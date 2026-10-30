/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { log } from '../../core/log.ts';
import * as direct from '../pro-system-audio-direct.ts';

type DirectTransportCallbacks = Parameters<typeof direct.configureProSystemAudioDirectTransport>[0];

const bridgeMocks = vi.hoisted(() => ({
  listeners: [] as Array<(frame: unknown) => void>,
  sent: [] as Array<{ channel: string; payload: Record<string, unknown> }>,
  send: vi.fn<(channel: string, payload: Record<string, unknown>) => boolean>(),
  on: vi.fn<(listener: (frame: unknown) => void) => () => void>(),
}));

vi.mock('../../pro-room/network-bridge.ts', () => ({
  onProRoomRealtimeEvent: bridgeMocks.on,
}));
vi.mock('../../pro-room/realtime-sender.ts', () => ({ sendProRoomRealtime: bridgeMocks.send }));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Locality =
  | 'host-host'
  | 'non-local'
  | 'pending'
  | 'global-ipv6'
  | 'hidden-address'
  | 'redacted-addresses'
  | 'redacted-remote-global-local'
  | 'empty-address-global-ip'
  | 'ledger-mismatch'
  | 'mdns'
  | 'both-mdns'
  | 'local-mdns-remote-private'
  | 'ambiguous'
  | 'multiple-selected'
  // WebKit-shaped graphs (host and prflx addresses cleared; foundation, port
  // and ufrag kept) whose transport selects one succeeded pair.
  | 'refined'
  | 'prflx-unrefined'
  | 'refined-other-port'
  | 'refined-other-generation'
  | 'refined-global-ip'
  // The refined pair read while libwebrtc's consent check is in flight: the
  // selected connection reads 'in-progress' for one round trip, after a
  // response ('answered') or before any ('unanswered').
  | 'refined-in-progress'
  | 'refined-in-progress-unanswered'
  // The refined pair, while another connection from the same local socket to a
  // prflx remote on the native snapshot's port is still listed.
  | 'refined-prflx-listed'
  // The refined pair, with a second transport selecting another pair.
  | 'refined-ambiguous'
  // The refined pair whose local statistics carry a private address only
  // under the legacy 'ipAddress' key.
  | 'refined-ipaddress'
  // The same refined graph as Chromium reports it (empty addresses).
  | 'refined-chromium';

/**
 * The native selected-pair snapshot: 'prflx' is iOS Safari's host-to-prflx
 * pair (see prflxNativePair), 'custom' returns customNativePair().
 */
type AuthoritativePairMode =
  'lan' | 'relay' | 'srflx' | 'incomplete' | 'throw' | 'prflx' | 'custom';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface MockTrack extends MediaStreamTrack {
  emitEnded: () => void;
}

let peerConnections: MockRTCPeerConnection[];
let nextLocalities: Locality[];
let receiverTrackId: string | null;
let localParticipantId: string;
let failNextAddTrack: boolean;
let nextStatsGates: Array<Promise<void>>;
let nextEmbeddedCandidateAddresses: Array<string | null>;
let nextAuthoritativePairModes: Array<AuthoritativePairMode | null>;
let customNativePair: () => RTCIceCandidatePair | null;
/** The simulated remote receiver withholds its pair proof on the probe channel. */
let receiverProofWithheld: boolean;
/**
 * A receiver's setLocalDescription(answer) leaves the publisher's probe channel
 * unannounced until announceRemoteChannel, as a browser announces it only after
 * DTLS, SCTP and the channel's open handshake.
 */
let receiverChannelHeld: boolean;
/** getParameters of the next senders addTrack creates, in order. */
let nextSenderParameters: Array<() => RTCRtpSendParameters>;

// iOS Safari, the ICE-controlled answerer, meets the publisher's check before
// it has resolved the publisher's mDNS name: its native pair keeps a prflx
// remote (address redacted) while the stats refine that connection to the
// added host candidate. Distinct values let the privacy rows find any leak.
const LISTENER_LOCAL_MDNS = '123e4567-e89b-42d3-a456-426614174010.local';
const LISTENER_LOCAL_PORT = 54321;
const LISTENER_LOCAL_FOUNDATION = '1394829115';
const PRFLX_FOUNDATION = '2788118142';
const LOCAL_UFRAG = 'ufragLocal9';
const REMOTE_UFRAG = 'ufragRemote9';

function prflxNativePair(): RTCIceCandidatePair {
  return {
    local: {
      type: 'host',
      address: LISTENER_LOCAL_MDNS,
      port: LISTENER_LOCAL_PORT,
      protocol: 'udp',
      foundation: LISTENER_LOCAL_FOUNDATION,
      usernameFragment: LOCAL_UFRAG,
    } as RTCIceCandidate,
    remote: {
      type: 'prflx',
      address: 'redacted-ip.invalid',
      port: 5000,
      protocol: 'udp',
      foundation: PRFLX_FOUNDATION,
      usernameFragment: REMOTE_UFRAG,
    } as RTCIceCandidate,
  };
}

const REFINED_LOCALITIES: ReadonlySet<Locality> = new Set<Locality>([
  'refined',
  'prflx-unrefined',
  'refined-other-port',
  'refined-other-generation',
  'refined-global-ip',
  'refined-in-progress',
  'refined-in-progress-unanswered',
  'refined-prflx-listed',
  'refined-ambiguous',
  'refined-ipaddress',
  'refined-chromium',
]);

/** The transport-selected stats graph of a refined (or not yet refined) connection. */
function refinedStats(locality: Locality): RTCStatsReport {
  const unrefined = locality === 'prflx-unrefined';
  const chromium = locality === 'refined-chromium';
  const remoteId = unrefined ? 'IRP' : 'IRH';
  const inProgress =
    locality === 'refined-in-progress' || locality === 'refined-in-progress-unanswered';
  const reports = new Map<string, unknown>([
    ['T01', { id: 'T01', type: 'transport', timestamp: 1, selectedCandidatePairId: 'CP1' }],
    [
      'CP1',
      {
        id: 'CP1',
        type: 'candidate-pair',
        timestamp: 1,
        transportId: 'T01',
        state: inProgress ? 'in-progress' : 'succeeded',
        nominated: true,
        localCandidateId: 'IL',
        remoteCandidateId: remoteId,
        ...(inProgress ? { responsesReceived: locality === 'refined-in-progress' ? 4 : 0 } : {}),
      },
    ],
    [
      'IL',
      {
        id: 'IL',
        type: 'local-candidate',
        timestamp: 1,
        candidateType: 'host',
        port: locality === 'refined-other-port' ? LISTENER_LOCAL_PORT + 1 : LISTENER_LOCAL_PORT,
        protocol: 'udp',
        foundation: LISTENER_LOCAL_FOUNDATION,
        usernameFragment: LOCAL_UFRAG,
        ...(chromium ? { address: '' } : {}),
        ...(locality === 'refined-global-ip' ? { address: '', ip: '2001:db8:1::10' } : {}),
        ...(locality === 'refined-ipaddress' ? { address: '', ipAddress: '192.168.1.10' } : {}),
      },
    ],
    [
      remoteId,
      {
        id: remoteId,
        type: 'remote-candidate',
        timestamp: 1,
        candidateType: unrefined ? 'prflx' : 'host',
        foundation: unrefined ? PRFLX_FOUNDATION : 'auto',
        port: 5000,
        protocol: 'udp',
        usernameFragment: locality === 'refined-other-generation' ? 'ufragRemote8' : REMOTE_UFRAG,
        ...(chromium ? { address: '' } : {}),
      },
    ],
  ]);
  if (locality === 'refined-prflx-listed') {
    reports.set('CP2', {
      id: 'CP2',
      type: 'candidate-pair',
      timestamp: 1,
      transportId: 'T01',
      state: 'succeeded',
      nominated: false,
      localCandidateId: 'IL',
      remoteCandidateId: 'IRP',
    });
    reports.set('IRP', {
      id: 'IRP',
      type: 'remote-candidate',
      timestamp: 1,
      candidateType: 'prflx',
      foundation: PRFLX_FOUNDATION,
      port: 5000,
      protocol: 'udp',
      usernameFragment: REMOTE_UFRAG,
    });
  }
  if (locality === 'refined-ambiguous') {
    reports.set('T02', {
      id: 'T02',
      type: 'transport',
      timestamp: 1,
      selectedCandidatePairId: 'CP9',
    });
  }
  return reports as unknown as RTCStatsReport;
}

const PROBE_CHANNEL_LABEL = 'MUSIXQUARE-lan-probe';
const RECEIVER_PAIR_PROVEN = 'receiver-pair-proven';
const PUBLISHER_TRACK_ATTACHED = 'publisher-track-attached';

interface MockChannel {
  label: string;
  readyState: RTCDataChannelState;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
}

function mockChannel(readyState: RTCDataChannelState = 'open'): MockChannel {
  return {
    label: PROBE_CHANNEL_LABEL,
    readyState,
    close: vi.fn(),
    send: vi.fn(),
    onmessage: null,
    onopen: null,
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

class MockMediaStream {
  constructor(readonly tracks: MediaStreamTrack[]) {}
}

class MockRTCPeerConnection {
  readonly configuration: RTCConfiguration;
  locality: Locality;
  /** Held reads wait on it; a test may replace it mid-route. */
  statsGate: Promise<void> | null;
  readonly embeddedCandidateAddress: string | null;
  statsCallCount = 0;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  close = vi.fn(() => {
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
  });
  addIceCandidate = vi.fn(async () => {});
  /** The publisher's probe channel. */
  readonly probeChannel = mockChannel('connecting');
  /** The probe channel as a receiver's ondatachannel sees it. */
  readonly remoteChannel = mockChannel();
  readonly senders: RTCRtpSender[] = [];
  readonly getSelectedCandidatePair = vi.fn<() => RTCIceCandidatePair | null>();
  readonly sctp: RTCSctpTransport | null;

  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
    this.locality = nextLocalities.shift() ?? 'host-host';
    this.statsGate = nextStatsGates.shift() ?? null;
    this.embeddedCandidateAddress = nextEmbeddedCandidateAddresses.shift() ?? null;
    const authoritativePairMode = nextAuthoritativePairModes.shift() ?? null;
    this.getSelectedCandidatePair.mockImplementation(() => {
      if (authoritativePairMode === 'throw') throw new Error('mock selected pair failure');
      if (!authoritativePairMode) return null;
      if (authoritativePairMode === 'prflx') return prflxNativePair();
      if (authoritativePairMode === 'custom') return customNativePair();
      const remoteType =
        authoritativePairMode === 'relay' || authoritativePairMode === 'srflx'
          ? authoritativePairMode
          : 'host';
      return {
        local: {
          type: 'host',
          foundation: 'local',
          port: 5000,
          protocol: 'udp',
          address: '192.168.1.10',
        } as RTCIceCandidate,
        remote: {
          type: remoteType,
          foundation: authoritativePairMode === 'incomplete' ? null : 'auto',
          port: 5000,
          protocol: 'udp',
          address: '123e4567-e89b-42d3-a456-426614174000.local',
        } as RTCIceCandidate,
      };
    });
    this.sctp = authoritativePairMode
      ? ({
          transport: {
            iceTransport: { getSelectedCandidatePair: this.getSelectedCandidatePair },
          },
        } as unknown as RTCSctpTransport)
      : null;
    peerConnections.push(this);
  }

  addTrack = vi.fn((track: MediaStreamTrack): RTCRtpSender => {
    if (failNextAddTrack) {
      failNextAddTrack = false;
      throw new Error('mock addTrack failure');
    }
    const sender = {
      track,
      getParameters:
        nextSenderParameters.shift() ?? (() => ({ encodings: [{}] }) as RTCRtpSendParameters),
      setParameters: vi.fn(async () => {}),
      replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => {
        (sender as { track: MediaStreamTrack | null }).track = next;
      }),
    } as unknown as RTCRtpSender;
    this.senders.push(sender);
    return sender;
  });

  /** The capture track this connection sends, or null while it carries no audio. */
  sendingTrack(): MediaStreamTrack | null {
    return this.senders[0]?.track ?? null;
  }

  createDataChannel(): RTCDataChannel {
    return this.probeChannel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const media =
      this.senders.length > 0
        ? 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2'
        : 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel';
    const embeddedCandidate = this.embeddedCandidateAddress
      ? `\r\na=candidate:embedded 1 udp 1 ${this.embeddedCandidateAddress} 5000 typ host`
      : '';
    return {
      type: 'offer',
      sdp:
        `v=0\r\n${media}\r\nc=IN IP4 192.168.1.10\r\no=${peerConnections.indexOf(this)}` +
        embeddedCandidate,
    };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const media = this.remoteDescription?.sdp?.includes('m=audio')
      ? 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2'
      : 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel';
    return { type: 'answer', sdp: `v=0\r\n${media}\r\no=${peerConnections.indexOf(this)}` };
  }

  async setLocalDescription(description: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    this.emitLocalCandidate();
    if (description.type === 'answer') {
      this.emitConnected();
      if (!receiverChannelHeld) {
        this.ondatachannel?.({ channel: this.remoteChannel } as unknown as RTCDataChannelEvent);
      }
    }
  }

  /**
   * Announces the held probe channel to this receiver in `readyState`. With
   * `openEvent`, an 'open' channel's open event follows the announcement, the
   * order the WebRTC specification gives a newly announced channel.
   */
  announceRemoteChannel(
    readyState: 'open' | 'connecting',
    options: { openEvent?: boolean } = {},
  ): void {
    this.remoteChannel.readyState = readyState;
    this.ondatachannel?.({ channel: this.remoteChannel } as unknown as RTCDataChannelEvent);
    if (readyState === 'open' && options.openEvent) this.remoteChannel.onopen?.();
  }

  /** The announced 'connecting' probe channel opens and fires its open event. */
  openRemoteChannel(): void {
    this.remoteChannel.readyState = 'open';
    this.remoteChannel.onopen?.();
  }

  emitLocalCandidate(
    candidateValue = 'candidate:1 1 udp 1 123e4567-e89b-42d3-a456-426614174010.local 5000 typ host',
  ): void {
    this.onicecandidate?.({
      candidate: {
        candidate: candidateValue,
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'local-fragment',
        toJSON: () => ({
          candidate: candidateValue,
          sdpMid: '0',
          sdpMLineIndex: 0,
          usernameFragment: 'local-fragment',
        }),
      } as RTCIceCandidate,
    } as RTCPeerConnectionIceEvent);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    if (description.type === 'offer' && description.sdp?.includes('m=audio') && receiverTrackId) {
      this.ontrack?.({ track: audioTrack(receiverTrackId) } as unknown as RTCTrackEvent);
    }
    if (description.type === 'answer') {
      this.emitConnected();
      if (!receiverProofWithheld) this.emitReceiverProof();
    }
  }

  /** The remote receiver's pair proof arriving on the publisher's probe channel. */
  emitReceiverProof(data: unknown = RECEIVER_PAIR_PROVEN): void {
    // A message arrives only on an open channel.
    this.probeChannel.readyState = 'open';
    this.probeChannel.onmessage?.({ data });
  }

  /** The remote publisher's track-attached message, as a receiver's channel gets it. */
  emitPublisherAttached(data: unknown = PUBLISHER_TRACK_ATTACHED): void {
    this.remoteChannel.onmessage?.({ data });
  }

  async getStats(): Promise<RTCStatsReport> {
    this.statsCallCount += 1;
    if (this.statsGate) await this.statsGate;
    if (this.locality === 'pending') return new Map() as unknown as RTCStatsReport;
    if (REFINED_LOCALITIES.has(this.locality)) return refinedStats(this.locality);
    const remoteType = this.locality === 'host-host' ? 'host' : 'relay';
    const localAddress =
      this.locality === 'global-ipv6' ||
      this.locality === 'redacted-remote-global-local' ||
      this.locality === 'empty-address-global-ip'
        ? '2001:db8:1::10'
        : this.locality === 'both-mdns' || this.locality === 'local-mdns-remote-private'
          ? '123e4567-e89b-42d3-a456-426614174001.local'
          : '192.168.1.10';
    const remoteAddress =
      this.locality === 'global-ipv6'
        ? '2001:db8:1::20'
        : this.locality === 'host-host' ||
            this.locality === 'mdns' ||
            this.locality === 'both-mdns' ||
            this.locality === 'empty-address-global-ip' ||
            this.locality === 'ledger-mismatch'
          ? '123e4567-e89b-42d3-a456-426614174000.local'
          : '192.168.1.20';
    const pair = {
      id: 'pair',
      type: 'candidate-pair',
      timestamp: 1,
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'local',
      remoteCandidateId: 'remote',
    } as RTCStats;
    const reports: Array<[string, RTCStats]> = [
      [
        'transport',
        {
          id: 'transport',
          type: 'transport',
          timestamp: 1,
          selectedCandidatePairId: 'pair',
        } as unknown as RTCStats,
      ],
      ['pair', pair],
      [
        'local',
        {
          id: 'local',
          type: 'local-candidate',
          timestamp: 1,
          candidateType: 'host',
          ...(this.locality === 'hidden-address' || this.locality === 'redacted-addresses'
            ? {}
            : this.locality === 'empty-address-global-ip'
              ? { address: '', ip: localAddress }
              : { address: localAddress }),
        } as unknown as RTCStats,
      ],
      [
        'remote',
        {
          id: 'remote',
          type: 'remote-candidate',
          timestamp: 1,
          candidateType: this.locality === 'non-local' ? remoteType : 'host',
          ...(this.locality === 'hidden-address'
            ? {}
            : {
                foundation: this.locality === 'ledger-mismatch' ? 'other-foundation' : 'auto',
                port: 5000,
                protocol: 'udp',
              }),
          ...(this.locality === 'hidden-address' ||
          this.locality === 'redacted-addresses' ||
          this.locality === 'redacted-remote-global-local'
            ? {}
            : { address: remoteAddress }),
        } as RTCStats,
      ],
    ];
    if (this.locality === 'ambiguous') {
      reports.shift();
      reports.push([
        'pair-2',
        {
          ...pair,
          id: 'pair-2',
          localCandidateId: 'local',
          remoteCandidateId: 'remote',
        } as RTCStats,
      ]);
    }
    if (this.locality === 'multiple-selected') {
      reports.push([
        'transport-2',
        {
          id: 'transport-2',
          type: 'transport',
          timestamp: 1,
          selectedCandidatePairId: 'pair-2',
        } as RTCStats,
      ]);
      reports.push(['pair-2', { ...pair, id: 'pair-2' } as RTCStats]);
    }
    return new Map<string, RTCStats>(reports) as unknown as RTCStatsReport;
  }

  emitConnected(): void {
    this.connectionState = 'connected';
    this.iceConnectionState = 'connected';
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }

  emitFailed(): void {
    this.connectionState = 'failed';
    this.iceConnectionState = 'failed';
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }
}

function audioTrack(id: string): MockTrack {
  const endedListeners: Array<() => void> = [];
  return {
    id,
    kind: 'audio',
    readyState: 'live',
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== 'ended') return;
      endedListeners.push(
        typeof listener === 'function' ? () => listener(new Event('ended')) : () => undefined,
      );
    }),
    emitEnded: () => endedListeners.forEach((listener) => listener()),
  } as unknown as MockTrack;
}

function emitRelay(senderParticipantId: string, payload: Record<string, unknown>): void {
  for (const listener of bridgeMocks.listeners) {
    listener({
      type: 'pro-realtime',
      version: 1,
      roomCode: '000001',
      coordinatorEpoch: 1,
      eventId: crypto.randomUUID(),
      channel: 'system-audio-signal',
      payload,
      sender: {
        participantId: senderParticipantId,
        presenceIncarnationId: `presence_${senderParticipantId}`,
      },
    });
  }
}

function target(
  participantId: string,
  routeToken = `joined-at:${participantId === receiverA ? 1 : 2}`,
): direct.ProSystemAudioDirectTarget {
  return { participantId, routeToken };
}

function safeCandidate(foundation: string): string {
  let hash = 0;
  for (const character of foundation) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const suffix = hash.toString(16).padStart(12, '0');
  return `candidate:${foundation} 1 udp 1 123e4567-e89b-42d3-a456-${suffix}.local 5000 typ host`;
}

/** The publisher's one offer: the probe channel and one audio m-section. */
const PUBLISHER_OFFER_SDP =
  'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' +
  'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2';

function publisherOffer(
  negotiationId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'offer',
    targetParticipantId: receiverA,
    direction: 'publisher',
    phase: 'media',
    generation: 11,
    publicationId,
    negotiationId,
    description: { type: 'offer', sdp: PUBLISHER_OFFER_SDP },
    trackId: 'remote-stereo-track',
    ...overrides,
  };
}

function publisherCandidate(negotiationId: string, candidate: string): Record<string, unknown> {
  return {
    kind: 'candidate',
    targetParticipantId: receiverA,
    direction: 'publisher',
    generation: 11,
    publicationId,
    negotiationId,
    candidate: { candidate },
  };
}

function installAutomaticAnswers(options: { emitCandidate?: boolean } = {}): void {
  bridgeMocks.send.mockImplementation((channel, payload) => {
    bridgeMocks.sent.push({ channel, payload });
    if (payload.kind === 'offer') {
      const remoteParticipantId = String(payload.targetParticipantId);
      queueMicrotask(() => {
        emitRelay(remoteParticipantId, {
          kind: 'answer',
          targetParticipantId: localParticipantId,
          direction: 'subscriber',
          phase: payload.phase,
          generation: payload.generation,
          publicationId: payload.publicationId,
          negotiationId: payload.negotiationId,
          description: {
            type: 'answer',
            sdp:
              payload.phase === 'media'
                ? `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\no=${remoteParticipantId}`
                : `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\no=${remoteParticipantId}`,
          },
        });
        if (options.emitCandidate !== false) {
          emitRelay(remoteParticipantId, {
            kind: 'candidate',
            targetParticipantId: localParticipantId,
            direction: 'subscriber',
            generation: payload.generation,
            publicationId: payload.publicationId,
            negotiationId: payload.negotiationId,
            candidate: { candidate: safeCandidate('auto') },
          });
        }
      });
    }
    return true;
  });
}

function configureCallbacks(
  overrides: Partial<
    Omit<
      DirectTransportCallbacks,
      'onReceiverTrackReady' | 'onLiveRouteFallback' | 'onLiveRouteStopped'
    >
  > = {},
) {
  const onReceiverTrackReady = vi.fn<(event: direct.ProSystemAudioDirectTrackReadyEvent) => void>();
  const onLiveRouteFallback = vi.fn<(event: direct.ProSystemAudioDirectFallbackEvent) => void>();
  const onLiveRouteStopped = vi.fn<(event: direct.ProSystemAudioDirectRouteStoppedEvent) => void>();
  const callbacks = {
    getLocalIdentity: () => ({ participantId: localParticipantId }),
    authorizeInboundOffer: () => true,
    authorizeInboundSignal: () => true,
    ...overrides,
    onReceiverTrackReady,
    onLiveRouteFallback,
    onLiveRouteStopped,
  } satisfies DirectTransportCallbacks;
  direct.configureProSystemAudioDirectTransport(callbacks);
  return callbacks;
}

const publisherId = 'publisher_participant_0001';
const receiverA = 'receiver_participant_0001';
const receiverB = 'receiver_participant_0002';
const receiverC = 'receiver_participant_0003';
const attackerId = 'attacker_participant_0001';
const publicationId = 'publication_000000000001';

beforeEach(() => {
  peerConnections = [];
  nextLocalities = [];
  receiverTrackId = null;
  localParticipantId = publisherId;
  failNextAddTrack = false;
  nextStatsGates = [];
  nextEmbeddedCandidateAddresses = [];
  nextAuthoritativePairModes = [];
  customNativePair = () => null;
  receiverProofWithheld = false;
  receiverChannelHeld = false;
  nextSenderParameters = [];
  bridgeMocks.sent.length = 0;
  bridgeMocks.send.mockReset();
  bridgeMocks.on.mockImplementation((listener) => {
    if (!bridgeMocks.listeners.includes(listener)) bridgeMocks.listeners.push(listener);
    return () => {
      const index = bridgeMocks.listeners.indexOf(listener);
      if (index >= 0) bridgeMocks.listeners.splice(index, 1);
    };
  });
  installAutomaticAnswers();
  vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
  vi.stubGlobal('MediaStream', MockMediaStream);
});

afterEach(() => {
  direct.resetProSystemAudioDirectTransport({ notifyPeers: false });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PRO system-audio LAN-direct publisher probe', () => {
  it('retires a timed-out native offer without sending its late result into a successor', async () => {
    vi.useFakeTimers();
    configureCallbacks();
    const gate = deferred<void>();
    const original = MockRTCPeerConnection.prototype.createOffer;
    const spy = vi
      .spyOn(MockRTCPeerConnection.prototype, 'createOffer')
      .mockImplementationOnce(async function (this: MockRTCPeerConnection) {
        await gate.promise;
        return original.call(this);
      });
    try {
      const old = direct.attemptProSystemAudioDirectPublication({
        track: audioTrack('old-capture'),
        generation: 7,
        publicationId,
        targets: [target(receiverA)],
      });
      await vi.advanceTimersByTimeAsync(2_001);
      await expect(old).resolves.toBeNull();
      const successor = direct.attemptProSystemAudioDirectPublication({
        track: audioTrack('new-capture'),
        generation: 8,
        publicationId,
        targets: [target(receiverB)],
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(successor).resolves.not.toBeNull();
      gate.resolve(undefined);
      await vi.advanceTimersByTimeAsync(100);
      expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
      expect(peerConnections[0]!.sendingTrack()).toBeNull();
      expect(peerConnections[1]?.close).not.toHaveBeenCalled();
      expect(
        bridgeMocks.sent.some((frame) => frame.payload.targetParticipantId === receiverA),
      ).toBe(false);
    } finally {
      gate.resolve(undefined);
      spy.mockRestore();
    }
  });

  it.each(['activation', 'periodic'] as const)(
    'fails closed when the %s native locality reproof exceeds the existing budget',
    async (phase) => {
      vi.useFakeTimers();
      const callbacks = configureCallbacks();
      const initial = direct.attemptProSystemAudioDirectPublication({
        track: audioTrack('capture-stereo'),
        generation: 7,
        publicationId,
        targets: [target(receiverA)],
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(initial).resolves.not.toBeNull();
      const publication = { ownerParticipantId: publisherId, generation: 7, publicationId };
      if (phase === 'periodic') {
        await expect(direct.activateProSystemAudioDirectPublication(publication)).resolves.toBe(
          true,
        );
      }
      const pc = peerConnections[0]!;
      const stats = await pc.getStats();
      const gate = deferred<RTCStatsReport>();
      const spy = vi.spyOn(pc, 'getStats').mockReturnValue(gate.promise);
      try {
        const activation =
          phase === 'activation'
            ? direct.activateProSystemAudioDirectPublication(publication)
            : null;
        await vi.advanceTimersByTimeAsync(phase === 'activation' ? 2_001 : 7_001);
        if (activation) await expect(activation).resolves.toBe(false);
        expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);
        expect(pc.close).toHaveBeenCalledTimes(1);
        gate.resolve(stats);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);
        expect(pc.close).toHaveBeenCalledTimes(1);
      } finally {
        gate.resolve(stats);
        spy.mockRestore();
      }
    },
  );

  it.each(['initial', 'late-join'] as const)(
    'bounds an awaited native stats proof during %s negotiation and ignores late settlement',
    async (phase) => {
      vi.useFakeTimers();
      const callbacks = configureCallbacks();
      if (phase === 'late-join') {
        await direct.attemptProSystemAudioDirectPublication({
          track: audioTrack('capture-stereo'),
          generation: 7,
          publicationId,
          targets: [],
        });
        await direct.activateProSystemAudioDirectPublication({
          ownerParticipantId: publisherId,
          generation: 7,
          publicationId,
        });
      }
      const stats = deferred<void>();
      nextStatsGates.push(stats.promise);
      let settled = false;
      const attempt =
        phase === 'initial'
          ? direct.attemptProSystemAudioDirectPublication({
              track: audioTrack('capture-stereo'),
              generation: 7,
              publicationId,
              targets: [target(receiverA)],
            })
          : direct.reconcileProSystemAudioDirectTargets([target(receiverA)]);
      void attempt.then(
        () => {
          settled = true;
        },
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(30);
      expect(peerConnections[0]?.statsCallCount).toBe(1);
      try {
        await vi.advanceTimersByTimeAsync(5_001);
        expect(settled).toBe(true);
        expect(await attempt).toBe(phase === 'initial' ? null : false);
        expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
        expect(peerConnections[0]!.sendingTrack()).toBeNull();
        expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(phase === 'initial' ? 0 : 1);
      } finally {
        stats.resolve(undefined);
        await vi.advanceTimersByTimeAsync(30);
      }
      expect(peerConnections[0]!.sendingTrack()).toBeNull();
    },
  );

  it('publishes only after every parallel route proves a selected host-to-host pair', async () => {
    const callbacks = configureCallbacks();
    nextLocalities.push('host-host', 'host-host');

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 7,
      publicationId,
      targets: [target(receiverA), target(receiverB)],
      timeoutMs: 250,
    });

    expect(descriptor).toEqual({ publicationId, transport: 'lan-direct', protocolVersion: 2 });
    expect(peerConnections).toHaveLength(2);
    expect(peerConnections.map((pc) => pc.configuration)).toEqual([
      { iceServers: [], bundlePolicy: 'max-bundle' },
      { iceServers: [], bundlePolicy: 'max-bundle' },
    ]);
    expect(peerConnections.map((pc) => pc.addTrack.mock.calls.length)).toEqual([1, 1]);
    expect(peerConnections.map((pc) => pc.addTrack.mock.calls[0]?.[0].id)).toEqual([
      'capture-stereo',
      'capture-stereo',
    ]);
    for (const pc of peerConnections) {
      expect(pc.senders[0]?.setParameters).toHaveBeenCalledWith(
        expect.objectContaining({
          encodings: [expect.objectContaining({ maxBitrate: 256_000 })],
        }),
      );
      // The offer goes out with no audio on the sender; the track attaches
      // only after both ends proved the pair.
      expect(
        (pc.senders[0]?.replaceTrack as ReturnType<typeof vi.fn>).mock.calls.map(
          ([track]) => (track as MediaStreamTrack | null)?.id ?? null,
        ),
      ).toEqual([null, 'capture-stereo']);
      expect(pc.sendingTrack()?.id).toBe('capture-stereo');
      // Then it tells the receiver, which hands its track over only now.
      expect(pc.probeChannel.send).toHaveBeenCalledWith(PUBLISHER_TRACK_ATTACHED);
    }
    for (const targetParticipantId of [receiverA, receiverB]) {
      expect(
        bridgeMocks.sent
          .filter((entry) => entry.payload.targetParticipantId === targetParticipantId)
          .map((entry) => entry.payload.kind),
      ).toEqual(['offer', 'candidate']);
      expect(
        bridgeMocks.sent
          .filter(
            (entry) =>
              entry.payload.targetParticipantId === targetParticipantId &&
              entry.payload.kind === 'offer',
          )
          .map((entry) => entry.payload.phase),
      ).toEqual(['media']);
      const mediaOffer = bridgeMocks.sent.find(
        (entry) =>
          entry.payload.targetParticipantId === targetParticipantId &&
          entry.payload.kind === 'offer' &&
          entry.payload.phase === 'media',
      );
      expect(mediaOffer?.payload).toEqual(expect.objectContaining({ trackId: 'capture-stereo' }));
      expect(mediaOffer?.payload).not.toHaveProperty('trackIds');
      const mediaSdp = (mediaOffer?.payload.description as RTCSessionDescriptionInit).sdp;
      expect(mediaSdp).toContain('stereo=1');
      expect(mediaSdp).toContain('sprop-stereo=1');
      expect(mediaSdp).toContain('maxaveragebitrate=256000');
    }
    await expect(
      direct.activateProSystemAudioDirectPublication({
        ownerParticipantId: publisherId,
        generation: 7,
        publicationId,
        targets: [target(receiverA), target(receiverB)],
      }),
    ).resolves.toBe(true);
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
  });

  // Phase 5 prep T2. C4-1 moves the sender bitrate into system-audio-media.ts;
  // the LAN-direct publisher keeps bitrate only, as today: unlike the Standard
  // host and both SFU publishers it never asks the capture track for the
  // music constraints, and an unreadable sender must not demote the route.
  it('tunes each LAN-direct sender for bitrate only, with no music-constraints call', async () => {
    configureCallbacks();
    nextLocalities.push('host-host', 'host-host');
    const track = Object.assign(audioTrack('capture-stereo'), {
      applyConstraints: vi.fn(async () => {}),
    });

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track,
      generation: 7,
      publicationId,
      targets: [target(receiverA), target(receiverB)],
      timeoutMs: 250,
    });

    expect(descriptor).toEqual({ publicationId, transport: 'lan-direct', protocolVersion: 2 });
    expect(track.applyConstraints).not.toHaveBeenCalled();
    for (const pc of peerConnections) {
      const sender = pc.senders[0];
      expect(sender?.track).toBe(track);
      expect(sender?.setParameters).toHaveBeenCalledTimes(1);
      expect(sender?.setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 256_000 }] });
    }
  });

  it('keeps a proven LAN-direct route when its sender parameters cannot be read', async () => {
    const callbacks = configureCallbacks();
    nextLocalities.push('host-host');
    nextSenderParameters.push(() => {
      throw new TypeError('getParameters is not supported');
    });
    const track = audioTrack('capture-stereo');

    const attempt = direct.attemptProSystemAudioDirectPublication({
      track,
      generation: 7,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });
    const pc = peerConnections[0]!;

    await expect(attempt).resolves.toEqual({
      publicationId,
      transport: 'lan-direct',
      protocolVersion: 2,
    });
    expect(pc.addTrack).toHaveBeenCalledTimes(1);
    expect(pc.senders[0]?.setParameters).not.toHaveBeenCalled();
    expect(pc.close).not.toHaveBeenCalled();
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
  });

  // The LAN-direct encoding-list edges C4-1 must carry into
  // system-audio-media.ts. A missing list becomes one 256 kbps encoding, as on
  // the music senders; unlike them (left alone there), a sender that lists no
  // encoding still gets its unchanged parameters set back.
  it.each([
    {
      name: 'without an encoding list',
      parameters: {} as Partial<RTCRtpSendParameters>,
      set: [{ maxBitrate: 256_000 }],
    },
    {
      name: 'that lists no encoding',
      parameters: { encodings: [] } as Partial<RTCRtpSendParameters>,
      set: [],
    },
  ])(
    'sets the parameters of a LAN-direct sender $name and keeps the route',
    async ({ parameters, set }) => {
      const callbacks = configureCallbacks();
      nextLocalities.push('host-host');
      nextSenderParameters.push(() => structuredClone(parameters) as RTCRtpSendParameters);
      const track = audioTrack('capture-stereo');

      const attempt = direct.attemptProSystemAudioDirectPublication({
        track,
        generation: 7,
        publicationId,
        targets: [target(receiverA)],
        timeoutMs: 250,
      });
      const pc = peerConnections[0]!;

      await expect(attempt).resolves.toEqual({
        publicationId,
        transport: 'lan-direct',
        protocolVersion: 2,
      });
      expect(pc.senders[0]?.setParameters).toHaveBeenCalledTimes(1);
      expect(pc.senders[0]?.setParameters).toHaveBeenCalledWith({ encodings: set });
      expect(pc.close).not.toHaveBeenCalled();
      expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
    },
  );

  it('fully abandons direct publication when even one selected pair is non-local', async () => {
    configureCallbacks();
    nextLocalities.push('host-host', 'non-local');

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA), target(receiverB)],
      timeoutMs: 250,
    });

    expect(descriptor).toBeNull();
    expect(peerConnections[1]!.sendingTrack()).toBeNull();
    expect(peerConnections.every((pc) => pc.close.mock.calls.length === 1)).toBe(true);
    await expect(direct.reconcileProSystemAudioDirectTargets([target(receiverA)])).resolves.toBe(
      false,
    );
    expect(
      bridgeMocks.sent
        .filter((entry) => entry.payload.kind === 'close')
        .map((entry) => ({
          target: entry.payload.targetParticipantId,
          reason: entry.payload.reason,
        })),
    ).toEqual(
      expect.arrayContaining([
        { target: receiverA, reason: 'fallback' },
        { target: receiverB, reason: 'fallback' },
      ]),
    );
  });

  it('uses the authoritative selected LAN pair without waiting for stats', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    configureCallbacks();
    nextAuthoritativePairModes.push('lan');
    nextStatsGates.push(deferred<void>().promise);

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });

    expect(descriptor).not.toBeNull();
    expect(peerConnections[0]?.getSelectedCandidatePair).toHaveBeenCalled();
    expect(peerConnections[0]?.statsCallCount).toBe(0);
    expect(peerConnections[0]?.addTrack).toHaveBeenCalledTimes(1);
  });

  it.each<AuthoritativePairMode>(['relay', 'srflx'])(
    'rejects an authoritative %s pair without waiting for stats',
    async (authoritativePairMode) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      configureCallbacks();
      nextAuthoritativePairModes.push(authoritativePairMode);
      nextStatsGates.push(deferred<void>().promise);

      const descriptor = await direct.attemptProSystemAudioDirectPublication({
        track: audioTrack('capture-stereo'),
        generation: 8,
        publicationId,
        targets: [target(receiverA)],
        timeoutMs: 80,
      });

      expect(descriptor).toBeNull();
      expect(peerConnections[0]?.getSelectedCandidatePair).toHaveBeenCalled();
      expect(peerConnections[0]?.statsCallCount).toBe(0);
      expect(peerConnections[0]!.sendingTrack()).toBeNull();
    },
  );

  it('falls back to stats when the authoritative selected pair is incomplete', async () => {
    configureCallbacks();
    nextAuthoritativePairModes.push('incomplete');
    nextLocalities.push('host-host');

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });

    expect(descriptor).not.toBeNull();
    expect(peerConnections[0]?.getSelectedCandidatePair).toHaveBeenCalled();
    expect(peerConnections[0]?.statsCallCount).toBeGreaterThan(0);
    expect(peerConnections[0]?.addTrack).toHaveBeenCalledTimes(1);
  });

  it('falls back to stats when authoritative selected-pair access throws', async () => {
    configureCallbacks();
    nextAuthoritativePairModes.push('throw');
    nextLocalities.push('host-host');

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });

    expect(descriptor).not.toBeNull();
    expect(peerConnections[0]?.getSelectedCandidatePair).toHaveBeenCalled();
    expect(peerConnections[0]?.statsCallCount).toBeGreaterThan(0);
    expect(peerConnections[0]?.addTrack).toHaveBeenCalledTimes(1);
  });

  it.each<Locality>([
    'global-ipv6',
    'redacted-remote-global-local',
    'empty-address-global-ip',
    'hidden-address',
    'local-mdns-remote-private',
    'ambiguous',
    'multiple-selected',
  ])('rejects %s selected host pairs before attaching the capture track', async (locality) => {
    vi.useFakeTimers();
    configureCallbacks();
    nextLocalities.push(locality);

    const attempt = direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 80,
    });
    await vi.advanceTimersByTimeAsync(1_100);

    await expect(attempt).resolves.toBeNull();
    // The one offer carried an empty audio sender; no audio ever left.
    expect(peerConnections[0]!.sendingTrack()).toBeNull();
    expect(
      bridgeMocks.sent
        .filter((entry) => entry.payload.kind === 'offer')
        .map((e) => e.payload.phase),
    ).toEqual(['media']);
  });

  it('allows a selected host pair with a private local address and UUID-v4 mDNS remote', async () => {
    configureCallbacks();
    nextLocalities.push('mdns');

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });

    expect(descriptor).not.toBeNull();
    expect(peerConnections[0]?.addTrack).toHaveBeenCalledTimes(1);
  });

  it('allows UUID-v4 mDNS addresses on both sides when the remote address is valid', async () => {
    configureCallbacks();
    nextLocalities.push('both-mdns');

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });

    expect(descriptor).not.toBeNull();
    expect(peerConnections[0]?.addTrack).toHaveBeenCalledTimes(1);
  });

  it('accepts Chromium-redacted selected-pair addresses only with an added mDNS ledger match', async () => {
    configureCallbacks();
    nextLocalities.push('redacted-addresses');

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });

    expect(descriptor).not.toBeNull();
    expect(peerConnections[0]?.addIceCandidate).toHaveBeenCalledWith({
      candidate: safeCandidate('auto'),
    });
    expect(peerConnections[0]?.addTrack).toHaveBeenCalledTimes(1);
  });

  it('rejects Chromium-redacted selected-pair addresses without an added mDNS ledger match', async () => {
    installAutomaticAnswers({ emitCandidate: false });
    configureCallbacks();
    nextLocalities.push('redacted-addresses');

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 80,
    });

    expect(descriptor).toBeNull();
    expect(peerConnections[0]?.addIceCandidate).not.toHaveBeenCalled();
    expect(peerConnections[0]!.sendingTrack()).toBeNull();
  });

  it('rejects a selected mDNS pair whose stats foundation does not match the added candidate', async () => {
    configureCallbacks();
    nextLocalities.push('ledger-mismatch');

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 80,
    });

    expect(descriptor).toBeNull();
    expect(peerConnections[0]?.addIceCandidate).toHaveBeenCalledWith({
      candidate: safeCandidate('auto'),
    });
    expect(peerConnections[0]!.sendingTrack()).toBeNull();
  });

  it('strips a global host candidate embedded in local SDP while keeping the private route', async () => {
    configureCallbacks();
    nextEmbeddedCandidateAddresses.push('2001:db8::10');

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });

    expect(descriptor).not.toBeNull();
    expect(peerConnections[0]?.addTrack).toHaveBeenCalledTimes(1);
    expect(
      bridgeMocks.sent
        .filter((entry) => entry.payload.kind === 'offer')
        .some((entry) =>
          (entry.payload.description as RTCSessionDescriptionInit).sdp?.includes('2001:db8'),
        ),
    ).toBe(false);
    expect(
      bridgeMocks.sent
        .filter((entry) => entry.payload.kind === 'offer')
        .some((entry) =>
          (entry.payload.description as RTCSessionDescriptionInit).sdp?.includes('192.168.1.10'),
        ),
    ).toBe(false);
  });

  it('fail-closes WebRTC construction/setup errors instead of leaking them to the service', async () => {
    configureCallbacks();
    failNextAddTrack = true;

    await expect(
      direct.attemptProSystemAudioDirectPublication({
        track: audioTrack('capture-stereo'),
        generation: 9,
        publicationId,
        targets: [target(receiverA)],
        timeoutMs: 250,
      }),
    ).resolves.toBeNull();
    expect(peerConnections).toHaveLength(1);
    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
    await expect(direct.reconcileProSystemAudioDirectTargets([target(receiverA)])).resolves.toBe(
      false,
    );
  });

  it('uses only direct browser APIs, including the valid zero-target publication', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    configureCallbacks();

    const emptyDescriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 9,
      publicationId,
      targets: [],
    });

    expect(emptyDescriptor).toEqual({ publicationId, transport: 'lan-direct', protocolVersion: 2 });
    expect(peerConnections).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    nextLocalities.push('host-host');
    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo-2'),
      generation: 10,
      publicationId: 'publication_000000000002',
      targets: [target(receiverA)],
      timeoutMs: 250,
    });
    expect(descriptor).not.toBeNull();
    expect(peerConnections[0]?.configuration).toEqual({
      iceServers: [],
      bundlePolicy: 'max-bundle',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed before creating peer connections when more than three targets are requested', async () => {
    configureCallbacks();

    await expect(
      direct.attemptProSystemAudioDirectPublication({
        track: audioTrack('capture-stereo'),
        generation: 10,
        publicationId,
        targets: [target(receiverA), target(receiverB), target(receiverC), target(attackerId)],
      }),
    ).rejects.toThrow('PRO_SYSTEM_AUDIO_DIRECT_TARGET_LIMIT');
    expect(peerConnections).toHaveLength(0);
  });
});

describe('PRO system-audio LAN-direct receiver fencing', () => {
  it('bounds replay tombstones and fails closed until the transport is reset', () => {
    localParticipantId = receiverA;
    configureCallbacks();

    const offer = (index: number) =>
      publisherOffer(`negotiation_${String(index).padStart(18, '0')}`);

    for (let index = 1; index <= 65; index += 1) emitRelay(publisherId, offer(index));
    expect(peerConnections).toHaveLength(64);

    direct.resetProSystemAudioDirectTransport({ notifyPeers: false });
    emitRelay(publisherId, offer(66));
    expect(peerConnections).toHaveLength(65);
  });

  it('rejects forged/stale frames and hands off the mapped stereo track only after activation', async () => {
    localParticipantId = receiverA;
    receiverTrackId = 'remote-stereo-track';
    const callbacks = configureCallbacks({
      authorizeInboundOffer: (context) =>
        context.ownerParticipantId === publisherId &&
        context.generation === 11 &&
        context.publicationId === publicationId,
    });
    const validOffer = publisherOffer('negotiation_000000000001');

    // The retired probe offer, a second audio m-section and the old trackIds
    // shape build no route.
    emitRelay(publisherId, {
      ...validOffer,
      phase: 'probe',
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      },
    });
    emitRelay(publisherId, {
      ...validOffer,
      description: {
        type: 'offer',
        sdp: `${PUBLISHER_OFFER_SDP}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111`,
      },
    });
    const { trackId: _trackId, ...withoutTrackId } = validOffer;
    emitRelay(publisherId, {
      ...withoutTrackId,
      trackIds: { L: 'remote-left-track', R: 'remote-right-track' },
    });
    emitRelay(attackerId, validOffer);
    expect(peerConnections).toHaveLength(0);

    emitRelay(publisherId, validOffer);
    await vi.waitFor(() =>
      expect(bridgeMocks.sent.some((entry) => entry.payload.kind === 'answer')).toBe(true),
    );
    expect(peerConnections).toHaveLength(1);
    expect(
      bridgeMocks.sent
        .filter((entry) => entry.payload.kind === 'answer')
        .map((entry) => entry.payload.phase),
    ).toEqual(['media']);
    expect(peerConnections[0]?.remoteDescription?.sdp).toContain('stereo=1');
    expect(peerConnections[0]?.remoteDescription?.sdp).toContain('sprop-stereo=1');
    const answer = bridgeMocks.sent.find((entry) => entry.payload.kind === 'answer');
    const answerSdp = (answer?.payload.description as RTCSessionDescriptionInit).sdp;
    expect(answerSdp).toContain('stereo=1');
    expect(answerSdp).toContain('sprop-stereo=1');
    expect(answerSdp).toContain('maxaveragebitrate=256000');
    // The track arrived with the offer but waits for the pair proof, and the
    // proof waits for the publisher's candidate.
    expect(peerConnections[0]?.remoteChannel.send).not.toHaveBeenCalled();
    expect(callbacks.onReceiverTrackReady).not.toHaveBeenCalled();

    emitRelay(
      publisherId,
      publisherCandidate(validOffer.negotiationId as string, safeCandidate('auto')),
    );
    await vi.waitFor(() =>
      expect(peerConnections[0]?.remoteChannel.send).toHaveBeenCalledWith(RECEIVER_PAIR_PROVEN),
    );
    expect(peerConnections[0]?.remoteChannel.send).toHaveBeenCalledTimes(1);
    expect(callbacks.onReceiverTrackReady).not.toHaveBeenCalled();

    emitRelay(attackerId, {
      kind: 'candidate',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 11,
      publicationId,
      negotiationId: validOffer.negotiationId,
      candidate: { candidate: safeCandidate('forged') },
    });
    emitRelay(publisherId, {
      kind: 'candidate',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 11,
      publicationId,
      negotiationId: 'negotiation_000000000099',
      candidate: { candidate: safeCandidate('stale') },
    });
    emitRelay(publisherId, {
      kind: 'candidate',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 12,
      publicationId,
      negotiationId: validOffer.negotiationId,
      candidate: { candidate: safeCandidate('stale-generation') },
    });
    emitRelay(publisherId, {
      kind: 'candidate',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 11,
      publicationId: 'publication_000000000099',
      negotiationId: validOffer.negotiationId,
      candidate: { candidate: safeCandidate('stale-publication') },
    });
    expect(peerConnections[0]?.addIceCandidate).toHaveBeenCalledWith({
      candidate: safeCandidate('auto'),
    });

    await expect(
      direct.activateProSystemAudioDirectPublication({
        ownerParticipantId: publisherId,
        generation: 11,
        publicationId,
      }),
    ).resolves.toBe(true);
    // Live and proven, but the track waits for the publisher's word that
    // audio flows on it; any other message is not that word.
    await Promise.resolve();
    peerConnections[0]!.emitPublisherAttached('receiver-pair-proven');
    peerConnections[0]!.emitPublisherAttached({ attached: true });
    await Promise.resolve();
    expect(callbacks.onReceiverTrackReady).not.toHaveBeenCalled();
    peerConnections[0]!.emitPublisherAttached();
    await vi.waitFor(() => expect(callbacks.onReceiverTrackReady).toHaveBeenCalledTimes(1));
    const deliveredEvent = callbacks.onReceiverTrackReady.mock.calls[0]?.[0];
    expect(deliveredEvent?.isCurrent()).toBe(true);
    expect(callbacks.onReceiverTrackReady).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerParticipantId: publisherId,
        generation: 11,
        publicationId,
        track: expect.objectContaining({ id: 'remote-stereo-track' }),
      }),
    );

    const replacementOffer = publisherOffer('negotiation_000000000002');
    emitRelay(publisherId, replacementOffer);
    await vi.waitFor(() => expect(peerConnections).toHaveLength(2));
    expect(deliveredEvent?.isCurrent()).toBe(false);
    emitRelay(publisherId, validOffer);
    await Promise.resolve();
    expect(peerConnections).toHaveLength(2);
  });

  it('buffers a bounded candidate that arrives before its offer and drains it afterward', async () => {
    localParticipantId = receiverA;
    configureCallbacks();
    const negotiationId = 'negotiation_000000000010';
    const candidate = safeCandidate('early');

    emitRelay(publisherId, {
      kind: 'candidate',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 11,
      publicationId,
      negotiationId,
      candidate: { candidate },
    });
    emitRelay(publisherId, publisherOffer(negotiationId));

    await vi.waitFor(() => expect(peerConnections).toHaveLength(1));
    await vi.waitFor(() =>
      expect(peerConnections[0]?.addIceCandidate).toHaveBeenCalledWith({ candidate }),
    );
  });

  it('clears pre-offer candidate buckets on transport reset', async () => {
    localParticipantId = receiverA;
    configureCallbacks();
    const negotiationId = 'negotiation_000000000019';
    emitRelay(publisherId, {
      kind: 'candidate',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 11,
      publicationId,
      negotiationId,
      candidate: { candidate: safeCandidate('discarded-before-reset') },
    });
    direct.resetProSystemAudioDirectTransport({ notifyPeers: false });
    emitRelay(publisherId, publisherOffer(negotiationId));

    await vi.waitFor(() => expect(peerConnections).toHaveLength(1));
    expect(peerConnections[0]?.addIceCandidate).not.toHaveBeenCalled();
  });

  it('caps pre-offer and route candidates and closes the route on count overflow', async () => {
    localParticipantId = receiverA;
    configureCallbacks();
    const negotiationId = 'negotiation_000000000011';
    for (let index = 0; index < 12; index += 1) {
      emitRelay(publisherId, {
        kind: 'candidate',
        targetParticipantId: receiverA,
        direction: 'publisher',
        generation: 11,
        publicationId,
        negotiationId,
        candidate: { candidate: safeCandidate(`early-${index}`) },
      });
    }
    emitRelay(publisherId, publisherOffer(negotiationId));
    await vi.waitFor(() => expect(peerConnections[0]?.addIceCandidate).toHaveBeenCalledTimes(2));

    for (let index = 0; index < 1; index += 1) {
      emitRelay(publisherId, {
        kind: 'candidate',
        targetParticipantId: receiverA,
        direction: 'publisher',
        generation: 11,
        publicationId,
        negotiationId,
        candidate: { candidate: safeCandidate(`after-${index}`) },
      });
    }
    await vi.waitFor(() => expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1));
    expect(peerConnections[0]?.addIceCandidate).toHaveBeenCalledTimes(2);
  });

  it('drops global trickle and strips embedded SDP candidates before they reach WebRTC', async () => {
    localParticipantId = receiverA;
    configureCallbacks();
    const negotiationId = 'negotiation_000000000012';
    emitRelay(
      publisherId,
      publisherOffer(negotiationId, {
        description: {
          type: 'offer',
          sdp:
            'v=0\r\n' +
            'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' +
            'c=IN IP6 2001:db8::20\r\n' +
            'a=remote-candidates:1 2001:db8::20 5000\r\n' +
            'a=candidate:bad 1 udp 1 2001:db8::20 5000 typ host\r\n' +
            'a=candidate:safe 1 udp 1 192.168.1.20 5000 typ host\r\n' +
            'a=end-of-candidates\r\n' +
            'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
        },
      }),
    );
    await vi.waitFor(() => expect(peerConnections).toHaveLength(1));
    const remoteSdp = peerConnections[0]?.remoteDescription?.sdp ?? '';
    expect(remoteSdp).toContain(
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP6 ::\r\n',
    );
    expect(remoteSdp).not.toMatch(/a=(?:candidate|remote-candidates|end-of-candidates)/);
    expect(remoteSdp).not.toContain('2001:db8');
    expect(remoteSdp).not.toContain('192.168.1.20');
    emitRelay(publisherId, {
      kind: 'candidate',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 11,
      publicationId,
      negotiationId,
      candidate: { candidate: 'candidate:bad 1 udp 1 2001:db8::20 5000 typ host' },
    });
    await Promise.resolve();
    expect(peerConnections[0]?.addIceCandidate).not.toHaveBeenCalled();
  });

  it('adds only bounded UUID-mDNS UDP host trickle candidates', async () => {
    localParticipantId = receiverA;
    configureCallbacks();
    const negotiationId = 'negotiation_000000000014';
    emitRelay(publisherId, publisherOffer(negotiationId));
    await vi.waitFor(() =>
      expect(bridgeMocks.sent.some((entry) => entry.payload.kind === 'answer')).toBe(true),
    );

    for (const candidate of [
      'candidate:numeric-private 1 udp 1 192.168.1.20 5000 typ host',
      'candidate:tcp 1 tcp 1 192.168.1.20 5000 typ host',
      'candidate:component-two 2 udp 1 192.168.1.20 5000 typ host',
    ]) {
      emitRelay(publisherId, {
        kind: 'candidate',
        targetParticipantId: receiverA,
        direction: 'publisher',
        generation: 11,
        publicationId,
        negotiationId,
        candidate: { candidate },
      });
    }
    await Promise.resolve();
    expect(peerConnections[0]?.addIceCandidate).not.toHaveBeenCalled();

    emitRelay(publisherId, {
      kind: 'candidate',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 11,
      publicationId,
      negotiationId,
      candidate: { candidate: safeCandidate('same-subnet') },
    });
    await vi.waitFor(() => expect(peerConnections[0]?.addIceCandidate).toHaveBeenCalledTimes(1));
    expect(peerConnections[0]?.addIceCandidate).toHaveBeenCalledWith({
      candidate: safeCandidate('same-subnet'),
    });

    emitRelay(publisherId, {
      kind: 'candidate',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 11,
      publicationId,
      negotiationId,
      candidate: {
        candidate:
          `${safeCandidate('sanitized')} generation 0 network-cost 999 ` +
          'raddr 203.0.113.10 rport 6000',
        usernameFragment: 'remote-fragment',
      },
    });
    await vi.waitFor(() => expect(peerConnections[0]?.addIceCandidate).toHaveBeenCalledTimes(2));
    expect(peerConnections[0]?.addIceCandidate).toHaveBeenLastCalledWith({
      candidate: safeCandidate('sanitized'),
      usernameFragment: 'remote-fragment',
    });
  });

  it('requests fallback when an activated, proven route never receives its track', async () => {
    vi.useFakeTimers();
    localParticipantId = receiverA;
    const callbacks = configureCallbacks();
    const negotiationId = 'negotiation_000000000013';
    // receiverTrackId stays null: the offer's audio m-section fires no track.
    emitRelay(publisherId, publisherOffer(negotiationId));
    await vi.advanceTimersByTimeAsync(0);
    expect(bridgeMocks.sent.filter((entry) => entry.payload.kind === 'answer')).toHaveLength(1);
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 11,
      publicationId,
    });

    // The track deadline starts only once the receiver proved the pair, on
    // the proof poll after the publisher's candidate arrives.
    emitRelay(publisherId, publisherCandidate(negotiationId, safeCandidate('auto')));
    await vi.advanceTimersByTimeAsync(25);
    expect(peerConnections[0]?.remoteChannel.send).toHaveBeenCalledWith(RECEIVER_PAIR_PROVEN);
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.onLiveRouteFallback).toHaveBeenCalledWith({
      role: 'receiver',
      reason: 'receiver-track-timeout',
      participantId: publisherId,
      generation: 11,
      publicationId,
    });
    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("reports only a publisher's 'stopped' close of the current receiver route, once and with no close back (5B-G6)", async () => {
    localParticipantId = receiverA;
    const callbacks = configureCallbacks();
    const probeOffer = (negotiationId: string) => publisherOffer(negotiationId);
    const close = (negotiationId: string, reason: string) => ({
      kind: 'close',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 11,
      publicationId,
      negotiationId,
      reason,
    });

    // 'superseded' closes the current route and reports nothing.
    emitRelay(publisherId, probeOffer('negotiation_000000000021'));
    await vi.waitFor(() => expect(peerConnections).toHaveLength(1));
    emitRelay(publisherId, close('negotiation_000000000021', 'superseded'));
    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);

    // A 'stopped' close of another negotiation or from another sender is not
    // this route's.
    emitRelay(publisherId, probeOffer('negotiation_000000000022'));
    await vi.waitFor(() => expect(peerConnections).toHaveLength(2));
    emitRelay(publisherId, close('negotiation_000000000099', 'stopped'));
    emitRelay(attackerId, close('negotiation_000000000022', 'stopped'));
    expect(peerConnections[1]?.close).not.toHaveBeenCalled();
    expect(callbacks.onLiveRouteStopped).not.toHaveBeenCalled();

    emitRelay(publisherId, close('negotiation_000000000022', 'stopped'));
    expect(peerConnections[1]?.close).toHaveBeenCalledTimes(1);
    expect(callbacks.onLiveRouteStopped).toHaveBeenCalledTimes(1);
    expect(callbacks.onLiveRouteStopped).toHaveBeenCalledWith({
      participantId: publisherId,
      generation: 11,
      publicationId,
    });
    // The route is gone: a repeated close reports nothing more.
    emitRelay(publisherId, close('negotiation_000000000022', 'stopped'));
    expect(callbacks.onLiveRouteStopped).toHaveBeenCalledTimes(1);
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
    expect(bridgeMocks.sent.filter((entry) => entry.payload.kind === 'close')).toEqual([]);
  });
});

describe('PRO system-audio LAN-direct live lifecycle', () => {
  it('keeps healthy incumbents through a failed newcomer until promotion or roster teardown', async () => {
    const callbacks = configureCallbacks();
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 12,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });
    await expect(
      direct.activateProSystemAudioDirectPublication({
        ownerParticipantId: publisherId,
        generation: 12,
        publicationId,
        targets: [target(receiverA)],
      }),
    ).resolves.toBe(true);
    const incumbent = peerConnections[0]!;
    callbacks.onLiveRouteFallback.mockImplementation(() => {
      expect(incumbent.close).not.toHaveBeenCalled();
    });

    nextLocalities.push('non-local');
    await expect(
      direct.reconcileProSystemAudioDirectTargets([target(receiverA), target(receiverB)], 250),
    ).resolves.toBe(false);

    expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);
    expect(incumbent.close).not.toHaveBeenCalled();
    expect(peerConnections[1]?.close).toHaveBeenCalledTimes(1);
    // A failed SFU retry can leave the direct descriptor authoritative. A
    // fresh roster must keep incumbents without creating another B route.
    await expect(
      direct.reconcileProSystemAudioDirectTargets([target(receiverA), target(receiverB)], 250),
    ).resolves.toBe(false);
    expect(peerConnections).toHaveLength(2);
    expect(incumbent.close).not.toHaveBeenCalled();

    // An incarnation change still revokes the old authenticated route while
    // promotion is pending; retaining audio must not retain stale authority.
    await expect(
      direct.reconcileProSystemAudioDirectTargets([target(receiverA, 'joined-at:replacement')]),
    ).resolves.toBe(false);
    expect(incumbent.close).toHaveBeenCalledTimes(1);
    expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);
  });

  it('continues locality checks and closes only invalid incumbents while SFU promotion waits', async () => {
    const callbacks = configureCallbacks();
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 12,
      publicationId,
      targets: [target(receiverA), target(receiverB)],
      timeoutMs: 250,
    });
    vi.useFakeTimers();
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 12,
      publicationId,
    });
    nextLocalities.push('non-local');
    const reconcile = direct.reconcileProSystemAudioDirectTargets(
      [target(receiverA), target(receiverB), target(receiverC)],
      250,
    );
    await vi.advanceTimersByTimeAsync(250);
    await expect(reconcile).resolves.toBe(false);
    expect(peerConnections[0]?.close).not.toHaveBeenCalled();
    expect(peerConnections[1]?.close).not.toHaveBeenCalled();

    peerConnections[0]!.locality = 'global-ipv6';
    const healthyStatsCalls = peerConnections[1]!.statsCallCount;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
    expect(peerConnections[1]?.close).not.toHaveBeenCalled();
    expect(peerConnections[1]!.statsCallCount).toBeGreaterThan(healthyStatsCalls + 1);
    expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);

    direct.resetProSystemAudioDirectTransport({ notifyPeers: false });
    expect(peerConnections[1]?.close).toHaveBeenCalledTimes(1);
    const statsAfterReset = peerConnections[1]!.statsCallCount;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(peerConnections[1]!.statsCallCount).toBe(statsAfterReset);
  });

  it('negotiates a late join and emits one fenced fallback on a live disconnect', async () => {
    const callbacks = configureCallbacks();
    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 12,
      publicationId,
      targets: [],
    });
    expect(descriptor).not.toBeNull();
    await expect(
      direct.activateProSystemAudioDirectPublication({
        ownerParticipantId: publisherId,
        generation: 12,
        publicationId,
      }),
    ).resolves.toBe(true);

    nextLocalities.push('host-host');
    await expect(
      direct.reconcileProSystemAudioDirectTargets([target(receiverB)], 250),
    ).resolves.toBe(true);
    expect(peerConnections).toHaveLength(1);
    expect(
      bridgeMocks.sent.some(
        (entry) =>
          entry.payload.kind === 'offer' && entry.payload.targetParticipantId === receiverB,
      ),
    ).toBe(true);

    peerConnections[0]?.emitFailed();
    peerConnections[0]?.emitFailed();
    expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);
    expect(callbacks.onLiveRouteFallback).toHaveBeenCalledWith({
      role: 'publisher',
      reason: 'connection-failed',
      participantId: receiverB,
      generation: 12,
      publicationId,
    });
  });

  it('serializes overlapping presence reconciles and validates only the newest target set', async () => {
    const callbacks = configureCallbacks();
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 12,
      publicationId,
      targets: [],
    });
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 12,
      publicationId,
    });
    const firstStats = deferred<void>();
    nextLocalities.push('host-host', 'host-host');
    nextStatsGates.push(firstStats.promise, Promise.resolve());

    const firstReconcile = direct.reconcileProSystemAudioDirectTargets([target(receiverB)], 250);
    await vi.waitFor(() => expect(peerConnections[0]?.statsCallCount).toBe(1));
    const newestReconcile = direct.reconcileProSystemAudioDirectTargets(
      [target(receiverB), target(receiverC)],
      250,
    );

    expect(peerConnections).toHaveLength(1);
    firstStats.resolve(undefined);
    await expect(Promise.all([firstReconcile, newestReconcile])).resolves.toEqual([true, true]);
    expect(peerConnections).toHaveLength(2);
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
    expect(
      bridgeMocks.sent
        .filter((entry) => entry.payload.kind === 'offer' && entry.payload.phase === 'media')
        .map((entry) => entry.payload.targetParticipantId),
    ).toEqual([receiverB, receiverC]);
  });

  it('closes a superseded negotiating route before locality proof can add media tracks', async () => {
    const callbacks = configureCallbacks();
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 12,
      publicationId,
      targets: [],
    });
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 12,
      publicationId,
    });
    const stats = deferred<void>();
    nextLocalities.push('host-host');
    nextStatsGates.push(stats.promise);

    const staleReconcile = direct.reconcileProSystemAudioDirectTargets(
      [target(receiverA, 'joined-at:100')],
      250,
    );
    await vi.waitFor(() => expect(peerConnections[0]?.statsCallCount).toBe(1));
    const newestReconcile = direct.reconcileProSystemAudioDirectTargets([], 250);

    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
    stats.resolve(undefined);
    await expect(Promise.all([staleReconcile, newestReconcile])).resolves.toEqual([true, true]);
    expect(peerConnections[0]!.sendingTrack()).toBeNull();
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
  });

  it('stops an existing live route immediately when the newest snapshot removes it', async () => {
    const callbacks = configureCallbacks();
    nextLocalities.push('host-host');
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 12,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 12,
      publicationId,
    });
    const lateStats = deferred<void>();
    nextLocalities.push('host-host');
    nextStatsGates.push(lateStats.promise);

    const firstReconcile = direct.reconcileProSystemAudioDirectTargets(
      [target(receiverA), target(receiverB)],
      250,
    );
    await vi.waitFor(() => expect(peerConnections[1]?.statsCallCount).toBe(1));
    const newestReconcile = direct.reconcileProSystemAudioDirectTargets([target(receiverB)], 250);

    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
    lateStats.resolve(undefined);
    await expect(Promise.all([firstReconcile, newestReconcile])).resolves.toEqual([true, true]);
  });

  it('fully resets publisher and receiver state and ignores delayed stale signaling', async () => {
    configureCallbacks();
    nextLocalities.push('host-host');
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 13,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 13,
      publicationId,
    });
    const negotiationId = String(
      bridgeMocks.sent.find((entry) => entry.payload.kind === 'offer')?.payload.negotiationId,
    );

    direct.resetProSystemAudioDirectTransport();
    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
    peerConnections[0]?.addIceCandidate.mockClear();
    await expect(direct.reconcileProSystemAudioDirectTargets([target(receiverA)])).resolves.toBe(
      false,
    );
    emitRelay(receiverA, {
      kind: 'answer',
      targetParticipantId: publisherId,
      direction: 'subscriber',
      phase: 'media',
      generation: 13,
      publicationId,
      negotiationId,
      description: { type: 'answer', sdp: 'delayed-answer' },
    });
    emitRelay(receiverA, {
      kind: 'candidate',
      targetParticipantId: publisherId,
      direction: 'subscriber',
      generation: 13,
      publicationId,
      negotiationId,
      candidate: { candidate: safeCandidate('delayed') },
    });
    await Promise.resolve();
    expect(peerConnections).toHaveLength(1);
    expect(peerConnections[0]?.addIceCandidate).not.toHaveBeenCalled();
    expect(
      bridgeMocks.sent.some(
        (entry) => entry.payload.kind === 'close' && entry.payload.reason === 'stopped',
      ),
    ).toBe(true);
  });

  it('replaces a same-ID route when its participant incarnation token changes', async () => {
    configureCallbacks();
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 14,
      publicationId,
      targets: [],
    });
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 14,
      publicationId,
      targets: [],
    });

    nextLocalities.push('host-host');
    await expect(
      direct.reconcileProSystemAudioDirectTargets([target(receiverA, 'joined-at:100')], 250),
    ).resolves.toBe(true);
    const firstRoute = peerConnections[0];
    nextLocalities.push('host-host');
    await expect(
      direct.reconcileProSystemAudioDirectTargets([target(receiverA, 'joined-at:200')], 250),
    ).resolves.toBe(true);

    expect(firstRoute?.close).toHaveBeenCalledTimes(1);
    expect(peerConnections).toHaveLength(2);
    expect(
      bridgeMocks.sent.filter(
        (entry) =>
          entry.payload.kind === 'offer' &&
          entry.payload.phase === 'media' &&
          entry.payload.targetParticipantId === receiverA,
      ),
    ).toHaveLength(2);
  });

  it('reproofs the exact pair at activation and falls back if it changed to global IPv6', async () => {
    const callbacks = configureCallbacks();
    nextLocalities.push('host-host');
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 15,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });
    peerConnections[0]!.locality = 'global-ipv6';

    await expect(
      direct.activateProSystemAudioDirectPublication({
        ownerParticipantId: publisherId,
        generation: 15,
        publicationId,
        targets: [target(receiverA)],
      }),
    ).resolves.toBe(false);
    expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);
    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('fails activation when desired target coverage differs from the proven route set', async () => {
    const callbacks = configureCallbacks();
    nextLocalities.push('host-host');
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 15,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });

    await expect(
      direct.activateProSystemAudioDirectPublication({
        ownerParticipantId: publisherId,
        generation: 15,
        publicationId,
        targets: [target(receiverA), target(receiverB)],
      }),
    ).resolves.toBe(false);
    expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);
    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('reproofs on live connection changes and emits only one fallback', async () => {
    const callbacks = configureCallbacks();
    nextLocalities.push('host-host');
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 16,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 16,
      publicationId,
      targets: [target(receiverA)],
    });
    peerConnections[0]!.locality = 'global-ipv6';
    peerConnections[0]!.emitConnected();

    await vi.waitFor(() => expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1));
    peerConnections[0]!.emitConnected();
    expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);
  });

  it('invalidates an awaited stats proof after reset without adding media tracks', async () => {
    configureCallbacks();
    const statsGate = deferred<void>();
    nextStatsGates.push(statsGate.promise);
    const attempt = direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 17,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });
    await vi.waitFor(() => expect(peerConnections[0]?.statsCallCount).toBe(1));

    direct.resetProSystemAudioDirectTransport({ notifyPeers: false });
    statsGate.resolve(undefined);
    await expect(attempt).resolves.toBeNull();
    expect(peerConnections[0]!.sendingTrack()).toBeNull();
  });

  it('drops outbound global trickle, keeps safe candidates, and clears reproof timers', async () => {
    const callbacks = configureCallbacks();
    nextLocalities.push('host-host');
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 18,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 250,
    });
    vi.useFakeTimers();
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 18,
      publicationId,
      targets: [target(receiverA)],
    });
    peerConnections[0]!.emitLocalCandidate('candidate:global 1 udp 1 2001:db8::10 5000 typ host');
    peerConnections[0]!.emitLocalCandidate(
      `${safeCandidate('after-global')} generation 0 network-cost 999 raddr 203.0.113.10 rport 6000`,
    );
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
    const statsCalls = peerConnections[0]!.statsCallCount;
    direct.resetProSystemAudioDirectTransport({ notifyPeers: false });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(peerConnections[0]!.statsCallCount).toBe(statsCalls);
    expect(
      bridgeMocks.sent.some(
        (entry) =>
          entry.payload.kind === 'candidate' &&
          (entry.payload.candidate as RTCIceCandidateInit).candidate?.includes('2001:db8'),
      ),
    ).toBe(false);
    expect(
      bridgeMocks.sent.some(
        (entry) =>
          entry.payload.kind === 'candidate' &&
          (entry.payload.candidate as RTCIceCandidateInit).candidate ===
            safeCandidate('after-global'),
      ),
    ).toBe(true);
    expect(
      bridgeMocks.sent.some(
        (entry) =>
          entry.payload.kind === 'candidate' &&
          (entry.payload.candidate as RTCIceCandidateInit).candidate ===
            safeCandidate('after-global') &&
          (entry.payload.candidate as RTCIceCandidateInit).usernameFragment === 'local-fragment',
      ),
    ).toBe(true);
  });
});

// Field case, 2026-10-30: a desktop Edge sharer and an iPhone Safari listener on
// one home Wi-Fi. The phone answered the data-channel-only probe in 0.75 s and
// the host-to-host pair connected 0.09 s later, but the retired two-round-trip
// protocol's media answer missed the attempt's single 2 s budget, so every
// share went to the SFU (pinned in d0b71a89). One round trip now carries the
// audio m-section: a receiver paced like that phone answers it in 1.2 s, the
// slower media pace, connects 0.09 s later and proves its pair 0.03 s after.
describe('PRO system-audio LAN-direct one round trip with a phone-paced receiver', () => {
  const PROBE_ANSWER_MS = 750;
  const MEDIA_ANSWER_MS = 1_200;
  const ICE_CONNECT_MS = 90;
  const RECEIVER_PROOF_MS = 30;

  interface PacedReceiver {
    id: string;
    answerMs: number;
    connects: boolean;
  }

  let setRemoteDescription: MockInstance<MockRTCPeerConnection['setRemoteDescription']> | null =
    null;

  function installPacedReceivers(receivers: readonly PacedReceiver[]): void {
    const byId = new Map(receivers.map((receiver) => [receiver.id, receiver]));
    bridgeMocks.send.mockImplementation((channel, payload) => {
      bridgeMocks.sent.push({ channel, payload });
      const receiver = byId.get(String(payload.targetParticipantId));
      if (payload.kind !== 'offer' || !receiver || !Number.isFinite(receiver.answerMs)) return true;
      setTimeout(() => {
        emitRelay(receiver.id, {
          kind: 'answer',
          targetParticipantId: localParticipantId,
          direction: 'subscriber',
          phase: 'media',
          generation: payload.generation,
          publicationId: payload.publicationId,
          negotiationId: payload.negotiationId,
          description: {
            type: 'answer',
            sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\no=${receiver.id}`,
          },
        });
        emitRelay(receiver.id, {
          kind: 'candidate',
          targetParticipantId: localParticipantId,
          direction: 'subscriber',
          generation: payload.generation,
          publicationId: payload.publicationId,
          negotiationId: payload.negotiationId,
          candidate: { candidate: safeCandidate('auto') },
        });
      }, receiver.answerMs);
      return true;
    });
    setRemoteDescription = vi
      .spyOn(MockRTCPeerConnection.prototype, 'setRemoteDescription')
      .mockImplementation(async function (
        this: MockRTCPeerConnection,
        description: RTCSessionDescriptionInit,
      ) {
        this.remoteDescription = description as RTCSessionDescription;
        const receiver = receivers[peerConnections.indexOf(this)];
        if (description.type !== 'answer' || !receiver?.connects) return;
        setTimeout(() => {
          this.emitConnected();
          if (!receiverProofWithheld) {
            setTimeout(() => this.emitReceiverProof(), RECEIVER_PROOF_MS);
          }
        }, ICE_CONNECT_MS);
      });
  }

  function offerPhases(participantId = receiverA): unknown[] {
    return bridgeMocks.sent
      .filter(
        (entry) =>
          entry.payload.kind === 'offer' && entry.payload.targetParticipantId === participantId,
      )
      .map((entry) => entry.payload.phase);
  }

  function infoLines(): string[] {
    return vi.mocked(log.info).mock.calls.map(([line]) => String(line));
  }

  /** Starts an attempt and records when it settles, in fake-timer milliseconds. */
  function track(attempt: Promise<unknown>): { settledAt: () => number | null } {
    const startedAt = Date.now();
    let settledAt: number | null = null;
    void attempt.then(
      () => {
        settledAt = Date.now() - startedAt;
      },
      () => undefined,
    );
    return { settledAt: () => settledAt };
  }

  beforeEach(() => {
    vi.mocked(log.info).mockClear();
  });

  afterEach(() => {
    setRemoteDescription?.mockRestore();
    setRemoteDescription = null;
  });

  it.each(['initial', 'late-join'] as const)(
    'proves LAN-direct in one round trip during %s negotiation, attaching audio only after both proofs',
    async (phase) => {
      vi.useFakeTimers();
      const callbacks = configureCallbacks();
      if (phase === 'late-join') {
        await direct.attemptProSystemAudioDirectPublication({
          track: audioTrack('capture-stereo'),
          generation: 7,
          publicationId,
          targets: [],
        });
        await expect(
          direct.activateProSystemAudioDirectPublication({
            ownerParticipantId: publisherId,
            generation: 7,
            publicationId,
          }),
        ).resolves.toBe(true);
      }
      installPacedReceivers([{ id: receiverA, answerMs: MEDIA_ANSWER_MS, connects: true }]);
      const attempt =
        phase === 'initial'
          ? direct.attemptProSystemAudioDirectPublication({
              track: audioTrack('capture-stereo'),
              generation: 7,
              publicationId,
              targets: [target(receiverA)],
            })
          : direct.reconcileProSystemAudioDirectTargets([target(receiverA)]);
      const timing = track(attempt);

      // Before the receiver's proof the offer is out and the sender is empty.
      await vi.advanceTimersByTimeAsync(MEDIA_ANSWER_MS + ICE_CONNECT_MS);
      expect(offerPhases()).toEqual(['media']);
      expect(peerConnections[0]!.sendingTrack()).toBeNull();
      expect(timing.settledAt()).toBeNull();

      await vi.advanceTimersByTimeAsync(RECEIVER_PROOF_MS + 25);
      expect(timing.settledAt()).toBeLessThan(1_400);
      if (phase === 'initial') {
        await expect(attempt).resolves.toEqual({
          publicationId,
          transport: 'lan-direct',
          protocolVersion: 2,
        });
      } else {
        await expect(attempt).resolves.toBe(true);
      }
      expect(peerConnections[0]!.sendingTrack()?.id).toBe('capture-stereo');
      expect(peerConnections[0]?.close).not.toHaveBeenCalled();
      expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
      expect(infoLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Publisher pair check to 0001 proven after \d+ ms by stats-host \(connected at \d+ ms; native none; stats host\/private-ipv4 to host\/mdns; candidates sent 1, refused 0, received 1, added 1, first at -?\d+ ms\)$/,
        ),
        expect.stringMatching(
          /^\[ProSysAudioDirect\] LAN route to 0001 proven in \d+ ms \(answer 12\d\d, pair 13\d\d, receiver 13\d\d\)$/,
        ),
      ]);
    },
  );

  it('falls back at the 2 s answer deadline when the receiver never answers, as an older build does', async () => {
    vi.useFakeTimers();
    configureCallbacks();
    installPacedReceivers([{ id: receiverA, answerMs: Number.POSITIVE_INFINITY, connects: true }]);
    const attempt = direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 7,
      publicationId,
      targets: [target(receiverA)],
    });
    const timing = track(attempt);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(timing.settledAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    await expect(attempt).resolves.toBeNull();
    expect(peerConnections[0]!.sendingTrack()).toBeNull();
    expect(bridgeMocks.sent.at(-1)?.payload).toEqual(
      expect.objectContaining({
        kind: 'close',
        targetParticipantId: receiverA,
        reason: 'fallback',
      }),
    );
    expect(infoLines()).toEqual([
      expect.stringMatching(
        /^\[ProSysAudioDirect\] LAN route to 0001 not proven at answer after 20\d\d ms \(deadline; no answer\)$/,
      ),
    ]);
  });

  it('falls back one second after the answer when the pair never connects', async () => {
    vi.useFakeTimers();
    configureCallbacks();
    installPacedReceivers([{ id: receiverA, answerMs: PROBE_ANSWER_MS, connects: false }]);
    const attempt = direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 7,
      publicationId,
      targets: [target(receiverA)],
    });
    const timing = track(attempt);

    await vi.advanceTimersByTimeAsync(PROBE_ANSWER_MS + 999);
    expect(timing.settledAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    await expect(attempt).resolves.toBeNull();
    expect(timing.settledAt()).toBeLessThan(PROBE_ANSWER_MS + 1_050);
    expect(peerConnections[0]!.sendingTrack()).toBeNull();
    expect(infoLines()).toEqual([
      expect.stringMatching(
        /^\[ProSysAudioDirect\] Publisher pair check to 0001 deadline after 10\d\d ms by not-connected \(never connected; native none; stats none; candidates sent 1, refused 0, received 1, added 1, first at -?\d+ ms\)$/,
      ),
      expect.stringMatching(
        /^\[ProSysAudioDirect\] LAN route to 0001 not proven at pair after 17\d\d ms \(deadline; answer 7\d\d\)$/,
      ),
    ]);
  });

  it('attaches no audio and falls back when the receiver never confirms its own pair proof', async () => {
    vi.useFakeTimers();
    configureCallbacks();
    receiverProofWithheld = true;
    installPacedReceivers([{ id: receiverA, answerMs: MEDIA_ANSWER_MS, connects: true }]);
    const attempt = direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 7,
      publicationId,
      targets: [target(receiverA)],
    });

    await vi.advanceTimersByTimeAsync(MEDIA_ANSWER_MS + 1_050);
    await expect(attempt).resolves.toBeNull();
    // The publisher proved its own end, but one end is not enough.
    expect(peerConnections[0]!.sendingTrack()).toBeNull();
    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
    expect(infoLines()).toEqual([
      expect.stringMatching(
        /^\[ProSysAudioDirect\] Publisher pair check to 0001 proven after \d+ ms by stats-host \(connected at \d+ ms; native none; stats host\/private-ipv4 to host\/mdns; candidates sent 1, refused 0, received 1, added 1, first at -?\d+ ms\)$/,
      ),
      expect.stringMatching(
        /^\[ProSysAudioDirect\] LAN route to 0001 not proven at receiver-proof after 22\d\d ms \(deadline; answer 12\d\d, pair 13\d\d\)$/,
      ),
    ]);
  });

  it('ignores a pair proof that is not the receiver message', async () => {
    vi.useFakeTimers();
    configureCallbacks();
    receiverProofWithheld = true;
    installPacedReceivers([{ id: receiverA, answerMs: PROBE_ANSWER_MS, connects: true }]);
    const attempt = direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 7,
      publicationId,
      targets: [target(receiverA)],
    });
    await vi.advanceTimersByTimeAsync(PROBE_ANSWER_MS + ICE_CONNECT_MS + 10);
    peerConnections[0]!.emitReceiverProof('receiver-pair-proven ');
    peerConnections[0]!.emitReceiverProof({ proven: true });

    await vi.advanceTimersByTimeAsync(1_100);
    await expect(attempt).resolves.toBeNull();
    expect(peerConnections[0]!.sendingTrack()).toBeNull();
  });

  it('settles a mixed room at the first failed route instead of waiting for a slow LAN route', async () => {
    vi.useFakeTimers();
    const callbacks = configureCallbacks();
    installPacedReceivers([
      // A slow phone on the LAN, and a remote listener whose pair never connects.
      { id: receiverA, answerMs: 1_800, connects: true },
      { id: receiverB, answerMs: 300, connects: false },
    ]);
    const attempt = direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 7,
      publicationId,
      targets: [target(receiverA), target(receiverB)],
    });
    const timing = track(attempt);

    await vi.advanceTimersByTimeAsync(1_350);
    await expect(attempt).resolves.toBeNull();
    expect(timing.settledAt()).toBeLessThan(1_350);
    expect(peerConnections.map((pc) => pc.sendingTrack())).toEqual([null, null]);
    expect(peerConnections.map((pc) => pc.close.mock.calls.length)).toEqual([1, 1]);
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
    // The late answer of the slow route reaches no route.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      setRemoteDescription?.mock.calls.filter(([description]) => description.type === 'answer'),
    ).toHaveLength(1);
  });

  // A stage that gives up before its deadline timer (here a non-local pair)
  // must not leave its route behind: an overlapping reconcile pass would find
  // it and commit a route whose sender never got the track.
  it('retires a late-join route that fails before its stage deadline, so an overlapping reconcile renegotiates it', async () => {
    vi.useFakeTimers();
    const callbacks = configureCallbacks();
    await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 7,
      publicationId,
      targets: [],
    });
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 7,
      publicationId,
    });
    installPacedReceivers([
      { id: receiverA, answerMs: PROBE_ANSWER_MS, connects: true },
      { id: receiverA, answerMs: PROBE_ANSWER_MS, connects: true },
    ]);
    nextLocalities.push('non-local', 'host-host');

    const first = direct.reconcileProSystemAudioDirectTargets([target(receiverA)]);
    await vi.advanceTimersByTimeAsync(PROBE_ANSWER_MS + 10);
    // A presence update lands while the first route proves its pair.
    const overlapping = direct.reconcileProSystemAudioDirectTargets([target(receiverA)]);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(Promise.all([first, overlapping])).resolves.toEqual([true, true]);
    expect(peerConnections).toHaveLength(2);
    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
    expect(peerConnections[0]!.sendingTrack()).toBeNull();
    expect(peerConnections[1]!.sendingTrack()?.id).toBe('capture-stereo');
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
    expect(infoLines()).toEqual([
      expect.stringMatching(
        /^\[ProSysAudioDirect\] Publisher pair check to 0001 non-local after \d+ ms by stats-type \(connected at \d+ ms; native none; stats host\/private-ipv4 to relay\/private-ipv4; candidates sent 1, refused 0, received 1, added 1, first at -?\d+ ms\)$/,
      ),
      expect.stringMatching(/not proven at pair after \d+ ms \(non-local; answer \d+\)$/),
      expect.stringMatching(/Publisher pair check to 0001 proven after \d+ ms by stats-host /),
      expect.stringMatching(/proven in \d+ ms \(answer \d+, pair \d+, receiver \d+\)$/),
    ]);
  });

  it('ignores a duplicate answer that arrives while the first one is still applied', async () => {
    vi.useFakeTimers();
    configureCallbacks();
    installPacedReceivers([{ id: receiverA, answerMs: PROBE_ANSWER_MS, connects: true }]);
    const pacedSend = bridgeMocks.send.getMockImplementation()!;
    bridgeMocks.send.mockImplementation((channel, payload) => {
      const sent = pacedSend(channel, payload);
      // The relay delivers the same answer twice, 1 ms apart.
      if (payload.kind === 'offer') setTimeout(() => pacedSend(channel, payload), 1);
      return sent;
    });
    // A real connection rejects a second answer once the first is applied.
    const paced = setRemoteDescription!.getMockImplementation()!;
    setRemoteDescription!.mockImplementation(async function (
      this: MockRTCPeerConnection,
      description: RTCSessionDescriptionInit,
    ) {
      if (description.type === 'answer' && this.remoteDescription?.type === 'answer') {
        throw new DOMException('Called in wrong state: stable', 'InvalidStateError');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return paced.call(this, description);
    });
    const attempt = direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 7,
      publicationId,
      targets: [target(receiverA)],
    });

    await vi.advanceTimersByTimeAsync(PROBE_ANSWER_MS + 500);
    await expect(attempt).resolves.toEqual(
      expect.objectContaining({ transport: 'lan-direct', publicationId }),
    );
    expect(
      setRemoteDescription!.mock.calls.filter(([description]) => description.type === 'answer'),
    ).toHaveLength(1);
  });
});

describe('PRO system-audio LAN-direct receiver hand-over waits for the attached track', () => {
  it('falls back when a live, proven receiver never hears that the publisher attached its track', async () => {
    vi.useFakeTimers();
    localParticipantId = receiverA;
    receiverTrackId = 'remote-stereo-track';
    const callbacks = configureCallbacks();
    const negotiationId = 'negotiation_000000000031';
    // A late joiner: the publication is already live when the offer arrives.
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 11,
      publicationId,
    });
    emitRelay(publisherId, publisherOffer(negotiationId));
    await vi.advanceTimersByTimeAsync(0);
    emitRelay(publisherId, publisherCandidate(negotiationId, safeCandidate('auto')));
    await vi.advanceTimersByTimeAsync(25);
    expect(peerConnections[0]?.remoteChannel.send).toHaveBeenCalledWith(RECEIVER_PAIR_PROVEN);
    // The track arrived and the pair is proven, but no audio flows on it yet.
    expect(callbacks.onReceiverTrackReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.onReceiverTrackReady).not.toHaveBeenCalled();
    expect(callbacks.onLiveRouteFallback).toHaveBeenCalledWith({
      role: 'receiver',
      reason: 'receiver-track-timeout',
      participantId: publisherId,
      generation: 11,
      publicationId,
    });
    expect(peerConnections[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('hands a live receiver its track as soon as the publisher says it is attached', async () => {
    vi.useFakeTimers();
    localParticipantId = receiverA;
    receiverTrackId = 'remote-stereo-track';
    const callbacks = configureCallbacks();
    const negotiationId = 'negotiation_000000000032';
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 11,
      publicationId,
    });
    emitRelay(publisherId, publisherOffer(negotiationId));
    await vi.advanceTimersByTimeAsync(0);
    emitRelay(publisherId, publisherCandidate(negotiationId, safeCandidate('auto')));
    await vi.advanceTimersByTimeAsync(25);
    peerConnections[0]!.emitPublisherAttached();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onReceiverTrackReady).toHaveBeenCalledTimes(1);
    expect(callbacks.onReceiverTrackReady).toHaveBeenCalledWith(
      expect.objectContaining({ track: expect.objectContaining({ id: 'remote-stereo-track' }) }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
  });
});

// A browser announces the publisher's probe channel (ondatachannel) only after
// DTLS, SCTP and the channel's open handshake, so after the receiver's own pair
// proof. The proof then leaves from ondatachannel, for a channel announced
// open, or from the channel's open event, for one announced connecting, and
// only once.
describe('PRO system-audio LAN-direct receiver proof on a probe channel announced after it', () => {
  function receiverProofLines(): string[] {
    return vi
      .mocked(log.info)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.startsWith('[ProSysAudioDirect] Receiver LAN pair'));
  }

  /** A late joiner whose probe channel is held answers the publisher's one offer. */
  async function answeredLiveReceiver(negotiationId: string) {
    vi.useFakeTimers();
    vi.mocked(log.info).mockClear();
    localParticipantId = receiverA;
    receiverTrackId = 'remote-stereo-track';
    receiverChannelHeld = true;
    const callbacks = configureCallbacks();
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 11,
      publicationId,
    });
    emitRelay(publisherId, publisherOffer(negotiationId));
    await vi.advanceTimersByTimeAsync(0);
    expect(bridgeMocks.sent.filter((entry) => entry.payload.kind === 'answer')).toHaveLength(1);
    return { callbacks, pc: peerConnections[0]! };
  }

  /** The publisher's candidate arrives and the next proof poll proves the pair. */
  async function provePair(negotiationId: string): Promise<void> {
    emitRelay(publisherId, publisherCandidate(negotiationId, safeCandidate('auto')));
    await vi.advanceTimersByTimeAsync(25);
    expect(receiverProofLines()).toEqual([
      expect.stringMatching(/^\[ProSysAudioDirect\] Receiver LAN pair proven in \d+ ms$/),
    ]);
  }

  /** The track waits for the publisher's word, then goes to playback once. */
  async function expectHandOverOnlyAfterAttach(
    callbacks: ReturnType<typeof configureCallbacks>,
    pc: MockRTCPeerConnection,
  ): Promise<void> {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callbacks.onReceiverTrackReady).not.toHaveBeenCalled();
    pc.emitPublisherAttached();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onReceiverTrackReady).toHaveBeenCalledTimes(1);
    expect(callbacks.onReceiverTrackReady).toHaveBeenCalledWith(
      expect.objectContaining({ track: expect.objectContaining({ id: 'remote-stereo-track' }) }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pc.remoteChannel.send).toHaveBeenCalledTimes(1);
    expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
    expect(pc.close).not.toHaveBeenCalled();
  }

  it.each([
    { order: 'with no open event', openEvent: false, negotiationId: 'negotiation_000000000033' },
    {
      order: 'followed by its open event',
      openEvent: true,
      negotiationId: 'negotiation_000000000034',
    },
  ])(
    'sends its pair proof once when the channel is announced open after the proof, $order',
    async ({ openEvent, negotiationId }) => {
      const { callbacks, pc } = await answeredLiveReceiver(negotiationId);
      await provePair(negotiationId);
      // Proven, but there is no channel to say it on yet.
      expect(pc.remoteChannel.send).not.toHaveBeenCalled();

      pc.announceRemoteChannel('open', { openEvent });
      expect(pc.remoteChannel.send).toHaveBeenCalledTimes(1);
      expect(pc.remoteChannel.send).toHaveBeenCalledWith(RECEIVER_PAIR_PROVEN);
      await expectHandOverOnlyAfterAttach(callbacks, pc);
    },
  );

  it.each([
    { moment: 'before', negotiationId: 'negotiation_000000000035' },
    { moment: 'after', negotiationId: 'negotiation_000000000036' },
  ] as const)(
    'sends its pair proof once when the channel is announced connecting $moment the proof and opens after it',
    async ({ moment, negotiationId }) => {
      const { callbacks, pc } = await answeredLiveReceiver(negotiationId);
      if (moment === 'before') pc.announceRemoteChannel('connecting');
      await provePair(negotiationId);
      if (moment === 'after') pc.announceRemoteChannel('connecting');
      // Proven, but the channel is still connecting: nothing can be sent on it.
      await vi.advanceTimersByTimeAsync(100);
      expect(pc.remoteChannel.send).not.toHaveBeenCalled();

      pc.openRemoteChannel();
      expect(pc.remoteChannel.send).toHaveBeenCalledTimes(1);
      expect(pc.remoteChannel.send).toHaveBeenCalledWith(RECEIVER_PAIR_PROVEN);
      await expectHandOverOnlyAfterAttach(callbacks, pc);
    },
  );
});

// 9.0.26 post-deploy: an iPhone Safari listener judged a real same-LAN pair
// non-local about 0.5 s into its proof, so every share used the SFU. iOS
// Safari answers, so it is ICE-controlled and meets the publisher's check
// before it has resolved the publisher's mDNS name: libwebrtc makes that
// remote prflx and later refines the same connection to the added host
// candidate in place, while the native selected-pair snapshot keeps the prflx
// remote. Both ends now hold a native host-to-prflx pair pending until the
// transport-selected stats pair refines to an added mDNS host candidate
// (ice-selected-pair.ts), and log one pair-check line when a proof ends.
describe('PRO system-audio LAN-direct host-to-prflx refinement (iOS Safari listener)', () => {
  const NEGOTIATION_ID = 'negotiation_000000000077';

  function directLines(): string[] {
    return vi
      .mocked(log.info)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.startsWith('[ProSysAudioDirect]'));
  }

  function pairCheckLines(): string[] {
    return directLines().filter((line) => / pair (?:check|reproof) /.test(line));
  }

  function closeReasons(): unknown[] {
    return bridgeMocks.sent
      .filter((entry) => entry.payload.kind === 'close')
      .map((entry) => entry.payload.reason);
  }

  /** A listener answers the publisher's offer; the publisher's mDNS candidate follows. */
  async function listenerWith(
    locality: Locality,
    native: AuthoritativePairMode | null,
    options: { addCandidate?: boolean } = {},
  ): Promise<MockRTCPeerConnection> {
    vi.useFakeTimers();
    vi.mocked(log.info).mockClear();
    localParticipantId = receiverA;
    receiverTrackId = 'remote-stereo-track';
    nextLocalities.push(locality);
    nextAuthoritativePairModes.push(native);
    configureCallbacks();
    emitRelay(publisherId, publisherOffer(NEGOTIATION_ID));
    if (options.addCandidate !== false) {
      emitRelay(publisherId, publisherCandidate(NEGOTIATION_ID, safeCandidate('auto')));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(bridgeMocks.sent.filter((entry) => entry.payload.kind === 'answer')).toHaveLength(1);
    return peerConnections[0]!;
  }

  describe('the listener', () => {
    it('waits on a native host-to-prflx pair and proves it once the selected stats pair refines to the added mDNS host', async () => {
      const pc = await listenerWith('prflx-unrefined', 'prflx');
      await vi.advanceTimersByTimeAsync(500);
      expect(directLines()).toEqual([]);
      expect(closeReasons()).toEqual([]);
      expect(pc.remoteChannel.send).not.toHaveBeenCalled();

      pc.locality = 'refined';
      await vi.advanceTimersByTimeAsync(25);
      expect(directLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Receiver pair check proven after 5\d\d ms by refined-host \(connected at 0 ms; native host\/mdns to prflx\/none; stats host\/none to host\/none; candidates sent 1, refused 0, received 1, added 1, first at 0 ms\)$/,
        ),
        expect.stringMatching(/^\[ProSysAudioDirect\] Receiver LAN pair proven in 5\d\d ms$/),
      ]);
      expect(pc.remoteChannel.send).toHaveBeenCalledWith(RECEIVER_PAIR_PROVEN);
      expect(closeReasons()).toEqual([]);
    });

    it('names when the first remote candidate was added, from the start of its proof', async () => {
      const pc = await listenerWith('prflx-unrefined', 'prflx', { addCandidate: false });
      await vi.advanceTimersByTimeAsync(300);
      emitRelay(publisherId, publisherCandidate(NEGOTIATION_ID, safeCandidate('auto')));
      await vi.advanceTimersByTimeAsync(200);
      pc.locality = 'refined';
      await vi.advanceTimersByTimeAsync(25);
      expect(pairCheckLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Receiver pair check proven after 5\d\d ms by refined-host \(.*; candidates sent 1, refused 0, received 1, added 1, first at 3\d\d ms\)$/,
        ),
      ]);
    });

    it('proves the refined pair as Chromium reports it, with empty statistics addresses', async () => {
      const pc = await listenerWith('refined-chromium', 'prflx');
      await vi.advanceTimersByTimeAsync(25);
      expect(directLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Receiver pair check proven after \d+ ms by refined-host \(connected at 0 ms; native host\/mdns to prflx\/none; stats host\/none to host\/none; candidates sent 1, refused 0, received 1, added 1, first at -?\d+ ms\)$/,
        ),
        expect.stringMatching(/^\[ProSysAudioDirect\] Receiver LAN pair proven in \d+ ms$/),
      ]);
      expect(pc.remoteChannel.send).toHaveBeenCalledWith(RECEIVER_PAIR_PROVEN);
    });

    it('proves a refined pair read while its consent check is in flight, once a check had a response', async () => {
      const pc = await listenerWith('refined-in-progress', 'prflx');
      await vi.advanceTimersByTimeAsync(25);
      expect(pairCheckLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Receiver pair check proven after \d+ ms by refined-host /,
        ),
      ]);
      expect(pc.remoteChannel.send).toHaveBeenCalledWith(RECEIVER_PAIR_PROVEN);
    });

    it('never proves an unrefined host-to-prflx pair: it fails at its 2 s window, not at once', async () => {
      await listenerWith('prflx-unrefined', 'prflx');
      await vi.advanceTimersByTimeAsync(1_900);
      expect(closeReasons()).toEqual([]);
      expect(directLines()).toEqual([]);

      await vi.advanceTimersByTimeAsync(200);
      expect(directLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Receiver pair check deadline after 20\d\d ms by prflx-unrefined \(connected at 0 ms; native host\/mdns to prflx\/none; stats host\/none to prflx\/none; candidates sent 1, refused 0, received 1, added 1, first at -?\d+ ms\)$/,
        ),
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Receiver LAN pair not proven \(deadline after 20\d\d ms\)$/,
        ),
        '[ProSysAudioDirect] Receiver route ended before live (receiver-locality-unproven)',
      ]);
      expect(closeReasons()).toEqual(['fallback']);
    });

    it('also waits, never refusing at once, when only statistics show a selected host-to-prflx pair', async () => {
      // Before WebKit's first route change its native snapshot is still null.
      const pc = await listenerWith('prflx-unrefined', null);
      await vi.advanceTimersByTimeAsync(500);
      expect(directLines()).toEqual([]);
      expect(closeReasons()).toEqual([]);

      pc.locality = 'refined';
      await vi.advanceTimersByTimeAsync(25);
      expect(directLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Receiver pair check proven after 5\d\d ms by stats-host \(connected at 0 ms; native none; stats host\/none to host\/none; candidates sent 1, refused 0, received 1, added 1, first at -?\d+ ms\)$/,
        ),
        expect.stringMatching(/^\[ProSysAudioDirect\] Receiver LAN pair proven in 5\d\d ms$/),
      ]);
    });

    it('logs its pair check as closed, with the last rule, when the publisher ends the route first', async () => {
      await listenerWith('prflx-unrefined', 'prflx');
      await vi.advanceTimersByTimeAsync(800);
      emitRelay(publisherId, {
        kind: 'close',
        targetParticipantId: receiverA,
        direction: 'publisher',
        generation: 11,
        publicationId,
        negotiationId: NEGOTIATION_ID,
        reason: 'fallback',
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(directLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Receiver pair check closed after 8\d\d ms by prflx-unrefined \(connected at 0 ms; native host\/mdns to prflx\/none; stats host\/none to prflx\/none; candidates sent 1, refused 0, received 1, added 1, first at -?\d+ ms\)$/,
        ),
      ]);
      // The publisher closed the route: nothing goes back.
      expect(closeReasons()).toEqual([]);
    });

    it('keeps the last reading taken while the route was current when the close lands during a statistics read', async () => {
      const pc = await listenerWith('prflx-unrefined', 'prflx');
      await vi.advanceTimersByTimeAsync(800);
      // The next read is held in getStats while the publisher closes the route,
      // which clears the ledger; that read would see the refined pair as
      // refined-key-pending if it were kept.
      const held = deferred<void>();
      pc.statsGate = held.promise;
      pc.locality = 'refined';
      await vi.advanceTimersByTimeAsync(25);
      emitRelay(publisherId, {
        kind: 'close',
        targetParticipantId: receiverA,
        direction: 'publisher',
        generation: 11,
        publicationId,
        negotiationId: NEGOTIATION_ID,
        reason: 'fallback',
      });
      await vi.advanceTimersByTimeAsync(0);
      held.resolve();
      await vi.advanceTimersByTimeAsync(25);
      expect(directLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Receiver pair check closed after 8\d\d ms by prflx-unrefined \(connected at 0 ms; native host\/mdns to prflx\/none; stats host\/none to prflx\/none; /,
        ),
      ]);
    });

    it('counts a gathered UDP candidate the LAN rule refused, and never signals it', async () => {
      const pc = await listenerWith('prflx-unrefined', 'prflx');
      // A numeric UDP host candidate (an origin with camera or microphone
      // permission gathers raw addresses) and a TCP one, which is not counted.
      pc.emitLocalCandidate('candidate:2 1 udp 2122260223 192.168.1.10 54322 typ host');
      pc.emitLocalCandidate('candidate:3 1 tcp 1518280447 192.168.1.10 9 typ host tcptype active');
      pc.locality = 'refined';
      await vi.advanceTimersByTimeAsync(25);
      expect(pairCheckLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Receiver pair check proven after \d+ ms by refined-host \(.*; candidates sent 1, refused 1, received 1, added 1, first at -?\d+ ms\)$/,
        ),
      ]);
      expect(JSON.stringify(bridgeMocks.sent)).not.toContain('192.168.1.10');
    });

    // Every threat case still fails closed. These stay pending, so the
    // receiver's existing 2 s window ends them.
    it.each([
      {
        name: 'a refined pair whose remote mDNS candidate was never added here',
        locality: 'refined' as const,
        addCandidate: false,
        rule: 'refined-key-pending',
      },
      {
        name: 'a stats pair on another local port (another connection)',
        locality: 'refined-other-port' as const,
        addCandidate: true,
        rule: 'prflx-unrefined',
      },
      {
        name: 'a stats pair of another ICE generation',
        locality: 'refined-other-generation' as const,
        addCandidate: true,
        rule: 'prflx-unrefined',
      },
      {
        name: 'an in-progress selected stats pair that never had a check response',
        locality: 'refined-in-progress-unanswered' as const,
        addCandidate: true,
        rule: 'prflx-unrefined',
      },
      {
        // The native snapshot may be that prflx connection, not the refined one.
        name: 'a refined pair while a prflx connection on the native port is still listed',
        locality: 'refined-prflx-listed' as const,
        addCandidate: true,
        rule: 'prflx-still-listed',
      },
    ])('never proves $name', async ({ locality, addCandidate, rule }) => {
      await listenerWith(locality, 'prflx', { addCandidate });
      await vi.advanceTimersByTimeAsync(1_900);
      expect(closeReasons()).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(directLines()[0]).toMatch(
        new RegExp(
          `^\\[ProSysAudioDirect\\] Receiver pair check deadline after \\d+ ms by ${rule} `,
        ),
      );
      expect(directLines().some((line) => line.includes('Receiver LAN pair proven'))).toBe(false);
      expect(peerConnections[0]!.remoteChannel.send).not.toHaveBeenCalled();
      expect(closeReasons()).toEqual(['fallback']);
    });

    it('never proves a pair whose native snapshot changes during every statistics read', async () => {
      let reads = 0;
      customNativePair = () => {
        const pair = prflxNativePair();
        reads += 1;
        return {
          local: pair.local,
          remote: {
            ...pair.remote,
            usernameFragment: `${REMOTE_UFRAG}-${reads}`,
          } as RTCIceCandidate,
        };
      };
      await listenerWith('refined', 'custom');
      await vi.advanceTimersByTimeAsync(2_100);
      expect(directLines()[0]).toMatch(
        /^\[ProSysAudioDirect\] Receiver pair check deadline after \d+ ms by snapshot-changed \(connected at 0 ms; native host\/mdns to prflx\/none; stats none;/,
      );
      expect(closeReasons()).toEqual(['fallback']);
    });

    // These are refused at the first connected reading, as before.
    it.each([
      {
        name: 'a refined pair whose statistics expose a public local address',
        locality: 'refined-global-ip' as const,
        native: 'prflx' as const,
        nativePair: null,
        line: 'by refined-address (connected at 0 ms; native host/mdns to prflx/none; stats host/public to host/none;',
      },
      {
        name: 'a host-to-prflx snapshot whose local address is public',
        locality: 'refined' as const,
        native: 'custom' as const,
        nativePair: { localAddress: '2001:db8:1::10' },
        line: 'by native-address (connected at 0 ms; native host/public to prflx/none; stats none;',
      },
      {
        name: 'a host-to-prflx snapshot whose prflx address is public',
        locality: 'refined' as const,
        native: 'custom' as const,
        nativePair: { remoteAddress: '203.0.113.5' },
        line: 'by native-address (connected at 0 ms; native host/mdns to prflx/public; stats none;',
      },
      {
        name: 'a local prflx snapshot',
        locality: 'refined' as const,
        native: 'custom' as const,
        nativePair: { localType: 'prflx', remoteType: 'host' },
        line: 'by native-type (connected at 0 ms; native prflx/mdns to host/none; stats none;',
      },
      {
        name: 'a host-to-srflx snapshot',
        locality: 'host-host' as const,
        native: 'srflx' as const,
        nativePair: null,
        line: 'by native-type (connected at 0 ms; native host/private-ipv4 to srflx/mdns; stats none;',
      },
      {
        name: 'a host-to-prflx snapshot whose statistics select two pairs',
        locality: 'refined-ambiguous' as const,
        native: 'prflx' as const,
        nativePair: null,
        line: 'by stats-ambiguous (connected at 0 ms; native host/mdns to prflx/none; stats none;',
      },
      {
        name: 'a host-to-relay snapshot',
        locality: 'host-host' as const,
        native: 'relay' as const,
        nativePair: null,
        line: 'by native-type (connected at 0 ms; native host/private-ipv4 to relay/mdns; stats none;',
      },
    ])('refuses $name at once', async ({ locality, native, nativePair, line }) => {
      if (nativePair) {
        customNativePair = () => {
          const pair = prflxNativePair();
          return {
            local: {
              ...pair.local,
              ...('localType' in nativePair ? { type: nativePair.localType } : {}),
              ...('localAddress' in nativePair ? { address: nativePair.localAddress } : {}),
            } as RTCIceCandidate,
            remote: {
              ...pair.remote,
              ...('remoteType' in nativePair ? { type: nativePair.remoteType } : {}),
              ...('remoteAddress' in nativePair ? { address: nativePair.remoteAddress } : {}),
            } as RTCIceCandidate,
          };
        };
      }
      await listenerWith(locality, native);
      await vi.advanceTimersByTimeAsync(25);
      expect(directLines()[0]).toMatch(
        /^\[ProSysAudioDirect\] Receiver pair check non-local after \d+ ms by /,
      );
      expect(directLines()[0]).toContain(line);
      expect(directLines()[1]).toMatch(
        /^\[ProSysAudioDirect\] Receiver LAN pair not proven \(non-local after \d+ ms\)$/,
      );
      expect(closeReasons()).toEqual(['fallback']);
    });

    it.each([
      [LISTENER_LOCAL_MDNS, 'mdns'],
      ['10.0.0.5', 'private-ipv4'],
      ['172.16.0.5', 'private-ipv4'],
      ['192.168.1.10', 'private-ipv4'],
      ['fd00::5', 'private-ipv6'],
      ['fe80::1%en0', 'link-local'],
      ['169.254.10.20', 'link-local'],
      ['8.8.8.8', 'public'],
      ['100.64.0.1', 'public'],
      ['2001:db8::1', 'public'],
      ['printer.local', 'other'],
      ['example.com', 'other'],
      ['', 'none'],
      ['redacted-ip.invalid', 'none'],
      ['0.0.0.0', 'none'],
      ['::', 'none'],
    ])('names the local address %j only by its kind, %s', async (address, kind) => {
      customNativePair = () => ({
        local: { type: 'host', address, port: 5000, protocol: 'udp' } as RTCIceCandidate,
        remote: {
          type: 'srflx',
          address: '123e4567-e89b-42d3-a456-426614174000.local',
          port: 5000,
          protocol: 'udp',
        } as RTCIceCandidate,
      });
      await listenerWith('host-host', 'custom');
      await vi.advanceTimersByTimeAsync(25);
      const line = pairCheckLines()[0] ?? '';
      expect(line).toContain(
        `by native-type (connected at 0 ms; native host/${kind} to srflx/mdns;`,
      );
      if (address) expect(line).not.toContain(address);
      expect(line).not.toContain(':');
    });
  });

  describe('the publisher', () => {
    it('proves a native host-to-prflx pair refined to the receiver it added, then attaches the track', async () => {
      vi.useFakeTimers();
      vi.mocked(log.info).mockClear();
      const callbacks = configureCallbacks();
      nextLocalities.push('refined');
      nextAuthoritativePairModes.push('prflx');
      const attempt = direct.attemptProSystemAudioDirectPublication({
        track: audioTrack('capture-stereo'),
        generation: 11,
        publicationId,
        targets: [target(receiverA)],
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(attempt).resolves.toEqual({
        publicationId,
        transport: 'lan-direct',
        protocolVersion: 2,
      });
      expect(peerConnections[0]!.sendingTrack()?.id).toBe('capture-stereo');
      expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
      expect(directLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Publisher pair check to 0001 proven after \d+ ms by refined-host \(connected at 0 ms; native host\/mdns to prflx\/none; stats host\/none to host\/none; candidates sent 1, refused 0, received 1, added 1, first at -?\d+ ms\)$/,
        ),
        expect.stringMatching(/^\[ProSysAudioDirect\] LAN route to 0001 proven in \d+ ms /),
      ]);
    });

    it('attaches no audio and falls back at the pair deadline when its host-to-prflx pair never refines', async () => {
      vi.useFakeTimers();
      vi.mocked(log.info).mockClear();
      configureCallbacks();
      nextLocalities.push('prflx-unrefined');
      nextAuthoritativePairModes.push('prflx');
      const attempt = direct.attemptProSystemAudioDirectPublication({
        track: audioTrack('capture-stereo'),
        generation: 11,
        publicationId,
        targets: [target(receiverA)],
      });
      await vi.advanceTimersByTimeAsync(900);
      expect(peerConnections[0]!.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      await expect(attempt).resolves.toBeNull();
      expect(peerConnections[0]!.sendingTrack()).toBeNull();
      expect(directLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Publisher pair check to 0001 deadline after 10\d\d ms by prflx-unrefined \(connected at 0 ms; native host\/mdns to prflx\/none; stats host\/none to prflx\/none; candidates sent 1, refused 0, received 1, added 1, first at -?\d+ ms\)$/,
        ),
        expect.stringMatching(
          /^\[ProSysAudioDirect\] LAN route to 0001 not proven at pair after \d+ ms \(deadline; answer \d+\)$/,
        ),
      ]);
    });

    it('keeps a live route whose native pair stays host-to-prflx while its stats stay refined, and promotes it once they are not', async () => {
      vi.useFakeTimers();
      const callbacks = configureCallbacks();
      nextLocalities.push('refined');
      nextAuthoritativePairModes.push('prflx');
      const attempt = direct.attemptProSystemAudioDirectPublication({
        track: audioTrack('capture-stereo'),
        generation: 11,
        publicationId,
        targets: [target(receiverA)],
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(attempt).resolves.not.toBeNull();
      await expect(
        direct.activateProSystemAudioDirectPublication({
          ownerParticipantId: publisherId,
          generation: 11,
          publicationId,
        }),
      ).resolves.toBe(true);
      const pc = peerConnections[0]!;
      vi.mocked(log.info).mockClear();

      // A connection change and two periodic reproofs keep the refined route.
      pc.emitConnected();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
      expect(pc.close).not.toHaveBeenCalled();
      expect(pairCheckLines()).toEqual([]);

      pc.locality = 'prflx-unrefined';
      await vi.advanceTimersByTimeAsync(5_000);
      expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);
      expect(callbacks.onLiveRouteFallback).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'publisher', reason: 'periodic-locality-check-failed' }),
      );
      expect(pairCheckLines()).toEqual([
        '[ProSysAudioDirect] Publisher pair reproof to 0001 pending by prflx-unrefined (native host/mdns to prflx/none; stats host/none to prflx/none; candidates sent 1, refused 0, received 1, added 1)',
      ]);
    });

    // libwebrtc marks the selected connection in-progress for one round trip
    // around each consent check (about every 2.5 s); a reproof that meets it
    // must not promote a refined route to the SFU mid-share.
    it('keeps a live refined route through activation and live reproofs that meet a consent check in flight', async () => {
      vi.useFakeTimers();
      const callbacks = configureCallbacks();
      nextLocalities.push('refined');
      nextAuthoritativePairModes.push('prflx');
      const attempt = direct.attemptProSystemAudioDirectPublication({
        track: audioTrack('capture-stereo'),
        generation: 11,
        publicationId,
        targets: [target(receiverA)],
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(attempt).resolves.not.toBeNull();
      const pc = peerConnections[0]!;
      pc.locality = 'refined-in-progress';
      vi.mocked(log.info).mockClear();
      await expect(
        direct.activateProSystemAudioDirectPublication({
          ownerParticipantId: publisherId,
          generation: 11,
          publicationId,
        }),
      ).resolves.toBe(true);

      pc.emitConnected();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(callbacks.onLiveRouteFallback).not.toHaveBeenCalled();
      expect(pc.close).not.toHaveBeenCalled();
      expect(pairCheckLines()).toEqual([]);

      // A selected pair that never had a response is still no proof.
      pc.locality = 'refined-in-progress-unanswered';
      await vi.advanceTimersByTimeAsync(5_000);
      expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);
      expect(pairCheckLines()).toEqual([
        expect.stringMatching(
          /^\[ProSysAudioDirect\] Publisher pair reproof to 0001 pending by prflx-unrefined /,
        ),
      ]);
    });
  });

  it('keeps addresses, ports, foundations, fragments, room codes and full ids out of every pair line', async () => {
    const receiver = await listenerWith('refined', 'prflx');
    receiver.emitLocalCandidate('candidate:2 1 udp 2122260223 192.168.1.10 54322 typ host');
    await vi.advanceTimersByTimeAsync(25);
    const receiverLines = pairCheckLines();
    expect(receiverLines).toHaveLength(1);

    direct.resetProSystemAudioDirectTransport({ notifyPeers: false });
    peerConnections.length = 0;
    vi.mocked(log.info).mockClear();
    localParticipantId = publisherId;
    const callbacks = configureCallbacks();
    nextLocalities.push('refined');
    nextAuthoritativePairModes.push('prflx');
    const attempt = direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 11,
      publicationId,
      targets: [target(receiverA)],
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(attempt).resolves.not.toBeNull();
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 11,
      publicationId,
    });
    peerConnections[0]!.locality = 'prflx-unrefined';
    await vi.advanceTimersByTimeAsync(5_001);
    expect(callbacks.onLiveRouteFallback).toHaveBeenCalledTimes(1);
    const lines = [...receiverLines, ...pairCheckLines()];
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      for (const secret of [
        String(LISTENER_LOCAL_PORT),
        '54322',
        '5000',
        '.local',
        '.invalid',
        'redacted',
        LOCAL_UFRAG,
        REMOTE_UFRAG,
        LISTENER_LOCAL_FOUNDATION,
        PRFLX_FOUNDATION,
        'auto',
        publisherId,
        receiverA,
        '000001',
        publicationId,
        NEGOTIATION_ID,
      ]) {
        expect(line).not.toContain(secret);
      }
      // No IPv4 literal, and no colon at all, so no IPv6 literal either.
      expect(line).not.toMatch(/\d{1,3}(?:\.\d{1,3}){3}/);
      expect(line).not.toContain(':');
    }
  });

  // The statistics view of a line names numeric addresses by kind only, under
  // any of the keys browsers use ('address', 'ip', 'ipAddress'), whatever the
  // outcome.
  it.each([
    {
      locality: 'global-ipv6' as const,
      native: null,
      outcome: 'non-local',
      view: 'stats host/public to host/public',
      literals: ['2001:db8:1::10', '2001:db8:1::20'],
    },
    {
      locality: 'non-local' as const,
      native: null,
      outcome: 'non-local',
      view: 'stats host/private-ipv4 to relay/private-ipv4',
      literals: ['192.168.1.10', '192.168.1.20'],
    },
    {
      locality: 'empty-address-global-ip' as const,
      native: null,
      outcome: 'non-local',
      view: 'stats host/public to host/mdns',
      literals: ['2001:db8:1::10'],
    },
    {
      locality: 'ledger-mismatch' as const,
      native: null,
      outcome: 'deadline',
      view: 'stats host/private-ipv4 to host/mdns',
      literals: ['192.168.1.10'],
    },
    {
      locality: 'refined-global-ip' as const,
      native: 'prflx' as const,
      outcome: 'non-local',
      view: 'stats host/public to host/none',
      literals: ['2001:db8:1::10'],
    },
    {
      locality: 'refined-ipaddress' as const,
      native: 'prflx' as const,
      outcome: 'proven',
      view: 'stats host/private-ipv4 to host/none',
      literals: ['192.168.1.10'],
    },
  ])(
    'names $locality statistics addresses by kind only in a $outcome line',
    async ({ locality, native, outcome, view, literals }) => {
      await listenerWith(locality, native);
      await vi.advanceTimersByTimeAsync(2_100);
      const line = pairCheckLines()[0] ?? '';
      expect(line.startsWith(`[ProSysAudioDirect] Receiver pair check ${outcome} `)).toBe(true);
      expect(line).toContain(view);
      for (const literal of [...literals, '5000', '.local']) expect(line).not.toContain(literal);
      expect(line).not.toMatch(/\d{1,3}(?:\.\d{1,3}){3}/);
      expect(line).not.toContain(':');
    },
  );
});

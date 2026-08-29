/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as direct from '../pro-system-audio-direct.ts';

type DirectTransportCallbacks = Parameters<typeof direct.configureProSystemAudioDirectTransport>[0];

const bridgeMocks = vi.hoisted(() => ({
  listeners: [] as Array<(frame: unknown) => void>,
  sent: [] as Array<{ channel: string; payload: Record<string, unknown> }>,
  send: vi.fn<(channel: string, payload: Record<string, unknown>) => boolean>(),
  on: vi.fn<(listener: (frame: unknown) => void) => () => void>(),
}));

vi.mock('../../pro-room/network-bridge.ts', () => ({
  sendProRoomRealtime: bridgeMocks.send,
  onProRoomRealtimeEvent: bridgeMocks.on,
}));

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
  | 'multiple-selected';

type AuthoritativePairMode = 'lan' | 'relay' | 'srflx' | 'incomplete' | 'throw';

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
  readonly statsGate: Promise<void> | null;
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
  close = vi.fn(() => {
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
  });
  addIceCandidate = vi.fn(async () => {});
  readonly probeChannel = { close: vi.fn() };
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
      getParameters: () => ({ encodings: [{}] }) as RTCRtpSendParameters,
      setParameters: vi.fn(async () => {}),
    } as unknown as RTCRtpSender;
    this.senders.push(sender);
    return sender;
  });

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
    if (description.type === 'answer') this.emitConnected();
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
    if (description.type === 'answer') this.emitConnected();
  }

  async getStats(): Promise<RTCStatsReport> {
    this.statsCallCount += 1;
    if (this.statsGate) await this.statsGate;
    if (this.locality === 'pending') return new Map() as unknown as RTCStatsReport;
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
    Omit<DirectTransportCallbacks, 'onReceiverTrackReady' | 'onLiveRouteFallback'>
  > = {},
) {
  const onReceiverTrackReady = vi.fn<(event: direct.ProSystemAudioDirectTrackReadyEvent) => void>();
  const onLiveRouteFallback = vi.fn<(event: direct.ProSystemAudioDirectFallbackEvent) => void>();
  const callbacks = {
    getLocalIdentity: () => ({ participantId: localParticipantId }),
    authorizeInboundOffer: () => true,
    authorizeInboundSignal: () => true,
    ...overrides,
    onReceiverTrackReady,
    onLiveRouteFallback,
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
    }
    for (const targetParticipantId of [receiverA, receiverB]) {
      expect(
        bridgeMocks.sent
          .filter((entry) => entry.payload.targetParticipantId === targetParticipantId)
          .map((entry) => entry.payload.kind),
      ).toEqual(['offer', 'candidate', 'offer']);
      expect(
        bridgeMocks.sent
          .filter(
            (entry) =>
              entry.payload.targetParticipantId === targetParticipantId &&
              entry.payload.kind === 'offer',
          )
          .map((entry) => entry.payload.phase),
      ).toEqual(['probe', 'media']);
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
    expect(peerConnections[1]?.addTrack).not.toHaveBeenCalled();
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
      expect(peerConnections[0]?.addTrack).not.toHaveBeenCalled();
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
  ])('rejects %s selected host pairs before adding the media track', async (locality) => {
    configureCallbacks();
    nextLocalities.push(locality);

    const descriptor = await direct.attemptProSystemAudioDirectPublication({
      track: audioTrack('capture-stereo'),
      generation: 8,
      publicationId,
      targets: [target(receiverA)],
      timeoutMs: 80,
    });

    expect(descriptor).toBeNull();
    expect(peerConnections[0]?.addTrack).not.toHaveBeenCalled();
    expect(
      bridgeMocks.sent.some(
        (entry) => entry.payload.kind === 'offer' && entry.payload.phase === 'media',
      ),
    ).toBe(false);
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
    expect(peerConnections[0]?.addTrack).not.toHaveBeenCalled();
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
    expect(peerConnections[0]?.addTrack).not.toHaveBeenCalled();
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

    const offer = (index: number) => ({
      kind: 'offer',
      targetParticipantId: receiverA,
      direction: 'publisher',
      phase: 'probe',
      generation: 11,
      publicationId,
      negotiationId: `negotiation_${String(index).padStart(18, '0')}`,
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      },
    });

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
    const validOffer = {
      kind: 'offer',
      targetParticipantId: receiverA,
      direction: 'publisher',
      phase: 'probe',
      generation: 11,
      publicationId,
      negotiationId: 'negotiation_000000000001',
      description: { type: 'offer', sdp: 'valid-owner-probe-offer' },
    };

    emitRelay(attackerId, validOffer);
    expect(peerConnections).toHaveLength(0);
    emitRelay(publisherId, validOffer);
    await vi.waitFor(() =>
      expect(bridgeMocks.sent.some((entry) => entry.payload.kind === 'answer')).toBe(true),
    );
    expect(peerConnections).toHaveLength(1);
    expect(callbacks.onReceiverTrackReady).not.toHaveBeenCalled();

    emitRelay(publisherId, {
      kind: 'candidate',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 11,
      publicationId,
      negotiationId: validOffer.negotiationId,
      candidate: { candidate: safeCandidate('auto') },
    });
    await vi.waitFor(() => expect(peerConnections[0]?.addIceCandidate).toHaveBeenCalledTimes(1));

    emitRelay(publisherId, {
      ...validOffer,
      phase: 'media',
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2',
      },
      trackIds: { L: 'remote-left-track', R: 'remote-right-track' },
    });
    await Promise.resolve();
    expect(
      bridgeMocks.sent.filter(
        (entry) => entry.payload.kind === 'answer' && entry.payload.phase === 'media',
      ),
    ).toHaveLength(0);

    emitRelay(publisherId, {
      ...validOffer,
      phase: 'media',
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2',
      },
      trackId: receiverTrackId,
    });
    await vi.waitFor(() =>
      expect(
        bridgeMocks.sent.filter(
          (entry) => entry.payload.kind === 'answer' && entry.payload.phase === 'media',
        ),
      ).toHaveLength(1),
    );
    expect(peerConnections[0]?.remoteDescription?.sdp).toContain('stereo=1');
    expect(peerConnections[0]?.remoteDescription?.sdp).toContain('sprop-stereo=1');
    const mediaAnswer = bridgeMocks.sent.find(
      (entry) => entry.payload.kind === 'answer' && entry.payload.phase === 'media',
    );
    const mediaAnswerSdp = (mediaAnswer?.payload.description as RTCSessionDescriptionInit).sdp;
    expect(mediaAnswerSdp).toContain('stereo=1');
    expect(mediaAnswerSdp).toContain('sprop-stereo=1');
    expect(mediaAnswerSdp).toContain('maxaveragebitrate=256000');

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

    const replacementOffer = {
      ...validOffer,
      negotiationId: 'negotiation_000000000002',
      description: { type: 'offer', sdp: 'replacement-owner-probe-offer' },
    };
    emitRelay(publisherId, replacementOffer);
    await vi.waitFor(() => expect(peerConnections).toHaveLength(2));
    expect(deliveredEvent?.isCurrent()).toBe(false);
    emitRelay(publisherId, validOffer);
    await Promise.resolve();
    expect(peerConnections).toHaveLength(2);
  });

  it('buffers a bounded candidate that arrives before its probe offer and drains it afterward', async () => {
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
    emitRelay(publisherId, {
      kind: 'offer',
      targetParticipantId: receiverA,
      direction: 'publisher',
      phase: 'probe',
      generation: 11,
      publicationId,
      negotiationId,
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      },
    });

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
    emitRelay(publisherId, {
      kind: 'offer',
      targetParticipantId: receiverA,
      direction: 'publisher',
      phase: 'probe',
      generation: 11,
      publicationId,
      negotiationId,
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      },
    });

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
    emitRelay(publisherId, {
      kind: 'offer',
      targetParticipantId: receiverA,
      direction: 'publisher',
      phase: 'probe',
      generation: 11,
      publicationId,
      negotiationId,
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      },
    });
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
    emitRelay(publisherId, {
      kind: 'offer',
      targetParticipantId: receiverA,
      direction: 'publisher',
      phase: 'probe',
      generation: 11,
      publicationId,
      negotiationId,
      description: {
        type: 'offer',
        sdp:
          'v=0\r\n' +
          'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' +
          'c=IN IP6 2001:db8::20\r\n' +
          'a=remote-candidates:1 2001:db8::20 5000\r\n' +
          'a=candidate:bad 1 udp 1 2001:db8::20 5000 typ host\r\n' +
          'a=candidate:safe 1 udp 1 192.168.1.20 5000 typ host\r\n' +
          'a=end-of-candidates\r\n',
      },
    });
    await vi.waitFor(() => expect(peerConnections).toHaveLength(1));
    expect(peerConnections[0]?.remoteDescription?.sdp).toBe(
      'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP6 ::\r\n',
    );
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
    emitRelay(publisherId, {
      kind: 'offer',
      targetParticipantId: receiverA,
      direction: 'publisher',
      phase: 'probe',
      generation: 11,
      publicationId,
      negotiationId,
      description: { type: 'offer', sdp: 'valid-owner-probe-offer' },
    });
    await vi.waitFor(() =>
      expect(
        bridgeMocks.sent.some(
          (entry) => entry.payload.kind === 'answer' && entry.payload.phase === 'probe',
        ),
      ).toBe(true),
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

  it('requests fallback when an activated media route never receives its mapped track', async () => {
    localParticipantId = receiverA;
    const callbacks = configureCallbacks();
    const negotiationId = 'negotiation_000000000013';
    const probeOffer = {
      kind: 'offer',
      targetParticipantId: receiverA,
      direction: 'publisher',
      phase: 'probe',
      generation: 11,
      publicationId,
      negotiationId,
      description: { type: 'offer', sdp: 'valid-owner-probe-offer' },
    };
    emitRelay(publisherId, probeOffer);
    await vi.waitFor(() =>
      expect(
        bridgeMocks.sent.some(
          (entry) => entry.payload.kind === 'answer' && entry.payload.phase === 'probe',
        ),
      ).toBe(true),
    );
    await direct.activateProSystemAudioDirectPublication({
      ownerParticipantId: publisherId,
      generation: 11,
      publicationId,
    });

    emitRelay(publisherId, {
      kind: 'candidate',
      targetParticipantId: receiverA,
      direction: 'publisher',
      generation: 11,
      publicationId,
      negotiationId,
      candidate: { candidate: safeCandidate('auto') },
    });
    await vi.waitFor(() => expect(peerConnections[0]?.addIceCandidate).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();

    emitRelay(publisherId, {
      ...probeOffer,
      phase: 'media',
      description: {
        type: 'offer',
        sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2',
      },
      trackId: 'remote-stereo-track',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      bridgeMocks.sent.some(
        (entry) => entry.payload.kind === 'answer' && entry.payload.phase === 'media',
      ),
    ).toBe(true);
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
});

describe('PRO system-audio LAN-direct live lifecycle', () => {
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
        .filter((entry) => entry.payload.kind === 'offer' && entry.payload.phase === 'probe')
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
    expect(peerConnections[0]?.addTrack).not.toHaveBeenCalled();
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
          entry.payload.phase === 'probe' &&
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
    expect(peerConnections[0]?.addTrack).not.toHaveBeenCalled();
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

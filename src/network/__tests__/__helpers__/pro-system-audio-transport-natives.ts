/**
 * Native seams for driving the real PRO system-audio transports
 * (network/pro-system-audio-sfu.ts and network/pro-system-audio-direct.ts)
 * under the receive-slot contract in
 * src/pro-room/__tests__/system-audio-receive-slot-pro-transport-contract.test.ts.
 *
 * Everything else the slot touches (Web Audio, media teardown, the Cloudflare
 * Realtime API behind fetchWithCapability, MediaStream, observations) comes
 * from system-audio-receive-harness.ts. Each section says what the fake models,
 * what it is calibrated against, and what it leaves out.
 */
import { makeAudioTrack } from './system-audio-receive-harness.ts';

// ─── RTCPeerConnection (PRO SFU subscriber and LAN-direct receiver) ──
// One class serves both transports, chosen the way they configure it: the SFU
// subscriber passes Cloudflare's STUN entry, the LAN-direct receiver passes no
// ICE servers at all (host candidates only).
//
// SFU mode, calibrated against pro-system-audio-sfu.ts performSubscribe: after
// setRemoteDescription(offer) one recvonly transceiver (mid '0') exposes its
// remote audio track, which the subscriber reads from getTransceivers();
// createAnswer and setLocalDescription succeed; runtime connection states are
// pushed with setConnectionState() to the 'connectionstatechange' listeners.
//
// LAN mode, calibrated against pro-system-audio-direct.ts acceptOffer and
// proveReceiverRoute and the 'host-host' locality in pro-system-audio-direct
// .test.ts: setLocalDescription(answer) gathers one mDNS host candidate and
// connects; getStats() reports one selected, succeeded host-to-host pair from
// 192.168.1.10 to an mDNS remote whose foundation and port match LAN_CANDIDATE,
// so the receiver proves its pair on the first proof poll (every 25 ms) after
// that candidate arrives; the offer fires ontrack with the track its `a=msid:`
// line names (none when the line is missing); setLocalDescription(answer) also
// opens the publisher's probe channel (ondatachannel), whose sent messages are
// kept and on which `sendLanTrackAttached` delivers the publisher's
// track-attached word. Runtime states go to onconnectionstatechange and
// oniceconnectionstatechange, as the receiver registers them.
//
// Neither mode models ICE, DTLS, media flow, track 'ended' events or the
// publisher side (addTrack, replaceTrack, sctp).

type PeerConnectionMode = 'sfu' | 'lan';

interface FakeReceiver {
  track: MediaStreamTrack;
  playoutDelayHint?: number;
}

interface FakeProbeChannel {
  label: string;
  readyState: 'open';
  /** Messages this receiver sent its publisher, in order. */
  sent: unknown[];
  send: (data: unknown) => void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** The publisher's one LAN host candidate: foundation 'auto', port 5000. */
export const LAN_CANDIDATE =
  'candidate:auto 1 udp 1 123e4567-e89b-42d3-a456-426614174000.local 5000 typ host';
const LAN_LOCAL_CANDIDATE =
  'candidate:local 1 udp 1 123e4567-e89b-42d3-a456-426614174010.local 5000 typ host';

export class ProTransportPeerConnection {
  static readonly instances: ProTransportPeerConnection[] = [];
  readonly mode: PeerConnectionMode;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  ondatachannel: ((event: { channel: FakeProbeChannel }) => void) | null = null;
  /** The publisher's probe channel as this receiver sees it (LAN mode, once answered). */
  readonly probeChannel: FakeProbeChannel = {
    label: 'MUSIXQUARE-lan-probe',
    readyState: 'open',
    sent: [],
    send(data: unknown) {
      this.sent.push(data);
    },
    onopen: null,
    onmessage: null,
  };
  closed = false;
  /** Every remote audio receiver this connection exposed, in order. */
  readonly receivers: FakeReceiver[] = [];
  readonly remoteCandidates: RTCIceCandidateInit[] = [];
  private transceivers: Array<{ mid: string; receiver: FakeReceiver }> = [];
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly ordinal: number;

  constructor(readonly configuration: RTCConfiguration = {}) {
    this.mode = (configuration.iceServers ?? []).length === 0 ? 'lan' : 'sfu';
    ProTransportPeerConnection.instances.push(this);
    this.ordinal = ProTransportPeerConnection.of(this.mode).length;
  }

  static of(mode: PeerConnectionMode): ProTransportPeerConnection[] {
    return ProTransportPeerConnection.instances.filter((pc) => pc.mode === mode);
  }

  static reset(): void {
    ProTransportPeerConnection.instances.length = 0;
  }

  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  getTransceivers() {
    return this.transceivers;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    if (description.type !== 'offer') return;
    if (this.mode === 'sfu') {
      const receiver = { track: makeAudioTrack(`sfu-audio-${this.ordinal}`) };
      this.receivers.push(receiver);
      this.transceivers = [{ mid: '0', receiver }];
      return;
    }
    const sdp = description.sdp ?? '';
    const trackId = /^a=msid:\S+ (\S+)$/m.exec(sdp)?.[1];
    if (!/^m=audio /m.test(sdp) || !trackId) return;
    const receiver = { track: makeAudioTrack(trackId) };
    this.receivers.push(receiver);
    this.ontrack?.({
      track: receiver.track,
      receiver,
      transceiver: { mid: '0', receiver },
      streams: [],
    });
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.mode === 'sfu') return { type: 'answer', sdp: 'v=0\r\n' };
    const media = /^m=audio /m.test(this.remoteDescription?.sdp ?? '')
      ? 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2'
      : 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel';
    return { type: 'answer', sdp: `v=0\r\n${media}\r\n` };
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description ?? null;
    if (this.mode !== 'lan' || description?.type !== 'answer') return;
    this.onicecandidate?.({
      candidate: {
        candidate: LAN_LOCAL_CANDIDATE,
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'local-fragment',
        toJSON: () => ({
          candidate: LAN_LOCAL_CANDIDATE,
          sdpMid: '0',
          sdpMLineIndex: 0,
          usernameFragment: 'local-fragment',
        }),
      },
    });
    if (this.connectionState !== 'connected') this.setConnectionState('connected');
    this.ondatachannel?.({ channel: this.probeChannel });
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.remoteCandidates.push(candidate);
  }

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    if (this.mode !== 'lan') return new Map();
    return new Map<string, Record<string, unknown>>([
      ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
      [
        'pair',
        {
          id: 'pair',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          localCandidateId: 'local',
          remoteCandidateId: 'remote',
        },
      ],
      [
        'local',
        { id: 'local', type: 'local-candidate', candidateType: 'host', address: '192.168.1.10' },
      ],
      [
        'remote',
        {
          id: 'remote',
          type: 'remote-candidate',
          candidateType: 'host',
          foundation: 'auto',
          port: 5000,
          protocol: 'udp',
          address: '123e4567-e89b-42d3-a456-426614174000.local',
        },
      ],
    ]);
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
  }

  /** A runtime ICE/DTLS state change, reported to every registration style. */
  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.iceConnectionState =
      state === 'connecting' ? 'checking' : (state as RTCIceConnectionState);
    for (const fn of this.listeners.get('connectionstatechange') ?? []) fn();
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }
}

// ─── PRO realtime relay (pro-room/network-bridge.ts) ────────────────
// Replaces onProRoomRealtimeEvent, the PRO room socket's inbound relay, with
// an emitter; outbound signals are captured by `send`, which the test binds
// through the real pro-room/realtime-sender.ts port. A delivered frame has the
// envelope shape network-bridge.ts accepts; the server's sender fencing and
// targeting are not modelled.

type RelayListener = (frame: unknown) => void;

class ProRelayFake {
  private readonly listeners = new Set<RelayListener>();
  private eventSeq = 0;
  /** Signals this device sent on 'system-audio-signal', in order. */
  readonly sent: Array<Record<string, unknown>> = [];

  readonly module = {
    onProRoomRealtimeEvent: (listener: RelayListener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };

  readonly send = (channel: string, payload: Record<string, unknown>): boolean => {
    if (channel === 'system-audio-signal') this.sent.push({ ...payload });
    return true;
  };

  deliver(roomCode: string, senderParticipantId: string, payload: Record<string, unknown>): void {
    const frame = {
      type: 'pro-realtime',
      version: 1,
      roomCode,
      coordinatorEpoch: 1,
      eventId: `event_${String(++this.eventSeq).padStart(12, '0')}`,
      channel: 'system-audio-signal',
      payload,
      sender: {
        participantId: senderParticipantId,
        presenceIncarnationId: `presence_${senderParticipantId}`,
      },
    };
    for (const listener of [...this.listeners]) listener(frame);
  }

  /** Sent signals of one kind ('answer', 'candidate', 'close'), with their phase or reason. */
  signals(kind: string): Array<Record<string, unknown>> {
    return this.sent.filter((signal) => signal.kind === kind);
  }

  reset(): void {
    this.sent.length = 0;
  }
}

export const proRelay = new ProRelayFake();

// ─── LAN-direct publisher signals ───────────────────────────────────
// The frames a remote LAN-direct publisher sends one listener, in the shapes
// pro-system-audio-direct.ts parseSignal accepts: one offer carrying the probe
// data channel and the audio m-section that names its stereo track, then one
// LAN host candidate.

export interface LanPublisherRoute {
  roomCode: string;
  ownerParticipantId: string;
  targetParticipantId: string;
  generation: number;
  publicationId: string;
  negotiationId: string;
}

function lanSignal(route: LanPublisherRoute, kind: string): Record<string, unknown> {
  return {
    kind,
    targetParticipantId: route.targetParticipantId,
    direction: 'publisher',
    generation: route.generation,
    publicationId: route.publicationId,
    negotiationId: route.negotiationId,
  };
}

/** The one offer; `withTrack: false` leaves out the msid, so no track arrives. */
export function sendLanOffer(
  route: LanPublisherRoute,
  trackId: string,
  options: { withTrack?: boolean } = {},
): void {
  const msid = options.withTrack === false ? '' : `a=msid:publisher-stream ${trackId}\r\n`;
  proRelay.deliver(route.roomCode, route.ownerParticipantId, {
    ...lanSignal(route, 'offer'),
    phase: 'media',
    trackId,
    description: {
      type: 'offer',
      sdp:
        'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' +
        `m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n${msid}`,
    },
  });
}

/**
 * The publisher's word, on the newest LAN connection's probe channel, that the
 * track now carries audio (it sends it after both ends proved the pair).
 */
export function sendLanTrackAttached(): void {
  const connection = ProTransportPeerConnection.of('lan').at(-1);
  connection?.probeChannel.onmessage?.({ data: 'publisher-track-attached' });
}

export function sendLanCandidate(route: LanPublisherRoute): void {
  proRelay.deliver(route.roomCode, route.ownerParticipantId, {
    ...lanSignal(route, 'candidate'),
    candidate: { candidate: LAN_CANDIDATE },
  });
}

export function sendLanClose(
  route: LanPublisherRoute,
  reason: 'stopped' | 'fallback' | 'superseded',
): void {
  proRelay.deliver(route.roomCode, route.ownerParticipantId, {
    ...lanSignal(route, 'close'),
    reason,
  });
}

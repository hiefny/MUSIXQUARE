/**
 * Native seams for driving the real system-audio SFU publishers
 * (network/system-audio-sfu.ts on the Standard host and
 * network/pro-system-audio-sfu.ts in PRO rooms) in the publisher evidence
 * suites:
 * - src/network/__tests__/system-audio-standard-publish-evidence.test.ts
 * - src/pro-room/__tests__/system-audio-pro-publish-evidence.test.ts
 *
 * Only platform and Cloudflare boundaries live here. Each section says what the
 * fake models, what it is calibrated against, and what it leaves out.
 */
import { vi } from 'vitest';

// ─── Captured track ─────────────────────────────────────────────────
// The original capture track a sharer publishes. Every applyConstraints call
// is recorded, so the music-capture constraints each publisher asks for are
// observable, and a test can make later calls reject or throw, as browsers
// that refuse sender-track constraints do. applyConstraints is a plain
// function on purpose: a vi.fn observes the promise it returns, which would
// hide a publisher's missing .catch (an unhandled rejection) from Vitest. Does
// not model ended tracks or media flow.

export interface CaptureTrack extends MediaStreamTrack {
  /** The argument of every applyConstraints call, in order. */
  readonly constraintRequests: unknown[];
  /** Later applyConstraints calls reject (OverconstrainedError) or throw synchronously. */
  refuseConstraints(how: 'reject' | 'throw'): void;
}

export function makeCaptureTrack(id = 'capture-stereo-track'): CaptureTrack {
  const constraintRequests: unknown[] = [];
  let refusal: 'reject' | 'throw' | null = null;
  return {
    id,
    kind: 'audio',
    readyState: 'live',
    muted: false,
    constraintRequests,
    refuseConstraints: (how: 'reject' | 'throw') => {
      refusal = how;
    },
    applyConstraints: (constraints?: unknown): Promise<void> => {
      constraintRequests.push(constraints);
      if (refusal === 'throw') throw new TypeError('applyConstraints is not supported');
      if (refusal === 'reject') {
        return Promise.reject(
          new DOMException('Cannot satisfy constraints', 'OverconstrainedError'),
        );
      }
      return Promise.resolve();
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as CaptureTrack;
}

// ─── RTCRtpSender ───────────────────────────────────────────────────
// Models the sender parameters as Chromium returns them for a fresh audio
// sender (one encoding, no bitrate set). getParameters returns a fresh copy on
// every call, as browsers do, so only a setParameters call can change what the
// sender carries. A test can make getParameters throw. replaceTrack records
// every track it is given, in order (`replaceTrack.mock.calls`), and the
// sender then carries that track, or none for null, as browsers do before and
// after negotiation without renegotiating.

export class FakeSender {
  private parameters: RTCRtpSendParameters = { encodings: [{}] } as RTCRtpSendParameters;
  track: MediaStreamTrack | null;
  readonly getParameters = vi.fn<() => RTCRtpSendParameters>(() =>
    structuredClone(this.parameters),
  );
  readonly setParameters = vi.fn<(parameters: RTCRtpSendParameters) => Promise<void>>(
    async (parameters) => {
      this.parameters = structuredClone(parameters);
    },
  );
  readonly replaceTrack = vi.fn<(track: MediaStreamTrack | null) => Promise<void>>(
    async (track) => {
      this.track = track;
    },
  );
  constructor(track: MediaStreamTrack) {
    this.track = track;
  }
  /** What the sender carries after every setParameters call so far. */
  get applied(): RTCRtpSendParameters {
    return structuredClone(this.parameters);
  }
}

// ─── RTCPeerConnection (SFU publisher) ──────────────────────────────
// Calibrated against both publishers' publish paths: addTransceiver(track,
// sendonly) returns a transceiver with mid '0' and a FakeSender; createOffer
// returns an Opus offer without stereo parameters (the publishers munge their
// own offer); setLocalDescription and setRemoteDescription succeed;
// connectionstatechange listeners can be driven with setConnectionState().
// `onSender` lets a test reach each new sender before the publisher tunes it.
// Does not model ICE, DTLS, media flow or receivers.

const OPUS_OFFER_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  '',
].join('\r\n');

/** Cloudflare's answer to a stereo publisher offer: Opus with stereo=1. */
export const OPUS_STEREO_ANSWER_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10; stereo=1; sprop-stereo=1',
  '',
].join('\r\n');

export class PublisherPeerConnection {
  static readonly instances: PublisherPeerConnection[] = [];
  static onSender: ((sender: FakeSender) => void) | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  closed = false;
  readonly senders: FakeSender[] = [];
  private readonly transceivers: Array<{
    mid: string;
    sender: FakeSender;
    receiver: { track: null };
  }> = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(readonly configuration: RTCConfiguration = {}) {
    PublisherPeerConnection.instances.push(this);
  }

  static reset(): void {
    PublisherPeerConnection.instances.length = 0;
    PublisherPeerConnection.onSender = null;
  }

  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  addTransceiver(track: MediaStreamTrack) {
    const sender = new FakeSender(track);
    PublisherPeerConnection.onSender?.(sender);
    const transceiver = {
      mid: String(this.transceivers.length),
      sender,
      receiver: { track: null },
    };
    this.senders.push(sender);
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers() {
    return this.transceivers;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: OPUS_OFFER_SDP };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(): Promise<void> {}

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    for (const fn of this.listeners.get('connectionstatechange') ?? []) fn();
  }
}

// ─── Cloudflare Realtime and TURN (publisher side) ──────────────────
// fetchWithCapability for /api/cloudflare-realtime and /api/get-turn-config,
// calibrated against the response shapes both publishers read: the TURN read
// answers 404 (the publishers fall back to Cloudflare's public STUN entry),
// new-session returns a numbered session id and owner token, a local
// tracks-new returns the stereo answer and one mid per requested track, and
// tracks-close returns {}. Responses resolve on the next macrotask (no
// latency), honour an aborted signal like fetch, and record every request.
// A test can hold the next request of one action (`holdNext`): it is recorded
// at once and answers only when the test lets it go, or rejects with the
// signal's reason when it is aborted first, as an in-flight fetch does.
// Does not model capability minting, Turnstile, the subscriber side, the
// second fallback endpoint or response size limits.

interface RealtimeRequest {
  action: string;
  sessionId?: string;
  payload?: { tracks?: Array<Record<string, unknown>>; force?: boolean };
}

class PublisherRealtimeFake {
  readonly requests: RealtimeRequest[] = [];
  private sessionSeq = 0;
  private held: { action: string; gate: Promise<void>; open: () => void } | null = null;

  readonly fetchWithCapability = (
    url: RequestInfo | URL,
    _capability: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (String(url).includes('get-turn-config')) {
      return Promise.resolve(Response.json({}, { status: 404 }));
    }
    const request = JSON.parse(String(init?.body ?? '{}')) as RealtimeRequest;
    this.requests.push(request);
    const held = this.held?.action === request.action ? this.held : null;
    if (held) this.held = null;
    return new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      const answer = () => setTimeout(() => resolve(Response.json(this.respond(request))), 0);
      if (held) void held.gate.then(answer);
      else answer();
    });
  };

  /** Holds the next request of `action` until the returned function lets it answer. */
  holdNext(action: string): () => void {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.held = { action, gate, open };
    return open;
  }

  count(action: string): number {
    return this.requests.filter((request) => request.action === action).length;
  }

  reset(): void {
    this.requests.length = 0;
    this.sessionSeq = 0;
    this.held = null;
  }

  private respond(request: RealtimeRequest): Record<string, unknown> {
    if (request.action === 'new-session') {
      const id = ++this.sessionSeq;
      return { sessionId: `publisher_session_${id}`, sessionOwnerToken: `publisher_owner_${id}` };
    }
    if (request.action === 'tracks-new') {
      return {
        sessionDescription: { type: 'answer', sdp: OPUS_STEREO_ANSWER_SDP },
        tracks: (request.payload?.tracks ?? []).map((track, index) => ({
          trackName: track.trackName,
          mid: String(index),
        })),
      };
    }
    return {};
  }
}

export const publisherRealtime = new PublisherRealtimeFake();

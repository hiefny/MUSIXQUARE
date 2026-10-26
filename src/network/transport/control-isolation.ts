/**
 * One optional control-only RTC association, owned by an admitted connection.
 * Its signaling travels over that connection's original authenticated channel;
 * it never enters the room membership/signaling negotiation namespace.
 */
import { log } from '../../core/log.ts';

const TYPE = 'mxqr-control-isolation';
const LABEL = 'musixquare-control-isolated'; // brand-capitalization: allow-technical -- private RTC data-channel identifier
const NONCE = /^[a-f0-9]{32}$/u;
const NEGOTIATION_MS = 10_000;
// An active side route survives an ICE interruption by restarting ICE on the
// same PC: DTLS/SCTP and its ordered channel remain, so queued and in-flight
// controls keep their order. How long an outage may last is its outage
// owner's (SideOutageOwner, since Phase 4 C5-9). These two windows bound peer
// restart requests (15 s) and restart offers (30 s). The two ends enforce them
// on each other, and consecutive builds meet in a room while the update dialog
// lets a tab wait, so they are a wire contract: they stay literals rather than
// follow RTC_INTERRUPTION_GRACE_MS (survey TR-15, kept again by the old-version
// removal train). Monotonic time keeps a wall-clock correction from moving them.
const RESTART_WINDOW_MS = 15_000;
const RESTART_CAP_MS = 30_000;
// Per local interruption, and separately per window of peer requests.
const MAX_RESTART_ATTEMPTS = 2;
// Restart offers per 30 s. The offerer stops below it; an answerer offered more
// closes, so an abusive peer cannot keep it renegotiating.
const MAX_RESTART_OFFERS = 16;
const MAX_EPOCH = 0x7fff_ffff;
const MAX_CANDIDATES = 128;
const MAX_QUEUE_MESSAGES = 128;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_UNITS = 16 * 1024 * 1024;
const encoder = new TextEncoder();

type Phase = 'idle' | 'negotiating' | 'fencing' | 'active' | 'fallback' | 'closed';
type Kind =
  | 'hello'
  | 'request'
  | 'decline'
  | 'offer'
  | 'answer'
  | 'candidate'
  | 'fence'
  | 'ready'
  // Restart frames, since 8.11.25. Every end restarts without an advertisement
  // since the old-version removal train (survey OV-B07), and train 2 (survey
  // OV-F03, App build floor 787) stopped sending the 'restart-capable' frame
  // that ends before the first train waited for. A 9.0.14 end still sends one
  // before its request: an unknown kind now, consumed on the original lane
  // without effect.
  | 'restart-request'
  | 'restart-offer'
  | 'restart-answer'
  | 'restart-candidate';
interface Frame {
  type: typeof TYPE;
  version: 1;
  kind: Kind;
  nonce: string;
  target?: string;
  epoch?: number;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export interface IsolatedControlLease {
  readonly pc: RTCPeerConnection;
  release(): void;
  /** Applies the owner's due RTC credential renewal before an ICE restart. */
  prepareRestart?(): Promise<void>;
}

/**
 * Why the side route ended its logical connection: its outage owner's restart
 * window ran out, the route failed or was refused once fenced, a local send
 * threw, a frame broke the protocol or could not be delivered, or a frame,
 * candidate, offer or queue bound was hit.
 */
export type SideRouteFailure = 'expired' | 'route' | 'send' | 'protocol' | 'limit';

/**
 * The owner of the side PC's outage deadline: the connection's link-liveness
 * owner (registry RO-15; Phase 4 C5-9 moved the deadline there). This route
 * reports each side PC state to it and asks it before restart signaling; the
 * owner starts, ends and expires each outage through outageStarted,
 * outageEnded and outageExpired, and calls mayRestart (through the
 * connection) when the original route changes.
 */
export interface SideOutageOwner {
  /** One state change of the current side PC, with whether this route restarts its ICE. */
  sideChanged(route: ControlIsolation, state: RTCPeerConnectionState, restartable: boolean): void;
  /** A grace for a side PC that cannot restart is running. */
  readonly sideGraceRunning: boolean;
  /** Restart signaling may travel on the original route now; if not, the outage waits for it. */
  sideMaySignal(): boolean;
  /** The side PC is gone (fallback or close): its outage ends without a callback. */
  sideClosed(): void;
}

interface Options {
  createPeerConnection(): IsolatedControlLease | null;
  sendOriginal(data: string): void;
  receive(data: string): void;
  changed(active: boolean): void;
  fail(reason: SideRouteFailure): void;
  /** Keeps the side PC's outage deadline. */
  readonly outages: SideOutageOwner;
}

/** The restart protocol's part of the exact side PC's current outage (monotonic time). */
interface Interruption {
  readonly start: number;
  attempts: number;
  /** A restart offer (offerer) or request (answerer) is due for this outage. */
  wanted: boolean;
}

interface Attempt {
  readonly epoch: number;
  readonly startedAt: number;
  offered: boolean;
  answered: boolean;
}

function nonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseEpoch(value: unknown, minimum: number): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= MAX_EPOCH
    ? value
    : null;
}

function parse(value: Record<string, unknown>): Frame | null {
  if (
    value.type !== TYPE ||
    value.version !== 1 ||
    typeof value.nonce !== 'string' ||
    !NONCE.test(value.nonce)
  )
    return null;
  const base = ['type', 'version', 'kind', 'nonce'];
  if (value.kind === 'hello') {
    return Object.keys(value).length === base.length
      ? { type: TYPE, version: 1, kind: 'hello', nonce: value.nonce }
      : null;
  }
  if (typeof value.target !== 'string' || !NONCE.test(value.target)) return null;
  base.push('target');
  let epoch: number | undefined;
  let sdp: string | undefined;
  let ice: RTCIceCandidateInit | undefined;
  switch (value.kind) {
    case 'request':
    case 'decline':
    case 'fence':
    case 'ready':
      break;
    case 'restart-request': {
      // The requester's latest observed restart generation; zero before any.
      const parsed = parseEpoch(value.epoch, 0);
      if (parsed === null) return null;
      base.push('epoch');
      epoch = parsed;
      break;
    }
    case 'offer':
    case 'answer':
    case 'restart-offer':
    case 'restart-answer':
      if (value.kind === 'restart-offer' || value.kind === 'restart-answer') {
        const parsed = parseEpoch(value.epoch, 1);
        if (parsed === null) return null;
        base.push('epoch');
        epoch = parsed;
      }
      if (typeof value.sdp !== 'string' || value.sdp.length === 0 || value.sdp.length > 32 * 1024)
        return null;
      base.push('sdp');
      sdp = value.sdp;
      break;
    case 'candidate':
    case 'restart-candidate': {
      if (value.kind === 'restart-candidate') {
        const parsed = parseEpoch(value.epoch, 1);
        if (parsed === null) return null;
        base.push('epoch');
        epoch = parsed;
      }
      const candidate = value.candidate;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
      const c = candidate as Record<string, unknown>;
      if (
        Object.keys(c).some(
          (key) => !['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].includes(key),
        ) ||
        typeof c.candidate !== 'string' ||
        c.candidate.length > 4096 ||
        (c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 256)) ||
        (c.usernameFragment != null &&
          (typeof c.usernameFragment !== 'string' || c.usernameFragment.length > 256)) ||
        (c.sdpMLineIndex != null &&
          (!Number.isInteger(c.sdpMLineIndex) ||
            (c.sdpMLineIndex as number) < 0 ||
            (c.sdpMLineIndex as number) > 16))
      )
        return null;
      base.push('candidate');
      ice = {
        candidate: c.candidate,
        ...(typeof c.sdpMid === 'string' ? { sdpMid: c.sdpMid } : {}),
        ...(typeof c.usernameFragment === 'string' ? { usernameFragment: c.usernameFragment } : {}),
        ...(typeof c.sdpMLineIndex === 'number' ? { sdpMLineIndex: c.sdpMLineIndex } : {}),
      };
      break;
    }
    default:
      return null;
  }
  return Object.keys(value).length === base.length
    ? {
        type: TYPE,
        version: 1,
        kind: value.kind,
        nonce: value.nonce,
        target: value.target,
        ...(epoch !== undefined ? { epoch } : {}),
        ...(sdp !== undefined ? { sdp } : {}),
        ...(ice !== undefined ? { candidate: ice } : {}),
      }
    : null;
}

export class ControlIsolation {
  private state: Phase = 'idle';
  private readonly localNonce = nonce();
  private remoteNonce: string | null = null;
  private started = false;
  private negotiationTimer: ReturnType<typeof setTimeout> | null = null;
  private lease: IsolatedControlLease | null = null;
  private sideChannel: RTCDataChannel | null = null;
  private localFence = false;
  private remoteFence = false;
  private sentReady = false;
  private remoteReady = false;
  private descriptionReceived = false;
  private remoteDescriptionReady = false;
  private remoteCandidates: RTCIceCandidateInit[] = [];
  private candidateCount = 0;
  private localCandidateCount = 0;
  private negotiationTail: Promise<void> = Promise.resolve();
  private readonly outgoing: string[] = [];
  private readonly incoming: string[] = [];
  private outgoingBytes = 0;
  private incomingBytes = 0;
  private largestOutgoingBytes = 0;
  private largestIncomingBytes = 0;
  private flushing = false;
  private readonly listeners = new Set<() => void>();
  // ICE restart of the side PC. Only the original side-PC offerer offers; the
  // answerer may ask it to. Generations ("epochs") increase by one.
  private restartEpoch = 0;
  private remoteEpochSeen = 0;
  private remoteEpoch = 0;
  private localEpoch = 0;
  private localRestartCandidates = 0;
  private remoteRestartCandidates = 0;
  private heldCandidates: RTCIceCandidateInit[] | null = null;
  private requestedEpoch = -1;
  private interruption: Interruption | null = null;
  private attempt: Attempt | null = null;
  private peerWanted = false;
  private peerWindowEnd = 0;
  private peerAttempts = 0;
  /** Monotonic times of offers sent (offerer) or accepted (answerer). */
  private readonly restartOffers: number[] = [];

  constructor(private readonly options: Options) {}

  get phase(): Phase {
    return this.state;
  }
  get peerConnection(): RTCPeerConnection | undefined {
    return this.lease?.pc;
  }
  get channel(): RTCDataChannel | undefined {
    return this.sideChannel ?? undefined;
  }
  get snapshot() {
    return {
      phase: this.state,
      localFence: this.localFence,
      remoteFence: this.remoteFence,
      sentReady: this.sentReady,
      remoteReady: this.remoteReady,
      outgoingMessages: this.outgoing.length,
      outgoingBytes: this.outgoingBytes,
      incomingMessages: this.incoming.length,
      incomingBytes: this.incomingBytes,
      localRestartEpoch: this.localEpoch,
      remoteRestartEpoch: this.remoteEpoch,
      restartInterrupted: this.interruption !== null,
    };
  }

  start(): void {
    if (this.started || this.state === 'closed') return;
    this.started = true;
    this.sendFrame('hello');
  }

  /**
   * Demand-driven: admission/R2-only peers allocate no additional PC. Bulk
   * waits for the peer's hello, which every end since 8.11.23 sends once
   * admission settles; the 1 s discovery window that let bulk start without
   * one went with the old-version removal train 2 (survey OV-F01).
   */
  allowBulk(): boolean {
    if (!this.started || this.state === 'closed') return false;
    if (this.state === 'active' || this.state === 'fallback') return true;
    if (this.state !== 'idle' || !this.remoteNonce) return false;
    this.begin();
    return this.phase === 'fallback';
  }

  subscribe(listener: () => void): () => void {
    if (this.state !== 'closed') this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** All application controls AND credit receipts use this single router. */
  send(data: string): void {
    if (this.state === 'closed') throw new Error('CONTROL_ISOLATION_CLOSED');
    try {
      if (this.flushing || (this.localFence && this.state !== 'active')) {
        this.enqueue(this.outgoing, data, true);
        if (this.phase === 'closed') throw new Error('CONTROL_ISOLATION_QUEUE_FULL');
      } else if (this.state === 'active') {
        if (this.sideChannel?.readyState !== 'open') throw new Error('CONTROL_ISOLATION_NOT_OPEN');
        this.sideChannel.send(data);
      } else this.options.sendOriginal(data);
    } catch (error) {
      this.fail('send');
      throw error;
    }
  }

  /** Called in the original control channel's serialized decode/dispatch lane. */
  handleOriginal(payload: unknown, fromControl: boolean): boolean {
    if (
      !payload ||
      typeof payload !== 'object' ||
      (payload as Record<string, unknown>).type !== TYPE
    )
      return false;
    // Reserved frames from the bulk lane never acquire negotiation authority.
    if (!fromControl || this.state === 'closed') return true;
    const frame = parse(payload as Record<string, unknown>);
    if (!frame) return true;
    if (frame.kind === 'hello') {
      if (frame.nonce === this.localNonce || this.remoteNonce !== null) return true;
      this.remoteNonce = frame.nonce;
      this.notify();
      return true;
    }
    if (!this.started || frame.nonce !== this.remoteNonce || frame.target !== this.localNonce)
      return true;
    if (frame.kind === 'request') {
      if (this.state === 'fallback') this.sendFrame('decline');
      else this.begin();
    } else if (frame.kind === 'decline') {
      // The refusing endpoint never creates an answer or sends a fence.
      if (this.localFence || this.remoteFence || this.state === 'active') this.fail('route');
      else this.fallback();
    } else if (frame.kind === 'fence') {
      if (this.state !== 'negotiating' && this.state !== 'fencing') return true;
      if (this.remoteFence) return true;
      this.remoteFence = true;
      this.advance();
    } else if (frame.kind === 'offer' || frame.kind === 'answer') {
      if (this.state === 'idle' && frame.kind === 'offer') this.begin();
      if (this.state !== 'negotiating' || this.descriptionReceived) return true;
      const offerer = this.localNonce < this.remoteNonce!;
      if ((frame.kind === 'offer') === offerer) return true;
      this.descriptionReceived = true;
      this.serialize(() => this.applyDescription(frame));
    } else if (frame.kind === 'candidate') {
      if (this.state !== 'negotiating' && this.state !== 'fencing' && this.state !== 'active')
        return true;
      if (++this.candidateCount > MAX_CANDIDATES) {
        this.fail('limit');
        return true;
      }
      if (!this.remoteDescriptionReady) this.remoteCandidates.push(frame.candidate!);
      // An accepted restart description supersedes initial-generation trickle.
      else if (this.remoteEpochSeen > 0) return true;
      else
        this.serialize(async () => {
          const pc = this.lease?.pc;
          if (pc && this.current(pc)) await pc.addIceCandidate(frame.candidate!);
        });
    } else if (frame.kind.startsWith('restart-') && this.restartReady()) this.restartFrame(frame);
    return true;
  }

  acceptOriginalApplication(): boolean {
    if (this.state === 'closed') return false;
    if (!this.remoteFence) return true;
    // Never silently mix old and new routes after the ordered remote fence.
    this.fail('protocol');
    return false;
  }

  /** The outage owner began an outage of the side PC: its attempts and request start over. */
  outageStarted(): void {
    this.interruption = { start: performance.now(), attempts: 0, wanted: false };
    this.requestedEpoch = -1;
  }

  /** The outage owner ended the side PC's outage. */
  outageEnded(): void {
    this.interruption = null;
    this.requestedEpoch = -1;
  }

  /** The original route changed and may carry restart signaling: restart if one is due. */
  mayRestart(): void {
    if (this.restartReady()) this.progressRestart();
  }

  /**
   * The outage owner's deadline ran out: a restartable route ends its logical
   * connection, one that cannot restart fails its setup.
   */
  outageExpired(restartable: boolean): void {
    if (restartable) this.fail('expired');
    else this.setupFailed();
  }

  dispose(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.clearTimers();
    this.attempt = null;
    this.heldCandidates = null;
    this.peerWanted = false;
    this.closeSide();
    this.outgoing.length = this.incoming.length = 0;
    this.outgoingBytes = this.incomingBytes = 0;
    this.remoteCandidates = [];
    this.options.changed(false);
    this.notify();
    this.listeners.clear();
  }

  private begin(): void {
    if (this.state !== 'idle' || !this.started || !this.remoteNonce) return;
    this.state = 'negotiating';
    // One attempt per exact logical connection; reconnect creates fresh nonces.
    // eslint-disable-next-line no-restricted-globals -- one bounded negotiation timer, disposed with the exact connection
    this.negotiationTimer = setTimeout(() => this.setupFailed(), NEGOTIATION_MS);
    this.sendFrame('request');
    if (this.localNonce < this.remoteNonce) this.serialize(() => this.createOffer());
  }

  private createSide(): RTCPeerConnection | null {
    if (this.lease) return this.lease.pc;
    if (this.state !== 'negotiating') return null;
    const lease = this.options.createPeerConnection();
    // Factories can synchronously retire their owner. Never resurrect its PC.
    if (this.phase !== 'negotiating') {
      try {
        lease?.pc.close();
      } finally {
        lease?.release();
      }
      return null;
    }
    if (!lease) {
      this.sendFrame('decline');
      this.fallback();
      return null;
    }
    this.lease = lease;
    const pc = lease.pc;
    pc.addEventListener('icecandidate', (event) => {
      if (!this.current(pc) || !event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (this.localEpoch > 0) return this.localRestartCandidate(candidate);
      if (++this.localCandidateCount > MAX_CANDIDATES) return this.fail('limit');
      this.sendFrame('candidate', { candidate });
    });
    pc.addEventListener('datachannel', (event) => {
      if (!this.current(pc)) {
        event.channel.close();
        return;
      }
      this.attachSide(event.channel);
    });
    pc.addEventListener('connectionstatechange', () => {
      if (!this.current(pc)) return;
      const state = pc.connectionState;
      const restartable = this.restartReady() && state !== 'closed';
      if (!restartable && (state === 'failed' || state === 'closed')) return this.setupFailed();
      this.sideStateChanged(state, restartable);
    });
    return pc;
  }

  private async createOffer(): Promise<void> {
    const pc = this.createSide();
    if (!pc) return;
    this.attachSide(pc.createDataChannel(LABEL, { ordered: true }));
    const offer = await pc.createOffer();
    if (!this.current(pc)) return;
    await pc.setLocalDescription(offer);
    if (!this.current(pc)) return;
    this.sendFrame('offer', { sdp: pc.localDescription?.sdp });
  }

  private async applyDescription(frame: Frame): Promise<void> {
    const pc = frame.kind === 'offer' ? this.createSide() : this.lease?.pc;
    if (!pc || !this.current(pc)) return;
    await pc.setRemoteDescription({ type: frame.kind as 'offer' | 'answer', sdp: frame.sdp! });
    if (!this.current(pc)) return;
    this.remoteDescriptionReady = true;
    const candidates = this.remoteCandidates.splice(0);
    for (const candidate of candidates) {
      await pc.addIceCandidate(candidate);
      if (!this.current(pc)) return;
    }
    if (frame.kind !== 'offer') return;
    const answer = await pc.createAnswer();
    if (!this.current(pc)) return;
    await pc.setLocalDescription(answer);
    if (!this.current(pc)) return;
    this.sendFrame('answer', { sdp: pc.localDescription?.sdp });
  }

  private attachSide(channel: RTCDataChannel): void {
    if (
      this.sideChannel ||
      channel.label !== LABEL ||
      !channel.ordered ||
      channel.maxRetransmits != null ||
      channel.maxPacketLifeTime != null
    ) {
      channel.close();
      this.fail('protocol');
      return;
    }
    this.sideChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => this.advance());
    channel.addEventListener('close', () => {
      if (this.state !== 'closed' && this.state !== 'fallback') this.setupFailed();
    });
    channel.addEventListener('error', () => {
      if (this.state !== 'closed' && this.state !== 'fallback') this.setupFailed();
    });
    channel.addEventListener('message', (event) => {
      if (this.state === 'closed' || this.sideChannel !== channel) return;
      if (typeof event.data !== 'string' || event.data.length > MAX_TEXT_UNITS)
        return this.fail('protocol');
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return this.fail('protocol');
      }
      if (
        payload &&
        typeof payload === 'object' &&
        (payload as Record<string, unknown>).type === TYPE
      ) {
        const frame = parse(payload as Record<string, unknown>);
        if (
          !frame ||
          frame.kind !== 'ready' ||
          frame.nonce !== this.remoteNonce ||
          frame.target !== this.localNonce
        )
          return this.fail('protocol');
        this.remoteReady = true;
        this.advance();
      } else if (this.state === 'active') this.deliver(event.data);
      else this.enqueue(this.incoming, event.data, false);
    });
    if (channel.readyState === 'open') this.advance();
  }

  private advance(): void {
    if (
      this.state === 'closed' ||
      this.state === 'fallback' ||
      this.state === 'active' ||
      this.sideChannel?.readyState !== 'open'
    )
      return;
    if (!this.localFence) {
      this.localFence = true;
      this.state = 'fencing';
      this.sendFrame('fence');
    }
    if (this.phase === 'closed' || !this.remoteFence) return;
    if (!this.sentReady) {
      this.sentReady = true;
      try {
        this.sideChannel.send(JSON.stringify(this.frame('ready')));
      } catch {
        return this.fail('send');
      }
    }
    if (!this.takeOverDisconnectGrace()) return;
    if (!this.remoteReady) return;
    this.state = 'active';
    if (this.negotiationTimer !== null) clearTimeout(this.negotiationTimer);
    this.negotiationTimer = null;
    // Flush before notifying capacity waiters: new sends cannot jump the fence queue.
    this.flushing = true;
    try {
      while (this.outgoing.length > 0 && this.state === 'active') {
        const data = this.outgoing.shift()!;
        this.outgoingBytes -= encoder.encode(data).byteLength;
        this.sideChannel.send(data);
      }
    } catch {
      return this.fail('send');
    } finally {
      this.flushing = false;
    }
    for (const data of this.incoming.splice(0)) {
      if (this.state !== 'active') return;
      this.deliver(data);
    }
    this.incomingBytes = 0;
    if (this.state !== 'active') return;
    this.options.changed(true);
    this.notify();
  }

  /** At READY the restart path takes over a disconnect grace armed before it. */
  private takeOverDisconnectGrace(): boolean {
    if (this.restartReady() && this.options.outages.sideGraceRunning && this.lease)
      this.sideStateChanged(this.lease.pc.connectionState, true);
    return this.state !== 'closed';
  }

  /**
   * Both fences are seen and READY is sent, so the peer may already be active
   * and own a restart: from here on, restart frames and side ICE outages use
   * the restart path rather than being dropped or closing the connection.
   */
  private restartReady(): boolean {
    return this.state === 'active' || (this.state === 'fencing' && this.sentReady);
  }

  private get offerer(): boolean {
    return this.remoteNonce !== null && this.localNonce < this.remoteNonce;
  }

  /** An offer or answer of the latest generation is still being applied. */
  private restartInFlight(): boolean {
    return (
      this.attempt !== null ||
      this.heldCandidates !== null ||
      this.localEpoch !== this.remoteEpochSeen
    );
  }

  private restartFrame(frame: Frame): void {
    const epoch = frame.epoch!;
    if (frame.kind === 'restart-request') {
      // Ordered after any answer still being applied for the same generation.
      if (this.offerer) this.serialize(async () => this.restartRequested(epoch));
    } else if (frame.kind === 'restart-offer') {
      if (this.offerer || epoch !== this.remoteEpochSeen + 1) return;
      // Ignoring an excess offer would strand the peer's attempt: close instead.
      const now = performance.now();
      if (this.offerWindowFull(now)) return this.fail('limit');
      this.restartOffers.push(now);
      this.remoteEpochSeen = epoch;
      this.remoteRestartCandidates = 0;
      if (this.interruption) this.interruption.wanted = false;
      this.serialize(() => this.answerRestart(epoch, frame.sdp!, now));
    } else if (frame.kind === 'restart-answer') {
      const attempt = this.attempt;
      if (!this.offerer || !attempt?.offered || attempt.answered || epoch !== attempt.epoch) return;
      attempt.answered = true;
      this.remoteEpochSeen = epoch;
      this.remoteRestartCandidates = 0;
      this.serialize(async () => {
        const pc = this.lease?.pc;
        if (!pc || !this.ownsAttempt(pc, attempt)) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: frame.sdp! });
        if (!this.ownsAttempt(pc, attempt)) return;
        this.remoteEpoch = epoch;
        this.attempt = null;
        this.retryIfNewer(attempt.startedAt, pc);
      });
    } else if (frame.kind === 'restart-candidate') {
      if (epoch !== this.remoteEpochSeen) return;
      if (++this.remoteRestartCandidates > MAX_CANDIDATES) return this.fail('limit');
      this.serialize(async () => {
        const pc = this.lease?.pc;
        if (!pc || !this.current(pc) || this.remoteEpoch !== epoch) return;
        // A trickled candidate from a superseded ICE generation is not route failure.
        await pc.addIceCandidate(frame.candidate!).catch(() => undefined);
      });
    }
  }

  /**
   * Reports a side PC state to the outage owner, which starts or ends the
   * outage; an outage reading then wants a restart.
   */
  private sideStateChanged(state: RTCPeerConnectionState, restartable: boolean): void {
    this.options.outages.sideChanged(this, state, restartable);
    const interruption = this.interruption;
    if (!interruption || (state !== 'disconnected' && state !== 'failed')) return;
    // An offer/answer still being applied already restarts this generation.
    if (!this.restartInFlight()) interruption.wanted = true;
    this.progressRestart();
  }

  private restartRequested(epoch: number): void {
    if (!this.restartReady() || this.attempt || epoch !== this.restartEpoch) return;
    this.peerWanted = true;
    this.progressRestart();
  }

  private progressRestart(): void {
    const interruption = this.interruption;
    if (!(interruption?.wanted || this.peerWanted)) return;
    if (!this.restartReady() || this.restartInFlight()) return;
    // The restart signaling travels on the original route: let it recover first.
    if (!this.options.outages.sideMaySignal()) return;
    if (interruption) interruption.wanted = false;
    this.peerWanted = false;
    if (!this.offerer) {
      // The answerer asks only for its own outage, once per generation.
      if (!interruption || this.requestedEpoch === this.remoteEpochSeen) return;
      this.requestedEpoch = this.remoteEpochSeen;
      this.sendFrame('restart-request', { epoch: this.remoteEpochSeen });
      return;
    }
    const pc = this.lease?.pc;
    const startedAt = performance.now();
    const count = pc ? this.consumeAttempt(interruption, startedAt) : 0;
    if (!pc || count === 0) return;
    const attempt: Attempt = {
      epoch: this.restartEpoch + 1,
      startedAt,
      offered: false,
      answered: false,
    };
    this.restartEpoch = attempt.epoch;
    this.attempt = attempt;
    log.info(`[Transport] Restarting isolated control ICE (${count}/${MAX_RESTART_ATTEMPTS})`);
    this.serialize(async () => {
      if (!this.ownsAttempt(pc, attempt)) return;
      await this.lease?.prepareRestart?.();
      if (!this.ownsAttempt(pc, attempt)) return;
      const offer = await pc.createOffer({ iceRestart: true });
      if (!this.ownsAttempt(pc, attempt)) return;
      this.holdLocalCandidates(attempt.epoch);
      await pc.setLocalDescription(offer);
      if (!this.ownsAttempt(pc, attempt)) return;
      attempt.offered = true;
      this.sendFrame('restart-offer', { epoch: attempt.epoch, sdp: pc.localDescription?.sdp });
      this.releaseLocalCandidates();
    });
  }

  /** A local outage spends its own attempts; peer requests alone, a window's. */
  private consumeAttempt(interruption: Interruption | null, now: number): number {
    if (this.offerWindowFull(now)) return 0;
    let count: number;
    if (interruption) {
      if (interruption.attempts >= MAX_RESTART_ATTEMPTS) return 0;
      count = ++interruption.attempts;
    } else {
      if (now >= this.peerWindowEnd) {
        this.peerWindowEnd = now + RESTART_WINDOW_MS;
        this.peerAttempts = 0;
      }
      if (this.peerAttempts >= MAX_RESTART_ATTEMPTS) return 0;
      count = ++this.peerAttempts;
    }
    this.restartOffers.push(now);
    return count;
  }

  /** Drops offers older than 30 s; true when one more would exceed the bound. */
  private offerWindowFull(now: number): boolean {
    while (this.restartOffers.length > 0 && this.restartOffers[0]! <= now - RESTART_CAP_MS)
      this.restartOffers.shift();
    return this.restartOffers.length >= MAX_RESTART_OFFERS;
  }

  /** An outage that began after this restart started may postdate its candidates. */
  private retryIfNewer(startedAt: number, pc: RTCPeerConnection): void {
    const interruption = this.interruption;
    if (!interruption || interruption.start <= startedAt || pc.connectionState === 'connected')
      return;
    interruption.wanted = true;
    this.progressRestart();
  }

  private async answerRestart(epoch: number, sdp: string, startedAt: number): Promise<void> {
    const pc = this.lease?.pc;
    const current = () => !!pc && this.current(pc) && this.remoteEpochSeen === epoch;
    if (!pc || !current()) return;
    // Same due credential renewal as the offerer before this side gathers.
    await this.lease?.prepareRestart?.();
    if (!current()) return;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    if (!current()) return;
    this.remoteEpoch = epoch;
    const answer = await pc.createAnswer();
    if (!current()) return;
    this.holdLocalCandidates(epoch);
    await pc.setLocalDescription(answer);
    if (!current()) return;
    this.sendFrame('restart-answer', { epoch, sdp: pc.localDescription?.sdp });
    this.releaseLocalCandidates();
    this.retryIfNewer(startedAt, pc);
  }

  /** New-generation candidates follow their own description on the ordered route. */
  private holdLocalCandidates(epoch: number): void {
    this.localEpoch = epoch;
    this.localRestartCandidates = 0;
    this.heldCandidates = [];
  }

  private releaseLocalCandidates(): void {
    const held = this.heldCandidates ?? [];
    this.heldCandidates = null;
    for (const candidate of held) {
      if (this.phase === 'closed') return;
      this.localRestartCandidate(candidate);
    }
  }

  private localRestartCandidate(candidate: RTCIceCandidateInit): void {
    if (this.heldCandidates) {
      if (this.heldCandidates.length >= MAX_CANDIDATES) return this.fail('limit');
      this.heldCandidates.push(candidate);
      return;
    }
    if (++this.localRestartCandidates > MAX_CANDIDATES) return this.fail('limit');
    this.sendFrame('restart-candidate', { epoch: this.localEpoch, candidate });
  }

  private ownsAttempt(pc: RTCPeerConnection, attempt: Attempt): boolean {
    return this.current(pc) && this.attempt === attempt;
  }

  private enqueue(queue: string[], data: string, outgoing: boolean): void {
    if (data.length > MAX_TEXT_UNITS) return this.fail('limit');
    const bytes = encoder.encode(data).byteLength;
    const next = (outgoing ? this.outgoingBytes : this.incomingBytes) + bytes;
    // Preserve the existing per-frame text envelope without permitting a queue
    // of arbitrarily many such frames: one largest frame plus 2 MiB of controls.
    // UTF-8 is at most 3 bytes per UTF-16 unit, so the hard bound is 50 MiB.
    const largest = Math.max(
      outgoing ? this.largestOutgoingBytes : this.largestIncomingBytes,
      bytes,
    );
    if (queue.length >= MAX_QUEUE_MESSAGES || next > MAX_QUEUE_BYTES + largest)
      return this.fail('limit');
    if (outgoing) this.largestOutgoingBytes = largest;
    else this.largestIncomingBytes = largest;
    if (outgoing) this.outgoingBytes = next;
    else this.incomingBytes = next;
    queue.push(data);
  }

  private deliver(data: string): void {
    try {
      this.options.receive(data);
    } catch {
      this.fail('protocol');
    }
  }

  private serialize(action: () => Promise<void>): void {
    this.negotiationTail = this.negotiationTail
      .then(async () => {
        if (this.state !== 'closed' && this.state !== 'fallback') await action();
      })
      .catch(() => {
        if (this.state !== 'closed' && this.state !== 'fallback') this.setupFailed();
      });
  }
  private current(pc: RTCPeerConnection): boolean {
    return this.state !== 'closed' && this.state !== 'fallback' && this.lease?.pc === pc;
  }
  private frame(kind: Kind, extra: Partial<Frame> = {}): Frame {
    return {
      type: TYPE,
      version: 1,
      kind,
      nonce: this.localNonce,
      ...(kind === 'hello' ? {} : { target: this.remoteNonce! }),
      ...extra,
    };
  }
  private sendFrame(kind: Kind, extra: Partial<Frame> = {}): void {
    if (this.state === 'closed') return;
    const frame = this.frame(kind, extra);
    if (!parse({ ...frame })) return this.fail('protocol');
    try {
      this.options.sendOriginal(JSON.stringify(frame));
    } catch {
      this.fail('send');
    }
  }
  private fallback(): void {
    if (this.state === 'closed' || this.state === 'fallback') return;
    if (this.localFence || this.remoteFence) return this.fail('route');
    this.state = 'fallback';
    this.clearTimers();
    this.closeSide();
    this.remoteCandidates = [];
    this.notify();
  }
  private setupFailed(): void {
    if (this.state === 'closed' || this.state === 'fallback') return;
    if (this.state !== 'negotiating' || this.localFence || this.remoteFence)
      return this.fail('route');
    // A refusal is ordered before any following old-route application message.
    // If the other endpoint has already fenced, it closes the entire connection.
    this.sendFrame('decline');
    if (this.phase !== 'closed') this.fallback();
  }
  private closeSide(): void {
    const lease = this.lease;
    const channel = this.sideChannel;
    this.lease = null;
    this.sideChannel = null;
    try {
      channel?.close();
    } catch {
      /* disposed */
    }
    try {
      lease?.pc.close();
    } catch {
      /* disposed */
    }
    lease?.release();
  }
  /** Clears this route's negotiation timer and its outage; the side PC is about to go. */
  private clearTimers(): void {
    if (this.negotiationTimer !== null) clearTimeout(this.negotiationTimer);
    this.negotiationTimer = null;
    this.interruption = null;
    this.options.outages.sideClosed();
  }
  private fail(reason: SideRouteFailure): void {
    if (this.state === 'closed') return;
    this.dispose();
    this.options.fail(reason);
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

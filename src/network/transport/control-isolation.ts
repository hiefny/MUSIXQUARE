/**
 * One optional control-only RTC association, owned by an admitted connection.
 * Its signaling travels over that connection's original authenticated channel;
 * it never enters the room membership/signaling negotiation namespace.
 */
import { log } from '../../core/log.ts';

const TYPE = 'mxqr-control-isolation';
const LABEL = 'musixquare-control-isolated'; // brand-capitalization: allow-technical -- private RTC data-channel identifier
const NONCE = /^[a-f0-9]{32}$/u;
const DISCOVERY_MS = 1_000;
const NEGOTIATION_MS = 10_000;
const DISCONNECTED_MS = 15_000;
// A restart-capable side route survives an ICE interruption by restarting ICE
// on the same PC: DTLS/SCTP and its ordered channel remain, so queued and
// in-flight controls keep their order. Each local interruption gets the
// original PC's 15-second grace, extended to 15 seconds after the original
// route recovers when that route was itself unavailable, never beyond 30.
// Monotonic time keeps a wall-clock correction from moving these deadlines.
const RESTART_WINDOW_MS = 15_000;
const RESTART_CAP_MS = 30_000;
// Per local interruption, and separately per window of peer requests.
const MAX_RESTART_ATTEMPTS = 2;
// Restart offers an answerer accepts per 30 s: above any legitimate offerer.
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
  // Additive restart frames. A build without them parses unknown kinds as
  // invalid and ignores them, so it keeps its terminal side-failure behavior.
  | 'restart-capable'
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

interface Options {
  createPeerConnection(): IsolatedControlLease | null;
  sendOriginal(data: string): void;
  receive(data: string): void;
  changed(active: boolean): void;
  fail(): void;
  /** Whether the original route is connected rather than itself recovering. */
  originalReady?(): boolean;
}

/** The exact side PC's own disconnected/failed outage (monotonic times). */
interface Interruption {
  readonly start: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  /** A restart offer (offerer) or request (answerer) is due for this outage. */
  wanted: boolean;
  /** The original route was unavailable during this interruption. */
  originalDown: boolean;
}

interface Attempt {
  readonly epoch: number;
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
    case 'restart-capable':
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
  private discoveryDone = false;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private negotiationTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
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
  private remoteRestartCapable = false;
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
  private readonly acceptedOffers: number[] = [];

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
      restartCapable: this.remoteRestartCapable,
      localRestartEpoch: this.localEpoch,
      remoteRestartEpoch: this.remoteEpoch,
      restartInterrupted: this.interruption !== null,
    };
  }

  start(): void {
    if (this.started || this.state === 'closed') return;
    this.started = true;
    this.sendFrame('hello');
    if (this.phase === 'closed') return;
    // eslint-disable-next-line no-restricted-globals -- exact connection owns and disposes discovery; room timer cleanup must not strand transfer waits
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      this.discoveryDone = true;
      this.notify();
    }, DISCOVERY_MS);
  }

  /** Demand-driven: admission/R2-only peers allocate no additional PC. */
  allowBulk(): boolean {
    if (!this.started || this.state === 'closed') return false;
    if (this.state === 'active' || this.state === 'fallback') return true;
    if (this.state !== 'idle') return false;
    if (!this.remoteNonce) return this.discoveryDone;
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
      this.fail();
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
      if (this.localFence || this.remoteFence || this.state === 'active') this.fail();
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
        this.fail();
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
    } else if (frame.kind === 'restart-capable') {
      // Ordered before the sender's fence: it cannot change an active route.
      if (!this.remoteFence && this.state !== 'fallback') this.remoteRestartCapable = true;
    } else if (frame.kind.startsWith('restart-') && this.restartReady()) this.restartFrame(frame);
    return true;
  }

  acceptOriginalApplication(): boolean {
    if (this.state === 'closed') return false;
    if (!this.remoteFence) return true;
    // Never silently mix old and new routes after the ordered remote fence.
    this.fail();
    return false;
  }

  /** The owner reports original-PC state changes; side restarts wait for its recovery. */
  originalChanged(): void {
    if (!this.restartReady()) return;
    const interruption = this.interruption;
    if (!this.originalReady()) {
      if (interruption) interruption.originalDown = true;
      return;
    }
    if (interruption?.originalDown) {
      interruption.originalDown = false;
      // Waiting for the original route must not consume the side's own window.
      this.armDeadline(
        interruption,
        Math.min(
          interruption.start + RESTART_CAP_MS,
          Math.max(interruption.deadline, performance.now() + RESTART_WINDOW_MS),
        ),
      );
    }
    this.progressRestart();
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
    // Precedes this endpoint's fence on the ordered original route.
    this.sendFrame('restart-capable');
    if (this.phase === 'closed') return;
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
      if (++this.localCandidateCount > MAX_CANDIDATES) return this.fail();
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
      if (this.restartReady() && pc.connectionState !== 'closed') return this.sideStateChanged(pc);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.setupFailed();
      else if (pc.connectionState === 'disconnected' && this.disconnectedTimer === null) {
        // eslint-disable-next-line no-restricted-globals -- non-renewing grace for the separately owned control PC
        this.disconnectedTimer = setTimeout(() => {
          this.disconnectedTimer = null;
          if (this.current(pc) && pc.connectionState !== 'connected') this.setupFailed();
        }, DISCONNECTED_MS);
      } else if (pc.connectionState === 'connected' && this.disconnectedTimer !== null) {
        clearTimeout(this.disconnectedTimer);
        this.disconnectedTimer = null;
      }
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
      this.fail();
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
      if (typeof event.data !== 'string' || event.data.length > MAX_TEXT_UNITS) return this.fail();
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return this.fail();
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
          return this.fail();
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
        return this.fail();
      }
    }
    // A restart-capable route takes over a disconnect grace armed before READY.
    if (this.restartReady() && this.disconnectedTimer !== null && this.lease) {
      this.sideStateChanged(this.lease.pc);
      if (this.phase === 'closed') return;
    }
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
      return this.fail();
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

  /**
   * Both fences are seen and READY is sent, so the peer may already be active
   * and own a restart: from here on, restart frames and side ICE outages use
   * the restart path rather than being dropped or closing the connection.
   */
  private restartReady(): boolean {
    return (
      this.remoteRestartCapable &&
      (this.state === 'active' || (this.state === 'fencing' && this.sentReady))
    );
  }

  private get offerer(): boolean {
    return this.remoteNonce !== null && this.localNonce < this.remoteNonce;
  }

  private originalReady(): boolean {
    return this.options.originalReady?.() ?? true;
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
      while (this.acceptedOffers.length > 0 && this.acceptedOffers[0]! <= now - RESTART_CAP_MS)
        this.acceptedOffers.shift();
      if (this.acceptedOffers.length >= MAX_RESTART_OFFERS) return this.fail();
      this.acceptedOffers.push(now);
      this.remoteEpochSeen = epoch;
      this.remoteRestartCandidates = 0;
      if (this.interruption) this.interruption.wanted = false;
      this.serialize(() => this.answerRestart(epoch, frame.sdp!));
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
      });
    } else if (frame.kind === 'restart-candidate') {
      if (epoch !== this.remoteEpochSeen) return;
      if (++this.remoteRestartCandidates > MAX_CANDIDATES) return this.fail();
      this.serialize(async () => {
        const pc = this.lease?.pc;
        if (!pc || !this.current(pc) || this.remoteEpoch !== epoch) return;
        // A trickled candidate from a superseded ICE generation is not route failure.
        await pc.addIceCandidate(frame.candidate!).catch(() => undefined);
      });
    }
  }

  private sideStateChanged(pc: RTCPeerConnection): void {
    if (this.disconnectedTimer !== null) {
      // The restart path owns this outage from here on.
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
    }
    const state = pc.connectionState;
    if (state === 'connected') {
      if (this.interruption) {
        this.endInterruption();
        log.info('[Transport] Isolated control ICE recovered');
      }
      return;
    }
    if (state !== 'disconnected' && state !== 'failed') return;
    const interruption = this.beginInterruption();
    // An offer/answer still being applied already restarts this generation.
    if (!this.restartInFlight()) interruption.wanted = true;
    this.progressRestart();
  }

  private restartRequested(epoch: number): void {
    if (!this.restartReady() || this.attempt || epoch !== this.restartEpoch) return;
    this.peerWanted = true;
    this.progressRestart();
  }

  private beginInterruption(): Interruption {
    if (this.interruption) return this.interruption;
    const start = performance.now();
    const interruption: Interruption = {
      start,
      deadline: start + RESTART_WINDOW_MS,
      timer: null,
      attempts: 0,
      wanted: false,
      originalDown: !this.originalReady(),
    };
    this.interruption = interruption;
    this.requestedEpoch = -1;
    this.armDeadline(interruption, interruption.deadline);
    return interruption;
  }

  private progressRestart(): void {
    const interruption = this.interruption;
    if (!(interruption?.wanted || this.peerWanted)) return;
    if (!this.restartReady() || this.restartInFlight()) return;
    // The restart signaling travels on the original route: let it recover first.
    if (!this.originalReady()) {
      if (interruption) interruption.originalDown = true;
      return;
    }
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
    const count = pc ? this.consumeAttempt(interruption) : 0;
    if (!pc || count === 0) return;
    const attempt: Attempt = { epoch: this.restartEpoch + 1, offered: false, answered: false };
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
  private consumeAttempt(interruption: Interruption | null): number {
    if (interruption) {
      if (interruption.attempts >= MAX_RESTART_ATTEMPTS) return 0;
      return ++interruption.attempts;
    }
    const now = performance.now();
    if (now >= this.peerWindowEnd) {
      this.peerWindowEnd = now + RESTART_WINDOW_MS;
      this.peerAttempts = 0;
    }
    if (this.peerAttempts >= MAX_RESTART_ATTEMPTS) return 0;
    return ++this.peerAttempts;
  }

  private async answerRestart(epoch: number, sdp: string): Promise<void> {
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
      if (this.heldCandidates.length >= MAX_CANDIDATES) return this.fail();
      this.heldCandidates.push(candidate);
      return;
    }
    if (++this.localRestartCandidates > MAX_CANDIDATES) return this.fail();
    this.sendFrame('restart-candidate', { epoch: this.localEpoch, candidate });
  }

  private armDeadline(interruption: Interruption, deadline: number): void {
    if (interruption.timer !== null) clearTimeout(interruption.timer);
    interruption.deadline = deadline;
    // eslint-disable-next-line no-restricted-globals -- one bounded recovery deadline per exact side interruption, disposed with the connection
    interruption.timer = setTimeout(
      () => this.restartExpired(interruption),
      Math.max(0, deadline - performance.now()),
    );
  }

  private restartExpired(interruption: Interruption): void {
    if (this.interruption !== interruption) return;
    interruption.timer = null;
    const pc = this.lease?.pc;
    if (!pc || !this.current(pc)) return;
    if (pc.connectionState === 'connected') return this.endInterruption();
    const cap = interruption.start + RESTART_CAP_MS;
    if (!this.originalReady() && performance.now() < cap) {
      // The original route owns its own bounded recovery; do not pre-empt it.
      interruption.originalDown = true;
      return this.armDeadline(interruption, cap);
    }
    log.warn('[Transport] Isolated control ICE did not recover; closing its logical connection');
    this.fail();
  }

  private endInterruption(): void {
    const interruption = this.interruption;
    if (!interruption) return;
    if (interruption.timer !== null) clearTimeout(interruption.timer);
    this.interruption = null;
    this.requestedEpoch = -1;
  }

  private ownsAttempt(pc: RTCPeerConnection, attempt: Attempt): boolean {
    return this.current(pc) && this.attempt === attempt;
  }

  private enqueue(queue: string[], data: string, outgoing: boolean): void {
    if (data.length > MAX_TEXT_UNITS) return this.fail();
    const bytes = encoder.encode(data).byteLength;
    const next = (outgoing ? this.outgoingBytes : this.incomingBytes) + bytes;
    // Preserve the existing per-frame text envelope without permitting a queue
    // of arbitrarily many such frames: one largest frame plus 2 MiB of controls.
    // UTF-8 is at most 3 bytes per UTF-16 unit, so the hard bound is 50 MiB.
    const largest = Math.max(
      outgoing ? this.largestOutgoingBytes : this.largestIncomingBytes,
      bytes,
    );
    if (queue.length >= MAX_QUEUE_MESSAGES || next > MAX_QUEUE_BYTES + largest) return this.fail();
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
      this.fail();
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
    if (!parse({ ...frame })) return this.fail();
    try {
      this.options.sendOriginal(JSON.stringify(frame));
    } catch {
      this.fail();
    }
  }
  private fallback(): void {
    if (this.state === 'closed' || this.state === 'fallback') return;
    if (this.localFence || this.remoteFence) return this.fail();
    this.state = 'fallback';
    this.clearTimers();
    this.closeSide();
    this.remoteCandidates = [];
    this.notify();
  }
  private setupFailed(): void {
    if (this.state === 'closed' || this.state === 'fallback') return;
    if (this.state !== 'negotiating' || this.localFence || this.remoteFence) return this.fail();
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
  private clearTimers(): void {
    for (const timer of [
      this.discoveryTimer,
      this.negotiationTimer,
      this.disconnectedTimer,
      this.interruption?.timer ?? null,
    ]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.discoveryTimer = this.negotiationTimer = this.disconnectedTimer = null;
    this.interruption = null;
  }
  private fail(): void {
    if (this.state === 'closed') return;
    this.dispose();
    this.options.fail();
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

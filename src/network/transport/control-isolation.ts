/**
 * One optional control-only RTC association, owned by an admitted connection.
 * Its signaling travels over that connection's original authenticated channel;
 * it never enters the room membership/signaling negotiation namespace.
 */
const TYPE = 'mxqr-control-isolation';
const LABEL = 'musixquare-control-isolated';
const NONCE = /^[a-f0-9]{32}$/u;
const DISCOVERY_MS = 1_000;
const NEGOTIATION_MS = 10_000;
const DISCONNECTED_MS = 15_000;
const MAX_CANDIDATES = 128;
const MAX_QUEUE_MESSAGES = 128;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_UNITS = 16 * 1024 * 1024;
const encoder = new TextEncoder();

type Phase = 'idle' | 'negotiating' | 'fencing' | 'active' | 'fallback' | 'closed';
type Kind = 'hello' | 'request' | 'decline' | 'offer' | 'answer' | 'candidate' | 'fence' | 'ready';
interface Frame {
  type: typeof TYPE;
  version: 1;
  kind: Kind;
  nonce: string;
  target?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export interface IsolatedControlLease {
  readonly pc: RTCPeerConnection;
  release(): void;
}

interface Options {
  createPeerConnection(): IsolatedControlLease | null;
  sendOriginal(data: string): void;
  receive(data: string): void;
  changed(active: boolean): void;
  fail(): void;
}

function nonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parse(value: Record<string, unknown>): Frame | null {
  if (value.version !== 1 || typeof value.nonce !== 'string' || !NONCE.test(value.nonce))
    return null;
  const base = ['type', 'version', 'kind', 'nonce'];
  if (value.kind === 'hello') {
    return Object.keys(value).length === base.length ? (value as unknown as Frame) : null;
  }
  if (typeof value.target !== 'string' || !NONCE.test(value.target)) return null;
  base.push('target');
  switch (value.kind) {
    case 'request':
    case 'decline':
    case 'fence':
    case 'ready':
      break;
    case 'offer':
    case 'answer':
      if (typeof value.sdp !== 'string' || value.sdp.length === 0 || value.sdp.length > 32 * 1024)
        return null;
      base.push('sdp');
      break;
    case 'candidate': {
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
      break;
    }
    default:
      return null;
  }
  return Object.keys(value).length === base.length ? (value as unknown as Frame) : null;
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
      else
        this.serialize(async () => {
          const pc = this.lease?.pc;
          if (pc && this.current(pc)) await pc.addIceCandidate(frame.candidate!);
        });
    }
    return true;
  }

  acceptOriginalApplication(): boolean {
    if (this.state === 'closed') return false;
    if (!this.remoteFence) return true;
    // Never silently mix old and new routes after the ordered remote fence.
    this.fail();
    return false;
  }

  dispose(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.clearTimers();
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
      if (++this.localCandidateCount > MAX_CANDIDATES) return this.fail();
      this.sendFrame('candidate', { candidate: event.candidate.toJSON() });
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
    if (!parse(frame as unknown as Record<string, unknown>)) return this.fail();
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
    for (const timer of [this.discoveryTimer, this.negotiationTimer, this.disconnectedTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.discoveryTimer = this.negotiationTimer = this.disconnectedTimer = null;
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

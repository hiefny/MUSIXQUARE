import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import type { TransportBulkFlowControl } from './types.ts';

const FRAME_TYPE = 'mxqr-bulk-flow';
const VERSION = 1;
const WINDOW_BYTES = 128 * 1024;
const RECEIPT_BYTES = 64 * 1024;
const RECEIPT_DELAY_MS = 20;
const LEGACY_GRACE_MS = 1000;
const NONCE_RE = /^[a-f0-9]{32}$/u;

// Delay-based receipt window. A chunk is credit only while it travels:
// sent -> bottleneck -> receiver -> receipt back, so throughput is window/loop.
// The rules reason about one shared FIFO bottleneck with a fixed feedback
// delay: there the window must cover the bandwidth-delay product and every
// byte beyond it queues in front of control traffic. SCTP, browsers and real
// links are not that model. Grow one chunk at a time while the measured loop
// shows the added chunk mostly entered the pipe; shrink as soon as it queues.
// Budgets are admission policy, not network guarantees.
const ADAPTIVE_STEP_BYTES = CHUNK_SIZE;
// The only cap. A 192 KiB variant changes this constant alone.
const ADAPTIVE_MAX_BYTES = 256 * 1024;
const ADAPTIVE_BLOCK_SAMPLES = 5;
// Little's-law estimate: a full window drains at windowBytes/loop, so one more
// chunk would add about 64 KiB x loop / window of queueing if the path were
// already full. It is an estimate from the last median, not a worst-case
// bound. A 2 Mbps/200 ms path (about 274 ms per chunk) therefore keeps 128 KiB.
const ADAPTIVE_GROWTH_DELAY_MS = 250;
// Keep a step only if at most this fraction of the added chunk's estimated
// delay became queueing and the loop stays within the standing-queue budget of
// the 128 KiB baseline.
const ADAPTIVE_QUEUED_FRACTION = 0.5;
const ADAPTIVE_STANDING_QUEUE_MS = 60;
// Per-receipt safety above the current level's loop: twice this falls back to
// 128 KiB at once; two consecutive receipts above it shed one chunk.
const ADAPTIVE_SAFETY_MS = 100;
const ADAPTIVE_HOLD_MS = 10_000;
// A failed probe is not repeated from the same window until that window's loop
// improves by this fraction of one chunk's delay, or the memory expires.
const ADAPTIVE_REPROBE_GAIN = 0.25;
const ADAPTIVE_REPROBE_MS = 60_000;
const ADAPTIVE_IDLE_RESET_MS = 1000;
// Above 128 KiB the window must keep earning its size. App-limited, tail,
// coalesced and untracked receipts release credit without a full-window
// sample, so after this long or this many released bytes without one (counted
// from the last sample or window change) the window returns to 128 KiB.
const ADAPTIVE_EVIDENCE_MS = 2000;
const ADAPTIVE_EVIDENCE_BYTES = 16 * CHUNK_SIZE;
const ADAPTIVE_BOUNDARIES = ADAPTIVE_MAX_BYTES / CHUNK_SIZE + 4;

type AdaptivePhase = 'measure' | 'probe';
type SentBoundary = { end: number; at: number; epoch: number; limited: boolean };
type FailedProbe = { windowBytes: number; ageMs: number; at: number };

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Sender-only policy; receipt age includes local, link, receiver and return time. */
class AdaptiveCreditController {
  windowBytes = WINDOW_BYTES;
  phase: AdaptivePhase = 'measure';
  epoch = 0;
  heldUntilMs = 0;
  lastDecision = 'initial';
  private active = false;
  private sentEnd = 0;
  private boundaries: SentBoundary[] = [];
  private samples: number[] = [];
  private warmupThrough = 0;
  private safetyFrom = 0;
  private failedProbe: FailedProbe | null = null;
  private baseAgeMs: number | null = null;
  private referenceAgeMs: number | null = null;
  private lastBlockAgeMs: number | null = null;
  private pendingViolation = false;
  private lastReceiptAt: number | null = null;
  private completedBlocks = 0;
  private evidenceAt = 0;
  private releasedSinceEvidence = 0;

  constructor(private readonly now: () => number) {}

  get diagnostics() {
    return {
      windowBytes: this.windowBytes,
      phase: this.phase,
      epoch: this.epoch,
      sampleCount: this.samples.length,
      baseAgeMs: this.baseAgeMs,
      referenceAgeMs: this.referenceAgeMs,
      lastBlockAgeMs: this.lastBlockAgeMs,
      heldUntilMs: this.heldUntilMs,
      lastDecision: this.lastDecision,
      trackedBoundaries: this.boundaries.length,
      completedBlocks: this.completedBlocks,
      warmupThroughBytes: this.warmupThrough,
      evidenceAtMs: this.evidenceAt,
      releasedSinceEvidenceBytes: this.releasedSinceEvidence,
      failedProbe: this.failedProbe ? { ...this.failedProbe } : null,
    } as const;
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.failedProbe = null;
    this.reset('negotiated', this.sentEnd);
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    // Lifetime debt belongs to BulkFlowControl. Only learning history expires.
    this.reset('control-isolation-inactive', this.sentEnd);
    this.lastReceiptAt = null;
  }

  sent(end: number, bytes: number, previousOutstanding: number): void {
    this.sentEnd = end;
    if (!this.active) return;
    const now = this.now();
    if (
      previousOutstanding === 0 &&
      this.lastReceiptAt !== null &&
      now - this.lastReceiptAt > ADAPTIVE_IDLE_RESET_MS
    ) {
      // The path may have changed while idle. Relearn from 128 KiB; not a penalty.
      this.reset('producer-idle', end - bytes);
    }
    // Evidence can expire between events; at most this chunk used the stale window.
    this.expireEvidence(now);
    // Tails never become timing samples. Pre-activation debt is never tracked.
    if (bytes !== CHUNK_SIZE) return;
    this.boundaries.push({
      end,
      at: now,
      epoch: this.epoch,
      // The sender is window-limited: less than one chunk of credit remains.
      limited: previousOutstanding + bytes > this.windowBytes - ADAPTIVE_STEP_BYTES,
    });
    if (this.boundaries.length > ADAPTIVE_BOUNDARIES) this.boundaries.shift();
  }

  receipt(previous: number, end: number): void {
    if (!this.active) return;
    const now = this.now();
    this.lastReceiptAt = now;
    this.releasedSinceEvidence += end - previous;
    const boundary = this.boundaries.find((entry) => entry.end === end);
    this.boundaries = this.boundaries.filter((entry) => entry.end > end);
    const age = boundary ? now - boundary.at : NaN;
    // A coalesced or untracked receipt releases credit but is not a loop sample.
    if (
      boundary &&
      boundary.epoch === this.epoch &&
      end - previous === CHUNK_SIZE &&
      end > this.warmupThrough &&
      Number.isFinite(age) &&
      age >= 0
    ) {
      this.observe(age, boundary.limited, end);
    }
    // Decide before the released credit wakes the sender.
    this.expireEvidence(now);
  }

  dispose(): void {
    this.active = false;
    this.boundaries = [];
    this.samples = [];
    this.lastReceiptAt = null;
  }

  private observe(age: number, limited: boolean, end: number): void {
    const reference = this.referenceAgeMs;
    // The first flight after growth queues behind its own extra chunk; the
    // probe's median judges it, the per-receipt safety starts after it.
    if (reference !== null && this.windowBytes > WINDOW_BYTES && end > this.safetyFrom) {
      const excess = age - reference;
      if (excess > 2 * ADAPTIVE_SAFETY_MS) return this.fallBack('loop-spike');
      if (excess > ADAPTIVE_SAFETY_MS) {
        if (this.pendingViolation) return this.shrink('loop-increase');
        this.pendingViolation = true;
      } else {
        this.pendingViolation = false;
      }
    }
    // Only a full window measures the path; app-limited loops are shorter.
    if (!limited) return;
    this.samples.push(age);
    this.noteEvidence();
    if (this.samples.length < ADAPTIVE_BLOCK_SAMPLES) return;
    const median = medianOf(this.samples);
    this.samples = [];
    this.completedBlocks += 1;
    this.lastBlockAgeMs = median;
    if (this.phase === 'probe') this.decideProbe(median);
    else this.decideMeasure(median);
  }

  private decideMeasure(median: number): void {
    if (this.windowBytes === WINDOW_BYTES) this.baseAgeMs = median;
    else if (this.baseAgeMs !== null && median - this.baseAgeMs > ADAPTIVE_SAFETY_MS) {
      return this.shrink('standing-queue');
    }
    this.referenceAgeMs = median;
    this.maybeGrow(median);
  }

  private decideProbe(median: number): void {
    // Probes start only from a measured level, so both references exist.
    const previous = this.referenceAgeMs!;
    const base = this.baseAgeMs ?? previous;
    // Estimated delay of one more chunk if all of it queued at the previous
    // level's drain rate; a model estimate, not a worst-case bound.
    const chunkDelay = (ADAPTIVE_STEP_BYTES * previous) / (this.windowBytes - ADAPTIVE_STEP_BYTES);
    if (
      median - previous > ADAPTIVE_QUEUED_FRACTION * chunkDelay ||
      median - base > ADAPTIVE_STANDING_QUEUE_MS
    ) {
      this.hold('queue-growth', this.windowBytes - ADAPTIVE_STEP_BYTES);
      return;
    }
    this.referenceAgeMs = median;
    this.phase = 'measure';
    this.lastDecision = `accepted-${this.windowBytes / 1024}`;
    this.maybeGrow(median);
  }

  private maybeGrow(ageMs: number): void {
    const now = this.now();
    const failed = this.failedProbe;
    const failedHere =
      failed !== null &&
      failed.windowBytes === this.windowBytes &&
      now - failed.at < ADAPTIVE_REPROBE_MS &&
      ageMs >
        failed.ageMs -
          (ADAPTIVE_REPROBE_GAIN * ADAPTIVE_STEP_BYTES * failed.ageMs) / failed.windowBytes;
    if (
      this.windowBytes >= ADAPTIVE_MAX_BYTES ||
      now < this.heldUntilMs ||
      failedHere ||
      (ADAPTIVE_STEP_BYTES * ageMs) / this.windowBytes > ADAPTIVE_GROWTH_DELAY_MS
    ) {
      return;
    }
    this.windowBytes += ADAPTIVE_STEP_BYTES;
    this.phase = 'probe';
    this.restartSamples(`probe-${this.windowBytes / 1024}`);
    this.safetyFrom = this.sentEnd + this.windowBytes;
  }

  /** Two consecutive excess receipts: shed one chunk and keep the old reference. */
  private shrink(reason: string): void {
    this.hold(reason, Math.max(WINDOW_BYTES, this.windowBytes - ADAPTIVE_STEP_BYTES));
  }

  /** A sudden loop jump (bandwidth collapse) returns to the 128 KiB baseline. */
  private fallBack(reason: string): void {
    this.hold(reason, WINDOW_BYTES);
    this.referenceAgeMs = null;
  }

  /** Keep a larger window only while full-window samples keep arriving. */
  private expireEvidence(now: number): void {
    if (this.windowBytes <= WINDOW_BYTES) return;
    if (now - this.evidenceAt > ADAPTIVE_EVIDENCE_MS) this.forget('evidence-stale');
    else if (this.releasedSinceEvidence > ADAPTIVE_EVIDENCE_BYTES) this.forget('evidence-sparse');
  }

  /** Missing evidence is not a failure: relearn from 128 KiB without a hold or probe memory. */
  private forget(reason: string): void {
    this.windowBytes = WINDOW_BYTES;
    this.phase = 'measure';
    this.baseAgeMs = null;
    this.referenceAgeMs = null;
    this.restartSamples(reason);
  }

  private hold(reason: string, windowBytes: number): void {
    if (this.phase === 'probe' && this.referenceAgeMs !== null) {
      this.failedProbe = {
        windowBytes: this.windowBytes - ADAPTIVE_STEP_BYTES,
        ageMs: this.referenceAgeMs,
        at: this.now(),
      };
    }
    this.windowBytes = windowBytes;
    this.phase = 'measure';
    this.heldUntilMs = this.now() + ADAPTIVE_HOLD_MS;
    this.restartSamples(reason);
  }

  /** Every chunk already sent belongs to the previous window. */
  private restartSamples(reason: string): void {
    this.samples = [];
    this.pendingViolation = false;
    this.warmupThrough = this.sentEnd;
    this.lastDecision = reason;
    this.noteEvidence();
  }

  /** A full-window sample or a window change restarts the evidence bound. */
  private noteEvidence(): void {
    this.evidenceAt = this.now();
    this.releasedSinceEvidence = 0;
  }

  private reset(reason: string, flightStart: number): void {
    this.epoch += 1;
    this.windowBytes = WINDOW_BYTES;
    this.phase = 'measure';
    this.boundaries = [];
    this.baseAgeMs = null;
    this.referenceAgeMs = null;
    this.restartSamples(reason);
    // A first flight from an empty pipe queues behind itself; skip it.
    this.warmupThrough = flightStart + WINDOW_BYTES;
    this.safetyFrom = 0;
  }
}

type ControlFrame =
  | { type: typeof FRAME_TYPE; version: 1; kind: 'hello'; nonce: string }
  | {
      type: typeof FRAME_TYPE;
      version: 1;
      kind: 'receipt';
      nonce: string;
      receivedBytes: number;
    };

/** Payload accounting excludes the small existing binary frame header. */
export function creditedFileChunkBytes(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  const value = payload as Record<string, unknown>;
  if (value.type !== MSG.FILE_CHUNK && value.type !== MSG.PRELOAD_CHUNK) return 0;
  const chunk = value.chunk;
  const bytes = chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk) ? chunk.byteLength : 0;
  return bytes > 0 && bytes <= CHUNK_SIZE ? bytes : 0;
}

function createNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Network receipt credit for one exact ordered bulk/control channel pair.
 * Counters cover the entire connection, including legacy grace and cancelled
 * file attempts. A receipt proves transport delivery, never storage readiness.
 * No file/session state, payload queue or per-chunk timer is retained here.
 */
export class BulkFlowControl implements TransportBulkFlowControl {
  private readonly nonce = createNonce();
  private remoteNonce: string | null = null;
  private started = false;
  private disposed = false;
  private legacy = false;
  private controlIsolationActive = false;
  private sentBytes = 0;
  private acknowledgedBytes = 0;
  private receivedBytes = 0;
  private reportedBytes = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private receiptTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly adaptive: AdaptiveCreditController;

  constructor(
    private readonly sendControl: (frame: ControlFrame) => void,
    private readonly onControlFailure?: () => void,
    monotonicNow: () => number = () => performance.now(),
  ) {
    this.adaptive = new AdaptiveCreditController(monotonicNow);
  }

  /** Passive diagnostics; reading cannot change credit or the probe. */
  get diagnosticSnapshot() {
    return {
      ...this.adaptive.diagnostics,
      controlIsolationActive: this.controlIsolationActive,
      adaptiveEnabled: this.canAdapt(),
      phase: this.disposed ? 'disposed' : this.legacy ? 'legacy' : this.adaptive.phase,
      sentBytes: this.sentBytes,
      acknowledgedBytes: this.acknowledgedBytes,
      receivedBytes: this.receivedBytes,
      reportedBytes: this.reportedBytes,
      outstandingBytes: this.sentBytes - this.acknowledgedBytes,
    } as const;
  }

  /** Enable only after this connection's separate control path is active. */
  setControlIsolationActive(active: boolean): void {
    if (this.disposed || this.controlIsolationActive === active) return;
    this.controlIsolationActive = active;
    if (this.canAdapt()) this.adaptive.activate();
    else this.adaptive.deactivate();
  }

  private canAdapt(): boolean {
    return (
      !this.disposed && this.started && this.remoteNonce !== null && this.controlIsolationActive
    );
  }

  /** Called after admission settles, before application transfer events. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (this.canAdapt()) this.adaptive.activate();
    if (this.remoteNonce === null) {
      // eslint-disable-next-line no-restricted-globals -- owned by this exact transport; room timer cleanup must not strand a live capacity waiter
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (this.disposed || this.remoteNonce !== null) return;
        this.legacy = true;
        this.notify();
      }, LEGACY_GRACE_MS);
    }
    this.send({ type: FRAME_TYPE, version: VERSION, kind: 'hello', nonce: this.nonce });
    if (this.remoteNonce !== null) this.flushReceipt(true);
  }

  hasCapacity(nextPayloadBytes: number): boolean {
    if (
      this.disposed ||
      !this.started ||
      !Number.isSafeInteger(nextPayloadBytes) ||
      nextPayloadBytes < 0 ||
      nextPayloadBytes > CHUNK_SIZE
    ) {
      return false;
    }
    return (
      this.legacy ||
      this.sentBytes - this.acknowledgedBytes + nextPayloadBytes <= this.adaptive.windowBytes
    );
  }

  subscribe(listener: () => void): () => void {
    if (!this.disposed) this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Record only after RTCDataChannel.send accepted the bytes successfully. */
  noteSent(bytes: number): void {
    if (!this.disposed && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= CHUNK_SIZE) {
      const previousOutstanding = this.sentBytes - this.acknowledgedBytes;
      this.sentBytes += bytes;
      this.adaptive.sent(this.sentBytes, bytes, previousOutstanding);
    }
  }

  /** Called after binary decoding, even when the app will discard stale bytes. */
  noteReceived(bytes: number): void {
    if (this.disposed || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > CHUNK_SIZE) return;
    this.receivedBytes += bytes;
    if (!this.started || this.remoteNonce === null) return;
    if (this.receivedBytes - this.reportedBytes >= RECEIPT_BYTES) this.flushReceipt();
    else if (this.receiptTimer === null) {
      // eslint-disable-next-line no-restricted-globals -- one bounded receipt flush per exact transport, disposed with its channels
      this.receiptTimer = setTimeout(() => {
        this.receiptTimer = null;
        this.flushReceipt();
      }, RECEIPT_DELAY_MS);
    }
  }

  /** Consume reserved frames on either lane, but trust only the control lane. */
  handleControl(payload: unknown, fromControlChannel: boolean): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const frame = payload as Record<string, unknown>;
    if (frame.type !== FRAME_TYPE) return false;
    if (this.disposed || !fromControlChannel) return true;
    if (
      frame.version !== VERSION ||
      typeof frame.nonce !== 'string' ||
      !NONCE_RE.test(frame.nonce)
    ) {
      return true;
    }
    if (frame.kind === 'hello') {
      if (Object.keys(frame).length !== 4 || this.remoteNonce !== null) return true;
      this.remoteNonce = frame.nonce;
      this.legacy = false;
      if (this.canAdapt()) this.adaptive.activate();
      if (this.graceTimer !== null) clearTimeout(this.graceTimer);
      this.graceTimer = null;
      // Remote admission may finish first. Local start() sends the pending reply.
      if (this.started) this.flushReceipt(true);
      this.notify();
      return true;
    }
    if (
      frame.kind !== 'receipt' ||
      Object.keys(frame).length !== 5 ||
      this.remoteNonce === null ||
      frame.nonce !== this.nonce ||
      !Number.isSafeInteger(frame.receivedBytes) ||
      (frame.receivedBytes as number) <= this.acknowledgedBytes ||
      (frame.receivedBytes as number) > this.sentBytes
    ) {
      return true;
    }
    const previousAcknowledged = this.acknowledgedBytes;
    this.acknowledgedBytes = frame.receivedBytes as number;
    this.adaptive.receipt(previousAcknowledged, this.acknowledgedBytes);
    this.notify();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.adaptive.dispose();
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    if (this.receiptTimer !== null) clearTimeout(this.receiptTimer);
    this.graceTimer = null;
    this.receiptTimer = null;
    this.notify();
    this.listeners.clear();
  }

  private flushReceipt(force = false): void {
    if (this.receiptTimer !== null) clearTimeout(this.receiptTimer);
    this.receiptTimer = null;
    if (
      this.disposed ||
      !this.started ||
      this.remoteNonce === null ||
      (!force && this.receivedBytes === this.reportedBytes)
    ) {
      return;
    }
    if (
      this.send({
        type: FRAME_TYPE,
        version: VERSION,
        kind: 'receipt',
        nonce: this.remoteNonce,
        receivedBytes: this.receivedBytes,
      })
    ) {
      this.reportedBytes = this.receivedBytes;
    }
  }

  private send(frame: ControlFrame): boolean {
    try {
      this.sendControl(frame);
      return true;
    } catch {
      // Once a hello/receipt is lost locally there may be no more bytes to
      // trigger another receipt. Retire this connection rather than strand
      // every future file attempt behind its lifetime credit counter.
      this.dispose();
      this.onControlFailure?.();
      return false;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

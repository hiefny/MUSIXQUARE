import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import type { TransportBulkFlowControl } from './types.ts';

const FRAME_TYPE = 'mxqr-bulk-flow';
const VERSION = 1;
const WINDOW_BYTES = 128 * 1024;
const RECEIPT_BYTES = 64 * 1024;
const RECEIPT_DELAY_MS = 20;
const LEGACY_GRACE_MS = 1000;
const NONCE_RE = /^[a-f0-9]{32}$/u;

// Conservative probe budgets are admission policy, not network guarantees.
const ADAPTIVE_STEP_BYTES = 64 * 1024;
const ADAPTIVE_MAX_BYTES = 192 * 1024;
const ADAPTIVE_SAMPLE_MS = 2000;
const ADAPTIVE_MIN_SAMPLES = 8;
const ADAPTIVE_MIN_GAIN = 1.2;
const ADAPTIVE_AGE_BUDGET_MS = 100;
const ADAPTIVE_MIN_RECEIPT_GAP_MS = 10;
const ADAPTIVE_MAX_RECEIPT_GAP_MS = 500;
const ADAPTIVE_ADDED_DELAY_MS = 250;
const ADAPTIVE_IDLE_MS = 250;
const ADAPTIVE_DEADLINE_MS = 8000;
const ADAPTIVE_COOLDOWN_MS = 30_000;
const ADAPTIVE_BOUNDARIES = 8;

type AdaptivePhase = 'baseline' | 'probe-warmup' | 'probe' | 'accepted' | 'cooldown';
type SentBoundary = { end: number; bytes: number; at: number; epoch: number };
type Observation = {
  firstAt: number;
  lastAt: number;
  count: number;
  ageSum: number;
};
type Reference = { goodputBytesPerSecond: number; ackAgeMs: number };

/** Sender-only policy; receipt age includes transport/batching/return delay. */
class AdaptiveCreditController {
  windowBytes = WINDOW_BYTES;
  phase: AdaptivePhase = 'baseline';
  epoch = 0;
  cooldownUntilMs = 0;
  lastDecision = 'initial';
  private active = false;
  private boundaries: SentBoundary[] = [];
  private observation: Observation | null = null;
  private reference: Reference | null = null;
  private baseline: Reference | null = null;
  private previousBlock: Reference | null = null;
  private conservativeRate: number | null = null;
  private lastEligibleReceiptAt: number | null = null;
  private completedBlocks = 0;
  private warmupThrough = 0;
  private lastReceiptAt: number | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly now: () => number) {}

  get diagnostics() {
    const sample = this.observation;
    return {
      windowBytes: this.windowBytes,
      phase: this.phase,
      epoch: this.epoch,
      sampleCount: sample?.count ?? 0,
      goodputBytesPerSecond: sample ? this.statistics(sample).goodputBytesPerSecond : null,
      ackAgeMs: sample ? this.statistics(sample).ackAgeMs : null,
      cooldownUntilMs: this.cooldownUntilMs,
      lastDecision: this.lastDecision,
      trackedBoundaries: this.boundaries.length,
      conservativeRateBytesPerSecond: this.conservativeRate,
      completedBlocks: this.completedBlocks,
      previousBlock: this.previousBlock ? { ...this.previousBlock } : null,
      warmupThroughBytes: this.warmupThrough,
      reference: this.reference ? { ...this.reference } : null,
    } as const;
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.resetBaseline('negotiated');
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.resetBaseline('control-isolation-inactive');
    // Lifetime debt belongs to BulkFlowControl. Only learning history expires.
    this.boundaries = [];
    this.lastReceiptAt = null;
  }

  sent(end: number, bytes: number, previousOutstanding: number): void {
    if (!this.active) return;
    const now = this.now();
    if (this.phase === 'cooldown' && now >= this.cooldownUntilMs) {
      this.resetBaseline('cooldown-complete');
    }
    if (
      previousOutstanding === 0 &&
      this.lastReceiptAt !== null &&
      now - this.lastReceiptAt > ADAPTIVE_IDLE_MS
    ) {
      this.inconclusive('producer-idle');
    }
    if (bytes !== CHUNK_SIZE) this.inconclusive('partial-tail');
    // Legacy history is never kept. A late hello can therefore have untracked
    // old debt; its receipt releases credit but cannot become a timing sample.
    this.boundaries.push({ end, bytes, at: now, epoch: this.epoch });
    if (this.boundaries.length > ADAPTIVE_BOUNDARIES) this.boundaries.shift();
  }

  receipt(previous: number, end: number, sentBytes: number): void {
    if (!this.active) return;
    const now = this.now();
    const boundary = this.boundaries.find((entry) => entry.end === end);
    this.boundaries = this.boundaries.filter((entry) => entry.end > end);
    this.lastReceiptAt = now;
    if (this.phase === 'cooldown') return;
    if (!boundary || end - previous !== CHUNK_SIZE || boundary.bytes !== CHUNK_SIZE) {
      this.inconclusive('ambiguous-receipt');
      return;
    }
    if (boundary.epoch !== this.epoch) return;
    if (this.phase === 'probe-warmup') {
      if (end <= this.warmupThrough) return;
      this.phase = 'probe';
    }
    const age = now - boundary.at;
    if (!Number.isFinite(age) || age < 0) {
      this.inconclusive('invalid-monotonic-time');
      return;
    }
    if (
      this.windowBytes > WINDOW_BYTES &&
      this.reference &&
      age > this.reference.ackAgeMs + ADAPTIVE_AGE_BUDGET_MS
    ) {
      this.retire('ack-age-increase');
      return;
    }
    const previousEligibleAt = this.lastEligibleReceiptAt;
    if (previousEligibleAt !== null && now - previousEligibleAt < ADAPTIVE_MIN_RECEIPT_GAP_MS) {
      this.inconclusive('compressed-receipts');
      return;
    }
    if (previousEligibleAt !== null && now - previousEligibleAt > ADAPTIVE_MAX_RECEIPT_GAP_MS) {
      this.inconclusive('ambiguous-receipt-gap');
      return;
    }
    this.lastEligibleReceiptAt = now;
    const sample = this.observation;
    if (!sample) {
      this.observation = { firstAt: now, lastAt: now, count: 1, ageSum: age };
      return;
    }
    sample.lastAt = now;
    sample.count += 1;
    sample.ageSum += age;
    if (sample.count < ADAPTIVE_MIN_SAMPLES || now - sample.firstAt < ADAPTIVE_SAMPLE_MS) return;
    const measured = this.statistics(sample);
    this.completedBlocks += 1;
    this.conservativeRate = this.previousBlock
      ? Math.min(this.previousBlock.goodputBytesPerSecond, measured.goodputBytesPerSecond)
      : null;
    this.previousBlock = measured;
    if (this.phase === 'baseline') {
      if (this.canGrowTo(WINDOW_BYTES + ADAPTIVE_STEP_BYTES)) {
        this.baseline = measured;
        this.probe(WINDOW_BYTES + ADAPTIVE_STEP_BYTES, measured, sentBytes);
      } else {
        this.lastDecision = 'baseline-rate-gate';
        this.observation = null;
      }
      return;
    }
    const reference = this.phase === 'accepted' ? this.baseline : this.reference;
    if (
      !reference ||
      measured.goodputBytesPerSecond < reference.goodputBytesPerSecond * ADAPTIVE_MIN_GAIN
    ) {
      this.retire('insufficient-goodput-gain');
      return;
    }
    if (measured.ackAgeMs > reference.ackAgeMs + ADAPTIVE_AGE_BUDGET_MS) {
      this.retire('ack-age-increase');
      return;
    }
    if (
      this.windowBytes < ADAPTIVE_MAX_BYTES &&
      this.canGrowTo(this.windowBytes + ADAPTIVE_STEP_BYTES)
    ) {
      this.probe(this.windowBytes + ADAPTIVE_STEP_BYTES, measured, sentBytes);
      return;
    }
    this.phase = 'accepted';
    this.lastDecision = `accepted-${this.windowBytes / 1024}`;
    this.observation = null;
    // A sustained connection must keep demonstrating useful throughput. This
    // is one phase watchdog, never a per-chunk timer or an ACK polling request.
    this.armDeadline();
  }

  dispose(): void {
    this.active = false;
    this.clearDeadline();
    this.boundaries = [];
    this.observation = null;
    this.previousBlock = null;
    this.conservativeRate = null;
    this.lastEligibleReceiptAt = null;
  }

  private canGrowTo(windowBytes: number): boolean {
    return (
      this.conservativeRate !== null &&
      this.conservativeRate > 0 &&
      ((windowBytes - WINDOW_BYTES) * 1000) / this.conservativeRate <= ADAPTIVE_ADDED_DELAY_MS
    );
  }

  private statistics(sample: Observation): Reference {
    const elapsed = sample.lastAt - sample.firstAt;
    return {
      goodputBytesPerSecond: elapsed > 0 ? ((sample.count - 1) * CHUNK_SIZE * 1000) / elapsed : 0,
      ackAgeMs: sample.ageSum / sample.count,
    };
  }

  private probe(windowBytes: number, reference: Reference, sentBytes: number): void {
    this.windowBytes = windowBytes;
    this.phase = 'probe-warmup';
    this.epoch += 1;
    this.reference = reference;
    this.observation = null;
    this.previousBlock = null;
    this.conservativeRate = null;
    this.lastEligibleReceiptAt = null;
    // Existing epoch debt and a complete first flight at the new size cannot
    // be counted as evidence of improved delivery under the new target.
    this.warmupThrough = sentBytes + windowBytes;
    this.lastDecision = `probe-${windowBytes / 1024}`;
    this.armDeadline();
  }

  private inconclusive(reason: string): void {
    if (this.windowBytes > WINDOW_BYTES) this.retire(reason);
    else if (this.phase !== 'cooldown') this.resetBaseline(reason);
  }

  private resetBaseline(reason: string): void {
    this.clearDeadline();
    this.windowBytes = WINDOW_BYTES;
    this.phase = this.now() < this.cooldownUntilMs ? 'cooldown' : 'baseline';
    this.epoch += 1;
    this.reference = null;
    this.baseline = null;
    this.observation = null;
    this.previousBlock = null;
    this.conservativeRate = null;
    this.lastEligibleReceiptAt = null;
    this.lastDecision = reason;
  }

  private retire(reason: string): void {
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, this.now() + ADAPTIVE_COOLDOWN_MS);
    this.resetBaseline(reason);
  }

  private armDeadline(): void {
    this.clearDeadline();
    // eslint-disable-next-line no-restricted-globals -- this exact connection owns one bounded phase watchdog
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      if (this.active) this.retire('phase-deadline');
    }, ADAPTIVE_DEADLINE_MS);
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
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
    this.adaptive.receipt(previousAcknowledged, this.acknowledgedBytes, this.sentBytes);
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

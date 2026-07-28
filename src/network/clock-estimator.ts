/**
 * Monotonic host-clock estimation for frame-accurate rendezvous playback.
 *
 * All timestamps in this module are DOMHighResTimeStamp-compatible
 * milliseconds. Wall-clock time is deliberately excluded: a system clock
 * correction must never move an already armed audio rendezvous.
 */

export type MonotonicNow = () => number;

export interface ClockCalibrationThresholds {
  minimumSamples: number;
  maxAgeMs: number;
  maxMinRttMs: number;
  maxRttP95Ms: number;
  maxOffsetSpreadMs: number;
}

export interface ClockEstimatorOptions {
  now?: MonotonicNow;
  isHostClock?: boolean;
  maxSamples?: number;
  maxSampleAgeMs?: number;
  maxAcceptedRttMs?: number;
  maxExchangeDurationMs?: number;
  offsetOutlierThresholdMs?: number;
  calibration?: Partial<ClockCalibrationThresholds>;
}

interface ClockSample {
  offsetMs: number;
  rttMs: number;
  capturedAtMs: number;
}

export interface ClockQuality {
  calibrated: boolean;
  offsetMs: number;
  minRttMs: number;
  rttP95Ms: number;
  offsetSpreadMs: number;
  sampleCount: number;
  ageMs: number;
}

export type ClockSampleRejectionReason =
  | 'non-finite-timestamp'
  | 'negative-timestamp'
  | 'local-clock-reversed'
  | 'host-clock-reversed'
  | 'exchange-too-long'
  | 'invalid-rtt'
  | 'rtt-too-high'
  | 'offset-outlier'
  | 'quality-regression';

export type ClockSampleResult =
  | {
      accepted: true;
      rttMs: number;
      offsetMs: number;
      quality: ClockQuality;
    }
  | {
      accepted: false;
      reason: ClockSampleRejectionReason;
      quality: ClockQuality;
    };

export const DEFAULT_CLOCK_CALIBRATION_THRESHOLDS: Readonly<ClockCalibrationThresholds> = {
  minimumSamples: 5,
  maxAgeMs: 3_000,
  maxMinRttMs: 250,
  maxRttP95Ms: 1_500,
  maxOffsetSpreadMs: 8,
};

const DEFAULT_MAX_SAMPLES = 60;
const DEFAULT_MAX_SAMPLE_AGE_MS = 120_000;
const DEFAULT_MAX_ACCEPTED_RTT_MS = 10_000;
const DEFAULT_MAX_EXCHANGE_DURATION_MS = 15_000;
const DEFAULT_OFFSET_OUTLIER_THRESHOLD_MS = 2_000;
const BEST_SAMPLE_COUNT = 5;

export const MIN_RENDEZVOUS_LEAD_MS = 450;
export const MAX_RENDEZVOUS_LEAD_MS = 2_500;
export const RENDEZVOUS_SAFETY_MARGIN_MS = 200;

export function monotonicNow(): number {
  return performance.now();
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!finiteNonNegative(value)) {
    throw new RangeError(`${label} must be a finite, non-negative number`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Nearest-rank percentile, intentionally conservative for small samples. */
function percentile95(values: readonly number[]): number {
  if (values.length === 0) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? Infinity;
}

function emptyQuality(): ClockQuality {
  return {
    calibrated: false,
    offsetMs: 0,
    minRttMs: Infinity,
    rttP95Ms: Infinity,
    offsetSpreadMs: Infinity,
    sampleCount: 0,
    ageMs: Infinity,
  };
}

/**
 * Four-timestamp NTP estimator.
 *
 * t0: guest sends, t1: host receives, t2: host sends, t3: guest receives.
 * Offset is host minus local. The median offset from the five lowest-RTT
 * samples rejects asymmetric queueing without trusting a single lucky packet.
 */
export class ClockEstimator {
  private readonly now: MonotonicNow;
  private readonly maxSamples: number;
  private readonly maxSampleAgeMs: number;
  private readonly maxAcceptedRttMs: number;
  private readonly maxExchangeDurationMs: number;
  private readonly offsetOutlierThresholdMs: number;
  private readonly calibration: ClockCalibrationThresholds;
  private samples: ClockSample[] = [];
  private hostClock: boolean;
  private lastObservedNowMs: number | null = null;

  constructor(options: ClockEstimatorOptions = {}) {
    this.now = options.now ?? monotonicNow;
    this.maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
    this.maxSampleAgeMs = options.maxSampleAgeMs ?? DEFAULT_MAX_SAMPLE_AGE_MS;
    this.maxAcceptedRttMs = options.maxAcceptedRttMs ?? DEFAULT_MAX_ACCEPTED_RTT_MS;
    this.maxExchangeDurationMs = options.maxExchangeDurationMs ?? DEFAULT_MAX_EXCHANGE_DURATION_MS;
    this.offsetOutlierThresholdMs =
      options.offsetOutlierThresholdMs ?? DEFAULT_OFFSET_OUTLIER_THRESHOLD_MS;
    this.calibration = {
      ...DEFAULT_CLOCK_CALIBRATION_THRESHOLDS,
      ...options.calibration,
    };
    this.hostClock = options.isHostClock ?? false;

    assertPositiveInteger(this.maxSamples, 'maxSamples');
    assertFiniteNonNegative(this.maxSampleAgeMs, 'maxSampleAgeMs');
    assertFiniteNonNegative(this.maxAcceptedRttMs, 'maxAcceptedRttMs');
    assertFiniteNonNegative(this.maxExchangeDurationMs, 'maxExchangeDurationMs');
    assertFiniteNonNegative(this.offsetOutlierThresholdMs, 'offsetOutlierThresholdMs');
    assertPositiveInteger(this.calibration.minimumSamples, 'calibration.minimumSamples');
    assertFiniteNonNegative(this.calibration.maxAgeMs, 'calibration.maxAgeMs');
    assertFiniteNonNegative(this.calibration.maxMinRttMs, 'calibration.maxMinRttMs');
    assertFiniteNonNegative(this.calibration.maxRttP95Ms, 'calibration.maxRttP95Ms');
    assertFiniteNonNegative(this.calibration.maxOffsetSpreadMs, 'calibration.maxOffsetSpreadMs');
  }

  addNtpSample(t0: number, t1: number, t2: number, t3: number): ClockSampleResult {
    const rejection = this.validateExchange(t0, t1, t2, t3);
    if (rejection) return this.rejected(rejection);

    const localElapsedMs = t3 - t0;
    const hostProcessingMs = t2 - t1;
    const rttMs = localElapsedMs - hostProcessingMs;
    const offsetMs = (t1 - t0 + (t2 - t3)) / 2;

    if (!Number.isFinite(rttMs) || rttMs < 0) return this.rejected('invalid-rtt');
    if (rttMs > this.maxAcceptedRttMs) return this.rejected('rtt-too-high');
    if (!Number.isFinite(offsetMs)) return this.rejected('non-finite-timestamp');

    const capturedAtMs = this.readNow();
    this.prune(capturedAtMs);

    if (this.isOffsetOutlier(offsetMs)) return this.rejected('offset-outlier', capturedAtMs);

    const qualityBefore = this.qualityAt(capturedAtMs);
    if (
      qualityBefore.calibrated &&
      (rttMs > this.calibration.maxRttP95Ms ||
        Math.abs(offsetMs - qualityBefore.offsetMs) > this.calibration.maxOffsetSpreadMs)
    ) {
      return this.rejected('quality-regression', capturedAtMs);
    }

    const previousSamples = this.samples;
    this.samples = [...previousSamples, { offsetMs, rttMs, capturedAtMs }];
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(this.samples.length - this.maxSamples);
    }
    const quality = this.qualityAt(capturedAtMs);

    // Once a clock is authoritative, one maintenance packet must not create a
    // transient authority gap. Evaluate the candidate transactionally and
    // keep the last calibrated cohort until a compatible sample can renew it.
    // Rejected candidates do not refresh age, so sustained drift/noise still
    // expires the lease and forces a fresh bounded calibration.
    if (qualityBefore.calibrated && !quality.calibrated) {
      this.samples = previousSamples;
      return this.rejected('quality-regression', capturedAtMs);
    }

    return {
      accepted: true,
      rttMs,
      offsetMs,
      quality,
    };
  }

  quality(): ClockQuality {
    return this.qualityAt(this.readNow());
  }

  hostNow(): number {
    const observedNowMs = this.readNow();
    if (this.hostClock) return observedNowMs;
    return observedNowMs + this.qualityAt(observedNowMs).offsetMs;
  }

  /** Build quality from an already captured local monotonic observation. */
  qualityAtLocalTime(localPerformanceTimeMs: number): ClockQuality {
    return this.qualityAt(this.observeNow(localPerformanceTimeMs));
  }

  /** Map one already captured local observation into the host clock domain. */
  hostNowAtLocalTime(localPerformanceTimeMs: number): number {
    const observedNowMs = this.observeNow(localPerformanceTimeMs);
    if (this.hostClock) return observedNowMs;
    return observedNowMs + this.qualityAt(observedNowMs).offsetMs;
  }

  localToHost(localPerformanceTimeMs: number): number {
    assertFiniteNonNegative(localPerformanceTimeMs, 'localPerformanceTimeMs');
    if (this.hostClock) return localPerformanceTimeMs;
    return localPerformanceTimeMs + this.quality().offsetMs;
  }

  hostToLocal(hostPerformanceTimeMs: number): number {
    assertFiniteNonNegative(hostPerformanceTimeMs, 'hostPerformanceTimeMs');
    if (this.hostClock) return hostPerformanceTimeMs;
    return hostPerformanceTimeMs - this.quality().offsetMs;
  }

  isHostClock(): boolean {
    return this.hostClock;
  }

  /** Role changes invalidate every sample collected under the previous role. */
  setHostClock(active: boolean): void {
    if (this.hostClock === active) return;
    this.hostClock = active;
    this.reset();
  }

  /** A sleep/wake boundary invalidates RTT and offset freshness assumptions. */
  handleWake(): void {
    this.reset();
  }

  /** Clear calibration while preserving whether this device is the host. */
  reset(): void {
    this.samples = [];
    this.lastObservedNowMs = null;
  }

  /** Full lifecycle reset for session teardown. */
  resetState(): void {
    this.hostClock = false;
    this.reset();
  }

  private rejected(reason: ClockSampleRejectionReason, nowMs?: number): ClockSampleResult {
    return {
      accepted: false,
      reason,
      quality: nowMs === undefined ? this.quality() : this.qualityAt(nowMs),
    };
  }

  private validateExchange(
    t0: number,
    t1: number,
    t2: number,
    t3: number,
  ): ClockSampleRejectionReason | null {
    const timestamps = [t0, t1, t2, t3];
    if (!timestamps.every(Number.isFinite)) return 'non-finite-timestamp';
    if (timestamps.some((timestamp) => timestamp < 0)) return 'negative-timestamp';
    if (t3 < t0) return 'local-clock-reversed';
    if (t2 < t1) return 'host-clock-reversed';
    if (t3 - t0 > this.maxExchangeDurationMs || t2 - t1 > this.maxExchangeDurationMs) {
      return 'exchange-too-long';
    }
    return null;
  }

  private isOffsetOutlier(candidateOffsetMs: number): boolean {
    if (this.samples.length < 3) return false;
    const establishedOffsetMs = median(this.bestSamples().map((sample) => sample.offsetMs));
    return Math.abs(candidateOffsetMs - establishedOffsetMs) > this.offsetOutlierThresholdMs;
  }

  private bestSamples(): ClockSample[] {
    return [...this.samples]
      .sort((a, b) => a.rttMs - b.rttMs)
      .slice(0, Math.min(BEST_SAMPLE_COUNT, this.samples.length));
  }

  private qualityAt(nowMs: number): ClockQuality {
    if (this.hostClock) {
      return {
        calibrated: true,
        offsetMs: 0,
        minRttMs: 0,
        rttP95Ms: 0,
        offsetSpreadMs: 0,
        sampleCount: 0,
        ageMs: 0,
      };
    }

    this.prune(nowMs);
    if (this.samples.length === 0) return emptyQuality();

    const best = this.bestSamples();
    const offsets = best.map((sample) => sample.offsetMs);
    const offsetMs = median(offsets);
    const minRttMs = Math.min(...this.samples.map((sample) => sample.rttMs));
    const rttP95Ms = percentile95(this.samples.map((sample) => sample.rttMs));
    const offsetSpreadMs = Math.max(...offsets) - Math.min(...offsets);
    const newestSample = this.samples[this.samples.length - 1];
    const ageMs = Math.max(0, nowMs - (newestSample?.capturedAtMs ?? nowMs));
    const sampleCount = this.samples.length;
    const calibrated =
      sampleCount >= this.calibration.minimumSamples &&
      ageMs <= this.calibration.maxAgeMs &&
      minRttMs <= this.calibration.maxMinRttMs &&
      rttP95Ms <= this.calibration.maxRttP95Ms &&
      offsetSpreadMs <= this.calibration.maxOffsetSpreadMs;

    return {
      calibrated,
      offsetMs,
      minRttMs,
      rttP95Ms,
      offsetSpreadMs,
      sampleCount,
      ageMs,
    };
  }

  private prune(nowMs: number): void {
    this.samples = this.samples.filter(
      (sample) => nowMs - sample.capturedAtMs <= this.maxSampleAgeMs,
    );
  }

  private readNow(): number {
    return this.observeNow(this.now());
  }

  private observeNow(nowMs: number): number {
    assertFiniteNonNegative(nowMs, 'monotonic now');

    // performance.now() must not move backwards. If a platform violates that
    // invariant across a lifecycle transition, stale samples are unsafe.
    if (this.lastObservedNowMs !== null && nowMs < this.lastObservedNowMs) {
      this.samples = [];
    }
    this.lastObservedNowMs = nowMs;
    return nowMs;
  }
}

export interface AudioContextTimingSource {
  readonly currentTime: number;
  getOutputTimestamp?: () => AudioTimestamp;
}

export interface ContextTimeMapping {
  contextTime: number;
  method: 'output-timestamp' | 'current-time-fallback';
}

export interface ContextTimeMappingOptions {
  now?: MonotonicNow;
  maxOutputTimestampAgeMs?: number;
  maxContextTimeDeltaSeconds?: number;
}

const DEFAULT_MAX_OUTPUT_TIMESTAMP_AGE_MS = 1_000;
const DEFAULT_MAX_CONTEXT_TIME_DELTA_SECONDS = 5;
const MAX_OUTPUT_TIMESTAMP_FUTURE_SKEW_MS = 100;

/**
 * Convert a local performance timestamp to the AudioContext timeline.
 *
 * getOutputTimestamp() is preferred because it maps the rendered audio clock,
 * but zeroed, stale, future, or internally inconsistent browser results are
 * discarded. The fallback midpoint-samples performance.now() around
 * currentTime to minimize main-thread read skew.
 */
export function mapPerformanceTimeToContext(
  context: AudioContextTimingSource,
  localPerformanceTimeMs: number,
  options: ContextTimeMappingOptions = {},
): ContextTimeMapping {
  assertFiniteNonNegative(localPerformanceTimeMs, 'localPerformanceTimeMs');
  const now = options.now ?? monotonicNow;
  const maxTimestampAgeMs = options.maxOutputTimestampAgeMs ?? DEFAULT_MAX_OUTPUT_TIMESTAMP_AGE_MS;
  const maxContextDeltaSeconds =
    options.maxContextTimeDeltaSeconds ?? DEFAULT_MAX_CONTEXT_TIME_DELTA_SECONDS;
  assertFiniteNonNegative(maxTimestampAgeMs, 'maxOutputTimestampAgeMs');
  assertFiniteNonNegative(maxContextDeltaSeconds, 'maxContextTimeDeltaSeconds');

  const currentTime = context.currentTime;
  assertFiniteNonNegative(currentTime, 'context.currentTime');

  if (typeof context.getOutputTimestamp === 'function') {
    try {
      const timestamp = context.getOutputTimestamp();
      const observedAtMs = now();
      assertFiniteNonNegative(observedAtMs, 'monotonic now');
      const timestampContextTime = timestamp.contextTime;
      const timestampPerformanceTime = timestamp.performanceTime;
      const timestampAgeMs = observedAtMs - (timestampPerformanceTime ?? Number.NaN);
      const contextDeltaSeconds = currentTime - (timestampContextTime ?? Number.NaN);
      const valid =
        typeof timestampContextTime === 'number' &&
        typeof timestampPerformanceTime === 'number' &&
        finiteNonNegative(timestampContextTime) &&
        finiteNonNegative(timestampPerformanceTime) &&
        !(timestampContextTime === 0 && timestampPerformanceTime === 0 && observedAtMs > 0) &&
        timestampAgeMs <= maxTimestampAgeMs &&
        timestampAgeMs >= -MAX_OUTPUT_TIMESTAMP_FUTURE_SKEW_MS &&
        Math.abs(contextDeltaSeconds) <= maxContextDeltaSeconds;

      if (valid) {
        const mappedContextTime =
          timestampContextTime + (localPerformanceTimeMs - timestampPerformanceTime) / 1_000;
        if (Number.isFinite(mappedContextTime)) {
          return { contextTime: mappedContextTime, method: 'output-timestamp' };
        }
      }
    } catch {
      // Browser implementations may expose the method before it is usable.
    }
  }

  const beforeMs = now();
  assertFiniteNonNegative(beforeMs, 'monotonic now');
  const fallbackContextTime = context.currentTime;
  assertFiniteNonNegative(fallbackContextTime, 'context.currentTime');
  const afterMs = now();
  assertFiniteNonNegative(afterMs, 'monotonic now');
  if (afterMs < beforeMs) {
    throw new RangeError('monotonic now moved backwards while mapping AudioContext time');
  }
  const midpointMs = (beforeMs + afterMs) / 2;
  const mappedContextTime = fallbackContextTime + (localPerformanceTimeMs - midpointMs) / 1_000;
  if (!Number.isFinite(mappedContextTime)) {
    throw new RangeError('AudioContext time mapping overflowed');
  }
  return {
    contextTime: mappedContextTime,
    method: 'current-time-fallback',
  };
}

/** 2 × network p95 + arm-barrier p95 + safety, clamped for product UX. */
export function calculateRendezvousLeadMs(rttP95Ms: number, armP95Ms: number): number {
  assertFiniteNonNegative(rttP95Ms, 'rttP95Ms');
  assertFiniteNonNegative(armP95Ms, 'armP95Ms');
  const estimatedLeadMs = 2 * rttP95Ms + armP95Ms + RENDEZVOUS_SAFETY_MARGIN_MS;
  return Math.min(MAX_RENDEZVOUS_LEAD_MS, Math.max(MIN_RENDEZVOUS_LEAD_MS, estimatedLeadMs));
}

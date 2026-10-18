/**
 * MUSIXQUARE — Shared Clock (Pure State Module)
 *
 * Pure clock state module — offset calculation and getHostNow() API.
 * Timer management and handler registration handled by sync.ts.
 *
 * Guest: measures RTT via ping/pong, calculates offset to host clock.
 *        getHostNow() returns the estimated host time at any moment.
 *
 * Playback commands use host-clock timestamps:
 *   "play trackX at hostTime T" → all guests start at the same absolute moment.
 */

import { log } from '../core/log.ts';
import { recordStandardStartObservation } from '../diagnostics/standard-start-observations.ts';

// ─── Constants ────────────────────────────────────────────────────

const MAX_SAMPLES = 60;
const PING_EXPIRY_MS = 5_000;
const SAMPLE_AGE_LIMIT_MS = 120_000; // 2 minutes — balances freshness vs sample pool
// Ignore sub-100ms wall/monotonic disagreement from coarse browser clocks.
// Larger local discontinuities still require a corroborating host observation.
const LOCAL_CLOCK_PRECISION_MS = 100;
const SELECTION_COMPARISON_TOLERANCE_MS = 5;

// ─── State ────────────────────────────────────────────────────────

interface ClockSample {
  sampleId: number;
  rtt: number;
  offset: number; // hostTime - localTime, corrected for half RTT
  timestamp: number;
  monotonicTimestamp: number;
}

interface PendingPing {
  /** Original wall timestamp for diagnostics; sentAt may be rebased by a later reply. */
  originalSentAtMs: number;
  sentAt: number;
  monotonicSentAt: number;
}

interface SharedClockDiagnostics {
  isHostClock: boolean;
  calibrated: boolean;
  sampleCount: number;
  pendingPingCount: number;
  pongsReceived: number;
  bestOffsetMs: number;
  bestRttMs: number | null;
  newestSampleAgeMs: number | null;
}

let _isHostClock = false;
let _samples: ClockSample[] = [];
let _bestOffset = 0;
let _pongsReceived = 0;
const _pendingPings = new Map<number, PendingPing>();
// Diagnostic identities never leave this browser and never affect selection.
let _sampleSequence = 0;
let _clockEpoch = 0;
let _selectedSample: ClockSample | null = null;

function captureClockSelection() {
  const sample = _isHostClock ? null : _selectedSample;
  return {
    sampleId: sample?.sampleId ?? null,
    offsetMs: _isHostClock ? 0 : _bestOffset,
    rttMs: sample?.rtt ?? null,
    sampledAtMs: sample?.timestamp ?? null,
    epoch: _clockEpoch,
    isHostClock: _isHostClock,
  };
}

function recordClockSelection(previous: ReturnType<typeof captureClockSelection>, reason: string) {
  const selected = captureClockSelection();
  // Equal-RTT arrivals still replace the sample, but identical estimates add no
  // diagnostic information. Lifecycle/eviction causes remain visible.
  if (
    (reason === 'new-sample' || reason === 'equal-rtt') &&
    previous.sampleId !== null &&
    selected.offsetMs === previous.offsetMs &&
    selected.rttMs === previous.rttMs
  )
    return;
  const sameEpoch = previous.epoch === selected.epoch;
  const comparable = sameEpoch && previous.rttMs !== null && selected.rttMs !== null;
  const difference = Math.abs(selected.offsetMs - previous.offsetMs);
  const uncertainty = ((previous.rttMs ?? 0) + (selected.rttMs ?? 0)) / 2;
  const now = Date.now();
  recordStandardStartObservation('clock-selection', {
    reason,
    previousSampleId: previous.sampleId,
    selectedSampleId: selected.sampleId,
    previousEpoch: previous.epoch,
    epoch: selected.epoch,
    previousIsHostClock: previous.isHostClock,
    isHostClock: selected.isHostClock,
    previousOffsetMs: previous.offsetMs,
    selectedOffsetMs: selected.offsetMs,
    previousRttMs: previous.rttMs,
    selectedRttMs: selected.rttMs,
    // An old wall-clock timestamp cannot be aged in a newly rebased epoch.
    previousAgeMs:
      sameEpoch && previous.sampledAtMs !== null ? Math.max(0, now - previous.sampledAtMs) : null,
    selectedAgeMs: selected.sampledAtMs !== null ? Math.max(0, now - selected.sampledAtMs) : null,
    sampleCount: _samples.length,
    sameEpoch,
    comparisonToleranceMs: SELECTION_COMPARISON_TOLERANCE_MS,
    offsetDifferenceMs: comparable ? difference : null,
    intervalGapMs: comparable ? Math.max(0, difference - uncertainty) : null,
    disjointIntervals: comparable
      ? difference > uncertainty + SELECTION_COMPARISON_TOLERANCE_MS
      : null,
  });
}

function recordClockContinuity(
  ping: PendingPing,
  hostTimeMs: number,
  receivedAtMs: number,
  receivedPerformanceMs: number,
  localClockStepMs: number | null = null,
) {
  const wallElapsedMs = receivedAtMs - ping.sentAt;
  const monotonicElapsedMs = receivedPerformanceMs - ping.monotonicSentAt;
  recordStandardStartObservation('clock-continuity', {
    reason: localClockStepMs === null ? 'wall-monotonic' : 'rebase',
    epoch: _clockEpoch,
    rawSentAtMs: ping.originalSentAtMs,
    rawWallElapsedMs: receivedAtMs - ping.originalSentAtMs,
    sentAtMs: ping.sentAt,
    receivedAtMs,
    hostTimeMs,
    sentPerformanceMs: ping.monotonicSentAt,
    receivedPerformanceMs,
    wallElapsedMs,
    monotonicElapsedMs,
    localClockStepMs,
    continuityToleranceMs: LOCAL_CLOCK_PRECISION_MS,
    clockContinuitySuspect: Math.abs(wallElapsedMs - monotonicElapsedMs) > LOCAL_CLOCK_PRECISION_MS,
  });
}

// ─── Getters ──────────────────────────────────────────────────────

/**
 * Get the estimated host time right now.
 * This is the core API — all playback timing uses this.
 */
export function getHostNow(): number {
  if (_isHostClock) return Date.now();
  if (_samples.length === 0)
    log.warn('[SharedClock] getHostNow called with no samples. Offset may be inaccurate');
  return Date.now() + _bestOffset;
}

/**
 * Get the current clock offset (host - local) in milliseconds.
 */
export function getClockOffset(): number {
  return _bestOffset;
}

/**
 * Check if the clock has been calibrated (at least one pong sample received).
 * Host is always considered calibrated (it IS the clock source).
 * Used to gate hostPlayAt-based sync — without samples, getHostNow() returns
 * raw Date.now() with zero offset, making timed play inaccurate.
 */
export function isClockCalibrated(): boolean {
  return _isHostClock || _samples.length > 0;
}

/**
 * Read-only admission evidence for optional precision correction, not a new
 * clock estimate. With fixed clock offset, accurate timestamps and nonnegative
 * transit time, the midpoint's uncertainty is at most RTT/2 plus precision.
 * Age/continuity checks reject evidence spanning observable sleep or clock
 * discontinuities; they cannot prove that an unobserved remote clock is fixed.
 * Reading this never expires samples, changes the selected offset, or pings.
 */
export function getClockCorrectionQuality() {
  const selected = _selectedSample;
  const newest = _samples[_samples.length - 1];
  const wallNow = Date.now();
  const monotonicNow = performance.now();
  const selectedAgeMs = selected ? wallNow - selected.timestamp : null;
  const selectedMonotonicAgeMs = selected ? monotonicNow - selected.monotonicTimestamp : null;
  const newestSampleAgeMs = newest ? wallNow - newest.timestamp : null;
  const newestMonotonicAgeMs = newest ? monotonicNow - newest.monotonicTimestamp : null;
  const evidence = {
    epoch: _clockEpoch,
    offsetMs: _isHostClock ? 0 : _bestOffset,
    rttMs: _isHostClock ? 0 : (selected?.rtt ?? null),
    uncertaintyMs: _isHostClock
      ? SELECTION_COMPARISON_TOLERANCE_MS
      : selected
        ? selected.rtt / 2 + SELECTION_COMPARISON_TOLERANCE_MS
        : null,
    precisionMs: SELECTION_COMPARISON_TOLERANCE_MS,
    selectedAgeMs,
    selectedMonotonicAgeMs,
    newestSampleAgeMs,
    newestMonotonicAgeMs,
  };
  if (_isHostClock) return { ...evidence, eligible: true, reason: 'host-clock' };
  if (
    selectedAgeMs === null ||
    selectedMonotonicAgeMs === null ||
    newestSampleAgeMs === null ||
    newestMonotonicAgeMs === null
  )
    return { ...evidence, eligible: false, reason: 'uncalibrated' };
  const ages = [selectedAgeMs, selectedMonotonicAgeMs, newestSampleAgeMs, newestMonotonicAgeMs];
  if (
    ages.some((age) => !Number.isFinite(age) || age < 0) ||
    Math.abs(selectedAgeMs - selectedMonotonicAgeMs) > LOCAL_CLOCK_PRECISION_MS ||
    Math.abs(newestSampleAgeMs - newestMonotonicAgeMs) > LOCAL_CLOCK_PRECISION_MS
  )
    return { ...evidence, eligible: false, reason: 'discontinuity' };
  if (Math.max(selectedAgeMs, selectedMonotonicAgeMs) >= SAMPLE_AGE_LIMIT_MS) {
    return { ...evidence, eligible: false, reason: 'selected-expired' };
  }
  if (Math.max(newestSampleAgeMs, newestMonotonicAgeMs) > PING_EXPIRY_MS) {
    return { ...evidence, eligible: false, reason: 'replies-stale' };
  }
  return { ...evidence, eligible: true, reason: 'fresh' };
}

/**
 * Get the best RTT in milliseconds.
 */
function getClockBestRtt(): number {
  if (_samples.length === 0) return 0;
  return Math.min(..._samples.map((s) => s.rtt));
}

/**
 * Read-only, privacy-neutral clock health used by the on-device sync flight
 * recorder. Raw samples and ping identifiers deliberately stay private.
 */
export function getSharedClockDiagnostics(nowMs = Date.now()): SharedClockDiagnostics {
  const newest = _samples.length > 0 ? _samples[_samples.length - 1] : null;
  return {
    isHostClock: _isHostClock,
    calibrated: _isHostClock || _samples.length > 0,
    sampleCount: _samples.length,
    pendingPingCount: _pendingPings.size,
    pongsReceived: _pongsReceived,
    bestOffsetMs: _bestOffset,
    bestRttMs: _samples.length > 0 ? Math.min(..._samples.map((sample) => sample.rtt)) : null,
    newestSampleAgeMs: newest ? Math.max(0, nowMs - newest.timestamp) : null,
  };
}

// ─── Setters ──────────────────────────────────────────────────────

/**
 * Set whether this peer is the host clock (host = true, guest = false).
 * Replaces startHostClock/stopHostClock.
 */
export function setIsHostClock(value: boolean): void {
  const previous = captureClockSelection();
  _isHostClock = value;
  if (previous.isHostClock !== value) {
    _clockEpoch += 1;
    recordClockSelection(previous, 'host-role');
  }
  if (value) log.info('[SharedClock] Host clock active');
}

// ─── Ping Registration ───────────────────────────────────────────

/**
 * Register a ping that was sent, storing pingId → sentAt timestamp.
 * Called by sync.ts immediately before sending SYNC_PING.
 */
export function registerPing(pingId: number): void {
  const now = Date.now();
  _pendingPings.set(pingId, {
    originalSentAtMs: now,
    sentAt: now,
    monotonicSentAt: performance.now(),
  });

  // Cleanup stale pings (>5s)
  for (const [id, ping] of _pendingPings) {
    if (now - ping.sentAt > PING_EXPIRY_MS) _pendingPings.delete(id);
  }
}

/**
 * A local clock edit changes Date.now but not the audio/monotonic timeline.
 * Corroborate that discontinuity against host time before rebasing the old
 * samples. Network queueing alone cannot satisfy the local-clock check;
 * sleep on a platform whose monotonic clock stopped fails the host check.
 * Rebase instead of discarding the established low-RTT measurements.
 */
function rebaseLocalClockStep(
  ping: PendingPing,
  hostTime: number,
  receivedAt: number,
  monotonicReceivedAt: number,
): void {
  if (_samples.length === 0) return;
  const best = _samples.reduce((a, b) => (a.rtt < b.rtt ? a : b));
  const elapsed = monotonicReceivedAt - best.monotonicTimestamp;
  const step = receivedAt - best.timestamp - elapsed;
  const monotonicRtt = monotonicReceivedAt - ping.monotonicSentAt;
  if (
    Math.abs(step) <= LOCAL_CLOCK_PRECISION_MS ||
    elapsed < 0 ||
    monotonicRtt < 0 ||
    monotonicRtt > PING_EXPIRY_MS
  ) {
    return;
  }
  const expectedHostNow = best.timestamp + best.offset + elapsed;
  const observedHostNow = hostTime + monotonicRtt / 2;
  const uncertainty = (best.rtt + monotonicRtt) / 2 + LOCAL_CLOCK_PRECISION_MS;
  if (Math.abs(observedHostNow - expectedHostNow) > uncertainty) return;
  // With a slow reply, both a local edit and a stopped monotonic clock may
  // explain the host observation. Wait for an unambiguous fresh sample.
  if (Math.abs(observedHostNow - (expectedHostNow + step)) <= uncertainty) return;

  const previous = captureClockSelection();
  for (const sample of _samples) {
    sample.timestamp += step;
    sample.offset -= step;
  }
  _bestOffset = best.offset;
  _selectedSample = best;
  // Some outstanding pings were sent before the step, others after it.
  // Their own monotonic ages place each send in the new wall-clock epoch.
  for (const pending of _pendingPings.values()) {
    pending.sentAt = receivedAt - (monotonicReceivedAt - pending.monotonicSentAt);
  }
  _clockEpoch += 1;
  recordClockContinuity(ping, hostTime, receivedAt, monotonicReceivedAt, step);
  recordClockSelection(previous, 'rebase');
}

// ─── Pong Processing (RTT/Offset Calculation) ────────────────────

/**
 * Process a SYNC_PONG response: calculate RTT and clock offset.
 * Returns { rtt, offset } or null for an unknown, expired, or invalid reply.
 *
 * Updates clock state and bounded local diagnostics; performs no transport.
 */
export function processSyncPong(
  pingId: number,
  hostTime: number,
): { rtt: number; offset: number } | null {
  const ping = _pendingPings.get(pingId);

  // Reject NaN / ±Infinity hostTime — a malicious or buggy peer sending
  // Infinity would otherwise propagate into `_bestOffset` and poison every
  // subsequent `getHostNow()` call, breaking rendezvous scheduling until a
  // clean sample displaces it. The non-finite sample has nothing to
  // self-heal because `reduce((a, b) => a.rtt < b.rtt ? a : b)` could still
  // keep picking it depending on RTT ordering.
  if (ping == null || !Number.isFinite(hostTime)) return null;

  const receivedAt = Date.now();
  const monotonicReceivedAt = performance.now();
  _pendingPings.delete(pingId);
  const wallRtt = receivedAt - ping.sentAt;
  const monotonicRtt = monotonicReceivedAt - ping.monotonicSentAt;
  // An exchange spanning a wall-clock discontinuity can also be a stale
  // reply held across sleep where performance.now stopped. Neither RTT nor
  // host freshness is reliable; let the next fresh exchange calibrate it.
  if (Math.abs(wallRtt - monotonicRtt) > LOCAL_CLOCK_PRECISION_MS) {
    recordClockContinuity(ping, hostTime, receivedAt, monotonicReceivedAt);
    return null;
  }
  rebaseLocalClockStep(ping, hostTime, receivedAt, monotonicReceivedAt);
  const rtt = wallRtt;
  // Enforce expiry on receipt too: background timer throttling can prevent
  // registerPing's cleanup from running before a very late reply arrives.
  if (rtt < 0 || rtt > PING_EXPIRY_MS) return null;
  const halfRtt = rtt / 2;

  // Offset = how far ahead host clock is from our clock
  // hostTime was sampled at (pingSentAt + halfRtt) in our time
  const offset = hostTime - (ping.sentAt + halfRtt);

  // Date.now() step detection (NTP correction on network change, mobile
  // sleep/wake, manual time adjustment). After a step, every existing
  // sample's offset references a different epoch — the min-RTT picker
  // can't self-heal because all old samples agree on the now-wrong value.
  // Each midpoint estimate has uncertainty of half its RTT. Queueing a ping
  // or pong behind file traffic can move the estimate by seconds without a
  // clock step. Require a jump beyond BOTH samples' uncertainty before
  // throwing away the established low-RTT clock; otherwise that single slow
  // reply can manufacture a hard playback correction on an aligned guest.
  // Length gate avoids false-flush during initial calibration where the
  // first samples legitimately revise the offset.
  const STEP_THRESHOLD_MS = 2_000;
  const offsetUncertaintyMs = halfRtt + getClockBestRtt() / 2;
  const previous = captureClockSelection();
  let selectionReason = 'new-sample';
  if (
    _samples.length >= 3 &&
    Math.abs(offset - _bestOffset) > STEP_THRESHOLD_MS + offsetUncertaintyMs
  ) {
    log.warn(
      `[SharedClock] Offset jump ${(offset - _bestOffset).toFixed(0)}ms exceeds RTT uncertainty. Clock likely stepped, flushing samples`,
    );
    _samples = [];
    _clockEpoch += 1;
    selectionReason = 'clock-step';
  }

  _samples.push({
    sampleId: ++_sampleSequence,
    rtt,
    offset,
    timestamp: receivedAt,
    monotonicTimestamp: monotonicReceivedAt,
  });

  // Keep bounded by count AND age. Old samples' offsets become stale
  // because device clocks drift over time (mobile Date.now() can drift
  // tens of μs/sec — after 30min that's hundreds of ms). Using a
  // months-old minimum-RTT sample's offset causes persistent rendezvous
  // desync that grows linearly with session duration.
  const selectedExpired =
    _selectedSample !== null && receivedAt - _selectedSample.timestamp >= SAMPLE_AGE_LIMIT_MS;
  _samples = _samples.filter((s) => receivedAt - s.timestamp < SAMPLE_AGE_LIMIT_MS);
  const evicted = _samples.length > MAX_SAMPLES ? _samples.shift() : undefined;

  // Best offset = from the sample with lowest RTT (most accurate)
  const best = _samples.reduce((a, b) => (a.rtt < b.rtt ? a : b));
  _bestOffset = best.offset;
  _selectedSample = best;
  if (selectionReason !== 'clock-step') {
    selectionReason = selectedExpired
      ? 'expired'
      : evicted?.sampleId === previous.sampleId
        ? 'capacity'
        : best.rtt === previous.rttMs
          ? 'equal-rtt'
          : 'new-sample';
  }
  if (best.sampleId !== previous.sampleId || previous.epoch !== _clockEpoch) {
    recordClockSelection(previous, selectionReason);
  }

  _pongsReceived++;

  log.debug(
    `[SharedClock] Sample #${_samples.length}: RTT=${rtt}ms, offset=${offset.toFixed(1)}ms, best=${_bestOffset.toFixed(1)}ms`,
  );

  return { rtt, offset };
}

// ─── Reset ────────────────────────────────────────────────────────

/**
 * Reset all clock state. Called by sync.ts on session end / role change.
 */
function clearClockSamples(): void {
  _samples = [];
  _bestOffset = 0;
  _pongsReceived = 0;
  _pendingPings.clear();
  _selectedSample = null;
  _clockEpoch += 1;
}

export function resetClockSamples(): void {
  const previous = captureClockSelection();
  clearClockSamples();
  recordClockSelection(previous, 'reset');
}

export function resetClockState(): void {
  const previous = captureClockSelection();
  clearClockSamples();
  _isHostClock = false;
  recordClockSelection(previous, 'reset');
}

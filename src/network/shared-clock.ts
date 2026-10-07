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

// ─── Constants ────────────────────────────────────────────────────

const MAX_SAMPLES = 60;
const PING_EXPIRY_MS = 5_000;
// Ignore sub-100ms wall/monotonic disagreement from coarse browser clocks.
// Larger local discontinuities still require a corroborating host observation.
const LOCAL_CLOCK_PRECISION_MS = 100;

// ─── State ────────────────────────────────────────────────────────

interface ClockSample {
  rtt: number;
  offset: number; // hostTime - localTime, corrected for half RTT
  timestamp: number;
  monotonicTimestamp: number;
}

interface PendingPing {
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
  _isHostClock = value;
  if (value) log.info('[SharedClock] Host clock active');
}

// ─── Ping Registration ───────────────────────────────────────────

/**
 * Register a ping that was sent, storing pingId → sentAt timestamp.
 * Called by sync.ts immediately before sending SYNC_PING.
 */
export function registerPing(pingId: number): void {
  const now = Date.now();
  _pendingPings.set(pingId, { sentAt: now, monotonicSentAt: performance.now() });

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

  for (const sample of _samples) {
    sample.timestamp += step;
    sample.offset -= step;
  }
  _bestOffset = best.offset;
  // Some outstanding pings were sent before the step, others after it.
  // Their own monotonic ages place each send in the new wall-clock epoch.
  for (const pending of _pendingPings.values()) {
    pending.sentAt = receivedAt - (monotonicReceivedAt - pending.monotonicSentAt);
  }
}

// ─── Pong Processing (RTT/Offset Calculation) ────────────────────

/**
 * Process a SYNC_PONG response: calculate RTT and clock offset.
 * Returns { rtt, offset } or null for an unknown, expired, or invalid reply.
 *
 * Contains the core calculation logic — no side effects beyond
 * updating internal sample buffer and best offset.
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
  if (Math.abs(wallRtt - monotonicRtt) > LOCAL_CLOCK_PRECISION_MS) return null;
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
  if (
    _samples.length >= 3 &&
    Math.abs(offset - _bestOffset) > STEP_THRESHOLD_MS + offsetUncertaintyMs
  ) {
    log.warn(
      `[SharedClock] Offset jump ${(offset - _bestOffset).toFixed(0)}ms exceeds RTT uncertainty. Clock likely stepped, flushing samples`,
    );
    _samples = [];
  }

  _samples.push({ rtt, offset, timestamp: receivedAt, monotonicTimestamp: monotonicReceivedAt });

  // Keep bounded by count AND age. Old samples' offsets become stale
  // because device clocks drift over time (mobile Date.now() can drift
  // tens of μs/sec — after 30min that's hundreds of ms). Using a
  // months-old minimum-RTT sample's offset causes persistent rendezvous
  // desync that grows linearly with session duration.
  const AGE_LIMIT = 120_000; // 2 minutes — balances freshness vs sample pool
  _samples = _samples.filter((s) => receivedAt - s.timestamp < AGE_LIMIT);
  if (_samples.length > MAX_SAMPLES) _samples.shift();

  // Best offset = from the sample with lowest RTT (most accurate)
  const best = _samples.reduce((a, b) => (a.rtt < b.rtt ? a : b));
  _bestOffset = best.offset;

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
export function resetClockSamples(): void {
  _samples = [];
  _bestOffset = 0;
  _pongsReceived = 0;
  _pendingPings.clear();
}

export function resetClockState(): void {
  resetClockSamples();
  _isHostClock = false;
}

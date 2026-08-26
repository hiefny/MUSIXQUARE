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

// ─── State ────────────────────────────────────────────────────────

interface ClockSample {
  rtt: number;
  offset: number; // hostTime - localTime, corrected for half RTT
  timestamp: number;
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
const _pendingPings = new Map<number, number>();

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
export function getClockBestRtt(): number {
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
 * Called by sync.ts after sending CLOCK_PING.
 */
export function registerPing(pingId: number): void {
  _pendingPings.set(pingId, Date.now());

  // Cleanup stale pings (>5s)
  for (const [id, ts] of _pendingPings) {
    if (Date.now() - ts > 5000) _pendingPings.delete(id);
  }
}

// ─── Pong Processing (RTT/Offset Calculation) ────────────────────

/**
 * Process a CLOCK_PONG response: calculate RTT and clock offset.
 * Returns { rtt, offset } or null if the pingId is unknown.
 *
 * Contains the core calculation logic — no side effects beyond
 * updating internal sample buffer and best offset.
 */
export function processSyncPong(
  pingId: number,
  hostTime: number,
): { rtt: number; offset: number } | null {
  const pingSentAt = _pendingPings.get(pingId);

  // Reject NaN / ±Infinity hostTime — a malicious or buggy peer sending
  // Infinity would otherwise propagate into `_bestOffset` and poison every
  // subsequent `getHostNow()` call, breaking rendezvous scheduling until a
  // clean sample displaces it. The non-finite sample has nothing to
  // self-heal because `reduce((a, b) => a.rtt < b.rtt ? a : b)` could still
  // keep picking it depending on RTT ordering.
  if (pingSentAt == null || !Number.isFinite(hostTime)) return null;
  _pendingPings.delete(pingId);

  const receivedAt = Date.now();
  const rtt = receivedAt - pingSentAt;
  if (rtt < 0) return null; // System clock went backward
  const halfRtt = rtt / 2;

  // Offset = how far ahead host clock is from our clock
  // hostTime was sampled at (pingSentAt + halfRtt) in our time
  const offset = hostTime - (pingSentAt + halfRtt);

  // Date.now() step detection (NTP correction on network change, mobile
  // sleep/wake, manual time adjustment). After a step, every existing
  // sample's offset references a different epoch — the min-RTT picker
  // can't self-heal because all old samples agree on the now-wrong value.
  // Threshold mirrors handleSyncPong's drift threshold (sync.ts) for
  // consistency. Length gate avoids false-flush during initial calibration
  // where the first samples legitimately revise the offset.
  const STEP_THRESHOLD_MS = 2_000;
  if (_samples.length >= 3 && Math.abs(offset - _bestOffset) > STEP_THRESHOLD_MS) {
    log.warn(
      `[SharedClock] Offset jump ${(offset - _bestOffset).toFixed(0)}ms. Local clock likely stepped, flushing samples`,
    );
    _samples = [];
  }

  _samples.push({ rtt, offset, timestamp: receivedAt });

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

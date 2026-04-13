/**
 * MUSIXQUARE 3.0 — Shared Clock (Pure State Module)
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

const MAX_SAMPLES = 60;            // Keep last 60 RTT samples (~1min window)

// ─── State ────────────────────────────────────────────────────────

interface ClockSample {
  rtt: number;
  offset: number;  // hostTime - localTime (corrected for half RTT)
  timestamp: number;
}

let _isHostClock = false;
let _samples: ClockSample[] = [];
let _bestOffset = 0;           // Current best estimate of (hostTime - localTime)
let _pongsReceived = 0;
let _pendingPings = new Map<number, number>(); // pingId → sentAt

// ─── Getters ──────────────────────────────────────────────────────

/**
 * Get the estimated host time right now.
 * This is the core API — all playback timing uses this.
 */
export function getHostNow(): number {
  if (_isHostClock) return Date.now(); // Host IS the clock
  if (_samples.length === 0) log.warn('[SharedClock] getHostNow called with no samples — offset may be inaccurate');
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
  return Math.min(..._samples.map(s => s.rtt));
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

  if (pingSentAt == null || !hostTime) return null;
  _pendingPings.delete(pingId);

  const receivedAt = Date.now();
  const rtt = receivedAt - pingSentAt;
  if (rtt < 0) return null;  // System clock went backward
  const halfRtt = rtt / 2;

  // Offset = how far ahead host clock is from our clock
  // hostTime was sampled at (pingSentAt + halfRtt) in our time
  const offset = hostTime - (pingSentAt + halfRtt);

  _samples.push({ rtt, offset, timestamp: receivedAt });

  // Keep bounded by count AND age. Old samples' offsets become stale
  // because device clocks drift over time (mobile Date.now() can drift
  // tens of μs/sec — after 30min that's hundreds of ms). Using a
  // months-old minimum-RTT sample's offset causes persistent rendezvous
  // desync that grows linearly with session duration.
  const AGE_LIMIT = 120_000; // 2 minutes — balances freshness vs sample pool
  _samples = _samples.filter(s => receivedAt - s.timestamp < AGE_LIMIT);
  if (_samples.length > MAX_SAMPLES) _samples.shift();

  // Best offset = from the sample with lowest RTT (most accurate)
  const best = _samples.reduce((a, b) => a.rtt < b.rtt ? a : b);
  _bestOffset = best.offset;

  _pongsReceived++;

  log.debug(`[SharedClock] Sample #${_samples.length}: RTT=${rtt}ms, offset=${offset.toFixed(1)}ms, best=${_bestOffset.toFixed(1)}ms`);

  return { rtt, offset };
}

// ─── Reset ────────────────────────────────────────────────────────

/**
 * Reset all clock state. Called by sync.ts on session end / role change.
 */
export function resetClockState(): void {
  _samples = [];
  _bestOffset = 0;
  _pongsReceived = 0;
  _pendingPings.clear();
  _isHostClock = false;
}

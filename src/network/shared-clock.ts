/**
 * MUSIXQUARE 6.0 — Shared Clock (Pure State Module)
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

const MAX_SAMPLES = 20;            // Keep last 20 RTT samples
const WARMUP_COUNT = 5;

// ─── State ────────────────────────────────────────────────────────

interface ClockSample {
  rtt: number;
  offset: number;  // hostTime - localTime (corrected for half RTT)
  timestamp: number;
}

let _isHostClock = false;
let _samples: ClockSample[] = [];
let _bestOffset = 0;           // Current best estimate of (hostTime - localTime)
let _pingsSent = 0;
let _pendingPings = new Map<number, number>(); // pingId → sentAt

// ─── Getters ──────────────────────────────────────────────────────

/**
 * Get the estimated host time right now.
 * This is the core API — all playback timing uses this.
 */
export function getHostNow(): number {
  if (_isHostClock) return Date.now(); // Host IS the clock
  return Date.now() + _bestOffset;
}

/**
 * Get the current clock offset (host - local) in milliseconds.
 */
export function getClockOffset(): number {
  return _bestOffset;
}

/**
 * Get the number of samples collected (for UI display).
 */
export function getClockSampleCount(): number {
  return _samples.length;
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
  const halfRtt = rtt / 2;

  // Offset = how far ahead host clock is from our clock
  // hostTime was sampled at (pingSentAt + halfRtt) in our time
  const offset = hostTime - (pingSentAt + halfRtt);

  _samples.push({ rtt, offset, timestamp: receivedAt });

  // Keep bounded
  if (_samples.length > MAX_SAMPLES) _samples.shift();

  // Best offset = from the sample with lowest RTT (most accurate)
  const best = _samples.reduce((a, b) => a.rtt < b.rtt ? a : b);
  _bestOffset = best.offset;

  _pingsSent++;

  log.debug(`[SharedClock] Sample #${_samples.length}: RTT=${rtt}ms, offset=${offset.toFixed(1)}ms, best=${_bestOffset.toFixed(1)}ms`);

  return { rtt, offset };
}

// ─── Warmup Detection ─────────────────────────────────────────────

/**
 * Returns true once enough pings have been processed for stable sync.
 * sync.ts uses this to switch from fast warmup interval to normal interval.
 */
export function isWarmupDone(): boolean {
  return _pingsSent >= WARMUP_COUNT;
}

// ─── Reset ────────────────────────────────────────────────────────

/**
 * Reset all clock state. Called by sync.ts on session end / role change.
 */
export function resetClockState(): void {
  _samples = [];
  _bestOffset = 0;
  _pingsSent = 0;
  _pendingPings.clear();
  _isHostClock = false;
}

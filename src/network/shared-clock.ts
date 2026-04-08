/**
 * MUSIXQUARE 6.0 — Shared Clock
 *
 * Host clock = single source of truth for all playback timing.
 *
 * Host: periodically broadcasts its Date.now() timestamp.
 * Guest: measures RTT, calculates offset to host clock.
 *        getHostNow() returns the estimated host time at any moment.
 *
 * Playback commands use host-clock timestamps:
 *   "play trackX at hostTime T" → all guests start at the same absolute moment.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { broadcast, sendToHost } from './peer-state.ts';
import { registerHandler } from './protocol.ts';

// ─── Constants ────────────────────────────────────────────────────

const CLOCK_SYNC_INTERVAL = 3000;  // Host broadcasts every 3s
const CLOCK_PING_INTERVAL = 2000;  // Guest pings every 2s
const MAX_SAMPLES = 20;            // Keep last 20 RTT samples
const WARMUP_FAST_INTERVAL = 500;  // First 5 samples at 500ms for fast convergence
const WARMUP_COUNT = 5;

// ─── Host State ───────────────────────────────────────────────────

let _isHostClock = false;

function startHostClock(): void {
  _isHostClock = true;
  // Broadcast host timestamp periodically
  setManagedTimer('shared-clock-broadcast', () => {
    broadcast({
      type: MSG.CLOCK_SYNC,
      hostTime: Date.now(),
    } as any);
  }, CLOCK_SYNC_INTERVAL, { interval: true });

  log.info('[SharedClock] Host clock started');
}

function stopHostClock(): void {
  _isHostClock = false;
  clearManagedTimer('shared-clock-broadcast');
}

// ─── Guest State ──────────────────────────────────────────────────

interface ClockSample {
  rtt: number;
  offset: number;  // hostTime - localTime (corrected for half RTT)
  timestamp: number;
}

let _samples: ClockSample[] = [];
let _bestOffset = 0;           // Current best estimate of (hostTime - localTime)
let _pingsSent = 0;
let _pendingPings = new Map<number, number>(); // pingId → sentAt

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

// ─── Guest: Ping/Pong RTT Measurement ────────────────────────────

let _pingCounter = 0;

function sendClockPing(): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn) return;

  const pingId = ++_pingCounter;
  const sentAt = Date.now();
  _pendingPings.set(pingId, sentAt);

  sendToHost({
    type: MSG.CLOCK_PING,
    pingId,
    guestTime: sentAt,
  } as any);

  // Cleanup stale pings (>5s)
  for (const [id, ts] of _pendingPings) {
    if (Date.now() - ts > 5000) _pendingPings.delete(id);
  }
}

function handleClockPong(data: Record<string, unknown>): void {
  const pingId = data.pingId as number;
  const hostTime = data.hostTime as number;
  const sentAt = _pendingPings.get(pingId);

  if (!sentAt || !hostTime) return;
  _pendingPings.delete(pingId);

  const receivedAt = Date.now();
  const rtt = receivedAt - sentAt;
  const halfRtt = rtt / 2;

  // Offset = how far ahead host clock is from our clock
  // hostTime was sampled at (sentAt + halfRtt) in our time
  const offset = hostTime - (sentAt + halfRtt);

  _samples.push({ rtt, offset, timestamp: receivedAt });

  // Keep bounded
  if (_samples.length > MAX_SAMPLES) _samples.shift();

  // Best offset = from the sample with lowest RTT (most accurate)
  const best = _samples.reduce((a, b) => a.rtt < b.rtt ? a : b);
  _bestOffset = best.offset;

  _pingsSent++;

  // Switch from warmup (fast) to normal (slow) interval after WARMUP_COUNT
  if (_pingsSent === WARMUP_COUNT) {
    clearManagedTimer('shared-clock-ping');
    setManagedTimer('shared-clock-ping', sendClockPing, CLOCK_PING_INTERVAL, { interval: true });
    log.info(`[SharedClock] Warmup done. offset=${_bestOffset}ms, bestRTT=${best.rtt}ms`);
  }

  log.debug(`[SharedClock] Sample #${_samples.length}: RTT=${rtt}ms, offset=${offset.toFixed(1)}ms, best=${_bestOffset.toFixed(1)}ms`);
}

// ─── Host: Handle Ping → Reply Pong ──────────────────────────────

function handleClockPing(data: Record<string, unknown>, conn: any): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host responds

  if (!conn?.open) return;

  try {
    conn.send({
      type: MSG.CLOCK_PONG,
      pingId: data.pingId,
      hostTime: Date.now(),
    });
  } catch { /* noop */ }
}

// ─── Guest: Start Clock Sync ─────────────────────────────────────

function startGuestClock(): void {
  _samples = [];
  _bestOffset = 0;
  _pingsSent = 0;
  _pendingPings.clear();

  // Fast warmup: 500ms interval for first 5 samples
  sendClockPing(); // Immediate first ping
  setManagedTimer('shared-clock-ping', sendClockPing, WARMUP_FAST_INTERVAL, { interval: true });

  log.info('[SharedClock] Guest clock sync started (warmup)');
}

function stopGuestClock(): void {
  clearManagedTimer('shared-clock-ping');
  _samples = [];
  _pendingPings.clear();
}

// ─── Init ─────────────────────────────────────────────────────────

export function initSharedClock(): void {
  // Register protocol handlers
  registerHandler(MSG.CLOCK_PING, handleClockPing);
  registerHandler(MSG.CLOCK_PONG, handleClockPong);

  // Host: start clock when session is created
  bus.on('state:network.appRole', () => {
    const role = getState('network.appRole');
    if (role === 'host') {
      startHostClock();
    } else if (role === 'guest') {
      startGuestClock();
    } else {
      stopHostClock();
      stopGuestClock();
    }
  });

  // Cleanup on session end
  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      stopHostClock();
      stopGuestClock();
    }
  });

  log.info('[SharedClock] Initialized');
}

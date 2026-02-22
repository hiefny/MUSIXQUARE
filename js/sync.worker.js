// sync.worker.js - Timer & Heartbeat Background Tasks (Improved)
// - Safer message handling (won't crash on bad payloads)
// - Interval validation
// - STOP_ALL support (optional, backward-compatible)
// - Uses Map to avoid prototype edge-cases

'use strict';

/** @type {Map<string, number>} */
const timers = new Map();

function toId(v) {
  // Keep exact ids used by app.js (e.g., 'heartbeat', 'ping', 'video-sync')
  if (v === null || v === undefined) return '';
  return String(v);
}

function normalizeIntervalMs(v, fallback = 1000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  // setInterval(0) can thrash; clamp to 1ms minimum.
  return Math.max(1, Math.floor(n));
}

function startTimer(id, intervalMs) {
  if (!id) return;

  // Restart semantics: START_TIMER on the same id replaces the previous one.
  stopTimer(id);

  const ms = normalizeIntervalMs(intervalMs);
  const handle = setInterval(() => {
    // Never throw from inside the interval callback.
    try {
      self.postMessage({ type: 'TICK', id });
    } catch (_) {
      // ignore
    }
  }, ms);

  timers.set(id, handle);
}

function stopTimer(id) {
  const handle = timers.get(id);
  if (handle !== undefined) {
    clearInterval(handle);
    timers.delete(id);
  }
}

function stopAllTimers() {
  for (const [id, handle] of timers.entries()) {
    clearInterval(handle);
    timers.delete(id);
  }
}

self.onmessage = (e) => {
  const data = (e && e.data) ? e.data : {};
  const command = data.command;

  try {
    switch (command) {
      case 'START_TIMER': {
        const id = toId(data.id);
        const interval = normalizeIntervalMs(data.interval);
        startTimer(id, interval);
        break;
      }
      case 'STOP_TIMER': {
        const id = toId(data.id);
        stopTimer(id);
        break;
      }
      case 'STOP_ALL': {
        // Optional command (doesn't require app.js changes)
        stopAllTimers();
        break;
      }
      case 'INIT_INSTANCE': {
        // Kept for consistency / future use.
        // (No-op by design)
        break;
      }
      default:
        // Ignore unknown commands for forward-compat.
        break;
    }
  } catch (err) {
    // Don't crash the worker: report and continue.
    try {
      self.postMessage({
        type: 'WORKER_ERROR',
        scope: 'sync',
        command,
        error: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : undefined
      });
    } catch (_) {
      // ignore
    }
  }
};

// Global safety: surface unexpected worker errors without crashing.
self.addEventListener('error', (e) => {
  try {
    self.postMessage({
      type: 'WORKER_ERROR',
      scope: 'sync',
      command: 'WORKER_ERROR',
      error: (e && e.message) ? e.message : 'Worker error'
    });
  } catch (_) { /* ignore */ }
});

self.addEventListener('unhandledrejection', (e) => {
  try {
    const reason = e && e.reason;
    self.postMessage({
      type: 'WORKER_ERROR',
      scope: 'sync',
      command: 'UNHANDLED_REJECTION',
      error: reason && reason.message ? reason.message : String(reason)
    });
  } catch (_) { /* ignore */ }
});

self.addEventListener('messageerror', () => {
  try {
    self.postMessage({
      type: 'WORKER_ERROR',
      scope: 'sync',
      command: 'MESSAGE_ERROR',
      error: 'Message deserialization failed'
    });
  } catch (_) { /* ignore */ }
});

// Defensive: if the worker ever gets terminated/reloaded, clear timers.
self.addEventListener('close', () => {
  try { stopAllTimers(); } catch (_) { /* ignore */ }
});

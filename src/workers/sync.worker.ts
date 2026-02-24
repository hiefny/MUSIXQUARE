/**
 * MUSIXQUARE 2.0 — Sync Worker (Background Timers)
 * Ported from js/sync.worker.js
 *
 * Timer & Heartbeat background tasks with robust error handling.
 */

// self is already typed as DedicatedWorkerGlobalScope in WebWorker lib

const timers = new Map<string, ReturnType<typeof setInterval>>();

function toId(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function normalizeIntervalMs(v: unknown, fallback = 1000): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

function startTimer(id: string, intervalMs: number): void {
  if (!id) return;
  stopTimer(id);

  const ms = normalizeIntervalMs(intervalMs);
  const handle = setInterval(() => {
    try {
      self.postMessage({ type: 'TICK', id });
    } catch { /* ignore */ }
  }, ms);

  timers.set(id, handle);
}

function stopTimer(id: string): void {
  const handle = timers.get(id);
  if (handle !== undefined) {
    clearInterval(handle);
    timers.delete(id);
  }
}

function stopAllTimers(): void {
  for (const [, handle] of timers.entries()) {
    clearInterval(handle);
  }
  timers.clear();
}

self.onmessage = (e: MessageEvent) => {
  const data = (e && e.data) ? e.data : {};
  const command = data.command as string | undefined;

  try {
    switch (command) {
      case 'START_TIMER': {
        const id = toId(data.id);
        startTimer(id, data.interval as number);
        break;
      }
      case 'STOP_TIMER': {
        const id = toId(data.id);
        stopTimer(id);
        break;
      }
      case 'STOP_ALL': {
        stopAllTimers();
        break;
      }
      case 'INIT_INSTANCE': {
        // No-op by design
        break;
      }
      default:
        break;
    }
  } catch (err: unknown) {
    try {
      const e2 = err as Error;
      self.postMessage({
        type: 'WORKER_ERROR',
        scope: 'sync',
        command,
        error: e2?.message ?? String(err),
        stack: e2?.stack,
      });
    } catch { /* ignore */ }
  }
};

self.addEventListener('error', (e) => {
  try {
    self.postMessage({
      type: 'WORKER_ERROR',
      scope: 'sync',
      command: 'WORKER_ERROR',
      error: e?.message ?? 'Worker error',
    });
  } catch { /* ignore */ }
});

self.addEventListener('unhandledrejection', (e) => {
  try {
    const reason = e?.reason as Error | undefined;
    self.postMessage({
      type: 'WORKER_ERROR',
      scope: 'sync',
      command: 'UNHANDLED_REJECTION',
      error: reason?.message ?? String(reason),
    });
  } catch { /* ignore */ }
});

self.addEventListener('messageerror', () => {
  try {
    self.postMessage({
      type: 'WORKER_ERROR',
      scope: 'sync',
      command: 'MESSAGE_ERROR',
      error: 'Message deserialization failed',
    });
  } catch { /* ignore */ }
});

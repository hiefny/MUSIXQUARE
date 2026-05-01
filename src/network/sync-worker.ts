/**
 * MUSIXQUARE — Sync Worker Bridge
 *
 * Owns the lifecycle of the background sync worker (`src/workers/sync.worker.ts`)
 * and exposes a simple `startWorkerTimer` / `stopWorkerTimer` API. The worker
 * exists for one reason: setInterval in a backgrounded tab is throttled to
 * once-per-minute (or worse) on most browsers, but a dedicated worker keeps
 * ticking at the requested cadence. Guest→Host SYNC_PING needs the steady
 * cadence to keep clock skew measurements warm even with the screen locked.
 *
 * Tick events are surfaced via `bus.emit('worker:timer-tick', id)` so
 * network/sync.ts (the actual SYNC_PING sender) can stay decoupled from
 * worker plumbing.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';

let _syncWorker: Worker | null = null;

/**
 * Wire the sync worker. Called once during app bootstrap (app.ts) after
 * `new Worker(new URL('../workers/sync.worker.ts', import.meta.url), …)`.
 * `onerror` is intentionally NOT assigned here — app.ts owns it for the
 * single-owner convention.
 */
export function setSyncWorker(worker: Worker): void {
  _syncWorker = worker;
  _syncWorker.onmessage = handleSyncWorkerMessage;
}

/** Start a recurring timer in the worker. */
export function startWorkerTimer(id: string, intervalMs: number): void {
  if (!_syncWorker) {
    log.warn(`[SyncWorker] Not ready — dropping START_TIMER ${id}`);
    return;
  }
  _syncWorker.postMessage({ command: 'START_TIMER', id, interval: intervalMs });
}

/** Stop a worker-managed timer. Safe to call when not running. */
export function stopWorkerTimer(id: string): void {
  if (!_syncWorker) return;
  _syncWorker.postMessage({ command: 'STOP_TIMER', id });
}

function handleSyncWorkerMessage(e: MessageEvent): void {
  const data = e.data;
  if (!data) return;

  if (data.type === 'TICK') {
    bus.emit('worker:timer-tick', data.id);
  } else if (data.type === 'WORKER_ERROR') {
    log.warn('[SyncWorker] Error:', data.error);
  }
}

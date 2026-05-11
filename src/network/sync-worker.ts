/**
 * MUSIXQUARE - Sync Worker Bridge
 *
 * Owns the lifecycle of the background sync worker (`src/workers/sync.worker.ts`)
 * and exposes a simple `startWorkerTimer` / `stopWorkerTimer` API. The worker
 * exists for one reason: setInterval in a backgrounded tab is throttled to
 * once-per-minute (or worse) on most browsers, but a dedicated worker keeps
 * ticking at the requested cadence. Guest-to-host SYNC_PING needs the steady
 * cadence to keep clock skew measurements warm even with the screen locked.
 *
 * Tick events are surfaced via `bus.emit('worker:timer-tick', id)` so
 * network/sync.ts (the actual SYNC_PING sender) can stay decoupled from
 * worker plumbing.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';

let _syncWorker: Worker | null = null;
const _activeTimers = new Map<string, number>();
const _fallbackTimers = new Set<string>();

function fallbackTimerName(id: string): string {
  return `sync-worker-fallback:${id}`;
}

/**
 * Wire the sync worker. Called once during app bootstrap (app.ts) after
 * `new Worker(new URL('../workers/sync.worker.ts', import.meta.url), ...)`.
 * `onerror` is intentionally NOT assigned here; app.ts owns it for the
 * single-owner convention.
 */
export function setSyncWorker(worker: Worker): void {
  _syncWorker = worker;
  _syncWorker.onmessage = handleSyncWorkerMessage;

  for (const [id, intervalMs] of _activeTimers.entries()) {
    if (!postWorkerMessage({ command: 'START_TIMER', id, interval: intervalMs }, id)) break;
    stopFallbackTimer(id);
  }
}

/** Start a recurring timer in the worker, falling back to the main thread. */
export function startWorkerTimer(id: string, intervalMs: number): void {
  _activeTimers.set(id, intervalMs);
  if (!_syncWorker) {
    startFallbackTimer(id, intervalMs, 'worker not ready');
    return;
  }
  if (postWorkerMessage({ command: 'START_TIMER', id, interval: intervalMs }, id)) {
    stopFallbackTimer(id);
  }
}

/** Stop a worker-managed or fallback timer. Safe to call when not running. */
export function stopWorkerTimer(id: string): void {
  _activeTimers.delete(id);
  stopFallbackTimer(id);
  if (!_syncWorker) return;
  postWorkerMessage({ command: 'STOP_TIMER', id }, id);
}

export function handleSyncWorkerFailure(error?: unknown): void {
  const worker = _syncWorker;
  _syncWorker = null;

  try {
    if (worker && typeof worker.terminate === 'function') worker.terminate();
  } catch {
    /* ignore */
  }

  log.warn('[SyncWorker] Unavailable; falling back to main-thread timers', error);
  for (const [id, intervalMs] of _activeTimers.entries()) {
    startFallbackTimer(id, intervalMs, 'worker failed');
  }
}

function postWorkerMessage(message: Record<string, unknown>, timerId: string): boolean {
  try {
    _syncWorker?.postMessage(message);
    return !!_syncWorker;
  } catch (e) {
    log.warn(`[SyncWorker] postMessage failed for ${timerId}:`, e);
    handleSyncWorkerFailure(e);
    return false;
  }
}

function startFallbackTimer(id: string, intervalMs: number, reason: string): void {
  const name = fallbackTimerName(id);
  clearManagedTimer(name);
  _fallbackTimers.add(id);
  log.warn(`[SyncWorker] ${reason}; using main-thread fallback timer ${id}`);
  setManagedTimer(name, () => bus.emit('worker:timer-tick', id), intervalMs, { interval: true });
}

function stopFallbackTimer(id: string): void {
  clearManagedTimer(fallbackTimerName(id));
  _fallbackTimers.delete(id);
}

export function isSyncWorkerFallbackActive(id?: string): boolean {
  return id === undefined ? _fallbackTimers.size > 0 : _fallbackTimers.has(id);
}

function handleSyncWorkerMessage(e: MessageEvent): void {
  const data = e.data;
  if (!data) return;

  if (data.type === 'TICK') {
    bus.emit('worker:timer-tick', data.id);
  } else if (data.type === 'WORKER_ERROR') {
    log.warn('[SyncWorker] Error:', data.error);
    handleSyncWorkerFailure(data.error);
  }
}

export function __resetSyncWorkerForTests(): void {
  _syncWorker = null;
  _activeTimers.clear();
  for (const id of Array.from(_fallbackTimers)) {
    stopFallbackTimer(id);
  }
}

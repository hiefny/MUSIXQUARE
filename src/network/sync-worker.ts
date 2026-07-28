/**
 * Bridges named recurring timers to a dedicated worker with a main-thread
 * fallback. A worker is usually throttled less aggressively than window
 * timers, but browsers may still suspend it in the background or under screen
 * lock; consumers must treat ticks as best-effort rather than exact cadence.
 * Timer ticks are emitted on the application bus so synchronization logic does
 * not depend on Worker message plumbing.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';

let _syncWorker: Worker | null = null;
const _activeTimers = new Map<string, number>();
const _fallbackTimers = new Set<string>();
type SyncWorkerFailureObserver = (error?: unknown) => void;
let _failureObserver: SyncWorkerFailureObserver | null = null;

function fallbackTimerName(id: string): string {
  return `sync-worker-fallback:${id}`;
}

/**
 * Install the worker and replay active timers. Bootstrap retains ownership of
 * `onerror` so worker failure has a single recovery path.
 */
export function setSyncWorker(worker: Worker): void {
  _syncWorker = worker;
  _syncWorker.onmessage = handleSyncWorkerMessage;

  for (const [id, intervalMs] of _activeTimers.entries()) {
    if (!postWorkerMessage({ command: 'START_TIMER', id, interval: intervalMs }, id)) break;
    stopFallbackTimer(id);
  }
}

/** Observe the single fallback boundary without changing its recovery policy. */
export function setSyncWorkerFailureObserver(observer: SyncWorkerFailureObserver | null): void {
  _failureObserver = observer;
}

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

export function stopWorkerTimer(id: string): void {
  _activeTimers.delete(id);
  stopFallbackTimer(id);
  if (!_syncWorker) return;
  postWorkerMessage({ command: 'STOP_TIMER', id }, id);
}

export function handleSyncWorkerFailure(error?: unknown): void {
  try {
    _failureObserver?.(error);
  } catch (observerError) {
    log.warn('[SyncWorker] Failure observer failed:', observerError);
  }

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
  _failureObserver = null;
  _activeTimers.clear();
  for (const id of Array.from(_fallbackTimers)) {
    stopFallbackTimer(id);
  }
}

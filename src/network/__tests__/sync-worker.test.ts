import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';

import {
  __resetSyncWorkerForTests,
  handleSyncWorkerFailure,
  isSyncWorkerFallbackActive,
  setSyncWorker,
  startWorkerTimer,
  stopWorkerTimer,
} from '../sync-worker.ts';

interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((e: MessageEvent) => void) | null;
  terminate: ReturnType<typeof vi.fn>;
}

function makeFakeWorker(): FakeWorker {
  return {
    postMessage: vi.fn(),
    onmessage: null,
    terminate: vi.fn(),
  };
}

function setFakeSyncWorker(worker: FakeWorker): void {
  // This fixture intentionally implements only the Worker surface consumed by
  // sync-worker.ts.
  setSyncWorker(worker as unknown as Worker);
}

beforeEach(() => {
  vi.useRealTimers();
  clearAllManagedTimers();
  __resetSyncWorkerForTests();
  bus.clear();
});

afterEach(() => {
  clearAllManagedTimers();
  __resetSyncWorkerForTests();
  vi.useRealTimers();
});

describe('setSyncWorker', () => {
  it('wires the worker.onmessage handler', () => {
    const w = makeFakeWorker();
    setFakeSyncWorker(w);
    expect(w.onmessage).toBeTypeOf('function');
  });
});

describe('startWorkerTimer / stopWorkerTimer', () => {
  it('posts START_TIMER with id + interval when a worker is wired', () => {
    const w = makeFakeWorker();
    setFakeSyncWorker(w);
    startWorkerTimer('sync', 1000);
    expect(w.postMessage).toHaveBeenCalledWith({
      command: 'START_TIMER',
      id: 'sync',
      interval: 1000,
    });
  });

  it('posts STOP_TIMER with id when a worker is wired', () => {
    const w = makeFakeWorker();
    setFakeSyncWorker(w);
    stopWorkerTimer('sync');
    expect(w.postMessage).toHaveBeenCalledWith({ command: 'STOP_TIMER', id: 'sync' });
  });

  it('drops STOP_TIMER silently when no worker is wired (no throw)', () => {
    expect(() => stopWorkerTimer('phantom')).not.toThrow();
  });

  it('uses a main-thread fallback timer when no worker is wired', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    bus.on('worker:timer-tick', cb);

    startWorkerTimer('sync', 1000);
    expect(isSyncWorkerFallbackActive('sync')).toBe(true);
    vi.advanceTimersByTime(999);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('sync');

    stopWorkerTimer('sync');
    expect(isSyncWorkerFallbackActive('sync')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('falls back if posting to the worker fails', () => {
    vi.useFakeTimers();
    const w = makeFakeWorker();
    w.postMessage.mockImplementationOnce(() => {
      throw new Error('post failed');
    });
    setFakeSyncWorker(w);
    const cb = vi.fn();
    bus.on('worker:timer-tick', cb);

    startWorkerTimer('sync', 1000);

    expect(w.terminate).toHaveBeenCalledTimes(1);
    expect(isSyncWorkerFallbackActive('sync')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledWith('sync');
  });

  it('replays active timers onto fallback when the worker fails later', () => {
    vi.useFakeTimers();
    const w = makeFakeWorker();
    setFakeSyncWorker(w);
    const cb = vi.fn();
    bus.on('worker:timer-tick', cb);

    startWorkerTimer('sync', 1000);
    expect(w.postMessage).toHaveBeenCalledWith({
      command: 'START_TIMER',
      id: 'sync',
      interval: 1000,
    });

    handleSyncWorkerFailure(new Error('worker crashed'));

    expect(w.terminate).toHaveBeenCalledTimes(1);
    expect(isSyncWorkerFallbackActive('sync')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledWith('sync');
  });

  it('moves an active fallback timer back to the worker when a worker is wired', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    bus.on('worker:timer-tick', cb);
    startWorkerTimer('sync', 1000);

    const w = makeFakeWorker();
    setFakeSyncWorker(w);

    expect(w.postMessage).toHaveBeenCalledWith({
      command: 'START_TIMER',
      id: 'sync',
      interval: 1000,
    });
    expect(isSyncWorkerFallbackActive('sync')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('TICK message handling', () => {
  it("emits 'worker:timer-tick' on TICK with the timer id", () => {
    const w = makeFakeWorker();
    setFakeSyncWorker(w);
    const cb = vi.fn();
    bus.on('worker:timer-tick', cb);
    w.onmessage!({ data: { type: 'TICK', id: 'sync' } } as MessageEvent);
    expect(cb).toHaveBeenCalledWith('sync');
  });

  it('falls back active timers on WORKER_ERROR without emitting an immediate tick', () => {
    vi.useFakeTimers();
    const w = makeFakeWorker();
    setFakeSyncWorker(w);
    const cb = vi.fn();
    bus.on('worker:timer-tick', cb);

    startWorkerTimer('sync', 1000);
    w.onmessage!({ data: { type: 'WORKER_ERROR', error: 'boom' } } as MessageEvent);

    expect(cb).not.toHaveBeenCalled();
    expect(w.terminate).toHaveBeenCalledTimes(1);
    expect(isSyncWorkerFallbackActive('sync')).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledWith('sync');
  });

  it('ignores empty messages', () => {
    const w = makeFakeWorker();
    setFakeSyncWorker(w);
    expect(() => w.onmessage!({ data: null } as MessageEvent)).not.toThrow();
  });
});

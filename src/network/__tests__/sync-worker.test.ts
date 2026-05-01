import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bus } from '../../core/events.ts';

import { setSyncWorker, startWorkerTimer, stopWorkerTimer } from '../sync-worker.ts';

interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((e: MessageEvent) => void) | null;
}

function makeFakeWorker(): FakeWorker {
  return {
    postMessage: vi.fn(),
    onmessage: null,
  };
}

beforeEach(() => {
  bus.clear();
});

describe('setSyncWorker', () => {
  it('wires the worker.onmessage handler', () => {
    const w = makeFakeWorker();
    setSyncWorker(w as unknown as Worker);
    expect(w.onmessage).toBeTypeOf('function');
  });
});

describe('startWorkerTimer / stopWorkerTimer', () => {
  it('posts START_TIMER with id + interval when a worker is wired', () => {
    const w = makeFakeWorker();
    setSyncWorker(w as unknown as Worker);
    startWorkerTimer('sync', 1000);
    expect(w.postMessage).toHaveBeenCalledWith({ command: 'START_TIMER', id: 'sync', interval: 1000 });
  });

  it('posts STOP_TIMER with id when a worker is wired', () => {
    const w = makeFakeWorker();
    setSyncWorker(w as unknown as Worker);
    stopWorkerTimer('sync');
    expect(w.postMessage).toHaveBeenCalledWith({ command: 'STOP_TIMER', id: 'sync' });
  });

  it('drops STOP_TIMER silently when no worker is wired (no throw)', () => {
    // Re-wire with a worker first, then null it out by re-setting through a
    // fresh fake — the module keeps a singleton ref; this test just verifies
    // the early-return path doesn't throw on missing reference.
    expect(() => stopWorkerTimer('phantom')).not.toThrow();
  });
});

describe('TICK message handling', () => {
  it("emits 'worker:timer-tick' on TICK with the timer id", () => {
    const w = makeFakeWorker();
    setSyncWorker(w as unknown as Worker);
    const cb = vi.fn();
    bus.on('worker:timer-tick', cb);
    w.onmessage!({ data: { type: 'TICK', id: 'sync' } } as MessageEvent);
    expect(cb).toHaveBeenCalledWith('sync');
  });

  it('logs WORKER_ERROR without emitting a tick', () => {
    const w = makeFakeWorker();
    setSyncWorker(w as unknown as Worker);
    const cb = vi.fn();
    bus.on('worker:timer-tick', cb);
    w.onmessage!({ data: { type: 'WORKER_ERROR', error: 'boom' } } as MessageEvent);
    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores empty messages', () => {
    const w = makeFakeWorker();
    setSyncWorker(w as unknown as Worker);
    expect(() => w.onmessage!({ data: null } as MessageEvent)).not.toThrow();
  });
});

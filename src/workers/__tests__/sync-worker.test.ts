import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Exercise the authored worker handlers against isolated self/timer boundaries.
// This replaces local replicas; it does not claim browser scheduling accuracy.
const workerCode = ts.transpileModule(
  readFileSync(new URL('../sync.worker.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

type WorkerOutput = { type: string; id?: string; command?: string; error?: string };
type WorkerEvent = { message?: string; reason?: unknown };
function createWorker() {
  const messages: WorkerOutput[] = [];
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const self = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: vi.fn((message: WorkerOutput) => messages.push(message)),
    addEventListener: (type: string, listener: (event: WorkerEvent) => void) => {
      listeners.set(type, listener);
    },
  };
  runInNewContext(workerCode, { self, setInterval, clearInterval });
  return {
    messages,
    post: (data: unknown) => self.onmessage!({ data }),
    event: (type: string, event: WorkerEvent = {}) => listeners.get(type)!(event),
    postMessage: self.postMessage,
  };
}
let worker: ReturnType<typeof createWorker>;
beforeEach(() => {
  vi.useFakeTimers();
  worker = createWorker();
});
afterEach(() => {
  worker.post({ command: 'STOP_ALL' });
  vi.useRealTimers();
});

describe('Sync Worker — actual START_TIMER normalization', () => {
  it.each([
    [null, null],
    [undefined, null],
    ['', null],
    [0, '0'],
    [42, '42'],
    ['hello', 'hello'],
    [false, 'false'],
  ])('normalizes message id %j to %j', (id, expected) => {
    worker.post({ command: 'START_TIMER', id, interval: 100 });
    vi.advanceTimersByTime(100);
    expect(worker.messages).toEqual(expected === null ? [] : [{ type: 'TICK', id: expected }]);
    expect(vi.getTimerCount()).toBe(expected === null ? 0 : 1);
  });
  it.each([
    [100, 100],
    [NaN, 1000],
    [Infinity, 1000],
    [-Infinity, 1000],
    [-500, 1],
    [0, 1],
    [99.9, 99],
    [0.5, 1],
    ['abc', 1000],
    ['200', 200],
  ])('normalizes interval %j to %j milliseconds', (interval, expected) => {
    worker.post({ command: 'START_TIMER', id: 'clock', interval });
    vi.advanceTimersByTime(Number(expected) - 1);
    expect(worker.messages).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(worker.messages).toEqual([{ type: 'TICK', id: 'clock' }]);
  });
});

describe('Sync Worker — actual timer management', () => {
  it('starts and stops through the same normalized message identity', () => {
    worker.post({ command: 'START_TIMER', id: 0, interval: 100 });
    vi.advanceTimersByTime(200);
    worker.post({ command: 'STOP_TIMER', id: '0' });
    vi.advanceTimersByTime(200);
    expect(worker.messages).toEqual([
      { type: 'TICK', id: '0' },
      { type: 'TICK', id: '0' },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('replaces a repeated id without retaining the old interval', () => {
    worker.post({ command: 'START_TIMER', id: 'dup', interval: 100 });
    vi.advanceTimersByTime(150);
    worker.post({ command: 'START_TIMER', id: 'dup', interval: 200 });
    vi.advanceTimersByTime(250);
    expect(worker.messages).toEqual([
      { type: 'TICK', id: 'dup' },
      { type: 'TICK', id: 'dup' },
    ]);
    expect(vi.getTimerCount()).toBe(1);
  });
  it('runs independent timers and stops all idempotently', () => {
    worker.post({ command: 'START_TIMER', id: 'A', interval: 100 });
    worker.post({ command: 'START_TIMER', id: 'B', interval: 200 });
    vi.advanceTimersByTime(400);
    expect(worker.messages.filter((message) => message.id === 'A')).toHaveLength(4);
    expect(worker.messages.filter((message) => message.id === 'B')).toHaveLength(2);
    worker.post({ command: 'STOP_ALL' });
    worker.post({ command: 'STOP_ALL' });
    vi.advanceTimersByTime(500);
    expect(worker.messages).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    null,
    {},
    { command: 'INIT_INSTANCE' },
    { command: 'unknown' },
    { command: 'STOP_TIMER', id: 'missing' },
  ])('ignores %j without changing a live timer', (message) => {
    worker.post({ command: 'START_TIMER', id: 'live', interval: 100 });
    worker.post(message);
    expect(worker.messages).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(worker.messages).toEqual([{ type: 'TICK', id: 'live' }]);
  });
  it('contains failed tick delivery and retains subsequent progress', () => {
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error('delivery failed');
    });
    worker.post({ command: 'START_TIMER', id: 'live', interval: 100 });
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    vi.advanceTimersByTime(100);
    expect(worker.messages).toEqual([{ type: 'TICK', id: 'live' }]);
  });
});

describe('Sync Worker — actual worker failure events', () => {
  it.each([
    ['error', { message: 'worker failed' }, 'WORKER_ERROR', 'worker failed'],
    ['unhandledrejection', { reason: new Error('rejected') }, 'UNHANDLED_REJECTION', 'rejected'],
    ['messageerror', {}, 'MESSAGE_ERROR', 'Message deserialization failed'],
  ] as const)('reports %s and contains a failed error report', (type, event, command, error) => {
    worker.event(type, event);
    expect(worker.messages).toEqual([{ type: 'WORKER_ERROR', scope: 'sync', command, error }]);
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error('report failed');
    });
    expect(() => worker.event(type, event)).not.toThrow();
  });
});

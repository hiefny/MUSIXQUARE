import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { decoderWorkerCall } from '../worker-call.ts';
import { getLargeAudioDiagnostics } from '../diagnostics.ts';

afterEach(() => {
  clearAllManagedTimers();
  expect(getLargeAudioDiagnostics().resources.workerCalls.live).toBe(0);
  vi.useRealTimers();
});

describe('decoder worker failure boundary', () => {
  it('turns a lost worker into a rejected operation and terminates it', async () => {
    const worker = Object.assign(new EventTarget(), { terminate: vi.fn() });
    const call = decoderWorkerCall(worker, new Promise<void>(() => {}));
    const failed = expect(call).rejects.toThrow('worker failed');
    worker.dispatchEvent(new Event('error'));
    await failed;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('bounds an unresponsive wrapper even if it exposes no native error events', async () => {
    vi.useFakeTimers();
    const worker = { terminate: vi.fn() };
    const call = decoderWorkerCall(worker, new Promise<void>(() => {}));
    const failed = expect(call).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('removes failure listeners and deadlines after a successful decode', async () => {
    vi.useFakeTimers();
    const worker = Object.assign(new EventTarget(), { terminate: vi.fn() });
    await expect(decoderWorkerCall(worker, Promise.resolve(123))).resolves.toBe(123);
    worker.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('keeps the RPC failure deadline when leaving a room clears managed timers', async () => {
    vi.useFakeTimers();
    const worker = { terminate: vi.fn() };
    const call = decoderWorkerCall(worker, new Promise<void>(() => {}));
    const failed = expect(call).rejects.toThrow('timed out');
    clearAllManagedTimers();
    expect(getLargeAudioDiagnostics().resources.workerCalls.live).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('settles failures even if terminating a torn-down worker throws', async () => {
    const worker = Object.assign(new EventTarget(), {
      terminate: vi.fn(() => {
        throw new Error('already torn down');
      }),
    });
    const call = decoderWorkerCall(worker, new Promise<void>(() => {}));
    const failed = expect(call).rejects.toThrow('worker failed');
    worker.dispatchEvent(new Event('messageerror'));
    await failed;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('does not revive settled RPCs when hundreds of late responses arrive after failure', async () => {
    vi.useFakeTimers();
    const lateResponses: Array<() => void> = [];
    const workers: Array<{ terminate: ReturnType<typeof vi.fn> }> = [];
    const pending = Array.from({ length: 200 }, () => {
      const worker = { terminate: vi.fn() };
      workers.push(worker);
      const result = new Promise<number>((resolve) => lateResponses.push(() => resolve(123)));
      return decoderWorkerCall(worker, result).catch((error: unknown) => error);
    });
    expect(getLargeAudioDiagnostics().resources.workerCalls.live).toBe(200);
    clearAllManagedTimers();
    await vi.advanceTimersByTimeAsync(15_000);
    const results = await Promise.all(pending);
    expect(results).toEqual(
      Array.from({ length: 200 }, () =>
        expect.objectContaining({ message: expect.stringContaining('timed out') }),
      ),
    );
    for (const resolve of lateResponses) resolve();
    await Promise.resolve();
    expect(getLargeAudioDiagnostics().resources.workerCalls.live).toBe(0);
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

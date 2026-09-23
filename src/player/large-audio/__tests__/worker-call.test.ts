import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { decoderWorkerCall } from '../worker-call.ts';

afterEach(() => {
  clearAllManagedTimers();
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
});

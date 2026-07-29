/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProRoomUploadQueue,
  getProRoomUploadRows,
  setActiveProRoomUploadQueue,
  subscribeProRoomUploadRows,
} from '../upload-queue.ts';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  setActiveProRoomUploadQueue(null);
});

describe('ProRoomUploadQueue', () => {
  it('projects every selected file immediately and advances each one sequentially', async () => {
    const first = deferred();
    const second = deferred();
    const runs: Array<{
      id: string;
      onProgress(fraction: number): void;
    }> = [];
    const completedPhases: string[] = [];
    const queue = new ProRoomUploadQueue({
      createId: vi.fn().mockReturnValueOnce(A).mockReturnValueOnce(B),
      run: vi.fn(async (input, context) => {
        runs.push({ id: input.id, onProgress: context.onProgress });
        await (input.id === A ? first.promise : second.promise);
      }),
    });
    queue.subscribe(() => {
      completedPhases.push(...queue.rows.map((row) => `${row.id}:${row.phase}`));
    });

    queue.enqueueFiles([new File(['a'], 'one.flac'), new File(['bb'], 'two.flac')]);

    expect(queue.rows).toEqual([
      expect.objectContaining({ id: A, phase: 'uploading', progressPercent: 0 }),
      expect.objectContaining({ id: B, phase: 'waiting', progressPercent: 0 }),
    ]);
    expect(runs.map(({ id }) => id)).toEqual([A]);

    runs[0]!.onProgress(0.429);
    expect(queue.rows[0]).toMatchObject({ phase: 'uploading', progressPercent: 42 });
    runs[0]!.onProgress(1);
    expect(queue.rows[0]).toMatchObject({ phase: 'confirming', progressPercent: 100 });
    expect(queue.cancel(A)).toBe(false);

    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs.map(({ id }) => id)).toEqual([A, B]);
    expect(queue.rows.find((row) => row.id === B)?.phase).toBe('uploading');

    second.resolve();
    await queue.whenIdle();
    await Promise.resolve();
    expect(completedPhases).toContain(`${A}:completed`);
    expect(completedPhases).toContain(`${B}:completed`);
    expect(queue.rows).toEqual([]);
  });

  it('keeps failed rows actionable, continues later files, and admits only one retry', async () => {
    const failure = new Error('temporary upload failure');
    const reportFailure = vi.fn();
    const attempts = new Map<string, number>();
    const retryFlags: boolean[] = [];
    const run = vi.fn(async (input, context) => {
      const attempt = (attempts.get(input.id) ?? 0) + 1;
      attempts.set(input.id, attempt);
      if (input.id === A) retryFlags.push(context.isRetry);
      if (input.id === A && attempt === 1) throw failure;
      context.onProgress(1);
    });
    const queue = new ProRoomUploadQueue({
      createId: vi.fn().mockReturnValueOnce(A).mockReturnValueOnce(B),
      run,
      reportFailure,
    });

    queue.enqueueFiles([new File(['a'], 'one.flac'), new File(['b'], 'two.flac')]);
    await queue.whenIdle();

    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(failure);
    expect(attempts).toEqual(
      new Map([
        [A, 1],
        [B, 1],
      ]),
    );
    expect(queue.rows).toEqual([
      expect.objectContaining({ id: A, phase: 'failed', progressPercent: 0 }),
    ]);

    expect(queue.retry(A)).toBe(true);
    expect(queue.retry(A)).toBe(false);
    await queue.whenIdle();
    await Promise.resolve();

    expect(attempts.get(A)).toBe(2);
    expect(retryFlags).toEqual([false, true]);
    expect(queue.rows).toEqual([]);
  });

  it('retires an ambiguous failed task when a later authoritative snapshot confirms it', async () => {
    const queue = new ProRoomUploadQueue({
      createId: () => A,
      run: async () => {
        throw new Error('append response and immediate snapshot were both lost');
      },
    });

    queue.enqueueFiles([new File(['a'], 'one.flac')]);
    await queue.whenIdle();
    expect(queue.rows).toEqual([expect.objectContaining({ id: A, phase: 'failed' })]);

    expect(queue.acknowledgeCommitted(new Set([A]))).toBe(true);
    expect(queue.rows).toEqual([]);
    expect(queue.acknowledgeCommitted(new Set([A]))).toBe(false);
  });

  it('aborts an active upload, removes its temporary row, and continues the queue', async () => {
    const aborted = vi.fn();
    const run = vi.fn(
      async (input: { id: string }, context: { signal: AbortSignal }): Promise<void> => {
        if (input.id !== A) return;
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              aborted();
              reject(context.signal.reason);
            },
            { once: true },
          );
        });
      },
    );
    const queue = new ProRoomUploadQueue({
      createId: vi.fn().mockReturnValueOnce(A).mockReturnValueOnce(B),
      run,
    });

    queue.enqueueFiles([new File(['a'], 'one.flac'), new File(['b'], 'two.flac')]);
    expect(queue.cancel(A)).toBe(true);
    await queue.whenIdle();
    await Promise.resolve();

    expect(aborted).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
    expect(queue.rows).toEqual([]);
  });

  it('publishes only the active room queue through the UI projection seam', () => {
    const queue = new ProRoomUploadQueue({
      createId: () => A,
      run: async () => undefined,
    });
    const listener = vi.fn();
    const unsubscribe = subscribeProRoomUploadRows(listener);

    setActiveProRoomUploadQueue(queue);
    queue.enqueueFiles([new File(['a'], 'one.flac')]);

    expect(listener).toHaveBeenCalled();
    expect(getProRoomUploadRows()[0]).toMatchObject({ id: A, name: 'one.flac' });

    setActiveProRoomUploadQueue(null);
    expect(getProRoomUploadRows()).toEqual([]);
    unsubscribe();
  });
});

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
      batchId: string;
      current: number;
      total: number;
      round: number;
      onProgress(fraction: number): void;
    }> = [];
    const completedPhases: string[] = [];
    const onBatchSettled = vi.fn();
    const queue = new ProRoomUploadQueue({
      createId: vi.fn().mockReturnValueOnce(A).mockReturnValueOnce(B),
      run: vi.fn(async (input, context) => {
        runs.push({
          id: input.id,
          batchId: context.batchId,
          current: context.current,
          total: context.total,
          round: context.round,
          onProgress: context.onProgress,
        });
        await (input.id === A ? first.promise : second.promise);
      }),
      onBatchSettled,
    });
    queue.subscribe(() => {
      completedPhases.push(...queue.rows.map((row) => `${row.id}:${row.phase}`));
    });

    queue.enqueueFiles([new File(['a'], 'one.flac'), new File(['bb'], 'two.flac')]);

    expect(queue.rows).toEqual([
      expect.objectContaining({ id: A, phase: 'uploading' }),
      expect.objectContaining({ id: B, phase: 'waiting' }),
    ]);
    expect(runs.map(({ id }) => id)).toEqual([A]);
    expect(runs[0]).toMatchObject({ batchId: 'batch-1', current: 1, total: 2, round: 1 });

    const notificationsBeforeProgress = completedPhases.length;
    runs[0]!.onProgress(0.429);
    expect(queue.rows[0]).toMatchObject({ phase: 'uploading' });
    expect(completedPhases).toHaveLength(notificationsBeforeProgress);
    runs[0]!.onProgress(1);
    expect(queue.rows[0]).toMatchObject({ phase: 'confirming' });
    expect(queue.cancel(A)).toBe(false);

    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs.map(({ id }) => id)).toEqual([A, B]);
    expect(runs[1]).toMatchObject({ batchId: 'batch-1', current: 2, total: 2, round: 1 });
    expect(queue.rows.find((row) => row.id === B)?.phase).toBe('uploading');

    second.resolve();
    await queue.whenIdle();
    await Promise.resolve();
    expect(completedPhases).toContain(`${A}:completed`);
    expect(completedPhases).toContain(`${B}:completed`);
    expect(queue.rows).toEqual([]);
    expect(onBatchSettled).toHaveBeenCalledOnce();
    expect(onBatchSettled).toHaveBeenCalledWith({
      batchId: 'batch-1',
      round: 1,
      requestedCount: 2,
      failedCount: 0,
      cancelledCount: 0,
      failedIds: [],
    });
  });

  it('settles failures as one batch and retries the same files and queue item ids once', async () => {
    const failure = new Error('temporary upload failure');
    const reportFailure = vi.fn();
    const onBatchSettled = vi.fn();
    const attempts = new Map<string, number>();
    const runContexts: Array<{
      id: string;
      file: File;
      batchId: string;
      current: number;
      total: number;
      round: number;
      isRetry: boolean;
    }> = [];
    const run = vi.fn(async (input, context) => {
      const attempt = (attempts.get(input.id) ?? 0) + 1;
      attempts.set(input.id, attempt);
      runContexts.push({
        id: input.id,
        file: input.file,
        batchId: context.batchId,
        current: context.current,
        total: context.total,
        round: context.round,
        isRetry: context.isRetry,
      });
      if (input.id === A && attempt === 1) throw failure;
      context.onProgress(1);
    });
    const firstFile = new File(['a'], 'one.flac');
    const queue = new ProRoomUploadQueue({
      createId: vi.fn().mockReturnValueOnce(A).mockReturnValueOnce(B),
      run,
      reportFailure,
      onBatchSettled,
    });

    queue.enqueueFiles([firstFile, new File(['b'], 'two.flac')]);
    await queue.whenIdle();

    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(failure);
    expect(attempts).toEqual(
      new Map([
        [A, 1],
        [B, 1],
      ]),
    );
    expect(queue.rows).toEqual([expect.objectContaining({ id: A, phase: 'failed' })]);
    expect(onBatchSettled).toHaveBeenCalledOnce();
    expect(onBatchSettled).toHaveBeenLastCalledWith({
      batchId: 'batch-1',
      round: 1,
      requestedCount: 2,
      failedCount: 1,
      cancelledCount: 0,
      failedIds: [A],
    });

    expect(queue.retryFailedBatch('batch-1')).toBe(true);
    expect(queue.retryFailedBatch('batch-1')).toBe(false);
    await queue.whenIdle();
    await Promise.resolve();

    expect(attempts.get(A)).toBe(2);
    expect(runContexts).toEqual([
      expect.objectContaining({
        id: A,
        file: firstFile,
        batchId: 'batch-1',
        current: 1,
        total: 2,
        round: 1,
        isRetry: false,
      }),
      expect.objectContaining({
        id: B,
        batchId: 'batch-1',
        current: 2,
        total: 2,
        round: 1,
        isRetry: false,
      }),
      expect.objectContaining({
        id: A,
        file: firstFile,
        batchId: 'batch-1',
        current: 1,
        total: 1,
        round: 2,
        isRetry: true,
      }),
    ]);
    expect(onBatchSettled).toHaveBeenCalledTimes(2);
    expect(onBatchSettled).toHaveBeenLastCalledWith({
      batchId: 'batch-1',
      round: 2,
      requestedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      failedIds: [],
    });
    expect(queue.rows).toEqual([]);
  });

  it('dismisses every failed file in a settled batch at once', async () => {
    const onBatchSettled = vi.fn();
    const queue = new ProRoomUploadQueue({
      createId: vi.fn().mockReturnValueOnce(A).mockReturnValueOnce(B),
      run: async () => {
        throw new Error('upload failed');
      },
      onBatchSettled,
    });

    queue.enqueueFiles([new File(['a'], 'one.flac'), new File(['b'], 'two.flac')]);
    await queue.whenIdle();

    expect(onBatchSettled).toHaveBeenCalledOnce();
    expect(queue.rows).toHaveLength(2);
    expect(queue.dismissFailedBatch('batch-1')).toBe(true);
    expect(queue.dismissFailedBatch('batch-1')).toBe(false);
    expect(queue.rows).toEqual([]);
  });

  it('ignores late progress after failure so the settled batch stays retryable and dismissible', async () => {
    let reportLateProgress: ((fraction: number) => void) | null = null;
    const queue = new ProRoomUploadQueue({
      createId: () => A,
      run: async (_input, context) => {
        reportLateProgress = context.onProgress;
        throw new Error('transport failed before its late progress callback');
      },
    });

    queue.enqueueFiles([new File(['a'], 'one.flac')]);
    await queue.whenIdle();
    expect(queue.rows).toEqual([expect.objectContaining({ id: A, phase: 'failed' })]);

    (reportLateProgress as ((fraction: number) => void) | null)?.(0.5);

    expect(queue.rows).toEqual([expect.objectContaining({ id: A, phase: 'failed' })]);
    expect(queue.dismissFailedBatch('batch-1')).toBe(true);
    expect(queue.rows).toEqual([]);
  });

  it('settles a hundred failures once per round and admits only one batch retry', async () => {
    const ids = Array.from(
      { length: 100 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    const attempts = new Map<string, number>();
    let nextId = 0;
    const onBatchSettled = vi.fn();
    const queue = new ProRoomUploadQueue({
      createId: () => ids[nextId++]!,
      run: async (input, context) => {
        const attempt = (attempts.get(input.id) ?? 0) + 1;
        attempts.set(input.id, attempt);
        if (context.round === 1) throw new Error('batch outage');
      },
      onBatchSettled,
    });

    queue.enqueueFiles(
      Array.from({ length: 100 }, (_, index) => new File([String(index)], `${index}.flac`)),
    );
    await queue.whenIdle();

    expect(onBatchSettled).toHaveBeenCalledOnce();
    expect(onBatchSettled).toHaveBeenLastCalledWith(
      expect.objectContaining({
        batchId: 'batch-1',
        round: 1,
        requestedCount: 100,
        failedCount: 100,
        cancelledCount: 0,
      }),
    );
    expect(queue.retryFailedBatch('batch-1')).toBe(true);
    expect(queue.retryFailedBatch('batch-1')).toBe(false);
    await queue.whenIdle();
    await Promise.resolve();

    expect(onBatchSettled).toHaveBeenCalledTimes(2);
    expect(onBatchSettled).toHaveBeenLastCalledWith({
      batchId: 'batch-1',
      round: 2,
      requestedCount: 100,
      failedCount: 0,
      cancelledCount: 0,
      failedIds: [],
    });
    expect([...attempts.values()]).toEqual(Array.from({ length: 100 }, () => 2));
    expect(queue.rows).toEqual([]);
  });

  it('retires an ambiguous failed task when a later authoritative snapshot confirms it', async () => {
    const onBatchSettled = vi.fn();
    const queue = new ProRoomUploadQueue({
      createId: () => A,
      run: async () => {
        throw new Error('append response and immediate snapshot were both lost');
      },
      onBatchSettled,
    });

    queue.enqueueFiles([new File(['a'], 'one.flac')]);
    await queue.whenIdle();
    expect(queue.rows).toEqual([expect.objectContaining({ id: A, phase: 'failed' })]);
    expect(onBatchSettled).toHaveBeenCalledOnce();

    expect(queue.acknowledgeCommitted(new Set([A]))).toBe(true);
    expect(queue.rows).toEqual([]);
    expect(queue.acknowledgeCommitted(new Set([A]))).toBe(false);
    expect(queue.retryFailedBatch('batch-1')).toBe(false);
    expect(queue.dismissFailedBatch('batch-1')).toBe(false);
    expect(onBatchSettled).toHaveBeenCalledOnce();
  });

  it('aborts an active upload, removes its temporary row, and continues the queue', async () => {
    const aborted = vi.fn();
    const onBatchSettled = vi.fn();
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
      onBatchSettled,
    });

    queue.enqueueFiles([new File(['a'], 'one.flac'), new File(['b'], 'two.flac')]);
    expect(queue.cancel(A)).toBe(true);
    await queue.whenIdle();
    await Promise.resolve();

    expect(aborted).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
    expect(queue.rows).toEqual([]);
    expect(onBatchSettled).toHaveBeenCalledOnce();
    expect(onBatchSettled).toHaveBeenCalledWith({
      batchId: 'batch-1',
      round: 1,
      requestedCount: 2,
      failedCount: 0,
      cancelledCount: 1,
      failedIds: [],
    });
  });

  it('discards active batch metadata on reset without publishing a settled event', async () => {
    const onBatchSettled = vi.fn();
    const queue = new ProRoomUploadQueue({
      createId: () => A,
      run: async (_input, context) => {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          });
        });
      },
      onBatchSettled,
    });

    queue.enqueueFiles([new File(['a'], 'one.flac')]);
    queue.reset();
    await queue.whenIdle();

    expect(queue.rows).toEqual([]);
    expect(onBatchSettled).not.toHaveBeenCalled();
    expect(queue.retryFailedBatch('batch-1')).toBe(false);
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

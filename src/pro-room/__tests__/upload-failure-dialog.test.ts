import { describe, expect, it, vi } from 'vitest';
import { resolveProRoomUploadFailureDialog } from '../upload-failure-dialog.ts';

function createQueue() {
  return {
    retryFailedBatch: vi.fn(() => true),
    dismissFailedBatch: vi.fn(() => true),
  };
}

describe('PRO upload failure dialog ownership', () => {
  it.each(['fallback', 'superseded', 'close'])(
    'releases the hidden failed batch when the dialog resolves programmatically as %s',
    async (action) => {
      const queue = createQueue();

      await resolveProRoomUploadFailureDialog({
        queue,
        batchId: 'batch-1',
        show: async () => ({ action }),
        isCurrent: () => true,
        reportPresentationFailure: vi.fn(),
      });

      expect(queue.retryFailedBatch).not.toHaveBeenCalled();
      expect(queue.dismissFailedBatch).toHaveBeenCalledWith('batch-1');
    },
  );

  it('reports presentation rejection and releases the hidden failed batch', async () => {
    const queue = createQueue();
    const error = new Error('dialog host unavailable');
    const reportPresentationFailure = vi.fn();

    await resolveProRoomUploadFailureDialog({
      queue,
      batchId: 'batch-1',
      show: async () => Promise.reject(error),
      isCurrent: () => true,
      reportPresentationFailure,
    });

    expect(reportPresentationFailure).toHaveBeenCalledWith(error);
    expect(queue.retryFailedBatch).not.toHaveBeenCalled();
    expect(queue.dismissFailedBatch).toHaveBeenCalledWith('batch-1');
  });

  it('contains a presentation reporter failure without blocking batch cleanup', async () => {
    const queue = createQueue();

    await expect(
      resolveProRoomUploadFailureDialog({
        queue,
        batchId: 'batch-1',
        show: async () => Promise.reject(new Error('dialog host unavailable')),
        isCurrent: () => true,
        reportPresentationFailure: () => {
          throw new Error('logger unavailable');
        },
      }),
    ).resolves.toBeUndefined();

    expect(queue.retryFailedBatch).not.toHaveBeenCalled();
    expect(queue.dismissFailedBatch).toHaveBeenCalledWith('batch-1');
  });

  it.each(['secondary', 'overlay', 'escape'])(
    'dismisses the failed batch only after the explicit %s action',
    async (action) => {
      const queue = createQueue();

      await resolveProRoomUploadFailureDialog({
        queue,
        batchId: 'batch-1',
        show: async () => ({ action }),
        isCurrent: () => true,
        reportPresentationFailure: vi.fn(),
      });

      expect(queue.dismissFailedBatch).toHaveBeenCalledWith('batch-1');
      expect(queue.retryFailedBatch).not.toHaveBeenCalled();
    },
  );

  it('retries only while the originating playlist lease remains current', async () => {
    const currentQueue = createQueue();
    const staleQueue = createQueue();

    await resolveProRoomUploadFailureDialog({
      queue: currentQueue,
      batchId: 'batch-current',
      show: async () => ({ action: 'ok' }),
      isCurrent: () => true,
      reportPresentationFailure: vi.fn(),
    });
    await resolveProRoomUploadFailureDialog({
      queue: staleQueue,
      batchId: 'batch-stale',
      show: async () => ({ action: 'ok' }),
      isCurrent: () => false,
      reportPresentationFailure: vi.fn(),
    });

    expect(currentQueue.retryFailedBatch).toHaveBeenCalledWith('batch-current');
    expect(currentQueue.dismissFailedBatch).not.toHaveBeenCalled();
    expect(staleQueue.retryFailedBatch).not.toHaveBeenCalled();
    expect(staleQueue.dismissFailedBatch).toHaveBeenCalledWith('batch-stale');
  });
});

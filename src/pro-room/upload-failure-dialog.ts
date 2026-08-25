import type { ProRoomUploadQueue } from './upload-queue.ts';

type FailedUploadQueue = Pick<ProRoomUploadQueue, 'dismissFailedBatch' | 'retryFailedBatch'>;

interface ProRoomUploadFailureDialogOptions {
  queue: FailedUploadQueue;
  batchId: string;
  show(): Promise<{ action: string }>;
  isCurrent(): boolean;
  reportPresentationFailure(error: unknown): void;
}

/**
 * Failed rows are intentionally hidden behind the batch dialog. If that dialog
 * cannot remain visible, release the retained File objects instead of leaving
 * an invisible batch alive for the rest of the room session.
 */
export async function resolveProRoomUploadFailureDialog(
  options: ProRoomUploadFailureDialogOptions,
): Promise<void> {
  let action: string;
  try {
    ({ action } = await options.show());
  } catch (error) {
    try {
      options.reportPresentationFailure(error);
    } catch {
      // Reporting is observational and cannot block retained-file cleanup.
    }
    options.queue.dismissFailedBatch(options.batchId);
    return;
  }

  if (action === 'ok') {
    if (options.isCurrent()) options.queue.retryFailedBatch(options.batchId);
    else options.queue.dismissFailedBatch(options.batchId);
    return;
  }
  options.queue.dismissFailedBatch(options.batchId);
}

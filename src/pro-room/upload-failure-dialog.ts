import type { I18nKey } from '../i18n/index.ts';
import { PRO_ROOM_MAX_ASSET_BYTES } from './contracts.ts';
import type { ProRoomUploadQueue } from './upload-queue.ts';

type FailedUploadQueue = Pick<ProRoomUploadQueue, 'dismissFailedBatch' | 'retryFailedBatch'>;

interface ProRoomUploadFailureDescription {
  readonly name: string;
  readonly size: number;
  readonly code: string | null;
  readonly retryable: boolean;
}

type Translate = (key: I18nKey, params?: Readonly<Record<string, string>>) => string;

/**
 * Dialog sentences for the codes the PRO client and Worker produce. Toast
 * copy is not reused here: the dialog lists one sentence per file.
 */
function failureReasonKey(failure: ProRoomUploadFailureDescription): I18nKey {
  switch (failure.code) {
    case 'PRO_ROOM_MEDIA_UPLOAD_SIZE_INVALID':
      return failure.size > PRO_ROOM_MAX_ASSET_BYTES
        ? 'pro.upload.file_too_large'
        : 'pro.upload.empty_file';
    case 'ROOM_QUOTA_EXCEEDED':
      return 'pro.upload.quota_exceeded';
    case 'PRO_ROOM_PLAYLIST_LIMIT_REACHED':
    case 'PLAYLIST_CAPACITY_EXCEEDED':
    case 'REQUEST_TOO_LARGE':
      return 'pro.upload.playlist_full';
    case 'ROOM_STATE_CAPACITY_EXCEEDED':
      return 'pro.upload.playlist_changed';
    case 'PRO_ROOM_PLAYLIST_SWITCHED':
      return 'pro.upload.playlist_switched';
    case 'PERMISSION_REQUIRED':
    case 'CAPABILITY_REQUIRED':
    case 'ADMINISTRATOR_REQUIRED':
    case 'RESERVATION_OWNER_REQUIRED':
      return 'pro.upload.permission_required';
    case 'ASSET_NOT_FOUND':
    case 'ASSET_NOT_READY':
    case 'UPLOAD_MISMATCH':
    case 'UPLOAD_INCOMPLETE':
      return 'pro.upload.retry_unavailable';
    default:
      return failure.retryable ? 'pro.upload.failed_retryable' : 'pro.upload.retry_unavailable';
  }
}

/** One dialog line per failed file: its name and the reason it failed. */
export function describeProRoomUploadFailures(
  failures: readonly ProRoomUploadFailureDescription[],
  translate: Translate,
): string[] {
  return failures.map((failure) =>
    translate('pro.upload.failed_file', {
      name: failure.name,
      reason: translate(failureReasonKey(failure)),
    }),
  );
}

interface ProRoomUploadFailureDialogOptions {
  queue: FailedUploadQueue;
  batchId: string;
  show(): Promise<{ action: string }>;
  isCurrent(): boolean;
  canRetry?: boolean;
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

  if (action === 'ok' && options.canRetry !== false) {
    if (options.isCurrent()) {
      if (!options.queue.retryFailedBatch(options.batchId)) {
        options.queue.dismissFailedBatch(options.batchId);
      }
    } else options.queue.dismissFailedBatch(options.batchId);
    return;
  }
  options.queue.dismissFailedBatch(options.batchId);
}

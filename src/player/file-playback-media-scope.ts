import type { QueueItemId } from '../types/index.ts';
import { isQueueItemId } from './queue-model.ts';

const MAX_SESSION_ID_LENGTH = 128;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._~:-]+$/u;

export interface FilePlaybackMediaScope {
  /** Immutable byte-source identity for one queue occurrence. */
  readonly sourceIdentity: string;
  /** Media-publication lifetime, independent from play runs and rendezvous. */
  readonly transferSessionId: string;
}

function isApplicationSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    SESSION_ID_PATTERN.test(value)
  );
}

/**
 * Derive the one shared host/guest media binding without filenames, sizes, or
 * Blob object identity. queueItemId is immutable and never reused; the random
 * application session prevents a stale room from claiming a new room's bytes.
 */
export function createFilePlaybackMediaScope(
  applicationSessionId: string,
  queueItemId: QueueItemId,
): FilePlaybackMediaScope {
  if (!isApplicationSessionId(applicationSessionId)) {
    throw new TypeError('File playback application session ID is invalid');
  }
  if (!isQueueItemId(queueItemId)) {
    throw new TypeError('File playback queue item ID is invalid');
  }

  return Object.freeze({
    sourceIdentity: `mxq:q:${queueItemId}`,
    transferSessionId: `mxq:s:${applicationSessionId}:q:${queueItemId}`,
  });
}

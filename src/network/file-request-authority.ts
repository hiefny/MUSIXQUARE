/**
 * Guest-side ownership for request/FILE_WAIT exchanges.
 *
 * A request belongs to one concrete host connection and one queue occurrence.
 * Peer IDs are intentionally absent: a reconnect can reuse them while delayed
 * frames from the replaced DataConnection are still draining.
 */

import type { DataConnection, FileRequestId, ProtocolMsg, QueueItemId } from '../types/index.ts';

interface FileRequestOwner {
  readonly hostConn: DataConnection;
  readonly requestId: FileRequestId;
  readonly queueItemId: QueueItemId;
  readonly sessionId?: number;
}

type FileRequestMessage =
  | Omit<ProtocolMsg<'request-current-file'>, 'requestId' | 'queueItemId' | 'sessionId'>
  | Omit<ProtocolMsg<'request-data-recovery'>, 'requestId' | 'queueItemId' | 'sessionId'>;

let nextRequestId = 0;
let currentOwner: FileRequestOwner | null = null;

export function isFileRequestId(value: unknown): value is FileRequestId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isOptionalSessionId(value: unknown): value is number | undefined {
  return value === undefined || isFileRequestId(value);
}

function allocateRequestId(): FileRequestId {
  if (nextRequestId >= Number.MAX_SAFE_INTEGER) {
    // Reusing an ID on the same live connection would weaken correlation.
    // Reaching this requires more than nine quadrillion file requests, so fail
    // closed instead of introducing a theoretical collision path.
    throw new Error('FILE_REQUEST_ID_EXHAUSTED');
  }
  nextRequestId += 1;
  return nextRequestId;
}

/** Replace the previous request owner and return the newly claimed identity. */
export function beginFileRequest(
  hostConn: DataConnection,
  queueItemId: QueueItemId,
  sessionId?: number,
): FileRequestOwner {
  if (!hostConn || typeof queueItemId !== 'string' || queueItemId.length === 0) {
    throw new TypeError('Invalid file request owner');
  }
  if (!isOptionalSessionId(sessionId)) {
    throw new TypeError('Invalid file request session');
  }

  const owner = Object.freeze({
    hostConn,
    requestId: allocateRequestId(),
    queueItemId,
    ...(sessionId === undefined ? {} : { sessionId }),
  }) as FileRequestOwner;
  currentOwner = owner;
  return owner;
}

export function getCurrentFileRequestOwnerForTests(): FileRequestOwner | null {
  return currentOwner;
}

/** Object identity prevents an old timer from clearing its successor. */
export function isCurrentFileRequestOwner(owner: FileRequestOwner): boolean {
  return currentOwner === owner;
}

function clearFileRequestOwner(expected?: FileRequestOwner): boolean {
  if (!currentOwner || (expected && currentOwner !== expected)) return false;
  currentOwner = null;
  return true;
}

export function resetFileRequestAuthority(): void {
  currentOwner = null;
}

/**
 * Send through the exact connection captured by the owner. This avoids a race
 * where a generic sendToHost() lookup switches connections between claiming
 * ownership and publishing the request.
 */
export function sendFileRequest(owner: FileRequestOwner, message: FileRequestMessage): boolean {
  if (!isCurrentFileRequestOwner(owner)) return false;
  if (!owner.hostConn.open) {
    clearFileRequestOwner(owner);
    return false;
  }
  try {
    owner.hostConn.send({
      ...message,
      requestId: owner.requestId,
      queueItemId: owner.queueItemId,
      ...(owner.sessionId === undefined ? {} : { sessionId: owner.sessionId }),
    });
    return true;
  } catch {
    clearFileRequestOwner(owner);
    return false;
  }
}

/** FILE_WAIT must echo the complete optional correlation tuple exactly. */
export function matchFileWaitResponse(
  conn: DataConnection | undefined,
  data: Record<string, unknown>,
): FileRequestOwner | null {
  const owner = currentOwner;
  if (
    !owner ||
    conn !== owner.hostConn ||
    data.requestId !== owner.requestId ||
    data.queueItemId !== owner.queueItemId ||
    !isOptionalSessionId(data.sessionId) ||
    data.sessionId !== owner.sessionId
  ) {
    return null;
  }
  return owner;
}

/**
 * Settle an accepted success response. A request without a session pins only
 * its queue occurrence; a recovery request with a session requires the exact
 * transfer attempt as well.
 */
export function completeFileRequest(
  conn: DataConnection | undefined,
  queueItemId: QueueItemId,
  sessionId?: number,
): boolean {
  const owner = currentOwner;
  if (
    !owner ||
    conn !== owner.hostConn ||
    owner.queueItemId !== queueItemId ||
    !isOptionalSessionId(sessionId) ||
    (owner.sessionId !== undefined && owner.sessionId !== sessionId)
  ) {
    return false;
  }
  return clearFileRequestOwner(owner);
}

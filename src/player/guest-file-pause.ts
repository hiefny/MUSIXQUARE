import { getState, setState } from '../core/state.ts';
import type { DataConnection, QueueItemId } from '../types/index.ts';
import { getCurrentLoadEpoch, getPendingPlayTime } from './_state.ts';
import { isExternalOwner } from './ownership.ts';
import { getQueueItemById } from './queue-model.ts';

interface GuestFilePause {
  readonly connection: DataConnection;
  readonly roomId: string | null;
  readonly roomEpoch: number;
  readonly sessionCode: string | null;
  readonly queueItemId: QueueItemId;
  readonly loadEpoch: number;
  readonly time: number;
  readonly sessionId: number | undefined;
}

let latestPause: GuestFilePause | null = null;

export function clearGuestFilePause(): void {
  latestPause = null;
}

/** Called only after the host PAUSE and its selected occurrence are validated. */
export function rememberGuestFilePause(queueItemId: QueueItemId, time: number): void {
  const connection = getState('network.hostConn');
  const room = getState('room.context');
  if (!connection || room.kind !== 'standard') return;
  const meta = getState('transfer.meta');
  const resident = getState('files.current');
  const sessionId =
    meta?.queueItemId === queueItemId
      ? meta.sessionId
      : resident?.queueItemId === queueItemId
        ? resident.sessionId
        : undefined;
  latestPause = {
    connection,
    roomId: room.roomId,
    roomEpoch: room.epoch,
    sessionCode: getState('network.sessionCode'),
    queueItemId,
    loadEpoch: getCurrentLoadEpoch(),
    time,
    sessionId:
      Number.isSafeInteger(sessionId) && Number(sessionId) > 0 ? Number(sessionId) : undefined,
  };
}

function isCurrentPause(pause: GuestFilePause): boolean {
  const room = getState('room.context');
  return (
    latestPause === pause &&
    room.kind === 'standard' &&
    room.roomId === pause.roomId &&
    room.epoch === pause.roomEpoch &&
    getState('network.sessionCode') === pause.sessionCode &&
    getState('network.hostConn') === pause.connection &&
    pause.connection.open &&
    getState('playlist.currentQueueItemId') === pause.queueItemId &&
    getQueueItemById(pause.queueItemId)?.type === 'file' &&
    getCurrentLoadEpoch() === pause.loadEpoch &&
    !isExternalOwner()
  );
}

/** Snapshot immediately before PREPARE's synchronous media teardown. */
export function captureGuestFilePause(
  queueItemId: QueueItemId | null,
  sessionId: number,
): GuestFilePause | null {
  const pause = latestPause;
  if (!pause) return null;
  if (
    !isCurrentPause(pause) ||
    pause.queueItemId !== queueItemId ||
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    (pause.sessionId !== undefined && pause.sessionId !== sessionId) ||
    getPendingPlayTime() !== undefined ||
    getState('playback.activity') === 'playing' ||
    getState('player.pausedAt') !== pause.time
  ) {
    latestPause = null;
    return null;
  }
  // A late-join PAUSE precedes the first file header. Bind that otherwise
  // sessionless checkpoint once so a later replay session cannot inherit it.
  latestPause = pause.sessionId === undefined ? { ...pause, sessionId } : pause;
  return latestPause;
}

export function restoreGuestFilePause(pause: GuestFilePause): void {
  if (!isCurrentPause(pause) || getPendingPlayTime() !== undefined) return;
  if (getState('transfer.localSessionId') > Number(pause.sessionId)) return;
  setState('player.pausedAt', pause.time);
}

import type { QueueItemId } from '../types/index.ts';
import { PRO_ROOM_MAX_PLAYLIST_ITEMS, type ProRoomSnapshot } from './contracts.ts';
import { isProRoomCode } from './room-code.ts';
import { isProRoomQueueItemId } from './snapshot.ts';

export type ProRoomRepeatMode = 0 | 1 | 2;

/**
 * Rolling-deploy-safe persistent queue behavior for a PRO room. This stays
 * outside snapshot v1 so an older strict client can continue joining while a
 * newer Worker is deployed.
 */
export interface ProRoomQueueModeSnapshot {
  schemaVersion: 1;
  view: 'queue-mode';
  roomCode: string;
  revision: number;
  playlistRevision: number;
  updatedAtMs: number;
  repeatMode: ProRoomRepeatMode;
  shuffleEnabled: boolean;
  shuffleOrder: QueueItemId[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseProRoomQueueModeSnapshot(
  value: unknown,
  expectedRoomCode?: string,
): ProRoomQueueModeSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'view',
      'roomCode',
      'revision',
      'playlistRevision',
      'updatedAtMs',
      'repeatMode',
      'shuffleEnabled',
      'shuffleOrder',
    ]) ||
    value.schemaVersion !== 1 ||
    value.view !== 'queue-mode' ||
    !isProRoomCode(value.roomCode) ||
    (expectedRoomCode !== undefined && value.roomCode !== expectedRoomCode) ||
    !isRevision(value.revision) ||
    !isRevision(value.playlistRevision) ||
    !isRevision(value.updatedAtMs) ||
    (value.repeatMode !== 0 && value.repeatMode !== 1 && value.repeatMode !== 2) ||
    typeof value.shuffleEnabled !== 'boolean' ||
    !Array.isArray(value.shuffleOrder) ||
    value.shuffleOrder.length > PRO_ROOM_MAX_PLAYLIST_ITEMS
  ) {
    return null;
  }

  const shuffleOrder: QueueItemId[] = [];
  const seen = new Set<QueueItemId>();
  for (const rawQueueItemId of value.shuffleOrder) {
    if (!isProRoomQueueItemId(rawQueueItemId) || seen.has(rawQueueItemId)) return null;
    seen.add(rawQueueItemId);
    shuffleOrder.push(rawQueueItemId);
  }
  if (!value.shuffleEnabled && shuffleOrder.length !== 0) return null;

  return {
    schemaVersion: 1,
    view: 'queue-mode',
    roomCode: value.roomCode,
    revision: value.revision,
    playlistRevision: value.playlistRevision,
    updatedAtMs: value.updatedAtMs,
    repeatMode: value.repeatMode,
    shuffleEnabled: value.shuffleEnabled,
    shuffleOrder,
  };
}

export function queueModeMatchesPlaylist(
  queueMode: ProRoomQueueModeSnapshot,
  snapshot: ProRoomSnapshot,
): boolean {
  if (
    queueMode.roomCode !== snapshot.roomCode ||
    queueMode.playlistRevision !== snapshot.playlistRevision
  ) {
    return false;
  }
  if (!queueMode.shuffleEnabled) return queueMode.shuffleOrder.length === 0;
  if (queueMode.shuffleOrder.length !== snapshot.playlist.length) return false;
  const liveIds = new Set(snapshot.playlist.map((item) => item.queueItemId));
  return (
    queueMode.shuffleOrder.every((queueItemId) => liveIds.delete(queueItemId)) && liveIds.size === 0
  );
}

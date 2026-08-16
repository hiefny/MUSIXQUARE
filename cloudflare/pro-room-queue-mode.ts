import { hasExactKeys, isSafeNonNegativeInteger } from './pro-room-validation.ts';

export interface QueueModePlaylistItem {
  queueItemId: string;
}

export interface QueueModeValues {
  repeatMode: 0 | 1 | 2;
  shuffleEnabled: boolean;
  shuffleOrder: string[];
}

export interface StoredQueueMode extends QueueModeValues {
  revision: number;
  updatedAtMs: number;
}

export interface RoomWithQueueMode {
  roomCode: string;
  playlistRevision: number;
  queueMode: StoredQueueMode;
}

export interface PublicQueueMode extends StoredQueueMode {
  schemaVersion: 1;
  view: 'queue-mode';
  roomCode: string;
  playlistRevision: number;
}

export interface DeveloperQueueMode {
  schemaVersion: 1;
  view: 'queue-mode';
  roomCode: string;
  revision: number;
  playlistRevision: number;
  updatedAtMs: number;
  repeatMode: 'off' | 'all' | 'one';
  shuffleEnabled: boolean;
}

export const QUEUE_ITEM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PLAYLIST_MAX_ITEMS = 1000;

export function initialQueueModeState(): StoredQueueMode {
  return {
    revision: 0,
    updatedAtMs: 0,
    repeatMode: 0,
    shuffleEnabled: false,
    shuffleOrder: [],
  };
}

export function parseQueueModeValues(
  value: unknown,
  playlist: readonly QueueModePlaylistItem[],
  stored: true,
): StoredQueueMode | null;
export function parseQueueModeValues(
  value: unknown,
  playlist: readonly QueueModePlaylistItem[],
  stored?: false,
): QueueModeValues | null;
export function parseQueueModeValues(
  value: unknown,
  playlist: readonly QueueModePlaylistItem[],
  stored = false,
): QueueModeValues | StoredQueueMode | null {
  const keys = stored
    ? ['revision', 'updatedAtMs', 'repeatMode', 'shuffleEnabled', 'shuffleOrder']
    : ['repeatMode', 'shuffleEnabled', 'shuffleOrder'];
  if (!hasExactKeys(value, keys)) return null;
  if (
    (stored &&
      (!isSafeNonNegativeInteger(value.revision) ||
        !isSafeNonNegativeInteger(value.updatedAtMs))) ||
    (value.repeatMode !== 0 && value.repeatMode !== 1 && value.repeatMode !== 2) ||
    typeof value.shuffleEnabled !== 'boolean' ||
    !Array.isArray(value.shuffleOrder) ||
    value.shuffleOrder.length > PLAYLIST_MAX_ITEMS
  ) {
    return null;
  }
  const liveIds = new Set(playlist.map((item) => item.queueItemId));
  const seen = new Set<string>();
  const shuffleOrder: string[] = [];
  for (const queueItemId of value.shuffleOrder) {
    if (
      typeof queueItemId !== 'string' ||
      !QUEUE_ITEM_ID_RE.test(queueItemId || '') ||
      !liveIds.has(queueItemId) ||
      seen.has(queueItemId)
    ) {
      return null;
    }
    seen.add(queueItemId);
    shuffleOrder.push(queueItemId);
  }
  if (
    (!value.shuffleEnabled && shuffleOrder.length !== 0) ||
    (value.shuffleEnabled && shuffleOrder.length !== playlist.length)
  ) {
    return null;
  }
  return {
    ...(stored ? { revision: value.revision, updatedAtMs: value.updatedAtMs } : {}),
    repeatMode: value.repeatMode,
    shuffleEnabled: value.shuffleEnabled,
    shuffleOrder,
  };
}

export function normalizeStoredQueueMode(
  value: unknown,
  playlist: readonly QueueModePlaylistItem[],
): StoredQueueMode | null {
  return parseQueueModeValues(value, playlist, true);
}

export function publicQueueMode(room: RoomWithQueueMode): PublicQueueMode {
  return {
    schemaVersion: 1,
    view: 'queue-mode',
    roomCode: room.roomCode,
    revision: room.queueMode.revision,
    playlistRevision: room.playlistRevision,
    updatedAtMs: room.queueMode.updatedAtMs,
    repeatMode: room.queueMode.repeatMode,
    shuffleEnabled: room.queueMode.shuffleEnabled,
    shuffleOrder: [...room.queueMode.shuffleOrder],
  };
}

export function developerQueueMode(room: RoomWithQueueMode): DeveloperQueueMode {
  return {
    schemaVersion: 1,
    view: 'queue-mode',
    roomCode: room.roomCode,
    revision: room.queueMode.revision,
    playlistRevision: room.playlistRevision,
    updatedAtMs: room.queueMode.updatedAtMs,
    repeatMode:
      room.queueMode.repeatMode === 2 ? 'one' : room.queueMode.repeatMode === 1 ? 'all' : 'off',
    shuffleEnabled: room.queueMode.shuffleEnabled,
  };
}

export function shuffledQueueItemIds(playlist: readonly QueueModePlaylistItem[]): string[] {
  const queueItemIds = playlist.map((item) => item.queueItemId);
  const random = new Uint32Array(1);
  for (let index = queueItemIds.length - 1; index > 0; index -= 1) {
    crypto.getRandomValues(random);
    const swapIndex = random[0]! % (index + 1);
    [queueItemIds[index], queueItemIds[swapIndex]] = [
      queueItemIds[swapIndex]!,
      queueItemIds[index]!,
    ];
  }
  return queueItemIds;
}

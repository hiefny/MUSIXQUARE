import { hasExactKeys, isSafeNonNegativeInteger } from './pro-room-validation.js';

/** @typedef {{ queueItemId: string }} QueueModePlaylistItem */
/** @typedef {{ repeatMode: 0 | 1 | 2, shuffleEnabled: boolean, shuffleOrder: string[] }} QueueModeValues */
/** @typedef {QueueModeValues & { revision: number, updatedAtMs: number }} StoredQueueMode */
/** @typedef {{ roomCode: string, playlistRevision: number, queueMode: StoredQueueMode }} RoomWithQueueMode */

export const QUEUE_ITEM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PLAYLIST_MAX_ITEMS = 1000;

/** @returns {StoredQueueMode} */
export function initialQueueModeState() {
  return {
    revision: 0,
    updatedAtMs: 0,
    repeatMode: 0,
    shuffleEnabled: false,
    shuffleOrder: [],
  };
}

/**
 * @param {unknown} value
 * @param {readonly QueueModePlaylistItem[]} playlist
 * @param {boolean} [stored]
 * @returns {QueueModeValues | StoredQueueMode | null}
 */
export function parseQueueModeValues(value, playlist, stored = false) {
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
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const shuffleOrder = [];
  for (const queueItemId of /** @type {string[]} */ (value.shuffleOrder)) {
    if (
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

/**
 * @param {unknown} value
 * @param {readonly QueueModePlaylistItem[]} playlist
 * @returns {StoredQueueMode | null}
 */
export function normalizeStoredQueueMode(value, playlist) {
  return /** @type {StoredQueueMode | null} */ (parseQueueModeValues(value, playlist, true));
}

/**
 * @param {RoomWithQueueMode} room
 * @returns {{ schemaVersion: 1, view: 'queue-mode', roomCode: string, revision: number, playlistRevision: number, updatedAtMs: number, repeatMode: 0 | 1 | 2, shuffleEnabled: boolean, shuffleOrder: string[] }}
 */
export function publicQueueMode(room) {
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

/**
 * @param {RoomWithQueueMode} room
 * @returns {{ schemaVersion: 1, view: 'queue-mode', roomCode: string, revision: number, playlistRevision: number, updatedAtMs: number, repeatMode: 'off' | 'all' | 'one', shuffleEnabled: boolean }}
 */
export function developerQueueMode(room) {
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

/**
 * @param {readonly QueueModePlaylistItem[]} playlist
 * @returns {string[]}
 */
export function shuffledQueueItemIds(playlist) {
  const queueItemIds = playlist.map((item) => item.queueItemId);
  const random = new Uint32Array(1);
  for (let index = queueItemIds.length - 1; index > 0; index -= 1) {
    crypto.getRandomValues(random);
    const swapIndex = random[0] % (index + 1);
    [queueItemIds[index], queueItemIds[swapIndex]] = [queueItemIds[swapIndex], queueItemIds[index]];
  }
  return queueItemIds;
}

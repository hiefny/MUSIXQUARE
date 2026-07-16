/**
 * Stable queue identity and authoritative snapshot helpers.
 *
 * Array positions are projections only. Every asynchronous or distributed
 * owner must retain a queueItemId and resolve its current index at use time.
 */

import { batchSetState, getState, setState } from '../core/state.ts';
import type {
  PlaylistItem,
  PlaylistRevision,
  PlaylistWireItem,
  QueueItemId,
} from '../types/index.ts';
import { clearProRoomTrackChangeIntent } from './track-change-intent.ts';

const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUEUE_ITEMS = 1000;
const MAX_QUEUE_TEXT_LENGTH = 2048;

interface PlaylistSnapshot {
  list: PlaylistWireItem[];
  revision: PlaylistRevision;
  currentQueueItemId: QueueItemId | null;
}

type PlaylistSnapshotApplyOutcome =
  | 'rebased'
  | 'applied'
  | 'duplicate'
  | 'stale'
  | 'conflict'
  | 'invalid';

type PlaylistSnapshotApplyMode = 'monotonic' | 'rebase';

interface PlaylistCommitOptions {
  currentQueueItemId?: QueueItemId | null;
}

export function createQueueItemId(): QueueItemId {
  const cryptoApi = globalThis.crypto;
  const randomUUID = cryptoApi?.randomUUID;
  if (typeof randomUUID !== 'function') {
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
      throw new Error('Secure queue item ID generation is unavailable');
    }
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
      16,
      20,
    )}-${hex.slice(20)}`;
  }
  return randomUUID.call(cryptoApi);
}

export function isQueueItemId(value: unknown): value is QueueItemId {
  return typeof value === 'string' && QUEUE_ITEM_ID_RE.test(value);
}

function isPlaylistRevision(value: unknown): value is PlaylistRevision {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function findQueueItemIndex(
  queueItemId: QueueItemId | null | undefined,
  items: readonly PlaylistItem[] = getState('playlist.items'),
): number {
  if (!queueItemId) return -1;
  return items.findIndex((item) => item.queueItemId === queueItemId);
}

export function getQueueItemById(
  queueItemId: QueueItemId | null | undefined,
  items: readonly PlaylistItem[] = getState('playlist.items'),
): Readonly<PlaylistItem> | null {
  const index = findQueueItemIndex(queueItemId, items);
  return index >= 0 ? (items[index] ?? null) : null;
}

export function getCurrentQueueItemId(): QueueItemId | null {
  return getState('playlist.currentQueueItemId');
}

export function getCurrentQueueItemIndex(): number {
  return findQueueItemIndex(getCurrentQueueItemId());
}

export function selectQueueItemById(queueItemId: QueueItemId | null): boolean {
  if (queueItemId !== null && !getQueueItemById(queueItemId)) return false;
  // Any validated coordinator selection is the authoritative answer to a
  // PRO member's optimistic outbound request (including a competing member
  // winning the race with a different row).
  clearProRoomTrackChangeIntent();
  setState('playlist.currentQueueItemId', queueItemId);
  return true;
}

function serializePlaylistItems(
  items: readonly PlaylistItem[] = getState('playlist.items'),
): PlaylistWireItem[] {
  return items.map((item) => ({
    queueItemId: item.queueItemId,
    type: item.type,
    name: item.name,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.artist === undefined ? {} : { artist: item.artist }),
    ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail }),
    videoId: item.videoId ?? null,
    playlistId: item.playlistId ?? null,
  }));
}

function clonePlaylistWireItem(item: PlaylistWireItem): PlaylistWireItem {
  return {
    queueItemId: item.queueItemId,
    type: item.type,
    name: item.name,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.artist === undefined ? {} : { artist: item.artist }),
    ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail }),
    videoId: item.videoId,
    playlistId: item.playlistId,
  };
}

export function createPlaylistSnapshot(): PlaylistSnapshot {
  return {
    list: serializePlaylistItems(),
    revision: getState('playlist.revision'),
    currentQueueItemId: getCurrentQueueItemId(),
  };
}

function isOptionalBoundedString(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'string' && value.length <= MAX_QUEUE_TEXT_LENGTH)
  );
}

function isPlaylistWireItem(value: unknown): value is PlaylistWireItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (!isQueueItemId(item.queueItemId)) return false;
  if (item.type !== 'file' && item.type !== 'youtube') return false;
  if (
    typeof item.name !== 'string' ||
    item.name.length === 0 ||
    item.name.length > MAX_QUEUE_TEXT_LENGTH
  ) {
    return false;
  }
  if (!isOptionalBoundedString(item.title)) return false;
  if (!isOptionalBoundedString(item.artist)) return false;
  if (!isOptionalBoundedString(item.thumbnail)) return false;
  if (
    item.videoId !== null &&
    (typeof item.videoId !== 'string' || item.videoId.length > MAX_QUEUE_TEXT_LENGTH)
  ) {
    return false;
  }
  if (
    item.playlistId !== null &&
    (typeof item.playlistId !== 'string' || item.playlistId.length > MAX_QUEUE_TEXT_LENGTH)
  ) {
    return false;
  }
  if (item.type === 'file' && (item.videoId !== null || item.playlistId !== null)) return false;
  if (item.type === 'youtube' && !item.videoId && !item.playlistId) return false;
  // Local-only media/UI fields must never cross the wire boundary.
  if ('file' in item || 'isExpanded' in item) return false;
  return true;
}

export function parsePlaylistSnapshot(value: unknown): PlaylistSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.list) || snapshot.list.length > MAX_QUEUE_ITEMS) return null;
  if (!isPlaylistRevision(snapshot.revision)) return null;
  if (snapshot.bootstrap !== undefined && snapshot.bootstrap !== true) return null;
  if (snapshot.currentQueueItemId !== null && !isQueueItemId(snapshot.currentQueueItemId)) {
    return null;
  }

  const ids = new Set<QueueItemId>();
  const list: PlaylistWireItem[] = [];
  for (const item of snapshot.list) {
    if (!isPlaylistWireItem(item) || ids.has(item.queueItemId)) return null;
    ids.add(item.queueItemId);
    list.push(clonePlaylistWireItem(item));
  }
  if (snapshot.currentQueueItemId !== null && !ids.has(snapshot.currentQueueItemId)) return null;

  return {
    list,
    revision: snapshot.revision,
    currentQueueItemId: snapshot.currentQueueItemId,
  };
}

function equalPlaylistWireItems(a: PlaylistWireItem, b: PlaylistWireItem): boolean {
  return (
    a.queueItemId === b.queueItemId &&
    a.type === b.type &&
    a.name === b.name &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.thumbnail === b.thumbnail &&
    a.videoId === b.videoId &&
    a.playlistId === b.playlistId
  );
}

function equalPlaylistSnapshots(a: PlaylistSnapshot, b: PlaylistSnapshot): boolean {
  return (
    a.revision === b.revision &&
    a.currentQueueItemId === b.currentQueueItemId &&
    a.list.length === b.list.length &&
    a.list.every((item, index) => {
      const other = b.list[index];
      return !!other && equalPlaylistWireItems(item, other);
    })
  );
}

function commitParsedPlaylistSnapshot(snapshot: PlaylistSnapshot): void {
  // Queue, selection, and revision form one authority boundary. Observers must
  // never see a new list paired with the previous session's selection/revision.
  batchSetState({
    'playlist.items': snapshot.list.map(clonePlaylistWireItem),
    'playlist.currentQueueItemId': snapshot.currentQueueItemId,
    'playlist.revision': snapshot.revision,
  });
}

export function applyPlaylistSnapshot(
  value: unknown,
  mode: PlaylistSnapshotApplyMode = 'monotonic',
): PlaylistSnapshotApplyOutcome {
  const snapshot = parsePlaylistSnapshot(value);
  if (!snapshot) return 'invalid';

  if (mode === 'rebase') {
    // Without an explicit room-instance identity, a new DataConnection cannot
    // prove that an equal-looking snapshot belongs to the previous authority.
    // Recommit and clean the media boundary even when canonical fields match.
    commitParsedPlaylistSnapshot(snapshot);
    return 'rebased';
  }

  const currentRevision = getState('playlist.revision');
  if (snapshot.revision < currentRevision) return 'stale';
  if (snapshot.revision === currentRevision) {
    return equalPlaylistSnapshots(snapshot, createPlaylistSnapshot()) ? 'duplicate' : 'conflict';
  }

  commitParsedPlaylistSnapshot(snapshot);
  return 'applied';
}

function assertValidHostItems(items: readonly PlaylistItem[]): void {
  if (items.length > MAX_QUEUE_ITEMS) throw new Error('Playlist item limit exceeded');
  const ids = new Set<QueueItemId>();
  for (const item of items) {
    if (!isQueueItemId(item.queueItemId)) throw new Error('Invalid queueItemId');
    if (ids.has(item.queueItemId)) throw new Error('Duplicate queueItemId');
    if (!isPlaylistWireItem(serializePlaylistItems([item])[0])) {
      throw new Error('Invalid playlist item');
    }
    ids.add(item.queueItemId);
  }
}

export function commitPlaylistItems(
  nextItems: readonly PlaylistItem[],
  options: PlaylistCommitOptions = {},
): PlaylistSnapshot {
  assertValidHostItems(nextItems);
  const previousRevision = getState('playlist.revision');
  if (!isPlaylistRevision(previousRevision) || previousRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Playlist revision exhausted');
  }

  const requestedCurrent = Object.prototype.hasOwnProperty.call(options, 'currentQueueItemId')
    ? (options.currentQueueItemId ?? null)
    : getCurrentQueueItemId();
  const currentQueueItemId =
    requestedCurrent && findQueueItemIndex(requestedCurrent, nextItems) >= 0
      ? requestedCurrent
      : null;
  const revision = previousRevision + 1;

  batchSetState({
    'playlist.items': [...nextItems],
    'playlist.currentQueueItemId': currentQueueItemId,
    'playlist.revision': revision,
  });
  return createPlaylistSnapshot();
}

export function moveQueueItemBefore(
  queueItemId: QueueItemId,
  beforeQueueItemId: QueueItemId | null,
  items: readonly PlaylistItem[] = getState('playlist.items'),
): PlaylistItem[] | null {
  const fromIndex = findQueueItemIndex(queueItemId, items);
  if (fromIndex < 0 || beforeQueueItemId === queueItemId) return null;
  if (beforeQueueItemId !== null && findQueueItemIndex(beforeQueueItemId, items) < 0) return null;

  const result = [...items];
  const [moved] = result.splice(fromIndex, 1);
  if (!moved) return null;
  const insertionIndex =
    beforeQueueItemId === null ? result.length : findQueueItemIndex(beforeQueueItemId, result);
  result.splice(insertionIndex, 0, moved);

  if (result.every((item, index) => item === items[index])) return null;
  return result;
}

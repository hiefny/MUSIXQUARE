/**
 * Inactive playlists of one PRO room.
 *
 * A room has three playlists by slot (0 is the unnumbered default). The
 * active one keeps the unchanged v2 layout (`pro-room:v2:core` plus
 * `pro-room:v2:playlist:<queueItemId>`), so an older Worker or client only
 * ever sees that playlist. The others live beside it: one
 * `pro-room:v2:slots` record with every slot's order and one
 * `pro-room:v2:slot-item:<queueItemId>` row per inactive item. A room without
 * the record has a single playlist at slot 0, and a room whose other
 * playlists are empty again at slot 0 deletes the record.
 */

export const PRO_ROOM_PLAYLIST_SLOT_COUNT = 3;
export const STORAGE_V2_SLOTS_KEY = 'pro-room:v2:slots';
const STORAGE_V2_SLOT_ITEM_PREFIX = 'pro-room:v2:slot-item:';
const STORAGE_SLOTS_SCHEMA_VERSION = 1;

/** The structural part of a Worker playlist item these helpers read. */
interface SlotPlaylistItem {
  queueItemId: string;
  source: { kind: 'youtube' } | { kind: 'pro-r2'; assetId: string; byteLength: number };
}

/** In-memory inactive playlists. The active slot's entry is always empty. */
export interface ProRoomPlaylistSlots<T> {
  activeSlot: number;
  inactive: T[][];
}

export interface StoredPlaylistSlots {
  schemaVersion: typeof STORAGE_SLOTS_SCHEMA_VERSION;
  activeSlot: number;
  orders: string[][];
}

export interface PlaylistSlotsSummary {
  activeSlot: number;
  slots: Array<{ count: number; bytes: number | null }>;
}

export function isPlaylistSlot(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < PRO_ROOM_PLAYLIST_SLOT_COUNT
  );
}

export function slotItemStorageKey(queueItemId: string) {
  return `${STORAGE_V2_SLOT_ITEM_PREFIX}${queueItemId}`;
}

export function emptyPlaylistSlots<T>(): ProRoomPlaylistSlots<T> {
  return {
    activeSlot: 0,
    inactive: Array.from({ length: PRO_ROOM_PLAYLIST_SLOT_COUNT }, () => []),
  };
}

/**
 * Strict validation of the stored record: exact keys, one order per slot, an
 * empty order at the active slot, and queue item IDs unique across every
 * playlist. Anything else fails closed, like an invalid core record.
 */
export function parseStoredPlaylistSlots(
  value: unknown,
  maxItems: number,
  isQueueItemId: (queueItemId: string) => boolean,
): StoredPlaylistSlots | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !['schemaVersion', 'activeSlot', 'orders'].every((key) => keys.includes(key)) ||
    record.schemaVersion !== STORAGE_SLOTS_SCHEMA_VERSION ||
    !isPlaylistSlot(record.activeSlot) ||
    !Array.isArray(record.orders) ||
    record.orders.length !== PRO_ROOM_PLAYLIST_SLOT_COUNT
  ) {
    return null;
  }
  const activeSlot = record.activeSlot;
  const seen = new Set<string>();
  const orders: string[][] = [];
  for (const [slot, order] of record.orders.entries()) {
    if (!Array.isArray(order) || order.length > maxItems) return null;
    if (slot === activeSlot && order.length !== 0) return null;
    const ids: string[] = [];
    for (const queueItemId of order) {
      if (typeof queueItemId !== 'string' || !isQueueItemId(queueItemId) || seen.has(queueItemId)) {
        return null;
      }
      seen.add(queueItemId);
      ids.push(queueItemId);
    }
    orders.push(ids);
  }
  return { schemaVersion: STORAGE_SLOTS_SCHEMA_VERSION, activeSlot, orders };
}

/** The record to store, or null when the room is back to one playlist at slot 0. */
export function storedPlaylistSlots<T extends SlotPlaylistItem>(
  slots: ProRoomPlaylistSlots<T> | undefined,
): StoredPlaylistSlots | null {
  if (!slots || (slots.activeSlot === 0 && slots.inactive.every((items) => items.length === 0))) {
    return null;
  }
  return {
    schemaVersion: STORAGE_SLOTS_SCHEMA_VERSION,
    activeSlot: slots.activeSlot,
    orders: slots.inactive.map((items, slot) =>
      slot === slots.activeSlot ? [] : items.map((item) => item.queueItemId),
    ),
  };
}

/** Every inactive item, for persistence and bounds checks. */
export function inactivePlaylistItems<T>(slots: ProRoomPlaylistSlots<T> | undefined): T[] {
  return slots ? slots.inactive.flat() : [];
}

export function playlistItemsAt<T>(
  active: T[],
  slots: ProRoomPlaylistSlots<T> | undefined,
  slot: number,
): T[] {
  const activeSlot = slots?.activeSlot ?? 0;
  if (slot === activeSlot) return active;
  return slots?.inactive[slot] ?? [];
}

/** File size of one playlist; YouTube items add nothing, no files is null. */
function playlistBytes(items: readonly SlotPlaylistItem[]): number | null {
  let bytes: number | null = null;
  for (const item of items) {
    if (item.source.kind === 'pro-r2') bytes = (bytes ?? 0) + item.source.byteLength;
  }
  return bytes;
}

export function summarizePlaylistSlots<T extends SlotPlaylistItem>(
  active: T[],
  slots: ProRoomPlaylistSlots<T> | undefined,
): PlaylistSlotsSummary {
  const activeSlot = slots?.activeSlot ?? 0;
  return {
    activeSlot,
    slots: Array.from({ length: PRO_ROOM_PLAYLIST_SLOT_COUNT }, (_, slot) => {
      const items = playlistItemsAt(active, slots, slot);
      return { count: items.length, bytes: playlistBytes(items) };
    }),
  };
}

/** Assets referenced by any playlist; garbage collection keeps all of them. */
export function referencedPlaylistAssetIds<T extends SlotPlaylistItem>(
  active: T[],
  slots: ProRoomPlaylistSlots<T> | undefined,
): Set<string> {
  const referenced = new Set<string>();
  for (const item of [...active, ...inactivePlaylistItems(slots)]) {
    if (item.source.kind === 'pro-r2') referenced.add(item.source.assetId);
  }
  return referenced;
}

/**
 * Make `slot` the active playlist: its items become the returned active list
 * and the previous active list moves into the previous active slot.
 */
export function swapActivePlaylist<T>(
  active: T[],
  slots: ProRoomPlaylistSlots<T> | undefined,
  slot: number,
): { active: T[]; slots: ProRoomPlaylistSlots<T> } {
  const current = slots ?? emptyPlaylistSlots<T>();
  const inactive = current.inactive.map((items) => [...items]);
  const next = inactive[slot] ?? [];
  inactive[current.activeSlot] = active;
  inactive[slot] = [];
  return { active: next, slots: { activeSlot: slot, inactive } };
}

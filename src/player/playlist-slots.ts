/**
 * MUSIXQUARE — Standard-room playlists (host side)
 *
 * `playlist.items` is always the room's active playlist, and every existing
 * queue frame keeps describing only that one. The host additionally keeps the
 * inactive playlists here, in memory with their `File` objects, so a moved
 * local file is never lost. Guests learn only summaries through
 * PLAYLIST_SLOTS (docs/design/multi-playlist-2026-10-21.md).
 */

import { PLAYLIST_SLOT_COUNT } from '../core/constants.ts';
import { getState } from '../core/state.ts';
import type { PlaylistItem, PlaylistSlotSummary, PlaylistSlotsSummary } from '../types/index.ts';
import { MAX_QUEUE_ITEMS, createQueueItemId } from './queue-model.ts';

let _activeSlot = 0;
let _inactive: PlaylistItem[][] = emptySlots();

function emptySlots(): PlaylistItem[][] {
  return Array.from({ length: PLAYLIST_SLOT_COUNT }, () => []);
}

export function isPlaylistSlot(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 0 && (value as number) < PLAYLIST_SLOT_COUNT
  );
}

export function getActivePlaylistSlot(): number {
  return _activeSlot;
}

/** Forget every inactive playlist (a new room or the end of hosting). */
export function resetPlaylistSlots(): void {
  _activeSlot = 0;
  _inactive = emptySlots();
}

function summarize(items: readonly PlaylistItem[]): PlaylistSlotSummary {
  let bytes: number | null = null;
  for (const item of items) {
    // Only local files have a known size; YouTube adds nothing.
    if (item.type === 'file' && item.file) bytes = (bytes ?? 0) + item.file.size;
  }
  return { count: items.length, bytes };
}

export function createPlaylistSlotsSummary(
  activeItems: readonly PlaylistItem[] = getState('playlist.items') || [],
): PlaylistSlotsSummary {
  return {
    activeSlot: _activeSlot,
    slots: _inactive.map((items, slot) => summarize(slot === _activeSlot ? activeItems : items)),
  };
}

/**
 * Park the outgoing active items in their slot and hand back the items of
 * `slot`, which becomes the active playlist.
 */
export function swapActivePlaylist(
  slot: number,
  outgoing: readonly PlaylistItem[],
): PlaylistItem[] | null {
  if (!isPlaylistSlot(slot) || slot === _activeSlot) return null;
  _inactive[_activeSlot] = [...outgoing];
  const incoming = _inactive[slot];
  _inactive[slot] = [];
  _activeSlot = slot;
  return incoming;
}

/**
 * Append copies of `items` (fresh queue item IDs) to each target playlist.
 * Refuses the whole transfer when any target is not an inactive playlist or
 * would exceed the queue limit.
 */
export function appendToInactivePlaylists(
  items: readonly PlaylistItem[],
  targetSlots: readonly number[],
): boolean {
  const targets = [...new Set(targetSlots)];
  if (
    items.length === 0 ||
    targets.length === 0 ||
    targets.some(
      (slot) =>
        !isPlaylistSlot(slot) ||
        slot === _activeSlot ||
        _inactive[slot].length + items.length > MAX_QUEUE_ITEMS,
    )
  ) {
    return false;
  }
  for (const slot of targets) {
    _inactive[slot] = [
      ..._inactive[slot],
      // A local resident copy and expansion state belong to one occurrence.
      ...items.map(({ isExpanded: _expanded, ...item }) => ({
        ...item,
        queueItemId: createQueueItemId(),
      })),
    ];
  }
  return true;
}

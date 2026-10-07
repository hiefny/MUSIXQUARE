import { getState } from '../core/state.ts';
import type { PlaylistItem, QueueItemId } from '../types/index.ts';

export function proYouTubeSubItemsKey(queueItemId: QueueItemId): string {
  return `pro-queue:${queueItemId}`;
}

export function getPlaylistSubItemsKey(item: PlaylistItem): string | null {
  if (!item.playlistId) return null;
  return item.youtubeVideoIds ? proYouTubeSubItemsKey(item.queueItemId) : item.playlistId;
}

/** A saved PRO occurrence never borrows another occurrence's ID ordering. */
export function getPlaylistSubItems(item: PlaylistItem | null | undefined):
  | {
      ids: string[];
      titles: string[];
      manifestComplete?: boolean;
      loadError?: boolean;
    }
  | undefined {
  if (!item?.playlistId) return undefined;
  const subMap = getState('youtube.subItemsMap');
  const entry = subMap[getPlaylistSubItemsKey(item)!];
  const ids = item.youtubeVideoIds;
  if (!ids) return entry;
  if (entry?.ids.length === ids.length && entry.ids.every((id, index) => id === ids[index])) {
    return entry;
  }
  // The title cache is bounded and may evict an inactive row. Its immutable
  // manifest still lives on the projected item, so eviction cannot change
  // navigation or force a fresh, potentially changed native playlist scrape.
  const source = subMap[item.playlistId];
  const titlesById = new Map(source?.ids.map((id, index) => [id, source.titles[index] || '']));
  return { ids, titles: ids.map((id) => titlesById.get(id) || ''), manifestComplete: true };
}

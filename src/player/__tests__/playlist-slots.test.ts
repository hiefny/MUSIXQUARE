import { afterEach, describe, expect, it } from 'vitest';
import type { PlaylistItem } from '../../types/index.ts';
import {
  appendToInactivePlaylists,
  createPlaylistSlotsSummary,
  getActivePlaylistSlot,
  resetPlaylistSlots,
  swapActivePlaylist,
} from '../playlist-slots.ts';
import { MAX_QUEUE_ITEMS, createQueueItemId } from '../queue-model.ts';

function fileItem(name: string, size: number): PlaylistItem {
  return {
    queueItemId: createQueueItemId(),
    type: 'file',
    name,
    file: new File([new Uint8Array(size)], name),
    videoId: null,
    playlistId: null,
  };
}

function youtubeItem(name: string): PlaylistItem {
  return {
    queueItemId: createQueueItemId(),
    type: 'youtube',
    name,
    videoId: 'dQw4w9WgXcQ',
    playlistId: null,
    isExpanded: true,
  };
}

describe('standard-room playlist slots', () => {
  afterEach(() => resetPlaylistSlots());

  it('summarizes every playlist, counting only local file sizes', () => {
    const active = [fileItem('a.mp3', 10), youtubeItem('video')];
    expect(createPlaylistSlotsSummary(active)).toEqual({
      activeSlot: 0,
      slots: [
        { count: 2, bytes: 10 },
        { count: 0, bytes: null },
        { count: 0, bytes: null },
      ],
    });
    expect(createPlaylistSlotsSummary([youtubeItem('only video')]).slots[0]).toEqual({
      count: 1,
      bytes: null,
    });
  });

  it('copies tracks with fresh IDs to inactive playlists and keeps their files', () => {
    const tracks = [fileItem('a.mp3', 4), youtubeItem('video')];
    expect(appendToInactivePlaylists(tracks, [1, 2])).toBe(true);

    const second = swapActivePlaylist(1, tracks)!;
    expect(second.map((item) => item.name)).toEqual(['a.mp3', 'video']);
    expect(second[0]!.queueItemId).not.toBe(tracks[0]!.queueItemId);
    expect(second[0]!.file).toBe(tracks[0]!.file);
    expect(second[1]!.isExpanded).toBeUndefined();
    expect(getActivePlaylistSlot()).toBe(1);

    // The parked first playlist comes back unchanged.
    expect(createPlaylistSlotsSummary(second).slots).toEqual([
      { count: 2, bytes: 4 },
      { count: 2, bytes: 4 },
      { count: 2, bytes: 4 },
    ]);
    expect(swapActivePlaylist(0, second)).toEqual(tracks);
  });

  it('refuses the active playlist, unknown slots and overfull targets as a whole', () => {
    const track = [fileItem('a.mp3', 1)];
    expect(appendToInactivePlaylists(track, [0])).toBe(false);
    expect(appendToInactivePlaylists(track, [3])).toBe(false);
    expect(appendToInactivePlaylists([], [1])).toBe(false);
    expect(swapActivePlaylist(0, track)).toBeNull();

    const many = Array.from({ length: MAX_QUEUE_ITEMS }, (_, index) => fileItem(`${index}`, 1));
    expect(appendToInactivePlaylists(many, [2])).toBe(true);
    expect(appendToInactivePlaylists(track, [1, 2])).toBe(false);
    expect(createPlaylistSlotsSummary([]).slots[1]).toEqual({ count: 0, bytes: null });
  });
});

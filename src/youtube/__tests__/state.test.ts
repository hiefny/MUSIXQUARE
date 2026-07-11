import { beforeEach, describe, expect, it } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import type { PlaylistItem } from '../../types/index.ts';
import {
  setSubItemsData,
  setSubItemsLoadError,
  updateSubItemIds,
  updateSubItemTitle,
} from '../_state.ts';
import { MAX_PLAYLIST_SUB_ITEMS } from '../constants.ts';

describe('YouTube subItemsMap cache', () => {
  beforeEach(() => {
    resetState();
  });

  it('keeps the current playlist when pruning old entries', () => {
    const queueItemId = '33333333-3333-4333-8333-333333333333';
    setState('playlist.items', [
      {
        queueItemId,
        type: 'youtube',
        playlistId: 'pid-0',
        videoId: 'v0',
        name: 'Current playlist',
      },
    ] satisfies PlaylistItem[]);
    setState('playlist.currentQueueItemId', queueItemId);

    for (let i = 0; i < 55; i++) {
      setSubItemsData(`pid-${i}`, [`v${i}`], [`Video ${i}`]);
    }

    const subMap = getState('youtube.subItemsMap');
    expect(Object.keys(subMap)).toHaveLength(50);
    expect(subMap['pid-0']?.ids).toEqual(['v0']);
    expect(subMap['pid-1']).toBeUndefined();
  });

  it('touches updated entries so recently used playlists are pruned last', () => {
    for (let i = 0; i < 50; i++) {
      setSubItemsData(`pid-${i}`, [`v${i}`], [`Video ${i}`]);
    }

    updateSubItemTitle('pid-0', 0, 'Recently used');
    updateSubItemIds('pid-50', ['v50']);

    const subMap = getState('youtube.subItemsMap');
    expect(Object.keys(subMap)).toHaveLength(50);
    expect(subMap['pid-0']?.titles[0]).toBe('Recently used');
    expect(subMap['pid-1']).toBeUndefined();
    expect(subMap['pid-50']?.ids).toEqual(['v50']);
  });

  it('keeps load-error updates behind the same pruning path', () => {
    for (let i = 0; i < 50; i++) {
      setSubItemsData(`pid-${i}`, [`v${i}`], [`Video ${i}`]);
    }

    setSubItemsLoadError('pid-50', true);

    const erroredMap = getState('youtube.subItemsMap');
    expect(Object.keys(erroredMap)).toHaveLength(50);
    expect(erroredMap['pid-0']).toBeUndefined();
    expect(erroredMap['pid-50']?.loadError).toBe(true);

    setSubItemsLoadError('pid-50', false);
    expect(getState('youtube.subItemsMap')['pid-50']?.loadError).toBeUndefined();
  });

  it('caps an out-of-range sub-item index so a hostile update cannot OOM-pad titles (F-2101)', () => {
    setSubItemsData('pid-0', ['v0'], ['Video 0']);

    // A YOUTUBE_SUB_TITLE_UPDATE with subIdx=1e9 must be dropped, not padded
    // into a billion-element titles array. (Validator also caps subIdx < 5000.)
    updateSubItemTitle('pid-0', 1_000_000_000, 'evil');

    const titles = getState('youtube.subItemsMap')['pid-0']?.titles ?? [];
    expect(titles.length).toBe(1);
    expect(titles.length).toBeLessThanOrEqual(MAX_PLAYLIST_SUB_ITEMS);
  });

  it('still applies an in-range sub-item title update', () => {
    setSubItemsData('pid-0', ['v0', 'v1', 'v2'], ['A', '', '']);
    updateSubItemTitle('pid-0', 2, 'C');
    expect(getState('youtube.subItemsMap')['pid-0']?.titles[2]).toBe('C');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import type { PlaylistItem } from '../../types/index.ts';
import {
  setSubItemsData,
  setSubItemsLoadError,
  updateSubItemIds,
  updateSubItemTitle,
} from '../_state.ts';

describe('YouTube subItemsMap cache', () => {
  beforeEach(() => {
    resetState();
  });

  it('keeps the current playlist when pruning old entries', () => {
    setState('playlist.currentTrackIndex', 0);
    setState('playlist.items', [
      {
        type: 'youtube',
        playlistId: 'pid-0',
        videoId: 'v0',
        name: 'Current playlist',
      },
    ] satisfies PlaylistItem[]);

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
});

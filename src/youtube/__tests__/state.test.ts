import { beforeEach, describe, expect, it } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import type { PlaylistItem } from '../../types/index.ts';
import {
  type YouTubePlayerInstance,
  isYtPlayerReady,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setYouTubePlayer,
  setSubItemsData,
  setSubItemsLoadError,
  updateSubItemIds,
  updateSubItemTitle,
} from '../_state.ts';
import { MAX_PLAYLIST_SUB_ITEMS } from '../constants.ts';

describe('YouTube subItemsMap cache', () => {
  beforeEach(() => {
    resetState();
    resetYouTubeModuleState();
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

  it('preserves complete-manifest proof only while the canonical IDs stay identical', () => {
    updateSubItemIds('pid-single', ['AAAAAAAAAAA'], { manifestComplete: true });
    setSubItemsLoadError('pid-single', true);
    setSubItemsLoadError('pid-single', false);
    updateSubItemIds('pid-single', ['AAAAAAAAAAA']);
    setSubItemsData('pid-single', ['AAAAAAAAAAA'], ['Only video']);

    expect(getState('youtube.subItemsMap')['pid-single']).toMatchObject({
      ids: ['AAAAAAAAAAA'],
      titles: ['Only video'],
      manifestComplete: true,
    });

    updateSubItemIds('pid-single', ['BBBBBBBBBBB']);
    expect(getState('youtube.subItemsMap')['pid-single']?.manifestComplete).toBeUndefined();
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

  it('preserves titles by video ID across reordered and replaced manifests without changing queue identity', () => {
    const queueItemId = '33333333-3333-4333-8333-333333333333';
    const items: PlaylistItem[] = [
      { queueItemId, type: 'youtube', playlistId: 'pid', videoId: 'A', name: 'Playlist' },
    ];
    setState('playlist.items', items);
    setState('playlist.currentQueueItemId', queueItemId);
    setSubItemsData('pid', ['A', 'B', 'C'], ['Title A', 'Title B', 'Title C']);

    updateSubItemIds('pid', ['B', 'D', 'A']);

    expect(getState('youtube.subItemsMap')['pid']).toMatchObject({
      ids: ['B', 'D', 'A'],
      titles: ['Title B', '', 'Title A'],
    });
    expect(getState('playlist.items')).toEqual(items);
    expect(getState('playlist.currentQueueItemId')).toBe(queueItemId);
  });

  it('shares the first known title for duplicate video IDs and clears titles for an empty manifest', () => {
    setSubItemsData('pid', ['A', 'A', 'A', 'B'], ['', 'Title A', 'Other title A', 'Title B']);

    updateSubItemIds('pid', ['B', 'A', 'A']);
    expect(getState('youtube.subItemsMap')['pid']?.titles).toEqual([
      'Title B',
      'Title A',
      'Title A',
    ]);

    updateSubItemIds('pid', []);
    expect(getState('youtube.subItemsMap')['pid']).toMatchObject({ ids: [], titles: [] });
  });

  it('keeps explicit received titles authoritative over cached titles', () => {
    setSubItemsData('pid', ['A', 'B'], ['Old A', 'Old B']);
    updateSubItemIds('pid', ['B', 'A']);
    setSubItemsData('pid', ['B', 'A'], ['Received B', '']);

    expect(getState('youtube.subItemsMap')['pid']?.titles).toEqual(['Received B', '']);
    updateSubItemIds('pid', ['A', 'B']);
    expect(getState('youtube.subItemsMap')['pid']?.titles).toEqual(['', 'Received B']);
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

describe('YouTube player readiness identity', () => {
  beforeEach(() => {
    resetYouTubeModuleState();
  });

  it('becomes ready only for the current player onReady epoch', () => {
    const first = {} as YouTubePlayerInstance;
    const replacement = {} as YouTubePlayerInstance;

    setYouTubePlayer(first);
    expect(isYtPlayerReady()).toBe(false);
    expect(markYtPlayerReady(first)).toBe(true);
    expect(isYtPlayerReady()).toBe(true);

    // Re-publishing the same retained iframe preserves its ready epoch.
    setYouTubePlayer(first);
    expect(isYtPlayerReady()).toBe(true);

    setYouTubePlayer(replacement);
    expect(isYtPlayerReady()).toBe(false);
    expect(markYtPlayerReady(first)).toBe(false);
    expect(isYtPlayerReady()).toBe(false);
    expect(markYtPlayerReady(replacement)).toBe(true);
    expect(isYtPlayerReady()).toBe(true);

    setYouTubePlayer(null);
    expect(isYtPlayerReady()).toBe(false);
    expect(markYtPlayerReady(replacement)).toBe(false);
  });
});

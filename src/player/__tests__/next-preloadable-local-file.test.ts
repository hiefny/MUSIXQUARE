import { describe, expect, it } from 'vitest';
import type { PlaylistItem, QueueItemId } from '../../types/index.ts';
import { selectNextPreloadableLocalFile } from '../next-preloadable-local-file.ts';

const Q1 = '00000000-0000-4000-8000-000000000001';
const Q2 = '00000000-0000-4000-8000-000000000002';
const Q3 = '00000000-0000-4000-8000-000000000003';
const Q4 = '00000000-0000-4000-8000-000000000004';

function local(queueItemId: QueueItemId, name = `${queueItemId}.audio`): PlaylistItem {
  return {
    queueItemId,
    type: 'file',
    name,
    videoId: null,
    playlistId: null,
  };
}

function youtube(queueItemId: QueueItemId): PlaylistItem {
  return {
    queueItemId,
    type: 'youtube',
    name: queueItemId,
    videoId: queueItemId,
    playlistId: null,
  };
}

function select(
  items: readonly PlaylistItem[],
  currentQueueItemId: QueueItemId | null,
  repeatMode = 0,
  isShuffle = false,
  shuffleNextQueueItemId: QueueItemId | null = null,
) {
  return selectNextPreloadableLocalFile({
    items,
    currentQueueItemId,
    repeatMode,
    isShuffle,
    shuffleNextQueueItemId,
  });
}

describe('selectNextPreloadableLocalFile', () => {
  it('requires a multi-item queue and an exact current occurrence', () => {
    expect(select([], null)).toBeNull();
    expect(select([local(Q1)], Q1, 2)).toBeNull();
    expect(select([local(Q1), local(Q2)], Q3)).toBeNull();
  });

  it('selects the sequential successor without inspecting its codec', () => {
    const items = [local(Q1, 'current.flac'), local(Q2, 'next.caf')];

    expect(select(items, Q1)).toEqual({
      item: items[1],
      queueItemId: Q2,
      indexHint: 1,
    });
  });

  it('skips consecutive YouTube rows only during linear traversal', () => {
    const items = [local(Q1), youtube(Q2), youtube(Q3), local(Q4, 'next.aiff')];

    expect(select(items, Q1)).toMatchObject({ queueItemId: Q4, indexHint: 3 });
    expect(select(items, Q1, 0, true, Q2)).toBeNull();
  });

  it('stops at the queue end when repeat is off', () => {
    const items = [local(Q1), youtube(Q2), local(Q3)];

    expect(select(items, Q3)).toBeNull();
    expect(select(items, Q1)).toMatchObject({ queueItemId: Q3, indexHint: 2 });
  });

  it('wraps and scans for repeat-all without completing a lap back to current', () => {
    const wrapped = [youtube(Q1), local(Q2, 'wrapped.wav'), local(Q3), youtube(Q4)];
    const noOtherLocal = [youtube(Q1), local(Q2), youtube(Q3), youtube(Q4)];

    expect(select(wrapped, Q3, 1)).toMatchObject({ queueItemId: Q2, indexHint: 1 });
    expect(select(noOtherLocal, Q2, 1)).toBeNull();
  });

  it('uses the exact shuffle hint and rejects absent or current hints', () => {
    const items = [local(Q1), local(Q2), local(Q3, 'hinted.m4a')];

    expect(select(items, Q1, 0, true, Q3)).toMatchObject({
      queueItemId: Q3,
      indexHint: 2,
    });
    expect(select(items, Q1, 0, true, Q1)).toBeNull();
    expect(select(items, Q1, 0, true, Q4)).toBeNull();
    expect(select(items, Q1, 0, true, null)).toBeNull();
  });

  it('gives repeat-one precedence over shuffle and rejects a YouTube current row', () => {
    const locals = [local(Q1, 'current.mp3'), local(Q2)];
    const videos = [youtube(Q1), local(Q2)];

    expect(select(locals, Q1, 2, true, Q2)).toMatchObject({
      queueItemId: Q1,
      indexHint: 0,
    });
    expect(select(videos, Q1, 2, true, Q2)).toBeNull();
  });
});

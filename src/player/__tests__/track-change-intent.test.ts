import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { PlaylistItem, QueueItemId } from '../../types/index.ts';
import { selectQueueItemById } from '../queue-model.ts';
import { beginProRoomTrackChangeIntent } from '../track-change-intent.ts';

const QUEUE_ITEM_ID = '30000000-0000-4000-8000-000000000001' as QueueItemId;

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
  resetState();
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('PRO member outbound track-change intent', () => {
  it('stays pending across a long coordinator fetch and clears on authoritative selection', () => {
    const item: PlaylistItem = {
      queueItemId: QUEUE_ITEM_ID,
      type: 'file',
      name: 'concert.flac',
      videoId: null,
      playlistId: null,
    };
    setState('playlist.items', [item]);
    beginProRoomTrackChangeIntent(QUEUE_ITEM_ID);

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(getState('network.pendingTrackChangeQueueItemId')).toBe(QUEUE_ITEM_ID);

    expect(selectQueueItemById(QUEUE_ITEM_ID)).toBe(true);
    expect(getState('network.pendingTrackChangeQueueItemId')).toBeNull();
  });

  it('eventually releases an orphaned request that receives no response', () => {
    beginProRoomTrackChangeIntent(QUEUE_ITEM_ID);

    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    expect(getState('network.pendingTrackChangeQueueItemId')).toBeNull();
  });
});

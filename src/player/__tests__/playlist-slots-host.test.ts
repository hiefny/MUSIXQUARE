/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { registerProPlaybackMediaEndpoint } from '../../pro-room/playback-authority-hooks.ts';
import { initPlaylist, switchPlaylist, transferTracks } from '../playlist.ts';

vi.mock('../../ui/toast.ts', () => ({ showToast: vi.fn() }));

function populate(count: number) {
  const items = Array.from({ length: count }, (_, index) => ({
    queueItemId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    type: 'file' as const,
    name: `${index}.mp3`,
    file: new File([new Uint8Array(index + 1)], `${index}.mp3`, { type: 'audio/mpeg' }),
    videoId: null,
    playlistId: null,
  }));
  setState('playlist.items', items);
  setState('playlist.currentQueueItemId', items[0]!.queueItemId);
  setState('playlist.revision', 4);
  return items;
}

beforeEach(() => {
  resetState();
  bus.clear();
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  initPlaylist();
});

afterEach(() => {
  clearAllManagedTimers();
  registerProPlaybackMediaEndpoint(null);
  bus.clear();
  vi.restoreAllMocks();
});

describe('standard host playlists', () => {
  it('copies, switches with no track selected, and starts a new session with one playlist', () => {
    const items = populate(3);
    expect(transferTracks([items[0]!.queueItemId, items[2]!.queueItemId], [1], 'copy')).toBe(true);
    expect(getState('playlist.items')).toBe(items);
    expect(getState('playlist.slots')?.slots[1]).toEqual({ count: 2, bytes: 4 });

    expect(switchPlaylist(1)).toBe(true);
    const switched = getState('playlist.items');
    expect(switched.map((item) => item.name)).toEqual(['0.mp3', '2.mp3']);
    expect(
      switched.every((item) => !items.some((old) => old.queueItemId === item.queueItemId)),
    ).toBe(true);
    expect(getState('playlist.currentQueueItemId')).toBeNull();
    expect(getState('playlist.slots')).toEqual({
      activeSlot: 1,
      slots: [
        { count: 3, bytes: 6 },
        { count: 2, bytes: 4 },
        { count: 0, bytes: null },
      ],
    });

    // Another room drops the old inactive playlists and their files.
    setState('playlist.items', []);
    setState('network.sessionCode', '654321');
    expect(getState('playlist.slots')).toEqual({
      activeSlot: 0,
      slots: [
        { count: 0, bytes: null },
        { count: 0, bytes: null },
        { count: 0, bytes: null },
      ],
    });
    expect(switchPlaylist(1)).toBe(true);
    expect(getState('playlist.items')).toEqual([]);
  });

  it('moves tracks out of the active playlist like a deletion', () => {
    const items = populate(3);
    expect(transferTracks([items[1]!.queueItemId], [2], 'move')).toBe(true);
    expect(getState('playlist.items').map((item) => item.queueItemId)).toEqual([
      items[0]!.queueItemId,
      items[2]!.queueItemId,
    ]);
    expect(getState('playlist.slots')?.slots).toEqual([
      { count: 2, bytes: 4 },
      { count: 0, bytes: null },
      { count: 1, bytes: 2 },
    ]);
  });
});

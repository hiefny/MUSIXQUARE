/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { initPreload, schedulePreload } from '../preload.ts';
import { setRepeatMode, setShuffle } from '../../player/playlist.ts';
import type { DataConnection, PlaylistItem } from '../../types/index.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── schedulePreload ─────────────────────────────────────────────────

describe('schedulePreload', () => {
  it('can be called without error', () => {
    expect(() => schedulePreload()).not.toThrow();
  });

  it('does not crash when playlist is empty', () => {
    // playlist.items defaults to [] in initial state
    expect(getState('playlist.items')).toEqual([]);
    expect(() => schedulePreload()).not.toThrow();
  });
});

// ─── Initial Preload State ───────────────────────────────────────────

describe('initial preload state', () => {
  it('isPreloading is false', () => {
    expect(getState('preload.isPreloading')).toBe(false);
  });

  it('nextTrackIndex is -1', () => {
    expect(getState('preload.nextTrackIndex')).toBe(-1);
  });

  it('nextFileBlob is null', () => {
    expect(getState('preload.nextFileBlob')).toBeNull();
  });
});

// ─── Shuffle end-of-pass preload (SA-01) ─────────────────────────────

function makeFileTrack(name: string): PlaylistItem {
  return {
    type: 'file',
    name,
    title: name,
    file: new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/mpeg' }),
    videoId: null,
    playlistId: null,
  };
}

describe('preloadNextTrack shuffle target (SA-01)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Deterministic Fisher-Yates: random=0.99 → j===i every pass → order [0,1,2]
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    setState('playlist.items', [
      makeFileTrack('a.mp3'),
      makeFileTrack('b.mp3'),
      makeFileTrack('c.mp3'),
    ]);
  });

  it('does NOT stage a random preload at shuffle pass end with repeat OFF', async () => {
    setState('playlist.currentTrackIndex', 2); // last slot in order [0,1,2]
    setRepeatMode(0, false);
    setShuffle(true, false);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(600);

    // Pre-fix this staged a random index (0 or 1), which playNextTrack's
    // preferredIndex fast-accept then used to bypass handleEndOfPlaylist.
    expect(getState('preload.nextTrackIndex')).toBe(-1);
    expect(getState('preload.nextFileBlob')).toBeNull();
    expect(getState('preload.isPreloading')).toBe(false);
  });

  it('still preloads the shuffle-next mid-pass', async () => {
    setState('playlist.currentTrackIndex', 0);
    setRepeatMode(0, false);
    setShuffle(true, false);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(600);

    expect(getState('preload.nextTrackIndex')).toBe(1);
    expect(getState('preload.nextFileBlob')).not.toBeNull();
  });

  it('still preloads the wrap target at pass end with repeat ALL', async () => {
    setState('playlist.currentTrackIndex', 2);
    setRepeatMode(1, false);
    setShuffle(true, false);

    schedulePreload(0);
    await vi.advanceTimersByTimeAsync(600);

    expect(getState('preload.nextTrackIndex')).toBe(0);
    expect(getState('preload.nextFileBlob')).not.toBeNull();
  });
});

describe('PLAY_PRELOADED guard', () => {
  it('does not enter preload activation while a system-audio placeholder owns playback', async () => {
    initPreload();
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
    });

    await handleData(
      {
        type: MSG.PLAY_PRELOADED,
        index: 0,
        name: 'song.mp3',
      },
      { open: true, peer: 'host-1' } as DataConnection,
    );

    expect(getState('playback.lifecycle')).toBe(PLAYBACK_STATE.IDLE);
    expect(getState('preload.nextTrackIndex')).toBe(-1);
    expect(getState('preload.nextFileBlob')).toBeNull();
  });
});

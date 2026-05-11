/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MSG, PLAYBACK_STATE } from '../../core/constants.ts';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { handleData } from '../../network/protocol.ts';
import { initPreload, schedulePreload } from '../preload.ts';
import type { DataConnection } from '../../types/index.ts';

beforeEach(() => {
  resetState();
  bus.clear();
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

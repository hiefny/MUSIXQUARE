/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import {
  getCurrentAudioBuffer,
  getLoadToken,
  incrementLoadToken,
  getPendingPlayTime,
  setPendingPlayTime,
} from '../_state.ts';
import { initPlayback } from '../playback.ts';
import { pause, stopPlayerNode, stopAllMedia, updatePlayState } from '../transport.ts';
import {
  isExternalOwner,
  isSystemAudioOwner,
  setPlaybackFilePaused,
  setPlaybackFilePlaying,
  setPlaybackSystemAudioPlaying,
  setPlaybackYouTubePlaying,
} from '../ownership.ts';
import { broadcast } from '../../network/peer.ts';
import type { DataConnection } from '../../types/index.ts';

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  sendToHost: vi.fn(),
}));

beforeEach(() => {
  resetState();
  bus.clear();
  vi.mocked(broadcast).mockClear();
});

// ─── getCurrentAudioBuffer ───────────────────────────────────────────

describe('getCurrentAudioBuffer', () => {
  it('returns null initially', () => {
    expect(getCurrentAudioBuffer()).toBeNull();
  });
});

// ─── getLoadToken / incrementLoadToken ───────────────────────────────

describe('getLoadToken', () => {
  it('returns 0 initially', () => {
    expect(getLoadToken()).toBe(0);
  });
});

describe('incrementLoadToken', () => {
  it('increments and returns new value', () => {
    const initial = getLoadToken();
    const next = incrementLoadToken();
    expect(next).toBe(initial + 1);
    expect(getLoadToken()).toBe(next);
  });
});

// ─── getPendingPlayTime / setPendingPlayTime ─────────────────────────

describe('getPendingPlayTime', () => {
  it('returns undefined initially', () => {
    expect(getPendingPlayTime()).toBeUndefined();
  });
});

describe('setPendingPlayTime', () => {
  it('sets and getPendingPlayTime returns the value', () => {
    setPendingPlayTime(5);
    expect(getPendingPlayTime()).toBe(5);
  });
});

// ─── stopPlayerNode ──────────────────────────────────────────────────

describe('stopPlayerNode', () => {
  it('does not throw when no player node exists', () => {
    expect(() => stopPlayerNode()).not.toThrow();
  });
});

// ─── stopAllMedia ────────────────────────────────────────────────────

describe('stopAllMedia', () => {
  it('resets appState to IDLE', () => {
    setPlaybackFilePlaying();
    stopAllMedia();
    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('requests visualizer fade-out instead of frame hold', () => {
    const fade = vi.fn();
    const hold = vi.fn();
    bus.on('visualizer:fade-out', fade);
    bus.on('visualizer:hold-frame', hold);

    stopAllMedia({ silent: true });

    expect(fade).toHaveBeenCalledTimes(1);
    expect(hold).not.toHaveBeenCalled();
  });

  it('broadcasts PAUSE with reason=transition for silent track-change path', () => {
    setPlaybackFilePlaying();

    stopAllMedia({ silent: true });

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pause', reason: 'transition' }),
    );
  });

  it('clears YouTube mode during a silent audio takeover', () => {
    setPlaybackYouTubePlaying();

    stopAllMedia({ silent: true });

    expect(getState('playback.mode')).toBeNull();
    expect(getState('playback.activity')).toBe('idle');
  });

  it('broadcasts PAUSE with reason=stop for explicit terminal stops', () => {
    setPlaybackFilePlaying();

    stopAllMedia();

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pause', reason: 'stop' }),
    );
  });

  it('can cancel in-flight loads when taking playback ownership away', () => {
    const before = getLoadToken();

    stopAllMedia({ cancelInFlight: true });

    expect(getLoadToken()).toBe(before + 1);
  });

  it('keeps the existing load token on silent track-change stops', () => {
    const before = getLoadToken();

    stopAllMedia({ silent: true });

    expect(getLoadToken()).toBe(before);
  });
});

describe('external playback mode guards', () => {
  it('treats the system-audio receiving placeholder as system-audio ownership', () => {
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioPlaceholder: true,
    });

    expect(isSystemAudioOwner()).toBe(true);
    expect(isExternalOwner()).toBe(true);
  });
});

describe('pause', () => {
  it('holds the current visualizer frame for an explicit pause', () => {
    const hold = vi.fn();
    bus.on('visualizer:hold-frame', hold);
    setPlaybackFilePlaying();

    pause();

    expect(hold).toHaveBeenCalledTimes(1);
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });

  it('does not hold the visualizer for programmatic rendezvous pauses', () => {
    const hold = vi.fn();
    bus.on('visualizer:hold-frame', hold);
    setPlaybackFilePlaying();

    pause(0, { holdVisualizer: false });

    expect(hold).not.toHaveBeenCalled();
    expect(getState('playback.mode')).toBe('file');
    expect(getState('playback.activity')).toBe('paused');
  });
});

// ─── updatePlayState ─────────────────────────────────────────────────

describe('updatePlayState', () => {
  it('emits ui:update-play-state with true', () => {
    const handler = vi.fn();
    bus.on('ui:update-play-state', handler);

    updatePlayState(true);

    expect(handler).toHaveBeenCalledWith(true);
  });

  it('emits ui:update-play-state with false', () => {
    const handler = vi.fn();
    bus.on('ui:update-play-state', handler);

    updatePlayState(false);

    expect(handler).toHaveBeenCalledWith(false);
  });
});

describe('late-join playback bootstrap', () => {
  function emitPeerConnected(send = vi.fn()): typeof send {
    bus.emit('network:peer-connected', { open: true, send } as unknown as DataConnection);
    return send;
  }

  it('sends file PLAY bootstrap without legacy appState payload', () => {
    initPlayback();
    setPlaybackFilePlaying();
    setState('playlist.currentTrackIndex', 0);
    setState('playlist.items', [{ name: 'song.mp3' }]);

    const send = emitPeerConnected();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PLAY,
        index: 0,
        name: 'song.mp3',
      }),
    );
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('state');
  });

  it('sends file PAUSE bootstrap with pause reason but no legacy appState payload', () => {
    initPlayback();
    setPlaybackFilePaused();
    setState('playlist.currentTrackIndex', 1);
    setState('player.pausedAt', 42);

    const send = emitPeerConnected();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.PAUSE,
        index: 1,
        reason: 'pause',
        time: 42,
      }),
    );
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('state');
  });

  it('sends system audio bootstrap without file playback payloads', () => {
    initPlayback();
    setPlaybackSystemAudioPlaying();

    const send = emitPeerConnected();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: MSG.SYSTEM_AUDIO_START });
  });
});

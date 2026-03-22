/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { APP_STATE } from '../../core/constants.ts';

// Mock playback.ts to avoid Tone.js dependency
vi.mock('../playback.ts', () => ({
  getCurrentAudioBuffer: vi.fn(() => null),
}));

// Mock blob-manager.ts
vi.mock('../../core/blob-manager.ts', () => ({
  setVideoElement: vi.fn(),
}));

import { isMediaVideo, isIdleOrPaused, setEngineMode, getVideoElement } from '../video.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

describe('isMediaVideo', () => {
  it('returns false for null blob', () => {
    expect(isMediaVideo(null)).toBe(false);
  });

  it('detects video MIME type from blob.type', () => {
    const blob = new Blob([''], { type: 'video/mp4' });
    expect(isMediaVideo(blob)).toBe(true);
  });

  it('detects video/webm MIME type', () => {
    const blob = new Blob([''], { type: 'video/webm' });
    expect(isMediaVideo(blob)).toBe(true);
  });

  it('returns false for audio MIME type', () => {
    const blob = new Blob([''], { type: 'audio/mpeg' });
    expect(isMediaVideo(blob)).toBe(false);
  });

  it('detects video from metadata.mime', () => {
    const blob = new Blob(['']);
    expect(isMediaVideo(blob, { mime: 'video/mp4' })).toBe(true);
  });

  it('detects video from metadata.type', () => {
    const blob = new Blob(['']);
    expect(isMediaVideo(blob, { type: 'video/mkv' })).toBe(true);
  });

  it('detects video from file extension .mp4', () => {
    const file = new File([''], 'movie.mp4', { type: '' });
    expect(isMediaVideo(file)).toBe(true);
  });

  it('detects video from file extension .mkv', () => {
    const file = new File([''], 'video.mkv', { type: '' });
    expect(isMediaVideo(file)).toBe(true);
  });

  it('detects video from file extension .webm', () => {
    const file = new File([''], 'clip.webm', { type: '' });
    expect(isMediaVideo(file)).toBe(true);
  });

  it('detects video from file extension .mov', () => {
    const file = new File([''], 'clip.mov', { type: '' });
    expect(isMediaVideo(file)).toBe(true);
  });

  it('returns false for audio file extension .mp3', () => {
    const file = new File([''], 'song.mp3', { type: '' });
    expect(isMediaVideo(file)).toBe(false);
  });

  it('returns false for audio file extension .flac', () => {
    const file = new File([''], 'track.flac', { type: '' });
    expect(isMediaVideo(file)).toBe(false);
  });

  it('detects video from metadata.name extension', () => {
    const blob = new Blob(['']);
    expect(isMediaVideo(blob, { name: 'video.mp4' })).toBe(true);
  });

  it('handles case-insensitive extensions', () => {
    const file = new File([''], 'VIDEO.MP4', { type: '' });
    // Extension comparison is .toLowerCase()
    expect(isMediaVideo(file)).toBe(true);
  });

  it('returns false for blob with no type and no name', () => {
    const blob = new Blob(['']);
    expect(isMediaVideo(blob)).toBe(false);
  });
});

describe('isIdleOrPaused', () => {
  it('returns true for IDLE', () => {
    expect(isIdleOrPaused(APP_STATE.IDLE)).toBe(true);
  });

  it('returns true for PAUSED', () => {
    expect(isIdleOrPaused(APP_STATE.PAUSED)).toBe(true);
  });

  it('returns false for PLAYING_AUDIO', () => {
    expect(isIdleOrPaused(APP_STATE.PLAYING_AUDIO)).toBe(false);
  });

  it('returns false for PLAYING_VIDEO', () => {
    expect(isIdleOrPaused(APP_STATE.PLAYING_VIDEO)).toBe(false);
  });

  it('returns false for PLAYING_YOUTUBE', () => {
    expect(isIdleOrPaused(APP_STATE.PLAYING_YOUTUBE)).toBe(false);
  });
});

describe('setEngineMode', () => {
  it('sets PLAYING_AUDIO for mode "audio" when currently playing', () => {
    // Not idle/paused → uses target state
    resetState();
    setState('appState', APP_STATE.PLAYING_AUDIO);
    setEngineMode('audio');
    expect(getState('appState')).toBe(APP_STATE.PLAYING_AUDIO);
  });

  it('sets PAUSED for mode "audio" when currently idle', () => {
    resetState(); // default is IDLE
    setEngineMode('audio');
    expect(getState('appState')).toBe(APP_STATE.PAUSED);
  });

  it('sets PLAYING_YOUTUBE for mode "youtube" even when idle', () => {
    resetState();
    setEngineMode('youtube');
    // YouTube always uses target state (not PAUSED)
    expect(getState('appState')).toBe(APP_STATE.PLAYING_YOUTUBE);
  });

  it('sets PLAYING_VIDEO for mode "video" when playing', () => {
    resetState();
    setState('appState', APP_STATE.PLAYING_AUDIO);
    setEngineMode('video');
    expect(getState('appState')).toBe(APP_STATE.PLAYING_VIDEO);
  });

  it('sets PAUSED for mode "video" when idle', () => {
    resetState();
    setEngineMode('video');
    expect(getState('appState')).toBe(APP_STATE.PAUSED);
  });

  it('emits player:state-changed event', () => {
    const fn = vi.fn();
    bus.on('player:state-changed', fn);
    resetState();
    setEngineMode('youtube');
    expect(fn).toHaveBeenCalledWith(APP_STATE.PLAYING_YOUTUBE);
  });

  it('emits state:appState on engine mode change', () => {
    const fn = vi.fn();
    bus.on('state:appState', fn);
    resetState();
    setEngineMode('audio');
    expect(fn).toHaveBeenCalled();
  });

  it('defaults to IDLE for unknown mode when idle', () => {
    resetState();
    setEngineMode('unknown');
    // isIdleOrPaused(IDLE) → PAUSED, not target
    // Wait — mode 'unknown' → targetState = IDLE, currentState = IDLE,
    // isIdleOrPaused(IDLE) → true → newState = PAUSED
    // mode !== 'youtube' → finalState = PAUSED
    expect(getState('appState')).toBe(APP_STATE.PAUSED);
  });
});

describe('getVideoElement', () => {
  it('returns null before initVideo', () => {
    expect(getVideoElement()).toBe(null);
  });
});

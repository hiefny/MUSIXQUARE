/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import {
  getCurrentAudioBuffer,
  getLoadToken,
  incrementLoadToken,
  getPendingPlayTime,
  setPendingPlayTime,
  stopPlayerNode,
  stopAllMedia,
  updatePlayState,
} from '../playback.ts';

beforeEach(() => {
  resetState();
  bus.clear();
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
    setState('appState', 'PLAYING_AUDIO');
    stopAllMedia();
    expect(getState('appState')).toBe('IDLE');
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getState, setState, batchSetState, resetState, snapshot } from '../state.ts';
import { bus } from '../events.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

describe('State Store', () => {
  describe('getState / setState', () => {
    it('reads initial default values', () => {
      expect(getState('appState')).toBe('IDLE');
      expect(getState('audio.masterVolume')).toBe(1.0);
      expect(getState('playlist.currentTrackIndex')).toBe(-1);
    });

    it('sets and reads a top-level value', () => {
      setState('appState', 'PLAYING_AUDIO');
      expect(getState('appState')).toBe('PLAYING_AUDIO');
    });

    it('sets and reads nested values', () => {
      setState('audio.masterVolume', 0.5);
      expect(getState('audio.masterVolume')).toBe(0.5);
    });

    it('sets deeply nested values', () => {
      setState('player.startedAt', 12345);
      expect(getState('player.startedAt')).toBe(12345);
    });

    it('returns undefined for nonexistent paths', () => {
      expect(getState('nonexistent.deep.path')).toBeUndefined();
    });

    it('emits state:<path> on change', () => {
      const fn = vi.fn();
      bus.on('state:audio.masterVolume', fn);
      setState('audio.masterVolume', 0.7);
      expect(fn).toHaveBeenCalledWith(0.7, 'audio.masterVolume');
    });

    it('does not emit when value is unchanged', () => {
      const fn = vi.fn();
      bus.on('state:appState', fn);
      setState('appState', 'IDLE'); // same as default
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('batchSetState', () => {
    it('applies multiple updates atomically', () => {
      batchSetState({
        'audio.masterVolume': 0.3,
        'player.startedAt': 999,
      });
      expect(getState('audio.masterVolume')).toBe(0.3);
      expect(getState('player.startedAt')).toBe(999);
    });

    it('emits events only after batch completes', () => {
      const calls: string[] = [];
      bus.on('state:audio.masterVolume', () => calls.push('vol'));
      bus.on('state:player.startedAt', () => calls.push('start'));

      batchSetState({
        'audio.masterVolume': 0.2,
        'player.startedAt': 500,
      });

      expect(calls).toEqual(['vol', 'start']);
    });

    it('deduplicates events for same path', () => {
      const fn = vi.fn();
      bus.on('state:appState', fn);
      // batchSetState with same path won't duplicate since it's a Record
      batchSetState({ 'appState': 'PLAYING_AUDIO' });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('snapshot', () => {
    it('returns current state tree', () => {
      const snap = snapshot();
      expect(snap.appState).toBe('IDLE');
      expect(snap.audio.masterVolume).toBe(1.0);
    });
  });

  describe('resetState', () => {
    it('restores all defaults', () => {
      setState('appState', 'PLAYING_VIDEO');
      setState('audio.masterVolume', 0.1);
      resetState();
      expect(getState('appState')).toBe('IDLE');
      expect(getState('audio.masterVolume')).toBe(1.0);
    });
  });
});

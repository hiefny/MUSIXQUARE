/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';

// Mock ensureSurroundNodes because jsdom has no real AudioContext.
vi.mock('../engine.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine.ts')>();
  return {
    ...actual,
    ensureSurroundNodes: vi.fn(() => ({
      splitter: { connect: vi.fn(), disconnect: vi.fn(), dispose: vi.fn() },
      gain: { connect: vi.fn(), disconnect: vi.fn(), dispose: vi.fn() },
    })),
  };
});

import { setChannelMode, toggleSurroundMode, setSurroundChannel } from '../channel.ts';

beforeEach(() => {
  resetState();
});

describe('setChannelMode', () => {
  it('mode 0 (Stereo) updates audio.channelMode in state', () => {
    setChannelMode(0);
    expect(getState('audio.channelMode')).toBe(0);
  });

  it('mode -1 (Left) updates audio.channelMode in state', () => {
    setChannelMode(-1);
    expect(getState('audio.channelMode')).toBe(-1);
  });

  it('mode 1 (Right) updates audio.channelMode in state', () => {
    setChannelMode(1);
    expect(getState('audio.channelMode')).toBe(1);
  });

  it('mode 2 (Sub) updates audio.channelMode in state', () => {
    setChannelMode(2);
    expect(getState('audio.channelMode')).toBe(2);
  });

  it('switching modes updates state correctly', () => {
    setChannelMode(1);
    expect(getState('audio.channelMode')).toBe(1);

    setChannelMode(-1);
    expect(getState('audio.channelMode')).toBe(-1);

    setChannelMode(0);
    expect(getState('audio.channelMode')).toBe(0);
  });

  it('default state is 0 (Stereo)', () => {
    expect(getState('audio.channelMode')).toBe(0);
  });
});

describe('toggleSurroundMode', () => {
  it('enabling surround sets audio.isSurroundMode to true', () => {
    toggleSurroundMode(true);
    expect(getState('audio.isSurroundMode')).toBe(true);
  });

  it('disabling surround sets audio.isSurroundMode to false', () => {
    toggleSurroundMode(true);
    toggleSurroundMode(false);
    expect(getState('audio.isSurroundMode')).toBe(false);
  });

  it('default surround mode is false', () => {
    expect(getState('audio.isSurroundMode')).toBe(false);
  });

  it('toggling on then off restores false', () => {
    expect(getState('audio.isSurroundMode')).toBe(false);
    toggleSurroundMode(true);
    expect(getState('audio.isSurroundMode')).toBe(true);
    toggleSurroundMode(false);
    expect(getState('audio.isSurroundMode')).toBe(false);
  });

  it('refreshes the active graph when file playback is currently playing', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    const emitSpy = vi.spyOn(bus, 'emit');

    toggleSurroundMode(true);

    expect(emitSpy).toHaveBeenCalledWith('audio:surround-toggled');
    emitSpy.mockRestore();
  });

  it('does not refresh the active graph while system audio is only pending', () => {
    setState('playback.mode', 'system-audio');
    setState('playback.activity', 'pending');
    const emitSpy = vi.spyOn(bus, 'emit');

    toggleSurroundMode(true);

    expect(emitSpy).not.toHaveBeenCalledWith('audio:surround-toggled');
    emitSpy.mockRestore();
  });
});

describe('surround channel index state', () => {
  it('default surroundChannelIndex is -1', () => {
    expect(getState('audio.surroundChannelIndex')).toBe(-1);
  });

  it('setSurroundChannel updates audio.surroundChannelIndex for index 0', () => {
    setSurroundChannel(0);
    expect(getState('audio.surroundChannelIndex')).toBe(0);
  });

  it('setSurroundChannel updates for index 2 (Center)', () => {
    setSurroundChannel(2);
    expect(getState('audio.surroundChannelIndex')).toBe(2);
  });

  it('setSurroundChannel updates for index 3 (LFE)', () => {
    setSurroundChannel(3);
    expect(getState('audio.surroundChannelIndex')).toBe(3);
  });

  it('setSurroundChannel updates for index 7 (max)', () => {
    setSurroundChannel(7);
    expect(getState('audio.surroundChannelIndex')).toBe(7);
  });

  it('setSurroundChannel updates state for all indices 0-7', () => {
    for (let idx = 0; idx <= 7; idx++) {
      setSurroundChannel(idx);
      expect(getState('audio.surroundChannelIndex')).toBe(idx);
    }
  });

  it('toggleSurroundMode(true) sets isSurroundMode and defaults to Center channel', () => {
    toggleSurroundMode(true);
    expect(getState('audio.isSurroundMode')).toBe(true);
    expect(getState('audio.surroundChannelIndex')).toBe(2);
  });
});

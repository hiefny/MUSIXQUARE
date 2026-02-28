/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetState, getState } from '../../core/state.ts';
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
  // Note: toggleSurroundMode sets state first, then calls ensureSurroundNodes()
  // which requires real Tone.js AudioContext (unavailable in jsdom).
  // We wrap in try/catch and verify the state update that happens before the Tone.js call.

  it('enabling surround sets audio.isSurroundMode to true', () => {
    try { toggleSurroundMode(true); } catch { /* Tone.js node creation fails in jsdom */ }
    expect(getState('audio.isSurroundMode')).toBe(true);
  });

  it('disabling surround sets audio.isSurroundMode to false', () => {
    try { toggleSurroundMode(true); } catch { /* Tone.js */ }
    try { toggleSurroundMode(false); } catch { /* Tone.js */ }
    expect(getState('audio.isSurroundMode')).toBe(false);
  });

  it('default surround mode is false', () => {
    expect(getState('audio.isSurroundMode')).toBe(false);
  });

  it('toggling on then off restores false', () => {
    expect(getState('audio.isSurroundMode')).toBe(false);
    try { toggleSurroundMode(true); } catch { /* Tone.js */ }
    expect(getState('audio.isSurroundMode')).toBe(true);
    try { toggleSurroundMode(false); } catch { /* Tone.js */ }
    expect(getState('audio.isSurroundMode')).toBe(false);
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

  it('toggleSurroundMode(true) sets isSurroundMode before ensureSurroundNodes throws', () => {
    // toggleSurroundMode calls setState('audio.isSurroundMode', true) first,
    // then ensureSurroundNodes() which throws in jsdom (no real AudioContext).
    // setSurroundChannel(2) is never reached, so surroundChannelIndex stays -1.
    try { toggleSurroundMode(true); } catch { /* Tone.js node creation fails in jsdom */ }
    expect(getState('audio.isSurroundMode')).toBe(true);
    expect(getState('audio.surroundChannelIndex')).toBe(-1); // setSurroundChannel not reached
  });
});

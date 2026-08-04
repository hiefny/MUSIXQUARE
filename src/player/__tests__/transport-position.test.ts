/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { setCurrentAudioBuffer, setPlayerNode } from '../_state.ts';
import { setPlaybackFilePlaying } from '../ownership.ts';

const mocks = vi.hoisted(() => ({
  currentTime: 100,
}));

vi.mock('../../audio/context.ts', () => ({
  getCurrentTime: () => mocks.currentTime,
  getAudioContext: vi.fn(),
  ensureRunning: vi.fn(),
}));

import { getTrackPosition, peekTrackPosition, setLocalManualSyncOffset } from '../transport.ts';

beforeEach(() => {
  resetState();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  mocks.currentTime = 100;
});

describe('transport position', () => {
  it('observes an out-of-range offset without scheduling transport repair', async () => {
    setPlaybackFilePlaying();
    setState('player.startedAt', 90);
    setState('sync.localOffset', 40);

    expect(peekTrackPosition()).toBeGreaterThanOrEqual(50);
    await Promise.resolve();

    expect(getState('sync.localOffset')).toBe(40);
    expect(getState('player.startedAt')).toBe(90);
  });

  it('keeps canonical file time unchanged when only the local output is nudged', () => {
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    setPlaybackFilePlaying();
    setState('player.startedAt', 90);
    setState('sync.localOffset', 0.25);
    const canonicalBefore = getTrackPosition();

    setLocalManualSyncOffset(0.5);

    expect(getTrackPosition()).toBeCloseTo(canonicalBefore, 8);
  });
});

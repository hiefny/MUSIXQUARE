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

import { peekTrackPosition } from '../transport.ts';

beforeEach(() => {
  resetState();
  setCurrentAudioBuffer(null);
  setPlayerNode(null);
  mocks.currentTime = 100;
});

describe('peekTrackPosition', () => {
  it('observes an out-of-range offset without scheduling transport repair', async () => {
    setPlaybackFilePlaying();
    setState('player.startedAt', 90);
    setState('sync.localOffset', 40);

    expect(peekTrackPosition()).toBeGreaterThanOrEqual(50);
    await Promise.resolve();

    expect(getState('sync.localOffset')).toBe(40);
    expect(getState('player.startedAt')).toBe(90);
  });
});

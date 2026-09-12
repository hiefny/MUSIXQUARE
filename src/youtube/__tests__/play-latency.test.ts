import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { getEffectiveYouTubePlayLatencyMs } from '../play-latency.ts';

const platform = vi.hoisted(() => ({ android: false }));
vi.mock('../../core/platform.ts', () => ({
  get IS_ANDROID() {
    return platform.android;
  },
}));

beforeEach(() => {
  resetState();
  platform.android = false;
});

describe('YouTube local play latency', () => {
  it.each([
    [125, 125],
    [-20, 0],
    [900, 600],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])('normalizes stored latency %s to %s milliseconds', (stored, expected) => {
    setState('youtube.guestPlayLatency', stored);
    expect(getEffectiveYouTubePlayLatencyMs()).toBe(expected);
  });

  it('retains the Android minimum while using learned values above it', () => {
    platform.android = true;
    setState('youtube.guestPlayLatency', 125);
    expect(getEffectiveYouTubePlayLatencyMs()).toBe(250);
    setState('youtube.guestPlayLatency', 350);
    expect(getEffectiveYouTubePlayLatencyMs()).toBe(350);
  });
});

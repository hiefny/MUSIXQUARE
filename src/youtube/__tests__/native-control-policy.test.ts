import { describe, expect, it } from 'vitest';

import { decideNativeYouTubeControlRoute } from '../native-control-policy.ts';

describe('native YouTube control routing policy', () => {
  it('routes a standard host to room rendezvous authority', () => {
    expect(
      decideNativeYouTubeControlRoute({
        action: 'play',
        roomKind: 'standard',
        canControlPlayback: true,
        hasStandardHostConnection: false,
      }),
    ).toBe('standard-host');
  });

  it('routes a delegated standard controller back to the host', () => {
    expect(
      decideNativeYouTubeControlRoute({
        action: 'pause',
        roomKind: 'standard',
        canControlPlayback: true,
        hasStandardHostConnection: true,
      }),
    ).toBe('standard-controller');
  });

  it('routes every PRO controller through server authority', () => {
    expect(
      decideNativeYouTubeControlRoute({
        action: 'play',
        roomKind: 'pro',
        canControlPlayback: true,
        hasStandardHostConnection: false,
      }),
    ).toBe('pro-controller');
  });

  it('keeps listener pause local and listener play on the rejoin path', () => {
    const base = {
      roomKind: 'pro' as const,
      canControlPlayback: false,
      hasStandardHostConnection: false,
    };
    expect(decideNativeYouTubeControlRoute({ ...base, action: 'pause' })).toBe('local-pause');
    expect(decideNativeYouTubeControlRoute({ ...base, action: 'play' })).toBe('local-rejoin');
  });
});

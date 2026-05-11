import { describe, expect, it } from 'vitest';
import { getFeatureFlagDefaults, isFeatureFlagEnabled } from '../feature-flags.ts';

describe('feature flags', () => {
  it('keeps compatibility migration flags on by default', () => {
    expect(isFeatureFlagEnabled('syncPongLegacyAppStateEmit')).toBe(true);
    expect(isFeatureFlagEnabled('syncPongLegacyAppStateAccept')).toBe(true);
  });

  it('keeps the appState source-of-truth flip disabled by default', () => {
    expect(isFeatureFlagEnabled('appStateSourceOfTruthFlip')).toBe(false);
  });

  it('exposes immutable default values for diagnostics', () => {
    expect(getFeatureFlagDefaults()).toMatchObject({
      syncPongLegacyAppStateEmit: true,
      syncPongLegacyAppStateAccept: true,
      appStateSourceOfTruthFlip: false,
    });
  });
});

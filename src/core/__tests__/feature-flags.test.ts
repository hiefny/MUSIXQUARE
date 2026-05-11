import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFeatureFlagDefaults, isFeatureFlagEnabled } from '../feature-flags.ts';

describe('feature flags', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps legacy sync appState compatibility off by default', () => {
    expect(isFeatureFlagEnabled('syncPongLegacyAppStateEmit')).toBe(false);
    expect(isFeatureFlagEnabled('syncPongLegacyAppStateAccept')).toBe(false);
  });

  it('keeps the appState source-of-truth flip disabled by default', () => {
    expect(isFeatureFlagEnabled('appStateSourceOfTruthFlip')).toBe(false);
  });

  it('exposes immutable default values for diagnostics', () => {
    expect(getFeatureFlagDefaults()).toMatchObject({
      syncPongLegacyAppStateEmit: false,
      syncPongLegacyAppStateAccept: false,
      appStateSourceOfTruthFlip: false,
    });
    expect(Object.isFrozen(getFeatureFlagDefaults())).toBe(true);
  });

  it('honors boolean-like env overrides on import', async () => {
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_EMIT', 'false');
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_ACCEPT', '0');
    vi.stubEnv('VITE_MUSIXQUARE_APPSTATE_SOURCE_OF_TRUTH_FLIP', 'yes');
    vi.resetModules();

    const flags = await import('../feature-flags.ts');

    expect(flags.isFeatureFlagEnabled('syncPongLegacyAppStateEmit')).toBe(false);
    expect(flags.isFeatureFlagEnabled('syncPongLegacyAppStateAccept')).toBe(false);
    expect(flags.isFeatureFlagEnabled('appStateSourceOfTruthFlip')).toBe(true);
  });

  it('ignores malformed env overrides and falls back to defaults', async () => {
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_EMIT', 'maybe');
    vi.stubEnv('VITE_MUSIXQUARE_APPSTATE_SOURCE_OF_TRUTH_FLIP', 'later');
    vi.resetModules();

    const flags = await import('../feature-flags.ts');

    expect(flags.isFeatureFlagEnabled('syncPongLegacyAppStateEmit')).toBe(false);
    expect(flags.isFeatureFlagEnabled('appStateSourceOfTruthFlip')).toBe(false);
  });

  it('can re-enable legacy sync compatibility as a rollback switch', async () => {
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_EMIT', 'true');
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_ACCEPT', 'on');
    vi.resetModules();

    const flags = await import('../feature-flags.ts');

    expect(flags.isFeatureFlagEnabled('syncPongLegacyAppStateEmit')).toBe(true);
    expect(flags.isFeatureFlagEnabled('syncPongLegacyAppStateAccept')).toBe(true);
  });
});

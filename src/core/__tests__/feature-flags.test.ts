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

  it('exposes immutable default values for diagnostics', () => {
    expect(getFeatureFlagDefaults()).toMatchObject({
      syncPongLegacyAppStateEmit: false,
      syncPongLegacyAppStateAccept: false,
    });
    expect(Object.isFrozen(getFeatureFlagDefaults())).toBe(true);
  });

  it('honors boolean-like env overrides on import', async () => {
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_EMIT', 'false');
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_ACCEPT', '0');
    vi.resetModules();

    const flags = await import('../feature-flags.ts');

    expect(flags.isFeatureFlagEnabled('syncPongLegacyAppStateEmit')).toBe(false);
    expect(flags.isFeatureFlagEnabled('syncPongLegacyAppStateAccept')).toBe(false);
  });

  it('ignores malformed env overrides and falls back to defaults', async () => {
    vi.stubEnv('VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_EMIT', 'maybe');
    vi.resetModules();

    const flags = await import('../feature-flags.ts');

    expect(flags.isFeatureFlagEnabled('syncPongLegacyAppStateEmit')).toBe(false);
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

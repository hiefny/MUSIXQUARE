/**
 * Central feature flags for staged compatibility migrations.
 *
 * Defaults describe the current migration posture. Override via Vite env only
 * for controlled preview builds or rollback switches.
 */

const FEATURE_FLAG_DEFAULTS = Object.freeze({
  syncPongLegacyAppStateEmit: false,
  syncPongLegacyAppStateAccept: false,
} as const);

export type FeatureFlagName = keyof typeof FEATURE_FLAG_DEFAULTS;

const ENV_OVERRIDES: Partial<Record<FeatureFlagName, string | boolean | undefined>> = {
  syncPongLegacyAppStateEmit: import.meta.env.VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_EMIT,
  syncPongLegacyAppStateAccept: import.meta.env.VITE_MUSIXQUARE_SYNC_PONG_LEGACY_APPSTATE_ACCEPT,
};

function parseBooleanOverride(value: string | boolean | undefined): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

export function isFeatureFlagEnabled(flag: FeatureFlagName): boolean {
  return parseBooleanOverride(ENV_OVERRIDES[flag]) ?? FEATURE_FLAG_DEFAULTS[flag];
}

export function getFeatureFlagDefaults(): Readonly<typeof FEATURE_FLAG_DEFAULTS> {
  return FEATURE_FLAG_DEFAULTS;
}

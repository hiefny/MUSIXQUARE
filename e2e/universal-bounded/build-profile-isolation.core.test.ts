import { expect, test, type Page } from '@playwright/test';
import {
  LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE,
  UNIVERSAL_BUILD_PROFILE_EVIDENCE,
  V2_CURRENT_BUILD_PROFILE_EVIDENCE,
} from './build-profile-evidence.ts';
import { FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED } from '../../src/player/file-playback-production-release-latch.ts';

interface RuntimeProfileEvidence {
  readonly schemaVersion: number;
  readonly buildProfileMarker: string;
  readonly profileId: string;
  readonly engine: string;
  readonly policyMode: string;
  readonly semanticPlaybackCohortId: string;
  readonly enabled: boolean;
}

interface RuntimeProfileBridge extends Omit<RuntimeProfileEvidence, 'enabled'> {
  readonly enabled: boolean | (() => boolean);
}

const UNIVERSAL_BRIDGE_MARKER = '__MUSIXQUARE_FILE_PLAYBACK_E2E__';
const CURRENT_BRIDGE_MARKER = '__MUSIXQUARE_FILE_PLAYBACK_CURRENT_ISOLATION__';
const PRODUCTION_LATCH_BRIDGE_MARKER = '__MUSIXQUARE_FILE_PLAYBACK_PRODUCTION_LATCH_ISOLATION__';

async function readRuntimeProfile(
  page: Page,
  url: string,
  bridgeMarker: string,
): Promise<RuntimeProfileEvidence> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() =>
      page.evaluate(
        (marker) => typeof (globalThis as unknown as Record<string, unknown>)[marker] === 'object',
        bridgeMarker,
      ),
    )
    .toBe(true);

  return page.evaluate((marker) => {
    const bridge = (globalThis as unknown as Record<string, unknown>)[marker] as
      | RuntimeProfileBridge
      | undefined;
    if (!bridge) throw new Error(`Missing build profile bridge: ${marker}`);
    return {
      schemaVersion: bridge.schemaVersion,
      buildProfileMarker: bridge.buildProfileMarker,
      profileId: bridge.profileId,
      engine: bridge.engine,
      policyMode: bridge.policyMode,
      semanticPlaybackCohortId: bridge.semanticPlaybackCohortId,
      enabled: typeof bridge.enabled === 'function' ? bridge.enabled() : bridge.enabled,
    };
  }, bridgeMarker);
}

function expectedSnapshot(
  evidence:
    | typeof LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE
    | typeof V2_CURRENT_BUILD_PROFILE_EVIDENCE
    | typeof UNIVERSAL_BUILD_PROFILE_EVIDENCE,
): RuntimeProfileEvidence {
  return {
    schemaVersion: 1,
    buildProfileMarker: evidence.artifactMarker,
    profileId: evidence.profileId,
    engine: evidence.engine,
    policyMode: evidence.policyMode,
    semanticPlaybackCohortId: evidence.semanticPlaybackCohortId,
    enabled: evidence.engine === 'v2',
  };
}

test('executes the exact isolated universal profile and cohort', async ({ page }) => {
  const snapshot = await readRuntimeProfile(
    page,
    'http://127.0.0.1:4174/',
    UNIVERSAL_BRIDGE_MARKER,
  );

  expect(snapshot).toEqual(expectedSnapshot(UNIVERSAL_BUILD_PROFILE_EVIDENCE));
});

test('executes the production current-route artifact selected by the tracked latch', async ({
  page,
}) => {
  const expected = FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED
    ? V2_CURRENT_BUILD_PROFILE_EVIDENCE
    : LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE;
  const snapshot = await readRuntimeProfile(page, 'http://127.0.0.1:4175/', CURRENT_BRIDGE_MARKER);

  expect(snapshot).toEqual(expectedSnapshot(expected));
});

test('executes the both-flags production artifact selected by the tracked latch', async ({
  page,
}) => {
  const expected = FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED
    ? UNIVERSAL_BUILD_PROFILE_EVIDENCE
    : LEGACY_CURRENT_BUILD_PROFILE_EVIDENCE;
  const snapshot = await readRuntimeProfile(
    page,
    'http://127.0.0.1:4176/',
    PRODUCTION_LATCH_BRIDGE_MARKER,
  );

  expect(snapshot).toEqual(expectedSnapshot(expected));
});

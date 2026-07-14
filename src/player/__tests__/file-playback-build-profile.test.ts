import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { FILE_PLAYBACK_SESSION_PROTOCOL_VERSION } from '../../network/file-playback-session-handshake.ts';
import {
  FILE_PLAYBACK_LEGACY_CURRENT_SEMANTIC_COHORT_ID,
  FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
  FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
} from '../file-playback-semantic-cohort.ts';

const MODULE_PATH = '../file-playback-build-profile.ts';
const RELEASE_LATCH_MODULE_PATH = '../file-playback-production-release-latch.ts';

function installProductionEnvironment(options: {
  readonly v2?: string;
  readonly universalV1?: string;
  readonly mode?: string;
}): void {
  vi.stubEnv('DEV', false);
  vi.stubEnv('PROD', true);
  vi.stubEnv('MODE', options.mode ?? 'production');
  vi.stubEnv('VITE_MUSIXQUARE_FILE_ENGINE_V2', options.v2);
  vi.stubEnv('VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1', options.universalV1);
  vi.stubGlobal('location', { search: '' });
}

async function loadProfile(options: { readonly productionLatch?: boolean } = {}) {
  if (options.productionLatch !== undefined) {
    vi.doMock(RELEASE_LATCH_MODULE_PATH, () => ({
      FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED: options.productionLatch,
    }));
  }
  return import(MODULE_PATH);
}

describe('file playback immutable build profile', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock(RELEASE_LATCH_MODULE_PATH);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('keeps the ordinary production artifact on legacy/current even if only the route flag leaks', async () => {
    installProductionEnvironment({ universalV1: '1' });

    const profile = (await loadProfile()).getFilePlaybackBuildProfile();

    expect(profile).toMatchObject({
      id: 'legacy-current',
      engine: 'legacy',
      boundedRouteMode: 'current',
      boundedRoutePolicy: null,
    });
    expect(profile.semanticPlaybackCohortId).toContain('engine=legacy;route=current');
  });

  it('distinguishes V2/current without changing omitted-policy product behavior', async () => {
    installProductionEnvironment({ v2: '1' });

    const profile = (await loadProfile({ productionLatch: true })).getFilePlaybackBuildProfile();

    expect(profile).toMatchObject({
      id: 'v2-current',
      engine: 'v2',
      boundedRouteMode: 'current',
      boundedRoutePolicy: null,
    });
    expect(profile.semanticPlaybackCohortId).toContain('session=v2;route=current');
  });

  it.each([undefined, '0', '1'])(
    'keeps stale production V2 flags on legacy/current while the tracked latch is OFF (universal=%s)',
    async (universalV1) => {
      installProductionEnvironment({ v2: '1', universalV1 });

      const profile = (await loadProfile()).getFilePlaybackBuildProfile();

      expect(profile).toMatchObject({
        id: 'legacy-current',
        engine: 'legacy',
        boundedRouteMode: 'current',
        boundedRoutePolicy: null,
        semanticPlaybackCohortId: FILE_PLAYBACK_LEGACY_CURRENT_SEMANTIC_COHORT_ID,
      });
    },
  );

  it('selects the exact universal cohort in the isolated E2E mode while the latch is OFF', async () => {
    installProductionEnvironment({ v2: '1', universalV1: '1', mode: 'e2e-universal' });

    const profile = (await loadProfile()).getFilePlaybackBuildProfile();

    expect(profile).toMatchObject({
      id: 'v2-universal-v1',
      engine: 'v2',
      boundedRouteMode: 'universal-v1',
      boundedRoutePolicy: {
        mode: 'universal-v1',
        aacBackendId: 'webcodecs',
        m4aBackendId: 'webcodecs',
      },
    });
    expect(profile.semanticPlaybackCohortId).toContain('mp3=mpg123-1.0.3');
    expect(profile.semanticPlaybackCohortId).toContain('adts-aac=webcodecs-v1');
    expect(profile.semanticPlaybackCohortId).toContain('m4a-aac=webcodecs-v1');
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it('selects the exact universal cohort in production only after the tracked latch is ON', async () => {
    installProductionEnvironment({ v2: '1', universalV1: '1' });

    const profile = (await loadProfile({ productionLatch: true })).getFilePlaybackBuildProfile();

    expect(profile).toMatchObject({
      id: 'v2-universal-v1',
      engine: 'v2',
      boundedRouteMode: 'universal-v1',
      boundedRoutePolicy: {
        mode: 'universal-v1',
      },
      semanticPlaybackCohortId: FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
    });
  });

  it('still requires the exact V2 flag after the production latch turns ON', async () => {
    installProductionEnvironment({ universalV1: '1' });

    expect((await loadProfile({ productionLatch: true })).getFilePlaybackBuildProfile().id).toBe(
      'legacy-current',
    );
  });

  it('selects V2/current after release when the optional universal flag is absent', async () => {
    installProductionEnvironment({ v2: '1' });

    expect((await loadProfile({ productionLatch: true })).getFilePlaybackBuildProfile().id).toBe(
      'v2-current',
    );
  });

  it.each([
    {
      label: 'isolated E2E mode without the V2 flag',
      environment: { universalV1: '1', mode: 'e2e-universal' },
    },
    {
      label: 'isolated E2E mode without the universal flag',
      environment: { v2: '1', mode: 'e2e-universal' },
    },
  ])('requires both exact build flags for the $label', async (testCase) => {
    installProductionEnvironment(testCase.environment);

    expect((await loadProfile()).getFilePlaybackBuildProfile().id).toBe('legacy-current');
  });

  it.each(['e2e-universal-preview', 'E2E-UNIVERSAL', ' e2e-universal ', 'e2e'])(
    'does not treat a near-match build mode as the isolated E2E release boundary: %s',
    async (mode) => {
      installProductionEnvironment({ v2: '1', universalV1: '1', mode });

      expect((await loadProfile()).getFilePlaybackBuildProfile().id).toBe('legacy-current');
    },
  );

  it.each([undefined, '', 'true', '01', ' 1 ', '0'])(
    'rejects a non-exact universal route build flag: %s',
    async (universalV1) => {
      installProductionEnvironment({ v2: '1', universalV1 });

      expect((await loadProfile({ productionLatch: true })).getFilePlaybackBuildProfile().id).toBe(
        'v2-current',
      );
    },
  );

  it('keeps the module-evaluation profile after environment changes', async () => {
    installProductionEnvironment({ v2: '1' });
    const module = await loadProfile({ productionLatch: true });

    vi.stubEnv('VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1', '1');
    vi.stubEnv('MODE', 'e2e-universal');

    expect(module.getFilePlaybackBuildProfile().id).toBe('v2-current');
  });

  it('pins protocol and Wasm decoder package identities into the semantic IDs', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const flacVersion = packageJson.dependencies?.['@wasm-audio-decoders/flac'];
    const mp3Version = packageJson.dependencies?.['mpg123-decoder'];

    expect(FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID).toContain(
      `session=v${FILE_PLAYBACK_SESSION_PROTOCOL_VERSION}`,
    );
    expect(FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID).toContain(
      `session=v${FILE_PLAYBACK_SESSION_PROTOCOL_VERSION}`,
    );
    expect(FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID).toContain(`flac=wasm-${flacVersion}`);
    expect(FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID).toContain(`mp3=mpg123-${mp3Version}`);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { FILE_PLAYBACK_SESSION_PROTOCOL_VERSION } from '../../network/file-playback-session-handshake.ts';
import {
  FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
  FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID,
} from '../file-playback-semantic-cohort.ts';

const MODULE_PATH = '../file-playback-build-profile.ts';

function installProductionEnvironment(options: {
  readonly v2?: string;
  readonly universalV1?: string;
}): void {
  vi.stubEnv('DEV', false);
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_MUSIXQUARE_FILE_ENGINE_V2', options.v2);
  vi.stubEnv('VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1', options.universalV1);
  vi.stubGlobal('location', { search: '' });
}

async function loadProfile() {
  return import(MODULE_PATH);
}

describe('file playback immutable build profile', () => {
  beforeEach(() => {
    vi.resetModules();
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

    const profile = (await loadProfile()).getFilePlaybackBuildProfile();

    expect(profile).toMatchObject({
      id: 'v2-current',
      engine: 'v2',
      boundedRouteMode: 'current',
      boundedRoutePolicy: null,
    });
    expect(profile.semanticPlaybackCohortId).toContain('session=v2;route=current');
  });

  it('selects one exact universal V2 route and decoder cohort only when both build flags match', async () => {
    installProductionEnvironment({ v2: '1', universalV1: '1' });

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

  it.each([undefined, '', 'true', '01', ' 1 ', '0'])(
    'rejects a non-exact universal route build flag: %s',
    async (universalV1) => {
      installProductionEnvironment({ v2: '1', universalV1 });

      expect((await loadProfile()).getFilePlaybackBuildProfile().id).toBe('v2-current');
    },
  );

  it('keeps the module-evaluation profile after environment changes', async () => {
    installProductionEnvironment({ v2: '1' });
    const module = await loadProfile();

    vi.stubEnv('VITE_MUSIXQUARE_FILE_ENGINE_UNIVERSAL_V1', '1');

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
    expect(FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID).toContain(
      `flac=wasm-${flacVersion}`,
    );
    expect(FILE_PLAYBACK_V2_UNIVERSAL_V1_SEMANTIC_COHORT_ID).toContain(
      `mp3=mpg123-${mp3Version}`,
    );
  });
});

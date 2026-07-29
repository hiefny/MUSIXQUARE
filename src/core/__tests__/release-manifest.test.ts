import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = resolve('scripts/release-manifest.mjs');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const temporaryDirectories: string[] = [];

type Manifest = {
  schemaVersion: number;
  release: {
    productVersion: string;
    serviceWorkerCacheEpoch: number;
  };
  commit: string;
  validationProfile: string | null;
};

function createFixture(): { dist: string; manifest: string } {
  const directory = mkdtempSync(resolve(tmpdir(), 'mxqr-release-manifest-'));
  temporaryDirectories.push(directory);
  const dist = resolve(directory, 'dist');
  const manifest = resolve(directory, 'release-manifest.json');
  mkdirSync(dist);
  writeFileSync(resolve(dist, 'index.html'), '<!doctype html>\n', 'utf8');
  return { dist, manifest };
}

function runManifest(
  mode: 'create' | 'verify',
  dist: string,
  manifest: string,
  validationProfile?: string,
  environment: NodeJS.ProcessEnv = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_SHA: COMMIT,
    npm_config_user_agent: 'npm/10.9.0 node/v22.0.0 win32 x64',
  };
  delete env.RELEASE_VALIDATION_PROFILE;
  if (validationProfile) env.RELEASE_VALIDATION_PROFILE = validationProfile;
  Object.assign(env, environment);

  return spawnSync(process.execPath, [SCRIPT_PATH, mode, dist, manifest], {
    encoding: 'utf8',
    env,
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('release manifest validation profile', () => {
  it('records and verifies the selected release validation profile', () => {
    const { dist, manifest } = createFixture();

    const createResult = runManifest('create', dist, manifest, 'core-smoke');
    expect(createResult.status, createResult.stderr).toBe(0);

    const payload = JSON.parse(readFileSync(manifest, 'utf8')) as Manifest;
    const product = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(payload).toMatchObject({
      schemaVersion: 2,
      release: {
        productVersion: product.version,
        serviceWorkerCacheEpoch: expect.any(Number),
      },
      commit: COMMIT,
      validationProfile: 'core-smoke',
    });

    const verifyResult = runManifest('verify', dist, manifest, 'core-smoke');
    expect(verifyResult.status, verifyResult.stderr).toBe(0);
  });

  it('rejects a candidate verified under a different validation profile', () => {
    const { dist, manifest } = createFixture();
    expect(runManifest('create', dist, manifest, 'core-smoke').status).toBe(0);

    const verifyResult = runManifest('verify', dist, manifest, 'full-e2e');

    expect(verifyResult.status).not.toBe(0);
    expect(verifyResult.stderr).toContain(
      'Release manifest validation profile core-smoke does not match full-e2e.',
    );
  });

  it('keeps local manifests compatible when no profile is selected', () => {
    const { dist, manifest } = createFixture();

    const createResult = runManifest('create', dist, manifest);
    expect(createResult.status, createResult.stderr).toBe(0);

    const payload = JSON.parse(readFileSync(manifest, 'utf8')) as Manifest;
    expect(payload.validationProfile).toBeNull();
    expect(runManifest('verify', dist, manifest).status).toBe(0);
  });

  it('verifies an exact-SHA candidate reused from a successful CI run', () => {
    const { dist, manifest } = createFixture();
    const createResult = runManifest('create', dist, manifest, 'main-ci', {
      GITHUB_RUN_ID: '1234',
      GITHUB_RUN_ATTEMPT: '2',
    });
    expect(createResult.status, createResult.stderr).toBe(0);

    const verifyResult = runManifest('verify', dist, manifest, 'main-ci', {
      GITHUB_RUN_ID: '5678',
      GITHUB_RUN_ATTEMPT: '1',
      RELEASE_SOURCE_RUN_ID: '1234',
      RELEASE_SOURCE_RUN_ATTEMPT: '2',
    });

    expect(verifyResult.status, verifyResult.stderr).toBe(0);
  });

  it('rejects a candidate from a different source CI run', () => {
    const { dist, manifest } = createFixture();
    expect(
      runManifest('create', dist, manifest, 'main-ci', {
        GITHUB_RUN_ID: '1234',
        GITHUB_RUN_ATTEMPT: '2',
      }).status,
    ).toBe(0);

    const verifyResult = runManifest('verify', dist, manifest, 'main-ci', {
      GITHUB_RUN_ID: '5678',
      GITHUB_RUN_ATTEMPT: '1',
      RELEASE_SOURCE_RUN_ID: '9999',
      RELEASE_SOURCE_RUN_ATTEMPT: '2',
    });

    expect(verifyResult.status).not.toBe(0);
    expect(verifyResult.stderr).toContain(
      'Release manifest run 1234 does not match candidate source run 9999.',
    );
  });

  it('rejects an artifact manifest with a different product release identity', () => {
    const { dist, manifest } = createFixture();
    expect(runManifest('create', dist, manifest).status).toBe(0);
    const payload = JSON.parse(readFileSync(manifest, 'utf8')) as Manifest;
    payload.release.productVersion = '999.0.0';
    writeFileSync(manifest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    const verifyResult = runManifest('verify', dist, manifest);

    expect(verifyResult.status).not.toBe(0);
    expect(verifyResult.stderr).toContain('Release manifest product version 999.0.0');
  });
});

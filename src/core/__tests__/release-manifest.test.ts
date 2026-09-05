import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createReleaseManifest,
  verifyReleaseManifest,
} from '../../../scripts/release-manifest.mts';

const SCRIPT_PATH = resolve('scripts/release-manifest.mts');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const temporaryDirectories: string[] = [];

type Manifest = {
  schemaVersion: number;
  release: {
    productVersion: string;
    serviceWorkerCacheEpoch: number;
  };
  commit: string;
  runId: string | null;
  runAttempt: string | null;
  target: string | null;
  validationProfile: string | null;
  tools: {
    wrangler: string;
  };
  files: Array<{
    path: string;
    size: number;
    sha256: string;
  }>;
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
  delete env.GITHUB_RUN_ID;
  delete env.GITHUB_RUN_ATTEMPT;
  delete env.RELEASE_SOURCE_RUN_ID;
  delete env.RELEASE_SOURCE_RUN_ATTEMPT;
  delete env.RELEASE_VALIDATION_PROFILE;
  delete env.RELEASE_TARGET;
  if (validationProfile) env.RELEASE_VALIDATION_PROFILE = validationProfile;
  Object.assign(env, environment);

  try {
    const options = {
      distDirectory: dist,
      manifestPath: manifest,
      environment: env,
      log: () => {},
    };
    if (mode === 'create') createReleaseManifest(options);
    else verifyReleaseManifest(options);
    return { status: 0, stderr: '' };
  } catch (error) {
    return { status: 1, stderr: error instanceof Error ? error.message : String(error) };
  }
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('release manifest validation profile', () => {
  it('runs the standalone CLI without npm environment hints', () => {
    const { dist, manifest } = createFixture();
    const environment: NodeJS.ProcessEnv = { ...process.env, GITHUB_SHA: COMMIT };
    for (const key of Object.keys(environment)) {
      if (['npm_config_user_agent', 'npm_execpath'].includes(key.toLowerCase())) {
        delete environment[key];
      }
    }
    const result = spawnSync(process.execPath, [SCRIPT_PATH, 'create', dist, manifest], {
      encoding: 'utf8',
      env: environment,
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(readFileSync(manifest, 'utf8')) as {
      tools: { npm: string };
    };
    expect(payload.tools.npm).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  });

  it('preserves the executable CLI boundary', () => {
    const { dist, manifest } = createFixture();
    const environment = {
      ...process.env,
      GITHUB_SHA: COMMIT,
      npm_config_user_agent: 'npm/10.9.0 node/v22.0.0 win32 x64',
    };
    const createResult = spawnSync(process.execPath, [SCRIPT_PATH, 'create', dist, manifest], {
      encoding: 'utf8',
      env: environment,
    });
    expect(createResult.status, createResult.stderr).toBe(0);
    expect(existsSync(manifest)).toBe(true);
    const payload = JSON.parse(readFileSync(manifest, 'utf8')) as Manifest;
    expect(payload).toMatchObject({
      schemaVersion: 2,
      commit: COMMIT,
      files: [
        {
          path: 'index.html',
          size: Buffer.byteLength('<!doctype html>\n'),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      ],
    });

    const verifyResult = spawnSync(process.execPath, [SCRIPT_PATH, 'verify', dist, manifest], {
      encoding: 'utf8',
      env: environment,
    });
    expect(verifyResult.status, verifyResult.stderr).toBe(0);

    writeFileSync(resolve(dist, 'index.html'), '<!doctype html><title>changed</title>\n', 'utf8');
    const mismatchResult = spawnSync(process.execPath, [SCRIPT_PATH, 'verify', dist, manifest], {
      encoding: 'utf8',
      env: environment,
    });
    expect(mismatchResult.status).not.toBe(0);
    expect(mismatchResult.stderr).toContain('Release artifact mismatch at index.html.');
  });

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
    expect(payload.runId).toBeNull();
    expect(payload.runAttempt).toBeNull();
    expect(payload.validationProfile).toBeNull();
    expect(runManifest('verify', dist, manifest).status).toBe(0);
  });

  it('records the installed Wrangler version instead of an environment label', () => {
    const { dist, manifest } = createFixture();
    const createResult = runManifest('create', dist, manifest, undefined, {
      WRANGLER_VERSION: '0.0.0',
    });
    expect(createResult.status, createResult.stderr).toBe(0);

    const payload = JSON.parse(readFileSync(manifest, 'utf8')) as Manifest;
    const installedWrangler = JSON.parse(
      readFileSync('node_modules/wrangler/package.json', 'utf8'),
    ) as { version: string };
    expect(payload.tools.wrangler).toBe(installedWrangler.version);
    expect(payload.tools.wrangler).not.toBe('0.0.0');

    const verifyResult = runManifest('verify', dist, manifest, undefined, {
      WRANGLER_VERSION: '999.0.0',
    });
    expect(verifyResult.status, verifyResult.stderr).toBe(0);
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

  it('reuses an all-scope main-CI candidate for a partial production target', () => {
    const { dist, manifest } = createFixture();
    const createResult = runManifest('create', dist, manifest, 'main-ci', {
      GITHUB_RUN_ID: '1234',
      GITHUB_RUN_ATTEMPT: '2',
      RELEASE_TARGET: 'all',
    });
    expect(createResult.status, createResult.stderr).toBe(0);

    const payload = JSON.parse(readFileSync(manifest, 'utf8')) as Manifest;
    expect(payload.target).toBe('all');

    const verifyResult = runManifest('verify', dist, manifest, 'main-ci', {
      GITHUB_RUN_ID: '5678',
      GITHUB_RUN_ATTEMPT: '1',
      RELEASE_SOURCE_RUN_ID: '1234',
      RELEASE_SOURCE_RUN_ATTEMPT: '2',
      RELEASE_TARGET: 'app',
    });

    expect(verifyResult.status, verifyResult.stderr).toBe(0);
  });

  it('does not reuse a narrow or non-main-CI candidate for another target', () => {
    const narrow = createFixture();
    expect(
      runManifest('create', narrow.dist, narrow.manifest, 'main-ci', {
        RELEASE_TARGET: 'app',
      }).status,
    ).toBe(0);
    const narrowVerify = runManifest('verify', narrow.dist, narrow.manifest, 'main-ci', {
      RELEASE_TARGET: 'signaling',
    });
    expect(narrowVerify.status).not.toBe(0);
    expect(narrowVerify.stderr).toContain('Release manifest target app does not match signaling.');

    const weak = createFixture();
    expect(
      runManifest('create', weak.dist, weak.manifest, 'core-smoke', {
        RELEASE_TARGET: 'all',
      }).status,
    ).toBe(0);
    const weakVerify = runManifest('verify', weak.dist, weak.manifest, 'core-smoke', {
      RELEASE_TARGET: 'app',
    });
    expect(weakVerify.status).not.toBe(0);
    expect(weakVerify.stderr).toContain('Release manifest target all does not match app.');
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

  it('fails closed before parsing when the release manifest is missing', () => {
    const { dist, manifest } = createFixture();

    const verifyResult = runManifest('verify', dist, manifest);

    expect(verifyResult.status).toBe(1);
    expect(verifyResult.stderr).toContain('Release manifest does not exist');
  });

  it('rejects a non-canonical commit before writing a release manifest', () => {
    const { dist, manifest } = createFixture();
    const result = runManifest('create', dist, manifest, undefined, {
      GITHUB_SHA: '0123456789ab',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('full lowercase Git commit SHA');
    expect(existsSync(manifest)).toBe(false);
  });
});

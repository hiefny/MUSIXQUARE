import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseReleaseIdentity, readReleaseIdentity } from '../../../scripts/release-identity.mts';

function sources(
  overrides: {
    productVersion?: string;
    lockVersion?: string;
    rootLockVersion?: string;
    serviceWorkerSource?: string;
  } = {},
) {
  const productVersion = overrides.productVersion ?? '9.0.829';
  return {
    packageSource: JSON.stringify({ name: 'musixquare', version: productVersion, private: true }),
    lockSource: JSON.stringify({
      name: 'musixquare',
      version: overrides.lockVersion ?? productVersion,
      packages: {
        '': { name: 'musixquare', version: overrides.rootLockVersion ?? productVersion },
      },
    }),
    serviceWorkerSource:
      overrides.serviceWorkerSource ?? "'use strict';\nconst CACHE_VERSION = 'v829';\n",
  };
}

describe('canonical release identity', () => {
  it('reads the product SemVer, whose patch is the service-worker cache epoch', () => {
    expect(parseReleaseIdentity(sources())).toEqual({
      productVersion: '9.0.829',
      serviceWorkerCacheEpoch: 829,
    });
  });

  // Owner decision 2026-11-17: from App 9.0.829 the patch number is the App
  // build number, and a minor or major release keeps counting it.
  it('rejects a patch number that is not the App build number', () => {
    expect(() =>
      parseReleaseIdentity(
        sources({ productVersion: '9.0.53', serviceWorkerSource: "const CACHE_VERSION = 'v828';" }),
      ),
    ).toThrow('patch 53 must be the App build number 828');
    expect(() =>
      parseReleaseIdentity(
        sources({ productVersion: '9.1.0', serviceWorkerSource: "const CACHE_VERSION = 'v840';" }),
      ),
    ).toThrow('patch 0 must be the App build number 840');
    expect(
      parseReleaseIdentity(
        sources({
          productVersion: '9.1.840',
          serviceWorkerSource: "const CACHE_VERSION = 'v840';",
        }),
      ),
    ).toEqual({ productVersion: '9.1.840', serviceWorkerCacheEpoch: 840 });
  });

  it('rejects either package-lock mirror drifting from the canonical product version', () => {
    expect(() => parseReleaseIdentity(sources({ lockVersion: '9.0.828' }))).toThrow(
      'top-level product version',
    );
    expect(() => parseReleaseIdentity(sources({ rootLockVersion: '9.0.828' }))).toThrow(
      'root package version',
    );
  });

  it('rejects an ambiguous or nonnumeric cache epoch', () => {
    expect(() =>
      parseReleaseIdentity(
        sources({ serviceWorkerSource: "const CACHE_VERSION = 'release-9.0.829';" }),
      ),
    ).toThrow('exactly one numeric CACHE_VERSION');
    expect(() =>
      parseReleaseIdentity(
        sources({
          serviceWorkerSource: "const CACHE_VERSION = 'v828';\nconst CACHE_VERSION = 'v829';\n",
        }),
      ),
    ).toThrow('exactly one numeric CACHE_VERSION');
  });

  it('keeps both admin shell assets pinned to the product release', () => {
    const versionedSources = {
      ...sources(),
      appWorkerSource: "const ADMIN_ASSET_VERSION = '9.0.829';",
      adminScriptSource: "const ADMIN_SCRIPT_VERSION = '9.0.829';",
    };
    expect(parseReleaseIdentity(versionedSources)).toEqual({
      productVersion: '9.0.829',
      serviceWorkerCacheEpoch: 829,
    });
    expect(() =>
      parseReleaseIdentity({
        ...versionedSources,
        adminScriptSource: "const ADMIN_SCRIPT_VERSION = '9.0.828';",
      }),
    ).toThrow('Admin asset versions must match');
  });

  it('keeps the repository guard wired into checked builds', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      version: string;
      scripts: Record<string, string>;
    };
    const identity = readReleaseIdentity();

    expect(identity.productVersion).toBe(manifest.version);
    expect(identity.serviceWorkerCacheEpoch).toBeGreaterThan(0);
    expect(/^\d+\.\d+\.(\d+)/u.exec(identity.productVersion)?.[1]).toBe(
      String(identity.serviceWorkerCacheEpoch),
    );
    expect(manifest.scripts['guard:release-identity']).toContain('release-identity.mts');
    expect(manifest.scripts['build:checked']).toContain('guard:release-identity');
    expect(manifest.scripts['version:status']).toContain('release-identity.mts');
  });
});

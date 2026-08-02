import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseReleaseIdentity, readReleaseIdentity } from '../../../scripts/release-identity.mjs';

function sources(
  overrides: {
    productVersion?: string;
    lockVersion?: string;
    rootLockVersion?: string;
    serviceWorkerSource?: string;
  } = {},
) {
  const productVersion = overrides.productVersion ?? '8.1.2';
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
      overrides.serviceWorkerSource ?? "'use strict';\nconst CACHE_VERSION = 'v226';\n",
  };
}

describe('canonical release identity', () => {
  it('keeps the product SemVer and service-worker cache epoch distinct', () => {
    expect(parseReleaseIdentity(sources())).toEqual({
      productVersion: '8.1.2',
      serviceWorkerCacheEpoch: 226,
    });
  });

  it('rejects either package-lock mirror drifting from the canonical product version', () => {
    expect(() => parseReleaseIdentity(sources({ lockVersion: '8.1.1' }))).toThrow(
      'top-level product version',
    );
    expect(() => parseReleaseIdentity(sources({ rootLockVersion: '8.1.1' }))).toThrow(
      'root package version',
    );
  });

  it('rejects an ambiguous or nonnumeric cache epoch', () => {
    expect(() =>
      parseReleaseIdentity(
        sources({ serviceWorkerSource: "const CACHE_VERSION = 'release-8.1.2';" }),
      ),
    ).toThrow('exactly one numeric CACHE_VERSION');
    expect(() =>
      parseReleaseIdentity(
        sources({
          serviceWorkerSource: "const CACHE_VERSION = 'v225';\nconst CACHE_VERSION = 'v226';\n",
        }),
      ),
    ).toThrow('exactly one numeric CACHE_VERSION');
  });

  it('keeps both admin shell assets pinned to the product release', () => {
    const versionedSources = {
      ...sources(),
      appWorkerSource: "const ADMIN_ASSET_VERSION = '8.1.2';",
      adminScriptSource: "const ADMIN_SCRIPT_VERSION = '8.1.2';",
    };
    expect(parseReleaseIdentity(versionedSources)).toEqual({
      productVersion: '8.1.2',
      serviceWorkerCacheEpoch: 226,
    });
    expect(() =>
      parseReleaseIdentity({
        ...versionedSources,
        adminScriptSource: "const ADMIN_SCRIPT_VERSION = '8.1.1';",
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
    expect(manifest.scripts['guard:release-identity']).toContain('release-identity.mjs');
    expect(manifest.scripts['build:checked']).toContain('guard:release-identity');
    expect(manifest.scripts['version:status']).toContain('release-identity.mjs');
  });
});

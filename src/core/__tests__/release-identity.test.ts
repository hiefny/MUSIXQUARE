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

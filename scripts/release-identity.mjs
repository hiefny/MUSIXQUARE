import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRODUCT_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SERVICE_WORKER_CACHE_VERSION_RE = /\bconst\s+CACHE_VERSION\s*=\s*['"]v([1-9]\d*)['"]\s*;/gu;

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

/**
 * Validate the two deliberately independent release identifiers.
 *
 * - package.json is the single source of truth for the human product version.
 * - public/service-worker.js owns a monotonic cache epoch, not an app version.
 */
export function parseReleaseIdentity({ packageSource, lockSource, serviceWorkerSource }) {
  const manifest = parseJson(packageSource, 'package.json');
  const lock = parseJson(lockSource, 'package-lock.json');
  const productVersion = typeof manifest?.version === 'string' ? manifest.version : '';
  if (manifest?.name !== 'musixquare' || manifest?.private !== true) {
    throw new Error('package.json must describe the private musixquare product.');
  }
  if (!PRODUCT_VERSION_RE.test(productVersion)) {
    throw new Error('package.json must contain a valid canonical SemVer product version.');
  }
  if (lock?.name !== manifest.name || lock?.version !== productVersion) {
    throw new Error('package-lock.json top-level product version does not match package.json.');
  }
  if (
    lock?.packages?.['']?.name !== manifest.name ||
    lock.packages[''].version !== productVersion
  ) {
    throw new Error('package-lock.json root package version does not match package.json.');
  }

  const cacheMatches = [...serviceWorkerSource.matchAll(SERVICE_WORKER_CACHE_VERSION_RE)];
  if (cacheMatches.length !== 1) {
    throw new Error('public/service-worker.js must declare exactly one numeric CACHE_VERSION.');
  }
  const serviceWorkerCacheEpoch = Number(cacheMatches[0][1]);
  if (!Number.isSafeInteger(serviceWorkerCacheEpoch) || serviceWorkerCacheEpoch <= 0) {
    throw new Error('Service-worker cache epoch must be a positive safe integer.');
  }

  return { productVersion, serviceWorkerCacheEpoch };
}

export function readReleaseIdentity(repositoryRoot = process.cwd()) {
  return parseReleaseIdentity({
    packageSource: readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
    lockSource: readFileSync(resolve(repositoryRoot, 'package-lock.json'), 'utf8'),
    serviceWorkerSource: readFileSync(
      resolve(repositoryRoot, 'public', 'service-worker.js'),
      'utf8',
    ),
  });
}

function main() {
  const identity = readReleaseIdentity();
  console.log(
    `[release-identity] MUSIXQUARE ${identity.productVersion}; service-worker cache epoch v${identity.serviceWorkerCacheEpoch}`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) main();

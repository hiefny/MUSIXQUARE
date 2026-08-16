import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRODUCT_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SERVICE_WORKER_CACHE_VERSION_RE =
  /\b(?:export\s+)?const\s+(?:SERVICE_WORKER_CACHE_VERSION|CACHE_VERSION)\s*=\s*['"]v([1-9]\d*)['"]\s*;/gu;
const ADMIN_WORKER_ASSET_VERSION_RE = /\bconst\s+ADMIN_ASSET_VERSION\s*=\s*['"]([^'"]+)['"]\s*;/gu;
const ADMIN_SCRIPT_VERSION_RE = /\bconst\s+ADMIN_SCRIPT_VERSION\s*=\s*['"]([^'"]+)['"]\s*;/gu;
const PRODUCT_PACKAGE_NAME = 'musixquare'; // brand-capitalization: allow-technical

export interface ReleaseIdentity {
  productVersion: string;
  serviceWorkerCacheEpoch: number;
}

export interface ReleaseIdentitySources {
  packageSource: string;
  lockSource: string;
  serviceWorkerSource: string;
  appWorkerSource?: string;
  adminScriptSource?: string;
}

interface ProductManifest {
  name?: unknown;
  private?: unknown;
  version?: unknown;
}

interface ProductLock extends ProductManifest {
  packages?: {
    ''?: ProductManifest;
  };
}

function parseJson(source: string, label: string): unknown {
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
 * - the service-worker compiler manifest owns a monotonic cache epoch, not an app version.
 */
export function parseReleaseIdentity({
  packageSource,
  lockSource,
  serviceWorkerSource,
  appWorkerSource,
  adminScriptSource,
}: ReleaseIdentitySources): ReleaseIdentity {
  const manifest = parseJson(packageSource, 'package.json') as ProductManifest | null;
  const lock = parseJson(lockSource, 'package-lock.json') as ProductLock | null;
  const productVersion = typeof manifest?.version === 'string' ? manifest.version : '';
  if (manifest?.name !== PRODUCT_PACKAGE_NAME || manifest?.private !== true) {
    throw new Error('package.json must describe the private MUSIXQUARE product.');
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
  const [cacheMatch] = cacheMatches;
  if (cacheMatches.length !== 1 || cacheMatch?.[1] === undefined) {
    throw new Error('Service-worker sources must declare exactly one numeric CACHE_VERSION.');
  }
  const serviceWorkerCacheEpoch = Number(cacheMatch[1]);
  if (!Number.isSafeInteger(serviceWorkerCacheEpoch) || serviceWorkerCacheEpoch <= 0) {
    throw new Error('Service-worker cache epoch must be a positive safe integer.');
  }

  if (appWorkerSource !== undefined || adminScriptSource !== undefined) {
    const workerMatches = [
      ...String(appWorkerSource || '').matchAll(ADMIN_WORKER_ASSET_VERSION_RE),
    ];
    const scriptMatches = [...String(adminScriptSource || '').matchAll(ADMIN_SCRIPT_VERSION_RE)];
    const [workerMatch] = workerMatches;
    const [scriptMatch] = scriptMatches;
    if (
      workerMatches.length !== 1 ||
      scriptMatches.length !== 1 ||
      workerMatch?.[1] === undefined ||
      scriptMatch?.[1] === undefined
    ) {
      throw new Error('Admin shell and script must each declare exactly one asset version.');
    }
    if (workerMatch[1] !== productVersion || scriptMatch[1] !== productVersion) {
      throw new Error('Admin asset versions must match the package.json product version.');
    }
  }

  return { productVersion, serviceWorkerCacheEpoch };
}

export function readReleaseIdentity(repositoryRoot = process.cwd()): ReleaseIdentity {
  return parseReleaseIdentity({
    packageSource: readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
    lockSource: readFileSync(resolve(repositoryRoot, 'package-lock.json'), 'utf8'),
    serviceWorkerSource: readFileSync(
      resolve(repositoryRoot, 'scripts', 'service-worker-asset.ts'),
      'utf8',
    ),
    appWorkerSource: readFileSync(resolve(repositoryRoot, 'cloudflare', 'app-worker.ts'), 'utf8'),
    adminScriptSource: readFileSync(
      resolve(repositoryRoot, 'browser', 'classic-runtime', 'admin.ts'),
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

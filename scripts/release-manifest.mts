import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readReleaseIdentity, type ReleaseIdentity } from './release-identity.mts';

const SCHEMA_VERSION = 2;
const REUSABLE_RELEASE_TARGETS = new Set([
  'app',
  'signaling',
  'pro-room',
  'developer-api',
  'remote-share',
  'all',
]);

export interface ReleaseManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ReleaseManifestTools {
  node: string;
  npm: string;
  wrangler: string;
}

export interface ReleaseManifest {
  schemaVersion: 2;
  release: ReleaseIdentity;
  commit: string;
  runId: string | null;
  runAttempt: string | null;
  target: string | null;
  validationProfile: string | null;
  createdAt: string;
  tools: ReleaseManifestTools;
  files: ReleaseManifestFile[];
}

export interface ReleaseManifestOptions {
  distDirectory?: string;
  manifestPath?: string;
  environment?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNullableRunNumber(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[1-9]\d*$/u.test(value));
}

function isToolVersion(value: unknown, allowNodePrefix = false): value is string {
  if (typeof value !== 'string') return false;
  const prefix = allowNodePrefix ? 'v?' : '';
  return new RegExp(`^${prefix}\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$`, 'u').test(value);
}

function isArtifactPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.split('/').includes('..')
  );
}

function isReleaseManifestFile(value: unknown): value is ReleaseManifestFile {
  return (
    isRecord(value) &&
    isArtifactPath(value.path) &&
    Number.isSafeInteger(value.size) &&
    typeof value.size === 'number' &&
    value.size >= 0 &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(value.sha256)
  );
}

function isReleaseIdentity(value: unknown): value is ReleaseIdentity {
  return (
    isRecord(value) &&
    typeof value.productVersion === 'string' &&
    typeof value.serviceWorkerCacheEpoch === 'number' &&
    Number.isSafeInteger(value.serviceWorkerCacheEpoch) &&
    value.serviceWorkerCacheEpoch > 0
  );
}

function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) return false;
  if (!isReleaseIdentity(value.release)) return false;
  if (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(value.commit)) return false;
  if (!isNullableRunNumber(value.runId) || !isNullableRunNumber(value.runAttempt)) return false;
  if (
    value.target !== null &&
    (typeof value.target !== 'string' || !REUSABLE_RELEASE_TARGETS.has(value.target))
  ) {
    return false;
  }
  if (
    value.validationProfile !== null &&
    (typeof value.validationProfile !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.validationProfile))
  ) {
    return false;
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    return false;
  }
  if (
    !isRecord(value.tools) ||
    !isToolVersion(value.tools.node, true) ||
    !isToolVersion(value.tools.npm) ||
    !isToolVersion(value.tools.wrangler)
  ) {
    return false;
  }
  return Array.isArray(value.files) && value.files.every(isReleaseManifestFile);
}

function commandVersion(command: string, args: string[] = ['--version']): string {
  const executable = process.platform === 'win32' ? `${command}.cmd` : command;
  return execFileSync(executable, args, { encoding: 'utf8' }).trim();
}

function npmVersion(environment: NodeJS.ProcessEnv): string {
  const userAgentVersion = environment.npm_config_user_agent?.match(/^npm\/([^\s]+)/)?.[1];
  if (userAgentVersion) return userAgentVersion;

  if (environment.npm_execpath) {
    return execFileSync(process.execPath, [environment.npm_execpath, '--version'], {
      encoding: 'utf8',
    }).trim();
  }
  return commandVersion('npm');
}

function installedWranglerVersion(): string {
  const packagePath = new URL('../node_modules/wrangler/package.json', import.meta.url);
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch {
    throw new Error('Cannot read the installed Wrangler package metadata. Run npm ci.');
  }
  const version = isRecord(packageJson) ? packageJson.version : undefined;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('The installed Wrangler package has an invalid version.');
  }
  return version;
}

function toPortablePath(filePath: string): string {
  return filePath.split(sep).join('/');
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(absolutePath));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Release artifact contains a non-file entry: ${absolutePath}`);
    }
    files.push(absolutePath);
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function describeFile(absolutePath: string, distDirectory: string): ReleaseManifestFile {
  const bytes = readFileSync(absolutePath);
  return {
    path: toPortablePath(relative(distDirectory, absolutePath)),
    size: statSync(absolutePath).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function currentCommit(environment: NodeJS.ProcessEnv): string {
  const commit =
    environment.GITHUB_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('Release manifest requires a full lowercase Git commit SHA.');
  }
  return commit;
}

function expectedSourceRunId(environment: NodeJS.ProcessEnv): string | null {
  return environment.RELEASE_SOURCE_RUN_ID || environment.GITHUB_RUN_ID || null;
}

function expectedSourceRunAttempt(environment: NodeJS.ProcessEnv): string | null {
  return environment.RELEASE_SOURCE_RUN_ATTEMPT || environment.GITHUB_RUN_ATTEMPT || null;
}

export function createReleaseManifest({
  distDirectory = 'dist',
  manifestPath = 'release-artifacts/release-manifest.json',
  environment = process.env,
  log = console.log,
}: ReleaseManifestOptions = {}): ReleaseManifest {
  const resolvedDistDirectory = resolve(distDirectory);
  const resolvedManifestPath = resolve(manifestPath);
  if (!existsSync(resolvedDistDirectory)) {
    throw new Error(`Production dist directory does not exist: ${resolvedDistDirectory}`);
  }
  const files = listFiles(resolvedDistDirectory).map((file) =>
    describeFile(file, resolvedDistDirectory),
  );
  if (files.length === 0) throw new Error('Production dist directory is empty.');

  const manifest: ReleaseManifest = {
    schemaVersion: 2,
    release: readReleaseIdentity(),
    commit: currentCommit(environment),
    runId: environment.GITHUB_RUN_ID || null,
    runAttempt: environment.GITHUB_RUN_ATTEMPT || null,
    target: environment.RELEASE_TARGET || null,
    validationProfile: environment.RELEASE_VALIDATION_PROFILE || null,
    createdAt: new Date().toISOString(),
    tools: {
      node: process.version,
      npm: npmVersion(environment),
      wrangler: installedWranglerVersion(),
    },
    files,
  };

  if (!isReleaseManifest(manifest)) {
    throw new Error('Refusing to create a malformed release manifest.');
  }

  mkdirSync(dirname(resolvedManifestPath), { recursive: true });
  writeFileSync(resolvedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  log(`Created release manifest for ${files.length} files at ${resolvedManifestPath}`);
  return manifest;
}

export function verifyReleaseManifest({
  distDirectory = 'dist',
  manifestPath = 'release-artifacts/release-manifest.json',
  environment = process.env,
  log = console.log,
}: ReleaseManifestOptions = {}): ReleaseManifest {
  const resolvedDistDirectory = resolve(distDirectory);
  const resolvedManifestPath = resolve(manifestPath);
  if (!existsSync(resolvedManifestPath)) {
    throw new Error(`Release manifest does not exist: ${resolvedManifestPath}`);
  }
  if (!existsSync(resolvedDistDirectory)) {
    throw new Error(`Production dist directory does not exist: ${resolvedDistDirectory}`);
  }

  const parsedManifest: unknown = JSON.parse(readFileSync(resolvedManifestPath, 'utf8'));
  if (!isReleaseManifest(parsedManifest)) {
    throw new Error('Unsupported or malformed release manifest.');
  }
  const manifest = parsedManifest;
  const currentRelease = readReleaseIdentity();
  if (manifest.release?.productVersion !== currentRelease.productVersion) {
    throw new Error(
      `Release manifest product version ${manifest.release?.productVersion} does not match ${currentRelease.productVersion}.`,
    );
  }
  if (manifest.release?.serviceWorkerCacheEpoch !== currentRelease.serviceWorkerCacheEpoch) {
    throw new Error(
      `Release manifest service-worker cache epoch ${manifest.release?.serviceWorkerCacheEpoch} does not match ${currentRelease.serviceWorkerCacheEpoch}.`,
    );
  }
  if (environment.GITHUB_SHA && manifest.commit !== environment.GITHUB_SHA) {
    throw new Error(
      `Release manifest commit ${manifest.commit} does not match ${environment.GITHUB_SHA}.`,
    );
  }
  const sourceRunId = expectedSourceRunId(environment);
  if (sourceRunId && manifest.runId !== sourceRunId) {
    throw new Error(
      `Release manifest run ${manifest.runId} does not match candidate source run ${sourceRunId}.`,
    );
  }
  const sourceRunAttempt = expectedSourceRunAttempt(environment);
  if (sourceRunAttempt && manifest.runAttempt !== sourceRunAttempt) {
    throw new Error(
      `Release manifest attempt ${manifest.runAttempt} does not match candidate source attempt ${sourceRunAttempt}.`,
    );
  }
  const requestedTarget = environment.RELEASE_TARGET;
  const reusableMainCiCandidate =
    manifest.target === 'all' &&
    manifest.validationProfile === 'main-ci' &&
    typeof requestedTarget === 'string' &&
    REUSABLE_RELEASE_TARGETS.has(requestedTarget);
  if (
    environment.RELEASE_TARGET &&
    manifest.target !== environment.RELEASE_TARGET &&
    !reusableMainCiCandidate
  ) {
    throw new Error(
      `Release manifest target ${manifest.target} does not match ${environment.RELEASE_TARGET}.`,
    );
  }
  if (
    environment.RELEASE_VALIDATION_PROFILE &&
    manifest.validationProfile !== environment.RELEASE_VALIDATION_PROFILE
  ) {
    throw new Error(
      `Release manifest validation profile ${manifest.validationProfile} does not match ${environment.RELEASE_VALIDATION_PROFILE}.`,
    );
  }
  const wranglerVersion = installedWranglerVersion();
  if (manifest.tools?.wrangler !== wranglerVersion) {
    throw new Error(
      `Release manifest Wrangler ${manifest.tools?.wrangler} does not match installed ${wranglerVersion}.`,
    );
  }

  const actualFiles = listFiles(resolvedDistDirectory).map((file) =>
    describeFile(file, resolvedDistDirectory),
  );
  if (actualFiles.length !== manifest.files.length) {
    throw new Error(
      `Release file count changed: expected ${manifest.files.length}, got ${actualFiles.length}.`,
    );
  }

  for (let index = 0; index < actualFiles.length; index += 1) {
    const expected = manifest.files[index];
    const actual = actualFiles[index];
    if (expected === undefined || actual === undefined) {
      throw new Error('Release file count changed during manifest verification.');
    }
    if (
      expected.path !== actual.path ||
      expected.size !== actual.size ||
      expected.sha256 !== actual.sha256
    ) {
      throw new Error(`Release artifact mismatch at ${actual.path || expected.path}.`);
    }
  }

  log(`Verified ${actualFiles.length} release files for ${manifest.commit}.`);
  return manifest;
}

function main(args: readonly string[] = process.argv.slice(2)): void {
  const [mode, distDirectory = 'dist', manifestPath = 'release-artifacts/release-manifest.json'] =
    args;
  if (args.length > 3) {
    throw new Error('Usage: node scripts/release-manifest.mts <create|verify> [dist] [manifest]');
  }
  if (mode === 'create') {
    createReleaseManifest({ distDirectory, manifestPath });
  } else if (mode === 'verify') {
    verifyReleaseManifest({ distDirectory, manifestPath });
  } else {
    throw new Error('Usage: node scripts/release-manifest.mts <create|verify> [dist] [manifest]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

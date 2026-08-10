import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readReleaseIdentity } from './release-identity.mjs';

const SCHEMA_VERSION = 2;
const REUSABLE_RELEASE_TARGETS = new Set([
  'app',
  'signaling',
  'pro-room',
  'developer-api',
  'remote-share',
  'all',
]);

function commandVersion(command, args = ['--version']) {
  const executable = process.platform === 'win32' ? `${command}.cmd` : command;
  return execFileSync(executable, args, { encoding: 'utf8' }).trim();
}

function npmVersion(environment) {
  const userAgentVersion = environment.npm_config_user_agent?.match(/^npm\/([^\s]+)/)?.[1];
  if (userAgentVersion) return userAgentVersion;

  if (environment.npm_execpath) {
    return execFileSync(process.execPath, [environment.npm_execpath, '--version'], {
      encoding: 'utf8',
    }).trim();
  }
  return commandVersion('npm');
}

function installedWranglerVersion() {
  const packagePath = new URL('../node_modules/wrangler/package.json', import.meta.url);
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error('Cannot read the installed Wrangler package metadata. Run npm ci.', {
      cause: error,
    });
  }
  const version = packageJson?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('The installed Wrangler package has an invalid version.');
  }
  return version;
}

function toPortablePath(filePath) {
  return filePath.split(sep).join('/');
}

function listFiles(directory) {
  const files = [];
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

function describeFile(absolutePath, distDirectory) {
  const bytes = readFileSync(absolutePath);
  return {
    path: toPortablePath(relative(distDirectory, absolutePath)),
    size: statSync(absolutePath).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function currentCommit(environment) {
  return (
    environment.GITHUB_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  );
}

function expectedSourceRunId(environment) {
  return environment.RELEASE_SOURCE_RUN_ID || environment.GITHUB_RUN_ID || null;
}

function expectedSourceRunAttempt(environment) {
  return environment.RELEASE_SOURCE_RUN_ATTEMPT || environment.GITHUB_RUN_ATTEMPT || null;
}

export function createReleaseManifest({
  distDirectory = 'dist',
  manifestPath = 'release-artifacts/release-manifest.json',
  environment = process.env,
  log = console.log,
} = {}) {
  const resolvedDistDirectory = resolve(distDirectory);
  const resolvedManifestPath = resolve(manifestPath);
  if (!existsSync(resolvedDistDirectory)) {
    throw new Error(`Production dist directory does not exist: ${resolvedDistDirectory}`);
  }
  const files = listFiles(resolvedDistDirectory).map((file) =>
    describeFile(file, resolvedDistDirectory),
  );
  if (files.length === 0) throw new Error('Production dist directory is empty.');

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
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
} = {}) {
  const resolvedDistDirectory = resolve(distDirectory);
  const resolvedManifestPath = resolve(manifestPath);
  if (!existsSync(resolvedManifestPath)) {
    throw new Error(`Release manifest does not exist: ${resolvedManifestPath}`);
  }
  if (!existsSync(resolvedDistDirectory)) {
    throw new Error(`Production dist directory does not exist: ${resolvedDistDirectory}`);
  }

  const manifest = JSON.parse(readFileSync(resolvedManifestPath, 'utf8'));
  if (manifest.schemaVersion !== SCHEMA_VERSION || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported or malformed release manifest.');
  }
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
  const reusableMainCiCandidate =
    manifest.target === 'all' &&
    manifest.validationProfile === 'main-ci' &&
    REUSABLE_RELEASE_TARGETS.has(environment.RELEASE_TARGET);
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

function main(args = process.argv.slice(2)) {
  const [mode, distDirectory = 'dist', manifestPath = 'release-artifacts/release-manifest.json'] =
    args;
  if (mode === 'create') {
    createReleaseManifest({ distDirectory, manifestPath });
  } else if (mode === 'verify') {
    verifyReleaseManifest({ distDirectory, manifestPath });
  } else {
    throw new Error('Usage: node scripts/release-manifest.mjs <create|verify> [dist] [manifest]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
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
const mode = process.argv[2];
const distDirectory = resolve(process.argv[3] || 'dist');
const manifestPath = resolve(process.argv[4] || 'release-artifacts/release-manifest.json');

function commandVersion(command, args = ['--version']) {
  const executable = process.platform === 'win32' ? `${command}.cmd` : command;
  return execFileSync(executable, args, { encoding: 'utf8' }).trim();
}

function npmVersion() {
  const userAgentVersion = process.env.npm_config_user_agent?.match(/^npm\/([^\s]+)/)?.[1];
  if (userAgentVersion) return userAgentVersion;

  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, '--version'], {
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

function describeFile(absolutePath) {
  const bytes = readFileSync(absolutePath);
  return {
    path: toPortablePath(relative(distDirectory, absolutePath)),
    size: statSync(absolutePath).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function currentCommit() {
  return (
    process.env.GITHUB_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  );
}

function expectedSourceRunId() {
  return process.env.RELEASE_SOURCE_RUN_ID || process.env.GITHUB_RUN_ID || null;
}

function expectedSourceRunAttempt() {
  return process.env.RELEASE_SOURCE_RUN_ATTEMPT || process.env.GITHUB_RUN_ATTEMPT || null;
}

function createManifest() {
  if (!existsSync(distDirectory)) {
    throw new Error(`Production dist directory does not exist: ${distDirectory}`);
  }
  const files = listFiles(distDirectory).map(describeFile);
  if (files.length === 0) throw new Error('Production dist directory is empty.');

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    release: readReleaseIdentity(),
    commit: currentCommit(),
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    target: process.env.RELEASE_TARGET || null,
    validationProfile: process.env.RELEASE_VALIDATION_PROFILE || null,
    createdAt: new Date().toISOString(),
    tools: {
      node: process.version,
      npm: npmVersion(),
      wrangler: installedWranglerVersion(),
    },
    files,
  };

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Created release manifest for ${files.length} files at ${manifestPath}`);
}

function verifyManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(`Release manifest does not exist: ${manifestPath}`);
  }
  if (!existsSync(distDirectory)) {
    throw new Error(`Production dist directory does not exist: ${distDirectory}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
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
  if (process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA) {
    throw new Error(
      `Release manifest commit ${manifest.commit} does not match ${process.env.GITHUB_SHA}.`,
    );
  }
  const sourceRunId = expectedSourceRunId();
  if (sourceRunId && manifest.runId !== sourceRunId) {
    throw new Error(
      `Release manifest run ${manifest.runId} does not match candidate source run ${sourceRunId}.`,
    );
  }
  const sourceRunAttempt = expectedSourceRunAttempt();
  if (sourceRunAttempt && manifest.runAttempt !== sourceRunAttempt) {
    throw new Error(
      `Release manifest attempt ${manifest.runAttempt} does not match candidate source attempt ${sourceRunAttempt}.`,
    );
  }
  const reusableMainCiCandidate =
    manifest.target === 'all' &&
    manifest.validationProfile === 'main-ci' &&
    REUSABLE_RELEASE_TARGETS.has(process.env.RELEASE_TARGET);
  if (
    process.env.RELEASE_TARGET &&
    manifest.target !== process.env.RELEASE_TARGET &&
    !reusableMainCiCandidate
  ) {
    throw new Error(
      `Release manifest target ${manifest.target} does not match ${process.env.RELEASE_TARGET}.`,
    );
  }
  if (
    process.env.RELEASE_VALIDATION_PROFILE &&
    manifest.validationProfile !== process.env.RELEASE_VALIDATION_PROFILE
  ) {
    throw new Error(
      `Release manifest validation profile ${manifest.validationProfile} does not match ${process.env.RELEASE_VALIDATION_PROFILE}.`,
    );
  }
  const wranglerVersion = installedWranglerVersion();
  if (manifest.tools?.wrangler !== wranglerVersion) {
    throw new Error(
      `Release manifest Wrangler ${manifest.tools?.wrangler} does not match installed ${wranglerVersion}.`,
    );
  }

  const actualFiles = listFiles(distDirectory).map(describeFile);
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

  console.log(`Verified ${actualFiles.length} release files for ${manifest.commit}.`);
}

if (mode === 'create') {
  createManifest();
} else if (mode === 'verify') {
  verifyManifest();
} else {
  throw new Error('Usage: node scripts/release-manifest.mjs <create|verify> [dist] [manifest]');
}

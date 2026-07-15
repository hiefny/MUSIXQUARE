import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const SCHEMA_VERSION = 1;
const DEFAULT_WRANGLER_VERSION = '4.111.0';
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

function createManifest() {
  if (!existsSync(distDirectory)) {
    throw new Error(`Production dist directory does not exist: ${distDirectory}`);
  }
  const files = listFiles(distDirectory).map(describeFile);
  if (files.length === 0) throw new Error('Production dist directory is empty.');

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    commit: currentCommit(),
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    target: process.env.RELEASE_TARGET || null,
    createdAt: new Date().toISOString(),
    tools: {
      node: process.version,
      npm: npmVersion(),
      wrangler: process.env.WRANGLER_VERSION || DEFAULT_WRANGLER_VERSION,
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
  if (process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA) {
    throw new Error(
      `Release manifest commit ${manifest.commit} does not match ${process.env.GITHUB_SHA}.`,
    );
  }
  if (process.env.GITHUB_RUN_ID && manifest.runId !== process.env.GITHUB_RUN_ID) {
    throw new Error(
      `Release manifest run ${manifest.runId} does not match ${process.env.GITHUB_RUN_ID}.`,
    );
  }
  if (process.env.GITHUB_RUN_ATTEMPT && manifest.runAttempt !== process.env.GITHUB_RUN_ATTEMPT) {
    throw new Error(
      `Release manifest attempt ${manifest.runAttempt} does not match ${process.env.GITHUB_RUN_ATTEMPT}.`,
    );
  }
  if (process.env.RELEASE_TARGET && manifest.target !== process.env.RELEASE_TARGET) {
    throw new Error(
      `Release manifest target ${manifest.target} does not match ${process.env.RELEASE_TARGET}.`,
    );
  }
  if (process.env.WRANGLER_VERSION && manifest.tools?.wrangler !== process.env.WRANGLER_VERSION) {
    throw new Error(
      `Release manifest Wrangler ${manifest.tools?.wrangler} does not match ${process.env.WRANGLER_VERSION}.`,
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

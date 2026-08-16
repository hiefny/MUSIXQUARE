import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export const RELEASE_DEVICE_RISK_CONTRACT_PATH = 'cloudflare/release-device-risk.contract.json';

const SHA_RE = /^[0-9a-f]{40}$/u;
const TARGETS = new Set(['app', 'signaling', 'pro-room', 'developer-api', 'remote-share', 'all']);
const SERVICE_WORKER_PATH = 'public/service-worker.js';
const INDEX_PATH = 'index.html';
const PACKAGE_JSON_PATH = 'package.json';
const PACKAGE_LOCK_PATH = 'package-lock.json';
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const SOURCE_MODULE_SUFFIXES = Object.freeze([
  '.ts',
  '.tsx',
  '.d.ts',
  '.mts',
  '.cts',
  '.d.mts',
  '.d.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
const PEER_LOCK_FIELDS = Object.freeze([
  'version',
  'resolved',
  'integrity',
  'link',
  'dev',
  'devOptional',
  'optional',
  'peer',
  'inBundle',
  'hasInstallScript',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'os',
  'cpu',
]);

function exactObject(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly ${expected.join(', ')}.`);
  }
  return value;
}

function canonicalRepositoryPath(value, label) {
  const normalized = typeof value === 'string' ? value.trim().replaceAll('\\', '/') : '';
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.startsWith('./') ||
    normalized.includes('//') ||
    normalized.split('/').includes('..') ||
    normalized.includes('\0') ||
    normalized.includes('\n') ||
    normalized.includes('\r')
  ) {
    throw new Error(`${label} must be a canonical repository-relative path.`);
  }
  return normalized;
}

function canonicalStringList(value, label, { prefix = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  const normalized = value.map((entry, index) => {
    const path = canonicalRepositoryPath(entry, `${label}[${index}]`);
    if (prefix && !path.endsWith('/')) {
      throw new Error(`${label}[${index}] must end with '/'.`);
    }
    if (!prefix && path.endsWith('/')) {
      throw new Error(`${label}[${index}] must name a file.`);
    }
    return path;
  });
  const sorted = [...new Set(normalized)].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(normalized)) {
    throw new Error(`${label} must be unique and sorted.`);
  }
  return Object.freeze(sorted);
}

export function normalizeReleaseDeviceRiskContract(value) {
  const contract = exactObject(
    value,
    ['schemaVersion', 'requiredExactPaths', 'requiredPathPrefixes'],
    'Release device-risk contract',
  );
  if (contract.schemaVersion !== 1) {
    throw new Error('Release device-risk contract schemaVersion must be 1.');
  }
  const requiredExactPaths = canonicalStringList(contract.requiredExactPaths, 'requiredExactPaths');
  const requiredPathPrefixes = canonicalStringList(
    contract.requiredPathPrefixes,
    'requiredPathPrefixes',
    { prefix: true },
  );
  for (const path of requiredExactPaths) {
    if (requiredPathPrefixes.some((prefix) => path.startsWith(prefix))) {
      throw new Error(`${path} is redundant with a required path prefix.`);
    }
  }
  return Object.freeze({ schemaVersion: 1, requiredExactPaths, requiredPathPrefixes });
}

export function readReleaseDeviceRiskContract(path = RELEASE_DEVICE_RISK_CONTRACT_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read release device-risk contract: ${error.message}`);
  }
  return normalizeReleaseDeviceRiskContract(parsed);
}

function isTestOnlySourcePath(path) {
  return (
    path.includes('/__tests__/') ||
    /(?:^|\/)__tests__(?:\/|$)/u.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)
  );
}

export function classifyReleaseDeviceRisk(changedPaths, contract) {
  if (!Array.isArray(changedPaths)) throw new Error('changedPaths must be an array.');
  const normalizedContract = normalizeReleaseDeviceRiskContract(contract);
  const exactPaths = new Set(normalizedContract.requiredExactPaths);
  const normalizedChanges = [
    ...new Set(
      changedPaths.map((entry, index) => canonicalRepositoryPath(entry, `changedPaths[${index}]`)),
    ),
  ].sort();
  const matchedPaths = normalizedChanges.filter(
    (path) =>
      !isTestOnlySourcePath(path) &&
      (exactPaths.has(path) ||
        normalizedContract.requiredPathPrefixes.some((prefix) => path.startsWith(prefix))),
  );
  return Object.freeze({
    required: matchedPaths.length > 0,
    changedPaths: Object.freeze(normalizedChanges),
    matchedPaths: Object.freeze(matchedPaths),
  });
}

export function releaseGitShaFromDeployment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Array.isArray(value.versions) || value.versions.length !== 1) return null;
  const [productionVersion] = value.versions;
  if (
    !productionVersion ||
    typeof productionVersion !== 'object' ||
    productionVersion.percentage !== 100 ||
    typeof productionVersion.version_id !== 'string' ||
    productionVersion.version_id.trim().length === 0
  ) {
    return null;
  }
  const message = value.annotations?.['workers/message'];
  const match = typeof message === 'string' ? /^git:([0-9a-f]{40})$/u.exec(message) : null;
  return match?.[1] ?? null;
}

function classifiedRiskReport({ target, baseSha, headSha, classification }) {
  return Object.freeze({
    schemaVersion: 1,
    required: classification.required,
    reason: classification.required ? 'high-risk-browser-runtime-change' : 'no-high-risk-change',
    target,
    baseSha,
    headSha,
    changedPaths: classification.changedPaths,
    matchedPaths: classification.matchedPaths,
  });
}

export function evaluateReleaseDeviceRisk({ target, headSha, deployment, changedPaths, contract }) {
  if (!TARGETS.has(target)) throw new Error(`Unsupported release target: ${target}`);
  if (!SHA_RE.test(headSha)) throw new Error('headSha must be a lowercase 40-character SHA.');
  if (target !== 'app' && target !== 'all') {
    return Object.freeze({
      schemaVersion: 1,
      required: false,
      reason: 'target-does-not-deploy-browser-app',
      target,
      baseSha: null,
      headSha,
      changedPaths: Object.freeze([]),
      matchedPaths: Object.freeze([]),
    });
  }
  const baseSha = releaseGitShaFromDeployment(deployment);
  if (!baseSha) {
    return Object.freeze({
      schemaVersion: 1,
      required: true,
      reason: 'unverifiable-current-app-deployment',
      target,
      baseSha: null,
      headSha,
      changedPaths: Object.freeze([]),
      matchedPaths: Object.freeze([]),
    });
  }
  return classifiedRiskReport({
    target,
    baseSha,
    headSha,
    classification: classifyReleaseDeviceRisk(changedPaths, contract),
  });
}

function exactSha(value, label) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!SHA_RE.test(normalized)) throw new Error(`${label} must be a lowercase 40-character SHA.`);
  return normalized;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${error.message}`);
  }
}

function git(repoRoot, args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
    ...options,
  });
}

function changedPathsBetween(repoRoot, baseSha, headSha) {
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', baseSha, headSha], { stdio: 'ignore' });
    const output = git(repoRoot, [
      'diff',
      '--no-renames',
      '--name-only',
      '--diff-filter=ACDMRTUXB',
      '-z',
      baseSha,
      headSha,
      '--',
    ]);
    return output.split('\0').filter(Boolean);
  } catch (error) {
    throw new Error(
      `Unable to prove the deployed app is an ancestor of this release: ${error.message}`,
    );
  }
}

function fileAtRevision(repoRoot, revision, filePath) {
  const listing = git(repoRoot, ['ls-tree', '-z', '--name-only', revision, '--', filePath]);
  if (!listing) return null;
  if (listing !== `${filePath}\0`) {
    throw new Error(`Unable to resolve ${filePath} at ${revision}.`);
  }
  return git(repoRoot, ['show', `${revision}:${filePath}`]);
}

function repositoryPathsAtRevision(repoRoot, revision, pathspec) {
  const listing = git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', revision, '--', pathspec]);
  return listing
    .split('\0')
    .filter(Boolean)
    .map((path, index) => canonicalRepositoryPath(path, `HEAD source path[${index}]`));
}

function isSourceModulePath(filePath) {
  return SOURCE_MODULE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function isDeclarationSourcePath(filePath) {
  return /\.d\.(?:[cm]?ts|tsx)$/u.test(filePath);
}

function moduleResolutionCandidates(importerPath, specifier) {
  const normalizedSpecifier = specifier.replaceAll('\\', '/');
  let basePath;
  if (normalizedSpecifier.startsWith('@/')) {
    basePath = posix.normalize(posix.join('src', normalizedSpecifier.slice(2)));
  } else {
    if (
      normalizedSpecifier !== '.' &&
      normalizedSpecifier !== '..' &&
      !normalizedSpecifier.startsWith('./') &&
      !normalizedSpecifier.startsWith('../')
    ) {
      return [];
    }
    basePath = posix.normalize(posix.join(posix.dirname(importerPath), normalizedSpecifier));
  }
  if (basePath === '..' || basePath.startsWith('../') || basePath.startsWith('/')) return [];

  const substitutions = [
    ['.mjs', ['.mts', '.d.mts', '.mjs']],
    ['.cjs', ['.cts', '.d.cts', '.cjs']],
    ['.jsx', ['.tsx', '.d.ts', '.jsx', '.js']],
    ['.js', ['.ts', '.tsx', '.d.ts', '.js', '.jsx']],
  ];
  for (const [specifierSuffix, resolvedSuffixes] of substitutions) {
    if (!basePath.endsWith(specifierSuffix)) continue;
    const stem = basePath.slice(0, -specifierSuffix.length);
    return resolvedSuffixes.map((suffix) => `${stem}${suffix}`);
  }

  if (SOURCE_MODULE_SUFFIXES.some((suffix) => basePath.endsWith(suffix))) return [basePath];
  return [
    basePath,
    ...SOURCE_MODULE_SUFFIXES.map((suffix) => `${basePath}${suffix}`),
    ...SOURCE_MODULE_SUFFIXES.map((suffix) => `${basePath}/index${suffix}`),
  ];
}

function resolveRelativeModulePath(importerPath, specifier, revisionPaths) {
  for (const candidate of moduleResolutionCandidates(importerPath, specifier)) {
    if (revisionPaths.has(candidate)) return candidate;
  }
  return null;
}

function productionTestImportViolationPaths(repoRoot, revision) {
  const revisionPaths = new Set(repositoryPathsAtRevision(repoRoot, revision, 'src'));
  const productionSources = [...revisionPaths]
    .filter(
      (filePath) =>
        isSourceModulePath(filePath) &&
        !isDeclarationSourcePath(filePath) &&
        !isTestOnlySourcePath(filePath),
    )
    .sort();
  const violationPaths = new Set();

  for (const importerPath of productionSources) {
    const source = git(repoRoot, ['show', `${revision}:${importerPath}`]);
    const imports = ts.preProcessFile(source, true, true).importedFiles;
    for (const imported of imports) {
      const targetPath = resolveRelativeModulePath(importerPath, imported.fileName, revisionPaths);
      if (!targetPath || !isTestOnlySourcePath(targetPath)) continue;
      violationPaths.add(importerPath);
      violationPaths.add(targetPath);
    }
  }

  return [...violationPaths].sort();
}

function contractAtRevision(repoRoot, revision) {
  const source = fileAtRevision(repoRoot, revision, RELEASE_DEVICE_RISK_CONTRACT_PATH);
  if (source === null) return null;
  try {
    return normalizeReleaseDeviceRiskContract(JSON.parse(source));
  } catch (error) {
    throw new Error(`Invalid release device-risk contract at ${revision}: ${error.message}`);
  }
}

function mergeContracts(contracts) {
  const available = contracts.filter(Boolean).map(normalizeReleaseDeviceRiskContract);
  if (available.length === 0) {
    throw new Error('The release device-risk contract is missing from both compared revisions.');
  }
  const requiredPathPrefixes = [
    ...new Set(available.flatMap((contract) => contract.requiredPathPrefixes)),
  ].sort();
  const requiredExactPaths = [
    ...new Set(available.flatMap((contract) => contract.requiredExactPaths)),
  ]
    .filter((path) => !requiredPathPrefixes.some((prefix) => path.startsWith(prefix)))
    .sort();
  return normalizeReleaseDeviceRiskContract({
    schemaVersion: 1,
    requiredExactPaths,
    requiredPathPrefixes,
  });
}

function replaceSingleCapturedEpoch(source, pattern, captureIndex) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return source;
  const match = matches[0];
  const epoch = match[captureIndex];
  if (typeof epoch !== 'string' || match.index === undefined) return source;
  const offset = match[0].indexOf(epoch);
  if (offset < 0) return source;
  const start = match.index + offset;
  return `${source.slice(0, start)}v<CACHE_EPOCH>${source.slice(start + epoch.length)}`;
}

function normalizedCacheEpochSource(filePath, source) {
  if (filePath === SERVICE_WORKER_PATH) {
    return replaceSingleCapturedEpoch(
      source,
      /\bconst\s+CACHE_VERSION\s*=\s*(['"])(v[1-9]\d*)\1\s*;/gu,
      2,
    );
  }
  if (filePath === INDEX_PATH) {
    return replaceSingleCapturedEpoch(source, /\/bootstrap\.js\?cache=(v[1-9]\d*)/gu, 1);
  }
  return source;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function readJsonSource(source, label) {
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('root must be an object');
    }
    return value;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function runtimeDependencyNames(entry) {
  const names = new Set();
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = entry?.[field];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) names.add(name);
  }
  return [...names].sort();
}

function parentLockPackagePath(packagePath) {
  const nestedMarker = packagePath.lastIndexOf('/node_modules/');
  if (nestedMarker >= 0) return packagePath.slice(0, nestedMarker);
  if (packagePath.startsWith('node_modules/')) return '';
  return '';
}

function resolveLockDependency(packages, fromPath, dependencyName) {
  let packagePath = fromPath;
  while (true) {
    const candidate = packagePath
      ? `${packagePath}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
    if (!packagePath) return null;
    packagePath = parentLockPackagePath(packagePath);
  }
}

function selectedLockEntry(entry) {
  return Object.fromEntries(
    PEER_LOCK_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(entry, field)).map(
      (field) => [field, entry[field]],
    ),
  );
}

function peerJsProductionLockFingerprint(source) {
  const lock = readJsonSource(source, PACKAGE_LOCK_PATH);
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error(`${PACKAGE_LOCK_PATH} must contain a packages object.`);
  }
  const root = packages[''];
  const rootPeerSpec = root?.dependencies?.peerjs ?? null;
  const startPath = Object.prototype.hasOwnProperty.call(packages, 'node_modules/peerjs')
    ? 'node_modules/peerjs'
    : null;
  const entries = {};
  const unresolved = [];
  const queue = startPath ? [startPath] : [];
  const visited = new Set();

  while (queue.length > 0) {
    const packagePath = queue.shift();
    if (visited.has(packagePath)) continue;
    visited.add(packagePath);
    const entry = packages[packagePath];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      unresolved.push(packagePath);
      continue;
    }
    entries[packagePath] = selectedLockEntry(entry);
    for (const dependencyName of runtimeDependencyNames(entry)) {
      const resolvedPath = resolveLockDependency(packages, packagePath, dependencyName);
      if (resolvedPath) queue.push(resolvedPath);
      else unresolved.push(`${packagePath}:${dependencyName}`);
    }
  }

  return JSON.stringify(
    stableValue({
      lockfileVersion: lock.lockfileVersion ?? null,
      rootPeerSpec,
      startPath,
      entries,
      unresolved: [...new Set(unresolved)].sort(),
    }),
  );
}

function peerJsPackageSpec(source) {
  const manifest = readJsonSource(source, PACKAGE_JSON_PATH);
  const dependencies = manifest.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return null;
  }
  return dependencies.peerjs ?? null;
}

function semanticPathRequiresEvidence(repoRoot, baseSha, headSha, filePath) {
  if (
    filePath !== SERVICE_WORKER_PATH &&
    filePath !== INDEX_PATH &&
    filePath !== PACKAGE_JSON_PATH &&
    filePath !== PACKAGE_LOCK_PATH
  ) {
    return true;
  }

  const before = fileAtRevision(repoRoot, baseSha, filePath);
  const after = fileAtRevision(repoRoot, headSha, filePath);
  if (before === null || after === null) return true;

  try {
    if (filePath === SERVICE_WORKER_PATH || filePath === INDEX_PATH) {
      return (
        normalizedCacheEpochSource(filePath, before) !== normalizedCacheEpochSource(filePath, after)
      );
    }
    if (filePath === PACKAGE_JSON_PATH) {
      return peerJsPackageSpec(before) !== peerJsPackageSpec(after);
    }
    return peerJsProductionLockFingerprint(before) !== peerJsProductionLockFingerprint(after);
  } catch {
    return true;
  }
}

function classifyReleaseDeviceRiskBetween(repoRoot, baseSha, headSha) {
  const changedPaths = changedPathsBetween(repoRoot, baseSha, headSha);
  const contract = mergeContracts([
    contractAtRevision(repoRoot, baseSha),
    contractAtRevision(repoRoot, headSha),
  ]);
  const pathClassification = classifyReleaseDeviceRisk(changedPaths, contract);
  const matchedPaths = [
    ...new Set([
      ...pathClassification.matchedPaths.filter((filePath) =>
        semanticPathRequiresEvidence(repoRoot, baseSha, headSha, filePath),
      ),
      ...productionTestImportViolationPaths(repoRoot, baseSha),
      ...productionTestImportViolationPaths(repoRoot, headSha),
    ]),
  ].sort();
  return Object.freeze({
    required: matchedPaths.length > 0,
    changedPaths: pathClassification.changedPaths,
    matchedPaths: Object.freeze(matchedPaths),
  });
}

function writeReport(path, report) {
  writeFileSync(resolve(path), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function appendSummary(report, attestationSelected) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const matched = report.matchedPaths.length > 0 ? report.matchedPaths.join(', ') : 'none';
  const lines = [
    '### Real-device release risk',
    '',
    `- Result: \`${report.required ? 'required' : 'not-required'}\``,
    `- Reason: \`${report.reason}\``,
    `- Compared deployment: \`${report.baseSha ?? 'unverifiable'}\``,
    `- Candidate: \`${report.headSha}\``,
    `- Matched paths: ${matched}`,
    `- Exact-SHA evidence selected: \`${attestationSelected ? 'yes' : 'no'}\``,
    '',
  ];
  writeFileSync(resolve(summaryPath), `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'a' });
}

function main() {
  const [command, target, deploymentPath, rawHeadSha, rawAttestationSelected, reportPath] =
    process.argv.slice(2);
  if (command !== 'evaluate' || !target || !deploymentPath || !rawHeadSha || !reportPath) {
    throw new Error(
      'Usage: release-device-risk.mjs evaluate TARGET DEPLOYMENT_JSON HEAD_SHA EVIDENCE_SELECTED REPORT_JSON',
    );
  }
  const headSha = exactSha(rawHeadSha, 'HEAD_SHA');
  const deployment = readJson(deploymentPath, 'current app deployment');
  const baseSha = releaseGitShaFromDeployment(deployment);
  let ancestryError = null;
  let report;

  if ((target === 'app' || target === 'all') && baseSha) {
    try {
      const classification = classifyReleaseDeviceRiskBetween(process.cwd(), baseSha, headSha);
      report = classifiedRiskReport({ target, baseSha, headSha, classification });
    } catch (error) {
      ancestryError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!report) {
    report = evaluateReleaseDeviceRisk({
      target,
      headSha,
      deployment: ancestryError ? {} : deployment,
      changedPaths: [],
      contract: readReleaseDeviceRiskContract(),
    });
  }
  if (ancestryError) {
    report = Object.freeze({ ...report, reason: 'unverifiable-deployment-ancestry' });
  }
  const attestationSelected = rawAttestationSelected === 'true';
  writeReport(reportPath, report);
  appendSummary(report, attestationSelected);
  if (report.required && !attestationSelected) {
    const detail =
      report.matchedPaths.length > 0 ? ` Matched: ${report.matchedPaths.join(', ')}.` : '';
    throw new Error(
      `Fresh exact-SHA physical-device evidence is required for this release.${detail}`,
    );
  }
  console.log(
    `Real-device release evidence ${report.required ? 'required and selected' : 'not required'} (${report.reason}).`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`[release-device-risk] ${error.message}`);
    process.exitCode = 1;
  }
}

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  loadD1MigrationManifest,
  trackedD1PathsForDatabase,
} from './check-d1-migration-contract.mts';
import { executeNpm, npmInvocation } from './npm-invocation.mts';

interface CommandRunnerCallOptions {
  readonly capture?: boolean;
}

type CommandRunner = (args: string[], options?: CommandRunnerCallOptions) => unknown;

export interface CommandRunnerOptions {
  readonly runner?: CommandRunner;
  readonly [key: string]: unknown;
}

export interface DeploymentVersion {
  readonly deployment?: Record<string, unknown>;
  readonly deploymentId?: string | null;
  readonly versionId: string;
  readonly message: string | null;
}

export interface ReleaseState extends Record<string, unknown> {
  readonly target: string;
}

interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (delayMs: number) => void;
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

type QueryCurrentFunction = (
  target: string,
  config: string,
  outputPath: string,
  options?: QueryCurrentOptions,
) => DeploymentVersion;

interface QueryCurrentOptions {
  readonly runner?: CommandRunner | undefined;
  readonly retry?: RetryOptions | undefined;
}

type ChangedRuntimePathsFunction = {
  bivarianceHack(
    baseSha: string,
    headSha: string,
    runtimePaths: string[],
    context: object,
  ): string[];
}['bivarianceHack'];

type ChangedAppRuntimeDependenciesFunction = (
  baseSha: string,
  headSha: string,
  options?: { readonly runner?: CommandRunner },
) => string[];

interface ContractCutoverOptions {
  readonly runner?: CommandRunner;
  readonly changedRuntimePaths?: ChangedRuntimePathsFunction;
  readonly queryCurrent?: QueryCurrentFunction;
  readonly queryOptions?: QueryCurrentOptions;
  readonly requireCheckpointInventory?: boolean;
}

interface CompatibilityOptions {
  readonly queryCurrent?: QueryCurrentFunction;
  readonly queryOptions?: QueryCurrentOptions;
  readonly changedRuntimePaths?: ChangedRuntimePathsFunction;
  readonly changedAppRuntimeDependencies?: ChangedAppRuntimeDependenciesFunction;
  readonly gitRunner?: CommandRunner;
}

interface QueryInjectionOptions {
  readonly queryCurrent?: QueryCurrentFunction | undefined;
  readonly queryOptions?: QueryCurrentOptions | undefined;
}

interface ReportResult extends Record<string, unknown> {
  target: string;
  status: string;
  error?: string;
  runtimePaths?: readonly string[];
  changedPaths?: string[];
  deployedGitSha?: string | null;
  deployedDeploymentId?: string | null;
  deployedVersionId?: string | null;
  deployedMessage?: string | null;
  expectedDeploymentId?: string | null;
  expectedVersionId?: string | null;
  expectedMessage?: string | null;
  expectedBaselineVersionId?: string | null;
  expectedCandidateMessage?: string | null;
  currentDeploymentId?: string | null;
  currentVersionId?: string | null;
  currentMessage?: string | null;
  rollbackStatus?: string | null;
  beforeVersionId?: string;
  restoredVersionId?: string;
}

interface OperationReport extends Record<string, unknown> {
  schemaVersion: number;
  startedAt: string;
  status: string;
  results: ReportResult[];
  completedAt?: string;
  error?: string;
}

interface AttemptedReleaseState extends ReleaseState {
  readonly target: WorkerTarget;
  readonly config: string;
  readonly attempted: true;
  readonly beforeVersionId: string;
  readonly releaseMessage: string;
  readonly rollbackOrder: number;
  readonly beforeDeploymentId?: string | null;
  readonly beforeMessage?: string | null;
  readonly afterDeploymentId?: string | null;
  readonly afterVersionId?: string | null;
  readonly afterMessage?: string | null;
  readonly ownedByRelease?: boolean;
}

interface RollbackState extends Record<string, unknown> {
  readonly target: string;
  readonly config: string;
  readonly beforeVersionId: string;
  readonly releaseMessage: string;
  readonly beforeMessage?: string | null;
  readonly afterDeploymentId?: string | null;
  readonly afterVersionId?: string | null;
  readonly ownedByRelease?: boolean;
}

interface RollbackAttempt {
  readonly status: string;
  readonly current: DeploymentVersion;
  readonly commandIssued: boolean;
}

interface RollbackAttemptOptions extends QueryInjectionOptions {
  readonly runner?: CommandRunner | undefined;
  readonly outputPath?: string;
  readonly confirmationOutputPath?: string;
  readonly initialCurrent?: DeploymentVersion | null;
  readonly retry?: RetryOptions | undefined;
}

type RollbackAttemptFunction = (
  state: RollbackState,
  rollbackMessage: string,
  options?: RollbackAttemptOptions,
) => RollbackAttempt;

type VerifyProductionVersionFunction = (
  target: string,
  config: string,
  expectedVersionId: string,
  outputPath: string,
  options?: QueryCurrentOptions,
) => DeploymentVersion;

interface RollbackOptions extends QueryInjectionOptions {
  readonly runner?: CommandRunner | undefined;
  readonly runRollbackWithRetry?: RollbackAttemptFunction;
  readonly verifyProductionVersion?: VerifyProductionVersionFunction;
  readonly skipTargets?: Set<string> | string;
  readonly rollbackRetry?: RetryOptions | undefined;
  readonly verifyRetry?: RetryOptions | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

const SCHEMA_VERSION = 1;
const DEFAULT_DIRECTORY = 'release-artifacts/deployments';
const QUERY_RETRY = Object.freeze({ maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 2_000 });
const ROLLBACK_RETRY = Object.freeze({ maxAttempts: 3, baseDelayMs: 750, maxDelayMs: 2_000 });
const VERIFY_RETRY = Object.freeze({ maxAttempts: 6, baseDelayMs: 500, maxDelayMs: 4_000 });
const D1_MIGRATION_MANIFEST = loadD1MigrationManifest();

function trackedD1Paths(databaseNames: readonly string[]): string[] {
  return [
    ...new Set(
      databaseNames.flatMap((databaseName) =>
        trackedD1PathsForDatabase(D1_MIGRATION_MANIFEST, databaseName),
      ),
    ),
  ];
}

function trackedD1MigrationPaths(migrationIds: readonly string[]): string[] {
  const requested = new Set(migrationIds);
  const paths = [];
  for (const database of D1_MIGRATION_MANIFEST.databases) {
    for (const migration of database.migrations) {
      if (!requested.delete(migration.id)) continue;
      paths.push(migration.forward);
      if (migration.rollback !== null) paths.push(migration.rollback);
    }
  }
  if (requested.size > 0) {
    throw new Error(`Unknown tracked D1 migration: ${[...requested].join(', ')}.`);
  }
  return paths;
}

const PRO_ROOM_D1_PATHS = Object.freeze([
  ...trackedD1MigrationPaths([
    'admin-pro-room-generation-v1',
    'admin-pro-grants-v1',
    'auth-pro-room-generation-v1',
    'developer-api-room-generation-v1',
  ]),
  ...trackedD1Paths(['musixquare-admin-metrics', 'musixquare-developer-api']).filter((path) =>
    path.endsWith('.schema.sql'),
  ),
]);
const DEVELOPER_API_D1_PATHS = Object.freeze(trackedD1Paths(['musixquare-developer-api']));
const APP_D1_PATHS = Object.freeze(
  trackedD1Paths(['musixquare-admin-metrics', 'musixquare-auth', 'musixquare-developer-api']),
);

// Emergency deployment is deliberately code-only. These files represent
// durable or account-level state that the local emergency path cannot apply,
// roll back, or prove atomically. If any selected Worker's deployed Git SHA is
// behind a change to one of these paths, the approved release workflow is the
// only safe deployment path.
const EMERGENCY_EXTERNAL_STATE_PATHS = Object.freeze([
  ...new Set([
    ...APP_D1_PATHS,
    ...PRO_ROOM_D1_PATHS,
    ...DEVELOPER_API_D1_PATHS,
    'cloudflare/d1-migrations.manifest.json',
    'cloudflare/r2-cors.remote-share.json',
    'cloudflare/r2-lifecycle.remote-share.json',
    'cloudflare/r2-cors.pro-media.json',
    'cloudflare/remote-share-contract-version.txt',
    'cloudflare/service-control-contract-version.txt',
    ...Object.values({
      remoteShare: 'cloudflare/wrangler.remote-share.toml',
      proRoom: 'cloudflare/wrangler.pro-room.toml',
      signaling: 'cloudflare/wrangler.signaling.toml',
      developerApiFacade: 'cloudflare/wrangler.developer-api-facade.toml',
      developerApi: 'cloudflare/wrangler.developer-api.toml',
      app: 'cloudflare/wrangler.app.toml',
    }),
  ]),
]);

const TARGETS = {
  'pro-room': {
    config: 'cloudflare/wrangler.pro-room.toml',
    rollbackOrder: 1,
  },
  'remote-share': {
    config: 'cloudflare/wrangler.remote-share.toml',
    rollbackOrder: 2,
  },
  signaling: {
    config: 'cloudflare/wrangler.signaling.toml',
    rollbackOrder: 3,
  },
  'developer-api-facade': {
    config: 'cloudflare/wrangler.developer-api-facade.toml',
    rollbackOrder: 4,
  },
  'developer-api': {
    config: 'cloudflare/wrangler.developer-api.toml',
    rollbackOrder: 5,
  },
  app: {
    config: 'cloudflare/wrangler.app.toml',
    rollbackOrder: 6,
  },
} as const;

type WorkerTarget = keyof typeof TARGETS;

function isWorkerTarget(value: string): value is WorkerTarget {
  return Object.hasOwn(TARGETS, value);
}

const RELEASE_TARGET_WORKERS = Object.freeze({
  'remote-share': ['remote-share'],
  signaling: ['signaling'],
  'pro-room': ['pro-room'],
  'developer-api': ['developer-api-facade', 'developer-api'],
  app: ['app'],
  all: ['pro-room', 'remote-share', 'signaling', 'developer-api-facade', 'developer-api', 'app'],
} satisfies Readonly<Record<string, readonly WorkerTarget[]>>);

type ReleaseTarget = keyof typeof RELEASE_TARGET_WORKERS;

function isReleaseTarget(value: string): value is ReleaseTarget {
  return Object.hasOwn(RELEASE_TARGET_WORKERS, value);
}

// Files that become production code or deployment configuration for each
// Worker. Shared modules intentionally appear in every Worker that imports
// them: a partial release must not publish only one copy of an identity or
// protocol contract that changed in the same source revision.
const TARGET_RUNTIME_PATHS = Object.freeze({
  'remote-share': [
    'cloudflare/remote-share-contract-version.txt',
    'cloudflare/remote-share-upload-assertion.ts',
    'cloudflare/remote-share-worker.ts',
    'cloudflare/service-maintenance.ts',
    'cloudflare/r2-cors.remote-share.json',
    'cloudflare/r2-lifecycle.remote-share.json',
    'cloudflare/wrangler.remote-share.toml',
  ],
  signaling: [
    'cloudflare/signaling-worker.ts',
    'cloudflare/signaling-protocol.ts',
    'cloudflare/remote-share-upload-assertion.ts',
    'cloudflare/service-maintenance.ts',
    'cloudflare/pro-room-generation.ts',
    'cloudflare/standard-room-account-assertion.ts',
    'cloudflare/account-nickname.ts',
    'cloudflare/display-name-policy.ts',
    'src/chat/profanity-patterns.generated.json',
    'cloudflare/wrangler.signaling.toml',
  ],
  'pro-room': [
    'cloudflare/service-control-contract-version.txt',
    'cloudflare/pro-room-worker.ts',
    'cloudflare/pro-room-body.ts',
    'cloudflare/pro-room-claims.ts',
    'cloudflare/pro-room-crypto.ts',
    'cloudflare/service-control-object.ts',
    'cloudflare/pro-room-grants.ts',
    'cloudflare/service-maintenance.ts',
    'cloudflare/pro-room-generation.ts',
    'cloudflare/pro-room-effects.ts',
    'cloudflare/pro-room-permissions.ts',
    'cloudflare/pro-room-queue-mode.ts',
    'cloudflare/pro-room-validation.ts',
    'cloudflare/account-assertion.ts',
    'cloudflare/account-nickname.ts',
    'cloudflare/display-name-policy.ts',
    'cloudflare/r2-cors.pro-media.json',
    ...PRO_ROOM_D1_PATHS,
    'src/chat/profanity-patterns.generated.json',
    'cloudflare/wrangler.pro-room.toml',
  ],
  'developer-api-facade': [
    'cloudflare/developer-api-facade-worker.ts',
    'cloudflare/service-maintenance.ts',
    'cloudflare/pro-room-generation.ts',
    'cloudflare/wrangler.developer-api-facade.toml',
  ],
  'developer-api': [
    'cloudflare/developer-api-worker.ts',
    'cloudflare/service-maintenance.ts',
    'cloudflare/pro-room-generation.ts',
    ...DEVELOPER_API_D1_PATHS,
    'cloudflare/wrangler.developer-api.toml',
  ],
  app: [
    'cloudflare/remote-share-contract-version.txt',
    'cloudflare/service-control-contract-version.txt',
    'src',
    ':(exclude)src/**/__tests__/**',
    ':(exclude)src/**/*.test.ts',
    ':(exclude)src/**/*.test.tsx',
    'browser',
    'public',
    'css',
    '.workshop/landing',
    '.workshop/privacy',
    '.workshop/terms',
    '.workshop/faq',
    '.workshop/developers',
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
    'tsconfig.browser-classic.json',
    'tsconfig.auxiliary-browser.json',
    'tsconfig.service-worker.json',
    'tsconfig.ui-kit.json',
    'cloudflare/app-static-assets/_headers',
    'scripts/classic-runtime-assets.ts',
    'scripts/auxiliary-browser-assets.ts',
    'scripts/service-worker-asset.ts',
    'scripts/ui-kit-asset.ts',
    'scripts/materialize-app-static-headers.mts',
    'cloudflare/app-worker.ts',
    'cloudflare/service-maintenance.ts',
    'cloudflare/pro-bot.ts',
    'cloudflare/pro-room-claims.ts',
    'cloudflare/pro-room-crypto.ts',
    'cloudflare/pro-room-grants.ts',
    'cloudflare/pro-room-generation.ts',
    'cloudflare/pro-room-validation.ts',
    'cloudflare/account-auth.ts',
    ...APP_D1_PATHS,
    'cloudflare/d1-migrations.manifest.json',
    'cloudflare/account-assertion.ts',
    'cloudflare/standard-room-account-assertion.ts',
    'cloudflare/account-nickname.ts',
    'cloudflare/display-name-policy.ts',
    'cloudflare/r2-cors.pro-media.json',
    'cloudflare/r2-cors.remote-share.json',
    'cloudflare/r2-lifecycle.remote-share.json',
    'cloudflare/wrangler.app.toml',
  ],
} satisfies Readonly<Record<WorkerTarget, readonly string[]>>);

const RELEASE_GIT_SHA_RE = /(?:^|\s)git:([0-9a-f]{40})(?=\s|$)/i;
const CANONICAL_RELEASE_MESSAGE_RE = /^git:[0-9a-f]{40}$/;

function readJson(filePath: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isRecord(value)) {
    throw new Error(`Expected a JSON object in ${filePath}.`);
  }
  return value;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function targetDefinition(target: string): (typeof TARGETS)[WorkerTarget] {
  if (!isWorkerTarget(target)) {
    throw new Error(`Unknown release target: ${target}`);
  }
  return TARGETS[target];
}

function releaseTargetWorkers(releaseTarget: string): ReadonlySet<string> {
  if (!isReleaseTarget(releaseTarget)) {
    throw new Error(`Unknown release target: ${releaseTarget}`);
  }
  const workers = RELEASE_TARGET_WORKERS[releaseTarget];
  return new Set(workers);
}

function runtimePathsForWorker(worker: string): string[] {
  if (!isWorkerTarget(worker)) throw new Error(`Unknown Worker target: ${worker}`);
  const paths = TARGET_RUNTIME_PATHS[worker];
  return [...paths];
}

function releaseGitSha(message: string | null | undefined): string | null {
  if (typeof message !== 'string') return null;
  return RELEASE_GIT_SHA_RE.exec(message)?.[1]?.toLowerCase() || null;
}

function contractCutoverRequiresForwardRepair(
  headSha: string,
  markerPath: string,
  targets: readonly string[],
  directory = DEFAULT_DIRECTORY,
  options: ContractCutoverOptions = {},
): boolean {
  if (!/^[0-9a-f]{40}$/i.test(headSha || '')) {
    throw new Error('A full 40-character release Git SHA is required for cutover-floor checks.');
  }
  const normalizedHeadSha = headSha.toLowerCase();
  const query = options.queryCurrent || queryCurrent;
  const immutableCheckpointPath = resolve(directory, 'recovery-checkpoint.json');
  let checkpointTargets = null;
  if (options.requireCheckpointInventory === true && !existsSync(immutableCheckpointPath)) {
    return true;
  }
  if (existsSync(immutableCheckpointPath)) {
    try {
      const checkpoint = readJson(immutableCheckpointPath);
      if (typeof checkpoint.releaseTarget !== 'string') return true;
      const selectedTargets = releaseTargetWorkers(checkpoint.releaseTarget);
      const reportedTargets = new Set(
        Array.isArray(checkpoint.workers)
          ? checkpoint.workers
              .map((worker) => (isRecord(worker) ? worker.target : undefined))
              .filter((target): target is string => typeof target === 'string' && target.length > 0)
          : [],
      );
      if (
        checkpoint.schemaVersion !== SCHEMA_VERSION ||
        checkpoint.status !== 'captured' ||
        !Array.isArray(checkpoint.workers) ||
        checkpoint.workers.length !== selectedTargets.size ||
        reportedTargets.size !== selectedTargets.size ||
        [...selectedTargets].some((target) => !reportedTargets.has(target))
      ) {
        return true;
      }
      checkpointTargets = selectedTargets;
    } catch {
      return true;
    }
  }
  for (const target of targets) {
    const statePath = pathsFor(target, directory).state;
    if (!existsSync(statePath)) {
      if (isWorkerTarget(target) && checkpointTargets?.has(target)) return true;
      continue;
    }
    let state;
    try {
      state = readJson(statePath);
    } catch {
      // An unreadable attempted-deployment record cannot prove that an older
      // protocol is safe to restore. Fail closed and repair forward.
      return true;
    }
    if (state?.attempted !== true) continue;
    const beforeGitSha = releaseGitSha(stringOrNull(state.beforeMessage));
    if (!beforeGitSha) return true;
    try {
      const changedPaths = options.changedRuntimePaths
        ? options.changedRuntimePaths(beforeGitSha, normalizedHeadSha, [markerPath], options)
        : changedRuntimePaths(
            beforeGitSha,
            normalizedHeadSha,
            [markerPath],
            options.runner ? { runner: options.runner } : {},
          );
      if (changedPaths.length === 0) {
        continue;
      }
    } catch {
      return true;
    }

    // An immutable recovery checkpoint deliberately includes every selected
    // Worker as attempted so a failure before the first deploy can still prove
    // its captured baseline. That flag alone does not prove the marker-changing
    // candidate ever became live. Resolve the exact Cloudflare version before
    // withholding rollback: a still-live captured baseline is safe, while a
    // candidate, external drift, or unreadable identity fails closed.
    if (
      state.schemaVersion !== SCHEMA_VERSION ||
      state.target !== target ||
      typeof state.config !== 'string' ||
      !state.config ||
      typeof state.beforeVersionId !== 'string' ||
      !state.beforeVersionId ||
      releaseGitSha(stringOrNull(state.releaseMessage)) !== normalizedHeadSha
    ) {
      return true;
    }
    try {
      const current = query(
        target,
        state.config,
        resolve(directory, `${target}-cutover-floor-current.json`),
        options.queryOptions,
      );
      if (current.versionId === state.beforeVersionId) continue;
      return true;
    } catch {
      return true;
    }
  }
  return false;
}

function rollbackDeploymentMessage(
  state: Record<string, unknown>,
  fallbackMessage: string,
): string {
  const restoredGitSha = releaseGitSha(
    typeof state.beforeMessage === 'string' ? state.beforeMessage : null,
  );
  return restoredGitSha ? `git:${restoredGitSha}` : fallbackMessage;
}

function runGit(args: string[], options: CommandRunnerCallOptions = {}): unknown {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

function changedRuntimePaths(
  baseSha: string,
  headSha: string,
  runtimePaths: string[],
  options: CommandRunnerOptions = {},
): string[] {
  const runner = options.runner || runGit;
  try {
    runner(['merge-base', '--is-ancestor', baseSha, headSha], { capture: true });
  } catch (error) {
    throw new Error(
      `Deployed commit ${baseSha} is not an ancestor of release commit ${headSha}; ` +
        `a partial release cannot prove compatibility.`,
      { cause: error },
    );
  }
  const stdout = runner(
    [
      'diff',
      '--name-only',
      '--diff-filter=ACDMRTUXB',
      `${baseSha}..${headSha}`,
      '--',
      ...runtimePaths,
    ],
    { capture: true },
  );
  return [...new Set(String(stdout).split(/\r?\n/).filter(Boolean))].sort();
}

function sortedObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedObject(value[key])]),
  );
}

function appRuntimeDependencySnapshot(
  revision: string,
  options: CommandRunnerOptions = {},
): Record<string, unknown> {
  const runner = options.runner || runGit;
  const readGitJson = (path: string): Record<string, unknown> => {
    const source = runner(['show', `${revision}:${path}`], { capture: true });
    try {
      const value: unknown = JSON.parse(String(source));
      if (!isRecord(value)) throw new Error('The JSON root is not an object.');
      return value;
    } catch (error) {
      throw new Error(`${path} at ${revision} is not valid JSON.`, { cause: error });
    }
  };
  const packageJson = readGitJson('package.json');
  const packageLock = readGitJson('package-lock.json');
  const runtimePackageFields = [
    'version',
    'resolved',
    'integrity',
    'link',
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundledDependencies',
  ];
  const packages = isRecord(packageLock.packages) ? packageLock.packages : {};
  const productionPackageEntries: Array<[string, Record<string, unknown>]> = [];
  for (const [path, record] of Object.entries(packages)) {
    if (path === '' || !isRecord(record) || record.dev === true) continue;
    productionPackageEntries.push([path, record]);
  }
  productionPackageEntries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const productionPackages = Object.fromEntries(
    productionPackageEntries.map(([path, record]) => [
      path,
      Object.fromEntries(
        runtimePackageFields
          .filter((field) => record[field] !== undefined)
          .map((field) => [field, sortedObject(record[field])]),
      ),
    ]),
  );
  return {
    dependencies: sortedObject(packageJson.dependencies || {}),
    lockfileVersion: packageLock.lockfileVersion ?? null,
    productionPackages,
  };
}

function changedAppRuntimeDependencies(
  baseSha: string,
  headSha: string,
  options: CommandRunnerOptions = {},
): string[] {
  const before = appRuntimeDependencySnapshot(baseSha, options);
  const after = appRuntimeDependencySnapshot(headSha, options);
  return isDeepStrictEqual(before, after)
    ? []
    : ['package.json#dependencies', 'package-lock.json#production-resolution'];
}

function productionVersion(deployment: unknown, label: string): string {
  if (!isRecord(deployment) || !Array.isArray(deployment.versions)) {
    throw new Error(`${label} is not a Wrangler deployment status payload.`);
  }
  const productionVersions = deployment.versions.filter(
    (version): version is Record<string, unknown> =>
      isRecord(version) &&
      Number(version.percentage) === 100 &&
      typeof version.version_id === 'string',
  );
  if (productionVersions.length !== 1) {
    throw new Error(
      `${label} must contain exactly one 100% production version; found ${productionVersions.length}.`,
    );
  }
  const production = productionVersions[0];
  if (!production || typeof production.version_id !== 'string') {
    throw new Error(`${label} has no readable 100% production version.`);
  }
  return production.version_id;
}

function deploymentMessage(deployment: unknown): string | null {
  if (!isRecord(deployment) || !isRecord(deployment.annotations)) return null;
  const message = deployment.annotations['workers/message'];
  return typeof message === 'string' && message ? message : null;
}

function pathsFor(target: string, directory: string) {
  const base = resolve(directory);
  return {
    before: resolve(base, `${target}-before.json`),
    preflight: resolve(base, `${target}-preflight.json`),
    after: resolve(base, `${target}.json`),
    state: resolve(base, `${target}-state.json`),
    finalCurrent: resolve(base, `${target}-final-current.json`),
    recoveryFinalCurrent: resolve(base, `${target}-recovery-final-current.json`),
    rollbackCurrent: resolve(base, `${target}-rollback-current.json`),
    rollback: resolve(base, `${target}-rollback.json`),
  };
}

function sleepSync(delayMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function retrySync<T>(
  label: string,
  operation: (attempt: number) => T,
  options: RetryOptions = {},
): T {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 1);
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs) || 0);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || baseDelayMs);
  const sleep = options.sleep || sleepSync;
  const onRetry =
    options.onRetry ||
    ((error, attempt, delayMs) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `${label} failed on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs} ms: ${detail}`,
      );
    });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return operation(attempt);
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      onRetry(error, attempt, delayMs);
      sleep(delayMs);
    }
  }

  throw new Error(`${label} exhausted its retry budget.`);
}

function prepare(target: string, directory: string): void {
  const definition = targetDefinition(target);
  const paths = pathsFor(target, directory);
  const before = readJson(paths.before);
  const releaseMessage = process.env.RELEASE_MESSAGE;
  if (!releaseMessage) throw new Error('RELEASE_MESSAGE is required to prepare a deployment.');
  if (!CANONICAL_RELEASE_MESSAGE_RE.test(releaseMessage)) {
    throw new Error('RELEASE_MESSAGE must be exactly git:<40-char-lowercase-sha>.');
  }

  writeJson(paths.state, {
    schemaVersion: SCHEMA_VERSION,
    target,
    config: definition.config,
    releaseMessage,
    beforeDeploymentId: before.id || null,
    beforeVersionId: productionVersion(before, `${target} before deployment`),
    beforeMessage: deploymentMessage(before),
    attempted: false,
    afterDeploymentId: null,
    afterVersionId: null,
    changed: false,
  });
  console.log(`Prepared rollback state for ${target}.`);
}

function deploymentState(
  target: string,
  releaseMessage: string | undefined,
  before: DeploymentVersion,
  { attempted = false }: { readonly attempted?: boolean } = {},
): Record<string, unknown> {
  const definition = targetDefinition(target);
  const gitSha = releaseGitSha(releaseMessage);
  if (!gitSha || gitSha !== gitSha.toLowerCase()) {
    throw new Error('Deployment checkpoint message must contain git:<40-char-lowercase-sha>.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    target,
    config: definition.config,
    releaseMessage,
    beforeDeploymentId: before.deploymentId || null,
    beforeVersionId: before.versionId,
    beforeMessage: before.message,
    attempted,
    ...(attempted ? { attemptedAt: new Date().toISOString() } : {}),
    afterDeploymentId: null,
    afterVersionId: null,
    changed: false,
  };
}

function captureDeploymentCheckpoint(
  releaseTarget: string,
  releaseMessage: string | undefined,
  directory: string,
  options: QueryInjectionOptions = {},
): Record<string, unknown> {
  const query = options.queryCurrent || queryCurrent;
  const selectedWorkers = [...releaseTargetWorkers(releaseTarget)];
  const report: Record<string, unknown> & {
    status: string;
    workers: Array<Record<string, unknown>>;
    completedAt?: string;
  } = {
    schemaVersion: SCHEMA_VERSION,
    releaseTarget,
    releaseMessage,
    startedAt: new Date().toISOString(),
    status: 'pending',
    workers: [],
  };

  for (const target of selectedWorkers) {
    const definition = targetDefinition(target);
    const paths = pathsFor(target, directory);
    const before = query(target, definition.config, paths.before, options.queryOptions);
    const state = deploymentState(target, releaseMessage, before, { attempted: true });
    writeJson(paths.state, state);
    report.workers.push({
      target,
      beforeDeploymentId: state.beforeDeploymentId,
      beforeVersionId: state.beforeVersionId,
      beforeMessage: state.beforeMessage,
    });
  }

  report.status = 'captured';
  report.completedAt = new Date().toISOString();
  writeJson(resolve(directory, 'recovery-checkpoint.json'), report);
  console.log(`Captured immutable recovery checkpoint for ${releaseTarget}.`);
  return report;
}

function verifyEmergencyCodeOnly(
  headSha: string,
  directory: string,
  options: Pick<CompatibilityOptions, 'changedRuntimePaths'> = {},
): OperationReport {
  if (!/^[0-9a-f]{40}$/u.test(headSha || '')) {
    throw new Error('Emergency code-only verification requires a full lowercase Git SHA.');
  }
  const diffRuntimePaths = options.changedRuntimePaths || changedRuntimePaths;
  const states = attemptedStates(directory);
  if (states.length === 0) {
    throw new Error('Emergency code-only verification requires a captured Worker checkpoint.');
  }
  const report: OperationReport = {
    schemaVersion: SCHEMA_VERSION,
    releaseGitSha: headSha,
    startedAt: new Date().toISOString(),
    status: 'compatible',
    results: [],
  };
  let failed = false;

  for (const state of states) {
    const result: ReportResult = {
      target: state.target,
      deployedGitSha: null,
      changedPaths: [],
      status: 'pending',
    };
    report.results.push(result);
    try {
      const deployedGitSha = releaseGitSha(state.beforeMessage);
      if (!deployedGitSha) {
        throw new Error(`${state.target} live deployment has no verifiable Git provenance.`);
      }
      result.deployedGitSha = deployedGitSha;
      result.changedPaths = diffRuntimePaths(
        deployedGitSha,
        headSha,
        [...EMERGENCY_EXTERNAL_STATE_PATHS],
        options,
      );
      if (result.changedPaths.length > 0) {
        throw new Error(
          `${state.target} requires external-state changes: ${result.changedPaths.join(', ')}.`,
        );
      }
      result.status = 'compatible';
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      failed = true;
    }
  }

  report.status = failed ? 'failed' : 'compatible';
  report.completedAt = new Date().toISOString();
  writeJson(resolve(directory, 'emergency-code-only.json'), report);
  if (failed) {
    throw new Error(
      'Emergency deployment is code-only and cannot cross D1, R2, contract-marker, or Worker-configuration changes. Use the approved Production Release workflow.',
    );
  }
  console.log('Emergency code-only external-state verification passed.');
  return report;
}

function updateState(
  target: string,
  directory: string,
  update: Record<string, unknown>,
): { paths: ReturnType<typeof pathsFor>; state: Record<string, unknown> } {
  const paths = pathsFor(target, directory);
  const state = readJson(paths.state);
  if (state.schemaVersion !== SCHEMA_VERSION || state.target !== target) {
    throw new Error(`Malformed deployment state for ${target}.`);
  }
  writeJson(paths.state, { ...state, ...update });
  return { paths, state: { ...state, ...update } };
}

function markAttempt(target: string, directory: string): void {
  updateState(target, directory, {
    attempted: true,
    attemptedAt: new Date().toISOString(),
  });
  console.log(`Marked ${target} deployment as attempted.`);
}

function record(target: string, directory: string): Record<string, unknown> {
  const paths = pathsFor(target, directory);
  const after = readJson(paths.after);
  const afterVersionId = productionVersion(after, `${target} after deployment`);
  const previousState = readJson(paths.state);
  const afterMessage = deploymentMessage(after);
  const changed = afterVersionId !== previousState.beforeVersionId;
  const ownedByRelease = afterMessage === previousState.releaseMessage;
  const { state } = updateState(target, directory, {
    afterDeploymentId: after.id || null,
    afterVersionId,
    afterMessage,
    changed,
    ownedByRelease,
    recordedAt: new Date().toISOString(),
  });
  console.log(`${target} production version ${state.beforeVersionId} -> ${state.afterVersionId}`);
  if (!changed) {
    throw new Error(`${target} deploy did not create a new 100% production version.`);
  }
  if (!ownedByRelease) {
    throw new Error(`${target} production deployment is not owned by this release.`);
  }
  return state;
}

function recordCurrentDeployment(
  target: string,
  directory: string,
  options: QueryInjectionOptions = {},
): Record<string, unknown> {
  const definition = targetDefinition(target);
  const paths = pathsFor(target, directory);
  const current = (options.queryCurrent || queryCurrent)(
    target,
    definition.config,
    paths.after,
    options.queryOptions,
  );
  if (!current?.deployment) {
    throw new Error(`${target} current deployment query did not return its source payload.`);
  }
  writeJson(paths.after, current.deployment);
  return record(target, directory);
}

function recordedVersion(target: string, directory: string): void {
  const state = readJson(pathsFor(target, directory).state);
  if (typeof state.afterVersionId !== 'string' || !state.afterVersionId) {
    throw new Error(`No recorded deployment version for ${target}.`);
  }
  process.stdout.write(state.afterVersionId);
}

function runWrangler(args: string[], options: CommandRunnerCallOptions = {}): unknown {
  return executeNpm(['run', '--silent', 'wrangler', '--', ...args], {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

function queryCurrentOnce(
  target: string,
  config: string,
  outputPath: string,
  runner: CommandRunner = runWrangler,
): DeploymentVersion {
  const stdout = runner(['deployments', 'status', '--config', config, '--json'], {
    capture: true,
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  const source = String(stdout);
  writeFileSync(outputPath, source, 'utf8');
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed)) {
    throw new Error(`${target} current deployment is not a JSON object.`);
  }
  const deployment = parsed;
  return {
    deployment,
    deploymentId: stringOrNull(deployment.id),
    versionId: productionVersion(deployment, `${target} current deployment`),
    message: deploymentMessage(deployment),
  };
}

function queryCurrent(
  target: string,
  config: string,
  outputPath: string,
  options: QueryCurrentOptions = {},
): DeploymentVersion {
  return retrySync(
    `${target} production deployment query`,
    () => queryCurrentOnce(target, config, outputPath, options.runner),
    { ...QUERY_RETRY, ...options.retry },
  );
}

function verifyPartialReleaseCompatibility(
  releaseTarget: string,
  headSha: string,
  directory: string,
  options: CompatibilityOptions = {},
): OperationReport {
  const selectedWorkers = releaseTargetWorkers(releaseTarget);
  const reportPath = resolve(directory, 'partial-release-compatibility.json');
  const report: OperationReport = {
    schemaVersion: SCHEMA_VERSION,
    releaseTarget,
    releaseGitSha: headSha,
    startedAt: new Date().toISOString(),
    status: releaseTarget === 'all' ? 'not-required' : 'pending',
    results: [],
  };

  if (releaseTarget === 'all') {
    report.completedAt = new Date().toISOString();
    writeJson(reportPath, report);
    console.log('Full release selected; partial-release compatibility gate is not required.');
    return report;
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha || '')) {
    throw new Error('A full 40-character release Git SHA is required for compatibility checks.');
  }

  let failed = false;
  const query = options.queryCurrent || queryCurrent;
  const diffRuntimePaths = options.changedRuntimePaths || changedRuntimePaths;
  const diffRuntimeDependencies =
    options.changedAppRuntimeDependencies || changedAppRuntimeDependencies;
  for (const [target, definition] of Object.entries(TARGETS)) {
    if (!isWorkerTarget(target)) continue;
    if (selectedWorkers.has(target)) continue;
    const result: ReportResult = {
      target,
      status: 'pending',
      runtimePaths: TARGET_RUNTIME_PATHS[target],
    };
    report.results.push(result);
    try {
      const current = query(
        target,
        definition.config,
        resolve(directory, `${target}-compatibility-current.json`),
        options.queryOptions,
      );
      result.deployedDeploymentId = current.deploymentId || null;
      result.deployedVersionId = current.versionId || null;
      result.deployedMessage = current.message || null;
      result.deployedGitSha = releaseGitSha(current.message);
      if (!result.deployedDeploymentId || !result.deployedVersionId) {
        throw new Error(`${target} production deployment identity is incomplete.`);
      }
      if (!result.deployedGitSha) {
        throw new Error(
          `${target} production deployment does not record a git:<40-char-sha> release message.`,
        );
      }
      const changedPaths = diffRuntimePaths(
        result.deployedGitSha,
        headSha.toLowerCase(),
        [...TARGET_RUNTIME_PATHS[target]],
        { target, kind: 'runtime' },
      );
      if (target === 'app') {
        const manifestChanges = diffRuntimePaths(
          result.deployedGitSha,
          headSha.toLowerCase(),
          ['package.json', 'package-lock.json'],
          { target, kind: 'dependency-manifest' },
        );
        if (manifestChanges.length > 0) {
          changedPaths.push(
            ...diffRuntimeDependencies(
              result.deployedGitSha,
              headSha.toLowerCase(),
              options.gitRunner ? { runner: options.gitRunner } : {},
            ),
          );
        }
      }
      result.changedPaths = [...new Set(changedPaths)].sort();
      if (result.changedPaths.length > 0) {
        result.status = 'incompatible';
        result.error =
          `${target} has undeployed production-source changes. ` +
          `Use target 'all' or first publish a source-equivalent ${target} release.`;
        failed = true;
      } else {
        result.status = 'compatible';
      }
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      failed = true;
    }
  }

  report.completedAt = new Date().toISOString();
  report.status = failed ? 'failed' : 'compatible';
  writeJson(reportPath, report);
  console.log(`Partial-release compatibility: ${reportPath} (${report.status})`);
  if (failed) {
    const blocked = report.results
      .filter((result) => result.status !== 'compatible')
      .map((result) => `${result.target}: ${result.error}`)
      .join(' | ');
    throw new Error(`Partial release compatibility check failed. ${blocked}`);
  }
  return report;
}

function recheckPartialReleaseCompatibility(
  releaseTarget: string,
  headSha: string,
  directory: string,
  options: QueryInjectionOptions = {},
): OperationReport {
  const selectedWorkers = releaseTargetWorkers(releaseTarget);
  const reportPath = resolve(directory, 'partial-release-compatibility.json');
  const recheckPath = resolve(directory, 'partial-release-compatibility-recheck.json');
  const recheck: OperationReport = {
    schemaVersion: SCHEMA_VERSION,
    releaseTarget,
    releaseGitSha: headSha,
    startedAt: new Date().toISOString(),
    status: releaseTarget === 'all' ? 'not-required' : 'pending',
    results: [],
  };

  if (releaseTarget === 'all') {
    recheck.completedAt = new Date().toISOString();
    writeJson(recheckPath, recheck);
    console.log('Full release selected; partial-release compatibility recheck is not required.');
    return recheck;
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha || '')) {
    throw new Error('A full 40-character release Git SHA is required for compatibility rechecks.');
  }

  const expectedTargets = Object.keys(TARGETS).filter(
    (target): target is WorkerTarget => isWorkerTarget(target) && !selectedWorkers.has(target),
  );
  let captured: Record<string, unknown> | undefined;
  try {
    captured = readJson(reportPath);
  } catch (error) {
    recheck.status = 'failed';
    recheck.error =
      `The captured partial-release compatibility report is unavailable: ` +
      (error instanceof Error ? error.message : String(error));
  }

  const capturedResults = Array.isArray(captured?.results) ? captured.results : [];
  const capturedByTarget = new Map<string, Record<string, unknown>>();
  for (const result of capturedResults) {
    if (
      !isRecord(result) ||
      typeof result.target !== 'string' ||
      capturedByTarget.has(result.target)
    ) {
      continue;
    }
    capturedByTarget.set(result.target, result);
  }
  const capturedTargets = [...capturedByTarget.keys()].sort();
  if (
    recheck.status !== 'failed' &&
    (captured?.schemaVersion !== SCHEMA_VERSION ||
      captured?.releaseTarget !== releaseTarget ||
      String(captured?.releaseGitSha || '').toLowerCase() !== headSha.toLowerCase() ||
      captured?.status !== 'compatible' ||
      capturedResults.length !== expectedTargets.length ||
      !isDeepStrictEqual(capturedTargets, [...expectedTargets].sort()))
  ) {
    recheck.status = 'failed';
    recheck.error =
      'The captured partial-release compatibility report does not match this release.';
  }

  let failed = recheck.status === 'failed';
  const query = options.queryCurrent || queryCurrent;
  if (!failed) {
    for (const target of expectedTargets) {
      const definition = targetDefinition(target);
      const baseline = capturedByTarget.get(target);
      const result: ReportResult = {
        target,
        expectedDeploymentId: stringOrNull(baseline?.deployedDeploymentId),
        expectedVersionId: stringOrNull(baseline?.deployedVersionId),
        expectedMessage: stringOrNull(baseline?.deployedMessage),
        status: 'pending',
      };
      recheck.results.push(result);
      try {
        if (
          baseline?.status !== 'compatible' ||
          typeof result.expectedDeploymentId !== 'string' ||
          !result.expectedDeploymentId ||
          typeof result.expectedVersionId !== 'string' ||
          !result.expectedVersionId ||
          typeof result.expectedMessage !== 'string' ||
          !result.expectedMessage
        ) {
          throw new Error(`${target} captured compatibility identity is incomplete.`);
        }
        const current = query(
          target,
          definition.config,
          resolve(directory, `${target}-compatibility-recheck-current.json`),
          options.queryOptions,
        );
        result.currentDeploymentId = current.deploymentId || null;
        result.currentVersionId = current.versionId || null;
        result.currentMessage = current.message || null;
        if (
          result.currentDeploymentId !== result.expectedDeploymentId ||
          result.currentVersionId !== result.expectedVersionId ||
          result.currentMessage !== result.expectedMessage
        ) {
          throw new Error(
            `${target} production changed after partial-release compatibility was captured; ` +
              `expected deployment ${result.expectedDeploymentId} / version ${result.expectedVersionId}, ` +
              `got ${result.currentDeploymentId || '(none)'} / ${result.currentVersionId || '(none)'}.`,
          );
        }
        result.status = 'compatible';
      } catch (error) {
        result.status = 'failed';
        result.error = error instanceof Error ? error.message : String(error);
        failed = true;
      }
    }
  }

  recheck.completedAt = new Date().toISOString();
  recheck.status = failed ? 'failed' : 'compatible';
  writeJson(recheckPath, recheck);
  console.log(`Partial-release compatibility recheck: ${recheckPath} (${recheck.status})`);
  if (failed) {
    const details = [
      recheck.error,
      ...recheck.results
        .filter((result) => result.status !== 'compatible')
        .map((result) => `${result.target}: ${result.error}`),
    ]
      .filter(Boolean)
      .join(' | ');
    throw new Error(`Partial release compatibility recheck failed. ${details}`);
  }
  return recheck;
}

function preflight(target: string, directory: string, options: QueryInjectionOptions = {}): void {
  const paths = pathsFor(target, directory);
  const state = readJson(paths.state);
  if (
    state.schemaVersion !== SCHEMA_VERSION ||
    state.target !== target ||
    typeof state.config !== 'string'
  ) {
    throw new Error(`Malformed deployment state for ${target}.`);
  }

  const current = (options.queryCurrent || queryCurrent)(
    target,
    state.config,
    paths.preflight,
    options.queryOptions,
  );
  const deploymentChanged = current.deploymentId !== state.beforeDeploymentId;
  const versionChanged = current.versionId !== state.beforeVersionId;
  if (deploymentChanged || versionChanged) {
    throw new Error(
      `${target} production changed after release preparation; expected deployment ` +
        `${state.beforeDeploymentId || '(none)'} / version ${state.beforeVersionId}, got ` +
        `${current.deploymentId || '(none)'} / version ${current.versionId}. Deploy was stopped.`,
    );
  }

  updateState(target, directory, {
    preflightDeploymentId: current.deploymentId,
    preflightVersionId: current.versionId,
    preflightCheckedAt: new Date().toISOString(),
  });
  console.log(`Verified unchanged production deployment for ${target}.`);
}

function runRollbackWithRetry(
  state: RollbackState,
  rollbackMessage: string,
  options: RollbackAttemptOptions = {},
): RollbackAttempt {
  const runner = options.runner || runWrangler;
  const query = options.queryCurrent || queryCurrent;
  if (!options.outputPath) {
    throw new Error(`A current-deployment output path is required to roll back ${state.target}.`);
  }
  const outputPath = options.outputPath;
  const confirmationOutputPath =
    options.confirmationOutputPath ||
    outputPath.replace(/\.json$/u, '-ownership-confirmation.json');
  let initialCurrent = options.initialCurrent || null;

  return retrySync(
    `${state.target} rollback attempt`,
    () => {
      // Recovery classifies the first fresh read before applying a compatibility
      // floor. Reuse that exact observation for the first attempt, then retain
      // the independent confirmation read immediately before any mutation.
      // A retry always starts from a new live observation.
      const current =
        initialCurrent || query(state.target, state.config, outputPath, options.queryOptions);
      initialCurrent = null;
      const disposition = rollbackDisposition(state, current);
      if (disposition !== 'rollback') {
        return { status: disposition, current, commandIssued: false };
      }

      // Cloudflare's rollback command has no compare-and-swap precondition.
      // The supported production lease makes this workflow the only writer
      // and forbids dashboard/out-of-band deploys while it is active. Re-read
      // the complete identity immediately before the command and stop without
      // mutation if either observation detects drift.
      const confirmed = query(
        state.target,
        state.config,
        confirmationOutputPath,
        options.queryOptions,
      );
      const confirmedDisposition = rollbackDisposition(state, confirmed);
      if (confirmedDisposition !== 'rollback') {
        return { status: confirmedDisposition, current: confirmed, commandIssued: false };
      }
      if (
        current.deploymentId !== confirmed.deploymentId ||
        current.versionId !== confirmed.versionId ||
        current.message !== confirmed.message
      ) {
        return { status: 'conflict', current: confirmed, commandIssued: false };
      }

      runner([
        'rollback',
        state.beforeVersionId,
        '--config',
        state.config,
        '--message',
        rollbackMessage,
        '--yes',
      ]);
      return { status: 'command-issued', current: confirmed, commandIssued: true };
    },
    { ...ROLLBACK_RETRY, ...options.retry },
  );
}

function verifyProductionVersion(
  target: string,
  config: string,
  expectedVersionId: string,
  outputPath: string,
  options: QueryCurrentOptions = {},
): DeploymentVersion {
  return retrySync(
    `${target} rollback verification`,
    () => {
      const current = queryCurrentOnce(target, config, outputPath, options.runner);
      if (current.versionId !== expectedVersionId) {
        throw new Error(
          `Rollback verification expected ${expectedVersionId}, got ${current.versionId}.`,
        );
      }
      return current;
    },
    { ...VERIFY_RETRY, ...options.retry },
  );
}

function attemptedStates(directory: string): AttemptedReleaseState[] {
  const states: AttemptedReleaseState[] = [];
  for (const target of Object.keys(TARGETS)) {
    if (!isWorkerTarget(target)) continue;
    const definition = TARGETS[target];
    const statePath = pathsFor(target, directory).state;
    if (!existsSync(statePath)) continue;
    const state = readJson(statePath);
    if (state.schemaVersion !== SCHEMA_VERSION || state.target !== target) {
      throw new Error(`Malformed deployment state for ${target}.`);
    }
    if (typeof state.attempted !== 'boolean') {
      throw new Error(`Malformed deployment-attempt marker for ${target}.`);
    }
    if (!state.attempted) continue;
    if (
      state.config !== definition.config ||
      typeof state.beforeVersionId !== 'string' ||
      !state.beforeVersionId ||
      typeof state.releaseMessage !== 'string' ||
      !CANONICAL_RELEASE_MESSAGE_RE.test(state.releaseMessage)
    ) {
      throw new Error(`Malformed attempted deployment evidence for ${target}.`);
    }
    states.push({
      ...state,
      target,
      config: definition.config,
      attempted: true,
      beforeVersionId: state.beforeVersionId,
      releaseMessage: state.releaseMessage,
      rollbackOrder: definition.rollbackOrder,
    });
  }
  return states.sort((left, right) => right.rollbackOrder - left.rollbackOrder);
}

function verifyCurrentRelease(
  directory: string,
  options: QueryInjectionOptions = {},
): OperationReport {
  const reportPath = resolve(directory, 'final-verification-report.json');
  const report: OperationReport = {
    schemaVersion: SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    status: 'pending',
    results: [],
  };
  let failed = false;
  const query = options.queryCurrent || queryCurrent;
  const states = attemptedStates(directory).reverse();

  if (states.length === 0) {
    report.status = 'failed';
    report.results.push({
      target: 'release-state',
      status: 'failed',
      error: 'No attempted Worker deployment state was found for final verification.',
    });
    failed = true;
  }

  for (const state of states) {
    const result: ReportResult = {
      target: state.target,
      expectedDeploymentId: state.afterDeploymentId || null,
      expectedVersionId: state.afterVersionId || null,
      expectedMessage: state.releaseMessage || null,
      status: 'pending',
    };
    report.results.push(result);

    if (
      state.ownedByRelease !== true ||
      !state.afterDeploymentId ||
      !state.afterVersionId ||
      !state.releaseMessage
    ) {
      result.status = 'failed';
      result.error =
        'The attempted deployment was not completely recorded as owned by this release.';
      failed = true;
      continue;
    }

    try {
      const current = query(
        state.target,
        state.config,
        pathsFor(state.target, directory).finalCurrent,
        options.queryOptions,
      );
      result.currentDeploymentId = current.deploymentId || null;
      result.currentVersionId = current.versionId || null;
      result.currentMessage = current.message || null;

      const matchesRelease =
        current.deploymentId === state.afterDeploymentId &&
        current.versionId === state.afterVersionId &&
        current.message === state.releaseMessage;
      if (!matchesRelease) {
        result.status = 'conflict';
        result.error =
          'Current production no longer matches the deployment recorded by this release.';
        failed = true;
        continue;
      }

      result.status = 'verified';
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      failed = true;
    }
  }

  report.completedAt = new Date().toISOString();
  report.status = failed ? 'failed' : 'verified';
  writeJson(reportPath, report);
  console.log(`Final deployment verification: ${reportPath} (${report.status})`);
  if (failed) {
    throw new Error(
      'Final production deployment verification failed; another deployment may have replaced this release.',
    );
  }
  return report;
}

function verifyRecoveryBoundary(
  directory: string,
  options: QueryInjectionOptions = {},
): OperationReport {
  const reportPath = resolve(directory, 'recovery-final-verification.json');
  const report: OperationReport = {
    schemaVersion: SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    status: 'pending',
    results: [],
  };
  let failed = false;
  const query = options.queryCurrent || queryCurrent;

  let states: AttemptedReleaseState[] = [];
  let rollbackReport: Record<string, unknown>;
  try {
    states = attemptedStates(directory);
    rollbackReport = readJson(resolve(directory, 'rollback-report.json'));
    if (
      rollbackReport?.schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray(rollbackReport.results)
    ) {
      throw new Error('The rollback report is missing or malformed.');
    }
    if (states.length === 0) {
      throw new Error('No attempted Worker deployment state was found for recovery verification.');
    }
  } catch (error) {
    report.results.push({
      target: 'release-state',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    report.completedAt = new Date().toISOString();
    report.status = 'failed';
    writeJson(reportPath, report);
    throw new Error('Final recovery boundary verification could not read its immutable evidence.', {
      cause: error,
    });
  }

  for (const state of states) {
    const rollbackResults = rollbackReport.results;
    if (!Array.isArray(rollbackResults)) {
      throw new Error('The rollback report is missing or malformed.');
    }
    const matchingResults = rollbackResults.filter(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) && candidate.target === state.target,
    );
    const rollbackResult = matchingResults[0];
    const result: ReportResult = {
      target: state.target,
      rollbackStatus: stringOrNull(rollbackResult?.status),
      expectedBaselineVersionId: state.beforeVersionId || null,
      expectedCandidateMessage: state.releaseMessage || null,
      status: 'pending',
    };
    report.results.push(result);

    if (matchingResults.length !== 1 || !rollbackResult) {
      result.status = 'failed';
      result.error = 'Recovery requires exactly one rollback result for every attempted Worker.';
      failed = true;
      continue;
    }

    const rollbackStatus = stringOrNull(rollbackResult.status);
    const expectsBaseline = rollbackStatus
      ? ['restored', 'already-restored'].includes(rollbackStatus)
      : false;
    const expectsCandidate = [
      'skipped-compatibility-floor',
      'skipped-dependent-worker-not-restored',
    ].includes(rollbackStatus || '');
    if (!expectsBaseline && !expectsCandidate) {
      result.status = 'failed';
      result.error = `Rollback result ${rollbackStatus || 'unknown'} does not prove a coherent recovery boundary.`;
      failed = true;
      continue;
    }

    try {
      const current = query(
        state.target,
        state.config,
        pathsFor(state.target, directory).recoveryFinalCurrent,
        options.queryOptions,
      );
      result.currentDeploymentId = current.deploymentId || null;
      result.currentVersionId = current.versionId || null;
      result.currentMessage = current.message || null;

      const matchesBaseline = current.versionId === state.beforeVersionId;
      const matchesRecordedCandidate =
        state.ownedByRelease === true &&
        Boolean(state.afterVersionId) &&
        current.versionId === state.afterVersionId &&
        (!state.afterDeploymentId || current.deploymentId === state.afterDeploymentId);
      const matchesCandidate =
        matchesRecordedCandidate ||
        (Boolean(state.releaseMessage) && current.message === state.releaseMessage);
      if ((expectsBaseline && !matchesBaseline) || (expectsCandidate && !matchesCandidate)) {
        result.status = 'conflict';
        result.error = expectsBaseline
          ? 'Current production no longer matches the captured baseline restored by recovery.'
          : 'Current production no longer matches the exact failed-release candidate retained for forward repair.';
        failed = true;
        continue;
      }

      result.status = expectsBaseline ? 'verified-baseline' : 'verified-forward-boundary';
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      failed = true;
    }
  }

  report.completedAt = new Date().toISOString();
  report.status = failed ? 'failed' : 'verified';
  writeJson(reportPath, report);
  console.log(`Final recovery boundary verification: ${reportPath} (${report.status})`);
  if (failed) {
    throw new Error(
      'Final recovery boundary verification failed; production is not a proven baseline or forward-repair candidate.',
    );
  }
  return report;
}

function rollbackSkipTargets(value = process.env.MXQR_ROLLBACK_SKIP_TARGETS): ReadonlySet<string> {
  if (!value?.trim()) return new Set<string>();
  const targets = new Set(
    value
      .split(/[\s,]+/)
      .map((target) => target.trim())
      .filter(Boolean),
  );
  for (const target of targets) targetDefinition(target);
  return targets;
}

function rollbackDisposition(state: Record<string, unknown>, current: DeploymentVersion): string {
  if (
    typeof state?.beforeVersionId !== 'string' ||
    !state.beforeVersionId ||
    typeof state?.releaseMessage !== 'string' ||
    !CANONICAL_RELEASE_MESSAGE_RE.test(state.releaseMessage) ||
    typeof current?.versionId !== 'string' ||
    !current.versionId
  ) {
    return 'conflict';
  }
  if (current.versionId === state.beforeVersionId) return 'already-restored';
  const isRecordedDeployment =
    state.ownedByRelease === true &&
    Boolean(state.afterVersionId) &&
    current.versionId === state.afterVersionId &&
    (!state.afterDeploymentId || current.deploymentId === state.afterDeploymentId);
  const isReleaseMessageMatch =
    typeof current.message === 'string' && current.message === state.releaseMessage;
  return isRecordedDeployment || isReleaseMessageMatch ? 'rollback' : 'conflict';
}

function rollbackDependencyBlock(
  target: string,
  states: ReadonlyArray<Record<string, unknown>>,
  results: ReadonlyArray<Record<string, unknown>>,
): { dependency: string; dependencyStatus: string } | null {
  // The current browser and signaling Worker negotiate PRO bearer tickets as
  // an exact WebSocket subprotocol pair. Rollback runs App first; if that
  // rollback is withheld by a durable/R2 compatibility floor or otherwise
  // cannot be verified, restoring a Worker without the exact subprotocol
  // contract would strand every PRO client served by the retained App. Keep
  // signaling current until App is known to be on its captured baseline.
  if (target === 'signaling' && states.some((state) => state.target === 'app')) {
    const appResult = results.find((result) => result.target === 'app');
    const appStatus = stringOrNull(appResult?.status);
    if (appStatus && ['restored', 'already-restored'].includes(appStatus)) {
      return null;
    }
    return {
      dependency: 'app',
      dependencyStatus: stringOrNull(appResult?.status) || 'not-processed',
    };
  }

  // The current App requires the assertion-v1 Remote Share security contract.
  // If App rollback is withheld or cannot be verified, restoring an older
  // Remote Share Worker would make every retained client reject /session
  // before upload. Keep Remote Share current until App is proven baseline.
  if (target === 'remote-share' && states.some((state) => state.target === 'app')) {
    const appResult = results.find((result) => result.target === 'app');
    const appStatus = stringOrNull(appResult?.status);
    if (appStatus && ['restored', 'already-restored'].includes(appStatus)) {
      return null;
    }
    return {
      dependency: 'app',
      dependencyStatus: stringOrNull(appResult?.status) || 'not-processed',
    };
  }

  // Signaling authorization is server-owned by the PRO room Durable Object.
  // A release that rolled signaling forward must restore signaling before it
  // can safely restore PRO. Otherwise a newer signaling Worker would call an
  // authority endpoint that no longer exists on the previous PRO Worker.
  if (target === 'pro-room' && states.some((state) => state.target === 'signaling')) {
    const signalingResult = results.find((result) => result.target === 'signaling');
    const signalingStatus = stringOrNull(signalingResult?.status);
    if (signalingStatus && ['restored', 'already-restored'].includes(signalingStatus)) {
      return null;
    }
    return {
      dependency: 'signaling',
      dependencyStatus: stringOrNull(signalingResult?.status) || 'not-processed',
    };
  }

  return null;
}

function rollback(directory: string, options: RollbackOptions = {}): OperationReport {
  const reportPath = resolve(directory, 'rollback-report.json');
  const report: OperationReport = {
    schemaVersion: SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    status: 'not-required',
    results: [],
  };
  let failed = false;
  let forwardBoundary = false;
  const query = options.queryCurrent || queryCurrent;
  const rollbackRunner = options.runRollbackWithRetry || runRollbackWithRetry;
  const verifyVersion = options.verifyProductionVersion || verifyProductionVersion;

  let states: AttemptedReleaseState[];
  let skipTargets: ReadonlySet<string>;
  try {
    states = attemptedStates(directory);
    skipTargets =
      options.skipTargets instanceof Set
        ? options.skipTargets
        : rollbackSkipTargets(options.skipTargets);
  } catch (error) {
    report.status = 'partial-failure';
    report.results.push({
      target: 'release-state',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    report.completedAt = new Date().toISOString();
    writeJson(reportPath, report);
    return report;
  }

  for (const state of states) {
    const paths = pathsFor(state.target, directory);
    const result: ReportResult = {
      target: state.target,
      beforeVersionId: state.beforeVersionId,
      deployedVersionId: state.afterVersionId || null,
      status: 'pending',
    };
    report.results.push(result);

    try {
      // A compatibility floor says that an exact release candidate must not be
      // rolled back. It does not turn a Worker that was never deployed (or a
      // failed deploy that left production unchanged) into that candidate.
      // Resolve the live identity before applying either a floor or a dependent
      // Worker hold so persisted pre-mutation checkpoints remain idempotent in
      // the independent recovery job.
      const current = query(
        state.target,
        state.config,
        paths.rollbackCurrent,
        options.queryOptions,
      );
      result.currentDeploymentId = current.deploymentId || null;
      result.currentVersionId = current.versionId || null;
      result.currentMessage = current.message || null;
      const disposition = rollbackDisposition(state, current);
      if (disposition === 'conflict') {
        result.status = 'conflict';
        result.error =
          'Current production is neither the captured baseline nor the exact release candidate; automatic rollback was skipped.';
        failed = true;
        continue;
      }

      const dependencyBlock = rollbackDependencyBlock(state.target, states, report.results);
      if (disposition === 'already-restored') {
        if (dependencyBlock) {
          result.status = 'incompatible-baseline-dependent-worker';
          result.error =
            `${state.target} is still on its captured baseline while ` +
            `${dependencyBlock.dependency} recovery is ${dependencyBlock.dependencyStatus}; ` +
            'automatic recovery cannot prove this cross-Worker protocol boundary.';
          failed = true;
          continue;
        }
        result.status = 'already-restored';
        continue;
      }

      if (skipTargets.has(state.target)) {
        result.status = 'skipped-compatibility-floor';
        result.error =
          'The exact release candidate remains deployed to preserve the active schema or generation compatibility floor.';
        forwardBoundary = true;
        continue;
      }

      if (dependencyBlock) {
        result.status = 'skipped-dependent-worker-not-restored';
        result.error =
          `Automatic ${state.target} rollback was withheld because ` +
          `${dependencyBlock.dependency} recovery is ${dependencyBlock.dependencyStatus}; ` +
          `the exact release candidate remains deployed to preserve cross-Worker compatibility.`;
        forwardBoundary = true;
        continue;
      }

      const rollbackContext =
        process.env.RELEASE_ROLLBACK_MESSAGE ||
        `rollback:${process.env.GITHUB_SHA || 'unknown'} run:${process.env.GITHUB_RUN_ID || 'local'}`;
      const rollbackMessage = rollbackDeploymentMessage(state, rollbackContext);
      const rollbackAttempt = rollbackRunner(state, rollbackMessage, {
        outputPath: paths.rollbackCurrent,
        confirmationOutputPath: paths.rollbackCurrent.replace(
          /\.json$/u,
          '-ownership-confirmation.json',
        ),
        initialCurrent: current,
        queryCurrent: query,
        queryOptions: options.queryOptions,
        runner: options.runner,
        retry: options.rollbackRetry,
      });
      result.currentDeploymentId = rollbackAttempt.current.deploymentId || null;
      result.currentVersionId = rollbackAttempt.current.versionId;
      result.currentMessage = rollbackAttempt.current.message || null;

      if (rollbackAttempt.status === 'already-restored') {
        result.status = 'already-restored';
        continue;
      }

      if (rollbackAttempt.status === 'conflict') {
        result.status = 'conflict';
        result.error =
          'Current production version is not owned by this release; automatic rollback was skipped.';
        failed = true;
        continue;
      }

      const restored = verifyVersion(
        state.target,
        state.config,
        state.beforeVersionId,
        paths.rollback,
        {
          runner: options.runner,
          retry: options.verifyRetry,
        },
      );
      result.restoredVersionId = restored.versionId;
      result.status = 'restored';
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      failed = true;
    }
  }

  report.completedAt = new Date().toISOString();
  if (failed) report.status = 'partial-failure';
  else if (forwardBoundary) report.status = 'forward-repair-required';
  else if (report.results.length > 0) report.status = 'succeeded';
  writeJson(reportPath, report);
  console.log(`Rollback report: ${reportPath} (${report.status})`);
  return report;
}

function summary(directory: string): void {
  const reportPath = resolve(directory, 'rollback-report.json');
  const lines = ['#### Automatic rollback'];
  if (!existsSync(reportPath)) {
    lines.push('- Not requested.');
  } else {
    const report = readJson(reportPath);
    lines.push(`- Result: \`${report.status}\``);
    const results = Array.isArray(report.results) ? report.results : [];
    for (const result of results) {
      if (!isRecord(result)) continue;
      let detail = `- \`${result.target}\`: \`${result.status}\``;
      if (result.beforeVersionId) detail += ` (previous: \`${result.beforeVersionId}\`)`;
      if (result.error) detail += `; ${result.error}`;
      lines.push(detail);
    }
  }
  const output = `${lines.join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, output, { encoding: 'utf8', flag: 'a' });
  } else {
    process.stdout.write(output);
  }
}

function main(): void {
  const [mode, targetArgument, valueArgument, directoryArgument] = process.argv.slice(2);
  const target = targetArgument || '';
  const value = valueArgument || '';
  const directory = resolve(
    mode === 'compatibility' || mode === 'compatibility-recheck'
      ? directoryArgument || DEFAULT_DIRECTORY
      : mode === 'service-control-forward-floor' || mode === 'remote-share-forward-floor'
        ? valueArgument || DEFAULT_DIRECTORY
        : mode === 'checkpoint' || mode === 'emergency-code-only'
          ? valueArgument || DEFAULT_DIRECTORY
          : mode === 'verify-current' ||
              mode === 'verify-recovery' ||
              mode === 'rollback' ||
              mode === 'summary'
            ? targetArgument || DEFAULT_DIRECTORY
            : valueArgument || DEFAULT_DIRECTORY,
  );

  if (mode === 'prepare') prepare(target, directory);
  else if (mode === 'preflight') preflight(target, directory);
  else if (mode === 'attempt') markAttempt(target, directory);
  else if (mode === 'record') record(target, directory);
  else if (mode === 'version') recordedVersion(target, directory);
  else if (mode === 'checkpoint') {
    captureDeploymentCheckpoint(target, process.env.RELEASE_MESSAGE, directory);
  } else if (mode === 'emergency-code-only') {
    verifyEmergencyCodeOnly(target, directory);
  } else if (mode === 'compatibility') {
    verifyPartialReleaseCompatibility(target, value, directory);
  } else if (mode === 'compatibility-recheck') {
    recheckPartialReleaseCompatibility(target, value, directory);
  } else if (mode === 'service-control-forward-floor') {
    process.stdout.write(
      contractCutoverRequiresForwardRepair(
        target,
        'cloudflare/service-control-contract-version.txt',
        ['pro-room', 'app'],
        directory,
        { requireCheckpointInventory: Boolean(valueArgument) },
      )
        ? 'true'
        : 'false',
    );
  } else if (mode === 'remote-share-forward-floor') {
    process.stdout.write(
      contractCutoverRequiresForwardRepair(
        target,
        'cloudflare/remote-share-contract-version.txt',
        ['remote-share', 'app'],
        directory,
        { requireCheckpointInventory: Boolean(valueArgument) },
      )
        ? 'true'
        : 'false',
    );
  } else if (mode === 'verify-current') verifyCurrentRelease(directory);
  else if (mode === 'verify-recovery') verifyRecoveryBoundary(directory);
  else if (mode === 'rollback') {
    const report = rollback(directory);
    if (report.status === 'partial-failure') process.exitCode = 1;
  } else if (mode === 'summary') summary(directory);
  else {
    throw new Error(
      'Usage: node scripts/release-deployment-state.mts <prepare|preflight|attempt|record|version> <target> [directory] | checkpoint <release-target> [directory] | emergency-code-only <git-sha> [directory] | <compatibility|compatibility-recheck> <release-target> <git-sha> [directory] | <service-control-forward-floor|remote-share-forward-floor> <git-sha> [directory] | <verify-current|verify-recovery|rollback|summary> [directory]',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

export {
  attemptedStates,
  captureDeploymentCheckpoint,
  contractCutoverRequiresForwardRepair,
  changedRuntimePaths,
  changedAppRuntimeDependencies,
  deploymentMessage,
  EMERGENCY_EXTERNAL_STATE_PATHS,
  npmInvocation,
  preflight,
  productionVersion,
  queryCurrent,
  recordCurrentDeployment,
  recheckPartialReleaseCompatibility,
  releaseGitSha,
  releaseTargetWorkers,
  runtimePathsForWorker,
  rollbackDeploymentMessage,
  retrySync,
  rollbackDisposition,
  rollbackDependencyBlock,
  rollback,
  rollbackSkipTargets,
  runRollbackWithRetry,
  verifyPartialReleaseCompatibility,
  verifyEmergencyCodeOnly,
  verifyCurrentRelease,
  verifyRecoveryBoundary,
  verifyProductionVersion,
};

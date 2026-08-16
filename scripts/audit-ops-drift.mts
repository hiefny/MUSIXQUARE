import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertDurableObjectMigrationContract,
  assertDurableObjectMigrationRepositoryHistory,
} from './check-durable-object-migration-contract.mts';

export const OPS_DRIFT_CONTRACT_PATH = 'cloudflare/ops-drift.contract.json';
export const DEFAULT_OPS_DRIFT_REPORT_PATH = 'release-artifacts/ops-drift/report.json';

const CONTRACT_VERSION = 4;
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const GITHUB_API = 'https://api.github.com';
const LIVE_CHECK_TIMEOUT_MS = 15_000;
const LIVE_RESPONSE_MAX_BYTES = 512 * 1024;

type JsonObject = Record<string, unknown>;

interface OpsDriftContractOptions {
  root?: string;
  contract?: unknown;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRepoPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}

function assertRepoFile(
  root: string,
  path: unknown,
  label: string,
  suffix: string | null = null,
): asserts path is string {
  if (!isRepoPath(path) || (suffix !== null && !path.endsWith(suffix))) {
    throw new Error(`${label} must be a repository-relative${suffix ? ` ${suffix}` : ''} file.`);
  }
  const absolute = resolve(root, path);
  const relativePath = relative(root, absolute);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes the repository.`);
  }
  readFileSync(absolute);
}

function uniqueStrings(
  value: unknown,
  label: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(
      `${label} must be ${allowEmpty ? 'an array' : 'a non-empty array'} of unique strings.`,
    );
  }
}

export function loadOpsDriftContract(
  root = resolve(fileURLToPath(new URL('..', import.meta.url))),
): OpsDriftContract {
  const value: unknown = JSON.parse(readFileSync(resolve(root, OPS_DRIFT_CONTRACT_PATH), 'utf8'));
  if (!isOpsDriftContract(value)) {
    throw new Error('Operations drift contract must be a structurally valid JSON object.');
  }
  return value;
}

export function assertOpsDriftContract({
  root = resolve(fileURLToPath(new URL('..', import.meta.url))),
  contract = loadOpsDriftContract(root),
}: OpsDriftContractOptions = {}) {
  if (
    !hasExactKeys(contract, [
      'schemaVersion',
      'r2Cors',
      'r2Lifecycle',
      'workerSecrets',
      'workerSurfaces',
      'workerRoutes',
      'github',
      'manualChecks',
    ]) ||
    contract.schemaVersion !== CONTRACT_VERSION
  ) {
    throw new Error(`Operations drift contract must use schemaVersion ${CONTRACT_VERSION}.`);
  }
  if (!Array.isArray(contract.r2Cors) || contract.r2Cors.length === 0) {
    throw new Error('Operations drift contract must declare at least one R2 CORS policy.');
  }
  const buckets = new Set<string>();
  const sources = new Set<string>();
  for (const entry of contract.r2Cors) {
    if (!hasExactKeys(entry, ['bucket', 'source'])) {
      throw new Error('Every R2 CORS entry must contain exactly bucket and source.');
    }
    if (
      typeof entry.bucket !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(entry.bucket) ||
      buckets.has(entry.bucket)
    ) {
      throw new Error(`Invalid or duplicate R2 bucket: ${entry.bucket}`);
    }
    buckets.add(entry.bucket);
    assertRepoFile(root, entry.source, `${entry.bucket}.source`, '.json');
    if (sources.has(entry.source)) throw new Error(`Duplicate R2 CORS source: ${entry.source}`);
    sources.add(entry.source);
    const source: unknown = JSON.parse(readFileSync(resolve(root, entry.source), 'utf8'));
    normalizeCorsPolicy(source, `${entry.bucket}.source`, { exactKeys: true });
  }

  if (
    !hasExactKeys(contract.r2Lifecycle, ['exactPolicies', 'forbiddenShortDeletePolicies']) ||
    !Array.isArray(contract.r2Lifecycle.exactPolicies) ||
    contract.r2Lifecycle.exactPolicies.length === 0 ||
    !Array.isArray(contract.r2Lifecycle.forbiddenShortDeletePolicies) ||
    contract.r2Lifecycle.forbiddenShortDeletePolicies.length === 0
  ) {
    throw new Error(
      'R2 lifecycle drift contract must declare exactPolicies and forbiddenShortDeletePolicies.',
    );
  }
  const lifecycleBuckets = new Set<string>();
  const lifecycleSources = new Set<string>();
  for (const entry of contract.r2Lifecycle.exactPolicies) {
    if (!hasExactKeys(entry, ['bucket', 'source'])) {
      throw new Error('Every exact R2 lifecycle policy must contain exactly bucket and source.');
    }
    if (
      typeof entry.bucket !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(entry.bucket) ||
      lifecycleBuckets.has(entry.bucket)
    ) {
      throw new Error(`Invalid or duplicate R2 lifecycle bucket: ${entry.bucket}`);
    }
    lifecycleBuckets.add(entry.bucket);
    assertRepoFile(root, entry.source, `${entry.bucket}.source`, '.json');
    if (lifecycleSources.has(entry.source)) {
      throw new Error(`Duplicate R2 lifecycle source: ${entry.source}`);
    }
    lifecycleSources.add(entry.source);
    normalizeLifecyclePolicy(
      JSON.parse(readFileSync(resolve(root, entry.source), 'utf8')),
      `${entry.bucket}.source`,
      { exactKeys: true },
    );
  }
  for (const entry of contract.r2Lifecycle.forbiddenShortDeletePolicies) {
    if (!hasExactKeys(entry, ['bucket', 'maxAgeSeconds'])) {
      throw new Error(
        'Every forbidden short-delete policy must contain exactly bucket and maxAgeSeconds.',
      );
    }
    if (
      typeof entry.bucket !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(entry.bucket) ||
      lifecycleBuckets.has(entry.bucket)
    ) {
      throw new Error(`Invalid or duplicate R2 lifecycle bucket: ${entry.bucket}`);
    }
    if (
      typeof entry.maxAgeSeconds !== 'number' ||
      !Number.isSafeInteger(entry.maxAgeSeconds) ||
      entry.maxAgeSeconds < 1 ||
      entry.maxAgeSeconds > 31_536_000
    ) {
      throw new Error(`${entry.bucket}.maxAgeSeconds must be between 1 second and 1 year.`);
    }
    lifecycleBuckets.add(entry.bucket);
  }

  if (!Array.isArray(contract.workerSecrets) || contract.workerSecrets.length === 0) {
    throw new Error('Operations drift contract must declare Worker secret-name inventories.');
  }
  const secretWorkers = new Set<string>();
  let workerSecretNameCount = 0;
  for (const entry of contract.workerSecrets) {
    if (!hasExactKeys(entry, ['worker', 'expectedNames'])) {
      throw new Error(
        'Every Worker secret inventory must contain exactly worker and expectedNames.',
      );
    }
    if (
      typeof entry.worker !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(entry.worker) ||
      secretWorkers.has(entry.worker)
    ) {
      throw new Error(`Invalid or duplicate Worker secret inventory: ${entry.worker}`);
    }
    secretWorkers.add(entry.worker);
    uniqueStrings(entry.expectedNames, `${entry.worker}.expectedNames`, { allowEmpty: true });
    if (entry.expectedNames.some((name) => !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name))) {
      throw new Error(`${entry.worker}.expectedNames contains an invalid binding name.`);
    }
    const sortedNames = [...entry.expectedNames].sort();
    if (!entry.expectedNames.every((name, index) => name === sortedNames[index])) {
      throw new Error(`${entry.worker}.expectedNames must be sorted.`);
    }
    workerSecretNameCount += entry.expectedNames.length;
  }

  if (!Array.isArray(contract.workerSurfaces) || contract.workerSurfaces.length === 0) {
    throw new Error('Operations drift contract must declare exact Worker surfaces.');
  }
  const surfaceWorkers = new Set<string>();
  const sourceRoutes: Array<{ pattern: string; worker: string }> = [];
  let workerBindingCount = 0;
  let workerCustomDomainCount = 0;
  for (const entry of contract.workerSurfaces) {
    if (
      !hasExactKeys(entry, [
        'worker',
        'source',
        'exposure',
        'environment',
        'workersDev',
        'previewUrls',
        'customDomains',
      ])
    ) {
      throw new Error(
        'Every Worker surface must contain exactly worker, source, exposure, environment, workersDev, previewUrls, and customDomains.',
      );
    }
    if (
      typeof entry.worker !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(entry.worker) ||
      surfaceWorkers.has(entry.worker)
    ) {
      throw new Error(`Invalid or duplicate Worker surface: ${entry.worker}`);
    }
    const worker = entry.worker;
    surfaceWorkers.add(worker);
    assertRepoFile(root, entry.source, `${entry.worker}.source`, '.toml');
    if (
      (entry.exposure !== 'none' && entry.exposure !== 'custom-domains') ||
      entry.environment !== 'production' ||
      typeof entry.workersDev !== 'boolean' ||
      typeof entry.previewUrls !== 'boolean'
    ) {
      throw new Error(`${entry.worker} has an invalid exposure or subdomain contract.`);
    }
    uniqueStrings(entry.customDomains, `${entry.worker}.customDomains`, { allowEmpty: true });
    if (
      entry.customDomains.some(
        (hostname) =>
          hostname !== hostname.toLowerCase() ||
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(hostname),
      )
    ) {
      throw new Error(`${entry.worker}.customDomains contains an invalid hostname.`);
    }
    const sortedDomains = [...entry.customDomains].sort();
    if (!sameJson(entry.customDomains, sortedDomains)) {
      throw new Error(`${entry.worker}.customDomains must be sorted.`);
    }
    if (
      entry.workersDev ||
      entry.previewUrls ||
      (entry.exposure === 'none' && entry.customDomains.length !== 0) ||
      (entry.exposure === 'custom-domains' && entry.customDomains.length === 0)
    ) {
      throw new Error(`${entry.worker} violates its declared public-exposure boundary.`);
    }

    const sourceSurface = parseWorkerToml(
      readFileSync(resolve(root, entry.source), 'utf8'),
      entry.source,
    );
    if (
      sourceSurface.worker !== entry.worker ||
      sourceSurface.workersDev !== entry.workersDev ||
      sourceSurface.previewUrls !== entry.previewUrls ||
      !sameJson(sourceSurface.customDomains, entry.customDomains)
    ) {
      throw new Error(`${entry.worker} surface contract does not exactly match ${entry.source}.`);
    }
    if (entry.exposure === 'none' && sourceSurface.routes.length !== 0) {
      throw new Error(
        `${entry.worker} is private but its Wrangler source declares a public route.`,
      );
    }
    workerBindingCount += sourceSurface.bindings.length;
    workerCustomDomainCount += entry.customDomains.length;
    sourceRoutes.push(...sourceSurface.routes.map((pattern) => ({ pattern, worker })));
  }
  if (
    surfaceWorkers.size !== secretWorkers.size ||
    [...surfaceWorkers].some((worker) => !secretWorkers.has(worker))
  ) {
    throw new Error('Worker surface and Worker secret inventories must cover the same scripts.');
  }
  if (workerCustomDomainScopes(contract.workerSurfaces).length === 0) {
    throw new Error('Worker surfaces must establish at least one custom-domain inventory scope.');
  }

  if (!hasExactKeys(contract.workerRoutes, ['zoneIdEnv', 'readTokenEnv', 'expected'])) {
    throw new Error('Worker routes must declare exactly zoneIdEnv, readTokenEnv, and expected.');
  }
  for (const [key, value] of [
    ['zoneIdEnv', contract.workerRoutes.zoneIdEnv],
    ['readTokenEnv', contract.workerRoutes.readTokenEnv],
  ]) {
    if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/u.test(value)) {
      throw new Error(`workerRoutes.${key} must be an environment variable name.`);
    }
  }
  if (!Array.isArray(contract.workerRoutes.expected)) {
    throw new Error('workerRoutes.expected must be an array.');
  }
  const expectedRoutes = contract.workerRoutes.expected.map((route, index) => {
    if (
      !hasExactKeys(route, ['pattern', 'worker']) ||
      typeof route.pattern !== 'string' ||
      typeof route.worker !== 'string' ||
      route.pattern.length === 0 ||
      route.pattern.length > 255 ||
      !surfaceWorkers.has(route.worker)
    ) {
      throw new Error(`workerRoutes.expected[${index}] is invalid.`);
    }
    return { pattern: route.pattern, worker: route.worker };
  });
  const sortedExpectedRoutes = [...expectedRoutes].sort(stableCompare);
  if (
    new Set(expectedRoutes.map((route) => `${route.worker}\n${route.pattern}`)).size !==
      expectedRoutes.length ||
    !sameJson(expectedRoutes, sortedExpectedRoutes)
  ) {
    throw new Error('workerRoutes.expected must be unique and sorted.');
  }
  if (!sameJson([...sourceRoutes].sort(stableCompare), expectedRoutes)) {
    throw new Error('workerRoutes.expected does not exactly match the non-custom Wrangler routes.');
  }

  if (!hasExactKeys(contract.github, ['repository', 'branch', 'requiredEffectiveRuleTypes'])) {
    throw new Error(
      'GitHub drift contract must declare repository, branch, and requiredEffectiveRuleTypes.',
    );
  }
  if (
    typeof contract.github.repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(contract.github.repository)
  ) {
    throw new Error('GitHub repository must use owner/name syntax.');
  }
  if (
    typeof contract.github.branch !== 'string' ||
    !/^[A-Za-z0-9._/-]{1,200}$/u.test(contract.github.branch)
  ) {
    throw new Error('GitHub branch is invalid.');
  }
  uniqueStrings(contract.github.requiredEffectiveRuleTypes, 'GitHub requiredEffectiveRuleTypes');

  if (!Array.isArray(contract.manualChecks) || contract.manualChecks.length === 0) {
    throw new Error('Operations drift contract must state its manual-only checks.');
  }
  const manualIds = new Set<string>();
  for (const check of contract.manualChecks) {
    if (!hasExactKeys(check, ['id', 'label', 'runbook', 'reason'])) {
      throw new Error(
        'Every manual-only check must contain exactly id, label, runbook, and reason.',
      );
    }
    if (
      typeof check.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{2,80}$/u.test(check.id) ||
      manualIds.has(check.id)
    ) {
      throw new Error(`Invalid or duplicate manual check id: ${check.id}`);
    }
    manualIds.add(check.id);
    if (typeof check.label !== 'string' || check.label.length < 8 || check.label.length > 200) {
      throw new Error(`${check.id}.label must be 8-200 characters.`);
    }
    if (typeof check.reason !== 'string' || check.reason.length < 24 || check.reason.length > 500) {
      throw new Error(`${check.id}.reason must honestly explain the manual boundary.`);
    }
    assertRepoFile(root, check.runbook, `${check.id}.runbook`);
  }

  return {
    schemaVersion: CONTRACT_VERSION,
    r2CorsPolicyCount: buckets.size,
    r2ExactLifecyclePolicyCount: contract.r2Lifecycle.exactPolicies.length,
    r2ShortLifecycleGuardCount: contract.r2Lifecycle.forbiddenShortDeletePolicies.length,
    workerSecretPolicyCount: secretWorkers.size,
    workerSecretNameCount,
    workerSurfacePolicyCount: surfaceWorkers.size,
    workerBindingCount,
    workerCustomDomainCount,
    workerRouteCount: expectedRoutes.length,
    githubRuleCount: contract.github.requiredEffectiveRuleTypes.length,
    manualCheckCount: manualIds.size,
  };
}

interface ExactKeysOptions {
  exactKeys?: boolean;
}

interface LifecycleConditionOptions {
  allowDate?: boolean;
}

interface LifecycleRuleOptions extends ExactKeysOptions {
  allowEmptyPrefixOmission?: boolean;
}

type NormalizedLifecycleCondition =
  | { type: 'Age'; maxAge: number }
  | { type: 'Date'; date: string };

interface NormalizedLifecycleRule {
  id: string;
  enabled: boolean;
  conditions: { prefix: string };
  abortMultipartUploadsTransition: { condition: NormalizedLifecycleCondition } | null;
  deleteObjectsTransition: { condition: NormalizedLifecycleCondition } | null;
  storageClassTransitions: Array<{
    condition: NormalizedLifecycleCondition;
    storageClass: 'InfrequentAccess';
  }>;
}

function sortedStrings(
  value: unknown,
  transform: (entry: string) => string = (entry) => entry,
): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  return value.map(transform).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function normalizeCorsRule(
  value: unknown,
  label: string,
  { exactKeys = false }: ExactKeysOptions = {},
) {
  if (!isJsonObject(value)) {
    throw new Error(`${label} is not a CORS rule.`);
  }
  if (exactKeys && !hasExactKeys(value, ['id', 'allowed', 'exposeHeaders', 'maxAgeSeconds'])) {
    throw new Error(`${label} must contain exactly id, allowed, exposeHeaders, and maxAgeSeconds.`);
  }
  if (exactKeys && (typeof value.id !== 'string' || value.id.length === 0)) {
    throw new Error(`${label}.id must be a non-empty string.`);
  }
  const allowed = value.allowed;
  if (!isJsonObject(allowed)) {
    throw new Error(`${label}.allowed is missing.`);
  }
  if (exactKeys && !hasExactKeys(allowed, ['origins', 'methods', 'headers'])) {
    throw new Error(`${label}.allowed must contain exactly origins, methods, and headers.`);
  }
  const origins = sortedStrings(allowed.origins);
  const methods = sortedStrings(allowed.methods, (entry) => entry.toUpperCase());
  const headers = sortedStrings(allowed.headers || [], (entry) => entry.toLowerCase());
  const exposeHeaders = sortedStrings(value.exposeHeaders || [], (entry) => entry.toLowerCase());
  if (!origins?.length || !methods?.length || headers === null || exposeHeaders === null) {
    throw new Error(`${label} contains invalid origins, methods, or headers.`);
  }
  const maxAgeSeconds = value.maxAgeSeconds ?? 0;
  if (
    typeof maxAgeSeconds !== 'number' ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 0 ||
    maxAgeSeconds > 86_400
  ) {
    throw new Error(`${label}.maxAgeSeconds is invalid.`);
  }
  return {
    allowed: { origins, methods, headers },
    exposeHeaders,
    maxAgeSeconds,
  };
}

export function normalizeCorsPolicy(
  value: unknown,
  label = 'CORS policy',
  options: ExactKeysOptions = {},
) {
  if (!isJsonObject(value) || !Array.isArray(value.rules)) {
    throw new Error(`${label} must contain a rules array.`);
  }
  if (options.exactKeys && !hasExactKeys(value, ['rules'])) {
    throw new Error(`${label} must contain exactly rules.`);
  }
  return value.rules
    .map((rule, index) => normalizeCorsRule(rule, `${label}.rules[${index}]`, options))
    .sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    });
}

const LIFECYCLE_RULE_KEYS = new Set([
  'id',
  'enabled',
  'conditions',
  'abortMultipartUploadsTransition',
  'deleteObjectsTransition',
  'storageClassTransitions',
]);

function assertOnlyKeys(value: JsonObject, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown keys: ${unknown.join(', ')}.`);
}

function normalizeLifecycleCondition(
  value: unknown,
  label: string,
  { allowDate = true }: LifecycleConditionOptions = {},
): NormalizedLifecycleCondition {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a lifecycle condition.`);
  }
  if (value.type === 'Age') {
    if (!hasExactKeys(value, ['type', 'maxAge'])) {
      throw new Error(`${label} Age condition must contain exactly type and maxAge.`);
    }
    if (
      typeof value.maxAge !== 'number' ||
      !Number.isSafeInteger(value.maxAge) ||
      value.maxAge < 0
    ) {
      throw new Error(`${label}.maxAge must be a non-negative integer number of seconds.`);
    }
    return { type: 'Age', maxAge: value.maxAge };
  }
  if (allowDate && value.type === 'Date') {
    if (!hasExactKeys(value, ['type', 'date']) || typeof value.date !== 'string') {
      throw new Error(`${label} Date condition must contain exactly type and date.`);
    }
    const timestamp = Date.parse(value.date);
    if (!Number.isFinite(timestamp)) throw new Error(`${label}.date must be an ISO date-time.`);
    return { type: 'Date', date: new Date(timestamp).toISOString() };
  }
  throw new Error(`${label}.type must be ${allowDate ? 'Age or Date' : 'Age'}.`);
}

function normalizeLifecycleTransition(
  value: unknown,
  label: string,
  options: LifecycleConditionOptions,
): { condition: NormalizedLifecycleCondition } {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (!hasExactKeys(value, ['condition'])) {
    throw new Error(`${label} must contain exactly condition.`);
  }
  return { condition: normalizeLifecycleCondition(value.condition, `${label}.condition`, options) };
}

function normalizeStorageClassTransitions(
  value: unknown,
  label: string,
): Array<{ condition: NormalizedLifecycleCondition; storageClass: 'InfrequentAccess' }> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value
    .map(
      (
        transition,
        index,
      ): {
        condition: NormalizedLifecycleCondition;
        storageClass: 'InfrequentAccess';
      } => {
        if (
          !isJsonObject(transition) ||
          !hasExactKeys(transition, ['condition', 'storageClass']) ||
          transition.storageClass !== 'InfrequentAccess'
        ) {
          throw new Error(
            `${label}[${index}] must contain exactly an InfrequentAccess storageClass and condition.`,
          );
        }
        return {
          condition: normalizeLifecycleCondition(
            transition.condition,
            `${label}[${index}].condition`,
          ),
          storageClass: 'InfrequentAccess',
        };
      },
    )
    .sort((left, right) => stableCompare(left, right));
}

function stableCompare(left: unknown, right: unknown): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function normalizeLifecycleRule(
  value: unknown,
  label: string,
  options: LifecycleRuleOptions = {},
): NormalizedLifecycleRule {
  if (!isJsonObject(value)) {
    throw new Error(`${label} is not a lifecycle rule.`);
  }
  assertOnlyKeys(value, LIFECYCLE_RULE_KEYS, label);
  // Cloudflare's built-in "Default Multipart Abort Rule" currently returns
  // `conditions: {}` for its all-prefix scope even though the public API
  // schema models that scope as `conditions: { prefix: "" }`. Only the
  // short-delete safety audit accepts that observed live representation, and
  // normalizes it conservatively to the all-object empty prefix. Checked-in
  // exact policies and exact live-policy comparisons remain strict.
  const conditions = value.conditions;
  const explicitPrefix =
    isJsonObject(conditions) &&
    hasExactKeys(conditions, ['prefix']) &&
    typeof conditions.prefix === 'string'
      ? conditions.prefix
      : null;
  const hasExplicitPrefix = explicitPrefix !== null;
  const hasOmittedEmptyPrefix =
    options.allowEmptyPrefixOmission === true && hasExactKeys(value.conditions, []);
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    typeof value.enabled !== 'boolean' ||
    (!hasExplicitPrefix && !hasOmittedEmptyPrefix)
  ) {
    throw new Error(`${label} must declare id, enabled, and the exact conditions.prefix.`);
  }
  return {
    id: value.id,
    enabled: value.enabled,
    conditions: { prefix: explicitPrefix ?? '' },
    abortMultipartUploadsTransition:
      value.abortMultipartUploadsTransition === undefined ||
      value.abortMultipartUploadsTransition === null
        ? null
        : normalizeLifecycleTransition(
            value.abortMultipartUploadsTransition,
            `${label}.abortMultipartUploadsTransition`,
            { allowDate: false },
          ),
    deleteObjectsTransition:
      value.deleteObjectsTransition === undefined || value.deleteObjectsTransition === null
        ? null
        : normalizeLifecycleTransition(
            value.deleteObjectsTransition,
            `${label}.deleteObjectsTransition`,
            { allowDate: true },
          ),
    storageClassTransitions:
      value.storageClassTransitions === undefined || value.storageClassTransitions === null
        ? []
        : normalizeStorageClassTransitions(
            value.storageClassTransitions,
            `${label}.storageClassTransitions`,
          ),
  };
}

/**
 * Normalize the `result` object from Cloudflare's
 * GET /accounts/{account_id}/r2/buckets/{bucket_name}/lifecycle envelope.
 * The API declares `result.rules` optional, so an absent array is normalized to
 * an empty policy; checked-in source files must contain exactly `{ "rules": [] }`.
 */
export function normalizeLifecyclePolicy(
  value: unknown,
  label = 'lifecycle policy',
  options: LifecycleRuleOptions = {},
): NormalizedLifecycleRule[] {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a lifecycle API result object.`);
  }
  if (options.exactKeys && !hasExactKeys(value, ['rules'])) {
    throw new Error(`${label} must contain exactly rules.`);
  }
  if (!options.exactKeys) assertOnlyKeys(value, new Set(['rules']), label);
  const rules = value.rules === undefined ? [] : value.rules;
  if (!Array.isArray(rules)) throw new Error(`${label}.rules must be an array when present.`);
  return rules
    .map((rule, index) => normalizeLifecycleRule(rule, `${label}.rules[${index}]`, options))
    .sort(stableCompare);
}

export function shortDeleteLifecycleRules(
  policy: readonly NormalizedLifecycleRule[],
  maxAgeSeconds: number,
): string[] {
  if (!Array.isArray(policy) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new Error('A normalized lifecycle policy and positive maxAgeSeconds are required.');
  }
  return policy
    .filter((rule) => {
      if (!rule?.enabled || !rule.deleteObjectsTransition?.condition) return false;
      const condition = rule.deleteObjectsTransition.condition;
      return condition.type !== 'Age' || condition.maxAge <= maxAgeSeconds;
    })
    .map((rule) => {
      const condition = rule.deleteObjectsTransition.condition;
      return condition.type === 'Age'
        ? `${rule.id} (${condition.maxAge}s)`
        : `${rule.id} (${condition.date})`;
    });
}

export function normalizeWorkerSecretNames(value: unknown, label = 'Worker secrets'): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a secret binding array.`);
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const binding = value[index];
    if (!isJsonObject(binding)) {
      throw new Error(`${label}[${index}] must be a secret binding object.`);
    }
    if (
      typeof binding.name !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(binding.name) ||
      (binding.type !== 'secret_text' && binding.type !== 'secret_key')
    ) {
      throw new Error(`${label}[${index}] contains an invalid secret name or type.`);
    }
    if (seen.has(binding.name)) {
      throw new Error(`${label} contains a duplicate secret name.`);
    }
    seen.add(binding.name);
    names.push(binding.name);
  }
  return names.sort();
}

function stripTomlComment(value: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quoted && escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && character === '#') return value.slice(0, index).trim();
  }
  return value.trim();
}

type TomlScalar = string | boolean | number;

interface SimpleTomlTable {
  name: string;
  array?: boolean;
  values: Map<string, string>;
}

interface SimpleTomlDocument {
  root: SimpleTomlTable;
  tables: SimpleTomlTable[];
}

interface CanonicalWorkerBinding {
  name: string;
  type: string;
  target?: string;
  jurisdiction?: string;
  className?: string;
  scriptName?: string;
  environment?: string;
  entrypoint?: string;
}

interface WorkerBindingReference {
  canonical: CanonicalWorkerBinding;
  matches: (actual: JsonObject) => boolean;
}

interface ParsedWorkerToml {
  worker: string;
  workersDev: boolean;
  previewUrls: boolean;
  uploadSourceMaps: true;
  customDomains: string[];
  routes: string[];
  bindings: WorkerBindingReference[];
}

function parseSimpleToml(source: unknown, label: string): SimpleTomlDocument {
  if (typeof source !== 'string') throw new Error(`${label} must be TOML source text.`);
  const root: SimpleTomlTable = { name: '', values: new Map<string, string>() };
  const tables: SimpleTomlTable[] = [];
  let current = root;
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const arrayHeader = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/u);
    const tableHeader = line.match(/^\[([A-Za-z0-9_.-]+)\]$/u);
    const headerName = arrayHeader?.[1] ?? tableHeader?.[1];
    if (headerName !== undefined) {
      current = {
        name: headerName,
        array: Boolean(arrayHeader),
        values: new Map<string, string>(),
      };
      tables.push(current);
      continue;
    }
    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/u);
    const key = assignment?.[1];
    const rawValue = assignment?.[2];
    if (key === undefined || rawValue === undefined) continue;
    if (current.values.has(key)) {
      throw new Error(`${label}:${index + 1} repeats ${key}.`);
    }
    current.values.set(key, rawValue.trim());
  }
  return { root, tables };
}

function parseTomlScalar(raw: unknown, label: string): TomlScalar {
  if (typeof raw !== 'string') throw new Error(`${label} is missing.`);
  if (raw.startsWith('"')) {
    try {
      const value = JSON.parse(raw);
      if (typeof value !== 'string') throw new Error('not a string');
      return value;
    } catch (error) {
      throw new Error(`${label} must be a basic TOML string.`, { cause: error });
    }
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?(?:0|[1-9][0-9]*)$/u.test(raw)) return Number(raw);
  throw new Error(`${label} must be a string, boolean, or integer.`);
}

function requiredTomlValue(table: SimpleTomlTable, key: string, label: string): TomlScalar {
  return parseTomlScalar(table.values.get(key), `${label}.${key}`);
}

function optionalTomlValue(
  table: SimpleTomlTable,
  key: string,
  label: string,
): TomlScalar | undefined {
  return table.values.has(key) ? requiredTomlValue(table, key, label) : undefined;
}

function requiredTomlString(table: SimpleTomlTable, key: string, label: string): string {
  const value = requiredTomlValue(table, key, label);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
  return value;
}

function optionalTomlString(
  table: SimpleTomlTable,
  key: string,
  label: string,
): string | undefined {
  const value = optionalTomlValue(table, key, label);
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${label}.${key} must be a non-empty string when present.`);
  }
  return value;
}

function assertBindingName(name: unknown, label: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u.test(name)) {
    throw new Error(`${label} is not a valid Worker binding name.`);
  }
  return name;
}

function parseWorkerToml(source: unknown, label = 'Worker TOML'): ParsedWorkerToml {
  const document = parseSimpleToml(source, label);
  const worker = requiredTomlString(document.root, 'name', label);
  const workersDev = requiredTomlValue(document.root, 'workers_dev', label);
  const previewUrls = requiredTomlValue(document.root, 'preview_urls', label);
  const uploadSourceMaps = requiredTomlValue(document.root, 'upload_source_maps', label);
  if (
    typeof workersDev !== 'boolean' ||
    typeof previewUrls !== 'boolean' ||
    typeof uploadSourceMaps !== 'boolean'
  ) {
    throw new Error(
      `${label} must explicitly declare boolean workers_dev, preview_urls, and upload_source_maps.`,
    );
  }
  if (!uploadSourceMaps) {
    throw new Error(`${label}.upload_source_maps must be true for production diagnostics.`);
  }

  const bindings: WorkerBindingReference[] = [];
  const addBinding = (
    canonical: CanonicalWorkerBinding,
    matches: (actual: JsonObject) => boolean,
  ): void => {
    assertBindingName(canonical.name, `${label} binding`);
    bindings.push({ canonical, matches });
  };
  const tables = (name: string): SimpleTomlTable[] =>
    document.tables.filter((table) => table.name === name);
  const allowedRootKeys = new Set([
    'name',
    'main',
    'compatibility_date',
    'workers_dev',
    'preview_urls',
    'upload_source_maps',
  ]);
  const unknownRootKeys = [...document.root.values.keys()].filter(
    (key) => !allowedRootKeys.has(key),
  );
  const allowedTables = new Set([
    'assets',
    'd1_databases',
    'durable_objects.bindings',
    'kv_namespaces',
    'migrations',
    'observability',
    'observability.logs',
    'observability.traces',
    'r2_buckets',
    'ratelimits',
    'ratelimits.simple',
    'routes',
    'services',
    'triggers',
    'vars',
    'version_metadata',
  ]);
  const unknownTables = document.tables
    .map((table) => table.name)
    .filter((name) => !allowedTables.has(name));
  if (unknownRootKeys.length > 0 || unknownTables.length > 0) {
    throw new Error(
      `${label} contains source fields the binding audit does not understand: ${[
        ...unknownRootKeys,
        ...unknownTables,
      ].join(', ')}.`,
    );
  }
  for (const singleton of ['assets', 'vars', 'version_metadata']) {
    if (tables(singleton).length > 1) throw new Error(`${label} repeats [${singleton}].`);
  }

  for (const [index, table] of tables('assets').entries()) {
    const name = requiredTomlString(table, 'binding', `${label}.assets[${index}]`);
    addBinding({ name, type: 'assets' }, () => true);
  }
  for (const [index, table] of tables('version_metadata').entries()) {
    const name = requiredTomlString(table, 'binding', `${label}.version_metadata[${index}]`);
    addBinding({ name, type: 'version_metadata' }, () => true);
  }
  for (const [index, table] of tables('vars').entries()) {
    for (const [name, raw] of table.values) {
      assertBindingName(name, `${label}.vars[${index}]`);
      const expected = parseTomlScalar(raw, `${label}.vars.${name}`);
      addBinding(
        { name, type: 'plain_text', target: 'source-config' },
        (actual) => actual.text === String(expected),
      );
    }
  }
  for (const [index, table] of tables('r2_buckets').entries()) {
    const tableLabel = `${label}.r2_buckets[${index}]`;
    const name = requiredTomlString(table, 'binding', tableLabel);
    const bucketName = requiredTomlString(table, 'bucket_name', tableLabel);
    const jurisdiction = optionalTomlString(table, 'jurisdiction', tableLabel);
    const canonical: CanonicalWorkerBinding = { name, type: 'r2_bucket', target: bucketName };
    if (jurisdiction !== undefined) canonical.jurisdiction = jurisdiction;
    addBinding(
      canonical,
      (actual) =>
        actual.bucket_name === bucketName && (actual.jurisdiction ?? undefined) === jurisdiction,
    );
  }
  for (const [index, table] of tables('kv_namespaces').entries()) {
    const tableLabel = `${label}.kv_namespaces[${index}]`;
    const name = requiredTomlString(table, 'binding', tableLabel);
    const namespaceId = requiredTomlString(table, 'id', tableLabel);
    addBinding(
      { name, type: 'kv_namespace', target: 'source-config' },
      (actual) => actual.namespace_id === namespaceId,
    );
  }
  for (const [index, table] of tables('d1_databases').entries()) {
    const tableLabel = `${label}.d1_databases[${index}]`;
    const name = requiredTomlString(table, 'binding', tableLabel);
    const databaseName = requiredTomlString(table, 'database_name', tableLabel);
    const databaseId = requiredTomlString(table, 'database_id', tableLabel);
    addBinding(
      { name, type: 'd1', target: databaseName },
      (actual) => (actual.database_id ?? actual.id) === databaseId,
    );
  }
  for (const [index, table] of tables('durable_objects.bindings').entries()) {
    const tableLabel = `${label}.durable_objects.bindings[${index}]`;
    const name = requiredTomlString(table, 'name', tableLabel);
    const className = requiredTomlString(table, 'class_name', tableLabel);
    const scriptName = optionalTomlString(table, 'script_name', tableLabel) ?? worker;
    const environment = optionalTomlString(table, 'environment', tableLabel);
    const canonical: CanonicalWorkerBinding = {
      name,
      type: 'durable_object_namespace',
      className,
      scriptName,
    };
    if (environment !== undefined) canonical.environment = environment;
    addBinding(
      canonical,
      (actual) =>
        actual.class_name === className &&
        (actual.script_name ?? worker) === scriptName &&
        (actual.environment ?? undefined) === environment,
    );
  }
  for (const [index, table] of tables('services').entries()) {
    const tableLabel = `${label}.services[${index}]`;
    const name = requiredTomlString(table, 'binding', tableLabel);
    const service = requiredTomlString(table, 'service', tableLabel);
    const environment = optionalTomlString(table, 'environment', tableLabel) ?? 'production';
    const entrypoint = optionalTomlString(table, 'entrypoint', tableLabel);
    const canonical: CanonicalWorkerBinding = {
      name,
      type: 'service',
      target: service,
      environment,
    };
    if (entrypoint !== undefined) canonical.entrypoint = entrypoint;
    addBinding(
      canonical,
      (actual) =>
        actual.service === service &&
        (actual.environment ?? 'production') === environment &&
        (actual.entrypoint ?? undefined) === entrypoint,
    );
  }
  const rateLimits = tables('ratelimits');
  const rateLimitSimple = tables('ratelimits.simple');
  if (rateLimits.length !== rateLimitSimple.length) {
    throw new Error(`${label} must give every ratelimit binding one simple table.`);
  }
  for (const [index, table] of rateLimits.entries()) {
    const tableLabel = `${label}.ratelimits[${index}]`;
    const name = requiredTomlString(table, 'name', tableLabel);
    const namespaceId = requiredTomlString(table, 'namespace_id', tableLabel);
    const simple = rateLimitSimple[index];
    if (simple === undefined) {
      throw new Error(`${label} must give every ratelimit binding one simple table.`);
    }
    const limit = requiredTomlValue(simple, 'limit', `${tableLabel}.simple`);
    const period = requiredTomlValue(simple, 'period', `${tableLabel}.simple`);
    if (
      typeof limit !== 'number' ||
      typeof period !== 'number' ||
      !Number.isSafeInteger(limit) ||
      !Number.isSafeInteger(period)
    ) {
      throw new Error(`${tableLabel}.simple must contain integer limit and period values.`);
    }
    addBinding({ name, type: 'ratelimit', target: 'source-config' }, (actual) => {
      const actualSimple = actual.simple;
      return (
        actual.namespace_id === namespaceId &&
        isJsonObject(actualSimple) &&
        actualSimple.limit === limit &&
        actualSimple.period === period &&
        (actualSimple.mitigation_timeout ?? 0) === 0
      );
    });
  }

  const bindingKeys = bindings.map(({ canonical }) => canonical.name);
  if (new Set(bindingKeys).size !== bindingKeys.length) {
    throw new Error(`${label} contains a duplicate non-secret binding name and type.`);
  }
  bindings.sort((left, right) => stableCompare(left.canonical, right.canonical));

  const customDomains: string[] = [];
  const routes: string[] = [];
  for (const [index, table] of tables('routes').entries()) {
    const tableLabel = `${label}.routes[${index}]`;
    const pattern = requiredTomlString(table, 'pattern', tableLabel);
    const customDomain = optionalTomlValue(table, 'custom_domain', tableLabel) ?? false;
    if (typeof customDomain !== 'boolean') {
      throw new Error(`${tableLabel}.custom_domain must be boolean.`);
    }
    (customDomain ? customDomains : routes).push(customDomain ? pattern.toLowerCase() : pattern);
  }
  customDomains.sort();
  routes.sort();
  return {
    worker,
    workersDev,
    previewUrls,
    uploadSourceMaps,
    customDomains,
    routes,
    bindings,
  };
}

export function workerSurfaceFromToml(source: unknown, label = 'Worker TOML') {
  const surface = parseWorkerToml(source, label);
  return {
    worker: surface.worker,
    workersDev: surface.workersDev,
    previewUrls: surface.previewUrls,
    uploadSourceMaps: surface.uploadSourceMaps,
    customDomains: surface.customDomains,
    routes: surface.routes,
    bindings: surface.bindings.map(({ canonical }) => canonical),
  };
}

export function normalizeWorkerBindings(
  value: unknown,
  source: unknown,
  label = 'Worker bindings',
): CanonicalWorkerBinding[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a binding array.`);
  const sourceSurface = parseWorkerToml(source, `${label} source`);
  const expected = new Map(
    sourceSurface.bindings.map((entry) => [
      `${entry.canonical.type}\n${entry.canonical.name}`,
      entry,
    ]),
  );
  const normalized: CanonicalWorkerBinding[] = [];
  const seenNames = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const binding = value[index];
    if (!isJsonObject(binding)) {
      throw new Error(`${label}[${index}] must be a binding object.`);
    }
    if (binding.type === 'secret_text' || binding.type === 'secret_key') continue;
    const name = assertBindingName(binding.name, `${label}[${index}].name`);
    if (typeof binding.type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(binding.type)) {
      throw new Error(`${label}[${index}].type is invalid.`);
    }
    if (seenNames.has(name)) throw new Error(`${label} contains a duplicate binding name.`);
    seenNames.add(name);
    const reference = expected.get(`${binding.type}\n${name}`);
    normalized.push(
      reference === undefined
        ? { name, type: binding.type }
        : reference.matches(binding)
          ? reference.canonical
          : { name, type: binding.type, target: 'unexpected-configuration' },
    );
  }
  return normalized.sort(stableCompare);
}

export function normalizeActiveDeploymentVersions(
  value: unknown,
  label = 'Worker deployments',
): Array<{ versionId: string; percentage: number }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain an active deployment.`);
  }
  const active = value[0];
  if (!isJsonObject(active)) {
    throw new Error(`${label} active deployment is invalid.`);
  }
  if (!Array.isArray(active.versions) || active.versions.length < 1 || active.versions.length > 2) {
    throw new Error(`${label} active deployment must contain one or two serving versions.`);
  }
  const versions: Array<{ versionId: string; percentage: number }> = [];
  const seen = new Set<string>();
  let totalPercentage = 0;
  for (let index = 0; index < active.versions.length; index++) {
    const version = active.versions[index];
    if (
      !isJsonObject(version) ||
      typeof version.version_id !== 'string' ||
      version.version_id.length === 0 ||
      version.version_id.length > 200 ||
      typeof version.percentage !== 'number' ||
      !Number.isFinite(version.percentage) ||
      version.percentage <= 0 ||
      version.percentage > 100
    ) {
      throw new Error(`${label} active deployment contains an invalid serving version.`);
    }
    if (seen.has(version.version_id)) {
      throw new Error(`${label} active deployment contains a duplicate serving version.`);
    }
    seen.add(version.version_id);
    totalPercentage += version.percentage;
    versions.push({ versionId: version.version_id, percentage: version.percentage });
  }
  if (Math.abs(totalPercentage - 100) > 1e-9) {
    throw new Error(`${label} active deployment percentages must sum to 100.`);
  }
  return versions;
}

export function normalizeWorkerCustomDomains(
  value: unknown,
  worker: string,
  label = 'Worker custom domains',
): Array<{ hostname: string; environment: string }> {
  if (!Array.isArray(value)) throw new Error(`${label} must be a domain array.`);
  const domains: Array<{ hostname: string; environment: string }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const domain = value[index];
    if (
      !isJsonObject(domain) ||
      typeof domain.hostname !== 'string' ||
      typeof domain.service !== 'string' ||
      (domain.environment !== undefined &&
        (typeof domain.environment !== 'string' || domain.environment.length === 0))
    ) {
      throw new Error(`${label}[${index}] is invalid.`);
    }
    if (domain.service !== worker) continue;
    const hostname = domain.hostname.toLowerCase();
    const environment = (domain.environment ?? 'production').toLowerCase();
    const key = `${environment}\n${hostname}`;
    if (seen.has(key)) throw new Error(`${label} contains a duplicate hostname and environment.`);
    seen.add(key);
    domains.push({ hostname, environment });
  }
  return domains.sort(stableCompare);
}

interface WorkerSurfaceContract {
  worker: string;
  source: string;
  exposure: 'none' | 'custom-domains';
  environment: 'production';
  workersDev: boolean;
  previewUrls: boolean;
  customDomains: string[];
}

interface R2PolicyContractEntry {
  bucket: string;
  source: string;
}

interface R2ShortDeleteContractEntry {
  bucket: string;
  maxAgeSeconds: number;
}

interface WorkerSecretContractEntry {
  worker: string;
  expectedNames: string[];
}

interface WorkerRoutesContract {
  zoneIdEnv: string;
  readTokenEnv: string;
  expected: Array<{ pattern: string; worker: string }>;
}

interface GithubContract {
  repository: string;
  branch: string;
  requiredEffectiveRuleTypes: string[];
}

interface ManualCheckContract {
  id: string;
  label: string;
  runbook: string;
  reason: string;
}

interface OpsDriftContract {
  schemaVersion: number;
  r2Cors: R2PolicyContractEntry[];
  r2Lifecycle: {
    exactPolicies: R2PolicyContractEntry[];
    forbiddenShortDeletePolicies: R2ShortDeleteContractEntry[];
  };
  workerSecrets: WorkerSecretContractEntry[];
  workerSurfaces: WorkerSurfaceContract[];
  workerRoutes: WorkerRoutesContract;
  github: GithubContract;
  manualChecks: ManualCheckContract[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isR2PolicyContractEntry(value: unknown): value is R2PolicyContractEntry {
  return (
    isJsonObject(value) && typeof value.bucket === 'string' && typeof value.source === 'string'
  );
}

function isR2ShortDeleteContractEntry(value: unknown): value is R2ShortDeleteContractEntry {
  return (
    isJsonObject(value) &&
    typeof value.bucket === 'string' &&
    typeof value.maxAgeSeconds === 'number'
  );
}

function isWorkerSecretContractEntry(value: unknown): value is WorkerSecretContractEntry {
  return (
    isJsonObject(value) && typeof value.worker === 'string' && isStringArray(value.expectedNames)
  );
}

function isWorkerSurfaceContract(value: unknown): value is WorkerSurfaceContract {
  return (
    isJsonObject(value) &&
    typeof value.worker === 'string' &&
    typeof value.source === 'string' &&
    (value.exposure === 'none' || value.exposure === 'custom-domains') &&
    value.environment === 'production' &&
    typeof value.workersDev === 'boolean' &&
    typeof value.previewUrls === 'boolean' &&
    isStringArray(value.customDomains)
  );
}

function isWorkerRoute(value: unknown): value is { pattern: string; worker: string } {
  return (
    isJsonObject(value) && typeof value.pattern === 'string' && typeof value.worker === 'string'
  );
}

function isWorkerRoutesContract(value: unknown): value is WorkerRoutesContract {
  return (
    isJsonObject(value) &&
    typeof value.zoneIdEnv === 'string' &&
    typeof value.readTokenEnv === 'string' &&
    Array.isArray(value.expected) &&
    value.expected.every(isWorkerRoute)
  );
}

function isGithubContract(value: unknown): value is GithubContract {
  return (
    isJsonObject(value) &&
    typeof value.repository === 'string' &&
    typeof value.branch === 'string' &&
    isStringArray(value.requiredEffectiveRuleTypes)
  );
}

function isManualCheckContract(value: unknown): value is ManualCheckContract {
  return (
    isJsonObject(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    typeof value.runbook === 'string' &&
    typeof value.reason === 'string'
  );
}

function isOpsDriftContract(value: unknown): value is OpsDriftContract {
  if (!isJsonObject(value) || value.schemaVersion !== CONTRACT_VERSION) return false;
  const lifecycle = value.r2Lifecycle;
  return (
    Array.isArray(value.r2Cors) &&
    value.r2Cors.every(isR2PolicyContractEntry) &&
    isJsonObject(lifecycle) &&
    Array.isArray(lifecycle.exactPolicies) &&
    lifecycle.exactPolicies.every(isR2PolicyContractEntry) &&
    Array.isArray(lifecycle.forbiddenShortDeletePolicies) &&
    lifecycle.forbiddenShortDeletePolicies.every(isR2ShortDeleteContractEntry) &&
    Array.isArray(value.workerSecrets) &&
    value.workerSecrets.every(isWorkerSecretContractEntry) &&
    Array.isArray(value.workerSurfaces) &&
    value.workerSurfaces.every(isWorkerSurfaceContract) &&
    isWorkerRoutesContract(value.workerRoutes) &&
    isGithubContract(value.github) &&
    Array.isArray(value.manualChecks) &&
    value.manualChecks.every(isManualCheckContract)
  );
}

function workerCustomDomainScopes(workerSurfaces: readonly WorkerSurfaceContract[]): string[] {
  const domains = [...new Set(workerSurfaces.flatMap((entry) => entry.customDomains))].sort();
  return domains.filter(
    (candidate) => !domains.some((other) => candidate !== other && candidate.endsWith(`.${other}`)),
  );
}

function normalizeWorkerDomainInventory(
  value: unknown,
  domainScopes: readonly string[],
  contractedWorkers: readonly string[],
  label = 'Worker custom-domain inventory',
): Array<{ hostname: string; environment: string; worker: string | null }> {
  if (!Array.isArray(value)) throw new Error(`${label} must be a domain array.`);
  const workerSet = new Set(contractedWorkers);
  const domains: Array<{ hostname: string; environment: string; worker: string | null }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const domain = value[index];
    if (!isJsonObject(domain) || typeof domain.hostname !== 'string') {
      throw new Error(`${label}[${index}] is invalid.`);
    }
    const hostname = domain.hostname.toLowerCase();
    if (!domainScopes.some((scope) => hostname === scope || hostname.endsWith(`.${scope}`))) {
      continue;
    }
    if (
      typeof domain.service !== 'string' ||
      (domain.environment !== undefined &&
        (typeof domain.environment !== 'string' || domain.environment.length === 0))
    ) {
      throw new Error(`${label}[${index}] is invalid.`);
    }
    const environment = (domain.environment ?? 'production').toLowerCase();
    const key = `${environment}\n${hostname}`;
    if (seen.has(key)) throw new Error(`${label} contains a duplicate hostname and environment.`);
    seen.add(key);
    domains.push({
      hostname,
      environment,
      worker: workerSet.has(domain.service) ? domain.service : null,
    });
  }
  return domains.sort(stableCompare);
}

export function normalizeWorkerSubdomain(
  value: unknown,
  label = 'Worker subdomain',
): { workersDev: boolean; previewUrls: boolean } {
  if (
    !isJsonObject(value) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.previews_enabled !== 'boolean'
  ) {
    throw new Error(`${label} must contain boolean enabled and previews_enabled values.`);
  }
  return { workersDev: value.enabled, previewUrls: value.previews_enabled };
}

export function normalizeWorkerRoutes(
  value: unknown,
  workers: readonly string[],
  label = 'Worker routes',
): Array<{ pattern: string; worker: string | null }> {
  if (!Array.isArray(value) || !Array.isArray(workers)) {
    throw new Error(`${label} requires route and Worker arrays.`);
  }
  const workerSet = new Set(workers);
  const routes: Array<{ pattern: string; worker: string | null }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const route = value[index];
    if (
      !isJsonObject(route) ||
      typeof route.pattern !== 'string' ||
      (route.script !== undefined && typeof route.script !== 'string')
    ) {
      throw new Error(`${label}[${index}] is invalid.`);
    }
    const key = `${route.script ?? ''}\n${route.pattern}`;
    if (seen.has(key)) throw new Error(`${label} contains a duplicate route.`);
    seen.add(key);
    routes.push({
      pattern: route.pattern,
      worker: typeof route.script === 'string' && workerSet.has(route.script) ? route.script : null,
    });
  }
  return routes.sort(stableCompare);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type OpsDriftFetcher = (url: string, init: RequestInit) => Response | Promise<Response>;

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: string): void {
  try {
    const cancellation = reader.cancel(reason);
    if (cancellation && typeof cancellation.catch === 'function') {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cleanup must not hide or delay the primary timeout/protocol/cap error.
  }
}

function cancelResponseBody(response: Response, reason: string): void {
  try {
    const cancellation = response.body?.cancel(reason);
    if (cancellation && typeof cancellation.catch === 'function') {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cleanup must not hide or delay the primary timeout/protocol/cap error.
  }
}

class SafeOpsDriftError extends Error {}

function safeOpsDriftError(message: string, options?: ErrorOptions): SafeOpsDriftError {
  return new SafeOpsDriftError(message, options);
}

function timeoutError(label: string): SafeOpsDriftError {
  return safeOpsDriftError(`${label} response timed out.`);
}

function absorbLateFetch(fetchPromise: Promise<Response>, label: string): void {
  void fetchPromise.then(
    (response) => {
      cancelResponseBody(response, `${label} response arrived after its deadline.`);
    },
    () => undefined,
  );
}

async function waitForResponse(
  fetchPromise: Promise<Response>,
  signal: AbortSignal,
  label: string,
): Promise<Response> {
  if (signal.aborted) {
    absorbLateFetch(fetchPromise, label);
    throw timeoutError(label);
  }

  let rejectOnAbort = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(timeoutError(label));
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    const response = await Promise.race([fetchPromise, aborted]);
    if (signal.aborted) {
      cancelResponseBody(response, `${label} response arrived after its deadline.`);
      throw timeoutError(label);
    }
    return response;
  } catch (error) {
    if (signal.aborted) {
      absorbLateFetch(fetchPromise, label);
      throw timeoutError(label);
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', rejectOnAbort);
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  label: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw timeoutError(label);
  let rejectOnAbort = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(timeoutError(label));
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', rejectOnAbort);
  }
}

async function readJsonResponse(
  response: Response,
  signal: AbortSignal,
  label: string,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > LIVE_RESPONSE_MAX_BYTES) {
    cancelResponseBody(response, `${label} exceeded the response ceiling.`);
    throw safeOpsDriftError(
      `${label} exceeded the ${LIVE_RESPONSE_MAX_BYTES}-byte response ceiling.`,
    );
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await readChunk(reader, signal, label);
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > LIVE_RESPONSE_MAX_BYTES) {
          cancelReader(reader, `${label} exceeded the response ceiling.`);
          throw safeOpsDriftError(
            `${label} exceeded the ${LIVE_RESPONSE_MAX_BYTES}-byte response ceiling.`,
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      cancelReader(reader, `${label} response read stopped.`);
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A pending read may retain its lock. The bounded-read error is primary.
      }
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed;
  } catch (error) {
    throw safeOpsDriftError(`${label} did not return valid UTF-8 JSON.`, { cause: error });
  }
}

async function fetchJson(
  fetcher: OpsDriftFetcher,
  url: string,
  token: string | undefined,
  label: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  if (!token) throw safeOpsDriftError(`${label} credential is not configured.`);
  const signal = AbortSignal.timeout(LIVE_CHECK_TIMEOUT_MS);
  const fetchPromise = Promise.resolve().then(() =>
    fetcher(url, {
      method: 'GET',
      signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
    }),
  );
  let response;
  try {
    response = await waitForResponse(fetchPromise, signal, label);
  } catch (error) {
    if (error instanceof SafeOpsDriftError) throw error;
    throw safeOpsDriftError(`${label} request failed.`);
  }
  if (!response.ok) {
    cancelResponseBody(response, `${label} returned a non-success status.`);
    throw safeOpsDriftError(`${label} returned HTTP ${response.status}.`);
  }
  try {
    return await readJsonResponse(response, signal, label);
  } catch (error) {
    if (error instanceof SafeOpsDriftError) throw error;
    throw safeOpsDriftError(`${label} response could not be read safely.`);
  }
}

async function fetchCloudflarePages(
  fetcher: OpsDriftFetcher,
  url: string,
  token: string | undefined,
  label: string,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set('page', String(page));
    pageUrl.searchParams.set('per_page', '100');
    const payload = await fetchJson(fetcher, pageUrl.href, token, label);
    if (!isJsonObject(payload) || payload.success !== true || !Array.isArray(payload.result)) {
      throw new Error(`${label} returned an invalid API envelope.`);
    }
    items.push(...payload.result);
    const reportedTotalPages = isJsonObject(payload.result_info)
      ? payload.result_info.total_pages
      : undefined;
    if (reportedTotalPages !== undefined) {
      if (
        typeof reportedTotalPages !== 'number' ||
        !Number.isSafeInteger(reportedTotalPages) ||
        reportedTotalPages < 1 ||
        reportedTotalPages > 100
      ) {
        throw new Error(`${label} returned invalid pagination metadata.`);
      }
      totalPages = reportedTotalPages;
    } else if (payload.result.length === 100) {
      throw new Error(`${label} omitted pagination metadata for a full result page.`);
    }
    page += 1;
  } while (page <= totalPages);
  return items;
}

type OpsDriftCheckStatus = 'pass' | 'drift' | 'error' | 'manual-only';

interface OpsDriftCheck {
  id: string;
  label: string;
  status: OpsDriftCheckStatus;
  detail: string;
}

interface OpsDriftReport {
  schemaVersion: 1;
  generatedAt: string;
  status: 'attention-required' | 'automated-checks-passed';
  checks: OpsDriftCheck[];
}

interface RunOpsDriftAuditOptions {
  root?: string;
  contract?: unknown;
  fetcher?: OpsDriftFetcher;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

function result(
  id: string,
  label: string,
  status: OpsDriftCheckStatus,
  detail: string,
): OpsDriftCheck {
  return { id, label, status, detail };
}

export async function runOpsDriftAudit({
  root = resolve(fileURLToPath(new URL('..', import.meta.url))),
  contract: contractValue = loadOpsDriftContract(root),
  fetcher = globalThis.fetch,
  env = process.env,
  now = new Date(),
}: RunOpsDriftAuditOptions = {}): Promise<OpsDriftReport> {
  assertOpsDriftContract({ root, contract: contractValue });
  if (!isOpsDriftContract(contractValue)) {
    throw new Error('Operations drift contract failed structural validation.');
  }
  const contract = contractValue;
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required.');

  const checks: OpsDriftCheck[] = [];
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  for (const entry of contract.r2Cors) {
    const id = `r2-cors:${entry.bucket}`;
    try {
      if (!accountId) throw new Error('Cloudflare account ID is not configured.');
      const payload = await fetchJson(
        fetcher,
        `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(entry.bucket)}/cors`,
        env.CLOUDFLARE_DRIFT_AUDIT_TOKEN,
        `R2 CORS ${entry.bucket}`,
      );
      if (!isJsonObject(payload) || payload.success !== true || !payload.result) {
        throw new Error(`R2 CORS ${entry.bucket} returned an invalid API envelope.`);
      }
      const expected = normalizeCorsPolicy(
        JSON.parse(readFileSync(resolve(root, entry.source), 'utf8')),
        entry.source,
        { exactKeys: true },
      );
      const actual = normalizeCorsPolicy(payload.result, `live:${entry.bucket}`);
      checks.push(
        sameJson(actual, expected)
          ? result(id, `R2 CORS ${entry.bucket}`, 'pass', `Live policy matches ${entry.source}.`)
          : result(
              id,
              `R2 CORS ${entry.bucket}`,
              'drift',
              `Live policy differs from ${entry.source}.`,
            ),
      );
    } catch (error) {
      checks.push(
        result(
          id,
          `R2 CORS ${entry.bucket}`,
          'error',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  // Cloudflare's lifecycle endpoint uses the standard API envelope
  // `{ success: true, result: { rules: [...] } }`. Keep the envelope check here
  // and the exported result-object normalization separate so release recovery
  // code can compare a captured live policy without performing another fetch.
  for (const entry of contract.r2Lifecycle.exactPolicies) {
    const id = `r2-lifecycle:${entry.bucket}`;
    try {
      if (!accountId) throw new Error('Cloudflare account ID is not configured.');
      const payload = await fetchJson(
        fetcher,
        `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(entry.bucket)}/lifecycle`,
        env.CLOUDFLARE_DRIFT_AUDIT_TOKEN,
        `R2 lifecycle ${entry.bucket}`,
      );
      if (!isJsonObject(payload) || payload.success !== true || !payload.result) {
        throw new Error(`R2 lifecycle ${entry.bucket} returned an invalid API envelope.`);
      }
      const expected = normalizeLifecyclePolicy(
        JSON.parse(readFileSync(resolve(root, entry.source), 'utf8')),
        entry.source,
        { exactKeys: true },
      );
      const actual = normalizeLifecyclePolicy(payload.result, `live:${entry.bucket}`);
      checks.push(
        sameJson(actual, expected)
          ? result(
              id,
              `R2 lifecycle ${entry.bucket}`,
              'pass',
              `Live lifecycle exactly matches ${entry.source}.`,
            )
          : result(
              id,
              `R2 lifecycle ${entry.bucket}`,
              'drift',
              `Live lifecycle differs from ${entry.source}.`,
            ),
      );
    } catch (error) {
      checks.push(
        result(
          id,
          `R2 lifecycle ${entry.bucket}`,
          'error',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  for (const entry of contract.r2Lifecycle.forbiddenShortDeletePolicies) {
    const id = `r2-lifecycle-short-delete:${entry.bucket}`;
    try {
      if (!accountId) throw new Error('Cloudflare account ID is not configured.');
      const payload = await fetchJson(
        fetcher,
        `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(entry.bucket)}/lifecycle`,
        env.CLOUDFLARE_DRIFT_AUDIT_TOKEN,
        `R2 lifecycle ${entry.bucket}`,
      );
      if (!isJsonObject(payload) || payload.success !== true || !payload.result) {
        throw new Error(`R2 lifecycle ${entry.bucket} returned an invalid API envelope.`);
      }
      const actual = normalizeLifecyclePolicy(payload.result, `live:${entry.bucket}`, {
        allowEmptyPrefixOmission: true,
      });
      const unsafe = shortDeleteLifecycleRules(actual, entry.maxAgeSeconds);
      checks.push(
        unsafe.length === 0
          ? result(
              id,
              `R2 short-delete lifecycle ${entry.bucket}`,
              'pass',
              `No enabled delete rule expires objects in ${entry.maxAgeSeconds} seconds or less.`,
            )
          : result(
              id,
              `R2 short-delete lifecycle ${entry.bucket}`,
              'drift',
              `Forbidden short or date-based delete rules: ${unsafe.join(', ')}.`,
            ),
      );
    } catch (error) {
      checks.push(
        result(
          id,
          `R2 short-delete lifecycle ${entry.bucket}`,
          'error',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  // The list endpoint is intentionally name-only for this audit. Cloudflare's
  // response schema may contain secret material fields, so normalization reads
  // only `name` and `type`; report details never serialize a binding object.
  for (const entry of contract.workerSecrets) {
    const id = `worker-secrets:${entry.worker}`;
    try {
      if (!accountId) throw new Error('Cloudflare account ID is not configured.');
      const payload = await fetchJson(
        fetcher,
        `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(entry.worker)}/secrets`,
        env.CLOUDFLARE_DRIFT_AUDIT_TOKEN,
        `Worker secrets ${entry.worker}`,
      );
      if (!isJsonObject(payload) || payload.success !== true || !Array.isArray(payload.result)) {
        throw new Error(`Worker secrets ${entry.worker} returned an invalid API envelope.`);
      }
      const expected = [...entry.expectedNames];
      const actual = normalizeWorkerSecretNames(payload.result, `live:${entry.worker}`);
      const actualSet = new Set(actual);
      const expectedSet = new Set(expected);
      const missing = expected.filter((name) => !actualSet.has(name));
      const unexpected = actual.filter((name) => !expectedSet.has(name));
      checks.push(
        missing.length === 0 && unexpected.length === 0
          ? result(
              id,
              `Worker secrets ${entry.worker}`,
              'pass',
              `Live secret-name inventory exactly matches ${expected.length} expected binding names.`,
            )
          : result(
              id,
              `Worker secrets ${entry.worker}`,
              'drift',
              [
                missing.length > 0 ? `Missing secret names: ${missing.join(', ')}.` : '',
                unexpected.length > 0 ? `Unexpected secret names: ${unexpected.join(', ')}.` : '',
              ]
                .filter(Boolean)
                .join(' '),
            ),
      );
    } catch (error) {
      checks.push(
        result(
          id,
          `Worker secrets ${entry.worker}`,
          'error',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  // Version resources contain secret/plain-text values and provider-managed
  // identifiers. Comparisons use them in memory, but normalization emits only
  // binding names/types and safe target names or a generic mismatch marker.
  // The first deployment returned by Cloudflare is the active deployment; all
  // of its one or two non-zero traffic versions must match the source contract.
  for (const entry of contract.workerSurfaces) {
    const source = readFileSync(resolve(root, entry.source), 'utf8');
    const expectedSurface = workerSurfaceFromToml(source, entry.source);

    const bindingId = `worker-bindings:${entry.worker}`;
    try {
      if (!accountId) throw new Error('Cloudflare account ID is not configured.');
      const deploymentsPayload = await fetchJson(
        fetcher,
        `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(entry.worker)}/deployments`,
        env.CLOUDFLARE_DRIFT_AUDIT_TOKEN,
        `Worker active deployment ${entry.worker}`,
      );
      if (
        !isJsonObject(deploymentsPayload) ||
        deploymentsPayload.success !== true ||
        !isJsonObject(deploymentsPayload.result) ||
        !Array.isArray(deploymentsPayload.result.deployments)
      ) {
        throw new Error(
          `Worker active deployment ${entry.worker} returned an invalid API envelope.`,
        );
      }
      const servingVersions = normalizeActiveDeploymentVersions(
        deploymentsPayload.result.deployments,
        `Worker active deployment ${entry.worker}`,
      );
      const actualVersions = [];
      for (const servingVersion of servingVersions) {
        const versionPayload = await fetchJson(
          fetcher,
          `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(entry.worker)}/versions/${encodeURIComponent(servingVersion.versionId)}`,
          env.CLOUDFLARE_DRIFT_AUDIT_TOKEN,
          `Worker serving version bindings ${entry.worker}`,
        );
        if (
          !isJsonObject(versionPayload) ||
          versionPayload.success !== true ||
          !isJsonObject(versionPayload.result) ||
          !isJsonObject(versionPayload.result.resources) ||
          !Array.isArray(versionPayload.result.resources.bindings)
        ) {
          throw new Error(
            `Worker serving version bindings ${entry.worker} returned an invalid API envelope.`,
          );
        }
        actualVersions.push(
          normalizeWorkerBindings(
            versionPayload.result.resources.bindings,
            source,
            `live:${entry.worker}`,
          ),
        );
      }
      const matches = actualVersions.every((actual) => sameJson(actual, expectedSurface.bindings));
      checks.push(
        matches
          ? result(
              bindingId,
              `Worker bindings ${entry.worker}`,
              'pass',
              `Every actively serving version's non-secret bindings exactly match ${entry.source}.`,
            )
          : result(
              bindingId,
              `Worker bindings ${entry.worker}`,
              'drift',
              `At least one actively serving version's non-secret binding names, types, or source-backed targets differ from ${entry.source}.`,
            ),
      );
    } catch (error) {
      checks.push(
        result(
          bindingId,
          `Worker bindings ${entry.worker}`,
          'error',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    const subdomainId = `worker-subdomain:${entry.worker}`;
    try {
      if (!accountId) throw new Error('Cloudflare account ID is not configured.');
      const payload = await fetchJson(
        fetcher,
        `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(entry.worker)}/subdomain`,
        env.CLOUDFLARE_DRIFT_AUDIT_TOKEN,
        `Worker subdomain ${entry.worker}`,
      );
      if (!isJsonObject(payload) || payload.success !== true || !payload.result) {
        throw new Error(`Worker subdomain ${entry.worker} returned an invalid API envelope.`);
      }
      const actual = normalizeWorkerSubdomain(payload.result, `live:${entry.worker}`);
      const expected = { workersDev: entry.workersDev, previewUrls: entry.previewUrls };
      checks.push(
        sameJson(actual, expected)
          ? result(
              subdomainId,
              `Worker subdomain ${entry.worker}`,
              'pass',
              `workers.dev and Preview URLs match the exact disabled-state contract.`,
            )
          : result(
              subdomainId,
              `Worker subdomain ${entry.worker}`,
              'drift',
              `workers.dev or Preview URL exposure differs from the contract.`,
            ),
      );
    } catch (error) {
      checks.push(
        result(
          subdomainId,
          `Worker subdomain ${entry.worker}`,
          'error',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    const domainsId = `worker-domains:${entry.worker}`;
    try {
      if (!accountId) throw new Error('Cloudflare account ID is not configured.');
      const url = new URL(
        `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/workers/domains`,
      );
      url.searchParams.set('service', entry.worker);
      const payload = await fetchCloudflarePages(
        fetcher,
        url.href,
        env.CLOUDFLARE_DRIFT_AUDIT_TOKEN,
        `Worker custom domains ${entry.worker}`,
      );
      const actual = normalizeWorkerCustomDomains(payload, entry.worker, `live:${entry.worker}`);
      const expected = entry.customDomains.map((hostname) => ({
        hostname,
        environment: entry.environment,
      }));
      checks.push(
        sameJson(actual, expected)
          ? result(
              domainsId,
              `Worker custom domains ${entry.worker}`,
              'pass',
              entry.customDomains.length === 0
                ? 'No public custom domain is attached.'
                : `Exact custom domains are attached: ${entry.customDomains.join(', ')}.`,
            )
          : result(
              domainsId,
              `Worker custom domains ${entry.worker}`,
              'drift',
              `Live custom-domain exposure differs from the exact contract.`,
            ),
      );
    } catch (error) {
      checks.push(
        result(
          domainsId,
          `Worker custom domains ${entry.worker}`,
          'error',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  const domainInventoryId = 'worker-domain-inventory';
  try {
    if (!accountId) throw new Error('Cloudflare account ID is not configured.');
    const payload = await fetchCloudflarePages(
      fetcher,
      `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/workers/domains`,
      env.CLOUDFLARE_DRIFT_AUDIT_TOKEN,
      'Worker account custom-domain inventory',
    );
    const contractedWorkers = contract.workerSurfaces.map((entry) => entry.worker);
    const actual = normalizeWorkerDomainInventory(
      payload,
      workerCustomDomainScopes(contract.workerSurfaces),
      contractedWorkers,
      'live Worker account custom-domain inventory',
    );
    const expected = contract.workerSurfaces
      .flatMap((entry) =>
        entry.customDomains.map((hostname) => ({
          hostname,
          environment: entry.environment,
          worker: entry.worker,
        })),
      )
      .sort(stableCompare);
    checks.push(
      sameJson(actual, expected)
        ? result(
            domainInventoryId,
            'Worker account custom-domain inventory',
            'pass',
            'Every project-domain hostname is attached to the exact contracted Worker and environment.',
          )
        : result(
            domainInventoryId,
            'Worker account custom-domain inventory',
            'drift',
            'Project-domain custom-domain exposure differs from the exact account inventory contract.',
          ),
    );
  } catch (error) {
    checks.push(
      result(
        domainInventoryId,
        'Worker account custom-domain inventory',
        'error',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  const routeWorkers = contract.workerSurfaces.map((entry) => entry.worker);
  const routeZoneId = env[contract.workerRoutes.zoneIdEnv];
  const routeToken = env[contract.workerRoutes.readTokenEnv];
  const routesId = 'worker-routes';
  if (!routeZoneId && !routeToken) {
    checks.push(
      result(
        routesId,
        'Worker zone routes',
        'manual-only',
        `Exact zone-route comparison was not queried because ${contract.workerRoutes.zoneIdEnv} and ${contract.workerRoutes.readTokenEnv} are both unset.`,
      ),
    );
  } else {
    try {
      if (!routeZoneId || !routeToken) {
        throw new Error(
          `Worker route audit requires both ${contract.workerRoutes.zoneIdEnv} and ${contract.workerRoutes.readTokenEnv}.`,
        );
      }
      const payload = await fetchJson(
        fetcher,
        `${CLOUDFLARE_API}/zones/${encodeURIComponent(routeZoneId)}/workers/routes`,
        routeToken,
        'Worker zone routes',
      );
      if (!isJsonObject(payload) || payload.success !== true || !Array.isArray(payload.result)) {
        throw new Error('Worker zone routes returned an invalid API envelope.');
      }
      const actual = normalizeWorkerRoutes(payload.result, routeWorkers, 'live Worker routes');
      checks.push(
        sameJson(actual, contract.workerRoutes.expected)
          ? result(
              routesId,
              'Worker zone routes',
              'pass',
              `Every live zone route exactly matches the ${contract.workerRoutes.expected.length}-route contract.`,
            )
          : result(
              routesId,
              'Worker zone routes',
              'drift',
              'Live zone routes differ from the exact route contract.',
            ),
      );
    } catch (error) {
      checks.push(
        result(
          routesId,
          'Worker zone routes',
          'error',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  const github = contract.github;
  try {
    if (
      env.GITHUB_REPOSITORY &&
      env.GITHUB_REPOSITORY.toLowerCase() !== github.repository.toLowerCase()
    ) {
      throw new Error(
        `Workflow repository ${env.GITHUB_REPOSITORY} does not match ${github.repository}.`,
      );
    }
    const payload = await fetchJson(
      fetcher,
      `${GITHUB_API}/repos/${github.repository}/rules/branches/${encodeURIComponent(github.branch)}?per_page=100`,
      env.GITHUB_DRIFT_AUDIT_TOKEN || env.GITHUB_TOKEN,
      `GitHub rules for ${github.repository}:${github.branch}`,
      { 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'musixquare-ops-drift-audit' },
    );
    if (!Array.isArray(payload))
      throw new Error('GitHub effective branch-rules response is invalid.');
    const actualTypes = new Set(
      payload.map((rule) => (typeof rule?.type === 'string' ? rule.type : null)).filter(Boolean),
    );
    const missing = github.requiredEffectiveRuleTypes.filter((type) => !actualTypes.has(type));
    checks.push(
      missing.length === 0
        ? result(
            `github-rules:${github.branch}`,
            `GitHub ${github.branch} effective rules`,
            'pass',
            `Required effective rules are active: ${github.requiredEffectiveRuleTypes.join(', ')}.`,
          )
        : result(
            `github-rules:${github.branch}`,
            `GitHub ${github.branch} effective rules`,
            'drift',
            `Missing required effective rules: ${missing.join(', ')}.`,
          ),
    );
  } catch (error) {
    checks.push(
      result(
        `github-rules:${github.branch}`,
        `GitHub ${github.branch} effective rules`,
        'error',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  for (const check of contract.manualChecks) {
    checks.push(
      result(check.id, check.label, 'manual-only', `${check.reason} Runbook: ${check.runbook}`),
    );
  }

  const failed = checks.some((check) => check.status === 'drift' || check.status === 'error');
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    status: failed ? 'attention-required' : 'automated-checks-passed',
    checks,
  };
}

export function renderOpsDriftMarkdown(report: OpsDriftReport): string {
  const icons: Record<OpsDriftCheckStatus, string> = {
    pass: 'PASS',
    drift: 'DRIFT',
    error: 'ERROR',
    'manual-only': 'MANUAL',
  };
  const lines = [
    '### MUSIXQUARE operations drift audit',
    '',
    `- Result: **${report.status}**`,
    `- Generated: \`${report.generatedAt}\``,
    '',
    '| Status | Control | Detail |',
    '| --- | --- | --- |',
  ];
  for (const check of report.checks) {
    const clean = (value: unknown): string =>
      String(value).replaceAll('|', '\\|').replaceAll(/\r?\n/gu, ' ');
    lines.push(
      `| ${icons[check.status] || check.status} | ${clean(check.label)} | ${clean(check.detail)} |`,
    );
  }
  lines.push('', '> MANUAL rows were not queried and are not implied to pass.');
  return `${lines.join('\n')}\n`;
}

function writeReport(path: string, report: OpsDriftReport): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (process.argv.includes('--source-only')) {
    const result = assertOpsDriftContract({ root });
    const durableObjects = assertDurableObjectMigrationContract({ root });
    const durableObjectHistory = assertDurableObjectMigrationRepositoryHistory({ root });
    process.stdout.write(
      `${JSON.stringify({ ok: true, ...result, durableObjects, durableObjectHistory })}\n`,
    );
    return;
  }

  const reportPath = process.env.MXQR_OPS_DRIFT_REPORT || DEFAULT_OPS_DRIFT_REPORT_PATH;
  const report = await runOpsDriftAudit({ root });
  writeReport(reportPath, report);
  const markdown = renderOpsDriftMarkdown(report);
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    mkdirSync(dirname(resolve(process.env.GITHUB_STEP_SUMMARY)), { recursive: true });
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, { encoding: 'utf8', flag: 'a' });
  }
  if (report.status !== 'automated-checks-passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

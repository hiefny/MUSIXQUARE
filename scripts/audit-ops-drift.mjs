import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertDurableObjectMigrationContract,
  assertDurableObjectMigrationRepositoryHistory,
} from './check-durable-object-migration-contract.mjs';

export const OPS_DRIFT_CONTRACT_PATH = 'cloudflare/ops-drift.contract.json';
export const DEFAULT_OPS_DRIFT_REPORT_PATH = 'release-artifacts/ops-drift/report.json';

const CONTRACT_VERSION = 2;
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const GITHUB_API = 'https://api.github.com';
const LIVE_CHECK_TIMEOUT_MS = 15_000;
const LIVE_RESPONSE_MAX_BYTES = 512 * 1024;

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRepoPath(value) {
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

function assertRepoFile(root, path, label, suffix = null) {
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

function uniqueStrings(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must be a non-empty array of unique strings.`);
  }
}

export function loadOpsDriftContract(
  root = resolve(fileURLToPath(new URL('..', import.meta.url))),
) {
  return JSON.parse(readFileSync(resolve(root, OPS_DRIFT_CONTRACT_PATH), 'utf8'));
}

export function assertOpsDriftContract({
  root = resolve(fileURLToPath(new URL('..', import.meta.url))),
  contract = loadOpsDriftContract(root),
} = {}) {
  if (
    !hasExactKeys(contract, ['schemaVersion', 'r2Cors', 'r2Lifecycle', 'github', 'manualChecks']) ||
    contract.schemaVersion !== CONTRACT_VERSION
  ) {
    throw new Error(`Operations drift contract must use schemaVersion ${CONTRACT_VERSION}.`);
  }
  if (!Array.isArray(contract.r2Cors) || contract.r2Cors.length === 0) {
    throw new Error('Operations drift contract must declare at least one R2 CORS policy.');
  }
  const buckets = new Set();
  const sources = new Set();
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
    const source = JSON.parse(readFileSync(resolve(root, entry.source), 'utf8'));
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
  const lifecycleBuckets = new Set();
  const lifecycleSources = new Set();
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
      !Number.isSafeInteger(entry.maxAgeSeconds) ||
      entry.maxAgeSeconds < 1 ||
      entry.maxAgeSeconds > 31_536_000
    ) {
      throw new Error(`${entry.bucket}.maxAgeSeconds must be between 1 second and 1 year.`);
    }
    lifecycleBuckets.add(entry.bucket);
  }

  if (!hasExactKeys(contract.github, ['repository', 'branch', 'requiredEffectiveRuleTypes'])) {
    throw new Error(
      'GitHub drift contract must declare repository, branch, and requiredEffectiveRuleTypes.',
    );
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(contract.github.repository)) {
    throw new Error('GitHub repository must use owner/name syntax.');
  }
  if (!/^[A-Za-z0-9._/-]{1,200}$/u.test(contract.github.branch)) {
    throw new Error('GitHub branch is invalid.');
  }
  uniqueStrings(contract.github.requiredEffectiveRuleTypes, 'GitHub requiredEffectiveRuleTypes');

  if (!Array.isArray(contract.manualChecks) || contract.manualChecks.length === 0) {
    throw new Error('Operations drift contract must state its manual-only checks.');
  }
  const manualIds = new Set();
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
    githubRuleCount: contract.github.requiredEffectiveRuleTypes.length,
    manualCheckCount: manualIds.size,
  };
}

function sortedStrings(value, transform = (entry) => entry) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  return value.map(transform).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function normalizeCorsRule(value, label, { exactKeys = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a CORS rule.`);
  }
  if (exactKeys && !hasExactKeys(value, ['id', 'allowed', 'exposeHeaders', 'maxAgeSeconds'])) {
    throw new Error(`${label} must contain exactly id, allowed, exposeHeaders, and maxAgeSeconds.`);
  }
  if (exactKeys && (typeof value.id !== 'string' || value.id.length === 0)) {
    throw new Error(`${label}.id must be a non-empty string.`);
  }
  const allowed = value.allowed;
  if (!allowed || typeof allowed !== 'object' || Array.isArray(allowed)) {
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
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > 86_400) {
    throw new Error(`${label}.maxAgeSeconds is invalid.`);
  }
  return {
    allowed: { origins, methods, headers },
    exposeHeaders,
    maxAgeSeconds,
  };
}

export function normalizeCorsPolicy(value, label = 'CORS policy', options = {}) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.rules)) {
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

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown keys: ${unknown.join(', ')}.`);
}

function normalizeLifecycleCondition(value, label, { allowDate = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a lifecycle condition.`);
  }
  if (value.type === 'Age') {
    if (!hasExactKeys(value, ['type', 'maxAge'])) {
      throw new Error(`${label} Age condition must contain exactly type and maxAge.`);
    }
    if (!Number.isSafeInteger(value.maxAge) || value.maxAge < 0) {
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

function normalizeLifecycleTransition(value, label, options) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (!hasExactKeys(value, ['condition'])) {
    throw new Error(`${label} must contain exactly condition.`);
  }
  return { condition: normalizeLifecycleCondition(value.condition, `${label}.condition`, options) };
}

function normalizeStorageClassTransitions(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value
    .map((transition, index) => {
      if (
        !transition ||
        typeof transition !== 'object' ||
        Array.isArray(transition) ||
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
        storageClass: transition.storageClass,
      };
    })
    .sort((left, right) => stableCompare(left, right));
}

function stableCompare(left, right) {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function normalizeLifecycleRule(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a lifecycle rule.`);
  }
  assertOnlyKeys(value, LIFECYCLE_RULE_KEYS, label);
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    typeof value.enabled !== 'boolean' ||
    !value.conditions ||
    typeof value.conditions !== 'object' ||
    Array.isArray(value.conditions) ||
    !hasExactKeys(value.conditions, ['prefix']) ||
    typeof value.conditions.prefix !== 'string'
  ) {
    throw new Error(`${label} must declare id, enabled, and the exact conditions.prefix.`);
  }
  return {
    id: value.id,
    enabled: value.enabled,
    conditions: { prefix: value.conditions.prefix },
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
export function normalizeLifecyclePolicy(value, label = 'lifecycle policy', options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a lifecycle API result object.`);
  }
  if (options.exactKeys && !hasExactKeys(value, ['rules'])) {
    throw new Error(`${label} must contain exactly rules.`);
  }
  if (!options.exactKeys) assertOnlyKeys(value, new Set(['rules']), label);
  const rules = value.rules === undefined ? [] : value.rules;
  if (!Array.isArray(rules)) throw new Error(`${label}.rules must be an array when present.`);
  return rules
    .map((rule, index) => normalizeLifecycleRule(rule, `${label}.rules[${index}]`))
    .sort(stableCompare);
}

export function shortDeleteLifecycleRules(policy, maxAgeSeconds) {
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cancelReader(reader, reason) {
  try {
    const cancellation = reader.cancel(reason);
    if (cancellation && typeof cancellation.catch === 'function') {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cleanup must not hide or delay the primary timeout/protocol/cap error.
  }
}

function cancelResponseBody(response, reason) {
  try {
    const cancellation = response.body?.cancel(reason);
    if (cancellation && typeof cancellation.catch === 'function') {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cleanup must not hide or delay the primary timeout/protocol/cap error.
  }
}

function timeoutError(label) {
  return new Error(`${label} response timed out.`);
}

function absorbLateFetch(fetchPromise, label) {
  void fetchPromise.then(
    (response) => {
      cancelResponseBody(response, `${label} response arrived after its deadline.`);
    },
    () => undefined,
  );
}

async function waitForResponse(fetchPromise, signal, label) {
  if (signal.aborted) {
    absorbLateFetch(fetchPromise, label);
    throw timeoutError(label);
  }

  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
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

async function readChunk(reader, signal, label) {
  if (signal.aborted) throw timeoutError(label);
  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => reject(timeoutError(label));
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', rejectOnAbort);
  }
}

async function readJsonResponse(response, signal, label) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > LIVE_RESPONSE_MAX_BYTES) {
    cancelResponseBody(response, `${label} exceeded the response ceiling.`);
    throw new Error(`${label} exceeded the ${LIVE_RESPONSE_MAX_BYTES}-byte response ceiling.`);
  }

  const chunks = [];
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
          throw new Error(
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} did not return valid UTF-8 JSON.`, { cause: error });
  }
}

async function fetchJson(fetcher, url, token, label, extraHeaders = {}) {
  if (!token) throw new Error(`${label} credential is not configured.`);
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
  const response = await waitForResponse(fetchPromise, signal, label);
  if (!response.ok) {
    cancelResponseBody(response, `${label} returned a non-success status.`);
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  return readJsonResponse(response, signal, label);
}

function result(id, label, status, detail) {
  return { id, label, status, detail };
}

export async function runOpsDriftAudit({
  root = resolve(fileURLToPath(new URL('..', import.meta.url))),
  contract = loadOpsDriftContract(root),
  fetcher = globalThis.fetch,
  env = process.env,
  now = new Date(),
} = {}) {
  assertOpsDriftContract({ root, contract });
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required.');

  const checks = [];
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
      if (payload?.success !== true || !payload.result) {
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
      if (payload?.success !== true || !payload.result) {
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
      if (payload?.success !== true || !payload.result) {
        throw new Error(`R2 lifecycle ${entry.bucket} returned an invalid API envelope.`);
      }
      const actual = normalizeLifecyclePolicy(payload.result, `live:${entry.bucket}`);
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

export function renderOpsDriftMarkdown(report) {
  const icons = { pass: 'PASS', drift: 'DRIFT', error: 'ERROR', 'manual-only': 'MANUAL' };
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
    const clean = (value) => String(value).replaceAll('|', '\\|').replaceAll(/\r?\n/gu, ' ');
    lines.push(
      `| ${icons[check.status] || check.status} | ${clean(check.label)} | ${clean(check.detail)} |`,
    );
  }
  lines.push('', '> MANUAL rows were not queried and are not implied to pass.');
  return `${lines.join('\n')}\n`;
}

function writeReport(path, report) {
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

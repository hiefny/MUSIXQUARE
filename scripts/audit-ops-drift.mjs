import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const OPS_DRIFT_CONTRACT_PATH = 'cloudflare/ops-drift.contract.json';
export const DEFAULT_OPS_DRIFT_REPORT_PATH = 'release-artifacts/ops-drift/report.json';

const CONTRACT_VERSION = 1;
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const GITHUB_API = 'https://api.github.com';
const LIVE_CHECK_TIMEOUT_MS = 15_000;

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
    !hasExactKeys(contract, ['schemaVersion', 'r2Cors', 'github', 'manualChecks']) ||
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
    r2PolicyCount: buckets.size,
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function fetchJson(fetcher, url, token, label, extraHeaders = {}) {
  if (!token) throw new Error(`${label} credential is not configured.`);
  const response = await fetcher(url, {
    method: 'GET',
    signal: AbortSignal.timeout(LIVE_CHECK_TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
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
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
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

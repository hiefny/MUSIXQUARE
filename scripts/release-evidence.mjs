import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/u;
const CANONICAL_UTC_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u;
const DEVICE_EVIDENCE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const DEVICE_EVIDENCE_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const DEVICE_MATRIX_KEYS = Object.freeze([
  'standardRoom',
  'proRoom',
  'localAndRemoteMedia',
  'youtubePlayback',
  'systemAudio',
  'backgroundResume',
  'adaptivePowPerformance',
]);

function requiredText(value, label, minLength = 1, maxLength = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new Error(`${label} must contain ${minLength}-${maxLength} characters.`);
  }
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = String(value ?? '').trim();
  if (!POSITIVE_INTEGER_RE.test(normalized)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the safe integer range.`);
  return parsed;
}

function exactHttpsUrl(value, label) {
  const normalized = requiredText(value, label, 1, 2_048);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be an absolute HTTPS URL without credentials or a fragment.`);
  }
  return parsed.href;
}

function exactBoolean(value, label) {
  if (value === true || value === 'true') return true;
  throw new Error(`${label} must be explicitly attested as true.`);
}

function parseTestedAt(value, nowMs) {
  const normalized = requiredText(value, 'testedAt', 20, 40);
  const match = CANONICAL_UTC_TIMESTAMP_RE.exec(normalized);
  if (!match) {
    throw new Error('testedAt must be a canonical UTC ISO-8601 timestamp ending in Z.');
  }
  const testedAtMs = Date.parse(normalized);
  const canonicalInput = `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`;
  if (!Number.isFinite(testedAtMs) || new Date(testedAtMs).toISOString() !== canonicalInput) {
    throw new Error('testedAt must be a valid canonical UTC ISO-8601 timestamp.');
  }
  if (testedAtMs > nowMs + DEVICE_EVIDENCE_FUTURE_SKEW_MS) {
    throw new Error('testedAt is too far in the future.');
  }
  if (testedAtMs < nowMs - DEVICE_EVIDENCE_MAX_AGE_MS) {
    throw new Error('Real-device evidence is older than 14 days.');
  }
  return new Date(testedAtMs).toISOString();
}

export function createRealDeviceEvidence(input, nowMs = Date.now()) {
  const releaseSha = requiredText(input?.releaseSha, 'releaseSha', 40, 40).toLowerCase();
  if (!SHA_RE.test(releaseSha)) throw new Error('releaseSha must be a lowercase 40-character SHA.');
  const repository = requiredText(input?.repository, 'repository', 3, 200);
  if (!REPOSITORY_RE.test(repository)) throw new Error('repository must use the owner/name form.');

  const matrix = Object.fromEntries(
    DEVICE_MATRIX_KEYS.map((key) => [key, exactBoolean(input?.matrix?.[key], `matrix.${key}`)]),
  );

  return {
    schemaVersion: 2,
    releaseSha,
    repository,
    testedAt: parseTestedAt(input?.testedAt, nowMs),
    environmentUrl: exactHttpsUrl(input?.environmentUrl, 'environmentUrl'),
    evidenceUrl: exactHttpsUrl(input?.evidenceUrl, 'evidenceUrl'),
    tester: requiredText(input?.tester, 'tester', 2, 120),
    workflowActor: requiredText(input?.workflowActor, 'workflowActor', 1, 120),
    deviceMatrix: requiredText(input?.deviceMatrix, 'deviceMatrix', 20, 800),
    matrix,
    source: {
      workflow: 'real-device-qa.yml',
      runId: positiveInteger(input?.source?.runId, 'source.runId'),
      runAttempt: positiveInteger(input?.source?.runAttempt, 'source.runAttempt'),
    },
  };
}

export function verifyRealDeviceEvidence(evidence, expected, nowMs = Date.now()) {
  const canonical = createRealDeviceEvidence(evidence, nowMs);
  if (JSON.stringify(canonical) !== JSON.stringify(evidence)) {
    throw new Error('Real-device evidence must use the canonical schema without extra fields.');
  }
  if (canonical.releaseSha !== expected.releaseSha) {
    throw new Error('Real-device evidence does not match the release SHA.');
  }
  if (canonical.repository !== expected.repository) {
    throw new Error('Real-device evidence does not match the repository.');
  }
  if (canonical.source.runId !== positiveInteger(expected.runId, 'expected runId')) {
    throw new Error('Real-device evidence does not match the selected workflow run.');
  }
  if (canonical.source.runAttempt !== positiveInteger(expected.runAttempt, 'expected runAttempt')) {
    throw new Error('Real-device evidence does not match the selected workflow attempt.');
  }
  return canonical;
}

function canonicalWorkflowRuns(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.workflow_runs)) {
    throw new Error('GitHub returned an invalid workflow-runs response.');
  }
  return value.workflow_runs;
}

function successfulRunsNewestFirst(payload, expected, excludedRunIds = new Set()) {
  const matches = canonicalWorkflowRuns(payload).filter(
    (run) =>
      run &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.head_sha === expected.sha &&
      run.event === expected.event &&
      run.head_branch === 'main' &&
      Number.isSafeInteger(run.id) &&
      Number.isSafeInteger(run.run_attempt) &&
      !excludedRunIds.has(run.id),
  );
  matches.sort((left, right) => {
    const leftUpdatedAt = Date.parse(
      left.updated_at || left.run_started_at || left.created_at || '',
    );
    const rightUpdatedAt = Date.parse(
      right.updated_at || right.run_started_at || right.created_at || '',
    );
    const leftRecency = Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : 0;
    const rightRecency = Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : 0;
    return rightRecency - leftRecency || right.id - left.id || right.run_attempt - left.run_attempt;
  });
  return matches;
}

export function selectLatestSuccessfulRun(payload, expected, excludedRunIds = new Set()) {
  return successfulRunsNewestFirst(payload, expected, excludedRunIds)[0] ?? null;
}

export function selectExactArtifact(payload, expected) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.artifacts)) {
    throw new Error('GitHub returned an invalid artifacts response.');
  }
  const prefix = `${expected.prefix}${expected.sha}-${expected.runId}-`;
  const matches = payload.artifacts.filter(
    (artifact) =>
      artifact &&
      artifact.expired === false &&
      typeof artifact.name === 'string' &&
      artifact.name.startsWith(prefix) &&
      artifact.name === `${prefix}${expected.runAttempt}`,
  );
  matches.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  return matches.at(-1) ?? null;
}

async function githubApi(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'MUSIXQUARE-release-evidence',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path} failed with HTTP ${response.status}.`);
  return response.json();
}

function workflowRunsPath(repository, workflow, sha, event) {
  const query = new URLSearchParams({
    branch: 'main',
    event,
    head_sha: sha,
    per_page: '20',
  });
  return `/repos/${repository}/actions/workflows/${workflow}/runs?${query}`;
}

function hasActiveExactRun(payload, sha, event) {
  return canonicalWorkflowRuns(payload).some(
    (run) =>
      run?.head_sha === sha &&
      run?.event === event &&
      run?.head_branch === 'main' &&
      ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status),
  );
}

function latestCompletedUrl(payload, sha, event) {
  return (
    canonicalWorkflowRuns(payload)
      .filter(
        (run) =>
          run?.head_sha === sha &&
          run?.event === event &&
          run?.head_branch === 'main' &&
          run?.status === 'completed',
      )
      .sort((left, right) => {
        const leftUpdatedAt = Date.parse(
          left?.updated_at || left?.run_started_at || left?.created_at || '',
        );
        const rightUpdatedAt = Date.parse(
          right?.updated_at || right?.run_started_at || right?.created_at || '',
        );
        const leftRecency = Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : 0;
        const rightRecency = Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : 0;
        return (
          rightRecency - leftRecency ||
          (right?.id ?? 0) - (left?.id ?? 0) ||
          (right?.run_attempt ?? 0) - (left?.run_attempt ?? 0)
        );
      })[0]?.html_url ?? ''
  );
}

function appendGithubOutputs(path, outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => {
    const normalized = String(value);
    if (!/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
      throw new Error(`Refusing unsafe GitHub output ${key}.`);
    }
    return `${key}=${normalized}`;
  });
  writeFileSync(path, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'a' });
}

async function waitForArtifact({ workflow, event, prefix, outputPrefix, timeoutMs }) {
  const repository = requiredText(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY', 3, 200);
  const sha = requiredText(process.env.GITHUB_SHA, 'GITHUB_SHA', 40, 40).toLowerCase();
  const token = requiredText(process.env.GH_TOKEN, 'GH_TOKEN', 10, 2_048);
  const output = requiredText(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT', 1, 2_048);
  if (!REPOSITORY_RE.test(repository) || !SHA_RE.test(sha)) {
    throw new Error('GITHUB_REPOSITORY or GITHUB_SHA is malformed.');
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await githubApi(workflowRunsPath(repository, workflow, sha, event), token);
    const skippedRunIds = new Set();
    let run = selectLatestSuccessfulRun(runs, { sha, event }, skippedRunIds);
    while (run) {
      const artifacts = await githubApi(
        `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
        token,
      );
      const artifact = selectExactArtifact(artifacts, {
        prefix,
        sha,
        runId: run.id,
        runAttempt: run.run_attempt,
      });
      if (artifact) {
        appendGithubOutputs(output, {
          [`${outputPrefix}run_id`]: run.id,
          [`${outputPrefix}run_attempt`]: run.run_attempt,
          [`${outputPrefix}artifact_name`]: artifact.name,
          ...(outputPrefix === '' ? { validation_profile: 'main-ci' } : {}),
        });
        return;
      }
      skippedRunIds.add(run.id);
      run = selectLatestSuccessfulRun(runs, { sha, event }, skippedRunIds);
    }

    const completedUrl = latestCompletedUrl(runs, sha, event);
    if (!hasActiveExactRun(runs, sha, event) && completedUrl) {
      if (skippedRunIds.size > 0) {
        throw new Error(
          `No successful ${workflow} run for the exact main commit has an unexpired exact-attempt artifact: ${completedUrl}`,
        );
      }
      throw new Error(`The exact main commit did not pass ${workflow}: ${completedUrl}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
  throw new Error(`Timed out waiting for ${workflow} on exact commit ${sha}.`);
}

function evidenceInputFromEnvironment() {
  return {
    releaseSha: process.env.MXQR_QA_RELEASE_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    testedAt: process.env.MXQR_QA_TESTED_AT,
    environmentUrl: process.env.MXQR_QA_ENVIRONMENT_URL,
    evidenceUrl: process.env.MXQR_QA_EVIDENCE_URL,
    tester: process.env.MXQR_QA_TESTER,
    workflowActor: process.env.GITHUB_ACTOR,
    deviceMatrix: process.env.MXQR_QA_DEVICE_MATRIX,
    matrix: Object.fromEntries(
      DEVICE_MATRIX_KEYS.map((key) => [key, process.env[`MXQR_QA_${key.toUpperCase()}`]]),
    ),
    source: {
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    },
  };
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read real-device evidence: ${error.message}`);
  }
}

async function main() {
  const [command, path] = process.argv.slice(2);
  if (command === 'wait-candidate') {
    await waitForArtifact({
      workflow: 'ci.yml',
      event: 'push',
      prefix: 'production-candidate-',
      outputPrefix: '',
      timeoutMs: 12 * 60 * 1_000,
    });
    return;
  }
  if (command === 'create-device' && path) {
    const evidence = createRealDeviceEvidence(evidenceInputFromEnvironment());
    writeFileSync(resolve(path), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    return;
  }
  if (command === 'verify-device' && path) {
    verifyRealDeviceEvidence(readJsonFile(path), {
      releaseSha: process.env.GITHUB_SHA,
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.MXQR_QA_RUN_ID,
      runAttempt: process.env.MXQR_QA_RUN_ATTEMPT,
    });
    return;
  }
  throw new Error(
    'Usage: release-evidence.mjs <wait-candidate|create-device FILE|verify-device FILE>',
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[release-evidence] ${error.message}`);
    process.exitCode = 1;
  });
}

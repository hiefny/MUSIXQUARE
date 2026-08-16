import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/u;
const CANONICAL_UTC_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u;
const DEVICE_EVIDENCE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const DEVICE_EVIDENCE_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const DEVICE_MATRIX_KEYS = [
  'standardRoom',
  'proRoom',
  'localAndRemoteMedia',
  'youtubePlayback',
  'systemAudio',
  'backgroundResume',
  'adaptivePowPerformance',
] as const;

interface RealDeviceMatrixInput {
  standardRoom: true | 'true';
  proRoom: true | 'true';
  localAndRemoteMedia: true | 'true';
  youtubePlayback: true | 'true';
  systemAudio: true | 'true';
  backgroundResume: true | 'true';
  adaptivePowPerformance: true | 'true';
}

interface RealDeviceMatrix {
  standardRoom: true;
  proRoom: true;
  localAndRemoteMedia: true;
  youtubePlayback: true;
  systemAudio: true;
  backgroundResume: true;
  adaptivePowPerformance: true;
}

export interface RealDeviceEvidenceInput {
  releaseSha: string;
  repository: string;
  testedAt: string;
  environmentUrl: string;
  evidenceUrl: string;
  tester: string;
  workflowActor: string;
  deviceMatrix: string;
  matrix: RealDeviceMatrixInput;
  source: { runId: number | string; runAttempt: number | string };
}

export interface RealDeviceEvidence {
  schemaVersion: 2;
  releaseSha: string;
  repository: string;
  testedAt: string;
  environmentUrl: string;
  evidenceUrl: string;
  tester: string;
  workflowActor: string;
  deviceMatrix: string;
  matrix: RealDeviceMatrix;
  source: { workflow: 'real-device-qa.yml'; runId: number; runAttempt: number };
}

interface EvidenceExpectation {
  releaseSha: string;
  repository: string;
  runId: number | string;
  runAttempt: number | string;
}

interface RunSelection {
  sha: string;
  event: string;
}

interface WorkflowRun extends Record<string, unknown> {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string;
  head_sha: string;
  event: string;
  head_branch: string;
}

interface ArtifactSelection {
  prefix: string;
  sha: string;
  runId: number;
  runAttempt: number;
}

interface WorkflowArtifact extends Record<string, unknown> {
  name: string;
  expired: false;
}

interface WaitForArtifactOptions {
  workflow: string;
  event: string;
  prefix: string;
  outputPrefix: string;
  timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function dateValue(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function requiredText(value: unknown, label: string, minLength = 1, maxLength = 512): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new Error(`${label} must contain ${minLength}-${maxLength} characters.`);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = String(value ?? '').trim();
  if (!POSITIVE_INTEGER_RE.test(normalized)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the safe integer range.`);
  return parsed;
}

function exactHttpsUrl(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 1, 2_048);
  let parsed: URL;
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

function exactBoolean(value: unknown, label: string): true {
  if (value === true || value === 'true') return true;
  throw new Error(`${label} must be explicitly attested as true.`);
}

function parseTestedAt(value: unknown, nowMs: number): string {
  const normalized = requiredText(value, 'testedAt', 20, 40);
  const match = CANONICAL_UTC_TIMESTAMP_RE.exec(normalized);
  if (!match) {
    throw new Error('testedAt must be a canonical UTC ISO-8601 timestamp ending in Z.');
  }
  const testedAtMs = Date.parse(normalized);
  const timestamp = match[1];
  if (timestamp === undefined) {
    throw new Error('testedAt must be a canonical UTC ISO-8601 timestamp ending in Z.');
  }
  const canonicalInput = `${timestamp}.${(match[2] || '').padEnd(3, '0')}Z`;
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

function canonicalDeviceMatrix(value: unknown): RealDeviceMatrix {
  const matrix = isRecord(value) ? value : {};
  return {
    standardRoom: exactBoolean(matrix.standardRoom, 'matrix.standardRoom'),
    proRoom: exactBoolean(matrix.proRoom, 'matrix.proRoom'),
    localAndRemoteMedia: exactBoolean(matrix.localAndRemoteMedia, 'matrix.localAndRemoteMedia'),
    youtubePlayback: exactBoolean(matrix.youtubePlayback, 'matrix.youtubePlayback'),
    systemAudio: exactBoolean(matrix.systemAudio, 'matrix.systemAudio'),
    backgroundResume: exactBoolean(matrix.backgroundResume, 'matrix.backgroundResume'),
    adaptivePowPerformance: exactBoolean(
      matrix.adaptivePowPerformance,
      'matrix.adaptivePowPerformance',
    ),
  };
}

function canonicalRealDeviceEvidence(input: unknown, nowMs: number): RealDeviceEvidence {
  const value = isRecord(input) ? input : {};
  const source = isRecord(value.source) ? value.source : {};
  const releaseSha = requiredText(value.releaseSha, 'releaseSha', 40, 40).toLowerCase();
  if (!SHA_RE.test(releaseSha)) throw new Error('releaseSha must be a lowercase 40-character SHA.');
  const repository = requiredText(value.repository, 'repository', 3, 200);
  if (!REPOSITORY_RE.test(repository)) throw new Error('repository must use the owner/name form.');

  return {
    schemaVersion: 2,
    releaseSha,
    repository,
    testedAt: parseTestedAt(value.testedAt, nowMs),
    environmentUrl: exactHttpsUrl(value.environmentUrl, 'environmentUrl'),
    evidenceUrl: exactHttpsUrl(value.evidenceUrl, 'evidenceUrl'),
    tester: requiredText(value.tester, 'tester', 2, 120),
    workflowActor: requiredText(value.workflowActor, 'workflowActor', 1, 120),
    deviceMatrix: requiredText(value.deviceMatrix, 'deviceMatrix', 20, 800),
    matrix: canonicalDeviceMatrix(value.matrix),
    source: {
      workflow: 'real-device-qa.yml',
      runId: positiveInteger(source.runId, 'source.runId'),
      runAttempt: positiveInteger(source.runAttempt, 'source.runAttempt'),
    },
  };
}

export function createRealDeviceEvidence(
  input: RealDeviceEvidenceInput,
  nowMs = Date.now(),
): RealDeviceEvidence {
  return canonicalRealDeviceEvidence(input, nowMs);
}

export function verifyRealDeviceEvidence(
  evidence: unknown,
  expected: EvidenceExpectation,
  nowMs = Date.now(),
): RealDeviceEvidence {
  const canonical = canonicalRealDeviceEvidence(evidence, nowMs);
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

function canonicalWorkflowRuns(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.workflow_runs)) {
    throw new Error('GitHub returned an invalid workflow-runs response.');
  }
  return value.workflow_runs.filter(isRecord);
}

function successfulRunsNewestFirst(
  payload: unknown,
  expected: RunSelection,
  excludedRunIds: ReadonlySet<number> = new Set(),
): WorkflowRun[] {
  const matches = canonicalWorkflowRuns(payload).filter(
    (run): run is WorkflowRun =>
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.head_sha === expected.sha &&
      run.event === expected.event &&
      run.head_branch === 'main' &&
      isSafeInteger(run.id) &&
      isSafeInteger(run.run_attempt) &&
      !excludedRunIds.has(run.id),
  );
  matches.sort((left, right) => {
    const leftUpdatedAt = dateValue(left.updated_at || left.run_started_at || left.created_at);
    const rightUpdatedAt = dateValue(right.updated_at || right.run_started_at || right.created_at);
    const leftRecency = Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : 0;
    const rightRecency = Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : 0;
    return rightRecency - leftRecency || right.id - left.id || right.run_attempt - left.run_attempt;
  });
  return matches;
}

export function selectLatestSuccessfulRun(
  payload: unknown,
  expected: RunSelection,
  excludedRunIds: ReadonlySet<number> = new Set(),
): WorkflowRun | null {
  return successfulRunsNewestFirst(payload, expected, excludedRunIds)[0] ?? null;
}

export function selectExactArtifact(
  payload: unknown,
  expected: ArtifactSelection,
): WorkflowArtifact | null {
  if (!isRecord(payload) || !Array.isArray(payload.artifacts)) {
    throw new Error('GitHub returned an invalid artifacts response.');
  }
  const prefix = `${expected.prefix}${expected.sha}-${expected.runId}-`;
  const matches = payload.artifacts.filter(
    (artifact): artifact is WorkflowArtifact =>
      isRecord(artifact) &&
      artifact.expired === false &&
      typeof artifact.name === 'string' &&
      artifact.name.startsWith(prefix) &&
      artifact.name === `${prefix}${expected.runAttempt}`,
  );
  matches.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  return matches.at(-1) ?? null;
}

async function githubApi(path: string, token: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'MUSIXQUARE-release-evidence',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}.`);
  const payload: unknown = await response.json();
  return payload;
}

function workflowRunsPath(
  repository: string,
  workflow: string,
  sha: string,
  event: string,
): string {
  const query = new URLSearchParams({
    branch: 'main',
    event,
    head_sha: sha,
    per_page: '20',
  });
  return `/repos/${repository}/actions/workflows/${workflow}/runs?${query}`;
}

function hasActiveExactRun(payload: unknown, sha: string, event: string): boolean {
  return canonicalWorkflowRuns(payload).some(
    (run) =>
      run.head_sha === sha &&
      run.event === event &&
      run.head_branch === 'main' &&
      typeof run.status === 'string' &&
      ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status),
  );
}

function latestCompletedUrl(payload: unknown, sha: string, event: string): string {
  const htmlUrl = canonicalWorkflowRuns(payload)
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.event === event &&
        run.head_branch === 'main' &&
        run.status === 'completed',
    )
    .sort((left, right) => {
      const leftUpdatedAt = dateValue(left.updated_at || left.run_started_at || left.created_at);
      const rightUpdatedAt = dateValue(
        right.updated_at || right.run_started_at || right.created_at,
      );
      const leftRecency = Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : 0;
      const rightRecency = Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : 0;
      return (
        rightRecency - leftRecency ||
        (isSafeInteger(right.id) ? right.id : 0) - (isSafeInteger(left.id) ? left.id : 0) ||
        (isSafeInteger(right.run_attempt) ? right.run_attempt : 0) -
          (isSafeInteger(left.run_attempt) ? left.run_attempt : 0)
      );
    })[0]?.html_url;
  return typeof htmlUrl === 'string' ? htmlUrl : '';
}

function appendGithubOutputs(
  path: string,
  outputs: Readonly<Record<string, string | number>>,
): void {
  const lines = Object.entries(outputs).map(([key, value]) => {
    const normalized = String(value);
    if (!/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
      throw new Error(`Refusing unsafe GitHub output ${key}.`);
    }
    return `${key}=${normalized}`;
  });
  writeFileSync(path, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'a' });
}

async function waitForArtifact({
  workflow,
  event,
  prefix,
  outputPrefix,
  timeoutMs,
}: WaitForArtifactOptions): Promise<void> {
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
    const skippedRunIds = new Set<number>();
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

    const hasCompletedRun = latestCompletedUrl(runs, sha, event).length > 0;
    if (!hasActiveExactRun(runs, sha, event) && hasCompletedRun) {
      if (skippedRunIds.size > 0) {
        throw new Error(
          `No successful ${workflow} run for the exact main commit has an unexpired exact-attempt artifact.`,
        );
      }
      throw new Error(`The exact main commit did not pass ${workflow}.`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
  throw new Error(`Timed out waiting for ${workflow} on exact commit ${sha}.`);
}

function evidenceInputFromEnvironment(): RealDeviceEvidenceInput {
  const matrix = Object.fromEntries(
    DEVICE_MATRIX_KEYS.map((key) => [key, process.env[`MXQR_QA_${key.toUpperCase()}`]]),
  );
  return {
    releaseSha: requiredText(process.env.MXQR_QA_RELEASE_SHA, 'MXQR_QA_RELEASE_SHA', 40, 40),
    repository: requiredText(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY', 3, 200),
    testedAt: requiredText(process.env.MXQR_QA_TESTED_AT, 'MXQR_QA_TESTED_AT', 20, 40),
    environmentUrl: requiredText(
      process.env.MXQR_QA_ENVIRONMENT_URL,
      'MXQR_QA_ENVIRONMENT_URL',
      1,
      2_048,
    ),
    evidenceUrl: requiredText(process.env.MXQR_QA_EVIDENCE_URL, 'MXQR_QA_EVIDENCE_URL', 1, 2_048),
    tester: requiredText(process.env.MXQR_QA_TESTER, 'MXQR_QA_TESTER', 2, 120),
    workflowActor: requiredText(process.env.GITHUB_ACTOR, 'GITHUB_ACTOR', 1, 120),
    deviceMatrix: requiredText(process.env.MXQR_QA_DEVICE_MATRIX, 'MXQR_QA_DEVICE_MATRIX', 20, 800),
    matrix: canonicalDeviceMatrix(matrix),
    source: {
      runId: requiredText(process.env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
      runAttempt: requiredText(process.env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
    },
  };
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch {
    throw new Error('Unable to read real-device evidence.');
  }
}

async function main(): Promise<void> {
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
      releaseSha: requiredText(process.env.GITHUB_SHA, 'GITHUB_SHA', 40, 40),
      repository: requiredText(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY', 3, 200),
      runId: requiredText(process.env.MXQR_QA_RUN_ID, 'MXQR_QA_RUN_ID'),
      runAttempt: requiredText(process.env.MXQR_QA_RUN_ATTEMPT, 'MXQR_QA_RUN_ATTEMPT'),
    });
    return;
  }
  throw new Error(
    'Usage: release-evidence.mts <wait-candidate|create-device FILE|verify-device FILE>',
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(`[release-evidence] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

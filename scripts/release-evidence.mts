import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ARTIFACTS_PER_PAGE = 100;

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

interface SelectedWorkflowArtifact extends WorkflowArtifact {
  runAttempt: number;
}

interface ArtifactPage {
  totalCount: number;
  artifacts: unknown[];
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

function canonicalWorkflowRuns(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.workflow_runs)) {
    throw new Error('GitHub returned an invalid workflow-runs response.');
  }
  return value.workflow_runs.filter(isRecord);
}

function canonicalArtifactPage(value: unknown): ArtifactPage {
  if (
    !isRecord(value) ||
    !isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > ARTIFACTS_PER_PAGE ||
    value.artifacts.length > value.total_count
  ) {
    throw new Error('GitHub returned an invalid artifacts response.');
  }
  return { totalCount: value.total_count, artifacts: value.artifacts };
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

export function selectLatestArtifactAttempt(
  payload: unknown,
  expected: ArtifactSelection,
): SelectedWorkflowArtifact | null {
  if (!isRecord(payload) || !Array.isArray(payload.artifacts)) {
    throw new Error('GitHub returned an invalid artifacts response.');
  }
  const prefix = `${expected.prefix}${expected.sha}-${expected.runId}-`;
  const matches = payload.artifacts.flatMap((artifact): SelectedWorkflowArtifact[] => {
    if (
      !isRecord(artifact) ||
      artifact.expired !== false ||
      typeof artifact.name !== 'string' ||
      !artifact.name.startsWith(prefix)
    ) {
      return [];
    }
    const suffix = artifact.name.slice(prefix.length);
    if (!/^[1-9][0-9]*$/u.test(suffix)) return [];
    const runAttempt = Number(suffix);
    if (!Number.isSafeInteger(runAttempt) || runAttempt > expected.runAttempt) return [];
    return [{ ...artifact, name: artifact.name, expired: false, runAttempt }];
  });
  matches.sort((left, right) => {
    const leftCreatedAt = dateValue(left.created_at);
    const rightCreatedAt = dateValue(right.created_at);
    return (
      left.runAttempt - right.runAttempt ||
      (Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0) -
        (Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0)
    );
  });
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

function runArtifactsPath(repository: string, runId: number, page: number): string {
  const query = new URLSearchParams({
    per_page: String(ARTIFACTS_PER_PAGE),
    direction: 'asc',
    page: String(page),
  });
  return `/repos/${repository}/actions/runs/${runId}/artifacts?${query}`;
}

async function allRunArtifacts(
  repository: string,
  runId: number,
  token: string,
): Promise<{ artifacts: unknown[] }> {
  const firstPage = canonicalArtifactPage(
    await githubApi(runArtifactsPath(repository, runId, 1), token),
  );
  const artifacts = [...firstPage.artifacts];
  const pageCount = Math.max(1, Math.ceil(firstPage.totalCount / ARTIFACTS_PER_PAGE));
  for (let page = 2; page <= pageCount; page += 1) {
    const nextPage = canonicalArtifactPage(
      await githubApi(runArtifactsPath(repository, runId, page), token),
    );
    if (nextPage.totalCount !== firstPage.totalCount) {
      throw new Error('GitHub artifact pagination changed during release evidence collection.');
    }
    artifacts.push(...nextPage.artifacts);
  }
  if (artifacts.length !== firstPage.totalCount) {
    throw new Error('GitHub returned an incomplete artifacts response.');
  }
  return { artifacts };
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

export async function waitForArtifact({
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
      const artifacts = await allRunArtifacts(repository, run.id, token);
      const artifact = selectLatestArtifactAttempt(artifacts, {
        prefix,
        sha,
        runId: run.id,
        runAttempt: run.run_attempt,
      });
      if (artifact) {
        appendGithubOutputs(output, {
          [`${outputPrefix}run_id`]: run.id,
          [`${outputPrefix}run_attempt`]: artifact.runAttempt,
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
          `No successful ${workflow} run for the exact main commit has an unexpired run-scoped artifact.`,
        );
      }
      throw new Error(`The exact main commit did not pass ${workflow}.`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
  throw new Error(`Timed out waiting for ${workflow} on exact commit ${sha}.`);
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
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
  throw new Error('Usage: release-evidence.mts wait-candidate');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(`[release-evidence] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeCorsPolicy, normalizeLifecyclePolicy } from './audit-ops-drift.mts';
import { releaseTargetWorkers, verifyRecoveryBoundary } from './release-deployment-state.mts';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 512 * 1024;
const SNAPSHOT_FILE = 'r2-policy-checkpoint.json';
const ASSESSMENT_FILE = 'r2-policy-recovery.json';
const VERIFICATION_FILE = 'r2-policy-recovery-verification.json';
const PAIRED_VERIFICATION_FILE = 'paired-recovery-verification.json';

type PolicyKind = 'cors' | 'lifecycle';
type PolicyBoundary = 'baseline' | 'candidate';
type R2Fetcher = typeof fetch;
type R2Environment = Readonly<Record<string, string | undefined>>;
type WorkerVerifier = (directory: string, options?: Record<string, unknown>) => unknown;

interface R2PolicyDefinition {
  id: string;
  bucket: string;
  kind: PolicyKind;
  source: string;
  releaseTargets: readonly string[];
  consumers: readonly string[];
}

interface R2PolicyCheckpoint extends R2PolicyDefinition {
  baseline: unknown;
  candidate: unknown;
  baselineCanonical: unknown;
  candidateCanonical: unknown;
}

interface R2PolicyCheckpointReport {
  schemaVersion: 1;
  releaseTarget: string;
  capturedAt: string;
  status: 'captured';
  policies: R2PolicyCheckpoint[];
}

interface R2PolicyResult {
  id: string;
  bucket: string;
  status: string;
  error?: string;
}

interface R2PolicyRecoveryReport {
  schemaVersion: 1;
  assessedAt?: string;
  recoveredAt?: string;
  status: string;
  results: R2PolicyResult[];
  forwardRepairTargets: string[];
}

interface WorkerBoundaryEvidence {
  target: string;
  boundary: PolicyBoundary;
  deploymentId: string;
  versionId: string;
  message: string | null;
}

interface ReconciliationResult extends R2PolicyResult {
  desiredBoundary: PolicyBoundary | null;
}

interface R2ReconciliationReport {
  schemaVersion: 1;
  reconciledAt: string;
  status: string;
  workerBoundaries: WorkerBoundaryEvidence[];
  results: ReconciliationResult[];
  forwardRepairTargets: string[];
}

interface R2VerificationResult extends R2PolicyResult {
  desiredBoundary: PolicyBoundary | null;
}

interface R2VerificationReport {
  schemaVersion: 1;
  verifiedAt: string;
  status: 'verified' | 'failed';
  pairedPlanStatus: string | null;
  results: R2VerificationResult[];
}

interface PairedVerificationReport {
  schemaVersion: 1;
  verifiedAt: string;
  status: 'pending' | 'verified' | 'failed';
  r2Status: string;
  workerStatus: string;
  r2Error?: string;
  workerError?: string;
  workerIdentityStable?: boolean;
  pairingError?: string;
  r2Verification?: unknown;
  workerVerification?: unknown;
}

export interface R2PolicyStateOptions {
  root?: string;
  fetcher?: R2Fetcher;
  env?: R2Environment;
  requirePairedPlan?: boolean;
  verifyWorkers?: WorkerVerifier;
  workerOptions?: Record<string, unknown>;
}

const POLICIES = [
  {
    id: 'remote-share-cors',
    bucket: 'musixquare-remote-share',
    kind: 'cors',
    source: 'cloudflare/r2-cors.remote-share.json',
    releaseTargets: ['remote-share', 'all'],
    consumers: ['remote-share', 'app'],
  },
  {
    id: 'remote-share-lifecycle',
    bucket: 'musixquare-remote-share',
    kind: 'lifecycle',
    source: 'cloudflare/r2-lifecycle.remote-share.json',
    releaseTargets: ['remote-share', 'all'],
    consumers: ['remote-share', 'app'],
  },
  {
    id: 'pro-media-cors',
    bucket: 'musixquare-pro-media',
    kind: 'cors',
    source: 'cloudflare/r2-cors.pro-media.json',
    releaseTargets: ['pro-room', 'all'],
    consumers: ['pro-room', 'app'],
  },
] as const satisfies readonly R2PolicyDefinition[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isPolicyKind(value: unknown): value is PolicyKind {
  return value === 'cors' || value === 'lifecycle';
}

function isPolicyBoundary(value: unknown): value is PolicyBoundary {
  return value === 'baseline' || value === 'candidate';
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path: string): unknown {
  const value: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'));
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizePolicy(kind: PolicyKind, value: unknown, label: string): unknown {
  return kind === 'cors'
    ? normalizeCorsPolicy(value, label)
    : normalizeLifecyclePolicy(value, label);
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void {
  try {
    reader.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation is resource cleanup only. It must never hide or delay the
    // primary protocol/cap/timeout error.
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  label: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new Error(`${label} response timed out.`);
  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(new Error(`${label} response timed out.`));
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (rejectOnAbort) signal.removeEventListener('abort', rejectOnAbort);
  }
}

async function readJsonResponse(
  response: Response,
  label: string,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) {
    cancelResponseBody(response, `${label} exceeded the response ceiling.`);
    throw new Error(`${label} exceeded the ${RESPONSE_MAX_BYTES}-byte response ceiling.`);
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
        if (byteLength > RESPONSE_MAX_BYTES) {
          cancelReader(reader, `${label} exceeded the response ceiling.`);
          throw new Error(`${label} exceeded the ${RESPONSE_MAX_BYTES}-byte response ceiling.`);
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
        // A pending read can retain the lock after a timeout. The primary
        // bounded-read error remains authoritative.
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

function cancelResponseBody(response: Response, reason: unknown): void {
  try {
    const cancellation = response.body?.cancel(reason);
    if (cancellation && typeof cancellation.catch === 'function') {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cancellation is resource cleanup only. It must never hide or delay the
    // primary protocol/cap error.
  }
}

function timeoutError(label: string): Error {
  return new Error(`${label} response timed out.`);
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

  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
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
    if (rejectOnAbort) signal.removeEventListener('abort', rejectOnAbort);
  }
}

async function fetchWithDeadline(
  fetcher: R2Fetcher,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  label: string,
): Promise<Response> {
  const fetchPromise = Promise.resolve().then(() => fetcher(url, init));
  return waitForResponse(fetchPromise, signal, label);
}

function policyUrl(policy: R2PolicyDefinition, accountId: string): string {
  return (
    `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}` +
    `/r2/buckets/${encodeURIComponent(policy.bucket)}/${policy.kind}`
  );
}

async function readLivePolicy(
  policy: R2PolicyDefinition,
  { fetcher, env }: { fetcher: R2Fetcher; env: R2Environment },
): Promise<unknown> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    throw new Error(
      'R2 policy checkpoint requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
    );
  }
  const url = policyUrl(policy, accountId);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchWithDeadline(
    fetcher,
    url,
    {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    },
    signal,
    policy.id,
  );
  if (!response.ok) {
    cancelResponseBody(response, `${policy.id} returned a non-success status.`);
    throw new Error(`${policy.id} read returned HTTP ${response.status}.`);
  }
  const payload = await readJsonResponse(response, policy.id, signal);
  if (!isRecord(payload) || payload.success !== true || !payload.result) {
    throw new Error(`${policy.id} returned an invalid Cloudflare API envelope.`);
  }
  return payload.result;
}

async function writeLivePolicy(
  policy: R2PolicyDefinition,
  value: unknown,
  { fetcher, env }: { fetcher: R2Fetcher; env: R2Environment },
): Promise<void> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    throw new Error('R2 policy recovery requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.');
  }
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchWithDeadline(
    fetcher,
    policyUrl(policy, accountId),
    {
      method: 'PUT',
      redirect: 'error',
      signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    },
    signal,
    `${policy.id} restore`,
  );
  if (!response.ok) {
    cancelResponseBody(response, `${policy.id} restore returned a non-success status.`);
    throw new Error(`${policy.id} restore returned HTTP ${response.status}.`);
  }
  const payload = await readJsonResponse(response, `${policy.id} restore`, signal);
  if (!isRecord(payload) || payload.success !== true) {
    throw new Error(`${policy.id} restore returned an invalid Cloudflare API envelope.`);
  }
}

export async function captureR2PolicyCheckpoint(
  releaseTarget: string,
  directory: string,
  {
    root = process.cwd(),
    fetcher = globalThis.fetch,
    env = process.env,
  }: R2PolicyStateOptions = {},
): Promise<R2PolicyCheckpointReport> {
  // Validate the release target even when it has no R2 policy mutation.
  releaseTargetWorkers(releaseTarget);
  const selected = POLICIES.filter((policy) =>
    policy.releaseTargets.some((target) => target === releaseTarget),
  );
  const report: R2PolicyCheckpointReport = {
    schemaVersion: 1,
    releaseTarget,
    capturedAt: new Date().toISOString(),
    status: 'captured',
    policies: [],
  };
  for (const policy of selected) {
    const baseline = await readLivePolicy(policy, { fetcher, env });
    const candidate = readJson(resolve(root, policy.source));
    report.policies.push({
      ...policy,
      baseline,
      candidate,
      baselineCanonical: normalizePolicy(policy.kind, baseline, `live:${policy.id}`),
      candidateCanonical: normalizePolicy(policy.kind, candidate, policy.source),
    });
  }
  writeJson(resolve(directory, SNAPSHOT_FILE), report);
  return report;
}

function parsePolicyCheckpoint(value: unknown): R2PolicyCheckpoint {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.bucket !== 'string' ||
    !isPolicyKind(value.kind) ||
    typeof value.source !== 'string' ||
    !isStringArray(value.releaseTargets) ||
    !isStringArray(value.consumers) ||
    !('baseline' in value) ||
    !('candidate' in value) ||
    !('baselineCanonical' in value) ||
    !('candidateCanonical' in value)
  ) {
    throw new Error('R2 policy recovery checkpoint is missing or malformed.');
  }
  return {
    id: value.id,
    bucket: value.bucket,
    kind: value.kind,
    source: value.source,
    releaseTargets: value.releaseTargets,
    consumers: value.consumers,
    baseline: value.baseline,
    candidate: value.candidate,
    baselineCanonical: value.baselineCanonical,
    candidateCanonical: value.candidateCanonical,
  };
}

function parsePolicyCheckpointReport(value: unknown): R2PolicyCheckpointReport {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.releaseTarget !== 'string' ||
    typeof value.capturedAt !== 'string' ||
    value.status !== 'captured' ||
    !Array.isArray(value.policies)
  ) {
    throw new Error('R2 policy recovery checkpoint is missing or malformed.');
  }
  return {
    schemaVersion: 1,
    releaseTarget: value.releaseTarget,
    capturedAt: value.capturedAt,
    status: 'captured',
    policies: value.policies.map(parsePolicyCheckpoint),
  };
}

export async function assessR2PolicyRecovery(
  directory: string,
  { fetcher = globalThis.fetch, env = process.env }: R2PolicyStateOptions = {},
): Promise<R2PolicyRecoveryReport> {
  const snapshot = parsePolicyCheckpointReport(readJson(resolve(directory, SNAPSHOT_FILE)));
  const forwardRepairTargets = new Set<string>();
  const report: R2PolicyRecoveryReport = {
    schemaVersion: 1,
    assessedAt: new Date().toISOString(),
    status: 'unchanged',
    results: [],
    forwardRepairTargets: [],
  };
  for (const policy of snapshot.policies) {
    const result: R2PolicyResult = { id: policy.id, bucket: policy.bucket, status: 'pending' };
    report.results.push(result);
    try {
      const current = await readLivePolicy(policy, { fetcher, env });
      const currentCanonical = normalizePolicy(policy.kind, current, `live:${policy.id}`);
      const baseline = sameJson(currentCanonical, policy.baselineCanonical);
      const candidate = sameJson(currentCanonical, policy.candidateCanonical);
      result.status = baseline
        ? 'baseline-policy-active'
        : candidate
          ? 'candidate-policy-active'
          : 'external-policy-drift';
      if (!baseline && !candidate) {
        for (const target of policy.consumers) forwardRepairTargets.add(target);
      }
    } catch (error) {
      result.status = 'assessment-failed';
      result.error = error instanceof Error ? error.message : String(error);
      for (const target of policy.consumers) forwardRepairTargets.add(target);
    }
  }
  report.forwardRepairTargets = [...forwardRepairTargets];
  if (forwardRepairTargets.size > 0) report.status = 'forward-repair-required';
  writeJson(resolve(directory, ASSESSMENT_FILE), report);
  return report;
}

export async function restoreR2Policies(
  directory: string,
  { fetcher = globalThis.fetch, env = process.env }: R2PolicyStateOptions = {},
): Promise<R2PolicyRecoveryReport> {
  // Focused baseline-restore helper retained for policy-level tests. Production
  // recovery must use reconcileR2PoliciesWithWorkerBoundary so a retained
  // candidate Worker can never be paired with a pre-release policy by itself.
  const snapshot = parsePolicyCheckpointReport(readJson(resolve(directory, SNAPSHOT_FILE)));
  const forwardRepairTargets = new Set<string>();
  const report: R2PolicyRecoveryReport = {
    schemaVersion: 1,
    recoveredAt: new Date().toISOString(),
    status: 'unchanged',
    results: [],
    forwardRepairTargets: [],
  };
  let restored = false;

  for (const policy of snapshot.policies) {
    const result: R2PolicyResult = { id: policy.id, bucket: policy.bucket, status: 'pending' };
    report.results.push(result);
    try {
      const current = await readLivePolicy(policy, { fetcher, env });
      const currentCanonical = normalizePolicy(policy.kind, current, `live:${policy.id}`);
      if (sameJson(currentCanonical, policy.baselineCanonical)) {
        result.status = 'unchanged';
        continue;
      }
      if (!sameJson(currentCanonical, policy.candidateCanonical)) {
        result.status = 'external-policy-drift';
        for (const target of policy.consumers) forwardRepairTargets.add(target);
        continue;
      }

      // The R2 policy endpoints do not document an ETag/If-Match mutation
      // precondition. Confirm the exact candidate twice immediately before the
      // PUT, restore only that known candidate, and verify the baseline by a
      // fresh read. Any observed divergence is left untouched and fenced to a
      // forward repair.
      const confirmation = await readLivePolicy(policy, { fetcher, env });
      const confirmationCanonical = normalizePolicy(
        policy.kind,
        confirmation,
        `confirmation:${policy.id}`,
      );
      if (!sameJson(confirmationCanonical, policy.candidateCanonical)) {
        result.status = 'external-policy-drift';
        for (const target of policy.consumers) forwardRepairTargets.add(target);
        continue;
      }

      await writeLivePolicy(policy, policy.baseline, { fetcher, env });
      const readback = await readLivePolicy(policy, { fetcher, env });
      const readbackCanonical = normalizePolicy(policy.kind, readback, `readback:${policy.id}`);
      if (!sameJson(readbackCanonical, policy.baselineCanonical)) {
        throw new Error(`${policy.id} baseline restore did not pass exact read-back.`);
      }
      result.status = 'restored-baseline';
      restored = true;
    } catch (error) {
      result.status = 'restore-failed';
      result.error = error instanceof Error ? error.message : String(error);
      for (const target of policy.consumers) forwardRepairTargets.add(target);
    }
  }

  report.forwardRepairTargets = [...forwardRepairTargets];
  report.status =
    forwardRepairTargets.size > 0
      ? 'forward-repair-required'
      : restored
        ? 'restored-baseline'
        : 'unchanged';
  writeJson(resolve(directory, ASSESSMENT_FILE), report);
  return report;
}

function workerBoundaryEvidence(verification: unknown): WorkerBoundaryEvidence[] {
  if (
    !isRecord(verification) ||
    verification.status !== 'verified' ||
    !Array.isArray(verification.results)
  ) {
    throw new Error('The fresh Worker recovery boundary is missing or unverified.');
  }
  return verification.results.map((result: unknown) => {
    if (!isRecord(result)) {
      throw new Error('The fresh Worker recovery boundary contains incomplete identity evidence.');
    }
    const boundary =
      result.status === 'verified-baseline'
        ? 'baseline'
        : result.status === 'verified-forward-boundary'
          ? 'candidate'
          : null;
    if (
      !boundary ||
      typeof result.target !== 'string' ||
      typeof result.currentDeploymentId !== 'string' ||
      !result.currentDeploymentId ||
      typeof result.currentVersionId !== 'string' ||
      !result.currentVersionId
    ) {
      throw new Error('The fresh Worker recovery boundary contains incomplete identity evidence.');
    }
    return {
      target: result.target,
      boundary,
      deploymentId: result.currentDeploymentId,
      versionId: result.currentVersionId,
      message: typeof result.currentMessage === 'string' ? result.currentMessage : null,
    };
  });
}

function desiredPolicyBoundary(
  policy: R2PolicyCheckpoint,
  workerBoundaries: WorkerBoundaryEvidence[],
): PolicyBoundary {
  const consumers = new Set(policy.consumers);
  const selectedConsumers = workerBoundaries.filter((worker) => consumers.has(worker.target));
  if (selectedConsumers.length === 0) {
    throw new Error(`${policy.id} has no selected Worker consumer in the recovery boundary.`);
  }
  return selectedConsumers.some((worker) => worker.boundary === 'candidate')
    ? 'candidate'
    : 'baseline';
}

function policyCandidate(policy: R2PolicyCheckpoint, root: string): unknown {
  const candidate = policy.candidate ?? readJson(resolve(root, policy.source));
  const candidateCanonical = normalizePolicy(policy.kind, candidate, `candidate:${policy.id}`);
  if (!sameJson(candidateCanonical, policy.candidateCanonical)) {
    throw new Error(`${policy.id} candidate no longer matches the immutable recovery checkpoint.`);
  }
  return candidate;
}

export async function reconcileR2PoliciesWithWorkerBoundary(
  directory: string,
  workerDirectory: string,
  {
    root = process.cwd(),
    fetcher = globalThis.fetch,
    env = process.env,
    verifyWorkers = verifyRecoveryBoundary,
    workerOptions,
  }: R2PolicyStateOptions = {},
): Promise<R2ReconciliationReport> {
  const snapshot = parsePolicyCheckpointReport(readJson(resolve(directory, SNAPSHOT_FILE)));

  // Resolve the exact live Worker boundary before changing an account-level
  // policy. A rollback report alone cannot prove that a skipped Worker really
  // is the retained candidate or that a restored Worker reached its baseline.
  const workerVerification = verifyWorkers(workerDirectory, workerOptions ?? {});
  const workerBoundaries = workerBoundaryEvidence(workerVerification);
  const forwardRepairTargets = new Set<string>();
  const report: R2ReconciliationReport = {
    schemaVersion: 1,
    reconciledAt: new Date().toISOString(),
    status: 'pending',
    workerBoundaries,
    results: [],
    forwardRepairTargets: [],
  };
  let failed = false;

  for (const policy of snapshot.policies) {
    const result: ReconciliationResult = {
      id: policy.id,
      bucket: policy.bucket,
      desiredBoundary: null,
      status: 'pending',
    };
    report.results.push(result);
    try {
      const desiredBoundary = desiredPolicyBoundary(policy, workerBoundaries);
      result.desiredBoundary = desiredBoundary;
      const candidate = policyCandidate(policy, root);
      const desired = desiredBoundary === 'candidate' ? candidate : policy.baseline;
      const desiredCanonical =
        desiredBoundary === 'candidate' ? policy.candidateCanonical : policy.baselineCanonical;
      const oppositeCanonical =
        desiredBoundary === 'candidate' ? policy.baselineCanonical : policy.candidateCanonical;
      const current = await readLivePolicy(policy, { fetcher, env });
      const currentCanonical = normalizePolicy(policy.kind, current, `live:${policy.id}`);

      if (sameJson(currentCanonical, desiredCanonical)) {
        result.status = `${desiredBoundary}-policy-active`;
        continue;
      }
      if (!sameJson(currentCanonical, oppositeCanonical)) {
        throw new Error(
          `${policy.id} is neither the captured baseline nor the exact release candidate.`,
        );
      }

      // R2 policy endpoints expose no documented compare-and-swap mutation.
      // Confirm the exact opposite known state immediately before switching to
      // the policy required by the freshly verified Worker boundary.
      const confirmation = await readLivePolicy(policy, { fetcher, env });
      const confirmationCanonical = normalizePolicy(
        policy.kind,
        confirmation,
        `confirmation:${policy.id}`,
      );
      if (!sameJson(confirmationCanonical, oppositeCanonical)) {
        throw new Error(`${policy.id} changed while its paired recovery was being reconciled.`);
      }
      await writeLivePolicy(policy, desired, { fetcher, env });
      const readback = await readLivePolicy(policy, { fetcher, env });
      const readbackCanonical = normalizePolicy(policy.kind, readback, `readback:${policy.id}`);
      if (!sameJson(readbackCanonical, desiredCanonical)) {
        throw new Error(`${policy.id} paired-policy update did not pass exact read-back.`);
      }
      result.status =
        desiredBoundary === 'candidate' ? 'candidate-policy-restored' : 'baseline-policy-restored';
    } catch (error) {
      result.status = 'reconciliation-failed';
      result.error = error instanceof Error ? error.message : String(error);
      for (const target of policy.consumers) forwardRepairTargets.add(target);
      failed = true;
    }
  }

  report.forwardRepairTargets = [...forwardRepairTargets];
  report.status = failed ? 'forward-repair-required' : 'paired-policy-active';
  writeJson(resolve(directory, ASSESSMENT_FILE), report);
  return report;
}

export async function verifyR2PolicyRecovery(
  directory: string,
  {
    fetcher = globalThis.fetch,
    env = process.env,
    requirePairedPlan = false,
  }: R2PolicyStateOptions = {},
): Promise<R2VerificationReport> {
  const snapshot = parsePolicyCheckpointReport(readJson(resolve(directory, SNAPSHOT_FILE)));

  let pairedPlan: unknown = null;
  try {
    pairedPlan = readJson(resolve(directory, ASSESSMENT_FILE));
  } catch {
    // Baseline-only verification remains available to focused tooling. The
    // production paired verifier below requires a reconciled plan explicitly.
  }
  const pairedPlanRecord = isRecord(pairedPlan) ? pairedPlan : null;
  const pairedResultValues =
    pairedPlanRecord && Array.isArray(pairedPlanRecord.results) ? pairedPlanRecord.results : [];
  const pairedResults = new Map<string, ReconciliationResult>();
  for (const result of pairedResultValues) {
    if (
      isRecord(result) &&
      typeof result.id === 'string' &&
      typeof result.bucket === 'string' &&
      isPolicyBoundary(result.desiredBoundary) &&
      typeof result.status === 'string'
    ) {
      pairedResults.set(result.id, {
        id: result.id,
        bucket: result.bucket,
        desiredBoundary: result.desiredBoundary,
        status: result.status,
        ...(typeof result.error === 'string' ? { error: result.error } : {}),
      });
    }
  }
  const pairedPlanValid =
    pairedPlanRecord?.schemaVersion === 1 &&
    pairedPlanRecord.status === 'paired-policy-active' &&
    Array.isArray(pairedPlanRecord.workerBoundaries) &&
    pairedResultValues.length === snapshot.policies.length &&
    pairedResults.size === snapshot.policies.length;

  const report: R2VerificationReport = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    status: 'verified',
    pairedPlanStatus:
      pairedPlanRecord && typeof pairedPlanRecord.status === 'string'
        ? pairedPlanRecord.status
        : null,
    results: [],
  };
  let failed = requirePairedPlan && !pairedPlanValid;
  for (const policy of snapshot.policies) {
    const pairedResult = pairedResults.get(policy.id);
    const desiredBoundary: PolicyBoundary | null = pairedPlanValid
      ? (pairedResult?.desiredBoundary ?? null)
      : 'baseline';
    const result: R2VerificationResult = {
      id: policy.id,
      bucket: policy.bucket,
      desiredBoundary,
      status: 'pending',
    };
    report.results.push(result);
    try {
      if (!isPolicyBoundary(desiredBoundary)) {
        throw new Error(`${policy.id} has no valid paired-policy recovery target.`);
      }
      const current = await readLivePolicy(policy, { fetcher, env });
      const currentCanonical = normalizePolicy(policy.kind, current, `verify:${policy.id}`);
      const expectedCanonical =
        desiredBoundary === 'candidate' ? policy.candidateCanonical : policy.baselineCanonical;
      if (!sameJson(currentCanonical, expectedCanonical)) {
        result.status = `${desiredBoundary}-mismatch`;
        result.error = `Live policy does not match the ${desiredBoundary} policy required by its recovered Workers.`;
        failed = true;
        continue;
      }
      result.status = `${desiredBoundary}-active`;
    } catch (error) {
      result.status = 'verification-failed';
      result.error = error instanceof Error ? error.message : String(error);
      failed = true;
    }
  }

  report.status = failed ? 'failed' : 'verified';
  writeJson(resolve(directory, VERIFICATION_FILE), report);
  if (failed) {
    throw new Error(
      'Fresh R2 recovery verification failed; production was left for manual forward repair.',
    );
  }
  return report;
}

export async function verifyPairedRecoveryBoundary(
  directory: string,
  workerDirectory: string,
  { fetcher = globalThis.fetch, env = process.env, workerOptions }: R2PolicyStateOptions = {},
): Promise<PairedVerificationReport> {
  const report: PairedVerificationReport = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    status: 'pending',
    r2Status: 'pending',
    workerStatus: 'pending',
  };
  let failed = false;
  let r2Verification: unknown;
  let workerVerification: unknown;

  try {
    const verification = await verifyR2PolicyRecovery(directory, {
      fetcher,
      env,
      requirePairedPlan: true,
    });
    r2Verification = verification;
    report.r2Status = verification.status;
  } catch (error) {
    failed = true;
    report.r2Status = 'failed';
    report.r2Error = error instanceof Error ? error.message : String(error);
    try {
      r2Verification = readJson(resolve(directory, VERIFICATION_FILE));
    } catch {
      // The primary verification error is already recorded.
    }
  }

  try {
    workerVerification = verifyRecoveryBoundary(workerDirectory, workerOptions || {});
    report.workerStatus =
      isRecord(workerVerification) && typeof workerVerification.status === 'string'
        ? workerVerification.status
        : 'failed';
  } catch (error) {
    failed = true;
    report.workerStatus = 'failed';
    report.workerError = error instanceof Error ? error.message : String(error);
    try {
      workerVerification = readJson(resolve(workerDirectory, 'recovery-final-verification.json'));
    } catch {
      // The primary verification error is already recorded.
    }
  }

  try {
    const plan = readJson(resolve(directory, ASSESSMENT_FILE));
    const plannedWorkers = isRecord(plan) ? plan.workerBoundaries : undefined;
    const currentWorkers = workerBoundaryEvidence(workerVerification);
    if (!Array.isArray(plannedWorkers) || !sameJson(plannedWorkers, currentWorkers)) {
      throw new Error('Worker identity changed after its paired R2 policy was reconciled.');
    }
    report.workerIdentityStable = true;
  } catch (error) {
    failed = true;
    report.workerIdentityStable = false;
    report.pairingError = error instanceof Error ? error.message : String(error);
  }

  report.status = failed ? 'failed' : 'verified';
  report.r2Verification = r2Verification || null;
  report.workerVerification = workerVerification || null;
  writeJson(resolve(workerDirectory, PAIRED_VERIFICATION_FILE), report);
  if (failed) {
    throw new Error(
      'Fresh paired R2 and Worker recovery verification failed; production is not a coherent boundary.',
    );
  }
  return report;
}

export async function verifyR2PolicyPreflight(
  policyId: string,
  directory: string,
  { fetcher = globalThis.fetch, env = process.env }: R2PolicyStateOptions = {},
): Promise<{ id: string; status: 'unchanged' }> {
  const snapshot = parsePolicyCheckpointReport(readJson(resolve(directory, SNAPSHOT_FILE)));
  const policy = snapshot.policies.find((entry) => entry.id === policyId);
  if (!policy) throw new Error(`R2 policy ${policyId} is absent from the recovery checkpoint.`);
  const current = await readLivePolicy(policy, { fetcher, env });
  const currentCanonical = normalizePolicy(policy.kind, current, `live:${policy.id}`);
  if (!sameJson(currentCanonical, policy.baselineCanonical)) {
    throw new Error(
      `${policy.id} changed after the recovery checkpoint; release policy mutation was stopped.`,
    );
  }
  return { id: policy.id, status: 'unchanged' };
}

export function readR2ForwardRepairTargets(directory: string): string {
  const report = readJson(resolve(directory, ASSESSMENT_FILE));
  if (!isRecord(report) || !isStringArray(report.forwardRepairTargets)) {
    throw new Error('R2 policy recovery assessment is missing or malformed.');
  }
  return report.forwardRepairTargets.join(',');
}

async function main(): Promise<void> {
  const [mode, value, directoryArgument] = process.argv.slice(2);
  if (mode === 'snapshot') {
    if (!value || !directoryArgument) {
      throw new Error('snapshot requires a release target and output directory.');
    }
    await captureR2PolicyCheckpoint(value, directoryArgument);
  } else if (mode === 'assess') {
    if (!value || directoryArgument) throw new Error('assess requires exactly one directory.');
    await assessR2PolicyRecovery(value);
  } else if (mode === 'reconcile') {
    if (!value || !directoryArgument) {
      throw new Error('reconcile requires policy and Worker recovery directories.');
    }
    const report = await reconcileR2PoliciesWithWorkerBoundary(value, directoryArgument);
    if (report.status !== 'paired-policy-active') {
      throw new Error(
        'R2 policy could not be reconciled with the exact recovered Worker boundary.',
      );
    }
  } else if (mode === 'verify-paired-recovery') {
    if (!value || !directoryArgument) {
      throw new Error('verify-paired-recovery requires policy and Worker recovery directories.');
    }
    await verifyPairedRecoveryBoundary(value, directoryArgument);
  } else if (mode === 'preflight') {
    if (!value || !directoryArgument) {
      throw new Error('preflight requires a policy id and checkpoint directory.');
    }
    await verifyR2PolicyPreflight(value, directoryArgument);
  } else if (mode === 'targets') {
    if (!value || directoryArgument) throw new Error('targets requires exactly one directory.');
    process.stdout.write(readR2ForwardRepairTargets(value));
  } else {
    throw new Error(
      'Usage: node scripts/release-r2-policy-state.mts snapshot <release-target> <directory> | preflight <policy-id> <directory> | <reconcile|verify-paired-recovery> <policy-directory> <worker-directory> | <assess|targets> <directory>',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeCorsPolicy, normalizeLifecyclePolicy } from './audit-ops-drift.mjs';
import { releaseTargetWorkers, verifyRecoveryBoundary } from './release-deployment-state.mjs';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 512 * 1024;
const SNAPSHOT_FILE = 'r2-policy-checkpoint.json';
const ASSESSMENT_FILE = 'r2-policy-recovery.json';
const VERIFICATION_FILE = 'r2-policy-recovery-verification.json';
const PAIRED_VERIFICATION_FILE = 'paired-recovery-verification.json';

const POLICIES = Object.freeze([
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
]);

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizePolicy(kind, value, label) {
  return kind === 'cors'
    ? normalizeCorsPolicy(value, label)
    : normalizeLifecyclePolicy(value, label);
}

function cancelReader(reader, reason) {
  try {
    const cancellation = reader.cancel(reason);
    if (cancellation && typeof cancellation.catch === 'function') {
      void cancellation.catch(() => undefined);
    }
  } catch {
    // Cancellation is resource cleanup only. It must never hide or delay the
    // primary protocol/cap/timeout error.
  }
}

async function readChunk(reader, signal, label) {
  if (signal.aborted) throw new Error(`${label} response timed out.`);
  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => reject(new Error(`${label} response timed out.`));
    signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', rejectOnAbort);
  }
}

async function readJsonResponse(response, label, signal) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) {
    cancelResponseBody(response, `${label} exceeded the response ceiling.`);
    throw new Error(`${label} exceeded the ${RESPONSE_MAX_BYTES}-byte response ceiling.`);
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

function cancelResponseBody(response, reason) {
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

async function fetchWithDeadline(fetcher, url, init, signal, label) {
  const fetchPromise = Promise.resolve().then(() => fetcher(url, init));
  return waitForResponse(fetchPromise, signal, label);
}

function policyUrl(policy, accountId) {
  return (
    `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}` +
    `/r2/buckets/${encodeURIComponent(policy.bucket)}/${policy.kind}`
  );
}

async function readLivePolicy(policy, { fetcher, env }) {
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
  if (payload?.success !== true || !payload.result) {
    throw new Error(`${policy.id} returned an invalid Cloudflare API envelope.`);
  }
  return payload.result;
}

async function writeLivePolicy(policy, value, { fetcher, env }) {
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
  if (payload?.success !== true) {
    throw new Error(`${policy.id} restore returned an invalid Cloudflare API envelope.`);
  }
}

export async function captureR2PolicyCheckpoint(
  releaseTarget,
  directory,
  { root = process.cwd(), fetcher = globalThis.fetch, env = process.env } = {},
) {
  // Validate the release target even when it has no R2 policy mutation.
  releaseTargetWorkers(releaseTarget);
  const selected = POLICIES.filter((policy) => policy.releaseTargets.includes(releaseTarget));
  const report = {
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

export async function assessR2PolicyRecovery(
  directory,
  { fetcher = globalThis.fetch, env = process.env } = {},
) {
  const snapshot = readJson(resolve(directory, SNAPSHOT_FILE));
  if (
    snapshot?.schemaVersion !== 1 ||
    snapshot.status !== 'captured' ||
    !Array.isArray(snapshot.policies)
  ) {
    throw new Error('R2 policy recovery checkpoint is missing or malformed.');
  }
  const forwardRepairTargets = new Set();
  const report = {
    schemaVersion: 1,
    assessedAt: new Date().toISOString(),
    status: 'unchanged',
    results: [],
    forwardRepairTargets: [],
  };
  for (const policy of snapshot.policies) {
    const result = { id: policy.id, bucket: policy.bucket, status: 'pending' };
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
  directory,
  { fetcher = globalThis.fetch, env = process.env } = {},
) {
  // Focused baseline-restore helper retained for policy-level tests. Production
  // recovery must use reconcileR2PoliciesWithWorkerBoundary so a retained
  // candidate Worker can never be paired with a pre-release policy by itself.
  const snapshot = readJson(resolve(directory, SNAPSHOT_FILE));
  if (
    snapshot?.schemaVersion !== 1 ||
    snapshot.status !== 'captured' ||
    !Array.isArray(snapshot.policies)
  ) {
    throw new Error('R2 policy recovery checkpoint is missing or malformed.');
  }
  const forwardRepairTargets = new Set();
  const report = {
    schemaVersion: 1,
    recoveredAt: new Date().toISOString(),
    status: 'unchanged',
    results: [],
    forwardRepairTargets: [],
  };
  let restored = false;

  for (const policy of snapshot.policies) {
    const result = { id: policy.id, bucket: policy.bucket, status: 'pending' };
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

function workerBoundaryEvidence(verification) {
  if (verification?.status !== 'verified' || !Array.isArray(verification.results)) {
    throw new Error('The fresh Worker recovery boundary is missing or unverified.');
  }
  return verification.results.map((result) => {
    const boundary =
      result?.status === 'verified-baseline'
        ? 'baseline'
        : result?.status === 'verified-forward-boundary'
          ? 'candidate'
          : null;
    if (
      !boundary ||
      typeof result?.target !== 'string' ||
      typeof result?.currentDeploymentId !== 'string' ||
      !result.currentDeploymentId ||
      typeof result?.currentVersionId !== 'string' ||
      !result.currentVersionId
    ) {
      throw new Error('The fresh Worker recovery boundary contains incomplete identity evidence.');
    }
    return {
      target: result.target,
      boundary,
      deploymentId: result.currentDeploymentId,
      versionId: result.currentVersionId,
      message: result.currentMessage || null,
    };
  });
}

function desiredPolicyBoundary(policy, workerBoundaries) {
  const consumers = new Set(policy.consumers || []);
  const selectedConsumers = workerBoundaries.filter((worker) => consumers.has(worker.target));
  if (selectedConsumers.length === 0) {
    throw new Error(`${policy.id} has no selected Worker consumer in the recovery boundary.`);
  }
  return selectedConsumers.some((worker) => worker.boundary === 'candidate')
    ? 'candidate'
    : 'baseline';
}

function policyCandidate(policy, root) {
  const candidate = policy.candidate ?? readJson(resolve(root, policy.source));
  const candidateCanonical = normalizePolicy(policy.kind, candidate, `candidate:${policy.id}`);
  if (!sameJson(candidateCanonical, policy.candidateCanonical)) {
    throw new Error(`${policy.id} candidate no longer matches the immutable recovery checkpoint.`);
  }
  return candidate;
}

export async function reconcileR2PoliciesWithWorkerBoundary(
  directory,
  workerDirectory,
  {
    root = process.cwd(),
    fetcher = globalThis.fetch,
    env = process.env,
    verifyWorkers = verifyRecoveryBoundary,
    workerOptions,
  } = {},
) {
  const snapshot = readJson(resolve(directory, SNAPSHOT_FILE));
  if (
    snapshot?.schemaVersion !== 1 ||
    snapshot.status !== 'captured' ||
    !Array.isArray(snapshot.policies)
  ) {
    throw new Error('R2 policy recovery checkpoint is missing or malformed.');
  }

  // Resolve the exact live Worker boundary before changing an account-level
  // policy. A rollback report alone cannot prove that a skipped Worker really
  // is the retained candidate or that a restored Worker reached its baseline.
  const workerVerification = verifyWorkers(workerDirectory, workerOptions || {});
  const workerBoundaries = workerBoundaryEvidence(workerVerification);
  const forwardRepairTargets = new Set();
  const report = {
    schemaVersion: 1,
    reconciledAt: new Date().toISOString(),
    status: 'pending',
    workerBoundaries,
    results: [],
    forwardRepairTargets: [],
  };
  let failed = false;

  for (const policy of snapshot.policies) {
    const result = {
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
      for (const target of policy.consumers || []) forwardRepairTargets.add(target);
      failed = true;
    }
  }

  report.forwardRepairTargets = [...forwardRepairTargets];
  report.status = failed ? 'forward-repair-required' : 'paired-policy-active';
  writeJson(resolve(directory, ASSESSMENT_FILE), report);
  return report;
}

export async function verifyR2PolicyRecovery(
  directory,
  { fetcher = globalThis.fetch, env = process.env, requirePairedPlan = false } = {},
) {
  const snapshot = readJson(resolve(directory, SNAPSHOT_FILE));
  if (
    snapshot?.schemaVersion !== 1 ||
    snapshot.status !== 'captured' ||
    !Array.isArray(snapshot.policies)
  ) {
    throw new Error('R2 policy recovery checkpoint is missing or malformed.');
  }

  let pairedPlan = null;
  try {
    pairedPlan = readJson(resolve(directory, ASSESSMENT_FILE));
  } catch {
    // Baseline-only verification remains available to focused tooling. The
    // production paired verifier below requires a reconciled plan explicitly.
  }
  const pairedResults = new Map(
    Array.isArray(pairedPlan?.results)
      ? pairedPlan.results.map((result) => [result?.id, result])
      : [],
  );
  const pairedPlanValid =
    pairedPlan?.schemaVersion === 1 &&
    pairedPlan?.status === 'paired-policy-active' &&
    Array.isArray(pairedPlan?.workerBoundaries) &&
    pairedPlan.results?.length === snapshot.policies.length;

  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    status: 'verified',
    pairedPlanStatus: pairedPlan?.status || null,
    results: [],
  };
  let failed = requirePairedPlan && !pairedPlanValid;
  for (const policy of snapshot.policies) {
    const pairedResult = pairedResults.get(policy.id);
    const desiredBoundary = pairedPlanValid ? pairedResult?.desiredBoundary : 'baseline';
    const result = {
      id: policy.id,
      bucket: policy.bucket,
      desiredBoundary,
      status: 'pending',
    };
    report.results.push(result);
    try {
      if (!['baseline', 'candidate'].includes(desiredBoundary)) {
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
  directory,
  workerDirectory,
  { fetcher = globalThis.fetch, env = process.env, workerOptions } = {},
) {
  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    status: 'pending',
    r2Status: 'pending',
    workerStatus: 'pending',
  };
  let failed = false;
  let r2Verification;
  let workerVerification;

  try {
    r2Verification = await verifyR2PolicyRecovery(directory, {
      fetcher,
      env,
      requirePairedPlan: true,
    });
    report.r2Status = r2Verification.status;
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
    report.workerStatus = workerVerification.status;
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
    const plannedWorkers = plan?.workerBoundaries;
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
  policyId,
  directory,
  { fetcher = globalThis.fetch, env = process.env } = {},
) {
  const snapshot = readJson(resolve(directory, SNAPSHOT_FILE));
  const policy = snapshot?.policies?.find((entry) => entry.id === policyId);
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

export function readR2ForwardRepairTargets(directory) {
  const report = readJson(resolve(directory, ASSESSMENT_FILE));
  if (!Array.isArray(report?.forwardRepairTargets)) {
    throw new Error('R2 policy recovery assessment is missing or malformed.');
  }
  return report.forwardRepairTargets.join(',');
}

async function main() {
  const [mode, value, directoryArgument] = process.argv.slice(2);
  const directory = directoryArgument || value;
  if (mode === 'snapshot') {
    if (!value || !directoryArgument) {
      throw new Error('snapshot requires a release target and output directory.');
    }
    await captureR2PolicyCheckpoint(value, directoryArgument);
  } else if (mode === 'assess') {
    if (!value || directoryArgument) throw new Error('assess requires exactly one directory.');
    await assessR2PolicyRecovery(directory);
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
    process.stdout.write(readR2ForwardRepairTargets(directory));
  } else {
    throw new Error(
      'Usage: node scripts/release-r2-policy-state.mjs snapshot <release-target> <directory> | preflight <policy-id> <directory> | <reconcile|verify-paired-recovery> <policy-directory> <worker-directory> | <assess|targets> <directory>',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

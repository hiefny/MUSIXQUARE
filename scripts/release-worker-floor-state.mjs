import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { releaseGitSha, releaseTargetWorkers } from './release-deployment-state.mjs';

const SCHEMA_VERSION = 1;
const CHECKPOINT_FILE = 'worker-floor-checkpoint.json';
const ASSESSMENT_FILE = 'worker-floor-recovery.json';
const FINAL_VERIFICATION_FILE = 'worker-floor-final-verification.json';
const GENERATION_WORKERS = Object.freeze([
  'pro-room',
  'signaling',
  'developer-api-facade',
  'developer-api',
  'app',
]);
const ENTITLEMENT_WORKERS = Object.freeze(['pro-room', 'app']);
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/u;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function writeJson(path, value) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function lastD1ResultRow(payload, label) {
  const executions = Array.isArray(payload) ? payload : [payload];
  if (executions.length === 0) throw new Error(`${label} returned no D1 executions.`);
  for (const execution of executions) {
    if (!execution || typeof execution !== 'object' || execution.success === false) {
      throw new Error(`${label} contains a failed or malformed D1 execution.`);
    }
  }
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const rows = executions[index]?.results;
    if (Array.isArray(rows) && rows.length === 1) return rows[0];
  }
  throw new Error(`${label} must return exactly one compatibility-floor row.`);
}

export function parseWorkerFloorEvidence(payload, label = 'Worker compatibility floors') {
  const row = lastD1ResultRow(payload, label);
  const generationFloor = Number(row?.generation_floor);
  const everEnabled = Number(row?.ever_enabled);
  const entitlementFloor = Number(row?.entitlement_floor);
  const status = row?.status;
  const releaseSha = row?.release_sha === null ? null : String(row?.release_sha || '');
  const floorReleaseSha =
    row?.floor_release_sha === null ? null : String(row?.floor_release_sha || '').toLowerCase();
  if (
    Number(row?.contract_version) !== 1 ||
    !['disabled', 'ready'].includes(status) ||
    ![0, 1].includes(generationFloor) ||
    ![0, 1].includes(everEnabled) ||
    ![0, 1].includes(entitlementFloor) ||
    generationFloor !== everEnabled ||
    (generationFloor === 1
      ? !RELEASE_SHA_RE.test(floorReleaseSha || '')
      : floorReleaseSha !== null) ||
    (status === 'disabled'
      ? releaseSha !== null
      : generationFloor !== 1 || !RELEASE_SHA_RE.test(releaseSha || ''))
  ) {
    throw new Error(`${label} returned malformed generation or entitlement floor evidence.`);
  }
  return {
    status,
    releaseSha,
    generationFloor: generationFloor === 1,
    floorReleaseSha,
    entitlementFloor: entitlementFloor === 1,
  };
}

function gitIsAncestor(baseSha, headSha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseSha, headSha], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function selectedFloorWorkers(releaseTarget) {
  const selected = releaseTargetWorkers(releaseTarget);
  return {
    generation: GENERATION_WORKERS.filter((target) => selected.has(target)),
    entitlement: ENTITLEMENT_WORKERS.filter((target) => selected.has(target)),
  };
}

function workerState(target, directory) {
  const state = readJson(resolve(directory, `${target}-state.json`));
  if (
    state?.schemaVersion !== SCHEMA_VERSION ||
    state.target !== target ||
    state.attempted !== true ||
    typeof state.beforeVersionId !== 'string' ||
    !state.beforeVersionId
  ) {
    throw new Error(`The immutable Worker checkpoint for ${target} is missing or malformed.`);
  }
  return state;
}

function inspectWorkerProvenance(state, releaseSha, floorReleaseSha, isAncestor) {
  const beforeGitSha = releaseGitSha(state.beforeMessage);
  const releaseAncestor = Boolean(beforeGitSha && isAncestor(beforeGitSha, releaseSha));
  const generationFloorAware = Boolean(
    releaseAncestor && floorReleaseSha && isAncestor(floorReleaseSha, beforeGitSha),
  );
  return {
    target: state.target,
    beforeDeploymentId: state.beforeDeploymentId || null,
    beforeVersionId: state.beforeVersionId,
    beforeMessage: state.beforeMessage || null,
    beforeGitSha,
    provenanceStatus: releaseAncestor ? 'verified-release-ancestor' : 'unverified',
    generationFloorAware,
  };
}

function validateCheckpoint(checkpoint) {
  if (
    checkpoint?.schemaVersion !== SCHEMA_VERSION ||
    typeof checkpoint.releaseTarget !== 'string' ||
    !RELEASE_SHA_RE.test(checkpoint.releaseGitSha || '') ||
    typeof checkpoint.floors?.generationFloor !== 'boolean' ||
    typeof checkpoint.floors?.entitlementFloor !== 'boolean' ||
    !['disabled', 'ready'].includes(checkpoint.floors?.status) ||
    (checkpoint.floors.generationFloor
      ? !RELEASE_SHA_RE.test(checkpoint.floors.floorReleaseSha || '')
      : checkpoint.floors.floorReleaseSha !== null) ||
    (checkpoint.floors.status === 'disabled'
      ? checkpoint.floors.releaseSha !== null
      : checkpoint.floors.generationFloor !== true ||
        !RELEASE_SHA_RE.test(checkpoint.floors.releaseSha || '')) ||
    !Array.isArray(checkpoint.workers)
  ) {
    throw new Error('Worker compatibility-floor checkpoint is missing or malformed.');
  }
  releaseTargetWorkers(checkpoint.releaseTarget);
  return checkpoint;
}

export function captureWorkerFloorCheckpoint(
  releaseTarget,
  payload,
  directory,
  { isAncestor = gitIsAncestor } = {},
) {
  const floors = parseWorkerFloorEvidence(payload, 'Pre-mutation Worker compatibility floors');
  const selected = selectedFloorWorkers(releaseTarget);
  const targets = [...new Set([...selected.generation, ...selected.entitlement])];
  if (targets.length === 0) {
    throw new Error(`${releaseTarget} does not require a Worker compatibility-floor checkpoint.`);
  }
  const states = targets.map((target) => workerState(target, directory));
  const releaseMessages = new Set(states.map((state) => state.releaseMessage));
  if (releaseMessages.size !== 1) {
    throw new Error('Worker compatibility-floor checkpoint release identity is inconsistent.');
  }
  const candidateGitSha = releaseGitSha(states[0]?.releaseMessage);
  if (!candidateGitSha) {
    throw new Error('Worker compatibility-floor checkpoint requires an exact release Git SHA.');
  }
  const report = {
    schemaVersion: SCHEMA_VERSION,
    releaseTarget,
    releaseGitSha: candidateGitSha,
    capturedAt: new Date().toISOString(),
    floors,
    workers: states.map((state) =>
      inspectWorkerProvenance(state, candidateGitSha, floors.floorReleaseSha, isAncestor),
    ),
  };
  writeJson(resolve(directory, CHECKPOINT_FILE), report);
  return report;
}

function checkpointWorkerMap(checkpoint, directory, isAncestor) {
  const expected = selectedFloorWorkers(checkpoint.releaseTarget);
  const targets = [...new Set([...expected.generation, ...expected.entitlement])];
  const capturedByTarget = new Map();
  for (const worker of checkpoint.workers) {
    if (typeof worker?.target !== 'string' || capturedByTarget.has(worker.target)) {
      throw new Error('Worker compatibility-floor checkpoint contains duplicate identities.');
    }
    capturedByTarget.set(worker.target, worker);
  }
  if (
    capturedByTarget.size !== targets.length ||
    targets.some((target) => !capturedByTarget.has(target))
  ) {
    throw new Error('Worker compatibility-floor checkpoint target inventory is incomplete.');
  }

  const current = new Map();
  for (const target of targets) {
    const state = workerState(target, directory);
    const inspected = inspectWorkerProvenance(
      state,
      checkpoint.releaseGitSha,
      checkpoint.floors.floorReleaseSha,
      isAncestor,
    );
    const captured = capturedByTarget.get(target);
    if (
      captured.beforeDeploymentId !== inspected.beforeDeploymentId ||
      captured.beforeVersionId !== inspected.beforeVersionId ||
      captured.beforeMessage !== inspected.beforeMessage ||
      captured.beforeGitSha !== inspected.beforeGitSha
    ) {
      throw new Error(`Worker compatibility-floor identity changed for ${target}.`);
    }
    current.set(target, inspected);
  }
  return { current, selected: expected };
}

function validateFloorEvolution(checkpoint, currentFloors) {
  const checkpointFloors = checkpoint.floors;
  if (checkpointFloors.generationFloor && !currentFloors.generationFloor) {
    throw new Error('The immutable generation floor regressed after the recovery checkpoint.');
  }
  if (
    checkpointFloors.generationFloor &&
    currentFloors.generationFloor &&
    checkpointFloors.floorReleaseSha !== currentFloors.floorReleaseSha
  ) {
    throw new Error('The immutable generation floor release SHA drifted after the checkpoint.');
  }
  const generationTransitioned =
    checkpointFloors.generationFloor === false && currentFloors.generationFloor === true;
  if (generationTransitioned && currentFloors.floorReleaseSha !== checkpoint.releaseGitSha) {
    throw new Error(
      'A new generation floor must identify the exact release candidate captured by the checkpoint.',
    );
  }
  if (checkpointFloors.entitlementFloor && !currentFloors.entitlementFloor) {
    throw new Error('The entitlement compatibility floor regressed after the checkpoint.');
  }
  return {
    generationTransitioned,
    entitlementTransitioned:
      checkpointFloors.entitlementFloor === false && currentFloors.entitlementFloor === true,
  };
}

export function assessWorkerFloorRecovery(
  checkpointDirectory,
  currentPayload,
  outputDirectory,
  { isAncestor = gitIsAncestor } = {},
) {
  const checkpoint = validateCheckpoint(readJson(resolve(checkpointDirectory, CHECKPOINT_FILE)));
  const currentFloors = parseWorkerFloorEvidence(
    currentPayload,
    'Current Worker compatibility floors',
  );
  const { generationTransitioned, entitlementTransitioned } = validateFloorEvolution(
    checkpoint,
    currentFloors,
  );
  const { current: workers, selected } = checkpointWorkerMap(
    checkpoint,
    checkpointDirectory,
    isAncestor,
  );
  const forwardRepairTargets = new Set();
  const report = {
    schemaVersion: SCHEMA_VERSION,
    releaseTarget: checkpoint.releaseTarget,
    releaseGitSha: checkpoint.releaseGitSha,
    assessedAt: new Date().toISOString(),
    status: 'rollback-compatible',
    checkpointFloors: checkpoint.floors,
    currentFloors,
    results: [],
    forwardRepairTargets: [],
  };

  const generationEvidenceStable =
    checkpoint.floors.generationFloor === currentFloors.generationFloor &&
    checkpoint.floors.floorReleaseSha === currentFloors.floorReleaseSha;
  for (const target of selected.generation) {
    const worker = workers.get(target);
    const compatible =
      !generationTransitioned &&
      generationEvidenceStable &&
      worker?.provenanceStatus === 'verified-release-ancestor' &&
      (checkpoint.floors.generationFloor === false || worker.generationFloorAware === true);
    report.results.push({
      target,
      floor: 'generation',
      status: compatible ? 'baseline-compatible' : 'candidate-required',
      beforeGitSha: worker?.beforeGitSha || null,
    });
    if (!compatible) forwardRepairTargets.add(target);
  }

  const entitlementEvidenceStable =
    checkpoint.floors.entitlementFloor === currentFloors.entitlementFloor;
  for (const target of selected.entitlement) {
    const worker = workers.get(target);
    // Before the first entitlement cutover, a live candidate App can complete
    // the durable backfill after this read but before Worker rollback. There is
    // no distributed writer fence/CAS for that audit marker. Prefer a red,
    // candidate-absent recovery over restoring an entitlement-blind baseline;
    // routine baseline rollback starts only after a checkpoint captured true.
    const compatible =
      checkpoint.floors.entitlementFloor === true &&
      !entitlementTransitioned &&
      entitlementEvidenceStable &&
      worker?.provenanceStatus === 'verified-release-ancestor';
    report.results.push({
      target,
      floor: 'entitlement',
      status: compatible ? 'baseline-compatible' : 'candidate-required',
      beforeGitSha: worker?.beforeGitSha || null,
    });
    if (!compatible) forwardRepairTargets.add(target);
  }

  report.forwardRepairTargets = [...forwardRepairTargets];
  if (forwardRepairTargets.size > 0) report.status = 'forward-repair-required';
  writeJson(resolve(outputDirectory, ASSESSMENT_FILE), report);
  return report;
}

export function readWorkerFloorForwardRepairTargets(directory) {
  const report = readJson(resolve(directory, ASSESSMENT_FILE));
  if (!Array.isArray(report?.forwardRepairTargets)) {
    throw new Error('Worker compatibility-floor recovery assessment is missing or malformed.');
  }
  const knownWorkers = new Set([...GENERATION_WORKERS, ...ENTITLEMENT_WORKERS]);
  if (report.forwardRepairTargets.some((target) => !knownWorkers.has(target))) {
    throw new Error('Worker compatibility-floor recovery assessment contains an unknown target.');
  }
  return report.forwardRepairTargets.join(',');
}

export function verifyWorkerFloorRecovery(
  checkpointDirectory,
  freshPayload,
  assessmentDirectory = checkpointDirectory,
) {
  const verificationPath = resolve(assessmentDirectory, FINAL_VERIFICATION_FILE);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    verifiedAt: new Date().toISOString(),
    status: 'pending',
  };
  try {
    const checkpoint = validateCheckpoint(readJson(resolve(checkpointDirectory, CHECKPOINT_FILE)));
    const freshFloors = parseWorkerFloorEvidence(freshPayload, 'Final Worker compatibility floors');
    validateFloorEvolution(checkpoint, freshFloors);
    const assessment = readJson(resolve(assessmentDirectory, ASSESSMENT_FILE));
    const workerVerification = readJson(
      resolve(assessmentDirectory, 'recovery-final-verification.json'),
    );
    const knownWorkers = new Set([...GENERATION_WORKERS, ...ENTITLEMENT_WORKERS]);
    const forwardTargets = assessment?.forwardRepairTargets;
    if (
      assessment?.schemaVersion !== SCHEMA_VERSION ||
      assessment.releaseTarget !== checkpoint.releaseTarget ||
      assessment.releaseGitSha !== checkpoint.releaseGitSha ||
      !['rollback-compatible', 'forward-repair-required'].includes(assessment.status) ||
      !isDeepStrictEqual(assessment.checkpointFloors, checkpoint.floors) ||
      !isDeepStrictEqual(assessment.currentFloors, freshFloors) ||
      !Array.isArray(forwardTargets) ||
      new Set(forwardTargets).size !== forwardTargets.length ||
      forwardTargets.some((target) => !knownWorkers.has(target)) ||
      (forwardTargets.length === 0) !== (assessment.status === 'rollback-compatible')
    ) {
      throw new Error('The Worker compatibility-floor assessment is missing, malformed, or stale.');
    }
    if (workerVerification?.status !== 'verified' || !Array.isArray(workerVerification.results)) {
      throw new Error('The fresh Worker recovery boundary is missing or unverified.');
    }
    for (const target of forwardTargets) {
      const matchingWorkers = workerVerification.results.filter(
        (worker) => worker?.target === target,
      );
      if (
        matchingWorkers.length !== 1 ||
        matchingWorkers[0]?.status !== 'verified-forward-boundary' ||
        releaseGitSha(matchingWorkers[0]?.currentMessage) !== checkpoint.releaseGitSha
      ) {
        throw new Error(
          `${target} must remain on the exact release candidate required by its compatibility floor.`,
        );
      }
    }
    report.status = 'verified';
    report.releaseTarget = checkpoint.releaseTarget;
    report.releaseGitSha = checkpoint.releaseGitSha;
    report.assessmentStatus = assessment.status;
    report.forwardRepairTargets = [...forwardTargets];
    report.freshFloors = freshFloors;
    report.workerBoundaryStatus = workerVerification.status;
    writeJson(verificationPath, report);
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    writeJson(verificationPath, report);
    throw new Error('Final Worker compatibility-floor verification failed.', { cause: error });
  }
}

async function main() {
  const [mode, first, second, third] = process.argv.slice(2);
  if (mode === 'snapshot' && first && second && third) {
    captureWorkerFloorCheckpoint(first, readJson(second), third);
  } else if (mode === 'assess' && first && second && third) {
    assessWorkerFloorRecovery(first, readJson(second), third);
  } else if (mode === 'targets' && first && !second) {
    process.stdout.write(readWorkerFloorForwardRepairTargets(first));
  } else if (mode === 'verify' && first && second && third) {
    verifyWorkerFloorRecovery(first, readJson(second), third);
  } else {
    throw new Error(
      'Usage: node scripts/release-worker-floor-state.mjs snapshot <release-target> <d1-json> <checkpoint-directory> | assess <checkpoint-directory> <current-d1-json> <output-directory> | targets <assessment-directory> | verify <checkpoint-directory> <fresh-d1-json> <assessment-directory>',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

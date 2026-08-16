import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { releaseGitSha, releaseTargetWorkers } from './release-deployment-state.mts';

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
const DEVELOPER_AUTHORITY_WORKERS = Object.freeze(['developer-api-facade', 'developer-api']);
// Immutable first release whose App/PRO Workers implement the durable
// entitlement ledger and backfill contract represented by entitlement_floor.
export const ENTITLEMENT_SUPPORT_RELEASE_SHA = 'a79d1624d2314942072622cc875da7c7332a9530';
// Immutable first release whose Developer API pair propagates and enforces the
// per-room authority epoch/fence contract consumed by the PRO room Worker.
export const DEVELOPER_AUTHORITY_SUPPORT_RELEASE_SHA = '4d2a4ff7898d40956fc110ad998433aa41ceb0e2';
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/u;

type AncestorCheck = (baseSha: string, headSha: string) => boolean;
type FloorStatus = 'disabled' | 'ready';
type RecoveryStatus = 'rollback-compatible' | 'forward-repair-required';
type RecoveryResultStatus = 'baseline-compatible' | 'candidate-required';
type FloorKind = 'generation' | 'entitlement' | 'developer-authority';

export interface WorkerFloorEvidence {
  status: FloorStatus;
  releaseSha: string | null;
  generationFloor: boolean;
  floorReleaseSha: string | null;
  entitlementFloor: boolean;
}

interface WorkerState {
  target: string;
  beforeDeploymentId: string | null;
  beforeVersionId: string;
  beforeMessage: string | null;
  releaseMessage: string | null;
}

interface WorkerProvenance extends Record<string, unknown> {
  target: string;
  beforeDeploymentId: string | null;
  beforeVersionId: string;
  beforeMessage: string | null;
  beforeGitSha: string | null;
  provenanceStatus: 'verified-release-ancestor' | 'unverified';
  generationFloorAware: boolean;
  entitlementFloorAware: boolean;
  developerAuthorityAware: boolean;
}

interface WorkerFloorCheckpoint {
  schemaVersion: 1;
  releaseTarget: string;
  releaseGitSha: string;
  capturedAt: string;
  floors: WorkerFloorEvidence;
  workers: WorkerProvenance[];
}

interface SelectedFloorWorkers {
  generation: string[];
  entitlement: string[];
  developerAuthority: string[];
}

interface WorkerFloorRecoveryResult {
  target: string;
  floor: FloorKind;
  status: RecoveryResultStatus;
  beforeGitSha: string | null;
}

export interface WorkerFloorRecoveryReport {
  schemaVersion: 1;
  releaseTarget: string;
  releaseGitSha: string;
  assessedAt: string;
  status: RecoveryStatus;
  checkpointFloors: WorkerFloorEvidence;
  currentFloors: WorkerFloorEvidence;
  results: WorkerFloorRecoveryResult[];
  forwardRepairTargets: string[];
}

interface WorkerBoundaryResult extends Record<string, unknown> {
  target: string;
  status: string;
  currentMessage: string | null;
}

interface WorkerBoundaryVerification extends Record<string, unknown> {
  status: 'verified';
  results: WorkerBoundaryResult[];
}

export interface VerifiedWorkerFloorRecovery {
  schemaVersion: 1;
  verifiedAt: string;
  status: 'verified';
  releaseTarget: string;
  releaseGitSha: string;
  assessmentStatus: RecoveryStatus;
  forwardRepairTargets: string[];
  freshFloors: WorkerFloorEvidence;
  workerBoundaryStatus: 'verified';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFloorStatus(value: unknown): value is FloorStatus {
  return value === 'disabled' || value === 'ready';
}

function isRecoveryStatus(value: unknown): value is RecoveryStatus {
  return value === 'rollback-compatible' || value === 'forward-repair-required';
}

function readJson(path: string): unknown {
  const value: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'));
  return value;
}

function writeJson(path: string, value: unknown): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function lastD1ResultRow(payload: unknown, label: string): Record<string, unknown> {
  const rawExecutions: unknown[] = Array.isArray(payload) ? payload : [payload];
  if (rawExecutions.length === 0) throw new Error(`${label} returned no D1 executions.`);
  const executions: Record<string, unknown>[] = [];
  for (const execution of rawExecutions) {
    if (!isRecord(execution) || execution.success === false) {
      throw new Error(`${label} contains a failed or malformed D1 execution.`);
    }
    executions.push(execution);
  }
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const execution = executions[index];
    if (execution === undefined) continue;
    const rows = execution.results;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (Array.isArray(rows) && rows.length === 1 && isRecord(row)) return row;
  }
  throw new Error(`${label} must return exactly one compatibility-floor row.`);
}

export function parseWorkerFloorEvidence(
  payload: unknown,
  label = 'Worker compatibility floors',
): WorkerFloorEvidence {
  const row = lastD1ResultRow(payload, label);
  const generationFloor = Number(row?.generation_floor);
  const everEnabled = Number(row?.ever_enabled);
  const entitlementFloor = Number(row?.entitlement_floor);
  const status = row.status;
  const releaseSha = row.release_sha === null ? null : String(row.release_sha || '');
  const floorReleaseSha =
    row.floor_release_sha === null ? null : String(row.floor_release_sha || '').toLowerCase();
  if (
    Number(row?.contract_version) !== 1 ||
    !isFloorStatus(status) ||
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

function gitIsAncestor(baseSha: string, headSha: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseSha, headSha], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function selectedFloorWorkers(releaseTarget: string): SelectedFloorWorkers {
  const selected = releaseTargetWorkers(releaseTarget);
  return {
    generation: GENERATION_WORKERS.filter((target) => selected.has(target)),
    entitlement: ENTITLEMENT_WORKERS.filter((target) => selected.has(target)),
    developerAuthority: DEVELOPER_AUTHORITY_WORKERS.filter((target) => selected.has(target)),
  };
}

function workerState(target: string, directory: string): WorkerState {
  const state = readJson(resolve(directory, `${target}-state.json`));
  const beforeDeploymentId = isRecord(state) ? (state.beforeDeploymentId ?? null) : null;
  const beforeMessage = isRecord(state) ? (state.beforeMessage ?? null) : null;
  const releaseMessage = isRecord(state) ? (state.releaseMessage ?? null) : null;
  if (
    !isRecord(state) ||
    state.schemaVersion !== SCHEMA_VERSION ||
    state.target !== target ||
    state.attempted !== true ||
    typeof state.beforeVersionId !== 'string' ||
    !state.beforeVersionId ||
    !isNullableString(beforeDeploymentId) ||
    !isNullableString(beforeMessage) ||
    !isNullableString(releaseMessage)
  ) {
    throw new Error(`The immutable Worker checkpoint for ${target} is missing or malformed.`);
  }
  return {
    target,
    beforeDeploymentId,
    beforeVersionId: state.beforeVersionId,
    beforeMessage,
    releaseMessage,
  };
}

function inspectWorkerProvenance(
  state: WorkerState,
  releaseSha: string,
  floorReleaseSha: string | null,
  isAncestor: AncestorCheck,
): WorkerProvenance {
  const beforeGitSha = releaseGitSha(state.beforeMessage);
  const releaseAncestor = beforeGitSha !== null && isAncestor(beforeGitSha, releaseSha);
  const generationFloorAware =
    releaseAncestor && floorReleaseSha !== null && isAncestor(floorReleaseSha, beforeGitSha);
  const entitlementFloorAware =
    releaseAncestor && isAncestor(ENTITLEMENT_SUPPORT_RELEASE_SHA, beforeGitSha);
  const developerAuthorityAware =
    releaseAncestor && isAncestor(DEVELOPER_AUTHORITY_SUPPORT_RELEASE_SHA, beforeGitSha);
  return {
    target: state.target,
    beforeDeploymentId: state.beforeDeploymentId || null,
    beforeVersionId: state.beforeVersionId,
    beforeMessage: state.beforeMessage || null,
    beforeGitSha,
    provenanceStatus: releaseAncestor ? 'verified-release-ancestor' : 'unverified',
    generationFloorAware,
    entitlementFloorAware,
    developerAuthorityAware,
  };
}

function isWorkerFloorEvidence(value: unknown): value is WorkerFloorEvidence {
  if (!isRecord(value) || !isFloorStatus(value.status)) return false;
  if (
    typeof value.generationFloor !== 'boolean' ||
    typeof value.entitlementFloor !== 'boolean' ||
    !isNullableString(value.releaseSha) ||
    !isNullableString(value.floorReleaseSha)
  ) {
    return false;
  }
  return (
    (value.generationFloor
      ? RELEASE_SHA_RE.test(value.floorReleaseSha || '')
      : value.floorReleaseSha === null) &&
    (value.status === 'disabled'
      ? value.releaseSha === null
      : value.generationFloor && RELEASE_SHA_RE.test(value.releaseSha || ''))
  );
}

function isWorkerProvenance(value: unknown): value is WorkerProvenance {
  return (
    isRecord(value) &&
    typeof value.target === 'string' &&
    isNullableString(value.beforeDeploymentId) &&
    typeof value.beforeVersionId === 'string' &&
    value.beforeVersionId.length > 0 &&
    isNullableString(value.beforeMessage) &&
    isNullableString(value.beforeGitSha) &&
    (value.provenanceStatus === 'verified-release-ancestor' ||
      value.provenanceStatus === 'unverified') &&
    typeof value.generationFloorAware === 'boolean' &&
    typeof value.entitlementFloorAware === 'boolean' &&
    typeof value.developerAuthorityAware === 'boolean'
  );
}

function validateCheckpoint(checkpoint: unknown): WorkerFloorCheckpoint {
  if (
    !isRecord(checkpoint) ||
    checkpoint.schemaVersion !== SCHEMA_VERSION ||
    typeof checkpoint.releaseTarget !== 'string' ||
    typeof checkpoint.releaseGitSha !== 'string' ||
    !RELEASE_SHA_RE.test(checkpoint.releaseGitSha) ||
    typeof checkpoint.capturedAt !== 'string' ||
    !isWorkerFloorEvidence(checkpoint.floors) ||
    !Array.isArray(checkpoint.workers) ||
    !checkpoint.workers.every(isWorkerProvenance)
  ) {
    throw new Error('Worker compatibility-floor checkpoint is missing or malformed.');
  }
  releaseTargetWorkers(checkpoint.releaseTarget);
  return {
    schemaVersion: 1,
    releaseTarget: checkpoint.releaseTarget,
    releaseGitSha: checkpoint.releaseGitSha,
    capturedAt: checkpoint.capturedAt,
    floors: checkpoint.floors,
    workers: checkpoint.workers,
  };
}

export function captureWorkerFloorCheckpoint(
  releaseTarget: string,
  payload: unknown,
  directory: string,
  { isAncestor = gitIsAncestor }: { isAncestor?: AncestorCheck } = {},
): WorkerFloorCheckpoint {
  const floors = parseWorkerFloorEvidence(payload, 'Pre-mutation Worker compatibility floors');
  const selected = selectedFloorWorkers(releaseTarget);
  const targets = [
    ...new Set([...selected.generation, ...selected.entitlement, ...selected.developerAuthority]),
  ];
  if (targets.length === 0) {
    throw new Error(`${releaseTarget} does not require a Worker compatibility-floor checkpoint.`);
  }
  const states = targets.map((target) => workerState(target, directory));
  const releaseMessages = new Set(states.map((state) => state.releaseMessage));
  if (releaseMessages.size !== 1) {
    throw new Error('Worker compatibility-floor checkpoint release identity is inconsistent.');
  }
  const firstState = states[0];
  const candidateGitSha = firstState ? releaseGitSha(firstState.releaseMessage) : null;
  if (!candidateGitSha) {
    throw new Error('Worker compatibility-floor checkpoint requires an exact release Git SHA.');
  }
  const report: WorkerFloorCheckpoint = {
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

function checkpointWorkerMap(
  checkpoint: WorkerFloorCheckpoint,
  directory: string,
  isAncestor: AncestorCheck,
): { current: Map<string, WorkerProvenance>; selected: SelectedFloorWorkers } {
  const expected = selectedFloorWorkers(checkpoint.releaseTarget);
  const targets = [
    ...new Set([...expected.generation, ...expected.entitlement, ...expected.developerAuthority]),
  ];
  const capturedByTarget = new Map<string, WorkerProvenance>();
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

  const current = new Map<string, WorkerProvenance>();
  for (const target of targets) {
    const state = workerState(target, directory);
    const inspected = inspectWorkerProvenance(
      state,
      checkpoint.releaseGitSha,
      checkpoint.floors.floorReleaseSha,
      isAncestor,
    );
    const captured = capturedByTarget.get(target);
    if (captured === undefined) {
      throw new Error('Worker compatibility-floor checkpoint target inventory is incomplete.');
    }
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

function validateFloorEvolution(
  checkpoint: WorkerFloorCheckpoint,
  currentFloors: WorkerFloorEvidence,
): { generationTransitioned: boolean; entitlementTransitioned: boolean } {
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

function buildWorkerFloorRecoveryAssessment(
  checkpointDirectory: string,
  currentPayload: unknown,
  { isAncestor = gitIsAncestor }: { isAncestor?: AncestorCheck } = {},
): WorkerFloorRecoveryReport {
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
  const forwardRepairTargets = new Set<string>();
  const report: WorkerFloorRecoveryReport = {
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
    // routine baseline rollback starts only after a checkpoint captured true
    // and the baseline descends from the entitlement-support release boundary.
    const compatible =
      checkpoint.floors.entitlementFloor === true &&
      !entitlementTransitioned &&
      entitlementEvidenceStable &&
      worker?.provenanceStatus === 'verified-release-ancestor' &&
      worker?.entitlementFloorAware === true;
    report.results.push({
      target,
      floor: 'entitlement',
      status: compatible ? 'baseline-compatible' : 'candidate-required',
      beforeGitSha: worker?.beforeGitSha || null,
    });
    if (!compatible) forwardRepairTargets.add(target);
  }

  // The facade and backend are one public Developer API deployment contract.
  // Authority epochs are durable and immutable once issued. If either
  // baseline predates their end-to-end propagation (or lacks exact release
  // provenance), restoring only the other half would create an unproven mixed
  // pair against a retained authority-aware PRO Worker. Keep both candidates
  // unless every selected member independently proves the support boundary.
  const developerAuthorityCompatible = selected.developerAuthority.every((target) => {
    const worker = workers.get(target);
    return (
      worker?.provenanceStatus === 'verified-release-ancestor' &&
      worker?.developerAuthorityAware === true
    );
  });
  for (const target of selected.developerAuthority) {
    const worker = workers.get(target);
    report.results.push({
      target,
      floor: 'developer-authority',
      status: developerAuthorityCompatible ? 'baseline-compatible' : 'candidate-required',
      beforeGitSha: worker?.beforeGitSha || null,
    });
    if (!developerAuthorityCompatible) forwardRepairTargets.add(target);
  }

  report.forwardRepairTargets = [...forwardRepairTargets];
  if (forwardRepairTargets.size > 0) report.status = 'forward-repair-required';
  return report;
}

export function assessWorkerFloorRecovery(
  checkpointDirectory: string,
  currentPayload: unknown,
  outputDirectory: string,
  options: { isAncestor?: AncestorCheck } = {},
): WorkerFloorRecoveryReport {
  const report = buildWorkerFloorRecoveryAssessment(checkpointDirectory, currentPayload, options);
  writeJson(resolve(outputDirectory, ASSESSMENT_FILE), report);
  return report;
}

export function readWorkerFloorForwardRepairTargets(directory: string): string {
  const report = readJson(resolve(directory, ASSESSMENT_FILE));
  if (!isRecord(report) || !Array.isArray(report.forwardRepairTargets)) {
    throw new Error('Worker compatibility-floor recovery assessment is missing or malformed.');
  }
  const knownWorkers = new Set([
    ...GENERATION_WORKERS,
    ...ENTITLEMENT_WORKERS,
    ...DEVELOPER_AUTHORITY_WORKERS,
  ]);
  if (
    report.forwardRepairTargets.some(
      (target) => typeof target !== 'string' || !knownWorkers.has(target),
    )
  ) {
    throw new Error('Worker compatibility-floor recovery assessment contains an unknown target.');
  }
  return report.forwardRepairTargets
    .filter((target): target is string => typeof target === 'string')
    .join(',');
}

function isWorkerBoundaryResult(value: unknown): value is WorkerBoundaryResult {
  return (
    isRecord(value) &&
    typeof value.target === 'string' &&
    typeof value.status === 'string' &&
    isNullableString(value.currentMessage ?? null)
  );
}

function parseWorkerBoundaryVerification(value: unknown): WorkerBoundaryVerification {
  if (
    !isRecord(value) ||
    value.status !== 'verified' ||
    !Array.isArray(value.results) ||
    !value.results.every(isWorkerBoundaryResult)
  ) {
    throw new Error('The fresh Worker recovery boundary is missing or unverified.');
  }
  return { ...value, status: 'verified', results: value.results };
}

export function verifyWorkerFloorRecovery(
  checkpointDirectory: string,
  freshPayload: unknown,
  assessmentDirectory = checkpointDirectory,
  { isAncestor = gitIsAncestor }: { isAncestor?: AncestorCheck } = {},
): VerifiedWorkerFloorRecovery {
  const verificationPath = resolve(assessmentDirectory, FINAL_VERIFICATION_FILE);
  const verifiedAt = new Date().toISOString();
  try {
    const checkpoint = validateCheckpoint(readJson(resolve(checkpointDirectory, CHECKPOINT_FILE)));
    const freshFloors = parseWorkerFloorEvidence(freshPayload, 'Final Worker compatibility floors');
    validateFloorEvolution(checkpoint, freshFloors);
    const expectedAssessment = buildWorkerFloorRecoveryAssessment(
      checkpointDirectory,
      freshPayload,
      { isAncestor },
    );
    const assessment = readJson(resolve(assessmentDirectory, ASSESSMENT_FILE));
    const workerVerification = parseWorkerBoundaryVerification(
      readJson(resolve(assessmentDirectory, 'recovery-final-verification.json')),
    );
    const knownWorkers = new Set([
      ...GENERATION_WORKERS,
      ...ENTITLEMENT_WORKERS,
      ...DEVELOPER_AUTHORITY_WORKERS,
    ]);
    if (!isRecord(assessment)) {
      throw new Error('The Worker compatibility-floor assessment is missing, malformed, or stale.');
    }
    const forwardTargets = assessment.forwardRepairTargets;
    if (
      assessment?.schemaVersion !== SCHEMA_VERSION ||
      assessment.releaseTarget !== checkpoint.releaseTarget ||
      assessment.releaseGitSha !== checkpoint.releaseGitSha ||
      assessment.status !== expectedAssessment.status ||
      !isDeepStrictEqual(assessment.checkpointFloors, checkpoint.floors) ||
      !isDeepStrictEqual(assessment.currentFloors, freshFloors) ||
      !isDeepStrictEqual(assessment.results, expectedAssessment.results) ||
      !Array.isArray(forwardTargets) ||
      !isDeepStrictEqual(forwardTargets, expectedAssessment.forwardRepairTargets) ||
      new Set(forwardTargets).size !== forwardTargets.length ||
      forwardTargets.some((target) => !knownWorkers.has(target)) ||
      (forwardTargets.length === 0) !== (assessment.status === 'rollback-compatible')
    ) {
      throw new Error('The Worker compatibility-floor assessment is missing, malformed, or stale.');
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
    if (!isRecoveryStatus(assessment.status)) {
      throw new Error('The Worker compatibility-floor assessment is missing, malformed, or stale.');
    }
    const report: VerifiedWorkerFloorRecovery = {
      schemaVersion: 1,
      verifiedAt,
      status: 'verified',
      releaseTarget: checkpoint.releaseTarget,
      releaseGitSha: checkpoint.releaseGitSha,
      assessmentStatus: assessment.status,
      forwardRepairTargets: [...forwardTargets],
      freshFloors,
      workerBoundaryStatus: workerVerification.status,
    };
    writeJson(verificationPath, report);
    return report;
  } catch (error) {
    writeJson(verificationPath, {
      schemaVersion: 1,
      verifiedAt,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error('Final Worker compatibility-floor verification failed.', { cause: error });
  }
}

async function main(): Promise<void> {
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
      'Usage: node scripts/release-worker-floor-state.mts snapshot <release-target> <d1-json> <checkpoint-directory> | assess <checkpoint-directory> <current-d1-json> <output-directory> | targets <assessment-directory> | verify <checkpoint-directory> <fresh-d1-json> <assessment-directory>',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

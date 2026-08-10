export interface WorkerFloorEvidence {
  status: 'disabled' | 'ready';
  releaseSha: string | null;
  generationFloor: boolean;
  floorReleaseSha: string | null;
  entitlementFloor: boolean;
}

export interface WorkerFloorRecoveryReport {
  schemaVersion: 1;
  releaseTarget: string;
  releaseGitSha: string;
  status: 'rollback-compatible' | 'forward-repair-required';
  checkpointFloors: WorkerFloorEvidence;
  currentFloors: WorkerFloorEvidence;
  forwardRepairTargets: string[];
  results: Array<{
    target: string;
    floor: 'generation' | 'entitlement';
    status: 'baseline-compatible' | 'candidate-required';
    beforeGitSha: string | null;
  }>;
}

export const ENTITLEMENT_SUPPORT_RELEASE_SHA: 'a79d1624d2314942072622cc875da7c7332a9530';

export function parseWorkerFloorEvidence(payload: unknown, label?: string): WorkerFloorEvidence;

export function captureWorkerFloorCheckpoint(
  releaseTarget: string,
  payload: unknown,
  directory: string,
  options?: { isAncestor?: (baseSha: string, headSha: string) => boolean },
): {
  schemaVersion: 1;
  releaseTarget: string;
  releaseGitSha: string;
  floors: WorkerFloorEvidence;
  workers: unknown[];
};

export function assessWorkerFloorRecovery(
  checkpointDirectory: string,
  currentPayload: unknown,
  outputDirectory: string,
  options?: { isAncestor?: (baseSha: string, headSha: string) => boolean },
): WorkerFloorRecoveryReport;

export function readWorkerFloorForwardRepairTargets(directory: string): string;

export function verifyWorkerFloorRecovery(
  checkpointDirectory: string,
  freshPayload: unknown,
  assessmentDirectory?: string,
): {
  schemaVersion: 1;
  status: 'verified';
  releaseTarget: string;
  releaseGitSha: string;
  assessmentStatus: 'rollback-compatible' | 'forward-repair-required';
  forwardRepairTargets: string[];
  freshFloors: WorkerFloorEvidence;
  workerBoundaryStatus: 'verified';
};

export interface RealDeviceEvidenceInput {
  releaseSha: string;
  repository: string;
  testedAt: string;
  environmentUrl: string;
  evidenceUrl: string;
  tester: string;
  workflowActor: string;
  deviceMatrix: string;
  matrix: {
    standardRoom: true | 'true';
    proRoom: true | 'true';
    localAndRemoteMedia: true | 'true';
    youtubePlayback: true | 'true';
    systemAudio: true | 'true';
    backgroundResume: true | 'true';
    adaptivePowPerformance: true | 'true';
  };
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
  matrix: {
    standardRoom: true;
    proRoom: true;
    localAndRemoteMedia: true;
    youtubePlayback: true;
    systemAudio: true;
    backgroundResume: true;
    adaptivePowPerformance: true;
  };
  source: { workflow: 'real-device-qa.yml'; runId: number; runAttempt: number };
}

export function createRealDeviceEvidence(
  input: RealDeviceEvidenceInput,
  nowMs?: number,
): RealDeviceEvidence;
export function verifyRealDeviceEvidence(
  evidence: unknown,
  expected: {
    releaseSha: string;
    repository: string;
    runId: number | string;
    runAttempt: number | string;
  },
  nowMs?: number,
): RealDeviceEvidence;
export function selectLatestSuccessfulRun(
  payload: unknown,
  expected: { sha: string; event: string },
  excludedRunIds?: Set<number>,
): Record<string, unknown> | null;
export function selectExactArtifact(
  payload: unknown,
  expected: { prefix: string; sha: string; runId: number; runAttempt: number },
): Record<string, unknown> | null;

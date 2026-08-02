export const PRO_ROOM_GENERATION_CONTRACT_VERSION: 1;
export const RELEASE_SHA_RE: RegExp;

export function assertGenerationCutoverStatus(
  payload: unknown,
  expectedStatus: 'disabled' | 'ready',
  expectedReleaseSha?: string | null,
): {
  contractVersion: 1;
  status: 'disabled' | 'ready';
  releaseSha: string | null;
  floorReleaseSha: string;
  everEnabled: true;
  generationFloor: true;
};

export function generationCutoverWorkflowOutputs(payload: unknown): {
  floorReleaseSha: string;
  generationFloor: true;
};

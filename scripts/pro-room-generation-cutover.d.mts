export const PRO_ROOM_GENERATION_CONTRACT_VERSION: 1;
export const RELEASE_SHA_RE: RegExp;
export const INITIAL_DELETION_ROOM_CODES: readonly ['000002', '000003'];
export const INITIAL_DELETION_MINIMUM_AGE_MS: number;

export function assertGenerationSchemaVerification(
  label: string,
  payload: unknown,
): { label: string; schemaReady: true };

export function generationMigrationState(
  label: string,
  payload: unknown,
): 'legacy' | 'partial' | 'ready';

export function renderForwardCompletionSql(
  database: 'admin' | 'auth' | 'developer',
  statePayload: unknown,
  sourceSql: string,
): string;

export function assertGenerationCutoverStatus(
  payload: unknown,
  expectedStatus: 'disabled' | 'ready',
  expectedReleaseSha?: string | null,
): {
  contractVersion: 1;
  status: 'disabled' | 'ready';
  releaseSha: string | null;
  floorReleaseSha: string | null;
  everEnabled: boolean;
  generationFloor: boolean;
};

export function generationCutoverWorkflowOutputs(payload: unknown): {
  wasReady: boolean;
  everEnabled: boolean;
  generationFloor: boolean;
  floorReleaseSha: string | null;
};

export function assertInitialDeletionEvidence(
  adminPayload: unknown,
  developerPayload: unknown,
  publicPayload: unknown,
): {
  ok: true;
  roomCodes: string[];
  minimumCompletionAgeMs: number;
};

export function probePublicDeletionEvidence(
  baseUrl?: string,
  fetchImpl?: typeof fetch,
): Promise<{
  checkedAt: number;
  rooms: Array<{
    roomCode: string;
    status: number;
    error: string | null;
  }>;
}>;

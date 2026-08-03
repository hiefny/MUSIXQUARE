export const PRO_ROOM_READINESS_RETRY_DELAYS_MS: readonly number[];
export const PRO_ROOM_HEALTH_REQUEST_TIMEOUT_MS: number;
export function verifyProRoomPublicBoundary(dependencies?: {
  read?: (path: string) => Promise<{
    status: number;
    payload: {
      roomCode?: string;
      status?: string;
      error?: string;
      [key: string]: unknown;
    };
  }>;
  retryDelaysMs?: readonly number[];
  wait?: (milliseconds: number) => Promise<unknown>;
  log?: (message: string) => void;
}): Promise<{
  roomCode: string;
  roomStatus: string;
  pinRoomCode: string;
  pinRoomStatus: string;
  anonymousSnapshotRejected: true;
}>;
export function main(): Promise<void>;
export function waitForProRoomReady(
  expectedVersion: string,
  dependencies?: {
    read?: () => Promise<{ service?: string; workerVersionId?: string }>;
    retryDelaysMs?: readonly number[];
    wait?: (milliseconds: number) => Promise<unknown>;
    log?: (message: string) => void;
  },
): Promise<{ service?: string; expectedVersion: string | null; actualVersion: string | null }>;

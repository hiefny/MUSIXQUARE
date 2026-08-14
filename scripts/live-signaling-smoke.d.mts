export const STALE_VERSION_RETRY_DELAYS_MS: readonly number[];
export class StaleSignalingVersionError extends Error {
  constructor(expectedVersion: string, actualVersion: string | null);
  expectedVersion: string;
  actualVersion: string | null;
}
export class InitialHostDeploymentConvergenceError extends Error {
  constructor(statusCode: number);
  statusCode: number;
}
export class InitialHostSocketConvergenceError extends Error {
  constructor(closeCode: number);
  closeCode: number;
}
export function initialHostHandshakeError(
  statusCode: number | undefined,
  expectedVersion: string,
  label: string,
): Error;
export function initialHostSocketCloseError(
  closeCode: number,
  closeReason: string,
  expectedVersion: string,
  receivedFrame: boolean,
  label: string,
): Error;
export function initialHostSocketError(
  error: Error,
  expectedVersion: string,
  receivedFrame: boolean,
): Error | null;
export function createSocketInbox(
  url: string,
  label: string,
  options?: {
    expectedInitialHostVersion?: string;
    createWebSocket?: (url: string, options: { origin: string }) => any;
  },
): {
  socket: any;
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
    description: string,
  ): Promise<Record<string, unknown>>;
};
export function settleUnexpectedInitialHostResponse(
  socket: { terminate(): unknown },
  response: { statusCode?: number; resume(): unknown },
  expectedVersion: string,
  label: string,
): Error;
export function assertPeerOpenVersion(
  message: { workerVersionId?: unknown } | null | undefined,
  expectedVersion: string,
  label: string,
  retryIfStale?: boolean,
): void;
export function withSignalingReadinessRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options?: {
    retryDelaysMs?: readonly number[];
    wait?: (milliseconds: number) => Promise<unknown>;
    onRetry?: (event: {
      error:
        | StaleSignalingVersionError
        | InitialHostDeploymentConvergenceError
        | InitialHostSocketConvergenceError;
      attempt: number;
      delayMs: number;
    }) => void;
  },
): Promise<T>;
export function main(): Promise<void>;

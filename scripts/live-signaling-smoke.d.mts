export const STALE_VERSION_RETRY_DELAYS_MS: readonly number[];
export class StaleSignalingVersionError extends Error {
  constructor(expectedVersion: string, actualVersion: string | null);
  expectedVersion: string;
  actualVersion: string | null;
}
export function classifyHostSocketOpenError(error: unknown, expectedVersion: string): unknown;
export function assertPeerOpenVersion(
  message: { workerVersionId?: unknown } | null | undefined,
  expectedVersion: string,
  label: string,
  retryIfStale?: boolean,
): void;
export function withStaleVersionRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options?: {
    retryDelaysMs?: readonly number[];
    wait?: (milliseconds: number) => Promise<unknown>;
    onRetry?: (event: {
      error: StaleSignalingVersionError;
      attempt: number;
      delayMs: number;
    }) => void;
  },
): Promise<T>;
export function main(): Promise<void>;

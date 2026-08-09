declare const appWorker: {
  fetch(request: Request, env: unknown, context?: unknown): Promise<Response>;
  scheduled(
    event: unknown,
    env: unknown,
    context: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void>;
};

export function sanitizeSoroArticleHtmlForTests(html: string): string;
export function readResponseBodyLimitedForTests(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array>;
export function fetchAndConsumeWithTimeout<T>(
  resource: RequestInfo | URL,
  options: RequestInit,
  timeoutMs: number,
  consume: (response: Response, signal: AbortSignal) => T | Promise<T>,
): Promise<T>;
export function reconcileStaleAdminProRoomActivationsForTests(
  env: Record<string, unknown>,
  db: unknown,
  rooms: Array<{
    roomCode: string;
    roomGeneration: number;
    status: string;
    activationState: string;
    updatedAt: number;
  }>,
  nowMs?: number,
): Promise<boolean>;
export function purgeProRoomAccountAuthorityForTests(
  input: {
    accountId: string;
    roomCode: string;
    roomGeneration: number;
  },
  env: Record<string, unknown>,
): Promise<boolean>;
export function reconcileOwnerTransferSagasForTests(
  env: Record<string, unknown>,
  db: unknown,
  nowMs?: number,
): Promise<number>;
export function retireDecommissionedAccountProRoomEdgesForTests(
  env: Record<string, unknown>,
  options?: { sinceMs?: number | null },
): Promise<{
  configured: boolean;
  retired: boolean;
  entitlementsRevoked?: boolean;
}>;
export function cleanupExpiredProRoomAdminAuditForTests(
  env: Record<string, unknown>,
  nowMs?: number,
): Promise<'unconfigured' | 'cleaned' | 'failed'>;
export default appWorker;

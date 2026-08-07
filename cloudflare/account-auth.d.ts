export interface ResolvedAccountSession {
  accountId: string;
  nickname: string | null;
  profileComplete: boolean;
}

export interface AccountDeletionIntegrations {
  purgeProRoomAccountAuthority?: (input: {
    accountId: string;
    roomCode: string;
    roomGeneration: number;
  }) => Promise<unknown>;
  orphanAccountProGrants?: (accountId: string) => Promise<boolean>;
  deferAccountDeletion?: (accountId: string) => unknown;
}

export interface AccountProRoomIncarnation {
  roomCode: string;
  roomGeneration: number;
}

export interface AccountDeletionCleanupResult {
  configured: boolean;
  processedAccounts: number;
  purgedEdges: number;
  failedEdges: number;
  completedAccounts: number;
  pendingAccounts: number;
}

export function resolveAccountSession(
  request: Request,
  env: unknown,
): Promise<ResolvedAccountSession | null>;
export function handleAccountAuthRequest(
  request: Request,
  env: unknown,
  url?: URL,
  integrations?: AccountDeletionIntegrations,
): Promise<Response | null>;
export function recordAccountProRoomLink(
  env: unknown,
  accountId: string,
  roomCode: string,
  nowMs: number,
  roomGeneration: number,
): Promise<boolean>;
export function retireAccountProRoomLinks(
  env: unknown,
  roomCode: string,
  roomGeneration: number,
): Promise<{ configured: boolean; retired: boolean }>;
export function retireAccountProRoomLinkBatch(
  env: unknown,
  incarnations: readonly AccountProRoomIncarnation[],
): Promise<{ configured: boolean; retired: boolean }>;
export function cleanupPendingAccountDeletions(
  env: unknown,
  integrations?: AccountDeletionIntegrations,
  options?: { accountId?: string; edgeLimit?: number },
): Promise<AccountDeletionCleanupResult>;
export function cleanupExpiredAccountSessions(
  env: unknown,
  nowMs?: number,
): Promise<{ sessions: number; deletedSessions: number; flows: number }>;
export function resetAccountAuthCachesForTests(): void;

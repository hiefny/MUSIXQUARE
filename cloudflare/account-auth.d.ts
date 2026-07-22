export interface ResolvedAccountSession {
  accountId: string;
  nickname: string | null;
  profileComplete: boolean;
}

export interface AccountDeletionIntegrations {
  purgeProRoomAccountAuthority?: (input: {
    accountId: string;
    roomCode: string;
  }) => Promise<unknown>;
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
  nowMs?: number,
): Promise<boolean>;
export function cleanupExpiredAccountSessions(
  env: unknown,
  nowMs?: number,
): Promise<{ sessions: number; deletedSessions: number; flows: number }>;
export function resetAccountAuthCachesForTests(): void;

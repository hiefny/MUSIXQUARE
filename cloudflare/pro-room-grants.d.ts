export interface ProGrantActivationIdentity {
  accountId: string;
  roomCode: string;
  roomGeneration: number;
  nowMs?: number;
}

export interface ProRoomOwnershipTransferEntitlementIdentity {
  targetAccountId: string;
  roomCode: string;
  roomGeneration: number;
  requestId: string;
  nowMs?: number;
}

export interface ProRoomOwnerEntitlementIdentity extends ProGrantActivationIdentity {
  status: 'active' | 'suspended';
  sourceRef: string;
}

export interface ProRoomEntitlementRevocationIdentity {
  accountId?: string;
  roomCode: string;
  roomGeneration: number;
  nowMs?: number;
}

export interface ProGrantDependencies {
  resolveAccountSession?: (request: Request, env: unknown) => Promise<unknown>;
  hasLegacyProRoomLink?: (accountId: string) => Promise<boolean>;
  inspectRoom?: (roomCode: string, roomGeneration: number) => Promise<unknown>;
  preflightVoucherRoom?: (roomCode: string) => Promise<unknown>;
  issueActivationHandoff?: (input: {
    accountId: string;
    roomCode: string;
    roomGeneration: number;
    grantId: string;
    redemptionId: string;
  }) => Promise<unknown>;
  isAccountActive?: (accountId: string) => Promise<boolean>;
  verifyOwnerEntitlementBackfill?: () => Promise<boolean>;
}

export interface ProGrantReconciliationResult {
  configured: boolean;
  checked: number;
  finalized: number;
  orphaned: number;
}

export function finalizeProGrantActivation(
  env: unknown,
  input: ProGrantActivationIdentity,
): Promise<boolean>;

export function reserveProRoomActivationEntitlement(
  env: unknown,
  input: ProGrantActivationIdentity,
): Promise<boolean>;

export function canAccountReceiveProRoomEntitlement(
  env: unknown,
  input: Pick<ProGrantActivationIdentity, 'accountId'>,
): Promise<boolean>;

export function markProRoomOwnerEntitlementBackfillComplete(
  env: unknown,
  nowMs?: number,
): Promise<boolean>;

export function finalizeProRoomActivationEntitlement(
  env: unknown,
  input: ProGrantActivationIdentity,
): Promise<boolean>;

export function reserveProRoomOwnershipTransferEntitlement(
  env: unknown,
  input: ProRoomOwnershipTransferEntitlementIdentity,
): Promise<boolean>;

export function finalizeProRoomOwnershipTransferEntitlement(
  env: unknown,
  input: ProRoomOwnershipTransferEntitlementIdentity,
): Promise<boolean>;

export function abortProRoomOwnershipTransferEntitlement(
  env: unknown,
  input: ProRoomOwnershipTransferEntitlementIdentity,
): Promise<boolean>;

export function revokeProRoomEntitlement(
  env: unknown,
  input: ProRoomEntitlementRevocationIdentity,
): Promise<boolean>;

export function upsertProRoomOwnerEntitlement(
  env: unknown,
  input: ProRoomOwnerEntitlementIdentity,
): Promise<boolean>;

export function orphanAccountProGrants(
  env: unknown,
  accountId: string,
  nowMs?: number,
): Promise<boolean>;

export function reconcileProGrantLifecycle(
  env: unknown,
  dependencies: ProGrantDependencies,
  options?: { limit?: number },
): Promise<ProGrantReconciliationResult>;

export function hasReservedProGrantAllocation(
  env: unknown,
  roomCode: string,
  roomGeneration: number,
): Promise<boolean>;

export function authorizeProGrantActivation(
  env: unknown,
  input: Pick<ProGrantActivationIdentity, 'accountId' | 'roomCode' | 'roomGeneration'>,
): Promise<boolean>;

export function handleProGrantPublicRequest(
  request: Request,
  env: unknown,
  url: URL,
  dependencies: ProGrantDependencies,
): Promise<Response | null>;

export function handleProGrantAdminRequest(
  request: Request,
  env: unknown,
  url: URL,
  dependencies: ProGrantDependencies,
): Promise<Response | null>;

export const PRO_GRANT_ACTIVE_STATES: readonly string[];

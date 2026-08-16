export const PRO_ROOM_ACTIVATION_CLAIM_MAX_LIFETIME_MS: number;
export const PRO_ROOM_OWNER_RECOVERY_CLAIM_DEFAULT_LIFETIME_MS: number;
export const PRO_ROOM_OWNER_RECOVERY_CLAIM_MAX_LIFETIME_MS: number;
export const PRO_ROOM_OWNER_TRANSFER_CLAIM_DEFAULT_LIFETIME_MS: number;
export const PRO_ROOM_OWNER_TRANSFER_CLAIM_MAX_LIFETIME_MS: number;
export const PRO_ROOM_OWNER_TRANSFER_REVOCATION_RECEIPT_MAX_LIFETIME_MS: number;

export interface ProRoomActivationClaimOptions {
  nowMs?: number;
  expiresAtMs?: number;
  generation?: number;
  roomGeneration?: number;
  targetAccountId?: string;
  nonce?: string;
}

export interface ProRoomActivationClaimPayload {
  v: 1;
  purpose: 'pro-room-activation';
  roomCode: string;
  iat: number;
  exp: number;
  nonce: string;
  generation: number;
  roomGeneration: number;
  targetAccountId?: string;
}

export interface ProRoomOwnerRecoveryClaimOptions {
  nowMs?: number;
  expiresAtMs?: number;
  roomGeneration?: number;
  nonce?: string;
  ownerAuthorityEpoch?: number;
}

export interface ProRoomOwnerRecoveryClaimPayload {
  v: 1;
  purpose: 'pro-room-owner-recovery';
  roomCode: string;
  iat: number;
  exp: number;
  nonce: string;
  ownerAuthorityEpoch: number;
  roomGeneration: number;
}

export interface ProRoomOwnerTransferClaimOptions {
  nowMs?: number;
  expiresAtMs?: number;
  roomGeneration?: number;
  nonce?: string;
  targetAccountId: string;
  claimGeneration: number;
  ownerAuthorityEpoch: number;
}

export interface ProRoomOwnerTransferClaimPayload {
  v: 1;
  purpose: 'pro-room-owner-transfer';
  roomCode: string;
  roomGeneration: number;
  targetAccountId: string;
  claimGeneration: number;
  ownerAuthorityEpoch: number;
  iat: number;
  exp: number;
  nonce: string;
}

export interface ProRoomOwnerTransferClaimInspection {
  error?: 'OWNER_TRANSFER_CLAIM_INVALID';
  claim?: ProRoomOwnerTransferClaimPayload;
  expired?: boolean;
}

export interface ProRoomOwnerTransferCommitProofRoom {
  roomCode: string;
  roomGeneration: number;
}

export interface ProRoomOwnerTransferCommitProofPending {
  transferId: string;
  requestId: string;
  targetAccountId: string;
  ownerAuthorityEpoch: number;
  preparedAtMs: number;
}

export interface ProRoomOwnerTransferRevocationIdentity {
  roomCode: string;
  roomGeneration: number;
  transferId: string;
  targetAccountId: string;
  requestId: string;
}

export interface ProRoomOwnerTransferRevocationReceiptOptions {
  revokedAtMs?: number;
  expiresAtMs?: number;
}

export interface ProRoomOwnerTransferRevocationReceiptPayload extends ProRoomOwnerTransferRevocationIdentity {
  purpose: 'pro-room-owner-transfer-revocation';
  revokedAtMs: number;
  expiresAtMs: number;
}

export function issueProRoomActivationClaim(
  roomCode: string,
  secret: string,
  options?: ProRoomActivationClaimOptions,
): Promise<string>;

export function verifyProRoomActivationClaim(
  token: string,
  roomCode: string,
  secret: string,
  nowMs: number,
): Promise<ProRoomActivationClaimPayload | null>;

export function issueProRoomOwnerRecoveryClaim(
  roomCode: string,
  secret: string,
  options?: ProRoomOwnerRecoveryClaimOptions,
): Promise<string>;

export function verifyProRoomOwnerRecoveryClaim(
  token: string,
  roomCode: string,
  secret: string,
  nowMs: number,
): Promise<ProRoomOwnerRecoveryClaimPayload | null>;

export function issueProRoomOwnerTransferClaim(
  roomCode: string,
  secret: string,
  options: ProRoomOwnerTransferClaimOptions,
): Promise<string>;

export function inspectProRoomOwnerTransferClaim(
  token: string,
  roomCode: string,
  secret: string,
  nowMs: number,
): Promise<ProRoomOwnerTransferClaimInspection>;

export function createProRoomOwnerTransferCommitProof(
  room: ProRoomOwnerTransferCommitProofRoom,
  pending: ProRoomOwnerTransferCommitProofPending,
  secret: string,
): Promise<string>;

export function issueProRoomOwnerTransferRevocationReceipt(
  expected: ProRoomOwnerTransferRevocationIdentity,
  secret: string,
  options?: ProRoomOwnerTransferRevocationReceiptOptions,
): Promise<string>;

export function verifyProRoomOwnerTransferRevocationReceipt(
  token: string,
  expected: ProRoomOwnerTransferRevocationIdentity,
  secret: string,
  nowMs: number,
): Promise<ProRoomOwnerTransferRevocationReceiptPayload | null>;

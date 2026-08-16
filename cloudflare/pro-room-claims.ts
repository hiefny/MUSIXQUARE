import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  createSignedToken,
  hmacBase64Url,
  randomToken,
  verifySignedToken,
} from './pro-room-crypto.ts';
import { INITIAL_PRO_ROOM_GENERATION, isProRoomGeneration } from './pro-room-generation.ts';
import { hasExactKeys, isSafeNonNegativeInteger } from './pro-room-validation.ts';

export const PRO_ROOM_ACTIVATION_CLAIM_MAX_LIFETIME_MS = 15 * 60 * 1000;
export const PRO_ROOM_OWNER_RECOVERY_CLAIM_DEFAULT_LIFETIME_MS = 10 * 60 * 1000;
export const PRO_ROOM_OWNER_RECOVERY_CLAIM_MAX_LIFETIME_MS = 15 * 60 * 1000;
export const PRO_ROOM_OWNER_TRANSFER_CLAIM_DEFAULT_LIFETIME_MS = 10 * 60 * 1000;
export const PRO_ROOM_OWNER_TRANSFER_CLAIM_MAX_LIFETIME_MS = 15 * 60 * 1000;
export const PRO_ROOM_OWNER_TRANSFER_REVOCATION_RECEIPT_MAX_LIFETIME_MS = 15 * 60 * 1000;

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

const PRO_ROOM_CODE_RE = /^0\d{5}$/;
const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{22}$/;
const OWNER_TRANSFER_ID_RE = /^transfer_[A-Za-z0-9_-]{22}$/;
const OWNER_TRANSFER_REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CLAIM_NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function isProRoomCode(value: unknown): value is string {
  return typeof value === 'string' && PRO_ROOM_CODE_RE.test(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isValidActivationClaim(
  claim: Record<string, unknown>,
  roomCode: string,
  nowMs: number,
): claim is Record<string, unknown> & ProRoomActivationClaimPayload {
  return (
    claim.v === 1 &&
    claim.purpose === 'pro-room-activation' &&
    claim.roomCode === roomCode &&
    isSafeInteger(claim.iat) &&
    claim.iat <= nowMs + 60_000 &&
    isSafeInteger(claim.exp) &&
    claim.exp > nowMs &&
    claim.exp - claim.iat <= PRO_ROOM_ACTIVATION_CLAIM_MAX_LIFETIME_MS &&
    typeof claim.nonce === 'string' &&
    claim.nonce.length >= 16 &&
    isSafeInteger(claim.generation) &&
    claim.generation >= 0 &&
    isProRoomGeneration(claim.roomGeneration) &&
    (claim.targetAccountId === undefined ||
      (typeof claim.targetAccountId === 'string' && ACCOUNT_ID_RE.test(claim.targetAccountId)))
  );
}

function isValidOwnerRecoveryClaim(
  payload: unknown,
  roomCode: string,
  nowMs: number,
): payload is Record<string, unknown> & ProRoomOwnerRecoveryClaimPayload {
  return (
    hasExactKeys(payload, [
      'v',
      'purpose',
      'roomCode',
      'iat',
      'exp',
      'nonce',
      'ownerAuthorityEpoch',
      'roomGeneration',
    ]) &&
    payload.v === 1 &&
    payload.purpose === 'pro-room-owner-recovery' &&
    payload.roomCode === roomCode &&
    isSafeInteger(payload.iat) &&
    payload.iat <= nowMs + 60_000 &&
    isSafeInteger(payload.exp) &&
    payload.exp > nowMs &&
    payload.exp - payload.iat <= PRO_ROOM_OWNER_RECOVERY_CLAIM_MAX_LIFETIME_MS &&
    isProRoomGeneration(payload.roomGeneration) &&
    isSafeNonNegativeInteger(payload.ownerAuthorityEpoch) &&
    typeof payload.nonce === 'string' &&
    CLAIM_NONCE_RE.test(payload.nonce)
  );
}

function isValidOwnerTransferClaim(
  payload: unknown,
  roomCode: string,
  nowMs: number,
): payload is Record<string, unknown> & ProRoomOwnerTransferClaimPayload {
  return (
    hasExactKeys(payload, [
      'v',
      'purpose',
      'roomCode',
      'roomGeneration',
      'targetAccountId',
      'claimGeneration',
      'ownerAuthorityEpoch',
      'iat',
      'exp',
      'nonce',
    ]) &&
    payload.v === 1 &&
    payload.purpose === 'pro-room-owner-transfer' &&
    payload.roomCode === roomCode &&
    isProRoomGeneration(payload.roomGeneration) &&
    typeof payload.targetAccountId === 'string' &&
    ACCOUNT_ID_RE.test(payload.targetAccountId) &&
    isSafeNonNegativeInteger(payload.claimGeneration) &&
    isSafeNonNegativeInteger(payload.ownerAuthorityEpoch) &&
    isSafeInteger(payload.iat) &&
    payload.iat <= nowMs + 60_000 &&
    isSafeInteger(payload.exp) &&
    payload.exp > payload.iat &&
    payload.exp - payload.iat <= PRO_ROOM_OWNER_TRANSFER_CLAIM_MAX_LIFETIME_MS &&
    typeof payload.nonce === 'string' &&
    CLAIM_NONCE_RE.test(payload.nonce)
  );
}

function isValidOwnerTransferRevocationReceipt(
  payload: unknown,
  expected: ProRoomOwnerTransferRevocationIdentity,
  nowMs: number,
): payload is Record<string, unknown> & ProRoomOwnerTransferRevocationReceiptPayload {
  return (
    hasExactKeys(payload, [
      'purpose',
      'roomCode',
      'roomGeneration',
      'transferId',
      'targetAccountId',
      'requestId',
      'revokedAtMs',
      'expiresAtMs',
    ]) &&
    payload.purpose === 'pro-room-owner-transfer-revocation' &&
    payload.roomCode === expected.roomCode &&
    payload.roomGeneration === expected.roomGeneration &&
    payload.transferId === expected.transferId &&
    payload.targetAccountId === expected.targetAccountId &&
    payload.requestId === expected.requestId &&
    isSafeInteger(payload.revokedAtMs) &&
    payload.revokedAtMs <= nowMs + 60_000 &&
    isSafeInteger(payload.expiresAtMs) &&
    payload.expiresAtMs > nowMs &&
    payload.expiresAtMs > payload.revokedAtMs &&
    payload.expiresAtMs - payload.revokedAtMs <=
      PRO_ROOM_OWNER_TRANSFER_REVOCATION_RECEIPT_MAX_LIFETIME_MS
  );
}

function assertClaimIssuerInputs(roomCode: unknown, secret: unknown): asserts roomCode is string {
  if (!isProRoomCode(roomCode)) throw new Error('Unsupported PRO room code');
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Activation secret too short');
  }
}

function claimNonce(value: unknown): string {
  const nonce = value ?? randomToken(18);
  if (typeof nonce !== 'string' || !CLAIM_NONCE_RE.test(nonce)) {
    throw new Error('Invalid nonce');
  }
  return nonce;
}

function claimExpiry(
  nowMs: number,
  expiresAtMs: number | undefined,
  defaultLifetimeMs: number,
  maxLifetimeMs: number,
): number {
  const expiry = expiresAtMs ?? nowMs + defaultLifetimeMs;
  if (!Number.isSafeInteger(expiry) || expiry <= nowMs || expiry - nowMs > maxLifetimeMs) {
    throw new Error('Invalid expiry');
  }
  return expiry;
}

/** Owner-claim issuer used by the offline CLI and the Access-gated admin API. */
export async function issueProRoomActivationClaim(
  roomCode: string,
  secret: string,
  options: ProRoomActivationClaimOptions = {},
): Promise<string> {
  assertClaimIssuerInputs(roomCode, secret);
  const nowMs = options.nowMs ?? Date.now();
  const expiresAtMs = claimExpiry(
    nowMs,
    options.expiresAtMs,
    PRO_ROOM_ACTIVATION_CLAIM_MAX_LIFETIME_MS,
    PRO_ROOM_ACTIVATION_CLAIM_MAX_LIFETIME_MS,
  );
  const generation = options.generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid generation');
  const roomGeneration = options.roomGeneration ?? INITIAL_PRO_ROOM_GENERATION;
  if (!isProRoomGeneration(roomGeneration)) throw new Error('Invalid room generation');
  const targetAccountId = options.targetAccountId ?? null;
  if (targetAccountId !== null && !ACCOUNT_ID_RE.test(targetAccountId)) {
    throw new Error('Invalid target account');
  }
  const nonce = claimNonce(options.nonce);
  return createSignedToken(
    {
      v: 1,
      purpose: 'pro-room-activation',
      roomCode,
      iat: nowMs,
      exp: expiresAtMs,
      nonce,
      generation,
      roomGeneration,
      ...(targetAccountId === null ? {} : { targetAccountId }),
    },
    secret,
  );
}

export async function verifyProRoomActivationClaim(
  token: string,
  roomCode: string,
  secret: string,
  nowMs: number,
): Promise<ProRoomActivationClaimPayload | null> {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const payload = await verifySignedToken(token, secret);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const claim = payload as Record<string, unknown>;
  return isValidActivationClaim(claim, roomCode, nowMs) ? claim : null;
}

export async function issueProRoomOwnerRecoveryClaim(
  roomCode: string,
  secret: string,
  options: ProRoomOwnerRecoveryClaimOptions = {},
): Promise<string> {
  assertClaimIssuerInputs(roomCode, secret);
  const nowMs = options.nowMs ?? Date.now();
  const expiresAtMs = claimExpiry(
    nowMs,
    options.expiresAtMs,
    PRO_ROOM_OWNER_RECOVERY_CLAIM_DEFAULT_LIFETIME_MS,
    PRO_ROOM_OWNER_RECOVERY_CLAIM_MAX_LIFETIME_MS,
  );
  const nonce = claimNonce(options.nonce);
  const roomGeneration = options.roomGeneration ?? INITIAL_PRO_ROOM_GENERATION;
  // The legacy offline helper can only describe the first activated owner
  // incarnation. Runtime issuance always supplies the current durable fence.
  const ownerAuthorityEpoch = options.ownerAuthorityEpoch ?? 1;
  if (!isProRoomGeneration(roomGeneration)) throw new Error('Invalid room generation');
  if (!isSafeNonNegativeInteger(ownerAuthorityEpoch)) {
    throw new Error('Invalid owner authority epoch');
  }
  return createSignedToken(
    {
      v: 1,
      purpose: 'pro-room-owner-recovery',
      roomCode,
      iat: nowMs,
      exp: expiresAtMs,
      nonce,
      ownerAuthorityEpoch,
      roomGeneration,
    },
    secret,
  );
}

export async function verifyProRoomOwnerRecoveryClaim(
  token: string,
  roomCode: string,
  secret: string,
  nowMs: number,
): Promise<ProRoomOwnerRecoveryClaimPayload | null> {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const payload = await verifySignedToken(token, secret);
  return isValidOwnerRecoveryClaim(payload, roomCode, nowMs) ? payload : null;
}

export async function issueProRoomOwnerTransferClaim(
  roomCode: string,
  secret: string,
  options: ProRoomOwnerTransferClaimOptions,
): Promise<string> {
  assertClaimIssuerInputs(roomCode, secret);
  if (!ACCOUNT_ID_RE.test(options.targetAccountId || '')) {
    throw new Error('Invalid target account');
  }
  if (!isSafeNonNegativeInteger(options.claimGeneration)) {
    throw new Error('Invalid claim generation');
  }
  if (!isSafeNonNegativeInteger(options.ownerAuthorityEpoch)) {
    throw new Error('Invalid owner authority epoch');
  }
  const roomGeneration = options.roomGeneration ?? INITIAL_PRO_ROOM_GENERATION;
  if (!isProRoomGeneration(roomGeneration)) throw new Error('Invalid room generation');
  const nowMs = options.nowMs ?? Date.now();
  const expiresAtMs = claimExpiry(
    nowMs,
    options.expiresAtMs,
    PRO_ROOM_OWNER_TRANSFER_CLAIM_DEFAULT_LIFETIME_MS,
    PRO_ROOM_OWNER_TRANSFER_CLAIM_MAX_LIFETIME_MS,
  );
  const nonce = claimNonce(options.nonce);
  return createSignedToken(
    {
      v: 1,
      purpose: 'pro-room-owner-transfer',
      roomCode,
      roomGeneration,
      targetAccountId: options.targetAccountId,
      claimGeneration: options.claimGeneration,
      ownerAuthorityEpoch: options.ownerAuthorityEpoch,
      iat: nowMs,
      exp: expiresAtMs,
      nonce,
    },
    secret,
  );
}

export async function inspectProRoomOwnerTransferClaim(
  token: string,
  roomCode: string,
  secret: string,
  nowMs: number,
): Promise<ProRoomOwnerTransferClaimInspection> {
  if (typeof secret !== 'string' || secret.length < 32) {
    return { error: 'OWNER_TRANSFER_CLAIM_INVALID' };
  }
  const payload = await verifySignedToken(token, secret);
  if (!isValidOwnerTransferClaim(payload, roomCode, nowMs)) {
    return { error: 'OWNER_TRANSFER_CLAIM_INVALID' };
  }
  return {
    claim: payload,
    expired: payload.exp <= nowMs,
  };
}

export async function createProRoomOwnerTransferCommitProof(
  room: ProRoomOwnerTransferCommitProofRoom,
  pending: ProRoomOwnerTransferCommitProofPending,
  secret: string,
): Promise<string> {
  return createSignedToken(
    {
      v: 1,
      purpose: 'pro-room-owner-transfer-commit',
      roomCode: room.roomCode,
      roomGeneration: room.roomGeneration,
      transferId: pending.transferId,
      requestId: pending.requestId,
      targetAccountId: pending.targetAccountId,
      ownerAuthorityEpoch: pending.ownerAuthorityEpoch,
      preparedAtMs: pending.preparedAtMs,
    },
    secret,
  );
}

export async function verifyProRoomOwnerTransferCommitProof(
  token: unknown,
  room: ProRoomOwnerTransferCommitProofRoom,
  pending: ProRoomOwnerTransferCommitProofPending,
  secret: string,
): Promise<boolean> {
  return constantTimeEqual(
    token,
    await createProRoomOwnerTransferCommitProof(room, pending, secret),
  );
}

export async function issueProRoomOwnerTransferRevocationReceipt(
  expected: ProRoomOwnerTransferRevocationIdentity,
  secret: string,
  options: ProRoomOwnerTransferRevocationReceiptOptions = {},
): Promise<string> {
  assertClaimIssuerInputs(expected?.roomCode, secret);
  if (
    !isProRoomGeneration(expected.roomGeneration) ||
    !OWNER_TRANSFER_ID_RE.test(expected.transferId || '') ||
    !ACCOUNT_ID_RE.test(expected.targetAccountId || '') ||
    !OWNER_TRANSFER_REQUEST_ID_RE.test(expected.requestId || '')
  ) {
    throw new Error('Invalid owner transfer revocation receipt');
  }
  const revokedAtMs = options.revokedAtMs ?? Date.now();
  const expiresAtMs = claimExpiry(
    revokedAtMs,
    options.expiresAtMs,
    PRO_ROOM_OWNER_TRANSFER_REVOCATION_RECEIPT_MAX_LIFETIME_MS,
    PRO_ROOM_OWNER_TRANSFER_REVOCATION_RECEIPT_MAX_LIFETIME_MS,
  );
  const payloadPart = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        purpose: 'pro-room-owner-transfer-revocation',
        roomCode: expected.roomCode,
        roomGeneration: expected.roomGeneration,
        transferId: expected.transferId,
        targetAccountId: expected.targetAccountId,
        requestId: expected.requestId,
        revokedAtMs,
        expiresAtMs,
      }),
    ),
  );
  const signature = await hmacBase64Url(secret, `owner-transfer-revocation:v1\u0000${payloadPart}`);
  return `v1.${payloadPart}.${signature}`;
}

export async function verifyProRoomOwnerTransferRevocationReceipt(
  token: string,
  expected: ProRoomOwnerTransferRevocationIdentity,
  secret: string,
  nowMs: number,
): Promise<ProRoomOwnerTransferRevocationReceiptPayload | null> {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret.length < 32) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
    const expectedMac = await hmacBase64Url(
      secret,
      `owner-transfer-revocation:v1\u0000${parts[1]}`,
    );
    if (!constantTimeEqual(expectedMac, parts[2])) return null;
    const payload: unknown = JSON.parse(decoder.decode(base64UrlDecode(parts[1])));
    return isValidOwnerTransferRevocationReceipt(payload, expected, nowMs) ? payload : null;
  } catch {
    return null;
  }
}

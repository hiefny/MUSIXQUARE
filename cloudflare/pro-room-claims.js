import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  createSignedToken,
  hmacBase64Url,
  randomToken,
  verifySignedToken,
} from './pro-room-crypto.js';
import { INITIAL_PRO_ROOM_GENERATION, isProRoomGeneration } from './pro-room-generation.js';
import { hasExactKeys, isSafeNonNegativeInteger } from './pro-room-validation.js';

export const PRO_ROOM_ACTIVATION_CLAIM_MAX_LIFETIME_MS = 15 * 60 * 1000;
export const PRO_ROOM_OWNER_RECOVERY_CLAIM_DEFAULT_LIFETIME_MS = 10 * 60 * 1000;
export const PRO_ROOM_OWNER_RECOVERY_CLAIM_MAX_LIFETIME_MS = 15 * 60 * 1000;
export const PRO_ROOM_OWNER_TRANSFER_CLAIM_DEFAULT_LIFETIME_MS = 10 * 60 * 1000;
export const PRO_ROOM_OWNER_TRANSFER_CLAIM_MAX_LIFETIME_MS = 15 * 60 * 1000;
export const PRO_ROOM_OWNER_TRANSFER_REVOCATION_RECEIPT_MAX_LIFETIME_MS = 15 * 60 * 1000;

const PRO_ROOM_CODE_RE = /^0\d{5}$/;
const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{22}$/;
const OWNER_TRANSFER_ID_RE = /^transfer_[A-Za-z0-9_-]{22}$/;
const OWNER_TRANSFER_REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CLAIM_NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function isProRoomCode(value) {
  return typeof value === 'string' && PRO_ROOM_CODE_RE.test(value);
}

function assertClaimIssuerInputs(roomCode, secret) {
  if (!isProRoomCode(roomCode)) throw new Error('Unsupported PRO room code');
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Activation secret too short');
  }
}

function claimNonce(value) {
  const nonce = value ?? randomToken(18);
  if (typeof nonce !== 'string' || !CLAIM_NONCE_RE.test(nonce)) {
    throw new Error('Invalid nonce');
  }
  return nonce;
}

function claimExpiry(nowMs, expiresAtMs, defaultLifetimeMs, maxLifetimeMs) {
  const expiry = expiresAtMs ?? nowMs + defaultLifetimeMs;
  if (!Number.isSafeInteger(expiry) || expiry <= nowMs || expiry - nowMs > maxLifetimeMs) {
    throw new Error('Invalid expiry');
  }
  return expiry;
}

/** Owner-claim issuer used by the offline CLI and the Access-gated admin API. */
export async function issueProRoomActivationClaim(roomCode, secret, options = {}) {
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

export async function verifyProRoomActivationClaim(token, roomCode, secret, nowMs) {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const payload = await verifySignedToken(token, secret);
  return payload &&
    payload.v === 1 &&
    payload.purpose === 'pro-room-activation' &&
    payload.roomCode === roomCode &&
    Number.isSafeInteger(payload.iat) &&
    payload.iat <= nowMs + 60_000 &&
    Number.isSafeInteger(payload.exp) &&
    payload.exp > nowMs &&
    payload.exp - payload.iat <= PRO_ROOM_ACTIVATION_CLAIM_MAX_LIFETIME_MS &&
    typeof payload.nonce === 'string' &&
    payload.nonce.length >= 16 &&
    Number.isSafeInteger(payload.generation) &&
    payload.generation >= 0 &&
    isProRoomGeneration(payload.roomGeneration) &&
    (payload.targetAccountId === undefined || ACCOUNT_ID_RE.test(payload.targetAccountId))
    ? payload
    : null;
}

export async function issueProRoomOwnerRecoveryClaim(roomCode, secret, options = {}) {
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

export async function verifyProRoomOwnerRecoveryClaim(token, roomCode, secret, nowMs) {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const payload = await verifySignedToken(token, secret);
  if (
    !payload ||
    !hasExactKeys(payload, [
      'v',
      'purpose',
      'roomCode',
      'iat',
      'exp',
      'nonce',
      'ownerAuthorityEpoch',
      'roomGeneration',
    ]) ||
    payload.v !== 1 ||
    payload.purpose !== 'pro-room-owner-recovery' ||
    payload.roomCode !== roomCode ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat > nowMs + 60_000 ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= nowMs ||
    payload.exp - payload.iat > PRO_ROOM_OWNER_RECOVERY_CLAIM_MAX_LIFETIME_MS ||
    !isProRoomGeneration(payload.roomGeneration) ||
    !isSafeNonNegativeInteger(payload.ownerAuthorityEpoch) ||
    typeof payload.nonce !== 'string' ||
    !CLAIM_NONCE_RE.test(payload.nonce)
  ) {
    return null;
  }
  return payload;
}

export async function issueProRoomOwnerTransferClaim(roomCode, secret, options = {}) {
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

export async function inspectProRoomOwnerTransferClaim(token, roomCode, secret, nowMs) {
  if (typeof secret !== 'string' || secret.length < 32) {
    return { error: 'OWNER_TRANSFER_CLAIM_INVALID' };
  }
  const payload = await verifySignedToken(token, secret);
  if (
    !payload ||
    !hasExactKeys(payload, [
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
    ]) ||
    payload.v !== 1 ||
    payload.purpose !== 'pro-room-owner-transfer' ||
    payload.roomCode !== roomCode ||
    !isProRoomGeneration(payload.roomGeneration) ||
    !ACCOUNT_ID_RE.test(payload.targetAccountId || '') ||
    !isSafeNonNegativeInteger(payload.claimGeneration) ||
    !isSafeNonNegativeInteger(payload.ownerAuthorityEpoch) ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat > nowMs + 60_000 ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > PRO_ROOM_OWNER_TRANSFER_CLAIM_MAX_LIFETIME_MS ||
    typeof payload.nonce !== 'string' ||
    !CLAIM_NONCE_RE.test(payload.nonce)
  ) {
    return { error: 'OWNER_TRANSFER_CLAIM_INVALID' };
  }
  return {
    claim: payload,
    expired: payload.exp <= nowMs,
  };
}

export async function createProRoomOwnerTransferCommitProof(room, pending, secret) {
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

export async function issueProRoomOwnerTransferRevocationReceipt(expected, secret, options = {}) {
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

export async function verifyProRoomOwnerTransferRevocationReceipt(token, expected, secret, nowMs) {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret.length < 32) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
    const expectedMac = await hmacBase64Url(
      secret,
      `owner-transfer-revocation:v1\u0000${parts[1]}`,
    );
    if (!constantTimeEqual(expectedMac, parts[2])) return null;
    const payload = JSON.parse(decoder.decode(base64UrlDecode(parts[1])));
    if (
      !hasExactKeys(payload, [
        'purpose',
        'roomCode',
        'roomGeneration',
        'transferId',
        'targetAccountId',
        'requestId',
        'revokedAtMs',
        'expiresAtMs',
      ]) ||
      payload.purpose !== 'pro-room-owner-transfer-revocation' ||
      payload.roomCode !== expected.roomCode ||
      payload.roomGeneration !== expected.roomGeneration ||
      payload.transferId !== expected.transferId ||
      payload.targetAccountId !== expected.targetAccountId ||
      payload.requestId !== expected.requestId ||
      !Number.isSafeInteger(payload.revokedAtMs) ||
      payload.revokedAtMs > nowMs + 60_000 ||
      !Number.isSafeInteger(payload.expiresAtMs) ||
      payload.expiresAtMs <= nowMs ||
      payload.expiresAtMs <= payload.revokedAtMs ||
      payload.expiresAtMs - payload.revokedAtMs >
        PRO_ROOM_OWNER_TRANSFER_REVOCATION_RECEIPT_MAX_LIFETIME_MS
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

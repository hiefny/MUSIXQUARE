import { normalizeAccountNickname } from './account-nickname.js';
import { isProRoomGeneration } from './pro-room-generation.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const ACCOUNT_ASSERTION_HEADER = 'X-MXQR-Account-Assertion';
export const ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM = 'pro-room';

const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{22}$/;
const PRO_ROOM_CODE_RE = /^0\d{5}$/;
const ASSERTION_VERSION = 1;
const ASSERTION_TTL_SECONDS = 60;
const ASSERTION_CLOCK_SKEW_SECONDS = 30;

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function validPayload(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = [
    'accountId',
    'aud',
    'exp',
    'iat',
    'nickname',
    'roomCode',
    'roomGeneration',
    'v',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return null;
  }
  const nickname = normalizeAccountNickname(value.nickname);
  const nowSeconds = Number.isSafeInteger(options.nowSeconds)
    ? options.nowSeconds
    : Math.floor(Date.now() / 1000);
  const expectedAudience = options.audience || ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM;
  const expectedRoomCode = options.roomCode;
  if (
    value.v !== ASSERTION_VERSION ||
    value.aud !== expectedAudience ||
    !ACCOUNT_ID_RE.test(value.accountId || '') ||
    !PRO_ROOM_CODE_RE.test(value.roomCode || '') ||
    (expectedRoomCode !== undefined && value.roomCode !== expectedRoomCode) ||
    !isProRoomGeneration(value.roomGeneration) ||
    (options.roomGeneration !== undefined &&
      value.roomGeneration !== options.roomGeneration) ||
    !nickname ||
    !Number.isSafeInteger(value.iat) ||
    !Number.isSafeInteger(value.exp) ||
    value.iat > nowSeconds + ASSERTION_CLOCK_SKEW_SECONDS ||
    value.exp <= nowSeconds ||
    value.exp - value.iat > ASSERTION_TTL_SECONDS ||
    value.exp <= value.iat
  ) {
    return null;
  }
  return {
    accountId: value.accountId,
    nickname,
    roomCode: value.roomCode,
    roomGeneration: value.roomGeneration,
    audience: value.aud,
    issuedAt: value.iat,
    expiresAt: value.exp,
  };
}

/**
 * Create a short-lived service assertion. The account session itself remains
 * in the App Worker; downstream room services see only this bounded proof.
 */
export async function createAccountAssertion(
  input,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const nickname = normalizeAccountNickname(input?.nickname);
  if (
    !ACCOUNT_ID_RE.test(input?.accountId || '') ||
    !PRO_ROOM_CODE_RE.test(input?.roomCode || '') ||
    input?.audience !== ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM ||
    !isProRoomGeneration(input?.roomGeneration) ||
    !nickname ||
    !Number.isSafeInteger(nowSeconds)
  ) {
    return null;
  }
  const payload = {
    v: ASSERTION_VERSION,
    aud: input.audience,
    roomCode: input.roomCode,
    roomGeneration: input.roomGeneration,
    accountId: input.accountId,
    nickname,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
  };
  const payloadPart = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${payloadPart}.${await hmac(secret, payloadPart)}`;
}

/** Verify an App-Worker-issued assertion without exposing the account cookie. */
export async function verifyAccountAssertion(token, secret, options = {}) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expectedSignature = await hmac(secret, parts[0]);
  if (!constantTimeEqual(expectedSignature, parts[1])) return null;
  const bytes = base64UrlToBytes(parts[0]);
  if (!bytes) return null;
  try {
    return validPayload(JSON.parse(decoder.decode(bytes)), options);
  } catch {
    return null;
  }
}

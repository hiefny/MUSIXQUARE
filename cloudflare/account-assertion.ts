import { normalizeAccountNickname } from './account-nickname.ts';
import { isProRoomGeneration } from './pro-room-generation.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export const ACCOUNT_ASSERTION_HEADER = 'X-MXQR-Account-Assertion';
export const ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM = 'pro-room';

export interface AccountAssertionInput {
  accountId: string;
  nickname: string;
  roomCode: string;
  roomGeneration?: number;
  audience: typeof ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM;
}

export interface VerifiedAccountAssertion extends AccountAssertionInput {
  roomGeneration: number;
  issuedAt: number;
  expiresAt: number;
}

export interface VerifyAccountAssertionOptions {
  audience?: string;
  roomCode?: string;
  roomGeneration?: number;
  nowSeconds?: number;
}

type UntrustedAccountAssertionPayload = Record<
  'accountId' | 'aud' | 'exp' | 'iat' | 'nickname' | 'roomCode' | 'roomGeneration' | 'v',
  unknown
>;

const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{22}$/;
const PRO_ROOM_CODE_RE = /^0\d{5}$/;
const ASSERTION_VERSION = 1;
const ASSERTION_TTL_SECONDS = 60;
const ASSERTION_CLOCK_SKEW_SECONDS = 30;

function bytesToBase64Url(bytes: Uint8Array<ArrayBufferLike>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
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

function constantTimeEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

async function hmac(secret: string, value: string): Promise<string> {
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

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function validPayload(
  value: unknown,
  options: VerifyAccountAssertionOptions = {},
): VerifiedAccountAssertion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as UntrustedAccountAssertionPayload;
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
  const nickname = normalizeAccountNickname(payload.nickname);
  const nowSeconds = isSafeInteger(options.nowSeconds)
    ? options.nowSeconds
    : Math.floor(Date.now() / 1000);
  const expectedAudience = options.audience || ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM;
  const expectedRoomCode = options.roomCode;
  if (
    payload.v !== ASSERTION_VERSION ||
    payload.aud !== expectedAudience ||
    !ACCOUNT_ID_RE.test((payload.accountId || '') as string) ||
    !PRO_ROOM_CODE_RE.test((payload.roomCode || '') as string) ||
    (expectedRoomCode !== undefined && payload.roomCode !== expectedRoomCode) ||
    !isProRoomGeneration(payload.roomGeneration) ||
    (options.roomGeneration !== undefined && payload.roomGeneration !== options.roomGeneration) ||
    !nickname ||
    !isSafeInteger(payload.iat) ||
    !isSafeInteger(payload.exp) ||
    payload.iat > nowSeconds + ASSERTION_CLOCK_SKEW_SECONDS ||
    payload.exp <= nowSeconds ||
    payload.exp - payload.iat > ASSERTION_TTL_SECONDS ||
    payload.exp <= payload.iat
  ) {
    return null;
  }
  return {
    accountId: payload.accountId as string,
    nickname,
    roomCode: payload.roomCode as string,
    roomGeneration: payload.roomGeneration,
    audience: payload.aud as typeof ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

/**
 * Create a short-lived service assertion. The account session itself remains
 * in the App Worker; downstream room services see only this bounded proof.
 */
export async function createAccountAssertion(
  input: AccountAssertionInput,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string | null> {
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
export async function verifyAccountAssertion(
  token: string | null | undefined,
  secret: string,
  options: VerifyAccountAssertionOptions = {},
): Promise<VerifiedAccountAssertion | null> {
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

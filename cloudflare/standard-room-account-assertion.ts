import { normalizeAccountNickname } from './account-nickname.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export const STANDARD_ROOM_ACCOUNT_ASSERTION_AUDIENCE = 'standard-room';
export const STANDARD_ROOM_ACCOUNT_DELETION_ASSERTION_AUDIENCE = 'standard-room-delete';

export type StandardRoomAssertionRole = 'host' | 'guest';

export interface StandardRoomAssertionInput {
  accountId: string;
  nickname: string;
  roomCode: string;
  peerId: string;
  role: StandardRoomAssertionRole;
}

export interface StandardRoomDeletionAssertionInput {
  accountId: string;
  roomCode: string;
  peerId: string;
  role: StandardRoomAssertionRole;
}

export interface StandardRoomAssertionOptions {
  roomCode?: string;
  peerId?: string;
  role?: StandardRoomAssertionRole;
  nowSeconds?: number;
}

export interface VerifiedStandardRoomAssertion {
  roomCode: string;
  accountSubject: string;
  nickname: string;
  peerId: string;
  role: StandardRoomAssertionRole;
  issuedAt: number;
  expiresAt: number;
}

export type VerifiedStandardRoomDeletionAssertion = Omit<VerifiedStandardRoomAssertion, 'nickname'>;

const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{22}$/;
const ACCOUNT_SUBJECT_RE = /^sub_[A-Za-z0-9_-]{22}$/;
const ROOM_CODE_RE = /^\d{6}$/;
const PEER_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const ASSERTION_VERSION = 1;
const ASSERTION_TTL_SECONDS = 60;
const ASSERTION_CLOCK_SKEW_SECONDS = 30;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function hmacBytes(secret: string, purpose: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${purpose}\u0000${value}`),
  );
  return new Uint8Array(signature);
}

async function signPart(secret: string, value: string): Promise<string> {
  return bytesToBase64Url(await hmacBytes(secret, 'standard-room-assertion:v1', value));
}

async function signDeletionPart(secret: string, value: string): Promise<string> {
  return bytesToBase64Url(await hmacBytes(secret, 'standard-room-deletion-assertion:v1', value));
}

/**
 * Derive a room-scoped account pseudonym. Neither the Google subject nor the
 * global MUSIXQUARE account ID crosses into signaling or peer metadata.
 */
export async function deriveStandardRoomAccountSubject(
  accountId: string,
  roomCode: string,
  secret: string,
): Promise<string | null> {
  if (
    !ACCOUNT_ID_RE.test(accountId || '') ||
    !ROOM_CODE_RE.test(roomCode || '') ||
    typeof secret !== 'string' ||
    secret.length < 32
  ) {
    return null;
  }
  const digest = await hmacBytes(
    secret,
    'standard-room-account-subject:v1',
    `${roomCode}\u0000${accountId}`,
  );
  return `sub_${bytesToBase64Url(digest).slice(0, 22)}`;
}

/** Create a short-lived, peer/role/room-bound assertion for signaling. */
export async function createStandardRoomAccountAssertion(
  input: StandardRoomAssertionInput,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const nickname = normalizeAccountNickname(input?.nickname);
  const accountSubject = await deriveStandardRoomAccountSubject(
    input?.accountId,
    input?.roomCode,
    secret,
  );
  if (
    !accountSubject ||
    !nickname ||
    !PEER_ID_RE.test(input?.peerId || '') ||
    (input?.role !== 'host' && input?.role !== 'guest') ||
    !Number.isSafeInteger(nowSeconds)
  ) {
    return null;
  }
  const payload = {
    v: ASSERTION_VERSION,
    aud: STANDARD_ROOM_ACCOUNT_ASSERTION_AUDIENCE,
    roomCode: input.roomCode,
    accountSubject,
    nickname,
    peerId: input.peerId,
    role: input.role,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
  };
  const payloadPart = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${payloadPart}.${await signPart(secret, payloadPart)}`;
}

/**
 * Create a deletion-only proof from a short-lived deleted-session tombstone.
 * The separate audience and HMAC purpose make this token unusable for account
 * attachment even though it derives the same room-scoped subject.
 */
export async function createStandardRoomAccountDeletionAssertion(
  input: StandardRoomDeletionAssertionInput,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const accountSubject = await deriveStandardRoomAccountSubject(
    input?.accountId,
    input?.roomCode,
    secret,
  );
  if (
    !accountSubject ||
    !PEER_ID_RE.test(input?.peerId || '') ||
    (input?.role !== 'host' && input?.role !== 'guest') ||
    !Number.isSafeInteger(nowSeconds)
  ) {
    return null;
  }
  const payload = {
    v: ASSERTION_VERSION,
    aud: STANDARD_ROOM_ACCOUNT_DELETION_ASSERTION_AUDIENCE,
    roomCode: input.roomCode,
    accountSubject,
    peerId: input.peerId,
    role: input.role,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
  };
  const payloadPart = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${payloadPart}.${await signDeletionPart(secret, payloadPart)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validatePayload(
  value: unknown,
  options: StandardRoomAssertionOptions,
): VerifiedStandardRoomAssertion | null {
  if (!isRecord(value)) return null;
  const expectedKeys = [
    'accountSubject',
    'aud',
    'exp',
    'iat',
    'nickname',
    'peerId',
    'role',
    'roomCode',
    'v',
  ];
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return null;
  }
  const nowSeconds =
    typeof options.nowSeconds === 'number' && Number.isSafeInteger(options.nowSeconds)
      ? options.nowSeconds
      : Math.floor(Date.now() / 1000);
  const nickname = normalizeAccountNickname(value.nickname);
  if (
    value.v !== ASSERTION_VERSION ||
    value.aud !== STANDARD_ROOM_ACCOUNT_ASSERTION_AUDIENCE ||
    typeof value.roomCode !== 'string' ||
    !ROOM_CODE_RE.test(value.roomCode) ||
    typeof value.accountSubject !== 'string' ||
    !ACCOUNT_SUBJECT_RE.test(value.accountSubject) ||
    !nickname ||
    typeof value.peerId !== 'string' ||
    !PEER_ID_RE.test(value.peerId) ||
    (value.role !== 'host' && value.role !== 'guest') ||
    (options?.roomCode !== undefined && value.roomCode !== options.roomCode) ||
    (options?.peerId !== undefined && value.peerId !== options.peerId) ||
    (options?.role !== undefined && value.role !== options.role) ||
    typeof value.iat !== 'number' ||
    !Number.isSafeInteger(value.iat) ||
    typeof value.exp !== 'number' ||
    !Number.isSafeInteger(value.exp) ||
    value.iat > nowSeconds + ASSERTION_CLOCK_SKEW_SECONDS ||
    value.exp <= nowSeconds ||
    value.exp <= value.iat ||
    value.exp - value.iat > ASSERTION_TTL_SECONDS
  ) {
    return null;
  }
  return {
    roomCode: value.roomCode,
    accountSubject: value.accountSubject,
    nickname,
    peerId: value.peerId,
    role: value.role,
    issuedAt: value.iat,
    expiresAt: value.exp,
  };
}

/** Verify a signed assertion. Invalid/expired assertions are anonymous, never fatal. */
export async function verifyStandardRoomAccountAssertion(
  token: string | null | undefined,
  secret: string,
  options: StandardRoomAssertionOptions = {},
): Promise<VerifiedStandardRoomAssertion | null> {
  if (typeof token !== 'string' || token.length > 2048) return null;
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!constantTimeEqual(await signPart(secret, parts[0]), parts[1])) return null;
  const bytes = base64UrlToBytes(parts[0]);
  if (!bytes) return null;
  try {
    return validatePayload(JSON.parse(decoder.decode(bytes)), options);
  } catch {
    return null;
  }
}

function validateDeletionPayload(
  value: unknown,
  options: StandardRoomAssertionOptions,
): VerifiedStandardRoomDeletionAssertion | null {
  if (!isRecord(value)) return null;
  const expectedKeys = ['accountSubject', 'aud', 'exp', 'iat', 'peerId', 'role', 'roomCode', 'v'];
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return null;
  }
  const nowSeconds =
    typeof options.nowSeconds === 'number' && Number.isSafeInteger(options.nowSeconds)
      ? options.nowSeconds
      : Math.floor(Date.now() / 1000);
  if (
    value.v !== ASSERTION_VERSION ||
    value.aud !== STANDARD_ROOM_ACCOUNT_DELETION_ASSERTION_AUDIENCE ||
    typeof value.roomCode !== 'string' ||
    !ROOM_CODE_RE.test(value.roomCode) ||
    typeof value.accountSubject !== 'string' ||
    !ACCOUNT_SUBJECT_RE.test(value.accountSubject) ||
    typeof value.peerId !== 'string' ||
    !PEER_ID_RE.test(value.peerId) ||
    (value.role !== 'host' && value.role !== 'guest') ||
    (options?.roomCode !== undefined && value.roomCode !== options.roomCode) ||
    (options?.peerId !== undefined && value.peerId !== options.peerId) ||
    (options?.role !== undefined && value.role !== options.role) ||
    typeof value.iat !== 'number' ||
    !Number.isSafeInteger(value.iat) ||
    typeof value.exp !== 'number' ||
    !Number.isSafeInteger(value.exp) ||
    value.iat > nowSeconds + ASSERTION_CLOCK_SKEW_SECONDS ||
    value.exp <= nowSeconds ||
    value.exp <= value.iat ||
    value.exp - value.iat > ASSERTION_TTL_SECONDS
  ) {
    return null;
  }
  return {
    roomCode: value.roomCode,
    accountSubject: value.accountSubject,
    peerId: value.peerId,
    role: value.role,
    issuedAt: value.iat,
    expiresAt: value.exp,
  };
}

/** Verify only deletion-audience assertions; normal attach tokens always fail. */
export async function verifyStandardRoomAccountDeletionAssertion(
  token: string | null | undefined,
  secret: string,
  options: StandardRoomAssertionOptions = {},
): Promise<VerifiedStandardRoomDeletionAssertion | null> {
  if (typeof token !== 'string' || token.length > 2048) return null;
  if (typeof secret !== 'string' || secret.length < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!constantTimeEqual(await signDeletionPart(secret, parts[0]), parts[1])) return null;
  const bytes = base64UrlToBytes(parts[0]);
  if (!bytes) return null;
  try {
    return validateDeletionPayload(JSON.parse(decoder.decode(bytes)), options);
  } catch {
    return null;
  }
}

/**
 * Derive the generation-scoped member ID inside the room DO. A reused six
 * digit code receives a new roomSecret and therefore cannot correlate people.
 */
export async function deriveStandardRoomMemberId(
  roomSecret: string,
  accountSubject: string | null,
): Promise<string | null> {
  if (
    typeof roomSecret !== 'string' ||
    !roomSecret ||
    typeof accountSubject !== 'string' ||
    !ACCOUNT_SUBJECT_RE.test(accountSubject)
  ) {
    return null;
  }
  const digest = await hmacBytes(roomSecret, 'standard-room-member:v1', accountSubject);
  return `member_${bytesToBase64Url(digest).slice(0, 22)}`;
}

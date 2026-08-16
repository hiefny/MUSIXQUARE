const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export const REMOTE_SHARE_UPLOAD_ASSERTION_VERSION = 1;
export const REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_VERSION = 1;
export const REMOTE_SHARE_UPLOAD_ASSERTION_AUDIENCE = 'musixquare-remote-share-upload';
export const REMOTE_SHARE_UPLOAD_ASSERTION_SCOPE = 'remote-share.upload';
export const REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS = 60;
export const REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_PREFIX = 'mxqr-keyring-v1:';

export interface RemoteShareUploadAssertionKey {
  kid: string | null;
  secret: string;
}

export interface RemoteShareUploadAssertionKeyring {
  current: RemoteShareUploadAssertionKey;
  previous: RemoteShareUploadAssertionKey | null;
}

export interface RemoteShareUploadAssertionInput {
  roomId: string;
  hostPeerId: string;
  sessionId: number;
  queueItemId: string;
  size: number;
  actorId: string;
  requestId: string;
  bodySha256: string;
}

export interface RemoteShareUploadAssertionResult {
  assertion: string;
  expiresAt: number;
}

export interface RemoteShareUploadAssertionOptions {
  roomId?: string;
  sessionId?: number;
  queueItemId?: string;
  size?: number;
  actorId?: string;
  requestId?: string;
  bodySha256?: string;
  nowSeconds?: number;
}

export interface VerifiedRemoteShareUploadAssertion extends RemoteShareUploadAssertionInput {
  jti: string;
  kid?: string;
  issuedAt: number;
  expiresAt: number;
}

const ASSERTION_CLOCK_SKEW_SECONDS = 30;
const ASSERTION_TOKEN_MAX_LENGTH = 4096;
const ASSERTION_SIGNING_PURPOSE = 'remote-share-upload-assertion:v1';
const HMAC_SECRET_MIN_LENGTH = 32;
const ASSERTION_KEYRING_MAX_LENGTH = 4096;
const REMOTE_SHARE_MAX_BYTES = 200 * 1024 * 1024;
const STANDARD_ROOM_CODE_RE = /^[1-9]\d{5}$/;
const PEER_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR_ID_RE = /^rsa_[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_RE = /^rs3_[A-Za-z0-9_-]{43}$/;
const SHA256_BASE64URL_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PAYLOAD_KEYS = Object.freeze([
  'actorId',
  'aud',
  'bodySha256',
  'exp',
  'hostPeerId',
  'iat',
  'jti',
  'queueItemId',
  'requestId',
  'role',
  'roomId',
  'scope',
  'sessionId',
  'size',
  'v',
]);
const KEYED_PAYLOAD_KEYS = Object.freeze([...PAYLOAD_KEYS, 'kid'].sort());

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
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
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

async function signPart(secret: string, payloadPart: string): Promise<string> {
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
    encoder.encode(`${ASSERTION_SIGNING_PURPOSE}\u0000${payloadPart}`),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function validSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length >= HMAC_SECRET_MIN_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    actual.length <= allowed.length &&
    actual.every((key) => allowed.includes(key))
  );
}

function normalizeKeyringKey(value: unknown): RemoteShareUploadAssertionKey | null {
  if (!hasExactKeys(value, ['kid', 'secret'])) return null;
  if (typeof value.kid !== 'string' || !KEY_ID_RE.test(value.kid) || !validSecret(value.secret)) {
    return null;
  }
  return { kid: value.kid, secret: value.secret };
}

/**
 * Parse the existing shared secret binding. A plain 32+ character value keeps
 * the original unkeyed contract. The explicit prefixed JSON form enables a
 * current/previous verification window without adding another Worker binding.
 */
export function parseRemoteShareUploadAssertionKeyring(
  value: unknown,
): RemoteShareUploadAssertionKeyring | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!value.startsWith(REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_PREFIX)) {
    return validSecret(value) ? { current: { kid: null, secret: value }, previous: null } : null;
  }
  if (value.length > ASSERTION_KEYRING_MAX_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(
      value.slice(REMOTE_SHARE_UPLOAD_ASSERTION_KEYRING_PREFIX.length),
    );
    if (!hasExactKeys(parsed, ['current', 'v'], ['previous']) || parsed.v !== 1) return null;
    const current = normalizeKeyringKey(parsed.current);
    const previous = parsed.previous === undefined ? null : normalizeKeyringKey(parsed.previous);
    if (!current || (parsed.previous !== undefined && !previous)) return null;
    if (
      previous &&
      (constantTimeEqual(current.kid, previous.kid) ||
        constantTimeEqual(current.secret, previous.secret))
    ) {
      return null;
    }
    return { current, previous };
  } catch {
    return null;
  }
}

function validBodySha256(value: unknown): value is string {
  if (typeof value !== 'string' || !SHA256_BASE64URL_RE.test(value)) return false;
  return base64UrlToBytes(value)?.byteLength === 32;
}

function validBoundFields(value: unknown): value is RemoteShareUploadAssertionInput {
  if (!isRecord(value)) return false;
  const candidate = value;
  return (
    typeof candidate.roomId === 'string' &&
    STANDARD_ROOM_CODE_RE.test(candidate.roomId) &&
    typeof candidate.hostPeerId === 'string' &&
    PEER_ID_RE.test(candidate.hostPeerId) &&
    typeof candidate.sessionId === 'number' &&
    Number.isSafeInteger(candidate.sessionId) &&
    candidate.sessionId > 0 &&
    typeof candidate.queueItemId === 'string' &&
    UUID_V4_RE.test(candidate.queueItemId) &&
    typeof candidate.size === 'number' &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size > 0 &&
    candidate.size <= REMOTE_SHARE_MAX_BYTES &&
    typeof candidate.actorId === 'string' &&
    ACTOR_ID_RE.test(candidate.actorId) &&
    typeof candidate.requestId === 'string' &&
    REQUEST_ID_RE.test(candidate.requestId) &&
    validBodySha256(candidate.bodySha256)
  );
}

/**
 * Issue a short-lived proof that signaling observed this exact upload request
 * from the current host of a standard room.
 */
export async function createRemoteShareUploadAssertion(
  input: RemoteShareUploadAssertionInput,
  keyringValue: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<RemoteShareUploadAssertionResult | null> {
  const keyring = parseRemoteShareUploadAssertionKeyring(keyringValue);
  if (!keyring || !validBoundFields(input) || !Number.isSafeInteger(nowSeconds)) {
    return null;
  }
  const jti = crypto.randomUUID();
  if (!UUID_V4_RE.test(jti)) return null;
  const expiresAt = nowSeconds + REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS;
  const payload = {
    v: REMOTE_SHARE_UPLOAD_ASSERTION_VERSION,
    aud: REMOTE_SHARE_UPLOAD_ASSERTION_AUDIENCE,
    scope: REMOTE_SHARE_UPLOAD_ASSERTION_SCOPE,
    role: 'host',
    roomId: input.roomId,
    hostPeerId: input.hostPeerId,
    sessionId: input.sessionId,
    queueItemId: input.queueItemId,
    size: input.size,
    actorId: input.actorId,
    requestId: input.requestId,
    bodySha256: input.bodySha256,
    jti,
    ...(keyring.current.kid ? { kid: keyring.current.kid } : {}),
    iat: nowSeconds,
    exp: expiresAt,
  };
  const payloadPart = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return {
    assertion: `${payloadPart}.${await signPart(keyring.current.secret, payloadPart)}`,
    expiresAt,
  };
}

function validatePayload(
  value: unknown,
  options: RemoteShareUploadAssertionOptions,
): VerifiedRemoteShareUploadAssertion | null {
  if (!isRecord(value)) return null;
  const candidate = value;
  const keys = Object.keys(candidate).sort();
  const expectedKeys = Object.prototype.hasOwnProperty.call(candidate, 'kid')
    ? KEYED_PAYLOAD_KEYS
    : PAYLOAD_KEYS;
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
    candidate.v !== REMOTE_SHARE_UPLOAD_ASSERTION_VERSION ||
    candidate.aud !== REMOTE_SHARE_UPLOAD_ASSERTION_AUDIENCE ||
    candidate.scope !== REMOTE_SHARE_UPLOAD_ASSERTION_SCOPE ||
    candidate.role !== 'host' ||
    (candidate.kid !== undefined &&
      (typeof candidate.kid !== 'string' || !KEY_ID_RE.test(candidate.kid))) ||
    !validBoundFields(candidate) ||
    typeof candidate.jti !== 'string' ||
    !UUID_V4_RE.test(candidate.jti) ||
    typeof candidate.iat !== 'number' ||
    !Number.isSafeInteger(candidate.iat) ||
    typeof candidate.exp !== 'number' ||
    !Number.isSafeInteger(candidate.exp) ||
    candidate.iat > nowSeconds + ASSERTION_CLOCK_SKEW_SECONDS ||
    candidate.exp <= nowSeconds ||
    candidate.exp <= candidate.iat ||
    candidate.exp - candidate.iat > REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS ||
    (options.roomId !== undefined && candidate.roomId !== options.roomId) ||
    (options.sessionId !== undefined && candidate.sessionId !== options.sessionId) ||
    (options.queueItemId !== undefined && candidate.queueItemId !== options.queueItemId) ||
    (options.size !== undefined && candidate.size !== options.size) ||
    (options.actorId !== undefined && candidate.actorId !== options.actorId) ||
    (options.requestId !== undefined && candidate.requestId !== options.requestId) ||
    (options.bodySha256 !== undefined && candidate.bodySha256 !== options.bodySha256)
  ) {
    return null;
  }
  return {
    roomId: candidate.roomId,
    hostPeerId: candidate.hostPeerId,
    sessionId: candidate.sessionId,
    queueItemId: candidate.queueItemId,
    size: candidate.size,
    actorId: candidate.actorId,
    requestId: candidate.requestId,
    bodySha256: candidate.bodySha256,
    jti: candidate.jti,
    ...(candidate.kid !== undefined ? { kid: candidate.kid } : {}),
    issuedAt: candidate.iat,
    expiresAt: candidate.exp,
  };
}

/** Verify a host assertion and, when supplied, every expected request field. */
export async function verifyRemoteShareUploadAssertion(
  token: string | null | undefined,
  keyringValue: string,
  options: RemoteShareUploadAssertionOptions = {},
): Promise<VerifiedRemoteShareUploadAssertion | null> {
  const keyring = parseRemoteShareUploadAssertionKeyring(keyringValue);
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > ASSERTION_TOKEN_MAX_LENGTH ||
    !keyring
  ) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payloadPart, signaturePart] = parts;
  try {
    const payloadBytes = base64UrlToBytes(payloadPart);
    if (!payloadBytes) return null;
    const payload: unknown = JSON.parse(decoder.decode(payloadBytes));
    if (!isRecord(payload)) return null;
    const candidate = payload;
    const presentedKid = Object.prototype.hasOwnProperty.call(candidate, 'kid')
      ? candidate.kid
      : null;
    if (
      presentedKid !== null &&
      (typeof presentedKid !== 'string' || !KEY_ID_RE.test(presentedKid))
    )
      return null;
    const candidates = [keyring.current, keyring.previous].filter(
      (key): key is RemoteShareUploadAssertionKey =>
        key !== null && (presentedKid === null || constantTimeEqual(key.kid, presentedKid)),
    );
    if (candidates.length === 0) return null;
    const signatures = await Promise.all(
      candidates.map((key) => signPart(key.secret, payloadPart)),
    );
    if (!signatures.some((signature) => constantTimeEqual(signature, signaturePart))) return null;
    return validatePayload(payload, options);
  } catch {
    return null;
  }
}

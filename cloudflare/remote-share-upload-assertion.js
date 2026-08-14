const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const REMOTE_SHARE_UPLOAD_ASSERTION_VERSION = 1;
export const REMOTE_SHARE_UPLOAD_ASSERTION_AUDIENCE = 'musixquare-remote-share-upload';
export const REMOTE_SHARE_UPLOAD_ASSERTION_SCOPE = 'remote-share.upload';
export const REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS = 60;

const ASSERTION_CLOCK_SKEW_SECONDS = 30;
const ASSERTION_TOKEN_MAX_LENGTH = 4096;
const ASSERTION_SIGNING_PURPOSE = 'remote-share-upload-assertion:v1';
const HMAC_SECRET_MIN_LENGTH = 32;
const REMOTE_SHARE_MAX_BYTES = 200 * 1024 * 1024;
const STANDARD_ROOM_CODE_RE = /^[1-9]\d{5}$/;
const PEER_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR_ID_RE = /^rsa_[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_RE = /^rs3_[A-Za-z0-9_-]{43}$/;
const SHA256_BASE64URL_RE = /^[A-Za-z0-9_-]{43}$/;
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
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function signPart(secret, payloadPart) {
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

function validSecret(secret) {
  return typeof secret === 'string' && secret.length >= HMAC_SECRET_MIN_LENGTH;
}

function validBodySha256(value) {
  if (!SHA256_BASE64URL_RE.test(value || '')) return false;
  return base64UrlToBytes(value)?.byteLength === 32;
}

function validBoundFields(value) {
  return (
    STANDARD_ROOM_CODE_RE.test(value?.roomId || '') &&
    PEER_ID_RE.test(value?.hostPeerId || '') &&
    Number.isSafeInteger(value?.sessionId) &&
    value.sessionId > 0 &&
    UUID_V4_RE.test(value?.queueItemId || '') &&
    Number.isSafeInteger(value?.size) &&
    value.size > 0 &&
    value.size <= REMOTE_SHARE_MAX_BYTES &&
    ACTOR_ID_RE.test(value?.actorId || '') &&
    REQUEST_ID_RE.test(value?.requestId || '') &&
    validBodySha256(value?.bodySha256)
  );
}

/**
 * Issue a short-lived proof that signaling observed this exact upload request
 * from the current host of a standard room.
 */
export async function createRemoteShareUploadAssertion(
  input,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (!validSecret(secret) || !validBoundFields(input) || !Number.isSafeInteger(nowSeconds)) {
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
    iat: nowSeconds,
    exp: expiresAt,
  };
  const payloadPart = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return {
    assertion: `${payloadPart}.${await signPart(secret, payloadPart)}`,
    expiresAt,
  };
}

function validatePayload(value, options) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some((key, index) => key !== PAYLOAD_KEYS[index])
  ) {
    return null;
  }
  const nowSeconds = Number.isSafeInteger(options?.nowSeconds)
    ? options.nowSeconds
    : Math.floor(Date.now() / 1000);
  if (
    value.v !== REMOTE_SHARE_UPLOAD_ASSERTION_VERSION ||
    value.aud !== REMOTE_SHARE_UPLOAD_ASSERTION_AUDIENCE ||
    value.scope !== REMOTE_SHARE_UPLOAD_ASSERTION_SCOPE ||
    value.role !== 'host' ||
    !validBoundFields(value) ||
    !UUID_V4_RE.test(value.jti || '') ||
    !Number.isSafeInteger(value.iat) ||
    !Number.isSafeInteger(value.exp) ||
    value.iat > nowSeconds + ASSERTION_CLOCK_SKEW_SECONDS ||
    value.exp <= nowSeconds ||
    value.exp <= value.iat ||
    value.exp - value.iat > REMOTE_SHARE_UPLOAD_ASSERTION_TTL_SECONDS ||
    (options?.roomId !== undefined && value.roomId !== options.roomId) ||
    (options?.sessionId !== undefined && value.sessionId !== options.sessionId) ||
    (options?.queueItemId !== undefined && value.queueItemId !== options.queueItemId) ||
    (options?.size !== undefined && value.size !== options.size) ||
    (options?.actorId !== undefined && value.actorId !== options.actorId) ||
    (options?.requestId !== undefined && value.requestId !== options.requestId) ||
    (options?.bodySha256 !== undefined && value.bodySha256 !== options.bodySha256)
  ) {
    return null;
  }
  return {
    roomId: value.roomId,
    hostPeerId: value.hostPeerId,
    sessionId: value.sessionId,
    queueItemId: value.queueItemId,
    size: value.size,
    actorId: value.actorId,
    requestId: value.requestId,
    bodySha256: value.bodySha256,
    jti: value.jti,
    issuedAt: value.iat,
    expiresAt: value.exp,
  };
}

/** Verify a host assertion and, when supplied, every expected request field. */
export async function verifyRemoteShareUploadAssertion(token, secret, options = {}) {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > ASSERTION_TOKEN_MAX_LENGTH ||
    !validSecret(secret)
  ) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    if (!constantTimeEqual(await signPart(secret, parts[0]), parts[1])) return null;
    const payloadBytes = base64UrlToBytes(parts[0]);
    if (!payloadBytes) return null;
    return validatePayload(JSON.parse(decoder.decode(payloadBytes)), options);
  } catch {
    return null;
  }
}

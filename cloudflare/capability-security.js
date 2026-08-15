const SECONDS_PER_MINUTE = 60;
const CAPABILITY_TOKEN_TTL_DEFAULT = 10 * SECONDS_PER_MINUTE;
const CAPABILITY_TOKEN_TTL_MIN = 3 * SECONDS_PER_MINUTE;
const CAPABILITY_TOKEN_TTL_MAX = 30 * SECONDS_PER_MINUTE;
const CAPABILITY_SCOPES = new Set(['turn', 'realtime', 'youtube-search', 'remote-share']);
const CAPABILITY_TOKEN_MAX_LENGTH = 512;
const CAPABILITY_TOKEN_PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;
const CAPABILITY_TOKEN_SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
const CAPABILITY_POW_DIFFICULTY_MIN = 8;
const CAPABILITY_POW_DIFFICULTY_MAX = 24;
const CAPABILITY_POW_TTL_DEFAULT = 2 * SECONDS_PER_MINUTE;
const CAPABILITY_POW_TTL_MIN = 30;
const CAPABILITY_POW_TTL_MAX = 5 * SECONDS_PER_MINUTE;
const CAPABILITY_POW_ADAPTIVE_MAX_DELTA_DEFAULT = 4;
const CAPABILITY_POW_ROOM_PRESSURE_BINDING = 'MXQR_CAPABILITY_POW_ROOM_PRESSURE';
const CAPABILITY_POW_GENERAL_PRESSURE_BINDING = 'MXQR_CAPABILITY_POW_GENERAL_PRESSURE';
const HMAC_SECRET_MIN_LENGTH = 32;

export const CAPABILITY_JSON_BODY_MAX_BYTES = 8 * 1024;

function boundedInteger(raw, fallback, minimum, maximum) {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function enabled(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
  );
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function stringToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToString(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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

async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function sha256Bytes(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function hasLeadingZeroBits(bytes, difficulty) {
  let remaining = difficulty;
  for (const byte of bytes) {
    if (remaining <= 0) return true;
    const bits = Math.min(8, remaining);
    if ((byte & (0xff << (8 - bits))) !== 0) return false;
    remaining -= bits;
  }
  return remaining <= 0;
}

async function capabilityIpHash(secret, request) {
  return hmacSha256(secret, `ip:${getClientIp(request)}`);
}

function randomNonce(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function getCapabilitySecret(env) {
  const secret = String(
    env.MXQR_CAPABILITY_SECRET || env.CAPABILITY_HMAC_SECRET || env.CAPABILITY_SECRET || '',
  );
  return secret.length >= HMAC_SECRET_MIN_LENGTH ? secret : '';
}

export function hasInvalidCapabilitySecret(env) {
  const secret = String(
    env.MXQR_CAPABILITY_SECRET || env.CAPABILITY_HMAC_SECRET || env.CAPABILITY_SECRET || '',
  );
  return secret.length > 0 && secret.length < HMAC_SECRET_MIN_LENGTH;
}

export function isCapabilityAuthEnabled(env) {
  return !!getCapabilitySecret(env);
}

export function parseCapabilityTtl(env) {
  return boundedInteger(
    env.MXQR_CAPABILITY_TTL || env.CAPABILITY_TTL,
    CAPABILITY_TOKEN_TTL_DEFAULT,
    CAPABILITY_TOKEN_TTL_MIN,
    CAPABILITY_TOKEN_TTL_MAX,
  );
}

export function parseCapabilityPowDifficulty(env, fallback = 12) {
  return boundedInteger(
    env.MXQR_CAPABILITY_POW_DIFFICULTY || env.CAPABILITY_POW_DIFFICULTY,
    fallback,
    CAPABILITY_POW_DIFFICULTY_MIN,
    CAPABILITY_POW_DIFFICULTY_MAX,
  );
}

export function parseCapabilityPowTtl(env) {
  return boundedInteger(
    env.MXQR_CAPABILITY_POW_TTL || env.CAPABILITY_POW_TTL,
    CAPABILITY_POW_TTL_DEFAULT,
    CAPABILITY_POW_TTL_MIN,
    CAPABILITY_POW_TTL_MAX,
  );
}

export function isCapabilityPowAdaptiveEnabled(env) {
  return enabled(env.MXQR_CAPABILITY_POW_ADAPTIVE_ENABLED);
}

export function parseCapabilityPowMaxDifficulty(env, baselineDifficulty) {
  if (!isCapabilityPowAdaptiveEnabled(env)) return baselineDifficulty;
  const fallback = Math.min(
    CAPABILITY_POW_DIFFICULTY_MAX,
    baselineDifficulty + CAPABILITY_POW_ADAPTIVE_MAX_DELTA_DEFAULT,
  );
  return boundedInteger(
    env.MXQR_CAPABILITY_POW_ADAPTIVE_MAX_DIFFICULTY,
    fallback,
    baselineDifficulty,
    CAPABILITY_POW_DIFFICULTY_MAX,
  );
}

export function parseRequestedScopes(value) {
  if (!Array.isArray(value)) return [];
  const scopes = [];
  for (const scope of value) {
    if (typeof scope === 'string' && CAPABILITY_SCOPES.has(scope) && !scopes.includes(scope)) {
      scopes.push(scope);
    }
  }
  return scopes.sort();
}

/**
 * Consume one location-local Cloudflare Rate Limiting binding event. The room
 * and general bindings have independent namespaces and fixed 150/60s and
 * 15/60s limits in wrangler.app.toml. Cloudflare updates these eventually
 * consistent counters asynchronously in the serving location, so awaiting
 * limit() does not wait on a network request. The signal is friction only: a
 * missing/malformed/throwing binding falls back to the reviewed baseline while
 * paid endpoints retain their independent fail-closed atomic cost caps.
 */
export async function consumeCapabilityPowPressure(
  request,
  env,
  { roomBurst = false, baselineDifficulty = 12 } = {},
) {
  const runtimeEnv = env || {};
  const maximumDifficulty = parseCapabilityPowMaxDifficulty(runtimeEnv, baselineDifficulty);
  if (!isCapabilityPowAdaptiveEnabled(runtimeEnv) || maximumDifficulty <= baselineDifficulty) {
    return {
      status: 'disabled',
      exceeded: false,
      difficulty: baselineDifficulty,
    };
  }
  const bindingName = roomBurst
    ? CAPABILITY_POW_ROOM_PRESSURE_BINDING
    : CAPABILITY_POW_GENERAL_PRESSURE_BINDING;
  const binding = runtimeEnv[bindingName];
  const secret = getCapabilitySecret(runtimeEnv);
  if (!secret || !binding || typeof binding.limit !== 'function') {
    return {
      status: 'fallback',
      exceeded: false,
      difficulty: baselineDifficulty,
    };
  }
  try {
    const result = await binding.limit({ key: await capabilityIpHash(secret, request) });
    if (!result || typeof result.success !== 'boolean') {
      return {
        status: 'fallback',
        exceeded: false,
        difficulty: baselineDifficulty,
      };
    }
    return {
      status: 'ok',
      exceeded: !result.success,
      difficulty: result.success ? baselineDifficulty : maximumDifficulty,
    };
  } catch {
    return {
      status: 'fallback',
      exceeded: false,
      difficulty: baselineDifficulty,
    };
  }
}

export async function createCapabilityPowChallenge(
  scopes,
  request,
  env,
  difficulty = parseCapabilityPowDifficulty(env),
) {
  const secret = getCapabilitySecret(env);
  const now = Math.floor(Date.now() / 1000);
  const baselineDifficulty = parseCapabilityPowDifficulty(env);
  const maximumDifficulty = parseCapabilityPowMaxDifficulty(env, baselineDifficulty);
  const resolvedDifficulty =
    Number.isSafeInteger(difficulty) &&
    difficulty >= baselineDifficulty &&
    difficulty <= maximumDifficulty
      ? difficulty
      : baselineDifficulty;
  const payload = {
    v: 1,
    scopes,
    iat: now,
    exp: now + parseCapabilityPowTtl(env),
    ip: await capabilityIpHash(secret, request),
    difficulty: resolvedDifficulty,
    capabilityTtl: parseCapabilityTtl(env),
    nonce: randomNonce(),
  };
  const payloadPart = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(secret, `capability-pow:${payloadPart}`);
  return {
    challenge: `${payloadPart}.${signature}`,
    difficulty: payload.difficulty,
    expiresAt: payload.exp,
    algorithm: 'sha256-leading-zero-bits',
  };
}

export async function verifyCapabilityPowProof(
  proof,
  scopes,
  request,
  env,
  baselineDifficulty = parseCapabilityPowDifficulty(env),
) {
  if (!proof || typeof proof !== 'object') return null;
  const challenge = typeof proof.challenge === 'string' ? proof.challenge : '';
  const solution = typeof proof.solution === 'string' ? proof.solution : '';
  if (!challenge || !/^\d{1,20}$/.test(solution)) return null;

  const parts = challenge.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const secret = getCapabilitySecret(env);
  const expectedSignature = await hmacSha256(secret, `capability-pow:${parts[0]}`);
  if (!constantTimeEqual(expectedSignature, parts[1])) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload?.v !== 1) return null;
  if (!Array.isArray(payload.scopes) || JSON.stringify(payload.scopes) !== JSON.stringify(scopes)) {
    return null;
  }
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (payload.exp - payload.iat !== parseCapabilityPowTtl(env)) return null;
  const maximumDifficulty = parseCapabilityPowMaxDifficulty(env, baselineDifficulty);
  if (
    !Number.isSafeInteger(payload.difficulty) ||
    payload.difficulty < baselineDifficulty ||
    payload.difficulty > maximumDifficulty
  ) {
    return null;
  }
  if (payload.capabilityTtl !== parseCapabilityTtl(env)) return null;
  if (typeof payload.nonce !== 'string' || !payload.nonce) return null;

  const expectedIp = await capabilityIpHash(secret, request);
  if (!constantTimeEqual(String(payload.ip || ''), expectedIp)) return null;

  const digest = await sha256Bytes(`mxqr-pow-v1:${challenge}:${solution}`);
  if (!hasLeadingZeroBits(digest, payload.difficulty)) return null;
  return payload;
}

export function readCapabilityToken(request) {
  const headerToken = request.headers.get('X-MXQR-Capability') || '';
  if (headerToken) return headerToken.trim();
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export async function createCapabilityToken(scopes, request, env, method, anchor = null) {
  const secret = getCapabilitySecret(env);
  const ttl = parseCapabilityTtl(env);
  const now = Math.floor(Date.now() / 1000);
  // Tokens are base64url-encoded, not encrypted. Do not embed the minting
  // method because it would disclose the active verification path.
  void method;
  const payload = {
    v: 1,
    scopes,
    iat: anchor?.iat ?? now,
    exp: (anchor?.iat ?? now) + ttl,
    ip: await capabilityIpHash(secret, request),
    ...(anchor?.jti ? { jti: anchor.jti } : {}),
  };
  const payloadPart = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256(secret, payloadPart);
  return {
    token: `${payloadPart}.${signature}`,
    expiresAt: payload.exp,
    scopes,
  };
}

export async function verifyCapabilityToken(token, request, env, requiredScope) {
  const secret = getCapabilitySecret(env);
  if (
    !secret ||
    typeof token !== 'string' ||
    !token ||
    token.length > CAPABILITY_TOKEN_MAX_LENGTH
  ) {
    return false;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  if (
    !CAPABILITY_TOKEN_PAYLOAD_RE.test(parts[0]) ||
    !CAPABILITY_TOKEN_SIGNATURE_RE.test(parts[1])
  ) {
    return false;
  }

  const expectedSignature = await hmacSha256(secret, parts[0]);
  if (!constantTimeEqual(expectedSignature, parts[1])) return false;

  let payload;
  try {
    payload = JSON.parse(base64UrlToString(parts[0]));
  } catch {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload?.v !== 1) return false;
  if (!Array.isArray(payload.scopes) || !payload.scopes.includes(requiredScope)) return false;
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return false;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return false;

  const expectedIp = await capabilityIpHash(secret, request);
  return constantTimeEqual(String(payload.ip || ''), expectedIp);
}

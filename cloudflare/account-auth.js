import {
  createStandardRoomAccountAssertion,
  createStandardRoomAccountDeletionAssertion,
} from './standard-room-account-assertion.js';
import {
  accountNicknameKey,
  normalizeAccountNickname,
  normalizeNewAccountNickname,
} from './account-nickname.js';
import { LEGACY_PRO_ROOM_GENERATION, isProRoomGeneration } from './pro-room-generation.js';

const AUTH_ROUTE_PREFIX = '/api/auth/';
const AUTH_SESSION_COOKIE = '__Host-mxqr_account';
const OAUTH_FLOW_COOKIE_PREFIX = '__Host-mxqr_oauth_flow_';
const OAUTH_FLOW_COOKIE_SUFFIX_LENGTH = 16;
const OAUTH_FLOW_COOKIE_MAX_ACTIVE = 3;
const OAUTH_FLOW_COOKIE_SCAN_MAX = 12;
const ACCOUNT_CSRF_HEADER = 'X-MXQR-Account-CSRF';

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_AUTHORIZATION_RESPONSE_ISSUER = 'https://accounts.google.com';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const DEFAULT_REDIRECT_URI = 'https://musixquare.com/api/auth/google/callback';

const OAUTH_FLOW_TTL_SECONDS = 10 * 60;
const ACCOUNT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACCOUNT_SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
// Long enough for every live Standard-room socket (40 s refresh cadence) to
// observe deletion, yet short enough that an old cookie is not retained as a
// durable account identifier.
const ACCOUNT_DELETED_SESSION_TTL_SECONDS = 10 * 60;
// Supports the advertised 100-device room with headroom for a user's other
// browsers, while bounding D1 growth and logout/delete fan-out per account.
const ACCOUNT_SESSION_MAX_PER_ACCOUNT = 128;
// Keep deletion fan-out bounded at the write boundary so a polluted reverse
// index can never make deletion permanently impossible. Small deletions finish
// inline; larger jobs revoke login immediately and drain exact incarnation
// edges from the scheduled App Worker continuation.
const ACCOUNT_PRO_ROOM_LINK_MAX_PER_ACCOUNT = 1000;
const ACCOUNT_DELETE_INLINE_LINK_LIMIT = 32;
const ACCOUNT_DELETE_JOB_EDGE_LIMIT = 128;
const ACCOUNT_DELETE_JOB_MAX_ACCOUNTS = 2;
const ACCOUNT_DELETE_JOB_CONCURRENCY = 16;
const ACCOUNT_DELETION_FENCE_TTL_MS = 10 * 60 * 1000;
const AUTH_JSON_BODY_MAX_BYTES = 8 * 1024;
const GOOGLE_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
const GOOGLE_JWKS_RESPONSE_MAX_BYTES = 256 * 1024;
const GOOGLE_FETCH_TIMEOUT_MS = 10_000;
const JWT_MAX_LENGTH = 20_000;
const JWT_CLOCK_SKEW_SECONDS = 60;
const JWT_MAX_AGE_SECONDS = 60 * 60;
const RETURN_TO_MAX_UTF8_BYTES = 1024;

const ACCOUNT_TABLE = 'mxqr_accounts';
const ACCOUNT_STATS_TABLE = 'mxqr_account_stats';
const SESSION_TABLE = 'mxqr_account_sessions';
const DELETED_SESSION_TABLE = 'mxqr_account_deleted_sessions';
const ACCOUNT_DELETION_TABLE = 'mxqr_account_deletions';
const PRO_ROOM_LINK_TABLE = 'mxqr_account_pro_rooms';
const PRO_ROOM_GENERATION_LINK_TABLE = 'mxqr_account_pro_room_generations';
const OAUTH_FLOW_TABLE = 'mxqr_oauth_flows';
const ACCOUNT_STATS_TOTAL_MAX = Number.MAX_SAFE_INTEGER;
const ACCOUNT_STATS_SESSION_DELTA_MAX = 100;
const ACCOUNT_STATS_LISTENING_SECONDS_DELTA_MAX = 60 * 60;
const ACCOUNT_STATS_TRACK_DELTA_MAX = 1000;
const ACCOUNT_STATS_SCOPE_HEADER = 'X-MXQR-Account-Stats-Scope';
const ACCOUNT_STATS_SCOPE_PURPOSE = 'account-stats-session-scope:v1';
const FLOW_TOKEN_AAD = new TextEncoder().encode('mxqr-oauth-flow:v1');
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ACCOUNT_STATS_SCOPE_RE = /^[A-Za-z0-9_-]{43}$/;
const OAUTH_STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const OAUTH_FLOW_COOKIE_SUFFIX_RE = /^[A-Za-z0-9_-]{16}$/;
const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{22}$/;
const GOOGLE_SUB_RE = /^[A-Za-z0-9_-]{1,255}$/;

let googleJwksCache = {
  expiresAtMs: 0,
  keys: new Map(),
};

function authJson(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...headers,
    },
  });
}

function methodNotAllowed(allow) {
  return authJson({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: allow });
}

function isMissingProRoomGenerationLinkSchemaError(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (
      /no such table:\s*mxqr_account_pro_room_generations/i.test(
        String(current?.message || current),
      )
    ) {
      return true;
    }
    current = current?.cause;
  }
  return false;
}

function appendSetCookies(response, cookies) {
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function redirect(location, status = 302, cookies = []) {
  const response = new Response(null, {
    status,
    headers: {
      Location: location,
      'Cache-Control': 'no-store, max-age=0',
    },
  });
  return cookies.length > 0 ? appendSetCookies(response, cookies) : response;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

function flowCookieName(state) {
  if (typeof state !== 'string' || !OAUTH_STATE_RE.test(state)) return null;
  return `${OAUTH_FLOW_COOKIE_PREFIX}${state.slice(0, OAUTH_FLOW_COOKIE_SUFFIX_LENGTH)}`;
}

function flowCookie(name, value) {
  return `${name}=${value}; Path=/; Max-Age=${OAUTH_FLOW_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function sessionCookie(value) {
  return `${AUTH_SESSION_COOKIE}=${value}; Path=/; Max-Age=${ACCOUNT_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function deletedSessionCookie(value) {
  return `${AUTH_SESSION_COOKIE}=${value}; Path=/; Max-Age=${ACCOUNT_DELETED_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request, name) {
  const rawCookie = request.headers.get('Cookie');
  if (!rawCookie) return null;
  for (const part of rawCookie.split(';')) {
    const cookie = part.trim();
    const separator = cookie.indexOf('=');
    if (separator <= 0 || cookie.slice(0, separator) !== name) continue;
    const value = cookie.slice(separator + 1);
    return value || null;
  }
  return null;
}

function readCookieValues(request, name) {
  const rawCookie = request.headers.get('Cookie');
  if (!rawCookie) return [];
  const values = [];
  for (const part of rawCookie.split(';')) {
    const cookie = part.trim();
    const separator = cookie.indexOf('=');
    if (separator <= 0 || cookie.slice(0, separator) !== name) continue;
    values.push(cookie.slice(separator + 1));
    if (values.length > 1) break;
  }
  return values;
}

function readOAuthFlowCookieEntries(request) {
  const rawCookie = request.headers.get('Cookie');
  if (!rawCookie) return [];
  const entries = [];
  for (const part of rawCookie.split(';')) {
    const cookie = part.trim();
    const separator = cookie.indexOf('=');
    if (separator <= 0) continue;
    const name = cookie.slice(0, separator);
    if (!name.startsWith(OAUTH_FLOW_COOKIE_PREFIX)) continue;
    const suffix = name.slice(OAUTH_FLOW_COOKIE_PREFIX.length);
    if (!OAUTH_FLOW_COOKIE_SUFFIX_RE.test(suffix)) continue;
    entries.push({ name, value: cookie.slice(separator + 1) });
    if (entries.length >= OAUTH_FLOW_COOKIE_SCAN_MAX) break;
  }
  return entries;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value, maxBytes = 32 * 1024) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) return null;
  if (value.length > Math.ceil((maxBytes * 4) / 3) + 4) return null;
  const remainder = value.length % 4;
  if (remainder === 1) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - remainder) % 4);
  try {
    const binary = atob(padded);
    if (binary.length > maxBytes) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch (error) {
    return null;
  }
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function constantTimeStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmacDigest(secret, purpose, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payload = new TextEncoder().encode(`${purpose}\u0000${value}`);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, payload)));
}

async function flowEncryptionKey(secret) {
  const digest = await sha256(new TextEncoder().encode(`mxqr-oauth-flow-key:v1\u0000${secret}`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function sealFlow(payload, secret) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: FLOW_TOKEN_AAD, tagLength: 128 },
      await flowEncryptionKey(secret),
      plaintext,
    ),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

async function openFlow(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const iv = base64UrlToBytes(parts[1], 12);
  const ciphertext = base64UrlToBytes(parts[2], 2048);
  if (!iv || iv.length !== 12 || !ciphertext || ciphertext.length < 17) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: FLOW_TOKEN_AAD, tagLength: 128 },
      await flowEncryptionKey(secret),
      ciphertext,
    );
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (
      typeof payload.state !== 'string' ||
      typeof payload.nonce !== 'string' ||
      typeof payload.verifier !== 'string' ||
      typeof payload.returnTo !== 'string' ||
      !Number.isSafeInteger(payload.issuedAtMs) ||
      !Number.isSafeInteger(payload.expiresAtMs)
    ) {
      return null;
    }
    if (
      payload.issuedAtMs > nowMs + 30_000 ||
      payload.expiresAtMs <= nowMs ||
      payload.expiresAtMs - payload.issuedAtMs > OAUTH_FLOW_TTL_SECONDS * 1000
    ) {
      return null;
    }
    if (
      !OAUTH_STATE_RE.test(payload.state) ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.nonce) ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(payload.verifier)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function pruneOAuthFlowCookies(
  request,
  secret,
  keepCount = OAUTH_FLOW_COOKIE_MAX_ACTIVE - 1,
) {
  const grouped = new Map();
  for (const entry of readOAuthFlowCookieEntries(request)) {
    const values = grouped.get(entry.name) || [];
    values.push(entry.value);
    grouped.set(entry.name, values);
  }

  const valid = [];
  const clearNames = new Set();
  for (const [name, values] of grouped) {
    if (values.length !== 1 || !values[0]) {
      clearNames.add(name);
      continue;
    }
    const flow = await openFlow(values[0], secret);
    if (!flow || flowCookieName(flow.state) !== name) {
      clearNames.add(name);
      continue;
    }
    valid.push({ name, issuedAtMs: flow.issuedAtMs });
  }

  valid.sort((left, right) => {
    const byAge = right.issuedAtMs - left.issuedAtMs;
    if (byAge !== 0) return byAge;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  for (const stale of valid.slice(Math.max(0, keepCount))) clearNames.add(stale.name);
  return [...clearNames].map(clearCookie);
}

function validSecret(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 4096;
}

function validRedirectUri(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.pathname !== '/api/auth/google/callback') return false;
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

function resolveAuthConfig(env) {
  const db = env?.MUSIXQUARE_AUTH_DB;
  const clientId =
    typeof env?.GOOGLE_OAUTH_CLIENT_ID === 'string' ? env.GOOGLE_OAUTH_CLIENT_ID : '';
  const clientSecret =
    typeof env?.GOOGLE_OAUTH_CLIENT_SECRET === 'string' ? env.GOOGLE_OAUTH_CLIENT_SECRET : '';
  const sessionPepper =
    typeof env?.MXQR_AUTH_SESSION_PEPPER === 'string' ? env.MXQR_AUTH_SESSION_PEPPER : '';
  const subjectPepper =
    typeof env?.MXQR_AUTH_SUBJECT_PEPPER === 'string' ? env.MXQR_AUTH_SUBJECT_PEPPER : '';
  const stateSecret =
    typeof env?.MXQR_OAUTH_STATE_SECRET === 'string' ? env.MXQR_OAUTH_STATE_SECRET : '';
  const redirectUri =
    typeof env?.MXQR_AUTH_REDIRECT_URI === 'string' && env.MXQR_AUTH_REDIRECT_URI.trim()
      ? env.MXQR_AUTH_REDIRECT_URI.trim()
      : DEFAULT_REDIRECT_URI;

  if (
    !db ||
    typeof db.prepare !== 'function' ||
    clientId.length < 10 ||
    clientId.length > 512 ||
    clientSecret.length < 8 ||
    clientSecret.length > 4096 ||
    !validSecret(sessionPepper) ||
    !validSecret(subjectPepper) ||
    !validSecret(stateSecret) ||
    !validRedirectUri(redirectUri)
  ) {
    return { configured: false };
  }

  return {
    configured: true,
    db,
    clientId,
    clientSecret,
    sessionPepper,
    subjectPepper,
    stateSecret,
    redirectUri,
  };
}

function sanitizeReturnTo(value, redirectUri) {
  if (typeof value !== 'string' || value.length === 0) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (/[\u0000-\u001F\u007F]/.test(value)) return '/';
  try {
    const base = new URL(redirectUri).origin;
    const resolved = new URL(value, base);
    if (resolved.origin !== base) return '/';
    const normalized = `${resolved.pathname}${resolved.search}${resolved.hash}` || '/';
    // returnTo is encrypted into a host-only cookie together with PKCE state.
    // Bound bytes (not JS code units) so multibyte paths cannot create a token
    // that openFlow rejects or a browser silently drops at its ~4 KiB limit.
    if (new TextEncoder().encode(normalized).byteLength > RETURN_TO_MAX_UTF8_BYTES) return '/';
    return normalized;
  } catch {
    return '/';
  }
}

async function readBodyBytesLimited(stream, contentLength, maxBytes) {
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^\d+$/.test(normalized) || Number(normalized) > maxBytes) return null;
  }
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += bytes.byteLength;
      if (total > maxBytes) {
        await reader.cancel('BODY_TOO_LARGE').catch(() => {});
        return null;
      }
      chunks.push(bytes);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function readJsonObject(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) return null;
  const bytes = await readBodyBytesLimited(
    request.body,
    request.headers.get('Content-Length'),
    AUTH_JSON_BODY_MAX_BYTES,
  );
  if (!bytes || bytes.length === 0) return null;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function mutationAuthorized(request) {
  if (request.headers.get(ACCOUNT_CSRF_HEADER) !== '1') return false;
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) return false;
  } catch {
    return false;
  }
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  return !fetchSite || fetchSite === 'same-origin';
}

async function readResponseTextLimited(response, maxBytes) {
  const bytes = await readBodyBytesLimited(
    response.body,
    response.headers.get('Content-Length'),
    maxBytes,
  );
  if (!bytes) throw new Error('RESPONSE_TOO_LARGE');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function fetchWithTimeout(url, init, timeoutMs = GOOGLE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonText(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function cacheMaxAgeMs(cacheControl) {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl || '');
  if (!match) return 60 * 60 * 1000;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds)) return 60 * 60 * 1000;
  return Math.min(Math.max(seconds, 60), 24 * 60 * 60) * 1000;
}

async function loadGoogleJwks(forceRefresh = false) {
  const nowMs = Date.now();
  if (!forceRefresh && googleJwksCache.expiresAtMs > nowMs && googleJwksCache.keys.size > 0) {
    return googleJwksCache.keys;
  }
  const response = await fetchWithTimeout(GOOGLE_JWKS_ENDPOINT, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('JWKS_UNAVAILABLE');
  const payload = parseJsonText(
    await readResponseTextLimited(response, GOOGLE_JWKS_RESPONSE_MAX_BYTES),
  );
  if (
    !payload ||
    !Array.isArray(payload.keys) ||
    payload.keys.length === 0 ||
    payload.keys.length > 16
  ) {
    throw new Error('JWKS_INVALID');
  }
  const keys = new Map();
  for (const key of payload.keys) {
    if (
      key &&
      typeof key === 'object' &&
      key.kty === 'RSA' &&
      key.alg === 'RS256' &&
      (key.use === undefined || key.use === 'sig') &&
      typeof key.kid === 'string' &&
      /^[A-Za-z0-9._-]{1,128}$/.test(key.kid) &&
      typeof key.n === 'string' &&
      typeof key.e === 'string'
    ) {
      keys.set(key.kid, key);
    }
  }
  if (keys.size === 0) throw new Error('JWKS_INVALID');
  googleJwksCache = {
    expiresAtMs: nowMs + cacheMaxAgeMs(response.headers.get('Cache-Control')),
    keys,
  };
  return keys;
}

function decodeJwtJson(segment, maxBytes) {
  const bytes = base64UrlToBytes(segment, maxBytes);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function verifyGoogleIdToken(idToken, config, expectedNonce, nowMs = Date.now()) {
  if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > JWT_MAX_LENGTH) {
    throw new Error('ID_TOKEN_INVALID');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('ID_TOKEN_INVALID');
  const header = decodeJwtJson(parts[0], 4096);
  const claims = decodeJwtJson(parts[1], 12 * 1024);
  const signature = base64UrlToBytes(parts[2], 1024);
  if (!header || !claims || !signature) throw new Error('ID_TOKEN_INVALID');
  if (
    header.alg !== 'RS256' ||
    typeof header.kid !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(header.kid)
  ) {
    throw new Error('ID_TOKEN_INVALID');
  }

  let keys = await loadGoogleJwks(false);
  let jwk = keys.get(header.kid);
  if (!jwk) {
    keys = await loadGoogleJwks(true);
    jwk = keys.get(header.kid);
  }
  if (!jwk) throw new Error('ID_TOKEN_INVALID');

  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    throw new Error('ID_TOKEN_INVALID');
  }
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const verified = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    publicKey,
    signature,
    signed,
  );
  if (!verified) throw new Error('ID_TOKEN_INVALID');

  const nowSeconds = Math.floor(nowMs / 1000);
  const issuerValid =
    claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  const audience = claims.aud;
  const audienceValid =
    (typeof audience === 'string' && audience === config.clientId) ||
    (Array.isArray(audience) &&
      audience.length > 0 &&
      audience.every((entry) => typeof entry === 'string') &&
      audience.includes(config.clientId) &&
      (audience.length === 1 || claims.azp === config.clientId));
  const authorizedPartyValid = claims.azp === undefined || claims.azp === config.clientId;
  if (
    !issuerValid ||
    !audienceValid ||
    !authorizedPartyValid ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= nowSeconds - JWT_CLOCK_SKEW_SECONDS ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat > nowSeconds + JWT_CLOCK_SKEW_SECONDS ||
    claims.iat < nowSeconds - JWT_MAX_AGE_SECONDS ||
    (claims.nbf !== undefined &&
      (!Number.isSafeInteger(claims.nbf) || claims.nbf > nowSeconds + JWT_CLOCK_SKEW_SECONDS)) ||
    !constantTimeStringEqual(claims.nonce, expectedNonce) ||
    typeof claims.sub !== 'string' ||
    !GOOGLE_SUB_RE.test(claims.sub) ||
    typeof claims.email !== 'string' ||
    claims.email.length === 0 ||
    claims.email.length > 320 ||
    claims.email_verified !== true
  ) {
    throw new Error('ID_TOKEN_INVALID');
  }
  return { sub: claims.sub };
}

async function exchangeAuthorizationCode(code, verifier, config) {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const response = await fetchWithTimeout(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: body.toString(),
  });
  const payload = parseJsonText(
    await readResponseTextLimited(response, GOOGLE_TOKEN_RESPONSE_MAX_BYTES),
  );
  if (!response.ok || !payload || typeof payload.id_token !== 'string') {
    throw new Error('TOKEN_EXCHANGE_FAILED');
  }
  return payload.id_token;
}

function bindStatement(db, sql, values = []) {
  const statement = db.prepare(sql);
  return values.length > 0 ? statement.bind(...values) : statement;
}

async function d1First(db, sql, values = []) {
  const statement = bindStatement(db, sql, values);
  if (typeof statement.first === 'function') return (await statement.first()) || null;
  const result = await statement.all();
  return result?.results?.[0] || null;
}

async function d1Run(db, sql, values = []) {
  return bindStatement(db, sql, values).run();
}

async function d1All(db, sql, values = []) {
  const result = await bindStatement(db, sql, values).all();
  return Array.isArray(result?.results) ? result.results : [];
}

function d1ChangeCount(result) {
  const changes = result?.meta?.changes ?? result?.changes;
  return Number.isSafeInteger(changes) && changes >= 0 ? changes : null;
}

async function d1Batch(db, statements) {
  const prepared = statements.map(({ sql, values }) => bindStatement(db, sql, values));
  if (typeof db.batch === 'function') return db.batch(prepared);
  const results = [];
  for (const statement of prepared) results.push(await statement.run());
  return results;
}

async function createAccountSession(config, googleSub, nowMs = Date.now()) {
  const subjectHash = await hmacDigest(config.subjectPepper, 'google-subject:v1', googleSub);
  const proposedAccountId = `acct_${randomToken(16)}`;
  const accountUpsert = await d1Run(
    config.db,
    `INSERT INTO ${ACCOUNT_TABLE}
       (account_id, google_subject_hash, nickname, profile_complete, status, created_at, updated_at)
     VALUES (?1, ?2, NULL, 0, 'active', ?3, ?3)
     ON CONFLICT(google_subject_hash) DO UPDATE SET updated_at = excluded.updated_at`,
    [proposedAccountId, subjectHash, nowMs],
  );
  if (d1ChangeCount(accountUpsert) !== 1) throw new Error('ACCOUNT_UNAVAILABLE');
  const account = await d1First(
    config.db,
    `SELECT account_id, nickname, profile_complete, status
       FROM ${ACCOUNT_TABLE}
      WHERE google_subject_hash = ?1
      LIMIT 1`,
    [subjectHash],
  );
  if (!account || !ACCOUNT_ID_RE.test(account.account_id) || account.status !== 'active') {
    throw new Error('ACCOUNT_UNAVAILABLE');
  }

  const token = randomToken(32);
  const sessionHash = await hmacDigest(config.sessionPepper, 'account-session:v1', token);
  const expiresAt = nowMs + ACCOUNT_SESSION_TTL_SECONDS * 1000;
  const [sessionInsert] = await d1Batch(config.db, [
    {
      sql: `INSERT INTO ${SESSION_TABLE}
              (session_hash, account_id, created_at, last_seen_at, expires_at)
            VALUES (?1, ?2, ?3, ?3, ?4)`,
      values: [sessionHash, account.account_id, nowMs, expiresAt],
    },
    {
      // Always retain the just-issued browser plus the 127 most recently used
      // others. D1 batch is atomic, so a failed trim cannot leave an unbounded
      // insert behind.
      sql: `DELETE FROM ${SESSION_TABLE}
             WHERE account_id = ?1
               AND session_hash <> ?2
               AND session_hash NOT IN (
                 SELECT session_hash
                   FROM ${SESSION_TABLE}
                  WHERE account_id = ?1 AND session_hash <> ?2
                  ORDER BY last_seen_at DESC, created_at DESC, session_hash DESC
                  LIMIT ${ACCOUNT_SESSION_MAX_PER_ACCOUNT - 1}
               )`,
      values: [account.account_id, sessionHash],
    },
    {
      sql: `DELETE FROM ${DELETED_SESSION_TABLE} WHERE expires_at <= ?1`,
      values: [nowMs],
    },
  ]);
  if (d1ChangeCount(sessionInsert) !== 1) throw new Error('ACCOUNT_UNAVAILABLE');
  return {
    token,
    account: accountResponse(account),
  };
}

function accountResponse(row) {
  return {
    nickname: typeof row.nickname === 'string' ? row.nickname : '',
    profileComplete: row.profile_complete === 1 || row.profile_complete === true,
  };
}

function accountStatsResponse(row) {
  if (!row) return { sessionCount: 0, listeningSeconds: 0, trackCount: 0 };
  const sessionCount = row.session_count;
  const listeningSeconds = row.listening_seconds;
  const trackCount = row.track_count;
  if (
    typeof sessionCount !== 'number' ||
    !Number.isSafeInteger(sessionCount) ||
    sessionCount < 0 ||
    typeof listeningSeconds !== 'number' ||
    !Number.isSafeInteger(listeningSeconds) ||
    listeningSeconds < 0 ||
    typeof trackCount !== 'number' ||
    !Number.isSafeInteger(trackCount) ||
    trackCount < 0
  ) {
    throw new Error('ACCOUNT_STATS_INVALID');
  }
  return { sessionCount, listeningSeconds, trackCount };
}

async function readAccountStats(db, accountId) {
  const row = await d1First(
    db,
    `SELECT session_count, listening_seconds, track_count
       FROM ${ACCOUNT_STATS_TABLE}
      WHERE account_id = ?1
      LIMIT 1`,
    [accountId],
  );
  return accountStatsResponse(row);
}

async function accountStatsScope(config, sessionHash) {
  return hmacDigest(config.sessionPepper, ACCOUNT_STATS_SCOPE_PURPOSE, sessionHash);
}

async function resolveStoredSession(request, config, { touch = true } = {}) {
  const token = readCookie(request, AUTH_SESSION_COOKIE);
  if (!token || !SESSION_TOKEN_RE.test(token)) {
    return { authenticated: false, clearCookie: Boolean(token) };
  }
  const sessionHash = await hmacDigest(config.sessionPepper, 'account-session:v1', token);
  const nowMs = Date.now();
  const row = await d1First(
    config.db,
    `SELECT s.session_hash, s.account_id, s.last_seen_at, s.expires_at,
            a.nickname, a.profile_complete, a.status
       FROM ${SESSION_TABLE} s
       JOIN ${ACCOUNT_TABLE} a ON a.account_id = s.account_id
      WHERE s.session_hash = ?1
      LIMIT 1`,
    [sessionHash],
  );
  if (!row || !ACCOUNT_ID_RE.test(row.account_id) || row.status !== 'active') {
    const deletedSession = await d1First(
      config.db,
      `SELECT session_hash, account_id, deleted_at, expires_at
         FROM ${DELETED_SESSION_TABLE}
        WHERE session_hash = ?1
        LIMIT 1`,
      [sessionHash],
    );
    if (
      deletedSession &&
      ACCOUNT_ID_RE.test(deletedSession.account_id || '') &&
      Number.isSafeInteger(deletedSession.expires_at) &&
      deletedSession.expires_at > nowMs
    ) {
      return {
        authenticated: false,
        clearCookie: false,
        deletedAccountId: deletedSession.account_id,
        deletedSessionExpiresAt: deletedSession.expires_at,
      };
    }
    if (deletedSession) {
      await d1Run(config.db, `DELETE FROM ${DELETED_SESSION_TABLE} WHERE session_hash = ?1`, [
        sessionHash,
      ]);
    }
    return { authenticated: false, clearCookie: true };
  }
  if (!Number.isSafeInteger(row.expires_at) || row.expires_at <= nowMs) {
    await d1Run(config.db, `DELETE FROM ${SESSION_TABLE} WHERE session_hash = ?1`, [sessionHash]);
    return { authenticated: false, clearCookie: true };
  }
  if (
    touch &&
    (!Number.isSafeInteger(row.last_seen_at) ||
      row.last_seen_at <= nowMs - ACCOUNT_SESSION_TOUCH_INTERVAL_MS)
  ) {
    await d1Run(
      config.db,
      `UPDATE ${SESSION_TABLE} SET last_seen_at = ?1 WHERE session_hash = ?2`,
      [nowMs, sessionHash],
    );
  }
  return {
    authenticated: true,
    accountId: row.account_id,
    sessionHash,
    account: accountResponse(row),
  };
}

async function requireSession(request, config) {
  const session = await resolveStoredSession(request, config);
  if (!session.authenticated) {
    const response = authJson({ error: 'AUTH_REQUIRED' }, 401);
    return {
      error: session.clearCookie
        ? appendSetCookies(response, [clearCookie(AUTH_SESSION_COOKIE)])
        : response,
    };
  }
  return { session };
}

async function handleGoogleStart(request, config, url) {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const canonicalOrigin = new URL(config.redirectUri).origin;
  if (url.origin !== canonicalOrigin) {
    const canonical = new URL(url.pathname, canonicalOrigin);
    canonical.search = url.search;
    return redirect(canonical.toString(), 307);
  }
  if (
    url.searchParams.has('error') ||
    [...url.searchParams.keys()].some((key) => key !== 'returnTo')
  ) {
    return authJson({ error: 'INVALID_REQUEST' }, 400);
  }
  const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo') || '/', config.redirectUri);
  const staleFlowCookies = await pruneOAuthFlowCookies(request, config.stateSecret);
  const state = randomToken(32);
  const cookieName = flowCookieName(state);
  if (!cookieName) return authJson({ error: 'AUTH_TEMPORARILY_UNAVAILABLE' }, 503);
  const nonce = randomToken(32);
  const verifier = randomToken(32);
  const challenge = bytesToBase64Url(await sha256(new TextEncoder().encode(verifier)));
  const issuedAtMs = Date.now();
  const sealed = await sealFlow(
    {
      state,
      nonce,
      verifier,
      returnTo,
      issuedAtMs,
      expiresAtMs: issuedAtMs + OAUTH_FLOW_TTL_SECONDS * 1000,
    },
    config.stateSecret,
  );
  const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return redirect(authorizationUrl.toString(), 302, [
    ...staleFlowCookies,
    flowCookie(cookieName, sealed),
  ]);
}

async function callbackError(code, status = 400, { clearFlowCookieName = null } = {}) {
  const response = authJson({ error: code }, status);
  return clearFlowCookieName
    ? appendSetCookies(response, [clearCookie(clearFlowCookieName)])
    : response;
}

function callbackOutcomeRedirect(config, flow, outcome, cookieName) {
  const destination = new URL(flow.returnTo, new URL(config.redirectUri).origin);
  destination.searchParams.set('accountAuth', outcome);
  return redirect(destination.toString(), 303, [clearCookie(cookieName)]);
}

function hasOnlySingleValueParameters(searchParams, allowedKeys) {
  const seen = new Set();
  for (const key of searchParams.keys()) {
    if (!allowedKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

async function consumeOAuthFlow(config, flow) {
  const stateHash = await hmacDigest(config.stateSecret, 'oauth-state:v1', flow.state);
  const consumed = await d1Run(
    config.db,
    `INSERT OR IGNORE INTO ${OAUTH_FLOW_TABLE} (state_hash, created_at, expires_at)
     VALUES (?1, ?2, ?3)`,
    [stateHash, Date.now(), flow.expiresAtMs],
  );
  return d1ChangeCount(consumed) === 1;
}

async function handleGoogleCallback(request, config, url) {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const states = url.searchParams.getAll('state');
  if (states.length !== 1 || typeof states[0] !== 'string' || !OAUTH_STATE_RE.test(states[0])) {
    return callbackError('AUTH_FLOW_INVALID');
  }
  const returnedState = states[0];
  const cookieName = flowCookieName(returnedState);
  if (!cookieName) return callbackError('AUTH_FLOW_INVALID');
  const cookieValues = readCookieValues(request, cookieName);
  if (cookieValues.length !== 1 || !cookieValues[0]) return callbackError('AUTH_FLOW_INVALID');
  const flow = await openFlow(cookieValues[0], config.stateSecret);
  if (!flow || !constantTimeStringEqual(returnedState, flow.state)) {
    return callbackError('AUTH_FLOW_INVALID');
  }

  // The provider must echo the exact one-time state on both success and
  // failure. Selecting a state-scoped cookie before decryption lets multiple
  // tabs authenticate concurrently without one flow overwriting another.

  const errors = url.searchParams.getAll('error');
  const codes = url.searchParams.getAll('code');
  // Google includes its RFC 9207 authorization-server issuer on both success
  // and error responses. Require the exact singleton value before trusting the
  // rest of either response shape.
  const issuers = url.searchParams.getAll('iss');
  const hasValidIssuer =
    issuers.length === 1 && issuers[0] === GOOGLE_AUTHORIZATION_RESPONSE_ISSUER;
  const providerDenied =
    hasValidIssuer &&
    errors.length === 1 &&
    errors[0].length > 0 &&
    errors[0].length <= 256 &&
    codes.length === 0 &&
    hasOnlySingleValueParameters(
      url.searchParams,
      new Set(['error', 'error_description', 'error_uri', 'state', 'iss']),
    ) &&
    (url.searchParams.get('error_description')?.length ?? 0) <= 1024 &&
    (url.searchParams.get('error_uri')?.length ?? 0) <= 2048;
  const successfulResponse =
    hasValidIssuer &&
    codes.length === 1 &&
    codes[0].length >= 8 &&
    codes[0].length <= 4096 &&
    errors.length === 0 &&
    hasOnlySingleValueParameters(
      url.searchParams,
      new Set(['code', 'state', 'scope', 'authuser', 'prompt', 'iss']),
    );

  try {
    if (!(await consumeOAuthFlow(config, flow))) {
      return callbackError('AUTH_FLOW_INVALID', 400, { clearFlowCookieName: cookieName });
    }
  } catch {
    return callbackOutcomeRedirect(config, flow, 'error', cookieName);
  }

  if (!providerDenied && !successfulResponse) {
    return callbackOutcomeRedirect(config, flow, 'error', cookieName);
  }
  if (providerDenied) return callbackOutcomeRedirect(config, flow, 'cancelled', cookieName);

  const code = codes[0];

  let identity;
  try {
    const idToken = await exchangeAuthorizationCode(code, flow.verifier, config);
    identity = await verifyGoogleIdToken(idToken, config, flow.nonce);
  } catch (error) {
    const providerFailure =
      error instanceof Error &&
      (error.message === 'TOKEN_EXCHANGE_FAILED' ||
        error.message === 'JWKS_UNAVAILABLE' ||
        error.message === 'JWKS_INVALID' ||
        error.name === 'AbortError');
    console.warn(
      '[AccountAuth] Google callback failed',
      providerFailure ? 'provider-unavailable' : 'assertion-invalid',
    );
    return callbackOutcomeRedirect(config, flow, 'error', cookieName);
  }

  try {
    const { token } = await createAccountSession(config, identity.sub);
    const destination = new URL(flow.returnTo, new URL(config.redirectUri).origin).toString();
    return redirect(destination, 303, [clearCookie(cookieName), sessionCookie(token)]);
  } catch {
    return callbackOutcomeRedirect(config, flow, 'error', cookieName);
  }
}

async function handleSession(request, config) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
  try {
    const session = await resolveStoredSession(request, config);
    const body = session.authenticated
      ? {
          configured: true,
          authenticated: true,
          account: session.account,
          statsScope: await accountStatsScope(config, session.sessionHash),
        }
      : { configured: true, authenticated: false, account: null, statsScope: null };
    const response =
      request.method === 'HEAD'
        ? new Response(null, {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store, max-age=0',
            },
          })
        : authJson(body);
    return session.clearCookie
      ? appendSetCookies(response, [clearCookie(AUTH_SESSION_COOKIE)])
      : response;
  } catch {
    return authJson({ error: 'AUTH_TEMPORARILY_UNAVAILABLE' }, 503);
  }
}

async function handleProfile(request, config) {
  if (request.method !== 'PATCH') return methodNotAllowed('PATCH');
  if (!mutationAuthorized(request)) return authJson({ error: 'CSRF_FAILED' }, 403);
  const body = await readJsonObject(request);
  if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'nickname')) {
    return authJson({ error: 'INVALID_REQUEST' }, 400);
  }
  const nickname = normalizeNewAccountNickname(body.nickname);
  if (!nickname) return authJson({ error: 'NICKNAME_INVALID' }, 400);
  const nicknameKey = accountNicknameKey(nickname);
  if (!nicknameKey) return authJson({ error: 'NICKNAME_INVALID' }, 400);
  try {
    const resolved = await requireSession(request, config);
    if (resolved.error) return resolved.error;
    let updated;
    try {
      updated = await d1Run(
        config.db,
        `UPDATE ${ACCOUNT_TABLE}
            SET nickname = ?1, nickname_key = ?2, profile_complete = 1, updated_at = ?3
          WHERE account_id = ?4 AND status = 'active'`,
        [nickname, nicknameKey, Date.now(), resolved.session.accountId],
      );
    } catch (error) {
      // D1's UNIQUE index is the race-safe source of truth. Re-read only after
      // a failed write so we can distinguish an ordinary nickname collision
      // from schema, availability, and unrelated constraint failures without
      // depending on the provider's error-message wording.
      const existing = await d1First(
        config.db,
        `SELECT account_id FROM ${ACCOUNT_TABLE} WHERE nickname_key = ?1 LIMIT 1`,
        [nicknameKey],
      );
      if (existing?.account_id && existing.account_id !== resolved.session.accountId) {
        return authJson({ error: 'NICKNAME_TAKEN' }, 409);
      }
      throw error;
    }
    if (d1ChangeCount(updated) !== 1) {
      return authJson({ error: 'AUTH_TEMPORARILY_UNAVAILABLE' }, 503);
    }
    return authJson({
      configured: true,
      authenticated: true,
      account: {
        nickname,
        profileComplete: true,
      },
      statsScope: await accountStatsScope(config, resolved.session.sessionHash),
    });
  } catch {
    return authJson({ error: 'AUTH_TEMPORARILY_UNAVAILABLE' }, 503);
  }
}

async function handleAccountStats(request, config) {
  if (request.method !== 'GET' && request.method !== 'PATCH') {
    return methodNotAllowed('GET, PATCH');
  }
  if (request.method === 'PATCH' && !mutationAuthorized(request)) {
    return authJson({ error: 'CSRF_FAILED' }, 403);
  }

  let deltas = null;
  let expectedStatsScope = null;
  if (request.method === 'PATCH') {
    expectedStatsScope = request.headers.get(ACCOUNT_STATS_SCOPE_HEADER);
    if (!expectedStatsScope || !ACCOUNT_STATS_SCOPE_RE.test(expectedStatsScope)) {
      return authJson({ error: 'INVALID_REQUEST' }, 400);
    }
    const body = await readJsonObject(request);
    const keys = body ? Object.keys(body).sort() : [];
    if (
      !body ||
      keys.length !== 3 ||
      keys[0] !== 'listeningSecondsDelta' ||
      keys[1] !== 'sessionCountDelta' ||
      keys[2] !== 'trackCountDelta' ||
      !Number.isSafeInteger(body.sessionCountDelta) ||
      body.sessionCountDelta < 0 ||
      body.sessionCountDelta > ACCOUNT_STATS_SESSION_DELTA_MAX ||
      !Number.isSafeInteger(body.listeningSecondsDelta) ||
      body.listeningSecondsDelta < 0 ||
      body.listeningSecondsDelta > ACCOUNT_STATS_LISTENING_SECONDS_DELTA_MAX ||
      !Number.isSafeInteger(body.trackCountDelta) ||
      body.trackCountDelta < 0 ||
      body.trackCountDelta > ACCOUNT_STATS_TRACK_DELTA_MAX ||
      (body.sessionCountDelta === 0 &&
        body.listeningSecondsDelta === 0 &&
        body.trackCountDelta === 0)
    ) {
      return authJson({ error: 'INVALID_REQUEST' }, 400);
    }
    deltas = {
      sessionCount: body.sessionCountDelta,
      listeningSeconds: body.listeningSecondsDelta,
      trackCount: body.trackCountDelta,
    };
  }

  try {
    const resolved = await requireSession(request, config);
    if (resolved.error) return resolved.error;
    const accountId = resolved.session.accountId;
    if (deltas) {
      const currentStatsScope = await accountStatsScope(config, resolved.session.sessionHash);
      if (!constantTimeStringEqual(expectedStatsScope, currentStatsScope)) {
        return authJson({ error: 'ACCOUNT_STATS_SCOPE_MISMATCH' }, 409);
      }
      const updated = await d1Run(
        config.db,
        `INSERT INTO ${ACCOUNT_STATS_TABLE}
           (account_id, session_count, listening_seconds, track_count)
         SELECT account.account_id, ?2, ?3, ?4
           FROM ${ACCOUNT_TABLE} account
          WHERE account.account_id = ?1
            AND account.status = 'active'
            AND NOT EXISTS (
              SELECT 1
                FROM ${ACCOUNT_DELETION_TABLE} deletion
               WHERE deletion.account_id = account.account_id
            )
         ON CONFLICT(account_id) DO UPDATE SET
           session_count = ${ACCOUNT_STATS_TABLE}.session_count + excluded.session_count,
           listening_seconds =
             ${ACCOUNT_STATS_TABLE}.listening_seconds + excluded.listening_seconds,
           track_count = ${ACCOUNT_STATS_TABLE}.track_count + excluded.track_count
         WHERE ${ACCOUNT_STATS_TABLE}.session_count <= ?5 - excluded.session_count
           AND ${ACCOUNT_STATS_TABLE}.listening_seconds <= ?5 - excluded.listening_seconds
           AND ${ACCOUNT_STATS_TABLE}.track_count <= ?5 - excluded.track_count`,
        [
          accountId,
          deltas.sessionCount,
          deltas.listeningSeconds,
          deltas.trackCount,
          ACCOUNT_STATS_TOTAL_MAX,
        ],
      );
      if (d1ChangeCount(updated) !== 1) {
        const current = await readAccountStats(config.db, accountId);
        const limitReached =
          current.sessionCount > ACCOUNT_STATS_TOTAL_MAX - deltas.sessionCount ||
          current.listeningSeconds > ACCOUNT_STATS_TOTAL_MAX - deltas.listeningSeconds ||
          current.trackCount > ACCOUNT_STATS_TOTAL_MAX - deltas.trackCount;
        return authJson(
          { error: limitReached ? 'ACCOUNT_STATS_LIMIT_REACHED' : 'ACCOUNT_STATS_UPDATE_REJECTED' },
          409,
        );
      }
    }
    return authJson({ stats: await readAccountStats(config.db, accountId) });
  } catch {
    return authJson({ error: 'AUTH_TEMPORARILY_UNAVAILABLE' }, 503);
  }
}

async function handleLogout(request, config, allSessions) {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  if (!mutationAuthorized(request)) return authJson({ error: 'CSRF_FAILED' }, 403);
  const body = await readJsonObject(request);
  if (!body || Object.keys(body).length !== 0) return authJson({ error: 'INVALID_REQUEST' }, 400);
  try {
    const resolved = await requireSession(request, config);
    if (resolved.error) return resolved.error;
    if (allSessions) {
      await d1Run(config.db, `DELETE FROM ${SESSION_TABLE} WHERE account_id = ?1`, [
        resolved.session.accountId,
      ]);
    } else {
      await d1Run(config.db, `DELETE FROM ${SESSION_TABLE} WHERE session_hash = ?1`, [
        resolved.session.sessionHash,
      ]);
    }
    return appendSetCookies(authJson({ ok: true }), [clearCookie(AUTH_SESSION_COOKIE)]);
  } catch {
    return authJson({ error: 'AUTH_TEMPORARILY_UNAVAILABLE' }, 503);
  }
}

async function readAccountProRoomLinks(
  db,
  accountId,
  limit = ACCOUNT_PRO_ROOM_LINK_MAX_PER_ACCOUNT + 1,
) {
  const boundedLimit = Math.max(
    1,
    Math.min(ACCOUNT_PRO_ROOM_LINK_MAX_PER_ACCOUNT + 1, Number(limit) || 1),
  );
  const legacyLinks = (
    await d1All(
      db,
      `SELECT room_code FROM ${PRO_ROOM_LINK_TABLE}
        WHERE account_id = ?1
        ORDER BY room_code ASC
        LIMIT ?2`,
      [accountId, boundedLimit],
    )
  ).map((row) => ({
    room_code: row?.room_code,
    room_generation: LEGACY_PRO_ROOM_GENERATION,
  }));
  let generationLinksConfigured = true;
  let generationLinks = [];
  try {
    generationLinks = await d1All(
      db,
      `SELECT room_code, room_generation
         FROM ${PRO_ROOM_GENERATION_LINK_TABLE}
        WHERE account_id = ?1
          AND room_generation > 0
        ORDER BY room_code ASC, room_generation ASC
        LIMIT ?2`,
      [accountId, boundedLimit],
    );
  } catch (error) {
    // Additive rollout compatibility. A later generation is never created
    // until the v2 reverse-index schema exists, so falling back is safe only
    // for the legacy table and its implicit generation zero.
    if (!isMissingProRoomGenerationLinkSchemaError(error)) throw error;
    generationLinksConfigured = false;
    generationLinks = [];
  }
  const linksByIncarnation = new Map();
  for (const row of [...legacyLinks, ...generationLinks]) {
    const roomCode = typeof row?.room_code === 'string' ? row.room_code : '';
    const roomGeneration = Number(row?.room_generation);
    const key = `${roomCode}:${roomGeneration}`;
    if (!linksByIncarnation.has(key)) {
      linksByIncarnation.set(key, { roomCode, roomGeneration });
    }
  }
  return {
    generationLinksConfigured,
    links: [...linksByIncarnation.values()]
      .sort(
        (left, right) =>
          left.roomCode.localeCompare(right.roomCode) || left.roomGeneration - right.roomGeneration,
      )
      .slice(0, boundedLimit),
  };
}

function accountDeletionSessionStatements(accountId, deletedAt, expiresAt) {
  return [
    {
      sql: `DELETE FROM ${DELETED_SESSION_TABLE} WHERE expires_at <= ?1`,
      values: [deletedAt],
    },
    {
      sql: `INSERT OR REPLACE INTO ${DELETED_SESSION_TABLE}
              (session_hash, account_id, deleted_at, expires_at)
            SELECT session_hash, account_id, ?2, ?3
              FROM ${SESSION_TABLE}
             WHERE account_id = ?1`,
      values: [accountId, deletedAt, expiresAt],
    },
    {
      sql: `DELETE FROM ${SESSION_TABLE} WHERE account_id = ?1`,
      values: [accountId],
    },
  ];
}

function accountDeletionFinalStatements(accountId, generationLinksConfigured) {
  return [
    {
      sql: `DELETE FROM ${SESSION_TABLE} WHERE account_id = ?1`,
      values: [accountId],
    },
    {
      sql: `DELETE FROM ${PRO_ROOM_LINK_TABLE} WHERE account_id = ?1`,
      values: [accountId],
    },
    ...(generationLinksConfigured
      ? [
          {
            sql: `DELETE FROM ${PRO_ROOM_GENERATION_LINK_TABLE} WHERE account_id = ?1`,
            values: [accountId],
          },
        ]
      : []),
    {
      sql: `DELETE FROM ${ACCOUNT_DELETION_TABLE} WHERE account_id = ?1`,
      values: [accountId],
    },
    {
      sql: `DELETE FROM ${ACCOUNT_TABLE} WHERE account_id = ?1`,
      values: [accountId],
    },
  ];
}

async function finalizeAccountDeletion(db, accountId, generationLinksConfigured, deletedAt) {
  const tombstoneExpiresAt = deletedAt + ACCOUNT_DELETED_SESSION_TTL_SECONDS * 1000;
  await d1Batch(db, [
    ...accountDeletionSessionStatements(accountId, deletedAt, tombstoneExpiresAt),
    ...accountDeletionFinalStatements(accountId, generationLinksConfigured),
  ]);
}

async function purgeAccountProRoomLinks(
  db,
  accountId,
  links,
  purgeProRoomAccountAuthority,
  generationLinksConfigured = true,
) {
  let purged = 0;
  let failed = 0;
  for (let offset = 0; offset < links.length; offset += ACCOUNT_DELETE_JOB_CONCURRENCY) {
    const batch = links.slice(offset, offset + ACCOUNT_DELETE_JOB_CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map(async (link) => {
        if (!/^0\d{5}$/.test(link.roomCode) || !isProRoomGeneration(link.roomGeneration)) {
          return false;
        }
        try {
          return (
            (await purgeProRoomAccountAuthority({
              accountId,
              roomCode: link.roomCode,
              roomGeneration: link.roomGeneration,
            })) === true
          );
        } catch {
          return false;
        }
      }),
    );
    const deletionStatements = [];
    for (let index = 0; index < batch.length; index += 1) {
      const link = batch[index];
      if (!outcomes[index]) {
        failed += 1;
        continue;
      }
      purged += 1;
      if (link.roomGeneration === LEGACY_PRO_ROOM_GENERATION) {
        deletionStatements.push({
          sql: `DELETE FROM ${PRO_ROOM_LINK_TABLE}
                 WHERE account_id = ?1 AND room_code = ?2`,
          values: [accountId, link.roomCode],
        });
        // The reusable-code migration backfilled generation zero into the
        // composite table. Remove both representations only after the exact
        // legacy incarnation confirms its idempotent purge.
        if (generationLinksConfigured) {
          deletionStatements.push({
            sql: `DELETE FROM ${PRO_ROOM_GENERATION_LINK_TABLE}
                   WHERE account_id = ?1 AND room_code = ?2 AND room_generation = 0`,
            values: [accountId, link.roomCode],
          });
        }
      } else {
        deletionStatements.push({
          sql: `DELETE FROM ${PRO_ROOM_GENERATION_LINK_TABLE}
                 WHERE account_id = ?1 AND room_code = ?2 AND room_generation = ?3`,
          values: [accountId, link.roomCode, link.roomGeneration],
        });
      }
    }
    if (deletionStatements.length > 0) {
      await d1Batch(db, deletionStatements);
    }
  }
  return { purged, failed };
}

async function handleAccountDelete(request, config, integrations = {}) {
  if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
  if (!mutationAuthorized(request)) return authJson({ error: 'CSRF_FAILED' }, 403);
  const body = await readJsonObject(request);
  if (!body || Object.keys(body).length !== 1 || body.confirm !== true) {
    return authJson({ error: 'ACCOUNT_DELETE_CONFIRMATION_REQUIRED' }, 400);
  }
  let fencedAccountId = null;
  let deletionStartedAt = null;
  try {
    const resolved = await requireSession(request, config);
    if (resolved.error) return resolved.error;
    const accountId = resolved.session.accountId;
    const deletionSessionToken = readCookie(request, AUTH_SESSION_COOKIE);
    deletionStartedAt = Date.now();
    const deletionFence = await d1Run(
      config.db,
      `INSERT INTO ${ACCOUNT_DELETION_TABLE} (account_id, started_at)
       VALUES (?1, ?2)
       ON CONFLICT(account_id) DO UPDATE SET started_at = excluded.started_at
       WHERE ${ACCOUNT_DELETION_TABLE}.started_at <= ?3`,
      [accountId, deletionStartedAt, deletionStartedAt - ACCOUNT_DELETION_FENCE_TTL_MS],
    );
    if (d1ChangeCount(deletionFence) !== 1) {
      return authJson({ error: 'ACCOUNT_DELETE_IN_PROGRESS' }, 409);
    }
    fencedAccountId = accountId;
    const purgeProRoomAccountAuthority = integrations?.purgeProRoomAccountAuthority;
    const { generationLinksConfigured, links: linkedRooms } = await readAccountProRoomLinks(
      config.db,
      accountId,
      ACCOUNT_PRO_ROOM_LINK_MAX_PER_ACCOUNT + 1,
    );
    if (linkedRooms.length > ACCOUNT_PRO_ROOM_LINK_MAX_PER_ACCOUNT) {
      throw new Error('ACCOUNT_DELETE_CLEANUP_UNAVAILABLE');
    }
    if (linkedRooms.length > 0 && typeof purgeProRoomAccountAuthority !== 'function') {
      throw new Error('ACCOUNT_DELETE_CLEANUP_UNAVAILABLE');
    }
    if (linkedRooms.length > ACCOUNT_DELETE_INLINE_LINK_LIMIT) {
      const tombstoneExpiresAt = deletionStartedAt + ACCOUNT_DELETED_SESSION_TTL_SECONDS * 1000;
      const [disabled] = await d1Batch(config.db, [
        {
          sql: `UPDATE ${ACCOUNT_TABLE}
                   SET status = 'disabled', updated_at = ?2
                 WHERE account_id = ?1 AND status = 'active'`,
          values: [accountId, deletionStartedAt],
        },
        ...accountDeletionSessionStatements(accountId, deletionStartedAt, tombstoneExpiresAt),
      ]);
      if (d1ChangeCount(disabled) !== 1) {
        throw new Error('ACCOUNT_DELETE_CLEANUP_UNAVAILABLE');
      }
      // From this point the deletion is committed from the user's perspective:
      // sessions and attachment authority are revoked. The durable D1 fence
      // remains until the scheduled continuation has purged every exact room
      // incarnation and removed the account row.
      fencedAccountId = null;
      try {
        integrations?.deferAccountDeletion?.(accountId);
      } catch {
        // The minute cron independently resumes every durable deletion job.
      }
      return appendSetCookies(authJson({ ok: true, pending: true }, 202), [
        deletionSessionToken && SESSION_TOKEN_RE.test(deletionSessionToken)
          ? deletedSessionCookie(deletionSessionToken)
          : clearCookie(AUTH_SESSION_COOKIE),
      ]);
    }
    const cleanup = await purgeAccountProRoomLinks(
      config.db,
      accountId,
      linkedRooms,
      purgeProRoomAccountAuthority,
      generationLinksConfigured,
    );
    if (cleanup.failed !== 0 || cleanup.purged !== linkedRooms.length) {
      throw new Error('ACCOUNT_DELETE_CLEANUP_UNAVAILABLE');
    }
    await finalizeAccountDeletion(
      config.db,
      accountId,
      generationLinksConfigured,
      deletionStartedAt,
    );
    fencedAccountId = null;
    return appendSetCookies(authJson({ ok: true }), [
      deletionSessionToken && SESSION_TOKEN_RE.test(deletionSessionToken)
        ? deletedSessionCookie(deletionSessionToken)
        : clearCookie(AUTH_SESSION_COOKIE),
    ]);
  } catch (error) {
    if (fencedAccountId && Number.isSafeInteger(deletionStartedAt)) {
      await d1Run(
        config.db,
        `DELETE FROM ${ACCOUNT_DELETION_TABLE}
          WHERE account_id = ?1 AND started_at = ?2`,
        [fencedAccountId, deletionStartedAt],
      ).catch(() => {});
    }
    return authJson(
      {
        error:
          error instanceof Error && error.message === 'ACCOUNT_DELETE_CLEANUP_UNAVAILABLE'
            ? 'ACCOUNT_DELETE_CLEANUP_UNAVAILABLE'
            : 'AUTH_TEMPORARILY_UNAVAILABLE',
      },
      503,
    );
  }
}

async function handleStandardRoomAssertion(request, config, env) {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  if (!mutationAuthorized(request)) return authJson({ error: 'CSRF_FAILED' }, 403);
  const body = await readJsonObject(request);
  const keys = body ? Object.keys(body).sort() : [];
  if (
    !body ||
    keys.length !== 3 ||
    keys[0] !== 'peerId' ||
    keys[1] !== 'role' ||
    keys[2] !== 'roomCode' ||
    typeof body.roomCode !== 'string' ||
    !/^\d{6}$/.test(body.roomCode) ||
    typeof body.peerId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,96}$/.test(body.peerId) ||
    (body.role !== 'host' && body.role !== 'guest')
  ) {
    return authJson({ error: 'INVALID_REQUEST' }, 400);
  }

  try {
    const session = await resolveStoredSession(request, config, { touch: false });
    const assertionSecret = String(env?.MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET || '');
    if (session.deletedAccountId) {
      const deletionAssertion = await createStandardRoomAccountDeletionAssertion(
        {
          accountId: session.deletedAccountId,
          roomCode: body.roomCode,
          peerId: body.peerId,
          role: body.role,
        },
        assertionSecret,
      );
      if (!deletionAssertion) return authJson({ error: 'AUTH_ASSERTION_UNAVAILABLE' }, 503);
      return authJson({ assertion: null, deletionAssertion });
    }
    if (!session.authenticated || !session.account.profileComplete || !session.account.nickname) {
      const response = authJson({ assertion: null, deletionAssertion: null });
      return session.clearCookie
        ? appendSetCookies(response, [clearCookie(AUTH_SESSION_COOKIE)])
        : response;
    }
    const assertion = await createStandardRoomAccountAssertion(
      {
        accountId: session.accountId,
        nickname: session.account.nickname,
        roomCode: body.roomCode,
        peerId: body.peerId,
        role: body.role,
      },
      assertionSecret,
    );
    if (!assertion) return authJson({ error: 'AUTH_ASSERTION_UNAVAILABLE' }, 503);
    return authJson({ assertion, deletionAssertion: null });
  } catch {
    return authJson({ error: 'AUTH_TEMPORARILY_UNAVAILABLE' }, 503);
  }
}

/**
 * Resolve an authenticated account for trusted App Worker integrations.
 * This does not issue room authority and must never be called on a downstream
 * browser-provided identity header. A missing/invalid session is represented
 * as null; storage failure is allowed to throw so callers fail closed.
 */
export async function resolveAccountSession(request, env) {
  const config = resolveAuthConfig(env);
  if (!config.configured) return null;
  const session = await resolveStoredSession(request, config, { touch: false });
  return session.authenticated
    ? {
        accountId: session.accountId,
        nickname: session.account.nickname,
        profileComplete: session.account.profileComplete,
      }
    : null;
}

export async function handleAccountAuthRequest(
  request,
  env,
  url = new URL(request.url),
  integrations = {},
) {
  if (!url.pathname.startsWith(AUTH_ROUTE_PREFIX)) return null;
  const config = resolveAuthConfig(env);
  if (!config.configured) {
    if (url.pathname === '/api/auth/session') {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return methodNotAllowed('GET, HEAD');
      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, max-age=0',
          },
        });
      }
      return authJson({
        configured: false,
        authenticated: false,
        account: null,
        statsScope: null,
      });
    }
    return authJson({ error: 'AUTH_NOT_CONFIGURED' }, 503);
  }

  switch (url.pathname) {
    case '/api/auth/google/start':
      return handleGoogleStart(request, config, url);
    case '/api/auth/google/callback':
      return handleGoogleCallback(request, config, url);
    case '/api/auth/session':
      return handleSession(request, config);
    case '/api/auth/profile':
      return handleProfile(request, config);
    case '/api/auth/stats':
      return handleAccountStats(request, config);
    case '/api/auth/room-assertion':
      return handleStandardRoomAssertion(request, config, env);
    case '/api/auth/logout':
      return handleLogout(request, config, false);
    case '/api/auth/logout-all':
      return handleLogout(request, config, true);
    case '/api/auth/account':
      return handleAccountDelete(request, config, integrations);
    default:
      return authJson({ error: 'AUTH_ROUTE_NOT_FOUND' }, 404);
  }
}

/**
 * Conservatively record that a verified account may hold persistent authority
 * in a PRO room. Call this before forwarding the signed account assertion so
 * no persistent authority can be created without a deletion cleanup path.
 */
export async function recordAccountProRoomLink(
  env,
  accountId,
  roomCode,
  nowMs = Date.now(),
  roomGeneration = LEGACY_PRO_ROOM_GENERATION,
) {
  const db = env?.MUSIXQUARE_AUTH_DB;
  if (
    !db ||
    typeof db.prepare !== 'function' ||
    !ACCOUNT_ID_RE.test(accountId || '') ||
    !/^0\d{5}$/.test(roomCode || '') ||
    !isProRoomGeneration(roomGeneration) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0
  ) {
    return false;
  }
  if (roomGeneration === LEGACY_PRO_ROOM_GENERATION) {
    // Keep the original generation-zero destination during the additive
    // rollout, but enforce one shared cleanup-edge cap across both schemas.
    // The exact missing-table fallback below is the only pre-migration path.
    let result;
    try {
      result = await d1Run(
        db,
        `INSERT INTO ${PRO_ROOM_LINK_TABLE}
         (account_id, room_code, first_linked_at, last_seen_at)
       SELECT ?1, ?2, ?3, ?3
         FROM ${ACCOUNT_TABLE} account
        WHERE account.account_id = ?1
          AND account.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM ${ACCOUNT_DELETION_TABLE} deletion
             WHERE deletion.account_id = account.account_id
          )
          AND (
            EXISTS (
              SELECT 1 FROM ${PRO_ROOM_LINK_TABLE} existing
               WHERE existing.account_id = ?1
                 AND existing.room_code = ?2
            )
            OR EXISTS (
              SELECT 1 FROM ${PRO_ROOM_GENERATION_LINK_TABLE} existing_generation
               WHERE existing_generation.account_id = ?1
                 AND existing_generation.room_code = ?2
                 AND existing_generation.room_generation = 0
            )
            OR (
              SELECT COUNT(*) FROM (
                SELECT room_code, 0 AS room_generation
                  FROM ${PRO_ROOM_LINK_TABLE} linked_legacy
                 WHERE linked_legacy.account_id = ?1
                UNION
                SELECT room_code, room_generation
                  FROM ${PRO_ROOM_GENERATION_LINK_TABLE} linked_generation
                 WHERE linked_generation.account_id = ?1
              )
            ) < ?4
          )
       ON CONFLICT(account_id, room_code)
       DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        [accountId, roomCode, nowMs, ACCOUNT_PRO_ROOM_LINK_MAX_PER_ACCOUNT],
      );
    } catch (error) {
      if (!isMissingProRoomGenerationLinkSchemaError(error)) throw error;
      result = await d1Run(
        db,
        `INSERT INTO ${PRO_ROOM_LINK_TABLE}
           (account_id, room_code, first_linked_at, last_seen_at)
         SELECT ?1, ?2, ?3, ?3
           FROM ${ACCOUNT_TABLE} account
          WHERE account.account_id = ?1
            AND account.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM ${ACCOUNT_DELETION_TABLE} deletion
               WHERE deletion.account_id = account.account_id
            )
            AND (
              EXISTS (
                SELECT 1 FROM ${PRO_ROOM_LINK_TABLE} existing
                 WHERE existing.account_id = ?1
                   AND existing.room_code = ?2
              )
              OR (
                SELECT COUNT(*) FROM ${PRO_ROOM_LINK_TABLE} linked
                 WHERE linked.account_id = ?1
              ) < ?4
            )
         ON CONFLICT(account_id, room_code)
         DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        [accountId, roomCode, nowMs, ACCOUNT_PRO_ROOM_LINK_MAX_PER_ACCOUNT],
      );
    }
    return d1ChangeCount(result) === 1;
  }
  const result = await d1Run(
    db,
    `INSERT INTO ${PRO_ROOM_GENERATION_LINK_TABLE}
       (account_id, room_code, room_generation, first_linked_at, last_seen_at)
     SELECT ?1, ?2, ?3, ?4, ?4
       FROM ${ACCOUNT_TABLE} account
      WHERE account.account_id = ?1
        AND account.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM ${ACCOUNT_DELETION_TABLE} deletion
           WHERE deletion.account_id = account.account_id
        )
        AND (
          EXISTS (
            SELECT 1 FROM ${PRO_ROOM_GENERATION_LINK_TABLE} existing
             WHERE existing.account_id = ?1
               AND existing.room_code = ?2
               AND existing.room_generation = ?3
          )
          OR (
            SELECT COUNT(*) FROM (
              SELECT room_code, 0 AS room_generation
                FROM ${PRO_ROOM_LINK_TABLE} linked_legacy
               WHERE linked_legacy.account_id = ?1
              UNION
              SELECT room_code, room_generation
                FROM ${PRO_ROOM_GENERATION_LINK_TABLE} linked_generation
               WHERE linked_generation.account_id = ?1
            )
          ) < ?5
        )
     ON CONFLICT(account_id, room_code, room_generation)
     DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    [accountId, roomCode, roomGeneration, nowMs, ACCOUNT_PRO_ROOM_LINK_MAX_PER_ACCOUNT],
  );
  return d1ChangeCount(result) === 1;
}

/**
 * Drop the reverse cleanup edge only after the exact room incarnation has
 * completed its durable decommission protocol. The room tombstone remains the
 * authorization fence; this merely prevents terminal history from consuming
 * a live account's 1,000-edge deletion budget forever.
 */
export async function retireAccountProRoomLinks(env, roomCode, roomGeneration) {
  return retireAccountProRoomLinkBatch(env, [{ roomCode, roomGeneration }]);
}

export async function retireAccountProRoomLinkBatch(env, incarnations) {
  const db = env?.MUSIXQUARE_AUTH_DB;
  if (!db || typeof db.prepare !== 'function') {
    return { configured: false, retired: false };
  }
  if (!Array.isArray(incarnations)) {
    return { configured: true, retired: false };
  }
  const unique = new Map();
  for (const incarnation of incarnations.slice(0, 5_000)) {
    const roomCode = incarnation?.roomCode;
    const roomGeneration = Number(incarnation?.roomGeneration);
    if (!/^0\d{5}$/.test(roomCode || '') || !isProRoomGeneration(roomGeneration)) continue;
    unique.set(`${roomCode}:${roomGeneration}`, { roomCode, roomGeneration });
  }
  const normalized = [...unique.values()];
  if (normalized.length === 0) return { configured: true, retired: false };
  for (let offset = 0; offset < normalized.length; offset += 40) {
    const chunk = normalized.slice(offset, offset + 40);
    const statements = [];
    const legacyCodes = chunk
      .filter(({ roomGeneration }) => roomGeneration === LEGACY_PRO_ROOM_GENERATION)
      .map(({ roomCode }) => roomCode);
    if (legacyCodes.length > 0) {
      statements.push({
        sql: `DELETE FROM ${PRO_ROOM_LINK_TABLE}
               WHERE room_code IN (${legacyCodes.map((_, index) => `?${index + 1}`).join(', ')})`,
        values: legacyCodes,
      });
    }
    statements.push({
      sql: `DELETE FROM ${PRO_ROOM_GENERATION_LINK_TABLE}
             WHERE ${chunk
               .map(
                 (_, index) =>
                   `(room_code = ?${index * 2 + 1} AND room_generation = ?${index * 2 + 2})`,
               )
               .join(' OR ')}`,
      values: chunk.flatMap(({ roomCode, roomGeneration }) => [roomCode, roomGeneration]),
    });
    try {
      await d1Batch(db, statements);
    } catch (error) {
      if (
        chunk.some(({ roomGeneration }) => roomGeneration !== LEGACY_PRO_ROOM_GENERATION) ||
        !isMissingProRoomGenerationLinkSchemaError(error)
      ) {
        throw error;
      }
      if (legacyCodes.length > 0) {
        await d1Run(
          db,
          `DELETE FROM ${PRO_ROOM_LINK_TABLE}
            WHERE room_code IN (${legacyCodes.map((_, index) => `?${index + 1}`).join(', ')})`,
          legacyCodes,
        );
      }
    }
  }
  return { configured: true, retired: true };
}

/**
 * Resume durable account-deletion jobs created when the reverse-index fan-out
 * is too large for a browser's request deadline. Login/session authority is
 * already revoked before a job is visible here. Every successful PRO purge is
 * followed by deletion of that exact generation edge; failures remain queued
 * and are retried by the next minute cron.
 */
export async function cleanupPendingAccountDeletions(env, integrations = {}, options = {}) {
  const db = env?.MUSIXQUARE_AUTH_DB;
  const purgeProRoomAccountAuthority = integrations?.purgeProRoomAccountAuthority;
  if (
    !db ||
    typeof db.prepare !== 'function' ||
    typeof purgeProRoomAccountAuthority !== 'function'
  ) {
    return {
      configured: false,
      processedAccounts: 0,
      purgedEdges: 0,
      failedEdges: 0,
      completedAccounts: 0,
      pendingAccounts: 0,
    };
  }
  const requestedAccountId =
    typeof options?.accountId === 'string' && ACCOUNT_ID_RE.test(options.accountId)
      ? options.accountId
      : null;
  const edgeLimit = Math.max(
    1,
    Math.min(
      ACCOUNT_DELETE_JOB_EDGE_LIMIT,
      Number.isSafeInteger(options?.edgeLimit) ? options.edgeLimit : ACCOUNT_DELETE_JOB_EDGE_LIMIT,
    ),
  );
  const jobs = requestedAccountId
    ? await d1All(
        db,
        `SELECT account_id, started_at
           FROM ${ACCOUNT_DELETION_TABLE}
          WHERE account_id = ?1
          LIMIT 1`,
        [requestedAccountId],
      )
    : await d1All(
        db,
        `SELECT account_id, started_at
           FROM ${ACCOUNT_DELETION_TABLE}
          ORDER BY started_at ASC, account_id ASC
          LIMIT ?1`,
        [ACCOUNT_DELETE_JOB_MAX_ACCOUNTS],
      );
  const result = {
    configured: true,
    processedAccounts: 0,
    purgedEdges: 0,
    failedEdges: 0,
    completedAccounts: 0,
    pendingAccounts: 0,
  };
  for (const job of jobs) {
    const accountId = typeof job?.account_id === 'string' ? job.account_id : '';
    const startedAt = Number(job?.started_at);
    if (!ACCOUNT_ID_RE.test(accountId) || !Number.isSafeInteger(startedAt) || startedAt <= 0) {
      result.pendingAccounts += 1;
      continue;
    }
    result.processedAccounts += 1;
    // Recover a legacy request that crashed after installing its fence but
    // before revoking sessions. This batch is idempotent for native async jobs.
    const disabledAt = Date.now();
    await d1Batch(db, [
      {
        sql: `UPDATE ${ACCOUNT_TABLE}
                 SET status = 'disabled', updated_at = ?2
               WHERE account_id = ?1 AND status = 'active'`,
        values: [accountId, disabledAt],
      },
      ...accountDeletionSessionStatements(
        accountId,
        disabledAt,
        disabledAt + ACCOUNT_DELETED_SESSION_TTL_SECONDS * 1000,
      ),
    ]);
    const { generationLinksConfigured, links } = await readAccountProRoomLinks(
      db,
      accountId,
      edgeLimit,
    );
    if (links.length > 0) {
      const cleanup = await purgeAccountProRoomLinks(
        db,
        accountId,
        links,
        purgeProRoomAccountAuthority,
        generationLinksConfigured,
      );
      result.purgedEdges += cleanup.purged;
      result.failedEdges += cleanup.failed;
    }
    const remaining = await readAccountProRoomLinks(db, accountId, 1);
    if (remaining.links.length > 0) {
      result.pendingAccounts += 1;
      continue;
    }
    await d1Batch(db, accountDeletionFinalStatements(accountId, generationLinksConfigured));
    result.completedAccounts += 1;
  }
  return result;
}

export async function cleanupExpiredAccountSessions(env, nowMs = Date.now()) {
  const db = env?.MUSIXQUARE_AUTH_DB;
  if (!db || typeof db.prepare !== 'function') return { configured: false, deleted: false };
  try {
    await d1Batch(db, [
      {
        sql: `DELETE FROM ${SESSION_TABLE} WHERE expires_at <= ?1`,
        values: [nowMs],
      },
      {
        sql: `DELETE FROM ${OAUTH_FLOW_TABLE} WHERE expires_at <= ?1`,
        values: [nowMs],
      },
      {
        sql: `DELETE FROM ${DELETED_SESSION_TABLE} WHERE expires_at <= ?1`,
        values: [nowMs],
      },
    ]);
    return { configured: true, deleted: true };
  } catch (error) {
    console.warn('[AccountAuth] expired-session cleanup failed', error);
    return { configured: true, deleted: false };
  }
}

export function resetAccountAuthCachesForTests() {
  googleJwksCache = { expiresAtMs: 0, keys: new Map() };
}

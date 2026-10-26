/**
 * GitHub Actions OIDC token verifier for the App Worker's ops routes.
 *
 * A workflow job with `id-token: write` mints a short-lived RS256 JWT from
 * GitHub's issuer. The App Worker accepts it instead of a stored secret, so no
 * owner credential is involved. Every identity claim the caller relies on is
 * pinned by the policy, the workflow through `workflow_ref` (the callers run
 * their own steps, not a reusable workflow); the signature is checked against
 * GitHub's published key set.
 *
 * Abuse bound: an unknown `kid` refreshes the key set at most once per
 * GITHUB_OIDC_JWKS_REFRESH_MIN_INTERVAL_MS per isolate (any fetch attempt,
 * successful or not, starts the interval), so forged tokens cannot turn into a
 * stream of outbound key fetches. The route also applies its abuse-rate limit
 * before it calls this verifier.
 */
import { fetchTextWithTimeout } from './account-auth.ts';

export const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_ACTIONS_OIDC_JWKS_URL = `${GITHUB_ACTIONS_OIDC_ISSUER}/.well-known/jwks`;
/** Largest token the verifier parses, in bytes (the token is ASCII). */
export const GITHUB_ACTIONS_OIDC_TOKEN_MAX_BYTES = 8 * 1024;
/** Shortest spacing of key-set fetch attempts per isolate. */
export const GITHUB_OIDC_JWKS_REFRESH_MIN_INTERVAL_MS = 60_000;

const GITHUB_OIDC_JWKS_FETCH_TIMEOUT_MS = 5_000;
const GITHUB_OIDC_JWKS_MAX_BYTES = 64 * 1024;
const GITHUB_OIDC_JWKS_MAX_KEYS = 16;
const GITHUB_OIDC_JWKS_MAX_AGE_MS = 60 * 60 * 1000;
const GITHUB_OIDC_RSA_MIN_MODULUS_BYTES = 256;
const JWT_CLOCK_SKEW_SECONDS = 60;
const JWT_MAX_AGE_SECONDS = 60 * 60;
const JWT_KID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

/** The identity a token must carry; every field is compared exactly. */
export interface GitHubActionsOidcPolicy {
  readonly audience: string;
  readonly repository: string;
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  readonly ref: string;
  readonly environment: string;
  readonly eventName: string;
  readonly runnerEnvironment: string;
  /**
   * Workflows (`owner/repo/.github/workflows/file.yml@ref`) whose jobs may
   * call, each running its own steps. The token's `workflow_ref` must be one
   * of them, and the job must not run a reusable workflow (see
   * `allowedWorkflowRef`).
   */
  readonly workflowRefs: readonly string[];
}

export type GitHubActionsOidcVerification =
  | { ok: true; workflowRef: string; runId: string | null }
  | { ok: false; status: 401; error: 'OIDC_TOKEN_INVALID' }
  | { ok: false; status: 403; error: 'OIDC_TOKEN_FORBIDDEN' }
  | { ok: false; status: 503; error: 'OIDC_JWKS_UNAVAILABLE' };

type JsonObject = Record<string, unknown>;

interface GitHubSigningKey {
  readonly n: string;
  readonly e: string;
  imported: Promise<CryptoKey> | null;
}

interface GitHubKeySet {
  readonly keys: ReadonlyMap<string, GitHubSigningKey>;
  readonly expiresAtMs: number;
}

let keySet: GitHubKeySet | null = null;
let lastFetchAttemptAtMs: number | null = null;
let keySetFetch: Promise<GitHubKeySet | null> | null = null;

const INVALID = Object.freeze({ ok: false, status: 401, error: 'OIDC_TOKEN_INVALID' } as const);
const FORBIDDEN = Object.freeze({ ok: false, status: 403, error: 'OIDC_TOKEN_FORBIDDEN' } as const);
const UNAVAILABLE = Object.freeze({
  ok: false,
  status: 503,
  error: 'OIDC_JWKS_UNAVAILABLE',
} as const);

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function base64UrlBytes(value: string, maxBytes: number): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_RE.test(value) || value.length % 4 === 1) return null;
  if (value.length > Math.ceil((maxBytes * 4) / 3) + 4) return null;
  try {
    const binary = atob(
      value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4),
    );
    if (binary.length > maxBytes) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function decodeSegment(segment: string, maxBytes: number): JsonObject | null {
  const bytes = base64UrlBytes(segment, maxBytes);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

function keySetMaxAgeMs(cacheControl: string | null): number {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl || '');
  const seconds = match ? Number(match[1]) : Number.NaN;
  const requested = Number.isSafeInteger(seconds) ? seconds * 1_000 : GITHUB_OIDC_JWKS_MAX_AGE_MS;
  // Never shorter than the refresh interval, so a cached set is not dropped
  // before the next fetch is allowed.
  return Math.min(
    Math.max(requested, GITHUB_OIDC_JWKS_REFRESH_MIN_INTERVAL_MS),
    GITHUB_OIDC_JWKS_MAX_AGE_MS,
  );
}

function signingKeyFrom(value: unknown): [string, GitHubSigningKey] | null {
  if (
    !isJsonObject(value) ||
    value.kty !== 'RSA' ||
    (value.use !== undefined && value.use !== 'sig') ||
    (value.alg !== undefined && value.alg !== 'RS256') ||
    typeof value.kid !== 'string' ||
    !JWT_KID_RE.test(value.kid) ||
    typeof value.n !== 'string' ||
    typeof value.e !== 'string'
  ) {
    return null;
  }
  const modulus = base64UrlBytes(value.n, 1024);
  const exponent = base64UrlBytes(value.e, 8);
  // Strip one leading zero byte of a big-endian modulus before measuring it.
  const modulusBytes = modulus && modulus[0] === 0 ? modulus.length - 1 : (modulus?.length ?? 0);
  if (!exponent || exponent.length === 0 || modulusBytes < GITHUB_OIDC_RSA_MIN_MODULUS_BYTES) {
    return null;
  }
  return [value.kid, { n: value.n, e: value.e, imported: null }];
}

async function fetchKeySet(nowMs: number): Promise<GitHubKeySet | null> {
  try {
    const { response, text } = await fetchTextWithTimeout(
      GITHUB_ACTIONS_OIDC_JWKS_URL,
      { method: 'GET', headers: { Accept: 'application/json' } },
      GITHUB_OIDC_JWKS_MAX_BYTES,
      GITHUB_OIDC_JWKS_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) return null;
    const payload: unknown = JSON.parse(text);
    if (
      !isJsonObject(payload) ||
      !Array.isArray(payload.keys) ||
      payload.keys.length > GITHUB_OIDC_JWKS_MAX_KEYS
    ) {
      return null;
    }
    const keys = new Map<string, GitHubSigningKey>();
    for (const entry of payload.keys) {
      const key = signingKeyFrom(entry);
      if (key) keys.set(...key);
    }
    if (keys.size === 0) return null;
    return {
      keys,
      expiresAtMs: nowMs + keySetMaxAgeMs(response.headers.get('Cache-Control')),
    };
  } catch {
    return null;
  }
}

/**
 * The cached key set, refreshed when it expired or lacks `kid`, but never more
 * than once per refresh interval. Null when no usable set exists.
 */
async function keySetFor(kid: string, nowMs: number): Promise<GitHubKeySet | null> {
  const cached = keySet && keySet.expiresAtMs > nowMs ? keySet : null;
  if (cached?.keys.has(kid)) return cached;
  if (keySetFetch) return (await keySetFetch) ?? cached;
  if (
    lastFetchAttemptAtMs !== null &&
    nowMs - lastFetchAttemptAtMs < GITHUB_OIDC_JWKS_REFRESH_MIN_INTERVAL_MS
  ) {
    return cached;
  }
  lastFetchAttemptAtMs = nowMs;
  const pending = fetchKeySet(nowMs);
  keySetFetch = pending;
  try {
    const fetched = await pending;
    if (fetched) keySet = fetched;
    return fetched ?? cached;
  } finally {
    if (keySetFetch === pending) keySetFetch = null;
  }
}

function importSigningKey(key: GitHubSigningKey): Promise<CryptoKey> {
  key.imported ??= crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return key.imported;
}

function audienceMatches(audience: unknown, expected: string): boolean {
  if (typeof audience === 'string') return audience === expected;
  return Array.isArray(audience) && audience.length === 1 && audience[0] === expected;
}

function timeClaimsValid(claims: JsonObject, nowMs: number): boolean {
  const now = Math.floor(nowMs / 1_000);
  return (
    isSafeInteger(claims.exp) &&
    claims.exp > now - JWT_CLOCK_SKEW_SECONDS &&
    isSafeInteger(claims.iat) &&
    claims.iat <= now + JWT_CLOCK_SKEW_SECONDS &&
    claims.iat >= now - JWT_MAX_AGE_SECONDS &&
    (claims.nbf === undefined ||
      (isSafeInteger(claims.nbf) && claims.nbf <= now + JWT_CLOCK_SKEW_SECONDS))
  );
}

function identityMatches(claims: JsonObject, policy: GitHubActionsOidcPolicy): boolean {
  return (
    claims.repository === policy.repository &&
    claims.repository_id === policy.repositoryId &&
    claims.repository_owner_id === policy.repositoryOwnerId &&
    claims.ref === policy.ref &&
    claims.environment === policy.environment &&
    claims.event_name === policy.eventName &&
    claims.runner_environment === policy.runnerEnvironment
  );
}

/**
 * The allowed workflow whose own steps minted the token, or null.
 *
 * `workflow_ref` names the workflow the event ran; GitHub documents it for
 * every job. GitHub documents `job_workflow_ref` only for a job that runs a
 * reusable workflow, where it names the called workflow whose steps run.
 * Tokens may also repeat `workflow_ref` there for a job that runs its own
 * steps, so an absent, empty or identical value means no reusable workflow
 * and the verifier works either way. Any other value is refused, even one on
 * the allowlist: the allowed callers run their own steps, and a token minted
 * inside a reusable workflow (such as the release's recovery job) carries the
 * caller's `workflow_ref` while running code the allowlist did not name.
 */
function allowedWorkflowRef(claims: JsonObject, allowed: readonly string[]): string | null {
  const workflowRef = claims.workflow_ref;
  if (typeof workflowRef !== 'string' || !allowed.includes(workflowRef)) return null;
  const jobWorkflowRef = claims.job_workflow_ref;
  if (jobWorkflowRef !== undefined && jobWorkflowRef !== '' && jobWorkflowRef !== workflowRef) {
    return null;
  }
  return workflowRef;
}

/**
 * Verifies a GitHub Actions OIDC token against the policy. 401 for anything
 * that is not a valid, current token for the policy's audience; 403 for a
 * valid token of another repository, ref, environment, event, runner or
 * workflow (a `workflow_ref` off the allowlist, or a job that runs a reusable
 * workflow); 503 when no key set is available to check the signature.
 */
export async function verifyGitHubActionsOidcToken(
  token: unknown,
  policy: GitHubActionsOidcPolicy,
  nowMs: number = Date.now(),
): Promise<GitHubActionsOidcVerification> {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > GITHUB_ACTIONS_OIDC_TOKEN_MAX_BYTES
  ) {
    return INVALID;
  }
  const parts = token.split('.');
  if (parts.length !== 3) return INVALID;
  const [headerSegment = '', claimsSegment = '', signatureSegment = ''] = parts;
  const header = decodeSegment(headerSegment, 1024);
  const claims = decodeSegment(claimsSegment, GITHUB_ACTIONS_OIDC_TOKEN_MAX_BYTES);
  const signature = base64UrlBytes(signatureSegment, 1024);
  if (
    !header ||
    !claims ||
    !signature ||
    signature.length === 0 ||
    header.alg !== 'RS256' ||
    typeof header.kid !== 'string' ||
    !JWT_KID_RE.test(header.kid)
  ) {
    return INVALID;
  }

  const keys = await keySetFor(header.kid, nowMs);
  if (!keys) return UNAVAILABLE;
  const key = keys.keys.get(header.kid);
  if (!key) return INVALID;
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      await importSigningKey(key),
      signature,
      new TextEncoder().encode(`${headerSegment}.${claimsSegment}`),
    );
  } catch {
    verified = false;
  }
  if (
    !verified ||
    claims.iss !== GITHUB_ACTIONS_OIDC_ISSUER ||
    !audienceMatches(claims.aud, policy.audience) ||
    !timeClaimsValid(claims, nowMs)
  ) {
    return INVALID;
  }
  if (!identityMatches(claims, policy)) return FORBIDDEN;
  const workflowRef = allowedWorkflowRef(claims, policy.workflowRefs);
  if (workflowRef === null) return FORBIDDEN;
  return {
    ok: true,
    workflowRef,
    runId: typeof claims.run_id === 'string' ? claims.run_id : null,
  };
}

export function resetGitHubActionsOidcCacheForTests(): void {
  keySet = null;
  lastFetchAttemptAtMs = null;
  keySetFetch = null;
}

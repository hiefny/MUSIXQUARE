/**
 * Optional account HTTP client.
 *
 * Authentication is cookie based. Callers must treat every failure as
 * account-feature-only: room setup, playback, and anonymous chat do not depend
 * on these requests succeeding.
 */

import { readBoundedResponseText, withRequestDeadline } from '../core/request-lifetime.ts';

export interface AccountProfile {
  nickname: string;
  profileComplete: boolean;
}

export interface AccountSessionResponse {
  configured: boolean;
  authenticated: boolean;
  account: AccountProfile | null;
  /**
   * Opaque, non-authorizing fence for the current HttpOnly account session.
   */
  statsScope: string | null;
}

export interface AccountStats {
  sessionCount: number;
  listeningSeconds: number;
  trackCount: number;
}

export interface AccountStatsDelta {
  sessionCountDelta: number;
  listeningSecondsDelta: number;
  trackCountDelta: number;
}

export interface AccountDeletionResult {
  pending: boolean;
}

export interface StandardRoomAssertionRequest {
  roomCode: string;
  peerId: string;
  role: 'host' | 'guest';
}

export interface StandardRoomIdentityAssertions {
  /** Active-account proof; the signaling Worker may use it only to attach. */
  accountAssertion: string | null;
  /** Deleted-session proof; the signaling Worker may use it only to revoke. */
  deletionAssertion: string | null;
}

interface RawAccountProfile {
  nickname?: unknown;
  profileComplete?: unknown;
}

interface RawAccountSessionResponse {
  configured?: unknown;
  authenticated?: unknown;
  account?: RawAccountProfile | null;
  statsScope?: unknown;
}

interface RawAccountStatsResponse {
  stats?: {
    sessionCount?: unknown;
    listeningSeconds?: unknown;
    trackCount?: unknown;
  };
}

const ACCOUNT_CSRF_HEADER = 'X-MXQR-Account-CSRF';
const ACCOUNT_STATS_SCOPE_HEADER = 'X-MXQR-Account-Stats-Scope';
const ACCOUNT_EXPECTED_SCOPE_HEADER = 'X-MXQR-Account-Expected-Scope';
const ACCOUNT_STATS_SCOPE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ACCOUNT_REQUEST_TIMEOUT_MS = 15_000;
// Session reads sit directly on the app's recovery path. A browser or service
// worker can leave the first fetch pending after a forced close, so do not let
// that optional read hold account recovery for the full mutation deadline.
const ACCOUNT_SESSION_REQUEST_TIMEOUT_MS = 5_000;
const ACCOUNT_RESPONSE_MAX_BYTES = 64 * 1024;
const ACCOUNT_RETRY_AFTER_MAX_MS = 5 * 60 * 1000;
const HTTP_DATE_WEEKDAY_RE =
  /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)(?:,|\s)/iu;

export class AccountApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(code: string, status: number, retryAfterMs: number | null = null) {
    super(code);
    this.name = 'AccountApiError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized) return null;

  if (/^\d+$/u.test(normalized)) {
    const seconds = Number(normalized);
    if (!Number.isFinite(seconds) || seconds >= ACCOUNT_RETRY_AFTER_MAX_MS / 1000) {
      return ACCOUNT_RETRY_AFTER_MAX_MS;
    }
    return seconds * 1000;
  }

  // Date.parse accepts many non-HTTP inputs (including signed numbers). Only
  // admit the three HTTP-date families, all of which begin with a weekday.
  if (!HTTP_DATE_WEEKDAY_RE.test(normalized)) return null;
  const retryAtMs = Date.parse(normalized);
  if (!Number.isFinite(retryAtMs)) return null;
  return Math.min(ACCOUNT_RETRY_AFTER_MAX_MS, Math.max(0, retryAtMs - nowMs));
}

function normalizeAccountResponse(value: unknown): AccountSessionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }

  const raw = value as RawAccountSessionResponse;
  if (
    typeof raw.configured !== 'boolean' ||
    typeof raw.authenticated !== 'boolean' ||
    (raw.authenticated && !raw.configured)
  ) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }

  if (!raw.authenticated) {
    if (raw.account !== null || (raw.statsScope !== undefined && raw.statsScope !== null)) {
      throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
    }
    return {
      configured: raw.configured,
      authenticated: false,
      account: null,
      statsScope: null,
    };
  }

  const account = raw.account;
  if (
    !account ||
    typeof account.nickname !== 'string' ||
    typeof account.profileComplete !== 'boolean'
  ) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }
  const statsScope = raw.statsScope;
  if (typeof statsScope !== 'string' || !ACCOUNT_STATS_SCOPE_PATTERN.test(statsScope)) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }

  return {
    configured: true,
    authenticated: true,
    statsScope,
    account: {
      nickname: account.nickname,
      profileComplete: account.profileComplete,
    },
  };
}

function normalizeAccountStats(value: unknown): AccountStats {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }
  const stats = (value as RawAccountStatsResponse).stats;
  if (
    !stats ||
    !Number.isSafeInteger(stats.sessionCount) ||
    (stats.sessionCount as number) < 0 ||
    !Number.isSafeInteger(stats.listeningSeconds) ||
    (stats.listeningSeconds as number) < 0 ||
    !Number.isSafeInteger(stats.trackCount) ||
    (stats.trackCount as number) < 0
  ) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }
  return {
    sessionCount: stats.sessionCount as number,
    listeningSeconds: stats.listeningSeconds as number,
    trackCount: stats.trackCount as number,
  };
}

async function readJson(
  response: Response,
  signal?: AbortSignal,
  retryAfterMs: number | null = null,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, ACCOUNT_RESPONSE_MAX_BYTES, signal);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AccountApiError(
      'ACCOUNT_INVALID_RESPONSE',
      response.ok ? 502 : response.status || 502,
      retryAfterMs,
    );
  }
}

async function requestJsonResponse(
  path: string,
  init: RequestInit = {},
  timeoutMs = ACCOUNT_REQUEST_TIMEOUT_MS,
): Promise<{ payload: unknown; status: number }> {
  try {
    return await withRequestDeadline(
      async (signal) => {
        const response = await fetch(path, {
          ...init,
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            ...init.headers,
          },
          signal,
        });

        // Consume the body inside the deadline. Fetch resolving at headers is
        // not completion and must not pin account refresh/mutation state.
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
        const payload = await readJson(response, signal, retryAfterMs);
        if (!response.ok) {
          const code =
            payload &&
            typeof payload === 'object' &&
            typeof (payload as { error?: unknown }).error === 'string'
              ? (payload as { error: string }).error
              : 'ACCOUNT_REQUEST_FAILED';
          throw new AccountApiError(code, response.status, retryAfterMs);
        }
        return { payload, status: response.status };
      },
      {
        signal: init.signal ?? undefined,
        timeoutMs,
        timeoutReason: 'ACCOUNT_REQUEST_TIMEOUT',
      },
    );
  } catch (error) {
    if (error instanceof AccountApiError) throw error;
    throw new AccountApiError('ACCOUNT_NETWORK_ERROR', 0);
  }
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  return (await requestJsonResponse(path, init)).payload;
}

function mutationHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    [ACCOUNT_CSRF_HEADER]: '1',
  };
}

function expectedAccountMutationHeaders(expectedScope: string | null): HeadersInit {
  if (!expectedScope || !ACCOUNT_STATS_SCOPE_PATTERN.test(expectedScope)) {
    throw new AccountApiError('ACCOUNT_SESSION_CHANGED', 409);
  }
  return { ...mutationHeaders(), [ACCOUNT_EXPECTED_SCOPE_HEADER]: expectedScope };
}

export async function getAccountSession(): Promise<AccountSessionResponse> {
  return normalizeAccountResponse(
    (await requestJsonResponse('/api/auth/session', {}, ACCOUNT_SESSION_REQUEST_TIMEOUT_MS))
      .payload,
  );
}

export async function getAccountStats(statsScope: string): Promise<AccountStats> {
  if (!ACCOUNT_STATS_SCOPE_PATTERN.test(statsScope)) {
    throw new AccountApiError('ACCOUNT_STATS_SCOPE_INVALID', 0);
  }
  return normalizeAccountStats(
    await requestJson('/api/auth/stats', {
      headers: { [ACCOUNT_STATS_SCOPE_HEADER]: statsScope },
    }),
  );
}

export async function addAccountStats(
  input: AccountStatsDelta,
  statsScope: string,
): Promise<AccountStats> {
  if (!ACCOUNT_STATS_SCOPE_PATTERN.test(statsScope)) {
    throw new AccountApiError('ACCOUNT_STATS_SCOPE_INVALID', 0);
  }
  return normalizeAccountStats(
    await requestJson('/api/auth/stats', {
      method: 'PATCH',
      headers: {
        ...mutationHeaders(),
        [ACCOUNT_STATS_SCOPE_HEADER]: statsScope,
      },
      body: JSON.stringify(input),
    }),
  );
}

function normalizeRoomAssertionToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length < 3 || value.length > 2048) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }
  return value;
}

export async function getStandardRoomIdentityAssertions(
  input: StandardRoomAssertionRequest,
): Promise<StandardRoomIdentityAssertions> {
  const payload = await requestJson('/api/auth/room-assertion', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify(input),
  });
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Object.prototype.hasOwnProperty.call(payload, 'assertion') ||
    !Object.prototype.hasOwnProperty.call(payload, 'deletionAssertion')
  ) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }
  const raw = payload as { assertion: unknown; deletionAssertion: unknown };
  const accountAssertion = normalizeRoomAssertionToken(raw.assertion);
  const deletionAssertion = normalizeRoomAssertionToken(raw.deletionAssertion);
  if (accountAssertion && deletionAssertion) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }
  return { accountAssertion, deletionAssertion };
}

export async function updateAccountProfile(
  nickname: string,
  expectedScope: string | null,
): Promise<AccountSessionResponse> {
  return normalizeAccountResponse(
    await requestJson('/api/auth/profile', {
      method: 'PATCH',
      headers: expectedAccountMutationHeaders(expectedScope),
      body: JSON.stringify({ nickname }),
    }),
  );
}

export async function logoutAccount(): Promise<void> {
  await requestJson('/api/auth/logout', {
    method: 'POST',
    headers: mutationHeaders(),
    body: '{}',
  });
}

export async function logoutAllAccounts(): Promise<void> {
  await requestJson('/api/auth/logout-all', {
    method: 'POST',
    headers: mutationHeaders(),
    body: '{}',
  });
}

export async function deleteAccount(expectedScope: string | null): Promise<AccountDeletionResult> {
  const response = await requestJsonResponse('/api/auth/account', {
    method: 'DELETE',
    headers: expectedAccountMutationHeaders(expectedScope),
    body: JSON.stringify({ confirm: true }),
  });
  const payload = response.payload;
  const deletion =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { ok?: unknown; pending?: unknown })
      : null;
  const validCompleted =
    response.status === 200 && deletion?.ok === true && deletion.pending !== true;
  const validPending =
    response.status === 202 && deletion?.ok === true && deletion.pending === true;
  if (!validCompleted && !validPending) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }
  return { pending: validPending };
}

/** Build a same-origin OAuth start URL without accepting an external return URL. */
export function buildGoogleLoginUrl(
  locationLike: Pick<Location, 'pathname' | 'search' | 'hash'> = location,
  returnToOverride?: string,
): string {
  const returnTo =
    returnToOverride ??
    `${locationLike.pathname || '/'}${locationLike.search || ''}${locationLike.hash || ''}`;
  return `/api/auth/google/start?returnTo=${encodeURIComponent(returnTo.startsWith('/') ? returnTo : '/')}`;
}

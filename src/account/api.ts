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
}

const ACCOUNT_CSRF_HEADER = 'X-MXQR-Account-CSRF';
const ACCOUNT_REQUEST_TIMEOUT_MS = 15_000;
const ACCOUNT_RESPONSE_MAX_BYTES = 64 * 1024;

export class AccountApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'AccountApiError';
    this.code = code;
    this.status = status;
  }
}

function normalizeAccountResponse(value: unknown): AccountSessionResponse {
  if (!value || typeof value !== 'object') {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }

  const raw = value as RawAccountSessionResponse;
  const configured = raw.configured === true;
  const authenticated = configured && raw.authenticated === true;

  if (!authenticated) {
    return { configured, authenticated: false, account: null };
  }

  const account = raw.account;
  if (
    !account ||
    typeof account.nickname !== 'string' ||
    typeof account.profileComplete !== 'boolean'
  ) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }

  return {
    configured: true,
    authenticated: true,
    account: {
      nickname: account.nickname,
      profileComplete: account.profileComplete,
    },
  };
}

async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const text = await readBoundedResponseText(response, ACCOUNT_RESPONSE_MAX_BYTES, signal);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', response.status || 502);
  }
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
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
        const payload = await readJson(response, signal);
        if (!response.ok) {
          const code =
            payload &&
            typeof payload === 'object' &&
            typeof (payload as { error?: unknown }).error === 'string'
              ? (payload as { error: string }).error
              : 'ACCOUNT_REQUEST_FAILED';
          throw new AccountApiError(code, response.status);
        }
        return payload;
      },
      {
        signal: init.signal ?? undefined,
        timeoutMs: ACCOUNT_REQUEST_TIMEOUT_MS,
        timeoutReason: 'ACCOUNT_REQUEST_TIMEOUT',
      },
    );
  } catch (error) {
    if (error instanceof AccountApiError) throw error;
    throw new AccountApiError('ACCOUNT_NETWORK_ERROR', 0);
  }
}

function mutationHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    [ACCOUNT_CSRF_HEADER]: '1',
  };
}

export async function getAccountSession(): Promise<AccountSessionResponse> {
  return normalizeAccountResponse(await requestJson('/api/auth/session'));
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
    !Object.prototype.hasOwnProperty.call(payload, 'assertion')
  ) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }
  const raw = payload as { assertion: unknown; deletionAssertion?: unknown };
  const accountAssertion = normalizeRoomAssertionToken(raw.assertion);
  // Older Stage-1 App Workers return only { assertion }. Missing deletion
  // proof is deliberately equivalent to null during a rolling deployment.
  const deletionAssertion = normalizeRoomAssertionToken(raw.deletionAssertion);
  if (accountAssertion && deletionAssertion) {
    throw new AccountApiError('ACCOUNT_INVALID_RESPONSE', 502);
  }
  return { accountAssertion, deletionAssertion };
}

export async function updateAccountProfile(nickname: string): Promise<AccountSessionResponse> {
  return normalizeAccountResponse(
    await requestJson('/api/auth/profile', {
      method: 'PATCH',
      headers: mutationHeaders(),
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

export async function deleteAccount(): Promise<void> {
  await requestJson('/api/auth/account', {
    method: 'DELETE',
    headers: mutationHeaders(),
    body: JSON.stringify({ confirm: true }),
  });
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

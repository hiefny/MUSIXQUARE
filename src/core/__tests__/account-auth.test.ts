import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.js';
import {
  cleanupExpiredAccountSessions,
  handleAccountAuthRequest,
  recordAccountProRoomLink,
  resetAccountAuthCachesForTests,
  resolveAccountSession,
} from '../../../cloudflare/account-auth.js';
import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  ACCOUNT_ASSERTION_HEADER,
  verifyAccountAssertion,
} from '../../../cloudflare/account-assertion.js';
import {
  verifyStandardRoomAccountAssertion,
  verifyStandardRoomAccountDeletionAssertion,
} from '../../../cloudflare/standard-room-account-assertion.js';

interface AccountRow {
  account_id: string;
  google_subject_hash: string;
  nickname: string | null;
  nickname_key: string | null;
  profile_complete: number;
  status: 'active' | 'disabled';
  created_at: number;
  updated_at: number;
}

interface SessionRow {
  session_hash: string;
  account_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

interface DeletedSessionRow {
  session_hash: string;
  account_id: string;
  deleted_at: number;
  expires_at: number;
}

interface FlowRow {
  state_hash: string;
  created_at: number;
  expires_at: number;
}

interface ProRoomLinkRow {
  account_id: string;
  room_code: string;
  first_linked_at: number;
  last_seen_at: number;
}

class FakeStatement {
  constructor(
    private readonly db: FakeAuthDb,
    readonly sql: string,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, values);
  }

  async first(): Promise<Record<string, unknown> | null> {
    return this.db.first(this.sql, this.values);
  }

  async all(): Promise<{ results: Record<string, unknown>[] }> {
    return { results: await this.db.all(this.sql, this.values) };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.db.run(this.sql, this.values);
  }
}

class FakeAuthDb {
  readonly accounts = new Map<string, AccountRow>();
  readonly accountBySubject = new Map<string, string>();
  readonly sessions = new Map<string, SessionRow>();
  readonly deletedSessions = new Map<string, DeletedSessionRow>();
  readonly flows = new Map<string, FlowRow>();
  readonly proRoomLinks = new Map<string, ProRoomLinkRow>();
  readonly accountDeletions = new Map<string, number>();
  readonly boundValues: unknown[][] = [];
  fail = false;
  nicknameWriteError: Error | null = null;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    const accountSnapshot = new Map(this.accounts);
    const subjectSnapshot = new Map(this.accountBySubject);
    const sessionSnapshot = new Map(this.sessions);
    const deletedSessionSnapshot = new Map(this.deletedSessions);
    const flowSnapshot = new Map(this.flows);
    const proRoomLinkSnapshot = new Map(this.proRoomLinks);
    const accountDeletionSnapshot = new Map(this.accountDeletions);
    try {
      const output = [];
      for (const statement of statements) output.push(await statement.run());
      return output;
    } catch (error) {
      this.accounts.clear();
      this.accountBySubject.clear();
      this.sessions.clear();
      this.deletedSessions.clear();
      this.flows.clear();
      this.proRoomLinks.clear();
      this.accountDeletions.clear();
      for (const entry of accountSnapshot) this.accounts.set(...entry);
      for (const entry of subjectSnapshot) this.accountBySubject.set(...entry);
      for (const entry of sessionSnapshot) this.sessions.set(...entry);
      for (const entry of deletedSessionSnapshot) this.deletedSessions.set(...entry);
      for (const entry of flowSnapshot) this.flows.set(...entry);
      for (const entry of proRoomLinkSnapshot) this.proRoomLinks.set(...entry);
      for (const entry of accountDeletionSnapshot) this.accountDeletions.set(...entry);
      throw error;
    }
  }

  async all(sql: string, values: unknown[]): Promise<Record<string, unknown>[]> {
    this.assertAvailable();
    this.boundValues.push([...values]);
    const normalized = normalizeSql(sql);
    if (normalized.includes('from mxqr_account_pro_room_generations')) {
      throw new Error('no such table: mxqr_account_pro_room_generations');
    }
    if (normalized.includes('from mxqr_account_pro_rooms')) {
      const accountId = String(values[0]);
      return [...this.proRoomLinks.values()]
        .filter((row) => row.account_id === accountId)
        .sort((left, right) => left.room_code.localeCompare(right.room_code))
        .slice(0, 1001)
        .map((row) => ({ room_code: row.room_code }));
    }
    const row = await this.first(sql, values);
    return row ? [row] : [];
  }

  async first(sql: string, values: unknown[]): Promise<Record<string, unknown> | null> {
    this.assertAvailable();
    this.boundValues.push([...values]);
    const normalized = normalizeSql(sql);
    if (normalized.includes('from mxqr_accounts') && normalized.includes('nickname_key = ?1')) {
      const nicknameKey = String(values[0]);
      const account = [...this.accounts.values()].find((row) => row.nickname_key === nicknameKey);
      return account ? { account_id: account.account_id } : null;
    }
    if (normalized.includes('from mxqr_accounts') && normalized.includes('google_subject_hash')) {
      const accountId = this.accountBySubject.get(String(values[0]));
      const account = accountId ? this.accounts.get(accountId) : null;
      return account ? { ...account } : null;
    }
    if (normalized.includes('from mxqr_account_sessions s')) {
      const session = this.sessions.get(String(values[0]));
      const account = session ? this.accounts.get(session.account_id) : null;
      return session && account ? { ...session, ...account } : null;
    }
    if (normalized.includes('from mxqr_account_deleted_sessions')) {
      const deletedSession = this.deletedSessions.get(String(values[0]));
      return deletedSession ? { ...deletedSession } : null;
    }
    throw new Error(`Unexpected D1 first: ${normalized}`);
  }

  async run(sql: string, values: unknown[]): Promise<{ success: true; meta: { changes: number } }> {
    this.assertAvailable();
    this.boundValues.push([...values]);
    const normalized = normalizeSql(sql);

    if (
      normalized.startsWith('insert into mxqr_oauth_flows') ||
      normalized.startsWith('insert or ignore into mxqr_oauth_flows')
    ) {
      const [stateHash, createdAt, expiresAt] = values as [string, number, number];
      if (this.flows.has(stateHash)) return changed(0);
      this.flows.set(stateHash, {
        state_hash: stateHash,
        created_at: createdAt,
        expires_at: expiresAt,
      });
      return changed(1);
    }
    if (
      normalized.startsWith('delete from mxqr_oauth_flows') &&
      normalized.includes('state_hash = ?1')
    ) {
      const [stateHash, now] = values as [string, number];
      const flow = this.flows.get(stateHash);
      if (!flow || flow.expires_at <= now) return changed(0);
      this.flows.delete(stateHash);
      return changed(1);
    }
    if (
      normalized.startsWith('delete from mxqr_oauth_flows') &&
      normalized.includes('expires_at <= ?1')
    ) {
      const now = Number(values[0]);
      let count = 0;
      for (const [key, flow] of this.flows) {
        if (flow.expires_at <= now) {
          this.flows.delete(key);
          count += 1;
        }
      }
      return changed(count);
    }
    if (normalized.startsWith('insert into mxqr_accounts')) {
      const [proposedId, subjectHash, now] = values as [string, string, number];
      const currentId = this.accountBySubject.get(subjectHash);
      if (currentId) {
        const current = this.accounts.get(currentId)!;
        current.updated_at = now;
        return changed(1);
      }
      const account: AccountRow = {
        account_id: proposedId,
        google_subject_hash: subjectHash,
        nickname: null,
        nickname_key: null,
        profile_complete: 0,
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      this.accounts.set(proposedId, account);
      this.accountBySubject.set(subjectHash, proposedId);
      return changed(1);
    }
    if (normalized.startsWith('insert into mxqr_account_sessions')) {
      const [sessionHash, accountId, now, expiresAt] = values as [string, string, number, number];
      this.sessions.set(sessionHash, {
        session_hash: sessionHash,
        account_id: accountId,
        created_at: now,
        last_seen_at: now,
        expires_at: expiresAt,
      });
      return changed(1);
    }
    if (normalized.startsWith('insert or replace into mxqr_account_deleted_sessions')) {
      const [accountId, deletedAt, expiresAt] = values as [string, number, number];
      let count = 0;
      for (const session of this.sessions.values()) {
        if (session.account_id !== accountId) continue;
        this.deletedSessions.set(session.session_hash, {
          session_hash: session.session_hash,
          account_id: accountId,
          deleted_at: deletedAt,
          expires_at: expiresAt,
        });
        count += 1;
      }
      return changed(count);
    }
    if (normalized.startsWith('insert into mxqr_account_pro_rooms')) {
      const [accountId, roomCode, now, maxLinks] = values as [string, string, number, number];
      const account = this.accounts.get(accountId);
      const deletionStartedAt = this.accountDeletions.get(accountId);
      if (!account || account.status !== 'active' || deletionStartedAt !== undefined) {
        return changed(0);
      }
      const key = `${accountId}:${roomCode}`;
      const existing = this.proRoomLinks.get(key);
      const accountLinkCount = [...this.proRoomLinks.values()].filter(
        (row) => row.account_id === accountId,
      ).length;
      if (!existing && accountLinkCount >= maxLinks) return changed(0);
      this.proRoomLinks.set(key, {
        account_id: accountId,
        room_code: roomCode,
        first_linked_at: existing?.first_linked_at ?? now,
        last_seen_at: now,
      });
      return changed(1);
    }
    if (normalized.startsWith('insert into mxqr_account_deletions')) {
      const [accountId, startedAt, staleBefore] = values as [string, number, number];
      const existing = this.accountDeletions.get(accountId);
      if (!this.accounts.has(accountId) || (existing !== undefined && existing > staleBefore)) {
        return changed(0);
      }
      this.accountDeletions.set(accountId, startedAt);
      return changed(1);
    }
    if (normalized.startsWith('update mxqr_account_sessions set last_seen_at')) {
      const [lastSeenAt, sessionHash] = values as [number, string];
      const session = this.sessions.get(sessionHash);
      if (!session) return changed(0);
      session.last_seen_at = lastSeenAt;
      return changed(1);
    }
    if (
      normalized.startsWith('delete from mxqr_account_sessions') &&
      normalized.includes('session_hash = ?1')
    ) {
      return changed(this.sessions.delete(String(values[0])) ? 1 : 0);
    }
    if (
      normalized.startsWith('delete from mxqr_account_sessions') &&
      normalized.includes('session_hash <> ?2')
    ) {
      const [accountId, retainedHash] = values as [string, string];
      const retainedOthers = [...this.sessions.values()]
        .filter(
          (session) => session.account_id === accountId && session.session_hash !== retainedHash,
        )
        .sort(
          (left, right) =>
            right.last_seen_at - left.last_seen_at ||
            right.created_at - left.created_at ||
            right.session_hash.localeCompare(left.session_hash),
        )
        .slice(0, 127);
      const retained = new Set(retainedOthers.map((session) => session.session_hash));
      let count = 0;
      for (const [key, session] of this.sessions) {
        if (
          session.account_id === accountId &&
          key !== retainedHash &&
          !retained.has(session.session_hash)
        ) {
          this.sessions.delete(key);
          count += 1;
        }
      }
      return changed(count);
    }
    if (normalized.startsWith('delete from mxqr_account_deleted_sessions')) {
      if (normalized.includes('session_hash = ?1')) {
        return changed(this.deletedSessions.delete(String(values[0])) ? 1 : 0);
      }
      if (normalized.includes('expires_at <= ?1')) {
        const now = Number(values[0]);
        let count = 0;
        for (const [key, session] of this.deletedSessions) {
          if (session.expires_at <= now) {
            this.deletedSessions.delete(key);
            count += 1;
          }
        }
        return changed(count);
      }
    }
    if (
      normalized.startsWith('delete from mxqr_account_sessions') &&
      normalized.includes('account_id = ?1')
    ) {
      const accountId = String(values[0]);
      let count = 0;
      for (const [key, session] of this.sessions) {
        if (session.account_id === accountId) {
          this.sessions.delete(key);
          count += 1;
        }
      }
      return changed(count);
    }
    if (normalized.startsWith('delete from mxqr_account_pro_rooms')) {
      const accountId = String(values[0]);
      let count = 0;
      for (const [key, row] of this.proRoomLinks) {
        if (row.account_id !== accountId) continue;
        this.proRoomLinks.delete(key);
        count += 1;
      }
      return changed(count);
    }
    if (normalized.startsWith('delete from mxqr_account_deletions')) {
      if (normalized.includes('started_at = ?2')) {
        const [accountId, startedAt] = values as [string, number];
        if (this.accountDeletions.get(accountId) !== startedAt) return changed(0);
        this.accountDeletions.delete(accountId);
        return changed(1);
      }
      return changed(this.accountDeletions.delete(String(values[0])) ? 1 : 0);
    }
    if (
      normalized.startsWith('delete from mxqr_account_sessions') &&
      normalized.includes('expires_at <= ?1')
    ) {
      const now = Number(values[0]);
      let count = 0;
      for (const [key, session] of this.sessions) {
        if (session.expires_at <= now) {
          this.sessions.delete(key);
          count += 1;
        }
      }
      return changed(count);
    }
    if (normalized.startsWith('update mxqr_accounts set nickname')) {
      if (this.nicknameWriteError) throw this.nicknameWriteError;
      const [nickname, nicknameKey, updatedAt, accountId] = values as [
        string,
        string,
        number,
        string,
      ];
      const account = this.accounts.get(accountId);
      if (!account || account.status !== 'active') return changed(0);
      const collision = [...this.accounts.values()].some(
        (candidate) => candidate.account_id !== accountId && candidate.nickname_key === nicknameKey,
      );
      if (collision) {
        throw new Error('UNIQUE constraint failed: mxqr_accounts.nickname_key');
      }
      account.nickname = nickname;
      account.nickname_key = nicknameKey;
      account.profile_complete = 1;
      account.updated_at = updatedAt;
      return changed(1);
    }
    if (normalized.startsWith('delete from mxqr_accounts')) {
      const accountId = String(values[0]);
      const account = this.accounts.get(accountId);
      if (!account) return changed(0);
      this.accounts.delete(accountId);
      this.accountBySubject.delete(account.google_subject_hash);
      return changed(1);
    }
    throw new Error(`Unexpected D1 run: ${normalized}`);
  }

  private assertAvailable(): void {
    if (this.fail) throw new Error('D1 unavailable');
  }
}

function createProRoomRegistryDb(registeredRoomCodes: readonly string[] = ['000001']) {
  const registered = new Set(registeredRoomCodes);
  return {
    prepare: vi.fn((sql: string) => ({
      bind: (roomCode: string) => ({
        first: vi.fn(async () => {
          if (!normalizeSql(sql).includes('from mxqr_pro_room_registry')) {
            throw new Error(`Unexpected registry query: ${normalizeSql(sql)}`);
          }
          return registered.has(roomCode) ? { status: 'registered' } : null;
        }),
      }),
    })),
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function changed(changes: number): { success: true; meta: { changes: number } } {
  return { success: true, meta: { changes } };
}

const CLIENT_ID = 'mxqr-test.apps.googleusercontent.com';
const GOOGLE_SUBJECT = 'google-subject-123';
const GOOGLE_EMAIL = 'person@example.com';
const GOOGLE_CALLBACK_ISSUER_QUERY = 'iss=https%3A%2F%2Faccounts.google.com';
const SESSION_PEPPER = 'session-pepper-for-tests-at-least-32-bytes';
const SUBJECT_PEPPER = 'subject-pepper-for-tests-at-least-32-bytes';
const STATE_SECRET = 'oauth-state-secret-for-tests-at-least-32-bytes';
const STANDARD_ROOM_ASSERTION_SECRET = 'standard-room-assertion-secret-for-tests-at-least-32-bytes';
const KEY_ID = 'mxqr-test-key';

let signingKeys: CryptoKeyPair;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  signingKeys = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  publicJwk = await crypto.subtle.exportKey('jwk', signingKeys.publicKey);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetAccountAuthCachesForTests();
});

function authEnv(
  db = new FakeAuthDb(),
): Record<string, unknown> & { MUSIXQUARE_AUTH_DB: FakeAuthDb } {
  return {
    MUSIXQUARE_AUTH_DB: db,
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    MXQR_AUTH_SESSION_PEPPER: SESSION_PEPPER,
    MXQR_AUTH_SUBJECT_PEPPER: SUBJECT_PEPPER,
    MXQR_OAUTH_STATE_SECRET: STATE_SECRET,
    MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET: STANDARD_ROOM_ASSERTION_SECRET,
  };
}

function setCookieValues(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = response.headers.get('Set-Cookie');
  return combined ? combined.split(/,(?=\s*__Host-mxqr_)/) : [];
}

function cookiePair(response: Response, name: string): string {
  const value = setCookieValues(response).find((cookie) => cookie.trim().startsWith(`${name}=`));
  if (!value) throw new Error(`Missing cookie ${name}`);
  return value.trim().split(';')[0];
}

function optionalCookiePair(response: Response, name: string): string | null {
  const value = setCookieValues(response).find((cookie) => cookie.trim().startsWith(`${name}=`));
  return value ? value.trim().split(';')[0] : null;
}

function oauthFlowCookieName(state: string): string {
  return `__Host-mxqr_oauth_flow_${state.slice(0, 16)}`;
}

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function idToken(
  nonce: string,
  overrides: Record<string, unknown> = {},
  tamperSignature = false,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: GOOGLE_SUBJECT,
      email: GOOGLE_EMAIL,
      email_verified: true,
      nonce,
      iat: now,
      exp: now + 600,
      ...overrides,
    }),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      signingKeys.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  );
  let encodedSignature = base64Url(signature);
  if (tamperSignature) {
    const replacement = encodedSignature[20] === 'A' ? 'B' : 'A';
    encodedSignature = `${encodedSignature.slice(0, 20)}${replacement}${encodedSignature.slice(21)}`;
  }
  return `${header}.${payload}.${encodedSignature}`;
}

interface GoogleFetchOptions {
  claimOverrides?: Record<string, unknown>;
  nonceOverride?: string;
  tamperSignature?: boolean;
  tokenStatus?: number;
}

function stubGoogle(nonce: string, options: GoogleFetchOptions = {}) {
  const requests: Request[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    if (request.url === 'https://oauth2.googleapis.com/token') {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
          status: options.tokenStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id_token: await idToken(
            options.nonceOverride ?? nonce,
            options.claimOverrides,
            options.tamperSignature,
          ),
          access_token: 'must-never-be-stored',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (request.url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }],
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600',
          },
        },
      );
    }
    throw new Error(`Unexpected fetch ${request.method} ${request.url}`);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, requests };
}

function stubGoogleByAuthorizationCode(nonces: Readonly<Record<string, string>>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(await request.text());
      const nonce = nonces[body.get('code') || ''];
      if (!nonce) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ id_token: await idToken(nonce) }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (request.url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(
        JSON.stringify({ keys: [{ ...publicJwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }] }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600',
          },
        },
      );
    }
    throw new Error(`Unexpected fetch ${request.method} ${request.url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function applyResponseCookies(jar: Map<string, string>, response: Response): void {
  for (const cookie of setCookieValues(response)) {
    const pair = cookie.trim().split(';')[0] || '';
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name);
    else jar.set(name, `${name}=${value}`);
  }
}

function cookieHeader(jar: ReadonlyMap<string, string>): string {
  return [...jar.values()].join('; ');
}

async function startLogin(
  env: Record<string, unknown>,
  returnTo = '/000001?panel=connect#account',
  cookie = '',
) {
  const request = new Request(
    `https://musixquare.com/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`,
    cookie ? { headers: { Cookie: cookie } } : undefined,
  );
  const response = await handleAccountAuthRequest(request, env);
  const location = new URL(response!.headers.get('Location')!);
  const state = location.searchParams.get('state')!;
  const flowCookieName = oauthFlowCookieName(state);
  return {
    response: response!,
    location,
    flowCookieName,
    flowCookie: cookiePair(response!, flowCookieName),
  };
}

async function completeLogin(
  env: Record<string, unknown>,
  returnTo = '/000001?panel=connect#account',
  options: GoogleFetchOptions = {},
) {
  const started = await startLogin(env, returnTo);
  const google = stubGoogle(started.location.searchParams.get('nonce')!, options);
  const callback = await handleAccountAuthRequest(
    new Request(
      `https://musixquare.com/api/auth/google/callback?code=authorization-code-123&state=${encodeURIComponent(started.location.searchParams.get('state')!)}&${GOOGLE_CALLBACK_ISSUER_QUERY}`,
      { headers: { Cookie: started.flowCookie } },
    ),
    env,
  );
  return {
    ...started,
    google,
    callback: callback!,
    sessionCookie: optionalCookiePair(callback!, '__Host-mxqr_account'),
  };
}

function mutationHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Origin: 'https://musixquare.com',
    'Content-Type': 'application/json',
    'X-MXQR-Account-CSRF': '1',
  };
}

describe('optional account authentication configuration', () => {
  it('fails closed as unconfigured without affecting the App Worker route', async () => {
    const direct = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/session'),
      {},
    );
    expect(direct?.status).toBe(200);
    await expect(direct?.json()).resolves.toEqual({
      configured: false,
      authenticated: false,
      account: null,
    });

    const appResponse = await appWorker.fetch(
      new Request('https://musixquare.com/api/auth/session'),
      {},
      {},
    );
    expect(appResponse.status).toBe(200);
    expect(appResponse.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expect(appResponse.json()).resolves.toEqual({
      configured: false,
      authenticated: false,
      account: null,
    });

    const start = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/google/start'),
      {},
    );
    expect(start?.status).toBe(503);
    await expect(start?.json()).resolves.toEqual({ error: 'AUTH_NOT_CONFIGURED' });
  });

  it('never forwards the account cookie through the PRO room cookie facade', async () => {
    let forwarded: Request | null = null;
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/v1/rooms/000001/session', {
        headers: {
          Origin: 'https://musixquare.com',
          Cookie:
            '__Host-mxqr_account=account-secret; __Secure-mxqr_pro_session_000001=room-secret',
          [ACCOUNT_ASSERTION_HEADER]: 'browser-spoof',
        },
      }),
      {
        PRO_ROOM_PUBLIC_API: {
          fetch: vi.fn(async (request: Request) => {
            forwarded = request;
            return new Response('{}', {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }),
        },
      },
      {},
    );

    expect(response.status).toBe(200);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.headers.get('Cookie')).toBe('__Host-mxqr_pro_session_000001=room-secret');
    expect(forwarded!.headers.get('Cookie')).not.toContain('account-secret');
    expect(forwarded!.headers.get(ACCOUNT_ASSERTION_HEADER)).toBeNull();
  });
});

describe('Google Authorization Code + PKCE account flow', () => {
  it('canonicalizes www to the apex before issuing the host-only flow cookie', async () => {
    const response = await handleAccountAuthRequest(
      new Request(
        'https://www.musixquare.com/api/auth/google/start?returnTo=%2F000001%3Fpanel%3Dconnect',
      ),
      authEnv(),
    );
    expect(response?.status).toBe(307);
    expect(response?.headers.get('Location')).toBe(
      'https://musixquare.com/api/auth/google/start?returnTo=%2F000001%3Fpanel%3Dconnect',
    );
    expect(response && setCookieValues(response)).toEqual([]);

    const canonical = await handleAccountAuthRequest(
      new Request(response!.headers.get('Location')!),
      authEnv(),
    );
    expect(canonical?.status).toBe(302);
    const canonicalLocation = new URL(canonical!.headers.get('Location')!);
    const flowName = oauthFlowCookieName(canonicalLocation.searchParams.get('state')!);
    expect(canonical && cookiePair(canonical, flowName)).toMatch(
      /^__Host-mxqr_oauth_flow_[A-Za-z0-9_-]{16}=v1\./,
    );
  });

  it('uses encrypted one-time state, verifies Google, and stores only pseudonymous credentials', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const result = await completeLogin(env);

    expect(result.response.status).toBe(302);
    expect(result.location.origin).toBe('https://accounts.google.com');
    expect(result.location.searchParams.get('response_type')).toBe('code');
    expect(result.location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(result.location.searchParams.get('scope')).toBe('openid email');
    expect(result.location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(result.location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.location.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const flowSetCookie = setCookieValues(result.response).join('\n');
    expect(flowSetCookie).toContain('HttpOnly');
    expect(flowSetCookie).toContain('Secure');
    expect(flowSetCookie).toContain('SameSite=Lax');
    expect(flowSetCookie).toContain('Path=/');
    expect(flowSetCookie).not.toContain('Domain=');
    expect(flowSetCookie).not.toContain(result.location.searchParams.get('state'));
    expect(db.flows.size).toBe(1);

    expect(result.callback.status).toBe(303);
    expect(result.callback.headers.get('Location')).toBe(
      'https://musixquare.com/000001?panel=connect#account',
    );
    expect(result.sessionCookie).toMatch(/^__Host-mxqr_account=[A-Za-z0-9_-]{43}$/);
    const callbackCookies = setCookieValues(result.callback).join('\n');
    expect(callbackCookies).toContain(`${result.flowCookieName}=;`);
    expect(callbackCookies).toContain('HttpOnly');
    expect(callbackCookies).toContain('Secure');
    expect(callbackCookies).toContain('SameSite=Lax');
    expect(callbackCookies).not.toContain('Domain=');

    expect(db.accounts.size).toBe(1);
    expect(db.sessions.size).toBe(1);
    const storedAccount = [...db.accounts.values()][0];
    const storedSession = [...db.sessions.values()][0];
    const rawSessionToken = result.sessionCookie!.split('=')[1];
    expect(storedAccount.account_id).toMatch(/^acct_[A-Za-z0-9_-]{22}$/);
    expect(storedAccount.google_subject_hash).not.toBe(GOOGLE_SUBJECT);
    expect(storedSession.session_hash).not.toBe(rawSessionToken);
    expect(JSON.stringify([...db.boundValues])).not.toContain(GOOGLE_SUBJECT);
    expect(JSON.stringify([...db.boundValues])).not.toContain(GOOGLE_EMAIL);
    expect(JSON.stringify([...db.boundValues])).not.toContain('must-never-be-stored');
    expect(JSON.stringify([...db.boundValues])).not.toContain(rawSessionToken);

    const tokenRequest = result.google.requests.find(
      (request) => request.url === 'https://oauth2.googleapis.com/token',
    );
    const tokenBody = new URLSearchParams(await tokenRequest!.text());
    expect(tokenBody.get('grant_type')).toBe('authorization_code');
    expect(tokenBody.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    const session = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/session', {
        headers: { Cookie: result.sessionCookie! },
      }),
      env,
    );
    expect(session?.status).toBe(200);
    await expect(session?.json()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: {
        nickname: '',
        profileComplete: false,
      },
    });
    await expect(
      resolveAccountSession(
        new Request('https://musixquare.com/', {
          headers: { Cookie: result.sessionCookie! },
        }),
        env,
      ),
    ).resolves.toEqual({
      accountId: storedAccount.account_id,
      nickname: '',
      profileComplete: false,
    });
  });

  it('keeps two simultaneous tab flows independent through both successful callbacks', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const jar = new Map<string, string>();
    const first = await startLogin(env, '/first');
    applyResponseCookies(jar, first.response);
    const second = await startLogin(env, '/second', cookieHeader(jar));
    applyResponseCookies(jar, second.response);

    expect(first.flowCookieName).not.toBe(second.flowCookieName);
    expect([...jar.keys()].filter((name) => name.startsWith('__Host-mxqr_oauth_flow_'))).toEqual(
      expect.arrayContaining([first.flowCookieName, second.flowCookieName]),
    );

    const firstCode = 'authorization-code-first';
    const secondCode = 'authorization-code-second';
    stubGoogleByAuthorizationCode({
      [firstCode]: first.location.searchParams.get('nonce')!,
      [secondCode]: second.location.searchParams.get('nonce')!,
    });
    const firstCallback = await handleAccountAuthRequest(
      new Request(
        `https://musixquare.com/api/auth/google/callback?code=${firstCode}&state=${first.location.searchParams.get('state')}&${GOOGLE_CALLBACK_ISSUER_QUERY}`,
        { headers: { Cookie: cookieHeader(jar) } },
      ),
      env,
    );
    expect(firstCallback?.status).toBe(303);
    expect(firstCallback?.headers.get('Location')).toBe('https://musixquare.com/first');
    const firstCallbackCookies = setCookieValues(firstCallback!).join('\n');
    expect(firstCallbackCookies).toContain(`${first.flowCookieName}=;`);
    expect(firstCallbackCookies).not.toContain(`${second.flowCookieName}=;`);
    applyResponseCookies(jar, firstCallback!);
    expect(jar.has(first.flowCookieName)).toBe(false);
    expect(jar.has(second.flowCookieName)).toBe(true);

    const secondCallback = await handleAccountAuthRequest(
      new Request(
        `https://musixquare.com/api/auth/google/callback?code=${secondCode}&state=${second.location.searchParams.get('state')}&${GOOGLE_CALLBACK_ISSUER_QUERY}`,
        { headers: { Cookie: cookieHeader(jar) } },
      ),
      env,
    );
    expect(secondCallback?.status).toBe(303);
    expect(secondCallback?.headers.get('Location')).toBe('https://musixquare.com/second');
    expect(setCookieValues(secondCallback!).join('\n')).toContain(`${second.flowCookieName}=;`);
    expect(db.accounts.size).toBe(1);
    expect(db.sessions.size).toBe(2);
    expect(db.flows.size).toBe(2);
  });

  it('bounds active OAuth cookies to three and removes expired flow cookies on the next start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
    const env = authEnv();
    const jar = new Map<string, string>();
    const started = [];

    for (let index = 0; index < 4; index += 1) {
      const flow = await startLogin(env, `/flow-${index}`, cookieHeader(jar));
      started.push(flow);
      applyResponseCookies(jar, flow.response);
      vi.setSystemTime(Date.now() + 1000);
    }

    const activeNames = [...jar.keys()].filter((name) =>
      name.startsWith('__Host-mxqr_oauth_flow_'),
    );
    expect(activeNames).toHaveLength(3);
    expect(activeNames).not.toContain(started[0]!.flowCookieName);
    expect(activeNames).toEqual(
      expect.arrayContaining(started.slice(1).map((flow) => flow.flowCookieName)),
    );

    const oldestActive = started[1]!;
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    const fresh = await startLogin(env, '/after-expiry', cookieHeader(jar));
    const freshCookies = setCookieValues(fresh.response).join('\n');
    expect(freshCookies).toContain(`${oldestActive.flowCookieName}=;`);
    applyResponseCookies(jar, fresh.response);
    expect([...jar.keys()].filter((name) => name.startsWith('__Host-mxqr_oauth_flow_'))).toEqual([
      fresh.flowCookieName,
    ]);
  });

  it('sanitizes an external return path instead of creating an open redirect', async () => {
    const result = await completeLogin(authEnv(), 'https://evil.example/steal');
    expect(result.callback.status).toBe(303);
    expect(result.callback.headers.get('Location')).toBe('https://musixquare.com/');
  });

  it.each([
    ['long ASCII', `/${'a'.repeat(1400)}`],
    ['long multibyte', `/${'🎵'.repeat(300)}`],
  ])('bounds %s return paths before sealing the OAuth cookie', async (_label, returnTo) => {
    const env = authEnv();
    const result = await completeLogin(env, returnTo);

    expect(result.callback.status).toBe(303);
    expect(result.callback.headers.get('Location')).toBe('https://musixquare.com/');
    const flowCookie = cookiePair(result.response, result.flowCookieName);
    expect(flowCookie?.length).toBeLessThan(3072);
  });

  it('rejects state mismatch before calling Google and consumes state only once', async () => {
    const env = authEnv();
    const started = await startLogin(env);
    const google = stubGoogle(started.location.searchParams.get('nonce')!);
    const mismatch = await handleAccountAuthRequest(
      new Request(
        'https://musixquare.com/api/auth/google/callback?code=authorization-code-123&state=wrong-state',
        { headers: { Cookie: started.flowCookie } },
      ),
      env,
    );
    expect(mismatch?.status).toBe(400);
    expect(google.mock).not.toHaveBeenCalled();

    const validUrl = `https://musixquare.com/api/auth/google/callback?code=authorization-code-123&state=${started.location.searchParams.get('state')}&${GOOGLE_CALLBACK_ISSUER_QUERY}`;
    const first = await handleAccountAuthRequest(
      new Request(validUrl, { headers: { Cookie: started.flowCookie } }),
      env,
    );
    expect(first?.status).toBe(303);
    const callsAfterFirst = google.mock.mock.calls.length;
    const replay = await handleAccountAuthRequest(
      new Request(validUrl, { headers: { Cookie: started.flowCookie } }),
      env,
    );
    expect(replay?.status).toBe(400);
    await expect(replay?.json()).resolves.toEqual({ error: 'AUTH_FLOW_INVALID' });
    expect(google.mock).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('fails closed on duplicate state, a colliding prefix, and duplicate flow cookies without deleting the valid flow', async () => {
    const env = authEnv();
    const started = await startLogin(env);
    const state = started.location.searchParams.get('state')!;
    const google = stubGoogle(started.location.searchParams.get('nonce')!);
    const forgedState = `${state.slice(0, 16)}${state[16] === 'A' ? 'B' : 'A'}${state.slice(17)}`;
    const attempts = [
      new Request(
        `https://musixquare.com/api/auth/google/callback?code=authorization-code-123&state=${state}&state=${state}`,
        { headers: { Cookie: started.flowCookie } },
      ),
      new Request(
        `https://musixquare.com/api/auth/google/callback?code=authorization-code-123&state=${forgedState}`,
        { headers: { Cookie: started.flowCookie } },
      ),
      new Request(
        `https://musixquare.com/api/auth/google/callback?code=authorization-code-123&state=${state}&${GOOGLE_CALLBACK_ISSUER_QUERY}`,
        { headers: { Cookie: `${started.flowCookie}; ${started.flowCookie}` } },
      ),
    ];

    for (const request of attempts) {
      const rejected = await handleAccountAuthRequest(request, env);
      expect(rejected?.status).toBe(400);
      await expect(rejected?.json()).resolves.toEqual({ error: 'AUTH_FLOW_INVALID' });
      expect(rejected && setCookieValues(rejected)).toEqual([]);
    }
    expect(google.mock).not.toHaveBeenCalled();

    const valid = await handleAccountAuthRequest(
      new Request(
        `https://musixquare.com/api/auth/google/callback?code=authorization-code-123&state=${state}&${GOOGLE_CALLBACK_ISSUER_QUERY}`,
        { headers: { Cookie: started.flowCookie } },
      ),
      env,
    );
    expect(valid?.status).toBe(303);
    expect(google.mock).toHaveBeenCalled();
  });

  it('validates state on provider errors without letting a forged error cancel the flow', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const started = await startLogin(env);

    for (const query of ['error=access_denied', 'error=access_denied&state=wrong-state']) {
      const forged = await handleAccountAuthRequest(
        new Request(`https://musixquare.com/api/auth/google/callback?${query}`, {
          headers: { Cookie: started.flowCookie },
        }),
        env,
      );
      expect(forged?.status).toBe(400);
      await expect(forged?.json()).resolves.toEqual({ error: 'AUTH_FLOW_INVALID' });
      expect(forged && setCookieValues(forged)).toEqual([]);
      expect(db.flows.size).toBe(0);
    }

    const google = stubGoogle(started.location.searchParams.get('nonce')!);
    const valid = await handleAccountAuthRequest(
      new Request(
        `https://musixquare.com/api/auth/google/callback?code=authorization-code-123&state=${started.location.searchParams.get('state')}&${GOOGLE_CALLBACK_ISSUER_QUERY}`,
        { headers: { Cookie: started.flowCookie } },
      ),
      env,
    );
    expect(valid?.status).toBe(303);
    expect(google.mock).toHaveBeenCalled();
  });

  it('consumes a provider denial only when its state matches exactly', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const started = await startLogin(env);
    const state = started.location.searchParams.get('state')!;
    const denied = await handleAccountAuthRequest(
      new Request(
        `https://musixquare.com/api/auth/google/callback?error=access_denied&error_description=cancelled&state=${state}&${GOOGLE_CALLBACK_ISSUER_QUERY}`,
        { headers: { Cookie: started.flowCookie } },
      ),
      env,
    );

    expect(denied?.status).toBe(303);
    expect(denied?.headers.get('Location')).toBe(
      'https://musixquare.com/000001?panel=connect&accountAuth=cancelled#account',
    );
    expect(setCookieValues(denied!).join('\n')).toContain(`${started.flowCookieName}=;`);
    expect(db.flows.size).toBe(1);

    const replay = await handleAccountAuthRequest(
      new Request(
        `https://musixquare.com/api/auth/google/callback?error=access_denied&state=${state}`,
        { headers: { Cookie: started.flowCookie } },
      ),
      env,
    );
    expect(replay?.status).toBe(400);
    await expect(replay?.json()).resolves.toEqual({ error: 'AUTH_FLOW_INVALID' });
  });

  it('requires exactly the Google authorization issuer on successful callbacks', async () => {
    const issuerCases = [
      ['missing', []],
      ['wrong', ['https://evil.example']],
      ['duplicate', ['https://accounts.google.com', 'https://accounts.google.com']],
    ] as const;

    for (const [, issuers] of issuerCases) {
      const db = new FakeAuthDb();
      const env = authEnv(db);
      const started = await startLogin(env);
      const google = stubGoogle(started.location.searchParams.get('nonce')!);
      const query = new URLSearchParams({
        code: 'authorization-code-123',
        state: started.location.searchParams.get('state')!,
      });
      for (const issuer of issuers) query.append('iss', issuer);

      const callback = await handleAccountAuthRequest(
        new Request(`https://musixquare.com/api/auth/google/callback?${query}`, {
          headers: { Cookie: started.flowCookie },
        }),
        env,
      );

      expect(callback?.status).toBe(303);
      expect(callback?.headers.get('Location')).toBe(
        'https://musixquare.com/000001?panel=connect&accountAuth=error#account',
      );
      expect(google.mock).not.toHaveBeenCalled();
      expect(db.flows.size).toBe(1);
    }
  });

  it('requires exactly the Google authorization issuer on denied callbacks', async () => {
    const issuerCases = [
      ['missing', []],
      ['wrong', ['https://evil.example']],
      ['duplicate', ['https://accounts.google.com', 'https://accounts.google.com']],
    ] as const;

    for (const [, issuers] of issuerCases) {
      const db = new FakeAuthDb();
      const env = authEnv(db);
      const started = await startLogin(env);
      const google = stubGoogle(started.location.searchParams.get('nonce')!);
      const query = new URLSearchParams({
        error: 'access_denied',
        state: started.location.searchParams.get('state')!,
      });
      for (const issuer of issuers) query.append('iss', issuer);

      const callback = await handleAccountAuthRequest(
        new Request(`https://musixquare.com/api/auth/google/callback?${query}`, {
          headers: { Cookie: started.flowCookie },
        }),
        env,
      );

      expect(callback?.status).toBe(303);
      expect(callback?.headers.get('Location')).toBe(
        'https://musixquare.com/000001?panel=connect&accountAuth=error#account',
      );
      expect(google.mock).not.toHaveBeenCalled();
      expect(db.flows.size).toBe(1);
    }
  });

  it.each([
    ['nonce', { nonceOverride: 'wrong-nonce' }],
    ['issuer', { claimOverrides: { iss: 'https://evil.example' } }],
    ['audience', { claimOverrides: { aud: 'another-client' } }],
    ['authorized party', { claimOverrides: { azp: 'another-client' } }],
    ['expiry', { claimOverrides: { exp: 1 } }],
    ['verified email', { claimOverrides: { email_verified: false } }],
    ['signature', { tamperSignature: true }],
  ])('rejects an invalid Google %s assertion', async (_label, options) => {
    const result = await completeLogin(authEnv(), '/', options as GoogleFetchOptions);
    expect(result.callback.status).toBe(303);
    expect(result.callback.headers.get('Location')).toBe(
      'https://musixquare.com/?accountAuth=error',
    );
    expect(result.sessionCookie).toBeNull();
  });

  it('returns safely to the app when the provider or D1 is unavailable', async () => {
    const provider = await completeLogin(authEnv(), '/', { tokenStatus: 503 });
    expect(provider.callback.status).toBe(303);
    expect(provider.callback.headers.get('Location')).toBe(
      'https://musixquare.com/?accountAuth=error',
    );
    expect(provider.sessionCookie).toBeNull();

    vi.unstubAllGlobals();
    resetAccountAuthCachesForTests();
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const started = await startLogin(env);
    stubGoogle(started.location.searchParams.get('nonce')!);
    db.fail = true;
    const callback = await handleAccountAuthRequest(
      new Request(
        `https://musixquare.com/api/auth/google/callback?code=authorization-code-123&state=${started.location.searchParams.get('state')}&${GOOGLE_CALLBACK_ISSUER_QUERY}`,
        { headers: { Cookie: started.flowCookie } },
      ),
      env,
    );
    expect(callback?.status).toBe(303);
    expect(callback?.headers.get('Location')).toBe(
      'https://musixquare.com/000001?panel=connect&accountAuth=error#account',
    );
    expect(optionalCookiePair(callback!, '__Host-mxqr_account')).toBeNull();
  });
});

describe('account session mutations', () => {
  it('bounds one account to 128 browser sessions while retaining the newly issued session', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    await completeLogin(env);
    const accountId = [...db.accounts.keys()][0]!;
    const now = Date.now();
    for (let index = 0; index < 130; index += 1) {
      const sessionHash = `synthetic-session-${String(index).padStart(3, '0')}`;
      db.sessions.set(sessionHash, {
        session_hash: sessionHash,
        account_id: accountId,
        created_at: now + index,
        last_seen_at: now + index,
        expires_at: now + 86_400_000,
      });
    }

    vi.unstubAllGlobals();
    const latest = await completeLogin(env);
    expect(latest.callback.status).toBe(303);
    expect(db.sessions.size).toBe(128);
    expect([...db.sessions.values()].every((row) => row.account_id === accountId)).toBe(true);
    await expect(
      resolveAccountSession(
        new Request('https://musixquare.com/', {
          headers: { Cookie: latest.sessionCookie! },
        }),
        env,
      ),
    ).resolves.toMatchObject({ accountId });
  });

  it('normalizes profile nicknames and enforces same-origin CSRF', async () => {
    const env = authEnv();
    const login = await completeLogin(env);
    vi.unstubAllGlobals();
    const blocked = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/profile', {
        method: 'PATCH',
        headers: {
          Cookie: login.sessionCookie!,
          'Content-Type': 'application/json',
          'X-MXQR-Account-CSRF': '1',
        },
        body: JSON.stringify({ nickname: 'Minsu' }),
      }),
      env,
    );
    expect(blocked?.status).toBe(403);

    const updated = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/profile', {
        method: 'PATCH',
        headers: mutationHeaders(login.sessionCookie!),
        body: JSON.stringify({ nickname: 'e\u0301' }),
      }),
      env,
    );
    expect(updated?.status).toBe(200);
    const payload = (await updated?.json()) as {
      account: { nickname: string; profileComplete: boolean };
    };
    expect(payload.account.nickname).toBe('\u00e9');
    expect(payload.account.profileComplete).toBe(true);

    for (const nickname of [
      'Peer 3',
      'ADMIN',
      '#1',
      'name\u202E',
      'name\u0085',
      'Min su',
      '\u00a0Minsu',
      '\u0301',
      'fuck',
      'x'.repeat(13),
    ]) {
      const response = await handleAccountAuthRequest(
        new Request('https://musixquare.com/api/auth/profile', {
          method: 'PATCH',
          headers: mutationHeaders(login.sessionCookie!),
          body: JSON.stringify({ nickname }),
        }),
        env,
      );
      expect(response?.status, nickname).toBe(400);
      await expect(response?.json()).resolves.toEqual({ error: 'NICKNAME_INVALID' });
    }
  });

  it('reserves nickname compatibility keys globally and reports only real collisions', async () => {
    const db = new FakeAuthDb();
    const first = await completeLogin(authEnv(db));
    const second = await completeLogin(authEnv(db), undefined, {
      claimOverrides: { sub: 'second-google-account' },
    });
    vi.unstubAllGlobals();

    const firstWrite = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/profile', {
        method: 'PATCH',
        headers: mutationHeaders(first.sessionCookie!),
        body: JSON.stringify({ nickname: 'MUSIXQUARE' }),
      }),
      authEnv(db),
    );
    expect(firstWrite?.status).toBe(200);

    for (const nickname of ['musixquare', 'ＭＵＳＩＸＱＵＡＲＥ']) {
      const collision = await handleAccountAuthRequest(
        new Request('https://musixquare.com/api/auth/profile', {
          method: 'PATCH',
          headers: mutationHeaders(second.sessionCookie!),
          body: JSON.stringify({ nickname }),
        }),
        authEnv(db),
      );
      expect(collision?.status, nickname).toBe(409);
      await expect(collision?.json()).resolves.toEqual({ error: 'NICKNAME_TAKEN' });
    }

    const casingChange = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/profile', {
        method: 'PATCH',
        headers: mutationHeaders(first.sessionCookie!),
        body: JSON.stringify({ nickname: 'musixquare' }),
      }),
      authEnv(db),
    );
    expect(casingChange?.status).toBe(200);
  });

  it('does not misreport an unrelated nickname write failure as a collision', async () => {
    const db = new FakeAuthDb();
    const login = await completeLogin(authEnv(db));
    vi.unstubAllGlobals();
    db.nicknameWriteError = new Error('D1 disk I/O error');

    const response = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/profile', {
        method: 'PATCH',
        headers: mutationHeaders(login.sessionCookie!),
        body: JSON.stringify({ nickname: 'FreshName' }),
      }),
      authEnv(db),
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      error: 'AUTH_TEMPORARILY_UNAVAILABLE',
    });
  });

  it('replaces a browser spoof with a verified short-lived PRO account assertion', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const login = await completeLogin(env);
    const profile = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/profile', {
        method: 'PATCH',
        headers: mutationHeaders(login.sessionCookie!),
        body: JSON.stringify({ nickname: 'Minsu' }),
      }),
      env,
    );
    expect(profile?.status).toBe(200);

    const assertionSecret = 'facade-assertion-secret-'.padEnd(48, 'a');
    let forwarded: Request | null = null;
    const response = await appWorker.fetch(
      new Request('https://musixquare.com/api/pro-room/v1/rooms/000001/sessions', {
        method: 'POST',
        headers: {
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          Cookie: login.sessionCookie!,
          [ACCOUNT_ASSERTION_HEADER]: 'browser-spoof',
        },
        body: JSON.stringify({ pin: '12345678', displayName: 'Peer' }),
      }),
      {
        ...env,
        MUSIXQUARE_ADMIN_DB: createProRoomRegistryDb(),
        MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: assertionSecret,
        PRO_ROOM_PUBLIC_API: {
          fetch: vi.fn(async (request: Request) => {
            forwarded = request;
            return Response.json({ ok: true }, { headers: { 'x-mxqr-account-linked': '1' } });
          }),
        },
      },
      {},
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-mxqr-account-linked')).toBeNull();
    expect([...db.proRoomLinks.values()]).toEqual([
      expect.objectContaining({ room_code: '000001' }),
    ]);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.headers.get('Cookie')).toBeNull();
    const assertion = forwarded!.headers.get(ACCOUNT_ASSERTION_HEADER);
    expect(assertion).not.toBe('browser-spoof');
    await expect(
      verifyAccountAssertion(assertion, assertionSecret, {
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        roomCode: '000001',
      }),
    ).resolves.toMatchObject({ nickname: 'Minsu', roomCode: '000001' });
  });

  it('renews an existing PRO account lease without rewriting the cleanup reverse index', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const login = await completeLogin(env);
    const profile = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/profile', {
        method: 'PATCH',
        headers: mutationHeaders(login.sessionCookie!),
        body: JSON.stringify({ nickname: 'Minsu' }),
      }),
      env,
    );
    expect(profile?.status).toBe(200);

    const assertionSecret = 'facade-assertion-secret-'.padEnd(48, 'a');
    let forwarded: Request | null = null;
    const response = await appWorker.fetch(
      new Request(
        'https://musixquare.com/api/pro-room/v1/rooms/000001/sessions/current/account/lease',
        {
          method: 'POST',
          headers: {
            Origin: 'https://musixquare.com',
            Cookie: `${login.sessionCookie}; __Secure-mxqr_pro_session_000001=room-session`,
            [ACCOUNT_ASSERTION_HEADER]: 'browser-spoof',
          },
        },
      ),
      {
        ...env,
        // Lease renewal cannot establish a new account-room relationship and
        // therefore skips the reverse-index write, but still resolves the
        // current immutable generation before an assertion is minted.
        MUSIXQUARE_ADMIN_DB: createProRoomRegistryDb(),
        MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: assertionSecret,
        PRO_ROOM_PUBLIC_API: {
          fetch: vi.fn(async (request: Request) => {
            forwarded = request;
            return Response.json({ ok: true, leaseExpiresAtMs: Date.now() + 120_000 });
          }),
        },
      },
      {},
    );
    expect(response.status).toBe(200);
    expect(db.proRoomLinks.size).toBe(0);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.headers.get('Cookie')).toBe('__Host-mxqr_pro_session_000001=room-session');
    const assertion = forwarded!.headers.get(ACCOUNT_ASSERTION_HEADER);
    expect(assertion).not.toBe('browser-spoof');
    await expect(
      verifyAccountAssertion(assertion, assertionSecret, {
        audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
        roomCode: '000001',
      }),
    ).resolves.toMatchObject({ nickname: 'Minsu', roomCode: '000001' });
  });

  it('does not grow account cleanup edges for unregistered rooms with invalid PINs', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const login = await completeLogin(env);
    const profile = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/profile', {
        method: 'PATCH',
        headers: mutationHeaders(login.sessionCookie!),
        body: JSON.stringify({ nickname: 'Minsu' }),
      }),
      env,
    );
    expect(profile?.status).toBe(200);

    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get(ACCOUNT_ASSERTION_HEADER)).toBeNull();
      return Response.json({ error: 'PIN_INVALID' }, { status: 401 });
    });
    const facadeEnv = {
      ...env,
      MUSIXQUARE_ADMIN_DB: createProRoomRegistryDb(),
      MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET: 'facade-assertion-secret-'.padEnd(48, 'a'),
      PRO_ROOM_PUBLIC_API: { fetch: upstreamFetch },
    };
    const unregisteredRoomCodes = Array.from({ length: 1_001 }, (_, index) =>
      String(index + 1_000).padStart(6, '0'),
    );

    for (const roomCode of unregisteredRoomCodes) {
      const response = await appWorker.fetch(
        new Request(`https://musixquare.com/api/pro-room/v1/rooms/${roomCode}/sessions`, {
          method: 'POST',
          headers: {
            Origin: 'https://musixquare.com',
            'Content-Type': 'application/json',
            Cookie: login.sessionCookie!,
          },
          body: JSON.stringify({ pin: '99999999', displayName: 'Peer' }),
        }),
        facadeEnv,
        {},
      );
      expect(response.status).toBe(401);
    }

    expect(upstreamFetch).toHaveBeenCalledTimes(1_001);
    expect(db.proRoomLinks.size).toBe(0);
  });

  it('logs out one session, all sessions, and permanently deletes the account', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const first = await completeLogin(env);
    vi.unstubAllGlobals();
    resetAccountAuthCachesForTests();
    const second = await completeLogin(env);
    vi.unstubAllGlobals();
    expect(db.accounts.size).toBe(1);
    expect(db.sessions.size).toBe(2);

    const logout = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/logout', {
        method: 'POST',
        headers: mutationHeaders(first.sessionCookie!),
        body: '{}',
      }),
      env,
    );
    expect(logout?.status).toBe(200);
    expect(db.sessions.size).toBe(1);
    expect(db.deletedSessions.size).toBe(0);
    expect(setCookieValues(logout!).join('\n')).toContain('__Host-mxqr_account=;');

    const logoutAll = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/logout-all', {
        method: 'POST',
        headers: mutationHeaders(second.sessionCookie!),
        body: '{}',
      }),
      env,
    );
    expect(logoutAll?.status).toBe(200);
    expect(db.sessions.size).toBe(0);
    expect(db.deletedSessions.size).toBe(0);

    resetAccountAuthCachesForTests();
    const third = await completeLogin(env);
    vi.unstubAllGlobals();
    const missingConfirmation = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/account', {
        method: 'DELETE',
        headers: mutationHeaders(third.sessionCookie!),
        body: JSON.stringify({ confirm: false }),
      }),
      env,
    );
    expect(missingConfirmation?.status).toBe(400);

    const deleted = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/account', {
        method: 'DELETE',
        headers: mutationHeaders(third.sessionCookie!),
        body: JSON.stringify({ confirm: true }),
      }),
      env,
    );
    expect(deleted?.status).toBe(200);
    expect(db.accounts.size).toBe(0);
    expect(db.sessions.size).toBe(0);
    expect(db.deletedSessions.size).toBe(1);
    expect(setCookieValues(deleted!).join('\n')).toContain('Max-Age=600');
  });

  it('turns every deleted-account browser cookie into deletion-only Standard-room proof', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const first = await completeLogin(env);
    vi.unstubAllGlobals();
    resetAccountAuthCachesForTests();
    const second = await completeLogin(env);
    vi.unstubAllGlobals();
    const deletedAccountId = [...db.accounts.keys()][0]!;

    const deleted = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/account', {
        method: 'DELETE',
        headers: mutationHeaders(first.sessionCookie!),
        body: JSON.stringify({ confirm: true }),
      }),
      env,
    );
    expect(deleted?.status).toBe(200);
    expect(db.deletedSessions.size).toBe(2);
    expect(db.accounts.has(deletedAccountId)).toBe(false);

    for (const [index, cookie] of [first.sessionCookie!, second.sessionCookie!].entries()) {
      const peerId = `deleted-device-${index + 1}`;
      const response = await handleAccountAuthRequest(
        new Request('https://musixquare.com/api/auth/room-assertion', {
          method: 'POST',
          headers: mutationHeaders(cookie),
          body: JSON.stringify({ roomCode: '123456', peerId, role: 'guest' }),
        }),
        env,
      );
      expect(response?.status).toBe(200);
      const payload = (await response!.json()) as {
        assertion: unknown;
        deletionAssertion: string | null;
      };
      expect(payload.assertion).toBeNull();
      expect(payload.deletionAssertion).toEqual(expect.any(String));
      await expect(
        verifyStandardRoomAccountDeletionAssertion(
          payload.deletionAssertion,
          STANDARD_ROOM_ASSERTION_SECRET,
          { roomCode: '123456', peerId, role: 'guest' },
        ),
      ).resolves.toMatchObject({
        roomCode: '123456',
        peerId,
        role: 'guest',
      });
      await expect(
        verifyStandardRoomAccountAssertion(
          payload.deletionAssertion,
          STANDARD_ROOM_ASSERTION_SECRET,
          {
            roomCode: '123456',
            peerId,
            role: 'guest',
          },
        ),
      ).resolves.toBeNull();
    }

    const tombstone = db.deletedSessions.values().next().value as DeletedSessionRow;
    tombstone.expires_at = Date.now() - 1;
    const expired = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/room-assertion', {
        method: 'POST',
        headers: mutationHeaders(first.sessionCookie!),
        body: JSON.stringify({
          roomCode: '123456',
          peerId: 'deleted-device-1',
          role: 'guest',
        }),
      }),
      env,
    );
    expect(expired?.status).toBe(200);
    await expect(expired!.json()).resolves.toEqual({
      assertion: null,
      deletionAssertion: null,
    });
    expect(setCookieValues(expired!).join('\n')).toContain('__Host-mxqr_account=;');
  });

  it('purges every linked PRO authority before deleting the account', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const login = await completeLogin(env);
    const accountId = [...db.accounts.keys()][0]!;
    for (const roomCode of ['000001', '000007']) {
      db.proRoomLinks.set(`${accountId}:${roomCode}`, {
        account_id: accountId,
        room_code: roomCode,
        first_linked_at: 1,
        last_seen_at: 1,
      });
    }
    vi.unstubAllGlobals();

    const request = () =>
      new Request('https://musixquare.com/api/auth/account', {
        method: 'DELETE',
        headers: mutationHeaders(login.sessionCookie!),
        body: JSON.stringify({ confirm: true }),
      });
    const missingCleanup = await handleAccountAuthRequest(request(), env);
    expect(missingCleanup?.status).toBe(503);
    expect(db.accounts.has(accountId)).toBe(true);
    expect(db.proRoomLinks.size).toBe(2);

    const purged: string[] = [];
    const deleted = await handleAccountAuthRequest(request(), env, undefined, {
      purgeProRoomAccountAuthority: async (input: { accountId: string; roomCode: string }) => {
        expect(input.accountId).toBe(accountId);
        if (purged.length === 0) {
          await expect(recordAccountProRoomLink(env, accountId, '000009')).resolves.toBe(false);
        }
        purged.push(input.roomCode);
        return true;
      },
    });
    expect(deleted?.status).toBe(200);
    expect(purged).toEqual(['000001', '000007']);
    expect(db.accounts.size).toBe(0);
    expect(db.sessions.size).toBe(0);
    expect(db.proRoomLinks.size).toBe(0);
  });

  it('fails account deletion closed when the generation reverse index is transiently unavailable', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const login = await completeLogin(env);
    const accountId = [...db.accounts.keys()][0]!;
    vi.unstubAllGlobals();
    const originalAll = db.all.bind(db);
    db.all = async (sql: string, values: unknown[]) => {
      if (normalizeSql(sql).includes('from mxqr_account_pro_room_generations')) {
        throw new Error('transient D1 timeout');
      }
      return originalAll(sql, values);
    };

    const response = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/account', {
        method: 'DELETE',
        headers: mutationHeaders(login.sessionCookie!),
        body: JSON.stringify({ confirm: true }),
      }),
      env,
      undefined,
      {
        purgeProRoomAccountAuthority: async () => true,
      },
    );

    expect(response?.status).toBe(503);
    expect(db.accounts.has(accountId)).toBe(true);
    expect(db.sessions.size).toBe(1);
    expect(db.accountDeletions.has(accountId)).toBe(false);
  });

  it('blocks new PRO authority edges for the full lifetime of a deletion fence', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    await completeLogin(env);
    const accountId = [...db.accounts.keys()][0]!;

    // A stale fence may be taken over by a later deletion attempt, but it must
    // never let an ordinary room-link request reopen the deletion boundary.
    db.accountDeletions.set(accountId, 1);
    await expect(recordAccountProRoomLink(env, accountId, '000001', Date.now())).resolves.toBe(
      false,
    );
    expect(db.proRoomLinks.size).toBe(0);
  });

  it('records a reusable PRO room incarnation as a generation-scoped reverse edge', async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            statements.push({ sql: normalizeSql(sql), values });
            return { success: true, meta: { changes: 1 } };
          },
        }),
      }),
    };
    const accountId = 'acct_0123456789abcdefghijkl';

    await expect(
      recordAccountProRoomLink(
        { MUSIXQUARE_AUTH_DB: db },
        accountId,
        '000001',
        1_784_524_800_000,
        7,
      ),
    ).resolves.toBe(true);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain('insert into mxqr_account_pro_room_generations');
    expect(statements[0]?.sql).toContain('on conflict(account_id, room_code, room_generation)');
    expect(statements[0]?.values).toEqual([accountId, '000001', 7, 1_784_524_800_000, 1_000]);
  });

  it('bounds PRO reverse edges at 1000 while allowing existing touches and deletion cleanup', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const login = await completeLogin(env);
    const accountId = [...db.accounts.keys()][0]!;
    const roomCodes = Array.from({ length: 1_000 }, (_, index) => String(index).padStart(6, '0'));
    for (const roomCode of roomCodes) {
      db.proRoomLinks.set(`${accountId}:${roomCode}`, {
        account_id: accountId,
        room_code: roomCode,
        first_linked_at: 1,
        last_seen_at: 1,
      });
    }

    await expect(recordAccountProRoomLink(env, accountId, '001000', 10)).resolves.toBe(false);
    expect(db.proRoomLinks.size).toBe(1_000);

    await expect(recordAccountProRoomLink(env, accountId, '000123', 20)).resolves.toBe(true);
    expect(db.proRoomLinks.get(`${accountId}:000123`)).toMatchObject({
      first_linked_at: 1,
      last_seen_at: 20,
    });
    expect(db.proRoomLinks.size).toBe(1_000);

    vi.unstubAllGlobals();
    const purged: string[] = [];
    const deleted = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/account', {
        method: 'DELETE',
        headers: mutationHeaders(login.sessionCookie!),
        body: JSON.stringify({ confirm: true }),
      }),
      env,
      undefined,
      {
        purgeProRoomAccountAuthority: async ({ roomCode }: { roomCode: string }) => {
          purged.push(roomCode);
          return true;
        },
      },
    );

    expect(deleted?.status).toBe(200);
    expect(purged).toEqual(roomCodes);
    expect(db.accounts.has(accountId)).toBe(false);
    expect(db.proRoomLinks.size).toBe(0);
  });

  it('does not let an older failed deletion remove a newer takeover fence', async () => {
    const db = new FakeAuthDb();
    const env = authEnv(db);
    const login = await completeLogin(env);
    const accountId = [...db.accounts.keys()][0]!;
    db.proRoomLinks.set(`${accountId}:000001`, {
      account_id: accountId,
      room_code: '000001',
      first_linked_at: 1,
      last_seen_at: 1,
    });
    vi.unstubAllGlobals();

    let takeoverFence = 0;
    const response = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/account', {
        method: 'DELETE',
        headers: mutationHeaders(login.sessionCookie!),
        body: JSON.stringify({ confirm: true }),
      }),
      env,
      undefined,
      {
        purgeProRoomAccountAuthority: async () => {
          takeoverFence = (db.accountDeletions.get(accountId) || 0) + 1;
          db.accountDeletions.set(accountId, takeoverFence);
          return false;
        },
      },
    );

    expect(response?.status).toBe(503);
    expect(db.accountDeletions.get(accountId)).toBe(takeoverFence);
    expect(db.accounts.has(accountId)).toBe(true);
  });

  it('expires sessions and OAuth states in scheduled cleanup', async () => {
    const db = new FakeAuthDb();
    db.sessions.set('expired-session', {
      session_hash: 'expired-session',
      account_id: 'acct_0000000000000000000000',
      created_at: 1,
      last_seen_at: 1,
      expires_at: 10,
    });
    db.sessions.set('current-session', {
      session_hash: 'current-session',
      account_id: 'acct_0000000000000000000000',
      created_at: 1,
      last_seen_at: 1,
      expires_at: 100,
    });
    db.flows.set('expired-flow', { state_hash: 'expired-flow', created_at: 1, expires_at: 10 });
    db.flows.set('current-flow', { state_hash: 'current-flow', created_at: 1, expires_at: 100 });
    db.deletedSessions.set('expired-deleted-session', {
      session_hash: 'expired-deleted-session',
      account_id: 'acct_0000000000000000000000',
      deleted_at: 1,
      expires_at: 10,
    });
    db.deletedSessions.set('current-deleted-session', {
      session_hash: 'current-deleted-session',
      account_id: 'acct_0000000000000000000000',
      deleted_at: 1,
      expires_at: 100,
    });
    // Cleanup intentionally needs only D1. It must continue after OAuth
    // credentials are removed during a rollback.
    await expect(cleanupExpiredAccountSessions({ MUSIXQUARE_AUTH_DB: db }, 50)).resolves.toEqual({
      configured: true,
      deleted: true,
    });
    expect([...db.sessions.keys()]).toEqual(['current-session']);
    expect([...db.flows.keys()]).toEqual(['current-flow']);
    expect([...db.deletedSessions.keys()]).toEqual(['current-deleted-session']);
  });
});

describe('account endpoint abuse bounds', () => {
  beforeEach(() => {
    // These assertions exercise fixed-window buckets. Freeze the wall clock so
    // a CPU-contended full-suite run cannot cross a minute boundary midway
    // through the sequential venue burst and make the limit appear to reset.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
  });

  it('allows a 100-device OAuth venue burst before bounding repeated starts', async () => {
    const cache = new Map<string, Response>();
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async (request: Request) => cache.get(request.url)?.clone() || undefined),
        put: vi.fn(async (request: Request, response: Response) => {
          cache.set(request.url, response.clone());
        }),
      },
    });
    const env = authEnv();
    for (let index = 0; index < 120; index += 1) {
      const response = await appWorker.fetch(
        new Request('https://musixquare.com/api/auth/google/start', {
          headers: { 'CF-Connecting-IP': '203.0.113.7' },
        }),
        env,
        {},
      );
      expect(response.status).toBe(302);
    }
    const limited = await appWorker.fetch(
      new Request('https://musixquare.com/api/auth/google/start', {
        headers: { 'CF-Connecting-IP': '203.0.113.7' },
      }),
      env,
      {},
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('600');
    await expect(limited.json()).resolves.toEqual({ error: 'AUTH_RATE_LIMITED' });
  });

  it('gives the OAuth callback the same 100-device venue burst budget', async () => {
    const cache = new Map<string, Response>();
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async (request: Request) => cache.get(request.url)?.clone() || undefined),
        put: vi.fn(async (request: Request, response: Response) => {
          cache.set(request.url, response.clone());
        }),
      },
    });
    const env = authEnv();
    const request = () =>
      new Request('https://musixquare.com/api/auth/google/callback?error=access_denied', {
        headers: { 'CF-Connecting-IP': '203.0.113.8' },
      });

    for (let index = 0; index < 120; index += 1) {
      const response = await appWorker.fetch(request(), env, {});
      expect(response.status, `callback ${index + 1}`).toBe(400);
    }
    const limited = await appWorker.fetch(request(), env, {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('600');
  });

  it('gives room assertion renewal its own 100-device venue rate bucket', async () => {
    const cache = new Map<string, Response>();
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async (request: Request) => cache.get(request.url)?.clone() || undefined),
        put: vi.fn(async (request: Request, response: Response) => {
          cache.set(request.url, response.clone());
        }),
      },
    });
    const env = authEnv();
    const request = () =>
      new Request('https://musixquare.com/api/auth/room-assertion', {
        method: 'POST',
        headers: {
          'CF-Connecting-IP': '203.0.113.100',
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          'X-MXQR-Account-CSRF': '1',
        },
        body: JSON.stringify({ roomCode: '123456', peerId: 'venue-peer', role: 'guest' }),
      });

    for (let index = 0; index < 600; index += 1) {
      const response = await appWorker.fetch(request(), env, {});
      expect(response.status, `renewal ${index + 1}`).not.toBe(429);
    }
    const limited = await appWorker.fetch(request(), env, {});
    expect(limited.status).toBe(429);

    // The high-frequency lease bucket must not consume the lower-frequency
    // profile/logout mutation budget for that same venue IP.
    const mutation = await appWorker.fetch(
      new Request('https://musixquare.com/api/auth/profile', {
        method: 'PATCH',
        headers: {
          'CF-Connecting-IP': '203.0.113.100',
          Origin: 'https://musixquare.com',
          'Content-Type': 'application/json',
          'X-MXQR-Account-CSRF': '1',
        },
        body: JSON.stringify({ nickname: 'Minsu' }),
      }),
      env,
      {},
    );
    expect(mutation.status).toBe(401);
  });
});

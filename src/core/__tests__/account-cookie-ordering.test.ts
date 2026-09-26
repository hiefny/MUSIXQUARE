import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleAccountAuthRequest,
  resetAccountAuthCachesForTests,
  resolveAccountSession,
} from '../../../cloudflare/account-auth.ts';

const ORIGIN = 'https://musixquare.com';
const CLIENT_ID = 'cookie-ordering.apps.googleusercontent.com';
const SESSION_PREFIX = '__Host-mxqr_account';
const SCHEMA = readFileSync(
  new URL('../../../cloudflare/auth.schema.sql', import.meta.url),
  'utf8',
);

class SqliteStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SQLInputValue[] = [],
    private readonly beforeRun?: (values: SQLInputValue[]) => void | Promise<void>,
  ) {}
  bind(...values: SQLInputValue[]): SqliteStatement {
    return new SqliteStatement(this.statement, values, this.beforeRun);
  }
  async first(): Promise<Record<string, unknown> | null> {
    return this.statement.get(...this.values) ?? null;
  }
  async all(): Promise<{ results: Record<string, unknown>[] }> {
    return { results: this.statement.all(...this.values) };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    await this.beforeRun?.(this.values);
    return { success: true, meta: { changes: Number(this.statement.run(...this.values).changes) } };
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(':memory:');
  beforeRun?: (sql: string, values: SQLInputValue[]) => void | Promise<void>;
  constructor() {
    this.database.exec(SCHEMA);
  }
  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database.prepare(sql), [], (values) =>
      this.beforeRun?.(sql, values),
    );
  }
  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

interface SessionPayload {
  authenticated: boolean;
  statsScope: string | null;
}
type CookieJar = Map<string, string>;
let db: SqliteD1;
let signingKeys: CryptoKeyPair;
let publicJwk: JsonWebKey;
let codes: Map<string, { nonce: string; subject: string }>;

function env(): Record<string, unknown> {
  return {
    MUSIXQUARE_AUTH_DB: db,
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: 'cookie-ordering-client-secret',
    MXQR_AUTH_SESSION_PEPPER: 'cookie-ordering-session-pepper-at-least-32-bytes',
    MXQR_AUTH_SUBJECT_PEPPER: 'cookie-ordering-subject-pepper-at-least-32-bytes',
    MXQR_OAUTH_STATE_SECRET: 'cookie-ordering-state-secret-at-least-32-bytes',
    MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET:
      'cookie-ordering-assertion-secret-at-least-32-bytes',
  };
}

function cookieHeader(jar: CookieJar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}
function applyCookies(jar: CookieJar, response: Response): void {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0]!;
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!value || /;\s*Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
}

async function route(
  path: string,
  jar: CookieJar,
  method = 'GET',
  body?: unknown,
  scope?: string,
): Promise<Response> {
  const headers = new Headers({ Cookie: cookieHeader(jar) });
  if (method !== 'GET') {
    headers.set('Origin', ORIGIN);
    headers.set('Sec-Fetch-Site', 'same-origin');
    headers.set('X-MXQR-Account-CSRF', '1');
    headers.set('Content-Type', 'application/json');
  }
  if (scope) headers.set('X-MXQR-Account-Expected-Scope', scope);
  const response = await handleAccountAuthRequest(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env(),
  );
  if (!response) throw new Error(`Missing auth route: ${path}`);
  return response;
}

async function session(jar: CookieJar): Promise<SessionPayload> {
  const response = await route('/api/auth/session', jar);
  expect(response.status).toBe(200);
  return response.json() as Promise<SessionPayload>;
}

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}
async function idToken(nonce: string, subject: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(
    JSON.stringify({ alg: 'RS256', kid: 'cookie-ordering-key', typ: 'JWT' }),
  );
  const payload = base64url(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: subject,
      email: 'cookie-ordering@example.test',
      email_verified: true,
      nonce,
      iat: now,
      exp: now + 600,
    }),
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKeys.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

async function login(
  jar: CookieJar,
  subject: string,
): Promise<{ name: string; value: string; scope: string; accountId: string }> {
  // Only the external provider is substituted. State/PKCE, AES flow cookie,
  // issuer/nonce/RS256 validation, session minting and every SQL statement run.
  const start = await route('/api/auth/google/start?returnTo=%2F', jar);
  expect(start.status).toBe(302);
  applyCookies(jar, start);
  const authorization = new URL(start.headers.get('Location')!);
  const code = `authorization-code-${codes.size + 1}`;
  codes.set(code, { nonce: authorization.searchParams.get('nonce')!, subject });
  const callback = await route(
    `/api/auth/google/callback?code=${code}&state=${authorization.searchParams.get('state')}&iss=https%3A%2F%2Faccounts.google.com`,
    jar,
  );
  expect(callback.status).toBe(303);
  expect(new URL(callback.headers.get('Location')!).searchParams.get('accountAuth')).toBe(
    'success',
  );
  const issued = callback.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(SESSION_PREFIX) && !/;\s*Max-Age=0(?:;|$)/i.test(cookie));
  expect(issued).toBeDefined();
  const pair = issued!.split(';')[0]!;
  const separator = pair.indexOf('=');
  applyCookies(jar, callback);
  const payload = await session(jar);
  expect(payload.authenticated).toBe(true);
  const resolved = await resolveAccountSession(
    new Request(`${ORIGIN}/api/auth/session`, { headers: { Cookie: cookieHeader(jar) } }),
    env(),
  );
  expect(resolved).not.toBeNull();
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    scope: payload.statsScope!,
    accountId: resolved!.accountId,
  };
}

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

beforeEach(() => {
  db = new SqliteD1();
  codes = new Map();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url === 'https://oauth2.googleapis.com/token') {
      const params = new URLSearchParams(await request.text());
      const identity = codes.get(params.get('code') ?? '');
      if (!identity) throw new Error('Unknown authorization code');
      return Response.json({ id_token: await idToken(identity.nonce, identity.subject) });
    }
    if (request.url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return Response.json({
        keys: [{ ...publicJwk, kid: 'cookie-ordering-key', alg: 'RS256', use: 'sig' }],
      });
    }
    throw new Error(`Unexpected provider request: ${request.url}`);
  });
});

afterEach(() => {
  db.database.close();
  resetAccountAuthCachesForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('session cookie response ordering with actual OAuth and tracked SQLite schema', () => {
  it.each(
    (
      ['logout', 'logout-all', 'invalid-session', 'invalid-required-session', 'delete'] as const
    ).flatMap((operation) => (['scoped', 'legacy'] as const).map((kind) => ({ operation, kind }))),
  )(
    'keeps a successor login authenticated when an older $kind $operation response arrives last',
    async ({ operation, kind }) => {
      const jar: CookieJar = new Map();
      const first = await login(jar, 'first-google-subject');
      if (kind === 'legacy') {
        jar.delete(first.name);
        jar.set(SESSION_PREFIX, first.value);
      }
      let delayed: Response;
      if (operation.startsWith('invalid-')) {
        db.database
          .prepare('DELETE FROM mxqr_account_sessions WHERE account_id = ?')
          .run(first.accountId);
        delayed = await route(
          operation === 'invalid-session' ? '/api/auth/session' : '/api/auth/stats',
          jar,
        );
        expect(delayed.status).toBe(operation === 'invalid-session' ? 200 : 401);
      } else if (operation === 'delete') {
        delayed = await route('/api/auth/account', jar, 'DELETE', { confirm: true }, first.scope);
        expect(delayed.status).toBe(200);
      } else {
        delayed = await route(`/api/auth/${operation}`, jar, 'POST', {});
        expect(delayed.status).toBe(200);
      }
      // Headers can be delayed independently of committed server work. The
      // browser applies them when that response finally arrives, after login.
      const successor = await login(jar, 'successor-google-subject');
      expect(successor.accountId).not.toBe(first.accountId);
      expect(
        db.database
          .prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions WHERE account_id = ?')
          .get(successor.accountId),
      ).toEqual({ count: 1 });
      applyCookies(jar, delayed);
      expect(jar.get(successor.name)).toBe(successor.value);
      expect(await session(jar)).toMatchObject({
        authenticated: true,
        statsScope: successor.scope,
      });
    },
  );

  it('keeps ordinary logout effective when no successor login exists', async () => {
    const jar: CookieJar = new Map();
    await login(jar, 'ordinary-logout');
    const response = await route('/api/auth/logout', jar, 'POST', {});
    expect(response.status).toBe(200);
    applyCookies(jar, response);
    expect(await session(jar)).toMatchObject({ authenticated: false });
    expect(
      db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions').get(),
    ).toEqual({ count: 0 });
  });

  it('keeps explicit replacement newer than a presented deleted login across a worker clock rollback', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const jar: CookieJar = new Map();
    const predecessor = await login(jar, 'predecessor-subject');
    const delayed = await route(
      '/api/auth/account',
      jar,
      'DELETE',
      { confirm: true },
      predecessor.scope,
    );
    expect(delayed.status).toBe(200);
    clock -= 1_000;
    const successor = await login(jar, 'successor-subject');
    applyCookies(jar, delayed);
    expect(await session(jar)).toMatchObject({ authenticated: true, statsScope: successor.scope });
  });

  it.each([0, -1_000])(
    'allows a newly selected account to save its profile immediately after a %sms clock change',
    async (clockDelta) => {
      let clock = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const jar: CookieJar = new Map();
      await login(jar, 'previous-account');
      clock += clockDelta;
      const successor = await login(jar, 'new-account');
      const response = await route(
        '/api/auth/profile',
        jar,
        'PATCH',
        { nickname: 'FreshAccount' },
        successor.scope,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        account: { nickname: 'FreshAccount', profileComplete: true },
      });
      expect(
        db.database
          .prepare('SELECT nickname, profile_complete FROM mxqr_accounts WHERE account_id = ?')
          .get(successor.accountId),
      ).toEqual({ nickname: 'FreshAccount', profile_complete: 1 });
    },
  );

  it('does not use a future cookie ordering timestamp to sweep another device deletion proof early', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const requestedAt = clock;
    // A browser can present a session issued by a worker whose clock was ahead.
    // The replacement must outrank it without advancing unrelated expiry work.
    clock += 601_000;
    const replacementJar: CookieJar = new Map();
    await login(replacementJar, 'future-issued-account');
    clock = requestedAt;
    const deletedJar: CookieJar = new Map();
    const deleted = await login(deletedJar, 'separate-deleted-account');
    const deletion = await route(
      '/api/auth/account',
      deletedJar,
      'DELETE',
      { confirm: true },
      deleted.scope,
    );
    expect(deletion.status).toBe(200);
    applyCookies(deletedJar, deletion);
    await login(replacementJar, 'newly-selected-account');
    expect(
      db.database
        .prepare('SELECT COUNT(*) AS count FROM mxqr_account_deleted_sessions WHERE expires_at > ?')
        .get(clock),
    ).toEqual({ count: 1 });
    const proof = await route('/api/auth/room-assertion', deletedJar, 'POST', {
      roomCode: '123456',
      peerId: 'deletion-proof-peer',
      role: 'guest',
    });
    expect(await proof.json()).toMatchObject({
      assertion: null,
      deletionAssertion: expect.any(String),
    });
  });

  it('keeps a valid legacy session readable without silently replacing its cookie', async () => {
    const current: CookieJar = new Map();
    const loggedIn = await login(current, 'legacy-google-subject');
    const legacy: CookieJar = new Map([[SESSION_PREFIX, loggedIn.value]]);
    const response = await route('/api/auth/session', legacy);
    expect(await response.json()).toMatchObject({
      authenticated: true,
      statsScope: loggedIn.scope,
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('issues distinct scoped cookies and revokes the browser-presented predecessor on login', async () => {
    const jar: CookieJar = new Map();
    const first = await login(jar, 'first-google-subject');
    const second = await login(jar, 'second-google-subject');
    expect(first.name).toMatch(/^__Host-mxqr_account_/);
    expect(second.name).toMatch(/^__Host-mxqr_account_/);
    expect(second.name).not.toBe(first.name);
    expect(jar.has(first.name)).toBe(false);
    expect(
      db.database
        .prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions WHERE account_id = ?')
        .get(first.accountId),
    ).toEqual({ count: 0 });
    expect(await session(new Map([[first.name, first.value]]))).toMatchObject({
      authenticated: false,
    });
    expect(await session(jar)).toMatchObject({ authenticated: true, statsScope: second.scope });
  });

  it.each([false, true])(
    'selects the newest live cookie independent of header order (reverse=%s)',
    async (reverse) => {
      let clock = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const olderJar: CookieJar = new Map();
      const older = await login(olderJar, 'older-subject');
      clock += 1_000;
      const newerJar: CookieJar = new Map();
      const newer = await login(newerJar, 'newer-subject');
      const entries = [
        [older.name, older.value],
        [newer.name, newer.value],
      ] as [string, string][];
      const jar: CookieJar = new Map(reverse ? entries.reverse() : entries);
      const response = await route('/api/auth/session', jar);
      expect(await response.json()).toMatchObject({ authenticated: true, statsScope: newer.scope });
      applyCookies(jar, response);
      expect(jar.has(older.name)).toBe(false);
      expect(jar.get(newer.name)).toBe(newer.value);
      expect(
        db.database
          .prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions WHERE account_id = ?')
          .get(older.accountId),
      ).toEqual({ count: 0 });
    },
  );

  it.each([false, true])(
    'does not fall back to an older live cookie after the newest was revoked (reverse=%s)',
    async (reverse) => {
      let clock = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const olderJar: CookieJar = new Map();
      const older = await login(olderJar, 'older-subject');
      clock += 1_000;
      const newerJar: CookieJar = new Map();
      const newer = await login(newerJar, 'newer-subject');
      expect((await route('/api/auth/logout', newerJar, 'POST', {})).status).toBe(200);
      const entries = [
        [older.name, older.value],
        [newer.name, newer.value],
      ] as [string, string][];
      const response = await route(
        '/api/auth/session',
        new Map(reverse ? entries.reverse() : entries),
      );
      expect(await response.json()).toMatchObject({ authenticated: false });
      expect(
        db.database
          .prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions WHERE account_id = ?')
          .get(older.accountId),
      ).toEqual({ count: 0 });
    },
  );

  it('keeps the deletion-only room proof until a valid newer scoped login supersedes it', async () => {
    const deletedJar: CookieJar = new Map();
    const first = await login(deletedJar, 'delete-subject');
    const response = await route(
      '/api/auth/account',
      deletedJar,
      'DELETE',
      { confirm: true },
      first.scope,
    );
    applyCookies(deletedJar, response);
    expect(await session(deletedJar)).toMatchObject({ authenticated: false });
    const deletedProof = await route('/api/auth/room-assertion', deletedJar, 'POST', {
      roomCode: '123456',
      peerId: 'cookie-proof-peer',
      role: 'guest',
    });
    expect(await deletedProof.json()).toMatchObject({
      assertion: null,
      deletionAssertion: expect.any(String),
    });
    const newer = await login(deletedJar, 'newer-subject');
    expect(await session(deletedJar)).toMatchObject({
      authenticated: true,
      statsScope: newer.scope,
    });
  });

  it('rejects a scoped name paired with a different valid token without authenticating that token', async () => {
    const first = await login(new Map(), 'first-subject');
    const second = await login(new Map(), 'second-subject');
    const forged = new Map([[first.name, second.value]]);
    expect(await session(forged)).toMatchObject({ authenticated: false });
    expect(await session(new Map([[second.name, second.value]]))).toMatchObject({
      authenticated: true,
      statsScope: second.scope,
    });
  });

  it('fails closed when the account-cookie candidate limit is exceeded', async () => {
    const entries: [string, string][] = [];
    for (let index = 0; index < 17; index++) {
      const issued = await login(new Map(), `subject-${index}`);
      entries.push([issued.name, issued.value]);
    }
    const response = await route('/api/auth/session', new Map(entries));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'AUTH_TEMPORARILY_UNAVAILABLE' });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('fails closed when an otherwise valid Cookie header exceeds 16 KiB', async () => {
    const jar: CookieJar = new Map();
    await login(jar, 'header-budget-subject');
    jar.set('unrelated-padding', 'x'.repeat(16 * 1024));
    const response = await route('/api/auth/session', jar);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'AUTH_TEMPORARILY_UNAVAILABLE' });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each(['scoped', 'legacy'] as const)(
    'does not erase a revoked newest cookie when retiring its %s predecessor fails',
    async (kind) => {
      let clock = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const older = await login(new Map(), 'old-subject');
      clock += 1_000;
      const newerJar: CookieJar = new Map();
      const newer = await login(newerJar, 'new-subject');
      await route('/api/auth/logout', newerJar, 'POST', {});
      const oldName = kind === 'legacy' ? SESSION_PREFIX : older.name;
      const jar = new Map([
        [oldName, older.value],
        [newer.name, newer.value],
      ]);
      const oldHash = db.database
        .prepare('SELECT session_hash FROM mxqr_account_sessions WHERE account_id = ?')
        .get(older.accountId)!.session_hash;
      db.beforeRun = (sql, values) => {
        if (sql.includes('DELETE FROM mxqr_account_sessions') && values[0] === oldHash)
          throw new Error('injected predecessor retirement failure');
      };
      const failed = await route('/api/auth/session', jar);
      expect(failed.status).toBe(503);
      expect(failed.headers.getSetCookie()).toEqual([]);
      applyCookies(jar, failed);
      expect(jar.get(newer.name)).toBe(newer.value);
      expect(
        db.database
          .prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions WHERE account_id = ?')
          .get(older.accountId),
      ).toEqual({ count: 1 });
      db.beforeRun = undefined;
      const settled = await route('/api/auth/session', jar);
      expect(await settled.json()).toMatchObject({ authenticated: false });
      applyCookies(jar, settled);
      expect(jar.has(newer.name)).toBe(false);
      expect(jar.has(oldName)).toBe(false);
      expect(
        db.database
          .prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions WHERE account_id = ?')
          .get(older.accountId),
      ).toEqual({ count: 0 });
    },
  );

  it('keeps another device session while replacing only the login browser predecessor', async () => {
    const anotherDevice: CookieJar = new Map();
    const remote = await login(anotherDevice, 'same-subject');
    const browserJar: CookieJar = new Map();
    await login(browserJar, 'same-subject');
    const successor = await login(browserJar, 'same-subject');
    expect(await session(anotherDevice)).toMatchObject({
      authenticated: true,
      statsScope: remote.scope,
    });
    expect(await session(browserJar)).toMatchObject({
      authenticated: true,
      statsScope: successor.scope,
    });
    expect(
      db.database
        .prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions WHERE account_id = ?')
        .get(remote.accountId),
    ).toEqual({ count: 2 });
  });

  it('retires the replaced browser slot before enforcing the 128-session cap', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const oldestDevice: CookieJar = new Map();
    const oldest = await login(oldestDevice, 'shared-account');
    // Every row is a separately issued OAuth session, including the oldest
    // unrelated device that would otherwise be evicted by a premature trim.
    for (let index = 0; index < 126; index++) {
      clock += 1_000;
      await login(new Map(), 'shared-account');
    }
    clock += 1_000;
    const browserJar: CookieJar = new Map();
    const predecessor = await login(browserJar, 'shared-account');
    expect(
      db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions').get(),
    ).toEqual({ count: 128 });
    clock += 1_000;
    const replacement = await login(browserJar, 'shared-account');
    expect(await session(oldestDevice)).toMatchObject({
      authenticated: true,
      statsScope: oldest.scope,
    });
    expect(await session(new Map([[predecessor.name, predecessor.value]]))).toMatchObject({
      authenticated: false,
    });
    expect(await session(browserJar)).toMatchObject({
      authenticated: true,
      statsScope: replacement.scope,
    });
    expect(
      db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions').get(),
    ).toEqual({ count: 128 });
  });
});

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleAccountAuthRequest,
  resetAccountAuthCachesForTests,
} from '../../../cloudflare/account-auth.js';

const ORIGIN = 'https://musixquare.com';
const SESSION_PEPPER = 'sqlite-session-pepper-for-tests-at-least-32-bytes';
const ACCOUNT_ID = `acct_${'A'.repeat(22)}`;
const SCHEMA = readFileSync(
  new URL('../../../cloudflare/auth.schema.sql', import.meta.url),
  'utf8',
);
const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    // The application supports Node 20, while node:sqlite starts in Node 22.
    // Keep the schema integration test available where the runtime provides it
    // without making the ordinary test suite fail on the supported older LTS.
    return null;
  }
})();

type SqlValue = string | number | bigint | Uint8Array | null;

class SqliteD1Statement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: readonly SqlValue[] = [],
  ) {}

  bind(...values: SqlValue[]): SqliteD1Statement {
    return new SqliteD1Statement(this.statement, values);
  }

  async first(): Promise<Record<string, unknown> | null> {
    return (this.statement.get(...this.values) as Record<string, unknown> | undefined) ?? null;
  }

  async all(): Promise<{ results: Record<string, unknown>[] }> {
    return { results: this.statement.all(...this.values) as Record<string, unknown>[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  readonly database: DatabaseSync;

  constructor() {
    if (!sqlite) throw new Error('node:sqlite is unavailable');
    this.database = new sqlite.DatabaseSync(':memory:');
    this.database.exec(SCHEMA);
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database.prepare(sql));
  }

  async batch(statements: SqliteD1Statement[]): Promise<unknown[]> {
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

  close(): void {
    this.database.close();
  }
}

async function sessionHash(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SESSION_PEPPER),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payload = new TextEncoder().encode(`account-session:v1\u0000${token}`);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function authEnv(db: SqliteD1): Record<string, unknown> {
  return {
    MUSIXQUARE_AUTH_DB: db,
    GOOGLE_OAUTH_CLIENT_ID: 'sqlite-test.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'sqlite-test-client-secret',
    MXQR_AUTH_SESSION_PEPPER: SESSION_PEPPER,
    MXQR_AUTH_SUBJECT_PEPPER: 'sqlite-subject-pepper-for-tests-at-least-32-bytes',
    MXQR_OAUTH_STATE_SECRET: 'sqlite-state-secret-for-tests-at-least-32-bytes',
    MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET:
      'sqlite-standard-room-secret-for-tests-at-least-32-bytes',
  };
}

function request(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Request {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  if (options.token) headers.set('Cookie', `__Host-mxqr_account=${options.token}`);
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('Content-Type', 'application/json');
    headers.set('Origin', ORIGIN);
    headers.set('Sec-Fetch-Site', 'same-origin');
    headers.set('X-MXQR-Account-CSRF', '1');
  }
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function seedAccount(db: SqliteD1, tokens: readonly string[]): Promise<void> {
  const now = Date.now() - 5_000;
  db.database
    .prepare(
      `INSERT INTO mxqr_accounts
         (account_id, google_subject_hash, nickname, profile_complete, status, created_at, updated_at)
       VALUES (?, ?, NULL, 0, 'active', ?, ?)`,
    )
    .run(ACCOUNT_ID, 'S'.repeat(43), now, now);
  for (const token of tokens) {
    db.database
      .prepare(
        `INSERT INTO mxqr_account_sessions
           (session_hash, account_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(await sessionHash(token), ACCOUNT_ID, now, now, now + 86_400_000);
  }
}

afterEach(() => {
  resetAccountAuthCachesForTests();
});

(sqlite ? describe : describe.skip)('account auth against the tracked SQLite/D1 schema', () => {
  it('shares one nickname across device sessions and preserves single-device logout semantics', async () => {
    const db = new SqliteD1();
    const firstToken = 'a'.repeat(43);
    const secondToken = 'b'.repeat(43);
    try {
      await seedAccount(db, [firstToken, secondToken]);
      const env = authEnv(db);

      const before = await handleAccountAuthRequest(
        request('/api/auth/session', { token: firstToken }),
        env,
      );
      expect(before.status).toBe(200);
      expect(await before.json()).toMatchObject({
        configured: true,
        authenticated: true,
        account: { nickname: '', profileComplete: false },
      });

      const profile = await handleAccountAuthRequest(
        request('/api/auth/profile', {
          method: 'PATCH',
          token: firstToken,
          body: { nickname: '  Minsu  ' },
        }),
        env,
      );
      expect(profile.status).toBe(200);
      expect(await profile.json()).toMatchObject({
        account: { nickname: 'Minsu', profileComplete: true },
      });

      const otherDevice = await handleAccountAuthRequest(
        request('/api/auth/session', { token: secondToken }),
        env,
      );
      expect(await otherDevice.json()).toMatchObject({
        authenticated: true,
        account: { nickname: 'Minsu', profileComplete: true },
      });

      const logout = await handleAccountAuthRequest(
        request('/api/auth/logout', { method: 'POST', token: firstToken, body: {} }),
        env,
      );
      expect(logout.status).toBe(200);

      const firstAfter = await handleAccountAuthRequest(
        request('/api/auth/session', { token: firstToken }),
        env,
      );
      const secondAfter = await handleAccountAuthRequest(
        request('/api/auth/session', { token: secondToken }),
        env,
      );
      expect(await firstAfter.json()).toMatchObject({ authenticated: false });
      expect(await secondAfter.json()).toMatchObject({ authenticated: true });
    } finally {
      db.close();
    }
  });

  it('executes the real deletion SQL atomically and lets foreign keys remove all sessions', async () => {
    const db = new SqliteD1();
    const firstToken = 'c'.repeat(43);
    const secondToken = 'd'.repeat(43);
    try {
      await seedAccount(db, [firstToken, secondToken]);
      const response = await handleAccountAuthRequest(
        request('/api/auth/account', {
          method: 'DELETE',
          token: firstToken,
          body: { confirm: true },
        }),
        authEnv(db),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(
        db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_accounts').get(),
      ).toMatchObject({
        count: 0,
      });
      expect(
        db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions').get(),
      ).toMatchObject({ count: 0 });
      expect(
        db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_account_deleted_sessions').get(),
      ).toMatchObject({ count: 2 });
      expect(response.headers.get('Set-Cookie')).toContain('Max-Age=600');

      const otherDeviceProof = await handleAccountAuthRequest(
        request('/api/auth/room-assertion', {
          method: 'POST',
          token: secondToken,
          body: { roomCode: '123456', peerId: 'other-device', role: 'guest' },
        }),
        authEnv(db),
      );
      expect(await otherDeviceProof.json()).toMatchObject({
        assertion: null,
        deletionAssertion: expect.any(String),
      });
    } finally {
      db.close();
    }
  });

  it('enforces tracked schema constraints instead of relying on the in-memory fake', () => {
    const db = new SqliteD1();
    try {
      expect(() =>
        db.database
          .prepare(
            `INSERT INTO mxqr_accounts
               (account_id, google_subject_hash, nickname, profile_complete, status, created_at, updated_at)
             VALUES (?, ?, ?, 0, 'active', 1, 1)`,
          )
          .run(ACCOUNT_ID, 'S'.repeat(43), 'nickname-with-incomplete-profile'),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

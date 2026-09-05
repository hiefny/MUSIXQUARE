import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupPendingAccountDeletions,
  handleAccountAuthRequest as handleMaybeAccountAuthRequest,
  recordAccountProRoomLink,
  resetAccountAuthCachesForTests,
} from '../../../cloudflare/account-auth.ts';
import { normalizeSchemaSql } from '../../../scripts/sql-schema-normalization.mts';

const ORIGIN = 'https://musixquare.com';
const SESSION_PEPPER = 'sqlite-session-pepper-for-tests-at-least-32-bytes';
const ACCOUNT_ID = `acct_${'A'.repeat(22)}`;
const SCHEMA = readFileSync(
  new URL('../../../cloudflare/auth.schema.sql', import.meta.url),
  'utf8',
);
const NICKNAME_KEY_MIGRATION = readFileSync(
  new URL('../../../cloudflare/auth.nickname-key.migration.sql', import.meta.url),
  'utf8',
);
const ACCOUNT_STATS_MIGRATION = readFileSync(
  new URL('../../../cloudflare/auth.account-stats.migration.sql', import.meta.url),
  'utf8',
);

async function handleAccountAuthRequest(request: Request, env: unknown): Promise<Response> {
  const response = await handleMaybeAccountAuthRequest(request, env);
  if (!response) throw new Error(`Expected account auth route: ${new URL(request.url).pathname}`);
  return response;
}

function schemaBeforeNicknameKeyMigration(): string {
  const columnStart = SCHEMA.indexOf('  -- Appended by the global-nickname migration.');
  const followingConstraint = SCHEMA.indexOf('  CHECK (length(account_id)', columnStart);
  if (columnStart < 0 || followingConstraint < 0) {
    throw new Error('Unable to derive the pre-nickname-key account schema fixture.');
  }
  const withoutColumn = `${SCHEMA.slice(0, columnStart)}${SCHEMA.slice(followingConstraint)}`;
  const withoutIndex = withoutColumn.replace(
    /\nCREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_accounts_nickname_key[\s\S]*?WHERE nickname_key IS NOT NULL;\n/u,
    '\n',
  );
  if (withoutIndex.includes('nickname_key')) {
    throw new Error('Pre-migration account schema fixture still contains nickname_key.');
  }
  return withoutIndex;
}

function schemaBeforeAccountStatsMigration(): string {
  const tableStart = SCHEMA.indexOf('-- Account-scoped lifetime aggregates.');
  const nextTable = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS mxqr_account_sessions', tableStart);
  if (tableStart < 0 || nextTable < 0) {
    throw new Error('Unable to derive the pre-account-stats schema fixture.');
  }
  return `${SCHEMA.slice(0, tableStart)}${SCHEMA.slice(nextTable)}`;
}
const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    // Keep the schema integration test's skip reason explicit if package
    // engine enforcement is bypassed with an unsupported runtime.
    return null;
  }
})();

type SqlValue = string | number | bigint | Uint8Array | null;

class SqliteD1Statement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: readonly SqlValue[] = [],
    private readonly beforeRun?: (values: readonly SqlValue[]) => Promise<void>,
  ) {}

  bind(...values: SqlValue[]): SqliteD1Statement {
    return new SqliteD1Statement(this.statement, values, this.beforeRun);
  }

  async first(): Promise<Record<string, unknown> | null> {
    return (this.statement.get(...this.values) as Record<string, unknown> | undefined) ?? null;
  }

  async all(): Promise<{ results: Record<string, unknown>[] }> {
    return { results: this.statement.all(...this.values) as Record<string, unknown>[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    await this.beforeRun?.(this.values);
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  readonly database: DatabaseSync;
  beforeRun?: (sql: string, values: readonly SqlValue[]) => Promise<void>;

  constructor() {
    if (!sqlite) throw new Error('node:sqlite is unavailable');
    this.database = new sqlite.DatabaseSync(':memory:');
    this.database.exec(SCHEMA);
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(
      this.database.prepare(sql),
      [],
      (values) => this.beforeRun?.(sql, values) ?? Promise.resolve(),
    );
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

type CreateAccountSession = (
  config: Record<string, unknown>,
  subject: string,
  nowMs: number,
) => Promise<{ token: string; account: { nickname: string; profileComplete: boolean } }>;
let accountSessionCreator: Promise<CreateAccountSession> | undefined;

function loadAccountSessionCreator(): Promise<CreateAccountSession> {
  // Exercise the actual private OAuth session boundary, including its SQL and
  // HMAC awaits, without substituting either with a copy in the test.
  accountSessionCreator ??= (async () => {
    const sourceUrl = new URL('../../../cloudflare/account-auth.ts', import.meta.url);
    const result = await build({
      stdin: {
        contents: `${readFileSync(sourceUrl, 'utf8')}\nexport { createAccountSession };\n`,
        resolveDir: fileURLToPath(new URL('.', sourceUrl)),
        sourcefile: 'account-auth-session-fixture.ts',
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
      write: false,
    });
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(`${result.outputFiles[0]!.text}\n//# sourceURL=account-auth-session-fixture.js`).toString('base64')}`
    )) as { createAccountSession: CreateAccountSession };
    return module.createAccountSession;
  })();
  return accountSessionCreator;
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
  options: {
    method?: string;
    token?: string;
    statsScope?: string;
    expectedScope?: string;
    body?: unknown;
  } = {},
): Request {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  if (options.token) headers.set('Cookie', `__Host-mxqr_account=${options.token}`);
  if (options.statsScope) {
    headers.set('X-MXQR-Account-Stats-Scope', options.statsScope);
  }
  if (options.expectedScope) {
    headers.set('X-MXQR-Account-Expected-Scope', options.expectedScope);
  }
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

async function statsScopeFor(db: SqliteD1, token: string): Promise<string> {
  const response = await handleAccountAuthRequest(
    request('/api/auth/session', { token }),
    authEnv(db),
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { statsScope?: unknown };
  expect(payload.statsScope).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return payload.statsScope as string;
}

async function seedAccount(
  db: SqliteD1,
  tokens: readonly string[],
  options: { accountId?: string; subjectHash?: string } = {},
): Promise<void> {
  const now = Date.now() - 5_000;
  const accountId = options.accountId ?? ACCOUNT_ID;
  const subjectHash = options.subjectHash ?? 'S'.repeat(43);
  db.database
    .prepare(
      `INSERT INTO mxqr_accounts
         (account_id, google_subject_hash, nickname, profile_complete, status, created_at, updated_at)
       VALUES (?, ?, NULL, 0, 'active', ?, ?)`,
    )
    .run(accountId, subjectHash, now, now);
  for (const token of tokens) {
    db.database
      .prepare(
        `INSERT INTO mxqr_account_sessions
           (session_hash, account_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(await sessionHash(token), accountId, now, now, now + 86_400_000);
  }
}

afterEach(() => {
  vi.useRealTimers();
  resetAccountAuthCachesForTests();
});

(sqlite ? describe : describe.skip)('account auth against the tracked SQLite/D1 schema', () => {
  it.each([false, true])(
    'keeps both reordered OAuth sessions valid and account time monotonic (existing account: %s)',
    async (existingAccount) => {
      const db = new SqliteD1();
      try {
        const createSession = await loadAccountSessionCreator();
        const config = {
          configured: true,
          db,
          sessionPepper: SESSION_PEPPER,
          subjectPepper: authEnv(db).MXQR_AUTH_SUBJECT_PEPPER,
        };
        const subject = 'same-google-account';
        const earlier = Date.now();
        const later = earlier + 1;
        if (existingAccount) await createSession(config, subject, earlier - 1_000);

        let arrived!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        db.beforeRun = async (sql, values) => {
          if (sql.startsWith('INSERT INTO mxqr_accounts') && values[2] === earlier) {
            arrived();
            await gate;
          }
        };
        const first = createSession(config, subject, earlier);
        await waiting;
        const second = await createSession(config, subject, later);
        release();
        const firstSession = await first;
        expect(firstSession.account).toEqual(second.account);
        expect(db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_accounts').get()).toEqual({
          count: 1,
        });
        expect(
          db.database
            .prepare('SELECT COUNT(DISTINCT account_id) AS count FROM mxqr_account_sessions')
            .get(),
        ).toEqual({ count: 1 });
        expect(
          db.database.prepare('SELECT created_at, updated_at FROM mxqr_accounts').get(),
        ).toEqual({ created_at: existingAccount ? earlier - 1_000 : later, updated_at: later });
        expect(
          db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_account_sessions').get(),
        ).toEqual({ count: existingAccount ? 3 : 2 });
        for (const session of [firstSession, second]) {
          const response = await handleAccountAuthRequest(
            request('/api/auth/session', { token: session.token }),
            authEnv(db),
          );
          expect(await response.json()).toMatchObject({
            authenticated: true,
            account: second.account,
          });
        }
      } finally {
        db.close();
      }
    },
  );

  it('applies the tracked nickname migration to the previous schema and matches canonical SQL', () => {
    if (!sqlite) throw new Error('node:sqlite is unavailable');
    const migrated = new sqlite.DatabaseSync(':memory:');
    const canonical = new sqlite.DatabaseSync(':memory:');
    try {
      migrated.exec(schemaBeforeNicknameKeyMigration());
      migrated
        .prepare(
          `INSERT INTO mxqr_accounts
             (account_id, google_subject_hash, nickname, profile_complete, status, created_at, updated_at)
           VALUES (?, ?, 'MUSIXQUARE', 1, 'active', 1, 1)`,
        )
        .run(ACCOUNT_ID, 'S'.repeat(43));
      migrated.exec(NICKNAME_KEY_MIGRATION);
      canonical.exec(SCHEMA);

      expect(
        migrated
          .prepare('SELECT nickname_key FROM mxqr_accounts WHERE account_id = ?')
          .get(ACCOUNT_ID),
      ).toMatchObject({ nickname_key: 'musixquare' });

      for (const objectName of ['mxqr_accounts', 'idx_mxqr_accounts_nickname_key']) {
        const migratedSql = migrated
          .prepare('SELECT sql FROM sqlite_master WHERE name = ?')
          .get(objectName)?.sql;
        const canonicalSql = canonical
          .prepare('SELECT sql FROM sqlite_master WHERE name = ?')
          .get(objectName)?.sql;
        if (typeof migratedSql !== 'string' || typeof canonicalSql !== 'string') {
          throw new Error(`Expected SQLite schema SQL for ${objectName}`);
        }
        expect(normalizeSchemaSql(migratedSql), objectName).toBe(normalizeSchemaSql(canonicalSql));
      }
    } finally {
      migrated.close();
      canonical.close();
    }
  });

  it('applies the aggregate-only account-stats migration and matches canonical SQL', () => {
    if (!sqlite) throw new Error('node:sqlite is unavailable');
    const migrated = new sqlite.DatabaseSync(':memory:');
    const canonical = new sqlite.DatabaseSync(':memory:');
    try {
      migrated.exec(schemaBeforeAccountStatsMigration());
      migrated.exec(ACCOUNT_STATS_MIGRATION);
      canonical.exec(SCHEMA);

      const migratedSql = migrated
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'mxqr_account_stats'")
        .get()?.sql;
      const canonicalSql = canonical
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'mxqr_account_stats'")
        .get()?.sql;
      if (typeof migratedSql !== 'string' || typeof canonicalSql !== 'string') {
        throw new Error('Expected SQLite schema SQL for mxqr_account_stats');
      }
      expect(normalizeSchemaSql(migratedSql)).toBe(normalizeSchemaSql(canonicalSql));
    } finally {
      migrated.close();
      canonical.close();
    }
  });

  it('atomically accumulates only the three account-stat counters', async () => {
    const db = new SqliteD1();
    const token = 'z'.repeat(43);
    try {
      await seedAccount(db, [token]);
      const statsScope = await statsScopeFor(db, token);
      const initial = await handleAccountAuthRequest(
        request('/api/auth/stats', { token }),
        authEnv(db),
      );
      await expect(initial.json()).resolves.toEqual({
        stats: { sessionCount: 0, listeningSeconds: 0, trackCount: 0 },
      });

      const updated = await handleAccountAuthRequest(
        request('/api/auth/stats', {
          method: 'PATCH',
          token,
          statsScope,
          body: {
            sessionCountDelta: 2,
            listeningSecondsDelta: 360,
            trackCountDelta: 7,
          },
        }),
        authEnv(db),
      );
      expect(updated.status).toBe(200);
      await expect(updated.json()).resolves.toEqual({
        stats: { sessionCount: 2, listeningSeconds: 360, trackCount: 7 },
      });
      expect(
        db.database
          .prepare(
            'SELECT account_id, session_count, listening_seconds, track_count FROM mxqr_account_stats',
          )
          .get(),
      ).toEqual({
        account_id: ACCOUNT_ID,
        session_count: 2,
        listening_seconds: 360,
        track_count: 7,
      });
    } finally {
      db.close();
    }
  });

  it('rejects a mismatched stats scope before the SQLite aggregate write', async () => {
    const db = new SqliteD1();
    const firstToken = 'x'.repeat(43);
    const secondToken = 'y'.repeat(43);
    const secondAccountId = `acct_${'B'.repeat(22)}`;
    try {
      await seedAccount(db, [firstToken]);
      await seedAccount(db, [secondToken], {
        accountId: secondAccountId,
        subjectHash: 'T'.repeat(43),
      });
      const firstScope = await statsScopeFor(db, firstToken);
      const secondScope = await statsScopeFor(db, secondToken);

      const stale = await handleAccountAuthRequest(
        request('/api/auth/stats', {
          method: 'PATCH',
          token: secondToken,
          statsScope: firstScope,
          body: {
            sessionCountDelta: 1,
            listeningSecondsDelta: 60,
            trackCountDelta: 2,
          },
        }),
        authEnv(db),
      );
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toEqual({ error: 'ACCOUNT_STATS_SCOPE_MISMATCH' });
      expect(db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_account_stats').get()).toEqual(
        { count: 0 },
      );

      const accepted = await handleAccountAuthRequest(
        request('/api/auth/stats', {
          method: 'PATCH',
          token: secondToken,
          statsScope: secondScope,
          body: {
            sessionCountDelta: 1,
            listeningSecondsDelta: 60,
            trackCountDelta: 2,
          },
        }),
        authEnv(db),
      );
      expect(accepted.status).toBe(200);
      expect(
        db.database
          .prepare(
            'SELECT account_id, session_count, listening_seconds, track_count FROM mxqr_account_stats',
          )
          .get(),
      ).toEqual({
        account_id: secondAccountId,
        session_count: 1,
        listening_seconds: 60,
        track_count: 2,
      });
    } finally {
      db.close();
    }
  });

  it.each(['matching', 'foreign', 'absent', 'malformed'] as const)(
    'fences a stats GET with a %s captured scope against the request cookie',
    async (scopeKind) => {
      const db = new SqliteD1();
      try {
        const firstToken = 'x'.repeat(43);
        const secondToken = 'y'.repeat(43);
        const secondAccountId = `acct_${'B'.repeat(22)}`;
        await seedAccount(db, [firstToken]);
        await seedAccount(db, [secondToken], {
          accountId: secondAccountId,
          subjectHash: 'T'.repeat(43),
        });
        db.database
          .prepare(
            `INSERT INTO mxqr_account_stats
          (account_id, session_count, listening_seconds, track_count) VALUES (?, 7, 80, 9)`,
          )
          .run(secondAccountId);
        const statsScope =
          scopeKind === 'absent'
            ? undefined
            : scopeKind === 'malformed'
              ? 'invalid-scope'
              : await statsScopeFor(db, scopeKind === 'foreign' ? firstToken : secondToken);
        const response = await handleAccountAuthRequest(
          request('/api/auth/stats', { token: secondToken, statsScope }),
          authEnv(db),
        );
        if (scopeKind === 'foreign' || scopeKind === 'malformed') {
          expect(response.status).toBe(scopeKind === 'foreign' ? 409 : 400);
          expect(await response.json()).toEqual({
            error: scopeKind === 'foreign' ? 'ACCOUNT_STATS_SCOPE_MISMATCH' : 'INVALID_REQUEST',
          });
        } else {
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            stats: { sessionCount: 7, listeningSeconds: 80, trackCount: 9 },
          });
        }
      } finally {
        db.close();
      }
    },
  );

  it.each([false, true])(
    'keeps reordered PRO link writes valid and monotonic (existing edge: %s)',
    async (existingEdge) => {
      const db = new SqliteD1();
      try {
        await seedAccount(db, []);
        const env = authEnv(db);
        const earlier = Date.now();
        const later = earlier + 1;
        if (existingEdge) {
          expect(
            await recordAccountProRoomLink(env, ACCOUNT_ID, '012345', earlier - 1_000, 1),
          ).toBe(true);
        }
        let arrived!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        db.beforeRun = async (sql, values) => {
          if (
            sql.startsWith('INSERT INTO mxqr_account_pro_room_generations') &&
            values[3] === earlier
          ) {
            arrived();
            await gate;
          }
        };
        const first = recordAccountProRoomLink(env, ACCOUNT_ID, '012345', earlier, 1);
        await waiting;
        expect(await recordAccountProRoomLink(env, ACCOUNT_ID, '012345', later, 1)).toBe(true);
        release();
        expect(await first).toBe(true);
        expect(
          db.database
            .prepare(
              `SELECT account_id, room_code, room_generation,
          first_linked_at, last_seen_at FROM mxqr_account_pro_room_generations`,
            )
            .all(),
        ).toEqual([
          {
            account_id: ACCOUNT_ID,
            room_code: '012345',
            room_generation: 1,
            first_linked_at: existingEdge ? earlier - 1_000 : later,
            last_seen_at: later,
          },
        ]);
      } finally {
        db.close();
      }
    },
  );

  it('enforces one 1000-edge cap across generation-scoped PRO links', async () => {
    const db = new SqliteD1();
    try {
      await seedAccount(db, []);
      const insertGeneration = db.database.prepare(
        `INSERT INTO mxqr_account_pro_room_generations
           (account_id, room_code, room_generation, first_linked_at, last_seen_at)
         VALUES (?, ?, ?, 1, 1)`,
      );
      for (let index = 0; index < 500; index += 1) {
        insertGeneration.run(ACCOUNT_ID, String(index).padStart(6, '0'), 0);
      }
      for (let index = 500; index < 1_000; index += 1) {
        insertGeneration.run(ACCOUNT_ID, String(index).padStart(6, '0'), 1);
      }

      const env = authEnv(db);
      await expect(recordAccountProRoomLink(env, ACCOUNT_ID, '001000', 10, 0)).resolves.toBe(false);
      await expect(recordAccountProRoomLink(env, ACCOUNT_ID, '000123', 20, 0)).resolves.toBe(true);
      await expect(recordAccountProRoomLink(env, ACCOUNT_ID, '000500', 20, 1)).resolves.toBe(true);

      const total = db.database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM mxqr_account_pro_room_generations
            WHERE account_id = ?`,
        )
        .get(ACCOUNT_ID);
      expect(Number(total?.count)).toBe(1_000);
    } finally {
      db.close();
    }
  });

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
          expectedScope: await statsScopeFor(db, firstToken),
          body: { nickname: 'Minsu' },
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

  it('grandfathers an existing nickname above 12 characters without allowing it as a new write', async () => {
    const db = new SqliteD1();
    const token = 'g'.repeat(43);
    const legacyNickname = 'x'.repeat(13);
    try {
      await seedAccount(db, [token]);
      db.database
        .prepare(
          `UPDATE mxqr_accounts
              SET nickname = ?, profile_complete = 1, updated_at = updated_at + 1
            WHERE account_id = ?`,
        )
        .run(legacyNickname, ACCOUNT_ID);

      const session = await handleAccountAuthRequest(
        request('/api/auth/session', { token }),
        authEnv(db),
      );
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({
        authenticated: true,
        account: { nickname: legacyNickname, profileComplete: true },
      });

      const unchangedWrite = await handleAccountAuthRequest(
        request('/api/auth/profile', {
          method: 'PATCH',
          token,
          expectedScope: await statsScopeFor(db, token),
          body: { nickname: legacyNickname },
        }),
        authEnv(db),
      );
      expect(unchangedWrite.status).toBe(400);
      expect(await unchangedWrite.json()).toEqual({ error: 'NICKNAME_INVALID' });

      const stored = db.database
        .prepare('SELECT nickname, profile_complete FROM mxqr_accounts WHERE account_id = ?')
        .get(ACCOUNT_ID);
      expect(stored).toMatchObject({ nickname: legacyNickname, profile_complete: 1 });
    } finally {
      db.close();
    }
  });

  it('enforces global case, compatibility, and NFC uniqueness while allowing same-account casing changes', async () => {
    const db = new SqliteD1();
    const firstToken = 'h'.repeat(43);
    const secondToken = 'i'.repeat(43);
    const thirdToken = 'j'.repeat(43);
    const secondAccountId = `acct_${'B'.repeat(22)}`;
    const thirdAccountId = `acct_${'C'.repeat(22)}`;
    try {
      await seedAccount(db, [firstToken]);
      await seedAccount(db, [secondToken], {
        accountId: secondAccountId,
        subjectHash: 'T'.repeat(43),
      });
      await seedAccount(db, [thirdToken], {
        accountId: thirdAccountId,
        subjectHash: 'U'.repeat(43),
      });
      const env = authEnv(db);

      const firstClaim = await handleAccountAuthRequest(
        request('/api/auth/profile', {
          method: 'PATCH',
          token: firstToken,
          expectedScope: await statsScopeFor(db, firstToken),
          body: { nickname: 'MUSIXQUARE' },
        }),
        env,
      );
      expect(firstClaim.status).toBe(200);

      for (const nickname of ['musixquare', 'ＭＵＳＩＸＱＵＡＲＥ']) {
        const collision = await handleAccountAuthRequest(
          request('/api/auth/profile', {
            method: 'PATCH',
            token: secondToken,
            expectedScope: await statsScopeFor(db, secondToken),
            body: { nickname },
          }),
          env,
        );
        expect(collision.status, nickname).toBe(409);
        await expect(collision.json()).resolves.toEqual({ error: 'NICKNAME_TAKEN' });
      }

      const sameAccountRename = await handleAccountAuthRequest(
        request('/api/auth/profile', {
          method: 'PATCH',
          token: firstToken,
          expectedScope: await statsScopeFor(db, firstToken),
          body: { nickname: 'musixquare' },
        }),
        env,
      );
      expect(sameAccountRename.status).toBe(200);
      await expect(sameAccountRename.json()).resolves.toMatchObject({
        account: { nickname: 'musixquare', profileComplete: true },
      });

      const composedClaim = await handleAccountAuthRequest(
        request('/api/auth/profile', {
          method: 'PATCH',
          token: secondToken,
          expectedScope: await statsScopeFor(db, secondToken),
          body: { nickname: 'Caf\u00e9' },
        }),
        env,
      );
      expect(composedClaim.status).toBe(200);

      const decomposedCollision = await handleAccountAuthRequest(
        request('/api/auth/profile', {
          method: 'PATCH',
          token: thirdToken,
          expectedScope: await statsScopeFor(db, thirdToken),
          body: { nickname: 'Cafe\u0301' },
        }),
        env,
      );
      expect(decomposedCollision.status).toBe(409);
      await expect(decomposedCollision.json()).resolves.toEqual({ error: 'NICKNAME_TAKEN' });

      expect(
        db.database
          .prepare('SELECT nickname, nickname_key FROM mxqr_accounts WHERE account_id = ?')
          .get(ACCOUNT_ID),
      ).toMatchObject({ nickname: 'musixquare', nickname_key: 'musixquare' });
      expect(
        db.database
          .prepare('SELECT nickname, nickname_key FROM mxqr_accounts WHERE account_id = ?')
          .get(secondAccountId),
      ).toMatchObject({ nickname: 'Caf\u00e9', nickname_key: 'caf\u00e9' });
    } finally {
      db.close();
    }
  });

  it('rejects whitespace at the HTTP boundary without mutating the stored nickname', async () => {
    const db = new SqliteD1();
    const token = 'k'.repeat(43);
    try {
      await seedAccount(db, [token]);
      const env = authEnv(db);
      for (const nickname of [
        'Min su',
        ' Minsu',
        'Minsu\u00a0',
        '남춘천\u3164닭갈비',
        'Min\u200Bsu',
        'Min\tsu',
        'Min\nsu',
      ]) {
        const response = await handleAccountAuthRequest(
          request('/api/auth/profile', {
            method: 'PATCH',
            token,
            expectedScope: await statsScopeFor(db, token),
            body: { nickname },
          }),
          env,
        );
        expect(response.status, JSON.stringify(nickname)).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: 'NICKNAME_INVALID' });
      }
      expect(
        db.database
          .prepare(
            'SELECT nickname, nickname_key, profile_complete FROM mxqr_accounts WHERE account_id = ?',
          )
          .get(ACCOUNT_ID),
      ).toMatchObject({ nickname: null, nickname_key: null, profile_complete: 0 });
    } finally {
      db.close();
    }
  });

  it('releases a global nickname reservation after account deletion', async () => {
    const db = new SqliteD1();
    const firstToken = 'l'.repeat(43);
    const secondToken = 'm'.repeat(43);
    const secondAccountId = `acct_${'D'.repeat(22)}`;
    try {
      await seedAccount(db, [firstToken]);
      await seedAccount(db, [secondToken], {
        accountId: secondAccountId,
        subjectHash: 'V'.repeat(43),
      });
      const env = authEnv(db);

      const claim = await handleAccountAuthRequest(
        request('/api/auth/profile', {
          method: 'PATCH',
          token: firstToken,
          expectedScope: await statsScopeFor(db, firstToken),
          body: { nickname: 'Reusable' },
        }),
        env,
      );
      expect(claim.status).toBe(200);

      const beforeDeletion = await handleAccountAuthRequest(
        request('/api/auth/profile', {
          method: 'PATCH',
          token: secondToken,
          expectedScope: await statsScopeFor(db, secondToken),
          body: { nickname: 'reusable' },
        }),
        env,
      );
      expect(beforeDeletion.status).toBe(409);

      const deletion = await handleAccountAuthRequest(
        request('/api/auth/account', {
          method: 'DELETE',
          token: firstToken,
          expectedScope: await statsScopeFor(db, firstToken),
          body: { confirm: true },
        }),
        env,
      );
      expect(deletion.status).toBe(200);

      const reclaimed = await handleAccountAuthRequest(
        request('/api/auth/profile', {
          method: 'PATCH',
          token: secondToken,
          expectedScope: await statsScopeFor(db, secondToken),
          body: { nickname: 'reusable' },
        }),
        env,
      );
      expect(reclaimed.status).toBe(200);
      expect(
        db.database
          .prepare('SELECT nickname, nickname_key FROM mxqr_accounts WHERE account_id = ?')
          .get(secondAccountId),
      ).toMatchObject({ nickname: 'reusable', nickname_key: 'reusable' });
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
      db.database
        .prepare(
          `INSERT INTO mxqr_account_stats
             (account_id, session_count, listening_seconds, track_count)
           VALUES (?, 2, 360, 7)`,
        )
        .run(ACCOUNT_ID);
      const response = await handleAccountAuthRequest(
        request('/api/auth/account', {
          method: 'DELETE',
          token: firstToken,
          expectedScope: await statsScopeFor(db, firstToken),
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
        db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_account_stats').get(),
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

  it('re-ages a failed deletion fence with an exact SQLite CAS before retrying it', async () => {
    vi.useFakeTimers();
    const now = 1_900_000_000_000;
    vi.setSystemTime(now);
    const db = new SqliteD1();
    try {
      await seedAccount(db, []);
      db.database
        .prepare(`INSERT INTO mxqr_account_deletions (account_id, started_at) VALUES (?, 1)`)
        .run(ACCOUNT_ID);
      db.database
        .prepare(
          `INSERT INTO mxqr_account_pro_room_generations
             (account_id, room_code, room_generation, first_linked_at, last_seen_at)
           VALUES (?, '000123', 7, 1, 1)`,
        )
        .run(ACCOUNT_ID);
      const purge = vi.fn(async () => false);

      await expect(
        cleanupPendingAccountDeletions(authEnv(db), {
          purgeProRoomAccountAuthority: purge,
        }),
      ).resolves.toMatchObject({
        processedAccounts: 1,
        failedEdges: 1,
        completedAccounts: 0,
        pendingAccounts: 1,
      });
      expect(
        db.database
          .prepare('SELECT started_at FROM mxqr_account_deletions WHERE account_id = ?')
          .get(ACCOUNT_ID),
      ).toMatchObject({ started_at: now });

      await expect(
        cleanupPendingAccountDeletions(authEnv(db), {
          purgeProRoomAccountAuthority: purge,
        }),
      ).resolves.toMatchObject({ processedAccounts: 0, completedAccounts: 0 });
      expect(purge).toHaveBeenCalledTimes(1);

      purge.mockResolvedValue(true);
      vi.setSystemTime(now + 10 * 60 * 1000);
      await expect(
        cleanupPendingAccountDeletions(authEnv(db), {
          purgeProRoomAccountAuthority: purge,
        }),
      ).resolves.toMatchObject({
        processedAccounts: 1,
        purgedEdges: 1,
        failedEdges: 0,
        completedAccounts: 1,
        pendingAccounts: 0,
      });
      expect(
        db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_accounts').get(),
      ).toMatchObject({ count: 0 });
      expect(
        db.database.prepare('SELECT COUNT(*) AS count FROM mxqr_account_deletions').get(),
      ).toMatchObject({ count: 0 });
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
      db.database
        .prepare(
          `INSERT INTO mxqr_accounts
             (account_id, google_subject_hash, nickname, profile_complete, status, created_at, updated_at)
           VALUES (?, ?, NULL, 0, 'active', 1, 1)`,
        )
        .run(ACCOUNT_ID, 'S'.repeat(43));
      expect(() =>
        db.database
          .prepare(
            `INSERT INTO mxqr_account_stats
               (account_id, session_count, listening_seconds, track_count)
             VALUES (?, -1, 0, 0)`,
          )
          .run(ACCOUNT_ID),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

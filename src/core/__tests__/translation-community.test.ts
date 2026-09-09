import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  handleTranslationCommunityRequest,
  handleAdminTranslationCommunityRequest,
} from '../../../cloudflare/translation-community.ts';
import {
  handleAccountAuthRequest,
  resolveAccountSession,
} from '../../../cloudflare/account-auth.ts';
import { loadCatalogs, type Catalog } from '../../../scripts/translation-catalog.ts';
import { createTranslationCatalogAssets } from '../../../scripts/translation-catalog-assets.ts';
import { normalizeSchemaSql } from '../../../scripts/sql-schema-normalization.mts';
import type { ProposalDraft, Suggestion } from '../../i18n/translation-community.ts';

const ORIGIN = 'https://musixquare.com';
const PREFIX = '/api/translations/suggestions';
const PEPPER = 'translation-session-pepper-long-enough-123456';
const ACCOUNT_A = `acct_${'A'.repeat(22)}`;
const ACCOUNT_B = `acct_${'B'.repeat(22)}`;
const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'B'.repeat(43);
const schema = readFileSync(
  new URL('../../../cloudflare/auth.schema.sql', import.meta.url),
  'utf8',
);
const migration = readFileSync(
  new URL('../../../cloudflare/auth.translation-community.migration.sql', import.meta.url),
  'utf8',
);
class SqlStatement {
  constructor(
    readonly statement: StatementSync,
    readonly values: SQLInputValue[] = [],
  ) {}
  bind(...values: SQLInputValue[]) {
    return new SqlStatement(this.statement, values);
  }
  async first() {
    return this.statement.get(...this.values) ?? null;
  }
  async all() {
    return { results: this.statement.all(...this.values) };
  }
  execute() {
    return { success: true, meta: { changes: Number(this.statement.run(...this.values).changes) } };
  }
  async run() {
    return this.execute();
  }
}
class SqlDatabase {
  readonly native = new DatabaseSync(':memory:');
  beforeBatch: (() => void) | null = null;
  constructor() {
    this.native.exec(schema);
  }
  prepare(sql: string) {
    return new SqlStatement(this.native.prepare(sql));
  }
  async batch(statements: SqlStatement[]) {
    this.beforeBatch?.();
    this.native.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement.execute());
      this.native.exec('COMMIT');
      return results;
    } catch (error) {
      this.native.exec('ROLLBACK');
      throw error;
    }
  }
}
let catalogs: Map<string, Catalog>;
let assets: Map<string, string>;
let db: SqlDatabase;
let env: Record<string, unknown>;
let rateAllowed: boolean;
beforeAll(async () => {
  catalogs = await loadCatalogs(process.cwd());
  assets = createTranslationCatalogAssets(catalogs);
});
function assetsPort(values = assets) {
  return {
    fetch: async (request: Request) => {
      const source = values.get(new URL(request.url).pathname.slice(1));
      return new Response(source, {
        status: source === undefined ? 404 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}
async function seed(accountId: string, token: string, nickname: string | null) {
  const now = Date.now();
  db.native
    .prepare(
      'INSERT INTO mxqr_accounts (account_id,google_subject_hash,nickname,profile_complete,status,created_at,updated_at,nickname_key) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(
      accountId,
      accountId.padEnd(43, 'x'),
      nickname,
      nickname ? 1 : 0,
      'active',
      now,
      now,
      nickname?.toLowerCase() ?? null,
    );
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(PEPPER),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const hash = Buffer.from(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`account-session:v1\u0000${token}`),
    ),
  ).toString('base64url');
  db.native
    .prepare(
      'INSERT INTO mxqr_account_sessions (session_hash,account_id,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?)',
    )
    .run(hash, accountId, now - 1000, now, now + 86_400_000);
}
beforeEach(async () => {
  db = new SqlDatabase();
  rateAllowed = true;
  env = {
    MUSIXQUARE_AUTH_DB: db,
    ASSETS: assetsPort(),
    GOOGLE_OAUTH_CLIENT_ID: 'translation-tests.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'translation-test-client-secret',
    MXQR_AUTH_SESSION_PEPPER: PEPPER,
    MXQR_AUTH_SUBJECT_PEPPER: 'translation-subject-pepper-at-least-32-bytes',
    MXQR_OAUTH_STATE_SECRET: 'translation-oauth-state-secret-at-least-32-bytes',
    MUSIXQUARE_SERVICE_CONTROL: {
      getByName: () => ({
        fetch: async (request: Request) => {
          const input = (await request.json()) as { limit: number; windowMs: number };
          return Response.json({
            allowed: rateAllowed,
            limit: input.limit,
            remaining: rateAllowed ? input.limit - 1 : 0,
            resetAtMs: Date.now() + input.windowMs,
            retryAfterSeconds: rateAllowed ? 0 : 60,
          });
        },
      }),
    },
  };
  await seed(ACCOUNT_A, TOKEN_A, 'Alice');
  await seed(ACCOUNT_B, TOKEN_B, null);
});
afterEach(() => {
  db.native.close();
});
function draft(proposed = 'Encerrar', locale = 'pt-br', id = 'app:common.close'): ProposalDraft {
  const entry = catalogs.get(locale)!.entries.find((item) => item.id === id)!;
  return {
    ...entry,
    locale,
    proposed,
    reason: 'A natural alternative.',
    updatedAt: '2099-01-01T00:00:00.000Z',
  };
}
async function request(
  url: string,
  method = 'GET',
  body?: unknown,
  token: string | null = TOKEN_A,
  headers: Record<string, string> = {},
) {
  const cookie: Record<string, string> = token ? { Cookie: `__Host-mxqr_account=${token}` } : {};
  const session = token
    ? await resolveAccountSession(new Request(ORIGIN + '/', { headers: cookie }), env, {
        includeStatsScope: true,
      })
    : null;
  return new Request(ORIGIN + url, {
    method,
    headers: {
      ...cookie,
      ...(method === 'GET'
        ? {}
        : {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            'Sec-Fetch-Site': 'same-origin',
            'X-MXQR-Account-CSRF': '1',
            'X-MXQR-Account-Expected-Scope': session?.statsScope ?? '',
          }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function call(
  url: string,
  method = 'GET',
  body?: unknown,
  token: string | null = TOKEN_A,
  headers?: Record<string, string>,
) {
  const response = await handleTranslationCommunityRequest(
    await request(url, method, body, token, headers),
    env,
  );
  if (!response) throw new Error('Missing public route');
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as {
      suggestion: Suggestion;
      suggestions: Suggestion[];
      nextCursor: string | null;
      error: string;
    },
  };
}
async function submit(proposed = 'Encerrar', token = TOKEN_A, requestId = crypto.randomUUID()) {
  return call(PREFIX, 'POST', { requestId, draft: draft(proposed) }, token);
}
async function admin(id: string, status: 'approved' | 'rejected' | 'pending', revision: number) {
  const response = await handleAdminTranslationCommunityRequest(
    await request(`/api/admin/translations/${id}/review`, 'POST', {
      status,
      expectedRevision: revision,
    }),
    env,
  );
  if (!response) throw new Error('Missing admin route');
  return {
    status: response.status,
    body: (await response.json()) as { suggestion: Suggestion; error: string },
  };
}
function updateCanonical(current: string) {
  const changed = new Map(catalogs);
  const portuguese = structuredClone(catalogs.get('pt-br')!);
  portuguese.entries.find((item) => item.id === 'app:common.close')!.current = current;
  changed.set('pt-br', portuguese);
  env.ASSETS = assetsPort(createTranslationCatalogAssets(changed));
}

describe('translation community actual auth and SQLite contract', () => {
  it('publishes a canonical proposal with server identity/time and no account identifiers', async () => {
    const result = await submit();
    expect(result.status).toBe(200);
    expect(result.body.suggestion).toMatchObject({
      author: 'Alice',
      status: 'pending',
      revision: 1,
      votes: 0,
      voted: false,
      owned: true,
      outdated: false,
      applied: false,
    });
    expect(result.body.suggestion.createdAt).toBeLessThan(Date.parse('2099-01-01'));
    expect(JSON.stringify(result.body)).not.toContain(ACCOUNT_A);
    const publicList = await call(`${PREFIX}?locale=pt-br`, 'GET', undefined, null);
    expect(publicList.headers.get('cache-control')).toBe('no-store');
    expect(publicList.body.suggestions).toHaveLength(1);
    expect(publicList.body.suggestions[0]).toMatchObject({ owned: false, voted: false });
  });
  it('admits authenticated unfinished profiles using Contributor display identity', async () => {
    expect((await submit('Concluir', TOKEN_B)).body.suggestion.author).toBe('Contributor');
  });
  it.each([
    ['en', 'app:common.close', 'Dismiss'],
    ['ko', 'app:common.close', '닫을게요'],
    ['en', 'about:header.try', 'Give it a try'],
    ['ko', 'about:header.try', '지금 사용하기'],
  ])(
    'reviews and exports %s wording for %s with the original English reference',
    async (locale, id, proposed) => {
      const submitted = draft(proposed, locale, id);
      expect(submitted.current).toBe(locale === 'en' ? submitted.sourceEn : submitted.sourceKo);
      const result = await call(PREFIX, 'POST', {
        requestId: crypto.randomUUID(),
        draft: submitted,
      });
      expect(result.status).toBe(200);
      const suggestion = result.body.suggestion;
      expect(suggestion).toMatchObject({
        locale,
        surface: submitted.surface,
        key: submitted.key,
        sourceEn: submitted.sourceEn,
        sourceKo: submitted.sourceKo,
        current: submitted.current,
        proposed,
        status: 'pending',
        outdated: false,
        applied: false,
      });
      const publicList = await call(`${PREFIX}?locale=${locale}`, 'GET', undefined, null);
      expect(publicList.status).toBe(200);
      expect(publicList.body.suggestions).toHaveLength(1);
      expect(publicList.body.suggestions[0]).toMatchObject({ id: suggestion.id, owned: false });
      for (let retry = 0; retry < 2; retry++) {
        const vote = await call(`${PREFIX}/${suggestion.id}/vote`, 'PUT', {}, TOKEN_B);
        expect(vote.status).toBe(200);
        expect(vote.body.suggestion).toMatchObject({ votes: 1, voted: true });
      }
      const queue = await handleAdminTranslationCommunityRequest(
        new Request(`${ORIGIN}/api/admin/translations?locale=${locale}&status=pending`),
        env,
      );
      expect(queue?.status).toBe(200);
      expect(await queue!.json()).toMatchObject({ suggestions: [{ id: suggestion.id, locale }] });
      expect((await admin(suggestion.id, 'approved', 1)).status).toBe(200);
      const approved = await handleAdminTranslationCommunityRequest(
        new Request(`${ORIGIN}/api/admin/translations/export`),
        env,
      );
      expect(approved?.status).toBe(200);
      expect(await approved!.json()).toMatchObject({
        drafts: [
          {
            id,
            locale,
            sourceEn: submitted.sourceEn,
            sourceKo: submitted.sourceKo,
            current: submitted.current,
            proposed,
            suggestionId: suggestion.id,
            reviewRevision: 2,
          },
        ],
      });

      // Applying a reference-language edit refreshes that reference in every catalog.
      const changed = new Map<string, Catalog>();
      for (const [code, catalog] of catalogs) {
        const next = structuredClone(catalog);
        const entry = next.entries.find((item) => item.id === id)!;
        if (locale === 'en') entry.sourceEn = proposed;
        else entry.sourceKo = proposed;
        if (code === locale) entry.current = proposed;
        changed.set(code, next);
      }
      env.ASSETS = assetsPort(createTranslationCatalogAssets(changed));
      const applied = await call(`${PREFIX}?locale=${locale}`);
      expect(applied.body.suggestions[0]).toMatchObject({ applied: true });
      expect((await call(`${PREFIX}/${suggestion.id}`, 'DELETE', {})).body.error).toBe(
        'ALREADY_APPLIED',
      );
      const after = await handleAdminTranslationCommunityRequest(
        new Request(`${ORIGIN}/api/admin/translations/export`),
        env,
      );
      expect(after?.status).toBe(200);
      expect(await after!.json()).toMatchObject({ drafts: [] });
    },
  );
  it.each(['en', 'ko'])(
    'keeps canonical keys, references, variables and HTML protected for %s',
    async (locale) => {
      const canonical = draft('Welcome, {{name}}!', locale, 'app:account.welcome_back');
      for (const patch of [
        { sourceEn: 'Invented English {{name}}' },
        { sourceKo: '가짜 원문 {{name}}' },
        { current: 'Invented current {{name}}' },
        { key: 'new.key', id: 'app:new.key' },
        { proposed: 'Welcome!' },
        { proposed: 'Welcome, {{other}}!' },
        { proposed: '<script>alert(1)</script>{{name}}' },
      ]) {
        const result = await call(PREFIX, 'POST', {
          requestId: crypto.randomUUID(),
          draft: { ...canonical, ...patch },
        });
        expect([400, 409]).toContain(result.status);
      }
      const markup = await call(PREFIX, 'POST', {
        requestId: crypto.randomUUID(),
        draft: draft('Every device, one system.', locale, 'about:hero.h1'),
      });
      expect(markup.body.error).toBe('INVALID_PROPOSAL');
      expect(
        db.native.prepare('SELECT COUNT(*) AS n FROM mxqr_translation_suggestions').get()?.n,
      ).toBe(0);
    },
  );
  it('rejects anonymous, cross-origin, missing CSRF and replaced-session mutations', async () => {
    const body = { requestId: crypto.randomUUID(), draft: draft() };
    expect((await call(PREFIX, 'POST', body, null)).status).toBe(401);
    expect(
      (await call(PREFIX, 'POST', body, TOKEN_A, { Origin: 'https://other.invalid' })).body.error,
    ).toBe('CSRF_REJECTED');
    expect((await call(PREFIX, 'POST', body, TOKEN_A, { 'X-MXQR-Account-CSRF': '' })).status).toBe(
      403,
    );
    expect(
      (
        await call(PREFIX, 'POST', body, TOKEN_A, {
          'X-MXQR-Account-Expected-Scope': 'stale-scope',
        })
      ).body.error,
    ).toBe('ACCOUNT_SESSION_CHANGED');
    expect(
      db.native.prepare('SELECT COUNT(*) AS n FROM mxqr_translation_suggestions').get()?.n,
    ).toBe(0);
  });
  it('enforces current canonical baseline, target locale and lexical markup before writing', async () => {
    for (const patch of [
      { current: 'invented baseline' },
      { sourceKo: 'invented Korean' },
      { locale: 'unsupported' },
      { id: 'app:wrong.key' },
      { proposed: '<script>alert(1)</script>' },
    ]) {
      const result = await call(PREFIX, 'POST', {
        requestId: crypto.randomUUID(),
        draft: { ...draft(), ...patch },
      });
      expect([400, 409]).toContain(result.status);
    }
    expect(
      db.native.prepare('SELECT COUNT(*) AS n FROM mxqr_translation_suggestions').get()?.n,
    ).toBe(0);
  });
  it('preserves the editor reason limit and enforces an approval timestamp in SQLite', async () => {
    const accepted = await call(PREFIX, 'POST', {
      requestId: crypto.randomUUID(),
      draft: { ...draft(), reason: 'x'.repeat(4000) },
    });
    expect(accepted.status).toBe(200);
    expect(
      (
        await call(PREFIX, 'POST', {
          requestId: crypto.randomUUID(),
          draft: { ...draft(), reason: 'x'.repeat(4001) },
        })
      ).body.error,
    ).toBe('INVALID_DRAFT');
    expect(() =>
      db.native
        .prepare(
          "UPDATE mxqr_translation_suggestions SET status = 'approved', approved_at = NULL WHERE suggestion_id = ?",
        )
        .run(accepted.body.suggestion.id),
    ).toThrow(/CHECK constraint/);
  });
  it('rejects coerced JSON surface/status arrays before any proposal or review mutation', async () => {
    expect(
      (
        await call(PREFIX, 'POST', {
          requestId: crypto.randomUUID(),
          draft: { ...draft(), surface: ['app'] },
        })
      ).body.error,
    ).toBe('INVALID_DRAFT');
    const one = (await submit()).body.suggestion;
    const response = await handleAdminTranslationCommunityRequest(
      await request(`/api/admin/translations/${one.id}/review`, 'POST', {
        status: ['approved'],
        expectedRevision: 1,
      }),
      env,
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({ error: 'INVALID_REQUEST' });
    expect(
      db.native
        .prepare('SELECT status,revision,approved_at FROM mxqr_translation_suggestions')
        .all(),
    ).toEqual([{ status: 'pending', revision: 1, approved_at: null }]);
    expect(db.native.prepare('SELECT COUNT(*) AS n FROM mxqr_translation_reviews').get()?.n).toBe(
      0,
    );
  });
  it('returns the original receipt after response loss and refuses request-ID reuse with different copy', async () => {
    const requestId = crypto.randomUUID();
    const [first, concurrent] = await Promise.all([
      submit('Encerrar', TOKEN_A, requestId),
      submit('Encerrar', TOKEN_A, requestId),
    ]);
    expect(first.status).toBe(200);
    expect(concurrent.status).toBe(200);
    expect(concurrent.body.suggestion.id).toBe(first.body.suggestion.id);
    expect((await submit('Concluir', TOKEN_A, requestId)).body.error).toBe('REQUEST_ID_CONFLICT');
    expect(
      db.native.prepare('SELECT COUNT(*) AS n FROM mxqr_translation_suggestions').get()?.n,
    ).toBe(1);
  });
  it('atomically treats repeated PUT/DELETE as one account vote and ranks public suggestions', async () => {
    const one = (await submit('Encerrar')).body.suggestion;
    const two = (await submit('Concluir')).body.suggestion;
    const url = `${PREFIX}/${one.id}/vote`;
    const votes = await Promise.all([call(url, 'PUT', {}, TOKEN_B), call(url, 'PUT', {}, TOKEN_B)]);
    expect(votes.map((item) => item.status)).toEqual([200, 200]);
    expect(votes[1]!.body.suggestion).toMatchObject({ votes: 1, voted: true, owned: false });
    expect(
      (await call(`${PREFIX}?locale=pt-br&sort=top`)).body.suggestions.map((item) => item.id),
    ).toEqual([one.id, two.id]);
    await call(url, 'DELETE', {}, TOKEN_B);
    expect((await call(url, 'DELETE', {}, TOKEN_B)).body.suggestion.votes).toBe(0);
  });
  it('blocks mutation when atomic rate control is unavailable or rejects admission', async () => {
    rateAllowed = false;
    const limited = await submit();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    delete env.MUSIXQUARE_SERVICE_CONTROL;
    expect((await submit()).status).toBe(503);
    expect(
      db.native.prepare('SELECT COUNT(*) AS n FROM mxqr_translation_suggestions').get()?.n,
    ).toBe(0);
  });
  it('does not publish against a missing canonical asset and can retry after asset recovery', async () => {
    let unavailable = true;
    env.ASSETS = {
      fetch: async (req: Request) =>
        unavailable ? new Response('missing', { status: 404 }) : assetsPort().fetch(req),
    };
    expect((await submit()).status).toBe(503);
    unavailable = false;
    expect((await submit()).status).toBe(200);
  });
  it('fails closed when deployment bindings do not expose their required callable ports', async () => {
    env.MUSIXQUARE_AUTH_DB = { prepare: db.prepare.bind(db), batch: null };
    expect((await call(`${PREFIX}?locale=pt-br`, 'GET', undefined, null)).status).toBe(503);
    env.MUSIXQUARE_AUTH_DB = db;
    env.ASSETS = { fetch: 'unavailable' };
    expect((await submit()).status).toBe(503);
    expect(
      db.native.prepare('SELECT COUNT(*) AS n FROM mxqr_translation_suggestions').get()?.n,
    ).toBe(0);
  });
  it('rejects an incomplete or incorrectly typed database result instead of publishing a partial DTO', async () => {
    await submit();
    const stored = db.native
      .prepare('SELECT *, NULL AS nickname, 0 AS voted FROM mxqr_translation_suggestions')
      .get()!;
    for (const sourceEn of [undefined, 123]) {
      const statement = {
        bind: () => statement,
        all: async () => ({ results: [{ ...stored, source_en: sourceEn }] }),
      };
      env.MUSIXQUARE_AUTH_DB = { prepare: () => statement, batch: async () => [] };
      const response = await call(`${PREFIX}?locale=pt-br`, 'GET', undefined, null);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'TRANSLATIONS_UNAVAILABLE' });
    }
  });
  it('rejects oversized request bytes before reading or storing copy', async () => {
    const result = await call(
      PREFIX,
      'POST',
      { requestId: crypto.randomUUID(), draft: draft() },
      TOKEN_A,
      { 'Content-Length': String(768 * 1024 + 1) },
    );
    expect(result.status).toBe(413);
  });
  it('selects one approved alternative atomically and audits superseded revision changes', async () => {
    const one = (await submit('Encerrar')).body.suggestion;
    const two = (await submit('Concluir')).body.suggestion;
    expect((await admin(one.id, 'approved', 1)).status).toBe(200);
    const approved = await admin(two.id, 'approved', 1);
    expect(approved.body.suggestion).toMatchObject({ status: 'approved', revision: 2 });
    const rows = db.native
      .prepare('SELECT suggestion_id,status,revision FROM mxqr_translation_suggestions')
      .all();
    expect(rows).toContainEqual({ suggestion_id: one.id, status: 'pending', revision: 3 });
    expect(
      db.native
        .prepare(
          'SELECT action,revision FROM mxqr_translation_reviews WHERE suggestion_id = ? ORDER BY revision',
        )
        .all(one.id),
    ).toEqual([
      { action: 'approved', revision: 2 },
      { action: 'superseded', revision: 3 },
    ]);
    expect((await admin(two.id, 'rejected', 1)).body.error).toBe('REVISION_CONFLICT');
  });
  it('rejects a superseded optimistic review and preserves both proposal/audit atomicity', async () => {
    const one = (await submit()).body.suggestion;
    const results = await Promise.all([admin(one.id, 'approved', 1), admin(one.id, 'approved', 1)]);
    expect(results.map((item) => item.status).sort()).toEqual([200, 409]);
    expect(db.native.prepare('SELECT COUNT(*) AS n FROM mxqr_translation_reviews').get()?.n).toBe(
      1,
    );
  });
  it('serializes approvals of different alternatives without leaving two approved rows', async () => {
    const one = (await submit('Encerrar')).body.suggestion;
    const two = (await submit('Concluir')).body.suggestion;
    const results = await Promise.all([admin(one.id, 'approved', 1), admin(two.id, 'approved', 1)]);
    expect(results.every((item) => item.status === 200 || item.status === 409)).toBe(true);
    expect(
      db.native
        .prepare("SELECT COUNT(*) AS n FROM mxqr_translation_suggestions WHERE status = 'approved'")
        .get()?.n,
    ).toBe(1);
    expect(
      db.native
        .prepare('SELECT action,revision FROM mxqr_translation_reviews ORDER BY rowid')
        .all(),
    ).toEqual([
      { action: 'approved', revision: 2 },
      { action: 'superseded', revision: 3 },
      { action: 'approved', revision: 2 },
    ]);
  });
  it('hides rejected/withdrawn proposals and never lets another account withdraw them', async () => {
    const one = (await submit()).body.suggestion;
    expect((await call(`${PREFIX}/${one.id}`, 'DELETE', {}, TOKEN_B)).status).toBe(404);
    await admin(one.id, 'rejected', 1);
    expect((await call(`${PREFIX}?locale=pt-br`)).body.suggestions).toEqual([]);
    expect((await call(`${PREFIX}/${one.id}/vote`, 'PUT', {})).body.error).toBe(
      'SUGGESTION_CLOSED',
    );
    expect((await call(`${PREFIX}/${one.id}`, 'DELETE', {})).body.suggestion.status).toBe(
      'withdrawn',
    );
  });
  it('exports only fresh approval, rejects stale pending release, and detects applied catalog copy', async () => {
    const one = (await submit()).body.suggestion;
    await admin(one.id, 'approved', 1);
    const exportResponse = await handleAdminTranslationCommunityRequest(
      new Request(`${ORIGIN}/api/admin/translations/export`),
      env,
    );
    expect(exportResponse?.status).toBe(200);
    expect(await exportResponse!.json()).toMatchObject({
      version: 1,
      kind: 'musixquare-approved-translations',
      drafts: [{ suggestionId: one.id, reviewRevision: 2, proposed: 'Encerrar' }],
    });
    updateCanonical('Nova origem');
    const stale = await handleAdminTranslationCommunityRequest(
      new Request(`${ORIGIN}/api/admin/translations/export`),
      env,
    );
    expect(stale?.status).toBe(409);
    updateCanonical('Encerrar');
    const applied = (await call(`${PREFIX}?locale=pt-br`)).body.suggestions[0]!;
    expect(applied.applied).toBe(true);
    expect((await call(`${PREFIX}/${one.id}`, 'DELETE', {})).body.error).toBe('ALREADY_APPLIED');
    const after = await handleAdminTranslationCommunityRequest(
      new Request(`${ORIGIN}/api/admin/translations/export`),
      env,
    );
    expect(await after!.json()).toMatchObject({ drafts: [] });
  });
  it('cascades actual account deletion through contributions, votes, counters and review history', async () => {
    const one = (await submit()).body.suggestion;
    const two = (await submit('Concluir', TOKEN_B)).body.suggestion;
    await call(`${PREFIX}/${two.id}/vote`, 'PUT', {}, TOKEN_A);
    await call(`${PREFIX}/${one.id}/vote`, 'PUT', {}, TOKEN_B);
    await admin(one.id, 'approved', 1);
    const deleted = await handleAccountAuthRequest(
      await request('/api/auth/account', 'DELETE', { confirm: true }),
      env,
    );
    expect(deleted?.status).toBe(200);
    expect(
      db.native.prepare('SELECT suggestion_id,vote_count FROM mxqr_translation_suggestions').all(),
    ).toEqual([{ suggestion_id: two.id, vote_count: 0 }]);
    expect(db.native.prepare('SELECT COUNT(*) AS n FROM mxqr_translation_votes').get()?.n).toBe(0);
    expect(db.native.prepare('SELECT COUNT(*) AS n FROM mxqr_translation_reviews').get()?.n).toBe(
      0,
    );
  });
  it('closes writes while deletion is in progress and closes a review if its author disappears', async () => {
    const one = (await submit()).body.suggestion;
    db.native
      .prepare('INSERT INTO mxqr_account_deletions (account_id,started_at) VALUES (?,?)')
      .run(ACCOUNT_A, Date.now());
    expect((await submit('Concluir')).status).toBe(401);
    expect((await call(`${PREFIX}?locale=pt-br`)).body.suggestions).toEqual([]);
    db.beforeBatch = () => {
      db.native.prepare('DELETE FROM mxqr_accounts WHERE account_id = ?').run(ACCOUNT_A);
      db.beforeBatch = null;
    };
    expect((await admin(one.id, 'approved', 1)).status).toBe(409);
  });
  it('uses stable bounded cursors and rejects a cursor reused for a different filter', async () => {
    for (let index = 0; index < 22; index++) await submit(`Alternativa ${index}`);
    const first = await call(`${PREFIX}?locale=pt-br&sort=new`);
    expect(first.body.suggestions).toHaveLength(20);
    expect(first.body.nextCursor).toBeTruthy();
    const cursor = encodeURIComponent(first.body.nextCursor!);
    const second = await call(`${PREFIX}?locale=pt-br&sort=new&cursor=${cursor}`);
    expect(second.body.suggestions).toHaveLength(2);
    expect(
      new Set([...first.body.suggestions, ...second.body.suggestions].map((item) => item.id)).size,
    ).toBe(22);
    expect((await call(`${PREFIX}?locale=fr&sort=new&cursor=${cursor}`)).body.error).toBe(
      'INVALID_CURSOR',
    );
  });
  it('puts older recommended proposals first in the admin queue and carries ranking across pages', async () => {
    const older = (await submit('Alternativa recomendada')).body.suggestion;
    for (let index = 0; index < 21; index++) await submit(`Alternativa ${index}`);
    await call(`${PREFIX}/${older.id}/vote`, 'PUT', {}, TOKEN_B);
    const readPage = async (cursor = '') => {
      const response = await handleAdminTranslationCommunityRequest(
        new Request(
          `${ORIGIN}/api/admin/translations?status=pending${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
        env,
      );
      expect(response?.status).toBe(200);
      return (await response!.json()) as { suggestions: Suggestion[]; nextCursor: string | null };
    };
    const first = await readPage();
    expect(first.suggestions).toHaveLength(20);
    expect(first.suggestions[0]).toMatchObject({ id: older.id, votes: 1 });
    expect(first.nextCursor).toBeTruthy();
    const second = await readPage(first.nextCursor!);
    expect(second.suggestions).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.suggestions, ...second.suggestions].map((item) => item.id)).size).toBe(
      22,
    );
  });
  it('runs the exact production release readback against both baseline and upgraded databases', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/release.yml', import.meta.url),
      'utf8',
    );
    const section = workflow.split(
      "verify_file='release-artifacts/deployments/translation-community-verified.json'",
    )[1];
    expect(section).toBeDefined();
    const sql = section!.match(/verify_sql=\$\(cat <<'SQL'\r?\n([\s\S]*?)\r?\n\s*SQL\r?\n/)?.[1];
    expect(sql).toBeDefined();
    const expected = {
      table_count: 3,
      proposal_columns: 17,
      approval_column: 1,
      vote_key_columns: 2,
      account_cascades: 2,
      proposal_cascades: 2,
      approval_index: 1,
      approval_key_columns: 3,
      vote_triggers: 2,
    };
    expect(db.native.prepare(sql!).get()).toEqual(expected);
    const previous = new DatabaseSync(':memory:');
    try {
      previous.exec(schema.slice(0, schema.indexOf('-- Public translation contributions')));
      expect(previous.prepare(sql!).get()).not.toEqual(expected);
      previous.exec(migration);
      expect(previous.prepare(sql!).get()).toEqual(expected);
    } finally {
      previous.close();
    }
  });
  it('upgrades the preceding account baseline idempotently to the current schema', () => {
    const marker = schema.indexOf('-- Public translation contributions');
    expect(marker).toBeGreaterThan(0);
    const previous = new DatabaseSync(':memory:');
    try {
      previous.exec(schema.slice(0, marker));
      previous.exec(migration);
      previous.exec(migration);
      const dump = (database: DatabaseSync) =>
        database
          .prepare(
            "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
          )
          .all()
          .map((item) => ({ ...item, sql: normalizeSchemaSql(String(item.sql)) }));
      expect(dump(previous)).toEqual(dump(db.native));
      expect(previous.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      previous.close();
    }
  });
});

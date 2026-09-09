import { resolveAccountSession, type ResolvedAccountSession } from './account-auth.ts';
import { consumeAbuseRateLimit } from './service-maintenance.ts';
import { LANGUAGE_OPTIONS } from '../src/i18n/locales.ts';
import {
  validateProposal,
  type Entry,
  type ProposalDraft,
  type Suggestion,
  type ApprovedTranslationsExport,
} from '../src/i18n/translation-community.ts';
import {
  currentTranslationEntry,
  readTranslationRequest,
  record,
  TranslationFailure,
} from './translation-community-catalog.ts';

type SqlValue = string | number | null;
interface Statement {
  bind(...values: SqlValue[]): Statement;
  first(): Promise<unknown>;
  all(): Promise<{ results?: unknown[] }>;
  run(): Promise<unknown>;
}
interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}
interface SuggestionRow {
  suggestion_id: string;
  account_id: string;
  request_fingerprint: string;
  locale: string;
  surface: 'app' | 'about';
  translation_key: string;
  source_en: string;
  source_ko: string;
  current_text: string;
  proposed_text: string;
  reason: string;
  created_at: number;
  updated_at: number;
  status: Suggestion['status'];
  revision: number;
  vote_count: number;
  approved_at: number | null;
  nickname: string | null;
  voted: number;
}
const PREFIX = '/api/translations/suggestions';
const ADMIN_PREFIX = '/api/admin/translations';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TARGETS = new Set<string>(LANGUAGE_OPTIONS.map(({ code }) => code));
const PAGE_SIZE = 20;
const MAX_RESPONSE_BYTES = 768 * 1024;
const ACTIVE_ACCOUNT = `EXISTS (SELECT 1 FROM mxqr_accounts a WHERE a.account_id = ? AND a.status = 'active' AND NOT EXISTS (SELECT 1 FROM mxqr_account_deletions d WHERE d.account_id = a.account_id))`;

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}
function fail(code: string, status = 400): never {
  throw new TranslationFailure(code, status);
}
function isDatabase(value: unknown): value is Database {
  return record(value) && typeof value.prepare === 'function' && typeof value.batch === 'function';
}
function database(env: unknown): Database {
  const db = record(env) ? env.MUSIXQUARE_AUTH_DB : null;
  if (!isDatabase(db)) fail('TRANSLATIONS_UNAVAILABLE', 503);
  return db;
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function isSuggestionRow(value: unknown): value is SuggestionRow {
  return (
    record(value) &&
    typeof value.suggestion_id === 'string' &&
    UUID.test(value.suggestion_id) &&
    typeof value.account_id === 'string' &&
    value.account_id.length > 0 &&
    typeof value.request_fingerprint === 'string' &&
    /^[0-9a-f]{64}$/u.test(value.request_fingerprint) &&
    typeof value.locale === 'string' &&
    TARGETS.has(value.locale) &&
    (value.surface === 'app' || value.surface === 'about') &&
    text(value.translation_key, 200) &&
    value.translation_key.length > 0 &&
    text(value.source_en, 32_768) &&
    text(value.source_ko, 32_768) &&
    text(value.current_text, 32_768) &&
    text(value.proposed_text, 32_768) &&
    value.proposed_text.length > 0 &&
    text(value.reason, 4000) &&
    integer(value.created_at, 1) &&
    integer(value.updated_at, value.created_at) &&
    (value.status === 'pending' ||
      value.status === 'approved' ||
      value.status === 'rejected' ||
      value.status === 'withdrawn') &&
    integer(value.revision, 1) &&
    integer(value.vote_count, 0) &&
    (value.status === 'approved' ? integer(value.approved_at, 1) : value.approved_at === null) &&
    (value.nickname === null || typeof value.nickname === 'string') &&
    (value.voted === 0 || value.voted === 1)
  );
}
function row(value: unknown): SuggestionRow {
  if (!isSuggestionRow(value)) fail('TRANSLATIONS_UNAVAILABLE', 503);
  return value;
}
function selection(accountId: string | null): { sql: string; values: SqlValue[] } {
  return {
    sql: `SELECT s.*, a.nickname, EXISTS(SELECT 1 FROM mxqr_translation_votes v WHERE v.suggestion_id = s.suggestion_id AND v.account_id = ?) AS voted FROM mxqr_translation_suggestions s JOIN mxqr_accounts a ON a.account_id = s.account_id`,
    values: [accountId],
  };
}
async function find(db: Database, id: string, accountId: string | null): Promise<SuggestionRow> {
  const query = selection(accountId);
  const found = await db
    .prepare(`${query.sql} WHERE s.suggestion_id = ?`)
    .bind(...query.values, id)
    .first();
  if (!found) fail('NOT_FOUND', 404);
  return row(found);
}
function baselineMatches(
  value: Pick<ProposalDraft, 'sourceEn' | 'sourceKo' | 'current'>,
  entry: Entry | null,
): boolean {
  return (
    entry !== null &&
    value.sourceEn === entry.sourceEn &&
    value.sourceKo === entry.sourceKo &&
    value.current === entry.current
  );
}
async function dto(
  value: SuggestionRow,
  env: unknown,
  accountId: string | null,
): Promise<Suggestion> {
  const entry = await currentTranslationEntry(
    env,
    value.locale,
    value.surface,
    value.translation_key,
  );
  return {
    id: value.suggestion_id,
    locale: value.locale,
    surface: value.surface,
    key: value.translation_key,
    sourceEn: value.source_en,
    sourceKo: value.source_ko,
    current: value.current_text,
    proposed: value.proposed_text,
    reason: value.reason,
    author: typeof value.nickname === 'string' && value.nickname ? value.nickname : 'Contributor',
    createdAt: value.created_at,
    status: value.status,
    revision: value.revision,
    votes: value.vote_count,
    voted: value.voted === 1,
    owned: value.account_id === accountId,
    outdated: !baselineMatches(
      { sourceEn: value.source_en, sourceKo: value.source_ko, current: value.current_text },
      entry,
    ),
    applied: value.status === 'approved' && entry?.current === value.proposed_text,
  };
}
async function mutationSession(request: Request, env: unknown): Promise<ResolvedAccountSession> {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (
    request.headers.get('X-MXQR-Account-CSRF') !== '1' ||
    origin !== new URL(request.url).origin ||
    (fetchSite !== null && fetchSite !== 'same-origin')
  )
    fail('CSRF_REJECTED', 403);
  const session = await resolveAccountSession(request, env, { includeStatsScope: true });
  if (!session) fail('AUTH_REQUIRED', 401);
  if (
    !session.statsScope ||
    request.headers.get('X-MXQR-Account-Expected-Scope') !== session.statsScope
  )
    fail('ACCOUNT_SESSION_CHANGED', 409);
  const rate = await consumeAbuseRateLimit(record(env) ? env : {}, {
    scope: request.method === 'POST' ? 'translation-submit' : 'translation-interaction',
    identity: session.accountId,
    limit: request.method === 'POST' ? 6 : 60,
    windowMs: 60_000,
  });
  if (rate.status !== 'ok') fail('TRANSLATIONS_UNAVAILABLE', 503);
  if (!rate.allowed) throw new RateFailure(rate.retryAfterSeconds);
  return session;
}
class RateFailure extends TranslationFailure {
  constructor(public readonly retryAfter: number) {
    super('RATE_LIMITED', 429);
  }
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}
function parseDraft(value: unknown): ProposalDraft {
  if (
    !record(value) ||
    !text(value.locale, 12) ||
    !TARGETS.has(value.locale) ||
    (value.surface !== 'app' && value.surface !== 'about') ||
    !text(value.key, 200) ||
    !value.key ||
    value.id !== `${value.surface}:${value.key}` ||
    !text(value.sourceEn, 32_768) ||
    !text(value.sourceKo, 32_768) ||
    !text(value.current, 32_768) ||
    !text(value.proposed, 32_768) ||
    !text(value.reason, 4000) ||
    !text(value.updatedAt, 100)
  )
    fail('INVALID_DRAFT');
  return {
    id: `${value.surface}:${value.key}`,
    locale: value.locale,
    surface: value.surface,
    key: value.key,
    sourceEn: value.sourceEn,
    sourceKo: value.sourceKo,
    current: value.current,
    proposed: value.proposed,
    reason: value.reason,
    updatedAt: value.updatedAt,
  };
}
async function fingerprint(draft: ProposalDraft): Promise<string> {
  // Browser timestamps have no authority and do not change retry identity.
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      draft.locale,
      draft.surface,
      draft.key,
      draft.sourceEn,
      draft.sourceKo,
      draft.current,
      draft.proposed,
      draft.reason,
    ]),
  );
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
async function submit(request: Request, env: unknown, db: Database): Promise<Response> {
  const session = await mutationSession(request, env);
  const body = await readTranslationRequest(request);
  if (typeof body.requestId !== 'string' || !UUID.test(body.requestId)) fail('INVALID_REQUEST');
  const draft = parseDraft(body.draft);
  const hash = await fingerprint(draft);
  const existing = await db
    .prepare(
      'SELECT suggestion_id, request_fingerprint FROM mxqr_translation_suggestions WHERE account_id = ? AND request_id = ?',
    )
    .bind(session.accountId, body.requestId)
    .first();
  if (record(existing)) {
    if (existing.request_fingerprint !== hash) fail('REQUEST_ID_CONFLICT', 409);
    return json({
      suggestion: await dto(
        await find(db, String(existing.suggestion_id), session.accountId),
        env,
        session.accountId,
      ),
    });
  }
  const entry = await currentTranslationEntry(env, draft.locale, draft.surface, draft.key);
  if (!baselineMatches(draft, entry)) fail('SOURCE_CHANGED', 409);
  if (!entry || validateProposal(entry, draft.proposed).length) fail('INVALID_PROPOSAL');
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO mxqr_translation_suggestions (suggestion_id, account_id, request_id, request_fingerprint, locale, surface, translation_key, source_en, source_ko, current_text, proposed_text, reason, created_at, updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${ACTIVE_ACCOUNT} ON CONFLICT(account_id, request_id) DO NOTHING`,
    )
    .bind(
      id,
      session.accountId,
      body.requestId,
      hash,
      draft.locale,
      draft.surface,
      draft.key,
      draft.sourceEn,
      draft.sourceKo,
      draft.current,
      draft.proposed,
      draft.reason,
      now,
      now,
      session.accountId,
    )
    .run();
  const inserted = await db
    .prepare(
      'SELECT suggestion_id, request_fingerprint FROM mxqr_translation_suggestions WHERE account_id = ? AND request_id = ?',
    )
    .bind(session.accountId, body.requestId)
    .first();
  if (!record(inserted)) fail('AUTH_REQUIRED', 401);
  if (inserted.request_fingerprint !== hash) fail('REQUEST_ID_CONFLICT', 409);
  return json({
    suggestion: await dto(
      await find(db, String(inserted.suggestion_id), session.accountId),
      env,
      session.accountId,
    ),
  });
}
interface Cursor {
  filter: string;
  votes: number;
  created: number;
  id: string;
}
function readCursor(value: string | null, filter: string): Cursor | null {
  if (!value) return null;
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) fail('INVALID_CURSOR');
  try {
    const parsed: unknown = JSON.parse(atob(value.replace(/-/gu, '+').replace(/_/gu, '/')));
    if (
      !record(parsed) ||
      parsed.filter !== filter ||
      !integer(parsed.votes, 0) ||
      !integer(parsed.created, 1) ||
      typeof parsed.id !== 'string' ||
      !UUID.test(parsed.id)
    )
      fail('INVALID_CURSOR');
    return { filter, votes: parsed.votes, created: parsed.created, id: parsed.id };
  } catch {
    return fail('INVALID_CURSOR');
  }
}
function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}
async function list(
  request: Request,
  env: unknown,
  db: Database,
  url: URL,
  admin: boolean,
): Promise<Response> {
  const allowed = new Set(
    admin ? ['status', 'locale', 'cursor'] : ['locale', 'surface', 'key', 'sort', 'cursor'],
  );
  for (const key of url.searchParams.keys())
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) fail('INVALID_REQUEST');
  const locale = url.searchParams.get('locale');
  if ((!admin && !locale) || (locale !== null && !TARGETS.has(locale))) fail('INVALID_REQUEST');
  const surface = url.searchParams.get('surface');
  const key = url.searchParams.get('key');
  if (
    (surface !== null && surface !== 'app' && surface !== 'about') ||
    (key !== null && (!key || key.length > 200 || !surface))
  )
    fail('INVALID_REQUEST');
  const sort = admin ? 'top' : (url.searchParams.get('sort') ?? 'top');
  if (sort !== 'top' && sort !== 'new') fail('INVALID_REQUEST');
  const status = admin ? (url.searchParams.get('status') ?? 'pending') : 'public';
  if (admin && !['pending', 'approved', 'rejected', 'all'].includes(status))
    fail('INVALID_REQUEST');
  const session = admin ? null : await resolveAccountSession(request, env);
  const accountId = session?.accountId ?? null;
  const filter = JSON.stringify([admin, locale, surface, key, sort, status]);
  const cursor = readCursor(url.searchParams.get('cursor'), filter);
  const query = selection(accountId);
  const where = [
    "a.status = 'active'",
    'NOT EXISTS (SELECT 1 FROM mxqr_account_deletions d WHERE d.account_id = s.account_id)',
  ];
  const values = [...query.values];
  if (locale) {
    where.push('s.locale = ?');
    values.push(locale);
  }
  if (surface) {
    where.push('s.surface = ?');
    values.push(surface);
  }
  if (key) {
    where.push('s.translation_key = ?');
    values.push(key);
  }
  if (!admin) where.push("s.status IN ('pending','approved')");
  else if (status !== 'all') {
    where.push('s.status = ?');
    values.push(status);
  }
  if (cursor) {
    const chronological = '(s.created_at < ? OR (s.created_at = ? AND s.suggestion_id > ?))';
    if (sort === 'top') {
      where.push(`(s.vote_count < ? OR (s.vote_count = ? AND ${chronological}))`);
      values.push(cursor.votes, cursor.votes);
    } else where.push(chronological);
    values.push(cursor.created, cursor.created, cursor.id);
  }
  const result = await db
    .prepare(
      `${query.sql} WHERE ${where.join(' AND ')} ORDER BY ${sort === 'top' ? 's.vote_count DESC, ' : ''}s.created_at DESC, s.suggestion_id ASC LIMIT ?`,
    )
    .bind(...values, PAGE_SIZE + 1)
    .all();
  const rows = (result.results ?? []).map(row);
  const suggestions: Suggestion[] = [];
  let bytes = 0;
  for (const item of rows.slice(0, PAGE_SIZE)) {
    const suggestion = await dto(item, env, accountId);
    const size = new TextEncoder().encode(JSON.stringify(suggestion)).byteLength;
    if (suggestions.length && bytes + size > MAX_RESPONSE_BYTES) break;
    suggestions.push(suggestion);
    bytes += size;
  }
  const last = rows[suggestions.length - 1];
  const nextCursor =
    last && rows.length > suggestions.length
      ? encodeCursor({
          filter,
          votes: last.vote_count,
          created: last.created_at,
          id: last.suggestion_id,
        })
      : null;
  return json({ suggestions, nextCursor });
}
async function vote(request: Request, env: unknown, db: Database, id: string): Promise<Response> {
  const session = await mutationSession(request, env);
  const before = await find(db, id, session.accountId);
  if (!['pending', 'approved'].includes(before.status)) fail('SUGGESTION_CLOSED', 409);
  if (request.method === 'PUT') {
    await db
      .prepare(
        `INSERT INTO mxqr_translation_votes (suggestion_id,account_id,created_at) SELECT ?,?,? WHERE ${ACTIVE_ACCOUNT} AND EXISTS (SELECT 1 FROM mxqr_translation_suggestions WHERE suggestion_id = ? AND status IN ('pending','approved')) ON CONFLICT(suggestion_id,account_id) DO NOTHING`,
      )
      .bind(id, session.accountId, Date.now(), session.accountId, id)
      .run();
  } else {
    await db
      .prepare(
        `DELETE FROM mxqr_translation_votes WHERE suggestion_id = ? AND account_id = ? AND ${ACTIVE_ACCOUNT}`,
      )
      .bind(id, session.accountId, session.accountId)
      .run();
  }
  const after = await find(db, id, session.accountId);
  if (!['pending', 'approved'].includes(after.status)) fail('SUGGESTION_CLOSED', 409);
  return json({ suggestion: await dto(after, env, session.accountId) });
}
async function withdraw(
  request: Request,
  env: unknown,
  db: Database,
  id: string,
): Promise<Response> {
  const session = await mutationSession(request, env);
  const before = await find(db, id, session.accountId);
  if (before.account_id !== session.accountId) fail('NOT_FOUND', 404);
  const display = await dto(before, env, session.accountId);
  if (display.applied) fail('ALREADY_APPLIED', 409);
  if (before.status === 'withdrawn') return json({ suggestion: display });
  const now = Date.now();
  const where = `suggestion_id = ? AND account_id = ? AND revision = ? AND ${ACTIVE_ACCOUNT}`;
  const binds: SqlValue[] = [id, session.accountId, before.revision, session.accountId];
  await db.batch([
    db
      .prepare(
        `INSERT INTO mxqr_translation_reviews (review_id,suggestion_id,action,actor_kind,revision,reviewed_at) SELECT ?,suggestion_id,'withdrawn','author',revision+1,? FROM mxqr_translation_suggestions WHERE ${where}`,
      )
      .bind(crypto.randomUUID(), now, ...binds),
    db
      .prepare(
        `UPDATE mxqr_translation_suggestions SET status = 'withdrawn', approved_at = NULL, revision = revision+1, updated_at = ? WHERE ${where}`,
      )
      .bind(now, ...binds),
  ]);
  const after = await find(db, id, session.accountId);
  if (after.status !== 'withdrawn') fail('REVISION_CONFLICT', 409);
  return json({ suggestion: await dto(after, env, session.accountId) });
}
async function review(request: Request, env: unknown, db: Database, id: string): Promise<Response> {
  const body = await readTranslationRequest(request);
  if (
    typeof body.status !== 'string' ||
    !['pending', 'approved', 'rejected'].includes(body.status) ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 1
  )
    fail('INVALID_REQUEST');
  const before = await find(db, id, null);
  if (before.status === 'withdrawn') fail('SUGGESTION_CLOSED', 409);
  if (before.revision !== body.expectedRevision) fail('REVISION_CONFLICT', 409);
  const display = await dto(before, env, null);
  if (body.status === 'approved' && display.outdated && !display.applied)
    fail('SOURCE_CHANGED', 409);
  if (before.status === body.status) return json({ suggestion: display });
  const now = Date.now();
  const condition = `EXISTS (SELECT 1 FROM mxqr_translation_suggestions target JOIN mxqr_accounts account ON account.account_id = target.account_id WHERE target.suggestion_id = ? AND target.revision = ? AND target.status <> 'withdrawn' AND account.status = 'active' AND NOT EXISTS (SELECT 1 FROM mxqr_account_deletions d WHERE d.account_id = account.account_id))`;
  const exact: SqlValue[] = [id, before.revision];
  const statements: Statement[] = [];
  if (body.status === 'approved') {
    const competing = `locale = ? AND surface = ? AND translation_key = ? AND status = 'approved' AND suggestion_id <> ? AND ${condition}`;
    const competingValues: SqlValue[] = [
      before.locale,
      before.surface,
      before.translation_key,
      id,
      ...exact,
    ];
    statements.push(
      db
        .prepare(
          `INSERT INTO mxqr_translation_reviews (review_id,suggestion_id,action,actor_kind,revision,reviewed_at) SELECT ?,suggestion_id,'superseded','admin',revision+1,? FROM mxqr_translation_suggestions WHERE ${competing}`,
        )
        .bind(crypto.randomUUID(), now, ...competingValues),
    );
    statements.push(
      db
        .prepare(
          `UPDATE mxqr_translation_suggestions SET status = 'pending', approved_at = NULL, revision = revision+1, updated_at = ? WHERE ${competing}`,
        )
        .bind(now, ...competingValues),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO mxqr_translation_reviews (review_id,suggestion_id,action,actor_kind,revision,reviewed_at) SELECT ?,suggestion_id,?,'admin',revision+1,? FROM mxqr_translation_suggestions WHERE suggestion_id = ? AND ${condition}`,
      )
      .bind(crypto.randomUUID(), String(body.status), now, id, ...exact),
  );
  statements.push(
    db
      .prepare(
        `UPDATE mxqr_translation_suggestions SET status = ?, approved_at = ?, revision = revision+1, updated_at = ? WHERE suggestion_id = ? AND ${condition}`,
      )
      .bind(String(body.status), body.status === 'approved' ? now : null, now, id, ...exact),
  );
  const results = await db.batch(statements);
  const mutation = results[results.length - 1];
  if (!record(mutation) || !record(mutation.meta) || mutation.meta.changes !== 1)
    fail('REVISION_CONFLICT', 409);
  const after = await find(db, id, null);
  if (after.revision !== before.revision + 1 || after.status !== body.status)
    fail('REVISION_CONFLICT', 409);
  return json({ suggestion: await dto(after, env, null) });
}
async function exportApproved(env: unknown, db: Database): Promise<Response> {
  const query = selection(null);
  const result = await db
    .prepare(
      `${query.sql} WHERE s.status = 'approved' AND a.status = 'active' AND NOT EXISTS (SELECT 1 FROM mxqr_account_deletions d WHERE d.account_id = s.account_id) ORDER BY s.locale,s.surface,s.translation_key LIMIT 1001`,
    )
    .bind(...query.values)
    .all();
  if ((result.results?.length ?? 0) > 1000) fail('EXPORT_TOO_LARGE', 413);
  const output: ApprovedTranslationsExport = {
    version: 1,
    kind: 'musixquare-approved-translations',
    exportedAt: new Date().toISOString(),
    drafts: [],
  };
  let bytes = 0;
  for (const raw of result.results ?? []) {
    const value = row(raw);
    const display = await dto(value, env, null);
    if (display.applied) continue;
    if (display.outdated) fail('STALE_APPROVED_SUGGESTIONS', 409);
    const draft = {
      id: `${value.surface}:${value.translation_key}`,
      locale: value.locale,
      surface: value.surface,
      key: value.translation_key,
      sourceEn: value.source_en,
      sourceKo: value.source_ko,
      current: value.current_text,
      proposed: value.proposed_text,
      reason: value.reason,
      updatedAt: new Date(value.updated_at).toISOString(),
      suggestionId: value.suggestion_id,
      reviewRevision: value.revision,
      approvedAt: value.approved_at!,
    };
    bytes += new TextEncoder().encode(JSON.stringify(draft)).byteLength;
    if (bytes > 8 * 1024 * 1024 - 1024) fail('EXPORT_TOO_LARGE', 413);
    output.drafts.push(draft);
  }
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 8 * 1024 * 1024)
    fail('EXPORT_TOO_LARGE', 413);
  return json(output);
}
async function respond(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof TranslationFailure)
      return json(
        { error: error.code },
        error.status,
        error instanceof RateFailure
          ? { 'Retry-After': String(Math.max(1, error.retryAfter)) }
          : {},
      );
    return json({ error: 'TRANSLATIONS_UNAVAILABLE' }, 503);
  }
}
export async function handleTranslationCommunityRequest(
  request: Request,
  env: unknown,
  url = new URL(request.url),
): Promise<Response | null> {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  return respond(async () => {
    const db = database(env);
    if (url.pathname === PREFIX) {
      if (request.method === 'GET') return list(request, env, db, url, false);
      if (request.method === 'POST') return submit(request, env, db);
    } else {
      const match = /^\/api\/translations\/suggestions\/([^/]+)(\/vote)?$/u.exec(url.pathname);
      if (!match || !match[1] || !UUID.test(match[1])) fail('NOT_FOUND', 404);
      if (url.search) fail('INVALID_REQUEST');
      if (match[2] && ['PUT', 'DELETE'].includes(request.method))
        return vote(request, env, db, match[1]);
      if (!match[2] && request.method === 'DELETE') return withdraw(request, env, db, match[1]);
    }
    return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  });
}
/** Caller must apply the existing admin method/CSRF and authenticated admin-session gates first. */
export async function handleAdminTranslationCommunityRequest(
  request: Request,
  env: unknown,
  url = new URL(request.url),
): Promise<Response | null> {
  if (url.pathname !== ADMIN_PREFIX && !url.pathname.startsWith(`${ADMIN_PREFIX}/`)) return null;
  return respond(async () => {
    const db = database(env);
    if (url.pathname === ADMIN_PREFIX && request.method === 'GET')
      return list(request, env, db, url, true);
    if (url.pathname === `${ADMIN_PREFIX}/export` && request.method === 'GET') {
      if (url.search) fail('INVALID_REQUEST');
      return exportApproved(env, db);
    }
    const match = /^\/api\/admin\/translations\/([^/]+)\/review$/u.exec(url.pathname);
    if (match?.[1] && UUID.test(match[1]) && request.method === 'POST') {
      if (url.search) fail('INVALID_REQUEST');
      return review(request, env, db, match[1]);
    }
    return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  });
}

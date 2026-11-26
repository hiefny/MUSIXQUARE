/**
 * GET|HEAD /api/status: the public JSON that musixquare.com/status polls.
 *
 * Every page gets the same answer, so a body is edge-cached under a made-up key
 * that no route serves: for STATUS_EDGE_CACHE_TTL_S when the ledger, the
 * maintenance state and the status note were all read, and for
 * STATUS_EDGE_CACHE_DEGRADED_TTL_S when one of those reads failed or ran past
 * its bound, so a struggling admin D1 or note object is not asked again by
 * every request. A degraded body never replaces a body already cached. A
 * failed read never turns into a 5xx: without the ledger every row reads
 * results_unavailable, and without the note there is no announcement.
 * generatedAt is stamped with the serve time on every answer, cached bodies
 * included, and query strings are ignored.
 *
 * The ledger read is raced against STATUS_API_READ_TIMEOUT_MS, and a read
 * still running at that bound counts as failed. The maintenance and note
 * reads need no bound of their own here: the App's service-control calls
 * behind them are bounded by SERVICE_CONTROL_READ_TIMEOUT_MS in
 * cloudflare/service-maintenance.ts.
 *
 * The route sits on the maintenance bypass, which skips the gate's background
 * refresh, so the App wires readMaintenance to its own maintenance read. The
 * App's private helpers come in as dependencies, as scheduled() passes them.
 */

import {
  STATUS_API_READ_TIMEOUT_MS,
  STATUS_EDGE_CACHE_DEGRADED_TTL_S,
  STATUS_EDGE_CACHE_KEY_PATH,
  STATUS_EDGE_CACHE_TTL_S,
  STATUS_RESULT_RETENTION_MS,
  STATUS_SCHEMA_VERSION,
  type StatusCheckRow,
  type StatusPublicNote,
} from './status-contract.ts';
import { buildStatusPayload, type StatusMaintenanceInput } from './status-payload.ts';
import { readStatusChecks, type StatusD1Database } from './status-store.ts';

/** The fields of the App's maintenance read that /api/status uses. */
export interface StatusMaintenanceRead {
  readonly enabled: boolean;
  readonly controlUnavailable?: boolean | undefined;
  readonly activatedAt: number | null;
}

/** The App's read of the status note: the published note (or none), or a failed read. */
export type StatusNoteRead =
  | { readonly status: 'ok'; readonly note: StatusPublicNote | null }
  | { readonly status: 'unavailable' };

/** The part of the Workers default cache that /api/status uses. */
export interface StatusEdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface StatusApiDependencies {
  /** The App's JSON response (Cache-Control: no-store, max-age=0). */
  json(body: unknown, status?: number): Response;
  withoutBodyForHead(request: Request, response: Response): Response;
  /** The App's method check: null when allowed, else a 405 with Allow. */
  methodAllowed(request: Request, methods: string[]): Response | null;
  adminDb(): StatusD1Database | null;
  readMaintenance(): Promise<StatusMaintenanceRead>;
  readStatusNote(): Promise<StatusNoteRead>;
  edgeCache(): StatusEdgeCache | null;
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

interface StatusRead<T> {
  /**
   * Whether the source answered. A body built from three answers is cached for
   * STATUS_EDGE_CACHE_TTL_S, any other for STATUS_EDGE_CACHE_DEGRADED_TTL_S.
   */
  readonly read: boolean;
  readonly value: T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusCacheKey(request: Request): Request {
  return new Request(new URL(STATUS_EDGE_CACHE_KEY_PATH, request.url), { method: 'GET' });
}

function edgeCacheOf(deps: StatusApiDependencies): StatusEdgeCache | null {
  try {
    return deps.edgeCache();
  } catch {
    return null;
  }
}

/** A cached body, or null for a miss or an entry that is not a status body. */
async function readCachedBody(cache: StatusEdgeCache, key: Request): Promise<object | null> {
  try {
    const cached = await cache.match(key);
    if (!cached) return null;
    const body: unknown = await cached.json();
    return isRecord(body) &&
      body.schemaVersion === STATUS_SCHEMA_VERSION &&
      Array.isArray(body.components)
      ? body
      : null;
  } catch {
    // A corrupt or unreadable entry falls through to a fresh read.
    return null;
  }
}

/** The ledger when it was not read: no database, a failed read or one past its bound. */
const LEDGER_UNREAD: StatusRead<StatusCheckRow[] | null> = Object.freeze({
  read: false,
  value: null,
});

/**
 * Reads the retained rows within STATUS_API_READ_TIMEOUT_MS. Both outcomes of
 * the read are handled, so one that ends after the bound is dropped without an
 * unhandled rejection, and the timer is cleared on every path.
 */
async function readRows(
  deps: StatusApiDependencies,
  nowMs: number,
): Promise<StatusRead<StatusCheckRow[] | null>> {
  let db: StatusD1Database | null;
  try {
    db = deps.adminDb();
  } catch {
    return LEDGER_UNREAD;
  }
  if (!db) return LEDGER_UNREAD;
  const sinceMs = nowMs - STATUS_RESULT_RETENTION_MS;
  const answer = Promise.resolve(db)
    .then((ledger) => readStatusChecks(ledger, sinceMs))
    .then(
      (rows): StatusRead<StatusCheckRow[] | null> => ({ read: true, value: rows }),
      () => LEDGER_UNREAD,
    );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<StatusRead<StatusCheckRow[] | null>>((resolve) => {
    timer = setTimeout(() => resolve(LEDGER_UNREAD), STATUS_API_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function readMaintenance(
  deps: StatusApiDependencies,
): Promise<StatusRead<StatusMaintenanceInput>> {
  try {
    const state = await deps.readMaintenance();
    // A control-plane outage reads as enabled but unavailable; it is not maintenance.
    const active = state.enabled === true && state.controlUnavailable !== true;
    return { read: true, value: { active, sinceMs: active ? state.activatedAt : null } };
  } catch {
    return { read: false, value: { active: false, sinceMs: null } };
  }
}

async function readNote(deps: StatusApiDependencies): Promise<StatusRead<StatusPublicNote | null>> {
  try {
    const answer = await deps.readStatusNote();
    return answer.status === 'ok'
      ? { read: true, value: answer.note }
      : { read: false, value: null };
  } catch {
    return { read: false, value: null };
  }
}

/**
 * Stores the body for the full lifetime when every read answered, otherwise
 * for the degraded one. A degraded body is stored only while no body is
 * cached, so it never replaces one that another request stored meanwhile.
 */
async function storeBody(
  deps: StatusApiDependencies,
  cache: StatusEdgeCache,
  key: Request,
  body: object,
  complete: boolean,
): Promise<void> {
  const maxAgeSeconds = complete ? STATUS_EDGE_CACHE_TTL_S : STATUS_EDGE_CACHE_DEGRADED_TTL_S;
  const write = Promise.resolve()
    .then(async () => {
      if (!complete && (await readCachedBody(cache, key)) !== null) return;
      await cache.put(
        key,
        new Response(JSON.stringify(body), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${maxAgeSeconds}`,
          },
        }),
      );
    })
    .catch(() => undefined);
  if (typeof deps.waitUntil === 'function') deps.waitUntil(write);
  else await write;
}

/** Answers GET|HEAD /api/status; any other method gets the App's 405. */
export async function handleStatusApi(
  request: Request,
  deps: StatusApiDependencies,
): Promise<Response> {
  const methodError = deps.methodAllowed(request, ['GET', 'HEAD']);
  if (methodError) return methodError;
  const cache = edgeCacheOf(deps);
  const key = statusCacheKey(request);
  let body = cache ? await readCachedBody(cache, key) : null;
  if (body === null) {
    const nowMs = Date.now();
    const [rows, maintenance, note] = await Promise.all([
      readRows(deps, nowMs),
      readMaintenance(deps),
      readNote(deps),
    ]);
    body = buildStatusPayload({
      nowMs,
      rows: rows.value,
      maintenance: maintenance.value,
      note: note.value,
    });
    if (cache) await storeBody(deps, cache, key, body, rows.read && maintenance.read && note.read);
  }
  const served = { ...body, generatedAt: new Date(Date.now()).toISOString() };
  return deps.withoutBodyForHead(request, deps.json(served));
}

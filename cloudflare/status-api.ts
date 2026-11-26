/**
 * GET|HEAD /api/status: the public JSON that musixquare.com/status polls.
 *
 * Every page gets the same answer, so a body is edge-cached for
 * STATUS_EDGE_CACHE_TTL_S under a made-up key that no route serves, and only
 * when the ledger, the maintenance state and the status note were all read;
 * an answer built around a failed read is served once and never cached. A
 * failed read never turns into a 5xx: without the ledger every row reads
 * results_unavailable, and without the note there is no announcement.
 * generatedAt is stamped with the serve time on every answer, cached bodies
 * included, and query strings are ignored.
 *
 * The route sits on the maintenance bypass, which skips the gate's background
 * refresh, so the App wires readMaintenance to its own maintenance read. The
 * App's private helpers come in as dependencies, as scheduled() passes them.
 */

import {
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
  /** Whether the source answered; only a body built from three answers is cached. */
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

async function readRows(
  deps: StatusApiDependencies,
  nowMs: number,
): Promise<StatusRead<StatusCheckRow[] | null>> {
  try {
    const db = deps.adminDb();
    if (!db) return { read: false, value: null };
    return { read: true, value: await readStatusChecks(db, nowMs - STATUS_RESULT_RETENTION_MS) };
  } catch {
    return { read: false, value: null };
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

async function storeBody(
  deps: StatusApiDependencies,
  cache: StatusEdgeCache,
  key: Request,
  body: object,
): Promise<void> {
  const write = Promise.resolve()
    .then(() =>
      cache.put(
        key,
        new Response(JSON.stringify(body), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${STATUS_EDGE_CACHE_TTL_S}`,
          },
        }),
      ),
    )
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
    if (cache && rows.read && maintenance.read && note.read) {
      await storeBody(deps, cache, key, body);
    }
  }
  const served = { ...body, generatedAt: new Date(Date.now()).toISOString() };
  return deps.withoutBodyForHead(request, deps.json(served));
}

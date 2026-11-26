import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import appWorker from '../../../cloudflare/app-worker.ts';
import {
  GITHUB_ACTIONS_OIDC_ISSUER,
  GITHUB_ACTIONS_OIDC_JWKS_URL,
  resetGitHubActionsOidcCacheForTests,
} from '../../../cloudflare/github-actions-oidc.ts';
import {
  SERVICE_CONTROL_OBJECT_NAME,
  SERVICE_CONTROL_STATE_PATH,
  clearServiceMaintenanceCacheForTests,
} from '../../../cloudflare/service-maintenance.ts';
import {
  STATUS_CLAIM_AUDIENCE,
  STATUS_CLAIM_PATH,
  STATUS_EDGE_CACHE_KEY_PATH,
  STATUS_MONITOR_WORKFLOW_REF,
  STATUS_PRO_PROBE_ROOM_CODE,
  STATUS_PROBE_CLAIM_INTERNAL_PATH,
  STATUS_PUBLIC_PATH,
  STATUS_REPORT_AUDIENCE,
  STATUS_REPORT_PATH,
  STATUS_RESULT_RETENTION_MS,
  STATUS_SERVER_CRON,
} from '../../../cloudflare/status-contract.ts';
import { createAtomicRateControlBinding } from './service-control-rate-limit-fixture.ts';

// The App Worker's /status wiring end to end: GET /api/status, the status cron
// and the browser monitor's report, over a node:sqlite ledger with the real
// admin metrics schema, the real service-control object, a fake signaling
// namespace and a fake PRO front door. Room codes here are random test codes.

const ORIGIN = 'https://musixquare.com';
const ADMIN_SCHEMA = readFileSync(
  new URL('../../../cloudflare/admin-metrics.schema.sql', import.meta.url),
  'utf8',
);
const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const SERVED_BUILD = 845;
const BRIDGE_OBJECT_PREFIX = 'mxqr-standard-http-bridge-v1:';
const SIX_DIGIT_RE = /\b[1-9]\d{5}\b/u;

type SqlValue = string | number | null;
type JsonObject = Record<string, unknown>;

const openDatabases = new Set<DatabaseSync>();

afterEach(() => {
  clearServiceMaintenanceCacheForTests();
  resetGitHubActionsOidcCacheForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of openDatabases) database.close();
  openDatabases.clear();
});

function useDateClock(iso: string) {
  // Only Date is fake: the checks' deadline and the control reads keep real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

function at(iso: string): number {
  return Date.parse(iso);
}

// ── The ledger: a D1 binding over node:sqlite with the admin metrics schema ──

class LedgerStatement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    readonly values: readonly SqlValue[] = [],
    private readonly failReads: () => boolean = () => false,
  ) {}

  bind(...values: SqlValue[]) {
    return new LedgerStatement(this.database, this.sql, values, this.failReads);
  }

  async first() {
    return (this.database.prepare(this.sql).get(...this.values) as JsonObject | undefined) ?? null;
  }

  async all() {
    if (this.failReads()) throw new Error('D1_ERROR: simulated read failure');
    return { success: true, results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    return this.runNow();
  }

  runNow() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

interface BatchHold {
  readonly matches: (statements: readonly LedgerStatement[]) => boolean;
  readonly gate: Promise<void>;
  readonly markReached: () => void;
}

function createLedger() {
  const database = new sqlite.DatabaseSync(':memory:');
  openDatabases.add(database);
  database.exec(ADMIN_SCHEMA);
  const statements: string[] = [];
  const holds: BatchHold[] = [];
  let failReads = false;
  const binding = {
    prepare: vi.fn((sql: string) => {
      statements.push(sql);
      return new LedgerStatement(database, sql, [], () => failReads);
    }),
    batch: vi.fn(async (batch: LedgerStatement[]) => {
      const index = holds.findIndex((hold) => hold.matches(batch));
      const hold = index >= 0 ? holds.splice(index, 1)[0] : undefined;
      if (hold) {
        hold.markReached();
        await hold.gate;
      }
      // Synchronous inside one transaction, as D1 runs a batch.
      database.exec('BEGIN');
      try {
        const results = batch.map((statement) => statement.runNow());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }),
  };
  return {
    binding,
    database,
    /** SQL of every prepared statement that touched the status ledger. */
    ledgerStatements: () => statements.filter((sql) => sql.includes('mxqr_status_checks')),
    ledgerReads: () => statements.filter((sql) => /^SELECT[\s\S]+mxqr_status_checks/u.test(sql)),
    failReads(value: boolean) {
      failReads = value;
    },
    /** Holds the next batch that matches until release(); reached resolves when it arrives. */
    hold(matches: (bound: readonly (readonly SqlValue[])[]) => boolean) {
      let release!: () => void;
      let markReached!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      holds.push({
        matches: (batch) => matches(batch.map((statement) => statement.values)),
        gate,
        markReached,
      });
      return { reached, release };
    },
    rows() {
      return database
        .prepare(
          `SELECT component, slot_at, result, reason, checked_at, source, run_id
             FROM mxqr_status_checks
            ORDER BY slot_at, component`,
        )
        .all()
        .map((row) => ({ ...row }));
    },
    insert(row: {
      component: string;
      slotAt: number;
      result: string;
      reason: string;
      checkedAt: number;
      source: string;
      runId: string | null;
    }) {
      database
        .prepare(
          `INSERT INTO mxqr_status_checks
             (component, slot_at, result, reason, checked_at, source, run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.component,
          row.slotAt,
          row.result,
          row.reason,
          row.checkedAt,
          row.source,
          row.runId,
        );
    },
  };
}

type Ledger = ReturnType<typeof createLedger>;

// ── Signaling: the room objects' claim route and the HTTP bridge objects ──

interface BridgeSession {
  readonly roomId: string;
  readonly role: 'host' | 'guest';
  readonly peerId: string;
  readonly frames: string[];
  closed: boolean;
}

function createSignalingRooms(options: { claimAnswer?: () => Response } = {}) {
  const log: string[] = [];
  const claims: Array<{ objectName: string; body: unknown; contentType: string | null }> = [];
  const sent: Array<{ role: string; roomId: string; frame: JsonObject }> = [];
  const claimed = new Set<string>();
  const sessions = new Map<string, BridgeSession>();
  let unclaimedHostAuths = 0;
  let polls = 0;

  const deliver = (roomId: string, role: 'host' | 'guest', frame: JsonObject) => {
    for (const session of sessions.values()) {
      if (session.roomId === roomId && session.role === role && !session.closed) {
        session.frames.push(JSON.stringify(frame));
      }
    }
  };
  const peerOf = (roomId: string, role: 'host' | 'guest') =>
    [...sessions.values()].find((entry) => entry.roomId === roomId && entry.role === role)
      ?.peerId ?? '';

  const room = async (objectName: string, request: Request) => {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== STATUS_PROBE_CLAIM_INTERNAL_PATH) {
      return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    claims.push({
      objectName,
      body: await request.json(),
      contentType: request.headers.get('Content-Type'),
    });
    log.push('claim');
    const answer = options.claimAnswer?.() ?? Response.json({ ok: true });
    if (answer.status === 200) claimed.add(objectName);
    return answer;
  };

  const bridge = async (request: Request) => {
    const operation = new URL(request.url).pathname.split('/').at(-1);
    const body = (await request.json()) as JsonObject & {
      sessionId: string;
      roomId: string;
      role: 'host' | 'guest';
      peerId: string;
      request?: JsonObject;
    };
    if (operation === 'open') {
      sessions.set(body.sessionId, {
        roomId: body.roomId,
        role: body.role,
        peerId: body.peerId,
        frames: [],
        closed: false,
      });
      log.push(`open ${body.role}`);
      return Response.json({ ok: true });
    }
    const session = sessions.get(body.sessionId);
    if (!session) return Response.json({ error: 'STANDARD_HTTP_BRIDGE_GONE' }, { status: 410 });
    if (operation === 'close') {
      session.closed = true;
      log.push(`close ${session.role}`);
      return Response.json({ ok: true });
    }
    if (operation === 'poll') {
      polls += 1;
      const ack = Number(body.request?.ack);
      return Response.json({
        v: 1,
        events: session.frames.slice(ack).map((data, index) => ({ sseq: ack + index + 1, data })),
      });
    }
    const frame = JSON.parse(String(body.request?.frame)) as JsonObject;
    sent.push({ role: session.role, roomId: session.roomId, frame });
    log.push(`send ${session.role} ${String(frame.type)}`);
    const { roomId } = session;
    if (frame.type === 'host-auth') {
      if (!claimed.has(roomId)) unclaimedHostAuths += 1;
      deliver(roomId, 'host', {
        type: 'peer-open',
        roomId,
        peerId: session.peerId,
        roomPasswordApplied: true,
      });
    } else if (frame.type === 'room-password-set') {
      deliver(roomId, 'host', {
        type: 'room-password-result',
        mutationId: frame.pinMutationId,
        applied: true,
      });
    } else if (frame.type === 'guest-auth') {
      deliver(roomId, 'guest', { type: 'peer-open', roomId, peerId: session.peerId });
    } else if (frame.type === 'signal-offer') {
      deliver(roomId, 'host', { ...frame, to: undefined, from: session.peerId });
    } else if (frame.type === 'signal-answer') {
      deliver(roomId, 'guest', { ...frame, to: undefined, from: peerOf(roomId, 'host') });
    }
    return Response.json({ v: 1, ack: body.request?.cseq });
  };

  return {
    namespace: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn((id: string) => ({
        fetch: (request: Request) =>
          id.startsWith(BRIDGE_OBJECT_PREFIX) ? bridge(request) : room(id, request),
      })),
    },
    log,
    claims,
    sent,
    unclaimedHostAuths: () => unclaimedHostAuths,
    polls: () => polls,
  };
}

type SignalingRooms = ReturnType<typeof createSignalingRooms>;

function createProApi(answer: () => Response = () => proAnswer('activation_required')) {
  const requests: Request[] = [];
  return {
    requests,
    binding: {
      fetch: vi.fn(async (request: Request) => {
        requests.push(request);
        return answer();
      }),
    },
  };
}

function proAnswer(status: string) {
  return Response.json({ roomCode: STATUS_PRO_PROBE_ROOM_CODE, status, passwordRequired: false });
}

function createAssets() {
  return {
    fetch: vi.fn(async (request: Request) =>
      new URL(request.url).pathname === '/service-worker.js'
        ? new Response(`const CACHE_VERSION = 'v${SERVED_BUILD}';`)
        : new Response('Not found', { status: 404 }),
    ),
  };
}

function createContext() {
  const waits: Promise<unknown>[] = [];
  const context = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      waits.push(Promise.resolve(promise).catch(() => undefined));
    }),
  };
  const settle = async () => {
    for (let drained = 0; drained < waits.length;) {
      const batch = waits.slice(drained);
      drained = waits.length;
      await Promise.all(batch);
    }
  };
  return { context, settle };
}

type ServiceControlBinding = ReturnType<typeof createAtomicRateControlBinding>['binding'];

interface StatusEnvOptions {
  readonly ledger?: Ledger | null;
  readonly signaling?: SignalingRooms;
  readonly pro?: ReturnType<typeof createProApi>;
  readonly control?: ServiceControlBinding | null;
}

function statusEnv(options: StatusEnvOptions = {}) {
  const ledger = options.ledger === undefined ? createLedger() : options.ledger;
  const signaling = options.signaling ?? createSignalingRooms();
  const pro = options.pro ?? createProApi();
  const control =
    options.control === undefined ? createAtomicRateControlBinding().binding : options.control;
  const assets = createAssets();
  const env = {
    ASSETS: assets,
    PRO_SIGNALING_ROOMS: signaling.namespace,
    PRO_ROOM_PUBLIC_API: pro.binding,
    ...(ledger ? { MUSIXQUARE_ADMIN_DB: ledger.binding } : {}),
    ...(control ? { MUSIXQUARE_SERVICE_CONTROL: control } : {}),
  };
  return { env, ledger, signaling, pro, assets };
}

async function enableMaintenance(control: ServiceControlBinding) {
  const response = await control.get(control.idFromName(SERVICE_CONTROL_OBJECT_NAME)).fetch(
    new Request(`https://service-control.internal${SERVICE_CONTROL_STATE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        expectedRevision: 0,
        requestId: '123e4567-e89b-42d3-a456-426614174301',
      }),
    }),
  );
  expect(response.status).toBe(200);
}

async function runStatusCron(env: Record<string, unknown>, scheduledTime: number) {
  const { context, settle } = createContext();
  await appWorker.scheduled({ cron: STATUS_SERVER_CRON, scheduledTime }, env, context);
  await settle();
  return context;
}

async function statusApi(env: Record<string, unknown>, init: RequestInit & { path?: string } = {}) {
  const { context, settle } = createContext();
  const response = await appWorker.fetch(
    new Request(`${ORIGIN}${init.path ?? STATUS_PUBLIC_PATH}`, init),
    env,
    context,
  );
  await settle();
  return { response, context };
}

/** A Cache API stand-in that honours the stored entry's max-age by Date. */
function installEdgeCache() {
  const entries = new Map<
    string,
    { body: string; headers: Headers; storedAt: number; maxAgeMs: number }
  >();
  const cache = {
    match: vi.fn(async (request: Request) => {
      const entry = entries.get(request.url);
      if (!entry || Date.now() - entry.storedAt >= entry.maxAgeMs) return undefined;
      return new Response(entry.body, { headers: entry.headers });
    }),
    put: vi.fn(async (request: Request, response: Response) => {
      const maxAge = /max-age=(\d+)/u.exec(response.headers.get('Cache-Control') || '');
      entries.set(request.url, {
        body: await response.text(),
        headers: new Headers(response.headers),
        storedAt: Date.now(),
        maxAgeMs: maxAge ? Number(maxAge[1]) * 1_000 : 0,
      });
    }),
  };
  vi.stubGlobal('caches', { default: cache });
  return { cache, entries, key: `${ORIGIN}${STATUS_EDGE_CACHE_KEY_PATH}` };
}

function quietConsole() {
  return {
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
  };
}

// ── GitHub OIDC tokens of the browser monitor (helpers as in status-ops.test.ts) ──

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JsonWebKey & { kid: string };
}

async function createSigningKey(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kty: 'RSA', n: exported.n, e: exported.e, alg: 'RS256', use: 'sig', kid },
  };
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function signToken(key: SigningKey, claims: JsonObject): Promise<string> {
  const head = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid }));
  const body = base64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
}

/** The monitor job on main names no environment, so its token has no environment claim. */
function monitorClaims(
  runId: string,
  eventName: string,
  audience: string = STATUS_REPORT_AUDIENCE,
): JsonObject {
  const now = Math.floor(Date.now() / 1_000);
  return {
    jti: `5f0c4e1e-0000-4000-8000-00000000${runId.padStart(4, '0').slice(-4)}`,
    sub: 'repo:hiefny/MUSIXQUARE:ref:refs/heads/main',
    aud: audience,
    ref: 'refs/heads/main',
    sha: 'a'.repeat(40),
    repository: 'hiefny/MUSIXQUARE',
    repository_owner: 'hiefny',
    repository_owner_id: '257024056',
    repository_id: '1141408724',
    repository_visibility: 'public',
    run_id: runId,
    run_number: '7',
    run_attempt: '1',
    actor: 'hiefny',
    actor_id: '257024056',
    workflow: 'Status monitor',
    event_name: eventName,
    ref_type: 'branch',
    ref_protected: 'true',
    workflow_ref: STATUS_MONITOR_WORKFLOW_REF,
    workflow_sha: 'a'.repeat(40),
    runner_environment: 'github-hosted',
    iss: GITHUB_ACTIONS_OIDC_ISSUER,
    nbf: now - 5,
    iat: now,
    exp: now + 300,
  };
}

function installJwks(key: SigningKey) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== GITHUB_ACTIONS_OIDC_JWKS_URL) throw new Error('Unexpected outbound fetch');
    return Response.json({ keys: [key.jwk] }, { headers: { 'Cache-Control': 'max-age=3600' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function postReport(
  env: Record<string, unknown>,
  key: SigningKey,
  input: {
    runId: string;
    eventName?: string;
    startedAt: string;
    website: [string, string];
    connection: [string, string];
  },
) {
  const token = await signToken(key, monitorClaims(input.runId, input.eventName ?? 'schedule'));
  const { context, settle } = createContext();
  const response = await appWorker.fetch(
    new Request(`${ORIGIN}${STATUS_REPORT_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.57',
      },
      body: JSON.stringify({
        v: 1,
        startedAt: input.startedAt,
        results: {
          website: { outcome: input.website[0], reason: input.website[1] },
          connection: { outcome: input.connection[0], reason: input.connection[1] },
        },
      }),
    }),
    env,
    context,
  );
  await settle();
  return response;
}

/** A POST to an ops route, signed for its audience unless the token is left out. */
async function postOps(
  env: Record<string, unknown>,
  path: string,
  body: string,
  token: string | null,
  ip = '203.0.113.58',
) {
  return appWorker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        'Content-Type': 'application/json',
        'CF-Connecting-IP': ip,
      },
      body,
    }),
    env,
  );
}

describe('App Worker /api/status', () => {
  it('builds the page JSON from the ledger, edge-caches it for 30 s and restamps generatedAt', async () => {
    useDateClock('2026-11-26T05:50:00.000Z');
    const edge = installEdgeCache();
    const { env, ledger } = statusEnv();
    for (const [component, slot, checked] of [
      ['website', '2026-11-26T05:37:00.000Z', '2026-11-26T05:38:10.000Z'],
      ['connection', '2026-11-26T05:37:00.000Z', '2026-11-26T05:38:40.000Z'],
      ['rooms', '2026-11-26T05:45:00.000Z', '2026-11-26T05:45:06.000Z'],
      ['pro', '2026-11-26T05:45:00.000Z', '2026-11-26T05:45:02.000Z'],
    ] as const) {
      ledger!.insert({
        component,
        slotAt: at(slot),
        result: 'o',
        reason: 'passing',
        checkedAt: at(checked),
        source: component === 'rooms' || component === 'pro' ? 'cron' : 'browser',
        runId: component === 'rooms' || component === 'pro' ? null : '9000000001',
      });
    }

    const first = await statusApi(env);
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(first.response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const body = (await first.response.json()) as JsonObject & {
      components: Array<JsonObject & { id: string }>;
    };
    expect(body).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-11-26T05:50:00.000Z',
      timeZone: 'UTC',
      policy: {
        checkIntervalMinutes: 15,
        problemAfterFailures: 2,
        staleAfterMinutes: 30,
        recentSlots: 96,
        schedule: { server: [0, 15, 30, 45], browser: [7, 22, 37, 52] },
      },
      overall: {
        state: 'ok',
        reason: 'all_passing',
        lastCheckedAt: '2026-11-26T05:45:06.000Z',
        since: null,
      },
      maintenance: { active: false, since: null },
      announcement: null,
    });
    expect(body.components.map((component) => component.id)).toEqual([
      'website',
      'rooms',
      'connection',
      'pro',
    ]);
    expect(body.components[1]).toEqual({
      id: 'rooms',
      state: 'ok',
      reason: 'passing',
      lastCheckedAt: '2026-11-26T05:45:06.000Z',
      lastOkAt: '2026-11-26T05:45:06.000Z',
      problemSince: null,
      recent: { lastAt: '2026-11-26T05:45:00.000Z', slots: 'o' },
    });
    expect(body.components[0]).toMatchObject({
      recent: { lastAt: '2026-11-26T05:37:00.000Z', slots: 'o' },
    });
    // Stored once every read succeeded, under the made-up key, through
    // waitUntil (beside the shared maintenance read the route makes itself).
    expect(first.context.waitUntil).toHaveBeenCalledTimes(2);
    expect(edge.cache.put).toHaveBeenCalledOnce();
    expect([...edge.entries.keys()]).toEqual([edge.key]);
    expect(ledger!.ledgerReads()).toHaveLength(1);

    // Cached: no ledger read, the query string ignored, generatedAt restamped.
    vi.setSystemTime(new Date('2026-11-26T05:50:20.000Z'));
    const cached = await statusApi(env, { path: `${STATUS_PUBLIC_PATH}?fixture=problem` });
    const cachedBody = (await cached.response.json()) as JsonObject;
    expect(cachedBody.generatedAt).toBe('2026-11-26T05:50:20.000Z');
    expect({ ...cachedBody, generatedAt: body.generatedAt }).toEqual(body);
    expect(ledger!.ledgerReads()).toHaveLength(1);
    expect(edge.cache.put).toHaveBeenCalledOnce();

    const head = await statusApi(env, { method: 'HEAD' });
    expect(head.response.status).toBe(200);
    expect(await head.response.text()).toBe('');

    const post = await statusApi(env, { method: 'POST', body: '{}' });
    expect(post.response.status).toBe(405);
    expect(post.response.headers.get('Allow')).toBe('GET, HEAD');
    await expect(post.response.json()).resolves.toEqual({ error: 'METHOD_NOT_ALLOWED' });

    // After the 30 s lifetime the ledger is read again.
    vi.setSystemTime(new Date('2026-11-26T05:50:31.000Z'));
    const expired = await statusApi(env);
    expect(expired.response.status).toBe(200);
    expect(ledger!.ledgerReads()).toHaveLength(2);
    expect(edge.cache.put).toHaveBeenCalledTimes(2);
  });

  it('answers 200 with results_unavailable when the ledger cannot be read, and never caches it', async () => {
    useDateClock('2026-11-26T05:50:00.000Z');
    const edge = installEdgeCache();
    const { env, ledger } = statusEnv();
    ledger!.failReads(true);

    for (let request = 0; request < 2; request += 1) {
      const { response } = await statusApi(env);
      expect(response.status).toBe(200);
      const body = (await response.json()) as JsonObject & {
        components: JsonObject[];
      };
      expect(body.overall).toEqual({
        state: 'stale',
        reason: 'results_unavailable',
        lastCheckedAt: null,
        since: null,
      });
      expect(body.maintenance).toEqual({ active: false, since: null });
      for (const component of body.components) {
        expect(component).toMatchObject({
          state: 'stale',
          reason: 'results_unavailable',
          lastCheckedAt: null,
          lastOkAt: null,
          problemSince: null,
          recent: null,
        });
      }
    }
    expect(edge.cache.put).not.toHaveBeenCalled();
    expect(ledger!.ledgerReads()).toHaveLength(2);

    // Without the admin database it is the same answer.
    const unbound = statusEnv({ ledger: null });
    const { response } = await statusApi(unbound.env);
    await expect(response.json()).resolves.toMatchObject({
      overall: { state: 'stale', reason: 'results_unavailable' },
    });
    expect(edge.cache.put).not.toHaveBeenCalled();
  });
});

describe('App Worker status cron', () => {
  it('claims a code before host-auth, runs both checks, closes both sessions and records the server slot', async () => {
    useDateClock('2026-11-26T05:45:01.000Z');
    const logs = quietConsole();
    const { env, ledger, signaling, pro, assets } = statusEnv();
    // A result older than 48 hours goes; one inside the window stays.
    ledger!.insert({
      component: 'rooms',
      slotAt: at('2026-11-26T05:45:00.000Z') - STATUS_RESULT_RETENTION_MS - 15 * 60_000,
      result: 'o',
      reason: 'passing',
      checkedAt: at('2026-11-24T05:30:05.000Z'),
      source: 'cron',
      runId: null,
    });
    ledger!.insert({
      component: 'pro',
      slotAt: at('2026-11-24T06:00:00.000Z'),
      result: 'o',
      reason: 'passing',
      checkedAt: at('2026-11-24T06:00:03.000Z'),
      source: 'cron',
      runId: null,
    });

    const context = await runStatusCron(env, at('2026-11-26T05:45:00.000Z') + 412);

    const slotAt = at('2026-11-26T05:45:00.000Z');
    expect(ledger!.rows()).toEqual([
      {
        component: 'pro',
        slot_at: at('2026-11-24T06:00:00.000Z'),
        result: 'o',
        reason: 'passing',
        checked_at: at('2026-11-24T06:00:03.000Z'),
        source: 'cron',
        run_id: null,
      },
      {
        component: 'pro',
        slot_at: slotAt,
        result: 'o',
        reason: 'passing',
        checked_at: at('2026-11-26T05:45:01.000Z'),
        source: 'cron',
        run_id: null,
      },
      {
        component: 'rooms',
        slot_at: slotAt,
        result: 'o',
        reason: 'passing',
        checked_at: at('2026-11-26T05:45:01.000Z'),
        source: 'cron',
        run_id: null,
      },
    ]);

    // The claim reached the code's own room object before any host frame.
    expect(signaling.log).toEqual([
      'claim',
      'open host',
      'send host host-auth',
      'send host room-password-set',
      'open guest',
      'send guest guest-auth',
      'send guest signal-offer',
      'send host signal-answer',
      'close guest',
      'close host',
    ]);
    expect(signaling.unclaimedHostAuths()).toBe(0);
    const [claim] = signaling.claims;
    expect(claim?.contentType).toBe('application/json');
    expect(claim?.objectName).toMatch(/^[1-9]\d{5}$/u);
    expect(claim?.body).toEqual({ v: 1, roomId: claim?.objectName });
    expect(new Set(signaling.sent.map((entry) => entry.roomId))).toEqual(
      new Set([claim?.objectName]),
    );
    const hostAuth = signaling.sent.find((entry) => entry.frame.type === 'host-auth')?.frame;
    expect(hostAuth).toMatchObject({ appBuild: SERVED_BUILD, desiredRoomPassword: '' });
    expect(signaling.sent.find((entry) => entry.frame.type === 'guest-auth')?.frame).toMatchObject({
      appBuild: SERVED_BUILD,
      password: '',
    });
    // The shared maintenance read, and both closes, so a late one outlives scheduled().
    expect(context.waitUntil).toHaveBeenCalledTimes(3);
    expect(assets.fetch).toHaveBeenCalledOnce();

    // The PRO entrance: a read-only bootstrap of the canary as the served build.
    expect(pro.requests).toHaveLength(1);
    const [bootstrap] = pro.requests;
    expect(bootstrap?.method).toBe('GET');
    expect(bootstrap?.url).toBe(
      `https://pro-room.internal/v1/rooms/${STATUS_PRO_PROBE_ROOM_CODE}/bootstrap`,
    );
    expect(Object.fromEntries(bootstrap?.headers ?? [])).toEqual({
      accept: 'application/json',
      origin: ORIGIN,
      'x-mxqr-app-build': String(SERVED_BUILD),
      'x-mxqr-pro-entry-policy': 'optional-v1',
    });
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it('opens no room and records nothing for rooms when signaling has no claim route', async () => {
    useDateClock('2026-11-26T06:00:02.000Z');
    const logs = quietConsole();
    const signaling = createSignalingRooms({
      claimAnswer: () => Response.json({ error: 'NOT_FOUND' }, { status: 404 }),
    });
    const { env, ledger } = statusEnv({ signaling });

    await runStatusCron(env, at('2026-11-26T06:00:00.000Z'));

    expect(signaling.log).toEqual(['claim']);
    expect(ledger!.rows()).toEqual([
      expect.objectContaining({ component: 'pro', result: 'o', reason: 'passing' }),
    ]);
    expect(logs.warn).toHaveBeenCalledWith({
      diagnostic: 'status_checks',
      event: 'status_probe_unsupported',
      component: 'rooms',
    });
    // Diagnostics carry fixed names only: never the claimed code.
    const claimedCode = signaling.claims[0]?.objectName ?? '';
    const printed = JSON.stringify([...logs.warn.mock.calls, ...logs.error.mock.calls]);
    expect(claimedCode).toMatch(/^[1-9]\d{5}$/u);
    expect(printed).not.toContain(claimedCode);
    expect(SIX_DIGIT_RE.test(printed)).toBe(false);
  });

  it.each([
    ['no cron', {}, 3],
    ['the six-hour cron', { cron: '0 */6 * * *' }, 3],
    ['the minute cron', { cron: '* * * * *' }, 0],
    ['a look-alike quarter-hour cron', { cron: '*/15 * * * *' }, 0],
    ['a scheduled time without a cron', { scheduledTime: Date.parse('2026-11-26T06:15:00Z') }, 3],
  ] as const)('never reaches the status checks on %s', async (_label, event, waits) => {
    useDateClock('2026-11-26T06:15:01.000Z');
    quietConsole();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    // The pinned scheduled-maintenance shape plus every status binding.
    const { env, ledger, signaling, pro, assets } = statusEnv({ control: null });
    const store = new Map<string, string>();
    const scheduledEnv = {
      ...env,
      SORO_RSS_BACKUP: {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => {
          store.set(key, value);
        }),
      },
    };
    const { context, settle } = createContext();

    await appWorker.scheduled(event, scheduledEnv, context);
    await settle();

    expect(context.waitUntil).toHaveBeenCalledTimes(waits);
    expect(signaling.log).toEqual([]);
    expect(signaling.namespace.get).not.toHaveBeenCalled();
    expect(pro.binding.fetch).not.toHaveBeenCalled();
    expect(assets.fetch).not.toHaveBeenCalled();
    expect(ledger!.ledgerStatements()).toEqual([]);
    expect(ledger!.rows()).toEqual([]);
  });

  it('records maintenance marks and claims, opens and reads nothing while maintenance is on', async () => {
    useDateClock('2026-11-26T06:30:01.000Z');
    const control = createAtomicRateControlBinding().binding;
    await enableMaintenance(control);
    const { env, ledger, signaling, pro, assets } = statusEnv({ control });

    await runStatusCron(env, at('2026-11-26T06:30:00.000Z'));

    expect(ledger!.rows()).toEqual(
      ['pro', 'rooms'].map((component) => ({
        component,
        slot_at: at('2026-11-26T06:30:00.000Z'),
        result: 'm',
        reason: 'maintenance',
        checked_at: at('2026-11-26T06:30:01.000Z'),
        source: 'cron',
        run_id: null,
      })),
    );
    expect(signaling.namespace.get).not.toHaveBeenCalled();
    expect(pro.binding.fetch).not.toHaveBeenCalled();
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it('runs both checks during a control-plane outage, which is not maintenance', async () => {
    useDateClock('2026-11-26T06:45:01.000Z');
    quietConsole();
    const rateControl = createAtomicRateControlBinding().binding;
    const control = {
      idFromName: (name: string) => rateControl.idFromName(name),
      get: (id: string) =>
        id === SERVICE_CONTROL_OBJECT_NAME
          ? { fetch: async () => new Response(null, { status: 503 }) }
          : rateControl.get(id),
    };
    const { env, ledger, signaling, pro } = statusEnv({ control });

    await runStatusCron(env, at('2026-11-26T06:45:00.000Z'));

    expect(ledger!.rows()).toEqual([
      expect.objectContaining({ component: 'pro', result: 'o', reason: 'passing' }),
      expect.objectContaining({ component: 'rooms', result: 'o', reason: 'passing' }),
    ]);
    expect(signaling.log[0]).toBe('claim');
    expect(pro.requests).toHaveLength(1);
  });

  it('does nothing at all without the admin database', async () => {
    useDateClock('2026-11-26T07:00:01.000Z');
    const { env, signaling, pro, assets } = statusEnv({ ledger: null, control: null });

    const context = await runStatusCron(env, at('2026-11-26T07:00:00.000Z'));

    expect(signaling.namespace.get).not.toHaveBeenCalled();
    expect(pro.binding.fetch).not.toHaveBeenCalled();
    expect(assets.fetch).not.toHaveBeenCalled();
    expect(context.waitUntil).not.toHaveBeenCalled();
  });

  it('checks only PRO without the signaling binding, in the slot of the run without a scheduled time', async () => {
    useDateClock('2026-11-26T07:31:10.000Z');
    const logs = quietConsole();
    const { env, ledger, pro } = statusEnv();
    const { context, settle } = createContext();

    await appWorker.scheduled(
      { cron: STATUS_SERVER_CRON },
      { ...env, PRO_SIGNALING_ROOMS: undefined },
      context,
    );
    await settle();

    expect(ledger!.rows()).toEqual([
      expect.objectContaining({
        component: 'pro',
        slot_at: at('2026-11-26T07:30:00.000Z'),
        result: 'o',
      }),
    ]);
    expect(pro.requests).toHaveLength(1);
    expect(logs.warn).toHaveBeenCalledWith({
      diagnostic: 'status_checks',
      event: 'status_bridge_unavailable',
      component: 'rooms',
    });
  });

  it('retries an unreachable PRO front door once after the pause, then records the failure', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-26T07:15:01.000Z'));
    const logs = quietConsole();
    const { env, ledger, signaling } = statusEnv();
    const run = runStatusCron(
      { ...env, PRO_ROOM_PUBLIC_API: undefined },
      at('2026-11-26T07:15:00.000Z'),
    );
    await vi.waitFor(() =>
      expect(logs.warn).toHaveBeenCalledWith({
        diagnostic: 'status_checks',
        event: 'status_check_retry',
        component: 'pro',
        reason: 'pro_unreachable',
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await run;

    const [proRow, roomsRow] = ledger!.rows();
    expect(proRow).toMatchObject({ component: 'pro', result: 'p', reason: 'pro_unreachable' });
    expect(roomsRow).toMatchObject({ component: 'rooms', result: 'o', reason: 'passing' });
    // The pro row waited out the pause (waitFor moves the fake clock too); the
    // rooms row did not wait for it.
    expect(Number(proRow?.checked_at) - Number(roomsRow?.checked_at)).toBeGreaterThanOrEqual(2_000);
    expect(signaling.log.filter((entry) => entry === 'claim')).toHaveLength(1);
    expect(logs.warn).toHaveBeenCalledWith({
      diagnostic: 'status_checks',
      event: 'status_check_failed',
      component: 'pro',
      reason: 'pro_unreachable',
    });
  });
});

describe('App Worker status ops routes', () => {
  it('claims a code on its signaling room object for the monitor, after the token', async () => {
    useDateClock('2026-11-26T05:37:05.000Z');
    const key = await createSigningKey('status-monitor-claim-key');
    installJwks(key);
    let answer = () => Response.json({ ok: true });
    const signaling = createSignalingRooms({ claimAnswer: () => answer() });
    const { env } = statusEnv({ signaling });
    const token = await signToken(
      key,
      monitorClaims('9000000201', 'schedule', STATUS_CLAIM_AUDIENCE),
    );
    // Synthetic Standard room code.
    const body = JSON.stringify({ v: 1, roomId: '123456' });

    // A report token is not a claim token.
    const reportToken = await signToken(key, monitorClaims('9000000201', 'schedule'));
    const wrongAudience = await postOps(env, STATUS_CLAIM_PATH, body, reportToken);
    expect(wrongAudience.status).toBe(401);
    expect(signaling.claims).toEqual([]);

    const claimed = await postOps(env, STATUS_CLAIM_PATH, body, token);
    expect(claimed.status).toBe(200);
    expect(claimed.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(claimed.headers.get('Access-Control-Allow-Origin')).toBeNull();
    await expect(claimed.json()).resolves.toEqual({ ok: true });
    expect(signaling.claims).toEqual([
      { objectName: '123456', body: { v: 1, roomId: '123456' }, contentType: 'application/json' },
    ]);

    for (const [reply, status, error] of [
      [() => Response.json({ error: 'ROOM_ACTIVE' }, { status: 409 }), 409, 'ROOM_ACTIVE'],
      [
        () => Response.json({ error: 'NOT_FOUND' }, { status: 404 }),
        424,
        'STATUS_PROBE_UNSUPPORTED',
      ],
      [
        () => Response.json({ error: 'SERVICE_MAINTENANCE' }, { status: 503 }),
        503,
        'STATUS_PROBE_UNAVAILABLE',
      ],
    ] as const) {
      answer = reply;
      const response = await postOps(env, STATUS_CLAIM_PATH, body, token);
      expect(response.status, error).toBe(status);
      await expect(response.json(), error).resolves.toEqual({ error });
    }

    const malformed = await postOps(env, STATUS_CLAIM_PATH, '{"v":1,', token);
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: 'Invalid JSON body' });
    expect(signaling.claims).toHaveLength(4);
    // The claim opens nothing by itself.
    expect(signaling.log).toEqual(['claim', 'claim', 'claim', 'claim']);
  });

  it('answers 503 when the ledger is missing, and applies the rate limit before any token work', async () => {
    useDateClock('2026-11-26T05:37:05.000Z');
    const key = await createSigningKey('status-monitor-limit-key');
    const jwks = installJwks(key);
    const { env } = statusEnv({ ledger: null });
    const token = await signToken(key, monitorClaims('9000000301', 'workflow_dispatch'));
    const report = JSON.stringify({
      v: 1,
      startedAt: '2026-11-26T05:37:01.000Z',
      results: {
        website: { outcome: 'ok', reason: 'passing' },
        connection: { outcome: 'ok', reason: 'passing' },
      },
    });
    const unstored = await postOps(env, STATUS_REPORT_PATH, report, token);
    expect(unstored.status).toBe(503);
    await expect(unstored.json()).resolves.toEqual({ error: 'STATUS_STORE_UNAVAILABLE' });

    // 60 requests per 10 minutes from one address, counted before the token:
    // with the key cache emptied, a verification would fetch the keys again.
    jwks.mockClear();
    resetGitHubActionsOidcCacheForTests();
    for (let request = 0; request < 60; request += 1) {
      const response = await postOps(env, STATUS_REPORT_PATH, report, null, '203.0.113.90');
      expect(response.status).toBe(401);
    }
    const limited = await postOps(env, STATUS_REPORT_PATH, report, token, '203.0.113.90');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(jwks).not.toHaveBeenCalled();

    // Without a working limiter the routes refuse rather than run unlimited.
    vi.stubGlobal('caches', { default: { match: vi.fn(), put: vi.fn() } });
    const { env: unlimited } = statusEnv({ control: null });
    for (const path of [STATUS_REPORT_PATH, STATUS_CLAIM_PATH]) {
      const response = await postOps(unlimited, path, report, token);
      expect(response.status, path).toBe(503);
      await expect(response.json(), path).resolves.toEqual({ error: 'RATE_LIMIT_UNAVAILABLE' });
    }
    expect(jwks).not.toHaveBeenCalled();
  });
});

describe('App Worker status ledger writers', () => {
  it('interleaves cron results and browser reports, keeping the newest result of each slot', async () => {
    useDateClock('2026-11-26T05:45:01.000Z');
    quietConsole();
    const key = await createSigningKey('status-monitor-key');
    installJwks(key);
    const control = createAtomicRateControlBinding().binding;
    let proStatus = 200;
    const pro = createProApi(() =>
      proStatus === 200
        ? proAnswer('activation_required')
        : Response.json({ error: 'ROOM_NOT_FOUND' }, { status: proStatus }),
    );
    const { env, ledger } = statusEnv({ control, pro });
    const scheduledTime = at('2026-11-26T05:45:00.000Z');

    // Cron run A: its pro row is held in flight while reports arrive.
    const cronProHold = ledger!.hold((bound) => bound.some((values) => values[0] === 'pro'));
    const runA = runStatusCron(env, scheduledTime);
    await cronProHold.reached;
    await vi.waitFor(() =>
      expect(ledger!.rows()).toEqual([expect.objectContaining({ component: 'rooms' })]),
    );

    // Report R1 of the 05:37 browser slot.
    vi.setSystemTime(new Date('2026-11-26T05:45:05.000Z'));
    const first = await postReport(env, key, {
      runId: '9000000101',
      startedAt: '2026-11-26T05:37:20.000Z',
      website: ['ok', 'passing'],
      connection: ['ok', 'passing'],
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      ok: true,
      slotAt: '2026-11-26T05:37:00.000Z',
      recorded: { website: 'o', connection: 'o' },
    });

    // R2, a manual run in the same slot, is still writing when R3 lands.
    vi.setSystemTime(new Date('2026-11-26T05:45:06.000Z'));
    const staleHold = ledger!.hold((bound) => bound.some((values) => values[6] === '9000000102'));
    const second = postReport(env, key, {
      runId: '9000000102',
      eventName: 'workflow_dispatch',
      startedAt: '2026-11-26T05:37:50.000Z',
      website: ['fail', 'website_timeout'],
      connection: ['ok', 'passing'],
    });
    await staleHold.reached;
    vi.setSystemTime(new Date('2026-11-26T05:45:07.000Z'));
    const third = await postReport(env, key, {
      runId: '9000000103',
      startedAt: '2026-11-26T05:38:05.000Z',
      website: ['ok', 'passing'],
      connection: ['fail', 'chat_timeout'],
    });
    expect(third.status).toBe(200);
    staleHold.release();
    expect((await second).status).toBe(200);

    // Run A finishes after the reports: its rows sit beside theirs.
    cronProHold.release();
    await runA;

    // Run B, the same scheduled slot delivered again later, supersedes run A.
    vi.setSystemTime(new Date('2026-11-26T05:45:20.000Z'));
    proStatus = 404;
    await runStatusCron(env, scheduledTime);

    const browserSlot = at('2026-11-26T05:37:00.000Z');
    expect(ledger!.rows()).toEqual([
      {
        component: 'connection',
        slot_at: browserSlot,
        result: 'p',
        reason: 'chat_timeout',
        checked_at: at('2026-11-26T05:45:07.000Z'),
        source: 'browser',
        run_id: '9000000103',
      },
      {
        component: 'website',
        slot_at: browserSlot,
        result: 'o',
        reason: 'passing',
        checked_at: at('2026-11-26T05:45:07.000Z'),
        source: 'browser',
        run_id: '9000000103',
      },
      {
        component: 'pro',
        slot_at: scheduledTime,
        result: 'p',
        reason: 'pro_http_404',
        checked_at: at('2026-11-26T05:45:20.000Z'),
        source: 'cron',
        run_id: null,
      },
      {
        component: 'rooms',
        slot_at: scheduledTime,
        result: 'o',
        reason: 'passing',
        checked_at: at('2026-11-26T05:45:20.000Z'),
        source: 'cron',
        run_id: null,
      },
    ]);

    vi.setSystemTime(new Date('2026-11-26T05:45:30.000Z'));
    const { response } = await statusApi(env);
    const body = (await response.json()) as { overall: JsonObject; components: JsonObject[] };
    expect(body.overall).toEqual({
      state: 'ok',
      reason: 'all_passing',
      lastCheckedAt: '2026-11-26T05:45:20.000Z',
      since: null,
    });
    expect(body.components).toEqual([
      {
        id: 'website',
        state: 'ok',
        reason: 'passing',
        lastCheckedAt: '2026-11-26T05:45:07.000Z',
        lastOkAt: '2026-11-26T05:45:07.000Z',
        problemSince: null,
        recent: { lastAt: '2026-11-26T05:37:00.000Z', slots: 'o' },
      },
      {
        id: 'rooms',
        state: 'ok',
        reason: 'passing',
        lastCheckedAt: '2026-11-26T05:45:20.000Z',
        lastOkAt: '2026-11-26T05:45:20.000Z',
        problemSince: null,
        recent: { lastAt: '2026-11-26T05:45:00.000Z', slots: 'o' },
      },
      {
        // One failure is not yet a problem.
        id: 'connection',
        state: 'ok',
        reason: 'passing',
        lastCheckedAt: '2026-11-26T05:45:07.000Z',
        lastOkAt: null,
        problemSince: null,
        recent: { lastAt: '2026-11-26T05:37:00.000Z', slots: 'p' },
      },
      {
        id: 'pro',
        state: 'ok',
        reason: 'passing',
        lastCheckedAt: '2026-11-26T05:45:20.000Z',
        lastOkAt: null,
        problemSince: null,
        recent: { lastAt: '2026-11-26T05:45:00.000Z', slots: 'p' },
      },
    ]);
  });
});

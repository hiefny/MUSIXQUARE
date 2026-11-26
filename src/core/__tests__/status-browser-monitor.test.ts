import { Buffer } from 'node:buffer';
import { globSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STATUS_BROWSER_CLAIM_TIMEOUT_MS,
  STATUS_BROWSER_REPORT_ATTEMPTS,
  STATUS_BROWSER_STEP_TIMEOUT_MS,
  STATUS_CLAIM_AUDIENCE,
  STATUS_CLAIM_PATH,
  STATUS_PUBLIC_PATH,
  STATUS_REPORT_AUDIENCE,
  STATUS_REPORT_PATH,
  isStatusReason,
} from '../../../cloudflare/status-contract.ts';
import {
  ClaimGate,
  MONITOR_MAINTENANCE,
  MONITOR_PASSING,
  MONITOR_REASONS,
  OidcUnavailableError,
  STATUS_MONITOR_APP_ORIGIN,
  STATUS_MONITOR_CHAT_RESEND_AFTER_MS,
  STATUS_MONITOR_CHAT_SEND_ATTEMPTS,
  STATUS_MONITOR_PEER_ROW_SELECTOR,
  STATUS_MONITOR_REFUSED_CLOSE_CODE,
  STATUS_MONITOR_REPORT_RETRY_DELAY_MS,
  STATUS_MONITOR_SIGNALING_ENDPOINTS,
  STATUS_MONITOR_TOKEN_REFRESH_MARGIN_MS,
  buildStatusReport,
  classifyClaimAnswer,
  classifyDocumentResponse,
  classifyMonitorRequest,
  classifyMonitorWebSocket,
  classifyReportAnswer,
  classifyStatusPreflight,
  compareServedAppBuild,
  connectionAfterWebsite,
  connectionResult,
  createOidcTokenSource,
  deliverChatMessage,
  describeAnswer,
  describeDelivered,
  mintOidcToken,
  monitorFailure,
  monitorSkipped,
  postStatusReport,
  readStatusPreflight,
  requestStatusClaim,
  resultForServedBuild,
  routeMonitorRequest,
  routeMonitorWebSocket,
  sanitizeMonitorDiagnostic,
  statusMonitorEndAnnotations,
  statusMonitorExitCode,
  type ChatStepPages,
  type ClaimGateSummary,
  type ClaimVerdict,
  type JsonAnswer,
  type MonitorPageSocket,
  type MonitorServerSocket,
  type MonitorSocketCloseOptions,
  type MonitorSocketMessage,
  type OidcTokenSource,
  type ReportDelivery,
  type ReportVerdict,
  type StatusMonitorDeps,
  type StatusMonitorRun,
} from '../../../scripts/lib/status-browser-monitor-lib.mts';

// Synthetic room codes and peer ids only.
const ROOM = '482913';
const OTHER_ROOM = '730158';
const HOST_SOCKET = `wss://signal.musixquare.com/api/rooms/${ROOM}/ws?role=host&peerId=mx-hostPeer01`;
const OIDC_REQUEST_URL = 'https://pipelines.actions.example/idtoken?api-version=2.0';
const OIDC_REQUEST_TOKEN = 'actions-request-token';
const T0 = Date.parse('2026-11-26T05:07:41.000Z');
const SERVICE_WORKER_PATH = '/service-worker.js';

/** The live App's service worker, as it declares the build it serves. */
function served(build: number): string {
  return `self.addEventListener('install', () => {});\nconst CACHE_VERSION = 'v${build}';\n`;
}

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
}

/** A JSON body, or with `text` a raw one (the live App's service worker). */
type Answer =
  { readonly status: number; readonly body?: unknown; readonly text?: string } | 'network-error';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function oidcToken(expSeconds: number | null, label = 'sig'): string {
  const payload = expSeconds === null ? { sub: 'repo' } : { exp: expSeconds, sub: 'repo' };
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.${label}`;
}

class World {
  time = T0;
  readonly requests: RecordedRequest[] = [];
  readonly lines: string[] = [];
  readonly sleeps: number[] = [];
  readonly answers = new Map<string, Answer[]>();
  readonly issued: string[] = [];
  mintExpiry: number | null = Math.floor(T0 / 1_000) + 300;
  /** What GitHub's token endpoint answers instead of a fresh token. */
  oidcAnswer: { readonly status: number; readonly body: unknown } | 'network-error' | null = null;
  env: Record<string, string | undefined> = {
    ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_REQUEST_URL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQUEST_TOKEN,
  };

  readonly deps: StatusMonitorDeps = {
    fetch: (url, init) => this.fetch(url, init),
    env: new Proxy({}, { get: (_target, key) => this.env[String(key)] }),
    write: (line) => {
      this.lines.push(line);
    },
    now: () => this.time,
    sleep: async (milliseconds) => {
      this.sleeps.push(milliseconds);
      this.time += milliseconds;
    },
  };

  answer(path: string, ...answers: Answer[]): this {
    this.answers.set(path, [...(this.answers.get(path) ?? []), ...answers]);
    return this;
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((request) => new URL(request.url).pathname === path);
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : null;
    this.requests.push({ url, method: init.method ?? 'GET', headers, body });
    const parsed = new URL(url);
    if (url.startsWith(OIDC_REQUEST_URL.split('?')[0] ?? '')) {
      if (this.oidcAnswer === 'network-error') throw new TypeError('fetch failed');
      if (this.oidcAnswer) return json(this.oidcAnswer.status, this.oidcAnswer.body);
      const token = oidcToken(this.mintExpiry, `sig${this.issued.length + 1}`);
      this.issued.push(token);
      return json(200, { value: token });
    }
    const queue = this.answers.get(parsed.pathname) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error(`no answer configured for ${parsed.pathname}`);
    if (next === 'network-error') throw new TypeError('fetch failed');
    if (next.text !== undefined) {
      return new Response(next.text, {
        status: next.status,
        headers: { 'Content-Type': 'text/javascript' },
      });
    }
    return json(next.status, next.body ?? {});
  }
}

/** A claim request whose answers the test hands out one at a time. */
function scriptedGate(): {
  gate: ClaimGate;
  calls: string[];
  signals: AbortSignal[];
  answer: (verdict: ClaimVerdict) => void;
} {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const pending: Array<(verdict: ClaimVerdict) => void> = [];
  const gate = new ClaimGate({
    request: (roomId, signal) => {
      calls.push(roomId);
      signals.push(signal);
      return new Promise<ClaimVerdict>((done) => pending.push(done));
    },
  });
  return {
    gate,
    calls,
    signals,
    answer: (verdict) => {
      const next = pending.shift();
      if (!next) throw new Error('no claim is pending');
      next(verdict);
    },
  };
}

function gateAnswering(...verdicts: ClaimVerdict[]): { gate: ClaimGate; calls: string[] } {
  const calls: string[] = [];
  const gate = new ClaimGate({
    request: async (roomId) => {
      calls.push(roomId);
      const verdict = verdicts.length > 1 ? verdicts.shift() : verdicts[0];
      if (!verdict) throw new Error('no verdict configured');
      return verdict;
    },
  });
  return { gate, calls };
}

class FakeServer implements MonitorServerSocket {
  readonly sent: MonitorSocketMessage[] = [];
  readonly closes: MonitorSocketCloseOptions[] = [];

  send(message: MonitorSocketMessage): void {
    this.sent.push(message);
  }

  async close(options: MonitorSocketCloseOptions = {}): Promise<void> {
    this.closes.push(options);
  }
}

/** Playwright's page-side WebSocketRoute, as far as the gate uses it. */
class FakePageSocket implements MonitorPageSocket {
  readonly events: string[] = [];
  readonly closes: MonitorSocketCloseOptions[] = [];
  server: FakeServer | null = null;
  private messageHandler: ((message: MonitorSocketMessage) => void) | null = null;
  private closeHandler: ((code: number | undefined, reason: string | undefined) => void) | null =
    null;

  constructor(private readonly address: string) {}

  url(): string {
    return this.address;
  }

  onMessage(handler: (message: MonitorSocketMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (code: number | undefined, reason: string | undefined) => void): void {
    this.closeHandler = handler;
  }

  async close(options: MonitorSocketCloseOptions = {}): Promise<void> {
    this.closes.push(options);
    this.events.push(`page closed ${options.code ?? 'without code'}`);
  }

  connectToServer(): MonitorServerSocket {
    if (this.server) throw new Error('Already connected to the server');
    this.events.push('connected');
    this.server = new FakeServer();
    return this.server;
  }

  /** The page sends a frame; a route with no handler would forward it itself. */
  pageSends(message: MonitorSocketMessage): void {
    if (!this.messageHandler) throw new Error('the gate installed no message handler');
    this.messageHandler(message);
  }

  pageCloses(code?: number, reason?: string): void {
    if (!this.closeHandler) throw new Error('the gate installed no close handler');
    this.closeHandler(code, reason);
  }

  get handlesMessages(): boolean {
    return this.messageHandler !== null;
  }
}

class FakeRequestRoute {
  readonly events: string[] = [];

  constructor(
    private readonly method: string,
    private readonly address: string,
    private readonly body: string | null,
  ) {}

  request(): { method(): string; url(): string; postData(): string | null } {
    return {
      method: () => this.method,
      url: () => this.address,
      postData: () => this.body,
    };
  }

  async continue(): Promise<void> {
    this.events.push('continue');
  }

  async abort(errorCode?: string): Promise<void> {
    this.events.push(`abort ${errorCode ?? ''}`.trim());
  }
}

function bridgeOpen(body: unknown): FakeRequestRoute {
  return new FakeRequestRoute(
    'POST',
    `${STATUS_MONITOR_APP_ORIGIN}/api/standard-signaling/v1/bridge/open`,
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}

const QUIET_GATE: ClaimGateSummary = Object.freeze({
  claimed: 1,
  refused: 0,
  unrecognized: 0,
  bypassed: false,
  stoppedBy: null,
  authRefused: false,
  contractMismatch: false,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('status browser monitor preflight', () => {
  it('runs only when GET /api/status answers schema 1, and reports maintenance while it is on', () => {
    expect(classifyStatusPreflight(null)).toBe('not-deployed');
    expect(classifyStatusPreflight({ status: 404, body: { error: 'NOT_FOUND' } })).toBe(
      'not-deployed',
    );
    expect(classifyStatusPreflight({ status: 503, body: { error: 'SERVICE_MAINTENANCE' } })).toBe(
      'not-deployed',
    );
    // The App's HTML fallback, or a body that is not the status payload.
    expect(classifyStatusPreflight({ status: 200, body: null })).toBe('not-deployed');
    expect(classifyStatusPreflight({ status: 200, body: { schemaVersion: 2 } })).toBe(
      'not-deployed',
    );
    expect(classifyStatusPreflight({ status: 200, body: { schemaVersion: '1' } })).toBe(
      'not-deployed',
    );
    expect(
      classifyStatusPreflight({
        status: 200,
        body: { schemaVersion: 1, maintenance: { active: true, since: null } },
      }),
    ).toBe('maintenance');
    expect(
      classifyStatusPreflight({
        status: 200,
        body: { schemaVersion: 1, maintenance: { active: false, since: null } },
      }),
    ).toBe('run');
    expect(classifyStatusPreflight({ status: 200, body: { schemaVersion: 1 } })).toBe('run');
  });

  it('reads the public status route once, without credentials', async () => {
    const world = new World()
      .answer(STATUS_PUBLIC_PATH, {
        status: 200,
        body: { schemaVersion: 1, maintenance: { active: true, since: null } },
      })
      .answer(SERVICE_WORKER_PATH, { status: 200, text: served(845) });

    await expect(readStatusPreflight(world.deps)).resolves.toMatchObject({
      preflight: 'maintenance',
    });
    const reads = world.requestsTo(STATUS_PUBLIC_PATH);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.url).toBe(`${STATUS_MONITOR_APP_ORIGIN}${STATUS_PUBLIC_PATH}`);
    expect(reads[0]?.method).toBe('GET');
    expect(reads[0]?.headers.get('Authorization')).toBeNull();
    expect(world.requests).toHaveLength(2);
    expect(world.lines).toEqual([]);

    const unreachable = new World()
      .answer(STATUS_PUBLIC_PATH, 'network-error')
      .answer(SERVICE_WORKER_PATH, 'network-error');
    await expect(readStatusPreflight(unreachable.deps)).resolves.toEqual({
      preflight: 'not-deployed',
      answer: null,
      servedAppBuild: null,
    });
  });

  it('reads the build the live App serves beside the status route, both at once', async () => {
    const world = new World()
      .answer(STATUS_PUBLIC_PATH, { status: 200, body: { schemaVersion: 1 } })
      .answer(SERVICE_WORKER_PATH, { status: 200, text: served(845) });

    const pending = readStatusPreflight(world.deps);
    // Both requests are out before either answer is read: the build read adds
    // no time to the run.
    expect(world.requests.map((request) => request.url).sort()).toEqual([
      `${STATUS_MONITOR_APP_ORIGIN}${STATUS_PUBLIC_PATH}`,
      `${STATUS_MONITOR_APP_ORIGIN}${SERVICE_WORKER_PATH}`,
    ]);
    await expect(pending).resolves.toEqual({
      preflight: 'run',
      answer: { status: 200, body: { schemaVersion: 1 } },
      servedAppBuild: 845,
    });
    const [build] = world.requestsTo(SERVICE_WORKER_PATH);
    expect(build?.method).toBe('GET');
    expect(build?.headers.get('Authorization')).toBeNull();
    expect(world.lines).toEqual([]);
  });

  it.each([
    ['a network error', 'network-error'],
    ['a 404', { status: 404, text: 'Not found' }],
    ['a 503', { status: 503, text: served(845) }],
    ['no cache version', { status: 200, text: 'self.addEventListener("fetch", () => {});' }],
  ] as const)('gives no served build for %s', async (_label, answer) => {
    const world = new World()
      .answer(STATUS_PUBLIC_PATH, { status: 200, body: { schemaVersion: 1 } })
      .answer(SERVICE_WORKER_PATH, answer as Answer);
    await expect(readStatusPreflight(world.deps)).resolves.toMatchObject({
      preflight: 'run',
      servedAppBuild: null,
    });
  });

  it('reports both rows as maintenance with the exact report body', () => {
    expect(buildStatusReport(T0, MONITOR_MAINTENANCE, MONITOR_MAINTENANCE)).toEqual({
      v: 1,
      startedAt: '2026-11-26T05:07:41.000Z',
      results: {
        website: { outcome: 'maintenance', reason: 'maintenance' },
        connection: { outcome: 'maintenance', reason: 'maintenance' },
      },
    });
  });
});

describe('status browser monitor served build', () => {
  const MISMATCH = { outcome: 'skipped', reason: 'app_build_mismatch' };

  it('compares the build production serves with this checkout', () => {
    expect(compareServedAppBuild(845, 846)).toBe('different');
    expect(compareServedAppBuild(847, 846)).toBe('different');
    expect(compareServedAppBuild(846, 846)).toBe('same');
    expect(compareServedAppBuild(null, 846)).toBe('unknown');
    expect(compareServedAppBuild(846, null)).toBe('unknown');
  });

  it('reports a failed check as skipped only while production serves another build', () => {
    expect(MONITOR_REASONS.appBuildMismatch).toBe('app_build_mismatch');
    for (const reason of [
      MONITOR_REASONS.chatToGuestFailed,
      MONITOR_REASONS.startScreenMissing,
      'page_http_503',
    ]) {
      expect(resultForServedBuild(monitorFailure(reason), 'different')).toEqual(MISMATCH);
      // A failure stands while the builds match, or when either is unknown.
      expect(resultForServedBuild(monitorFailure(reason), 'same')).toEqual(monitorFailure(reason));
      expect(resultForServedBuild(monitorFailure(reason), 'unknown')).toEqual(
        monitorFailure(reason),
      );
    }
    // A pass, a skip and maintenance stand whatever production serves.
    for (const result of [
      MONITOR_PASSING,
      monitorSkipped(MONITOR_REASONS.claimUnavailable),
      monitorSkipped(MONITOR_REASONS.edgeChallenge),
      MONITOR_MAINTENANCE,
    ]) {
      for (const match of ['different', 'same', 'unknown'] as const) {
        expect(resultForServedBuild(result, match)).toEqual(result);
      }
    }
  });

  it('reports both rows skipped for a build mismatch in the exact report body', () => {
    const skipped = monitorSkipped(MONITOR_REASONS.appBuildMismatch);
    expect(buildStatusReport(T0, skipped, skipped).results).toEqual({
      website: MISMATCH,
      connection: MISMATCH,
    });
  });
});

describe('status browser monitor report body', () => {
  it('has exactly the keys the report route accepts', () => {
    const body = buildStatusReport(
      T0,
      { ...MONITOR_PASSING, extra: 'dropped' } as typeof MONITOR_PASSING,
      monitorFailure(MONITOR_REASONS.chatToGuestFailed),
    );
    expect(Object.keys(body)).toEqual(['v', 'startedAt', 'results']);
    expect(Object.keys(body.results)).toEqual(['website', 'connection']);
    expect(Object.keys(body.results.website)).toEqual(['outcome', 'reason']);
    expect(Object.keys(body.results.connection)).toEqual(['outcome', 'reason']);
    expect(body.results).toEqual({
      website: { outcome: 'ok', reason: 'passing' },
      connection: { outcome: 'fail', reason: 'chat_to_guest_failed' },
    });
    expect(new Date(body.startedAt).getTime()).toBe(T0);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(4_096);
  });

  it('reports only reasons that the reason pattern accepts', () => {
    for (const reason of Object.values(MONITOR_REASONS)) {
      expect(isStatusReason(reason), reason).toBe(true);
    }
    expect(() => buildStatusReport(T0, monitorFailure('Bad-Reason'), MONITOR_PASSING)).toThrow(
      'website',
    );
    expect(() => buildStatusReport(T0, MONITOR_PASSING, monitorSkipped('x'.repeat(49)))).toThrow(
      'connection',
    );
    expect(() =>
      buildStatusReport(
        T0,
        { outcome: 'passed', reason: 'passing' } as unknown as typeof MONITOR_PASSING,
        MONITOR_PASSING,
      ),
    ).toThrow();
    expect(() => buildStatusReport(Number.NaN, MONITOR_PASSING, MONITOR_PASSING)).toThrow();
  });

  it('names a challenge, a failed page load and a status outside 2xx', () => {
    expect(classifyDocumentResponse(403, 'challenge')).toEqual({ kind: 'challenge' });
    expect(classifyDocumentResponse(200, ' Challenge ')).toEqual({ kind: 'challenge' });
    expect(classifyDocumentResponse(200, null)).toEqual({ kind: 'ok' });
    expect(classifyDocumentResponse(204, 'managed')).toEqual({ kind: 'ok' });
    expect(classifyDocumentResponse(503, null)).toEqual({ kind: 'http', reason: 'page_http_503' });
    expect(classifyDocumentResponse(404, null)).toEqual({ kind: 'http', reason: 'page_http_404' });
    expect(classifyDocumentResponse(0, null)).toEqual({
      kind: 'http',
      reason: 'navigation_failed',
    });
    expect(isStatusReason('page_http_503')).toBe(true);
  });
});

describe('status browser monitor OIDC tokens', () => {
  it('masks a minted token before anything else is written', async () => {
    const world = new World();
    const token = await mintOidcToken(STATUS_REPORT_AUDIENCE, world.deps);

    expect(world.lines).toEqual([`::add-mask::${token}`]);
    const [request] = world.requests;
    const url = new URL(request?.url ?? '');
    expect(url.searchParams.get('audience')).toBe(STATUS_REPORT_AUDIENCE);
    expect(url.searchParams.get('api-version')).toBe('2.0');
    expect(request?.headers.get('Authorization')).toBe(`Bearer ${OIDC_REQUEST_TOKEN}`);
  });

  it('masks every token before any other line, and never writes a token or the request token', async () => {
    const world = new World().answer(
      STATUS_REPORT_PATH,
      { status: 503, body: { error: 'STATUS_STORE_UNAVAILABLE' } },
      { status: 200, body: { ok: true } },
    );
    const reportTokens = createOidcTokenSource(STATUS_REPORT_AUDIENCE, world.deps);
    const claimTokens = createOidcTokenSource(STATUS_CLAIM_AUDIENCE, world.deps);
    await reportTokens.get();
    await claimTokens.get();
    // The report token now expires within the refresh margin; its successor
    // lasts the whole delivery.
    world.time += 280_000;
    world.mintExpiry = Math.floor(world.time / 1_000) + 300;
    await postStatusReport(
      buildStatusReport(T0, MONITOR_PASSING, MONITOR_PASSING),
      reportTokens,
      world.deps,
    );

    expect(world.issued).toHaveLength(3);
    for (const token of world.issued) {
      const lines = world.lines.filter((line) => line.includes(token));
      expect(lines).toEqual([`::add-mask::${token}`]);
    }
    expect(world.lines.some((line) => line.includes(OIDC_REQUEST_TOKEN))).toBe(false);
    // Each mask line comes right when its token is minted, before the next write.
    const firstMask = world.lines.findIndex((line) => line.startsWith('::add-mask::'));
    expect(firstMask).toBe(0);
  });

  it('refuses to run without GitHub Actions OIDC, and never echoes what GitHub answered', async () => {
    const world = new World();
    world.env = {};
    await expect(mintOidcToken(STATUS_CLAIM_AUDIENCE, world.deps)).rejects.toThrow(
      'GitHub Actions OIDC is unavailable for /api/ops/status-claim',
    );
    expect(world.requests).toEqual([]);

    const malformed = new World();
    malformed.oidcAnswer = { status: 200, body: { value: 'not a token secret-value' } };
    await expect(mintOidcToken(STATUS_REPORT_AUDIENCE, malformed.deps)).rejects.toThrow(
      /^GitHub Actions OIDC did not issue a token for \/api\/ops\/status-report \(HTTP 200\)\.$/u,
    );
    expect(malformed.lines).toEqual([]);

    const refused = new World();
    refused.oidcAnswer = { status: 403, body: { message: 'denied' } };
    await expect(mintOidcToken(STATUS_REPORT_AUDIENCE, refused.deps)).rejects.toThrow('HTTP 403');
    expect(refused.lines).toEqual([]);
  });

  it('tells a token service that gave no token for now from one that refused the job', async () => {
    const mintError = async (world: World) =>
      mintOidcToken(STATUS_REPORT_AUDIENCE, world.deps).then(
        () => null,
        (error: unknown) => error,
      );
    for (const [answer, detail] of [
      [{ status: 503, body: { message: 'unavailable' } }, 'HTTP 503'],
      [{ status: 500, body: {} }, 'HTTP 500'],
      [{ status: 429, body: { message: 'slow down' } }, 'HTTP 429'],
      ['network-error', 'no answer'],
    ] as const) {
      const world = new World();
      world.oidcAnswer = answer;
      const error = await mintError(world);
      expect(error, detail).toBeInstanceOf(OidcUnavailableError);
      expect((error as Error).message).toBe(
        `GitHub Actions OIDC did not issue a token for /api/ops/status-report (${detail}).`,
      );
      // One request, never retried here, and nothing written.
      expect(world.requests).toHaveLength(1);
      expect(world.lines).toEqual([]);
      // The token source hands the same error to the run, which ends with a warning.
      await expect(
        createOidcTokenSource(STATUS_CLAIM_AUDIENCE, world.deps).get(),
      ).rejects.toBeInstanceOf(OidcUnavailableError);
    }

    const refusals: World[] = [];
    for (const answer of [
      { status: 403, body: { message: 'denied' } },
      { status: 400, body: {} },
      { status: 404, body: {} },
      { status: 200, body: { value: 'not a token' } },
    ]) {
      const world = new World();
      world.oidcAnswer = answer;
      refusals.push(world);
    }
    const withoutOidc = new World();
    withoutOidc.env = {};
    refusals.push(withoutOidc);
    for (const world of refusals) {
      const error = await mintError(world);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(OidcUnavailableError);
      expect(world.lines).toEqual([]);
    }
  });

  it('reuses a token until it expires within the refresh margin, and shares one mint', async () => {
    const world = new World();
    const tokens = createOidcTokenSource(STATUS_REPORT_AUDIENCE, world.deps);
    const [first, concurrent] = await Promise.all([tokens.get(), tokens.get()]);
    expect(concurrent).toBe(first);
    expect(world.issued).toEqual([first]);

    world.time += 300_000 - STATUS_MONITOR_TOKEN_REFRESH_MARGIN_MS - 1_000;
    await expect(tokens.get()).resolves.toBe(first);
    world.time += 1_000;
    const second = await tokens.get();
    expect(second).not.toBe(first);
    expect(world.issued).toEqual([first, second]);

    // A token whose expiry cannot be read is never reused.
    const opaque = new World();
    opaque.mintExpiry = null;
    const opaqueTokens = createOidcTokenSource(STATUS_CLAIM_AUDIENCE, opaque.deps);
    await opaqueTokens.get();
    await opaqueTokens.get();
    expect(opaque.issued).toHaveLength(2);
  });
});

describe('status browser monitor claim gate', () => {
  it('classifies every claim route answer', () => {
    expect(classifyClaimAnswer({ status: 200, body: { ok: true } })).toBe('claimed');
    expect(classifyClaimAnswer({ status: 200, body: {} })).toBe('unavailable');
    expect(classifyClaimAnswer({ status: 409, body: { error: 'ROOM_ACTIVE' } })).toBe(
      'room_active',
    );
    expect(classifyClaimAnswer({ status: 424, body: { error: 'STATUS_PROBE_UNSUPPORTED' } })).toBe(
      'unsupported',
    );
    expect(classifyClaimAnswer({ status: 401, body: { error: 'OIDC_TOKEN_INVALID' } })).toBe(
      'unauthorized',
    );
    expect(classifyClaimAnswer({ status: 403, body: {} })).toBe('unauthorized');
    expect(classifyClaimAnswer({ status: 503, body: { error: 'SERVICE_MAINTENANCE' } })).toBe(
      'maintenance',
    );
    expect(
      classifyClaimAnswer({
        status: 503,
        body: { error: 'SERVICE_MAINTENANCE_STATUS_UNAVAILABLE' },
      }),
    ).toBe('unavailable');
    expect(classifyClaimAnswer({ status: 503, body: { error: 'STATUS_PROBE_UNAVAILABLE' } })).toBe(
      'unavailable',
    );
    expect(classifyClaimAnswer({ status: 503, body: { error: 'RATE_LIMIT_UNAVAILABLE' } })).toBe(
      'unavailable',
    );
    expect(classifyClaimAnswer({ status: 429, body: {} })).toBe('unavailable');
    expect(classifyClaimAnswer({ status: 500, body: null })).toBe('unavailable');
    expect(classifyClaimAnswer({ status: 400, body: { error: 'INVALID_REQUEST' } })).toBe(
      'rejected',
    );
    expect(classifyClaimAnswer({ status: 404, body: null })).toBe('rejected');
    expect(classifyClaimAnswer(null)).toBe('unavailable');
  });

  it('posts exactly {v:1, roomId} with a claim-audience token', async () => {
    const world = new World().answer(STATUS_CLAIM_PATH, { status: 200, body: { ok: true } });
    const tokens = createOidcTokenSource(STATUS_CLAIM_AUDIENCE, world.deps);
    await expect(
      requestStatusClaim(ROOM, tokens, world.deps, new AbortController().signal),
    ).resolves.toBe('claimed');

    const [claim] = world.requestsTo(STATUS_CLAIM_PATH);
    expect(claim?.url).toBe(`${STATUS_MONITOR_APP_ORIGIN}${STATUS_CLAIM_PATH}`);
    expect(claim?.method).toBe('POST');
    expect(claim?.headers.get('Content-Type')).toBe('application/json');
    expect(claim?.headers.get('Authorization')).toBe(`Bearer ${world.issued[0]}`);
    expect(JSON.parse(claim?.body ?? '')).toEqual({ v: 1, roomId: ROOM });
    expect(Object.keys(JSON.parse(claim?.body ?? '') as object)).toEqual(['v', 'roomId']);

    const offline = new World().answer(STATUS_CLAIM_PATH, 'network-error');
    await expect(
      requestStatusClaim(
        ROOM,
        createOidcTokenSource(STATUS_CLAIM_AUDIENCE, offline.deps),
        offline.deps,
        new AbortController().signal,
      ),
    ).resolves.toBe('unavailable');

    const noToken: OidcTokenSource = { get: () => Promise.reject(new Error('no OIDC')) };
    await expect(
      requestStatusClaim(ROOM, noToken, world.deps, new AbortController().signal),
    ).resolves.toBe('unavailable');
  });

  it('holds a host socket, with no server connection, until the claim answers', async () => {
    const { gate, calls, answer } = scriptedGate();
    const page = new FakePageSocket(HOST_SOCKET);
    const routed = routeMonitorWebSocket(page, gate);

    await Promise.resolve();
    expect(calls).toEqual([ROOM]);
    expect(page.events).toEqual([]);
    // Defense in depth: a frame that reached the gate while it waited is held.
    page.pageSends('{"type":"host-auth","n":1}');
    page.pageSends('{"type":"host-auth","n":2}');
    expect(page.server).toBeNull();

    answer('claimed');
    await routed;
    expect(page.events).toEqual(['connected']);
    page.pageSends('{"n":3}');
    page.pageSends(Buffer.from('binary-4'));
    expect(page.server?.sent).toEqual([
      '{"type":"host-auth","n":1}',
      '{"type":"host-auth","n":2}',
      '{"n":3}',
      Buffer.from('binary-4'),
    ]);
    expect(gate.isClaimed(ROOM)).toBe(true);
    expect(gate.summary()).toEqual({ ...QUIET_GATE });
  });

  it('closes a refused host socket and never forwards its frames', async () => {
    const { gate, answer } = scriptedGate();
    const page = new FakePageSocket(HOST_SOCKET);
    const routed = routeMonitorWebSocket(page, gate);
    await Promise.resolve();
    page.pageSends('{"type":"host-auth"}');

    answer('room_active');
    await routed;
    expect(page.server).toBeNull();
    expect(page.closes).toEqual([
      { code: STATUS_MONITOR_REFUSED_CLOSE_CODE, reason: 'status-claim-unavailable' },
    ]);
    expect(STATUS_MONITOR_REFUSED_CLOSE_CODE).toBeLessThan(4_000);
    expect(gate.summary()).toMatchObject({ claimed: 0, refused: 1, stoppedBy: null });

    // A 409 refuses only that code: the App's next code may still be claimed.
    const next = new FakePageSocket(HOST_SOCKET.replace(ROOM, OTHER_ROOM));
    const routedNext = routeMonitorWebSocket(next, gate);
    await Promise.resolve();
    answer('claimed');
    await routedNext;
    expect(next.events).toEqual(['connected']);
    // The refused code stays refused without another request.
    const again = new FakePageSocket(HOST_SOCKET);
    await routeMonitorWebSocket(again, gate);
    expect(again.server).toBeNull();
    expect(gate.summary()).toMatchObject({ claimed: 1, refused: 2 });
  });

  it('reuses a claimed code and shares one request between concurrent transports', async () => {
    const { gate, calls, answer } = scriptedGate();
    const primary = new FakePageSocket(HOST_SOCKET);
    const alternate = new FakePageSocket(HOST_SOCKET.replace('wss://signal.', 'wss://signal-alt.'));
    const routedPrimary = routeMonitorWebSocket(primary, gate);
    const routedAlternate = routeMonitorWebSocket(alternate, gate);
    await Promise.resolve();
    expect(calls).toEqual([ROOM]);
    answer('claimed');
    await Promise.all([routedPrimary, routedAlternate]);
    expect(primary.events).toEqual(['connected']);
    expect(alternate.events).toEqual(['connected']);

    // A reconnect of the same room opens at once, without a second request.
    const reconnect = new FakePageSocket(HOST_SOCKET.replace('mx-hostPeer01', 'mx-hostPeer02'));
    await routeMonitorWebSocket(reconnect, gate);
    expect(reconnect.events).toEqual(['connected']);
    expect(calls).toEqual([ROOM]);
  });

  it('stops claiming after a definite refusal', async () => {
    for (const verdict of ['unsupported', 'unauthorized', 'maintenance', 'rejected'] as const) {
      const { gate, calls } = gateAnswering(verdict, 'claimed');
      await expect(gate.claim(ROOM)).resolves.toBe(false);
      await expect(gate.claim(OTHER_ROOM)).resolves.toBe(false);
      expect(calls, verdict).toEqual([ROOM]);
      expect(gate.summary().stoppedBy).toBe(verdict);
      expect(gate.summary().authRefused).toBe(verdict === 'unauthorized');
      expect(gate.summary().contractMismatch).toBe(verdict === 'rejected');
    }
    for (const verdict of ['claimed', 'room_active', 'unavailable'] as const) {
      const { gate } = gateAnswering(verdict);
      await gate.claim(ROOM);
      expect(gate.summary(), verdict).toMatchObject({
        stoppedBy: null,
        authRefused: false,
        contractMismatch: false,
      });
    }
  });

  it('keeps an identity refusal or a contract mismatch that arrives after claiming stopped', async () => {
    for (const late of ['unauthorized', 'rejected'] as const) {
      const { gate, answer } = scriptedGate();
      const first = gate.claim(ROOM);
      const second = gate.claim(OTHER_ROOM);
      await Promise.resolve();
      answer('unsupported');
      answer(late);
      await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
      expect(gate.summary(), late).toMatchObject({
        stoppedBy: 'unsupported',
        authRefused: late === 'unauthorized',
        contractMismatch: late === 'rejected',
      });
    }
  });

  it('logs the status and error code of a claim answer that fails the job, and nothing else', async () => {
    const cases: Array<[Answer, ClaimVerdict, string | null]> = [
      [
        { status: 401, body: { error: 'OIDC_TOKEN_INVALID' } },
        'unauthorized',
        'HTTP 401 (OIDC_TOKEN_INVALID)',
      ],
      [
        { status: 403, body: { error: 'OIDC_TOKEN_FORBIDDEN' } },
        'unauthorized',
        'HTTP 403 (OIDC_TOKEN_FORBIDDEN)',
      ],
      [
        { status: 400, body: { error: 'INVALID_REQUEST' } },
        'rejected',
        'HTTP 400 (INVALID_REQUEST)',
      ],
      [
        { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } },
        'rejected',
        'HTTP 405 (METHOD_NOT_ALLOWED)',
      ],
      [{ status: 200, body: { ok: true } }, 'claimed', null],
      [{ status: 409, body: { error: 'ROOM_ACTIVE' } }, 'room_active', null],
      [{ status: 424, body: { error: 'STATUS_PROBE_UNSUPPORTED' } }, 'unsupported', null],
      [{ status: 429, body: { error: 'RATE_LIMITED' } }, 'unavailable', null],
      [{ status: 503, body: { error: 'SERVICE_MAINTENANCE' } }, 'maintenance', null],
      ['network-error', 'unavailable', null],
    ];
    for (const [reply, verdict, logged] of cases) {
      const world = new World().answer(STATUS_CLAIM_PATH, reply);
      const tokens = createOidcTokenSource(STATUS_CLAIM_AUDIENCE, world.deps);
      await expect(
        requestStatusClaim(ROOM, tokens, world.deps, new AbortController().signal),
      ).resolves.toBe(verdict);
      const lines = world.lines.filter((line) => !line.startsWith('::add-mask::'));
      expect(lines, verdict).toEqual(
        logged === null ? [] : [`[status-monitor] claim route answered ${logged}`],
      );
      expect(lines.some((line) => line.includes(ROOM))).toBe(false);
      expect(lines.some((line) => world.issued.some((token) => line.includes(token)))).toBe(false);
    }
  });

  it('lets the next transport try again after a claim without an answer', async () => {
    const { gate, calls } = gateAnswering('unavailable', 'claimed');
    await expect(gate.admitHost(ROOM)).resolves.toBe(false);
    await expect(gate.admitHost(ROOM)).resolves.toBe(true);
    expect(calls).toEqual([ROOM, ROOM]);
    expect(gate.summary()).toMatchObject({ claimed: 1, refused: 1, stoppedBy: null });

    const failing = new ClaimGate({ request: () => Promise.reject(new Error('offline')) });
    await expect(failing.claim(ROOM)).resolves.toBe(false);
  });

  it('gives up on a claim after the claim timeout and aborts its request', async () => {
    vi.useFakeTimers();
    const verdicts: ClaimVerdict[] = [];
    const signals: AbortSignal[] = [];
    const gate = new ClaimGate({
      request: (_roomId, signal) => {
        signals.push(signal);
        return new Promise<ClaimVerdict>(() => undefined);
      },
      onVerdict: (verdict) => verdicts.push(verdict),
    });
    const claim = gate.claim(ROOM);
    await vi.advanceTimersByTimeAsync(STATUS_BROWSER_CLAIM_TIMEOUT_MS - 1);
    expect(verdicts).toEqual([]);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(claim).resolves.toBe(false);
    expect(verdicts).toEqual(['unavailable']);
    expect(signals[0]?.aborted).toBe(true);
    expect(gate.isClaimed(ROOM)).toBe(false);
  });

  it('never opens a host socket whose page closed while the claim was pending', async () => {
    const { gate, answer } = scriptedGate();
    const page = new FakePageSocket(HOST_SOCKET);
    const routed = routeMonitorWebSocket(page, gate);
    await Promise.resolve();
    page.pageCloses(1000, 'route retry');
    expect(page.closes).toEqual([{ code: 1000, reason: 'route retry' }]);

    answer('claimed');
    await routed;
    expect(page.server).toBeNull();
    expect(page.events).toEqual(['page closed 1000']);
  });

  it('carries the page close to the server once the host socket is connected', async () => {
    const { gate } = gateAnswering('claimed');
    const page = new FakePageSocket(HOST_SOCKET);
    await routeMonitorWebSocket(page, gate);
    page.pageCloses(4000, 'left');
    expect(page.server?.closes).toEqual([{ code: 4000, reason: 'left' }]);
    page.pageCloses(undefined, undefined);
    expect(page.server?.closes.at(-1)).toEqual({});
  });

  it('passes guest sockets straight through without a claim', async () => {
    const { gate, calls } = gateAnswering('claimed');
    for (const origin of STATUS_MONITOR_SIGNALING_ENDPOINTS.socketOrigins) {
      const page = new FakePageSocket(
        `${origin}/api/rooms/${ROOM}/ws?role=guest&peerId=mx-guestPeer01`,
      );
      await routeMonitorWebSocket(page, gate);
      expect(page.events).toEqual(['connected']);
      expect(page.handlesMessages).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('refuses every socket it does not recognise, before any connection', async () => {
    const unknown = [
      `wss://signal.musixquare.com/api/pro-rooms/012345/ws`,
      `wss://signal.musixquare.com/api/rooms/012345/ws?role=host&peerId=mx-a`,
      `wss://signal.musixquare.com/api/rooms/${ROOM}/ws?role=host&peerId=mx-a&ticket=x`,
      `wss://signal.musixquare.com/api/rooms/${ROOM}/ws?role=host&role=guest&peerId=mx-a`,
      `wss://signal.musixquare.com/api/rooms/${ROOM}/ws?peerId=mx-a`,
      `wss://signal.musixquare.com/api/rooms/${ROOM}/ws?role=owner&peerId=mx-a`,
      `wss://signal.musixquare.com/api/rooms/${ROOM}/ws?role=host&peerId=bad%20peer`,
      `wss://signal.musixquare.com/api/rooms/${ROOM}/socket?role=host&peerId=mx-a`,
      `wss://signal.musixquare.com:8443/api/rooms/${ROOM}/ws?role=host&peerId=mx-a`,
      `wss://user@signal.musixquare.com/api/rooms/${ROOM}/ws?role=host&peerId=mx-a`,
      `ws://signal.musixquare.com/api/rooms/${ROOM}/ws?role=host&peerId=mx-a`,
      `wss://signal-3.musixquare.com/api/rooms/${ROOM}/ws?role=host&peerId=mx-a`,
      `wss://musixquare.com/api/rooms/${ROOM}/ws?role=host&peerId=mx-a`,
      `wss://example.com/socket`,
      'not a url',
    ];
    const { gate, calls } = gateAnswering('claimed');
    for (const url of unknown) {
      expect(classifyMonitorWebSocket(url), url).toEqual({ kind: 'refuse' });
      const page = new FakePageSocket(url);
      await routeMonitorWebSocket(page, gate);
      expect(page.server, url).toBeNull();
      expect(page.closes, url).toEqual([
        { code: STATUS_MONITOR_REFUSED_CLOSE_CODE, reason: 'status-monitor-unrecognized' },
      ]);
    }
    expect(calls).toEqual([]);
    expect(gate.summary().unrecognized).toBe(unknown.length);
    expect(classifyMonitorWebSocket(HOST_SOCKET)).toEqual({ kind: 'host', roomId: ROOM });
  });

  it('never rejects into Playwright when the page goes away while it waits', async () => {
    const { gate, answer } = scriptedGate();
    const page = new FakePageSocket(HOST_SOCKET);
    page.connectToServer = () => {
      throw new Error('Target page, context or browser has been closed');
    };
    const routed = routeMonitorWebSocket(page, gate);
    await Promise.resolve();
    answer('claimed');
    await expect(routed).resolves.toBeUndefined();
  });
});

describe('status browser monitor HTTP signaling gate', () => {
  it('classifies the bridge, the signaling hosts and everything else', () => {
    const open = `${STATUS_MONITOR_APP_ORIGIN}/api/standard-signaling/v1/bridge/open`;
    const body = (value: Record<string, unknown>): string => JSON.stringify(value);
    const host = { roomId: ROOM, role: 'host', peerId: 'mx-hostPeer01' };

    expect(classifyMonitorRequest('POST', open, body(host))).toEqual({
      kind: 'host',
      roomId: ROOM,
    });
    expect(classifyMonitorRequest('post', open, body({ ...host, role: 'guest' }))).toEqual({
      kind: 'pass',
    });
    for (const path of ['send', 'poll', 'close']) {
      expect(classifyMonitorRequest('POST', open.replace('/open', `/${path}`), '{}'), path).toEqual(
        { kind: 'pass' },
      );
    }
    for (const signalHost of STATUS_MONITOR_SIGNALING_ENDPOINTS.httpOrigins) {
      expect(classifyMonitorRequest('GET', `${signalHost}/?_mxqr_route=1-x`, null)).toEqual({
        kind: 'pass',
      });
      expect(classifyMonitorRequest('HEAD', `${signalHost}/`, null)).toEqual({ kind: 'pass' });
      expect(classifyMonitorRequest('POST', `${signalHost}/api/rooms/${ROOM}`, '{}')).toEqual({
        kind: 'refuse',
      });
    }
    expect(classifyMonitorRequest('GET', `${STATUS_MONITOR_APP_ORIGIN}/api/status`, null)).toEqual({
      kind: 'pass',
    });

    const refused: Array<[string, string, string | null]> = [
      ['POST', open, body({ ...host, extra: true })],
      ['POST', open, body({ roomId: ROOM, role: 'host' })],
      ['POST', open, body({ ...host, roomId: '012345' })],
      ['POST', open, body({ ...host, roomId: 482913 })],
      ['POST', open, body({ ...host, role: 'owner' })],
      ['POST', open, body({ ...host, peerId: 'bad peer' })],
      ['POST', open, '[]'],
      ['POST', open, 'not json'],
      ['POST', open, null],
      ['GET', open, null],
      ['POST', `${open}?debug=1`, body(host)],
      ['POST', open.replace('/v1/', '/v2/'), body(host)],
      ['POST', `${STATUS_MONITOR_APP_ORIGIN}/api/standard-signaling/v1/session`, body(host)],
      ['POST', 'not a url', body(host)],
    ];
    for (const [method, url, postData] of refused) {
      expect(classifyMonitorRequest(method, url, postData), `${method} ${url} ${postData}`).toEqual(
        { kind: 'refuse' },
      );
    }
  });

  it('holds a host bridge open until its code is claimed', async () => {
    const { gate, calls, answer } = scriptedGate();
    const route = bridgeOpen({ roomId: ROOM, role: 'host', peerId: 'mx-hostPeer01' });
    const routed = routeMonitorRequest(route, gate);
    await Promise.resolve();
    expect(calls).toEqual([ROOM]);
    expect(route.events).toEqual([]);
    answer('claimed');
    await routed;
    expect(route.events).toEqual(['continue']);
  });

  it('aborts a refused bridge open and an unrecognised request', async () => {
    const { gate } = gateAnswering('unsupported');
    const refused = bridgeOpen({ roomId: ROOM, role: 'host', peerId: 'mx-hostPeer01' });
    await routeMonitorRequest(refused, gate);
    expect(refused.events).toEqual(['abort blockedbyclient']);

    const unknown = bridgeOpen({ roomId: ROOM, role: 'host', peerId: 'mx-a', ticket: 'x' });
    await routeMonitorRequest(unknown, gate);
    expect(unknown.events).toEqual(['abort blockedbyclient']);

    const guest = bridgeOpen({ roomId: ROOM, role: 'guest', peerId: 'mx-guestPeer01' });
    await routeMonitorRequest(guest, gate);
    expect(guest.events).toEqual(['continue']);
    expect(gate.summary()).toMatchObject({ refused: 1, unrecognized: 1, stoppedBy: 'unsupported' });

    const cancelled = bridgeOpen({ roomId: OTHER_ROOM, role: 'guest', peerId: 'mx-guestPeer01' });
    cancelled.continue = () => Promise.reject(new Error('Route is already handled!'));
    await expect(routeMonitorRequest(cancelled, gate)).resolves.toBeUndefined();
  });
});

describe('status browser monitor connection result', () => {
  it('passes only a finished flow through a quiet gate', () => {
    expect(connectionResult({ ok: true }, QUIET_GATE)).toEqual(MONITOR_PASSING);
    expect(
      connectionResult(
        { ok: false, outcome: 'fail', reason: 'chat_to_host_failed', hostOpened: true },
        QUIET_GATE,
      ),
    ).toEqual({ outcome: 'fail', reason: 'chat_to_host_failed' });
    expect(
      connectionResult(
        { ok: false, outcome: 'fail', reason: 'host_start_failed', hostOpened: false },
        QUIET_GATE,
      ),
    ).toEqual({ outcome: 'fail', reason: 'host_start_failed' });
    expect(
      connectionResult(
        { ok: false, outcome: 'skipped', reason: 'edge_challenge', hostOpened: false },
        QUIET_GATE,
      ),
    ).toEqual({ outcome: 'skipped', reason: 'edge_challenge' });
  });

  it('fails closed: an unrecognised transport or an unclaimed room skips the check', () => {
    const skipped = { outcome: 'skipped', reason: 'claim_unavailable' };
    expect(connectionResult({ ok: true }, { ...QUIET_GATE, unrecognized: 1 })).toEqual(skipped);
    expect(connectionResult({ ok: true }, { ...QUIET_GATE, bypassed: true })).toEqual(skipped);
    // The refusal, not the product, stopped a host that never opened its room.
    expect(
      connectionResult(
        { ok: false, outcome: 'fail', reason: 'host_start_failed', hostOpened: false },
        { ...QUIET_GATE, claimed: 0, refused: 2 },
      ),
    ).toEqual(skipped);
    expect(
      connectionResult(
        { ok: false, outcome: 'fail', reason: 'connection_timeout', hostOpened: false },
        { ...QUIET_GATE, claimed: 0, stoppedBy: 'unsupported' },
      ),
    ).toEqual(skipped);
    // Once the claimed room opened, a later failure is the product's.
    expect(
      connectionResult(
        { ok: false, outcome: 'fail', reason: 'guest_join_failed', hostOpened: true },
        { ...QUIET_GATE, refused: 1 },
      ),
    ).toEqual({ outcome: 'fail', reason: 'guest_join_failed' });
    // A refused transport the App recovered from does not fail a finished flow.
    expect(connectionResult({ ok: true }, { ...QUIET_GATE, refused: 1 })).toEqual(MONITOR_PASSING);
  });

  it('skips the connection check when the website did not pass', () => {
    expect(connectionAfterWebsite(monitorFailure('page_http_503'))).toEqual({
      outcome: 'skipped',
      reason: 'website_failed',
    });
    expect(connectionAfterWebsite(monitorSkipped(MONITOR_REASONS.edgeChallenge))).toEqual({
      outcome: 'skipped',
      reason: 'edge_challenge',
    });
  });
});

/**
 * The two pages of one chat step on a fake clock. The other device shows
 * connected from peerAt on (until peerGoneAfterSends sends, if set), a send
 * takes sendMs, and a send that is not lost shows on the other page arriveMs
 * later. Each wait that ends without its condition uses its whole timeout.
 */
class FakeChat {
  time = 0;
  peerAt = 0;
  peerGoneAfterSends: number | null = null;
  sendMs = 100;
  arriveMs = 50;
  readonly lost = new Set<number>();
  sendError: Error | null = null;
  readonly calls: string[] = [];
  readonly sendTimes: number[] = [];
  /** Each timeout handed to the pages, with the step time left when it was handed over. */
  readonly timeouts: Array<{ timeoutMs: number; leftMs: number }> = [];
  private shownAt = Number.POSITIVE_INFINITY;

  readonly now = (): number => this.time;

  readonly pages: ChatStepPages = {
    waitForPeer: async (timeoutMs) => {
      this.handOver(timeoutMs);
      this.calls.push(`peer ${timeoutMs}`);
      const gone =
        this.peerGoneAfterSends !== null && this.sendTimes.length >= this.peerGoneAfterSends;
      if (!gone && this.peerAt - this.time <= timeoutMs) {
        this.time = Math.max(this.time, this.peerAt);
        return true;
      }
      this.time += timeoutMs;
      return false;
    },
    send: async (timeoutMs) => {
      this.handOver(timeoutMs);
      if (this.sendError) throw this.sendError;
      this.time += this.sendMs;
      this.sendTimes.push(this.time);
      this.calls.push(`send ${this.sendTimes.length}`);
      if (!this.lost.has(this.sendTimes.length)) {
        this.shownAt = Math.min(this.shownAt, this.time + this.arriveMs);
      }
    },
    waitForMessage: async (timeoutMs) => {
      this.handOver(timeoutMs);
      this.calls.push(`message ${timeoutMs}`);
      if (this.shownAt - this.time <= timeoutMs) {
        this.time = Math.max(this.time, this.shownAt);
        return true;
      }
      this.time += timeoutMs;
      return false;
    },
  };

  private handOver(timeoutMs: number): void {
    this.timeouts.push({ timeoutMs, leftMs: STATUS_BROWSER_STEP_TIMEOUT_MS - this.time });
  }
}

describe('status browser monitor chat', () => {
  const STEP = STATUS_BROWSER_STEP_TIMEOUT_MS;
  const RESEND = STATUS_MONITOR_CHAT_RESEND_AFTER_MS;

  /** Every timeout is positive (Playwright reads 0 as none) and inside the step. */
  function expectBoundedTimeouts(chat: FakeChat): void {
    for (const { timeoutMs, leftMs } of chat.timeouts) {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(leftMs);
    }
    expect(chat.time).toBeLessThanOrEqual(STEP);
  }

  it('sends once when the message arrives, after the other device shows connected', async () => {
    const chat = new FakeChat();
    chat.peerAt = 1_200;
    await expect(deliverChatMessage(chat.pages, chat.now)).resolves.toEqual({
      delivered: true,
      sends: 1,
    });
    expect(chat.calls).toEqual([`peer ${STEP}`, 'send 1', `message ${RESEND}`]);
    // The send came only once the other device showed connected.
    expect(chat.sendTimes).toEqual([1_200 + chat.sendMs]);
    expectBoundedTimeouts(chat);
  });

  it('never sends while the other device has not shown connected', async () => {
    const chat = new FakeChat();
    chat.peerAt = Number.POSITIVE_INFINITY;
    await expect(deliverChatMessage(chat.pages, chat.now)).resolves.toEqual({
      delivered: false,
      sends: 0,
    });
    expect(chat.calls).toEqual([`peer ${STEP}`]);
    expect(chat.time).toBe(STEP);

    // Nor sends again once the other device went away.
    const gone = new FakeChat();
    gone.lost.add(1);
    gone.peerGoneAfterSends = 1;
    await expect(deliverChatMessage(gone.pages, gone.now)).resolves.toEqual({
      delivered: false,
      sends: 1,
    });
    expect(gone.calls).toEqual([
      `peer ${STEP}`,
      'send 1',
      `message ${RESEND}`,
      `peer ${STEP - gone.sendMs - RESEND}`,
    ]);
    expectBoundedTimeouts(gone);
  });

  it('sends a lost message again after the resend wait, never inside the App double-send guard', async () => {
    const chat = new FakeChat();
    chat.lost.add(1);
    await expect(deliverChatMessage(chat.pages, chat.now)).resolves.toEqual({
      delivered: true,
      sends: 2,
    });
    expect(chat.calls).toEqual([
      `peer ${STEP}`,
      'send 1',
      `message ${RESEND}`,
      `peer ${STEP - chat.sendMs - RESEND}`,
      'send 2',
      `message ${RESEND}`,
    ]);
    const [first = 0, second = 0] = chat.sendTimes;
    expect(second - first).toBeGreaterThanOrEqual(RESEND);
    expectBoundedTimeouts(chat);

    const late = new FakeChat();
    late.lost.add(1);
    late.lost.add(2);
    await expect(deliverChatMessage(late.pages, late.now)).resolves.toEqual({
      delivered: true,
      sends: STATUS_MONITOR_CHAT_SEND_ATTEMPTS,
    });
  });

  it('stops after the last send has waited until the step ends', async () => {
    const chat = new FakeChat();
    for (let send = 1; send <= STATUS_MONITOR_CHAT_SEND_ATTEMPTS; send += 1) {
      chat.lost.add(send);
    }
    await expect(deliverChatMessage(chat.pages, chat.now)).resolves.toEqual({
      delivered: false,
      sends: STATUS_MONITOR_CHAT_SEND_ATTEMPTS,
    });
    const waits = chat.calls.filter((call) => call.startsWith('message '));
    expect(waits).toHaveLength(STATUS_MONITOR_CHAT_SEND_ATTEMPTS);
    expect(waits.slice(0, -1)).toEqual(
      Array.from({ length: STATUS_MONITOR_CHAT_SEND_ATTEMPTS - 1 }, () => `message ${RESEND}`),
    );
    // The last wait runs to the end of the step, and not a millisecond beyond.
    const lastSentAt = chat.sendTimes.at(-1) ?? 0;
    expect(waits.at(-1)).toBe(`message ${STEP - lastSentAt}`);
    expect(chat.time).toBe(STEP);
    expectBoundedTimeouts(chat);
  });

  it('sends no more than the step leaves time for', async () => {
    const chat = new FakeChat();
    chat.peerAt = STEP - 3_000;
    chat.lost.add(1);
    await expect(deliverChatMessage(chat.pages, chat.now)).resolves.toEqual({
      delivered: false,
      sends: 1,
    });
    expect(chat.calls).toEqual([`peer ${STEP}`, 'send 1', `message ${3_000 - chat.sendMs}`]);
    expect(chat.time).toBe(STEP);
    expectBoundedTimeouts(chat);

    // A send that uses up the step leaves nothing to wait for.
    const slow = new FakeChat();
    slow.sendMs = STEP;
    await expect(deliverChatMessage(slow.pages, slow.now)).resolves.toEqual({
      delivered: false,
      sends: 1,
    });
    expect(slow.calls).toEqual([`peer ${STEP}`, 'send 1']);
  });

  it('ends the step when a send throws', async () => {
    const chat = new FakeChat();
    chat.sendError = new Error('locator.fill: Timeout exceeded');
    await expect(deliverChatMessage(chat.pages, chat.now)).rejects.toThrow('Timeout exceeded');
    expect(chat.calls).toEqual([`peer ${STEP}`]);
  });

  it('fits every send and its wait in one step, apart by more than the App double-send guard', () => {
    const chat = readFileSync(resolve('src/ui/chat.ts'), 'utf8');
    const guard = /if \(text === _lastSentText && now - _lastSentTs < (\d+)\) return;/u.exec(chat);
    expect(guard, 'sendChatMessage double-send guard').not.toBeNull();
    expect(RESEND).toBeGreaterThan(Number(guard?.[1]));
    expect(STATUS_MONITOR_CHAT_SEND_ATTEMPTS).toBeGreaterThan(1);
    // After every resend wait, the last send still gets at least one whole wait.
    expect(STATUS_MONITOR_CHAT_SEND_ATTEMPTS * RESEND).toBeLessThanOrEqual(STEP);
    // The host's per-peer chat rate limit never drops a resend.
    const protocol = readFileSync(resolve('src/chat/protocol.ts'), 'utf8');
    const burst = /^const CHAT_RATE_BURST = (\d+);$/mu.exec(protocol);
    expect(burst, 'CHAT_RATE_BURST').not.toBeNull();
    expect(STATUS_MONITOR_CHAT_SEND_ATTEMPTS).toBeLessThanOrEqual(Number(burst?.[1]));
  });
});

describe('status browser monitor report delivery', () => {
  const body = buildStatusReport(T0, MONITOR_PASSING, monitorFailure('chat_to_guest_failed'));

  async function deliver(...answers: Answer[]) {
    const world = new World().answer(STATUS_REPORT_PATH, ...answers);
    const tokens = createOidcTokenSource(STATUS_REPORT_AUDIENCE, world.deps);
    const delivery = await postStatusReport(body, tokens, world.deps);
    return { world, delivery, reports: world.requestsTo(STATUS_REPORT_PATH) };
  }

  it('posts the exact body once with a report-audience token', async () => {
    const { world, delivery, reports } = await deliver({
      status: 200,
      body: {
        ok: true,
        slotAt: '2026-11-26T05:07:00.000Z',
        recorded: { website: 'o', connection: 'p' },
      },
    });
    expect(delivery).toMatchObject({ verdict: 'delivered', attempts: 1 });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.url).toBe(`${STATUS_MONITOR_APP_ORIGIN}${STATUS_REPORT_PATH}`);
    expect(reports[0]?.method).toBe('POST');
    expect(reports[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(reports[0]?.headers.get('Authorization')).toBe(`Bearer ${world.issued[0]}`);
    expect(reports[0]?.body).toBe(JSON.stringify(body));
    expect(describeDelivered(delivery.answer)).toBe(
      'slot 2026-11-26T05:07:00.000Z, website o, connection p',
    );
    expect(world.sleeps).toEqual([]);
  });

  it('tries again only after a 429, a 5xx or no answer, up to the attempt limit', async () => {
    const recovered = await deliver(
      { status: 503, body: { error: 'STATUS_STORE_UNAVAILABLE' } },
      'network-error',
      { status: 200, body: { ok: true } },
    );
    expect(STATUS_BROWSER_REPORT_ATTEMPTS).toBe(3);
    expect(recovered.delivery).toMatchObject({ verdict: 'delivered', attempts: 3 });
    expect(recovered.world.sleeps).toEqual([
      STATUS_MONITOR_REPORT_RETRY_DELAY_MS,
      STATUS_MONITOR_REPORT_RETRY_DELAY_MS,
    ]);
    expect(recovered.world.lines.filter((line) => line.startsWith('[status-monitor]'))).toEqual([
      '[status-monitor] report attempt 1 got HTTP 503 (STATUS_STORE_UNAVAILABLE); trying again',
      '[status-monitor] report attempt 2 got no answer; trying again',
    ]);

    const limited = await deliver({ status: 429, body: { error: 'RATE_LIMITED' } });
    expect(limited.delivery).toMatchObject({
      verdict: 'unavailable',
      attempts: STATUS_BROWSER_REPORT_ATTEMPTS,
    });
    expect(limited.reports).toHaveLength(STATUS_BROWSER_REPORT_ATTEMPTS);

    const exhausted = await deliver({ status: 500, body: {} });
    expect(exhausted.reports).toHaveLength(STATUS_BROWSER_REPORT_ATTEMPTS);
    expect(exhausted.delivery).toMatchObject({ verdict: 'unavailable', answer: { status: 500 } });

    const silent = await deliver('network-error');
    expect(silent.reports).toHaveLength(STATUS_BROWSER_REPORT_ATTEMPTS);
    expect(silent.delivery).toEqual({
      verdict: 'unavailable',
      answer: null,
      attempts: STATUS_BROWSER_REPORT_ATTEMPTS,
    });
  });

  it('never repeats a definite answer', async () => {
    for (const status of [400, 401, 403, 404, 405, 409, 413, 415, 422]) {
      const { delivery, reports } = await deliver({ status, body: { error: 'X' } });
      expect(reports, String(status)).toHaveLength(1);
      expect(delivery.verdict, String(status)).toBe(
        status === 401 || status === 403 ? 'unauthorized' : 'mismatch',
      );
    }
    const unconfirmed = await deliver({ status: 200, body: { ok: false } });
    expect(unconfirmed.reports).toHaveLength(1);
    expect(unconfirmed.delivery.verdict).toBe('mismatch');
  });

  it('classifies every report route answer', () => {
    const verdict = (answer: JsonAnswer | null): ReportVerdict => classifyReportAnswer(answer);
    expect(verdict({ status: 200, body: { ok: true, slotAt: 'x', recorded: {} } })).toBe(
      'delivered',
    );
    expect(verdict({ status: 200, body: { ok: false } })).toBe('mismatch');
    expect(verdict({ status: 200, body: null })).toBe('mismatch');
    expect(verdict({ status: 204, body: null })).toBe('mismatch');
    expect(verdict({ status: 401, body: { error: 'OIDC_TOKEN_INVALID' } })).toBe('unauthorized');
    expect(verdict({ status: 403, body: { error: 'OIDC_TOKEN_FORBIDDEN' } })).toBe('unauthorized');
    for (const status of [400, 404, 405, 409, 413, 415, 422]) {
      expect(verdict({ status, body: { error: 'X' } }), String(status)).toBe('mismatch');
    }
    expect(verdict({ status: 429, body: { error: 'RATE_LIMITED' } })).toBe('unavailable');
    for (const status of [500, 502, 503, 504]) {
      expect(verdict({ status, body: null }), String(status)).toBe('unavailable');
    }
    expect(verdict(null)).toBe('unavailable');
  });

  it('describes answers without their bodies', () => {
    expect(describeAnswer(null)).toBe('no answer');
    expect(describeAnswer({ status: 503, body: { error: 'STATUS_STORE_UNAVAILABLE' } })).toBe(
      'HTTP 503 (STATUS_STORE_UNAVAILABLE)',
    );
    expect(describeAnswer({ status: 400, body: { error: 'roomId 482913 is bad' } })).toBe(
      'HTTP 400 (unknown)',
    );
    expect(describeDelivered({ status: 200, body: { ok: true } })).toBe(
      'slot unknown, website none, connection none',
    );
  });
});

describe('status browser monitor exit code', () => {
  const answers: Record<ReportVerdict, JsonAnswer | null> = {
    delivered: { status: 200, body: { ok: true } },
    unavailable: { status: 503, body: { error: 'STATUS_STORE_UNAVAILABLE' } },
    unauthorized: { status: 403, body: { error: 'OIDC_TOKEN_FORBIDDEN' } },
    mismatch: { status: 400, body: { error: 'INVALID_REQUEST' } },
  };
  const delivery = (verdict: ReportVerdict, attempts = 1): ReportDelivery => ({
    verdict,
    answer: answers[verdict],
    attempts,
  });
  type Claims = Pick<ClaimGateSummary, 'authRefused' | 'contractMismatch'> | null;
  const quiet: Claims = { authRefused: false, contractMismatch: false };
  const run = (verdict: ReportVerdict, claims: Claims = quiet): StatusMonitorRun => ({
    preflight: 'run',
    delivery: delivery(verdict),
    claims,
  });

  it('ends successfully when production has no status API yet', () => {
    expect(statusMonitorExitCode({ preflight: 'not-deployed' })).toBe(0);
    expect(statusMonitorEndAnnotations({ preflight: 'not-deployed' })).toEqual([]);
  });

  it('ends successfully after a delivered report, failed checks included', () => {
    // The report body carries the failed rows; the exit code never reads it.
    expect(statusMonitorExitCode(run('delivered'))).toBe(0);
    expect(statusMonitorEndAnnotations(run('delivered'))).toEqual([]);
    const maintenance: StatusMonitorRun = {
      preflight: 'maintenance',
      delivery: delivery('delivered'),
      claims: null,
    };
    expect(statusMonitorExitCode(maintenance)).toBe(0);
    expect(statusMonitorEndAnnotations(maintenance)).toEqual([]);
    // A 409 or 424 claim answer is part of the claim route's contract.
    for (const stoppedBy of ['room_active', 'unsupported', 'maintenance'] as const) {
      const summary: ClaimGateSummary = { ...QUIET_GATE, claimed: 0, refused: 1, stoppedBy };
      expect(statusMonitorExitCode(run('delivered', summary)), stoppedBy).toBe(0);
    }
  });

  it('ends successfully with a warning when the report is still unavailable after every attempt', () => {
    for (const answer of [
      { status: 429, body: { error: 'RATE_LIMITED' } },
      { status: 503, body: { error: 'STATUS_STORE_UNAVAILABLE' } },
      null,
    ]) {
      const unavailable: StatusMonitorRun = {
        preflight: 'run',
        delivery: { verdict: 'unavailable', answer, attempts: STATUS_BROWSER_REPORT_ATTEMPTS },
        claims: quiet,
      };
      expect(statusMonitorExitCode(unavailable)).toBe(0);
      expect(statusMonitorEndAnnotations(unavailable)).toEqual([
        {
          kind: 'warning',
          message:
            `The report was not delivered: ${describeAnswer(answer)} after ` +
            `${STATUS_BROWSER_REPORT_ATTEMPTS} attempt(s). Until a report lands, the website ` +
            'and connection rows age to Not checked.',
        },
      ]);
    }
    const maintenance: StatusMonitorRun = {
      preflight: 'maintenance',
      delivery: delivery('unavailable', STATUS_BROWSER_REPORT_ATTEMPTS),
      claims: null,
    };
    expect(statusMonitorExitCode(maintenance)).toBe(0);
    expect(statusMonitorEndAnnotations(maintenance).map((annotation) => annotation.kind)).toEqual([
      'warning',
    ]);
  });

  it('ends successfully with a warning when GitHub gave no token at the start of the run', () => {
    const tokensUnavailable =
      'GitHub Actions OIDC did not issue a token for /api/ops/status-report (HTTP 503).';
    for (const preflight of ['run', 'maintenance'] as const) {
      const ended: StatusMonitorRun = { preflight, tokensUnavailable };
      expect(statusMonitorExitCode(ended), preflight).toBe(0);
      expect(statusMonitorEndAnnotations(ended)).toEqual([
        {
          kind: 'warning',
          message:
            `${tokensUnavailable} No checks ran. Until a report lands, the website and ` +
            'connection rows age to Not checked.',
        },
      ]);
    }
  });

  it('fails the job when the report route refuses its identity or answers outside its contract', () => {
    expect(statusMonitorExitCode(run('unauthorized'))).toBe(1);
    expect(statusMonitorEndAnnotations(run('unauthorized'))).toEqual([
      {
        kind: 'error',
        message: "The report route refused this job's identity: HTTP 403 (OIDC_TOKEN_FORBIDDEN).",
      },
    ]);
    expect(statusMonitorExitCode(run('mismatch'))).toBe(1);
    expect(statusMonitorEndAnnotations(run('mismatch'))).toEqual([
      {
        kind: 'error',
        message: 'The report route answered HTTP 400 (INVALID_REQUEST), outside its contract.',
      },
    ]);
    for (const verdict of ['unauthorized', 'mismatch'] as const) {
      const maintenance: StatusMonitorRun = {
        preflight: 'maintenance',
        delivery: delivery(verdict),
        claims: null,
      };
      expect(statusMonitorExitCode(maintenance), verdict).toBe(1);
    }
  });

  it('fails the job when the claim route refuses its identity or answers outside its contract', () => {
    const refused = { ...QUIET_GATE, claimed: 0, refused: 1, stoppedBy: 'unauthorized' as const };
    const mismatch = { ...QUIET_GATE, claimed: 0, refused: 1, stoppedBy: 'rejected' as const };
    for (const verdict of ['delivered', 'unavailable'] as const) {
      expect(statusMonitorExitCode(run(verdict, { ...refused, authRefused: true })), verdict).toBe(
        1,
      );
      expect(
        statusMonitorExitCode(run(verdict, { ...mismatch, contractMismatch: true })),
        verdict,
      ).toBe(1);
    }
    expect(
      statusMonitorEndAnnotations(run('delivered', { ...refused, authRefused: true })),
    ).toEqual([
      { kind: 'error', message: "The claim route refused this job's identity (401 or 403)." },
    ]);
    expect(
      statusMonitorEndAnnotations(run('delivered', { ...mismatch, contractMismatch: true })),
    ).toEqual([{ kind: 'error', message: 'The claim route answered outside its contract.' }]);
    // Every failure is reported, the report's first.
    expect(
      statusMonitorEndAnnotations(
        run('unauthorized', { authRefused: true, contractMismatch: true }),
      ).map((annotation) => annotation.message),
    ).toEqual([
      "The report route refused this job's identity: HTTP 403 (OIDC_TOKEN_FORBIDDEN).",
      "The claim route refused this job's identity (401 or 403).",
      'The claim route answered outside its contract.',
    ]);
  });

  it('fails the job exactly when the run ends with an error annotation', () => {
    const verdicts: ReportVerdict[] = ['delivered', 'unavailable', 'unauthorized', 'mismatch'];
    for (const verdict of verdicts) {
      for (const claims of [
        null,
        quiet,
        { authRefused: true, contractMismatch: false },
        { authRefused: false, contractMismatch: true },
        { authRefused: true, contractMismatch: true },
      ]) {
        const ended: StatusMonitorRun = { preflight: 'run', delivery: delivery(verdict), claims };
        const errors = statusMonitorEndAnnotations(ended).filter(
          (annotation) => annotation.kind === 'error',
        );
        expect(statusMonitorExitCode(ended), `${verdict} ${JSON.stringify(claims)}`).toBe(
          errors.length > 0 ? 1 : 0,
        );
      }
    }
    for (const preflight of ['run', 'maintenance'] as const) {
      const ended: StatusMonitorRun = {
        preflight,
        tokensUnavailable:
          'GitHub Actions OIDC did not issue a token for /api/ops/status-claim (no answer).',
      };
      const errors = statusMonitorEndAnnotations(ended).filter(
        (annotation) => annotation.kind === 'error',
      );
      expect(statusMonitorExitCode(ended), preflight).toBe(errors.length > 0 ? 1 : 0);
    }
  });

  it('logs no body, token or room code in its annotations', () => {
    const leaky: StatusMonitorRun = {
      preflight: 'run',
      delivery: {
        verdict: 'mismatch',
        answer: { status: 400, body: { error: `room ${ROOM} token ${oidcToken(1)}` } },
        attempts: 1,
      },
      claims: quiet,
    };
    const [annotation] = statusMonitorEndAnnotations(leaky);
    expect(annotation?.message).toBe(
      'The report route answered HTTP 400 (unknown), outside its contract.',
    );
  });
});

describe('status browser monitor diagnostics', () => {
  it('shows no room code, peer id, token, IP address or full URL', () => {
    const jwt = oidcToken(1_800_000_000);
    const line = sanitizeMonitorDiagnostic(
      `WebSocket wss://signal.musixquare.com/api/rooms/${ROOM}/ws?role=host&peerId=mx-hostPeer01 ` +
        `failed; room ${ROOM} peer mx-Ab3_dEf-9 token ${jwt} from 203.0.113.7 and ` +
        `2001:db8::8a2e:370:7334 or fe80::1%en0, secret Zx8kQ2mV9pL4nR7tW1yB3cD6fG0hJ5 ` +
        'code SIGNALING_HOST_ADMISSION_TIMEOUT at 12:34:56 after 1500 ms',
    );
    expect(line).not.toContain(ROOM);
    expect(line).not.toContain('mx-');
    expect(line).not.toContain(jwt);
    expect(line).not.toContain('203.0.113.7');
    expect(line).not.toContain('2001:db8');
    expect(line).not.toContain('fe80');
    expect(line).not.toContain('/api/rooms');
    expect(line).not.toContain('Zx8kQ2mV9pL4nR7tW1yB3cD6fG0hJ5');
    expect(line).toContain('wss://signal.musixquare.com/[path]');
    expect(line).toContain('SIGNALING_HOST_ADMISSION_TIMEOUT');
    expect(line).toContain('12:34:56');
    expect(line).toContain('1500 ms');
  });

  it('keeps one line, so page text can never start a workflow command', () => {
    const newline = String.fromCharCode(10);
    const lineSeparator = String.fromCharCode(0x2028);
    const carriage = String.fromCharCode(13);
    const line = sanitizeMonitorDiagnostic(
      `console error: boom${newline}::add-mask::x${lineSeparator}::error::forged${carriage}::x`,
    );
    expect(line.startsWith('console error: boom ')).toBe(true);
    expect(line).toMatch(/ ::error::forged ::x$/u);
    expect([newline, carriage, lineSeparator].some((separator) => line.includes(separator))).toBe(
      false,
    );
    expect(sanitizeMonitorDiagnostic('x'.repeat(500))).toHaveLength(240);
  });
});

describe('status browser monitor transport parity', () => {
  const source = (path: string): string =>
    readFileSync(resolve(path), 'utf8').replace(/\r\n/gu, '\n');

  it('gates the signaling hosts the App connects to', () => {
    const config = source('src/network/transport/config.ts');
    const urls = [
      ...config.matchAll(/^const PUBLIC_SIGNALING(?:_FALLBACK)?_URL = '([^']+)';$/gmu),
    ].map((match) => new URL(match[1] ?? ''));
    expect(urls.map((url) => url.origin)).toEqual([
      ...STATUS_MONITOR_SIGNALING_ENDPOINTS.socketOrigins,
    ]);
    expect(urls.map((url) => url.pathname)).toEqual(['/api/rooms', '/api/rooms']);
    expect(
      STATUS_MONITOR_SIGNALING_ENDPOINTS.httpOrigins.map((origin) =>
        origin.replace(/^https:/u, 'wss:'),
      ),
    ).toEqual([...STATUS_MONITOR_SIGNALING_ENDPOINTS.socketOrigins]);

    const transport = source('src/network/transport/cloudflare-signaling.ts');
    const standardPath =
      "base.pathname = `${base.pathname.replace(/\\/+$/, '')}/${encodeURIComponent(roomId)}/ws`;";
    const start = transport.indexOf(standardPath);
    expect(start).toBeGreaterThan(-1);
    const end = transport.indexOf('return base.toString();', start);
    expect(end).toBeGreaterThan(start);
    // classifyMonitorWebSocket accepts a host socket whose query has exactly
    // these two keys, so the Standard branch's whole query is pinned: a third
    // key fails here, not on every monitor run after the release. The monitor
    // runs from main against the released App: when this pin fails because of
    // an App change, let classifyMonitorWebSocket accept both the released and
    // main's key sets (with a lib test for each) until the release that ships
    // the change is live, then drop the old set.
    const query = transport
      .slice(transport.indexOf('\n', start) + 1, end)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//'));
    expect(query).toEqual([
      "base.search = '';",
      "base.searchParams.set('role', role);",
      "base.searchParams.set('peerId', peerId);",
    ]);
  });

  it('gates the HTTP bridge the App falls back to', () => {
    const bridge = source('src/network/transport/standard-http-signaling.ts');
    expect(bridge).toContain("options.endpointPrefix ?? '/api/standard-signaling/v1/bridge'");
    expect(bridge).toMatch(
      /const body = JSON\.stringify\(\{\s+roomId: this\.#options\.roomId,\s+role: this\.#options\.role,\s+peerId: this\.#options\.peerId,\s+\}\);/u,
    );
    for (const path of ['send', 'poll', 'close']) {
      expect(bridge).toContain(`\`\${this.#endpoint}/${path}\``);
    }
    expect(STATUS_MONITOR_SIGNALING_ENDPOINTS.appOrigin).toBe(STATUS_MONITOR_APP_ORIGIN);
  });

  it('knows every place the App opens a signaling socket or bridge', () => {
    // A new opener is a new way to deliver a host's first frame: review the
    // gate (the classifiers above) in the same change.
    const sources = globSync('src/**/*.ts')
      .map((file) => file.split(sep).join('/'))
      .filter((file) => !file.includes('/__tests__/'));
    const openers = (pattern: RegExp): string[] =>
      sources.filter((file) => pattern.test(readFileSync(file, 'utf8'))).sort();
    expect(openers(/\bnew WebSocket\(/u)).toEqual([
      'src/network/transport/cloudflare-signaling.ts',
      'src/pro-room/network-bridge.ts',
    ]);
    expect(openers(/\bnew StandardHttpSignalingSocket\(/u)).toEqual([
      'src/network/transport/cloudflare-signaling.ts',
    ]);
    expect(openers(/\bendpointPrefix\b/u)).toEqual([
      'src/network/transport/standard-http-signaling.ts',
    ]);
  });

  it('waits for the device row that only a connected peer gets before each chat send', () => {
    // A change to any of these is a change to when a chat message can be lost:
    // review deliverChatMessage and the selector in the same change.
    expect(STATUS_MONITOR_PEER_ROW_SELECTOR).toBe(
      '#connect-device-list .device-row:not(.is-current-member)',
    );
    expect(source('index.html')).toContain(
      '<div id="connect-device-list" class="device-list"></div>',
    );

    const connect = source('src/ui/connect.ts');
    expect(connect).toContain("getUiElement('connect-device-list'),");
    expect(connect).toContain(
      "row.className = `device-row${member.isCurrent ? ' is-current-member' : ''}`;",
    );
    expect(connect).toMatch(
      /_busScope\.on\('network:device-list-update', \(list: unknown\[\]\) => \{\s+if \(Array\.isArray\(list\)\) \{\s+renderConnectDeviceList\(list\);/u,
    );

    const peerState = source('src/network/peer-state.ts');
    const body = (name: string): string => {
      const start = peerState.indexOf(`export function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      return peerState.slice(start, peerState.indexOf('\n}\n', start));
    };
    // The chat broadcast skips a peer that is not connected yet ...
    expect(body('broadcast')).toContain("if (p.status === 'connected' && p.conn) {");
    // ... and the device list holds only connected peers besides the host itself.
    const deviceList = body('broadcastDeviceList');
    expect(deviceList).toContain(".filter((peer) => peer.status === 'connected')");
    expect(deviceList).toContain("bus.emit('network:device-list', list);");

    // The host renders its own list; a guest renders only the list its host sent.
    expect(source('src/network/host.ts')).toMatch(
      /bus\.on\('network:device-list', \(list\) => \{\s+if \(Array\.isArray\(list\)\) \{\s+setState\('network\.lastKnownDeviceList', list as DeviceInfo\[\]\);\s+bus\.emit\('network:device-list-update', list\);/u,
    );
    const guest = source('src/network/guest.ts');
    const update = guest.slice(guest.indexOf('function handleDeviceListUpdateMsg('));
    expect(update).toMatch(
      /^function handleDeviceListUpdateMsg\([^)]*\): void \{[\s\S]*?if \(!hostConn \|\| conn !== hostConn\) return;[\s\S]*?setState\('network\.lastKnownDeviceList', list\);\s+bus\.emit\('network:device-list-update', list\);\n\}/u,
    );

    const script = source('scripts/status-browser-monitor.ts');
    expect(script).toContain('.locator(STATUS_MONITOR_PEER_ROW_SELECTOR)');
    expect(script).toContain('deliverChatMessage(');
  });

  it('uses only App selectors that the App still renders', () => {
    // The monitor runs from main against the released App. When a pin below
    // fails because of an App change, keep the monitor accepting both the
    // released form and main's form until the release that ships the change is
    // live, then drop the old form: a selector takes a comma-joined
    // alternative ('#old-id, #new-id'), which passes here while one of its
    // alternatives names only ids the App renders.
    const script = source('scripts/status-browser-monitor.ts');
    const literals = [...script.matchAll(/'[^'\n]*'/gu)]
      .map((match) => match[0].slice(1, -1))
      .filter((literal) => literal.includes('#'));
    const idsOf = (selector: string): string[] =>
      [...selector.matchAll(/#([a-z][\w-]*)/gu)].map((match) => match[1] ?? '');
    // Every id the monitor waits for or reads; a new one joins this list.
    expect([...new Set(literals.flatMap(idsOf))].sort()).toEqual([
      'btn-chat-send',
      'btn-dialog-secondary',
      'btn-setup-confirm',
      'btn-setup-guest',
      'btn-setup-host',
      'chat-input',
      'chat-messages',
      'dialog-overlay',
      'dialog-title',
      'setup-code',
      'setup-code-area',
      'setup-guest-error',
      'setup-host-error',
      'setup-join-area',
      'setup-join-code',
      'setup-overlay',
    ]);

    // The page markup, the start screen's two buttons, and the confirm button
    // that both the host and the guest setup render.
    const html = source('index.html');
    const setup = source('src/ui/setup.ts');
    const setupFlows = [source('src/ui/setup-host.ts'), source('src/ui/setup-guest.ts')];
    const rendered = (id: string): boolean =>
      html.includes(`id="${id}"`) ||
      setup.includes(`id: '${id}',`) ||
      setupFlows.every((flow) => flow.includes(`id: '${id}'`));
    for (const literal of literals) {
      const alternatives = literal.split(',').map(idsOf);
      expect(
        alternatives.some((ids) => ids.length > 0 && ids.every(rendered)),
        literal,
      ).toBe(true);
    }

    // The state classes the monitor waits on.
    const dom = source('src/ui/dom.ts');
    expect(dom).toContain("{ id: 'setup-overlay', cls: 'active', fullscreen: true },");
    expect(dom).toContain("{ id: 'dialog-overlay', cls: 'show', fullscreen: false },");
    expect(script).toContain("'#setup-overlay.active'");
    expect(script).toContain("'#dialog-overlay.show'");

    // The boot states the website check ends on.
    const app = source('src/app.ts');
    expect(app).toContain('root.dataset.bootstrapState = state;');
    expect(app).toContain(
      "type PublishedBootstrapState = BootstrapReadinessSnapshot['state'] | 'bootstrapping' | 'aborted';",
    );
    expect(source('src/core/bootstrap-readiness.ts')).toContain("? 'degraded' : 'ready'");
    for (const state of ['ready', 'degraded', 'aborted']) {
      expect(script).toContain(`html[data-bootstrap-state="${state}"]`);
    }
  });

  it('keeps the browser script on Locator waits, with no screenshot or page script', () => {
    const script = source('scripts/status-browser-monitor.ts');
    expect(script).not.toMatch(/\.waitForFunction\(|\.waitForTimeout\(|\.evaluate\(/u);
    expect(script).not.toMatch(/\.screenshot\(|\.\$\$?eval\(/u);
    expect(script).not.toContain('console.');
    expect(script).toContain("serviceWorkers: 'block'");
    expect(script).toContain("locale: 'en-US'");
  });
});

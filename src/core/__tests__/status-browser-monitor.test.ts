import { Buffer } from 'node:buffer';
import { globSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STATUS_BROWSER_CLAIM_TIMEOUT_MS,
  STATUS_BROWSER_REPORT_ATTEMPTS,
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
  STATUS_MONITOR_APP_ORIGIN,
  STATUS_MONITOR_REFUSED_CLOSE_CODE,
  STATUS_MONITOR_REPORT_RETRY_DELAY_MS,
  STATUS_MONITOR_SIGNALING_ENDPOINTS,
  STATUS_MONITOR_TOKEN_REFRESH_MARGIN_MS,
  buildStatusReport,
  classifyClaimAnswer,
  classifyDocumentResponse,
  classifyMonitorRequest,
  classifyMonitorWebSocket,
  classifyStatusPreflight,
  connectionAfterWebsite,
  connectionResult,
  createOidcTokenSource,
  describeAnswer,
  describeDelivered,
  mintOidcToken,
  monitorFailure,
  monitorSkipped,
  postStatusReport,
  readStatusPreflight,
  requestStatusClaim,
  routeMonitorRequest,
  routeMonitorWebSocket,
  sanitizeMonitorDiagnostic,
  statusMonitorExitCode,
  type ClaimGateSummary,
  type ClaimVerdict,
  type MonitorPageSocket,
  type MonitorServerSocket,
  type MonitorSocketCloseOptions,
  type MonitorSocketMessage,
  type OidcTokenSource,
  type StatusMonitorDeps,
} from '../../../scripts/lib/status-browser-monitor-lib.mts';

// Synthetic room codes and peer ids only.
const ROOM = '482913';
const OTHER_ROOM = '730158';
const HOST_SOCKET = `wss://signal.musixquare.com/api/rooms/${ROOM}/ws?role=host&peerId=mx-hostPeer01`;
const OIDC_REQUEST_URL = 'https://pipelines.actions.example/idtoken?api-version=2.0';
const OIDC_REQUEST_TOKEN = 'actions-request-token';
const T0 = Date.parse('2026-11-26T05:07:41.000Z');

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
}

type Answer = { readonly status: number; readonly body?: unknown } | 'network-error';

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
  oidcAnswer: { readonly status: number; readonly body: unknown } | null = null;
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
      if (this.oidcAnswer) return json(this.oidcAnswer.status, this.oidcAnswer.body);
      const token = oidcToken(this.mintExpiry, `sig${this.issued.length + 1}`);
      this.issued.push(token);
      return json(200, { value: token });
    }
    const queue = this.answers.get(parsed.pathname) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error(`no answer configured for ${parsed.pathname}`);
    if (next === 'network-error') throw new TypeError('fetch failed');
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
    const world = new World().answer(STATUS_PUBLIC_PATH, {
      status: 200,
      body: { schemaVersion: 1, maintenance: { active: true, since: null } },
    });

    await expect(readStatusPreflight(world.deps)).resolves.toMatchObject({
      preflight: 'maintenance',
    });
    expect(world.requests).toHaveLength(1);
    expect(world.requests[0]?.url).toBe(`${STATUS_MONITOR_APP_ORIGIN}${STATUS_PUBLIC_PATH}`);
    expect(world.requests[0]?.method).toBe('GET');
    expect(world.requests[0]?.headers.get('Authorization')).toBeNull();
    expect(world.lines).toEqual([]);

    const unreachable = new World().answer(STATUS_PUBLIC_PATH, 'network-error');
    await expect(readStatusPreflight(unreachable.deps)).resolves.toEqual({
      preflight: 'not-deployed',
      answer: null,
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
    expect(delivery).toMatchObject({ delivered: true, authRefused: false, attempts: 1 });
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
    expect(recovered.delivery).toMatchObject({ delivered: true, attempts: 3 });
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
      delivered: false,
      authRefused: false,
      attempts: STATUS_BROWSER_REPORT_ATTEMPTS,
    });
    expect(limited.reports).toHaveLength(STATUS_BROWSER_REPORT_ATTEMPTS);

    const exhausted = await deliver({ status: 500, body: {} });
    expect(exhausted.reports).toHaveLength(STATUS_BROWSER_REPORT_ATTEMPTS);
    expect(exhausted.delivery.delivered).toBe(false);
  });

  it('never repeats a definite answer', async () => {
    for (const status of [400, 401, 403, 404, 405, 415]) {
      const { delivery, reports } = await deliver({ status, body: { error: 'X' } });
      expect(reports, String(status)).toHaveLength(1);
      expect(delivery.delivered).toBe(false);
      expect(delivery.authRefused).toBe(status === 401 || status === 403);
    }
    const unconfirmed = await deliver({ status: 200, body: { ok: false } });
    expect(unconfirmed.reports).toHaveLength(1);
    expect(unconfirmed.delivery.delivered).toBe(false);
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
  it('fails the job only when its identity is refused or the report is not delivered', () => {
    const exit = (
      preflight: 'not-deployed' | 'maintenance' | 'run',
      delivered: boolean,
      authRefused: boolean,
    ) => statusMonitorExitCode({ preflight, delivered, authRefused });

    expect(exit('not-deployed', false, false)).toBe(0);
    expect(exit('run', true, false)).toBe(0);
    expect(exit('maintenance', true, false)).toBe(0);
    // The claim route refused the identity although the report landed.
    expect(exit('run', true, true)).toBe(1);
    expect(exit('run', false, true)).toBe(1);
    expect(exit('run', false, false)).toBe(1);
    expect(exit('maintenance', false, false)).toBe(1);
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
    expect(transport).toContain(
      "base.pathname = `${base.pathname.replace(/\\/+$/, '')}/${encodeURIComponent(roomId)}/ws`;",
    );
    expect(transport).toContain("base.searchParams.set('role', role);");
    expect(transport).toContain("base.searchParams.set('peerId', peerId);");
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

  it('keeps the browser script on Locator waits, with no screenshot or page script', () => {
    const script = source('scripts/status-browser-monitor.ts');
    expect(script).not.toMatch(/\.waitForFunction\(|\.waitForTimeout\(|\.evaluate\(/u);
    expect(script).not.toMatch(/\.screenshot\(|\.\$\$?eval\(/u);
    expect(script).not.toContain('console.');
    expect(script).toContain("serviceWorkers: 'block'");
    expect(script).toContain("locale: 'en-US'");
  });
});

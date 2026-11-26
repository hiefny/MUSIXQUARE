import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_BUILD_FLOOR_OPS_AUDIENCE } from '../../../cloudflare/app-build-floor-contract.ts';
import {
  GITHUB_ACTIONS_OIDC_ISSUER,
  GITHUB_ACTIONS_OIDC_JWKS_URL,
  GITHUB_ACTIONS_OIDC_TOKEN_MAX_BYTES,
  resetGitHubActionsOidcCacheForTests,
  verifyGitHubActionsOidcToken,
} from '../../../cloudflare/github-actions-oidc.ts';
import {
  STATUS_CLAIM_AUDIENCE,
  STATUS_CLAIM_PATH,
  STATUS_MONITOR_WORKFLOW_REF,
  STATUS_OPS_RATE_LIMIT,
  STATUS_OPS_RATE_WINDOW_SECONDS,
  STATUS_REPORT_AUDIENCE,
  STATUS_REPORT_BODY_MAX_BYTES,
  STATUS_REPORT_MAX_AGE_MS,
  STATUS_REPORT_MAX_FUTURE_SKEW_MS,
  STATUS_REPORT_PATH,
  type StatusCheckRow,
  type StatusProbeClaimOutcome,
} from '../../../cloudflare/status-contract.ts';
import {
  STATUS_CLAIM_POLICY,
  STATUS_OPS_BODY_VERSION,
  STATUS_REPORT_COMPONENTS,
  STATUS_REPORT_OUTCOMES,
  STATUS_REPORT_POLICY,
  handleStatusClaim,
  handleStatusReport,
  type StatusClaimDeps,
  type StatusOpsJsonBody,
  type StatusOpsMaintenance,
  type StatusOpsRateLimit,
  type StatusReportDeps,
} from '../../../cloudflare/status-ops.ts';

// Wrap the real verifier so the tests can prove when it never ran.
vi.mock('../../../cloudflare/github-actions-oidc.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../cloudflare/github-actions-oidc.ts')>();
  return { ...actual, verifyGitHubActionsOidcToken: vi.fn(actual.verifyGitHubActionsOidcToken) };
});

const verifySpy = vi.mocked(verifyGitHubActionsOidcToken);

const ORIGIN = 'https://musixquare.com';
const NOW = Date.parse('2026-11-26T05:30:00.000Z');
const MONITOR_REPOSITORY = 'hiefny/MUSIXQUARE';
const CI_WORKFLOW = 'hiefny/MUSIXQUARE/.github/workflows/ci.yml@refs/heads/main';
const RECOVERY_WORKFLOW =
  'hiefny/MUSIXQUARE/.github/workflows/release-recovery.yml@refs/heads/main';
// Synthetic Standard room codes.
const ROOM_ID = '123456';
const OTHER_ROOM_ID = '654321';

// Signing-key and claims helpers, copied from app-build-floor-ops.test.ts.

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

async function signToken(key: SigningKey, claims: Record<string, unknown>): Promise<string> {
  const head = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid }));
  const body = base64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * A genuine token of the status monitor's scheduled job on main: it names no
 * environment, so it carries no environment claim, and it runs its own steps,
 * so it carries no job_workflow_ref. An override of undefined drops a claim.
 */
function monitorClaims(
  audience: string,
  nowMs: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(nowMs / 1_000);
  return {
    jti: '5f0c4e1e-0000-4000-8000-000000000003',
    sub: `repo:${MONITOR_REPOSITORY}:ref:refs/heads/main`,
    aud: audience,
    ref: 'refs/heads/main',
    sha: 'a'.repeat(40),
    repository: MONITOR_REPOSITORY,
    repository_owner: 'hiefny',
    repository_owner_id: '257024056',
    repository_id: '1141408724',
    repository_visibility: 'public',
    run_id: '9000000001',
    run_number: '7',
    run_attempt: '1',
    actor: 'hiefny',
    actor_id: '257024056',
    workflow: 'Status monitor',
    event_name: 'schedule',
    ref_type: 'branch',
    ref_protected: 'true',
    workflow_ref: STATUS_MONITOR_WORKFLOW_REF,
    workflow_sha: 'a'.repeat(40),
    runner_environment: 'github-hosted',
    iss: GITHUB_ACTIONS_OIDC_ISSUER,
    nbf: now - 5,
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

/** GitHub's key set behind a counted fetch stub. */
function installJwks(keys: readonly (JsonWebKey & { kid?: string })[], status = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== GITHUB_ACTIONS_OIDC_JWKS_URL) throw new Error(`Unexpected fetch ${url}`);
    return new Response(JSON.stringify({ keys }), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// App Worker helper fakes with the App's shapes.

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...headers,
    },
  });
}

async function readJsonBodyLimited(request: Request, maxBytes: number): Promise<StatusOpsJsonBody> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) return { error: 'too-large' };
  if (bytes.byteLength === 0) return { error: 'invalid' };
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return { value };
  } catch {
    return { error: 'invalid' };
  }
}

function jsonBodyError(result: StatusOpsJsonBody) {
  if (result.error === 'too-large') return json({ error: 'Request body too large' }, 413);
  if (result.error === 'timeout') return json({ error: 'Request body timed out' }, 408);
  return json({ error: 'Invalid JSON body' }, 400);
}

interface HarnessOptions {
  nowMs?: number;
  rate?: StatusOpsRateLimit;
  maintenance?: StatusOpsMaintenance | Error;
  recordError?: Error;
  claim?: StatusProbeClaimOutcome | Error;
}

function harness(options: HarnessOptions = {}) {
  const calls = {
    rate: [] as { endpoint: string; limit: number; windowSec: number }[],
    bodyReads: [] as number[],
    maintenanceReads: 0,
    records: [] as (readonly StatusCheckRow[])[],
    claims: [] as string[],
  };
  const deps: StatusReportDeps & StatusClaimDeps = {
    json,
    checkPaidRateLimit: async (_request, endpoint, limit, windowSec) => {
      calls.rate.push({ endpoint, limit, windowSec });
      return options.rate ?? { status: 'ok', allowed: true, retryAfterSeconds: 0 };
    },
    rateLimitResponse: (retryAfterSeconds) =>
      json({ error: 'Too Many Requests' }, 429, {
        'Retry-After': String(Math.max(1, retryAfterSeconds ?? 60)),
      }),
    rateLimitUnavailableResponse: () => json({ error: 'RATE_LIMIT_UNAVAILABLE' }, 503),
    readJsonBodyLimited: async (request, maxBytes) => {
      calls.bodyReads.push(maxBytes);
      return readJsonBodyLimited(request, maxBytes);
    },
    jsonBodyError,
    readMaintenance: async () => {
      calls.maintenanceReads += 1;
      if (options.maintenance instanceof Error) throw options.maintenance;
      return options.maintenance ?? { enabled: false };
    },
    record: async (rows) => {
      calls.records.push(rows);
      if (options.recordError) throw options.recordError;
    },
    claim: async (roomId) => {
      calls.claims.push(roomId);
      if (options.claim instanceof Error) throw options.claim;
      return options.claim ?? 'claimed';
    },
    nowMs: () => options.nowMs ?? NOW,
  };
  return { deps, calls };
}

interface PostOptions {
  token?: string | null;
  method?: string;
  contentType?: string;
  authorization?: string;
  headers?: Record<string, string>;
}

function opsRequest(path: string, body: unknown, options: PostOptions = {}) {
  const method = options.method ?? 'POST';
  const headers: Record<string, string> = {
    'Content-Type': options.contentType ?? 'application/json',
    'CF-Connecting-IP': '192.0.2.50',
    ...options.headers,
  };
  if (options.authorization !== undefined) headers.Authorization = options.authorization;
  else if (options.token) headers.Authorization = `Bearer ${options.token}`;
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD'
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function reportBody(overrides: Record<string, unknown> = {}, startedAtMs = NOW - 3 * 60_000) {
  return {
    v: 1,
    startedAt: iso(startedAtMs),
    results: {
      website: { outcome: 'ok', reason: 'passing' },
      connection: { outcome: 'ok', reason: 'passing' },
    },
    ...overrides,
  };
}

function results(
  website: readonly [string, string] = ['ok', 'passing'],
  connection: readonly [string, string] = ['ok', 'passing'],
) {
  return {
    website: { outcome: website[0], reason: website[1] },
    connection: { outcome: connection[0], reason: connection[1] },
  };
}

function reportToken(overrides: Record<string, unknown> = {}, nowMs = NOW) {
  return signToken(primary, monitorClaims(STATUS_REPORT_AUDIENCE, nowMs, overrides));
}

function claimToken(overrides: Record<string, unknown> = {}, nowMs = NOW) {
  return signToken(primary, monitorClaims(STATUS_CLAIM_AUDIENCE, nowMs, overrides));
}

async function report(
  deps: StatusReportDeps,
  body: unknown = reportBody(),
  options: PostOptions = {},
) {
  const token = options.token === undefined ? await reportToken() : options.token;
  return handleStatusReport(opsRequest(STATUS_REPORT_PATH, body, { ...options, token }), deps);
}

async function claim(
  deps: StatusClaimDeps,
  body: unknown = { v: 1, roomId: ROOM_ID },
  options: PostOptions = {},
) {
  const token = options.token === undefined ? await claimToken() : options.token;
  return handleStatusClaim(opsRequest(STATUS_CLAIM_PATH, body, { ...options, token }), deps);
}

let primary: SigningKey;
let forger: SigningKey;

beforeAll(async () => {
  primary = await createSigningKey('github-primary');
  forger = await createSigningKey('github-forged');
});

beforeEach(() => {
  verifySpy.mockClear();
});

afterEach(() => {
  resetGitHubActionsOidcCacheForTests();
  vi.unstubAllGlobals();
});

describe('status ops policies', () => {
  it('pin the status monitor job on main, with no environment, for each route audience', () => {
    const identity = {
      repository: 'hiefny/MUSIXQUARE',
      repositoryId: '1141408724',
      repositoryOwnerId: '257024056',
      ref: 'refs/heads/main',
      environment: null,
      eventName: ['schedule', 'workflow_dispatch'],
      runnerEnvironment: 'github-hosted',
      workflowRefs: [STATUS_MONITOR_WORKFLOW_REF],
    };
    expect(STATUS_REPORT_POLICY).toEqual({ ...identity, audience: STATUS_REPORT_AUDIENCE });
    expect(STATUS_CLAIM_POLICY).toEqual({ ...identity, audience: STATUS_CLAIM_AUDIENCE });
    for (const policy of [STATUS_REPORT_POLICY, STATUS_CLAIM_POLICY]) {
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.eventName)).toBe(true);
      expect(Object.isFrozen(policy.workflowRefs)).toBe(true);
    }
  });

  it('take the browser rows and four outcomes in a version 1 report', () => {
    expect(STATUS_REPORT_COMPONENTS).toEqual(['website', 'connection']);
    expect(STATUS_REPORT_OUTCOMES).toEqual(['ok', 'fail', 'maintenance', 'skipped']);
    expect(STATUS_OPS_BODY_VERSION).toBe(1);
  });
});

const ROUTES = [
  {
    name: 'report',
    endpoint: 'ops-status-report',
    audience: STATUS_REPORT_AUDIENCE,
    otherAudience: STATUS_CLAIM_AUDIENCE,
    send: (deps: StatusReportDeps & StatusClaimDeps, options: PostOptions = {}) =>
      report(deps, reportBody(), options),
    sendBody: (deps: StatusReportDeps & StatusClaimDeps, body: unknown, options: PostOptions) =>
      report(deps, body, options),
    validBody: () => reportBody(),
  },
  {
    name: 'claim',
    endpoint: 'ops-status-claim',
    audience: STATUS_CLAIM_AUDIENCE,
    otherAudience: STATUS_REPORT_AUDIENCE,
    send: (deps: StatusReportDeps & StatusClaimDeps, options: PostOptions = {}) =>
      claim(deps, { v: 1, roomId: ROOM_ID }, options),
    sendBody: (deps: StatusReportDeps & StatusClaimDeps, body: unknown, options: PostOptions) =>
      claim(deps, body, options),
    validBody: () => ({ v: 1, roomId: ROOM_ID }),
  },
] as const;

describe.each(ROUTES)('status $name route admission', (route) => {
  const token = (overrides: Record<string, unknown> = {}) =>
    signToken(primary, monitorClaims(route.audience, NOW, overrides));

  function expectNothingDone(calls: ReturnType<typeof harness>['calls']) {
    expect(calls.bodyReads).toEqual([]);
    expect(calls.maintenanceReads).toBe(0);
    expect(calls.records).toEqual([]);
    expect(calls.claims).toEqual([]);
  }

  it('refuses every other method with 405 before the abuse limit', async () => {
    const fetchMock = installJwks([primary.jwk]);
    const { deps, calls } = harness();
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await route.send(deps, { method, token: await token() });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    }
    expect(calls.rate).toEqual([]);
    expect(verifySpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expectNothingDone(calls);
  });

  it('applies the abuse limit before it parses a token or fetches keys', async () => {
    const fetchMock = installJwks([primary.jwk]);
    const { deps, calls } = harness({
      rate: { status: 'ok', allowed: false, retryAfterSeconds: 42 },
    });
    const forged = await signToken(forger, monitorClaims(route.audience, NOW));
    for (const candidate of [forged, await token(), 'x.y.z']) {
      const response = await route.send(deps, { token: candidate });
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('42');
    }
    expect(calls.rate).toEqual(
      Array.from({ length: 3 }, () => ({
        endpoint: route.endpoint,
        limit: STATUS_OPS_RATE_LIMIT,
        windowSec: STATUS_OPS_RATE_WINDOW_SECONDS,
      })),
    );
    expect(verifySpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expectNothingDone(calls);
  });

  it.each([
    ['unavailable', { status: 'unavailable' }],
    ['unbound', { status: 'unbound' }],
  ])('answers 503 while the abuse limit is %s, before any token parse', async (_label, rate) => {
    const fetchMock = installJwks([primary.jwk]);
    const { deps, calls } = harness({ rate });
    const response = await route.send(deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'RATE_LIMIT_UNAVAILABLE' });
    expect(verifySpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expectNothingDone(calls);
  });

  it.each([
    ['no Authorization header', { token: null }],
    ['an empty bearer token', { authorization: 'Bearer ' }],
    ['a token over 8 KiB', { token: 'a'.repeat(GITHUB_ACTIONS_OIDC_TOKEN_MAX_BYTES + 1) }],
  ])('refuses %s with 401 and no key fetch', async (_label, options) => {
    const fetchMock = installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const response = await route.send(deps, options);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'OIDC_TOKEN_INVALID' });
    expect(verifySpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expectNothingDone(calls);
  });

  it('refuses a non-bearer scheme that carries a genuine token with 401', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const response = await route.send(deps, { authorization: `Basic ${await token()}` });
    expect(response.status).toBe(401);
    expect(verifySpy).not.toHaveBeenCalled();
    expectNothingDone(calls);
  });

  it('refuses a malformed or forged token with 401', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const forged = await signToken(
      { kid: primary.kid, privateKey: forger.privateKey, jwk: forger.jwk },
      monitorClaims(route.audience, NOW),
    );
    for (const candidate of [
      'x.y.z',
      forged,
      await signToken(forger, monitorClaims(route.audience, NOW)),
    ]) {
      const response = await route.send(deps, { token: candidate });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'OIDC_TOKEN_INVALID' });
    }
    expect(verifySpy).toHaveBeenCalledTimes(3);
    expectNothingDone(calls);
  });

  it.each([
    ['the other status route', 'otherAudience'],
    ['the App build floor route', 'floor'],
  ])("refuses a token for %s's audience with 401", async (_label, which) => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const audience = which === 'floor' ? APP_BUILD_FLOOR_OPS_AUDIENCE : route.otherAudience;
    const response = await route.send(deps, { token: await token({ aud: audience }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'OIDC_TOKEN_INVALID' });
    expectNothingDone(calls);
  });

  it('refuses an expired token with 401', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const response = await route.send(deps, {
      token: await token({ exp: Math.floor(NOW / 1_000) - 61 }),
    });
    expect(response.status).toBe(401);
    expectNothingDone(calls);
  });

  it.each([
    ['an environment claim', { environment: 'production' }],
    ['an empty environment claim', { environment: '' }],
    ['a push event', { event_name: 'push' }],
    ['a pull request event', { event_name: 'pull_request' }],
    ['no event', { event_name: undefined }],
    ['another ref', { ref: 'refs/heads/feature' }],
    ['another repository', { repository: 'someone/MUSIXQUARE' }],
    ['another repository id', { repository_id: '1' }],
    ['a self-hosted runner', { runner_environment: 'self-hosted' }],
    ['another workflow', { workflow_ref: CI_WORKFLOW }],
    [
      'the monitor workflow from another ref',
      {
        workflow_ref: 'hiefny/MUSIXQUARE/.github/workflows/status-monitor.yml@refs/heads/feature',
      },
    ],
    ['a job that runs a reusable workflow', { job_workflow_ref: RECOVERY_WORKFLOW }],
    [
      'another workflow that calls the monitor as a reusable workflow',
      { workflow_ref: CI_WORKFLOW, job_workflow_ref: STATUS_MONITOR_WORKFLOW_REF },
    ],
  ])('refuses a token with %s with 403', async (_label, overrides) => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const response = await route.send(deps, { token: await token(overrides) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'OIDC_TOKEN_FORBIDDEN' });
    expectNothingDone(calls);
  });

  it.each([
    ['a scheduled run', { event_name: 'schedule' }],
    ['a run started by hand', { event_name: 'workflow_dispatch' }],
    [
      'a token that repeats workflow_ref in job_workflow_ref',
      { job_workflow_ref: STATUS_MONITOR_WORKFLOW_REF },
    ],
  ])('accepts %s of the monitor job', async (_label, overrides) => {
    installJwks([primary.jwk]);
    const { deps } = harness();
    const response = await route.send(deps, { token: await token(overrides) });
    expect(response.status).toBe(200);
    expect(verifySpy).toHaveBeenCalledOnce();
  });

  it('answers 503 while GitHub keys are unavailable and does nothing', async () => {
    installJwks([primary.jwk], 503);
    const { deps, calls } = harness();
    const response = await route.send(deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'OIDC_JWKS_UNAVAILABLE' });
    expectNothingDone(calls);
  });

  it('requires a JSON content type once the token verified, before it reads the body', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    for (const contentType of ['text/plain', 'application/jsonx', '']) {
      const response = await route.send(deps, { contentType });
      expect(response.status, contentType).toBe(415);
      expect(await response.json()).toEqual({ error: 'JSON_REQUIRED' });
    }
    expect(verifySpy).toHaveBeenCalledTimes(3);
    expectNothingDone(calls);
    const charset = await route.send(deps, { contentType: 'Application/JSON; charset=utf-8' });
    expect(charset.status).toBe(200);
  });

  it('reads the body with the 4 KiB bound and refuses a larger or broken one', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const large = { ...route.validBody(), padding: 'x'.repeat(STATUS_REPORT_BODY_MAX_BYTES) };
    const tooLarge = await route.sendBody(deps, large, {});
    expect(tooLarge.status).toBe(413);
    const broken = await route.sendBody(deps, '{"v":1,', {});
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: 'Invalid JSON body' });
    expect(calls.bodyReads).toEqual([STATUS_REPORT_BODY_MAX_BYTES, STATUS_REPORT_BODY_MAX_BYTES]);
    expect(calls.records).toEqual([]);
    expect(calls.claims).toEqual([]);
  });

  it('answers without CORS headers', async () => {
    installJwks([primary.jwk]);
    const { deps } = harness();
    const headers = { Origin: ORIGIN };
    for (const response of [
      await route.send(deps, { headers }),
      await route.send(deps, { headers, method: 'OPTIONS' }),
      await route.send(deps, { headers, token: null }),
    ]) {
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull();
    }
  });

  it('never repeats the token or the body in an error', async () => {
    installJwks([primary.jwk]);
    const { deps } = harness();
    const marker = 'body-marker-7f3a';
    const forbidden = await token({ event_name: 'push' });
    // The signature is the part no other token shares.
    const signature = forbidden.split('.')[2] ?? '';
    expect(signature.length).toBeGreaterThan(40);
    const texts = [
      await (await route.send(deps, { token: forbidden })).text(),
      await (await route.send(deps, { token: `${forbidden}x` })).text(),
      await (await route.sendBody(deps, { ...route.validBody(), extra: marker }, {})).text(),
      await (await route.sendBody(deps, `{"${marker}":`, {})).text(),
    ];
    for (const text of texts) {
      expect(text).not.toContain(signature.slice(0, 40));
      expect(text).not.toContain(marker);
    }
  });
});

describe('status report route', () => {
  it('records both results in the browser slot the run started in', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const startedAt = Date.parse('2026-11-26T05:22:03.120Z');
    const response = await report(
      deps,
      reportBody({ results: results(['ok', 'passing'], ['fail', 'chat_timeout']) }, startedAt),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      slotAt: '2026-11-26T05:22:00.000Z',
      recorded: { website: 'o', connection: 'p' },
    });
    const slotAt = Date.parse('2026-11-26T05:22:00.000Z');
    expect(calls.records).toEqual([
      [
        {
          component: 'website',
          slotAt,
          result: 'o',
          reason: 'passing',
          checkedAt: NOW,
          source: 'browser',
          runId: '9000000001',
        },
        {
          component: 'connection',
          slotAt,
          result: 'p',
          reason: 'chat_timeout',
          checkedAt: NOW,
          source: 'browser',
          runId: '9000000001',
        },
      ],
    ]);
    expect(calls.maintenanceReads).toBe(1);
    expect(calls.rate).toEqual([
      {
        endpoint: 'ops-status-report',
        limit: STATUS_OPS_RATE_LIMIT,
        windowSec: STATUS_OPS_RATE_WINDOW_SECONDS,
      },
    ]);
  });

  it.each([
    ['on time', '2026-11-26T05:07:41.000Z', '2026-11-26T05:07:00.000Z'],
    ['14 minutes late', '2026-11-26T05:21:59.999Z', '2026-11-26T05:07:00.000Z'],
    ['15 minutes late', '2026-11-26T05:22:00.000Z', '2026-11-26T05:22:00.000Z'],
    ['late across the hour', '2026-11-26T05:06:59.999Z', '2026-11-26T04:52:00.000Z'],
    ['late across midnight UTC', '2026-11-27T00:06:30.000Z', '2026-11-26T23:52:00.000Z'],
  ])('records a run that starts %s in the slot it started in', async (_label, startedAt, slot) => {
    installJwks([primary.jwk]);
    const startedAtMs = Date.parse(startedAt);
    const nowMs = startedAtMs + 4 * 60_000;
    const { deps, calls } = harness({ nowMs });
    const response = await report(deps, reportBody({}, startedAtMs), {
      token: await reportToken({}, nowMs),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ slotAt: slot });
    expect(calls.records[0]?.map((row) => row.slotAt)).toEqual([
      Date.parse(slot),
      Date.parse(slot),
    ]);
    expect(calls.records[0]?.[0]?.checkedAt).toBe(nowMs);
  });

  it('accepts startedAt from 20 minutes before now to 2 minutes after it', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const cases = [
      [NOW - STATUS_REPORT_MAX_AGE_MS, 200],
      [NOW - STATUS_REPORT_MAX_AGE_MS - 1, 400],
      [NOW + STATUS_REPORT_MAX_FUTURE_SKEW_MS, 200],
      [NOW + STATUS_REPORT_MAX_FUTURE_SKEW_MS + 1, 400],
      [NOW - 24 * 60 * 60_000, 400],
    ] as const;
    for (const [startedAtMs, status] of cases) {
      const response = await report(deps, reportBody({}, startedAtMs));
      expect(response.status, iso(startedAtMs)).toBe(status);
      if (status === 400) {
        expect(await response.json()).toEqual({ error: 'REPORT_OUT_OF_WINDOW' });
      }
    }
    expect(calls.records).toHaveLength(2);
    // The window is checked before maintenance is read.
    expect(calls.maintenanceReads).toBe(2);
  });

  it('refuses any other body shape with 400 and records nothing', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const startedAt = iso(NOW - 60_000);
    const bodies: unknown[] = [
      { ...reportBody(), extra: true },
      { startedAt, results: results() },
      { v: 2, startedAt, results: results() },
      { v: '1', startedAt, results: results() },
      { v: 1, results: results() },
      { v: 1, startedAt: '2026-11-26T05:29:00Z', results: results() },
      { v: 1, startedAt: '2026-11-26T05:29:00.000+00:00', results: results() },
      { v: 1, startedAt: '2026-11-26 05:29:00.000Z', results: results() },
      { v: 1, startedAt: '2026-02-30T05:29:00.000Z', results: results() },
      { v: 1, startedAt: NOW - 60_000, results: results() },
      { v: 1, startedAt: '', results: results() },
      { v: 1, startedAt: 'not a time', results: results() },
      { v: 1, startedAt },
      { v: 1, startedAt, results: null },
      { v: 1, startedAt, results: [] },
      { v: 1, startedAt, results: { website: results().website } },
      { v: 1, startedAt, results: { ...results(), rooms: results().website } },
      { v: 1, startedAt, results: { ...results(), pro: results().website } },
      { v: 1, startedAt, results: { ...results(), website: { outcome: 'ok' } } },
      { v: 1, startedAt, results: { ...results(), website: { reason: 'passing' } } },
      {
        v: 1,
        startedAt,
        results: { ...results(), website: { outcome: 'ok', reason: 'passing', at: 1 } },
      },
      { v: 1, startedAt, results: { ...results(), connection: 'ok' } },
      ...['passed', 'OK', 'failed', 'error', '', null, 1].map((outcome) => ({
        v: 1,
        startedAt,
        results: { ...results(), website: { outcome, reason: 'passing' } },
      })),
      ...[
        'Bad-Reason',
        'x'.repeat(49),
        '',
        'has space',
        `caf${String.fromCharCode(0xe9)}`,
        7,
        null,
      ].map((reason) => ({
        v: 1,
        startedAt,
        results: { ...results(), connection: { outcome: 'fail', reason } },
      })),
      [],
      null,
      'report',
      1,
    ];
    for (const body of bodies) {
      const response = await report(deps, JSON.stringify(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: 'INVALID_REQUEST' });
    }
    expect(calls.records).toEqual([]);
    expect(calls.maintenanceReads).toBe(0);

    const longest = await report(
      deps,
      reportBody({ results: results(['ok', 'passing'], ['fail', 'x'.repeat(48)]) }),
    );
    expect(longest.status).toBe(200);
  });

  it.each([
    ['ok', 'o'],
    ['fail', 'p'],
    ['maintenance', 'm'],
  ])('records an outcome of %s as %s', async (outcome, result) => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const response = await report(
      deps,
      reportBody({ results: results([outcome, 'website_reason'], [outcome, 'connection_reason']) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recorded: { website: result, connection: result },
    });
    expect(
      calls.records[0]?.map(({ component, result: stored, reason }) => [component, stored, reason]),
    ).toEqual([
      ['website', result, 'website_reason'],
      ['connection', result, 'connection_reason'],
    ]);
  });

  it('records no row for a skipped check', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const one = await report(
      deps,
      reportBody({ results: results(['ok', 'passing'], ['skipped', 'claim_unavailable']) }),
    );
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ recorded: { website: 'o', connection: null } });
    expect(calls.records).toHaveLength(1);
    expect(calls.records[0]?.map((row) => row.component)).toEqual(['website']);

    const none = await report(
      deps,
      reportBody({
        results: results(['skipped', 'edge_challenge'], ['skipped', 'website_failed']),
      }),
    );
    expect(none.status).toBe(200);
    expect(await none.json()).toMatchObject({ recorded: { website: null, connection: null } });
    // Nothing to write: the ledger is not called.
    expect(calls.records).toHaveLength(1);
  });

  it.each([
    ['enabled', { enabled: true }],
    ['enabled and readable', { enabled: true, controlUnavailable: false }],
  ])('records maintenance marks for both rows while maintenance is %s', async (_label, state) => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness({ maintenance: state });
    for (const reported of [
      results(['ok', 'passing'], ['fail', 'chat_timeout']),
      results(['fail', 'page_not_ready'], ['skipped', 'website_failed']),
      results(['skipped', 'edge_challenge'], ['skipped', 'website_failed']),
    ]) {
      const response = await report(deps, reportBody({ results: reported }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ recorded: { website: 'm', connection: 'm' } });
    }
    expect(calls.records).toHaveLength(3);
    for (const rows of calls.records) {
      expect(rows.map(({ component, result, reason }) => [component, result, reason])).toEqual([
        ['website', 'm', 'maintenance'],
        ['connection', 'm', 'maintenance'],
      ]);
    }
  });

  it.each([
    ['a control-plane outage', { enabled: true, controlUnavailable: true }],
    ['maintenance switched off', { enabled: false }],
    ['a maintenance read that failed', new Error('control read failed')],
  ])('records the reported results during %s', async (_label, maintenance) => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness({ maintenance });
    const response = await report(
      deps,
      reportBody({ results: results(['fail', 'http_503'], ['skipped', 'website_failed']) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recorded: { website: 'p', connection: null } });
    expect(calls.records[0]?.map(({ result, reason }) => [result, reason])).toEqual([
      ['p', 'http_503'],
    ]);
  });

  it('answers 503 STATUS_STORE_UNAVAILABLE when the ledger write fails', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness({ recordError: new Error('D1 batch failed for 123456') });
    const response = await report(deps);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'STATUS_STORE_UNAVAILABLE' });
    expect(text).not.toContain('D1');
    expect(calls.records).toHaveLength(1);
  });

  it.each([
    ['a decimal run id', '9000000001', '9000000001'],
    ['the longest run id the ledger keeps', '9'.repeat(32), '9'.repeat(32)],
    ['no run id', undefined, null],
    ['an empty run id', '', null],
    ['a run id over 32 digits', '9'.repeat(33), null],
    ['a run id that is not decimal', 'run-9000000001', null],
    ['a numeric run id', 9000000001, null],
  ])('records %s as %j', async (_label, runId, expected) => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const response = await report(deps, reportBody(), {
      token: await reportToken({ run_id: runId }),
    });
    expect(response.status).toBe(200);
    expect(calls.records[0]?.map((row) => row.runId)).toEqual([expected, expected]);
  });
});

describe('status claim route', () => {
  it('claims the code on its room object and answers 200', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const response = await claim(deps, { v: 1, roomId: OTHER_ROOM_ID });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.claims).toEqual([OTHER_ROOM_ID]);
    expect(calls.rate).toEqual([
      {
        endpoint: 'ops-status-claim',
        limit: STATUS_OPS_RATE_LIMIT,
        windowSec: STATUS_OPS_RATE_WINDOW_SECONDS,
      },
    ]);
    // The claim route neither reads maintenance nor writes the ledger.
    expect(calls.maintenanceReads).toBe(0);
    expect(calls.records).toEqual([]);
  });

  it.each([
    ['claimed', 200, { ok: true }],
    ['room_active', 409, { error: 'ROOM_ACTIVE' }],
    ['unsupported', 424, { error: 'STATUS_PROBE_UNSUPPORTED' }],
    ['maintenance', 503, { error: 'STATUS_PROBE_UNAVAILABLE' }],
    ['control_unavailable', 503, { error: 'STATUS_PROBE_UNAVAILABLE' }],
    ['failed', 503, { error: 'STATUS_PROBE_UNAVAILABLE' }],
  ] as const)('maps a %s claim to %i', async (outcome, status, body) => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness({ claim: outcome });
    const response = await claim(deps);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(calls.claims).toEqual([ROOM_ID]);
  });

  it('answers 503 when the claim call throws', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness({ claim: new Error('room object for 123456 unreachable') });
    const response = await claim(deps);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'STATUS_PROBE_UNAVAILABLE' });
    expect(text).not.toContain(ROOM_ID);
    expect(calls.claims).toEqual([ROOM_ID]);
  });

  it('refuses any other body with 400 and claims nothing', async () => {
    installJwks([primary.jwk]);
    const { deps, calls } = harness();
    const bodies: unknown[] = [
      { v: 1 },
      { roomId: ROOM_ID },
      { v: 2, roomId: ROOM_ID },
      { v: '1', roomId: ROOM_ID },
      { v: 1, roomId: ROOM_ID, role: 'host' },
      { v: 1, roomCode: ROOM_ID },
      // A PRO code, a short or long code, a number and stray characters.
      { v: 1, roomId: '012345' },
      { v: 1, roomId: '000000' },
      { v: 1, roomId: '12345' },
      { v: 1, roomId: '1234567' },
      { v: 1, roomId: 123456 },
      { v: 1, roomId: '12345a' },
      { v: 1, roomId: ' 123456' },
      { v: 1, roomId: '123456\n' },
      { v: 1, roomId: String.fromCharCode(0xff11, 0xff12, 0xff13, 0xff14, 0xff15, 0xff16) },
      { v: 1, roomId: null },
      [],
      null,
      ROOM_ID,
    ];
    for (const body of bodies) {
      const response = await claim(deps, JSON.stringify(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: 'INVALID_REQUEST' });
    }
    expect(calls.claims).toEqual([]);
  });
});

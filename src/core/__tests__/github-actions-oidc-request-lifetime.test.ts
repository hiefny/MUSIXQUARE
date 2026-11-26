import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  GITHUB_ACTIONS_OIDC_ISSUER,
  GITHUB_ACTIONS_OIDC_JWKS_URL,
  GITHUB_OIDC_JWKS_REFRESH_MIN_INTERVAL_MS,
} from '../../../cloudflare/github-actions-oidc.ts';
import {
  STATUS_OPS_BODY_VERSION,
  STATUS_REPORT_COMPONENTS,
  STATUS_REPORT_POLICY,
} from '../../../cloudflare/status-ops.ts';
import { localWorkerdPort } from './helpers/local-workerd-port.ts';

/**
 * The GitHub Actions OIDC verifier's key-set download (keySetFor in
 * cloudflare/github-actions-oidc.ts) in actual workerd request contexts,
 * through the real status report route (handleStatusReport in
 * cloudflare/status-ops.ts) and its pinned monitor policy.
 *
 * An isolate shares one key-set download between its requests. workerd settles
 * a promise only inside the request that created it
 * (handle_cross_request_promise_resolution, on by default since 2024-10-14).
 * When the client of the request that started the download disconnects
 * mid-download (anyone can send a forged token with an unknown key id), every
 * request awaiting it is rejected with "can never settle". Before the fix only
 * that request cleared the download, so every later verification in the
 * isolate that needed the key set threw: the status claim and report routes
 * and the App build floor setter answered 500 until the isolate was replaced.
 *
 * A service binding stands in for GitHub's key set (it is the verifier's only
 * outbound host and refuses any other URL) and holds one download on cue. The
 * entry Worker cancels the request marked cancellable when told to, as a client
 * abort would. The route's clock is set per request, and every step waits for
 * an observed state instead of a time margin.
 */

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const statusOpsSource = fileURLToPath(
  new URL('../../../cloudflare/status-ops.ts', import.meta.url),
);
const appDate = readFileSync(
  new URL('../../../cloudflare/wrangler.app.toml', import.meta.url),
  'utf8',
).match(/compatibility_date = "([^"]+)"/)![1]!;

const INTERVAL_MS = GITHUB_OIDC_JWKS_REFRESH_MIN_INTERVAL_MS;
// Test data: how long the stand-in's key set may be cached.
const KEY_SET_MAX_AGE_MS = 3 * INTERVAL_MS;
const T0 = Date.UTC(2026, 10, 26, 12, 0, 0);
const KID = 'monitor-key';
const OK = { status: 200, body: expect.objectContaining({ ok: true }) };
const KEY_SET_UNAVAILABLE = { status: 503, body: { error: 'OIDC_JWKS_UNAVAILABLE' } };
const CANCELLED = { status: 499, body: 'cancelled' };
const SHARED_FETCH_REJECTED = 'github_oidc_jwks_shared_fetch_rejected';

// Entry Worker: forwards each request to the route and, for the one request
// marked cancellable, aborts that subrequest once /cancel arrives.
const ENTRY_SCRIPT = `
let cancelRequested = false;
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/cancel') {
    cancelRequested = true;
    return new Response('ok');
  }
  const cancellable = url.searchParams.has('cancellable');
  url.search = '';
  const controller = new AbortController();
  let settled = false;
  const forwarded = new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
    signal: controller.signal,
  });
  const operation = env.FRONT.fetch(forwarded)
    .then(async (response) => new Response(await response.text(), response))
    .catch(() => new Response('route request failed', { status: 502 }))
    .finally(() => { settled = true; });
  if (!cancellable) return operation;
  while (!settled && !cancelRequested) await new Promise((resolve) => setTimeout(resolve, 5));
  if (settled) return operation;
  cancelRequested = false;
  controller.abort();
  return new Response('cancelled', { status: 499 });
} };
`;

// The real report route with stand-in App helpers. The rate limit counts each
// request; after it the route reaches the shared download without other I/O.
// Like the App Worker's fetch handler, the route has no catch around it.
const FRONT_SHIM = `
import { handleStatusReport } from ${JSON.stringify(statusOpsSource)};
let clockMs = 0;
let entered = 0;
const warnings = [];
const original = console.warn.bind(console);
console.warn = (first, ...rest) => {
  if (typeof first === 'string' && first.startsWith('[GitHub OIDC]')) {
    warnings.push(rest[0] && rest[0].event ? rest[0].event : first);
  } else {
    original(first, ...rest);
  }
};
const deps = {
  json: (body, status = 200, headers = {}) => Response.json(body, { status, headers }),
  async checkPaidRateLimit() {
    entered += 1;
    return { status: 'ok', allowed: true };
  },
  rateLimitResponse: () => Response.json({ error: 'RATE_LIMITED' }, { status: 429 }),
  rateLimitUnavailableResponse: () =>
    Response.json({ error: 'RATE_LIMIT_UNAVAILABLE' }, { status: 503 }),
  async readJsonBodyLimited(request) {
    try {
      return { value: JSON.parse(await request.text()) };
    } catch {
      return { error: 'invalid' };
    }
  },
  jsonBodyError: () => Response.json({ error: 'INVALID_JSON' }, { status: 400 }),
  nowMs: () => clockMs,
  readMaintenance: async () => ({ enabled: false }),
  record: async () => undefined,
};
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/state') return Response.json({ entered, warnings });
  if (url.pathname === '/clock') {
    clockMs = Number(url.searchParams.get('at'));
    return new Response('ok');
  }
  return handleStatusReport(request, deps);
} };
`;

// GitHub key-set stand-in: answers only the verifier's key-set URL, counts
// downloads and, once told to hold, keeps the next download until /release.
function keySetScript(keySet: string) {
  return `
const KEY_SET_URL = ${JSON.stringify(GITHUB_ACTIONS_OIDC_JWKS_URL)};
let downloads = 0;
let holdNext = false;
let holding = false;
let released = false;
const refused = [];
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.hostname === 'control.local') {
    if (url.pathname === '/hold') {
      holdNext = true;
      released = false;
      return new Response('ok');
    }
    if (url.pathname === '/release') {
      released = true;
      return new Response('ok');
    }
    return Response.json({ downloads, holding, refused });
  }
  if (request.url !== KEY_SET_URL) {
    refused.push(url.origin);
    return new Response('Not found', { status: 404 });
  }
  downloads += 1;
  if (holdNext) {
    holdNext = false;
    holding = true;
    const giveUpAt = Date.now() + 10000;
    while (!released && Date.now() < giveUpAt) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    holding = false;
  }
  return new Response(${JSON.stringify(keySet)}, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=${KEY_SET_MAX_AGE_MS / 1_000}',
    },
  });
} };
`;
}

type LocalService = { fetch(input: string, init?: RequestInit): Promise<Response> };

let frontScript: string;
let keySet: string;
let privateKey: KeyObject;
let runtime: Miniflare | undefined;
let refusedByStandIn: (() => Promise<string[]>) | undefined;
const outboundRequests: string[] = [];

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const { n, e } = pair.publicKey.export({ format: 'jwk' });
  keySet = JSON.stringify({ keys: [{ kty: 'RSA', kid: KID, use: 'sig', alg: 'RS256', n, e }] });
  const bundled = await build({
    absWorkingDir: repository,
    stdin: { resolveDir: repository, loader: 'ts', contents: FRONT_SHIM },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  frontScript = bundled.outputFiles[0]!.text;
}, 30_000);

afterEach(async () => {
  const refused = (await refusedByStandIn?.()) ?? [];
  refusedByStandIn = undefined;
  await runtime?.dispose();
  runtime = undefined;
  expect(refused).toEqual([]);
  expect(outboundRequests.splice(0)).toEqual([]);
}, 30_000);

function segment(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A token the monitor job would carry, signed with the stand-in's key. */
function monitorToken(atMs: number) {
  const iat = Math.floor(atMs / 1_000);
  const header = segment({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const claims = segment({
    iss: GITHUB_ACTIONS_OIDC_ISSUER,
    aud: STATUS_REPORT_POLICY.audience,
    repository: STATUS_REPORT_POLICY.repository,
    repository_id: STATUS_REPORT_POLICY.repositoryId,
    repository_owner_id: STATUS_REPORT_POLICY.repositoryOwnerId,
    ref: STATUS_REPORT_POLICY.ref,
    event_name: [STATUS_REPORT_POLICY.eventName].flat()[0],
    runner_environment: STATUS_REPORT_POLICY.runnerEnvironment,
    workflow_ref: STATUS_REPORT_POLICY.workflowRefs[0],
    run_id: '1',
    iat,
    nbf: iat,
    exp: iat + 300,
  });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), privateKey);
  return `${header}.${claims}.${signature.toString('base64url')}`;
}

/** A well-formed token with an unknown key id and a junk signature. */
function forgedToken() {
  const header = segment({ alg: 'RS256', kid: 'forged-key', typ: 'JWT' });
  return `${header}.${segment({ iss: 'forged' })}.${'A'.repeat(342)}`;
}

async function harness() {
  const blockOutbound = (request: Request) => {
    outboundRequests.push(new URL(request.url).origin);
    return new Response('External network disabled', { status: 502 });
  };
  const worker = (
    name: string,
    script: string,
    extra: { serviceBindings?: Record<string, string>; outboundService?: string } = {},
  ) => ({
    name,
    modules: true,
    compatibilityDate: appDate,
    script,
    outboundService: blockOutbound,
    ...extra,
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      port: await localWorkerdPort(),
      log: new Log(LogLevel.NONE),
      workers: [
        worker('entry', ENTRY_SCRIPT, { serviceBindings: { FRONT: 'front' } }),
        // The route's only outbound fetch, the key set, reaches the stand-in.
        worker('front', frontScript, { outboundService: 'keyset' }),
        worker('keyset', keySetScript(keySet)),
      ],
    }),
  );
  await runtime.ready;
  const front = (await runtime.getWorker('front')) as unknown as LocalService;
  const standIn = (await runtime.getWorker('keyset')) as unknown as LocalService;
  const control = (path: string) => standIn.fetch(`http://control.local${path}`);
  const standInState = async () =>
    (await (await control('/state')).json()) as {
      downloads: number;
      holding: boolean;
      refused: string[];
    };
  const frontState = async () =>
    (await (await front.fetch('http://front/state')).json()) as {
      entered: number;
      warnings: string[];
    };
  refusedByStandIn = async () => (await standInState()).refused;
  return {
    async hold() {
      await (await control('/hold')).text();
    },
    async release() {
      await (await control('/release')).text();
    },
    async cancel() {
      await (await runtime!.dispatchFetch('http://localhost/cancel')).text();
    },
    // One monitor report at atMs on the route's clock.
    async report(token: string, atMs: number, cancellable = false) {
      await (await front.fetch(`http://front/clock?at=${atMs}`)).text();
      const results = Object.fromEntries(
        STATUS_REPORT_COMPONENTS.map((component) => [
          component,
          { outcome: 'ok', reason: 'passing' },
        ]),
      );
      const response = await runtime!.dispatchFetch(
        `http://localhost/api/ops/status-report${cancellable ? '?cancellable' : ''}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            v: STATUS_OPS_BODY_VERSION,
            startedAt: new Date(atMs).toISOString(),
            results,
          }),
        },
      );
      const body = await response.text();
      return { status: response.status, body: body.startsWith('{') ? JSON.parse(body) : body };
    },
    async downloads() {
      return (await standInState()).downloads;
    },
    async warnings() {
      return (await frontState()).warnings;
    },
    async untilHolding() {
      await until('the key-set download to be held', async () => (await standInState()).holding);
    },
    // The route counts a request at its rate limit, after which it reaches
    // the shared download without other I/O.
    async untilEntered(requests: number) {
      await until(`${requests} reports to reach the verifier`, async () => {
        return (await frontState()).entered === requests;
      });
    },
  };
}

async function until(what: string, condition: () => Promise<boolean>) {
  const giveUpAt = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > giveUpAt) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('GitHub Actions OIDC key-set download across workerd requests', () => {
  it('answers 503, not a thrown error, after a forged report is cancelled mid-download in a cold isolate', async () => {
    const test = await harness();
    await test.hold();
    const creator = test.report(forgedToken(), T0, true);
    await test.untilHolding();
    const waiter = test.report(monitorToken(T0), T0);
    await test.untilEntered(2);
    await test.cancel();
    expect(await creator).toEqual(CANCELLED);
    await test.release();

    // Before the fix the waiter and every later report threw "can never
    // settle", which the App answers as a 500.
    expect(await waiter).toEqual(KEY_SET_UNAVAILABLE);
    // The lost download still counts as an attempt: no new download inside
    // the refresh interval.
    const inside = T0 + INTERVAL_MS / 2;
    expect(await test.report(monitorToken(inside), inside)).toEqual(KEY_SET_UNAVAILABLE);
    expect(await test.downloads()).toBe(1);

    const next = T0 + INTERVAL_MS;
    expect(await test.report(monitorToken(next), next)).toEqual(OK);
    expect(await test.downloads()).toBe(2);
    expect(await test.warnings()).toEqual([SHARED_FETCH_REJECTED]);
  });

  it('keeps verifying from the cached set, then downloads once, after a refresh is cancelled in a warm isolate', async () => {
    const test = await harness();
    expect(await test.report(monitorToken(T0), T0)).toEqual(OK);
    const refresh = T0 + INTERVAL_MS;
    await test.hold();
    const creator = test.report(forgedToken(), refresh, true);
    await test.untilHolding();
    await test.cancel();
    expect(await creator).toEqual(CANCELLED);
    await test.release();

    const cached = T0 + 2 * INTERVAL_MS;
    expect(await test.report(monitorToken(cached), cached)).toEqual(OK);
    expect(await test.downloads()).toBe(2);

    // Before the fix the first report after the cached set expired threw.
    const expired = T0 + KEY_SET_MAX_AGE_MS;
    expect(await test.report(monitorToken(expired), expired)).toEqual(OK);
    expect(await test.downloads()).toBe(3);
    expect(await test.warnings()).toEqual([SHARED_FETCH_REJECTED]);
  });

  it('shares one download between concurrent reports when none is cancelled', async () => {
    const test = await harness();
    await test.hold();
    const first = test.report(monitorToken(T0), T0);
    await test.untilHolding();
    const second = test.report(monitorToken(T0), T0);
    await test.untilEntered(2);
    await test.release();

    expect(await first).toEqual(OK);
    expect(await second).toEqual(OK);
    expect(await test.downloads()).toBe(1);
    expect(await test.warnings()).toEqual([]);
  });
});

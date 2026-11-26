import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { APP_BUILD_FLOOR_CLIENT_PATH } from '../../../cloudflare/app-build-floor-contract.ts';
import { STATUS_SERVER_CRON } from '../../../cloudflare/status-contract.ts';
import { localWorkerdPort } from './helpers/local-workerd-port.ts';

/**
 * The App build the App Worker serves (readServedAppBuild in
 * cloudflare/app-worker.ts) in actual workerd request contexts, with the real
 * App code bundled.
 *
 * The App reads its build once per assets binding from its own deployed
 * service worker, and concurrent callers share a read that is still running.
 * workerd settles a promise only inside the request that created it
 * (handle_cross_request_promise_resolution, on by default since 2024-10-14).
 * The page drops its floor read when it is hidden, so the request that started
 * the read can end mid-read. Before the fix only that request cleared the
 * shared read, so every later caller in the isolate was rejected with "can
 * never settle": the floor read failed, and the status cron recorded neither
 * server row (app_build_unavailable) until the isolate was replaced.
 *
 * A service binding stands in for the assets and holds the first service
 * worker read until it is released, another stands in for the PRO front door,
 * and an object stands in for the admin D1 and keeps the ledger rows the cron
 * writes. The entry Worker cancels the request marked cancellable when told
 * to, as a client abort would. Every step waits for an observed state instead
 * of a time margin.
 */

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const appWorkerSource = fileURLToPath(
  new URL('../../../cloudflare/app-worker.ts', import.meta.url),
);
const appDate = readFileSync(
  new URL('../../../cloudflare/wrangler.app.toml', import.meta.url),
  'utf8',
).match(/compatibility_date = "([^"]+)"/)![1]!;

// A synthetic build for the stand-in service worker's cache epoch.
const SERVED_BUILD = 785;
// Without a service-control binding the floor is not read live, so the client
// read publishes 0 once it has read the served build.
const FLOOR_OK = { status: 200, body: { effectiveMinAppBuild: 0 } };
const SERVED_BUILD_OK = { status: 200, body: { build: SERVED_BUILD } };
const PRO_ROW = { component: 'pro', result: 'o', reason: 'passing', source: 'cron' };
const SHARED_READ_REJECTED = 'served_app_build_shared_read_rejected';

// Entry Worker: forwards each request to the App and, for the one request
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
  const operation = env.APP.fetch(new Request(url, { signal: controller.signal }))
    .then(async (response) => new Response(await response.text(), response))
    .catch(() => new Response('app request failed', { status: 502 }))
    .finally(() => { settled = true; });
  if (!cancellable) return operation;
  while (!settled && !cancelRequested) await new Promise((resolve) => setTimeout(resolve, 5));
  if (settled) return operation;
  cancelRequested = false;
  controller.abort();
  return new Response('cancelled', { status: 499 });
} };
`;

// The real App default export. /served-build calls the read directly and
// counts the call, which awaits a shared read before anything else; the cron
// gets an admin D1 stand-in that keeps the rows it records. Status check and
// served build warnings are kept by event name, not printed.
const APP_SHIM = `
import app, { readServedAppBuildForTests } from ${JSON.stringify(appWorkerSource)};
let entered = 0;
const warnings = [];
const rows = [];
const original = console.warn.bind(console);
console.warn = (first, ...rest) => {
  if (first && typeof first === 'object' && first.diagnostic === 'status_checks') {
    warnings.push(first.event);
  } else if (typeof first === 'string' && first.startsWith('[App build floor]')) {
    warnings.push(rest[0] && rest[0].event ? rest[0].event : first);
  } else {
    original(first, ...rest);
  }
};
const statement = (values) => ({
  values,
  bind: (...next) => statement(next),
  async run() { return { success: true, meta: { changes: 0 } }; },
  async all() { return { success: true, meta: {}, results: [] }; },
});
const db = {
  prepare: () => statement([]),
  async batch(statements) {
    for (const { values } of statements) {
      rows.push({ component: values[0], result: values[2], reason: values[3], source: values[5] });
    }
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  },
};
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/state') return Response.json({ entered, warnings, rows });
    if (pathname === '/served-build') {
      entered += 1;
      return Response.json({ build: await readServedAppBuildForTests(env) });
    }
    return app.fetch(request, env, ctx);
  },
  scheduled(event, env, ctx) {
    return app.scheduled(event, { ...env, MUSIXQUARE_ADMIN_DB: db }, ctx);
  },
};
`;

// Assets stand-in: counts service worker reads and, once told to hold, keeps
// the first read until /__release.
const ASSETS_SCRIPT = `
let holdFirst = false;
let reads = 0;
let holding = false;
let released = false;
export default { async fetch(request) {
  const { pathname } = new URL(request.url);
  if (pathname === '/__hold') {
    holdFirst = true;
    return new Response('ok');
  }
  if (pathname === '/__release') {
    released = true;
    return new Response('ok');
  }
  if (pathname === '/__state') return Response.json({ reads, holding });
  if (pathname !== '/service-worker.js') return new Response('Not found', { status: 404 });
  reads += 1;
  if (holdFirst && reads === 1) {
    holding = true;
    const giveUpAt = Date.now() + 10000;
    while (!released && Date.now() < giveUpAt) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    holding = false;
  }
  return new Response("const CACHE_VERSION = 'v${SERVED_BUILD}';\\n", {
    headers: { 'Content-Type': 'text/javascript' },
  });
} };
`;

// PRO front door stand-in: the canary room's bootstrap answers open.
const PRO_SCRIPT = `
export default { async fetch() {
  return Response.json({ roomCode: '000000', status: 'open' });
} };
`;

type LocalService = { fetch(input: string, init?: RequestInit): Promise<Response> };
type LocalApp = LocalService & {
  scheduled(options: { cron: string; scheduledTime: Date }): Promise<{ outcome: string }>;
};
interface AppState {
  entered: number;
  warnings: string[];
  rows: Record<string, unknown>[];
}

let appScript: string;
let runtime: Miniflare | undefined;
const outboundRequests: string[] = [];

beforeAll(async () => {
  const bundled = await build({
    absWorkingDir: repository,
    stdin: { resolveDir: repository, loader: 'ts', contents: APP_SHIM },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  appScript = bundled.outputFiles[0]!.text;
}, 30_000);

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  expect(outboundRequests.splice(0)).toEqual([]);
}, 30_000);

async function harness() {
  const blockOutbound = (request: Request) => {
    outboundRequests.push(new URL(request.url).origin);
    return new Response('External network disabled', { status: 502 });
  };
  const worker = (name: string, script: string, serviceBindings?: Record<string, string>) => ({
    name,
    modules: true,
    compatibilityDate: appDate,
    script,
    ...(serviceBindings ? { serviceBindings } : {}),
    outboundService: blockOutbound,
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      port: await localWorkerdPort(),
      log: new Log(LogLevel.NONE),
      workers: [
        worker('entry', ENTRY_SCRIPT, { APP: 'app' }),
        worker('app', appScript, { ASSETS: 'assets', PRO_ROOM_PUBLIC_API: 'pro' }),
        worker('assets', ASSETS_SCRIPT),
        worker('pro', PRO_SCRIPT),
      ],
    }),
  );
  await runtime.ready;
  const app = (await runtime.getWorker('app')) as unknown as LocalApp;
  const assets = (await runtime.getWorker('assets')) as unknown as LocalService;
  const assetsState = async () =>
    (await (await assets.fetch('http://assets/__state')).json()) as {
      reads: number;
      holding: boolean;
    };
  const appState = async () => (await (await app.fetch('http://app/state')).json()) as AppState;
  return {
    async hold() {
      await (await assets.fetch('http://assets/__hold')).text();
    },
    async release() {
      await (await assets.fetch('http://assets/__release')).text();
    },
    async cancel() {
      await (await runtime!.dispatchFetch('http://localhost/cancel')).text();
    },
    async request(path: string, cancellable = false) {
      const response = await runtime!.dispatchFetch(
        `http://localhost${path}${cancellable ? '?cancellable' : ''}`,
      );
      const body = await response.text();
      return { status: response.status, body: body.startsWith('{') ? JSON.parse(body) : body };
    },
    // One status server cron run, as a Cron Trigger would start it.
    async cron() {
      const result = await app.scheduled({ cron: STATUS_SERVER_CRON, scheduledTime: new Date() });
      return result.outcome;
    },
    async serviceWorkerReads() {
      return (await assetsState()).reads;
    },
    state: appState,
    // The first service worker read is held by the assets stand-in.
    async untilHolding() {
      await until('the first served build read to be held', async () => {
        return (await assetsState()).holding;
      });
    },
    // /served-build counts a call before it awaits the shared read.
    async untilEntered(calls: number) {
      await until(`${calls} direct reads to start`, async () => {
        return (await appState()).entered === calls;
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

describe('served App build read across workerd requests', () => {
  it.each(['status cron', 'floor read'] as const)(
    'lets the %s that comes next, and every later caller, read again after the first read is cancelled',
    async (next) => {
      const test = await harness();
      await test.hold();
      const creator = test.request(APP_BUILD_FLOOR_CLIENT_PATH, true);
      await test.untilHolding();
      await test.cancel();
      expect(await creator).toEqual({ status: 499, body: 'cancelled' });
      await test.release();

      // Before the fix every later caller was rejected with "can never
      // settle": the floor read failed and the cron recorded no row.
      if (next === 'status cron') expect(await test.cron()).toBe('ok');
      else expect(await test.request(APP_BUILD_FLOOR_CLIENT_PATH)).toEqual(FLOOR_OK);
      expect(await test.serviceWorkerReads()).toBe(2);

      expect(await test.request(APP_BUILD_FLOOR_CLIENT_PATH)).toEqual(FLOOR_OK);
      expect(await test.cron()).toBe('ok');
      expect(await test.request('/served-build')).toEqual(SERVED_BUILD_OK);
      // The recovered read is kept: nothing reads the asset again.
      expect(await test.serviceWorkerReads()).toBe(2);

      const state = await test.state();
      expect(state.rows).toEqual(next === 'status cron' ? [PRO_ROW, PRO_ROW] : [PRO_ROW]);
      expect(state.warnings).not.toContain('app_build_unavailable');
      expect(state.warnings.filter((event) => event === SHARED_READ_REJECTED)).toHaveLength(1);
    },
  );

  it('recovers a caller that was awaiting the shared read when its creator was cancelled', async () => {
    const test = await harness();
    await test.hold();
    const creator = test.request(APP_BUILD_FLOOR_CLIENT_PATH, true);
    await test.untilHolding();
    const waiter = test.request('/served-build');
    await test.untilEntered(1);
    await test.cancel();
    expect(await creator).toEqual({ status: 499, body: 'cancelled' });
    await test.release();

    expect(await waiter).toEqual(SERVED_BUILD_OK);
    expect(await test.cron()).toBe('ok');
    expect(await test.request(APP_BUILD_FLOOR_CLIENT_PATH)).toEqual(FLOOR_OK);
    expect(await test.serviceWorkerReads()).toBe(2);

    const state = await test.state();
    expect(state.rows).toEqual([PRO_ROW]);
    expect(state.warnings).not.toContain('app_build_unavailable');
    expect(state.warnings.filter((event) => event === SHARED_READ_REJECTED)).toHaveLength(1);
  });

  it('shares one read between concurrent callers when none is cancelled', async () => {
    const test = await harness();
    await test.hold();
    const creator = test.request(APP_BUILD_FLOOR_CLIENT_PATH);
    await test.untilHolding();
    const waiter = test.request('/served-build');
    await test.untilEntered(1);
    await test.release();

    expect(await creator).toEqual(FLOOR_OK);
    expect(await waiter).toEqual(SERVED_BUILD_OK);
    expect(await test.cron()).toBe('ok');
    expect(await test.request(APP_BUILD_FLOOR_CLIENT_PATH)).toEqual(FLOOR_OK);
    expect(await test.serviceWorkerReads()).toBe(1);

    const state = await test.state();
    expect(state.rows).toEqual([PRO_ROW]);
    expect(state.warnings).not.toContain('app_build_unavailable');
    expect(state.warnings).not.toContain(SHARED_READ_REJECTED);
  });
});

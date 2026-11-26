import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { localWorkerdPort } from './helpers/local-workerd-port.ts';

/**
 * The admin PRO room registry check (ensureAdminProRoomRegistry in
 * cloudflare/app-worker.ts) in actual workerd request contexts, with the real
 * App code bundled.
 *
 * The App Worker shares one check per D1 binding between the requests of an
 * isolate. workerd settles a promise only inside the request that created it
 * (handle_cross_request_promise_resolution, on by default since 2024-10-14).
 * When an admin client aborts the request that started the check (a second
 * PRO tab click, Refresh or reload), every request awaiting that check is
 * rejected with "can never settle". Before the fix only the creating request
 * cleared a failed check, so the rejected promise stayed cached and every later
 * admin PRO request in the isolate answered 503 PRO_ROOM_REGISTRY_UNAVAILABLE
 * until the isolate was replaced.
 *
 * A service binding stands in for D1 (this is not native D1) so one statement
 * can be held, then released or failed on cue, and the entry Worker cancels the
 * request marked cancellable when told to, as a client abort would. Every step
 * waits for an observed state instead of a time margin.
 */

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const appWorkerSource = fileURLToPath(
  new URL('../../../cloudflare/app-worker.ts', import.meta.url),
);
const appDate = readFileSync(
  new URL('../../../cloudflare/wrangler.app.toml', import.meta.url),
  'utf8',
).match(/compatibility_date = "([^"]+)"/)![1]!;

// The statement of the first check that the D1 stand-in holds.
const HELD_STATEMENT = 3;
const UNAVAILABLE = { status: 503, body: { error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' } };
const OK = { status: 200, body: { ok: true } };

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

// The App code: /ensure runs the check once; /list has the admin PRO list's
// shape, an earlier check whose failure is swallowed (owner transfer
// reconciliation) and then the list's own check, whose failure answers 503.
const APP_SHIM = `
import { ensureAdminProRoomRegistryForTests as ensure } from ${JSON.stringify(appWorkerSource)};
const events = [];
let entered = 0;
for (const level of ['info', 'warn']) {
  const original = console[level].bind(console);
  console[level] = (message, ...rest) => {
    if (typeof message === 'string' && message.startsWith('[PRO registry]')) {
      events.push({ level, message, details: rest[0] });
    } else {
      original(message, ...rest);
    }
  };
}
// Column answers that keep the check on the path a complete schema takes.
const COLUMNS = ['room_code', 'label', 'status', 'suspension_reason', 'activation_state',
  'room_generation', 'created_at', 'updated_at'];
async function send(d1) {
  const answer = await (await d1.fetch('http://d1/statement', { method: 'POST' })).json();
  if (answer.error) throw new Error(answer.error);
}
function standIn(d1) {
  const statement = (sql) => ({
    bind: () => statement(sql),
    async run() {
      await send(d1);
      return { success: true, meta: { changes: 0 } };
    },
    async all() {
      await send(d1);
      const pragma = sql.trimStart().toUpperCase().startsWith('PRAGMA');
      return { success: true, meta: {}, results: pragma ? COLUMNS.map((name) => ({ name })) : [] };
    },
  });
  return { prepare: (sql) => statement(sql) };
}
let db;
export default { async fetch(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname === '/state') return Response.json({ entered, events });
  db ??= standIn(env.D1);
  entered += 1;
  try {
    if (pathname === '/list') await ensure(db).catch(() => undefined);
    await ensure(db);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: 'PRO_ROOM_REGISTRY_UNAVAILABLE' }, { status: 503 });
  }
} };
`;

// D1 stand-in: counts statements; holds statement holdAt until /release
// (which may answer it with an error) and fails statement failAt.
const D1_SCRIPT = `
let config = {};
let count = 0;
let holding = false;
let release = null;
export default { async fetch(request) {
  const { pathname } = new URL(request.url);
  if (pathname === '/configure') {
    config = await request.json();
    count = 0;
    holding = false;
    release = null;
    return new Response('ok');
  }
  if (pathname === '/release') {
    release = await request.json();
    return new Response('ok');
  }
  if (pathname === '/state') return Response.json({ count, holding });
  count += 1;
  const position = count;
  if (position === config.holdAt) {
    holding = true;
    const giveUpAt = Date.now() + 10000;
    while (!release && Date.now() < giveUpAt) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    holding = false;
    if (!release) return Response.json({ error: 'D1 stand-in hold was never released' });
    if (release.error) return Response.json({ error: release.error });
  }
  if (position === config.failAt) return Response.json({ error: config.failMessage });
  return Response.json({ ok: true });
} };
`;

type LocalService = { fetch(input: string, init?: RequestInit): Promise<Response> };
interface RegistryEvent {
  level: 'info' | 'warn';
  message: string;
  details: Record<string, unknown>;
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
        worker('app', appScript, { D1: 'd1' }),
        worker('d1', D1_SCRIPT),
      ],
    }),
  );
  await runtime.ready;
  const app = (await runtime.getWorker('app')) as unknown as LocalService;
  const d1 = (await runtime.getWorker('d1')) as unknown as LocalService;
  const post = async (path: string, body: unknown) => {
    const init = { method: 'POST', body: JSON.stringify(body) };
    await (await d1.fetch(`http://d1${path}`, init)).text();
  };
  const d1State = async () =>
    (await (await d1.fetch('http://d1/state')).json()) as { count: number; holding: boolean };
  const appState = async () =>
    (await (await app.fetch('http://app/state')).json()) as {
      entered: number;
      events: RegistryEvent[];
    };
  return {
    configure: (config: { holdAt?: number; failAt?: number; failMessage?: string }) =>
      post('/configure', config),
    release: (answer: { error?: string } = {}) => post('/release', answer),
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
    async statementCount() {
      return (await d1State()).count;
    },
    async events() {
      return (await appState()).events;
    },
    // The first request's check holds statement HELD_STATEMENT.
    async untilHolding() {
      await until('the first check to reach the held statement', async () => {
        return (await d1State()).holding;
      });
    },
    // The App counts a request when it calls the check, which awaits any
    // check already cached before its first statement.
    async untilEntered(requests: number) {
      await until(`${requests} requests to call the check`, async () => {
        return (await appState()).entered === requests;
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

const ready = {
  level: 'info',
  message: '[PRO registry] schema ensure',
  details: expect.objectContaining({
    event: 'admin_pro_room_registry_schema_ensure',
    outcome: 'ready',
  }),
};

function failed(errorClass: string, statementCount: number) {
  return {
    level: 'info',
    message: '[PRO registry] schema ensure',
    details: expect.objectContaining({
      event: 'admin_pro_room_registry_schema_ensure',
      outcome: 'error',
      errorClass,
      statementCount,
    }),
  };
}

function sharedCheckRejected(errorClass: string) {
  return {
    level: 'warn',
    message: '[PRO registry] shared schema check rejected',
    details: { event: 'admin_pro_room_registry_shared_check_rejected', errorClass },
  };
}

// Statements of the one completed check; it must be the only one.
function completedCheckStatements(events: RegistryEvent[]) {
  const completed = events.filter((event) => event.details.outcome === 'ready');
  expect(completed).toHaveLength(1);
  const statements = completed[0]!.details.statementCount as number;
  expect(statements).toBeGreaterThan(HELD_STATEMENT);
  return statements;
}

describe('admin PRO room registry check across workerd requests', () => {
  it.each(['/ensure', '/list'] as const)(
    'recovers a waiting %s request and later requests after the creator is cancelled mid-check',
    async (route) => {
      const test = await harness();
      await test.configure({ holdAt: HELD_STATEMENT });
      const creator = test.request('/ensure', true);
      await test.untilHolding();
      const waiter = test.request(route);
      await test.untilEntered(2);
      await test.cancel();

      expect(await creator).toEqual({ status: 499, body: 'cancelled' });
      expect(await waiter).toEqual(OK);
      // The isolate is not stuck: later requests reuse the waiter's check.
      expect(await test.request(route)).toEqual(OK);
      expect(await test.request('/ensure')).toEqual(OK);

      const events = await test.events();
      // The cancelled creator never settles, so it logs nothing; the waiter
      // saw workerd's cross-request rejection and ran one fresh check.
      expect(events).toEqual([sharedCheckRejected('cross_request'), ready]);
      expect(await test.statementCount()).toBe(HELD_STATEMENT + completedCheckStatements(events));
    },
  );

  it('recovers a request that arrives after the creator was cancelled mid-check', async () => {
    const test = await harness();
    await test.configure({ holdAt: HELD_STATEMENT });
    const creator = test.request('/ensure', true);
    await test.untilHolding();
    await test.cancel();
    expect(await creator).toEqual({ status: 499, body: 'cancelled' });

    // Before the fix, this request and every later one found the cancelled
    // check still cached and answered 503.
    expect(await test.request('/list')).toEqual(OK);
    expect(await test.request('/ensure')).toEqual(OK);

    const events = await test.events();
    expect(events).toEqual([sharedCheckRejected('cross_request'), ready]);
    expect(await test.statementCount()).toBe(HELD_STATEMENT + completedCheckStatements(events));
  });

  it('shares one check between concurrent requests when none is cancelled', async () => {
    const test = await harness();
    await test.configure({ holdAt: HELD_STATEMENT });
    const creator = test.request('/ensure');
    await test.untilHolding();
    const waiter = test.request('/list');
    await test.untilEntered(2);
    await test.release();

    expect(await creator).toEqual(OK);
    expect(await waiter).toEqual(OK);
    expect(await test.request('/list')).toEqual(OK);

    const events = await test.events();
    expect(events).toEqual([ready]);
    expect(await test.statementCount()).toBe(completedCheckStatements(events));
  });

  it('answers one failure for an injected D1 error and recovers on the next request', async () => {
    const test = await harness();
    await test.configure({ failAt: 5, failMessage: 'D1_ERROR: Network connection lost.' });

    expect(await test.request('/ensure')).toEqual(UNAVAILABLE);
    expect(await test.request('/ensure')).toEqual(OK);
    expect(await test.request('/list')).toEqual(OK);

    const events = await test.events();
    expect(events).toEqual([failed('d1_network', 5), ready]);
    expect(await test.statementCount()).toBe(5 + completedCheckStatements(events));
    expect(JSON.stringify(events)).not.toMatch(/D1_ERROR|Network connection lost/u);
  });

  it('lets a request that waited on a check failed by D1 run its own check', async () => {
    const test = await harness();
    await test.configure({ holdAt: HELD_STATEMENT });
    const creator = test.request('/ensure');
    await test.untilHolding();
    const waiter = test.request('/ensure');
    await test.untilEntered(2);
    await test.release({ error: 'D1_ERROR: D1 DB is overloaded. Too many requests queued.' });

    expect(await creator).toEqual(UNAVAILABLE);
    expect(await waiter).toEqual(OK);
    expect(await test.request('/ensure')).toEqual(OK);

    const events = await test.events();
    expect(events).toEqual([
      failed('d1_overloaded', HELD_STATEMENT),
      sharedCheckRejected('other'),
      ready,
    ]);
    expect(await test.statementCount()).toBe(HELD_STATEMENT + completedCheckStatements(events));
    expect(JSON.stringify(events)).not.toMatch(/D1_ERROR|D1 DB is|requests queued/u);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';

// Exercise the shipped handlers in actual workerd request contexts. A service
// binding stands in for slow D1/control I/O; these are not native D1 tests.
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const appDate = readFileSync(
  new URL('../../../cloudflare/wrangler.app.toml', import.meta.url),
  'utf8',
).match(/compatibility_date = "([^"]+)"/)![1]!;
const proDate = readFileSync(
  new URL('../../../cloudflare/wrangler.pro-room.toml', import.meta.url),
  'utf8',
).match(/compatibility_date = "([^"]+)"/)![1]!;
let runtime: Miniflare | undefined;
type LocalService = { fetch(input: string, init?: RequestInit): Promise<Response> };

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

async function harness(owned = true) {
  const bundled = await build({
    absWorkingDir: repository,
    stdin: {
      resolveDir: repository,
      contents: `
        import front from './cloudflare/pro-room-worker.ts';
        import { readServiceMaintenance, readAdminAnnouncementControl } from './cloudflare/service-maintenance.ts';
        let db, binding;
        const realNow = Date.now;
        let offset = 0;
        Date.now = () => realNow() + offset;
        export default { async fetch(request, env, ctx) {
          const url = new URL(request.url);
          if (url.pathname === '/clock') {
            offset = Number(url.searchParams.get('offset'));
            return new Response('ok');
          }
          db ??= { prepare(sql) { return {
            bind() { return this },
            async all() { return (await env.SLOW.fetch('http://slow/list')).json() },
            async first() { return (await env.SLOW.fetch('http://slow/recheck')).json() },
          } } };
          binding ??= { getByName() { return { fetch: (request) => env.SLOW.fetch(request) } } };
          const context = ${owned ? 'ctx' : 'undefined'};
          if (url.pathname === '/maintenance') {
            return Response.json(await readServiceMaintenance({ MUSIXQUARE_SERVICE_CONTROL: binding }, { context }));
          }
          if (url.pathname === '/announcement') {
            return Response.json(await readAdminAnnouncementControl({ MUSIXQUARE_SERVICE_CONTROL: binding }, { context }));
          }
          return front.fetch(request, {
            MUSIXQUARE_ADMIN_DB: db,
            PRO_ROOM_RATE_LIMIT_SECRET: 'test-only-secret-with-at-least-32-bytes',
            ALLOWED_ORIGINS: 'https://musixquare.test',
            PRO_ROOMS: {
              idFromName(name) { return name },
              get(name) { return { fetch() { return Response.json({ objectName: name }) } } },
            },
          }, context);
        } };
      `,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.NONE),
      workers: [
        {
          name: 'app',
          modules: true,
          compatibilityDate: appDate,
          serviceBindings: { FRONT: 'front' },
          script: `export default { async fetch(request, env) {
          const url = new URL(request.url);
          const controller = new AbortController();
          let timer;
          const deadline = Number(url.searchParams.get('deadline') || 4000);
          url.search = '';
          const operation = env.FRONT.fetch(new Request(url, {
            signal: controller.signal,
            headers: { Origin: 'https://musixquare.test' },
          })).then(async r => new Response(await r.text(), r)).catch(() => null);
          const timeout = new Promise(resolve => {
            timer = setTimeout(() => { controller.abort(); resolve(null) }, deadline);
          });
          const result = await Promise.race([operation, timeout]);
          clearTimeout(timer);
          return result ?? new Response('proxy-timeout', { status: 502 });
        } };`,
        },
        {
          name: 'front',
          modules: true,
          compatibilityDate: proDate,
          serviceBindings: { SLOW: 'slow' },
          script: bundled.outputFiles[0]!.text,
        },
        {
          name: 'slow',
          modules: true,
          compatibilityDate: proDate,
          script: `
          let config = { status: 'registered', generation: 0, delay: 0 };
          let counts = {};
          export default { async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === '/configure') {
              config = { ...config, ...await request.json() };
              return Response.json(counts);
            }
            if (path === '/counts') return Response.json(counts);
            counts[path] = (counts[path] || 0) + 1;
            const snapshot = { ...config };
            await new Promise(resolve => setTimeout(resolve, snapshot.delay));
            const row = { room_code: '000000', room_generation: snapshot.generation, status: snapshot.status };
            if (path === '/list') return Response.json({ results: [row] });
            if (path === '/recheck') return Response.json(row);
            if (path.includes('service-maintenance')) {
              return new Response(null, { headers: {
                'X-Musixquare-Service-Control-Version': '1',
                'X-Musixquare-Service-Control-Enabled': '0',
                'X-Musixquare-Service-Control-Revision': '1',
                'X-Musixquare-Service-Control-Updated-At': '1800000000000',
                'X-Musixquare-Service-Control-Activated-At': 'null',
              } });
            }
            return Response.json({ announcementState: {
              revision: 1,
              announcement: { id: 'notice-1', message: 'Test', enabled: true, expiresAt: null, updatedAt: '2026-10-13T00:00:00.000Z' },
              history: [{ id: 'notice-1', message: 'Test', enabled: true, expiresAt: null, updatedAt: '2026-10-13T00:00:00.000Z', action: 'published' }],
            } });
          } };
        `,
        },
      ],
    }),
  );
  await runtime.ready;
  const slow = (await runtime.getWorker('slow')) as unknown as LocalService;
  const front = (await runtime.getWorker('front')) as unknown as LocalService;
  return {
    async configure(config: Record<string, unknown>) {
      await slow.fetch('http://slow/configure', { method: 'POST', body: JSON.stringify(config) });
    },
    async counts() {
      return (await (await slow.fetch('http://slow/counts')).json()) as Record<string, number>;
    },
    async expire() {
      await front.fetch('http://front/clock?offset=6000');
    },
    async read(path = '/v1/rooms/000000/snapshot', deadline = 4000) {
      const response = await runtime!.dispatchFetch(`http://localhost${path}?deadline=${deadline}`);
      const body = await response.text();
      return { status: response.status, body: body.startsWith('{') ? JSON.parse(body) : body };
    },
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('request lifetime of shared Worker reads (workerd)', () => {
  it.each(['list', 'recheck'] as const)(
    'keeps a %s lookup alive after its first caller is cancelled',
    async (kind) => {
      const test = await harness();
      if (kind === 'recheck') {
        await test.configure({ status: 'suspended' });
        expect((await test.read('/v1/rooms/000000/bootstrap')).status).toBe(200);
      }
      await test.configure({ status: 'registered', delay: 450 });
      const first = test.read(undefined, 100);
      await pause(50);
      const second = test.read();
      expect((await first).status).toBe(502);
      expect(await second).toMatchObject({
        status: 200,
        body: { objectName: '000000:generation:0' },
      });
      expect((await test.read()).status).toBe(200);
      expect((await test.counts())[`/${kind}`]).toBe(1);
    },
  );

  it('coalesces a successful cold burst and reuses the completed registry', async () => {
    const test = await harness();
    await test.configure({ delay: 200 });
    const responses = await Promise.all(Array.from({ length: 8 }, () => test.read()));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect((await test.read()).status).toBe(200);
    expect((await test.counts())['/list']).toBe(1);
  });

  it.each(['list', 'recheck'] as const)(
    'bounds a stalled %s lookup and permits a successor without late promotion',
    async (kind) => {
      const test = await harness();
      if (kind === 'recheck') {
        await test.configure({ status: 'suspended' });
        expect((await test.read('/v1/rooms/000000/bootstrap')).status).toBe(200);
      }
      await test.configure({ status: 'registered', delay: 2700 });
      const first = test.read(undefined, 100);
      await pause(50);
      const second = test.read();
      expect((await first).status).toBe(502);
      expect(await second).toMatchObject({ status: 404, body: { error: 'ROOM_NOT_FOUND' } });
      await test.configure({ status: 'suspended', delay: 0 });
      if (kind === 'list') await test.expire();
      expect((await test.read()).status).toBe(404);
      await pause(750);
      expect((await test.read()).status).toBe(404);
      await test.configure({ status: 'registered', delay: 0 });
      expect((await test.read()).status).toBe(200);
      expect((await test.counts())[`/${kind}`]).toBeGreaterThanOrEqual(2);
    },
  );

  it('does not let a cancelled unowned read poison later registry requests', async () => {
    const test = await harness(false);
    await test.configure({ delay: 450 });
    const first = test.read(undefined, 100);
    await pause(50);
    const second = test.read();
    expect((await first).status).toBe(502);
    expect((await second).status).toBe(200);
    expect((await test.read()).status).toBe(200);
    expect((await test.counts())['/list']).toBe(2);
  });

  it('fences an older unowned registry read behind a newer generation', async () => {
    const test = await harness(false);
    await test.configure({ delay: 450, generation: 0 });
    const first = test.read();
    await pause(100);
    await test.configure({ delay: 0, generation: 7 });
    expect(await test.read()).toMatchObject({
      status: 200,
      body: { objectName: '000000:generation:7' },
    });
    expect(await first).toMatchObject({ status: 200, body: { objectName: '000000:generation:7' } });
    expect(await test.read()).toMatchObject({
      status: 200,
      body: { objectName: '000000:generation:7' },
    });
  });

  it('does not reopen an expired positive cache while a newer unowned read is pending', async () => {
    const test = await harness(false);
    expect((await test.read()).status).toBe(200);
    await test.expire();
    await test.configure({ delay: 250 });
    const older = test.read();
    await pause(100);
    await test.configure({ delay: 450, status: 'decommissioned' });
    const newer = test.read();
    expect((await older).status).toBe(404);
    expect((await newer).status).toBe(404);
    expect((await test.read()).status).toBe(404);
  });

  it.each([
    ['maintenance', true],
    ['maintenance', false],
    ['announcement', true],
    ['announcement', false],
  ] as const)('recovers %s reads after cancellation with ownership=%s', async (kind, owned) => {
    const test = await harness(owned);
    await test.configure({ delay: 450 });
    const first = test.read(`/${kind}`, 100);
    await pause(50);
    const second = test.read(`/${kind}`);
    expect((await first).status).toBe(502);
    const expected = kind === 'maintenance' ? { enabled: false, revision: 1 } : { status: 'ok' };
    expect(await second).toMatchObject({ status: 200, body: expected });
    expect(await test.read(`/${kind}`)).toMatchObject({ status: 200, body: expected });
    const counts = await test.counts();
    expect(
      counts[
        `/internal/${kind === 'maintenance' ? 'service-maintenance' : 'admin-announcement'}/v1/status`
      ],
    ).toBe(owned ? 1 : 2);
  });

  it.each(['maintenance', 'announcement'] as const)(
    'bounds an owned stalled %s read and recovers after its failure cache expires',
    async (kind) => {
      const test = await harness();
      await test.configure({ delay: 2700 });
      const first = test.read(`/${kind}`, 100);
      await pause(50);
      const second = test.read(`/${kind}`);
      expect((await first).status).toBe(502);
      const unavailable =
        kind === 'maintenance'
          ? { enabled: true, controlUnavailable: true }
          : { status: 'unavailable' };
      expect(await second).toMatchObject({ status: 200, body: unavailable });
      await test.configure({ delay: 0 });
      await test.expire();
      const expected = kind === 'maintenance' ? { enabled: false, revision: 1 } : { status: 'ok' };
      expect(await test.read(`/${kind}`)).toMatchObject({ status: 200, body: expected });
      await pause(750);
      expect(await test.read(`/${kind}`)).toMatchObject({ status: 200, body: expected });
      const counts = await test.counts();
      expect(
        counts[
          `/internal/${kind === 'maintenance' ? 'service-maintenance' : 'admin-announcement'}/v1/status`
        ],
      ).toBe(2);
    },
  );
});

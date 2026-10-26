import { afterEach, describe, expect, it, vi } from 'vitest';

import appWorker from '../../../cloudflare/app-worker.ts';
import proRoomWorker from '../../../cloudflare/pro-room-worker.ts';
import {
  APP_BUILD_FLOOR_REPORT_STALE_MS,
  APP_BUILD_HEADER,
} from '../../../cloudflare/app-build-floor-contract.ts';
import {
  APP_BUILD_FLOOR_STATE_PATH,
  SERVICE_CONTROL_OBJECT_NAME,
  clearServiceMaintenanceCacheForTests,
} from '../../../cloudflare/service-maintenance.ts';
import { createAtomicRateControlBinding } from '../../core/__tests__/service-control-rate-limit-fixture.ts';

// The developer canary room resolves without the D1 registry binding.
const ROOM_CODE = '000000';
const BASE_URL = `https://pro.musixquare.com/v1/rooms/${ROOM_CODE}`;
const ORIGIN = 'https://musixquare.com';

type EntryRequest = readonly [method: 'GET' | 'POST', path: string];

const GATED_ENTRIES: readonly EntryRequest[] = [
  ['GET', '/bootstrap'],
  ['POST', '/sessions'],
  ['POST', '/presence/enter'],
];

const UNGATED_REQUESTS: readonly EntryRequest[] = [
  ['POST', '/activation'],
  ['POST', '/owner-recovery'],
  ['POST', '/owner-transfer'],
  ['POST', '/owner-transfer/prepare'],
  ['POST', '/presence/heartbeat'],
  ['GET', '/snapshot'],
  ['POST', '/signaling-tickets'],
  ['GET', '/presence/current'],
  ['POST', '/presence/close'],
  ['POST', '/sessions/current/close'],
  ['GET', '/sessions'],
  ['GET', '/presence/enter'],
  ['POST', '/bootstrap'],
];

async function raiseFloor(
  binding: ReturnType<typeof createAtomicRateControlBinding>['binding'],
  minAppBuild: number,
): Promise<void> {
  const object = binding.get(binding.idFromName(SERVICE_CONTROL_OBJECT_NAME));
  const response = await object.fetch(
    new Request(`https://service-control.internal${APP_BUILD_FLOOR_STATE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        minAppBuild,
        expectedRevision: 0,
        requestId: `pro-gate-floor-${minAppBuild}`,
        liveAppBuild: minAppBuild,
        reason: 'PRO entry gate test',
      }),
    }),
  );
  expect(response.status).toBe(200);
}

async function frontDoor(minAppBuild: number, extraEnv: Record<string, unknown> = {}) {
  const control = createAtomicRateControlBinding();
  if (minAppBuild > 0) await raiseFloor(control.binding, minAppBuild);
  const downstream = vi.fn(async (_request: Request) => Response.json({ ok: true }));
  const env = {
    PRO_ROOM_RATE_LIMIT_SECRET: 'rate-limit-secret-'.padEnd(48, 'r'),
    MUSIXQUARE_SERVICE_CONTROL: control.binding,
    PRO_ROOMS: {
      idFromName: (value: string) => value,
      get: () => ({ fetch: downstream }),
    },
    ...extraEnv,
  };
  const call = (entry: EntryRequest, appBuild?: string) => {
    const [method, path] = entry;
    const headers = new Headers({ origin: ORIGIN, 'cf-connecting-ip': '192.0.2.10' });
    if (appBuild !== undefined) headers.set(APP_BUILD_HEADER, appBuild);
    if (method === 'POST') headers.set('content-type', 'application/json');
    return proRoomWorker.fetch(
      new Request(`${BASE_URL}${path}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: '{}' } : {}),
      }),
      env as never,
    );
  };
  return { env, downstream, call };
}

afterEach(() => {
  clearServiceMaintenanceCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PRO room App build floor gate', () => {
  it('refuses the three entry paths below the effective floor before resolving the room', async () => {
    const adminPrepare = vi.fn(() => {
      throw new Error('the room registry must not be read for a refused entry');
    });
    const { call, downstream } = await frontDoor(785, {
      MUSIXQUARE_ADMIN_DB: { prepare: adminPrepare },
    });
    for (const entry of GATED_ENTRIES) {
      for (const appBuild of [undefined, '784', '0', '', 'v785', '0785', '785.0', ' 1e3']) {
        const response = await call(entry, appBuild);
        const label = `${entry.join(' ')} ${String(appBuild)}`;
        expect(response.status, label).toBe(426);
        expect(response.headers.get('cache-control'), label).toBe('no-store');
        expect(response.headers.get('access-control-allow-origin'), label).toBe(ORIGIN);
        expect(response.headers.get('upgrade'), label).toBeNull();
        expect(await response.json(), label).toEqual({
          error: 'APP_UPDATE_REQUIRED',
          minAppBuild: 785,
        });
      }
    }
    expect(downstream).not.toHaveBeenCalled();
    expect(adminPrepare).not.toHaveBeenCalled();
  });

  it('admits the entry paths at or above the effective floor and forwards the build', async () => {
    const { call, downstream } = await frontDoor(785);
    for (const entry of GATED_ENTRIES) {
      for (const appBuild of ['785', '786']) {
        const response = await call(entry, appBuild);
        expect(response.status, `${entry.join(' ')} ${appBuild}`).toBe(200);
      }
    }
    expect(downstream).toHaveBeenCalledTimes(GATED_ENTRIES.length * 2);
    expect(
      downstream.mock.calls.map(([request]) => (request as Request).headers.get(APP_BUILD_HEADER)),
    ).toEqual(['785', '786', '785', '786', '785', '786']);
  });

  it('leaves claim, in-session and other requests ungated below the floor', async () => {
    const { call, downstream } = await frontDoor(785);
    for (const entry of UNGATED_REQUESTS) {
      const response = await call(entry);
      expect(response.status, entry.join(' ')).toBe(200);
    }
    expect(downstream).toHaveBeenCalledTimes(UNGATED_REQUESTS.length);
  });

  it('refuses nobody while the floor is off, unbound or its live report is stale', async () => {
    const off = await frontDoor(0);
    expect((await off.call(GATED_ENTRIES[0]!)).status).toBe(200);

    const unbound = await frontDoor(785, { MUSIXQUARE_SERVICE_CONTROL: undefined });
    expect((await unbound.call(GATED_ENTRIES[1]!)).status).toBe(200);

    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-25T13:00:00.000Z'));
    const stale = await frontDoor(785);
    expect((await stale.call(GATED_ENTRIES[0]!)).status).toBe(426);
    await vi.advanceTimersByTimeAsync(APP_BUILD_FLOOR_REPORT_STALE_MS + 1);
    expect((await stale.call(GATED_ENTRIES[0]!)).status).toBe(200);
    expect(stale.downstream).toHaveBeenCalledOnce();
  });

  it('allows the build header in the CORS preflight for the loopback client', async () => {
    const { env } = await frontDoor(0);
    const preflight = await proRoomWorker.fetch(
      new Request(`${BASE_URL}/bootstrap`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-mxqr-app-build',
        },
      }),
      env as never,
    );
    expect(preflight.status).toBe(204);
    expect(
      preflight.headers
        .get('access-control-allow-headers')
        ?.split(',')
        .includes('x-mxqr-app-build'),
    ).toBe(true);
  });

  it('carries the build header through the App facade and relays the refusal unchanged', async () => {
    const { env, downstream } = await frontDoor(785);
    const forwarded: Request[] = [];
    const facadeEnv = {
      PRO_ROOM_PUBLIC_API: {
        fetch: vi.fn(async (request: Request) => {
          forwarded.push(request.clone());
          return proRoomWorker.fetch(request, env as never);
        }),
      },
    };
    const bootstrap = (appBuild: string) =>
      appWorker.fetch(
        new Request(`https://musixquare.com/api/pro-room/v1/rooms/${ROOM_CODE}/bootstrap`, {
          headers: { [APP_BUILD_HEADER]: appBuild },
        }),
        facadeEnv as never,
      );

    const refused = await bootstrap('784');
    expect(refused.status).toBe(426);
    expect(await refused.json()).toEqual({ error: 'APP_UPDATE_REQUIRED', minAppBuild: 785 });
    const admitted = await bootstrap('785');
    expect(admitted.status).toBe(200);

    expect(forwarded.map((request) => request.headers.get(APP_BUILD_HEADER))).toEqual([
      '784',
      '785',
    ]);
    expect(downstream).toHaveBeenCalledOnce();
    expect((downstream.mock.calls[0]![0] as Request).headers.get(APP_BUILD_HEADER)).toBe('785');
  });
});

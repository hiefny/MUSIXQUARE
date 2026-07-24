import { describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.js';

const CANARY_CODE = '099999';
const CANARY_BASE = `https://musixquare.com/_mxqr-ops/v1/pro-room-reuse-canary/${CANARY_CODE}`;
const CANARY_SECRET = 'canary-ops-test-secret-material-48-characters-long';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';

type RegistryRow = {
  room_code: string;
  label: string;
  status: string;
  activation_state: string;
  room_generation: number;
  created_at: number;
  updated_at: number;
};

type KeyRow = {
  key_id: string;
  room_code: string;
  room_generation: number;
  label: string;
  secret_digest: string;
  digest_version: number;
  scope_mask: number;
  status: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_hour: number | null;
};

function canaryHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${CANARY_SECRET}`,
    ...extra,
  };
}

function canaryMutation(action: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${CANARY_BASE}/${action}`, {
    method: 'POST',
    headers: canaryHeaders({
      'Content-Type': 'application/json',
      ...headers,
    }),
    body: JSON.stringify(body),
  });
}

function expectCanaryHeaders(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0, must-revalidate');
  expect(response.headers.get('Pragma')).toBe('no-cache');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  expect(response.headers.get('Set-Cookie')).toBeNull();
  expect(response.headers.get('Authorization')).toBeNull();
}

function createGenerationCanaryEnv(roomGeneration = 0) {
  const now = Date.now();
  const registryRows = new Map<string, RegistryRow>([
    [
      CANARY_CODE,
      {
        room_code: CANARY_CODE,
        label: 'Decommissioned PRO room',
        status: 'decommissioned',
        activation_state: 'unactivated',
        room_generation: roomGeneration,
        created_at: now - 100_000,
        updated_at: now - 10_000,
      },
    ],
  ]);
  const allocations = new Set([`${CANARY_CODE}:${roomGeneration}`]);
  const history = new Set([`${CANARY_CODE}:${roomGeneration}`]);
  const proAudits: Array<{
    action: string;
    result: string;
    roomCode: string;
    roomGeneration: number;
  }> = [];

  const adminDb = {
    prepare: vi.fn((sql: string) => {
      const executeRun = (...values: unknown[]) => {
        if (/INSERT OR IGNORE INTO mxqr_pro_room_generation_allocations/i.test(sql)) {
          return { meta: { changes: 0 } };
        }
        if (
          /INSERT OR IGNORE INTO mxqr_pro_room_registry/i.test(sql) &&
          !/SELECT \?1, \?2, 'provisioning'/i.test(sql)
        ) {
          return { meta: { changes: 0 } };
        }
        if (/INSERT OR IGNORE INTO mxqr_pro_room_generation_history/i.test(sql)) {
          const [roomCode, roomGeneration] = values as [string, number];
          history.add(`${roomCode}:${roomGeneration}`);
          return { meta: { changes: 1 } };
        }
        if (/room_generation = room_generation \+ 1/i.test(sql)) {
          const [roomCode, label, timestamp, roomGeneration] = values as [
            string,
            string,
            number,
            number,
          ];
          const row = registryRows.get(roomCode);
          if (
            !row ||
            row.status !== 'decommissioned' ||
            row.room_generation !== roomGeneration ||
            !history.has(`${roomCode}:${roomGeneration}`)
          ) {
            return { meta: { changes: 0 } };
          }
          row.label = label;
          row.status = 'provisioning';
          row.activation_state = 'unactivated';
          row.room_generation += 1;
          row.created_at = timestamp;
          row.updated_at = timestamp;
          allocations.add(`${roomCode}:${row.room_generation}`);
          return { meta: { changes: 1 } };
        }
        if (/SET status = 'registered', activation_state = \?3/i.test(sql)) {
          const [roomCode, roomGeneration, activationState, timestamp] = values as [
            string,
            number,
            string,
            number,
          ];
          const row = registryRows.get(roomCode);
          if (!row || row.room_generation !== roomGeneration) return { meta: { changes: 0 } };
          row.status = 'registered';
          row.activation_state = activationState;
          row.updated_at = timestamp;
          return { meta: { changes: 1 } };
        }
        if (/SET status = 'decommissioning'/i.test(sql)) {
          const [roomCode, roomGeneration, timestamp] = values as [string, number, number];
          const row = registryRows.get(roomCode);
          if (!row || row.room_generation !== roomGeneration) return { meta: { changes: 0 } };
          row.status = 'decommissioning';
          row.activation_state = 'unactivated';
          row.updated_at = timestamp;
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO mxqr_pro_room_admin_audit/i.test(sql)) {
          const [, action, result, roomCode, roomGeneration] = values as [
            string,
            string,
            string,
            string,
            number,
          ];
          proAudits.push({ action, result, roomCode, roomGeneration });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      };
      const bound = (...values: unknown[]) => ({
        run: vi.fn(async () => executeRun(...values)),
        first: vi.fn(async () => {
          if (/FROM mxqr_pro_room_generation_cutover/i.test(sql)) {
            return {
              status: 'ready',
              release_sha: '1234567890abcdef1234567890abcdef12345678',
              ever_enabled: 1,
              floor_release_sha: '1234567890abcdef1234567890abcdef12345678',
            };
          }
          if (/AS has_allocation/i.test(sql) && /AS has_history/i.test(sql)) {
            const key = `${String(values[0])}:${Number(values[1])}`;
            return {
              has_allocation: allocations.has(key) ? 1 : 0,
              has_history: history.has(key) ? 1 : 0,
            };
          }
          return registryRows.get(String(values[0])) || null;
        }),
        all: vi.fn(async () => {
          if (/PRAGMA table_info/i.test(sql)) {
            return { results: [{ name: 'room_generation' }] };
          }
          return { results: [...registryRows.values()] };
        }),
      });
      return {
        bind: vi.fn(bound),
        run: vi.fn(async () => executeRun()),
        all: vi.fn(async () => ({ results: [] })),
      };
    }),
  };

  const keyRows = new Map<string, KeyRow>();
  const developerAudits: Array<{ roomGeneration: number; action: string }> = [];
  const developerDb = {
    prepare: vi.fn((sql: string) => {
      const executeRun = (...values: unknown[]) => {
        if (/SET status = 'revoked', revoked_at = expires_at/i.test(sql)) {
          return { meta: { changes: 0 } };
        }
        if (/INSERT INTO mxqr_developer_api_keys/i.test(sql)) {
          const [
            keyId,
            roomCode,
            roomGeneration,
            label,
            secretDigest,
            scopeMask,
            createdAt,
            expiresAt,
          ] = values as [string, string, number, string, string, number, number, number];
          keyRows.set(keyId, {
            key_id: keyId,
            room_code: roomCode,
            room_generation: roomGeneration,
            label,
            secret_digest: secretDigest,
            digest_version: 1,
            scope_mask: scopeMask,
            status: 'active',
            created_at: createdAt,
            updated_at: createdAt,
            expires_at: expiresAt,
            revoked_at: null,
            last_used_hour: null,
          });
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO mxqr_developer_api_admin_audit/i.test(sql)) {
          const [, action, , , , roomGeneration] = values as [
            string,
            string,
            string,
            string,
            string,
            number,
          ];
          developerAudits.push({ action, roomGeneration });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      };
      const bound = (...values: unknown[]) => ({
        run: vi.fn(async () => executeRun(...values)),
        first: vi.fn(async () => {
          if (/FROM mxqr_developer_api_keys/i.test(sql)) {
            const [roomCode, roomGeneration, keyId] = values as [string, number, string];
            const row = keyRows.get(keyId);
            return row?.room_code === roomCode && row.room_generation === roomGeneration
              ? row
              : null;
          }
          return null;
        }),
        all: vi.fn(async () => ({ results: [] })),
      });
      return {
        bind: vi.fn(bound),
        run: vi.fn(async () => executeRun()),
      };
    }),
    batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }),
  };

  const durableObjectCalls: Array<{
    objectName: string;
    pathname: string;
    roomGeneration: string | null;
    body: unknown;
  }> = [];
  let activeObjectName = '';
  const namespace = {
    idFromName: vi.fn((objectName: string) => objectName),
    get: vi.fn((objectName: string) => {
      activeObjectName = objectName;
      return {
        fetch: vi.fn(async (request: Request) => {
          const pathname = new URL(request.url).pathname;
          const text = await request.text();
          const body = text ? JSON.parse(text) : null;
          const wireGeneration = request.headers.get('x-mxqr-pro-room-generation');
          durableObjectCalls.push({
            objectName: activeObjectName,
            pathname,
            roomGeneration: wireGeneration,
            body,
          });
          const identity = { roomCode: CANARY_CODE, roomGeneration: roomGeneration + 1 };
          if (pathname === '/internal/admin/provision') {
            return Response.json({ ok: true, ...identity, status: 'unactivated' });
          }
          if (pathname === '/internal/admin/activation-claim') {
            return Response.json({
              ...identity,
              activationUrl: `https://musixquare.com/${CANARY_CODE}#pro-claim=canary-claim`,
              expiresAt: Date.now() + 15 * 60 * 1000,
            });
          }
          if (pathname === '/internal/admin/status') {
            return Response.json({ ...identity, provisioned: true, status: 'active' });
          }
          if (pathname === '/internal/admin/decommission') {
            return Response.json(
              {
                ok: true,
                ...identity,
                status: 'decommissioning',
                purgeAfterMs: Date.now() + 10 * 60 * 1000,
                completedAtMs: null,
              },
              { status: 202 },
            );
          }
          return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
        }),
      };
    }),
  };

  return {
    env: {
      MXQR_PRO_ROOM_REUSE_CANARY_OPS_SECRET: CANARY_SECRET,
      MXQR_ADMIN_PASSWORD: 'admin-password',
      MXQR_ADMIN_SESSION_SECRET: 'admin-session-secret-at-least-32-characters',
      MXQR_DEVELOPER_API_KEY_PEPPER: 'developer-api-pepper-at-least-32-characters',
      MUSIXQUARE_ADMIN_DB: adminDb,
      DEVELOPER_API_DB: developerDb,
      PRO_ROOM_ADMIN_ROOMS: namespace,
    },
    registryRows,
    keyRows,
    proAudits,
    developerAudits,
    durableObjectCalls,
  };
}

describe('temporary generation-aware PRO room reuse canary control', () => {
  it('fails closed outside the exact endpoint and bearer contract', async () => {
    const fixture = createGenerationCanaryEnv();
    const attempts = [
      new Request(`${CANARY_BASE}/status`),
      new Request(`${CANARY_BASE}/status?verbose=1`, { headers: canaryHeaders() }),
      new Request(`${CANARY_BASE}/status`, {
        headers: canaryHeaders({ Origin: 'https://musixquare.com' }),
      }),
      new Request(`https://musixquare.com/_mxqr-ops/v1/pro-room-reuse-canary/099998/status`, {
        headers: canaryHeaders(),
      }),
      new Request(`http://musixquare.com${new URL(`${CANARY_BASE}/status`).pathname}`, {
        headers: canaryHeaders(),
      }),
      new Request(`${CANARY_BASE}/register`, { headers: canaryHeaders() }),
    ];

    for (const request of attempts) {
      const response = await appWorker.fetch(request, fixture.env);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
      expectCanaryHeaders(response);
    }
  });

  it('requires the caller to bind every mutation to the current generation', async () => {
    const fixture = createGenerationCanaryEnv();

    const initialStatus = await appWorker.fetch(
      new Request(`${CANARY_BASE}/status`, { headers: canaryHeaders() }),
      fixture.env,
    );
    expect(initialStatus.status).toBe(200);
    expect(await initialStatus.json()).toMatchObject({
      roomCode: CANARY_CODE,
      roomGeneration: 0,
      registerRoomGeneration: 1,
      room: { roomCode: CANARY_CODE, roomGeneration: 0, status: 'decommissioned' },
    });
    expectCanaryHeaders(initialStatus);

    const staleRegister = await appWorker.fetch(
      canaryMutation('register', { roomGeneration: 0 }),
      fixture.env,
    );
    expect(staleRegister.status).toBe(409);
    expect(await staleRegister.json()).toMatchObject({
      error: 'PRO_ROOM_GENERATION_MISMATCH',
      roomGeneration: 0,
      registerRoomGeneration: 1,
    });
    expect(fixture.durableObjectCalls).toHaveLength(0);

    const registered = await appWorker.fetch(
      canaryMutation('register', { roomGeneration: 1 }),
      fixture.env,
    );
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({
      room: {
        roomCode: CANARY_CODE,
        roomGeneration: 1,
        status: 'registered',
      },
    });
    expectCanaryHeaders(registered);
    expect(fixture.registryRows.get(CANARY_CODE)).toMatchObject({
      room_generation: 1,
      status: 'registered',
    });

    for (const [action, body] of [
      ['activation-claim', { roomGeneration: 0 }],
      ['api-key', { requestId: REQUEST_ID, roomGeneration: 0 }],
      ['decommission', { confirmRoomCode: CANARY_CODE, requestId: REQUEST_ID, roomGeneration: 0 }],
    ] as const) {
      const stale = await appWorker.fetch(canaryMutation(action, body), fixture.env);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({
        error:
          action === 'api-key' ? 'PRO_ROOM_GENERATION_CONFLICT' : 'PRO_ROOM_GENERATION_MISMATCH',
      });
    }
    expect(fixture.durableObjectCalls.map(({ pathname }) => pathname)).toEqual([
      '/internal/admin/provision',
    ]);

    const claim = await appWorker.fetch(
      canaryMutation('activation-claim', { roomGeneration: 1 }),
      fixture.env,
    );
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({
      roomCode: CANARY_CODE,
      roomGeneration: 1,
      activationUrl: expect.stringContaining(`/${CANARY_CODE}#pro-claim=`),
    });

    const key = await appWorker.fetch(
      canaryMutation('api-key', { requestId: REQUEST_ID, roomGeneration: 1 }),
      fixture.env,
    );
    expect(key.status).toBe(201);
    expect(await key.json()).toMatchObject({
      roomCode: CANARY_CODE,
      roomGeneration: 1,
      apiKey: expect.stringMatching(/^mxqr_live_/),
      key: { roomGeneration: 1 },
    });
    expect([...fixture.keyRows.values()][0]).toMatchObject({
      room_code: CANARY_CODE,
      room_generation: 1,
    });

    const decommissioned = await appWorker.fetch(
      canaryMutation('decommission', {
        confirmRoomCode: CANARY_CODE,
        requestId: REQUEST_ID,
        roomGeneration: 1,
      }),
      fixture.env,
    );
    expect(decommissioned.status).toBe(202);
    expect(await decommissioned.json()).toMatchObject({
      roomCode: CANARY_CODE,
      roomGeneration: 1,
      status: 'decommissioning',
    });
    expectCanaryHeaders(decommissioned);
    expect(fixture.registryRows.get(CANARY_CODE)?.status).toBe('decommissioning');
    expect(fixture.proAudits).toEqual(
      expect.arrayContaining([
        {
          action: 'room.register',
          result: 'recreated',
          roomCode: CANARY_CODE,
          roomGeneration: 1,
        },
        {
          action: 'activation_claim.issue',
          result: 'issued',
          roomCode: CANARY_CODE,
          roomGeneration: 1,
        },
        {
          action: 'room.delete',
          result: 'authorized',
          roomCode: CANARY_CODE,
          roomGeneration: 1,
        },
      ]),
    );
    expect(fixture.developerAudits).toContainEqual({ action: 'key.issue', roomGeneration: 1 });
    expect(fixture.durableObjectCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectName: `${CANARY_CODE}:generation:1`,
          roomGeneration: '1',
        }),
      ]),
    );
  });

  it('rejects unrecognized caller-controlled fields before delegation', async () => {
    const fixture = createGenerationCanaryEnv();
    const attempts = [
      canaryMutation('register', { roomGeneration: 1, roomCode: '000001' }),
      canaryMutation('activation-claim', { roomGeneration: 1, extra: true }),
      canaryMutation('api-key', {
        requestId: REQUEST_ID,
        roomGeneration: 1,
        scopes: ['playback:control'],
      }),
      canaryMutation('decommission', {
        confirmRoomCode: '000001',
        requestId: REQUEST_ID,
        roomGeneration: 1,
      }),
    ];
    for (const request of attempts) {
      const response = await appWorker.fetch(request, fixture.env);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'INVALID_REQUEST' });
      expectCanaryHeaders(response);
    }
    expect(fixture.durableObjectCalls).toHaveLength(0);
  });

  it('computes the next immutable generation beyond the first reuse', async () => {
    const fixture = createGenerationCanaryEnv(1);
    const status = await appWorker.fetch(
      new Request(`${CANARY_BASE}/status`, { headers: canaryHeaders() }),
      fixture.env,
    );
    expect(await status.json()).toMatchObject({
      roomGeneration: 1,
      registerRoomGeneration: 2,
    });

    const registered = await appWorker.fetch(
      canaryMutation('register', { roomGeneration: 2 }),
      fixture.env,
    );
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({
      room: { roomCode: CANARY_CODE, roomGeneration: 2 },
    });
    expect(fixture.durableObjectCalls).toContainEqual(
      expect.objectContaining({
        objectName: `${CANARY_CODE}:generation:2`,
        roomGeneration: '2',
      }),
    );
  });
});

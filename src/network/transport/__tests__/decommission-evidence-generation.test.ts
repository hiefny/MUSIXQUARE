import { describe, expect, it, vi } from 'vitest';
import { DeveloperApiRateLimiter } from '../../../../cloudflare/developer-api-worker.js';
import signalingWorker, { MusixquareRoom } from '../../../../cloudflare/signaling-worker.js';

const CANARY_ROOM_CODE = '099999';
const LEGACY_ROOM_CODE = '000002';
const LEGACY_REQUEST_ID = '3756542c-9112-48ac-a672-7de17a71adb5';
const REQUEST_ID = '5756542c-9112-48ac-a672-7de17a71adb5';
const VERIFY_SECRET = 'decommission-evidence-test-secret-at-least-32-bytes';
const DECOMMISSIONED_AT_MS = Date.parse('2026-07-24T03:37:43.243Z');
const EVIDENCE_PATH = '/internal/ops/v1/decommission-evidence';

class EvidenceStorage {
  readonly data: Map<string, unknown>;
  readonly mutationCalls: string[] = [];

  constructor(
    entries: Record<string, unknown>,
    readonly alarmAtMs: number | null = null,
  ) {
    this.data = new Map(Object.entries(entries));
  }

  async get(key: string): Promise<unknown> {
    return structuredClone(this.data.get(key));
  }

  async list(): Promise<Map<string, unknown>> {
    return new Map([...this.data.entries()].map(([key, value]) => [key, structuredClone(value)]));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAtMs;
  }

  async put(): Promise<never> {
    this.mutationCalls.push('put');
    throw new Error('read-only evidence attempted put');
  }

  async delete(): Promise<never> {
    this.mutationCalls.push('delete');
    throw new Error('read-only evidence attempted delete');
  }

  async deleteAll(): Promise<never> {
    this.mutationCalls.push('deleteAll');
    throw new Error('read-only evidence attempted deleteAll');
  }

  async setAlarm(): Promise<never> {
    this.mutationCalls.push('setAlarm');
    throw new Error('read-only evidence attempted setAlarm');
  }

  async deleteAlarm(): Promise<never> {
    this.mutationCalls.push('deleteAlarm');
    throw new Error('read-only evidence attempted deleteAlarm');
  }
}

function generationFields(roomGeneration: number): Record<string, number> {
  return { roomGeneration };
}

function tombstone(
  roomCode: string,
  roomGeneration: number,
  requestId: string,
): Record<string, unknown> {
  return {
    v: 1,
    roomCode,
    ...generationFields(roomGeneration),
    requestId,
    decommissionedAtMs: DECOMMISSIONED_AT_MS,
  };
}

function evidenceRequest(roomCode: string, roomGeneration: number): Request {
  return new Request(`https://evidence.internal${EVIDENCE_PATH}`, {
    method: 'GET',
    headers: {
      'x-mxqr-pro-room-code': roomCode,
      'x-mxqr-pro-room-generation': String(roomGeneration),
    },
  });
}

function namespace(fetch: (request: Request) => Promise<Response>) {
  const stub = { fetch: vi.fn(fetch) };
  return {
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn(() => stub),
    stub,
  };
}

function adminDatabase(options: {
  roomCode: string;
  roomGeneration: number;
  registryGeneration?: number;
  historyRequestId?: string | null;
  latestAuthorizedDeleteAtMs?: number;
}) {
  const registryGeneration = options.registryGeneration ?? options.roomGeneration;
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (sql.includes('mxqr_pro_room_registry')) {
            return {
              room_code: options.roomCode,
              room_generation: registryGeneration,
              status: 'decommissioned',
              activation_state: 'unactivated',
              created_at: DECOMMISSIONED_AT_MS - 10_000,
              updated_at: DECOMMISSIONED_AT_MS + 1_000,
            };
          }
          if (sql.includes('mxqr_pro_room_generation_history')) {
            return {
              room_code: options.roomCode,
              room_generation: options.roomGeneration,
              status: 'decommissioned',
              decommissioned_at: DECOMMISSIONED_AT_MS,
              request_id: options.historyRequestId ?? null,
            };
          }
          if (sql.includes('mxqr_pro_room_generation_allocations')) {
            return {
              room_code: options.roomCode,
              room_generation: options.roomGeneration,
              allocated_at: DECOMMISSIONED_AT_MS - 20_000,
            };
          }
          if (sql.includes('mxqr_pro_room_admin_audit')) {
            return {
              count: 1,
              latest_authorized_at:
                options.latestAuthorizedDeleteAtMs ?? DECOMMISSIONED_AT_MS - 1_000,
            };
          }
          throw new Error(`unexpected admin query: ${sql}`);
        }),
      })),
    })),
  };
}

function developerDatabase(options: {
  roomCode: string;
  roomGeneration: number;
  requestId: string;
  counts?: number;
}) {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (sql.includes('mxqr_developer_api_room_generation_tombstones')) {
            return {
              room_code: options.roomCode,
              room_generation: options.roomGeneration,
              request_id: options.requestId,
              decommissioned_at: DECOMMISSIONED_AT_MS,
            };
          }
          if (sql.includes('mxqr_developer_api_room_tombstones')) {
            return {
              room_code: options.roomCode,
              request_id: options.requestId,
              decommissioned_at: DECOMMISSIONED_AT_MS,
            };
          }
          if (
            sql.includes('mxqr_developer_api_keys') ||
            sql.includes('mxqr_developer_api_audit') ||
            sql.includes('mxqr_developer_api_admin_audit')
          ) {
            return { count: options.counts ?? 0 };
          }
          throw new Error(`unexpected developer query: ${sql}`);
        }),
      })),
    })),
  };
}

function createEvidenceEnvironment(
  options: {
    roomCode?: string;
    roomGeneration?: number;
    registryGeneration?: number;
    requestId?: string;
    historyRequestId?: string | null;
    limiterRequestId?: string;
    r2Objects?: { key: string }[];
    secret?: string;
    developerCounts?: number;
    latestAuthorizedDeleteAtMs?: number;
  } = {},
) {
  const roomCode = options.roomCode ?? CANARY_ROOM_CODE;
  const roomGeneration = options.roomGeneration ?? 7;
  const requestId = options.requestId ?? REQUEST_ID;
  const signalingStorage = new EvidenceStorage({
    proRoomDecommissioned: tombstone(roomCode, roomGeneration, requestId),
  });
  const signalingRoom = new MusixquareRoom(
    {
      storage: signalingStorage,
      getWebSockets: vi.fn(() => []),
    } as never,
    { CF_VERSION_METADATA: { id: 'signaling-observer-version' } },
  );
  const limiterStorage = new EvidenceStorage({
    decommissioned: tombstone(roomCode, roomGeneration, options.limiterRequestId ?? requestId),
  });
  const limiter = new DeveloperApiRateLimiter({ storage: limiterStorage } as never, {
    CF_VERSION_METADATA: { id: 'developer-api-observer-version' },
  });
  const proRooms = namespace(async (request) =>
    request.headers.get('x-mxqr-pro-room-code') === roomCode &&
    request.headers.get('x-mxqr-pro-room-generation') === String(roomGeneration)
      ? Response.json({
          roomCode,
          roomGeneration,
          provisioned: false,
          status: 'decommissioned',
          ownerAccountLinked: false,
        })
      : Response.json({ error: 'ROOM_NOT_FOUND' }, { status: 404 }),
  );
  const signalingRooms = namespace((request) => signalingRoom.fetch(request));
  const limiters = namespace((request) => limiter.fetch(request));
  const bucket = {
    list: vi.fn(async () => ({ objects: options.r2Objects ?? [] })),
  };
  return {
    env: {
      CF_VERSION_METADATA: { id: 'signaling-observer-version' },
      PRO_ROOM_DECOMMISSION_VERIFY_SECRET: options.secret ?? VERIFY_SECRET,
      PRO_ROOM_AUTHORITY_ROOMS: proRooms,
      MUSIXQUARE_ROOMS: signalingRooms,
      DEVELOPER_API_LIMITERS: limiters,
      MUSIXQUARE_ADMIN_DB: adminDatabase({
        roomCode,
        roomGeneration,
        registryGeneration: options.registryGeneration,
        historyRequestId: options.historyRequestId,
        latestAuthorizedDeleteAtMs: options.latestAuthorizedDeleteAtMs,
      }),
      DEVELOPER_API_DB: developerDatabase({
        roomCode,
        roomGeneration,
        requestId,
        counts: options.developerCounts,
      }),
      PRO_MEDIA_BUCKET: bucket,
    },
    proRooms,
    signalingRooms,
    limiters,
    bucket,
    signalingStorage,
    limiterStorage,
  };
}

describe('generation-aware read-only PRO room decommission evidence', () => {
  it('reads an exact Developer API limiter generation without invoking mutation APIs', async () => {
    const storage = new EvidenceStorage({
      decommissioned: tombstone(CANARY_ROOM_CODE, 7, REQUEST_ID),
    });
    const limiter = new DeveloperApiRateLimiter({ storage } as never, {
      CF_VERSION_METADATA: { id: 'developer-api-observer-version' },
    });

    const response = await limiter.fetch(evidenceRequest(CANARY_ROOM_CODE, 7));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      observerContract: 2,
      component: 'developer-api-rate-limiter',
      workerVersionId: 'developer-api-observer-version',
      roomCode: CANARY_ROOM_CODE,
      roomGeneration: 7,
      roomInstanceId: `${CANARY_ROOM_CODE}:generation:7`,
      durableObjectName: `room:${CANARY_ROOM_CODE}:generation:7`,
      tombstone: {
        roomCode: CANARY_ROOM_CODE,
        roomGeneration: 7,
        requestId: REQUEST_ID,
      },
      remainingKeys: ['decommissioned'],
      alarmAtMs: null,
      storageReadable: true,
      clean: true,
    });
    expect(storage.mutationCalls).toEqual([]);
  });

  it('reads an exact signaling generation without invoking mutation APIs', async () => {
    const storage = new EvidenceStorage({
      proRoomDecommissioned: tombstone(CANARY_ROOM_CODE, 7, REQUEST_ID),
    });
    const getWebSockets = vi.fn(() => []);
    const room = new MusixquareRoom({ storage, getWebSockets } as never, {
      CF_VERSION_METADATA: { id: 'signaling-observer-version' },
    });

    const response = await room.fetch(evidenceRequest(CANARY_ROOM_CODE, 7));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      observerContract: 2,
      component: 'signaling-room',
      workerVersionId: 'signaling-observer-version',
      roomCode: CANARY_ROOM_CODE,
      roomGeneration: 7,
      roomInstanceId: `${CANARY_ROOM_CODE}:generation:7`,
      durableObjectName: `${CANARY_ROOM_CODE}:generation:7`,
      tombstone: {
        roomCode: CANARY_ROOM_CODE,
        roomGeneration: 7,
        requestId: REQUEST_ID,
      },
      remainingKeys: ['proRoomDecommissioned'],
      alarmAtMs: null,
      activeSocketCount: 0,
      storageReadable: true,
      clean: true,
    });
    expect(getWebSockets).toHaveBeenCalled();
    expect(storage.mutationCalls).toEqual([]);
  });

  it('binds the canary to its current registry generation, request, DOs, D1 rows, and R2 prefix', async () => {
    const context = createEvidenceEnvironment({ historyRequestId: REQUEST_ID });
    const response = await signalingWorker.fetch(
      new Request(
        `https://signal.musixquare.com/internal/ops/v1/decommission-evidence/${CANARY_ROOM_CODE}`,
        { headers: { authorization: `Bearer ${VERIFY_SECRET}` } },
      ),
      context.env,
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(payload).toMatchObject({
      observerContract: 2,
      service: 'musixquare-decommission-evidence',
      workerVersionId: 'signaling-observer-version',
      roomCode: CANARY_ROOM_CODE,
      roomGeneration: 7,
      roomInstanceId: `${CANARY_ROOM_CODE}:generation:7`,
      expectedRequestId: REQUEST_ID,
      identity: {
        durableObjectName: `${CANARY_ROOM_CODE}:generation:7`,
        limiterIdentity: `room:${CANARY_ROOM_CODE}:generation:7`,
        r2Prefix: `pro-room-incarnations/${CANARY_ROOM_CODE}/generation-7/`,
      },
      observedVersions: {
        signaling: 'signaling-observer-version',
        signalingRoom: 'signaling-observer-version',
        developerApiRateLimiter: 'developer-api-observer-version',
      },
      verified: true,
      checks: {
        identity: true,
        observerVersion: true,
        proRoom: true,
        signaling: true,
        developerRateLimiter: true,
        registry: true,
        developerDatabase: true,
        r2: true,
      },
    });
    expect(context.proRooms.idFromName).toHaveBeenCalledWith(`${CANARY_ROOM_CODE}:generation:7`);
    expect(context.signalingRooms.idFromName).toHaveBeenCalledWith(
      `${CANARY_ROOM_CODE}:generation:7`,
    );
    expect(context.limiters.idFromName).toHaveBeenCalledWith(
      `room:${CANARY_ROOM_CODE}:generation:7`,
    );
    expect(context.bucket.list).toHaveBeenCalledWith({
      prefix: `pro-room-incarnations/${CANARY_ROOM_CODE}/generation-7/`,
      limit: 1,
    });
    expect(context.signalingStorage.mutationCalls).toEqual([]);
    expect(context.limiterStorage.mutationCalls).toEqual([]);
  });

  it('uses the canonical generation-aware evidence path for generation zero', async () => {
    const context = createEvidenceEnvironment({
      roomCode: LEGACY_ROOM_CODE,
      roomGeneration: 0,
      requestId: LEGACY_REQUEST_ID,
      historyRequestId: LEGACY_REQUEST_ID,
    });
    const response = await signalingWorker.fetch(
      new Request(
        `https://signal.musixquare.com/internal/ops/v1/decommission-evidence/${LEGACY_ROOM_CODE}`,
        { headers: { authorization: `Bearer ${VERIFY_SECRET}` } },
      ),
      context.env,
    );
    const payload = (await response.json()) as {
      roomGeneration: number;
      expectedRequestId: string;
      verified: boolean;
    };

    expect(response.status).toBe(200);
    expect(payload.roomGeneration).toBe(0);
    expect(payload.expectedRequestId).toBe(LEGACY_REQUEST_ID);
    expect(payload.verified).toBe(true);
    expect(context.proRooms.idFromName).toHaveBeenCalledWith(`${LEGACY_ROOM_CODE}:generation:0`);
    expect(context.signalingRooms.idFromName).toHaveBeenCalledWith(
      `${LEGACY_ROOM_CODE}:generation:0`,
    );
    expect(context.limiters.idFromName).toHaveBeenCalledWith(
      `room:${LEGACY_ROOM_CODE}:generation:0`,
    );
    expect(context.bucket.list).toHaveBeenCalledWith({
      prefix: `pro-room-incarnations/${LEGACY_ROOM_CODE}/generation-0/`,
      limit: 1,
    });
  });

  it('fails closed on residue, generation-specific rows, or request-id mismatch', async () => {
    const context = createEvidenceEnvironment({
      historyRequestId: REQUEST_ID,
      limiterRequestId: '4756542c-9112-48ac-a672-7de17a71adb5',
      r2Objects: [{ key: `pro-room-incarnations/${CANARY_ROOM_CODE}/generation-7/late-upload` }],
      developerCounts: 1,
    });
    const response = await signalingWorker.fetch(
      new Request(
        `https://signal.musixquare.com/internal/ops/v1/decommission-evidence/${CANARY_ROOM_CODE}`,
        { headers: { authorization: `Bearer ${VERIFY_SECRET}` } },
      ),
      context.env,
    );
    const payload = (await response.json()) as {
      verified: boolean;
      checks: Record<string, boolean>;
    };

    expect(payload.verified).toBe(false);
    expect(payload.checks.developerRateLimiter).toBe(false);
    expect(payload.checks.developerDatabase).toBe(false);
    expect(payload.checks.r2).toBe(false);
    expect(context.signalingStorage.mutationCalls).toEqual([]);
    expect(context.limiterStorage.mutationCalls).toEqual([]);
  });

  it('follows the current registry generation and fails closed on stale evidence', async () => {
    const context = createEvidenceEnvironment({
      roomCode: LEGACY_ROOM_CODE,
      roomGeneration: 0,
      registryGeneration: 1,
      requestId: LEGACY_REQUEST_ID,
      historyRequestId: null,
    });
    const response = await signalingWorker.fetch(
      new Request(
        `https://signal.musixquare.com/internal/ops/v1/decommission-evidence/${LEGACY_ROOM_CODE}`,
        { headers: { authorization: `Bearer ${VERIFY_SECRET}` } },
      ),
      context.env,
    );
    const payload = (await response.json()) as {
      roomGeneration: number;
      verified: boolean;
      checks: Record<string, boolean>;
    };

    expect(payload.roomGeneration).toBe(1);
    expect(payload.verified).toBe(false);
    expect(payload.checks.identity).toBe(true);
    expect(context.proRooms.idFromName).toHaveBeenCalledWith(`${LEGACY_ROOM_CODE}:generation:1`);
  });

  it('requires an authorized delete audit before immutable completion', async () => {
    const context = createEvidenceEnvironment({
      historyRequestId: REQUEST_ID,
      latestAuthorizedDeleteAtMs: DECOMMISSIONED_AT_MS + 1,
    });
    const response = await signalingWorker.fetch(
      new Request(
        `https://signal.musixquare.com/internal/ops/v1/decommission-evidence/${CANARY_ROOM_CODE}`,
        { headers: { authorization: `Bearer ${VERIFY_SECRET}` } },
      ),
      context.env,
    );
    const payload = (await response.json()) as {
      verified: boolean;
      checks: Record<string, boolean>;
    };

    expect(payload.verified).toBe(false);
    expect(payload.checks.registry).toBe(false);
  });

  it('hides the observer for bad auth, unknown rooms, query strings, and non-GET methods', async () => {
    const context = createEvidenceEnvironment({ historyRequestId: REQUEST_ID });
    const cases = [
      new Request(
        `https://signal.musixquare.com/internal/ops/v1/decommission-evidence/${CANARY_ROOM_CODE}`,
        { headers: { authorization: 'Bearer wrong-secret' } },
      ),
      new Request('https://signal.musixquare.com/internal/ops/v1/decommission-evidence/000004', {
        headers: { authorization: `Bearer ${VERIFY_SECRET}` },
      }),
      new Request(
        `https://signal.musixquare.com/internal/ops/v1/decommission-evidence/${CANARY_ROOM_CODE}?probe=1`,
        { headers: { authorization: `Bearer ${VERIFY_SECRET}` } },
      ),
      new Request(
        `https://signal.musixquare.com/internal/ops/v1/decommission-evidence/${CANARY_ROOM_CODE}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${VERIFY_SECRET}`,
            'content-type': 'application/json',
          },
          body: '{}',
        },
      ),
    ];

    for (const request of cases) {
      const response = await signalingWorker.fetch(request, context.env);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'NOT_FOUND' });
    }
    expect(context.proRooms.stub.fetch).not.toHaveBeenCalled();
    expect(context.signalingRooms.stub.fetch).not.toHaveBeenCalled();
    expect(context.limiters.stub.fetch).not.toHaveBeenCalled();
  });
});

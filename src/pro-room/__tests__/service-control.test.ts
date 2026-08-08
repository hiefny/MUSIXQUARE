import { describe, expect, it } from 'vitest';
import { MusixquareServiceControl } from '../../../cloudflare/pro-room-worker.js';
import {
  ADMIN_ANNOUNCEMENT_STATE_PATH,
  ADMIN_ANNOUNCEMENT_STATUS_PATH,
} from '../../../cloudflare/service-maintenance.js';

class ServiceControlStorage {
  readonly data = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return structuredClone(this.data.get(key));
  }

  async put(entries: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      this.data.set(key, structuredClone(value));
    }
  }
}

function setup(storage = new ServiceControlStorage()): {
  control: MusixquareServiceControl;
  storage: ServiceControlStorage;
} {
  const state = {
    storage,
    blockConcurrencyWhile: async (callback: () => Promise<void>): Promise<void> => callback(),
  };
  return { control: new MusixquareServiceControl(state), storage };
}

function stateRequest(enabled: boolean, expectedRevision: number, requestId: string): Request {
  return new Request('https://service-control.internal/internal/service-maintenance/v1/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, expectedRevision, requestId }),
  });
}

function announcementRequest(
  message: string,
  expectedRevision: number,
  requestId: string,
  baseHistory: Array<Record<string, unknown>> = [],
): Request {
  return new Request(`https://service-control.internal${ADMIN_ANNOUNCEMENT_STATE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      enabled: true,
      expiresAt: null,
      expectedRevision,
      requestId,
      baseHistory,
    }),
  });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('MusixquareServiceControl', () => {
  it('starts operational and persists one strongly ordered maintenance transition', async () => {
    const { control, storage } = setup();
    const initial = await control.fetch(
      new Request('https://service-control.internal/internal/service-maintenance/v1/status'),
    );
    expect(await payload(initial)).toEqual({
      serviceStatus: {
        enabled: false,
        revision: 0,
        updatedAt: null,
        activatedAt: null,
        settlesAt: null,
      },
    });

    const enabled = await control.fetch(
      stateRequest(true, 0, '123e4567-e89b-42d3-a456-426614174000'),
    );
    expect(enabled.status).toBe(200);
    const enabledPayload = await payload(enabled);
    expect(enabledPayload).toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
      serviceStatus: { enabled: true, revision: 1 },
    });
    const status = enabledPayload.serviceStatus as Record<string, unknown>;
    expect(status.activatedAt).toBe(status.updatedAt);
    expect(status.settlesAt).toBe(Number(status.updatedAt) + 2_000);

    const rehydrated = setup(storage).control;
    const restored = await rehydrated.fetch(
      new Request('https://service-control.internal/internal/service-maintenance/v1/status'),
    );
    expect(await payload(restored)).toEqual({ serviceStatus: status });
  });

  it('accepts the same request idempotently despite its now-stale expected revision', async () => {
    const { control } = setup();
    const requestId = '123e4567-e89b-42d3-a456-426614174001';
    await control.fetch(stateRequest(true, 0, requestId));
    const replay = await control.fetch(stateRequest(true, 0, requestId));
    expect(replay.status).toBe(200);
    expect(await payload(replay)).toMatchObject({
      ok: true,
      changed: false,
      replayed: true,
      serviceStatus: { enabled: true, revision: 1 },
    });
  });

  it('returns current state for conflicts and never replays a superseded snapshot', async () => {
    const { control } = setup();
    const enableId = '123e4567-e89b-42d3-a456-426614174002';
    await control.fetch(stateRequest(true, 0, enableId));
    await control.fetch(stateRequest(false, 1, '123e4567-e89b-42d3-a456-426614174003'));

    const oldReplay = await control.fetch(stateRequest(true, 0, enableId));
    expect(oldReplay.status).toBe(409);
    expect(await payload(oldReplay)).toMatchObject({
      error: 'SERVICE_MAINTENANCE_REQUEST_SUPERSEDED',
      serviceStatus: { enabled: false, revision: 2 },
    });

    const stale = await control.fetch(
      stateRequest(true, 1, '123e4567-e89b-42d3-a456-426614174004'),
    );
    expect(stale.status).toBe(409);
    expect(await payload(stale)).toMatchObject({
      error: 'SERVICE_MAINTENANCE_REVISION_CONFLICT',
      serviceStatus: { enabled: false, revision: 2 },
    });
  });

  it('serializes concurrent compare-and-set mutations', async () => {
    const { control } = setup();
    const responses = await Promise.all([
      control.fetch(stateRequest(true, 0, '123e4567-e89b-42d3-a456-426614174005')),
      control.fetch(stateRequest(true, 0, '123e4567-e89b-42d3-a456-426614174006')),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it('stores announcement current state and history atomically with fenced idempotent writes', async () => {
    const { control, storage } = setup();
    const initial = await control.fetch(
      new Request(`https://service-control.internal${ADMIN_ANNOUNCEMENT_STATUS_PATH}`),
    );
    expect(await payload(initial)).toEqual({
      announcementState: {
        revision: 0,
        announcement: {
          id: '',
          message: '',
          enabled: false,
          expiresAt: null,
          updatedAt: '',
        },
        history: [],
      },
    });

    const legacy = {
      id: 'legacy-current',
      message: 'Legacy current notice',
      enabled: true,
      expiresAt: null,
      updatedAt: '2026-08-01T00:00:00.000Z',
      action: 'published',
    };
    const requestId = '123e4567-e89b-42d3-a456-426614174010';
    const saved = await control.fetch(
      announcementRequest('Strongly ordered notice', 0, requestId, [legacy]),
    );
    expect(saved.status).toBe(200);
    const savedPayload = await payload(saved);
    expect(savedPayload).toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
      announcementState: {
        revision: 1,
        announcement: { message: 'Strongly ordered notice', enabled: true },
        history: [{ message: 'Strongly ordered notice', action: 'published' }, legacy],
      },
    });

    const replay = await control.fetch(
      announcementRequest('Strongly ordered notice', 0, requestId, [legacy]),
    );
    expect(replay.status).toBe(200);
    expect(await payload(replay)).toMatchObject({
      ok: true,
      changed: false,
      replayed: true,
      announcementState: { revision: 1 },
    });

    const raced = await Promise.all([
      control.fetch(announcementRequest('Concurrent A', 1, '123e4567-e89b-42d3-a456-426614174011')),
      control.fetch(announcementRequest('Concurrent B', 1, '123e4567-e89b-42d3-a456-426614174012')),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);

    const restored = setup(storage).control;
    const current = await restored.fetch(
      new Request(`https://service-control.internal${ADMIN_ANNOUNCEMENT_STATUS_PATH}`),
    );
    const currentPayload = await payload(current);
    expect(currentPayload).toMatchObject({
      announcementState: {
        revision: 2,
        history: [{}, { message: 'Strongly ordered notice' }, legacy],
      },
    });
    const state = currentPayload.announcementState as Record<string, unknown>;
    const history = state.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(3);
    expect(history[0].message).toMatch(/^Concurrent [AB]$/);
  });

  it('accepts a maximum legacy history migration larger than the old 128 KiB cap', async () => {
    const { control } = setup();
    const baseHistory = Array.from({ length: 100 }, (_, index) => ({
      id: `legacy-${index}`,
      message: '\u0000'.repeat(280),
      enabled: true,
      expiresAt: null,
      updatedAt: '2026-08-08T00:00:00.000Z',
      action: 'published',
    }));
    const request = announcementRequest(
      'Migrated maximum history',
      0,
      '123e4567-e89b-42d3-a456-426614174099',
      baseHistory,
    );
    expect(new TextEncoder().encode(await request.clone().text()).byteLength).toBeGreaterThan(
      128 * 1024,
    );

    const response = await control.fetch(request);

    expect(response.status).toBe(200);
    const result = await payload(response);
    expect(result).toMatchObject({
      announcementState: {
        revision: 1,
        announcement: { message: 'Migrated maximum history' },
      },
    });
    const state = result.announcementState as Record<string, unknown>;
    expect(state.history).toHaveLength(100);
  });

  it('canonicalizes long parseable legacy timestamps before storing the response', async () => {
    const { control } = setup();
    const longUpdatedAt = `${' '.repeat(2500)}August 8, 2026`;
    const canonicalUpdatedAt = new Date(longUpdatedAt).toISOString();
    const baseHistory = Array.from({ length: 99 }, (_, index) => ({
      id: `legacy-long-date-${index}`,
      message: 'Legacy notice',
      enabled: false,
      expiresAt: null,
      updatedAt: longUpdatedAt,
      action: 'disabled',
    }));
    const request = announcementRequest(
      'Canonical timestamp migration',
      0,
      '123e4567-e89b-42d3-a456-426614174098',
      baseHistory,
    );
    const requestBytes = new TextEncoder().encode(await request.clone().text()).byteLength;
    expect(requestBytes).toBeGreaterThan(240 * 1024);
    expect(requestBytes).toBeLessThan(256 * 1024);

    const response = await control.fetch(request);
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(new TextEncoder().encode(responseText).byteLength).toBeLessThan(256 * 1024);
    const result = JSON.parse(responseText) as Record<string, unknown>;
    const state = result.announcementState as Record<string, unknown>;
    const history = state.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(100);
    expect(history[1].updatedAt).toBe(canonicalUpdatedAt);
  });

  it('isolates corrupt announcement storage from the global maintenance gate', async () => {
    const storage = new ServiceControlStorage();
    storage.data.set('admin-announcement-state', { revision: -1 });
    const { control } = setup(storage);
    const maintenance = await control.fetch(
      new Request('https://service-control.internal/internal/service-maintenance/v1/status'),
    );
    expect(maintenance.status).toBe(200);
    await expect(payload(maintenance)).resolves.toMatchObject({
      serviceStatus: { enabled: false, revision: 0 },
    });

    const announcement = await control.fetch(
      new Request(`https://service-control.internal${ADMIN_ANNOUNCEMENT_STATUS_PATH}`),
    );
    expect(announcement.status).toBe(503);
    await expect(payload(announcement)).resolves.toEqual({
      error: 'ADMIN_ANNOUNCEMENT_STATE_INVALID',
    });
  });

  it('rejects a stored current announcement that differs from its same-id history head', async () => {
    const storage = new ServiceControlStorage();
    const updatedAt = '2026-08-08T00:00:00.000Z';
    storage.data.set('admin-announcement-state', {
      revision: 1,
      announcement: {
        id: 'same-announcement',
        message: 'Current message',
        enabled: true,
        expiresAt: null,
        updatedAt,
      },
      history: [
        {
          id: 'same-announcement',
          message: 'Different history message',
          enabled: false,
          expiresAt: null,
          updatedAt,
          action: 'disabled',
        },
      ],
    });
    const { control } = setup(storage);

    const maintenance = await control.fetch(
      new Request('https://service-control.internal/internal/service-maintenance/v1/status'),
    );
    expect(maintenance.status).toBe(200);
    await expect(payload(maintenance)).resolves.toMatchObject({
      serviceStatus: { enabled: false, revision: 0 },
    });

    const announcement = await control.fetch(
      new Request(`https://service-control.internal${ADMIN_ANNOUNCEMENT_STATUS_PATH}`),
    );
    expect(announcement.status).toBe(503);
    await expect(payload(announcement)).resolves.toEqual({
      error: 'ADMIN_ANNOUNCEMENT_STATE_INVALID',
    });
  });

  it('rejects a stored older history row whose action contradicts its contents', async () => {
    const storage = new ServiceControlStorage();
    const current = {
      id: 'current-announcement',
      message: 'Current message',
      enabled: true,
      expiresAt: null,
      updatedAt: '2026-08-08T00:00:00.000Z',
    };
    storage.data.set('admin-announcement-state', {
      revision: 2,
      announcement: current,
      history: [
        { ...current, action: 'published' },
        {
          id: 'older-announcement',
          message: '',
          enabled: false,
          expiresAt: null,
          updatedAt: '2026-08-07T00:00:00.000Z',
          action: 'published',
        },
      ],
    });
    const { control } = setup(storage);

    const maintenance = await control.fetch(
      new Request('https://service-control.internal/internal/service-maintenance/v1/status'),
    );
    expect(maintenance.status).toBe(200);
    const announcement = await control.fetch(
      new Request(`https://service-control.internal${ADMIN_ANNOUNCEMENT_STATUS_PATH}`),
    );
    expect(announcement.status).toBe(503);
    await expect(payload(announcement)).resolves.toEqual({
      error: 'ADMIN_ANNOUNCEMENT_STATE_INVALID',
    });
  });

  it('rejects a revision-zero sentinel that carries a latent expiry', async () => {
    const storage = new ServiceControlStorage();
    storage.data.set('admin-announcement-state', {
      revision: 0,
      announcement: {
        id: '',
        message: '',
        enabled: false,
        expiresAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '',
      },
      history: [],
    });
    const { control } = setup(storage);

    const maintenance = await control.fetch(
      new Request('https://service-control.internal/internal/service-maintenance/v1/status'),
    );
    expect(maintenance.status).toBe(200);
    const announcement = await control.fetch(
      new Request(`https://service-control.internal${ADMIN_ANNOUNCEMENT_STATUS_PATH}`),
    );
    expect(announcement.status).toBe(503);
    await expect(payload(announcement)).resolves.toEqual({
      error: 'ADMIN_ANNOUNCEMENT_STATE_INVALID',
    });
  });
});

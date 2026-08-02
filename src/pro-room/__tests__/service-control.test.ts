import { describe, expect, it } from 'vitest';
import { MusixquareServiceControl } from '../../../cloudflare/pro-room-worker.js';

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
});

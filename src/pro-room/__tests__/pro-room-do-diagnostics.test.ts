import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import proRoomWorker, { MusixquareProRoom } from '../../../cloudflare/pro-room-worker.ts';
import {
  clearServiceMaintenanceCacheForTests,
  SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER,
  SERVICE_CONTROL_STATUS_ENABLED_HEADER,
  SERVICE_CONTROL_STATUS_REVISION_HEADER,
  SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER,
  SERVICE_CONTROL_STATUS_VERSION_HEADER,
} from '../../../cloudflare/service-maintenance.ts';

const VERSION_ID = '440b001f-acde-4321-9876-abcdefabcdef';
const ROOM = '000000';
let sequence = 0;
let log = vi.fn<(...args: unknown[]) => void>();

class MemoryStorage {
  readonly data = new Map<string, unknown>();
  failNextWrite = false;
  async get(key: string | string[]) {
    return Array.isArray(key)
      ? new Map(key.map((item) => [item, structuredClone(this.data.get(item))]))
      : structuredClone(this.data.get(key));
  }
  async put(key: string | Record<string, unknown>, value?: unknown) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('private-storage-failure');
    }
    if (typeof key === 'string') this.data.set(key, structuredClone(value));
    else
      for (const [name, entry] of Object.entries(key)) this.data.set(name, structuredClone(entry));
  }
  async delete(key: string | string[]) {
    if (typeof key === 'string') return this.data.delete(key);
    return key.reduce((count, name) => count + Number(this.data.delete(name)), 0);
  }
  async transaction<T>(callback: (storage: MemoryStorage) => Promise<T>) {
    const prior = structuredClone(this.data);
    try {
      return await callback(this);
    } catch (error) {
      this.data.clear();
      for (const [key, value] of prior) this.data.set(key, value);
      throw error;
    }
  }
  async setAlarm() {}
  async deleteAlarm() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  clearServiceMaintenanceCacheForTests();
  sequence = 0;
  log = vi.fn<(...args: unknown[]) => void>();
  vi.spyOn(console, 'log').mockImplementation(log);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function request(
  path: string,
  body?: unknown,
  cookie?: string,
  method = body === undefined ? 'GET' : 'POST',
) {
  return new Request(`https://pro-room.internal/v1/rooms/${ROOM}${path}`, {
    method,
    headers: {
      Origin: 'https://musixquare.com',
      'Content-Type': 'application/json',
      'x-mxqr-pro-room-code': ROOM,
      'x-mxqr-pro-room-generation': '0',
      'x-mxqr-pro-entry-policy': 'optional-v1',
      'x-mxqr-pro-ip-hash': 'private-ip-hash',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function fixture() {
  const storage = new MemoryStorage();
  const env = {
    PRO_ROOM_PIN_PEPPER: 'private-pin-pepper'.padEnd(48, 'x'),
    PRO_ROOM_SESSION_SECRET: 'private-session-secret'.padEnd(48, 'x'),
    PRO_SIGNALING_SECRET: 'private-signaling-secret'.padEnd(48, 'x'),
    CF_VERSION_METADATA: { id: VERSION_ID },
    MUSIXQUARE_SERVICE_CONTROL: undefined as unknown,
  };
  const worker = new MusixquareProRoom({ storage } as never, env);
  expect((await worker.fetch(request('/bootstrap'))).status).toBe(200);
  worker.room!.status = 'active';
  worker.room!.passwordRequired = false;
  await worker.persist();
  return { worker, storage, env };
}

function maintenanceControl(mode: 'maintenance' | 'unavailable') {
  const fetch = vi.fn(async (_request: Request) => {
    if (mode === 'unavailable') throw new Error('private-control-error https://private.example');
    return new Response(null, {
      headers: {
        [SERVICE_CONTROL_STATUS_VERSION_HEADER]: '1',
        [SERVICE_CONTROL_STATUS_ENABLED_HEADER]: '1',
        [SERVICE_CONTROL_STATUS_REVISION_HEADER]: '8',
        [SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER]: '1000000',
        [SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER]: '999000',
      },
    });
  });
  return { fetch, binding: { idFromName: (name: string) => name, get: () => ({ fetch }) } };
}

async function join(worker: MusixquareProRoom) {
  const requestId = `diagnostic-join-request-${++sequence}`;
  const response = await worker.fetch(request('/sessions', { requestId }));
  return { response, requestId, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

function records(kind: 'event' | 'summary') {
  return log.mock.calls
    .map(([entry]) => entry as Record<string, unknown>)
    .filter((entry) => entry.diagnostic === 'pro_room' && entry.kind === kind);
}

function expectPrivateDataAbsent() {
  expect(JSON.stringify(log.mock.calls)).not.toMatch(
    /private|participantId|sessionHash|presenceIncarnationId|https:\/\//,
  );
}

describe('PRO Durable Object admission diagnostics', () => {
  it('reports a front maintenance-control outage from the single existing lookup', async () => {
    const control = maintenanceControl('unavailable');
    const incoming = request('/sessions?token=private-query-token', { pin: 'private-pin' });
    incoming.headers.set('x-mxqr-pro-room-generation', '12345');
    const response = await proRoomWorker.fetch(incoming, {
      MUSIXQUARE_SERVICE_CONTROL: control.binding,
      CF_VERSION_METADATA: { id: VERSION_ID },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'SERVICE_MAINTENANCE_STATUS_UNAVAILABLE',
    });
    expect(records('event')).toEqual([
      expect.objectContaining({
        scope: 'front',
        event: 'maintenance_unavailable',
        operation: 'maintenance_gate',
        status: 503,
        roomCode: ROOM,
        roomGeneration: null,
        versionId: VERSION_ID,
      }),
    ]);
    expect(control.fetch).toHaveBeenCalledTimes(1);
    expect(control.fetch.mock.calls[0]?.[0].method).toBe('HEAD');
    expect(vi.getTimerCount()).toBe(0);
    expectPrivateDataAbsent();
  });

  it.each(['front', 'room'] as const)(
    'keeps intended maintenance silent in the %s gate and reuses the single lookup',
    async (scope) => {
      const control = maintenanceControl('maintenance');
      const env = { MUSIXQUARE_SERVICE_CONTROL: control.binding };
      const response =
        scope === 'front'
          ? await proRoomWorker.fetch(request('/sessions', {}), env)
          : await new MusixquareProRoom({ storage: new MemoryStorage() } as never, env).fetch(
              request('/sessions', {}),
            );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'SERVICE_MAINTENANCE' });
      expect(records('event')).toEqual([]);
      expect(control.fetch).toHaveBeenCalledTimes(1);
      expect(control.fetch.mock.calls[0]?.[0].method).toBe('HEAD');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([false, true])(
    'reports a room maintenance-control outage with initialized=%s and no extra lookup',
    async (initialized) => {
      const control = maintenanceControl('unavailable');
      const setup = initialized
        ? await fixture()
        : (() => {
            const env = {
              MUSIXQUARE_SERVICE_CONTROL: undefined as unknown,
              CF_VERSION_METADATA: { id: VERSION_ID },
            };
            return {
              worker: new MusixquareProRoom({ storage: new MemoryStorage() } as never, env),
              env,
            };
          })();
      setup.env.MUSIXQUARE_SERVICE_CONTROL = control.binding;
      const response = await setup.worker.fetch(request('/sessions', { pin: 'private-pin' }));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: 'SERVICE_MAINTENANCE_STATUS_UNAVAILABLE',
      });
      expect(records('event')).toEqual([
        expect.objectContaining({
          scope: 'room',
          event: 'maintenance_unavailable',
          operation: 'maintenance_gate',
          status: 503,
          roomCode: initialized ? ROOM : null,
          roomGeneration: initialized ? 0 : null,
          versionId: VERSION_ID,
        }),
      ]);
      expect(control.fetch).toHaveBeenCalledTimes(1);
      expect(control.fetch.mock.calls[0]?.[0].method).toBe('HEAD');
      expect(vi.getTimerCount()).toBe(0);
      if (!initialized) expect(setup.worker.room).toBeNull();
      expectPrivateDataAbsent();
    },
  );

  it('identifies a full rate ledger independently of a client exhausting its PIN attempts', async () => {
    const { worker } = await fixture();
    worker.room!.passwordRequired = true;
    for (let index = 0; index < 512; index += 1) {
      worker.room!.rateLimits[`pin-failure:private-other-client-${index}`] = {
        count: 1,
        resetAtMs: Date.now() + 60_000,
      };
    }
    const rejected = await worker.fetch(
      request('/sessions', {
        pin: '87654321',
        requestId: 'diagnostic-ledger-request-0001',
      }),
    );
    expect(rejected.status).toBe(429);
    await expect(rejected.json()).resolves.toEqual({ error: 'RATE_LIMITED' });
    expect(rejected.headers.get('retry-after')).toBe('60');
    expect(records('event')).toEqual([
      expect.objectContaining({
        event: 'rate_limited',
        reason: 'ledger_capacity',
        status: 429,
        livePresence: 0,
        storedSessions: 0,
        retryAfterSeconds: 60,
      }),
    ]);
    expect(worker.room!.rateLimits['pin-failure:private-ip-hash']).toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain('87654321');
    expectPrivateDataAbsent();
  });

  it('separates PIN and admission throttles through their HTTP rejection paths', async () => {
    const { worker } = await fixture();
    worker.room!.passwordRequired = true;
    worker.room!.rateLimits['pin-failure:private-ip-hash'] = {
      count: 10,
      resetAtMs: Date.now() + 3_600_000,
    };
    const pinRejected = await worker.fetch(
      request('/sessions', {
        pin: '87654321',
        requestId: 'diagnostic-pin-request-0001',
      }),
    );
    expect(pinRejected.status).toBe(429);
    worker.room!.passwordRequired = false;
    worker.sessionAdmissionEntries().set('private-ip-hash', {
      count: 200,
      resetAtMs: Date.now() + 600_000,
    });
    expect((await join(worker)).response.status).toBe(429);
    expect(
      records('event').map((entry) => [entry.event, entry.reason, entry.retryAfterSeconds]),
    ).toEqual([
      ['rate_limited', 'pin', 3600],
      ['rate_limited', 'admission', 600],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('87654321');
    expectPrivateDataAbsent();
  });

  it('reports the receipt-capacity reason without counting the rejected admission as a join', async () => {
    const { worker } = await fixture();
    expect((await join(worker)).response.status).toBe(200);
    const [receiptKey, receipt] = Object.entries(worker.room!.sessionCreateIdempotency)[0]!;
    const scope = receiptKey.slice(0, receiptKey.lastIndexOf(':'));
    for (let i = 1; i < 240; i += 1) {
      worker.room!.sessionCreateIdempotency[`${scope}:diagnostic-prior-receipt-${i}`] = {
        ...receipt,
      };
    }
    const rejected = await join(worker);
    expect(rejected.response.status).toBe(409);
    await expect(rejected.response.json()).resolves.toEqual({
      error: 'ROOM_STATE_CAPACITY_EXCEEDED',
    });
    expect(records('event')).toEqual([
      expect.objectContaining({
        event: 'state_capacity',
        reason: 'session_receipt',
        livePresence: 1,
        sessionReceipts: 240,
      }),
    ]);
    vi.setSystemTime(1_060_001);
    await worker.withMutation(() => undefined);
    expect(records('summary')[0]).toMatchObject({
      counts: { presence_join: 1, 'state_capacity:session_receipt': 1 },
    });
    expectPrivateDataAbsent();
  });

  it('records live-tab conflicts and the DELETE presence/current leave route', async () => {
    const { worker } = await fixture();
    const admitted = await join(worker);
    const payload = (await admitted.response.json()) as {
      snapshot: { viewer: { participantId: string; presenceIncarnationId: string } };
    };
    const conflict = await worker.fetch(
      request('/presence/enter', undefined, admitted.cookie, 'POST'),
    );
    expect(conflict.status).toBe(409);
    expect(records('event')[0]).toMatchObject({
      event: 'presence_active_elsewhere',
      livePresence: 1,
    });
    const leave = request('/presence/current', undefined, admitted.cookie, 'DELETE');
    leave.headers.set('x-mxqr-pro-participant-id', payload.snapshot.viewer.participantId);
    leave.headers.set(
      'x-mxqr-pro-presence-incarnation',
      payload.snapshot.viewer.presenceIncarnationId,
    );
    expect((await worker.fetch(leave)).status).toBe(200);
    expect(records('summary')[0]).toMatchObject({ counts: { presence_leave: 1 } });
    expectPrivateDataAbsent();
  });

  it('accepts the canonical owner with no physical peer ordinal without a contract warning', async () => {
    const { worker } = await fixture();
    const owner = await worker.createSessionRecord('owner', 'private-owner', Date.now());
    expect(owner).not.toBeNull();
    if (!owner) throw new Error('missing owner fixture');
    worker.room!.ownerMemberId = owner.session.memberId;
    expect(owner.session.peerOrdinal).toBeUndefined();
    expect(worker.joinPresence(owner.session, owner.tokenHash, Date.now())).toBe(true);
    await worker.persist();
    expect((await join(worker)).response.status).toBe(200);
    expect(records('event')).toEqual([]);
    expectPrivateDataAbsent();
  });

  it('reports a server numeric projection regression without serializing its snapshot', async () => {
    const { worker } = await fixture();
    const original = worker.handleCreateSession.bind(worker);
    vi.spyOn(worker, 'handleCreateSession').mockImplementation(async (input) => {
      const response = await original(input);
      const payload = (await response.json()) as {
        snapshot: {
          presence: { participants: Array<{ memberDisplayNumber: number }> };
          viewer: { memberDisplayNumber: number };
        };
      };
      // Model a future handler regression after the normal identity allocator.
      const presence = Object.values(worker.room!.presence.participants)[0]!;
      presence.memberDisplayNumber = 101;
      worker.room!.sessions[presence.sessionHash]!.peerOrdinal = 101;
      payload.snapshot.presence.participants[0]!.memberDisplayNumber = 101;
      payload.snapshot.viewer.memberDisplayNumber = 101;
      return Response.json(payload, { status: response.status, headers: response.headers });
    });
    expect((await join(worker)).response.status).toBe(200);
    expect(
      records('event').map((entry) => [entry.event, entry.reason, entry.maxPeerOrdinal]),
    ).toEqual([
      ['snapshot_contract_invalid', 'member_display_number', 101],
      ['snapshot_contract_invalid', 'peer_ordinal', 101],
    ]);
    expectPrivateDataAbsent();
  });

  it('captures actual live room-full counts through the HTTP handler', async () => {
    const { worker } = await fixture();
    for (let i = 0; i < 99; i += 1) expect((await join(worker)).response.status).toBe(200);
    const rejected = await join(worker);
    expect(rejected.response.status).toBe(409);
    await expect(rejected.response.json()).resolves.toEqual({ error: 'ROOM_FULL' });
    expect(records('event')).toEqual([
      expect.objectContaining({
        event: 'room_full',
        scope: 'room',
        roomCode: ROOM,
        roomGeneration: 0,
        versionId: VERSION_ID,
        operation: 'sessions',
        livePresence: 99,
        nonOwnerPresence: 99,
        storedSessions: 99,
        status: 409,
      }),
    ]);
    expectPrivateDataAbsent();
  });

  it('keeps successful heartbeats silent and classifies expired session replay as re-entry', async () => {
    const { worker } = await fixture();
    const admitted = await join(worker);
    expect(admitted.response.status).toBe(200);
    const payload = (await admitted.response.json()) as {
      snapshot: { viewer: { participantId: string; presenceIncarnationId: string } };
    };
    const viewer = payload.snapshot.viewer;
    const heartbeatRequest = request('/presence/heartbeat', undefined, admitted.cookie, 'POST');
    heartbeatRequest.headers.set('x-mxqr-pro-participant-id', viewer.participantId);
    heartbeatRequest.headers.set('x-mxqr-pro-presence-incarnation', viewer.presenceIncarnationId);
    const heartbeat = await worker.fetch(heartbeatRequest);
    expect(heartbeat.status).toBe(200);
    expect(records('event')).toEqual([]);
    expect(records('summary')).toEqual([]);

    vi.setSystemTime(1_045_001);
    const replayed = await worker.fetch(request('/sessions', { requestId: admitted.requestId }));
    expect(replayed.status).toBe(200);
    vi.setSystemTime(1_060_001);
    await worker.withMutation(() => undefined);
    const counts = records('summary').map((entry) => entry.counts as Record<string, number>);
    expect(counts.reduce((total, entry) => total + (entry.presence_reenter ?? 0), 0)).toBe(1);
    expect(counts.every((entry) => entry.presence_takeover === undefined)).toBe(true);
    expectPrivateDataAbsent();
  });

  it('does not emit a fictitious successful join after a storage transaction rolls admission back', async () => {
    const { worker, storage } = await fixture();
    storage.failNextWrite = true;
    await expect(join(worker)).rejects.toThrow('PRO room state storage transaction failed');
    expect(Object.keys(worker.room!.presence.participants)).toHaveLength(0);
    expect(Object.keys(worker.room!.sessions)).toHaveLength(0);
    vi.setSystemTime(1_060_001);
    await worker.withMutation(() => undefined);
    expect(records('event')).toEqual([]);
    expect(records('summary')).toEqual([]);
  });
});

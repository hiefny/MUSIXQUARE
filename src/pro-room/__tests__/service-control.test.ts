import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelReadableBody, readBodyBytesLimited } from '../../../cloudflare/pro-room-body.ts';
import { MusixquareServiceControl } from '../../../cloudflare/pro-room-worker.ts';
import {
  ABUSE_RATE_CONSUME_PATH,
  ABUSE_RATE_IDEMPOTENT_CONSUME_PATH,
  ABUSE_RATE_PAIR_CONSUME_PATH,
  ABUSE_RATE_RESPONSE_PROTOCOL,
  ABUSE_RATE_RESPONSE_PROTOCOL_HEADER,
  ABUSE_RATE_RESPONSE_RESULT_HEADER,
  ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME,
  ADMIN_ANNOUNCEMENT_MIGRATION_HEADER,
  ADMIN_ANNOUNCEMENT_STATE_PATH,
  ADMIN_ANNOUNCEMENT_STATUS_PATH,
  SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER,
  SERVICE_CONTROL_STATUS_ENABLED_HEADER,
  SERVICE_CONTROL_STATUS_PATH,
  SERVICE_CONTROL_STATUS_REVISION_HEADER,
  SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER,
  SERVICE_CONTROL_STATUS_VERSION_HEADER,
} from '../../../cloudflare/service-maintenance.ts';

class ServiceControlStorage {
  readonly data = new Map<string, unknown>();
  readonly getKeys: string[] = [];
  alarmAt: number | null = null;
  readonly setAlarmCalls: number[] = [];

  async get(key: string): Promise<unknown> {
    this.getKeys.push(key);
    return structuredClone(this.data.get(key));
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries;
    for (const [key, entry] of Object.entries(entries)) {
      this.data.set(key, structuredClone(entry));
    }
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarmAt = timestamp;
    this.setAlarmCalls.push(timestamp);
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

function setup(
  storage = new ServiceControlStorage(),
  objectName?: string,
): {
  control: MusixquareServiceControl;
  storage: ServiceControlStorage;
} {
  const state = {
    storage,
    ...(objectName ? { id: { name: objectName } } : {}),
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

function rateRequest(path: string, operationId?: string, limit = 1): Request {
  return new Request(`https://service-control.internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      limit,
      windowMs: 60_000,
      cost: 1,
      ...(operationId === undefined ? {} : { operationId }),
    }),
  });
}

function requestHeaderResponse(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set(ABUSE_RATE_RESPONSE_PROTOCOL_HEADER, ABUSE_RATE_RESPONSE_PROTOCOL);
  return new Request(request, { headers });
}

function pairRateRequest(
  secondaryIdentity: string | null,
  {
    limit = 3,
    secondaryLimit = 2,
    cost = 1,
    secondaryCost = 1,
  }: {
    limit?: number;
    secondaryLimit?: number;
    cost?: number;
    secondaryCost?: number;
  } = {},
): Request {
  return new Request(`https://service-control.internal${ABUSE_RATE_PAIR_CONSUME_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      limit,
      windowMs: 60_000,
      cost,
      secondaryIdentity,
      secondaryLimit: secondaryIdentity === null ? null : secondaryLimit,
      secondaryCost: secondaryIdentity === null ? null : secondaryCost,
    }),
  });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PRO room bounded request bodies', () => {
  function requestWithReader(
    reader: {
      read(): Promise<{ done: boolean; value?: Uint8Array | ArrayBuffer }>;
      cancel(reason?: unknown): unknown;
      releaseLock(): void;
    },
    {
      contentLength,
      signal = new AbortController().signal,
    }: { contentLength?: string; signal?: AbortSignal } = {},
  ): Request {
    return {
      headers: new Headers(contentLength === undefined ? {} : { 'Content-Length': contentLength }),
      body: { getReader: () => reader },
      signal,
    } as unknown as Request;
  }

  it.each([
    ['a malformed content length', 'not-a-number', 16, 'invalid'],
    ['a negative content length', '-1', 16, 'invalid'],
    ['a declared body over the limit', '17', 16, 'too-large'],
  ])('rejects %s before acquiring a stream reader', async (_label, length, limit, error) => {
    const getReader = vi.fn();
    const request = {
      headers: new Headers({ 'Content-Length': length }),
      body: { getReader },
      signal: new AbortController().signal,
    } as unknown as Request;

    await expect(readBodyBytesLimited(request, limit, 100)).resolves.toEqual({ error });
    expect(getReader).not.toHaveBeenCalled();
  });

  it('returns an explicit null body without acquiring a reader', async () => {
    await expect(
      readBodyBytesLimited(new Request('https://service-control.internal/empty'), 16, 100),
    ).resolves.toEqual({ body: null });
  });

  it('assembles mixed stream chunks and always releases the reader lock', async () => {
    const releaseLock = vi.fn();
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2]) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([3, 4]).buffer })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
      releaseLock,
    };

    const outcome = await readBodyBytesLimited(
      requestWithReader(reader, { contentLength: '4' }),
      4,
      100,
    );

    expect(outcome).toEqual({ body: new Uint8Array([1, 2, 3, 4]) });
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('maps a stream read rejection to invalid and tolerates releaseLock failure', async () => {
    const releaseLock = vi.fn(() => {
      throw new Error('already released');
    });
    const reader = {
      read: vi.fn().mockRejectedValue(new Error('stream failed')),
      cancel: vi.fn(),
      releaseLock,
    };

    await expect(readBodyBytesLimited(requestWithReader(reader), 16, 100)).resolves.toEqual({
      error: 'invalid',
    });
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('cancels an actual body overflow and releases the reader lock', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array([1, 2, 3]) }),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };

    await expect(readBodyBytesLimited(requestWithReader(reader), 2, 100)).resolves.toEqual({
      error: 'too-large',
    });
    expect(reader.cancel).toHaveBeenCalledWith('PRO_ROOM_REQUEST_BODY_TOO_LARGE');
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('bounds a stalled read, cancels it, and ignores asynchronous cancel rejection', async () => {
    vi.useFakeTimers();
    const reader = {
      read: vi.fn(() => new Promise<never>(() => {})),
      cancel: vi.fn().mockRejectedValue(new Error('cancel rejected')),
      releaseLock: vi.fn(),
    };
    const pending = readBodyBytesLimited(requestWithReader(reader), 16, 2_000);

    await vi.advanceTimersByTimeAsync(2_001);

    await expect(pending).resolves.toEqual({ error: 'timeout' });
    expect(reader.cancel).toHaveBeenCalledWith('PRO_ROOM_REQUEST_BODY_TIMEOUT');
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('honors a pre-aborted request and ignores synchronous cancel failure', async () => {
    const abort = new AbortController();
    const reason = new Error('request aborted');
    abort.abort(reason);
    const reader = {
      read: vi.fn(() => new Promise<never>(() => {})),
      cancel: vi.fn(() => {
        throw new Error('cancel failed');
      }),
      releaseLock: vi.fn(),
    };

    await expect(
      readBodyBytesLimited(requestWithReader(reader, { signal: abort.signal }), 16, 100),
    ).resolves.toEqual({ error: 'aborted' });
    expect(reader.cancel).toHaveBeenCalledWith(reason);
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('cancels response-like wrappers and ignores non-cancellable values', () => {
    const cancel = vi.fn();
    const reason = new Error('stop');

    cancelReadableBody({ body: { cancel } }, reason);
    cancelReadableBody(undefined, reason);
    cancelReadableBody({ body: {} }, reason);

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(reason);
  });
});

describe('MusixquareServiceControl', () => {
  it('fails malformed storage ports explicitly instead of trusting untyped runtime state', async () => {
    const control = new MusixquareServiceControl({ storage: {} });

    await expect(
      control.fetch(new Request(`https://service-control.internal${SERVICE_CONTROL_STATUS_PATH}`)),
    ).rejects.toThrow('Service-control storage get() is unavailable');
  });

  it('rejects malformed typed control envelopes before any mutation', async () => {
    const { control } = setup();
    const pair = setup(
      new ServiceControlStorage(),
      'musixquare-abuse-rate-pair-v1:app-turn-config:invalid-envelope',
    ).control;
    const invalidAnnouncement = new Request(
      `https://service-control.internal${ADMIN_ANNOUNCEMENT_STATE_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );

    const responses = await Promise.all([
      control.fetch(rateRequest(ABUSE_RATE_IDEMPOTENT_CONSUME_PATH, 'short')),
      pair.fetch(pairRateRequest(null, { limit: 0 })),
      control.fetch(stateRequest(true, -1, '123e4567-e89b-42d3-a456-426614174099')),
      control.fetch(invalidAnnouncement),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    await Promise.all(
      responses.map((response) =>
        expect(payload(response)).resolves.toEqual({ error: 'INVALID_REQUEST' }),
      ),
    );
  });

  it('loads only announcement keys and exposes only announcement routes for the separated object', async () => {
    const { control, storage } = setup(
      new ServiceControlStorage(),
      ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME,
    );

    const announcement = await control.fetch(
      new Request(`https://service-control.internal${ADMIN_ANNOUNCEMENT_STATUS_PATH}`),
    );
    expect(announcement.status).toBe(200);
    expect(storage.getKeys).toEqual(['admin-announcement-state', 'admin-announcement-requests']);
    expect(
      (
        await control.fetch(
          new Request(`https://service-control.internal${SERVICE_CONTROL_STATUS_PATH}`),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await control.fetch(
          new Request(`https://service-control.internal${ABUSE_RATE_CONSUME_PATH}`, {
            method: 'POST',
          }),
        )
      ).status,
    ).toBe(404);
  });

  it('accepts revision inheritance only on the named announcement object', async () => {
    const legacy = {
      id: 'legacy-current',
      message: 'Legacy current notice',
      enabled: true,
      expiresAt: null,
      updatedAt: '2026-08-01T00:00:00.000Z',
      action: 'published',
    };
    const migrationRequest = () => {
      const request = announcementRequest(
        'Separated notice',
        7,
        '123e4567-e89b-42d3-a456-426614174097',
        [legacy],
      );
      request.headers.set(ADMIN_ANNOUNCEMENT_MIGRATION_HEADER, '1');
      return request;
    };

    const original = setup().control;
    expect((await original.fetch(migrationRequest())).status).toBe(409);

    const separated = setup(
      new ServiceControlStorage(),
      ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME,
    ).control;
    const migrated = await separated.fetch(migrationRequest());
    expect(migrated.status).toBe(200);
    await expect(payload(migrated)).resolves.toMatchObject({
      announcementState: {
        revision: 8,
        history: [{ message: 'Separated notice' }, legacy],
      },
    });
  });
  it('loads only the owned counter for a named abuse-rate object', async () => {
    const storage = new ServiceControlStorage();
    const { control } = setup(storage, 'musixquare-abuse-rate-v1:app-turn:opaque-rate-identity');

    const consumed = await control.fetch(rateRequest(ABUSE_RATE_CONSUME_PATH));
    expect(consumed.status).toBe(200);
    await expect(payload(consumed)).resolves.toMatchObject({ allowed: true, remaining: 0 });
    expect(storage.getKeys).toEqual(['abuse-rate-state-v1']);

    const unrelated = await control.fetch(
      new Request('https://service-control.internal/internal/service-maintenance/v1/status'),
    );
    expect(unrelated.status).toBe(404);
    expect(storage.getKeys).toEqual(['abuse-rate-state-v1']);
  });

  it('returns a negotiated single-counter result in headers with no body', async () => {
    const { control } = setup(
      new ServiceControlStorage(),
      'musixquare-abuse-rate-v1:app-turn:header-rate-identity',
    );

    const response = await control.fetch(
      requestHeaderResponse(rateRequest(ABUSE_RATE_CONSUME_PATH)),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get(ABUSE_RATE_RESPONSE_PROTOCOL_HEADER)).toBe(
      ABUSE_RATE_RESPONSE_PROTOCOL,
    );
    expect(JSON.parse(response.headers.get(ABUSE_RATE_RESPONSE_RESULT_HEADER) || '')).toMatchObject(
      {
        allowed: true,
        limit: 1,
        remaining: 0,
      },
    );
  });

  it('keeps a similar but non-canonical object-name prefix on the full-load path', async () => {
    const storage = new ServiceControlStorage();
    const { control } = setup(storage, 'musixquare-abuse-rate-v10:app-turn:opaque-rate-identity');

    const status = await control.fetch(
      new Request('https://service-control.internal/internal/service-maintenance/v1/status'),
    );

    expect(status.status).toBe(200);
    expect(storage.getKeys).toEqual([
      'service-maintenance-state',
      'service-maintenance-requests',
      'admin-announcement-state',
      'admin-announcement-requests',
      'abuse-rate-state-v1',
    ]);
  });

  it('fails a named abuse-rate object closed when its owned counter is corrupt', async () => {
    const storage = new ServiceControlStorage();
    storage.data.set('abuse-rate-state-v1', {
      v: 2,
      limit: 1,
      windowMs: 60_000,
      windowStartMs: 0,
      resetAtMs: 60_000,
      count: 2,
      operationIds: [],
    });
    const { control } = setup(storage, 'musixquare-abuse-rate-v1:app-turn:corrupt-rate-identity');

    const response = await control.fetch(rateRequest(ABUSE_RATE_CONSUME_PATH));

    expect(response.status).toBe(503);
    await expect(payload(response)).resolves.toEqual({ error: 'ABUSE_RATE_STATE_INVALID' });
    expect(storage.getKeys).toEqual(['abuse-rate-state-v1']);
  });

  it('returns negotiated abuse-rate failures without a response body', async () => {
    const storage = new ServiceControlStorage();
    storage.data.set('abuse-rate-state-v1', {
      v: 2,
      limit: 1,
      windowMs: 60_000,
      windowStartMs: 0,
      resetAtMs: 60_000,
      count: 2,
      operationIds: [],
    });
    const { control } = setup(
      storage,
      'musixquare-abuse-rate-v1:app-turn:negotiated-corrupt-rate-identity',
    );

    const response = await control.fetch(
      requestHeaderResponse(rateRequest(ABUSE_RATE_CONSUME_PATH)),
    );

    expect(response.status).toBe(503);
    expect(response.body).toBeNull();
    expect(response.headers.get(ABUSE_RATE_RESPONSE_PROTOCOL_HEADER)).toBe(
      ABUSE_RATE_RESPONSE_PROTOCOL,
    );
    expect(response.headers.get(ABUSE_RATE_RESPONSE_RESULT_HEADER)).toBeNull();
  });

  it('atomically enforces the shared IP limit before independent capability limits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T08:00:30.000Z'));
    const storage = new ServiceControlStorage();
    const objectName = 'musixquare-abuse-rate-pair-v1:app-turn-config:opaque-ip';
    const { control } = setup(storage, objectName);

    const [first, second, third, denied] = await Promise.all([
      control.fetch(pairRateRequest('token-a')),
      control.fetch(pairRateRequest('token-a')),
      control.fetch(pairRateRequest('token-b')),
      control.fetch(pairRateRequest('token-c')),
    ]);

    expect([first.status, second.status, third.status, denied.status]).toEqual([
      200, 200, 200, 200,
    ]);
    await expect(payload(first)).resolves.toMatchObject({
      allowed: true,
      deniedBy: null,
      primary: { allowed: true },
      secondary: { allowed: true },
    });
    await expect(payload(second)).resolves.toMatchObject({ allowed: true, deniedBy: null });
    await expect(payload(third)).resolves.toMatchObject({ allowed: true, deniedBy: null });
    await expect(payload(denied)).resolves.toMatchObject({
      allowed: false,
      deniedBy: 'primary',
      primary: { allowed: false, remaining: 0 },
      secondary: null,
    });
    expect(storage.getKeys).toEqual(['abuse-rate-pair-state-v1']);
    expect(storage.data.get('abuse-rate-pair-state-v1')).toMatchObject({
      primary: { limit: 3, count: 3 },
      secondaries: [
        { identity: 'token-a', limit: 2, count: 2 },
        { identity: 'token-b', limit: 2, count: 1 },
      ],
    });
    expect(storage.setAlarmCalls).toEqual([Date.parse('2026-08-11T08:01:00.000Z')]);
  });

  it('returns a negotiated pair result in headers with no body', async () => {
    const { control } = setup(
      new ServiceControlStorage(),
      'musixquare-abuse-rate-pair-v1:app-turn-config:header-pair-identity',
    );

    const response = await control.fetch(requestHeaderResponse(pairRateRequest('token-a')));

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get(ABUSE_RATE_RESPONSE_PROTOCOL_HEADER)).toBe(
      ABUSE_RATE_RESPONSE_PROTOCOL,
    );
    expect(JSON.parse(response.headers.get(ABUSE_RATE_RESPONSE_RESULT_HEADER) || '')).toMatchObject(
      {
        allowed: true,
        deniedBy: null,
        primary: { allowed: true, remaining: 2 },
        secondary: { allowed: true, remaining: 1 },
      },
    );
  });

  it('counts primary-only authentication failures in the same pair IP bucket', async () => {
    const objectName = 'musixquare-abuse-rate-pair-v1:app-turn-config:shared-ip';
    const { control, storage } = setup(new ServiceControlStorage(), objectName);

    const unauthenticated = await control.fetch(pairRateRequest(null, { limit: 2 }));
    const authenticated = await control.fetch(pairRateRequest('valid-token', { limit: 2 }));
    const limited = await control.fetch(pairRateRequest('another-token', { limit: 2 }));

    await expect(payload(unauthenticated)).resolves.toMatchObject({
      allowed: true,
      primary: { remaining: 1 },
      secondary: null,
    });
    await expect(payload(authenticated)).resolves.toMatchObject({
      allowed: true,
      primary: { remaining: 0 },
      secondary: { remaining: 1 },
    });
    await expect(payload(limited)).resolves.toMatchObject({
      allowed: false,
      deniedBy: 'primary',
      secondary: null,
    });
    expect(storage.data.get('abuse-rate-pair-state-v1')).toMatchObject({
      primary: { count: 2 },
      secondaries: [{ identity: 'valid-token', count: 1 }],
    });
  });

  it('charges the IP once when a capability is denied and never advances that capability', async () => {
    const objectName = 'musixquare-abuse-rate-pair-v1:app-turn-config:secondary-denial';
    const { control, storage } = setup(new ServiceControlStorage(), objectName);

    expect(
      (await control.fetch(pairRateRequest('token-a', { limit: 10, secondaryLimit: 1 }))).status,
    ).toBe(200);
    const denied = await control.fetch(
      pairRateRequest('token-a', { limit: 10, secondaryLimit: 1 }),
    );

    await expect(payload(denied)).resolves.toMatchObject({
      allowed: false,
      deniedBy: 'secondary',
      primary: { allowed: true, remaining: 8 },
      secondary: { allowed: false, remaining: 0 },
    });
    expect(storage.data.get('abuse-rate-pair-state-v1')).toMatchObject({
      primary: { count: 2 },
      secondaries: [{ identity: 'token-a', count: 1 }],
    });
  });

  it('fails pair consumption closed on corrupt pair state', async () => {
    const storage = new ServiceControlStorage();
    storage.data.set('abuse-rate-pair-state-v1', {
      v: 1,
      windowMs: 60_000,
      windowStartMs: 0,
      resetAtMs: 60_000,
      primary: { limit: 3, count: 4 },
      secondaries: [],
    });
    const { control } = setup(storage, 'musixquare-abuse-rate-pair-v1:app-turn-config:corrupt-ip');

    const response = await control.fetch(pairRateRequest('token-a'));

    expect(response.status).toBe(503);
    await expect(payload(response)).resolves.toEqual({ error: 'ABUSE_RATE_PAIR_STATE_INVALID' });
  });

  it.each([
    [
      'a zero primary count',
      {
        v: 1,
        windowMs: 60_000,
        windowStartMs: 0,
        resetAtMs: 60_000,
        primary: { limit: 3, count: 0 },
        secondaries: [],
      },
    ],
    [
      'a zero secondary count',
      {
        v: 1,
        windowMs: 60_000,
        windowStartMs: 0,
        resetAtMs: 60_000,
        primary: { limit: 3, count: 1 },
        secondaries: [{ identity: 'token-a', limit: 2, count: 0 }],
      },
    ],
    [
      'more secondary consumes than primary consumes',
      {
        v: 1,
        windowMs: 60_000,
        windowStartMs: 0,
        resetAtMs: 60_000,
        primary: { limit: 3, count: 1 },
        secondaries: [{ identity: 'token-a', limit: 2, count: 2 }],
      },
    ],
  ])('fails pair consumption closed on unreachable pair state with %s', async (_label, state) => {
    const storage = new ServiceControlStorage();
    storage.data.set('abuse-rate-pair-state-v1', state);
    const { control } = setup(
      storage,
      'musixquare-abuse-rate-pair-v1:app-turn-config:unreachable-state',
    );

    const response = await control.fetch(pairRateRequest('token-a'));

    expect(response.status).toBe(503);
    await expect(payload(response)).resolves.toEqual({ error: 'ABUSE_RATE_PAIR_STATE_INVALID' });
  });

  it('rejects a secondary cost that could outrun the primary persisted count', async () => {
    const { control, storage } = setup(
      new ServiceControlStorage(),
      'musixquare-abuse-rate-pair-v1:app-turn-config:invalid-cost',
    );

    const response = await control.fetch(pairRateRequest('token-a', { cost: 1, secondaryCost: 2 }));

    expect(response.status).toBe(400);
    await expect(payload(response)).resolves.toEqual({ error: 'INVALID_REQUEST' });
    expect(storage.data.has('abuse-rate-pair-state-v1')).toBe(false);
  });

  it('latches alarm-observed pair corruption so the live object remains fail-closed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T08:00:30.000Z'));
    const storage = new ServiceControlStorage();
    const { control } = setup(
      storage,
      'musixquare-abuse-rate-pair-v1:app-turn-config:alarm-corruption',
    );
    expect((await control.fetch(pairRateRequest('token-a'))).status).toBe(200);
    const stored = storage.data.get('abuse-rate-pair-state-v1') as Record<string, unknown>;
    storage.data.set('abuse-rate-pair-state-v1', {
      ...stored,
      primary: { limit: 3, count: 0 },
    });

    await expect((control as unknown as { alarm(): Promise<void> }).alarm()).rejects.toThrow(
      'ABUSE_RATE_STATE_INVALID',
    );
    const afterAlarm = await control.fetch(pairRateRequest('token-a'));

    expect(afterAlarm.status).toBe(503);
    await expect(payload(afterAlarm)).resolves.toEqual({
      error: 'ABUSE_RATE_PAIR_STATE_INVALID',
    });
  });

  it('expires pair state through its one persistent alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T08:00:30.000Z'));
    const storage = new ServiceControlStorage();
    const { control } = setup(storage, 'musixquare-abuse-rate-pair-v1:app-turn-config:expiring-ip');
    expect((await control.fetch(pairRateRequest('token-a'))).status).toBe(200);
    expect(storage.data.has('abuse-rate-pair-state-v1')).toBe(true);

    vi.setSystemTime(new Date('2026-08-11T08:01:00.001Z'));
    await (control as unknown as { alarm(): Promise<void> }).alarm();

    expect(storage.data.has('abuse-rate-pair-state-v1')).toBe(false);
    expect(storage.alarmAt).toBeNull();
  });

  it('keeps one persistent alarm for repeated consumes in the same fixed window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T08:00:30.000Z'));
    const storage = new ServiceControlStorage();
    const objectName = 'musixquare-abuse-rate-v1:signaling-ws-open:opaque-rate-identity';
    const { control } = setup(storage, objectName);

    expect((await control.fetch(rateRequest(ABUSE_RATE_CONSUME_PATH, undefined, 3))).status).toBe(
      200,
    );
    expect((await control.fetch(rateRequest(ABUSE_RATE_CONSUME_PATH, undefined, 3))).status).toBe(
      200,
    );
    expect(storage.setAlarmCalls).toEqual([Date.parse('2026-08-11T08:01:00.000Z')]);

    const rehydrated = setup(storage, objectName).control;
    expect(
      (await rehydrated.fetch(rateRequest(ABUSE_RATE_CONSUME_PATH, undefined, 3))).status,
    ).toBe(200);
    expect(storage.setAlarmCalls).toEqual([Date.parse('2026-08-11T08:01:00.000Z')]);
  });

  it('keeps the full cold load when the Durable Object id has no trusted name', async () => {
    const storage = new ServiceControlStorage();
    const { control } = setup(storage);

    const status = await control.fetch(
      new Request('https://service-control.internal/internal/service-maintenance/v1/status'),
    );

    expect(status.status).toBe(200);
    expect(storage.getKeys).toEqual([
      'service-maintenance-state',
      'service-maintenance-requests',
      'admin-announcement-state',
      'admin-announcement-requests',
      'abuse-rate-state-v1',
    ]);
  });

  it('counts one successful v2 operation once while preserving the exact v1 body', async () => {
    const { control, storage } = setup();
    const operationId = `rs_${'A'.repeat(43)}`;

    const first = await control.fetch(rateRequest(ABUSE_RATE_IDEMPOTENT_CONSUME_PATH, operationId));
    const rehydrated = setup(storage).control;
    const replay = await rehydrated.fetch(
      rateRequest(ABUSE_RATE_IDEMPOTENT_CONSUME_PATH, operationId),
    );
    const limited = await rehydrated.fetch(
      rateRequest(ABUSE_RATE_IDEMPOTENT_CONSUME_PATH, `rs_${'B'.repeat(43)}`),
    );
    const v1WithV2Body = await rehydrated.fetch(rateRequest(ABUSE_RATE_CONSUME_PATH, operationId));
    const legacyV1 = await rehydrated.fetch(rateRequest(ABUSE_RATE_CONSUME_PATH));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(limited.status).toBe(200);
    await expect(payload(first)).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(payload(replay)).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(payload(limited)).resolves.toMatchObject({ allowed: false, remaining: 0 });
    expect(v1WithV2Body.status).toBe(400);
    await expect(payload(v1WithV2Body)).resolves.toEqual({ error: 'INVALID_REQUEST' });
    expect(legacyV1.status).toBe(200);
    await expect(payload(legacyV1)).resolves.toMatchObject({ allowed: false, remaining: 0 });
  });

  it('bounds and cancels a stalled private JSON body without blocking the next mutation', async () => {
    vi.useFakeTimers();
    const { control } = setup();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"limit":10'));
      },
      cancel,
    });
    const pending = control.fetch(
      new Request('https://service-control.internal/internal/abuse-rate/v1/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    await vi.advanceTimersByTimeAsync(2_001);

    const timedOut = await pending;
    expect(timedOut.status).toBe(408);
    await expect(payload(timedOut)).resolves.toEqual({ error: 'REQUEST_TIMEOUT' });
    expect(cancel).toHaveBeenCalledOnce();

    const next = await control.fetch(stateRequest(true, 0, '123e4567-e89b-42d3-a456-426614174090'));
    expect(next.status).toBe(200);
  });

  it.each([
    ['a malformed declared length', 'not-a-number'],
    ['an oversized declared length', '1025'],
  ])('rejects %s before reading an abuse-rate body', async (_label, contentLength) => {
    const { control } = setup();
    const response = await control.fetch(
      new Request(`https://service-control.internal${ABUSE_RATE_CONSUME_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': contentLength,
        },
        body: '{}',
      }),
    );

    expect(response.status).toBe(413);
    await expect(payload(response)).resolves.toEqual({ error: 'REQUEST_TOO_LARGE' });
  });

  it('maps an invalid declared maintenance length to invalid JSON', async () => {
    const { control } = setup();
    const request = stateRequest(true, 0, '123e4567-e89b-42d3-a456-426614174091');
    request.headers.set('Content-Length', 'not-a-number');

    const response = await control.fetch(request);

    expect(response.status).toBe(400);
    await expect(payload(response)).resolves.toEqual({ error: 'INVALID_JSON' });
  });

  it('rejects an undeclared private body that exceeds its byte limit while streaming', async () => {
    const { control } = setup();
    const response = await control.fetch(
      new Request(`https://service-control.internal${ABUSE_RATE_CONSUME_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: new Uint8Array(1_025),
      }),
    );

    expect(response.status).toBe(413);
    await expect(payload(response)).resolves.toEqual({ error: 'REQUEST_TOO_LARGE' });
  });

  it('maps a rejected private body read to invalid JSON', async () => {
    const { control } = setup();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stream failed'));
      },
    });
    const response = await control.fetch(
      new Request('https://service-control.internal/internal/service-maintenance/v1/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );

    expect(response.status).toBe(400);
    await expect(payload(response)).resolves.toEqual({ error: 'INVALID_JSON' });
  });

  it('maps an aborted private body read to a bounded timeout response', async () => {
    const { control } = setup();
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = new Request(
      'https://service-control.internal/internal/service-maintenance/v1/state',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: abort.signal,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' },
    );
    abort.abort(new Error('request aborted'));

    const response = await control.fetch(request);

    expect(response.status).toBe(408);
    await expect(payload(response)).resolves.toEqual({ error: 'REQUEST_TIMEOUT' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects malformed UTF-8 in a bounded private JSON body', async () => {
    const { control } = setup();
    const response = await control.fetch(
      new Request('https://service-control.internal/internal/abuse-rate/v1/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]),
      }),
    );
    expect(response.status).toBe(400);
    await expect(payload(response)).resolves.toEqual({ error: 'INVALID_JSON' });
  });

  it('repairs a future single-rate alarm and later expires its persisted state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T08:00:30.000Z'));
    const storage = new ServiceControlStorage();
    const { control } = setup(storage, 'musixquare-abuse-rate-v1:app-turn:alarm-lifecycle');
    expect((await control.fetch(rateRequest(ABUSE_RATE_CONSUME_PATH, undefined, 3))).status).toBe(
      200,
    );

    await (control as unknown as { alarm(): Promise<void> }).alarm();
    expect(storage.data.has('abuse-rate-state-v1')).toBe(true);
    expect(storage.setAlarmCalls).toEqual([
      Date.parse('2026-08-11T08:01:00.000Z'),
      Date.parse('2026-08-11T08:01:00.000Z'),
    ]);

    vi.setSystemTime(new Date('2026-08-11T08:01:00.001Z'));
    await (control as unknown as { alarm(): Promise<void> }).alarm();
    expect(storage.data.has('abuse-rate-state-v1')).toBe(false);
    expect(storage.alarmAt).toBeNull();
  });

  it('clears a missing single-rate alarm state idempotently', async () => {
    const storage = new ServiceControlStorage();
    storage.alarmAt = Date.now() + 60_000;
    const { control } = setup(storage, 'musixquare-abuse-rate-v1:app-turn:missing-alarm-state');

    await (control as unknown as { alarm(): Promise<void> }).alarm();

    expect(storage.data.has('abuse-rate-state-v1')).toBe(false);
    expect(storage.alarmAt).toBeNull();
  });

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
    expect(initial.headers.get(SERVICE_CONTROL_STATUS_VERSION_HEADER)).toBe('1');
    expect(initial.headers.get(SERVICE_CONTROL_STATUS_ENABLED_HEADER)).toBe('0');
    expect(initial.headers.get(SERVICE_CONTROL_STATUS_REVISION_HEADER)).toBe('0');
    expect(initial.headers.get(SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER)).toBe('null');
    expect(initial.headers.get(SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER)).toBe('null');

    const initialHead = await control.fetch(
      new Request('https://service-control.internal/internal/service-maintenance/v1/status', {
        method: 'HEAD',
      }),
    );
    expect(initialHead.status).toBe(200);
    expect(initialHead.body).toBeNull();
    expect(initialHead.headers.get(SERVICE_CONTROL_STATUS_VERSION_HEADER)).toBe('1');
    expect(initialHead.headers.get(SERVICE_CONTROL_STATUS_ENABLED_HEADER)).toBe('0');

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

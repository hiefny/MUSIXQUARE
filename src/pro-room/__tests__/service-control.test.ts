import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelReadableBody, readBodyBytesLimited } from '../../../cloudflare/pro-room-body.ts';
import { MusixquareServiceControl } from '../../../cloudflare/pro-room-worker.ts';
import { APP_BUILD_FLOOR_REPORT_STALE_MS } from '../../../cloudflare/app-build-floor-contract.ts';
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
  APP_BUILD_FLOOR_HISTORY_PATH,
  APP_BUILD_FLOOR_LIVE_REPORT_PATH,
  APP_BUILD_FLOOR_STATE_PATH,
  APP_BUILD_FLOOR_STATUS_HEADERS,
  APP_BUILD_FLOOR_STATUS_PATH,
  SERVICE_CONTROL_HISTORY_PATH,
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
      'app-build-floor-state',
      'app-build-floor-requests',
      'app-build-floor-live-report',
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

  it('does not charge the shared IP when a capability is denied', async () => {
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
      primary: { allowed: true, remaining: 9 },
      secondary: { allowed: false, remaining: 0 },
    });
    expect(storage.data.get('abuse-rate-pair-state-v1')).toMatchObject({
      primary: { count: 1 },
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
      'app-build-floor-state',
      'app-build-floor-requests',
      'app-build-floor-live-report',
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

  it('reads only recorded maintenance revisions across restarts without writing or exposing request IDs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
    const { control, storage } = setup();
    const historyRequest = () =>
      new Request(`https://service-control.internal${SERVICE_CONTROL_HISTORY_PATH}`);
    expect(await payload(await control.fetch(historyRequest()))).toEqual({
      history: [],
      truncated: false,
    });
    await control.fetch(stateRequest(false, 0, 'initial-noop-request'));
    await control.fetch(stateRequest(true, 0, 'enable-history-request'));
    await control.fetch(stateRequest(true, 0, 'enable-history-request'));
    await control.fetch(stateRequest(true, 1, 'enabled-noop-request'));
    vi.advanceTimersByTime(1000);
    await control.fetch(stateRequest(false, 1, 'disable-history-request'));
    await control.fetch(stateRequest(true, 1, 'stale-history-request'));

    const beforeRead = structuredClone(storage.data);
    const restarted = setup(storage).control;
    const response = await restarted.fetch(historyRequest());
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(await payload(response)).toEqual({
      history: [
        { enabled: false, revision: 2, updatedAt: Date.parse('2026-09-08T12:00:01Z') },
        { enabled: true, revision: 1, updatedAt: Date.parse('2026-09-08T12:00:00Z') },
      ],
      truncated: false,
    });
    expect(storage.data).toEqual(beforeRead);
  });

  it('reports incomplete history when request retention evicts earlier changes, including no-op churn', async () => {
    const { control, storage } = setup();
    for (let revision = 0; revision < 66; revision += 1) {
      await control.fetch(stateRequest(revision % 2 === 0, revision, `history-change-${revision}`));
    }
    const readHistory = () =>
      control.fetch(new Request(`https://service-control.internal${SERVICE_CONTROL_HISTORY_PATH}`));
    const recent = await payload(await readHistory());
    expect(recent).toMatchObject({ truncated: true });
    expect(recent.history).toHaveLength(64);
    expect(recent.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ revision: 66 }),
        expect.objectContaining({ revision: 3 }),
      ]),
    );
    for (let index = 0; index < 64; index += 1) {
      await control.fetch(stateRequest(false, 66, `history-noop-${index}`));
    }
    expect(await payload(await readHistory())).toEqual({
      history: [expect.objectContaining({ enabled: false, revision: 66 })],
      truncated: true,
    });
    storage.data.delete('service-maintenance-requests');
    const restarted = setup(storage).control;
    expect(
      await payload(
        await restarted.fetch(
          new Request(`https://service-control.internal${SERVICE_CONTROL_HISTORY_PATH}`),
        ),
      ),
    ).toEqual({
      history: [expect.objectContaining({ enabled: false, revision: 66 })],
      truncated: true,
    });
  });

  it('keeps maintenance history isolated from announcement and abuse-rate objects and rejects conflicting snapshots', async () => {
    for (const name of [
      ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME,
      'musixquare-abuse-rate-v1:test',
      'musixquare-abuse-rate-pair-v1:test',
    ]) {
      const isolated = setup(new ServiceControlStorage(), name).control;
      const response = await isolated.fetch(
        new Request(`https://service-control.internal${SERVICE_CONTROL_HISTORY_PATH}`),
      );
      expect(response.status).toBe(404);
    }
    const { control, storage } = setup();
    await control.fetch(stateRequest(true, 0, 'history-valid-request'));
    const state = storage.data.get('service-maintenance-state') as Record<string, unknown>;
    storage.data.set('service-maintenance-requests', [
      { requestId: 'history-corrupt-request', enabled: false, state: { ...state, enabled: false } },
    ]);
    const restarted = setup(storage).control;
    const response = await restarted.fetch(
      new Request(`https://service-control.internal${SERVICE_CONTROL_HISTORY_PATH}`),
    );
    expect(response.status).toBe(503);
    expect(await payload(response)).toEqual({ error: 'SERVICE_CONTROL_HISTORY_INVALID' });
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

  it('allows disabling an expired announcement while rejecting reactivation with its past expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const { control, storage } = setup();
    const expiresAt = '2030-01-01T00:01:00.123Z';
    const mutate = (enabled: boolean, revision: number, requestId: string) =>
      control.fetch(
        new Request(`https://service-control.internal${ADMIN_ANNOUNCEMENT_STATE_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Expired notice',
            enabled,
            expiresAt,
            expectedRevision: revision,
            requestId,
            baseHistory: [],
          }),
        }),
      );
    expect((await mutate(true, 0, 'announcement-expiry-publish')).status).toBe(200);
    vi.setSystemTime(new Date('2030-01-01T00:02:00Z'));
    const disabled = await mutate(false, 1, 'announcement-expiry-disable');
    expect(disabled.status).toBe(200);
    expect(await payload(disabled)).toMatchObject({
      announcementState: {
        revision: 2,
        announcement: { enabled: false, expiresAt },
        history: [{ action: 'disabled' }, { action: 'published' }],
      },
    });
    const rejected = await mutate(true, 2, 'announcement-expiry-reactivate');
    expect(rejected.status).toBe(400);
    expect(await payload(rejected)).toEqual({ error: 'EXPIRES_AT_IN_PAST' });
    const restored = await setup(storage).control.fetch(
      new Request(`https://service-control.internal${ADMIN_ANNOUNCEMENT_STATUS_PATH}`),
    );
    expect(await payload(restored)).toMatchObject({
      announcementState: { revision: 2, announcement: { enabled: false, expiresAt } },
    });
  });

  it.each(['2031-02-29T12:00:00Z', '2032-02-30T12:00:00.001+09:00'])(
    'rejects impossible expiry instants at the durable mutation boundary: %s',
    async (expiresAt) => {
      const { control, storage } = setup();
      const request = new Request(
        `https://service-control.internal${ADMIN_ANNOUNCEMENT_STATE_PATH}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Never publish a normalized date',
            enabled: true,
            expiresAt,
            expectedRevision: 0,
            requestId: 'announcement-impossible-expiry',
            baseHistory: [],
          }),
        },
      );
      const response = await control.fetch(request);
      expect(response.status).toBe(400);
      expect(await payload(response)).toEqual({ error: 'INVALID_REQUEST' });
      expect(storage.data.has('admin-announcement-state')).toBe(false);
    },
  );

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

describe('MusixquareServiceControl app build floor', () => {
  const NOW = Date.parse('2026-10-25T13:00:00.000Z');

  function floorRequest(path: string, init: RequestInit = {}): Request {
    return new Request(`https://service-control.internal${path}`, init);
  }

  function floorMutation(
    minAppBuild: number,
    expectedRevision: number,
    requestId: string,
    extra: Record<string, unknown> = {},
  ): Request {
    return floorRequest(APP_BUILD_FLOOR_STATE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        minAppBuild,
        expectedRevision,
        requestId,
        reason: `test ${requestId}`,
        ...extra,
      }),
    });
  }

  function rawFloorMutation(body: unknown, contentType = 'application/json'): Request {
    return floorRequest(APP_BUILD_FLOOR_STATE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: JSON.stringify(body),
    });
  }

  function liveReport(body: unknown): Request {
    return floorRequest(APP_BUILD_FLOOR_LIVE_REPORT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function floorStatus(control: MusixquareServiceControl): Promise<Record<string, unknown>> {
    const response = await control.fetch(floorRequest(APP_BUILD_FLOOR_STATUS_PATH));
    expect(response.status).toBe(200);
    return (await payload(response)).appBuildFloor as Record<string, unknown>;
  }

  async function floorHistory(control: MusixquareServiceControl): Promise<Record<string, unknown>> {
    const response = await control.fetch(floorRequest(APP_BUILD_FLOOR_HISTORY_PATH));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    return payload(response);
  }

  function headerValues(response: Response): Record<string, string | null> {
    return Object.fromEntries(
      Object.entries(APP_BUILD_FLOOR_STATUS_HEADERS).map(([key, name]) => [
        key,
        response.headers.get(name),
      ]),
    );
  }

  it('starts with the floor off and answers versioned HEAD headers and the same GET JSON', async () => {
    const { control, storage } = setup();
    const head = await control.fetch(floorRequest(APP_BUILD_FLOOR_STATUS_PATH, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(headerValues(head)).toEqual({
      version: '1',
      minAppBuild: '0',
      effectiveMinAppBuild: '0',
      revision: '0',
      updatedAt: 'null',
      liveAppBuild: 'null',
      liveReportedAt: 'null',
      state: 'valid',
    });

    const get = await control.fetch(floorRequest(APP_BUILD_FLOOR_STATUS_PATH));
    expect(get.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(headerValues(get)).toEqual(headerValues(head));
    expect(await payload(get)).toEqual({
      appBuildFloor: {
        minAppBuild: 0,
        effectiveMinAppBuild: 0,
        revision: 0,
        updatedAt: null,
        liveAppBuild: null,
        liveReportedAt: null,
        state: 'valid',
      },
    });
    expect([...storage.data.keys()]).toEqual([]);
  });

  it('refuses a raise without a live App build or above it, and lowers without one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { control, storage } = setup();

    const missingLive = await control.fetch(floorMutation(785, 0, 'raise-without-live'));
    expect(missingLive.status).toBe(409);
    expect(await payload(missingLive)).toMatchObject({
      error: 'APP_BUILD_FLOOR_LIVE_BUILD_REQUIRED',
      appBuildFloor: { minAppBuild: 0, revision: 0 },
    });
    const aboveLive = await control.fetch(
      floorMutation(785, 0, 'raise-above-live', { liveAppBuild: 784 }),
    );
    expect(aboveLive.status).toBe(409);
    expect(await payload(aboveLive)).toMatchObject({
      error: 'APP_BUILD_FLOOR_ABOVE_LIVE',
      appBuildFloor: { minAppBuild: 0, revision: 0 },
    });
    expect([...storage.data.keys()]).toEqual([]);

    const raised = await control.fetch(
      floorMutation(785, 0, 'raise-to-live', { liveAppBuild: 785 }),
    );
    expect(raised.status).toBe(200);
    expect(headerValues(raised)).toMatchObject({
      minAppBuild: '785',
      effectiveMinAppBuild: '785',
      revision: '1',
      liveAppBuild: '785',
      liveReportedAt: String(NOW),
    });
    expect(await payload(raised)).toEqual({
      ok: true,
      changed: true,
      replayed: false,
      appBuildFloor: {
        minAppBuild: 785,
        effectiveMinAppBuild: 785,
        revision: 1,
        updatedAt: NOW,
        liveAppBuild: 785,
        liveReportedAt: NOW,
        state: 'valid',
      },
    });

    vi.advanceTimersByTime(1_000);
    const lowered = await control.fetch(floorMutation(700, 1, 'lower-without-live'));
    expect(lowered.status).toBe(200);
    expect(await payload(lowered)).toMatchObject({
      changed: true,
      appBuildFloor: {
        minAppBuild: 700,
        effectiveMinAppBuild: 700,
        revision: 2,
        updatedAt: NOW + 1_000,
        liveAppBuild: 785,
        liveReportedAt: NOW,
      },
    });
    const off = await control.fetch(floorMutation(0, 2, 'lower-to-off', { liveAppBuild: 1 }));
    expect(await payload(off)).toMatchObject({
      changed: true,
      appBuildFloor: { minAppBuild: 0, effectiveMinAppBuild: 0, revision: 3, liveAppBuild: 785 },
    });

    const restored = setup(storage).control;
    expect(await floorStatus(restored)).toEqual({
      minAppBuild: 0,
      effectiveMinAppBuild: 0,
      revision: 3,
      updatedAt: NOW + 1_000,
      liveAppBuild: 785,
      liveReportedAt: NOW,
      state: 'valid',
    });
  });

  it('bounds the effective floor by a fresh report that never changes the stored floor or history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { control, storage } = setup();
    await control.fetch(floorMutation(785, 0, 'raise-for-report', { liveAppBuild: 785 }));
    const before = {
      state: structuredClone(storage.data.get('app-build-floor-state')),
      requests: structuredClone(storage.data.get('app-build-floor-requests')),
      history: await floorHistory(control),
    };

    vi.advanceTimersByTime(60_000);
    const rolledBack = await control.fetch(liveReport({ appBuild: 784 }));
    expect(rolledBack.status).toBe(200);
    expect(await payload(rolledBack)).toEqual({
      ok: true,
      appBuildFloor: {
        minAppBuild: 785,
        effectiveMinAppBuild: 784,
        revision: 1,
        updatedAt: NOW,
        liveAppBuild: 784,
        liveReportedAt: NOW + 60_000,
        state: 'valid',
      },
    });
    expect(storage.data.get('app-build-floor-live-report')).toEqual({
      appBuild: 784,
      reportedAt: NOW + 60_000,
    });

    vi.advanceTimersByTime(APP_BUILD_FLOOR_REPORT_STALE_MS);
    expect(await floorStatus(control)).toMatchObject({ effectiveMinAppBuild: 784 });
    vi.advanceTimersByTime(1);
    expect(await floorStatus(control)).toMatchObject({
      minAppBuild: 785,
      effectiveMinAppBuild: 0,
      liveAppBuild: 784,
    });

    await control.fetch(liveReport({ appBuild: 790 }));
    expect(await floorStatus(control)).toMatchObject({ effectiveMinAppBuild: 785 });
    expect(storage.data.get('app-build-floor-state')).toEqual(before.state);
    expect(storage.data.get('app-build-floor-requests')).toEqual(before.requests);
    expect(await floorHistory(control)).toEqual(before.history);
    expect(await floorStatus(setup(storage).control)).toMatchObject({
      minAppBuild: 785,
      effectiveMinAppBuild: 785,
      revision: 1,
      liveAppBuild: 790,
    });
  });

  it('replays, refuses reuse, supersedes, conflicts and keeps a no-op revision', async () => {
    const { control } = setup();
    const raised = await control.fetch(
      floorMutation(785, 0, 'floor-request-a', { liveAppBuild: 785 }),
    );
    expect(raised.status).toBe(200);

    for (const expectedRevision of [0, 1]) {
      const replay = await control.fetch(
        floorMutation(785, expectedRevision, 'floor-request-a', { liveAppBuild: 785 }),
      );
      expect(replay.status).toBe(200);
      expect(await payload(replay)).toMatchObject({
        ok: true,
        changed: false,
        replayed: true,
        appBuildFloor: { minAppBuild: 785, revision: 1 },
      });
    }
    const reused = await control.fetch(floorMutation(700, 1, 'floor-request-a'));
    expect(reused.status).toBe(409);
    expect(await payload(reused)).toMatchObject({
      error: 'APP_BUILD_FLOOR_REQUEST_ID_REUSED',
      appBuildFloor: { minAppBuild: 785, revision: 1 },
    });

    expect((await control.fetch(floorMutation(700, 1, 'floor-request-b'))).status).toBe(200);
    const superseded = await control.fetch(
      floorMutation(785, 0, 'floor-request-a', { liveAppBuild: 785 }),
    );
    expect(superseded.status).toBe(409);
    expect(await payload(superseded)).toMatchObject({
      error: 'APP_BUILD_FLOOR_REQUEST_SUPERSEDED',
      appBuildFloor: { minAppBuild: 700, revision: 2 },
    });
    const stale = await control.fetch(floorMutation(600, 1, 'floor-request-c'));
    expect(stale.status).toBe(409);
    expect(await payload(stale)).toMatchObject({
      error: 'APP_BUILD_FLOOR_REVISION_CONFLICT',
      appBuildFloor: { minAppBuild: 700, revision: 2 },
    });

    const historyBefore = await floorHistory(control);
    const noop = await control.fetch(floorMutation(700, 2, 'floor-request-d'));
    expect(noop.status).toBe(200);
    expect(await payload(noop)).toMatchObject({
      ok: true,
      changed: false,
      replayed: false,
      appBuildFloor: { minAppBuild: 700, revision: 2 },
    });
    expect(await floorHistory(control)).toEqual(historyBefore);

    const concurrent = await Promise.all([
      control.fetch(floorMutation(650, 2, 'floor-request-e')),
      control.fetch(floorMutation(640, 2, 'floor-request-f')),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it('rejects malformed floor mutations and reports before any write', async () => {
    const { control, storage } = setup();
    const valid = {
      minAppBuild: 785,
      expectedRevision: 0,
      requestId: 'malformed-floor-request',
      liveAppBuild: 785,
      reason: 'raise after release',
    };
    const malformed: unknown[] = [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, minAppBuild: '785' },
      { ...valid, minAppBuild: -1 },
      { ...valid, minAppBuild: 785.5 },
      { ...valid, minAppBuild: 2_147_483_648 },
      { ...valid, liveAppBuild: '785' },
      { ...valid, liveAppBuild: null },
      { ...valid, expectedRevision: -1 },
      { ...valid, expectedRevision: '0' },
      { ...valid, requestId: 'short' },
      { ...valid, reason: '' },
      { ...valid, reason: 'line\nbreak' },
      { ...valid, reason: 'r'.repeat(201) },
      { ...valid, reason: 7 },
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'reason')),
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'requestId')),
    ];
    for (const body of malformed) {
      const response = await control.fetch(rawFloorMutation(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await payload(response)).toEqual({ error: 'INVALID_REQUEST' });
    }
    for (const body of [{}, { appBuild: '785' }, { appBuild: -1 }, { appBuild: 785, extra: 1 }]) {
      const response = await control.fetch(liveReport(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await payload(response)).toEqual({ error: 'INVALID_REQUEST' });
    }
    expect((await control.fetch(rawFloorMutation(valid, 'text/plain'))).status).toBe(415);
    const oversized = floorRequest(APP_BUILD_FLOOR_STATE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '4097' },
      body: JSON.stringify(valid),
    });
    expect((await control.fetch(oversized)).status).toBe(413);
    const notJson = floorRequest(APP_BUILD_FLOOR_LIVE_REPORT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"appBuild":',
    });
    expect((await control.fetch(notJson)).status).toBe(400);
    for (const [method, path] of [
      ['GET', APP_BUILD_FLOOR_STATE_PATH],
      ['GET', APP_BUILD_FLOOR_LIVE_REPORT_PATH],
      ['POST', APP_BUILD_FLOOR_STATUS_PATH],
      ['POST', APP_BUILD_FLOOR_HISTORY_PATH],
      ['PUT', APP_BUILD_FLOOR_STATE_PATH],
    ] as const) {
      expect((await control.fetch(floorRequest(path, { method }))).status).toBe(404);
    }
    expect((await control.fetch(floorRequest(`${APP_BUILD_FLOOR_STATUS_PATH}?x=1`))).status).toBe(
      404,
    );
    expect([...storage.data.keys()]).toEqual([]);
  });

  it('keeps the floor on the main object only', async () => {
    for (const name of [
      ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME,
      'musixquare-abuse-rate-v1:test',
      'musixquare-abuse-rate-pair-v1:test',
    ]) {
      const { control, storage } = setup(new ServiceControlStorage(), name);
      const responses = await Promise.all([
        control.fetch(floorRequest(APP_BUILD_FLOOR_STATUS_PATH)),
        control.fetch(floorRequest(APP_BUILD_FLOOR_HISTORY_PATH)),
        control.fetch(floorMutation(1, 0, 'isolated-floor-request', { liveAppBuild: 1 })),
        control.fetch(liveReport({ appBuild: 1 })),
      ]);
      expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
      expect(storage.getKeys.some((key) => key.startsWith('app-build-floor'))).toBe(false);
      expect([...storage.data.keys()]).toEqual([]);
    }
  });

  it('lists changes newest first with their reasons and reports truncation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { control, storage } = setup();
    expect(await floorHistory(control)).toEqual({ history: [], truncated: false });

    await control.fetch(floorMutation(785, 0, 'history-raise', { liveAppBuild: 785 }));
    vi.advanceTimersByTime(1_000);
    await control.fetch(floorMutation(785, 1, 'history-noop'));
    await control.fetch(floorMutation(0, 1, 'history-lower'));
    expect(await floorHistory(control)).toEqual({
      history: [
        {
          minAppBuild: 0,
          revision: 2,
          updatedAt: NOW + 1_000,
          reason: 'test history-lower',
          note: null,
        },
        {
          minAppBuild: 785,
          revision: 1,
          updatedAt: NOW,
          reason: 'test history-raise',
          note: null,
        },
      ],
      truncated: false,
    });

    for (let revision = 2; revision < 68; revision += 1) {
      await control.fetch(
        floorMutation(revision % 2 === 0 ? 785 : 0, revision, `history-change-${revision}`, {
          liveAppBuild: 785,
        }),
      );
    }
    const truncated = await floorHistory(control);
    expect(truncated.truncated).toBe(true);
    const rows = truncated.history as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(64);
    expect(rows[0]).toMatchObject({ revision: 68, reason: 'test history-change-67' });
    expect(rows.at(-1)).toMatchObject({ revision: 5 });

    storage.data.delete('app-build-floor-requests');
    expect(await floorHistory(setup(storage).control)).toEqual({
      history: [{ minAppBuild: 0, revision: 68, updatedAt: NOW + 1_000, reason: null, note: null }],
      truncated: true,
    });

    const state = storage.data.get('app-build-floor-state') as Record<string, unknown>;
    storage.data.set('app-build-floor-requests', [
      {
        requestId: 'history-conflicting-row',
        reason: 'conflict',
        note: null,
        state: { ...state, minAppBuild: 785 },
      },
    ]);
    const conflicting = await setup(storage).control.fetch(
      floorRequest(APP_BUILD_FLOOR_HISTORY_PATH),
    );
    expect(conflicting.status).toBe(503);
    expect(await payload(conflicting)).toEqual({ error: 'APP_BUILD_FLOOR_HISTORY_INVALID' });
  });

  it('answers an invalid stored floor as off without touching maintenance and repairs it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const storage = new ServiceControlStorage();
    storage.data.set('app-build-floor-state', { minAppBuild: 'corrupt', revision: 9 });
    storage.data.set('app-build-floor-requests', [
      { requestId: 'corrupt-journal-row', reason: '', note: null, state: {} },
      {
        requestId: 'valid-journal-row',
        reason: 'earlier raise',
        note: null,
        state: { minAppBuild: 785, revision: 4, updatedAt: NOW - 10_000 },
      },
    ]);
    storage.data.set('app-build-floor-live-report', { appBuild: 785, reportedAt: NOW });
    const { control } = setup(storage);

    const maintenance = await control.fetch(
      new Request(`https://service-control.internal${SERVICE_CONTROL_STATUS_PATH}`),
    );
    expect(maintenance.status).toBe(200);
    expect(await payload(maintenance)).toMatchObject({
      serviceStatus: { enabled: false, revision: 0 },
    });
    const head = await control.fetch(floorRequest(APP_BUILD_FLOOR_STATUS_PATH, { method: 'HEAD' }));
    expect(headerValues(head)).toEqual({
      version: '1',
      minAppBuild: '0',
      effectiveMinAppBuild: '0',
      revision: '4',
      updatedAt: 'null',
      liveAppBuild: '785',
      liveReportedAt: String(NOW),
      state: 'invalid',
    });
    expect(await floorHistory(control)).toEqual({
      history: [
        {
          minAppBuild: 785,
          revision: 4,
          updatedAt: NOW - 10_000,
          reason: 'earlier raise',
          note: null,
        },
      ],
      truncated: true,
    });

    const stale = await control.fetch(floorMutation(0, 3, 'repair-stale-revision'));
    expect(stale.status).toBe(409);
    expect(await payload(stale)).toMatchObject({
      error: 'APP_BUILD_FLOOR_REVISION_CONFLICT',
      appBuildFloor: { revision: 4, state: 'invalid' },
    });
    const raiseWithoutLive = await control.fetch(floorMutation(785, 4, 'repair-raise-no-live'));
    expect(raiseWithoutLive.status).toBe(409);
    expect(await payload(raiseWithoutLive)).toMatchObject({
      error: 'APP_BUILD_FLOOR_LIVE_BUILD_REQUIRED',
    });

    const repaired = await control.fetch(floorMutation(0, 4, 'repair-invalid-floor'));
    expect(repaired.status).toBe(200);
    expect(await payload(repaired)).toMatchObject({
      ok: true,
      changed: true,
      appBuildFloor: {
        minAppBuild: 0,
        effectiveMinAppBuild: 0,
        revision: 5,
        updatedAt: NOW,
        state: 'valid',
      },
    });
    expect(storage.data.get('app-build-floor-state')).toEqual({
      minAppBuild: 0,
      revision: 5,
      updatedAt: NOW,
    });
    const history = (await floorHistory(control)).history as Array<Record<string, unknown>>;
    expect(history[0]).toEqual({
      minAppBuild: 0,
      revision: 5,
      updatedAt: NOW,
      reason: 'test repair-invalid-floor',
      note: 'repaired-invalid-state',
    });
  });

  it('reads an invalid stored state with an unusable journal as revision zero', async () => {
    const storage = new ServiceControlStorage();
    storage.data.set('app-build-floor-state', 'not-a-state');
    storage.data.set('app-build-floor-requests', { not: 'a journal' });
    const { control } = setup(storage);
    expect(await floorStatus(control)).toMatchObject({
      minAppBuild: 0,
      effectiveMinAppBuild: 0,
      revision: 0,
      state: 'invalid',
    });
    expect((await control.fetch(floorMutation(0, 0, 'repair-from-zero'))).status).toBe(200);
    expect(await floorStatus(control)).toMatchObject({ revision: 1, state: 'valid' });
  });

  it('skips malformed journal rows and loads at most the newest retained changes', async () => {
    const storage = new ServiceControlStorage();
    const row = (revision: number, extra: Record<string, unknown> = {}) => ({
      requestId: `journal-row-${String(revision).padStart(3, '0')}`,
      reason: `change ${revision}`,
      note: null,
      state: { minAppBuild: revision, revision, updatedAt: NOW + revision },
      ...extra,
    });
    storage.data.set('app-build-floor-state', {
      minAppBuild: 70,
      revision: 70,
      updatedAt: NOW + 70,
    });
    storage.data.set('app-build-floor-requests', [
      { requestId: 'journal-row-missing-note', reason: 'x', state: row(70).state },
      row(70, { note: 'unknown-note' }),
      row(70, { requestId: 'short' }),
      row(70, { state: { minAppBuild: 0, revision: 0, updatedAt: null } }),
      ...Array.from({ length: 66 }, (_, index) => row(70 - index)),
    ]);
    const { control } = setup(storage);
    const history = await floorHistory(control);
    const rows = history.history as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(64);
    expect(rows[0]).toEqual({
      minAppBuild: 70,
      revision: 70,
      updatedAt: NOW + 70,
      reason: 'change 70',
      note: null,
    });
    expect(rows.at(-1)).toMatchObject({ revision: 7, reason: 'change 7' });
    // The 65th retained row is beyond the journal limit, so its id no longer replays.
    const beyond = await control.fetch(floorMutation(6, 70, 'journal-row-006'));
    expect(await payload(beyond)).toMatchObject({ changed: true, replayed: false });
  });

  it('accepts an explicit initial record and refuses a body without a content type', async () => {
    const storage = new ServiceControlStorage();
    storage.data.set('app-build-floor-state', { minAppBuild: 0, revision: 0, updatedAt: null });
    const { control } = setup(storage);
    expect(await floorStatus(control)).toMatchObject({ revision: 0, state: 'valid' });
    const untyped = floorRequest(APP_BUILD_FLOOR_STATE_PATH, {
      method: 'POST',
      body: new Uint8Array(new TextEncoder().encode('{}')),
    });
    const response = await control.fetch(untyped);
    expect(response.status).toBe(415);
    expect(await payload(response)).toEqual({ error: 'JSON_REQUIRED' });
  });

  it('treats an invalid stored report as absent until the next report replaces it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const storage = new ServiceControlStorage();
    storage.data.set('app-build-floor-state', {
      minAppBuild: 785,
      revision: 1,
      updatedAt: NOW - 1_000,
    });
    storage.data.set('app-build-floor-live-report', { appBuild: 785, reportedAt: 'now' });
    const { control } = setup(storage);
    expect(await floorStatus(control)).toMatchObject({
      minAppBuild: 785,
      effectiveMinAppBuild: 0,
      liveAppBuild: null,
      liveReportedAt: null,
      state: 'valid',
    });
    await control.fetch(liveReport({ appBuild: 785 }));
    expect(await floorStatus(control)).toMatchObject({
      effectiveMinAppBuild: 785,
      liveAppBuild: 785,
      liveReportedAt: NOW,
    });
  });

  it('rejects stored floor records that break their revision invariants', async () => {
    for (const stored of [
      { minAppBuild: 785, revision: 0, updatedAt: null },
      { minAppBuild: 0, revision: 0, updatedAt: NOW },
      { minAppBuild: 785, revision: 2, updatedAt: null },
      { minAppBuild: 785, revision: 2, updatedAt: NOW, extra: true },
      { minAppBuild: 785, revision: -1, updatedAt: NOW },
    ]) {
      const storage = new ServiceControlStorage();
      storage.data.set('app-build-floor-state', stored);
      expect(await floorStatus(setup(storage).control), JSON.stringify(stored)).toMatchObject({
        minAppBuild: 0,
        effectiveMinAppBuild: 0,
        state: 'invalid',
      });
    }
  });
});

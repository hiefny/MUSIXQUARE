import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_ANNOUNCEMENT_STATE_PATH,
  ADMIN_ANNOUNCEMENT_STATUS_PATH,
  SERVICE_CONTROL_READ_TIMEOUT_MS,
  SERVICE_CONTROL_STATE_PATH,
  SERVICE_CONTROL_STATUS_PATH,
  clearServiceMaintenanceCacheForTests,
  consumeAbuseRateLimit,
  gateServiceMaintenance,
  inactiveServiceMaintenanceState,
  normalizeServiceMaintenanceState,
  readAdminAnnouncementControl,
  readServiceMaintenance,
  serviceMaintenanceResponse,
  updateServiceMaintenance,
  updateAdminAnnouncementControl,
  type ServiceMaintenanceState,
} from '../../../cloudflare/service-maintenance.js';

function activeState(overrides: Partial<ServiceMaintenanceState> = {}): ServiceMaintenanceState {
  return {
    enabled: true,
    revision: 4,
    updatedAt: 1_800_000_000_000,
    activatedAt: 1_799_999_999_000,
    settlesAt: 1_800_000_002_000,
    ...overrides,
  };
}

function announcementControlPayload(revision: number) {
  if (revision === 0) {
    return {
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
    };
  }
  const updatedAt = new Date(Date.UTC(2026, 0, revision)).toISOString();
  const announcement = {
    id: `announcement-${revision}`,
    message: `Revision ${revision}`,
    enabled: true,
    expiresAt: null,
    updatedAt,
  };
  return {
    announcementState: {
      revision,
      announcement,
      history: [{ ...announcement, action: 'published' }],
    },
  };
}

function serviceControlEnv(
  handler: (request: Request) => Response | Promise<Response>,
  options: { legacyNamespace?: boolean } = {},
): { env: Record<string, unknown>; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(handler);
  const stub = { fetch };
  const namespace = options.legacyNamespace
    ? {
        idFromName: vi.fn((name: string) => `id:${name}`),
        get: vi.fn(() => stub),
      }
    : { getByName: vi.fn(() => stub) };
  return { env: { MUSIXQUARE_SERVICE_CONTROL: namespace }, fetch };
}

afterEach(() => {
  clearServiceMaintenanceCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared service-maintenance control', () => {
  it('accepts base64url rate identities that begin with URL-safe punctuation', async () => {
    const fetch = vi.fn(() =>
      Response.json({
        allowed: true,
        limit: 4,
        remaining: 3,
        resetAtMs: 1_800_000_060_000,
        retryAfterSeconds: 0,
      }),
    );
    const getByName = vi.fn(() => ({ fetch }));

    await expect(
      consumeAbuseRateLimit(
        { MUSIXQUARE_SERVICE_CONTROL: { getByName } },
        { scope: 'app-turn-capability', identity: '_base64url', limit: 4, windowMs: 60_000 },
      ),
    ).resolves.toMatchObject({ status: 'ok', allowed: true, remaining: 3 });
    expect(getByName).toHaveBeenCalledWith(
      'musixquare-abuse-rate-v1:app-turn-capability:_base64url',
    );
  });

  it('keeps an intentionally unbound local environment operational but observable', async () => {
    expect(inactiveServiceMaintenanceState()).toEqual({
      enabled: false,
      revision: 0,
      updatedAt: null,
      activatedAt: null,
      settlesAt: null,
      controlUnavailable: true,
    });
    await expect(readServiceMaintenance({})).resolves.toEqual(inactiveServiceMaintenanceState());
    await expect(
      gateServiceMaintenance(new Request('https://musixquare.com/api/security-config'), {}),
    ).resolves.toBeNull();
  });

  it('normalizes only complete canonical control states', () => {
    expect(
      normalizeServiceMaintenanceState({
        enabled: true,
        revision: 8,
        updatedAt: 1_800_000_000_000,
        activatedAt: 1_799_999_999_000,
      }),
    ).toEqual({
      enabled: true,
      revision: 8,
      updatedAt: 1_800_000_000_000,
      activatedAt: 1_799_999_999_000,
      settlesAt: 1_800_000_002_000,
    });
    expect(normalizeServiceMaintenanceState({ enabled: true, revision: 1 })).toBeNull();
    expect(normalizeServiceMaintenanceState({ enabled: false, revision: -1 })).toBeNull();
    expect(normalizeServiceMaintenanceState(null)).toBeNull();
  });

  it('deduplicates and caches ordinary reads while fresh reads bypass the cache', async () => {
    const first = activeState();
    const second = activeState({ revision: 5, updatedAt: 1_800_000_001_000 });
    const control = serviceControlEnv((request) => {
      expect(new URL(request.url).pathname).toBe(SERVICE_CONTROL_STATUS_PATH);
      return Response.json({
        serviceStatus: control.fetch.mock.calls.length === 1 ? first : second,
      });
    });

    const [left, right] = await Promise.all([
      readServiceMaintenance(control.env),
      readServiceMaintenance(control.env),
    ]);
    expect(left.revision).toBe(4);
    expect(right.revision).toBe(4);
    expect(control.fetch).toHaveBeenCalledTimes(1);

    expect((await readServiceMaintenance(control.env)).revision).toBe(4);
    expect(control.fetch).toHaveBeenCalledTimes(1);
    expect((await readServiceMaintenance(control.env, { fresh: true })).revision).toBe(5);
    expect(control.fetch).toHaveBeenCalledTimes(2);
  });

  it('never lets an older status read reopen maintenance after a mutation', async () => {
    const oldState = activeState({
      enabled: false,
      revision: 1,
      updatedAt: 1_800_000_000_000,
      activatedAt: null,
    });
    const enabledState = activeState({
      enabled: true,
      revision: 2,
      updatedAt: 1_800_000_001_000,
      activatedAt: 1_800_000_001_000,
      settlesAt: 1_800_000_003_000,
    });
    let oldBody!: ReadableStreamDefaultController<Uint8Array>;
    const control = serviceControlEnv((request) => {
      const path = new URL(request.url).pathname;
      if (path === SERVICE_CONTROL_STATE_PATH) {
        return Response.json({ serviceStatus: enabledState });
      }
      expect(path).toBe(SERVICE_CONTROL_STATUS_PATH);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            oldBody = controller;
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const oldRead = readServiceMaintenance(control.env, { fresh: true });
    await vi.waitFor(() => expect(control.fetch).toHaveBeenCalledTimes(1));
    await expect(
      updateServiceMaintenance(control.env, {
        enabled: true,
        expectedRevision: 1,
        requestId: 'maintenance-generation-fence',
      }),
    ).resolves.toEqual({ status: 'ok', state: enabledState });

    oldBody.enqueue(new TextEncoder().encode(JSON.stringify({ serviceStatus: oldState })));
    oldBody.close();

    await expect(oldRead).resolves.toEqual(enabledState);
    await expect(readServiceMaintenance(control.env)).resolves.toEqual(enabledState);
    expect(control.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest-started maintenance mutation in cache when responses finish out of order', async () => {
    const enabledState = activeState({
      enabled: true,
      revision: 2,
      updatedAt: 1_800_000_001_000,
      activatedAt: 1_800_000_001_000,
      settlesAt: 1_800_000_003_000,
    });
    const disabledState = activeState({
      enabled: false,
      revision: 3,
      updatedAt: 1_800_000_002_000,
      activatedAt: null,
      settlesAt: 1_800_000_004_000,
    });
    let firstBody!: ReadableStreamDefaultController<Uint8Array>;
    let mutations = 0;
    const control = serviceControlEnv((request) => {
      expect(new URL(request.url).pathname).toBe(SERVICE_CONTROL_STATE_PATH);
      mutations += 1;
      if (mutations > 1) return Response.json({ serviceStatus: disabledState });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            firstBody = controller;
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const first = updateServiceMaintenance(control.env, {
      enabled: true,
      expectedRevision: 1,
      requestId: 'maintenance-out-of-order-first',
    });
    await vi.waitFor(() => expect(control.fetch).toHaveBeenCalledTimes(1));
    await expect(
      updateServiceMaintenance(control.env, {
        enabled: false,
        expectedRevision: 2,
        requestId: 'maintenance-out-of-order-second',
      }),
    ).resolves.toEqual({ status: 'ok', state: disabledState });

    firstBody.enqueue(new TextEncoder().encode(JSON.stringify({ serviceStatus: enabledState })));
    firstBody.close();
    await expect(first).resolves.toEqual({ status: 'ok', state: enabledState });
    await expect(readServiceMaintenance(control.env)).resolves.toEqual(disabledState);
    expect(control.fetch).toHaveBeenCalledTimes(2);
  });

  it('promotes a superseded maintenance response only when it carries a higher canonical revision', async () => {
    const revisionTwo = activeState({
      enabled: false,
      revision: 2,
      updatedAt: 1_800_000_001_000,
      activatedAt: null,
      settlesAt: 1_800_000_003_000,
    });
    const revisionThree = activeState({
      enabled: true,
      revision: 3,
      updatedAt: 1_800_000_002_000,
      activatedAt: 1_800_000_002_000,
      settlesAt: 1_800_000_004_000,
    });
    let firstBody!: ReadableStreamDefaultController<Uint8Array>;
    let mutations = 0;
    const control = serviceControlEnv((request) => {
      expect(new URL(request.url).pathname).toBe(SERVICE_CONTROL_STATE_PATH);
      mutations += 1;
      if (mutations > 1) return Response.json({ serviceStatus: revisionTwo });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            firstBody = controller;
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const first = updateServiceMaintenance(control.env, {
      enabled: true,
      expectedRevision: 1,
      requestId: 'maintenance-higher-revision-first',
    });
    await vi.waitFor(() => expect(control.fetch).toHaveBeenCalledTimes(1));
    await expect(
      updateServiceMaintenance(control.env, {
        enabled: false,
        expectedRevision: 1,
        requestId: 'maintenance-higher-revision-second',
      }),
    ).resolves.toEqual({ status: 'ok', state: revisionTwo });

    firstBody.enqueue(new TextEncoder().encode(JSON.stringify({ serviceStatus: revisionThree })));
    firstBody.close();
    await expect(first).resolves.toEqual({ status: 'conflict', state: revisionThree });
    await expect(readServiceMaintenance(control.env)).resolves.toEqual(revisionThree);
    expect(control.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps maintenance fail-closed when the newest mutation is unavailable', async () => {
    const revisionThree = activeState({
      enabled: false,
      revision: 3,
      updatedAt: 1_800_000_002_000,
      activatedAt: null,
      settlesAt: 1_800_000_004_000,
    });
    let firstBody!: ReadableStreamDefaultController<Uint8Array>;
    let mutations = 0;
    const control = serviceControlEnv((request) => {
      expect(new URL(request.url).pathname).toBe(SERVICE_CONTROL_STATE_PATH);
      mutations += 1;
      if (mutations > 1) return Response.json({ error: 'CONTROL_UNAVAILABLE' }, { status: 503 });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            firstBody = controller;
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const first = updateServiceMaintenance(control.env, {
      enabled: false,
      expectedRevision: 1,
      requestId: 'maintenance-unavailable-first',
    });
    await vi.waitFor(() => expect(control.fetch).toHaveBeenCalledTimes(1));
    await expect(
      updateServiceMaintenance(control.env, {
        enabled: true,
        expectedRevision: 2,
        requestId: 'maintenance-unavailable-second',
      }),
    ).resolves.toMatchObject({ status: 'unavailable', state: { controlUnavailable: true } });

    firstBody.enqueue(new TextEncoder().encode(JSON.stringify({ serviceStatus: revisionThree })));
    firstBody.close();
    await expect(first).resolves.toEqual({ status: 'conflict', state: revisionThree });
    await expect(readServiceMaintenance(control.env)).resolves.toMatchObject({
      enabled: true,
      controlUnavailable: true,
    });
    expect(control.fetch).toHaveBeenCalledTimes(2);
  });

  it('supports the idFromName namespace shape and fails closed on bound RPC failure', async () => {
    const healthy = serviceControlEnv(() => Response.json({ serviceStatus: activeState() }), {
      legacyNamespace: true,
    });
    await expect(readServiceMaintenance(healthy.env)).resolves.toMatchObject({
      enabled: true,
      revision: 4,
    });

    const failing = serviceControlEnv(() => Promise.reject(new Error('control unavailable')));
    await expect(readServiceMaintenance(failing.env)).resolves.toEqual({
      enabled: true,
      revision: 0,
      updatedAt: null,
      activatedAt: null,
      settlesAt: null,
      controlUnavailable: true,
    });
  });

  it('coalesces and caches announcement reads while fresh reads bypass the cache', async () => {
    let statusReads = 0;
    const control = serviceControlEnv(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === ADMIN_ANNOUNCEMENT_STATE_PATH) {
        expect(request.method).toBe('POST');
        expect(await request.json()).toMatchObject({
          message: 'Updated notice',
          expectedRevision: 2,
          requestId: 'announcement-request-1',
        });
        return Response.json(announcementControlPayload(3));
      }
      expect(url.pathname).toBe(ADMIN_ANNOUNCEMENT_STATUS_PATH);
      statusReads += 1;
      return Response.json(announcementControlPayload(statusReads));
    });

    const [left, right] = await Promise.all([
      readAdminAnnouncementControl(control.env),
      readAdminAnnouncementControl(control.env),
    ]);
    expect(left).toEqual({ status: 'ok', payload: announcementControlPayload(1) });
    expect(right).toEqual(left);
    expect(statusReads).toBe(1);
    expect(control.fetch).toHaveBeenCalledTimes(1);

    await expect(readAdminAnnouncementControl(control.env)).resolves.toEqual(left);
    expect(control.fetch).toHaveBeenCalledTimes(1);
    await expect(readAdminAnnouncementControl(control.env, { fresh: true })).resolves.toEqual({
      status: 'ok',
      payload: announcementControlPayload(2),
    });
    expect(statusReads).toBe(2);

    await expect(
      updateAdminAnnouncementControl(control.env, {
        message: 'Updated notice',
        enabled: true,
        expiresAt: null,
        expectedRevision: 2,
        requestId: 'announcement-request-1',
        baseHistory: [],
      }),
    ).resolves.toEqual({
      status: 'ok',
      payload: announcementControlPayload(3),
    });
    await expect(readAdminAnnouncementControl(control.env)).resolves.toEqual({
      status: 'ok',
      payload: announcementControlPayload(3),
    });
    expect(control.fetch).toHaveBeenCalledTimes(3);
  });

  it('negative-caches a malformed high-revision announcement without poisoning later state', async () => {
    vi.useFakeTimers();
    const malformed = {
      announcementState: { revision: 999, announcement: null, history: [] },
    };
    let reads = 0;
    const control = serviceControlEnv(() => {
      reads += 1;
      return Response.json(reads === 1 ? malformed : announcementControlPayload(1));
    });

    await expect(readAdminAnnouncementControl(control.env)).resolves.toEqual({
      status: 'unavailable',
      payload: malformed,
    });
    await expect(readAdminAnnouncementControl(control.env)).resolves.toEqual({
      status: 'unavailable',
      payload: malformed,
    });
    expect(control.fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(readAdminAnnouncementControl(control.env)).resolves.toEqual({
      status: 'ok',
      payload: announcementControlPayload(1),
    });
    await expect(readAdminAnnouncementControl(control.env)).resolves.toEqual({
      status: 'ok',
      payload: announcementControlPayload(1),
    });
    expect(control.fetch).toHaveBeenCalledTimes(2);
  });

  it('starts a new fresh announcement read after a mutation generation change', async () => {
    const revisionOne = announcementControlPayload(1);
    const revisionTwo = announcementControlPayload(2);
    let oldBody!: ReadableStreamDefaultController<Uint8Array>;
    let statusReads = 0;
    const control = serviceControlEnv((request) => {
      const path = new URL(request.url).pathname;
      if (path === ADMIN_ANNOUNCEMENT_STATE_PATH) return Response.json(revisionTwo);
      expect(path).toBe(ADMIN_ANNOUNCEMENT_STATUS_PATH);
      statusReads += 1;
      if (statusReads > 1) return Response.json(revisionTwo);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            oldBody = controller;
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const oldRead = readAdminAnnouncementControl(control.env, { fresh: true });
    await vi.waitFor(() => expect(control.fetch).toHaveBeenCalledTimes(1));
    await expect(
      updateAdminAnnouncementControl(control.env, {
        message: 'Revision two',
        enabled: true,
        expiresAt: null,
        expectedRevision: 1,
        requestId: 'announcement-generation-fence',
        baseHistory: [],
      }),
    ).resolves.toEqual({ status: 'ok', payload: revisionTwo });

    const freshRead = readAdminAnnouncementControl(control.env, { fresh: true });
    await expect(freshRead).resolves.toEqual({ status: 'ok', payload: revisionTwo });
    expect(statusReads).toBe(2);

    oldBody.enqueue(new TextEncoder().encode(JSON.stringify(revisionOne)));
    oldBody.close();
    await expect(oldRead).resolves.toEqual({ status: 'ok', payload: revisionTwo });
    expect(control.fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps the newest-started announcement mutation when responses finish out of order', async () => {
    const revisionTwo = announcementControlPayload(2);
    const revisionThree = announcementControlPayload(3);
    let firstBody!: ReadableStreamDefaultController<Uint8Array>;
    let mutations = 0;
    const control = serviceControlEnv((request) => {
      expect(new URL(request.url).pathname).toBe(ADMIN_ANNOUNCEMENT_STATE_PATH);
      mutations += 1;
      if (mutations > 1) return Response.json(revisionThree);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            firstBody = controller;
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const first = updateAdminAnnouncementControl(control.env, {
      message: 'Revision two',
      enabled: true,
      expiresAt: null,
      expectedRevision: 1,
      requestId: 'announcement-out-of-order-first',
      baseHistory: [],
    });
    await vi.waitFor(() => expect(control.fetch).toHaveBeenCalledTimes(1));
    await expect(
      updateAdminAnnouncementControl(control.env, {
        message: 'Revision three',
        enabled: false,
        expiresAt: null,
        expectedRevision: 2,
        requestId: 'announcement-out-of-order-second',
        baseHistory: [],
      }),
    ).resolves.toEqual({ status: 'ok', payload: revisionThree });

    firstBody.enqueue(new TextEncoder().encode(JSON.stringify(revisionTwo)));
    firstBody.close();
    await expect(first).resolves.toEqual({ status: 'ok', payload: revisionTwo });
    await expect(readAdminAnnouncementControl(control.env)).resolves.toEqual({
      status: 'ok',
      payload: revisionThree,
    });
    expect(control.fetch).toHaveBeenCalledTimes(2);
  });

  it('promotes a superseded announcement response only when it carries a higher revision', async () => {
    const revisionTwo = announcementControlPayload(2);
    const revisionThree = announcementControlPayload(3);
    let firstBody!: ReadableStreamDefaultController<Uint8Array>;
    let mutations = 0;
    const control = serviceControlEnv((request) => {
      expect(new URL(request.url).pathname).toBe(ADMIN_ANNOUNCEMENT_STATE_PATH);
      mutations += 1;
      if (mutations > 1) return Response.json(revisionTwo);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            firstBody = controller;
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const first = updateAdminAnnouncementControl(control.env, {
      message: 'Revision three elsewhere',
      enabled: true,
      expiresAt: null,
      expectedRevision: 1,
      requestId: 'announcement-higher-revision-first',
      baseHistory: [],
    });
    await vi.waitFor(() => expect(control.fetch).toHaveBeenCalledTimes(1));
    await expect(
      updateAdminAnnouncementControl(control.env, {
        message: 'Revision two here',
        enabled: false,
        expiresAt: null,
        expectedRevision: 1,
        requestId: 'announcement-higher-revision-second',
        baseHistory: [],
      }),
    ).resolves.toEqual({ status: 'ok', payload: revisionTwo });

    firstBody.enqueue(new TextEncoder().encode(JSON.stringify(revisionThree)));
    firstBody.close();
    await expect(first).resolves.toEqual({ status: 'conflict', payload: revisionThree });
    await expect(readAdminAnnouncementControl(control.env)).resolves.toEqual({
      status: 'ok',
      payload: revisionThree,
    });
    expect(control.fetch).toHaveBeenCalledTimes(2);
  });

  it('forces a fresh announcement read when the newest mutation is unavailable', async () => {
    const revisionThree = announcementControlPayload(3);
    const revisionFour = announcementControlPayload(4);
    let firstBody!: ReadableStreamDefaultController<Uint8Array>;
    let mutations = 0;
    const control = serviceControlEnv((request) => {
      const path = new URL(request.url).pathname;
      if (path === ADMIN_ANNOUNCEMENT_STATUS_PATH) return Response.json(revisionFour);
      expect(path).toBe(ADMIN_ANNOUNCEMENT_STATE_PATH);
      mutations += 1;
      if (mutations > 1) return Response.json({ error: 'CONTROL_UNAVAILABLE' }, { status: 503 });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            firstBody = controller;
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const first = updateAdminAnnouncementControl(control.env, {
      message: 'Revision three elsewhere',
      enabled: true,
      expiresAt: null,
      expectedRevision: 1,
      requestId: 'announcement-unavailable-first',
      baseHistory: [],
    });
    await vi.waitFor(() => expect(control.fetch).toHaveBeenCalledTimes(1));
    await expect(
      updateAdminAnnouncementControl(control.env, {
        message: 'Unknown latest outcome',
        enabled: false,
        expiresAt: null,
        expectedRevision: 2,
        requestId: 'announcement-unavailable-second',
        baseHistory: [],
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      payload: { error: 'CONTROL_UNAVAILABLE' },
    });

    firstBody.enqueue(new TextEncoder().encode(JSON.stringify(revisionThree)));
    firstBody.close();
    await expect(first).resolves.toEqual({ status: 'conflict', payload: revisionThree });
    await expect(readAdminAnnouncementControl(control.env)).resolves.toEqual({
      status: 'ok',
      payload: revisionFour,
    });
    expect(control.fetch).toHaveBeenCalledTimes(3);
  });

  it('bounds an announcement control stall and consumes a later rejection', async () => {
    vi.useFakeTimers();
    let rejectControl!: (error: Error) => void;
    const control = serviceControlEnv(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectControl = reject;
        }),
    );
    let settled = false;
    const read = readAdminAnnouncementControl(control.env, { fresh: true }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(SERVICE_CONTROL_READ_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).resolves.toEqual({ status: 'unavailable', payload: null });

    rejectControl(new Error('late announcement control failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(control.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a response whose announcement JSON body never finishes', async () => {
    vi.useFakeTimers();
    let bodyCancelled = false;
    const control = serviceControlEnv(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"announcementState":'));
            },
            cancel() {
              bodyCancelled = true;
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const read = readAdminAnnouncementControl(control.env, { fresh: true });

    await vi.advanceTimersByTimeAsync(SERVICE_CONTROL_READ_TIMEOUT_MS);
    await expect(read).resolves.toEqual({ status: 'unavailable', payload: null });
    expect(bodyCancelled).toBe(true);
    expect(control.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a control response that arrives only after its deadline', async () => {
    vi.useFakeTimers();
    let resolveControl!: (response: Response) => void;
    let bodyCancelled = false;
    const control = serviceControlEnv(
      () =>
        new Promise<Response>((resolve) => {
          resolveControl = resolve;
        }),
    );
    const read = readAdminAnnouncementControl(control.env, { fresh: true });
    await vi.advanceTimersByTimeAsync(SERVICE_CONTROL_READ_TIMEOUT_MS);
    await expect(read).resolves.toEqual({ status: 'unavailable', payload: null });

    resolveControl(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{}'));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(bodyCancelled).toBe(true);
  });

  it('briefly negative-caches an unavailable announcement control', async () => {
    const control = serviceControlEnv(() =>
      Response.json({ error: 'ADMIN_ANNOUNCEMENT_STATE_INVALID' }, { status: 503 }),
    );

    await expect(readAdminAnnouncementControl(control.env)).resolves.toEqual({
      status: 'unavailable',
      payload: { error: 'ADMIN_ANNOUNCEMENT_STATE_INVALID' },
    });
    await expect(readAdminAnnouncementControl(control.env)).resolves.toEqual({
      status: 'unavailable',
      payload: { error: 'ADMIN_ANNOUNCEMENT_STATE_INVALID' },
    });
    expect(control.fetch).toHaveBeenCalledTimes(1);

    await readAdminAnnouncementControl(control.env, { fresh: true });
    expect(control.fetch).toHaveBeenCalledTimes(2);
  });

  it('accepts the maximum canonical announcement history payload within the cap', async () => {
    const history = Array.from({ length: 100 }, (_, index) => ({
      id: `history-${index}`,
      message: '\u0000'.repeat(280),
      enabled: true,
      expiresAt: null,
      updatedAt: '2026-08-08T00:00:00.000Z',
      action: 'published',
    }));
    const responsePayload = {
      announcementState: {
        revision: 100,
        announcement: history[0],
        history,
      },
    };
    expect(new TextEncoder().encode(JSON.stringify(responsePayload)).byteLength).toBeGreaterThan(
      64 * 1024,
    );
    const control = serviceControlEnv(() => Response.json(responsePayload));

    await expect(readAdminAnnouncementControl(control.env, { fresh: true })).resolves.toEqual({
      status: 'ok',
      payload: responsePayload,
    });
  });

  it('rejects malformed UTF-8 in a service-control response', async () => {
    const prefix = new TextEncoder().encode('{"value":"');
    const suffix = new TextEncoder().encode('"}');
    const bytes = new Uint8Array(prefix.byteLength + 2 + suffix.byteLength);
    bytes.set(prefix, 0);
    bytes.set([0xc3, 0x28], prefix.byteLength);
    bytes.set(suffix, prefix.byteLength + 2);
    const control = serviceControlEnv(
      () => new Response(bytes, { headers: { 'Content-Type': 'application/json' } }),
    );

    await expect(readAdminAnnouncementControl(control.env, { fresh: true })).resolves.toEqual({
      status: 'unavailable',
      payload: null,
    });
  });

  it('fails closed within a bounded interval when the control read never settles', async () => {
    vi.useFakeTimers();
    const control = serviceControlEnv(() => new Promise<Response>(() => {}));
    let settled = false;
    const read = readServiceMaintenance(control.env).then((state) => {
      settled = true;
      return state;
    });

    await vi.advanceTimersByTimeAsync(SERVICE_CONTROL_READ_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(read).resolves.toEqual({
      enabled: true,
      revision: 0,
      updatedAt: null,
      activatedAt: null,
      settlesAt: null,
      controlUnavailable: true,
    });
    expect(control.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('consumes a late control rejection after timeout and clears the deadline timer', async () => {
    vi.useFakeTimers();
    let rejectControl!: (error: Error) => void;
    const control = serviceControlEnv(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectControl = reject;
        }),
    );

    const read = readServiceMaintenance(control.env);
    await vi.advanceTimersByTimeAsync(SERVICE_CONTROL_READ_TIMEOUT_MS);
    await expect(read).resolves.toMatchObject({ enabled: true, controlUnavailable: true });

    rejectControl(new Error('late control failure'));
    await Promise.resolve();
    await Promise.resolve();

    await expect(readServiceMaintenance(control.env)).resolves.toMatchObject({
      enabled: true,
      controlUnavailable: true,
    });
    expect(control.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards a bounded desired-state update and records successful and conflicting read-back', async () => {
    const current = activeState({ revision: 9 });
    const control = serviceControlEnv(async (request) => {
      expect(new URL(request.url).pathname).toBe(SERVICE_CONTROL_STATE_PATH);
      expect(request.method).toBe('POST');
      expect(request.headers.get('Content-Type')).toBe('application/json');
      expect(await request.json()).toEqual({
        enabled: true,
        expectedRevision: 8,
        requestId: 'maintenance-request-1',
      });
      return Response.json({ serviceStatus: current });
    });

    await expect(
      updateServiceMaintenance(control.env, {
        enabled: true,
        expectedRevision: 8,
        requestId: 'maintenance-request-1',
      }),
    ).resolves.toEqual({ status: 'ok', state: current });
    expect((await readServiceMaintenance(control.env)).revision).toBe(9);
    expect(control.fetch).toHaveBeenCalledTimes(1);

    clearServiceMaintenanceCacheForTests();
    const conflict = serviceControlEnv(() =>
      Response.json({ serviceStatus: current }, { status: 409 }),
    );
    await expect(
      updateServiceMaintenance(conflict.env, {
        enabled: false,
        expectedRevision: 8,
        requestId: 'maintenance-request-2',
      }),
    ).resolves.toEqual({ status: 'conflict', state: current });
  });

  it('returns the exact no-store JSON maintenance contract for APIs', async () => {
    const request = new Request('https://musixquare.com/api/security-config', {
      headers: { Accept: 'application/json', 'Accept-Language': 'en-US' },
    });
    const response = serviceMaintenanceResponse(request, activeState(), { format: 'json' });

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(response.headers.get('Content-Language')).toBe('en');
    expect(response.headers.get('Vary')).toBe('Accept-Language');
    await expect(response.json()).resolves.toEqual({
      error: 'SERVICE_MAINTENANCE',
      maintenance: true,
      revision: 4,
      activatedAt: 1_799_999_999_000,
      settlesAt: 1_800_000_002_000,
    });
  });

  it('renders one fixed English line plus the weighted supported system language', async () => {
    const request = new Request('https://musixquare.com/000002', {
      headers: {
        Accept: 'text/html',
        'Accept-Language': 'fr-FR;q=0.4, ko-KR;q=0.9, en;q=0.7',
      },
    });
    const response = serviceMaintenanceResponse(request, activeState());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Content-Language')).toBe('ko');
    expect(body).toContain('<html lang="ko">');
    expect(body).toContain('<title lang="en">MUSIXQUARE · Service check</title>');
    expect(body).toContain('<h1 lang="en">Musixquare is temporarily unavailable.</h1>');
    expect(body).toContain('안전한 서비스 점검을 진행 중이에요. 잠시 후 다시 시도해 주세요.');
  });

  it('maps every regional Portuguese preference to the supported Brazilian copy', async () => {
    const response = serviceMaintenanceResponse(
      new Request('https://musixquare.com/', {
        headers: { Accept: 'text/html', 'Accept-Language': 'pt-PT' },
      }),
      activeState(),
    );
    const body = await response.text();

    expect(response.headers.get('Content-Language')).toBe('pt-br');
    expect(body).toContain('<html lang="pt-br">');
    expect(body).toContain('Estamos verificando o serviço. Tente novamente em instantes.');
  });

  it('falls back to English for English, unsupported, wildcard, and missing language headers', () => {
    for (const language of ['en-GB', 'ar-SA', '*', '']) {
      const headers = new Headers({ Accept: 'text/html' });
      if (language) headers.set('Accept-Language', language);
      const response = serviceMaintenanceResponse(
        new Request('https://musixquare.com/', { headers }),
        activeState(),
      );
      expect(response.headers.get('Content-Language'), language || 'missing').toBe('en');
    }
  });

  it('returns headers without a response body for maintenance HEAD requests', async () => {
    const response = serviceMaintenanceResponse(
      new Request('https://musixquare.com/', {
        method: 'HEAD',
        headers: { Accept: 'text/html', 'Accept-Language': 'ja-JP' },
      }),
      activeState(),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Language')).toBe('ja');
    expect(await response.text()).toBe('');
  });
});

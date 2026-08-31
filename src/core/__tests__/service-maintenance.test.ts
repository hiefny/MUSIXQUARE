import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME,
  ADMIN_ANNOUNCEMENT_STATE_PATH,
  ADMIN_ANNOUNCEMENT_STATUS_PATH,
  ABUSE_RATE_IDEMPOTENT_CONSUME_PATH,
  ABUSE_RATE_PAIR_CONSUME_PATH,
  ABUSE_RATE_RESPONSE_PROTOCOL,
  ABUSE_RATE_RESPONSE_PROTOCOL_HEADER,
  ABUSE_RATE_RESPONSE_RESULT_HEADER,
  SERVICE_CONTROL_READ_TIMEOUT_MS,
  SERVICE_CONTROL_STATE_PATH,
  SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER,
  SERVICE_CONTROL_STATUS_ENABLED_HEADER,
  SERVICE_CONTROL_STATUS_PATH,
  SERVICE_CONTROL_STATUS_REVISION_HEADER,
  SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER,
  SERVICE_CONTROL_STATUS_VERSION_HEADER,
  clearServiceMaintenanceCacheForTests,
  consumeAbuseRateLimit,
  consumeAbuseRateLimitPair,
  gateServiceMaintenance,
  inactiveServiceMaintenanceState,
  normalizeServiceMaintenanceState,
  readAdminAnnouncementControl,
  readCachedServiceMaintenance,
  readServiceMaintenance,
  serviceMaintenancePreviewResponse,
  serviceMaintenanceResponse,
  updateServiceMaintenance,
  updateAdminAnnouncementControl,
  type ServiceMaintenanceState,
} from '../../../cloudflare/service-maintenance.ts';
import { createAtomicRateControlBinding } from './service-control-rate-limit-fixture.ts';

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
  options: {
    legacyNamespace?: boolean;
    legacyAnnouncementHandler?: (request: Request) => Response | Promise<Response>;
    separatedAnnouncementStatusHandler?: (request: Request) => Response | Promise<Response>;
  } = {},
): {
  env: Record<string, unknown>;
  fetch: ReturnType<typeof vi.fn>;
  legacyAnnouncementFetch: ReturnType<typeof vi.fn>;
  objectNames: string[];
} {
  const fetch = vi.fn(handler);
  const legacyAnnouncementFetch = vi.fn(
    options.legacyAnnouncementHandler || (() => Response.json(announcementControlPayload(0))),
  );
  const objectNames: string[] = [];
  const stubForName = (name: string) => {
    objectNames.push(name);
    if (name === ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME) {
      return {
        fetch: (request: Request) =>
          options.separatedAnnouncementStatusHandler &&
          new URL(request.url).pathname === ADMIN_ANNOUNCEMENT_STATUS_PATH
            ? options.separatedAnnouncementStatusHandler(request)
            : fetch(request),
      };
    }
    return {
      fetch: (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'HEAD' && pathname === SERVICE_CONTROL_STATUS_PATH) {
          return new Response(null, { status: 404 });
        }
        return pathname === ADMIN_ANNOUNCEMENT_STATUS_PATH
          ? legacyAnnouncementFetch(request)
          : fetch(request);
      },
    };
  };
  const namespace = options.legacyNamespace
    ? {
        idFromName: vi.fn((name: string) => `id:${name}`),
        get: vi.fn((id: string) => stubForName(id.slice(3))),
      }
    : { getByName: vi.fn((name: string) => stubForName(name)) };
  return {
    env: { MUSIXQUARE_SERVICE_CONTROL: namespace },
    fetch,
    legacyAnnouncementFetch,
    objectNames,
  };
}

afterEach(() => {
  clearServiceMaintenanceCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared service-maintenance control', () => {
  it('hard-limits 121 barrier-concurrent consumes through a named rate object', async () => {
    const control = createAtomicRateControlBinding(121);
    const input = {
      scope: 'signaling-ws-open',
      identity: 'opaque-signaling-rate-identity',
      limit: 120,
      windowMs: 60_000,
    };

    const outcomes = await Promise.all(
      Array.from({ length: 121 }, () =>
        consumeAbuseRateLimit({ MUSIXQUARE_SERVICE_CONTROL: control.binding }, input),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'ok' && outcome.allowed)).toHaveLength(
      120,
    );
    expect(outcomes.filter((outcome) => outcome.status === 'ok' && !outcome.allowed)).toHaveLength(
      1,
    );
    expect(control.rateFetchCount()).toBe(121);
    expect(control.objectNames()).toEqual([
      'musixquare-abuse-rate-v1:signaling-ws-open:opaque-signaling-rate-identity',
    ]);
  });

  it('accepts base64url rate identities that begin with URL-safe punctuation', async () => {
    const fetch = vi.fn((_request: Request) =>
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
    const request = fetch.mock.calls[0]?.[0] as Request;
    expect(request.headers.get(ABUSE_RATE_RESPONSE_PROTOCOL_HEADER)).toBe(
      ABUSE_RATE_RESPONSE_PROTOCOL,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('consumes a negotiated single-counter result from headers without touching its body', async () => {
    const getReader = vi.fn();
    const cancel = vi.fn();
    const fetch = vi.fn(() => ({
      ok: true,
      status: 200,
      headers: new Headers({
        [ABUSE_RATE_RESPONSE_PROTOCOL_HEADER]: ABUSE_RATE_RESPONSE_PROTOCOL,
        [ABUSE_RATE_RESPONSE_RESULT_HEADER]: JSON.stringify({
          allowed: true,
          limit: 4,
          remaining: 3,
          resetAtMs: 1_800_000_060_000,
          retryAfterSeconds: 0,
        }),
      }),
      body: { getReader, cancel },
    }));
    const env = { MUSIXQUARE_SERVICE_CONTROL: { getByName: vi.fn(() => ({ fetch })) } };

    await expect(
      consumeAbuseRateLimit(env, {
        scope: 'app-turn-capability',
        identity: 'header-result',
        limit: 4,
        windowMs: 60_000,
      }),
    ).resolves.toMatchObject({ status: 'ok', allowed: true, remaining: 3 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('falls back to one legacy response body without replaying the rate mutation', async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        allowed: true,
        limit: 4,
        remaining: 3,
        resetAtMs: 1_800_000_060_000,
        retryAfterSeconds: 0,
      }),
    );
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: encoded })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const getReader = vi.fn(() => reader);
    const fetch = vi.fn(() => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(encoded.byteLength) }),
      body: { getReader, cancel: vi.fn() },
    }));
    const env = { MUSIXQUARE_SERVICE_CONTROL: { getByName: vi.fn(() => ({ fetch })) } };

    await expect(
      consumeAbuseRateLimit(env, {
        scope: 'app-turn-capability',
        identity: 'legacy-body-result',
        limit: 4,
        windowMs: 60_000,
      }),
    ).resolves.toMatchObject({ status: 'ok', allowed: true, remaining: 3 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(getReader).toHaveBeenCalledOnce();
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('fails a malformed negotiated rate result closed without falling back to its body', async () => {
    const getReader = vi.fn();
    const cancel = vi.fn();
    const fetch = vi.fn(() => ({
      ok: true,
      status: 200,
      headers: new Headers({
        [ABUSE_RATE_RESPONSE_PROTOCOL_HEADER]: ABUSE_RATE_RESPONSE_PROTOCOL,
        [ABUSE_RATE_RESPONSE_RESULT_HEADER]: '{invalid',
      }),
      body: { getReader, cancel },
    }));
    const env = { MUSIXQUARE_SERVICE_CONTROL: { getByName: vi.fn(() => ({ fetch })) } };

    await expect(
      consumeAbuseRateLimit(env, {
        scope: 'app-turn-capability',
        identity: 'malformed-header-result',
        limit: 4,
        windowMs: 60_000,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('fails an unknown negotiated rate protocol closed without opening its body', async () => {
    const getReader = vi.fn();
    const cancel = vi.fn();
    const fetch = vi.fn(() => ({
      ok: true,
      status: 200,
      headers: new Headers({
        [ABUSE_RATE_RESPONSE_PROTOCOL_HEADER]: 'headers-v999',
        [ABUSE_RATE_RESPONSE_RESULT_HEADER]: '{}',
      }),
      body: { getReader, cancel },
    }));
    const env = { MUSIXQUARE_SERVICE_CONTROL: { getByName: vi.fn(() => ({ fetch })) } };

    await expect(
      consumeAbuseRateLimit(env, {
        scope: 'app-turn-capability',
        identity: 'unknown-header-protocol',
        limit: 4,
        windowMs: 60_000,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('does not touch a negotiated non-success rate body', async () => {
    const getReader = vi.fn();
    const cancel = vi.fn();
    const fetch = vi.fn(() => ({
      ok: false,
      status: 503,
      headers: new Headers({
        [ABUSE_RATE_RESPONSE_PROTOCOL_HEADER]: ABUSE_RATE_RESPONSE_PROTOCOL,
      }),
      body: { getReader, cancel },
    }));
    const env = { MUSIXQUARE_SERVICE_CONTROL: { getByName: vi.fn(() => ({ fetch })) } };

    await expect(
      consumeAbuseRateLimit(env, {
        scope: 'app-turn-capability',
        identity: 'status-only-error',
        limit: 4,
        windowMs: 60_000,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('routes an opaque operation id through the idempotent v2 consume contract', async () => {
    const { env, fetch } = serviceControlEnv(() =>
      Response.json({
        allowed: true,
        limit: 4,
        remaining: 3,
        resetAtMs: 1_800_000_060_000,
        retryAfterSeconds: 0,
      }),
    );
    const operationId = `rs_${'A'.repeat(43)}`;

    await expect(
      consumeAbuseRateLimit(env, {
        scope: 'remote-share-upload',
        identity: 'session-ip:test',
        limit: 4,
        windowMs: 60_000,
        operationId,
      }),
    ).resolves.toMatchObject({ status: 'ok', allowed: true, remaining: 3 });
    const request = fetch.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).pathname).toBe(ABUSE_RATE_IDEMPOTENT_CONSUME_PATH);
    await expect(request.json()).resolves.toEqual({
      limit: 4,
      windowMs: 60_000,
      cost: 1,
      operationId,
    });
  });

  it('routes two ordered buckets through one named pair object and one fetch', async () => {
    const control = createAtomicRateControlBinding();

    const outcome = await consumeAbuseRateLimitPair(
      { MUSIXQUARE_SERVICE_CONTROL: control.binding },
      {
        scope: 'app-turn-config',
        identity: 'opaque-ip',
        limit: 150,
        windowMs: 60_000,
        secondary: { identity: 'opaque-token', limit: 4 },
      },
    );

    expect(outcome).toMatchObject({
      status: 'ok',
      allowed: true,
      deniedBy: null,
      primary: { remaining: 149 },
      secondary: { remaining: 3 },
    });
    expect(control.rateFetchCount()).toBe(1);
    expect(control.objectNames()).toEqual([
      'musixquare-abuse-rate-pair-v1:app-turn-config:opaque-ip',
    ]);
  });

  it('does not charge the shared primary bucket when only one secondary identity is exhausted', async () => {
    const control = createAtomicRateControlBinding();
    const env = { MUSIXQUARE_SERVICE_CONTROL: control.binding };
    const consume = (secondaryIdentity: string) =>
      consumeAbuseRateLimitPair(env, {
        scope: 'app-turn-config',
        identity: 'shared-private-relay-ip',
        limit: 2,
        windowMs: 60_000,
        secondary: { identity: secondaryIdentity, limit: 1 },
      });

    await expect(consume('browser-a')).resolves.toMatchObject({
      status: 'ok',
      allowed: true,
      primary: { remaining: 1 },
      secondary: { remaining: 0 },
    });
    await expect(consume('browser-a')).resolves.toMatchObject({
      status: 'ok',
      allowed: false,
      deniedBy: 'secondary',
      primary: { remaining: 1 },
    });
    await expect(consume('browser-b')).resolves.toMatchObject({
      status: 'ok',
      allowed: true,
      primary: { remaining: 0 },
    });
  });

  it('validates a primary denial without requiring a secondary projection', async () => {
    const { env } = serviceControlEnv(() =>
      Response.json({
        allowed: false,
        deniedBy: 'primary',
        primary: {
          allowed: false,
          limit: 150,
          remaining: 0,
          resetAtMs: 1_800_000_060_000,
          retryAfterSeconds: 30,
        },
        secondary: null,
      }),
    );

    await expect(
      consumeAbuseRateLimitPair(env, {
        scope: 'app-turn-config',
        identity: 'opaque-ip',
        limit: 150,
        windowMs: 60_000,
        secondary: { identity: 'opaque-token', limit: 4 },
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      allowed: false,
      deniedBy: 'primary',
      retryAfterSeconds: 30,
      secondary: null,
    });
  });

  it('consumes a negotiated pair result from headers without touching its body', async () => {
    const getReader = vi.fn();
    const cancel = vi.fn();
    const resetAtMs = 1_800_000_060_000;
    const fetch = vi.fn(() => ({
      ok: true,
      status: 200,
      headers: new Headers({
        [ABUSE_RATE_RESPONSE_PROTOCOL_HEADER]: ABUSE_RATE_RESPONSE_PROTOCOL,
        [ABUSE_RATE_RESPONSE_RESULT_HEADER]: JSON.stringify({
          allowed: false,
          deniedBy: 'secondary',
          primary: {
            allowed: true,
            limit: 150,
            remaining: 149,
            resetAtMs,
            retryAfterSeconds: 0,
          },
          secondary: {
            allowed: false,
            limit: 4,
            remaining: 0,
            resetAtMs,
            retryAfterSeconds: 30,
          },
        }),
      }),
      body: { getReader, cancel },
    }));
    const env = { MUSIXQUARE_SERVICE_CONTROL: { getByName: vi.fn(() => ({ fetch })) } };

    await expect(
      consumeAbuseRateLimitPair(env, {
        scope: 'app-turn-config',
        identity: 'header-pair-result',
        limit: 150,
        windowMs: 60_000,
        secondary: { identity: 'opaque-token', limit: 4 },
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      allowed: false,
      deniedBy: 'secondary',
      retryAfterSeconds: 30,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('fails pair consumption closed on a contradictory internal response', async () => {
    const { env, fetch } = serviceControlEnv(() =>
      Response.json({
        allowed: true,
        deniedBy: null,
        primary: {
          allowed: true,
          limit: 150,
          remaining: 149,
          resetAtMs: 1_800_000_060_000,
          retryAfterSeconds: 0,
        },
        secondary: null,
      }),
    );

    await expect(
      consumeAbuseRateLimitPair(env, {
        scope: 'app-turn-config',
        identity: 'opaque-ip',
        limit: 150,
        windowMs: 60_000,
        secondary: { identity: 'opaque-token', limit: 4 },
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    const request = fetch.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).pathname).toBe(ABUSE_RATE_PAIR_CONSUME_PATH);
    await expect(request.json()).resolves.toEqual({
      limit: 150,
      windowMs: 60_000,
      cost: 1,
      secondaryIdentity: 'opaque-token',
      secondaryLimit: 4,
      secondaryCost: 1,
    });
  });

  it('fails pair consumption closed on impossible cost, retry, and reset projections', async () => {
    const resetAtMs = 1_800_000_060_000;
    const canonical = {
      allowed: true,
      deniedBy: null,
      primary: {
        allowed: true,
        limit: 150,
        remaining: 149,
        resetAtMs,
        retryAfterSeconds: 0,
      },
      secondary: {
        allowed: true,
        limit: 4,
        remaining: 3,
        resetAtMs,
        retryAfterSeconds: 0,
      },
    };
    const cases = [
      {
        payload: canonical,
        cost: 2,
        secondaryCost: 1,
      },
      {
        payload: {
          ...canonical,
          primary: { ...canonical.primary, retryAfterSeconds: 1 },
        },
        cost: 1,
        secondaryCost: 1,
      },
      {
        payload: {
          ...canonical,
          secondary: { ...canonical.secondary, resetAtMs: resetAtMs + 60_000 },
        },
        cost: 1,
        secondaryCost: 1,
      },
      {
        payload: {
          ...canonical,
          allowed: false,
          deniedBy: 'secondary',
          secondary: {
            ...canonical.secondary,
            allowed: false,
            remaining: 0,
            retryAfterSeconds: 0,
          },
        },
        cost: 1,
        secondaryCost: 1,
      },
    ];

    for (const testCase of cases) {
      const { env } = serviceControlEnv(() => Response.json(testCase.payload));
      await expect(
        consumeAbuseRateLimitPair(env, {
          scope: 'app-turn-config',
          identity: 'opaque-ip',
          limit: 150,
          windowMs: 60_000,
          cost: testCase.cost,
          secondary: {
            identity: 'opaque-token',
            limit: 4,
            cost: testCase.secondaryCost,
          },
        }),
      ).resolves.toEqual({ status: 'unavailable' });
    }
  });

  it('rejects a pair request whose secondary cost can outrun its primary count', async () => {
    const { env, fetch } = serviceControlEnv(() => {
      throw new Error('invalid pair input must not reach the binding');
    });

    await expect(
      consumeAbuseRateLimitPair(env, {
        scope: 'app-turn-config',
        identity: 'opaque-ip',
        limit: 150,
        windowMs: 60_000,
        cost: 1,
        secondary: { identity: 'opaque-token', limit: 4, cost: 2 },
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
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

  it('reads versioned status headers without opening or cancelling the response body', async () => {
    const getReader = vi.fn(() => {
      throw new Error('status body must remain untouched');
    });
    const cancel = vi.fn(() => {
      throw new Error('status body must not be cancelled');
    });
    const fetch = vi.fn((_request: Request) =>
      Promise.resolve({
        body: { getReader, cancel },
        headers: new Headers({
          [SERVICE_CONTROL_STATUS_VERSION_HEADER]: '1',
          [SERVICE_CONTROL_STATUS_ENABLED_HEADER]: '1',
          [SERVICE_CONTROL_STATUS_REVISION_HEADER]: '8',
          [SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER]: '1800000000000',
          [SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER]: '1799999999000',
        }),
        ok: true,
        status: 200,
      }),
    );
    const env = {
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn(() => ({ fetch })),
      },
    };

    await expect(readServiceMaintenance(env)).resolves.toEqual({
      enabled: true,
      revision: 8,
      updatedAt: 1_800_000_000_000,
      activatedAt: 1_799_999_999_000,
      settlesAt: 1_800_000_002_000,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ method: 'HEAD' }));
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('fails closed on malformed versioned status headers without falling back to the body', async () => {
    const getReader = vi.fn();
    const cancel = vi.fn();
    const fetch = vi.fn(() =>
      Promise.resolve({
        body: { getReader, cancel },
        headers: new Headers({
          [SERVICE_CONTROL_STATUS_VERSION_HEADER]: '1',
          [SERVICE_CONTROL_STATUS_ENABLED_HEADER]: '1',
          [SERVICE_CONTROL_STATUS_REVISION_HEADER]: 'not-a-revision',
          [SERVICE_CONTROL_STATUS_UPDATED_AT_HEADER]: '1800000000000',
          [SERVICE_CONTROL_STATUS_ACTIVATED_AT_HEADER]: '1799999999000',
        }),
        ok: true,
        status: 200,
      }),
    );
    const env = {
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn(() => ({ fetch })),
      },
    };

    await expect(readServiceMaintenance(env)).resolves.toMatchObject({
      enabled: true,
      controlUnavailable: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('falls back to legacy JSON only when the status HEAD route is explicitly unavailable', async () => {
    const methods: string[] = [];
    const fetch = vi.fn((request: Request) => {
      methods.push(request.method);
      if (request.method === 'HEAD') return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(Response.json({ serviceStatus: activeState() }));
    });
    const env = {
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn(() => ({ fetch })),
      },
    };

    await expect(readServiceMaintenance(env)).resolves.toMatchObject({
      enabled: true,
      revision: 4,
    });
    expect(methods).toEqual(['HEAD', 'GET']);
  });

  it('does not reopen the legacy body path for a headerless successful HEAD response', async () => {
    const fetch = vi.fn((_request: Request) =>
      Promise.resolve(Response.json({ serviceStatus: activeState() })),
    );
    const env = {
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn(() => ({ fetch })),
      },
    };

    await expect(readServiceMaintenance(env)).resolves.toMatchObject({
      enabled: true,
      controlUnavailable: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ method: 'HEAD' }));
  });

  it('bounds a stalled status HEAD without attempting a legacy GET', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_request: Request) => new Promise<Response>(() => {}));
    const env = {
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn(() => ({ fetch })),
      },
    };
    const read = readServiceMaintenance(env);

    await vi.advanceTimersByTimeAsync(SERVICE_CONTROL_READ_TIMEOUT_MS);
    await expect(read).resolves.toMatchObject({ enabled: true, controlUnavailable: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ method: 'HEAD' }));
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

  it('keeps public cached reads closed when a status read overtakes an ambiguous mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00.000Z'));
    const disabledState = activeState({
      enabled: false,
      revision: 3,
      updatedAt: 1_800_000_002_000,
      activatedAt: null,
      settlesAt: 1_800_000_004_000,
    });
    const enabledState = activeState({
      enabled: true,
      revision: 4,
      updatedAt: 1_800_000_003_000,
      activatedAt: 1_800_000_003_000,
      settlesAt: 1_800_000_005_000,
    });
    let statusReadCount = 0;
    const control = serviceControlEnv((request) => {
      const path = new URL(request.url).pathname;
      if (path === SERVICE_CONTROL_STATUS_PATH) {
        statusReadCount += 1;
        return Response.json({
          serviceStatus: statusReadCount < 3 ? disabledState : enabledState,
        });
      }
      expect(path).toBe(SERVICE_CONTROL_STATE_PATH);
      return Response.json({ error: 'CONTROL_UNAVAILABLE' }, { status: 503 });
    });

    await expect(readServiceMaintenance(control.env, { fresh: true })).resolves.toEqual(
      disabledState,
    );
    await expect(
      updateServiceMaintenance(control.env, {
        enabled: true,
        expectedRevision: disabledState.revision,
        requestId: 'maintenance-ambiguous-enable',
      }),
    ).resolves.toMatchObject({ status: 'unavailable', state: { controlUnavailable: true } });

    expect(readCachedServiceMaintenance(control.env)).toMatchObject({
      state: { enabled: true, controlUnavailable: true },
      refreshNeeded: false,
    });

    await vi.advanceTimersByTimeAsync(1_001);
    expect(readCachedServiceMaintenance(control.env)).toMatchObject({
      state: { enabled: true, controlUnavailable: true },
      refreshNeeded: true,
    });

    await expect(readServiceMaintenance(control.env, { fresh: true })).resolves.toMatchObject({
      enabled: true,
      controlUnavailable: true,
    });
    expect(readCachedServiceMaintenance(control.env)).toMatchObject({
      state: { enabled: true, controlUnavailable: true },
      refreshNeeded: false,
    });

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(readServiceMaintenance(control.env, { fresh: true })).resolves.toEqual(
      enabledState,
    );
    expect(readCachedServiceMaintenance(control.env)).toEqual({
      state: enabledState,
      refreshNeeded: false,
    });
  });

  it('keeps every ambiguous mutation fenced when a newer no-op mutation completes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00.000Z'));
    const disabledState = activeState({
      enabled: false,
      revision: 3,
      updatedAt: 1_800_000_002_000,
      activatedAt: null,
      settlesAt: 1_800_000_004_000,
    });
    const enabledState = activeState({
      enabled: true,
      revision: 4,
      updatedAt: 1_800_000_003_000,
      activatedAt: 1_800_000_003_000,
      settlesAt: 1_800_000_005_000,
    });
    let statusReadCount = 0;
    const control = serviceControlEnv(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === SERVICE_CONTROL_STATUS_PATH) {
        statusReadCount += 1;
        return Response.json({
          serviceStatus: statusReadCount < 3 ? disabledState : enabledState,
        });
      }
      expect(path).toBe(SERVICE_CONTROL_STATE_PATH);
      const body = (await request.json()) as { requestId?: string };
      return body.requestId === 'maintenance-stalled-enable'
        ? Response.json({ error: 'CONTROL_UNAVAILABLE' }, { status: 503 })
        : Response.json({ serviceStatus: disabledState });
    });

    await expect(readServiceMaintenance(control.env, { fresh: true })).resolves.toEqual(
      disabledState,
    );
    await expect(
      updateServiceMaintenance(control.env, {
        enabled: true,
        expectedRevision: disabledState.revision,
        requestId: 'maintenance-stalled-enable',
      }),
    ).resolves.toMatchObject({ status: 'unavailable' });
    await expect(
      updateServiceMaintenance(control.env, {
        enabled: false,
        expectedRevision: disabledState.revision,
        requestId: 'maintenance-definitive-noop-disable',
      }),
    ).resolves.toEqual({ status: 'ok', state: disabledState });

    expect(readCachedServiceMaintenance(control.env)).toMatchObject({
      state: { enabled: true, controlUnavailable: true },
      refreshNeeded: false,
    });

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(readServiceMaintenance(control.env, { fresh: true })).resolves.toMatchObject({
      enabled: true,
      controlUnavailable: true,
    });

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(readServiceMaintenance(control.env, { fresh: true })).resolves.toEqual(
      enabledState,
    );
    expect(readCachedServiceMaintenance(control.env)).toEqual({
      state: enabledState,
      refreshNeeded: false,
    });
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

  it('keeps maintenance available while the separated announcement object is stalled', async () => {
    let releaseAnnouncement!: (response: Response) => void;
    const announcementFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseAnnouncement = resolve;
        }),
    );
    const maintenanceFetch = vi.fn((request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === SERVICE_CONTROL_STATUS_PATH) {
        if (request.method === 'HEAD') return new Response(null, { status: 404 });
        return Response.json({ serviceStatus: activeState({ enabled: false }) });
      }
      if (path === SERVICE_CONTROL_STATE_PATH) {
        return Response.json({
          serviceStatus: activeState({
            enabled: false,
            revision: 5,
            updatedAt: 1_800_000_001_000,
            activatedAt: null,
            settlesAt: 1_800_000_003_000,
          }),
        });
      }
      return Response.json(announcementControlPayload(0));
    });
    const env = {
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn((name: string) => ({
          fetch:
            name === ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME ? announcementFetch : maintenanceFetch,
        })),
      },
    };

    const stalled = readAdminAnnouncementControl(env, { fresh: true });
    await vi.waitFor(() => expect(announcementFetch).toHaveBeenCalledTimes(1));
    await expect(readServiceMaintenance(env, { fresh: true })).resolves.toMatchObject({
      enabled: false,
      revision: 4,
    });
    await expect(
      updateServiceMaintenance(env, {
        enabled: false,
        expectedRevision: 4,
        requestId: 'maintenance-during-announcement-stall',
      }),
    ).resolves.toMatchObject({ status: 'ok', state: { enabled: false, revision: 5 } });
    expect(maintenanceFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }));
    expect(maintenanceFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }));

    releaseAnnouncement(Response.json(announcementControlPayload(1)));
    await expect(stalled).resolves.toEqual({
      status: 'ok',
      payload: announcementControlPayload(1),
    });
  });

  it('falls back to the old shared announcement and atomically migrates its revision and history', async () => {
    const legacy = announcementControlPayload(2);
    const migrated = announcementControlPayload(3);
    let separated = announcementControlPayload(0);
    const separatedFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === ADMIN_ANNOUNCEMENT_STATUS_PATH) return Response.json(separated);
      expect(path).toBe(ADMIN_ANNOUNCEMENT_STATE_PATH);
      expect(request.headers.get('X-Musixquare-Admin-Announcement-Migration')).toBe('1');
      await expect(request.clone().json()).resolves.toMatchObject({
        expectedRevision: 2,
        baseHistory: legacy.announcementState.history,
      });
      separated = migrated;
      return Response.json(migrated);
    });
    const legacyFetch = vi.fn(() => Response.json(legacy));
    const env = {
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn((name: string) => ({
          fetch: name === ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME ? separatedFetch : legacyFetch,
        })),
      },
    };

    await expect(readAdminAnnouncementControl(env, { fresh: true })).resolves.toEqual({
      status: 'ok',
      payload: legacy,
    });
    await expect(
      updateAdminAnnouncementControl(env, {
        message: 'Revision 3',
        enabled: true,
        expiresAt: null,
        expectedRevision: 2,
        requestId: 'announcement-separated-migration',
        baseHistory: [],
      }),
    ).resolves.toEqual({ status: 'ok', payload: migrated });
    await expect(readAdminAnnouncementControl(env, { fresh: true })).resolves.toEqual({
      status: 'ok',
      payload: migrated,
    });
    expect(legacyFetch).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent first writes into the separated announcement object', async () => {
    const legacy = announcementControlPayload(2);
    const migrated = announcementControlPayload(3);
    let separated = announcementControlPayload(0);
    const separatedFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === ADMIN_ANNOUNCEMENT_STATUS_PATH) {
        return Response.json(separated);
      }
      if (separated.announcementState.revision !== 0) {
        return Response.json(separated, { status: 409 });
      }
      separated = migrated;
      return Response.json(migrated);
    });
    const env = {
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn((name: string) => ({
          fetch:
            name === ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME
              ? separatedFetch
              : () => Response.json(legacy),
        })),
      },
    };
    await readAdminAnnouncementControl(env, { fresh: true });

    const results = await Promise.all([
      updateAdminAnnouncementControl(env, {
        message: 'Concurrent A',
        enabled: true,
        expiresAt: null,
        expectedRevision: 2,
        requestId: 'announcement-separated-concurrent-a',
        baseHistory: [],
      }),
      updateAdminAnnouncementControl(env, {
        message: 'Concurrent B',
        enabled: true,
        expiresAt: null,
        expectedRevision: 2,
        requestId: 'announcement-separated-concurrent-b',
        baseHistory: [],
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'ok']);
  });

  it('rechecks both stores before the first mutation when an empty separated cache is stale', async () => {
    let legacy = announcementControlPayload(0);
    let separatedMutations = 0;
    const separatedFetch = vi.fn((request: Request) => {
      if (new URL(request.url).pathname === ADMIN_ANNOUNCEMENT_STATUS_PATH) {
        return Response.json(announcementControlPayload(0));
      }
      separatedMutations += 1;
      return Response.json(announcementControlPayload(1));
    });
    const env = {
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn((name: string) => ({
          fetch:
            name === ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME
              ? separatedFetch
              : () => Response.json(legacy),
        })),
      },
    };

    await expect(readAdminAnnouncementControl(env, { fresh: true })).resolves.toEqual({
      status: 'ok',
      payload: announcementControlPayload(0),
    });
    legacy = announcementControlPayload(1);

    await expect(
      updateAdminAnnouncementControl(env, {
        message: 'Would overwrite a rollout write',
        enabled: true,
        expiresAt: null,
        expectedRevision: 0,
        requestId: 'announcement-stale-empty-separated-cache',
        baseHistory: [],
      }),
    ).resolves.toEqual({ status: 'conflict', payload: legacy });
    expect(separatedMutations).toBe(0);
  });

  it('keeps a positive separated result ahead of a higher-revision delayed legacy fallback', async () => {
    const legacyOne = announcementControlPayload(1);
    const delayedLegacyThree = announcementControlPayload(3);
    const separatedAnnouncement = {
      id: 'separated-announcement-2',
      message: 'Separated revision 2',
      enabled: true,
      expiresAt: null,
      updatedAt: '2026-02-02T00:00:00.000Z',
    };
    const separatedTwo = {
      announcementState: {
        revision: 2,
        announcement: separatedAnnouncement,
        history: [{ ...separatedAnnouncement, action: 'published' }],
      },
    };
    let legacyReads = 0;
    let delayedLegacyBody!: ReadableStreamDefaultController<Uint8Array>;
    const separatedFetch = vi.fn((request: Request) => {
      const path = new URL(request.url).pathname;
      return path === ADMIN_ANNOUNCEMENT_STATUS_PATH
        ? Response.json(announcementControlPayload(0))
        : Response.json(separatedTwo);
    });
    const legacyFetch = vi.fn(() => {
      legacyReads += 1;
      if (legacyReads > 1) return Response.json(legacyOne);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            delayedLegacyBody = controller;
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
    const env = {
      MUSIXQUARE_SERVICE_CONTROL: {
        getByName: vi.fn((name: string) => ({
          fetch: name === ADMIN_ANNOUNCEMENT_CONTROL_OBJECT_NAME ? separatedFetch : legacyFetch,
        })),
      },
    };

    const delayedRead = readAdminAnnouncementControl(env, { fresh: true });
    await vi.waitFor(() => expect(legacyFetch).toHaveBeenCalledTimes(1));
    await expect(
      updateAdminAnnouncementControl(env, {
        message: 'Separated revision 2',
        enabled: true,
        expiresAt: null,
        expectedRevision: 1,
        requestId: 'announcement-separated-source-priority',
        baseHistory: [],
      }),
    ).resolves.toEqual({ status: 'ok', payload: separatedTwo });

    delayedLegacyBody.enqueue(new TextEncoder().encode(JSON.stringify(delayedLegacyThree)));
    delayedLegacyBody.close();
    await expect(delayedRead).resolves.toEqual({ status: 'ok', payload: separatedTwo });
    await expect(readAdminAnnouncementControl(env)).resolves.toEqual({
      status: 'ok',
      payload: separatedTwo,
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
    expect(statusReads).toBe(3);

    oldBody.enqueue(new TextEncoder().encode(JSON.stringify(revisionOne)));
    oldBody.close();
    await expect(oldRead).resolves.toEqual({ status: 'ok', payload: revisionTwo });
    expect(control.fetch).toHaveBeenCalledTimes(4);
  });

  it('keeps the newest-started announcement mutation when responses finish out of order', async () => {
    const revisionTwo = announcementControlPayload(2);
    const revisionThree = announcementControlPayload(3);
    let firstBody!: ReadableStreamDefaultController<Uint8Array>;
    let mutations = 0;
    const control = serviceControlEnv(
      (request) => {
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
      },
      {
        separatedAnnouncementStatusHandler: () => Response.json(announcementControlPayload(1)),
      },
    );

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
    const control = serviceControlEnv(
      (request) => {
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
      },
      {
        separatedAnnouncementStatusHandler: () => Response.json(announcementControlPayload(1)),
      },
    );

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
    let separatedStatusReads = 0;
    const control = serviceControlEnv(
      (request) => {
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
      },
      {
        separatedAnnouncementStatusHandler: () => {
          separatedStatusReads += 1;
          return Response.json(
            separatedStatusReads > 2 ? revisionFour : announcementControlPayload(1),
          );
        },
      },
    );

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
    expect(control.fetch).toHaveBeenCalledTimes(2);
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
    expect(body).toContain('<html lang="ko" dir="ltr">');
    expect(body).toContain('<title lang="en">MUSIXQUARE: Service check</title>');
    expect(body).toContain('<h1 lang="en" dir="ltr">');
    expect(body).toContain('<span class="sr-only">MUSIXQUARE is temporarily unavailable.</span>');
    expect(body).toContain('<span class="headline" aria-hidden="true">');
    expect(body).toContain('<span class="headline-lead"><svg class="wordmark"');
    expect(body).toContain('viewBox="43 12 214 26"');
    expect(body).toContain('focusable="false"');
    expect(body).toContain('</svg><span>is</span></span> temporarily unavailable.</span>');
    expect(body.match(/class="wordmark"/gu)).toHaveLength(1);
    expect(body).not.toContain('role="img" aria-label="MUSIXQUARE"');
    expect(body).toContain('안전한 서비스 점검을 진행 중이에요. 잠시 후 다시 시도해 주세요.');
    expect(body).not.toMatch(/(?:class="[^"]*\b(?:card|dot|pulse)\b|[.#](?:card|dot|pulse)\b)/u);
    expect(body).not.toMatch(/@keyframes|\banimation(?:-name)?\s*:/u);
  });

  it('serves a visually exact, no-store maintenance preview without 503 semantics', async () => {
    const headers = { Accept: 'text/html', 'Accept-Language': 'ko-KR, en;q=0.8' };
    const actual = serviceMaintenanceResponse(
      new Request('https://musixquare.com/000002', { headers }),
      activeState(),
    );
    const preview = serviceMaintenancePreviewResponse(
      new Request('https://musixquare.com/admin/maintenance-preview', { headers }),
    );

    expect(actual.status).toBe(503);
    expect(actual.headers.get('Retry-After')).toBe('60');
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(preview.headers.get('Retry-After')).toBeNull();
    expect(preview.headers.get('X-MXQR-Maintenance-Preview')).toBe('1');
    expect(preview.headers.get('Content-Language')).toBe('ko');
    await expect(preview.text()).resolves.toBe(await actual.text());
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
    expect(body).toContain('<html lang="pt-br" dir="ltr">');
    expect(body).toContain('Estamos verificando o serviço. Tente novamente em instantes.');
  });

  it('maps the generic Norwegian language tag to supported Bokmål copy', async () => {
    const response = serviceMaintenanceResponse(
      new Request('https://musixquare.com/', {
        headers: { Accept: 'text/html', 'Accept-Language': 'no-NO' },
      }),
      activeState(),
    );
    const body = await response.text();

    expect(response.headers.get('Content-Language')).toBe('nb');
    expect(body).toContain('<html lang="nb" dir="ltr">');
    expect(body).toContain('Vi gjennomfører en servicekontroll. Prøv igjen om en liten stund.');
  });

  it('falls back to English for English, unsupported, wildcard, and missing language headers', () => {
    for (const language of ['en-GB', 'zu-ZA', '*', '']) {
      const headers = new Headers({ Accept: 'text/html' });
      if (language) headers.set('Accept-Language', language);
      const response = serviceMaintenanceResponse(
        new Request('https://musixquare.com/', { headers }),
        activeState(),
      );
      expect(response.headers.get('Content-Language'), language || 'missing').toBe('en');
    }
  });

  it('serves right-to-left maintenance copy with an explicit document direction', async () => {
    const response = serviceMaintenanceResponse(
      new Request('https://musixquare.com/', {
        headers: { Accept: 'text/html', 'Accept-Language': 'ar-EG, en;q=0.5' },
      }),
      activeState(),
    );
    const body = await response.text();

    expect(response.headers.get('Content-Language')).toBe('ar');
    expect(body).toContain('<html lang="ar" dir="rtl">');
    expect(body).toContain('نجري فحصًا للخدمة حاليًا. يُرجى المحاولة مرة أخرى بعد قليل.');
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

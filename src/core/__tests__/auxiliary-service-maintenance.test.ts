import { afterEach, describe, expect, it, vi } from 'vitest';
import developerApiWorker, {
  DeveloperApiRateLimiter,
} from '../../../cloudflare/developer-api-worker.ts';
import developerApiFacadeWorker from '../../../cloudflare/developer-api-facade-worker.ts';
import { clearServiceMaintenanceCacheForTests } from '../../../cloudflare/service-maintenance.ts';

type RemoteShareWorkerModule = {
  default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
  RemoteShareQuota: new (
    state: { storage: Record<string, unknown> },
    env: Record<string, unknown>,
  ) => {
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
  };
};

const remoteShareWorkerModulePath = '../../../cloudflare/remote-share-worker.ts';
const { default: remoteShareWorker, RemoteShareQuota } = (await import(
  remoteShareWorkerModulePath
)) as RemoteShareWorkerModule;

const ACTIVE_STATUS = Object.freeze({
  enabled: true,
  revision: 7,
  updatedAt: 1_786_000_000_000,
  activatedAt: 1_786_000_000_000,
});

function activeMaintenanceEnv(extra: Record<string, unknown> = {}) {
  const fetch = vi.fn(async (request: Request) =>
    request.method === 'HEAD'
      ? new Response(null, { status: 404 })
      : Response.json({ serviceStatus: ACTIVE_STATUS }),
  );
  return {
    ...extra,
    MUSIXQUARE_SERVICE_CONTROL: {
      getByName: vi.fn(() => ({ fetch })),
    },
  };
}

afterEach(() => {
  clearServiceMaintenanceCacheForTests();
  vi.restoreAllMocks();
});

describe('auxiliary Worker service-maintenance gates', () => {
  it('blocks remote-share work while keeping CORS preflight available', async () => {
    const env = activeMaintenanceEnv();
    const blocked = await remoteShareWorker.fetch(
      new Request('https://share.musixquare.com/session', {
        method: 'POST',
        headers: { origin: 'https://musixquare.com' },
      }),
      env,
    );

    expect(blocked.status).toBe(503);
    expect(blocked.headers.get('access-control-allow-origin')).toBe('https://musixquare.com');
    await expect(blocked.json()).resolves.toMatchObject({
      error: 'SERVICE_MAINTENANCE',
      maintenance: true,
    });

    const readiness = await remoteShareWorker.fetch(
      new Request('https://share.musixquare.com/security-config', {
        headers: { origin: 'https://musixquare.com' },
      }),
      env,
    );
    expect(readiness.status).toBe(200);

    const preflight = await remoteShareWorker.fetch(
      new Request('https://share.musixquare.com/session', {
        method: 'OPTIONS',
        headers: { origin: 'https://musixquare.com' },
      }),
      env,
    );
    expect(preflight.status).toBe(204);
  });

  it('keeps Developer API health readable but blocks public and facade requests', async () => {
    const env = activeMaintenanceEnv();
    const health = await developerApiWorker.fetch(
      new Request('https://api.musixquare.com/health'),
      env,
    );
    expect(health.status).toBe(200);

    const blocked = await developerApiWorker.fetch(
      new Request('https://api.musixquare.com/v1/rooms/000001'),
      env,
    );
    expect(blocked.status).toBe(503);

    const facadeBlocked = await developerApiFacadeWorker.fetch(
      new Request('https://developer-api-facade.internal/internal/v1/read', { method: 'POST' }),
      env,
    );
    expect(facadeBlocked.status).toBe(503);
  });

  it('stops remote-share quota mutations and rearms its alarm', async () => {
    const storage = {
      get: vi.fn(),
      put: vi.fn(),
      setAlarm: vi.fn(async () => undefined),
    };
    const quota = new RemoteShareQuota({ storage }, activeMaintenanceEnv());

    const blocked = await quota.fetch(
      new Request('https://remote-share-quota.internal/reserve', { method: 'POST' }),
    );
    expect(blocked.status).toBe(503);
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();

    await quota.alarm();
    expect(storage.setAlarm).toHaveBeenCalledOnce();
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('stops Developer API background and limiter mutations during maintenance', async () => {
    const prepare = vi.fn();
    const env = activeMaintenanceEnv({ DEVELOPER_API_DB: { prepare } });
    const waits: Promise<unknown>[] = [];
    developerApiWorker.scheduled({ scheduledTime: ACTIVE_STATUS.updatedAt }, env, {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits);
    expect(prepare).not.toHaveBeenCalled();

    const storage = {
      get: vi.fn(),
      put: vi.fn(),
      setAlarm: vi.fn(async () => undefined),
    };
    const limiter = new DeveloperApiRateLimiter({ storage }, env);
    const blocked = await limiter.fetch(
      new Request('https://developer-api-rate.internal/check', { method: 'POST' }),
    );
    expect(blocked.status).toBe(503);
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();

    await limiter.alarm();
    expect(storage.setAlarm).toHaveBeenCalledOnce();
    expect(storage.get).not.toHaveBeenCalled();
  });
});

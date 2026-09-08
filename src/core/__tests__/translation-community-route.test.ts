import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.ts';
import {
  handleAdminTranslationCommunityRequest,
  handleTranslationCommunityRequest,
} from '../../../cloudflare/translation-community.ts';
import { clearServiceMaintenanceCacheForTests } from '../../../cloudflare/service-maintenance.ts';
import { createAtomicRateControlBinding } from './service-control-rate-limit-fixture.ts';

// Keep the real App routing, login, cookie verifier and CSRF gates. The endpoint
// seam is observed here; separate SQLite tests execute its actual mutations.
vi.mock('../../../cloudflare/translation-community.ts', () => ({
  handleAdminTranslationCommunityRequest: vi.fn(),
  handleTranslationCommunityRequest: vi.fn(),
}));

const origin = 'https://musixquare.com';
const reviewPath = '/api/admin/translations/11111111-1111-4111-8111-111111111111/review';
let env: Record<string, unknown>;

function mutationHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Origin: origin,
    'Content-Type': 'application/json',
    'X-MXQR-Admin-CSRF': '1',
  };
}

async function login(): Promise<string> {
  const response = await appWorker.fetch(
    new Request(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: mutationHeaders(''),
      body: JSON.stringify({ password: 'translation-admin-strong-password' }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie')?.split(';')[0];
  expect(cookie).toMatch(/^__Host-mxqr_admin=/u);
  return cookie!;
}

beforeEach(() => {
  env = {
    ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
    MXQR_ADMIN_PASSWORD: 'translation-admin-strong-password',
    MXQR_ADMIN_SESSION_SECRET: 'translation-admin-session-secret-at-least-32',
    MUSIXQUARE_SERVICE_CONTROL: createAtomicRateControlBinding().binding,
  };
  vi.mocked(handleAdminTranslationCommunityRequest)
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ reached: 'admin' }, { headers: { 'Cache-Control': 'no-store' } }),
    );
  vi.mocked(handleTranslationCommunityRequest)
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ reached: 'public' }, { headers: { 'Cache-Control': 'no-store' } }),
    );
});

afterEach(() => {
  clearServiceMaintenanceCacheForTests();
  vi.useRealTimers();
});

describe('translation routes retain App admin authority', () => {
  it.each(['/api/admin/translations', '/api/admin/translations/export'])(
    'blocks anonymous %s before the endpoint can read review data',
    async (pathname) => {
      const response = await appWorker.fetch(new Request(`${origin}${pathname}`), env);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' });
      expect(handleAdminTranslationCommunityRequest).not.toHaveBeenCalled();
      expect(handleTranslationCommunityRequest).not.toHaveBeenCalled();
    },
  );

  it('admits an actual login-issued cookie for both the review list and approved export', async () => {
    const cookie = await login();
    for (const pathname of ['/api/admin/translations', '/api/admin/translations/export']) {
      const request = new Request(`${origin}${pathname}`, { headers: { Cookie: cookie } });
      const response = await appWorker.fetch(request, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ reached: 'admin' });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(handleAdminTranslationCommunityRequest).toHaveBeenLastCalledWith(
        request,
        env,
        new URL(request.url),
      );
    }
    expect(handleAdminTranslationCommunityRequest).toHaveBeenCalledTimes(2);
    expect(handleTranslationCommunityRequest).not.toHaveBeenCalled();
  });

  it('rejects tampered and expired login cookies before entering the admin endpoint', async () => {
    const cookie = await login();
    const tampered = await appWorker.fetch(
      new Request(`${origin}/api/admin/translations/export`, {
        headers: { Cookie: `${cookie}x` },
      }),
      env,
    );
    expect(tampered.status).toBe(401);
    const token = cookie.slice(cookie.indexOf('=') + 1);
    const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as {
      exp: number;
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date((payload.exp + 1) * 1000));
    const expired = await appWorker.fetch(
      new Request(`${origin}/api/admin/translations`, {
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(expired.status).toBe(401);
    expect(handleAdminTranslationCommunityRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['missing CSRF', { 'X-MXQR-Admin-CSRF': '' }, 403],
    ['cross-origin', { Origin: 'https://unrelated.invalid' }, 403],
    ['non-JSON', { 'Content-Type': 'text/plain' }, 415],
  ] as const)(
    'blocks %s review even with a valid admin cookie',
    async (_label, changedHeaders, status) => {
      const cookie = await login();
      const response = await appWorker.fetch(
        new Request(`${origin}${reviewPath}`, {
          method: 'POST',
          headers: { ...mutationHeaders(cookie), ...changedHeaders },
          body: JSON.stringify({ status: 'approved', expectedRevision: 1 }),
        }),
        env,
      );
      expect(response.status).toBe(status);
      expect(handleAdminTranslationCommunityRequest).not.toHaveBeenCalled();
    },
  );

  it('routes a legitimate JSON review after actual session and CSRF checks', async () => {
    const cookie = await login();
    const request = new Request(`${origin}${reviewPath}`, {
      method: 'POST',
      headers: mutationHeaders(cookie),
      body: JSON.stringify({ status: 'approved', expectedRevision: 1 }),
    });
    const response = await appWorker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reached: 'admin' });
    expect(handleAdminTranslationCommunityRequest).toHaveBeenCalledExactlyOnceWith(
      request,
      env,
      new URL(request.url),
    );
    expect(handleTranslationCommunityRequest).not.toHaveBeenCalled();
  });

  it('does not route a GET review or DELETE export as an admin mutation', async () => {
    const cookie = await login();
    for (const [pathname, method] of [
      [reviewPath, 'GET'],
      ['/api/admin/translations/export', 'DELETE'],
    ]) {
      const response = await appWorker.fetch(
        new Request(`${origin}${pathname}`, { method, headers: mutationHeaders(cookie) }),
        env,
      );
      expect(response.status).toBe(405);
    }
    expect(handleAdminTranslationCommunityRequest).not.toHaveBeenCalled();
  });

  it('keeps anonymous public browsing on the separately gated community route', async () => {
    const request = new Request(`${origin}/api/translations/suggestions?locale=fr`);
    const response = await appWorker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reached: 'public' });
    expect(handleTranslationCommunityRequest).toHaveBeenCalledExactlyOnceWith(
      request,
      env,
      new URL(request.url),
    );
    expect(handleAdminTranslationCommunityRequest).not.toHaveBeenCalled();
  });
});

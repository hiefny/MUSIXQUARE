import { afterEach, describe, expect, it, vi } from 'vitest';

type RemoteShareWorker = {
  default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
};

const workerModule = (await import('../../../cloudflare/remote-share-worker.js')) as RemoteShareWorker;
const ORIGIN = 'https://musixquare.com';
const SIGNING_SECRET = 'remote-share-signing-secret-for-tests';
const CAPABILITY_SECRET = 'remote-share-capability-secret-for-tests';
const CLIENT_IP = '203.0.113.7';

function base64UrlEncode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

async function createCapabilityToken(scopes = ['remote-share']): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    scopes,
    iat: now,
    exp: now + 600,
    ip: await hmacSha256(CAPABILITY_SECRET, `ip:${CLIENT_IP}`),
    method: 'test',
  };
  const payloadPart = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSha256(CAPABILITY_SECRET, payloadPart);
  return `${payloadPart}.${signature}`;
}

function env(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    REMOTE_SHARE_SIGNING_SECRET: SIGNING_SECRET,
    ...extra,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('origin', ORIGIN);
  return new Request(`https://share.musixquare.com${path}`, {
    ...init,
    headers,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('remote-share Worker capability gate', () => {
  it('reports whether session capability is required', async () => {
    const response = await workerModule.default.fetch(
      request('/security-config'),
      env({ MXQR_CAPABILITY_SECRET: CAPABILITY_SECRET }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      capabilityRequired: true,
      scope: 'remote-share',
    });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('fails closed when capability secret is missing in production', async () => {
    // Match the app Worker policy: missing capability configuration blocks the
    // session endpoint unless the explicit unguarded override is enabled.
    const response = await workerModule.default.fetch(
      request('/session', { method: 'POST', body: 'not-json' }),
      env(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'CAPABILITY_NOT_CONFIGURED' });
  });

  it('allows /session without capability when MXQR_ALLOW_UNGUARDED_REMOTE_SHARE is set', async () => {
    const response = await workerModule.default.fetch(
      request('/session', { method: 'POST', body: 'not-json' }),
      env({ MXQR_ALLOW_UNGUARDED_REMOTE_SHARE: 'true' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid json' });
  });

  it('requires a valid remote-share capability token when configured', async () => {
    const response = await workerModule.default.fetch(
      request('/session', { method: 'POST', body: 'not-json' }),
      env({ MXQR_CAPABILITY_SECRET: CAPABILITY_SECRET }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'CAPABILITY_REQUIRED' });
  });

  it('accepts an app-issued remote-share capability token for session requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00.000Z'));
    const token = await createCapabilityToken();
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        body: 'not-json',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'x-mxqr-capability': token,
        },
      }),
      env({ MXQR_CAPABILITY_SECRET: CAPABILITY_SECRET }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid json' });
  });

  it('rejects oversized session JSON after capability verification', async () => {
    const token = await createCapabilityToken();
    const response = await workerModule.default.fetch(
      request('/session', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': CLIENT_IP,
          'content-type': 'application/json',
          'x-mxqr-capability': token,
        },
        body: JSON.stringify({ roomId: 'room', padding: 'x'.repeat(8192) }),
      }),
      env({ MXQR_CAPABILITY_SECRET: CAPABILITY_SECRET }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'request body too large' });
  });

  it('rejects oversized completion JSON before token verification', async () => {
    const response = await workerModule.default.fetch(
      request('/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'room', padding: 'x'.repeat(8192) }),
      }),
      env({ REMOTE_SHARE_BUCKET: {} }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'request body too large' });
  });
});

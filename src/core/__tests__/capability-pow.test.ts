/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function hasLeadingZeroBits(bytes: Uint8Array, difficulty: number): boolean {
  let remaining = difficulty;
  for (const byte of bytes) {
    if (remaining <= 0) return true;
    const bits = Math.min(8, remaining);
    if ((byte & (0xff << (8 - bits))) !== 0) return false;
    remaining -= bits;
  }
  return remaining <= 0;
}

describe('capability proof-of-work client', () => {
  it('solves PoW transparently and caches only the exact requested scope', async () => {
    const challenge = 'test-stateless-challenge.signature';
    const difficulty = 8;
    const challengeScopes: string[][] = [];
    const tokenScopes: string[][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/security-config')) {
        return Response.json({
          capabilityRequired: true,
          turnstileSiteKey: '',
          turnstileRequired: false,
          proofOfWorkRequired: true,
          proofOfWorkDifficulty: difficulty,
          proofOfWorkTtl: 120,
          inferredFallback: false,
          ttl: 600,
        });
      }
      if (url.endsWith('/api/capability-challenge')) {
        const body = JSON.parse(String(init?.body)) as { scopes: string[] };
        challengeScopes.push(body.scopes);
        return Response.json({
          challenge,
          difficulty,
          expiresAt: Math.floor(Date.now() / 1000) + 120,
          algorithm: 'sha256-leading-zero-bits',
        });
      }
      if (url.endsWith('/api/capability-token')) {
        const body = JSON.parse(String(init?.body)) as {
          scopes: string[];
          proofOfWork?: { challenge?: string; solution?: string };
        };
        tokenScopes.push(body.scopes);
        expect(body.proofOfWork?.challenge).toBe(challenge);
        const digest = new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(
              `mxqr-pow-v1:${challenge}:${body.proofOfWork?.solution || ''}`,
            ),
          ),
        );
        expect(hasLeadingZeroBits(digest, difficulty)).toBe(true);
        return Response.json({
          token: `capability-${body.scopes.join(',')}`,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        });
      }
      if (url.endsWith('/api/get-turn-config')) {
        expect(new Headers(init?.headers).get('X-MXQR-Capability')).toBe('capability-turn');
        return Response.json({ provider: 'cloudflare', iceServers: [] });
      }
      if (url.endsWith('/api/cloudflare-realtime')) {
        expect(new Headers(init?.headers).get('X-MXQR-Capability')).toBe('capability-realtime');
        return Response.json({ ok: true });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchWithCapability } = await import('../capability.ts');
    const response = await fetchWithCapability('/api/get-turn-config', 'turn');
    const cachedTurn = await fetchWithCapability('/api/get-turn-config', 'turn');
    const realtime = await fetchWithCapability('/api/cloudflare-realtime', 'realtime');

    expect(response.status).toBe(200);
    expect(cachedTurn.status).toBe(200);
    expect(realtime.status).toBe(200);
    expect(challengeScopes).toEqual([['turn'], ['realtime']]);
    expect(tokenScopes).toEqual([['turn'], ['realtime']]);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/security-config',
      '/api/capability-challenge',
      '/api/capability-token',
      '/api/get-turn-config',
      '/api/get-turn-config',
      '/api/capability-challenge',
      '/api/capability-token',
      '/api/cloudflare-realtime',
    ]);
    expect(document.querySelector('#mxqr-turnstile-container')).toBeNull();
  });
});

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
  it('solves one transparent PoW and reuses its bundle token for YouTube and remote share', async () => {
    const challenge = 'test-stateless-challenge.signature';
    const difficulty = 8;
    const expectedScopes = ['realtime', 'remote-share', 'turn', 'youtube-search'];
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
        return Response.json({ token: 'capability-bundle', expiresAt: Date.now() / 1000 + 600 });
      }
      if (url.endsWith('/api/youtube-search?q=test')) {
        expect(new Headers(init?.headers).get('X-MXQR-Capability')).toBe('capability-bundle');
        return Response.json({ results: [] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchWithCapability, getCapabilityHeaders } = await import('../capability.ts');
    await expect(
      fetchWithCapability('/api/youtube-search?q=test', 'youtube-search'),
    ).resolves.toMatchObject({ status: 200 });
    await expect(getCapabilityHeaders('/api/capability-token', ['remote-share'])).resolves.toEqual({
      'X-MXQR-Capability': 'capability-bundle',
    });

    expect(challengeScopes).toEqual([expectedScopes]);
    expect(tokenScopes).toEqual([expectedScopes]);
    expect(document.querySelector('#mxqr-turnstile-container')).toBeNull();
  });

  it('stops proof-of-work after the current batch when its upload is aborted', async () => {
    const controller = new AbortController();
    let tokenRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/security-config')) {
          return Response.json({
            capabilityRequired: true,
            turnstileSiteKey: '',
            turnstileRequired: false,
            proofOfWorkRequired: true,
            proofOfWorkDifficulty: 24,
            proofOfWorkTtl: 120,
            ttl: 600,
          });
        }
        if (url.endsWith('/api/capability-challenge')) {
          return Response.json({
            challenge: 'abortable-challenge.signature',
            difficulty: 24,
            expiresAt: Math.floor(Date.now() / 1000) + 120,
            algorithm: 'sha256-leading-zero-bits',
          });
        }
        if (url.endsWith('/api/capability-token')) tokenRequests += 1;
        return new Response('unexpected', { status: 500 });
      }),
    );
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async () => {
      controller.abort();
      return new Uint8Array(32).fill(0xff).buffer;
    });

    const { getCapabilityHeaders } = await import('../capability.ts');
    await expect(
      getCapabilityHeaders('/api/capability-token', ['remote-share'], controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(digest).toHaveBeenCalledTimes(64);
    expect(tokenRequests).toBe(0);
  });

  it('settles an aborting caller without cancelling a shared Turnstile execution', async () => {
    const controller = new AbortController();
    let rejectTurnstile!: () => void;
    const turnstile = {
      render: vi.fn(
        (_container: HTMLElement, options: { 'error-callback': () => void }): string => {
          rejectTurnstile = () => options['error-callback']();
          return 'widget-1';
        },
      ),
      execute: vi.fn(),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal('turnstile', turnstile);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/security-config')) {
          return Response.json({
            capabilityRequired: true,
            turnstileSiteKey: 'test-site-key',
            turnstileRequired: true,
            proofOfWorkRequired: false,
            proofOfWorkDifficulty: 0,
            proofOfWorkTtl: 0,
            ttl: 600,
          });
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { getCapabilityHeaders } = await import('../capability.ts');
    const pending = getCapabilityHeaders('/api/capability-token', ['turn'], controller.signal);
    await vi.waitFor(() => expect(turnstile.execute).toHaveBeenCalledOnce());

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(turnstile.remove).not.toHaveBeenCalled();

    // Finish the shared widget promise so the test leaves no live timeout.
    rejectTurnstile();
    await Promise.resolve();
  });

  it('refuses silent warmup when Turnstile could become interactive', async () => {
    const existingTurnstileContainer = document.querySelector('#mxqr-turnstile-container');
    const existingTurnstileScripts = document.querySelectorAll(
      'script[src*="challenges.cloudflare.com"]',
    ).length;
    const tokenRequest = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/security-config')) {
          return Response.json({
            capabilityRequired: true,
            turnstileSiteKey: 'interactive-site-key',
            turnstileRequired: false,
            proofOfWorkRequired: false,
            proofOfWorkDifficulty: 0,
            proofOfWorkTtl: 0,
            ttl: 600,
          });
        }
        tokenRequest();
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { warmCapabilitySilently } = await import('../capability.ts');
    await expect(warmCapabilitySilently('/api/get-turn-config', ['turn'])).resolves.toBe(false);

    expect(tokenRequest).not.toHaveBeenCalled();
    expect(document.querySelector('#mxqr-turnstile-container')).toBe(existingTurnstileContainer);
    expect(document.querySelectorAll('script[src*="challenges.cloudflare.com"]')).toHaveLength(
      existingTurnstileScripts,
    );
  });

  it('shares a silent mint with an explicit caller while isolating caller abort', async () => {
    let resolveToken!: (response: Response) => void;
    const tokenResponse = new Promise<Response>((resolve) => {
      resolveToken = resolve;
    });
    let tokenRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/security-config')) {
          return Response.json({
            capabilityRequired: true,
            turnstileSiteKey: '',
            turnstileRequired: false,
            proofOfWorkRequired: false,
            proofOfWorkDifficulty: 0,
            proofOfWorkTtl: 0,
            ttl: 600,
          });
        }
        if (url.endsWith('/api/capability-token')) {
          tokenRequests += 1;
          return tokenResponse;
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { getCapabilityHeaders, warmCapabilitySilently } = await import('../capability.ts');
    const warmup = warmCapabilitySilently('/api/get-turn-config', ['turn']);
    await vi.waitFor(() => expect(tokenRequests).toBe(1));

    const controller = new AbortController();
    const explicit = getCapabilityHeaders('/api/get-turn-config', ['turn'], controller.signal);
    controller.abort();
    await expect(explicit).rejects.toMatchObject({ name: 'AbortError' });

    resolveToken(Response.json({ token: 'warm-bundle', expiresAt: Date.now() / 1000 + 600 }));
    await expect(warmup).resolves.toBe(true);
    expect(tokenRequests).toBe(1);
    await expect(getCapabilityHeaders('/api/get-turn-config', ['turn'])).resolves.toEqual({
      'X-MXQR-Capability': 'warm-bundle',
    });
  });

  it('does not let the silent warmup deadline cancel a shared caller mint', async () => {
    vi.useFakeTimers();
    let resolveToken!: (response: Response) => void;
    const tokenResponse = new Promise<Response>((resolve) => {
      resolveToken = resolve;
    });
    let tokenRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/security-config')) {
          return Response.json({
            capabilityRequired: true,
            turnstileSiteKey: '',
            turnstileRequired: false,
            proofOfWorkRequired: false,
            proofOfWorkDifficulty: 0,
            proofOfWorkTtl: 0,
            ttl: 600,
          });
        }
        if (url.endsWith('/api/capability-token')) {
          tokenRequests += 1;
          return tokenResponse;
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { getCapabilityHeaders, warmCapabilitySilently } = await import('../capability.ts');
    const warmup = warmCapabilitySilently('/api/get-turn-config', ['turn']);
    await vi.waitFor(() => expect(tokenRequests).toBe(1));
    const explicit = getCapabilityHeaders('/api/get-turn-config', ['turn']);

    await vi.advanceTimersByTimeAsync(8_000);
    await expect(warmup).resolves.toBe(false);

    resolveToken(Response.json({ token: 'shared-bundle', expiresAt: Date.now() / 1000 + 600 }));
    await expect(explicit).resolves.toEqual({
      'X-MXQR-Capability': 'shared-bundle',
    });
    expect(tokenRequests).toBe(1);
    vi.useRealTimers();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTextWithTimeout,
  handleAccountAuthRequest,
} from '../../../cloudflare/account-auth.ts';

function configuredAuthEnv(): Record<string, unknown> {
  return {
    MUSIXQUARE_AUTH_DB: { prepare: vi.fn() },
    GOOGLE_OAUTH_CLIENT_ID: 'google-client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret',
    MXQR_AUTH_SESSION_PEPPER: 's'.repeat(32),
    MXQR_AUTH_SUBJECT_PEPPER: 'u'.repeat(32),
    MXQR_OAUTH_STATE_SECRET: 'o'.repeat(32),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('account-auth Google request lifetime', () => {
  it('rejects an unsupported profile method without reading a request body', async () => {
    const response = await handleAccountAuthRequest(
      new Request('https://musixquare.com/api/auth/profile', {
        method: 'GET',
        headers: { origin: 'https://musixquare.com' },
      }),
      configuredAuthEnv(),
    );

    expect(response?.status).toBe(405);
    expect(response?.headers.get('allow')).toBe('PATCH');
    await expect(response?.json()).resolves.toEqual({ error: 'METHOD_NOT_ALLOWED' });
  });

  it('settles stalled response headers and cancels a response that arrives after timeout', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? null;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      }),
    );

    const pending = fetchTextWithTimeout('https://oauth2.googleapis.test/token', {}, 1024, 1_000);
    const rejection = expect(pending).rejects.toThrow('Google response timed out');
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);

    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    resolveFetch({ body: { cancel } } as unknown as Response);
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('settles a stalled response body without awaiting non-cooperative cancellation', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      }),
    );
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response));

    const pending = fetchTextWithTimeout(
      'https://www.googleapis.test/oauth2/v3/certs',
      {},
      1024,
      1_000,
    );
    const rejection = expect(pending).rejects.toThrow('Google response timed out');
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['invalid', '8193'])(
    'cancels an unread request body for rejected Content-Length %s',
    async (contentLength) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      });
      const request = new Request('https://musixquare.com/api/auth/profile', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'content-length': contentLength,
          origin: 'https://musixquare.com',
          'x-mxqr-account-csrf': '1',
        },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });

      const response = await handleAccountAuthRequest(request, configuredAuthEnv());

      expect(response?.status).toBe(400);
      await expect(response?.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
});

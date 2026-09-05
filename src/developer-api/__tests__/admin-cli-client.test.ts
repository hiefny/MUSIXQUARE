import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminCliClient,
  isAdminCliTransportFailure,
} from '../../../scripts/admin-cli-client.mts';

afterEach(() => vi.useRealTimers());

describe('shared operator CLI response bounds', () => {
  function client(response: Response) {
    return createAdminCliClient({
      origin: 'https://musixquare.com',
      env: { MXQR_ADMIN_SESSION_COOKIE: 'fixture.signature' },
      fetcher: vi.fn(async () => response),
    });
  }

  it('rejects excess UTF-8 bytes before buffering an unbounded body', async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode(`"${'😀'.repeat(270_000)}"`);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
        },
        cancel,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    await expect(client(response).request('/api/admin/session')).rejects.toThrow('safe size limit');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds a non-cooperative response stream and classifies transport loss without body disclosure', async () => {
    vi.useFakeTimers();
    const response = new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    const result = client(response)
      .request('/api/admin/session')
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await result;
    expect(isAdminCliTransportFailure(error)).toBe(true);
    expect(error).toMatchObject({ message: 'Admin request returned an unreadable response' });
  });

  it('does not include raw server text or credential-shaped errors in exceptions', async () => {
    const response = Response.json({ error: 'mxqr_live_secret-material' }, { status: 500 });
    await expect(client(response).request('/api/admin/session')).rejects.toThrow(
      '500 REQUEST_FAILED',
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let appWorker: typeof import('../../../cloudflare/app-worker.ts').default;
let log = vi.fn<(...args: unknown[]) => void>();

beforeEach(async () => {
  // The facade deliberately shares its bounded diagnostic budget per isolate.
  // A fresh module models a fresh isolate so tests do not consume each other's slots.
  vi.resetModules();
  appWorker = (await import('../../../cloudflare/app-worker.ts')).default;
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  log = vi.fn<(...args: unknown[]) => void>();
  vi.spyOn(console, 'log').mockImplementation(log);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function request(suffix = '/presence/enter') {
  return new Request(`https://musixquare.com/api/pro-room/v1/rooms/002026${suffix}`, {
    method: 'POST',
    headers: {
      Origin: 'https://musixquare.com',
      'Content-Type': 'application/json',
      Cookie: '__Host-mxqr_pro_002026_session=private-cookie',
      Authorization: 'Bearer private-token',
      'CF-Connecting-IP': '203.0.113.190',
      'X-MXQR-Pro-Room-Generation': '999999',
    },
    body: JSON.stringify({ requestId: 'session-create-request-0001', pin: 'private-pin' }),
  });
}

function events() {
  return log.mock.calls
    .map(([record]) => record as Record<string, unknown>)
    .filter((record) => record.diagnostic === 'pro_room' && record.kind === 'event');
}

function expectPrivateDataAbsent() {
  expect(JSON.stringify(log.mock.calls)).not.toMatch(
    /private|203\.0\.113\.190|Bearer|999999|https:\/\/|participantId|Cookie|Authorization/,
  );
}

describe('App PRO facade structured failure diagnostics', () => {
  it('classifies a rejected service fetch without trusting caller generation or inventing release identity', async () => {
    const response = await appWorker.fetch(request(), {
      PRO_ROOM_PUBLIC_API: {
        fetch: vi.fn(async () => {
          throw new Error('private-upstream https://private.example/?token=private-token');
        }),
      },
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'PRO_ROOM_API_UNAVAILABLE' });
    expect(events()).toEqual([
      expect.objectContaining({
        scope: 'app',
        roomCode: '002026',
        roomGeneration: null,
        // App has no version metadata binding; provider log metadata supplies
        // deployment identity. Do not claim a custom release ID is available.
        versionId: null,
        event: 'upstream_failure',
        operation: 'presence_enter',
        reason: 'fetch',
        status: 502,
      }),
    ]);
    expectPrivateDataAbsent();
  });

  it('emits one response timeout and does not duplicate it when the fetch later rejects', async () => {
    let rejectLate!: (error: Error) => void;
    let upstreamSignal: AbortSignal | null = null;
    const pending = appWorker.fetch(request('/presence/heartbeat'), {
      PRO_ROOM_PUBLIC_API: {
        fetch: vi.fn((resource) => {
          upstreamSignal = (resource as Request).signal;
          return new Promise<Response>((_resolve, reject) => {
            rejectLate = reject;
          });
        }),
      },
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).status).toBe(502);
    expect((upstreamSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(events()).toEqual([
      expect.objectContaining({
        event: 'upstream_timeout',
        reason: 'response',
        operation: 'heartbeat',
      }),
    ]);
    rejectLate(new Error('private-late-rejection'));
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toHaveLength(1);
    expectPrivateDataAbsent();
  });

  it('cancels a late response body after timeout without emitting another failure', async () => {
    let resolveLate!: (response: Response) => void;
    const pending = appWorker.fetch(request('/presence/enter'), {
      PRO_ROOM_PUBLIC_API: {
        fetch: vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              resolveLate = resolve;
            }),
        ),
      },
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).status).toBe(502);
    const cancel = vi.fn();
    resolveLate(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ event: 'upstream_timeout', reason: 'response' });
    expectPrivateDataAbsent();
  });

  it('distinguishes a stalled body deadline from waiting for response headers', async () => {
    const cancel = vi.fn();
    const pending = appWorker.fetch(request('/presence/heartbeat'), {
      PRO_ROOM_PUBLIC_API: {
        fetch: vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"private":'));
                },
                cancel,
              }),
            ),
        ),
      },
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
    expect(events()).toEqual([
      expect.objectContaining({
        event: 'upstream_timeout',
        reason: 'body',
        operation: 'heartbeat',
      }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(events()).toHaveLength(1);
    expectPrivateDataAbsent();
  });

  it.each(['stream', 'utf8'] as const)(
    'classifies invalid %s bodies without their contents',
    async (kind) => {
      const response = await appWorker.fetch(request('/presence/close'), {
        PRO_ROOM_PUBLIC_API: {
          fetch: vi.fn(async () =>
            kind === 'utf8'
              ? new Response(new Uint8Array([0xc3, 0x28]))
              : new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.error(new Error('private-body-error'));
                    },
                  }),
                ),
          ),
        },
      });
      expect(response.status).toBe(502);
      expect(events()).toEqual([
        expect.objectContaining({
          event: 'upstream_failure',
          reason: 'body',
          operation: 'presence_close',
        }),
      ]);
      expectPrivateDataAbsent();
    },
  );

  it('leaves successful proxy responses silent and clears the deadline', async () => {
    const response = await appWorker.fetch(request('/presence/heartbeat'), {
      PRO_ROOM_PUBLIC_API: { fetch: vi.fn(async () => Response.json({ ok: true })) },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(events()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events()).toEqual([]);
  });

  it('preserves the public failure response even when the diagnostic logger throws', async () => {
    log.mockImplementation(() => {
      throw new Error('private-logger-failure');
    });
    const response = await appWorker.fetch(request(), {
      PRO_ROOM_PUBLIC_API: {
        fetch: vi.fn(async () => {
          throw new Error('private-upstream');
        }),
      },
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'PRO_ROOM_API_UNAVAILABLE' });
  });
});

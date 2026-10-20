import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import appWorker from '../../../cloudflare/app-worker.ts';
import {
  mintStandardSignalingCapability,
  StandardHttpBridgeSmokeClient,
} from '../../../scripts/live-standard-http-signaling-smoke.mts';
import { createAtomicRateControlBinding } from './service-control-rate-limit-fixture.ts';

const CLIENT_IP = '203.0.113.231';
const RAY_ID = '8d1f2c3b4a5e6f70-ORD';
const ROOM_ID = '654321';
const PEER_ID = 'http-host-private1';

type BridgeOperation = 'open' | 'send' | 'poll' | 'close';
type BridgeHandler = (operation: BridgeOperation, request: Request) => Promise<Response>;

let errorLog = vi.fn<(...args: unknown[]) => void>();
let capability = '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  errorLog = vi.fn<(...args: unknown[]) => void>();
  vi.spyOn(console, 'error').mockImplementation(errorLog);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Runs the release smoke client against the real App Worker in-process. The
 * signaling bridge object is the only stub, as in production where every open
 * reaches a fresh object through the PRO_SIGNALING_ROOMS binding.
 */
async function connectSmokeToApp(handler: BridgeHandler): Promise<void> {
  const env = {
    MXQR_CAPABILITY_SECRET: 'standard-bridge-diagnostic-secret-at-least-32',
    MXQR_TURNSTILE_DISABLED: 'true',
    MXQR_CAPABILITY_POW_DIFFICULTY: '8',
    MUSIXQUARE_SERVICE_CONTROL: createAtomicRateControlBinding().binding,
    PRO_SIGNALING_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (request: Request) =>
          handler(new URL(request.url).pathname.split('/').pop() as BridgeOperation, request),
      }),
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      // Cloudflare adds the client IP to the request, and the same Ray ID to
      // the request the App Worker sees and to the response the client sees.
      const headers = new Headers(init?.headers);
      headers.set('CF-Connecting-IP', CLIENT_IP);
      headers.set('CF-Ray', RAY_ID);
      const response = await appWorker.fetch(
        new Request(String(input), {
          method: init?.method ?? 'GET',
          headers,
          body: init?.body ?? null,
        }),
        env,
      );
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('cf-ray', RAY_ID);
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    }),
  );
  capability = await mintStandardSignalingCapability();
}

function openHost() {
  return StandardHttpBridgeSmokeClient.open(capability, {
    roomId: ROOM_ID,
    role: 'host',
    peerId: PEER_ID,
  });
}

async function failureOf(operation: Promise<unknown>): Promise<string> {
  const failure: unknown = await operation.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  return (failure as Error).message;
}

function diagnostics() {
  return errorLog.mock.calls
    .map(([record]) => record as Record<string, unknown>)
    .filter((record) => record?.diagnostic === 'standard_signaling_bridge');
}

function diagnostic(overrides: Record<string, unknown>) {
  return {
    diagnostic: 'standard_signaling_bridge',
    schema: 1,
    operation: 'open',
    reason: 'fetch',
    status: 502,
    upstreamStatus: null,
    upstreamContentType: null,
    upstreamError: null,
    errorType: null,
    retryable: false,
    overloaded: false,
    remote: false,
    elapsedMs: 0,
    timeoutMs: 5_000,
    rayId: RAY_ID,
    ...overrides,
  };
}

function expectIdentifiersAbsent() {
  const logged = JSON.stringify(errorLog.mock.calls);
  for (const value of [ROOM_ID, PEER_ID, CLIENT_IP, capability, 'Bearer', 'private', '://']) {
    expect(logged).not.toContain(value);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('Standard HTTPS signaling bridge failure diagnostics', () => {
  it('names the operation, reason and error code on both sides when the bridge object call is rejected', async () => {
    await connectSmokeToApp(async () => {
      throw Object.assign(new Error(`private room ${ROOM_ID} peer ${PEER_ID}`), {
        retryable: true,
      });
    });

    const message = await failureOf(openHost());

    expect(message).toBe(
      'HTTP signaling bridge open failed (role=host; HTTP 502; ' +
        `code=STANDARD_SIGNALING_BRIDGE_UNAVAILABLE; elapsedMs=0; ray=${RAY_ID})`,
    );
    expect(diagnostics()).toEqual([
      diagnostic({ reason: 'fetch', errorType: 'Error', retryable: true }),
    ]);
    expect(errorLog).toHaveBeenCalledOnce();
    expectIdentifiersAbsent();
  });

  it('records one 5 s open timeout with the elapsed time on both sides', async () => {
    const reached = deferred();
    await connectSmokeToApp(() => {
      reached.resolve();
      return new Promise<Response>(() => undefined);
    });

    const opening = failureOf(openHost());
    await reached.promise;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await opening).toBe(
      'HTTP signaling bridge open failed (role=host; HTTP 502; ' +
        `code=STANDARD_SIGNALING_BRIDGE_UNAVAILABLE; elapsedMs=5000; ray=${RAY_ID})`,
    );
    expect(diagnostics()).toEqual([diagnostic({ reason: 'response_timeout', elapsedMs: 5_000 })]);
    expectIdentifiersAbsent();
  });

  it.each([
    [502, 'STANDARD_HTTP_BRIDGE_UPSTREAM_REJECTED', 'STANDARD_HTTP_BRIDGE_UPSTREAM_REJECTED'],
    [502, 'STANDARD_HTTP_BRIDGE_UPSTREAM_UNAVAILABLE', 'STANDARD_HTTP_BRIDGE_UPSTREAM_UNAVAILABLE'],
    [503, `private room ${ROOM_ID}`, 'unknown'],
  ])(
    'passes a bridge object HTTP %i through and records its allowlisted code',
    async (status, error, code) => {
      await connectSmokeToApp(async () => Response.json({ error }, { status }));

      const message = await failureOf(openHost());

      expect(message).toBe(
        `HTTP signaling bridge open failed (role=host; HTTP ${status}; code=${code}; ` +
          `elapsedMs=0; ray=${RAY_ID})`,
      );
      expect(diagnostics()).toEqual([
        diagnostic({
          reason: 'upstream_status',
          status,
          upstreamStatus: status,
          upstreamContentType: 'application/json',
          upstreamError: code,
        }),
      ]);
      expectIdentifiersAbsent();
    },
  );

  it.each([
    [
      'an HTML error page',
      () =>
        new Response('<html>private</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
      'STANDARD_SIGNALING_BRIDGE_INVALID_RESPONSE',
      { reason: 'content_type', upstreamStatus: 502, upstreamContentType: 'text/html' },
    ],
    [
      'a body without a content type',
      () => new Response(new TextEncoder().encode('private'), { status: 500 }),
      'STANDARD_SIGNALING_BRIDGE_INVALID_RESPONSE',
      { reason: 'content_type', upstreamStatus: 500, upstreamContentType: 'none' },
    ],
    [
      'a malformed content type',
      () => new Response('{}', { status: 500, headers: { 'Content-Type': 'private://value' } }),
      'STANDARD_SIGNALING_BRIDGE_INVALID_RESPONSE',
      { reason: 'content_type', upstreamStatus: 500, upstreamContentType: 'invalid' },
    ],
    [
      'invalid UTF-8',
      () =>
        new Response(new Uint8Array([0xc3, 0x28]), {
          headers: { 'Content-Type': 'application/json' },
        }),
      'STANDARD_SIGNALING_BRIDGE_UNAVAILABLE',
      { reason: 'invalid_utf8', upstreamStatus: 200, upstreamContentType: 'application/json' },
    ],
    [
      'a body that fails mid-read',
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('private-body-error'));
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      'STANDARD_SIGNALING_BRIDGE_UNAVAILABLE',
      { reason: 'body', errorType: 'Error' },
    ],
    [
      'an oversized body',
      () =>
        new Response(new Uint8Array(97 * 1024), {
          headers: { 'Content-Type': 'application/json' },
        }),
      'STANDARD_SIGNALING_BRIDGE_UNAVAILABLE',
      { reason: 'body', errorType: 'ResponseBodyTooLargeError' },
    ],
  ])('classifies %s without its contents', async (_label, response, code, expected) => {
    await connectSmokeToApp(async () => response());

    const message = await failureOf(openHost());

    expect(message).toBe(
      `HTTP signaling bridge open failed (role=host; HTTP 502; code=${code}; ` +
        `elapsedMs=0; ray=${RAY_ID})`,
    );
    expect(diagnostics()).toEqual([diagnostic(expected)]);
    expectIdentifiersAbsent();
  });

  it('keeps provider error flags but not an unrecognized error name', async () => {
    await connectSmokeToApp(async () => {
      throw Object.assign(new Error('private overload'), {
        name: 'private-error-name',
        overloaded: true,
        remote: true,
      });
    });

    await failureOf(openHost());

    expect(diagnostics()).toEqual([
      diagnostic({ reason: 'fetch', errorType: 'unknown', overloaded: true, remote: true }),
    ]);
    expectIdentifiersAbsent();
  });

  it('measures a stalled poll body against the 18 s poll deadline', async () => {
    const reached = deferred();
    await connectSmokeToApp(async (operation) => {
      if (operation === 'open') return Response.json({ ok: true });
      reached.resolve();
      return new Response(new ReadableStream<Uint8Array>(), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = await openHost();

    const polling = failureOf(client.poll(1_500));
    await reached.promise;
    await vi.advanceTimersByTimeAsync(18_000);

    expect(await polling).toBe(
      'HTTP signaling bridge poll failed (role=host; HTTP 502; ' +
        `code=STANDARD_SIGNALING_BRIDGE_UNAVAILABLE; elapsedMs=18000; ray=${RAY_ID})`,
    );
    expect(diagnostics()).toEqual([
      diagnostic({
        operation: 'poll',
        reason: 'body_timeout',
        elapsedMs: 18_000,
        timeoutMs: 18_000,
      }),
    ]);
    expectIdentifiersAbsent();
  });

  it('names send and close failures by their own operation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await connectSmokeToApp(async (operation) => {
      if (operation === 'open') return Response.json({ ok: true });
      if (operation === 'send') throw new TypeError('private send failure');
      return Response.json({ error: 'STANDARD_HTTP_BRIDGE_UNAVAILABLE' }, { status: 503 });
    });
    const client = await openHost();

    const message = await failureOf(client.send({ type: 'host-auth', secret: 'private-secret' }));
    await client.close();

    expect(message).toBe(
      'HTTP signaling bridge send failed (role=host; HTTP 502; cseq=1; frame=host-auth; ' +
        `code=STANDARD_SIGNALING_BRIDGE_UNAVAILABLE; elapsedMs=0; ray=${RAY_ID})`,
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'HTTP signaling bridge close failed (role=host; HTTP 503; ' +
        `code=STANDARD_HTTP_BRIDGE_UNAVAILABLE; elapsedMs=0; ray=${RAY_ID})`,
    );
    expect(diagnostics()).toEqual([
      diagnostic({ operation: 'send', reason: 'fetch', errorType: 'TypeError' }),
      diagnostic({
        operation: 'close',
        reason: 'upstream_status',
        status: 503,
        upstreamStatus: 503,
        upstreamContentType: 'application/json',
        upstreamError: 'STANDARD_HTTP_BRIDGE_UNAVAILABLE',
      }),
    ]);
    expectIdentifiersAbsent();
  });

  it('stays silent for successful traffic and 4xx protocol answers', async () => {
    await connectSmokeToApp(async (operation) => {
      if (operation === 'send') {
        return Response.json({ error: 'STANDARD_HTTP_BRIDGE_SEQUENCE_GAP' }, { status: 409 });
      }
      if (operation === 'poll') return Response.json({ v: 1, events: [] });
      return Response.json({ ok: true });
    });
    const client = await openHost();

    await expect(client.poll(0)).resolves.toEqual([]);
    expect(await failureOf(client.send({ type: 'host-auth' }))).toContain(
      'HTTP 409; cseq=1; frame=host-auth; code=STANDARD_HTTP_BRIDGE_SEQUENCE_GAP;',
    );
    await client.close();

    expect(errorLog).not.toHaveBeenCalled();
  });

  it('keeps the public failure response when the diagnostic logger throws', async () => {
    await connectSmokeToApp(async () => {
      throw new Error('private-upstream');
    });
    errorLog.mockImplementation(() => {
      throw new Error('private-logger-failure');
    });

    expect(await failureOf(openHost())).toContain(
      'HTTP 502; code=STANDARD_SIGNALING_BRIDGE_UNAVAILABLE;',
    );
    expect(errorLog).toHaveBeenCalledOnce();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  main,
  StandardHttpBridgeSmokeClient,
} from '../../../scripts/live-standard-http-signaling-smoke.mts';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

describe('live Standard HTTPS signaling smoke', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses separate ordered send and poll lanes without putting credentials in URLs', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const request = init ?? {};
      requests.push({ url, init: request });
      if (url.endsWith('/open')) return jsonResponse({ sessionToken: 'bridge.session.token' });
      if (url.endsWith('/send')) return jsonResponse({ v: 1, ack: 1 });
      if (url.endsWith('/poll')) {
        return jsonResponse({
          v: 1,
          events: [{ sseq: 1, data: JSON.stringify({ type: 'peer-open', roomId: '123456' }) }],
        });
      }
      if (url.endsWith('/close')) return jsonResponse({ ok: true });
      throw new Error(`Unexpected smoke URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = await StandardHttpBridgeSmokeClient.open('capability.token', {
      roomId: '123456',
      role: 'host',
      peerId: 'http-host-abcdef12',
    });
    await client.send({ type: 'host-auth', secret: 'never-in-url' });
    await expect(client.poll(250)).resolves.toEqual([{ type: 'peer-open', roomId: '123456' }]);
    await client.close();

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/standard-signaling/v1/bridge/open',
      '/api/standard-signaling/v1/bridge/send',
      '/api/standard-signaling/v1/bridge/poll',
      '/api/standard-signaling/v1/bridge/close',
    ]);
    expect(requests.every(({ url }) => !url.includes('never-in-url'))).toBe(true);
    expect(requests.every(({ url }) => !url.includes('bridge.session.token'))).toBe(true);

    const sendBody = JSON.parse(String(requests[1]?.init.body)) as Record<string, unknown>;
    expect(sendBody).toEqual({
      v: 1,
      cseq: 1,
      frame: JSON.stringify({ type: 'host-auth', secret: 'never-in-url' }),
    });
    const pollBody = JSON.parse(String(requests[2]?.init.body)) as Record<string, unknown>;
    expect(pollBody).toEqual({ v: 1, requestEpoch: 1, ack: 0, waitMs: 250 });
    expect(new Headers(requests[2]?.init.headers).get('Authorization')).toBe(
      'Bearer bridge.session.token',
    );
  });

  it('fails closed when bridge open adds an unrecognized response field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ sessionToken: 'bridge.session.token', expiresAt: 123 })),
    );

    await expect(
      StandardHttpBridgeSmokeClient.open('capability.token', {
        roomId: '123456',
        role: 'guest',
        peerId: 'http-guest-abcdef12',
      }),
    ).rejects.toThrow('bridge open failed');
  });

  it.each([
    ['RATE_LIMIT_UNAVAILABLE', 'guest-auth', 'RATE_LIMIT_UNAVAILABLE', 'guest-auth'],
    [
      'STANDARD_SIGNALING_BRIDGE_UNAVAILABLE',
      'host-auth',
      'STANDARD_SIGNALING_BRIDGE_UNAVAILABLE',
      'host-auth',
    ],
    ['Bearer private-token.password-4821', 'private-token.password-4821', 'unknown', 'unknown'],
    ['A'.repeat(5_000), 'guest-auth', 'unknown', 'guest-auth'],
  ])(
    'reports bounded send diagnostics without leaking credentials (%#)',
    async (rawCode, rawType, code, frameType) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ sessionToken: 'private-bridge-session' }))
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: rawCode,
              message: 'private-token.password-4821',
              authorization: 'Bearer private-bridge-session',
              pin: '4821',
            },
            503,
          ),
        );
      vi.stubGlobal('fetch', fetchMock);
      const client = await StandardHttpBridgeSmokeClient.open('private-capability', {
        roomId: '123456',
        role: 'guest',
        peerId: 'http-guest-abcdef12',
      });

      const failure: unknown = await client
        .send({
          type: rawType,
          password: '4821',
          reconnectSecret: 'private-reconnect-secret',
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(
        new RegExp(
          `^HTTP signaling bridge send failed \\(role=guest; HTTP 503; cseq=1; ` +
            `frame=${frameType}; code=${code}; elapsedMs=\\d+; ray=none\\)$`,
        ),
      );
      expect(message.length).toBeLessThan(200);
      for (const secret of ['private-', '4821', 'Bearer ', 'A'.repeat(100)]) {
        expect(message).not.toContain(secret);
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  describe('bridge failure lines', () => {
    const RAY_ID = '8d1f2c3b4a5e6f70-ORD';
    const SECRETS = [
      'private-capability',
      'private-bridge-session',
      'http-host-private',
      '654321',
      'private-detail',
    ];

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // Resolve after the given fake wall time, as a slow production edge would.
    function respondAfter(elapsedMs: number, response: () => Response) {
      return vi.fn(async () => {
        vi.advanceTimersByTime(elapsedMs);
        return response();
      });
    }

    function openHost() {
      return StandardHttpBridgeSmokeClient.open('private-capability', {
        roomId: '654321',
        role: 'host',
        peerId: 'http-host-private',
      });
    }

    function expectNoSecrets(message: string) {
      for (const secret of SECRETS) expect(message).not.toContain(secret);
    }

    it.each([
      ['STANDARD_SIGNALING_BRIDGE_UNAVAILABLE', 502, 'STANDARD_SIGNALING_BRIDGE_UNAVAILABLE'],
      [
        'STANDARD_SIGNALING_BRIDGE_INVALID_RESPONSE',
        502,
        'STANDARD_SIGNALING_BRIDGE_INVALID_RESPONSE',
      ],
      ['STANDARD_HTTP_BRIDGE_UPSTREAM_REJECTED', 502, 'STANDARD_HTTP_BRIDGE_UPSTREAM_REJECTED'],
      ['RATE_LIMIT_UNAVAILABLE', 503, 'RATE_LIMIT_UNAVAILABLE'],
      ['private-detail room 654321 peer http-host-private', 502, 'unknown'],
      [undefined, 502, 'none'],
    ])('names the open status, code %s, elapsed time and Ray ID', async (error, status, code) => {
      vi.stubGlobal(
        'fetch',
        respondAfter(5_012, () =>
          Response.json(
            error === undefined ? { ok: false } : { error, message: 'private-detail' },
            {
              status,
              headers: { 'cf-ray': RAY_ID },
            },
          ),
        ),
      );

      const failure: unknown = await openHost().catch((caught: unknown) => caught);

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toBe(
        `HTTP signaling bridge open failed (role=host; HTTP ${status}; code=${code}; ` +
          `elapsedMs=5012; ray=${RAY_ID})`,
      );
      expectNoSecrets(message);
    });

    it.each([
      [
        'an HTML edge error page',
        () =>
          new Response('<html>private-detail</html>', {
            status: 502,
            headers: { 'Content-Type': 'text/html', 'cf-ray': RAY_ID },
          }),
        `HTTP 502; code=non-json; elapsedMs=40; ray=${RAY_ID}`,
      ],
      [
        'an oversized body',
        () =>
          new Response(JSON.stringify({ error: 'x'.repeat(200 * 1024) }), {
            status: 502,
            headers: { 'cf-ray': 'private-detail' },
          }),
        'HTTP 502; code=oversized; elapsedMs=40; ray=none',
      ],
      [
        'a body that fails mid-read',
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error('private-detail'));
              },
            }),
            { status: 502 },
          ),
        'HTTP 502; code=body-error; elapsedMs=40; ray=none',
      ],
    ])('classifies %s without its contents', async (_label, response, expected) => {
      vi.stubGlobal('fetch', respondAfter(40, response));

      const failure: unknown = await openHost().catch((caught: unknown) => caught);

      const message = (failure as Error).message;
      expect(message).toBe(`HTTP signaling bridge open failed (role=host; ${expected})`);
      expectNoSecrets(message);
    });

    it('reports a request that never reached HTTP as a network error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          vi.advanceTimersByTime(7);
          throw new TypeError('private-detail fetch failed');
        }),
      );

      const failure: unknown = await openHost().catch((caught: unknown) => caught);

      expect((failure as Error).message).toBe(
        'HTTP signaling bridge open failed (role=host; HTTP none; code=network-error; ' +
          'elapsedMs=7; ray=none)',
      );
    });

    it('reports the 20 s client deadline as a timeout', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_input: unknown, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            }),
        ),
      );

      const opening = openHost().catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(20_000);

      expect(((await opening) as Error).message).toBe(
        'HTTP signaling bridge open failed (role=host; HTTP none; code=timeout; ' +
          'elapsedMs=20000; ray=none)',
      );
    });

    it('names the role and code of a failed poll and prints a failed close without throwing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementationOnce(async () =>
            Response.json({ sessionToken: 'private-bridge-session' }),
          )
          .mockImplementationOnce(
            respondAfter(18_003, () =>
              Response.json(
                { error: 'STANDARD_SIGNALING_BRIDGE_UNAVAILABLE' },
                { status: 502, headers: { 'cf-ray': RAY_ID } },
              ),
            ),
          )
          .mockImplementationOnce(async () =>
            Response.json({ error: 'STANDARD_HTTP_BRIDGE_AUTHORITY_MISMATCH' }, { status: 409 }),
          ),
      );
      const client = await openHost();

      const failure: unknown = await client.poll(1_500).catch((caught: unknown) => caught);
      await expect(client.close()).resolves.toBeUndefined();

      expect((failure as Error).message).toBe(
        'HTTP signaling bridge poll failed (role=host; HTTP 502; ' +
          `code=STANDARD_SIGNALING_BRIDGE_UNAVAILABLE; elapsedMs=18003; ray=${RAY_ID})`,
      );
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'HTTP signaling bridge close failed (role=host; HTTP 409; ' +
          'code=STANDARD_HTTP_BRIDGE_AUTHORITY_MISMATCH; elapsedMs=0; ray=none)',
      );
      expectNoSecrets(JSON.stringify([(failure as Error).message, warn.mock.calls]));
    });
  });

  describe('close acknowledgment', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      [
        'a 200 whose body is not JSON',
        () => new Response('private-detail', { status: 200 }),
        'HTTP 200; code=non-json; elapsedMs=0',
      ],
      [
        'a 200 without the ok acknowledgment',
        () => Response.json({ ok: false, detail: 'private-detail' }),
        'HTTP 200; code=none; elapsedMs=0',
      ],
      [
        'a 200 whose body stalls past the client deadline',
        (init?: RequestInit) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener('abort', () =>
                  controller.error(init.signal?.reason),
                );
              },
            }),
            { status: 200 },
          ),
        'HTTP 200; code=timeout; elapsedMs=20000',
      ],
    ])('prints a close answered by %s', async (_label, closeResponse, expected) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementationOnce(async () =>
            Response.json({ sessionToken: 'private-bridge-session' }),
          )
          .mockImplementationOnce(async (_input: unknown, init?: RequestInit) =>
            closeResponse(init),
          ),
      );
      const client = await StandardHttpBridgeSmokeClient.open('private-capability', {
        roomId: '654321',
        role: 'guest',
        peerId: 'http-guest-private',
      });

      const closing = client.close();
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(closing).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        `HTTP signaling bridge close failed (role=guest; ${expected}; ray=none)`,
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
    });

    it('stays quiet for the expected acknowledgment', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(Response.json({ sessionToken: 'private-bridge-session' }))
          .mockResolvedValueOnce(Response.json({ ok: true })),
      );
      const client = await StandardHttpBridgeSmokeClient.open('private-capability', {
        roomId: '654321',
        role: 'host',
        peerId: 'http-host-private',
      });

      await client.close();

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('rejects gaps in the server event sequence', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ sessionToken: 'bridge.session.token' }))
        .mockResolvedValueOnce(
          jsonResponse({
            v: 1,
            events: [{ sseq: 2, data: JSON.stringify({ type: 'peer-open' }) }],
          }),
        ),
    );

    const client = await StandardHttpBridgeSmokeClient.open('capability.token', {
      roomId: '123456',
      role: 'host',
      peerId: 'http-host-abcdef12',
    });
    await expect(client.poll(0)).rejects.toThrow('event sequence was malformed');
  });

  it('crosses the host PIN fence before opening the guest in the production smoke', async () => {
    interface SessionState {
      role: 'host' | 'guest';
      roomId: string;
      peerId: string;
      nextServerSequence: number;
      events: Array<{ sseq: number; data: string }>;
    }
    const sessions = new Map<string, SessionState>();
    const actions: string[] = [];
    const capabilityToken = `proof.${'a'.repeat(43)}`;
    let sessionSerial = 0;
    const enqueue = (state: SessionState, frame: Record<string, unknown>) => {
      state.nextServerSequence += 1;
      state.events.push({ sseq: state.nextServerSequence, data: JSON.stringify(frame) });
    };
    const sessionFrom = (init?: RequestInit): SessionState => {
      const authorization = new Headers(init?.headers).get('Authorization') ?? '';
      const state = sessions.get(authorization.replace(/^Bearer /u, ''));
      if (!state) throw new Error('Unknown bridge smoke session');
      return state;
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/security-config')) {
        return jsonResponse({
          capabilityRequired: true,
          turnstileRequired: false,
          proofOfWorkRequired: true,
        });
      }
      if (url.endsWith('/api/capability-challenge')) {
        return jsonResponse({ challenge: 'bridge-smoke.signature', difficulty: 8 });
      }
      if (url.endsWith('/api/capability-token')) {
        return jsonResponse({ token: capabilityToken });
      }
      if (url.endsWith('/open')) {
        const body = JSON.parse(String(init?.body)) as {
          role: 'host' | 'guest';
          roomId: string;
          peerId: string;
        };
        actions.push(`open:${body.role}`);
        const token = `session-${++sessionSerial}`;
        sessions.set(token, {
          ...body,
          nextServerSequence: 0,
          events: [],
        });
        return jsonResponse({ sessionToken: token });
      }
      if (url.endsWith('/send')) {
        const state = sessionFrom(init);
        const body = JSON.parse(String(init?.body)) as { cseq: number; frame: string };
        const frame = JSON.parse(body.frame) as Record<string, unknown>;
        actions.push(`send:${state.role}:${String(frame.type)}`);
        if (frame.type === 'host-auth') {
          enqueue(state, {
            type: 'peer-open',
            peerId: state.peerId,
            roomId: state.roomId,
            roomPasswordApplied: true,
          });
        } else if (frame.type === 'room-password-set') {
          enqueue(state, {
            type: 'room-password-result',
            mutationId: frame.pinMutationId,
            applied: true,
          });
        } else if (frame.type === 'guest-auth') {
          enqueue(state, { type: 'peer-open', peerId: state.peerId, roomId: state.roomId });
        } else if (frame.type === 'signal-offer') {
          const host = [...sessions.values()].find((candidate) => candidate.role === 'host');
          if (!host) throw new Error('Missing host smoke session');
          enqueue(host, { ...frame, from: state.peerId });
        } else if (frame.type === 'signal-answer') {
          const guest = [...sessions.values()].find((candidate) => candidate.role === 'guest');
          if (!guest) throw new Error('Missing guest smoke session');
          enqueue(guest, { ...frame, from: state.peerId });
        }
        return jsonResponse({ v: 1, ack: body.cseq });
      }
      if (url.endsWith('/poll')) {
        const state = sessionFrom(init);
        const events = state.events.splice(0);
        return jsonResponse({ v: 1, events });
      }
      if (url.endsWith('/close')) return jsonResponse({ ok: true });
      throw new Error(`Unexpected production smoke URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main();

    expect(actions.indexOf('send:host:room-password-set')).toBeGreaterThan(
      actions.indexOf('send:host:host-auth'),
    );
    expect(actions.indexOf('open:guest')).toBeGreaterThan(
      actions.indexOf('send:host:room-password-set'),
    );
    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]?.[0]).not.toContain('session-');
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      bridgeOpenMs: { host: expect.any(Number), guest: expect.any(Number) },
    });
  });
});

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ALTERNATE_SIGNALING_ORIGIN,
  ALTERNATE_SIGNALING_HTTP_ORIGIN,
  ALTERNATE_SIGNALING_READINESS_RETRY_DELAYS_MS,
  ALTERNATE_PRO_SIGNALING_PROBE_URL,
  InitialHostDeploymentConvergenceError,
  InitialHostOpenTimeoutConvergenceError,
  InitialHostSocketConvergenceError,
  MESSAGE_TIMEOUT_MS,
  PRIMARY_SIGNALING_ORIGIN,
  SIGNALING_SMOKE_ROOM_READINESS,
  SIGNALING_SMOKE_ROOM_ROUTES,
  STALE_VERSION_RETRY_DELAYS_MS,
  StaleSignalingVersionError,
  UNRELATED_TOSS_ORIGIN,
  assertPeerOpenVersion,
  createSocketInbox,
  initialHostHandshakeError,
  initialHostSocketCloseError,
  initialHostSocketError,
  readAlternateSignalingSurface,
  readSignalingOriginBoundary,
  signalingSocketUrl,
  settleUnexpectedInitialHostResponse,
  verifyAlternateSignalingSurface,
  verifySignalingOriginBoundary,
  withSignalingReadinessRetry,
} from '../../../scripts/live-signaling-smoke.mts';

const EXPECTED_VERSION = '11111111-1111-4111-8111-111111111111';
const STALE_VERSION = '22222222-2222-4222-8222-222222222222';

class FakeWebSocket extends EventEmitter {
  readyState = 1;

  close(): void {
    this.readyState = 3;
  }

  terminate(): void {
    this.readyState = 3;
  }
}

function fakeInitialHost(expectedVersion = EXPECTED_VERSION) {
  const socket = new FakeWebSocket();
  const inbox = createSocketInbox('wss://signal.example/room', 'host', {
    expectedInitialHostVersion: expectedVersion,
    createWebSocket: () => socket,
  });
  return { inbox, socket };
}

describe('live signaling smoke deployment readiness', () => {
  it('live-gates both custom domains through opposite host/guest room paths', () => {
    expect(PRIMARY_SIGNALING_ORIGIN).toBe('wss://signal.musixquare.com/api/rooms');
    expect(ALTERNATE_SIGNALING_ORIGIN).toBe('wss://signal-alt.musixquare.com/api/rooms');
    expect(SIGNALING_SMOKE_ROOM_ROUTES).toEqual({
      unprotected: {
        hostOrigin: ALTERNATE_SIGNALING_ORIGIN,
        guestOrigin: PRIMARY_SIGNALING_ORIGIN,
      },
      protected: {
        hostOrigin: PRIMARY_SIGNALING_ORIGIN,
        guestOrigin: ALTERNATE_SIGNALING_ORIGIN,
      },
    });
    expect(SIGNALING_SMOKE_ROOM_READINESS).toEqual({
      unprotected: {
        retryDelaysMs: ALTERNATE_SIGNALING_READINESS_RETRY_DELAYS_MS,
        retryInitialHostDeploymentConvergence: true,
        retryGuestVersionConvergence: true,
      },
      protected: {
        retryDelaysMs: STALE_VERSION_RETRY_DELAYS_MS,
        retryInitialHostDeploymentConvergence: false,
        retryGuestVersionConvergence: false,
      },
    });

    const fallbackHost = new URL(
      signalingSocketUrl('123456', 'host', 'host-test', ALTERNATE_SIGNALING_ORIGIN),
    );
    const primaryGuest = new URL(
      signalingSocketUrl('123456', 'guest', 'guest-test', PRIMARY_SIGNALING_ORIGIN),
    );
    expect(fallbackHost.origin).toBe('wss://signal-alt.musixquare.com');
    expect(primaryGuest.origin).toBe('wss://signal.musixquare.com');
    expect(fallbackHost.pathname).toBe('/api/rooms/123456/ws');
    expect(fallbackHost.searchParams.get('role')).toBe('host');
    expect(primaryGuest.searchParams.get('role')).toBe('guest');
  });

  it('runs the exact-version signaling smoke before any app deployment', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const signalingDeployStart = workflow.indexOf('- name: Deploy and record signaling Worker');
    const signalingSmokeStart = workflow.indexOf('- name: Smoke signaling Worker');
    const appDeployStart = workflow.indexOf(
      '- name: Deploy and record app Worker with immutable dist',
    );
    const signalingSmokeEnd = workflow.indexOf('\n      - name:', signalingSmokeStart + 1);
    const signalingSmoke = workflow.slice(signalingSmokeStart, signalingSmokeEnd);

    expect(signalingDeployStart).toBeGreaterThan(-1);
    expect(signalingSmokeStart).toBeGreaterThan(signalingDeployStart);
    expect(appDeployStart).toBeGreaterThan(signalingSmokeStart);
    expect(signalingSmoke).toContain("inputs.target == 'all' || inputs.target == 'signaling'");
    expect(signalingSmoke).toContain('timeout-minutes: 5');
    expect(signalingSmoke).toContain(
      'MXQR_EXPECTED_SIGNALING_VERSION: ${{ steps.signaling_deployment.outputs.version_id }}',
    );
    expect(signalingSmoke).toContain('run: npm run smoke:live:signaling');
  });

  it('pins the live negative probe to the unrelated Apps-in-Toss origin and HTTP 403', async () => {
    const socket = new FakeWebSocket();
    const resume = vi.fn();
    const terminate = vi.spyOn(socket, 'terminate');
    let observedOrigin = '';
    const read = readSignalingOriginBoundary({
      timeoutMs: 100,
      createWebSocket: (_target, options) => {
        observedOrigin = String(options.origin || '');
        queueMicrotask(() => {
          socket.emit('unexpected-response', {}, { statusCode: 403, resume });
        });
        return socket;
      },
    });

    await expect(read).resolves.toEqual({ statusCode: 403 });
    expect(UNRELATED_TOSS_ORIGIN).toBe('https://unrelated.apps.tossmini.com');
    expect(observedOrigin).toBe(UNRELATED_TOSS_ORIGIN);
    expect(resume).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('accepts only HTTP 403 as the live signaling origin boundary', async () => {
    await expect(
      verifySignalingOriginBoundary({ read: async () => ({ statusCode: 403 }) }),
    ).resolves.toEqual({ unrelatedTossOriginRejected: true });

    for (const statusCode of [101, 200, 401, 404, 426, 500]) {
      await expect(
        verifySignalingOriginBoundary({ read: async () => ({ statusCode }) }),
      ).rejects.toThrow('Production signaling still trusts an unrelated Toss app origin');
    }
  });

  it('live-reads the exact alternate root, internal, and PRO WebSocket surfaces', async () => {
    const requested: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/internal/developer/v1/dispatch')) {
        return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
      }
      return Response.json({
        ok: true,
        service: 'musixquare-signaling',
        websocket: '/api/rooms/:roomId/ws',
      });
    }) as typeof fetch;

    await expect(
      readAlternateSignalingSurface({
        fetcher,
        readProWebSocketStatus: async () => 404,
      }),
    ).resolves.toMatchObject({
      rootStatusCode: 200,
      internalStatusCode: 404,
      proWebSocketStatusCode: 404,
    });
    expect(ALTERNATE_SIGNALING_HTTP_ORIGIN).toBe('https://signal-alt.musixquare.com');
    expect(ALTERNATE_PRO_SIGNALING_PROBE_URL).toBe(
      'wss://signal-alt.musixquare.com/api/pro-rooms/000001/ws',
    );
    expect(requested).toEqual([
      'https://signal-alt.musixquare.com/',
      'https://signal-alt.musixquare.com/internal/developer/v1/dispatch',
    ]);
  });

  it('accepts only the exact restricted alternate signaling surface', async () => {
    const exact = {
      rootStatusCode: 200,
      rootBody: {
        ok: true,
        service: 'musixquare-signaling',
        websocket: '/api/rooms/:roomId/ws',
      },
      internalStatusCode: 404,
      proWebSocketStatusCode: 404,
    };
    await expect(verifyAlternateSignalingSurface({ read: async () => exact })).resolves.toEqual({
      standardWebSocketAdvertised: true,
      proWebSocketHidden: true,
      internalPathHidden: true,
      proWebSocketRejected: true,
    });

    for (const proWebSocketStatusCode of [101, 200, 401, 403, 426, 500]) {
      await expect(
        verifyAlternateSignalingSurface({
          read: async () => ({ ...exact, proWebSocketStatusCode }),
        }),
      ).rejects.toThrow('PRO WebSocket was not hidden with HTTP 404');
    }
    await expect(
      verifyAlternateSignalingSurface({
        read: async () => ({ ...exact, internalStatusCode: 403 }),
      }),
    ).rejects.toThrow('internal path was not hidden with HTTP 404');
    await expect(
      verifyAlternateSignalingSurface({
        read: async () => ({
          ...exact,
          rootBody: { ...exact.rootBody, proWebsocket: '/api/pro-rooms/:roomId/ws' },
        }),
      }),
    ).rejects.toThrow('root exposed an unexpected public surface');
  });

  it('keeps the bounded backoff comfortably below 45 seconds', () => {
    expect(STALE_VERSION_RETRY_DELAYS_MS.reduce((total, value) => total + value, 0)).toBeLessThan(
      45_000,
    );
  });

  it('gives only the first alternate-domain handshake a bounded convergence backoff', () => {
    const total = ALTERNATE_SIGNALING_READINESS_RETRY_DELAYS_MS.reduce(
      (sum, delayMs) => sum + delayMs,
      0,
    );
    const worstCaseWithSocketTimeouts =
      total + MESSAGE_TIMEOUT_MS * (ALTERNATE_SIGNALING_READINESS_RETRY_DELAYS_MS.length + 1);
    expect(total).toBeGreaterThanOrEqual(90_000);
    expect(total).toBeLessThanOrEqual(120_000);
    expect(worstCaseWithSocketTimeouts).toBeLessThan(5 * 60_000);
    expect(ALTERNATE_SIGNALING_READINESS_RETRY_DELAYS_MS).not.toEqual(
      STALE_VERSION_RETRY_DELAYS_MS,
    );
  });

  it('classifies first-room host HTTP 404 and 5xx as convergence without retrying policy errors', () => {
    for (const status of [404, 500, 501, 502, 503, 504, 599]) {
      expect(initialHostHandshakeError(status, EXPECTED_VERSION, 'host', true)).toBeInstanceOf(
        InitialHostDeploymentConvergenceError,
      );
      expect(initialHostHandshakeError(status, EXPECTED_VERSION, 'host')).not.toBeInstanceOf(
        InitialHostDeploymentConvergenceError,
      );
      expect(initialHostHandshakeError(status, '', 'host', true)).not.toBeInstanceOf(
        InitialHostDeploymentConvergenceError,
      );
    }

    for (const status of [400, 401, 403, 409, 426, 429]) {
      expect(initialHostHandshakeError(status, EXPECTED_VERSION, 'host', true)).not.toBeInstanceOf(
        InitialHostDeploymentConvergenceError,
      );
    }
  });

  it('drains and terminates an intercepted initial host response', () => {
    let resumed = 0;
    let terminated = 0;
    const error = settleUnexpectedInitialHostResponse(
      { terminate: () => (terminated += 1) },
      { statusCode: 500, resume: () => (resumed += 1) },
      EXPECTED_VERSION,
      'host',
      true,
    );

    expect(error).toBeInstanceOf(InitialHostDeploymentConvergenceError);
    expect(resumed).toBe(1);
    expect(terminated).toBe(1);
  });

  it('classifies only a pre-frame initial host 1006 as deployment convergence', () => {
    expect(initialHostSocketCloseError(1006, '', EXPECTED_VERSION, false, 'host')).toBeInstanceOf(
      InitialHostSocketConvergenceError,
    );

    for (const [closeCode, expectedVersion, receivedFrame] of [
      [1006, '', false],
      [1006, EXPECTED_VERSION, true],
      [1008, EXPECTED_VERSION, false],
      [1011, EXPECTED_VERSION, false],
      [1012, EXPECTED_VERSION, false],
    ] as const) {
      expect(
        initialHostSocketCloseError(
          closeCode,
          'non-convergence close',
          expectedVersion,
          receivedFrame,
          'host',
        ),
      ).not.toBeInstanceOf(InitialHostSocketConvergenceError);
    }
  });

  it('defers a pre-frame socket error until the initial host close is classified', () => {
    const socketError = new Error('socket hang up');
    expect(initialHostSocketError(socketError, EXPECTED_VERSION, false)).toBeNull();
    expect(initialHostSocketCloseError(1006, '', EXPECTED_VERSION, false, 'host')).toBeInstanceOf(
      InitialHostSocketConvergenceError,
    );

    expect(initialHostSocketError(socketError, '', false)).toBe(socketError);
    expect(initialHostSocketError(socketError, EXPECTED_VERSION, true)).toBe(socketError);
  });

  it('retries the observed open-error-close1006 event order only before any frame', async () => {
    const { inbox, socket } = fakeInitialHost();
    socket.emit('open');
    await expect(inbox.opened).resolves.toBeUndefined();

    const peerOpen = inbox.waitFor((message) => message.type === 'peer-open', 'peer-open');
    socket.emit('error', new Error('socket hang up'));
    socket.emit('close', 1006, Buffer.alloc(0));

    await expect(peerOpen).rejects.toBeInstanceOf(InitialHostSocketConvergenceError);
  });

  it('classifies a pre-open error-close1006 without waiting for the open timeout', async () => {
    const { inbox, socket } = fakeInitialHost();
    socket.emit('error', new Error('socket hang up'));
    socket.emit('close', 1006, Buffer.alloc(0));

    await expect(inbox.opened).rejects.toBeInstanceOf(InitialHostSocketConvergenceError);
  });

  it('terminates and retries an exact-version initial-host open timeout', async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      let attempts = 0;
      const pending = withSignalingReadinessRetry(
        async () => {
          attempts += 1;
          const socket = new FakeWebSocket();
          sockets.push(socket);
          const inbox = createSocketInbox('wss://signal.example/room', 'host', {
            expectedInitialHostVersion: EXPECTED_VERSION,
            createWebSocket: () => socket,
          });
          if (attempts === 2) queueMicrotask(() => socket.emit('open'));
          await inbox.opened;
          return attempts;
        },
        { retryDelaysMs: [0], wait: async () => {}, onRetry: () => {} },
      );

      await vi.advanceTimersByTimeAsync(MESSAGE_TIMEOUT_MS);
      await expect(pending).resolves.toBe(2);
      expect(attempts).toBe(2);
      expect(sockets[0]?.readyState).toBe(3);
      expect(sockets[1]?.readyState).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an ordinary open timeout terminal and does not terminate the socket', async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      let attempts = 0;
      const pending = withSignalingReadinessRetry(
        () => {
          attempts += 1;
          const opened = createSocketInbox('wss://signal.example/room', 'guest', {
            createWebSocket: () => socket,
          }).opened;
          return opened.catch((error: unknown) => {
            throw error;
          });
        },
        { retryDelaysMs: [0, 0], wait: async () => {}, onRetry: () => {} },
      );
      const rejection = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(MESSAGE_TIMEOUT_MS);
      const error = await rejection;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('guest open timeout');
      expect(attempts).toBe(1);
      expect(socket.readyState).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies the initial-host open timeout as convergence only with an exact version', () => {
    expect(new InitialHostOpenTimeoutConvergenceError()).toBeInstanceOf(Error);
  });

  it('does not retry 1006 after any raw frame, even when the frame is malformed', async () => {
    const { inbox, socket } = fakeInitialHost();
    socket.emit('open');
    await expect(inbox.opened).resolves.toBeUndefined();

    const peerOpen = inbox.waitFor((message) => message.type === 'peer-open', 'peer-open');
    const socketError = new Error('socket hang up');
    socket.emit('message', Buffer.from('{malformed'));
    socket.emit('error', socketError);
    socket.emit('close', 1006, Buffer.alloc(0));

    await expect(peerOpen).rejects.toBe(socketError);
  });

  it.each([1008, 1011, 1012])('does not retry initial host close code %i', async (code) => {
    const { inbox, socket } = fakeInitialHost();
    socket.emit('open');
    await expect(inbox.opened).resolves.toBeUndefined();

    const peerOpen = inbox.waitFor((message) => message.type === 'peer-open', 'peer-open');
    socket.emit('error', new Error('socket hang up'));
    socket.emit('close', code, Buffer.from('policy failure'));

    await expect(peerOpen).rejects.not.toBeInstanceOf(InitialHostSocketConvergenceError);
  });

  it('does not retry 1006 when no exact signaling version is required', async () => {
    const { inbox, socket } = fakeInitialHost('');
    socket.emit('open');
    await expect(inbox.opened).resolves.toBeUndefined();

    const peerOpen = inbox.waitFor((message) => message.type === 'peer-open', 'peer-open');
    const socketError = new Error('socket hang up');
    socket.emit('error', socketError);
    socket.emit('close', 1006, Buffer.alloc(0));

    await expect(peerOpen).rejects.toBe(socketError);
  });

  it('classifies only an explicitly opted-in peer-open version mismatch as retryable staleness', () => {
    expect(() =>
      assertPeerOpenVersion(
        { workerVersionId: STALE_VERSION },
        EXPECTED_VERSION,
        'host peer-open',
        true,
      ),
    ).toThrow(StaleSignalingVersionError);
    expect(() => assertPeerOpenVersion({}, EXPECTED_VERSION, 'host peer-open', true)).toThrow(
      StaleSignalingVersionError,
    );

    let guestError: unknown;
    try {
      assertPeerOpenVersion(
        { workerVersionId: STALE_VERSION },
        EXPECTED_VERSION,
        'guest peer-open',
      );
    } catch (error) {
      guestError = error;
    }
    expect(guestError).toBeInstanceOf(Error);
    expect(guestError).not.toBeInstanceOf(StaleSignalingVersionError);
    expect(() =>
      assertPeerOpenVersion(
        { workerVersionId: STALE_VERSION },
        EXPECTED_VERSION,
        'first cross-host guest peer-open',
        true,
      ),
    ).toThrow(StaleSignalingVersionError);
    expect(() =>
      assertPeerOpenVersion(
        { workerVersionId: EXPECTED_VERSION },
        EXPECTED_VERSION,
        'guest peer-open',
      ),
    ).not.toThrow();
  });

  it('retries stale host versions with a fresh operation invocation', async () => {
    const attempts: number[] = [];
    const waits: number[] = [];
    const result = await withSignalingReadinessRetry(
      async (attempt: number) => {
        attempts.push(attempt);
        if (attempt < 3) {
          throw new StaleSignalingVersionError(EXPECTED_VERSION, STALE_VERSION);
        }
        return 'ready';
      },
      {
        retryDelaysMs: [10, 20],
        wait: async (milliseconds: number) => {
          waits.push(milliseconds);
        },
        onRetry: () => {},
      },
    );

    expect(result).toBe('ready');
    expect(attempts).toEqual([1, 2, 3]);
    expect(waits).toEqual([10, 20]);
  });

  it('retries a pre-readiness host HTTP 500 with a fresh operation invocation', async () => {
    const attempts: number[] = [];
    const waits: number[] = [];
    const result = await withSignalingReadinessRetry(
      async (attempt: number) => {
        attempts.push(attempt);
        if (attempt === 1) {
          throw new InitialHostDeploymentConvergenceError(500);
        }
        return `room-attempt-${attempt}`;
      },
      {
        retryDelaysMs: [25],
        wait: async (milliseconds: number) => {
          waits.push(milliseconds);
        },
        onRetry: () => {},
      },
    );

    expect(result).toBe('room-attempt-2');
    expect(attempts).toEqual([1, 2]);
    expect(waits).toEqual([25]);
  });

  it('retries a pre-frame host 1006 with a fresh operation invocation', async () => {
    const attempts: number[] = [];
    const waits: number[] = [];
    const result = await withSignalingReadinessRetry(
      async (attempt: number) => {
        attempts.push(attempt);
        if (attempt === 1) {
          throw new InitialHostSocketConvergenceError(1006);
        }
        return `room-attempt-${attempt}`;
      },
      {
        retryDelaysMs: [25],
        wait: async (milliseconds: number) => {
          waits.push(milliseconds);
        },
        onRetry: () => {},
      },
    );

    expect(result).toBe('room-attempt-2');
    expect(attempts).toEqual([1, 2]);
    expect(waits).toEqual([25]);
  });

  it('does not retry a protocol failure after readiness reaches the expected version', async () => {
    let attempts = 0;
    await expect(
      withSignalingReadinessRetry(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new StaleSignalingVersionError(EXPECTED_VERSION, STALE_VERSION);
          }
          throw new Error('guest reconnect protocol regression');
        },
        {
          retryDelaysMs: [0, 0, 0],
          wait: async () => {},
          onRetry: () => {},
        },
      ),
    ).rejects.toThrow('guest reconnect protocol regression');
    expect(attempts).toBe(2);
  });

  it('fails after the bounded stale-version retry budget is exhausted', async () => {
    let attempts = 0;
    await expect(
      withSignalingReadinessRetry(
        async () => {
          attempts += 1;
          throw new StaleSignalingVersionError(EXPECTED_VERSION, STALE_VERSION);
        },
        {
          retryDelaysMs: [0, 0],
          wait: async () => {},
          onRetry: () => {},
        },
      ),
    ).rejects.toBeInstanceOf(StaleSignalingVersionError);
    expect(attempts).toBe(3);
  });

  it('fails after the bounded initial-host HTTP 500 retry budget is exhausted', async () => {
    let attempts = 0;
    await expect(
      withSignalingReadinessRetry(
        async () => {
          attempts += 1;
          throw new InitialHostDeploymentConvergenceError(500);
        },
        {
          retryDelaysMs: [0, 0],
          wait: async () => {},
          onRetry: () => {},
        },
      ),
    ).rejects.toBeInstanceOf(InitialHostDeploymentConvergenceError);
    expect(attempts).toBe(3);
  });

  it('fails after the bounded initial-host 1006 retry budget is exhausted', async () => {
    let attempts = 0;
    await expect(
      withSignalingReadinessRetry(
        async () => {
          attempts += 1;
          throw new InitialHostSocketConvergenceError(1006);
        },
        {
          retryDelaysMs: [0, 0],
          wait: async () => {},
          onRetry: () => {},
        },
      ),
    ).rejects.toBeInstanceOf(InitialHostSocketConvergenceError);
    expect(attempts).toBe(3);
  });
});

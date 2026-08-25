import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  InitialHostDeploymentConvergenceError,
  InitialHostSocketConvergenceError,
  STALE_VERSION_RETRY_DELAYS_MS,
  StaleSignalingVersionError,
  UNRELATED_TOSS_ORIGIN,
  assertPeerOpenVersion,
  createSocketInbox,
  initialHostHandshakeError,
  initialHostSocketCloseError,
  initialHostSocketError,
  readSignalingOriginBoundary,
  settleUnexpectedInitialHostResponse,
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

  it('keeps the bounded backoff comfortably below 45 seconds', () => {
    expect(STALE_VERSION_RETRY_DELAYS_MS.reduce((total, value) => total + value, 0)).toBeLessThan(
      45_000,
    );
  });

  it('classifies only an initial host HTTP 500 with an expected version as convergence', () => {
    expect(initialHostHandshakeError(500, EXPECTED_VERSION, 'host')).toBeInstanceOf(
      InitialHostDeploymentConvergenceError,
    );
    expect(initialHostHandshakeError(500, '', 'host')).not.toBeInstanceOf(
      InitialHostDeploymentConvergenceError,
    );

    for (const status of [400, 401, 403, 404, 409, 426, 429, 502, 503, 504]) {
      expect(initialHostHandshakeError(status, EXPECTED_VERSION, 'host')).not.toBeInstanceOf(
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

  it('classifies only a host peer-open version mismatch as retryable staleness', () => {
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

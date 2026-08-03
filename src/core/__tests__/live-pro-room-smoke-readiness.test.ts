import { describe, expect, it, vi } from 'vitest';

import {
  PRO_ROOM_HEALTH_REQUEST_TIMEOUT_MS,
  PRO_ROOM_READINESS_RETRY_DELAYS_MS,
  verifyProRoomPublicBoundary,
  waitForProRoomReady,
} from '../../../scripts/live-pro-room-smoke.mjs';

describe('live PRO room smoke readiness', () => {
  it('requires the activation and PIN canaries to expose their exact public states', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        payload: { roomCode: '000000', status: 'activation_required' },
      })
      .mockResolvedValueOnce({
        status: 200,
        payload: { roomCode: '000001', status: 'pin_required' },
      })
      .mockResolvedValueOnce({
        status: 401,
        payload: { error: 'SESSION_REQUIRED' },
      });

    await expect(verifyProRoomPublicBoundary({ read })).resolves.toEqual({
      roomCode: '000000',
      roomStatus: 'activation_required',
      pinRoomCode: '000001',
      pinRoomStatus: 'pin_required',
      anonymousSnapshotRejected: true,
    });
    expect(read).toHaveBeenNthCalledWith(1, '/000000/bootstrap');
    expect(read).toHaveBeenNthCalledWith(2, '/000001/bootstrap');
    expect(read).toHaveBeenNthCalledWith(3, '/000000/snapshot');
  });

  it.each([
    ['000000', 'pin_required', 'activation_required'],
    ['000001', 'activation_required', 'pin_required'],
  ])(
    'fails when room %s reports %s instead of %s',
    async (roomCode, actualStatus, expectedStatus) => {
      const read = vi.fn();
      if (roomCode === '000001') {
        read.mockResolvedValueOnce({
          status: 200,
          payload: { roomCode: '000000', status: 'activation_required' },
        });
      }
      read.mockResolvedValueOnce({
        status: 200,
        payload: { roomCode, status: actualStatus },
      });

      await expect(verifyProRoomPublicBoundary({ read })).rejects.toThrow(
        `PRO room ${roomCode} bootstrap must return ${expectedStatus}`,
      );
    },
  );

  it('fails when either bootstrap response belongs to a different room', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        payload: { roomCode: '000000', status: 'activation_required' },
      })
      .mockResolvedValueOnce({
        status: 200,
        payload: { roomCode: '000002', status: 'pin_required' },
      });

    await expect(verifyProRoomPublicBoundary({ read })).rejects.toThrow(
      'PRO room 000001 bootstrap must return pin_required',
    );
  });

  it('fails when a public PRO boundary becomes permissive or malformed', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        payload: { roomCode: '000000', status: 'activation_required' },
      })
      .mockResolvedValueOnce({
        status: 200,
        payload: { roomCode: '000001', status: 'pin_required' },
      })
      .mockResolvedValueOnce({
        status: 200,
        payload: { snapshot: {} },
      });

    await expect(verifyProRoomPublicBoundary({ read })).rejects.toThrow(
      'did not reject an anonymous credential',
    );
  });

  it('retries only transient HTTP responses for each public boundary probe', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, payload: { error: 'UNAVAILABLE' } })
      .mockResolvedValueOnce({
        status: 200,
        payload: { roomCode: '000000', status: 'activation_required' },
      })
      .mockResolvedValueOnce({ status: 429, payload: { error: 'RATE_LIMITED' } })
      .mockResolvedValueOnce({
        status: 200,
        payload: { roomCode: '000001', status: 'pin_required' },
      })
      .mockResolvedValueOnce({ status: 401, payload: { error: 'SESSION_REQUIRED' } });
    const wait = vi.fn(async () => undefined);
    const log = vi.fn();

    await expect(
      verifyProRoomPublicBoundary({ read, retryDelaysMs: [0, 25], wait, log }),
    ).resolves.toMatchObject({
      roomStatus: 'activation_required',
      pinRoomStatus: 'pin_required',
      anonymousSnapshotRejected: true,
    });

    expect(read.mock.calls.map(([path]) => path)).toEqual([
      '/000000/bootstrap',
      '/000000/bootstrap',
      '/000001/bootstrap',
      '/000001/bootstrap',
      '/000000/snapshot',
    ]);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 25);
    expect(wait).toHaveBeenNthCalledWith(2, 25);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('retries transport failures but keeps the retry budget bounded', async () => {
    const timeoutError = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    const networkError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    });
    const read = vi
      .fn()
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({
        status: 200,
        payload: { roomCode: '000000', status: 'activation_required' },
      })
      .mockResolvedValueOnce({
        status: 200,
        payload: { roomCode: '000001', status: 'pin_required' },
      })
      .mockResolvedValueOnce({ status: 401, payload: { error: 'SESSION_REQUIRED' } });

    await expect(
      verifyProRoomPublicBoundary({
        read,
        retryDelaysMs: [0, 0, 0],
        wait: async () => undefined,
        log: vi.fn(),
      }),
    ).resolves.toMatchObject({ anonymousSnapshotRejected: true });
    expect(read).toHaveBeenCalledTimes(5);

    const unavailable = vi.fn().mockRejectedValue(networkError);
    const retryWait = vi.fn(async () => undefined);
    await expect(
      verifyProRoomPublicBoundary({
        read: unavailable,
        wait: retryWait,
        log: vi.fn(),
      }),
    ).rejects.toThrow('boundary /000000/bootstrap remained unavailable: fetch failed');
    expect(unavailable).toHaveBeenCalledTimes(3);
    expect(retryWait.mock.calls).toEqual([[1_000], [2_000]]);
  });

  it('does not retry logical, schema, or non-transient HTTP failures', async () => {
    const wait = vi.fn(async () => undefined);
    const malformed = vi.fn().mockResolvedValue({
      status: 200,
      payload: { roomCode: '000000', status: 'pin_required' },
    });

    await expect(
      verifyProRoomPublicBoundary({
        read: malformed,
        retryDelaysMs: [0, 25],
        wait,
        log: vi.fn(),
      }),
    ).rejects.toThrow('bootstrap must return activation_required');
    expect(malformed).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();

    const invalidJson = vi.fn().mockRejectedValue(new Error('boundary returned invalid JSON'));
    await expect(
      verifyProRoomPublicBoundary({
        read: invalidJson,
        retryDelaysMs: [0, 25],
        wait,
        log: vi.fn(),
      }),
    ).rejects.toThrow('boundary returned invalid JSON');
    expect(invalidJson).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();

    const forbidden = vi.fn().mockResolvedValue({ status: 403, payload: { error: 'FORBIDDEN' } });
    await expect(
      verifyProRoomPublicBoundary({
        read: forbidden,
        retryDelaysMs: [0, 25],
        wait,
        log: vi.fn(),
      }),
    ).rejects.toThrow('bootstrap must return activation_required');
    expect(forbidden).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('retries stale edge versions until the expected deployment is visible', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        service: 'musixquare-pro-room',
        workerVersionId: 'stale-version',
      })
      .mockResolvedValueOnce({
        ok: true,
        service: 'musixquare-pro-room',
        workerVersionId: 'expected-version',
      });
    const wait = vi.fn(async () => undefined);

    await expect(
      waitForProRoomReady('expected-version', {
        read,
        retryDelaysMs: [0, 25],
        wait,
        log: vi.fn(),
      }),
    ).resolves.toEqual({
      service: 'musixquare-pro-room',
      expectedVersion: 'expected-version',
      actualVersion: 'expected-version',
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(25);
  });

  it('fails when the expected deployment never becomes visible', async () => {
    const read = vi.fn(async () => ({
      ok: true,
      service: 'musixquare-pro-room',
      workerVersionId: 'stale-version',
    }));

    await expect(
      waitForProRoomReady('expected-version', {
        read,
        retryDelaysMs: [0, 0],
        wait: async () => undefined,
        log: vi.fn(),
      }),
    ).rejects.toThrow('expected expected-version, received stale-version');
  });

  it('retries transient health errors before accepting the expected deployment', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('edge reset')).mockResolvedValueOnce({
      ok: true,
      service: 'musixquare-pro-room',
      workerVersionId: 'expected-version',
    });

    await expect(
      waitForProRoomReady('expected-version', {
        read,
        retryDelaysMs: [0, 0],
        wait: async () => undefined,
        log: vi.fn(),
      }),
    ).resolves.toMatchObject({ actualVersion: 'expected-version' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('allows slow service-binding propagation without exceeding the release step budget', async () => {
    const read = vi.fn();
    for (let attempt = 1; attempt < PRO_ROOM_READINESS_RETRY_DELAYS_MS.length; attempt += 1) {
      read.mockResolvedValueOnce({
        ok: true,
        service: 'musixquare-pro-room',
        workerVersionId: 'stale-version',
      });
    }
    read.mockResolvedValueOnce({
      ok: true,
      service: 'musixquare-pro-room',
      workerVersionId: 'expected-version',
    });

    await expect(
      waitForProRoomReady('expected-version', {
        read,
        wait: async () => undefined,
        log: vi.fn(),
      }),
    ).resolves.toMatchObject({ actualVersion: 'expected-version' });

    expect(read).toHaveBeenCalledTimes(PRO_ROOM_READINESS_RETRY_DELAYS_MS.length);
    const retryBudget = PRO_ROOM_READINESS_RETRY_DELAYS_MS.reduce(
      (total, milliseconds) => total + milliseconds,
      0,
    );
    const worstCaseRequestBudget =
      PRO_ROOM_HEALTH_REQUEST_TIMEOUT_MS * PRO_ROOM_READINESS_RETRY_DELAYS_MS.length;
    expect(retryBudget).toBe(150_000);
    expect(retryBudget + worstCaseRequestBudget).toBeLessThan(5 * 60_000);
  });
});

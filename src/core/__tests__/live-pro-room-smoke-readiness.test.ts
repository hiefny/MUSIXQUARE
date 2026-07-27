import { describe, expect, it, vi } from 'vitest';

import {
  PRO_ROOM_HEALTH_REQUEST_TIMEOUT_MS,
  PRO_ROOM_READINESS_RETRY_DELAYS_MS,
  verifyProRoomPublicBoundary,
  waitForProRoomReady,
} from '../../../scripts/live-pro-room-smoke.mjs';

describe('live PRO room smoke readiness', () => {
  it('checks a real public bootstrap and keeps anonymous snapshots fail-closed', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        payload: { roomCode: '000000', status: 'pin_required' },
      })
      .mockResolvedValueOnce({
        status: 401,
        payload: { error: 'SESSION_REQUIRED' },
      });

    await expect(verifyProRoomPublicBoundary({ read })).resolves.toEqual({
      roomCode: '000000',
      roomStatus: 'pin_required',
      anonymousSnapshotRejected: true,
    });
    expect(read).toHaveBeenNthCalledWith(1, '/bootstrap');
    expect(read).toHaveBeenNthCalledWith(2, '/snapshot');
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
        payload: { snapshot: {} },
      });

    await expect(verifyProRoomPublicBoundary({ read })).rejects.toThrow(
      'did not reject an anonymous credential',
    );
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

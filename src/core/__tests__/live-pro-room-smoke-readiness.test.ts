import { describe, expect, it, vi } from 'vitest';

import { waitForProRoomReady } from '../../../scripts/live-pro-room-smoke.mjs';

describe('live PRO room smoke readiness', () => {
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
      }),
    ).resolves.toMatchObject({ actualVersion: 'expected-version' });
    expect(read).toHaveBeenCalledTimes(2);
  });
});

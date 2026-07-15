import { describe, expect, it, vi } from 'vitest';
import { ProRoomHeartbeatSingleFlight } from '../heartbeat-single-flight.ts';
import { completeProRoomPinRotation } from '../pin-rotation.ts';

describe('completeProRoomPinRotation', () => {
  it('forces a post-PIN pass behind an old heartbeat and waits for reconfiguration', async () => {
    const order: string[] = [];
    let finishOldHeartbeat!: () => void;
    const oldHeartbeatPending = new Promise<void>((resolve) => {
      finishOldHeartbeat = resolve;
    });
    let finishReconfigure!: () => void;
    const reconfigurePending = new Promise<void>((resolve) => {
      finishReconfigure = resolve;
    });
    const flight = new ProRoomHeartbeatSingleFlight();
    const authoritativeHeartbeat = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        order.push('old-heartbeat');
        await oldHeartbeatPending;
      })
      .mockImplementationOnce(async () => {
        order.push('new-epoch-reconfigure');
        await reconfigurePending;
      });
    const changePin = vi.fn(async () => {
      order.push('pin');
    });

    const scheduledHeartbeat = flight.run(authoritativeHeartbeat);
    await vi.waitFor(() => expect(authoritativeHeartbeat).toHaveBeenCalledOnce());

    const completion = completeProRoomPinRotation({
      changePin,
      isSessionCurrent: () => true,
      heartbeat: () => flight.run(authoritativeHeartbeat, { forceFollowUp: true }),
    });
    await vi.waitFor(() => expect(changePin).toHaveBeenCalledOnce());
    expect(order).toEqual(['old-heartbeat', 'pin']);

    finishOldHeartbeat();
    await vi.waitFor(() => expect(authoritativeHeartbeat).toHaveBeenCalledTimes(2));
    expect(order).toEqual(['old-heartbeat', 'pin', 'new-epoch-reconfigure']);

    let completed = false;
    void completion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    finishReconfigure();
    await expect(completion).resolves.toBe(true);
    await scheduledHeartbeat;
  });

  it('does not report success when the new-epoch heartbeat/reconfigure fails', async () => {
    const expected = new Error('SIGNALING_RECONFIGURE_FAILED');
    await expect(
      completeProRoomPinRotation({
        changePin: vi.fn(async () => undefined),
        isSessionCurrent: () => true,
        heartbeat: vi.fn(async () => {
          throw expected;
        }),
      }),
    ).rejects.toBe(expected);
  });

  it('does not reconcile a room that replaced the PIN mutation lease', async () => {
    const heartbeat = vi.fn(async () => undefined);
    await expect(
      completeProRoomPinRotation({
        changePin: vi.fn(async () => undefined),
        isSessionCurrent: () => false,
        heartbeat,
      }),
    ).resolves.toBe(false);
    expect(heartbeat).not.toHaveBeenCalled();
  });
});

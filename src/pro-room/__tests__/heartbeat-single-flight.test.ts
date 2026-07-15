import { describe, expect, it, vi } from 'vitest';
import { ProRoomHeartbeatSingleFlight } from '../heartbeat-single-flight.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ProRoomHeartbeatSingleFlight', () => {
  it('guarantees a fresh reconciliation after an epoch event races an old heartbeat', async () => {
    const flight = new ProRoomHeartbeatSingleFlight();
    const oldEpochHeartbeat = deferred();
    const newEpochHeartbeat = deferred();
    const heartbeat = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(oldEpochHeartbeat.promise)
      .mockReturnValueOnce(newEpochHeartbeat.promise);

    const first = flight.run(heartbeat);
    await Promise.resolve();
    expect(heartbeat).toHaveBeenCalledTimes(1);

    // The signaling DO has already advanced authority, but the request that
    // began under the old epoch has not settled yet. The event must not be
    // reduced to the ordinary single-flight no-op.
    const epochReconcile = flight.run(heartbeat, { forceFollowUp: true });
    oldEpochHeartbeat.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(heartbeat).toHaveBeenCalledTimes(2);

    newEpochHeartbeat.resolve();
    await expect(Promise.all([first, epochReconcile])).resolves.toEqual([undefined, undefined]);
  });

  it('coalesces ordinary overlapping triggers without an unnecessary second heartbeat', async () => {
    const flight = new ProRoomHeartbeatSingleFlight();
    const pending = deferred();
    const heartbeat = vi.fn(() => pending.promise);

    const first = flight.run(heartbeat);
    const overlap = flight.run(heartbeat);
    await Promise.resolve();
    expect(heartbeat).toHaveBeenCalledTimes(1);

    pending.resolve();
    await Promise.all([first, overlap]);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it('does not let a reset flight enqueue work into the next room lifecycle', async () => {
    const flight = new ProRoomHeartbeatSingleFlight();
    const oldHeartbeat = deferred();
    const nextHeartbeat = deferred();
    const oldOperation = vi.fn(() => oldHeartbeat.promise);
    const nextOperation = vi.fn(() => nextHeartbeat.promise);

    const oldFlight = flight.run(oldOperation);
    await Promise.resolve();
    flight.run(oldOperation, { forceFollowUp: true });
    flight.reset();
    const nextFlight = flight.run(nextOperation);
    await Promise.resolve();

    oldHeartbeat.resolve();
    nextHeartbeat.resolve();
    await Promise.all([oldFlight, nextFlight]);
    expect(oldOperation).toHaveBeenCalledTimes(1);
    expect(nextOperation).toHaveBeenCalledTimes(1);
  });
});

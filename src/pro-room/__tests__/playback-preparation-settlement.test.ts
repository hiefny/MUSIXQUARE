import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  cancelProPlaybackPreparation,
  cancelSupersededProPlaybackPreparation,
  commitProPlaybackAuthority,
  createProPlaybackAuthorityToken,
  prepareCurrentProPlaybackRendezvousAuthority,
  prepareProPlaybackAuthority,
  recoverCancelledProPlaybackCheckpoint,
  registerProPlaybackMediaEndpoint,
  rendezvousCurrentProPlaybackAuthority,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackCommitRequest,
  type ProPlaybackMediaEndpoint,
  type ProPlaybackPrepareResult,
} from '../playback-authority-hooks.ts';

const Q1 = '10000000-0000-4000-8000-000000000001' as QueueItemId;
const releasePending: Array<() => void> = [];
const observations: Promise<void>[] = [];

function authority(revision: number, transitionId: string | null = `transition-${revision}`) {
  return createProPlaybackAuthorityToken({
    roomId: '000001',
    roomEpoch: 7,
    basePlaybackRevision: revision,
    transitionId,
  });
}

function ready(token: ReturnType<typeof authority>): ProPlaybackPrepareResult {
  return {
    status: 'ready',
    authority: token,
    queueItemId: Q1,
    mediaKind: 'file',
    durationSeconds: 10,
    youtubeSubIndex: null,
    youtubeVideoId: null,
  };
}

function request(token: ReturnType<typeof authority>): ProPlaybackCommitRequest {
  return {
    authority: token,
    committedPlaybackRevision: token.basePlaybackRevision + 1,
    queueItemId: Q1,
    state: 'playing',
    positionSeconds: 0,
    scheduleDelayMs: 0,
    timingMode: 'scheduled-control',
    isCurrent: () => true,
  };
}

function prepare(token: ReturnType<typeof authority>) {
  return prepareProPlaybackAuthority({ authority: token, queueItemId: Q1, positionSeconds: 0 });
}

function observe<T>(promise: Promise<T>) {
  const settled = vi.fn<(result: T) => void>();
  const rejected = vi.fn<(error: unknown) => void>();
  const done = promise.then(settled, rejected);
  observations.push(done);
  return { settled, rejected, done };
}

function endpoint() {
  const prepare = vi.fn<ProPlaybackMediaEndpoint['prepare']>(async (value) =>
    ready(value.authority),
  );
  const commit = vi.fn<ProPlaybackMediaEndpoint['commit']>(async (value) => ({
    status: 'applied',
    authority: value.authority,
  }));
  const cancel = vi.fn<NonNullable<ProPlaybackMediaEndpoint['cancel']>>();
  const reset = vi.fn();
  registerProPlaybackMediaEndpoint({ prepare, commit, cancel, reset });
  return { prepare, commit, cancel, reset };
}

// The native-decode integration suite establishes this uncancellable endpoint
// contract. These tests isolate its authority observers, without replacing the
// real decode/cleanup coverage in playback-native-preparation-cancel.test.ts.
function pendingEndpoint(token: ReturnType<typeof authority>) {
  let settled = false;
  let resolve!: (value: ProPlaybackPrepareResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ProPlaybackPrepareResult>((accept, fail) => {
    resolve = (value) => {
      settled = true;
      accept(value);
    };
    reject = (reason) => {
      settled = true;
      fail(reason);
    };
  });
  releasePending.push(() => resolve(ready(token)));
  return { promise, resolve, reject, isSettled: () => settled };
}

beforeEach(() => {
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: null,
    epoch: 7,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
  });
});

afterEach(async () => {
  resetProPlaybackAuthorityHooks();
  for (const release of releasePending.splice(0)) release();
  await Promise.all(observations.splice(0));
  registerProPlaybackMediaEndpoint(null);
  clearAllManagedTimers();
  setState('room.context', {
    kind: 'standard',
    roomId: null,
    role: 'idle',
    coordinatorId: null,
    epoch: 0,
    snapshotRevision: 0,
    capabilities: [],
  });
});

describe('pending PRO preparation observation settlement', () => {
  it.each(['exact cancel', 'room reset', 'direct canonical commit', 'new PREPARE'] as const)(
    '%s releases both preparation and its waiting COMMIT before native work finishes',
    async (action) => {
      const h = endpoint();
      const old = authority(1);
      const native = pendingEndpoint(old);
      h.prepare.mockReturnValueOnce(native.promise);
      const preparing = observe(prepare(old));
      const committing = observe(commitProPlaybackAuthority(request(old)));
      expect(h.prepare).toHaveBeenCalledTimes(1);

      if (action === 'exact cancel') expect(cancelProPlaybackPreparation(old)).toBe(true);
      else if (action === 'room reset') resetProPlaybackAuthorityHooks();
      else if (action === 'direct canonical commit') {
        await expect(
          commitProPlaybackAuthority(request(authority(2, null))),
        ).resolves.toMatchObject({
          status: 'applied',
        });
      } else {
        await expect(prepare(authority(2))).resolves.toMatchObject({ status: 'ready' });
      }

      await vi.waitFor(() => {
        expect(preparing.settled).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'superseded' }),
        );
        expect(committing.settled).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'superseded' }),
        );
      });
      expect(native.isSettled()).toBe(false);
      expect(h.prepare.mock.calls[0]![0].isCurrent?.()).toBe(false);
      expect(h.cancel).toHaveBeenCalledExactlyOnceWith(old);
      expect(preparing.rejected).not.toHaveBeenCalled();
      expect(committing.rejected).not.toHaveBeenCalled();

      if (action !== 'direct canonical commit') {
        if (action !== 'new PREPARE') await prepare(authority(2));
        await expect(commitProPlaybackAuthority(request(authority(2)))).resolves.toMatchObject({
          status: 'applied',
        });
      }
      native.resolve(ready(old));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.commit).toHaveBeenCalledTimes(1);
      expect(h.commit.mock.calls[0]![0].authority.basePlaybackRevision).toBe(2);
      expect(h.cancel).toHaveBeenCalledTimes(1);
      expect(h.reset).toHaveBeenCalledTimes(action === 'room reset' ? 1 : 0);
    },
  );

  it('wrong transition, revision or room token leaves the genuine owner waiting and able to commit', async () => {
    const h = endpoint();
    const owner = authority(1);
    const native = pendingEndpoint(owner);
    h.prepare.mockReturnValueOnce(native.promise);
    const preparing = observe(prepare(owner));
    const committing = observe(commitProPlaybackAuthority(request(owner)));
    const wrongRoom = createProPlaybackAuthorityToken({
      ...owner,
      roomId: '000002',
    });
    for (const wrong of [authority(1, 'other'), authority(2), wrongRoom]) {
      expect(cancelProPlaybackPreparation(wrong)).toBe(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(preparing.settled).not.toHaveBeenCalled();
    expect(committing.settled).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.prepare.mock.calls[0]![0].isCurrent?.()).toBe(true);

    native.resolve(ready(owner));
    await Promise.all([preparing.done, committing.done]);
    expect(preparing.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
    expect(committing.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'applied' }));
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it('releases every same-authority caller once and consumes a late native rejection', async () => {
    const h = endpoint();
    const owner = authority(1);
    const native = pendingEndpoint(owner);
    h.prepare.mockReturnValueOnce(native.promise);
    const first = observe(prepare(owner));
    const shared = observe(prepare(authority(1)));
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(cancelProPlaybackPreparation(authority(1))).toBe(true);
    await vi.waitFor(() => {
      expect(first.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
      expect(shared.settled).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'superseded' }),
      );
    });
    expect(native.isSettled()).toBe(false);
    await expect(prepare(authority(2))).resolves.toMatchObject({ status: 'ready' });

    native.reject(new Error('retired native decode failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.rejected).not.toHaveBeenCalled();
    expect(shared.rejected).not.toHaveBeenCalled();
    expect(first.settled).toHaveBeenCalledTimes(1);
    expect(shared.settled).toHaveBeenCalledTimes(1);
    expect(h.cancel).toHaveBeenCalledExactlyOnceWith(owner);
    await expect(commitProPlaybackAuthority(request(authority(2)))).resolves.toMatchObject({
      status: 'applied',
    });
  });

  it('preserves endpoint rejection for an uncancelled owner and its waiting COMMIT', async () => {
    const h = endpoint();
    const owner = authority(1);
    const native = pendingEndpoint(owner);
    h.prepare.mockReturnValueOnce(native.promise);
    const preparing = observe(prepare(owner));
    const committing = observe(commitProPlaybackAuthority(request(owner)));
    const error = new Error('current native decode failed');
    native.reject(error);
    await Promise.all([preparing.done, committing.done]);
    expect(preparing.rejected).toHaveBeenCalledExactlyOnceWith(error);
    expect(committing.rejected).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('an admitted COMMIT preserves matching or newer preparation and rejects foreign authority', async () => {
    const h = endpoint();
    const owner = authority(10);
    const native = pendingEndpoint(owner);
    h.prepare.mockReturnValueOnce(native.promise);
    const preparing = observe(prepare(owner));
    const unbranded = {
      roomId: owner.roomId,
      roomEpoch: owner.roomEpoch,
      basePlaybackRevision: 11,
      transitionId: null,
    } as typeof owner;
    const retained = [
      authority(10),
      authority(9, null),
      authority(9),
      createProPlaybackAuthorityToken({ ...owner, roomId: '000002', basePlaybackRevision: 11 }),
      createProPlaybackAuthorityToken({ ...owner, roomEpoch: 8, basePlaybackRevision: 11 }),
      unbranded,
    ];
    for (const incoming of retained) {
      expect(cancelSupersededProPlaybackPreparation(incoming)).toBe(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(preparing.settled).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.prepare.mock.calls[0]![0].isCurrent?.()).toBe(true);
    native.resolve(ready(owner));
    await preparing.done;
    await expect(commitProPlaybackAuthority(request(owner))).resolves.toMatchObject({
      status: 'applied',
    });
  });

  it.each(['same-base direct', 'newer revision'] as const)(
    'an admitted %s COMMIT releases the older native wait before joining the controller queue',
    async (kind) => {
      const h = endpoint();
      const owner = authority(10);
      const native = pendingEndpoint(owner);
      h.prepare.mockReturnValueOnce(native.promise);
      const preparing = observe(prepare(owner));
      const committing = observe(commitProPlaybackAuthority(request(owner)));
      const incoming = kind === 'same-base direct' ? authority(10, null) : authority(11);
      expect(cancelSupersededProPlaybackPreparation(incoming)).toBe(true);
      expect(cancelSupersededProPlaybackPreparation(incoming)).toBe(false);
      await vi.waitFor(() => {
        expect(preparing.settled).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'superseded' }),
        );
        expect(committing.settled).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'superseded' }),
        );
      });
      expect(native.isSettled()).toBe(false);
      expect(h.cancel).toHaveBeenCalledExactlyOnceWith(owner);
      const successor = authority(12);
      await prepare(successor);
      native.resolve(ready(owner));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(commitProPlaybackAuthority(request(successor))).resolves.toMatchObject({
        status: 'applied',
      });
      expect(h.commit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ authority: successor }),
      );
      expect(h.cancel).toHaveBeenCalledExactlyOnceWith(owner);
    },
  );

  it.each(['local rendezvous', 'cancelled checkpoint recovery'] as const)(
    'cancels a pending %s without its continuation cancelling the successor',
    async (kind) => {
      const h = endpoint();
      if (kind === 'local rendezvous') {
        await expect(
          commitProPlaybackAuthority(request(authority(9, null))),
        ).resolves.toMatchObject({
          status: 'applied',
        });
      } else {
        await prepare(authority(10));
        expect(cancelProPlaybackPreparation(authority(10))).toBe(true);
      }
      h.commit.mockClear();
      h.cancel.mockClear();
      const local = authority(9, kind);
      const native = pendingEndpoint(local);
      h.prepare.mockReturnValueOnce(native.promise);
      const localWaits =
        kind === 'local rendezvous'
          ? [
              observe(
                prepareCurrentProPlaybackRendezvousAuthority({
                  authority: local,
                  queueItemId: Q1,
                  positionSeconds: 0,
                }),
              ),
              observe(rendezvousCurrentProPlaybackAuthority(request(local))),
            ]
          : [
              observe(
                recoverCancelledProPlaybackCheckpoint(request(local), () => ({
                  positionSeconds: 0,
                  scheduleDelayMs: 0,
                })),
              ),
            ];
      const successor = authority(11);
      await expect(prepare(successor)).resolves.toMatchObject({ status: 'ready' });
      await vi.waitFor(() => {
        for (const waiting of localWaits) {
          expect(waiting.settled).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'superseded' }),
          );
        }
      });
      expect(native.isSettled()).toBe(false);
      expect(h.cancel).toHaveBeenCalledExactlyOnceWith(local);
      if (kind === 'local rendezvous') native.resolve(ready(local));
      else native.reject(new Error('retired recovery decode failed'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const waiting of localWaits) expect(waiting.rejected).not.toHaveBeenCalled();

      await expect(commitProPlaybackAuthority(request(successor))).resolves.toMatchObject({
        status: 'applied',
      });
      expect(h.commit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ authority: successor }),
      );
      expect(h.cancel).toHaveBeenCalledExactlyOnceWith(local);
    },
  );
});

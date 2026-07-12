import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import type {
  RendezvousArmIntent,
  RendezvousArmReceipt,
  RendezvousFinalizeIntent,
  RendezvousFinalizeReceipt,
} from '../rendezvous-contract.ts';
import {
  HostRendezvousCoordinator,
  RENDEZVOUS_FINALIZATION_GUARD_MS,
  type HostRendezvousParticipant,
} from '../rendezvous-coordinator.ts';

const QID = '00000000-0000-4000-8000-0000000000aa' as QueueItemId;
const RUN = Object.freeze({ queueItemId: QID, runId: 'run-a', revision: 12 });

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function armedReceipt(
  intent: RendezvousArmIntent,
  overrides: Partial<RendezvousArmReceipt> = {},
): RendezvousArmReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-armed',
    queueItemId: intent.queueItemId,
    runId: intent.runId,
    revision: intent.revision,
    rendezvousId: intent.rendezvousId,
    participantId: intent.recipientId,
    status: 'armed',
    observedAtRoomTimeMs: intent.finalizeByRoomTimeMs,
    bufferedAheadSeconds: 3,
    reasonCode: null,
    ...overrides,
  };
}

function finalizedReceipt(
  intent: RendezvousFinalizeIntent,
  overrides: Partial<RendezvousFinalizeReceipt> = {},
): RendezvousFinalizeReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalized',
    queueItemId: intent.queueItemId,
    runId: intent.runId,
    revision: intent.revision,
    rendezvousId: intent.rendezvousId,
    participantId: intent.recipientId,
    status: 'accepted',
    observedAtRoomTimeMs: intent.finalizedAtRoomTimeMs,
    reasonCode: null,
    ...overrides,
  };
}

function participant(
  participantId: string,
  overrides: Partial<HostRendezvousParticipant> = {},
): HostRendezvousParticipant {
  return {
    participantId,
    rttP95Ms: 0,
    armP95Ms: 0,
    arm: async (intent) => armedReceipt(intent),
    finalize: async (intent) => finalizedReceipt(intent),
    ...overrides,
  };
}

function coordinator(
  nowRoomTimeMs: () => number,
  ids: string[] = ['rv-a'],
): HostRendezvousCoordinator {
  return new HostRendezvousCoordinator({
    nowRoomTimeMs,
    createRendezvousId: () => ids.shift() ?? 'rv-fallback',
  });
}

describe('HostRendezvousCoordinator', () => {
  it('snapshots exact coordinator options without invoking dynamic getters', () => {
    let getterCalls = 0;
    const accessor = {
      get nowRoomTimeMs() {
        getterCalls += 1;
        return () => 0;
      },
      createRendezvousId: () => 'rv-accessor',
    };
    expect(() => new HostRendezvousCoordinator(accessor)).toThrow(/options are invalid/);
    expect(getterCalls).toBe(0);

    const proxied = new Proxy(
      { nowRoomTimeMs: () => 0, createRendezvousId: () => 'rv-options-proxy' },
      {
        get() {
          getterCalls += 1;
          throw new Error('dynamic [[Get]] must not run');
        },
      },
    );
    const instance = new HostRendezvousCoordinator(proxied);
    expect(
      instance.start({ run: RUN, positionSeconds: 0, playbackRate: 1, participants: [] }),
    ).toMatchObject({ rendezvousId: 'rv-options-proxy' });
    expect(getterCalls).toBe(0);
  });

  it('detaches start scalars and participant callbacks exactly once', async () => {
    const reads = new Map<string, number>();
    const read = (key: string): number => {
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      return count;
    };
    const stableArm = async (intent: RendezvousArmIntent) => armedReceipt(intent);
    const stableFinalize = async (intent: RendezvousFinalizeIntent) => finalizedReceipt(intent);
    const hostileParticipant = {
      get participantId() {
        return read('participantId') === 1 ? 'detached-peer' : '';
      },
      get rttP95Ms() {
        read('rttP95Ms');
        return 0;
      },
      get armP95Ms() {
        read('armP95Ms');
        return 0;
      },
      get arm() {
        return read('arm') === 1 ? stableArm : () => Promise.reject(new Error('stale arm'));
      },
      get finalize() {
        return read('finalize') === 1
          ? stableFinalize
          : () => Promise.reject(new Error('stale finalize'));
      },
      get commitAttempt() {
        read('commitAttempt');
        return undefined;
      },
      get cancel() {
        read('cancel');
        return undefined;
      },
    };
    const input = {
      get run() {
        read('run');
        return RUN;
      },
      get positionSeconds() {
        return read('positionSeconds') === 1 ? 2 : -1;
      },
      get playbackRate() {
        return read('playbackRate') === 1 ? 1 : -1;
      },
      get participants() {
        read('participants');
        return [hostileParticipant];
      },
    };
    const attempt = coordinator(() => 10_000, ['rv-detached-input']).start(input);
    await drainMicrotasks();

    expect(attempt.getSnapshot()).toMatchObject({
      positionSeconds: 2,
      playbackRate: 1,
      participants: [
        { participantId: 'detached-peer', armStatus: 'armed', finalizeStatus: 'accepted' },
      ],
    });
    for (const key of [
      'run',
      'positionSeconds',
      'playbackRate',
      'participants',
      'participantId',
      'rttP95Ms',
      'armP95Ms',
      'arm',
      'finalize',
      'commitAttempt',
      'cancel',
    ]) {
      expect(reads.get(key)).toBe(1);
    }
  });

  it('uses detached run and receipt snapshots under hostile Proxy traps', async () => {
    const roomNow = 10_000;
    let getCalls = 0;
    const run = new Proxy(RUN, {
      get() {
        getCalls += 1;
        throw new Error('dynamic [[Get]] must not run');
      },
    });
    const peer = participant('proxy-peer', {
      arm: async (intent) =>
        new Proxy(armedReceipt(intent, { observedAtRoomTimeMs: roomNow }), {
          get(_target, property) {
            if (property === 'then') return undefined;
            getCalls += 1;
            throw new Error('dynamic [[Get]] must not run');
          },
        }),
    });
    const attempt = coordinator(() => roomNow).start({
      run,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [peer],
    });
    await drainMicrotasks();

    expect(getCalls).toBe(0);
    expect(attempt.getSnapshot().participants[0]).toMatchObject({
      armStatus: 'armed',
      finalizeStatus: 'accepted',
    });
  });

  it('cannot commit arm or finalize receipts after Proxy inspection re-enters cancellation', async () => {
    const armGate = deferred<RendezvousArmReceipt>();
    const finalizeGate = deferred<RendezvousFinalizeReceipt>();
    const finalize = vi.fn((intent: RendezvousFinalizeIntent) => finalizeGate.promise);
    const armCoordinator = coordinator(() => 10_000, ['rv-arm-reentry']);
    const armAttempt = armCoordinator.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [participant('arm-reentry', { arm: () => armGate.promise, finalize })],
    });
    const armTarget = armedReceipt(
      Object.freeze({
        protocolVersion: 2,
        kind: 'rendezvous-arm',
        ...RUN,
        rendezvousId: armAttempt.rendezvousId,
        recipientId: 'arm-reentry',
        positionSeconds: 0,
        playbackRate: 1,
        startAtRoomTimeMs: armAttempt.startAtRoomTimeMs,
        finalizeByRoomTimeMs: armAttempt.finalizeByRoomTimeMs,
      }),
    );
    armGate.resolve(
      new Proxy(armTarget, {
        ownKeys(target) {
          armAttempt.cancel('proxy-reentered-cancel');
          return Reflect.ownKeys(target);
        },
      }),
    );
    await drainMicrotasks();

    expect(finalize).not.toHaveBeenCalled();
    expect(armAttempt.getSnapshot()).toMatchObject({
      status: 'cancelled',
      participants: [{ armStatus: 'stale', finalizeStatus: 'stale' }],
    });

    let capturedFinalize: RendezvousFinalizeIntent | null = null;
    const finalizeAttempt = coordinator(() => 20_000, ['rv-finalize-reentry']).start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('finalize-reentry', {
          finalize: (intent) => {
            capturedFinalize = intent;
            return finalizeGate.promise;
          },
        }),
      ],
    });
    await drainMicrotasks();
    expect(capturedFinalize).not.toBeNull();
    finalizeGate.resolve(
      new Proxy(finalizedReceipt(capturedFinalize!), {
        ownKeys(target) {
          finalizeAttempt.cancel('proxy-reentered-cancel');
          return Reflect.ownKeys(target);
        },
      }),
    );
    await drainMicrotasks();

    expect(finalizeAttempt.getSnapshot()).toMatchObject({
      status: 'cancelled',
      participants: [{ armStatus: 'armed', finalizeStatus: 'stale' }],
    });
  });

  it('does not let a clock callback roll a newer reentrant start back', () => {
    let reentered = false;
    let nested: ReturnType<HostRendezvousCoordinator['start']> | null = null;
    let instance!: HostRendezvousCoordinator;
    instance = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => {
        if (!reentered) {
          reentered = true;
          nested = instance.start({
            run: { ...RUN, revision: 13 },
            positionSeconds: 0,
            playbackRate: 1,
            participants: [],
          });
        }
        return 10_000;
      },
      createRendezvousId: () => 'rv-clock-reentry',
    });

    expect(() =>
      instance.start({
        run: RUN,
        positionSeconds: 0,
        playbackRate: 1,
        participants: [],
      }),
    ).toThrow(/superseded/);
    expect(nested).not.toBeNull();
    expect(nested!.getSnapshot()).toMatchObject({
      status: 'complete',
      run: { revision: 13 },
    });
  });

  it('commits before supersede callbacks so a reentrant newer start wins', async () => {
    let nested: ReturnType<HostRendezvousCoordinator['start']> | null = null;
    let instance!: HostRendezvousCoordinator;
    const pendingFinalize = deferred<RendezvousFinalizeReceipt>();
    const ids = ['rv-old', 'rv-outer', 'rv-nested'];
    instance = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => 10_000,
      createRendezvousId: () => ids.shift() ?? 'rv-fallback',
    });
    const old = instance.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('old-peer', {
          finalize: () => pendingFinalize.promise,
          cancel: () => {
            nested = instance.start({
              run: { ...RUN, revision: 14 },
              positionSeconds: 0,
              playbackRate: 1,
              participants: [],
            });
          },
        }),
      ],
    });
    await drainMicrotasks();
    expect(old.getSnapshot()).toMatchObject({
      status: 'open',
      participants: [{ finalizeStatus: 'pending' }],
    });

    const outer = instance.start({
      run: { ...RUN, revision: 13 },
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });

    expect(outer.getSnapshot().status).toBe('superseded');
    expect(nested).not.toBeNull();
    expect(nested!.getSnapshot()).toMatchObject({
      status: 'complete',
      run: { revision: 14 },
    });
  });

  it('stops dispatching remaining participants after an arm callback cancels the attempt', () => {
    const instance = coordinator(() => 10_000, ['rv-dispatch-cancel']);
    const secondArm = vi.fn(async (intent: RendezvousArmIntent) => armedReceipt(intent));
    const attempt = instance.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('first', {
          arm: async (intent) => {
            instance.cancelActive('cancelled-during-dispatch');
            return armedReceipt(intent);
          },
        }),
        participant('second', { arm: secondArm }),
      ],
    });

    expect(secondArm).not.toHaveBeenCalled();
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'cancelled',
      reasonCode: 'cancelled-during-dispatch',
    });
  });

  it('returns immediately, uses the slowest estimate, and never lets a slow peer block peers', async () => {
    let roomNow = 10_000;
    let healthyArmIntent: RendezvousArmIntent | null = null;
    let healthyFinalizeIntent: RendezvousFinalizeIntent | null = null;
    let rejectedArmIntent: RendezvousArmIntent | null = null;
    let slowArmIntent: RendezvousArmIntent | null = null;
    const slowArm = deferred<RendezvousArmReceipt>();
    const healthyFinalize = vi.fn(async (intent: RendezvousFinalizeIntent) => {
      healthyFinalizeIntent = intent;
      return finalizedReceipt(intent);
    });
    const rejectedFinalize = vi.fn();
    const slowFinalize = vi.fn();

    const attempt = coordinator(() => roomNow).start({
      run: RUN,
      positionSeconds: 24,
      playbackRate: 1,
      participants: [
        participant('healthy', {
          rttP95Ms: 100,
          armP95Ms: 300,
          arm: async (intent) => {
            healthyArmIntent = intent;
            return armedReceipt(intent, { observedAtRoomTimeMs: roomNow });
          },
          finalize: healthyFinalize,
        }),
        participant('rejected', {
          arm: async (intent) => {
            rejectedArmIntent = intent;
            return armedReceipt(intent, {
              status: 'rejected',
              observedAtRoomTimeMs: roomNow,
              reasonCode: 'not-ready',
            });
          },
          finalize: rejectedFinalize,
        }),
        participant('slow', {
          rttP95Ms: 1_000,
          armP95Ms: 1_000,
          arm: (intent) => {
            slowArmIntent = intent;
            return slowArm.promise;
          },
          finalize: slowFinalize,
        }),
      ],
    });

    expect(attempt.startAtRoomTimeMs).toBe(12_500);
    expect(attempt.finalizeByRoomTimeMs).toBe(
      attempt.startAtRoomTimeMs - RENDEZVOUS_FINALIZATION_GUARD_MS,
    );
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'open',
      leadTimeMs: 2_500,
    });

    await drainMicrotasks();

    expect(healthyFinalize).toHaveBeenCalledTimes(1);
    expect(rejectedFinalize).not.toHaveBeenCalled();
    expect(slowFinalize).not.toHaveBeenCalled();
    expect(healthyArmIntent).not.toBeNull();
    expect(rejectedArmIntent).not.toBeNull();
    expect(slowArmIntent).not.toBeNull();
    expect(healthyFinalizeIntent?.startAtRoomTimeMs).toBe(attempt.startAtRoomTimeMs);
    expect(Object.isFrozen(healthyArmIntent)).toBe(true);
    expect(Object.isFrozen(healthyFinalizeIntent)).toBe(true);
    expect(attempt.getSnapshot().participants).toEqual([
      expect.objectContaining({
        participantId: 'healthy',
        armStatus: 'armed',
        finalizeStatus: 'accepted',
      }),
      expect.objectContaining({
        participantId: 'rejected',
        armStatus: 'rejected',
        finalizeStatus: 'not-requested',
      }),
      expect.objectContaining({
        participantId: 'slow',
        armStatus: 'pending',
        finalizeStatus: 'not-requested',
      }),
    ]);

    roomNow = attempt.finalizeByRoomTimeMs + 1;
    slowArm.resolve(armedReceipt(slowArmIntent!));
    await drainMicrotasks();

    expect(slowFinalize).not.toHaveBeenCalled();
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [
        { finalizeStatus: 'accepted' },
        { armStatus: 'rejected' },
        { armStatus: 'armed', finalizeStatus: 'missed-deadline' },
      ],
    });
  });

  it('completes without issuing any finalization when every arm is rejected', async () => {
    const finalize = vi.fn();
    const attempt = coordinator(() => 500).start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: ['a', 'b'].map((participantId) =>
        participant(participantId, {
          arm: async (intent) =>
            armedReceipt(intent, {
              status: 'rejected',
              observedAtRoomTimeMs: 500,
              reasonCode: 'decoder-not-ready',
            }),
          finalize,
        }),
      ),
    });

    await drainMicrotasks();

    expect(finalize).not.toHaveBeenCalled();
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [{ armStatus: 'rejected' }, { armStatus: 'rejected' }],
    });
  });

  it('supersedes the old generation so its late receipt cannot finalize', async () => {
    let roomNow = 1_000;
    const oldArm = deferred<RendezvousArmReceipt>();
    let oldIntent: RendezvousArmIntent | null = null;
    const oldFinalize = vi.fn();
    const currentFinalize = vi.fn(async (intent: RendezvousFinalizeIntent) =>
      finalizedReceipt(intent),
    );
    const host = coordinator(() => roomNow, ['rv-old', 'rv-current']);

    const oldAttempt = host.start({
      run: RUN,
      positionSeconds: 1,
      playbackRate: 1,
      participants: [
        participant('peer', {
          arm: (intent) => {
            oldIntent = intent;
            return oldArm.promise;
          },
          finalize: oldFinalize,
        }),
      ],
    });
    roomNow = 1_010;
    const currentAttempt = host.start({
      run: { ...RUN, revision: 13 },
      positionSeconds: 2,
      playbackRate: 1,
      participants: [participant('peer', { finalize: currentFinalize })],
    });
    oldArm.resolve(armedReceipt(oldIntent!, { observedAtRoomTimeMs: roomNow }));
    await drainMicrotasks();

    expect(oldFinalize).not.toHaveBeenCalled();
    expect(currentFinalize).toHaveBeenCalledTimes(1);
    expect(oldAttempt.getSnapshot()).toMatchObject({
      status: 'superseded',
      reasonCode: 'newer-rendezvous',
      participants: [{ armStatus: 'stale', finalizeStatus: 'stale' }],
    });
    expect(currentAttempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [{ finalizeStatus: 'accepted' }],
    });
  });

  it('refuses equal or older revisions without disturbing the latest attempt', () => {
    const host = coordinator(() => 1_250, ['rv-12', 'rv-13']);
    const latest = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });

    expect(() =>
      host.start({
        run: { ...RUN, runId: 'different-run', revision: RUN.revision },
        positionSeconds: 0,
        playbackRate: 1,
        participants: [],
      }),
    ).toThrow(/revision must be newer/i);
    expect(() =>
      host.start({
        run: { ...RUN, runId: 'older-run', revision: RUN.revision - 1 },
        positionSeconds: 0,
        playbackRate: 1,
        participants: [],
      }),
    ).toThrow(/revision must be newer/i);
    expect(latest.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-12',
    });

    const newer = host.start({
      run: { ...RUN, runId: 'newer-run', revision: RUN.revision + 1 },
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });
    expect(latest.getSnapshot().status).toBe('superseded');
    expect(newer.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-13',
    });
  });

  it('retires armed old targets without awaiting cancel success', async () => {
    const pendingOldFinalize = deferred<RendezvousFinalizeReceipt>();
    const oldCancel = vi.fn(() => Promise.reject(new Error('peer already disconnected')));
    const currentCancel = vi.fn();
    const host = coordinator(() => 1_400, ['rv-old', 'rv-current']);
    const oldAttempt = host.start({
      run: RUN,
      positionSeconds: 3,
      playbackRate: 1,
      participants: [
        participant('peer', {
          finalize: () => pendingOldFinalize.promise,
          cancel: oldCancel,
        }),
      ],
    });
    await drainMicrotasks();
    expect(oldAttempt.getSnapshot().participants[0]).toMatchObject({
      armStatus: 'armed',
      finalizeStatus: 'pending',
    });
    expect(oldAttempt.commitParticipant('peer')).toBe(false);

    const currentAttempt = host.start({
      run: { ...RUN, runId: 'run-b', revision: RUN.revision + 1 },
      positionSeconds: 5,
      playbackRate: 1,
      participants: [participant('peer', { cancel: currentCancel })],
    });
    await drainMicrotasks();

    expect(oldCancel).toHaveBeenCalledTimes(1);
    expect(oldCancel).toHaveBeenCalledWith({
      kind: 'file-playback-cancel',
      ...RUN,
      rendezvousId: 'rv-old',
      reasonCode: 'newer-rendezvous',
    });
    expect(Object.isFrozen(oldCancel.mock.calls[0]![0])).toBe(true);
    expect(oldAttempt.getSnapshot()).toMatchObject({
      status: 'superseded',
      participants: [{ armStatus: 'armed', finalizeStatus: 'stale' }],
    });
    expect(currentAttempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [{ finalizeStatus: 'accepted' }],
    });

    expect(currentAttempt.cancel('manual-stop').status).toBe('cancelled');
    expect(currentCancel).toHaveBeenCalledWith({
      kind: 'file-playback-cancel',
      queueItemId: RUN.queueItemId,
      runId: 'run-b',
      revision: RUN.revision + 1,
      rendezvousId: 'rv-current',
      reasonCode: 'manual-stop',
    });
  });

  it('does not cancel an explicitly committed participant when a newer attempt supersedes it', async () => {
    const promotedCancel = vi.fn();
    const commitAttempt = vi.fn(() => true);
    const host = coordinator(() => 1_400, ['rv-promoted', 'rv-next']);
    const promoted = host.start({
      run: RUN,
      positionSeconds: 3,
      playbackRate: 1,
      participants: [participant('peer', { commitAttempt, cancel: promotedCancel })],
    });
    await drainMicrotasks();
    expect(promoted.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [{ finalizeStatus: 'accepted' }],
    });
    expect(promoted.commitParticipant('missing-peer')).toBe(false);
    expect(promoted.commitParticipant('peer')).toBe(true);
    expect(promoted.commitParticipant('peer')).toBe(true);
    expect(commitAttempt).toHaveBeenCalledOnce();
    expect(commitAttempt).toHaveBeenCalledWith({
      ...RUN,
      rendezvousId: 'rv-promoted',
    });
    expect(Object.isFrozen(commitAttempt.mock.calls[0]![0])).toBe(true);
    expect(Object.getPrototypeOf(commitAttempt.mock.calls[0]![0])).toBeNull();

    host.start({
      run: { ...RUN, runId: 'run-next', revision: RUN.revision + 1 },
      positionSeconds: 5,
      playbackRate: 1,
      participants: [],
    });

    expect(promoted.getSnapshot().status).toBe('superseded');
    expect(promotedCancel).not.toHaveBeenCalled();
  });

  it('cancels only the accepted participant that was not explicitly committed', async () => {
    const committedCancel = vi.fn();
    const candidateCancel = vi.fn();
    const attempt = coordinator(() => 1_400, ['rv-mixed']).start({
      run: RUN,
      positionSeconds: 3,
      playbackRate: 1,
      participants: [
        participant('committed-peer', {
          commitAttempt: () => true,
          cancel: committedCancel,
        }),
        participant('candidate-peer', {
          commitAttempt: () => true,
          cancel: candidateCancel,
        }),
      ],
    });
    await drainMicrotasks();
    expect(attempt.getSnapshot().participants).toMatchObject([
      { participantId: 'committed-peer', finalizeStatus: 'accepted' },
      { participantId: 'candidate-peer', finalizeStatus: 'accepted' },
    ]);
    expect(attempt.commitParticipant('committed-peer')).toBe(true);

    attempt.cancel('mixed-cancel');

    expect(committedCancel).not.toHaveBeenCalled();
    expect(candidateCancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['returns false', () => false],
    [
      'throws',
      () => {
        throw new Error('commit failed');
      },
    ],
  ] as const)('keeps an accepted candidate cancellable when commit %s', async (_label, commit) => {
    const cancel = vi.fn();
    const attempt = coordinator(() => 1_400, ['rv-failed-commit']).start({
      run: RUN,
      positionSeconds: 3,
      playbackRate: 1,
      participants: [participant('peer', { commitAttempt: commit, cancel })],
    });
    await drainMicrotasks();

    expect(attempt.commitParticipant('peer')).toBe(false);
    attempt.cancel('commit-not-established');

    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels pending participants so their later receipts stay stale', async () => {
    const arm = deferred<RendezvousArmReceipt>();
    let armIntent: RendezvousArmIntent | null = null;
    const finalize = vi.fn();
    const attempt = coordinator(() => 1_500).start({
      run: RUN,
      positionSeconds: 2,
      playbackRate: 1,
      participants: [
        participant('peer', {
          arm: (intent) => {
            armIntent = intent;
            return arm.promise;
          },
          finalize,
        }),
      ],
    });

    expect(attempt.cancel('user-cancelled')).toMatchObject({
      status: 'cancelled',
      reasonCode: 'user-cancelled',
    });
    arm.resolve(armedReceipt(armIntent!, { observedAtRoomTimeMs: 1_500 }));
    await drainMicrotasks();

    expect(finalize).not.toHaveBeenCalled();
    expect(attempt.getSnapshot().participants[0]).toMatchObject({
      armStatus: 'stale',
      finalizeStatus: 'stale',
    });
  });

  it('rejects an exact-identity mismatch instead of finalizing the participant', async () => {
    const finalize = vi.fn();
    const attempt = coordinator(() => 2_000).start({
      run: RUN,
      positionSeconds: 4,
      playbackRate: 1,
      participants: [
        participant('peer', {
          arm: async (intent) =>
            armedReceipt(intent, {
              runId: 'foreign-run',
              observedAtRoomTimeMs: 2_000,
            }),
          finalize,
        }),
      ],
    });

    await drainMicrotasks();

    expect(finalize).not.toHaveBeenCalled();
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [
        {
          armStatus: 'invalid',
          armValidationCode: 'identity-mismatch',
          finalizeStatus: 'not-requested',
        },
      ],
    });
  });

  it('absorbs malformed transport receipts as invalid participant outcomes', async () => {
    const malformedArm = coordinator(() => 2_500).start({
      run: RUN,
      positionSeconds: 4,
      playbackRate: 1,
      participants: [
        participant('bad-arm', {
          arm: async () => null as unknown as RendezvousArmReceipt,
        }),
      ],
    });
    const malformedFinalize = coordinator(() => 2_500, ['rv-finalize']).start({
      run: RUN,
      positionSeconds: 4,
      playbackRate: 1,
      participants: [
        participant('bad-finalize', {
          finalize: async () => null as unknown as RendezvousFinalizeReceipt,
        }),
      ],
    });

    await drainMicrotasks();

    expect(malformedArm.getSnapshot().participants[0]).toMatchObject({
      armStatus: 'invalid',
      armValidationCode: 'invalid-contract',
      armReasonCode: 'invalid-contract',
    });
    expect(malformedFinalize.getSnapshot().participants[0]).toMatchObject({
      armStatus: 'armed',
      finalizeStatus: 'invalid',
      finalizeValidationCode: 'invalid-contract',
      finalizeReasonCode: 'invalid-contract',
    });
  });

  it('checks the moving deadline immediately before each independent finalization', async () => {
    let roomNow = 3_000;
    const firstArm = deferred<RendezvousArmReceipt>();
    const secondArm = deferred<RendezvousArmReceipt>();
    let firstIntent: RendezvousArmIntent | null = null;
    let secondIntent: RendezvousArmIntent | null = null;
    const firstFinalize = vi.fn(async (intent: RendezvousFinalizeIntent) => {
      roomNow = 3_351;
      return finalizedReceipt(intent, { observedAtRoomTimeMs: intent.finalizedAtRoomTimeMs });
    });
    const secondFinalize = vi.fn();
    const attempt = coordinator(() => roomNow).start({
      run: RUN,
      positionSeconds: 8,
      playbackRate: 1,
      participants: [
        participant('first', {
          arm: (intent) => {
            firstIntent = intent;
            return firstArm.promise;
          },
          finalize: firstFinalize,
        }),
        participant('second', {
          arm: (intent) => {
            secondIntent = intent;
            return secondArm.promise;
          },
          finalize: secondFinalize,
        }),
      ],
    });
    expect(attempt.finalizeByRoomTimeMs).toBe(3_350);
    roomNow = 3_350;
    firstArm.resolve(armedReceipt(firstIntent!, { observedAtRoomTimeMs: roomNow }));
    secondArm.resolve(armedReceipt(secondIntent!, { observedAtRoomTimeMs: roomNow }));

    await drainMicrotasks();

    expect(firstFinalize).toHaveBeenCalledTimes(1);
    expect(secondFinalize).not.toHaveBeenCalled();
    const [firstFinalizeIntent] = firstFinalize.mock.calls[0]!;
    expect(firstFinalizeIntent.startAtRoomTimeMs).toBe(attempt.startAtRoomTimeMs);
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [
        { finalizeStatus: 'accepted' },
        { armStatus: 'armed', finalizeStatus: 'missed-deadline' },
      ],
    });
  });

  it('reports local arm/finalize latencies and keeps snapshots immutable', async () => {
    let roomNow = 7_000;
    const arm = deferred<RendezvousArmReceipt>();
    const finalize = deferred<RendezvousFinalizeReceipt>();
    let armIntent: RendezvousArmIntent | null = null;
    let finalizeIntent: RendezvousFinalizeIntent | null = null;
    const attempt = coordinator(() => roomNow).start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('peer', {
          arm: (intent) => {
            armIntent = intent;
            return arm.promise;
          },
          finalize: (intent) => {
            finalizeIntent = intent;
            return finalize.promise;
          },
        }),
      ],
    });

    roomNow = 7_075;
    arm.resolve(armedReceipt(armIntent!, { observedAtRoomTimeMs: roomNow }));
    await drainMicrotasks();
    roomNow = 7_090;
    finalize.resolve(finalizedReceipt(finalizeIntent!, { observedAtRoomTimeMs: roomNow }));
    await drainMicrotasks();

    const snapshot = attempt.getSnapshot();
    expect(snapshot.participants[0]).toMatchObject({
      armLatencyMs: 75,
      finalizeLatencyMs: 15,
      bufferedAheadSeconds: 3,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.run)).toBe(true);
    expect(Object.isFrozen(snapshot.participants)).toBe(true);
    expect(Object.isFrozen(snapshot.participants[0])).toBe(true);
  });

  it('expires unresolved work without timers and absorbs async failures into outcomes', async () => {
    let roomNow = 9_000;
    const hangingArm = deferred<RendezvousArmReceipt>();
    const failedArm = deferred<RendezvousArmReceipt>();
    const attempt = coordinator(() => roomNow).start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('hanging', { arm: () => hangingArm.promise }),
        participant('failed', { arm: () => failedArm.promise }),
      ],
    });
    failedArm.reject(new Error('transport closed'));
    await drainMicrotasks();

    roomNow = attempt.finalizeByRoomTimeMs + 1;
    const snapshot = attempt.expire();

    expect(snapshot).toMatchObject({
      status: 'complete',
      participants: [
        {
          armStatus: 'missed-deadline',
          armReasonCode: 'arm-receipt-not-received',
          finalizeStatus: 'missed-deadline',
        },
        { armStatus: 'failed', armReasonCode: 'arm-promise-rejected' },
      ],
    });
  });
});

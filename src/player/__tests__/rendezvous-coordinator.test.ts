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
  type HostRendezvousAttempt,
  type HostRendezvousParticipant,
} from '../rendezvous-coordinator.ts';

const QID = '00000000-0000-4000-8000-0000000000aa' as QueueItemId;
const QID_B = '00000000-0000-4000-8000-0000000000bb' as QueueItemId;
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

  it('closes irreversibly, cancels once, and makes retained attempts inert', async () => {
    const armGate = deferred<RendezvousArmReceipt>();
    const finalize = vi.fn(async (intent: RendezvousFinalizeIntent) => finalizedReceipt(intent));
    const cancel = vi.fn();
    let clockReads = 0;
    const host = coordinator(() => {
      clockReads += 1;
      return 10_000;
    }, ['rv-close']);
    const attempt = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('closing-peer', {
          arm: () => armGate.promise,
          finalize,
          cancel,
        }),
      ],
    });
    const readsBeforeClose = clockReads;

    host.close();
    host.close();

    expect(cancel).toHaveBeenCalledOnce();
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'cancelled',
      reasonCode: 'coordinator-closed',
      participants: [{ participantId: 'closing-peer', armStatus: 'stale' }],
    });
    expect(attempt.commitParticipant('closing-peer')).toBe(false);
    expect(attempt.expire()).toMatchObject({ status: 'cancelled' });
    expect(host.cancelActive()).toBeNull();
    expect(host.tryReadRoomTimeMs()).toBeNull();
    expect(clockReads).toBe(readsBeforeClose);
    expect(() =>
      host.start({ run: RUN, positionSeconds: 0, playbackRate: 1, participants: [] }),
    ).toThrow('coordinator is closed');

    armGate.resolve(
      armedReceipt({
        protocolVersion: 2,
        kind: 'rendezvous-arm',
        ...RUN,
        rendezvousId: 'rv-close',
        recipientId: 'closing-peer',
        positionSeconds: 0,
        playbackRate: 1,
        startAtRoomTimeMs: 10_450,
        finalizeByRoomTimeMs: 10_350,
      }),
    );
    await drainMicrotasks();
    expect(finalize).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('fences close re-entry from participant cancellation before any successor can start', () => {
    let nestedStartError: unknown = null;
    let nestedCancelSnapshot: ReturnType<HostRendezvousAttempt['cancel']> | null = null;
    let nestedExpireSnapshot: ReturnType<HostRendezvousAttempt['expire']> | null = null;
    let host!: HostRendezvousCoordinator;
    let attempt!: HostRendezvousAttempt;
    const cancel = vi.fn(() => {
      host.close();
      nestedCancelSnapshot = attempt.cancel('participant-cancel-reentry');
      nestedExpireSnapshot = attempt.expire();
      try {
        host.start({ run: RUN, positionSeconds: 0, playbackRate: 1, participants: [] });
      } catch (error) {
        nestedStartError = error;
      }
    });
    host = coordinator(() => 1_000, ['rv-close-reentry', 'rv-must-not-start']);
    attempt = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [participant('reentrant-peer', { arm: () => new Promise(() => {}), cancel })],
    });

    host.close();

    expect(cancel).toHaveBeenCalledOnce();
    expect(nestedStartError).toBeInstanceOf(Error);
    expect((nestedStartError as Error).message).toContain('coordinator is closed');
    expect(attempt.getSnapshot()).toMatchObject({
      status: 'cancelled',
      reasonCode: 'coordinator-closed',
    });
    expect(nestedCancelSnapshot).toMatchObject({
      status: 'cancelled',
      reasonCode: 'coordinator-closed',
    });
    expect(nestedExpireSnapshot).toMatchObject({
      status: 'cancelled',
      reasonCode: 'coordinator-closed',
    });
    expect(host.cancelActive()).toBeNull();
  });

  it('aborts a re-entrant start when the room clock closes the coordinator', () => {
    let host!: HostRendezvousCoordinator;
    const createRendezvousId = vi.fn(() => 'rv-never-created');
    host = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => {
        host.close();
        return 5_000;
      },
      createRendezvousId,
    });

    expect(() =>
      host.start({
        run: RUN,
        positionSeconds: 0,
        playbackRate: 1,
        participants: [],
      }),
    ).toThrow('coordinator is closed');
    expect(createRendezvousId).not.toHaveBeenCalled();
    expect(host.cancelActive()).toBeNull();
    expect(() =>
      host.start({ run: RUN, positionSeconds: 0, playbackRate: 1, participants: [] }),
    ).toThrow('coordinator is closed');
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

  it('retires every non-accepted terminal participant exactly once', async () => {
    const armRejectedCancel = vi.fn();
    const armInvalidCancel = vi.fn();
    const armFailedCancel = vi.fn();
    const finalizeRejectedCancel = vi.fn();
    const finalizeFailedCancel = vi.fn();
    const acceptedCancel = vi.fn();
    const attempt = coordinator(() => 10_000, ['rv-terminal-cleanup']).start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('arm-rejected', {
          arm: async (intent) =>
            armedReceipt(intent, { status: 'rejected', reasonCode: 'not-ready' }),
          cancel: armRejectedCancel,
        }),
        participant('arm-invalid', {
          arm: async (intent) => armedReceipt(intent, { runId: 'foreign-run' }),
          cancel: armInvalidCancel,
        }),
        participant('arm-failed', {
          arm: async () => Promise.reject(new Error('arm transport failed')),
          cancel: armFailedCancel,
        }),
        participant('finalize-rejected', {
          finalize: async (intent) =>
            finalizedReceipt(intent, {
              status: 'rejected',
              reasonCode: 'backend-rejected',
            }),
          cancel: finalizeRejectedCancel,
        }),
        participant('finalize-failed', {
          finalize: async () => Promise.reject(new Error('finalize transport failed')),
          cancel: finalizeFailedCancel,
        }),
        participant('accepted', { cancel: acceptedCancel }),
      ],
    });

    await drainMicrotasks();

    expect(attempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [
        { armStatus: 'rejected' },
        { armStatus: 'invalid' },
        { armStatus: 'failed' },
        { finalizeStatus: 'rejected' },
        { finalizeStatus: 'failed' },
        { finalizeStatus: 'accepted' },
      ],
    });
    for (const cancel of [
      armRejectedCancel,
      armInvalidCancel,
      armFailedCancel,
      finalizeRejectedCancel,
      finalizeFailedCancel,
    ]) {
      expect(cancel).toHaveBeenCalledOnce();
    }
    expect(acceptedCancel).not.toHaveBeenCalled();

    attempt.cancel('explicit-after-terminal-cleanup');
    for (const cancel of [
      armRejectedCancel,
      armInvalidCancel,
      armFailedCancel,
      finalizeRejectedCancel,
      finalizeFailedCancel,
    ]) {
      expect(cancel).toHaveBeenCalledOnce();
    }
    expect(acceptedCancel).toHaveBeenCalledOnce();
  });

  it('does not overwrite cancellation or replacement caused by terminal cleanup re-entry', async () => {
    let cancelledAttempt!: ReturnType<HostRendezvousCoordinator['start']>;
    const cancelHost = coordinator(() => 10_250, ['rv-terminal-cancel-reentry']);
    const cancel = vi.fn(() => {
      cancelledAttempt.cancel('terminal-cleanup-reentered-cancel');
    });
    cancelledAttempt = cancelHost.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('cancel-reentry', {
          arm: async (intent) =>
            armedReceipt(intent, { status: 'rejected', reasonCode: 'not-ready' }),
          cancel,
        }),
      ],
    });
    await drainMicrotasks();

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancelledAttempt.getSnapshot()).toMatchObject({
      status: 'cancelled',
      reasonCode: 'terminal-cleanup-reentered-cancel',
    });

    let replacement: ReturnType<HostRendezvousCoordinator['start']> | null = null;
    const ids = ['rv-terminal-old', 'rv-terminal-recovery'];
    const replacementHost = coordinator(() => 10_300, ids);
    const old = replacementHost.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('replacement-reentry', {
          arm: async (intent) =>
            armedReceipt(intent, { status: 'rejected', reasonCode: 'not-ready' }),
          cancel: () => {
            replacement = replacementHost.start({
              run: RUN,
              positionSeconds: 1,
              playbackRate: 1,
              participants: [],
            });
          },
        }),
      ],
    });
    await drainMicrotasks();

    expect(old.getSnapshot()).toMatchObject({
      status: 'superseded',
      reasonCode: 'replacement-rendezvous',
    });
    expect(replacement).not.toBeNull();
    expect(replacement!.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-terminal-recovery',
    });
  });

  it('preserves a newer active attempt when explicit cancellation re-enters start', () => {
    let newer: ReturnType<HostRendezvousCoordinator['start']> | null = null;
    const ids = ['rv-explicit-old', 'rv-explicit-newer'];
    const host = coordinator(() => 10_400, ids);
    const pendingArm = deferred<RendezvousArmReceipt>();
    const old = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('explicit-reentry', {
          arm: () => pendingArm.promise,
          cancel: () => {
            newer = host.start({
              run: { ...RUN, runId: 'run-explicit-newer', revision: RUN.revision + 1 },
              positionSeconds: 1,
              playbackRate: 1,
              participants: [],
            });
          },
        }),
      ],
    });

    old.cancel('outer-explicit-cancel');

    expect(old.getSnapshot()).toMatchObject({
      status: 'superseded',
      reasonCode: 'newer-rendezvous',
    });
    expect(newer).not.toBeNull();
    expect(newer!.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-explicit-newer',
    });
    expect(host.cancelActive('prove-newer-remains-active')).toMatchObject({
      status: 'cancelled',
      rendezvousId: 'rv-explicit-newer',
    });
  });

  it('retires an arm dispatched before the room clock becomes invalid', async () => {
    let clockValid = true;
    const cancel = vi.fn();
    const attempt = coordinator(
      () => (clockValid ? 10_500 : Number.NaN),
      ['rv-invalid-clock-cleanup'],
    ).start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [participant('clock-peer', { cancel })],
    });
    clockValid = false;
    await drainMicrotasks();

    expect(attempt.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [{ armStatus: 'failed', armReasonCode: 'invalid-room-clock' }],
    });
    expect(cancel).toHaveBeenCalledOnce();

    let expireClockValid = true;
    const pendingArm = deferred<RendezvousArmReceipt>();
    const expireCancel = vi.fn();
    const expiring = coordinator(
      () => (expireClockValid ? 10_600 : Number.NaN),
      ['rv-invalid-expire-cleanup'],
    ).start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('expire-clock-peer', {
          arm: () => pendingArm.promise,
          cancel: expireCancel,
        }),
      ],
    });
    expireClockValid = false;
    expect(expiring.expire()).toMatchObject({
      status: 'cancelled',
      reasonCode: 'invalid-room-clock',
    });
    expect(expireCancel).toHaveBeenCalledOnce();
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

  it('refuses equal foreign state or older revisions without disturbing the latest attempt', () => {
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
    ).toThrow(/must match the active playback state/i);
    expect(() =>
      host.start({
        run: { ...RUN, queueItemId: QID_B },
        positionSeconds: 0,
        playbackRate: 1,
        participants: [],
      }),
    ).toThrow(/must match the active playback state/i);
    expect(() =>
      host.start({
        run: { ...RUN, runId: 'older-run', revision: RUN.revision - 1 },
        positionSeconds: 0,
        playbackRate: 1,
        participants: [],
      }),
    ).toThrow(/must not be older/i);
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

  it('replaces a pending same-state attempt and may target only a participant subset', async () => {
    const pendingArm = deferred<RendezvousArmReceipt>();
    const oldFinalize = vi.fn();
    const host = coordinator(() => 1_300, ['rv-pending', 'rv-recovery']);
    const pending = host.start({
      run: RUN,
      positionSeconds: 2,
      playbackRate: 1,
      participants: [
        participant('retry-peer', { arm: () => pendingArm.promise, finalize: oldFinalize }),
        participant('dropped-peer', { arm: () => pendingArm.promise, finalize: oldFinalize }),
      ],
    });

    const recovery = host.start({
      run: RUN,
      positionSeconds: 2.5,
      playbackRate: 1,
      participants: [participant('retry-peer')],
    });
    await drainMicrotasks();

    expect(pending.getSnapshot()).toMatchObject({
      status: 'superseded',
      reasonCode: 'replacement-rendezvous',
      participants: [
        { participantId: 'retry-peer', armStatus: 'stale', finalizeStatus: 'stale' },
        { participantId: 'dropped-peer', armStatus: 'stale', finalizeStatus: 'stale' },
      ],
    });
    expect(oldFinalize).not.toHaveBeenCalled();
    expect(recovery.getSnapshot()).toMatchObject({
      status: 'complete',
      run: RUN,
      positionSeconds: 2.5,
      participants: [{ participantId: 'retry-peer', finalizeStatus: 'accepted' }],
    });
  });

  it('keeps the room transition and participant recovery slots independently active', async () => {
    const oldArm = deferred<RendezvousArmReceipt>();
    const peerBArm = deferred<RendezvousArmReceipt>();
    let oldIntent: RendezvousArmIntent | null = null;
    let peerBIntent: RendezvousArmIntent | null = null;
    const oldFinalize = vi.fn();
    const peerBFinalize = vi.fn(async (intent: RendezvousFinalizeIntent) =>
      finalizedReceipt(intent),
    );
    const oldCancel = vi.fn();
    const peerBCancel = vi.fn();
    const replacementCancel = vi.fn();
    const host = coordinator(
      () => 1_325,
      ['rv-transition', 'rv-recovery-a', 'rv-recovery-b', 'rv-recovery-a-2'],
    );
    const transition = host.start({
      run: RUN,
      positionSeconds: 2,
      playbackRate: 1,
      participants: [],
    });
    const recoveryA = host.startRecovery({
      run: RUN,
      positionSeconds: 2,
      playbackRate: 1,
      participants: [
        participant('peer-a', {
          arm: (intent) => {
            oldIntent = intent;
            return oldArm.promise;
          },
          finalize: oldFinalize,
          cancel: oldCancel,
        }),
      ],
    });
    const recoveryB = host.startRecovery({
      run: RUN,
      positionSeconds: 2,
      playbackRate: 1,
      participants: [
        participant('peer-b', {
          arm: (intent) => {
            peerBIntent = intent;
            return peerBArm.promise;
          },
          finalize: peerBFinalize,
          cancel: peerBCancel,
        }),
      ],
    });
    const replacementA = host.startRecovery({
      run: RUN,
      positionSeconds: 2.25,
      playbackRate: 1,
      participants: [participant('peer-a', { cancel: replacementCancel })],
    });
    await drainMicrotasks();

    expect(transition.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-transition',
    });
    expect(recoveryA.getSnapshot()).toMatchObject({
      status: 'superseded',
      reasonCode: 'replacement-rendezvous',
    });
    expect(oldCancel).toHaveBeenCalledOnce();
    expect(recoveryB.getSnapshot()).toMatchObject({
      status: 'open',
      rendezvousId: 'rv-recovery-b',
    });
    expect(peerBCancel).not.toHaveBeenCalled();
    expect(replacementA.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-recovery-a-2',
      positionSeconds: 2.25,
    });

    oldArm.resolve(armedReceipt(oldIntent!));
    peerBArm.resolve(armedReceipt(peerBIntent!));
    await drainMicrotasks();
    expect(oldFinalize).not.toHaveBeenCalled();
    expect(peerBFinalize).toHaveBeenCalledOnce();
    expect(recoveryB.getSnapshot()).toMatchObject({
      status: 'complete',
      participants: [{ participantId: 'peer-b', finalizeStatus: 'accepted' }],
    });

    host.close();
    expect(transition.getSnapshot()).toMatchObject({
      status: 'cancelled',
      reasonCode: 'coordinator-closed',
    });
    expect(recoveryB.getSnapshot().status).toBe('cancelled');
    expect(replacementA.getSnapshot().status).toBe('cancelled');
    expect(peerBCancel).toHaveBeenCalledOnce();
    expect(replacementCancel).toHaveBeenCalledOnce();
    expect(recoveryB.commitParticipant('peer-b')).toBe(false);
    expect(replacementA.commitParticipant('peer-a')).toBe(false);
  });

  it('lets recovery replacement cancellation re-enter a different participant slot', async () => {
    const pendingArm = deferred<RendezvousArmReceipt>();
    const outerArm = vi.fn(async (intent: RendezvousArmIntent) => armedReceipt(intent));
    let nested: ReturnType<HostRendezvousCoordinator['startRecovery']> | null = null;
    let host!: HostRendezvousCoordinator;
    host = coordinator(() => 1_330, ['rv-transition', 'rv-old-a', 'rv-outer-a', 'rv-nested-b']);
    const transition = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });
    const old = host.startRecovery({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('peer-a', {
          arm: () => pendingArm.promise,
          cancel: () => {
            nested = host.startRecovery({
              run: RUN,
              positionSeconds: 0,
              playbackRate: 1,
              participants: [participant('peer-b')],
            });
          },
        }),
      ],
    });

    const outer = host.startRecovery({
      run: RUN,
      positionSeconds: 1,
      playbackRate: 1,
      participants: [participant('peer-a', { arm: outerArm })],
    });
    await drainMicrotasks();

    expect(old.getSnapshot()).toMatchObject({ status: 'superseded' });
    expect(transition.getSnapshot()).toMatchObject({ status: 'complete' });
    expect(outerArm).toHaveBeenCalledOnce();
    expect(outer.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-outer-a',
    });
    expect(nested).not.toBeNull();
    expect(nested!.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-nested-b',
    });
  });

  it('supersedes every older recovery only when playback advances', async () => {
    const transitionArm = deferred<RendezvousArmReceipt>();
    const recoveryAArm = deferred<RendezvousArmReceipt>();
    const recoveryBArm = deferred<RendezvousArmReceipt>();
    const transitionFinalize = vi.fn();
    const recoveryAFinalize = vi.fn();
    const recoveryBFinalize = vi.fn();
    const transitionCancel = vi.fn();
    const recoveryACancel = vi.fn();
    const recoveryBCancel = vi.fn();
    const host = coordinator(
      () => 1_335,
      ['rv-transition', 'rv-recovery-a', 'rv-recovery-b', 'rv-newer', 'rv-new-state-recovery'],
    );
    const transition = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('transition-peer', {
          arm: () => transitionArm.promise,
          finalize: transitionFinalize,
          cancel: transitionCancel,
        }),
      ],
    });
    const recoveryA = host.startRecovery({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('peer-a', {
          arm: () => recoveryAArm.promise,
          finalize: recoveryAFinalize,
          cancel: recoveryACancel,
        }),
      ],
    });
    const recoveryB = host.startRecovery({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('peer-b', {
          arm: () => recoveryBArm.promise,
          finalize: recoveryBFinalize,
          cancel: recoveryBCancel,
        }),
      ],
    });

    const newerRun = Object.freeze({ ...RUN, runId: 'run-newer', revision: RUN.revision + 1 });
    const newer = host.start({
      run: newerRun,
      positionSeconds: 4,
      playbackRate: 1,
      participants: [],
    });
    expect(newer.getSnapshot()).toMatchObject({ status: 'complete', run: newerRun });
    for (const attempt of [transition, recoveryA, recoveryB]) {
      expect(attempt.getSnapshot()).toMatchObject({
        status: 'superseded',
        reasonCode: 'newer-rendezvous',
      });
    }
    expect(transitionCancel).toHaveBeenCalledOnce();
    expect(recoveryACancel).toHaveBeenCalledOnce();
    expect(recoveryBCancel).toHaveBeenCalledOnce();

    transitionArm.resolve({} as RendezvousArmReceipt);
    recoveryAArm.resolve({} as RendezvousArmReceipt);
    recoveryBArm.resolve({} as RendezvousArmReceipt);
    await drainMicrotasks();
    expect(transitionFinalize).not.toHaveBeenCalled();
    expect(recoveryAFinalize).not.toHaveBeenCalled();
    expect(recoveryBFinalize).not.toHaveBeenCalled();

    expect(() =>
      host.startRecovery({
        run: RUN,
        positionSeconds: 0,
        playbackRate: 1,
        participants: [participant('stale-peer')],
      }),
    ).toThrow(/stale/u);
    const currentRecovery = host.startRecovery({
      run: newerRun,
      positionSeconds: 4,
      playbackRate: 1,
      participants: [participant('current-peer')],
    });
    await drainMicrotasks();
    expect(currentRecovery.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-new-state-recovery',
    });
  });

  it('protects committed participants while replacing a complete same-state candidate set', async () => {
    const committedCancel = vi.fn();
    const candidateCancel = vi.fn();
    const host = coordinator(() => 1_350, ['rv-complete', 'rv-recovery']);
    const complete = host.start({
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
    expect(complete.getSnapshot().status).toBe('complete');
    expect(complete.commitParticipant('committed-peer')).toBe(true);

    const recovery = host.start({
      run: RUN,
      positionSeconds: 3,
      playbackRate: 1,
      participants: [participant('committed-peer')],
    });
    await drainMicrotasks();

    expect(committedCancel).not.toHaveBeenCalled();
    expect(candidateCancel).toHaveBeenCalledWith({
      kind: 'file-playback-cancel',
      ...RUN,
      rendezvousId: 'rv-complete',
      reasonCode: 'replacement-rendezvous',
    });
    expect(complete.getSnapshot()).toMatchObject({
      status: 'superseded',
      reasonCode: 'replacement-rendezvous',
    });
    expect(recovery.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-recovery',
      participants: [{ participantId: 'committed-peer', finalizeStatus: 'accepted' }],
    });
  });

  it('starts same-state recovery after the active attempt was already cancelled', () => {
    const host = coordinator(() => 1_375, ['rv-cancelled', 'rv-after-cancel']);
    const cancelled = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });
    cancelled.cancel('manual-recovery');

    const recovery = host.start({
      run: RUN,
      positionSeconds: 1,
      playbackRate: 1,
      participants: [],
    });

    expect(cancelled.getSnapshot()).toMatchObject({
      status: 'cancelled',
      reasonCode: 'manual-recovery',
    });
    expect(recovery.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-after-cancel',
      run: RUN,
    });
  });

  it('rejects rendezvous ID reuse across same-state replacement generations', () => {
    const host = coordinator(() => 1_390, ['rv-a', 'rv-b', 'rv-a', 'rv-a']);
    const first = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });
    const second = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });

    expect(() =>
      host.start({
        run: RUN,
        positionSeconds: 0,
        playbackRate: 1,
        participants: [],
      }),
    ).toThrow(/must differ/);
    expect(first.getSnapshot()).toMatchObject({
      status: 'superseded',
      reasonCode: 'replacement-rendezvous',
    });
    expect(second.getSnapshot()).toMatchObject({ status: 'complete', rendezvousId: 'rv-b' });

    const newerState = host.start({
      run: { ...RUN, runId: 'run-newer', revision: RUN.revision + 1 },
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });
    expect(second.getSnapshot()).toMatchObject({
      status: 'superseded',
      reasonCode: 'newer-rendezvous',
    });
    expect(newerState.getSnapshot()).toMatchObject({ status: 'complete', rendezvousId: 'rv-a' });
  });

  it('requires one exact current-state participant and a fresh recovery ID', () => {
    const noState = coordinator(() => 1_388, ['rv-unused']);
    expect(() =>
      noState.startRecovery({
        run: RUN,
        positionSeconds: 0,
        playbackRate: 1,
        participants: [participant('peer')],
      }),
    ).toThrow(/requires an active playback state/u);

    const pendingArm = deferred<RendezvousArmReceipt>();
    const host = coordinator(() => 1_389, ['rv-state', 'rv-fresh', 'rv-fresh', 'rv-after-cancel']);
    const transition = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });
    expect(() =>
      host.startRecovery({
        run: RUN,
        positionSeconds: 0,
        playbackRate: 1,
        participants: [],
      } as never),
    ).toThrow(/exactly one participant/u);
    expect(() =>
      host.startRecovery({
        run: RUN,
        positionSeconds: 0,
        playbackRate: 1,
        participants: [participant('peer-a'), participant('peer-b')],
      } as never),
    ).toThrow(/exactly one participant/u);
    expect(() =>
      host.startRecovery({
        run: { ...RUN, revision: RUN.revision - 1 },
        positionSeconds: 0,
        playbackRate: 1,
        participants: [participant('peer')],
      }),
    ).toThrow(/stale/u);
    expect(() =>
      host.startRecovery({
        run: { ...RUN, revision: RUN.revision + 1 },
        positionSeconds: 0,
        playbackRate: 1,
        participants: [participant('peer')],
      }),
    ).toThrow(/cannot advance/u);
    expect(() =>
      host.startRecovery({
        run: { ...RUN, runId: 'foreign-run' },
        positionSeconds: 0,
        playbackRate: 1,
        participants: [participant('peer')],
      }),
    ).toThrow(/must match/u);

    const recovery = host.startRecovery({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [participant('peer-a', { arm: () => pendingArm.promise })],
    });
    expect(() =>
      host.startRecovery({
        run: RUN,
        positionSeconds: 0,
        playbackRate: 1,
        participants: [participant('peer-b')],
      }),
    ).toThrow(/must be fresh/u);
    expect(recovery.getSnapshot()).toMatchObject({
      status: 'open',
      rendezvousId: 'rv-fresh',
    });
    expect(transition.getSnapshot()).toMatchObject({ status: 'complete' });

    transition.cancel('room-transition-retired');
    const afterCancel = host.startRecovery({
      run: RUN,
      positionSeconds: 1,
      playbackRate: 1,
      participants: [participant('peer-b')],
    });
    expect(afterCancel.rendezvousId).toBe('rv-after-cancel');
    expect(recovery.getSnapshot().status).toBe('open');
  });

  it('keeps same-state recovery available beyond the bounded recent-ID window', () => {
    let nextId = 0;
    let forcedId: string | null = null;
    const host = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => 1_392,
      createRendezvousId: () => forcedId ?? `rv-window-${nextId++}`,
    });
    let latest = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });
    let recentRetiredId = '';
    for (let index = 1; index <= 300; index += 1) {
      if (index === 300) recentRetiredId = latest.rendezvousId;
      latest = host.start({
        run: RUN,
        positionSeconds: index,
        playbackRate: 1,
        participants: [],
      });
    }
    expect(latest.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-window-300',
      positionSeconds: 300,
    });

    forcedId = recentRetiredId;
    expect(() =>
      host.start({
        run: RUN,
        positionSeconds: 301,
        playbackRate: 1,
        participants: [],
      }),
    ).toThrow(/must differ/);
    expect(latest.getSnapshot().status).toBe('complete');

    forcedId = 'rv-window-0';
    const afterEviction = host.start({
      run: RUN,
      positionSeconds: 302,
      playbackRate: 1,
      participants: [],
    });
    expect(afterEviction.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-window-0',
      positionSeconds: 302,
    });
  });

  it('bounds recovery ID history without permitting any still-active ID', () => {
    let nextId = 0;
    let forcedId: string | null = null;
    const neverArmed = new Promise<RendezvousArmReceipt>(() => undefined);
    const host = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => 1_393,
      createRendezvousId: () => forcedId ?? `rv-recovery-window-${nextId++}`,
    });
    const transition = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });
    let latest: HostRendezvousAttempt | null = null;
    for (let index = 1; index <= 300; index += 1) {
      latest = host.startRecovery({
        run: RUN,
        positionSeconds: index,
        playbackRate: 1,
        participants: [participant('window-peer', { arm: () => neverArmed })],
      });
    }
    expect(latest!.getSnapshot()).toMatchObject({
      status: 'open',
      rendezvousId: 'rv-recovery-window-300',
      positionSeconds: 300,
    });

    forcedId = 'rv-recovery-window-299';
    expect(() =>
      host.startRecovery({
        run: RUN,
        positionSeconds: 301,
        playbackRate: 1,
        participants: [participant('window-peer', { arm: () => neverArmed })],
      }),
    ).toThrow(/must be fresh/u);
    forcedId = transition.rendezvousId;
    expect(() =>
      host.startRecovery({
        run: RUN,
        positionSeconds: 301,
        playbackRate: 1,
        participants: [participant('window-peer', { arm: () => neverArmed })],
      }),
    ).toThrow(/must be fresh/u);

    forcedId = 'rv-recovery-window-1';
    const afterEviction = host.startRecovery({
      run: RUN,
      positionSeconds: 302,
      playbackRate: 1,
      participants: [participant('window-peer', { arm: () => neverArmed })],
    });
    expect(afterEviction.getSnapshot()).toMatchObject({
      status: 'open',
      rendezvousId: 'rv-recovery-window-1',
      positionSeconds: 302,
    });
    expect(latest!.getSnapshot()).toMatchObject({
      status: 'superseded',
      reasonCode: 'replacement-rendezvous',
    });
  });

  it('does not let a reentrant same-state recovery get rolled back by its caller', () => {
    let idCall = 0;
    let nested: ReturnType<HostRendezvousCoordinator['start']> | null = null;
    let host!: HostRendezvousCoordinator;
    host = new HostRendezvousCoordinator({
      nowRoomTimeMs: () => 1_395,
      createRendezvousId: () => {
        idCall += 1;
        if (idCall === 1) return 'rv-initial';
        if (idCall === 2) {
          nested = host.start({
            run: RUN,
            positionSeconds: 4,
            playbackRate: 1,
            participants: [],
          });
          return 'rv-outer';
        }
        return 'rv-nested';
      },
    });
    const initial = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [],
    });

    expect(() =>
      host.start({
        run: RUN,
        positionSeconds: 2,
        playbackRate: 1,
        participants: [],
      }),
    ).toThrow(/superseded/);
    expect(initial.getSnapshot()).toMatchObject({
      status: 'superseded',
      reasonCode: 'replacement-rendezvous',
    });
    expect(nested).not.toBeNull();
    expect(nested!.getSnapshot()).toMatchObject({
      status: 'complete',
      rendezvousId: 'rv-nested',
      positionSeconds: 4,
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

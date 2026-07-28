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
  type HostRendezvousParticipant,
} from '../rendezvous-coordinator.ts';

const RUN = Object.freeze({
  queueItemId: '00000000-0000-4000-8000-0000000000aa' as QueueItemId,
  runId: 'run-participant-acceptance',
  revision: 4,
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function armedReceipt(intent: RendezvousArmIntent): RendezvousArmReceipt {
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
    bufferedAheadSeconds: 4,
    reasonCode: null,
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

function coordinator(nowRoomTimeMs: () => number, id = 'rv-participant') {
  return new HostRendezvousCoordinator({
    nowRoomTimeMs,
    createRendezvousId: () => id,
  });
}

async function drainMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

describe('HostRendezvousAttempt.whenParticipantAccepted', () => {
  it('settles each exact participant once while preserving the independent first acceptance', async () => {
    const finalizeA = deferred<RendezvousFinalizeReceipt>();
    const finalizeB = deferred<RendezvousFinalizeReceipt>();
    let intentA: RendezvousFinalizeIntent | null = null;
    let intentB: RendezvousFinalizeIntent | null = null;
    const attempt = coordinator(() => 10_000, 'rv-exact').start({
      run: RUN,
      positionSeconds: 8.25,
      playbackRate: 1.1,
      participants: [
        participant('peer-a', {
          finalize: (intent) => {
            intentA = intent;
            return finalizeA.promise;
          },
        }),
        participant('peer-b', {
          finalize: (intent) => {
            intentB = intent;
            return finalizeB.promise;
          },
        }),
      ],
    });
    const acceptedA = attempt.whenParticipantAccepted('peer-a');
    const acceptedB = attempt.whenParticipantAccepted('peer-b');
    const firstAccepted = attempt.whenFirstParticipantAccepted();
    expect(attempt.whenParticipantAccepted('peer-a')).toBe(acceptedA);
    expect(attempt.whenParticipantAccepted('peer-b')).toBe(acceptedB);

    await drainMicrotasks();
    finalizeB.resolve(finalizedReceipt(intentB!));
    const [settlementB, first] = await Promise.all([acceptedB, firstAccepted]);
    expect(first.acceptedParticipantId).toBe('peer-b');
    expect(settlementB).toEqual({
      protocolVersion: 2,
      kind: 'host-rendezvous-participant-accepted',
      acceptedParticipantId: 'peer-b',
      attempt: { ...RUN, rendezvousId: 'rv-exact' },
      schedule: {
        positionSeconds: 8.25,
        playbackRate: 1.1,
        createdAtRoomTimeMs: 10_000,
        leadTimeMs: 450,
        finalizeByRoomTimeMs: 10_350,
        startAtRoomTimeMs: 10_450,
      },
    });

    finalizeA.resolve(finalizedReceipt(intentA!));
    const settlementA = await acceptedA;
    expect(settlementA.acceptedParticipantId).toBe('peer-a');
    expect(await attempt.whenParticipantAccepted('peer-a')).toBe(settlementA);
    expect(await attempt.whenParticipantAccepted('peer-b')).toBe(settlementB);
    for (const settlement of [settlementA, settlementB]) {
      expect(Object.isFrozen(settlement)).toBe(true);
      expect(Object.isFrozen(settlement.attempt)).toBe(true);
      expect(Object.isFrozen(settlement.schedule)).toBe(true);
      expect(Reflect.getPrototypeOf(settlement)).toBeNull();
      expect(Reflect.getPrototypeOf(settlement.attempt)).toBeNull();
      expect(Reflect.getPrototypeOf(settlement.schedule)).toBeNull();
      expect(JSON.stringify(settlement)).not.toContain('receipt');
      expect(JSON.stringify(settlement)).not.toContain('body');
    }
  });

  it('rejects one participant terminally without disturbing a healthy participant', async () => {
    const rejectedFinalize = vi.fn(async (intent: RendezvousFinalizeIntent) =>
      finalizedReceipt(intent, { status: 'rejected', reasonCode: 'renderer-not-ready' }),
    );
    const attempt = coordinator(() => 2_000, 'rv-rejected').start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('rejected-peer', { finalize: rejectedFinalize }),
        participant('healthy-peer'),
      ],
    });
    const rejected = attempt.whenParticipantAccepted('rejected-peer');
    const healthy = attempt.whenParticipantAccepted('healthy-peer');

    await expect(rejected).rejects.toThrow(
      'Host rendezvous participant acceptance rejected: rejected-peer: renderer-not-ready',
    );
    await expect(healthy).resolves.toMatchObject({ acceptedParticipantId: 'healthy-peer' });
    expect(attempt.whenParticipantAccepted('rejected-peer')).toBe(rejected);
  });

  it('rejects an exact pending participant on expiry, cancellation, and coordinator close', async () => {
    let expiryNow = 1_000;
    const expiringAttempt = coordinator(() => expiryNow, 'rv-expire').start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('expiring-peer', {
          arm: () => new Promise(() => undefined),
        }),
      ],
    });
    const expired = expiringAttempt.whenParticipantAccepted('expiring-peer');
    expiryNow = expiringAttempt.startAtRoomTimeMs + 1;
    expiringAttempt.expire();
    await expect(expired).rejects.toThrow(
      'Host rendezvous participant acceptance missed-deadline: expiring-peer: arm-receipt-not-received',
    );

    const cancellingAttempt = coordinator(() => 1_000, 'rv-cancel').start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('cancelled-peer', {
          arm: () => new Promise(() => undefined),
        }),
      ],
    });
    const cancelled = cancellingAttempt.whenParticipantAccepted('cancelled-peer');
    cancellingAttempt.cancel('product-room-ended');
    await expect(cancelled).rejects.toThrow(
      'Host rendezvous participant acceptance stale: cancelled-peer: product-room-ended',
    );

    const host = coordinator(() => 1_000, 'rv-close');
    const closingAttempt = host.start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('closing-peer', {
          arm: () => new Promise(() => undefined),
        }),
      ],
    });
    const closed = closingAttempt.whenParticipantAccepted('closing-peer');
    host.close();
    await expect(closed).rejects.toThrow(
      'Host rendezvous participant acceptance stale: closing-peer: coordinator-closed',
    );
  });

  it('rejects malformed and foreign IDs without coercion or waiter creation', () => {
    const attempt = coordinator(() => 1_000, 'rv-identity').start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [participant('known-peer')],
    });
    const malicious = {
      toString() {
        throw new Error('participant ID coercion must not run');
      },
    };

    expect(() => attempt.whenParticipantAccepted('')).toThrow(
      'Rendezvous participant ID is invalid',
    );
    expect(() => attempt.whenParticipantAccepted('x'.repeat(257))).toThrow(
      'Rendezvous participant ID is invalid',
    );
    expect(() => attempt.whenParticipantAccepted(malicious as never)).toThrow(
      'Rendezvous participant ID is invalid',
    );
    expect(() => attempt.whenParticipantAccepted('foreign-peer')).toThrow(
      'Rendezvous participant does not belong to this attempt',
    );
  });

  it('delivers acceptance handlers only after FINALIZE processing has returned', async () => {
    const finalizeGate = deferred<RendezvousFinalizeReceipt>();
    let finalizeIntent: RendezvousFinalizeIntent | null = null;
    const attempt = coordinator(() => 1_000, 'rv-no-reentry').start({
      run: RUN,
      positionSeconds: 0,
      playbackRate: 1,
      participants: [
        participant('peer', {
          finalize: (intent) => {
            finalizeIntent = intent;
            return finalizeGate.promise;
          },
        }),
      ],
    });
    const order: string[] = [];
    void attempt.whenParticipantAccepted('peer').then(() => order.push('acceptance-handler'));
    await drainMicrotasks();

    order.push('before-finalize-resolution');
    finalizeGate.resolve(finalizedReceipt(finalizeIntent!));
    order.push('after-finalize-resolution');
    expect(order).toEqual(['before-finalize-resolution', 'after-finalize-resolution']);

    await drainMicrotasks();
    expect(order).toEqual([
      'before-finalize-resolution',
      'after-finalize-resolution',
      'acceptance-handler',
    ]);
  });
});

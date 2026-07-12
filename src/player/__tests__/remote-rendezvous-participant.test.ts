import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import type { FilePlaybackCancelIntent } from '../file-playback-source.ts';
import {
  RemoteRendezvousParticipant,
  type RemoteRendezvousParticipantOptions,
} from '../remote-rendezvous-participant.ts';
import {
  readRendezvousArmReceipt,
  readRendezvousFinalizeReceipt,
  type RendezvousArmIntent,
  type RendezvousArmReceipt,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
} from '../rendezvous-contract.ts';

const QID = '00000000-0000-4000-8000-0000000000aa' as QueueItemId;
const OTHER_QID = '00000000-0000-4000-8000-0000000000bb' as QueueItemId;
const PARTICIPANT_ID = 'remote-peer';

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function armIntent(overrides: Partial<RendezvousArmIntent> = {}): RendezvousArmIntent {
  return Object.freeze({
    protocolVersion: 2,
    kind: 'rendezvous-arm',
    queueItemId: QID,
    runId: 'run-a',
    revision: 7,
    rendezvousId: 'rv-a',
    recipientId: PARTICIPANT_ID,
    positionSeconds: 12,
    playbackRate: 1,
    startAtRoomTimeMs: 2_000,
    finalizeByRoomTimeMs: 1_900,
    ...overrides,
  });
}

function finalizeIntent(
  overrides: Partial<RendezvousFinalizeIntent> = {},
): RendezvousFinalizeIntent {
  return Object.freeze({
    protocolVersion: 2,
    kind: 'rendezvous-finalize',
    queueItemId: QID,
    runId: 'run-a',
    revision: 7,
    rendezvousId: 'rv-a',
    recipientId: PARTICIPANT_ID,
    startAtRoomTimeMs: 2_000,
    finalizedAtRoomTimeMs: 1_800,
    ...overrides,
  });
}

function armReceipt(
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
    observedAtRoomTimeMs: 1_500,
    bufferedAheadSeconds: 4,
    reasonCode: null,
    ...overrides,
  };
}

function finalizeReceipt(
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
    observedAtRoomTimeMs: 1_800,
    reasonCode: null,
    ...overrides,
  };
}

function cancelIntent(overrides: Partial<FilePlaybackCancelIntent> = {}): FilePlaybackCancelIntent {
  return Object.freeze({
    kind: 'file-playback-cancel',
    queueItemId: QID,
    runId: 'run-a',
    revision: 7,
    reasonCode: 'host-cancelled',
    ...overrides,
  });
}

function participant(
  overrides: Partial<RemoteRendezvousParticipantOptions> = {},
): RemoteRendezvousParticipant {
  return new RemoteRendezvousParticipant({
    participantId: PARTICIPANT_ID,
    rttP95Ms: 40,
    armP95Ms: 80,
    nowRoomTimeMs: () => 1_600,
    dispatchArm: () => undefined,
    dispatchFinalize: () => undefined,
    dispatchCancel: () => undefined,
    ...overrides,
  });
}

describe('RemoteRendezvousParticipant', () => {
  it('dispatches immutable requests and resolves only exact admitted receipts', async () => {
    const arms: RendezvousArmIntent[] = [];
    const finalizes: RendezvousFinalizeIntent[] = [];
    const remote = participant({
      dispatchArm: (intent) => arms.push(intent),
      dispatchFinalize: (intent) => finalizes.push(intent),
    });
    const arm = armIntent();
    const pendingArm = remote.arm(arm);

    expect(arms).toHaveLength(1);
    expect(arms[0]).toEqual(arm);
    expect(arms[0]).not.toBe(arm);
    expect(Object.isFrozen(arms[0])).toBe(true);
    expect(Object.getPrototypeOf(arms[0])).toBeNull();
    expect(remote.acceptArmReceipt({ ...armReceipt(arm), ignored: 'wire-junk' })).toBe(true);
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(false);

    const acceptedArm = await pendingArm;
    expect(acceptedArm).toEqual(armReceipt(arm));
    expect(Object.isFrozen(acceptedArm)).toBe(true);
    expect(Object.getPrototypeOf(acceptedArm)).toBeNull();
    expect('ignored' in acceptedArm).toBe(false);

    const finalize = finalizeIntent();
    const pendingFinalize = remote.finalize(finalize);
    expect(finalizes).toHaveLength(1);
    expect(finalizes[0]).toEqual(finalize);
    expect(finalizes[0]).not.toBe(finalize);
    expect(Object.isFrozen(finalizes[0])).toBe(true);
    expect(remote.acceptFinalizeReceipt(finalizeReceipt(finalize))).toBe(true);

    const acceptedFinalize = await pendingFinalize;
    expect(acceptedFinalize.status).toBe('accepted');
    expect(Object.isFrozen(acceptedFinalize)).toBe(true);
  });

  it('coalesces duplicate arm and finalize calls onto their exact promises', async () => {
    const dispatchArm = vi.fn();
    const dispatchFinalize = vi.fn();
    const remote = participant({ dispatchArm, dispatchFinalize });
    const arm = armIntent();

    const firstArm = remote.arm(arm);
    const duplicateArm = remote.arm({ ...arm });
    expect(duplicateArm).toBe(firstArm);
    expect(dispatchArm).toHaveBeenCalledOnce();
    remote.acceptArmReceipt(armReceipt(arm));
    await firstArm;

    const finalize = finalizeIntent();
    const firstFinalize = remote.finalize(finalize);
    const duplicateFinalize = remote.finalize({ ...finalize });
    expect(duplicateFinalize).toBe(firstFinalize);
    expect(dispatchFinalize).toHaveBeenCalledOnce();
    remote.acceptFinalizeReceipt(finalizeReceipt(finalize));
    await firstFinalize;
  });

  it('supersedes pending work with a deterministic rejected receipt', async () => {
    const dispatchArm = vi.fn();
    const remote = participant({ dispatchArm });
    const oldIntent = armIntent();
    const newerIntent = armIntent({
      runId: 'run-b',
      revision: 8,
      rendezvousId: 'rv-b',
    });

    const oldPending = remote.arm(oldIntent);
    const newerPending = remote.arm(newerIntent);

    await expect(oldPending).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-operation-superseded',
    });
    expect(dispatchArm).toHaveBeenCalledTimes(2);
    expect(remote.acceptArmReceipt(armReceipt(oldIntent))).toBe(false);
    expect(remote.acceptArmReceipt(armReceipt(newerIntent))).toBe(true);
    await expect(newerPending).resolves.toMatchObject({ status: 'armed', revision: 8 });
  });

  it('allows a newer rendezvous for the same revisioned run while fencing the old one', async () => {
    const remote = participant();
    const first = armIntent();
    const retry = armIntent({ rendezvousId: 'rv-retry', startAtRoomTimeMs: 2_100 });

    const oldPending = remote.arm(first);
    const retryPending = remote.arm(retry);

    await expect(oldPending).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-operation-superseded',
    });
    expect(remote.acceptArmReceipt(armReceipt(first))).toBe(false);
    expect(remote.acceptArmReceipt(armReceipt(retry))).toBe(true);
    await expect(retryPending).resolves.toMatchObject({ rendezvousId: 'rv-retry' });
  });

  it('does not let older or conflicting calls replace the active correlation', async () => {
    const dispatchArm = vi.fn();
    const remote = participant({ dispatchArm });
    const active = armIntent({ revision: 8, runId: 'run-b', rendezvousId: 'rv-b' });
    const activePending = remote.arm(active);

    await expect(remote.arm(armIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-operation-superseded',
    });
    await expect(remote.arm({ ...active, positionSeconds: 99 })).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-operation-conflict',
    });
    expect(dispatchArm).toHaveBeenCalledOnce();

    expect(remote.acceptArmReceipt(armReceipt(active))).toBe(true);
    await expect(activePending).resolves.toMatchObject({ status: 'armed', revision: 8 });
  });

  it('keeps malformed, accessor, and mismatched arm receipts inert and closes late work', async () => {
    let now = 1_600;
    const remote = participant({ nowRoomTimeMs: () => now });
    const arm = armIntent();
    const pending = remote.arm(arm);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    expect(remote.acceptArmReceipt(null)).toBe(false);
    expect(remote.acceptArmReceipt({ ...armReceipt(arm), participantId: 'other' })).toBe(false);
    expect(remote.acceptArmReceipt({ ...armReceipt(arm), queueItemId: OTHER_QID })).toBe(false);
    let accessorReads = 0;
    const hostile = { ...armReceipt(arm) };
    Object.defineProperty(hostile, 'participantId', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return PARTICIPANT_ID;
      },
    });
    expect(remote.acceptArmReceipt(hostile)).toBe(false);
    expect(accessorReads).toBe(0);
    now = 1_901;
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(false);
    await expect(pending).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-arm-receipt-late',
    });
    expect(settled).toBe(true);

    now = 1_800;
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(false);
  });

  it('keeps malformed, mismatched, and late finalize receipts inert', async () => {
    let now = 1_600;
    const remote = participant({ nowRoomTimeMs: () => now });
    const arm = armIntent();
    const finalize = finalizeIntent();
    remote.arm(arm);
    remote.acceptArmReceipt(armReceipt(arm));
    const pending = remote.finalize(finalize);

    expect(remote.acceptFinalizeReceipt({ ...finalizeReceipt(finalize), runId: 'other' })).toBe(
      false,
    );
    let accessorReads = 0;
    const hostile = { ...finalizeReceipt(finalize) };
    Object.defineProperty(hostile, 'status', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'accepted';
      },
    });
    expect(remote.acceptFinalizeReceipt(hostile)).toBe(false);
    expect(accessorReads).toBe(0);
    now = 2_001;
    expect(remote.acceptFinalizeReceipt(finalizeReceipt(finalize))).toBe(false);
    await expect(pending).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-finalize-receipt-late',
    });

    now = 1_900;
    expect(remote.acceptFinalizeReceipt(finalizeReceipt(finalize))).toBe(false);
  });

  it('accepts exact remote rejection receipts for coordinator-level classification', async () => {
    const remote = participant();
    const arm = armIntent();
    const pendingArm = remote.arm(arm);
    expect(
      remote.acceptArmReceipt(
        armReceipt(arm, {
          status: 'rejected',
          bufferedAheadSeconds: 0,
          reasonCode: 'remote-source-unavailable',
        }),
      ),
    ).toBe(true);
    await expect(pendingArm).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-source-unavailable',
    });
    await expect(remote.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-rendezvous-not-armed',
    });
  });

  it('settles an exact pending arm before best-effort cancellation and never awaits transport', async () => {
    const never = new Promise<void>(() => undefined);
    const dispatchCancel = vi.fn(() => never);
    const remote = participant({ dispatchCancel });
    const arm = armIntent();
    const pending = remote.arm(arm);

    await expect(remote.cancel(cancelIntent({ runId: 'wrong' }))).resolves.toBeUndefined();
    expect(dispatchCancel).not.toHaveBeenCalled();
    await expect(remote.cancel(cancelIntent())).resolves.toBeUndefined();
    await expect(pending).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-operation-cancelled',
    });
    expect(dispatchCancel).toHaveBeenCalledOnce();
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(false);
  });

  it('settles pending finalize work on exact cancellation and swallows cancellation failure', async () => {
    const dispatchCancel = vi.fn(() => {
      throw undefined;
    });
    const remote = participant({ dispatchCancel });
    const arm = armIntent();
    const finalize = finalizeIntent();
    remote.arm(arm);
    remote.acceptArmReceipt(armReceipt(arm));
    const pendingFinalize = remote.finalize(finalize);

    await expect(remote.cancel(cancelIntent())).resolves.toBeUndefined();
    await expect(pendingFinalize).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-operation-cancelled',
    });
    expect(remote.acceptFinalizeReceipt(finalizeReceipt(finalize))).toBe(false);
  });

  it('allows same-run recovery with a fresh rendezvous after cancellation', async () => {
    const dispatchArm = vi.fn();
    const remote = participant({ dispatchArm });
    const first = armIntent();
    const firstPending = remote.arm(first);
    await remote.cancel(cancelIntent());
    await firstPending;

    const recovery = armIntent({ rendezvousId: 'rv-recovery', startAtRoomTimeMs: 2_100 });
    const recoveryPending = remote.arm(recovery);
    expect(dispatchArm).toHaveBeenCalledTimes(2);
    expect(remote.acceptArmReceipt(armReceipt(recovery))).toBe(true);
    await expect(recoveryPending).resolves.toMatchObject({ rendezvousId: 'rv-recovery' });

    await expect(remote.arm(first)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-operation-superseded',
    });
  });

  it('normalizes synchronous callback throws including undefined into rejected receipts', async () => {
    const arm = armIntent();
    const brokenArm = participant({
      dispatchArm: () => {
        throw undefined;
      },
    });
    await expect(brokenArm.arm(arm)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-arm-dispatch-failed',
    });

    const finalize = finalizeIntent();
    const brokenFinalize = participant({
      dispatchFinalize: () => {
        throw undefined;
      },
    });
    brokenFinalize.arm(arm);
    brokenFinalize.acceptArmReceipt(armReceipt(arm));
    await expect(brokenFinalize.finalize(finalize)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-finalize-dispatch-failed',
    });
  });

  it('normalizes asynchronous dispatch rejection without overriding an admitted receipt', async () => {
    const arm = armIntent();
    const rejectedDispatch = participant({ dispatchArm: () => Promise.reject(undefined) });
    const failed = rejectedDispatch.arm(arm);
    await drainMicrotasks();
    await expect(failed).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-arm-dispatch-failed',
    });

    let rejectDispatch!: (reason?: unknown) => void;
    const transport = new Promise<void>((_resolve, reject) => {
      rejectDispatch = reject;
    });
    const receiptWins = participant({ dispatchArm: () => transport });
    const accepted = receiptWins.arm(arm);
    expect(receiptWins.acceptArmReceipt(armReceipt(arm))).toBe(true);
    rejectDispatch(undefined);
    await drainMicrotasks();
    await expect(accepted).resolves.toMatchObject({ status: 'armed' });
  });

  it('uses bounded metric fallbacks when dynamic providers fail', () => {
    let rtt = 25;
    const remote = participant({
      rttP95Ms: () => rtt,
      armP95Ms: () => {
        throw new Error('unavailable');
      },
    });

    expect(remote.rttP95Ms).toBe(25);
    rtt = Number.NaN;
    expect(remote.rttP95Ms).toBe(2_500);
    expect(remote.armP95Ms).toBe(2_500);
    expect(Number.isFinite(remote.rttP95Ms)).toBe(true);
    expect(remote.rttP95Ms).toBeGreaterThanOrEqual(0);
  });

  it('rejects invalid construction options and reads proxied intents without [[Get]]', async () => {
    expect(() => participant({ rttP95Ms: -1 })).toThrow(/rttP95Ms/);
    expect(() => participant({ participantId: '' })).toThrow(/participantId/);
    expect(() => participant({ dispatchArm: null as never })).toThrow(/dispatchArm/);

    const remote = participant();
    let getterReads = 0;
    const hostile = new Proxy(armIntent(), {
      get(target, property, receiver) {
        getterReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const pending = remote.arm(hostile);
    expect(getterReads).toBe(0);
    expect(remote.acceptArmReceipt(armReceipt(armIntent()))).toBe(true);
    const receipt = await pending;
    expect(receipt).toMatchObject({ status: 'armed' });
    expect(readRendezvousArmReceipt(receipt)).not.toBeNull();

    const invalidFinalize = await remote.finalize(null as never);
    expect(invalidFinalize).toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-finalize-intent',
    });
    // A response synthesized without an active intent deliberately carries the
    // stopped revision watermark (0), so it must not masquerade as a valid
    // active rendezvous receipt.
    expect(readRendezvousFinalizeReceipt(invalidFinalize)).toBeNull();
  });

  it('fails the exact pending receipt closed when the room clock cannot be read', async () => {
    let clockFails = true;
    const remote = participant({
      nowRoomTimeMs: () => {
        if (clockFails) throw new Error('clock unavailable');
        return 1_600;
      },
    });
    const arm = armIntent();
    const pending = remote.arm(arm);
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(false);
    await expect(pending).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-room-clock-invalid',
    });

    clockFails = false;
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(false);
  });

  it('rechecks authority after a room-clock callback cancels the pending arm', async () => {
    let remote!: RemoteRendezvousParticipant;
    let cancelDuringRead = true;
    remote = participant({
      nowRoomTimeMs: () => {
        if (cancelDuringRead) {
          cancelDuringRead = false;
          void remote.cancel(cancelIntent());
        }
        return 1_600;
      },
    });
    const arm = armIntent();
    const pending = remote.arm(arm);

    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(false);
    await expect(pending).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-operation-cancelled',
    });
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(false);
  });

  it('rechecks finalize authority after a room-clock callback supersedes the run', async () => {
    let remote!: RemoteRendezvousParticipant;
    let phase: 'arm' | 'finalize' | 'done' = 'arm';
    let replacementPending: Promise<RendezvousArmReceipt> | null = null;
    const replacement = armIntent({
      runId: 'run-b',
      revision: 8,
      rendezvousId: 'rv-b',
      startAtRoomTimeMs: 2_500,
      finalizeByRoomTimeMs: 2_400,
    });
    remote = participant({
      nowRoomTimeMs: () => {
        if (phase === 'finalize') {
          phase = 'done';
          replacementPending = remote.arm(replacement);
        }
        return phase === 'arm' ? 1_600 : 1_700;
      },
    });
    const arm = armIntent();
    remote.arm(arm);
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(true);
    phase = 'finalize';
    const finalize = finalizeIntent();
    const pendingFinalize = remote.finalize(finalize);

    expect(remote.acceptFinalizeReceipt(finalizeReceipt(finalize))).toBe(false);
    await expect(pendingFinalize).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-operation-superseded',
    });
    expect(replacementPending).not.toBeNull();
    expect(remote.acceptArmReceipt(armReceipt(replacement))).toBe(true);
    await expect(replacementPending!).resolves.toMatchObject({ status: 'armed', revision: 8 });
  });

  it('fails a clock rollback closed and never reopens the exact operation', async () => {
    let now = 1_600;
    const remote = participant({ nowRoomTimeMs: () => now });
    const first = armIntent();
    const firstPending = remote.arm(first);
    expect(remote.acceptArmReceipt(armReceipt(first))).toBe(true);
    await firstPending;

    const recovery = armIntent({
      rendezvousId: 'rv-clock-rollback',
      startAtRoomTimeMs: 2_500,
      finalizeByRoomTimeMs: 2_400,
    });
    const recoveryPending = remote.arm(recovery);
    now = 1_500;
    expect(remote.acceptArmReceipt(armReceipt(recovery))).toBe(false);
    await expect(recoveryPending).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-room-clock-invalid',
    });

    now = 1_700;
    expect(remote.acceptArmReceipt(armReceipt(recovery))).toBe(false);
  });

  it('never invokes accessors, rejects hostile shapes, and strips future data fields', async () => {
    let accessorReads = 0;
    const rawOptions: Record<string, unknown> = {
      participantId: PARTICIPANT_ID,
      rttP95Ms: 40,
      armP95Ms: 80,
      nowRoomTimeMs: () => 1_600,
      dispatchArm: () => undefined,
      dispatchFinalize: () => undefined,
      dispatchCancel: () => undefined,
    };
    Object.defineProperty(rawOptions, 'participantId', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return PARTICIPANT_ID;
      },
    });
    expect(() => new RemoteRendezvousParticipant(rawOptions as never)).toThrow(/exact own data/);
    expect(accessorReads).toBe(0);
    const cleanOptions: RemoteRendezvousParticipantOptions = {
      participantId: PARTICIPANT_ID,
      rttP95Ms: 40,
      armP95Ms: 80,
      nowRoomTimeMs: () => 1_600,
      dispatchArm: () => undefined,
      dispatchFinalize: () => undefined,
      dispatchCancel: () => undefined,
    };
    expect(
      () => new RemoteRendezvousParticipant({ ...cleanOptions, extra: true } as never),
    ).toThrow(/exact own data/);
    expect(
      () =>
        new RemoteRendezvousParticipant({
          ...cleanOptions,
          [Symbol('extra')]: true,
        } as never),
    ).toThrow(/exact own data/);
    expect(
      () =>
        new RemoteRendezvousParticipant(
          Object.assign(Object.create({ inherited: true }), cleanOptions),
        ),
    ).toThrow(/exact own data/);

    const dispatchArm = vi.fn();
    const dispatchFinalize = vi.fn();
    const dispatchCancel = vi.fn();
    const remote = participant({ dispatchArm, dispatchFinalize, dispatchCancel });
    const arm = armIntent();
    const accessorArm = { ...arm };
    Object.defineProperty(accessorArm, 'revision', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 7;
      },
    });
    await expect(remote.arm(accessorArm)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-arm-intent',
    });
    expect(accessorReads).toBe(0);

    const inheritedArm = Object.create(arm) as RendezvousArmIntent;
    await expect(remote.arm(inheritedArm)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-arm-intent',
    });
    const customPrototypeArm = Object.assign(Object.create({ polluted: true }), arm);
    await expect(remote.arm(customPrototypeArm)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-arm-intent',
    });
    const symbolArm = { ...arm, [Symbol('extra')]: true };
    await expect(remote.arm(symbolArm)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-arm-intent',
    });
    expect(dispatchArm).not.toHaveBeenCalled();

    const futurePending = remote.arm({ ...arm, extra: true } as never);
    expect(dispatchArm).toHaveBeenCalledTimes(1);
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(true);
    await expect(futurePending).resolves.toMatchObject({ status: 'armed' });
    expect('extra' in (dispatchArm.mock.calls[0]?.[0] as object)).toBe(false);

    const accessorFinalize = { ...finalizeIntent() };
    Object.defineProperty(accessorFinalize, 'finalizedAtRoomTimeMs', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 1_800;
      },
    });
    await expect(remote.finalize(accessorFinalize)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-finalize-intent',
    });
    expect(accessorReads).toBe(0);
    expect(dispatchFinalize).not.toHaveBeenCalled();

    const accessorCancel = { ...cancelIntent() };
    Object.defineProperty(accessorCancel, 'reasonCode', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'cancelled';
      },
    });
    await remote.cancel(accessorCancel);
    expect(accessorReads).toBe(0);
    expect(dispatchCancel).not.toHaveBeenCalled();
  });

  it('is immune to Object.prototype pollution and publishes null-prototype canonicals', async () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
    let pollutionReads = 0;
    Object.defineProperty(Object.prototype, 'value', {
      configurable: true,
      get() {
        pollutionReads += 1;
        return 'polluted';
      },
    });
    let outbound: RendezvousArmIntent | null = null;
    let result: RendezvousArmReceipt | null = null;
    let accepted = false;
    try {
      const remote = participant({
        dispatchArm: (intent) => {
          outbound = intent;
        },
      });
      const arm = armIntent();
      const pending = remote.arm(arm);
      accepted = remote.acceptArmReceipt(armReceipt(arm));
      result = await pending;
    } finally {
      if (original) Object.defineProperty(Object.prototype, 'value', original);
      else Reflect.deleteProperty(Object.prototype, 'value');
    }

    expect(pollutionReads).toBe(0);
    expect(accepted).toBe(true);
    expect(outbound).not.toBeNull();
    expect(result).not.toBeNull();
    expect(Object.getPrototypeOf(outbound!)).toBeNull();
    expect(Object.getPrototypeOf(result!)).toBeNull();
  });

  it('bounds same-run rendezvous history at 256 and rejects replay without dispatch', async () => {
    const dispatchArm = vi.fn();
    const remote = participant({ dispatchArm });
    let activeIntent = armIntent({ rendezvousId: 'rv-0' });
    let activePending = remote.arm(activeIntent);
    for (let index = 1; index < 256; index += 1) {
      activeIntent = armIntent({ rendezvousId: `rv-${index}` });
      activePending = remote.arm(activeIntent);
    }
    expect(dispatchArm).toHaveBeenCalledTimes(256);

    await expect(remote.arm(armIntent({ rendezvousId: 'rv-256' }))).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-operation-superseded',
    });
    await expect(remote.arm(armIntent({ rendezvousId: 'rv-0' }))).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-operation-superseded',
    });
    expect(dispatchArm).toHaveBeenCalledTimes(256);

    expect(remote.acceptArmReceipt(armReceipt(activeIntent))).toBe(true);
    await expect(activePending).resolves.toMatchObject({
      status: 'armed',
      rendezvousId: 'rv-255',
    });
  });
});

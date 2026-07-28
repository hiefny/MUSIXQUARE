import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import type { FilePlaybackCancelIntent } from '../file-playback-source.ts';
import type { RendererHealthWireMessage } from '../file-playback-wire.ts';
import {
  RemoteRendezvousParticipant,
  type RemoteRendererEvidenceScope,
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
const RENDERER_EVIDENCE_SCOPE: RemoteRendererEvidenceScope = Object.freeze({
  sessionId: 'session-a',
  connectionId: 'connection-a',
  recipientParticipantId: 'host-peer',
  sourceIdentity: 'sha256:source-a',
  transferSessionId: null,
});

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
    rendezvousId: 'rv-a',
    reasonCode: 'host-cancelled',
    ...overrides,
  });
}

function rendererHealth(
  overrides: Partial<RendererHealthWireMessage> = {},
): RendererHealthWireMessage {
  return {
    protocolVersion: 2,
    kind: 'renderer-health',
    sessionId: 'session-a',
    connectionId: 'connection-a',
    senderParticipantId: PARTICIPANT_ID,
    recipientParticipantId: 'host-peer',
    controlSequence: 9,
    queueItemId: QID,
    runId: 'run-a',
    revision: 7,
    sourceIdentity: 'sha256:source-a',
    transferSessionId: null,
    rendezvousId: 'rv-a',
    value: 'healthy',
    observedAtRoomTimeMs: 2_000,
    leaseUntilRoomTimeMs: 5_000,
    renderedFrame: 96_000,
    underrunCount: 0,
    reasonCode: null,
    ...overrides,
  };
}

function participant(
  overrides: Partial<RemoteRendezvousParticipantOptions> = {},
): RemoteRendezvousParticipant {
  return new RemoteRendezvousParticipant({
    participantId: PARTICIPANT_ID,
    rendererEvidenceScope: RENDERER_EVIDENCE_SCOPE,
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

  it('classifies live, stale, conflicting, and unknown arm receipt authority separately', async () => {
    const remote = participant();
    const arm = armIntent();
    const pending = remote.arm(arm);

    expect(remote.admitArmReceipt(null)).toEqual({
      disposition: 'invalid',
      reason: 'malformed',
    });
    expect(
      remote.admitArmReceipt({ ...armReceipt(arm), participantId: 'wrong-participant' }),
    ).toEqual({
      disposition: 'invalid',
      reason: 'wrong-participant',
    });
    expect(
      remote.admitArmReceipt(armReceipt({ ...arm, rendezvousId: 'unissued-rendezvous' })),
    ).toEqual({
      disposition: 'invalid',
      reason: 'conflicting-authority',
    });
    expect(
      remote.admitArmReceipt(
        armReceipt(
          armIntent({
            queueItemId: OTHER_QID,
            runId: 'unknown-run',
            revision: 99,
            rendezvousId: 'unknown-rendezvous',
          }),
        ),
      ),
    ).toEqual({
      disposition: 'invalid',
      reason: 'unknown-authority',
    });

    expect(remote.admitArmReceipt(armReceipt(arm))).toEqual({ disposition: 'accepted' });
    await expect(pending).resolves.toMatchObject({ status: 'armed' });
    expect(remote.admitArmReceipt(armReceipt(arm))).toEqual({
      disposition: 'handled',
      reason: 'stale',
    });
  });

  it('classifies exact expired arm and finalize receipts as handled timing outcomes', async () => {
    let now = 1_600;
    const lateArmRemote = participant({ nowRoomTimeMs: () => now });
    const arm = armIntent();
    const pendingArm = lateArmRemote.arm(arm);
    now = arm.finalizeByRoomTimeMs + 1;
    expect(lateArmRemote.admitArmReceipt(armReceipt(arm))).toEqual({
      disposition: 'handled',
      reason: 'late',
    });
    await expect(pendingArm).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-arm-receipt-late',
    });

    now = 1_600;
    const lateFinalizeRemote = participant({ nowRoomTimeMs: () => now });
    const finalizeArm = armIntent();
    lateFinalizeRemote.arm(finalizeArm);
    expect(lateFinalizeRemote.admitArmReceipt(armReceipt(finalizeArm))).toEqual({
      disposition: 'accepted',
    });
    const finalize = finalizeIntent();
    const pendingFinalize = lateFinalizeRemote.finalize(finalize);
    expect(lateFinalizeRemote.admitFinalizeReceipt(null)).toEqual({
      disposition: 'invalid',
      reason: 'malformed',
    });
    expect(
      lateFinalizeRemote.admitFinalizeReceipt({
        ...finalizeReceipt(finalize),
        participantId: 'wrong-participant',
      }),
    ).toEqual({
      disposition: 'invalid',
      reason: 'wrong-participant',
    });
    expect(
      lateFinalizeRemote.admitFinalizeReceipt(
        finalizeReceipt({ ...finalize, rendezvousId: 'unissued-rendezvous' }),
      ),
    ).toEqual({
      disposition: 'invalid',
      reason: 'conflicting-authority',
    });
    expect(
      lateFinalizeRemote.admitFinalizeReceipt(
        finalizeReceipt({
          ...finalize,
          queueItemId: OTHER_QID,
          runId: 'unknown-run',
          revision: 99,
          rendezvousId: 'unknown-rendezvous',
        }),
      ),
    ).toEqual({
      disposition: 'invalid',
      reason: 'unknown-authority',
    });
    now = finalize.startAtRoomTimeMs + 1;
    expect(lateFinalizeRemote.admitFinalizeReceipt(finalizeReceipt(finalize))).toEqual({
      disposition: 'handled',
      reason: 'late',
    });
    await expect(pendingFinalize).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'remote-finalize-receipt-late',
    });
    expect(lateFinalizeRemote.admitFinalizeReceipt(finalizeReceipt(finalize))).toEqual({
      disposition: 'handled',
      reason: 'stale',
    });
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
    await expect(
      remote.cancel(cancelIntent({ rendezvousId: 'rv-stale' })),
    ).resolves.toBeUndefined();
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

  it('keeps an accepted finalization cancellable before explicit commit', async () => {
    const dispatchCancel = vi.fn();
    const remote = participant({ dispatchCancel });
    const arm = armIntent();
    const finalize = finalizeIntent();
    const pendingArm = remote.arm(arm);
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(true);
    await pendingArm;
    const pendingFinalize = remote.finalize(finalize);
    expect(remote.acceptFinalizeReceipt(finalizeReceipt(finalize))).toBe(true);
    await expect(pendingFinalize).resolves.toMatchObject({ status: 'accepted' });

    await expect(remote.cancel(cancelIntent())).resolves.toBeUndefined();

    expect(dispatchCancel).toHaveBeenCalledOnce();
  });

  it('commits only the exact accepted correlation and then suppresses dispatch', async () => {
    let now = 1_600;
    const dispatchCancel = vi.fn();
    const remote = participant({ dispatchCancel, nowRoomTimeMs: () => now });
    const arm = armIntent();
    const finalize = finalizeIntent();
    const identity = Object.freeze({
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
    });
    const pendingArm = remote.arm(arm);
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(true);
    await pendingArm;
    expect(remote.commitAttempt(identity)).toBe(false);
    const pendingFinalize = remote.finalize(finalize);
    expect(remote.acceptFinalizeReceipt(finalizeReceipt(finalize))).toBe(true);
    await expect(pendingFinalize).resolves.toMatchObject({ status: 'accepted' });
    expect(remote.commitAttempt({ ...identity, rendezvousId: 'rv-wrong' })).toBe(false);
    expect(remote.commitAttempt(identity)).toBe(false);
    expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(false);
    now = 2_100;
    expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(true);
    expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(false);
    expect(remote.commitAttempt(identity)).toBe(true);
    expect(remote.commitAttempt(identity)).toBe(true);

    await remote.cancel(cancelIntent());

    expect(dispatchCancel).not.toHaveBeenCalled();
  });

  it('admits only exact current healthy start evidence with a live host-time lease', async () => {
    let now = 1_600;
    const remote = participant({ nowRoomTimeMs: () => now });
    const arm = armIntent();
    const finalize = finalizeIntent();
    const pendingArm = remote.arm(arm);
    expect(remote.acceptArmReceipt(armReceipt(arm))).toBe(true);
    await pendingArm;
    const pendingFinalize = remote.finalize(finalize);
    expect(remote.acceptFinalizeReceipt(finalizeReceipt(finalize))).toBe(true);
    await pendingFinalize;

    expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(false);
    now = 2_100;
    expect(
      remote.acceptRendererStartEvidence(rendererHealth({ senderParticipantId: 'other-peer' })),
    ).toBe(false);
    expect(remote.acceptRendererStartEvidence(rendererHealth({ queueItemId: OTHER_QID }))).toBe(
      false,
    );
    expect(remote.acceptRendererStartEvidence(rendererHealth({ runId: 'run-other' }))).toBe(false);
    expect(remote.acceptRendererStartEvidence(rendererHealth({ revision: 8 }))).toBe(false);
    expect(remote.acceptRendererStartEvidence(rendererHealth({ rendezvousId: 'rv-stale' }))).toBe(
      false,
    );
    expect(remote.acceptRendererStartEvidence(rendererHealth({ sessionId: 'session-other' }))).toBe(
      false,
    );
    expect(
      remote.acceptRendererStartEvidence(rendererHealth({ connectionId: 'connection-other' })),
    ).toBe(false);
    expect(
      remote.acceptRendererStartEvidence(rendererHealth({ recipientParticipantId: 'host-other' })),
    ).toBe(false);
    expect(
      remote.acceptRendererStartEvidence(rendererHealth({ sourceIdentity: 'sha256:source-other' })),
    ).toBe(false);
    expect(
      remote.acceptRendererStartEvidence(rendererHealth({ transferSessionId: 'transfer-other' })),
    ).toBe(false);
    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({
          value: 'unhealthy',
          observedAtRoomTimeMs: 2_100,
          leaseUntilRoomTimeMs: 2_100,
          reasonCode: 'renderer-interrupted',
        }),
      ),
    ).toBe(false);
    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({
          controlSequence: 10,
          observedAtRoomTimeMs: 1_749,
          leaseUntilRoomTimeMs: 4_000,
        }),
      ),
    ).toBe(false);
    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({
          controlSequence: 10,
          observedAtRoomTimeMs: 2_351,
          leaseUntilRoomTimeMs: 4_000,
        }),
      ),
    ).toBe(false);
    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({ controlSequence: 10, leaseUntilRoomTimeMs: 2_100 }),
      ),
    ).toBe(false);
    expect(remote.acceptRendererStartEvidence({ ...rendererHealth(), extra: true })).toBe(false);

    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({
          controlSequence: 11,
          observedAtRoomTimeMs: 1_750,
          leaseUntilRoomTimeMs: 4_000,
        }),
      ),
    ).toBe(true);

    let accessorReads = 0;
    const accessorEvidence = { ...rendererHealth() };
    Object.defineProperty(accessorEvidence, 'value', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'healthy';
      },
    });
    expect(remote.acceptRendererStartEvidence(accessorEvidence)).toBe(false);
    expect(accessorReads).toBe(0);

    const proxiedWrongAttempt = new Proxy(rendererHealth({ rendezvousId: 'rv-stale' }), {
      get(target, property, receiver) {
        accessorReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(remote.acceptRendererStartEvidence(proxiedWrongAttempt)).toBe(false);
    expect(accessorReads).toBe(0);

    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({ controlSequence: 12, observedAtRoomTimeMs: 2_350 }),
      ),
    ).toBe(true);
    expect(remote.acceptRendererStartEvidence(rendererHealth({ controlSequence: 11 }))).toBe(false);
  });

  it('lets exact newer unhealthy evidence revoke a pre-commit start lease', async () => {
    let now = 1_600;
    const remote = participant({ nowRoomTimeMs: () => now });
    const arm = armIntent();
    remote.arm(arm);
    remote.acceptArmReceipt(armReceipt(arm));
    const finalize = finalizeIntent();
    remote.finalize(finalize);
    remote.acceptFinalizeReceipt(finalizeReceipt(finalize));
    const identity = {
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
    } as const;

    now = 2_100;
    expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(true);
    now = 2_200;
    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({
          controlSequence: 10,
          value: 'unhealthy',
          observedAtRoomTimeMs: 2_200,
          leaseUntilRoomTimeMs: 2_200,
          reasonCode: 'renderer-interrupted',
        }),
      ),
    ).toBe(false);
    expect(remote.commitAttempt(identity)).toBe(false);
    expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(false);

    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({
          controlSequence: 11,
          observedAtRoomTimeMs: 2_200,
          leaseUntilRoomTimeMs: 5_000,
        }),
      ),
    ).toBe(true);
    expect(remote.commitAttempt(identity)).toBe(true);
    now = 6_000;
    expect(remote.commitAttempt(identity)).toBe(true);
  });

  it('burns reentrant unhealthy evidence before a first-commit clock read can reuse old health', () => {
    let now = 1_600;
    let injectUnhealthy = false;
    let nestedUnhealthyResult: boolean | null = null;
    let remote!: RemoteRendezvousParticipant;
    const unhealthy = rendererHealth({
      controlSequence: 10,
      value: 'unhealthy',
      observedAtRoomTimeMs: 2_200,
      leaseUntilRoomTimeMs: 2_200,
      reasonCode: 'renderer-interrupted',
    });
    remote = participant({
      nowRoomTimeMs: () => {
        if (injectUnhealthy) {
          injectUnhealthy = false;
          nestedUnhealthyResult = remote.acceptRendererStartEvidence(unhealthy);
        }
        return now;
      },
    });
    const arm = armIntent();
    remote.arm(arm);
    remote.acceptArmReceipt(armReceipt(arm));
    const finalize = finalizeIntent();
    remote.finalize(finalize);
    remote.acceptFinalizeReceipt(finalizeReceipt(finalize));
    const identity = {
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
    } as const;

    now = 2_100;
    expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(true);
    now = 2_200;
    injectUnhealthy = true;
    expect(remote.commitAttempt(identity)).toBe(false);
    expect(nestedUnhealthyResult).toBe(false);
    expect(remote.commitAttempt(identity)).toBe(false);
    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({
          controlSequence: 10,
          observedAtRoomTimeMs: 2_200,
          leaseUntilRoomTimeMs: 5_000,
        }),
      ),
    ).toBe(false);

    now = 2_300;
    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({
          controlSequence: 11,
          observedAtRoomTimeMs: 2_300,
          leaseUntilRoomTimeMs: 5_000,
        }),
      ),
    ).toBe(true);
    expect(remote.commitAttempt(identity)).toBe(true);
  });

  it('revalidates the stored lease and room clock on the first commit', async () => {
    let now = 1_600;
    let clockThrows = false;
    const remote = participant({
      nowRoomTimeMs: () => {
        if (clockThrows) throw new Error('clock unavailable');
        return now;
      },
    });
    const arm = armIntent();
    remote.arm(arm);
    remote.acceptArmReceipt(armReceipt(arm));
    const finalize = finalizeIntent();
    remote.finalize(finalize);
    remote.acceptFinalizeReceipt(finalizeReceipt(finalize));
    const identity = {
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
    } as const;

    now = 2_100;
    expect(
      remote.acceptRendererStartEvidence(rendererHealth({ leaseUntilRoomTimeMs: 2_200 })),
    ).toBe(true);
    now = 2_200;
    expect(remote.commitAttempt(identity)).toBe(false);

    now = 2_300;
    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({
          controlSequence: 10,
          observedAtRoomTimeMs: 2_300,
          leaseUntilRoomTimeMs: 5_000,
        }),
      ),
    ).toBe(true);
    clockThrows = true;
    expect(remote.commitAttempt(identity)).toBe(false);
    clockThrows = false;
    now = 2_200;
    expect(remote.commitAttempt(identity)).toBe(false);
    now = 2_400;
    expect(remote.commitAttempt(identity)).toBe(true);
  });

  it('fails a first commit when the room-clock callback cancels or supersedes it', async () => {
    for (const action of ['cancel', 'supersede'] as const) {
      let now = 1_600;
      let actDuringRead = false;
      let remote!: RemoteRendezvousParticipant;
      const replacement = armIntent({
        runId: 'run-b',
        revision: 8,
        rendezvousId: 'rv-b',
        startAtRoomTimeMs: 3_000,
        finalizeByRoomTimeMs: 2_900,
      });
      remote = participant({
        nowRoomTimeMs: () => {
          if (actDuringRead) {
            actDuringRead = false;
            if (action === 'cancel') void remote.cancel(cancelIntent());
            else void remote.arm(replacement);
          }
          return now;
        },
      });
      const arm = armIntent();
      remote.arm(arm);
      remote.acceptArmReceipt(armReceipt(arm));
      const finalize = finalizeIntent();
      remote.finalize(finalize);
      remote.acceptFinalizeReceipt(finalizeReceipt(finalize));
      now = 2_100;
      expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(true);

      actDuringRead = true;
      now = 2_200;
      expect(
        remote.commitAttempt({
          queueItemId: QID,
          runId: 'run-a',
          revision: 7,
          rendezvousId: 'rv-a',
        }),
      ).toBe(false);
    }
  });

  it('revokes start evidence authority on cancel and same-state recovery', async () => {
    let now = 1_600;
    const remote = participant({ nowRoomTimeMs: () => now });
    const first = armIntent();
    remote.arm(first);
    remote.acceptArmReceipt(armReceipt(first));
    const firstFinalize = finalizeIntent();
    const firstFinalizePending = remote.finalize(firstFinalize);
    remote.acceptFinalizeReceipt(finalizeReceipt(firstFinalize));
    await firstFinalizePending;

    now = 2_100;
    expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(true);
    await remote.cancel(cancelIntent());
    expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(false);

    const recovery = armIntent({
      rendezvousId: 'rv-recovery',
      startAtRoomTimeMs: 3_000,
      finalizeByRoomTimeMs: 2_900,
    });
    const recoveryArmPending = remote.arm(recovery);
    expect(remote.acceptArmReceipt(armReceipt(recovery, { observedAtRoomTimeMs: 2_200 }))).toBe(
      true,
    );
    await recoveryArmPending;
    const recoveryFinalize = finalizeIntent({
      rendezvousId: 'rv-recovery',
      startAtRoomTimeMs: 3_000,
      finalizedAtRoomTimeMs: 2_800,
    });
    const recoveryFinalizePending = remote.finalize(recoveryFinalize);
    expect(
      remote.acceptFinalizeReceipt(
        finalizeReceipt(recoveryFinalize, { observedAtRoomTimeMs: 2_800 }),
      ),
    ).toBe(true);
    await recoveryFinalizePending;

    now = 3_100;
    expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(false);
    const recoveryEvidence = rendererHealth({
      controlSequence: 10,
      rendezvousId: 'rv-recovery',
      observedAtRoomTimeMs: 3_000,
      leaseUntilRoomTimeMs: 5_000,
    });
    expect(remote.acceptRendererStartEvidence(recoveryEvidence)).toBe(true);
    await remote.cancel(cancelIntent({ rendezvousId: 'rv-recovery' }));
    expect(
      remote.commitAttempt({
        queueItemId: QID,
        runId: 'run-a',
        revision: 7,
        rendezvousId: 'rv-recovery',
      }),
    ).toBe(false);
    expect(remote.acceptRendererStartEvidence(recoveryEvidence)).toBe(false);
  });

  it('rechecks evidence authority after the host clock cancels or supersedes it', async () => {
    let phase: 'receipts' | 'cancel' | 'supersede' | 'steady' = 'receipts';
    let remote!: RemoteRendezvousParticipant;
    const replacement = armIntent({
      runId: 'run-b',
      revision: 8,
      rendezvousId: 'rv-b',
      startAtRoomTimeMs: 3_000,
      finalizeByRoomTimeMs: 2_900,
    });
    remote = participant({
      nowRoomTimeMs: () => {
        const currentPhase = phase;
        if (currentPhase === 'cancel') {
          phase = 'steady';
          void remote.cancel(cancelIntent());
        } else if (currentPhase === 'supersede') {
          phase = 'steady';
          void remote.arm(replacement);
        }
        if (currentPhase === 'receipts') return 1_600;
        return currentPhase === 'supersede' ? 3_100 : 2_100;
      },
    });

    const arm = armIntent();
    remote.arm(arm);
    remote.acceptArmReceipt(armReceipt(arm));
    const finalize = finalizeIntent();
    remote.finalize(finalize);
    remote.acceptFinalizeReceipt(finalizeReceipt(finalize));
    phase = 'cancel';
    expect(remote.acceptRendererStartEvidence(rendererHealth())).toBe(false);

    const retry = armIntent({
      rendezvousId: 'rv-retry',
      startAtRoomTimeMs: 2_800,
      finalizeByRoomTimeMs: 2_700,
    });
    remote.arm(retry);
    remote.acceptArmReceipt(armReceipt(retry));
    const retryFinalize = finalizeIntent({ rendezvousId: 'rv-retry', startAtRoomTimeMs: 2_800 });
    remote.finalize(retryFinalize);
    remote.acceptFinalizeReceipt(finalizeReceipt(retryFinalize));
    phase = 'supersede';
    expect(
      remote.acceptRendererStartEvidence(
        rendererHealth({
          rendezvousId: 'rv-retry',
          observedAtRoomTimeMs: 2_800,
          leaseUntilRoomTimeMs: 5_000,
        }),
      ),
    ).toBe(false);
  });

  it('fails reentrant evidence and first-commit room-clock reads closed', async () => {
    let now = 1_600;
    let reenter: 'evidence' | 'commit' | null = null;
    let nestedEvidenceResult: boolean | null = null;
    let nestedCommitResult: boolean | null = null;
    let remote!: RemoteRendezvousParticipant;
    const evidence = rendererHealth();
    const identity = {
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
    } as const;
    remote = participant({
      nowRoomTimeMs: () => {
        const operation = reenter;
        reenter = null;
        if (operation === 'evidence') {
          nestedEvidenceResult = remote.acceptRendererStartEvidence(evidence);
        } else if (operation === 'commit') {
          nestedCommitResult = remote.commitAttempt(identity);
        }
        return now;
      },
    });
    const arm = armIntent();
    remote.arm(arm);
    remote.acceptArmReceipt(armReceipt(arm));
    const finalize = finalizeIntent();
    remote.finalize(finalize);
    remote.acceptFinalizeReceipt(finalizeReceipt(finalize));

    now = 2_100;
    reenter = 'evidence';
    expect(remote.acceptRendererStartEvidence(evidence)).toBe(false);
    expect(nestedEvidenceResult).toBe(false);
    expect(remote.acceptRendererStartEvidence(evidence)).toBe(true);

    now = 2_200;
    reenter = 'commit';
    expect(remote.commitAttempt(identity)).toBe(false);
    expect(nestedCommitResult).toBe(false);
    expect(remote.commitAttempt(identity)).toBe(true);
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
      rendererEvidenceScope: RENDERER_EVIDENCE_SCOPE,
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
      rendererEvidenceScope: RENDERER_EVIDENCE_SCOPE,
      rttP95Ms: 40,
      armP95Ms: 80,
      nowRoomTimeMs: () => 1_600,
      dispatchArm: () => undefined,
      dispatchFinalize: () => undefined,
      dispatchCancel: () => undefined,
    };
    const hostileScope = { ...RENDERER_EVIDENCE_SCOPE };
    Object.defineProperty(hostileScope, 'sessionId', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'session-a';
      },
    });
    expect(
      () =>
        new RemoteRendezvousParticipant({
          ...cleanOptions,
          rendererEvidenceScope: hostileScope,
        }),
    ).toThrow(/rendererEvidenceScope/);
    expect(accessorReads).toBe(0);
    expect(
      () =>
        new RemoteRendezvousParticipant({
          ...cleanOptions,
          rendererEvidenceScope: { ...RENDERER_EVIDENCE_SCOPE, extra: true } as never,
        }),
    ).toThrow(/rendererEvidenceScope/);
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

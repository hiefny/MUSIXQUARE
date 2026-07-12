import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import type {
  FilePlaybackBackend,
  FilePlaybackCancelIntent,
  FilePlaybackSource,
} from '../file-playback-source.ts';
import { LocalRendezvousParticipant } from '../local-rendezvous-participant.ts';
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
const PARTICIPANT_ID = 'local-peer';

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
    observedAtRoomTimeMs: 1_500,
    bufferedAheadSeconds: 4,
    reasonCode: null,
  };
}

function finalizedReceipt(intent: RendezvousFinalizeIntent): RendezvousFinalizeReceipt {
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
  };
}

interface FakeSource extends FilePlaybackSource {
  readonly arm: ReturnType<typeof vi.fn<FilePlaybackSource['arm']>>;
  readonly finalize: ReturnType<typeof vi.fn<FilePlaybackSource['finalize']>>;
  readonly cancel: ReturnType<typeof vi.fn<FilePlaybackSource['cancel']>>;
}

function source(queueItemId = QID, backend: FilePlaybackBackend = 'audio-buffer'): FakeSource {
  return {
    queueItemId,
    backend,
    prepare: vi.fn(),
    connect: vi.fn(),
    arm: vi.fn(async (intent: RendezvousArmIntent) => armedReceipt(intent)),
    finalize: vi.fn(async (intent: RendezvousFinalizeIntent) => finalizedReceipt(intent)),
    cancel: vi.fn(async () => ({}) as never),
    pause: vi.fn(),
    seek: vi.fn(),
    positionAt: vi.fn(),
    getSnapshot: vi.fn(),
    destroy: vi.fn(),
  } as unknown as FakeSource;
}

function participant(getActiveSource: () => FilePlaybackSource | null) {
  return new LocalRendezvousParticipant({
    participantId: PARTICIPANT_ID,
    getActiveSource,
    rttP95Ms: 40,
    armP95Ms: 80,
    nowRoomTimeMs: () => 1_600,
  });
}

describe('LocalRendezvousParticipant', () => {
  it('snapshots exact constructor options without invoking accessors or dynamic gets', () => {
    let getterCalls = 0;
    const accessor = {
      get participantId() {
        getterCalls += 1;
        return PARTICIPANT_ID;
      },
      getActiveSource: () => null,
      rttP95Ms: 0,
      armP95Ms: 0,
      nowRoomTimeMs: () => 0,
    };
    expect(() => new LocalRendezvousParticipant(accessor)).toThrow(/options are invalid/);
    expect(getterCalls).toBe(0);

    const options = {
      participantId: PARTICIPANT_ID,
      getActiveSource: () => null,
      rttP95Ms: 10,
      armP95Ms: 20,
      nowRoomTimeMs: () => 0,
    };
    const proxied = new Proxy(options, {
      get() {
        getterCalls += 1;
        throw new Error('dynamic [[Get]] must not run');
      },
    });
    const adapter = new LocalRendezvousParticipant(proxied);
    expect(adapter.participantId).toBe(PARTICIPANT_ID);
    expect(adapter.rttP95Ms).toBe(10);
    expect(adapter.armP95Ms).toBe(20);
    expect(getterCalls).toBe(0);
  });

  it('passes only a detached canonical intent to the active source under a hostile Proxy', async () => {
    const active = source();
    const adapter = participant(() => active);
    let getCalls = 0;
    const proxied = new Proxy(armIntent(), {
      get() {
        getCalls += 1;
        throw new Error('dynamic [[Get]] must not run');
      },
    });

    await expect(adapter.arm(proxied)).resolves.toMatchObject({ status: 'armed' });
    expect(getCalls).toBe(0);
    const delegated = active.arm.mock.calls[0]?.[0];
    expect(delegated).toEqual(armIntent());
    expect(delegated === proxied).toBe(false);
    expect(Object.getPrototypeOf(delegated)).toBeNull();
    expect(Object.isFrozen(delegated)).toBe(true);

    const accessor = { ...armIntent(), rendezvousId: 'rv-accessor' };
    Object.defineProperty(accessor, 'revision', {
      enumerable: true,
      get() {
        getCalls += 1;
        return 8;
      },
    });
    await expect(adapter.arm(accessor)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-arm-intent',
    });
    expect(getCalls).toBe(0);
    expect(active.arm).toHaveBeenCalledTimes(1);
  });

  it('rechecks operation authority after a source receipt Proxy re-enters cancellation', async () => {
    const active = source();
    const adapter = participant(() => active);
    const cancelIntent: FilePlaybackCancelIntent = Object.freeze({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
      reasonCode: 'proxy-reentered-cancel',
    });

    active.arm.mockImplementationOnce(
      async (intent) =>
        new Proxy(armedReceipt(intent), {
          ownKeys(target) {
            void adapter.cancel(cancelIntent);
            return Reflect.ownKeys(target);
          },
        }),
    );
    await expect(adapter.arm(armIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-cancelled',
    });
    expect(active.cancel).toHaveBeenCalledOnce();

    const finalizeSource = source();
    const finalizeAdapter = participant(() => finalizeSource);
    await finalizeAdapter.arm(armIntent());
    finalizeSource.finalize.mockImplementationOnce(
      async (intent) =>
        new Proxy(finalizedReceipt(intent), {
          ownKeys(target) {
            void finalizeAdapter.cancel(cancelIntent);
            return Reflect.ownKeys(target);
          },
        }),
    );
    await expect(finalizeAdapter.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-cancelled',
    });
    expect(finalizeSource.cancel).toHaveBeenCalledOnce();
  });

  it('cannot resurrect cancelled work when the active-source provider re-enters final checks', async () => {
    const armSource = source();
    let armProviderCalls = 0;
    let armAdapter!: LocalRendezvousParticipant;
    armAdapter = participant(() => {
      armProviderCalls += 1;
      if (armProviderCalls === 3) {
        void armAdapter.cancel({
          kind: 'file-playback-cancel',
          queueItemId: QID,
          runId: 'run-a',
          revision: 7,
          rendezvousId: 'rv-a',
          reasonCode: 'provider-reentered-cancel',
        });
      }
      return armSource;
    });
    await expect(armAdapter.arm(armIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-cancelled',
    });
    await expect(armAdapter.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'local-rendezvous-not-armed',
    });

    const finalizeSource = source();
    let mode: 'setup' | 'finalize' = 'setup';
    let finalizeProviderCalls = 0;
    let finalizeAdapter!: LocalRendezvousParticipant;
    finalizeAdapter = participant(() => {
      if (mode === 'finalize') {
        finalizeProviderCalls += 1;
        if (finalizeProviderCalls === 3) {
          void finalizeAdapter.cancel({
            kind: 'file-playback-cancel',
            queueItemId: QID,
            runId: 'run-a',
            revision: 7,
            rendezvousId: 'rv-a',
            reasonCode: 'provider-reentered-cancel',
          });
        }
      }
      return finalizeSource;
    });
    await finalizeAdapter.arm(armIntent());
    mode = 'finalize';
    await expect(finalizeAdapter.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-cancelled',
    });
    expect(finalizeSource.cancel).toHaveBeenCalledOnce();
  });

  it.each<FilePlaybackBackend>(['audio-buffer', 'streaming-flac'])(
    'delegates the same contract without depending on the %s backend',
    async (backend) => {
      const active = source(QID, backend);
      const adapter = participant(() => active);
      const arm = armIntent();
      const finalize = finalizeIntent();

      const armResult = await adapter.arm(arm);
      const finalizeResult = await adapter.finalize(finalize);

      expect(active.arm).toHaveBeenCalledOnce();
      expect(active.arm).toHaveBeenCalledWith(arm);
      expect(active.finalize).toHaveBeenCalledOnce();
      expect(active.finalize).toHaveBeenCalledWith(finalize);
      expect(armResult.status).toBe('armed');
      expect(finalizeResult.status).toBe('accepted');
      expect(Object.isFrozen(armResult)).toBe(true);
      expect(Object.isFrozen(finalizeResult)).toBe(true);
    },
  );

  it('rejects missing, wrongly addressed, and wrong-queue arm requests without delegation', async () => {
    const active = source();
    const adapter = participant(() => active);

    const wrongRecipient = await adapter.arm(armIntent({ recipientId: 'another-peer' }));
    const wrongQueue = await adapter.arm(armIntent({ queueItemId: OTHER_QID }));
    const missing = await participant(() => null).arm(armIntent());

    expect(active.arm).not.toHaveBeenCalled();
    expect(wrongRecipient.reasonCode).toBe('local-participant-mismatch');
    expect(wrongRecipient.participantId).toBe(PARTICIPANT_ID);
    expect(wrongQueue.reasonCode).toBe('local-source-mismatch');
    expect(missing.reasonCode).toBe('local-source-unavailable');
    for (const receipt of [wrongRecipient, wrongQueue, missing]) {
      expect(receipt.status).toBe('rejected');
      expect(receipt.bufferedAheadSeconds).toBe(0);
      expect(readRendezvousArmReceipt(receipt)).not.toBeNull();
      expect(Object.isFrozen(receipt)).toBe(true);
    }
  });

  it('rejects finalization when the owner swaps to another source with the same queue ID', async () => {
    const armedSource = source();
    const replacement = source();
    let active: FilePlaybackSource | null = armedSource;
    const adapter = participant(() => active);

    await adapter.arm(armIntent());
    active = replacement;
    const receipt = await adapter.finalize(finalizeIntent());

    expect(receipt).toMatchObject({ status: 'rejected', reasonCode: 'local-source-changed' });
    expect(armedSource.finalize).not.toHaveBeenCalled();
    expect(replacement.finalize).not.toHaveBeenCalled();
    expect(readRendezvousFinalizeReceipt(receipt)).not.toBeNull();
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it('fences a pending arm after the active source changes and retires the exact old source', async () => {
    const gate = deferred<RendezvousArmReceipt>();
    const oldSource = source();
    const replacement = source();
    oldSource.arm.mockReturnValueOnce(gate.promise);
    let active: FilePlaybackSource | null = oldSource;
    const adapter = participant(() => active);
    const intent = armIntent();

    const pending = adapter.arm(intent);
    await drainMicrotasks();
    active = replacement;
    gate.resolve(armedReceipt(intent));
    const receipt = await pending;

    expect(receipt).toMatchObject({ status: 'rejected', reasonCode: 'local-source-changed' });
    expect(oldSource.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        queueItemId: QID,
        runId: 'run-a',
        revision: 7,
      }),
    );
    expect(replacement.cancel).not.toHaveBeenCalled();
  });

  it('cancels a matching pending arm before a binding exists and rejects its late receipt', async () => {
    const gate = deferred<RendezvousArmReceipt>();
    const active = source();
    active.arm.mockReturnValueOnce(gate.promise);
    const adapter = participant(() => active);
    const arm = armIntent();
    const pending = adapter.arm(arm);
    await drainMicrotasks();
    const cancel: FilePlaybackCancelIntent = Object.freeze({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
      reasonCode: 'cancel-pending-arm',
    });

    await expect(adapter.cancel({ ...cancel, rendezvousId: 'rv-stale' })).resolves.toBeUndefined();
    expect(active.cancel).not.toHaveBeenCalled();
    await expect(adapter.cancel(cancel)).resolves.toBeUndefined();
    expect(active.cancel).toHaveBeenCalledWith(cancel);
    gate.resolve(armedReceipt(arm));
    const lateReceipt = await pending;
    const finalizeReceipt = await adapter.finalize(finalizeIntent());

    expect(lateReceipt).toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-cancelled',
    });
    expect(finalizeReceipt).toMatchObject({
      status: 'rejected',
      reasonCode: 'local-rendezvous-not-armed',
    });
    expect(active.finalize).not.toHaveBeenCalled();
  });

  it('keeps an accepted finalization cancellable before explicit commit', async () => {
    const active = source();
    const adapter = participant(() => active);
    await expect(adapter.arm(armIntent())).resolves.toMatchObject({ status: 'armed' });
    await expect(adapter.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'accepted',
    });

    await expect(
      adapter.cancel({
        kind: 'file-playback-cancel',
        queueItemId: QID,
        runId: 'run-a',
        revision: 7,
        rendezvousId: 'rv-a',
        reasonCode: 'attempt-closed-after-promotion',
      }),
    ).resolves.toBeUndefined();

    expect(active.cancel).toHaveBeenCalledOnce();
  });

  it('commits only the exact accepted finalization and then suppresses attempt cancel', async () => {
    const active = source();
    const adapter = participant(() => active);
    const identity = Object.freeze({
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
    });
    await expect(adapter.arm(armIntent())).resolves.toMatchObject({ status: 'armed' });
    expect(adapter.commitAttempt(identity)).toBe(false);
    await expect(adapter.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(adapter.commitAttempt({ ...identity, rendezvousId: 'rv-wrong' })).toBe(false);
    expect(adapter.commitAttempt(identity)).toBe(true);
    expect(adapter.commitAttempt(identity)).toBe(true);

    await adapter.cancel({
      kind: 'file-playback-cancel',
      ...identity,
      reasonCode: 'attempt-closed-after-commit',
    });

    expect(active.cancel).not.toHaveBeenCalled();
  });

  it('keeps committed playback untouched while a fresh same-state candidate is armed and cancelled', async () => {
    const committedSource = source();
    const candidateSource = source();
    let active: FilePlaybackSource | null = committedSource;
    const adapter = participant(() => active);
    const committedIdentity = Object.freeze({
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
    });
    await adapter.arm(armIntent());
    await adapter.finalize(finalizeIntent());
    expect(adapter.commitAttempt(committedIdentity)).toBe(true);
    committedSource.cancel.mockClear();
    active = candidateSource;

    const candidateArm = armIntent({ rendezvousId: 'rv-b', positionSeconds: 13 });
    const candidateFinalize = finalizeIntent({ rendezvousId: 'rv-b' });
    await expect(adapter.arm(candidateArm)).resolves.toMatchObject({
      status: 'armed',
      rendezvousId: 'rv-b',
    });
    await expect(adapter.finalize(candidateFinalize)).resolves.toMatchObject({
      status: 'accepted',
      rendezvousId: 'rv-b',
    });

    expect(committedSource.cancel).not.toHaveBeenCalled();
    expect(candidateSource.cancel).not.toHaveBeenCalled();
    expect(adapter.commitAttempt(committedIdentity)).toBe(true);
    await adapter.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-b',
      reasonCode: 'candidate-cancelled',
    });
    expect(candidateSource.cancel).toHaveBeenCalledOnce();
    expect(candidateSource.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ rendezvousId: 'rv-b', reasonCode: 'candidate-cancelled' }),
    );

    await adapter.cancel({
      kind: 'file-playback-cancel',
      ...committedIdentity,
      reasonCode: 'stale-attempt-close',
    });
    expect(committedSource.cancel).not.toHaveBeenCalled();
    expect(candidateSource.cancel).toHaveBeenCalledOnce();
    expect(adapter.commitAttempt(committedIdentity)).toBe(true);
  });

  it('atomically replaces the committed binding only after the recovery candidate commits', async () => {
    const sourceA = source();
    const sourceB = source();
    const sourceC = source();
    let active: FilePlaybackSource | null = sourceA;
    const adapter = participant(() => active);
    const identityA = Object.freeze({
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
    });
    const identityB = Object.freeze({ ...identityA, rendezvousId: 'rv-b' });
    await adapter.arm(armIntent());
    await adapter.finalize(finalizeIntent());
    expect(adapter.commitAttempt(identityA)).toBe(true);

    active = sourceB;
    await adapter.arm(armIntent({ rendezvousId: 'rv-b' }));
    await adapter.finalize(finalizeIntent({ rendezvousId: 'rv-b' }));
    expect(adapter.commitAttempt(identityA)).toBe(true);
    expect(adapter.commitAttempt(identityB)).toBe(true);
    expect(adapter.commitAttempt(identityA)).toBe(false);

    sourceA.cancel.mockClear();
    sourceB.cancel.mockClear();
    await adapter.cancel({
      kind: 'file-playback-cancel',
      ...identityB,
      reasonCode: 'committed-attempt-close',
    });
    expect(sourceA.cancel).not.toHaveBeenCalled();
    expect(sourceB.cancel).not.toHaveBeenCalled();

    active = sourceC;
    await expect(adapter.arm(armIntent({ rendezvousId: 'rv-c' }))).resolves.toMatchObject({
      status: 'armed',
      rendezvousId: 'rv-c',
    });
    expect(sourceA.cancel).not.toHaveBeenCalled();
    expect(sourceB.cancel).not.toHaveBeenCalled();
    expect(sourceC.arm).toHaveBeenCalledOnce();
  });

  it('rejects recent same-state rendezvous ABA but resets the history for a newer state', async () => {
    const active = source();
    const adapter = participant(() => active);
    const identityA = Object.freeze({
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
    });
    await adapter.arm(armIntent());
    await adapter.finalize(finalizeIntent());
    expect(adapter.commitAttempt(identityA)).toBe(true);
    await adapter.arm(armIntent({ rendezvousId: 'rv-b' }));
    await adapter.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-b',
      reasonCode: 'recovery-aborted',
    });

    await expect(adapter.arm(armIntent({ positionSeconds: 14 }))).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-conflict',
      rendezvousId: 'rv-a',
    });
    await expect(
      adapter.arm(armIntent({ rendezvousId: 'rv-b', positionSeconds: 15 })),
    ).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-conflict',
      rendezvousId: 'rv-b',
    });
    expect(active.arm).toHaveBeenCalledTimes(2);

    await expect(
      adapter.arm(armIntent({ runId: 'run-newer', revision: 8, positionSeconds: 0 })),
    ).resolves.toMatchObject({
      status: 'armed',
      runId: 'run-newer',
      revision: 8,
      rendezvousId: 'rv-a',
    });
  });

  it('bounds same-state rendezvous history while rejecting IDs still in the recent window', async () => {
    const active = source();
    const adapter = participant(() => active);
    let current = armIntent({ rendezvousId: 'rv-window-0' });
    await adapter.arm(current);

    for (let index = 1; index <= 256; index += 1) {
      await adapter.cancel({
        kind: 'file-playback-cancel',
        queueItemId: QID,
        runId: 'run-a',
        revision: 7,
        rendezvousId: current.rendezvousId,
        reasonCode: 'advance-history-window',
      });
      current = armIntent({ rendezvousId: `rv-window-${index}`, positionSeconds: index });
      await expect(adapter.arm(current)).resolves.toMatchObject({ status: 'armed' });
    }

    await adapter.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: current.rendezvousId,
      reasonCode: 'test-history-eviction',
    });
    await expect(
      adapter.arm(armIntent({ rendezvousId: 'rv-window-1', positionSeconds: 300 })),
    ).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-conflict',
    });
    await expect(
      adapter.arm(armIntent({ rendezvousId: 'rv-window-0', positionSeconds: 301 })),
    ).resolves.toMatchObject({ status: 'armed', rendezvousId: 'rv-window-0' });
  });

  it('does not let a reentrant source provider roll a newer recovery back', async () => {
    const active = source();
    let reenter = false;
    let nested: Promise<RendezvousArmReceipt> | null = null;
    let adapter!: LocalRendezvousParticipant;
    adapter = participant(() => {
      if (reenter) {
        reenter = false;
        nested = adapter.arm(armIntent({ rendezvousId: 'rv-c' }));
      }
      return active;
    });
    const identityA = Object.freeze({
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
    });
    await adapter.arm(armIntent());
    await adapter.finalize(finalizeIntent());
    expect(adapter.commitAttempt(identityA)).toBe(true);
    active.arm.mockClear();

    reenter = true;
    await expect(adapter.arm(armIntent({ rendezvousId: 'rv-b' }))).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-superseded',
    });
    expect(nested).not.toBeNull();
    await expect(nested!).resolves.toMatchObject({ status: 'armed', rendezvousId: 'rv-c' });
    expect(active.arm).toHaveBeenCalledOnce();
    expect(active.arm).toHaveBeenCalledWith(expect.objectContaining({ rendezvousId: 'rv-c' }));
    expect(adapter.commitAttempt(identityA)).toBe(true);
  });

  it('fences a pending finalize after the active source changes and never leaks acceptance', async () => {
    const oldSource = source();
    const replacement = source();
    let active: FilePlaybackSource | null = oldSource;
    const adapter = participant(() => active);
    await adapter.arm(armIntent());
    const gate = deferred<RendezvousFinalizeReceipt>();
    oldSource.finalize.mockReturnValueOnce(gate.promise);
    const intent = finalizeIntent();

    const pending = adapter.finalize(intent);
    await drainMicrotasks();
    active = replacement;
    gate.resolve(finalizedReceipt(intent));
    const receipt = await pending;

    expect(receipt).toMatchObject({ status: 'rejected', reasonCode: 'local-source-changed' });
    expect(oldSource.cancel).toHaveBeenCalledOnce();
    expect(replacement.cancel).not.toHaveBeenCalled();
  });

  it('prevents A to B to A from restoring an obsolete pending arm', async () => {
    const gateA = deferred<RendezvousArmReceipt>();
    const gateB = deferred<RendezvousArmReceipt>();
    const sourceA = source();
    const sourceB = source();
    sourceA.arm.mockReturnValueOnce(gateA.promise);
    sourceB.arm.mockReturnValueOnce(gateB.promise);
    let active: FilePlaybackSource | null = sourceA;
    const adapter = participant(() => active);
    const intentA = armIntent();
    const intentB = armIntent({ runId: 'run-b', revision: 8, rendezvousId: 'rv-b' });

    const pendingA = adapter.arm(intentA);
    await drainMicrotasks();
    active = sourceB;
    const pendingB = adapter.arm(intentB);
    await drainMicrotasks();
    active = sourceA;
    gateA.resolve(armedReceipt(intentA));
    gateB.resolve(armedReceipt(intentB));
    const [receiptA, receiptB] = await Promise.all([pendingA, pendingB]);

    expect(receiptA).toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-superseded',
    });
    expect(receiptB).toMatchObject({ status: 'rejected', reasonCode: 'local-source-changed' });
    expect(sourceA.cancel).toHaveBeenCalled();
    expect(sourceB.cancel).toHaveBeenCalled();
  });

  it('coalesces exact arm and finalize retries without duplicate backend work or cancellation', async () => {
    const active = source();
    const adapter = participant(() => active);
    const armGate = deferred<RendezvousArmReceipt>();
    const arm = armIntent();
    active.arm.mockReturnValueOnce(armGate.promise);

    const firstArm = adapter.arm(arm);
    const retryArm = adapter.arm(arm);
    expect(retryArm).toBe(firstArm);
    await drainMicrotasks();
    expect(active.arm).toHaveBeenCalledOnce();
    armGate.resolve(armedReceipt(arm));
    await Promise.all([firstArm, retryArm]);

    const finalizeGate = deferred<RendezvousFinalizeReceipt>();
    const finalize = finalizeIntent();
    active.finalize.mockReturnValueOnce(finalizeGate.promise);
    const firstFinalize = adapter.finalize(finalize);
    const retryFinalize = adapter.finalize(finalize);
    expect(retryFinalize).toBe(firstFinalize);
    await drainMicrotasks();
    expect(active.finalize).toHaveBeenCalledOnce();
    finalizeGate.resolve(finalizedReceipt(finalize));
    await Promise.all([firstFinalize, retryFinalize]);

    expect(active.cancel).not.toHaveBeenCalled();
  });

  it('allows a new rendezvous for the same cancelled revision and run', async () => {
    const active = source();
    const adapter = participant(() => active);
    const first = armIntent();
    await adapter.arm(first);
    await adapter.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
      reasonCode: 'retry-with-new-rendezvous',
    });

    const retry = armIntent({ rendezvousId: 'rv-retry' });
    const receipt = await adapter.arm(retry);

    expect(receipt).toMatchObject({
      status: 'armed',
      rendezvousId: 'rv-retry',
      runId: 'run-a',
      revision: 7,
    });
    expect(active.arm).toHaveBeenCalledTimes(2);
    expect(active.arm).toHaveBeenLastCalledWith(retry);
  });

  it('does not let a cancelled late arm tear down a same-run replacement rendezvous', async () => {
    const staleGate = deferred<RendezvousArmReceipt>();
    const active = source();
    active.arm.mockReturnValueOnce(staleGate.promise);
    const adapter = participant(() => active);
    const staleIntent = armIntent();
    const stalePending = adapter.arm(staleIntent);
    await drainMicrotasks();
    await adapter.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
      reasonCode: 'replace-pending-rendezvous',
    });
    const cancelCallsBeforeReplacement = active.cancel.mock.calls.length;

    const replacementIntent = armIntent({ rendezvousId: 'rv-replacement' });
    const replacementReceipt = await adapter.arm(replacementIntent);
    staleGate.resolve(armedReceipt(staleIntent));
    const staleReceipt = await stalePending;
    const replacementFinalize = await adapter.finalize(
      finalizeIntent({ rendezvousId: 'rv-replacement' }),
    );

    expect(replacementReceipt.status).toBe('armed');
    expect(staleReceipt).toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-cancelled',
    });
    expect(replacementFinalize.status).toBe('accepted');
    expect(active.cancel).toHaveBeenCalledTimes(cancelCallsBeforeReplacement);
  });

  it('rejects an equal-revision rendezvous for a different run after cancellation', async () => {
    const active = source();
    const adapter = participant(() => active);
    await adapter.arm(armIntent());
    await adapter.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
      reasonCode: 'cancel-first-run',
    });

    const receipt = await adapter.arm(armIntent({ runId: 'run-b', rendezvousId: 'rv-b' }));

    expect(receipt).toMatchObject({
      status: 'rejected',
      reasonCode: 'local-operation-conflict',
    });
    expect(active.arm).toHaveBeenCalledOnce();
  });

  it('turns thrown and rejected backend operations into valid rejected receipts', async () => {
    const armFailure = source();
    armFailure.arm.mockImplementationOnce(() => {
      throw new Error('decoder failed');
    });
    const failedArm = await participant(() => armFailure).arm(armIntent());

    const finalizeFailure = source();
    const finalizeAdapter = participant(() => finalizeFailure);
    await finalizeAdapter.arm(armIntent());
    finalizeFailure.finalize.mockRejectedValueOnce(new Error('worklet failed'));
    const failedFinalize = await finalizeAdapter.finalize(finalizeIntent());

    expect(failedArm).toMatchObject({
      status: 'rejected',
      reasonCode: 'local-source-arm-failed',
    });
    expect(failedFinalize).toMatchObject({
      status: 'rejected',
      reasonCode: 'local-source-finalize-failed',
    });
    expect(readRendezvousArmReceipt(failedArm)).not.toBeNull();
    expect(readRendezvousFinalizeReceipt(failedFinalize)).not.toBeNull();
    expect(Object.isFrozen(failedArm)).toBe(true);
    expect(Object.isFrozen(failedFinalize)).toBe(true);
  });

  it('preserves a backend rejection as a canonical frozen receipt', async () => {
    const active = source();
    active.arm.mockImplementationOnce(async (intent) => ({
      ...armedReceipt(intent),
      status: 'rejected',
      bufferedAheadSeconds: 0,
      reasonCode: 'decoder-not-ready',
    }));

    const receipt = await participant(() => active).arm(armIntent());

    expect(receipt).toMatchObject({ status: 'rejected', reasonCode: 'decoder-not-ready' });
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it('cancels the exact armed source after an owner swap and absorbs teardown errors', async () => {
    const armedSource = source();
    let active: FilePlaybackSource | null = armedSource;
    const adapter = participant(() => active);
    await adapter.arm(armIntent());
    const cancelIntent: FilePlaybackCancelIntent = Object.freeze({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-a',
      revision: 7,
      rendezvousId: 'rv-a',
      reasonCode: 'superseded',
    });
    armedSource.cancel.mockRejectedValueOnce(new Error('already stopped'));

    const replacement = source();
    active = replacement;

    await expect(adapter.cancel(cancelIntent)).resolves.toBeUndefined();
    expect(armedSource.cancel).toHaveBeenCalledOnce();
    expect(replacement.cancel).not.toHaveBeenCalled();
  });

  it('exposes only finite non-negative metrics from constants or fallible providers', () => {
    let rtt = 25;
    const dynamic = new LocalRendezvousParticipant({
      participantId: PARTICIPANT_ID,
      getActiveSource: () => null,
      rttP95Ms: () => rtt,
      armP95Ms: () => {
        throw new Error('telemetry unavailable');
      },
      nowRoomTimeMs: () => Number.NaN,
    });

    expect(dynamic.rttP95Ms).toBe(25);
    rtt = Number.NaN;
    expect(dynamic.rttP95Ms).toBe(2_500);
    expect(dynamic.armP95Ms).toBe(2_500);
    expect(Number.isFinite(dynamic.rttP95Ms)).toBe(true);
    expect(dynamic.rttP95Ms).toBeGreaterThanOrEqual(0);
    expect(
      () =>
        new LocalRendezvousParticipant({
          participantId: PARTICIPANT_ID,
          getActiveSource: () => null,
          rttP95Ms: -1,
          armP95Ms: 0,
          nowRoomTimeMs: () => 0,
        }),
    ).toThrow(/rttP95Ms/);
  });
});

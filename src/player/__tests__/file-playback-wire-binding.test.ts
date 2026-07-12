import { describe, expect, it } from 'vitest';

import {
  FilePlaybackWireBindingRegistry,
  type FilePlaybackWireMediaBinding,
  type FilePlaybackWireStateReference,
} from '../file-playback-wire-binding.ts';

const CURRENT_BINDING = Object.freeze({
  run: Object.freeze({
    queueItemId: 'queue-item-1',
    runId: 'run-7',
    revision: 7,
  }),
  sourceIdentity: 'sha256:source-1',
  transferSessionId: 'transfer-session-9',
}) satisfies FilePlaybackWireMediaBinding;

const CURRENT_REFERENCE = Object.freeze({
  ...CURRENT_BINDING.run,
  sourceIdentity: CURRENT_BINDING.sourceIdentity,
  transferSessionId: CURRENT_BINDING.transferSessionId,
}) satisfies FilePlaybackWireStateReference;

const SUCCESSOR_REFERENCE = Object.freeze({
  ...CURRENT_REFERENCE,
  revision: 8,
}) satisfies FilePlaybackWireStateReference;

function reference(
  changes: Partial<FilePlaybackWireStateReference> = {},
): FilePlaybackWireStateReference {
  return { ...SUCCESSOR_REFERENCE, ...changes };
}

function binding(value: FilePlaybackWireStateReference): FilePlaybackWireMediaBinding {
  return {
    run: {
      queueItemId: value.queueItemId,
      runId: value.runId,
      revision: value.revision,
    },
    sourceIdentity: value.sourceIdentity,
    transferSessionId: value.transferSessionId,
  };
}

function registryWithCurrent(): Readonly<{
  registry: FilePlaybackWireBindingRegistry;
  currentLease: ReturnType<FilePlaybackWireBindingRegistry['bootstrapCurrentMedia']>;
}> {
  const registry = new FilePlaybackWireBindingRegistry();
  const currentLease = registry.bootstrapCurrentMedia(CURRENT_BINDING);
  return { registry, currentLease };
}

describe('file playback wire binding rendezvous successors', () => {
  it('atomically stages an exact-next same-run state and its rendezvous attempt', () => {
    const { registry } = registryWithCurrent();

    const admitted = registry.admitRemoteRendezvousSuccessor(
      SUCCESSOR_REFERENCE,
      'rendezvous-next',
    );

    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.getPrototypeOf(admitted)).toBeNull();
    expect(registry.bindingForStateLease(admitted.stateLease)).toEqual(
      binding(SUCCESSOR_REFERENCE),
    );
    expect(registry.authorityForAttemptLease(admitted.attemptLease)).toEqual({
      stateLease: admitted.stateLease,
      rendezvousId: 'rendezvous-next',
    });
    expect(registry.resolveSuccessor(SUCCESSOR_REFERENCE, CURRENT_BINDING.run)).toEqual({
      status: 'active',
      stateLease: admitted.stateLease,
    });
    expect(registry.resolveArmAttempt(SUCCESSOR_REFERENCE, 'rendezvous-next')).toEqual({
      status: 'active',
      stateLease: admitted.stateLease,
      attemptLease: admitted.attemptLease,
    });

    registry.commitAttempt(admitted.attemptLease);
    registry.commitMedia(admitted.stateLease);
    expect(registry.bindingForStateLease(admitted.stateLease)).toEqual(
      binding(SUCCESSOR_REFERENCE),
    );
  });

  it('returns the same opaque leases only for an exact still-staged retry', () => {
    const { registry } = registryWithCurrent();
    const first = registry.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, 'rendezvous-next');
    const retry = registry.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, 'rendezvous-next');

    expect(retry.stateLease).toBe(first.stateLease);
    expect(retry.attemptLease).toBe(first.attemptLease);
    expect(() =>
      registry.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, 'rendezvous-conflict'),
    ).toThrow(/conflicts with current authority/u);
    expect(() =>
      registry.admitRemoteRendezvousSuccessor(
        reference({ sourceIdentity: 'sha256:source-other' }),
        'rendezvous-next',
      ),
    ).toThrow(/conflicts with current authority/u);
    expect(registry.resolveArmAttempt(SUCCESSOR_REFERENCE, 'rendezvous-next')).toEqual({
      status: 'active',
      stateLease: first.stateLease,
      attemptLease: first.attemptLease,
    });
  });

  it.each([
    ['queue item', { queueItemId: 'queue-item-other' }],
    ['logical run', { runId: 'run-other' }],
    ['source', { sourceIdentity: 'sha256:source-other' }],
    ['transfer session', { transferSessionId: 'transfer-session-other' }],
    ['already admitted revision', { revision: 7 }],
    ['non-contiguous future revision', { revision: 9 }],
  ] satisfies readonly [string, Partial<FilePlaybackWireStateReference>][])(
    'rejects a mismatched %s without consuming the valid successor slot',
    (_label, changes) => {
      const { registry } = registryWithCurrent();

      expect(() =>
        registry.admitRemoteRendezvousSuccessor(reference(changes), 'rendezvous-rejected'),
      ).toThrow(/conflicts with current authority/u);

      const admitted = registry.admitRemoteRendezvousSuccessor(
        SUCCESSOR_REFERENCE,
        'rendezvous-valid',
      );
      expect(registry.resolveArmAttempt(SUCCESSOR_REFERENCE, 'rendezvous-valid')).toEqual({
        status: 'active',
        stateLease: admitted.stateLease,
        attemptLease: admitted.attemptLease,
      });
    },
  );

  it('rejects partial candidate authority without changing first-play admission behavior', () => {
    const { registry } = registryWithCurrent();
    const candidate = registry.stageMedia(binding(SUCCESSOR_REFERENCE));

    expect(() =>
      registry.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, 'rendezvous-next'),
    ).toThrow(/conflicts with current authority/u);

    const firstPlay = registry.admitRemoteAttempt(SUCCESSOR_REFERENCE, 'rendezvous-first-play');
    expect(firstPlay.stateLease).toBe(candidate);
    expect(registry.resolveArmAttempt(SUCCESSOR_REFERENCE, 'rendezvous-first-play')).toEqual({
      status: 'active',
      stateLease: candidate,
      attemptLease: firstPlay.attemptLease,
    });
  });

  it('leaves same-state recovery and ordinary new-run staging unchanged', () => {
    const recoveryHarness = registryWithCurrent();
    const currentAttempt = recoveryHarness.registry.stageAttempt(
      recoveryHarness.currentLease,
      'rendezvous-current',
    );
    recoveryHarness.registry.commitAttempt(currentAttempt);

    const recovery = recoveryHarness.registry.admitRemoteAttempt(
      CURRENT_REFERENCE,
      'rendezvous-recovery',
    );
    expect(recovery.stateLease).toBe(recoveryHarness.currentLease);
    expect(
      recoveryHarness.registry.resolveArmAttempt(CURRENT_REFERENCE, 'rendezvous-recovery'),
    ).toEqual({
      status: 'active',
      stateLease: recoveryHarness.currentLease,
      attemptLease: recovery.attemptLease,
    });

    const newRunHarness = registryWithCurrent();
    const newRunReference = reference({
      runId: 'run-8',
      sourceIdentity: 'sha256:source-2',
      transferSessionId: null,
    });
    expect(() =>
      newRunHarness.registry.admitRemoteRendezvousSuccessor(newRunReference, 'rendezvous-new-run'),
    ).toThrow(/conflicts with current authority/u);
    const newRunLease = newRunHarness.registry.stageMedia(binding(newRunReference));
    expect(newRunHarness.registry.bindingForStateLease(newRunLease)).toEqual(
      binding(newRunReference),
    );
    const newRunAttempt = newRunHarness.registry.admitRemoteAttempt(
      newRunReference,
      'rendezvous-new-run',
    );
    expect(() =>
      newRunHarness.registry.admitRemoteRendezvousSuccessor(newRunReference, 'rendezvous-new-run'),
    ).toThrow(/conflicts with current authority/u);
    expect(newRunHarness.registry.resolveArmAttempt(newRunReference, 'rendezvous-new-run')).toEqual(
      {
        status: 'active',
        stateLease: newRunLease,
        attemptLease: newRunAttempt.attemptLease,
      },
    );
  });

  it('does not resurrect a retired pair and preserves consumed revision semantics', () => {
    const { registry } = registryWithCurrent();
    const retired = registry.admitRemoteRendezvousSuccessor(
      SUCCESSOR_REFERENCE,
      'rendezvous-retired',
    );
    registry.retireMedia(retired.stateLease);

    expect(registry.resolveAttempt(SUCCESSOR_REFERENCE, 'rendezvous-retired')).toEqual({
      status: 'stale',
    });
    expect(() =>
      registry.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, 'rendezvous-retired'),
    ).toThrow(/conflicts with current authority/u);
    expect(() =>
      registry.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, 'rendezvous-new-id'),
    ).toThrow(/conflicts with current authority/u);

    const nextReference = reference({ revision: 9 });
    const next = registry.admitRemoteRendezvousSuccessor(nextReference, 'rendezvous-next');
    expect(registry.resolveArmAttempt(nextReference, 'rendezvous-next')).toEqual({
      status: 'active',
      stateLease: next.stateLease,
      attemptLease: next.attemptLease,
    });
  });

  it('rejects exact ARM reuse after the admitted attempt becomes current', () => {
    const { registry } = registryWithCurrent();
    const admitted = registry.admitRemoteRendezvousSuccessor(
      SUCCESSOR_REFERENCE,
      'rendezvous-next',
    );
    registry.commitAttempt(admitted.attemptLease);

    expect(registry.resolveArmAttempt(SUCCESSOR_REFERENCE, 'rendezvous-next')).toEqual({
      status: 'unknown',
    });
    expect(() =>
      registry.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, 'rendezvous-next'),
    ).toThrow(/conflicts with current authority/u);

    registry.commitMedia(admitted.stateLease);
    expect(() =>
      registry.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, 'rendezvous-next'),
    ).toThrow(/conflicts with current authority/u);
  });

  it('rejects missing current, malformed input, and revoked authority without half-staging', () => {
    const stopped = new FilePlaybackWireBindingRegistry();
    stopped.bootstrapStopped(7);
    expect(() =>
      stopped.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, 'rendezvous-next'),
    ).toThrow(/conflicts with current authority/u);
    expect(stopped.stageMedia(binding(SUCCESSOR_REFERENCE))).toBeDefined();

    const { registry } = registryWithCurrent();
    let getterCalls = 0;
    const accessorReference = { ...SUCCESSOR_REFERENCE };
    Object.defineProperty(accessorReference, 'sourceIdentity', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return SUCCESSOR_REFERENCE.sourceIdentity;
      },
    });
    expect(() =>
      registry.admitRemoteRendezvousSuccessor(accessorReference, 'rendezvous-accessor'),
    ).toThrow(TypeError);
    expect(() => registry.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, ' ')).toThrow(
      TypeError,
    );
    expect(getterCalls).toBe(0);
    expect(
      registry.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, 'rendezvous-valid'),
    ).toBeDefined();

    const revoked = registryWithCurrent().registry;
    revoked.revokeAll();
    expect(() =>
      revoked.admitRemoteRendezvousSuccessor(SUCCESSOR_REFERENCE, 'rendezvous-next'),
    ).toThrow(/revoked/u);
  });
});

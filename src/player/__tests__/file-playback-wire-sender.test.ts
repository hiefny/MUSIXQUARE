import { describe, expect, it } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackWireSender,
  type FilePlaybackWirePayload,
  type FilePlaybackWirePayloadByKind,
  type FilePlaybackWireSenderOptions,
} from '../file-playback-wire-sender.ts';
import {
  FilePlaybackWireBindingRegistry,
  type FilePlaybackWireAttemptLease,
  type FilePlaybackWireLease,
  type FilePlaybackWireMediaBinding,
  type FilePlaybackWireStateLease,
} from '../file-playback-wire-binding.ts';

const scope: FilePlaybackWireSenderOptions = {
  sessionId: 'app-session-1',
  connectionId: 'connection-1',
  senderParticipantId: 'participant-guest-1',
  recipientParticipantId: 'participant-host',
};

const currentBinding: FilePlaybackWireMediaBinding = {
  run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
  sourceIdentity: 'sha256:source-1',
  transferSessionId: 'transfer-session-9',
};

const successorBinding: FilePlaybackWireMediaBinding = {
  run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 8 },
  sourceIdentity: 'sha256:source-1',
  transferSessionId: 'transfer-session-9',
};

const expected = Object.freeze({
  expectedQueueItemId: 'queue-item-1' as QueueItemId,
  expectedRunId: 'run-7',
  expectedRevision: 7,
});

const payloads = Object.freeze([
  {
    kind: 'source-ready',
    observedAtRoomTimeMs: 10_000,
    readyLeaseUntilRoomTimeMs: 40_000,
    backend: 'streaming-flac',
    durationSeconds: 555.7,
    bufferedAheadSeconds: 9.6,
    outputSampleRateHz: 48_000,
    channelCount: 2,
  },
  {
    kind: 'source-not-ready',
    observedAtRoomTimeMs: 10_001,
    reasonCode: 'source-still-loading',
    retryable: true,
  },
  {
    kind: 'rendezvous-arm',
    rendezvousId: 'rendezvous-7',
    positionSeconds: 12.25,
    playbackRate: 1,
    startAtRoomTimeMs: 12_000,
    finalizeByRoomTimeMs: 11_900,
  },
  {
    kind: 'rendezvous-armed',
    rendezvousId: 'rendezvous-7',
    status: 'armed',
    observedAtRoomTimeMs: 11_850,
    bufferedAheadSeconds: 9.4,
    reasonCode: null,
  },
  {
    kind: 'rendezvous-finalize',
    rendezvousId: 'rendezvous-7',
    startAtRoomTimeMs: 12_000,
    finalizedAtRoomTimeMs: 11_880,
  },
  {
    kind: 'rendezvous-finalized',
    rendezvousId: 'rendezvous-7',
    status: 'accepted',
    observedAtRoomTimeMs: 11_890,
    reasonCode: null,
  },
  { kind: 'file-playback-pause', ...expected, atRoomTimeMs: 13_000 },
  {
    kind: 'file-playback-seek',
    ...expected,
    positionSeconds: 99.5,
    atRoomTimeMs: 13_100,
  },
  {
    kind: 'file-playback-cancel',
    rendezvousId: 'rendezvous-7',
    reasonCode: 'superseded-by-newer-revision',
  },
  { kind: 'file-playback-stop', ...expected, atRoomTimeMs: 13_150 },
  {
    kind: 'renderer-health',
    rendezvousId: 'rendezvous-7',
    value: 'healthy',
    observedAtRoomTimeMs: 13_200,
    leaseUntilRoomTimeMs: 18_200,
    renderedFrame: 633_600,
    underrunCount: 0,
    reasonCode: null,
  },
] as const satisfies readonly FilePlaybackWirePayload[]);

interface SenderSetup {
  readonly sender: FilePlaybackWireSender;
  readonly current: FilePlaybackWireStateLease;
  readonly successor: FilePlaybackWireStateLease;
  readonly attempt: FilePlaybackWireAttemptLease;
}

function setupSender(): SenderSetup {
  const sender = new FilePlaybackWireSender(scope);
  const current = sender.bootstrapCurrentMedia(currentBinding);
  const attempt = sender.stageAttempt(current, 'rendezvous-7');
  const successor = sender.stageMedia(successorBinding);
  return { sender, current, successor, attempt };
}

function leaseFor(setup: SenderSetup, payload: FilePlaybackWirePayload): FilePlaybackWireLease {
  if (
    payload.kind === 'rendezvous-arm' ||
    payload.kind === 'rendezvous-armed' ||
    payload.kind === 'rendezvous-finalize' ||
    payload.kind === 'rendezvous-finalized' ||
    payload.kind === 'file-playback-cancel' ||
    payload.kind === 'renderer-health'
  ) {
    return setup.attempt;
  }
  if (
    payload.kind === 'file-playback-pause' ||
    payload.kind === 'file-playback-seek' ||
    payload.kind === 'file-playback-stop'
  ) {
    return setup.successor;
  }
  return setup.current;
}

describe('FilePlaybackWireSender', () => {
  it('builds every exact payload kind with connection-global sequence and exact leases', () => {
    const setup = setupSender();
    payloads.forEach((payload, index) => {
      const message = setup.sender.create(leaseFor(setup, payload), payload);
      const binding =
        payload.kind === 'file-playback-pause' ||
        payload.kind === 'file-playback-seek' ||
        payload.kind === 'file-playback-stop'
          ? successorBinding
          : currentBinding;
      expect(message).toEqual({
        protocolVersion: 2,
        ...scope,
        controlSequence: index + 1,
        queueItemId: binding.run.queueItemId,
        runId: binding.run.runId,
        revision: binding.run.revision,
        sourceIdentity: binding.sourceIdentity,
        transferSessionId: binding.transferSessionId,
        ...payload,
      });
      expect(Object.getPrototypeOf(message)).toBeNull();
      expect(Object.isFrozen(message)).toBe(true);
    });
    expect(setup.sender.lastControlSequence()).toBe(payloads.length);
  });

  it('snapshots exact connection and media data without invoking accessors', () => {
    const mutableScope = { ...scope };
    const mutableRun = { ...currentBinding.run };
    const mutableBinding = { ...currentBinding, run: mutableRun };
    const sender = new FilePlaybackWireSender(mutableScope);
    const lease = sender.bootstrapCurrentMedia(mutableBinding);

    mutableScope.sessionId = 'mutated-session';
    mutableRun.runId = 'mutated-run';
    mutableBinding.sourceIdentity = 'mutated-source';
    expect(sender.create(lease, payloads[0])).toMatchObject({
      sessionId: 'app-session-1',
      runId: 'run-7',
      sourceIdentity: 'sha256:source-1',
    });

    let getterCalls = 0;
    const accessor = { ...currentBinding };
    Object.defineProperty(accessor, 'sourceIdentity', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'sha256:source-1';
      },
    });
    expect(() => sender.stageMedia(accessor)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });

  it('rejects malformed payloads atomically without consuming sequence', () => {
    const setup = setupSender();
    const missing = { ...payloads[0] } as Record<string, unknown>;
    delete missing.durationSeconds;
    const extra = { ...payloads[0], queueIndex: 0 };
    const accessor = { ...payloads[0] };
    let getterCalls = 0;
    Object.defineProperty(accessor, 'durationSeconds', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 555.7;
      },
    });
    for (const value of [missing, extra, accessor]) {
      expect(() =>
        setup.sender.create(setup.current, value as unknown as (typeof payloads)[0]),
      ).toThrow(TypeError);
      expect(setup.sender.lastControlSequence()).toBe(0);
    }
    expect(getterCalls).toBe(0);
  });

  it('supports current and candidate rendezvous attempts simultaneously', () => {
    const setup = setupSender();
    setup.sender.commitAttempt(setup.attempt);
    const recovery = setup.sender.stageAttempt(setup.current, 'rendezvous-recovery');
    const currentHealth = setup.sender.create(setup.attempt, payloads[10]);
    const recoveryArm = setup.sender.create(recovery, {
      ...payloads[2],
      rendezvousId: 'rendezvous-recovery',
    });

    expect(currentHealth).toMatchObject({ controlSequence: 1, rendezvousId: 'rendezvous-7' });
    expect(recoveryArm).toMatchObject({
      controlSequence: 2,
      rendezvousId: 'rendezvous-recovery',
    });
  });

  it('makes attempt cancel candidate-only and keeps logical stop on a successor state', () => {
    const setup = setupSender();
    expect(setup.sender.create(setup.attempt, payloads[8])).toMatchObject({
      kind: 'file-playback-cancel',
      rendezvousId: 'rendezvous-7',
      revision: 7,
    });
    expect(setup.sender.create(setup.successor, payloads[9])).toMatchObject({
      kind: 'file-playback-stop',
      revision: 8,
      expectedRevision: 7,
    });
    setup.sender.commitAttempt(setup.attempt);
    expect(() => setup.sender.create(setup.attempt, payloads[8])).toThrow(/candidate/);
  });

  it('requires exact successor identity for pause, seek, and stop', () => {
    const setup = setupSender();
    expect(setup.sender.create(setup.successor, payloads[6]).revision).toBe(8);
    expect(() =>
      setup.sender.create(setup.successor, {
        ...payloads[7],
        expectedRevision: 6,
      }),
    ).toThrow(/successor/);
    expect(() => setup.sender.create(setup.current, payloads[9])).toThrow();
  });

  it('rejects forged, retired, revoked, and over-capacity leases', () => {
    const setup = setupSender();
    expect(() => setup.sender.create({} as FilePlaybackWireStateLease, payloads[0])).toThrow(
      /forged|retired/,
    );
    expect(() =>
      setup.sender.stageMedia({
        run: { queueItemId: 'queue-item-2', runId: 'run-8', revision: 9 },
        sourceIdentity: 'sha256:source-2',
        transferSessionId: null,
      }),
    ).toThrow(/candidate/);

    setup.sender.retireMedia(setup.successor);
    expect(() => setup.sender.create(setup.successor, payloads[6])).toThrow(/forged|retired/);
    expect(() => setup.sender.stageMedia({ ...successorBinding })).toThrow(/exact next/);
    setup.sender.revokeAll();
    expect(() => setup.sender.create(setup.current, payloads[0])).toThrow(/revoked/);
  });

  it('observes nested sequence commits after hostile payload reentry', () => {
    const setup = setupSender();
    let reentered = false;
    const outer = new Proxy(
      { ...payloads[0] },
      {
        ownKeys(target) {
          if (!reentered) {
            reentered = true;
            expect(setup.sender.create(setup.current, payloads[1]).controlSequence).toBe(1);
          }
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(setup.sender.create(setup.current, outer).controlSequence).toBe(2);
  });

  it('does not revive a lease retired during hostile payload detachment', () => {
    const setup = setupSender();
    let reentered = false;
    const outer = new Proxy(
      { ...payloads[6] },
      {
        ownKeys(target) {
          if (!reentered) {
            reentered = true;
            setup.sender.retireMedia(setup.successor);
          }
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(() => setup.sender.create(setup.successor, outer)).toThrow(/forged|retired/);
    expect(setup.sender.lastControlSequence()).toBe(0);
  });

  it('rejects a mismatched rendezvous under an otherwise valid attempt lease', () => {
    const setup = setupSender();
    expect(() =>
      setup.sender.create(setup.attempt, {
        ...(payloads[2] as FilePlaybackWirePayloadByKind['rendezvous-arm']),
        rendezvousId: 'forged-rendezvous',
      }),
    ).toThrow(/exact lease/);
    expect(setup.sender.lastControlSequence()).toBe(0);
  });

  it('bootstraps one authoritative high revision once, then consumes exact admitted successors', () => {
    const sender = new FilePlaybackWireSender(scope);
    const high: FilePlaybackWireMediaBinding = {
      ...currentBinding,
      run: { ...currentBinding.run, revision: 500 },
    };
    expect(() => sender.stageMedia({ ...high, run: { ...high.run, revision: 501 } })).toThrow(
      /bootstrapped/,
    );
    const current = sender.bootstrapCurrentMedia(high);
    expect(sender.create(current, payloads[0]).revision).toBe(500);
    expect(() => sender.bootstrapCurrentMedia(high)).toThrow(/one-shot/);
    expect(() => sender.stageMedia({ ...high, run: { ...high.run, revision: 502 } })).toThrow(
      /exact next/,
    );
    const candidate = sender.stageMedia({ ...high, run: { ...high.run, revision: 501 } });
    sender.retireMedia(candidate);
    expect(() => sender.stageMedia({ ...high, run: { ...high.run, revision: 501 } })).toThrow(
      /exact next/,
    );
    expect(() => sender.stageMedia({ ...high, run: { ...high.run, revision: 502 } })).not.toThrow();
  });

  it('bootstraps an empty stopped timeline at zero or a late-join watermark exactly once', () => {
    const stopped = new FilePlaybackWireSender(scope);
    stopped.bootstrapStopped(0);
    const first = stopped.stageMedia({
      ...currentBinding,
      run: { queueItemId: 'queue-item-first', runId: 'run-first', revision: 1 },
    });
    expect(stopped.create(first, payloads[0]).revision).toBe(1);
    expect(() => stopped.bootstrapStopped(0)).toThrow(/one-shot/u);
    expect(() => stopped.bootstrapCurrentMedia(currentBinding)).toThrow(/one-shot/u);

    const lateJoin = new FilePlaybackWireSender(scope);
    lateJoin.bootstrapStopped(100);
    expect(() =>
      lateJoin.stageMedia({
        ...currentBinding,
        run: { queueItemId: 'queue-item-late', runId: 'run-late', revision: 100 },
      }),
    ).toThrow(/exact next/u);
    expect(() =>
      lateJoin.stageMedia({
        ...currentBinding,
        run: { queueItemId: 'queue-item-late', runId: 'run-late', revision: 101 },
      }),
    ).not.toThrow();

    const current = new FilePlaybackWireSender(scope);
    current.bootstrapCurrentMedia(currentBinding);
    expect(() => current.bootstrapStopped(7)).toThrow(/one-shot/u);
    expect(() => new FilePlaybackWireSender(scope).bootstrapStopped(-0)).toThrow(TypeError);
  });

  it('commits stop atomically to no-current and admits only the exact next new play', () => {
    const setup = setupSender();
    setup.sender.create(setup.successor, payloads[9]);

    expect(() => setup.sender.stageAttempt(setup.successor, 'stop-attempt')).toThrow(
      /stop successor/u,
    );
    expect(() => setup.sender.create(setup.successor, payloads[0])).toThrow(
      /media state authority/u,
    );
    expect(() => setup.sender.commitMedia(setup.successor)).toThrow(/candidate state/u);
    expect(() =>
      setup.sender.commitStop(setup.successor, { ...currentBinding.run, revision: 6 }),
    ).toThrow(/stop successor/u);

    setup.sender.commitStop(setup.successor, currentBinding.run);
    expect(() => setup.sender.create(setup.current, payloads[0])).toThrow(/forged|retired/u);
    expect(() => setup.sender.stageAttempt(setup.successor, 'stop-attempt')).toThrow(
      /forged|retired/u,
    );

    const next = setup.sender.stageMedia({
      run: { queueItemId: 'queue-item-2', runId: 'run-next', revision: 9 },
      sourceIdentity: 'sha256:source-2',
      transferSessionId: null,
    });
    setup.sender.commitMedia(next);
    expect(() => setup.sender.stageAttempt(next, 'rendezvous-next')).not.toThrow();
    expect(() => setup.sender.stageMedia(successorBinding)).toThrow(/exact next/u);
  });

  it('does not turn a candidate into stop authority when stop message creation fails', () => {
    const setup = setupSender();
    expect(() =>
      setup.sender.create(setup.successor, {
        ...payloads[9],
        atRoomTimeMs: Number.NaN,
      }),
    ).toThrow(TypeError);
    expect(setup.sender.lastControlSequence()).toBe(0);
    expect(setup.sender.create(setup.successor, payloads[6])).toMatchObject({
      kind: 'file-playback-pause',
      controlSequence: 1,
    });
  });

  it('remembers exact alternating run intervals without treating revision holes as stale', () => {
    const bindings = new FilePlaybackWireBindingRegistry();
    bindings.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-a', runId: 'run-a', revision: 1 },
      sourceIdentity: 'source-a',
      transferSessionId: null,
    });
    const otherRun = bindings.stageMedia({
      run: { queueItemId: 'queue-b', runId: 'run-b', revision: 2 },
      sourceIdentity: 'source-b',
      transferSessionId: null,
    });
    bindings.retireMedia(otherRun);
    const resumedRun = bindings.stageMedia({
      run: { queueItemId: 'queue-a', runId: 'run-a', revision: 3 },
      sourceIdentity: 'source-a',
      transferSessionId: null,
    });
    bindings.retireMedia(resumedRun);

    expect(
      bindings.resolveState({
        queueItemId: 'queue-a',
        runId: 'run-a',
        revision: 2,
        sourceIdentity: 'source-a',
        transferSessionId: null,
      }),
    ).toEqual({ status: 'unknown' });
    expect(
      bindings.resolveState({
        queueItemId: 'queue-b',
        runId: 'run-b',
        revision: 2,
        sourceIdentity: 'source-b',
        transferSessionId: null,
      }),
    ).toEqual({ status: 'stale' });
    expect(
      bindings.resolveState({
        queueItemId: 'queue-a',
        runId: 'run-a',
        revision: 3,
        sourceIdentity: 'source-a',
        transferSessionId: null,
      }),
    ).toEqual({ status: 'stale' });
  });
});

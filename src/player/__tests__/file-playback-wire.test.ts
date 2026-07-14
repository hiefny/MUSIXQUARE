import { describe, expect, it } from 'vitest';

import {
  FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH,
  FILE_PLAYBACK_WIRE_MAX_PAYLOAD_BYTES,
  FilePlaybackWireReceiver,
  createFilePlaybackWireMessage,
  parseFilePlaybackWireMessage as parseWireMessage,
  serializeFilePlaybackWireMessage,
  type FilePlaybackWireReceiveExpectations,
  type FilePlaybackWireMessage,
  type FilePlaybackWireReceiverResult,
} from '../file-playback-wire.ts';

const envelope = Object.freeze({
  protocolVersion: 2 as const,
  sessionId: 'app-session-1',
  connectionId: 'connection-1',
  senderParticipantId: 'participant-guest-1',
  recipientParticipantId: 'participant-host',
  controlSequence: 41,
  queueItemId: 'queue-item-1',
  runId: 'run-7',
  revision: 7,
  sourceIdentity: 'sha256:source-1',
  transferSessionId: 'transfer-session-9',
});

const messages: readonly FilePlaybackWireMessage[] = Object.freeze([
  {
    ...envelope,
    kind: 'source-ready',
    observedAtRoomTimeMs: 10_000,
    readyLeaseUntilRoomTimeMs: 40_000,
    backend: 'bounded-stream',
    durationSeconds: 555.7,
    bufferedAheadSeconds: 9.6,
    outputSampleRateHz: 48_000,
    channelCount: 2,
  },
  {
    ...envelope,
    kind: 'source-not-ready',
    controlSequence: 42,
    observedAtRoomTimeMs: 10_001,
    reasonCode: 'source-still-loading',
    retryable: true,
  },
  {
    ...envelope,
    kind: 'rendezvous-arm',
    controlSequence: 43,
    rendezvousId: 'rendezvous-7',
    positionSeconds: 12.25,
    playbackRate: 1,
    startAtRoomTimeMs: 12_000,
    finalizeByRoomTimeMs: 11_900,
  },
  {
    ...envelope,
    kind: 'rendezvous-armed',
    controlSequence: 44,
    rendezvousId: 'rendezvous-7',
    status: 'armed',
    observedAtRoomTimeMs: 11_850,
    bufferedAheadSeconds: 9.4,
    reasonCode: null,
  },
  {
    ...envelope,
    kind: 'rendezvous-finalize',
    controlSequence: 45,
    rendezvousId: 'rendezvous-7',
    startAtRoomTimeMs: 12_000,
    finalizedAtRoomTimeMs: 11_880,
  },
  {
    ...envelope,
    kind: 'rendezvous-finalized',
    controlSequence: 46,
    rendezvousId: 'rendezvous-7',
    status: 'accepted',
    observedAtRoomTimeMs: 11_890,
    reasonCode: null,
  },
  {
    ...envelope,
    kind: 'file-playback-pause',
    controlSequence: 47,
    revision: 8,
    expectedQueueItemId: 'queue-item-1',
    expectedRunId: 'run-7',
    expectedRevision: 7,
    atRoomTimeMs: 13_000,
  },
  {
    ...envelope,
    kind: 'file-playback-seek',
    controlSequence: 48,
    revision: 9,
    expectedQueueItemId: 'queue-item-1',
    expectedRunId: 'run-7',
    expectedRevision: 7,
    positionSeconds: 99.5,
    atRoomTimeMs: 13_100,
  },
  {
    ...envelope,
    kind: 'file-playback-cancel',
    controlSequence: 49,
    rendezvousId: 'rendezvous-7',
    reasonCode: 'superseded-by-newer-revision',
  },
  {
    ...envelope,
    kind: 'file-playback-stop',
    controlSequence: 50,
    revision: 10,
    expectedQueueItemId: 'queue-item-1',
    expectedRunId: 'run-7',
    expectedRevision: 7,
    atRoomTimeMs: 13_150,
  },
  {
    ...envelope,
    kind: 'renderer-health',
    controlSequence: 51,
    rendezvousId: 'rendezvous-7',
    value: 'healthy',
    observedAtRoomTimeMs: 13_200,
    leaseUntilRoomTimeMs: 18_200,
    renderedFrame: 633_600,
    underrunCount: 0,
    reasonCode: null,
  },
  {
    ...envelope,
    kind: 'file-playback-prepare',
    controlSequence: 52,
    revision: 8,
    expectedQueueItemId: 'queue-item-1',
    expectedRunId: 'run-7',
    expectedRevision: 7,
    positionSeconds: 99.5,
    playbackRate: 1,
  },
]);

function record(message: FilePlaybackWireMessage = messages[0]): Record<string, unknown> {
  return JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
}

function replace(
  message: FilePlaybackWireMessage,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  return { ...record(message), ...changes };
}

function parseFilePlaybackWireMessage(
  value: unknown,
  overrides: Partial<FilePlaybackWireReceiveExpectations> = {},
): FilePlaybackWireMessage | null {
  let rendezvousId: string | undefined;
  try {
    const descriptor =
      value && typeof value === 'object'
        ? Object.getOwnPropertyDescriptor(value, 'rendezvousId')
        : undefined;
    if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string') {
      rendezvousId = descriptor.value;
    }
  } catch {
    // The production parser performs its own detached hostile-object handling.
  }
  return parseWireMessage(value, {
    sessionId: 'app-session-1',
    connectionId: 'connection-1',
    senderParticipantId: 'participant-guest-1',
    recipientParticipantId: 'participant-host',
    lastControlSequence: 0,
    receivedAtRoomTimeMs: 11_800,
    maxClockSkewMs: 2_500,
    ...(rendezvousId === undefined ? {} : { rendezvousId }),
    ...overrides,
  });
}

describe('file playback V2 control wire', () => {
  it.each(messages.map((message) => [message.kind, message] as const))(
    'round-trips and freezes a detached canonical %s message',
    (_kind, input) => {
      const untrusted = record(input);
      const parsed = parseFilePlaybackWireMessage(untrusted);

      expect(parsed).toEqual(input);
      expect(parsed).not.toBe(untrusted);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(JSON.parse(serializeFilePlaybackWireMessage(parsed!))).toEqual(input);

      untrusted.sourceIdentity = 'mutated-after-parse';
      expect(parsed?.sourceIdentity).toBe('sha256:source-1');
    },
  );

  it('rejects extra, missing, symbol, non-enumerable, and accessor keys', () => {
    const extra = { ...record(), queueIndex: 0 };
    const missing = record();
    delete missing.queueItemId;
    const symbolKey = record();
    Object.defineProperty(symbolKey, Symbol('hidden'), { enumerable: true, value: 'x' });
    const nonEnumerable = record();
    Object.defineProperty(nonEnumerable, 'hidden', { enumerable: false, value: 'x' });
    const accessor = record();
    Object.defineProperty(accessor, 'sourceIdentity', {
      enumerable: true,
      get: () => 'sha256:source-1',
    });

    for (const candidate of [extra, missing, symbolKey, nonEnumerable, accessor]) {
      expect(parseFilePlaybackWireMessage(candidate)).toBeNull();
    }
  });

  it('detaches hostile Proxy values before validation, budgeting, and canonicalization', () => {
    const valid = record(messages[0]);
    let sourceReads = 0;
    const changing = new Proxy(valid, {
      get(target, property, receiver) {
        if (property === 'sourceIdentity') {
          sourceReads += 1;
          return sourceReads === 1 ? 'sha256:source-1' : '';
        }
        if (property === 'toJSON') return () => ({});
        return Reflect.get(target, property, receiver);
      },
    });

    const parsed = parseFilePlaybackWireMessage(changing);
    expect(parsed?.sourceIdentity).toBe('sha256:source-1');
    expect(sourceReads).toBe(0);

    const oversized = record(messages[0]);
    for (const key of [
      'sessionId',
      'connectionId',
      'senderParticipantId',
      'recipientParticipantId',
      'queueItemId',
      'runId',
      'sourceIdentity',
      'transferSessionId',
    ]) {
      oversized[key] = '한'.repeat(FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH);
    }
    const hiddenByToJson = new Proxy(oversized, {
      get(target, property, receiver) {
        if (property === 'toJSON') return () => ({});
        return Reflect.get(target, property, receiver);
      },
    });
    expect(parseFilePlaybackWireMessage(hiddenByToJson)).toBeNull();
  });

  it('rejects accessors even when Object.prototype is polluted with value', () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
    let getterCalls = 0;
    const accessorRecord: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record(messages[0]))) {
      Object.defineProperty(accessorRecord, key, {
        enumerable: true,
        configurable: true,
        get: () => {
          getterCalls += 1;
          return value;
        },
      });
    }

    let parsed: FilePlaybackWireMessage | null = null;
    try {
      Object.defineProperty(Object.prototype, 'value', {
        configurable: true,
        get: () => 'polluted',
      });
      parsed = parseFilePlaybackWireMessage(accessorRecord);
    } finally {
      if (original) Object.defineProperty(Object.prototype, 'value', original);
      else delete (Object.prototype as { value?: unknown }).value;
    }
    expect(parsed).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it('enforces the serialized byte budget after per-field bounds', () => {
    const wide = '한'.repeat(FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH);
    const oversized = replace(messages[0], {
      sessionId: wide,
      connectionId: wide,
      senderParticipantId: wide,
      recipientParticipantId: `x${wide.slice(1)}`,
      queueItemId: wide,
      runId: wide,
      sourceIdentity: wide,
      transferSessionId: wide,
    });

    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(
      FILE_PLAYBACK_WIRE_MAX_PAYLOAD_BYTES,
    );
    expect(parseFilePlaybackWireMessage(oversized)).toBeNull();
  });

  it('enforces protocol, identifier, reason, participant, and sequence bounds', () => {
    const overlongId = 'x'.repeat(FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH + 1);
    const notReady = messages[1];
    for (const changes of [
      { protocolVersion: 1 },
      { sessionId: overlongId },
      { connectionId: '' },
      { senderParticipantId: 'participant-host' },
      { controlSequence: 0 },
      { controlSequence: 1.5 },
      { controlSequence: Number.MAX_VALUE },
      { sourceIdentity: overlongId },
      { transferSessionId: '' },
      { reasonCode: 'x'.repeat(161) },
    ]) {
      expect(parseFilePlaybackWireMessage(replace(notReady, changes))).toBeNull();
    }
  });

  it('rejects stale sequences and mismatched session, connection, participant, run, or source', () => {
    const candidate = messages[2];
    const exact = {
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      lastControlSequence: 42,
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
      rendezvousId: 'rendezvous-7',
    } as const;

    expect(parseFilePlaybackWireMessage(record(candidate), exact)).toEqual(candidate);
    expect(
      parseFilePlaybackWireMessage(record(candidate), { ...exact, lastControlSequence: 43 }),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(candidate), { ...exact, sessionId: 'other-session' }),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(candidate), {
        ...exact,
        connectionId: 'other-connection',
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(candidate), {
        ...exact,
        senderParticipantId: 'other-participant',
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(candidate), {
        ...exact,
        sourceIdentity: 'sha256:other-source',
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(candidate), {
        ...exact,
        transferSessionId: 'other-transfer',
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(candidate), {
        ...exact,
        run: { ...exact.run, revision: 8 },
      }),
    ).toBeNull();
  });

  it('rejects invalid or positional fallback playback identity', () => {
    const arm = messages[2];
    for (const changes of [
      { queueItemId: '' },
      { queueItemId: undefined, queueIndex: 0 },
      { runId: '' },
      { revision: -1 },
      { revision: 1.5 },
      { revision: Number.MAX_VALUE },
      { revision: -0 },
    ]) {
      expect(parseFilePlaybackWireMessage(replace(arm, changes))).toBeNull();
    }
  });

  it('keeps transfer identity distinct from the application session', () => {
    const local = replace(messages[0], { transferSessionId: null });
    const parsed = parseFilePlaybackWireMessage(local, {
      sessionId: 'app-session-1',
      transferSessionId: null,
    });

    expect(parsed?.sessionId).toBe('app-session-1');
    expect(parsed?.transferSessionId).toBeNull();
    expect(parseFilePlaybackWireMessage(local, { transferSessionId: 'app-session-1' })).toBeNull();
  });

  it('validates source-ready lease, duration, backend, and render format', () => {
    const ready = messages[0];
    for (const changes of [
      { readyLeaseUntilRoomTimeMs: 10_000 },
      { readyLeaseUntilRoomTimeMs: 130_001 },
      { durationSeconds: 0 },
      { durationSeconds: Number.MAX_VALUE },
      { backend: 'media-element' },
      { bufferedAheadSeconds: 556 },
      { outputSampleRateHz: 0 },
      { channelCount: 9 },
    ]) {
      expect(parseFilePlaybackWireMessage(replace(ready, changes))).toBeNull();
    }
  });

  it('validates exact rendezvous identities, schedules, receipts, and reasons', () => {
    const arm = messages[2];
    const armed = messages[3];
    const finalize = messages[4];
    const finalized = messages[5];

    expect(parseFilePlaybackWireMessage(replace(arm, { rendezvousId: '' }))).toBeNull();
    expect(parseFilePlaybackWireMessage(replace(arm, { finalizeByRoomTimeMs: 12_001 }))).toBeNull();
    expect(parseFilePlaybackWireMessage(replace(arm, { playbackRate: Infinity }))).toBeNull();
    expect(
      parseFilePlaybackWireMessage(replace(armed, { status: 'armed', reasonCode: 'why' })),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(replace(armed, { status: 'rejected', reasonCode: null })),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(replace(finalize, { finalizedAtRoomTimeMs: 12_001 })),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(
        replace(finalized, { status: 'missed-deadline', reasonCode: null }),
      ),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(finalized), { rendezvousId: 'other-rendezvous' }),
    ).toBeNull();
  });

  it('requires revisioned pause, seek, and cancel payloads exactly', () => {
    const pause = messages[6];
    const seek = messages[7];
    const cancel = messages[8];

    expect(parseFilePlaybackWireMessage(replace(pause, { atRoomTimeMs: NaN }))).toBeNull();
    expect(parseFilePlaybackWireMessage(replace(seek, { positionSeconds: -1 }))).toBeNull();
    expect(
      parseFilePlaybackWireMessage(replace(seek, { atRoomTimeMs: Number.MAX_VALUE })),
    ).toBeNull();
    expect(parseFilePlaybackWireMessage(replace(cancel, { reasonCode: '' }))).toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(cancel), {
        run: { queueItemId: 'queue-item-1', runId: 'run-older', revision: 7 },
      }),
    ).toBeNull();
  });

  it('requires an exact same-run successor and bounded media intent for PREPARE', () => {
    const prepare = messages[11];
    for (const changes of [
      { expectedQueueItemId: 'other-item' },
      { expectedRunId: 'other-run' },
      { expectedRevision: 8 },
      { expectedRevision: 9 },
      { positionSeconds: -1 },
      { positionSeconds: Number.MAX_VALUE },
      { playbackRate: 0 },
      { playbackRate: 17 },
    ]) {
      expect(parseFilePlaybackWireMessage(replace(prepare, changes))).toBeNull();
    }
  });

  it('validates renderer leases, counters, and status/reason coherence', () => {
    const healthy = messages[10];
    const unhealthy = replace(healthy, {
      value: 'unhealthy',
      leaseUntilRoomTimeMs: 13_200,
      reasonCode: 'audio-context-interrupted',
    });

    expect(parseFilePlaybackWireMessage(unhealthy)).not.toBeNull();
    expect(
      parseFilePlaybackWireMessage(replace(healthy, { leaseUntilRoomTimeMs: 43_201 })),
    ).toBeNull();
    expect(parseFilePlaybackWireMessage(replace(healthy, { reasonCode: 'unexpected' }))).toBeNull();
    expect(parseFilePlaybackWireMessage({ ...unhealthy, leaseUntilRoomTimeMs: 13_201 })).toBeNull();
    expect(
      parseFilePlaybackWireMessage(replace(healthy, { renderedFrame: Number.MAX_VALUE })),
    ).toBeNull();
    expect(parseFilePlaybackWireMessage(replace(healthy, { underrunCount: -1 }))).toBeNull();
    expect(parseFilePlaybackWireMessage(replace(healthy, { rendezvousId: '' }))).toBeNull();
  });

  it('binds leases and scheduled timestamps to trusted receive room time', () => {
    expect(
      parseFilePlaybackWireMessage(record(messages[0]), {
        receivedAtRoomTimeMs: 20_000,
        maxClockSkewMs: 250,
      }),
    ).not.toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(messages[0]), {
        receivedAtRoomTimeMs: 40_000,
        maxClockSkewMs: 250,
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(messages[2]), {
        receivedAtRoomTimeMs: 9_000,
        maxClockSkewMs: 250,
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(messages[2]), {
        receivedAtRoomTimeMs: 11_800,
        maxClockSkewMs: 250,
      }),
    ).not.toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(messages[10]), {
        receivedAtRoomTimeMs: 13_210,
        maxClockSkewMs: 250,
        rendezvousId: 'rendezvous-7',
      }),
    ).not.toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(messages[10]), {
        receivedAtRoomTimeMs: 18_200,
        maxClockSkewMs: 250,
        rendezvousId: 'rendezvous-7',
      }),
    ).toBeNull();
  });

  it('requires a complete own-data receive scope and rejects malformed expectations', () => {
    expect(
      parseWireMessage(record(messages[0]), {} as FilePlaybackWireReceiveExpectations),
    ).toBeNull();
    expect(
      parseWireMessage(record(messages[0]), {
        sessionId: 'app-session-1',
        connectionId: 'connection-1',
        senderParticipantId: 'participant-guest-1',
        recipientParticipantId: 'participant-host',
        lastControlSequence: 0,
        receivedAtRoomTimeMs: 10_000,
        maxClockSkewMs: null as unknown as number,
      }),
    ).toBeNull();
    expect(
      parseFilePlaybackWireMessage(record(messages[0]), {
        run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: -0 },
      }),
    ).toBeNull();
  });

  it('atomically gates current/candidate state and rendezvous leases behind one sequence', () => {
    let now = 11_800;
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => now,
    });
    expect(receiver.receive(record(messages[0]))).toMatchObject({
      accepted: false,
      reason: 'unknown-binding',
    });
    expect(receiver.lastControlSequence()).toBe(0);

    const current = receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    const attempt = receiver.stageAttempt(current, 'rendezvous-7');
    expect(receiver.receive(record(messages[0]))).toMatchObject({
      accepted: true,
      status: 'message',
      stateLease: current,
      attemptLease: null,
    });
    expect(receiver.receive(record(messages[2]))).toMatchObject({
      accepted: true,
      status: 'message',
      stateLease: current,
      attemptLease: attempt,
    });
    receiver.commitAttempt(attempt);
    now = 13_200;
    const successor = receiver.stageMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 8 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    expect(receiver.receive(record(messages[6]))).toMatchObject({
      accepted: true,
      status: 'message',
      stateLease: successor,
    });
    expect(receiver.receive(record(messages[10]))).toMatchObject({
      accepted: true,
      status: 'message',
      stateLease: current,
      attemptLease: attempt,
    });
    expect(receiver.lastControlSequence()).toBe(51);

    receiver.retireMedia(successor);
    now += 1;
    expect(receiver.receive(replace(messages[6], { controlSequence: 52 }))).toEqual({
      accepted: true,
      status: 'stale',
      scope: 'state',
      controlSequence: 52,
    });
    expect(receiver.lastControlSequence()).toBe(52);
    expect(
      receiver.receive(
        replace(messages[0], { controlSequence: 53, sourceIdentity: 'unknown-source' }),
      ),
    ).toMatchObject({ accepted: false, reason: 'unknown-binding' });

    receiver.retireMedia(current);
    expect(receiver.receive(replace(messages[10], { controlSequence: 54 }))).toEqual({
      accepted: true,
      status: 'stale',
      scope: 'attempt',
      controlSequence: 54,
    });
  });

  it.each([
    ['file-playback-pause', messages[6]],
    ['file-playback-seek', messages[7]],
  ] as const)('atomically admits an unstaged remote %s successor', (_kind, template) => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 13_200,
    });
    receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });

    const accepted = receiver.receive(
      replace(template, {
        revision: 8,
        controlSequence: 60,
        atRoomTimeMs: 13_100,
      }),
    );
    expect(accepted).toMatchObject({
      accepted: true,
      status: 'message',
      message: { kind: _kind, revision: 8, expectedRevision: 7 },
      attemptLease: null,
    });
    if (!accepted.accepted || accepted.status !== 'message') {
      throw new Error('Expected an admitted remote successor');
    }
    expect(() => receiver.commitMedia(accepted.stateLease)).not.toThrow();
  });

  it('admits an unstaged stop as exact stop authority and commits to no-current atomically', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 13_200,
    });
    const current = receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    const accepted = receiver.receive(
      replace(messages[9], { revision: 8, controlSequence: 60, atRoomTimeMs: 13_100 }),
    );
    expect(accepted).toMatchObject({
      accepted: true,
      status: 'message',
      message: { kind: 'file-playback-stop', revision: 8, expectedRevision: 7 },
    });
    if (!accepted.accepted || accepted.status !== 'message') {
      throw new Error('Expected an admitted remote stop');
    }
    expect(() => receiver.stageAttempt(accepted.stateLease, 'stop-attempt')).toThrow(
      /stop successor/u,
    );
    expect(() => receiver.commitMedia(accepted.stateLease)).toThrow(/candidate state/u);
    receiver.commitStop(accepted.stateLease, {
      queueItemId: 'queue-item-1',
      runId: 'run-7',
      revision: 7,
    });
    expect(() => receiver.stageAttempt(current, 'old-attempt')).toThrow(/forged|retired/u);
    const next = receiver.stageMedia({
      run: { queueItemId: 'queue-item-2', runId: 'run-next', revision: 9 },
      sourceIdentity: 'sha256:source-2',
      transferSessionId: null,
    });
    expect(() => receiver.commitMedia(next)).not.toThrow();
  });

  it('does not consume a remote successor revision for replayed or temporal-invalid frames', () => {
    let now = 13_000;
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => now,
    });
    receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    expect(receiver.receive(replace(messages[0], { controlSequence: 41 }))).toMatchObject({
      accepted: true,
      status: 'message',
    });
    expect(
      receiver.receive(
        replace(messages[6], {
          revision: 8,
          controlSequence: 41,
          atRoomTimeMs: now,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'replayed-sequence' });
    expect(
      receiver.receive(
        replace(messages[6], {
          revision: 8,
          controlSequence: 42,
          atRoomTimeMs: now + 1_000,
        }),
      ),
    ).toMatchObject({ accepted: true, status: 'message', message: { revision: 8 } });

    const later = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => now,
    });
    later.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    expect(
      later.receive(
        replace(messages[6], {
          revision: 8,
          controlSequence: 42,
          atRoomTimeMs: now + 3_000,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'temporal-invalid' });
    now += 1;
    expect(
      later.receive(
        replace(messages[6], {
          revision: 8,
          controlSequence: 43,
          atRoomTimeMs: now,
        }),
      ),
    ).toMatchObject({ accepted: true, status: 'message', message: { revision: 8 } });
  });

  it('requires current+1, the exact media binding, and an empty candidate slot', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 13_200,
    });
    receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    expect(
      receiver.receive(
        replace(messages[6], { revision: 9, controlSequence: 60, atRoomTimeMs: 13_100 }),
      ),
    ).toMatchObject({ accepted: false, reason: 'unknown-binding' });
    expect(
      receiver.receive(
        replace(messages[6], {
          revision: 8,
          controlSequence: 61,
          sourceIdentity: 'sha256:wrong-source',
          atRoomTimeMs: 13_100,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'unknown-binding' });

    const conflicting = receiver.stageMedia({
      run: { queueItemId: 'queue-item-other', runId: 'run-other', revision: 8 },
      sourceIdentity: 'sha256:other-source',
      transferSessionId: null,
    });
    expect(
      receiver.receive(
        replace(messages[6], { revision: 8, controlSequence: 62, atRoomTimeMs: 13_100 }),
      ),
    ).toMatchObject({ accepted: false, reason: 'unknown-binding' });
    receiver.retireMedia(conflicting);

    expect(
      receiver.receive(
        replace(messages[6], { revision: 9, controlSequence: 63, atRoomTimeMs: 13_100 }),
      ),
    ).toMatchObject({ accepted: true, status: 'message', message: { revision: 9 } });
  });

  it('atomically admits an exact-next rendezvous ARM and preserves exact retry leases', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });

    const first = receiver.receive(
      replace(messages[2], {
        revision: 8,
        rendezvousId: 'rendezvous-successor',
        controlSequence: 43,
      }),
    );
    expect(first).toMatchObject({
      accepted: true,
      status: 'message',
      message: {
        kind: 'rendezvous-arm',
        revision: 8,
        rendezvousId: 'rendezvous-successor',
      },
    });
    if (!first.accepted || first.status !== 'message' || !first.attemptLease) {
      throw new Error('Expected an atomically admitted rendezvous successor');
    }
    expect(receiver.lastControlSequence()).toBe(43);

    const retry = receiver.receive(
      replace(messages[2], {
        revision: 8,
        rendezvousId: 'rendezvous-successor',
        controlSequence: 44,
      }),
    );
    if (!retry.accepted || retry.status !== 'message' || !retry.attemptLease) {
      throw new Error('Expected an exact rendezvous successor retry');
    }
    expect(retry.stateLease).toBe(first.stateLease);
    expect(retry.attemptLease).toBe(first.attemptLease);
    expect(receiver.lastControlSequence()).toBe(44);
    expect(
      receiver.receive(
        replace(messages[2], {
          revision: 8,
          rendezvousId: 'rendezvous-successor',
          controlSequence: 44,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'replayed-sequence' });

    receiver.commitAttempt(first.attemptLease);
    receiver.commitMedia(first.stateLease);
  });

  it('admits PREPARE as state-only authority, then ARM attaches only its exact attempt', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });

    const prepared = receiver.receive(replace(messages[11], { controlSequence: 60 }));
    expect(prepared).toMatchObject({
      accepted: true,
      status: 'message',
      message: { kind: 'file-playback-prepare', revision: 8, expectedRevision: 7 },
      attemptLease: null,
    });
    if (!prepared.accepted || prepared.status !== 'message') {
      throw new Error('Expected an atomically admitted PREPARE successor');
    }

    const armed = receiver.receive(
      replace(messages[2], {
        controlSequence: 61,
        revision: 8,
        rendezvousId: 'rendezvous-prepared',
      }),
    );
    expect(armed).toMatchObject({
      accepted: true,
      status: 'message',
      message: { kind: 'rendezvous-arm', revision: 8, rendezvousId: 'rendezvous-prepared' },
    });
    if (!armed.accepted || armed.status !== 'message' || !armed.attemptLease) {
      throw new Error('Expected ARM to attach an attempt to PREPARE');
    }
    expect(armed.stateLease).toBe(prepared.stateLease);

    receiver.commitAttempt(armed.attemptLease);
    receiver.commitMedia(prepared.stateLease);
  });

  it('does not consume successor ARM authority for replay, time, or binding failures', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    expect(receiver.receive(record(messages[0]))).toMatchObject({ accepted: true });

    expect(
      receiver.receive(
        replace(messages[2], {
          revision: 8,
          rendezvousId: 'rendezvous-replayed',
          controlSequence: 41,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'replayed-sequence' });
    expect(
      receiver.receive(
        replace(messages[2], {
          revision: 8,
          rendezvousId: 'rendezvous-late',
          controlSequence: 42,
          startAtRoomTimeMs: 20_000,
          finalizeByRoomTimeMs: 19_900,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'temporal-invalid' });
    expect(
      receiver.receive(
        replace(messages[2], {
          revision: 8,
          sourceIdentity: 'sha256:wrong-source',
          rendezvousId: 'rendezvous-wrong-source',
          controlSequence: 43,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'unknown-binding' });
    expect(
      receiver.receive(
        replace(messages[2], {
          revision: 8,
          runId: 'run-wrong',
          rendezvousId: 'rendezvous-wrong-run',
          controlSequence: 44,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'unknown-binding' });
    expect(
      receiver.receive(
        replace(messages[2], {
          revision: 8,
          transferSessionId: 'transfer-session-wrong',
          rendezvousId: 'rendezvous-wrong-transfer',
          controlSequence: 45,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'unknown-binding' });
    expect(
      receiver.receive(
        replace(messages[2], {
          revision: 9,
          rendezvousId: 'rendezvous-wrong-revision',
          controlSequence: 46,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'unknown-binding' });
    expect(receiver.lastControlSequence()).toBe(41);

    expect(
      receiver.receive(
        replace(messages[2], {
          revision: 8,
          rendezvousId: 'rendezvous-valid',
          controlSequence: 47,
        }),
      ),
    ).toMatchObject({
      accepted: true,
      status: 'message',
      message: { revision: 8, rendezvousId: 'rendezvous-valid' },
    });
  });

  it('stale-drops only the exact retired successor attempt and never resurrects its state', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    const retiredState = receiver.stageMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 8 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    receiver.stageAttempt(retiredState, 'rendezvous-retired-successor');
    receiver.retireMedia(retiredState);

    expect(
      receiver.receive(
        replace(messages[2], {
          revision: 8,
          rendezvousId: 'rendezvous-retired-successor',
          controlSequence: 43,
        }),
      ),
    ).toEqual({
      accepted: true,
      status: 'stale',
      scope: 'attempt',
      controlSequence: 43,
    });
    expect(
      receiver.receive(
        replace(messages[2], {
          revision: 8,
          rendezvousId: 'rendezvous-resurrection',
          controlSequence: 44,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'unknown-binding' });
    expect(receiver.lastControlSequence()).toBe(43);

    expect(
      receiver.receive(
        replace(messages[2], {
          revision: 9,
          rendezvousId: 'rendezvous-after-retirement',
          controlSequence: 45,
        }),
      ),
    ).toMatchObject({
      accepted: true,
      status: 'message',
      message: { revision: 9, rendezvousId: 'rendezvous-after-retirement' },
    });
  });

  it('prevents a re-entrant older successor ARM from overwriting newer inner authority', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });

    const reentry: { result: FilePlaybackWireReceiverResult | null } = { result: null };
    let reentered = false;
    const outer = new Proxy(
      replace(messages[2], {
        revision: 8,
        rendezvousId: 'rendezvous-outer',
        controlSequence: 42,
      }),
      {
        ownKeys(target) {
          if (!reentered) {
            reentered = true;
            reentry.result = receiver.receive(
              replace(messages[2], {
                revision: 8,
                rendezvousId: 'rendezvous-inner',
                controlSequence: 43,
              }),
            );
          }
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(receiver.receive(outer)).toMatchObject({
      accepted: false,
      reason: 'replayed-sequence',
    });
    const inner = reentry.result;
    if (!inner?.accepted || inner.status !== 'message' || !inner.attemptLease) {
      throw new Error('Expected the newer inner successor admission');
    }
    const retry = receiver.receive(
      replace(messages[2], {
        revision: 8,
        rendezvousId: 'rendezvous-inner',
        controlSequence: 44,
      }),
    );
    if (!retry.accepted || retry.status !== 'message' || !retry.attemptLease) {
      throw new Error('Expected the inner successor authority to remain active');
    }
    expect(retry.stateLease).toBe(inner.stateLease);
    expect(retry.attemptLease).toBe(inner.attemptLease);
    expect(receiver.lastControlSequence()).toBe(44);
  });

  it('auto-admits a first-play ARM attempt on an active candidate state', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    receiver.bootstrapStopped(6);
    const candidate = receiver.stageMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });

    expect(receiver.receive(record(messages[2]))).toMatchObject({
      accepted: true,
      status: 'message',
      stateLease: candidate,
      message: { kind: 'rendezvous-arm', rendezvousId: 'rendezvous-7' },
    });
  });

  it('auto-admits same-state recovery while preserving the current attempt', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    const state = receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    const current = receiver.stageAttempt(state, 'rendezvous-current');
    receiver.commitAttempt(current);
    const recovery = receiver.receive(
      replace(messages[2], { rendezvousId: 'rendezvous-recovery', controlSequence: 43 }),
    );
    expect(recovery).toMatchObject({
      accepted: true,
      status: 'message',
      stateLease: state,
      message: { rendezvousId: 'rendezvous-recovery' },
    });
    expect(() => receiver.stageAttempt(state, 'rendezvous-third')).toThrow(/candidate/u);
    expect(
      receiver.receive(
        replace(messages[10], {
          rendezvousId: 'rendezvous-current',
          controlSequence: 44,
          observedAtRoomTimeMs: 11_800,
          leaseUntilRoomTimeMs: 16_800,
        }),
      ),
    ).toMatchObject({
      accepted: true,
      status: 'message',
      stateLease: state,
      attemptLease: current,
    });
  });

  it('does not consume a remote ARM slot for replayed or temporal-invalid frames', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    expect(receiver.receive(record(messages[0]))).toMatchObject({ accepted: true });
    expect(receiver.receive(replace(messages[2], { controlSequence: 41 }))).toMatchObject({
      accepted: false,
      reason: 'replayed-sequence',
    });
    expect(
      receiver.receive(
        replace(messages[2], {
          controlSequence: 42,
          startAtRoomTimeMs: 20_000,
          finalizeByRoomTimeMs: 19_900,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'temporal-invalid' });
    expect(receiver.receive(replace(messages[2], { controlSequence: 43 }))).toMatchObject({
      accepted: true,
      status: 'message',
    });
  });

  it('rejects a conflicting ARM candidate without consuming the available slot', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    const state = receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    const existing = receiver.stageAttempt(state, 'rendezvous-existing');
    expect(
      receiver.receive(
        replace(messages[2], { rendezvousId: 'rendezvous-remote', controlSequence: 43 }),
      ),
    ).toMatchObject({ accepted: false, reason: 'unknown-binding' });
    receiver.retireAttempt(existing);
    expect(
      receiver.receive(
        replace(messages[2], { rendezvousId: 'rendezvous-remote', controlSequence: 44 }),
      ),
    ).toMatchObject({ accepted: true, status: 'message' });
  });

  it('rejects current ARM reuse and stale-drops only the exact retired attempt', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    const state = receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    const current = receiver.stageAttempt(state, 'rendezvous-7');
    receiver.commitAttempt(current);
    expect(receiver.receive(record(messages[2]))).toMatchObject({
      accepted: false,
      reason: 'unknown-binding',
    });
    receiver.retireAttempt(current);
    expect(receiver.receive(replace(messages[2], { controlSequence: 44 }))).toEqual({
      accepted: true,
      status: 'stale',
      scope: 'attempt',
      controlSequence: 44,
    });
  });

  it('never auto-admits unknown attempts for receipts, finalize, health, or cancel', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    for (const template of [messages[3], messages[4], messages[5], messages[8], messages[10]]) {
      expect(receiver.receive(record(template))).toMatchObject({
        accepted: false,
        reason: 'unknown-binding',
      });
    }
    expect(receiver.receive(replace(messages[2], { controlSequence: 60 }))).toMatchObject({
      accepted: true,
      status: 'message',
    });
  });

  it('validates stale replay and temporal bounds before advancing the watermark', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    const state = receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    const retired = receiver.stageAttempt(state, 'rendezvous-7');
    receiver.retireAttempt(retired);
    expect(
      receiver.receive(
        replace(messages[2], {
          controlSequence: 43,
          startAtRoomTimeMs: 20_000,
          finalizeByRoomTimeMs: 19_900,
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'temporal-invalid' });
    expect(receiver.lastControlSequence()).toBe(0);
    expect(receiver.receive(replace(messages[2], { controlSequence: 44 }))).toMatchObject({
      accepted: true,
      status: 'stale',
    });
    expect(receiver.lastControlSequence()).toBe(44);
    expect(receiver.receive(replace(messages[2], { controlSequence: 44 }))).toMatchObject({
      accepted: false,
      reason: 'replayed-sequence',
    });
    expect(receiver.lastControlSequence()).toBe(44);
  });

  it('does not retype a pre-staged media successor when a stop frame targets it', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 13_200,
    });
    receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    const successor = receiver.stageMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 8 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    expect(
      receiver.receive(
        replace(messages[9], { revision: 8, controlSequence: 60, atRoomTimeMs: 13_100 }),
      ),
    ).toMatchObject({ accepted: false, reason: 'unknown-binding' });
    expect(
      receiver.receive(
        replace(messages[6], { revision: 8, controlSequence: 61, atRoomTimeMs: 13_100 }),
      ),
    ).toMatchObject({ accepted: true, status: 'message', stateLease: successor });
  });

  it('prevents a re-entrant older Proxy frame from overwriting a newer inner commit', () => {
    const receiver = new FilePlaybackWireReceiver({
      sessionId: 'app-session-1',
      connectionId: 'connection-1',
      senderParticipantId: 'participant-guest-1',
      recipientParticipantId: 'participant-host',
      nowRoomTimeMs: () => 11_800,
    });
    const current = receiver.bootstrapCurrentMedia({
      run: { queueItemId: 'queue-item-1', runId: 'run-7', revision: 7 },
      sourceIdentity: 'sha256:source-1',
      transferSessionId: 'transfer-session-9',
    });
    receiver.stageAttempt(current, 'rendezvous-7');

    let reentered = false;
    const outer = new Proxy(record(messages[1]), {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          expect(receiver.receive(record(messages[2]))).toMatchObject({
            accepted: true,
            status: 'message',
            message: { controlSequence: 43 },
          });
        }
        return Reflect.ownKeys(target);
      },
    });

    expect(receiver.receive(outer)).toMatchObject({
      accepted: false,
      reason: 'replayed-sequence',
    });
    expect(receiver.lastControlSequence()).toBe(43);
  });

  it('rejects native objects and non-plain top-level inputs', () => {
    const nativeTopLevel = Object.assign(new Blob(), record());
    const nativeField = replace(messages[0], { sourceIdentity: new Blob(['native']) });
    const array = Object.assign([], record());

    expect(parseFilePlaybackWireMessage(nativeTopLevel)).toBeNull();
    expect(parseFilePlaybackWireMessage(nativeField)).toBeNull();
    expect(parseFilePlaybackWireMessage(array)).toBeNull();
    expect(parseFilePlaybackWireMessage(new Date())).toBeNull();
  });

  it('throws when a local factory input is not wire-valid', () => {
    expect(() =>
      createFilePlaybackWireMessage(
        replace(messages[0], { controlSequence: 0 }) as unknown as FilePlaybackWireMessage,
      ),
    ).toThrow(TypeError);
  });
});

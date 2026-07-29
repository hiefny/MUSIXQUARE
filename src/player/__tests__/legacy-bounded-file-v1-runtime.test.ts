import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemId } from '../../types/index.ts';
import type { FilePlaybackR2RecordPublication } from '../file-playback-r2-whole-blob-publisher.ts';
import type { FilePlaybackCutoverSource } from '../file-playback-source.ts';
import type { LegacyBoundedFilePortContract } from '../legacy-bounded-file-port-contract.ts';
import type {
  LegacyBoundedFileV1BridgeContract,
  LegacyBoundedV1BridgeSnapshot,
  LegacyBoundedV1ControlOutcome,
  LegacyBoundedV1PrepareOutcome,
} from '../legacy-bounded-file-v1-bridge.ts';
import type {
  LegacyBoundedFileV1EncodedSourceBinding,
  LegacyBoundedFileV1SourceAdapter,
  LegacyBoundedFileV1SourceOpenOutcome,
} from '../legacy-bounded-file-v1-source.ts';
import {
  createLegacyBoundedFileV1Runtime,
  type LegacyBoundedFileV1DescriptorFrame,
  type LegacyBoundedFileV1RuntimeSeams,
  type LegacyBoundedFileV1WireFrame,
} from '../legacy-bounded-file-v1-runtime.ts';

const QID_A = '11111111-1111-4111-8111-111111111111' as QueueItemId;
const QID_B = '22222222-2222-4222-8222-222222222222' as QueueItemId;

function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function bridgeSnapshot(
  overrides: Partial<LegacyBoundedV1BridgeSnapshot> = {},
): LegacyBoundedV1BridgeSnapshot {
  return freezeRecord({
    schemaVersion: 1,
    scope: null,
    phase: 'idle',
    positionSeconds: 0,
    durationSeconds: null,
    anchorRoomTimeMs: null,
    pending: null,
    renderer: freezeRecord({ hasCurrent: false, hasCandidate: false }),
    fallbackRequired: false,
    ...overrides,
  });
}

class FakeBridge implements LegacyBoundedFileV1BridgeContract {
  snapshotValue = bridgeSnapshot();
  readonly controls: string[] = [];
  readonly playingInputs: {
    readonly positionSeconds: number;
    readonly startAtRoomTimeMs: number;
  }[] = [];
  playingStartFloorMs: number | null = null;
  prepareDeferred: ReturnType<typeof deferred<LegacyBoundedV1PrepareOutcome>> | null = null;
  retireDeferred: ReturnType<typeof deferred<LegacyBoundedV1ControlOutcome>> | null = null;
  stopDeferred: ReturnType<typeof deferred<void>> | null = null;
  prepareFailure: 'fallback' | Error | null = null;
  controlFailure: Error | null = null;
  retired = 0;
  readonly preparedQueueItemIds: QueueItemId[] = [];

  snapshot(): LegacyBoundedV1BridgeSnapshot {
    return this.snapshotValue;
  }

  async prepare(
    input: Parameters<LegacyBoundedFileV1BridgeContract['prepare']>[0],
  ): Promise<LegacyBoundedV1PrepareOutcome> {
    this.preparedQueueItemIds.push(input.scope.queueItemId);
    if (this.prepareDeferred) return this.prepareDeferred.promise;
    if (this.prepareFailure === 'fallback') {
      return freezeRecord({
        status: 'fallback',
        reason: 'unsupported-source' as const,
        snapshot: this.snapshotValue,
      });
    }
    if (this.prepareFailure instanceof Error) {
      return freezeRecord({
        status: 'failed',
        error: this.prepareFailure,
        snapshot: this.snapshotValue,
      });
    }
    const opened = await input.open(new AbortController().signal);
    if (!opened) {
      return freezeRecord({
        status: 'fallback',
        reason: 'unsupported-source' as const,
        snapshot: this.snapshotValue,
      });
    }
    this.snapshotValue = bridgeSnapshot({
      scope: input.scope,
      phase: 'stopped',
      durationSeconds: 120,
      renderer: freezeRecord({ hasCurrent: false, hasCandidate: true }),
    });
    return freezeRecord({ status: 'ready', snapshot: this.snapshotValue });
  }

  play(
    input: Parameters<LegacyBoundedFileV1BridgeContract['play']>[0],
  ): Promise<LegacyBoundedV1ControlOutcome> {
    if (this.controlFailure) throw this.controlFailure;
    this.controls.push('play');
    this.playingInputs.push({
      positionSeconds: input.positionSeconds,
      startAtRoomTimeMs: input.startAtRoomTimeMs,
    });
    if (
      this.playingStartFloorMs !== null &&
      input.startAtRoomTimeMs <= this.playingStartFloorMs
    ) {
      throw new Error('playing control rendezvous must remain in the future');
    }
    this.snapshotValue = bridgeSnapshot({
      scope: input.scope,
      phase: 'playing',
      positionSeconds: input.positionSeconds,
      durationSeconds: 120,
      anchorRoomTimeMs: input.startAtRoomTimeMs,
      renderer: freezeRecord({ hasCurrent: true, hasCandidate: false }),
    });
    return Promise.resolve(freezeRecord({ status: 'applied', snapshot: this.snapshotValue }));
  }

  schedulePlay(
    input: Parameters<LegacyBoundedFileV1BridgeContract['schedulePlay']>[0],
  ): ReturnType<LegacyBoundedFileV1BridgeContract['schedulePlay']> {
    const settled = this.play(input);
    return Promise.resolve(
      freezeRecord({
        status: 'scheduled' as const,
        startAtRoomTimeMs: input.startAtRoomTimeMs,
        snapshot: this.snapshotValue,
        settled,
      }),
    );
  }

  pause(
    input: Parameters<LegacyBoundedFileV1BridgeContract['pause']>[0],
  ): Promise<LegacyBoundedV1ControlOutcome> {
    this.controls.push('pause');
    this.snapshotValue = bridgeSnapshot({
      scope: input.scope,
      phase: 'paused',
      positionSeconds: input.positionSeconds,
      durationSeconds: 120,
      renderer: freezeRecord({ hasCurrent: true, hasCandidate: false }),
    });
    return Promise.resolve(freezeRecord({ status: 'applied', snapshot: this.snapshotValue }));
  }

  seekPaused(
    input: Parameters<LegacyBoundedFileV1BridgeContract['seekPaused']>[0],
  ): Promise<LegacyBoundedV1ControlOutcome> {
    this.controls.push('seek-paused');
    return this.pause(input);
  }

  seekPlaying(
    input: Parameters<LegacyBoundedFileV1BridgeContract['seekPlaying']>[0],
  ): Promise<LegacyBoundedV1ControlOutcome> {
    this.controls.push('seek-playing');
    return this.play(input);
  }

  scheduleSeekPlaying(
    input: Parameters<LegacyBoundedFileV1BridgeContract['scheduleSeekPlaying']>[0],
  ): ReturnType<LegacyBoundedFileV1BridgeContract['scheduleSeekPlaying']> {
    const settled = this.seekPlaying(input);
    return Promise.resolve(
      freezeRecord({
        status: 'scheduled' as const,
        startAtRoomTimeMs: input.startAtRoomTimeMs,
        snapshot: this.snapshotValue,
        settled,
      }),
    );
  }

  async stop(
    input: Parameters<LegacyBoundedFileV1BridgeContract['stop']>[0],
  ): Promise<LegacyBoundedV1ControlOutcome> {
    this.controls.push('stop');
    if (this.stopDeferred) await this.stopDeferred.promise;
    this.snapshotValue = bridgeSnapshot({
      scope: input.scope,
      phase: 'stopped',
      positionSeconds: input.positionSeconds,
      durationSeconds: 120,
      renderer: freezeRecord({ hasCurrent: true, hasCandidate: false }),
    });
    return freezeRecord({ status: 'applied', snapshot: this.snapshotValue });
  }

  async retire(): Promise<LegacyBoundedV1ControlOutcome> {
    this.retired += 1;
    if (this.retireDeferred) {
      const deferredRetirement = this.retireDeferred;
      this.retireDeferred = null;
      await deferredRetirement.promise;
    }
    this.snapshotValue = bridgeSnapshot();
    return freezeRecord({ status: 'applied', snapshot: this.snapshotValue });
  }
}

interface TestConnection {
  readonly id: string;
}

interface TestHarness {
  readonly bridge: FakeBridge;
  readonly frames: {
    readonly connection: TestConnection;
    readonly frame: Readonly<LegacyBoundedFileV1WireFrame>;
  }[];
  readonly fallbacks: {
    readonly connection: TestConnection;
    readonly reason: string;
  }[];
  readonly failures: unknown[];
  readonly publisher: {
    readonly publishRecordSet: ReturnType<typeof vi.fn>;
    readonly cancelPendingRecordSet: ReturnType<typeof vi.fn>;
    readonly removeQueueItem: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  };
  readonly cancelled: QueueItemId[];
  readonly removed: QueueItemId[];
  readonly providerRetired: unknown[];
  readonly runtime: ReturnType<typeof createLegacyBoundedFileV1Runtime<TestConnection>>;
  publicationReject(error: unknown): void;
  useRejectedPublication(): void;
  setSourceFallback(value: boolean): void;
}

function publication(
  queueItemId = QID_A,
  sourceIdentity = 'source-a',
  transferSessionId = 'binding-a',
  applicationSessionId = 'room-epoch-a',
): Readonly<FilePlaybackR2RecordPublication> {
  return freezeRecord({
    schemaVersion: 1,
    queueItemId,
    sourceIdentity,
    transferSessionId,
    applicationSessionId,
    storageRoomId: '100001',
    setId: '33333333-3333-4333-8333-333333333333',
    encodedSize: 1,
    recordSize: 1,
    recordCount: 1,
    cryptoSecretDescriptor: freezeRecord({
      formatVersion: 2,
      objectId: '44444444-4444-4444-8444-444444444444',
      plaintextSize: 1,
      recordSize: 1,
      recordCount: 1,
      noncePrefixB64: 'AAAAAA==',
      keyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    }),
    records: Object.freeze([
      freezeRecord({
        index: 0,
        objectId: '55555555-5555-4555-8555-555555555555',
        plaintextSize: 1,
        encryptedSize: 17,
      }),
    ]),
    name: 'track.flac',
    mime: 'audio/flac',
    expiresAtEpochMs: Date.now() + 60_000,
  });
}

function createHarness(
  options: {
    gate?: boolean;
    fallbackAcknowledgement?: Promise<void>;
    nowRoomTimeMs?: () => number;
  } = {},
): TestHarness {
  const bridge = new FakeBridge();
  const frames: TestHarness['frames'] = [];
  const fallbacks: TestHarness['fallbacks'] = [];
  const failures: unknown[] = [];
  const cancelled: QueueItemId[] = [];
  const removed: QueueItemId[] = [];
  const providerRetired: unknown[] = [];
  let identifier = 0;
  let sourceFallback = false;
  let rejectedPublication: ReturnType<
    typeof deferred<Readonly<FilePlaybackR2RecordPublication>>
  > | null = null;
  let rejectNextPublication = false;
  const port = {
    clear: vi.fn(() => Promise.resolve()),
  } as unknown as LegacyBoundedFilePortContract;
  const registry = {
    register(value: unknown) {
      const record = value as {
        readonly scope: LegacyBoundedFileV1DescriptorFrame['scope'];
        readonly descriptorId: string;
        readonly descriptorVersion: 1;
      };
      return freezeRecord({
        scope: record.scope,
        descriptorId: record.descriptorId,
        descriptorVersion: record.descriptorVersion,
      });
    },
    retire: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
  };
  const provider = {
    open: vi.fn(() => Promise.reject(new Error('unused provider open'))),
    retire: vi.fn((scope: unknown) => {
      providerRetired.push(scope);
      return Promise.resolve();
    }),
    clear: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
  };
  const publisher = {
    publishRecordSet: vi.fn(
      (
        source: Readonly<{
          queueItemId: QueueItemId;
          sourceIdentity: string;
          transferSessionId: string;
        }>,
        publishOptions: Readonly<{ applicationSessionId: string }>,
      ) => {
        if (rejectNextPublication) {
          rejectNextPublication = false;
          rejectedPublication = deferred();
          return rejectedPublication.promise;
        }
        return Promise.resolve(
          publication(
            source.queueItemId,
            source.sourceIdentity,
            source.transferSessionId,
            publishOptions.applicationSessionId,
          ),
        );
      },
    ),
    cancelPendingRecordSet: vi.fn((queueItemId: QueueItemId) => {
      cancelled.push(queueItemId);
      return Promise.resolve(true);
    }),
    removeQueueItem: vi.fn((queueItemId: QueueItemId) => {
      removed.push(queueItemId);
      return Promise.resolve(true);
    }),
    close: vi.fn(() => Promise.resolve()),
  };
  const binding = (sourceIdentity: string): Readonly<LegacyBoundedFileV1EncodedSourceBinding> =>
    freezeRecord({
      sourceIdentity,
      open: () => Promise.reject(new Error('unused encoded source open')),
    });
  const sourceAdapter: Readonly<LegacyBoundedFileV1SourceAdapter> = freezeRecord({
    open: (): Promise<LegacyBoundedFileV1SourceOpenOutcome> =>
      Promise.resolve(
        sourceFallback
          ? freezeRecord({
              status: 'fallback' as const,
              reason: 'unsupported-source' as const,
            })
          : freezeRecord({
              status: 'opened' as const,
              sourceIdentity: 'source-a',
              opened: freezeRecord({
                source: Object.freeze({}) as FilePlaybackCutoverSource,
                destination: Object.freeze({}) as AudioNode,
              }),
            }),
      ),
  });
  const seams: LegacyBoundedFileV1RuntimeSeams = {
    gateEnabled: () => options.gate ?? true,
    getAudioGraph: () =>
      Promise.resolve(
        freezeRecord({
          audioContext: freezeRecord({ currentTime: 1 }) as unknown as AudioContext,
          destination: Object.freeze({}) as AudioNode,
        }),
      ),
    createPort: () => port,
    createBridge: () => bridge,
    createPublisher: () => publisher,
    createRegistry: () => registry,
    createProvider: () => provider,
    createBlobBinding: (_blob, sourceIdentity) => binding(sourceIdentity),
    createR2Binding: (_provider, scope) => binding(scope.sourceIdentity),
    createSourceAdapter: () => sourceAdapter,
    createIdentifier: (purpose) => `${purpose}:id-${++identifier}`,
  };
  const runtime = createLegacyBoundedFileV1Runtime<TestConnection>({
    nowRoomTimeMs: options.nowRoomTimeMs ?? (() => 1_000),
    emitFrame: (connection, frame) => {
      frames.push({ connection, frame });
      return true;
    },
    onLegacyFallback: (connection, commit) => {
      fallbacks.push({ connection, reason: commit.reason });
      return options.fallbackAcknowledgement;
    },
    onFailure: ({ error }) => failures.push(error),
    capabilityTimeoutMs: 20,
    descriptorResultTimeoutMs: 40,
    seamsForTests: seams,
  });
  return {
    bridge,
    frames,
    fallbacks,
    failures,
    publisher,
    cancelled,
    removed,
    providerRetired,
    runtime,
    publicationReject(error: unknown) {
      rejectedPublication?.reject(error);
    },
    useRejectedPublication() {
      rejectNextPublication = true;
    },
    setSourceFallback(value: boolean) {
      sourceFallback = value;
    },
  };
}

function hostPrepareInput(queueItemId = QID_A, legacySessionId = queueItemId === QID_A ? 1 : 2) {
  return freezeRecord({
    blob: new Blob([new Uint8Array([1])], { type: 'audio/flac' }),
    name: 'track.flac',
    mime: 'audio/flac',
    queueItemId,
    sourceIdentity: queueItemId === QID_A ? 'source-a' : 'source-b',
    transferSessionId: queueItemId === QID_A ? 'binding-a' : 'binding-b',
    legacySessionId,
  });
}

function descriptorFrame(
  queueItemId = QID_A,
  legacySessionId = 1,
): Readonly<LegacyBoundedFileV1DescriptorFrame> {
  const sourceIdentity = queueItemId === QID_A ? 'source-a' : 'source-b';
  const transferSessionId = queueItemId === QID_A ? 'binding-a' : 'binding-b';
  return freezeRecord({
    type: 'file-r2-record-descriptor',
    bridgeVersion: 1,
    legacySessionId,
    purpose: 'current',
    scope: freezeRecord({
      roomEpoch: 'room-epoch-a',
      bridgeGeneration: 'peer-generation-a',
      bindingId: transferSessionId,
      queueItemId,
      sourceIdentity,
    }),
    descriptorId: `descriptor-${legacySessionId}`,
    descriptorVersion: 1,
    publication: publication(queueItemId, sourceIdentity, transferSessionId, 'room-epoch-a'),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LegacyBoundedFileV1Runtime', () => {
  it('bypasses every PRO room lifecycle without constructing product resources', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });

    await expect(
      harness.runtime.beginHostRoom({
        kind: 'pro',
        roomEpoch: '',
        storageRoomId: '',
        roomToken: Object.freeze({}),
      }),
    ).resolves.toEqual({ status: 'bypass' });
    await expect(harness.runtime.prepareHost(hostPrepareInput())).resolves.toEqual({
      status: 'bypass',
    });
    expect(await harness.runtime.offerHostCurrent(connection)).toEqual({ status: 'bypass' });
    expect(harness.runtime.announceGuestCapability(connection)).toBe(false);
    expect(harness.runtime.snapshot()).toMatchObject({
      active: false,
      role: 'bypass',
      roomKind: 'pro',
      current: null,
    });
  });

  it('prepares the host locally, negotiates an exact descriptor, and accepts ready', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'guest-a' });
    expect(harness.runtime.offerHostCurrent).toHaveLength(1);
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });

    await expect(harness.runtime.prepareHost(hostPrepareInput())).resolves.toEqual({
      status: 'ready',
      durationSeconds: 120,
    });
    expect(
      harness.runtime.adoptHostCapability(connection, {
        type: 'file-bounded-v1-capability',
        bridgeVersion: 1,
        descriptorVersion: 1,
      }),
    ).toBe('accepted');
    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'descriptor-sent',
    });
    const descriptor = harness.frames.at(-1)?.frame;
    expect(descriptor?.type).toBe('file-r2-record-descriptor');
    if (!descriptor || descriptor.type !== 'file-r2-record-descriptor') {
      throw new Error('descriptor was not emitted');
    }
    expect(
      harness.runtime.adoptHostResult(connection, {
        type: 'file-r2-record-result',
        bridgeVersion: 1,
        legacySessionId: descriptor.legacySessionId,
        scope: descriptor.scope,
        descriptorId: descriptor.descriptorId,
        descriptorVersion: 1,
        outcome: 'ready',
      }),
    ).toBe('ready');
    expect(harness.fallbacks).toHaveLength(0);
    expect(harness.runtime.hasReadyRenderer(QID_A, 1)).toBe(true);
    expect(harness.runtime.durationSeconds()).toBe(120);
  });

  it('refreshes publication authority for each unpinned peer while preserving an existing frame', async () => {
    const harness = createHarness();
    const first = freezeRecord({ id: 'guest-a' });
    const reconnect = freezeRecord({ id: 'guest-a-reconnect' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());
    for (const connection of [first, reconnect]) {
      expect(
        harness.runtime.adoptHostCapability(connection, {
          type: 'file-bounded-v1-capability',
          bridgeVersion: 1,
          descriptorVersion: 1,
        }),
      ).toBe('accepted');
    }

    const callsAfterPrepare = harness.publisher.publishRecordSet.mock.calls.length;
    await expect(harness.runtime.offerHostCurrent(first)).resolves.toEqual({
      status: 'descriptor-sent',
    });
    expect(harness.publisher.publishRecordSet).toHaveBeenCalledTimes(callsAfterPrepare + 1);

    // The exact connection keeps its accepted descriptor instead of being
    // rotated underneath an active reader.
    await harness.runtime.offerHostCurrent(first);
    expect(harness.publisher.publishRecordSet).toHaveBeenCalledTimes(callsAfterPrepare + 1);

    await expect(harness.runtime.offerHostCurrent(reconnect)).resolves.toEqual({
      status: 'descriptor-sent',
    });
    expect(harness.publisher.publishRecordSet).toHaveBeenCalledTimes(callsAfterPrepare + 2);
  });

  it('keeps an exact host retirement visible and drains it before successor preparation', async () => {
    const harness = createHarness();
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    const retirement = deferred<LegacyBoundedV1ControlOutcome>();
    harness.bridge.retireDeferred = retirement;

    const retiring = harness.runtime.retireCurrent(QID_A, 1);
    expect(harness.runtime.snapshot()).toMatchObject({
      current: { queueItemId: QID_A, legacySessionId: 1, state: 'retiring' },
    });
    const successor = harness.runtime.prepareHost(hostPrepareInput(QID_B, 2));
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.bridge.preparedQueueItemIds).toEqual([QID_A]);

    retirement.resolve(
      freezeRecord({
        status: 'applied',
        snapshot: bridgeSnapshot(),
      }),
    );
    await expect(retiring).resolves.toBe(true);
    await expect(successor).resolves.toEqual({ status: 'ready', durationSeconds: 120 });
    expect(harness.bridge.preparedQueueItemIds).toEqual([QID_A, QID_B]);
    expect(harness.runtime.snapshot()).toMatchObject({
      current: { queueItemId: QID_B, legacySessionId: 2, state: 'ready' },
    });
  });

  it('does not revive a retiring host when its pending preparation completes', async () => {
    const harness = createHarness();
    const preparation = deferred<LegacyBoundedV1PrepareOutcome>();
    const retirement = deferred<LegacyBoundedV1ControlOutcome>();
    harness.bridge.prepareDeferred = preparation;
    harness.bridge.retireDeferred = retirement;
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });

    const preparing = harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    await vi.waitFor(() => {
      expect(harness.bridge.preparedQueueItemIds).toEqual([QID_A]);
    });
    const retiring = harness.runtime.retireCurrent(QID_A, 1);
    expect(harness.runtime.snapshot()).toMatchObject({
      current: { queueItemId: QID_A, legacySessionId: 1, state: 'retiring' },
    });

    preparation.resolve(
      freezeRecord({
        status: 'ready',
        snapshot: bridgeSnapshot({ durationSeconds: 120 }),
      }),
    );
    await expect(preparing).resolves.toEqual({ status: 'superseded' });
    expect(harness.runtime.snapshot()).toMatchObject({
      current: { queueItemId: QID_A, legacySessionId: 1, state: 'retiring' },
    });
    expect(harness.bridge.retired).toBe(1);

    retirement.resolve(
      freezeRecord({
        status: 'applied',
        snapshot: bridgeSnapshot(),
      }),
    );
    await expect(retiring).resolves.toBe(true);
    expect(harness.runtime.snapshot().current).toBeNull();
  });

  it('settles a pending exact offer when capability dispatches its descriptor', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'guest-a' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());

    const settlement = harness.runtime.offerHostCurrentSettled(connection, QID_A, 1);
    await Promise.resolve();
    expect(harness.frames).toHaveLength(0);
    expect(
      harness.runtime.adoptHostCapability(connection, {
        type: 'file-bounded-v1-capability',
        bridgeVersion: 1,
        descriptorVersion: 1,
      }),
    ).toBe('accepted');

    await expect(settlement).resolves.toEqual({ status: 'descriptor-sent' });
    expect(harness.frames.map(({ frame }) => frame.type)).toEqual(['file-r2-record-descriptor']);
  });

  it('settles a pending exact offer through the ledger capability timeout fallback', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const connection = freezeRecord({ id: 'legacy-guest' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());

    const settlement = harness.runtime.offerHostCurrentSettled(connection, QID_A, 1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(21);

    await expect(settlement).resolves.toEqual({ status: 'legacy-committed' });
    expect(harness.fallbacks).toEqual([{ connection, reason: 'capability-timeout' }]);
  });

  it('does not settle legacy delivery before its exact fallback acknowledgement', async () => {
    vi.useFakeTimers();
    const acknowledgement = deferred<void>();
    const harness = createHarness({ fallbackAcknowledgement: acknowledgement.promise });
    const connection = freezeRecord({ id: 'legacy-guest' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());

    let terminal = false;
    const settlement = harness.runtime.offerHostCurrentSettled(connection, QID_A, 1);
    void settlement.then(() => {
      terminal = true;
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(21);
    expect(harness.fallbacks).toEqual([{ connection, reason: 'capability-timeout' }]);
    expect(terminal).toBe(false);

    acknowledgement.resolve(undefined);
    await expect(settlement).resolves.toEqual({ status: 'legacy-committed' });
    expect(terminal).toBe(true);
  });

  it('reports a repeated exact offer as pending while its fallback acknowledgement is unresolved', async () => {
    vi.useFakeTimers();
    const acknowledgement = deferred<void>();
    const harness = createHarness({ fallbackAcknowledgement: acknowledgement.promise });
    const connection = freezeRecord({ id: 'legacy-guest-pending-repeat' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());

    const first = harness.runtime.offerHostCurrentSettled(connection, QID_A, 1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(21);
    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'pending',
    });

    acknowledgement.resolve(undefined);
    await expect(first).resolves.toEqual({ status: 'legacy-committed' });
  });

  it('settles a repeated exact offer after its cached fallback acknowledgement committed', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const connection = freezeRecord({ id: 'legacy-guest-repeat' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());

    const first = harness.runtime.offerHostCurrentSettled(connection, QID_A, 1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(21);
    await expect(first).resolves.toEqual({ status: 'legacy-committed' });

    await expect(
      harness.runtime.offerHostCurrentSettled(connection, QID_A, 1),
    ).resolves.toEqual({ status: 'legacy-committed' });
    expect(harness.fallbacks).toEqual([{ connection, reason: 'capability-timeout' }]);
  });

  it('fences a late fallback acknowledgement after its exact connection retires', async () => {
    vi.useFakeTimers();
    const acknowledgement = deferred<void>();
    const harness = createHarness({ fallbackAcknowledgement: acknowledgement.promise });
    const connection = freezeRecord({ id: 'retiring-legacy-guest' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());

    const settlement = harness.runtime.offerHostCurrentSettled(connection, QID_A, 1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(21);
    expect(harness.fallbacks).toEqual([{ connection, reason: 'capability-timeout' }]);

    await expect(harness.runtime.retireConnection(connection)).resolves.toBe(true);
    await expect(settlement).resolves.toEqual({ status: 'retired' });
    acknowledgement.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'retired',
    });
  });

  it('holds a publication-failure settled offer until its exact stable fallback is committed', async () => {
    const acknowledgement = deferred<void>();
    const harness = createHarness({ fallbackAcknowledgement: acknowledgement.promise });
    const connection = freezeRecord({ id: 'guest-r2-failure' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());
    harness.useRejectedPublication();

    let terminal = false;
    const settlement = harness.runtime.offerHostCurrentSettled(connection, QID_A, 1);
    void settlement.then(() => {
      terminal = true;
    });
    const failure = new Error('R2 unavailable');
    harness.publicationReject(failure);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.fallbacks).toEqual([{ connection, reason: 'publication-failed' }]);
    expect(terminal).toBe(false);

    acknowledgement.resolve(undefined);
    await expect(settlement).resolves.toEqual({ status: 'legacy-committed' });
  });

  it('retries a failed publication for a different unpinned peer', async () => {
    const harness = createHarness();
    const failedPeer = freezeRecord({ id: 'guest-failed' });
    const reconnect = freezeRecord({ id: 'guest-reconnect' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());
    harness.useRejectedPublication();
    const failed = harness.runtime.offerHostCurrent(failedPeer);
    const failure = new Error('R2 unavailable');
    harness.publicationReject(failure);
    await expect(failed).resolves.toEqual({ status: 'failed', error: failure });

    expect(
      harness.runtime.adoptHostCapability(reconnect, {
        type: 'file-bounded-v1-capability',
        bridgeVersion: 1,
        descriptorVersion: 1,
      }),
    ).toBe('accepted');
    await expect(harness.runtime.offerHostCurrent(reconnect)).resolves.toEqual({
      status: 'descriptor-sent',
    });
    expect(harness.fallbacks).toEqual([
      { connection: failedPeer, reason: 'publication-failed' },
    ]);
  });

  it('fails a settled offer when the exact stable V1 fallback acknowledgement rejects', async () => {
    vi.useFakeTimers();
    const failure = new Error('fallback dispatch failed');
    const acknowledgement = deferred<void>();
    const harness = createHarness({
      fallbackAcknowledgement: acknowledgement.promise,
    });
    const connection = freezeRecord({ id: 'legacy-guest' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());

    const settlement = harness.runtime.offerHostCurrentSettled(connection, QID_A, 1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(21);
    acknowledgement.reject(failure);

    await expect(settlement).resolves.toEqual({ status: 'failed', error: failure });
    expect(harness.failures).toContain(failure);

    await expect(
      harness.runtime.offerHostCurrentSettled(connection, QID_A, 1),
    ).resolves.toEqual({ status: 'failed', error: failure });
  });

  it('settles exact offer waiters on connection retirement and current replacement', async () => {
    const harness = createHarness();
    const retiredConnection = freezeRecord({ id: 'guest-retired' });
    const replacedConnection = freezeRecord({ id: 'guest-replaced' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));

    const retired = harness.runtime.offerHostCurrentSettled(retiredConnection, QID_A, 1);
    await Promise.resolve();
    await expect(harness.runtime.retireConnection(retiredConnection)).resolves.toBe(true);
    await expect(retired).resolves.toEqual({ status: 'retired' });
    expect(
      harness.runtime.adoptHostCapability(retiredConnection, {
        type: 'file-bounded-v1-capability',
        bridgeVersion: 1,
        descriptorVersion: 1,
      }),
    ).toBe('retired');
    await expect(harness.runtime.offerHostCurrent(retiredConnection)).resolves.toEqual({
      status: 'retired',
    });

    const replaced = harness.runtime.offerHostCurrentSettled(replacedConnection, QID_A, 1);
    await Promise.resolve();
    await harness.runtime.prepareHost(hostPrepareInput(QID_B, 2));
    await expect(replaced).resolves.toEqual({ status: 'superseded' });
  });

  it('settles a pending exact offer when its host room ends', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'guest-a' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());

    const settlement = harness.runtime.offerHostCurrentSettled(connection, QID_A, 1);
    await Promise.resolve();
    await harness.runtime.endRoom();

    await expect(settlement).resolves.toEqual({ status: 'retired' });
  });

  it('retains and retries exact publisher cleanup after a transient room-close failure', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const cleanupFailure = new Error('transient authenticated cleanup failure');
    harness.publisher.close
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValue(undefined);
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });

    await expect(harness.runtime.endRoom()).resolves.toBeUndefined();
    expect(harness.publisher.close).toHaveBeenCalledTimes(1);
    expect(harness.failures).toContain(cleanupFailure);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.publisher.close).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.publisher.close).toHaveBeenCalledTimes(2);
  });

  it('commits an unknown connection to legacy exactly once after capability timeout', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const connection = freezeRecord({ id: 'legacy-guest' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());

    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'pending',
    });
    await vi.advanceTimersByTimeAsync(21);
    expect(harness.fallbacks).toEqual([{ connection, reason: 'capability-timeout' }]);
    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'legacy-committed',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.fallbacks).toHaveLength(1);
  });

  it('keeps a timed-out connection on stable V1 across later playback generations', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const connection = freezeRecord({ id: 'legacy-guest' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'pending',
    });
    await vi.advanceTimersByTimeAsync(21);

    const descriptorCount = harness.frames.length;
    await harness.runtime.prepareHost(hostPrepareInput(QID_B, 2));
    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'legacy-committed',
    });
    expect(harness.frames).toHaveLength(descriptorCount);
    expect(harness.fallbacks).toEqual([
      { connection, reason: 'capability-timeout' },
      { connection, reason: 'capability-unavailable' },
    ]);
  });

  it('localizes publication failure and invokes per-connection fallback once', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'guest-a' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput());
    harness.useRejectedPublication();
    const offer = harness.runtime.offerHostCurrent(connection);
    const failure = new Error('R2 unavailable');
    harness.publicationReject(failure);

    await expect(offer).resolves.toEqual({ status: 'failed', error: failure });
    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'legacy-committed',
    });
    expect(harness.fallbacks).toEqual([{ connection, reason: 'publication-failed' }]);
  });

  it('retires an old host descriptor before a replacement can accept its late result', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'guest-a' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    harness.runtime.adoptHostCapability(connection, {
      type: 'file-bounded-v1-capability',
      bridgeVersion: 1,
      descriptorVersion: 1,
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A));
    await harness.runtime.offerHostCurrent(connection);
    const first = harness.frames.at(-1)?.frame;
    if (!first || first.type !== 'file-r2-record-descriptor') {
      throw new Error('first descriptor was not emitted');
    }

    await harness.runtime.prepareHost(hostPrepareInput(QID_B));
    expect(
      harness.runtime.adoptHostResult(connection, {
        type: 'file-r2-record-result',
        bridgeVersion: 1,
        legacySessionId: first.legacySessionId,
        scope: first.scope,
        descriptorId: first.descriptorId,
        descriptorVersion: 1,
        outcome: 'ready',
      }),
    ).toBe('stale');
    expect(harness.fallbacks).toHaveLength(0);
    expect(harness.removed).not.toContain(QID_A);
  });

  it('re-offers a repeated queue item under a fresh exact scope without deleting its record', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'guest-a' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    expect(
      harness.runtime.adoptHostCapability(connection, {
        type: 'file-bounded-v1-capability',
        bridgeVersion: 1,
        descriptorVersion: 1,
      }),
    ).toBe('accepted');

    const firstInput = hostPrepareInput(QID_A, 1);
    await harness.runtime.prepareHost(firstInput);
    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'descriptor-sent',
    });
    const first = harness.frames.at(-1)?.frame;
    if (!first || first.type !== 'file-r2-record-descriptor') {
      throw new Error('first descriptor was not emitted');
    }

    await harness.runtime.prepareHost(hostPrepareInput(QID_B, 2));
    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'descriptor-sent',
    });

    await harness.runtime.prepareHost(
      freezeRecord({
        ...firstInput,
        legacySessionId: 3,
        sourceIdentity: 'source-a-revisit',
        transferSessionId: 'binding-a-revisit',
      }),
    );
    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'descriptor-sent',
    });
    const repeated = harness.frames.at(-1)?.frame;
    if (!repeated || repeated.type !== 'file-r2-record-descriptor') {
      throw new Error('repeated descriptor was not emitted');
    }
    expect(repeated.legacySessionId).toBe(3);
    expect(repeated.scope.bindingId).toBe(first.scope.bindingId);
    expect(repeated.scope.sourceIdentity).toBe(first.scope.sourceIdentity);
    expect(repeated.scope.bridgeGeneration).not.toBe(first.scope.bridgeGeneration);
    expect(repeated.descriptorId).not.toBe(first.descriptorId);
    const publicationsForRepeatedOccurrence =
      harness.publisher.publishRecordSet.mock.calls.filter(
        ([source]) => (source as { queueItemId?: QueueItemId }).queueItemId === QID_A,
      );
    const firstPublished = publicationsForRepeatedOccurrence[0]?.[0];
    const repeatedPublished = publicationsForRepeatedOccurrence.at(-1)?.[0];
    expect(firstPublished).toMatchObject({
      sourceIdentity: `mxq:q:${QID_A}`,
      transferSessionId: `mxq:s:room-epoch-a:q:${QID_A}`,
    });
    expect(repeatedPublished).toMatchObject({
      sourceIdentity: firstPublished?.sourceIdentity,
      transferSessionId: firstPublished?.transferSessionId,
      blob: firstInput.blob,
    });
    expect(harness.removed).not.toContain(QID_A);
    expect(harness.cancelled).toEqual([QID_A, QID_B]);
  });

  it('cancels only an unfinished different occurrence and never a same-occurrence revisit', async () => {
    const harness = createHarness();
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 2));
    expect(harness.cancelled).toEqual([]);

    await harness.runtime.prepareHost(hostPrepareInput(QID_B, 3));
    expect(harness.cancelled).toEqual([QID_A]);
  });

  it('does not hold successor preparation behind remote cancellation cleanup', async () => {
    const harness = createHarness();
    const cancellation = deferred<boolean>();
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    harness.publisher.cancelPendingRecordSet.mockReturnValueOnce(cancellation.promise);

    await expect(harness.runtime.prepareHost(hostPrepareInput(QID_B, 2))).resolves.toEqual({
      status: 'ready',
      durationSeconds: 120,
    });
    expect(harness.publisher.cancelPendingRecordSet).toHaveBeenCalledWith(QID_A);

    cancellation.resolve(true);
    await cancellation.promise;
  });

  it('deletes non-current queue assets immediately and drains current removal after an explicit guest-free barrier', async () => {
    const harness = createHarness();
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    await expect(harness.runtime.flushDeferredQueueItemRemovals()).resolves.toBe(0);

    await expect(harness.runtime.removeQueueItem(QID_B)).resolves.toBe('removed');
    await expect(harness.runtime.removeQueueItem(QID_A)).resolves.toBe('deferred');
    expect(harness.removed).toEqual([QID_B]);
    await expect(harness.runtime.flushDeferredQueueItemRemovals()).resolves.toBe(0);

    await harness.runtime.prepareHost(hostPrepareInput(QID_B, 2));
    expect(harness.removed).toEqual([QID_B]);
    await expect(harness.runtime.flushDeferredQueueItemRemovals()).resolves.toBe(1);
    expect(harness.removed).toEqual([QID_B, QID_A]);
  });

  it('retains a failed non-current cleanup request for an exact later retry', async () => {
    const harness = createHarness();
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    await expect(harness.runtime.flushDeferredQueueItemRemovals()).resolves.toBe(0);
    harness.publisher.removeQueueItem.mockRejectedValueOnce(new Error('transient delete failure'));

    await expect(harness.runtime.removeQueueItem(QID_B)).resolves.toBe('failed');
    await expect(harness.runtime.flushDeferredQueueItemRemovals()).resolves.toBe(1);
    expect(harness.publisher.removeQueueItem).toHaveBeenCalledTimes(2);
    expect(harness.removed).toEqual([QID_B]);
  });

  it('does not drain an old record set at descriptor-sent before the successor guest is ready', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'guest-a' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    expect(
      harness.runtime.adoptHostCapability(connection, {
        type: 'file-bounded-v1-capability',
        bridgeVersion: 1,
        descriptorVersion: 1,
      }),
    ).toBe('accepted');
    await expect(harness.runtime.removeQueueItem(QID_A)).resolves.toBe('deferred');
    await harness.runtime.prepareHost(hostPrepareInput(QID_B, 2));
    // The connection existed in the prior ledger, but has no successor
    // delivery evidence yet. A missing snapshot is not proof of release.
    await expect(harness.runtime.flushDeferredQueueItemRemovals()).resolves.toBe(0);
    expect(harness.removed).not.toContain(QID_A);
    expect(
      harness.runtime.adoptHostCapability(connection, {
        type: 'file-bounded-v1-capability',
        bridgeVersion: 1,
        descriptorVersion: 1,
      }),
    ).toBe('accepted');
    await expect(harness.runtime.offerHostCurrent(connection)).resolves.toEqual({
      status: 'descriptor-sent',
    });

    await expect(harness.runtime.flushDeferredQueueItemRemovals()).resolves.toBe(0);
    expect(harness.removed).not.toContain(QID_A);

    const descriptor = harness.frames.at(-1)?.frame;
    if (!descriptor || descriptor.type !== 'file-r2-record-descriptor') {
      throw new Error('descriptor was not emitted');
    }
    expect(
      harness.runtime.adoptHostResult(connection, {
        type: 'file-r2-record-result',
        bridgeVersion: 1,
        legacySessionId: descriptor.legacySessionId,
        scope: descriptor.scope,
        descriptorId: descriptor.descriptorId,
        descriptorVersion: 1,
        outcome: 'ready',
      }),
    ).toBe('ready');
    await vi.waitFor(() => expect(harness.removed).toContain(QID_A));
    await expect(harness.runtime.flushDeferredQueueItemRemovals()).resolves.toBe(0);
    expect(harness.removed).toContain(QID_A);
  });

  it('defers predecessor deletion when successor prepare wins the playlist-removal race', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'guest-a' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    expect(
      harness.runtime.adoptHostCapability(connection, {
        type: 'file-bounded-v1-capability',
        bridgeVersion: 1,
        descriptorVersion: 1,
      }),
    ).toBe('accepted');
    await harness.runtime.offerHostCurrent(connection);
    const firstDescriptor = harness.frames.at(-1)?.frame;
    if (!firstDescriptor || firstDescriptor.type !== 'file-r2-record-descriptor') {
      throw new Error('first descriptor was not emitted');
    }
    harness.runtime.adoptHostResult(connection, {
      type: 'file-r2-record-result',
      bridgeVersion: 1,
      legacySessionId: firstDescriptor.legacySessionId,
      scope: firstDescriptor.scope,
      descriptorId: firstDescriptor.descriptorId,
      descriptorVersion: 1,
      outcome: 'ready',
    });
    await expect(harness.runtime.flushDeferredQueueItemRemovals()).resolves.toBe(0);

    await harness.runtime.prepareHost(hostPrepareInput(QID_B, 2));
    // Playlist removal can race after prepare has already published qB as the
    // current identity. qA is still protected until qB's exact peer barrier.
    await expect(harness.runtime.removeQueueItem(QID_A)).resolves.toBe('deferred');
    expect(harness.removed).not.toContain(QID_A);

    harness.runtime.adoptHostCapability(connection, {
      type: 'file-bounded-v1-capability',
      bridgeVersion: 1,
      descriptorVersion: 1,
    });
    await harness.runtime.offerHostCurrent(connection);
    await expect(harness.runtime.flushDeferredQueueItemRemovals()).resolves.toBe(0);
    expect(harness.removed).not.toContain(QID_A);
    const successorDescriptor = harness.frames.at(-1)?.frame;
    if (!successorDescriptor || successorDescriptor.type !== 'file-r2-record-descriptor') {
      throw new Error('successor descriptor was not emitted');
    }
    harness.runtime.adoptHostResult(connection, {
      type: 'file-r2-record-result',
      bridgeVersion: 1,
      legacySessionId: successorDescriptor.legacySessionId,
      scope: successorDescriptor.scope,
      descriptorId: successorDescriptor.descriptorId,
      descriptorVersion: 1,
      outcome: 'ready',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.removed).toContain(QID_A);
  });

  it('auto-drains an armed old set after the successor stable-V1 fallback acknowledgement', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const connection = freezeRecord({ id: 'legacy-guest' });
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    await harness.runtime.offerHostCurrent(connection);
    await expect(harness.runtime.removeQueueItem(QID_A)).resolves.toBe('deferred');
    await harness.runtime.prepareHost(hostPrepareInput(QID_B, 2));

    const settlement = harness.runtime.offerHostCurrentSettled(connection, QID_B, 2);
    await expect(harness.runtime.flushDeferredQueueItemRemovals()).resolves.toBe(0);
    await vi.advanceTimersByTimeAsync(21);
    await expect(settlement).resolves.toEqual({ status: 'legacy-committed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.removed).toContain(QID_A);
  });

  it('permits deferred current cleanup after exact empty-playlist retirement', async () => {
    const harness = createHarness();
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    await expect(harness.runtime.removeQueueItem(QID_A)).resolves.toBe('deferred');

    await expect(harness.runtime.retireCurrent(QID_A, 1)).resolves.toBe(true);
    await vi.waitFor(() => expect(harness.removed).toEqual([QID_A]));
    expect(harness.runtime.snapshot().current).toBeNull();
  });

  it('settles one exact host natural end once while duplicate polls share its task', async () => {
    const harness = createHarness();
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    await harness.runtime.applyControl({
      kind: 'play',
      queueItemId: QID_A,
      legacySessionId: 1,
      positionSeconds: 119.96,
      startAtRoomTimeMs: 1_000,
    });
    const stop = deferred<void>();
    harness.bridge.stopDeferred = stop;

    const first = harness.runtime.settleHostNaturalEnd(QID_A, 1);
    const duplicate = harness.runtime.settleHostNaturalEnd(QID_A, 1);
    expect(duplicate).toBe(first);
    expect(harness.bridge.controls.filter((kind) => kind === 'stop')).toHaveLength(1);

    stop.resolve(undefined);
    await expect(first).resolves.toMatchObject({
      status: 'settled',
      snapshot: { queueItemId: QID_A, legacySessionId: 1, phase: 'stopped' },
    });
    await expect(harness.runtime.settleHostNaturalEnd(QID_A, 1)).resolves.toMatchObject({
      status: 'settled',
    });
    expect(harness.bridge.controls.filter((kind) => kind === 'stop')).toHaveLength(1);

    await harness.runtime.applyControl({
      kind: 'play',
      queueItemId: QID_A,
      legacySessionId: 1,
      positionSeconds: 119.96,
      startAtRoomTimeMs: 1_100,
    });
    const replayStop = deferred<void>();
    harness.bridge.stopDeferred = replayStop;
    const replayEnd = harness.runtime.settleHostNaturalEnd(QID_A, 1);
    expect(replayEnd).not.toBe(first);
    expect(harness.bridge.controls.filter((kind) => kind === 'stop')).toHaveLength(2);
    replayStop.resolve(undefined);
    await expect(replayEnd).resolves.toMatchObject({ status: 'settled' });
  });

  it('rejects premature natural-end evidence and fences an in-flight end on supersession', async () => {
    const harness = createHarness();
    await harness.runtime.beginHostRoom({
      kind: 'standard',
      roomEpoch: 'room-epoch-a',
      storageRoomId: '100001',
      roomToken: Object.freeze({}),
    });
    await harness.runtime.prepareHost(hostPrepareInput(QID_A, 1));
    await harness.runtime.applyControl({
      kind: 'play',
      queueItemId: QID_A,
      legacySessionId: 1,
      positionSeconds: 20,
      startAtRoomTimeMs: 1_000,
    });
    await expect(harness.runtime.settleHostNaturalEnd(QID_A, 1)).resolves.toEqual({
      status: 'not-ended',
    });

    await harness.runtime.applyControl({
      kind: 'seek-playing',
      queueItemId: QID_A,
      legacySessionId: 1,
      positionSeconds: 119.96,
      startAtRoomTimeMs: 1_010,
    });
    const stop = deferred<void>();
    harness.bridge.stopDeferred = stop;
    const ending = harness.runtime.settleHostNaturalEnd(QID_A, 1);
    await harness.runtime.prepareHost(hostPrepareInput(QID_B, 2));
    stop.resolve(undefined);

    await expect(ending).resolves.toEqual({ status: 'superseded' });
    await expect(harness.runtime.settleHostNaturalEnd(QID_A, 1)).resolves.toEqual({
      status: 'superseded',
    });
  });

  it('announces guest capability once and buffers only the latest exact control', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    expect(harness.runtime.announceGuestCapability(connection)).toBe(true);
    expect(harness.runtime.announceGuestCapability(connection)).toBe(false);
    expect(harness.frames.map(({ frame }) => frame.type)).toEqual(['file-bounded-v1-capability']);
    expect(harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 })).toBe(
      true,
    );
    await expect(
      harness.runtime.applyControl({
        queueItemId: QID_A,
        legacySessionId: 1,
        kind: 'play',
        positionSeconds: 3,
        startAtRoomTimeMs: 1_050,
      }),
    ).resolves.toEqual({ status: 'buffered' });
    await expect(
      harness.runtime.applyControl({
        queueItemId: QID_A,
        legacySessionId: 1,
        kind: 'play',
        positionSeconds: 7,
        startAtRoomTimeMs: 1_100,
      }),
    ).resolves.toEqual({ status: 'buffered' });

    await expect(
      harness.runtime.adoptGuestDescriptor(connection, descriptorFrame()),
    ).resolves.toEqual({ status: 'ready', durationSeconds: 120 });
    await Promise.resolve();
    expect(harness.bridge.controls).toEqual(['play']);
    expect(harness.runtime.positionSeconds()).toBeCloseTo(7.15, 6);
    expect(harness.runtime.snapshot().current).toMatchObject({
      state: 'ready',
      phase: 'playing',
      pendingControl: null,
    });
    expect(harness.frames.at(-1)?.frame).toMatchObject({
      type: 'file-r2-record-result',
      outcome: 'ready',
    });
  });

  it.each(['play', 'seek-playing'] as const)(
    'rebases a pending guest %s after late descriptor readiness and catches up its position',
    async (kind) => {
      let nowRoomTimeMs = 1_000;
      const harness = createHarness({ nowRoomTimeMs: () => nowRoomTimeMs });
      const connection = freezeRecord({ id: 'host' });
      const preparation = deferred<LegacyBoundedV1PrepareOutcome>();
      harness.bridge.prepareDeferred = preparation;
      await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
      expect(
        harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 }),
      ).toBe(true);

      const adoption = harness.runtime.adoptGuestDescriptor(connection, descriptorFrame());
      await vi.waitFor(() => {
        expect(harness.bridge.preparedQueueItemIds).toEqual([QID_A]);
      });
      await expect(
        harness.runtime.applyControl({
          queueItemId: QID_A,
          legacySessionId: 1,
          kind,
          positionSeconds: 7,
          startAtRoomTimeMs: 1_050,
        }),
      ).resolves.toEqual({ status: 'buffered' });

      nowRoomTimeMs = 2_550;
      harness.bridge.playingStartFloorMs = nowRoomTimeMs;
      preparation.resolve(
        freezeRecord({
          status: 'ready',
          snapshot: bridgeSnapshot({ durationSeconds: 120 }),
        }),
      );

      await expect(adoption).resolves.toEqual({ status: 'ready', durationSeconds: 120 });
      await vi.waitFor(() => {
        expect(harness.bridge.playingInputs).toHaveLength(1);
      });
      const applied = harness.bridge.playingInputs[0];
      expect(applied?.startAtRoomTimeMs).toBeGreaterThan(nowRoomTimeMs);
      expect(applied?.positionSeconds).toBeCloseTo(
        7 + ((applied?.startAtRoomTimeMs ?? 0) - 1_050) / 1_000,
        8,
      );
      expect(harness.failures).toHaveLength(0);
      expect(harness.runtime.snapshot().current).toMatchObject({
        state: 'ready',
        phase: 'playing',
        pendingControl: null,
      });
      expect(harness.runtime.ownsGuestTransfer(connection, QID_A, 1)).toBe(true);
    },
  );

  it('does not let a retired guest connection reacquire runtime authority', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    expect(harness.runtime.announceGuestCapability(connection)).toBe(true);
    expect(harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 })).toBe(
      true,
    );

    await expect(harness.runtime.retireConnection(connection)).resolves.toBe(true);
    await expect(harness.runtime.retireConnection(connection)).resolves.toBe(false);
    expect(harness.runtime.announceGuestCapability(connection)).toBe(false);
    expect(harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 })).toBe(
      false,
    );
    await expect(
      harness.runtime.adoptGuestDescriptor(connection, descriptorFrame()),
    ).resolves.toEqual({ status: 'bypass' });
    expect(harness.runtime.ownsGuestTransfer(connection, QID_A, 1)).toBe(false);
  });

  it('keeps a retiring guest connection owner visible until physical cleanup settles', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 });
    await harness.runtime.adoptGuestDescriptor(connection, descriptorFrame(QID_A, 1));
    const retirement = deferred<LegacyBoundedV1ControlOutcome>();
    harness.bridge.retireDeferred = retirement;

    const retiring = harness.runtime.retireConnection(connection);
    expect(harness.runtime.snapshot()).toMatchObject({
      current: { queueItemId: QID_A, legacySessionId: 1, state: 'retiring' },
    });
    expect(harness.runtime.ownsGuestTransfer(connection, QID_A, 1)).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.bridge.retired).toBe(1);

    retirement.resolve(
      freezeRecord({
        status: 'applied',
        snapshot: bridgeSnapshot(),
      }),
    );
    await expect(retiring).resolves.toBe(true);
    expect(harness.providerRetired).toHaveLength(1);
    expect(harness.runtime.snapshot().current).toBeNull();
  });

  it('returns typed guest fallback, emits fallback result, and releases ownership', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    harness.setSourceFallback(true);
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 });

    await expect(
      harness.runtime.adoptGuestDescriptor(connection, descriptorFrame()),
    ).resolves.toEqual({ status: 'fallback' });
    expect(harness.frames.at(-1)?.frame).toMatchObject({
      type: 'file-r2-record-result',
      outcome: 'fallback',
    });
    expect(harness.runtime.ownsGuestTransfer(connection, QID_A, 1)).toBe(false);
    expect(harness.providerRetired).toHaveLength(1);
  });

  it('localizes a hard renderer control failure without any connection-close effect', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 });
    await harness.runtime.adoptGuestDescriptor(connection, descriptorFrame());
    const failure = new Error('renderer exploded');
    harness.bridge.controlFailure = failure;

    await expect(
      harness.runtime.applyControl({
        queueItemId: QID_A,
        legacySessionId: 1,
        kind: 'play',
        positionSeconds: 0,
        startAtRoomTimeMs: 1_000,
      }),
    ).resolves.toEqual({ status: 'failed', error: failure });
    expect(harness.runtime.snapshot()).toMatchObject({
      active: true,
      role: 'guest',
      current: { state: 'failed' },
    });
    expect(harness.failures).toContain(failure);
    expect(harness.runtime.ownsGuestTransfer(connection, QID_A, 1)).toBe(false);
  });

  it('serializes a successor descriptor behind exact prior retirement', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 });
    await harness.runtime.adoptGuestDescriptor(connection, descriptorFrame(QID_A, 1));
    harness.frames.splice(0);

    const retirement = deferred<LegacyBoundedV1ControlOutcome>();
    harness.bridge.retireDeferred = retirement;
    harness.runtime.beginGuestTransfer({ queueItemId: QID_B, legacySessionId: 2 });
    const successor = harness.runtime.adoptGuestDescriptor(connection, descriptorFrame(QID_B, 2));
    let successorSettled = false;
    void successor.then(() => {
      successorSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.bridge.retired).toBe(1);
    expect(successorSettled).toBe(false);
    expect(harness.bridge.preparedQueueItemIds).toEqual([QID_A]);
    await expect(
      harness.runtime.applyControl({
        queueItemId: QID_A,
        legacySessionId: 1,
        kind: 'pause',
        positionSeconds: 2,
        atRoomTimeMs: 1_010,
      }),
    ).resolves.toEqual({ status: 'superseded' });
    await expect(
      harness.runtime.adoptGuestDescriptor(connection, descriptorFrame(QID_A, 1)),
    ).resolves.toEqual({ status: 'stale' });

    retirement.resolve(
      freezeRecord({
        status: 'applied',
        snapshot: bridgeSnapshot(),
      }),
    );
    await expect(successor).resolves.toEqual({ status: 'ready', durationSeconds: 120 });
    expect(harness.bridge.preparedQueueItemIds).toEqual([QID_A, QID_B]);
    expect(harness.providerRetired).toHaveLength(1);
    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]?.frame).toMatchObject({
      type: 'file-r2-record-result',
      legacySessionId: 2,
      outcome: 'ready',
    });
    expect(harness.runtime.hasReadyRenderer(QID_B, 2)).toBe(true);
  });

  it('keeps an exact guest retirement visible and joins repeated retirement requests', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 });
    await harness.runtime.adoptGuestDescriptor(connection, descriptorFrame(QID_A, 1));

    const retirement = deferred<LegacyBoundedV1ControlOutcome>();
    harness.bridge.retireDeferred = retirement;

    const first = harness.runtime.retireCurrent(QID_A, 1);
    const second = harness.runtime.retireCurrent(QID_A, 1);
    expect(harness.runtime.snapshot()).toMatchObject({
      current: { queueItemId: QID_A, legacySessionId: 1, state: 'retiring' },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.bridge.retired).toBe(1);

    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    retirement.resolve(
      freezeRecord({
        status: 'applied',
        snapshot: bridgeSnapshot(),
      }),
    );
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(harness.bridge.retired).toBe(1);
    expect(harness.runtime.snapshot().current).toBeNull();
  });

  it('does not revive a retiring guest when its pending descriptor completes', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    const preparation = deferred<LegacyBoundedV1PrepareOutcome>();
    const retirement = deferred<LegacyBoundedV1ControlOutcome>();
    harness.bridge.prepareDeferred = preparation;
    harness.bridge.retireDeferred = retirement;
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 });

    const adopting = harness.runtime.adoptGuestDescriptor(
      connection,
      descriptorFrame(QID_A, 1),
    );
    await vi.waitFor(() => {
      expect(harness.bridge.preparedQueueItemIds).toEqual([QID_A]);
    });
    const retiring = harness.runtime.retireCurrent(QID_A, 1);
    expect(harness.runtime.snapshot()).toMatchObject({
      current: { queueItemId: QID_A, legacySessionId: 1, state: 'retiring' },
    });

    preparation.resolve(
      freezeRecord({
        status: 'ready',
        snapshot: bridgeSnapshot({ durationSeconds: 120 }),
      }),
    );
    let adoptionSettled = false;
    void adopting.then(() => {
      adoptionSettled = true;
    });
    await Promise.resolve();
    expect(adoptionSettled).toBe(false);
    expect(harness.runtime.snapshot()).toMatchObject({
      current: { queueItemId: QID_A, legacySessionId: 1, state: 'retiring' },
    });
    expect(harness.frames).toHaveLength(0);
    expect(harness.bridge.retired).toBe(1);

    retirement.resolve(
      freezeRecord({
        status: 'applied',
        snapshot: bridgeSnapshot(),
      }),
    );
    await expect(retiring).resolves.toBe(true);
    await expect(adopting).resolves.toEqual({ status: 'stale' });
    expect(harness.frames).toHaveLength(0);
    expect(harness.runtime.snapshot().current).toBeNull();
  });

  it('rejects stale descriptor completion without emitting a terminal result', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    const pending = deferred<LegacyBoundedV1PrepareOutcome>();
    harness.bridge.prepareDeferred = pending;
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 });
    const first = harness.runtime.adoptGuestDescriptor(connection, descriptorFrame());
    harness.runtime.beginGuestTransfer({ queueItemId: QID_B, legacySessionId: 2 });
    pending.resolve(
      freezeRecord({
        status: 'ready',
        snapshot: bridgeSnapshot({ durationSeconds: 120 }),
      }),
    );

    await expect(first).resolves.toEqual({ status: 'stale' });
    expect(harness.frames).toHaveLength(0);
    expect(harness.providerRetired).toHaveLength(0);
    expect(harness.runtime.ownsGuestTransfer(connection, QID_B, 2)).toBe(true);
  });

  it('rechecks guest authority after failed-source retirement before emitting fallback', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    const preparation = deferred<LegacyBoundedV1PrepareOutcome>();
    const retirement = deferred<LegacyBoundedV1ControlOutcome>();
    harness.bridge.prepareDeferred = preparation;
    harness.bridge.retireDeferred = retirement;
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 });
    const first = harness.runtime.adoptGuestDescriptor(connection, descriptorFrame(QID_A, 1));
    void first.catch(() => undefined);
    await vi.waitFor(() => {
      expect(harness.bridge.preparedQueueItemIds).toEqual([QID_A]);
    });

    preparation.reject(new Error('source failed'));
    harness.bridge.prepareDeferred = null;
    await vi.waitFor(() => {
      expect(harness.bridge.retired).toBe(1);
    });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_B, legacySessionId: 2 });
    retirement.resolve(
      freezeRecord({
        status: 'applied',
        snapshot: bridgeSnapshot(),
      }),
    );

    await expect(first).resolves.toEqual({ status: 'stale' });
    expect(harness.frames).toHaveLength(0);
    expect(harness.runtime.ownsGuestTransfer(connection, QID_B, 2)).toBe(true);
  });

  it('abandons only the exact guest transfer and fences its late completion', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    const otherConnection = freezeRecord({ id: 'other-host' });
    const pending = deferred<LegacyBoundedV1PrepareOutcome>();
    harness.bridge.prepareDeferred = pending;
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 });
    const adoption = harness.runtime.adoptGuestDescriptor(connection, descriptorFrame());

    await expect(harness.runtime.abandonGuestTransfer(otherConnection, QID_A, 1)).resolves.toBe(
      false,
    );
    await expect(harness.runtime.abandonGuestTransfer(connection, QID_B, 1)).resolves.toBe(false);
    await expect(harness.runtime.abandonGuestTransfer(connection, QID_A, 1)).resolves.toBe(true);
    expect(harness.bridge.retired).toBe(1);
    expect(harness.providerRetired).toHaveLength(1);
    expect(harness.runtime.ownsGuestTransfer(connection, QID_A, 1)).toBe(false);

    pending.resolve(
      freezeRecord({
        status: 'ready',
        snapshot: bridgeSnapshot({ durationSeconds: 120 }),
      }),
    );
    await expect(adoption).resolves.toEqual({ status: 'stale' });
    expect(harness.bridge.retired).toBe(1);
    expect(harness.providerRetired).toHaveLength(1);
    expect(harness.frames).toHaveLength(0);
    await expect(
      harness.runtime.applyControl({
        queueItemId: QID_A,
        legacySessionId: 1,
        kind: 'play',
        positionSeconds: 0,
        startAtRoomTimeMs: 1_000,
      }),
    ).resolves.toEqual({ status: 'bypass' });
  });

  it('keeps an abandoned guest transfer visible until its exact drain completes', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 });
    await harness.runtime.adoptGuestDescriptor(connection, descriptorFrame(QID_A, 1));
    const retirement = deferred<LegacyBoundedV1ControlOutcome>();
    harness.bridge.retireDeferred = retirement;

    const first = harness.runtime.abandonGuestTransfer(connection, QID_A, 1);
    const second = harness.runtime.abandonGuestTransfer(connection, QID_A, 1);
    expect(harness.runtime.snapshot()).toMatchObject({
      current: { queueItemId: QID_A, legacySessionId: 1, state: 'retiring' },
    });
    expect(harness.runtime.ownsGuestTransfer(connection, QID_A, 1)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.bridge.retired).toBe(1);

    retirement.resolve(
      freezeRecord({
        status: 'applied',
        snapshot: bridgeSnapshot(),
      }),
    );
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(harness.bridge.retired).toBe(1);
    expect(harness.providerRetired).toHaveLength(1);
    expect(harness.runtime.snapshot().current).toBeNull();
    expect(harness.runtime.ownsGuestTransfer(connection, QID_A, 1)).toBe(false);
  });

  it('fences completion after room cleanup and never closes the connection', async () => {
    const harness = createHarness();
    const connection = freezeRecord({ id: 'host' });
    const pending = deferred<LegacyBoundedV1PrepareOutcome>();
    harness.bridge.prepareDeferred = pending;
    await harness.runtime.beginGuestRoom({ kind: 'standard', hostConnection: connection });
    harness.runtime.beginGuestTransfer({ queueItemId: QID_A, legacySessionId: 1 });
    const adoption = harness.runtime.adoptGuestDescriptor(connection, descriptorFrame());
    const cleanup = harness.runtime.endRoom();
    pending.resolve(
      freezeRecord({
        status: 'ready',
        snapshot: bridgeSnapshot({ durationSeconds: 120 }),
      }),
    );

    await expect(adoption).resolves.toEqual({ status: 'stale' });
    await cleanup;
    expect(harness.frames).toHaveLength(0);
    expect(harness.runtime.snapshot()).toMatchObject({
      active: false,
      role: 'idle',
      current: null,
    });
  });
});

/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetLease,
} from '../file-playback-asset-registry.ts';
import type {
  FilePlaybackConnectionMediaOperation,
  FilePlaybackConnectionMediaOperationEpoch,
} from '../file-playback-connection-media-session.ts';
import {
  createPeerRangeFileMediaSourceOfferV2,
  createR2WholeBlobFileMediaSourceOfferV2,
  type R2WholeBlobFileMediaSourceOfferV2Input,
} from '../file-media-source-offer.ts';
import {
  FilePlaybackR2WholeBlobAcquirer,
  FilePlaybackR2WholeBlobAcquirerFatalError,
  type FilePlaybackR2WholeBlobAcquirerRuntime,
} from '../file-playback-r2-whole-blob-acquirer.ts';
import { createFilePlaybackRunBindingV2 } from '../file-playback-run-binding.ts';
import {
  memoryReservationStatsForTests,
  reserveRemoteTransportMemoryWithinBudget,
  type EncodedReceiveMemoryReservation,
  type RemoteTransportMemoryReservation,
} from '../decode-admission.ts';

const ROOM_TOKEN = Object.freeze({ room: 'r2-acquirer' });
const SESSION_ID = 'session:r2-acquirer';
const CONNECTION_ID = 'connection:r2-acquirer';
const QUEUE_ID = '10000000-0000-4000-8000-000000000001' as QueueItemId;
const PREPARE_ONE = '20000000-0000-4000-8000-000000000001';
const PREPARE_TWO = '20000000-0000-4000-8000-000000000002';
const RUN_ONE = '30000000-0000-4000-8000-000000000001';
const OBJECT_ONE = '40000000-0000-4000-8000-000000000001';
const KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const IV_B64 = 'AAAAAAAAAAAAAAAA';

function canonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function offerInput(
  overrides: Partial<R2WholeBlobFileMediaSourceOfferV2Input> = {},
): R2WholeBlobFileMediaSourceOfferV2Input {
  return {
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    prepareId: PREPARE_ONE,
    prepareRevision: 1,
    queueItemId: QUEUE_ID,
    sourceIdentity: 'source:r2-acquirer',
    transferSessionId: 'transfer:r2-acquirer',
    storageRoomId: 'r2-room_acquirer',
    objectId: OBJECT_ONE,
    encodedSize: 4,
    encryptedSize: 20,
    keyB64: KEY_B64,
    ivB64: IV_B64,
    name: 'take.wav',
    mime: 'audio/wav',
    expiresAtRoomTimeMs: 10_000,
    ...overrides,
  };
}

interface OperationHarness {
  readonly operation: Readonly<FilePlaybackConnectionMediaOperation>;
  readonly abort: AbortController;
  setCurrent(value: boolean): void;
}

function operation(
  overrides: Partial<R2WholeBlobFileMediaSourceOfferV2Input> = {},
): OperationHarness {
  const offer = createR2WholeBlobFileMediaSourceOfferV2(offerInput(overrides));
  const binding = createFilePlaybackRunBindingV2({
    sessionId: offer.sessionId,
    connectionId: offer.connectionId,
    prepareId: offer.prepareId,
    prepareRevision: offer.prepareRevision,
    queueItemId: offer.queueItemId,
    sourceIdentity: offer.sourceIdentity,
    transferSessionId: offer.transferSessionId,
    runId: RUN_ONE,
    playbackRevision: offer.prepareRevision,
  });
  const abort = new AbortController();
  let current = true;
  const epoch = Object.freeze(Object.create(null)) as FilePlaybackConnectionMediaOperationEpoch;
  const fence = canonical({ epoch, signal: abort.signal, isCurrent: () => current });
  const value = canonical({
    kind: offer.prepareRevision === 1 ? ('baseline' as const) : ('successor' as const),
    offer,
    binding,
    fence,
  }) as Readonly<FilePlaybackConnectionMediaOperation>;
  return {
    operation: value,
    abort,
    setCurrent(value: boolean) {
      current = value;
    },
  };
}

interface ReservationHarness {
  readonly transport: RemoteTransportMemoryReservation;
  readonly handoff: ReturnType<typeof vi.fn>;
  readonly transportRelease: ReturnType<typeof vi.fn>;
  readonly retainedRelease: ReturnType<typeof vi.fn>;
}

function reservation(index: number): ReservationHarness {
  const retainedRelease = vi.fn();
  const retained: EncodedReceiveMemoryReservation = {
    id: index,
    encodedBytes: 4,
    markFinalized: vi.fn(),
    release: retainedRelease,
  };
  const handoff = vi.fn(() => retained);
  const transportRelease = vi.fn();
  return {
    transport: { handoffToRetainedEncoded: handoff, release: transportRelease },
    handoff,
    transportRelease,
    retainedRelease,
  };
}

interface Harness {
  readonly registry: FilePlaybackAssetRegistry;
  readonly registryFatal: ReturnType<typeof vi.fn>;
  readonly roomFatal: ReturnType<typeof vi.fn>;
  readonly download: ReturnType<typeof vi.fn>;
  readonly decrypt: ReturnType<typeof vi.fn>;
  readonly reserveTransport: ReturnType<typeof vi.fn>;
  readonly livePcmBytes: ReturnType<typeof vi.fn>;
  readonly waitForMemoryReservationChange: ReturnType<typeof vi.fn>;
  readonly reservations: ReservationHarness[];
  readonly acquirer: FilePlaybackR2WholeBlobAcquirer;
}

function harness(overrides: Partial<FilePlaybackR2WholeBlobAcquirerRuntime> = {}): Harness {
  const registryFatal = vi.fn();
  const roomFatal = vi.fn();
  const registry = new FilePlaybackAssetRegistry({
    liveRoomToken: ROOM_TOKEN,
    onFatalRoom: registryFatal,
  });
  const reservations: ReservationHarness[] = [];
  const download = vi.fn(async () => new ArrayBuffer(20));
  const decrypt = vi.fn(
    async (_encrypted: ArrayBuffer, options: { name: string; mime: string }) =>
      new File([new Uint8Array([1, 2, 3, 4])], options.name, {
        type: options.mime,
        lastModified: 0,
      }),
  );
  const reserveTransport = vi.fn(() => {
    const created = reservation(reservations.length + 1);
    reservations.push(created);
    return created.transport;
  });
  const livePcmBytes = vi.fn(() => 77);
  const waitForMemoryReservationChange = vi.fn(async () => false);
  const runtime: FilePlaybackR2WholeBlobAcquirerRuntime = {
    download,
    decrypt,
    reserveTransport,
    resolveMemoryBudget: () => ({
      tier: 'ios',
      maxDecodedPcmBytes: 192 * 1024 * 1024,
      maxDecodeWorkingSetBytes: 320 * 1024 * 1024,
    }),
    livePcmBytes,
    waitForMemoryReservationChange,
    ...overrides,
  };
  return {
    registry,
    registryFatal,
    roomFatal,
    download,
    decrypt,
    reserveTransport,
    livePcmBytes,
    waitForMemoryReservationChange,
    reservations,
    acquirer: new FilePlaybackR2WholeBlobAcquirer({
      roomToken: ROOM_TOKEN,
      registry,
      onFatalRoom: roomFatal,
      runtime,
    }),
  };
}

describe('FilePlaybackR2WholeBlobAcquirer', () => {
  it('admits iOS ciphertext memory before download and commits a body-free Blob asset', async () => {
    const setup = harness();
    const run = operation();
    const result = await setup.acquirer.acquire(run.operation);

    expect(setup.reserveTransport).toHaveBeenCalledWith(20, {
      budget: expect.objectContaining({ tier: 'ios' }),
      fileName: 'take.wav',
      retainedPcmBytes: 77,
    });
    expect(setup.reserveTransport.mock.invocationCallOrder[0]).toBeLessThan(
      setup.download.mock.invocationCallOrder[0]!,
    );
    expect(setup.livePcmBytes).toHaveBeenCalledOnce();
    expect(setup.download).toHaveBeenCalledWith(
      'r2-room_acquirer',
      OBJECT_ONE,
      20,
      undefined,
      expect.any(AbortSignal),
    );
    expect(setup.reservations[0]!.handoff).toHaveBeenCalledWith(expect.any(File), 4);
    expect(setup.reservations[0]!.transportRelease).not.toHaveBeenCalled();
    expect(setup.reservations[0]!.retainedRelease).not.toHaveBeenCalled();
    expect(Reflect.ownKeys(result)).toEqual(['assetLease', 'asset']);
    expect(result.asset).toMatchObject({
      queueItemId: QUEUE_ID,
      sourceIdentity: 'source:r2-acquirer',
      transferSessionId: 'transfer:r2-acquirer',
      kind: 'blob',
      size: 4,
      name: 'take.wav',
      mime: 'audio/wav',
    });
    expect(Object.keys(result)).not.toEqual(expect.arrayContaining(['blob', 'file', 'body']));
  });

  it('waits for the existing admission ledger before starting iOS download', async () => {
    const budget = {
      tier: 'ios' as const,
      maxDecodedPcmBytes: 192 * 1024 * 1024,
      maxDecodeWorkingSetBytes: 100,
    };
    const wait = vi.fn(async () => {
      budget.maxDecodeWorkingSetBytes = 200;
      return true;
    });
    const setup = harness({
      reserveTransport: reserveRemoteTransportMemoryWithinBudget,
      resolveMemoryBudget: () => budget,
      waitForMemoryReservationChange: wait,
    });
    const before = memoryReservationStatsForTests();

    await setup.acquirer.acquire(operation().operation);
    expect(wait).toHaveBeenCalledOnce();
    expect(setup.download).toHaveBeenCalledOnce();
    expect(memoryReservationStatsForTests().encodedReceiveBytes - before.encodedReceiveBytes).toBe(
      4,
    );

    await setup.acquirer.close();
    expect(memoryReservationStatsForTests().encodedReceiveBytes).toBe(before.encodedReceiveBytes);
    expect(memoryReservationStatsForTests().remoteTransportBytes).toBe(before.remoteTransportBytes);
  });

  it('coalesces only the same operation and rejects a superseded physical receive', async () => {
    const receives = [deferred<ArrayBuffer>(), deferred<ArrayBuffer>()];
    let call = 0;
    const setup = harness({ download: vi.fn(() => receives[call++]!.promise) });
    const first = operation();
    const successor = operation({
      prepareId: PREPARE_TWO,
      prepareRevision: 2,
    });

    const firstPending = setup.acquirer.acquire(first.operation);
    expect(setup.acquirer.acquire(first.operation)).toBe(firstPending);
    const successorPending = setup.acquirer.acquire(successor.operation);
    expect(successorPending).not.toBe(firstPending);
    expect(call).toBe(2);

    first.setCurrent(false);
    first.abort.abort();
    receives[0]!.resolve(new ArrayBuffer(20));
    await expect(firstPending).rejects.toThrow('FILE_PLAYBACK_R2_WHOLE_BLOB_OPERATION_STALE');
    receives[1]!.resolve(new ArrayBuffer(20));
    await expect(successorPending).resolves.toMatchObject({ asset: { queueItemId: QUEUE_ID } });

    expect(setup.decrypt).toHaveBeenCalledOnce();
    expect(setup.reservations[0]!.transportRelease).toHaveBeenCalledOnce();
    expect(setup.reservations[0]!.handoff).not.toHaveBeenCalled();
    expect(setup.reservations[1]!.handoff).toHaveBeenCalledOnce();
    await setup.acquirer.close();
  });

  it('waits for uncancellable decrypt settlement after abort and never admits its File', async () => {
    const decrypt = deferred<File>();
    const decryptMock = vi.fn(() => decrypt.promise);
    const setup = harness({ decrypt: decryptMock });
    const run = operation();
    const pending = setup.acquirer.acquire(run.operation);
    await vi.waitFor(() => expect(decryptMock).toHaveBeenCalledOnce());

    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    run.setCurrent(false);
    run.abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);

    decrypt.resolve(
      new File([new Uint8Array([1, 2, 3, 4])], 'take.wav', {
        type: 'audio/wav',
        lastModified: 0,
      }),
    );
    await expect(pending).rejects.toThrow('FILE_PLAYBACK_R2_WHOLE_BLOB_OPERATION_STALE');
    expect(setup.registry.activeAssetCount(ROOM_TOKEN)).toBe(0);
    expect(setup.reservations[0]!.transportRelease).toHaveBeenCalledOnce();
    expect(setup.reservations[0]!.handoff).not.toHaveBeenCalled();
  });

  it.each(['REMOTE_SHARE_DOWNLOAD_NETWORK', 'REMOTE_SHARE_DOWNLOAD_STALLED'])(
    'retries %s exactly once',
    async (code) => {
      const download = vi
        .fn()
        .mockRejectedValueOnce(new Error(code))
        .mockResolvedValueOnce(new ArrayBuffer(20));
      const setup = harness({ download });

      await expect(setup.acquirer.acquire(operation().operation)).resolves.toMatchObject({
        asset: { queueItemId: QUEUE_ID },
      });
      expect(download).toHaveBeenCalledTimes(2);
      await setup.acquirer.close();
    },
  );

  it.each([
    'REMOTE_SHARE_DOWNLOAD_ORIGIN_INVALID',
    'REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH',
    'REMOTE_SHARE_DOWNLOAD_HTTP_403',
    'REMOTE_SHARE_DOWNLOAD_HTTP_404',
    'REMOTE_SHARE_V2_DECRYPT_FAILED',
  ])('never retries terminal %s failures', async (code) => {
    const download = vi.fn(async () => {
      if (code === 'REMOTE_SHARE_V2_DECRYPT_FAILED') return new ArrayBuffer(20);
      throw new Error(code);
    });
    const decrypt = vi.fn(async () => {
      throw new Error(code);
    });
    const setup = harness({ download, decrypt });

    await expect(setup.acquirer.acquire(operation().operation)).rejects.toThrow(code);
    expect(download).toHaveBeenCalledOnce();
    expect(setup.reservations[0]!.transportRelease).toHaveBeenCalledOnce();
    expect(setup.reservations[0]!.handoff).not.toHaveBeenCalled();
  });

  it('keeps a commit-dominant Blob after operation abort and reuses it for an exact successor', async () => {
    const setup = harness();
    const first = operation();
    const firstResult = await setup.acquirer.acquire(first.operation);
    first.setCurrent(false);
    first.abort.abort();

    expect(setup.acquirer.activeAssetCount()).toBe(1);
    expect(setup.reservations[0]!.retainedRelease).not.toHaveBeenCalled();
    const successor = operation({ prepareId: PREPARE_TWO, prepareRevision: 2 });
    const reused = await setup.acquirer.acquire(successor.operation);
    expect(reused).toBe(firstResult);
    expect(reused.assetLease).toBe(firstResult.assetLease);
    expect(setup.download).toHaveBeenCalledOnce();
    expect(setup.reserveTransport).toHaveBeenCalledOnce();

    await setup.acquirer.close();
    expect(setup.reservations[0]!.retainedRelease).toHaveBeenCalledOnce();
  });

  it('retires queue ownership and its retained reservation exactly once', async () => {
    const setup = harness();
    const result = await setup.acquirer.acquire(operation().operation);
    setup.reservations[0]!.retainedRelease.mockImplementation(() => {
      expect(setup.registry.snapshotForLease(ROOM_TOKEN, result.assetLease)).toBeNull();
    });

    const firstRetirement = setup.acquirer.removeQueueItem(QUEUE_ID);
    expect(setup.acquirer.removeQueueItem(QUEUE_ID)).toBe(firstRetirement);
    await expect(firstRetirement).resolves.toBe(true);
    expect(setup.reservations[0]!.retainedRelease).toHaveBeenCalledOnce();
    expect(setup.registry.snapshotForLease(ROOM_TOKEN, result.assetLease)).toBeNull();
    expect(setup.acquirer.activeAssetCount()).toBe(0);
    await expect(setup.acquirer.acquire(operation().operation)).rejects.toThrow(
      'FILE_PLAYBACK_R2_WHOLE_BLOB_OPERATION_STALE',
    );
    expect(setup.reservations[0]!.retainedRelease).toHaveBeenCalledOnce();
  });

  it('closes the registry and releases every retained reservation exactly once', async () => {
    const setup = harness();
    await setup.acquirer.acquire(operation().operation);
    setup.reservations[0]!.retainedRelease.mockImplementation(() => {
      expect(setup.registry.isClosed()).toBe(true);
    });

    const firstClose = setup.acquirer.close();
    expect(setup.acquirer.close()).toBe(firstClose);
    await firstClose;
    expect(setup.registry.isClosed()).toBe(true);
    expect(setup.acquirer.isClosed()).toBe(true);
    expect(setup.reservations[0]!.retainedRelease).toHaveBeenCalledOnce();
    expect(setup.registryFatal).not.toHaveBeenCalled();
  });

  it('fails closed on source metadata conflict and releases room ownership once', async () => {
    const setup = harness();
    await setup.acquirer.acquire(operation().operation);
    const conflict = operation({
      prepareId: PREPARE_TWO,
      prepareRevision: 2,
      name: 'different.wav',
    });

    await expect(setup.acquirer.acquire(conflict.operation)).rejects.toBeInstanceOf(
      FilePlaybackR2WholeBlobAcquirerFatalError,
    );
    await setup.acquirer.close();
    expect(setup.roomFatal).toHaveBeenCalledOnce();
    expect(setup.reservations[0]!.retainedRelease).toHaveBeenCalledOnce();
    expect(setup.acquirer.isClosed()).toBe(true);
  });

  it('rejects non-R2 and offer/binding-confused operations before memory or download', async () => {
    const first = harness();
    const peerOffer = createPeerRangeFileMediaSourceOfferV2({
      sessionId: SESSION_ID,
      connectionId: CONNECTION_ID,
      prepareId: PREPARE_ONE,
      prepareRevision: 1,
      queueItemId: QUEUE_ID,
      sourceIdentity: 'source:r2-acquirer',
      transferSessionId: 'transfer:r2-acquirer',
      handleId: 'handle:r2-acquirer',
      encodedSize: 4,
      name: 'take.flac',
      mime: 'audio/flac',
      expiresAtRoomTimeMs: 10_000,
    });
    const valid = operation();
    const peerOperation = canonical({
      kind: 'baseline' as const,
      offer: peerOffer,
      binding: valid.operation.binding,
      fence: valid.operation.fence,
    }) as Readonly<FilePlaybackConnectionMediaOperation>;
    await expect(first.acquirer.acquire(peerOperation)).rejects.toBeInstanceOf(
      FilePlaybackR2WholeBlobAcquirerFatalError,
    );
    expect(first.reserveTransport).not.toHaveBeenCalled();
    expect(first.download).not.toHaveBeenCalled();

    const second = harness();
    const exact = operation();
    const confusedBinding = createFilePlaybackRunBindingV2({
      sessionId: exact.operation.binding.sessionId,
      connectionId: exact.operation.binding.connectionId,
      prepareId: exact.operation.binding.prepareId,
      prepareRevision: exact.operation.binding.prepareRevision,
      queueItemId: '10000000-0000-4000-8000-000000000002' as QueueItemId,
      sourceIdentity: exact.operation.binding.sourceIdentity,
      transferSessionId: exact.operation.binding.transferSessionId,
      runId: exact.operation.binding.runId,
      playbackRevision: exact.operation.binding.playbackRevision,
    });
    const confused = canonical({
      kind: exact.operation.kind,
      offer: exact.operation.offer,
      binding: confusedBinding,
      fence: exact.operation.fence,
    }) as Readonly<FilePlaybackConnectionMediaOperation>;
    await expect(second.acquirer.acquire(confused)).rejects.toBeInstanceOf(
      FilePlaybackR2WholeBlobAcquirerFatalError,
    );
    expect(second.reserveTransport).not.toHaveBeenCalled();
    expect(second.download).not.toHaveBeenCalled();
  });
});

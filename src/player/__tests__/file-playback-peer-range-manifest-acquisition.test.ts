import { afterEach, describe, expect, it, vi } from 'vitest';

const operationAuthority = vi.hoisted(() => ({ trusted: new WeakSet<object>() }));

vi.mock('../file-playback-connection-media-session.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../file-playback-connection-media-session.ts')>();
  return {
    ...actual,
    assertFilePlaybackConnectionMediaOperationCurrent(value: unknown) {
      if (value === null || typeof value !== 'object' || !operationAuthority.trusted.has(value)) {
        throw new Error('File playback media operation is forged or retired');
      }
      const operation = value as Readonly<FilePlaybackConnectionMediaOperation>;
      if (operation.fence.signal.aborted) throw operation.fence.signal.reason;
      let current = false;
      try {
        current = operation.fence.isCurrent() === true;
      } catch {
        if (operation.fence.signal.aborted) throw operation.fence.signal.reason;
      }
      if (operation.fence.signal.aborted) throw operation.fence.signal.reason;
      if (!current) throw new Error('File playback media operation is stale');
    },
  };
});

import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetLease,
} from '../file-playback-asset-registry.ts';
import type { FilePlaybackConnectionMediaOperation } from '../file-playback-connection-media-session.ts';
import {
  acquireFilePlaybackPeerRangeManifestAsset,
  readFilePlaybackPeerRangeManifestAdmission,
  type AcquireFilePlaybackPeerRangeManifestOptions,
  type FilePlaybackPeerRangeManifestAdmission,
} from '../file-playback-peer-range-manifest-acquisition.ts';
import {
  createPeerRangeManifestFileMediaSourceOfferV2,
  type PeerRangeManifestFileMediaSourceOfferV2,
} from '../file-media-source-offer.ts';
import { createFilePlaybackRunBindingV2 } from '../file-playback-run-binding.ts';
import {
  CODEC_TIMELINE_MANIFEST_MAX_BYTES,
  encodeCodecTimelineManifest,
} from '../manifests/codec-timeline-manifest.ts';
import { computeCodecTimelineSourceBindingSha256 } from '../manifests/codec-timeline-source-binding.ts';
import type {
  EncodedAudioSource,
  EncodedAudioSourceMetadata,
} from '../sources/encoded-audio-source.ts';
import type {
  PeerRangeReadRequest,
  PeerRangeTransport,
} from '../sources/peer-range-encoded-audio-source.ts';
import { PEER_RANGE_MAX_READ_BYTES } from '../sources/peer-range-protocol.ts';
import type { QueueItemId } from '../../types/index.ts';

const ROOM_TOKEN = Object.freeze({ room: 'peer-manifest' });
const FOREIGN_ROOM_TOKEN = Object.freeze({ room: 'foreign-peer-manifest' });
const SESSION_ID = 'peer-manifest:session';
const CONNECTION_ID = 'peer-manifest:connection';
const PREPARE_ID = 'a1000000-0000-4000-8000-000000000001';
const QUEUE_ID = 'a1000000-0000-4000-8000-000000000002' as QueueItemId;
const QUEUE_ID_2 = 'a1000000-0000-4000-8000-000000000004' as QueueItemId;
const RUN_ID = 'a1000000-0000-4000-8000-000000000003';
const SOURCE_ID = 'peer-manifest:source';
const TRANSFER_ID = 'peer-manifest:transfer';
const HANDLE_ID = 'peer-manifest:handle';
const NAME = 'bounded.aac';
const MIME = 'audio/aac';

interface Fixture {
  readonly media: Uint8Array;
  readonly manifest: Uint8Array;
  readonly bundle: Uint8Array;
  readonly offer: Readonly<PeerRangeManifestFileMediaSourceOfferV2>;
  readonly operation: Readonly<FilePlaybackConnectionMediaOperation>;
  readonly controller: AbortController;
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function registry(token: object = ROOM_TOKEN): FilePlaybackAssetRegistry {
  return new FilePlaybackAssetRegistry({
    liveRoomToken: token,
    onFatalRoom: vi.fn(),
  });
}

class MemorySource implements EncodedAudioSource {
  readonly kind = 'peer-range' as const;
  readonly size: number;
  readonly identity: string;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;

  constructor(
    readonly bytes: Uint8Array,
    identity = SOURCE_ID,
    metadata: EncodedAudioSourceMetadata = { name: NAME, mime: MIME },
  ) {
    this.size = bytes.byteLength;
    this.identity = identity;
    this.metadata = Object.freeze({ ...metadata });
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw signal.reason;
    return this.bytes.slice(offset, offset + length);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
}

function operationFor(
  offer: Readonly<PeerRangeManifestFileMediaSourceOfferV2>,
  controller = new AbortController(),
  isCurrent: () => boolean = () => true,
): Readonly<FilePlaybackConnectionMediaOperation> {
  const binding = createFilePlaybackRunBindingV2({
    sessionId: offer.sessionId,
    connectionId: offer.connectionId,
    prepareId: offer.prepareId,
    prepareRevision: offer.prepareRevision,
    queueItemId: offer.queueItemId,
    sourceIdentity: offer.sourceIdentity,
    transferSessionId: offer.transferSessionId,
    runId: RUN_ID,
    playbackRevision: 1,
  });
  const operation = freezeCanonical({
    kind: 'baseline' as const,
    offer,
    binding,
    fence: freezeCanonical({
      epoch: Object.freeze(Object.create(null)),
      signal: controller.signal,
      isCurrent,
    }),
  }) as unknown as Readonly<FilePlaybackConnectionMediaOperation>;
  operationAuthority.trusted.add(operation as object);
  return operation;
}

async function fixture(options: { readonly wrongBinding?: boolean } = {}): Promise<Fixture> {
  const media = Uint8Array.from({ length: 16 }, (_value, index) => index + 1);
  const controller = new AbortController();
  const sourceBinding = options.wrongBinding
    ? new Uint8Array(32).fill(0x5a)
    : await computeCodecTimelineSourceBindingSha256(
        {
          schemaVersion: 1,
          queueItemId: QUEUE_ID,
          sourceIdentity: SOURCE_ID,
          transferSessionId: TRANSFER_ID,
          encodedSize: media.byteLength,
          name: NAME,
          mime: MIME,
        },
        new MemorySource(media),
        controller.signal,
      );
  const manifest = encodeCodecTimelineManifest({
    manifestVersion: 1,
    codec: 'adts-aac-lc',
    sourceBindingSha256: Array.from(sourceBinding),
    sourceSize: media.byteLength,
    audioStartByte: 0,
    audioEndByte: media.byteLength,
    frameCount: 2,
    sampleRateHz: 44_100,
    samplesPerFrame: 1_024,
    channels: 2,
    mpegId: 0,
    profile: 1,
    audioObjectType: 2,
    sampleRateIndex: 4,
    channelConfiguration: 2,
    protectionAbsent: true,
    rawDataBlocks: 1,
    points: [
      { frameOrdinal: 0, byteOffset: 0 },
      { frameOrdinal: 1, byteOffset: 8 },
    ],
  });
  const offer = createPeerRangeManifestFileMediaSourceOfferV2({
    sessionId: SESSION_ID,
    connectionId: CONNECTION_ID,
    prepareId: PREPARE_ID,
    prepareRevision: 1,
    queueItemId: QUEUE_ID,
    sourceIdentity: SOURCE_ID,
    transferSessionId: TRANSFER_ID,
    handleId: HANDLE_ID,
    encodedSize: media.byteLength,
    manifestByteLength: manifest.byteLength,
    manifestSha256B64: base64(await sha256(manifest)),
    name: NAME,
    mime: MIME,
    expiresAtRoomTimeMs: 10_000,
  });
  const bundle = new Uint8Array(manifest.byteLength + media.byteLength);
  bundle.set(manifest);
  bundle.set(media, manifest.byteLength);
  return {
    media,
    manifest,
    bundle,
    offer,
    operation: operationFor(offer, controller),
    controller,
  };
}

function memoryTransport(bytes: Uint8Array): PeerRangeTransport & {
  readonly read: ReturnType<typeof vi.fn>;
  readonly closeHandle: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(async (request: PeerRangeReadRequest) => {
    if (request.signal.aborted) throw request.signal.reason;
    return bytes.slice(request.offset, request.offset + request.length);
  });
  const closeHandle = vi.fn();
  return { read, closeHandle };
}

function acquisitionOptions(
  value: Fixture,
  assetRegistry: FilePlaybackAssetRegistry,
  transport: PeerRangeTransport,
  roomToken = ROOM_TOKEN,
): AcquireFilePlaybackPeerRangeManifestOptions {
  return {
    operation: value.operation,
    roomToken,
    registry: assetRegistry,
    transport,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('peer-range manifest-prefix acquisition', () => {
  it('registers only the verified media window and binds opaque evidence to its exact live lease', async () => {
    const value = await fixture();
    const assetRegistry = registry();
    const transport = memoryTransport(value.bundle);
    const acquired = await acquireFilePlaybackPeerRangeManifestAsset(
      acquisitionOptions(value, assetRegistry, transport),
    );

    expect(assetRegistry.activeAssetCount(ROOM_TOKEN)).toBe(1);
    expect(acquired.asset).toMatchObject({
      kind: 'peer-range',
      size: value.media.byteLength,
      sourceIdentity: SOURCE_ID,
      name: NAME,
      mime: MIME,
    });
    expect(
      transport.read.mock.calls.slice(0, 2).map(([request]) => [request.offset, request.length]),
    ).toEqual([
      [0, value.manifest.byteLength],
      [value.manifest.byteLength, value.media.byteLength],
    ]);

    const mediaLease = assetRegistry.acquireSource(ROOM_TOKEN, acquired.assetLease);
    await expect(mediaLease.readAt(0, 4, new AbortController().signal)).resolves.toEqual(
      value.media.slice(0, 4),
    );
    expect(transport.read.mock.calls.at(-1)?.[0]).toMatchObject({
      offset: value.manifest.byteLength,
      length: 4,
    });
    await mediaLease.close();
    expect(transport.closeHandle).not.toHaveBeenCalled();

    expect(Object.keys(acquired.manifestAdmission)).toEqual([]);
    expect(Object.getPrototypeOf(acquired.manifestAdmission)).toBeNull();
    expect(Object.isFrozen(acquired.manifestAdmission)).toBe(true);
    const evidence = readFilePlaybackPeerRangeManifestAdmission(
      acquired.manifestAdmission,
      acquired.assetLease,
    );
    expect(evidence.asset).toBe(acquired.asset);
    expect(evidence.manifest).toMatchObject({
      codec: 'adts-aac-lc',
      sourceSize: value.media.byteLength,
      frameCount: 2,
    });

    const forged = Object.freeze(Object.create(null)) as FilePlaybackPeerRangeManifestAdmission;
    const copied = Object.assign({}, acquired.manifestAdmission);
    const cloned = structuredClone(acquired.manifestAdmission);
    expect(() => readFilePlaybackPeerRangeManifestAdmission(forged, acquired.assetLease)).toThrow(
      /forged|stale/u,
    );
    expect(() =>
      readFilePlaybackPeerRangeManifestAdmission(
        copied as FilePlaybackPeerRangeManifestAdmission,
        acquired.assetLease,
      ),
    ).toThrow(/forged|stale/u);
    expect(() =>
      readFilePlaybackPeerRangeManifestAdmission(
        cloned as FilePlaybackPeerRangeManifestAdmission,
        acquired.assetLease,
      ),
    ).toThrow(/forged|stale/u);
    expect(() =>
      readFilePlaybackPeerRangeManifestAdmission(
        acquired.manifestAdmission,
        Object.freeze(Object.create(null)) as FilePlaybackAssetLease,
      ),
    ).toThrow(/another asset lease/u);

    await assetRegistry.retire(ROOM_TOKEN, acquired.assetLease);
    expect(transport.closeHandle).toHaveBeenCalledOnce();
    expect(() =>
      readFilePlaybackPeerRangeManifestAdmission(acquired.manifestAdmission, acquired.assetLease),
    ).toThrow(/stale/u);
  });

  it('reads a maximum-size manifest sequentially in exactly four bounded requests', async () => {
    const media = Uint8Array.of(1);
    const manifest = new Uint8Array(CODEC_TIMELINE_MANIFEST_MAX_BYTES);
    const offer = createPeerRangeManifestFileMediaSourceOfferV2({
      sessionId: SESSION_ID,
      connectionId: CONNECTION_ID,
      prepareId: PREPARE_ID,
      prepareRevision: 1,
      queueItemId: QUEUE_ID,
      sourceIdentity: SOURCE_ID,
      transferSessionId: TRANSFER_ID,
      handleId: HANDLE_ID,
      encodedSize: media.byteLength,
      manifestByteLength: manifest.byteLength,
      manifestSha256B64: base64(await sha256(manifest)),
      name: NAME,
      mime: MIME,
      expiresAtRoomTimeMs: 10_000,
    });
    const bundle = new Uint8Array(manifest.byteLength + media.byteLength);
    bundle.set(manifest);
    bundle.set(media, manifest.byteLength);
    const controller = new AbortController();
    const value: Fixture = {
      media,
      manifest,
      bundle,
      offer,
      operation: operationFor(offer, controller),
      controller,
    };
    const assetRegistry = registry();
    const transport = memoryTransport(bundle);

    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(value, assetRegistry, transport),
      ),
    ).rejects.toThrow(/canonical/u);
    expect(transport.read).toHaveBeenCalledTimes(4);
    expect(transport.read.mock.calls.map(([request]) => [request.offset, request.length])).toEqual([
      [0, PEER_RANGE_MAX_READ_BYTES],
      [PEER_RANGE_MAX_READ_BYTES, PEER_RANGE_MAX_READ_BYTES],
      [PEER_RANGE_MAX_READ_BYTES * 2, PEER_RANGE_MAX_READ_BYTES],
      [PEER_RANGE_MAX_READ_BYTES * 3, PEER_RANGE_MAX_READ_BYTES],
    ]);
    expect(assetRegistry.activeAssetCount(ROOM_TOKEN)).toBe(0);
    expect(transport.closeHandle).toHaveBeenCalledOnce();
  });

  it('rejects offer-hash and bounded source-binding mismatches without publishing an asset', async () => {
    const valid = await fixture();
    const wrongHashOffer = createPeerRangeManifestFileMediaSourceOfferV2({
      ...valid.offer,
      manifestSha256B64: base64(new Uint8Array(32)),
    });
    const wrongHash: Fixture = {
      ...valid,
      offer: wrongHashOffer,
      operation: operationFor(wrongHashOffer),
    };
    const firstRegistry = registry();
    const firstTransport = memoryTransport(wrongHash.bundle);
    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(wrongHash, firstRegistry, firstTransport),
      ),
    ).rejects.toThrow(/SHA-256 does not match/u);
    expect(firstRegistry.activeAssetCount(ROOM_TOKEN)).toBe(0);
    expect(firstTransport.closeHandle).toHaveBeenCalledOnce();

    const wrongSizeOffer = createPeerRangeManifestFileMediaSourceOfferV2({
      ...valid.offer,
      encodedSize: valid.media.byteLength + 1,
    });
    const wrongSizeBundle = new Uint8Array(valid.manifest.byteLength + wrongSizeOffer.encodedSize);
    wrongSizeBundle.set(valid.manifest);
    wrongSizeBundle.set(valid.media, valid.manifest.byteLength);
    const wrongSize: Fixture = {
      ...valid,
      bundle: wrongSizeBundle,
      offer: wrongSizeOffer,
      operation: operationFor(wrongSizeOffer),
    };
    const sizeRegistry = registry();
    const sizeTransport = memoryTransport(wrongSize.bundle);
    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(wrongSize, sizeRegistry, sizeTransport),
      ),
    ).rejects.toThrow(/sourceSize/u);
    expect(sizeRegistry.activeAssetCount(ROOM_TOKEN)).toBe(0);
    expect(sizeTransport.closeHandle).toHaveBeenCalledOnce();

    const wrongBinding = await fixture({ wrongBinding: true });
    const secondRegistry = registry();
    const secondTransport = memoryTransport(wrongBinding.bundle);
    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(wrongBinding, secondRegistry, secondTransport),
      ),
    ).rejects.toThrow(/source binding/u);
    expect(secondRegistry.activeAssetCount(ROOM_TOKEN)).toBe(0);
    expect(secondTransport.closeHandle).toHaveBeenCalledOnce();
  });

  it('preserves abort reasons and suppresses a transport result that arrives after close', async () => {
    const value = await fixture();
    const gate = deferred<Uint8Array>();
    const read = vi.fn((request: PeerRangeReadRequest) =>
      request.offset === 0
        ? gate.promise
        : Promise.resolve(value.bundle.slice(request.offset, request.offset + request.length)),
    );
    const closeHandle = vi.fn();
    const transport: PeerRangeTransport = { read, closeHandle };
    const assetRegistry = registry();
    const reason = Object.freeze({ phase: 'manifest-read-abort' });
    const task = acquireFilePlaybackPeerRangeManifestAsset(
      acquisitionOptions(value, assetRegistry, transport),
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

    value.controller.abort(reason);
    await expect(task).rejects.toBe(reason);
    gate.resolve(value.manifest.slice());
    await Promise.resolve();
    await Promise.resolve();

    expect(assetRegistry.activeAssetCount(ROOM_TOKEN)).toBe(0);
    expect(closeHandle).toHaveBeenCalledOnce();
  });

  it('does not publish a digest that resolves after abort', async () => {
    const value = await fixture();
    const realCrypto = globalThis.crypto;
    const gate = deferred<ArrayBuffer>();
    const digest = vi.fn(() => gate.promise);
    vi.stubGlobal('crypto', Object.freeze({ subtle: Object.freeze({ digest }) }));
    const assetRegistry = registry();
    const transport = memoryTransport(value.bundle);
    const reason = Object.freeze({ phase: 'manifest-digest-abort' });
    const task = acquireFilePlaybackPeerRangeManifestAsset(
      acquisitionOptions(value, assetRegistry, transport),
    );
    await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());

    value.controller.abort(reason);
    gate.resolve(await realCrypto.subtle.digest('SHA-256', value.manifest));
    await expect(task).rejects.toBe(reason);
    expect(assetRegistry.activeAssetCount(ROOM_TOKEN)).toBe(0);
    expect(transport.closeHandle).toHaveBeenCalledOnce();
  });

  it.each([
    ['typed-array', () => new Uint8Array(32)],
    ['short', () => new ArrayBuffer(31)],
    ['long', () => new ArrayBuffer(33)],
  ] as const)('rejects a noncanonical WebCrypto %s result', async (_label, result) => {
    const value = await fixture();
    const digest = vi.fn(async () => result());
    vi.stubGlobal('crypto', Object.freeze({ subtle: Object.freeze({ digest }) }));
    const assetRegistry = registry();
    const transport = memoryTransport(value.bundle);

    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(value, assetRegistry, transport),
      ),
    ).rejects.toThrow(/SHA-256/u);
    expect(assetRegistry.activeAssetCount(ROOM_TOKEN)).toBe(0);
    expect(transport.closeHandle).toHaveBeenCalledOnce();
  });

  it('rejects SharedArrayBuffer digest storage when the platform exposes it', async () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const value = await fixture();
    const digest = vi.fn(async () => new SharedArrayBuffer(32));
    vi.stubGlobal('crypto', Object.freeze({ subtle: Object.freeze({ digest }) }));
    const assetRegistry = registry();
    const transport = memoryTransport(value.bundle);

    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(value, assetRegistry, transport),
      ),
    ).rejects.toThrow(/SHA-256/u);
    expect(assetRegistry.activeAssetCount(ROOM_TOKEN)).toBe(0);
    expect(transport.closeHandle).toHaveBeenCalledOnce();
  });

  it('deduplicates exact and structurally equivalent live operations before opening one handle', async () => {
    const value = await fixture();
    const firstRead = deferred<Uint8Array>();
    let held = true;
    const read = vi.fn((request: PeerRangeReadRequest) => {
      if (held) {
        held = false;
        return firstRead.promise;
      }
      return Promise.resolve(value.bundle.slice(request.offset, request.offset + request.length));
    });
    const closeHandle = vi.fn();
    const transport: PeerRangeTransport = { read, closeHandle };
    const assetRegistry = registry();
    const options = acquisitionOptions(value, assetRegistry, transport);
    const first = acquireFilePlaybackPeerRangeManifestAsset(options);
    const joined = acquireFilePlaybackPeerRangeManifestAsset(options);
    const equivalentValue: Fixture = {
      ...value,
      operation: operationFor(value.offer),
    };
    const equivalent = acquireFilePlaybackPeerRangeManifestAsset(
      acquisitionOptions(equivalentValue, assetRegistry, transport),
    );
    expect(joined).toBe(first);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    firstRead.resolve(value.manifest.slice());
    const acquired = await first;
    await expect(joined).resolves.toBe(acquired);
    await expect(equivalent).resolves.toBe(acquired);
    const readsAfterFirst = read.mock.calls.length;

    await expect(acquireFilePlaybackPeerRangeManifestAsset(options)).resolves.toBe(acquired);
    expect(read).toHaveBeenCalledTimes(readsAfterFirst);

    const changedOffer = createPeerRangeManifestFileMediaSourceOfferV2({
      ...value.offer,
      handleId: 'peer-manifest:changed-handle',
    });
    const changed: Fixture = {
      ...value,
      offer: changedOffer,
      operation: operationFor(changedOffer),
    };
    const changedTransport = memoryTransport(value.bundle);
    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(changed, assetRegistry, changedTransport),
      ),
    ).rejects.toThrow(/no matching manifest admission/u);
    expect(changedTransport.read).not.toHaveBeenCalled();

    await assetRegistry.retire(ROOM_TOKEN, acquired.assetLease);
    expect(closeHandle).toHaveBeenCalledOnce();
  });

  it('keeps one persistent handle owner across live conflicts and tombstones a failed handle', async () => {
    const value = await fixture();
    const assetRegistry = registry();
    const transport = memoryTransport(value.bundle);
    const acquired = await acquireFilePlaybackPeerRangeManifestAsset(
      acquisitionOptions(value, assetRegistry, transport),
    );
    const readsAfterAdmission = transport.read.mock.calls.length;

    const conflictingOffer = createPeerRangeManifestFileMediaSourceOfferV2({
      ...value.offer,
      queueItemId: QUEUE_ID_2,
      transferSessionId: 'peer-manifest:conflicting-transfer',
    });
    const conflicting: Fixture = {
      ...value,
      offer: conflictingOffer,
      operation: operationFor(conflictingOffer),
    };
    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(conflicting, assetRegistry, transport),
      ),
    ).rejects.toThrow(/handle.*another exact offer/u);
    expect(transport.read).toHaveBeenCalledTimes(readsAfterAdmission);
    expect(transport.closeHandle).not.toHaveBeenCalled();
    await assetRegistry.retire(ROOM_TOKEN, acquired.assetLease);
    expect(transport.closeHandle).toHaveBeenCalledOnce();

    const failed = await fixture();
    const failedOffer = createPeerRangeManifestFileMediaSourceOfferV2({
      ...failed.offer,
      manifestSha256B64: base64(new Uint8Array(32)),
    });
    const failedValue: Fixture = {
      ...failed,
      offer: failedOffer,
      operation: operationFor(failedOffer),
    };
    const failedRegistry = registry();
    const failedTransport = memoryTransport(failed.bundle);
    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(failedValue, failedRegistry, failedTransport),
      ),
    ).rejects.toThrow(/SHA-256 does not match/u);
    const failedReads = failedTransport.read.mock.calls.length;
    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(
          { ...failedValue, operation: operationFor(failedOffer) },
          failedRegistry,
          failedTransport,
        ),
      ),
    ).rejects.toThrow(/permanently closed/u);
    expect(failedTransport.read).toHaveBeenCalledTimes(failedReads);
    expect(failedTransport.closeHandle).toHaveBeenCalledOnce();

    const replacementOffer = createPeerRangeManifestFileMediaSourceOfferV2({
      ...failed.offer,
      handleId: 'peer-manifest:replacement-handle',
    });
    const replacement = await acquireFilePlaybackPeerRangeManifestAsset(
      acquisitionOptions(
        { ...failed, offer: replacementOffer, operation: operationFor(replacementOffer) },
        failedRegistry,
        failedTransport,
      ),
    );
    expect(replacement.asset.sourceIdentity).toBe(SOURCE_ID);
    await failedRegistry.retire(ROOM_TOKEN, replacement.assetLease);
    expect(failedTransport.closeHandle).toHaveBeenCalledTimes(2);
  });

  it('rejects a registry-owned source identity before constructing a peer handle wrapper', async () => {
    const value = await fixture();
    const assetRegistry = registry();
    const occupiedLease = assetRegistry.admitBlob(
      ROOM_TOKEN,
      {
        queueItemId: QUEUE_ID_2,
        sourceIdentity: SOURCE_ID,
        transferSessionId: 'peer-manifest:occupied-transfer',
      },
      new Blob([Uint8Array.of(1)], { type: MIME }),
      { name: 'occupied.aac', mime: MIME },
    );
    const transport = memoryTransport(value.bundle);

    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(value, assetRegistry, transport),
      ),
    ).rejects.toThrow(/source identity.*already owned/u);
    expect(transport.read).not.toHaveBeenCalled();
    expect(transport.closeHandle).not.toHaveBeenCalled();
    await assetRegistry.retire(ROOM_TOKEN, occupiedLease);
  });

  it('retires the exact registry lease if opaque admission publication fails after commit', async () => {
    const value = await fixture();
    const assetRegistry = registry();
    const transport = memoryTransport(value.bundle);
    const weakMapSet = WeakMap.prototype.set;
    let publicationSets = 0;
    vi.spyOn(WeakMap.prototype, 'set').mockImplementation(function (key, record) {
      const candidate = record as Record<string, unknown> | null;
      const isAdmissionRecord =
        candidate !== null &&
        typeof candidate === 'object' &&
        candidate.registry === assetRegistry &&
        candidate.roomToken === ROOM_TOKEN &&
        'authority' in candidate &&
        'evidence' in candidate;
      const result = Reflect.apply(weakMapSet, this, [key, record]);
      if (isAdmissionRecord && ++publicationSets === 2) {
        throw new Error('injected second admission-index failure');
      }
      return result;
    });

    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(value, assetRegistry, transport),
      ),
    ).rejects.toThrow(/second admission-index failure/u);
    expect(publicationSets).toBe(2);
    expect(assetRegistry.activeAssetCount(ROOM_TOKEN)).toBe(0);
    expect(transport.closeHandle).toHaveBeenCalledOnce();
  });

  it('rejects a foreign room token before claiming its handle and permits the correct owner', async () => {
    const value = await fixture();
    const assetRegistry = registry();
    const transport = memoryTransport(value.bundle);

    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        acquisitionOptions(value, assetRegistry, transport, FOREIGN_ROOM_TOKEN),
      ),
    ).rejects.toThrow(/room token/u);
    expect(assetRegistry.activeAssetCount(ROOM_TOKEN)).toBe(0);
    expect(transport.read).not.toHaveBeenCalled();
    expect(transport.closeHandle).not.toHaveBeenCalled();

    const acquired = await acquireFilePlaybackPeerRangeManifestAsset(
      acquisitionOptions(value, assetRegistry, transport),
    );
    expect(acquired.asset.sourceIdentity).toBe(SOURCE_ID);
    await assetRegistry.retire(ROOM_TOKEN, acquired.assetLease);
    expect(transport.closeHandle).toHaveBeenCalledOnce();
  });

  it('rejects accessors, operation mismatches, and throwing currentness without invoking transport', async () => {
    const value = await fixture();
    const assetRegistry = registry();
    const transport = memoryTransport(value.bundle);
    let getterCalls = 0;
    const accessorOptions = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(
      acquisitionOptions(value, assetRegistry, transport),
    )) {
      Object.defineProperty(accessorOptions, key, {
        enumerable: true,
        ...(key === 'transport'
          ? {
              get() {
                getterCalls += 1;
                return entry;
              },
            }
          : { value: entry }),
      });
    }
    await expect(
      acquireFilePlaybackPeerRangeManifestAsset(
        accessorOptions as unknown as AcquireFilePlaybackPeerRangeManifestOptions,
      ),
    ).rejects.toThrow(/options/u);
    expect(getterCalls).toBe(0);

    const throwingOperation = operationFor(value.offer, new AbortController(), () => {
      throw new Error('hostile-currentness');
    });
    await expect(
      acquireFilePlaybackPeerRangeManifestAsset({
        operation: throwingOperation,
        registry: assetRegistry,
        roomToken: ROOM_TOKEN,
        transport,
      }),
    ).rejects.toThrow(/stale/u);
    expect(transport.read).not.toHaveBeenCalled();

    const lookalike = Object.freeze({ ...value.operation }) as FilePlaybackConnectionMediaOperation;
    await expect(
      acquireFilePlaybackPeerRangeManifestAsset({
        operation: lookalike,
        registry: assetRegistry,
        roomToken: ROOM_TOKEN,
        transport,
      }),
    ).rejects.toThrow(/forged|retired/u);
    expect(transport.read).not.toHaveBeenCalled();

    const mismatchedBinding = createFilePlaybackRunBindingV2({
      sessionId: value.offer.sessionId,
      connectionId: value.offer.connectionId,
      prepareId: value.offer.prepareId,
      prepareRevision: value.offer.prepareRevision,
      queueItemId: value.offer.queueItemId,
      sourceIdentity: value.offer.sourceIdentity,
      transferSessionId: 'peer-manifest:mismatched-transfer',
      runId: RUN_ID,
      playbackRevision: 1,
    });
    const mismatchOperation = freezeCanonical({
      kind: 'baseline' as const,
      offer: value.offer,
      binding: mismatchedBinding,
      fence: freezeCanonical({
        epoch: Object.freeze(Object.create(null)),
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
    }) as unknown as FilePlaybackConnectionMediaOperation;
    await expect(
      acquireFilePlaybackPeerRangeManifestAsset({
        operation: mismatchOperation,
        registry: assetRegistry,
        roomToken: ROOM_TOKEN,
        transport,
      }),
    ).rejects.toThrow(/forged|retired/u);
    expect(transport.read).not.toHaveBeenCalled();
  });
});

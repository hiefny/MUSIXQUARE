import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
} from '../file-playback-asset-registry.ts';
import {
  stageFilePlaybackAssetSource,
  type FilePlaybackAssetSourceStagerRuntimeForTests,
  type StageFilePlaybackAssetSourceOptions,
} from '../file-playback-asset-source-stager.ts';
import { FilePlaybackManager } from '../file-playback-manager.ts';
import type { FilePlaybackCutoverSource } from '../file-playback-source.ts';
import {
  createBlobFilePlaybackSource,
  type BlobFilePlaybackSourceResult,
  type CreateBlobFilePlaybackSourceOptions,
} from '../file-playback-source-factory.ts';
import type { EncodedAudioAsset } from '../sources/encoded-audio-asset.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';

const TOKEN = Object.freeze({ room: 'asset-source-stager' });
const QID = '91000000-0000-4000-8000-000000000001' as QueueItemId;
const BINDING: FilePlaybackAssetBinding = Object.freeze({
  queueItemId: QID,
  sourceIdentity: 'distributed-source:asset-source-stager',
  transferSessionId: 'transfer-session:asset-source-stager',
});
const METADATA = Object.freeze({ name: 'session-take.mp3', mime: 'audio/mpeg' });
const PORT = Object.freeze(Object.create(null));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeAudioBuffer(): AudioBuffer {
  return {
    duration: 12,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: 576_000,
  } as AudioBuffer;
}

function fakeCutoverSource(
  backend: 'audio-buffer' | 'bounded-stream' = 'audio-buffer',
  destroy = vi.fn(async () => undefined),
): FilePlaybackCutoverSource & { readonly backend: typeof backend } {
  return {
    queueItemId: QID,
    backend,
    prepare: vi.fn(async () => ({}) as never),
    connect: vi.fn(async () => ({}) as never),
    arm: vi.fn(async () => ({}) as never),
    armForCutover: vi.fn(async () => ({}) as never),
    finalize: vi.fn(async () => ({}) as never),
    cancel: vi.fn(async () => ({}) as never),
    pause: vi.fn(async () => ({}) as never),
    pauseRevisioned: vi.fn(async () => ({}) as never),
    seek: vi.fn(async () => ({}) as never),
    seekRevisioned: vi.fn(async () => ({}) as never),
    positionAt: vi.fn(() => ({}) as never),
    getSnapshot: vi.fn(() => ({
      schemaVersion: 1,
      queueItemId: QID,
      backend,
      phase: 'connected',
      revision: 0,
      run: null,
      durationSeconds: 12,
      positionSeconds: 0,
      bufferedAheadSeconds: backend === 'bounded-stream' ? 4 : 12,
      outputSampleRateHz: 48_000,
      channelCount: 2,
      underrunCount: 0,
      errorCode: null,
    })),
    destroy,
  };
}

function factoryResult(
  source: FilePlaybackCutoverSource,
  releaseConstructionLease = vi.fn(),
): BlobFilePlaybackSourceResult {
  if (source.backend === 'audio-buffer') {
    return Object.freeze({
      backend: 'audio-buffer' as const,
      source: source as never,
      sourceIdentity: BINDING.sourceIdentity,
      audioBuffer: fakeAudioBuffer(),
      releaseConstructionLease,
    });
  }
  return Object.freeze({
    backend: 'bounded-stream' as const,
    source: source as never,
    sourceIdentity: BINDING.sourceIdentity,
    releaseConstructionLease,
  });
}

function blobRegistry(
  blob = new Blob([new Uint8Array([0x49, 0x44, 0x33, 0x04])], {
    type: METADATA.mime,
  }),
) {
  const fatal = vi.fn();
  const registry = new FilePlaybackAssetRegistry({ liveRoomToken: TOKEN, onFatalRoom: fatal });
  const lease = registry.admitBlob(TOKEN, BINDING, blob, METADATA);
  return { registry, lease, blob, fatal };
}

function genericRegistry() {
  const closeSource = vi.fn(async () => undefined);
  const closeAsset = vi.fn(async () => undefined);
  const source: EncodedAudioSource = {
    kind: 'peer-range',
    size: 16,
    identity: BINDING.sourceIdentity,
    metadata: METADATA,
    readAt: vi.fn(async (_offset, length) => new Uint8Array(length)),
    close: closeSource,
  };
  const asset: EncodedAudioAsset = {
    kind: 'peer-range',
    size: 16,
    identity: BINDING.sourceIdentity,
    metadata: METADATA,
    activeLeaseCount: 0,
    acquire: vi.fn(() => source),
    close: closeAsset,
  };
  const fatal = vi.fn();
  const registry = new FilePlaybackAssetRegistry({ liveRoomToken: TOKEN, onFatalRoom: fatal });
  const lease = registry.admitEncodedAsset(TOKEN, BINDING, asset);
  return { registry, lease, asset, source, closeSource, closeAsset, fatal };
}

function baseOptions(
  registry: FilePlaybackAssetRegistry,
  lease: FilePlaybackAssetLease,
  runtime: FilePlaybackAssetSourceStagerRuntimeForTests,
  overrides: Partial<StageFilePlaybackAssetSourceOptions> = {},
): StageFilePlaybackAssetSourceOptions {
  return {
    registry,
    roomToken: TOKEN,
    assetLease: lease,
    expectedBinding: BINDING,
    manager: new FilePlaybackManager(),
    audioContext: { sampleRate: 48_000, currentTime: 0 } as AudioContext,
    destination: {} as AudioNode,
    clockBindings: {
      nowRoomTimeMs: () => 1_000,
      roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
      localPerformanceMsToContextTime: (localTimeMs) => localTimeMs / 1_000,
    },
    signal: new AbortController().signal,
    isCurrent: () => true,
    decodeOrdinaryAudio: vi.fn(async () => ({
      audioBuffer: fakeAudioBuffer(),
      release: vi.fn(),
    })),
    runtime,
    ...overrides,
  };
}

function successfulRuntime(
  result: BlobFilePlaybackSourceResult,
  overrides: Partial<FilePlaybackAssetSourceStagerRuntimeForTests> = {},
) {
  const createBlobSource = vi.fn(async () => result);
  const createEncodedSource = vi.fn(async () => result);
  const stageCandidate = vi.fn(async () => PORT as never);
  const retireCandidate = vi.fn(async () => true);
  return {
    runtime: {
      createBlobSource,
      createEncodedSource,
      stageCandidate,
      retireCandidate,
      ...overrides,
    },
    createBlobSource,
    createEncodedSource,
    stageCandidate,
    retireCandidate,
  };
}

function uint64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function nativeFlacBlob(): Blob {
  const info = new Uint8Array(34);
  info[0] = 0x10;
  info[1] = 0x00;
  info[2] = 0x10;
  info[3] = 0x00;
  const packed = (48_000n << 44n) | (1n << 41n) | (23n << 36n) | BigInt(48_000 * 2);
  info.set(uint64(packed), 10);
  return new Blob(
    [
      new Uint8Array([0x66, 0x4c, 0x61, 0x43]),
      new Uint8Array([0x80, 0x00, 0x00, 0x22]),
      info,
      new Uint8Array([0xff, 0xf8]),
    ],
    { type: 'audio/flac' },
  );
}

function nativeWaveBlob(): Blob {
  const bytes = new Uint8Array(60);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 192_000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, 16, true);
  return new Blob([bytes], { type: 'audio/wav' });
}

describe('stageFilePlaybackAssetSource', () => {
  it('forwards the exact Blob, distributed identity, and canonical metadata once', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const release = vi.fn();
    const h = successfulRuntime(factoryResult(source, release));

    const staged = await stageFilePlaybackAssetSource(
      baseOptions(setup.registry, setup.lease, h.runtime),
    );

    expect(h.createBlobSource).toHaveBeenCalledOnce();
    const request = h.createBlobSource.mock.calls[0]?.[0];
    expect(request?.blob).toBe(setup.blob);
    expect(request?.sourceIdentity).toBe(BINDING.sourceIdentity);
    expect(request?.sourceMetadata).toEqual(METADATA);
    expect(Object.getPrototypeOf(request?.sourceMetadata)).toBeNull();
    expect(Object.isFrozen(request?.sourceMetadata)).toBe(true);
    expect(h.createEncodedSource).not.toHaveBeenCalled();
    expect(h.stageCandidate).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(source.destroy).not.toHaveBeenCalled();
    expect(staged.sourceIdentity).toBe(BINDING.sourceIdentity);
  });

  it('acquires one generic source lease and transfers it only to the encoded factory', async () => {
    const setup = genericRegistry();
    const source = fakeCutoverSource('bounded-stream');
    const h = successfulRuntime(factoryResult(source));

    await stageFilePlaybackAssetSource(baseOptions(setup.registry, setup.lease, h.runtime));

    expect(setup.asset.acquire).toHaveBeenCalledOnce();
    expect(h.createEncodedSource).toHaveBeenCalledOnce();
    expect(h.createEncodedSource.mock.calls[0]?.[0].encodedSource.identity).toBe(
      BINDING.sourceIdentity,
    );
    expect(h.createBlobSource).not.toHaveBeenCalled();
    expect(setup.closeSource).not.toHaveBeenCalled();
  });

  it.each([
    ['ordinary', new Blob([new Uint8Array([0x49, 0x44, 0x33, 0x04])]), 'audio-buffer', METADATA],
    [
      'native FLAC',
      nativeFlacBlob(),
      'bounded-stream',
      { name: 'orchestra.flac', mime: 'audio/flac' },
    ],
    ['WAVE PCM', nativeWaveBlob(), 'bounded-stream', { name: 'orchestra.wav', mime: 'audio/wav' }],
  ] as const)(
    'keeps committed factory routing for %s Blob assets',
    async (_label, blob, backend, metadata) => {
      const registry = new FilePlaybackAssetRegistry({
        liveRoomToken: TOKEN,
        onFatalRoom: vi.fn(),
      });
      const lease = registry.admitBlob(TOKEN, BINDING, blob, metadata);
      const decoderRelease = vi.fn();
      const decodeOrdinaryAudio = vi.fn(async () => ({
        audioBuffer: fakeAudioBuffer(),
        release: decoderRelease,
      }));
      const createdSource = fakeCutoverSource(backend);
      const createBlobSource = (options: CreateBlobFilePlaybackSourceOptions) =>
        createBlobFilePlaybackSource({
          ...options,
          backendFactories: {
            createAudioBufferSource: () => createdSource as never,
            createStreamingFlacSource: () => createdSource as never,
            createStreamingWaveSource: () => createdSource as never,
          },
        });
      const stageCandidate = vi.fn(async () => PORT as never);

      const staged = await stageFilePlaybackAssetSource(
        baseOptions(registry, lease, { createBlobSource, stageCandidate }, { decodeOrdinaryAudio }),
      );

      expect(staged.backend).toBe(backend);
      expect(decodeOrdinaryAudio).toHaveBeenCalledTimes(backend === 'audio-buffer' ? 1 : 0);
      expect(decoderRelease).toHaveBeenCalledTimes(backend === 'audio-buffer' ? 1 : 0);
    },
  );

  it('destroys and releases a factory result superseded while its factory was pending', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const release = vi.fn();
    const pending = deferred<BlobFilePlaybackSourceResult>();
    let current = true;
    const stageCandidate = vi.fn(async () => PORT as never);
    const promise = stageFilePlaybackAssetSource(
      baseOptions(
        setup.registry,
        setup.lease,
        { createBlobSource: () => pending.promise, stageCandidate },
        { isCurrent: () => current },
      ),
    );
    await vi.waitFor(() => expect(pending.resolve).toBeTypeOf('function'));
    current = false;
    pending.resolve(factoryResult(source, release));

    await expect(promise).rejects.toThrow(/superseded/u);
    expect(source.destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(stageCandidate).not.toHaveBeenCalled();
  });

  it('destroys a factory result when abort wins the factory await boundary', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const release = vi.fn();
    const pending = deferred<BlobFilePlaybackSourceResult>();
    const abort = new AbortController();
    const promise = stageFilePlaybackAssetSource(
      baseOptions(
        setup.registry,
        setup.lease,
        { createBlobSource: () => pending.promise },
        { signal: abort.signal },
      ),
    );
    abort.abort(new Error('room closed'));
    pending.resolve(factoryResult(source, release));

    await expect(promise).rejects.toThrow('room closed');
    expect(source.destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('retires only the exact resolved candidate when authority expires during manager staging', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const release = vi.fn();
    const pendingStage = deferred<never>();
    let current = true;
    const retireCandidate = vi.fn(async () => true);
    const stageCandidate = vi.fn(() => pendingStage.promise);
    const promise = stageFilePlaybackAssetSource(
      baseOptions(
        setup.registry,
        setup.lease,
        {
          createBlobSource: async () => factoryResult(source, release),
          stageCandidate,
          retireCandidate,
        },
        { isCurrent: () => current },
      ),
    );
    await vi.waitFor(() => expect(stageCandidate).toHaveBeenCalledOnce());
    current = false;
    pendingStage.resolve(PORT as never);

    await expect(promise).rejects.toThrow(/superseded/u);
    expect(retireCandidate).toHaveBeenCalledOnce();
    expect(retireCandidate.mock.calls[0]?.[1]).toBe(PORT);
    expect(source.destroy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('retires only the exact resolved candidate when abort wins manager staging', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const pendingStage = deferred<never>();
    const abort = new AbortController();
    const retireCandidate = vi.fn(async () => true);
    const stageCandidate = vi.fn(() => pendingStage.promise);
    const promise = stageFilePlaybackAssetSource(
      baseOptions(
        setup.registry,
        setup.lease,
        {
          createBlobSource: async () => factoryResult(source),
          stageCandidate,
          retireCandidate,
        },
        { signal: abort.signal },
      ),
    );
    await vi.waitFor(() => expect(stageCandidate).toHaveBeenCalledOnce());
    abort.abort(new Error('room closed while staging'));
    pendingStage.resolve(PORT as never);

    await expect(promise).rejects.toThrow('room closed while staging');
    expect(retireCandidate).toHaveBeenCalledOnce();
    expect(retireCandidate.mock.calls[0]?.[1]).toBe(PORT);
    expect(source.destroy).not.toHaveBeenCalled();
  });

  it('retires the exact staged candidate instead of publishing invalid readiness', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    vi.mocked(source.getSnapshot).mockReturnValue({
      schemaVersion: 1,
      queueItemId: QID,
      backend: 'audio-buffer',
      phase: 'connected',
      revision: 0,
      run: null,
      durationSeconds: null,
      positionSeconds: 0,
      bufferedAheadSeconds: 0,
      outputSampleRateHz: null,
      channelCount: null,
      underrunCount: 0,
      errorCode: null,
    });
    const h = successfulRuntime(factoryResult(source));

    await expect(
      stageFilePlaybackAssetSource(baseOptions(setup.registry, setup.lease, h.runtime)),
    ).rejects.toThrow(/readiness/u);
    expect(h.retireCandidate).toHaveBeenCalledOnce();
  });

  it('does not publish readiness when authority changes during its exact snapshot', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const exactSnapshot = source.getSnapshot();
    let current = true;
    vi.mocked(source.getSnapshot).mockImplementation(() => {
      current = false;
      return exactSnapshot;
    });
    const h = successfulRuntime(factoryResult(source));

    await expect(
      stageFilePlaybackAssetSource(
        baseOptions(setup.registry, setup.lease, h.runtime, { isCurrent: () => current }),
      ),
    ).rejects.toThrow(/superseded/u);
    expect(h.retireCandidate).toHaveBeenCalledOnce();
  });

  it('lets manager rejection own source destruction without a second destroy', async () => {
    const setup = blobRegistry();
    const destroy = vi.fn(async () => undefined);
    const source = fakeCutoverSource('audio-buffer', destroy);
    const release = vi.fn();
    const stageError = new Error('manager rejected');
    const stageCandidate = vi.fn(async (_manager, options) => {
      await options.source.destroy();
      throw stageError;
    });

    await expect(
      stageFilePlaybackAssetSource(
        baseOptions(setup.registry, setup.lease, {
          createBlobSource: async () => factoryResult(source, release),
          stageCandidate,
        }),
      ),
    ).rejects.toBe(stageError);
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('destroys before handoff when staging throws synchronously', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const release = vi.fn();
    const stageError = new Error('stage invocation failed');

    await expect(
      stageFilePlaybackAssetSource(
        baseOptions(setup.registry, setup.lease, {
          createBlobSource: async () => factoryResult(source, release),
          stageCandidate: () => {
            throw stageError;
          },
        }),
      ),
    ).rejects.toBe(stageError);
    expect(source.destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('retires a staged candidate when construction release throws', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const releaseError = new Error('decode reservation release failed');
    const release = vi.fn(() => {
      throw releaseError;
    });
    const h = successfulRuntime(factoryResult(source, release));

    await expect(
      stageFilePlaybackAssetSource(baseOptions(setup.registry, setup.lease, h.runtime)),
    ).rejects.toBe(releaseError);
    expect(release).toHaveBeenCalledOnce();
    expect(h.retireCandidate).toHaveBeenCalledOnce();
    expect(source.destroy).not.toHaveBeenCalled();
  });

  it('preserves factory failure while generic synchronous handoff cleanup closes once', async () => {
    const setup = genericRegistry();
    const factoryError = new Error('generic factory failed');

    await expect(
      stageFilePlaybackAssetSource(
        baseOptions(setup.registry, setup.lease, {
          createEncodedSource: () => {
            throw factoryError;
          },
        }),
      ),
    ).rejects.toBe(factoryError);
    expect(setup.closeSource).toHaveBeenCalledOnce();
  });

  it('closes a generic source lease when a forged factory returns a non-Promise', async () => {
    const setup = genericRegistry();

    await expect(
      stageFilePlaybackAssetSource(
        baseOptions(setup.registry, setup.lease, {
          createEncodedSource: (() => Object.freeze({})) as never,
        }),
      ),
    ).rejects.toThrow(/native Promise/u);
    expect(setup.closeSource).toHaveBeenCalledOnce();
  });

  it.each(['forged', 'retired'] as const)(
    'rejects a %s asset lease before construction',
    async (mode) => {
      const setup = blobRegistry();
      const lease =
        mode === 'forged'
          ? (Object.freeze(Object.create(null)) as FilePlaybackAssetLease)
          : setup.lease;
      if (mode === 'retired') await setup.registry.retire(TOKEN, setup.lease);
      const createBlobSource = vi.fn(async () => factoryResult(fakeCutoverSource()));

      await expect(
        stageFilePlaybackAssetSource(baseOptions(setup.registry, lease, { createBlobSource })),
      ).rejects.toThrow(/stale/u);
      expect(createBlobSource).not.toHaveBeenCalled();
    },
  );

  it('rejects a valid but mismatched expected binding before factory work', async () => {
    const setup = blobRegistry();
    const createBlobSource = vi.fn(async () => factoryResult(fakeCutoverSource()));
    const mismatchedBinding: FilePlaybackAssetBinding = {
      queueItemId: '91000000-0000-4000-8000-000000000002',
      sourceIdentity: 'distributed-source:other',
      transferSessionId: 'transfer-session:other',
    };

    await expect(
      stageFilePlaybackAssetSource(
        baseOptions(
          setup.registry,
          setup.lease,
          { createBlobSource },
          { expectedBinding: mismatchedBinding },
        ),
      ),
    ).rejects.toThrow(/stale/u);
    expect(createBlobSource).not.toHaveBeenCalled();
  });

  it('rejects hostile accessors without invoking them', async () => {
    const setup = blobRegistry();
    const getter = vi.fn(() => setup.registry);
    const options = baseOptions(setup.registry, setup.lease, {});
    Object.defineProperty(options, 'registry', { enumerable: true, get: getter });

    await expect(stageFilePlaybackAssetSource(options)).rejects.toThrow(/options/u);
    expect(getter).not.toHaveBeenCalled();
  });

  it('detects authority-callback retirement reentry before factory work', async () => {
    const setup = blobRegistry();
    const createBlobSource = vi.fn(async () => factoryResult(fakeCutoverSource()));
    let retired = false;

    await expect(
      stageFilePlaybackAssetSource(
        baseOptions(
          setup.registry,
          setup.lease,
          { createBlobSource },
          {
            isCurrent: () => {
              if (!retired) {
                retired = true;
                void setup.registry.retire(TOKEN, setup.lease);
              }
              return true;
            },
          },
        ),
      ),
    ).rejects.toThrow(/changed/u);
    expect(createBlobSource).not.toHaveBeenCalled();
  });

  it('returns a deeply body-free frozen canonical runtime record', async () => {
    const setup = blobRegistry();
    const h = successfulRuntime(factoryResult(fakeCutoverSource()));

    const staged = await stageFilePlaybackAssetSource(
      baseOptions(setup.registry, setup.lease, h.runtime),
    );

    expect(staged).toEqual({
      cutoverPort: PORT,
      backend: 'audio-buffer',
      sourceIdentity: BINDING.sourceIdentity,
      asset: {
        ...BINDING,
        kind: 'blob',
        size: setup.blob.size,
        ...METADATA,
      },
      metadata: METADATA,
      readiness: {
        durationSeconds: 12,
        bufferedAheadSeconds: 12,
        outputSampleRateHz: 48_000,
        channelCount: 2,
      },
    });
    expect(Object.getPrototypeOf(staged)).toBeNull();
    expect(Object.isFrozen(staged)).toBe(true);
    expect(Object.getPrototypeOf(staged.asset)).toBeNull();
    expect(Object.isFrozen(staged.asset)).toBe(true);
    expect(Object.getPrototypeOf(staged.metadata)).toBeNull();
    expect(Object.isFrozen(staged.metadata)).toBe(true);
    expect(Object.getPrototypeOf(staged.readiness)).toBeNull();
    expect(Object.isFrozen(staged.readiness)).toBe(true);
    expect(JSON.stringify(staged)).not.toMatch(/"blob":|audioBuffer|"source":|arrayBuffer/u);
  });
});

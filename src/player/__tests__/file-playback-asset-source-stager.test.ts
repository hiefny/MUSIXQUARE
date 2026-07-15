import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
  type FilePlaybackBoundedRoutePolicy,
} from '../file-playback-bounded-route-policy.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
} from '../file-playback-asset-registry.ts';
import {
  handoffFilePlaybackAssetSourceWarm,
  prepareFilePlaybackAssetSourceWarm,
  readFilePlaybackAssetSourceWarmReadiness,
  retireFilePlaybackAssetSourceWarm,
  stageFilePlaybackAssetSource,
  type FilePlaybackAssetSourceStagerRuntimeForTests,
  type PrepareFilePlaybackAssetSourceWarmOptions,
  type StageFilePlaybackAssetSourceOptions,
} from '../file-playback-asset-source-stager.ts';
import { FilePlaybackManager } from '../file-playback-manager.ts';
import type { FilePlaybackCutoverSource } from '../file-playback-source.ts';
import {
  codecTimelineHostArtifactForFilePlaybackSourceResult,
  createBlobFilePlaybackSource,
  createEncodedFilePlaybackSource,
  type BlobFilePlaybackSourceResult,
  type CreateBlobFilePlaybackSourceOptions,
} from '../file-playback-source-factory.ts';
import {
  describeCodecTimelineHostArtifactForLease,
  installCodecTimelineHostArtifactForLease,
} from '../manifests/codec-timeline-host-artifact-lease-store.ts';
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

function managerAudioGraph(): {
  readonly context: AudioContext;
  readonly destination: AudioNode;
} {
  const createGain = vi.fn();
  const context = {
    currentTime: 0,
    sampleRate: 48_000,
    createGain,
  } as unknown as AudioContext;
  const gate = {
    context,
    gain: {
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as GainNode;
  createGain.mockReturnValue(gate);
  return { context, destination: { context } as AudioNode };
}

function fakeCutoverSource(
  backend: 'audio-buffer' | 'bounded-stream' = 'audio-buffer',
  destroy = vi.fn(async () => undefined),
  connectedBufferedAheadSeconds = backend === 'bounded-stream' ? 4 : 12,
): FilePlaybackCutoverSource & { readonly backend: typeof backend } {
  let phase: 'new' | 'ready' | 'connected' = 'new';
  const getSnapshot = vi.fn(() => ({
    schemaVersion: 1 as const,
    queueItemId: QID,
    backend,
    phase,
    revision: 0,
    run: null,
    durationSeconds: phase === 'new' ? null : 12,
    positionSeconds: 0,
    bufferedAheadSeconds:
      phase === 'new'
        ? 0
        : phase === 'connected'
          ? connectedBufferedAheadSeconds
          : backend === 'bounded-stream'
            ? 4
            : 12,
    outputSampleRateHz: phase === 'new' ? null : 48_000,
    channelCount: phase === 'new' ? null : 2,
    underrunCount: 0,
    errorCode: null,
  }));
  return {
    queueItemId: QID,
    backend,
    prepare: vi.fn(async () => {
      phase = 'ready';
      return getSnapshot();
    }),
    connect: vi.fn(async () => {
      phase = 'connected';
      return getSnapshot();
    }),
    primeForCutover: vi.fn(async (_positionSeconds, signal) => {
      signal.throwIfAborted();
      return getSnapshot();
    }),
    arm: vi.fn(async () => ({}) as never),
    armForCutover: vi.fn(async () => ({}) as never),
    finalize: vi.fn(async () => ({}) as never),
    cancel: vi.fn(async () => ({}) as never),
    pause: vi.fn(async () => ({}) as never),
    pauseRevisioned: vi.fn(async () => ({}) as never),
    seek: vi.fn(async () => ({}) as never),
    seekRevisioned: vi.fn(async () => ({}) as never),
    positionAt: vi.fn(() => ({}) as never),
    getSnapshot,
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

function genericRegistry(
  bytes: Uint8Array = new Uint8Array(16),
  metadata: Readonly<{ readonly name: string; readonly mime: string }> = METADATA,
) {
  const closeSource = vi.fn(async () => undefined);
  const closeAsset = vi.fn(async () => undefined);
  const source: EncodedAudioSource = {
    kind: 'peer-range',
    size: bytes.byteLength,
    identity: BINDING.sourceIdentity,
    metadata,
    readAt: vi.fn(async (offset, length, signal) => {
      signal.throwIfAborted();
      return bytes.slice(offset, offset + length);
    }),
    close: closeSource,
  };
  const asset: EncodedAudioAsset = {
    kind: 'peer-range',
    size: bytes.byteLength,
    identity: BINDING.sourceIdentity,
    metadata,
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

function warmOptions(
  registry: FilePlaybackAssetRegistry,
  lease: FilePlaybackAssetLease,
  runtime: FilePlaybackAssetSourceStagerRuntimeForTests,
  overrides: Partial<PrepareFilePlaybackAssetSourceWarmOptions> = {},
): PrepareFilePlaybackAssetSourceWarmOptions {
  const staged = baseOptions(registry, lease, runtime);
  return {
    registry: staged.registry,
    roomToken: staged.roomToken,
    assetLease: staged.assetLease,
    expectedBinding: staged.expectedBinding,
    audioContext: staged.audioContext,
    clockBindings: staged.clockBindings,
    signal: staged.signal,
    isCurrent: staged.isCurrent,
    decodeOrdinaryAudio: staged.decodeOrdinaryAudio,
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
  const stageCandidate = vi.fn(async (_manager, options) => {
    await options.source.connect(options.destination);
    return PORT as never;
  });
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

function makeAdtsFrame(frameLengthBytes: number, payloadByte: number): Uint8Array {
  const bytes = new Uint8Array(frameLengthBytes).fill(payloadByte);
  const profile = 1;
  const sampleRateIndex = 4;
  const channelConfiguration = 2;
  bytes[0] = 0xff;
  bytes[1] = 0xf1;
  bytes[2] = (profile << 6) | (sampleRateIndex << 2) | ((channelConfiguration >>> 2) & 1);
  bytes[3] = ((channelConfiguration & 0b11) << 6) | ((frameLengthBytes >>> 11) & 0b11);
  bytes[4] = (frameLengthBytes >>> 3) & 0xff;
  bytes[5] = ((frameLengthBytes & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0b1111_1100;
  return bytes;
}

function adtsFixtureBytes(): Uint8Array {
  return concatFixtureBytes(
    makeAdtsFrame(19, 0x11),
    makeAdtsFrame(41, 0x22),
    makeAdtsFrame(83, 0x33),
  );
}

function authenticAdtsRuntime(
  onResult?: (result: BlobFilePlaybackSourceResult) => void | Promise<void>,
) {
  const destroy = vi.fn(async () => undefined);
  const source = fakeCutoverSource('bounded-stream', destroy);
  const createEncodedSource = vi.fn(
    async (options: Parameters<typeof createEncodedFilePlaybackSource>[0]) => {
      const result = await createEncodedFilePlaybackSource({
        ...options,
        aacCapabilityProbe: async () => undefined,
        backendFactories: {
          createStreamingAacSource: () => source as never,
        },
      });
      await onResult?.(result);
      return result;
    },
  );
  return {
    source,
    destroy,
    createEncodedSource,
    runtime: {
      createEncodedSource,
    } satisfies FilePlaybackAssetSourceStagerRuntimeForTests,
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

function concatFixtureBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let cursor = 0;
  for (const part of parts) {
    bytes.set(part, cursor);
    cursor += part.byteLength;
  }
  return bytes;
}

function asciiFixture(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function fixtureUint32Be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function nativeAiffBlob(): Blob {
  const channels = new Uint8Array(2);
  new DataView(channels.buffer).setUint16(0, 2, false);
  const rate = new Uint8Array(10);
  const rateView = new DataView(rate.buffer);
  rateView.setUint16(0, 16_398, false);
  rateView.setBigUint64(2, 48_000n << 48n, false);
  const common = concatFixtureBytes(channels, fixtureUint32Be(4), Uint8Array.of(0, 16), rate);
  const chunk = (id: string, body: Uint8Array) =>
    concatFixtureBytes(asciiFixture(id), fixtureUint32Be(body.byteLength), body);
  const sound = concatFixtureBytes(new Uint8Array(8), new Uint8Array(16));
  const body = concatFixtureBytes(
    asciiFixture('AIFF'),
    chunk('COMM', common),
    chunk('SSND', sound),
  );
  return new Blob(
    [concatFixtureBytes(asciiFixture('FORM'), fixtureUint32Be(body.byteLength), body)],
    { type: 'audio/aiff' },
  );
}

function nativeCafBlob(): Blob {
  const header = concatFixtureBytes(asciiFixture('caff'), Uint8Array.of(0, 1, 0, 0));
  const description = new Uint8Array(32);
  const descriptionView = new DataView(description.buffer);
  descriptionView.setFloat64(0, 48_000, false);
  description.set(asciiFixture('lpcm'), 8);
  descriptionView.setUint32(16, 4, false);
  descriptionView.setUint32(20, 1, false);
  descriptionView.setUint32(24, 2, false);
  descriptionView.setUint32(28, 16, false);
  const chunk = (id: string, body: Uint8Array) => {
    const size = new Uint8Array(8);
    new DataView(size.buffer).setBigInt64(0, BigInt(body.byteLength), false);
    return concatFixtureBytes(asciiFixture(id), size, body);
  };
  return new Blob(
    [
      concatFixtureBytes(
        header,
        chunk('desc', description),
        chunk('data', concatFixtureBytes(new Uint8Array(4), new Uint8Array(16))),
      ),
    ],
    { type: 'audio/x-caf' },
  );
}

describe('revision-free file playback warm source', () => {
  it('prepares one disconnected body-free source without occupying a manager slot', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource('bounded-stream');
    const release = vi.fn();
    const h = successfulRuntime(factoryResult(source, release));
    const signal = new AbortController().signal;

    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, h.runtime, { signal }),
    );

    expect(source.prepare).toHaveBeenCalledOnce();
    expect(source.prepare).toHaveBeenCalledWith(signal);
    expect(source.connect).not.toHaveBeenCalled();
    expect(h.stageCandidate).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(readFilePlaybackAssetSourceWarmReadiness(warm)).toEqual({
      durationSeconds: 12,
      bufferedAheadSeconds: 4,
      outputSampleRateHz: 48_000,
      channelCount: 2,
    });
    expect(Object.getPrototypeOf(warm)).toBeNull();
    expect(Object.isFrozen(warm)).toBe(true);
    expect(Object.isFrozen(warm.asset)).toBe(true);
    expect(Object.isFrozen(warm.metadata)).toBe(true);
    expect(Object.isFrozen(warm.readiness)).toBe(true);
    expect(JSON.stringify(warm)).not.toMatch(/"blob":|audioBuffer|"source":|arrayBuffer/u);

    await expect(retireFilePlaybackAssetSourceWarm(warm)).resolves.toBe(true);
    expect(source.destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects manager, destination, run, and revision fields at the warm boundary', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const h = successfulRuntime(factoryResult(source));
    const invalid = {
      ...warmOptions(setup.registry, setup.lease, h.runtime),
      manager: new FilePlaybackManager(),
      destination: {} as AudioNode,
      run: Object.freeze({}),
      revision: 1,
    } as unknown as PrepareFilePlaybackAssetSourceWarmOptions;

    await expect(prepareFilePlaybackAssetSourceWarm(invalid)).rejects.toThrow(/options/u);
    expect(h.createBlobSource).not.toHaveBeenCalled();
    expect(source.prepare).not.toHaveBeenCalled();
  });

  it('hands off exactly once and transfers cleanup ownership to the manager', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const release = vi.fn();
    const h = successfulRuntime(factoryResult(source, release));
    const signal = new AbortController().signal;
    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, h.runtime, { signal }),
    );
    const handoffOptions = {
      authority: warm,
      manager: new FilePlaybackManager(),
      destination: {} as AudioNode,
      signal,
      isCurrent: () => true,
    } as const;

    const first = handoffFilePlaybackAssetSourceWarm(handoffOptions);
    const duplicate = handoffFilePlaybackAssetSourceWarm(handoffOptions);
    await expect(duplicate).rejects.toThrow(/stale/u);
    const staged = await first;

    expect(staged.cutoverPort).toBe(PORT);
    expect(source.prepare).toHaveBeenCalledOnce();
    expect(source.connect).toHaveBeenCalledOnce();
    expect(h.stageCandidate).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(source.destroy).not.toHaveBeenCalled();
    await expect(retireFilePlaybackAssetSourceWarm(warm)).resolves.toBe(false);
    expect(() => readFilePlaybackAssetSourceWarmReadiness(warm)).toThrow(/stale/u);
  });

  it('coalesces repeated retirement and releases only after destroying the source', async () => {
    const order: string[] = [];
    const setup = blobRegistry();
    const destroy = vi.fn(async () => {
      order.push('destroy');
    });
    const release = vi.fn(() => order.push('release'));
    const source = fakeCutoverSource('audio-buffer', destroy);
    const h = successfulRuntime(factoryResult(source, release));
    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, h.runtime),
    );

    const first = retireFilePlaybackAssetSourceWarm(warm);
    const duplicate = retireFilePlaybackAssetSourceWarm(warm);
    expect(duplicate).toBe(first);
    await expect(first).resolves.toBe(true);

    expect(order).toEqual(['destroy', 'release']);
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await expect(
      handoffFilePlaybackAssetSourceWarm({
        authority: warm,
        manager: new FilePlaybackManager(),
        destination: {} as AudioNode,
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
    ).rejects.toThrow(/stale/u);
  });

  it('retires a prepared warm source when its original signal aborts', async () => {
    const setup = blobRegistry();
    const destroy = vi.fn(async () => undefined);
    const release = vi.fn();
    const source = fakeCutoverSource('bounded-stream', destroy);
    const h = successfulRuntime(factoryResult(source, release));
    const abort = new AbortController();
    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, h.runtime, { signal: abort.signal }),
    );

    abort.abort(new Error('room closed'));
    await vi.waitFor(() => {
      expect(destroy).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    });
    expect(() => readFilePlaybackAssetSourceWarmReadiness(warm)).toThrow(/stale/u);
  });

  it('preserves automatic abort cleanup failure for a later exact owner join', async () => {
    const setup = blobRegistry();
    const cleanupError = new Error('fixture automatic warm destroy failed');
    const destroy = vi.fn(async () => {
      throw cleanupError;
    });
    const release = vi.fn();
    const source = fakeCutoverSource('bounded-stream', destroy);
    const h = successfulRuntime(factoryResult(source, release));
    const abort = new AbortController();
    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, h.runtime, { signal: abort.signal }),
    );

    abort.abort(new Error('room closed'));
    await vi.waitFor(() => {
      expect(destroy).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    });

    await expect(retireFilePlaybackAssetSourceWarm(warm)).rejects.toBe(cleanupError);
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('joins retirement to an in-flight manager handoff and retires only its resolved port', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const release = vi.fn();
    const pendingStage = deferred<never>();
    const retireCandidate = vi.fn(async () => true);
    const stageCandidate = vi.fn(() => pendingStage.promise);
    const runtime = {
      createBlobSource: async () => factoryResult(source, release),
      stageCandidate,
      retireCandidate,
    };
    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, runtime),
    );
    const handoff = handoffFilePlaybackAssetSourceWarm({
      authority: warm,
      manager: new FilePlaybackManager(),
      destination: {} as AudioNode,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    await vi.waitFor(() => expect(stageCandidate).toHaveBeenCalledOnce());

    const retirement = retireFilePlaybackAssetSourceWarm(warm);
    pendingStage.resolve(PORT as never);

    await expect(handoff).rejects.toThrow(/retired/u);
    await expect(retirement).resolves.toBe(false);
    expect(retireCandidate).toHaveBeenCalledOnce();
    expect(retireCandidate.mock.calls[0]?.[1]).toBe(PORT);
    expect(source.destroy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('allows bounded buffering to grow between warm prepare and connected handoff', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource(
      'bounded-stream',
      vi.fn(async () => undefined),
      6,
    );
    const h = successfulRuntime(factoryResult(source));
    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, h.runtime),
    );

    expect(warm.readiness.bufferedAheadSeconds).toBe(4);
    const staged = await handoffFilePlaybackAssetSourceWarm({
      authority: warm,
      manager: new FilePlaybackManager(),
      destination: {} as AudioNode,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(staged.readiness.bufferedAheadSeconds).toBe(6);
  });

  it('hands an already-ready source to the actual manager without preparing it twice', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource('bounded-stream');
    const release = vi.fn();
    const graph = managerAudioGraph();
    const manager = new FilePlaybackManager();
    const runtime = { createBlobSource: async () => factoryResult(source, release) };
    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, runtime, { audioContext: graph.context }),
    );

    const staged = await handoffFilePlaybackAssetSourceWarm({
      authority: warm,
      manager,
      destination: graph.destination,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(source.prepare).toHaveBeenCalledOnce();
    expect(source.connect).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await expect(manager.retireCutoverCandidate(staged.cutoverPort)).resolves.toBe(true);
    expect(source.destroy).toHaveBeenCalledOnce();
    await expect(retireFilePlaybackAssetSourceWarm(warm)).resolves.toBe(false);
  });

  it('has the actual manager destroy a source when its first adoption snapshot fails', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const release = vi.fn();
    const graph = managerAudioGraph();
    const getSnapshot = vi.mocked(source.getSnapshot);
    const originalSnapshot = getSnapshot.getMockImplementation();
    if (!originalSnapshot) throw new Error('fake source snapshot implementation is missing');
    let snapshotCalls = 0;
    getSnapshot.mockImplementation(() => {
      snapshotCalls += 1;
      if (snapshotCalls === 3) throw new Error('manager adoption snapshot failed');
      return originalSnapshot();
    });
    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(
        setup.registry,
        setup.lease,
        { createBlobSource: async () => factoryResult(source, release) },
        { audioContext: graph.context },
      ),
    );

    await expect(
      handoffFilePlaybackAssetSourceWarm({
        authority: warm,
        manager: new FilePlaybackManager(),
        destination: graph.destination,
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
    ).rejects.toThrow('manager adoption snapshot failed');

    expect(source.destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not bind a consumed renderer to the completed warm preparation signal', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const graph = managerAudioGraph();
    const manager = new FilePlaybackManager();
    const preparation = new AbortController();
    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(
        setup.registry,
        setup.lease,
        { createBlobSource: async () => factoryResult(source) },
        { audioContext: graph.context, signal: preparation.signal },
      ),
    );
    const staged = await handoffFilePlaybackAssetSourceWarm({
      authority: warm,
      manager,
      destination: graph.destination,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    preparation.abort(new Error('warm slot consumed'));

    await expect(
      manager.armCutoverCandidate(staged.cutoverPort, {
        protocolVersion: 2,
        kind: 'rendezvous-arm',
        queueItemId: QID,
        runId: `run-${QID}`,
        revision: 1,
        rendezvousId: 'warm-signal-lifetime',
        recipientId: 'local-peer',
        positionSeconds: 0,
        playbackRate: 1,
        startAtRoomTimeMs: 5_000,
        finalizeByRoomTimeMs: 4_000,
      }),
    ).rejects.toThrow(/arm result/u);
    expect(source.armForCutover).toHaveBeenCalledOnce();
  });

  it('destroys a late prepared source when preparation authority is superseded', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    const release = vi.fn();
    const pendingPrepare = deferred<ReturnType<FilePlaybackCutoverSource['getSnapshot']>>();
    vi.mocked(source.prepare).mockImplementation(() => pendingPrepare.promise);
    let current = true;
    const promise = prepareFilePlaybackAssetSourceWarm(
      warmOptions(
        setup.registry,
        setup.lease,
        { createBlobSource: async () => factoryResult(source, release) },
        { isCurrent: () => current },
      ),
    );
    await vi.waitFor(() => expect(source.prepare).toHaveBeenCalledOnce());
    current = false;
    pendingPrepare.resolve({
      schemaVersion: 1,
      queueItemId: QID,
      backend: 'audio-buffer',
      phase: 'ready',
      revision: 0,
      run: null,
      durationSeconds: 12,
      positionSeconds: 0,
      bufferedAheadSeconds: 12,
      outputSampleRateHz: 48_000,
      channelCount: 2,
      underrunCount: 0,
      errorCode: null,
    });

    await expect(promise).rejects.toThrow(/superseded/u);
    expect(source.destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('host codec timeline artifact installation', () => {
  const metadata = Object.freeze({ name: 'remote.aac', mime: 'audio/aac' });

  it('keeps omission inert and installs an authentic result with the exact canonical binding', async () => {
    const bytes = adtsFixtureBytes();
    const omittedSetup = genericRegistry(bytes, metadata);
    const omittedSource = fakeCutoverSource('bounded-stream');
    const omittedRuntime = successfulRuntime(factoryResult(omittedSource));
    const omitted = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(omittedSetup.registry, omittedSetup.lease, omittedRuntime.runtime, {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      }),
    );
    const omittedRequest = omittedRuntime.createEncodedSource.mock.calls[0]?.[0];
    expect(omittedRequest).not.toHaveProperty('codecTimelineHostArtifactBinding');
    expect(
      describeCodecTimelineHostArtifactForLease({
        registry: omittedSetup.registry,
        roomToken: TOKEN,
        lease: omittedSetup.lease,
      }),
    ).toBeNull();
    await retireFilePlaybackAssetSourceWarm(omitted);

    const setup = genericRegistry(bytes, metadata);
    const h = authenticAdtsRuntime();
    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, h.runtime, {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        installCodecTimelineHostArtifact: true,
      }),
    );
    const request = h.createEncodedSource.mock.calls[0]?.[0];
    const binding = request?.codecTimelineHostArtifactBinding;
    expect(binding).toEqual({
      queueItemId: QID,
      sourceIdentity: BINDING.sourceIdentity,
      transferSessionId: BINDING.transferSessionId,
      encodedSize: bytes.byteLength,
      name: metadata.name,
      mime: metadata.mime,
    });
    expect(Reflect.ownKeys(binding ?? {})).toEqual([
      'queueItemId',
      'sourceIdentity',
      'transferSessionId',
      'encodedSize',
      'name',
      'mime',
    ]);
    expect(Object.getPrototypeOf(binding)).toBeNull();
    expect(Object.isFrozen(binding)).toBe(true);
    expect(
      describeCodecTimelineHostArtifactForLease({
        registry: setup.registry,
        roomToken: TOKEN,
        lease: setup.lease,
      }),
    ).toMatchObject({ codec: 'adts-aac-lc' });
    expect(Object.keys(warm)).toEqual([
      'backend',
      'sourceIdentity',
      'asset',
      'metadata',
      'readiness',
    ]);
    await retireFilePlaybackAssetSourceWarm(warm);
  });

  it('does not install from a structural copy of an otherwise authentic factory result', async () => {
    const bytes = adtsFixtureBytes();
    const setup = genericRegistry(bytes, metadata);
    const authentic = authenticAdtsRuntime();
    const copiedRuntime: FilePlaybackAssetSourceStagerRuntimeForTests = {
      createEncodedSource: async (options) => {
        const result = await authentic.createEncodedSource(options);
        return Object.freeze({ ...result });
      },
    };
    const warm = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, copiedRuntime, {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        installCodecTimelineHostArtifact: true,
      }),
    );

    expect(
      describeCodecTimelineHostArtifactForLease({
        registry: setup.registry,
        roomToken: TOKEN,
        lease: setup.lease,
      }),
    ).toBeNull();
    await retireFilePlaybackAssetSourceWarm(warm);
  });

  it('preflights an existing association and skips reissuing or reinstalling it', async () => {
    const bytes = adtsFixtureBytes();
    const setup = genericRegistry(bytes, metadata);
    const firstRuntime = authenticAdtsRuntime();
    const first = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, firstRuntime.runtime, {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        installCodecTimelineHostArtifact: true,
      }),
    );
    await retireFilePlaybackAssetSourceWarm(first);

    const secondSource = fakeCutoverSource('bounded-stream');
    const secondRuntime = successfulRuntime(factoryResult(secondSource));
    const second = await prepareFilePlaybackAssetSourceWarm(
      warmOptions(setup.registry, setup.lease, secondRuntime.runtime, {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        installCodecTimelineHostArtifact: true,
      }),
    );

    expect(secondRuntime.createEncodedSource.mock.calls[0]?.[0]).not.toHaveProperty(
      'codecTimelineHostArtifactBinding',
    );
    expect(
      describeCodecTimelineHostArtifactForLease({
        registry: setup.registry,
        roomToken: TOKEN,
        lease: setup.lease,
      }),
    ).toMatchObject({ codec: 'adts-aac-lc' });
    await retireFilePlaybackAssetSourceWarm(second);
  });

  it('converges concurrent same-lease preparations on one matching association', async () => {
    const bytes = adtsFixtureBytes();
    const setup = genericRegistry(bytes, metadata);
    const barrier = deferred<void>();
    const artifacts: Array<
      NonNullable<ReturnType<typeof codecTimelineHostArtifactForFilePlaybackSourceResult>>
    > = [];
    let arrivals = 0;
    const waitForBothResults = async (result: BlobFilePlaybackSourceResult): Promise<void> => {
      const artifact = codecTimelineHostArtifactForFilePlaybackSourceResult(result);
      if (!artifact) throw new Error('fixture artifact missing');
      artifacts.push(artifact);
      arrivals += 1;
      if (arrivals === 2) barrier.resolve(undefined);
      await barrier.promise;
    };
    const firstRuntime = authenticAdtsRuntime(waitForBothResults);
    const secondRuntime = authenticAdtsRuntime(waitForBothResults);
    const options = {
      boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
      installCodecTimelineHostArtifact: true as const,
    };

    const [first, second] = await Promise.all([
      prepareFilePlaybackAssetSourceWarm(
        warmOptions(setup.registry, setup.lease, firstRuntime.runtime, options),
      ),
      prepareFilePlaybackAssetSourceWarm(
        warmOptions(setup.registry, setup.lease, secondRuntime.runtime, options),
      ),
    ]);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).not.toBe(artifacts[1]);
    expect({
      codec: artifacts[1]!.codec,
      manifestByteLength: artifacts[1]!.manifestByteLength,
      manifestSha256B64: artifacts[1]!.manifestSha256B64,
    }).toEqual({
      codec: artifacts[0]!.codec,
      manifestByteLength: artifacts[0]!.manifestByteLength,
      manifestSha256B64: artifacts[0]!.manifestSha256B64,
    });
    expect(
      describeCodecTimelineHostArtifactForLease({
        registry: setup.registry,
        roomToken: TOKEN,
        lease: setup.lease,
      }),
    ).toMatchObject({
      codec: artifacts[0]!.codec,
      manifestByteLength: artifacts[0]!.manifestByteLength,
      manifestSha256B64: artifacts[0]!.manifestSha256B64,
    });
    const exactReplayOutcomes = artifacts.map((artifact) => {
      try {
        installCodecTimelineHostArtifactForLease({
          registry: setup.registry,
          roomToken: TOKEN,
          lease: setup.lease,
          artifact,
        });
        return 'installed' as const;
      } catch {
        return 'rejected' as const;
      }
    });
    expect(exactReplayOutcomes.filter((outcome) => outcome === 'installed')).toHaveLength(1);
    expect(exactReplayOutcomes.filter((outcome) => outcome === 'rejected')).toHaveLength(1);
    await Promise.all([
      retireFilePlaybackAssetSourceWarm(first),
      retireFilePlaybackAssetSourceWarm(second),
    ]);
  });

  it('rejects false and accessor opt-ins before entering the source factory', async () => {
    const setup = genericRegistry(adtsFixtureBytes(), metadata);
    const source = fakeCutoverSource('bounded-stream');
    const h = successfulRuntime(factoryResult(source));
    const falseOptions = warmOptions(setup.registry, setup.lease, h.runtime) as unknown as Record<
      string,
      unknown
    >;
    falseOptions.installCodecTimelineHostArtifact = false;
    await expect(prepareFilePlaybackAssetSourceWarm(falseOptions as never)).rejects.toThrow(
      /literal true/u,
    );

    const accessorOptions = { ...warmOptions(setup.registry, setup.lease, h.runtime) } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorOptions, 'installCodecTimelineHostArtifact', {
      enumerable: true,
      get: () => true,
    });
    await expect(prepareFilePlaybackAssetSourceWarm(accessorOptions as never)).rejects.toThrow(
      /options/u,
    );
    expect(h.createEncodedSource).not.toHaveBeenCalled();
  });

  it('fails closed when a concurrent same-lease artifact has different diagnostics', async () => {
    const bytes = adtsFixtureBytes();
    const alternateBytes = concatFixtureBytes(
      makeAdtsFrame(23, 0x44),
      makeAdtsFrame(37, 0x55),
      makeAdtsFrame(83, 0x66),
    );
    expect(alternateBytes.byteLength).toBe(bytes.byteLength);
    const setup = genericRegistry(bytes, metadata);
    let candidate: NonNullable<
      ReturnType<typeof codecTimelineHostArtifactForFilePlaybackSourceResult>
    > | null = null;
    const h = authenticAdtsRuntime(async (result) => {
      const candidateArtifact = codecTimelineHostArtifactForFilePlaybackSourceResult(result);
      if (!candidateArtifact) throw new Error('fixture candidate artifact missing');
      candidate = candidateArtifact;
      const alternateSource: EncodedAudioSource = {
        kind: 'peer-range',
        size: alternateBytes.byteLength,
        identity: BINDING.sourceIdentity,
        metadata,
        readAt: async (offset, length, signal) => {
          signal.throwIfAborted();
          return alternateBytes.slice(offset, offset + length);
        },
        close: vi.fn(async () => undefined),
      };
      const alternateResult = await createEncodedFilePlaybackSource({
        encodedSource: alternateSource,
        queueItemId: QID,
        audioContext: { sampleRate: 48_000, currentTime: 0 } as AudioContext,
        nowRoomTimeMs: () => 1_000,
        roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
        localPerformanceMsToContextTime: (localTimeMs) => localTimeMs / 1_000,
        signal: new AbortController().signal,
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        codecTimelineHostArtifactBinding: {
          queueItemId: QID,
          sourceIdentity: BINDING.sourceIdentity,
          transferSessionId: BINDING.transferSessionId,
          encodedSize: alternateBytes.byteLength,
          name: metadata.name,
          mime: metadata.mime,
        },
        aacCapabilityProbe: async () => undefined,
        backendFactories: {
          createStreamingAacSource: () => fakeCutoverSource('bounded-stream') as never,
        },
      });
      const alternateArtifact =
        codecTimelineHostArtifactForFilePlaybackSourceResult(alternateResult);
      if (!alternateArtifact) throw new Error('fixture alternate artifact missing');
      expect(alternateArtifact.manifestSha256B64).not.toBe(candidateArtifact.manifestSha256B64);
      installCodecTimelineHostArtifactForLease({
        registry: setup.registry,
        roomToken: TOKEN,
        lease: setup.lease,
        artifact: alternateArtifact,
      });
    });

    await expect(
      prepareFilePlaybackAssetSourceWarm(
        warmOptions(setup.registry, setup.lease, h.runtime, {
          boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
          installCodecTimelineHostArtifact: true,
        }),
      ),
    ).rejects.toThrow(/conflicts with this source/u);
    expect(candidate).not.toBeNull();
    expect(h.destroy).toHaveBeenCalledOnce();
  });

  it('destroys the prepared source when exact lease installation fails', async () => {
    const bytes = adtsFixtureBytes();
    const setup = genericRegistry(bytes, metadata);
    const foreign = genericRegistry(bytes, metadata);
    const h = authenticAdtsRuntime((result) => {
      const artifact = codecTimelineHostArtifactForFilePlaybackSourceResult(result);
      if (!artifact) throw new Error('fixture artifact missing');
      installCodecTimelineHostArtifactForLease({
        registry: foreign.registry,
        roomToken: TOKEN,
        lease: foreign.lease,
        artifact,
      });
    });

    await expect(
      prepareFilePlaybackAssetSourceWarm(
        warmOptions(setup.registry, setup.lease, h.runtime, {
          boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
          installCodecTimelineHostArtifact: true,
        }),
      ),
    ).rejects.toThrow(/claimed by another exact registry lease/u);
    expect(h.destroy).toHaveBeenCalledOnce();
    expect(
      describeCodecTimelineHostArtifactForLease({
        registry: setup.registry,
        roomToken: TOKEN,
        lease: setup.lease,
      }),
    ).toBeNull();
  });

  it('rechecks authority immediately after synchronous installation', async () => {
    const bytes = adtsFixtureBytes();
    const setup = genericRegistry(bytes, metadata);
    const h = authenticAdtsRuntime();
    const isCurrent = vi.fn(
      () =>
        describeCodecTimelineHostArtifactForLease({
          registry: setup.registry,
          roomToken: TOKEN,
          lease: setup.lease,
        }) === null,
    );

    await expect(
      prepareFilePlaybackAssetSourceWarm(
        warmOptions(setup.registry, setup.lease, h.runtime, {
          boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
          installCodecTimelineHostArtifact: true,
          isCurrent,
        }),
      ),
    ).rejects.toThrow(/superseded/u);
    expect(h.destroy).toHaveBeenCalledOnce();
    expect(
      describeCodecTimelineHostArtifactForLease({
        registry: setup.registry,
        roomToken: TOKEN,
        lease: setup.lease,
      }),
    ).toMatchObject({ codec: 'adts-aac-lc' });
  });
});

describe('stageFilePlaybackAssetSource', () => {
  it('forwards only the exact host-artifact opt-in through the one-shot facade', async () => {
    const setup = genericRegistry(adtsFixtureBytes(), {
      name: 'facade.aac',
      mime: 'audio/aac',
    });
    const source = fakeCutoverSource('bounded-stream');
    const h = successfulRuntime(factoryResult(source));
    await stageFilePlaybackAssetSource(
      baseOptions(setup.registry, setup.lease, h.runtime, {
        boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        installCodecTimelineHostArtifact: true,
      }),
    );

    expect(h.createEncodedSource.mock.calls[0]?.[0]).toHaveProperty(
      'codecTimelineHostArtifactBinding',
    );

    const rejectedSetup = genericRegistry(adtsFixtureBytes(), {
      name: 'facade-false.aac',
      mime: 'audio/aac',
    });
    const rejectedSource = fakeCutoverSource('bounded-stream');
    const rejected = successfulRuntime(factoryResult(rejectedSource));
    const invalid = baseOptions(
      rejectedSetup.registry,
      rejectedSetup.lease,
      rejected.runtime,
    ) as unknown as Record<string, unknown>;
    invalid.installCodecTimelineHostArtifact = false;
    await expect(stageFilePlaybackAssetSource(invalid as never)).rejects.toThrow(/literal true/u);
    expect(rejected.createEncodedSource).not.toHaveBeenCalled();
  });

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
    expect(request).not.toHaveProperty('boundedRoutePolicy');
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
    expect(h.createEncodedSource.mock.calls[0]?.[0]).not.toHaveProperty('boundedRoutePolicy');
    expect(h.createBlobSource).not.toHaveBeenCalled();
    expect(setup.closeSource).not.toHaveBeenCalled();
  });

  it.each(['blob', 'generic'] as const)(
    'forwards one canonical opt-in route policy to the %s factory',
    async (kind) => {
      const setup = kind === 'blob' ? blobRegistry() : genericRegistry();
      const source = fakeCutoverSource(kind === 'blob' ? 'audio-buffer' : 'bounded-stream');
      const h = successfulRuntime(factoryResult(source));

      await stageFilePlaybackAssetSource(
        baseOptions(setup.registry, setup.lease, h.runtime, {
          boundedRoutePolicy: FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY,
        }),
      );

      const request =
        kind === 'blob'
          ? h.createBlobSource.mock.calls[0]?.[0]
          : h.createEncodedSource.mock.calls[0]?.[0];
      expect(request?.boundedRoutePolicy).toBe(FILE_PLAYBACK_UNIVERSAL_V1_BOUNDED_ROUTE_POLICY);
    },
  );

  it('rejects an invalid route policy before resolving or acquiring the asset body', async () => {
    const setup = genericRegistry();
    const source = fakeCutoverSource('bounded-stream');
    const h = successfulRuntime(factoryResult(source));

    await expect(
      stageFilePlaybackAssetSource(
        baseOptions(setup.registry, setup.lease, h.runtime, {
          boundedRoutePolicy: {
            mode: 'universal-v1',
            aacBackendId: 'webcodecs',
            m4aBackendId: 'symphonia-wasm',
          } as unknown as FilePlaybackBoundedRoutePolicy,
        }),
      ),
    ).rejects.toThrow(/webcodecs/i);

    expect(setup.asset.acquire).not.toHaveBeenCalled();
    expect(h.createBlobSource).not.toHaveBeenCalled();
    expect(h.createEncodedSource).not.toHaveBeenCalled();
  });

  it.each([
    ['AIFF', nativeAiffBlob, { name: 'remote.aiff', mime: 'audio/aiff' }],
    ['CAF', nativeCafBlob, { name: 'remote.caf', mime: 'audio/x-caf' }],
  ] as const)(
    'keeps committed bounded routing for a generic %s asset lease',
    async (_label, createBlob, metadata) => {
      const bytes = new Uint8Array(await createBlob().arrayBuffer());
      const setup = genericRegistry(bytes, metadata);
      let createdSource: FilePlaybackCutoverSource | null = null;
      const createEncodedSource = (
        options: Parameters<typeof createEncodedFilePlaybackSource>[0],
      ) =>
        createEncodedFilePlaybackSource({
          ...options,
          backendFactories: {
            createStreamingLinearPcmSource: (sourceOptions) => {
              const source = fakeCutoverSource(
                'bounded-stream',
                vi.fn(async () => sourceOptions.encodedSource.close()),
              );
              createdSource = source;
              return source as never;
            },
          },
        });
      const stageCandidate = vi.fn(async (_manager, options) => {
        await options.source.connect(options.destination);
        return PORT as never;
      });

      const staged = await stageFilePlaybackAssetSource(
        baseOptions(setup.registry, setup.lease, { createEncodedSource, stageCandidate }),
      );

      expect(staged.backend).toBe('bounded-stream');
      expect(createdSource).not.toBeNull();
      expect(setup.closeSource).not.toHaveBeenCalled();
      await (createdSource as unknown as FilePlaybackCutoverSource).destroy();
      expect(setup.closeSource).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['ordinary', new Blob([new Uint8Array([0x49, 0x44, 0x33, 0x04])]), 'audio-buffer', METADATA],
    [
      'native FLAC',
      nativeFlacBlob(),
      'bounded-stream',
      { name: 'orchestra.flac', mime: 'audio/flac' },
    ],
    ['WAVE PCM', nativeWaveBlob(), 'bounded-stream', { name: 'orchestra.wav', mime: 'audio/wav' }],
    [
      'AIFF PCM',
      nativeAiffBlob(),
      'bounded-stream',
      { name: 'orchestra.aiff', mime: 'audio/aiff' },
    ],
    ['CAF LPCM', nativeCafBlob(), 'bounded-stream', { name: 'orchestra.caf', mime: 'audio/x-caf' }],
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
            createStreamingLinearPcmSource: () => createdSource as never,
          },
        });
      const stageCandidate = vi.fn(async (_manager, options) => {
        await options.source.connect(options.destination);
        return PORT as never;
      });

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
    const invalidSnapshot = {
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
    } as const;
    const retireCandidate = vi.fn(async () => true);
    const stageCandidate = vi.fn(async (_manager, options) => {
      await options.source.connect(options.destination);
      vi.mocked(source.getSnapshot).mockReturnValue(invalidSnapshot);
      return PORT as never;
    });

    await expect(
      stageFilePlaybackAssetSource(
        baseOptions(setup.registry, setup.lease, {
          createBlobSource: async () => factoryResult(source),
          stageCandidate,
          retireCandidate,
        }),
      ),
    ).rejects.toThrow(/readiness/u);
    expect(retireCandidate).toHaveBeenCalledOnce();
  });

  it('does not publish readiness when authority changes during its exact snapshot', async () => {
    const setup = blobRegistry();
    const source = fakeCutoverSource();
    let current = true;
    const retireCandidate = vi.fn(async () => true);
    const stageCandidate = vi.fn(async (_manager, options) => {
      await options.source.connect(options.destination);
      current = false;
      return PORT as never;
    });

    await expect(
      stageFilePlaybackAssetSource(
        baseOptions(
          setup.registry,
          setup.lease,
          {
            createBlobSource: async () => factoryResult(source),
            stageCandidate,
            retireCandidate,
          },
          { isCurrent: () => current },
        ),
      ),
    ).rejects.toThrow(/superseded/u);
    expect(retireCandidate).toHaveBeenCalledOnce();
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

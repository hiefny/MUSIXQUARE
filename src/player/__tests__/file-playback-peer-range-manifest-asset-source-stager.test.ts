import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeHarness = vi.hoisted(() => {
  interface Record {
    readonly source: object;
    readonly closeConstruction: () => Promise<void>;
    readonly registry: object;
    readonly roomToken: object;
    readonly assetLease: object;
    status: 'available' | 'constructing' | 'consumed' | 'retired';
    retirement: Promise<boolean> | null;
  }
  return {
    records: new WeakMap<object, Record>(),
    retirements: new WeakMap<object, Promise<boolean>>(),
    reset(): void {
      this.records = new WeakMap<object, Record>();
      this.retirements = new WeakMap<object, Promise<boolean>>();
    },
  };
});

vi.mock('../file-playback-peer-range-manifest-decoder-bridge.ts', () => ({
  async constructFilePlaybackPeerRangeManifestDecoder(options: {
    readonly authority: object;
    readonly registry: object;
    readonly roomToken: object;
    readonly assetLease: object;
  }): Promise<object> {
    const record = bridgeHarness.records.get(options.authority);
    if (!record || record.status !== 'available') {
      throw new Error('File playback manifest decoder construction is stale');
    }
    if (
      record.registry !== options.registry ||
      record.roomToken !== options.roomToken ||
      record.assetLease !== options.assetLease
    ) {
      throw new Error('File playback manifest decoder asset authority does not match');
    }
    record.status = 'constructing';
    await Promise.resolve();
    if (record.status !== 'constructing') {
      throw new Error('File playback manifest decoder construction was revoked');
    }
    record.status = 'consumed';
    bridgeHarness.records.delete(options.authority);
    return record.source;
  },
  retireFilePlaybackPeerRangeManifestDecoderConstruction(authority: object): Promise<boolean> {
    const existing = bridgeHarness.retirements.get(authority);
    if (existing) return existing;
    const record = bridgeHarness.records.get(authority);
    if (!record || (record.status !== 'available' && record.status !== 'constructing')) {
      return Promise.resolve(false);
    }
    record.status = 'retired';
    const retirement = Promise.resolve().then(async () => {
      await record.closeConstruction();
      bridgeHarness.records.delete(authority);
      return true;
    });
    record.retirement = retirement;
    bridgeHarness.retirements.set(authority, retirement);
    return retirement;
  },
}));

import type { QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackAssetRegistry,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
} from '../file-playback-asset-registry.ts';
import {
  prepareFilePlaybackPeerRangeManifestAssetSourceWarm,
  retireFilePlaybackAssetSourceWarm,
  stageFilePlaybackPeerRangeManifestAssetSource,
  type FilePlaybackPeerRangeManifestAssetSourceStagerRuntimeForTests,
  type PrepareFilePlaybackPeerRangeManifestAssetSourceWarmOptions,
  type StageFilePlaybackPeerRangeManifestAssetSourceOptions,
} from '../file-playback-asset-source-stager.ts';
import {
  retireFilePlaybackPeerRangeManifestDecoderConstruction,
  type FilePlaybackPeerRangeManifestDecoderConstruction,
} from '../file-playback-peer-range-manifest-decoder-bridge.ts';
import { FilePlaybackManager } from '../file-playback-manager.ts';
import type { FilePlaybackCutoverSource } from '../file-playback-source.ts';
import type { EncodedAudioAsset } from '../sources/encoded-audio-asset.ts';

const TOKEN = Object.freeze({ room: 'manifest-asset-source-stager' });
const QUEUE_ITEM_ID = 'b2000000-0000-4000-8000-000000000001' as QueueItemId;
const SOURCE_IDENTITY = 'manifest-asset-source-stager:source';
const SOURCE_SIZE = 143;
const BINDING: Readonly<FilePlaybackAssetBinding> = Object.freeze({
  queueItemId: QUEUE_ITEM_ID,
  sourceIdentity: SOURCE_IDENTITY,
  transferSessionId: 'manifest-asset-source-stager:transfer',
});
const METADATA = Object.freeze({ name: 'bounded.aac', mime: 'audio/aac' });
const PORT = Object.freeze(Object.create(null));
const registries = new Set<FilePlaybackAssetRegistry>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function fakeCutoverSource(
  options: {
    readonly prepareHook?: (signal: AbortSignal) => Promise<void>;
    readonly destroyHook?: () => void;
  } = {},
): FilePlaybackCutoverSource & {
  readonly destroy: ReturnType<typeof vi.fn>;
} {
  let phase: 'new' | 'ready' | 'connected' | 'destroyed' = 'new';
  const snapshot = () => ({
    schemaVersion: 1 as const,
    queueItemId: QUEUE_ITEM_ID,
    backend: 'bounded-stream' as const,
    phase,
    revision: 0,
    run: null,
    durationSeconds: phase === 'new' || phase === 'destroyed' ? null : 12,
    positionSeconds: 0,
    bufferedAheadSeconds: phase === 'new' || phase === 'destroyed' ? 0 : 4,
    outputSampleRateHz: phase === 'new' || phase === 'destroyed' ? null : 48_000,
    channelCount: phase === 'new' || phase === 'destroyed' ? null : 2,
    underrunCount: 0,
    errorCode: null,
  });
  const destroy = vi.fn(async () => {
    options.destroyHook?.();
    phase = 'destroyed';
  });
  return {
    queueItemId: QUEUE_ITEM_ID,
    backend: 'bounded-stream',
    prepare: vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      await options.prepareHook?.(signal);
      signal.throwIfAborted();
      phase = 'ready';
      return snapshot();
    }),
    connect: vi.fn(async () => {
      phase = 'connected';
      return snapshot();
    }),
    primeForCutover: vi.fn(async (_positionSeconds, signal) => {
      signal.throwIfAborted();
      return snapshot();
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
    getSnapshot: vi.fn(snapshot),
    destroy,
  };
}

function registryFixture(): {
  readonly registry: FilePlaybackAssetRegistry;
  readonly lease: FilePlaybackAssetLease;
  readonly acquire: ReturnType<typeof vi.fn>;
} {
  const acquire = vi.fn(() => {
    throw new Error('Manifest staging must not acquire a second generic source');
  });
  const asset: EncodedAudioAsset = {
    kind: 'peer-range',
    size: SOURCE_SIZE,
    identity: SOURCE_IDENTITY,
    metadata: METADATA,
    activeLeaseCount: 1,
    acquire,
    close: vi.fn(async () => undefined),
  };
  const registry = new FilePlaybackAssetRegistry({
    liveRoomToken: TOKEN,
    onFatalRoom: vi.fn(),
  });
  registries.add(registry);
  const lease = registry.admitEncodedAsset(TOKEN, BINDING, asset);
  return { registry, lease, acquire };
}

function makeConstruction(
  fixture: Readonly<{
    readonly registry: FilePlaybackAssetRegistry;
    readonly lease: FilePlaybackAssetLease;
  }>,
  source: FilePlaybackCutoverSource,
  closeConstruction = vi.fn(async () => undefined),
): {
  readonly construction: Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>;
  readonly closeConstruction: ReturnType<typeof vi.fn>;
} {
  const construction = freezeCanonical({
    codec: 'adts-aac-lc' as const,
    queueItemId: QUEUE_ITEM_ID,
    sourceIdentity: SOURCE_IDENTITY,
    sourceSize: SOURCE_SIZE,
  }) as unknown as Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>;
  bridgeHarness.records.set(construction as object, {
    source,
    closeConstruction,
    registry: fixture.registry,
    roomToken: TOKEN,
    assetLease: fixture.lease,
    status: 'available',
    retirement: null,
  });
  return { construction, closeConstruction };
}

const clockBindings = Object.freeze({
  nowRoomTimeMs: () => 1_000,
  roomTimeMsToContextTime: (roomTimeMs: number) => roomTimeMs / 1_000,
  localPerformanceMsToContextTime: (localTimeMs: number) => localTimeMs / 1_000,
});

function warmOptions(
  registry: FilePlaybackAssetRegistry,
  lease: FilePlaybackAssetLease,
  construction: Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>,
  patch: Partial<PrepareFilePlaybackPeerRangeManifestAssetSourceWarmOptions> = {},
): PrepareFilePlaybackPeerRangeManifestAssetSourceWarmOptions {
  return {
    construction,
    registry,
    roomToken: TOKEN,
    assetLease: lease,
    expectedBinding: BINDING,
    audioContext: { sampleRate: 48_000 } as AudioContext,
    clockBindings,
    signal: new AbortController().signal,
    isCurrent: () => true,
    ...patch,
  };
}

function successfulRuntime(
  source: FilePlaybackCutoverSource,
  beforeReturn: () => void = () => undefined,
): {
  readonly runtime: FilePlaybackPeerRangeManifestAssetSourceStagerRuntimeForTests;
  readonly stageCandidate: ReturnType<typeof vi.fn>;
  readonly retireCandidate: ReturnType<typeof vi.fn>;
} {
  const stageCandidate = vi.fn(async (_manager, options) => {
    await options.source.connect(options.destination);
    beforeReturn();
    return PORT as never;
  });
  const retireCandidate = vi.fn(async () => {
    await source.destroy();
    return true;
  });
  return { runtime: { stageCandidate, retireCandidate }, stageCandidate, retireCandidate };
}

function stageOptions(
  registry: FilePlaybackAssetRegistry,
  lease: FilePlaybackAssetLease,
  construction: Readonly<FilePlaybackPeerRangeManifestDecoderConstruction>,
  runtime: FilePlaybackPeerRangeManifestAssetSourceStagerRuntimeForTests,
  patch: Partial<StageFilePlaybackPeerRangeManifestAssetSourceOptions> = {},
): StageFilePlaybackPeerRangeManifestAssetSourceOptions {
  return {
    ...warmOptions(registry, lease, construction),
    manager: new FilePlaybackManager(),
    destination: {} as AudioNode,
    runtime,
    ...patch,
  };
}

beforeEach(() => {
  bridgeHarness.reset();
});

afterEach(async () => {
  for (const registry of registries) {
    await registry.close(TOKEN).catch(() => undefined);
  }
  registries.clear();
  vi.restoreAllMocks();
});

describe('peer-range manifest asset source staging boundary', () => {
  it('consumes one construction and transfers the prepared source to the manager', async () => {
    const fixture = registryFixture();
    const source = fakeCutoverSource();
    const { construction } = makeConstruction(fixture, source);
    const runtime = successfulRuntime(source);

    const staged = await stageFilePlaybackPeerRangeManifestAssetSource(
      stageOptions(fixture.registry, fixture.lease, construction, runtime.runtime),
    );

    expect(source.prepare).toHaveBeenCalledOnce();
    expect(source.connect).toHaveBeenCalledOnce();
    expect(source.destroy).not.toHaveBeenCalled();
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(runtime.retireCandidate).not.toHaveBeenCalled();
    expect(staged.sourceIdentity).toBe(SOURCE_IDENTITY);
    expect(staged.backend).toBe('bounded-stream');
    expect(JSON.stringify(staged)).not.toMatch(/timeline|encodedSource|"source"/u);
    await expect(
      retireFilePlaybackPeerRangeManifestDecoderConstruction(construction),
    ).resolves.toBe(false);
  });

  it('lets the caller explicitly retire an unused construction exactly once', async () => {
    const fixture = registryFixture();
    const source = fakeCutoverSource();
    const { construction, closeConstruction } = makeConstruction(fixture, source);

    const first = retireFilePlaybackPeerRangeManifestDecoderConstruction(construction);
    expect(retireFilePlaybackPeerRangeManifestDecoderConstruction(construction)).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(closeConstruction).toHaveBeenCalledOnce();
    expect(source.destroy).not.toHaveBeenCalled();
  });

  it('destroys a consumed decoder once when abort wins during preparation', async () => {
    const fixture = registryFixture();
    const started = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const source = fakeCutoverSource({
      prepareHook: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const { construction, closeConstruction } = makeConstruction(fixture, source);

    const preparing = prepareFilePlaybackPeerRangeManifestAssetSourceWarm(
      warmOptions(fixture.registry, fixture.lease, construction, { signal: controller.signal }),
    );
    await started.promise;
    controller.abort(new Error('manifest prepare aborted'));
    release.resolve();

    await expect(preparing).rejects.toThrow('manifest prepare aborted');
    expect(source.destroy).toHaveBeenCalledOnce();
    expect(closeConstruction).not.toHaveBeenCalled();
  });

  it('retires a manager-owned candidate once when authority changes during staging', async () => {
    const fixture = registryFixture();
    const source = fakeCutoverSource();
    const { construction } = makeConstruction(fixture, source);
    let current = true;
    const runtime = successfulRuntime(source, () => {
      current = false;
    });

    await expect(
      stageFilePlaybackPeerRangeManifestAssetSource(
        stageOptions(fixture.registry, fixture.lease, construction, runtime.runtime, {
          isCurrent: () => current,
        }),
      ),
    ).rejects.toThrow('superseded');

    expect(runtime.retireCandidate).toHaveBeenCalledOnce();
    expect(source.destroy).toHaveBeenCalledOnce();
  });

  it('rejects a copied construction without consuming the original', async () => {
    const fixture = registryFixture();
    const source = fakeCutoverSource();
    const { construction, closeConstruction } = makeConstruction(fixture, source);
    const copied = Object.assign(
      {},
      construction,
    ) as FilePlaybackPeerRangeManifestDecoderConstruction;

    await expect(
      prepareFilePlaybackPeerRangeManifestAssetSourceWarm(
        warmOptions(fixture.registry, fixture.lease, copied),
      ),
    ).rejects.toThrow('construction is stale');

    expect(source.destroy).not.toHaveBeenCalled();
    await expect(
      retireFilePlaybackPeerRangeManifestDecoderConstruction(construction),
    ).resolves.toBe(true);
    expect(closeConstruction).toHaveBeenCalledOnce();
  });

  it('rejects reuse after one warm publication and leaves its source with that warm owner', async () => {
    const fixture = registryFixture();
    const source = fakeCutoverSource();
    const { construction } = makeConstruction(fixture, source);
    const first = await prepareFilePlaybackPeerRangeManifestAssetSourceWarm(
      warmOptions(fixture.registry, fixture.lease, construction),
    );

    await expect(
      prepareFilePlaybackPeerRangeManifestAssetSourceWarm(
        warmOptions(fixture.registry, fixture.lease, construction),
      ),
    ).rejects.toThrow('construction is stale');
    expect(source.destroy).not.toHaveBeenCalled();

    await expect(retireFilePlaybackAssetSourceWarm(first)).resolves.toBe(true);
    expect(source.destroy).toHaveBeenCalledOnce();
  });

  it('publishes retirement before synchronous destroy re-enters the warm owner', async () => {
    const fixture = registryFixture();
    let warm!: Awaited<ReturnType<typeof prepareFilePlaybackPeerRangeManifestAssetSourceWarm>>;
    let reentrantRetirement: Promise<boolean> | null = null;
    const source = fakeCutoverSource({
      destroyHook: () => {
        reentrantRetirement = retireFilePlaybackAssetSourceWarm(warm);
      },
    });
    const { construction } = makeConstruction(fixture, source);
    warm = await prepareFilePlaybackPeerRangeManifestAssetSourceWarm(
      warmOptions(fixture.registry, fixture.lease, construction),
    );

    const retirement = retireFilePlaybackAssetSourceWarm(warm);
    await vi.waitFor(() => expect(reentrantRetirement).not.toBeNull());

    expect(reentrantRetirement).toBe(retirement);
    await expect(retirement).resolves.toBe(true);
    expect(source.destroy).toHaveBeenCalledOnce();
  });

  it('joins reentrant construction retirement before any decoder source is published', async () => {
    const fixture = registryFixture();
    const source = fakeCutoverSource();
    const { construction, closeConstruction } = makeConstruction(fixture, source);
    let retired = false;

    await expect(
      prepareFilePlaybackPeerRangeManifestAssetSourceWarm(
        warmOptions(fixture.registry, fixture.lease, construction, {
          isCurrent: () => {
            if (!retired) {
              retired = true;
              void retireFilePlaybackPeerRangeManifestDecoderConstruction(construction);
            }
            return true;
          },
        }),
      ),
    ).rejects.toThrow('construction is stale');

    expect(closeConstruction).toHaveBeenCalledOnce();
    expect(source.prepare).not.toHaveBeenCalled();
    expect(source.destroy).not.toHaveBeenCalled();
  });

  it('rejects a different registry even when every public diagnostic is identical', async () => {
    const original = registryFixture();
    const lookalike = registryFixture();
    const source = fakeCutoverSource();
    const { construction, closeConstruction } = makeConstruction(original, source);

    await expect(
      prepareFilePlaybackPeerRangeManifestAssetSourceWarm(
        warmOptions(lookalike.registry, lookalike.lease, construction),
      ),
    ).rejects.toThrow('asset authority does not match');

    expect(closeConstruction).toHaveBeenCalledOnce();
    expect(source.prepare).not.toHaveBeenCalled();
    expect(source.destroy).not.toHaveBeenCalled();
  });

  it('rejects a wrong room token and retires the still-unused construction', async () => {
    const fixture = registryFixture();
    const source = fakeCutoverSource();
    const { construction, closeConstruction } = makeConstruction(fixture, source);

    await expect(
      prepareFilePlaybackPeerRangeManifestAssetSourceWarm(
        warmOptions(fixture.registry, fixture.lease, construction, {
          roomToken: Object.freeze({ room: 'wrong-room' }),
        }),
      ),
    ).rejects.toThrow('authority is stale');

    expect(closeConstruction).toHaveBeenCalledOnce();
    expect(source.prepare).not.toHaveBeenCalled();
  });

  it('rejects a forged asset lease and retires the still-unused construction', async () => {
    const fixture = registryFixture();
    const source = fakeCutoverSource();
    const { construction, closeConstruction } = makeConstruction(fixture, source);

    await expect(
      prepareFilePlaybackPeerRangeManifestAssetSourceWarm(
        warmOptions(fixture.registry, fixture.lease, construction, {
          assetLease: Object.freeze(Object.create(null)) as FilePlaybackAssetLease,
        }),
      ),
    ).rejects.toThrow('authority is stale');

    expect(closeConstruction).toHaveBeenCalledOnce();
    expect(source.prepare).not.toHaveBeenCalled();
  });

  it('retires the unused construction when its exact registry lease is already stale', async () => {
    const fixture = registryFixture();
    const source = fakeCutoverSource();
    const { construction, closeConstruction } = makeConstruction(fixture, source);
    await fixture.registry.retire(TOKEN, fixture.lease);

    await expect(
      prepareFilePlaybackPeerRangeManifestAssetSourceWarm(
        warmOptions(fixture.registry, fixture.lease, construction),
      ),
    ).rejects.toThrow('authority is stale');

    expect(closeConstruction).toHaveBeenCalledOnce();
    expect(source.prepare).not.toHaveBeenCalled();
    expect(source.destroy).not.toHaveBeenCalled();
  });
});

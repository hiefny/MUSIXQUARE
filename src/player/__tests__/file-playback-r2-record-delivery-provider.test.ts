import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_VERSION,
  FilePlaybackR2RecordDescriptorRegistry,
  type FilePlaybackR2RecordDeliveryScope,
  type FilePlaybackR2RecordDescriptorRef,
} from '../file-playback-r2-record-descriptor.ts';
import {
  createFilePlaybackR2RecordDeliveryProvider,
  FilePlaybackR2RecordDeliveryProviderForTests as FilePlaybackR2RecordDeliveryProvider,
} from '../file-playback-r2-record-delivery-provider.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';
import { R2RecordEncodedAudioSource } from '../sources/r2-record-encoded-audio-source.ts';

const NOW = 1_900_000_000_000;
const QUEUE_ID = '10000000-0000-4000-8000-000000000001' as QueueItemId;
const OTHER_QUEUE_ID = '10000000-0000-4000-8000-000000000002' as QueueItemId;
const SET_ID = '20000000-0000-4000-8000-000000000001';
const RECORD_ID = '30000000-0000-4000-8000-000000000001';
const KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const NONCE_PREFIX_B64 = 'AAAAAAAAAAA=';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function scope(
  overrides: Partial<FilePlaybackR2RecordDeliveryScope> = {},
): FilePlaybackR2RecordDeliveryScope {
  return {
    roomEpoch: 'room-epoch-1',
    bridgeGeneration: 'bridge-generation-1',
    bindingId: 'binding-1',
    queueItemId: QUEUE_ID,
    sourceIdentity: 'source-1',
    ...overrides,
  };
}

function publication(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    queueItemId: QUEUE_ID,
    sourceIdentity: 'source-1',
    transferSessionId: 'binding-1',
    applicationSessionId: 'room-epoch-1',
    storageRoomId: '123456',
    setId: SET_ID,
    encodedSize: 4,
    recordSize: 8 * 1024 * 1024,
    recordCount: 1,
    cryptoSecretDescriptor: {
      formatVersion: 2,
      objectId: SET_ID,
      plaintextSize: 4,
      recordSize: 8 * 1024 * 1024,
      recordCount: 1,
      noncePrefixB64: NONCE_PREFIX_B64,
      keyB64: KEY_B64,
    },
    records: [
      {
        index: 0,
        objectId: RECORD_ID,
        plaintextSize: 4,
        encryptedSize: 20,
      },
    ],
    name: 'concert.flac',
    mime: 'audio/flac',
    expiresAtEpochMs: NOW + 60_000,
    ...overrides,
  };
}

function registration(
  overrides: {
    readonly scope?: FilePlaybackR2RecordDeliveryScope;
    readonly descriptorId?: string;
    readonly publication?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    scope: overrides.scope ?? scope(),
    descriptorId: overrides.descriptorId ?? 'descriptor-1',
    descriptorVersion: FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_VERSION,
    publication: overrides.publication ?? publication(),
  };
}

function fakeSource(overrides: Partial<EncodedAudioSource> = {}): EncodedAudioSource & {
  readonly readAt: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const readAt = vi.fn(async () => new Uint8Array([7]));
  const close = vi.fn(async () => undefined);
  return {
    kind: 'r2-records',
    size: 4,
    identity: 'source-1',
    metadata: { name: 'concert.flac', mime: 'audio/flac' },
    readAt,
    close,
    ...overrides,
  } as EncodedAudioSource & {
    readonly readAt: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  };
}

function register(
  registry: FilePlaybackR2RecordDescriptorRegistry,
): Readonly<FilePlaybackR2RecordDescriptorRef> {
  return registry.register(registration());
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('FilePlaybackR2RecordDescriptorRegistry', () => {
  it('keeps raw R2 authority private and returns only a frozen data-only reference', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();

    const ref = register(registry);

    expect(Reflect.getPrototypeOf(ref)).toBeNull();
    expect(Reflect.getPrototypeOf(ref.scope)).toBeNull();
    expect(Object.isFrozen(ref)).toBe(true);
    expect(Object.isFrozen(ref.scope)).toBe(true);
    expect(Object.keys(ref)).toEqual(['scope', 'descriptorId', 'descriptorVersion']);
    expect(Object.keys(ref.scope)).toEqual([
      'roomEpoch',
      'bridgeGeneration',
      'bindingId',
      'queueItemId',
      'sourceIdentity',
    ]);
    const serialized = JSON.stringify(ref);
    expect(serialized).not.toContain(KEY_B64);
    expect(serialized).not.toContain(NONCE_PREFIX_B64);
    expect(serialized).not.toContain(RECORD_ID);
    expect(serialized).not.toContain('storageRoomId');
  });

  it('rejects accessors without invoking them at any descriptor level', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const value = publication();
    let getterCalls = 0;
    Object.defineProperty(value, 'records', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return [];
      },
    });

    expect(() => registry.register(registration({ publication: value }))).toThrow(
      /PUBLICATION_INVALID/,
    );
    expect(getterCalls).toBe(0);
  });

  it('enforces publication scope and the R2 source storage-room constraint', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();

    expect(() =>
      registry.register(
        registration({ publication: publication({ applicationSessionId: 'another-epoch' }) }),
      ),
    ).toThrow(/PUBLICATION_INVALID/);
    expect(() =>
      registry.register(
        registration({ publication: publication({ queueItemId: OTHER_QUEUE_ID }) }),
      ),
    ).toThrow(/PUBLICATION_INVALID/);
    expect(() =>
      registry.register(
        registration({ publication: publication({ transferSessionId: 'another-binding' }) }),
      ),
    ).toThrow(/PUBLICATION_INVALID/);
    expect(() =>
      registry.register(
        registration({ publication: publication({ sourceIdentity: 'another-source' }) }),
      ),
    ).toThrow(/PUBLICATION_INVALID/);
    expect(() =>
      registry.register(registration({ publication: publication({ storageRoomId: '000002' }) })),
    ).toThrow(/PUBLICATION_INVALID/);
  });

  it('scopes descriptor ids and tombstones to the full room, bridge, binding, queue, and source identity', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const firstScope = scope();
    const successorScope = scope({
      sourceIdentity: 'source-2',
    });
    const first = registry.register(registration({ scope: firstScope }));
    const successor = registry.register(
      registration({
        scope: successorScope,
        publication: publication({
          sourceIdentity: successorScope.sourceIdentity,
        }),
      }),
    );

    expect(first.descriptorId).toBe(successor.descriptorId);
    expect(registry.has(first)).toBe(true);
    expect(registry.has(successor)).toBe(true);
    await registry.retire(firstScope);
    expect(registry.has(first)).toBe(false);
    expect(registry.has(successor)).toBe(true);
    expect(() => registry.register(registration({ scope: firstScope }))).toThrow(/SCOPE_RETIRED/);
    expect(
      registry.register(
        registration({
          scope: successorScope,
          publication: publication({
            sourceIdentity: successorScope.sourceIdentity,
          }),
        }),
      ),
    ).toBe(successor);
  });

  it('is idempotent for one exact registration and tombstones a retired descriptor id', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const first = register(registry);
    const duplicate = registry.register(registration());

    expect(duplicate).toBe(first);
    expect(() =>
      registry.register(registration({ publication: publication({ name: 'different.flac' }) })),
    ).toThrow(/DESCRIPTOR_CONFLICT/);

    await registry.retire(scope());
    expect(registry.has(first)).toBe(false);
    expect(() => registry.register(registration())).toThrow(/SCOPE_RETIRED/);
    expect(() =>
      registry.register(registration({ descriptorId: 'descriptor-after-scope-retire' })),
    ).toThrow(/SCOPE_RETIRED/);
  });

  it('fences an exact scope even when retirement arrives before its descriptor', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const retiredScope = scope({ bindingId: 'binding-retired-before-register' });

    await registry.retire(retiredScope);

    expect(() =>
      registry.register(
        registration({
          scope: retiredScope,
          descriptorId: 'descriptor-late',
          publication: publication({
            transferSessionId: retiredScope.bindingId,
          }),
        }),
      ),
    ).toThrow(/SCOPE_RETIRED/);
    expect(
      registry.register(
        registration({
          scope: scope({ bridgeGeneration: 'bridge-generation-successor' }),
          descriptorId: 'descriptor-late',
        }),
      ),
    ).toMatchObject({ descriptorId: 'descriptor-late' });
  });

  it('allows credential refresh with a new descriptor id after expiry but not explicit retire', () => {
    let now = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const expired = registry.register(registration({ descriptorId: 'descriptor-expiring' }));

    now = NOW + 60_000;
    expect(registry.has(expired)).toBe(false);
    expect(
      registry.register(
        registration({
          descriptorId: 'descriptor-refreshed',
          publication: publication({ expiresAtEpochMs: now + 60_000 }),
        }),
      ),
    ).toMatchObject({ descriptorId: 'descriptor-refreshed' });
  });

  it('rejects duplicate R2 record object identities', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const recordSize = 8 * 1024 * 1024;
    const encodedSize = recordSize + 4;

    expect(() =>
      registry.register(
        registration({
          publication: publication({
            encodedSize,
            recordCount: 2,
            cryptoSecretDescriptor: {
              formatVersion: 2,
              objectId: SET_ID,
              plaintextSize: encodedSize,
              recordSize,
              recordCount: 2,
              noncePrefixB64: NONCE_PREFIX_B64,
              keyB64: KEY_B64,
            },
            records: [
              {
                index: 0,
                objectId: RECORD_ID,
                plaintextSize: recordSize,
                encryptedSize: recordSize + 16,
              },
              {
                index: 1,
                objectId: RECORD_ID,
                plaintextSize: 4,
                encryptedSize: 20,
              },
            ],
          }),
        }),
      ),
    ).toThrow(/OBJECT_ID_DUPLICATE/);
  });

  it('bounds live and retired descriptor slots while allowing an exact live duplicate', () => {
    let now = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const first = registry.register(registration({ descriptorId: 'descriptor-capacity-0' }));
    for (let index = 1; index < 1_024; index += 1) {
      registry.register(registration({ descriptorId: `descriptor-capacity-${index}` }));
    }
    expect(() =>
      registry.register(registration({ descriptorId: 'descriptor-capacity-overflow' })),
    ).toThrow(/REGISTRY_CAPACITY/);
    expect(registry.register(registration({ descriptorId: 'descriptor-capacity-0' }))).toBe(first);

    now = NOW + 60_000;
    expect(registry.has(first)).toBe(false);
    expect(() =>
      registry.register(
        registration({
          descriptorId: 'descriptor-after-prune',
          publication: publication({ expiresAtEpochMs: now + 60_000 }),
        }),
      ),
    ).toThrow(/REGISTRY_CAPACITY/);
  });

  it('keeps every explicitly retired exact scope fenced for the registry lifetime', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const registrationFor = (index: number) => {
      const exactScope = scope({
        roomEpoch: `room-epoch-${index}`,
        bridgeGeneration: `bridge-generation-${index}`,
        bindingId: `binding-${index}`,
      });
      return {
        exactScope,
        value: registration({
          scope: exactScope,
          descriptorId: 'descriptor-shared',
          publication: publication({
            applicationSessionId: exactScope.roomEpoch,
            transferSessionId: exactScope.bindingId,
            sourceIdentity: exactScope.sourceIdentity,
          }),
        }),
      };
    };

    for (let index = 0; index < 1_024; index += 1) {
      const current = registrationFor(index);
      registry.register(current.value);
      await registry.retire(current.exactScope);
    }

    expect(() => registry.register(registrationFor(1_024).value)).toThrow(/REGISTRY_CAPACITY/);
    expect(() => registry.register(registrationFor(0).value)).toThrow(/SCOPE_RETIRED/);
    expect(() => registry.register(registrationFor(1_023).value)).toThrow(/SCOPE_RETIRED/);
  });

  it('clears retained entries and permanently disposes the registry boundary', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const first = register(registry);

    await registry.clear();
    expect(registry.has(first)).toBe(false);
    expect(() => registry.register(registration())).toThrow(/DESCRIPTOR_RETIRED/);

    const second = registry.register(registration({ descriptorId: 'descriptor-2' }));
    expect(registry.has(second)).toBe(true);
    await registry.dispose();
    expect(registry.has(second)).toBe(false);
    expect(() =>
      registry.register(registration({ descriptorId: 'descriptor-after-dispose' })),
    ).toThrow(/REGISTRY_DISPOSED/);
    await expect(registry.clear()).resolves.toBeUndefined();
    await expect(registry.retire(scope())).resolves.toBeUndefined();
  });
});

describe('FilePlaybackR2RecordDeliveryProvider', () => {
  it('constructs the product contract and clears abort-ignoring opens before registry reuse', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const descriptor = register(registry);
    const stale = fakeSource();
    const successor = fakeSource();
    const creation = deferred<R2RecordEncodedAudioSource>();
    const create = vi
      .spyOn(R2RecordEncodedAudioSource, 'create')
      .mockReturnValueOnce(creation.promise)
      .mockResolvedValueOnce(successor as unknown as R2RecordEncodedAudioSource);
    const provider = createFilePlaybackR2RecordDeliveryProvider(registry);
    const open = provider.open({
      scope: scope(),
      descriptor,
      signal: new AbortController().signal,
    });

    const clearing = provider.clear();
    expect(provider.clear()).toBe(clearing);
    expect(create.mock.calls[0]?.[1]?.aborted).toBe(true);
    await expect(clearing).resolves.toBeUndefined();
    expect(registry.has(descriptor)).toBe(false);

    const successorDescriptor = registry.register(
      registration({ descriptorId: 'descriptor-after-clear' }),
    );
    creation.resolve(stale as unknown as R2RecordEncodedAudioSource);
    await expect(open).rejects.toMatchObject({ name: 'AbortError' });
    expect(stale.close).toHaveBeenCalledTimes(1);
    await expect(
      provider.open({
        scope: scope(),
        descriptor: successorDescriptor,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(successor);
  });

  it('permanently and idempotently disposes after revoking every provider-owned open', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const descriptor = register(registry);
    const stale = fakeSource();
    const creation = deferred<R2RecordEncodedAudioSource>();
    const create = vi.spyOn(R2RecordEncodedAudioSource, 'create').mockReturnValue(creation.promise);
    const provider = createFilePlaybackR2RecordDeliveryProvider(registry);
    const open = provider.open({
      scope: scope(),
      descriptor,
      signal: new AbortController().signal,
    });

    const disposal = provider.dispose();
    expect(provider.dispose()).toBe(disposal);
    expect(provider.clear()).toBe(disposal);
    expect(create.mock.calls[0]?.[1]?.aborted).toBe(true);
    await expect(disposal).resolves.toBeUndefined();
    expect(registry.has(descriptor)).toBe(false);
    await expect(
      provider.open({
        scope: scope(),
        descriptor,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/PROVIDER_DISPOSED/);

    creation.resolve(stale as unknown as R2RecordEncodedAudioSource);
    await expect(open).rejects.toMatchObject({ name: 'AbortError' });
    expect(stale.close).toHaveBeenCalledTimes(1);
  });

  it('validates exact scope, constructs the R2 source, and preflights one byte', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const descriptor = register(registry);
    const source = fakeSource();
    const successor = fakeSource({ identity: 'source-1' });
    const create = vi
      .spyOn(R2RecordEncodedAudioSource, 'create')
      .mockResolvedValueOnce(source as unknown as R2RecordEncodedAudioSource)
      .mockResolvedValueOnce(successor as unknown as R2RecordEncodedAudioSource);
    const provider = new FilePlaybackR2RecordDeliveryProvider(registry);
    const controller = new AbortController();

    await expect(
      provider.open({ scope: scope(), descriptor, signal: controller.signal }),
    ).resolves.toBe(source);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      storageRoomId: '123456',
      setId: SET_ID,
      identity: 'source-1',
      expiresAtEpochMs: NOW + 60_000,
    });
    expect(source.readAt).toHaveBeenCalledWith(0, 1, expect.any(AbortSignal));
    expect(source.close).not.toHaveBeenCalled();

    await expect(
      provider.open({ scope: scope(), descriptor, signal: new AbortController().signal }),
    ).resolves.toBe(successor);
    expect(create).toHaveBeenCalledTimes(2);
    expect(successor.readAt).toHaveBeenCalledWith(0, 1, expect.any(AbortSignal));

    await provider.retire(scope());
    expect(source.close).not.toHaveBeenCalled();
    expect(successor.close).not.toHaveBeenCalled();
    await expect(
      provider.open({ scope: scope(), descriptor, signal: new AbortController().signal }),
    ).rejects.toThrow(/SCOPE_RETIRED/);
    await source.close();
    await successor.close();
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(successor.close).toHaveBeenCalledTimes(1);
  });

  it('rejects only a concurrent open while allowing a later sequential source', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const descriptor = register(registry);
    const first = fakeSource();
    const second = fakeSource();
    const creation = deferred<R2RecordEncodedAudioSource>();
    const create = vi
      .spyOn(R2RecordEncodedAudioSource, 'create')
      .mockReturnValueOnce(creation.promise)
      .mockResolvedValueOnce(second as unknown as R2RecordEncodedAudioSource);
    const provider = new FilePlaybackR2RecordDeliveryProvider(registry);
    const active = provider.open({
      scope: scope(),
      descriptor,
      signal: new AbortController().signal,
    });

    await expect(
      provider.open({
        scope: scope(),
        descriptor,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/OPEN_ALREADY_ACTIVE/);
    creation.resolve(first as unknown as R2RecordEncodedAudioSource);
    await expect(active).resolves.toBe(first);
    await expect(
      provider.open({
        scope: scope(),
        descriptor,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(second);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rejects a mismatched exact scope before source construction', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const descriptor = register(registry);
    const create = vi.spyOn(R2RecordEncodedAudioSource, 'create');
    const provider = new FilePlaybackR2RecordDeliveryProvider(registry);

    await expect(
      provider.open({
        scope: scope({ bindingId: 'binding-2' }),
        descriptor,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/OPEN_SCOPE_MISMATCH/);
    await expect(
      provider.open({
        scope: scope({ sourceIdentity: 'source-2' }),
        descriptor,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/OPEN_SCOPE_MISMATCH/);
    expect(create).not.toHaveBeenCalled();
  });

  it('logically retires without joining an abort-ignoring constructor and closes its late source', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const descriptor = register(registry);
    const source = fakeSource();
    const creation = deferred<R2RecordEncodedAudioSource>();
    vi.spyOn(R2RecordEncodedAudioSource, 'create').mockReturnValue(creation.promise);
    const provider = new FilePlaybackR2RecordDeliveryProvider(registry);
    const open = provider.open({
      scope: scope(),
      descriptor,
      signal: new AbortController().signal,
    });

    const retirement = provider.retire(scope());
    expect(provider.retire(scope())).toBe(retirement);
    await retirement;
    expect(registry.has(descriptor)).toBe(false);

    creation.resolve(source as unknown as R2RecordEncodedAudioSource);
    await expect(open).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.readAt).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('closes a source that arrives after caller abort and keeps the descriptor retryable', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const descriptor = register(registry);
    const stale = fakeSource();
    const retry = fakeSource();
    const creation = deferred<R2RecordEncodedAudioSource>();
    vi.spyOn(R2RecordEncodedAudioSource, 'create')
      .mockReturnValueOnce(creation.promise)
      .mockResolvedValueOnce(retry as unknown as R2RecordEncodedAudioSource);
    const provider = new FilePlaybackR2RecordDeliveryProvider(registry);
    const controller = new AbortController();
    const open = provider.open({
      scope: scope(),
      descriptor,
      signal: controller.signal,
    });

    controller.abort(new DOMException('caller cancelled', 'AbortError'));
    creation.resolve(stale as unknown as R2RecordEncodedAudioSource);
    await expect(open).rejects.toMatchObject({ name: 'AbortError' });
    expect(stale.close).toHaveBeenCalledTimes(1);

    await expect(
      provider.open({
        scope: scope(),
        descriptor,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(retry);
    expect(retry.close).not.toHaveBeenCalled();
  });

  it('keeps a different generation retirement inert while the current open completes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const descriptor = register(registry);
    const source = fakeSource();
    const creation = deferred<R2RecordEncodedAudioSource>();
    const create = vi.spyOn(R2RecordEncodedAudioSource, 'create').mockReturnValue(creation.promise);
    const provider = new FilePlaybackR2RecordDeliveryProvider(registry);
    const open = provider.open({
      scope: scope(),
      descriptor,
      signal: new AbortController().signal,
    });

    await provider.retire(
      scope({
        bridgeGeneration: 'bridge-generation-stale',
        bindingId: 'binding-stale',
        queueItemId: OTHER_QUEUE_ID,
      }),
    );
    const constructionSignal = create.mock.calls[0]?.[1];
    expect(constructionSignal?.aborted).toBe(false);

    creation.resolve(source as unknown as R2RecordEncodedAudioSource);
    await expect(open).resolves.toBe(source);
    expect(source.close).not.toHaveBeenCalled();
  });

  it('closes a failed preflight once and permits a clean exact retry', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const descriptor = register(registry);
    const invalid = fakeSource({
      readAt: vi.fn(async () => new Uint8Array(0)),
    } as Partial<EncodedAudioSource>);
    const valid = fakeSource();
    vi.spyOn(R2RecordEncodedAudioSource, 'create')
      .mockResolvedValueOnce(invalid as unknown as R2RecordEncodedAudioSource)
      .mockResolvedValueOnce(valid as unknown as R2RecordEncodedAudioSource);
    const provider = new FilePlaybackR2RecordDeliveryProvider(registry);

    await expect(
      provider.open({
        scope: scope(),
        descriptor,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/PREFLIGHT_INVALID/);
    expect(invalid.close).toHaveBeenCalledTimes(1);

    await expect(
      provider.open({
        scope: scope(),
        descriptor,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(valid);
    expect(valid.close).not.toHaveBeenCalled();
  });

  it('rechecks descriptor expiry before construction', async () => {
    let now = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const registry = new FilePlaybackR2RecordDescriptorRegistry();
    const descriptor = register(registry);
    const create = vi.spyOn(R2RecordEncodedAudioSource, 'create');
    const provider = new FilePlaybackR2RecordDeliveryProvider(registry);

    now = NOW + 60_000;
    await expect(
      provider.open({
        scope: scope(),
        descriptor,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/DESCRIPTOR_EXPIRED/);
    expect(create).not.toHaveBeenCalled();
  });
});

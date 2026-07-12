import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackAssetRegistry,
  FilePlaybackAssetRegistryFatalError,
  parseFilePlaybackAssetBinding,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
} from '../file-playback-asset-registry.ts';
import type { EncodedAudioAsset } from '../sources/encoded-audio-asset.ts';
import {
  EncodedSourceClosedError,
  type EncodedAudioSource,
  type EncodedAudioSourceKind,
} from '../sources/encoded-audio-source.ts';

const TOKEN = Object.freeze({ room: 'asset-registry' });
const FOREIGN_TOKEN = Object.freeze({ room: 'foreign' });
const QIDS = [
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000003',
] as const satisfies readonly QueueItemId[];

function binding(index: number): FilePlaybackAssetBinding {
  return {
    queueItemId: QIDS[index]!,
    sourceIdentity: `distributed-source:${index + 1}`,
    transferSessionId: `transfer-session:${index + 1}`,
  };
}

function metadata(index = 0) {
  return { name: `take-${index + 1}.flac`, mime: 'audio/flac' };
}

function source(
  assetBinding: FilePlaybackAssetBinding,
  overrides: Partial<EncodedAudioSource> = {},
): EncodedAudioSource {
  return {
    kind: 'peer-range',
    size: 8,
    identity: assetBinding.sourceIdentity,
    metadata: metadata(),
    async readAt(_offset, length) {
      return new Uint8Array(length).fill(7);
    },
    async close() {
      return undefined;
    },
    ...overrides,
  };
}

class TestAsset implements EncodedAudioAsset {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: { readonly name: string; readonly mime: string };
  readonly activeLeaseCount = 0;
  readonly acquireCall: () => EncodedAudioSource;
  readonly closeCall: () => Promise<void>;

  constructor(
    assetBinding: FilePlaybackAssetBinding,
    options: {
      readonly kind?: EncodedAudioSourceKind;
      readonly size?: number;
      readonly metadata?: { readonly name: string; readonly mime: string };
      readonly acquire?: () => EncodedAudioSource;
      readonly close?: () => Promise<void>;
    } = {},
  ) {
    this.kind = options.kind ?? 'peer-range';
    this.size = options.size ?? 8;
    this.identity = assetBinding.sourceIdentity;
    this.metadata = options.metadata ?? metadata();
    this.acquireCall = options.acquire ?? (() => source(assetBinding));
    this.closeCall = options.close ?? (async () => undefined);
  }

  acquire(): EncodedAudioSource {
    return this.acquireCall();
  }

  close(): Promise<void> {
    return this.closeCall();
  }
}

function registry(
  options: { readonly maxLiveAssets?: number; readonly maxRetiredAssets?: number } = {},
) {
  const fatal = vi.fn();
  return {
    fatal,
    registry: new FilePlaybackAssetRegistry({
      liveRoomToken: TOKEN,
      onFatalRoom: fatal,
      ...options,
    }),
  };
}

async function flushCleanup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FilePlaybackAssetRegistry', () => {
  it('constructs a Blob asset with the distributed identity and exposes no body in snapshots', async () => {
    const setup = registry();
    const assetBinding = binding(0);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/flac' });
    const lease = setup.registry.admitBlob(TOKEN, assetBinding, blob, metadata());
    const snapshot = setup.registry.snapshotForLease(TOKEN, lease);

    expect(snapshot).toEqual({
      ...assetBinding,
      kind: 'blob',
      size: 4,
      ...metadata(),
    });
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.keys(snapshot ?? {})).not.toEqual(
      expect.arrayContaining(['asset', 'body', 'blob', 'arrayBuffer']),
    );
    const resolved = setup.registry.resolveBlobAsset(TOKEN, lease);
    expect(resolved).toEqual({ blob, binding: assetBinding, metadata: metadata() });
    expect(resolved?.blob).toBe(blob);
    expect(Object.getPrototypeOf(resolved)).toBeNull();
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved?.binding)).toBe(true);
    expect(Object.isFrozen(resolved?.metadata)).toBe(true);

    const reader = setup.registry.acquireSource(TOKEN, lease);
    expect(reader.identity).toBe(assetBinding.sourceIdentity);
    await expect(reader.readAt(1, 2, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([2, 3]),
    );
    await reader.close();
    await setup.registry.retire(TOKEN, lease);
  });

  it('replays only the exact Blob, binding, and metadata while preserving the live entry', () => {
    const setup = registry();
    const assetBinding = binding(0);
    const firstBlob = new Blob([new Uint8Array([1, 2, 3])]);
    const unrelatedBlob = new Blob([new Uint8Array([1, 2, 3])]);
    const first = setup.registry.admitBlob(TOKEN, assetBinding, firstBlob, metadata());

    expect(setup.registry.admitBlob(TOKEN, { ...assetBinding }, firstBlob, metadata())).toBe(first);
    expect(() =>
      setup.registry.admitBlob(TOKEN, assetBinding, firstBlob, {
        ...metadata(),
        name: 'renamed.flac',
      }),
    ).toThrow(/already owned/u);
    expect(() => setup.registry.admitBlob(TOKEN, assetBinding, unrelatedBlob, metadata())).toThrow(
      /conflicts with a live asset/u,
    );
    expect(setup.registry.resolveBlobAsset(TOKEN, first)?.blob).toBe(firstBlob);
    expect(setup.registry.activeAssetCount(TOKEN)).toBe(1);
  });

  it('transfers generic ownership, preserves same-object conflicts, and closes new conflicts', async () => {
    const setup = registry();
    const firstBinding = binding(0);
    const firstClose = vi.fn(async () => undefined);
    const firstAsset = new TestAsset(firstBinding, { close: firstClose });
    const first = setup.registry.admitEncodedAsset(TOKEN, firstBinding, firstAsset);

    expect(setup.registry.resolveBlobAsset(TOKEN, first)).toBeNull();
    expect(setup.registry.admitEncodedAsset(TOKEN, { ...firstBinding }, firstAsset)).toBe(first);
    expect(() => setup.registry.admitEncodedAsset(TOKEN, binding(1), firstAsset)).toThrow(
      /already owned/u,
    );
    expect(firstClose).not.toHaveBeenCalled();

    const conflictClose = vi.fn(async () => undefined);
    const conflict = new TestAsset(firstBinding, { close: conflictClose });
    expect(() => setup.registry.admitEncodedAsset(TOKEN, firstBinding, conflict)).toThrow(
      /conflicts with a live asset/u,
    );
    await flushCleanup();
    expect(conflictClose).toHaveBeenCalledOnce();
    expect(firstClose).not.toHaveBeenCalled();
    expect(setup.registry.snapshotForLease(TOKEN, first)?.queueItemId).toBe(
      firstBinding.queueItemId,
    );
  });

  it('enforces process-wide single ownership for transferred generic asset objects', async () => {
    const firstRoom = registry();
    const secondRoom = registry();
    const assetBinding = binding(0);
    const close = vi.fn(async () => undefined);
    const asset = new TestAsset(assetBinding, { close });
    const firstLease = firstRoom.registry.admitEncodedAsset(TOKEN, assetBinding, asset);

    expect(() => secondRoom.registry.admitEncodedAsset(TOKEN, assetBinding, asset)).toThrow(
      /owned by another room registry/u,
    );
    expect(close).not.toHaveBeenCalled();
    expect(firstRoom.registry.snapshotForLease(TOKEN, firstLease)?.sourceIdentity).toBe(
      assetBinding.sourceIdentity,
    );
    expect(secondRoom.registry.activeAssetCount(TOKEN)).toBe(0);

    await firstRoom.registry.retire(TOKEN, firstLease);
    expect(close).toHaveBeenCalledOnce();
    expect(() => secondRoom.registry.admitEncodedAsset(TOKEN, assetBinding, asset)).toThrow(
      /retired/u,
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('delegates the asset two-reader bound and synchronously revokes before async close', async () => {
    const setup = registry();
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
    const lease = setup.registry.admitBlob(TOKEN, binding(0), blob, metadata());
    const first = setup.registry.acquireSource(TOKEN, lease);
    const second = setup.registry.acquireSource(TOKEN, lease);

    expect(() => setup.registry.acquireSource(TOKEN, lease)).toThrow(
      /at most 2 concurrent leases/u,
    );
    await first.close();
    const replacement = setup.registry.acquireSource(TOKEN, lease);
    const retiring = setup.registry.retire(TOKEN, lease);
    expect(setup.registry.snapshotForLease(TOKEN, lease)).toBeNull();
    expect(setup.registry.resolveBlobAsset(TOKEN, lease)).toBeNull();
    expect(() => setup.registry.acquireSource(TOKEN, lease)).toThrow(/forged or retired/u);
    await retiring;
    await expect(second.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );
    await expect(replacement.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );
  });

  it('keeps immutable queue occurrence bindings stable across arbitrary external reorder', () => {
    const setup = registry();
    const first = setup.registry.admitBlob(
      TOKEN,
      binding(0),
      new Blob([new Uint8Array([1])]),
      metadata(0),
    );
    const second = setup.registry.admitBlob(
      TOKEN,
      binding(1),
      new Blob([new Uint8Array([2])]),
      metadata(1),
    );
    const queue = [QIDS[0], QIDS[1]];
    queue.reverse();

    expect(queue).toEqual([QIDS[1], QIDS[0]]);
    expect(setup.registry.snapshotForLease(TOKEN, first)?.queueItemId).toBe(QIDS[0]);
    expect(setup.registry.snapshotForLease(TOKEN, second)?.queueItemId).toBe(QIDS[1]);
  });

  it('tombstones retired queue, source, and transfer authorities independently', async () => {
    const setup = registry();
    const retiredBinding = binding(0);
    const retired = setup.registry.admitBlob(
      TOKEN,
      retiredBinding,
      new Blob([new Uint8Array([1])]),
      metadata(),
    );
    await setup.registry.retire(TOKEN, retired);

    const fresh = binding(1);
    const attempts: FilePlaybackAssetBinding[] = [
      { ...fresh, queueItemId: retiredBinding.queueItemId },
      { ...fresh, sourceIdentity: retiredBinding.sourceIdentity },
      { ...fresh, transferSessionId: retiredBinding.transferSessionId },
    ];
    for (const attempt of attempts) {
      expect(() =>
        setup.registry.admitBlob(TOKEN, attempt, new Blob([new Uint8Array([2])]), metadata(1)),
      ).toThrow(/authority is retired/u);
    }
    expect(setup.registry.activeAssetCount(TOKEN)).toBe(0);
    expect(setup.registry.retiredAssetCount(TOKEN)).toBe(1);
  });

  it('rejects stale, forged, foreign-registry leases and foreign tokens', async () => {
    const first = registry();
    const second = registry();
    const lease = first.registry.admitBlob(
      TOKEN,
      binding(0),
      new Blob([new Uint8Array([1])]),
      metadata(),
    );
    const forged = Object.freeze({}) as FilePlaybackAssetLease;
    let leaseTrapCalls = 0;
    const hostileLease = new Proxy(
      {},
      {
        get() {
          leaseTrapCalls += 1;
          return undefined;
        },
      },
    ) as FilePlaybackAssetLease;

    expect(first.registry.snapshotForLease(FOREIGN_TOKEN, lease)).toBeNull();
    expect(first.registry.resolveBlobAsset(FOREIGN_TOKEN, lease)).toBeNull();
    expect(first.registry.resolveBlobAsset(TOKEN, forged)).toBeNull();
    expect(first.registry.resolveBlobAsset(TOKEN, hostileLease)).toBeNull();
    expect(leaseTrapCalls).toBe(0);
    expect(second.registry.snapshotForLease(TOKEN, lease)).toBeNull();
    expect(() => first.registry.acquireSource(FOREIGN_TOKEN, lease)).toThrow(/room token/u);
    expect(() => second.registry.acquireSource(TOKEN, lease)).toThrow(/forged or retired/u);

    await first.registry.retire(TOKEN, lease);
    expect(first.registry.snapshotForLease(TOKEN, lease)).toBeNull();
    expect(first.registry.resolveBlobAsset(TOKEN, lease)).toBeNull();
    expect(() => first.registry.acquireSource(TOKEN, lease)).toThrow(/forged or retired/u);
  });

  it('closes transferred assets exactly once on retire, close, and retired-object replay', async () => {
    const setup = registry();
    const firstClose = vi.fn(async () => undefined);
    const firstAsset = new TestAsset(binding(0), { close: firstClose });
    const first = setup.registry.admitEncodedAsset(TOKEN, binding(0), firstAsset);

    const retiring = setup.registry.retire(TOKEN, first);
    expect(firstClose).toHaveBeenCalledOnce();
    await retiring;
    expect(() => setup.registry.admitEncodedAsset(TOKEN, binding(1), firstAsset)).toThrow(
      /retired/u,
    );
    expect(firstClose).toHaveBeenCalledOnce();

    const secondClose = vi.fn(async () => undefined);
    const secondAsset = new TestAsset(binding(1), { close: secondClose });
    setup.registry.admitEncodedAsset(TOKEN, binding(1), secondAsset);
    const closing = setup.registry.close(TOKEN);
    expect(secondClose).toHaveBeenCalledOnce();
    expect(setup.registry.activeAssetCount(TOKEN)).toBeNull();
    await closing;
    expect(secondClose).toHaveBeenCalledOnce();
    expect(setup.registry.close(TOKEN)).toBe(closing);
  });

  it('keeps caller ownership for foreign-token and already-closed admissions', async () => {
    const setup = registry();
    const foreignClose = vi.fn(async () => undefined);
    const foreignAsset = new TestAsset(binding(0), { close: foreignClose });
    expect(() => setup.registry.admitEncodedAsset(FOREIGN_TOKEN, binding(0), foreignAsset)).toThrow(
      /room token/u,
    );
    expect(foreignClose).not.toHaveBeenCalled();

    await setup.registry.close(TOKEN);
    const lateClose = vi.fn(async () => undefined);
    const lateAsset = new TestAsset(binding(1), { close: lateClose });
    expect(() => setup.registry.admitEncodedAsset(TOKEN, binding(1), lateAsset)).toThrow(/closed/u);
    await flushCleanup();
    expect(lateClose).not.toHaveBeenCalled();
    expect(setup.registry.isClosed()).toBe(true);
  });

  it('closes zero-size and malformed exact-token assets without invoking binding accessors', async () => {
    const setup = registry();
    const zeroClose = vi.fn(async () => undefined);
    const zero = new TestAsset(binding(0), { size: 0, close: zeroClose });
    expect(() => setup.registry.admitEncodedAsset(TOKEN, binding(0), zero)).toThrow(/invalid/u);
    await flushCleanup();
    expect(zeroClose).toHaveBeenCalledOnce();
    expect(() => setup.registry.admitBlob(TOKEN, binding(0), new Blob([]), metadata())).toThrow(
      /invalid/u,
    );

    let getterCalls = 0;
    const hostile = { ...binding(1) };
    Object.defineProperty(hostile, 'sourceIdentity', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return binding(1).sourceIdentity;
      },
    });
    const malformedClose = vi.fn(async () => undefined);
    const malformed = new TestAsset(binding(1), { close: malformedClose });
    expect(() => setup.registry.admitEncodedAsset(TOKEN, hostile, malformed)).toThrow(/binding/u);
    await flushCleanup();
    expect(getterCalls).toBe(0);
    expect(malformedClose).toHaveBeenCalledOnce();
  });

  it('validates every acquired source field and closes invalid values once before fail-close', async () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        value.kind = 'blob';
      },
      (value) => {
        value.size = 9;
      },
      (value) => {
        value.identity = 'distributed-source:foreign';
      },
      (value) => {
        value.metadata = { name: 'other.flac', mime: 'audio/flac' };
      },
      (value) => {
        delete value.readAt;
      },
      (value) => {
        delete value.close;
      },
    ];

    for (const mutate of mutations) {
      const setup = registry();
      const assetBinding = binding(0);
      const sourceClose = vi.fn(async () => undefined);
      const acquired = source(assetBinding, { close: sourceClose }) as unknown as Record<
        string,
        unknown
      >;
      mutate(acquired);
      const assetClose = vi.fn(async () => undefined);
      const asset = new TestAsset(assetBinding, {
        acquire: () => acquired as unknown as EncodedAudioSource,
        close: assetClose,
      });
      const lease = setup.registry.admitEncodedAsset(TOKEN, assetBinding, asset);

      expect(() => setup.registry.acquireSource(TOKEN, lease)).toThrow(
        FilePlaybackAssetRegistryFatalError,
      );
      await setup.registry.close(TOKEN);
      if ('close' in acquired) expect(sourceClose).toHaveBeenCalledOnce();
      else expect(sourceClose).not.toHaveBeenCalled();
      expect(assetClose).toHaveBeenCalledOnce();
      expect(setup.registry.snapshotForLease(TOKEN, lease)).toBeNull();
    }
  });

  it('waits for the once-only invalid-source cleanup before terminal close settles', async () => {
    const setup = registry();
    const assetBinding = binding(0);
    const sourceClosed = deferred<void>();
    const sourceClose = vi.fn(() => sourceClosed.promise);
    const invalid = source(assetBinding, {
      identity: 'distributed-source:mismatch',
      close: sourceClose,
    });
    const assetClose = vi.fn(async () => undefined);
    const lease = setup.registry.admitEncodedAsset(
      TOKEN,
      assetBinding,
      new TestAsset(assetBinding, { acquire: () => invalid, close: assetClose }),
    );

    expect(() => setup.registry.acquireSource(TOKEN, lease)).toThrow(
      FilePlaybackAssetRegistryFatalError,
    );
    const closing = setup.registry.close(TOKEN);
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await flushCleanup();
    expect(settled).toBe(false);
    expect(sourceClose).toHaveBeenCalledOnce();
    expect(assetClose).toHaveBeenCalledOnce();

    sourceClosed.resolve();
    await closing;
    expect(settled).toBe(true);
    expect(sourceClose).toHaveBeenCalledOnce();
  });

  it('publishes a frozen source wrapper over captured methods and immutable metadata', async () => {
    const setup = registry();
    const assetBinding = binding(0);
    const originalRead = vi.fn(async (_offset: number, length: number) =>
      new Uint8Array(length).fill(3),
    );
    const originalClose = vi.fn(async () => undefined);
    const mutatedRead = vi.fn(async (_offset: number, length: number) =>
      new Uint8Array(length).fill(9),
    );
    const mutatedClose = vi.fn(async () => undefined);
    const raw = source(assetBinding, {
      readAt: originalRead,
      close: originalClose,
    });
    const asset = new TestAsset(assetBinding, { acquire: () => raw });
    const lease = setup.registry.admitEncodedAsset(TOKEN, assetBinding, asset);
    const published = setup.registry.acquireSource(TOKEN, lease);

    Object.assign(raw, {
      identity: 'distributed-source:mutated',
      metadata: { name: 'mutated.flac', mime: 'audio/flac' },
      readAt: mutatedRead,
      close: mutatedClose,
    });

    expect(Object.getPrototypeOf(published)).toBeNull();
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.metadata)).toBe(true);
    expect(published.identity).toBe(assetBinding.sourceIdentity);
    expect(published.metadata).toEqual(metadata());
    await expect(published.readAt(0, 2, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([3, 3]),
    );
    const closing = published.close();
    expect(published.close()).toBe(closing);
    await closing;
    expect(originalRead).toHaveBeenCalledOnce();
    expect(mutatedRead).not.toHaveBeenCalled();
    expect(originalClose).toHaveBeenCalledOnce();
    expect(mutatedClose).not.toHaveBeenCalled();
  });

  it('publishes wrapper close authority before reentry and blocks late in-flight reads', async () => {
    const reentrantSetup = registry();
    const reentrantBinding = binding(0);
    let published!: EncodedAudioSource;
    let reentered: Promise<void> | null = null;
    const physicalClose = vi.fn(() => {
      reentered = published.close();
      return Promise.resolve();
    });
    const raw = source(reentrantBinding, { close: physicalClose });
    const reentrantLease = reentrantSetup.registry.admitEncodedAsset(
      TOKEN,
      reentrantBinding,
      new TestAsset(reentrantBinding, { acquire: () => raw }),
    );
    published = reentrantSetup.registry.acquireSource(TOKEN, reentrantLease);

    const closing = published.close();
    expect(reentered).toBe(closing);
    expect(published.close()).toBe(closing);
    await closing;
    expect(physicalClose).toHaveBeenCalledOnce();
    await expect(published.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );

    const pendingSetup = registry();
    const pendingBinding = binding(1);
    const pendingBytes = deferred<Uint8Array>();
    const pendingRaw = source(pendingBinding, {
      readAt: vi.fn(() => pendingBytes.promise),
    });
    const pendingLease = pendingSetup.registry.admitEncodedAsset(
      TOKEN,
      pendingBinding,
      new TestAsset(pendingBinding, { acquire: () => pendingRaw }),
    );
    const pendingSource = pendingSetup.registry.acquireSource(TOKEN, pendingLease);
    const read = pendingSource.readAt(0, 2, new AbortController().signal);
    await pendingSource.close();
    pendingBytes.resolve(new Uint8Array([1, 2]));
    await expect(read).rejects.toBeInstanceOf(EncodedSourceClosedError);
  });

  it('enforces exact range, abort, and result length at the canonical source wrapper', async () => {
    const setup = registry();
    const assetBinding = binding(0);
    const rawRead = vi.fn(async (_offset: number, _length: number) => new Uint8Array([1]));
    const lease = setup.registry.admitEncodedAsset(
      TOKEN,
      assetBinding,
      new TestAsset(assetBinding, {
        acquire: () => source(assetBinding, { readAt: rawRead }),
      }),
    );
    const published = setup.registry.acquireSource(TOKEN, lease);

    await expect(published.readAt(-1, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      RangeError,
    );
    const aborted = new AbortController();
    aborted.abort(new Error('caller aborted'));
    await expect(published.readAt(0, 1, aborted.signal)).rejects.toThrow('caller aborted');
    expect(rawRead).not.toHaveBeenCalled();
    await expect(published.readAt(0, 2, new AbortController().signal)).rejects.toThrow(
      /returned 1 bytes; expected 2/u,
    );
  });

  it('fences close-descriptor traps before ownership snapshots can become stale', async () => {
    const setup = registry();
    const outerBinding = binding(0);
    const nestedBinding = binding(1);
    const outerClose = vi.fn(async () => undefined);
    const nestedClose = vi.fn(async () => undefined);
    const target = new TestAsset(outerBinding, { close: outerClose });
    const nested = new TestAsset(nestedBinding, { close: nestedClose });
    let nestedError: unknown;
    let entered = false;
    const hostile = new Proxy(target, {
      getOwnPropertyDescriptor(object, property) {
        if (property === 'close' && !entered) {
          entered = true;
          try {
            setup.registry.admitEncodedAsset(TOKEN, nestedBinding, nested);
          } catch (error) {
            nestedError = error;
          }
        }
        return Reflect.getOwnPropertyDescriptor(object, property);
      },
    });

    expect(() => setup.registry.admitEncodedAsset(TOKEN, outerBinding, hostile)).toThrow(
      FilePlaybackAssetRegistryFatalError,
    );
    await setup.registry.close(TOKEN);
    expect(nestedError).toBeInstanceOf(FilePlaybackAssetRegistryFatalError);
    expect(outerClose).toHaveBeenCalledOnce();
    expect(nestedClose).toHaveBeenCalledOnce();
    expect(setup.registry.activeAssetCount(TOKEN)).toBeNull();
  });

  it('bounds hostile cyclic prototype walks and still cleans a discoverable close method', async () => {
    const setup = registry();
    const assetBinding = binding(0);
    const close = vi.fn(async () => undefined);
    const target = {
      kind: 'peer-range',
      size: 8,
      identity: assetBinding.sourceIdentity,
      metadata: metadata(),
      activeLeaseCount: 0,
      close,
    };
    let cyclic!: EncodedAudioAsset;
    cyclic = new Proxy(target, {
      getPrototypeOf() {
        return cyclic;
      },
    }) as unknown as EncodedAudioAsset;

    expect(() => setup.registry.admitEncodedAsset(TOKEN, assetBinding, cyclic)).toThrow(/invalid/u);
    await flushCleanup();
    expect(close).toHaveBeenCalledOnce();
    expect(setup.registry.isClosed()).toBe(false);
  });

  it('fences cleanup callbacks for rejected transferred assets', async () => {
    const setup = registry();
    const ownedIdentity = binding(0);
    const claimedBinding = binding(1);
    const nestedBinding = binding(2);
    const nestedClose = vi.fn(async () => undefined);
    const nested = new TestAsset(nestedBinding, { close: nestedClose });
    let nestedError: unknown;
    const rejectedClose = vi.fn(async () => {
      try {
        setup.registry.admitEncodedAsset(TOKEN, nestedBinding, nested);
      } catch (error) {
        nestedError = error;
      }
    });
    const rejected = new TestAsset(ownedIdentity, { close: rejectedClose });

    expect(() => setup.registry.admitEncodedAsset(TOKEN, claimedBinding, rejected)).toThrow(
      /identity does not match/u,
    );
    await setup.registry.close(TOKEN);
    expect(nestedError).toBeInstanceOf(FilePlaybackAssetRegistryFatalError);
    expect(rejectedClose).toHaveBeenCalledOnce();
    expect(nestedClose).toHaveBeenCalledOnce();
    expect(setup.fatal).toHaveBeenCalledOnce();
    expect(setup.registry.isClosed()).toBe(true);
  });

  it('fail-closes live capacity and cleans both owned and rejected assets exactly once', async () => {
    const setup = registry({ maxLiveAssets: 1 });
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    setup.registry.admitEncodedAsset(
      TOKEN,
      binding(0),
      new TestAsset(binding(0), { close: firstClose }),
    );

    expect(() =>
      setup.registry.admitEncodedAsset(
        TOKEN,
        binding(1),
        new TestAsset(binding(1), { close: secondClose }),
      ),
    ).toThrow(FilePlaybackAssetRegistryFatalError);
    await setup.registry.close(TOKEN);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    expect(setup.fatal).toHaveBeenCalledOnce();
    expect(setup.registry.isClosed()).toBe(true);
  });

  it('bounds unresolved rejected cleanup claims before taking ownership of another asset', () => {
    const setup = registry({ maxLiveAssets: 1 });
    const never = new Promise<void>(() => undefined);
    const claimedCloses: Array<ReturnType<typeof vi.fn>> = [];

    for (let index = 0; index < 17; index += 1) {
      const close = vi.fn(() => never);
      claimedCloses.push(close);
      const mismatched = new TestAsset(binding(1), { close });
      expect(() => setup.registry.admitEncodedAsset(TOKEN, binding(0), mismatched)).toThrow(
        /identity does not match/u,
      );
    }
    expect(claimedCloses.every((close) => close.mock.calls.length === 1)).toBe(true);

    const unclaimedClose = vi.fn(async () => undefined);
    const unclaimed = new TestAsset(binding(1), { close: unclaimedClose });
    expect(() => setup.registry.admitEncodedAsset(TOKEN, binding(0), unclaimed)).toThrow(
      FilePlaybackAssetRegistryFatalError,
    );
    expect(unclaimedClose).not.toHaveBeenCalled();
    expect(setup.fatal).toHaveBeenCalledOnce();
    expect(setup.registry.isClosed()).toBe(true);
  });

  it('fail-closes tombstone capacity without double-closing retired assets', async () => {
    const setup = registry({ maxRetiredAssets: 1 });
    const firstClose = vi.fn(async () => undefined);
    const first = setup.registry.admitEncodedAsset(
      TOKEN,
      binding(0),
      new TestAsset(binding(0), { close: firstClose }),
    );
    await setup.registry.retire(TOKEN, first);

    const secondClose = vi.fn(async () => undefined);
    const second = setup.registry.admitEncodedAsset(
      TOKEN,
      binding(1),
      new TestAsset(binding(1), { close: secondClose }),
    );
    expect(() => setup.registry.retire(TOKEN, second)).toThrow(FilePlaybackAssetRegistryFatalError);
    await setup.registry.close(TOKEN);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    expect(setup.fatal).toHaveBeenCalledOnce();
  });

  it('fail-closes cleanup reentry and also owns the nested exact-token asset', async () => {
    const setup = registry();
    const nestedClose = vi.fn(async () => undefined);
    const nestedAsset = new TestAsset(binding(1), { close: nestedClose });
    let nestedError: unknown;
    const outerClose = vi.fn(async () => {
      try {
        setup.registry.admitEncodedAsset(TOKEN, binding(1), nestedAsset);
      } catch (error) {
        nestedError = error;
      }
    });
    const outerAsset = new TestAsset(binding(0), { close: outerClose });
    const lease = setup.registry.admitEncodedAsset(TOKEN, binding(0), outerAsset);

    expect(() => setup.registry.retire(TOKEN, lease)).toThrow(FilePlaybackAssetRegistryFatalError);
    await setup.registry.close(TOKEN);
    expect(nestedError).toBeInstanceOf(FilePlaybackAssetRegistryFatalError);
    expect(outerClose).toHaveBeenCalledOnce();
    expect(nestedClose).toHaveBeenCalledOnce();
    expect(setup.registry.isClosed()).toBe(true);
  });

  it('parses exact descriptor-safe bindings and exact constructor options', () => {
    const canonical = parseFilePlaybackAssetBinding(binding(0));
    expect(canonical).toEqual(binding(0));
    expect(Object.getPrototypeOf(canonical)).toBeNull();
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(parseFilePlaybackAssetBinding({ ...binding(0), index: 0 })).toBeNull();
    expect(parseFilePlaybackAssetBinding({ ...binding(0), sourceIdentity: QIDS[0] })).toBeNull();

    let getterCalls = 0;
    const options = {
      liveRoomToken: TOKEN,
      get onFatalRoom() {
        getterCalls += 1;
        return vi.fn();
      },
    };
    expect(() => new FilePlaybackAssetRegistry(options)).toThrow(/options are invalid/u);
    expect(getterCalls).toBe(0);
    expect(
      () =>
        new FilePlaybackAssetRegistry({
          liveRoomToken: TOKEN,
          onFatalRoom: vi.fn(),
          maxLiveAssets: 0,
        }),
    ).toThrow(RangeError);
  });
});

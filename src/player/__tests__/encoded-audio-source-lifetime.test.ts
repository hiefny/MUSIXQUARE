import { describe, expect, it, vi } from 'vitest';

import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  EncodedSourceRangeError,
  type EncodedAudioSource,
} from '../sources/encoded-audio-source.ts';
import {
  EncodedAudioSourceLifetime,
  ENCODED_SOURCE_LIFETIME_DEFAULT_MAX_READ_TASKS,
  ENCODED_SOURCE_LIFETIME_MAX_READ_TASKS,
  EncodedSourceLifetimeCapacityError,
  EncodedSourceLifetimeLeaseActiveError,
} from '../sources/encoded-audio-source-lifetime.ts';
import {
  ENCODED_SOURCE_PORT_DEFAULT_MAX_PHYSICAL_READS,
  ENCODED_SOURCE_PORT_MAX_PHYSICAL_READS,
  EncodedSourcePortBroker,
  EncodedSourcePortClient,
  EncodedSourcePortError,
} from '../sources/encoded-source-port.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function requireAssigned<T>(read: () => T | null, message: string): T {
  const value = read();
  if (value === null) throw new Error(message);
  return value;
}

function source(
  readAt: EncodedAudioSource['readAt'] = async (offset, length) =>
    Uint8Array.from({ length }, (_, index) => (offset + index) & 0xff),
  options: {
    readonly size?: number;
    readonly identity?: string;
    readonly metadata?: EncodedAudioSource['metadata'];
    readonly close?: EncodedAudioSource['close'];
  } = {},
): EncodedAudioSource {
  return {
    kind: 'blob',
    size: options.size ?? 1_024,
    identity: options.identity ?? 'source:lifetime-fixture',
    metadata: options.metadata ?? { name: 'fixture.mp3', mime: 'audio/mpeg' },
    readAt,
    close: options.close ?? vi.fn(async () => undefined),
  };
}

async function flushTasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('EncodedAudioSourceLifetime', () => {
  it('keeps its source-read task limits aligned with the encoded-source port', () => {
    expect(ENCODED_SOURCE_LIFETIME_DEFAULT_MAX_READ_TASKS).toBe(
      ENCODED_SOURCE_PORT_DEFAULT_MAX_PHYSICAL_READS,
    );
    expect(ENCODED_SOURCE_LIFETIME_MAX_READ_TASKS).toBe(ENCODED_SOURCE_PORT_MAX_PHYSICAL_READS);
  });

  it.each([0, -1, 1.5, 65, Number.MAX_SAFE_INTEGER])(
    'rejects invalid source-read task limit %s',
    (maxReadTasks) => {
      expect(() => new EncodedAudioSourceLifetime({ source: source(), maxReadTasks })).toThrow(
        RangeError,
      );
    },
  );

  it('strictly validates and snapshots identity, metadata, kind, size, and methods', () => {
    expect(
      () =>
        new EncodedAudioSourceLifetime({
          source: { ...source(), identity: '' },
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new EncodedAudioSourceLifetime({
          source: { ...source(), size: -1 },
        }),
    ).toThrow(EncodedSourceRangeError);
    expect(
      () =>
        new EncodedAudioSourceLifetime({
          source: { ...source(), kind: 'unknown' as 'blob' },
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new EncodedAudioSourceLifetime({
          source: {
            ...source(),
            metadata: { name: 1 as never, mime: 'audio/mpeg' },
          },
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new EncodedAudioSourceLifetime({
          source: { ...source(), readAt: null as never },
        }),
    ).toThrow(TypeError);

    const metadata = { name: 'original.mp3', mime: 'audio/mpeg' };
    const underlying = source(undefined, { metadata });
    const lifetime = new EncodedAudioSourceLifetime({ source: underlying });
    metadata.name = 'mutated.mp3';
    const lease = lifetime.acquireLease();
    expect(lease.metadata).toEqual({ name: 'original.mp3', mime: 'audio/mpeg' });
    expect(Object.isFrozen(lease.metadata)).toBe(true);

    const contractOnlyMetadata = { name: `${'x'.repeat(1_024)}\n`, mime: '' };
    const contractOnlyLifetime = new EncodedAudioSourceLifetime({
      source: source(undefined, { metadata: contractOnlyMetadata }),
    });
    expect(contractOnlyLifetime.metadata).toEqual(contractOnlyMetadata);

    class ExtendedMetadata {
      readonly extra = true;

      get name(): string {
        return 'extended.mp3';
      }

      get mime(): string {
        return 'audio/mpeg';
      }
    }
    const extendedLifetime = new EncodedAudioSourceLifetime({
      source: source(undefined, { metadata: new ExtendedMetadata() }),
    });
    expect(extendedLifetime.metadata).toEqual({
      name: 'extended.mp3',
      mime: 'audio/mpeg',
    });
  });

  it('issues one active non-owning lease at a time with monotonic generations', async () => {
    const lifetime = new EncodedAudioSourceLifetime({ source: source() });
    const first = lifetime.acquireLease();
    expect(first.leaseGeneration).toBe(1);
    expect(lifetime.hasActiveLease).toBe(true);
    expect(() => lifetime.acquireLease()).toThrow(EncodedSourceLifetimeLeaseActiveError);

    const firstClose = first.close();
    expect(first.close()).toBe(firstClose);
    await firstClose;
    expect(first.closed).toBe(true);
    expect(lifetime.hasActiveLease).toBe(false);

    const second = lifetime.acquireLease();
    expect(second.leaseGeneration).toBe(2);
    expect(second.identity).toBe(first.identity);
    expect(second.metadata).toBe(first.metadata);
  });

  it('publishes an exact owned byte copy and never delegates zero-length reads', async () => {
    const backing = Uint8Array.of(10, 11, 12, 13);
    const readAt = vi.fn(async (offset: number, length: number) =>
      backing.subarray(offset, offset + length),
    );
    const lifetime = new EncodedAudioSourceLifetime({
      source: source(readAt, { size: backing.byteLength }),
    });
    const lease = lifetime.acquireLease();

    const bytes = await lease.readAt(1, 2, new AbortController().signal);
    backing[1] = 99;
    expect(bytes).toEqual(Uint8Array.of(11, 12));
    expect(lifetime.readTaskCount).toBe(0);

    await expect(
      lease.readAt(backing.byteLength, 0, new AbortController().signal),
    ).resolves.toEqual(new Uint8Array());
    expect(readAt).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid ranges or signals and preserves an already-aborted reason', async () => {
    const readAt = vi.fn(async () => Uint8Array.of(1));
    const lifetime = new EncodedAudioSourceLifetime({ source: source(readAt, { size: 4 }) });
    const lease = lifetime.acquireLease();

    await expect(lease.readAt(4, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceRangeError,
    );
    await expect(lease.readAt(0, 1, {} as AbortSignal)).rejects.toBeInstanceOf(TypeError);
    const controller = new AbortController();
    const reason = new Error('superseded');
    controller.abort(reason);
    await expect(lease.readAt(0, 1, controller.signal)).rejects.toBe(reason);
    expect(readAt).not.toHaveBeenCalled();
    expect(lifetime.readTaskCount).toBe(0);
  });

  it('rejects malformed or short underlying byte results as integrity failures', async () => {
    const malformed = new EncodedAudioSourceLifetime({
      source: source(async () => new Uint8Array(0), { size: 4 }),
    });
    await expect(
      malformed.acquireLease().readAt(0, 1, new AbortController().signal),
    ).rejects.toBeInstanceOf(EncodedSourceIntegrityError);

    const exotic = new EncodedAudioSourceLifetime({
      source: source(async () => new ArrayBuffer(1) as never, { size: 4 }),
    });
    await expect(
      exotic.acquireLease().readAt(0, 1, new AbortController().signal),
    ).rejects.toBeInstanceOf(EncodedSourceIntegrityError);
  });

  it('aborts lease reads immediately without closing the owned source', async () => {
    const physical = deferred<Uint8Array>();
    const close = vi.fn(async () => undefined);
    let physicalSignal: AbortSignal | null = null;
    const lifetime = new EncodedAudioSourceLifetime({
      source: source(
        (_offset, _length, signal) => {
          physicalSignal = signal;
          return physical.promise;
        },
        { close },
      ),
    });
    const lease = lifetime.acquireLease();
    const read = lease.readAt(0, 1, new AbortController().signal);
    await flushTasks();
    expect(lifetime.readTaskCount).toBe(1);

    await lease.close();
    await expect(read).rejects.toBeInstanceOf(EncodedSourceClosedError);
    expect(
      requireAssigned(() => physicalSignal, 'physical read signal was not captured').aborted,
    ).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(lifetime.readTaskCount).toBe(1);

    physical.resolve(Uint8Array.of(1));
    await flushTasks();
    expect(lifetime.readTaskCount).toBe(0);
  });

  it('keeps retired abort-resistant reads in one global cap across successor leases', async () => {
    const pending: Deferred<Uint8Array>[] = [];
    const readAt = vi.fn(() => {
      const task = deferred<Uint8Array>();
      pending.push(task);
      return task.promise;
    });
    const lifetime = new EncodedAudioSourceLifetime({
      source: source(readAt),
      maxReadTasks: 2,
    });
    const firstLease = lifetime.acquireLease();
    const first = firstLease.readAt(0, 1, new AbortController().signal);
    const second = firstLease.readAt(1, 1, new AbortController().signal);
    await flushTasks();
    expect(lifetime.readTaskCount).toBe(2);
    await firstLease.close();
    await expect(first).rejects.toBeInstanceOf(EncodedSourceClosedError);
    await expect(second).rejects.toBeInstanceOf(EncodedSourceClosedError);

    const successor = lifetime.acquireLease();
    await expect(successor.readAt(2, 1, new AbortController().signal)).rejects.toEqual(
      new EncodedSourceLifetimeCapacityError(2),
    );
    expect(readAt).toHaveBeenCalledTimes(2);
    expect(lifetime.readTaskCount).toBe(2);

    pending[0]?.resolve(Uint8Array.of(1));
    await flushTasks();
    expect(lifetime.readTaskCount).toBe(1);
    const successorRead = successor.readAt(2, 1, new AbortController().signal);
    await flushTasks();
    expect(readAt).toHaveBeenCalledTimes(3);
    pending[2]?.resolve(Uint8Array.of(3));
    await expect(successorRead).resolves.toEqual(Uint8Array.of(3));
    pending[1]?.resolve(Uint8Array.of(2));
    await flushTasks();
    expect(lifetime.readTaskCount).toBe(0);
  });

  it('keeps an externally aborted source read task charged until actual settlement', async () => {
    const physical = deferred<Uint8Array>();
    const lifetime = new EncodedAudioSourceLifetime({
      source: source(() => physical.promise),
      maxReadTasks: 1,
    });
    const lease = lifetime.acquireLease();
    const controller = new AbortController();
    const read = lease.readAt(0, 1, controller.signal);
    await flushTasks();
    const reason = new Error('caller-cancelled');
    controller.abort(reason);
    await expect(read).rejects.toBe(reason);
    expect(lifetime.readTaskCount).toBe(1);
    await expect(lease.readAt(1, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceLifetimeCapacityError,
    );

    physical.resolve(Uint8Array.of(1));
    await flushTasks();
    expect(lifetime.readTaskCount).toBe(0);
  });

  it('makes lifetime close authoritative, idempotent, and exactly-once for ownership', async () => {
    const physical = deferred<Uint8Array>();
    const close = vi.fn(async () => undefined);
    const lifetime = new EncodedAudioSourceLifetime({
      source: source(() => physical.promise, { close }),
    });
    const lease = lifetime.acquireLease();
    const read = lease.readAt(0, 1, new AbortController().signal);
    await flushTasks();

    const closing = lifetime.close();
    expect(lifetime.close()).toBe(closing);
    await closing;
    await expect(read).rejects.toBeInstanceOf(EncodedSourceClosedError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(lifetime.closed).toBe(true);
    expect(lease.closed).toBe(true);
    expect(lifetime.readTaskCount).toBe(1);
    expect(() => lifetime.acquireLease()).toThrow(EncodedSourceClosedError);
    await expect(lease.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );

    physical.resolve(Uint8Array.of(1));
    await flushTasks();
    expect(lifetime.readTaskCount).toBe(0);
  });

  it('does not retry or leak a synchronous or asynchronous underlying close failure', async () => {
    const syncClose = vi.fn(() => {
      throw new Error('sync close failed');
    });
    const syncLifetime = new EncodedAudioSourceLifetime({
      source: source(undefined, { close: syncClose as EncodedAudioSource['close'] }),
    });
    await expect(syncLifetime.close()).resolves.toBeUndefined();
    await expect(syncLifetime.close()).resolves.toBeUndefined();
    expect(syncClose).toHaveBeenCalledTimes(1);

    const asyncClose = vi.fn(async () => {
      throw new Error('async close failed');
    });
    const asyncLifetime = new EncodedAudioSourceLifetime({
      source: source(undefined, { close: asyncClose }),
    });
    await expect(asyncLifetime.close()).resolves.toBeUndefined();
    expect(asyncClose).toHaveBeenCalledTimes(1);
  });

  it('claims close ownership before invoking a reentrant source callback', async () => {
    let lifetime!: EncodedAudioSourceLifetime;
    const close = vi.fn(() => lifetime.close());
    lifetime = new EncodedAudioSourceLifetime({
      source: source(undefined, { close }),
    });

    const closing = lifetime.close();
    expect(lifetime.close()).toBe(closing);
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not deadlock when asynchronous source cleanup awaits reentrant close', async () => {
    let lifetime!: EncodedAudioSourceLifetime;
    let cleanupFinished = false;
    const close = vi.fn(async () => {
      await lifetime.close();
      cleanupFinished = true;
    });
    lifetime = new EncodedAudioSourceLifetime({
      source: source(undefined, { close }),
    });

    const closing = lifetime.close();
    expect(lifetime.close()).toBe(closing);
    await closing;
    await flushTasks();
    expect(cleanupFinished).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('plugs sequential leases directly into existing source-port brokers', async () => {
    const close = vi.fn(async () => undefined);
    const lifetime = new EncodedAudioSourceLifetime({ source: source(undefined, { close }) });

    const firstChannel = new MessageChannel();
    const firstLease = lifetime.acquireLease();
    const firstBroker = new EncodedSourcePortBroker({
      source: firstLease,
      port: firstChannel.port1,
      generation: 101,
    });
    const firstClient = new EncodedSourcePortClient({
      port: firstChannel.port2,
      generation: 101,
      size: firstLease.size,
    });
    await expect(firstClient.readAt(7, 2, new AbortController().signal)).resolves.toEqual(
      Uint8Array.of(7, 8),
    );
    await firstClient.close();
    await vi.waitFor(() => expect(firstBroker.closed).toBe(true));
    expect(firstLease.closed).toBe(true);
    expect(close).not.toHaveBeenCalled();

    const secondChannel = new MessageChannel();
    const secondLease = lifetime.acquireLease();
    const secondBroker = new EncodedSourcePortBroker({
      source: secondLease,
      port: secondChannel.port1,
      generation: 102,
    });
    const secondClient = new EncodedSourcePortClient({
      port: secondChannel.port2,
      generation: 102,
      size: secondLease.size,
    });
    await expect(secondClient.readAt(9, 2, new AbortController().signal)).resolves.toEqual(
      Uint8Array.of(9, 10),
    );
    await secondClient.close();
    await vi.waitFor(() => expect(secondBroker.closed).toBe(true));
    expect(close).not.toHaveBeenCalled();

    await lifetime.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('maps a successor lease capacity rejection to a retryable busy port error', async () => {
    const pending = deferred<Uint8Array>();
    const lifetime = new EncodedAudioSourceLifetime({
      source: source(() => pending.promise),
      maxReadTasks: 1,
    });

    const firstChannel = new MessageChannel();
    const firstLease = lifetime.acquireLease();
    const firstBroker = new EncodedSourcePortBroker({
      source: firstLease,
      port: firstChannel.port1,
      generation: 201,
    });
    const firstClient = new EncodedSourcePortClient({
      port: firstChannel.port2,
      generation: 201,
      size: firstLease.size,
    });
    const firstRead = firstClient.readAt(0, 1, new AbortController().signal);
    await vi.waitFor(() => expect(lifetime.readTaskCount).toBe(1));
    await firstClient.close();
    await expect(firstRead).rejects.toBeInstanceOf(EncodedSourceClosedError);
    await vi.waitFor(() => expect(firstBroker.closed).toBe(true));

    const secondChannel = new MessageChannel();
    const secondLease = lifetime.acquireLease();
    const secondBroker = new EncodedSourcePortBroker({
      source: secondLease,
      port: secondChannel.port1,
      generation: 202,
    });
    const secondClient = new EncodedSourcePortClient({
      port: secondChannel.port2,
      generation: 202,
      size: secondLease.size,
    });
    const capacityError = await secondClient
      .readAt(1, 1, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(capacityError).toBeInstanceOf(EncodedSourcePortError);
    expect(capacityError).toMatchObject({ code: 'busy' });

    await secondClient.close();
    await vi.waitFor(() => expect(secondBroker.closed).toBe(true));
    pending.resolve(Uint8Array.of(1));
    await vi.waitFor(() => expect(lifetime.readTaskCount).toBe(0));
    await lifetime.close();
  });
});

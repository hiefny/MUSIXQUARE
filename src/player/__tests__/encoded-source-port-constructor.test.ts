import { beforeEach, describe, expect, it, vi } from 'vitest';

const acquireLifecycleLease = vi.hoisted(() => vi.fn());

vi.mock('../diagnostics/file-playback-universal-lifecycle-diagnostics.ts', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../diagnostics/file-playback-universal-lifecycle-diagnostics.ts')
    >();
  return {
    ...actual,
    acquireFilePlaybackUniversalLifecycleLease: acquireLifecycleLease,
  };
});

import { getFilePlaybackUniversalLifecycleSnapshotForTests } from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';
import { EncodedSourcePortBroker } from '../sources/encoded-source-port.ts';

class ConstructorPort {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  closeCount = 0;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  start(): void {}

  close(): void {
    this.closeCount += 1;
  }

  postMessage(): void {}

  emit(value: unknown): void {
    const event = { data: value } as MessageEvent<unknown>;
    for (const listener of [...(this.listeners.get('message') ?? [])]) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

function source(): EncodedAudioSource {
  return {
    kind: 'blob',
    size: 16,
    identity: 'constructor-source',
    metadata: { name: 'constructor.flac', mime: 'audio/flac' },
    readAt: async () => Uint8Array.of(1),
    close: async () => undefined,
  };
}

describe('EncodedSourcePortBroker constructor ownership', () => {
  beforeEach(() => {
    acquireLifecycleLease.mockReset();
    acquireLifecycleLease.mockImplementation(() => {
      throw new Error('synthetic lifecycle acquisition failure');
    });
  });

  it('closes the transferred port exactly once without installing listeners or changing counters when acquisition fails', () => {
    const port = new ConstructorPort();
    const baseline = getFilePlaybackUniversalLifecycleSnapshotForTests().kinds.ports;

    expect(
      () =>
        new EncodedSourcePortBroker({
          source: source(),
          port: port as unknown as MessagePort,
          generation: 1,
        }),
    ).toThrow(/acquisition failure/);

    expect(port.closeCount).toBe(1);
    expect(port.listeners.size).toBe(0);
    expect(getFilePlaybackUniversalLifecycleSnapshotForTests().kinds.ports).toEqual(baseline);
  });

  it('snapshots hostile option accessors exactly once before lifecycle acquisition', async () => {
    const port = new ConstructorPort();
    const closeSource = vi.fn(async () => undefined);
    const accesses = new Map<string, number>();
    const once = <T>(key: string, value: T): T => {
      const count = (accesses.get(key) ?? 0) + 1;
      accesses.set(key, count);
      if (count > 1) throw new Error(`synthetic ${key} accessor re-entry`);
      return value;
    };
    const hostileSource = Object.defineProperties(
      {
        kind: 'blob',
        identity: 'hostile-constructor-source',
        metadata: { name: 'hostile.flac', mime: 'audio/flac' },
        readAt: async () => Uint8Array.of(1),
        close: closeSource,
      },
      {
        size: {
          enumerable: true,
          get: () => once('source.size', 16),
        },
      },
    ) as unknown as EncodedAudioSource;
    const signal = new AbortController().signal;
    const options = Object.defineProperties(
      { port: port as unknown as MessagePort },
      {
        source: { enumerable: true, get: () => once('options.source', hostileSource) },
        generation: { enumerable: true, get: () => once('options.generation', 7) },
        maxPhysicalReads: {
          enumerable: true,
          get: () => once('options.maxPhysicalReads', 2),
        },
        lifetimeSignal: {
          enumerable: true,
          get: () => once('options.lifetimeSignal', signal),
        },
      },
    ) as unknown as ConstructorParameters<typeof EncodedSourcePortBroker>[0];
    acquireLifecycleLease.mockImplementation(() => {
      const retirement = Object.freeze({ release: vi.fn(), forceUnconfirmed: vi.fn() });
      return Object.freeze({
        beginRetire: vi.fn(() => retirement),
        forceUnconfirmed: vi.fn(),
      });
    });

    const broker = new EncodedSourcePortBroker(options);
    expect(broker.size).toBe(16);
    expect(broker.generation).toBe(7);
    await broker.close();

    expect(Object.fromEntries(accesses)).toEqual({
      'options.source': 1,
      'options.generation': 1,
      'options.maxPhysicalReads': 1,
      'options.lifetimeSignal': 1,
      'source.size': 1,
    });
    expect(closeSource).toHaveBeenCalledOnce();
    expect(port.closeCount).toBe(1);
  });

  it('closes the transferred port without acquiring a lease when an option getter throws', () => {
    const port = new ConstructorPort();
    const options = Object.defineProperties(
      { port: port as unknown as MessagePort },
      {
        source: {
          enumerable: true,
          get: () => {
            throw new Error('synthetic source getter failure');
          },
        },
      },
    ) as unknown as ConstructorParameters<typeof EncodedSourcePortBroker>[0];

    expect(() => new EncodedSourcePortBroker(options)).toThrow(/source getter failure/);
    expect(acquireLifecycleLease).not.toHaveBeenCalled();
    expect(port.closeCount).toBe(1);
    expect(port.listeners.size).toBe(0);
  });

  it('fails the exact broker closed when pending-read lifecycle acquisition fails', async () => {
    const port = new ConstructorPort();
    const closeSource = vi.fn(async () => undefined);
    const readAt = vi.fn(async () => Uint8Array.of(1));
    const portRetirement = Object.freeze({
      release: vi.fn(),
      forceUnconfirmed: vi.fn(),
    });
    const portLease = Object.freeze({
      beginRetire: vi.fn(() => portRetirement),
      forceUnconfirmed: vi.fn(),
    });
    acquireLifecycleLease.mockImplementation((kind: string) => {
      if (kind === 'ports') return portLease;
      throw new Error('synthetic pending read acquisition failure');
    });
    const broker = new EncodedSourcePortBroker({
      source: {
        ...source(),
        readAt,
        close: closeSource,
      },
      port: port as unknown as MessagePort,
      generation: 1,
    });

    expect(() =>
      port.emit({
        type: 'encoded-source:read',
        generation: 1,
        decoderGeneration: 1,
        requestId: 1,
        offset: 0,
        length: 1,
      }),
    ).not.toThrow();
    await Promise.resolve();

    expect(broker.closed).toBe(true);
    expect(readAt).not.toHaveBeenCalled();
    expect(closeSource).toHaveBeenCalledOnce();
    expect(port.closeCount).toBe(1);
    expect(portLease.forceUnconfirmed).toHaveBeenCalledOnce();
  });
});

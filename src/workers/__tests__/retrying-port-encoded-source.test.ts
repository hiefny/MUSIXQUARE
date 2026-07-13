import { afterEach, describe, expect, it, vi } from 'vitest';

import { EncodedSourceClosedError } from '../../player/sources/encoded-audio-source.ts';
import {
  ENCODED_SOURCE_PORT_MAX_READ_BYTES,
  EncodedSourcePortError,
} from '../../player/sources/encoded-source-port.ts';
import {
  RetryingPortEncodedSource,
  RetryingPortEncodedSourceError,
} from '../retrying-port-encoded-source.ts';

type RetryingPortEncodedSourceClient = ConstructorParameters<
  typeof RetryingPortEncodedSource
>[0]['client'];

const FIXED_BUSY_ATTEMPTS = 129;

function client(
  options: {
    readonly readAt?: RetryingPortEncodedSourceClient['readAt'];
    readonly close?: RetryingPortEncodedSourceClient['close'];
  } = {},
): RetryingPortEncodedSourceClient & {
  readonly readAt: ReturnType<typeof vi.fn<RetryingPortEncodedSourceClient['readAt']>>;
  readonly close: ReturnType<typeof vi.fn<RetryingPortEncodedSourceClient['close']>>;
} {
  return {
    readAt: vi.fn(
      options.readAt ??
        (async (_offset: number, length: number) => new Uint8Array(length).fill(0x5a)),
    ),
    close: vi.fn(options.close ?? (async () => undefined)),
  };
}

function source(
  portClient: RetryingPortEncodedSourceClient,
  size = ENCODED_SOURCE_PORT_MAX_READ_BYTES * 2,
): RetryingPortEncodedSource {
  return new RetryingPortEncodedSource({
    size,
    identity: 'worker-port-source:test',
    client: portClient,
  });
}

describe('RetryingPortEncodedSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exposes only the narrow random-access contract and delegates exact bounded reads', async () => {
    const portClient = client();
    const encoded = source(portClient);

    expect('kind' in encoded).toBe(false);
    expect('metadata' in encoded).toBe(false);
    await expect(encoded.readAt(7, 3, new AbortController().signal)).resolves.toEqual(
      Uint8Array.of(0x5a, 0x5a, 0x5a),
    );
    expect(portClient.readAt).toHaveBeenCalledTimes(1);
    expect(portClient.readAt).toHaveBeenCalledWith(7, 3, expect.any(AbortSignal));

    await expect(
      encoded.readAt(0, ENCODED_SOURCE_PORT_MAX_READ_BYTES + 1, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'source-read-overrun' });
    expect(portClient.readAt).toHaveBeenCalledTimes(1);
  });

  it('retries only explicit port busy failures and eventually publishes the exact bytes', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const portClient = client({
      readAt: async (_offset, length) => {
        attempts += 1;
        if (attempts < 4) throw new EncodedSourcePortError('busy');
        return new Uint8Array(length).fill(0x31);
      },
    });
    const encoded = source(portClient);
    const result = encoded.readAt(0, 2, new AbortController().signal);

    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual(Uint8Array.of(0x31, 0x31));
    expect(portClient.readAt).toHaveBeenCalledTimes(4);
  });

  it('stops at the fixed retry ceiling without accumulating an unbounded queue', async () => {
    vi.useFakeTimers();
    const portClient = client({
      readAt: async () => {
        throw new EncodedSourcePortError('busy');
      },
    });
    const encoded = source(portClient);
    const outcome = encoded
      .readAt(0, 1, new AbortController().signal)
      .catch((error: unknown) => error);

    await vi.runAllTimersAsync();
    const error = await outcome;
    expect(error).toBeInstanceOf(RetryingPortEncodedSourceError);
    expect(error).toMatchObject({ code: 'source-busy-timeout' });
    expect(portClient.readAt).toHaveBeenCalledTimes(FIXED_BUSY_ATTEMPTS);
  });

  it('preserves the caller abort reason and never retries a different failure', async () => {
    vi.useFakeTimers();
    const abortingClient = client({
      readAt: async () => {
        throw new EncodedSourcePortError('busy');
      },
    });
    const abortingSource = source(abortingClient);
    const controller = new AbortController();
    const reason = new Error('exact caller abort');
    const aborted = abortingSource.readAt(0, 1, controller.signal).catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(reason);
    await vi.runAllTimersAsync();
    expect(await aborted).toBe(reason);
    expect(abortingClient.readAt).toHaveBeenCalledTimes(1);

    const terminal = new Error('terminal source failure');
    const failingClient = client({
      readAt: async () => {
        throw terminal;
      },
    });
    const failingSource = source(failingClient);
    await expect(failingSource.readAt(0, 1, new AbortController().signal)).rejects.toBe(terminal);
    expect(failingClient.readAt).toHaveBeenCalledTimes(1);
  });

  it('owns and closes its port client exactly once through one idempotent promise', async () => {
    let resolveClientClose!: () => void;
    const clientClose = new Promise<void>((resolve) => {
      resolveClientClose = resolve;
    });
    const portClient = client({ close: () => clientClose });
    const encoded = source(portClient);

    const first = encoded.close();
    const second = encoded.close();
    expect(second).toBe(first);
    expect(portClient.close).toHaveBeenCalledTimes(1);
    await expect(encoded.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );

    resolveClientClose();
    await first;
    expect(portClient.close).toHaveBeenCalledTimes(1);
  });
});

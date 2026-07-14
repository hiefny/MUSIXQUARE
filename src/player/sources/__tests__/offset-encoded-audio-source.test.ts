import { describe, expect, it, vi } from 'vitest';

import {
  EncodedSourceBusyError,
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  EncodedSourceRangeError,
  type EncodedAudioSource,
} from '../encoded-audio-source.ts';
import { OffsetEncodedAudioSource } from '../offset-encoded-audio-source.ts';
import { PEER_RANGE_MAX_READ_BYTES } from '../peer-range-protocol.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => index & 0xff);
}

function encodedSource(
  bytes: Uint8Array,
  options: Partial<EncodedAudioSource> = {},
): EncodedAudioSource {
  return {
    kind: options.kind ?? 'peer-range',
    size: options.size ?? bytes.byteLength,
    identity: options.identity ?? 'bundle:source-1',
    metadata: options.metadata ?? { name: 'concert.mp3', mime: 'audio/mpeg' },
    readAt:
      options.readAt ??
      (async (offset, length) => Uint8Array.from(bytes.subarray(offset, offset + length))),
    close: options.close ?? (async () => undefined),
  };
}

describe('OffsetEncodedAudioSource', () => {
  it('maps exact 0/1/boundary reads while preserving source identity and metadata', async () => {
    const bytes = pattern(PEER_RANGE_MAX_READ_BYTES + 300);
    const readAt = vi.fn(async (offset: number, length: number) =>
      Uint8Array.from(bytes.subarray(offset, offset + length)),
    );
    const source = encodedSource(bytes, {
      kind: 'r2-records',
      identity: 'bundle:exact',
      metadata: { name: 'long.aac', mime: 'audio/aac' },
      readAt,
    });
    const view = new OffsetEncodedAudioSource({
      source,
      mediaOffset: 129,
      mediaSize: PEER_RANGE_MAX_READ_BYTES,
    });
    const signal = new AbortController().signal;

    expect(Object.isFrozen(view)).toBe(true);
    expect(view).toMatchObject({
      kind: 'r2-records',
      size: PEER_RANGE_MAX_READ_BYTES,
      identity: 'bundle:exact',
      metadata: { name: 'long.aac', mime: 'audio/aac' },
      mediaOffset: 129,
    });
    await expect(view.readAt(0, 0, signal)).resolves.toEqual(new Uint8Array(0));
    expect(readAt).not.toHaveBeenCalled();
    await expect(view.readAt(0, 1, signal)).resolves.toEqual(bytes.subarray(129, 130));
    await expect(view.readAt(1, 3, signal)).resolves.toEqual(bytes.subarray(130, 133));
    await expect(view.readAt(0, PEER_RANGE_MAX_READ_BYTES, signal)).resolves.toHaveLength(
      PEER_RANGE_MAX_READ_BYTES,
    );
    expect(readAt.mock.calls).toEqual([
      [129, 1, expect.any(AbortSignal)],
      [130, 3, expect.any(AbortSignal)],
      [129, PEER_RANGE_MAX_READ_BYTES, expect.any(AbortSignal)],
    ]);
  });

  it('rejects 64 KiB + 1, logical overflow, and unsafe construction geometry', async () => {
    const readAt = vi.fn(async () => new Uint8Array(1));
    const source = encodedSource(new Uint8Array(PEER_RANGE_MAX_READ_BYTES + 2), { readAt });
    const view = new OffsetEncodedAudioSource({
      source,
      mediaOffset: 0,
      mediaSize: PEER_RANGE_MAX_READ_BYTES + 1,
    });
    const signal = new AbortController().signal;

    await expect(view.readAt(0, PEER_RANGE_MAX_READ_BYTES + 1, signal)).rejects.toBeInstanceOf(
      EncodedSourceRangeError,
    );
    await expect(view.readAt(PEER_RANGE_MAX_READ_BYTES, 2, signal)).rejects.toBeInstanceOf(
      EncodedSourceRangeError,
    );
    expect(readAt).not.toHaveBeenCalled();
    expect(
      () =>
        new OffsetEncodedAudioSource({
          source: encodedSource(new Uint8Array(0), { size: Number.MAX_SAFE_INTEGER }),
          mediaOffset: Number.MAX_SAFE_INTEGER,
          mediaSize: 1,
        }),
    ).toThrow(/exceeds source size|MAX_SAFE_INTEGER/i);
  });

  it('snapshots fields and methods once and keeps private geometry authoritative', async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5);
    const metadata = { name: 'stable.wav', mime: 'audio/wav' };
    const originalRead = vi.fn(async (offset: number, length: number) =>
      Uint8Array.from(bytes.subarray(offset, offset + length)),
    );
    const owned = encodedSource(bytes, { metadata, readAt: originalRead });
    let sourceGets = 0;
    const options = {
      get source() {
        sourceGets += 1;
        return owned;
      },
      get mediaOffset() {
        return 1;
      },
      get mediaSize() {
        return 3;
      },
    };
    const view = new OffsetEncodedAudioSource(options);

    metadata.name = 'mutated.mp3';
    owned.readAt = async () => Uint8Array.of(99);
    expect(sourceGets).toBe(1);
    expect(view.metadata).toEqual({ name: 'stable.wav', mime: 'audio/wav' });
    await expect(view.readAt(0, 3, new AbortController().signal)).resolves.toEqual(
      Uint8Array.of(2, 3, 4),
    );
    expect(originalRead).toHaveBeenCalledWith(1, 3, expect.any(AbortSignal));
  });

  it('rejects short and non-Uint8Array source results', async () => {
    const short = new OffsetEncodedAudioSource({
      source: encodedSource(new Uint8Array(4), { readAt: async () => new Uint8Array(2) }),
      mediaOffset: 0,
      mediaSize: 4,
    });
    await expect(short.readAt(0, 4, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceIntegrityError,
    );

    const wrongView = new OffsetEncodedAudioSource({
      source: encodedSource(new Uint8Array(4), {
        readAt: async () => new Uint16Array(2) as unknown as Uint8Array,
      }),
      mediaOffset: 0,
      mediaSize: 4,
    });
    await expect(wrongView.readAt(0, 4, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceIntegrityError,
    );
  });

  it('settles promptly on abort, forwards the signal, and suppresses late completion', async () => {
    const pending = deferred<Uint8Array>();
    const started = deferred<void>();
    let readSignal: AbortSignal | null = null;
    const view = new OffsetEncodedAudioSource({
      source: encodedSource(new Uint8Array(4), {
        readAt: async (_offset, _length, signal) => {
          readSignal = signal;
          started.resolve();
          return pending.promise;
        },
      }),
      mediaOffset: 0,
      mediaSize: 4,
    });
    const controller = new AbortController();
    const result = view.readAt(0, 4, controller.signal);

    await started.promise;
    controller.abort(new Error('reader moved'));
    await expect(result).rejects.toThrow('reader moved');
    expect(readSignal?.aborted).toBe(true);
    pending.resolve(new Uint8Array(4));
  });

  it('bounds abort-resistant physical reads and restores capacity after physical settlement', async () => {
    const physicalReads = Array.from({ length: 9 }, () => deferred<Uint8Array>());
    let readCount = 0;
    const view = new OffsetEncodedAudioSource({
      source: encodedSource(Uint8Array.of(1), {
        readAt: async () => physicalReads[readCount++]!.promise,
      }),
      mediaOffset: 0,
      mediaSize: 1,
    });

    for (let index = 0; index < 8; index += 1) {
      const controller = new AbortController();
      const result = view.readAt(0, 1, controller.signal);
      await vi.waitFor(() => expect(readCount).toBe(index + 1));
      controller.abort(new Error(`logical abort ${index}`));
      await expect(result).rejects.toThrow(`logical abort ${index}`);
    }
    await expect(view.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceBusyError,
    );
    expect(readCount).toBe(8);

    physicalReads[0]!.resolve(Uint8Array.of(1));
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    const resumedController = new AbortController();
    const resumed = view.readAt(0, 1, resumedController.signal);
    await vi.waitFor(() => expect(readCount).toBe(9));
    resumedController.abort(new Error('resumed logical abort'));
    await expect(resumed).rejects.toThrow('resumed logical abort');
    for (const physical of physicalReads.slice(1)) physical.resolve(Uint8Array.of(1));
  });

  it('closes its owned source exactly once, supports reentry, and aborts an active read', async () => {
    const pending = deferred<Uint8Array>();
    const started = deferred<void>();
    let view!: OffsetEncodedAudioSource;
    const close = vi.fn(async () => {
      await view.close();
    });
    view = new OffsetEncodedAudioSource({
      source: encodedSource(new Uint8Array(4), {
        readAt: async () => {
          started.resolve();
          return pending.promise;
        },
        close,
      }),
      mediaOffset: 0,
      mediaSize: 4,
    });
    const result = view.readAt(0, 4, new AbortController().signal);
    await started.promise;

    const firstClose = view.close();
    const secondClose = view.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    await expect(result).rejects.toBeInstanceOf(EncodedSourceClosedError);
    expect(close).toHaveBeenCalledOnce();
    pending.resolve(new Uint8Array(4));
    await expect(view.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );
  });

  it('leaves source ownership with the caller when construction fails', () => {
    const close = vi.fn(async () => undefined);
    const owned = encodedSource(new Uint8Array(4), { close });

    expect(
      () => new OffsetEncodedAudioSource({ source: owned, mediaOffset: 3, mediaSize: 2 }),
    ).toThrow(EncodedSourceRangeError);
    expect(close).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  CODEC_TIMELINE_MANIFEST_HEADER_BYTES,
  CODEC_TIMELINE_MANIFEST_MAX_BYTES,
} from '../../manifests/codec-timeline-manifest.ts';
import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  EncodedSourceRangeError,
  type EncodedAudioSource,
} from '../encoded-audio-source.ts';
import {
  ManifestPrefixedEncodedAudioSource,
  type ManifestPrefixedEncodedAudioSourceOptions,
} from '../manifest-prefixed-encoded-audio-source.ts';
import { PEER_RANGE_MAX_READ_BYTES } from '../peer-range-protocol.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pattern(length: number, start = 0): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (start + index) & 0xff);
}

function encodedSource(
  bytes: Uint8Array,
  options: Partial<EncodedAudioSource> = {},
): EncodedAudioSource {
  return {
    kind: options.kind ?? 'peer-range',
    size: options.size ?? bytes.byteLength,
    identity: options.identity ?? 'source:exact-1',
    metadata: options.metadata ?? { name: 'concert.flac', mime: 'audio/flac' },
    readAt:
      options.readAt ??
      (async (offset, length) => Uint8Array.from(bytes.subarray(offset, offset + length))),
    close: options.close ?? (async () => undefined),
  };
}

function source(
  media = pattern(PEER_RANGE_MAX_READ_BYTES + 32, 91),
  manifest = pattern(CODEC_TIMELINE_MANIFEST_HEADER_BYTES, 7),
) {
  return new ManifestPrefixedEncodedAudioSource({
    manifestBytes: manifest,
    media: encodedSource(media),
  });
}

describe('ManifestPrefixedEncodedAudioSource', () => {
  it('serves exact prefix-only, media-only, and cross-boundary reads with one media read at most', async () => {
    const manifest = pattern(CODEC_TIMELINE_MANIFEST_HEADER_BYTES, 11);
    const media = pattern(PEER_RANGE_MAX_READ_BYTES + 64, 101);
    const readAt = vi.fn(async (offset: number, length: number) =>
      Uint8Array.from(media.subarray(offset, offset + length)),
    );
    const prefixed = new ManifestPrefixedEncodedAudioSource({
      manifestBytes: manifest,
      media: encodedSource(media, { readAt }),
    });
    const signal = new AbortController().signal;

    await expect(prefixed.readAt(0, 1, signal)).resolves.toEqual(manifest.subarray(0, 1));
    await expect(prefixed.readAt(17, 0, signal)).resolves.toEqual(new Uint8Array(0));
    await expect(prefixed.readAt(7, 19, signal)).resolves.toEqual(manifest.subarray(7, 26));
    expect(readAt).not.toHaveBeenCalled();

    await expect(prefixed.readAt(manifest.byteLength + 3, 9, signal)).resolves.toEqual(
      media.subarray(3, 12),
    );
    expect(readAt).toHaveBeenLastCalledWith(3, 9, expect.any(AbortSignal));

    const cross = await prefixed.readAt(manifest.byteLength - 5, 13, signal);
    expect(cross).toEqual(Uint8Array.from([...manifest.subarray(-5), ...media.subarray(0, 8)]));
    expect(readAt).toHaveBeenCalledTimes(2);
    expect(readAt).toHaveBeenLastCalledWith(0, 8, expect.any(AbortSignal));
  });

  it('accepts a 64 KiB read and rejects 64 KiB + 1 before touching media', async () => {
    const prefixed = source();
    const signal = new AbortController().signal;

    await expect(prefixed.readAt(0, PEER_RANGE_MAX_READ_BYTES, signal)).resolves.toHaveLength(
      PEER_RANGE_MAX_READ_BYTES,
    );
    await expect(prefixed.readAt(0, PEER_RANGE_MAX_READ_BYTES + 1, signal)).rejects.toBeInstanceOf(
      EncodedSourceRangeError,
    );
  });

  it('preserves exact source fields while isolating manifest, metadata, and method mutation', async () => {
    const manifest = pattern(CODEC_TIMELINE_MANIFEST_HEADER_BYTES, 31);
    const originalPrefix = Uint8Array.from(manifest);
    const media = Uint8Array.of(4, 5, 6, 7);
    const metadata = { name: 'take.wav', mime: 'audio/wav' };
    const readAt = vi.fn(async (offset: number, length: number) =>
      Uint8Array.from(media.subarray(offset, offset + length)),
    );
    const owned = encodedSource(media, {
      kind: 'r2-records',
      identity: 'asset:immutable',
      metadata,
      readAt,
    });
    const prefixed = new ManifestPrefixedEncodedAudioSource({
      manifestBytes: manifest,
      media: owned,
    });

    manifest.fill(0);
    metadata.name = 'changed.mp3';
    owned.readAt = async () => Uint8Array.of(99);
    expect(Object.isFrozen(prefixed)).toBe(true);
    expect(prefixed).toMatchObject({
      kind: 'r2-records',
      identity: 'asset:immutable',
      metadata: { name: 'take.wav', mime: 'audio/wav' },
      manifestSize: CODEC_TIMELINE_MANIFEST_HEADER_BYTES,
      mediaSize: 4,
    });
    await expect(
      prefixed.readAt(0, originalPrefix.byteLength, new AbortController().signal),
    ).resolves.toEqual(originalPrefix);
    await expect(
      prefixed.readAt(originalPrefix.byteLength, 4, new AbortController().signal),
    ).resolves.toEqual(media);
    expect(readAt).toHaveBeenCalledOnce();
  });

  it('borrows Blob bytes through intrinsics and never closes the Blob', async () => {
    const media = Uint8Array.of(10, 20, 30, 40);
    const blob = new Blob([media], { type: 'audio/flac' });
    Object.defineProperty(blob, 'size', { configurable: true, get: () => Number.MAX_SAFE_INTEGER });
    Object.defineProperty(blob, 'slice', {
      configurable: true,
      value: () => {
        throw new Error('instance slice must not run');
      },
    });
    const prefixed = new ManifestPrefixedEncodedAudioSource({
      manifestBytes: pattern(CODEC_TIMELINE_MANIFEST_HEADER_BYTES),
      media: blob,
      identity: 'blob:borrowed',
      metadata: { name: 'blob.flac', mime: 'audio/flac' },
    });

    expect(prefixed.mediaSize).toBe(4);
    await expect(
      prefixed.readAt(prefixed.manifestSize + 1, 2, new AbortController().signal),
    ).resolves.toEqual(Uint8Array.of(20, 30));
    await prefixed.close();

    const stillReadable = await Blob.prototype.arrayBuffer.call(blob);
    expect(new Uint8Array(stillReadable)).toEqual(media);
  });

  it('validates canonical manifest bounds, exact Uint8Array storage, metadata, and safe total size', () => {
    const media = encodedSource(Uint8Array.of(1));
    const construct = (manifestBytes: unknown, mediaOverride = media) =>
      new ManifestPrefixedEncodedAudioSource({
        manifestBytes: manifestBytes as Uint8Array,
        media: mediaOverride,
      });

    expect(() => construct(new Uint8Array(CODEC_TIMELINE_MANIFEST_HEADER_BYTES - 1))).toThrow(
      /128 to 262144/i,
    );
    expect(() => construct(new Uint8Array(CODEC_TIMELINE_MANIFEST_MAX_BYTES + 1))).toThrow(
      /128 to 262144/i,
    );
    expect(() => construct(new Int16Array(CODEC_TIMELINE_MANIFEST_HEADER_BYTES))).toThrow(
      /Uint8Array/i,
    );
    expect(() => construct(new DataView(new ArrayBuffer(256)))).toThrow(/Uint8Array/i);
    expect(() => construct({ byteLength: CODEC_TIMELINE_MANIFEST_HEADER_BYTES })).toThrow(
      /Uint8Array/i,
    );
    if (typeof SharedArrayBuffer !== 'undefined') {
      expect(() => construct(new Uint8Array(new SharedArrayBuffer(128)))).toThrow(/local storage/i);
    }
    expect(() =>
      construct(
        new Uint8Array(CODEC_TIMELINE_MANIFEST_HEADER_BYTES),
        encodedSource(Uint8Array.of(1), {
          size: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).toThrow(/MAX_SAFE_INTEGER/i);
    expect(
      () =>
        new ManifestPrefixedEncodedAudioSource({
          manifestBytes: new Uint8Array(CODEC_TIMELINE_MANIFEST_HEADER_BYTES),
          media: encodedSource(Uint8Array.of(1), {
            metadata: { name: 'bad\nname', mime: 'audio/flac' },
          }),
        }),
    ).toThrow(/name/i);
    expect(
      () =>
        new ManifestPrefixedEncodedAudioSource({
          manifestBytes: new Uint8Array(CODEC_TIMELINE_MANIFEST_HEADER_BYTES),
          media: encodedSource(Uint8Array.of(1), {
            metadata: { name: 'good', mime: 'audio/flac; codecs=x' },
          }),
        }),
    ).toThrow(/mime/i);
  });

  it('reads option fields once and resists accessor ABA', async () => {
    const first = encodedSource(Uint8Array.of(7));
    const second = encodedSource(Uint8Array.of(9), { identity: 'source:wrong' });
    let mediaReads = 0;
    const options = {
      manifestBytes: pattern(CODEC_TIMELINE_MANIFEST_HEADER_BYTES),
      get media() {
        mediaReads += 1;
        return mediaReads === 1 ? first : second;
      },
    } as unknown as ManifestPrefixedEncodedAudioSourceOptions;

    const prefixed = new ManifestPrefixedEncodedAudioSource(options);
    expect(mediaReads).toBe(1);
    expect(prefixed.identity).toBe('source:exact-1');
    await expect(
      prefixed.readAt(prefixed.manifestSize, 1, new AbortController().signal),
    ).resolves.toEqual(Uint8Array.of(7));
  });

  it('rejects short or wrong-view media results without exposing partial bytes', async () => {
    const manifest = pattern(CODEC_TIMELINE_MANIFEST_HEADER_BYTES);
    const short = new ManifestPrefixedEncodedAudioSource({
      manifestBytes: manifest,
      media: encodedSource(new Uint8Array(4), { readAt: async () => new Uint8Array(3) }),
    });
    await expect(
      short.readAt(manifest.byteLength, 4, new AbortController().signal),
    ).rejects.toBeInstanceOf(EncodedSourceIntegrityError);

    const wrongView = new ManifestPrefixedEncodedAudioSource({
      manifestBytes: manifest,
      media: encodedSource(new Uint8Array(4), {
        readAt: async () => new Int16Array(2) as unknown as Uint8Array,
      }),
    });
    await expect(
      wrongView.readAt(manifest.byteLength, 4, new AbortController().signal),
    ).rejects.toBeInstanceOf(EncodedSourceIntegrityError);
  });

  it('settles promptly on abort and suppresses a late media completion', async () => {
    const pending = deferred<Uint8Array>();
    const started = deferred<void>();
    let readSignal: AbortSignal | null = null;
    const manifest = pattern(CODEC_TIMELINE_MANIFEST_HEADER_BYTES);
    const prefixed = new ManifestPrefixedEncodedAudioSource({
      manifestBytes: manifest,
      media: encodedSource(new Uint8Array(4), {
        readAt: async (_offset, _length, signal) => {
          readSignal = signal;
          started.resolve();
          return pending.promise;
        },
      }),
    });
    const controller = new AbortController();
    const result = prefixed.readAt(manifest.byteLength, 4, controller.signal);

    await started.promise;
    controller.abort(new Error('superseded'));
    await expect(result).rejects.toThrow('superseded');
    expect(readSignal?.aborted).toBe(true);
    pending.resolve(new Uint8Array(4));
  });

  it('bounds uncancellable Blob reads and restores a slot only after physical settlement', async () => {
    const physicalReads = Array.from({ length: 9 }, () => deferred<ArrayBuffer>());
    let readCount = 0;
    const manifest = pattern(CODEC_TIMELINE_MANIFEST_HEADER_BYTES);
    const manifestSize = manifest.byteLength;
    vi.resetModules();
    const arrayBuffer = vi
      .spyOn(Blob.prototype, 'arrayBuffer')
      .mockImplementation(async () => physicalReads[readCount++]!.promise);

    try {
      const [{ ManifestPrefixedEncodedAudioSource: DynamicPrefixed }, { EncodedSourceBusyError }] =
        await Promise.all([
          import('../manifest-prefixed-encoded-audio-source.ts'),
          import('../encoded-audio-source.ts'),
        ]);
      const prefixed = new DynamicPrefixed({
        manifestBytes: manifest,
        media: new Blob([Uint8Array.of(1)]),
        identity: 'blob:uncancellable',
        metadata: { name: 'slow.flac', mime: 'audio/flac' },
      });

      for (let index = 0; index < 8; index += 1) {
        const controller = new AbortController();
        const result = prefixed.readAt(manifestSize, 1, controller.signal);
        await vi.waitFor(() => expect(readCount).toBe(index + 1));
        controller.abort(new Error(`logical abort ${index}`));
        await expect(result).rejects.toThrow(`logical abort ${index}`);
      }

      await expect(
        prefixed.readAt(manifestSize, 1, new AbortController().signal),
      ).rejects.toBeInstanceOf(EncodedSourceBusyError);
      expect(readCount).toBe(8);

      physicalReads[0]!.resolve(Uint8Array.of(1).buffer);
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      const resumedController = new AbortController();
      const resumed = prefixed.readAt(manifestSize, 1, resumedController.signal);
      await vi.waitFor(() => expect(readCount).toBe(9));
      resumedController.abort(new Error('resumed logical abort'));
      await expect(resumed).rejects.toThrow('resumed logical abort');
    } finally {
      for (const physical of physicalReads) physical.resolve(Uint8Array.of(1).buffer);
      arrayBuffer.mockRestore();
    }
  });

  it('uses captured TypedArray intrinsics without exposing its private manifest', async () => {
    const manifest = pattern(CODEC_TIMELINE_MANIFEST_HEADER_BYTES, 47);
    const expected = Uint8Array.from(manifest);
    const expectedLength = expected.byteLength;
    const media = encodedSource(Uint8Array.of(1));
    const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object;
    const byteLengthDescriptor = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      'byteLength',
    )!;
    const ownSpeciesDescriptor = Object.getOwnPropertyDescriptor(Uint8Array, Symbol.species);
    const species = vi.fn(function PoisonedSpecies() {
      throw new Error('private manifest reached TypedArray species');
    });
    const subarray = vi.spyOn(Uint8Array.prototype, 'subarray').mockImplementation(() => {
      throw new Error('poisoned subarray');
    });
    const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(() => {
      throw new Error('poisoned set');
    });
    Object.defineProperty(typedArrayPrototype, 'byteLength', {
      configurable: true,
      get: () => 1,
    });
    Object.defineProperty(Uint8Array, Symbol.species, {
      configurable: true,
      value: species,
    });

    let result: Uint8Array;
    let subarrayCalls = -1;
    let setCalls = -1;
    let speciesCalls = -1;
    try {
      const prefixed = new ManifestPrefixedEncodedAudioSource({
        manifestBytes: manifest,
        media,
      });
      result = await prefixed.readAt(0, expectedLength, new AbortController().signal);
      subarrayCalls = subarray.mock.calls.length;
      setCalls = set.mock.calls.length;
      speciesCalls = species.mock.calls.length;
    } finally {
      Object.defineProperty(typedArrayPrototype, 'byteLength', byteLengthDescriptor);
      if (ownSpeciesDescriptor) {
        Object.defineProperty(Uint8Array, Symbol.species, ownSpeciesDescriptor);
      } else {
        Reflect.deleteProperty(Uint8Array, Symbol.species);
      }
      subarray.mockRestore();
      set.mockRestore();
    }

    expect(result!).toEqual(expected);
    expect(subarrayCalls).toBe(0);
    expect(setCalls).toBe(0);
    expect(speciesCalls).toBe(0);
  });

  it('closes an owned source exactly once, supports reentry, and suppresses active reads', async () => {
    const pending = deferred<Uint8Array>();
    const started = deferred<void>();
    let prefixed!: ManifestPrefixedEncodedAudioSource;
    const close = vi.fn(async () => {
      await prefixed.close();
    });
    const manifest = pattern(CODEC_TIMELINE_MANIFEST_HEADER_BYTES);
    prefixed = new ManifestPrefixedEncodedAudioSource({
      manifestBytes: manifest,
      media: encodedSource(new Uint8Array(4), {
        readAt: async () => {
          started.resolve();
          return pending.promise;
        },
        close,
      }),
    });
    const result = prefixed.readAt(manifest.byteLength, 4, new AbortController().signal);
    await started.promise;

    const firstClose = prefixed.close();
    const secondClose = prefixed.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    await expect(result).rejects.toBeInstanceOf(EncodedSourceClosedError);
    expect(close).toHaveBeenCalledOnce();
    pending.resolve(new Uint8Array(4));
    await expect(prefixed.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );
  });

  it('does not claim an owned source when construction fails', () => {
    const close = vi.fn(async () => undefined);
    const owned = encodedSource(Uint8Array.of(1), { close });
    expect(
      () =>
        new ManifestPrefixedEncodedAudioSource({
          manifestBytes: new Uint8Array(1),
          media: owned,
        }),
    ).toThrow();
    expect(close).not.toHaveBeenCalled();
  });
});

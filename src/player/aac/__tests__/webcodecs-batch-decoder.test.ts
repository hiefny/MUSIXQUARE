import { describe, expect, it, vi } from 'vitest';

import {
  AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES,
  AacDecoderBackendClosedError,
  AacDecoderBackendIntegrityError,
  AacDecoderBackendUnavailableError,
  type AacDecoderAccessUnit,
  type AacDecoderBackend,
  type AacDecoderBackendGenerationOptions,
} from '../decoder-backend.ts';
import {
  AAC_WEB_CODECS_MAX_OUTPUT_CALLBACKS_PER_BATCH,
  AAC_WEB_CODECS_TIMESTAMP_TOLERANCE_MICROSECONDS,
  createAacWebCodecsBatchDecoder,
  type AacWebCodecsBatchAudioData,
  type AacWebCodecsBatchAudioDataCopyOptions,
  type AacWebCodecsBatchBindings,
  type AacWebCodecsBatchDecoderConfig,
  type AacWebCodecsBatchDecoderInit,
  type AacWebCodecsBatchEncodedAudioChunkInit,
  type AacWebCodecsBatchNativeDecoder,
} from '../webcodecs-batch-decoder.ts';

interface FrameOptions {
  readonly mpegId?: 0 | 1;
  readonly protectionAbsent?: boolean;
  readonly profile?: 0 | 1 | 2 | 3;
  readonly sampleRateIndex?: number;
  readonly channelConfiguration?: number;
  readonly rawDataBlocks?: 1 | 2 | 3 | 4;
  readonly totalBytes?: number;
  readonly declaredBytes?: number;
}

interface FakeAudioDataOptions {
  readonly frames?: number;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly timestamp?: number;
  readonly allocationBytes?: number;
  readonly values?: readonly (readonly number[])[];
  readonly writtenFrames?: number;
  readonly copyError?: unknown;
  readonly closeError?: unknown;
  readonly onCopy?: (destination: Uint8Array) => void;
  readonly onClose?: () => void;
}

interface FakeAudioDataFixture {
  readonly data: AacWebCodecsBatchAudioData;
  readonly allocationSize: ReturnType<typeof vi.fn>;
  readonly copyTo: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

interface FakeChunk {
  readonly type: 'key';
  readonly timestamp: number;
  readonly copiedBytes: readonly number[];
}

interface Harness {
  readonly bindings: AacWebCodecsBatchBindings;
  readonly isConfigSupported: ReturnType<typeof vi.fn>;
  readonly createDecoder: ReturnType<typeof vi.fn>;
  readonly createEncodedAudioChunk: ReturnType<typeof vi.fn>;
  readonly decoder: AacWebCodecsBatchNativeDecoder & {
    readonly configure: ReturnType<typeof vi.fn>;
    readonly decode: ReturnType<typeof vi.fn>;
    readonly flush: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  };
  readonly chunks: FakeChunk[];
  emit(data: AacWebCodecsBatchAudioData): void;
  fail(error: unknown): void;
}

const STEREO_44K = Object.freeze({
  mpegId: 0 as const,
  profile: 1 as const,
  coreAudioObjectType: 2 as const,
  sampleRateIndex: 4 as const,
  channelConfiguration: 2 as const,
  protectionAbsent: true as const,
  rawDataBlocks: 1 as const,
});
const RAW_STEREO_44K = Object.freeze({
  kind: 'raw' as const,
  description: Object.freeze([0x12, 0x10] as const),
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return Object.freeze({ promise, resolve, reject });
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function makeFrame(options: FrameOptions = {}): Uint8Array {
  const mpegId = options.mpegId ?? 0;
  const protectionAbsent = options.protectionAbsent ?? true;
  const profile = options.profile ?? 1;
  const sampleRateIndex = options.sampleRateIndex ?? 4;
  const channelConfiguration = options.channelConfiguration ?? 2;
  const rawDataBlocks = options.rawDataBlocks ?? 1;
  const headerBytes = protectionAbsent ? 7 : 9;
  const totalBytes = options.totalBytes ?? headerBytes + 5;
  const declaredBytes = options.declaredBytes ?? totalBytes;
  const bytes = new Uint8Array(totalBytes);
  bytes[0] = 0xff;
  bytes[1] = 0xf0 | (mpegId << 3) | (protectionAbsent ? 1 : 0);
  bytes[2] = (profile << 6) | (sampleRateIndex << 2) | ((channelConfiguration >>> 2) & 1);
  bytes[3] = ((channelConfiguration & 0b11) << 6) | ((declaredBytes >>> 11) & 0b11);
  bytes[4] = (declaredBytes >>> 3) & 0xff;
  bytes[5] = ((declaredBytes & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0b1111_1100 | ((rawDataBlocks - 1) & 0b11);
  for (let index = headerBytes; index < bytes.length; index += 1) bytes[index] = index & 0xff;
  return bytes;
}

function accessUnit(accessUnitOrdinal: number, frame = makeFrame()): AacDecoderAccessUnit {
  return { accessUnitOrdinal, bytes: frame };
}

function fakeAudioData(options: FakeAudioDataOptions = {}): FakeAudioDataFixture {
  const frames = options.frames ?? 1_024;
  const channels = options.channels ?? 2;
  const sampleRate = options.sampleRate ?? 44_100;
  const timestamp = options.timestamp ?? 0;
  const allocationSize = vi.fn((_options: AacWebCodecsBatchAudioDataCopyOptions): unknown =>
    options.allocationBytes === undefined ? frames * 4 : options.allocationBytes,
  );
  const copyTo = vi.fn(
    (destination: Uint8Array, copyOptions: AacWebCodecsBatchAudioDataCopyOptions): void => {
      options.onCopy?.(destination);
      if (options.copyError !== undefined) throw options.copyError;
      const output = new Float32Array(
        destination.buffer,
        destination.byteOffset,
        destination.byteLength / 4,
      );
      const values = options.values?.[copyOptions.planeIndex] ?? [copyOptions.planeIndex + 0.25];
      const writtenFrames = Math.min(options.writtenFrames ?? output.length, output.length);
      for (let index = 0; index < writtenFrames; index += 1) {
        output[index] = values[index % values.length] ?? 0;
      }
    },
  );
  const close = vi.fn((): void => {
    options.onClose?.();
    if (options.closeError !== undefined) throw options.closeError;
  });
  return Object.freeze({
    data: {
      numberOfChannels: channels,
      numberOfFrames: frames,
      sampleRate,
      timestamp,
      allocationSize,
      copyTo,
      close,
    },
    allocationSize,
    copyTo,
    close,
  });
}

function createHarness(): Harness {
  let init: AacWebCodecsBatchDecoderInit | null = null;
  const chunks: FakeChunk[] = [];
  const isConfigSupported = vi.fn(
    (_config: AacWebCodecsBatchDecoderConfig): PromiseLike<unknown> =>
      Promise.resolve(Object.freeze({ supported: true })),
  );
  const configure = vi.fn((_config: AacWebCodecsBatchDecoderConfig): void => {});
  const decode = vi.fn((_chunk: unknown): void => {});
  const flush = vi.fn((): PromiseLike<void> => Promise.resolve());
  const close = vi.fn((): void => {});
  const decoder = { configure, decode, flush, close } satisfies AacWebCodecsBatchNativeDecoder;
  const createDecoder = vi.fn(
    (value: AacWebCodecsBatchDecoderInit): AacWebCodecsBatchNativeDecoder => {
      init = value;
      return decoder;
    },
  );
  const createEncodedAudioChunk = vi.fn(
    (value: AacWebCodecsBatchEncodedAudioChunkInit): unknown => {
      const chunk = Object.freeze({
        type: value.type,
        timestamp: value.timestamp,
        copiedBytes: Object.freeze(Array.from(value.data)),
      });
      chunks.push(chunk);
      return chunk;
    },
  );
  const bindings = {
    isConfigSupported,
    createDecoder,
    createEncodedAudioChunk,
  } satisfies AacWebCodecsBatchBindings;

  return {
    bindings,
    isConfigSupported,
    createDecoder,
    createEncodedAudioChunk,
    decoder,
    chunks,
    emit(data: AacWebCodecsBatchAudioData): void {
      if (!init) throw new Error('decoder is not constructed');
      init.output(data);
    },
    fail(error: unknown): void {
      if (!init) throw new Error('decoder is not constructed');
      init.error(error);
    },
  };
}

async function createBackend(
  harness: Harness,
  options: {
    readonly firstAccessUnitOrdinal?: number;
    readonly coreConfiguration?: typeof STEREO_44K;
    readonly framing?: AacDecoderBackendGenerationOptions['framing'];
    readonly signal?: AbortSignal;
  } = {},
): Promise<AacDecoderBackend> {
  return createAacWebCodecsBatchDecoder(
    {
      coreConfiguration: options.coreConfiguration ?? STEREO_44K,
      firstAccessUnitOrdinal: options.firstAccessUnitOrdinal ?? 0,
      framing: options.framing ?? { kind: 'adts' },
    },
    options.signal ?? new AbortController().signal,
    harness.bindings,
  );
}

describe('WebCodecs AAC batch decoder', () => {
  it('uses the exact support/configure shape without an AudioSpecificConfig description', async () => {
    const harness = createHarness();
    const backend = await createBackend(harness);

    expect(backend.id).toBe('webcodecs');
    expect(backend.coreSampleRateHz).toBe(44_100);
    expect(backend.channels).toBe(2);
    const supportConfig = harness.isConfigSupported.mock.calls[0]?.[0];
    const configureConfig = harness.decoder.configure.mock.calls[0]?.[0];
    expect(supportConfig).toEqual({
      codec: 'mp4a.40.2',
      sampleRate: 44_100,
      numberOfChannels: 2,
    });
    expect(Reflect.ownKeys(supportConfig)).toEqual(['codec', 'sampleRate', 'numberOfChannels']);
    expect(Object.hasOwn(supportConfig, 'description')).toBe(false);
    expect(Object.isFrozen(supportConfig)).toBe(true);
    expect(configureConfig).not.toBe(supportConfig);
    expect(configureConfig).toEqual(supportConfig);
    expect(Object.hasOwn(configureConfig, 'description')).toBe(false);
    expect(Object.isFrozen(configureConfig)).toBe(true);
    backend.close();
  });

  it.each([
    [Object.freeze([0x12, 0x10] as const)],
    [Object.freeze([0x12, 0x10, 0x56, 0xe5, 0x00] as const)],
  ])('configures raw AAC with independent canonical ASC bytes %#', async (canonical) => {
    const harness = createHarness();
    const backend = await createBackend(harness, {
      framing: { kind: 'raw', description: canonical },
    });
    const supportConfig = harness.isConfigSupported.mock.calls[0]?.[0];
    const configureConfig = harness.decoder.configure.mock.calls[0]?.[0];

    expect(backend.framing).toEqual({ kind: 'raw', description: canonical });
    expect(supportConfig).not.toBe(configureConfig);
    expect(supportConfig).toMatchObject({
      codec: 'mp4a.40.2',
      sampleRate: 44_100,
      numberOfChannels: 2,
    });
    expect(Array.from(supportConfig?.description ?? [])).toEqual(canonical);
    expect(Array.from(configureConfig?.description ?? [])).toEqual(canonical);
    expect(supportConfig?.description).not.toBe(configureConfig?.description);
    expect(Object.isFrozen(supportConfig)).toBe(true);
    expect(Object.isFrozen(configureConfig)).toBe(true);
    backend.close();
  });

  it.each([1, AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES])(
    'passes an opaque %i-byte raw AU unchanged without attempting ADTS parsing',
    async (byteLength) => {
      const harness = createHarness();
      harness.decoder.decode.mockImplementationOnce(() => harness.emit(fakeAudioData().data));
      const backend = await createBackend(harness, { framing: RAW_STEREO_44K });
      const source = Uint8Array.from({ length: byteLength }, (_unused, index) =>
        index === 0 ? 0xff : index & 0xff,
      );
      const original = Array.from(source);

      const result = await backend.decodeBatch(
        [accessUnit(0, source)],
        new AbortController().signal,
      );

      expect(result.frameCount).toBe(1_024);
      expect(harness.chunks[0]?.copiedBytes).toEqual(original);
      expect(source).toEqual(Uint8Array.from(original));
    },
  );

  it('isolates configure from support-probe mutation of raw description bytes', async () => {
    const harness = createHarness();
    harness.isConfigSupported.mockImplementationOnce((config) => {
      config.description?.fill(0);
      return Promise.resolve(Object.freeze({ supported: true }));
    });

    const backend = await createBackend(harness, { framing: RAW_STEREO_44K });
    const supportConfig = harness.isConfigSupported.mock.calls[0]?.[0];
    const configureConfig = harness.decoder.configure.mock.calls[0]?.[0];

    expect(Array.from(supportConfig?.description ?? [])).toEqual([0, 0]);
    expect(Array.from(configureConfig?.description ?? [])).toEqual([0x12, 0x10]);
    expect(backend.framing).toEqual(RAW_STEREO_44K);
    backend.close();
  });

  it('keeps an ADTS generation on ADTS after public framing replacement attempts', async () => {
    const harness = createHarness();
    const backend = await createBackend(harness);
    const replacement = Object.freeze({
      kind: 'raw' as const,
      description: Object.freeze([0x12, 0x10] as const),
    });

    expect(Reflect.set(backend, 'framing', replacement)).toBe(false);
    expect(Reflect.defineProperty(backend, 'framing', { value: replacement })).toBe(false);
    expect(backend.framing).toEqual({ kind: 'adts' });
    await expect(
      backend.decodeBatch([accessUnit(0, new Uint8Array([0xff]))], new AbortController().signal),
    ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
    expect(harness.decoder.decode).not.toHaveBeenCalled();
  });

  it('keeps a raw generation on raw after public framing replacement attempts', async () => {
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(fakeAudioData().data));
    const backend = await createBackend(harness, { framing: RAW_STEREO_44K });
    const replacement = Object.freeze({ kind: 'adts' as const });

    expect(Reflect.set(backend, 'framing', replacement)).toBe(false);
    expect(Reflect.defineProperty(backend, 'framing', { value: replacement })).toBe(false);
    expect(backend.framing).toEqual(RAW_STEREO_44K);
    await expect(
      backend.decodeBatch([accessUnit(0, new Uint8Array([0xff]))], new AbortController().signal),
    ).resolves.toMatchObject({ frameCount: 1_024 });
    expect(harness.decoder.decode).toHaveBeenCalledOnce();
    backend.close();
  });

  it.each([0, AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES + 1])(
    'rejects and poisons raw AU byte length %i before native decoding',
    async (byteLength) => {
      const harness = createHarness();
      const backend = await createBackend(harness, { framing: RAW_STEREO_44K });

      await expect(
        backend.decodeBatch(
          [accessUnit(0, new Uint8Array(byteLength))],
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
      expect(harness.decoder.decode).not.toHaveBeenCalled();
      expect(harness.decoder.close).toHaveBeenCalledOnce();
      await expect(
        backend.decodeBatch([accessUnit(0, new Uint8Array([1]))], new AbortController().signal),
      ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
    },
  );

  it('decodes one AU into independent canonical planar Float32 storage', async () => {
    const harness = createHarness();
    const audio = fakeAudioData({
      values: [
        [0.125, -0.5],
        [0.75, -0.25],
      ],
    });
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    const backend = await createBackend(harness, { firstAccessUnitOrdinal: 7 });
    const source = makeFrame();
    const original = Array.from(source);

    const result = await backend.decodeBatch([accessUnit(7, source)], new AbortController().signal);

    expect(result).toMatchObject({
      firstAccessUnitOrdinal: 7,
      accessUnitCount: 1,
      frameCount: 1_024,
      sampleRateHz: 44_100,
      channels: 2,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.planes)).toBe(true);
    expect(result.planes[0]).toBeInstanceOf(Float32Array);
    expect(result.planes[0]).toHaveLength(1_024);
    expect(Array.from(result.planes[0].slice(0, 4))).toEqual([0.125, -0.5, 0.125, -0.5]);
    expect(Array.from(result.planes[1]!.slice(0, 4))).toEqual([0.75, -0.25, 0.75, -0.25]);
    expect(audio.allocationSize).toHaveBeenCalledTimes(2);
    expect(audio.copyTo).toHaveBeenCalledTimes(2);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(source).toEqual(Uint8Array.from(original));
    expect(harness.chunks[0]).toMatchObject({ type: 'key', timestamp: 0 });
    expect(harness.chunks[0]?.copiedBytes).toEqual(original);
  });

  it('accepts the maximum eight-AU and encoded-byte batch with combined output', async () => {
    const harness = createHarness();
    const combined = fakeAudioData({ frames: 8 * 1_024 });
    harness.decoder.flush.mockImplementationOnce(() => {
      harness.emit(combined.data);
      return Promise.resolve();
    });
    const backend = await createBackend(harness);
    const batch = Array.from({ length: 8 }, (_, index) =>
      accessUnit(index, makeFrame({ totalBytes: AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES })),
    );

    const result = await backend.decodeBatch(batch, new AbortController().signal);

    expect(result.frameCount).toBe(8_192);
    expect(harness.decoder.decode).toHaveBeenCalledTimes(8);
    expect(harness.chunks).toHaveLength(8);
    expect(harness.chunks[7]?.timestamp).toBe(162_539);
    expect(combined.close).toHaveBeenCalledOnce();
  });

  it('aggregates split callbacks in order without retaining AudioData', async () => {
    const harness = createHarness();
    const first = fakeAudioData({ frames: 512, values: [[1], [2]] });
    const second = fakeAudioData({ frames: 512, values: [[3], [4]] });
    harness.decoder.decode.mockImplementationOnce(() => {
      harness.emit(first.data);
      harness.emit(second.data);
    });
    const backend = await createBackend(harness);

    const result = await backend.decodeBatch([accessUnit(0)], new AbortController().signal);

    expect(result.planes[0][0]).toBe(1);
    expect(result.planes[0][511]).toBe(1);
    expect(result.planes[0][512]).toBe(3);
    expect(result.planes[1]![511]).toBe(2);
    expect(result.planes[1]![512]).toBe(4);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('keeps decoder state across batches and enforces the exact next ordinal', async () => {
    const harness = createHarness();
    harness.decoder.decode.mockImplementation((chunk: FakeChunk) =>
      harness.emit(fakeAudioData({ timestamp: chunk.timestamp }).data),
    );
    const firstOrdinal = Number.MAX_SAFE_INTEGER - 2;
    const backend = await createBackend(harness, { firstAccessUnitOrdinal: firstOrdinal });

    await backend.decodeBatch([accessUnit(firstOrdinal)], new AbortController().signal);
    await backend.decodeBatch([accessUnit(firstOrdinal + 1)], new AbortController().signal);

    expect(harness.createDecoder).toHaveBeenCalledOnce();
    expect(harness.decoder.configure).toHaveBeenCalledOnce();
    expect(harness.decoder.flush).toHaveBeenCalledTimes(2);
    expect(harness.chunks.map((chunk) => chunk.timestamp)).toEqual([0, 23_219]);

    const failure = backend.decodeBatch(
      [accessUnit(firstOrdinal + 1)],
      new AbortController().signal,
    );
    await expect(failure).rejects.toThrow(/contiguous/i);
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['empty', []],
    ['nine AUs', Array.from({ length: 9 }, (_, index) => accessUnit(index))],
    ['short AU', [accessUnit(0, new Uint8Array(7))]],
    ['oversize AU', [accessUnit(0, new Uint8Array(AAC_DECODER_BACKEND_MAX_ACCESS_UNIT_BYTES + 1))]],
    ['sparse array', Object.assign(new Array(1), {})],
    ['non-contiguous ordinal', [accessUnit(1)]],
  ])('rejects and poisons a %s batch before native decoding', async (_label, batch) => {
    const harness = createHarness();
    const backend = await createBackend(harness);
    await expect(
      backend.decodeBatch(batch as AacDecoderAccessUnit[], new AbortController().signal),
    ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
    expect(harness.decoder.decode).not.toHaveBeenCalled();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
    await expect(
      backend.decodeBatch([accessUnit(0)], new AbortController().signal),
    ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
  });

  it('fails closed on revoked, accessor-backed, shared, and detached inputs', async () => {
    const cases: unknown[] = [];
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    cases.push(revoked.proxy);

    const accessorRecord = { accessUnitOrdinal: 0 } as Record<string, unknown>;
    Object.defineProperty(accessorRecord, 'bytes', {
      enumerable: true,
      get: () => makeFrame(),
    });
    cases.push([accessorRecord]);

    const shared = new Uint8Array(new SharedArrayBuffer(makeFrame().byteLength));
    shared.set(makeFrame());
    cases.push([accessUnit(0, shared)]);

    const detached = makeFrame();
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    cases.push([accessUnit(0, detached)]);

    for (const candidate of cases) {
      const harness = createHarness();
      const backend = await createBackend(harness);
      await expect(
        backend.decodeBatch(
          candidate as readonly AacDecoderAccessUnit[],
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
      expect(harness.decoder.decode).not.toHaveBeenCalled();
      expect(harness.decoder.close).toHaveBeenCalledOnce();
    }
  });

  it('rejects extra and symbolic keys on batch and AU records', async () => {
    const symbol = Symbol('hostile-extra');
    const candidates: unknown[] = [];
    const batchExtra = [accessUnit(0)] as Array<AacDecoderAccessUnit> & { extra?: boolean };
    batchExtra.extra = true;
    candidates.push(batchExtra);
    const batchSymbol = [accessUnit(0)] as Array<AacDecoderAccessUnit> & {
      [symbol]?: boolean;
    };
    batchSymbol[symbol] = true;
    candidates.push(batchSymbol);
    candidates.push([{ ...accessUnit(0), extra: true }]);
    candidates.push([
      Object.assign(accessUnit(0), {
        [symbol]: true,
      }),
    ]);

    for (const candidate of candidates) {
      const harness = createHarness();
      const backend = await createBackend(harness);
      await expect(
        backend.decodeBatch(
          candidate as readonly AacDecoderAccessUnit[],
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
      expect(harness.decoder.decode).not.toHaveBeenCalled();
      expect(harness.decoder.close).toHaveBeenCalledOnce();
    }
  });

  it('poisons active validation when a Proxy reenters decodeBatch', async () => {
    const harness = createHarness();
    const backend = await createBackend(harness);
    let nested: Promise<unknown> | null = null;
    const target = [accessUnit(0)];
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(current, key) {
        if (key === 'length' && nested === null) {
          nested = backend.decodeBatch([accessUnit(0)], new AbortController().signal);
        }
        return Reflect.getOwnPropertyDescriptor(current, key);
      },
    });

    const outer = backend.decodeBatch(proxy, new AbortController().signal);

    expect(nested).not.toBeNull();
    await expect(nested!).rejects.toThrow(/overlapping|reentrant/i);
    await expect(outer).rejects.toThrow(/overlapping|reentrant/i);
    expect(harness.decoder.decode).not.toHaveBeenCalled();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['MPEG-2', { mpegId: 1 as const }],
    ['AAC Main', { profile: 0 as const }],
    ['CRC', { protectionAbsent: false }],
    ['two RDBs', { rawDataBlocks: 2 as const }],
    ['sample-rate change', { sampleRateIndex: 3 }],
    ['channel change', { channelConfiguration: 1 }],
    ['declared-length mismatch', { declaredBytes: 13 }],
  ])('rejects and poisons %s ADTS input', async (_label, frameOptions) => {
    const harness = createHarness();
    const backend = await createBackend(harness);
    await expect(
      backend.decodeBatch(
        [accessUnit(0, makeFrame(frameOptions as FrameOptions))],
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
    expect(harness.decoder.decode).not.toHaveBeenCalled();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['short', fakeAudioData({ frames: 1_023 }), AacDecoderBackendIntegrityError],
    ['excess', fakeAudioData({ frames: 1_025 }), AacDecoderBackendIntegrityError],
    ['expanded rate', fakeAudioData({ sampleRate: 88_200 }), AacDecoderBackendIntegrityError],
    ['expanded channels', fakeAudioData({ channels: 1 }), AacDecoderBackendIntegrityError],
    ['bad allocation', fakeAudioData({ allocationBytes: 1 }), AacDecoderBackendIntegrityError],
    [
      'copy error',
      fakeAudioData({ copyError: new Error('copy failed') }),
      AacDecoderBackendUnavailableError,
    ],
    ['no-op copy', fakeAudioData({ writtenFrames: 0 }), AacDecoderBackendIntegrityError],
    ['partial copy', fakeAudioData({ writtenFrames: 512 }), AacDecoderBackendIntegrityError],
    [
      'non-finite PCM',
      fakeAudioData({ values: [[Number.NaN], [0]] }),
      AacDecoderBackendIntegrityError,
    ],
  ])('poisons the generation on %s output', async (_label, audio, ExpectedError) => {
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    const backend = await createBackend(harness);

    await expect(
      backend.decodeBatch([accessUnit(0)], new AbortController().signal),
    ).rejects.toBeInstanceOf(ExpectedError);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
    await expect(
      backend.decodeBatch([accessUnit(1)], new AbortController().signal),
    ).rejects.toBeInstanceOf(ExpectedError);
  });

  it('bounds callback amplification independently of PCM size', async () => {
    const harness = createHarness();
    const outputs = Array.from({ length: AAC_WEB_CODECS_MAX_OUTPUT_CALLBACKS_PER_BATCH + 1 }, () =>
      fakeAudioData({ frames: 1 }),
    );
    harness.decoder.decode.mockImplementationOnce(() => {
      for (const output of outputs) harness.emit(output.data);
    });
    const backend = await createBackend(harness);

    await expect(
      backend.decodeBatch([accessUnit(0)], new AbortController().signal),
    ).rejects.toThrow(/too many/i);
    expect(harness.decoder.close).toHaveBeenCalledOnce();
    expect(outputs.every((output) => output.close.mock.calls.length === 1)).toBe(true);
  });

  it('accepts floor/ceil rational AU timestamps and repeated timestamps for split output', async () => {
    const harness = createHarness();
    const firstHalf = fakeAudioData({ frames: 512, timestamp: 0 });
    const secondHalf = fakeAudioData({ frames: 512, timestamp: 0 });
    harness.decoder.decode
      .mockImplementationOnce(() => {
        harness.emit(firstHalf.data);
        harness.emit(secondHalf.data);
      })
      .mockImplementationOnce(() => harness.emit(fakeAudioData({ timestamp: 23_220 }).data));
    const backend = await createBackend(harness);

    await backend.decodeBatch([accessUnit(0)], new AbortController().signal);
    const second = await backend.decodeBatch([accessUnit(1)], new AbortController().signal);

    expect(second.frameCount).toBe(1_024);
    expect(harness.chunks.map((chunk) => chunk.timestamp)).toEqual([0, 23_219]);
  });

  it('accepts Chromium one-microsecond boundary quantization without admitting two', async () => {
    const core48k = Object.freeze({
      ...STEREO_44K,
      sampleRateIndex: 3,
    });
    const frame48k = (): Uint8Array => makeFrame({ sampleRateIndex: 3 });
    const decodeBoundary = async (boundaryTimestamp: number) => {
      const harness = createHarness();
      harness.decoder.flush
        .mockImplementationOnce(() => {
          harness.emit(fakeAudioData({ frames: 8_192, sampleRate: 48_000, timestamp: 0 }).data);
          return Promise.resolve();
        })
        .mockImplementationOnce(() => {
          harness.emit(fakeAudioData({ sampleRate: 48_000, timestamp: 170_666 }).data);
          harness.emit(fakeAudioData({ sampleRate: 48_000, timestamp: boundaryTimestamp }).data);
          return Promise.resolve();
        });
      const backend = await createBackend(harness, { coreConfiguration: core48k });
      await backend.decodeBatch(
        Array.from({ length: 8 }, (_unused, ordinal) => accessUnit(ordinal, frame48k())),
        new AbortController().signal,
      );
      return backend.decodeBatch(
        [accessUnit(8, frame48k()), accessUnit(9, frame48k())],
        new AbortController().signal,
      );
    };

    await expect(decodeBoundary(191_999)).resolves.toMatchObject({ frameCount: 2_048 });
    await expect(decodeBoundary(192_001)).resolves.toMatchObject({ frameCount: 2_048 });
    await expect(decodeBoundary(191_998)).rejects.toThrow(/stale|reordered/i);
    await expect(decodeBoundary(192_002)).rejects.toThrow(/stale|reordered/i);
    expect(AAC_WEB_CODECS_TIMESTAMP_TOLERANCE_MICROSECONDS).toBe(1);
  });

  it('rejects stale prior-batch and reversed current-batch output timestamps', async () => {
    const staleHarness = createHarness();
    staleHarness.decoder.decode
      .mockImplementationOnce(() => staleHarness.emit(fakeAudioData({ timestamp: 0 }).data))
      .mockImplementationOnce(() => staleHarness.emit(fakeAudioData({ timestamp: 0 }).data));
    const staleBackend = await createBackend(staleHarness);
    await staleBackend.decodeBatch([accessUnit(0)], new AbortController().signal);
    await expect(
      staleBackend.decodeBatch([accessUnit(1)], new AbortController().signal),
    ).rejects.toThrow(/stale|reordered/i);
    expect(staleHarness.decoder.close).toHaveBeenCalledOnce();

    const reversedHarness = createHarness();
    reversedHarness.decoder.flush.mockImplementationOnce(() => {
      reversedHarness.emit(fakeAudioData({ timestamp: 23_219 }).data);
      return Promise.resolve();
    });
    const reversedBackend = await createBackend(reversedHarness);
    await expect(
      reversedBackend.decodeBatch([accessUnit(0), accessUnit(1)], new AbortController().signal),
    ).rejects.toThrow(/stale|reordered/i);
    expect(reversedHarness.decoder.close).toHaveBeenCalledOnce();
  });

  it('rejects support failure before allocating a decoder', async () => {
    const unsupported = createHarness();
    unsupported.isConfigSupported.mockResolvedValueOnce(Object.freeze({ supported: false }));
    await expect(createBackend(unsupported)).rejects.toBeInstanceOf(
      AacDecoderBackendUnavailableError,
    );
    expect(unsupported.createDecoder).not.toHaveBeenCalled();

    const rejected = createHarness();
    rejected.isConfigSupported.mockRejectedValueOnce(new Error('probe failed'));
    await expect(createBackend(rejected)).rejects.toThrow(/probing failed/i);
    expect(rejected.createDecoder).not.toHaveBeenCalled();
  });

  it('returns the exact abort reason from a noncooperative support query', async () => {
    const harness = createHarness();
    harness.isConfigSupported.mockReturnValueOnce(never());
    const controller = new AbortController();
    const reason = Object.freeze({ stage: 'support' });
    const creating = createBackend(harness, { signal: controller.signal });

    controller.abort(reason);

    await expect(creating).rejects.toBe(reason);
    expect(harness.createDecoder).not.toHaveBeenCalled();
  });

  it('rechecks abort before classifying a synchronously fulfilled invalid support result', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const reason = Object.freeze({ stage: 'support-fulfill' });
    harness.isConfigSupported.mockReturnValueOnce({
      then(resolve: (value: unknown) => void): void {
        resolve(null);
        controller.abort(reason);
      },
    } as unknown as PromiseLike<unknown>);

    await expect(createBackend(harness, { signal: controller.signal })).rejects.toBe(reason);
    expect(harness.createDecoder).not.toHaveBeenCalled();
  });

  it('prioritizes aborts triggered by options, bindings, and support-result reflection', async () => {
    const stages = ['options', 'framing', 'bindings', 'support-result'] as const;
    for (const stage of stages) {
      const harness = createHarness();
      const controller = new AbortController();
      const reason = Object.freeze({ stage });
      const baseOptions = {
        coreConfiguration: STEREO_44K,
        firstAccessUnitOrdinal: 0,
        framing: { kind: 'adts' as const },
      };
      let options: typeof baseOptions = baseOptions;
      let bindings: AacWebCodecsBatchBindings = harness.bindings;

      if (stage === 'options') {
        options = new Proxy(baseOptions, {
          ownKeys(target) {
            controller.abort(reason);
            return Reflect.ownKeys(target);
          },
        });
      } else if (stage === 'framing') {
        options = {
          ...baseOptions,
          framing: new Proxy(baseOptions.framing, {
            getOwnPropertyDescriptor(target, key) {
              controller.abort(reason);
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          }),
        };
      } else if (stage === 'bindings') {
        bindings = Object.defineProperties(
          {},
          {
            isConfigSupported: {
              get() {
                controller.abort(reason);
                return harness.isConfigSupported;
              },
            },
            createDecoder: { value: harness.createDecoder },
            createEncodedAudioChunk: { value: harness.createEncodedAudioChunk },
          },
        ) as AacWebCodecsBatchBindings;
      } else {
        harness.isConfigSupported.mockResolvedValueOnce(
          Object.defineProperty({}, 'supported', {
            get() {
              controller.abort(reason);
              return false;
            },
          }),
        );
      }

      await expect(
        createAacWebCodecsBatchDecoder(options, controller.signal, bindings),
      ).rejects.toBe(reason);
      expect(harness.createDecoder).not.toHaveBeenCalled();
    }
  });

  it('returns the exact abort reason and closes once when configure aborts', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const reason = new Error('configure abort');
    harness.decoder.configure.mockImplementationOnce(() => controller.abort(reason));

    await expect(createBackend(harness, { signal: controller.signal })).rejects.toBe(reason);
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('closes exactly once when configure fails or emits output before submission', async () => {
    const configureFailure = createHarness();
    configureFailure.decoder.configure.mockImplementationOnce(() => {
      throw new Error('configure failed');
    });
    await expect(createBackend(configureFailure)).rejects.toThrow(/configuration failed/i);
    expect(configureFailure.decoder.close).toHaveBeenCalledOnce();

    const earlyOutput = createHarness();
    const audio = fakeAudioData();
    earlyOutput.decoder.configure.mockImplementationOnce(() => earlyOutput.emit(audio.data));
    await expect(createBackend(earlyOutput)).rejects.toThrow(/before|outside/i);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(earlyOutput.decoder.close).toHaveBeenCalledOnce();
  });

  it('closes an invalid native decoder candidate exactly once', async () => {
    const harness = createHarness();
    const close = vi.fn();
    harness.createDecoder.mockReturnValueOnce({
      configure: vi.fn(),
      decode: null,
      flush: vi.fn(),
      close,
    });

    await expect(createBackend(harness)).rejects.toThrow(/configuration failed/i);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects output reentered by chunk construction before calling decode', async () => {
    const harness = createHarness();
    const early = fakeAudioData();
    harness.createEncodedAudioChunk.mockImplementationOnce(() => {
      harness.emit(early.data);
      return Object.freeze({});
    });
    const backend = await createBackend(harness);

    await expect(
      backend.decodeBatch([accessUnit(0)], new AbortController().signal),
    ).rejects.toThrow(/before/i);
    expect(early.close).toHaveBeenCalledOnce();
    expect(harness.decoder.decode).not.toHaveBeenCalled();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['chunk construction', 'chunk'],
    ['decode submission', 'decode'],
    ['flush start', 'flush-start'],
    ['flush rejection', 'flush-reject'],
  ])('poisons and closes exactly once on %s failure', async (_label, kind) => {
    const harness = createHarness();
    if (kind === 'chunk') {
      harness.createEncodedAudioChunk.mockImplementationOnce(() => {
        throw new Error('chunk failed');
      });
    } else if (kind === 'decode') {
      harness.decoder.decode.mockImplementationOnce(() => {
        throw new Error('decode failed');
      });
    } else if (kind === 'flush-start') {
      harness.decoder.decode.mockImplementationOnce(() => harness.emit(fakeAudioData().data));
      harness.decoder.flush.mockImplementationOnce(() => {
        throw new Error('flush start failed');
      });
    } else {
      harness.decoder.decode.mockImplementationOnce(() => harness.emit(fakeAudioData().data));
      harness.decoder.flush.mockRejectedValueOnce(new Error('flush rejected'));
    }
    const backend = await createBackend(harness);

    await expect(
      backend.decodeBatch([accessUnit(0)], new AbortController().signal),
    ).rejects.toBeInstanceOf(AacDecoderBackendUnavailableError);
    expect(harness.decoder.close).toHaveBeenCalledOnce();
    backend.close();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('lets an asynchronous error callback break a noncooperative flush', async () => {
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(fakeAudioData().data));
    harness.decoder.flush.mockReturnValueOnce(never());
    const backend = await createBackend(harness);
    const decoding = backend.decodeBatch([accessUnit(0)], new AbortController().signal);

    harness.fail(new Error('native decoder failed'));

    await expect(decoding).rejects.toThrow(/reported an error/i);
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('gives the exact abort reason precedence and breaks a noncooperative flush', async () => {
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(fakeAudioData().data));
    harness.decoder.flush.mockReturnValueOnce(never());
    const backend = await createBackend(harness);
    const controller = new AbortController();
    const reason = Object.freeze({ kind: 'test-abort' });
    const decoding = backend.decodeBatch([accessUnit(0)], controller.signal);

    controller.abort(reason);

    await expect(decoding).rejects.toBe(reason);
    expect(harness.decoder.close).toHaveBeenCalledOnce();
    await expect(backend.decodeBatch([accessUnit(1)], new AbortController().signal)).rejects.toBe(
      reason,
    );
  });

  it('gives a synchronous abort during PCM copy precedence over callback success', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const reason = new Error('copy abort');
    const audio = fakeAudioData({ onCopy: () => controller.abort(reason) });
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    const backend = await createBackend(harness);

    await expect(backend.decodeBatch([accessUnit(0)], controller.signal)).rejects.toBe(reason);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('keeps the original failure when hostile copyTo detaches a destination plane', async () => {
    const harness = createHarness();
    const audio = fakeAudioData({
      onCopy(destination) {
        structuredClone(destination.buffer, { transfer: [destination.buffer] });
      },
    });
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    const backend = await createBackend(harness);

    await expect(
      backend.decodeBatch([accessUnit(0)], new AbortController().signal),
    ).rejects.toBeInstanceOf(AacDecoderBackendUnavailableError);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('detects reentrant output, closes each AudioData once, and never publishes partial PCM', async () => {
    const harness = createHarness();
    const nested = fakeAudioData();
    const outer = fakeAudioData({ onCopy: () => harness.emit(nested.data) });
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(outer.data));
    const backend = await createBackend(harness);

    await expect(
      backend.decodeBatch([accessUnit(0)], new AbortController().signal),
    ).rejects.toThrow(/re-entered/i);
    expect(outer.close).toHaveBeenCalledOnce();
    expect(nested.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('poisons both calls when batches overlap', async () => {
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(fakeAudioData().data));
    harness.decoder.flush.mockReturnValueOnce(never());
    const backend = await createBackend(harness);
    const first = backend.decodeBatch([accessUnit(0)], new AbortController().signal);
    const second = backend.decodeBatch([accessUnit(1)], new AbortController().signal);

    await expect(second).rejects.toThrow(/overlapping|reentrant/i);
    await expect(first).rejects.toThrow(/overlapping|reentrant/i);
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('closes late output without mutating an already returned batch and poisons future work', async () => {
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(fakeAudioData().data));
    const backend = await createBackend(harness);
    const result = await backend.decodeBatch([accessUnit(0)], new AbortController().signal);
    const before = Array.from(result.planes[0]);
    const late = fakeAudioData({ values: [[99], [99]] });

    harness.emit(late.data);

    expect(late.close).toHaveBeenCalledOnce();
    expect(Array.from(result.planes[0])).toEqual(before);
    expect(harness.decoder.close).toHaveBeenCalledOnce();
    await expect(
      backend.decodeBatch([accessUnit(1)], new AbortController().signal),
    ).rejects.toThrow(/outside/i);
  });

  it('treats AudioData close failure as terminal and still attempts native close once', async () => {
    const harness = createHarness();
    const audio = fakeAudioData({ closeError: new Error('close failed') });
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    const backend = await createBackend(harness);

    await expect(
      backend.decodeBatch([accessUnit(0)], new AbortController().signal),
    ).rejects.toThrow(/could not be closed/i);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('makes normal close idempotent and rejects later decoding as closed', async () => {
    const harness = createHarness();
    const backend = await createBackend(harness);

    backend.close();
    backend.close();

    expect(harness.decoder.close).toHaveBeenCalledOnce();
    await expect(
      backend.decodeBatch([accessUnit(0)], new AbortController().signal),
    ).rejects.toBeInstanceOf(AacDecoderBackendClosedError);
  });

  it('makes native close failure best-effort and preserves the original configure error', async () => {
    const normal = createHarness();
    normal.decoder.close.mockImplementationOnce(() => {
      throw new Error('native close failed');
    });
    const backend = await createBackend(normal);
    expect(() => backend.close()).not.toThrow();
    expect(() => backend.close()).not.toThrow();
    expect(normal.decoder.close).toHaveBeenCalledOnce();

    const failed = createHarness();
    failed.decoder.configure.mockImplementationOnce(() => {
      throw new Error('configure root cause');
    });
    failed.decoder.close.mockImplementationOnce(() => {
      throw new Error('cleanup must not replace configure');
    });
    await expect(createBackend(failed)).rejects.toThrow(/configuration failed/i);
    expect(failed.decoder.close).toHaveBeenCalledOnce();
  });

  it('does not let a late flush rejection escape after abort', async () => {
    const harness = createHarness();
    const flush = deferred<void>();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(fakeAudioData().data));
    harness.decoder.flush.mockReturnValueOnce(flush.promise);
    const backend = await createBackend(harness);
    const controller = new AbortController();
    const reason = new Error('stop generation');
    const decoding = backend.decodeBatch([accessUnit(0)], controller.signal);
    controller.abort(reason);

    await expect(decoding).rejects.toBe(reason);
    flush.reject(new Error('late flush rejection'));
    await Promise.resolve();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });
});

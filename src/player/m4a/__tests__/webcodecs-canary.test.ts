import { describe, expect, it, vi } from 'vitest';

import {
  M4aRawAacWebCodecsIntegrityError,
  M4aRawAacWebCodecsUnavailableError,
  probeM4aRawAacWebCodecsAccessUnit,
  type M4aRawAacWebCodecsAudioData,
  type M4aRawAacWebCodecsAudioDataCopyOptions,
  type M4aRawAacWebCodecsBindings,
  type M4aRawAacWebCodecsDecoder,
  type M4aRawAacWebCodecsDecoderConfig,
  type M4aRawAacWebCodecsDecoderInit,
  type M4aRawAacWebCodecsEncodedAudioChunkInit,
} from '../webcodecs-canary.ts';

interface FakeAudioDataOptions {
  readonly timestamp?: number;
  readonly frames?: number;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly closeError?: unknown;
}

interface FakeAudioDataFixture {
  readonly data: M4aRawAacWebCodecsAudioData;
  readonly allocationSize: ReturnType<typeof vi.fn>;
  readonly copyTo: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

interface Harness {
  readonly bindings: M4aRawAacWebCodecsBindings;
  readonly isConfigSupported: ReturnType<typeof vi.fn>;
  readonly createDecoder: ReturnType<typeof vi.fn>;
  readonly createEncodedAudioChunk: ReturnType<typeof vi.fn>;
  readonly decoder: M4aRawAacWebCodecsDecoder & {
    readonly configure: ReturnType<typeof vi.fn>;
    readonly decode: ReturnType<typeof vi.fn>;
    readonly flush: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  };
  readonly supportDescriptionCopies: number[][];
  readonly supportDescriptionViews: Uint8Array[];
  readonly decoderDescriptionCopies: number[][];
  readonly decoderDescriptionViews: Uint8Array[];
  readonly chunkCopies: number[][];
  readonly chunkViews: Uint8Array[];
  emit(data: M4aRawAacWebCodecsAudioData): void;
  fail(error: unknown): void;
}

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

function rawAccessUnit(): Uint8Array {
  // Deliberately not an ADTS frame: no sync word or transport header exists.
  return new Uint8Array([0x21, 0x37, 0x55, 0x89, 0xab, 0xcd]);
}

function stereo44kAsc(): Uint8Array {
  return new Uint8Array([0x12, 0x10]);
}

function fakeAudioData(options: FakeAudioDataOptions = {}): FakeAudioDataFixture {
  const frames = options.frames ?? 1_024;
  const channels = options.channels ?? 2;
  const sampleRate = options.sampleRate ?? 44_100;
  const allocationSize = vi.fn(
    (_copyOptions: M4aRawAacWebCodecsAudioDataCopyOptions): unknown => frames * 4,
  );
  const copyTo = vi.fn(
    (destination: Uint8Array, _copyOptions: M4aRawAacWebCodecsAudioDataCopyOptions): void => {
      const samples = new Float32Array(
        destination.buffer,
        destination.byteOffset,
        destination.byteLength / 4,
      );
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = index % 3 === 0 ? -0.25 : 0.5;
      }
    },
  );
  const close = vi.fn((): void => {
    if (options.closeError !== undefined) throw options.closeError;
  });
  return Object.freeze({
    data: {
      timestamp: options.timestamp ?? 0,
      numberOfChannels: channels,
      numberOfFrames: frames,
      sampleRate,
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
  let init: M4aRawAacWebCodecsDecoderInit | null = null;
  const supportDescriptionCopies: number[][] = [];
  const supportDescriptionViews: Uint8Array[] = [];
  const decoderDescriptionCopies: number[][] = [];
  const decoderDescriptionViews: Uint8Array[] = [];
  const chunkCopies: number[][] = [];
  const chunkViews: Uint8Array[] = [];

  const isConfigSupported = vi.fn(
    (config: M4aRawAacWebCodecsDecoderConfig): PromiseLike<unknown> => {
      supportDescriptionCopies.push(Array.from(config.description));
      supportDescriptionViews.push(config.description);
      return Promise.resolve(Object.freeze({ supported: true, config }));
    },
  );
  const configure = vi.fn((config: M4aRawAacWebCodecsDecoderConfig): void => {
    decoderDescriptionCopies.push(Array.from(config.description));
    decoderDescriptionViews.push(config.description);
  });
  const decode = vi.fn((_chunk: unknown): void => {});
  const flush = vi.fn((): PromiseLike<void> => Promise.resolve());
  const close = vi.fn((): void => {});
  const decoder = { configure, decode, flush, close } satisfies M4aRawAacWebCodecsDecoder;
  const createDecoder = vi.fn((value: M4aRawAacWebCodecsDecoderInit): M4aRawAacWebCodecsDecoder => {
    init = value;
    return decoder;
  });
  const createEncodedAudioChunk = vi.fn(
    (value: M4aRawAacWebCodecsEncodedAudioChunkInit): unknown => {
      chunkCopies.push(Array.from(value.data));
      chunkViews.push(value.data);
      return Object.freeze({ type: value.type, timestamp: value.timestamp });
    },
  );
  const bindings = {
    isConfigSupported,
    createDecoder,
    createEncodedAudioChunk,
  } satisfies M4aRawAacWebCodecsBindings;

  return {
    bindings,
    isConfigSupported,
    createDecoder,
    createEncodedAudioChunk,
    decoder,
    supportDescriptionCopies,
    supportDescriptionViews,
    decoderDescriptionCopies,
    decoderDescriptionViews,
    chunkCopies,
    chunkViews,
    emit(data: M4aRawAacWebCodecsAudioData): void {
      if (!init) throw new Error('decoder is not constructed');
      init.output(data);
    },
    fail(error: unknown): void {
      if (!init) throw new Error('decoder is not constructed');
      init.error(error);
    },
  };
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((value) => value === 0);
}

describe('M4A raw AAC WebCodecs capability canary', () => {
  it('configures exact raw AAC-LC, decodes without ADTS, and returns frozen evidence', async () => {
    const accessUnit = rawAccessUnit();
    const asc = stereo44kAsc();
    const accessUnitBefore = Array.from(accessUnit);
    const ascBefore = Array.from(asc);
    const audio = fakeAudioData();
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));

    const evidence = await probeM4aRawAacWebCodecsAccessUnit(
      accessUnit,
      asc,
      new AbortController().signal,
      harness.bindings,
    );

    expect(evidence).toEqual({
      codec: 'mp4a.40.2',
      framing: 'raw-aac',
      coreSampleRateHz: 44_100,
      coreChannelCount: 2,
      descriptionByteLength: 2,
      decodedCoreFrames: 1_024,
      outputCount: 1,
      timestampPropagationVerified: true,
      f32PlanarCopyVerified: true,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(accessUnit).toEqual(Uint8Array.from(accessUnitBefore));
    expect(asc).toEqual(Uint8Array.from(ascBefore));

    const supportConfig = harness.isConfigSupported.mock.calls[0]?.[0];
    const decoderConfig = harness.decoder.configure.mock.calls[0]?.[0];
    expect(Reflect.ownKeys(supportConfig)).toEqual([
      'codec',
      'sampleRate',
      'numberOfChannels',
      'description',
    ]);
    expect(Object.isFrozen(supportConfig)).toBe(true);
    expect(Object.isFrozen(decoderConfig)).toBe(true);
    expect(supportConfig).not.toBe(decoderConfig);
    expect(supportConfig.description).not.toBe(asc);
    expect(decoderConfig.description).not.toBe(asc);
    expect(supportConfig.description).not.toBe(decoderConfig.description);
    expect(harness.supportDescriptionCopies).toEqual([ascBefore]);
    expect(harness.decoderDescriptionCopies).toEqual([ascBefore]);
    expect(harness.chunkCopies).toEqual([accessUnitBefore]);
    expect(harness.chunkCopies[0]?.slice(0, 2)).not.toEqual([0xff, 0xf1]);
    expect(harness.supportDescriptionViews.every(allZero)).toBe(true);
    expect(harness.decoderDescriptionViews.every(allZero)).toBe(true);
    expect(harness.chunkViews.every(allZero)).toBe(true);

    expect(audio.allocationSize).toHaveBeenCalledTimes(2);
    expect(audio.copyTo).toHaveBeenCalledTimes(2);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('snapshots caller-owned ASC and AU before an asynchronous support query', async () => {
    const support = deferred<unknown>();
    const harness = createHarness();
    harness.isConfigSupported.mockImplementationOnce(
      (config: M4aRawAacWebCodecsDecoderConfig): PromiseLike<unknown> => {
        harness.supportDescriptionCopies.push(Array.from(config.description));
        harness.supportDescriptionViews.push(config.description);
        return support.promise;
      },
    );
    const audio = fakeAudioData();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    const accessUnit = rawAccessUnit();
    const asc = stereo44kAsc();
    const expectedAccessUnit = Array.from(accessUnit);
    const expectedAsc = Array.from(asc);

    const operation = probeM4aRawAacWebCodecsAccessUnit(
      accessUnit,
      asc,
      new AbortController().signal,
      harness.bindings,
    );
    accessUnit.fill(0);
    asc.fill(0);
    support.resolve(Object.freeze({ supported: true }));
    await operation;

    expect(harness.supportDescriptionCopies).toEqual([expectedAsc]);
    expect(harness.decoderDescriptionCopies).toEqual([expectedAsc]);
    expect(harness.chunkCopies).toEqual([expectedAccessUnit]);
    expect(harness.supportDescriptionViews.every(allZero)).toBe(true);
    expect(harness.decoderDescriptionViews.every(allZero)).toBe(true);
    expect(harness.chunkViews.every(allZero)).toBe(true);
  });

  it('classifies a false support result as unsupported without constructing a decoder', async () => {
    const harness = createHarness();
    harness.isConfigSupported.mockResolvedValueOnce(
      Object.freeze({ supported: false, config: Object.freeze({}) }),
    );

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toMatchObject({
      name: 'M4aRawAacWebCodecsUnavailableError',
      stage: 'unsupported',
    });
    expect(harness.createDecoder).not.toHaveBeenCalled();
    expect(harness.supportDescriptionViews.every(allZero)).toBe(true);
  });

  it('classifies a throwing support query separately from cancellation', async () => {
    const failure = new Error('support API failed');
    const harness = createHarness();
    harness.isConfigSupported.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toMatchObject({
      name: 'M4aRawAacWebCodecsUnavailableError',
      stage: 'support-query',
      cause: failure,
    });
    expect(harness.createDecoder).not.toHaveBeenCalled();
  });

  it('rejects getter-backed support evidence instead of executing it', async () => {
    const harness = createHarness();
    const getter = vi.fn(() => true);
    const support = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(support, 'supported', { enumerable: true, get: getter });
    harness.isConfigSupported.mockResolvedValueOnce(support);

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toMatchObject({ stage: 'support-query' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('classifies configure rejection and still closes the constructed decoder', async () => {
    const failure = new DOMException('not supported', 'NotSupportedError');
    const harness = createHarness();
    harness.decoder.configure.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toMatchObject({
      name: 'M4aRawAacWebCodecsUnavailableError',
      stage: 'configuration',
      cause: failure,
    });
    expect(harness.createEncodedAudioChunk).not.toHaveBeenCalled();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
    expect(harness.decoderDescriptionViews.every(allZero)).toBe(true);
  });

  it('surfaces a decoder error callback and closes the decoder', async () => {
    const failure = new Error('native decoder failure');
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.fail(failure));

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toMatchObject({
      name: 'M4aRawAacWebCodecsUnavailableError',
      stage: 'decode',
      cause: failure,
    });
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it.each(['no-op', 'partial'] as const)(
    'rejects a %s f32-planar copy instead of accepting zero-initialized scratch',
    async (mode) => {
      const harness = createHarness();
      const audio = fakeAudioData();
      audio.copyTo.mockImplementation((destination: Uint8Array): void => {
        if (mode === 'partial') {
          new Float32Array(
            destination.buffer,
            destination.byteOffset,
            destination.byteLength / 4,
          )[0] = 0.25;
        }
      });
      harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));

      await expect(
        probeM4aRawAacWebCodecsAccessUnit(
          rawAccessUnit(),
          stereo44kAsc(),
          new AbortController().signal,
          harness.bindings,
        ),
      ).rejects.toBeInstanceOf(M4aRawAacWebCodecsIntegrityError);
      expect(audio.close).toHaveBeenCalledOnce();
      expect(harness.decoder.close).toHaveBeenCalledOnce();
    },
  );

  it('rejects decoded output that does not preserve the submitted timestamp', async () => {
    const harness = createHarness();
    const audio = fakeAudioData({ timestamp: 1 });
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toBeInstanceOf(M4aRawAacWebCodecsIntegrityError);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('does not submit decode after the chunk constructor reports a terminal error', async () => {
    const failure = new Error('chunk construction reentry');
    const harness = createHarness();
    harness.createEncodedAudioChunk.mockImplementationOnce(() => {
      harness.fail(failure);
      return Object.freeze({});
    });

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toMatchObject({ stage: 'decode', cause: failure });
    expect(harness.decoder.decode).not.toHaveBeenCalled();
    expect(harness.decoder.flush).not.toHaveBeenCalled();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('stops before chunk creation after configure reentrantly aborts', async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'configure-reentry' });
    const harness = createHarness();
    harness.decoder.configure.mockImplementationOnce(() => controller.abort(reason));

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        controller.signal,
        harness.bindings,
      ),
    ).rejects.toBe(reason);
    expect(harness.createEncodedAudioChunk).not.toHaveBeenCalled();
    expect(harness.decoder.decode).not.toHaveBeenCalled();
    expect(harness.decoder.flush).not.toHaveBeenCalled();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('stops before configuration after decoder construction reentrantly aborts', async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'decoder-construction-reentry' });
    const harness = createHarness();
    harness.createDecoder.mockImplementationOnce(() => {
      controller.abort(reason);
      return harness.decoder;
    });

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        controller.signal,
        harness.bindings,
      ),
    ).rejects.toBe(reason);
    expect(harness.decoder.configure).not.toHaveBeenCalled();
    expect(harness.createEncodedAudioChunk).not.toHaveBeenCalled();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('does not flush after decode reentrantly aborts', async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'decode-reentry' });
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => controller.abort(reason));

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        controller.signal,
        harness.bindings,
      ),
    ).rejects.toBe(reason);
    expect(harness.decoder.flush).not.toHaveBeenCalled();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('preserves an exact pre-abort reason without touching WebCodecs', async () => {
    const reason = Object.freeze({ phase: 'before-raw-canary' });
    const controller = new AbortController();
    controller.abort(reason);
    const harness = createHarness();

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        controller.signal,
        harness.bindings,
      ),
    ).rejects.toBe(reason);
    expect(harness.isConfigSupported).not.toHaveBeenCalled();
  });

  it('cancels a pending support query with the exact reason and zeroes its copy', async () => {
    const harness = createHarness();
    harness.isConfigSupported.mockReturnValueOnce(deferred<unknown>().promise);
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'during-support-query' });

    const operation = probeM4aRawAacWebCodecsAccessUnit(
      rawAccessUnit(),
      stereo44kAsc(),
      controller.signal,
      harness.bindings,
    );
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(harness.createDecoder).not.toHaveBeenCalled();
    expect(harness.supportDescriptionViews.every(allZero)).toBe(true);
  });

  it('preserves exact abort when a support binding detaches its config copy', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'detached-support-config' });
    harness.isConfigSupported.mockImplementationOnce(
      (config: M4aRawAacWebCodecsDecoderConfig): PromiseLike<unknown> => {
        structuredClone(config.description.buffer, {
          transfer: [config.description.buffer as ArrayBuffer],
        });
        controller.abort(reason);
        return Promise.resolve(Object.freeze({ supported: true }));
      },
    );

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        controller.signal,
        harness.bindings,
      ),
    ).rejects.toBe(reason);
    expect(harness.createDecoder).not.toHaveBeenCalled();
  });

  it('reports detached submitted bytes as cleanup failure and still closes the decoder', async () => {
    const harness = createHarness();
    harness.createEncodedAudioChunk.mockImplementationOnce(
      (init: M4aRawAacWebCodecsEncodedAudioChunkInit): unknown => {
        structuredClone(init.data.buffer, { transfer: [init.data.buffer as ArrayBuffer] });
        return Object.freeze({});
      },
    );

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toMatchObject({
      name: 'M4aRawAacWebCodecsUnavailableError',
      stage: 'cleanup',
    });
    expect(harness.decoder.decode).not.toHaveBeenCalled();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('cancels a pending flush exactly and closes both AudioData and decoder', async () => {
    const flush = deferred<void>();
    const harness = createHarness();
    const audio = fakeAudioData();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    harness.decoder.flush.mockReturnValueOnce(flush.promise);
    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'during-raw-flush' });

    const operation = probeM4aRawAacWebCodecsAccessUnit(
      rawAccessUnit(),
      stereo44kAsc(),
      controller.signal,
      harness.bindings,
    );
    await vi.waitFor(() => expect(harness.decoder.flush).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
    expect(harness.decoderDescriptionViews.every(allZero)).toBe(true);
    expect(harness.chunkViews.every(allZero)).toBe(true);
  });

  it('reports decoder cleanup failure after otherwise successful evidence', async () => {
    const closeFailure = new Error('decoder close failed');
    const harness = createHarness();
    const audio = fakeAudioData();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    harness.decoder.close.mockImplementationOnce(() => {
      throw closeFailure;
    });

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toMatchObject({
      name: 'M4aRawAacWebCodecsUnavailableError',
      stage: 'cleanup',
      cause: closeFailure,
    });
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('rejects noncanonical ASC before consulting WebCodecs', async () => {
    const harness = createHarness();

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        new Uint8Array([0x2a, 0x10]),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toBeInstanceOf(M4aRawAacWebCodecsIntegrityError);
    expect(harness.isConfigSupported).not.toHaveBeenCalled();
  });

  it('uses the unavailable error type for unsupported configurations', async () => {
    const harness = createHarness();
    harness.isConfigSupported.mockResolvedValueOnce(Object.freeze({ supported: false }));

    await expect(
      probeM4aRawAacWebCodecsAccessUnit(
        rawAccessUnit(),
        stereo44kAsc(),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toBeInstanceOf(M4aRawAacWebCodecsUnavailableError);
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  AacWebCodecsIntegrityError,
  AacWebCodecsUnavailableError,
  probeAacWebCodecsAdtsFrame,
  type AacWebCodecsAudioData,
  type AacWebCodecsAudioDataCopyOptions,
  type AacWebCodecsBindings,
  type AacWebCodecsDecoder,
  type AacWebCodecsDecoderConfig,
  type AacWebCodecsDecoderInit,
  type AacWebCodecsEncodedAudioChunkInit,
} from '../webcodecs-canary.ts';

interface FrameOptions {
  readonly mpegId?: 0 | 1;
  readonly protectionAbsent?: boolean;
  readonly profile?: 0 | 1 | 2 | 3;
  readonly sampleRateIndex?: number;
  readonly channelConfiguration?: number;
  readonly rawDataBlocks?: 1 | 2 | 3 | 4;
  readonly payloadBytes?: number;
}

interface FakeAudioDataOptions {
  readonly frames?: number;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly allocationBytes?: number;
  readonly copyError?: unknown;
  readonly closeError?: unknown;
  readonly samples?: readonly number[];
}

interface FakeAudioDataFixture {
  readonly data: AacWebCodecsAudioData;
  readonly allocationSize: ReturnType<typeof vi.fn>;
  readonly copyTo: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

interface Harness {
  readonly bindings: AacWebCodecsBindings;
  readonly isConfigSupported: ReturnType<typeof vi.fn>;
  readonly createDecoder: ReturnType<typeof vi.fn>;
  readonly createEncodedAudioChunk: ReturnType<typeof vi.fn>;
  readonly decoder: AacWebCodecsDecoder & {
    readonly configure: ReturnType<typeof vi.fn>;
    readonly decode: ReturnType<typeof vi.fn>;
    readonly flush: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  };
  readonly chunkBytes: number[][];
  emit(data: AacWebCodecsAudioData): void;
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

function makeFrame(options: FrameOptions = {}): Uint8Array {
  const mpegId = options.mpegId ?? 0;
  const protectionAbsent = options.protectionAbsent ?? true;
  const profile = options.profile ?? 1;
  const sampleRateIndex = options.sampleRateIndex ?? 4;
  const channelConfiguration = options.channelConfiguration ?? 2;
  const rawDataBlocks = options.rawDataBlocks ?? 1;
  const payloadBytes = options.payloadBytes ?? 5;
  const headerBytes = protectionAbsent ? 7 : 9;
  const frameLengthBytes = headerBytes + payloadBytes;
  const bytes = new Uint8Array(frameLengthBytes);
  bytes[0] = 0xff;
  bytes[1] = 0xf0 | (mpegId << 3) | (protectionAbsent ? 1 : 0);
  bytes[2] = (profile << 6) | (sampleRateIndex << 2) | ((channelConfiguration >>> 2) & 1);
  bytes[3] = ((channelConfiguration & 0b11) << 6) | ((frameLengthBytes >>> 11) & 0b11);
  bytes[4] = (frameLengthBytes >>> 3) & 0xff;
  bytes[5] = ((frameLengthBytes & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0b1111_1100 | ((rawDataBlocks - 1) & 0b11);
  for (let index = headerBytes; index < bytes.length; index += 1) bytes[index] = index;
  return bytes;
}

function fakeAudioData(options: FakeAudioDataOptions = {}): FakeAudioDataFixture {
  const frames = options.frames ?? 1_024;
  const channels = options.channels ?? 2;
  const sampleRate = options.sampleRate ?? 44_100;
  const allocationSize = vi.fn((_copyOptions: AacWebCodecsAudioDataCopyOptions): unknown =>
    options.allocationBytes === undefined ? frames * 4 : options.allocationBytes,
  );
  const copyTo = vi.fn(
    (destination: Uint8Array, _copyOptions: AacWebCodecsAudioDataCopyOptions): void => {
      if (options.copyError !== undefined) throw options.copyError;
      if (options.samples) {
        const samples = new Float32Array(
          destination.buffer,
          destination.byteOffset,
          destination.byteLength / 4,
        );
        for (let index = 0; index < samples.length; index += 1) {
          samples[index] = options.samples[index % options.samples.length] ?? 0;
        }
      }
    },
  );
  const close = vi.fn((): void => {
    if (options.closeError !== undefined) throw options.closeError;
  });
  return Object.freeze({
    data: {
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
  let init: AacWebCodecsDecoderInit | null = null;
  const chunkBytes: number[][] = [];
  const isConfigSupported = vi.fn(
    (_config: AacWebCodecsDecoderConfig): PromiseLike<unknown> =>
      Promise.resolve(Object.freeze({ supported: true })),
  );
  const configure = vi.fn((_config: AacWebCodecsDecoderConfig): void => {});
  const decode = vi.fn((_chunk: unknown): void => {});
  const flush = vi.fn((): PromiseLike<void> => Promise.resolve());
  const close = vi.fn((): void => {});
  const decoder = { configure, decode, flush, close } satisfies AacWebCodecsDecoder;
  const createDecoder = vi.fn((value: AacWebCodecsDecoderInit): AacWebCodecsDecoder => {
    init = value;
    return decoder;
  });
  const createEncodedAudioChunk = vi.fn((value: AacWebCodecsEncodedAudioChunkInit): unknown => {
    const copiedBytes = Array.from(value.data);
    chunkBytes.push(copiedBytes);
    return Object.freeze({ type: value.type, timestamp: value.timestamp, copiedBytes });
  });
  const bindings = {
    isConfigSupported,
    createDecoder,
    createEncodedAudioChunk,
  } satisfies AacWebCodecsBindings;

  return {
    bindings,
    isConfigSupported,
    createDecoder,
    createEncodedAudioChunk,
    decoder,
    chunkBytes,
    emit(data: AacWebCodecsAudioData): void {
      if (!init) throw new Error('decoder is not constructed');
      init.output(data);
    },
    fail(error: unknown): void {
      if (!init) throw new Error('decoder is not constructed');
      init.error(error);
    },
  };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('AAC WebCodecs ADTS capability canary', () => {
  it('uses the exact ADTS AAC-LC config and returns frozen scalar evidence', async () => {
    const frame = makeFrame();
    const original = Array.from(frame);
    const audio = fakeAudioData({ samples: [0, 0.25, -0.5] });
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));

    const evidence = await probeAacWebCodecsAdtsFrame(
      frame,
      new AbortController().signal,
      harness.bindings,
    );

    expect(evidence).toEqual({
      codec: 'mp4a.40.2',
      framing: 'adts',
      coreSampleRateHz: 44_100,
      coreChannelCount: 2,
      decodedCoreFrames: 1_024,
      outputCount: 1,
      f32PlanarCopyVerified: true,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(frame).toEqual(Uint8Array.from(original));

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
    expect(configureConfig).toBe(supportConfig);

    const chunkInit = harness.createEncodedAudioChunk.mock.calls[0]?.[0];
    expect(chunkInit.type).toBe('key');
    expect(chunkInit.timestamp).toBe(0);
    expect(Reflect.ownKeys(chunkInit)).toEqual(['type', 'timestamp', 'data']);
    expect(harness.chunkBytes).toEqual([original]);
    expect(Array.from(chunkInit.data)).toEqual(new Array(frame.length).fill(0));
    expect(audio.allocationSize).toHaveBeenCalledTimes(2);
    expect(audio.copyTo).toHaveBeenCalledTimes(2);
    expect(audio.allocationSize.mock.calls.map((call) => call[0])).toEqual([
      { format: 'f32-planar', planeIndex: 0, frameOffset: 0, frameCount: 1_024 },
      { format: 'f32-planar', planeIndex: 1, frameOffset: 0, frameCount: 1_024 },
    ]);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('accepts split output callbacks only when they sum to one AAC-LC core frame', async () => {
    const first = fakeAudioData({ frames: 400 });
    const second = fakeAudioData({ frames: 624 });
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => {
      harness.emit(first.data);
      harness.emit(second.data);
    });

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
    ).resolves.toMatchObject({ outputCount: 2, decodedCoreFrames: 1_024 });
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(first.copyTo).toHaveBeenCalledTimes(2);
    expect(second.copyTo).toHaveBeenCalledTimes(2);
  });

  it('reports an unsupported configuration without constructing a decoder', async () => {
    const harness = createHarness();
    harness.isConfigSupported.mockResolvedValueOnce(Object.freeze({ supported: false }));

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsUnavailableError);
    expect(harness.createDecoder).not.toHaveBeenCalled();
  });

  it('treats a support lie that rejects the verified frame as unavailable', async () => {
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => {
      throw new DOMException('not supported after all', 'NotSupportedError');
    });

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsUnavailableError);
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['2048 decoded frames', { frames: 2_048 }],
    ['a doubled sample rate', { sampleRate: 88_200 }],
  ])('rejects %s before allocating PCM', async (_label, options) => {
    const audio = fakeAudioData(options);
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);
    expect(audio.allocationSize).not.toHaveBeenCalled();
    expect(audio.copyTo).not.toHaveBeenCalled();
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('rejects channel-expanded output before allocating PCM', async () => {
    const audio = fakeAudioData({ channels: 2 });
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));

    await expect(
      probeAacWebCodecsAdtsFrame(
        makeFrame({ channelConfiguration: 1 }),
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);
    expect(audio.allocationSize).not.toHaveBeenCalled();
    expect(audio.close).toHaveBeenCalledOnce();
  });

  it('rejects maliciously oversized output geometry before allocation', async () => {
    const audio = fakeAudioData({ frames: Number.MAX_SAFE_INTEGER });
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);
    expect(audio.allocationSize).not.toHaveBeenCalled();
    expect(audio.close).toHaveBeenCalledOnce();
  });

  it('requires exact allocation geometry and finite copied PCM', async () => {
    const invalidAllocation = fakeAudioData({ allocationBytes: 1_000_000_000 });
    const invalidPcm = fakeAudioData({ samples: [Number.NaN] });

    for (const audio of [invalidAllocation, invalidPcm]) {
      const harness = createHarness();
      harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
      await expect(
        probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
      ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);
      expect(audio.close).toHaveBeenCalledOnce();
      expect(harness.decoder.close).toHaveBeenCalledOnce();
    }
    expect(invalidAllocation.copyTo).not.toHaveBeenCalled();
  });

  it('closes AudioData and the decoder when f32-planar copying fails', async () => {
    const audio = fakeAudioData({ copyError: new Error('copy failed') });
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsUnavailableError);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('preserves a synchronous decoder error without entering flush', async () => {
    const harness = createHarness();
    const decoderFailure = new Error('native decoder failed');
    harness.decoder.decode.mockImplementationOnce(() => harness.fail(decoderFailure));
    harness.decoder.flush.mockReturnValueOnce(never());

    const operation = probeAacWebCodecsAdtsFrame(
      makeFrame(),
      new AbortController().signal,
      harness.bindings,
    );
    await expect(operation).rejects.toMatchObject({
      name: 'AacWebCodecsUnavailableError',
      cause: decoderFailure,
    });
    expect(harness.decoder.flush).not.toHaveBeenCalled();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('lets an asynchronous decoder error escape a noncooperative flush', async () => {
    const harness = createHarness();
    const decoderFailure = new Error('asynchronous native decoder failed');
    harness.decoder.flush.mockReturnValueOnce(never());

    const operation = probeAacWebCodecsAdtsFrame(
      makeFrame(),
      new AbortController().signal,
      harness.bindings,
    );
    await vi.waitFor(() => expect(harness.decoder.flush).toHaveBeenCalledOnce());
    harness.fail(decoderFailure);

    await expect(operation).rejects.toMatchObject({
      name: 'AacWebCodecsUnavailableError',
      cause: decoderFailure,
    });
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('rejects output emitted by the decoder constructor before decode submission', async () => {
    const early = fakeAudioData();
    const harness = createHarness();
    harness.createDecoder.mockImplementationOnce((init: AacWebCodecsDecoderInit) => {
      init.output(early.data);
      return harness.decoder;
    });
    harness.decoder.decode.mockImplementationOnce(() => {
      throw new Error('decode must not establish a false pass');
    });

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);
    expect(early.allocationSize).not.toHaveBeenCalled();
    expect(early.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('rejects output emitted by configure before decode submission', async () => {
    const early = fakeAudioData();
    const harness = createHarness();
    harness.decoder.configure.mockImplementationOnce(() => harness.emit(early.data));

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);
    expect(harness.decoder.decode).not.toHaveBeenCalled();
    expect(early.close).toHaveBeenCalledOnce();
  });

  it('rejects a short total and an excessive output split', async () => {
    const short = createHarness();
    short.decoder.decode.mockImplementationOnce(() =>
      short.emit(fakeAudioData({ frames: 512 }).data),
    );
    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, short.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);

    const fragmented = createHarness();
    const outputs = Array.from({ length: 65 }, () => fakeAudioData({ frames: 1 }));
    fragmented.decoder.decode.mockImplementationOnce(() => {
      for (const audio of outputs) fragmented.emit(audio.data);
    });
    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, fragmented.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);
    for (const audio of outputs) expect(audio.close).toHaveBeenCalledOnce();
  });

  it('closes a duplicated AudioData identity exactly once', async () => {
    const audio = fakeAudioData({ frames: 512 });
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => {
      harness.emit(audio.data);
      harness.emit(audio.data);
    });

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);
    expect(audio.close).toHaveBeenCalledOnce();
  });

  it('fails closed when an AudioData operation re-enters the output callback', async () => {
    const outer = fakeAudioData();
    const nested = fakeAudioData();
    const harness = createHarness();
    outer.allocationSize.mockImplementationOnce(() => {
      harness.emit(nested.data);
      return 4_096;
    });
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(outer.data));

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
    ).rejects.toMatchObject({
      name: 'AacWebCodecsIntegrityError',
      message: expect.stringContaining('re-entered'),
    });
    expect(outer.close).toHaveBeenCalledOnce();
    expect(nested.close).toHaveBeenCalledOnce();
    expect(harness.decoder.flush).not.toHaveBeenCalled();
  });

  it('honors a pre-aborted signal before touching frame bytes or bindings', async () => {
    const controller = new AbortController();
    const reason = new Error('pre-aborted');
    controller.abort(reason);
    const harness = createHarness();

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), controller.signal, harness.bindings),
    ).rejects.toBe(reason);
    expect(harness.isConfigSupported).not.toHaveBeenCalled();
  });

  it('escapes a noncooperative support promise on mid-probe abort', async () => {
    const controller = new AbortController();
    const reason = new Error('support aborted');
    const harness = createHarness();
    harness.isConfigSupported.mockReturnValueOnce(never());

    const operation = probeAacWebCodecsAdtsFrame(makeFrame(), controller.signal, harness.bindings);
    await Promise.resolve();
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(harness.createDecoder).not.toHaveBeenCalled();
  });

  it('escapes a noncooperative flush and closes the decoder on mid-decode abort', async () => {
    const controller = new AbortController();
    const reason = new Error('flush aborted');
    const audio = fakeAudioData();
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    harness.decoder.flush.mockReturnValueOnce(never());

    const operation = probeAacWebCodecsAdtsFrame(makeFrame(), controller.signal, harness.bindings);
    await vi.waitFor(() => expect(harness.decoder.flush).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('is inert when the signal aborts after a successful probe', async () => {
    const controller = new AbortController();
    const audio = fakeAudioData();
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    const evidence = await probeAacWebCodecsAdtsFrame(
      makeFrame(),
      controller.signal,
      harness.bindings,
    );

    controller.abort(new Error('too late'));
    expect(evidence.outputCount).toBe(1);
    expect(audio.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('gives an exact abort reason precedence when cleanup aborts', async () => {
    const audio = fakeAudioData();
    const harness = createHarness();
    const controller = new AbortController();
    const reason = new Error('cleanup aborted');
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    harness.decoder.close.mockImplementationOnce(() => controller.abort(reason));

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), controller.signal, harness.bindings),
    ).rejects.toBe(reason);
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('gives an exact abort reason precedence over a hostile support getter', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const reason = new Error('support inspection aborted');
    harness.isConfigSupported.mockResolvedValueOnce(
      Object.defineProperty({}, 'supported', {
        get(): boolean {
          controller.abort(reason);
          return false;
        },
      }),
    );

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), controller.signal, harness.bindings),
    ).rejects.toBe(reason);
    expect(harness.createDecoder).not.toHaveBeenCalled();
  });

  it('reports decoder cleanup failure when no earlier failure exists', async () => {
    const audio = fakeAudioData();
    const harness = createHarness();
    const closeFailure = new Error('decoder close failed');
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(audio.data));
    harness.decoder.close.mockImplementationOnce(() => {
      throw closeFailure;
    });

    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, harness.bindings),
    ).rejects.toMatchObject({
      name: 'AacWebCodecsUnavailableError',
      cause: closeFailure,
    });
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it('closes late output without reading or mutating completed evidence', async () => {
    const initial = fakeAudioData();
    const late = fakeAudioData({ frames: Number.MAX_SAFE_INTEGER, channels: 999 });
    const harness = createHarness();
    harness.decoder.decode.mockImplementationOnce(() => harness.emit(initial.data));
    const evidence = await probeAacWebCodecsAdtsFrame(
      makeFrame(),
      new AbortController().signal,
      harness.bindings,
    );

    harness.emit(late.data);
    harness.fail(new Error('late decoder error'));
    expect(evidence.outputCount).toBe(1);
    expect(late.allocationSize).not.toHaveBeenCalled();
    expect(late.copyTo).not.toHaveBeenCalled();
    expect(late.close).toHaveBeenCalledOnce();
    expect(harness.decoder.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['MPEG-2', makeFrame({ mpegId: 1 })],
    ['AAC Main', makeFrame({ profile: 0 })],
    ['CRC', makeFrame({ protectionAbsent: false })],
    ['multiple raw data blocks', makeFrame({ rawDataBlocks: 2 })],
    ['multichannel', makeFrame({ channelConfiguration: 6 })],
  ])('rejects scanner-incompatible %s input before probing support', async (_label, frame) => {
    const harness = createHarness();
    await expect(
      probeAacWebCodecsAdtsFrame(frame, new AbortController().signal, harness.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);
    expect(harness.isConfigSupported).not.toHaveBeenCalled();
  });

  it('rejects hostile and shared frame views without probing support', async () => {
    const harness = createHarness();
    const hostile = new Proxy(makeFrame(), {});
    await expect(
      probeAacWebCodecsAdtsFrame(
        hostile as unknown as Uint8Array,
        new AbortController().signal,
        harness.bindings,
      ),
    ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);

    if (typeof SharedArrayBuffer === 'function') {
      const normal = makeFrame();
      const shared = new Uint8Array(new SharedArrayBuffer(normal.byteLength));
      shared.set(normal);
      await expect(
        probeAacWebCodecsAdtsFrame(shared, new AbortController().signal, harness.bindings),
      ).rejects.toBeInstanceOf(AacWebCodecsIntegrityError);
    }
    expect(harness.isConfigSupported).not.toHaveBeenCalled();
  });

  it('closes the decoder once when configure or flush fails', async () => {
    const configureHarness = createHarness();
    configureHarness.decoder.configure.mockImplementationOnce(() => {
      throw new Error('configure failed');
    });
    await expect(
      probeAacWebCodecsAdtsFrame(
        makeFrame(),
        new AbortController().signal,
        configureHarness.bindings,
      ),
    ).rejects.toBeInstanceOf(AacWebCodecsUnavailableError);
    expect(configureHarness.decoder.close).toHaveBeenCalledOnce();

    const flushHarness = createHarness();
    flushHarness.decoder.decode.mockImplementationOnce(() =>
      flushHarness.emit(fakeAudioData().data),
    );
    flushHarness.decoder.flush.mockRejectedValueOnce(new Error('flush failed'));
    await expect(
      probeAacWebCodecsAdtsFrame(makeFrame(), new AbortController().signal, flushHarness.bindings),
    ).rejects.toBeInstanceOf(AacWebCodecsUnavailableError);
    expect(flushHarness.decoder.close).toHaveBeenCalledOnce();
  });
});

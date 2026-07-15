import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flacCrc16, flacCrc8 } from '../../player/flac/frame-scanner.ts';
import {
  FLAC_STREAM_PROTOCOL_VERSION,
  type FlacStreamDescriptor,
} from '../../player/flac/stream-protocol.ts';
import { BlobEncodedAudioSource } from '../../player/sources/blob-encoded-audio-source.ts';
import { EncodedSourcePortBroker } from '../../player/sources/encoded-source-port.ts';

const mocks = vi.hoisted(() => ({
  decoderReadyQueue: [] as Promise<void>[],
  decoderDecodeQueue: [] as Promise<void>[],
  decoderBlockQueue: [] as number[],
  decoderInstances: [] as Array<{ free: ReturnType<typeof vi.fn> }>,
  decoderFreeFailures: 0,
  decoderCalls: 0,
  defaultBlockSize: 4,
  channels: 2,
  sampleRate: 48_000,
  bitDepth: 24,
  lanczosInitializations: 0,
}));

const sourceBrokers: EncodedSourcePortBroker[] = [];

vi.mock('@wasm-audio-decoders/flac', () => ({
  FLACDecoder: class MockFlacDecoder {
    readonly ready = mocks.decoderReadyQueue.shift() ?? Promise.resolve();
    readonly free = vi.fn(() => {
      if (mocks.decoderFreeFailures > 0) {
        mocks.decoderFreeFailures -= 1;
        throw new Error('synthetic decoder free failure');
      }
    });

    constructor() {
      mocks.decoderInstances.push(this);
    }

    async decodeFrames(): Promise<{
      channelData: Float32Array[];
      samplesDecoded: number;
      sampleRate: number;
      bitDepth: number;
      errors: [];
    }> {
      mocks.decoderCalls += 1;
      await (mocks.decoderDecodeQueue.shift() ?? Promise.resolve());
      const samplesDecoded = mocks.decoderBlockQueue.shift() ?? mocks.defaultBlockSize;
      return {
        channelData: Array.from({ length: mocks.channels }, (_, channel) =>
          Float32Array.from({ length: samplesDecoded }, (_, frame) => channel * 100 + frame),
        ),
        samplesDecoded,
        sampleRate: mocks.sampleRate,
        bitDepth: mocks.bitDepth,
        errors: [],
      };
    }
  },
}));

vi.mock('lanczos-resampler/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lanczos-resampler/loader.js')>();
  return {
    ...actual,
    initWithBase64: async () => {
      mocks.lanczosInitializations += 1;
      await actual.initWithBase64();
    },
  };
});

interface FakeWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  emit(type: string): void;
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function encodeCodedNumber(value: number): Uint8Array {
  const number = BigInt(value);
  const length =
    number <= 0x7fn
      ? 1
      : number <= 0x7ffn
        ? 2
        : number <= 0xffffn
          ? 3
          : number <= 0x1f_ffffn
            ? 4
            : number <= 0x3ff_ffffn
              ? 5
              : number <= 0x7fff_ffffn
                ? 6
                : 7;
  const bytes = new Uint8Array(length);
  if (length === 1) {
    bytes[0] = Number(number);
    return bytes;
  }
  let remainder = number;
  for (let index = length - 1; index >= 1; index -= 1) {
    bytes[index] = 0x80 | Number(remainder & 0x3fn);
    remainder >>= 6n;
  }
  const prefixes = [0, 0, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc, 0xfe];
  bytes[0] = (prefixes[length] ?? 0) | Number(remainder);
  return bytes;
}

function bitDepthCode(bitDepth: number): number {
  const code = new Map([
    [8, 1],
    [12, 2],
    [16, 4],
    [20, 5],
    [24, 6],
    [32, 7],
  ]).get(bitDepth);
  if (!code) throw new RangeError('test bit depth is unsupported');
  return code;
}

function nativeFrame(
  absoluteSourceSample: number,
  blockSize: number,
  options: { channels?: number; bitDepth?: number; payloadBytes?: number } = {},
): Uint8Array {
  if (blockSize < 1 || blockSize > 256) throw new RangeError('test block size is unsupported');
  const channels = options.channels ?? mocks.channels;
  const bitDepth = options.bitDepth ?? mocks.bitDepth;
  const headerWithoutCrc = Uint8Array.from([
    0xff,
    0xf9, // native FLAC sync + variable-blocking strategy
    0x60, // block-size code 6, STREAMINFO sample rate
    ((channels - 1) << 4) | (bitDepthCode(bitDepth) << 1),
    ...encodeCodedNumber(absoluteSourceSample),
    blockSize - 1,
  ]);
  const header = concatenate(headerWithoutCrc, Uint8Array.of(flacCrc8(headerWithoutCrc)));
  const payload = new Uint8Array(options.payloadBytes ?? 3).fill(0x35);
  const withoutFooter = concatenate(header, payload);
  const crc = flacCrc16(withoutFooter);
  return concatenate(withoutFooter, Uint8Array.of(crc >>> 8, crc & 0xff));
}

function streamDescriptor(patch: Partial<FlacStreamDescriptor> = {}): FlacStreamDescriptor {
  return {
    sourceSampleRate: mocks.sampleRate,
    outputSampleRate: mocks.sampleRate,
    channels: mocks.channels,
    bitDepth: mocks.bitDepth,
    totalSourceSamples: mocks.defaultBlockSize,
    firstAudioFrameOffset: 8,
    targetSourceSample: 0,
    decodeAnchorByteOffset: 8,
    decodeAnchorSourceSample: 0,
    minBlockSize: 16,
    maxBlockSize: 16,
    minFrameSize: 0,
    maxFrameSize: 1_024,
    ...patch,
  };
}

function sourceBlob(frames: readonly Uint8Array[], prefixBytes = 8): Blob {
  return new Blob([new Uint8Array(prefixBytes), ...frames]);
}

function openSourceFixture(
  scope: FakeWorkerScope,
  blob: Blob,
  identity: string,
): EncodedSourcePortBroker {
  const source = new BlobEncodedAudioSource(blob, {
    identity,
    metadata: { name: 'fixture.flac', mime: 'audio/flac' },
  });
  const sourceChannel = new MessageChannel();
  const broker = new EncodedSourcePortBroker({
    source,
    port: sourceChannel.port1,
    generation: 1,
  });
  sourceBrokers.push(broker);
  dispatch(scope, {
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'open-source',
    sourceLifetimeGeneration: 1,
    sourceSize: source.size,
    sourceIdentity: source.identity,
    sourcePort: sourceChannel.port2,
  });
  return broker;
}

function dispatchDecoderInit(
  scope: FakeWorkerScope,
  generation: number,
  pcmPort: MessagePort,
  descriptor: FlacStreamDescriptor,
): void {
  dispatch(scope, {
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'init-decoder',
    sourceLifetimeGeneration: 1,
    decoderGeneration: generation,
    descriptor,
    pcmPort,
  });
}

function dispatchInit(
  scope: FakeWorkerScope,
  generation: number,
  pcmPort: MessagePort,
  descriptor = streamDescriptor(),
  blob = sourceBlob([nativeFrame(0, descriptor.totalSourceSamples)]),
): EncodedSourcePortBroker {
  const broker = openSourceFixture(scope, blob, `worker-test-source:${generation}`);
  dispatchDecoderInit(scope, generation, pcmPort, descriptor);
  return broker;
}

function dispatch(scope: FakeWorkerScope, data: unknown): void {
  scope.onmessage?.({ data } as MessageEvent<unknown>);
}

async function loadWorker(): Promise<FakeWorkerScope> {
  const listeners = new Map<string, EventListener>();
  const scope: FakeWorkerScope = {
    onmessage: null,
    postMessage: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') listeners.set(type, listener);
    }),
    emit(type: string) {
      listeners.get(type)?.(new Event(type));
    },
  };
  vi.stubGlobal('self', scope);
  vi.resetModules();
  await import('../flac-stream.worker.ts');
  return scope;
}

function demand(generation: number, maxFrames = 32_768): Record<string, unknown> {
  return {
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'need',
    generation,
    maxFrames,
  };
}

function nextPortMessage(port: MessagePort): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    port.onmessage = (event: MessageEvent<Record<string, unknown>>) => resolve(event.data);
    port.start();
  });
}

describe.sequential('bounded FLAC stream worker', () => {
  beforeEach(() => {
    mocks.decoderReadyQueue.length = 0;
    mocks.decoderDecodeQueue.length = 0;
    mocks.decoderBlockQueue.length = 0;
    mocks.decoderInstances.length = 0;
    mocks.decoderFreeFailures = 0;
    mocks.decoderCalls = 0;
    mocks.defaultBlockSize = 4;
    mocks.channels = 2;
    mocks.sampleRate = 48_000;
    mocks.bitDepth = 24;
    mocks.lanczosInitializations = 0;
    sourceBrokers.length = 0;
  });

  afterEach(async () => {
    await Promise.all(sourceBrokers.map((broker) => broker.close()));
    sourceBrokers.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses exact direct PCM, absolute counters, verified index points, and no Lanczos init', async () => {
    const scope = await loadWorker();
    const channel = new MessageChannel();
    const received = nextPortMessage(channel.port2);
    dispatchInit(scope, 1, channel.port1);
    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 1 }),
      );
    });
    channel.port2.postMessage(demand(1));

    const pcm = await received;
    expect(pcm).toMatchObject({ type: 'pcm', generation: 1, frames: 4, final: true });
    const buffers = pcm.channels as ArrayBuffer[];
    expect(Array.from(new Float32Array(buffers[0]))).toEqual([0, 1, 2, 3]);
    expect(mocks.lanczosInitializations).toBe(0);
    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'frame-index-point',
          decoderGeneration: 1,
          sourceSample: 0,
          byteOffset: 8,
        }),
      );
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'decoder-eof',
          decoderGeneration: 1,
          decodedInputBytes: 8 + nativeFrame(0, 4).byteLength,
          decodedSourceSamples: 4,
          producedOutputFrames: 4,
        }),
      );
      expect(mocks.decoderInstances[0]?.free).toHaveBeenCalledOnce();
    });
    channel.port2.close();
  });

  it('starts at a verified absolute anchor and discards only to the target sample', async () => {
    mocks.defaultBlockSize = 16;
    mocks.decoderBlockQueue.push(16);
    const first = nativeFrame(0, 16);
    const second = nativeFrame(16, 16);
    const descriptor = streamDescriptor({
      totalSourceSamples: 32,
      targetSourceSample: 18,
      decodeAnchorSourceSample: 16,
      decodeAnchorByteOffset: 8 + first.byteLength,
      maxBlockSize: 16,
    });
    const scope = await loadWorker();
    const channel = new MessageChannel();
    const received = nextPortMessage(channel.port2);
    dispatchInit(scope, 3, channel.port1, descriptor, sourceBlob([first, second]));
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 3 }),
      ),
    );
    channel.port2.postMessage(demand(3));

    const pcm = await received;
    expect(pcm).toMatchObject({ type: 'pcm', frames: 14, final: true });
    expect(Array.from(new Float32Array((pcm.channels as ArrayBuffer[])[0]))).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 2),
    );
    expect(mocks.decoderCalls).toBe(1);
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'frame-index-point', sourceSample: 16 }),
    );
    channel.port2.close();
  });

  it('falls back to the origin when an unverified seek-table anchor is invalid', async () => {
    const frame = nativeFrame(0, 4);
    const descriptor = streamDescriptor({
      targetSourceSample: 2,
      decodeAnchorSourceSample: 1,
      decodeAnchorByteOffset: 9,
    });
    const scope = await loadWorker();
    const channel = new MessageChannel();
    const received = nextPortMessage(channel.port2);
    dispatchInit(scope, 4, channel.port1, descriptor, sourceBlob([frame]));
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 4 }),
      ),
    );
    channel.port2.postMessage(demand(4));

    const pcm = await received;
    expect(pcm).toMatchObject({ type: 'pcm', frames: 2, final: true });
    expect(Array.from(new Float32Array((pcm.channels as ArrayBuffer[])[0]))).toEqual([2, 3]);
    expect(scope.postMessage).toHaveBeenCalledWith({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decode-anchor-rejected',
      sourceLifetimeGeneration: 1,
      decoderGeneration: 4,
      sourceSample: 1,
      byteOffset: 9,
    });
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'frame-index-point', sourceSample: 0, byteOffset: 8 }),
    );
    expect(scope.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-error', decoderGeneration: 4 }),
    );
    channel.port2.close();
  });

  it('keeps at most one PCM demand in flight while a frame decode is pending', async () => {
    let releaseDecode: (() => void) | undefined;
    mocks.decoderDecodeQueue.push(new Promise<void>((resolve) => (releaseDecode = resolve)));
    const scope = await loadWorker();
    const channel = new MessageChannel();
    const supplies: Record<string, unknown>[] = [];
    channel.port2.onmessage = (event: MessageEvent<Record<string, unknown>>) =>
      supplies.push(event.data);
    channel.port2.start();
    dispatchInit(scope, 5, channel.port1);
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 5 }),
      ),
    );
    channel.port2.postMessage(demand(5));
    channel.port2.postMessage(demand(5));

    await vi.waitFor(() => expect(mocks.decoderCalls).toBe(1));
    releaseDecode?.();
    await vi.waitFor(() => expect(supplies).toHaveLength(1));
    expect(supplies[0]).toMatchObject({ type: 'pcm', generation: 5, final: true });
    expect(mocks.decoderCalls).toBe(1);
    channel.port2.close();
  });

  it('defers global messageerror cleanup until an in-flight WASM decode settles', async () => {
    let releaseDecode: (() => void) | undefined;
    mocks.decoderDecodeQueue.push(new Promise<void>((resolve) => (releaseDecode = resolve)));
    const scope = await loadWorker();
    const channel = new MessageChannel();
    channel.port2.start();
    dispatchInit(scope, 6, channel.port1);
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 6 }),
      ),
    );
    channel.port2.postMessage(demand(6));
    await vi.waitFor(() => expect(mocks.decoderCalls).toBe(1));

    scope.emit('messageerror');
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-error', decoderGeneration: 6 }),
    );
    expect(mocks.decoderInstances[0]?.free).not.toHaveBeenCalled();

    releaseDecode?.();
    await vi.waitFor(() => expect(mocks.decoderInstances[0]?.free).toHaveBeenCalledOnce());
    channel.port2.close();
  });

  it('does not let stale or same-generation duplicate init stop the active decoder', async () => {
    const scope = await loadWorker();
    const current = new MessageChannel();
    dispatchInit(scope, 20, current.port1);
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 20 }),
      ),
    );

    for (const generation of [19, 20]) {
      const duplicate = new MessageChannel();
      dispatch(scope, {
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'init-decoder',
        sourceLifetimeGeneration: 1,
        decoderGeneration: generation,
        descriptor: streamDescriptor(),
        pcmPort: duplicate.port1,
      });
      duplicate.port2.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scope.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-stopped', decoderGeneration: 20 }),
    );
    expect(scope.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-error', decoderGeneration: 20 }),
    );

    dispatch(scope, {
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'stop-decoder',
      sourceLifetimeGeneration: 1,
      decoderGeneration: 20,
    });
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-stopped', decoderGeneration: 20 }),
      ),
    );
    current.port2.close();
  });

  it('keeps one source-port client across decoder generations and closes it once', async () => {
    const scope = await loadWorker();
    const { EncodedSourcePortClient: WorkerSourcePortClient } =
      await import('../../player/sources/encoded-source-port.ts');
    const beginGeneration = vi.spyOn(WorkerSourcePortClient.prototype, 'beginDecoderGeneration');
    const descriptor = streamDescriptor();
    const broker = openSourceFixture(
      scope,
      sourceBlob([nativeFrame(0, descriptor.totalSourceSamples)]),
      'worker-test-source:lifetime',
    );
    const first = new MessageChannel();
    dispatchDecoderInit(scope, 60, first.port1, descriptor);
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 60 }),
      ),
    );
    dispatch(scope, {
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'stop-decoder',
      sourceLifetimeGeneration: 1,
      decoderGeneration: 60,
    });

    const second = new MessageChannel();
    dispatchDecoderInit(scope, 61, second.port1, descriptor);
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 61 }),
      ),
    );
    expect(beginGeneration).toHaveBeenCalledTimes(1);
    expect(
      scope.postMessage.mock.calls.filter(
        ([message]) => (message as Record<string, unknown>).type === 'source-opened',
      ),
    ).toHaveLength(1);
    expect(broker.closed).toBe(false);

    dispatch(scope, {
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'close-source',
      sourceLifetimeGeneration: 1,
    });
    await vi.waitFor(() => expect(broker.closed).toBe(true));
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'source-closed', sourceLifetimeGeneration: 1 }),
      ),
    );
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-retired', decoderGeneration: 61 }),
    );
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'worker-retired', sourceLifetimeGeneration: 1 }),
    );
    first.port2.close();
    second.port2.close();
    beginGeneration.mockRestore();
  });

  it('cancels during decoder initialization without publishing stale readiness', async () => {
    let releaseReady: (() => void) | undefined;
    mocks.decoderReadyQueue.push(new Promise<void>((resolve) => (releaseReady = resolve)));
    const scope = await loadWorker();
    const channel = new MessageChannel();
    dispatchInit(scope, 30, channel.port1);
    await vi.waitFor(() => expect(mocks.decoderInstances).toHaveLength(1));
    dispatch(scope, {
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'stop-decoder',
      sourceLifetimeGeneration: 1,
      decoderGeneration: 30,
    });
    releaseReady?.();
    await vi.waitFor(() => expect(mocks.decoderInstances[0]?.free).toHaveBeenCalledOnce());
    expect(scope.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 30 }),
    );
    expect(scope.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-error', decoderGeneration: 30 }),
    );
    channel.port2.close();
  });

  it('closes remaining resources but suppresses retirement ACKs when decoder free throws', async () => {
    const scope = await loadWorker();
    const channel = new MessageChannel();
    const broker = dispatchInit(scope, 70, channel.port1);
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 70 }),
      ),
    );
    mocks.decoderFreeFailures = 1;

    dispatch(scope, {
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'close-source',
      sourceLifetimeGeneration: 1,
    });
    await vi.waitFor(() => expect(broker.closed).toBe(true));
    await vi.waitFor(() => expect(mocks.decoderInstances[0]?.free).toHaveBeenCalledOnce());

    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'source-closed', sourceLifetimeGeneration: 1 }),
    );
    expect(scope.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-retired', decoderGeneration: 70 }),
    );
    expect(scope.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'worker-retired', sourceLifetimeGeneration: 1 }),
    );
    channel.port2.close();
  });

  it('publishes source retirement before a hostile PCM close reenters close-source', async () => {
    const scope = await loadWorker();
    const channel = new MessageChannel();
    const broker = openSourceFixture(
      scope,
      sourceBlob([nativeFrame(0, mocks.defaultBlockSize)]),
      'worker-hostile-close-source',
    );
    let reentries = 0;
    const nativeClose = channel.port1.close.bind(channel.port1);
    const portClose = vi.spyOn(channel.port1, 'close').mockImplementation(() => {
      if (reentries === 0) {
        reentries += 1;
        dispatch(scope, {
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'close-source',
          sourceLifetimeGeneration: 1,
        });
      }
      nativeClose();
    });
    dispatchDecoderInit(scope, 71, channel.port1, streamDescriptor());
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 71 }),
      ),
    );

    dispatch(scope, {
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'close-source',
      sourceLifetimeGeneration: 1,
    });

    await vi.waitFor(() => expect(broker.closed).toBe(true));
    await vi.waitFor(() => {
      const messages = scope.postMessage.mock.calls.map(
        ([message]) => message as Record<string, unknown>,
      );
      expect(messages.filter((message) => message.type === 'decoder-retired')).toHaveLength(1);
      expect(messages.filter((message) => message.type === 'source-closed')).toHaveLength(1);
      expect(messages.filter((message) => message.type === 'worker-retired')).toHaveLength(1);
    });
    expect(reentries).toBe(1);
    expect(portClose).toHaveBeenCalledOnce();
    channel.port2.close();
  });

  it('uses real Lanczos carry across decoded frames and publishes the exact pinned count', async () => {
    mocks.sampleRate = 352_800;
    mocks.defaultBlockSize = 16;
    mocks.decoderBlockQueue.push(16, 16);
    const first = nativeFrame(0, 16);
    const second = nativeFrame(16, 16);
    const descriptor = streamDescriptor({
      sourceSampleRate: 352_800,
      outputSampleRate: 48_000,
      totalSourceSamples: 32,
      targetSourceSample: 10,
      maxBlockSize: 16,
    });
    const scope = await loadWorker();
    const channel = new MessageChannel();
    const received = nextPortMessage(channel.port2);
    dispatchInit(scope, 40, channel.port1, descriptor, sourceBlob([first, second]));
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 40 }),
      ),
    );
    expect(mocks.lanczosInitializations).toBe(1);
    channel.port2.postMessage(demand(40));

    const pcm = await received;
    expect(pcm).toMatchObject({ type: 'pcm', frames: 2, final: true });
    expect(mocks.decoderCalls).toBe(2);
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-eof', producedOutputFrames: 2 }),
    );
    channel.port2.close();
  });

  it('keeps a fixed scratch guard across non-zero extreme-ratio Lanczos phases', async () => {
    mocks.sampleRate = 352_800;
    mocks.defaultBlockSize = 256;
    mocks.decoderBlockQueue.push(256, 256, 256, 256);
    const frames = Array.from({ length: 4 }, (_, index) => nativeFrame(index * 256, 256));
    const descriptor = streamDescriptor({
      sourceSampleRate: 352_800,
      outputSampleRate: 48_000,
      totalSourceSamples: 1_024,
      maxBlockSize: 256,
    });
    const scope = await loadWorker();
    const channel = new MessageChannel();
    const received = nextPortMessage(channel.port2);
    dispatchInit(scope, 45, channel.port1, descriptor, sourceBlob(frames));
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 45 }),
      ),
    );
    channel.port2.postMessage(demand(45));

    const pcm = await received;
    expect(pcm).toMatchObject({ type: 'pcm', frames: 139, final: true });
    expect(mocks.decoderCalls).toBe(4);
    expect(scope.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-error', decoderGeneration: 45 }),
    );
    channel.port2.close();
  });

  it('zero-pads and trims a real Lanczos EOF tail without a one-frame stall', async () => {
    mocks.sampleRate = 8_000;
    mocks.defaultBlockSize = 1;
    mocks.decoderBlockQueue.push(1);
    const frame = nativeFrame(0, 1);
    const descriptor = streamDescriptor({
      sourceSampleRate: 8_000,
      outputSampleRate: 48_000,
      totalSourceSamples: 1,
      maxBlockSize: 16,
    });
    const scope = await loadWorker();
    const channel = new MessageChannel();
    const received = nextPortMessage(channel.port2);
    dispatchInit(scope, 50, channel.port1, descriptor, sourceBlob([frame]));
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 50 }),
      ),
    );
    channel.port2.postMessage(demand(50));

    const pcm = await received;
    expect(pcm).toMatchObject({ type: 'pcm', frames: 6, final: true });
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-eof', producedOutputFrames: 6 }),
    );
    channel.port2.close();
  });
});

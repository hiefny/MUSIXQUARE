import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MP3_DECODER_PROTOCOL_VERSION,
  type Mp3DecoderDescriptor,
} from '../../player/mp3/decoder-protocol.ts';
import { parseMpegLayer3FrameHeader } from '../../player/mp3/frame-header.ts';
import {
  EncodedSourceBusyError,
  type EncodedAudioSource,
  throwIfAborted,
  validateExactRead,
} from '../../player/sources/encoded-audio-source.ts';
import { EncodedSourcePortBroker } from '../../player/sources/encoded-source-port.ts';
import { PCM_STREAM_PROTOCOL_VERSION } from '../../player/streaming/pcm-stream-protocol.ts';

const mocks = vi.hoisted(() => ({
  decodedFrames: [] as Uint8Array[],
  decoderInstances: 0,
}));

vi.mock('mpg123-decoder', () => ({
  MPEGDecoder: class MockMpegDecoder {
    readonly ready = Promise.resolve();

    constructor(options: { readonly enableGapless: boolean }) {
      if (options.enableGapless !== false) throw new Error('gapless runtime mode must stay off');
      mocks.decoderInstances += 1;
    }

    decodeFrame(frame: Uint8Array) {
      const copy = frame.slice();
      mocks.decodedFrames.push(copy);
      const header = parseMpegLayer3FrameHeader(copy.subarray(0, 4));
      const ordinal = copy.at(-1) ?? 0;
      const left = Float32Array.from(
        { length: header.samplesPerFrame },
        (_, index) => ordinal + index / 10_000,
      );
      const right = Float32Array.from(
        { length: header.samplesPerFrame },
        (_, index) => ordinal + 10 + index / 10_000,
      );
      return {
        channelData: [left, right],
        samplesDecoded: header.samplesPerFrame,
        sampleRate: header.sampleRateHz,
        errors: [],
      };
    }
  },
}));

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

class MemoryEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly size: number;
  readonly metadata = Object.freeze({ name: 'fixture.mp3', mime: 'audio/mpeg' });
  readonly reads: ReadRecord[] = [];
  closeCount = 0;
  abortCount = 0;
  busyReads = 0;
  blockReads = false;

  constructor(
    readonly bytes: Uint8Array,
    readonly identity = 'mp3-worker-test-source',
  ) {
    this.size = bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push({ offset, length });
    if (this.busyReads > 0) {
      this.busyReads -= 1;
      throw new EncodedSourceBusyError();
    }
    if (this.blockReads) {
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => {
          this.abortCount += 1;
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    throwIfAborted(signal);
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

interface FakeWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  emit(type: string): void;
}

interface Fixture {
  readonly descriptor: Mp3DecoderDescriptor;
  readonly bytes: Uint8Array;
  readonly frameBytes: number;
  readonly firstAudioFrameOffset: number;
  readonly audioEndByteOffset: number;
}

const sourceBrokers: EncodedSourcePortBroker[] = [];
const openPorts: MessagePort[] = [];
const MPEG_1_SAMPLES_PER_FRAME = 1_152;

function mpegFrame(ordinal: number, mainDataBeginBytes = 0): Uint8Array {
  const headerBytes = Uint8Array.of(0xff, 0xfb, 0x90, 0x00);
  const header = parseMpegLayer3FrameHeader(headerBytes);
  const frame = new Uint8Array(header.frameLengthBytes).fill(0x35);
  frame.set(headerBytes);
  frame[4] = mainDataBeginBytes >>> 1;
  frame[5] = (mainDataBeginBytes & 1) << 7;
  frame[frame.length - 1] = ordinal & 0xff;
  return frame;
}

function fixture(options: {
  readonly frameCount: number;
  readonly mediaFrame?: number;
  readonly headTrimSamples?: number;
  readonly tailTrimSamples?: number;
  readonly targetFrameOrdinal?: number;
  readonly scanAnchorFrameOrdinal?: number;
  readonly minimumWarmupFrames?: number;
  readonly historyFrameLimit?: number;
  readonly mainDataBegin?: Readonly<Record<number, number>>;
  readonly outputSampleRate?: number;
}): Fixture {
  const firstAudioFrameOffset = 8;
  const suffixBytes = 6;
  const frames = Array.from({ length: options.frameCount }, (_, ordinal) =>
    mpegFrame(ordinal, options.mainDataBegin?.[ordinal] ?? 0),
  );
  const frameBytes = frames[0]?.byteLength ?? 0;
  const audioEndByteOffset = firstAudioFrameOffset + frameBytes * options.frameCount;
  const bytes = new Uint8Array(audioEndByteOffset + suffixBytes).fill(0x7e);
  let offset = firstAudioFrameOffset;
  for (const frame of frames) {
    bytes.set(frame, offset);
    offset += frame.byteLength;
  }

  const headTrimSamples = options.headTrimSamples ?? 0;
  const tailTrimSamples = options.tailTrimSamples ?? 0;
  const totalRawSamples = options.frameCount * MPEG_1_SAMPLES_PER_FRAME;
  const rawEofSampleExclusive = totalRawSamples - tailTrimSamples;
  const totalMediaFrames = rawEofSampleExclusive - headTrimSamples;
  const mediaFrame = options.mediaFrame ?? 0;
  const rawSample = headTrimSamples + mediaFrame;
  const targetFrameOrdinal =
    options.targetFrameOrdinal ?? Math.floor(rawSample / MPEG_1_SAMPLES_PER_FRAME);
  const scanAnchorFrameOrdinal = options.scanAnchorFrameOrdinal ?? 0;
  const minimumWarmupFrames = options.minimumWarmupFrames ?? targetFrameOrdinal;
  const historyFrameLimit = options.historyFrameLimit ?? targetFrameOrdinal;

  return {
    bytes,
    frameBytes,
    firstAudioFrameOffset,
    audioEndByteOffset,
    descriptor: {
      format: 'mp3',
      sourceSize: bytes.byteLength,
      sourceIdentity: 'mp3-worker-test-source',
      version: '1',
      sourceSampleRate: 44_100,
      outputSampleRate: options.outputSampleRate ?? 44_100,
      channels: 2,
      samplesPerFrame: MPEG_1_SAMPLES_PER_FRAME,
      firstAudioFrameOffset,
      audioEndByteOffset,
      audioFrameCount: options.frameCount,
      timeline: {
        totalRawSamples,
        samplesPerFrame: MPEG_1_SAMPLES_PER_FRAME,
        headTrimSamples,
        tailTrimSamples,
        rawEofSampleExclusive,
        totalMediaFrames,
      },
      startPlan: {
        mediaFrame,
        rawSample,
        audioFrameOrdinal: targetFrameOrdinal,
        sampleWithinAudioFrame: rawSample - targetFrameOrdinal * MPEG_1_SAMPLES_PER_FRAME,
        scanAnchorByteOffset: firstAudioFrameOffset + scanAnchorFrameOrdinal * frameBytes,
        scanAnchorFrameOrdinal,
        minimumWarmupFrames,
        historyFrameLimit,
      },
    },
  };
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
  await import('../mp3-stream.worker.ts');
  return scope;
}

function openDecoder(
  scope: FakeWorkerScope,
  source: MemoryEncodedAudioSource,
  descriptor: Mp3DecoderDescriptor,
  decoderGeneration = 1,
  configureWorkerPcmPort?: (port: MessagePort) => void,
): MessagePort {
  const sourceChannel = new MessageChannel();
  const pcmChannel = new MessageChannel();
  openPorts.push(sourceChannel.port1, sourceChannel.port2, pcmChannel.port1, pcmChannel.port2);
  const broker = new EncodedSourcePortBroker({
    source,
    port: sourceChannel.port1,
    generation: 1,
  });
  sourceBrokers.push(broker);
  configureWorkerPcmPort?.(pcmChannel.port1);
  dispatch(scope, {
    protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
    type: 'open-decoder',
    sourceLifetimeGeneration: 1,
    decoderGeneration,
    descriptor,
    sourcePort: sourceChannel.port2,
    pcmPort: pcmChannel.port1,
  });
  pcmChannel.port2.start();
  return pcmChannel.port2;
}

function demand(generation: number, maxFrames = 32_768): Record<string, unknown> {
  return {
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'need',
    generation,
    maxFrames,
  };
}

function nextPortMessage(port: MessagePort): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent<Record<string, unknown>>): void => {
      port.removeEventListener('message', listener);
      resolve(event.data);
    };
    port.addEventListener('message', listener);
    port.start();
  });
}

async function requestPcm(
  port: MessagePort,
  generation: number,
  maxFrames: number,
): Promise<Record<string, unknown>> {
  const response = nextPortMessage(port);
  port.postMessage(demand(generation, maxFrames));
  return response;
}

async function waitReady(scope: FakeWorkerScope, generation = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-ready', decoderGeneration: generation }),
    );
  });
}

function stop(scope: FakeWorkerScope, decoderGeneration = 1): void {
  dispatch(scope, {
    protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
    type: 'stop-decoder',
    sourceLifetimeGeneration: 1,
    decoderGeneration,
  });
}

function controlMessages(scope: FakeWorkerScope, type: string): Record<string, unknown>[] {
  return scope.postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === type);
}

describe.sequential('bounded MP3 stream worker', () => {
  beforeEach(() => {
    mocks.decodedFrames.length = 0;
    mocks.decoderInstances = 0;
    sourceBrokers.length = 0;
    openPorts.length = 0;
  });

  afterEach(async () => {
    await Promise.all(sourceBrokers.map((broker) => broker.close()));
    sourceBrokers.length = 0;
    for (const port of openPorts) closePort(port);
    openPorts.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rereads exact audio frames, clips head and tail, and supplies bounded PCM', async () => {
    const media = fixture({
      frameCount: 5,
      headTrimSamples: 100,
      tailTrimSamples: 200,
      mediaFrame: 1_152,
      targetFrameOrdinal: 1,
      minimumWarmupFrames: 1,
      historyFrameLimit: 1,
    });
    const source = new MemoryEncodedAudioSource(media.bytes);
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, source, media.descriptor);
    await waitReady(scope);

    const collected: Record<string, unknown>[] = [];
    while (true) {
      const message = await requestPcm(pcmPort, 1, 700);
      collected.push(message);
      if (message.type === 'pcm' && message.final === true) break;
    }

    expect(collected.every((message) => message.type === 'pcm')).toBe(true);
    expect(collected.every((message) => (message.frames as number) <= 700)).toBe(true);
    expect(collected.reduce((sum, message) => sum + (message.frames as number), 0)).toBe(4_308);
    const firstChannels = collected[0]?.channels as ArrayBuffer[];
    const lastChannels = collected.at(-1)?.channels as ArrayBuffer[];
    expect(new Float32Array(firstChannels[0] ?? new ArrayBuffer(0))[0]).toBeCloseTo(1.01, 5);
    expect(new Float32Array(lastChannels[0] ?? new ArrayBuffer(0)).at(-1)).toBeCloseTo(4.0951, 5);

    expect(mocks.decoderInstances).toBe(1);
    expect(mocks.decodedFrames).toHaveLength(5);
    expect(mocks.decodedFrames.map((frame) => frame.at(-1))).toEqual([0, 1, 2, 3, 4]);
    expect(mocks.decodedFrames.every((frame) => frame[0] === 0xff && frame[1] === 0xfb)).toBe(true);
    expect(source.reads.length).toBeGreaterThanOrEqual(2);
    expect(source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
    expect(source.reads.every((read) => read.offset >= media.firstAudioFrameOffset)).toBe(true);

    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'decoder-eof',
          decodedInputBytes: media.audioEndByteOffset,
          decodedRawSamples: 5 * MPEG_1_SAMPLES_PER_FRAME,
          producedOutputFrames: 4_308,
        }),
      );
    });
  });

  it('resolves a rolling reservoir prelude then rereads from the selected frame', async () => {
    const media = fixture({
      frameCount: 7,
      mediaFrame: 5 * MPEG_1_SAMPLES_PER_FRAME,
      targetFrameOrdinal: 5,
      scanAnchorFrameOrdinal: 1,
      minimumWarmupFrames: 1,
      historyFrameLimit: 4,
      mainDataBegin: { 4: 500 },
    });
    const source = new MemoryEncodedAudioSource(media.bytes);
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, source, media.descriptor);
    await waitReady(scope);

    let supplied = 0;
    while (true) {
      const message = await requestPcm(pcmPort, 1, 512);
      expect(message.type).toBe('pcm');
      supplied += message.frames as number;
      if (message.final === true) break;
    }

    expect(supplied).toBe(2 * MPEG_1_SAMPLES_PER_FRAME);
    expect(mocks.decodedFrames.map((frame) => frame.at(-1))).toEqual([2, 3, 4, 5, 6]);
    expect(source.reads.map((read) => read.offset)).toContain(
      media.firstAudioFrameOffset + media.frameBytes,
    );
    expect(source.reads.map((read) => read.offset)).toContain(
      media.firstAudioFrameOffset + 2 * media.frameBytes,
    );
    const indexEvents = scope.postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.type === 'frame-index-point');
    expect(indexEvents.length).toBeGreaterThan(0);
    expect(indexEvents.every((event) => !Object.hasOwn(event, 'bytes'))).toBe(true);
  });

  it('consumes multi-frame gapless tail padding before reporting physical EOF', async () => {
    const media = fixture({
      frameCount: 6,
      tailTrimSamples: 2 * MPEG_1_SAMPLES_PER_FRAME + 200,
    });
    const source = new MemoryEncodedAudioSource(media.bytes);
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, source, media.descriptor);
    await waitReady(scope);

    let supplied = 0;
    while (true) {
      const message = await requestPcm(pcmPort, 1, 700);
      if (message.type === 'pcm') supplied += message.frames as number;
      if (message.type === 'pcm' && message.final === true) break;
      if (message.type === 'eof') break;
    }

    expect(supplied).toBe(4_408);
    expect(mocks.decodedFrames.map((frame) => frame.at(-1))).toEqual([0, 1, 2, 3, 4, 5]);
    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'decoder-eof',
          decodedInputBytes: media.audioEndByteOffset,
          decodedRawSamples: 6 * MPEG_1_SAMPLES_PER_FRAME,
          producedOutputFrames: 4_408,
        }),
      );
    });

    expect(() =>
      dispatch(scope, {
        protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
        type: 'stop-decoder',
        sourceLifetimeGeneration: 1,
        decoderGeneration: 1,
      }),
    ).not.toThrow();
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-stopped', decoderGeneration: 1 }),
    );
  });

  it('retries only transient source busy results within the exact read bound', async () => {
    const media = fixture({ frameCount: 2 });
    const source = new MemoryEncodedAudioSource(media.bytes);
    source.busyReads = 1;
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, source, media.descriptor);
    await waitReady(scope);

    expect(source.reads).toHaveLength(2);
    expect(source.reads[0]).toEqual(source.reads[1]);
    expect(source.reads[0]?.length).toBeLessThanOrEqual(64 * 1_024);
    const message = await requestPcm(pcmPort, 1, 32_768);
    expect(message).toMatchObject({ type: 'pcm', frames: 1_152, final: false });
  });

  it('fails closed on a non-canonical PCM demand', async () => {
    const media = fixture({ frameCount: 2 });
    const source = new MemoryEncodedAudioSource(media.bytes);
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, source, media.descriptor);
    await waitReady(scope);

    const response = nextPortMessage(pcmPort);
    pcmPort.postMessage({ ...demand(1), extra: true });
    await expect(response).resolves.toMatchObject({
      type: 'source-error',
      generation: 1,
      code: 'invalid-pcm-demand',
    });
    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-error', code: 'invalid-pcm-demand' }),
      );
    });
  });

  it('finishes cleanup but suppresses retirement ACKs when decoder-error delivery throws', async () => {
    const media = fixture({ frameCount: 2 });
    const source = new MemoryEncodedAudioSource(media.bytes);
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, source, media.descriptor, 6);
    await waitReady(scope, 6);
    scope.postMessage.mockImplementation((message: Record<string, unknown>) => {
      if (message.type === 'decoder-error') {
        throw new Error('terminal control delivery failed');
      }
    });

    const response = nextPortMessage(pcmPort);
    pcmPort.postMessage({ ...demand(6), extra: true });
    await expect(response).resolves.toMatchObject({
      type: 'source-error',
      generation: 6,
      code: 'invalid-pcm-demand',
    });
    await vi.waitFor(() => expect(source.closeCount).toBe(1));

    expect(() => stop(scope, 6)).not.toThrow();
    await Promise.resolve();
    expect(controlMessages(scope, 'decoder-stopped')).toHaveLength(1);
    expect(controlMessages(scope, 'decoder-retired')).toHaveLength(0);
    expect(controlMessages(scope, 'worker-retired')).toHaveLength(0);
    expect(source.closeCount).toBe(1);
  });

  it('aborts an in-flight scan and acknowledges the exact stop generation', async () => {
    const media = fixture({ frameCount: 2 });
    const source = new MemoryEncodedAudioSource(media.bytes);
    source.blockReads = true;
    const scope = await loadWorker();
    openDecoder(scope, source, media.descriptor, 7);
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));

    dispatch(scope, {
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'stop-decoder',
      sourceLifetimeGeneration: 1,
      decoderGeneration: 7,
    });

    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-stopped', decoderGeneration: 7 }),
      );
      expect(source.abortCount).toBe(1);
    });
    expect(mocks.decoderInstances).toBe(0);
  });

  it('publishes one terminal barrier before a hostile PCM-port close reenters stop', async () => {
    const media = fixture({ frameCount: 2 });
    const source = new MemoryEncodedAudioSource(media.bytes);
    const scope = await loadWorker();
    let reentries = 0;
    openDecoder(scope, source, media.descriptor, 8, (workerPort) => {
      const nativeClose = workerPort.close.bind(workerPort);
      vi.spyOn(workerPort, 'close').mockImplementation(() => {
        if (reentries === 0) {
          reentries += 1;
          try {
            stop(scope, 8);
          } finally {
            nativeClose();
          }
          return;
        }
        nativeClose();
      });
    });
    await waitReady(scope, 8);

    expect(() => stop(scope, 8)).not.toThrow();
    await vi.waitFor(() => expect(source.closeCount).toBe(1));

    expect(reentries).toBe(1);
    expect(controlMessages(scope, 'decoder-stopped')).toHaveLength(1);
    expect(controlMessages(scope, 'decoder-retired')).toHaveLength(0);
    expect(controlMessages(scope, 'worker-retired')).toHaveLength(0);
  });
});

function closePort(port: MessagePort): void {
  try {
    port.close();
  } catch {
    // Test cleanup is deliberately idempotent.
  }
}

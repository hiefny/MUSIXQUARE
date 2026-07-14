import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncodedAudioSource } from '../../player/sources/encoded-audio-source.ts';
import { throwIfAborted, validateExactRead } from '../../player/sources/encoded-audio-source.ts';
import { EncodedSourcePortBroker } from '../../player/sources/encoded-source-port.ts';
import { PCM_STREAM_PROTOCOL_VERSION } from '../../player/streaming/pcm-stream-protocol.ts';
import {
  LINEAR_PCM_DECODER_PROTOCOL_VERSION,
  type LinearPcmDecoderDescriptor,
} from '../../player/linear-pcm/decoder-protocol.ts';

const mocks = vi.hoisted(() => ({
  lanczosInitializations: 0,
  resamplerInstances: 0,
  resamplerFrees: 0,
}));

vi.mock('lanczos-resampler/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lanczos-resampler/loader.js')>();
  class TrackingChunkedResampler {
    readonly inner: InstanceType<typeof actual.ChunkedResampler>;
    freed = false;

    constructor(inputSampleRate: number, outputSampleRate: number) {
      mocks.resamplerInstances += 1;
      this.inner = new actual.ChunkedResampler(inputSampleRate, outputSampleRate);
    }

    maxNumOutputFrames(inputFrames: number): number {
      return this.inner.maxNumOutputFrames(inputFrames);
    }

    resample(input: Float32Array, output: Float32Array) {
      return this.inner.resample(input, output);
    }

    free(): void {
      if (this.freed) return;
      this.freed = true;
      mocks.resamplerFrees += 1;
      this.inner.free();
    }
  }
  return {
    ...actual,
    ChunkedResampler: TrackingChunkedResampler,
    initWithBase64: async () => {
      mocks.lanczosInitializations += 1;
      await actual.initWithBase64();
    },
  };
});

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

class MemoryEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly size: number;
  readonly identity: string;
  readonly metadata = Object.freeze({ name: 'fixture.wav', mime: 'audio/wav' });
  readonly reads: ReadRecord[] = [];
  closeCount = 0;
  abortCount = 0;
  blockReads = false;

  constructor(
    readonly bytes: Uint8Array,
    identity = 'linear-pcm-worker-test-source',
  ) {
    this.size = bytes.byteLength;
    this.identity = identity;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push({ offset, length });
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

class SparseGeneratedEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'peer-range' as const;
  readonly identity = 'linear-pcm-worker-sparse-5-gib';
  readonly metadata = Object.freeze({ name: 'sparse.wav', mime: 'audio/wav' });
  readonly reads: ReadRecord[] = [];
  closeCount = 0;

  constructor(readonly size: number) {
    validateExactRead(size, 0, 0);
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push({ offset, length });
    return new Uint8Array(length).fill(144);
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

const sourceBrokers: EncodedSourcePortBroker[] = [];
const openPorts: MessagePort[] = [];

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
  await import('../linear-pcm-stream.worker.ts');
  return scope;
}

function descriptor(options: {
  readonly frames: number;
  readonly channels?: number;
  readonly dataOffset?: number;
  readonly sourceSampleRate?: number;
  readonly outputSampleRate?: number;
  readonly targetSourceFrame?: number;
}): LinearPcmDecoderDescriptor {
  const channels = options.channels ?? 2;
  const dataOffset = options.dataOffset ?? 8;
  const sourceSampleRate = options.sourceSampleRate ?? 48_000;
  return {
    format: 'linear-pcm',
    sourceSampleRate,
    outputSampleRate: options.outputSampleRate ?? sourceSampleRate,
    channels,
    encoding: 'pcm-u8',
    containerBitsPerSample: 8,
    validBitsPerSample: 8,
    blockAlign: channels,
    dataOffset,
    dataBytes: options.frames * channels,
    logicalFileBytes: dataOffset + options.frames * channels,
    totalSourceFrames: options.frames,
    targetSourceFrame: options.targetSourceFrame ?? 0,
  };
}

function sourceBytes(
  descriptorValue: LinearPcmDecoderDescriptor,
  sample: (frame: number, channel: number) => number = (frame, channel) =>
    128 + ((frame + channel * 17) % 96),
): Uint8Array {
  const bytes = new Uint8Array(descriptorValue.logicalFileBytes).fill(0x57);
  for (let frame = 0; frame < descriptorValue.totalSourceFrames; frame += 1) {
    for (let channel = 0; channel < descriptorValue.channels; channel += 1) {
      bytes[descriptorValue.dataOffset + frame * descriptorValue.blockAlign + channel] = sample(
        frame,
        channel,
      );
    }
  }
  return bytes;
}

function openSource(scope: FakeWorkerScope, source: EncodedAudioSource): EncodedSourcePortBroker {
  const channel = new MessageChannel();
  openPorts.push(channel.port1, channel.port2);
  const broker = new EncodedSourcePortBroker({
    source,
    port: channel.port1,
    generation: 1,
  });
  sourceBrokers.push(broker);
  dispatch(scope, {
    protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
    type: 'open-source',
    sourceLifetimeGeneration: 1,
    sourceSize: source.size,
    sourceIdentity: source.identity,
    sourcePort: channel.port2,
  });
  return broker;
}

function initialize(
  scope: FakeWorkerScope,
  generation: number,
  descriptorValue: LinearPcmDecoderDescriptor,
): MessagePort {
  const channel = new MessageChannel();
  openPorts.push(channel.port1, channel.port2);
  dispatch(scope, {
    protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
    type: 'init-decoder',
    sourceLifetimeGeneration: 1,
    decoderGeneration: generation,
    descriptor: descriptorValue,
    pcmPort: channel.port1,
  });
  return channel.port2;
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
    port.onmessage = (event: MessageEvent<Record<string, unknown>>) => resolve(event.data);
    port.start();
  });
}

async function waitReady(scope: FakeWorkerScope, generation: number): Promise<void> {
  await vi.waitFor(() => {
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-ready', decoderGeneration: generation }),
    );
  });
}

describe.sequential('bounded linear PCM stream worker', () => {
  beforeEach(() => {
    mocks.lanczosInitializations = 0;
    mocks.resamplerInstances = 0;
    mocks.resamplerFrees = 0;
    sourceBrokers.length = 0;
    openPorts.length = 0;
  });

  afterEach(async () => {
    await Promise.all(sourceBrokers.map((broker) => broker.close()));
    sourceBrokers.length = 0;
    for (const port of openPorts) port.close();
    openPorts.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('deinterleaves exact direct PCM without initializing Lanczos', async () => {
    const layout = descriptor({ frames: 4 });
    const source = new MemoryEncodedAudioSource(
      sourceBytes(layout, (frame, channel) => 128 + frame * 8 + channel * 32),
    );
    const scope = await loadWorker();
    openSource(scope, source);
    const pcmPort = initialize(scope, 1, layout);
    await waitReady(scope, 1);

    const received = nextPortMessage(pcmPort);
    pcmPort.postMessage(demand(1));
    const pcm = await received;

    expect(pcm).toMatchObject({ type: 'pcm', generation: 1, frames: 4, final: true });
    const channels = pcm.channels as ArrayBuffer[];
    expect(channels).toHaveLength(2);
    expect(Array.from(new Float32Array(channels[0]))).toEqual([0, 0.0625, 0.125, 0.1875]);
    expect(Array.from(new Float32Array(channels[1]))).toEqual([0.25, 0.3125, 0.375, 0.4375]);
    expect(channels[0]).not.toBe(channels[1]);
    expect(mocks.lanczosInitializations).toBe(0);
    expect(mocks.resamplerInstances).toBe(0);
    expect(source.reads).toEqual([{ offset: 8, length: 8 }]);
    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'decoder-eof',
          decoderGeneration: 1,
          decodedInputBytes: 8,
          decodedSourceFrames: 4,
          producedOutputFrames: 4,
        }),
      );
    });
  });

  it('decodes container-neutral big-endian PCM through the shared worker lane', async () => {
    const layout: LinearPcmDecoderDescriptor = {
      format: 'linear-pcm',
      sourceSampleRate: 48_000,
      outputSampleRate: 48_000,
      channels: 2,
      encoding: 'pcm-s16be',
      containerBitsPerSample: 16,
      validBitsPerSample: 16,
      blockAlign: 4,
      dataOffset: 8,
      dataBytes: 8,
      logicalFileBytes: 16,
      totalSourceFrames: 2,
      targetSourceFrame: 0,
    };
    const bytes = new Uint8Array(layout.logicalFileBytes);
    const view = new DataView(bytes.buffer);
    view.setInt16(8, -32_768, false);
    view.setInt16(10, 32_767, false);
    view.setInt16(12, 16_384, false);
    view.setInt16(14, -16_384, false);
    const source = new MemoryEncodedAudioSource(bytes);
    const scope = await loadWorker();
    openSource(scope, source);
    const pcmPort = initialize(scope, 10, layout);
    await waitReady(scope, 10);

    const received = nextPortMessage(pcmPort);
    pcmPort.postMessage(demand(10));
    const pcm = await received;

    expect(pcm).toMatchObject({ type: 'pcm', generation: 10, frames: 2, final: true });
    const channels = pcm.channels as ArrayBuffer[];
    expect(Array.from(new Float32Array(channels[0]))).toEqual([-1, 0.5]);
    expect(Array.from(new Float32Array(channels[1]))).toEqual([32_767 / 32_768, -0.5]);
    expect(source.reads).toEqual([{ offset: 8, length: 8 }]);
    expect(mocks.lanczosInitializations).toBe(0);
  });

  it('seeks to a PCM frame with one O(1) byte-offset read', async () => {
    const layout = descriptor({ frames: 5, targetSourceFrame: 3, dataOffset: 13 });
    const source = new MemoryEncodedAudioSource(
      sourceBytes(layout, (frame, channel) => 128 + frame * 4 + channel * 16),
    );
    const scope = await loadWorker();
    openSource(scope, source);
    const pcmPort = initialize(scope, 7, layout);
    await waitReady(scope, 7);

    const received = nextPortMessage(pcmPort);
    pcmPort.postMessage(demand(7));
    const pcm = await received;

    expect(pcm).toMatchObject({ type: 'pcm', frames: 2, final: true });
    expect(source.reads).toEqual([{ offset: 13 + 3 * 2, length: 2 * 2 }]);
    expect(Array.from(new Float32Array((pcm.channels as ArrayBuffer[])[0]))).toEqual([
      0.09375, 0.125,
    ]);
  });

  it('seeks and reaches EOF in a sparse 5 GiB PCM source with one bounded terminal read', async () => {
    const gib = 1_024 * 1_024 * 1_024;
    const sourceSize = 5 * gib;
    const dataOffset = 128;
    const channels = 2;
    const frames = (sourceSize - dataOffset) / channels;
    const layout = descriptor({
      frames,
      channels,
      dataOffset,
      targetSourceFrame: frames - 2,
    });
    expect(layout.logicalFileBytes).toBe(sourceSize);
    const source = new SparseGeneratedEncodedAudioSource(sourceSize);
    const scope = await loadWorker();
    openSource(scope, source);
    const pcmPort = initialize(scope, 11, layout);
    await waitReady(scope, 11);

    const received = nextPortMessage(pcmPort);
    pcmPort.postMessage(demand(11));
    const pcm = await received;

    expect(pcm).toMatchObject({ type: 'pcm', generation: 11, frames: 2, final: true });
    expect(source.reads).toEqual([{ offset: sourceSize - 4, length: 4 }]);
    expect(source.reads[0]!.offset).toBeGreaterThan(4 * gib);
    const buffers = pcm.channels as ArrayBuffer[];
    expect(buffers).toHaveLength(channels);
    expect(buffers.reduce((total, buffer) => total + buffer.byteLength, 0)).toBe(16);
    expect(Array.from(new Float32Array(buffers[0]))).toEqual([0.125, 0.125]);
    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'decoder-eof',
          decoderGeneration: 11,
          decodedInputBytes: 4,
          decodedSourceFrames: 2,
          producedOutputFrames: 2,
        }),
      );
    });

    const terminalPort = initialize(scope, 12, { ...layout, targetSourceFrame: frames });
    await waitReady(scope, 12);
    const terminalReceived = nextPortMessage(terminalPort);
    terminalPort.postMessage(demand(12));
    await expect(terminalReceived).resolves.toEqual({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'eof',
      generation: 12,
    });
    expect(source.reads).toEqual([{ offset: sourceSize - 4, length: 4 }]);
  });

  it('keeps every physical read and PCM supply within their independent ceilings', async () => {
    const layout = descriptor({ frames: 70_000, channels: 1 });
    const source = new MemoryEncodedAudioSource(sourceBytes(layout));
    const scope = await loadWorker();
    openSource(scope, source);
    const pcmPort = initialize(scope, 2, layout);
    await waitReady(scope, 2);

    for (const expectedFrames of [32_768, 32_768, 4_464]) {
      const received = nextPortMessage(pcmPort);
      pcmPort.postMessage(demand(2, 99_999));
      const pcm = await received;
      expect(pcm).toMatchObject({ type: 'pcm', frames: expectedFrames });
      expect((pcm.channels as ArrayBuffer[])[0]?.byteLength).toBe(expectedFrames * 4);
    }
    expect(source.reads.map((read) => read.length)).toEqual([32_768, 32_768, 4_464]);
    expect(source.reads.every((read) => read.length <= 64 * 1_024)).toBe(true);
  });

  it('uses bounded Lanczos output and frees every channel resampler at exact EOF', async () => {
    const layout = descriptor({
      frames: 8,
      channels: 2,
      sourceSampleRate: 96_000,
      outputSampleRate: 48_000,
    });
    const source = new MemoryEncodedAudioSource(sourceBytes(layout));
    const scope = await loadWorker();
    openSource(scope, source);
    const pcmPort = initialize(scope, 3, layout);
    await waitReady(scope, 3);
    expect(mocks.lanczosInitializations).toBe(1);

    const received = nextPortMessage(pcmPort);
    pcmPort.postMessage(demand(3));
    const pcm = await received;

    expect(pcm).toMatchObject({ type: 'pcm', frames: 4, final: true });
    expect(pcm.channels as ArrayBuffer[]).toHaveLength(2);
    await vi.waitFor(() => {
      expect(mocks.resamplerInstances).toBe(2);
      expect(mocks.resamplerFrees).toBe(2);
    });
  });

  it('pads and trims a short resampling EOF to the exact timeline', async () => {
    const layout = descriptor({
      frames: 1,
      channels: 1,
      sourceSampleRate: 48_000,
      outputSampleRate: 96_000,
    });
    const source = new MemoryEncodedAudioSource(sourceBytes(layout));
    const scope = await loadWorker();
    openSource(scope, source);
    const pcmPort = initialize(scope, 4, layout);
    await waitReady(scope, 4);

    const received = nextPortMessage(pcmPort);
    pcmPort.postMessage(demand(4));
    const pcm = await received;

    expect(pcm).toMatchObject({ type: 'pcm', frames: 2, final: true });
    await vi.waitFor(() => expect(mocks.resamplerFrees).toBe(1));
  });

  it('makes stale decoder generations inert without touching the source', async () => {
    const layout = descriptor({ frames: 4 });
    const source = new MemoryEncodedAudioSource(sourceBytes(layout));
    const scope = await loadWorker();
    openSource(scope, source);
    initialize(scope, 5, layout);
    await waitReady(scope, 5);

    const staleChannel = new MessageChannel();
    openPorts.push(staleChannel.port1, staleChannel.port2);
    const closeSpy = vi.spyOn(staleChannel.port1, 'close');
    dispatch(scope, {
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'init-decoder',
      sourceLifetimeGeneration: 1,
      decoderGeneration: 4,
      descriptor: layout,
      pcmPort: staleChannel.port1,
    });

    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledOnce());
    expect(source.reads).toEqual([]);
    expect(scope.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-ready', decoderGeneration: 4 }),
    );
  });

  it('aborts an in-flight read on stop without publishing a stale error', async () => {
    const layout = descriptor({ frames: 16, channels: 1 });
    const source = new MemoryEncodedAudioSource(sourceBytes(layout));
    source.blockReads = true;
    const scope = await loadWorker();
    openSource(scope, source);
    const pcmPort = initialize(scope, 6, layout);
    await waitReady(scope, 6);
    pcmPort.postMessage(demand(6));
    await vi.waitFor(() => expect(source.reads).toHaveLength(1));

    dispatch(scope, {
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'stop-decoder',
      sourceLifetimeGeneration: 1,
      decoderGeneration: 6,
    });

    await vi.waitFor(() => {
      expect(source.abortCount).toBe(1);
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-stopped', decoderGeneration: 6 }),
      );
    });
    expect(scope.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'decoder-error', decoderGeneration: 6 }),
    );
  });

  it('emits exact zero-length EOF when the target is the source end', async () => {
    const layout = descriptor({ frames: 4, targetSourceFrame: 4 });
    const source = new MemoryEncodedAudioSource(sourceBytes(layout));
    const scope = await loadWorker();
    openSource(scope, source);
    const pcmPort = initialize(scope, 8, layout);
    await waitReady(scope, 8);

    const received = nextPortMessage(pcmPort);
    pcmPort.postMessage(demand(8));
    expect(await received).toEqual({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'eof',
      generation: 8,
    });
    expect(source.reads).toEqual([]);
    await vi.waitFor(() => {
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'decoder-eof',
          decoderGeneration: 8,
          decodedInputBytes: 0,
          decodedSourceFrames: 0,
          producedOutputFrames: 0,
        }),
      );
    });
  });

  it('closes the active decoder and underlying source exactly once', async () => {
    const layout = descriptor({ frames: 4 });
    const source = new MemoryEncodedAudioSource(sourceBytes(layout));
    const scope = await loadWorker();
    const broker = openSource(scope, source);
    initialize(scope, 9, layout);
    await waitReady(scope, 9);

    dispatch(scope, {
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'close-source',
      sourceLifetimeGeneration: 1,
    });

    await vi.waitFor(() => {
      expect(source.closeCount).toBe(1);
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'decoder-stopped', decoderGeneration: 9 }),
      );
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'source-closed', sourceLifetimeGeneration: 1 }),
      );
    });
    await broker.close();
    expect(source.closeCount).toBe(1);
  });
});

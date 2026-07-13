import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
  type AacDecoderAccessUnit,
  type AacDecoderBackend,
  type AacDecoderPcmBatch,
} from '../../player/aac/decoder-backend.ts';
import {
  AAC_DECODER_PROTOCOL_VERSION,
  type AacDecoderDescriptor,
} from '../../player/aac/decoder-protocol.ts';
import {
  type EncodedAudioSource,
  throwIfAborted,
  validateExactRead,
} from '../../player/sources/encoded-audio-source.ts';
import { EncodedSourcePortBroker } from '../../player/sources/encoded-source-port.ts';
import { PCM_STREAM_PROTOCOL_VERSION } from '../../player/streaming/pcm-stream-protocol.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

interface DecodeObservation {
  readonly ordinals: readonly number[];
  readonly byteCopies: readonly Uint8Array[];
  readonly byteViews: readonly Uint8Array[];
  readonly rawBatch: Readonly<AacDecoderPcmBatch>;
}

const mocks = vi.hoisted(() => ({
  canaryCopies: [] as Uint8Array[],
  canaryViews: [] as Uint8Array[],
  decodeCalls: [] as DecodeObservation[],
  backends: [] as AacDecoderBackend[],
  backendCloseCounts: [] as number[],
  factoryCalls: 0,
  factoryOptions: [] as unknown[],
  factoryImpl: null as ((...args: unknown[]) => Promise<AacDecoderBackend>) | null,
  decodeImpl: null as
    | ((
        accessUnits: readonly Readonly<AacDecoderAccessUnit>[],
        signal: AbortSignal,
        rawBatch: Readonly<AacDecoderPcmBatch>,
      ) => Promise<Readonly<AacDecoderPcmBatch>>)
    | null,
}));

vi.mock('../../player/aac/webcodecs-canary.ts', () => ({
  AacWebCodecsIntegrityError: class AacWebCodecsIntegrityError extends Error {},
  AacWebCodecsUnavailableError: class AacWebCodecsUnavailableError extends Error {},
  probeAacWebCodecsAdtsFrame: (bytes: Uint8Array) => {
    mocks.canaryViews.push(bytes);
    mocks.canaryCopies.push(bytes.slice());
    return Promise.resolve({
      codec: 'mp4a.40.2',
      framing: 'adts',
      coreSampleRateHz: 44_100,
      coreChannelCount: 2,
      decodedCoreFrames: AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
      outputCount: 1,
      f32PlanarCopyVerified: true,
    });
  },
}));

vi.mock('../../player/aac/decoder-backend-factory.ts', () => ({
  createAacDecoderBackend: (...args: unknown[]) => {
    mocks.factoryCalls += 1;
    mocks.factoryOptions.push(args[1]);
    if (!mocks.factoryImpl) throw new Error('AAC test factory was not configured');
    return mocks.factoryImpl(...args);
  },
}));

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

class MemoryEncodedAudioSource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly size: number;
  readonly metadata = Object.freeze({ name: 'fixture.aac', mime: 'audio/aac' });
  readonly reads: ReadRecord[] = [];
  closeCount = 0;

  constructor(
    readonly bytes: Uint8Array,
    readonly identity = 'aac-worker-test-source',
  ) {
    this.size = bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push({ offset, length });
    return this.bytes.slice(offset, end);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

interface FakeWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  readonly postMessage: ReturnType<typeof vi.fn>;
  readonly addEventListener: ReturnType<typeof vi.fn>;
}

interface AacFixture {
  readonly bytes: Uint8Array;
  readonly frames: readonly Uint8Array[];
  readonly frameBytes: number;
  readonly descriptor: Readonly<AacDecoderDescriptor>;
}

const sourceBrokers: EncodedSourcePortBroker[] = [];
const openPorts: MessagePort[] = [];
const CORE_FRAMES = AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES;
const FRAME_BYTES = 31;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeAdtsFrame(ordinal: number): Uint8Array {
  const bytes = new Uint8Array(FRAME_BYTES).fill((ordinal + 1) & 0xff);
  bytes[0] = 0xff;
  bytes[1] = 0xf1;
  bytes[2] = 0x50;
  bytes[3] = 0x80 | ((FRAME_BYTES >>> 11) & 0b11);
  bytes[4] = (FRAME_BYTES >>> 3) & 0xff;
  bytes[5] = ((FRAME_BYTES & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0xfc;
  bytes[FRAME_BYTES - 1] = ordinal & 0xff;
  return bytes;
}

function fixture(options: {
  readonly actualFrameCount: number;
  readonly descriptorFrameCount?: number;
  readonly targetAccessUnitOrdinal?: number;
  readonly coreFrameWithinAccessUnit?: number;
  readonly decodeStartAccessUnitOrdinal?: number;
  readonly scanAnchorAccessUnitOrdinal?: number;
}): AacFixture {
  const descriptorFrameCount = options.descriptorFrameCount ?? options.actualFrameCount;
  const targetAccessUnitOrdinal = options.targetAccessUnitOrdinal ?? 0;
  const coreFrameWithinAccessUnit = options.coreFrameWithinAccessUnit ?? 0;
  const decodeStartAccessUnitOrdinal = options.decodeStartAccessUnitOrdinal ?? 0;
  const scanAnchorAccessUnitOrdinal = options.scanAnchorAccessUnitOrdinal ?? 0;
  const mediaFrame = targetAccessUnitOrdinal * CORE_FRAMES + coreFrameWithinAccessUnit;
  const frames = Array.from({ length: options.actualFrameCount }, (_, ordinal) =>
    makeAdtsFrame(ordinal),
  );
  const bytes = new Uint8Array(options.actualFrameCount * FRAME_BYTES);
  for (const [ordinal, frame] of frames.entries()) bytes.set(frame, ordinal * FRAME_BYTES);

  const descriptor: Readonly<AacDecoderDescriptor> = Object.freeze({
    format: 'aac-adts',
    sourceSize: bytes.byteLength,
    sourceIdentity: 'aac-worker-test-source',
    coreConfiguration: Object.freeze({
      mpegId: 0,
      profile: 1,
      coreAudioObjectType: 2,
      sampleRateIndex: 4,
      channelConfiguration: 2,
      protectionAbsent: true,
      rawDataBlocks: 1,
    }),
    coreSampleRateHz: 44_100,
    outputSampleRateHz: 44_100,
    channels: 2,
    frameCount: descriptorFrameCount,
    audioEndByteOffset: bytes.byteLength,
    timeline: Object.freeze({
      frameCount: descriptorFrameCount,
      coreFramesPerAccessUnit: CORE_FRAMES,
      totalMediaFrames: descriptorFrameCount * CORE_FRAMES,
    }),
    startPlan: Object.freeze({
      mediaFrame,
      coreFrame: mediaFrame,
      accessUnitOrdinal: targetAccessUnitOrdinal,
      coreFrameWithinAccessUnit,
      scanAnchorByteOffset: scanAnchorAccessUnitOrdinal * FRAME_BYTES,
      scanAnchorAccessUnitOrdinal,
      decodeStartAccessUnitOrdinal,
      discardCoreFrames: mediaFrame - decodeStartAccessUnitOrdinal * CORE_FRAMES,
    }),
  });
  return { bytes, frames, frameBytes: FRAME_BYTES, descriptor };
}

function makeRawBatch(
  accessUnits: readonly Readonly<AacDecoderAccessUnit>[],
): Readonly<AacDecoderPcmBatch> {
  const firstAccessUnitOrdinal = accessUnits[0]?.accessUnitOrdinal ?? 0;
  const frameCount = accessUnits.length * CORE_FRAMES;
  const planes = [0, 1].map((channel) =>
    Float32Array.from({ length: frameCount }, (_unused, index) => {
      const ordinal = firstAccessUnitOrdinal + Math.floor(index / CORE_FRAMES);
      const within = index % CORE_FRAMES;
      return channel * 100 + ordinal + 0.25 + within / 10_000;
    }),
  ) as [Float32Array, Float32Array];
  return {
    firstAccessUnitOrdinal,
    accessUnitCount: accessUnits.length,
    frameCount,
    sampleRateHz: 44_100,
    channels: 2,
    planes,
  };
}

function createBackend(firstAccessUnitOrdinal: number): AacDecoderBackend {
  const backendIndex = mocks.backends.length;
  mocks.backendCloseCounts.push(0);
  const backend: AacDecoderBackend = {
    id: 'webcodecs',
    coreSampleRateHz: 44_100,
    channels: 2,
    firstAccessUnitOrdinal,
    framing: Object.freeze({ kind: 'adts' }),
    async decodeBatch(accessUnits, signal) {
      const rawBatch = makeRawBatch(accessUnits);
      mocks.decodeCalls.push({
        ordinals: accessUnits.map((unit) => unit.accessUnitOrdinal),
        byteCopies: accessUnits.map((unit) => unit.bytes.slice()),
        byteViews: accessUnits.map((unit) => unit.bytes),
        rawBatch,
      });
      if (mocks.decodeImpl) return mocks.decodeImpl(accessUnits, signal, rawBatch);
      return rawBatch;
    },
    close() {
      mocks.backendCloseCounts[backendIndex] = (mocks.backendCloseCounts[backendIndex] ?? 0) + 1;
    },
  };
  mocks.backends.push(backend);
  return backend;
}

function allZero(values: ArrayLike<number>): boolean {
  return Array.from(values).every((value) => value === 0);
}

function dispatch(scope: FakeWorkerScope, data: unknown): void {
  scope.onmessage?.({ data } as MessageEvent<unknown>);
}

async function loadWorker(): Promise<FakeWorkerScope> {
  const scope: FakeWorkerScope = {
    onmessage: null,
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
  };
  vi.stubGlobal('self', scope);
  vi.resetModules();
  await import('../aac-stream.worker.ts');
  return scope;
}

function openDecoder(
  scope: FakeWorkerScope,
  source: MemoryEncodedAudioSource,
  descriptor: Readonly<AacDecoderDescriptor>,
  decoderGeneration = 1,
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
  dispatch(scope, {
    protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
    type: 'open-decoder',
    sourceLifetimeGeneration: 1,
    decoderGeneration,
    backendId: 'webcodecs',
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

function stop(scope: FakeWorkerScope, decoderGeneration = 1): void {
  dispatch(scope, {
    protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
    type: 'stop-decoder',
    sourceLifetimeGeneration: 1,
    decoderGeneration,
  });
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

function controlMessages(scope: FakeWorkerScope, type: string): Record<string, unknown>[] {
  return scope.postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === type);
}

function closePort(port: MessagePort): void {
  try {
    port.close();
  } catch {
    // Test cleanup is deliberately idempotent.
  }
}

describe.sequential('bounded AAC stream worker', () => {
  beforeEach(() => {
    mocks.canaryCopies.length = 0;
    mocks.canaryViews.length = 0;
    mocks.decodeCalls.length = 0;
    mocks.backends.length = 0;
    mocks.backendCloseCounts.length = 0;
    mocks.factoryCalls = 0;
    mocks.factoryOptions.length = 0;
    mocks.decodeImpl = null;
    mocks.factoryImpl = async (_id, options) => {
      const firstAccessUnitOrdinal = (options as { readonly firstAccessUnitOrdinal: number })
        .firstAccessUnitOrdinal;
      return createBackend(firstAccessUnitOrdinal);
    };
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

  it('scans a sparse anchor, canaries, rereads the decode start, and publishes exact EOF', async () => {
    const media = fixture({
      actualFrameCount: 5,
      targetAccessUnitOrdinal: 3,
      decodeStartAccessUnitOrdinal: 3,
      scanAnchorAccessUnitOrdinal: 1,
    });
    const source = new MemoryEncodedAudioSource(media.bytes);
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, source, media.descriptor);

    await waitReady(scope);
    expect(mocks.factoryOptions[0]).toMatchObject({ framing: { kind: 'adts' } });
    expect(mocks.factoryCalls).toBe(1);
    expect(mocks.decodeCalls).toHaveLength(0);
    expect(mocks.canaryCopies).toEqual([media.frames[3]]);
    expect(allZero(mocks.canaryViews[0] ?? [])).toBe(true);
    expect(source.reads.map((read) => read.offset)).toEqual([media.frameBytes]);

    const supplied: Record<string, unknown>[] = [];
    while (true) {
      const message = await requestPcm(pcmPort, 1, 512);
      supplied.push(message);
      if (message.type === 'pcm' && message.final === true) break;
    }

    expect(supplied).toHaveLength(4);
    expect(supplied.every((message) => message.frames === 512)).toBe(true);
    expect(mocks.decodeCalls.map((call) => call.ordinals)).toEqual([[3, 4]]);
    expect(mocks.decodeCalls[0]?.byteCopies).toEqual([media.frames[3], media.frames[4]]);
    expect(source.reads.map((read) => read.offset)).toEqual([
      media.frameBytes,
      3 * media.frameBytes,
    ]);
    expect(mocks.decodeCalls[0]?.byteViews.every(allZero)).toBe(true);
    expect(mocks.decodeCalls[0]?.rawBatch.planes.every(allZero)).toBe(true);

    await vi.waitFor(() => {
      expect(controlMessages(scope, 'decoder-eof')).toEqual([
        expect.objectContaining({
          decodedInputBytes: media.bytes.byteLength,
          decodedCoreFrames: 5 * CORE_FRAMES,
          producedOutputFrames: 2 * CORE_FRAMES,
        }),
      ]);
      expect(mocks.backendCloseCounts).toEqual([1]);
      expect(source.closeCount).toBe(1);
    });

    stop(scope);
    expect(controlMessages(scope, 'decoder-stopped')).toHaveLength(1);
    expect(() => stop(scope)).toThrow(/strict validation/i);
    expect(controlMessages(scope, 'decoder-stopped')).toHaveLength(1);
  });

  it('carries a discard beyond one eight-AU batch without leaking preroll PCM', async () => {
    const media = fixture({
      actualFrameCount: 10,
      targetAccessUnitOrdinal: 8,
      coreFrameWithinAccessUnit: 123,
      decodeStartAccessUnitOrdinal: 0,
    });
    const source = new MemoryEncodedAudioSource(media.bytes);
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, source, media.descriptor);
    await waitReady(scope);

    const message = await requestPcm(pcmPort, 1, 4_096);
    expect(message).toMatchObject({ type: 'pcm', frames: 1_925, final: true });
    expect(mocks.decodeCalls.map((call) => call.ordinals)).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7],
      [8, 9],
    ]);
    const channels = message.channels as ArrayBuffer[];
    expect(new Float32Array(channels[0] ?? new ArrayBuffer(0))[0]).toBeCloseTo(8.2623, 4);
    expect(new Float32Array(channels[1] ?? new ArrayBuffer(0))[0]).toBeCloseTo(108.2623, 4);
    expect(mocks.decodeCalls.every((call) => call.byteViews.every(allZero))).toBe(true);
    expect(mocks.decodeCalls.every((call) => call.rawBatch.planes.every(allZero))).toBe(true);
  });

  it('fails closed on noncanonical and overlapping PCM demands', async () => {
    const invalidMedia = fixture({ actualFrameCount: 2 });
    const invalidSource = new MemoryEncodedAudioSource(invalidMedia.bytes);
    const invalidScope = await loadWorker();
    const invalidPort = openDecoder(invalidScope, invalidSource, invalidMedia.descriptor);
    await waitReady(invalidScope);
    const invalidResponse = nextPortMessage(invalidPort);
    invalidPort.postMessage({ ...demand(1), extra: true });
    await expect(invalidResponse).resolves.toMatchObject({
      type: 'source-error',
      code: 'invalid-pcm-demand',
    });
    await vi.waitFor(() => expect(invalidSource.closeCount).toBe(1));

    const pending = deferred<Readonly<AacDecoderPcmBatch>>();
    mocks.decodeImpl = (_accessUnits, _signal, _rawBatch) => pending.promise;
    const overlapMedia = fixture({ actualFrameCount: 2 });
    const overlapSource = new MemoryEncodedAudioSource(overlapMedia.bytes);
    const overlapScope = await loadWorker();
    const overlapPort = openDecoder(overlapScope, overlapSource, overlapMedia.descriptor, 2);
    await waitReady(overlapScope, 2);
    overlapPort.postMessage(demand(2));
    await vi.waitFor(() => expect(mocks.decodeCalls).toHaveLength(1));
    const overlapResponse = nextPortMessage(overlapPort);
    overlapPort.postMessage(demand(2));
    await expect(overlapResponse).resolves.toMatchObject({
      type: 'source-error',
      generation: 2,
      code: 'invalid-pcm-demand',
    });
    pending.resolve(mocks.decodeCalls[0]!.rawBatch);
    await vi.waitFor(() => {
      expect(overlapSource.closeCount).toBe(1);
      expect(mocks.decodeCalls[0]?.rawBatch.planes.every(allZero)).toBe(true);
    });
  });

  it('stops an abort-ignoring decode immediately and clears late encoded and PCM storage', async () => {
    const pending = deferred<Readonly<AacDecoderPcmBatch>>();
    mocks.decodeImpl = (_accessUnits, _signal, _rawBatch) => pending.promise;
    const media = fixture({ actualFrameCount: 2 });
    const source = new MemoryEncodedAudioSource(media.bytes);
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, source, media.descriptor, 7);
    await waitReady(scope, 7);
    pcmPort.postMessage(demand(7));
    await vi.waitFor(() => expect(mocks.decodeCalls).toHaveLength(1));

    stop(scope, 7);
    await vi.waitFor(() => {
      expect(controlMessages(scope, 'decoder-stopped')).toHaveLength(1);
      expect(mocks.decodeCalls[0]?.byteViews.every(allZero)).toBe(true);
      expect(mocks.backendCloseCounts).toEqual([1]);
      expect(source.closeCount).toBe(1);
    });

    const lateRawBatch = mocks.decodeCalls[0]!.rawBatch;
    expect(lateRawBatch.planes.some((plane) => !allZero(plane))).toBe(true);
    pending.resolve(lateRawBatch);
    await vi.waitFor(() => {
      expect(lateRawBatch.planes.every(allZero)).toBe(true);
      expect(mocks.backendCloseCounts).toEqual([1]);
    });
  });

  it('closes a backend that resolves after stop during factory initialization exactly once', async () => {
    const pendingFactory = deferred<AacDecoderBackend>();
    mocks.factoryImpl = () => pendingFactory.promise;
    const media = fixture({ actualFrameCount: 2 });
    const source = new MemoryEncodedAudioSource(media.bytes);
    const scope = await loadWorker();
    openDecoder(scope, source, media.descriptor, 9);
    await vi.waitFor(() => expect(mocks.factoryCalls).toBe(1));

    stop(scope, 9);
    await vi.waitFor(() => {
      expect(controlMessages(scope, 'decoder-stopped')).toHaveLength(1);
      expect(source.closeCount).toBe(1);
    });
    const lateBackend = createBackend(0);
    pendingFactory.resolve(lateBackend);
    await vi.waitFor(() => expect(mocks.backendCloseCounts).toEqual([1]));
    expect(controlMessages(scope, 'decoder-ready')).toHaveLength(0);
  });

  it('rejects a verified frame count that ends before exact physical EOF', async () => {
    const media = fixture({ actualFrameCount: 3, descriptorFrameCount: 2 });
    const source = new MemoryEncodedAudioSource(media.bytes);
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, source, media.descriptor);
    await waitReady(scope);

    const response = await requestPcm(pcmPort, 1, 32_768);
    expect(response).toMatchObject({
      type: 'source-error',
      generation: 1,
      code: 'physical-eof-mismatch',
    });
    expect(mocks.decodeCalls).toHaveLength(0);
    await vi.waitFor(() => {
      expect(controlMessages(scope, 'decoder-error')).toEqual([
        expect.objectContaining({ code: 'physical-eof-mismatch' }),
      ]);
      expect(mocks.backendCloseCounts).toEqual([1]);
      expect(source.closeCount).toBe(1);
    });
  });
});

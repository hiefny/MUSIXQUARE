import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
  type AacDecoderAccessUnit,
  type AacDecoderBackend,
  type AacDecoderBackendGenerationOptions,
  type AacDecoderPcmBatch,
} from '../../player/aac/decoder-backend.ts';
import { createM4aAacDecoderDescriptor } from '../../player/m4a/decoder-helpers.ts';
import {
  M4A_AAC_DECODER_PROTOCOL_VERSION,
  type M4aAacDecoderBackendId,
  type M4aAacDecoderDescriptor,
} from '../../player/m4a/decoder-protocol.ts';
import {
  buildM4aAacFixture,
  type M4aAacFixture,
} from '../../player/m4a/__tests__/m4a-aac-fixture.ts';
import { readM4aAacLcMetadata } from '../../player/m4a/metadata.ts';
import { M4aRawAacWebCodecsIntegrityError } from '../../player/m4a/webcodecs-canary.ts';
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
  canaryDescriptions: [] as Uint8Array[],
  canaryImpl: null as ((bytes: Uint8Array, description: Uint8Array) => Promise<unknown>) | null,
  decodeCalls: [] as DecodeObservation[],
  decodeImpl: null as
    | ((
        accessUnits: readonly Readonly<AacDecoderAccessUnit>[],
        signal: AbortSignal,
        rawBatch: Readonly<AacDecoderPcmBatch>,
      ) => Promise<Readonly<AacDecoderPcmBatch>>)
    | null,
  factoryCalls: [] as Readonly<{
    readonly backendId: unknown;
    readonly options: unknown;
  }>[],
  factoryImpl: null as
    | ((backendId: unknown, options: unknown, signal: AbortSignal) => Promise<AacDecoderBackend>)
    | null,
  backendCloseCounts: [] as number[],
}));

vi.mock('../../player/m4a/webcodecs-canary.ts', () => ({
  M4aRawAacWebCodecsIntegrityError: class M4aRawAacWebCodecsIntegrityError extends Error {},
  M4aRawAacWebCodecsUnavailableError: class M4aRawAacWebCodecsUnavailableError extends Error {},
  probeM4aRawAacWebCodecsAccessUnit: (bytes: Uint8Array, description: Uint8Array) => {
    mocks.canaryViews.push(bytes);
    mocks.canaryCopies.push(bytes.slice());
    mocks.canaryDescriptions.push(description.slice());
    if (mocks.canaryImpl) return mocks.canaryImpl(bytes, description);
    return Promise.resolve({
      codec: 'mp4a.40.2',
      framing: 'raw-aac',
      coreSampleRateHz: 48_000,
      coreChannelCount: 2,
      descriptionByteLength: 5,
      decodedCoreFrames: AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES,
      outputCount: 1,
      timestampPropagationVerified: true,
      f32PlanarCopyVerified: true,
    });
  },
}));

vi.mock('../../player/aac/decoder-backend-factory.ts', () => ({
  createAacDecoderBackend: (backendId: unknown, options: unknown, signal: AbortSignal) => {
    mocks.factoryCalls.push(Object.freeze({ backendId, options }));
    if (!mocks.factoryImpl) throw new Error('M4A AAC test factory was not configured');
    return mocks.factoryImpl(backendId, options, signal);
  },
}));

interface ReadRecord {
  readonly offset: number;
  readonly length: number;
}

class WorkerFixtureSource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly size: number;
  readonly metadata = Object.freeze({ name: 'fixture.m4a', mime: 'audio/mp4' });
  readonly reads: ReadRecord[] = [];
  closeCount = 0;
  readImpl: ((offset: number, length: number, signal: AbortSignal) => Promise<Uint8Array>) | null =
    null;

  constructor(
    readonly bytes: Uint8Array,
    readonly identity: string,
  ) {
    this.size = bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const end = validateExactRead(this.size, offset, length);
    throwIfAborted(signal);
    this.reads.push(Object.freeze({ offset, length }));
    if (this.readImpl) return this.readImpl(offset, length, signal);
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

interface WorkerFixture {
  readonly built: M4aAacFixture;
  readonly source: WorkerFixtureSource;
  readonly descriptor: Readonly<M4aAacDecoderDescriptor>;
}

const sourceBrokers: EncodedSourcePortBroker[] = [];
const openPorts: MessagePort[] = [];
const CORE_FRAMES = AAC_DECODER_BACKEND_ACCESS_UNIT_CORE_FRAMES;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function workerFixture(mediaFrame = 0): Promise<WorkerFixture> {
  const built = buildM4aAacFixture();
  const manifest = await readM4aAacLcMetadata(built.source, new AbortController().signal);
  const descriptor = createM4aAacDecoderDescriptor({
    manifest,
    outputSampleRateHz: 48_000,
    mediaFrame,
  });
  return Object.freeze({
    built,
    source: new WorkerFixtureSource(built.bytes, built.source.identity),
    descriptor,
  });
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
    sampleRateHz: 48_000,
    channels: 2,
    planes,
  };
}

function createBackend(optionsValue: unknown): AacDecoderBackend {
  const options = optionsValue as Readonly<AacDecoderBackendGenerationOptions>;
  const backendIndex = mocks.backendCloseCounts.length;
  mocks.backendCloseCounts.push(0);
  return {
    id: 'webcodecs',
    coreSampleRateHz: 48_000,
    channels: 2,
    firstAccessUnitOrdinal: options.firstAccessUnitOrdinal,
    framing: options.framing,
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
  await import('../m4a-aac-stream.worker.ts');
  return scope;
}

function openDecoder(
  scope: FakeWorkerScope,
  source: WorkerFixtureSource,
  descriptor: Readonly<M4aAacDecoderDescriptor>,
  options: {
    readonly decoderGeneration?: number;
    readonly backendId?: M4aAacDecoderBackendId;
  } = {},
): MessagePort {
  const decoderGeneration = options.decoderGeneration ?? 1;
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
    protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
    type: 'open-decoder',
    sourceLifetimeGeneration: 1,
    decoderGeneration,
    backendId: options.backendId ?? 'webcodecs',
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
    protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
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

describe.sequential('bounded M4A raw AAC stream worker', () => {
  beforeEach(() => {
    mocks.canaryCopies.length = 0;
    mocks.canaryViews.length = 0;
    mocks.canaryDescriptions.length = 0;
    mocks.canaryImpl = null;
    mocks.decodeCalls.length = 0;
    mocks.decodeImpl = null;
    mocks.factoryCalls.length = 0;
    mocks.backendCloseCounts.length = 0;
    mocks.factoryImpl = async (_backendId, options) => createBackend(options);
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

  it('opens the source-bound runtime, retains its canary AU, and publishes exact logical EOF', async () => {
    const media = await workerFixture();
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, media.source, media.descriptor);
    await waitReady(scope);

    expect(mocks.factoryCalls).toHaveLength(1);
    expect(mocks.factoryCalls[0]?.backendId).toBe('webcodecs');
    expect(mocks.factoryCalls[0]?.options).toMatchObject({
      firstAccessUnitOrdinal: 0,
      framing: {
        kind: 'raw',
        description: media.built.expected.audioSpecificConfig,
      },
    });
    expect(mocks.canaryCopies).toEqual([media.built.expected.accessUnitPayloads[0]]);
    expect(mocks.canaryDescriptions).toEqual([
      Uint8Array.from(media.built.expected.audioSpecificConfig),
    ]);

    const supplied: Record<string, unknown>[] = [];
    while (true) {
      const message = await requestPcm(pcmPort, 1, 700);
      supplied.push(message);
      if (message.type === 'pcm' && message.final === true) break;
    }

    expect(mocks.decodeCalls.map((call) => call.ordinals)).toEqual([[0, 1, 2, 3, 4, 5]]);
    expect(mocks.decodeCalls[0]?.byteCopies).toEqual(media.built.expected.accessUnitPayloads);
    expect(mocks.canaryViews[0]).toBe(mocks.decodeCalls[0]?.byteViews[0]);
    expect(mocks.decodeCalls[0]?.byteViews.every(allZero)).toBe(true);
    expect(mocks.decodeCalls[0]?.rawBatch.planes.every(allZero)).toBe(true);
    expect(supplied.reduce((sum, message) => sum + Number(message.frames ?? 0), 0)).toBe(
      media.built.expected.audibleCoreFrames,
    );

    const mdatReads = media.source.reads.filter(
      ({ offset }) =>
        offset >= media.built.expected.mdatPayloadRange.start &&
        offset < media.built.expected.mdatPayloadRange.end,
    );
    expect(mdatReads).toHaveLength(1);
    await vi.waitFor(() => {
      expect(controlMessages(scope, 'decoder-eof')).toEqual([
        expect.objectContaining({
          nextAccessUnitOrdinal: 6,
          consumedEncodedBytes: media.built.expected.accessUnitSizes.reduce(
            (sum, size) => sum + size,
            0,
          ),
          decodedRawCoreFrames: media.built.expected.rawCoreFrames,
          acceptedMediaFrames: media.built.expected.audibleCoreFrames,
          producedOutputFrames: media.built.expected.audibleCoreFrames,
        }),
      ]);
      expect(mocks.backendCloseCounts).toEqual([1]);
      expect(media.source.closeCount).toBe(1);
    });
  });

  it('uses one-AU preroll for a nonzero seek and clips both leading and trailing PCM', async () => {
    const mediaFrame = 1_234;
    const media = await workerFixture(mediaFrame);
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, media.source, media.descriptor, { decoderGeneration: 2 });
    await waitReady(scope, 2);

    const response = await requestPcm(pcmPort, 2, 32_768);
    expect(response).toMatchObject({
      type: 'pcm',
      frames: media.built.expected.audibleCoreFrames - mediaFrame,
      final: true,
    });
    expect(media.descriptor.startPlan).toMatchObject({
      decodeStartAccessUnitOrdinal: 1,
      actualPrerollAccessUnits: 1,
      discardCoreFrames: 1_234,
    });
    expect(mocks.canaryCopies).toEqual([media.built.expected.accessUnitPayloads[1]]);
    expect(mocks.decodeCalls.map((call) => call.ordinals)).toEqual([[1, 2, 3, 4, 5]]);
    const firstChannel = new Float32Array(
      (response.channels as ArrayBuffer[])[0] ?? new ArrayBuffer(0),
    );
    expect(firstChannel[0]).toBeCloseTo(2.271, 3);
  });

  it('releases the full session when terminal control publication fails', async () => {
    const media = await workerFixture();
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, media.source, media.descriptor, {
      decoderGeneration: 9,
    });
    await waitReady(scope, 9);
    scope.postMessage.mockImplementation((message: unknown) => {
      if ((message as { readonly type?: unknown }).type === 'decoder-eof') {
        throw new Error('fixture control port failed at EOF');
      }
    });

    await expect(requestPcm(pcmPort, 9, 32_768)).resolves.toMatchObject({
      type: 'pcm',
      final: true,
    });
    await vi.waitFor(() => {
      expect(controlMessages(scope, 'decoder-error')).toEqual([
        expect.objectContaining({
          decoderGeneration: 9,
          code: 'decode-failed',
        }),
      ]);
      expect(mocks.backendCloseCounts).toEqual([1]);
      expect(media.source.closeCount).toBe(1);
    });
  });

  it('stops immediately while a source read ignores abort and never publishes ready', async () => {
    const media = await workerFixture();
    const pendingRead = deferred<Uint8Array>();
    media.source.readImpl = () => pendingRead.promise;
    const scope = await loadWorker();
    openDecoder(scope, media.source, media.descriptor, { decoderGeneration: 3 });
    await vi.waitFor(() => expect(media.source.reads).toHaveLength(1));

    stop(scope, 3);
    await vi.waitFor(() => {
      expect(controlMessages(scope, 'decoder-stopped')).toHaveLength(1);
      expect(media.source.closeCount).toBe(1);
    });
    pendingRead.resolve(media.source.bytes.slice(0, media.source.reads[0]?.length ?? 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controlMessages(scope, 'decoder-ready')).toHaveLength(0);
    expect(controlMessages(scope, 'decoder-error')).toHaveLength(0);
  });

  it('closes a late backend after stop and never substitutes its selected backend', async () => {
    const pendingFactory = deferred<AacDecoderBackend>();
    mocks.factoryImpl = () => pendingFactory.promise;
    const media = await workerFixture();
    const scope = await loadWorker();
    openDecoder(scope, media.source, media.descriptor, { decoderGeneration: 4 });
    await vi.waitFor(() => expect(mocks.factoryCalls).toHaveLength(1));

    stop(scope, 4);
    await vi.waitFor(() => expect(controlMessages(scope, 'decoder-stopped')).toHaveLength(1));
    pendingFactory.resolve(
      createBackend((mocks.factoryCalls[0]?.options ?? {}) as AacDecoderBackendGenerationOptions),
    );
    await vi.waitFor(() => expect(mocks.backendCloseCounts).toEqual([1]));
    expect(controlMessages(scope, 'decoder-ready')).toHaveLength(0);
    expect(mocks.factoryCalls[0]?.backendId).toBe('webcodecs');
  });

  it('stops an abort-ignoring decode and clears both late PCM and encoded storage', async () => {
    const pendingDecode = deferred<Readonly<AacDecoderPcmBatch>>();
    mocks.decodeImpl = () => pendingDecode.promise;
    const media = await workerFixture();
    const scope = await loadWorker();
    const pcmPort = openDecoder(scope, media.source, media.descriptor, { decoderGeneration: 5 });
    await waitReady(scope, 5);
    pcmPort.postMessage(demand(5));
    await vi.waitFor(() => expect(mocks.decodeCalls).toHaveLength(1));

    stop(scope, 5);
    await vi.waitFor(() => {
      expect(controlMessages(scope, 'decoder-stopped')).toHaveLength(1);
      expect(mocks.decodeCalls[0]?.byteViews.every(allZero)).toBe(true);
      expect(mocks.backendCloseCounts).toEqual([1]);
    });
    const lateBatch = mocks.decodeCalls[0]!.rawBatch;
    expect(lateBatch.planes.some((plane) => !allZero(plane))).toBe(true);
    pendingDecode.resolve(lateBatch);
    await vi.waitFor(() => expect(lateBatch.planes.every(allZero)).toBe(true));
  });

  it('fails closed on malformed backend PCM and a raw AAC unit rejected by the canary', async () => {
    const malformed = await workerFixture();
    mocks.decodeImpl = async (_accessUnits, _signal, batch) => ({
      ...batch,
      frameCount: batch.frameCount - 1,
    });
    const malformedScope = await loadWorker();
    const malformedPort = openDecoder(malformedScope, malformed.source, malformed.descriptor);
    await waitReady(malformedScope);
    await expect(requestPcm(malformedPort, 1, 32_768)).resolves.toMatchObject({
      type: 'source-error',
      code: 'backend-integrity',
    });

    mocks.canaryImpl = async () => {
      throw new M4aRawAacWebCodecsIntegrityError('fixture raw AAC unit is malformed');
    };
    const invalidCanary = await workerFixture();
    const invalidScope = await loadWorker();
    const invalidPort = openDecoder(invalidScope, invalidCanary.source, invalidCanary.descriptor, {
      decoderGeneration: 6,
    });
    await expect(nextPortMessage(invalidPort)).resolves.toMatchObject({
      type: 'source-error',
      generation: 6,
      code: 'canary-integrity',
    });
    expect(mocks.factoryCalls).toHaveLength(1);
  });

  it('surfaces source failure and rejects the unavailable Symphonia cohort without fallback', async () => {
    const failing = await workerFixture();
    failing.source.readImpl = async () => {
      throw new Error('fixture source failed');
    };
    const failingScope = await loadWorker();
    const failingPort = openDecoder(failingScope, failing.source, failing.descriptor, {
      decoderGeneration: 7,
    });
    await expect(nextPortMessage(failingPort)).resolves.toMatchObject({
      type: 'source-error',
      generation: 7,
      code: 'source-read-failed',
    });

    const unavailable = await workerFixture();
    const unavailableScope = await loadWorker();
    const unavailablePort = openDecoder(
      unavailableScope,
      unavailable.source,
      unavailable.descriptor,
      { decoderGeneration: 8, backendId: 'symphonia-wasm' },
    );
    await expect(nextPortMessage(unavailablePort)).resolves.toMatchObject({
      type: 'source-error',
      generation: 8,
      code: 'backend-unavailable',
    });
    expect(unavailable.source.reads).toHaveLength(0);
    expect(mocks.factoryCalls).toHaveLength(0);
    expect(mocks.canaryCopies).toHaveLength(0);
  });
});

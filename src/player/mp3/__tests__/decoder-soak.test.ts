import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EncodedAudioSource } from '../../sources/encoded-audio-source.ts';
import {
  ENCODED_SOURCE_LIFETIME_DEFAULT_MAX_READ_TASKS,
  EncodedAudioSourceLifetime,
  EncodedSourceLifetimeCapacityError,
} from '../../sources/encoded-audio-source-lifetime.ts';
import { EncodedSourcePortBroker } from '../../sources/encoded-source-port.ts';
import type { StreamingDecoderOpenOptions } from '../../streaming/decoder-adapter.ts';
import {
  PCM_STREAM_MAX_MESSAGE_FRAMES,
  PCM_STREAM_PROTOCOL_VERSION,
} from '../../streaming/pcm-stream-protocol.ts';
import {
  MP3_DECODER_MAX_PROGRESSIVE_INDEX_EVENTS,
  MP3_DECODER_PROTOCOL_VERSION,
  type Mp3DecoderCommand,
  type Mp3DecoderDescriptor,
  type Mp3DecoderEvent,
  type Mp3DecoderOpenCommand,
} from '../decoder-protocol.ts';
import { Mp3DecoderAdapter } from '../decoder-adapter.ts';
import { parseMpegLayer3FrameHeader } from '../frame-header.ts';
import { MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES } from '../incremental-frame-reader.ts';
import type { Mp3Metadata } from '../metadata.ts';

const workerMetrics = vi.hoisted(() => ({
  decodedFrames: 0,
  preludePointLengths: [] as number[],
  preludeDecodeStartOrdinals: [] as number[],
}));

vi.mock('../decoder-helpers.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../decoder-helpers.ts')>();
  return {
    ...actual,
    resolveMp3DecoderPrelude(
      options: Parameters<typeof actual.resolveMp3DecoderPrelude>[0],
    ): ReturnType<typeof actual.resolveMp3DecoderPrelude> {
      workerMetrics.preludePointLengths.push(options.points.length);
      const resolved = actual.resolveMp3DecoderPrelude(options);
      workerMetrics.preludeDecodeStartOrdinals.push(resolved.decodeStart.frameOrdinal);
      return resolved;
    },
  };
});

vi.mock('mpg123-decoder', () => ({
  MPEGDecoder: class SoakMpegDecoder {
    readonly ready = Promise.resolve();

    constructor(options: { readonly enableGapless: boolean }) {
      if (options.enableGapless !== false) throw new Error('gapless runtime mode must stay off');
    }

    decodeFrame() {
      workerMetrics.decodedFrames += 1;
      return {
        channelData: [new Float32Array(SAMPLES_PER_FRAME), new Float32Array(SAMPLES_PER_FRAME)],
        samplesDecoded: SAMPLES_PER_FRAME,
        sampleRate: SAMPLE_RATE,
        errors: [],
      };
    }
  },
}));

const HEADER_BYTES = Uint8Array.of(0xff, 0xfb, 0x90, 0x00);
const HEADER = parseMpegLayer3FrameHeader(HEADER_BYTES);
const SAMPLE_RATE = 44_100;
const SAMPLES_PER_FRAME = 1_152;
const ADAPTER_FRAME_COUNT = 100;
const ADAPTER_SOURCE_SIZE = HEADER.frameLengthBytes * ADAPTER_FRAME_COUNT;
const ADAPTER_TOTAL_FRAMES = ADAPTER_FRAME_COUNT * SAMPLES_PER_FRAME;
const ADAPTER_GENERATIONS = 128;
const LIFETIME_SEEKS = 256;
const SOAK_FRAME_COUNT = 1_200;
const SOAK_TARGET_FRAME_ORDINAL = 1_180;
const SOAK_WARMUP_FRAMES = 511;
const SOAK_HISTORY_FRAMES = 1_022;
const SOAK_DEMAND_FRAMES = 7;

interface SentPortMessage {
  readonly message: unknown;
  readonly transfer: readonly Transferable[];
}

class SoakMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly messages: SentPortMessage[] = [];
  closeCount = 0;
  startCount = 0;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    this.messages.push({ message, transfer });
  }

  start(): void {
    this.startCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }
}

class SoakMessageChannel {
  readonly port1 = new SoakMessagePort();
  readonly port2 = new SoakMessagePort();
}

interface ActiveWorkerLedger {
  active: number;
  maximum: number;
}

class SoakWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{
    readonly message: Mp3DecoderCommand;
    readonly transfer: readonly Transferable[];
  }> = [];
  readonly #ledger: ActiveWorkerLedger;
  #ownedPorts: SoakMessagePort[] = [];
  #terminated = false;
  terminateCount = 0;

  constructor(ledger: ActiveWorkerLedger) {
    this.#ledger = ledger;
    ledger.active += 1;
    ledger.maximum = Math.max(ledger.maximum, ledger.active);
  }

  postMessage(message: Mp3DecoderCommand, transfer: readonly Transferable[] = []): void {
    this.messages.push({ message, transfer });
    if (message.type === 'open-decoder') {
      this.#ownedPorts = transfer.filter(
        (value) => value instanceof SoakMessagePort,
      ) as unknown as SoakMessagePort[];
    }
  }

  terminate(): void {
    this.terminateCount += 1;
    if (this.#terminated) return;
    this.#terminated = true;
    this.#ledger.active -= 1;
    for (const port of this.#ownedPorts) port.close();
    this.#ownedPorts = [];
  }

  emit(message: Mp3DecoderEvent): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

function adapterPoint(frameOrdinal: number) {
  return Object.freeze({
    rawSample: frameOrdinal * SAMPLES_PER_FRAME,
    byteOffset: frameOrdinal * HEADER.frameLengthBytes,
    frameOrdinal,
    mainDataCapacityBytes: HEADER.mainDataCapacityBytes,
    mainDataBeginBytes: 0,
  });
}

function adapterMetadata(): Readonly<Mp3Metadata> {
  return Object.freeze({
    format: 'mp3' as const,
    id3: Object.freeze({
      sourceBytes: ADAPTER_SOURCE_SIZE,
      dataStart: 0,
      audioEnd: ADAPTER_SOURCE_SIZE,
      leadingTagCount: 0,
      leadingTags: Object.freeze([]),
      hasTrailingId3v1: false,
      trailingId3v1Offset: null,
      trailingTagCount: 0,
      trailingTags: Object.freeze([]),
    }),
    vbr: null,
    gapless: null,
    version: HEADER.version,
    sampleRateHz: SAMPLE_RATE,
    channels: 2,
    samplesPerFrame: SAMPLES_PER_FRAME,
    firstAudioFrameHeader: HEADER,
    hasTagFrame: false,
    tagFrameOffset: null,
    tagFrameBytes: 0,
    firstAudioFrameOffset: 0,
    audioEndByteOffset: ADAPTER_SOURCE_SIZE,
    id3FreeMpegBytes: ADAPTER_SOURCE_SIZE,
    audioBytes: ADAPTER_SOURCE_SIZE,
    physicalFrameCount: ADAPTER_FRAME_COUNT,
    audioFrameCount: ADAPTER_FRAME_COUNT,
    totalRawSamples: ADAPTER_TOTAL_FRAMES,
    totalMediaFrames: ADAPTER_TOTAL_FRAMES,
    durationSeconds: ADAPTER_TOTAL_FRAMES / SAMPLE_RATE,
    frameCountEvidence: 'verified-scan' as const,
    fullyVerifiedFrameSpan: true,
    verifiedAudioFrameCount: ADAPTER_FRAME_COUNT,
    verifiedAudioBytes: ADAPTER_SOURCE_SIZE,
    seekPoints: Object.freeze([adapterPoint(0)]),
  });
}

function decoderOpenOptions(
  patch: Partial<StreamingDecoderOpenOptions> = {},
): StreamingDecoderOpenOptions {
  return {
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
    onFatal: vi.fn(),
    onGenerationStopped: vi.fn(),
    ...patch,
  };
}

function decoderOpenCommand(worker: SoakWorker): Readonly<Mp3DecoderOpenCommand> {
  const command = worker.messages.find(({ message }) => message.type === 'open-decoder')?.message;
  if (!command || command.type !== 'open-decoder') throw new Error('Expected open-decoder command');
  return command;
}

function decoderReady(command: Readonly<Mp3DecoderOpenCommand>): Mp3DecoderEvent {
  return {
    protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
    type: 'decoder-ready',
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    descriptor: command.descriptor,
  };
}

interface WorkerScopeHarness {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  readonly events: Mp3DecoderEvent[];
  postMessage(message: Mp3DecoderEvent): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

class PagedMemorySource implements EncodedAudioSource {
  readonly kind = 'blob' as const;
  readonly size: number;
  readonly identity = 'source:mp3-decoder-soak';
  readonly metadata = Object.freeze({ name: 'soak.mp3', mime: 'audio/mpeg' });
  readonly reads: Array<{ readonly offset: number; readonly length: number }> = [];
  activeReads = 0;
  maximumActiveReads = 0;
  closeCount = 0;

  constructor(readonly bytes: Uint8Array) {
    this.size = bytes.byteLength;
  }

  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    this.activeReads += 1;
    this.maximumActiveReads = Math.max(this.maximumActiveReads, this.activeReads);
    this.reads.push({ offset, length });
    try {
      if (signal.aborted) throw signal.reason;
      await Promise.resolve();
      if (signal.aborted) throw signal.reason;
      return this.bytes.slice(offset, offset + length);
    } finally {
      this.activeReads -= 1;
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function soakBytes(): Uint8Array {
  const output = new Uint8Array(HEADER.frameLengthBytes * SOAK_FRAME_COUNT);
  for (let ordinal = 0; ordinal < SOAK_FRAME_COUNT; ordinal += 1) {
    output.set(HEADER_BYTES, ordinal * HEADER.frameLengthBytes);
  }
  return output;
}

function soakDescriptor(source: PagedMemorySource): Mp3DecoderDescriptor {
  const totalRawSamples = SOAK_FRAME_COUNT * SAMPLES_PER_FRAME;
  const mediaFrame = SOAK_TARGET_FRAME_ORDINAL * SAMPLES_PER_FRAME;
  return {
    format: 'mp3',
    sourceSize: source.size,
    sourceIdentity: source.identity,
    version: '1',
    sourceSampleRate: SAMPLE_RATE,
    outputSampleRate: SAMPLE_RATE,
    channels: 2,
    samplesPerFrame: SAMPLES_PER_FRAME,
    firstAudioFrameOffset: 0,
    audioEndByteOffset: source.size,
    audioFrameCount: SOAK_FRAME_COUNT,
    timeline: {
      totalRawSamples,
      samplesPerFrame: SAMPLES_PER_FRAME,
      headTrimSamples: 0,
      tailTrimSamples: 0,
      rawEofSampleExclusive: totalRawSamples,
      totalMediaFrames: totalRawSamples,
    },
    startPlan: {
      mediaFrame,
      rawSample: mediaFrame,
      audioFrameOrdinal: SOAK_TARGET_FRAME_ORDINAL,
      sampleWithinAudioFrame: 0,
      scanAnchorByteOffset: 0,
      scanAnchorFrameOrdinal: 0,
      minimumWarmupFrames: SOAK_WARMUP_FRAMES,
      historyFrameLimit: SOAK_HISTORY_FRAMES,
    },
  };
}

async function loadWorkerScope(): Promise<WorkerScopeHarness> {
  const scope: WorkerScopeHarness = {
    onmessage: null,
    events: [],
    postMessage(message) {
      this.events.push(message);
    },
    addEventListener() {
      // No messageerror is injected by this bounded soak harness.
    },
  };
  vi.stubGlobal('self', scope);
  vi.resetModules();
  await import('../../../workers/mp3-stream.worker.ts');
  return scope;
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

describe.sequential('bounded MP3 decoder soak', () => {
  beforeEach(() => {
    workerMetrics.decodedFrames = 0;
    workerMetrics.preludePointLengths.length = 0;
    workerMetrics.preludeDecodeStartOrdinals.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps 128 fresh adapter seek/stop generations at one active realm and exact ownership', async () => {
    const ledger: ActiveWorkerLedger = { active: 0, maximum: 0 };
    const workers: SoakWorker[] = [];
    const channels: SoakMessageChannel[] = [];
    const pcmPorts: SoakMessagePort[] = [];
    const closeSource = vi.fn(async () => undefined);
    const source: EncodedAudioSource = {
      kind: 'blob',
      size: ADAPTER_SOURCE_SIZE,
      identity: 'source:mp3-adapter-soak',
      metadata: { name: 'adapter-soak.mp3', mime: 'audio/mpeg' },
      readAt: async (_offset, length) => new Uint8Array(length),
      close: closeSource,
    };
    const fatal = vi.fn();
    const stopped = vi.fn();
    const adapter = new Mp3DecoderAdapter({
      encodedSource: source,
      metadata: adapterMetadata(),
      runtime: {
        createWorker: () => {
          const worker = new SoakWorker(ledger);
          workers.push(worker);
          return worker as unknown as Worker;
        },
        createMessageChannel: () => {
          const channel = new SoakMessageChannel();
          channels.push(channel);
          return channel as unknown as MessageChannel;
        },
      },
    });
    await adapter.open(decoderOpenOptions({ onFatal: fatal, onGenerationStopped: stopped }));

    const sourceLifetimeGenerations: number[] = [];
    for (let index = 0; index < ADAPTER_GENERATIONS; index += 1) {
      const generation = index + 1;
      const pcmPort = new SoakMessagePort();
      pcmPorts.push(pcmPort);
      const targetMediaFrame = (index * 997) % (ADAPTER_TOTAL_FRAMES - 1);
      const pending = adapter.startGeneration({
        generation,
        targetMediaFrame,
        outputSampleRateHz: 48_000,
        pcmPort: pcmPort as unknown as MessagePort,
        signal: new AbortController().signal,
      });
      const worker = workers[index];
      if (!worker) throw new Error(`Missing Worker generation ${generation}`);
      const command = decoderOpenCommand(worker);
      sourceLifetimeGenerations.push(command.sourceLifetimeGeneration);
      const staleCallback = worker.onmessage;

      expect(ledger.active).toBe(1);
      expect(worker.messages).toHaveLength(1);
      expect(worker.messages[0]?.transfer).toHaveLength(2);
      worker.emit(decoderReady(command));
      await pending;
      adapter.stopGeneration(generation);

      expect(ledger.active).toBe(0);
      expect(worker.terminateCount).toBe(1);
      staleCallback?.({ data: { malformed: true } } as MessageEvent<unknown>);
      expect(fatal).not.toHaveBeenCalled();
    }

    expect(ledger).toEqual({ active: 0, maximum: 1 });
    expect(workers).toHaveLength(ADAPTER_GENERATIONS);
    expect(channels).toHaveLength(ADAPTER_GENERATIONS);
    expect(new Set(sourceLifetimeGenerations).size).toBe(ADAPTER_GENERATIONS);
    expect(sourceLifetimeGenerations).toEqual(
      Array.from({ length: ADAPTER_GENERATIONS }, (_, index) => index + 1),
    );
    expect(channels.every((channel) => channel.port1.closeCount === 1)).toBe(true);
    expect(channels.every((channel) => channel.port2.closeCount === 1)).toBe(true);
    expect(pcmPorts.every((port) => port.closeCount === 1)).toBe(true);
    expect(stopped).not.toHaveBeenCalled();

    const close = adapter.close();
    expect(adapter.close()).toBe(close);
    await close;
    expect(closeSource).toHaveBeenCalledTimes(1);
  });

  it('holds abort-resistant reads to one global lifetime cap across 256 retired leases', async () => {
    const physicalResolvers: Array<(bytes: Uint8Array) => void> = [];
    const closeSource = vi.fn(async () => undefined);
    const sourceRead = vi.fn(
      (_offset: number, _length: number, _signal: AbortSignal) =>
        new Promise<Uint8Array>((resolve) => physicalResolvers.push(resolve)),
    );
    const lifetime = new EncodedAudioSourceLifetime({
      source: {
        kind: 'peer-range',
        size: 1,
        identity: 'source:abort-resistant-soak',
        metadata: { name: 'blocked.mp3', mime: 'audio/mpeg' },
        readAt: sourceRead,
        close: closeSource,
      },
    });
    let capacityFailures = 0;

    for (let index = 0; index < LIFETIME_SEEKS; index += 1) {
      const lease = lifetime.acquireLease();
      const result = lease
        .readAt(0, 1, new AbortController().signal)
        .catch((error: unknown) => error);
      await Promise.resolve();
      await lease.close();
      const outcome = await result;
      if (outcome instanceof EncodedSourceLifetimeCapacityError) capacityFailures += 1;

      expect(lifetime.hasActiveLease).toBe(false);
      expect(lifetime.readTaskCount).toBe(
        Math.min(index + 1, ENCODED_SOURCE_LIFETIME_DEFAULT_MAX_READ_TASKS),
      );
    }

    expect(sourceRead).toHaveBeenCalledTimes(ENCODED_SOURCE_LIFETIME_DEFAULT_MAX_READ_TASKS);
    expect(physicalResolvers).toHaveLength(ENCODED_SOURCE_LIFETIME_DEFAULT_MAX_READ_TASKS);
    expect(capacityFailures).toBe(LIFETIME_SEEKS - ENCODED_SOURCE_LIFETIME_DEFAULT_MAX_READ_TASKS);
    expect(lifetime.readTaskCount).toBe(ENCODED_SOURCE_LIFETIME_DEFAULT_MAX_READ_TASKS);

    const close = lifetime.close();
    expect(lifetime.close()).toBe(close);
    await close;
    expect(closeSource).toHaveBeenCalledTimes(1);
    for (const resolve of physicalResolvers) resolve(Uint8Array.of(0));
    await vi.waitFor(() => expect(lifetime.readTaskCount).toBe(0));
    expect(closeSource).toHaveBeenCalledTimes(1);
  });

  it('serially supplies thousands of small demands within page, rolling-index, and PCM bounds', async () => {
    const source = new PagedMemorySource(soakBytes());
    const descriptor = soakDescriptor(source);
    const scope = await loadWorkerScope();
    const sourceChannel = new MessageChannel();
    const pcmChannel = new MessageChannel();
    const broker = new EncodedSourcePortBroker({
      source,
      port: sourceChannel.port1,
      generation: 1,
    });
    try {
      scope.onmessage?.({
        data: {
          protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
          type: 'open-decoder',
          sourceLifetimeGeneration: 1,
          decoderGeneration: 1,
          descriptor,
          sourcePort: sourceChannel.port2,
          pcmPort: pcmChannel.port1,
        },
      } as MessageEvent<unknown>);
      await vi.waitFor(() => {
        expect(scope.events.some((event) => event.type === 'decoder-ready')).toBe(true);
      });

      const pcmMessages: Record<string, unknown>[] = [];
      while (true) {
        const response = nextPortMessage(pcmChannel.port2);
        pcmChannel.port2.postMessage({
          protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
          type: 'need',
          generation: 1,
          maxFrames: SOAK_DEMAND_FRAMES,
        });
        const message = await response;
        pcmMessages.push(message);
        if (message.type === 'pcm' && message.final === true) break;
        if (message.type !== 'pcm') throw new Error(`Unexpected PCM message: ${message.type}`);
      }

      const remainingFrames = (SOAK_FRAME_COUNT - SOAK_TARGET_FRAME_ORDINAL) * SAMPLES_PER_FRAME;
      expect(pcmMessages).toHaveLength(
        (SOAK_FRAME_COUNT - SOAK_TARGET_FRAME_ORDINAL) *
          Math.ceil(SAMPLES_PER_FRAME / SOAK_DEMAND_FRAMES),
      );
      expect(pcmMessages.length).toBeGreaterThan(3_000);
      expect(pcmMessages.reduce((total, message) => total + (message.frames as number), 0)).toBe(
        remainingFrames,
      );
      expect(pcmMessages.filter((message) => message.final === true)).toHaveLength(1);
      expect(
        pcmMessages.every(
          (message) =>
            message.type === 'pcm' &&
            (message.frames as number) >= 1 &&
            (message.frames as number) <= SOAK_DEMAND_FRAMES &&
            (message.frames as number) <= PCM_STREAM_MAX_MESSAGE_FRAMES,
        ),
      ).toBe(true);
      expect(
        pcmMessages.every((message) => {
          const channels = message.channels as ArrayBuffer[];
          return (
            channels.length === 2 &&
            channels.every(
              (channel) =>
                channel.byteLength === (message.frames as number) * Float32Array.BYTES_PER_ELEMENT,
            )
          );
        }),
      ).toBe(true);

      expect(workerMetrics.preludePointLengths).toEqual([SOAK_HISTORY_FRAMES + 1]);
      const decodeStartOrdinal = SOAK_TARGET_FRAME_ORDINAL - SOAK_WARMUP_FRAMES;
      expect(workerMetrics.preludeDecodeStartOrdinals).toEqual([decodeStartOrdinal]);
      expect(workerMetrics.decodedFrames).toBe(SOAK_FRAME_COUNT - decodeStartOrdinal);

      const indexEvents = scope.events.filter((event) => event.type === 'frame-index-point');
      expect(indexEvents).toHaveLength(SOAK_FRAME_COUNT);
      expect(indexEvents.length).toBeLessThanOrEqual(MP3_DECODER_MAX_PROGRESSIVE_INDEX_EVENTS);
      expect(indexEvents.every((event) => !Object.hasOwn(event, 'bytes'))).toBe(true);
      expect(source.maximumActiveReads).toBe(1);
      expect(
        source.reads.every((read) => read.length <= MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES),
      ).toBe(true);
      const scanBytes = (SOAK_TARGET_FRAME_ORDINAL + 1) * HEADER.frameLengthBytes;
      const decodeBytes = source.size - decodeStartOrdinal * HEADER.frameLengthBytes;
      const maximumPageReads =
        Math.ceil(scanBytes / MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES) +
        Math.ceil(decodeBytes / MP3_INCREMENTAL_FRAME_READER_MAX_PAGE_BYTES);
      expect(source.reads.length).toBeLessThanOrEqual(maximumPageReads);

      await vi.waitFor(() => {
        expect(scope.events).toContainEqual(
          expect.objectContaining({
            type: 'decoder-eof',
            decodedInputBytes: source.size,
            decodedRawSamples: SOAK_FRAME_COUNT * SAMPLES_PER_FRAME,
            producedOutputFrames: remainingFrames,
          }),
        );
        expect(source.closeCount).toBe(1);
      });
    } finally {
      await broker.close();
      sourceChannel.port2.close();
      pcmChannel.port2.close();
    }
  }, 15_000);
});

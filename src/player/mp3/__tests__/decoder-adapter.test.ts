import { describe, expect, it, vi } from 'vitest';

import type { EncodedAudioSource } from '../../sources/encoded-audio-source.ts';
import type { StreamingDecoderOpenOptions } from '../../streaming/decoder-adapter.ts';
import {
  PCM_STREAM_MAX_MESSAGE_FRAMES,
  PCM_STREAM_PROTOCOL_VERSION,
} from '../../streaming/pcm-stream-protocol.ts';
import { expectedMp3OutputFrames } from '../decoder-helpers.ts';
import {
  MP3_DECODER_PROTOCOL_VERSION,
  type Mp3DecoderCommand,
  type Mp3DecoderEvent,
  type Mp3DecoderOpenCommand,
} from '../decoder-protocol.ts';
import { Mp3DecoderAdapter } from '../decoder-adapter.ts';
import {
  createMp3DecoderTimelineEvidence,
  type Mp3DecoderTimelineEvidence,
} from '../decoder-timeline-evidence.ts';
import { parseMpegLayer3FrameHeader } from '../frame-header.ts';
import type { Mp3Metadata } from '../metadata.ts';

class FakeMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly messages: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
  closeCount = 0;
  startCount = 0;
  throwOnAdd = false;
  throwOnPost = false;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (this.throwOnAdd) throw new Error('failed port addEventListener');
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    if (this.throwOnPost) throw new Error('failed port postMessage');
    this.messages.push({ message, transfer });
  }

  start(): void {
    this.startCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
    const event = { data: message } as MessageEvent<unknown>;
    for (const listener of this.listeners.get('message') ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

class FakeMessageChannel {
  readonly port1 = new FakeMessagePort();
  readonly port2 = new FakeMessagePort();
}

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{ message: Mp3DecoderCommand; transfer: readonly Transferable[] }> = [];
  throwOnOpen = false;
  terminateCount = 0;

  postMessage(message: Mp3DecoderCommand, transfer: readonly Transferable[] = []): void {
    if (message.type === 'open-decoder' && this.throwOnOpen) {
      throw new Error('failed open-decoder transfer');
    }
    this.messages.push({ message, transfer });
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: Mp3DecoderEvent): void {
    this.emitUnknown(message);
  }

  emitUnknown(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

const HEADER = parseMpegLayer3FrameHeader(Uint8Array.of(0xff, 0xfb, 0x90, 0x64));
const AUDIO_FRAME_COUNT = 100;
const SOURCE_SIZE = HEADER.frameLengthBytes * AUDIO_FRAME_COUNT;
const TOTAL_FRAMES = AUDIO_FRAME_COUNT * HEADER.samplesPerFrame;
const SOURCE_IDENTITY = 'source:mp3-decoder-adapter-test';

function point(frameOrdinal: number) {
  return Object.freeze({
    rawSample: frameOrdinal * HEADER.samplesPerFrame,
    byteOffset: frameOrdinal * HEADER.frameLengthBytes,
    frameOrdinal,
    mainDataCapacityBytes: HEADER.mainDataCapacityBytes,
    mainDataBeginBytes: 0,
  });
}

function metadata(): Readonly<Mp3Metadata> {
  return Object.freeze({
    format: 'mp3' as const,
    id3: Object.freeze({
      sourceBytes: SOURCE_SIZE,
      dataStart: 0,
      audioEnd: SOURCE_SIZE,
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
    sampleRateHz: HEADER.sampleRateHz,
    channels: HEADER.channelCount,
    samplesPerFrame: HEADER.samplesPerFrame,
    firstAudioFrameHeader: HEADER,
    hasTagFrame: false,
    tagFrameOffset: null,
    tagFrameBytes: 0,
    firstAudioFrameOffset: 0,
    audioEndByteOffset: SOURCE_SIZE,
    id3FreeMpegBytes: SOURCE_SIZE,
    audioBytes: SOURCE_SIZE,
    physicalFrameCount: AUDIO_FRAME_COUNT,
    audioFrameCount: AUDIO_FRAME_COUNT,
    totalRawSamples: TOTAL_FRAMES,
    totalMediaFrames: TOTAL_FRAMES,
    durationSeconds: TOTAL_FRAMES / HEADER.sampleRateHz,
    frameCountEvidence: 'verified-scan' as const,
    fullyVerifiedFrameSpan: true,
    verifiedAudioFrameCount: AUDIO_FRAME_COUNT,
    verifiedAudioBytes: SOURCE_SIZE,
    seekPoints: Object.freeze([point(0)]),
  });
}

function timelineEvidence(sourceIdentity = SOURCE_IDENTITY): Readonly<Mp3DecoderTimelineEvidence> {
  return createMp3DecoderTimelineEvidence({
    format: 'mp3-decoder-timeline',
    sourceIdentity,
    sourceSize: SOURCE_SIZE,
    version: HEADER.version,
    sampleRateHz: HEADER.sampleRateHz,
    channels: HEADER.channelCount,
    samplesPerFrame: HEADER.samplesPerFrame,
    firstAudioFrameOffset: 0,
    audioEndByteOffset: SOURCE_SIZE,
    audioFrameCount: AUDIO_FRAME_COUNT,
    tagFrame: null,
    frameCountEvidence: 'verified-scan',
    fullyVerifiedFrameSpan: true,
    verifiedAudioFrameCount: AUDIO_FRAME_COUNT,
    verifiedAudioBytes: SOURCE_SIZE,
    timeline: {
      totalRawSamples: TOTAL_FRAMES,
      samplesPerFrame: HEADER.samplesPerFrame,
      headTrimSamples: 0,
      tailTrimSamples: 0,
      rawEofSampleExclusive: TOTAL_FRAMES,
      totalMediaFrames: TOTAL_FRAMES,
    },
    seekPoints: [point(0), point(AUDIO_FRAME_COUNT - 1)],
  });
}

function harness(
  options: { readonly timelineEvidence?: Readonly<Mp3DecoderTimelineEvidence> } = {},
) {
  const workers: FakeWorker[] = [];
  const channels: FakeMessageChannel[] = [];
  const closeSource = vi.fn(async () => undefined);
  const readAt = vi.fn(async (_offset: number, length: number) => new Uint8Array(length));
  const source: EncodedAudioSource = {
    kind: 'blob',
    size: SOURCE_SIZE,
    identity: SOURCE_IDENTITY,
    metadata: { name: 'fixture.mp3', mime: 'audio/mpeg' },
    readAt,
    close: closeSource,
  };
  const createWorker = vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const createMessageChannel = vi.fn(() => {
    const channel = new FakeMessageChannel();
    channels.push(channel);
    return channel as unknown as MessageChannel;
  });
  const runtime = { createWorker, createMessageChannel };
  const adapter = options.timelineEvidence
    ? new Mp3DecoderAdapter({
        encodedSource: source,
        timelineEvidence: options.timelineEvidence,
        runtime,
      })
    : new Mp3DecoderAdapter({
        encodedSource: source,
        metadata: metadata(),
        runtime,
      });
  return {
    adapter,
    workers,
    channels,
    closeSource,
    readAt,
    createWorker,
    createMessageChannel,
  };
}

function options(patch: Partial<StreamingDecoderOpenOptions> = {}): StreamingDecoderOpenOptions {
  return {
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
    onFatal: vi.fn(),
    onGenerationStopped: vi.fn(),
    ...patch,
  };
}

function openCommand(worker: FakeWorker): Mp3DecoderOpenCommand {
  const command = worker.messages.find(({ message }) => message.type === 'open-decoder')?.message;
  if (!command || command.type !== 'open-decoder') throw new Error('Expected open-decoder command');
  return command;
}

function ready(command: Mp3DecoderOpenCommand): Mp3DecoderEvent {
  return {
    protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
    type: 'decoder-ready',
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    descriptor: command.descriptor,
  };
}

function request(
  generation: number,
  targetMediaFrame: number,
  port: FakeMessagePort,
  signal = new AbortController().signal,
) {
  return {
    generation,
    targetMediaFrame,
    outputSampleRateHz: 48_000,
    pcmPort: port as unknown as MessagePort,
    signal,
  };
}

describe('Mp3DecoderAdapter', () => {
  it('opens byte-identical generations from normalized timeline evidence', async () => {
    const legacy = harness();
    const normalized = harness({ timelineEvidence: timelineEvidence() });
    await legacy.adapter.open(options());
    await normalized.adapter.open(options());
    const target = 50 * HEADER.samplesPerFrame + 37;

    const legacyReady = legacy.adapter.startGeneration(request(1, target, new FakeMessagePort()));
    const normalizedReady = normalized.adapter.startGeneration(
      request(1, target, new FakeMessagePort()),
    );
    const legacyWorker = legacy.workers[0];
    const normalizedWorker = normalized.workers[0];
    if (!legacyWorker || !normalizedWorker) throw new Error('Expected comparable MP3 realms');
    const legacyCommand = openCommand(legacyWorker);
    const normalizedCommand = openCommand(normalizedWorker);

    expect(normalizedCommand.descriptor).toEqual(legacyCommand.descriptor);
    expect(JSON.stringify(normalizedCommand.descriptor)).toBe(
      JSON.stringify(legacyCommand.descriptor),
    );
    legacyWorker.emit(ready(legacyCommand));
    normalizedWorker.emit(ready(normalizedCommand));
    await Promise.all([legacyReady, normalizedReady]);
    await Promise.all([legacy.adapter.close(), normalized.adapter.close()]);
  });

  it('rejects ambiguous or differently source-bound timeline evidence before ownership', () => {
    const close = vi.fn(async () => undefined);
    const source: EncodedAudioSource = {
      kind: 'blob',
      size: SOURCE_SIZE,
      identity: SOURCE_IDENTITY,
      metadata: { name: 'fixture.mp3', mime: 'audio/mpeg' },
      readAt: async (_offset, length) => new Uint8Array(length),
      close,
    };
    const runtime = {
      createWorker: () => new FakeWorker() as unknown as Worker,
      createMessageChannel: () => new FakeMessageChannel() as unknown as MessageChannel,
    };

    expect(
      () =>
        new Mp3DecoderAdapter({
          encodedSource: source,
          metadata: metadata(),
          timelineEvidence: timelineEvidence(),
          runtime,
        } as never),
    ).toThrow(/exactly one/i);
    expect(
      () =>
        new Mp3DecoderAdapter({
          encodedSource: source,
          timelineEvidence: timelineEvidence(`${SOURCE_IDENTITY}:other`),
          runtime,
        }),
    ).toThrow(/another encoded source/i);
    expect(close).not.toHaveBeenCalled();
  });

  it('binds evidence comparison and lifetime ownership to one source snapshot', async () => {
    let sizeReads = 0;
    let identityReads = 0;
    const close = vi.fn(async () => undefined);
    const source = {
      kind: 'blob' as const,
      get size() {
        sizeReads += 1;
        return sizeReads === 1 ? SOURCE_SIZE : SOURCE_SIZE + 1;
      },
      get identity() {
        identityReads += 1;
        return identityReads === 1 ? SOURCE_IDENTITY : `${SOURCE_IDENTITY}:changed`;
      },
      metadata: { name: 'fixture.mp3', mime: 'audio/mpeg' },
      readAt: async (_offset: number, length: number) => new Uint8Array(length),
      close,
    };
    const adapter = new Mp3DecoderAdapter({
      encodedSource: source,
      timelineEvidence: timelineEvidence(),
      runtime: {
        createWorker: () => new FakeWorker() as unknown as Worker,
        createMessageChannel: () => new FakeMessageChannel() as unknown as MessageChannel,
      },
    });

    expect(sizeReads).toBe(1);
    expect(identityReads).toBe(1);
    expect(adapter.info.totalMediaFrames).toBe(TOTAL_FRAMES);
    await adapter.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(sizeReads).toBe(1);
    expect(identityReads).toBe(1);
  });

  it('keeps construction/open inert and closes the encoded source exactly once', async () => {
    const h = harness();
    expect(h.adapter.info).toEqual({
      mediaSampleRateHz: 44_100,
      channelCount: 2,
      totalMediaFrames: TOTAL_FRAMES,
    });
    expect(h.createWorker).not.toHaveBeenCalled();
    expect(h.createMessageChannel).not.toHaveBeenCalled();
    expect(h.readAt).not.toHaveBeenCalled();

    await h.adapter.open(options());
    expect(h.adapter.opened).toBe(true);
    expect(h.createWorker).not.toHaveBeenCalled();
    expect(h.createMessageChannel).not.toHaveBeenCalled();

    const firstClose = h.adapter.close();
    expect(h.adapter.close()).toBe(firstClose);
    await firstClose;
    expect(h.closeSource).toHaveBeenCalledTimes(1);
  });

  it('atomically transfers source+PCM ports into a fresh Worker for every generation', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const target = 90 * HEADER.samplesPerFrame + 123;

    const firstReady = h.adapter.startGeneration(request(1, target, new FakeMessagePort()));
    const firstWorker = h.workers[0];
    const firstChannel = h.channels[0];
    if (!firstWorker || !firstChannel) throw new Error('Expected first MP3 realm');
    const first = openCommand(firstWorker);
    expect(first.sourcePort).toBe(firstChannel.port2);
    expect(firstWorker.messages[0]?.transfer).toEqual([firstChannel.port2, first.pcmPort]);
    expect(firstChannel.port1.startCount).toBe(1);
    firstWorker.emit(ready(first));
    await firstReady;

    firstWorker.emit({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'decoder-eof',
      sourceLifetimeGeneration: first.sourceLifetimeGeneration,
      decoderGeneration: first.decoderGeneration,
      decodedInputBytes: first.descriptor.audioEndByteOffset,
      decodedRawSamples: first.descriptor.timeline.totalRawSamples,
      producedOutputFrames: expectedMp3OutputFrames(first.descriptor),
    });
    expect(firstWorker.terminateCount).toBe(0);

    const secondReady = h.adapter.startGeneration(request(2, target, new FakeMessagePort()));
    const secondWorker = h.workers[1];
    if (!secondWorker) throw new Error('Expected second MP3 realm');
    const second = openCommand(secondWorker);
    expect(second.sourceLifetimeGeneration).toBeGreaterThan(first.sourceLifetimeGeneration);
    expect(firstWorker.terminateCount).toBe(1);
    firstWorker.emitUnknown({ malformed: true });
    expect(fatal).not.toHaveBeenCalled();
    secondWorker.emit(ready(second));
    await secondReady;

    await h.adapter.close();
    expect(secondWorker.terminateCount).toBe(1);
    expect(h.closeSource).toHaveBeenCalledTimes(1);
  });

  it('hard-terminates aborted/stopped realms and releases the lease for a successor', async () => {
    const h = harness();
    const fatal = vi.fn();
    const stopped = vi.fn();
    await h.adapter.open(options({ onFatal: fatal, onGenerationStopped: stopped }));

    const abort = new AbortController();
    const aborted = h.adapter
      .startGeneration(request(10, 0, new FakeMessagePort(), abort.signal))
      .catch((error: unknown) => error);
    const firstWorker = h.workers[0];
    if (!firstWorker) throw new Error('Expected abortable realm');
    const reason = new DOMException('seek replaced', 'AbortError');
    abort.abort(reason);
    await expect(aborted).resolves.toBe(reason);
    expect(firstWorker.terminateCount).toBe(1);

    const nextReady = h.adapter.startGeneration(request(11, 0, new FakeMessagePort()));
    const nextWorker = h.workers[1];
    if (!nextWorker) throw new Error('Expected successor realm');
    const next = openCommand(nextWorker);
    nextWorker.emit(ready(next));
    await nextReady;
    h.adapter.stopGeneration(11);
    expect(nextWorker.messages.at(-1)?.message.type).toBe('stop-decoder');
    expect(nextWorker.terminateCount).toBe(1);
    expect(fatal).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    await h.adapter.close();
  });

  it('serves exclusive EOF once after its exact PCM demand and never opens a Worker', async () => {
    const h = harness();
    await h.adapter.open(options());
    const port = new FakeMessagePort();
    await h.adapter.startGeneration(request(20, TOTAL_FRAMES, port));
    expect(h.workers).toHaveLength(0);
    expect(h.channels).toHaveLength(0);
    expect(port.messages).toHaveLength(0);
    expect(port.startCount).toBe(1);

    const demand = {
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'need' as const,
      generation: 20,
      maxFrames: 1,
    };
    port.emit(demand);
    expect(port.messages.map(({ message }) => message)).toEqual([
      { protocolVersion: PCM_STREAM_PROTOCOL_VERSION, type: 'eof', generation: 20 },
    ]);

    h.adapter.stopGeneration(20);
    expect(port.closeCount).toBe(1);
    await h.adapter.close();
  });

  it.each([
    {
      name: 'wrong generation',
      demand: {
        protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
        type: 'need',
        generation: 19,
        maxFrames: 1,
      },
    },
    {
      name: 'invalid maxFrames demand',
      demand: {
        protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
        type: 'need',
        generation: 20,
        maxFrames: PCM_STREAM_MAX_MESSAGE_FRAMES + 1,
      },
    },
  ])('fails closed immediately on an exclusive-EOF $name', async ({ demand }) => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const port = new FakeMessagePort();
    await h.adapter.startGeneration(request(20, TOTAL_FRAMES, port));

    port.emit(demand);

    expect(port.messages).toHaveLength(0);
    expect(port.closeCount).toBe(1);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith('decoder-invalid-pcm-demand', expect.any(Error));
    port.emit(demand);
    expect(fatal).toHaveBeenCalledTimes(1);
    await h.adapter.close();
  });

  it('fails closed on a duplicate current-port EOF demand after one EOF reply', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const port = new FakeMessagePort();
    await h.adapter.startGeneration(request(21, TOTAL_FRAMES, port));
    const demand = {
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'need' as const,
      generation: 21,
      maxFrames: 1,
    };

    port.emit(demand);
    port.emit(demand);

    expect(port.messages.map(({ message }) => message)).toEqual([
      { protocolVersion: PCM_STREAM_PROTOCOL_VERSION, type: 'eof', generation: 21 },
    ]);
    expect(port.closeCount).toBe(1);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith('decoder-invalid-pcm-demand', expect.any(Error));
    await h.adapter.close();
  });

  it('closes both untransferred ports and terminates the Worker when atomic transfer throws', async () => {
    const h = harness();
    await h.adapter.open(options());
    const pcm = new FakeMessagePort();
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.throwOnOpen = true;
      h.workers.push(worker);
      return worker as unknown as Worker;
    });

    await expect(h.adapter.startGeneration(request(30, 0, pcm))).rejects.toThrow(
      /open-decoder transfer/i,
    );
    expect(h.workers[0]?.terminateCount).toBe(1);
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(1);
    expect(pcm.closeCount).toBe(1);

    const retryReady = h.adapter.startGeneration(request(31, 0, new FakeMessagePort()));
    const retryWorker = h.workers[1];
    if (!retryWorker) throw new Error('Expected retry realm');
    const retry = openCommand(retryWorker);
    retryWorker.emit(ready(retry));
    await retryReady;
    await h.adapter.close();
  });

  it('closes both channel endpoints when broker construction fails partway through open', async () => {
    const h = harness();
    await h.adapter.open(options());
    const failedChannel = new FakeMessageChannel();
    failedChannel.port1.throwOnAdd = true;
    h.createMessageChannel.mockImplementationOnce(() => failedChannel as unknown as MessageChannel);
    const pcm = new FakeMessagePort();

    await expect(h.adapter.startGeneration(request(32, 0, pcm))).rejects.toThrow(
      'failed port addEventListener',
    );
    expect(failedChannel.port1.closeCount).toBe(1);
    expect(failedChannel.port2.closeCount).toBe(1);
    expect(pcm.closeCount).toBe(1);
    expect(h.workers[0]?.terminateCount).toBe(1);

    const retryReady = h.adapter.startGeneration(request(33, 0, new FakeMessagePort()));
    const retryWorker = h.workers[1];
    if (!retryWorker) throw new Error('Expected retry realm');
    const retry = openCommand(retryWorker);
    retryWorker.emit(ready(retry));
    await retryReady;
    await h.adapter.close();
  });

  it('persists bounded progressive index points into the next realm planning snapshot', async () => {
    const h = harness();
    await h.adapter.open(options());
    const target = 90 * HEADER.samplesPerFrame + 123;
    const firstReady = h.adapter.startGeneration(request(40, target, new FakeMessagePort()));
    const firstWorker = h.workers[0];
    if (!firstWorker) throw new Error('Expected indexing realm');
    const first = openCommand(firstWorker);

    for (let ordinal = 74; ordinal <= 90; ordinal += 1) {
      firstWorker.emit({
        protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
        type: 'frame-index-point',
        sourceLifetimeGeneration: first.sourceLifetimeGeneration,
        decoderGeneration: first.decoderGeneration,
        ...point(ordinal),
      });
    }
    firstWorker.emit(ready(first));
    await firstReady;

    const secondReady = h.adapter.startGeneration(request(41, target, new FakeMessagePort()));
    const secondWorker = h.workers[1];
    if (!secondWorker) throw new Error('Expected replanned realm');
    const second = openCommand(secondWorker);
    expect(second.descriptor.startPlan.scanAnchorFrameOrdinal).toBe(74);
    expect(second.descriptor.startPlan.scanAnchorByteOffset).toBe(point(74).byteOffset);
    secondWorker.emit(ready(second));
    await secondReady;
    await h.adapter.close();
  });

  it('fails and terminates only the current malformed realm while retired callbacks stay inert', async () => {
    const h = harness();
    const fatal = vi.fn();
    const stopped = vi.fn();
    await h.adapter.open(options({ onFatal: fatal, onGenerationStopped: stopped }));
    const firstPending = h.adapter
      .startGeneration(request(50, 0, new FakeMessagePort()))
      .catch((error: unknown) => error);
    const firstWorker = h.workers[0];
    if (!firstWorker) throw new Error('Expected malformed realm');
    firstWorker.emitUnknown({ malformed: true });
    await expect(firstPending).resolves.toBeInstanceOf(Error);
    expect(firstWorker.terminateCount).toBe(1);
    expect(fatal).toHaveBeenCalledWith('decoder-invalid-event', expect.any(Error));

    fatal.mockClear();
    firstWorker.emitUnknown({ still: 'stale' });
    expect(fatal).not.toHaveBeenCalled();
    const secondPending = h.adapter
      .startGeneration(request(51, 0, new FakeMessagePort()))
      .catch((error: unknown) => error);
    const secondWorker = h.workers[1];
    if (!secondWorker) throw new Error('Expected stoppable realm');
    const second = openCommand(secondWorker);
    secondWorker.emit({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'decoder-stopped',
      sourceLifetimeGeneration: second.sourceLifetimeGeneration,
      decoderGeneration: second.decoderGeneration,
    });
    await expect(secondPending).resolves.toBeInstanceOf(Error);
    expect(secondWorker.terminateCount).toBe(1);
    expect(stopped).toHaveBeenCalledWith(51, expect.any(Error));
    await h.adapter.close();
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { EncodedAudioSource } from '../../sources/encoded-audio-source.ts';
import { EncodedAudioSourceLease } from '../../sources/encoded-audio-source-lifetime.ts';
import type { StreamingDecoderOpenOptions } from '../../streaming/decoder-adapter.ts';
import { getFilePlaybackUniversalLifecycleSnapshotForTests as getFilePlaybackUniversalLifecycleSnapshot } from '../../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import {
  PCM_STREAM_MAX_MESSAGE_FRAMES,
  PCM_STREAM_PROTOCOL_VERSION,
} from '../../streaming/pcm-stream-protocol.ts';
import { createMp3DecoderDescriptor, expectedMp3OutputFrames } from '../decoder-helpers.ts';
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
  onStart: (() => void) | null = null;
  throwOnAdd = false;
  throwOnClose = false;
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
    this.onStart?.();
  }

  close(): void {
    this.closeCount += 1;
    if (this.throwOnClose) throw new Error('failed MP3 port close');
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
  #onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{ message: Mp3DecoderCommand; transfer: readonly Transferable[] }> = [];
  throwOnOpen = false;
  throwOnMessageSet = false;
  throwOnTerminate = false;
  autoRetire = true;
  retryWaitSequence = 0;
  onOpenPost: ((command: Mp3DecoderOpenCommand) => void) | null = null;
  onMessageSet: ((handler: (event: MessageEvent<unknown>) => void) => void) | null = null;
  onMessageSetBeforeCommit = false;
  terminateCount = 0;

  get onmessage(): ((event: MessageEvent<unknown>) => void) | null {
    return this.#onmessage;
  }

  set onmessage(value: ((event: MessageEvent<unknown>) => void) | null) {
    if (value && this.throwOnMessageSet)
      throw new Error('failed MP3 Worker message handler install');
    if (value && this.onMessageSetBeforeCommit) {
      let failed = false;
      let fault: unknown;
      try {
        this.onMessageSet?.(value);
      } catch (error) {
        failed = true;
        fault = error;
      }
      this.#onmessage = value;
      if (failed) throw fault;
      return;
    }
    this.#onmessage = value;
    if (value) this.onMessageSet?.(value);
  }

  postMessage(message: Mp3DecoderCommand, transfer: readonly Transferable[] = []): void {
    if (message.type === 'open-decoder' && this.throwOnOpen) {
      throw new Error('failed open-decoder transfer');
    }
    this.messages.push({ message, transfer });
    if (message.type === 'open-decoder') this.onOpenPost?.(message);
    if (message.type === 'stop-decoder' && this.autoRetire) {
      queueMicrotask(() => {
        this.emit({ ...message, type: 'decoder-stopped' });
        this.emit({ ...message, type: 'decoder-retired' });
        this.emit({
          ...message,
          type: 'worker-retired',
          retryWaitSequence: this.retryWaitSequence,
          activeRetryWaits: 0,
        });
      });
    }
  }

  terminate(): void {
    this.terminateCount += 1;
    if (this.throwOnTerminate) throw new Error('failed MP3 Worker termination');
  }

  emit(message: Mp3DecoderEvent): void {
    if (message.type === 'retry-wait-delta') this.retryWaitSequence = message.retryWaitSequence;
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
    authority: 'none',
    provenanceKind: 'scanner',
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
    manifestEndpointEvidence: null,
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

function acknowledgeRetirement(worker: FakeWorker): void {
  const command = worker.messages.find(({ message }) => message.type === 'stop-decoder')?.message;
  if (!command || command.type !== 'stop-decoder') throw new Error('Expected stop-decoder command');
  worker.emit({ ...command, type: 'decoder-stopped' });
  worker.emit({ ...command, type: 'decoder-retired' });
  worker.emit({
    ...command,
    type: 'worker-retired',
    retryWaitSequence: worker.retryWaitSequence,
    activeRetryWaits: 0,
  });
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
    acceptPcmPortOwnership: vi.fn(),
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

    const legacyRequest = request(1, target, new FakeMessagePort());
    const legacyReady = legacy.adapter.startGeneration(legacyRequest);
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
    expect(legacyRequest.acceptPcmPortOwnership).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => expect(h.workers).toHaveLength(2));
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

  it('serializes rapid successor requests across physical retirement barriers', async () => {
    const h = harness();
    await h.adapter.open(options());
    const firstPending = h.adapter.startGeneration(request(5, 0, new FakeMessagePort()));
    const firstWorker = h.workers[0];
    if (!firstWorker) throw new Error('Expected first rapid-seek realm');
    const first = openCommand(firstWorker);
    firstWorker.emit(ready(first));
    await firstPending;

    const secondOutcome = h.adapter
      .startGeneration(request(6, 100, new FakeMessagePort()))
      .catch((error: unknown) => error);
    const thirdPending = h.adapter.startGeneration(request(7, 200, new FakeMessagePort()));
    await vi.waitFor(() => expect(h.workers).toHaveLength(3));
    await expect(secondOutcome).resolves.toBeInstanceOf(Error);
    const secondWorker = h.workers[1];
    const thirdWorker = h.workers[2];
    if (!secondWorker || !thirdWorker) throw new Error('Expected serialized rapid-seek realms');
    expect(secondWorker.terminateCount).toBe(1);
    const third = openCommand(thirdWorker);
    thirdWorker.emit(ready(third));
    await thirdPending;
    await h.adapter.close();
  });

  it('does not publish a queued EOF generation after close wins the retirement barrier', async () => {
    const h = harness();
    await h.adapter.open(options());
    const firstPending = h.adapter.startGeneration(request(8, 0, new FakeMessagePort()));
    const firstWorker = h.workers[0];
    if (!firstWorker) throw new Error('Expected first close-race realm');
    const first = openCommand(firstWorker);
    firstWorker.emit(ready(first));
    await firstPending;
    firstWorker.autoRetire = false;

    const queued = h.adapter
      .startGeneration(request(9, TOTAL_FRAMES, new FakeMessagePort()))
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(firstWorker.messages.at(-1)?.message.type).toBe('stop-decoder'));
    const closing = h.adapter.close();
    firstWorker.emit({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'decoder-retired',
      sourceLifetimeGeneration: first.sourceLifetimeGeneration,
      decoderGeneration: first.decoderGeneration,
    });
    firstWorker.emit({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'worker-retired',
      sourceLifetimeGeneration: first.sourceLifetimeGeneration,
      decoderGeneration: first.decoderGeneration,
      retryWaitSequence: 0,
      activeRetryWaits: 0,
    });

    await expect(queued).resolves.toBeInstanceOf(DOMException);
    await closing;
    expect(h.workers).toHaveLength(1);
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
    await vi.waitFor(() => expect(firstWorker.terminateCount).toBe(1));

    const nextReady = h.adapter.startGeneration(request(11, 0, new FakeMessagePort()));
    await vi.waitFor(() => expect(h.workers).toHaveLength(2));
    const nextWorker = h.workers[1];
    if (!nextWorker) throw new Error('Expected successor realm');
    const next = openCommand(nextWorker);
    nextWorker.emit(ready(next));
    await nextReady;
    h.adapter.stopGeneration(11);
    expect(nextWorker.messages.at(-1)?.message.type).toBe('stop-decoder');
    await vi.waitFor(() => expect(nextWorker.terminateCount).toBe(1));
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

  it('rolls back every exclusive-EOF setup failure at the exact ownership boundary', async () => {
    const h = harness();
    await h.adapter.open(options());
    const before = getFilePlaybackUniversalLifecycleSnapshot();

    const rejectedPort = new FakeMessagePort();
    const rejectedRequest = request(40, TOTAL_FRAMES, rejectedPort);
    rejectedRequest.acceptPcmPortOwnership.mockImplementationOnce(() => {
      throw new Error('MP3 EOF ownership rejected');
    });
    await expect(h.adapter.startGeneration(rejectedRequest)).rejects.toThrow(/ownership rejected/i);
    expect(rejectedRequest.acceptPcmPortOwnership).toHaveBeenCalledTimes(1);
    expect(rejectedPort.closeCount).toBe(0);

    const messagePort = new FakeMessagePort();
    Object.defineProperty(messagePort, 'onmessage', {
      configurable: true,
      get: () => null,
      set: (value: unknown) => {
        if (value !== null) throw new Error('MP3 EOF onmessage setter failed');
      },
    });
    const messageRequest = request(41, TOTAL_FRAMES, messagePort);
    await expect(h.adapter.startGeneration(messageRequest)).rejects.toThrow(/onmessage setter/i);
    expect(messageRequest.acceptPcmPortOwnership).toHaveBeenCalledTimes(1);
    expect(messagePort.closeCount).toBe(1);

    const messageErrorPort = new FakeMessagePort();
    Object.defineProperty(messageErrorPort, 'onmessageerror', {
      configurable: true,
      get: () => null,
      set: (value: unknown) => {
        if (value !== null) throw new Error('MP3 EOF onmessageerror setter failed');
      },
    });
    const messageErrorRequest = request(42, TOTAL_FRAMES, messageErrorPort);
    await expect(h.adapter.startGeneration(messageErrorRequest)).rejects.toThrow(
      /onmessageerror setter/i,
    );
    expect(messageErrorRequest.acceptPcmPortOwnership).toHaveBeenCalledTimes(1);
    expect(messageErrorPort.closeCount).toBe(1);

    const startPort = new FakeMessagePort();
    startPort.onStart = () => {
      throw new Error('MP3 EOF start failed');
    };
    const startRequest = request(43, TOTAL_FRAMES, startPort);
    await expect(h.adapter.startGeneration(startRequest)).rejects.toThrow(/start failed/i);
    expect(startRequest.acceptPcmPortOwnership).toHaveBeenCalledTimes(1);
    expect(startPort.closeCount).toBe(1);

    const after = getFilePlaybackUniversalLifecycleSnapshot();
    for (const kind of ['decoderGenerations', 'ports'] as const) {
      expect(after.kinds[kind].live).toBe(before.kinds[kind].live);
      expect(after.kinds[kind].retiring).toBe(before.kinds[kind].retiring);
      expect(after.kinds[kind].releasedTotal).toBe(before.kinds[kind].releasedTotal + 4);
      expect(after.kinds[kind].unconfirmed).toBe(before.kinds[kind].unconfirmed);
    }
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

  it('mirrors retry waits and returns confirmed codec resources to their exact baseline', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    await h.adapter.open(options());
    const pending = h.adapter.startGeneration(request(29, 0, new FakeMessagePort()));
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected lifecycle realm');
    const command = openCommand(worker);
    worker.emit(ready(command));
    await pending;

    const active = getFilePlaybackUniversalLifecycleSnapshot();
    expect(active.kinds.decoderGenerations.live).toBe(before.kinds.decoderGenerations.live + 1);
    expect(active.kinds.workers.live).toBe(before.kinds.workers.live + 1);
    expect(active.kinds.ports.live).toBeGreaterThanOrEqual(before.kinds.ports.live + 2);
    const identity = {
      protocolVersion: command.protocolVersion,
      sourceLifetimeGeneration: command.sourceLifetimeGeneration,
      decoderGeneration: command.decoderGeneration,
    } as const;
    worker.emit({
      ...identity,
      type: 'retry-wait-delta',
      delta: 1,
      retryWaitSequence: 1,
      activeRetryWaits: 1,
    });
    const waiting = getFilePlaybackUniversalLifecycleSnapshot();
    expect(waiting.kinds.retryWaits.live).toBe(before.kinds.retryWaits.live + 1);
    expect(waiting.kinds.timers.live).toBe(before.kinds.timers.live + 1);
    worker.emit({
      ...identity,
      type: 'retry-wait-delta',
      delta: -1,
      retryWaitSequence: 2,
      activeRetryWaits: 0,
    });

    await h.adapter.close();
    const after = getFilePlaybackUniversalLifecycleSnapshot();
    for (const kind of [
      'decoderGenerations',
      'workers',
      'ports',
      'retryWaits',
      'timers',
    ] as const) {
      expect(after.kinds[kind].live, kind).toBe(before.kinds[kind].live);
      expect(after.kinds[kind].retiring, kind).toBe(before.kinds[kind].retiring);
    }
    expect(after.kinds.decoderGenerations.releasedTotal).toBeGreaterThan(
      before.kinds.decoderGenerations.releasedTotal,
    );
    expect(after.kinds.workers.releasedTotal).toBeGreaterThan(before.kinds.workers.releasedTotal);
  });

  it('keeps missing retry sequence evidence sticky instead of reporting a false clean zero', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    await h.adapter.open(options());
    const pending = h.adapter.startGeneration(request(28, 0, new FakeMessagePort()));
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected retry-accounting realm');
    const command = openCommand(worker);
    worker.emit(ready(command));
    await pending;

    worker.emitUnknown({
      protocolVersion: command.protocolVersion,
      type: 'retry-wait-delta',
      sourceLifetimeGeneration: command.sourceLifetimeGeneration,
      decoderGeneration: command.decoderGeneration,
      delta: 1,
      activeRetryWaits: 1,
    });
    await vi.waitFor(() => expect(worker.terminateCount).toBe(1));
    await h.adapter.close();

    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(after.kinds.retryWaits.unconfirmed).toBe(before.kinds.retryWaits.unconfirmed + 1);
    expect(after.kinds.timers.unconfirmed).toBe(before.kinds.timers.unconfirmed + 1);
  });

  it('keeps an EOF port unconfirmed when its physical close throws', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    await h.adapter.open(options());
    const port = new FakeMessagePort();
    port.throwOnClose = true;
    await h.adapter.startGeneration(request(27, TOTAL_FRAMES, port));

    h.adapter.stopGeneration(27);

    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(after.kinds.ports.unconfirmed).toBe(before.kinds.ports.unconfirmed + 1);
    await h.adapter.close();
  });

  it('discards exact-realm telemetry already queued behind logical retirement', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const pending = h.adapter.startGeneration(request(52, 0, new FakeMessagePort()));
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected MP3 telemetry-race realm');
    const command = openCommand(worker);
    worker.emit(ready(command));
    await pending;

    h.adapter.stopGeneration(52);
    worker.emit(ready(command));
    worker.emit({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'decoder-eof',
      sourceLifetimeGeneration: command.sourceLifetimeGeneration,
      decoderGeneration: command.decoderGeneration,
      decodedInputBytes: command.descriptor.audioEndByteOffset,
      decodedRawSamples: command.descriptor.timeline.totalRawSamples,
      producedOutputFrames: expectedMp3OutputFrames(command.descriptor),
    });
    worker.emit({
      protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
      type: 'decoder-error',
      sourceLifetimeGeneration: command.sourceLifetimeGeneration,
      decoderGeneration: command.decoderGeneration,
      code: 'late-error',
      message: 'already queued before stop',
    });

    await vi.waitFor(() => expect(worker.terminateCount).toBe(1));
    const after = getFilePlaybackUniversalLifecycleSnapshot();
    for (const kind of ['decoderGenerations', 'workers', 'ports'] as const) {
      expect(after.kinds[kind].unconfirmed).toBe(before.kinds[kind].unconfirmed);
    }
    expect(fatal).not.toHaveBeenCalled();
    await h.adapter.close();
  });

  it('keeps a wrong-realm event after logical retirement sticky-unconfirmed', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    await h.adapter.open(options());
    const pending = h.adapter.startGeneration(request(54, 0, new FakeMessagePort()));
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected MP3 wrong-realm race');
    const command = openCommand(worker);
    worker.emit(ready(command));
    await pending;

    h.adapter.stopGeneration(54);
    worker.emitUnknown({ ...ready(command), decoderGeneration: command.decoderGeneration + 1 });
    await vi.waitFor(() => expect(worker.terminateCount).toBe(1));

    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(after.kinds.decoderGenerations.unconfirmed).toBe(
      before.kinds.decoderGenerations.unconfirmed + 1,
    );
    expect(after.kinds.workers.unconfirmed).toBe(before.kinds.workers.unconfirmed + 1);
    await h.adapter.close();
  });

  it('keeps an untransferred PCM port unconfirmed when local close throws', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    await h.adapter.open(options());
    const pcm = new FakeMessagePort();
    pcm.throwOnClose = true;
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.throwOnMessageSet = true;
      h.workers.push(worker);
      return worker as unknown as Worker;
    });

    await expect(h.adapter.startGeneration(request(26, 0, pcm))).rejects.toThrow(
      /message handler install/i,
    );

    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(pcm.closeCount).toBe(1);
    expect(after.kinds.ports.unconfirmed).toBe(before.kinds.ports.unconfirmed + 1);
    await h.adapter.close();
  });

  it('rejects a valid ready event reentered by the Worker handler setter before transfer', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    const fatal = vi.fn();
    const planning = metadata();
    const descriptor = createMp3DecoderDescriptor({
      metadata: planning,
      sourceSize: SOURCE_SIZE,
      sourceIdentity: SOURCE_IDENTITY,
      seekPoints: planning.seekPoints,
      mediaFrame: 0,
      outputSampleRate: 48_000,
    });
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.onMessageSet = (handler) => {
        handler({
          data: {
            protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
            type: 'decoder-ready',
            sourceLifetimeGeneration: 1,
            decoderGeneration: 53,
            descriptor,
          },
        } as MessageEvent<unknown>);
      };
      h.workers.push(worker);
      return worker as unknown as Worker;
    });
    await h.adapter.open(options({ onFatal: fatal }));
    const pcm = new FakeMessagePort();
    const generationRequest = request(53, 0, pcm);

    await expect(h.adapter.startGeneration(generationRequest)).rejects.toThrow();

    expect(generationRequest.acceptPcmPortOwnership).toHaveBeenCalledTimes(1);
    expect(h.workers[0]?.terminateCount).toBe(1);
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(1);
    expect(pcm.closeCount).toBe(1);
    expect(fatal).toHaveBeenCalledWith('decoder-invalid-event', expect.any(Error));
    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(after.kinds.decoderGenerations.unconfirmed).toBe(
      before.kinds.decoderGenerations.unconfirmed + 1,
    );
    expect(after.kinds.workers.unconfirmed).toBe(before.kinds.workers.unconfirmed + 1);
    await h.adapter.close();
  });

  it('does not resurrect later Worker handlers when the first setter re-enters close', async () => {
    const h = harness();
    let reentrantClose: Promise<void> | null = null;
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.onMessageSet = () => {
        reentrantClose = h.adapter.close();
      };
      h.workers.push(worker);
      return worker as unknown as Worker;
    });
    await h.adapter.open(options());

    await expect(
      h.adapter.startGeneration(request(54, 0, new FakeMessagePort())),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const worker = h.workers[0];
    if (!worker || !reentrantClose) throw new Error('Expected hostile MP3 Worker setter');
    const close = reentrantClose;
    expect(h.adapter.close()).toBe(close);
    await close;
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
    expect(worker.messages).toHaveLength(0);
    expect(worker.terminateCount).toBe(1);
  });

  it('publishes the retirement barrier before generation listener removal can re-enter close', async () => {
    const h = harness();
    const generationAbort = new AbortController();
    await h.adapter.open(options());
    const pending = h.adapter.startGeneration(
      request(76, 0, new FakeMessagePort(), generationAbort.signal),
    );
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected MP3 barrier realm');
    const command = openCommand(worker);
    worker.emit(ready(command));
    await pending;
    worker.autoRetire = false;

    const nativeRemove = generationAbort.signal.removeEventListener.bind(
      generationAbort.signal,
    ) as EventTarget['removeEventListener'];
    let reentered = false;
    let reentrantClose: Promise<void> | null = null;
    Object.defineProperty(generationAbort.signal, 'removeEventListener', {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        removeOptions?: boolean | EventListenerOptions,
      ) => {
        if (type === 'abort' && !reentered) {
          reentered = true;
          reentrantClose = h.adapter.close();
        }
        nativeRemove(type, listener, removeOptions);
      },
    });

    h.adapter.stopGeneration(76);
    if (!reentrantClose) throw new Error('Expected removeEventListener-reentrant MP3 close');
    const close = reentrantClose;
    let closeSettled = false;
    void close.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(h.adapter.close()).toBe(close);

    acknowledgeRetirement(worker);
    await close;
    expect(worker.terminateCount).toBe(1);
  });

  it('rejects exact-realm retirement ACKs emitted before the stop command is posted', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    const generationAbort = new AbortController();
    await h.adapter.open(options());
    const pending = h.adapter.startGeneration(
      request(77, 0, new FakeMessagePort(), generationAbort.signal),
    );
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected MP3 pre-stop ACK realm');
    const command = openCommand(worker);
    worker.emit(ready(command));
    await pending;
    worker.autoRetire = false;

    const nativeRemove = generationAbort.signal.removeEventListener.bind(
      generationAbort.signal,
    ) as EventTarget['removeEventListener'];
    let injected = false;
    Object.defineProperty(generationAbort.signal, 'removeEventListener', {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        removeOptions?: boolean | EventListenerOptions,
      ) => {
        if (type === 'abort' && !injected) {
          injected = true;
          worker.emit({ ...command, type: 'decoder-retired' });
          worker.emit({
            ...command,
            type: 'worker-retired',
            retryWaitSequence: 0,
            activeRetryWaits: 0,
          });
        }
        nativeRemove(type, listener, removeOptions);
      },
    });

    h.adapter.stopGeneration(77);
    await vi.waitFor(() => expect(worker.terminateCount).toBe(1));
    expect(worker.messages.some(({ message }) => message.type === 'stop-decoder')).toBe(true);
    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(after.kinds.decoderGenerations.unconfirmed).toBe(
      before.kinds.decoderGenerations.unconfirmed + 1,
    );
    expect(after.kinds.workers.unconfirmed).toBe(before.kinds.workers.unconfirmed + 1);
    expect(after.kinds.ports.unconfirmed).toBe(before.kinds.ports.unconfirmed + 2);
    await h.adapter.close();
  });

  it('re-detaches a callback-before-commit Worker setter and retains its exact realm after throw', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    let reentrantClose: Promise<void> | null = null;
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.onMessageSetBeforeCommit = true;
      worker.onMessageSet = () => {
        reentrantClose = h.adapter.close();
        throw new Error('MP3 setter failed after reentrant close');
      };
      h.workers.push(worker);
      return worker as unknown as Worker;
    });
    await h.adapter.open(options());
    const pcm = new FakeMessagePort();

    await expect(
      h.adapter.startGeneration(request(78, 0, pcm)).catch((error: unknown) => error),
    ).resolves.toMatchObject({ name: 'AbortError' });
    const worker = h.workers[0];
    if (!worker || !reentrantClose) throw new Error('Expected callback-before-commit MP3 close');
    const close = reentrantClose;
    await close;
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
    expect(worker.terminateCount).toBe(1);
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(1);
    expect(pcm.closeCount).toBe(1);
    expect(getFilePlaybackUniversalLifecycleSnapshot().invariantFaults).toBe(
      before.invariantFaults,
    );
  });

  it('removes an EOF abort listener committed after a reentrant close', async () => {
    const h = harness();
    await h.adapter.open(options());
    const generationAbort = new AbortController();
    const installed = new Set<EventListenerOrEventListenerObject>();
    let reentered = false;
    let reentrantClose: Promise<void> | null = null;
    Object.defineProperties(generationAbort.signal, {
      addEventListener: {
        configurable: true,
        value: (type: string, listener: EventListenerOrEventListenerObject | null) => {
          if (type === 'abort' && !reentered) {
            reentered = true;
            reentrantClose = h.adapter.close();
          }
          if (type === 'abort' && listener) installed.add(listener);
        },
      },
      removeEventListener: {
        configurable: true,
        value: (type: string, listener: EventListenerOrEventListenerObject | null) => {
          if (type === 'abort' && listener) installed.delete(listener);
        },
      },
    });
    const port = new FakeMessagePort();

    await expect(
      h.adapter.startGeneration(request(79, TOTAL_FRAMES, port, generationAbort.signal)),
    ).rejects.toMatchObject({ name: 'AbortError' });
    if (!reentrantClose) throw new Error('Expected EOF addEventListener-reentrant MP3 close');
    await reentrantClose;
    expect(installed.size).toBe(0);
    expect(port.onmessage).toBeNull();
    expect(port.onmessageerror).toBeNull();
    expect(port.closeCount).toBe(1);
  });

  it('re-detaches a lifetime abort listener committed after a reentrant close during open', async () => {
    const h = harness();
    const lifetime = new AbortController();
    const installed = new Set<EventListenerOrEventListenerObject>();
    let reentered = false;
    let reentrantClose: Promise<void> | null = null;
    Object.defineProperties(lifetime.signal, {
      addEventListener: {
        configurable: true,
        value: (type: string, listener: EventListenerOrEventListenerObject | null) => {
          if (type === 'abort' && !reentered) {
            reentered = true;
            reentrantClose = h.adapter.close();
          }
          if (type === 'abort' && listener) installed.add(listener);
        },
      },
      removeEventListener: {
        configurable: true,
        value: (type: string, listener: EventListenerOrEventListenerObject | null) => {
          if (type === 'abort' && listener) installed.delete(listener);
        },
      },
    });

    await expect(h.adapter.open(options({ lifetimeSignal: lifetime.signal }))).rejects.toThrow(
      'MP3 decoder adapter is closed',
    );
    if (!reentrantClose) throw new Error('Expected lifetime addEventListener-reentrant MP3 close');
    const close = reentrantClose;
    expect(h.adapter.close()).toBe(close);
    await close;
    expect(installed.size).toBe(0);
    expect(h.adapter.opened).toBe(false);
    expect(h.closeSource).toHaveBeenCalledTimes(1);
  });

  it('keeps close stable when hostile lifetime listener removal throws', async () => {
    const h = harness();
    const lifetime = new AbortController();
    await h.adapter.open(options({ lifetimeSignal: lifetime.signal }));
    Object.defineProperty(lifetime.signal, 'removeEventListener', {
      configurable: true,
      value: () => {
        throw new Error('MP3 lifetime remove failed');
      },
    });

    const close = h.adapter.close();
    expect(h.adapter.close()).toBe(close);
    await close;
    expect(h.closeSource).toHaveBeenCalledTimes(1);
  });

  it('makes a postMessage-reentrant close join the exact retirement until delayed ACKs arrive', async () => {
    const h = harness();
    let reentrantClose: Promise<void> | null = null;
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.autoRetire = false;
      worker.onOpenPost = () => {
        reentrantClose = h.adapter.close();
      };
      h.workers.push(worker);
      return worker as unknown as Worker;
    });
    await h.adapter.open(options());
    const pcm = new FakeMessagePort();

    const pending = h.adapter.startGeneration(request(55, 0, pcm));
    const worker = h.workers[0];
    if (!worker || !reentrantClose) throw new Error('Expected reentrant MP3 close');
    const close = reentrantClose;
    let closeSettled = false;
    void close.then(() => {
      closeSettled = true;
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(worker.terminateCount).toBe(0);
    expect(h.channels[0]?.port2.closeCount).toBe(0);
    expect(pcm.closeCount).toBe(0);
    expect(h.adapter.close()).toBe(close);

    acknowledgeRetirement(worker);
    await close;
    expect(worker.terminateCount).toBe(1);
  });

  it('bounds a postMessage-reentrant close when its physical source read never settles', async () => {
    const h = harness();
    let resolveRead!: (bytes: Uint8Array) => void;
    const stalledRead = new Promise<Uint8Array>((resolve) => {
      resolveRead = resolve;
    });
    let readSettled = false;
    void stalledRead.then(() => {
      readSettled = true;
    });
    const readSpy = vi
      .spyOn(EncodedAudioSourceLease.prototype, 'readAt')
      .mockImplementation(() => stalledRead);
    let reentrantClose: Promise<void> | null = null;
    let fakeTimers = false;
    try {
      h.createWorker.mockImplementationOnce(() => {
        const worker = new FakeWorker();
        worker.onOpenPost = (command) => {
          const channel = h.channels[0];
          if (!channel) throw new Error('Expected MP3 source channel');
          channel.port1.emit({
            type: 'encoded-source:read',
            generation: command.sourceLifetimeGeneration,
            decoderGeneration: command.decoderGeneration,
            requestId: 1,
            offset: 0,
            length: 1,
          });
          reentrantClose = h.adapter.close();
        };
        h.workers.push(worker);
        return worker as unknown as Worker;
      });
      await h.adapter.open(options());
      vi.useFakeTimers();
      fakeTimers = true;

      const pending = h.adapter.startGeneration(request(56, 0, new FakeMessagePort()));
      const worker = h.workers[0];
      if (!worker || !reentrantClose) throw new Error('Expected stalled reentrant MP3 close');
      const close = reentrantClose;
      let closeSettled = false;
      void close.then(() => {
        closeSettled = true;
      });
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);

      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(readSettled).toBe(false);
      expect(closeSettled).toBe(false);
      expect(worker.terminateCount).toBe(0);

      await vi.advanceTimersByTimeAsync(5_000);
      await close;
      expect(readSettled).toBe(false);
      expect(worker.terminateCount).toBe(1);
    } finally {
      resolveRead(new Uint8Array(1));
      if (fakeTimers) {
        await vi.runAllTimersAsync();
        vi.useRealTimers();
      }
      readSpy.mockRestore();
      await h.adapter.close();
    }
  });

  it('publishes one stable close Promise before source cleanup can re-enter', async () => {
    let adapter!: Mp3DecoderAdapter;
    let reentrantClose: Promise<void> | null = null;
    const closeSource = vi.fn(() => {
      reentrantClose = adapter.close();
      return Promise.resolve();
    });
    const source: EncodedAudioSource = {
      kind: 'blob',
      size: SOURCE_SIZE,
      identity: SOURCE_IDENTITY,
      metadata: { name: 'fixture.mp3', mime: 'audio/mpeg' },
      readAt: async (_offset, length) => new Uint8Array(length),
      close: closeSource,
    };
    adapter = new Mp3DecoderAdapter({
      encodedSource: source,
      metadata: metadata(),
      runtime: {
        createWorker: () => new FakeWorker() as unknown as Worker,
        createMessageChannel: () => new FakeMessageChannel() as unknown as MessageChannel,
      },
    });
    await adapter.open(options());

    const close = adapter.close();
    expect(reentrantClose).toBe(close);
    expect(adapter.close()).toBe(close);
    await close;
    expect(closeSource).toHaveBeenCalledTimes(1);
  });

  it('closes both untransferred ports and terminates the Worker when atomic transfer throws', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
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
    const failed = getFilePlaybackUniversalLifecycleSnapshot();
    expect(failed.kinds.decoderGenerations.unconfirmed).toBe(
      before.kinds.decoderGenerations.unconfirmed + 1,
    );
    expect(failed.kinds.workers.unconfirmed).toBe(before.kinds.workers.unconfirmed + 1);
    expect(failed.kinds.ports.unconfirmed).toBe(before.kinds.ports.unconfirmed + 2);

    const retryReady = h.adapter.startGeneration(request(31, 0, new FakeMessagePort()));
    await vi.waitFor(() => expect(h.workers).toHaveLength(2));
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
    const generationRequest = request(32, 0, pcm);

    await expect(h.adapter.startGeneration(generationRequest)).rejects.toThrow(
      'failed port addEventListener',
    );
    expect(failedChannel.port1.closeCount).toBe(1);
    expect(failedChannel.port2.closeCount).toBe(1);
    expect(pcm.closeCount).toBe(0);
    expect(generationRequest.acceptPcmPortOwnership).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(h.workers).toHaveLength(2));
    const secondWorker = h.workers[1];
    if (!secondWorker) throw new Error('Expected replanned realm');
    const second = openCommand(secondWorker);
    expect(second.descriptor.startPlan.scanAnchorFrameOrdinal).toBe(74);
    expect(second.descriptor.startPlan.scanAnchorByteOffset).toBe(point(74).byteOffset);
    secondWorker.emit(ready(second));
    await secondReady;
    await h.adapter.close();
  });

  it('keeps Worker retirement unconfirmed when native termination throws after valid ACKs', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    await h.adapter.open(options());
    const pending = h.adapter.startGeneration(request(49, 0, new FakeMessagePort()));
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected MP3 Worker');
    const command = openCommand(worker);
    worker.throwOnTerminate = true;
    worker.emit(ready(command));
    await pending;

    await h.adapter.close();

    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(worker.terminateCount).toBeGreaterThan(0);
    expect(after.kinds.workers.unconfirmed).toBe(before.kinds.workers.unconfirmed + 1);
  });

  it('bounds retirement and successor start when the broker physical read never settles', async () => {
    const h = harness();
    let resolveRead!: (bytes: Uint8Array) => void;
    const stalledRead = new Promise<Uint8Array>((resolve) => {
      resolveRead = resolve;
    });
    let readSettled = false;
    void stalledRead.then(() => {
      readSettled = true;
    });
    const readSpy = vi
      .spyOn(EncodedAudioSourceLease.prototype, 'readAt')
      .mockImplementation(() => stalledRead);
    let fakeTimers = false;
    try {
      await h.adapter.open(options());
      const firstPending = h.adapter.startGeneration(request(70, 0, new FakeMessagePort()));
      const firstWorker = h.workers[0];
      const firstChannel = h.channels[0];
      if (!firstWorker || !firstChannel) throw new Error('Expected stalled MP3 realm');
      const first = openCommand(firstWorker);
      firstWorker.emit(ready(first));
      await firstPending;
      firstChannel.port1.emit({
        type: 'encoded-source:read',
        generation: first.sourceLifetimeGeneration,
        decoderGeneration: first.decoderGeneration,
        requestId: 1,
        offset: 0,
        length: 1,
      });
      await vi.waitFor(() => expect(readSpy).toHaveBeenCalledTimes(1));

      const before = getFilePlaybackUniversalLifecycleSnapshot();
      vi.useFakeTimers();
      fakeTimers = true;
      h.adapter.stopGeneration(70);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(firstWorker.terminateCount).toBe(1);
      expect(readSettled).toBe(false);
      const timedOut = getFilePlaybackUniversalLifecycleSnapshot();
      expect(timedOut.kinds.workers.unconfirmed).toBe(before.kinds.workers.unconfirmed + 1);

      const successorPending = h.adapter.startGeneration(request(71, 0, new FakeMessagePort()));
      expect(h.workers).toHaveLength(2);
      const successorWorker = h.workers[1];
      if (!successorWorker) throw new Error('Expected successor MP3 realm');
      const successor = openCommand(successorWorker);
      successorWorker.emit(ready(successor));
      await successorPending;

      const close = h.adapter.close();
      await vi.advanceTimersByTimeAsync(0);
      await close;
      expect(readSettled).toBe(false);
    } finally {
      resolveRead(new Uint8Array(1));
      if (fakeTimers) {
        await vi.runAllTimersAsync();
        vi.useRealTimers();
      }
      readSpy.mockRestore();
      await h.adapter.close();
    }
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
    await vi.waitFor(() => expect(firstWorker.terminateCount).toBe(1));
    expect(fatal).toHaveBeenCalledWith('decoder-invalid-event', expect.any(Error));

    fatal.mockClear();
    firstWorker.emitUnknown({ still: 'stale' });
    expect(fatal).not.toHaveBeenCalled();
    const secondPending = h.adapter
      .startGeneration(request(51, 0, new FakeMessagePort()))
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.workers).toHaveLength(2));
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
    await vi.waitFor(() => expect(secondWorker.terminateCount).toBe(1));
    expect(stopped).toHaveBeenCalledWith(51, expect.any(Error));
    await h.adapter.close();
  });
});

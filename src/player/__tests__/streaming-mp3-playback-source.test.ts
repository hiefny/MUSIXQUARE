import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import { StreamingMp3PlaybackSource } from '../backends/streaming-mp3-playback-source.ts';
import {
  MP3_DECODER_PROTOCOL_VERSION,
  type Mp3DecoderCommand,
  type Mp3DecoderEvent,
  type Mp3DecoderOpenCommand,
} from '../mp3/decoder-protocol.ts';
import {
  createMp3DecoderTimelineEvidence,
  type Mp3DecoderTimelineEvidence,
} from '../mp3/decoder-timeline-evidence.ts';
import { parseMpegLayer3FrameHeader } from '../mp3/frame-header.ts';
import type { Mp3Metadata } from '../mp3/metadata.ts';
import type { RendezvousArmIntent } from '../rendezvous-contract.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';
import type { BoundedStreamingCodecRuntime } from '../streaming/bounded-codec-runtime.ts';
import {
  PCM_STREAM_PROTOCOL_VERSION,
  type PcmRingCommand,
  type PcmRingEvent,
} from '../streaming/pcm-stream-protocol.ts';

const QID = '00000000-0000-4000-8000-000000000401' as QueueItemId;
const SOURCE_IDENTITY = 'source:test-streaming-mp3';
const OUTPUT_RATE = 48_000;
const HEADER = parseMpegLayer3FrameHeader(Uint8Array.of(0xff, 0xfb, 0x90, 0x64));
const AUDIO_FRAME_COUNT = 100;
const SOURCE_SIZE = HEADER.frameLengthBytes * AUDIO_FRAME_COUNT;
const TOTAL_MEDIA_FRAMES = HEADER.samplesPerFrame * AUDIO_FRAME_COUNT;

class FakeAudioContext {
  currentTime = 1;
  roomNowMs = 1_000;
  state: AudioContextState = 'running';

  constructor(readonly sampleRate = OUTPUT_RATE) {}
}

class FakeAudioNode {
  readonly connections: FakeAudioNode[] = [];
  disconnectCount = 0;

  constructor(readonly context: FakeAudioContext) {}

  connect(destination: FakeAudioNode): AudioNode {
    this.connections.push(destination);
    return destination as unknown as AudioNode;
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.connections.length = 0;
  }
}

class FakeMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  startCount = 0;
  closeCount = 0;
  autoRetireOnStop = true;

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
    if (
      this.autoRetireOnStop &&
      message !== null &&
      typeof message === 'object' &&
      (message as Record<string, unknown>).type === 'stop'
    ) {
      const generation = (message as Record<string, unknown>).generation as number;
      queueMicrotask(() => {
        this.emit({
          protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
          type: 'pcm-port-retired',
          generation,
        } satisfies PcmRingEvent);
        this.emit({
          protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
          type: 'processor-retired',
          generation,
        } satisfies PcmRingEvent);
      });
    }
  }

  start(): void {
    this.startCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }

  emit(message: unknown): void {
    const event = { data: message } as MessageEvent<unknown>;
    this.onmessage?.(event);
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
  terminateCount = 0;

  postMessage(message: Mp3DecoderCommand, transfer: readonly Transferable[] = []): void {
    this.messages.push({ message, transfer });
    if (message.type === 'stop-decoder') {
      queueMicrotask(() => {
        this.emit({ ...message, type: 'decoder-stopped' });
        this.emit({ ...message, type: 'decoder-retired' });
        this.emit({
          ...message,
          type: 'worker-retired',
          retryWaitSequence: 0,
          activeRetryWaits: 0,
        });
      });
    }
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: Mp3DecoderEvent): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

class FakeAudioWorkletNode extends FakeAudioNode {
  readonly port = new FakeMessagePort();
  onprocessorerror: ((event: Event) => void) | null = null;
}

function seekPoint(frameOrdinal: number) {
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
    totalRawSamples: TOTAL_MEDIA_FRAMES,
    totalMediaFrames: TOTAL_MEDIA_FRAMES,
    durationSeconds: TOTAL_MEDIA_FRAMES / HEADER.sampleRateHz,
    frameCountEvidence: 'verified-scan' as const,
    fullyVerifiedFrameSpan: true,
    verifiedAudioFrameCount: AUDIO_FRAME_COUNT,
    verifiedAudioBytes: SOURCE_SIZE,
    seekPoints: Object.freeze([seekPoint(0)]),
  });
}

function timelineEvidence(): Readonly<Mp3DecoderTimelineEvidence> {
  return createMp3DecoderTimelineEvidence({
    format: 'mp3-decoder-timeline',
    authority: 'none',
    provenanceKind: 'scanner',
    sourceIdentity: SOURCE_IDENTITY,
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
      totalRawSamples: TOTAL_MEDIA_FRAMES,
      samplesPerFrame: HEADER.samplesPerFrame,
      headTrimSamples: 0,
      tailTrimSamples: 0,
      rawEofSampleExclusive: TOTAL_MEDIA_FRAMES,
      totalMediaFrames: TOTAL_MEDIA_FRAMES,
    },
    manifestEndpointEvidence: null,
    seekPoints: [seekPoint(0), seekPoint(AUDIO_FRAME_COUNT - 1)],
  });
}

function armIntent(): RendezvousArmIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-arm',
    queueItemId: QID,
    runId: 'run-mp3-stream-1',
    revision: 1,
    rendezvousId: 'rv-mp3-stream-1',
    recipientId: 'peer-1',
    positionSeconds: 0,
    playbackRate: 1,
    startAtRoomTimeMs: 2_000,
    finalizeByRoomTimeMs: 1_800,
  };
}

interface HarnessOptions {
  readonly useDefaultWorker?: boolean;
  readonly timelineEvidence?: Readonly<Mp3DecoderTimelineEvidence>;
}

function harness(options: HarnessOptions = {}) {
  const context = new FakeAudioContext();
  const destination = new FakeAudioNode(context);
  const node = new FakeAudioWorkletNode(context);
  const workers: FakeWorker[] = [];
  const channels: FakeMessageChannel[] = [];
  const defaultWorkerCalls: Array<{
    readonly url: string | URL;
    readonly options: WorkerOptions | undefined;
  }> = [];
  const closeEncodedSource = vi.fn(async () => undefined);
  const readAt = vi.fn(async (_offset: number, length: number) => new Uint8Array(length));
  const encodedSource: EncodedAudioSource = {
    kind: 'blob',
    size: SOURCE_SIZE,
    identity: SOURCE_IDENTITY,
    metadata: { name: 'fixture.mp3', mime: 'audio/mpeg' },
    readAt,
    close: closeEncodedSource,
  };
  const loadWorklet = vi.fn(async () => undefined);
  const createWorker = vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const createWorkletNode = vi.fn(
    (_context: AudioContext, name: string, workletOptions: AudioWorkletNodeOptions) => {
      expect(name).toBe('musixquare-pcm-ring-v3');
      expect(workletOptions.outputChannelCount).toEqual([HEADER.channelCount]);
      return node as unknown as AudioWorkletNode;
    },
  );
  const createMessageChannel = vi.fn(() => {
    const channel = new FakeMessageChannel();
    channels.push(channel);
    return channel as unknown as MessageChannel;
  });

  if (options.useDefaultWorker) {
    function WorkerShim(this: unknown, url: string | URL, workerOptions?: WorkerOptions): object {
      defaultWorkerCalls.push({ url, options: workerOptions });
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }
    vi.stubGlobal('Worker', WorkerShim);
  }

  const runtime = {
    loadWorklet,
    createWorkletNode,
    createMessageChannel,
    ...(options.useDefaultWorker ? {} : { createWorker }),
  } satisfies Partial<BoundedStreamingCodecRuntime>;
  const commonOptions = {
    queueItemId: QID,
    encodedSource,
    audioContext: context as unknown as AudioContext,
    nowRoomTimeMs: () => context.roomNowMs,
    roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
    localPerformanceMsToContextTime: (performanceTimeMs) => performanceTimeMs / 1_000,
    runtime,
  };
  const source =
    options.timelineEvidence === undefined
      ? new StreamingMp3PlaybackSource({ ...commonOptions, metadata: metadata() })
      : new StreamingMp3PlaybackSource({
          ...commonOptions,
          timelineEvidence: options.timelineEvidence,
        });

  return {
    source,
    context,
    destination,
    node,
    workers,
    channels,
    closeEncodedSource,
    readAt,
    loadWorklet,
    createWorker,
    createWorkletNode,
    createMessageChannel,
    defaultWorkerCalls,
  };
}

function openCommand(worker: FakeWorker): Mp3DecoderOpenCommand {
  const command = worker.messages.find(({ message }) => message.type === 'open-decoder')?.message;
  if (!command || command.type !== 'open-decoder') throw new Error('Expected MP3 open command');
  return command;
}

function emitDecoderReady(worker: FakeWorker): void {
  const command = openCommand(worker);
  worker.emit({
    protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
    type: 'decoder-ready',
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    descriptor: command.descriptor,
  });
}

function emitPrimed(node: FakeAudioWorkletNode, generation: number): void {
  node.port.emit({
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'primed',
    generation,
    bufferedFrames: 4_096,
    sampleRate: OUTPUT_RATE,
    channels: HEADER.channelCount,
  } satisfies PcmRingEvent);
}

function controlMessages(node: FakeAudioWorkletNode): readonly PcmRingCommand[] {
  return node.port.messages.map(({ message }) => message as PcmRingCommand);
}

async function waitForWorkerOpen(
  h: ReturnType<typeof harness>,
  index: number,
): Promise<FakeWorker> {
  await vi.waitFor(() => expect(h.workers[index]?.messages[0]?.message.type).toBe('open-decoder'));
  const worker = h.workers[index];
  if (!worker) throw new Error('Expected MP3 worker realm');
  return worker;
}

async function prepare(h: ReturnType<typeof harness>): Promise<void> {
  const preparing = h.source.prepare();
  const worker = await waitForWorkerOpen(h, 0);
  emitDecoderReady(worker);
  emitPrimed(h.node, openCommand(worker).decoderGeneration);
  await preparing;
}

async function arm(h: ReturnType<typeof harness>): Promise<void> {
  await h.source.connect(h.destination as unknown as AudioNode);
  const arming = h.source.arm(armIntent());
  await vi.waitFor(() =>
    expect(controlMessages(h.node).some((message) => message.type === 'arm')).toBe(true),
  );
  const command = controlMessages(h.node).findLast((message) => message.type === 'arm');
  if (!command || command.type !== 'arm') throw new Error('Expected PCM arm command');
  h.node.port.emit({
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'armed',
    generation: command.generation,
    revision: command.revision,
    runId: command.runId,
    rendezvousId: command.rendezvousId,
    targetFrame: command.targetFrame,
  } satisfies PcmRingEvent);
  await arming;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StreamingMp3PlaybackSource', () => {
  it('requires exactly one timeline input at the wrapper boundary', () => {
    const invalidSource: EncodedAudioSource = {
      kind: 'blob',
      size: SOURCE_SIZE,
      identity: SOURCE_IDENTITY,
      metadata: { name: 'fixture.mp3', mime: 'audio/mpeg' },
      readAt: async (_offset, length) => new Uint8Array(length),
      close: async () => undefined,
    };
    const commonOptions = {
      queueItemId: QID,
      encodedSource: invalidSource,
      audioContext: new FakeAudioContext() as unknown as AudioContext,
      nowRoomTimeMs: () => 1_000,
      roomTimeMsToContextTime: (roomTimeMs: number) => roomTimeMs / 1_000,
      localPerformanceMsToContextTime: (performanceTimeMs: number) => performanceTimeMs / 1_000,
    };

    expect(() => new StreamingMp3PlaybackSource(commonOptions as never)).toThrow(/exactly one/i);
    expect(
      () =>
        new StreamingMp3PlaybackSource({
          ...commonOptions,
          metadata: metadata(),
          timelineEvidence: timelineEvidence(),
        } as never),
    ).toThrow(/exactly one/i);
  });

  it('passes normalized timeline evidence to the same bounded decoder path', async () => {
    const legacy = harness();
    const normalized = harness({ timelineEvidence: timelineEvidence() });

    await prepare(legacy);
    await prepare(normalized);

    expect(openCommand(normalized.workers[0] as FakeWorker).descriptor).toEqual(
      openCommand(legacy.workers[0] as FakeWorker).descriptor,
    );
    expect(normalized.readAt).not.toHaveBeenCalled();

    await legacy.source.destroy();
    await normalized.source.destroy();
  });

  it('keeps construction inert and closes its encoded-source ownership exactly once', async () => {
    const h = harness();

    expect(h.source.backend).toBe('bounded-stream');
    expect(h.source.getSnapshot()).toMatchObject({
      queueItemId: QID,
      backend: 'bounded-stream',
      phase: 'new',
      durationSeconds: TOTAL_MEDIA_FRAMES / HEADER.sampleRateHz,
      outputSampleRateHz: OUTPUT_RATE,
      channelCount: HEADER.channelCount,
    });
    expect(h.loadWorklet).not.toHaveBeenCalled();
    expect(h.createWorker).not.toHaveBeenCalled();
    expect(h.createWorkletNode).not.toHaveBeenCalled();
    expect(h.createMessageChannel).not.toHaveBeenCalled();
    expect(h.readAt).not.toHaveBeenCalled();

    await h.source.destroy();
    await h.source.destroy();
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
    expect(h.workers).toHaveLength(0);
  });

  it('uses the default module Worker and waits for decoder-ready plus Worklet priming', async () => {
    const h = harness({ useDefaultWorker: true });
    let settled = false;
    const preparing = h.source.prepare().then((snapshot) => {
      settled = true;
      return snapshot;
    });
    const worker = await waitForWorkerOpen(h, 0);
    const command = openCommand(worker);

    expect(h.defaultWorkerCalls).toHaveLength(1);
    expect(String(h.defaultWorkerCalls[0]?.url).replaceAll('\\', '/')).toMatch(
      /\/src\/workers\/mp3-stream\.worker\.ts$/,
    );
    expect(h.defaultWorkerCalls[0]?.options).toEqual({
      type: 'module',
      name: 'musixquare-mp3-stream-v1',
    });
    expect(h.channels).toHaveLength(2);
    expect(command.pcmPort).toBe(h.channels[0]?.port1);
    expect(command.sourcePort).toBe(h.channels[1]?.port2);
    expect(worker.messages[0]?.transfer).toEqual([h.channels[1]?.port2, h.channels[0]?.port1]);
    const bind = controlMessages(h.node).find((message) => message.type === 'bind-pcm-port');
    if (!bind || bind.type !== 'bind-pcm-port') throw new Error('Expected PCM port binding');
    expect(bind.port).toBe(h.channels[0]?.port2);

    emitDecoderReady(worker);
    await Promise.resolve();
    expect(settled).toBe(false);
    emitPrimed(h.node, command.decoderGeneration);
    await expect(preparing).resolves.toMatchObject({ phase: 'ready' });

    await h.source.destroy();
    expect(worker.terminateCount).toBe(1);
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh Worker and source lease when an armed session seeks', async () => {
    const h = harness();
    await prepare(h);
    await arm(h);
    const firstWorker = h.workers[0];
    if (!firstWorker) throw new Error('Expected first MP3 worker');
    const first = openCommand(firstWorker);

    const seeking = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-mp3-stream-1',
      revision: 1,
      positionSeconds: 1,
      atRoomTimeMs: 1_000,
    });
    const secondWorker = await waitForWorkerOpen(h, 1);
    const second = openCommand(secondWorker);

    expect(firstWorker.terminateCount).toBe(1);
    expect(second.sourceLifetimeGeneration).toBeGreaterThan(first.sourceLifetimeGeneration);
    expect(second.decoderGeneration).toBe(2);
    expect(second.descriptor.startPlan.mediaFrame).toBe(HEADER.sampleRateHz);
    expect(h.channels).toHaveLength(4);
    expect(second.pcmPort).toBe(h.channels[2]?.port1);
    expect(second.sourcePort).toBe(h.channels[3]?.port2);
    expect(secondWorker.messages[0]?.transfer).toEqual([
      h.channels[3]?.port2,
      h.channels[2]?.port1,
    ]);

    emitDecoderReady(secondWorker);
    emitPrimed(h.node, 2);
    await expect(seeking).resolves.toMatchObject({ phase: 'paused', positionSeconds: 1 });

    await h.source.destroy();
    await h.source.destroy();
    expect(secondWorker.terminateCount).toBe(1);
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
  });

  it('serves an exclusive-EOF seek only after the Worklet-side PCM demand', async () => {
    const h = harness();
    await prepare(h);
    await arm(h);
    const firstWorker = h.workers[0];
    if (!firstWorker) throw new Error('Expected first MP3 worker');

    const seeking = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-mp3-stream-1',
      revision: 1,
      positionSeconds: TOTAL_MEDIA_FRAMES / HEADER.sampleRateHz,
      atRoomTimeMs: 1_000,
    });
    await vi.waitFor(() => expect(h.channels).toHaveLength(3));

    expect(h.workers).toHaveLength(1);
    await vi.waitFor(() => expect(firstWorker.terminateCount).toBe(1));
    const eofPort = h.channels[2]?.port1;
    if (!eofPort) throw new Error('Expected exclusive EOF PCM port');
    expect(eofPort.messages).toHaveLength(0);
    eofPort.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'need',
      generation: 2,
      maxFrames: 1,
    });
    expect(eofPort.messages.map(({ message }) => message)).toEqual([
      { protocolVersion: PCM_STREAM_PROTOCOL_VERSION, type: 'eof', generation: 2 },
    ]);

    emitPrimed(h.node, 2);
    const snapshot = await seeking;
    expect(snapshot.phase).toBe('paused');
    expect(snapshot.positionSeconds).toBeCloseTo(TOTAL_MEDIA_FRAMES / HEADER.sampleRateHz, 4);
    await h.source.destroy();
    expect(eofPort.closeCount).toBeGreaterThan(0);
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
  });
});

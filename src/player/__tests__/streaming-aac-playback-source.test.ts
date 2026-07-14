import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  AAC_DECODER_PROTOCOL_VERSION,
  type AacDecoderCommand,
  type AacDecoderEvent,
  type AacDecoderOpenCommand,
} from '../aac/decoder-protocol.ts';
import {
  createAdtsDecoderTimelineEvidenceFromScanResult,
  type AdtsDecoderTimelineEvidence,
} from '../aac/decoder-timeline-evidence.ts';
import { scanAdtsFrames, type AdtsFrameScanResult } from '../aac/frame-scanner.ts';
import { StreamingAacPlaybackSource } from '../backends/streaming-aac-playback-source.ts';
import type { RendezvousArmIntent } from '../rendezvous-contract.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';
import type { BoundedStreamingCodecRuntime } from '../streaming/bounded-codec-runtime.ts';
import {
  PCM_STREAM_PROTOCOL_VERSION,
  type PcmRingCommand,
  type PcmRingEvent,
} from '../streaming/pcm-stream-protocol.ts';

const QID = '00000000-0000-4000-8000-000000000601' as QueueItemId;
const SOURCE_IDENTITY = 'source:streaming-adts-aac-wrapper';
const OUTPUT_RATE = 48_000;
const CORE_RATE = 44_100;
const CHANNELS = 2;
const FRAME_BYTES = 31;
const FRAME_COUNT = 100;
let fixtureBytes: Uint8Array;
let scan: Readonly<AdtsFrameScanResult>;

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
  readonly messages: Array<{ message: AacDecoderCommand; transfer: readonly Transferable[] }> = [];
  terminateCount = 0;

  postMessage(message: AacDecoderCommand, transfer: readonly Transferable[] = []): void {
    this.messages.push({ message, transfer });
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: AacDecoderEvent): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

class FakeAudioWorkletNode extends FakeAudioNode {
  readonly port = new FakeMessagePort();
  onprocessorerror: ((event: Event) => void) | null = null;
}

interface HarnessOptions {
  readonly useDefaultWorker?: boolean;
  readonly timelineEvidence?: Readonly<AdtsDecoderTimelineEvidence>;
}

function makeAdtsFrame(): Uint8Array {
  const bytes = new Uint8Array(FRAME_BYTES).fill(0x5a);
  const profile = 1;
  const sampleRateIndex = 4;
  const channelConfiguration = CHANNELS;
  bytes[0] = 0xff;
  bytes[1] = 0xf1;
  bytes[2] = (profile << 6) | (sampleRateIndex << 2) | ((channelConfiguration >>> 2) & 1);
  bytes[3] = ((channelConfiguration & 0b11) << 6) | ((FRAME_BYTES >>> 11) & 0b11);
  bytes[4] = (FRAME_BYTES >>> 3) & 0xff;
  bytes[5] = ((FRAME_BYTES & 0b111) << 5) | 0b1_1111;
  bytes[6] = 0b1111_1100;
  return bytes;
}

function repeatFrame(frame: Uint8Array, count: number): Uint8Array {
  const bytes = new Uint8Array(frame.byteLength * count);
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    bytes.set(frame, ordinal * frame.byteLength);
  }
  return bytes;
}

function encodedSource(
  close: () => Promise<void>,
  readAt: EncodedAudioSource['readAt'],
): EncodedAudioSource {
  return {
    kind: 'blob',
    size: fixtureBytes.byteLength,
    identity: SOURCE_IDENTITY,
    metadata: { name: 'fixture.aac', mime: 'audio/aac' },
    readAt,
    close,
  };
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
  const readAt = vi.fn(async (offset: number, length: number) =>
    fixtureBytes.slice(offset, offset + length),
  );
  const source = encodedSource(closeEncodedSource, readAt);
  const loadWorklet = vi.fn(async () => undefined);
  const createWorker = vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const createWorkletNode = vi.fn(
    (_context: AudioContext, name: string, workletOptions: AudioWorkletNodeOptions) => {
      expect(name).toBe('musixquare-pcm-ring-v2');
      expect(workletOptions.outputChannelCount).toEqual([CHANNELS]);
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
    encodedSource: source,
    backendId: 'webcodecs',
    audioContext: context as unknown as AudioContext,
    nowRoomTimeMs: () => context.roomNowMs,
    roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
    localPerformanceMsToContextTime: (performanceTimeMs) => performanceTimeMs / 1_000,
    runtime,
  } as const;
  const sourceOwner =
    options.timelineEvidence === undefined
      ? new StreamingAacPlaybackSource({ ...commonOptions, scan })
      : new StreamingAacPlaybackSource({
          ...commonOptions,
          timelineEvidence: options.timelineEvidence,
        });

  return {
    source: sourceOwner,
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

function openCommand(worker: FakeWorker): AacDecoderOpenCommand {
  const command = worker.messages.find(({ message }) => message.type === 'open-decoder')?.message;
  if (!command || command.type !== 'open-decoder') throw new Error('Expected AAC open command');
  return command;
}

function emitDecoderReady(worker: FakeWorker): void {
  const command = openCommand(worker);
  worker.emit({
    protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
    type: 'decoder-ready',
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    descriptor: command.descriptor,
    backendId: command.backendId,
  });
}

function emitPrimed(node: FakeAudioWorkletNode, generation: number): void {
  node.port.emit({
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'primed',
    generation,
    bufferedFrames: 4_096,
    sampleRate: OUTPUT_RATE,
    channels: CHANNELS,
  } satisfies PcmRingEvent);
}

function controlMessages(node: FakeAudioWorkletNode): readonly PcmRingCommand[] {
  return node.port.messages.map(({ message }) => message as PcmRingCommand);
}

function armIntent(): RendezvousArmIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-arm',
    queueItemId: QID,
    runId: 'run-aac-stream-1',
    revision: 1,
    rendezvousId: 'rv-aac-stream-1',
    recipientId: 'peer-1',
    positionSeconds: 0,
    playbackRate: 1,
    startAtRoomTimeMs: 2_000,
    finalizeByRoomTimeMs: 1_800,
  };
}

async function waitForWorkerOpen(
  h: ReturnType<typeof harness>,
  index: number,
): Promise<FakeWorker> {
  await vi.waitFor(() => expect(h.workers[index]?.messages[0]?.message.type).toBe('open-decoder'));
  const worker = h.workers[index];
  if (!worker) throw new Error('Expected AAC Worker realm');
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

beforeAll(async () => {
  fixtureBytes = repeatFrame(makeAdtsFrame(), FRAME_COUNT);
  scan = await scanAdtsFrames(
    encodedSource(
      async () => undefined,
      async (offset, length) => fixtureBytes.slice(offset, offset + length),
    ),
    new AbortController().signal,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  fixtureBytes.fill(0);
});

describe('StreamingAacPlaybackSource', () => {
  it('requires exactly one timeline input at the wrapper boundary', () => {
    const invalidSource = encodedSource(
      async () => undefined,
      async (offset, length) => fixtureBytes.slice(offset, offset + length),
    );
    const commonOptions = {
      queueItemId: QID,
      encodedSource: invalidSource,
      backendId: 'webcodecs',
      audioContext: new FakeAudioContext() as unknown as AudioContext,
      nowRoomTimeMs: () => 1_000,
      roomTimeMsToContextTime: (roomTimeMs: number) => roomTimeMs / 1_000,
      localPerformanceMsToContextTime: (performanceTimeMs: number) => performanceTimeMs / 1_000,
    };

    expect(() => new StreamingAacPlaybackSource(commonOptions as never)).toThrow(/exactly one/i);
    expect(
      () =>
        new StreamingAacPlaybackSource({
          ...commonOptions,
          scan,
          timelineEvidence: createAdtsDecoderTimelineEvidenceFromScanResult(scan),
        } as never),
    ).toThrow(/exactly one/i);
  });

  it('passes normalized timeline evidence to the same bounded decoder path', async () => {
    const legacy = harness();
    const normalized = harness({
      timelineEvidence: createAdtsDecoderTimelineEvidenceFromScanResult(scan),
    });

    await prepare(legacy);
    await prepare(normalized);

    expect(openCommand(normalized.workers[0] as FakeWorker).descriptor).toEqual(
      openCommand(legacy.workers[0] as FakeWorker).descriptor,
    );
    expect(normalized.readAt).not.toHaveBeenCalled();

    await legacy.source.destroy();
    await normalized.source.destroy();
  });

  it('keeps construction inert, rejects a non-WebCodecs cohort, and closes ownership once', async () => {
    const h = harness();

    expect(h.source.backend).toBe('bounded-stream');
    expect(h.source.getSnapshot()).toMatchObject({
      queueItemId: QID,
      backend: 'bounded-stream',
      phase: 'new',
      durationSeconds: scan.totalCoreSamples / scan.coreSampleRateHz,
      outputSampleRateHz: OUTPUT_RATE,
      channelCount: scan.coreChannelCount,
    });
    expect(h.loadWorklet).not.toHaveBeenCalled();
    expect(h.createWorker).not.toHaveBeenCalled();
    expect(h.createWorkletNode).not.toHaveBeenCalled();
    expect(h.createMessageChannel).not.toHaveBeenCalled();
    expect(h.readAt).not.toHaveBeenCalled();

    const rejectedClose = vi.fn(async () => undefined);
    expect(
      () =>
        new StreamingAacPlaybackSource({
          queueItemId: QID,
          encodedSource: encodedSource(rejectedClose, async (offset, length) =>
            fixtureBytes.slice(offset, offset + length),
          ),
          scan,
          backendId: 'symphonia-wasm' as never,
          audioContext: h.context as unknown as AudioContext,
          nowRoomTimeMs: () => h.context.roomNowMs,
          roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
          localPerformanceMsToContextTime: (performanceTimeMs) => performanceTimeMs / 1_000,
        }),
    ).toThrow(/exactly webcodecs/i);
    expect(rejectedClose).not.toHaveBeenCalled();

    await h.source.destroy();
    await h.source.destroy();
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
    expect(h.workers).toHaveLength(0);
  });

  it('uses the AAC module Worker and waits for decoder-ready plus Worklet priming', async () => {
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
      /\/src\/workers\/aac-stream\.worker\.ts$/,
    );
    expect(h.defaultWorkerCalls[0]?.options).toEqual({
      type: 'module',
      name: 'musixquare-aac-stream-v1',
    });
    expect(command.backendId).toBe('webcodecs');
    expect(command.descriptor).toMatchObject({
      format: 'aac-adts',
      sourceIdentity: scan.sourceIdentity,
      sourceSize: scan.sourceSize,
      coreConfiguration: scan.coreConfiguration,
      coreSampleRateHz: scan.coreSampleRateHz,
      channels: scan.coreChannelCount,
      frameCount: scan.frameCount,
      audioEndByteOffset: scan.audioEndByteOffset,
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

  it('uses a fresh Worker and source lease after seek', async () => {
    const h = harness();
    await prepare(h);
    await arm(h);
    const firstWorker = h.workers[0];
    if (!firstWorker) throw new Error('Expected first AAC Worker');
    const first = openCommand(firstWorker);
    const positionSeconds = 1;

    const seeking = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-aac-stream-1',
      revision: 1,
      positionSeconds,
      atRoomTimeMs: 1_000,
    });
    const secondWorker = await waitForWorkerOpen(h, 1);
    const second = openCommand(secondWorker);

    expect(h.createWorker).toHaveBeenCalledTimes(2);
    expect(h.createMessageChannel).toHaveBeenCalledTimes(4);
    expect(firstWorker.terminateCount).toBe(1);
    expect(second.sourceLifetimeGeneration).toBeGreaterThan(first.sourceLifetimeGeneration);
    expect(second.decoderGeneration).toBe(2);
    expect(second.backendId).toBe('webcodecs');
    expect(second.descriptor.startPlan.mediaFrame).toBe(Math.floor(positionSeconds * CORE_RATE));
    expect(second.pcmPort).toBe(h.channels[2]?.port1);
    expect(second.sourcePort).toBe(h.channels[3]?.port2);
    expect(secondWorker.messages[0]?.transfer).toEqual([
      h.channels[3]?.port2,
      h.channels[2]?.port1,
    ]);

    emitDecoderReady(secondWorker);
    emitPrimed(h.node, second.decoderGeneration);
    await expect(seeking).resolves.toMatchObject({ phase: 'paused', positionSeconds });

    await h.source.destroy();
    await h.source.destroy();
    expect(secondWorker.terminateCount).toBe(1);
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
  });

  it('serves exclusive EOF only after Worklet-side PCM demand', async () => {
    const h = harness();
    await prepare(h);
    await arm(h);
    const firstWorker = h.workers[0];
    if (!firstWorker) throw new Error('Expected first AAC Worker');
    const durationSeconds = scan.totalCoreSamples / scan.coreSampleRateHz;

    const seeking = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-aac-stream-1',
      revision: 1,
      positionSeconds: durationSeconds,
      atRoomTimeMs: 1_000,
    });
    await vi.waitFor(() => expect(h.channels).toHaveLength(3));

    expect(h.workers).toHaveLength(1);
    expect(firstWorker.terminateCount).toBe(1);
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
    expect(snapshot.positionSeconds).toBeCloseTo(durationSeconds, 4);
    await h.source.destroy();
    expect(eofPort.closeCount).toBeGreaterThan(0);
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import { StreamingLinearPcmPlaybackSource } from '../backends/streaming-linear-pcm-playback-source.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';
import type { BoundedStreamingCodecRuntime } from '../streaming/bounded-codec-runtime.ts';
import {
  PCM_STREAM_PROTOCOL_VERSION,
  type PcmRingEvent,
} from '../streaming/pcm-stream-protocol.ts';
import type { LinearPcmMetadata } from '../linear-pcm/sample-format.ts';
import {
  LINEAR_PCM_DECODER_PROTOCOL_VERSION,
  type LinearPcmDecoderCommand,
  type LinearPcmDecoderEvent,
} from '../linear-pcm/decoder-protocol.ts';

const QID = '00000000-0000-4000-8000-000000000301' as QueueItemId;
const SOURCE_RATE = 96_000;
const OUTPUT_RATE = 48_000;

class FakeAudioContext {
  currentTime = 1;
  state: AudioContextState = 'running';

  constructor(readonly sampleRate = OUTPUT_RATE) {}
}

class FakeMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  closeCount = 0;
  startCount = 0;
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
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

class FakeMessageChannel {
  readonly port1 = new FakeMessagePort();
  readonly port2 = new FakeMessagePort();
}

class FakeWorker {
  onmessage: ((event: MessageEvent<LinearPcmDecoderEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{
    message: LinearPcmDecoderCommand;
    transfer: readonly Transferable[];
  }> = [];
  autoOpenSource = true;
  terminateCount = 0;

  postMessage(message: LinearPcmDecoderCommand, transfer: readonly Transferable[] = []): void {
    this.messages.push({ message, transfer });
    if (message.type === 'open-source' && this.autoOpenSource) {
      queueMicrotask(() => {
        this.emit({
          protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
          type: 'source-opened',
          sourceLifetimeGeneration: message.sourceLifetimeGeneration,
          sourceSize: message.sourceSize,
          sourceIdentity: message.sourceIdentity,
        });
      });
    }
    if (message.type === 'close-source') {
      queueMicrotask(() => {
        const generations = new Set(
          this.messages.flatMap(({ message: candidate }) =>
            candidate.type === 'init-decoder' ? [candidate.decoderGeneration] : [],
          ),
        );
        for (const decoderGeneration of generations) {
          this.emit({
            protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
            type: 'decoder-retired',
            sourceLifetimeGeneration: message.sourceLifetimeGeneration,
            decoderGeneration,
          });
        }
        this.emit({
          protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
          type: 'source-closed',
          sourceLifetimeGeneration: message.sourceLifetimeGeneration,
        });
        this.emit({
          protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
          type: 'worker-retired',
          sourceLifetimeGeneration: message.sourceLifetimeGeneration,
        });
      });
    }
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: LinearPcmDecoderEvent): void {
    this.onmessage?.({ data: message } as MessageEvent<LinearPcmDecoderEvent>);
  }
}

class FakeAudioWorkletNode {
  readonly port = new FakeMessagePort();
  onprocessorerror: ((event: Event) => void) | null = null;
  disconnectCount = 0;

  constructor(readonly context: FakeAudioContext) {}

  connect(destination: AudioNode): AudioNode {
    return destination;
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

function metadata(): Readonly<LinearPcmMetadata> {
  return Object.freeze({
    encoding: 'pcm-s16be',
    sourceSampleRate: SOURCE_RATE,
    channels: 2,
    containerBitsPerSample: 16,
    validBitsPerSample: 16,
    blockAlign: 4,
    dataOffset: 44,
    dataBytes: 960_000,
    totalSourceFrames: 240_000,
    durationSeconds: 2.5,
    logicalFileBytes: 960_044,
  });
}

interface HarnessOptions {
  readonly useDefaultWorker?: boolean;
  readonly autoOpenSource?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const context = new FakeAudioContext();
  const worker = new FakeWorker();
  worker.autoOpenSource = options.autoOpenSource ?? true;
  const node = new FakeAudioWorkletNode(context);
  const channels: FakeMessageChannel[] = [];
  const closeEncodedSource = vi.fn(async () => undefined);
  const encodedSource: EncodedAudioSource = {
    kind: 'blob',
    size: 960_044,
    identity: 'source:test-streaming-linear-pcm',
    metadata: { name: 'fixture.pcm-container', mime: 'application/octet-stream' },
    readAt: async (offset, length) =>
      Uint8Array.from({ length }, (_value, index) => offset + index),
    close: closeEncodedSource,
  };
  const loadWorklet = vi.fn(async () => undefined);
  const createWorker = vi.fn(() => worker as unknown as Worker);
  const createWorkletNode = vi.fn(
    (_audioContext: AudioContext, name: string, workletOptions: AudioWorkletNodeOptions) => {
      expect(name).toBe('musixquare-pcm-ring-v3');
      expect(workletOptions.outputChannelCount).toEqual([2]);
      return node as unknown as AudioWorkletNode;
    },
  );
  const createMessageChannel = vi.fn(() => {
    const channel = new FakeMessageChannel();
    channels.push(channel);
    return channel as unknown as MessageChannel;
  });
  const defaultWorkerCalls: Array<{
    readonly url: string | URL;
    readonly options: WorkerOptions | undefined;
  }> = [];

  if (options.useDefaultWorker) {
    function WorkerShim(this: unknown, url: string | URL, workerOptions?: WorkerOptions): object {
      defaultWorkerCalls.push({ url, options: workerOptions });
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
  const source = new StreamingLinearPcmPlaybackSource({
    queueItemId: QID,
    encodedSource,
    metadata: metadata(),
    audioContext: context as unknown as AudioContext,
    nowRoomTimeMs: () => 1_000,
    roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
    localPerformanceMsToContextTime: (performanceTimeMs) => performanceTimeMs / 1_000,
    runtime,
  });

  return {
    source,
    worker,
    node,
    channels,
    closeEncodedSource,
    loadWorklet,
    createWorker,
    createWorkletNode,
    createMessageChannel,
    defaultWorkerCalls,
  };
}

function openCommand(worker: FakeWorker) {
  const command = worker.messages.find(({ message }) => message.type === 'open-source')?.message;
  if (!command || command.type !== 'open-source') throw new Error('Expected source-open command');
  return command;
}

function initCommand(worker: FakeWorker) {
  const command = worker.messages.find(({ message }) => message.type === 'init-decoder')?.message;
  if (!command || command.type !== 'init-decoder') throw new Error('Expected decoder init command');
  return command;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StreamingLinearPcmPlaybackSource', () => {
  it('exposes bounded linear-PCM media info while keeping construction inert', async () => {
    const h = harness();

    expect(h.source.backend).toBe('bounded-stream');
    expect(h.source.getSnapshot()).toMatchObject({
      queueItemId: QID,
      backend: 'bounded-stream',
      phase: 'new',
      durationSeconds: 2.5,
      outputSampleRateHz: OUTPUT_RATE,
      channelCount: 2,
      errorCode: null,
    });
    expect(h.loadWorklet).not.toHaveBeenCalled();
    expect(h.createWorker).not.toHaveBeenCalled();
    expect(h.createWorkletNode).not.toHaveBeenCalled();
    expect(h.createMessageChannel).not.toHaveBeenCalled();
    expect(h.closeEncodedSource).not.toHaveBeenCalled();

    await h.source.destroy();
    await h.source.destroy();
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
    expect(h.worker.terminateCount).toBe(0);
  });

  it('opens the shared default worker and shares one channel factory across both runtime layers', async () => {
    const h = harness({ useDefaultWorker: true });
    const preparing = h.source.prepare();

    await vi.waitFor(() =>
      expect(h.worker.messages.some(({ message }) => message.type === 'init-decoder')).toBe(true),
    );
    const opened = openCommand(h.worker);
    const init = initCommand(h.worker);
    expect(init.descriptor).toMatchObject({
      format: 'linear-pcm',
      encoding: 'pcm-s16be',
      dataOffset: 44,
      dataBytes: 960_000,
      sourceSampleRate: SOURCE_RATE,
      outputSampleRate: OUTPUT_RATE,
      channels: 2,
    });
    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'decoder-ready',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: init.decoderGeneration,
      descriptor: init.descriptor,
    });
    h.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'primed',
      generation: init.decoderGeneration,
      bufferedFrames: 192_000,
      sampleRate: OUTPUT_RATE,
      channels: 2,
    });

    await expect(preparing).resolves.toMatchObject({ phase: 'ready' });
    expect(h.defaultWorkerCalls).toHaveLength(1);
    expect(String(h.defaultWorkerCalls[0]?.url).replaceAll('\\', '/')).toMatch(
      /\/src\/workers\/linear-pcm-stream\.worker\.ts$/,
    );
    expect(h.defaultWorkerCalls[0]?.options).toEqual({
      type: 'module',
      name: 'musixquare-linear-pcm-stream-v1',
    });
    expect(h.channels).toHaveLength(2);
    expect(opened.sourcePort).toBe(h.channels[0]?.port2);
    expect(h.worker.messages[0]?.transfer).toEqual([h.channels[0]?.port2]);

    const bind = h.node.port.messages.find(
      ({ message }) =>
        message !== null &&
        typeof message === 'object' &&
        (message as Record<string, unknown>).type === 'bind-pcm-port',
    )?.message as { readonly port?: unknown } | undefined;
    expect(bind?.port).toBe(h.channels[1]?.port2);
    expect(init.pcmPort).toBe(h.channels[1]?.port1);
    expect(h.createMessageChannel).toHaveBeenCalledTimes(2);

    await h.source.destroy();
    expect(h.worker.terminateCount).toBe(1);
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
  });

  it('cleans failed source-open ownership exactly once', async () => {
    const h = harness({ autoOpenSource: false });
    const preparing = h.source.prepare();
    const rejected = expect(preparing).rejects.toThrow(/source-open acknowledgement mismatch/i);

    await vi.waitFor(() =>
      expect(h.worker.messages.some(({ message }) => message.type === 'open-source')).toBe(true),
    );
    const opened = openCommand(h.worker);
    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'source-opened',
      sourceLifetimeGeneration: opened.sourceLifetimeGeneration,
      sourceSize: opened.sourceSize + 1,
      sourceIdentity: `${opened.sourceIdentity}:mismatch`,
    });

    await rejected;
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'failed',
      errorCode: 'decoder-source-open-mismatch',
    });
    expect(h.worker.terminateCount).toBe(1);
    expect(h.createWorkletNode).not.toHaveBeenCalled();
    expect(h.channels).toHaveLength(1);
    await vi.waitFor(() => expect(h.closeEncodedSource).toHaveBeenCalledTimes(1));
    expect(h.channels[0]?.port1.closeCount).toBeGreaterThan(0);
    expect(h.channels[0]?.port2.closeCount).toBe(0);

    await h.source.destroy();
    await h.source.destroy();
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
    expect(h.worker.terminateCount).toBe(1);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { EncodedAudioSource } from '../../sources/encoded-audio-source.ts';
import type { StreamingDecoderOpenOptions } from '../../streaming/decoder-adapter.ts';
import { PCM_STREAM_PROTOCOL_VERSION } from '../../streaming/pcm-stream-protocol.ts';
import { AacDecoderAdapter } from '../decoder-adapter.ts';
import { createAacDecoderDescriptor, expectedAacOutputFrames } from '../decoder-helpers.ts';
import {
  AAC_DECODER_PROTOCOL_VERSION,
  type AacDecoderBackendId,
  type AacDecoderCommand,
  type AacDecoderEvent,
  type AacDecoderOpenCommand,
} from '../decoder-protocol.ts';
import type { AdtsFrameScanResult } from '../frame-scanner.ts';
import type { AdtsCoreConfiguration } from '../incremental-frame-reader.ts';

class FakeMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly messages: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
  closeCount = 0;
  startCount = 0;
  onStart: (() => void) | null = null;
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
    this.onStart?.();
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
  #onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{ message: AacDecoderCommand; transfer: readonly Transferable[] }> = [];
  throwOnOpen = false;
  onOpenPost: ((command: AacDecoderOpenCommand) => void) | null = null;
  onMessageSet: ((handler: (event: MessageEvent<unknown>) => void) => void) | null = null;
  terminateCount = 0;

  get onmessage(): ((event: MessageEvent<unknown>) => void) | null {
    return this.#onmessage;
  }

  set onmessage(value: ((event: MessageEvent<unknown>) => void) | null) {
    this.#onmessage = value;
    if (value) this.onMessageSet?.(value);
  }

  postMessage(message: AacDecoderCommand, transfer: readonly Transferable[] = []): void {
    if (message.type === 'open-decoder' && this.throwOnOpen) {
      throw new Error('failed open-decoder transfer');
    }
    this.messages.push({ message, transfer });
    if (message.type === 'open-decoder') this.onOpenPost?.(message);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: AacDecoderEvent): void {
    this.emitUnknown(message);
  }

  emitUnknown(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

const SOURCE_IDENTITY = 'source:aac-decoder-adapter-test';
const FRAME_BYTES = 100;
const FRAME_COUNT = 12;
const TOTAL_FRAMES = FRAME_COUNT * 1_024;
const SOURCE_SIZE = FRAME_COUNT * FRAME_BYTES;
const CORE_CONFIGURATION: Readonly<AdtsCoreConfiguration> = Object.freeze({
  mpegId: 0,
  profile: 1,
  coreAudioObjectType: 2,
  sampleRateIndex: 4,
  channelConfiguration: 2,
  protectionAbsent: true,
  rawDataBlocks: 1,
});

function scanFixture(
  patch: Readonly<Partial<AdtsFrameScanResult>> = {},
): Readonly<AdtsFrameScanResult> {
  return Object.freeze({
    sourceIdentity: SOURCE_IDENTITY,
    sourceSize: SOURCE_SIZE,
    coreConfiguration: CORE_CONFIGURATION,
    coreSampleRateHz: 44_100,
    coreChannelCount: 2 as const,
    samplesPerFrame: 1_024,
    frameCount: FRAME_COUNT,
    totalCoreSamples: TOTAL_FRAMES,
    audioEndByteOffset: SOURCE_SIZE,
    seekPoints: Object.freeze([
      Object.freeze({ frameOrdinal: 0, byteOffset: 0 }),
      Object.freeze({ frameOrdinal: 4, byteOffset: 4 * FRAME_BYTES }),
      Object.freeze({ frameOrdinal: FRAME_COUNT - 1, byteOffset: (FRAME_COUNT - 1) * FRAME_BYTES }),
    ]),
    fullyVerifiedFrameSpan: true as const,
    ...patch,
  });
}

function harness(backendId: AacDecoderBackendId = 'webcodecs') {
  const workers: FakeWorker[] = [];
  const channels: FakeMessageChannel[] = [];
  const closeSource = vi.fn(async () => undefined);
  const readAt = vi.fn(async (_offset: number, length: number) => new Uint8Array(length));
  const source: EncodedAudioSource = {
    kind: 'blob',
    size: SOURCE_SIZE,
    identity: SOURCE_IDENTITY,
    metadata: { name: 'fixture.aac', mime: 'audio/aac' },
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
  const adapter = new AacDecoderAdapter({
    encodedSource: source,
    scan: scanFixture(),
    backendId,
    runtime: { createWorker, createMessageChannel },
  });
  return {
    adapter,
    source,
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

function openCommand(worker: FakeWorker): AacDecoderOpenCommand {
  const command = worker.messages.find(({ message }) => message.type === 'open-decoder')?.message;
  if (!command || command.type !== 'open-decoder') throw new Error('Expected open-decoder command');
  return command;
}

function ready(
  command: AacDecoderOpenCommand,
  backendId: AacDecoderBackendId = command.backendId,
): AacDecoderEvent {
  return {
    protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
    type: 'decoder-ready',
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    descriptor: command.descriptor,
    backendId,
  };
}

function progress(
  command: AacDecoderOpenCommand,
  patch: Readonly<
    Partial<Extract<AacDecoderEvent, { readonly type: 'decode-progress' | 'decoder-eof' }>>
  > = {},
): AacDecoderEvent {
  return {
    protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
    type: 'decode-progress',
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    decodedInputBytes: command.descriptor.startPlan.scanAnchorByteOffset,
    decodedCoreFrames: command.descriptor.startPlan.decodeStartAccessUnitOrdinal * 1_024,
    producedOutputFrames: 0,
    ...patch,
  };
}

describe('AacDecoderAdapter', () => {
  it('keeps construction/open inert, binds scan identity, and closes source exactly once', async () => {
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
    const firstClose = h.adapter.close();
    expect(h.adapter.close()).toBe(firstClose);
    await firstClose;
    expect(h.closeSource).toHaveBeenCalledTimes(1);

    const foreignClose = vi.fn(async () => undefined);
    expect(
      () =>
        new AacDecoderAdapter({
          encodedSource: { ...h.source, identity: 'source:foreign', close: foreignClose },
          scan: scanFixture(),
          backendId: 'webcodecs',
          runtime: { createWorker: h.createWorker, createMessageChannel: h.createMessageChannel },
        }),
    ).toThrow(/different encoded source/i);
    expect(foreignClose).not.toHaveBeenCalled();
  });

  it('uses fresh pinned-backend realms and preserves exact control EOF until successor retirement', async () => {
    const h = harness('webcodecs');
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const target = 9 * 1_024 + 17;

    const firstPending = h.adapter.startGeneration(request(1, target, new FakeMessagePort()));
    const firstWorker = h.workers[0];
    const firstChannel = h.channels[0];
    if (!firstWorker || !firstChannel) throw new Error('Expected first AAC realm');
    const first = openCommand(firstWorker);
    expect(first.backendId).toBe('webcodecs');
    expect(first.sourcePort).toBe(firstChannel.port2);
    expect(firstWorker.messages[0]?.transfer).toEqual([firstChannel.port2, first.pcmPort]);
    firstWorker.emit(ready(first));
    await firstPending;

    firstWorker.emit(
      progress(first, {
        type: 'decoder-eof',
        decodedInputBytes: first.descriptor.audioEndByteOffset,
        decodedCoreFrames: first.descriptor.timeline.totalMediaFrames,
        producedOutputFrames: expectedAacOutputFrames(first.descriptor),
      }),
    );
    expect(firstWorker.terminateCount).toBe(0);

    const secondPending = h.adapter.startGeneration(request(2, target, new FakeMessagePort()));
    const secondWorker = h.workers[1];
    if (!secondWorker) throw new Error('Expected second AAC realm');
    const second = openCommand(secondWorker);
    expect(second.sourceLifetimeGeneration).toBeGreaterThan(first.sourceLifetimeGeneration);
    expect(second.backendId).toBe('webcodecs');
    expect(firstWorker.terminateCount).toBe(1);
    firstWorker.emitUnknown({ stale: true });
    expect(fatal).not.toHaveBeenCalled();
    secondWorker.emit(ready(second));
    await secondPending;
    await h.adapter.close();
  });

  it('preflights descriptor arithmetic before retiring the active realm or accepting the PCM port', async () => {
    const frameCount = Math.floor(Number.MAX_SAFE_INTEGER / 1_024);
    const totalFrames = frameCount * 1_024;
    const sourceSize = frameCount * 8;
    const identity = 'source:aac-descriptor-preflight';
    const closeSource = vi.fn(async () => undefined);
    const source: EncodedAudioSource = {
      kind: 'blob',
      size: sourceSize,
      identity,
      metadata: { name: 'huge.aac', mime: 'audio/aac' },
      readAt: vi.fn(async (_offset: number, length: number) => new Uint8Array(length)),
      close: closeSource,
    };
    const scan: AdtsFrameScanResult = {
      sourceIdentity: identity,
      sourceSize,
      coreConfiguration: {
        ...CORE_CONFIGURATION,
        sampleRateIndex: 11,
      },
      coreSampleRateHz: 8_000,
      coreChannelCount: 2,
      samplesPerFrame: 1_024,
      frameCount,
      totalCoreSamples: totalFrames,
      audioEndByteOffset: sourceSize,
      seekPoints: [
        { frameOrdinal: 0, byteOffset: 0 },
        { frameOrdinal: frameCount - 1, byteOffset: (frameCount - 1) * 8 },
      ],
      fullyVerifiedFrameSpan: true,
    };
    const workers: FakeWorker[] = [];
    const channels: FakeMessageChannel[] = [];
    const adapter = new AacDecoderAdapter({
      encodedSource: source,
      scan,
      backendId: 'webcodecs',
      runtime: {
        createWorker: () => {
          const worker = new FakeWorker();
          workers.push(worker);
          return worker as unknown as Worker;
        },
        createMessageChannel: () => {
          const channel = new FakeMessageChannel();
          channels.push(channel);
          return channel as unknown as MessageChannel;
        },
      },
    });
    await adapter.open(options());
    const activePort = new FakeMessagePort();
    const activePending = adapter.startGeneration({
      generation: 20,
      targetMediaFrame: 0,
      outputSampleRateHz: 8_000,
      pcmPort: activePort as unknown as MessagePort,
      signal: new AbortController().signal,
    });
    const activeWorker = workers[0];
    if (!activeWorker) throw new Error('Expected active preflight realm');
    const activeCommand = openCommand(activeWorker);
    activeWorker.emit(ready(activeCommand));
    await activePending;

    const rejectedPort = new FakeMessagePort();
    await expect(
      adapter.startGeneration({
        generation: 21,
        targetMediaFrame: 0,
        outputSampleRateHz: 1_000_000,
        pcmPort: rejectedPort as unknown as MessagePort,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/safe-integer range/i);
    expect(workers).toHaveLength(1);
    expect(activeWorker.terminateCount).toBe(0);
    expect(rejectedPort.closeCount).toBe(0);

    adapter.stopGeneration(20);
    await adapter.close();
    expect(closeSource).toHaveBeenCalledTimes(1);
  });

  it('fails closed on backend echo mismatch without falling back or opening another realm', async () => {
    const h = harness('webcodecs');
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const pending = h.adapter
      .startGeneration(request(3, 0, new FakeMessagePort()))
      .catch((error: unknown) => error);
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected AAC realm');
    const command = openCommand(worker);

    worker.emit(ready(command, 'symphonia-wasm'));

    await expect(pending).resolves.toBeInstanceOf(Error);
    expect(worker.terminateCount).toBe(1);
    expect(h.createWorker).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith('decoder-backend-mismatch', expect.any(Error));
    await h.adapter.close();
  });

  it('enforces whole-AU monotonic progress and exact terminal counters', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const pending = h.adapter.startGeneration(request(4, 0, new FakeMessagePort()));
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected AAC realm');
    const command = openCommand(worker);
    worker.emit(ready(command));
    await pending;

    worker.emit(
      progress(command, {
        decodedInputBytes: FRAME_BYTES,
        decodedCoreFrames: 1_024,
        producedOutputFrames: 1_114,
      }),
    );
    expect(fatal).not.toHaveBeenCalled();
    worker.emit(
      progress(command, {
        decodedInputBytes: FRAME_BYTES * 2,
        decodedCoreFrames: 1_025,
        producedOutputFrames: 1_115,
      }),
    );
    expect(fatal).toHaveBeenCalledWith('decoder-invalid-progress', expect.any(Error));
    expect(worker.terminateCount).toBe(1);
    await h.adapter.close();
  });

  it('serves exclusive EOF locally after one exact demand and keeps it until explicit stop', async () => {
    const h = harness();
    await h.adapter.open(options());
    const port = new FakeMessagePort();
    await h.adapter.startGeneration(request(5, TOTAL_FRAMES, port));
    expect(h.workers).toHaveLength(0);
    expect(h.channels).toHaveLength(0);

    port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'need',
      generation: 5,
      maxFrames: 1,
    });
    expect(port.messages.map(({ message }) => message)).toEqual([
      { protocolVersion: PCM_STREAM_PROTOCOL_VERSION, type: 'eof', generation: 5 },
    ]);
    expect(port.closeCount).toBe(0);
    h.adapter.stopGeneration(5);
    expect(port.closeCount).toBe(1);
    await h.adapter.close();
  });

  it('rejects local EOF if port start reentrantly closes the adapter', async () => {
    const h = harness();
    await h.adapter.open(options());
    const port = new FakeMessagePort();
    port.onStart = () => {
      void h.adapter.close();
    };

    await expect(h.adapter.startGeneration(request(50, TOTAL_FRAMES, port))).rejects.toThrow(
      /adapter was closed/i,
    );
    expect(port.closeCount).toBe(1);
    expect(h.workers).toHaveLength(0);
  });

  it('gives an EOF start abort exact precedence over a later injected port error', async () => {
    const h = harness();
    await h.adapter.open(options());
    const controller = new AbortController();
    const reason = Object.freeze({ code: 'eof-start-abort' });
    const port = new FakeMessagePort();
    port.onStart = () => {
      controller.abort(reason);
      throw new Error('later port failure');
    };

    await expect(
      h.adapter
        .startGeneration(request(51, TOTAL_FRAMES, port, controller.signal))
        .catch((error: unknown) => error),
    ).resolves.toBe(reason);
    expect(port.closeCount).toBe(1);
    await h.adapter.close();
  });

  it('rejects with the exact abort reason and ignores retired realm callbacks', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const controller = new AbortController();
    const pending = h.adapter
      .startGeneration(request(6, 0, new FakeMessagePort(), controller.signal))
      .catch((error: unknown) => error);
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected abortable AAC realm');
    const reason = Object.freeze({ code: 'seek-replaced' });
    controller.abort(reason);

    await expect(pending).resolves.toBe(reason);
    expect(worker.terminateCount).toBe(1);
    worker.emitUnknown({ malformed: true });
    expect(fatal).not.toHaveBeenCalled();
    await h.adapter.close();
  });

  it('preserves the exact lifetime abort reason for a pending generation', async () => {
    const h = harness();
    const lifetime = new AbortController();
    await h.adapter.open(options({ lifetimeSignal: lifetime.signal }));
    const pending = h.adapter
      .startGeneration(request(8, 0, new FakeMessagePort()))
      .catch((error: unknown) => error);
    const reason = Object.freeze({ code: 'source-lifetime-ended' });

    lifetime.abort(reason);

    await expect(pending).resolves.toBe(reason);
    expect(h.workers[0]?.terminateCount).toBe(1);
    expect(h.closeSource).toHaveBeenCalledTimes(1);
  });

  it('defers retirement across a reentrant postMessage abort without reclaiming transferred ports', async () => {
    const h = harness();
    const controller = new AbortController();
    const reason = Object.freeze({ code: 'abort-during-transfer' });
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.onOpenPost = () => controller.abort(reason);
      h.workers.push(worker);
      return worker as unknown as Worker;
    });
    await h.adapter.open(options());
    const pcm = new FakeMessagePort();

    await expect(
      h.adapter
        .startGeneration(request(30, 0, pcm, controller.signal))
        .catch((error: unknown) => error),
    ).resolves.toBe(reason);

    expect(h.workers[0]?.terminateCount).toBe(1);
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(0);
    expect(pcm.closeCount).toBe(0);
    await h.adapter.close();
  });

  it('does not publish a reentrant ready event when the same postMessage aborts', async () => {
    const h = harness();
    const controller = new AbortController();
    const reason = Object.freeze({ code: 'ready-then-abort' });
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.onOpenPost = (command) => {
        worker.emit(ready(command));
        controller.abort(reason);
      };
      h.workers.push(worker);
      return worker as unknown as Worker;
    });
    await h.adapter.open(options());

    await expect(
      h.adapter
        .startGeneration(request(31, 0, new FakeMessagePort(), controller.signal))
        .catch((error: unknown) => error),
    ).resolves.toBe(reason);
    expect(h.workers[0]?.terminateCount).toBe(1);
    await h.adapter.close();
  });

  it('fails setup if an injected runtime closes the adapter before realm publication', async () => {
    const h = harness();
    await h.adapter.open(options());
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      h.workers.push(worker);
      void h.adapter.close();
      return worker as unknown as Worker;
    });
    const pcm = new FakeMessagePort();

    await expect(h.adapter.startGeneration(request(32, 0, pcm))).rejects.toThrow(
      /adapter was closed/i,
    );
    expect(h.workers[0]?.messages).toHaveLength(0);
    expect(h.workers[0]?.terminateCount).toBe(1);
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(1);
    expect(pcm.closeCount).toBe(1);
    expect(h.closeSource).toHaveBeenCalledTimes(1);
  });

  it('rejects a guessed ready event emitted by an injected Worker setter before open posting', async () => {
    const h = harness();
    const fatal = vi.fn();
    const descriptor = createAacDecoderDescriptor({
      scan: scanFixture(),
      outputSampleRateHz: 48_000,
      mediaFrame: 0,
    });
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.onMessageSet = (handler) => {
        handler({
          data: {
            protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
            type: 'decoder-ready',
            sourceLifetimeGeneration: 1,
            decoderGeneration: 33,
            descriptor,
            backendId: 'webcodecs',
          },
        } as MessageEvent<unknown>);
      };
      h.workers.push(worker);
      return worker as unknown as Worker;
    });
    await h.adapter.open(options({ onFatal: fatal }));
    const pcm = new FakeMessagePort();

    await expect(
      h.adapter.startGeneration(request(33, 0, pcm)).catch((error: unknown) => error),
    ).resolves.toBeInstanceOf(Error);
    expect(h.workers[0]?.messages).toHaveLength(0);
    expect(h.workers[0]?.terminateCount).toBe(1);
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(1);
    expect(pcm.closeCount).toBe(1);
    expect(fatal).toHaveBeenCalledWith('decoder-invalid-event', expect.any(Error));
    await h.adapter.close();
  });

  it('publishes one stable close Promise before source cleanup can re-enter', async () => {
    let adapter!: AacDecoderAdapter;
    let reentrantClose: Promise<void> | null = null;
    const closeSource = vi.fn(() => {
      reentrantClose = adapter.close();
      return Promise.resolve();
    });
    const source: EncodedAudioSource = {
      kind: 'blob',
      size: SOURCE_SIZE,
      identity: SOURCE_IDENTITY,
      metadata: { name: 'fixture.aac', mime: 'audio/aac' },
      readAt: async (_offset, length) => new Uint8Array(length),
      close: closeSource,
    };
    adapter = new AacDecoderAdapter({
      encodedSource: source,
      scan: scanFixture(),
      backendId: 'webcodecs',
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

  it('closes every untransferred endpoint when the atomic Worker handoff throws', async () => {
    const h = harness();
    await h.adapter.open(options());
    const pcm = new FakeMessagePort();
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.throwOnOpen = true;
      h.workers.push(worker);
      return worker as unknown as Worker;
    });

    await expect(h.adapter.startGeneration(request(7, 0, pcm))).rejects.toThrow(
      /open-decoder transfer/i,
    );
    expect(h.workers[0]?.terminateCount).toBe(1);
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(1);
    expect(pcm.closeCount).toBe(1);
    await h.adapter.close();
  });
});

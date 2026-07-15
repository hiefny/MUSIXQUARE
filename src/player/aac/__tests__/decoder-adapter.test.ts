import { describe, expect, it, vi } from 'vitest';

import { getFilePlaybackUniversalLifecycleSnapshotForTests as getFilePlaybackUniversalLifecycleSnapshot } from '../../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import type { EncodedAudioSource } from '../../sources/encoded-audio-source.ts';
import { EncodedAudioSourceLease } from '../../sources/encoded-audio-source-lifetime.ts';
import type { StreamingDecoderOpenOptions } from '../../streaming/decoder-adapter.ts';
import { PCM_STREAM_PROTOCOL_VERSION } from '../../streaming/pcm-stream-protocol.ts';
import { AacDecoderAdapter } from '../decoder-adapter.ts';
import { createAacDecoderDescriptor, expectedAacOutputFrames } from '../decoder-helpers.ts';
import { createAdtsDecoderTimelineEvidence } from '../decoder-timeline-evidence.ts';
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
    if (this.throwOnClose) throw new Error('failed AAC port close');
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
  throwOnTerminate = false;
  autoRetire = true;
  onOpenPost: ((command: AacDecoderOpenCommand) => void) | null = null;
  onMessageSet: ((handler: (event: MessageEvent<unknown>) => void) => void) | null = null;
  onMessageSetBeforeCommit = false;
  terminateCount = 0;

  get onmessage(): ((event: MessageEvent<unknown>) => void) | null {
    return this.#onmessage;
  }

  set onmessage(value: ((event: MessageEvent<unknown>) => void) | null) {
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

  postMessage(message: AacDecoderCommand, transfer: readonly Transferable[] = []): void {
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
          retryWaitSequence: 0,
          activeRetryWaits: 0,
        });
      });
    }
  }

  terminate(): void {
    this.terminateCount += 1;
    if (this.throwOnTerminate) throw new Error('failed AAC Worker termination');
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
    audioStartByte: 0,
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

function timelineEvidenceFixture() {
  const scan = scanFixture();
  return createAdtsDecoderTimelineEvidence({
    format: 'adts-decoder-timeline',
    authority: 'none',
    sourceIdentity: scan.sourceIdentity,
    sourceSize: scan.sourceSize,
    audioStartByte: scan.audioStartByte,
    coreConfiguration: scan.coreConfiguration,
    coreSampleRateHz: scan.coreSampleRateHz,
    coreChannelCount: scan.coreChannelCount,
    samplesPerFrame: scan.samplesPerFrame,
    frameCount: scan.frameCount,
    audioEndByteOffset: scan.audioEndByteOffset,
    timeline: {
      frameCount: scan.frameCount,
      coreFramesPerAccessUnit: 1_024,
      totalMediaFrames: scan.totalCoreSamples,
    },
    seekPoints: scan.seekPoints,
  });
}

function harness(
  backendId: AacDecoderBackendId = 'webcodecs',
  planningKind: 'scan' | 'timeline-evidence' = 'scan',
) {
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
  const adapter =
    planningKind === 'scan'
      ? new AacDecoderAdapter({
          encodedSource: source,
          scan: scanFixture(),
          backendId,
          runtime: { createWorker, createMessageChannel },
        })
      : new AacDecoderAdapter({
          encodedSource: source,
          timelineEvidence: timelineEvidenceFixture(),
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
    acceptPcmPortOwnership: vi.fn(),
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

function acknowledgeRetirement(worker: FakeWorker): void {
  const command = worker.messages.find(({ message }) => message.type === 'stop-decoder')?.message;
  if (!command || command.type !== 'stop-decoder') throw new Error('Expected stop-decoder command');
  worker.emit({ ...command, type: 'decoder-stopped' });
  worker.emit({ ...command, type: 'decoder-retired' });
  worker.emit({
    ...command,
    type: 'worker-retired',
    retryWaitSequence: 0,
    activeRetryWaits: 0,
  });
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

  it('accepts normalized timeline evidence with identical source binding and realm planning', async () => {
    const h = harness('webcodecs', 'timeline-evidence');
    expect(h.adapter.info).toEqual({
      mediaSampleRateHz: 44_100,
      channelCount: 2,
      totalMediaFrames: TOTAL_FRAMES,
    });
    expect(h.readAt).not.toHaveBeenCalled();

    await h.adapter.open(options());
    const target = 5 * 1_024 + 29;
    const generationRequest = request(80, target, new FakeMessagePort());
    const pending = h.adapter.startGeneration(generationRequest);
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected evidence-backed AAC realm');
    const command = openCommand(worker);
    expect(command.descriptor).toEqual(
      createAacDecoderDescriptor({
        scan: scanFixture(),
        outputSampleRateHz: 48_000,
        mediaFrame: target,
      }),
    );
    worker.emit(ready(command));
    await pending;
    expect(generationRequest.acceptPcmPortOwnership).toHaveBeenCalledTimes(1);
    await h.adapter.close();
    expect(h.closeSource).toHaveBeenCalledTimes(1);
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
      metadata: { name: 'fixture.aac', mime: 'audio/aac' },
      readAt: async (_offset: number, length: number) => new Uint8Array(length),
      close,
    };
    const adapter = new AacDecoderAdapter({
      encodedSource: source,
      timelineEvidence: timelineEvidenceFixture(),
      backendId: 'webcodecs',
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

  it('rejects timeline-evidence source mismatch and exact-one option violations before ownership', async () => {
    const h = harness();
    const foreignClose = vi.fn(async () => undefined);
    const foreignSource = {
      ...h.source,
      identity: 'source:foreign-timeline-evidence',
      close: foreignClose,
    } satisfies EncodedAudioSource;
    expect(
      () =>
        new AacDecoderAdapter({
          encodedSource: foreignSource,
          timelineEvidence: timelineEvidenceFixture(),
          backendId: 'webcodecs',
          runtime: { createWorker: h.createWorker, createMessageChannel: h.createMessageChannel },
        }),
    ).toThrow(/different encoded source/i);
    expect(foreignClose).not.toHaveBeenCalled();

    const unusedClose = vi.fn(async () => undefined);
    const unusedSource = { ...h.source, close: unusedClose } satisfies EncodedAudioSource;
    expect(
      () =>
        new AacDecoderAdapter({
          encodedSource: unusedSource,
          scan: scanFixture(),
          timelineEvidence: timelineEvidenceFixture(),
          backendId: 'webcodecs',
          runtime: { createWorker: h.createWorker, createMessageChannel: h.createMessageChannel },
        } as never),
    ).toThrow(/exactly one/i);
    expect(
      () =>
        new AacDecoderAdapter({
          encodedSource: unusedSource,
          backendId: 'webcodecs',
          runtime: { createWorker: h.createWorker, createMessageChannel: h.createMessageChannel },
        } as never),
    ).toThrow(/exactly one/i);

    let scanGetterReads = 0;
    const accessorOptions = {
      encodedSource: unusedSource,
      backendId: 'webcodecs',
      runtime: { createWorker: h.createWorker, createMessageChannel: h.createMessageChannel },
    };
    Object.defineProperty(accessorOptions, 'scan', {
      enumerable: true,
      get() {
        scanGetterReads += 1;
        return scanFixture();
      },
    });
    expect(() => new AacDecoderAdapter(accessorOptions as never)).toThrow(/data property/i);
    expect(scanGetterReads).toBe(0);
    expect(unusedClose).not.toHaveBeenCalled();
    await h.adapter.close();
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
    await vi.waitFor(() => expect(h.workers).toHaveLength(2));
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
      audioStartByte: 0,
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
    const activeAccept = vi.fn();
    const activePending = adapter.startGeneration({
      generation: 20,
      targetMediaFrame: 0,
      outputSampleRateHz: 8_000,
      pcmPort: activePort as unknown as MessagePort,
      acceptPcmPortOwnership: activeAccept,
      signal: new AbortController().signal,
    });
    const activeWorker = workers[0];
    if (!activeWorker) throw new Error('Expected active preflight realm');
    const activeCommand = openCommand(activeWorker);
    activeWorker.emit(ready(activeCommand));
    await activePending;
    expect(activeAccept).toHaveBeenCalledTimes(1);

    const rejectedPort = new FakeMessagePort();
    const rejectedAccept = vi.fn();
    await expect(
      adapter.startGeneration({
        generation: 21,
        targetMediaFrame: 0,
        outputSampleRateHz: 1_000_000,
        pcmPort: rejectedPort as unknown as MessagePort,
        acceptPcmPortOwnership: rejectedAccept,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/safe-integer range/i);
    expect(workers).toHaveLength(1);
    expect(activeWorker.terminateCount).toBe(0);
    expect(rejectedPort.closeCount).toBe(0);
    expect(rejectedAccept).not.toHaveBeenCalled();

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
    await vi.waitFor(() => expect(worker.terminateCount).toBe(1));
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
    await vi.waitFor(() => expect(worker.terminateCount).toBe(1));
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

  it('rolls back every exclusive-EOF setup failure at the exact ownership boundary', async () => {
    const h = harness();
    await h.adapter.open(options());
    const before = getFilePlaybackUniversalLifecycleSnapshot();

    const rejectedPort = new FakeMessagePort();
    const rejectedRequest = request(40, TOTAL_FRAMES, rejectedPort);
    rejectedRequest.acceptPcmPortOwnership.mockImplementationOnce(() => {
      throw new Error('AAC EOF ownership rejected');
    });
    await expect(h.adapter.startGeneration(rejectedRequest)).rejects.toThrow(/ownership rejected/i);
    expect(rejectedRequest.acceptPcmPortOwnership).toHaveBeenCalledTimes(1);
    expect(rejectedPort.closeCount).toBe(0);

    const messagePort = new FakeMessagePort();
    Object.defineProperty(messagePort, 'onmessage', {
      configurable: true,
      get: () => null,
      set: (value: unknown) => {
        if (value !== null) throw new Error('AAC EOF onmessage setter failed');
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
        if (value !== null) throw new Error('AAC EOF onmessageerror setter failed');
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
      throw new Error('AAC EOF start failed');
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
    await vi.waitFor(() => expect(worker.terminateCount).toBe(1));
    worker.emitUnknown({ malformed: true });
    expect(fatal).not.toHaveBeenCalled();
    await h.adapter.close();
  });

  it('discards exact-realm telemetry already queued behind logical retirement', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const pending = h.adapter.startGeneration(request(52, 0, new FakeMessagePort()));
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected AAC telemetry-race realm');
    const command = openCommand(worker);
    worker.emit(ready(command));
    await pending;

    h.adapter.stopGeneration(52);
    worker.emit(ready(command));
    worker.emit(
      progress(command, {
        type: 'decoder-eof',
        decodedInputBytes: command.descriptor.audioEndByteOffset,
        decodedCoreFrames: command.descriptor.timeline.totalMediaFrames,
        producedOutputFrames: expectedAacOutputFrames(command.descriptor),
      }),
    );
    worker.emit({
      protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
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
    const pending = h.adapter.startGeneration(request(53, 0, new FakeMessagePort()));
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected AAC wrong-realm race');
    const command = openCommand(worker);
    worker.emit(ready(command));
    await pending;

    h.adapter.stopGeneration(53);
    worker.emitUnknown({ ...ready(command), decoderGeneration: command.decoderGeneration + 1 });
    await vi.waitFor(() => expect(worker.terminateCount).toBe(1));

    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(after.kinds.decoderGenerations.unconfirmed).toBe(
      before.kinds.decoderGenerations.unconfirmed + 1,
    );
    expect(after.kinds.workers.unconfirmed).toBe(before.kinds.workers.unconfirmed + 1);
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
    await vi.waitFor(() => expect(h.workers[0]?.terminateCount).toBe(1));
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

    await vi.waitFor(() => expect(h.workers[0]?.terminateCount).toBe(1));
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(0);
    expect(pcm.closeCount).toBe(0);
    await h.adapter.close();
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

    const pending = h.adapter.startGeneration(request(34, 0, pcm));
    const worker = h.workers[0];
    if (!worker || !reentrantClose) throw new Error('Expected reentrant AAC close');
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
          if (!channel) throw new Error('Expected AAC source channel');
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

      const pending = h.adapter.startGeneration(request(36, 0, new FakeMessagePort()));
      const worker = h.workers[0];
      if (!worker || !reentrantClose) throw new Error('Expected stalled reentrant AAC close');
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
    await vi.waitFor(() => expect(h.workers[0]?.terminateCount).toBe(1));
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
    const generationRequest = request(32, 0, pcm);

    await expect(h.adapter.startGeneration(generationRequest)).rejects.toThrow(
      /adapter was closed/i,
    );
    expect(h.workers[0]?.messages).toHaveLength(0);
    expect(h.workers[0]?.terminateCount).toBe(1);
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(1);
    expect(pcm.closeCount).toBe(0);
    expect(generationRequest.acceptPcmPortOwnership).not.toHaveBeenCalled();
    expect(h.closeSource).toHaveBeenCalledTimes(1);
  });

  it('rejects a guessed ready event emitted by an injected Worker setter before open posting', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
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
    pcm.throwOnClose = true;

    await expect(
      h.adapter.startGeneration(request(33, 0, pcm)).catch((error: unknown) => error),
    ).resolves.toBeInstanceOf(Error);
    expect(h.workers[0]?.messages).toHaveLength(0);
    expect(h.workers[0]?.terminateCount).toBe(1);
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(1);
    expect(pcm.closeCount).toBe(1);
    expect(fatal).toHaveBeenCalledWith('decoder-invalid-event', expect.any(Error));
    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(after.kinds.ports.unconfirmed).toBe(before.kinds.ports.unconfirmed + 1);
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
      h.adapter.startGeneration(request(35, 0, new FakeMessagePort())),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const worker = h.workers[0];
    if (!worker || !reentrantClose) throw new Error('Expected hostile AAC Worker setter');
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
    if (!worker) throw new Error('Expected AAC barrier realm');
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
    if (!reentrantClose) throw new Error('Expected removeEventListener-reentrant AAC close');
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
    if (!worker) throw new Error('Expected AAC pre-stop ACK realm');
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

  it('re-detaches a callback-before-commit Worker setter that closes and then throws', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    let reentrantClose: Promise<void> | null = null;
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.onMessageSetBeforeCommit = true;
      worker.onMessageSet = () => {
        reentrantClose = h.adapter.close();
        throw new Error('AAC setter failed after reentrant close');
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
    if (!worker || !reentrantClose) throw new Error('Expected callback-before-commit AAC close');
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
    if (!reentrantClose) throw new Error('Expected EOF addEventListener-reentrant AAC close');
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
      'AAC decoder adapter is closed',
    );
    if (!reentrantClose) throw new Error('Expected lifetime addEventListener-reentrant AAC close');
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
        throw new Error('AAC lifetime remove failed');
      },
    });

    const close = h.adapter.close();
    expect(h.adapter.close()).toBe(close);
    await close;
    expect(h.closeSource).toHaveBeenCalledTimes(1);
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

  it('keeps an EOF port unconfirmed when its physical close throws', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    await h.adapter.open(options());
    const port = new FakeMessagePort();
    port.throwOnClose = true;
    await h.adapter.startGeneration(request(67, TOTAL_FRAMES, port));

    h.adapter.stopGeneration(67);

    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(after.kinds.ports.unconfirmed).toBe(before.kinds.ports.unconfirmed + 1);
    await h.adapter.close();
  });

  it('keeps Worker retirement unconfirmed when native termination throws after valid ACKs', async () => {
    const before = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    await h.adapter.open(options());
    const pending = h.adapter.startGeneration(request(68, 0, new FakeMessagePort()));
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected AAC Worker');
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
      if (!firstWorker || !firstChannel) throw new Error('Expected stalled AAC realm');
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
      if (!successorWorker) throw new Error('Expected successor AAC realm');
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

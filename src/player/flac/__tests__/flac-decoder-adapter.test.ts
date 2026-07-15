import { describe, expect, it, vi } from 'vitest';

import type { EncodedAudioSource } from '../../sources/encoded-audio-source.ts';
import { getFilePlaybackUniversalLifecycleSnapshotForTests as getFilePlaybackUniversalLifecycleSnapshot } from '../../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import type { StreamingDecoderOpenOptions } from '../../streaming/decoder-adapter.ts';
import { FlacDecoderAdapter } from '../flac-decoder-adapter.ts';
import type { FlacMetadata } from '../metadata.ts';
import {
  FLAC_STREAM_PROTOCOL_VERSION,
  type FlacDecoderCommand,
  type FlacDecoderEvent,
} from '../stream-protocol.ts';

class FakeMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly messages: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
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

  emitMessage(message: unknown): void {
    const event = { data: message } as MessageEvent<unknown>;
    for (const listener of this.listeners.get('message') ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
    this.onmessage?.(event);
  }
}

class FakeMessageChannel {
  readonly port1 = new FakeMessagePort();
  readonly port2 = new FakeMessagePort();
}

class FakeWorker {
  onmessage: ((event: MessageEvent<FlacDecoderEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{ message: FlacDecoderCommand; transfer: readonly Transferable[] }> = [];
  autoOpenSource = true;
  autoRetireOnClose = true;
  onCloseSource: (() => void) | null = null;
  readonly retiredGenerations = new Set<number>();
  terminateCount = 0;

  postMessage(message: FlacDecoderCommand, transfer: readonly Transferable[] = []): void {
    this.messages.push({ message, transfer });
    if (message.type === 'open-source' && this.autoOpenSource) {
      queueMicrotask(() => {
        this.emit({
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'source-opened',
          sourceLifetimeGeneration: message.sourceLifetimeGeneration,
          sourceSize: message.sourceSize,
          sourceIdentity: message.sourceIdentity,
        });
      });
    }
    if (message.type === 'close-source' && this.autoRetireOnClose) {
      this.onCloseSource?.();
      queueMicrotask(() => {
        const generations = new Set(
          this.messages.flatMap(({ message: candidate }) =>
            candidate.type === 'init-decoder' ? [candidate.decoderGeneration] : [],
          ),
        );
        for (const decoderGeneration of generations) {
          if (this.retiredGenerations.has(decoderGeneration)) continue;
          this.emit({
            protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
            type: 'decoder-retired',
            sourceLifetimeGeneration: message.sourceLifetimeGeneration,
            decoderGeneration,
          });
        }
        this.emit({
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'source-closed',
          sourceLifetimeGeneration: message.sourceLifetimeGeneration,
        });
        this.emit({
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'worker-retired',
          sourceLifetimeGeneration: message.sourceLifetimeGeneration,
        });
      });
    }
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: FlacDecoderEvent): void {
    const sourceLifetimeGeneration = this.messages.find(
      ({ message: candidate }) => candidate.type === 'open-source',
    )?.message.sourceLifetimeGeneration;
    if (
      message.type === 'decoder-retired' &&
      message.sourceLifetimeGeneration === sourceLifetimeGeneration
    ) {
      this.retiredGenerations.add(message.decoderGeneration);
    }
    this.onmessage?.({ data: message } as MessageEvent<FlacDecoderEvent>);
  }
}

function metadata(): FlacMetadata {
  return Object.freeze({
    streamInfo: Object.freeze({
      minBlockSize: 4_096,
      maxBlockSize: 4_096,
      minFrameSize: 100,
      maxFrameSize: 10_000,
      sampleRate: 96_000,
      channels: 2,
      bitDepth: 24,
      totalSamples: 960_000,
      duration: 10,
      md5: '00000000000000000000000000000000',
    }),
    seekPoints: Object.freeze([]),
    firstAudioFrameOffset: 42,
    metadataBlockCount: 1,
  });
}

function harness() {
  const worker = new FakeWorker();
  const channels: FakeMessageChannel[] = [];
  const closeSource = vi.fn(async () => undefined);
  const readAt = vi.fn(async (offset: number, length: number) =>
    Uint8Array.from({ length }, (_value, index) => offset + index),
  );
  const encodedSource: EncodedAudioSource = {
    kind: 'blob',
    size: 256,
    identity: 'source:flac-adapter-test',
    metadata: { name: 'fixture.flac', mime: 'audio/flac' },
    readAt,
    close: closeSource,
  };
  const createWorker = vi.fn(() => worker as unknown as Worker);
  const createMessageChannel = vi.fn(() => {
    const channel = new FakeMessageChannel();
    channels.push(channel);
    return channel as unknown as MessageChannel;
  });
  const adapter = new FlacDecoderAdapter({
    encodedSource,
    metadata: metadata(),
    runtime: { createWorker, createMessageChannel },
  });
  return {
    adapter,
    worker,
    channels,
    closeSource,
    readAt,
    createWorker,
    createMessageChannel,
  };
}

function openCommand(worker: FakeWorker) {
  const command = worker.messages.find(({ message }) => message.type === 'open-source')?.message;
  if (!command || command.type !== 'open-source') throw new Error('Expected open-source command');
  return command;
}

function initCommand(worker: FakeWorker) {
  const command = worker.messages.findLast(
    ({ message }) => message.type === 'init-decoder',
  )?.message;
  if (!command || command.type !== 'init-decoder') throw new Error('Expected init-decoder command');
  return command;
}

function openOptions(
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

function readyEvent(command: ReturnType<typeof initCommand>): FlacDecoderEvent {
  return {
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'decoder-ready',
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    descriptor: command.descriptor,
  };
}

function lifecycleDelta(
  before: ReturnType<typeof getFilePlaybackUniversalLifecycleSnapshot>,
  after: ReturnType<typeof getFilePlaybackUniversalLifecycleSnapshot>,
  kind: 'workers' | 'decoderGenerations' | 'ports' | 'timers',
  field: 'live' | 'retiring' | 'unconfirmed' | 'releasedTotal',
): number {
  return after.kinds[kind][field] - before.kinds[kind][field];
}

async function startReadyGeneration(
  h: ReturnType<typeof harness>,
  generation: number,
): Promise<ReturnType<typeof initCommand>> {
  const pending = h.adapter.startGeneration({
    generation,
    targetMediaFrame: 0,
    outputSampleRateHz: 48_000,
    pcmPort: new FakeMessagePort() as unknown as MessagePort,
    acceptPcmPortOwnership: vi.fn(),
    signal: new AbortController().signal,
  });
  const init = initCommand(h.worker);
  h.worker.emit(readyEvent(init));
  await pending;
  return init;
}

describe('FlacDecoderAdapter', () => {
  it('keeps construction inert and closes its encoded source exactly once before open', async () => {
    const h = harness();

    expect(h.adapter.info).toEqual({
      mediaSampleRateHz: 96_000,
      channelCount: 2,
      totalMediaFrames: 960_000,
    });
    expect(h.createWorker).not.toHaveBeenCalled();
    expect(h.createMessageChannel).not.toHaveBeenCalled();
    expect(h.readAt).not.toHaveBeenCalled();
    expect(h.closeSource).not.toHaveBeenCalled();

    await h.adapter.close();
    await h.adapter.close();
    expect(h.closeSource).toHaveBeenCalledTimes(1);
    expect(h.worker.terminateCount).toBe(0);
  });

  it('owns exact worker readiness while keeping stale and retired generations inert', async () => {
    const h = harness();
    const fatal = vi.fn();
    const controller = new AbortController();
    const lifetime = new AbortController();
    await h.adapter.open({
      signal: controller.signal,
      lifetimeSignal: lifetime.signal,
      onFatal: fatal,
      onGenerationStopped: vi.fn(),
    });

    expect(h.adapter.opened).toBe(true);
    expect(h.createWorker).toHaveBeenCalledTimes(1);
    expect(h.createMessageChannel).toHaveBeenCalledTimes(1);
    expect(openCommand(h.worker).sourcePort).toBe(h.channels[0]?.port2);
    expect(h.channels[0]?.port1.startCount).toBe(1);

    const pcmPort = new FakeMessagePort();
    const acceptPcmPortOwnership = vi.fn();
    const ready = h.adapter.startGeneration({
      generation: 1,
      targetMediaFrame: 24_000,
      outputSampleRateHz: 48_000,
      pcmPort: pcmPort as unknown as MessagePort,
      acceptPcmPortOwnership,
      signal: controller.signal,
    });
    const init = initCommand(h.worker);
    expect(init.descriptor).toMatchObject({
      sourceSampleRate: 96_000,
      outputSampleRate: 48_000,
      channels: 2,
      targetSourceSample: 24_000,
      decodeAnchorSourceSample: 0,
      decodeAnchorByteOffset: 42,
    });
    expect(init.pcmPort).toBe(pcmPort);

    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-error',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: 2,
      code: 'stale-generation',
      message: 'stale decoder failed',
    });
    expect(fatal).not.toHaveBeenCalled();

    const exactReady: FlacDecoderEvent = {
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-ready',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: init.decoderGeneration,
      descriptor: init.descriptor,
    };
    h.worker.emit(exactReady);
    await ready;
    expect(acceptPcmPortOwnership).toHaveBeenCalledTimes(1);
    h.worker.emit(exactReady);
    expect(fatal).not.toHaveBeenCalled();

    h.adapter.stopGeneration(1);
    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-error',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: 1,
      code: 'retired-generation',
      message: 'retired decoder failed',
    });
    expect(fatal).not.toHaveBeenCalled();
    expect(h.worker.messages.filter(({ message }) => message.type === 'stop-decoder')).toHaveLength(
      1,
    );

    await h.adapter.close();
    expect(h.worker.terminateCount).toBe(1);
    expect(h.closeSource).toHaveBeenCalledTimes(1);
  });

  it('preserves caller PCM ownership when a duplicate generation is rejected pre-commit', async () => {
    const h = harness();
    const controller = new AbortController();
    await h.adapter.open({
      signal: controller.signal,
      lifetimeSignal: controller.signal,
      onFatal: vi.fn(),
      onGenerationStopped: vi.fn(),
    });
    const firstPending = h.adapter.startGeneration({
      generation: 2,
      targetMediaFrame: 0,
      outputSampleRateHz: 48_000,
      pcmPort: new FakeMessagePort() as unknown as MessagePort,
      acceptPcmPortOwnership: vi.fn(),
      signal: controller.signal,
    });
    const first = initCommand(h.worker);
    const rejectedPort = new FakeMessagePort();
    const rejectedAccept = vi.fn();

    await expect(
      h.adapter.startGeneration({
        generation: 2,
        targetMediaFrame: 1,
        outputSampleRateHz: 48_000,
        pcmPort: rejectedPort as unknown as MessagePort,
        acceptPcmPortOwnership: rejectedAccept,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/already created/i);
    expect(rejectedPort.closeCount).toBe(0);
    expect(rejectedAccept).not.toHaveBeenCalled();

    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-ready',
      sourceLifetimeGeneration: first.sourceLifetimeGeneration,
      decoderGeneration: first.decoderGeneration,
      descriptor: first.descriptor,
    });
    await firstPending;
    await h.adapter.close();
  });

  it('keeps generation leases live for wrong-realm and premature retirement ACKs', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(openOptions({ onFatal: fatal }));
    const init = await startReadyGeneration(h, 80);
    const before = getFilePlaybackUniversalLifecycleSnapshot();

    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-retired',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration + 1,
      decoderGeneration: init.decoderGeneration,
    });
    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-retired',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: init.decoderGeneration,
    });

    const after = getFilePlaybackUniversalLifecycleSnapshot();
    expect(after.kinds.decoderGenerations.live).toBe(before.kinds.decoderGenerations.live);
    expect(after.kinds.decoderGenerations.releasedTotal).toBe(
      before.kinds.decoderGenerations.releasedTotal,
    );
    expect(fatal).toHaveBeenCalledTimes(2);
    await h.adapter.close();
  });

  it('accepts one exact retiring ACK and rejects its duplicate without a second release', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(openOptions({ onFatal: fatal }));
    const init = await startReadyGeneration(h, 81);
    h.adapter.stopGeneration(init.decoderGeneration);

    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-retired',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: init.decoderGeneration,
    });
    const released = getFilePlaybackUniversalLifecycleSnapshot();
    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-retired',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: init.decoderGeneration,
    });
    const duplicate = getFilePlaybackUniversalLifecycleSnapshot();

    expect(duplicate.kinds.decoderGenerations.releasedTotal).toBe(
      released.kinds.decoderGenerations.releasedTotal,
    );
    expect(fatal).toHaveBeenCalledWith('decoder-invalid-event', undefined);
    await h.adapter.close();
  });

  it('moves a natural EOF generation to retiring before accepting its exact ACK', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(openOptions({ onFatal: fatal }));
    const init = await startReadyGeneration(h, 82);
    const before = getFilePlaybackUniversalLifecycleSnapshot();

    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-eof',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: init.decoderGeneration,
      decodedInputBytes: 1,
      decodedSourceSamples: 1,
      producedOutputFrames: 1,
    });
    const eof = getFilePlaybackUniversalLifecycleSnapshot();
    expect(lifecycleDelta(before, eof, 'decoderGenerations', 'retiring')).toBe(1);

    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-retired',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: init.decoderGeneration,
    });
    const retired = getFilePlaybackUniversalLifecycleSnapshot();
    expect(lifecycleDelta(before, retired, 'decoderGenerations', 'releasedTotal')).toBe(1);
    expect(fatal).not.toHaveBeenCalled();
    await h.adapter.close();
  });

  it('publishes one stable close Promise before close-source can re-enter', async () => {
    const h = harness();
    await h.adapter.open(openOptions());
    let reentered: Promise<void> | null = null;
    h.worker.onCloseSource = () => {
      h.worker.onCloseSource = null;
      reentered = h.adapter.close();
    };

    const closing = h.adapter.close();
    expect(reentered).toBe(closing);
    expect(h.adapter.close()).toBe(closing);
    await closing;
    expect(h.worker.messages.filter(({ message }) => message.type === 'close-source')).toHaveLength(
      1,
    );
  });

  it('bounds close after timeout even when an encoded read never physically settles', async () => {
    const h = harness();
    h.readAt.mockImplementationOnce(() => new Promise<Uint8Array>(() => {}));
    await h.adapter.open(openOptions());
    const opened = openCommand(h.worker);
    h.channels[0]?.port1.emitMessage({
      type: 'encoded-source:read',
      generation: opened.sourceLifetimeGeneration,
      decoderGeneration: 1,
      requestId: 1,
      offset: 0,
      length: 1,
    });
    await vi.waitFor(() => expect(h.readAt).toHaveBeenCalledTimes(1));
    h.worker.autoRetireOnClose = false;
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();

    vi.useFakeTimers();
    try {
      const closing = h.adapter.close();
      await vi.advanceTimersByTimeAsync(4_000);
      await closing;
    } finally {
      vi.useRealTimers();
    }

    const timedOut = getFilePlaybackUniversalLifecycleSnapshot();
    expect(lifecycleDelta(baseline, timedOut, 'workers', 'unconfirmed')).toBe(1);
    expect(lifecycleDelta(baseline, timedOut, 'ports', 'unconfirmed')).toBeGreaterThanOrEqual(1);
    expect(h.closeSource).toHaveBeenCalledTimes(1);
    expect(h.worker.terminateCount).toBe(1);
  });

  it('fails a mismatched source-open echo and permits exact-once partial cleanup', async () => {
    const h = harness();
    h.worker.autoOpenSource = false;
    const controller = new AbortController();
    const lifetime = new AbortController();
    const fatalCodes: string[] = [];
    const opening = h.adapter.open({
      signal: controller.signal,
      lifetimeSignal: lifetime.signal,
      onFatal: (code) => {
        fatalCodes.push(code);
        void h.adapter.close();
      },
      onGenerationStopped: vi.fn(),
    });
    const opened = openCommand(h.worker);

    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'source-opened',
      sourceLifetimeGeneration: opened.sourceLifetimeGeneration,
      sourceSize: opened.sourceSize + 1,
      sourceIdentity: `${opened.sourceIdentity}:mismatch`,
    });

    await expect(opening).rejects.toThrow(/source-open acknowledgement mismatch/i);
    await h.adapter.close();
    expect(fatalCodes).toEqual(['decoder-source-open-mismatch']);
    expect(h.worker.terminateCount).toBe(1);
    expect(h.closeSource).toHaveBeenCalledTimes(1);
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(0);
  });
});

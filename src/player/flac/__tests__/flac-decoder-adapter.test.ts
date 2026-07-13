import { describe, expect, it, vi } from 'vitest';

import type { EncodedAudioSource } from '../../sources/encoded-audio-source.ts';
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
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: FlacDecoderEvent): void {
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
    const ready = h.adapter.startGeneration({
      generation: 1,
      targetMediaFrame: 24_000,
      outputSampleRateHz: 48_000,
      pcmPort: pcmPort as unknown as MessagePort,
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
    expect(h.channels[0]?.port1.closeCount).toBeGreaterThan(0);
    expect(h.channels[0]?.port2.closeCount).toBeGreaterThan(0);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { EncodedAudioSource } from '../../sources/encoded-audio-source.ts';
import type { StreamingDecoderOpenOptions } from '../../streaming/decoder-adapter.ts';
import { createLinearPcmDecoderDescriptor } from '../decoder-helpers.ts';
import {
  LINEAR_PCM_DECODER_PROTOCOL_VERSION,
  type LinearPcmDecoderCommand,
  type LinearPcmDecoderEvent,
} from '../decoder-protocol.ts';
import { LinearPcmDecoderAdapter } from '../decoder-adapter.ts';
import type { LinearPcmMetadata } from '../sample-format.ts';

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
  onmessage: ((event: MessageEvent<LinearPcmDecoderEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{
    message: LinearPcmDecoderCommand;
    transfer: readonly Transferable[];
  }> = [];
  autoOpenSource = true;
  throwOnType: LinearPcmDecoderCommand['type'] | null = null;
  terminateCount = 0;

  postMessage(message: LinearPcmDecoderCommand, transfer: readonly Transferable[] = []): void {
    if (message.type === this.throwOnType) throw new Error(`failed ${message.type}`);
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
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: LinearPcmDecoderEvent): void {
    this.emitUnknown(message);
  }

  emitUnknown(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<LinearPcmDecoderEvent>);
  }
}

function metadata(): Readonly<LinearPcmMetadata> {
  return Object.freeze({
    encoding: 'pcm-s16le',
    sourceSampleRate: 96_000,
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

function harness() {
  const worker = new FakeWorker();
  const channels: FakeMessageChannel[] = [];
  const closeSource = vi.fn(async () => undefined);
  const readAt = vi.fn(async (offset: number, length: number) =>
    Uint8Array.from({ length }, (_value, index) => offset + index),
  );
  const encodedSource: EncodedAudioSource = {
    kind: 'blob',
    size: 960_044,
    identity: 'source:linear-pcm-adapter-test',
    metadata: { name: 'fixture.wav', mime: 'audio/wav' },
    readAt,
    close: closeSource,
  };
  const createWorker = vi.fn(() => worker as unknown as Worker);
  const createMessageChannel = vi.fn(() => {
    const channel = new FakeMessageChannel();
    channels.push(channel);
    return channel as unknown as MessageChannel;
  });
  const adapter = new LinearPcmDecoderAdapter({
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

function initCommands(worker: FakeWorker) {
  return worker.messages
    .map(({ message }) => message)
    .filter((message) => message.type === 'init-decoder');
}

function initCommand(worker: FakeWorker) {
  const command = initCommands(worker).at(-1);
  if (!command) throw new Error('Expected init-decoder command');
  return command;
}

function openOptions(
  patch: Partial<StreamingDecoderOpenOptions> = {},
): StreamingDecoderOpenOptions {
  const prepare = new AbortController();
  const lifetime = new AbortController();
  return {
    signal: prepare.signal,
    lifetimeSignal: lifetime.signal,
    onFatal: vi.fn(),
    onGenerationStopped: vi.fn(),
    ...patch,
  };
}

function readyEvent(command: ReturnType<typeof initCommand>): LinearPcmDecoderEvent {
  return {
    protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
    type: 'decoder-ready',
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    descriptor: command.descriptor,
  };
}

describe('LinearPcmDecoderAdapter', () => {
  it('exposes verified media info while keeping construction inert and close exact-once', async () => {
    const h = harness();

    expect(h.adapter.info).toEqual({
      mediaSampleRateHz: 96_000,
      channelCount: 2,
      totalMediaFrames: 240_000,
    });
    expect(h.createWorker).not.toHaveBeenCalled();
    expect(h.createMessageChannel).not.toHaveBeenCalled();
    expect(h.readAt).not.toHaveBeenCalled();
    expect(h.closeSource).not.toHaveBeenCalled();

    const firstClose = h.adapter.close();
    expect(h.adapter.close()).toBe(firstClose);
    await firstClose;
    expect(h.closeSource).toHaveBeenCalledTimes(1);
    expect(h.worker.terminateCount).toBe(0);
  });

  it('owns exact source-open and descriptor echoes through the injected worker runtime', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(openOptions({ onFatal: fatal }));

    expect(h.adapter.opened).toBe(true);
    expect(h.createWorker).toHaveBeenCalledTimes(1);
    expect(h.createMessageChannel).toHaveBeenCalledTimes(1);
    const opened = openCommand(h.worker);
    expect(opened.sourcePort).toBe(h.channels[0]?.port2);
    expect(h.worker.messages[0]?.transfer).toEqual([h.channels[0]?.port2]);
    expect(h.channels[0]?.port1.startCount).toBe(1);

    const pcmPort = new FakeMessagePort();
    const controller = new AbortController();
    const primed = h.adapter.startGeneration({
      generation: 1,
      targetMediaFrame: 120_000,
      outputSampleRateHz: 48_000,
      pcmPort: pcmPort as unknown as MessagePort,
      signal: controller.signal,
    });
    const init = initCommand(h.worker);
    expect(init.descriptor).toEqual(createLinearPcmDecoderDescriptor(metadata(), 120_000, 48_000));
    expect(init.pcmPort).toBe(pcmPort);
    expect(h.worker.messages.at(-1)?.transfer).toEqual([pcmPort]);

    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'decoder-error',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: 2,
      code: 'stale-generation',
      message: 'stale decoder failed',
    });
    expect(fatal).not.toHaveBeenCalled();

    const ready = readyEvent(init);
    h.worker.emit(ready);
    await primed;
    h.worker.emit(ready);
    expect(fatal).not.toHaveBeenCalled();

    h.adapter.stopGeneration(1);
    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
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

  it('retires a pending generation and keeps all superseded worker events inert', async () => {
    const h = harness();
    const fatal = vi.fn();
    const stopped = vi.fn();
    await h.adapter.open(openOptions({ onFatal: fatal, onGenerationStopped: stopped }));
    const controller = new AbortController();

    const firstOutcome = h.adapter
      .startGeneration({
        generation: 10,
        targetMediaFrame: 0,
        outputSampleRateHz: 48_000,
        pcmPort: new FakeMessagePort() as unknown as MessagePort,
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    const first = initCommand(h.worker);
    const secondReady = h.adapter.startGeneration({
      generation: 11,
      targetMediaFrame: 96_000,
      outputSampleRateHz: 48_000,
      pcmPort: new FakeMessagePort() as unknown as MessagePort,
      signal: controller.signal,
    });
    const second = initCommand(h.worker);

    await expect(firstOutcome).resolves.toMatchObject({ message: /stopped before priming/i });
    h.worker.emit(readyEvent(first));
    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'decoder-stopped',
      sourceLifetimeGeneration: first.sourceLifetimeGeneration,
      decoderGeneration: first.decoderGeneration,
    });
    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'decoder-error',
      sourceLifetimeGeneration: first.sourceLifetimeGeneration,
      decoderGeneration: first.decoderGeneration,
      code: 'superseded',
      message: 'superseded decoder failed',
    });
    expect(fatal).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();

    h.worker.emit(readyEvent(second));
    await secondReady;
    expect(fatal).not.toHaveBeenCalled();
    await h.adapter.close();
  });

  it('rejects an unexpected current stop and reports it through the stop callback', async () => {
    const h = harness();
    const fatal = vi.fn();
    const stopped = vi.fn();
    await h.adapter.open(openOptions({ onFatal: fatal, onGenerationStopped: stopped }));
    const controller = new AbortController();
    const primed = h.adapter.startGeneration({
      generation: 20,
      targetMediaFrame: 0,
      outputSampleRateHz: 48_000,
      pcmPort: new FakeMessagePort() as unknown as MessagePort,
      signal: controller.signal,
    });
    const init = initCommand(h.worker);

    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'decoder-stopped',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: init.decoderGeneration,
    });

    await expect(primed).rejects.toThrow(/stopped before priming/i);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledWith(20, expect.any(Error));
    expect(fatal).not.toHaveBeenCalled();
    await h.adapter.close();
  });

  it('fails a mismatched ready descriptor instead of accepting a near echo', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(openOptions({ onFatal: fatal }));
    const controller = new AbortController();
    const primed = h.adapter.startGeneration({
      generation: 30,
      targetMediaFrame: 1,
      outputSampleRateHz: 48_000,
      pcmPort: new FakeMessagePort() as unknown as MessagePort,
      signal: controller.signal,
    });
    const init = initCommand(h.worker);

    h.worker.emit({
      ...readyEvent(init),
      descriptor: { ...init.descriptor, targetSourceFrame: 2 },
    });

    await expect(primed).rejects.toThrow(/descriptor mismatch/i);
    expect(fatal).toHaveBeenCalledWith('decoder-descriptor-mismatch', expect.any(Error));
    await h.adapter.close();
  });

  it('fails a mismatched source-open echo and permits exact-once partial cleanup', async () => {
    const h = harness();
    h.worker.autoOpenSource = false;
    const fatalCodes: string[] = [];
    const opening = h.adapter.open(
      openOptions({
        onFatal: (code) => {
          fatalCodes.push(code);
          void h.adapter.close();
        },
      }),
    );
    const opened = openCommand(h.worker);

    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
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

  it('closes an untransferred PCM port and source exactly once after command failure', async () => {
    const h = harness();
    await h.adapter.open(openOptions());
    h.worker.throwOnType = 'init-decoder';
    const pcmPort = new FakeMessagePort();
    const controller = new AbortController();

    await expect(
      h.adapter.startGeneration({
        generation: 40,
        targetMediaFrame: 0,
        outputSampleRateHz: 48_000,
        pcmPort: pcmPort as unknown as MessagePort,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/failed init-decoder/i);
    expect(pcmPort.closeCount).toBe(1);

    await h.adapter.close();
    await h.adapter.close();
    expect(h.closeSource).toHaveBeenCalledTimes(1);
    expect(h.worker.terminateCount).toBe(1);
  });

  it('cleans up a source broker exactly once when open-source transfer fails', async () => {
    const h = harness();
    h.worker.throwOnType = 'open-source';

    await expect(h.adapter.open(openOptions())).rejects.toThrow(/failed open-source/i);
    expect(h.channels[0]?.port1.closeCount).toBeGreaterThan(0);
    expect(h.channels[0]?.port2.closeCount).toBeGreaterThan(0);

    await h.adapter.close();
    await h.adapter.close();
    expect(h.closeSource).toHaveBeenCalledTimes(1);
    expect(h.worker.terminateCount).toBe(1);
  });

  it('rejects malformed current events and forwards worker terminal callbacks', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(openOptions({ onFatal: fatal }));

    h.worker.emitUnknown({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'decoder-ready',
      sourceLifetimeGeneration: openCommand(h.worker).sourceLifetimeGeneration,
      decoderGeneration: 1,
      descriptor: {},
      extra: true,
    });
    expect(fatal).toHaveBeenCalledWith('decoder-invalid-event', undefined);

    h.worker.onerror?.(new Event('error') as ErrorEvent);
    h.worker.onmessageerror?.(new Event('messageerror') as MessageEvent);
    expect(fatal).toHaveBeenCalledWith('decoder-worker-error', undefined);
    expect(fatal).toHaveBeenCalledWith('decoder-message-error', undefined);
    await h.adapter.close();
  });
});

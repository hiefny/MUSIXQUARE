import { describe, expect, it, vi } from 'vitest';

import type { EncodedAudioSource } from '../../sources/encoded-audio-source.ts';
import type { StreamingDecoderOpenOptions } from '../../streaming/decoder-adapter.ts';
import { getFilePlaybackUniversalLifecycleSnapshotForTests as getFilePlaybackUniversalLifecycleSnapshot } from '../../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
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
  throwOnClose = false;
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
    if (this.throwOnClose) throw new Error('synthetic port close failure');
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
  onmessage: ((event: MessageEvent<LinearPcmDecoderEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{
    message: LinearPcmDecoderCommand;
    transfer: readonly Transferable[];
  }> = [];
  autoOpenSource = true;
  autoRetireOnClose = true;
  onCloseSource: (() => void) | null = null;
  readonly retiredGenerations = new Set<number>();
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
    const sourceLifetimeGeneration = this.messages.find(
      ({ message: candidate }) => candidate.type === 'open-source',
    )?.message.sourceLifetimeGeneration;
    if (
      message.type === 'decoder-retired' &&
      message.sourceLifetimeGeneration === sourceLifetimeGeneration
    ) {
      this.retiredGenerations.add(message.decoderGeneration);
    }
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

function harness(
  configureChannel: (channel: FakeMessageChannel, index: number) => void = () => {},
) {
  const worker = new FakeWorker();
  const channels: FakeMessageChannel[] = [];
  const closeSource = vi.fn(async (): Promise<void> => undefined);
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
    configureChannel(channel, channels.length);
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

function readyEvent(
  command: ReturnType<typeof initCommand>,
): Extract<LinearPcmDecoderEvent, { readonly type: 'decoder-ready' }> {
  return {
    protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
    type: 'decoder-ready',
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    descriptor: command.descriptor,
  };
}

function lifecycleDelta(
  before: ReturnType<typeof getFilePlaybackUniversalLifecycleSnapshot>,
  after: ReturnType<typeof getFilePlaybackUniversalLifecycleSnapshot>,
  kind: 'decoderGenerations' | 'workers' | 'ports' | 'timers',
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
    const acceptPcmPortOwnership = vi.fn();
    const primed = h.adapter.startGeneration({
      generation: 1,
      targetMediaFrame: 120_000,
      outputSampleRateHz: 48_000,
      pcmPort: pcmPort as unknown as MessagePort,
      acceptPcmPortOwnership,
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
    expect(acceptPcmPortOwnership).toHaveBeenCalledTimes(1);
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

  it('preserves caller PCM ownership when a duplicate generation is rejected pre-commit', async () => {
    const h = harness();
    await h.adapter.open(openOptions());
    const firstPending = h.adapter.startGeneration({
      generation: 2,
      targetMediaFrame: 0,
      outputSampleRateHz: 48_000,
      pcmPort: new FakeMessagePort() as unknown as MessagePort,
      acceptPcmPortOwnership: vi.fn(),
      signal: new AbortController().signal,
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
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/already created/i);
    expect(rejectedPort.closeCount).toBe(0);
    expect(rejectedAccept).not.toHaveBeenCalled();

    h.worker.emit(readyEvent(first));
    await firstPending;
    await h.adapter.close();
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
        acceptPcmPortOwnership: vi.fn(),
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    const first = initCommand(h.worker);
    const secondReady = h.adapter.startGeneration({
      generation: 11,
      targetMediaFrame: 96_000,
      outputSampleRateHz: 48_000,
      pcmPort: new FakeMessagePort() as unknown as MessagePort,
      acceptPcmPortOwnership: vi.fn(),
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
      acceptPcmPortOwnership: vi.fn(),
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
      acceptPcmPortOwnership: vi.fn(),
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
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(0);
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
        acceptPcmPortOwnership: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/failed init-decoder/i);
    expect(pcmPort.closeCount).toBe(1);

    await h.adapter.close();
    await h.adapter.close();
    expect(h.closeSource).toHaveBeenCalledTimes(1);
    expect(h.worker.terminateCount).toBe(1);
  });

  it('keeps an ambiguous generation and PCM port unconfirmed when worker transfer throws', async () => {
    const h = harness();
    await h.adapter.open(openOptions());
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    h.worker.throwOnType = 'init-decoder';
    const pcmPort = new FakeMessagePort();
    pcmPort.throwOnClose = true;

    await expect(
      h.adapter.startGeneration({
        generation: 41,
        targetMediaFrame: 0,
        outputSampleRateHz: 48_000,
        pcmPort: pcmPort as unknown as MessagePort,
        acceptPcmPortOwnership: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/failed init-decoder/i);
    await h.adapter.close();

    const failed = getFilePlaybackUniversalLifecycleSnapshot();
    expect(pcmPort.closeCount).toBe(1);
    expect(lifecycleDelta(baseline, failed, 'decoderGenerations', 'unconfirmed')).toBe(1);
    expect(lifecycleDelta(baseline, failed, 'ports', 'unconfirmed')).toBe(1);
  });

  it('cleans up a source broker exactly once when open-source transfer fails', async () => {
    const h = harness();
    h.worker.throwOnType = 'open-source';

    await expect(h.adapter.open(openOptions())).rejects.toThrow(/failed open-source/i);
    expect(h.channels[0]?.port1.closeCount).toBe(0);
    expect(h.channels[0]?.port2.closeCount).toBe(1);

    await h.adapter.close();
    await h.adapter.close();
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.closeSource).toHaveBeenCalledTimes(1);
    expect(h.worker.terminateCount).toBe(1);
  });

  it('keeps an untransferred source port unconfirmed when its local close throws', async () => {
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness((channel, index) => {
      if (index === 0) channel.port2.throwOnClose = true;
    });
    h.worker.throwOnType = 'open-source';

    await expect(h.adapter.open(openOptions())).rejects.toThrow(/failed open-source/i);
    await h.adapter.close();

    const failed = getFilePlaybackUniversalLifecycleSnapshot();
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(1);
    expect(lifecycleDelta(baseline, failed, 'ports', 'unconfirmed')).toBe(1);
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

  it('detaches after exact ACK while physical source cleanup stays independently retiring', async () => {
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    const h = harness();
    let finishPhysicalSourceClose: (() => void) | undefined;
    const physicalSourceClose = new Promise<void>((resolve) => {
      finishPhysicalSourceClose = resolve;
    });
    h.closeSource.mockReturnValueOnce(physicalSourceClose);
    await h.adapter.open(openOptions());
    const controller = new AbortController();
    const ready = h.adapter.startGeneration({
      generation: 50,
      targetMediaFrame: 0,
      outputSampleRateHz: 48_000,
      pcmPort: new FakeMessagePort() as unknown as MessagePort,
      acceptPcmPortOwnership: vi.fn(),
      signal: controller.signal,
    });
    const init = initCommand(h.worker);
    h.worker.emit(readyEvent(init));
    await ready;
    h.worker.autoRetireOnClose = false;

    const closing = h.adapter.close();
    const retiring = getFilePlaybackUniversalLifecycleSnapshot();
    expect(lifecycleDelta(baseline, retiring, 'workers', 'retiring')).toBe(1);
    expect(lifecycleDelta(baseline, retiring, 'decoderGenerations', 'retiring')).toBe(1);
    expect(lifecycleDelta(baseline, retiring, 'ports', 'retiring')).toBe(2);
    expect(lifecycleDelta(baseline, retiring, 'timers', 'live')).toBe(1);

    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'decoder-retired',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: init.decoderGeneration,
    });
    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'source-closed',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
    });
    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'worker-retired',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
    });
    await vi.waitFor(() => expect(h.closeSource).toHaveBeenCalledTimes(1));
    await closing;

    const acknowledged = getFilePlaybackUniversalLifecycleSnapshot();
    expect(lifecycleDelta(baseline, acknowledged, 'workers', 'retiring')).toBe(0);
    expect(lifecycleDelta(baseline, acknowledged, 'workers', 'releasedTotal')).toBe(1);
    expect(lifecycleDelta(baseline, acknowledged, 'decoderGenerations', 'releasedTotal')).toBe(1);
    expect(lifecycleDelta(baseline, acknowledged, 'ports', 'releasedTotal')).toBe(2);
    expect(lifecycleDelta(baseline, acknowledged, 'timers', 'releasedTotal')).toBe(1);
    expect(h.worker.terminateCount).toBe(1);

    finishPhysicalSourceClose?.();
    await vi.waitFor(() => {
      const retired = getFilePlaybackUniversalLifecycleSnapshot();
      expect(lifecycleDelta(baseline, retired, 'ports', 'releasedTotal')).toBe(3);
      expect(lifecycleDelta(baseline, retired, 'timers', 'releasedTotal')).toBe(2);
    });

    const retired = getFilePlaybackUniversalLifecycleSnapshot();
    for (const kind of ['workers', 'decoderGenerations', 'ports', 'timers'] as const) {
      expect(lifecycleDelta(baseline, retired, kind, 'live')).toBe(0);
      expect(lifecycleDelta(baseline, retired, kind, 'retiring')).toBe(0);
      expect(lifecycleDelta(baseline, retired, kind, 'unconfirmed')).toBe(0);
      expect(lifecycleDelta(baseline, retired, kind, 'releasedTotal')).toBe(
        kind === 'ports' ? 3 : kind === 'timers' ? 2 : 1,
      );
    }
    expect(h.worker.terminateCount).toBe(1);
  });

  it('keeps forced worker termination sticky-unconfirmed after its ACK timeout', async () => {
    const h = harness();
    await h.adapter.open(openOptions());
    const controller = new AbortController();
    const ready = h.adapter.startGeneration({
      generation: 60,
      targetMediaFrame: 0,
      outputSampleRateHz: 48_000,
      pcmPort: new FakeMessagePort() as unknown as MessagePort,
      acceptPcmPortOwnership: vi.fn(),
      signal: controller.signal,
    });
    const init = initCommand(h.worker);
    h.worker.emit(readyEvent(init));
    await ready;
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
    expect(lifecycleDelta(baseline, timedOut, 'decoderGenerations', 'unconfirmed')).toBe(1);
    expect(lifecycleDelta(baseline, timedOut, 'ports', 'unconfirmed')).toBe(2);
    expect(lifecycleDelta(baseline, timedOut, 'timers', 'releasedTotal')).toBe(2);
    expect(h.worker.terminateCount).toBe(1);
  });

  it('marks worker resources unconfirmed when close-source cannot be posted', async () => {
    const h = harness();
    await h.adapter.open(openOptions());
    const controller = new AbortController();
    const ready = h.adapter.startGeneration({
      generation: 70,
      targetMediaFrame: 0,
      outputSampleRateHz: 48_000,
      pcmPort: new FakeMessagePort() as unknown as MessagePort,
      acceptPcmPortOwnership: vi.fn(),
      signal: controller.signal,
    });
    const init = initCommand(h.worker);
    h.worker.emit(readyEvent(init));
    await ready;
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    h.worker.throwOnType = 'close-source';

    await h.adapter.close();

    const failed = getFilePlaybackUniversalLifecycleSnapshot();
    expect(lifecycleDelta(baseline, failed, 'workers', 'unconfirmed')).toBe(1);
    expect(lifecycleDelta(baseline, failed, 'decoderGenerations', 'unconfirmed')).toBe(1);
    expect(lifecycleDelta(baseline, failed, 'ports', 'unconfirmed')).toBe(2);
    expect(lifecycleDelta(baseline, failed, 'timers', 'releasedTotal')).toBe(0);
    expect(h.closeSource).toHaveBeenCalledTimes(1);
    expect(h.worker.terminateCount).toBe(1);
  });

  it('keeps generation leases live for wrong-realm and premature retirement ACKs', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(openOptions({ onFatal: fatal }));
    const init = await startReadyGeneration(h, 80);
    const before = getFilePlaybackUniversalLifecycleSnapshot();

    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'decoder-retired',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration + 1,
      decoderGeneration: init.decoderGeneration,
    });
    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
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
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'decoder-retired',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: init.decoderGeneration,
    });
    const released = getFilePlaybackUniversalLifecycleSnapshot();
    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
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
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
      type: 'decoder-eof',
      sourceLifetimeGeneration: init.sourceLifetimeGeneration,
      decoderGeneration: init.decoderGeneration,
      decodedInputBytes: 1,
      decodedSourceFrames: 1,
      producedOutputFrames: 1,
    });
    const eof = getFilePlaybackUniversalLifecycleSnapshot();
    expect(lifecycleDelta(before, eof, 'decoderGenerations', 'retiring')).toBe(1);

    h.worker.emit({
      protocolVersion: LINEAR_PCM_DECODER_PROTOCOL_VERSION,
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
    h.readAt.mockImplementationOnce(() => new Promise<Uint8Array<ArrayBuffer>>(() => {}));
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

  it('records a Worker constructor failure as unconfirmed instead of a false zero', async () => {
    const h = harness();
    h.createWorker.mockImplementationOnce(() => {
      throw new Error('synthetic Worker constructor failure');
    });
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();

    await expect(h.adapter.open(openOptions())).rejects.toThrow(/constructor failure/i);
    await h.adapter.close();

    const failed = getFilePlaybackUniversalLifecycleSnapshot();
    expect(lifecycleDelta(baseline, failed, 'workers', 'unconfirmed')).toBe(1);
  });
});

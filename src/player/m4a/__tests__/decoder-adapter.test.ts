import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { EncodedAudioSource } from '../../sources/encoded-audio-source.ts';
import type { StreamingDecoderOpenOptions } from '../../streaming/decoder-adapter.ts';
import { PCM_STREAM_PROTOCOL_VERSION } from '../../streaming/pcm-stream-protocol.ts';
import { M4aAacDecoderAdapter } from '../decoder-adapter.ts';
import {
  createM4aAacDecoderDescriptor,
  expectedM4aAacDecoderEofProgress,
} from '../decoder-helpers.ts';
import {
  M4A_AAC_DECODER_PROTOCOL_VERSION,
  type M4aAacDecoderBackendId,
  type M4aAacDecoderCommand,
  type M4aAacDecoderEvent,
  type M4aAacDecoderLogicalProgress,
  type M4aAacDecoderOpenCommand,
} from '../decoder-protocol.ts';
import { M4A_AAC_FIXTURE_ACCESS_UNIT_SIZES, buildM4aAacFixture } from './m4a-aac-fixture.ts';
import { readM4aAacLcMetadata, type M4aAacLcManifest } from '../metadata.ts';

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
  readonly messages: Array<{
    message: M4aAacDecoderCommand;
    transfer: readonly Transferable[];
  }> = [];
  throwOnOpen = false;
  onOpenPost: ((command: M4aAacDecoderOpenCommand) => void) | null = null;
  onMessageSet: ((handler: (event: MessageEvent<unknown>) => void) => void) | null = null;
  terminateCount = 0;

  get onmessage(): ((event: MessageEvent<unknown>) => void) | null {
    return this.#onmessage;
  }

  set onmessage(value: ((event: MessageEvent<unknown>) => void) | null) {
    this.#onmessage = value;
    if (value) this.onMessageSet?.(value);
  }

  postMessage(message: M4aAacDecoderCommand, transfer: readonly Transferable[] = []): void {
    if (message.type === 'open-decoder' && this.throwOnOpen) {
      throw new Error('failed open-decoder transfer');
    }
    this.messages.push({ message, transfer });
    if (message.type === 'open-decoder') this.onOpenPost?.(message);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: M4aAacDecoderEvent): void {
    this.emitUnknown(message);
  }

  emitUnknown(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

let fixtureBytes: Uint8Array;
let manifest: Readonly<M4aAacLcManifest>;

function harness(backendId: M4aAacDecoderBackendId = 'webcodecs') {
  const workers: FakeWorker[] = [];
  const channels: FakeMessageChannel[] = [];
  const closeSource = vi.fn(async () => undefined);
  const readAt = vi.fn(async (offset: number, length: number) =>
    fixtureBytes.slice(offset, offset + length),
  );
  const source: EncodedAudioSource = {
    kind: 'blob',
    size: manifest.sourceSize,
    identity: manifest.sourceIdentity,
    metadata: { name: 'fixture.m4a', mime: 'audio/mp4' },
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
  const adapter = new M4aAacDecoderAdapter({
    encodedSource: source,
    manifest,
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
    outputSampleRateHz: manifest.codec.sampleRateHz,
    pcmPort: port as unknown as MessagePort,
    signal,
  };
}

function openCommand(worker: FakeWorker): M4aAacDecoderOpenCommand {
  const command = worker.messages.find(({ message }) => message.type === 'open-decoder')?.message;
  if (!command || command.type !== 'open-decoder') {
    throw new Error('Expected M4A AAC open-decoder command');
  }
  return command;
}

function ready(
  command: M4aAacDecoderOpenCommand,
  backendId: M4aAacDecoderBackendId = command.backendId,
  descriptor = command.descriptor,
): M4aAacDecoderEvent {
  return {
    protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
    type: 'decoder-ready',
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    descriptor,
    backendId,
  };
}

function progress(
  command: M4aAacDecoderOpenCommand,
  patch: Readonly<
    Partial<Extract<M4aAacDecoderEvent, { readonly type: 'decode-progress' | 'decoder-eof' }>>
  > = {},
): M4aAacDecoderEvent {
  const startOrdinal = command.descriptor.startPlan.decodeStartAccessUnitOrdinal;
  return {
    protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
    type: 'decode-progress',
    sourceLifetimeGeneration: command.sourceLifetimeGeneration,
    decoderGeneration: command.decoderGeneration,
    nextAccessUnitOrdinal: startOrdinal,
    consumedEncodedBytes: 0,
    decodedRawCoreFrames: startOrdinal * 1_024,
    acceptedMediaFrames: 0,
    producedOutputFrames: 0,
    ...patch,
  };
}

function eof(command: M4aAacDecoderOpenCommand): M4aAacDecoderEvent {
  const expected = expectedM4aAacDecoderEofProgress(command.descriptor);
  return progress(command, { type: 'decoder-eof', ...expected });
}

beforeAll(async () => {
  const built = buildM4aAacFixture();
  fixtureBytes = built.bytes;
  manifest = await readM4aAacLcMetadata(built.source, new AbortController().signal);
});

afterAll(() => {
  fixtureBytes.fill(0);
});

describe('M4aAacDecoderAdapter', () => {
  it('keeps construction/open inert, accepts only issuer-authenticated same-source evidence, and closes once', async () => {
    const h = harness();
    expect(h.adapter.info).toEqual({
      mediaSampleRateHz: manifest.codec.sampleRateHz,
      channelCount: manifest.codec.channelCount,
      totalMediaFrames: manifest.timeline.totalMediaFrames,
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

    const cloneClose = vi.fn(async () => undefined);
    expect(
      () =>
        new M4aAacDecoderAdapter({
          encodedSource: { ...h.source, close: cloneClose },
          manifest: structuredClone(manifest),
          backendId: 'webcodecs',
          runtime: { createWorker: h.createWorker, createMessageChannel: h.createMessageChannel },
        }),
    ).toThrow(/manifest evidence|not issued/i);
    expect(cloneClose).not.toHaveBeenCalled();

    const foreignClose = vi.fn(async () => undefined);
    expect(
      () =>
        new M4aAacDecoderAdapter({
          encodedSource: { ...h.source, identity: 'source:foreign-m4a', close: foreignClose },
          manifest,
          backendId: 'webcodecs',
          runtime: { createWorker: h.createWorker, createMessageChannel: h.createMessageChannel },
        }),
    ).toThrow(/different encoded source/i);
    expect(foreignClose).not.toHaveBeenCalled();
  });

  it('uses a fresh lease, broker, Worker, and pinned backend for every non-EOF generation', async () => {
    const h = harness('webcodecs');
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const target = Math.min(2_000, manifest.timeline.totalMediaFrames - 1);

    const firstPending = h.adapter.startGeneration(request(1, target, new FakeMessagePort()));
    const firstWorker = h.workers[0];
    const firstChannel = h.channels[0];
    if (!firstWorker || !firstChannel) throw new Error('Expected first M4A AAC realm');
    const first = openCommand(firstWorker);
    expect(first.backendId).toBe('webcodecs');
    expect(first.sourcePort).toBe(firstChannel.port2);
    expect(firstWorker.messages[0]?.transfer).toEqual([firstChannel.port2, first.pcmPort]);
    firstWorker.emit(ready(first));
    await firstPending;

    firstWorker.emit(eof(first));
    expect(firstWorker.terminateCount).toBe(0);

    const secondPending = h.adapter.startGeneration(request(2, target, new FakeMessagePort()));
    const secondWorker = h.workers[1];
    const secondChannel = h.channels[1];
    if (!secondWorker || !secondChannel) throw new Error('Expected second M4A AAC realm');
    const second = openCommand(secondWorker);
    expect(second.sourceLifetimeGeneration).toBeGreaterThan(first.sourceLifetimeGeneration);
    expect(second.backendId).toBe('webcodecs');
    expect(second.sourcePort).toBe(secondChannel.port2);
    expect(firstWorker.terminateCount).toBe(1);
    expect(firstChannel.port1.closeCount).toBe(1);
    firstWorker.emitUnknown({ stale: true });
    expect(fatal).not.toHaveBeenCalled();
    secondWorker.emit(ready(second));
    await secondPending;
    await h.adapter.close();
  });

  it('preflights the descriptor before retiring an active realm or accepting the next PCM port', async () => {
    const h = harness();
    await h.adapter.open(options());
    const activePending = h.adapter.startGeneration(request(20, 0, new FakeMessagePort()));
    const activeWorker = h.workers[0];
    if (!activeWorker) throw new Error('Expected active M4A AAC realm');
    const activeCommand = openCommand(activeWorker);
    activeWorker.emit(ready(activeCommand));
    await activePending;

    const rejectedPort = new FakeMessagePort();
    await expect(h.adapter.startGeneration(request(21, -0, rejectedPort))).rejects.toThrow(
      /mediaFrame|safe integer/i,
    );
    expect(h.workers).toHaveLength(1);
    expect(activeWorker.terminateCount).toBe(0);
    expect(rejectedPort.closeCount).toBe(0);

    h.adapter.stopGeneration(20);
    await h.adapter.close();
  });

  it('fails closed on backend echo mismatch without substituting or opening another realm', async () => {
    const h = harness('webcodecs');
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const pending = h.adapter
      .startGeneration(request(3, 0, new FakeMessagePort()))
      .catch((error: unknown) => error);
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected M4A AAC realm');
    const command = openCommand(worker);

    worker.emit(ready(command, 'symphonia-wasm'));

    await expect(pending).resolves.toBeInstanceOf(Error);
    expect(worker.terminateCount).toBe(1);
    expect(h.createWorker).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith('decoder-backend-mismatch', expect.any(Error));
    await h.adapter.close();
  });

  it('requires the ready event to echo the exact descriptor', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const pending = h.adapter
      .startGeneration(request(4, 0, new FakeMessagePort()))
      .catch((error: unknown) => error);
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected M4A AAC realm');
    const command = openCommand(worker);
    const mismatched = createM4aAacDecoderDescriptor({
      manifest: command.descriptor.manifest,
      outputSampleRateHz: command.descriptor.outputSampleRateHz === 44_100 ? 48_000 : 44_100,
      mediaFrame: command.descriptor.startPlan.mediaFrame,
    });

    worker.emit(ready(command, command.backendId, mismatched));

    await expect(pending).resolves.toBeInstanceOf(Error);
    expect(worker.terminateCount).toBe(1);
    expect(fatal).toHaveBeenCalledWith('decoder-descriptor-mismatch', expect.any(Error));
    await h.adapter.close();
  });

  it('enforces all five logical counter bounds and whole-access-unit geometry', async () => {
    const invalidCases: ReadonlyArray<
      readonly [string, Readonly<Partial<M4aAacDecoderLogicalProgress>>]
    > = [
      [
        'nextAccessUnitOrdinal',
        {
          nextAccessUnitOrdinal: manifest.timeline.accessUnitCount + 1,
          decodedRawCoreFrames: manifest.timeline.rawCoreFrames,
        },
      ],
      [
        'consumedEncodedBytes',
        { consumedEncodedBytes: manifest.sampleSizes.totalEncodedBytes + 1 },
      ],
      ['decodedRawCoreFrames', { nextAccessUnitOrdinal: 1, decodedRawCoreFrames: 1_023 }],
      ['acceptedMediaFrames', { acceptedMediaFrames: manifest.timeline.totalMediaFrames + 1 }],
      ['producedOutputFrames', { producedOutputFrames: manifest.timeline.totalMediaFrames + 1 }],
    ];

    for (const [label, patch] of invalidCases) {
      const h = harness();
      const fatal = vi.fn();
      await h.adapter.open(options({ onFatal: fatal }));
      const pending = h.adapter.startGeneration(request(40, 0, new FakeMessagePort()));
      const worker = h.workers[0];
      if (!worker) throw new Error(`Expected M4A AAC realm for ${label}`);
      const command = openCommand(worker);
      worker.emit(ready(command));
      await pending;

      worker.emit(progress(command, patch));

      expect(fatal, label).toHaveBeenCalledWith('decoder-invalid-progress', expect.any(Error));
      expect(worker.terminateCount, label).toBe(1);
      await h.adapter.close();
    }
  });

  it('enforces monotonic progress and exact terminal counters', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const pending = h.adapter.startGeneration(request(41, 0, new FakeMessagePort()));
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected M4A AAC realm');
    const command = openCommand(worker);
    worker.emit(ready(command));
    await pending;

    const firstTwoBytes =
      M4A_AAC_FIXTURE_ACCESS_UNIT_SIZES[0] + M4A_AAC_FIXTURE_ACCESS_UNIT_SIZES[1];
    worker.emit(
      progress(command, {
        nextAccessUnitOrdinal: 2,
        consumedEncodedBytes: firstTwoBytes,
        decodedRawCoreFrames: 2_048,
        acceptedMediaFrames: 1_024,
        producedOutputFrames: 1_024,
      }),
    );
    expect(fatal).not.toHaveBeenCalled();

    worker.emit(
      progress(command, {
        nextAccessUnitOrdinal: 2,
        consumedEncodedBytes: firstTwoBytes - 1,
        decodedRawCoreFrames: 2_048,
        acceptedMediaFrames: 1_024,
        producedOutputFrames: 1_024,
      }),
    );
    expect(fatal).toHaveBeenCalledWith('decoder-invalid-progress', expect.any(Error));
    expect(worker.terminateCount).toBe(1);
    await h.adapter.close();

    const exact = harness();
    const exactFatal = vi.fn();
    await exact.adapter.open(options({ onFatal: exactFatal }));
    const exactPending = exact.adapter.startGeneration(request(42, 0, new FakeMessagePort()));
    const exactWorker = exact.workers[0];
    if (!exactWorker) throw new Error('Expected exact-EOF M4A AAC realm');
    const exactCommand = openCommand(exactWorker);
    exactWorker.emit(ready(exactCommand));
    await exactPending;
    exactWorker.emit(eof(exactCommand));
    expect(exactFatal).not.toHaveBeenCalled();
    expect(exactWorker.terminateCount).toBe(0);
    await exact.adapter.close();

    const inexact = harness();
    const inexactFatal = vi.fn();
    await inexact.adapter.open(options({ onFatal: inexactFatal }));
    const inexactPending = inexact.adapter.startGeneration(request(43, 0, new FakeMessagePort()));
    const inexactWorker = inexact.workers[0];
    if (!inexactWorker) throw new Error('Expected inexact-EOF M4A AAC realm');
    const inexactCommand = openCommand(inexactWorker);
    inexactWorker.emit(ready(inexactCommand));
    await inexactPending;
    const expected = expectedM4aAacDecoderEofProgress(inexactCommand.descriptor);
    inexactWorker.emit(
      progress(inexactCommand, {
        type: 'decoder-eof',
        ...expected,
        producedOutputFrames: expected.producedOutputFrames - 1,
      }),
    );
    expect(inexactFatal).toHaveBeenCalledWith('decoder-invalid-progress', expect.any(Error));
    expect(inexactWorker.terminateCount).toBe(1);
    await inexact.adapter.close();
  });

  it('serves exclusive EOF locally after one exact demand and retains it until explicit stop', async () => {
    const h = harness();
    await h.adapter.open(options());
    const port = new FakeMessagePort();
    await h.adapter.startGeneration(request(5, manifest.timeline.totalMediaFrames, port));
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

    await expect(
      h.adapter.startGeneration(request(50, manifest.timeline.totalMediaFrames, port)),
    ).rejects.toThrow(/adapter was closed/i);
    expect(port.closeCount).toBe(1);
    expect(h.workers).toHaveLength(0);
  });

  it('gives an EOF-start abort exact precedence over a later injected port error', async () => {
    const h = harness();
    await h.adapter.open(options());
    const controller = new AbortController();
    const reason = Object.freeze({ code: 'm4a-eof-start-abort' });
    const port = new FakeMessagePort();
    port.onStart = () => {
      controller.abort(reason);
      throw new Error('later port failure');
    };

    await expect(
      h.adapter
        .startGeneration(request(51, manifest.timeline.totalMediaFrames, port, controller.signal))
        .catch((error: unknown) => error),
    ).resolves.toBe(reason);
    expect(port.closeCount).toBe(1);
    await h.adapter.close();
  });

  it('preserves exact generation and lifetime abort reasons and ignores retired callbacks', async () => {
    const h = harness();
    const fatal = vi.fn();
    await h.adapter.open(options({ onFatal: fatal }));
    const controller = new AbortController();
    const pending = h.adapter
      .startGeneration(request(6, 0, new FakeMessagePort(), controller.signal))
      .catch((error: unknown) => error);
    const worker = h.workers[0];
    if (!worker) throw new Error('Expected abortable M4A AAC realm');
    const reason = Object.freeze({ code: 'm4a-seek-replaced' });
    controller.abort(reason);

    await expect(pending).resolves.toBe(reason);
    expect(worker.terminateCount).toBe(1);
    worker.emitUnknown({ malformed: true });
    expect(fatal).not.toHaveBeenCalled();
    await h.adapter.close();

    const lifetimeHarness = harness();
    const lifetime = new AbortController();
    await lifetimeHarness.adapter.open(options({ lifetimeSignal: lifetime.signal }));
    const lifetimePending = lifetimeHarness.adapter
      .startGeneration(request(7, 0, new FakeMessagePort()))
      .catch((error: unknown) => error);
    const lifetimeReason = Object.freeze({ code: 'm4a-source-lifetime-ended' });
    lifetime.abort(lifetimeReason);

    await expect(lifetimePending).resolves.toBe(lifetimeReason);
    expect(lifetimeHarness.workers[0]?.terminateCount).toBe(1);
    expect(lifetimeHarness.closeSource).toHaveBeenCalledTimes(1);
  });

  it('defers cleanup across reentrant postMessage abort and never reclaims transferred ports', async () => {
    const h = harness();
    const controller = new AbortController();
    const reason = Object.freeze({ code: 'm4a-abort-during-transfer' });
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
    const reason = Object.freeze({ code: 'm4a-ready-then-abort' });
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
    const descriptor = createM4aAacDecoderDescriptor({
      manifest,
      outputSampleRateHz: manifest.codec.sampleRateHz,
      mediaFrame: 0,
    });
    h.createWorker.mockImplementationOnce(() => {
      const worker = new FakeWorker();
      worker.onMessageSet = (handler) => {
        handler({
          data: {
            protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
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
    let adapter!: M4aAacDecoderAdapter;
    let reentrantClose: Promise<void> | null = null;
    const closeSource = vi.fn(() => {
      reentrantClose = adapter.close();
      return Promise.resolve();
    });
    const source: EncodedAudioSource = {
      kind: 'blob',
      size: manifest.sourceSize,
      identity: manifest.sourceIdentity,
      metadata: { name: 'fixture.m4a', mime: 'audio/mp4' },
      readAt: async (offset, length) => fixtureBytes.slice(offset, offset + length),
      close: closeSource,
    };
    adapter = new M4aAacDecoderAdapter({
      encodedSource: source,
      manifest,
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

    await expect(h.adapter.startGeneration(request(70, 0, pcm))).rejects.toThrow(
      /open-decoder transfer/i,
    );
    expect(h.workers[0]?.terminateCount).toBe(1);
    expect(h.channels[0]?.port1.closeCount).toBe(1);
    expect(h.channels[0]?.port2.closeCount).toBe(1);
    expect(pcm.closeCount).toBe(1);
    await h.adapter.close();
  });
});

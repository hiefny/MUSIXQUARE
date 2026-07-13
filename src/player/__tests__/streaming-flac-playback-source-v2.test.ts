import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  StreamingFlacPlaybackSource,
  type StreamingFlacPlaybackRuntime,
} from '../backends/streaming-flac-playback-source.ts';
import type { FlacMetadata } from '../flac/metadata.ts';
import {
  FLAC_STREAM_PROTOCOL_VERSION,
  type FlacDecoderCommand,
  type FlacDecoderEvent,
} from '../flac/stream-protocol.ts';
import type { PcmRingCommand, PcmRingEvent } from '../streaming/pcm-stream-protocol.ts';
import type { RendezvousArmIntent, RendezvousFinalizeIntent } from '../rendezvous-contract.ts';
import type {
  FilePlaybackPauseTransitionIntent,
  FilePlaybackSeekTransitionIntent,
} from '../file-playback-source.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';

const QID = '00000000-0000-4000-8000-000000000101' as QueueItemId;
const OTHER_QID = '00000000-0000-4000-8000-000000000202' as QueueItemId;
const SOURCE_RATE = 96_000;
const OUTPUT_RATE = 48_000;
const TOTAL_SOURCE_SAMPLES = SOURCE_RATE * 10;

class FakeAudioContext {
  #currentTime = 1;
  roomNowMs = 1_000;
  state: AudioContextState = 'running';
  readonly sampleRate = OUTPUT_RATE;
  onCurrentTimeRead: (() => void) | null = null;

  get currentTime(): number {
    this.onCurrentTimeRead?.();
    return this.#currentTime;
  }

  set currentTime(value: number) {
    this.#currentTime = value;
    this.roomNowMs = value * 1_000;
  }
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
  onmessage: ((event: MessageEvent<PcmRingEvent>) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
  closeCount = 0;
  startCount = 0;
  throwOnType: string | null = null;
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    if (
      this.throwOnType &&
      message !== null &&
      typeof message === 'object' &&
      (message as Record<string, unknown>).type === this.throwOnType
    ) {
      throw new Error(`Synthetic ${this.throwOnType} post failure`);
    }
    this.messages.push({ message, transfer });
  }

  start(): void {
    this.startCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }

  emit(message: PcmRingEvent): void {
    this.onmessage?.({ data: message } as MessageEvent<PcmRingEvent>);
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
  terminateCount = 0;

  postMessage(message: FlacDecoderCommand, transfer: readonly Transferable[] = []): void {
    this.messages.push({ message, transfer });
    if (message.type === 'open-source') {
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

class FakeAudioWorkletNode extends FakeAudioNode {
  readonly port = new FakeMessagePort();
  onprocessorerror: ((event: Event) => void) | null = null;
}

function metadata(): FlacMetadata {
  return Object.freeze({
    streamInfo: Object.freeze({
      minBlockSize: 4_096,
      maxBlockSize: 4_096,
      minFrameSize: 100,
      maxFrameSize: 10_000,
      sampleRate: SOURCE_RATE,
      channels: 2,
      bitDepth: 24,
      totalSamples: TOTAL_SOURCE_SAMPLES,
      duration: 10,
      md5: '00000000000000000000000000000000',
    }),
    seekPoints: Object.freeze([]),
    firstAudioFrameOffset: 42,
    metadataBlockCount: 1,
  });
}

function armIntent(overrides: Partial<RendezvousArmIntent> = {}): RendezvousArmIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-arm',
    queueItemId: QID,
    runId: 'run-stream-1',
    revision: 1,
    rendezvousId: 'rv-stream-1',
    recipientId: 'peer-1',
    positionSeconds: 0,
    playbackRate: 1,
    startAtRoomTimeMs: 2_000,
    finalizeByRoomTimeMs: 1_800,
    ...overrides,
  };
}

function finalizeIntent(
  overrides: Partial<RendezvousFinalizeIntent> = {},
): RendezvousFinalizeIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalize',
    queueItemId: QID,
    runId: 'run-stream-1',
    revision: 1,
    rendezvousId: 'rv-stream-1',
    recipientId: 'peer-1',
    startAtRoomTimeMs: 2_000,
    finalizedAtRoomTimeMs: 1_700,
    ...overrides,
  };
}

function pauseTransition(
  overrides: Partial<FilePlaybackPauseTransitionIntent> = {},
): FilePlaybackPauseTransitionIntent {
  return {
    kind: 'file-playback-pause-transition',
    from: { queueItemId: QID, runId: 'run-stream-1', revision: 1 },
    to: { queueItemId: QID, runId: 'run-stream-1', revision: 2 },
    atRoomTimeMs: 3_000,
    ...overrides,
  };
}

function seekTransition(
  overrides: Partial<FilePlaybackSeekTransitionIntent> = {},
): FilePlaybackSeekTransitionIntent {
  return {
    kind: 'file-playback-seek-transition',
    from: { queueItemId: QID, runId: 'run-stream-1', revision: 2 },
    to: { queueItemId: QID, runId: 'run-stream-1', revision: 3 },
    positionSeconds: 2,
    atRoomTimeMs: 4_000,
    ...overrides,
  };
}

function harness(
  loadWorklet: () => Promise<void> = async () => undefined,
  sourceMetadata: FlacMetadata = metadata(),
  nowRoomTimeMs?: () => number,
  roomTimeMsToContextTime: (roomTimeMs: number) => number = (roomTimeMs) => roomTimeMs / 1_000,
) {
  const context = new FakeAudioContext();
  const destination = new FakeAudioNode(context);
  const worker = new FakeWorker();
  const node = new FakeAudioWorkletNode(context);
  const channels: FakeMessageChannel[] = [];
  const closeEncodedSource = vi.fn(async () => undefined);
  const encodedSource: EncodedAudioSource = {
    kind: 'blob',
    size: 256,
    identity: 'source:test-streaming-flac',
    metadata: { name: 'fixture.flac', mime: 'audio/flac' },
    readAt: async (offset, length) =>
      Uint8Array.from({ length }, (_value, index) => offset + index),
    close: closeEncodedSource,
  };
  let workletLoadCount = 0;
  let nodeOptions: AudioWorkletNodeOptions | null = null;

  const runtime: StreamingFlacPlaybackRuntime = {
    loadWorklet: async () => {
      workletLoadCount += 1;
      await loadWorklet();
    },
    createWorker: () => worker as unknown as Worker,
    createWorkletNode: (_audioContext, name, options) => {
      expect(name).toBe('musixquare-pcm-ring-v2');
      nodeOptions = options;
      return node as unknown as AudioWorkletNode;
    },
    createMessageChannel: () => {
      const channel = new FakeMessageChannel();
      channels.push(channel);
      return channel as unknown as MessageChannel;
    },
  };
  const source = new StreamingFlacPlaybackSource({
    queueItemId: QID,
    encodedSource,
    metadata: sourceMetadata,
    audioContext: context as unknown as AudioContext,
    nowRoomTimeMs: nowRoomTimeMs ?? (() => context.roomNowMs),
    roomTimeMsToContextTime,
    localPerformanceMsToContextTime: (performanceTimeMs) => performanceTimeMs / 1_000,
    runtime,
  });

  return {
    context,
    destination,
    worker,
    node,
    channels,
    encodedSource,
    closeEncodedSource,
    source,
    get workletLoadCount() {
      return workletLoadCount;
    },
    get nodeOptions() {
      return nodeOptions;
    },
  };
}

function lastWorkerInit(worker: FakeWorker) {
  const init = worker.messages.findLast(({ message }) => message.type === 'init-decoder')?.message;
  if (!init || init.type !== 'init-decoder') {
    throw new Error('Expected a FLAC decoder init command');
  }
  return init;
}

function controlMessages(node: FakeAudioWorkletNode): PcmRingCommand[] {
  return node.port.messages.map(({ message }) => message as PcmRingCommand);
}

async function beginPrepare(
  source: StreamingFlacPlaybackSource,
  worker: FakeWorker,
): Promise<{ preparing: Promise<unknown> }> {
  const preparing = source.prepare();
  for (let turn = 0; turn < 20; turn += 1) {
    if (worker.messages.some(({ message }) => message.type === 'init-decoder')) {
      return { preparing };
    }
    await Promise.resolve();
  }
  throw new Error('Streaming FLAC runtime did not post its init command');
}

function emitDecoderReady(worker: FakeWorker): void {
  const init = lastWorkerInit(worker);
  worker.emit({
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'decoder-ready',
    sourceLifetimeGeneration: init.sourceLifetimeGeneration,
    decoderGeneration: init.decoderGeneration,
    descriptor: init.descriptor,
  });
}

function emitPrimed(node: FakeAudioWorkletNode, generation: number, bufferedFrames = 192_000) {
  node.port.emit({
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'primed',
    generation,
    bufferedFrames,
    sampleRate: OUTPUT_RATE,
    channels: 2,
  });
}

async function prepare(
  source: StreamingFlacPlaybackSource,
  worker: FakeWorker,
  node: FakeAudioWorkletNode,
) {
  const { preparing } = await beginPrepare(source, worker);
  emitDecoderReady(worker);
  emitPrimed(node, lastWorkerInit(worker).decoderGeneration);
  await preparing;
}

async function arm(
  source: StreamingFlacPlaybackSource,
  node: FakeAudioWorkletNode,
  intent = armIntent(),
) {
  const pending = source.arm(intent);
  await Promise.resolve();
  const command = controlMessages(node).findLast((message) => message.type === 'arm');
  if (!command || command.type !== 'arm') throw new Error('Expected a PCM ring arm command');
  node.port.emit({
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'armed',
    generation: command.generation,
    revision: command.revision,
    runId: command.runId,
    rendezvousId: command.rendezvousId,
    targetFrame: command.targetFrame,
  });
  return pending;
}

async function startPlaying(h: ReturnType<typeof harness>): Promise<void> {
  await prepare(h.source, h.worker, h.node);
  await h.source.connect(h.destination as unknown as AudioNode);
  await arm(h.source, h.node);
  h.context.currentTime = 1.7;
  const finalizing = h.source.finalize(finalizeIntent());
  await Promise.resolve();
  const command = controlMessages(h.node).findLast((message) => message.type === 'finalize');
  if (!command || command.type !== 'finalize') throw new Error('Expected finalize command');
  const armed = controlMessages(h.node).findLast((message) => message.type === 'arm');
  if (!armed || armed.type !== 'arm') throw new Error('Expected arm command');
  h.node.port.emit({
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'finalized',
    generation: command.generation,
    revision: command.revision,
    runId: command.runId,
    rendezvousId: command.rendezvousId,
    targetFrame: armed.targetFrame,
  });
  await finalizing;
  h.node.port.emit({
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'started',
    generation: command.generation,
    revision: command.revision,
    runId: command.runId,
    rendezvousId: command.rendezvousId,
    targetFrame: armed.targetFrame,
    actualStartFrame: armed.targetFrame,
    mediaFrame: 0,
  });
}

async function applyRevisionedPause(h: ReturnType<typeof harness>) {
  h.context.currentTime = 2.5;
  const pause = await h.source.pauseRevisioned(pauseTransition());
  if (pause.status !== 'scheduled') throw new Error('Expected scheduled pause');
  h.context.currentTime = 3;
  h.node.port.emit({
    protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
    type: 'paused',
    generation: 1,
    revision: 1,
    runId: 'run-stream-1',
    rendezvousId: 'rv-stream-1',
    targetFrame: 144_000,
    actualPauseFrame: 144_000,
    mediaFrame: OUTPUT_RATE,
  });
  await pause.applied;
  return pause;
}

describe('StreamingFlacPlaybackSource v2', () => {
  it('canonicalizes a hostile arm Proxy before queuing the control operation', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    let getCalls = 0;
    const proxied = new Proxy(armIntent(), {
      get() {
        getCalls += 1;
        throw new Error('dynamic [[Get]] must not run');
      },
    });
    await expect(arm(h.source, h.node, proxied)).resolves.toMatchObject({ status: 'armed' });
    expect(getCalls).toBe(0);

    const accessor = {
      ...armIntent({ revision: 2, runId: 'run-stream-2', rendezvousId: 'rv-stream-2' }),
    };
    Object.defineProperty(accessor, 'positionSeconds', {
      enumerable: true,
      get() {
        getCalls += 1;
        return 0;
      },
    });
    await expect(h.source.arm(accessor)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-contract',
    });
    expect(getCalls).toBe(0);
    await h.source.destroy();
  });

  it('does not finalize an arm cancelled by a reentrant intent Proxy', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    const hostileFinalize = new Proxy(finalizeIntent(), {
      ownKeys(target) {
        void h.source.cancel({
          kind: 'file-playback-cancel',
          queueItemId: QID,
          runId: 'run-stream-1',
          revision: 1,
          rendezvousId: 'rv-stream-1',
          reasonCode: 'proxy-reentered-cancel',
        });
        return Reflect.ownKeys(target);
      },
    });

    await expect(h.source.finalize(hostileFinalize)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'operation-superseded',
    });
    expect(controlMessages(h.node).some((message) => message.type === 'finalize')).toBe(false);
    expect(h.source.getSnapshot()).toMatchObject({ phase: 'cancelled' });
    await h.source.destroy();
  });

  it('does not let a stale rendezvous cancel reentry supersede exact finalization', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.7;
    const hostileFinalize = new Proxy(finalizeIntent(), {
      ownKeys(target) {
        void h.source.cancel({
          kind: 'file-playback-cancel',
          queueItemId: QID,
          runId: 'run-stream-1',
          revision: 1,
          rendezvousId: 'rv-stale',
          reasonCode: 'stale-reentrant-cancel',
        });
        return Reflect.ownKeys(target);
      },
    });

    const finalizing = h.source.finalize(hostileFinalize);
    await Promise.resolve();
    const finalizeCommand = controlMessages(h.node).findLast(
      (message) => message.type === 'finalize',
    );
    if (!finalizeCommand || finalizeCommand.type !== 'finalize') {
      throw new Error('Expected a PCM ring finalize command');
    }
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: finalizeCommand.generation,
      revision: finalizeCommand.revision,
      runId: finalizeCommand.runId,
      rendezvousId: finalizeCommand.rendezvousId,
      targetFrame: 96_000,
    });

    await expect(finalizing).resolves.toMatchObject({ status: 'accepted', reasonCode: null });
    expect(controlMessages(h.node).some((message) => message.type === 'cancel')).toBe(false);
    await h.source.destroy();
  });

  it('does not expire a due arm while rejecting a stale rendezvous cancel', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.9;
    const cancelCount = controlMessages(h.node).filter(
      (message) => message.type === 'cancel',
    ).length;

    await expect(
      h.source.cancel({
        kind: 'file-playback-cancel',
        queueItemId: QID,
        runId: 'run-stream-1',
        revision: 1,
        rendezvousId: 'rv-stale',
        reasonCode: 'stale-after-finalize-deadline',
      }),
    ).resolves.toMatchObject({ phase: 'armed' });
    expect(controlMessages(h.node).filter((message) => message.type === 'cancel')).toHaveLength(
      cancelCount,
    );

    expect(h.source.getSnapshot()).toMatchObject({ phase: 'paused' });
    expect(controlMessages(h.node).filter((message) => message.type === 'cancel')).toHaveLength(
      cancelCount + 1,
    );
    await h.source.destroy();
  });

  it('does not expire an arm when the room-clock callback starts finalization', async () => {
    let triggerFinalize = false;
    let finalizing: Promise<unknown> | null = null;
    let h!: ReturnType<typeof harness>;
    h = harness(
      async () => undefined,
      metadata(),
      () => {
        if (triggerFinalize) {
          triggerFinalize = false;
          finalizing = h.source.finalize(finalizeIntent());
          return 1_900;
        }
        return h.context.roomNowMs;
      },
    );
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.7;
    triggerFinalize = true;

    expect(h.source.getSnapshot()).toMatchObject({ phase: 'armed', revision: 1 });
    const command = controlMessages(h.node).findLast((message) => message.type === 'finalize');
    if (!command || command.type !== 'finalize') throw new Error('Missing finalize command');
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: command.generation,
      revision: command.revision,
      runId: command.runId,
      rendezvousId: command.rendezvousId,
      targetFrame: 96_000,
    });
    await expect(finalizing).resolves.toMatchObject({ status: 'accepted', reasonCode: null });
    expect(controlMessages(h.node).filter((message) => message.type === 'cancel')).toHaveLength(0);
    await h.source.destroy();
  });

  it('does not post a stale arm after a clock callback starts a newer operation', async () => {
    let countArmClockReads = false;
    let armClockReads = 0;
    let nestedArm: Promise<unknown> | null = null;
    let h!: ReturnType<typeof harness>;
    h = harness(
      async () => undefined,
      metadata(),
      () => {
        if (countArmClockReads) {
          armClockReads += 1;
          if (armClockReads === 2) {
            countArmClockReads = false;
            nestedArm = h.source.arm(
              armIntent({
                revision: 2,
                runId: 'run-stream-2',
                rendezvousId: 'rv-stream-2',
                startAtRoomTimeMs: 3_000,
                finalizeByRoomTimeMs: 2_800,
              }),
            );
          }
        }
        return h.context.roomNowMs;
      },
    );
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    countArmClockReads = true;

    await expect(h.source.arm(armIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'operation-superseded',
    });
    const commands = controlMessages(h.node).filter((message) => message.type === 'arm');
    expect(commands).toHaveLength(1);
    const command = commands[0];
    if (!command || command.type !== 'arm') throw new Error('Missing newer arm command');
    expect(command).toMatchObject({ revision: 2, runId: 'run-stream-2' });
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'armed',
      generation: command.generation,
      revision: command.revision,
      runId: command.runId,
      rendezvousId: command.rendezvousId,
      targetFrame: command.targetFrame,
    });
    await expect(nestedArm).resolves.toMatchObject({ status: 'armed' });
    expect(h.source.getSnapshot()).toMatchObject({
      revision: 2,
      run: { runId: 'run-stream-2', revision: 2 },
    });
    await h.source.destroy();
  });

  it('does not post a stale playing-seek pause after mapper reentry cancels it', async () => {
    let triggerCancel = false;
    let h!: ReturnType<typeof harness>;
    h = harness(
      async () => undefined,
      metadata(),
      undefined,
      (roomTimeMs) => {
        if (triggerCancel) {
          triggerCancel = false;
          void h.source.cancel({
            kind: 'file-playback-cancel',
            queueItemId: QID,
            runId: 'run-stream-1',
            revision: 1,
            rendezvousId: 'rv-stream-1',
            reasonCode: 'mapper-reentered-cancel',
          });
        }
        return roomTimeMs / 1_000;
      },
    );
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.7;
    const finalizing = h.source.finalize(finalizeIntent());
    const finalizeCommand = controlMessages(h.node).findLast(
      (message) => message.type === 'finalize',
    );
    if (!finalizeCommand || finalizeCommand.type !== 'finalize') {
      throw new Error('Missing finalize command');
    }
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: finalizeCommand.generation,
      revision: finalizeCommand.revision,
      runId: finalizeCommand.runId,
      rendezvousId: finalizeCommand.rendezvousId,
      targetFrame: 96_000,
    });
    await finalizing;
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'started',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: 96_000,
      actualStartFrame: 96_000,
      mediaFrame: 0,
    });
    expect(h.source.getSnapshot().phase).toBe('playing');
    const pauseCommandsBefore = controlMessages(h.node).filter(
      (message) => message.type === 'pause',
    ).length;
    triggerCancel = true;

    await h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      positionSeconds: 5,
      atRoomTimeMs: 2_500,
    });
    expect(h.source.getSnapshot().phase).toBe('cancelled');
    expect(controlMessages(h.node).filter((message) => message.type === 'pause')).toHaveLength(
      pauseCommandsBefore,
    );
    await h.source.destroy();
  });

  it('primes a bounded discrete ring off-graph and connects only after readiness', async () => {
    const h = harness();
    const { preparing } = await beginPrepare(h.source, h.worker);

    expect(h.workletLoadCount).toBe(1);
    expect(h.node.connections).toHaveLength(0);
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'preparing',
      backend: 'streaming-flac',
      durationSeconds: 10,
      channelCount: 2,
      outputSampleRateHz: OUTPUT_RATE,
    });
    expect(h.nodeOptions).toMatchObject({
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      processorOptions: {
        channels: 2,
        generation: 1,
        mediaFrame: 0,
        capacitySeconds: 12,
        primeSeconds: 4,
      },
    });
    expect(h.channels).toHaveLength(2);
    const sourceOpen = h.worker.messages.find(({ message }) => message.type === 'open-source');
    expect(sourceOpen?.message).toMatchObject({
      type: 'open-source',
      sourceSize: 256,
      sourceIdentity: h.encodedSource.identity,
    });
    if (!sourceOpen || sourceOpen.message.type !== 'open-source') {
      throw new Error('Expected encoded source open command');
    }
    expect(sourceOpen.transfer).toEqual([sourceOpen.message.sourcePort]);
    expect(lastWorkerInit(h.worker)).toMatchObject({
      decoderGeneration: 1,
      descriptor: {
        sourceSampleRate: SOURCE_RATE,
        outputSampleRate: OUTPUT_RATE,
        channels: 2,
        bitDepth: 24,
        totalSourceSamples: TOTAL_SOURCE_SAMPLES,
        firstAudioFrameOffset: 42,
        targetSourceSample: 0,
        decodeAnchorByteOffset: 42,
        decodeAnchorSourceSample: 0,
        minBlockSize: 4_096,
        maxBlockSize: 4_096,
        minFrameSize: 100,
        maxFrameSize: 10_000,
      },
    });

    // Either boundary may become ready first; publication waits for both.
    emitPrimed(h.node, 1);
    expect(h.source.getSnapshot().phase).toBe('preparing');
    emitDecoderReady(h.worker);
    await expect(preparing).resolves.toMatchObject({
      phase: 'ready',
      bufferedAheadSeconds: 4,
    });
    expect(h.node.connections).toHaveLength(0);

    await expect(h.source.connect(h.destination as unknown as AudioNode)).resolves.toMatchObject({
      phase: 'connected',
    });
    expect(h.node.connections).toEqual([h.destination]);

    const foreign = new FakeAudioNode(new FakeAudioContext());
    await expect(h.source.connect(foreign as unknown as AudioNode)).rejects.toThrow(
      /another AudioContext/,
    );
    await h.source.destroy();
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
  });

  it('arms and finalizes one immutable render frame, then derives position from ring status', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);

    await expect(arm(h.source, h.node)).resolves.toMatchObject({
      status: 'armed',
      observedAtRoomTimeMs: 1_000,
      bufferedAheadSeconds: 4,
    });
    const armCommand = controlMessages(h.node).findLast((message) => message.type === 'arm');
    expect(armCommand).toMatchObject({ targetFrame: 96_000, fadeInFrames: 0 });

    h.context.currentTime = 1.7;
    const finalizing = h.source.finalize(finalizeIntent());
    await Promise.resolve();
    const finalizeCommand = controlMessages(h.node).findLast(
      (message) => message.type === 'finalize',
    );
    if (!finalizeCommand || finalizeCommand.type !== 'finalize') {
      throw new Error('Expected a PCM ring finalize command');
    }
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: finalizeCommand.generation,
      revision: finalizeCommand.revision,
      runId: finalizeCommand.runId,
      rendezvousId: finalizeCommand.rendezvousId,
      targetFrame: 96_000,
    });
    await expect(finalizing).resolves.toMatchObject({ status: 'accepted' });

    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'started',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: 96_000,
      actualStartFrame: 96_000,
      mediaFrame: 0,
    });
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'status',
      generation: 1,
      state: 'playing',
      bufferedFrames: 168_000,
      mediaFrame: 24_000,
      renderFrame: 120_000,
      underruns: 0,
      overflows: 0,
    });
    expect(h.source.positionAt(2_500)).toMatchObject({
      phase: 'playing',
      positionSeconds: 0.5,
      bufferedAheadSeconds: 3.5,
      underrunCount: 0,
    });

    // Finalization retries are idempotent and never send a second commit.
    const finalizeCount = controlMessages(h.node).filter(
      (message) => message.type === 'finalize',
    ).length;
    await expect(h.source.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(controlMessages(h.node).filter((message) => message.type === 'finalize')).toHaveLength(
      finalizeCount,
    );
    await h.source.destroy();
  });

  it('single-flights an exact cutover target and resolves evidence only from the exact started event', async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      await prepare(h.source, h.worker, h.node);
      await h.source.connect(h.destination as unknown as AudioNode);

      const firstPromise = h.source.armForCutover(armIntent());
      const retryPromise = h.source.armForCutover(armIntent());
      expect(retryPromise).toBe(firstPromise);
      await Promise.resolve();
      const armCommand = controlMessages(h.node).findLast((message) => message.type === 'arm');
      if (!armCommand || armCommand.type !== 'arm') throw new Error('Missing arm command');
      h.node.port.emit({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'armed',
        generation: armCommand.generation,
        revision: armCommand.revision,
        runId: armCommand.runId,
        rendezvousId: armCommand.rendezvousId,
        targetFrame: armCommand.targetFrame,
      });
      const first = await firstPromise;
      expect(first.status).toBe('armed');
      if (first.status !== 'armed') throw new Error('Expected armed cutover');
      expect(first.target).toMatchObject({
        audioContext: h.context,
        contextTimeSeconds: 2,
        targetFrame: 96_000,
      });
      const activeRetry = await h.source.armForCutover(armIntent());
      expect(activeRetry).toBe(first);
      if (activeRetry.status !== 'armed') throw new Error('Expected armed retry');
      expect(activeRetry.target).toBe(first.target);
      expect(activeRetry.started).toBe(first.started);

      h.context.currentTime = 1.7;
      const finalizing = h.source.finalize(finalizeIntent());
      await Promise.resolve();
      const finalizeCommand = controlMessages(h.node).findLast(
        (message) => message.type === 'finalize',
      );
      if (!finalizeCommand || finalizeCommand.type !== 'finalize') {
        throw new Error('Missing finalize command');
      }
      h.node.port.emit({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'finalized',
        generation: finalizeCommand.generation,
        revision: finalizeCommand.revision,
        runId: finalizeCommand.runId,
        rendezvousId: finalizeCommand.rendezvousId,
        targetFrame: 96_000,
      });
      await finalizing;

      let evidenceState = 'pending';
      void first.started.then(
        () => {
          evidenceState = 'resolved';
        },
        () => {
          evidenceState = 'rejected';
        },
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(evidenceState).toBe('pending');
      h.node.port.emit({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'started',
        generation: armCommand.generation,
        revision: armCommand.revision,
        runId: armCommand.runId,
        rendezvousId: armCommand.rendezvousId,
        targetFrame: armCommand.targetFrame,
        actualStartFrame: armCommand.targetFrame,
        mediaFrame: 0,
      });
      await expect(first.started).resolves.toEqual({
        kind: 'worklet-observed',
        targetFrame: 96_000,
        actualStartFrame: 96_000,
      });
      expect(evidenceState).toBe('resolved');
    } finally {
      await h.source.destroy();
      vi.useRealTimers();
    }
  });

  it('returns the same pending arm promise after mutable render preflight has drifted', async () => {
    const h = harness(undefined, metadata(), () => 1_000);
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);

    const intent = armIntent();
    const first = h.source.armForCutover(intent);
    await Promise.resolve();
    const armCommand = controlMessages(h.node).findLast((message) => message.type === 'arm');
    if (!armCommand || armCommand.type !== 'arm') throw new Error('Missing arm command');

    // A fresh preflight would now reject start-not-in-future, but an exact
    // retransmission still owns the in-flight Worklet acknowledgement.
    h.context.currentTime = 2;
    const retry = h.source.armForCutover({ ...intent });
    expect(retry).toBe(first);

    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'armed',
      generation: armCommand.generation,
      revision: armCommand.revision,
      runId: armCommand.runId,
      rendezvousId: armCommand.rendezvousId,
      targetFrame: armCommand.targetFrame,
    });
    const result = await first;
    expect(result.status).toBe('armed');
    await expect(retry).resolves.toBe(result);
    await h.source.destroy();
  });

  it('rejects cutover evidence on an exact-identity Worklet start mismatch', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    const arming = h.source.armForCutover(armIntent());
    await Promise.resolve();
    const armCommand = controlMessages(h.node).findLast((message) => message.type === 'arm');
    if (!armCommand || armCommand.type !== 'arm') throw new Error('Missing arm command');
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'armed',
      generation: armCommand.generation,
      revision: armCommand.revision,
      runId: armCommand.runId,
      rendezvousId: armCommand.rendezvousId,
      targetFrame: armCommand.targetFrame,
    });
    const armed = await arming;
    if (armed.status !== 'armed') throw new Error('Expected armed cutover');

    h.context.currentTime = 1.7;
    const finalizing = h.source.finalize(finalizeIntent());
    await Promise.resolve();
    const finalizeCommand = controlMessages(h.node).findLast(
      (message) => message.type === 'finalize',
    );
    if (!finalizeCommand || finalizeCommand.type !== 'finalize') {
      throw new Error('Missing finalize command');
    }
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: finalizeCommand.generation,
      revision: finalizeCommand.revision,
      runId: finalizeCommand.runId,
      rendezvousId: finalizeCommand.rendezvousId,
      targetFrame: 96_000,
    });
    await finalizing;
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'started',
      generation: armCommand.generation,
      revision: armCommand.revision,
      runId: armCommand.runId,
      rendezvousId: armCommand.rendezvousId,
      targetFrame: armCommand.targetFrame,
      actualStartFrame: armCommand.targetFrame + 1,
      mediaFrame: 0,
    });

    await expect(armed.started).rejects.toMatchObject({
      name: 'FilePlaybackStartEvidenceError',
      code: 'worklet-start-target-mismatch',
    });
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'failed',
      errorCode: 'worklet-start-target-mismatch',
    });
    await h.source.destroy();
  });

  it('returns null cutover data on rejection and settles evidence on cancel and destroy', async () => {
    const cancelled = harness();
    await prepare(cancelled.source, cancelled.worker, cancelled.node);
    await cancelled.source.connect(cancelled.destination as unknown as AudioNode);
    cancelled.context.state = 'suspended';
    await expect(cancelled.source.armForCutover(armIntent())).resolves.toMatchObject({
      status: 'rejected',
      target: null,
      started: null,
      receipt: { status: 'rejected', reasonCode: 'audio-context-not-running' },
    });
    cancelled.context.state = 'running';
    const cancelledArm = await arm(cancelled.source, cancelled.node);
    const cancelledCutover = await cancelled.source.armForCutover(armIntent());
    expect(cancelledCutover.status).toBe('armed');
    expect(cancelledArm.status).toBe('armed');
    if (cancelledCutover.status !== 'armed') throw new Error('Expected armed cutover');
    await cancelled.source.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      rendezvousId: 'rv-stale',
      reasonCode: 'stale-attempt-cancel',
    });
    expect(cancelled.source.getSnapshot()).toMatchObject({ phase: 'armed' });
    await cancelled.source.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      rendezvousId: 'rv-stream-1',
      reasonCode: 'test-cancel',
    });
    await expect(cancelledCutover.started).rejects.toMatchObject({
      name: 'FilePlaybackStartEvidenceError',
    });
    await cancelled.source.destroy();

    const destroyed = harness();
    await prepare(destroyed.source, destroyed.worker, destroyed.node);
    await destroyed.source.connect(destroyed.destination as unknown as AudioNode);
    await arm(destroyed.source, destroyed.node);
    const destroyedCutover = await destroyed.source.armForCutover(armIntent());
    if (destroyedCutover.status !== 'armed') throw new Error('Expected armed cutover');
    await destroyed.source.destroy();
    await expect(destroyedCutover.started).rejects.toMatchObject({
      name: 'FilePlaybackStartEvidenceError',
      code: 'source-destroyed',
    });
  });

  it('bounds missing Worklet start evidence by the authoritative room clock', async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      await prepare(h.source, h.worker, h.node);
      await h.source.connect(h.destination as unknown as AudioNode);
      await arm(h.source, h.node);
      const armed = await h.source.armForCutover(armIntent());
      if (armed.status !== 'armed') throw new Error('Expected armed cutover');
      h.context.currentTime = 1.7;
      const finalizing = h.source.finalize(finalizeIntent());
      await Promise.resolve();
      const finalizeCommand = controlMessages(h.node).findLast(
        (message) => message.type === 'finalize',
      );
      if (!finalizeCommand || finalizeCommand.type !== 'finalize') {
        throw new Error('Missing finalize command');
      }
      h.node.port.emit({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'finalized',
        generation: finalizeCommand.generation,
        revision: finalizeCommand.revision,
        runId: finalizeCommand.runId,
        rendezvousId: finalizeCommand.rendezvousId,
        targetFrame: 96_000,
      });
      await finalizing;
      h.context.state = 'suspended';
      h.context.roomNowMs = 4_501;
      await vi.advanceTimersByTimeAsync(250);
      await expect(armed.started).rejects.toMatchObject({
        name: 'FilePlaybackStartEvidenceError',
        code: 'start-evidence-timeout',
      });
    } finally {
      await h.source.destroy();
      vi.useRealTimers();
    }
  });

  it('single-flights exact concurrent finalization and rejects a mismatched caller without mutation', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.7;

    const first = h.source.finalize(finalizeIntent());
    const duplicate = h.source.finalize(finalizeIntent());
    expect(duplicate).toBe(first);
    await expect(
      h.source.finalize(finalizeIntent({ rendezvousId: 'rv-stream-other' })),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'finalize-mismatch' });
    await Promise.resolve();
    const finalizeCommands = controlMessages(h.node).filter(
      (message) => message.type === 'finalize',
    );
    expect(finalizeCommands).toHaveLength(1);
    const command = finalizeCommands[0];
    if (!command || command.type !== 'finalize') throw new Error('Missing finalize command');
    expect(controlMessages(h.node).some((message) => message.type === 'cancel')).toBe(false);

    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: command.generation,
      revision: command.revision,
      runId: command.runId,
      rendezvousId: command.rendezvousId,
      targetFrame: 96_000,
    });
    const [firstReceipt, duplicateReceipt] = await Promise.all([first, duplicate]);
    expect(firstReceipt).toMatchObject({ status: 'accepted', reasonCode: null });
    expect(duplicateReceipt).toBe(firstReceipt);
    expect(controlMessages(h.node).filter((message) => message.type === 'finalize')).toHaveLength(
      1,
    );
    await h.source.destroy();
  });

  it('rejects a conflicting finalize without retiring the valid armed attempt', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.7;
    const cancelCount = controlMessages(h.node).filter(
      (message) => message.type === 'cancel',
    ).length;

    await expect(
      h.source.finalize(finalizeIntent({ rendezvousId: 'rv-stream-other' })),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'rendezvous-mismatch' });
    expect(h.source.getSnapshot()).toMatchObject({ phase: 'armed', errorCode: null });
    expect(controlMessages(h.node).filter((message) => message.type === 'cancel')).toHaveLength(
      cancelCount,
    );
    expect(controlMessages(h.node).filter((message) => message.type === 'finalize')).toHaveLength(
      0,
    );

    const finalizing = h.source.finalize(finalizeIntent());
    await Promise.resolve();
    const command = controlMessages(h.node).findLast((message) => message.type === 'finalize');
    if (!command || command.type !== 'finalize') throw new Error('Missing finalize command');
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: command.generation,
      revision: command.revision,
      runId: command.runId,
      rendezvousId: command.rendezvousId,
      targetFrame: 96_000,
    });
    await expect(finalizing).resolves.toMatchObject({ status: 'accepted', reasonCode: null });
    expect(controlMessages(h.node).filter((message) => message.type === 'cancel')).toHaveLength(
      cancelCount,
    );
    await h.source.destroy();
  });

  it('does not let snapshot expiry cancel a finalization already submitted before its deadline', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.7;
    const finalizing = h.source.finalize(finalizeIntent());
    await Promise.resolve();
    const command = controlMessages(h.node).findLast((message) => message.type === 'finalize');
    if (!command || command.type !== 'finalize') throw new Error('Missing finalize command');
    const cancelCount = controlMessages(h.node).filter(
      (message) => message.type === 'cancel',
    ).length;

    h.context.currentTime = 2.1;
    expect(h.source.getSnapshot()).toMatchObject({ phase: 'armed', errorCode: null });
    expect(controlMessages(h.node).filter((message) => message.type === 'cancel')).toHaveLength(
      cancelCount,
    );

    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: command.generation,
      revision: command.revision,
      runId: command.runId,
      rendezvousId: command.rendezvousId,
      targetFrame: 96_000,
    });
    await expect(finalizing).resolves.toMatchObject({ status: 'accepted', reasonCode: null });
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'started',
      generation: command.generation,
      revision: command.revision,
      runId: command.runId,
      rendezvousId: command.rendezvousId,
      targetFrame: 96_000,
      actualStartFrame: 96_000,
      mediaFrame: 0,
    });
    expect(h.source.getSnapshot()).toMatchObject({ phase: 'playing', errorCode: null });
    expect(controlMessages(h.node).filter((message) => message.type === 'cancel')).toHaveLength(
      cancelCount,
    );
    await h.source.destroy();
  });

  it('stays silent and paused when finalization never arrives', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);

    h.context.currentTime = 2;
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'rejected',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      code: 'arm-not-finalized',
    });
    expect(h.source.getSnapshot()).toMatchObject({ phase: 'paused', positionSeconds: 0 });
    expect(controlMessages(h.node).some((message) => message.type === 'finalize')).toBe(false);
    await h.source.destroy();
  });

  it('uses monotonic room time when AudioContext render time is frozen', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);

    h.context.roomNowMs = 1_900;
    await expect(h.source.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'missed-deadline',
      reasonCode: 'finalization-after-deadline',
      observedAtRoomTimeMs: 1_900,
    });
    expect(controlMessages(h.node).some((message) => message.type === 'finalize')).toBe(false);
    expect(controlMessages(h.node).at(-1)).toMatchObject({ type: 'cancel', generation: 1 });
    expect(h.source.getSnapshot().phase).toBe('paused');
    await h.source.destroy();
  });

  it('rejects arm and finalization while the shared AudioContext is not running', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);

    h.context.state = 'suspended';
    await expect(h.source.arm(armIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'audio-context-not-running',
    });
    h.context.state = 'running';
    await arm(h.source, h.node);
    h.context.state = 'suspended';
    await expect(h.source.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'audio-context-not-running',
    });
    expect(controlMessages(h.node).some((message) => message.type === 'finalize')).toBe(false);
    await h.source.destroy();
  });

  it('does not treat a pending but not yet issued finalize as Worklet start authority', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    const armed = await h.source.armForCutover(armIntent());
    if (armed.status !== 'armed') throw new Error('Expected armed cutover');
    h.context.currentTime = 1.7;

    h.context.onCurrentTimeRead = () => {
      h.context.onCurrentTimeRead = null;
      h.node.port.emit({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'started',
        generation: 1,
        revision: 1,
        runId: 'run-stream-1',
        rendezvousId: 'rv-stream-1',
        targetFrame: 96_000,
        actualStartFrame: 96_000,
        mediaFrame: 0,
      });
    };

    await expect(h.source.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'worklet-start-without-finalize',
    });
    await expect(armed.started).rejects.toMatchObject({
      name: 'FilePlaybackStartEvidenceError',
      code: 'worklet-start-without-finalize',
    });
    expect(controlMessages(h.node).some((message) => message.type === 'finalize')).toBe(false);
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'failed',
      errorCode: 'worklet-start-without-finalize',
    });
    await h.source.destroy();
  });

  it('rejects arm and finalize acknowledgements for a different render frame', async () => {
    const armMismatch = harness();
    await prepare(armMismatch.source, armMismatch.worker, armMismatch.node);
    await armMismatch.source.connect(armMismatch.destination as unknown as AudioNode);
    const arming = armMismatch.source.arm(armIntent());
    await Promise.resolve();
    const armCommand = controlMessages(armMismatch.node).findLast(
      (message) => message.type === 'arm',
    );
    if (!armCommand || armCommand.type !== 'arm') throw new Error('Missing arm command');
    armMismatch.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'armed',
      generation: armCommand.generation,
      revision: armCommand.revision,
      runId: armCommand.runId,
      rendezvousId: armCommand.rendezvousId,
      targetFrame: armCommand.targetFrame + 1,
    });
    await expect(arming).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'worklet-target-mismatch',
    });
    await armMismatch.source.destroy();

    const finalizeMismatch = harness();
    await prepare(finalizeMismatch.source, finalizeMismatch.worker, finalizeMismatch.node);
    await finalizeMismatch.source.connect(finalizeMismatch.destination as unknown as AudioNode);
    await arm(finalizeMismatch.source, finalizeMismatch.node);
    finalizeMismatch.context.currentTime = 1.7;
    const finalizing = finalizeMismatch.source.finalize(finalizeIntent());
    await Promise.resolve();
    const finalizeCommand = controlMessages(finalizeMismatch.node).findLast(
      (message) => message.type === 'finalize',
    );
    if (!finalizeCommand || finalizeCommand.type !== 'finalize') {
      throw new Error('Missing finalize command');
    }
    finalizeMismatch.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: finalizeCommand.generation,
      revision: finalizeCommand.revision,
      runId: finalizeCommand.runId,
      rendezvousId: finalizeCommand.rendezvousId,
      targetFrame: 96_001,
    });
    await expect(finalizing).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'worklet-target-mismatch',
    });
    expect(finalizeMismatch.source.getSnapshot()).toMatchObject({
      phase: 'failed',
      errorCode: 'worklet-target-mismatch',
    });
    await finalizeMismatch.source.destroy();
  });

  it('does not issue a destructive late cancel when a finalize acknowledgement is lost', async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      await prepare(h.source, h.worker, h.node);
      await h.source.connect(h.destination as unknown as AudioNode);
      await arm(h.source, h.node);
      h.context.currentTime = 1.7;
      const cancelCount = controlMessages(h.node).filter(
        (message) => message.type === 'cancel',
      ).length;

      const finalizing = h.source.finalize(finalizeIntent());
      let settled = false;
      void finalizing.then(() => {
        settled = true;
      });
      await Promise.resolve();
      h.context.currentTime = 2.1;
      await vi.advanceTimersByTimeAsync(300);
      expect(settled).toBe(false);
      expect(controlMessages(h.node).filter((message) => message.type === 'cancel')).toHaveLength(
        cancelCount,
      );

      h.node.port.emit({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'started',
        generation: 1,
        revision: 1,
        runId: 'run-stream-1',
        rendezvousId: 'rv-stream-1',
        targetFrame: 96_000,
        actualStartFrame: 96_000,
        mediaFrame: 0,
      });
      await expect(finalizing).resolves.toMatchObject({ status: 'accepted', reasonCode: null });
      expect(h.source.getSnapshot().phase).toBe('playing');
      await expect(h.source.finalize(finalizeIntent())).resolves.toMatchObject({
        status: 'accepted',
      });
      await h.source.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an exact started event as commit proof even when the sampled room clock is stale', async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      await prepare(h.source, h.worker, h.node);
      await h.source.connect(h.destination as unknown as AudioNode);
      await arm(h.source, h.node);
      h.context.currentTime = 1.7;
      const cancelCount = controlMessages(h.node).filter(
        (message) => message.type === 'cancel',
      ).length;
      const finalizing = h.source.finalize(finalizeIntent());
      await Promise.resolve();

      h.node.port.emit({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'started',
        generation: 1,
        revision: 1,
        runId: 'run-stream-1',
        rendezvousId: 'rv-stream-1',
        targetFrame: 96_000,
        actualStartFrame: 96_000,
        mediaFrame: 0,
      });
      expect(h.source.getSnapshot().phase).toBe('playing');
      await vi.advanceTimersByTimeAsync(300);
      await expect(finalizing).resolves.toMatchObject({ status: 'accepted', reasonCode: null });
      expect(controlMessages(h.node).filter((message) => message.type === 'cancel')).toHaveLength(
        cancelCount,
      );
      await h.source.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed with an explicit unknown receipt when post-target commit evidence never arrives', async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      await prepare(h.source, h.worker, h.node);
      await h.source.connect(h.destination as unknown as AudioNode);
      await arm(h.source, h.node);
      h.context.currentTime = 1.7;
      const cancelCount = controlMessages(h.node).filter(
        (message) => message.type === 'cancel',
      ).length;

      const finalizing = h.source.finalize(finalizeIntent());
      let settled = false;
      void finalizing.then(() => {
        settled = true;
      });
      await Promise.resolve();
      h.context.currentTime = 2.1;
      await vi.advanceTimersByTimeAsync(300);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(4_000);
      await expect(finalizing).resolves.toMatchObject({
        status: 'rejected',
        reasonCode: 'commit-status-unknown',
      });
      expect(controlMessages(h.node).filter((message) => message.type === 'cancel')).toHaveLength(
        cancelCount,
      );
      expect(h.source.getSnapshot()).toMatchObject({
        phase: 'failed',
        errorCode: 'commit-status-unknown',
      });

      h.node.port.emit({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'started',
        generation: 1,
        revision: 1,
        runId: 'run-stream-1',
        rendezvousId: 'rv-stream-1',
        targetFrame: 96_000,
        actualStartFrame: 96_000,
        mediaFrame: 0,
      });
      expect(h.source.getSnapshot().phase).toBe('failed');
      await h.source.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a post-target finalize timeout from an exact fail-silent Worklet rejection', async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      await prepare(h.source, h.worker, h.node);
      await h.source.connect(h.destination as unknown as AudioNode);
      await arm(h.source, h.node);
      h.context.currentTime = 1.7;
      const finalizing = h.source.finalize(finalizeIntent());
      await Promise.resolve();
      h.context.currentTime = 2.1;
      await vi.advanceTimersByTimeAsync(300);

      h.node.port.emit({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'rejected',
        generation: 1,
        revision: 1,
        runId: 'run-stream-1',
        rendezvousId: 'rv-stream-1',
        code: 'arm-target-missed',
      });
      await expect(finalizing).resolves.toMatchObject({
        status: 'missed-deadline',
        reasonCode: 'arm-target-missed',
      });
      expect(h.source.getSnapshot()).toMatchObject({ phase: 'paused', errorCode: null });
      await h.source.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores unqualified Worklet rejections while exact arm and finalize ACKs are pending', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);

    const arming = h.source.arm(armIntent());
    let armSettled = false;
    void arming.then(() => {
      armSettled = true;
    });
    await Promise.resolve();
    const armCommand = controlMessages(h.node).findLast((message) => message.type === 'arm');
    if (!armCommand || armCommand.type !== 'arm') throw new Error('Missing arm command');
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'rejected',
      generation: armCommand.generation,
      code: 'unrelated-worklet-rejection',
    });
    await Promise.resolve();
    expect(armSettled).toBe(false);
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'armed',
      generation: armCommand.generation,
      revision: armCommand.revision,
      runId: armCommand.runId,
      rendezvousId: armCommand.rendezvousId,
      targetFrame: armCommand.targetFrame,
    });
    await expect(arming).resolves.toMatchObject({ status: 'armed' });

    h.context.currentTime = 1.7;
    const finalizing = h.source.finalize(finalizeIntent());
    let finalizeSettled = false;
    void finalizing.then(() => {
      finalizeSettled = true;
    });
    await Promise.resolve();
    const finalizeCommand = controlMessages(h.node).findLast(
      (message) => message.type === 'finalize',
    );
    if (!finalizeCommand || finalizeCommand.type !== 'finalize') {
      throw new Error('Missing finalize command');
    }
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'rejected',
      generation: finalizeCommand.generation,
      code: 'unrelated-worklet-rejection',
    });
    await Promise.resolve();
    expect(finalizeSettled).toBe(false);
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: finalizeCommand.generation,
      revision: finalizeCommand.revision,
      runId: finalizeCommand.runId,
      rendezvousId: finalizeCommand.rendezvousId,
      targetFrame: 96_000,
    });
    await expect(finalizing).resolves.toMatchObject({ status: 'accepted' });
    await h.source.destroy();
  });

  it('does not overwrite a terminal command failure with a paused phase', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.7;
    h.node.port.throwOnType = 'finalize';

    await expect(h.source.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'worklet-command-failed',
    });
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'failed',
      errorCode: 'worklet-command-failed',
    });
    expect(h.worker.terminateCount).toBe(1);
    await h.source.destroy();
  });

  it('does not let semantically invalid higher-revision arms disturb audible output', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.7;
    const finalizing = h.source.finalize(finalizeIntent());
    await Promise.resolve();
    const finalizeCommand = controlMessages(h.node).findLast(
      (message) => message.type === 'finalize',
    );
    if (!finalizeCommand || finalizeCommand.type !== 'finalize') {
      throw new Error('Missing finalize command');
    }
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: finalizeCommand.generation,
      revision: finalizeCommand.revision,
      runId: finalizeCommand.runId,
      rendezvousId: finalizeCommand.rendezvousId,
      targetFrame: 96_000,
    });
    await finalizing;
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'started',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: 96_000,
      actualStartFrame: 96_000,
      mediaFrame: 0,
    });
    h.context.currentTime = 2.1;

    const messageCount = h.node.port.messages.length;
    const invalidCases = [
      {
        intent: armIntent({
          queueItemId: OTHER_QID,
          revision: 2,
          runId: 'run-stream-2',
          rendezvousId: 'rv-stream-2',
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
        reasonCode: 'queue-item-mismatch',
      },
      {
        intent: armIntent({
          revision: 2,
          runId: 'run-stream-2',
          rendezvousId: 'rv-stream-2',
          playbackRate: 1.25,
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
        reasonCode: 'unsupported-playback-rate',
      },
      {
        intent: armIntent({
          revision: 2,
          runId: 'run-stream-2',
          rendezvousId: 'rv-stream-2',
          positionSeconds: 10,
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
        reasonCode: 'offset-out-of-range',
      },
      {
        intent: armIntent({
          revision: 2,
          runId: 'run-stream-2',
          rendezvousId: 'rv-stream-2',
        }),
        reasonCode: 'start-not-in-future',
      },
      {
        intent: armIntent({
          revision: 2,
          runId: 'run-stream-2',
          rendezvousId: 'rv-stream-2',
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_000,
        }),
        reasonCode: 'arm-after-deadline',
      },
    ] as const;

    for (const invalid of invalidCases) {
      await expect(h.source.arm(invalid.intent)).resolves.toMatchObject({
        status: 'rejected',
        reasonCode: invalid.reasonCode,
      });
    }
    expect(h.node.port.messages).toHaveLength(messageCount);
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'playing',
      revision: 1,
      run: { queueItemId: QID, runId: 'run-stream-1', revision: 1 },
    });
    await h.source.destroy();
  });

  it('does not let a semantic preflight rejection supersede a pending valid arm', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);

    const arming = h.source.arm(armIntent());
    await Promise.resolve();
    const command = controlMessages(h.node).findLast((message) => message.type === 'arm');
    if (!command || command.type !== 'arm') throw new Error('Missing arm command');
    await expect(
      h.source.arm(
        armIntent({
          queueItemId: OTHER_QID,
          revision: 2,
          runId: 'run-stream-2',
          rendezvousId: 'rv-stream-2',
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'queue-item-mismatch' });
    expect(controlMessages(h.node).some((message) => message.type === 'cancel')).toBe(false);

    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'armed',
      generation: command.generation,
      revision: command.revision,
      runId: command.runId,
      rendezvousId: command.rendezvousId,
      targetFrame: command.targetFrame,
    });
    await expect(arming).resolves.toMatchObject({ status: 'armed', revision: 1 });
    await h.source.destroy();
  });

  it('does not let a semantic preflight rejection abort an in-flight seek reset', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);

    const seeking = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      positionSeconds: 4,
      atRoomTimeMs: 1_000,
    });
    await Promise.resolve();
    expect(lastWorkerInit(h.worker).decoderGeneration).toBe(2);
    await expect(
      h.source.arm(
        armIntent({
          queueItemId: OTHER_QID,
          revision: 2,
          runId: 'run-stream-2',
          rendezvousId: 'rv-stream-2',
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'queue-item-mismatch' });

    emitDecoderReady(h.worker);
    emitPrimed(h.node, 2);
    await expect(seeking).resolves.toMatchObject({
      phase: 'paused',
      positionSeconds: 4,
      errorCode: null,
    });
    await h.source.destroy();
  });

  it('lets a newer revision silently preempt and re-prime an older reservation', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    const previousCutover = await h.source.armForCutover(armIntent());
    if (previousCutover.status !== 'armed') throw new Error('Expected previous armed cutover');

    const nextIntent = armIntent({
      runId: 'run-stream-2',
      revision: 2,
      rendezvousId: 'rv-stream-2',
      startAtRoomTimeMs: 3_000,
      finalizeByRoomTimeMs: 2_800,
    });
    const nextArm = h.source.arm(nextIntent);
    await Promise.resolve();
    await expect(previousCutover.started).rejects.toMatchObject({
      name: 'FilePlaybackStartEvidenceError',
      code: 'operation-superseded',
    });
    const init = lastWorkerInit(h.worker);
    expect(init.decoderGeneration).toBe(2);
    emitDecoderReady(h.worker);
    emitPrimed(h.node, 2);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    const command = controlMessages(h.node).findLast(
      (message) => message.type === 'arm' && message.generation === 2,
    );
    if (!command || command.type !== 'arm') throw new Error('Missing replacement arm');
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'armed',
      generation: command.generation,
      revision: command.revision,
      runId: command.runId,
      rendezvousId: command.rendezvousId,
      targetFrame: command.targetFrame,
    });
    await expect(nextArm).resolves.toMatchObject({ status: 'armed', revision: 2 });
    expect(controlMessages(h.node)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'cancel', generation: 1, revision: 1 }),
        expect.objectContaining({ type: 'reset', generation: 2 }),
      ]),
    );
    await h.source.destroy();
  });

  it('keeps an older reservation cancelled when newer-revision reset scheduling fails', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.node.port.throwOnType = 'reset';

    await expect(
      h.source.arm(
        armIntent({
          revision: 2,
          runId: 'run-stream-2',
          rendezvousId: 'rv-stream-2',
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(controlMessages(h.node)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'cancel', generation: 1, revision: 1 }),
      ]),
    );
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'failed',
      revision: 2,
      run: { queueItemId: QID, runId: 'run-stream-2', revision: 2 },
      errorCode: 'worklet-command-failed',
    });
    expect(h.worker.terminateCount).toBe(1);
    await h.source.destroy();
  });

  it('keeps a higher-revision watermark after a non-terminal arm failure and allows only an exact retry', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);

    const nextIntent = armIntent({
      runId: 'run-stream-2',
      revision: 2,
      rendezvousId: 'rv-stream-2',
      startAtRoomTimeMs: 3_000,
      finalizeByRoomTimeMs: 2_800,
    });
    const nextArm = h.source.arm(nextIntent);
    await Promise.resolve();
    expect(lastWorkerInit(h.worker).decoderGeneration).toBe(2);
    emitDecoderReady(h.worker);
    emitPrimed(h.node, 2);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    const failedCommand = controlMessages(h.node).findLast(
      (message) => message.type === 'arm' && message.generation === 2,
    );
    if (!failedCommand || failedCommand.type !== 'arm') throw new Error('Missing replacement arm');
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'rejected',
      generation: failedCommand.generation,
      revision: failedCommand.revision,
      runId: failedCommand.runId,
      rendezvousId: failedCommand.rendezvousId,
      code: 'not-ready',
    });
    await expect(nextArm).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'not-ready',
    });
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'connected',
      revision: 2,
      run: { queueItemId: QID, runId: 'run-stream-2', revision: 2 },
    });

    const messageCount = h.node.port.messages.length;
    await expect(
      h.source.arm(
        armIntent({
          revision: 1,
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'stale-revision' });
    await expect(
      h.source.arm(
        armIntent({
          revision: 2,
          runId: 'different-run-stream-2',
          rendezvousId: 'different-rv-stream-2',
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'run-mismatch' });
    expect(h.node.port.messages).toHaveLength(messageCount);

    const retry = h.source.arm(nextIntent);
    await Promise.resolve();
    const retryCommand = controlMessages(h.node).findLast((message) => message.type === 'arm');
    if (!retryCommand || retryCommand.type !== 'arm') throw new Error('Missing retry arm');
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'armed',
      generation: retryCommand.generation,
      revision: retryCommand.revision,
      runId: retryCommand.runId,
      rendezvousId: retryCommand.rendezvousId,
      targetFrame: retryCommand.targetFrame,
    });
    await expect(retry).resolves.toMatchObject({ status: 'armed', revision: 2 });
    await h.source.destroy();
  });

  it('cancels a pending arm while retaining its claimed run watermark', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);

    const arming = h.source.arm(armIntent());
    await Promise.resolve();
    expect(controlMessages(h.node).some((message) => message.type === 'arm')).toBe(true);
    await h.source.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      rendezvousId: 'rv-stream-1',
      reasonCode: 'user-cancelled',
    });
    await expect(arming).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'operation-superseded',
    });
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'cancelled',
      revision: 1,
      run: { queueItemId: QID, runId: 'run-stream-1', revision: 1 },
    });
    expect(controlMessages(h.node).at(-1)).toMatchObject({
      type: 'cancel',
      generation: 1,
      revision: 1,
    });
    await h.source.destroy();
  });

  it('wakes a seek waiting for an exact pause when the run is cancelled', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.7;
    const finalizing = h.source.finalize(finalizeIntent());
    await Promise.resolve();
    const finalizeCommand = controlMessages(h.node).findLast(
      (message) => message.type === 'finalize',
    );
    if (!finalizeCommand || finalizeCommand.type !== 'finalize') {
      throw new Error('Missing finalize command');
    }
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: 96_000,
    });
    await finalizing;
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'started',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: 96_000,
      actualStartFrame: 96_000,
      mediaFrame: 0,
    });
    h.context.currentTime = 2.5;

    const seeking = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      positionSeconds: 4,
      atRoomTimeMs: 3_000,
    });
    await Promise.resolve();
    expect(controlMessages(h.node).some((message) => message.type === 'pause')).toBe(true);
    await h.source.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      rendezvousId: 'rv-stream-1',
      reasonCode: 'user-cancelled',
    });
    await expect(seeking).resolves.toBeDefined();
    expect(h.source.getSnapshot()).toMatchObject({ phase: 'cancelled', errorCode: null });
    await h.source.destroy();
  });

  it('keeps the second pause waiter owned when a playing seek supersedes another seek', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.7;
    const finalizing = h.source.finalize(finalizeIntent());
    await Promise.resolve();
    const finalizeCommand = controlMessages(h.node).findLast(
      (message) => message.type === 'finalize',
    );
    if (!finalizeCommand || finalizeCommand.type !== 'finalize') {
      throw new Error('Missing finalize command');
    }
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: finalizeCommand.generation,
      revision: finalizeCommand.revision,
      runId: finalizeCommand.runId,
      rendezvousId: finalizeCommand.rendezvousId,
      targetFrame: 96_000,
    });
    await finalizing;
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'started',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: 96_000,
      actualStartFrame: 96_000,
      mediaFrame: 0,
    });
    h.context.currentTime = 2.5;

    const seekOne = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      positionSeconds: 4,
      atRoomTimeMs: 3_000,
    });
    await Promise.resolve();
    const firstPause = controlMessages(h.node).findLast((message) => message.type === 'pause');
    if (!firstPause || firstPause.type !== 'pause') throw new Error('Missing first pause command');

    const seekTwo = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      positionSeconds: 5,
      atRoomTimeMs: 3_200,
    });
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    const secondPause = controlMessages(h.node).findLast((message) => message.type === 'pause');
    if (!secondPause || secondPause.type !== 'pause')
      throw new Error('Missing second pause command');
    expect(secondPause.targetFrame).not.toBe(firstPause.targetFrame);

    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'paused',
      generation: secondPause.generation,
      revision: secondPause.revision,
      runId: secondPause.runId,
      rendezvousId: secondPause.rendezvousId,
      targetFrame: secondPause.targetFrame,
      actualPauseFrame: secondPause.targetFrame,
      mediaFrame: 60_000,
    });
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(lastWorkerInit(h.worker).decoderGeneration).toBe(2);
    emitDecoderReady(h.worker);
    emitPrimed(h.node, 2);

    await expect(seekOne).resolves.toBeDefined();
    await expect(seekTwo).resolves.toMatchObject({
      phase: 'paused',
      positionSeconds: 5,
      errorCode: null,
    });
    await h.source.destroy();
  });

  it('supersedes concurrent seeks and cancels an in-flight reset without late failure', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);

    const seekOne = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      positionSeconds: 2,
      atRoomTimeMs: 1_000,
    });
    await Promise.resolve();
    const seekTwo = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      positionSeconds: 3,
      atRoomTimeMs: 1_000,
    });
    await Promise.resolve();
    expect(lastWorkerInit(h.worker).decoderGeneration).toBe(3);
    emitDecoderReady(h.worker);
    emitPrimed(h.node, 3);
    await expect(seekOne).resolves.toBeDefined();
    await expect(seekTwo).resolves.toMatchObject({ phase: 'paused', positionSeconds: 3 });
    expect(h.source.getSnapshot()).toMatchObject({ phase: 'paused', errorCode: null });

    const seekThree = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      positionSeconds: 4,
      atRoomTimeMs: 1_000,
    });
    await Promise.resolve();
    await h.source.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      rendezvousId: 'rv-stream-1',
      reasonCode: 'user-cancelled',
    });
    await expect(seekThree).resolves.toBeDefined();
    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-error',
      sourceLifetimeGeneration: lastWorkerInit(h.worker).sourceLifetimeGeneration,
      decoderGeneration: 4,
      code: 'late-cancelled-generation',
      message: 'late cancelled generation error',
    });
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'status',
      generation: 4,
      state: 'playing',
      bufferedFrames: 1,
      mediaFrame: 1,
      renderFrame: 1,
      underruns: 0,
      overflows: 0,
    });
    expect(h.source.getSnapshot()).toMatchObject({ phase: 'cancelled', errorCode: null });
    expect(h.worker.terminateCount).toBe(0);
    await h.source.destroy();
  });

  it('ignores stale generation events and fails closed on a current interruption', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);

    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'interrupted',
      generation: 99,
      code: 'stale-test',
    });
    expect(h.source.getSnapshot()).toMatchObject({ phase: 'connected', errorCode: null });
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'interrupted',
      generation: 1,
      code: 'ring-underrun',
    });
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'failed',
      errorCode: 'worklet:ring-underrun',
    });
    expect(h.worker.terminateCount).toBe(1);
    expect(h.node.disconnectCount).toBe(1);
    await h.source.destroy();
  });

  it('fails closed when the AudioWorklet processor crashes', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);

    h.node.onprocessorerror?.(new Event('processorerror'));
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'failed',
      errorCode: 'worklet-processor-error',
    });
    expect(h.worker.terminateCount).toBe(1);
    expect(h.node.disconnectCount).toBe(1);
    await h.source.destroy();
  });

  it('resets to a fresh generation and re-primes a paused seek without replacing the node', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.context.currentTime = 1.7;
    const finalizing = h.source.finalize(finalizeIntent());
    await Promise.resolve();
    const finalCommand = controlMessages(h.node).findLast((message) => message.type === 'finalize');
    if (!finalCommand || finalCommand.type !== 'finalize') throw new Error('Missing finalize');
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'finalized',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: 96_000,
    });
    await finalizing;
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'started',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: 96_000,
      actualStartFrame: 96_000,
      mediaFrame: 0,
    });

    h.context.currentTime = 2.5;
    await h.source.pause({
      kind: 'file-playback-pause',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      atRoomTimeMs: 3_000,
    });
    const pauseCommand = controlMessages(h.node).findLast((message) => message.type === 'pause');
    if (!pauseCommand || pauseCommand.type !== 'pause') throw new Error('Missing pause');
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'paused',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: pauseCommand.targetFrame,
      actualPauseFrame: pauseCommand.targetFrame,
      mediaFrame: OUTPUT_RATE,
    });
    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'frame-index-point',
      sourceLifetimeGeneration: lastWorkerInit(h.worker).sourceLifetimeGeneration,
      decoderGeneration: 1,
      sourceSample: SOURCE_RATE * 2,
      byteOffset: 100,
    });

    h.context.currentTime = 3;
    const seeking = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      positionSeconds: 2,
      atRoomTimeMs: 3_000,
    });
    await Promise.resolve();
    const init = lastWorkerInit(h.worker);
    expect(init).toMatchObject({
      decoderGeneration: 2,
      descriptor: {
        targetSourceSample: SOURCE_RATE * 2,
        decodeAnchorSourceSample: SOURCE_RATE * 2,
        decodeAnchorByteOffset: 100,
      },
    });
    expect(controlMessages(h.node)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reset', generation: 2, mediaFrame: OUTPUT_RATE * 2 }),
        expect.objectContaining({ type: 'bind-pcm-port', generation: 2 }),
      ]),
    );
    emitDecoderReady(h.worker);
    emitPrimed(h.node, 2);
    await expect(seeking).resolves.toMatchObject({
      phase: 'paused',
      positionSeconds: 2,
    });
    expect(h.channels).toHaveLength(3);
    expect(h.node.connections).toEqual([h.destination]);
    expect(h.worker.terminateCount).toBe(0);

    await expect(
      arm(
        h.source,
        h.node,
        armIntent({
          positionSeconds: 2,
          rendezvousId: 'rv-stream-replay',
          startAtRoomTimeMs: 4_000,
          finalizeByRoomTimeMs: 3_800,
        }),
      ),
    ).resolves.toMatchObject({ status: 'armed' });
    await h.source.destroy();
  });

  it('commits a pause revision only from the exact Worklet paused frame', async () => {
    const h = harness();
    await startPlaying(h);
    h.context.currentTime = 2.5;

    const pause = await h.source.pauseRevisioned(pauseTransition());
    if (pause.status !== 'scheduled') {
      throw new Error(`${pause.reason}:${pause.snapshot.errorCode ?? 'no-error'}`);
    }
    expect(pause).toMatchObject({
      status: 'scheduled',
      from: { revision: 1 },
      to: { revision: 2 },
      target: { targetFrame: 144_000, contextTimeSeconds: 3 },
      snapshot: { phase: 'playing', revision: 1 },
    });
    const pauseCommands = () =>
      controlMessages(h.node).filter((message) => message.type === 'pause');
    expect(pauseCommands()).toHaveLength(1);
    expect(await h.source.pauseRevisioned({ ...pauseTransition() })).toBe(pause);
    expect(pauseCommands()).toHaveLength(1);
    expect(h.source.getSnapshot()).toMatchObject({ phase: 'playing', revision: 1 });

    h.context.currentTime = 3;
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'paused',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: 144_000,
      actualPauseFrame: 144_000,
      mediaFrame: OUTPUT_RATE,
    });
    await expect(pause.applied).resolves.toMatchObject({
      kind: 'pause-applied',
      observation: 'worklet-observed',
      targetFrame: 144_000,
      appliedFrame: 144_000,
      from: { revision: 1 },
      to: { revision: 2 },
    });
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'paused',
      revision: 2,
      run: { revision: 2 },
      positionSeconds: 1,
    });
    await h.source.destroy();
  });

  it('revokes an applied transition retry cache on destroy and terminal failure', async () => {
    const destroyed = harness();
    await startPlaying(destroyed);
    const destroyedPause = await applyRevisionedPause(destroyed);
    expect(await destroyed.source.pauseRevisioned({ ...pauseTransition() })).toBe(destroyedPause);
    await destroyed.source.destroy();
    await expect(destroyed.source.pauseRevisioned({ ...pauseTransition() })).resolves.toMatchObject(
      {
        status: 'rejected',
        reason: 'source-destroyed',
        target: null,
        applied: null,
      },
    );

    const failed = harness();
    await startPlaying(failed);
    const failedPause = await applyRevisionedPause(failed);
    expect(await failed.source.pauseRevisioned({ ...pauseTransition() })).toBe(failedPause);
    failed.node.onprocessorerror?.(new Event('processorerror'));
    await expect(failed.source.pauseRevisioned({ ...pauseTransition() })).resolves.toMatchObject({
      status: 'rejected',
      reason: 'source-failed',
      target: null,
      applied: null,
    });
    await failed.source.destroy();
  });

  it('revokes an applied transition retry cache on exact current cancellation', async () => {
    const h = harness();
    await startPlaying(h);
    const pause = await applyRevisionedPause(h);
    expect(await h.source.pauseRevisioned({ ...pauseTransition() })).toBe(pause);

    await expect(
      h.source.cancel({
        kind: 'file-playback-cancel',
        queueItemId: QID,
        runId: 'run-stream-1',
        revision: 2,
        rendezvousId: 'rv-stream-1',
        reasonCode: 'test-current-cancel',
      }),
    ).resolves.toMatchObject({ phase: 'cancelled', revision: 2 });
    await expect(h.source.pauseRevisioned({ ...pauseTransition() })).resolves.toMatchObject({
      status: 'rejected',
      reason: 'identity-mismatch',
      target: null,
      applied: null,
    });
    await h.source.destroy();
  });

  it('keeps a paused seek logically hidden until a matching Worklet status proves it', async () => {
    const h = harness();
    await startPlaying(h);
    h.context.currentTime = 2.5;
    const pause = await h.source.pauseRevisioned(pauseTransition());
    if (pause.status !== 'scheduled') throw new Error('Expected scheduled pause');
    h.context.currentTime = 3;
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'paused',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: 144_000,
      actualPauseFrame: 144_000,
      mediaFrame: OUTPUT_RATE,
    });
    await pause.applied;

    vi.useFakeTimers();
    try {
      const seek = await h.source.seekRevisioned(seekTransition());
      if (seek.status !== 'scheduled') throw new Error('Expected scheduled seek');
      expect(seek.snapshot).toMatchObject({ revision: 2, positionSeconds: 1 });
      expect(h.source.getSnapshot()).toMatchObject({ revision: 2, positionSeconds: 1 });

      h.context.currentTime = 4;
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      const init = lastWorkerInit(h.worker);
      expect(init.decoderGeneration).toBe(2);
      emitDecoderReady(h.worker);
      emitPrimed(h.node, 2);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(h.source.getSnapshot()).toMatchObject({ revision: 2, positionSeconds: 1 });

      h.node.port.emit({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'status',
        generation: 2,
        state: 'ready',
        bufferedFrames: 192_000,
        mediaFrame: OUTPUT_RATE * 2,
        renderFrame: 192_000,
        underruns: 0,
        overflows: 0,
      });
      await expect(seek.applied).resolves.toMatchObject({
        kind: 'seek-applied',
        observation: 'worklet-observed',
        targetFrame: 192_000,
        appliedFrame: 192_000,
        positionSeconds: 2,
        from: { revision: 2 },
        to: { revision: 3 },
      });
      expect(h.source.getSnapshot()).toMatchObject({
        phase: 'paused',
        revision: 3,
        positionSeconds: 2,
      });
    } finally {
      vi.useRealTimers();
      await h.source.destroy();
    }
  });

  it('rejects invalid revision transitions without posting Worklet control', async () => {
    const h = harness();
    await startPlaying(h);
    h.context.currentTime = 2.5;
    const before = controlMessages(h.node).length;

    await expect(
      h.source.pauseRevisioned(
        pauseTransition({
          from: { queueItemId: QID, runId: 'wrong-run', revision: 1 },
          to: { queueItemId: QID, runId: 'wrong-run', revision: 2 },
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'identity-mismatch' });
    await expect(
      h.source.pauseRevisioned(
        pauseTransition({
          to: { queueItemId: QID, runId: 'run-stream-1', revision: 1 },
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'non-consecutive-revision' });
    await expect(
      h.source.seekRevisioned(
        seekTransition({
          from: { queueItemId: QID, runId: 'run-stream-1', revision: 1 },
          to: { queueItemId: QID, runId: 'run-stream-1', revision: 2 },
        }),
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: 'playing-seek-requires-cutover',
    });
    await expect(
      h.source.seekRevisioned(
        seekTransition({
          from: { queueItemId: QID, runId: 'run-stream-1', revision: 1 },
          to: { queueItemId: QID, runId: 'run-stream-1', revision: 2 },
          positionSeconds: 11,
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'position-out-of-range' });
    await expect(
      h.source.pauseRevisioned(pauseTransition({ atRoomTimeMs: 2_500 })),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'target-not-in-future' });
    expect(controlMessages(h.node)).toHaveLength(before);
    await h.source.destroy();
  });

  it('fails closed when Worklet pause evidence misses the exact target', async () => {
    const h = harness();
    await startPlaying(h);
    h.context.currentTime = 2.5;
    const pause = await h.source.pauseRevisioned(pauseTransition());
    if (pause.status !== 'scheduled') throw new Error('Expected scheduled pause');
    h.context.currentTime = 3;
    h.node.port.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'paused',
      generation: 1,
      revision: 1,
      runId: 'run-stream-1',
      rendezvousId: 'rv-stream-1',
      targetFrame: 144_000,
      actualPauseFrame: 144_128,
      mediaFrame: OUTPUT_RATE,
    });

    await expect(pause.applied).rejects.toMatchObject({
      name: 'FilePlaybackTransitionEvidenceError',
      code: 'worklet-pause-target-mismatch',
    });
    expect(h.source.getSnapshot()).toMatchObject({ phase: 'failed', revision: 1 });
    await h.source.destroy();
  });

  it('removes a rejected SEEKTABLE candidate before the next seek', async () => {
    const sourceMetadata: FlacMetadata = Object.freeze({
      ...metadata(),
      seekPoints: Object.freeze([
        Object.freeze({
          sample: SOURCE_RATE * 2,
          streamOffset: 58,
          frameSamples: 4_096,
        }),
      ]),
    });
    const h = harness(async () => undefined, sourceMetadata);
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);
    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decode-anchor-rejected',
      sourceLifetimeGeneration: lastWorkerInit(h.worker).sourceLifetimeGeneration,
      decoderGeneration: 1,
      sourceSample: SOURCE_RATE * 2,
      byteOffset: 100,
    });

    const seeking = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      positionSeconds: 2,
      atRoomTimeMs: 1_000,
    });
    await Promise.resolve();
    const init = lastWorkerInit(h.worker);
    expect(init.descriptor).toMatchObject({
      targetSourceSample: SOURCE_RATE * 2,
      decodeAnchorSourceSample: 0,
      decodeAnchorByteOffset: 42,
    });
    emitDecoderReady(h.worker);
    emitPrimed(h.node, init.decoderGeneration);
    await expect(seeking).resolves.toMatchObject({ phase: 'paused', positionSeconds: 2 });
    await h.source.destroy();
  });

  it('keeps one encoded source bridge across seeks and closes ownership exactly once', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    await h.source.connect(h.destination as unknown as AudioNode);
    await arm(h.source, h.node);

    const seeking = h.source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-stream-1',
      revision: 1,
      positionSeconds: 1,
      atRoomTimeMs: 1_000,
    });
    await Promise.resolve();
    const secondInit = lastWorkerInit(h.worker);
    expect(secondInit.decoderGeneration).toBe(2);
    emitDecoderReady(h.worker);
    emitPrimed(h.node, 2);
    await expect(seeking).resolves.toMatchObject({ phase: 'paused', positionSeconds: 1 });

    const sourceOpens = h.worker.messages.filter(({ message }) => message.type === 'open-source');
    const decoderInits = h.worker.messages.filter(({ message }) => message.type === 'init-decoder');
    expect(sourceOpens).toHaveLength(1);
    expect(decoderInits).toHaveLength(2);
    expect(h.channels).toHaveLength(3);
    const sourceLifetimeGeneration = secondInit.sourceLifetimeGeneration;
    for (const entry of decoderInits) {
      if (entry.message.type !== 'init-decoder') throw new Error('Expected decoder init');
      expect(entry.message.sourceLifetimeGeneration).toBe(sourceLifetimeGeneration);
      expect(entry.transfer).toEqual([entry.message.pcmPort]);
    }
    expect(h.closeEncodedSource).not.toHaveBeenCalled();

    await h.source.destroy();
    await h.source.destroy();
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
    expect(h.worker.terminateCount).toBe(1);
    expect(h.worker.messages.filter(({ message }) => message.type === 'close-source')).toHaveLength(
      1,
    );
  });

  it('fails closed on accessor worker events without invoking their getters', async () => {
    const h = harness();
    await prepare(h.source, h.worker, h.node);
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'decoder-ready';
      },
    });

    h.worker.onmessage?.({ data: hostile } as MessageEvent<FlacDecoderEvent>);

    expect(getterCalls).toBe(0);
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'failed',
      errorCode: 'decoder-invalid-event',
    });
    await vi.waitFor(() => expect(h.closeEncodedSource).toHaveBeenCalledTimes(1));
    await h.source.destroy();
  });

  it('aborts a hanging prepare and releases all partially created resources', async () => {
    let releaseLoad!: () => void;
    const load = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const h = harness(() => load);
    const controller = new AbortController();
    const preparing = h.source.prepare(controller.signal);
    await Promise.resolve();
    controller.abort(new DOMException('test abort', 'AbortError'));
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.source.getSnapshot()).toMatchObject({
      phase: 'failed',
      errorCode: 'prepare-aborted',
    });
    expect(h.worker.terminateCount).toBe(0);
    releaseLoad();
    await h.source.destroy();
    await h.source.destroy();
    expect(h.closeEncodedSource).toHaveBeenCalledTimes(1);
  });
});

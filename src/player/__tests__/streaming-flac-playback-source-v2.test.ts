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
  type PcmRingCommand,
  type PcmRingEvent,
} from '../flac/stream-protocol.ts';
import type { RendezvousArmIntent, RendezvousFinalizeIntent } from '../rendezvous-contract.ts';

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

  get currentTime(): number {
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

function harness(
  loadWorklet: () => Promise<void> = async () => undefined,
  sourceMetadata: FlacMetadata = metadata(),
) {
  const context = new FakeAudioContext();
  const destination = new FakeAudioNode(context);
  const worker = new FakeWorker();
  const node = new FakeAudioWorkletNode(context);
  const channels: FakeMessageChannel[] = [];
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
    blob: new Blob([new Uint8Array(256)]),
    metadata: sourceMetadata,
    audioContext: context as unknown as AudioContext,
    nowRoomTimeMs: () => context.roomNowMs,
    roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
    localPerformanceMsToContextTime: (performanceTimeMs) => performanceTimeMs / 1_000,
    runtime,
  });

  return {
    context,
    destination,
    worker,
    node,
    channels,
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
  const init = worker.messages.findLast(({ message }) => message.type === 'init')?.message;
  if (!init || init.type !== 'init') throw new Error('Expected a FLAC decoder init command');
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
    if (worker.messages.some(({ message }) => message.type === 'init')) {
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
    generation: init.generation,
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
  emitPrimed(node, lastWorkerInit(worker).generation);
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

describe('StreamingFlacPlaybackSource v2', () => {
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
    expect(h.channels).toHaveLength(1);
    expect(lastWorkerInit(h.worker)).toMatchObject({
      generation: 1,
      blob: expect.any(Blob),
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
    expect(lastWorkerInit(h.worker).generation).toBe(2);
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

    const nextIntent = armIntent({
      runId: 'run-stream-2',
      revision: 2,
      rendezvousId: 'rv-stream-2',
      startAtRoomTimeMs: 3_000,
      finalizeByRoomTimeMs: 2_800,
    });
    const nextArm = h.source.arm(nextIntent);
    await Promise.resolve();
    const init = lastWorkerInit(h.worker);
    expect(init.generation).toBe(2);
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
    expect(lastWorkerInit(h.worker).generation).toBe(2);
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
    expect(lastWorkerInit(h.worker).generation).toBe(2);
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
    expect(lastWorkerInit(h.worker).generation).toBe(3);
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
      reasonCode: 'user-cancelled',
    });
    await expect(seekThree).resolves.toBeDefined();
    h.worker.emit({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'decoder-error',
      generation: 4,
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
      generation: 1,
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
      generation: 2,
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
    expect(h.channels).toHaveLength(2);
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
      generation: 1,
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
    emitPrimed(h.node, init.generation);
    await expect(seeking).resolves.toMatchObject({ phase: 'paused', positionSeconds: 2 });
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
  });
});

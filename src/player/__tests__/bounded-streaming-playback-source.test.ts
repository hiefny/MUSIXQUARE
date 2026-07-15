import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  BoundedStreamingPlaybackSource,
  type BoundedStreamingPlaybackSourceOptions,
} from '../backends/bounded-streaming-playback-source.ts';
import { getFilePlaybackUniversalLifecycleSnapshotForTests as getFilePlaybackUniversalLifecycleSnapshot } from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import type {
  StreamingDecoderAdapter,
  StreamingDecoderGenerationRequest,
} from '../streaming/decoder-adapter.ts';
import {
  PCM_STREAM_PROTOCOL_VERSION,
  type PcmRingCommand,
  type PcmRingEvent,
} from '../streaming/pcm-stream-protocol.ts';
import type { RendezvousArmIntent, RendezvousFinalizeIntent } from '../rendezvous-contract.ts';

const QID = '00000000-0000-4000-8000-000000000901' as QueueItemId;

function decoder(totalMediaFrames = 480_000) {
  const open = vi.fn(async () => undefined);
  const startGeneration = vi.fn(async (request: StreamingDecoderGenerationRequest) => {
    request.acceptPcmPortOwnership();
  });
  const stopGeneration = vi.fn();
  const close = vi.fn(async () => undefined);
  const adapter: StreamingDecoderAdapter = {
    info: Object.freeze({
      mediaSampleRateHz: 48_000,
      channelCount: 2,
      totalMediaFrames,
    }),
    opened: false,
    open,
    startGeneration,
    stopGeneration,
    close,
  };
  return { adapter, open, startGeneration, stopGeneration, close };
}

function options(
  createDecoder: () => StreamingDecoderAdapter,
): BoundedStreamingPlaybackSourceOptions {
  return {
    queueItemId: QID,
    createDecoder,
    audioContext: { sampleRate: 48_000 } as AudioContext,
    nowRoomTimeMs: () => 1_000,
    roomTimeMsToContextTime: (roomTimeMs) => roomTimeMs / 1_000,
    localPerformanceMsToContextTime: (performanceTimeMs) => performanceTimeMs / 1_000,
  };
}

class FakeMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
  closeCount = 0;
  throwOnClose = false;
  throwOnType: string | null = null;

  addEventListener(): void {}
  removeEventListener(): void {}
  start(): void {}

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    if (
      this.throwOnType &&
      message !== null &&
      typeof message === 'object' &&
      (message as Record<string, unknown>).type === this.throwOnType
    ) {
      throw new Error(`synthetic ${this.throwOnType} post failure`);
    }
    this.messages.push({ message, transfer });
  }

  close(): void {
    this.closeCount += 1;
    if (this.throwOnClose) throw new Error('synthetic port close failure');
  }

  emit(message: PcmRingEvent): void {
    this.onmessage?.({ data: message } as MessageEvent<PcmRingEvent>);
  }
}

class FakeMessageChannel {
  readonly port1 = new FakeMessagePort();
  readonly port2 = new FakeMessagePort();
}

class FakeWorkletNode {
  readonly port = new FakeMessagePort();
  onprocessorerror: ((event: Event) => void) | null = null;
  disconnectCount = 0;
  throwOnDisconnect = false;

  connect(): void {}

  disconnect(): void {
    this.disconnectCount += 1;
    if (this.throwOnDisconnect) throw new Error('synthetic disconnect failure');
  }
}

function lifecycleHarness(
  patch: Partial<BoundedStreamingPlaybackSourceOptions> = {},
  createChannel: () => FakeMessageChannel = () => new FakeMessageChannel(),
) {
  let opened = false;
  const open = vi.fn(async () => {
    opened = true;
  });
  const startGeneration = vi.fn(async (request: StreamingDecoderGenerationRequest) => {
    request.acceptPcmPortOwnership();
  });
  const stopGeneration = vi.fn();
  const close = vi.fn(async () => {
    opened = false;
  });
  const adapter: StreamingDecoderAdapter = {
    info: Object.freeze({
      mediaSampleRateHz: 48_000,
      channelCount: 2,
      totalMediaFrames: 480_000,
    }),
    get opened() {
      return opened;
    },
    open,
    startGeneration,
    stopGeneration,
    close,
  };
  const node = new FakeWorkletNode();
  const channels: FakeMessageChannel[] = [];
  const audioContext = {
    sampleRate: 48_000,
    currentTime: 1,
    state: 'running' as AudioContextState,
  };
  const destination = { context: audioContext } as unknown as AudioNode;
  const { runtime: runtimePatch, ...optionsPatch } = patch;
  const source = new BoundedStreamingPlaybackSource({
    ...options(() => adapter),
    audioContext: audioContext as AudioContext,
    runtime: {
      loadWorklet: async () => undefined,
      createWorkletNode: () => node as unknown as AudioWorkletNode,
      createMessageChannel: () => {
        const channel = createChannel();
        channels.push(channel);
        return channel as unknown as MessageChannel;
      },
      ...runtimePatch,
    },
    ...optionsPatch,
  });
  return {
    source,
    adapter,
    node,
    channels,
    audioContext,
    destination,
    open,
    startGeneration,
    stopGeneration,
    close,
  };
}

async function prepareLifecycleHarness(
  harness: ReturnType<typeof lifecycleHarness>,
): Promise<void> {
  const preparing = harness.source.prepare();
  await vi.waitFor(() => {
    expect(
      harness.node.port.messages.some(
        ({ message }) =>
          message !== null &&
          typeof message === 'object' &&
          (message as Record<string, unknown>).type === 'bind-pcm-port',
      ),
    ).toBe(true);
  });
  harness.node.port.emit({
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'primed',
    generation: 1,
    bufferedFrames: 96_000,
    sampleRate: 48_000,
    channels: 2,
  });
  await preparing;
}

function rendezvousArmIntent(overrides: Partial<RendezvousArmIntent> = {}): RendezvousArmIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-arm',
    queueItemId: QID,
    runId: 'run-bounded-start-evidence',
    revision: 1,
    rendezvousId: 'rv-bounded-start-evidence',
    recipientId: 'peer-1',
    positionSeconds: 0,
    playbackRate: 1,
    startAtRoomTimeMs: 2_000,
    finalizeByRoomTimeMs: 1_800,
    ...overrides,
  };
}

function rendezvousFinalizeIntent(
  overrides: Partial<RendezvousFinalizeIntent> = {},
): RendezvousFinalizeIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalize',
    queueItemId: QID,
    runId: 'run-bounded-start-evidence',
    revision: 1,
    rendezvousId: 'rv-bounded-start-evidence',
    recipientId: 'peer-1',
    startAtRoomTimeMs: 2_000,
    finalizedAtRoomTimeMs: 1_700,
    ...overrides,
  };
}

function controlMessages(node: FakeWorkletNode): PcmRingCommand[] {
  return node.port.messages.map(({ message }) => message as PcmRingCommand);
}

async function waitForControlMessage(
  node: FakeWorkletNode,
  predicate: (message: PcmRingCommand) => boolean,
): Promise<PcmRingCommand> {
  for (let turn = 0; turn < 40; turn += 1) {
    const message = controlMessages(node).findLast(predicate);
    if (message) return message;
    await Promise.resolve();
  }
  throw new Error('Expected bounded stream control command');
}

async function armLifecycleHarness(
  harness: ReturnType<typeof lifecycleHarness>,
  intent: RendezvousArmIntent = rendezvousArmIntent(),
) {
  const pending = harness.source.armForCutover(intent);
  await Promise.resolve();
  const command = controlMessages(harness.node).findLast((message) => message.type === 'arm');
  if (!command || command.type !== 'arm') throw new Error('Expected bounded stream arm command');
  harness.node.port.emit({
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'armed',
    generation: command.generation,
    revision: command.revision,
    runId: command.runId,
    rendezvousId: command.rendezvousId,
    targetFrame: command.targetFrame,
  });
  const armed = await pending;
  if (armed.status !== 'armed') throw new Error('Expected bounded stream armed result');
  return { armed, command };
}

async function finalizeLifecycleHarness(
  harness: ReturnType<typeof lifecycleHarness>,
  intent: RendezvousFinalizeIntent = rendezvousFinalizeIntent(),
) {
  const pending = harness.source.finalize(intent);
  await Promise.resolve();
  const command = controlMessages(harness.node).findLast((message) => message.type === 'finalize');
  if (!command || command.type !== 'finalize') {
    throw new Error('Expected bounded stream finalize command');
  }
  const armCommand = controlMessages(harness.node).findLast((message) => message.type === 'arm');
  if (!armCommand || armCommand.type !== 'arm') {
    throw new Error('Expected bounded stream arm command');
  }
  harness.node.port.emit({
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'finalized',
    generation: command.generation,
    revision: command.revision,
    runId: command.runId,
    rendezvousId: command.rendezvousId,
    targetFrame: armCommand.targetFrame,
  });
  await expect(pending).resolves.toMatchObject({ status: 'accepted', reasonCode: null });
  return { command, targetFrame: armCommand.targetFrame };
}

function emitExactStarted(
  harness: ReturnType<typeof lifecycleHarness>,
  finalized: Awaited<ReturnType<typeof finalizeLifecycleHarness>>,
): void {
  harness.node.port.emit({
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'started',
    generation: finalized.command.generation,
    revision: finalized.command.revision,
    runId: finalized.command.runId,
    rendezvousId: finalized.command.rendezvousId,
    targetFrame: finalized.targetFrame,
    actualStartFrame: finalized.targetFrame,
    mediaFrame: 0,
  });
}

async function destroyLifecycleHarness(
  harness: ReturnType<typeof lifecycleHarness>,
): Promise<void> {
  const destroying = harness.source.destroy();
  const generations = new Set(
    controlMessages(harness.node).flatMap((message) =>
      message.type === 'bind-pcm-port' ? [message.generation] : [],
    ),
  );
  for (const generation of generations) {
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'pcm-port-retired',
      generation,
    });
  }
  harness.node.port.emit({
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'processor-retired',
    generation: Math.max(1, ...generations),
  });
  await destroying;
}

function kindDelta(
  before: ReturnType<typeof getFilePlaybackUniversalLifecycleSnapshot>,
  after: ReturnType<typeof getFilePlaybackUniversalLifecycleSnapshot>,
  kind: 'playbackSources' | 'ports' | 'rings' | 'timers',
  field: 'live' | 'retiring' | 'unconfirmed' | 'releasedTotal',
): number {
  return after.kinds[kind][field] - before.kinds[kind][field];
}

describe('BoundedStreamingPlaybackSource ownership', () => {
  it('validates common inputs before invoking the decoder factory', () => {
    const createDecoder = vi.fn(() => decoder().adapter);
    const invalid = {
      ...options(createDecoder),
      audioContext: { sampleRate: 0 } as AudioContext,
    };

    expect(() => new BoundedStreamingPlaybackSource(invalid)).toThrow(/AudioContext is invalid/i);
    expect(createDecoder).not.toHaveBeenCalled();
  });

  it('invokes the decoder factory once without opening it and closes an unprepared source once', async () => {
    const h = decoder();
    const createDecoder = vi.fn(() => h.adapter);
    const source = new BoundedStreamingPlaybackSource(options(createDecoder));

    expect(source.backend).toBe('bounded-stream');
    expect(createDecoder).toHaveBeenCalledTimes(1);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.startGeneration).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();

    await source.destroy();
    await source.destroy();
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('best-effort closes exactly once when validation fails after the factory returns', async () => {
    const h = decoder(0);
    h.close.mockRejectedValueOnce(new Error('synthetic close failure'));
    const createDecoder = vi.fn(() => h.adapter);

    expect(() => new BoundedStreamingPlaybackSource(options(createDecoder))).toThrow(
      /invalid adapter/i,
    );
    await Promise.resolve();
    expect(createDecoder).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.open).not.toHaveBeenCalled();
  });

  it('keeps the source, ring, and ports retiring until exact Worklet ACKs arrive', async () => {
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    const harness = lifecycleHarness();
    await prepareLifecycleHarness(harness);

    const destroying = harness.source.destroy();
    const retiring = getFilePlaybackUniversalLifecycleSnapshot();
    expect(kindDelta(baseline, retiring, 'playbackSources', 'retiring')).toBe(1);
    expect(kindDelta(baseline, retiring, 'rings', 'retiring')).toBe(1);
    expect(kindDelta(baseline, retiring, 'ports', 'retiring')).toBe(2);
    expect(kindDelta(baseline, retiring, 'timers', 'live')).toBe(1);

    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'pcm-port-retired',
      generation: 1,
    });
    const pcmRetired = getFilePlaybackUniversalLifecycleSnapshot();
    expect(kindDelta(baseline, pcmRetired, 'ports', 'retiring')).toBe(1);
    expect(kindDelta(baseline, pcmRetired, 'ports', 'releasedTotal')).toBe(1);

    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'processor-retired',
      generation: 1,
    });
    await destroying;

    const retired = getFilePlaybackUniversalLifecycleSnapshot();
    for (const kind of ['playbackSources', 'ports', 'rings', 'timers'] as const) {
      expect(kindDelta(baseline, retired, kind, 'live')).toBe(0);
      expect(kindDelta(baseline, retired, kind, 'retiring')).toBe(0);
      expect(kindDelta(baseline, retired, kind, 'unconfirmed')).toBe(0);
    }
    expect(kindDelta(baseline, retired, 'playbackSources', 'releasedTotal')).toBe(1);
    expect(kindDelta(baseline, retired, 'ports', 'releasedTotal')).toBe(2);
    expect(kindDelta(baseline, retired, 'rings', 'releasedTotal')).toBe(1);
    expect(kindDelta(baseline, retired, 'timers', 'releasedTotal')).toBe(1);
  });

  it('leaves forced Worklet cleanup unconfirmed when the terminal ACK times out', async () => {
    const harness = lifecycleHarness({ commandTimeoutMs: 100 });
    await prepareLifecycleHarness(harness);
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    vi.useFakeTimers();
    try {
      const destroying = harness.source.destroy();
      await vi.advanceTimersByTimeAsync(100);
      await destroying;
    } finally {
      vi.useRealTimers();
    }

    const timedOut = getFilePlaybackUniversalLifecycleSnapshot();
    expect(kindDelta(baseline, timedOut, 'playbackSources', 'unconfirmed')).toBe(1);
    expect(kindDelta(baseline, timedOut, 'rings', 'unconfirmed')).toBe(1);
    expect(kindDelta(baseline, timedOut, 'ports', 'unconfirmed')).toBe(2);
    expect(kindDelta(baseline, timedOut, 'timers', 'releasedTotal')).toBe(1);
  });

  it('does not report clean retirement when the Worklet stop command cannot be posted', async () => {
    const harness = lifecycleHarness();
    await prepareLifecycleHarness(harness);
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    harness.node.port.throwOnType = 'stop';

    await harness.source.destroy();

    const failed = getFilePlaybackUniversalLifecycleSnapshot();
    expect(kindDelta(baseline, failed, 'playbackSources', 'unconfirmed')).toBe(1);
    expect(kindDelta(baseline, failed, 'rings', 'unconfirmed')).toBe(1);
    expect(kindDelta(baseline, failed, 'ports', 'unconfirmed')).toBe(2);
    expect(kindDelta(baseline, failed, 'timers', 'releasedTotal')).toBe(0);
  });

  it('closes the caller-owned PCM endpoint when decoder preflight rejects before acceptance', async () => {
    const harness = lifecycleHarness();
    let acceptAfterRejection: (() => void) | null = null;
    harness.startGeneration.mockImplementationOnce(async (request) => {
      acceptAfterRejection = request.acceptPcmPortOwnership;
      throw new Error('synthetic decoder preflight failure');
    });

    await expect(harness.source.prepare()).rejects.toThrow(/preflight failure/i);
    expect(harness.channels[0]?.port1.closeCount).toBe(1);
    expect(() => acceptAfterRejection?.()).toThrow(/after request settlement/i);

    const destroying = harness.source.destroy();
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'pcm-port-retired',
      generation: 1,
    });
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'processor-retired',
      generation: 1,
    });
    await destroying;
  });

  it('rejects a decoder that reports ready without committing PCM port ownership', async () => {
    const harness = lifecycleHarness();
    harness.startGeneration.mockImplementationOnce(async () => undefined);

    await expect(harness.source.prepare()).rejects.toThrow(/without accepting the PCM port/i);
    expect(harness.channels[0]?.port1.closeCount).toBe(1);

    const destroying = harness.source.destroy();
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'pcm-port-retired',
      generation: 1,
    });
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'processor-retired',
      generation: 1,
    });
    await destroying;
  });

  it('makes PCM ownership acceptance one-shot and never reclaims an accepted endpoint', async () => {
    const harness = lifecycleHarness();
    harness.startGeneration.mockImplementationOnce(async (request) => {
      request.acceptPcmPortOwnership();
      expect(() => request.acceptPcmPortOwnership()).toThrow(/more than once/i);
      request.pcmPort.close();
      throw new Error('synthetic post-accept failure');
    });

    await expect(harness.source.prepare()).rejects.toThrow(/post-accept failure/i);
    expect(harness.channels[0]?.port1.closeCount).toBe(1);

    const destroying = harness.source.destroy();
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'pcm-port-retired',
      generation: 1,
    });
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'processor-retired',
      generation: 1,
    });
    await destroying;
  });

  it('records a pre-accept PCM endpoint whose caller-side close fails', async () => {
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    const harness = lifecycleHarness({}, () => {
      const channel = new FakeMessageChannel();
      channel.port1.throwOnClose = true;
      return channel;
    });
    harness.startGeneration.mockRejectedValueOnce(new Error('synthetic decoder preflight failure'));

    await expect(harness.source.prepare()).rejects.toThrow(/preflight failure/i);
    expect(harness.channels[0]?.port1.closeCount).toBe(1);

    const destroying = harness.source.destroy();
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'pcm-port-retired',
      generation: 1,
    });
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'processor-retired',
      generation: 1,
    });
    await destroying;

    const failed = getFilePlaybackUniversalLifecycleSnapshot();
    expect(kindDelta(baseline, failed, 'playbackSources', 'unconfirmed')).toBe(1);
  });

  it('keeps an untransferred PCM channel and source unconfirmed when local close fails', async () => {
    const harness = lifecycleHarness({}, () => {
      const channel = new FakeMessageChannel();
      channel.port2.throwOnClose = true;
      return channel;
    });
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    harness.node.port.throwOnType = 'bind-pcm-port';

    await expect(harness.source.prepare()).rejects.toThrow(/post failure/i);
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'processor-retired',
      generation: 1,
    });
    await harness.source.destroy();

    const failed = getFilePlaybackUniversalLifecycleSnapshot();
    expect(harness.channels[0]?.port1.closeCount).toBe(1);
    expect(harness.channels[0]?.port2.closeCount).toBe(1);
    expect(kindDelta(baseline, failed, 'playbackSources', 'unconfirmed')).toBe(1);
    expect(kindDelta(baseline, failed, 'ports', 'unconfirmed')).toBe(1);
    expect(kindDelta(baseline, failed, 'ports', 'releasedTotal')).toBe(1);
    expect(kindDelta(baseline, failed, 'rings', 'releasedTotal')).toBe(1);
  });

  it('keeps graph, ports, and source unconfirmed when page-side disconnect fails', async () => {
    const harness = lifecycleHarness();
    await prepareLifecycleHarness(harness);
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    harness.node.throwOnDisconnect = true;

    await harness.source.destroy();

    const failed = getFilePlaybackUniversalLifecycleSnapshot();
    expect(harness.node.disconnectCount).toBe(1);
    expect(harness.node.port.closeCount).toBe(1);
    expect(kindDelta(baseline, failed, 'playbackSources', 'unconfirmed')).toBe(1);
    expect(kindDelta(baseline, failed, 'rings', 'unconfirmed')).toBe(1);
    expect(kindDelta(baseline, failed, 'ports', 'unconfirmed')).toBe(2);
    expect(kindDelta(baseline, failed, 'timers', 'releasedTotal')).toBe(0);
  });

  it('keeps the control port, ring, and source unconfirmed when page-side close fails', async () => {
    const harness = lifecycleHarness();
    await prepareLifecycleHarness(harness);
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    harness.node.port.throwOnClose = true;

    const destroying = harness.source.destroy();
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'pcm-port-retired',
      generation: 1,
    });
    harness.node.port.emit({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'processor-retired',
      generation: 1,
    });
    await destroying;

    const failed = getFilePlaybackUniversalLifecycleSnapshot();
    expect(harness.node.disconnectCount).toBe(1);
    expect(harness.node.port.closeCount).toBe(1);
    expect(kindDelta(baseline, failed, 'playbackSources', 'unconfirmed')).toBe(1);
    expect(kindDelta(baseline, failed, 'rings', 'unconfirmed')).toBe(1);
    expect(kindDelta(baseline, failed, 'ports', 'releasedTotal')).toBe(1);
    expect(kindDelta(baseline, failed, 'ports', 'unconfirmed')).toBe(1);
    expect(kindDelta(baseline, failed, 'timers', 'releasedTotal')).toBe(1);
  });

  it('marks the source unconfirmed when Worklet construction crosses an unknown boundary', async () => {
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    const harness = lifecycleHarness({
      runtime: {
        loadWorklet: async () => undefined,
        createWorkletNode: () => {
          throw new Error('synthetic Worklet constructor failure');
        },
        createMessageChannel: () => new FakeMessageChannel() as unknown as MessageChannel,
      },
    });

    await expect(harness.source.prepare()).rejects.toThrow(/constructor failure/i);
    await vi.waitFor(() => {
      const failed = getFilePlaybackUniversalLifecycleSnapshot();
      expect(kindDelta(baseline, failed, 'playbackSources', 'unconfirmed')).toBe(1);
    });
    await harness.source.destroy();
  });
});

describe('BoundedStreamingPlaybackSource finalized start evidence', () => {
  it('accepts the exact Worklet started event after the room clock becomes unavailable', async () => {
    vi.useFakeTimers();
    let roomNowMs = 1_000;
    let roomClockAvailable = true;
    let unavailableClockReads = 0;
    const harness = lifecycleHarness({
      nowRoomTimeMs: () => {
        if (!roomClockAvailable) {
          unavailableClockReads += 1;
          throw new Error('synthetic expired room clock');
        }
        return roomNowMs;
      },
      nowMonotonicMs: () => 100,
    });

    try {
      await prepareLifecycleHarness(harness);
      await harness.source.connect(harness.destination);
      const { armed } = await armLifecycleHarness(harness);
      roomNowMs = 1_700;
      harness.audioContext.currentTime = 1.7;
      const finalized = await finalizeLifecycleHarness(harness);

      roomClockAvailable = false;
      await vi.advanceTimersByTimeAsync(2_000);
      emitExactStarted(harness, finalized);

      await expect(armed.started).resolves.toEqual({
        kind: 'worklet-observed',
        targetFrame: finalized.targetFrame,
        actualStartFrame: finalized.targetFrame,
      });
      expect(unavailableClockReads).toBe(0);
      expect(harness.source.getSnapshot()).toMatchObject({ phase: 'playing', errorCode: null });
    } finally {
      await destroyLifecycleHarness(harness);
      vi.useRealTimers();
    }
  });

  it('times out once on the captured render deadline even if the monotonic seam would reverse', async () => {
    vi.useFakeTimers();
    let roomNowMs = 1_000;
    let monotonicReads = 0;
    const harness = lifecycleHarness({
      nowRoomTimeMs: () => roomNowMs,
      nowMonotonicMs: () => {
        monotonicReads += 1;
        return monotonicReads === 1 ? 500 : 0;
      },
    });

    try {
      await prepareLifecycleHarness(harness);
      await harness.source.connect(harness.destination);
      const { armed } = await armLifecycleHarness(harness);
      roomNowMs = 1_700;
      harness.audioContext.currentTime = 1.7;
      await finalizeLifecycleHarness(harness);
      const settled = vi.fn();
      void armed.started.then(settled, settled);

      await vi.advanceTimersByTimeAsync(2_799);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(armed.started).rejects.toMatchObject({
        name: 'FilePlaybackStartEvidenceError',
        code: 'start-evidence-timeout',
      });
      expect(settled).toHaveBeenCalledTimes(1);
      expect(monotonicReads).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await destroyLifecycleHarness(harness);
      vi.useRealTimers();
    }
  });

  it('cannot let a cancelled attempt deadline reject its exact successor', async () => {
    vi.useFakeTimers();
    let roomNowMs = 1_000;
    const harness = lifecycleHarness({
      nowRoomTimeMs: () => roomNowMs,
      nowMonotonicMs: () => 700,
    });

    try {
      await prepareLifecycleHarness(harness);
      await harness.source.connect(harness.destination);
      const { armed: first } = await armLifecycleHarness(harness);
      roomNowMs = 1_700;
      harness.audioContext.currentTime = 1.7;
      await finalizeLifecycleHarness(harness);
      await vi.advanceTimersByTimeAsync(500);

      await harness.source.cancel({
        kind: 'file-playback-cancel',
        queueItemId: QID,
        runId: 'run-bounded-start-evidence',
        revision: 1,
        rendezvousId: 'rv-bounded-start-evidence',
        reasonCode: 'test-supersession',
      });
      await expect(first.started).rejects.toMatchObject({
        name: 'FilePlaybackStartEvidenceError',
        code: 'cancelled',
      });
      expect(vi.getTimerCount()).toBe(0);

      roomNowMs = 3_000;
      harness.audioContext.currentTime = 3;
      const successorArmIntent = rendezvousArmIntent({
        runId: 'run-bounded-successor',
        revision: 2,
        rendezvousId: 'rv-bounded-successor',
        startAtRoomTimeMs: 4_000,
        finalizeByRoomTimeMs: 3_800,
      });
      const successorPending = harness.source.armForCutover(successorArmIntent);
      const bind = await waitForControlMessage(
        harness.node,
        (message) => message.type === 'bind-pcm-port' && message.generation === 2,
      );
      if (bind.type !== 'bind-pcm-port') throw new Error('Expected successor PCM bind');
      harness.node.port.emit({
        protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
        type: 'pcm-port-retired',
        generation: 1,
      });
      harness.node.port.emit({
        protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
        type: 'primed',
        generation: bind.generation,
        bufferedFrames: 96_000,
        sampleRate: 48_000,
        channels: 2,
      });
      const successorArmCommand = await waitForControlMessage(
        harness.node,
        (message) => message.type === 'arm' && message.revision === 2,
      );
      if (successorArmCommand.type !== 'arm') throw new Error('Expected successor arm command');
      harness.node.port.emit({
        protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
        type: 'armed',
        generation: successorArmCommand.generation,
        revision: successorArmCommand.revision,
        runId: successorArmCommand.runId,
        rendezvousId: successorArmCommand.rendezvousId,
        targetFrame: successorArmCommand.targetFrame,
      });
      const successor = await successorPending;
      if (successor.status !== 'armed') throw new Error('Expected successor armed result');

      roomNowMs = 3_700;
      harness.audioContext.currentTime = 3.7;
      const finalized = await finalizeLifecycleHarness(
        harness,
        rendezvousFinalizeIntent({
          runId: 'run-bounded-successor',
          revision: 2,
          rendezvousId: 'rv-bounded-successor',
          startAtRoomTimeMs: 4_000,
          finalizedAtRoomTimeMs: 3_700,
        }),
      );
      const successorSettled = vi.fn();
      void successor.started.then(successorSettled, successorSettled);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(2_300);
      expect(successorSettled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      emitExactStarted(harness, finalized);

      await expect(successor.started).resolves.toMatchObject({
        kind: 'worklet-observed',
        targetFrame: finalized.targetFrame,
        actualStartFrame: finalized.targetFrame,
      });
      expect(successorSettled).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(harness.source.getSnapshot()).toMatchObject({ phase: 'playing', errorCode: null });
    } finally {
      await destroyLifecycleHarness(harness);
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import { AudioBufferPlaybackSource } from '../backends/audio-buffer-playback-source.ts';
import type {
  FilePlaybackPauseTransitionIntent,
  FilePlaybackSeekTransitionIntent,
} from '../file-playback-source.ts';
import type { RendezvousArmIntent, RendezvousFinalizeIntent } from '../rendezvous-contract.ts';

const QID = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const OTHER_QID = '00000000-0000-4000-8000-000000000002' as QueueItemId;

interface AutomationEvent {
  readonly value: number;
  readonly time: number;
}

class FakeAudioParam {
  value = 1;
  readonly automation: AutomationEvent[] = [];
  onSetValueAtTime: ((value: number, time: number) => void) | null = null;

  setValueAtTime(value: number, time: number): AudioParam {
    this.value = value;
    this.automation.push({ value, time });
    this.onSetValueAtTime?.(value, time);
    return this as unknown as AudioParam;
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

class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

class FakeBufferSourceNode extends FakeAudioNode {
  buffer: AudioBuffer | null = null;
  readonly playbackRate = new FakeAudioParam();
  onended: (() => void) | null = null;
  readonly starts: Array<{ when: number; offset: number }> = [];
  readonly stops: Array<number | undefined> = [];

  start(when = 0, offset = 0): void {
    if (this.context.failNextStart) {
      this.context.failNextStart = false;
      throw new Error('Synthetic AudioBufferSource start failure');
    }
    this.starts.push({ when, offset });
  }

  stop(when?: number): void {
    this.stops.push(when);
  }

  emitEnded(): void {
    this.onended?.();
  }
}

class FakeAudioContext {
  #currentTime = 1;
  roomNowMs = 1_000;
  state: AudioContextState = 'running';
  failNextStart = false;
  readonly sampleRate = 48_000;
  readonly sources: FakeBufferSourceNode[] = [];
  readonly gains: FakeGainNode[] = [];

  get currentTime(): number {
    return this.#currentTime;
  }

  set currentTime(value: number) {
    this.#currentTime = value;
    this.roomNowMs = value * 1_000;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeBufferSourceNode(this);
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    const gain = new FakeGainNode(this);
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }
}

function fakeBuffer(duration = 20): AudioBuffer {
  return {
    duration,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length: duration * 48_000,
  } as AudioBuffer;
}

function armIntent(overrides: Partial<RendezvousArmIntent> = {}): RendezvousArmIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-arm',
    queueItemId: QID,
    runId: 'run-3',
    revision: 3,
    rendezvousId: 'rv-3',
    recipientId: 'peer-1',
    positionSeconds: 4,
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
    runId: 'run-3',
    revision: 3,
    rendezvousId: 'rv-3',
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
    from: { queueItemId: QID, runId: 'run-3', revision: 3 },
    to: { queueItemId: QID, runId: 'run-3', revision: 4 },
    atRoomTimeMs: 3_000,
    ...overrides,
  };
}

function seekTransition(
  overrides: Partial<FilePlaybackSeekTransitionIntent> = {},
): FilePlaybackSeekTransitionIntent {
  return {
    kind: 'file-playback-seek-transition',
    from: { queueItemId: QID, runId: 'run-3', revision: 4 },
    to: { queueItemId: QID, runId: 'run-3', revision: 5 },
    positionSeconds: 12,
    atRoomTimeMs: 4_000,
    ...overrides,
  };
}

function harness(
  duration = 20,
  roomTimeMsToContextTime: (roomTimeMs: number) => number = (roomTimeMs) => roomTimeMs / 1000,
) {
  const context = new FakeAudioContext();
  const destination = new FakeAudioNode(context);
  const source = new AudioBufferPlaybackSource({
    queueItemId: QID,
    audioBuffer: fakeBuffer(duration),
    audioContext: context as unknown as AudioContext,
    nowRoomTimeMs: () => context.roomNowMs,
    roomTimeMsToContextTime,
    localPerformanceMsToContextTime: (localPerformanceTimeMs) => localPerformanceTimeMs / 1000,
  });
  return { context, destination, source };
}

async function prepareAndConnect(
  source: AudioBufferPlaybackSource,
  destination: FakeAudioNode,
): Promise<void> {
  await source.prepare();
  await source.connect(destination as unknown as AudioNode);
}

describe('AudioBufferPlaybackSource v2', () => {
  it('canonicalizes hostile rendezvous proxies before scheduling or storing them', async () => {
    const { destination, source } = harness();
    await prepareAndConnect(source, destination);
    let getCalls = 0;
    const arm = new Proxy(armIntent(), {
      get() {
        getCalls += 1;
        throw new Error('dynamic [[Get]] must not run');
      },
    });
    await expect(source.arm(arm)).resolves.toMatchObject({ status: 'armed' });

    const finalize = new Proxy(finalizeIntent(), {
      get() {
        getCalls += 1;
        throw new Error('dynamic [[Get]] must not run');
      },
    });
    await expect(source.finalize(finalize)).resolves.toMatchObject({ status: 'accepted' });
    expect(getCalls).toBe(0);

    const accessor = { ...armIntent({ revision: 4, runId: 'run-4', rendezvousId: 'rv-4' }) };
    Object.defineProperty(accessor, 'positionSeconds', {
      enumerable: true,
      get() {
        getCalls += 1;
        return 0;
      },
    });
    await expect(source.arm(accessor)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'invalid-contract',
    });
    expect(getCalls).toBe(0);
  });

  it('does not finalize an execution cancelled by a reentrant intent Proxy', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await expect(source.arm(armIntent())).resolves.toMatchObject({ status: 'armed' });
    const gate = context.gains[0]!;
    const hostileFinalize = new Proxy(finalizeIntent(), {
      ownKeys(target) {
        void source.cancel({
          kind: 'file-playback-cancel',
          queueItemId: QID,
          runId: 'run-3',
          revision: 3,
          rendezvousId: 'rv-3',
          reasonCode: 'proxy-reentered-cancel',
        });
        return Reflect.ownKeys(target);
      },
    });

    await expect(source.finalize(hostileFinalize)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'operation-superseded',
    });
    expect(gate.gain.automation).not.toContainEqual({ value: 1, time: 2 });
    expect(source.getSnapshot()).toMatchObject({ phase: 'cancelled' });
  });

  it('does not let a stale rendezvous cancel reentry supersede exact finalization', async () => {
    const { destination, source } = harness();
    await prepareAndConnect(source, destination);
    await expect(source.arm(armIntent())).resolves.toMatchObject({ status: 'armed' });
    const hostileFinalize = new Proxy(finalizeIntent(), {
      ownKeys(target) {
        void source.cancel({
          kind: 'file-playback-cancel',
          queueItemId: QID,
          runId: 'run-3',
          revision: 3,
          rendezvousId: 'rv-stale',
          reasonCode: 'stale-reentrant-cancel',
        });
        return Reflect.ownKeys(target);
      },
    });

    await expect(source.finalize(hostileFinalize)).resolves.toMatchObject({
      status: 'accepted',
      reasonCode: null,
    });
    expect(source.getSnapshot()).toMatchObject({ phase: 'armed' });
  });

  it('does not reconcile a due arm while rejecting a stale rendezvous cancel', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await expect(source.arm(armIntent())).resolves.toMatchObject({ status: 'armed' });
    const nativeSource = context.sources[0]!;
    context.currentTime = 1.9;

    await expect(
      source.cancel({
        kind: 'file-playback-cancel',
        queueItemId: QID,
        runId: 'run-3',
        revision: 3,
        rendezvousId: 'rv-stale',
        reasonCode: 'stale-after-finalize-deadline',
      }),
    ).resolves.toMatchObject({ phase: 'armed' });
    expect(nativeSource.stops).toHaveLength(0);

    expect(source.getSnapshot()).toMatchObject({ phase: 'paused' });
    expect(nativeSource.stops).toHaveLength(1);
  });

  it.each(['cancel', 'destroy', 're-arm'] as const)(
    'does not accept or prove a finalize whose inner gate setter re-enters %s',
    async (action) => {
      const { context, destination, source } = harness();
      await prepareAndConnect(source, destination);
      const armed = await source.armForCutover(armIntent());
      if (armed.status !== 'armed') throw new Error('Expected an armed cutover');
      const gate = context.gains[0]!;
      let nestedOperation: Promise<unknown> | null = null;
      gate.gain.onSetValueAtTime = (value, time) => {
        if (value !== 1 || time !== 2 || nestedOperation !== null) return;
        if (action === 'cancel') {
          nestedOperation = source.cancel({
            kind: 'file-playback-cancel',
            queueItemId: QID,
            runId: 'run-3',
            revision: 3,
            rendezvousId: 'rv-3',
            reasonCode: 'setter-reentered-cancel',
          });
        } else if (action === 'destroy') {
          nestedOperation = source.destroy();
        } else {
          nestedOperation = source.armForCutover(
            armIntent({
              revision: 4,
              runId: 'run-4',
              rendezvousId: 'rv-4',
              startAtRoomTimeMs: 3_000,
              finalizeByRoomTimeMs: 2_800,
            }),
          );
        }
      };

      context.currentTime = 1.7;
      await expect(source.finalize(finalizeIntent())).resolves.toMatchObject({
        status: 'rejected',
        reasonCode: 'operation-superseded',
      });
      await nestedOperation;
      await expect(armed.started).rejects.toMatchObject({
        code: 'execution-retired',
      });
      expect(gate.disconnectCount).toBeGreaterThan(0);

      if (action === 're-arm') {
        expect(source.getSnapshot()).toMatchObject({
          revision: 4,
          phase: 'armed',
          run: { runId: 'run-4', revision: 4 },
        });
      } else {
        expect(source.getSnapshot()).toMatchObject({
          phase: action === 'cancel' ? 'cancelled' : 'destroyed',
        });
      }
    },
  );

  it('does not let a reentrant room-time mapper roll a newer arm back', async () => {
    let source!: AudioBufferPlaybackSource;
    let nestedArm: Promise<unknown> | null = null;
    let reenter = true;
    const h = harness(20, (roomTimeMs) => {
      if (reenter) {
        reenter = false;
        nestedArm = source.arm(
          armIntent({
            revision: 4,
            runId: 'run-4',
            rendezvousId: 'rv-4',
            startAtRoomTimeMs: 3_000,
            finalizeByRoomTimeMs: 2_800,
          }),
        );
      }
      return roomTimeMs / 1_000;
    });
    source = h.source;
    await prepareAndConnect(source, h.destination);

    await expect(source.arm(armIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'operation-superseded',
    });
    await nestedArm;
    expect(source.getSnapshot()).toMatchObject({
      revision: 4,
      run: { runId: 'run-4', revision: 4 },
      phase: 'armed',
    });
    expect(h.context.sources).toHaveLength(1);
    expect(h.context.sources[0]!.stops).toHaveLength(0);
  });

  it('does not plant an idle seek after its mapper re-enters a newer arm', async () => {
    let source!: AudioBufferPlaybackSource;
    let triggerReentry = false;
    let nestedArm: Promise<unknown> | null = null;
    const h = harness(20, (roomTimeMs) => {
      if (triggerReentry) {
        triggerReentry = false;
        nestedArm = source.arm(
          armIntent({
            revision: 4,
            runId: 'run-4',
            rendezvousId: 'rv-4',
            startAtRoomTimeMs: 3_000,
            finalizeByRoomTimeMs: 2_800,
          }),
        );
      }
      return roomTimeMs / 1_000;
    });
    source = h.source;
    await prepareAndConnect(source, h.destination);
    await source.arm(armIntent());
    await source.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-3',
      revision: 3,
      rendezvousId: 'rv-3',
      reasonCode: 'prepare-idle-seek',
    });
    triggerReentry = true;

    await source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-3',
      revision: 3,
      positionSeconds: 9,
      atRoomTimeMs: 2_500,
    });
    await nestedArm;
    h.context.currentTime = 4;
    expect(source.getSnapshot()).toMatchObject({
      revision: 4,
      run: { runId: 'run-4', revision: 4 },
      phase: 'paused',
      positionSeconds: 4,
    });
    expect(source.getSnapshot()).toMatchObject({
      revision: 4,
      phase: 'paused',
      positionSeconds: 4,
    });
  });

  it('prepares independently, then accepts only a same-context destination', async () => {
    const { context, destination, source } = harness();

    expect(source.getSnapshot()).toMatchObject({
      backend: 'audio-buffer',
      phase: 'new',
      durationSeconds: 20,
      outputSampleRateHz: 48_000,
      channelCount: 2,
    });
    await expect(source.connect(destination as unknown as AudioNode)).rejects.toThrow(/prepared/);
    await expect(source.prepare()).resolves.toMatchObject({ phase: 'ready' });

    const foreignDestination = new FakeAudioNode(new FakeAudioContext());
    await expect(source.connect(foreignDestination as unknown as AudioNode)).rejects.toThrow(
      /another AudioContext/,
    );
    await expect(source.connect(destination as unknown as AudioNode)).resolves.toMatchObject({
      phase: 'connected',
    });
    expect(context.sources).toHaveLength(0);
  });

  it('arms a one-shot source silently and opens its gate only on exact finalization', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);

    const armed = await source.arm(armIntent());
    expect(armed).toMatchObject({
      status: 'armed',
      observedAtRoomTimeMs: 1_000,
      bufferedAheadSeconds: 16,
    });
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.starts).toEqual([{ when: 2, offset: 4 }]);
    expect(context.sources[0]?.playbackRate.value).toBe(1);
    expect(context.gains[0]?.gain.automation).toEqual([{ value: 0, time: 1 }]);

    context.currentTime = 1.7;
    const finalIntent = finalizeIntent();
    const finalized = await source.finalize(finalIntent);
    expect(finalized).toMatchObject({
      status: 'accepted',
      observedAtRoomTimeMs: 1_700,
    });
    expect(context.gains[0]?.gain.automation).toEqual([
      { value: 0, time: 1 },
      { value: 1, time: 2 },
    ]);

    // An exact retry is idempotent, while a subtly different commit cannot
    // reopen or retime an already-finalized gate.
    await expect(source.finalize(finalIntent)).resolves.toBe(finalized);
    await expect(
      source.finalize(finalizeIntent({ finalizedAtRoomTimeMs: 1_701 })),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'finalize-mismatch' });
    expect(context.gains[0]?.gain.automation).toHaveLength(2);

    expect(source.positionAt(2_500)).toMatchObject({
      phase: 'playing',
      positionSeconds: 4.5,
      bufferedAheadSeconds: 15.5,
    });
  });

  it('returns one exact cutover target and evidence promise for idempotent retries', async () => {
    vi.useFakeTimers();
    const { context, destination, source } = harness();
    try {
      await prepareAndConnect(source, destination);
      const first = await source.armForCutover(armIntent());
      expect(first.status).toBe('armed');
      if (first.status !== 'armed') throw new Error('Expected an armed cutover result');
      expect(first.target).toMatchObject({
        audioContext: context,
        contextTimeSeconds: 2,
        targetFrame: 96_000,
      });
      expect(Object.getPrototypeOf(first.target)).toBeNull();
      expect(Object.isFrozen(first.target)).toBe(true);

      const retry = await source.armForCutover(armIntent());
      expect(retry).toBe(first);
      if (retry.status !== 'armed') throw new Error('Expected an armed retry');
      expect(retry.target).toBe(first.target);
      expect(retry.started).toBe(first.started);

      let evidenceState = 'pending';
      void first.started.then(
        () => {
          evidenceState = 'resolved';
        },
        () => {
          evidenceState = 'rejected';
        },
      );
      context.currentTime = 1.7;
      await source.finalize(finalizeIntent());
      await vi.advanceTimersByTimeAsync(100);
      expect(evidenceState).toBe('pending');

      context.currentTime = 2;
      context.state = 'suspended';
      await vi.advanceTimersByTimeAsync(100);
      expect(evidenceState).toBe('pending');

      context.state = 'running';
      await vi.advanceTimersByTimeAsync(100);
      await expect(first.started).resolves.toEqual({
        kind: 'webaudio-schedule-passed',
        targetFrame: 96_000,
      });
      expect(evidenceState).toBe('resolved');
    } finally {
      await source.destroy();
      vi.useRealTimers();
    }
  });

  it('returns null cutover data for rejected arms and rejects every retired attempt', async () => {
    const { destination, source } = harness();
    await prepareAndConnect(source, destination);

    const rejected = await source.armForCutover(armIntent({ positionSeconds: 20 }));
    expect(rejected).toMatchObject({
      status: 'rejected',
      target: null,
      started: null,
      receipt: { status: 'rejected', reasonCode: 'offset-out-of-range' },
    });

    const first = await source.armForCutover(armIntent());
    if (first.status !== 'armed') throw new Error('Expected first arm');
    const second = await source.armForCutover(
      armIntent({
        revision: 4,
        runId: 'run-4',
        rendezvousId: 'rv-4',
        startAtRoomTimeMs: 3_000,
        finalizeByRoomTimeMs: 2_800,
      }),
    );
    await expect(first.started).rejects.toMatchObject({
      name: 'FilePlaybackStartEvidenceError',
    });
    if (second.status !== 'armed') throw new Error('Expected second arm');

    await source.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-4',
      revision: 4,
      rendezvousId: 'rv-stale',
      reasonCode: 'stale-attempt-cancel',
    });
    expect(source.getSnapshot()).toMatchObject({
      phase: 'armed',
      run: { runId: 'run-4', revision: 4 },
    });

    await source.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-4',
      revision: 4,
      rendezvousId: 'rv-4',
      reasonCode: 'test-cancel',
    });
    await expect(second.started).rejects.toMatchObject({
      name: 'FilePlaybackStartEvidenceError',
    });

    const third = await source.armForCutover(
      armIntent({
        revision: 5,
        runId: 'run-5',
        rendezvousId: 'rv-5',
        startAtRoomTimeMs: 4_000,
        finalizeByRoomTimeMs: 3_800,
      }),
    );
    if (third.status !== 'armed') throw new Error('Expected third arm');
    await source.destroy();
    await expect(third.started).rejects.toMatchObject({
      name: 'FilePlaybackStartEvidenceError',
    });
  });

  it('bounds a suspended AudioContext start-evidence wait by the room clock', async () => {
    vi.useFakeTimers();
    const { context, destination, source } = harness();
    try {
      await prepareAndConnect(source, destination);
      const armed = await source.armForCutover(armIntent());
      if (armed.status !== 'armed') throw new Error('Expected armed cutover');
      context.currentTime = 1.7;
      await source.finalize(finalizeIntent());
      context.state = 'suspended';
      context.roomNowMs = 4_501;
      await vi.advanceTimersByTimeAsync(50);
      await expect(armed.started).rejects.toMatchObject({
        name: 'FilePlaybackStartEvidenceError',
        code: 'start-evidence-timeout',
      });
    } finally {
      await source.destroy();
      vi.useRealTimers();
    }
  });

  it('keeps a scheduled source muted when finalization never arrives', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.arm(armIntent());

    context.currentTime = 2.5;
    expect(source.getSnapshot()).toMatchObject({ phase: 'paused', positionSeconds: 4 });
    expect(context.gains[0]?.gain.automation.some(({ value }) => value === 1)).toBe(false);
    expect(context.sources[0]?.stops).toEqual([undefined]);
    expect(context.sources[0]?.disconnectCount).toBe(1);

    context.sources[0]?.emitEnded();
    expect(source.getSnapshot()).toMatchObject({ phase: 'paused', positionSeconds: 4 });
    expect(source.getSnapshot().phase).not.toBe('ended');
  });

  it('reports and retires a final commit that misses the arm deadline', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.arm(armIntent());

    context.currentTime = 1.81;
    await expect(source.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'missed-deadline',
      reasonCode: 'finalization-after-deadline',
    });
    expect(context.gains[0]?.gain.automation.some(({ value }) => value === 1)).toBe(false);
    expect(context.sources[0]?.stops).toEqual([undefined]);
    expect(source.getSnapshot()).toMatchObject({ phase: 'paused', positionSeconds: 4 });
  });

  it('uses the monotonic room clock when AudioContext time is frozen', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.arm(armIntent());

    context.currentTime = 1.7;
    context.roomNowMs = 1_900;
    await expect(source.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'missed-deadline',
      reasonCode: 'finalization-after-deadline',
      observedAtRoomTimeMs: 1_900,
    });
    expect(context.gains[0]?.gain.automation.some(({ value }) => value === 1)).toBe(false);
  });

  it('refuses to arm or finalize while the shared AudioContext is not running', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    context.state = 'suspended';
    await expect(source.arm(armIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'audio-context-not-running',
    });

    context.state = 'running';
    await source.arm(armIntent());
    context.currentTime = 1.7;
    context.state = 'suspended';
    await expect(source.finalize(finalizeIntent())).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'audio-context-not-running',
    });
    expect(context.gains.at(-1)?.gain.automation.some(({ value }) => value === 1)).toBe(false);
  });

  it('rejects invalid offsets, past schedules, stale revisions, and mismatched identities', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);

    await expect(source.arm(armIntent({ queueItemId: OTHER_QID }))).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'queue-item-mismatch',
    });
    await expect(source.arm(armIntent({ positionSeconds: 20 }))).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'offset-out-of-range',
    });
    await expect(
      source.arm(armIntent({ startAtRoomTimeMs: 1_000, finalizeByRoomTimeMs: 900 })),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'start-not-in-future' });
    expect(context.sources).toHaveLength(0);

    await expect(source.arm(armIntent())).resolves.toMatchObject({ status: 'armed' });
    await expect(source.arm(armIntent({ revision: 2 }))).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'stale-revision',
    });
    await expect(source.arm(armIntent({ runId: 'other-run' }))).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'run-mismatch',
    });

    context.currentTime = 1.7;
    await expect(
      source.finalize(finalizeIntent({ rendezvousId: 'other-rv' })),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'rendezvous-mismatch' });
    expect(context.gains[0]?.gain.automation.some(({ value }) => value === 1)).toBe(false);
  });

  it('schedules an exact pause, seeks while paused, and replays through a fresh node', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.arm(armIntent());
    context.currentTime = 1.7;
    await source.finalize(finalizeIntent());

    context.currentTime = 2.5;
    await source.pause({
      kind: 'file-playback-pause',
      queueItemId: QID,
      runId: 'run-3',
      revision: 3,
      atRoomTimeMs: 3_000,
    });
    expect(context.sources[0]?.stops).toEqual([3]);
    expect(context.gains[0]?.gain.automation.at(-1)).toEqual({ value: 0, time: 3 });
    expect(source.positionAt(2_800)).toMatchObject({
      phase: 'playing',
      positionSeconds: 4.8,
    });
    expect(source.positionAt(3_200)).toMatchObject({
      phase: 'paused',
      positionSeconds: 5,
    });

    context.currentTime = 3.2;
    expect(source.getSnapshot()).toMatchObject({ phase: 'paused', positionSeconds: 5 });
    await source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-3',
      revision: 3,
      positionSeconds: 12,
      atRoomTimeMs: 3_200,
    });
    expect(source.getSnapshot()).toMatchObject({ phase: 'paused', positionSeconds: 12 });

    await expect(
      source.arm(
        armIntent({
          rendezvousId: 'rv-replay',
          positionSeconds: 12,
          startAtRoomTimeMs: 4_000,
          finalizeByRoomTimeMs: 3_800,
        }),
      ),
    ).resolves.toMatchObject({ status: 'armed' });
    expect(context.sources).toHaveLength(2);
    expect(context.sources[1]?.starts).toEqual([{ when: 4, offset: 12 }]);
  });

  it('advances a pause revision only after the exact WebAudio boundary passes', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.armForCutover(armIntent());
    context.currentTime = 1.7;
    await source.finalize(finalizeIntent());
    context.currentTime = 2.5;

    const scheduled = await source.pauseRevisioned(pauseTransition());
    expect(scheduled).toMatchObject({
      status: 'scheduled',
      from: { revision: 3 },
      to: { revision: 4 },
      target: { contextTimeSeconds: 3, targetFrame: 144_000 },
      snapshot: { phase: 'playing', revision: 3 },
    });
    if (scheduled.status !== 'scheduled') throw new Error('Expected scheduled pause');
    let applied = false;
    void scheduled.applied.then(() => {
      applied = true;
    });
    await Promise.resolve();
    expect(applied).toBe(false);
    expect(context.sources[0]?.stops).toEqual([3]);
    expect(source.getSnapshot()).toMatchObject({ phase: 'playing', revision: 3 });

    const retry = await source.pauseRevisioned({ ...pauseTransition() });
    expect(retry).toBe(scheduled);
    expect(context.sources[0]?.stops).toEqual([3]);

    context.currentTime = 3;
    expect(source.getSnapshot()).toMatchObject({
      phase: 'paused',
      revision: 4,
      run: { runId: 'run-3', revision: 4 },
      positionSeconds: 5,
    });
    await expect(scheduled.applied).resolves.toMatchObject({
      kind: 'pause-applied',
      observation: 'webaudio-schedule-passed',
      targetFrame: 144_000,
      appliedFrame: 144_000,
      from: { revision: 3 },
      to: { revision: 4 },
    });
  });

  it('applies a paused seek as the next revision without exposing it early', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.armForCutover(armIntent());
    context.currentTime = 1.7;
    await source.finalize(finalizeIntent());
    context.currentTime = 2.5;
    const pause = await source.pauseRevisioned(pauseTransition());
    if (pause.status !== 'scheduled') throw new Error('Expected scheduled pause');
    context.currentTime = 3;
    await pause.applied;

    const seek = await source.seekRevisioned(seekTransition());
    expect(seek).toMatchObject({
      status: 'scheduled',
      snapshot: { phase: 'paused', revision: 4, positionSeconds: 5 },
    });
    if (seek.status !== 'scheduled') throw new Error('Expected scheduled seek');
    context.currentTime = 3.9;
    expect(source.getSnapshot()).toMatchObject({ revision: 4, positionSeconds: 5 });
    context.currentTime = 4.01;
    expect(source.getSnapshot()).toMatchObject({
      phase: 'paused',
      revision: 5,
      positionSeconds: 12,
    });
    await expect(seek.applied).resolves.toMatchObject({
      kind: 'seek-applied',
      positionSeconds: 12,
      targetFrame: 192_000,
      appliedFrame: 192_480,
    });
  });

  it('rejects stale, non-consecutive, playing-seek, and past controls without native mutation', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.armForCutover(armIntent());
    context.currentTime = 1.7;
    await source.finalize(finalizeIntent());
    context.currentTime = 2.5;
    const node = context.sources[0];
    const automationCount = context.gains[0]?.gain.automation.length;

    await expect(
      source.pauseRevisioned(
        pauseTransition({
          from: { queueItemId: QID, runId: 'other-run', revision: 3 },
          to: { queueItemId: QID, runId: 'other-run', revision: 4 },
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'identity-mismatch' });
    await expect(
      source.pauseRevisioned(
        pauseTransition({ to: { queueItemId: QID, runId: 'run-3', revision: 3 } }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'non-consecutive-revision' });
    await expect(
      source.pauseRevisioned(
        pauseTransition({ to: { queueItemId: QID, runId: 'run-3', revision: 5 } }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'non-consecutive-revision' });
    await expect(
      source.seekRevisioned(
        seekTransition({
          from: { queueItemId: QID, runId: 'run-3', revision: 3 },
          to: { queueItemId: QID, runId: 'run-3', revision: 4 },
        }),
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: 'playing-seek-requires-cutover',
    });
    await expect(
      source.seekRevisioned(
        seekTransition({
          from: { queueItemId: QID, runId: 'run-3', revision: 3 },
          to: { queueItemId: QID, runId: 'run-3', revision: 4 },
          positionSeconds: 21,
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'position-out-of-range' });
    await expect(
      source.pauseRevisioned(pauseTransition({ atRoomTimeMs: 2_500 })),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'target-not-in-future' });
    expect(node?.stops).toEqual([]);
    expect(context.gains[0]?.gain.automation).toHaveLength(automationCount ?? 0);
  });

  it('rejects pending transition evidence on destruction and never advances its revision', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.armForCutover(armIntent());
    context.currentTime = 1.7;
    await source.finalize(finalizeIntent());
    context.currentTime = 2.5;
    const pause = await source.pauseRevisioned(pauseTransition());
    if (pause.status !== 'scheduled') throw new Error('Expected scheduled pause');

    await source.destroy();
    await expect(pause.applied).rejects.toMatchObject({
      name: 'FilePlaybackTransitionEvidenceError',
      code: 'source-destroyed',
    });
    expect(source.getSnapshot()).toMatchObject({ phase: 'destroyed', revision: 3, run: null });
  });

  it('revokes an applied transition retry cache when the source is destroyed', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.armForCutover(armIntent());
    context.currentTime = 1.7;
    await source.finalize(finalizeIntent());
    context.currentTime = 2.5;
    const pause = await source.pauseRevisioned(pauseTransition());
    if (pause.status !== 'scheduled') throw new Error('Expected scheduled pause');
    context.currentTime = 3;
    await pause.applied;
    expect(await source.pauseRevisioned({ ...pauseTransition() })).toBe(pause);

    await source.destroy();
    await expect(source.pauseRevisioned({ ...pauseTransition() })).resolves.toMatchObject({
      status: 'rejected',
      reason: 'source-destroyed',
      target: null,
      applied: null,
    });
  });

  it('rejects a pause whose native scheduling callback crosses the target boundary', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.armForCutover(armIntent());
    context.currentTime = 1.7;
    await source.finalize(finalizeIntent());
    context.currentTime = 2.5;
    const gain = context.gains[0]?.gain;
    if (!gain) throw new Error('Expected playback gate');
    gain.onSetValueAtTime = (value, time) => {
      if (value === 0 && time === 3) context.currentTime = 3;
    };

    await expect(source.pauseRevisioned(pauseTransition())).resolves.toMatchObject({
      status: 'rejected',
      reason: 'operation-superseded',
      snapshot: { revision: 3 },
    });
    expect(source.getSnapshot()).toMatchObject({ phase: 'paused', revision: 3 });
  });

  it('clamps deterministic positions and paused seeks to the media duration', async () => {
    const { context, destination, source } = harness(6);
    await prepareAndConnect(source, destination);
    await source.arm(armIntent({ positionSeconds: 5, startAtRoomTimeMs: 2_000 }));
    context.currentTime = 1.7;
    await source.finalize(finalizeIntent());

    expect(source.positionAt(9_000)).toMatchObject({
      phase: 'ended',
      positionSeconds: 6,
      bufferedAheadSeconds: 0,
    });
    context.currentTime = 3;
    expect(source.getSnapshot()).toMatchObject({ phase: 'ended', positionSeconds: 6 });

    await source.seek({
      kind: 'file-playback-seek',
      queueItemId: QID,
      runId: 'run-3',
      revision: 3,
      positionSeconds: 999,
      atRoomTimeMs: 3_000,
    });
    expect(source.getSnapshot()).toMatchObject({ phase: 'paused', positionSeconds: 6 });
  });

  it('lets only the current finalized audible node mark the source ended', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.arm(armIntent());
    const oldNode = context.sources[0];

    await source.cancel({
      kind: 'file-playback-cancel',
      queueItemId: QID,
      runId: 'run-3',
      revision: 3,
      rendezvousId: 'rv-3',
      reasonCode: 'superseded',
    });
    expect(oldNode?.stops).toEqual([undefined]);
    expect(oldNode?.disconnectCount).toBe(1);
    oldNode?.emitEnded();
    expect(source.getSnapshot().phase).toBe('cancelled');

    await source.arm(
      armIntent({
        revision: 4,
        runId: 'run-4',
        rendezvousId: 'rv-4',
        startAtRoomTimeMs: 3_000,
        finalizeByRoomTimeMs: 2_800,
      }),
    );
    context.currentTime = 2.7;
    await source.finalize(
      finalizeIntent({
        revision: 4,
        runId: 'run-4',
        rendezvousId: 'rv-4',
        startAtRoomTimeMs: 3_000,
        finalizedAtRoomTimeMs: 2_700,
      }),
    );
    context.sources[1]?.emitEnded();
    expect(source.getSnapshot()).toMatchObject({ phase: 'ended', positionSeconds: 20 });

    await source.destroy();
    await source.destroy();
    expect(source.getSnapshot()).toMatchObject({ phase: 'destroyed', run: null });
  });

  it('retires an older execution before a newer revision can fail scheduling', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    await source.arm(armIntent());
    context.currentTime = 1.7;
    await source.finalize(finalizeIntent());
    const oldSource = context.sources[0];

    context.currentTime = 2.2;
    context.failNextStart = true;
    await expect(
      source.arm(
        armIntent({
          revision: 4,
          runId: 'run-4',
          rendezvousId: 'rv-4',
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'schedule-failed' });

    expect(oldSource?.stops).toEqual([undefined]);
    expect(oldSource?.disconnectCount).toBe(1);
    oldSource?.emitEnded();
    expect(source.getSnapshot()).toMatchObject({
      phase: 'connected',
      revision: 4,
      run: { queueItemId: QID, runId: 'run-4', revision: 4 },
      positionSeconds: 4.2,
    });

    await expect(
      source.arm(
        armIntent({
          revision: 3,
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'stale-revision' });
    await expect(
      source.arm(
        armIntent({
          revision: 4,
          runId: 'different-run-4',
          rendezvousId: 'different-rv-4',
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
      ),
    ).resolves.toMatchObject({ status: 'rejected', reasonCode: 'run-mismatch' });
    await expect(
      source.arm(
        armIntent({
          revision: 4,
          runId: 'run-4',
          rendezvousId: 'rv-4',
          startAtRoomTimeMs: 3_000,
          finalizeByRoomTimeMs: 2_800,
        }),
      ),
    ).resolves.toMatchObject({ status: 'armed' });
  });

  it('claims a validated run watermark before first-run scheduling can fail', async () => {
    const { context, destination, source } = harness();
    await prepareAndConnect(source, destination);
    context.failNextStart = true;
    const intent = armIntent();

    await expect(source.arm(intent)).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'schedule-failed',
    });
    expect(source.getSnapshot()).toMatchObject({
      phase: 'connected',
      revision: 3,
      run: { queueItemId: QID, runId: 'run-3', revision: 3 },
    });
    await expect(source.arm(armIntent({ revision: 2 }))).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'stale-revision',
    });
    await expect(source.arm(armIntent({ runId: 'other-run' }))).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'run-mismatch',
    });
    await expect(source.arm(intent)).resolves.toMatchObject({ status: 'armed' });
  });
});

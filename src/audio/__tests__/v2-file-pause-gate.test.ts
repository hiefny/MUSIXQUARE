/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';

interface FakeAudioParam {
  value: number;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
}

interface FakeAudioNode {
  context: FakeAudioContext;
  gain: FakeAudioParam;
  frequency: FakeAudioParam;
  Q: FakeAudioParam;
  threshold: FakeAudioParam;
  ratio: FakeAudioParam;
  attack: FakeAudioParam;
  release: FakeAudioParam;
  knee: FakeAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

class FakeAudioContext {
  readonly state = 'running';
  readonly sampleRate = 48_000;
  readonly currentTime = 0;
  readonly destination = this.createNode();

  private createParam(value = 0): FakeAudioParam {
    return {
      value,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    };
  }

  private createNode(): FakeAudioNode {
    const node = {
      context: this,
      gain: this.createParam(1),
      frequency: this.createParam(),
      Q: this.createParam(),
      threshold: this.createParam(),
      ratio: this.createParam(),
      attack: this.createParam(),
      release: this.createParam(),
      knee: this.createParam(),
      connect: vi.fn((destination: FakeAudioNode) => destination),
      disconnect: vi.fn(),
    } satisfies FakeAudioNode;
    return node;
  }

  createGain(): GainNode {
    return this.createNode() as unknown as GainNode;
  }

  createChannelSplitter(): ChannelSplitterNode {
    return this.createNode() as unknown as ChannelSplitterNode;
  }

  createChannelMerger(): ChannelMergerNode {
    return this.createNode() as unknown as ChannelMergerNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    return this.createNode() as unknown as BiquadFilterNode;
  }

  createConvolver(): ConvolverNode {
    return this.createNode() as unknown as ConvolverNode;
  }

  createDynamicsCompressor(): DynamicsCompressorNode {
    return this.createNode() as unknown as DynamicsCompressorNode;
  }

  createWaveShaper(): WaveShaperNode {
    return this.createNode() as unknown as WaveShaperNode;
  }

  createAnalyser(): AnalyserNode {
    return this.createNode() as unknown as AnalyserNode;
  }
}

const audioHarness = vi.hoisted(() => ({
  context: null as FakeAudioContext | null,
  rampParam: vi.fn((param: FakeAudioParam, target: number) => {
    param.value = target;
  }),
}));

vi.mock('../context.ts', () => ({
  getAudioContext: () => audioHarness.context,
  ensureRunning: vi.fn(async () => undefined),
}));

vi.mock('../context-recovery.ts', () => ({
  bindAudioContextInterruptionRecovery: vi.fn(() => () => undefined),
}));

vi.mock('../helpers.ts', () => {
  const makeNode = () => audioHarness.context!.createGain() as unknown as FakeAudioNode;
  return {
    rampParam: audioHarness.rampParam,
    safeDisconnect: vi.fn(),
    generateReverbIR: vi.fn(() => ({})),
    makeExciterCurve: vi.fn(() => new Float32Array(8)),
    getFullRangeFrequency: vi.fn(() => 20_000),
    createCrossFade: vi.fn(() => ({
      a: makeNode(),
      b: makeNode(),
      output: makeNode(),
    })),
    createStereoWidener: vi.fn(() => ({
      input: makeNode(),
      output: makeNode(),
      dispose: vi.fn(),
    })),
    createCascadedFilter: vi.fn(() => ({
      input: makeNode(),
      output: makeNode(),
      disconnect: vi.fn(),
    })),
  };
});

afterEach(() => {
  bus.clear();
});

describe('standard-room V2 file pause gate', () => {
  it('keeps route input closed across stale and overlapping token settlements', async () => {
    resetState();
    bus.clear();
    audioHarness.context = new FakeAudioContext();
    audioHarness.rampParam.mockClear();

    const { getFilePlaybackDestination, initAudio } = await import('../engine.ts');
    await initAudio();

    const input = getFilePlaybackDestination() as unknown as FakeAudioNode;
    expect(input.gain.value).toBe(1);

    bus.emit('player:v2-host-ui-control-pending', {
      token: 10,
      kind: 'pause',
      queueItemId: '00000000-0000-4000-8000-000000000001',
    });
    expect(input.gain.value).toBe(0);

    bus.emit('player:v2-host-ui-control-settled', {
      token: 9,
      kind: 'pause',
      queueItemId: '00000000-0000-4000-8000-000000000001',
      status: 'failed',
    });
    expect(input.gain.value).toBe(0);

    bus.emit('player:v2-guest-pause-gate-pending', { token: 20 });
    bus.emit('player:v2-host-ui-control-settled', {
      token: 10,
      kind: 'pause',
      queueItemId: '00000000-0000-4000-8000-000000000001',
      status: 'committed',
    });
    expect(input.gain.value).toBe(0);

    bus.emit('player:v2-guest-pause-gate-settled', { token: 19 });
    expect(input.gain.value).toBe(0);

    bus.emit('player:v2-guest-pause-gate-settled', { token: 20 });
    expect(input.gain.value).toBe(1);
    expect(audioHarness.rampParam.mock.calls.map(([, target]) => target)).toEqual([0, 0, 0, 1]);
  });
});

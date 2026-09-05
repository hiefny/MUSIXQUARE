/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState, getState } from '../../core/state.ts';

const engineMocks = vi.hoisted(() => ({
  getMasterGain: vi.fn(() => null as GainNode | null),
  getGainL: vi.fn(() => null as GainNode | null),
  getGainR: vi.fn(() => null as GainNode | null),
  getToneMerge: vi.fn(() => null as ChannelMergerNode | null),
  getGlobalLowPass: vi.fn(() => null as BiquadFilterNode | null),
}));

const helperMocks = vi.hoisted(() => ({
  rampParam: vi.fn(),
}));

// Keep jsdom away from native Web Audio while exposing graph-policy seams.
vi.mock('../engine.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine.ts')>();
  return {
    ...actual,
    ...engineMocks,
  };
});

vi.mock('../helpers.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helpers.ts')>();
  return { ...actual, rampParam: helperMocks.rampParam };
});

import { setChannelMode, toggleSurroundMode, setSurroundChannel } from '../channel.ts';

beforeEach(() => {
  vi.clearAllMocks();
  engineMocks.getMasterGain.mockReturnValue(null);
  engineMocks.getGainL.mockReturnValue(null);
  engineMocks.getGainR.mockReturnValue(null);
  engineMocks.getToneMerge.mockReturnValue(null);
  engineMocks.getGlobalLowPass.mockReturnValue(null);
  resetState();
});

describe('setChannelMode', () => {
  it('cancels prior role gain ramps before installing the Sub summing gain', async () => {
    const contextModule = await import('../context.ts');
    const context = vi
      .spyOn(contextModule, 'getAudioContext')
      .mockReturnValue({ currentTime: 0 } as AudioContext);
    const effects = await import('../effects.ts');
    const apply = vi.spyOn(effects, 'applySettingsAsync').mockImplementation(() => undefined);
    const helpers = await vi.importActual<typeof import('../helpers.ts')>('../helpers.ts');
    helperMocks.rampParam.mockImplementation(helpers.rampParam);
    const createGain = () => {
      const futureRamps: number[] = [];
      const gain = {
        value: 1,
        cancelScheduledValues: vi.fn(() => {
          futureRamps.length = 0;
        }),
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn((value: number) => {
          futureRamps.push(value);
        }),
      };
      return { gain, futureRamps, connect: vi.fn(), disconnect: vi.fn() };
    };
    const left = createGain();
    const right = createGain();
    engineMocks.getMasterGain.mockReturnValue({} as GainNode);
    engineMocks.getGainL.mockReturnValue(left as unknown as GainNode);
    engineMocks.getGainR.mockReturnValue(right as unknown as GainNode);
    engineMocks.getToneMerge.mockReturnValue({} as ChannelMergerNode);
    try {
      setChannelMode(0);
      expect(left.futureRamps).toEqual([1]);
      expect(right.futureRamps).toEqual([1]);
      setChannelMode(2);
      for (const node of [left, right]) {
        expect(node.gain.value).toBe(0.5);
        expect(node.futureRamps).toEqual([]);
      }
      setChannelMode(1);
      expect(left.futureRamps).toEqual([1]);
      expect(right.futureRamps).toEqual([1]);
    } finally {
      context.mockRestore();
      apply.mockRestore();
      helperMocks.rampParam.mockReset();
    }
  });

  it('mode 0 (Stereo) updates audio.channelMode in state', () => {
    setChannelMode(0);
    expect(getState('audio.channelMode')).toBe(0);
  });

  it('mode -1 (Left) updates audio.channelMode in state', () => {
    setChannelMode(-1);
    expect(getState('audio.channelMode')).toBe(-1);
  });

  it('mode 1 (Right) updates audio.channelMode in state', () => {
    setChannelMode(1);
    expect(getState('audio.channelMode')).toBe(1);
  });

  it('mode 2 (Sub) updates audio.channelMode in state', () => {
    setChannelMode(2);
    expect(getState('audio.channelMode')).toBe(2);
  });

  it('switching modes updates state correctly', () => {
    setChannelMode(1);
    expect(getState('audio.channelMode')).toBe(1);

    setChannelMode(-1);
    expect(getState('audio.channelMode')).toBe(-1);

    setChannelMode(0);
    expect(getState('audio.channelMode')).toBe(0);
  });

  it('default state is 0 (Stereo)', () => {
    expect(getState('audio.channelMode')).toBe(0);
  });
});

describe('toggleSurroundMode', () => {
  it('enabling surround sets audio.isSurroundMode to true', () => {
    toggleSurroundMode(true);
    expect(getState('audio.isSurroundMode')).toBe(true);
  });

  it('disabling surround sets audio.isSurroundMode to false', () => {
    toggleSurroundMode(true);
    toggleSurroundMode(false);
    expect(getState('audio.isSurroundMode')).toBe(false);
  });

  it('default surround mode is false', () => {
    expect(getState('audio.isSurroundMode')).toBe(false);
  });

  it('toggling on then off restores false', () => {
    expect(getState('audio.isSurroundMode')).toBe(false);
    toggleSurroundMode(true);
    expect(getState('audio.isSurroundMode')).toBe(true);
    toggleSurroundMode(false);
    expect(getState('audio.isSurroundMode')).toBe(false);
  });

  it('preserves the selected channel across an off/on cycle without graph primitives', () => {
    toggleSurroundMode(true);
    setSurroundChannel(6);
    toggleSurroundMode(false);
    toggleSurroundMode(true);

    expect(getState('audio.isSurroundMode')).toBe(true);
    expect(getState('audio.surroundChannelIndex')).toBe(6);
  });

  it('retains the LFE low-pass and output-role policy outside route ownership', () => {
    const gainL = {
      gain: {},
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as GainNode;
    const gainR = {
      gain: {},
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as GainNode;
    const merge = {} as ChannelMergerNode;
    const frequency = {} as AudioParam;
    const lowPass = {
      context: { sampleRate: 48_000 },
      frequency,
    } as unknown as BiquadFilterNode;
    engineMocks.getGainL.mockReturnValue(gainL);
    engineMocks.getGainR.mockReturnValue(gainR);
    engineMocks.getToneMerge.mockReturnValue(merge);
    engineMocks.getGlobalLowPass.mockReturnValue(lowPass);

    toggleSurroundMode(true);
    helperMocks.rampParam.mockClear();
    setSurroundChannel(3);

    expect(helperMocks.rampParam).toHaveBeenCalledWith(
      frequency,
      getState('audio.subFreq'),
      expect.any(Number),
    );
    expect(gainL.connect).toHaveBeenCalledWith(merge, 0, 0);
    expect(gainR.connect).toHaveBeenCalledWith(merge, 0, 1);
  });
});

describe('surround channel index state', () => {
  it('default surroundChannelIndex is -1', () => {
    expect(getState('audio.surroundChannelIndex')).toBe(-1);
  });

  it('setSurroundChannel updates audio.surroundChannelIndex for index 0', () => {
    setSurroundChannel(0);
    expect(getState('audio.surroundChannelIndex')).toBe(0);
  });

  it('setSurroundChannel updates for index 2 (Center)', () => {
    setSurroundChannel(2);
    expect(getState('audio.surroundChannelIndex')).toBe(2);
  });

  it('setSurroundChannel updates for index 3 (LFE)', () => {
    setSurroundChannel(3);
    expect(getState('audio.surroundChannelIndex')).toBe(3);
  });

  it('setSurroundChannel updates for index 7 (max)', () => {
    setSurroundChannel(7);
    expect(getState('audio.surroundChannelIndex')).toBe(7);
  });

  it('setSurroundChannel updates state for all indices 0-7', () => {
    for (let idx = 0; idx <= 7; idx++) {
      setSurroundChannel(idx);
      expect(getState('audio.surroundChannelIndex')).toBe(idx);
    }
  });

  it('toggleSurroundMode(true) sets isSurroundMode and defaults to Center channel', () => {
    toggleSurroundMode(true);
    expect(getState('audio.isSurroundMode')).toBe(true);
    expect(getState('audio.surroundChannelIndex')).toBe(2);
  });
});

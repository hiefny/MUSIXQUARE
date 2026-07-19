/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';

const contextMock = vi.hoisted(() => ({
  getAudioContext: vi.fn(),
}));

vi.mock('../context.ts', () => contextMock);

import {
  initUiSounds,
  isUiSoundsEnabled,
  playAnnouncementSound,
  playUiTouchSound,
  resetUiSoundsForTests,
  setUiSoundsEnabled,
} from '../ui-sounds.ts';

type FakeAudioContext = AudioContext & {
  createBufferSource: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
};

function audioParam(value = 0): AudioParam {
  return {
    value,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  } as unknown as AudioParam;
}

function audioNode(): AudioNode {
  return { connect: vi.fn() } as unknown as AudioNode;
}

function createFakeContext(): FakeAudioContext {
  const createBufferSource = vi.fn(() => ({
    ...audioNode(),
    buffer: null,
    start: vi.fn(),
  }));
  const createOscillator = vi.fn(() => ({
    ...audioNode(),
    type: 'sine',
    frequency: audioParam(),
    start: vi.fn(),
    stop: vi.fn(),
  }));
  return {
    state: 'running',
    currentTime: 10,
    sampleRate: 48_000,
    destination: audioNode(),
    resume: vi.fn().mockResolvedValue(undefined),
    createGain: vi.fn(() => ({ ...audioNode(), gain: audioParam(1) })),
    createDynamicsCompressor: vi.fn(() => ({
      ...audioNode(),
      threshold: audioParam(),
      knee: audioParam(),
      ratio: audioParam(),
      attack: audioParam(),
      release: audioParam(),
    })),
    createStereoPanner: vi.fn(() => ({ ...audioNode(), pan: audioParam() })),
    createBuffer: vi.fn((_channels: number, length: number) => {
      const data = new Float32Array(length);
      return { getChannelData: vi.fn(() => data) };
    }),
    createBufferSource,
    createOscillator,
  } as unknown as FakeAudioContext;
}

async function flushSounds(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('UI sounds', () => {
  let context: FakeAudioContext;

  beforeEach(() => {
    resetUiSoundsForTests();
    resetState();
    bus.clear();
    localStorage.clear();
    context = createFakeContext();
    contextMock.getAudioContext.mockReset().mockReturnValue(context);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('defaults off and persists an explicit local opt-in', () => {
    const changed = vi.fn();
    bus.on('ui:ui-sounds-changed', changed);

    expect(isUiSoundsEnabled()).toBe(false);
    setUiSoundsEnabled(true);

    expect(isUiSoundsEnabled()).toBe(true);
    expect(localStorage.getItem('musixquare-ui-sounds-enabled')).toBe('1');
    expect(changed).toHaveBeenCalledWith(true);
  });

  it('does not synthesize while disabled but can preview the opt-in sound', async () => {
    playUiTouchSound();
    await flushSounds();
    expect(context.createBufferSource).not.toHaveBeenCalled();

    playUiTouchSound({ force: true });
    await flushSounds();
    expect(context.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it('plays through a unity-gain output bus', async () => {
    playUiTouchSound({ force: true });
    await flushSounds();

    const output = context.createGain.mock.results[0]?.value as GainNode | undefined;
    expect(output?.gain.value).toBe(1);
  });

  it('plays the self-entry micro echo only when a session actually starts', async () => {
    setUiSoundsEnabled(true);
    initUiSounds();

    setState('network.appRole', 'host');
    await flushSounds();
    expect(context.createOscillator).not.toHaveBeenCalled();

    setState('setup.sessionStarted', true);
    await flushSounds();
    expect(context.createOscillator).toHaveBeenCalledTimes(2);

    setState('network.appRole', 'guest');
    await flushSounds();
    expect(context.createOscillator).toHaveBeenCalledTimes(2);
  });

  it('schedules the two-tone announcement chime only when enabled', async () => {
    playAnnouncementSound();
    await flushSounds();
    expect(context.createOscillator).not.toHaveBeenCalled();

    setUiSoundsEnabled(true);
    playAnnouncementSound();
    await flushSounds();
    expect(context.createOscillator).toHaveBeenCalledTimes(2);
  });
});

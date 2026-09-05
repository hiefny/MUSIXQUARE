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
  playChatSystemEventSound,
  playUiTouchSound,
  resetUiSoundsForTests,
  setUiSoundsEnabled,
} from '../ui-sounds.ts';

type FakeAudioContext = AudioContext & {
  createBufferSource: ReturnType<typeof vi.fn>;
  createDynamicsCompressor: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
  createStereoPanner: ReturnType<typeof vi.fn>;
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

function scheduledFrequencies(context: FakeAudioContext): number[] {
  return context.createOscillator.mock.results.map((result) => {
    const oscillator = result.value as OscillatorNode;
    return vi.mocked(oscillator.frequency.setValueAtTime).mock.calls[0]?.[0] ?? Number.NaN;
  });
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

  it('keeps the selected sound opt-in for this page when a full localStorage rejects its new key', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    });
    try {
      // The settings button calls this setter; unlike the immediate forced
      // preview, subsequent ordinary sound must honor the same local choice.
      setUiSoundsEnabled(true);
      expect(localStorage.getItem('musixquare-ui-sounds-enabled')).toBeNull();
      expect(isUiSoundsEnabled()).toBe(true);
      playUiTouchSound();
      await flushSounds();
      expect(context.createBufferSource).toHaveBeenCalledOnce();
      // A later successful choice resumes the normal persistent/cross-tab
      // reader instead of keeping an obsolete page override forever.
      setUiSoundsEnabled(false);
      expect(isUiSoundsEnabled()).toBe(false);
      expect(localStorage.getItem('musixquare-ui-sounds-enabled')).toBe('0');
      localStorage.setItem('musixquare-ui-sounds-enabled', '1');
      expect(isUiSoundsEnabled()).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  it('continues reading ordinary persisted changes when no local write failed', () => {
    setUiSoundsEnabled(true);
    localStorage.setItem('musixquare-ui-sounds-enabled', '0');
    expect(isUiSoundsEnabled()).toBe(false);
  });

  it('does not synthesize while disabled but can preview the opt-in sound', async () => {
    playUiTouchSound();
    await flushSounds();
    expect(context.createBufferSource).not.toHaveBeenCalled();

    playUiTouchSound({ force: true });
    await flushSounds();
    expect(context.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it.each(['touch', 'announcement', 'session'] as const)(
    'rechecks sound opt-in and visibility after native resume: %s',
    async (kind) => {
      for (const change of ['disabled', 'hidden', 'current'] as const) {
        resetUiSoundsForTests();
        setUiSoundsEnabled(true);
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: 'visible',
        });
        Object.defineProperty(context, 'state', { configurable: true, value: 'suspended' });
        let finishResume!: () => void;
        const resume = new Promise<void>((resolve) => {
          finishResume = resolve;
        });
        vi.mocked(context.resume).mockReturnValueOnce(resume);
        context.createBufferSource.mockClear();
        context.createOscillator.mockClear();
        if (kind === 'touch') playUiTouchSound();
        else if (kind === 'announcement') playAnnouncementSound();
        else playChatSystemEventSound('chat.peer_connected', { name: 'Peer 2' });
        if (change === 'disabled') setUiSoundsEnabled(false);
        if (change === 'hidden') {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
          });
        }
        Object.defineProperty(context, 'state', { configurable: true, value: 'running' });
        finishResume();
        await flushSounds();
        expect(context.createBufferSource).toHaveBeenCalledTimes(
          change === 'current' && kind === 'touch' ? 1 : 0,
        );
        expect(context.createOscillator).toHaveBeenCalledTimes(
          change === 'current' && kind !== 'touch' ? 2 : 0,
        );
      }
    },
  );

  it('keeps touch feedback at unity and gives attention sounds one shared makeup gain', async () => {
    playUiTouchSound({ force: true });
    await flushSounds();

    const touchInput = context.createGain.mock.results[0]?.value as GainNode | undefined;
    const attentionInput = context.createGain.mock.results[1]?.value as GainNode | undefined;
    const attentionOutput = context.createGain.mock.results[2]?.value as GainNode | undefined;
    const touchCompressor = context.createDynamicsCompressor.mock.results[0]?.value as
      | DynamicsCompressorNode
      | undefined;
    const attentionCompressor = context.createDynamicsCompressor.mock.results[1]?.value as
      | DynamicsCompressorNode
      | undefined;
    const touchSource = context.createBufferSource.mock.results[0]?.value as
      | AudioBufferSourceNode
      | undefined;

    expect(touchInput?.gain.value).toBe(1);
    expect(attentionInput?.gain.value).toBe(1);
    expect(attentionOutput?.gain.value).toBe(2.5);
    expect(touchInput?.connect).toHaveBeenCalledWith(touchCompressor);
    expect(touchCompressor?.connect).toHaveBeenCalledWith(context.destination);
    expect(attentionInput?.connect).toHaveBeenCalledWith(attentionCompressor);
    expect(attentionCompressor?.connect).toHaveBeenCalledWith(attentionOutput);
    expect(attentionOutput?.connect).toHaveBeenCalledWith(context.destination);
    expect(touchSource?.connect).toHaveBeenCalledWith(touchInput);
  });

  it('routes announcements through the amplified attention bus', async () => {
    setUiSoundsEnabled(true);
    playAnnouncementSound();
    await flushSounds();

    const attentionInput = context.createGain.mock.results[1]?.value as GainNode | undefined;
    const panners = context.createStereoPanner.mock.results.map(
      (result) => result.value as StereoPannerNode,
    );

    expect(panners).toHaveLength(2);
    for (const panner of panners) expect(panner.connect).toHaveBeenCalledWith(attentionInput);
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
    expect(scheduledFrequencies(context)).toEqual([523.25, 659.25]);
  });

  it('echoes the announcement high note when a participant enters', async () => {
    setUiSoundsEnabled(true);

    playChatSystemEventSound('chat.peer_connected', { name: 'Peer 2' });
    await flushSounds();

    expect(scheduledFrequencies(context)).toEqual([659.25, 659.25]);
  });

  it('echoes the announcement low note when a participant leaves', async () => {
    setUiSoundsEnabled(true);

    playChatSystemEventSound('chat.peer_disconnected', { name: 'Peer 2' });
    await flushSounds();

    expect(scheduledFrequencies(context)).toEqual([523.25, 523.25]);
  });
});

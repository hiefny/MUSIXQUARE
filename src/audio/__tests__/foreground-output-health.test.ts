/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';

const mocks = vi.hoisted(() => ({
  isPlayingFile: vi.fn(() => true),
  isPipelineBusy: vi.fn(() => false),
  getBuffer: vi.fn(() => ({ duration: 120 }) as AudioBuffer | null),
}));

vi.mock('../../player/ownership.ts', () => ({
  isPlaybackPlayingFile: mocks.isPlayingFile,
}));
vi.mock('../../player/transport.ts', () => ({
  isFilePipelineBusyForPlay: mocks.isPipelineBusy,
}));
vi.mock('../../player/_state.ts', () => ({
  getCurrentAudioBuffer: mocks.getBuffer,
}));

class FakeAudioContext {
  state: AudioContextState = 'running';
  currentTime = 4;
  readonly resume = vi.fn(async () => {
    this.state = 'running';
  });
  readonly suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  private readonly listeners = new Set<() => void>();

  addEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.listeners.delete(listener);
  }
}

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';

function stageFilePlayback(): void {
  setState('setup.sessionStarted', true);
  setState('playback.mode', 'file');
  setState('playback.activity', 'playing');
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
  setState('files.current', {
    name: 'resume.mp3',
    indexHint: 0,
    size: 10,
    mime: 'audio/mpeg',
    queueItemId: QUEUE_ITEM_ID,
    sessionId: 1,
    blob: new File(['audio'], 'resume.mp3', { type: 'audio/mpeg' }),
  });
}

describe('foreground restart and background output inspection ownership', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    stageFilePlayback();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a prepared generic restart parked until its single trusted gesture', async () => {
    const context = new FakeAudioContext();
    class AudioContextConstructor {
      constructor() {
        return context;
      }
    }
    vi.stubGlobal('AudioContext', AudioContextConstructor);
    const contextModule = await import('../context.ts');
    const { inspectBackgroundFileOutput } = await import('../output-health.ts');
    contextModule.getAudioContext();

    const checkToken = contextModule.armForegroundAudioContextClockHealthCheck(
      context as unknown as AudioContext,
    );
    const preparation = await contextModule.prepareForegroundAudioContextRestart(checkToken!);
    expect(preparation).toMatchObject({ status: 'prepared' });
    expect(context.state).toBe('suspended');

    await expect(inspectBackgroundFileOutput()).resolves.toEqual({
      status: 'stale',
      reason: 'superseded',
    });
    expect(context.resume).not.toHaveBeenCalled();
    expect(preparation?.isCurrent()).toBe(true);
    expect(context.state).toBe('suspended');

    await expect(
      contextModule.resumePreparedForegroundAudioContextRestartFromGesture(
        preparation!.attemptToken,
      ),
    ).resolves.toEqual({ running: true, requiresClockVerification: true });
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.state).toBe('running');
    expect(
      contextModule.getPendingForegroundAudioContextRestartClockHealthRequirement()?.attemptToken,
    ).toBe(preparation?.attemptToken);
    expect(contextModule.retireForegroundAudioContextRestart(preparation!.attemptToken)).toBe(true);
  });
});

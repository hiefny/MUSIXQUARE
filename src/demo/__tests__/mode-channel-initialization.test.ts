/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../player/transport.ts', () => ({
  fmtTime: (seconds: number) => String(seconds),
  getTrackPosition: () => 0,
  isFilePipelineBusyForPlay: () => false,
  pause: vi.fn(),
  play: vi.fn(async () => true),
  seekTo: vi.fn(),
  stopAllMedia: vi.fn(),
}));
vi.mock('../../network/shared-clock.ts', () => ({ getHostNow: () => 10_000 }));
vi.mock('../../network/peer.ts', () => ({ broadcast: vi.fn(), safeSend: vi.fn() }));
vi.mock('../../player/decode.ts', () => ({ loadDemoFile: vi.fn() }));
vi.mock('../../player/media-session-loader.ts', () => ({
  prepareMediaSession: vi.fn(async () => {}),
}));
vi.mock('../../audio/effects.ts', () => ({ applySettingsAsync: vi.fn() }));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: vi.fn() }));
vi.mock('../../ui/setup-shared.ts', () => ({ hideSetupOverlay: vi.fn() }));
vi.mock('../../ui/toast.ts', () => ({
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
}));
vi.mock('../../ui/dom.ts', () => ({ updateOverlayOpenClass: vi.fn() }));
vi.mock('../../ui/theme-chrome.ts', () => ({
  syncAppThemeChrome: vi.fn(),
  syncDemoThemeChrome: vi.fn(),
}));

class PendingXHR {
  static pending: PendingXHR[] = [];
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(): void {}
  send(): void {
    PendingXHR.pending.push(this);
  }
  abort(): void {
    this.onabort?.();
  }
}

function nativeContextFixture() {
  let releaseResume!: () => void;
  const resumed = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  const param = () => ({
    value: 1,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  });
  const createNode = () => {
    const inputs = new Set<number>();
    return {
      context,
      inputs,
      gain: param(),
      frequency: param(),
      Q: param(),
      threshold: param(),
      ratio: param(),
      knee: param(),
      attack: param(),
      release: param(),
      connect: vi.fn((_destination: AudioNode, _output?: number, input?: number) => {
        if (input !== undefined) inputs.add(input);
      }),
      disconnect: vi.fn(() => inputs.clear()),
    };
  };
  const context = Object.assign(new EventTarget(), {
    state: 'suspended',
    currentTime: 0,
    sampleRate: 8000,
    destination: {},
    resume: vi.fn(() => resumed),
    createGain: createNode,
    createChannelSplitter: createNode,
    createChannelMerger: createNode,
    createBiquadFilter: createNode,
    createConvolver: createNode,
    createDynamicsCompressor: createNode,
    createWaveShaper: createNode,
    createAnalyser: createNode,
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
  });
  return {
    context,
    finishResume: () => {
      context.state = 'running';
      releaseResume();
    },
  };
}

describe('demo channel selection while the native audio graph initializes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    PendingXHR.pending = [];
    vi.stubGlobal('XMLHttpRequest', PendingXHR);
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    delete document.body.dataset.demoBound;
    document.body.innerHTML = `
      <button class="active" data-demo-step="1" aria-pressed="true"></button>
      <button data-demo-step="2" aria-pressed="false"></button>
      <button data-demo-step="3" aria-pressed="false"></button>
      <button data-demo-next></button>
      <button data-demo-role="-1" aria-pressed="false"></button>
      <button data-demo-role="1" aria-pressed="false"></button>
    `;
  });

  afterEach(async () => {
    const { clearAllManagedTimers } = await import('../../core/timers.ts');
    clearAllManagedTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(['before', 'after'] as const)(
    'preserves failed-entry restoration when native resume completes %s the XHR failure',
    async (resumeOrder) => {
      const native = nativeContextFixture();
      vi.stubGlobal(
        'AudioContext',
        class {
          constructor() {
            return native.context;
          }
        },
      );
      const { bus } = await import('../../core/events.ts');
      const { getState, setState } = await import('../../core/state.ts');
      const { initDemoMode } = await import('../mode.ts');
      const { setChannelMode } = await import('../../audio/channel.ts');
      const engine = await import('../../audio/engine.ts');
      const ready = vi.fn();
      bus.on('audio:ready', ready);
      initDemoMode();
      setState('network.appRole', 'host');
      setState('setup.sessionStarted', true);
      setChannelMode(-1);

      bus.emit('demo:enter');
      await vi.advanceTimersByTimeAsync(1);
      expect(getState('demo.loading')).toBe(true);
      document.querySelector<HTMLButtonElement>('[data-demo-next]')!.click();
      document.querySelector<HTMLButtonElement>('[data-demo-role="1"]')!.click();
      expect(getState('audio.channelMode')).toBe(1);
      expect(native.context.resume).toHaveBeenCalledOnce();
      expect(engine.getMasterGain()).toBeNull();

      const routing = () =>
        [engine.getGainL(), engine.getGainR()].map((node) => [
          ...(node as unknown as { inputs: Set<number> }).inputs,
        ]);
      if (resumeOrder === 'before') {
        native.finishResume();
        await engine.initAudio();
        await vi.advanceTimersByTimeAsync(1);
        expect(ready).toHaveBeenCalledOnce();
        expect(getState('audio.channelMode')).toBe(1);
        expect(routing()).toEqual([[], [0, 1]]);
      }

      PendingXHR.pending[0]!.onerror?.();
      await vi.advanceTimersByTimeAsync(1);
      expect(getState('demo.active')).toBe(false);
      expect(getState('audio.channelMode')).toBe(-1);

      if (resumeOrder === 'after') {
        native.finishResume();
        await engine.initAudio();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(ready).toHaveBeenCalledOnce();
      expect(engine.getMasterGain()).not.toBeNull();
      expect.soft(getState('audio.channelMode')).toBe(-1);
      expect.soft(routing()).toEqual([[0, 1], []]);
    },
  );
});

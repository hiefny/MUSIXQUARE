/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setCurrentAudioBuffer } from '../../player/_state.ts';
import { setPlaybackIdle } from '../../player/ownership.ts';

const mocks = vi.hoisted(() => ({
  play: vi.fn(async (_offset: number, _scheduleDelay = 0) => true),
  pause: vi.fn(),
  stopAllMedia: vi.fn(),
  getTrackPosition: vi.fn(() => 12),
  getHostNow: vi.fn(() => 10_000),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  loadDemoFile: vi.fn(),
  prepareMediaSession: vi.fn(() => Promise.resolve()),
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
  getMasterGain: vi.fn(() => null as GainNode | null),
  getGainL: vi.fn(() => null as GainNode | null),
  getGainR: vi.fn(() => null as GainNode | null),
  getToneMerge: vi.fn(() => null as ChannelMergerNode | null),
}));

vi.mock('../../player/transport.ts', () => ({
  fmtTime: vi.fn((seconds: number) => `fmt:${Math.floor(seconds)}`),
  getTrackPosition: mocks.getTrackPosition,
  isFilePipelineBusyForPlay: vi.fn(() => false),
  pause: mocks.pause,
  play: mocks.play,
  seekTo: vi.fn(),
  stopAllMedia: mocks.stopAllMedia,
}));

vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: mocks.getHostNow,
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  safeSend: mocks.safeSend,
}));

vi.mock('../../player/decode.ts', () => ({
  loadDemoFile: mocks.loadDemoFile,
}));

vi.mock('../../player/media-session-loader.ts', () => ({
  prepareMediaSession: mocks.prepareMediaSession,
}));

vi.mock('../../audio/effects.ts', () => ({
  applySettingsAsync: vi.fn(),
}));

vi.mock('../../audio/engine.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../audio/engine.ts')>()),
  getMasterGain: mocks.getMasterGain,
  getGainL: mocks.getGainL,
  getGainR: mocks.getGainR,
  getToneMerge: mocks.getToneMerge,
}));

vi.mock('../../ui/dialog.ts', () => ({
  showDialog: vi.fn(),
}));

vi.mock('../../ui/setup-shared.ts', () => ({
  hideSetupOverlay: vi.fn(),
}));

vi.mock('../../ui/toast.ts', () => ({
  showLoader: mocks.showLoader,
  showToast: mocks.showToast,
  updateLoader: mocks.updateLoader,
}));

vi.mock('../../ui/dom.ts', () => ({
  updateOverlayOpenClass: vi.fn(),
}));

vi.mock('../../ui/theme-chrome.ts', () => ({
  syncAppThemeChrome: vi.fn(),
  syncDemoThemeChrome: vi.fn(),
}));

/** Manually resolvable XHR stand-in for fetchDemoBlob. */
class FakeXHR {
  static pending: FakeXHR[] = [];
  status = 200;
  response: Blob = new Blob(['demo-bytes']);
  responseType = '';
  timeout = 0;
  onprogress: ((e: unknown) => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    FakeXHR.pending.push(this);
  }
  abort(): void {
    this.onabort?.();
  }
  resolveOk(): void {
    this.onload?.();
  }
  failNetwork(): void {
    this.onerror?.();
  }
}

async function flush(ms = 1): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('demo physical channel recovery', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    FakeXHR.pending = [];
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    // jsdom has no matchMedia; without this initDemoMode falls back to a
    // window resize listener and the demo layout-refresh resize dispatches
    // re-enter setDemoDomActive recursively.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    delete document.body.dataset.demoBound;
    document.body.innerHTML = `
      <button class="active" data-demo-step="1" aria-pressed="true"></button>
      <button data-demo-step="2" aria-pressed="false"></button>
      <button data-demo-step="3" aria-pressed="false"></button>
      <button data-demo-next></button>
      <button data-demo-role="-1" aria-pressed="false"></button>
      <button data-demo-role="1" aria-pressed="false"></button>
    `;
    // Simulate the real loadDemoFile side effects the snapshot must defend
    // against: buffer publish + transfer.meta overwrite (decode.ts).
    mocks.loadDemoFile.mockImplementation(async (_file: File, meta: { name?: string }) => {
      setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      setState('transfer.meta', { name: meta?.name || 'demo.m4a', indexHint: 0 });
    });
    // Real stopAllMedia releases playback to idle — the restore policy
    // depends on it.
    mocks.stopAllMedia.mockImplementation(() => {
      setState('player.pausedAt', 0);
      setPlaybackIdle();
    });

    const { initDemoMode } = await import('../mode.ts');
    initDemoMode();
  });

  afterEach(() => {
    setCurrentAudioBuffer(null);
    clearAllManagedTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('restores the physical role after failed entry and commits it after a normal exit', async () => {
    // Load the actual channel bus consumer after this fixture's bus.clear().
    const { setChannelMode } = await import('../../audio/channel.ts');
    const contextModule = await import('../../audio/context.ts');
    const context = vi.spyOn(contextModule, 'getAudioContext').mockReturnValue({
      currentTime: 0,
    } as AudioContext);
    const createGain = () => {
      const inputs = new Set<number>();
      return {
        inputs,
        gain: {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn((_destination: AudioNode, _output: number, input: number) => {
          inputs.add(input);
        }),
        disconnect: vi.fn(() => inputs.clear()),
      };
    };
    const left = createGain();
    const right = createGain();
    mocks.getMasterGain.mockReturnValue({} as GainNode);
    mocks.getGainL.mockReturnValue(left as unknown as GainNode);
    mocks.getGainR.mockReturnValue(right as unknown as GainNode);
    mocks.getToneMerge.mockReturnValue({} as ChannelMergerNode);
    try {
      setState('network.appRole', 'host');
      setState('setup.sessionStarted', true);
      setChannelMode(-1);
      expect([...left.inputs]).toEqual([0, 1]);
      expect([...right.inputs]).toEqual([]);

      bus.emit('demo:enter');
      await flush();
      expect(getState('demo.loading')).toBe(true);
      document.querySelector<HTMLButtonElement>('[data-demo-next]')!.click();
      document.querySelector<HTMLButtonElement>('[data-demo-role="1"]')!.click();
      expect([...left.inputs]).toEqual([]);
      expect([...right.inputs]).toEqual([0, 1]);
      FakeXHR.pending[0]!.failNetwork();
      await flush(50);

      expect(getState('demo.active')).toBe(false);
      expect(getState('audio.channelMode')).toBe(-1);
      expect([...left.inputs]).toEqual([0, 1]);
      expect([...right.inputs]).toEqual([]);

      bus.emit('demo:enter');
      await flush();
      FakeXHR.pending[1]!.resolveOk();
      await flush(50);
      document.querySelector<HTMLButtonElement>('[data-demo-role="1"]')!.click();
      bus.emit('demo:request-exit');
      await flush(50);
      expect(getState('demo.active')).toBe(false);
      expect(getState('audio.channelMode')).toBe(1);
      expect([...left.inputs]).toEqual([]);
      expect([...right.inputs]).toEqual([0, 1]);
    } finally {
      context.mockRestore();
      mocks.getMasterGain.mockReturnValue(null);
      mocks.getGainL.mockReturnValue(null);
      mocks.getGainR.mockReturnValue(null);
      mocks.getToneMerge.mockReturnValue(null);
    }
  });
});

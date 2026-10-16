/**
 * @vitest-environment jsdom
 *
 * History Back on the demo ends it for whoever its exit button would end it
 * for, and never traps a guest who cannot end it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { setCurrentAudioBuffer } from '../../player/_state.ts';
import { setPlaybackFilePlaying, setPlaybackIdle } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  play: vi.fn(async () => true),
  stopAllMedia: vi.fn(),
  safeSend: vi.fn(() => true),
  loadDemoFile: vi.fn(),
  showToast: vi.fn(),
  backHandlers: [] as Array<{ element: HTMLElement; handler: () => boolean }>,
}));

vi.mock('../../player/transport.ts', () => ({
  fmtTime: vi.fn((seconds: number) => `fmt:${Math.floor(seconds)}`),
  getTrackPosition: vi.fn(() => 0),
  getLocalFilePendingStartDeadlineMs: vi.fn(() => undefined),
  isLocalFileStartPending: vi.fn(() => false),
  isFilePipelineBusyForPlay: vi.fn(() => false),
  pause: vi.fn(),
  play: mocks.play,
  seekTo: vi.fn(),
  stopAllMedia: mocks.stopAllMedia,
}));

vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: vi.fn(() => 10_000),
  isClockCalibrated: vi.fn(() => true),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: mocks.safeSend,
}));

vi.mock('../../player/decode.ts', () => ({
  loadDemoFile: mocks.loadDemoFile,
}));

vi.mock('../../player/media-session-loader.ts', () => ({
  prepareMediaSession: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../audio/effects.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audio/effects.ts')>();
  return {
    getAppliedRoomEffectsAuthority: actual.getAppliedRoomEffectsAuthority,
    applySettingsAsync: vi.fn(),
    syncRoomEffectsUI: vi.fn(actual.syncRoomEffectsUI),
  };
});

vi.mock('../../ui/dialog.ts', () => ({
  showDialog: vi.fn(),
}));

vi.mock('../../ui/setup-shared.ts', () => ({
  hideSetupOverlay: vi.fn(),
}));

vi.mock('../../ui/toast.ts', () => ({
  showLoader: vi.fn(),
  showToast: mocks.showToast,
  updateLoader: vi.fn(),
}));

vi.mock('../../ui/dom.ts', () => ({
  updateOverlayOpenClass: vi.fn(),
  onWindowBack: vi.fn((element: HTMLElement, handler: () => boolean) => {
    mocks.backHandlers.push({ element, handler });
  }),
}));

vi.mock('../../ui/theme-chrome.ts', () => ({
  syncAppThemeChrome: vi.fn(),
  syncDemoThemeChrome: vi.fn(),
}));

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
}

async function flush(ms = 1): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function demoBack(): boolean {
  const overlay = document.getElementById('demo-overlay');
  const entry = mocks.backHandlers.find((candidate) => candidate.element === overlay);
  if (!entry) throw new Error('The demo did not register a Back handler');
  return entry.handler();
}

function joinAsGuest(capabilities: string[]): DataConnection {
  const hostConn = { open: true, peer: 'host-1' } as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.hostConn', hostConn);
  setState('setup.sessionStarted', true);
  setState('network.isOperator', true);
  setState('network.standardRoomCapabilities', capabilities as never);
  // A guest follows the host's demo; its own state shows the demo running.
  setState('demo.active', true);
  return hostConn;
}

describe('history Back on the demo', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    mocks.backHandlers.length = 0;
    FakeXHR.pending = [];
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    delete document.body.dataset.demoBound;
    document.body.innerHTML = '<div id="demo-overlay" class="demo-overlay"></div>';
    mocks.loadDemoFile.mockImplementation(async () => {
      setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    });
    mocks.play.mockImplementation(async () => {
      setPlaybackFilePlaying();
      return true;
    });
    mocks.stopAllMedia.mockImplementation(() => {
      setState('player.pausedAt', 0);
      setPlaybackIdle();
    });

    const { initDemoMode } = await import('../mode.ts');
    initDemoMode();
  });

  afterEach(() => {
    bus.emit('demo:authority-reset');
    setCurrentAudioBuffer(null);
    clearAllManagedTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('ends the demo for the host, as its exit button does', async () => {
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);
    bus.emit('demo:enter');
    await flush();
    FakeXHR.pending[0]?.onload?.();
    await flush(50);
    expect(getState('demo.active')).toBe(true);

    expect(demoBack()).toBe(true);
    await flush(50);

    expect(getState('demo.active')).toBe(false);
  });

  it('asks the host to end it for a guest with room control', () => {
    const hostConn = joinAsGuest(['room.configure']);

    expect(demoBack()).toBe(true);

    expect(mocks.safeSend).toHaveBeenCalledWith(hostConn, { type: MSG.REQUEST_DEMO_EXIT });
  });

  it('passes Back to the leave confirmation for a guest who cannot end it', () => {
    joinAsGuest(['media.add', 'playback.control']);

    expect(demoBack()).toBe(false);

    expect(mocks.safeSend).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('holds Back only while the exit curtain is still running', () => {
    const overlay = document.getElementById('demo-overlay')!;
    overlay.classList.add('active', 'exiting');
    expect(demoBack()).toBe(true);

    overlay.classList.remove('exiting');
    expect(demoBack()).toBe(false);
  });
});

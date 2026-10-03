/**
 * @vitest-environment jsdom
 * Actual demo, protocol and effects authority; only CDN/decode/audio output are controlled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { syncRoomEffectsUI } from '../../audio/effects.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import { setCurrentAudioBuffer } from '../../player/_state.ts';

import { setPlaybackFilePlaying, setPlaybackIdle } from '../../player/ownership.ts';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  play: vi.fn(
    async (
      _offset: number,
      _scheduleDelay = 0,
      _deadline?: number,
      _shouldApply?: () => boolean,
      _recovery?: { timing?: string; onRecoveredStarted?: () => void | Promise<void> },
    ) => true,
  ),
  pause: vi.fn(),
  stopAllMedia: vi.fn(),
  getTrackPosition: vi.fn(() => 12),
  getLocalFilePendingStartDeadlineMs: vi.fn<() => number | undefined>(() => undefined),
  isLocalFileStartPending: vi.fn(() => false),
  getHostNow: vi.fn(() => 10_000),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  loadDemoFile: vi.fn(),
  prepareMediaSession: vi.fn(() => Promise.resolve()),
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
}));

vi.mock('../../player/transport.ts', () => ({
  fmtTime: vi.fn((seconds: number) => `fmt:${Math.floor(seconds)}`),
  getTrackPosition: mocks.getTrackPosition,
  getLocalFilePendingStartDeadlineMs: mocks.getLocalFilePendingStartDeadlineMs,
  isLocalFileStartPending: mocks.isLocalFileStartPending,
  isFilePipelineBusyForPlay: vi.fn(() => false),
  pause: mocks.pause,
  play: mocks.play,
  seekTo: vi.fn(),
  stopAllMedia: mocks.stopAllMedia,
}));

vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: mocks.getHostNow,
  isClockCalibrated: vi.fn(() => true),
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

/** Keep both CDN attempts pending until the test chooses the authority ordering. */
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
  url = '';
  open(_method: string, url: string): void {
    this.url = url;
  }
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

describe('demo failure preserves effects authority', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    mocks.pause.mockReset();
    mocks.getTrackPosition.mockReturnValue(12);
    mocks.getLocalFilePendingStartDeadlineMs.mockReturnValue(undefined);
    mocks.isLocalFileStartPending.mockReturnValue(false);
    mocks.play.mockImplementation(async () => {
      setPlaybackFilePlaying();
      return true;
    });
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
    bus.emit('demo:authority-reset');
    setCurrentAudioBuffer(null);
    clearAllManagedTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function setupSyncedGuest() {
    const effects =
      await vi.importActual<typeof import('../../audio/effects.ts')>('../../audio/effects.ts');
    effects.resetSettingsSyncAuthorityForTests();
    effects.initEffectsHandlers();
    const conn = { open: true, peer: 'current-host', send: vi.fn() } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.sessionCode', '123456');
    setState('network.lastJoinCode', '123456');
    setState('network.myId', 'guest');
    setState('network.hostConn', conn);
    setState('setup.sessionStarted', true);
    markQueueAuthorityReady(conn);
    effects.setSettingsSyncEnabled(true);
    const settings = effects.captureRoomSettingsSyncState();
    const snapshot = (sequence: number, mixPercent: number) => ({
      type: MSG.SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      epoch: 0,
      sequence,
      settings: {
        ...settings,
        effects: {
          ...settings.effects,
          reverb: { ...settings.effects.reverb, mixPercent },
        },
      },
    });
    await handleData(snapshot(1, 10), conn);
    expect(getState('audio.reverbMix')).toBe(0.1);
    await handleData(
      {
        type: MSG.DEMO_ENTER,
        index: 0,
        reverbOn: false,
        bassBoostOn: false,
        trebleBoostOn: false,
        surroundOn: false,
      },
      conn,
    );
    await flush();
    expect(getState('demo.loading')).toBe(true);
    return { effects, conn, snapshot };
  }

  it('a successful demo load and normal exit retain newer canonical settings', async () => {
    const { conn, snapshot } = await setupSyncedGuest();
    await handleData(snapshot(2, 60), conn);
    FakeXHR.pending[0]!.resolveOk();
    await flush(50);
    expect(getState('demo.loading')).toBe(false);
    expect(getState('audio.reverbMix')).toBe(0.6);
    await handleData({ type: MSG.DEMO_EXIT }, conn);
    await flush(500);
    expect(getState('audio.reverbMix')).toBe(0.6);
  });

  it('guest CDN failure must retain a host snapshot accepted during demo loading', async () => {
    const { conn, snapshot } = await setupSyncedGuest();
    await handleData(snapshot(2, 60), conn);
    expect(getState('audio.reverbMix')).toBe(0.6);
    FakeXHR.pending[0]!.failNetwork();
    await flush();
    expect(FakeXHR.pending).toHaveLength(2);
    FakeXHR.pending[1]!.failNetwork();
    await flush(500);
    expect(getState('demo.active')).toBe(false);
    expect(getState('network.hostConn')).toBe(conn);
    expect(getState('audio.settingsSyncEnabled')).toBe(true);
    expect(getState('audio.reverbMix')).toBe(0.6);
  });

  function installExitCurtain() {
    document.body.innerHTML =
      '<div id="demo-overlay" class="active"></div><div id="demo-curtain" style="opacity: 0"></div>';
    const animation = { cancel: vi.fn(), onfinish: null, oncancel: null } as unknown as Animation;
    Object.defineProperty(document.getElementById('demo-curtain')!, 'animate', {
      configurable: true,
      value: vi.fn(() => animation),
    });
    return animation;
  }

  async function exhaustGuestFetch() {
    FakeXHR.pending[0]!.failNetwork();
    await flush();
    FakeXHR.pending[1]!.failNetwork();
    await flush();
    expect(getState('demo.active')).toBe(false);
  }

  it('newer canonical settings during the failure exit curtain must survive the old restore', async () => {
    const { conn, snapshot } = await setupSyncedGuest();
    const animation = installExitCurtain();
    await exhaustGuestFetch();
    expect(animation.onfinish).toBeTypeOf('function');
    await handleData(snapshot(2, 60), conn);
    expect(getState('audio.reverbMix')).toBe(0.6);
    animation.onfinish?.call(animation, new Event('finish') as AnimationPlaybackEvent);
    await flush(500);
    expect(getState('network.hostConn')).toBe(conn);
    expect(getState('audio.reverbMix')).toBe(0.6);
  });

  it('revoking the guest operator must not let pending demo restore overwrite its canonical resync', async () => {
    const { conn, snapshot } = await setupSyncedGuest();
    const { initGuestProtocolHandlers } = await import('../../network/guest.ts');
    initGuestProtocolHandlers();
    await handleData(
      { type: MSG.OPERATOR_GRANT, silent: true, capabilities: ['effects.control'] },
      conn,
    );
    expect(getState('network.isOperator')).toBe(true);
    const animation = installExitCurtain();
    await exhaustGuestFetch();
    await handleData({ type: MSG.OPERATOR_REVOKE, silent: true }, conn);
    expect(getState('network.isOperator')).toBe(false);
    await handleData(snapshot(2, 60), conn);
    expect(getState('audio.reverbMix')).toBe(0.6);
    animation.onfinish?.call(animation, new Event('finish') as AnimationPlaybackEvent);
    await flush(500);
    expect(getState('audio.reverbMix')).toBe(0.6);
  });

  it('a canonical snapshot after the restore applies normally', async () => {
    const { conn, snapshot } = await setupSyncedGuest();
    await exhaustGuestFetch();
    await flush(1_000);
    expect(getState('audio.reverbMix')).toBe(0.1);
    await handleData(snapshot(2, 60), conn);
    expect(getState('audio.reverbMix')).toBe(0.6);
  });

  it('settings sync OFF ignores host snapshots and restores the local settings', async () => {
    const { conn, snapshot, effects } = await setupSyncedGuest();
    effects.setSettingsSyncEnabled(false);
    const animation = installExitCurtain();
    await exhaustGuestFetch();
    await handleData(snapshot(2, 60), conn);
    expect(getState('audio.reverbMix')).toBe(0.1);
    animation.onfinish?.call(animation, new Event('finish') as AnimationPlaybackEvent);
    await flush(500);
    expect(getState('audio.reverbMix')).toBe(0.1);
  });

  it('disconnected guest settings do not overwrite a successor connection', async () => {
    const { snapshot } = await setupSyncedGuest();
    const animation = installExitCurtain();
    setState('network.hostConn', null);
    expect(getState('demo.active')).toBe(false);
    const nextConn = { open: true, peer: 'new-host', send: vi.fn() } as unknown as DataConnection;
    setState('network.hostConn', nextConn);
    markQueueAuthorityReady(nextConn);
    await handleData(snapshot(2, 60), nextConn);
    expect(getState('audio.reverbMix')).toBe(0.6);
    animation.onfinish?.call(animation, new Event('finish') as AnimationPlaybackEvent);
    await flush(500);
    expect(getState('network.hostConn')).toBe(nextConn);
    expect(getState('audio.reverbMix')).toBe(0.6);
    expect(mocks.loadDemoFile).not.toHaveBeenCalled();
  });

  it('restores every newer room effect, including zero/false, while rolling back device-local output', async () => {
    setState('audio.channelMode', -1);
    setState('audio.userPreampGain', 0.7);
    setState('audio.subFreq', 90);
    setState('audio.virtualBass', 0.7);
    setState('audio.exciter', true);
    const { conn, snapshot, effects } = await setupSyncedGuest();
    const latest = snapshot(2, 0);
    latest.settings.masterVolume = 0.4;
    latest.settings.effects.reverb = {
      mixPercent: 0,
      decaySeconds: 2.3,
      preDelaySeconds: 0.08,
      lowCutPercent: 15,
      highCutPercent: 20,
    };
    latest.settings.effects.equalizer.bandsDb = [-3, 2, 0, 4, -1];
    latest.settings.effects.virtualSurround.widthPercent = 120;
    latest.settings.effects.virtualBass.strengthPercent = 0;
    latest.settings.effects.virtualTreble.enabled = false;
    await handleData(latest, conn);
    expect(effects.captureRoomEffectsState()).toEqual(latest.settings.effects);
    // An unpublished demo preview after the authority update must not become
    // the failed-entry rollback target, nor should local output fields survive.
    setState('audio.reverbMix', 0.9);
    setState('audio.channelMode', 1);
    setState('audio.userPreampGain', 0.3);
    setState('audio.subFreq', 150);
    await exhaustGuestFetch();
    await flush(500);
    expect(effects.captureRoomEffectsState()).toEqual(latest.settings.effects);
    expect(getState('audio.channelMode')).toBe(-1);
    expect(getState('audio.userPreampGain')).toBe(0.7);
    expect(getState('audio.subFreq')).toBe(90);
    expect(getState('audio.masterVolume')).toBe(0.4);
    expect(syncRoomEffectsUI).toHaveBeenCalled();
  });

  it('restores the entry settings when no newer canonical state was applied', async () => {
    const { effects } = await setupSyncedGuest();
    const initial = effects.captureRoomEffectsState();
    setState('audio.reverbMix', 0.9);
    setState('audio.eqValues', [2, 3, 4, 5, 6]);
    await exhaustGuestFetch();
    await flush(500);
    expect(effects.captureRoomEffectsState()).toEqual(initial);
  });

  it('rejects stale and conflicting snapshots without replacing the applied authority', async () => {
    const { effects, conn, snapshot } = await setupSyncedGuest();
    const authority = effects.getAppliedRoomEffectsAuthority();
    await handleData(snapshot(0, 70), conn);
    await handleData(snapshot(1, 80), conn);
    expect(effects.getAppliedRoomEffectsAuthority()).toBe(authority);
    setState('audio.reverbMix', 0.9);
    await exhaustGuestFetch();
    await flush(500);
    expect(getState('audio.reverbMix')).toBe(0.1);
  });

  it('preserves an already-published coordinator edit when its own demo load fails', async () => {
    const effects =
      await vi.importActual<typeof import('../../audio/effects.ts')>('../../audio/effects.ts');
    effects.resetSettingsSyncAuthorityForTests();
    effects.initEffectsHandlers();
    setState('network.appRole', 'host');
    setState('network.sessionCode', '123456');
    setState('network.myId', 'host');
    setState('setup.sessionStarted', true);
    effects.setSettingsSyncEnabled(true);
    effects.setReverbParam('mix', 10);
    expect(effects.publishLocalSettingsAuthorityForTests()).toBe(true);
    bus.emit('demo:enter');
    await flush();
    expect(getState('demo.loading')).toBe(true);
    effects.setReverbParam('mix', 60);
    expect(effects.publishLocalSettingsAuthorityForTests()).toBe(true);
    expect(mocks.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.SETTINGS_SYNC_SNAPSHOT,
        settings: expect.objectContaining({
          effects: expect.objectContaining({ reverb: expect.objectContaining({ mixPercent: 60 }) }),
        }),
      }),
    );
    FakeXHR.pending[0]!.failNetwork();
    await flush(500);
    expect(getState('demo.active')).toBe(false);
    expect(getState('audio.reverbMix')).toBe(0.6);
  });

  it('clears applied authority when the session ends', async () => {
    const { effects } = await setupSyncedGuest();
    expect(effects.getAppliedRoomEffectsAuthority()).not.toBeNull();
    bus.emit('demo:authority-reset');
    setState('setup.sessionStarted', false);
    expect(effects.getAppliedRoomEffectsAuthority()).toBeNull();
  });
});

/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { handleData } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import {
  isLocalFilePaused,
  setLocalFilePaused,
  setCurrentAudioBuffer,
} from '../../player/_state.ts';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  play: vi.fn(
    async (_offset: number, _scheduleDelay = 0, _deadline?: number, _shouldApply?: () => boolean) =>
      true,
  ),
  pause: vi.fn(),
  stopAllMedia: vi.fn(),
  getTrackPosition: vi.fn(() => 12),
  getHostNow: vi.fn(() => 10_000),
  isClockCalibrated: vi.fn(() => true),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  prepareMediaSession: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../player/transport.ts', () => ({
  fmtTime: (seconds: number) => String(seconds),
  getTrackPosition: mocks.getTrackPosition,
  pause: mocks.pause,
  play: mocks.play,
  stopAllMedia: mocks.stopAllMedia,
}));

vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: mocks.getHostNow,
  isClockCalibrated: mocks.isClockCalibrated,
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: mocks.broadcast,
  safeSend: mocks.safeSend,
}));

vi.mock('../../player/decode.ts', () => ({
  loadDemoFile: vi.fn(),
}));

vi.mock('../../player/media-session-loader.ts', () => ({
  prepareMediaSession: mocks.prepareMediaSession,
}));

vi.mock('../../audio/effects.ts', () => ({
  applySettingsAsync: vi.fn(),
}));

vi.mock('../../ui/dialog.ts', () => ({
  showDialog: vi.fn(),
}));

vi.mock('../../ui/setup-shared.ts', () => ({
  hideSetupOverlay: vi.fn(),
}));

vi.mock('../../ui/toast.ts', () => ({
  showLoader: vi.fn(),
  showToast: vi.fn(),
  updateLoader: vi.fn(),
}));

vi.mock('../../ui/dom.ts', () => ({
  updateOverlayOpenClass: vi.fn(),
}));

vi.mock('../../ui/theme-chrome.ts', () => ({
  syncAppThemeChrome: vi.fn(),
  syncDemoThemeChrome: vi.fn(),
}));

describe('demo playback sync bootstrap', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetState();
    bus.clear();
    clearAllManagedTimers();
    vi.clearAllMocks();
    setLocalFilePaused(false);
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    mocks.getHostNow.mockReturnValue(10_000);
    mocks.isClockCalibrated.mockReturnValue(true);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    const { initDemoMode } = await import('../mode.ts');
    initDemoMode();
  });

  afterEach(() => {
    setCurrentAudioBuffer(null);
    clearAllManagedTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('compensates late demo play delivery by the full host scheduling window', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    const immediateSync = vi.fn();
    bus.on('sync:request-immediate-ping', immediateSync);

    setState('network.hostConn', hostConn);
    setState('network.appRole', 'guest');
    markQueueAuthorityReady(hostConn);
    setState('demo.active', true);

    await handleData(
      {
        type: MSG.DEMO_PLAY,
        index: 0,
        time: 42,
        hostPlayAt: 9_000,
      },
      hostConn,
    );

    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(mocks.play.mock.calls[0][0]).toBeCloseTo(43.35, 3);
    expect(mocks.play.mock.calls[0][1]).toBe(0);
    expect(immediateSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);

    expect(immediateSync).toHaveBeenCalledOnce();
  });

  it('compensates early demo play delivery without dropping one-way latency', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    mocks.getHostNow.mockReturnValue(8_800);

    setState('network.hostConn', hostConn);
    setState('network.appRole', 'guest');
    markQueueAuthorityReady(hostConn);
    setState('demo.active', true);

    await handleData(
      {
        type: MSG.DEMO_PLAY,
        index: 0,
        time: 42,
        hostPlayAt: 9_000,
      },
      hostConn,
    );

    // The host command happened at 8,650ms. The guest starts at the 9,000ms
    // rendezvous, so it must begin at 42.350s rather than 42.200s.
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(mocks.play.mock.calls[0][0]).toBeCloseTo(42.35, 3);
    expect(mocks.play.mock.calls[0][1]).toBeCloseTo(0.2, 3);
  });

  it('ignores hostPlayAt while the shared clock is uncalibrated', async () => {
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    mocks.getHostNow.mockReturnValue(100_000);
    mocks.isClockCalibrated.mockReturnValue(false);

    setState('network.hostConn', hostConn);
    setState('network.appRole', 'guest');
    markQueueAuthorityReady(hostConn);
    setState('demo.active', true);

    await handleData(
      {
        type: MSG.DEMO_PLAY,
        index: 0,
        time: 42,
        hostPlayAt: 9_000,
      },
      hostConn,
    );

    expect(mocks.play).toHaveBeenCalledWith(42, 0, expect.any(Number), expect.any(Function));
    expect(mocks.getHostNow).not.toHaveBeenCalled();
  });

  it.each([
    { position: 42, expected: 47.35, ended: false },
    { position: 118, expected: 120, ended: true },
  ])(
    'projects a demo command received after a long load (position $position)',
    async ({ position, expected, ended }) => {
      const hostConn = { open: true, peer: 'host-1' } as DataConnection;
      setState('network.hostConn', hostConn);
      setState('network.appRole', 'guest');
      markQueueAuthorityReady(hostConn);
      setState('demo.active', true);
      await handleData(
        { type: MSG.DEMO_PLAY, index: 0, time: position, hostPlayAt: 5_000 },
        hostConn,
      );
      if (ended) {
        expect(mocks.play).not.toHaveBeenCalled();
        expect(mocks.pause).toHaveBeenCalledWith(expected, expect.anything());
      } else expect(mocks.play.mock.calls[0][0]).toBeCloseTo(expected);
    },
  );

  it.each([MSG.DEMO_PLAY, MSG.DEMO_PAUSE])(
    'releases native local-pause suppression for authoritative %s',
    async (type) => {
      const hostConn = { open: true, peer: 'host-1' } as DataConnection;
      setState('network.hostConn', hostConn);
      setState('network.appRole', 'guest');
      markQueueAuthorityReady(hostConn);
      setState('demo.active', true);
      setLocalFilePaused(true);
      await handleData({ type, index: 0, time: 20, hostPlayAt: 0 }, hostConn);
      expect(isLocalFilePaused()).toBe(false);
    },
  );

  it.each(['pause', 'play', 'connection', 'buffer', 'exit', 'local-pause'] as const)(
    'retires a waiting demo play after a newer %s owner',
    async (replacement) => {
      const hostConn = { open: true, peer: 'host-1' } as DataConnection;
      setState('network.hostConn', hostConn);
      setState('network.appRole', 'guest');
      markQueueAuthorityReady(hostConn);
      setState('demo.active', true);
      await handleData({ type: MSG.DEMO_PLAY, index: 0, time: 10, hostPlayAt: 10_100 }, hostConn);
      const isCurrent = mocks.play.mock.calls[0][3]!;
      expect(isCurrent()).toBe(true);
      if (replacement === 'pause') await handleData({ type: MSG.DEMO_PAUSE, time: 11 }, hostConn);
      if (replacement === 'play')
        await handleData({ type: MSG.DEMO_PLAY, index: 0, time: 30, hostPlayAt: 10_100 }, hostConn);
      if (replacement === 'connection')
        setState('network.hostConn', { open: true, peer: 'host-1' } as DataConnection);
      if (replacement === 'buffer') setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      if (replacement === 'exit') await handleData({ type: MSG.DEMO_EXIT }, hostConn);
      if (replacement === 'local-pause') setLocalFilePaused(true);
      expect(isCurrent()).toBe(false);
    },
  );

  it('uses a monotonic transport deadline even when wall time has a large epoch', async () => {
    vi.setSystemTime(new Date('2026-09-19T00:00:00Z'));
    const hostConn = { open: true, peer: 'host-1' } as DataConnection;
    setState('network.hostConn', hostConn);
    setState('network.appRole', 'guest');
    markQueueAuthorityReady(hostConn);
    setState('demo.active', true);
    const monotonicNow = performance.now();
    await handleData({ type: MSG.DEMO_PLAY, index: 0, time: 10, hostPlayAt: 10_100 }, hostConn);
    expect(mocks.play.mock.calls[0][2]).toBeCloseTo(monotonicNow + 100, 3);
  });
});

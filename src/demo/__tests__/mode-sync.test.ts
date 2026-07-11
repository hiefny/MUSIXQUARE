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
import { setCurrentAudioBuffer } from '../../player/_state.ts';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  play: vi.fn(),
  pause: vi.fn(),
  stopAllMedia: vi.fn(),
  getTrackPosition: vi.fn(() => 12),
  getHostNow: vi.fn(() => 10_000),
  isClockCalibrated: vi.fn(() => true),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
}));

vi.mock('../../player/transport.ts', () => ({
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
    mocks.getHostNow.mockReturnValue(10_000);
    mocks.isClockCalibrated.mockReturnValue(true);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    const { initDemoMode } = await import('../mode.ts');
    initDemoMode();
  });

  afterEach(() => {
    setCurrentAudioBuffer(null);
    clearAllManagedTimers();
    vi.useRealTimers();
  });

  it('requests an immediate host sync after applying a pending guest demo play', async () => {
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

    expect(mocks.play).toHaveBeenCalledWith(43);
    expect(immediateSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);

    expect(immediateSync).toHaveBeenCalledOnce();
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

    expect(mocks.play).toHaveBeenCalledWith(42);
    expect(mocks.getHostNow).not.toHaveBeenCalled();
  });
});

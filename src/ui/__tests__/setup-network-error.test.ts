/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/capability.ts', () => ({
  cancelCapabilityChallenge: vi.fn(),
}));

vi.mock('../../core/platform.ts', () => ({
  onCompactLandscapeChange: vi.fn(),
}));

vi.mock('../../core/timers.ts', () => ({
  clearManagedTimer: vi.fn(),
  setManagedTimer: vi.fn(),
}));

vi.mock('../../core/page-lifecycle.ts', () => ({
  markIntentionalNav: vi.fn(),
}));

vi.mock('../../core/session-reset.ts', () => ({
  scheduleSessionReset: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  cancelPendingSessionSetup: vi.fn(),
}));

vi.mock('../../network/standard-room-prerequisites.ts', () => ({
  scheduleStandardRoomPrerequisiteWarmup: vi.fn(),
}));

vi.mock('../../player/ownership.ts', () => ({
  isPlaybackModeYouTube: vi.fn(() => false),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

vi.mock('../dialog.ts', () => ({
  showDialog: vi.fn(() => Promise.resolve({ action: 'cancel' })),
}));

vi.mock('../player-controls.ts', () => ({
  updateRoleBadge: vi.fn(),
}));

vi.mock('../settings.ts', () => ({
  openLanguageDialog: vi.fn(),
}));

vi.mock('../setup-host.ts', () => ({
  startHostFlow: vi.fn(),
  setHostGoBack: vi.fn(),
}));

vi.mock('../setup-guest.ts', () => ({
  startGuestFlow: vi.fn(),
  setGuestGoBack: vi.fn(),
  handleSetupJoinWithRole: vi.fn(),
  promptForRoomPassword: vi.fn(() => Promise.resolve()),
  clearPendingRoomPasswordJoin: vi.fn(),
  restoreGuestJoinControlsAfterFailure: vi.fn(),
}));

vi.mock('../dom.ts', () => ({
  animateTransition: vi.fn((apply: () => void) => apply()),
}));

vi.mock('../setup-shared.ts', () => ({
  BACK_SVG: '',
  syncDesktopLeftPanel: vi.fn(),
  setupEl: vi.fn(() => null),
  showSetupOverlay: vi.fn(),
  hideSetupOverlay: vi.fn(),
  setupShowCodeArea: vi.fn(),
  setupShowJoinArea: vi.fn(),
  setupShowAutoJoinArea: vi.fn(),
  setupShowRoleArea: vi.fn(),
  setupShowWelcome: vi.fn(),
  setupSetGuestJoinBusy: vi.fn(),
  setupSetGuestJoinError: vi.fn(),
  setupRenderActions: vi.fn(),
  initObCarousel: vi.fn(),
  notifyObCarouselGreetingReady: vi.fn(),
  updateObSlider: vi.fn(),
  nextObSlide: vi.fn(),
  prevObSlide: vi.fn(),
  handleSetupRolePreview: vi.fn(),
  setCurrentObSlide: vi.fn(),
  setPendingGuestRoleMode: vi.fn(),
  incrementHostCodeFlowId: vi.fn(),
  getSetupOverlayEverShown: vi.fn(() => true),
  getSetupOverlayAbort: vi.fn(() => null),
  setSetupOverlayAbort: vi.fn(),
  getPendingGuestRoleMode: vi.fn(() => null),
  getPendingAutoJoinCode: vi.fn(() => null),
  setPendingAutoJoinCode: vi.fn(),
}));

import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { cancelPendingSessionSetup } from '../../network/peer.ts';
import { isPlaybackModeYouTube } from '../../player/ownership.ts';
import { registerProRoomSignalingEpochAdvanceHandler } from '../../pro-room/lifecycle-hook.ts';
import { markProRoomTransportRecovered } from '../../pro-room/transport-recovery.ts';
import { initSetup } from '../setup.ts';
import { showDialog } from '../dialog.ts';
import { setHostGoBack } from '../setup-host.ts';
import { restoreGuestJoinControlsAfterFailure } from '../setup-guest.ts';
import { showToast } from '../toast.ts';

function startJoining(): void {
  setState('network.appRole', 'guest');
  setState('network.isConnecting', true);
  vi.mocked(showToast).mockClear();
  vi.mocked(restoreGuestJoinControlsAfterFailure).mockClear();
}

beforeEach(() => {
  bus.clear();
  resetState();
  markProRoomTransportRecovered();
  sessionStorage.clear();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  initSetup();
  vi.mocked(showToast).mockClear();
  vi.mocked(showDialog).mockClear();
  vi.mocked(isPlaybackModeYouTube).mockClear();
  vi.mocked(isPlaybackModeYouTube).mockReturnValue(false);
  startJoining();
});

afterEach(() => {
  registerProRoomSignalingEpochAdvanceHandler(null);
});

describe('setup network error messages', () => {
  it('keeps active PRO media intact and suppresses the ordinary host-loss dialog', () => {
    const recover = vi.fn();
    const youtubeStop = vi.fn();
    registerProRoomSignalingEpochAdvanceHandler(recover);
    bus.on('youtube:stop-mode', youtubeStop);
    vi.mocked(isPlaybackModeYouTube).mockReturnValue(true);
    setState('network.isConnecting', false);
    setState('setup.sessionStarted', true);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'participant_owner',
      epoch: 4,
      snapshotRevision: 8,
      capabilities: [],
    });

    bus.emit('network:error', new Error('HOST_DISCONNECTED'));

    expect(recover).toHaveBeenCalledOnce();
    expect(showToast).not.toHaveBeenCalled();
    expect(getState('network.signalingHealth')).toMatchObject({
      status: 'reconnecting',
      attempt: 1,
      maxAttempts: 5,
    });
    expect(showDialog).not.toHaveBeenCalled();
    expect(youtubeStop).not.toHaveBeenCalled();
  });

  it('retains the ordinary-room host-loss dialog and YouTube cleanup', () => {
    const youtubeStop = vi.fn();
    bus.on('youtube:stop-mode', youtubeStop);
    vi.mocked(isPlaybackModeYouTube).mockReturnValue(true);
    setState('network.isConnecting', false);

    bus.emit('network:error', new Error('HOST_DISCONNECTED'));

    expect(showDialog).toHaveBeenCalledOnce();
    expect(youtubeStop).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'Worker reason',
      Object.assign(new Error('ROOM_GUEST_LIMIT_REACHED'), { type: 'server-error' }),
    ],
    ['transport type', Object.assign(new Error('SIGNALING_ERROR'), { type: 'room-full' })],
  ])(
    'maps a signaling room limit reported by %s to the existing session-full copy',
    (_label, error) => {
      bus.emit('network:error', error);

      expect(showToast).not.toHaveBeenCalled();
      expect(restoreGuestJoinControlsAfterFailure).toHaveBeenCalledWith('network.session_full');
      expect(getState('network.isConnecting')).toBe(false);
    },
  );

  it('keeps an existing specific join error after the guest UI is restored', () => {
    bus.emit('network:error', new Error('HOST_UNREACHABLE'));

    expect(showToast).not.toHaveBeenCalled();
    expect(restoreGuestJoinControlsAfterFailure).toHaveBeenCalledWith('error.host_unreachable');
    expect(showToast).not.toHaveBeenCalledWith('network.cant_join');
    expect(getState('network.isConnecting')).toBe(false);
  });

  it('clears the reconnect marker after a successful guest join', () => {
    sessionStorage.setItem('mxqr_reconnect_target', '123456');
    setState('network.lastJoinCode', '123456');

    bus.emit('setup:guest-join-success');

    expect(sessionStorage.getItem('mxqr_reconnect_target')).toBeNull();
    expect(getState('setup.sessionStarted')).toBe(true);
  });

  it('refuses to downgrade an active session through a setup back callback', () => {
    const goBack = vi.mocked(setHostGoBack).mock.calls.at(-1)?.[0];
    expect(goBack).toBeTypeOf('function');
    vi.mocked(cancelPendingSessionSetup).mockClear();
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', true);

    goBack?.();

    expect(cancelPendingSessionSetup).not.toHaveBeenCalled();
    expect(getState('network.appRole')).toBe('host');
    expect(getState('setup.sessionStarted')).toBe(true);
  });
});

/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/capability.ts', () => ({
  cancelCapabilityChallenge: vi.fn(),
}));

vi.mock('../../core/platform.ts', () => ({
  onCompactLandscapeChange: vi.fn(),
}));

vi.mock('../../core/timers.ts', () => ({
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
  setupRenderActions: vi.fn(),
  startObAutoSlide: vi.fn(),
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
import { initSetup } from '../setup.ts';
import { showToast } from '../toast.ts';

function startJoining(): void {
  setState('network.appRole', 'guest');
  setState('network.isConnecting', true);
  vi.mocked(showToast).mockClear();
}

beforeEach(() => {
  bus.clear();
  resetState();
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
  startJoining();
});

describe('setup network error messages', () => {
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

      expect(showToast).toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledWith('network.session_full');
      expect(getState('network.isConnecting')).toBe(false);
    },
  );

  it('keeps an existing specific join error after the guest UI is restored', () => {
    bus.emit('network:error', new Error('HOST_UNREACHABLE'));

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('error.host_unreachable');
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
});

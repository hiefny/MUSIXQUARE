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
  scheduleDocumentReload: vi.fn(),
  scheduleSessionReset: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  cancelPendingSessionSetup: vi.fn(),
}));

vi.mock('../../network/standard-room-prerequisites.ts', () => ({
  scheduleStandardRoomPrerequisiteWarmup: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
  synchronizeCurrentLocalizedAppHead: vi.fn(),
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
import { createLazyFeatureLoadError } from '../../core/lazy-feature-failure.ts';
import { synchronizeCurrentLocalizedAppHead } from '../../i18n/index.ts';
import { registerProRoomSignalingEpochAdvanceHandler } from '../../pro-room/lifecycle-hook.ts';
import { markProRoomTransportRecovered } from '../../pro-room/transport-recovery.ts';
import { initSetup } from '../setup.ts';
import { showDialog } from '../dialog.ts';
import { setHostGoBack } from '../setup-host.ts';
import { restoreGuestJoinControlsAfterFailure } from '../setup-guest.ts';
import { showToast } from '../toast.ts';
import { scheduleDocumentReload, scheduleSessionReset } from '../../core/session-reset.ts';

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
  document.documentElement.lang = 'en';
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
  vi.mocked(synchronizeCurrentLocalizedAppHead).mockClear();
  startJoining();
});

afterEach(() => {
  registerProRoomSignalingEpochAdvanceHandler(null);
});

describe('setup network error messages', () => {
  it('keeps active PRO media intact and suppresses the ordinary host-loss dialog', () => {
    const recover = vi.fn();
    const youtubeStop = vi.fn();
    const mediaStop = vi.fn();
    const systemAudioStop = vi.fn();
    registerProRoomSignalingEpochAdvanceHandler(recover);
    bus.on('youtube:stop-mode', youtubeStop);
    bus.on('player:stop-all-media', mediaStop);
    bus.on('system-audio:force-stop', systemAudioStop);
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
    expect(mediaStop).not.toHaveBeenCalled();
    expect(systemAudioStop).not.toHaveBeenCalled();
  });

  it.each(['HOST_DISCONNECTED', 'HOST_CONNECTION_ERROR'])(
    'silences all media before the terminal %s dialog opens',
    (message) => {
      const order: string[] = [];
      const mediaStop = vi.fn(() => {
        order.push('media');
      });
      bus.on('system-audio:force-stop', () => {
        order.push('system-audio');
      });
      bus.on('player:stop-all-media', mediaStop);
      vi.mocked(showDialog).mockImplementationOnce(() => {
        order.push('dialog');
        return new Promise(() => {});
      });
      setState('network.isConnecting', false);

      bus.emit('network:error', new Error(message));

      expect(showDialog).toHaveBeenCalledOnce();
      expect(mediaStop).toHaveBeenCalledExactlyOnceWith({
        cancelInFlight: true,
        clearBuffer: true,
      });
      expect(order).toEqual(['system-audio', 'media', 'dialog']);
    },
  );

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

  it('routes a wrapped terminal feature failure to Refresh instead of Retry', () => {
    const terminal = createLazyFeatureLoadError('room-session', new TypeError('chunk unavailable'));
    // guest.ts clears this flag before surfacing its wrapped init error.
    setState('network.isConnecting', false);
    bus.emit('network:error', new Error('NETWORK_INIT_FAILED', { cause: terminal }));

    expect(restoreGuestJoinControlsAfterFailure).toHaveBeenCalledWith('dialog.sw_update_msg', true);
    expect(showToast).not.toHaveBeenCalled();
    expect(getState('network.isConnecting')).toBe(false);
  });

  it('clears the reconnect marker after a successful guest join', () => {
    sessionStorage.setItem('mxqr_reconnect_target', '123456');
    setState('network.lastJoinCode', '123456');

    bus.emit('setup:guest-join-success');

    expect(sessionStorage.getItem('mxqr_reconnect_target')).toBeNull();
    expect(getState('setup.sessionStarted')).toBe(true);
  });

  it('returns a joined room to root while preserving its displayed language and hash', () => {
    window.history.replaceState({}, '', '/123456?invite=share#queue');
    document.documentElement.lang = 'ko';
    setState('network.lastJoinCode', '123456');

    bus.emit('setup:guest-join-success');

    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#queue');
    expect(document.documentElement.lang).toBe('ko');
    expect(synchronizeCurrentLocalizedAppHead).toHaveBeenCalledOnce();
  });

  it('preserves an explicit locale URL after a standard room join', () => {
    window.history.replaceState({}, '', '/ko/?panel=connect#queue');
    setState('network.lastJoinCode', '123456');

    bus.emit('setup:guest-join-success');

    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/ko/?panel=connect#queue',
    );
    expect(synchronizeCurrentLocalizedAppHead).not.toHaveBeenCalled();
  });

  it('preserves a PRO room URL after joining', () => {
    window.history.replaceState({}, '', '/000001?panel=connect#queue');
    setState('network.lastJoinCode', '000001');

    bus.emit('setup:guest-join-success');

    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/000001?panel=connect#queue',
    );
    expect(synchronizeCurrentLocalizedAppHead).not.toHaveBeenCalled();
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

describe('Standard-room PIN removal and wrong-PIN limit', () => {
  function dialogOptions() {
    const options = vi.mocked(showDialog).mock.calls.at(-1)?.[0];
    if (!options || typeof options === 'string') throw new Error('expected dialog options');
    return options;
  }
  const text = (value: unknown) =>
    typeof value === 'function' ? (value as () => string)() : value;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    vi.mocked(scheduleSessionReset).mockClear();
    vi.mocked(scheduleDocumentReload).mockClear();
    setState('network.isConnecting', false);
    setState('setup.sessionStarted', true);
    setState('network.lastJoinCode', '123456');
  });

  it.each([
    ['room-pin-enabled', 'pro.pin_enabled_removed_title', 'connect.pin_enabled_removed_message'],
    ['room-pin-changed', 'pro.pin_changed_removed_title', 'connect.pin_changed_removed_message'],
  ] as const)(
    'explains a %s removal with the host wording, then reopens the same room',
    async (reason, title, message) => {
      bus.emit('network:kicked-explicitly', reason);
      // The departing session clears the code; the route was captured already.
      setState('network.lastJoinCode', '');

      expect(showDialog).toHaveBeenCalledOnce();
      const options = dialogOptions();
      expect(text(options.title)).toBe(title);
      expect(text(options.message)).toBe(message);
      expect(options.dismissible).toBe(false);
      await flush();
      expect(scheduleSessionReset).toHaveBeenCalledOnce();
      expect(scheduleDocumentReload).not.toHaveBeenCalled();
      const navigate = vi.mocked(scheduleSessionReset).mock.calls[0]?.[1];
      const location = { href: '' };
      vi.stubGlobal('location', location);
      try {
        navigate?.();
      } finally {
        vi.unstubAllGlobals();
      }
      expect(location.href).toBe('/123456');
    },
  );

  it('reloads instead of navigating when the remembered room code is not a room code', async () => {
    setState('network.lastJoinCode', '../evil');
    bus.emit('network:kicked-explicitly', 'room-pin-changed');
    await flush();
    expect(scheduleSessionReset).not.toHaveBeenCalled();
    expect(scheduleDocumentReload).toHaveBeenCalledOnce();
  });

  it('keeps the generic kick copy for a kick without a known reason', async () => {
    bus.emit('network:kicked-explicitly');
    const options = dialogOptions();
    expect(options.title).toBe('connect.kicked_title');
    expect(options.message).toBe('connect.kicked_message');
    await flush();
    expect(scheduleDocumentReload).toHaveBeenCalledOnce();
    expect(scheduleSessionReset).not.toHaveBeenCalled();
  });

  it('shows one notice when the kick frame and the closed signaling socket both report it', async () => {
    let close: (value: { action: string }) => void = () => undefined;
    vi.mocked(showDialog).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          close = resolve;
        }),
    );
    bus.emit('network:kicked-explicitly', 'room-pin-changed');
    bus.emit(
      'network:error',
      Object.assign(new Error('ROOM_PASSWORD_CHANGED'), { type: 'room-password-changed' }),
    );
    expect(showDialog).toHaveBeenCalledOnce();
    close({ action: 'ok' });
    await flush();
    expect(scheduleSessionReset).toHaveBeenCalledOnce();
  });

  it('explains a room-password-changed close that arrives without the kick frame', async () => {
    setState('network.isConnecting', true);
    bus.emit(
      'network:error',
      Object.assign(new Error('ROOM_PASSWORD_CHANGED'), { type: 'room-password-changed' }),
    );
    expect(getState('network.isConnecting')).toBe(false);
    expect(text(dialogOptions().title)).toBe('pro.pin_changed_removed_title');
    expect(text(dialogOptions().message)).toBe('connect.pin_changed_removed_message');
    expect(restoreGuestJoinControlsAfterFailure).not.toHaveBeenCalled();
    await flush();
    expect(scheduleSessionReset).toHaveBeenCalledOnce();
  });

  it('uses the first-enable notice when the Worker closes the socket for a new PIN', async () => {
    setState('network.isConnecting', true);
    bus.emit(
      'network:error',
      Object.assign(new Error('ROOM_PASSWORD_ENABLED'), { type: 'room-password-changed' }),
    );
    expect(getState('network.isConnecting')).toBe(false);
    expect(text(dialogOptions().title)).toBe('pro.pin_enabled_removed_title');
    expect(text(dialogOptions().message)).toBe('connect.pin_enabled_removed_message');
    await flush();
    expect(scheduleSessionReset).toHaveBeenCalledOnce();
  });

  it.each([
    [600, 'dialog.room_password_rate_limited'],
    [61, 'dialog.room_password_rate_limited'],
    [0, 'dialog.room_password_rate_limited_later'],
    [undefined, 'dialog.room_password_rate_limited_later'],
  ] as const)(
    'tells a guest locked out for %s seconds when to try again',
    (retryAfterSeconds, message) => {
      startJoining();
      bus.emit(
        'network:error',
        Object.assign(new Error('ROOM_PASSWORD_RATE_LIMITED'), {
          type: 'room-password-rate-limited',
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        }),
      );
      expect(getState('network.isConnecting')).toBe(false);
      expect(restoreGuestJoinControlsAfterFailure).toHaveBeenCalledWith(message);
      expect(showDialog).not.toHaveBeenCalled();
    },
  );

  it('rounds the lockout up to whole minutes', async () => {
    const { t } = await import('../../i18n/index.ts');
    vi.mocked(t).mockClear();
    startJoining();
    bus.emit(
      'network:error',
      Object.assign(new Error('ROOM_PASSWORD_RATE_LIMITED'), {
        type: 'room-password-rate-limited',
        retryAfterSeconds: 61,
      }),
    );
    expect(t).toHaveBeenCalledWith('dialog.room_password_rate_limited', { count: 2 });
    // The Standard wrong-PIN lockout has its own copy; the PRO join throttle
    // wording ("too many join attempts") is not reused.
    expect(t).not.toHaveBeenCalledWith('pro.join_rate_limited', expect.anything());
    expect(t).not.toHaveBeenCalledWith('pro.join_rate_limited_later');
  });
});

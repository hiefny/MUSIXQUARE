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
  claimUnloadExemption: vi.fn(() => () => undefined),
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
  setupRenderActionsInTransition: vi.fn(
    (_buttons: unknown, _layout?: unknown, onRendered?: () => void) => onRendered?.(),
  ),
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

import { requestForcedAppUpdateFor, setForcedAppUpdateHandler } from '../../core/app-build.ts';
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
import { setupRenderActions, setupRenderActionsInTransition } from '../setup-shared.ts';
import { restoreGuestJoinControlsAfterFailure, startGuestFlow } from '../setup-guest.ts';
import { showToast } from '../toast.ts';
import { scheduleDocumentReload, scheduleSessionReset } from '../../core/session-reset.ts';
import { log } from '../../core/log.ts';
import { CloudflareDataConnection } from '../../network/transport/cloudflare-signaling.ts';

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

  it('swaps back to the welcome actions inside the area transition', () => {
    const goBack = vi.mocked(setHostGoBack).mock.calls.at(-1)?.[0];
    vi.mocked(setupRenderActions).mockClear();
    vi.mocked(setupRenderActionsInTransition).mockClear();
    setState('network.appRole', 'host');
    setState('setup.sessionStarted', false);

    goBack?.();

    expect(setupRenderActions).not.toHaveBeenCalled();
    expect(setupRenderActionsInTransition).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: 'btn-setup-host' }),
        expect.objectContaining({ id: 'btn-setup-guest' }),
      ],
      'vertical',
    );
  });
});

describe('terminal host loss: Reconnect or Go back', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    vi.mocked(scheduleSessionReset).mockClear();
    vi.mocked(scheduleDocumentReload).mockClear();
    vi.mocked(startGuestFlow).mockClear();
    setState('network.isConnecting', false);
    setState('setup.sessionStarted', true);
  });

  it('returns to the room Start screen on Reconnect and marks the next join as a reconnect', async () => {
    setState('network.lastJoinCode', '123456');
    vi.mocked(showDialog).mockResolvedValueOnce({ action: 'ok' });

    bus.emit('network:error', new Error('HOST_DISCONNECTED'));
    await flush();

    expect(sessionStorage.getItem('mxqr_reconnect_target')).toBe('123456');
    expect(scheduleSessionReset).toHaveBeenCalledExactlyOnceWith(
      'dialog.refreshing_session',
      expect.any(Function),
    );
    // setup passes a plain action (returnToRoomStart).
    const navigate = vi.mocked(scheduleSessionReset).mock.calls[0]?.[1] as unknown as
      (() => void) | undefined;
    const location = { href: '' };
    vi.stubGlobal('location', location);
    try {
      navigate?.();
    } finally {
      vi.unstubAllGlobals();
    }
    // A pushed entry, as every /CODE return keeps.
    expect(location.href).toBe('/123456');
    expect(startGuestFlow).not.toHaveBeenCalled();
    expect(scheduleDocumentReload).not.toHaveBeenCalled();
  });

  it('starts the guest flow instead when the remembered code is not a room code', async () => {
    setState('network.lastJoinCode', '../evil');
    vi.mocked(showDialog).mockResolvedValueOnce({ action: 'ok' });

    bus.emit('network:error', new Error('HOST_DISCONNECTED'));
    await flush();

    expect(startGuestFlow).toHaveBeenCalledOnce();
    expect(scheduleSessionReset).not.toHaveBeenCalled();
    expect(scheduleDocumentReload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('mxqr_reconnect_target')).toBeNull();
  });

  it('reloads with the leaving message on Go back', async () => {
    setState('network.lastJoinCode', '123456');
    vi.mocked(showDialog).mockResolvedValueOnce({ action: 'secondary' });

    bus.emit('network:error', new Error('HOST_DISCONNECTED'));
    await flush();

    expect(scheduleDocumentReload).toHaveBeenCalledExactlyOnceWith('dialog.leaving_session');
    expect(scheduleSessionReset).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('mxqr_reconnect_target')).toBeNull();
  });
});

describe("the guest's last close cause outlives the disconnect-dialog reload (P4-D5 B)", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const KEPT_CLOSE_KEY = 'mxqr-prev-close';
  // 2026-10-25 03:04:05.678 UTC. The line shows whole seconds, as the 4A
  // close line's capture time does.
  const CLOSED_AT = Date.UTC(2026, 9, 25, 3, 4, 5, 678);
  const PREVIOUS_CLOSE_LINE = '[Transport] Previous page closed (peer-left) at 03:04:05 UTC';

  /** Closes a real Standard logical connection; its first cause is the named reason. */
  function closeHostLink(reason: 'peer-left' | 'transport-error', closedAt = CLOSED_AT): void {
    const now = vi.spyOn(Date, 'now').mockReturnValue(closedAt);
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    try {
      new CloudflareDataConnection('host-link').close(reason);
    } finally {
      info.mockRestore();
      now.mockRestore();
    }
  }

  /** Boots setup again as the next page in this tab and reads back its previous-close lines. */
  function bootNextPage(): string[] {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    try {
      bus.clear();
      initSetup();
      return info.mock.calls
        .map(([line]) => line)
        .filter(
          (line): line is string =>
            typeof line === 'string' && line.startsWith('[Transport] Previous page closed'),
        );
    } finally {
      info.mockRestore();
    }
  }

  function refuseStorage(method: 'getItem' | 'setItem') {
    return vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
  }

  beforeEach(() => {
    vi.mocked(scheduleSessionReset).mockClear();
    vi.mocked(scheduleDocumentReload).mockClear();
    vi.mocked(startGuestFlow).mockClear();
    setState('network.isConnecting', false);
    setState('setup.sessionStarted', true);
    setState('network.lastJoinCode', '123456');
  });

  it('keeps the last cause when Go back reloads, and the next page logs it once', async () => {
    closeHostLink('transport-error', CLOSED_AT - 60_000);
    closeHostLink('peer-left');
    vi.mocked(showDialog).mockResolvedValueOnce({ action: 'secondary' });

    bus.emit('network:error', new Error('HOST_DISCONNECTED'));
    await flush();

    expect(scheduleDocumentReload).toHaveBeenCalledExactlyOnceWith('dialog.leaving_session');
    // The cause token and the close time only: no peer id and no room code.
    expect(sessionStorage.getItem(KEPT_CLOSE_KEY)).toBe(`peer-left ${CLOSED_AT}`);
    expect(bootNextPage()).toEqual([PREVIOUS_CLOSE_LINE]);
    expect(sessionStorage.getItem(KEPT_CLOSE_KEY)).toBeNull();
    expect(bootNextPage()).toEqual([]);
  });

  it('keeps the cause when the dialog is dismissed, which also reloads', async () => {
    closeHostLink('peer-left');

    bus.emit('network:error', new Error('HOST_CONNECTION_ERROR'));
    await flush();

    expect(scheduleDocumentReload).toHaveBeenCalledExactlyOnceWith('dialog.leaving_session');
    expect(bootNextPage()).toEqual([PREVIOUS_CLOSE_LINE]);
  });

  it('keeps the cause when Reconnect returns to the room Start screen', async () => {
    closeHostLink('peer-left');
    vi.mocked(showDialog).mockResolvedValueOnce({ action: 'ok' });

    bus.emit('network:error', new Error('HOST_DISCONNECTED'));
    await flush();

    expect(scheduleSessionReset).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('mxqr_reconnect_target')).toBe('123456');
    expect(sessionStorage.getItem(KEPT_CLOSE_KEY)).toBe(`peer-left ${CLOSED_AT}`);
    expect(bootNextPage()).toEqual([PREVIOUS_CLOSE_LINE]);
  });

  it('keeps nothing when Reconnect stays on this page', async () => {
    closeHostLink('peer-left');
    setState('network.lastJoinCode', '../evil');
    vi.mocked(showDialog).mockResolvedValueOnce({ action: 'ok' });

    bus.emit('network:error', new Error('HOST_DISCONNECTED'));
    await flush();

    expect(startGuestFlow).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(KEPT_CLOSE_KEY)).toBeNull();
  });

  it('keeps the cause when the host removes the guest and the page reloads by itself', () => {
    closeHostLink('peer-left');

    bus.emit('network:kicked-from-session');

    expect(scheduleDocumentReload).toHaveBeenCalledExactlyOnceWith('dialog.leaving_session');
    expect(sessionStorage.getItem(KEPT_CLOSE_KEY)).toBe(`peer-left ${CLOSED_AT}`);
  });

  it('still reloads when sessionStorage refuses the write (iOS Safari private mode)', async () => {
    closeHostLink('peer-left');
    const setItem = refuseStorage('setItem');
    try {
      vi.mocked(showDialog).mockResolvedValueOnce({ action: 'secondary' });
      bus.emit('network:error', new Error('HOST_DISCONNECTED'));
      await flush();
      bus.emit('network:kicked-from-session');
    } finally {
      setItem.mockRestore();
    }

    expect(vi.mocked(scheduleDocumentReload).mock.calls).toEqual([
      ['dialog.leaving_session'],
      ['dialog.leaving_session'],
    ]);
    expect(sessionStorage.getItem(KEPT_CLOSE_KEY)).toBeNull();
  });

  it('boots the next page normally when sessionStorage refuses the read', () => {
    sessionStorage.setItem(KEPT_CLOSE_KEY, `peer-left ${CLOSED_AT}`);
    const getItem = refuseStorage('getItem');
    try {
      expect(bootNextPage()).toEqual([]);
    } finally {
      getItem.mockRestore();
    }
  });

  it('drops a malformed kept value without logging it', () => {
    sessionStorage.setItem(KEPT_CLOSE_KEY, '<img src=x onerror=alert(1)> 1');

    expect(bootNextPage()).toEqual([]);
    expect(sessionStorage.getItem(KEPT_CLOSE_KEY)).toBeNull();
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
      // setup passes a plain action (returnToRoomStart).
      const navigate = vi.mocked(scheduleSessionReset).mock.calls[0]?.[1] as unknown as
        (() => void) | undefined;
      const location = { href: '' };
      vi.stubGlobal('location', location);
      try {
        navigate?.();
      } finally {
        vi.unstubAllGlobals();
      }
      expect(location.href).toBe('/123456');
      // A PIN removal is not a reconnect: the next join keeps its own error copy.
      expect(sessionStorage.getItem('mxqr_reconnect_target')).toBeNull();
    },
  );

  it('reloads instead of navigating when the remembered room code is not a room code', async () => {
    setState('network.lastJoinCode', '../evil');
    bus.emit('network:kicked-explicitly', 'room-pin-changed');
    await flush();
    expect(scheduleSessionReset).not.toHaveBeenCalled();
    expect(scheduleDocumentReload).toHaveBeenCalledExactlyOnceWith('dialog.leaving_session');
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

describe('forced update: refusals below the App build floor (train 9.0.14)', () => {
  let pending: boolean;
  let answer: boolean;

  beforeEach(() => {
    pending = false;
    answer = true;
    setForcedAppUpdateHandler({
      request: () => {
        if (answer) pending = true;
        return answer;
      },
      isPending: () => pending,
    });
  });

  afterEach(() => {
    setForcedAppUpdateHandler({ request: () => false, isPending: () => false });
  });

  /** The transport's error for the Worker's refusal frame. */
  function refusal(): Error {
    return Object.assign(new Error('APP_UPDATE_REQUIRED'), {
      type: 'app-update-required',
      minAppBuild: 786,
    });
  }

  /** The transport asks the port before it reports the refusal. */
  function refuse(returnCode: string | null): Error {
    const error = refusal();
    requestForcedAppUpdateFor(error, { minAppBuild: 786, admitted: false, returnCode });
    return error;
  }

  it('resets a refused join with no join-field text and no toast while the forced dialog is up', () => {
    const cancelled = vi.fn();
    bus.on('setup:guest-join-cancelled', cancelled);

    bus.emit('network:error', refuse('123456'));

    expect(restoreGuestJoinControlsAfterFailure).toHaveBeenCalledExactlyOnceWith(null);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(showToast).not.toHaveBeenCalled();
    expect(showDialog).not.toHaveBeenCalled();
    expect(getState('network.isConnecting')).toBe(false);
  });

  it('hides the join-field text by the pending query alone', () => {
    pending = true;

    bus.emit('network:error', refusal());

    expect(restoreGuestJoinControlsAfterFailure).toHaveBeenCalledExactlyOnceWith(null);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('shows no join-field text or toast for a refusal during a logo reset (nothing pending yet)', () => {
    // Step 4b: a navigation holds the page, so the port answers true and
    // presents nothing; only the mark on the refusal's error tells setup.
    setForcedAppUpdateHandler({ request: () => true, isPending: () => false });

    bus.emit('network:error', refuse('123456'));

    expect(restoreGuestJoinControlsAfterFailure).toHaveBeenCalledExactlyOnceWith(null);
    expect(showToast).not.toHaveBeenCalled();
    expect(getState('network.isConnecting')).toBe(false);
  });

  it('keeps the ordinary join-field text when the port declined (the loop guard)', () => {
    answer = false;

    bus.emit('network:error', refuse('123456'));

    expect(restoreGuestJoinControlsAfterFailure).toHaveBeenCalledExactlyOnceWith(
      'error.network_generic',
    );
    expect(getState('network.isConnecting')).toBe(false);
  });

  it('shows no toast for a host refused at its reconnect in a room, and the ordinary one when declined', () => {
    setState('network.appRole', 'host');
    setState('network.isConnecting', false);
    setState('setup.sessionStarted', true);

    bus.emit('network:error', refuse(null));
    expect(showToast).not.toHaveBeenCalled();
    expect(showDialog).not.toHaveBeenCalled();

    pending = false;
    answer = false;
    bus.emit('network:error', refuse(null));
    expect(showToast).toHaveBeenCalledExactlyOnceWith('error.network_generic');
  });
});

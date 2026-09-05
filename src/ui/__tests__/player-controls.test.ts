/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bus } from '../../core/events.ts';
import { PLAYBACK_STATE } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { getResolvedLanguage, setLanguageMode, t } from '../../i18n/index.ts';
import { setCurrentAudioBuffer } from '../../player/_state.ts';
import {
  claimPlaybackOwner,
  createSystemAudioTrackMeta,
  setPlaybackIdle,
  setPlaybackSystemAudioPlaying,
  setSystemAudioReceiving,
} from '../../player/ownership.ts';
import { STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES } from '../../network/standard-room-authority.ts';
import type { DataConnection } from '../../types/index.ts';
import { broadcastYouTubeSync, guestRendezvousSync } from '../../youtube/sync.ts';
import { showToast } from '../toast.ts';
import { __resetAccountStateForTests, applyAccountSession } from '../../account/state.ts';
import { initSettings } from '../settings.ts';
import {
  getRoleLabelByChannelMode,
  getStandardRolePreset,
  getInviteCode,
  initPlayerControls,
  updateRoleBadge,
} from '../player-controls.ts';

const PLAY_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const PAUSE_QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000002';

const zeroStartFacade = vi.hoisted(() => ({ active: false, inFlight: false }));
const platform = vi.hoisted(() => ({ android: false }));
const youtubePrimer = vi.hoisted(() => ({
  prime: vi.fn((_options?: { retryPending?: boolean }) => false),
  wait: vi.fn(async () => true),
}));

const proPlaybackRuntime = vi.hoisted(() => ({
  reconcile: vi.fn<() => Promise<boolean>>(),
}));

const hardResetNavigation = vi.hoisted(() => ({
  activatePendingServiceWorkerForHardReset: vi.fn<() => Promise<undefined>>(),
  navigateToAppHome: vi.fn(),
  scheduleSessionReset: vi.fn(),
}));

const proSystemAudio = vi.hoisted(() => ({
  view: {
    roomCode: '000001',
    initialized: true,
    phase: 'idle' as 'idle' | 'preparing' | 'live',
    generation: 0 as number | null,
    ownerParticipantId: null as string | null,
    isLocalOwner: false,
    localRequestPending: false,
    canStart: true,
    canStop: false,
    claimExpiresAt: null as number | null,
    liveExpiresAt: null as number | null,
    publication: null,
  },
  ownerName: null as string | null,
  coordinatorCompatible: true,
}));

vi.mock('../../youtube/sync.ts', () => ({
  broadcastYouTubeSync: vi.fn(),
  guestRendezvousSync: vi.fn(),
}));

vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
  get IS_ANDROID() {
    return platform.android;
  },
}));

vi.mock('../../youtube/zero-start.ts', () => ({
  isYouTubeZeroStartProtocolActive: vi.fn(() => zeroStartFacade.active),
  isYouTubeZeroStartInFlight: vi.fn(() => zeroStartFacade.inFlight),
}));

vi.mock('../../youtube/iframe.ts', () => ({
  primeYouTubePlayer: youtubePrimer.prime,
  waitForPendingYouTubePrimeBounce: youtubePrimer.wait,
}));

vi.mock('../../pro-room/runtime.ts', () => ({
  requestActiveProRoomPlaybackReconciliation: proPlaybackRuntime.reconcile,
}));

vi.mock('../../core/sw-hard-reset.ts', () => ({
  default: hardResetNavigation.activatePendingServiceWorkerForHardReset,
}));

vi.mock('../../core/navigation.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/navigation.ts')>()),
  navigateToAppHome: hardResetNavigation.navigateToAppHome,
}));

vi.mock('../../core/session-reset.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/session-reset.ts')>()),
  scheduleSessionReset: hardResetNavigation.scheduleSessionReset,
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

vi.mock('../../pro-room/system-audio-bridge.ts', () => ({
  canPublishProSystemAudioWithCurrentCoordinator: vi.fn(() => proSystemAudio.coordinatorCompatible),
  getProSystemAudioOwnerDisplayName: vi.fn(() => proSystemAudio.ownerName),
  getProSystemAudioViewState: vi.fn(() => ({ ...proSystemAudio.view })),
  isLocalProSystemAudioOwner: vi.fn(() => proSystemAudio.view.isLocalOwner),
}));

beforeEach(() => {
  __resetAccountStateForTests();
  resetState();
  bus.clear();
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  vi.clearAllMocks();
  Object.assign(proSystemAudio.view, {
    roomCode: '000001',
    initialized: true,
    phase: 'idle',
    generation: 0,
    ownerParticipantId: null,
    isLocalOwner: false,
    localRequestPending: false,
    canStart: true,
    canStop: false,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  });
  proSystemAudio.ownerName = null;
  proSystemAudio.coordinatorCompatible = true;
  zeroStartFacade.active = false;
  platform.android = false;
  zeroStartFacade.inFlight = false;
  proPlaybackRuntime.reconcile.mockResolvedValue(true);
  hardResetNavigation.activatePendingServiceWorkerForHardReset.mockResolvedValue(undefined);
  document.body.innerHTML = '';
});

afterEach(() => {
  clearAllManagedTimers();
  setCurrentAudioBuffer(null);
  bus.clear();
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
  delete (document as unknown as Record<string, unknown>).exitFullscreen;
});

function makeConnection(peer: string): DataConnection {
  return { peer, open: true } as DataConnection;
}

function setActiveStandardHost(): void {
  setState('network.appRole', 'host');
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
}

describe('Android range scroll ownership', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function openActualEqualizer() {
    const markup = readFileSync('index.html', 'utf8');
    document.body.innerHTML = new DOMParser().parseFromString(markup, 'text/html').body.innerHTML;
    platform.android = true;
    setActiveStandardHost();
    initPlayerControls();
    initSettings();
    document.querySelector<HTMLElement>('#grid-eq [data-eq-type="advanced"]')!.click();
    expect(document.getElementById('eq-sliders-area')!.classList.contains('collapsed')).toBe(false);
    const first = document.getElementById('eq-slider-0') as HTMLInputElement;
    const second = document.getElementById('eq-slider-1') as HTMLInputElement;
    const parent = first.closest<HTMLElement>('.tab-content')!;
    expect(second.closest('.tab-content')).toBe(parent);
    expect(first.disabled || second.disabled).toBe(false);
    parent.style.overflowY = 'auto';
    return { first, second, parent };
  }

  function touch(identifier: number, target: HTMLInputElement): Touch {
    // jsdom has TouchEvent but no Touch constructor. Keep native list/target semantics.
    return {
      identifier,
      target,
      clientX: 10,
      clientY: 10,
      pageX: 10,
      pageY: 10,
      screenX: 10,
      screenY: 10,
      radiusX: 1,
      radiusY: 1,
      rotationAngle: 0,
      force: 1,
    };
  }

  function dispatchTouch(
    target: HTMLInputElement,
    type: 'touchstart' | 'touchend' | 'touchcancel',
    touches: Touch[],
    changedTouches: Touch[],
  ): void {
    target.dispatchEvent(
      new TouchEvent(type, {
        bubbles: true,
        touches,
        targetTouches: touches.filter((point) => point.target === target),
        changedTouches,
      }),
    );
  }

  it('keeps the settings parent locked until both touched equalizer ranges release', () => {
    const { first, second, parent } = openActualEqualizer();
    const a = touch(1, first);
    const b = touch(2, second);
    dispatchTouch(first, 'touchstart', [a], [a]);
    dispatchTouch(second, 'touchstart', [a, b], [b]);
    expect(parent.style.overflowY).toBe('hidden');
    dispatchTouch(first, 'touchend', [b], [a]);
    expect.soft(parent.style.overflowY).toBe('hidden');
    dispatchTouch(second, 'touchend', [], [b]);
    expect(parent.style.overflowY).toBe('auto');
  });

  it('keeps a range locked while a second contact on that range remains', () => {
    const { first, parent } = openActualEqualizer();
    const a = touch(1, first);
    const b = touch(2, first);
    dispatchTouch(first, 'touchstart', [a], [a]);
    dispatchTouch(first, 'touchstart', [a, b], [b]);
    dispatchTouch(first, 'touchend', [b], [a]);
    expect.soft(parent.style.overflowY).toBe('hidden');
    dispatchTouch(first, 'touchend', [], [b]);
    expect(parent.style.overflowY).toBe('auto');
  });

  it('restores the original parent style for a single completed touch', () => {
    const { first, parent } = openActualEqualizer();
    const a = touch(1, first);
    dispatchTouch(first, 'touchstart', [a], [a]);
    expect(parent.style.overflowY).toBe('hidden');
    dispatchTouch(first, 'touchend', [], [a]);
    expect(parent.style.overflowY).toBe('auto');
  });

  it('preserves shared ownership when the newer range cancels first', () => {
    const { first, second, parent } = openActualEqualizer();
    parent.style.overflowY = '';
    const a = touch(1, first);
    const b = touch(2, second);
    dispatchTouch(first, 'touchstart', [a], [a]);
    dispatchTouch(second, 'touchstart', [a, b], [b]);
    dispatchTouch(second, 'touchcancel', [a], [b]);
    expect(parent.style.overflowY).toBe('hidden');
    dispatchTouch(first, 'touchend', [], [a]);
    expect(parent.style.overflowY).toBe('');
  });

  it('keeps a surviving contact on a range locked after another contact cancels', () => {
    const { first, parent } = openActualEqualizer();
    const a = touch(1, first);
    const b = touch(2, first);
    dispatchTouch(first, 'touchstart', [a], [a]);
    dispatchTouch(first, 'touchstart', [a, b], [b]);
    dispatchTouch(first, 'touchcancel', [b], [a]);
    expect(parent.style.overflowY).toBe('hidden');
    dispatchTouch(first, 'touchcancel', [], [b]);
    expect(parent.style.overflowY).toBe('auto');
  });

  it('restores overlapping owners on reinitialization and allows a fresh touch', () => {
    const { first, second, parent } = openActualEqualizer();
    const a = touch(1, first);
    const b = touch(2, second);
    dispatchTouch(first, 'touchstart', [a], [a]);
    dispatchTouch(second, 'touchstart', [a, b], [b]);
    expect(parent.style.overflowY).toBe('hidden');
    initPlayerControls();
    expect(parent.style.overflowY).toBe('auto');
    // Ending the retired gesture cannot undo the restored parent style.
    dispatchTouch(first, 'touchend', [b], [a]);
    dispatchTouch(second, 'touchend', [], [b]);
    expect(parent.style.overflowY).toBe('auto');
    const c = touch(3, first);
    dispatchTouch(first, 'touchstart', [c], [c]);
    expect(parent.style.overflowY).toBe('hidden');
    dispatchTouch(first, 'touchend', [], [c]);
    expect(parent.style.overflowY).toBe('auto');
  });
});

describe('initPlayerControls storage errors', () => {
  it('uses the active non-English unknown label when a filename is missing', async () => {
    setLanguageMode('ja');
    await vi.waitFor(() => {
      expect(getResolvedLanguage()).toBe('ja');
      expect(t('common.unknown')).toBe('不明');
    });

    try {
      initPlayerControls();

      bus.emit('storage:error', 'save failed', '');
      bus.emit('storage:read-error', { error: 'read failed', filename: '' });

      const unknown = t('common.unknown');
      expect(showToast).toHaveBeenNthCalledWith(1, t('toast.file_save_error', { name: unknown }));
      expect(showToast).toHaveBeenNthCalledWith(2, t('toast.file_read_error', { name: unknown }));
    } finally {
      setLanguageMode('en');
      await vi.waitFor(() => expect(getResolvedLanguage()).toBe('en'));
    }
  });
});

describe('logo hard reset update hand-off', () => {
  it.each(['resolve', 'reject'])(
    'ignores activation %s after the reset attempt recovered',
    async (outcome) => {
      vi.useFakeTimers();
      const coordinator = await vi.importActual<typeof import('../../core/session-reset.ts')>(
        '../../core/session-reset.ts',
      );
      let resolveActivation!: (value: undefined) => void;
      let rejectActivation!: (reason: Error) => void;
      hardResetNavigation.activatePendingServiceWorkerForHardReset.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolveActivation = resolve;
          rejectActivation = reject;
        }),
      );
      hardResetNavigation.scheduleSessionReset.mockImplementationOnce(
        coordinator.scheduleSessionReset,
      );
      document.body.innerHTML =
        '<button id="app-logo">MUSIXQUARE</button><div id="setup-overlay"></div>';
      initPlayerControls();
      try {
        document.getElementById('app-logo')?.click();
        await vi.advanceTimersByTimeAsync(120);
        expect(hardResetNavigation.activatePendingServiceWorkerForHardReset).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(2000);
        expect(coordinator.isSessionResetPending()).toBe(false);

        // A successor reset does not reauthorize this recovered attempt.
        coordinator.scheduleSessionReset('Successor', vi.fn());
        if (outcome === 'resolve') resolveActivation(undefined);
        else rejectActivation(new Error('late activation failure'));
        await vi.advanceTimersByTimeAsync(0);
        expect(hardResetNavigation.navigateToAppHome).not.toHaveBeenCalled();
      } finally {
        coordinator.__resetSessionResetForTests();
        vi.useRealTimers();
      }
    },
  );

  it('skips activation when the reset recovers before the lazy import completes', async () => {
    let recover!: () => void;
    hardResetNavigation.scheduleSessionReset.mockReturnValueOnce({
      onRecovered: (listener: () => void) => {
        recover = listener;
      },
    });
    document.body.innerHTML =
      '<button id="app-logo">MUSIXQUARE</button><div id="setup-overlay"></div>';
    initPlayerControls();
    document.getElementById('app-logo')?.click();
    await vi.waitFor(() => expect(hardResetNavigation.scheduleSessionReset).toHaveBeenCalledOnce());
    const resetAction = hardResetNavigation.scheduleSessionReset.mock.calls[0]?.[1] as () => void;
    resetAction();
    recover();
    await vi.dynamicImportSettled();
    expect(hardResetNavigation.activatePendingServiceWorkerForHardReset).not.toHaveBeenCalled();
    expect(hardResetNavigation.navigateToAppHome).not.toHaveBeenCalled();
  });

  it('hands service-worker activation to the reset coordinator before navigating home', async () => {
    document.body.innerHTML = `
      <button id="app-logo" type="button">MUSIXQUARE</button>
      <div id="setup-overlay"></div>
    `;
    initPlayerControls();

    document.getElementById('app-logo')?.click();
    await vi.waitFor(() => expect(hardResetNavigation.scheduleSessionReset).toHaveBeenCalledOnce());
    expect(hardResetNavigation.scheduleSessionReset).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
    );
    // Scheduling paints and blocks first; the coordinator owns when the lazy
    // update hand-off and its one home navigation are actually invoked.
    expect(hardResetNavigation.activatePendingServiceWorkerForHardReset).not.toHaveBeenCalled();
    expect(hardResetNavigation.navigateToAppHome).not.toHaveBeenCalled();

    const resetAction = hardResetNavigation.scheduleSessionReset.mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    resetAction?.();
    await vi.waitFor(() =>
      expect(hardResetNavigation.activatePendingServiceWorkerForHardReset).toHaveBeenCalledOnce(),
    );
    expect(hardResetNavigation.navigateToAppHome).toHaveBeenCalledOnce();
  });

  it('still navigates home when the deferred update hand-off fails', async () => {
    hardResetNavigation.activatePendingServiceWorkerForHardReset.mockRejectedValueOnce(
      new Error('activation unavailable'),
    );
    document.body.innerHTML = `
      <button id="app-logo" type="button">MUSIXQUARE</button>
      <div id="setup-overlay"></div>
    `;
    initPlayerControls();

    document.getElementById('app-logo')?.click();
    await vi.waitFor(() => expect(hardResetNavigation.scheduleSessionReset).toHaveBeenCalledOnce());
    const resetAction = hardResetNavigation.scheduleSessionReset.mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    resetAction?.();

    await vi.waitFor(() => expect(hardResetNavigation.navigateToAppHome).toHaveBeenCalledOnce());
  });
});

describe('initPlayerControls empty-play media guidance', () => {
  it.each([390, 844, 1280, 1440])(
    'scrolls to, focuses, and restarts the three-pulse media hint at %ipx',
    (viewportWidth) => {
      const innerWidth = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(viewportWidth);
      try {
        document.body.innerHTML = '<button id="btn-media-source">Media</button>';
        const button = document.getElementById('btn-media-source') as HTMLButtonElement;
        const scrollIntoView = vi.fn();
        const forcedReflow = vi.fn(() => 56);
        button.scrollIntoView = scrollIntoView;
        Object.defineProperty(button, 'offsetWidth', { configurable: true, get: forcedReflow });
        button.classList.add('attention-hint');

        initPlayerControls();
        const removeClass = vi.spyOn(button.classList, 'remove');
        const addClass = vi.spyOn(button.classList, 'add');
        bus.emit('ui:reveal-media-source');

        expect(scrollIntoView).toHaveBeenCalledWith({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'nearest',
        });
        expect(document.activeElement).toBe(button);
        expect(button.classList.contains('attention-hint')).toBe(true);
        expect(forcedReflow).toHaveBeenCalledTimes(1);
        expect(removeClass).toHaveBeenCalledWith('attention-hint');
        expect(addClass).toHaveBeenCalledWith('attention-hint');

        bus.emit('ui:reveal-media-source');
        expect(scrollIntoView).toHaveBeenCalledTimes(2);
        expect(forcedReflow).toHaveBeenCalledTimes(2);
        expect(button.classList.contains('attention-hint')).toBe(true);

        const animationEnd = new Event('animationend');
        Object.defineProperty(animationEnd, 'animationName', { value: 'attention-hint-fill' });
        button.dispatchEvent(animationEnd);
        expect(button.classList.contains('attention-hint')).toBe(false);
      } finally {
        innerWidth.mockRestore();
      }
    },
  );

  it('uses instant scrolling when reduced motion is requested', () => {
    const innerWidth = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true }) as MediaQueryList),
    });
    try {
      document.body.innerHTML = '<button id="btn-media-source">Media</button>';
      const button = document.getElementById('btn-media-source') as HTMLButtonElement;
      const scrollIntoView = vi.fn();
      button.scrollIntoView = scrollIntoView;

      initPlayerControls();
      bus.emit('ui:reveal-media-source');

      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'auto',
        block: 'nearest',
        inline: 'nearest',
      });
      expect(document.activeElement).toBe(button);
    } finally {
      innerWidth.mockRestore();
      if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });
});

describe('getRoleLabelByChannelMode', () => {
  it('returns Original for mode 0', () => {
    expect(getRoleLabelByChannelMode(0)).toBe('Original');
  });

  it('returns Left for mode -1', () => {
    expect(getRoleLabelByChannelMode(-1)).toBe('Left');
  });

  it('returns Right for mode 1', () => {
    expect(getRoleLabelByChannelMode(1)).toBe('Right');
  });

  it('returns Woofer for mode 2', () => {
    expect(getRoleLabelByChannelMode(2)).toBe('Woofer');
  });

  it('falls back to Original for unknown mode', () => {
    expect(getRoleLabelByChannelMode(99)).toBe('Original');
  });
});

describe('getStandardRolePreset', () => {
  it('returns center preset for mode 0', () => {
    const preset = getStandardRolePreset(0);
    expect(preset.labelKey).toBe('common.original');
    expect(preset.placementToastKey).toBe('role.center_placement');
  });

  it('returns left preset for mode -1', () => {
    const preset = getStandardRolePreset(-1);
    expect(preset.labelKey).toBe('common.left');
    expect(preset.placementToastKey).toBe('role.left_placement');
  });

  it('returns right preset for mode 1', () => {
    const preset = getStandardRolePreset(1);
    expect(preset.labelKey).toBe('common.right');
    expect(preset.placementToastKey).toBe('role.right_placement');
  });

  it('returns a dedicated subwoofer placement preset for mode 2', () => {
    const preset = getStandardRolePreset(2);
    expect(preset.labelKey).toBe('common.woofer');
    expect(preset.placementToastKey).toBe('role.subwoofer_placement');
  });

  it('falls back to Original preset for unknown mode', () => {
    const preset = getStandardRolePreset(99);
    expect(preset.labelKey).toBe('common.original');
    expect(preset.placementToastKey).toBe('role.center_placement');
  });
});

describe('getInviteCode', () => {
  it('returns sessionCode when valid 6-digit', () => {
    setState('network.sessionCode', '123456');
    expect(getInviteCode()).toBe('123456');
  });

  it('returns lastJoinCode when sessionCode is empty', () => {
    setState('network.sessionCode', '');
    setState('network.lastJoinCode', '654321');
    expect(getInviteCode()).toBe('654321');
  });

  it('returns ------ when both are empty', () => {
    setState('network.sessionCode', '');
    setState('network.lastJoinCode', '');
    expect(getInviteCode()).toBe('------');
  });

  it('returns ------ when sessionCode is invalid format', () => {
    setState('network.sessionCode', 'abc');
    setState('network.lastJoinCode', '');
    expect(getInviteCode()).toBe('------');
  });

  it('prefers sessionCode over lastJoinCode', () => {
    setState('network.sessionCode', '111111');
    setState('network.lastJoinCode', '222222');
    expect(getInviteCode()).toBe('111111');
  });
});

describe('updateRoleBadge', () => {
  function renderBadge(): HTMLElement {
    document.body.innerHTML = `
      <div class="role-badge" id="role-badge">
        <span id="role-text"></span>
      </div>
    `;
    return document.getElementById('role-badge') as HTMLElement;
  }

  it('shows LOGIN for an anonymous user regardless of the network route', () => {
    const badge = renderBadge();
    applyAccountSession({
      configured: true,
      authenticated: false,
      account: null,
      statsScope: null,
    });
    setState('network.hostConn', makeConnection('host-1'));
    setState('network.myDeviceLabel', 'GUEST 1');
    setState('network.connectionType', 'remote');
    setState('sync.lastLatencyMs', 42);

    updateRoleBadge();

    expect(badge.classList.contains('connected')).toBe(false);
    expect(badge.classList.contains('remote')).toBe(false);
    expect(document.getElementById('role-text')?.textContent).toBe('LOGIN');
    expect(document.querySelector('.badge-ping')).toBeNull();
  });

  it('does not project an unresolved account session as logged out', () => {
    const badge = renderBadge();
    setState('network.appRole', 'host');

    updateRoleBadge();

    expect(document.getElementById('role-text')?.textContent).toBe('Account');
    expect(badge.getAttribute('aria-label')).toContain('Please wait');
    expect(badge.getAttribute('aria-label')).not.toBe(t('account.login_title'));
  });

  it('shows the authenticated nickname with the account style', () => {
    const badge = renderBadge();
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Minsu', profileComplete: true },
      statsScope: 's'.repeat(43),
    });

    updateRoleBadge();

    expect(badge.classList.contains('account-authenticated')).toBe(true);
    expect(badge.classList.contains('remote')).toBe(false);
    expect(document.getElementById('role-text')?.textContent).toBe('Minsu');
  });

  it('keeps a nickname-deferred account visibly signed in as a standard-room host', () => {
    const badge = renderBadge();
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: '', profileComplete: false },
      statsScope: 's'.repeat(43),
    });
    setState('network.appRole', 'host');
    setState('network.hostConn', null);

    updateRoleBadge();

    expect(badge.classList.contains('account-authenticated')).toBe(true);
    expect(document.getElementById('role-text')?.textContent).toBe('HOST');
    expect(badge.getAttribute('aria-label')).not.toBe(t('account.login_title'));
  });

  it('uses the equal PEER role for a nickname-deferred PRO member', () => {
    const badge = renderBadge();
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: '', profileComplete: false },
      statsScope: 's'.repeat(43),
    });
    // PRO reuses the legacy host role for media-engine compatibility. The
    // account badge must still preserve the room's equal-peer presentation.
    setState('network.appRole', 'host');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });

    updateRoleBadge();

    expect(badge.classList.contains('account-authenticated')).toBe(true);
    expect(document.getElementById('role-text')?.textContent).toBe('PEER');
    expect(badge.getAttribute('aria-label')).not.toBe(t('account.login_title'));
  });

  it('reacts to the account role-badge refresh event', () => {
    renderBadge();
    initPlayerControls();

    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Living Room', profileComplete: true },
      statsScope: 's'.repeat(43),
    });
    bus.emit('network:role-badge-update');

    expect(document.getElementById('role-text')?.textContent).toBe('Living Room');
  });

  it('does not let PRO transport identity replace the account identity', () => {
    const badge = renderBadge();
    applyAccountSession({
      configured: true,
      authenticated: true,
      account: { nickname: 'Account Name', profileComplete: true },
      statsScope: 's'.repeat(43),
    });
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('network.myDeviceLabel', 'Listening Room');
    setState('network.connectionType', 'remote');
    setState('sync.lastLatencyMs', 87);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });

    updateRoleBadge();

    expect(badge.classList.contains('connected')).toBe(false);
    expect(badge.classList.contains('remote')).toBe(false);
    expect(badge.classList.contains('pro-equal')).toBe(false);
    expect(badge.classList.contains('account-authenticated')).toBe(true);
    expect(document.getElementById('role-text')?.textContent).toBe('Account Name');
    expect(document.querySelector('.badge-ping')).toBeNull();
    expect(badge.querySelector('.role-dot')).toBeNull();
  });
});

describe('local file picker hint', () => {
  it('lists every extension supported by the MIME fallback contract', () => {
    document.body.innerHTML = '<input id="file-input" type="file" />';

    initPlayerControls();

    expect((document.getElementById('file-input') as HTMLInputElement).accept).toBe(
      '.mp3,.wav,.flac,.m4a,.aac,.ogg,.oga,.opus,.webm,.aif,.aiff,.caf,audio/*',
    );
  });
});

describe('PRO room media-source capabilities', () => {
  it('restores the ordinary host affordance when setup changes idle to host', () => {
    document.body.innerHTML = `
      <button id="btn-media-source"><span data-i18n="player.play_media_compact">Media</span></button>
    `;

    initPlayerControls();
    expect(document.getElementById('btn-media-source')?.getAttribute('aria-disabled')).toBe('true');

    setState('network.appRole', 'host');

    expect(document.getElementById('btn-media-source')?.getAttribute('aria-disabled')).toBe(
      'false',
    );
  });

  it('updates the standard ADMIN media affordance immediately on grant and revoke', () => {
    document.body.innerHTML = `
      <button id="btn-media-source"><span data-i18n="player.play_media_compact">Media</span></button>
    `;
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host-1'));

    initPlayerControls();
    expect(document.getElementById('btn-media-source')?.getAttribute('aria-disabled')).toBe('true');

    setState('network.isOperator', true);
    expect(document.getElementById('btn-media-source')?.getAttribute('aria-disabled')).toBe(
      'false',
    );

    setState('network.isOperator', false);
    expect(document.getElementById('btn-media-source')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('uses the explicit media.add capability instead of the legacy operator role', () => {
    document.body.innerHTML = `
      <button id="btn-media-source"><span data-i18n="player.play_media_compact">Media</span></button>
    `;
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host-1'));
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['playback.control']);

    initPlayerControls();
    expect(document.getElementById('btn-media-source')?.getAttribute('aria-disabled')).toBe('true');

    setState('network.standardRoomCapabilities', ['media.add', 'asset.upload']);
    expect(document.getElementById('btn-media-source')?.getAttribute('aria-disabled')).toBe(
      'false',
    );
  });

  it('keeps playlist media addition available while the host shares system audio', () => {
    document.body.innerHTML = `
      <button id="btn-add-media"></button>
      <button id="btn-media-source"></button>
      <div id="media-source-overlay"></div>
    `;
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setPlaybackSystemAudioPlaying();

    initPlayerControls();
    const addMedia = document.getElementById('btn-add-media');
    expect(addMedia?.getAttribute('aria-disabled')).toBe('false');

    addMedia?.click();
    expect(document.getElementById('media-source-overlay')?.classList.contains('active')).toBe(
      true,
    );
  });

  it('lets a delegated media manager control repeat and shuffle independently', () => {
    document.body.innerHTML = `
      <button id="btn-repeat"></button>
      <button id="btn-shuffle"></button>
    `;
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host-1'));
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', [
      'media.add',
      'queue.mutate',
      'asset.upload',
      'members.manage',
    ]);
    const repeat = vi.fn();
    const shuffle = vi.fn();
    bus.on('playlist:toggle-repeat', repeat);
    bus.on('playlist:toggle-shuffle', shuffle);

    initPlayerControls();
    document.getElementById('btn-repeat')?.click();
    document.getElementById('btn-shuffle')?.click();

    expect(document.getElementById('btn-repeat')?.getAttribute('aria-disabled')).toBe('false');
    expect(document.getElementById('btn-shuffle')?.getAttribute('aria-disabled')).toBe('false');
    expect(repeat).toHaveBeenCalledTimes(1);
    expect(shuffle).toHaveBeenCalledTimes(1);
  });

  it('lets a PRO administrator add files and YouTube entries but keeps live capture owner-only', () => {
    document.body.innerHTML = `
      <button id="btn-add-media"></button>
      <button id="btn-media-source"><span data-i18n="player.play_media_compact">Media</span></button>
      <div id="media-source-overlay">
        <button id="btn-local-file"></button>
        <input id="file-input" type="file" hidden />
      </div>
      <button id="btn-youtube-source"></button>
      <div id="youtube-url-overlay"></div>
      <div id="youtube-url-input"></div>
      <button id="btn-system-audio"></button>
    `;
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['media.add', 'asset.upload'],
    });
    const input = document.getElementById('file-input') as HTMLInputElement;
    const inputClick = vi.spyOn(input, 'click');
    const reveal = vi.fn();
    bus.on('ui:scrollbar-reveal', reveal);

    initPlayerControls();
    expect(document.getElementById('btn-media-source')?.getAttribute('aria-disabled')).toBe(
      'false',
    );
    expect(document.getElementById('btn-add-media')?.getAttribute('aria-disabled')).toBe('false');
    document.getElementById('btn-add-media')?.click();
    expect(document.getElementById('media-source-overlay')?.classList.contains('active')).toBe(
      true,
    );
    expect(reveal).toHaveBeenCalledWith(document.getElementById('media-source-overlay'));

    document.getElementById('btn-local-file')?.click();
    expect(inputClick).toHaveBeenCalledTimes(1);

    document.getElementById('btn-youtube-source')?.click();
    expect(document.getElementById('youtube-url-overlay')?.classList.contains('active')).toBe(true);
    expect(reveal).toHaveBeenCalledWith(document.getElementById('youtube-url-overlay'));
    expect(youtubePrimer.prime).toHaveBeenCalledTimes(1);

    expect(document.getElementById('btn-system-audio')?.hidden).toBe(true);
  });

  it('focuses, traps, escapes, and restores the media picker dialog', async () => {
    document.body.innerHTML = `
      <button id="btn-media-source"></button>
      <div id="media-source-overlay" role="dialog" aria-modal="true" tabindex="-1">
        <button id="btn-local-file"></button>
        <input id="file-input" type="file" hidden />
        <button id="btn-close-media-popup"></button>
      </div>
    `;
    setState('network.appRole', 'host');
    setState('network.standardRoomCapabilities', ['media.add', 'asset.upload']);

    initPlayerControls();
    const trigger = document.getElementById('btn-media-source') as HTMLButtonElement;
    const first = document.getElementById('btn-local-file') as HTMLButtonElement;
    const close = document.getElementById('btn-close-media-popup') as HTMLButtonElement;
    trigger.focus();
    trigger.click();

    await vi.waitFor(() => expect(document.activeElement).toBe(first));
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(close);

    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.getElementById('media-source-overlay')?.classList).not.toContain('active');
  });

  it('focuses the media picker surface instead of visually selecting an action for pointer opens', async () => {
    document.body.innerHTML = `
      <button id="btn-media-source"></button>
      <div id="media-source-overlay" role="dialog" aria-modal="true" tabindex="-1">
        <button id="btn-local-file"></button>
        <input id="file-input" type="file" hidden />
        <button id="btn-close-media-popup"></button>
      </div>
    `;
    setState('network.appRole', 'host');
    setState('network.standardRoomCapabilities', ['media.add', 'asset.upload']);

    initPlayerControls();
    document
      .getElementById('btn-media-source')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));

    const overlay = document.getElementById('media-source-overlay') as HTMLElement;
    await vi.waitFor(() => expect(document.activeElement).toBe(overlay));
    expect(overlay.classList.contains('active')).toBe(true);
  });

  it('updates script-aware fonts while typing a YouTube search query', () => {
    document.body.innerHTML = `<div id="youtube-url-input" contenteditable="true"></div>`;
    const input = document.getElementById('youtube-url-input') as HTMLDivElement;

    initPlayerControls();
    input.textContent = 'เพลงไทย';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));

    expect(input.classList).toContain('user-text-font');
    expect(input.classList).toContain('user-text-font-th');
  });

  it('uses the inline magnifier for queries while preserving direct URL submission on Enter', () => {
    document.body.innerHTML = `
      <div id="youtube-url-input" contenteditable="true"></div>
      <button id="youtube-search-btn" disabled></button>
      <button id="youtube-play-btn" disabled></button>
    `;
    const input = document.getElementById('youtube-url-input') as HTMLDivElement;
    const searchButton = document.getElementById('youtube-search-btn') as HTMLButtonElement;
    const playButton = document.getElementById('youtube-play-btn') as HTMLButtonElement;
    const search = vi.fn();
    const load = vi.fn();
    bus.on('youtube:search-from-input', search);
    bus.on('youtube:load-from-input', load);

    initPlayerControls();
    input.textContent = 'city pop live';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));

    expect(searchButton.disabled).toBe(false);
    expect(playButton.disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    searchButton.click();
    expect(search).toHaveBeenCalledTimes(2);
    expect(load).not.toHaveBeenCalled();

    input.textContent = 'https://www.youtube.com/watch?v=AAAAAAAAAAA';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    expect(searchButton.disabled).toBe(true);

    playButton.disabled = false;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(load).toHaveBeenCalledOnce();
  });

  it('does not let Enter bypass a disabled YouTube preview submit gate', () => {
    document.body.innerHTML = `
      <div id="youtube-url-input" contenteditable="true"></div>
      <button id="youtube-play-btn" disabled></button>
    `;
    const input = document.getElementById('youtube-url-input') as HTMLDivElement;
    const submit = vi.fn();
    bus.on('youtube:load-from-input', submit);

    initPlayerControls();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['composing', 'legacy'])('keeps the YouTube query during %s IME Escape', (mode) => {
    document.body.innerHTML =
      '<div id="youtube-url-overlay" class="active"><div id="youtube-url-input" contenteditable="true">한글</div><button id="btn-yt-cancel"></button></div>';
    initPlayerControls();
    const input = document.getElementById('youtube-url-input')!;
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        isComposing: mode === 'composing',
        keyCode: mode === 'legacy' ? 229 : 0,
        bubbles: true,
      }),
    );
    expect(document.getElementById('youtube-url-overlay')!.classList.contains('active')).toBe(true);
    expect(input.textContent).toBe('한글');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('youtube-url-overlay')!.classList.contains('active')).toBe(
      false,
    );
  });

  it('waits for a gesture-bound iOS prime proof before submitting the real video load', async () => {
    document.body.innerHTML = `
      <div id="youtube-url-overlay" class="active"></div>
      <div id="youtube-url-input" contenteditable="true">https://youtube.com/playlist?list=PL_READY</div>
      <button id="youtube-play-btn"></button>
    `;
    const submit = vi.fn();
    bus.on('youtube:load-from-input', submit);
    youtubePrimer.prime.mockReturnValueOnce(true);

    initPlayerControls();
    const playButton = document.getElementById('youtube-play-btn') as HTMLButtonElement;
    playButton.click();

    expect(submit).not.toHaveBeenCalled();
    expect(playButton.disabled).toBe(true);
    expect(playButton.getAttribute('aria-busy')).toBe('true');
    expect(youtubePrimer.prime).toHaveBeenCalledWith({ retryPending: true });
    expect(youtubePrimer.wait).toHaveBeenCalledWith(1_500);

    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(playButton.disabled).toBe(false);
    expect(playButton.hasAttribute('aria-busy')).toBe(false);
  });

  it('keeps an already-primed YouTube submit in the original click stack', () => {
    document.body.innerHTML = `
      <div id="youtube-url-input" contenteditable="true">https://youtube.com/watch?v=AAAAAAAAAAA</div>
      <button id="youtube-play-btn"></button>
    `;
    const submit = vi.fn();
    bus.on('youtube:load-from-input', submit);
    youtubePrimer.prime.mockReturnValueOnce(false);

    initPlayerControls();
    document.getElementById('youtube-play-btn')?.click();

    expect(submit).toHaveBeenCalledOnce();
    expect(youtubePrimer.prime).toHaveBeenCalledWith({ retryPending: true });
    expect(youtubePrimer.wait).not.toHaveBeenCalled();
  });

  it('does not let a closed submit resume into a reopened popup with the same URL', async () => {
    document.body.innerHTML = `
      <div id="youtube-url-overlay" class="active"></div>
      <div id="youtube-url-input" contenteditable="true">https://youtube.com/playlist?list=PL_STALE</div>
      <button id="youtube-play-btn"></button>
      <button id="btn-yt-cancel"></button>
    `;
    let resolvePrime!: (value: boolean) => void;
    youtubePrimer.prime.mockReturnValueOnce(true);
    youtubePrimer.wait.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolvePrime = resolve;
      }),
    );
    const submit = vi.fn();
    bus.on('youtube:load-from-input', submit);

    initPlayerControls();
    const overlay = document.getElementById('youtube-url-overlay') as HTMLDivElement;
    const input = document.getElementById('youtube-url-input') as HTMLDivElement;
    const playButton = document.getElementById('youtube-play-btn') as HTMLButtonElement;
    playButton.click();
    expect(playButton.disabled).toBe(true);

    document.getElementById('btn-yt-cancel')?.click();
    overlay.classList.add('active');
    input.textContent = 'https://youtube.com/playlist?list=PL_STALE';
    playButton.disabled = true;

    resolvePrime(true);
    await vi.waitFor(() => expect(youtubePrimer.wait).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();

    expect(submit).not.toHaveBeenCalled();
    expect(playButton.disabled).toBe(true);
    expect(playButton.hasAttribute('aria-busy')).toBe(false);
  });

  it('shows the current owner and never starts a second PRO picker', () => {
    document.body.innerHTML = `
      <button id="btn-add-media"></button>
      <div id="media-source-overlay"></div>
      <button id="btn-system-audio"><span class="media-source-label-text"></span></button>
    `;
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['media.add', 'asset.upload', 'system-audio.publish'],
    });
    Object.assign(proSystemAudio.view, {
      initialized: true,
      phase: 'live',
      generation: 9,
      ownerParticipantId: 'participant-2',
      canStart: false,
    });
    proSystemAudio.ownerName = 'Peer 2';
    const startSpy = vi.fn();
    bus.on('system-audio:start', startSpy);

    initPlayerControls();
    document.getElementById('btn-add-media')?.click();
    document.getElementById('btn-system-audio')?.click();

    expect(startSpy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(t('system_audio.owner_active', { name: 'Peer 2' }));
  });

  it('reports an unavailable PRO publishing capability before opening the native picker', () => {
    document.body.innerHTML = `
      <button id="btn-add-media"></button>
      <div id="media-source-overlay"></div>
      <button id="btn-system-audio"><span class="media-source-label-text"></span></button>
    `;
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['media.add', 'asset.upload', 'system-audio.publish'],
    });
    proSystemAudio.coordinatorCompatible = false;
    const startSpy = vi.fn();
    bus.on('system-audio:start', startSpy);

    initPlayerControls();
    document.getElementById('btn-add-media')?.click();
    document.getElementById('btn-system-audio')?.click();

    expect(startSpy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(t('system_audio.coordinator_update_required'));
  });

  it('keeps standard-room live capture coordinator-only', () => {
    document.body.innerHTML = '<button id="btn-system-audio"></button>';
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host-1'));
    const startSpy = vi.fn();
    bus.on('system-audio:start', startSpy);

    initPlayerControls();
    document.getElementById('btn-system-audio')?.click();

    expect(startSpy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(t('toast.system_audio_owner_required'));
  });
});

describe('initPlayerControls playback mode rendering', () => {
  function renderPlaybackControls(): void {
    document.body.innerHTML = `
      <button id="btn-prev"></button>
      <button id="play-btn"><svg><path d=""></path></svg></button>
      <button id="btn-next"></button>
      <button
        id="btn-media-source"
        aria-label="Play media"
        data-i18n-aria-label="player.play_media"
      ><span data-i18n="player.play_media_compact">Media</span></button>
      <div class="vinyl-wrapper" aria-busy="false"><canvas id="visualizerCanvas"></canvas></div>
      <div class="video-wrapper" aria-busy="false">
        <div id="youtube-player-container"></div>
        <div
          id="youtube-sync-loading-overlay"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-hidden="true"
          hidden
        ></div>
      </div>
    `;
  }

  function expectYouTubeSyncOverlay(showing: boolean): void {
    const wrapper = document.querySelector('.video-wrapper');
    const youtubeContainer = document.getElementById('youtube-player-container');
    const overlay = document.getElementById('youtube-sync-loading-overlay') as HTMLElement | null;
    expect(wrapper?.getAttribute('aria-busy')).toBe(String(showing));
    expect(youtubeContainer?.hasAttribute('inert')).toBe(showing);
    expect(overlay?.hidden).toBe(!showing);
    expect(overlay?.getAttribute('aria-hidden')).toBe(String(!showing));
  }

  it('renders the current playback mode immediately and stays reactive afterward', () => {
    renderPlaybackControls();
    setPlaybackSystemAudioPlaying();

    initPlayerControls();

    const icon = document.querySelector('#play-btn path');
    const mediaBtn = document.getElementById('btn-media-source');
    const mediaLabel = mediaBtn?.querySelector('span');

    expect(icon?.getAttribute('d')).toBe('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    expect(mediaLabel?.getAttribute('data-i18n')).toBe('system_audio.stop_compact');
    expect(mediaBtn?.getAttribute('data-i18n-aria-label')).toBe('system_audio.stop');
    expect(mediaBtn?.getAttribute('aria-label')).toBe(t('system_audio.stop'));

    setPlaybackIdle();

    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');
    expect(mediaLabel?.getAttribute('data-i18n')).toBe('player.play_media_compact');
    expect(mediaBtn?.getAttribute('data-i18n-aria-label')).toBe('player.play_media');
    expect(mediaBtn?.getAttribute('aria-label')).toBe(t('player.play_media'));
    expect(mediaBtn?.classList.contains('sys-audio-guest')).toBe(false);
  });

  it('removes the stop-sharing label when PRO system-audio ownership moves away', () => {
    renderPlaybackControls();
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['media.add', 'system-audio.publish'],
    });
    setPlaybackSystemAudioPlaying();
    proSystemAudio.view.phase = 'live';
    proSystemAudio.view.isLocalOwner = true;

    initPlayerControls();
    const mediaBtn = document.getElementById('btn-media-source');
    const mediaLabel = mediaBtn?.querySelector('span');
    expect(mediaLabel?.getAttribute('data-i18n')).toBe('system_audio.stop_compact');
    expect(mediaBtn?.getAttribute('data-i18n-aria-label')).toBe('system_audio.stop');
    expect(mediaBtn?.getAttribute('aria-label')).toBe(t('system_audio.stop'));

    proSystemAudio.view.isLocalOwner = false;
    bus.emit('pro-system-audio:state-changed', { ...proSystemAudio.view }, null);

    expect(mediaLabel?.getAttribute('data-i18n')).toBe('player.play_media_compact');
    expect(mediaBtn?.getAttribute('data-i18n-aria-label')).toBe('player.play_media');
    expect(mediaBtn?.getAttribute('aria-label')).toBe(t('player.play_media'));
    expect(mediaBtn?.classList.contains('sys-audio-guest')).toBe(true);
  });

  it('uses playback mode for YouTube play-state events', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();

    const icon = document.querySelector('#play-btn path');
    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');

    bus.emit('ui:update-play-state', true);
    expect(icon?.getAttribute('d')).toBe('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
  });

  it('blocks only the YouTube frame for the complete sync-loading lifecycle', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    initPlayerControls();

    expectYouTubeSyncOverlay(false);
    bus.emit('youtube:sync-loading', true);
    expectYouTubeSyncOverlay(true);

    bus.emit('youtube:sync-loading', false);
    expectYouTubeSyncOverlay(false);
  });

  it('keeps the shield while any independently owned YouTube sync remains pending', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    initPlayerControls();

    bus.emit('youtube:sync-loading', true, 'rendezvous');
    bus.emit('youtube:sync-loading', true, 'clock-action');
    expectYouTubeSyncOverlay(true);

    bus.emit('youtube:sync-loading', false, 'rendezvous');
    expectYouTubeSyncOverlay(true);

    bus.emit('youtube:sync-loading', false, 'clock-action');
    expectYouTubeSyncOverlay(false);
  });

  it('never exposes the YouTube shield for non-YouTube loading', () => {
    renderPlaybackControls();
    setState('playback.mode', 'file');
    setState('playback.lifecycle', PLAYBACK_STATE.DECODING);
    initPlayerControls();

    expect(document.getElementById('play-btn')?.classList).toContain('is-loading');
    expectYouTubeSyncOverlay(false);

    bus.emit('youtube:sync-loading', true);
    expectYouTubeSyncOverlay(false);
  });

  it('removes the shield on mode exit even while a PRO transition remains pending', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    initPlayerControls();

    bus.emit('pro-playback:transition-loading', true);
    expectYouTubeSyncOverlay(true);

    setState('playback.mode', 'file');
    expect(document.getElementById('play-btn')?.classList).toContain('is-loading');
    expectYouTubeSyncOverlay(false);
  });

  it('clears a stale shield when player controls are re-initialized', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    initPlayerControls();
    bus.emit('youtube:sync-loading', true);
    expectYouTubeSyncOverlay(true);

    initPlayerControls();
    expect(document.getElementById('play-btn')?.classList).not.toContain('is-loading');
    expectYouTubeSyncOverlay(false);
  });

  it('replaces DOM listeners when re-initialized on the same controls', () => {
    renderPlaybackControls();
    const previousTrack = vi.fn();
    const togglePlay = vi.fn();
    const nextTrack = vi.fn();
    bus.on('playlist:prev-track', previousTrack);
    bus.on('player:toggle-play', togglePlay);
    bus.on('playlist:next-track', nextTrack);

    initPlayerControls();
    initPlayerControls();

    document.getElementById('btn-prev')?.click();
    document.getElementById('play-btn')?.click();
    document.getElementById('btn-next')?.click();

    expect(previousTrack).toHaveBeenCalledTimes(1);
    expect(togglePlay).toHaveBeenCalledTimes(1);
    expect(nextTrack).toHaveBeenCalledTimes(1);
  });

  it('shows the shield for pending PRO YouTube play and playing-seek controls', () => {
    renderPlaybackControls();
    setState('playback.mode', 'youtube');
    initPlayerControls();

    bus.emit('pro-playback:ui-control-pending', {
      token: 30,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      targetSeconds: 12,
      wasPlaying: false,
    });
    expectYouTubeSyncOverlay(true);

    bus.emit('pro-playback:ui-control-settled', {
      token: 30,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 12,
    });
    expectYouTubeSyncOverlay(false);

    bus.emit('pro-playback:ui-control-pending', {
      token: 31,
      kind: 'seek',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      targetSeconds: 30,
      wasPlaying: true,
    });
    expectYouTubeSyncOverlay(true);

    bus.emit('pro-playback:ui-control-settled', {
      token: 31,
      kind: 'seek',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 30,
    });
    expectYouTubeSyncOverlay(false);
  });

  it('updates a ready PRO play button immediately when playback authority is revoked or granted', () => {
    renderPlaybackControls();
    const context = {
      kind: 'pro' as const,
      roomId: '000001',
      role: 'member' as const,
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control' as const],
    };
    setState('room.context', context);
    initPlayerControls();
    const playBtn = document.getElementById('play-btn');

    bus.emit('ui:play-btn-state', true);
    expect(playBtn?.getAttribute('aria-disabled')).toBe('false');

    setState('room.context', { ...context, snapshotRevision: 2, capabilities: [] });
    expect(playBtn?.getAttribute('aria-disabled')).toBe('true');

    setState('room.context', { ...context, snapshotRevision: 3 });
    expect(playBtn?.getAttribute('aria-disabled')).toBe('false');
  });

  it('projects granular standard-room playback authority onto every transport control', () => {
    renderPlaybackControls();
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host-1'));
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['media.add', 'queue.mutate']);
    initPlayerControls();
    bus.emit('ui:play-btn-state', true);

    for (const id of ['btn-prev', 'play-btn', 'btn-next']) {
      expect(document.getElementById(id)?.getAttribute('aria-disabled')).toBe('true');
    }

    setState('network.standardRoomCapabilities', ['media.add', 'queue.mutate', 'playback.control']);
    for (const id of ['btn-prev', 'play-btn', 'btn-next']) {
      expect(document.getElementById(id)?.getAttribute('aria-disabled')).toBe('false');
    }
  });

  it('keeps the physical standard-room host transport enabled through sibling authority churn', () => {
    renderPlaybackControls();
    setActiveStandardHost();
    setState('network.hostConn', null);
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    initPlayerControls();
    bus.emit('ui:play-btn-state', true);

    const expectHostTransportEnabled = () => {
      expect(getState('network.appRole')).toBe('host');
      expect(getState('network.hostConn')).toBeNull();
      for (const id of ['btn-prev', 'play-btn', 'btn-next']) {
        const button = document.getElementById(id);
        expect(button?.getAttribute('aria-disabled')).toBe('false');
        expect(button?.hasAttribute('title')).toBe(false);
      }
    };

    expectHostTransportEnabled();

    // These are the guest-side projections used by another authenticated
    // device of the host account. They must never demote the physical host.
    setState('network.standardRoomCapabilities', [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES]);
    expectHostTransportEnabled();
    setState('network.isOperator', true);
    expectHostTransportEnabled();
    setState('network.standardRoomCapabilities', null);
    expectHostTransportEnabled();
    setState('network.isOperator', false);
    expectHostTransportEnabled();
  });

  it.each([PLAYBACK_STATE.DOWNLOADING, PLAYBACK_STATE.AWAITING_PRELOAD, PLAYBACK_STATE.DECODING])(
    'shows the loading play button while a local file is preparing (%s)',
    (lifecycle) => {
      renderPlaybackControls();
      setState('playback.lifecycle', lifecycle);

      initPlayerControls();

      const playBtn = document.getElementById('play-btn');
      expect(playBtn?.classList.contains('is-loading')).toBe(true);
      expect(playBtn?.getAttribute('aria-busy')).toBe('true');

      setState('playback.lifecycle', PLAYBACK_STATE.READY);

      expect(playBtn?.classList.contains('is-loading')).toBe(false);
      expect(playBtn?.getAttribute('aria-busy')).toBe('false');
    },
  );

  it('shows system-audio receiver loading through initial connect and reconnect gaps', () => {
    renderPlaybackControls();
    claimPlaybackOwner('system-audio', {
      pending: true,
      currentTrackMeta: createSystemAudioTrackMeta('receiving'),
    });

    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    expect(playBtn?.classList.contains('is-loading')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    setSystemAudioReceiving(true);
    expect(playBtn?.classList.contains('is-loading')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');

    setSystemAudioReceiving(false);
    expect(playBtn?.classList.contains('is-loading')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');
  });

  it('shows the loading play button while a PRO member awaits server selection', () => {
    renderPlaybackControls();
    setState('network.pendingTrackChangeQueueItemId', PLAY_QUEUE_ITEM_ID);

    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    expect(playBtn?.classList.contains('is-loading')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    setState('network.pendingTrackChangeQueueItemId', null);

    expect(playBtn?.classList.contains('is-loading')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
  });

  it('shows the loading play button for every participant in a PRO rendezvous', () => {
    renderPlaybackControls();
    const loadingStates: boolean[] = [];
    bus.on('ui:play-loading-state', (loading) => loadingStates.push(loading));
    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    expect(loadingStates.at(-1)).toBe(false);
    bus.emit('pro-playback:transition-loading', true);

    expect(playBtn?.classList.contains('is-loading')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');
    expect(loadingStates.at(-1)).toBe(true);

    bus.emit('pro-playback:transition-loading', false);

    expect(playBtn?.classList.contains('is-loading')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
    expect(loadingStates.at(-1)).toBe(false);
  });

  it('keeps the spinner after local selection intent yields to the shared PRO transition', () => {
    renderPlaybackControls();
    setState('network.pendingTrackChangeQueueItemId', PLAY_QUEUE_ITEM_ID);
    initPlayerControls();

    const playBtn = document.getElementById('play-btn');
    bus.emit('pro-playback:transition-loading', true);
    setState('network.pendingTrackChangeQueueItemId', null);

    expect(playBtn?.classList.contains('is-loading')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    bus.emit('pro-playback:transition-loading', false);

    expect(playBtn?.classList.contains('is-loading')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
  });

  it('keeps the play spinner bound to the exact pending PRO play token', () => {
    renderPlaybackControls();
    initPlayerControls();
    const playBtn = document.getElementById('play-btn');

    bus.emit('pro-playback:ui-control-pending', {
      token: 10,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      targetSeconds: 12,
      wasPlaying: false,
    });
    expect(playBtn?.classList.contains('is-loading')).toBe(true);
    expect(playBtn?.getAttribute('aria-busy')).toBe('true');

    bus.emit('pro-playback:ui-control-settled', {
      token: 9,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'superseded',
    });
    expect(playBtn?.classList.contains('is-loading')).toBe(true);

    bus.emit('pro-playback:ui-control-settled', {
      token: 10,
      kind: 'play',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 12,
    });
    expect(playBtn?.classList.contains('is-loading')).toBe(false);
    expect(playBtn?.getAttribute('aria-busy')).toBe('false');
  });

  it('shows a spinner for a playing seek but makes a pending pause look immediate', () => {
    renderPlaybackControls();
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    initPlayerControls();
    const playBtn = document.getElementById('play-btn');
    const icon = playBtn?.querySelector('path');

    bus.emit('pro-playback:ui-control-pending', {
      token: 20,
      kind: 'seek',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      targetSeconds: 30,
      wasPlaying: true,
    });
    expect(playBtn?.classList.contains('is-loading')).toBe(true);

    bus.emit('pro-playback:ui-control-settled', {
      token: 20,
      kind: 'seek',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 30,
    });
    bus.emit('pro-playback:ui-control-pending', {
      token: 21,
      kind: 'pause',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      targetSeconds: 31,
      wasPlaying: true,
    });
    // A late engine state notification must not paint the pause icon back
    // over the participant-local pause projection.
    setState('playback.activity', 'paused');
    setState('playback.activity', 'playing');

    expect(playBtn?.classList.contains('is-loading')).toBe(false);
    expect(icon?.getAttribute('d')).toBe('M8 5v14l11-7z');

    bus.emit('pro-playback:ui-control-settled', {
      token: 21,
      kind: 'pause',
      queueItemId: PLAY_QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 31,
    });
  });
});

describe('initPlayerControls fullscreen fallback', () => {
  it('does not enter fake fullscreen when a rejected native request settles after mode exit', async () => {
    document.body.innerHTML = `
      <div class="video-wrapper">
        <button id="btn-fullscreen"></button>
      </div>
    `;
    const wrapper = document.querySelector('.video-wrapper') as HTMLElement & {
      requestFullscreen: () => Promise<void>;
    };
    let rejectFullscreen!: (reason?: unknown) => void;
    wrapper.requestFullscreen = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFullscreen = reject;
        }),
    );
    setState('playback.mode', 'youtube');
    initPlayerControls();

    document.getElementById('btn-fullscreen')?.click();
    setState('playback.mode', 'file');
    rejectFullscreen(new Error('request superseded'));
    await Promise.resolve();

    expect(wrapper.classList.contains('fake-fullscreen')).toBe(false);
    expect(document.body.classList.contains('has-fake-fullscreen')).toBe(false);
  });

  it('exits a native fullscreen request that resolves after YouTube mode has ended', async () => {
    document.body.innerHTML = `
      <div class="video-wrapper">
        <div id="youtube-player-container"></div>
        <button id="btn-fullscreen"></button>
      </div>
    `;
    const wrapper = document.querySelector('.video-wrapper') as HTMLElement & {
      requestFullscreen: () => Promise<void>;
    };
    let resolveFullscreen!: () => void;
    let activeFullscreenElement: Element | null = null;
    const exitFullscreen = vi.fn(() => Promise.resolve());
    wrapper.requestFullscreen = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFullscreen = resolve;
        }),
    );
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => activeFullscreenElement,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    });
    setState('playback.mode', 'youtube');
    initPlayerControls();

    document.getElementById('btn-fullscreen')?.click();
    setState('playback.mode', 'file');
    activeFullscreenElement = wrapper;
    resolveFullscreen();
    await Promise.resolve();

    expect(exitFullscreen).toHaveBeenCalledOnce();
  });
});

describe('initPlayerControls tab title marquee wiring', () => {
  it('hydrates metadata when a remote guest is already playing during UI initialization', () => {
    setState('network.hostConn', makeConnection('host-1'));
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'remote.flac',
      title: 'Remote orchestra',
    });
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');

    initPlayerControls();

    expect(document.title).toBe('Remote orchestra · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();
  });

  it('starts the new title when remote metadata arrives after the playing state', () => {
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    initPlayerControls();

    expect(document.title).toBe('MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).toBeNull();

    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'late.wav',
      title: 'Late remote metadata',
    });

    expect(document.title).toBe('Late remote metadata · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();
  });

  it('replaces the previous title when the next track arrives without an activity transition', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'first.wav',
      title: 'First track',
    });
    initPlayerControls();

    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'second.wav',
      title: 'Second track',
    });

    expect(document.title).toBe('Second track · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();
  });

  it('updates a paused track title immediately instead of waiting for playback to change', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'old.wav',
      title: 'Old title',
    });
    initPlayerControls();

    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'new.wav',
      title: 'New paused title',
    });

    expect(document.title).toBe('New paused title · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).toBeNull();
  });

  it('keeps confirmed YouTube marquee motion when the iframe state is unavailable on focus', () => {
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    setState('player.currentTrackMeta', {
      type: 'youtube',
      name: 'youtube-video',
      title: 'YouTube track',
      videoId: 'video-1',
      playlistId: null,
    });
    initPlayerControls();

    // The real iframe PLAYING event is authoritative even if getPlayerState()
    // is temporarily unavailable during the next page-lifecycle callback.
    bus.emit('ui:update-play-state', true);
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();

    window.dispatchEvent(new Event('focus'));

    expect(document.title).toBe('YouTube track · MUSIXQUARE');
    expect(getManagedTimer('tab-title-marquee')).not.toBeNull();
  });
});

describe('initPlayerControls track metadata subtitle', () => {
  function renderTrackMetadata(): HTMLElement {
    document.body.innerHTML = `
      <div id="track-title"></div>
      <div id="track-artist" data-i18n="player.select_file_hint">${t('player.select_file_hint')}</div>
    `;
    initPlayerControls();
    return document.getElementById('track-artist')!;
  }

  it('keeps the localized no-media hint across player panel refreshes', () => {
    const subtitle = renderTrackMetadata();
    const expectedHint = t('player.select_file_hint');

    expect(subtitle.textContent).toBe(expectedHint);

    bus.emit('ui:player-panel-visible');

    expect(subtitle.textContent).toBe(expectedHint);
    expect(subtitle.title).toBe(expectedHint);
  });

  it('shows estimated bitrate before the local extension and omits artist', () => {
    const subtitle = renderTrackMetadata();
    const file = new File([new Uint8Array(400_000)], 'night-drive.flac', {
      type: 'audio/flac',
    });
    setCurrentAudioBuffer({ duration: 10 } as AudioBuffer);
    setState('playlist.currentQueueItemId', PLAY_QUEUE_ITEM_ID);

    setState('player.currentTrackMeta', {
      queueItemId: PLAY_QUEUE_ITEM_ID,
      type: 'file',
      name: file.name,
      title: 'Night Drive',
      artist: 'Archive Signal',
      file,
    });

    expect(subtitle.textContent).toBe('FLAC');

    setState('files.current', {
      queueItemId: PLAY_QUEUE_ITEM_ID,
      indexHint: 0,
      sessionId: 1,
      name: file.name,
      blob: file,
      mime: file.type,
      size: file.size,
    });

    expect(subtitle.textContent).toBe('≈320 kbps · FLAC');
    expect(subtitle.title).toBe(subtitle.textContent);
  });

  it('shows only the YouTube channel when it is available', () => {
    const subtitle = renderTrackMetadata();

    setState('player.currentTrackMeta', {
      type: 'youtube',
      name: 'Live Session',
      title: 'Live Session',
      artist: 'MUSIXQUARE Live',
      videoId: 'video-1',
      playlistId: null,
    });

    expect(subtitle.textContent).toBe('MUSIXQUARE Live');
  });

  it.each([
    ['sharing', 'browser', '≤256 kbps · BROWSER'],
    ['sharing', 'window', '≤256 kbps · WINDOW'],
    ['sharing', 'display', '≤256 kbps · DISPLAY'],
    ['receiving', 'browser', '≤256 kbps · BROWSER'],
    ['receiving', 'window', '≤256 kbps · WINDOW'],
    ['receiving', 'display', '≤256 kbps · DISPLAY'],
  ] as const)('renders the %s system-audio %s profile', (mode, surface, expected) => {
    const subtitle = renderTrackMetadata();

    setState('player.currentTrackMeta', createSystemAudioTrackMeta(mode, undefined, surface));

    expect(subtitle.textContent).toBe(expected);
    expect(subtitle.title).toBe(expected);

    bus.emit('i18n:changed', 'en');
    expect(subtitle.textContent).toBe(expected);
  });

  it('leaves an extensionless unresolved local file blank instead of inventing a format', () => {
    const subtitle = renderTrackMetadata();

    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'untagged-audio',
      title: 'Untagged audio',
    });

    expect(subtitle.textContent).toBe('');
    expect(subtitle.hasAttribute('title')).toBe(false);
  });
});

describe('initPlayerControls volume icon', () => {
  function renderVolumeControls(): HTMLElement {
    document.body.innerHTML = `
      <button id="vol-icon-btn" aria-label="Toggle mute">
        <svg class="volume-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path class="volume-speaker" d="M3 9v6h4l5 5V4L7 9H3z"></path>
          <path class="volume-wave volume-wave-inner" d="M15.2 8.5a4.9 4.9 0 0 1 0 7"></path>
          <path class="volume-wave volume-wave-outer" d="M18 5.7a8.9 8.9 0 0 1 0 12.6"></path>
          <g class="volume-muted-backdrop">
            <circle class="volume-muted-ring" cx="17" cy="12" r="4.8"></circle>
            <path class="volume-muted-slash" d="M13.6 8.6l6.8 6.8"></path>
          </g>
          <g class="volume-muted-mark">
            <circle class="volume-muted-ring" cx="17" cy="12" r="4.8"></circle>
            <path class="volume-muted-slash" d="M13.6 8.6l6.8 6.8"></path>
          </g>
        </svg>
      </button>
      <input type="range" id="volume-slider" min="0" max="100" value="100" />
    `;
    return document.getElementById('vol-icon-btn') as HTMLElement;
  }

  it('uses a class-driven muted mark instead of swapping icon paths', () => {
    const button = renderVolumeControls();
    setState('audio.masterVolume', 0);

    initPlayerControls();

    expect(button.classList.contains('is-muted')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(
      document.getElementById('volume-slider')?.style.getPropertyValue('--range-progress'),
    ).toBe('0%');

    setState('audio.masterVolume', 0.65);
    bus.emit('audio:volume-changed', 0.65);

    expect(button.classList.contains('is-muted')).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect((document.getElementById('volume-slider') as HTMLInputElement).value).toBe('65');
    expect(
      document.getElementById('volume-slider')?.style.getPropertyValue('--range-progress'),
    ).toBe('65%');
  });

  it('locks follower volume while sync is ON and restores local control when OFF', () => {
    const button = renderVolumeControls() as HTMLButtonElement;
    const slider = document.getElementById('volume-slider') as HTMLInputElement;
    setState('setup.sessionStarted', true);
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('host'));
    setState('audio.settingsSyncEnabled', true);

    initPlayerControls();
    expect(button.disabled).toBe(true);
    expect(slider.disabled).toBe(true);

    setState('audio.settingsSyncEnabled', false);
    bus.emit('settings-sync:changed', false);
    expect(button.disabled).toBe(false);
    expect(slider.disabled).toBe(false);
  });
});

describe('initPlayerControls sync button', () => {
  function renderSyncControls(): void {
    document.body.innerHTML = `
      <button id="btn-sync"><span data-i18n="player.sync_compact">Sync</span></button>
      <button id="play-btn"><svg><path d=""></path></svg></button>
      <button id="btn-media-source"><span data-i18n="player.play_media_compact">Media</span></button>
      <div id="manual-sync-overlay" aria-hidden="true">
        <div role="dialog" aria-modal="true" aria-label="Sync">
          <div class="chat-input-wrapper">
            <div
              id="manual-sync-value"
              contenteditable="true"
              role="textbox"
              tabindex="0"
              aria-describedby="manual-sync-range-hint"
              inputmode="text"
            >0</div>
            <span id="manual-sync-range-hint" class="sr-only">-9999 … +9999 ms</span>
          </div>
          <button id="btn-nudge-minus10">-10</button>
          <button id="btn-nudge-minus1">-1</button>
          <button id="btn-nudge-plus1">+1</button>
          <button id="btn-nudge-plus10">+10</button>
          <button id="btn-auto-sync">Reset</button>
          <button id="btn-sync-done">Done</button>
        </div>
      </div>
    `;
  }

  async function settleManualSyncOverlayOpen(): Promise<void> {
    await vi.dynamicImportSettled();
    await Promise.resolve();
  }

  async function openEditableFileSyncControls(): Promise<HTMLElement> {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    initPlayerControls();
    document.getElementById('btn-sync')?.click();
    await settleManualSyncOverlayOpen();
    return document.getElementById('manual-sync-value') as HTMLElement;
  }

  it('tells a fresh host to select media instead of suggesting a passive retry', () => {
    renderSyncControls();

    initPlayerControls();
    expect(document.getElementById('btn-sync')?.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById('btn-sync')?.title).toContain("There's no media to sync");
    document.getElementById('btn-sync')?.click();

    expect(showToast).toHaveBeenCalledWith(
      "There's no media to sync.\nSelect something to play first",
    );
  });

  it('updates sync readiness before activation when playable media appears', () => {
    renderSyncControls();
    setActiveStandardHost();

    initPlayerControls();
    const button = document.getElementById('btn-sync') as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');

    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(button.hasAttribute('title')).toBe(false);
  });

  it('repaints restored host sync readiness when room activation settles after YouTube', async () => {
    renderSyncControls();
    setState('network.appRole', 'host');
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();
    const button = document.getElementById('btn-sync') as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.title).toContain('Not ready yet');

    setState('network.sessionCode', '123456');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    setState('setup.sessionStarted', true);

    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(button.hasAttribute('title')).toBe(false);
    button.click();
    await settleManualSyncOverlayOpen();
    expect(broadcastYouTubeSync).toHaveBeenCalledWith(true);
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
  });

  it('keeps the transient not-ready message for a guest waiting on the host', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('runs guest YouTube rendezvous before opening the manual sync panel', async () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    setState('sync.youtubeLocalOffset', 0.25);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();
    await settleManualSyncOverlayOpen();

    const guestSync = vi.mocked(guestRendezvousSync);
    expect(guestSync).toHaveBeenCalledTimes(1);
    const opts = guestSync.mock.calls[0][0];
    expect(opts?.suppressProgressToast).toBe(true);
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);

    opts?.onComplete?.();
    await settleManualSyncOverlayOpen();

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
    expect((document.getElementById('manual-sync-value') as HTMLElement | null)?.textContent).toBe(
      '+250',
    );
    expect(showToast).toHaveBeenCalledWith(
      'Automatic sync was just attempted.\nIf it still feels delayed, adjust the value now',
    );
  });

  it('commits a signed manual value on Enter and clamps it to -9999ms', async () => {
    const editor = await openEditableFileSyncControls();
    const commits = vi.fn();
    bus.on('sync:set-manual-offset', commits);

    editor.focus();
    editor.textContent = '−１２３４５';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledWith(-9999);
    expect(editor.textContent).toBe('-9999');
    expect(editor.getAttribute('aria-invalid')).toBe('false');
  });

  it('commits a sanitized positive value on blur', async () => {
    const editor = await openEditableFileSyncControls();
    const commits = vi.fn();
    bus.on('sync:set-manual-offset', commits);

    editor.focus();
    editor.textContent = '+42ms';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editor.textContent).toBe('+42');
    editor.blur();

    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledWith(42);
    expect(editor.textContent).toBe('+42');
  });

  it('commits and dismisses the mobile editor from beforeinput Done', async () => {
    const editor = await openEditableFileSyncControls();
    const commits = vi.fn();
    bus.on('sync:set-manual-offset', commits);

    editor.focus();
    editor.textContent = '-321';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    const done = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertParagraph',
    });
    editor.dispatchEvent(done);

    expect(done.defaultPrevented).toBe(true);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledWith(-321);
    expect(document.activeElement).not.toBe(editor);
  });

  it('keeps an incomplete sign editable without committing an invalid value', async () => {
    const editor = await openEditableFileSyncControls();
    const commits = vi.fn();
    bus.on('sync:set-manual-offset', commits);

    editor.focus();
    editor.textContent = '+';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(commits).not.toHaveBeenCalled();
    expect(editor.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(editor);
  });

  it('waits for IME composition before normalizing and committing', async () => {
    const editor = await openEditableFileSyncControls();
    const commits = vi.fn();
    bus.on('sync:set-manual-offset', commits);

    editor.focus();
    editor.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    editor.textContent = '＋１２３';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    const composingDone = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertLineBreak',
      isComposing: true,
    });
    editor.dispatchEvent(composingDone);
    expect(composingDone.defaultPrevented).toBe(true);
    expect(commits).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);

    editor.dispatchEvent(new Event('compositionend', { bubbles: true }));
    expect(editor.textContent).toBe('+123');
    editor.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertLineBreak',
      }),
    );

    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledWith(123);
  });

  it('blocks guest YouTube sync while zero-start owns the iframe', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    zeroStartFacade.active = true;
    zeroStartFacade.inFlight = true;

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(guestRendezvousSync).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('preserves the standard-host canonical rendezvous before opening local controls', async () => {
    renderSyncControls();
    setActiveStandardHost();
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();
    document.getElementById('btn-sync')?.click();
    await settleManualSyncOverlayOpen();

    expect(broadcastYouTubeSync).toHaveBeenCalledWith(true);
    expect(guestRendezvousSync).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not expose host nudge controls while a stale setup host has no active room', () => {
    renderSyncControls();
    setState('network.appRole', 'host');
    setState('network.sessionCode', '123456');
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();
    const button = document.getElementById('btn-sync') as HTMLButtonElement;

    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();

    expect(broadcastYouTubeSync).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('does not report a host sync success while zero-start is active', () => {
    renderSyncControls();
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    zeroStartFacade.active = true;
    zeroStartFacade.inFlight = true;

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(broadcastYouTubeSync).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('keeps host Sync fenced through calibration, then repaints at protocol idle', async () => {
    renderSyncControls();
    document.body.insertAdjacentHTML(
      'beforeend',
      '<input id="seek-slider" type="range" value="0" max="120" />',
    );
    setActiveStandardHost();
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    zeroStartFacade.active = true;
    zeroStartFacade.inFlight = true;

    initPlayerControls();
    const button = document.getElementById('btn-sync') as HTMLButtonElement;
    const playButton = document.getElementById('play-btn') as HTMLButtonElement;
    const seekSlider = document.getElementById('seek-slider') as HTMLInputElement;
    bus.emit('youtube:sync-loading', true, 'zero-start');

    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(playButton.classList.contains('is-loading')).toBe(true);
    expect(playButton.getAttribute('aria-busy')).toBe('true');
    expect(seekSlider.getAttribute('aria-disabled')).toBe('true');

    zeroStartFacade.inFlight = false;
    bus.emit('youtube:sync-loading', false, 'zero-start');

    expect(zeroStartFacade.active).toBe(true);
    expect(playButton.classList.contains('is-loading')).toBe(false);
    expect(playButton.getAttribute('aria-busy')).toBe('false');
    expect(seekSlider.getAttribute('aria-disabled')).toBe('false');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    await settleManualSyncOverlayOpen();
    expect(broadcastYouTubeSync).not.toHaveBeenCalled();

    zeroStartFacade.active = false;
    bus.emit('youtube:zero-start-readiness-changed');

    expect(button.getAttribute('aria-disabled')).toBe('false');
    button.click();
    await settleManualSyncOverlayOpen();
    expect(broadcastYouTubeSync).toHaveBeenCalledWith(true);
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
  });

  it('reconciles an equal PRO participant before opening the local YouTube nudge panel', async () => {
    renderSyncControls();
    setState('network.appRole', 'host');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    await vi.waitFor(() => {
      expect(proPlaybackRuntime.reconcile).toHaveBeenCalledTimes(1);
      expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
    });
    expect(broadcastYouTubeSync).not.toHaveBeenCalled();
    expect(guestRendezvousSync).not.toHaveBeenCalled();
  });

  it('shows one PRO synchronization request as pending until reconciliation settles', async () => {
    renderSyncControls();
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    let resolveReconciliation!: (value: boolean) => void;
    proPlaybackRuntime.reconcile.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveReconciliation = resolve;
      }),
    );

    initPlayerControls();
    const button = document.getElementById('btn-sync') as HTMLButtonElement;
    button.click();
    await vi.waitFor(() => expect(proPlaybackRuntime.reconcile).toHaveBeenCalledTimes(1));

    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toBe('Syncing…');
    expect(button.querySelector('span')?.getAttribute('data-i18n')).toBe('player.syncing_compact');
    expect(button.getAttribute('aria-label')).toBe('Syncing...');
    expect(button.getAttribute('data-i18n-aria-label')).toBe('toast.yt_sync_start');

    resolveReconciliation(true);
    await vi.waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'));

    expect(button.getAttribute('aria-disabled')).toBe('false');
    expect(button.textContent).toBe('Sync');
    expect(button.querySelector('span')?.getAttribute('data-i18n')).toBe('player.sync_compact');
    expect(button.getAttribute('aria-label')).toBe('Sync');
    expect(button.getAttribute('data-i18n-aria-label')).toBe('common.sync');
  });

  it('keeps the PRO nudge panel closed when server reconciliation cannot realign media', async () => {
    renderSyncControls();
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    proPlaybackRuntime.reconcile.mockResolvedValueOnce(false);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    await vi.waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
    });
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
  });

  it('does not surface a stale PRO reconciliation failure after switching rooms', async () => {
    renderSyncControls();
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    let rejectReconciliation!: (error: Error) => void;
    proPlaybackRuntime.reconcile.mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectReconciliation = reject;
      }),
    );

    initPlayerControls();
    document.getElementById('btn-sync')?.click();
    await vi.waitFor(() => expect(proPlaybackRuntime.reconcile).toHaveBeenCalledTimes(1));

    setState('room.context', {
      kind: 'pro',
      roomId: '000002',
      role: 'member',
      coordinatorId: null,
      epoch: 2,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    rejectReconciliation(new Error('old room request failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(showToast).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
  });

  it('keeps the PRO participant nudge panel closed during zero-start', () => {
    renderSyncControls();
    setState('network.appRole', 'host');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    zeroStartFacade.active = true;
    zeroStartFacade.inFlight = true;

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('does not treat a closed YouTube host connection as either host or guest sync', () => {
    renderSyncControls();
    setState('network.hostConn', { peer: 'host-1', open: false } as DataConnection);
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(broadcastYouTubeSync).not.toHaveBeenCalled();
    expect(guestRendezvousSync).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('opens a local-file nudge panel without broadcasting when the playing host presses sync', async () => {
    renderSyncControls();
    setActiveStandardHost();
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', PLAY_QUEUE_ITEM_ID);
    setState('player.pausedAt', 42);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const broadcastSpy = vi.fn();
    bus.on('network:broadcast', broadcastSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();
    await settleManualSyncOverlayOpen();

    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('keeps an active standard-host file sync disabled until its buffer is resident', () => {
    renderSyncControls();
    setActiveStandardHost();
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', PLAY_QUEUE_ITEM_ID);

    initPlayerControls();
    const button = document.getElementById('btn-sync') as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');

    button.click();

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('reconciles a PRO file endpoint before opening its local nudge panel', async () => {
    renderSyncControls();
    setState('network.appRole', 'host');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', PLAY_QUEUE_ITEM_ID);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const broadcastSpy = vi.fn();
    bus.on('network:broadcast', broadcastSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    await vi.waitFor(() => {
      expect(proPlaybackRuntime.reconcile).toHaveBeenCalledTimes(1);
      expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
    });
    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('keeps a paused host nudge local instead of rebasing the room position', async () => {
    renderSyncControls();
    setActiveStandardHost();
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    setState('playlist.currentQueueItemId', PAUSE_QUEUE_ITEM_ID);
    setState('player.pausedAt', 33);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const broadcastSpy = vi.fn();
    bus.on('network:broadcast', broadcastSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();
    await settleManualSyncOverlayOpen();

    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
  });

  it('runs one local-file resync before opening the guest manual sync panel', async () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('sync.localOffset', 0.12);
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
    const forceResyncSpy = vi.fn();
    bus.on('sync:force-resync', forceResyncSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();
    await settleManualSyncOverlayOpen();

    expect(forceResyncSpy).toHaveBeenCalledTimes(1);
    expect(getState('sync.localOffset')).toBe(0.12);
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);
  });

  it('does not open the local-file manual panel before the guest has a decoded buffer', () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    const forceResyncSpy = vi.fn();
    bus.on('sync:force-resync', forceResyncSpy);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();

    expect(forceResyncSpy).not.toHaveBeenCalled();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Not ready yet.\nTry again in a moment');
  });

  it('closes the local-file manual panel if the decoded buffer is cleared', async () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    initPlayerControls();
    document.getElementById('btn-sync')?.click();
    await settleManualSyncOverlayOpen();
    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(true);

    setCurrentAudioBuffer(null);

    expect(document.getElementById('manual-sync-overlay')?.classList.contains('show')).toBe(false);
  });

  it.each(['composing', 'legacy', 'editor-state'])(
    'keeps the manual draft during %s IME Escape',
    async (mode) => {
      renderSyncControls();
      setState('network.hostConn', makeConnection('host-1'));
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
      initPlayerControls();
      document.getElementById('btn-sync')!.focus();
      document.getElementById('btn-sync')!.click();
      await settleManualSyncOverlayOpen();
      const input = document.getElementById('manual-sync-value')!;
      input.focus();
      input.textContent = '１';
      if (mode === 'editor-state') input.dispatchEvent(new Event('compositionstart'));
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          isComposing: mode === 'composing',
          keyCode: mode === 'legacy' ? 229 : 0,
          bubbles: true,
        }),
      );
      expect(document.getElementById('manual-sync-overlay')!.classList.contains('show')).toBe(true);
      expect(input.textContent).toBe('１');
      if (mode === 'editor-state') input.dispatchEvent(new Event('compositionend'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(document.getElementById('manual-sync-overlay')!.classList.contains('show')).toBe(
        false,
      );
      expect(document.activeElement).toBe(document.getElementById('btn-sync'));
    },
  );

  it('makes the manual panel modal, traps Tab, closes on Escape, and restores focus', async () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    const trigger = document.getElementById('btn-sync') as HTMLButtonElement;
    const overlay = document.getElementById('manual-sync-overlay')!;
    const first = document.getElementById('manual-sync-value') as HTMLElement;
    const done = document.getElementById('btn-sync-done') as HTMLButtonElement;
    trigger.focus();

    initPlayerControls();
    trigger.click();
    await settleManualSyncOverlayOpen();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(overlay.classList.contains('show')).toBe(true);
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(trigger.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(done);

    done.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(done);

    done.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay.classList.contains('show')).toBe(false);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(trigger.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('routes the Done event through the shared manual-overlay close path', async () => {
    renderSyncControls();
    setState('network.hostConn', makeConnection('host-1'));
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);

    const trigger = document.getElementById('btn-sync') as HTMLButtonElement;
    const overlay = document.getElementById('manual-sync-overlay')!;
    trigger.focus();
    initPlayerControls();
    trigger.click();
    await settleManualSyncOverlayOpen();

    bus.emit('sync:close-manual');

    expect(overlay.classList.contains('show')).toBe(false);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(trigger);
  });
});

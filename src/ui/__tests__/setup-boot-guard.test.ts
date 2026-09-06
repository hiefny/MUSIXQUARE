// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../i18n/en.ts';
import { failOpenSetupBootGuard } from '../setup-boot-guard.ts';

// Keep the setup orchestrator, its DOM updates, and the transition adapter real.
// The only deferred UI boundary below is the browser's native update callback.
vi.mock('../../core/capability.ts', () => ({ cancelCapabilityChallenge: vi.fn() }));
vi.mock('../../core/platform.ts', () => ({
  onCompactLandscapeChange: vi.fn(),
  isCompactLandscape: vi.fn(() => false),
}));
vi.mock('../../network/peer.ts', () => ({
  cancelPendingSessionSetup: vi.fn(),
  joinSession: vi.fn(),
}));
vi.mock('../../network/standard-room-prerequisites.ts', () => ({
  scheduleStandardRoomPrerequisiteWarmup: vi.fn(),
}));
vi.mock('../../core/session-reset.ts', () => ({
  scheduleDocumentReload: vi.fn(),
  scheduleSessionReset: vi.fn(),
}));
vi.mock('../../player/ownership.ts', () => ({
  isPlaybackModeYouTube: vi.fn(() => false),
}));
vi.mock('../../core/wake-lock.ts', () => ({ activateNoSleep: vi.fn() }));
vi.mock('../../i18n/index.ts', async () => {
  const { default: en } = await import('../../i18n/en.ts');
  return {
    t: (key: keyof typeof en, params?: Record<string, string | number>) =>
      en[key]?.replace(/\{(\w+)\}/gu, (placeholder, name: string) =>
        params?.[name] === undefined ? placeholder : String(params[name]),
      ),
    getResolvedLanguage: () => 'en',
    synchronizeCurrentLocalizedAppHead: vi.fn(),
  };
});
vi.mock('../toast.ts', () => ({ showToast: vi.fn(), showLoader: vi.fn() }));
vi.mock('../dialog.ts', () => ({ showDialog: vi.fn() }));
vi.mock('../player-controls.ts', () => ({
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  showPlacementToastForChannel: vi.fn(),
}));
vi.mock('../settings.ts', () => ({
  openLanguageDialog: vi.fn(),
  selectStandardChannelButton: vi.fn(),
}));
vi.mock('../setup-host.ts', () => ({ startHostFlow: vi.fn(), setHostGoBack: vi.fn() }));
vi.mock('../../youtube/player.ts', () => ({ precreateYouTubePlayer: vi.fn() }));
vi.mock('../../pro-room/setup-flow.ts', () => ({ enterProRoomFromSetup: vi.fn() }));
vi.mock('../setup-start.ts', () => ({ prepareSetupStartFromGesture: vi.fn() }));
vi.mock('../setup-qr-scanner.ts', () => ({
  initGuestQrScanner: vi.fn(),
  stopGuestQrScanner: vi.fn(),
}));
vi.mock('../onboarding-diagnostics.ts', () => ({
  initOnboardingDiagnostics: vi.fn(),
  openOnboardingDiagnostics: vi.fn(),
}));

describe('setup boot guard failure recovery', () => {
  let queuedFrame: FrameRequestCallback | undefined;

  beforeEach(() => {
    document.documentElement.className = 'setup-boot-block';
    document.body.innerHTML = `
      <div id="setup-overlay"></div>
      <nav class="app-entrance app-entrance-up" style="--entrance-delay: 400ms"></nav>
    `;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        queuedFrame = callback;
        return 1;
      }),
    );
  });

  afterEach(() => {
    queuedFrame = undefined;
    vi.unstubAllGlobals();
    document.documentElement.className = '';
    document.body.innerHTML = '';
  });

  it('waits one frame, retires prepared entrance motion, and restores a visible failure surface', () => {
    failOpenSetupBootGuard();

    expect(document.documentElement.classList.contains('setup-boot-block')).toBe(true);
    queuedFrame?.(0);

    const nav = document.querySelector<HTMLElement>('nav');
    expect(document.documentElement.classList.contains('setup-boot-block')).toBe(false);
    expect(document.documentElement.classList.contains('setup-boot-failed')).toBe(true);
    expect(nav?.classList.contains('app-entrance')).toBe(false);
    expect(nav?.classList.contains('app-entrance-up')).toBe(false);
    expect(nav?.style.getPropertyValue('--entrance-delay')).toBe('');
  });

  it('keeps the guard handoff untouched when the queued setup overlay wins first', () => {
    failOpenSetupBootGuard();
    document.getElementById('setup-overlay')?.classList.add('active');
    queuedFrame?.(0);

    expect(document.documentElement.classList.contains('setup-boot-block')).toBe(true);
    expect(document.documentElement.classList.contains('setup-boot-failed')).toBe(false);
    expect(document.querySelector('nav')?.classList.contains('app-entrance')).toBe(true);
    expect(document.querySelector('nav')?.classList.contains('app-entrance-up')).toBe(true);
  });

  it('falls back synchronously when a host cannot schedule animation frames', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => {
        throw new Error('unavailable');
      }),
    );

    failOpenSetupBootGuard();

    expect(document.documentElement.classList.contains('setup-boot-block')).toBe(false);
    expect(document.documentElement.classList.contains('setup-boot-failed')).toBe(true);
  });
});

describe('first setup paint with a deferred native View Transition', () => {
  const markup = readFileSync('index.html', 'utf8');
  let transitionDescriptor: PropertyDescriptor | undefined;
  let pendingUpdates: Array<() => void>;
  let startViewTransition: ReturnType<typeof vi.fn>;
  let setup: typeof import('../setup.ts');
  let shared: typeof import('../setup-shared.ts');
  let dom: typeof import('../dom.ts');
  let events: typeof import('../../core/events.ts');
  const listeners: Array<{
    type: string;
    callback: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
  }> = [];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    document.body.innerHTML = parsed.body.innerHTML;
    document.documentElement.className = 'setup-boot-block';
    vi.stubGlobal(
      'matchMedia',
      vi.fn((media: string) => ({
        media,
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );

    // Dispose the real overlay guard's document listeners between fresh modules.
    const addEventListener = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type, callback, options) => {
      listeners.push({ type, callback, options });
      addEventListener(type, callback, options);
    });
    pendingUpdates = [];
    transitionDescriptor = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
    startViewTransition = vi.fn((update: () => void) => {
      const done = new Promise<void>((resolve, reject) => {
        pendingUpdates.push(() => {
          try {
            update();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      return { ready: done, finished: done, updateCallbackDone: done };
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    });
    events = await import('../../core/events.ts');
    (await import('../../core/state.ts')).resetState();
    dom = await import('../dom.ts');
    shared = await import('../setup-shared.ts');
    setup = await import('../setup.ts');
    dom.initOverlayObservers();
  });

  afterEach(() => {
    shared?.getSetupOverlayAbort()?.abort();
    events?.bus.clear();
    dom?.__resetModalStackForTests();
    for (const { type, callback, options } of listeners.splice(0)) {
      document.removeEventListener(type, callback, options);
    }
    if (transitionDescriptor) {
      Object.defineProperty(document, 'startViewTransition', transitionDescriptor);
    } else {
      Reflect.deleteProperty(document, 'startViewTransition');
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.documentElement.className = '';
    document.body.innerHTML = '';
  });

  it('prepares welcome and reveals the first overlay before any native update callback', async () => {
    setup.initSetup();

    expect(document.getElementById('setup-welcome-area')?.style.display).toBe('flex');
    for (const id of [
      'setup-code-area',
      'setup-join-area',
      'setup-auto-join-area',
      'setup-role-area',
    ]) {
      expect(document.getElementById(id)?.style.display).toBe('none');
    }
    expect(document.getElementById('btn-setup-host')?.textContent).toBe(en['setup.host_button']);
    expect(document.getElementById('btn-setup-guest')?.textContent).toBe(en['setup.guest_button']);
    expect(document.getElementById('setup-overlay')?.classList.contains('active')).toBe(true);
    expect(document.documentElement.classList.contains('setup-boot-block')).toBe(false);
    expect(document.body.classList.contains('overlay-open')).toBe(true);
    expect(document.body.classList.contains('fouc-loaded')).toBe(true);

    // Let the real MutationObserver project modal ownership, without releasing
    // a frame, timer, or native transition callback.
    await Promise.resolve();
    expect(document.getElementById('setup-overlay')?.getAttribute('aria-hidden')).toBe('false');
    expect(document.getElementById('setup-overlay')?.hasAttribute('inert')).toBe(false);
    expect(document.getElementById('main-header')?.hasAttribute('inert')).toBe(true);
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it('reveals the actual invite guest screen together after its existing 200ms route delay', async () => {
    window.history.replaceState({}, '', '/123456');
    setup.initSetup();
    expect(document.getElementById('setup-overlay')?.classList.contains('active')).toBe(false);
    vi.advanceTimersByTime(199);
    expect(document.getElementById('setup-overlay')?.classList.contains('active')).toBe(false);
    vi.advanceTimersByTime(1);

    expect(document.getElementById('setup-overlay')?.classList.contains('active')).toBe(true);
    expect(document.documentElement.classList.contains('setup-boot-block')).toBe(false);
    expect(document.getElementById('setup-auto-join-area')?.style.display).toBe('flex');
    expect(document.getElementById('setup-welcome-area')?.style.display).toBe('none');
    expect(document.getElementById('setup-join-area')?.style.display).toBe('none');
    expect(document.getElementById('setup-auto-join-subtitle')?.textContent).toContain('123456');
    expect(document.getElementById('btn-setup-confirm')?.textContent).toBe(en['common.start']);
    await Promise.resolve();
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.getElementById('setup-overlay')?.getAttribute('aria-hidden')).toBe('false');
    expect(document.getElementById('main-header')?.hasAttribute('inert')).toBe(true);
  });

  it('retains native transitions when an existing onboarding flow returns to welcome', async () => {
    setup.initSetup();
    await Promise.resolve();
    for (const update of pendingUpdates.splice(0)) update();
    await Promise.resolve();
    shared.setupShowWelcome(false);
    shared.setupShowCodeArea(true);
    startViewTransition.mockClear();
    const { setHostGoBack } = await import('../setup-host.ts');
    const goBack = vi.mocked(setHostGoBack).mock.calls[0]?.[0];
    expect(goBack).toBeTypeOf('function');
    goBack?.();

    expect(document.getElementById('setup-code-area')?.style.display).toBe('flex');
    expect(document.getElementById('setup-welcome-area')?.style.display).toBe('none');
    await Promise.resolve();
    expect(startViewTransition).toHaveBeenCalledOnce();
    for (const update of pendingUpdates.splice(0)) update();
    await Promise.resolve();
    expect(document.getElementById('setup-code-area')?.style.display).toBe('none');
    expect(document.getElementById('setup-welcome-area')?.style.display).toBe('flex');
    expect(document.getElementById('setup-overlay')?.classList.contains('active')).toBe(true);
  });

  it('does not replace an existing terminal failure with the first setup overlay', async () => {
    document.documentElement.className = 'setup-boot-failed';
    document.body.classList.add('fouc-loaded');
    setup.initSetup();
    await Promise.resolve();
    for (const update of pendingUpdates.splice(0)) update();
    await Promise.resolve();

    expect(document.documentElement.classList.contains('setup-boot-failed')).toBe(true);
    expect(document.getElementById('setup-overlay')?.classList.contains('active')).toBe(false);
    expect(document.getElementById('bootstrap-failure')?.hasAttribute('inert')).toBe(false);
    expect(document.body.classList.contains('overlay-open')).toBe(false);
  });

  it('keeps a terminal failure in charge when a later overlay update arrives', async () => {
    setup.initSetup();
    await Promise.resolve();
    for (const update of pendingUpdates.splice(0)) update();
    await Promise.resolve();
    shared.hideSetupOverlay();
    shared.showSetupOverlay();
    await Promise.resolve();
    expect(pendingUpdates).toHaveLength(1);
    document.documentElement.classList.add('setup-boot-failed');
    document.documentElement.classList.remove('setup-boot-block');
    for (const update of pendingUpdates.splice(0)) update();
    await Promise.resolve();

    expect(document.getElementById('setup-overlay')?.classList.contains('active')).toBe(false);
    expect(document.documentElement.classList.contains('setup-boot-failed')).toBe(true);
    expect(document.getElementById('bootstrap-failure')?.hasAttribute('inert')).toBe(false);
    expect(document.body.classList.contains('overlay-open')).toBe(false);
  });
});

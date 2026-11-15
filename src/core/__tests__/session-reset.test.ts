/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_SPLASH_CONTINUITY_KEY } from '../navigation-contract.ts';
import { stubNavigationSinks } from './__helpers__/navigation-sinks.ts';

const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;
type Coordinator = typeof import('../session-reset.ts');

describe('session reset coordinator', () => {
  let coordinator: Coordinator | null;
  let lifecycle: { dispose(): void } | null;

  async function loadCoordinator(): Promise<Coordinator> {
    coordinator = await import('../session-reset.ts');
    // The real page-lifecycle of the same module graph: its beforeunload
    // handler shows whether the owner holds an unload-exemption claim.
    const pageLifecycle = await import('../page-lifecycle.ts');
    lifecycle ??= pageLifecycle.initPageLifecycleHandlers({
      getRole: () => 'host',
      leaveSession: () => undefined,
    });
    return coordinator;
  }

  /** Whether a beforeunload in this room asks to confirm (no exemption held). */
  function unloadPrompts(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    coordinator = null;
    lifecycle = null;
    document.documentElement.className = '';
    document.body.innerHTML = '<main id="app"><button id="control">Control</button></main>';
  });

  afterEach(() => {
    coordinator?.__resetPageNavigationForTests();
    lifecycle?.dispose();
    // Vitest 5 forwards these descriptors to the DOM window. Fake-timer teardown
    // must still be able to restore the writable native animation APIs.
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalCancelAnimationFrame,
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('blocks the document immediately and waits for an overlay paint before reset', async () => {
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    });
    const action = vi.fn();
    const shortcutHandler = vi.fn();
    window.addEventListener('keydown', shortcutHandler);
    const control = document.getElementById('control') as HTMLButtonElement;
    control.focus();
    const { scheduleSessionReset } = await loadCoordinator();

    scheduleSessionReset('Refreshing session...', action);

    const overlay = document.getElementById('session-reset-overlay') as HTMLElement;
    expect(overlay.hidden).toBe(false);
    expect(overlay.classList.contains('show')).toBe(true);
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(document.getElementById('session-reset-message')?.textContent).toBe(
      'Refreshing session...',
    );
    expect(overlay.querySelector('.session-reset-spinner')).toBeNull();
    expect(overlay.children).toHaveLength(1);
    expect((document.getElementById('app') as HTMLElement).inert).toBe(true);
    expect(document.documentElement.classList.contains('session-reset-pending')).toBe(true);
    expect(action).not.toHaveBeenCalled();

    const keyEvent = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(keyEvent);
    expect(keyEvent.defaultPrevented).toBe(true);
    expect(shortcutHandler).not.toHaveBeenCalled();
    window.removeEventListener('keydown', shortcutHandler);

    frames.shift()?.(0);
    expect(action).not.toHaveBeenCalled();
    expect(unloadPrompts()).toBe(true);
    frames.shift()?.(16);

    expect(unloadPrompts()).toBe(false);
    expect(action).toHaveBeenCalledOnce();
  });

  it('uses a native timeout fallback and accepts only the first reset request', async () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const firstAction = vi.fn();
    const secondAction = vi.fn();
    const { scheduleSessionReset } = await loadCoordinator();

    const firstHandle = scheduleSessionReset('First', firstAction);
    const rejectedHandle = scheduleSessionReset('Second', secondAction);
    vi.advanceTimersByTime(120);

    expect(firstAction).toHaveBeenCalledOnce();
    expect(secondAction).not.toHaveBeenCalled();
    expect(firstHandle).not.toBeNull();
    expect(rejectedHandle).toBeNull();
    expect(document.getElementById('session-reset-message')?.textContent).toBe('First');
    expect(unloadPrompts()).toBe(false);
  });

  /**
   * The screen's own fade-in, as style.css gives `.session-reset-overlay.show`
   * (0.2 s), or another computed transition, or one that throws when read.
   */
  function stubResetFadeIn(
    fadeIn: Readonly<Record<string, string>> | 'unreadable' = {
      transitionProperty: 'opacity, visibility',
      transitionDuration: '0.2s, 0s',
      transitionDelay: '0s, 0s',
    },
  ): void {
    const computed = window.getComputedStyle.bind(window);
    const transitionNames = ['transitionProperty', 'transitionDuration', 'transitionDelay'];
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = computed(element, pseudo);
      if (!(element instanceof HTMLElement) || element.id !== 'session-reset-overlay') return style;
      return new Proxy(style, {
        get(target, property) {
          if (typeof property === 'string' && transitionNames.includes(property)) {
            if (fadeIn === 'unreadable') throw new Error('computed style unavailable');
            if (property in fadeIn) return fadeIn[property];
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
  }

  /** Animation frames the test runs by hand. */
  function useFrames(): FrameRequestCallback[] {
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    });
    return frames;
  }

  it("starts the action only once the screen's fade-in has run, so the next page continues a whole screen", async () => {
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    });
    stubResetFadeIn();
    const action = vi.fn();
    const { scheduleSessionReset } = await loadCoordinator();

    scheduleSessionReset('Refreshing session...', action);
    frames.shift()?.(0);
    frames.shift()?.(16);
    // Painted, but still fading in: the next page would replace a half-shown screen.
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledOnce();
    expect(unloadPrompts()).toBe(false);
  });

  it('waits out the fade-in in the timeout fallback too, and runs the action once', async () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    stubResetFadeIn();
    const { RESET_PAINT_FALLBACK_MS } = await import('../navigation-contract.ts');
    const action = vi.fn();
    const { scheduleSessionReset } = await loadCoordinator();

    scheduleSessionReset('Refreshing session...', action);
    vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(action).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_000);
    expect(action).toHaveBeenCalledOnce();
  });

  /**
   * The overlay's running opacity transition as the Web Animations API reports
   * it: a null current time has not started, a null end time has no effect.
   */
  function stubFadeInClock(
    running: { currentTime: number | null; endTime: number | null } | null,
  ): void {
    const overlay = document.getElementById('session-reset-overlay') as HTMLElement;
    const fadeIn = running && {
      transitionProperty: 'opacity',
      currentTime: running.currentTime,
      effect:
        running.endTime === null
          ? null
          : { getComputedTiming: () => ({ endTime: running.endTime }) },
      finished: Promise.resolve(),
    };
    Object.defineProperty(overlay, 'getAnimations', {
      configurable: true,
      value: () => (fadeIn ? [fadeIn] : []),
    });
  }

  it("times that wait by the fade-in's own clock, which a busy page starts only at its first frame", async () => {
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    });
    stubResetFadeIn();
    const action = vi.fn();
    const { scheduleSessionReset } = await loadCoordinator();

    scheduleSessionReset('Refreshing session...', action);
    // WebKit measured: the page stayed busy 180 ms past the show, and the
    // fade-in started on the first frame after it.
    vi.advanceTimersByTime(180);
    stubFadeInClock({ currentTime: 20, endTime: 200 });
    frames.shift()?.(180);
    frames.shift()?.(200);
    // 200 ms have passed since the show, but 180 ms of the fade-in are left.
    vi.advanceTimersByTime(179);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_000);
    expect(action).toHaveBeenCalledOnce();
  });

  it('starts the action at once when the fade-in has already run by the second frame', async () => {
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    });
    stubResetFadeIn();
    const action = vi.fn();
    const { scheduleSessionReset } = await loadCoordinator();

    scheduleSessionReset('Refreshing session...', action);
    // WebKit can date the fade-in from the last frame before the show, so it
    // may have ended by the first frame the page renders.
    stubFadeInClock(null);
    frames.shift()?.(0);
    frames.shift()?.(16);
    expect(action).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'no opacity transition',
      { transitionProperty: 'visibility', transitionDuration: '0s', transitionDelay: '0s' },
    ],
    ['a transition it cannot read', 'unreadable'],
  ] as const)(
    'starts the action at the second frame when the screen has %s',
    async (_label, fadeIn) => {
      const frames = useFrames();
      stubResetFadeIn(fadeIn);
      const action = vi.fn();
      const { scheduleSessionReset } = await loadCoordinator();

      scheduleSessionReset('Refreshing session...', action);
      frames.shift()?.(0);
      expect(action).not.toHaveBeenCalled();
      frames.shift()?.(16);
      expect(action).toHaveBeenCalledOnce();
    },
  );

  it('reads a fade-in given in milliseconds', async () => {
    const frames = useFrames();
    stubResetFadeIn({
      transitionProperty: 'opacity',
      transitionDuration: '200ms',
      transitionDelay: '0ms',
    });
    const action = vi.fn();
    const { scheduleSessionReset } = await loadCoordinator();

    scheduleSessionReset('Refreshing session...', action);
    frames.shift()?.(0);
    frames.shift()?.(16);
    vi.advanceTimersByTime(199);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledOnce();
  });

  it('waits the whole fade-in when its transition has not started by the second frame', async () => {
    const frames = useFrames();
    stubResetFadeIn();
    const action = vi.fn();
    const { scheduleSessionReset } = await loadCoordinator();

    scheduleSessionReset('Refreshing session...', action);
    vi.advanceTimersByTime(50);
    stubFadeInClock({ currentTime: null, endTime: 200 });
    frames.shift()?.(50);
    frames.shift()?.(66);
    vi.advanceTimersByTime(199);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledOnce();
  });

  it("counts from the show when the transition's timing cannot be read", async () => {
    const frames = useFrames();
    stubResetFadeIn();
    const action = vi.fn();
    const { scheduleSessionReset } = await loadCoordinator();

    scheduleSessionReset('Refreshing session...', action);
    vi.advanceTimersByTime(50);
    stubFadeInClock({ currentTime: 20, endTime: null });
    frames.shift()?.(50);
    frames.shift()?.(66);
    // The computed 0.2 s from the show, as without the Web Animations API.
    vi.advanceTimersByTime(149);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledOnce();
  });

  it('ignores the frames of a reset that a returning page already ended', async () => {
    const frames = useFrames();
    stubResetFadeIn();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const action = vi.fn();
    const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();

    try {
      scheduleSessionReset('Leaving', action);
      window.dispatchEvent(new Event('pagehide'));
      vi.advanceTimersByTime(1_000);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(1_000);
      expect(isSessionResetPending()).toBe(false);

      // Frames the page asked for before it left still arrive.
      frames.shift()?.(0);
      frames.shift()?.(16);
      vi.advanceTimersByTime(1_000);
      expect(action).not.toHaveBeenCalled();
    } finally {
      if (originalVisibility) {
        Object.defineProperty(document, 'visibilityState', originalVisibility);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
    }
  });

  it('restores interaction and releases its unload exemption when the action throws', async () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const app = document.getElementById('app') as HTMLElement;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();

    const handle = scheduleSessionReset('Broken action', () => {
      throw new Error('navigation failed');
    });
    const recovered = vi.fn();
    handle?.onRecovered(recovered);

    expect(() => vi.advanceTimersByTime(120)).not.toThrow();
    expect(isSessionResetPending()).toBe(false);
    expect(app.inert).not.toBe(true);
    expect(document.getElementById('session-reset-overlay')?.hidden).toBe(true);
    expect(document.documentElement.classList.contains('session-reset-pending')).toBe(false);
    expect(unloadPrompts()).toBe(true);
    expect(recovered).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      '[SessionReset] Hard-navigation action failed:',
      expect.any(Error),
    );
  });

  it('does not treat beforeunload alone as a committed navigation', async () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();

    scheduleSessionReset('Maybe leaving', vi.fn());
    vi.advanceTimersByTime(120);
    window.dispatchEvent(new Event('beforeunload'));
    vi.advanceTimersByTime(2_000);

    expect(isSessionResetPending()).toBe(false);
    expect(unloadPrompts()).toBe(true);
  });

  it('recovers a no-op navigation and accepts a later reset request', async () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const firstAction = vi.fn();
    const secondAction = vi.fn();
    const app = document.getElementById('app') as HTMLElement;
    const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();

    const firstHandle = scheduleSessionReset('No-op', firstAction);
    const recovered = vi.fn();
    firstHandle?.onRecovered(recovered);
    vi.advanceTimersByTime(120);
    expect(isSessionResetPending()).toBe(true);

    vi.advanceTimersByTime(1_999);
    expect(isSessionResetPending()).toBe(true);
    vi.advanceTimersByTime(1);

    expect(isSessionResetPending()).toBe(false);
    expect(app.inert).not.toBe(true);
    expect(unloadPrompts()).toBe(true);
    expect(recovered).toHaveBeenCalledOnce();

    scheduleSessionReset('Retry', secondAction);
    vi.advanceTimersByTime(120);
    expect(secondAction).toHaveBeenCalledOnce();
  });

  it('keeps a committed navigation first-wins after pagehide', async () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const firstAction = vi.fn();
    const secondAction = vi.fn();
    const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();

    const handle = scheduleSessionReset('Leaving', firstAction);
    const recovered = vi.fn();
    handle?.onRecovered(recovered);
    vi.advanceTimersByTime(120);
    window.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(10_000);
    scheduleSessionReset('Ignored', secondAction);

    expect(isSessionResetPending()).toBe(true);
    expect(firstAction).toHaveBeenCalledOnce();
    expect(secondAction).not.toHaveBeenCalled();
    // The committed navigation keeps its exemption.
    expect(unloadPrompts()).toBe(false);
    expect(recovered).not.toHaveBeenCalled();
  });

  it('cancels a pre-action reset and recovers once when the old page returns', async () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const action = vi.fn();
    const recovered = vi.fn();
    const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
    const handle = scheduleSessionReset('Leaving', action);
    handle?.onRecovered(recovered);

    window.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(1_000);
    expect(action).not.toHaveBeenCalled();
    expect(isSessionResetPending()).toBe(true);

    window.dispatchEvent(new Event('pageshow'));
    vi.advanceTimersByTime(1_000);

    expect(action).not.toHaveBeenCalled();
    expect(isSessionResetPending()).toBe(false);
    expect(recovered).toHaveBeenCalledOnce();
  });

  it('cancels a pre-action reset when the returned page only becomes visible', async () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const action = vi.fn();
    const recovered = vi.fn();
    const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();

    try {
      const handle = scheduleSessionReset('Leaving', action);
      handle?.onRecovered(recovered);
      window.dispatchEvent(new Event('pagehide'));
      vi.advanceTimersByTime(1_000);

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(1_000);

      expect(action).not.toHaveBeenCalled();
      expect(isSessionResetPending()).toBe(false);
      expect(recovered).toHaveBeenCalledOnce();
    } finally {
      if (originalVisibility) {
        Object.defineProperty(document, 'visibilityState', originalVisibility);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
    }
  });

  it('restores a committed reset when Safari returns the old document via pageshow', async () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const app = document.getElementById('app') as HTMLElement;
    const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();

    const handle = scheduleSessionReset('Reloading', vi.fn());
    const recovered = vi.fn();
    handle?.onRecovered(recovered);
    vi.advanceTimersByTime(120);
    window.dispatchEvent(new Event('pagehide'));
    expect(isSessionResetPending()).toBe(true);
    expect(app.inert).toBe(true);

    window.dispatchEvent(new Event('pageshow'));

    expect(isSessionResetPending()).toBe(false);
    expect(app.inert).not.toBe(true);
    expect(document.getElementById('session-reset-overlay')?.hidden).toBe(true);
    expect(unloadPrompts()).toBe(true);
    expect(recovered).toHaveBeenCalledOnce();
  });

  it('restores a committed reset when iOS only foregrounds the old document', async () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: undefined,
    });
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();

    try {
      scheduleSessionReset('Reloading', vi.fn());
      vi.advanceTimersByTime(120);
      window.dispatchEvent(new Event('pagehide'));
      expect(isSessionResetPending()).toBe(true);

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(isSessionResetPending()).toBe(false);
      expect(document.getElementById('session-reset-overlay')?.hidden).toBe(true);
    } finally {
      if (originalVisibility) {
        Object.defineProperty(document, 'visibilityState', originalVisibility);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
    }
  });

  it('restores exact inert state and removes blockers during explicit cleanup', async () => {
    const alreadyInert = document.createElement('aside');
    alreadyInert.inert = true;
    document.body.append(alreadyInert);
    const app = document.getElementById('app') as HTMLElement;
    const control = document.getElementById('control') as HTMLButtonElement;
    control.focus();
    const shortcutHandler = vi.fn();
    window.addEventListener('keydown', shortcutHandler);
    const { __resetPageNavigationForTests, scheduleSessionReset } = await loadCoordinator();

    scheduleSessionReset('Cleanup', vi.fn());
    const overlay = document.getElementById('session-reset-overlay') as HTMLElement;
    const focusControl = control.focus.bind(control);
    const focusSpy = vi.spyOn(control, 'focus').mockImplementation((options?: FocusOptions) => {
      expect(overlay.hidden).toBe(false);
      focusControl(options);
    });
    __resetPageNavigationForTests();

    expect(app.inert).not.toBe(true);
    expect(alreadyInert.inert).toBe(true);
    expect(focusSpy).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(control);
    expect(overlay.hidden).toBe(true);
    const keyEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    window.dispatchEvent(keyEvent);
    expect(keyEvent.defaultPrevented).toBe(false);
    expect(shortcutHandler).toHaveBeenCalledOnce();
    window.removeEventListener('keydown', shortcutHandler);
  });

  // Owner decision 2026-11-15: the reset screen is the boot splash's wordmark
  // and loader in their final place, with no visible text, and the page the
  // reset opens continues them (browser/classic-runtime/wordmark-anim.ts).
  describe('the reset screen continues the boot splash', () => {
    const CONTINUITY_KEY = BOOT_SPLASH_CONTINUITY_KEY;
    // The splash as the reset finds it after boot: drawn, faded out, hidden.
    const SPLASH = `<div class="boot-splash" aria-hidden="true" hidden>
      <div class="boot-splash-mark">
        <svg class="boot-splash-logo" viewBox="43 12 214 24" aria-hidden="true" focusable="false"
          data-wordmark-ready="true" data-wordmark-draw-complete="true">
          <g class="wg" mask="url(#reveal)"><rect x="43" y="12" width="4" height="10"></rect><rect x="47" y="12" width="6" height="4"></rect></g>
          <defs><mask id="reveal"></mask><g data-wordmark-strokes></g></defs>
        </svg>
        <span class="boot-splash-spinner" aria-hidden="true"><svg viewBox="0 0 44 44" focusable="false"><circle cx="22" cy="22" r="18"></circle></svg></span>
      </div>
    </div>`;

    beforeEach(() => {
      sessionStorage.clear();
      vi.setSystemTime(1_000_000);
      document.body.insertAdjacentHTML('afterbegin', SPLASH);
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: undefined,
      });
    });

    afterEach(() => {
      sessionStorage.clear();
    });

    it("furnishes the page's own overlay with the splash's wordmark and loader, once", async () => {
      // index.html as shipped: its splash and its static reset overlay.
      const page = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
      const splash = page.querySelector('.boot-splash');
      const shipped = page.getElementById('session-reset-overlay');
      expect(splash).not.toBeNull();
      expect(shipped).not.toBeNull();
      document.body.innerHTML = '<main id="app"><button id="control">Control</button></main>';
      document.body.prepend(document.importNode(splash!, true));
      document.body.append(document.importNode(shipped!, true));
      const { scheduleSessionReset, __resetPageNavigationForTests } = await loadCoordinator();

      for (const message of ['Refreshing session...', 'Leaving session...']) {
        scheduleSessionReset(message, vi.fn());
        const overlays = document.querySelectorAll('.session-reset-overlay');
        expect(overlays).toHaveLength(1);
        const mark = overlays[0]!.querySelector('.session-reset-mark') as HTMLElement;
        expect([...overlays[0]!.children]).toEqual([mark]);
        expect([...mark.children].map((child) => child.getAttribute('class'))).toEqual([
          'session-reset-wordmark',
          'boot-splash-spinner',
          'session-reset-message sr-only',
        ]);
        expect(document.getElementById('session-reset-message')?.textContent).toBe(message);
        const wordmark = mark.querySelector('svg.session-reset-wordmark') as SVGSVGElement;
        expect(wordmark.querySelector('defs, mask')).toBeNull();
        expect(wordmark.querySelectorAll('.wg > *')).toHaveLength(12);
        expect(wordmark.getAttribute('aria-hidden')).toBe('true');
        expect(wordmark.getAttribute('overflow')).toBe('visible');
        __resetPageNavigationForTests();
      }
    });

    it("shows the splash's wordmark and loader, with its message for screen readers only", async () => {
      const { scheduleSessionReset } = await loadCoordinator();
      scheduleSessionReset('Refreshing session...', vi.fn());

      const overlay = document.getElementById('session-reset-overlay') as HTMLElement;
      const mark = overlay.querySelector('.session-reset-mark') as HTMLElement;
      expect([...overlay.children]).toEqual([mark]);
      expect([...mark.children].map((child) => child.getAttribute('class'))).toEqual([
        'session-reset-wordmark',
        'boot-splash-spinner',
        'session-reset-message sr-only',
      ]);
      expect(document.getElementById('session-reset-message')?.textContent).toBe(
        'Refreshing session...',
      );
      const wordmark = mark.querySelector('svg.session-reset-wordmark') as SVGSVGElement;
      // Drawn whole: no reveal geometry, mask or runtime state.
      expect(wordmark.querySelector('defs, mask')).toBeNull();
      expect(wordmark.querySelector('.wg')?.hasAttribute('mask')).toBe(false);
      expect(wordmark.hasAttribute('data-wordmark-ready')).toBe(false);
      expect(wordmark.hasAttribute('data-wordmark-draw-complete')).toBe(false);
      expect(wordmark.querySelectorAll('.wg > rect')).toHaveLength(2);
      expect(wordmark.getAttribute('viewBox')).toBe('43 12 214 24');
      // The live status region announces the message, not the pictures.
      expect(wordmark.getAttribute('aria-hidden')).toBe('true');
      expect(mark.querySelector('.boot-splash-spinner')?.getAttribute('aria-hidden')).toBe('true');
      // The splash itself is left as it was.
      const splashLogo = document.querySelector('.boot-splash .boot-splash-logo') as SVGSVGElement;
      expect(splashLogo.querySelector('defs')).not.toBeNull();
      expect(splashLogo.querySelector('.wg')?.getAttribute('mask')).toBe('url(#reveal)');
    });

    it('builds the screen once and keeps only its message when the splash is missing', async () => {
      document.querySelector('.boot-splash')?.remove();
      const { scheduleSessionReset } = await loadCoordinator();
      scheduleSessionReset('Leaving session...', vi.fn());
      const mark = document.querySelector('#session-reset-overlay .session-reset-mark');
      expect([...(mark?.children ?? [])].map((child) => child.id)).toEqual([
        'session-reset-message',
      ]);
    });

    it("runs the loader on the wall clock's phase, as the next page's splash does", async () => {
      const original = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
        if (element.closest('#session-reset-overlay') && element.localName === 'svg') {
          return { animationDuration: '1.85s' } as CSSStyleDeclaration;
        }
        if (element.closest('#session-reset-overlay') && element.localName === 'circle') {
          return { animationDuration: '1.45s' } as CSSStyleDeclaration;
        }
        return original(element, pseudo);
      });
      const { scheduleSessionReset } = await loadCoordinator();
      scheduleSessionReset('Refreshing session...', vi.fn());
      const loader = document.querySelector('#session-reset-overlay .boot-splash-spinner');
      // Without the Web Animations API (jsdom): an equivalent negative delay.
      // At 1 000 000 ms a 1 850 ms turn is 1 000 ms in and a 1 450 ms dash 950 ms in.
      expect(loader?.querySelector<SVGSVGElement>(':scope > svg')?.style.animationDelay).toBe(
        '-1000ms',
      );
      expect(loader?.querySelector<SVGCircleElement>('circle')?.style.animationDelay).toBe(
        '-950ms',
      );
    });

    it("sets the loader's running animations to the wall clock once shown, and again after a move", async () => {
      // Each element's CSS animation, as the Web Animations API reports it,
      // and a transition beside it that is not a loop to align.
      const animations = new Map<Element, { currentTime: number | null }>();
      const transitions = new Map<Element, { currentTime: number | null }>();
      Object.defineProperty(window.SVGElement.prototype, 'getAnimations', {
        configurable: true,
        value(this: SVGElement) {
          if (!this.closest('#session-reset-overlay')) return [];
          const duration = this.localName === 'svg' ? 1850 : 1450;
          let animation = animations.get(this);
          if (!animation) {
            animation = Object.assign(
              { animationName: duration === 1850 ? 'boot-splash-spin' : 'boot-splash-dash' },
              { currentTime: null, effect: { getTiming: () => ({ duration }) } },
            );
            animations.set(this, animation);
          }
          let transition = transitions.get(this);
          if (!transition) {
            transition = Object.assign(
              { transitionProperty: 'opacity' },
              { currentTime: null, effect: { getTiming: () => ({ duration: 200 }) } },
            );
            transitions.set(this, transition);
          }
          return [animation, transition];
        },
      });
      // The splash of a page a reset opened: bootstrap.js left its loader on
      // the wall clock with a negative delay, which the copy must not keep.
      document
        .querySelectorAll<SVGElement>(
          '.boot-splash .boot-splash-spinner > svg, .boot-splash .boot-splash-spinner circle',
        )
        .forEach((element) => {
          element.style.animationDelay = '-700ms';
        });
      try {
        const { scheduleSessionReset, setSessionResetWindowLayer } = await loadCoordinator();
        // A fullscreen host that appears while the reset holds the page.
        let host: HTMLElement | null = null;
        let hostChanged = (): void => undefined;
        setSessionResetWindowLayer({
          release: () => undefined,
          surfaceHost: () => host,
          onSurfaceHostChange: (listener) => {
            hostChanged = listener;
            return () => {
              hostChanged = () => undefined;
            };
          },
        });
        const phases = () => [...animations.values()].map((animation) => animation.currentTime);

        scheduleSessionReset('Refreshing session...', vi.fn());
        expect(phases()).toEqual([1_000_000 % 1850, 1_000_000 % 1450]);
        // The copy dropped the splash's delay, and the transition kept its time.
        expect(
          [
            ...document.querySelectorAll<SVGElement>(
              '#session-reset-overlay .boot-splash-spinner > svg, #session-reset-overlay .boot-splash-spinner circle',
            ),
          ].map((element) => element.style.animationDelay),
        ).toEqual(['', '']);
        expect([...transitions.values()].map((transition) => transition.currentTime)).toEqual([
          null,
          null,
        ]);

        // The move into the host restarts them: the wall clock's phase again.
        vi.setSystemTime(1_000_700);
        host = document.createElement('div');
        document.body.append(host);
        hostChanged();
        expect(document.getElementById('session-reset-overlay')?.parentElement).toBe(host);
        expect(phases()).toEqual([1_000_700 % 1850, 1_000_700 % 1450]);
      } finally {
        Reflect.deleteProperty(window.SVGElement.prototype, 'getAnimations');
      }
    });

    it('takes the screen out of rendering once its own fade-out has ended, and back for the next show', async () => {
      const { NAVIGATION_COMMIT_TIMEOUT_MS, RESET_PAINT_FALLBACK_MS } =
        await import('../navigation-contract.ts');
      const recover = () =>
        vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS + NAVIGATION_COMMIT_TIMEOUT_MS);
      const microtasks = async () => {
        await Promise.resolve();
        await Promise.resolve();
      };
      const { scheduleSessionReset } = await loadCoordinator();
      scheduleSessionReset('Refreshing session...', vi.fn());
      const overlay = document.getElementById('session-reset-overlay') as HTMLElement;
      // The fade-out each release starts, as the browser runs it; the test ends
      // or cancels it.
      const fades: Array<{ end(): void; cancel(): void }> = [];
      let transitions = true;
      Object.defineProperty(overlay, 'getAnimations', {
        configurable: true,
        value: () => {
          if (!transitions) return [];
          const fade: { end(): void; cancel(): void } = {
            end: () => undefined,
            cancel: () => undefined,
          };
          const finished = new Promise<void>((resolve, reject) => {
            fade.end = () => resolve();
            fade.cancel = () => reject(new DOMException('Cancelled', 'AbortError'));
          });
          fades.push(fade);
          return [
            { transitionProperty: 'visibility', finished: new Promise(() => undefined) },
            { transitionProperty: 'opacity', finished },
          ];
        },
      });
      const opacityEvent = (type: string) => {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, 'propertyName', { value: 'opacity' });
        overlay.dispatchEvent(event);
      };

      // The navigation never commits: this page stays and the screen fades out.
      recover();
      expect(overlay.hidden).toBe(true);
      expect(fades).toHaveLength(1);
      // Its loader keeps turning through the fade; another opacity transition's
      // end or cancellation (a fade-in the release cut short) does not count.
      opacityEvent('transitioncancel');
      opacityEvent('transitionend');
      await microtasks();
      expect(overlay.classList.contains('is-retired')).toBe(false);
      fades[0]!.end();
      await microtasks();
      expect(overlay.classList.contains('is-retired')).toBe(true);

      // The next reset shows it again.
      scheduleSessionReset('Leaving session...', vi.fn());
      expect(overlay.classList.contains('is-retired')).toBe(false);
      expect(overlay.classList.contains('show')).toBe(true);
      // A show during a fade-out cancels that fade and keeps the screen.
      recover();
      scheduleSessionReset('Refreshing session...', vi.fn());
      fades[1]!.cancel();
      await microtasks();
      expect(overlay.classList.contains('is-retired')).toBe(false);

      // With no fade running (transitions off), it leaves rendering at once.
      transitions = false;
      recover();
      expect(overlay.classList.contains('is-retired')).toBe(true);
    });

    it('stamps the next page as a continuation and clears the stamp when this page stays', async () => {
      const { NAVIGATION_COMMIT_TIMEOUT_MS, RESET_PAINT_FALLBACK_MS } =
        await import('../navigation-contract.ts');
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();

      // A navigation that never commits (a rejected traversal) recovers here.
      scheduleSessionReset('Refreshing session...', vi.fn());
      expect(sessionStorage.getItem(CONTINUITY_KEY)).toBe('1000000');
      vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS + NAVIGATION_COMMIT_TIMEOUT_MS);
      expect(isSessionResetPending()).toBe(false);
      expect(sessionStorage.getItem(CONTINUITY_KEY)).toBeNull();
    });

    it('keeps the stamp for the page a committed navigation opens, until this page returns', async () => {
      const { RESET_PAINT_FALLBACK_MS } = await import('../navigation-contract.ts');
      const { scheduleSessionReset } = await loadCoordinator();

      scheduleSessionReset('Refreshing session...', vi.fn());
      vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS);
      window.dispatchEvent(new Event('pagehide'));
      expect(sessionStorage.getItem(CONTINUITY_KEY)).toBe('1000000');

      // Safari returned this document instead: no later page continues it.
      window.dispatchEvent(new Event('pageshow'));
      expect(sessionStorage.getItem(CONTINUITY_KEY)).toBeNull();
    });

    it('fades in over the page and out when the page stays', () => {
      const stylesheet = readFileSync('css/style.css', 'utf8');
      const rule = (opener: string) => {
        const start = stylesheet.indexOf(opener);
        expect(start, opener).toBeGreaterThan(-1);
        return stylesheet.slice(start, stylesheet.indexOf('}', start)).replace(/\s+/gu, ' ');
      };
      expect(rule('  .session-reset-overlay {')).toContain(
        'transition: opacity 0.3s ease-out, visibility 0s linear 0.3s;',
      );
      expect(rule('  .session-reset-overlay.show {')).toContain(
        'transition: opacity 0.2s ease-out, visibility 0s linear 0s;',
      );
      // Hidden until shown; the shown screen is the only thing the page shows
      // while its input is blocked and the rest is inert.
      expect(rule('  .session-reset-overlay {')).toContain('visibility: hidden;');
      expect(rule('  .session-reset-overlay.show {')).toContain('visibility: visible;');
      // Its sheet keeps it rendered while hidden, so the fade can run; the
      // owner takes it out once the fade has ended.
      expect(rule('  .session-reset-overlay {')).toContain('display: grid;');
      expect(rule('  .session-reset-overlay.is-retired {')).toContain('display: none;');
      // The hidden starting style is settled before .show, so the fade runs.
      const source = readFileSync('src/core/session-reset.ts', 'utf8');
      expect(source).toMatch(
        /void overlay\.getBoundingClientRect\(\);\s*overlay\.classList\.add\('show'\);/u,
      );
    });
  });

  describe('exactly-once typed settlement (C6-4)', () => {
    beforeEach(() => {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: undefined,
      });
    });

    it('settles a throwing action as failed, once, through onSettled and its onRecovered alias', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
      const handle = scheduleSessionReset('Broken', () => {
        throw new Error('navigation failed');
      });
      const settled = vi.fn();
      const recovered = vi.fn();
      handle?.onSettled(settled);
      handle?.onRecovered(recovered);

      vi.advanceTimersByTime(120);
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pageshow'));
      vi.advanceTimersByTime(10_000);

      expect(settled.mock.calls).toEqual([['failed']]);
      expect(recovered).toHaveBeenCalledOnce();
      expect(isSessionResetPending()).toBe(false);
    });

    it.each([
      ['the commit deadline', true, () => vi.advanceTimersByTime(120 + 2_000)],
      [
        'a return after pagehide',
        true,
        () => {
          vi.advanceTimersByTime(120);
          window.dispatchEvent(new Event('pagehide'));
          window.dispatchEvent(new Event('pageshow'));
        },
      ],
      // C6-8 replaced the explicit restore inside the action with isCurrent().
      ['a stale request at navigate', false, () => vi.advanceTimersByTime(120)],
    ] as const)('settles %s as recovered, once', async (_name, current, run) => {
      const { scheduleSessionReset } = await loadCoordinator();
      const handle = scheduleSessionReset('Leaving', {
        navigate: vi.fn(),
        isCurrent: () => current,
      });
      const settled = vi.fn();
      handle?.onSettled(settled);

      run();
      vi.advanceTimersByTime(10_000);
      window.dispatchEvent(new Event('pageshow'));

      expect(settled.mock.calls).toEqual([['recovered']]);
      // A subscriber that arrives after settlement hears the same outcome at once.
      const late = vi.fn();
      handle?.onSettled(late);
      expect(late.mock.calls).toEqual([['recovered']]);
    });

    it('settles a request that is no longer current at navigate once, navigates nowhere and arms no deadline', async () => {
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
      const events: string[] = [];
      const navigate = vi.fn();
      scheduleSessionReset('Stale owner', {
        navigate,
        isCurrent: () => {
          events.push(`isCurrent: pending=${isSessionResetPending()}`);
          return false;
        },
      })?.onSettled((outcome) => events.push(`settled ${outcome}`));

      vi.advanceTimersByTime(120);
      const successor = vi.fn();
      scheduleSessionReset('Successor', vi.fn())?.onSettled(successor);
      // The stale request's would-be deadline (2 s after it) passes first.
      vi.advanceTimersByTime(2_000);

      expect(navigate).not.toHaveBeenCalled();
      expect(events).toEqual(['isCurrent: pending=true', 'settled recovered']);
      expect(successor).not.toHaveBeenCalled();
      expect(isSessionResetPending()).toBe(true);
      vi.advanceTimersByTime(120);
      expect(successor.mock.calls).toEqual([['recovered']]);
    });

    // Every order of the owner's inputs: animation frames, the 120 ms paint
    // fallback, the 2 s commit deadline, pagehide and pageshow (persisted or
    // not) and visibility. initPageNavigation is not called, so the owner's
    // bfcache reload stays out; the harness pins that path. The model writes out today's
    // rule: two frames or the fallback run the action once, pagehide commits,
    // and only a return after the commit, or the deadline after the action,
    // restores.
    type Step =
      | 'frame'
      | 'fallback'
      | 'deadline'
      | 'pagehide'
      | 'pagehide-persisted'
      | 'pageshow'
      | 'pageshow-persisted'
      | 'visible'
      | 'hidden';
    const STEPS: readonly Step[] = [
      'frame',
      'fallback',
      'deadline',
      'pagehide',
      'pagehide-persisted',
      'pageshow',
      'pageshow-persisted',
      'visible',
      'hidden',
    ];

    interface Model {
      phase: 'painting' | 'navigating' | 'left' | 'idle';
      frames: number;
      now: number;
      actionAt: number;
      actions: number;
    }

    function advanceModel(model: Model, ms: number): void {
      const target = model.now + ms;
      if (model.phase === 'painting' && target >= 120) {
        model.phase = 'navigating';
        model.actions += 1;
        model.actionAt = Math.max(model.now, 120);
      }
      if (model.phase === 'navigating' && target >= model.actionAt + 2_000) model.phase = 'idle';
      model.now = target;
    }

    function stepModel(model: Model, step: Step): void {
      if (step === 'frame') {
        if (model.phase !== 'painting') return;
        model.frames += 1;
        if (model.frames === 2) {
          model.phase = 'navigating';
          model.actions += 1;
          model.actionAt = model.now;
        }
      } else if (step === 'fallback') advanceModel(model, 120);
      else if (step === 'deadline') advanceModel(model, 2_000);
      else if (step.startsWith('pagehide')) {
        if (model.phase === 'painting' || model.phase === 'navigating') model.phase = 'left';
      } else if (step !== 'hidden' && model.phase === 'left') model.phase = 'idle';
    }

    /** Every pair, then a fixed pseudo-random walk, so every run checks the same orders. */
    function sequences(count: number, length: number): Step[][] {
      let seed = 0x6c0ffee;
      const next = () => {
        seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
        return seed >>> 8;
      };
      const pairs = STEPS.flatMap((first) => STEPS.map((second): Step[] => [first, second]));
      const walks = Array.from({ length: count }, () =>
        Array.from({ length }, () => STEPS[next() % STEPS.length] as Step),
      );
      return [...pairs, ...walks];
    }

    it('settles at most once per attempt in any order, and is pending exactly until then', async () => {
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 1;
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: (callback: FrameRequestCallback) => {
          frames.set(nextFrame, callback);
          return nextFrame++;
        },
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        value: (id: number) => frames.delete(id),
      });
      const setVisibility = (state: DocumentVisibilityState) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      const { __resetPageNavigationForTests, isSessionResetPending, scheduleSessionReset } =
        await loadCoordinator();
      const failures: string[] = [];

      try {
        for (const sequence of sequences(400, 8)) {
          setVisibility('visible');
          frames.clear();
          const model: Model = { phase: 'painting', frames: 0, now: 0, actionAt: 0, actions: 0 };
          const action = vi.fn();
          const outcomes: string[] = [];
          scheduleSessionReset('Sequence', action)?.onSettled((outcome) => outcomes.push(outcome));

          for (const [index, step] of sequence.entries()) {
            if (step === 'frame') {
              const due = [...frames.values()];
              frames.clear();
              for (const callback of due) callback(0);
            } else if (step === 'fallback') vi.advanceTimersByTime(120);
            else if (step === 'deadline') vi.advanceTimersByTime(2_000);
            else if (step === 'visible' || step === 'hidden') setVisibility(step);
            else {
              const [type = '', persisted] = step.split('-');
              window.dispatchEvent(
                new PageTransitionEvent(type, { persisted: persisted === 'persisted' }),
              );
            }
            stepModel(model, step);
            if (isSessionResetPending() !== (model.phase !== 'idle')) {
              const prefix = sequence.slice(0, index + 1).join(' > ');
              failures.push(`${prefix}: pending=${isSessionResetPending()}, model ${model.phase}`);
            }
          }

          const expected = model.phase === 'idle' ? ['recovered'] : [];
          if (JSON.stringify(outcomes) !== JSON.stringify(expected)) {
            failures.push(`${sequence.join(' > ')}: settled ${JSON.stringify(outcomes)}`);
          }
          if (action.mock.calls.length !== model.actions) {
            failures.push(`${sequence.join(' > ')}: ${action.mock.calls.length} actions`);
          }
          __resetPageNavigationForTests();
          vi.clearAllTimers();
        }
      } finally {
        Reflect.deleteProperty(document, 'visibilityState');
      }

      expect(failures).toEqual([]);
    });
  });

  // C6-8 (owner decision 2, 2026-10-23): an optional prepare step runs after
  // the paint and before the final navigation call, bounded by
  // NAVIGATION_PREPARE_TIMEOUT_MS; the 2 s commit deadline starts only when
  // the owner navigates.
  describe('prepare/navigate requests (C6-8)', () => {
    const PAINT = 120;
    const PREPARE_DEADLINE = 2_500;
    const COMMIT_DEADLINE = 2_000;

    beforeEach(() => {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: undefined,
      });
    });

    function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('prepares after the paint, navigates when prepare settles, and starts the commit deadline only then', async () => {
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
      const step = deferred();
      const prepare = vi.fn((_signal: AbortSignal) => step.promise);
      const navigate = vi.fn();
      const settled = vi.fn();
      scheduleSessionReset('Leaving', { prepare, navigate })?.onSettled(settled);

      expect(prepare).not.toHaveBeenCalled();
      vi.advanceTimersByTime(PAINT);
      expect(prepare).toHaveBeenCalledOnce();
      expect(unloadPrompts()).toBe(false);

      // A prepare step longer than the commit deadline does not settle anything.
      await vi.advanceTimersByTimeAsync(2_400);
      expect(navigate).not.toHaveBeenCalled();
      expect(isSessionResetPending()).toBe(true);

      step.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(navigate).toHaveBeenCalledOnce();
      expect(prepare.mock.calls[0]![0].aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(COMMIT_DEADLINE - 1);
      expect(isSessionResetPending()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(isSessionResetPending()).toBe(false);
      expect(settled.mock.calls).toEqual([['recovered']]);
    });

    it('navigates anyway when prepare passes its deadline, and aborts its signal so a late step stops', async () => {
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
      const step = deferred();
      const late = vi.fn();
      let signal: AbortSignal | null = null;
      const navigate = vi.fn();
      scheduleSessionReset('Leaving', {
        async prepare(prepareSignal) {
          signal = prepareSignal;
          await step.promise;
          if (!prepareSignal.aborted) late();
        },
        navigate,
      });

      await vi.advanceTimersByTimeAsync(PAINT + PREPARE_DEADLINE - 1);
      expect(navigate).not.toHaveBeenCalled();
      expect(signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(navigate).toHaveBeenCalledOnce();
      expect(signal!.aborted).toBe(true);
      expect(isSessionResetPending()).toBe(true);

      step.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(late).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledOnce();
    });

    it('navigates anyway when prepare rejects or throws (fail open)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { scheduleSessionReset } = await loadCoordinator();
      const navigate = vi.fn();
      scheduleSessionReset('Leaving', {
        prepare: () => Promise.reject(new Error('chunk failed')),
        navigate,
      });

      await vi.advanceTimersByTimeAsync(PAINT);
      expect(navigate).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        '[SessionReset] Navigation preparation failed; navigating anyway:',
        expect.any(Error),
      );

      const { __resetPageNavigationForTests } = coordinator!;
      __resetPageNavigationForTests();
      const second = vi.fn();
      scheduleSessionReset('Leaving', {
        prepare: () => {
          throw new Error('sync failure');
        },
        navigate: second,
      });
      await vi.advanceTimersByTimeAsync(PAINT);
      expect(second).toHaveBeenCalledOnce();
    });

    it('never navigates after the attempt settles during prepare, and settles recovered once', async () => {
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
      const step = deferred();
      let signal: AbortSignal | null = null;
      const navigate = vi.fn();
      const settled = vi.fn();
      scheduleSessionReset('Leaving', {
        prepare(prepareSignal) {
          signal = prepareSignal;
          return step.promise;
        },
        navigate,
      })?.onSettled(settled);

      await vi.advanceTimersByTimeAsync(PAINT);
      // Another navigation wins during prepare and the old page returns.
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pageshow'));
      expect(isSessionResetPending()).toBe(false);
      expect(signal!.aborted).toBe(true);
      expect(unloadPrompts()).toBe(true);

      step.resolve();
      await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE + COMMIT_DEADLINE);
      expect(navigate).not.toHaveBeenCalled();
      expect(settled.mock.calls).toEqual([['recovered']]);
    });

    it('holds the page while a pagehide during prepare commits, and never navigates from the returned page', async () => {
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
      const navigate = vi.fn();
      scheduleSessionReset('Leaving', {
        prepare: () => new Promise<void>(() => undefined),
        navigate,
      });

      await vi.advanceTimersByTimeAsync(PAINT);
      window.dispatchEvent(new Event('pagehide'));
      await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE + COMMIT_DEADLINE);
      expect(navigate).not.toHaveBeenCalled();
      expect(isSessionResetPending()).toBe(true);
    });

    it('asks isCurrent() after prepare, right before navigating', async () => {
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
      let current = true;
      const step = deferred();
      const navigate = vi.fn();
      scheduleSessionReset('Leaving', {
        prepare: () => step.promise,
        navigate,
        isCurrent: () => current,
      });

      await vi.advanceTimersByTimeAsync(PAINT);
      current = false;
      step.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(navigate).not.toHaveBeenCalled();
      expect(isSessionResetPending()).toBe(false);
    });
  });

  // C6-12: the Back guard re-arms from this event (owner decision 5).
  describe('onNavigationPendingChange (C6-12)', () => {
    beforeEach(() => {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: undefined,
      });
      // Reloads in these cases are recorded no-op navigations.
      stubNavigationSinks();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('reports the start and the settle of an attempt once each, after its own callbacks, reading the live state', async () => {
      const { isSessionResetPending, onNavigationPendingChange, scheduleSessionReset } =
        await loadCoordinator();
      const events: string[] = [];
      const unsubscribe = onNavigationPendingChange(() =>
        events.push(`pending-change: pending=${isSessionResetPending()}`),
      );

      scheduleSessionReset('Leaving', vi.fn())?.onSettled(() => events.push('settled'));
      expect(events).toEqual(['pending-change: pending=true']);

      vi.advanceTimersByTime(120 + 2_000);
      expect(events).toEqual([
        'pending-change: pending=true',
        'settled',
        'pending-change: pending=false',
      ]);

      unsubscribe();
      scheduleSessionReset('Again', vi.fn());
      expect(events).toHaveLength(3);
    });

    it('reports no passing idle when settle starts a queued reload or a callback asks for a reset', async () => {
      const {
        isSessionResetPending,
        onNavigationPendingChange,
        scheduleDocumentReload,
        scheduleSessionReset,
      } = await loadCoordinator();
      const states: boolean[] = [];
      onNavigationPendingChange(() => states.push(isSessionResetPending()));

      scheduleSessionReset('Leaving', vi.fn())?.onSettled(() =>
        scheduleSessionReset('Retry', vi.fn()),
      );
      scheduleDocumentReload('Queued');
      vi.advanceTimersByTime(120 + 2_000);
      // The queued reload took the page inside settle; the retry was refused.
      expect(isSessionResetPending()).toBe(true);
      expect(states).toEqual([true]);

      vi.advanceTimersByTime(120 + 2_000);
      expect(isSessionResetPending()).toBe(false);
      expect(states).toEqual([true, false]);
    });

    it('reports a reset that a subscriber starts while hearing of the idle page', async () => {
      const { isSessionResetPending, onNavigationPendingChange, scheduleSessionReset } =
        await loadCoordinator();
      const states: boolean[] = [];
      let retried = false;
      onNavigationPendingChange(() => {
        states.push(isSessionResetPending());
        if (!isSessionResetPending() && !retried) {
          retried = true;
          scheduleSessionReset('Retry', vi.fn());
        }
      });

      scheduleSessionReset('Leaving', vi.fn());
      vi.advanceTimersByTime(120 + 2_000);

      expect(isSessionResetPending()).toBe(true);
      expect(states).toEqual([true, false, true]);
    });
  });

  describe('shared inert ownership with the modal stack', () => {
    async function loadModalStack(): Promise<typeof import('../../ui/dom.ts')> {
      // Same module registry as the coordinator, so both owners see one ledger.
      const dom = await import('../../ui/dom.ts');
      // Mirror app.ts: the window layer re-derives once the reset releases.
      const { setSessionResetWindowLayer } = await loadCoordinator();
      setSessionResetWindowLayer({
        release: dom.syncOverlayStateAfterExternalLock,
        surfaceHost: dom.fullscreenSurfaceHost,
        onSurfaceHostChange: dom.onFullscreenSurfaceHostChange,
      });
      return dom;
    }

    // Mirror dialog.ts: the window writes its own aria-hidden on open and close.
    function openDialog(dom: typeof import('../../ui/dom.ts'), dialog: HTMLElement): void {
      dialog.classList.add('show');
      dialog.setAttribute('aria-hidden', 'false');
      dom.syncOverlayState('dialog-overlay');
    }

    function closeDialog(dom: typeof import('../../ui/dom.ts'), dialog: HTMLElement): void {
      dialog.classList.remove('show');
      dialog.setAttribute('aria-hidden', 'true');
      dom.syncOverlayState();
    }

    beforeEach(() => {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: undefined,
      });
      // Same initial attributes as index.html: a closed dialog is aria-hidden.
      document.body.innerHTML =
        '<main id="app"><button id="control">Control</button></main>' +
        '<div id="dialog-overlay" aria-hidden="true"></div>';
    });

    it('locks with inert only and leaves aria-hidden to the windows', async () => {
      const app = document.getElementById('app') as HTMLElement;
      const dialog = document.getElementById('dialog-overlay') as HTMLElement;
      const { scheduleSessionReset } = await loadCoordinator();

      scheduleSessionReset('No-op', vi.fn());
      expect(app.inert).toBe(true);
      expect(dialog.inert).toBe(true);
      expect(app.hasAttribute('aria-hidden')).toBe(false);
      expect(dialog.getAttribute('aria-hidden')).toBe('true');

      vi.advanceTimersByTime(120 + 2_000);
      expect(app.inert).toBe(false);
      expect(dialog.inert).toBe(false);
      expect(app.hasAttribute('aria-hidden')).toBe(false);
      expect(dialog.getAttribute('aria-hidden')).toBe('true');
    });

    it('leaves the shell interactive after a dialog opened during an abandoned reset closes', async () => {
      const app = document.getElementById('app') as HTMLElement;
      const dialog = document.getElementById('dialog-overlay') as HTMLElement;
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
      const dom = await loadModalStack();

      try {
        scheduleSessionReset('No-op', vi.fn());
        openDialog(dom, dialog);
        expect(app.inert).toBe(true);

        // The navigation never commits, so the coordinator recovers the page.
        vi.advanceTimersByTime(120 + 2_000);
        expect(isSessionResetPending()).toBe(false);
        // The still-open dialog keeps its own lock on the shell.
        expect(app.inert).toBe(true);
        expect(app.getAttribute('aria-hidden')).toBe('true');
        // The recovered dialog keeps the value it wrote when it opened.
        expect(dialog.inert).toBe(false);
        expect(dialog.getAttribute('aria-hidden')).toBe('false');

        closeDialog(dom, dialog);
        expect(app.inert).toBe(false);
        expect(app.hasAttribute('inert')).toBe(false);
        expect(app.hasAttribute('aria-hidden')).toBe(false);
        expect(dialog.getAttribute('aria-hidden')).toBe('true');
      } finally {
        dom.__resetModalStackForTests();
      }
    });

    it('keeps the shell locked when a dialog closes mid-reset and unlocks it on recovery', async () => {
      const app = document.getElementById('app') as HTMLElement;
      const dialog = document.getElementById('dialog-overlay') as HTMLElement;
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
      const dom = await loadModalStack();

      try {
        openDialog(dom, dialog);
        scheduleSessionReset('No-op', vi.fn());

        closeDialog(dom, dialog);
        // Closing the dialog must not re-enable the page behind the reset.
        expect(app.inert).toBe(true);

        vi.advanceTimersByTime(120 + 2_000);
        expect(isSessionResetPending()).toBe(false);
        expect(app.inert).toBe(false);
        expect(app.hasAttribute('inert')).toBe(false);
        expect(app.hasAttribute('aria-hidden')).toBe(false);
        expect(dialog.inert).toBe(false);
        // The closed dialog keeps the value it wrote when it closed.
        expect(dialog.getAttribute('aria-hidden')).toBe('true');
      } finally {
        dom.__resetModalStackForTests();
      }
    });

    it('re-derives a dialog that opened over the setup screen during an abandoned reset', async () => {
      document.body.innerHTML =
        '<main id="app"><button id="control">Control</button></main>' +
        '<div id="setup-overlay" class="active"><button id="setup-start">Start</button></div>' +
        '<div id="dialog-overlay" aria-hidden="true"><button id="dialog-ok">OK</button></div>';
      const setup = document.getElementById('setup-overlay') as HTMLElement;
      const dialog = document.getElementById('dialog-overlay') as HTMLElement;
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
      const dom = await loadModalStack();

      try {
        dom.syncOverlayState('setup-overlay');
        (document.getElementById('setup-start') as HTMLButtonElement).focus();
        scheduleSessionReset('No-op', vi.fn());
        openDialog(dom, dialog);

        vi.advanceTimersByTime(120 + 2_000);
        expect(isSessionResetPending()).toBe(false);
        // The dialog is on top: exposed, interactive and holding focus.
        expect(dialog.inert).toBe(false);
        expect(dialog.getAttribute('aria-hidden')).toBe('false');
        expect(setup.inert).toBe(true);
        expect(document.activeElement?.id).toBe('dialog-ok');

        closeDialog(dom, dialog);
        expect(setup.inert).toBe(false);
        expect(setup.hasAttribute('inert')).toBe(false);
        expect(setup.getAttribute('aria-hidden')).toBe('false');
      } finally {
        dom.__resetModalStackForTests();
      }
    });

    it('moves focus into a dialog that opened during an abandoned reset after focus was lost', async () => {
      const dialog = document.getElementById('dialog-overlay') as HTMLElement;
      dialog.innerHTML = '<button id="dialog-ok">OK</button>';
      const { scheduleSessionReset } = await loadCoordinator();
      const dom = await loadModalStack();

      try {
        scheduleSessionReset('No-op', vi.fn());
        openDialog(dom, dialog);
        // Browsers drop focus from an element that becomes inert.
        (document.activeElement as HTMLElement | null)?.blur();

        vi.advanceTimersByTime(120 + 2_000);
        expect(dialog.getAttribute('aria-hidden')).toBe('false');
        expect(document.activeElement?.id).toBe('dialog-ok');
      } finally {
        dom.__resetModalStackForTests();
      }
    });

    it('never locks the reset overlay when a retry follows an abandoned reset on the setup screen', async () => {
      document.body.innerHTML =
        '<main id="app"><button id="control">Control</button></main>' +
        '<div id="setup-overlay" class="active"><button id="setup-start">Start</button></div>';
      const { isSessionResetPending, scheduleSessionReset } = await loadCoordinator();
      const dom = await loadModalStack();

      try {
        dom.syncOverlayState('setup-overlay');
        scheduleSessionReset('No-op', vi.fn());
        const overlay = document.getElementById('session-reset-overlay') as HTMLElement;

        vi.advanceTimersByTime(120 + 2_000);
        expect(isSessionResetPending()).toBe(false);
        expect(overlay.hasAttribute('inert')).toBe(false);

        scheduleSessionReset('Retry', vi.fn());
        // The retry's status surface stays exposed and focusable.
        expect(overlay.inert).not.toBe(true);
        expect(overlay.hasAttribute('inert')).toBe(false);
        expect(overlay.getAttribute('aria-hidden')).toBe('false');
        expect(document.getElementById('app')?.inert).toBe(true);
      } finally {
        dom.__resetModalStackForTests();
      }
    });

    it('keeps the mounted reset overlay exposed while windows open and close around it', async () => {
      // Same order as index.html: the reset overlay is mounted from the start.
      document.body.innerHTML =
        '<main id="app"><button id="control">Control</button></main>' +
        '<div id="setup-overlay" class="active"><button id="setup-start">Start</button></div>' +
        '<div id="session-reset-overlay" aria-hidden="true" tabindex="-1" hidden>' +
        '<p id="session-reset-message"></p></div>' +
        '<div id="dialog-overlay" aria-hidden="true"><button id="dialog-ok">OK</button></div>';
      const overlay = document.getElementById('session-reset-overlay') as HTMLElement;
      const dialog = document.getElementById('dialog-overlay') as HTMLElement;
      const { scheduleSessionReset } = await loadCoordinator();
      const dom = await loadModalStack();

      try {
        dom.syncOverlayState('setup-overlay');
        expect(overlay.hasAttribute('inert')).toBe(false);
        expect(overlay.getAttribute('aria-hidden')).toBe('true');

        scheduleSessionReset('No-op', vi.fn());
        openDialog(dom, dialog);
        expect(overlay.hasAttribute('inert')).toBe(false);
        expect(overlay.getAttribute('aria-hidden')).toBe('false');
        expect(document.activeElement).toBe(overlay);

        closeDialog(dom, dialog);
        expect(overlay.hasAttribute('inert')).toBe(false);
        expect(overlay.getAttribute('aria-hidden')).toBe('false');
      } finally {
        dom.__resetModalStackForTests();
      }
    });
  });
});

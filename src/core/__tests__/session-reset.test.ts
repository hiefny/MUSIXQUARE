/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleMocks = vi.hoisted(() => ({
  markIntentionalNav: vi.fn(),
  clearIntentionalNav: vi.fn(),
}));

vi.mock('../page-lifecycle.ts', () => lifecycleMocks);

const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;
type Coordinator = typeof import('../session-reset.ts');

describe('session reset coordinator', () => {
  let coordinator: Coordinator | null;

  async function loadCoordinator(): Promise<Coordinator> {
    coordinator = await import('../session-reset.ts');
    return coordinator;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    coordinator = null;
    lifecycleMocks.markIntentionalNav.mockClear();
    lifecycleMocks.clearIntentionalNav.mockClear();
    document.documentElement.className = '';
    document.body.innerHTML = '<main id="app"><button id="control">Control</button></main>';
  });

  afterEach(() => {
    coordinator?.__resetSessionResetForTests();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: originalRequestAnimationFrame,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
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
    frames.shift()?.(16);

    expect(lifecycleMocks.markIntentionalNav).toHaveBeenCalledOnce();
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
    expect(lifecycleMocks.markIntentionalNav).toHaveBeenCalledOnce();
  });

  it('restores interaction and intentional-nav state when the action throws', async () => {
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
    expect(lifecycleMocks.clearIntentionalNav).toHaveBeenCalledOnce();
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
    expect(lifecycleMocks.clearIntentionalNav).toHaveBeenCalledOnce();
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
    expect(lifecycleMocks.clearIntentionalNav).toHaveBeenCalledOnce();
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
    expect(lifecycleMocks.clearIntentionalNav).not.toHaveBeenCalled();
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
    expect(lifecycleMocks.clearIntentionalNav).toHaveBeenCalledOnce();
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
    const { restoreSessionReset, scheduleSessionReset } = await loadCoordinator();

    scheduleSessionReset('Cleanup', vi.fn());
    const overlay = document.getElementById('session-reset-overlay') as HTMLElement;
    const focusControl = control.focus.bind(control);
    const focusSpy = vi.spyOn(control, 'focus').mockImplementation((options?: FocusOptions) => {
      expect(overlay.hidden).toBe(false);
      focusControl(options);
    });
    restoreSessionReset();

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
});

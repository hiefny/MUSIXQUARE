/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import {
  markIntentionalNav,
  clearIntentionalNav,
  isIntentionalNav,
  initPageLifecycleHandlers,
  __resetIntentionalNavForTests,
  type PageLifecycleHandle,
} from '../page-lifecycle.ts';
import {
  __resetSessionResetForTests,
  initPageNavigation,
  isSessionResetPending,
  scheduleSessionReset,
} from '../session-reset.ts';
import { stubNavigationSinks, type NavigationSinks } from './__helpers__/navigation-sinks.ts';

// jsdom's Event doesn't carry the `persisted` property that real
// PageTransitionEvent does, and setting it via the constructor only
// works when the environment exposes PageTransitionEvent. Synthesize
// both properties manually so the tests are environment-agnostic.
function pageTransition(name: string, persisted: boolean): Event {
  const e = new Event(name);
  Object.defineProperty(e, 'persisted', { value: persisted });
  return e;
}

beforeEach(() => {
  __resetIntentionalNavForTests();
  document.body.classList.remove('fouc-loaded');
});

describe('page-lifecycle flag', () => {
  it('starts false', () => {
    expect(isIntentionalNav()).toBe(false);
  });

  it('becomes true after markIntentionalNav()', () => {
    markIntentionalNav();
    expect(isIntentionalNav()).toBe(true);
  });

  it('stays true across repeated calls (idempotent)', () => {
    markIntentionalNav();
    markIntentionalNav();
    markIntentionalNav();
    expect(isIntentionalNav()).toBe(true);
  });

  it('can clear an intentional navigation that did not commit', () => {
    markIntentionalNav();
    clearIntentionalNav();
    expect(isIntentionalNav()).toBe(false);
  });
});

describe('initPageLifecycleHandlers — beforeunload', () => {
  let handle: PageLifecycleHandle;
  let role: string;
  let leaveSession: Mock<() => void>;

  beforeEach(() => {
    role = 'idle';
    leaveSession = vi.fn<() => void>();
    handle = initPageLifecycleHandlers({
      getRole: () => role,
      leaveSession,
    });
  });

  afterEach(() => {
    handle.dispose();
  });

  it('does NOT preventDefault when role is idle', () => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('preventDefaults when role is non-idle and flag is not set', () => {
    role = 'host';
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('does NOT preventDefault when role is non-idle but intentional-nav flag is set', () => {
    role = 'host';
    markIntentionalNav();
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('treats guest role the same as host', () => {
    role = 'guest';
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('initPageLifecycleHandlers — pagehide', () => {
  let handle: PageLifecycleHandle;
  let role: string;
  let leaveSession: Mock<() => void>;

  beforeEach(() => {
    role = 'host';
    leaveSession = vi.fn<() => void>();
    handle = initPageLifecycleHandlers({
      getRole: () => role,
      leaveSession,
    });
  });

  afterEach(() => {
    handle.dispose();
  });

  it('calls leaveSession on real unload (persisted=false) with active session', () => {
    window.dispatchEvent(pageTransition('pagehide', false));
    expect(leaveSession).toHaveBeenCalledTimes(1);
  });

  it('skips leaveSession when entering bfcache (persisted=true)', () => {
    window.dispatchEvent(pageTransition('pagehide', true));
    expect(leaveSession).not.toHaveBeenCalled();
  });

  it('skips leaveSession when role is already idle (avoids redundant double-cleanup)', () => {
    role = 'idle';
    window.dispatchEvent(pageTransition('pagehide', false));
    expect(leaveSession).not.toHaveBeenCalled();
  });

  it('swallows a leaveSession throw — pagehide must never raise', () => {
    leaveSession.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => {
      window.dispatchEvent(pageTransition('pagehide', false));
    }).not.toThrow();
  });
});

describe('initPageLifecycleHandlers — dispose', () => {
  it('detaches both listeners when dispose() is called', () => {
    const leaveSession = vi.fn();
    const { dispose } = initPageLifecycleHandlers({
      getRole: () => 'host',
      leaveSession,
    });

    dispose();

    const before = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    window.dispatchEvent(pageTransition('pagehide', false));
    expect(leaveSession).not.toHaveBeenCalled();
  });
});

// The back-forward cache return moved from page-lifecycle's pageshow listener
// into the navigation owner's one page-transition dispatch (C6-6). These run
// the real owner with recorded location sinks and real DOM events.
describe('page navigation owner — back-forward cache return (initPageNavigation)', () => {
  const RELOADING = 'Reloading';
  let role: string;
  let info: Mock<(message: string, ...args: unknown[]) => void>;
  let sinks: NavigationSinks;
  let navigation: { dispose(): void };
  const originalRaf = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');

  beforeEach(() => {
    vi.useFakeTimers();
    // No frames: the reset runs its action after the 120 ms fallback.
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    document.body.innerHTML = '<main id="app">Session</main>';
    role = 'host';
    info = vi.fn();
    sinks = stubNavigationSinks();
    navigation = initPageNavigation({
      getRole: () => role,
      bfcacheReloadMessage: () => RELOADING,
      log: { info },
    });
  });

  afterEach(() => {
    navigation.dispose();
    __resetSessionResetForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalRaf) Object.defineProperty(window, 'requestAnimationFrame', originalRaf);
    else Reflect.deleteProperty(window, 'requestAnimationFrame');
    document.body.innerHTML = '';
  });

  function resetMessage(): string | null {
    return document.getElementById('session-reset-message')?.textContent ?? null;
  }

  it('reveals the shell on a fresh pageshow (persisted=false) and reloads nothing', () => {
    window.dispatchEvent(pageTransition('pageshow', false));
    vi.advanceTimersByTime(10_000);
    expect(document.body.classList.contains('fouc-loaded')).toBe(true);
    expect(isSessionResetPending()).toBe(false);
    expect(sinks.calls).toEqual([]);
  });

  it('does nothing on bfcache restore when role is idle and no reset is pending', () => {
    role = 'idle';
    window.dispatchEvent(pageTransition('pageshow', true));
    vi.advanceTimersByTime(10_000);
    expect(document.body.classList.contains('fouc-loaded')).toBe(true);
    expect(isSessionResetPending()).toBe(false);
    expect(sinks.calls).toEqual([]);
  });

  it('settles a returned pending reset, then reloads the idle document once', () => {
    role = 'idle';
    const events: string[] = [];
    scheduleSessionReset('Leaving', () => window.location.replace('/'))?.onSettled((outcome) =>
      events.push(`settled ${outcome}: pending=${isSessionResetPending()}`),
    );
    vi.advanceTimersByTime(120);
    window.dispatchEvent(pageTransition('pagehide', true));

    window.dispatchEvent(pageTransition('pageshow', true));

    // The returned reset settled before the fresh reload took the page.
    expect(events).toEqual(['settled recovered: pending=false']);
    expect(isSessionResetPending()).toBe(true);
    expect(resetMessage()).toBe(RELOADING);
    expect(isIntentionalNav()).toBe(false);
    vi.advanceTimersByTime(120);
    expect(sinks.calls.map((call) => call.op)).toEqual(['replace', 'reload']);
  });

  it('reloads on bfcache restore when role is non-idle', () => {
    window.dispatchEvent(pageTransition('pageshow', true));
    expect(isSessionResetPending()).toBe(true);
    vi.advanceTimersByTime(120);
    expect(sinks.count('reload')).toBe(1);
  });

  it('flips the intentional-nav flag before reloading (avoids double-prompt)', () => {
    window.dispatchEvent(pageTransition('pageshow', true));
    expect(isIntentionalNav()).toBe(true);
  });

  it('clears the intentional-nav flag when the bfcache reload throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sinks.reload.mockImplementationOnce(() => {
      throw new Error('reload rejected');
    });

    expect(() => window.dispatchEvent(pageTransition('pageshow', true))).not.toThrow();
    vi.advanceTimersByTime(120);

    expect(isSessionResetPending()).toBe(false);
    expect(isIntentionalNav()).toBe(false);
  });

  it('restores the shell without entering another reload loop when the same bfcache document returns', () => {
    role = 'guest';
    window.dispatchEvent(pageTransition('pageshow', true));
    vi.advanceTimersByTime(120);
    expect(sinks.count('reload')).toBe(1);
    expect(isIntentionalNav()).toBe(true);
    window.dispatchEvent(pageTransition('pagehide', true));

    document.body.classList.remove('fouc-loaded');
    window.dispatchEvent(pageTransition('pageshow', true));
    vi.advanceTimersByTime(10_000);

    expect(isSessionResetPending()).toBe(false);
    expect(sinks.count('reload')).toBe(1);
    expect(isIntentionalNav()).toBe(false);
    expect(document.body.classList.contains('fouc-loaded')).toBe(true);
    expect(info).toHaveBeenLastCalledWith(
      '[PageLifecycle] bfcache reload returned; keeping recovered shell visible',
    );
  });

  it('passes the log message through the injected logger', () => {
    window.dispatchEvent(pageTransition('pageshow', true));
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toContain('bfcache');
  });

  it('stops the bounded reload after dispose but still restores a returned reset', () => {
    navigation.dispose();
    scheduleSessionReset('Leaving', vi.fn());
    vi.advanceTimersByTime(120);
    window.dispatchEvent(pageTransition('pagehide', true));

    window.dispatchEvent(pageTransition('pageshow', true));
    vi.advanceTimersByTime(10_000);

    expect(isSessionResetPending()).toBe(false);
    expect(sinks.calls).toEqual([]);
  });

  it('re-arms a fresh reload after an idle pending reset returns from bfcache', () => {
    scheduleSessionReset('Leaving', () => {
      role = 'idle';
    });
    vi.advanceTimersByTime(120);
    window.dispatchEvent(pageTransition('pagehide', true));

    window.dispatchEvent(pageTransition('pageshow', true));

    expect(isSessionResetPending()).toBe(true);
    expect(resetMessage()).toBe(RELOADING);
    vi.advanceTimersByTime(120);
    expect(sinks.count('reload')).toBe(1);
  });
});

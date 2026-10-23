/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import {
  claimUnloadExemption,
  initPageLifecycleHandlers,
  __resetUnloadExemptionsForTests,
  type PageLifecycleHandle,
} from '../page-lifecycle.ts';
import {
  __resetPageNavigationForTests,
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

/** Whether a beforeunload in a room asks to confirm (handlers from the caller). */
function unloadPrompts(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  __resetUnloadExemptionsForTests();
  document.body.classList.remove('fouc-loaded');
});

describe('unload-exemption claims (C6-7)', () => {
  let handle: PageLifecycleHandle;

  beforeEach(() => {
    handle = initPageLifecycleHandlers({ getRole: () => 'host', leaveSession: vi.fn() });
  });

  afterEach(() => {
    handle.dispose();
  });

  it('asks to confirm in a session while no claim is held', () => {
    expect(unloadPrompts()).toBe(true);
  });

  it('exempts the unload while a claim is live and asks again once it is released', () => {
    const release = claimUnloadExemption('navigation');
    expect(unloadPrompts()).toBe(false);
    release();
    expect(unloadPrompts()).toBe(true);
  });

  it('keeps the claim of one writer when another releases its own', () => {
    const releaseLogin = claimUnloadExemption('account-login');
    const releaseNavigation = claimUnloadExemption('navigation');
    releaseNavigation();
    expect(unloadPrompts()).toBe(false);
    releaseLogin();
    expect(unloadPrompts()).toBe(true);
  });

  it('treats a second release of the same claim as a no-op', () => {
    const releaseLogin = claimUnloadExemption('account-login');
    const releaseNavigation = claimUnloadExemption('navigation');
    releaseNavigation();
    releaseNavigation();
    expect(unloadPrompts()).toBe(false);
    releaseLogin();
    expect(unloadPrompts()).toBe(true);
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

  it('does NOT preventDefault when role is non-idle but an exemption is claimed', () => {
    role = 'host';
    claimUnloadExemption('navigation');
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
    __resetPageNavigationForTests();
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
    vi.advanceTimersByTime(120);
    expect(sinks.calls.map((call) => call.op)).toEqual(['replace', 'reload']);
  });

  it('reloads on bfcache restore when role is non-idle', () => {
    window.dispatchEvent(pageTransition('pageshow', true));
    expect(isSessionResetPending()).toBe(true);
    vi.advanceTimersByTime(120);
    expect(sinks.count('reload')).toBe(1);
  });

  // Until C6-7 page-lifecycle pre-marked the exemption before the reload was
  // even scheduled; the reload's own claim now starts with its action.
  it('claims the unload exemption when the bfcache reload action starts (avoids double-prompt)', () => {
    const lifecycle = initPageLifecycleHandlers({ getRole: () => role, leaveSession: vi.fn() });
    try {
      window.dispatchEvent(pageTransition('pageshow', true));
      expect(unloadPrompts()).toBe(true);
      vi.advanceTimersByTime(120);
      expect(sinks.count('reload')).toBe(1);
      expect(unloadPrompts()).toBe(false);
    } finally {
      lifecycle.dispose();
    }
  });

  it('releases the reload exemption when the bfcache reload throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sinks.reload.mockImplementationOnce(() => {
      throw new Error('reload rejected');
    });
    const lifecycle = initPageLifecycleHandlers({ getRole: () => role, leaveSession: vi.fn() });

    try {
      expect(() => window.dispatchEvent(pageTransition('pageshow', true))).not.toThrow();
      vi.advanceTimersByTime(120);

      expect(isSessionResetPending()).toBe(false);
      expect(unloadPrompts()).toBe(true);
    } finally {
      lifecycle.dispose();
    }
  });

  it('restores the shell without entering another reload loop when the same bfcache document returns', () => {
    role = 'guest';
    const lifecycle = initPageLifecycleHandlers({ getRole: () => role, leaveSession: vi.fn() });
    window.dispatchEvent(pageTransition('pageshow', true));
    vi.advanceTimersByTime(120);
    expect(sinks.count('reload')).toBe(1);
    expect(unloadPrompts()).toBe(false);
    window.dispatchEvent(pageTransition('pagehide', true));

    document.body.classList.remove('fouc-loaded');
    window.dispatchEvent(pageTransition('pageshow', true));
    vi.advanceTimersByTime(10_000);

    expect(isSessionResetPending()).toBe(false);
    expect(sinks.count('reload')).toBe(1);
    expect(unloadPrompts()).toBe(true);
    lifecycle.dispose();
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

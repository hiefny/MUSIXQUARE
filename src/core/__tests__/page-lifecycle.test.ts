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
  isSessionResetPending,
  restoreSessionReset,
  scheduleSessionReset,
} from '../session-reset.ts';

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
  let reload: Mock<() => void>;

  beforeEach(() => {
    role = 'idle';
    leaveSession = vi.fn<() => void>();
    reload = vi.fn<() => void>();
    handle = initPageLifecycleHandlers({
      getRole: () => role,
      leaveSession,
      reload,
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
      reload: vi.fn(),
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

describe('initPageLifecycleHandlers — pageshow', () => {
  let handle: PageLifecycleHandle;
  let role: string;
  let reload: Mock<() => void>;

  beforeEach(() => {
    role = 'host';
    reload = vi.fn<() => void>();
    handle = initPageLifecycleHandlers({
      getRole: () => role,
      leaveSession: vi.fn(),
      reload,
    });
  });

  afterEach(() => {
    handle.dispose();
  });

  it('does nothing on a fresh pageshow (persisted=false)', () => {
    window.dispatchEvent(pageTransition('pageshow', false));
    expect(reload).not.toHaveBeenCalled();
    expect(document.body.classList.contains('fouc-loaded')).toBe(true);
  });

  it('does nothing on bfcache restore when role is idle', () => {
    role = 'idle';
    window.dispatchEvent(pageTransition('pageshow', true));
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads an idle bfcache document that still owns a pending reset', () => {
    handle.dispose();
    role = 'idle';
    const restorePendingReset = vi.fn();
    handle = initPageLifecycleHandlers({
      getRole: () => role,
      leaveSession: vi.fn(),
      reload,
      hasPendingReset: () => true,
      restorePendingReset,
    });

    window.dispatchEvent(pageTransition('pageshow', true));

    expect(restorePendingReset).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(restorePendingReset.mock.invocationCallOrder[0]).toBeLessThan(
      reload.mock.invocationCallOrder[0],
    );
    expect(isIntentionalNav()).toBe(false);
  });

  it('reloads on bfcache restore when role is non-idle', () => {
    window.dispatchEvent(pageTransition('pageshow', true));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('flips the intentional-nav flag before reloading (avoids double-prompt)', () => {
    window.dispatchEvent(pageTransition('pageshow', true));
    expect(isIntentionalNav()).toBe(true);
  });

  it('clears the intentional-nav flag if a bfcache reload throws', () => {
    handle.dispose();
    handle = initPageLifecycleHandlers({
      getRole: () => 'host',
      leaveSession: vi.fn(),
      reload: () => {
        throw new Error('reload rejected');
      },
    });

    expect(() => window.dispatchEvent(pageTransition('pageshow', true))).not.toThrow();
    expect(isIntentionalNav()).toBe(false);
  });

  it('restores the shell without entering another reload loop when the same bfcache document returns', () => {
    handle.dispose();
    let resetPending = false;
    const restorePendingReset = vi.fn(() => {
      resetPending = false;
    });
    reload.mockImplementation(() => {
      resetPending = true;
    });
    handle = initPageLifecycleHandlers({
      getRole: () => 'guest',
      leaveSession: vi.fn(),
      reload,
      hasPendingReset: () => resetPending,
      restorePendingReset,
    });

    window.dispatchEvent(pageTransition('pageshow', true));
    expect(reload).toHaveBeenCalledOnce();
    expect(isIntentionalNav()).toBe(true);

    document.body.classList.remove('fouc-loaded');
    window.dispatchEvent(pageTransition('pageshow', true));

    expect(restorePendingReset).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(isIntentionalNav()).toBe(false);
    expect(document.body.classList.contains('fouc-loaded')).toBe(true);
  });

  it('passes the log message through when a logger is provided', () => {
    // Detach the fixture before installing the logger-specific handler.
    handle.dispose();
    const info = vi.fn();
    handle = initPageLifecycleHandlers({
      getRole: () => 'host',
      leaveSession: vi.fn(),
      reload,
      log: { info },
    });
    window.dispatchEvent(pageTransition('pageshow', true));
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toContain('bfcache');
  });
});

describe('initPageLifecycleHandlers — dispose', () => {
  it('detaches all three listeners when dispose() is called', () => {
    const leaveSession = vi.fn();
    const reload = vi.fn();
    const { dispose } = initPageLifecycleHandlers({
      getRole: () => 'host',
      leaveSession,
      reload,
    });

    dispose();

    const before = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    window.dispatchEvent(pageTransition('pagehide', false));
    expect(leaveSession).not.toHaveBeenCalled();

    window.dispatchEvent(pageTransition('pageshow', true));
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('page lifecycle + session reset integration', () => {
  it('re-arms a fresh reload after an idle pending reset returns from bfcache', () => {
    const originalRaf = window.requestAnimationFrame;
    vi.useFakeTimers();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    document.body.innerHTML = '<main id="app">Session</main>';
    let role = 'host';
    const reloadAction = vi.fn();
    const handle = initPageLifecycleHandlers({
      getRole: () => role,
      leaveSession: vi.fn(),
      reload: () => scheduleSessionReset('Reloading', reloadAction),
      hasPendingReset: isSessionResetPending,
      restorePendingReset: restoreSessionReset,
    });

    try {
      scheduleSessionReset('Leaving', () => {
        role = 'idle';
      });
      vi.advanceTimersByTime(120);
      window.dispatchEvent(pageTransition('pagehide', true));

      window.dispatchEvent(pageTransition('pageshow', true));

      expect(isSessionResetPending()).toBe(true);
      expect(document.getElementById('session-reset-message')?.textContent).toBe('Reloading');
      vi.advanceTimersByTime(120);
      expect(reloadAction).toHaveBeenCalledOnce();
    } finally {
      handle.dispose();
      restoreSessionReset();
      vi.useRealTimers();
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalRaf,
      });
    }
  });
});

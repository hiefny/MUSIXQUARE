/**
 * @vitest-environment jsdom
 *
 * Unit tests for core/page-lifecycle.ts — flag behavior and the
 * beforeunload / pagehide / pageshow handler branch matrix.
 *
 * Each handler test re-initialises with a fresh AbortController-backed
 * handle and disposes it in afterEach, so listeners never accumulate
 * across cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  markIntentionalNav,
  isIntentionalNav,
  initPageLifecycleHandlers,
  __resetIntentionalNavForTests,
  type PageLifecycleHandle,
} from '../page-lifecycle.ts';

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
});

// ─── Flag ─────────────────────────────────────────────────────────

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
});

// ─── beforeunload ─────────────────────────────────────────────────

describe('initPageLifecycleHandlers — beforeunload', () => {
  let handle: PageLifecycleHandle;
  let role: string;
  let leaveSession: ReturnType<typeof vi.fn<() => void>>;
  let reload: ReturnType<typeof vi.fn<() => void>>;

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

// ─── pagehide ─────────────────────────────────────────────────────

describe('initPageLifecycleHandlers — pagehide', () => {
  let handle: PageLifecycleHandle;
  let role: string;
  let leaveSession: ReturnType<typeof vi.fn<() => void>>;

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

// ─── pageshow ─────────────────────────────────────────────────────

describe('initPageLifecycleHandlers — pageshow', () => {
  let handle: PageLifecycleHandle;
  let role: string;
  let reload: ReturnType<typeof vi.fn<() => void>>;

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
  });

  it('does nothing on bfcache restore when role is idle', () => {
    role = 'idle';
    window.dispatchEvent(pageTransition('pageshow', true));
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads on bfcache restore when role is non-idle', () => {
    window.dispatchEvent(pageTransition('pageshow', true));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('flips the intentional-nav flag before reloading (avoids double-prompt)', () => {
    window.dispatchEvent(pageTransition('pageshow', true));
    expect(isIntentionalNav()).toBe(true);
  });

  it('passes the log message through when a logger is provided', () => {
    handle.dispose(); // discard previous default-logger handle
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

// ─── dispose ──────────────────────────────────────────────────────

describe('initPageLifecycleHandlers — dispose', () => {
  it('detaches all three listeners when dispose() is called', () => {
    const leaveSession = vi.fn<() => void>();
    const reload = vi.fn<() => void>();
    const { dispose } = initPageLifecycleHandlers({
      getRole: () => 'host',
      leaveSession,
      reload,
    });

    dispose();

    // Post-dispose: none of the handlers should respond.
    const before = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    window.dispatchEvent(pageTransition('pagehide', false));
    expect(leaveSession).not.toHaveBeenCalled();

    window.dispatchEvent(pageTransition('pageshow', true));
    expect(reload).not.toHaveBeenCalled();
  });
});

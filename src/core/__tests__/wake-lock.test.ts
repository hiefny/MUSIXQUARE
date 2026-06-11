/**
 * @vitest-environment jsdom
 *
 * Pin tests for core/wake-lock.ts (ARCH-APPSCC: extracted from app.ts so
 * ui/setup-shared.ts no longer back-imports the bootstrap module).
 *
 * Pinned behaviors (must stay true — they mirror the pre-extraction app.ts
 * semantics exactly):
 *   - activateNoSleep is idempotent: one underlying request per page life.
 *   - reacquireWakeLockIfActive no-ops until a session activated keep-awake.
 *   - a rejected wakeLock.request is swallowed (no throw, no unhandled
 *     rejection) and does NOT unset the active flag, so the visibilitychange
 *     re-acquire path keeps retrying on later bounces.
 *   - missing Wake Lock API (older browsers / WebViews) is a silent no-op.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  activateNoSleep,
  reacquireWakeLockIfActive,
  __resetWakeLockForTests,
} from '../wake-lock.ts';

vi.mock('../log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const request = vi.fn();

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  __resetWakeLockForTests();
  request.mockReset();
  request.mockResolvedValue({});
  // jsdom has no navigator.wakeLock — install a configurable test shim.
  Object.defineProperty(navigator, 'wakeLock', {
    value: { request },
    configurable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'wakeLock');
});

describe('core/wake-lock', () => {
  it('requests a screen wake lock once; second activateNoSleep call no-ops', () => {
    activateNoSleep();
    activateNoSleep();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('screen');
  });

  it('reacquireWakeLockIfActive no-ops when keep-awake was never activated', () => {
    reacquireWakeLockIfActive();

    expect(request).not.toHaveBeenCalled();
  });

  it('reacquireWakeLockIfActive re-requests after activation', () => {
    activateNoSleep();
    reacquireWakeLockIfActive();

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('swallows a request rejection and keeps the active flag set', async () => {
    request.mockRejectedValueOnce(new Error('NotAllowedError (battery saver)'));

    expect(() => activateNoSleep()).not.toThrow();
    await flushAsync();

    // The flag must survive the rejection: the next visibility bounce
    // retries instead of giving up for the rest of the session.
    reacquireWakeLockIfActive();
    await flushAsync();

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('no-ops gracefully when the Wake Lock API is unavailable', () => {
    Reflect.deleteProperty(navigator, 'wakeLock');

    expect(() => {
      activateNoSleep();
      reacquireWakeLockIfActive();
    }).not.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

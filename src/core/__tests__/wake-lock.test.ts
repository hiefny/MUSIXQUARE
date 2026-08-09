/**
 * @vitest-environment jsdom
 *
 * Contract tests for the desired/current/pending wake-lock state machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetWakeLockForTests,
  activateNoSleep,
  deactivateNoSleep,
  reacquireWakeLockIfActive,
} from '../wake-lock.ts';

vi.mock('../log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const request = vi.fn();

class FakeWakeLockSentinel extends EventTarget {
  released = false;
  readonly release = vi.fn(async () => {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  });

  simulateBrowserRelease(): void {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

let sentinel: FakeWakeLockSentinel;

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  __resetWakeLockForTests();
  request.mockReset();
  sentinel = new FakeWakeLockSentinel();
  request.mockResolvedValue(sentinel);
  Object.defineProperty(navigator, 'wakeLock', {
    value: { request },
    configurable: true,
  });
});

afterEach(() => {
  __resetWakeLockForTests();
  Reflect.deleteProperty(navigator, 'wakeLock');
});

describe('core/wake-lock', () => {
  it('deduplicates activate/reacquire calls while one request is pending', async () => {
    let resolveRequest: ((value: FakeWakeLockSentinel) => void) | undefined;
    request.mockReturnValueOnce(
      new Promise<FakeWakeLockSentinel>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    activateNoSleep();
    activateNoSleep();
    reacquireWakeLockIfActive();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('screen');

    resolveRequest?.(sentinel);
    await flushAsync();
  });

  it('reacquireWakeLockIfActive no-ops before activation', () => {
    reacquireWakeLockIfActive();

    expect(request).not.toHaveBeenCalled();
  });

  it('reacquires after the browser releases the current sentinel', async () => {
    activateNoSleep();
    await flushAsync();
    sentinel.simulateBrowserRelease();

    const replacement = new FakeWakeLockSentinel();
    request.mockResolvedValueOnce(replacement);
    reacquireWakeLockIfActive();

    expect(request).toHaveBeenCalledTimes(2);
    await flushAsync();
  });

  it('releases the current sentinel once and suppresses later re-acquisition', async () => {
    activateNoSleep();
    await flushAsync();

    deactivateNoSleep();
    deactivateNoSleep();
    reacquireWakeLockIfActive();

    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('releases a stale pending result before serving a reactivated intent', async () => {
    let resolveRequest: ((value: FakeWakeLockSentinel) => void) | undefined;
    const lateSentinel = new FakeWakeLockSentinel();
    request.mockReturnValueOnce(
      new Promise<FakeWakeLockSentinel>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    activateNoSleep();
    deactivateNoSleep();
    activateNoSleep();
    reacquireWakeLockIfActive();
    expect(request).toHaveBeenCalledTimes(1);

    resolveRequest?.(lateSentinel);
    await flushAsync();

    expect(lateSentinel.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not reacquire when a pending request resolves after deactivation', async () => {
    let resolveRequest: ((value: FakeWakeLockSentinel) => void) | undefined;
    const lateSentinel = new FakeWakeLockSentinel();
    request.mockReturnValueOnce(
      new Promise<FakeWakeLockSentinel>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    activateNoSleep();
    deactivateNoSleep();
    resolveRequest?.(lateSentinel);
    await flushAsync();
    reacquireWakeLockIfActive();

    expect(lateSentinel.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('swallows a request rejection and retries on the next re-acquire', async () => {
    request.mockRejectedValueOnce(new Error('NotAllowedError (battery saver)'));

    expect(() => activateNoSleep()).not.toThrow();
    await flushAsync();

    reacquireWakeLockIfActive();
    await flushAsync();

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('no-ops gracefully when the Wake Lock API is unavailable', () => {
    Reflect.deleteProperty(navigator, 'wakeLock');

    expect(() => {
      activateNoSleep();
      reacquireWakeLockIfActive();
      deactivateNoSleep();
    }).not.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

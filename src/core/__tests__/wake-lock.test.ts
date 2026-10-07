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
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['rejected', 'already-released'] as const)(
    'serves a foreground re-acquire after an older pending request is %s',
    async (outcome) => {
      let resolveRequest!: (value: FakeWakeLockSentinel) => void;
      let rejectRequest!: (reason: Error) => void;
      request.mockReturnValueOnce(
        new Promise<FakeWakeLockSentinel>((resolve, reject) => {
          resolveRequest = resolve;
          rejectRequest = reject;
        }),
      );

      activateNoSleep();
      // Visibility recovery can arrive before the native request settles.
      reacquireWakeLockIfActive();
      reacquireWakeLockIfActive();
      expect(request).toHaveBeenCalledTimes(1);

      if (outcome === 'rejected') {
        rejectRequest(new Error('NotAllowedError (document became hidden)'));
      } else {
        const released = new FakeWakeLockSentinel();
        released.simulateBrowserRelease();
        resolveRequest(released);
      }
      await flushAsync();

      expect(request).toHaveBeenCalledTimes(2);
      deactivateNoSleep();
      expect(sentinel.release).toHaveBeenCalledTimes(1);
    },
  );

  it('consumes repeated foreground requests once even when the replacement is denied', async () => {
    let rejectRequest!: (reason: Error) => void;
    request.mockReturnValueOnce(
      new Promise<FakeWakeLockSentinel>((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );
    request.mockRejectedValueOnce(new Error('NotAllowedError (battery saver)'));

    activateNoSleep();
    reacquireWakeLockIfActive();
    reacquireWakeLockIfActive();
    rejectRequest(new Error('NotAllowedError (document became hidden)'));
    await flushAsync();
    await flushAsync();
    expect(request).toHaveBeenCalledTimes(2);

    reacquireWakeLockIfActive();
    await flushAsync();
    expect(request).toHaveBeenCalledTimes(3);
    deactivateNoSleep();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('retires a queued foreground re-acquire on deactivation', async () => {
    let rejectRequest!: (reason: Error) => void;
    request.mockReturnValueOnce(
      new Promise<FakeWakeLockSentinel>((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );

    activateNoSleep();
    reacquireWakeLockIfActive();
    deactivateNoSleep();
    rejectRequest(new Error('NotAllowedError (document became hidden)'));
    await flushAsync();
    expect(request).toHaveBeenCalledTimes(1);

    // A later session must not inherit the retired recovery request.
    request.mockRejectedValueOnce(new Error('NotAllowedError (battery saver)'));
    activateNoSleep();
    await flushAsync();
    expect(request).toHaveBeenCalledTimes(2);
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
    expect(request).toHaveBeenCalledTimes(1);

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

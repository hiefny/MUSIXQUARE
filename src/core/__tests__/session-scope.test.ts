import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionScope } from '../session-scope.ts';

describe('SessionScope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('isolates equal timer names across concurrently live scopes', () => {
    const first = new SessionScope();
    const second = new SessionScope();
    const firstFn = vi.fn();
    const secondFn = vi.fn();

    first.timer('poll', firstFn, 100);
    second.timer('poll', secondFn, 200);
    first.dispose();

    vi.advanceTimersByTime(200);
    expect(firstFn).not.toHaveBeenCalled();
    expect(secondFn).toHaveBeenCalledOnce();
  });

  it('replaces a logical timer only inside the same scope', () => {
    const scope = new SessionScope();
    const replaced = vi.fn();
    const current = vi.fn();

    scope.timer('retry', replaced, 100);
    scope.timer('retry', current, 100);
    vi.advanceTimersByTime(100);

    expect(replaced).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });

  it('disposes intervals and refuses timers after abort', () => {
    const scope = new SessionScope();
    const interval = vi.fn();
    const late = vi.fn();

    scope.timer('heartbeat', interval, 50, { interval: true });
    vi.advanceTimersByTime(100);
    expect(interval).toHaveBeenCalledTimes(2);

    scope.dispose();
    scope.timer('late', late, 1);
    vi.advanceTimersByTime(100);

    expect(scope.aborted).toBe(true);
    expect(interval).toHaveBeenCalledTimes(2);
    expect(late).not.toHaveBeenCalled();
  });
});

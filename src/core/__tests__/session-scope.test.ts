import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../log.ts';
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

  it('releases owned resources once in reverse registration order', () => {
    const scope = new SessionScope();
    const order: string[] = [];
    const disposeFirst = scope.own(() => order.push('first'));
    scope.own(() => order.push('second'));
    scope.own(() => order.push('third'));

    scope.dispose();
    scope.dispose();
    disposeFirst();

    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('continues cleanup when one owned resource throws', () => {
    const error = new Error('cleanup failed');
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const scope = new SessionScope();
    const order: string[] = [];
    scope.own(() => order.push('first'));
    scope.own(() => {
      throw error;
    });
    scope.own(() => order.push('third'));

    scope.dispose();

    expect(order).toEqual(['third', 'first']);
    expect(errorLog).toHaveBeenCalledWith('[SessionScope] Owned cleanup failed:', error);
    errorLog.mockRestore();
  });

  it('disposes children with their parent and detaches children that finish early', () => {
    const parent = new SessionScope();
    const inherited = parent.child();
    const finishedEarly = parent.child();
    const inheritedCleanup = vi.fn();
    const earlyCleanup = vi.fn();
    inherited.own(inheritedCleanup);
    finishedEarly.own(earlyCleanup);

    finishedEarly.dispose();
    parent.dispose();

    expect(parent.aborted).toBe(true);
    expect(inherited.aborted).toBe(true);
    expect(finishedEarly.aborted).toBe(true);
    expect(inheritedCleanup).toHaveBeenCalledOnce();
    expect(earlyCleanup).toHaveBeenCalledOnce();
  });

  it('immediately releases resources registered after disposal', () => {
    const scope = new SessionScope();
    const cleanup = vi.fn();
    scope.dispose();

    const disposeLateResource = scope.own(cleanup);
    disposeLateResource();

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('throws at a checkpoint after disposal', () => {
    const scope = new SessionScope();
    expect(() => scope.throwIfAborted()).not.toThrow();

    scope.dispose();

    expect(() => scope.throwIfAborted()).toThrow();
  });
});

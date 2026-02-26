import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bus } from '../events.ts';

beforeEach(() => {
  bus.clear();
});

describe('EventBus', () => {
  it('delivers events to listeners', () => {
    const fn = vi.fn();
    bus.on('test-event', fn);
    bus.emit('test-event', 'hello');
    expect(fn).toHaveBeenCalledWith('hello');
  });

  it('supports multiple listeners on the same event', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    bus.on('multi', fn1);
    bus.on('multi', fn2);
    bus.emit('multi', 42);
    expect(fn1).toHaveBeenCalledWith(42);
    expect(fn2).toHaveBeenCalledWith(42);
  });

  it('unsubscribes via returned function', () => {
    const fn = vi.fn();
    const unsub = bus.on('unsub-test', fn);
    unsub();
    bus.emit('unsub-test');
    expect(fn).not.toHaveBeenCalled();
  });

  it('unsubscribes via off()', () => {
    const fn = vi.fn();
    bus.on('off-test', fn);
    bus.off('off-test', fn);
    bus.emit('off-test');
    expect(fn).not.toHaveBeenCalled();
  });

  it('once() fires only once', () => {
    const fn = vi.fn();
    bus.once('once-test', fn);
    bus.emit('once-test', 'a');
    bus.emit('once-test', 'b');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('clear() removes all listeners for an event', () => {
    const fn = vi.fn();
    bus.on('clear-test', fn);
    bus.clear('clear-test');
    bus.emit('clear-test');
    expect(fn).not.toHaveBeenCalled();
  });

  it('clear() without args removes everything', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    bus.on('a', fn1);
    bus.on('b', fn2);
    bus.clear();
    bus.emit('a');
    bus.emit('b');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('debug() returns listener counts', () => {
    bus.on('x', () => {});
    bus.on('x', () => {});
    bus.on('y', () => {});
    const info = bus.debug();
    expect(info['x']).toBe(2);
    expect(info['y']).toBe(1);
  });

  it('emit does not throw when no listeners exist', () => {
    expect(() => bus.emit('nonexistent')).not.toThrow();
  });

  it('handler errors do not prevent other handlers from running', () => {
    const fn1 = vi.fn(() => { throw new Error('boom'); });
    const fn2 = vi.fn();
    bus.on('err-test', fn1);
    bus.on('err-test', fn2);
    bus.emit('err-test');
    expect(fn1).toHaveBeenCalled();
    expect(fn2).toHaveBeenCalled();
  });
});

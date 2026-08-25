import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bus } from '../events.ts';
import { log } from '../log.ts';

beforeEach(() => {
  bus.clear();
});

describe('EventBus', () => {
  it('delivers events to listeners', () => {
    const fn = vi.fn();
    bus.on('chat:system-message', fn);
    bus.emit('chat:system-message', 'hello');
    expect(fn).toHaveBeenCalledWith('hello');
  });

  it('supports multiple listeners on the same event', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    bus.on('chat:system-message', fn1);
    bus.on('chat:system-message', fn2);
    bus.emit('chat:system-message', 'message');
    expect(fn1).toHaveBeenCalledWith('message');
    expect(fn2).toHaveBeenCalledWith('message');
  });

  it('unsubscribes via returned function', () => {
    const fn = vi.fn();
    const unsub = bus.on('chat:system-message', fn);
    unsub();
    bus.emit('chat:system-message', 'message');
    expect(fn).not.toHaveBeenCalled();
  });

  it('unsubscribes via off()', () => {
    const fn = vi.fn();
    bus.on('chat:system-message', fn);
    bus.off('chat:system-message', fn);
    bus.emit('chat:system-message', 'message');
    expect(fn).not.toHaveBeenCalled();
  });

  it('once() fires only once', () => {
    const fn = vi.fn();
    bus.once('chat:system-message', fn);
    bus.emit('chat:system-message', 'a');
    bus.emit('chat:system-message', 'b');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('clear() removes all listeners for an event', () => {
    const fn = vi.fn();
    bus.on('chat:system-message', fn);
    bus.clear('chat:system-message');
    bus.emit('chat:system-message', 'message');
    expect(fn).not.toHaveBeenCalled();
  });

  it('clear() without args removes everything', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    bus.on('chat:system-message', fn1);
    bus.on('network:peer-disconnected', fn2);
    bus.clear();
    bus.emit('chat:system-message', 'message');
    bus.emit('network:peer-disconnected', 'peer');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('debug() returns listener counts', () => {
    bus.on('chat:system-message', () => {});
    bus.on('chat:system-message', () => {});
    bus.on('network:peer-disconnected', () => {});
    const info = bus.debug();
    expect(info['chat:system-message']).toBe(2);
    expect(info['network:peer-disconnected']).toBe(1);
  });

  it('emit does not throw when no listeners exist', () => {
    expect(() => bus.emit('sync:auto-sync')).not.toThrow();
  });

  it('handler errors do not prevent other handlers from running', () => {
    const fn1 = vi.fn(() => {
      throw new Error('boom');
    });
    const fn2 = vi.fn();
    bus.on('sync:auto-sync', fn1);
    bus.on('sync:auto-sync', fn2);
    bus.emit('sync:auto-sync');
    expect(fn1).toHaveBeenCalled();
    expect(fn2).toHaveBeenCalled();
  });

  it('reports rejected async handlers without leaking an unhandled rejection', async () => {
    const error = new Error('async boom');
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const laterHandler = vi.fn();
    bus.on('sync:auto-sync', async () => {
      throw error;
    });
    bus.on('sync:auto-sync', laterHandler);

    bus.emit('sync:auto-sync');
    await Promise.resolve();

    expect(laterHandler).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      '[EventBus] Async handler for "sync:auto-sync" rejected:',
      error,
    );
    errorLog.mockRestore();
  });

  it('reports rejection from a once handler after removing it', async () => {
    const error = new Error('once boom');
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const handler = vi.fn(async () => {
      throw error;
    });
    bus.once('sync:auto-sync', handler);

    bus.emit('sync:auto-sync');
    bus.emit('sync:auto-sync');
    await Promise.resolve();

    expect(handler).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      '[EventBus] Async handler for "sync:auto-sync" rejected:',
      error,
    );
    errorLog.mockRestore();
  });
});

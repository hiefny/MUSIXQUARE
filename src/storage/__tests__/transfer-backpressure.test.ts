/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTransferCapacity, waitForTransferCapacity } from '../transfer-backpressure.ts';
import type { DataConnection } from '../../types/index.ts';

function fixture(bufferedAmount = 2048) {
  const channel = Object.assign(new EventTarget(), {
    bufferedAmount,
    bufferedAmountLowThreshold: 19,
    readyState: 'open',
  });
  const add = vi.spyOn(channel, 'addEventListener');
  const remove = vi.spyOn(channel, 'removeEventListener');
  const conn = { open: true, dataChannel: channel } as unknown as DataConnection;
  return { channel, conn, add, remove };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('direct transfer capacity waits', () => {
  it('returns ready without listeners or timers when already within the window', async () => {
    const { conn, channel, add } = fixture(1024);
    await expect(waitForTransferCapacity(conn, 1024, 5000, () => true)).resolves.toBe('ready');
    expect(add).not.toHaveBeenCalled();
    expect(channel.bufferedAmountLowThreshold).toBe(19);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resumes from a low-watermark event before the 50 ms fallback and releases ownership', async () => {
    const { conn, channel, add, remove } = fixture();
    const pending = waitForTransferCapacity(conn, 1024, 5000, () => true);
    expect(channel.bufferedAmountLowThreshold).toBe(1024);
    await vi.advanceTimersByTimeAsync(2);
    channel.bufferedAmount = 1024;
    channel.dispatchEvent(new Event('bufferedamountlow'));
    await expect(pending).resolves.toBe('ready');
    expect(channel.bufferedAmountLowThreshold).toBe(19);
    expect(add).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the fallback after a spurious low-watermark event', async () => {
    const { conn, channel } = fixture();
    let settled = false;
    const pending = waitForTransferCapacity(conn, 1024, 5000, () => true).then((value) => {
      settled = true;
      return value;
    });
    channel.dispatchEvent(new Event('bufferedamountlow'));
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(49);
    await expect(pending).resolves.toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'error'] as const)(
    'settles a channel %s event without waiting for the fallback',
    async (event) => {
      const { conn, channel, remove } = fixture();
      const pending = waitForTransferCapacity(conn, 1024, 5000, () => true);
      channel.dispatchEvent(new Event(event));
      await expect(pending).resolves.toBe('stopped');
      expect(remove).toHaveBeenCalledTimes(3);
      expect(channel.bufferedAmountLowThreshold).toBe(19);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not accept a draining stale channel after the connection installs a successor', async () => {
    const { conn, channel } = fixture();
    const pending = waitForTransferCapacity(conn, 1024, 5000, () => true);
    const replacement = fixture(0).channel;
    conn.dataChannel = replacement as unknown as RTCDataChannel;
    channel.bufferedAmount = 0;
    channel.dispatchEvent(new Event('bufferedamountlow'));
    await expect(pending).resolves.toBe('stopped');
    expect(replacement.bufferedAmountLowThreshold).toBe(19);
    expect(channel.bufferedAmountLowThreshold).toBe(19);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes a cancelled owner on the bounded fallback even if the channel emits nothing', async () => {
    const { conn, channel, remove } = fixture();
    let current = true;
    const pending = waitForTransferCapacity(conn, 1024, 5000, () => current);
    current = false;
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe('stopped');
    expect(remove).toHaveBeenCalledTimes(3);
    expect(channel.bufferedAmountLowThreshold).toBe(19);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps parallel high/low window waiters independent and restores the original threshold last', async () => {
    const { conn, channel } = fixture(4096);
    let lowSettled = false;
    const low = waitForTransferCapacity(conn, 1024, 5000, () => true).then((value) => {
      lowSettled = true;
      return value;
    });
    const high = waitForTransferCapacity(conn, 2048, 5000, () => true);
    expect(channel.bufferedAmountLowThreshold).toBe(2048);
    channel.bufferedAmount = 2048;
    channel.dispatchEvent(new Event('bufferedamountlow'));
    await expect(high).resolves.toBe('ready');
    expect(lowSettled).toBe(false);
    expect(channel.bufferedAmountLowThreshold).toBe(1024);
    channel.bufferedAmount = 1024;
    channel.dispatchEvent(new Event('bufferedamountlow'));
    await expect(low).resolves.toBe('ready');
    expect(channel.bufferedAmountLowThreshold).toBe(19);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('one waiter timing out neither settles nor detaches its longer-lived sibling', async () => {
    const { conn, channel } = fixture(4096);
    const short = waitForTransferCapacity(conn, 2048, 20, () => true);
    const long = waitForTransferCapacity(conn, 1024, 5000, () => true);
    await vi.advanceTimersByTimeAsync(20);
    await expect(short).resolves.toBe('timeout');
    expect(channel.bufferedAmountLowThreshold).toBe(1024);
    channel.bufferedAmount = 0;
    channel.dispatchEvent(new Event('bufferedamountlow'));
    await expect(long).resolves.toBe('ready');
    expect(channel.bufferedAmountLowThreshold).toBe(19);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overwrite a threshold assigned by another owner during the wait', async () => {
    const { conn, channel } = fixture();
    const pending = waitForTransferCapacity(conn, 1024, 5000, () => true);
    channel.bufferedAmountLowThreshold = 777;
    channel.bufferedAmount = 0;
    channel.dispatchEvent(new Event('bufferedamountlow'));
    await pending;
    expect(channel.bufferedAmountLowThreshold).toBe(777);
  });

  it('uses polling for legacy connection facades without event methods', async () => {
    const channel = { bufferedAmount: 2048 };
    const conn = { open: true, dataChannel: channel } as unknown as DataConnection;
    const pending = waitForTransferCapacity(conn, 1024, 5000, () => true);
    channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the fallback if the channel rejects its threshold setter', async () => {
    const { conn, channel } = fixture();
    Object.defineProperty(channel, 'bufferedAmountLowThreshold', {
      get: () => 19,
      set: () => {
        throw new Error('unsupported');
      },
    });
    const pending = waitForTransferCapacity(conn, 1024, 5000, () => true);
    channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the initial check/listener registration race without waiting for an event', async () => {
    const { conn, channel, add } = fixture();
    add.mockImplementation((...args) => {
      EventTarget.prototype.addEventListener.call(channel, ...args);
      channel.bufferedAmount = 0;
    });
    await expect(waitForTransferCapacity(conn, 1024, 5000, () => true)).resolves.toBe('ready');
    expect(channel.bufferedAmountLowThreshold).toBe(19);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans partial event registration and falls back when a channel facade throws', async () => {
    const { conn, channel, add, remove } = fixture();
    add.mockImplementation((...args) => {
      if (args[0] === 'close') throw new Error('unsupported event');
      EventTarget.prototype.addEventListener.call(channel, ...args);
    });
    const pending = waitForTransferCapacity(conn, 1024, 5000, () => true);
    expect(channel.bufferedAmountLowThreshold).toBe(19);
    expect(remove).toHaveBeenCalledTimes(3);
    channel.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('receiver credit and native capacity compose without a shared backlog', () => {
  function credited(bufferedAmount = 0) {
    const base = fixture(bufferedAmount);
    const listeners = new Set<() => void>();
    let remaining = 0;
    const flow = {
      hasCapacity: (bytes: number) => bytes <= remaining,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    Object.defineProperty(base.conn, 'bulkFlowControl', { value: flow, configurable: true });
    return {
      ...base,
      flow,
      listeners,
      grant(bytes: number) {
        remaining = bytes;
        for (const listener of listeners) listener();
      },
    };
  }

  it('waits with an empty native queue and wakes from receipt before the polling tick', async () => {
    const target = credited();
    const pending = waitForTransferCapacity(target.conn, 1024, 5000, () => true, 73);
    expect(hasTransferCapacity(target.conn, 1024, 73)).toBe(false);
    expect(target.listeners.size).toBe(1);
    target.grant(72);
    expect(target.listeners.size).toBe(1);
    target.grant(73);
    await expect(pending).resolves.toBe('ready');
    expect(target.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires both native drain and receiver credit, in either arrival order', async () => {
    for (const creditFirst of [true, false]) {
      const target = credited(2048);
      const pending = waitForTransferCapacity(target.conn, 1024, 5000, () => true, 73);
      const drain = () => {
        target.channel.bufferedAmount = 0;
        target.channel.dispatchEvent(new Event('bufferedamountlow'));
      };
      if (creditFirst) target.grant(73);
      else drain();
      expect(target.listeners.size).toBe(1);
      if (creditFirst) drain();
      else target.grant(73);
      await expect(pending).resolves.toBe('ready');
      expect(target.listeners.size).toBe(0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out missing receipts without silently reverting to the native queue', async () => {
    const target = credited();
    const pending = waitForTransferCapacity(target.conn, 1024, 150, () => true, 73);
    await vi.advanceTimersByTimeAsync(150);
    await expect(pending).resolves.toBe('timeout');
    expect(target.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on cancellation and releases the receipt subscription even without new receipts', async () => {
    const target = credited();
    let current = true;
    const pending = waitForTransferCapacity(target.conn, 1024, 5000, () => current, 73);
    current = false;
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe('stopped');
    expect(target.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not inherit a replaced credit authority on the same connection facade', async () => {
    const target = credited();
    const pending = waitForTransferCapacity(target.conn, 1024, 5000, () => true, 73);
    Object.defineProperty(target.conn, 'bulkFlowControl', { value: credited().flow });
    target.grant(73);
    await expect(pending).resolves.toBe('stopped');
    expect(target.listeners.size).toBe(0);
  });

  it('keeps receivers and differently sized final-chunk waiters independent', async () => {
    const target = credited();
    const other = credited();
    const small = waitForTransferCapacity(target.conn, 1024, 5000, () => true, 7);
    const large = waitForTransferCapacity(target.conn, 1024, 5000, () => true, 73);
    const independent = waitForTransferCapacity(other.conn, 1024, 5000, () => true, 7);
    target.grant(7);
    await expect(small).resolves.toBe('ready');
    expect(target.listeners.size).toBe(1);
    expect(other.listeners.size).toBe(1);
    target.grant(73);
    other.grant(7);
    await expect(large).resolves.toBe('ready');
    await expect(independent).resolves.toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });
});

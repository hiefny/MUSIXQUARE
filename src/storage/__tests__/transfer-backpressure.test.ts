/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForTransferCapacity } from '../transfer-backpressure.ts';
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

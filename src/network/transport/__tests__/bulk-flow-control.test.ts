import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../../core/constants.ts';
import { BulkFlowControl, creditedFileChunkBytes } from '../bulk-flow-control.ts';

type Frame = Record<string, unknown>;
const flows: BulkFlowControl[] = [];

function endpoint() {
  const frames: Frame[] = [];
  const flow = new BulkFlowControl((frame) => frames.push(frame));
  flows.push(flow);
  return { flow, frames };
}

function pair() {
  const sender = endpoint();
  const receiver = endpoint();
  sender.flow.start();
  receiver.flow.start();
  sender.flow.handleControl(receiver.frames[0], true);
  receiver.flow.handleControl(sender.frames[0], true);
  return { sender, receiver };
}

function receipt(receiver: ReturnType<typeof endpoint>): Frame {
  return receiver.frames.filter((frame) => frame.kind === 'receipt').at(-1)!;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const flow of flows.splice(0)) flow.dispose();
  vi.useRealTimers();
});

describe('connection-owned bulk receipt credit', () => {
  it('allows only two full payload chunks while negotiating, then falls back for an old peer', () => {
    const { flow, frames } = endpoint();
    expect(flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    flow.start();
    flow.start();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'mxqr-bulk-flow', version: 1, kind: 'hello' });
    const wake = vi.fn();
    flow.subscribe(wake);
    for (let index = 0; index < 2; index++) {
      expect(flow.hasCapacity(CHUNK_SIZE)).toBe(true);
      flow.noteSent(CHUNK_SIZE);
    }
    expect(flow.hasCapacity(1)).toBe(false);
    vi.advanceTimersByTime(999);
    expect(flow.hasCapacity(1)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(flow.hasCapacity(CHUNK_SIZE)).toBe(true);
    expect(wake).toHaveBeenCalledOnce();
  });

  it('keeps a negotiated window bounded until cumulative receipts arrive, without timeout fallback', () => {
    const { sender, receiver } = pair();
    sender.flow.noteSent(CHUNK_SIZE);
    sender.flow.noteSent(CHUNK_SIZE);
    expect(sender.flow.hasCapacity(1)).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(sender.flow.hasCapacity(1)).toBe(false);
    receiver.flow.noteReceived(CHUNK_SIZE);
    sender.flow.handleControl(receipt(receiver), true);
    expect(sender.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
    sender.flow.noteSent(CHUNK_SIZE);
    expect(sender.flow.hasCapacity(1)).toBe(false);
    receiver.flow.noteReceived(CHUNK_SIZE);
    receiver.flow.noteReceived(CHUNK_SIZE);
    sender.flow.handleControl(receipt(receiver), true);
    expect(sender.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
  });

  it('preserves lifetime counts when a late hello activates after legacy sends', () => {
    const sender = endpoint();
    const receiver = endpoint();
    sender.flow.start();
    receiver.flow.start();
    vi.advanceTimersByTime(1000);
    for (let index = 0; index < 10; index++) {
      expect(sender.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
      sender.flow.noteSent(CHUNK_SIZE);
      receiver.flow.noteReceived(CHUNK_SIZE);
    }
    sender.flow.handleControl(receiver.frames[0], true);
    expect(sender.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    receiver.flow.handleControl(sender.frames[0], true);
    expect(receipt(receiver).receivedBytes).toBe(10 * CHUNK_SIZE);
    sender.flow.handleControl(receipt(receiver), true);
    expect(sender.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
  });

  it('remembers a hello and received bytes arriving before local open', () => {
    const sender = endpoint();
    const receiver = endpoint();
    sender.flow.start();
    receiver.flow.handleControl(sender.frames[0], true);
    sender.flow.noteSent(123);
    receiver.flow.noteReceived(123);
    expect(receiver.frames).toHaveLength(0);
    receiver.flow.start();
    expect(receiver.frames.map((frame) => frame.kind)).toEqual(['hello', 'receipt']);
    expect(receipt(receiver).receivedBytes).toBe(123);
    sender.flow.handleControl(receiver.frames[0], true);
    sender.flow.handleControl(receipt(receiver), true);
    expect(sender.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
  });

  it('flushes one small tail receipt within 20ms and cancels its timer after a threshold flush', () => {
    const { receiver } = pair();
    const initial = receiver.frames.length;
    receiver.flow.noteReceived(7);
    receiver.flow.noteReceived(13);
    vi.advanceTimersByTime(19);
    expect(receiver.frames).toHaveLength(initial);
    vi.advanceTimersByTime(1);
    expect(receipt(receiver).receivedBytes).toBe(20);
    receiver.flow.noteReceived(10);
    receiver.flow.noteReceived(CHUNK_SIZE);
    const thresholdCount = receiver.frames.length;
    expect(receipt(receiver).receivedBytes).toBe(CHUNK_SIZE + 30);
    vi.advanceTimersByTime(100);
    expect(receiver.frames).toHaveLength(thresholdCount);
  });

  it('ignores replay, regression, wrong nonce, overshoot and malformed receipts without waking senders', () => {
    const { sender, receiver } = pair();
    sender.flow.noteSent(CHUNK_SIZE);
    sender.flow.noteSent(CHUNK_SIZE);
    receiver.flow.noteReceived(CHUNK_SIZE);
    const valid = receipt(receiver);
    const wake = vi.fn();
    sender.flow.subscribe(wake);
    for (const changes of [
      { receivedBytes: -1 },
      { receivedBytes: 0 },
      { receivedBytes: 0.5 },
      { receivedBytes: Number.NaN },
      { receivedBytes: Number.POSITIVE_INFINITY },
      { receivedBytes: Number.MAX_SAFE_INTEGER + 1 },
      { receivedBytes: 2 * CHUNK_SIZE + 1 },
      { nonce: 'f'.repeat(32) },
      { nonce: '' },
      { version: 2 },
      { extra: true },
    ]) {
      expect(sender.flow.handleControl({ ...valid, ...changes }, true)).toBe(true);
      expect(sender.flow.hasCapacity(1)).toBe(false);
    }
    expect(wake).not.toHaveBeenCalled();
    sender.flow.handleControl(valid, false);
    expect(wake).not.toHaveBeenCalled();
    sender.flow.handleControl(valid, true);
    expect(wake).toHaveBeenCalledOnce();
    sender.flow.handleControl(valid, true);
    sender.flow.handleControl({ ...valid, receivedBytes: 1 }, true);
    expect(wake).toHaveBeenCalledOnce();
  });

  it('does not reset counters or answer repeated hellos, and cannot transfer credit to a replacement', () => {
    const { sender, receiver } = pair();
    const successor = endpoint();
    successor.flow.start();
    successor.flow.handleControl(receiver.frames[0], true);
    sender.flow.noteSent(CHUNK_SIZE);
    sender.flow.noteSent(CHUNK_SIZE);
    successor.flow.noteSent(CHUNK_SIZE);
    successor.flow.noteSent(CHUNK_SIZE);
    receiver.flow.noteReceived(CHUNK_SIZE);
    const count = sender.frames.length;
    sender.flow.handleControl(receiver.frames[0], true);
    sender.flow.handleControl({ ...receiver.frames[0], nonce: 'a'.repeat(32) }, true);
    expect(sender.frames).toHaveLength(count);
    expect(sender.flow.hasCapacity(1)).toBe(false);
    successor.flow.handleControl(receipt(receiver), true);
    expect(successor.flow.hasCapacity(1)).toBe(false);
  });

  it('disposes all timers, wakes pending waiters once, and never reopens capacity', () => {
    const { sender, receiver } = pair();
    receiver.flow.noteReceived(1);
    const wake = vi.fn();
    const unsubscribe = receiver.flow.subscribe(wake);
    receiver.flow.dispose();
    receiver.flow.dispose();
    unsubscribe();
    const sent = receiver.frames.length;
    vi.advanceTimersByTime(60_000);
    receiver.flow.start();
    receiver.flow.noteReceived(CHUNK_SIZE);
    receiver.flow.handleControl(sender.frames[0], true);
    expect(receiver.flow.hasCapacity(0)).toBe(false);
    expect(wake).toHaveBeenCalledOnce();
    expect(receiver.frames).toHaveLength(sent);
  });

  it('isolates a stalled peer from 99 other peer windows without per-chunk timers', () => {
    const pairs = Array.from({ length: 100 }, () => pair());
    for (const { sender } of pairs) {
      sender.flow.noteSent(CHUNK_SIZE);
      sender.flow.noteSent(CHUNK_SIZE);
    }
    for (const { sender, receiver } of pairs.slice(1)) {
      receiver.flow.noteReceived(CHUNK_SIZE);
      receiver.flow.noteReceived(CHUNK_SIZE);
      sender.flow.handleControl(receipt(receiver), true);
      expect(sender.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
    }
    expect(pairs[0]!.sender.flow.hasCapacity(1)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retires credit on a failed hello instead of silently falling back or retrying forever', () => {
    const failed = vi.fn();
    const flow = new BulkFlowControl(() => {
      throw new Error('control-send-failed');
    }, failed);
    flows.push(flow);
    flow.start();
    expect(failed).toHaveBeenCalledOnce();
    expect(flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps network receipt separate from FILE_END, PRELOAD_ACK and operator uploads', () => {
    const chunk = new Uint8Array(CHUNK_SIZE);
    expect(creditedFileChunkBytes({ type: MSG.FILE_CHUNK, chunk })).toBe(CHUNK_SIZE);
    expect(creditedFileChunkBytes({ type: MSG.PRELOAD_CHUNK, chunk: chunk.buffer })).toBe(
      CHUNK_SIZE,
    );
    expect(creditedFileChunkBytes({ type: MSG.FILE_CHUNK, chunk: chunk.subarray(1) })).toBe(
      CHUNK_SIZE - 1,
    );
    for (const type of [MSG.FILE_END, MSG.PRELOAD_ACK, MSG.OPERATOR_FILE_UPLOAD_CHUNK]) {
      expect(creditedFileChunkBytes({ type, chunk })).toBe(0);
    }
    expect(creditedFileChunkBytes({ type: MSG.FILE_CHUNK, chunk: new Uint8Array(0) })).toBe(0);
    expect(
      creditedFileChunkBytes({ type: MSG.FILE_CHUNK, chunk: new Uint8Array(CHUNK_SIZE + 1) }),
    ).toBe(0);
  });
});

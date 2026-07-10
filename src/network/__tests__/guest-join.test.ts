import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, getState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection, PeerInstance } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  getPeer: vi.fn(),
  detectConnectionType: vi.fn(),
  startWorkerTimer: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: mocks.showToast,
}));

vi.mock('../peer-state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../peer-state.ts')>();
  return {
    ...actual,
    getPeer: mocks.getPeer,
    detectConnectionType: mocks.detectConnectionType,
  };
});

vi.mock('../sync-worker.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync-worker.ts')>();
  return {
    ...actual,
    startWorkerTimer: mocks.startWorkerTimer,
  };
});

import { joinSession, setInitNetwork } from '../guest.ts';

type FiringConn = DataConnection & {
  fire: (event: string, ...args: unknown[]) => void;
  open: boolean;
};

function makeFakeConn(peerId: string): FiringConn {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    peer: peerId,
    open: false,
    send: vi.fn(),
    close: vi.fn(),
    off: vi.fn(),
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    fire(event: string, ...args: unknown[]) {
      if (event === 'open') (this as { open: boolean }).open = true;
      for (const cb of [...(handlers.get(event) ?? [])]) cb(...args);
    },
  } as unknown as FiringConn;
}

function makeFakePeer(): { peer: PeerInstance; conns: FiringConn[]; connect: ReturnType<typeof vi.fn> } {
  const conns: FiringConn[] = [];
  const connect = vi.fn((hostId: string) => {
    const conn = makeFakeConn(hostId);
    conns.push(conn);
    return conn;
  });
  const peer = { open: true, connect } as unknown as PeerInstance;
  return { peer, conns, connect };
}

beforeEach(() => {
  vi.useRealTimers();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  mocks.detectConnectionType.mockResolvedValue('local');
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('joinSession reconnect racing', () => {
  it('ignores a duplicate joinSession call while the first attempt is still connecting', () => {
    vi.useFakeTimers();
    const { peer, connect } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);

    joinSession('HOST01');
    expect(getState('network.isConnecting')).toBe(true);

    joinSession('HOST01');
    joinSession('HOST02');

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith('HOST01', expect.anything());
  });

  it('does not let a replaced connection’s late close nullify the new host connection', async () => {
    vi.useFakeTimers();
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    bus.on('network:error', errors);

    joinSession('HOST01');
    const first = conns[0];
    first.fire('open');
    expect(getState('network.hostConn')).toBe(first);

    // Transport blip: the channel is dead but PeerJS has not delivered the
    // close event yet, and the user re-joins in that window.
    first.open = false;
    joinSession('HOST01');
    const second = conns[1];
    second.fire('open');
    expect(getState('network.hostConn')).toBe(second);

    first.fire('close');

    expect(getState('network.hostConn')).toBe(second);
    expect(getState('network.isConnecting')).toBe(false);

    // The successful open also cleared the join timeout — advancing past it
    // must not surface HOST_UNREACHABLE against the live connection. The
    // replaced conn's close must not surface HOST_DISCONNECTED either: the
    // consumer would show a "disconnected — reconnect?" dialog (and stop
    // YouTube playback) over the live session.
    await vi.advanceTimersByTimeAsync(10_000);
    const errorMessages = errors.mock.calls.map((call) => (call[0] as Error)?.message);
    expect(errorMessages).not.toContain('HOST_UNREACHABLE');
    expect(errorMessages).not.toContain('HOST_DISCONNECTED');
    expect(getState('network.hostConn')).toBe(second);
  });

  it('a replaced connection closing mid-connect neither resets isConnecting nor surfaces errors', () => {
    vi.useFakeTimers();
    const { peer, conns, connect } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    bus.on('network:error', errors);

    joinSession('HOST01');
    const first = conns[0];
    first.fire('open');

    // Rejoining during an undetected transport failure replaces the stale
    // connection while the successor is still connecting.
    first.open = false;
    joinSession('HOST01');
    expect(getState('network.isConnecting')).toBe(true);

    // conn1's late close/error land BEFORE conn2 opens. They must be inert:
    // no isConnecting reset (would defeat the duplicate-join guard), no
    // spurious HOST_DISCONNECTED / HOST_CONNECTION_ERROR dialog.
    first.fire('close');
    first.fire('error', new Error('boom'));

    expect(getState('network.isConnecting')).toBe(true);
    expect(errors).not.toHaveBeenCalled();

    joinSession('HOST01');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('times out with HOST_UNREACHABLE when the data channel never opens within 10s', () => {
    vi.useFakeTimers();
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    bus.on('network:error', errors);

    joinSession('HOST01');
    const conn = conns[0];

    vi.advanceTimersByTime(9_999);
    expect(errors).not.toHaveBeenCalled();
    expect(getState('network.isConnecting')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(getState('network.isConnecting')).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
    expect((errors.mock.calls[0][0] as Error).message).toBe('HOST_UNREACHABLE');
  });
});

describe('joinSession capability-challenge cancel (F-2401)', () => {
  it('routes a cancelled init to a silent join-UI restore, not a network:error toast', async () => {
    mocks.getPeer.mockReturnValue(null);
    setInitNetwork(() => Promise.reject(new Error('NETWORK_INIT_CANCELLED')));

    const errors = vi.fn();
    const cancelled = vi.fn();
    bus.on('network:error', errors);
    bus.on('setup:guest-join-cancelled', cancelled);

    joinSession('HOST01');
    // Flush the _initNetwork(null).then().catch() chain (real timers).
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Cancellation restores the join UI without surfacing a connection error.
    expect(errors).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(getState('network.isConnecting')).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection, PeerInstance } from '../../types/index.ts';
import { registerProRoomSignalingEpochAdvanceHandler } from '../../pro-room/lifecycle-hook.ts';
import { resetProRoomTransportRecovery } from '../../pro-room/transport-recovery.ts';

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

import { invalidateGuestJoinAttempt, joinSession, setInitNetwork } from '../guest.ts';

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

function makeFakePeer(): {
  peer: PeerInstance;
  conns: FiringConn[];
  connect: ReturnType<typeof vi.fn>;
} {
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
  resetProRoomTransportRecovery();
  mocks.detectConnectionType.mockResolvedValue('local');
});

afterEach(() => {
  registerProRoomSignalingEpochAdvanceHandler(null);
  clearAllManagedTimers();
  vi.useRealTimers();
});

describe('joinSession reconnect racing', () => {
  it.each(['close', 'error'] as const)(
    'turns a PRO host-connection %s into one topology recovery without a network error',
    (event) => {
      const { peer, conns } = makeFakePeer();
      mocks.getPeer.mockReturnValue(peer);
      const errors = vi.fn();
      const transportFailures = vi.fn();
      const recover = vi.fn();
      bus.on('network:error', errors);
      bus.on('pro-room:transport-connect-failure', transportFailures);
      registerProRoomSignalingEpochAdvanceHandler(recover);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: 'participant_owner',
        epoch: 4,
        snapshotRevision: 8,
        capabilities: [],
      });
      setState('setup.sessionStarted', true);

      joinSession('000001');
      const conn = conns[0];
      conn.fire('open');
      if (event === 'error') conn.fire('error', new Error('coordinator left'));
      else conn.fire('close');

      expect(getState('network.hostConn')).toBeNull();
      expect(errors).not.toHaveBeenCalled();
      expect(transportFailures).toHaveBeenCalledOnce();
      expect((transportFailures.mock.calls[0][0] as Error).message).toBe(
        event === 'error' ? 'HOST_CONNECTION_ERROR' : 'HOST_DISCONNECTED',
      );
      expect(recover).toHaveBeenCalledOnce();
      expect(mocks.showToast).toHaveBeenCalledOnce();
    },
  );

  it('rejects an active PRO handoff immediately when the replacement connection fails pre-open', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    const transportFailures = vi.fn();
    const recover = vi.fn();
    bus.on('network:error', errors);
    bus.on('pro-room:transport-connect-failure', transportFailures);
    registerProRoomSignalingEpochAdvanceHandler(recover);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'participant_owner',
      epoch: 4,
      snapshotRevision: 8,
      capabilities: [],
    });
    setState('setup.sessionStarted', true);

    joinSession('000001');
    conns[0].fire('error', new Error('replacement unavailable'));

    expect(getState('network.isConnecting')).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    expect(transportFailures).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(mocks.showToast).toHaveBeenCalledOnce();
  });

  it('preserves the ordinary-room HOST_DISCONNECTED error contract', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    const recover = vi.fn();
    bus.on('network:error', errors);
    registerProRoomSignalingEpochAdvanceHandler(recover);

    joinSession('HOST01');
    conns[0].fire('open');
    conns[0].fire('close');

    expect(errors).toHaveBeenCalledOnce();
    expect((errors.mock.calls[0][0] as Error).message).toBe('HOST_DISCONNECTED');
    expect(recover).not.toHaveBeenCalled();
  });

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

  it('ignores connection-type detection that resolves from a replaced host connection', async () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    let resolveFirst!: (value: 'remote') => void;
    let resolveSecond!: (value: 'local') => void;
    mocks.detectConnectionType
      .mockImplementationOnce(() => new Promise<'remote'>((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise<'local'>((resolve) => (resolveSecond = resolve)));

    joinSession('HOST01');
    const first = conns[0];
    first.fire('open');
    first.open = false;

    joinSession('HOST01');
    const second = conns[1];
    second.fire('open');
    expect(getState('network.hostConn')).toBe(second);

    resolveFirst('remote');
    await Promise.resolve();
    expect(getState('network.connectionType')).toBe('unknown');

    resolveSecond('local');
    await Promise.resolve();
    expect(getState('network.connectionType')).toBe('local');
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
    const successes = vi.fn();
    bus.on('network:error', errors);
    bus.on('setup:guest-join-success', successes);

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

    // A transport may already have queued an open callback when close() wins.
    // That stale event must not resurrect the failed join.
    conn.fire('open');
    expect(getState('network.hostConn')).toBeNull();
    expect(getState('network.isConnecting')).toBe(false);
    expect(successes).not.toHaveBeenCalled();
  });

  it('does not revive a join when open arrives after a pre-open error', async () => {
    vi.useFakeTimers();
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    const successes = vi.fn();
    bus.on('network:error', errors);
    bus.on('setup:guest-join-success', successes);

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('error', new Error('pre-open failed'));

    expect(getState('network.isConnecting')).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);

    conn.fire('open');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getState('network.hostConn')).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(successes).not.toHaveBeenCalled();
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

  it('does not let guest A cancellation overwrite a newly started guest B join', async () => {
    let rejectGuestA!: (reason?: unknown) => void;
    const guestAInit = new Promise<string>((_resolve, reject) => {
      rejectGuestA = reject;
    });
    let resolveGuestB!: (id: string) => void;
    const guestBInit = new Promise<string>((resolve) => {
      resolveGuestB = resolve;
    });
    const cancelled = vi.fn();
    const errors = vi.fn();
    bus.on('setup:guest-join-cancelled', cancelled);
    bus.on('network:error', errors);

    mocks.getPeer.mockReturnValue(null);
    setInitNetwork(() => guestAInit);
    joinSession('HOST01');
    expect(getState('network.isConnecting')).toBe(true);

    // Mirrors the generation invalidation performed by setup cancellation,
    // followed immediately by a second join attempt.
    invalidateGuestJoinAttempt();
    setState('network.isConnecting', false);
    setInitNetwork(() => guestBInit);
    joinSession('HOST02');
    expect(getState('network.isConnecting')).toBe(true);

    rejectGuestA(new Error('NETWORK_INIT_CANCELLED'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getState('network.isConnecting')).toBe(true);
    expect(cancelled).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();

    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    resolveGuestB('GUEST-B');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conns).toHaveLength(1);

    conns[0].fire('open');
    expect(getState('network.hostConn')).toBe(conns[0]);
    expect(getState('network.isConnecting')).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, getState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection, PeerInstance } from '../../types/index.ts';
import { registerProRoomSignalingEpochAdvanceHandler } from '../../pro-room/lifecycle-hook.ts';
import { resetProRoomTransportRecovery } from '../../pro-room/transport-recovery.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';

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

import {
  initGuestProtocolHandlers,
  invalidateGuestJoinAttempt,
  joinSession,
  setInitNetwork,
} from '../guest.ts';
import { initProtocol } from '../protocol.ts';

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

function joinBootstrapFrames(): Record<string, unknown>[] {
  return [
    {
      type: MSG.PLAYLIST_UPDATE,
      list: [],
      revision: 0,
      currentQueueItemId: null,
      bootstrap: true,
    },
    { type: MSG.REPEAT_MODE, value: 0, _bootstrap: true },
    { type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true },
  ];
}

function installSuccessfulBootstrapApply(): () => void {
  return bus.on('network:peer-bootstrap-apply', (frame, conn, acknowledge) => {
    if ((frame as { type?: string })?.type === MSG.PLAYLIST_UPDATE) {
      markQueueAuthorityReady(conn);
    }
    acknowledge(true);
  });
}

function fireJoinBootstrap(conn: FiringConn, includeWelcome = true): void {
  if (includeWelcome) {
    conn.fire('data', { type: MSG.WELCOME, lockChannel: false, label: 'Guest' });
  }
  for (const frame of joinBootstrapFrames()) conn.fire('data', frame);
}

function openAndCompleteStandardJoin(conn: FiringConn, includeWelcome = true): void {
  const stopApply = installSuccessfulBootstrapApply();
  try {
    conn.fire('open');
    fireJoinBootstrap(conn, includeWelcome);
  } finally {
    stopApply();
  }
}

function sentMessages(conn: FiringConn): Array<Record<string, unknown>> {
  return vi.mocked(conn.send).mock.calls.map(([message]) => message as Record<string, unknown>);
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
  it('replays pre-open WELCOME but fails closed on media before queue bootstrap', async () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const inbound: unknown[] = [];
    const errors = vi.fn();
    const successes = vi.fn();
    bus.on('network:data', (data: unknown) => inbound.push(data));
    bus.on('network:error', errors);
    bus.on('setup:guest-join-success', successes);
    initGuestProtocolHandlers();
    initProtocol();

    joinSession('HOST01');
    const conn = conns[0];
    const chunk = new Uint8Array([7, 11, 13, 17]);
    conn.fire('data', {
      type: MSG.WELCOME,
      label: 'Late guest',
      chatFrozen: true,
      slowmodeSeconds: 7,
      filterEnabled: true,
    });
    conn.fire('data', {
      type: MSG.FILE_CHUNK,
      chunk,
      chunkIndex: 0,
      queueItemId: '00000000-0000-4000-8000-000000000001',
      sessionId: 1,
      name: 'bootstrap.mp3',
      total: 1,
      size: chunk.byteLength,
    });

    expect(inbound).toEqual([]);
    expect(getState('network.chatFrozen')).toBe(false);

    conn.fire('open');
    await Promise.resolve();

    expect(inbound.map((frame) => (frame as { type: string }).type)).toEqual([MSG.WELCOME]);
    expect(getState('network.chatFrozen')).toBe(true);
    expect(getState('network.slowmodeSeconds')).toBe(7);
    expect(getState('network.filterEnabled')).toBe(true);
    expect(conn.close).toHaveBeenCalledOnce();
    expect(getState('network.hostConn')).toBeNull();
    expect(getState('network.isConnecting')).toBe(false);
    expect(successes).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect((errors.mock.calls[0][0] as Error).message).toBe('HOST_CONNECTION_ERROR');
    expect(sentMessages(conn)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: MSG.JOIN_BOOTSTRAP_HELLO })]),
    );
  });

  it('does not announce a connected guest after a buffered terminal frame closes the join', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const successes = vi.fn();
    const sessionFull = vi.fn();
    bus.on('setup:guest-join-success', successes);
    bus.on('network:session-full', sessionFull);
    initGuestProtocolHandlers();
    initProtocol();

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('data', {
      type: MSG.SESSION_FULL,
      message: 'Room is full',
    });
    conn.fire('open');

    expect(sessionFull).toHaveBeenCalledWith('Room is full');
    expect(conn.close).toHaveBeenCalledOnce();
    expect(getState('network.hostConn')).toBeNull();
    expect(getState('network.isConnecting')).toBe(false);
    expect(successes).not.toHaveBeenCalled();
  });

  it('discards one cancelled connection buffer and only drains its exact replacement', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const inbound: unknown[] = [];
    bus.on('network:data', (data: unknown) => inbound.push(data));

    joinSession('HOST01');
    const cancelled = conns[0];
    cancelled.fire('data', { type: MSG.WELCOME, label: 'cancelled' });
    invalidateGuestJoinAttempt();
    setState('network.isConnecting', false);

    joinSession('HOST02');
    const replacement = conns[1];
    replacement.fire('data', { type: MSG.WELCOME, label: 'replacement' });
    cancelled.fire('open');
    openAndCompleteStandardJoin(replacement, false);

    expect(cancelled.close).toHaveBeenCalledOnce();
    expect(inbound).toEqual([{ type: MSG.WELCOME, label: 'replacement' }]);
    expect(getState('network.hostConn')).toBe(replacement);
    expect(getState('network.isConnecting')).toBe(false);
  });

  it('fails closed without publishing when the bounded pre-open FIFO overflows', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const inbound = vi.fn();
    const errors = vi.fn();
    const successes = vi.fn();
    bus.on('network:data', inbound);
    bus.on('network:error', errors);
    bus.on('setup:guest-join-success', successes);

    joinSession('HOST01');
    const conn = conns[0];
    for (let index = 0; index < 65; index++) {
      conn.fire('data', { type: MSG.WELCOME, label: `frame-${index}` });
    }

    expect(conn.close).toHaveBeenCalledOnce();
    expect(getState('network.isConnecting')).toBe(false);
    expect(errors).toHaveBeenCalledOnce();
    expect((errors.mock.calls[0][0] as Error).message).toBe('HOST_CONNECTION_ERROR');

    conn.fire('open');
    expect(inbound).not.toHaveBeenCalled();
    expect(successes).not.toHaveBeenCalled();
    expect(getState('network.hostConn')).toBeNull();
  });

  it('publishes APPLIED and join success only after all three authority frames apply', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const immediatePing = vi.fn();
    const successes = vi.fn();
    const connected = vi.fn();
    bus.on('sync:request-immediate-ping', immediatePing);
    bus.on('setup:guest-join-success', successes);
    bus.on('network:peer-connected', connected);

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('open');

    const hello = sentMessages(conn).find((message) => message.type === MSG.JOIN_BOOTSTRAP_HELLO);
    expect(hello).toMatchObject({
      type: MSG.JOIN_BOOTSTRAP_HELLO,
      version: 1,
      bootstrapId: expect.any(String),
    });
    expect(getState('network.isConnecting')).toBe(true);
    expect(successes).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
    expect(mocks.startWorkerTimer).not.toHaveBeenCalled();
    expect(immediatePing).not.toHaveBeenCalled();

    const stopApply = installSuccessfulBootstrapApply();
    try {
      conn.fire('data', { type: MSG.WELCOME, lockChannel: false, label: 'Guest' });
      const frames = joinBootstrapFrames();
      conn.fire('data', frames[0]);
      conn.fire('data', frames[1]);
      expect(successes).not.toHaveBeenCalled();
      expect(mocks.startWorkerTimer).not.toHaveBeenCalled();
      conn.fire('data', frames[2]);
    } finally {
      stopApply();
    }

    const applied = sentMessages(conn).find(
      (message) => message.type === MSG.JOIN_BOOTSTRAP_APPLIED,
    );
    expect(applied).toEqual({
      type: MSG.JOIN_BOOTSTRAP_APPLIED,
      version: 1,
      bootstrapId: hello?.bootstrapId,
    });
    expect(getState('network.isConnecting')).toBe(false);
    expect(successes).toHaveBeenCalledOnce();
    expect(connected).toHaveBeenCalledOnce();
    expect(mocks.startWorkerTimer).toHaveBeenCalledWith('sync', 1000);
    expect(immediatePing).toHaveBeenCalledOnce();
  });

  it('fails closed when bootstrap frames arrive out of order', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    const successes = vi.fn();
    bus.on('network:error', errors);
    bus.on('setup:guest-join-success', successes);

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('open');
    conn.fire('data', { type: MSG.WELCOME, lockChannel: false, label: 'Guest' });
    conn.fire('data', { type: MSG.REPEAT_MODE, value: 0, _bootstrap: true });

    expect(conn.close).toHaveBeenCalledOnce();
    expect(getState('network.hostConn')).toBeNull();
    expect(getState('network.isConnecting')).toBe(false);
    expect(successes).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect((errors.mock.calls[0][0] as Error).message).toBe('HOST_CONNECTION_ERROR');
    expect(sentMessages(conn)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: MSG.JOIN_BOOTSTRAP_APPLIED })]),
    );
  });

  it('does not dispatch media in the partially applied authority window', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const inbound = vi.fn();
    const errors = vi.fn();
    const successes = vi.fn();
    bus.on('network:data', inbound);
    bus.on('network:error', errors);
    bus.on('setup:guest-join-success', successes);

    const stopApply = installSuccessfulBootstrapApply();
    try {
      joinSession('HOST01');
      const conn = conns[0];
      conn.fire('open');
      conn.fire('data', { type: MSG.WELCOME, lockChannel: false, label: 'Guest' });
      conn.fire('data', joinBootstrapFrames()[0]);
      conn.fire('data', {
        type: MSG.FILE_CHUNK,
        chunk: new Uint8Array([1]),
        chunkIndex: 0,
        queueItemId: '00000000-0000-4000-8000-000000000001',
        sessionId: 1,
        name: 'must-not-dispatch.mp3',
        total: 1,
        size: 1,
      });

      expect(inbound.mock.calls.map((call) => (call[0] as { type?: string }).type)).toEqual([
        MSG.WELCOME,
      ]);
      expect(conn.close).toHaveBeenCalledOnce();
      expect(getState('network.hostConn')).toBeNull();
      expect(successes).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledOnce();
      expect(sentMessages(conn)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: MSG.JOIN_BOOTSTRAP_APPLIED })]),
      );
    } finally {
      stopApply();
    }
  });

  it('keeps the existing immediate-open completion path for PRO rooms', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const successes = vi.fn();
    bus.on('setup:guest-join-success', successes);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 4,
      snapshotRevision: 8,
      capabilities: [],
    });

    joinSession('000001');
    const conn = conns[0];
    conn.fire('open');

    expect(getState('network.hostConn')).toBe(conn);
    expect(getState('network.isConnecting')).toBe(false);
    expect(successes).toHaveBeenCalledOnce();
    expect(mocks.startWorkerTimer).toHaveBeenCalledWith('sync', 1000);
    expect(
      sentMessages(conn).filter(
        (message) =>
          message.type === MSG.JOIN_BOOTSTRAP_HELLO || message.type === MSG.JOIN_BOOTSTRAP_APPLIED,
      ),
    ).toEqual([]);
  });

  it.each(['close', 'error'] as const)(
    'turns a stale PRO host-connection %s into one control recovery without a network error',
    (event) => {
      const { peer, conns } = makeFakePeer();
      mocks.getPeer.mockReturnValue(peer);
      const errors = vi.fn();
      const recover = vi.fn();
      bus.on('network:error', errors);
      registerProRoomSignalingEpochAdvanceHandler(recover);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'member',
        coordinatorId: null,
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
      expect(recover).toHaveBeenCalledOnce();
      expect(mocks.showToast).not.toHaveBeenCalled();
      expect(getState('network.signalingHealth')).toMatchObject({
        status: 'reconnecting',
        attempt: 1,
        maxAttempts: 5,
      });
    },
  );

  it('rejects an active PRO handoff immediately when the replacement connection fails pre-open', () => {
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    const recover = vi.fn();
    bus.on('network:error', errors);
    registerProRoomSignalingEpochAdvanceHandler(recover);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 4,
      snapshotRevision: 8,
      capabilities: [],
    });
    setState('setup.sessionStarted', true);

    joinSession('000001');
    conns[0].fire('error', new Error('replacement unavailable'));

    expect(getState('network.isConnecting')).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledOnce();
    expect(mocks.showToast).not.toHaveBeenCalled();
    expect(getState('network.signalingHealth')).toMatchObject({
      status: 'reconnecting',
      attempt: 1,
      maxAttempts: 5,
    });
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

  it('does not let a replaced connection’s late bootstrap or close affect the successor', async () => {
    vi.useFakeTimers();
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    const successes = vi.fn();
    bus.on('network:error', errors);
    bus.on('setup:guest-join-success', successes);

    joinSession('HOST01');
    const first = conns[0];
    openAndCompleteStandardJoin(first);
    expect(getState('network.hostConn')).toBe(first);

    // Transport blip: the channel is dead but PeerJS has not delivered the
    // close event yet, and the user re-joins in that window.
    first.open = false;
    joinSession('HOST01');
    const second = conns[1];
    openAndCompleteStandardJoin(second);
    expect(getState('network.hostConn')).toBe(second);

    const staleSendCount = vi.mocked(first.send).mock.calls.length;
    fireJoinBootstrap(first);
    first.fire('close');

    expect(getState('network.hostConn')).toBe(second);
    expect(getState('network.isConnecting')).toBe(false);
    expect(vi.mocked(first.send)).toHaveBeenCalledTimes(staleSendCount);
    expect(successes).toHaveBeenCalledTimes(2);

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
    openAndCompleteStandardJoin(first);
    first.open = false;

    joinSession('HOST01');
    const second = conns[1];
    openAndCompleteStandardJoin(second);
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
    openAndCompleteStandardJoin(first);

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
    const inbound = vi.fn();
    bus.on('network:error', errors);
    bus.on('setup:guest-join-success', successes);
    bus.on('network:data', inbound);

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('data', { type: MSG.WELCOME, label: 'must-be-discarded' });

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
    expect(inbound).not.toHaveBeenCalled();
  });

  it('fails once when an open standard connection never completes bootstrap', () => {
    vi.useFakeTimers();
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    const successes = vi.fn();
    bus.on('network:error', errors);
    bus.on('setup:guest-join-success', successes);

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('open');

    expect(sentMessages(conn)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: MSG.JOIN_BOOTSTRAP_HELLO, version: 1 }),
      ]),
    );
    vi.advanceTimersByTime(9_999);
    expect(errors).not.toHaveBeenCalled();
    expect(getState('network.hostConn')).toBe(conn);
    expect(getState('network.isConnecting')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(conn.close).toHaveBeenCalledOnce();
    expect(getState('network.hostConn')).toBeNull();
    expect(getState('network.isConnecting')).toBe(false);
    expect(successes).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect((errors.mock.calls[0][0] as Error).message).toBe('HOST_CONNECTION_ERROR');

    const stopApply = installSuccessfulBootstrapApply();
    try {
      fireJoinBootstrap(conn);
    } finally {
      stopApply();
    }
    expect(successes).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect(sentMessages(conn)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: MSG.JOIN_BOOTSTRAP_APPLIED })]),
    );
  });

  it('does not revive a join when open arrives after a pre-open error', async () => {
    vi.useFakeTimers();
    const { peer, conns } = makeFakePeer();
    mocks.getPeer.mockReturnValue(peer);
    const errors = vi.fn();
    const successes = vi.fn();
    const inbound = vi.fn();
    bus.on('network:error', errors);
    bus.on('setup:guest-join-success', successes);
    bus.on('network:data', inbound);

    joinSession('HOST01');
    const conn = conns[0];
    conn.fire('data', { type: MSG.WELCOME, label: 'must-be-discarded' });
    conn.fire('error', new Error('pre-open failed'));

    expect(getState('network.isConnecting')).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);

    conn.fire('open');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getState('network.hostConn')).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(successes).not.toHaveBeenCalled();
    expect(inbound).not.toHaveBeenCalled();
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

    openAndCompleteStandardJoin(conns[0]);
    expect(getState('network.hostConn')).toBe(conns[0]);
    expect(getState('network.isConnecting')).toBe(false);
  });
});

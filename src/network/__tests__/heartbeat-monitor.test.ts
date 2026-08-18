import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  broadcastDeviceList: vi.fn(),
  detachHostPeerConnection: vi.fn(),
}));

vi.mock('../peer-state.ts', () => ({
  broadcastDeviceList: mocks.broadcastDeviceList,
}));
vi.mock('../host-peer-departure.ts', () => ({
  detachHostPeerConnection: mocks.detachHostPeerConnection,
}));
vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

type CloseMock = ReturnType<typeof vi.fn<() => void>>;
type TestConnection = DataConnection & { close: CloseMock };

function makeConnection(
  peer: string,
  options: {
    open?: boolean;
    connectionState?: RTCPeerConnectionState;
    dataState?: RTCDataChannelState;
    controlState?: RTCDataChannelState;
    close?: CloseMock;
  } = {},
): TestConnection {
  return {
    peer,
    open: options.open ?? true,
    close: options.close ?? vi.fn<() => void>(),
    peerConnection:
      options.connectionState === undefined
        ? undefined
        : { connectionState: options.connectionState },
    dataChannel: options.dataState === undefined ? undefined : { readyState: options.dataState },
    controlChannel:
      options.controlState === undefined ? undefined : { readyState: options.controlState },
  } as unknown as TestConnection;
}

function makePeer(
  id: string,
  conn: DataConnection,
  lastHeartbeat: number,
  overrides: Partial<ConnectedPeer> = {},
): ConnectedPeer {
  return {
    id,
    slot: 1,
    conn,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    connectionType: 'local',
    isDataTarget: true,
    joinOrder: 1,
    lastHeartbeat,
    label: id,
    ...overrides,
  };
}

function installPeers(peers: ConnectedPeer[]): void {
  setState('network.connectedPeers', peers);
  setState(
    'network.activeHostConnByPeerId',
    new Map(peers.map((peer) => [peer.id, peer.conn as DataConnection])),
  );
}

describe('host heartbeat monitor', () => {
  beforeEach(() => {
    clearAllManagedTimers();
    resetState();
    bus.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    mocks.detachHostPeerConnection.mockImplementation(
      (peerId: string, expectedConnection: DataConnection | null | undefined) => {
        const peers = getState('network.connectedPeers');
        const peer = peers.find(
          (candidate) =>
            candidate.id === peerId &&
            (candidate.conn as DataConnection | null | undefined) === expectedConnection,
        );
        if (!peer) return null;

        const remainingPeers = peers.filter((candidate) => candidate !== peer);
        setState('network.connectedPeers', remainingPeers);
        const activeConnections = new Map(getState('network.activeHostConnByPeerId'));
        if (activeConnections.get(peerId) === expectedConnection) activeConnections.delete(peerId);
        setState('network.activeHostConnByPeerId', activeConnections);
        return {
          peer,
          remainingPeers,
          connection: expectedConnection ?? null,
          label: peer.label,
        };
      },
    );
  });

  afterEach(() => {
    clearAllManagedTimers();
    bus.clear();
    vi.useRealTimers();
  });

  it('starts from an already-started setup snapshot and stops when the session ends', async () => {
    setState('setup.sessionStarted', true);
    const { initHeartbeatMonitor } = await import('../heartbeat-monitor.ts');

    initHeartbeatMonitor();

    expect(getManagedTimer('heartbeat-monitor')).not.toBeNull();

    bus.emit('state:setup.sessionStarted', false, 'setup.sessionStarted');

    expect(getManagedTimer('heartbeat-monitor')).toBeNull();
  });

  it.each([
    {
      name: 'closed transport',
      threshold: 8_000,
      connection: () => makeConnection('guest', { open: false }),
    },
    {
      name: 'recovering transport',
      threshold: 30_000,
      connection: () => makeConnection('guest', { connectionState: 'disconnected' }),
    },
    {
      name: 'live transport',
      threshold: 90_000,
      connection: () =>
        makeConnection('guest', {
          connectionState: 'connected',
          dataState: 'open',
          controlState: 'open',
        }),
    },
  ])('uses the exact $threshold ms grace for a $name', async ({ threshold, connection }) => {
    const conn = connection();
    installPeers([makePeer(conn.peer, conn, Date.now() - (threshold - 5_000))]);
    setState('setup.sessionStarted', true);
    const { initHeartbeatMonitor } = await import('../heartbeat-monitor.ts');
    initHeartbeatMonitor();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.detachHostPeerConnection).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.detachHostPeerConnection).toHaveBeenCalledOnce();
    expect(mocks.detachHostPeerConnection).toHaveBeenCalledWith(conn.peer, conn);
  });

  it('records heartbeat only for the exact connected connection', async () => {
    const staleAlias = makeConnection('reused-peer');
    const exactConn = makeConnection('exact-peer');
    const replacedConn = makeConnection('reused-peer');
    installPeers([
      makePeer(replacedConn.peer, replacedConn, Date.now() - 9_000),
      makePeer(exactConn.peer, exactConn, Date.now() - 9_000, { joinOrder: 2, slot: 2 }),
    ]);
    setState('setup.sessionStarted', true);
    const { initHeartbeatMonitor, recordPeerHeartbeat } = await import('../heartbeat-monitor.ts');

    recordPeerHeartbeat(staleAlias);
    recordPeerHeartbeat(exactConn);
    initHeartbeatMonitor();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.detachHostPeerConnection).toHaveBeenCalledOnce();
    expect(mocks.detachHostPeerConnection).toHaveBeenCalledWith(replacedConn.peer, replacedConn);
    expect(exactConn.close).not.toHaveBeenCalled();
  });

  it('rejects a heartbeat observed while the peer is disconnected', async () => {
    const conn = makeConnection('disconnected-peer');
    const disconnectedPeer = makePeer(conn.peer, conn, Date.now() - 9_000, {
      status: 'disconnected',
    });
    installPeers([disconnectedPeer]);
    const { initHeartbeatMonitor, recordPeerHeartbeat } = await import('../heartbeat-monitor.ts');

    recordPeerHeartbeat(conn);
    installPeers([{ ...disconnectedPeer, status: 'connected' }]);
    setState('setup.sessionStarted', true);
    initHeartbeatMonitor();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.detachHostPeerConnection).toHaveBeenCalledWith(conn.peer, conn);
  });

  it('stops monitoring when a host connection appears', async () => {
    const peerConn = makeConnection('guest');
    installPeers([makePeer(peerConn.peer, peerConn, Date.now() - 100_000)]);
    setState('setup.sessionStarted', true);
    const { initHeartbeatMonitor } = await import('../heartbeat-monitor.ts');
    initHeartbeatMonitor();
    expect(getManagedTimer('heartbeat-monitor')).not.toBeNull();

    setState('network.hostConn', makeConnection('host'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getManagedTimer('heartbeat-monitor')).toBeNull();
    expect(mocks.detachHostPeerConnection).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.detachHostPeerConnection).not.toHaveBeenCalled();
  });

  it('detaches every stale peer before close, tolerates close errors, then emits and broadcasts', async () => {
    const order: string[] = [];
    const firstConn = makeConnection('first', {
      open: false,
      close: vi.fn(() => {
        order.push('close:first');
        throw new Error('synchronous close failure');
      }),
    });
    const secondConn = makeConnection('second', {
      open: false,
      close: vi.fn(() => {
        order.push('close:second');
      }),
    });
    installPeers([
      makePeer(firstConn.peer, firstConn, Date.now() - 9_000),
      makePeer(secondConn.peer, secondConn, Date.now() - 9_000, {
        joinOrder: 2,
        slot: 2,
      }),
    ]);
    mocks.detachHostPeerConnection.mockImplementation((peerId: string, expectedConnection) => {
      order.push(`detach:${peerId}`);
      const peer = getState('network.connectedPeers').find(
        (candidate) => candidate.id === peerId && candidate.conn === expectedConnection,
      );
      return peer
        ? { peer, remainingPeers: [], connection: expectedConnection, label: peer.label }
        : null;
    });
    mocks.broadcastDeviceList.mockImplementation(() => order.push('broadcast'));
    bus.on('network:peer-disconnected', (peerId) => order.push(`disconnect:${peerId}`));
    setState('setup.sessionStarted', true);
    const { initHeartbeatMonitor } = await import('../heartbeat-monitor.ts');
    initHeartbeatMonitor();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(order).toEqual([
      'detach:first',
      'detach:second',
      'close:first',
      'close:second',
      'disconnect:first',
      'disconnect:second',
      'broadcast',
    ]);
    expect(mocks.broadcastDeviceList).toHaveBeenCalledOnce();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: mocks.showToast,
}));

vi.mock('../../core/log.ts', () => ({
  log: {
    warn: mocks.warn,
    debug: mocks.debug,
    info: mocks.info,
    error: mocks.error,
  },
}));

import '../host.ts';

function makeConn(send: ReturnType<typeof vi.fn>): DataConnection {
  return {
    peer: 'guest-1',
    open: true,
    send,
  } as unknown as DataConnection;
}

function makePeer(conn: DataConnection): ConnectedPeer {
  return {
    id: 'guest-1',
    slot: 1,
    label: '#1 Guest',
    conn,
    isOp: false,
    preloadedIndexes: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: 0,
  };
}

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
  setState('network.myId', 'host-1');
});

describe('host operator toggle', () => {
  it('grants operator only after the target connection receives the message', () => {
    const send = vi.fn();
    const conn = makeConn(send);
    setState('network.connectedPeers', [makePeer(conn)]);

    bus.emit('network:toggle-operator', 'guest-1');

    expect(getState('network.connectedPeers')[0].isOp).toBe(true);
    expect(send).toHaveBeenNthCalledWith(1, { type: MSG.OPERATOR_GRANT });
    expect(mocks.showToast).toHaveBeenCalled();
  });

  it('leaves host state unchanged when the operator message cannot be sent', () => {
    const send = vi.fn(() => {
      throw new Error('send failed');
    });
    const conn = makeConn(send);
    setState('network.connectedPeers', [makePeer(conn)]);

    bus.emit('network:toggle-operator', 'guest-1');

    expect(getState('network.connectedPeers')[0].isOp).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});

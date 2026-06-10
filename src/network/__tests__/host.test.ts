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

function makeSlottedPeer(id: string, slot: number, send: ReturnType<typeof vi.fn>): ConnectedPeer {
  return {
    id,
    slot,
    label: `#${slot} Guest`,
    conn: { peer: id, open: true, send } as unknown as DataConnection,
    isOp: false,
    preloadedIndexes: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: slot,
    connectionType: 'local',
    lastHeartbeat: 0,
  };
}

// CONN-1 (22차 domain audit): the reduction guard is count-based but the
// enforcement was slot-index-based — with sparse slots a peer in a high slot
// got kicked even though the room had capacity. Displaced occupants must be
// relocated into freed low slots; only genuine overflow kicks.
describe('max-guests reduction with sparse slots', () => {
  it('relocates a high-slot peer into a freed hole instead of kicking', () => {
    const sendG1 = vi.fn();
    const sendG3 = vi.fn();
    const sendG4 = vi.fn();
    setState('network.maxGuestSlots', 4);
    setState('network.peerSlots', [null, 'g1', null, 'g3', 'g4']);
    setState(
      'network.peerSlotByPeerId',
      new Map([
        ['g1', 1],
        ['g3', 3],
        ['g4', 4],
      ]),
    );
    setState('network.connectedPeers', [
      makeSlottedPeer('g1', 1, sendG1),
      makeSlottedPeer('g3', 3, sendG3),
      makeSlottedPeer('g4', 4, sendG4),
    ]);

    bus.emit('network:max-guests-changed', 3);

    expect(sendG1).not.toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(sendG3).not.toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(sendG4).not.toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(getState('network.peerSlots')).toEqual([null, 'g1', 'g4', 'g3']);
    expect(getState('network.peerSlotByPeerId').get('g4')).toBe(2);
    expect(getState('network.maxGuestSlots')).toBe(3);
  });

  it('still kicks exactly the overflow peer when all remaining slots are dense', () => {
    const sends = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    setState('network.maxGuestSlots', 4);
    setState('network.peerSlots', [null, 'g1', 'g2', 'g3', 'g4']);
    setState(
      'network.peerSlotByPeerId',
      new Map([
        ['g1', 1],
        ['g2', 2],
        ['g3', 3],
        ['g4', 4],
      ]),
    );
    setState('network.connectedPeers', [
      makeSlottedPeer('g1', 1, sends[0]),
      makeSlottedPeer('g2', 2, sends[1]),
      makeSlottedPeer('g3', 3, sends[2]),
      makeSlottedPeer('g4', 4, sends[3]),
    ]);

    bus.emit('network:max-guests-changed', 3);

    expect(sends[0]).not.toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(sends[1]).not.toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(sends[2]).not.toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(sends[3]).toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(getState('network.peerSlots')).toEqual([null, 'g1', 'g2', 'g3']);
    expect(getState('network.peerSlotByPeerId').has('g4')).toBe(false);
  });
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

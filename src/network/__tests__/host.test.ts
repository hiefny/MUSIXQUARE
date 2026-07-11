import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
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

import { handleHostIncomingConnection } from '../host.ts';

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
    preloadedQueueItemIds: new Set(),
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
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: slot,
    connectionType: 'local',
    lastHeartbeat: 0,
  };
}

// The reduction guard is count-based but enforcement is slot-index-based. With
// sparse slots, a peer in a high slot must not be kicked while capacity remains.
// Displaced occupants move into freed low slots; only genuine overflow kicks.
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
    // The ConnectedPeer record must follow (stale-field hygiene); label and
    // joinOrder intentionally keep their join-time values.
    const relocated = getState('network.connectedPeers').find((p) => p.id === 'g4');
    expect(relocated?.slot).toBe(2);
    expect(relocated?.joinOrder).toBe(4);
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

type FiringConn = DataConnection & { fire: (event: string, ...args: unknown[]) => void };

function makeIncomingConn(peerId: string): FiringConn {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    peer: peerId,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    fire(event: string, ...args: unknown[]) {
      for (const cb of [...(handlers.get(event) ?? [])]) cb(...args);
    },
  } as unknown as FiringConn;
}

describe('duplicate guest connection handoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAllManagedTimers();
    vi.useRealTimers();
  });

  it('replaces the active connection through a reconnect storm and ignores stale closes', () => {
    const disconnected = vi.fn();
    bus.on('network:peer-disconnected', disconnected);

    const first = makeIncomingConn('guest-re');
    const second = makeIncomingConn('guest-re');
    const third = makeIncomingConn('guest-re');
    handleHostIncomingConnection(first);
    handleHostIncomingConnection(second);
    handleHostIncomingConnection(third);

    expect(first.send).toHaveBeenCalledWith({ type: MSG.FORCE_CLOSE_DUPLICATE });
    expect(second.send).toHaveBeenCalledWith({ type: MSG.FORCE_CLOSE_DUPLICATE });
    expect(first.close).toHaveBeenCalled();
    expect(second.close).toHaveBeenCalled();

    // PeerJS delivers the replaced connections' close events late — they must
    // not tear down the record now bound to the live connection.
    first.fire('close');
    second.fire('close');

    expect(disconnected).not.toHaveBeenCalled();
    const records = getState('network.connectedPeers').filter((p) => p.id === 'guest-re');
    expect(records).toHaveLength(1);
    expect(records[0].conn).toBe(third);
    expect(getState('network.activeHostConnByPeerId').get('guest-re')).toBe(third);
    // The slot follows the peer id across the storm instead of leaking one per attempt.
    expect(getState('network.peerSlotByPeerId').get('guest-re')).toBe(1);
    expect(getState('network.peerSlots').filter((s) => s === 'guest-re')).toHaveLength(1);
    expect(third.close).not.toHaveBeenCalled();
  });

  it('does not bootstrap a replaced connection whose open event arrives late', () => {
    const bootstrapped: DataConnection[] = [];
    const connected: DataConnection[] = [];
    const stopBootstrap = bus.on('network:peer-bootstrap', (conn) => bootstrapped.push(conn));
    const stopConnected = bus.on('network:peer-connected', (conn) => connected.push(conn));
    const first = makeIncomingConn('guest-late-open');
    const replacement = makeIncomingConn('guest-late-open');

    try {
      handleHostIncomingConnection(first);
      handleHostIncomingConnection(replacement);
      first.fire('open');
      expect(bootstrapped).toEqual([]);
      expect(connected).toEqual([]);

      replacement.fire('open');
    } finally {
      stopBootstrap();
      stopConnected();
    }

    expect(bootstrapped).toEqual([replacement]);
    expect(connected).toEqual([replacement]);
  });

  it('rejects a connection over capacity with SESSION_FULL and a deferred close, leaving no record', () => {
    setState('network.maxGuestSlots', 1);
    setState('network.peerSlots', [null, 'g1']);
    setState('network.peerSlotByPeerId', new Map([['g1', 1]]));
    setState('network.connectedPeers', [makeSlottedPeer('g1', 1, vi.fn())]);

    const overflow = makeIncomingConn('guest-overflow');
    handleHostIncomingConnection(overflow);

    expect(overflow.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.SESSION_FULL, i18nKey: 'network.session_full_detail' }),
    );
    // Close is deferred so the rejection frame can flush first.
    expect(overflow.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(overflow.close).toHaveBeenCalledTimes(1);

    expect(getState('network.connectedPeers').map((p) => p.id)).toEqual(['g1']);
    expect(getState('network.activeHostConnByPeerId').has('guest-overflow')).toBe(false);
    expect(getState('network.peerLabels')['guest-overflow']).toBeUndefined();
  });
});

describe('ordered host bootstrap phases', () => {
  it('runs queue authority bootstrap before playback-dependent peer listeners', () => {
    const conn = makeIncomingConn('guest-bootstrap');
    const phases: string[] = [];
    const stopBootstrap = bus.on('network:peer-bootstrap', (current) => {
      phases.push('queue');
      current.send({ type: MSG.PLAYLIST_UPDATE } as never);
    });
    const stopConnected = bus.on('network:peer-connected', (current) => {
      phases.push('playback');
      current.send({ type: MSG.PLAY } as never);
    });

    try {
      handleHostIncomingConnection(conn);
      conn.fire('open');
    } finally {
      stopBootstrap();
      stopConnected();
    }

    expect(phases).toEqual(['queue', 'playback']);
    const sentTypes = vi
      .mocked(conn.send)
      .mock.calls.map(([message]) => (message as { type?: string }).type);
    expect(sentTypes.indexOf(MSG.WELCOME)).toBeLessThan(sentTypes.indexOf(MSG.PLAYLIST_UPDATE));
    expect(sentTypes.indexOf(MSG.PLAYLIST_UPDATE)).toBeLessThan(sentTypes.indexOf(MSG.CHAT_SYSTEM));
    expect(sentTypes.indexOf(MSG.PLAYLIST_UPDATE)).toBeLessThan(sentTypes.indexOf(MSG.PLAY));
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

  // OPERATOR_REVOKE re-baselines a demoted guest: the effects snapshot reconciles
  // any raced changes, but repeat/shuffle go through the
  // same optimistic-apply → verifyOperator-silent-drop path and were not
  // covered. The revoke must also resend both as _bootstrap (toast-silent)
  // frames on the same ordered channel.
  it('revoke re-baselines the demoted guest: effects resync + repeat/shuffle bootstrap frames', () => {
    const send = vi.fn();
    const conn = makeConn(send);
    setState('network.connectedPeers', [{ ...makePeer(conn), isOp: true }]);
    setState('playlist.repeatMode', 2);
    setState('playlist.isShuffle', true);
    const resyncSpy = vi.fn();
    bus.on('effects:resync-peer', resyncSpy);

    bus.emit('network:toggle-operator', 'guest-1');

    expect(getState('network.connectedPeers')[0].isOp).toBe(false);
    expect(send).toHaveBeenCalledWith({ type: MSG.OPERATOR_REVOKE });
    expect(resyncSpy).toHaveBeenCalledWith(conn);
    expect(send).toHaveBeenCalledWith({ type: MSG.REPEAT_MODE, value: 2, _bootstrap: true });
    expect(send).toHaveBeenCalledWith({ type: MSG.SHUFFLE_MODE, value: true, _bootstrap: true });
  });

  it('grant sends no re-baseline frames (nothing was dropped for a promoted guest)', () => {
    const send = vi.fn();
    const conn = makeConn(send);
    setState('network.connectedPeers', [makePeer(conn)]);
    const resyncSpy = vi.fn();
    bus.on('effects:resync-peer', resyncSpy);

    bus.emit('network:toggle-operator', 'guest-1');

    expect(send).toHaveBeenCalledWith({ type: MSG.OPERATOR_GRANT });
    expect(resyncSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.REPEAT_MODE }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.SHUFFLE_MODE }));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { MAX_GUEST_SLOTS, MAX_SYSTEM_AUDIO_DEVICES, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
import type { StandardRoomMemberIdentity } from '../transport/types.ts';
import { isCoordinator } from '../../rooms/authority.ts';
import { STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES } from '../standard-room-authority.ts';
import { JOIN_BOOTSTRAP_TIMEOUT_MS } from '../join-bootstrap.ts';

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

it('uses a fixed 100-device room ceiling including the host', () => {
  expect(MAX_GUEST_SLOTS).toBe(99);
  expect(getState('network.peerSlots')).toHaveLength(100);
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

type FiringConn = DataConnection & {
  send: Mock<(data: unknown) => void>;
  close: Mock<() => void>;
  fire: (event: string, ...args: unknown[]) => void;
};

function makeIncomingConn(peerId: string): FiringConn {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    peer: peerId,
    open: true,
    send: vi.fn<(data: unknown) => void>(),
    close: vi.fn<() => void>(),
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

const BOOTSTRAP_ID_A = '12345678-1234-4abc-8def-1234567890ab';
const BOOTSTRAP_ID_B = '87654321-4321-4cba-9fed-ba0987654321';

function joinBootstrapHello(bootstrapId = BOOTSTRAP_ID_A) {
  return {
    type: MSG.JOIN_BOOTSTRAP_HELLO,
    version: 1 as const,
    bootstrapId,
  };
}

function joinBootstrapApplied(bootstrapId = BOOTSTRAP_ID_A) {
  return {
    type: MSG.JOIN_BOOTSTRAP_APPLIED,
    version: 1 as const,
    bootstrapId,
  };
}

function installStandardBootstrapResponder(
  expectedConn: FiringConn,
  onBootstrap?: () => void,
): () => void {
  return bus.on('network:peer-bootstrap', (conn, send, acknowledge) => {
    if (conn !== expectedConn) return;
    onBootstrap?.();
    const sent =
      send({
        type: MSG.PLAYLIST_UPDATE,
        list: [],
        revision: 0,
        currentQueueItemId: null,
        bootstrap: true,
      }) &&
      send({ type: MSG.REPEAT_MODE, value: 0, _bootstrap: true }) &&
      send({ type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true });
    acknowledge(sent);
  });
}

function completeStandardJoin(conn: FiringConn, bootstrapId = BOOTSTRAP_ID_A): void {
  const stopBootstrap = installStandardBootstrapResponder(conn);
  try {
    conn.fire('open');
    conn.fire('data', joinBootstrapHello(bootstrapId));
    conn.fire('data', joinBootstrapApplied(bootstrapId));
  } finally {
    stopBootstrap();
  }
}

function verifiedIdentity(
  memberId = 'member_abcdefghijklmnopqrstuv',
  nickname = 'Minsu',
  memberDisplayNumber = 1,
): StandardRoomMemberIdentity {
  return {
    memberId,
    memberDisplayNumber,
    nickname,
    isAuthenticated: true,
  };
}

function makeVerifiedIncomingConn(
  peerId: string,
  identity: StandardRoomMemberIdentity = verifiedIdentity(),
): FiringConn {
  const conn = makeIncomingConn(peerId);
  conn.roomIdentity = identity;
  return conn;
}

function setAuthenticatedPhysicalHost(identity: StandardRoomMemberIdentity): void {
  setState('network.appRole', 'host');
  setState('network.myDeviceLabel', identity.nickname);
  setState('network.myMemberId', identity.memberId);
  setState('network.myMemberDisplayNumber', identity.memberDisplayNumber);
  setState('network.myMemberAuthenticated', true);
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
    const replaced = vi.fn();
    bus.on('network:peer-disconnected', disconnected);
    bus.on('network:peer-connection-replaced', replaced);

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

    // Browsers can deliver the replaced connections' close/error events late —
    // they must not tear down the record now bound to the live connection or
    // surface a false connection-failed toast.
    first.fire('close');
    first.fire('error', new Error('late close error'));
    second.fire('close');
    second.fire('error', new Error('late close error'));

    expect(disconnected).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
    expect(replaced).toHaveBeenNthCalledWith(1, 'guest-re');
    expect(replaced).toHaveBeenNthCalledWith(2, 'guest-re');
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

      completeStandardJoin(replacement);
    } finally {
      stopBootstrap();
      stopConnected();
    }

    expect(bootstrapped).toEqual([replacement]);
    expect(connected).toEqual([replacement]);
  });

  it('announces a join once in chat without a duplicate toast when a connection is replaced', () => {
    setState('setup.sessionStarted', true);
    const systemMessages: string[] = [];
    const stop = bus.on('chat:system-message', (text) => systemMessages.push(text));
    const first = makeIncomingConn('guest-rejoin');
    const replacement = makeIncomingConn('guest-rejoin');

    try {
      handleHostIncomingConnection(first);
      completeStandardJoin(first);
      handleHostIncomingConnection(replacement);
      completeStandardJoin(replacement, BOOTSTRAP_ID_B);
    } finally {
      stop();
    }

    expect(systemMessages).toHaveLength(1);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('still announces the first join when a stalled pre-open connection is replaced', () => {
    const systemMessages: string[] = [];
    const stop = bus.on('chat:system-message', (text) => systemMessages.push(text));
    const stalled = makeIncomingConn('guest-stalled');
    const replacement = makeIncomingConn('guest-stalled');

    try {
      handleHostIncomingConnection(stalled);
      handleHostIncomingConnection(replacement);
      completeStandardJoin(replacement);
    } finally {
      stop();
    }

    expect(systemMessages).toHaveLength(1);
  });

  it('keeps only an allowlisted coarse platform from untrusted connection metadata', () => {
    const ios = makeIncomingConn('guest-ios');
    (ios as unknown as { metadata: unknown }).metadata = {
      devicePlatform: 'ios',
      userAgent: 'must-not-enter-room-state',
    };
    const invalid = makeIncomingConn('guest-invalid-platform');
    (invalid as unknown as { metadata: unknown }).metadata = { devicePlatform: 'freebsd' };

    handleHostIncomingConnection(ios);
    handleHostIncomingConnection(invalid);

    expect(
      getState('network.connectedPeers').find((peer) => peer.id === 'guest-ios')?.devicePlatform,
    ).toBe('ios');
    expect(
      getState('network.connectedPeers').find((peer) => peer.id === 'guest-invalid-platform')
        ?.devicePlatform,
    ).toBe('other');
    expect(getState('network.connectedPeers')).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ userAgent: expect.anything() })]),
    );
  });

  it('rejects a connection over capacity with SESSION_FULL and a deferred close, leaving no record', () => {
    const ids = Array.from({ length: MAX_GUEST_SLOTS }, (_, index) => `g${index + 1}`);
    setState('network.peerSlots', [null, ...ids]);
    setState('network.peerSlotByPeerId', new Map(ids.map((id, index) => [id, index + 1])));
    setState(
      'network.connectedPeers',
      ids.map((id, index) => makeSlottedPeer(id, index + 1, vi.fn())),
    );

    const overflow = makeIncomingConn('guest-overflow');
    handleHostIncomingConnection(overflow);

    expect(overflow.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.SESSION_FULL, i18nKey: 'network.session_full_detail' }),
    );
    // Close is deferred so the rejection frame can flush first.
    expect(overflow.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(overflow.close).toHaveBeenCalledTimes(1);

    expect(getState('network.connectedPeers')).toHaveLength(MAX_GUEST_SLOTS);
    expect(getState('network.activeHostConnByPeerId').has('guest-overflow')).toBe(false);
    expect(getState('network.peerLabels')['guest-overflow']).toBeUndefined();
  });

  it('suppresses the transient connection toast when the fifth device ends system audio', () => {
    const ids = ['guest-1', 'guest-2', 'guest-3'];
    const slots = [...getState('network.peerSlots')];
    for (const [index, id] of ids.entries()) slots[index + 1] = id;
    setState('network.peerSlots', slots);
    setState('network.peerSlotByPeerId', new Map(ids.map((id, index) => [id, index + 1])));
    setState(
      'network.connectedPeers',
      ids.map((id, index) => makeSlottedPeer(id, index + 1, vi.fn())),
    );
    setState('playback.mode', 'system-audio');

    const fifthDevice = makeIncomingConn('guest-4');
    handleHostIncomingConnection(fifthDevice);
    completeStandardJoin(fifthDevice);

    expect(getState('network.connectedPeers')).toHaveLength(MAX_SYSTEM_AUDIO_DEVICES);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});

describe('account-grouped presence announcements', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setState('setup.sessionStarted', true);
  });

  afterEach(() => {
    clearAllManagedTimers();
    vi.useRealTimers();
  });

  it('announces only the first join and last departure across the same account devices', () => {
    const systemMessages: string[] = [];
    const stop = bus.on('chat:system-message', (text) => systemMessages.push(text));
    const first = makeVerifiedIncomingConn('minsu-phone');
    const second = makeVerifiedIncomingConn('minsu-laptop');

    try {
      handleHostIncomingConnection(first);
      completeStandardJoin(first);
      handleHostIncomingConnection(second);
      completeStandardJoin(second, BOOTSTRAP_ID_B);

      expect(systemMessages).toHaveLength(1);
      first.fire('close');
      expect(systemMessages).toHaveLength(1);
      second.fire('close');
      expect(systemMessages).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it('does not announce a guest device when the physical host already represents that account', () => {
    const identity = verifiedIdentity();
    setState('network.appRole', 'host');
    setState('network.myDeviceLabel', identity.nickname);
    setState('network.myMemberId', identity.memberId);
    setState('network.myMemberDisplayNumber', identity.memberDisplayNumber);
    setState('network.myMemberAuthenticated', true);
    const systemMessages: string[] = [];
    const stop = bus.on('chat:system-message', (text) => systemMessages.push(text));
    const secondDevice = makeVerifiedIncomingConn('host-account-phone', identity);

    try {
      handleHostIncomingConnection(secondDevice);
      completeStandardJoin(secondDevice);
      secondDevice.fire('close');
    } finally {
      stop();
    }

    expect(systemMessages).toEqual([]);
  });

  it('keeps physical slots while account rows use the first device slot', () => {
    const minsu = [0, 1, 2].map((index) =>
      makeVerifiedIncomingConn(
        `minsu-${index}`,
        verifiedIdentity('member_abcdefghijklmnopqrstuv', 'Minsu', 1),
      ),
    );
    const jisu = [0, 1].map((index) =>
      makeVerifiedIncomingConn(
        `jisu-${index}`,
        verifiedIdentity('member_zyxwvutsrqponmlkjihgfe', 'Jisu', 4),
      ),
    );
    const anonymous = makeIncomingConn('anonymous-6');

    for (const conn of [...minsu, ...jisu, anonymous]) {
      handleHostIncomingConnection(conn);
      completeStandardJoin(conn);
    }

    const peers = getState('network.connectedPeers');
    expect(peers.map((peer) => peer.slot)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      peers.map((peer) => (peer.isAuthenticated ? peer.memberDisplayNumber : peer.joinOrder)),
    ).toEqual([1, 1, 1, 4, 4, 6]);
  });
});

describe('ordered host bootstrap phases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAllManagedTimers();
    vi.useRealTimers();
  });

  it('does not publish a standard-room peer from transport open alone', () => {
    const conn = makeIncomingConn('guest-open-only');
    const connected = vi.fn();
    const stopConnected = bus.on('network:peer-connected', connected);

    try {
      handleHostIncomingConnection(conn);
      conn.fire('open');

      expect(connected).not.toHaveBeenCalled();
      expect(getState('network.connectedPeers')).toEqual([
        expect.objectContaining({ id: conn.peer, conn, status: 'connecting' }),
      ]);
      expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.WELCOME }));
    } finally {
      stopConnected();
    }
  });

  it('closes and detaches a standard peer that never sends HELLO after exactly 10s', () => {
    const conn = makeIncomingConn('guest-no-hello');
    const connected = vi.fn();
    const stopConnected = bus.on('network:peer-connected', connected);

    try {
      handleHostIncomingConnection(conn);
      conn.fire('open');

      vi.advanceTimersByTime(JOIN_BOOTSTRAP_TIMEOUT_MS - 1);
      expect(conn.close).not.toHaveBeenCalled();
      expect(connected).not.toHaveBeenCalled();
      expect(getState('network.connectedPeers')).toEqual([
        expect.objectContaining({ id: conn.peer, conn, status: 'connecting' }),
      ]);
      expect(getState('network.activeHostConnByPeerId').get(conn.peer)).toBe(conn);

      vi.advanceTimersByTime(1);
    } finally {
      stopConnected();
    }

    expect(conn.close).toHaveBeenCalledOnce();
    expect(connected).not.toHaveBeenCalled();
    expect(getState('network.connectedPeers')).toHaveLength(0);
    expect(getState('network.activeHostConnByPeerId').has(conn.peer)).toBe(false);
  });

  it('fails closed when an application frame precedes the exact HELLO', () => {
    const conn = makeIncomingConn('guest-early-application-frame');
    const connected = vi.fn();
    const stopConnected = bus.on('network:peer-connected', connected);

    try {
      handleHostIncomingConnection(conn);
      conn.fire('open');
      conn.fire('data', { type: MSG.SYNC_PING, pingId: 1, guestTime: 1 });
    } finally {
      stopConnected();
    }

    expect(connected).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalledOnce();
    expect(getState('network.connectedPeers')).toHaveLength(0);
  });

  it.each(['zero', 'one', 'wrong', 'extra'] as const)(
    'fails closed when the bootstrap listener acknowledges a %s-frame sequence',
    (variant) => {
      const conn = makeIncomingConn(`guest-invalid-bootstrap-${variant}`);
      const connected = vi.fn();
      const stopConnected = bus.on('network:peer-connected', connected);
      const stopBootstrap = bus.on('network:peer-bootstrap', (current, send, acknowledge) => {
        if (current !== conn) return;
        const playlist = {
          type: MSG.PLAYLIST_UPDATE,
          list: [],
          revision: 0,
          currentQueueItemId: null,
          bootstrap: true,
        };
        if (variant === 'one') send(playlist);
        if (variant === 'wrong') send({ type: MSG.REPEAT_MODE, value: 0, _bootstrap: true });
        if (variant === 'extra') {
          send(playlist);
          send({ type: MSG.REPEAT_MODE, value: 0, _bootstrap: true });
          send({ type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true });
          send({ type: MSG.SHUFFLE_MODE, value: false, _bootstrap: true });
        }
        acknowledge(true);
      });

      try {
        handleHostIncomingConnection(conn);
        conn.fire('open');
        conn.fire('data', joinBootstrapHello());
      } finally {
        stopBootstrap();
        stopConnected();
      }

      expect(connected).not.toHaveBeenCalled();
      expect(conn.close).toHaveBeenCalledOnce();
      expect(getState('network.connectedPeers')).toHaveLength(0);
    },
  );

  it('requires HELLO, an acknowledged queue bootstrap, then matching APPLIED before playback', () => {
    const conn = makeIncomingConn('guest-bootstrap');
    const phases: string[] = [];
    const stopBootstrap = installStandardBootstrapResponder(conn, () => phases.push('queue'));
    const stopConnected = bus.on('network:peer-connected', (current) => {
      phases.push('playback');
      current.send({ type: MSG.PLAY } as never);
    });

    try {
      handleHostIncomingConnection(conn);
      conn.fire('open');

      expect(phases).toEqual([]);
      conn.fire('data', joinBootstrapHello());
      expect(phases).toEqual(['queue']);
      expect(getState('network.connectedPeers')[0]?.status).toBe('connecting');

      conn.fire('data', joinBootstrapApplied());
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

  it('queues one exact pre-open HELLO and applies it only after transport open', () => {
    const conn = makeIncomingConn('guest-pre-open-hello');
    const bootstrapped = vi.fn();
    const connected = vi.fn();
    const stopBootstrap = installStandardBootstrapResponder(conn, bootstrapped);
    const stopConnected = bus.on('network:peer-connected', connected);

    try {
      handleHostIncomingConnection(conn);
      conn.fire('data', joinBootstrapHello());
      expect(bootstrapped).not.toHaveBeenCalled();
      expect(connected).not.toHaveBeenCalled();

      conn.fire('open');
      expect(bootstrapped).toHaveBeenCalledOnce();
      expect(connected).not.toHaveBeenCalled();

      conn.fire('data', joinBootstrapApplied());
      expect(connected).toHaveBeenCalledOnce();
      expect(connected).toHaveBeenCalledWith(conn);
    } finally {
      stopBootstrap();
      stopConnected();
    }

    const sentTypes = conn.send.mock.calls.map(([message]) => (message as { type?: string }).type);
    expect(sentTypes.indexOf(MSG.WELCOME)).toBeLessThan(sentTypes.indexOf(MSG.PLAYLIST_UPDATE));
  });

  it('fails closed when APPLIED does not match the HELLO for this connection', () => {
    const conn = makeIncomingConn('guest-wrong-applied');
    const connected = vi.fn();
    const stopBootstrap = installStandardBootstrapResponder(conn);
    const stopConnected = bus.on('network:peer-connected', connected);

    try {
      handleHostIncomingConnection(conn);
      conn.fire('open');
      conn.fire('data', joinBootstrapHello(BOOTSTRAP_ID_A));
      conn.fire('data', joinBootstrapApplied(BOOTSTRAP_ID_B));
    } finally {
      stopBootstrap();
      stopConnected();
    }

    expect(connected).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalledOnce();
    expect(getState('network.connectedPeers')).toHaveLength(0);
    expect(getState('network.activeHostConnByPeerId').has(conn.peer)).toBe(false);
  });

  it('ignores stale APPLIED from a replaced exact connection', () => {
    const first = makeIncomingConn('guest-stale-applied');
    const replacement = makeIncomingConn('guest-stale-applied');
    const connected: DataConnection[] = [];
    const stopConnected = bus.on('network:peer-connected', (conn) => connected.push(conn));
    const stopFirstBootstrap = installStandardBootstrapResponder(first);

    try {
      handleHostIncomingConnection(first);
      first.fire('open');
      first.fire('data', joinBootstrapHello(BOOTSTRAP_ID_A));
      stopFirstBootstrap();

      handleHostIncomingConnection(replacement);
      first.fire('data', joinBootstrapApplied(BOOTSTRAP_ID_A));
      completeStandardJoin(replacement, BOOTSTRAP_ID_B);
    } finally {
      stopFirstBootstrap();
      stopConnected();
    }

    expect(connected).toEqual([replacement]);
    expect(getState('network.connectedPeers')).toEqual([
      expect.objectContaining({ id: replacement.peer, conn: replacement, status: 'connected' }),
    ]);
    expect(getState('network.activeHostConnByPeerId').get(replacement.peer)).toBe(replacement);
  });

  it('closes and detaches a standard peer that never sends APPLIED', () => {
    const conn = makeIncomingConn('guest-bootstrap-timeout');
    const connected = vi.fn();
    const stopBootstrap = installStandardBootstrapResponder(conn);
    const stopConnected = bus.on('network:peer-connected', connected);

    try {
      handleHostIncomingConnection(conn);
      conn.fire('open');
      conn.fire('data', joinBootstrapHello());
      vi.advanceTimersByTime(JOIN_BOOTSTRAP_TIMEOUT_MS);
    } finally {
      stopBootstrap();
      stopConnected();
    }

    expect(connected).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalledOnce();
    expect(getState('network.connectedPeers')).toHaveLength(0);
    expect(getState('network.activeHostConnByPeerId').has(conn.peer)).toBe(false);
  });

  it('keeps the PRO transport-open completion boundary without the standard handshake', () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage'],
    });
    const conn = makeIncomingConn('pro-controller');
    const bootstrapped = vi.fn();
    const connected = vi.fn();
    const stopBootstrap = bus.on('network:peer-bootstrap', bootstrapped);
    const stopConnected = bus.on('network:peer-connected', connected);

    try {
      handleHostIncomingConnection(conn);
      conn.fire('open');
    } finally {
      stopBootstrap();
      stopConnected();
    }

    expect(bootstrapped).not.toHaveBeenCalled();
    expect(connected).toHaveBeenCalledOnce();
    expect(connected).toHaveBeenCalledWith(conn);
    expect(getState('network.connectedPeers')[0]).toMatchObject({
      id: conn.peer,
      conn,
      status: 'connected',
    });
  });
});

describe('host operator toggle', () => {
  it('ignores the legacy operator toggle in a PRO room', () => {
    const send = vi.fn();
    const conn = makeConn(send);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage'],
    });
    setState('network.connectedPeers', [{ ...makePeer(conn), isOp: true }]);

    bus.emit('network:toggle-operator', 'guest-1');

    expect(getState('network.connectedPeers')[0].isOp).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('grants operator only after the target connection receives the message', () => {
    const send = vi.fn();
    const conn = makeConn(send);
    setState('network.connectedPeers', [makePeer(conn)]);

    bus.emit('network:toggle-operator', 'guest-1');

    expect(getState('network.connectedPeers')[0].isOp).toBe(true);
    expect(send).toHaveBeenNthCalledWith(1, {
      type: MSG.OPERATOR_GRANT,
      capabilities: [
        'effects.control',
        'media.add',
        'queue.mutate',
        'asset.upload',
        'playback.control',
        'members.manage',
        'chat.notice',
      ],
    });
    expect(mocks.showToast).toHaveBeenCalled();
  });

  it('keeps the canonical grant when its first projection cannot be sent', () => {
    const send = vi.fn(() => {
      throw new Error('send failed');
    });
    const conn = makeConn(send);
    setState('network.connectedPeers', [makePeer(conn)]);

    bus.emit('network:toggle-operator', 'guest-1');

    expect(getState('network.connectedPeers')[0].isOp).toBe(true);
    expect(getState('network.standardRoomAdministrators').has('peer:guest-1')).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.OPERATOR_GRANT }));
    expect(mocks.showToast).toHaveBeenCalled();
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

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MSG.OPERATOR_GRANT,
        capabilities: expect.arrayContaining(['media.add', 'playback.control']),
      }),
    );
    expect(resyncSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.REPEAT_MODE }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: MSG.SHUFFLE_MODE }));
  });
});

describe('standard-room account authority', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAllManagedTimers();
    vi.useRealTimers();
  });

  it('marks an unchanged ordinary member identity refresh as a silent projection', () => {
    const identity = verifiedIdentity();
    const conn = makeVerifiedIncomingConn('ordinary-refresh-device', identity);
    handleHostIncomingConnection(conn);
    conn.send.mockClear();

    conn.fire('identity', identity);

    expect(getState('network.connectedPeers')[0]).toMatchObject({
      memberId: identity.memberId,
      isAuthenticated: true,
      isOp: false,
    });
    expect(conn.send).toHaveBeenCalledWith({ type: MSG.OPERATOR_REVOKE, silent: true });
  });

  it('projects one persistent grant to every live device and restores it after reconnect', () => {
    const first = makeVerifiedIncomingConn('member-device-a');
    const second = makeVerifiedIncomingConn('member-device-b');
    handleHostIncomingConnection(first);
    handleHostIncomingConnection(second);

    bus.emit('network:grant-standard-room-administrator', {
      memberId: verifiedIdentity().memberId,
    });

    expect(getState('network.connectedPeers').map((peer) => peer.isOp)).toEqual([true, true]);
    expect(first.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.OPERATOR_GRANT }));
    expect(second.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.OPERATOR_GRANT }));
    const firstGrant = first.send.mock.calls.find(
      ([message]) => (message as { type?: string }).type === MSG.OPERATOR_GRANT,
    )?.[0] as { silent?: boolean } | undefined;
    const secondGrant = second.send.mock.calls.find(
      ([message]) => (message as { type?: string }).type === MSG.OPERATOR_GRANT,
    )?.[0] as { silent?: boolean } | undefined;
    expect(firstGrant?.silent).toBeUndefined();
    expect(secondGrant?.silent).toBeUndefined();

    first.fire('close');
    second.fire('close');
    expect(getState('network.standardRoomAdministrators').has(verifiedIdentity().memberId)).toBe(
      true,
    );

    const reconnected = makeVerifiedIncomingConn('member-device-c');
    handleHostIncomingConnection(reconnected);
    completeStandardJoin(reconnected);
    expect(getState('network.connectedPeers')).toEqual([
      expect.objectContaining({
        id: 'member-device-c',
        memberId: verifiedIdentity().memberId,
        isOp: true,
      }),
    ]);
    expect(reconnected.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.OPERATOR_GRANT, silent: true }),
    );
  });

  it('sends a definitive silent revoke after an ordinary member reconnects', () => {
    const identity = verifiedIdentity();
    const reconnected = makeVerifiedIncomingConn('revoked-member-reconnect', identity);

    handleHostIncomingConnection(reconnected);
    // Clear projections produced while identity was resolved before RTC open.
    // The post-open frame is the definitive acknowledgement that lets a guest
    // discard any disconnected settings takeover it may have retained.
    reconnected.send.mockClear();
    completeStandardJoin(reconnected);

    expect(getState('network.connectedPeers')[0]).toMatchObject({
      id: 'revoked-member-reconnect',
      memberId: identity.memberId,
      isOp: false,
    });
    expect(reconnected.send).toHaveBeenCalledWith({
      type: MSG.OPERATOR_REVOKE,
      silent: true,
    });
  });

  it('revokes one account grant from every live device at once', () => {
    const identity = verifiedIdentity();
    const first = makeVerifiedIncomingConn('revoke-device-a', identity);
    const second = makeVerifiedIncomingConn('revoke-device-b', identity);
    handleHostIncomingConnection(first);
    handleHostIncomingConnection(second);
    bus.emit('network:grant-standard-room-administrator', { memberId: identity.memberId });
    first.send.mockClear();
    second.send.mockClear();

    bus.emit('network:revoke-standard-room-administrator', { memberId: identity.memberId });

    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(false);
    expect(getState('network.connectedPeers')).toEqual([
      expect.objectContaining({ id: 'revoke-device-a', isOp: false, roomCapabilities: [] }),
      expect.objectContaining({ id: 'revoke-device-b', isOp: false, roomCapabilities: [] }),
    ]);
    expect(first.send).toHaveBeenCalledWith({ type: MSG.OPERATOR_REVOKE });
    expect(second.send).toHaveBeenCalledWith({ type: MSG.OPERATOR_REVOKE });
  });

  it('projects full host-routed product authority to an exact verified sibling device', () => {
    const identity = verifiedIdentity();
    setAuthenticatedPhysicalHost(identity);
    const sameAccountGuest = makeVerifiedIncomingConn('host-account-second-device', identity);
    handleHostIncomingConnection(sameAccountGuest);
    completeStandardJoin(sameAccountGuest);

    expect(getState('network.connectedPeers')[0]).toMatchObject({
      memberId: identity.memberId,
      isAuthenticated: true,
      isOp: true,
      roomCapabilities: [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES],
    });
    expect(sameAccountGuest.send).toHaveBeenCalledWith({
      type: MSG.OPERATOR_GRANT,
      capabilities: [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES],
      silent: true,
    });
    expect(STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES).not.toContain('system-audio.publish');
    expect(STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES).not.toContain('coordinator.eligible');
    expect(isCoordinator()).toBe(true);
    expect(getState('network.appRole')).toBe('host');
    expect(getState('network.hostConn')).toBeNull();
  });

  it('does not project owner authority from a matching nickname or a different member id', () => {
    const owner = verifiedIdentity('member_abcdefghijklmnopqrstuv', 'Shared name', 1);
    const impostor = verifiedIdentity('member_vutsrqponmlkjihgfedcba', 'Shared name', 2);
    setAuthenticatedPhysicalHost(owner);
    const differentAccount = makeVerifiedIncomingConn('different-account-device', impostor);

    handleHostIncomingConnection(differentAccount);

    expect(getState('network.connectedPeers')[0]).toMatchObject({
      memberId: impostor.memberId,
      label: owner.nickname,
      isAuthenticated: true,
      isOp: false,
      roomCapabilities: [],
    });
  });

  it('fails closed across host login, logout, and account deletion state changes', () => {
    const identity = verifiedIdentity();
    setState('network.appRole', 'host');
    const sibling = makeVerifiedIncomingConn('account-lifecycle-sibling', identity);
    handleHostIncomingConnection(sibling);
    completeStandardJoin(sibling);
    sibling.send.mockClear();

    expect(getState('network.connectedPeers')[0].isOp).toBe(false);

    setState('network.myMemberId', identity.memberId);
    setState('network.myMemberAuthenticated', true);
    expect(getState('network.connectedPeers')[0]).toMatchObject({
      isOp: true,
      roomCapabilities: [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES],
    });
    expect(sibling.send).toHaveBeenCalledWith({
      type: MSG.OPERATOR_GRANT,
      capabilities: [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES],
      silent: true,
    });

    setState('network.myMemberAuthenticated', false);
    setState('network.myMemberId', null);
    expect(getState('network.connectedPeers')[0]).toMatchObject({
      isOp: false,
      roomCapabilities: [],
    });
    expect(sibling.send).toHaveBeenCalledWith({ type: MSG.OPERATOR_REVOKE, silent: true });

    setState('network.myMemberId', identity.memberId);
    setState('network.myMemberAuthenticated', true);
    expect(getState('network.connectedPeers')[0].isOp).toBe(true);

    // Account deletion clears the signed local projection. Sibling product
    // authority disappears immediately; the physical host transport remains.
    setState('network.myMemberAuthenticated', false);
    setState('network.myMemberId', null);
    expect(getState('network.connectedPeers')[0].isOp).toBe(false);
    expect(isCoordinator()).toBe(true);
  });

  it('removes owner projection when a sibling proof expires and restores it only after reassertion', () => {
    const identity = verifiedIdentity();
    setAuthenticatedPhysicalHost(identity);
    const sibling = makeVerifiedIncomingConn('owner-proof-lifecycle', identity);
    handleHostIncomingConnection(sibling);
    completeStandardJoin(sibling);

    expect(getState('network.connectedPeers')[0].isOp).toBe(true);
    sibling.send.mockClear();

    sibling.fire('identity', null, 'expired');
    expect(getState('network.connectedPeers')[0]).toMatchObject({
      isAuthenticated: false,
      isOp: false,
      roomCapabilities: [],
    });
    expect(sibling.send).toHaveBeenCalledWith({ type: MSG.OPERATOR_REVOKE, silent: true });
    sibling.send.mockClear();

    sibling.fire('identity', identity);
    expect(getState('network.connectedPeers')[0]).toMatchObject({
      memberId: identity.memberId,
      isAuthenticated: true,
      isOp: true,
      roomCapabilities: [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES],
    });
    expect(sibling.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: MSG.OPERATOR_GRANT, silent: true }),
    );
    sibling.send.mockClear();

    sibling.fire('identity', null, 'deleted');
    expect(getState('network.connectedPeers')[0]).toMatchObject({
      isAuthenticated: false,
      isOp: false,
      roomCapabilities: [],
    });
    expect(sibling.send).toHaveBeenCalledWith({ type: MSG.OPERATOR_REVOKE, silent: true });
    expect(isCoordinator()).toBe(true);
  });

  it('ignores legacy operator toggles for a verified owner sibling', () => {
    const identity = verifiedIdentity();
    setAuthenticatedPhysicalHost(identity);
    const sibling = makeVerifiedIncomingConn('owner-legacy-toggle', identity);
    handleHostIncomingConnection(sibling);
    completeStandardJoin(sibling);
    sibling.send.mockClear();
    mocks.showToast.mockClear();

    bus.emit('network:toggle-operator', sibling.peer);

    expect(getState('network.connectedPeers')[0]).toMatchObject({
      isOp: true,
      roomCapabilities: [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES],
    });
    expect(sibling.send).not.toHaveBeenCalledWith({ type: MSG.OPERATOR_REVOKE });
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('re-baselines stateful controls when owner projection narrows to an explicit admin grant', () => {
    const identity = verifiedIdentity();
    setAuthenticatedPhysicalHost(identity);
    const sibling = makeVerifiedIncomingConn('owner-to-admin', identity);
    handleHostIncomingConnection(sibling);
    completeStandardJoin(sibling);
    bus.emit('network:grant-standard-room-administrator', { memberId: identity.memberId });
    sibling.send.mockClear();
    setState('playlist.repeatMode', 2);
    setState('playlist.isShuffle', true);
    const resync = vi.fn();
    bus.on('effects:resync-peer', resync);

    setState('network.myMemberAuthenticated', false);

    expect(getState('network.connectedPeers')[0]).toMatchObject({
      isOp: true,
      roomCapabilities: [
        'effects.control',
        'media.add',
        'queue.mutate',
        'asset.upload',
        'playback.control',
        'members.manage',
        'chat.notice',
      ],
    });
    expect(resync).toHaveBeenCalledWith(sibling);
    expect(sibling.send).toHaveBeenCalledWith({
      type: MSG.REPEAT_MODE,
      value: 2,
      _bootstrap: true,
    });
    expect(sibling.send).toHaveBeenCalledWith({
      type: MSG.SHUFFLE_MODE,
      value: true,
      _bootstrap: true,
    });
  });

  it('removes an anonymous one-session grant when that physical connection leaves', () => {
    const anonymous = makeIncomingConn('anonymous-admin');
    handleHostIncomingConnection(anonymous);
    bus.emit('network:grant-standard-room-administrator', {
      memberId: 'peer:anonymous-admin',
    });
    expect(getState('network.standardRoomAdministrators').has('peer:anonymous-admin')).toBe(true);

    anonymous.fire('close');

    expect(getState('network.standardRoomAdministrators').has('peer:anonymous-admin')).toBe(false);
  });

  it('removes an anonymous grant when the connection never opens and times out', () => {
    const anonymous = makeIncomingConn('anonymous-timeout');
    handleHostIncomingConnection(anonymous);
    bus.emit('network:grant-standard-room-administrator', {
      memberId: 'peer:anonymous-timeout',
    });

    vi.advanceTimersByTime(15_000);

    expect(getState('network.standardRoomAdministrators').has('peer:anonymous-timeout')).toBe(
      false,
    );
    expect(getState('network.connectedPeers')).toHaveLength(0);
    expect(getState('network.activeHostConnByPeerId').has('anonymous-timeout')).toBe(false);
    expect(anonymous.close).toHaveBeenCalledTimes(1);
  });

  it('does not transfer an anonymous grant to a replacement connection with the same peer ID', () => {
    const original = makeIncomingConn('anonymous-replaced');
    handleHostIncomingConnection(original);
    bus.emit('network:grant-standard-room-administrator', {
      memberId: 'peer:anonymous-replaced',
    });

    const replacement = makeIncomingConn('anonymous-replaced');
    handleHostIncomingConnection(replacement);

    expect(getState('network.standardRoomAdministrators').has('peer:anonymous-replaced')).toBe(
      false,
    );
    expect(getState('network.connectedPeers')).toEqual([
      expect.objectContaining({
        id: 'anonymous-replaced',
        conn: replacement,
        isAuthenticated: false,
        isOp: false,
      }),
    ]);
    expect(getState('network.activeHostConnByPeerId').get('anonymous-replaced')).toBe(replacement);
  });

  it('projects a retained account grant onto an authenticated replacement connection', () => {
    const identity = verifiedIdentity();
    const original = makeVerifiedIncomingConn('authenticated-replaced', identity);
    handleHostIncomingConnection(original);
    bus.emit('network:grant-standard-room-administrator', { memberId: identity.memberId });

    const replacement = makeVerifiedIncomingConn('authenticated-replaced', identity);
    handleHostIncomingConnection(replacement);

    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(true);
    expect(getState('network.connectedPeers')).toEqual([
      expect.objectContaining({
        id: 'authenticated-replaced',
        conn: replacement,
        memberId: identity.memberId,
        isAuthenticated: true,
        isOp: true,
      }),
    ]);
  });

  it('retains an authenticated grant when its pre-open connection times out', () => {
    const identity = verifiedIdentity();
    const authenticated = makeVerifiedIncomingConn('authenticated-timeout', identity);
    handleHostIncomingConnection(authenticated);
    bus.emit('network:grant-standard-room-administrator', { memberId: identity.memberId });

    vi.advanceTimersByTime(15_000);

    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(true);
    expect(getState('network.connectedPeers')).toHaveLength(0);
    expect(authenticated.close).toHaveBeenCalledTimes(1);
  });

  it('downgrades an expired identity but restores its remembered grant after reassertion', () => {
    const identity = verifiedIdentity();
    const conn = makeVerifiedIncomingConn('expiring-device', identity);
    handleHostIncomingConnection(conn);
    bus.emit('network:grant-standard-room-administrator', { memberId: identity.memberId });

    conn.fire('identity', null, 'expired');
    expect(getState('network.connectedPeers')[0]).toMatchObject({
      id: 'expiring-device',
      isAuthenticated: false,
      isOp: false,
    });
    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(true);
    expect(conn.send).toHaveBeenCalledWith({ type: MSG.OPERATOR_REVOKE, silent: true });

    conn.fire('identity', identity);
    expect(getState('network.connectedPeers')[0]).toMatchObject({
      memberId: identity.memberId,
      isAuthenticated: true,
      isOp: true,
    });
    expect(conn.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: MSG.OPERATOR_GRANT, silent: true }),
    );
  });

  it('retains an account grant across explicit logout after its lease expired', () => {
    const identity = verifiedIdentity();
    const conn = makeVerifiedIncomingConn('logout-after-expiry', identity);
    handleHostIncomingConnection(conn);
    bus.emit('network:grant-standard-room-administrator', { memberId: identity.memberId });

    conn.fire('identity', null, 'expired');
    conn.send.mockClear();
    conn.fire('identity', null, 'explicit');

    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(true);
    expect(getState('network.connectedPeers')[0]).toMatchObject({
      isAuthenticated: false,
      isOp: false,
    });
    expect(conn.send).toHaveBeenCalledWith({ type: MSG.OPERATOR_REVOKE, silent: true });
  });

  it('revokes a remembered grant when the server confirms account deletion after lease expiry', () => {
    const identity = verifiedIdentity();
    const conn = makeVerifiedIncomingConn('deleted-after-expiry', identity);
    handleHostIncomingConnection(conn);
    bus.emit('network:grant-standard-room-administrator', { memberId: identity.memberId });

    conn.fire('identity', null, 'expired');
    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(true);

    bus.emit('network:standard-room-account-deleted', { memberId: identity.memberId });

    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(false);
    expect(getState('network.connectedPeers')[0]).toMatchObject({
      isAuthenticated: false,
      isOp: false,
    });
  });

  it('keeps a remembered account grant after every live device logs out', () => {
    const identity = verifiedIdentity();
    const first = makeVerifiedIncomingConn('logout-device-a', identity);
    const second = makeVerifiedIncomingConn('logout-device-b', identity);
    handleHostIncomingConnection(first);
    handleHostIncomingConnection(second);
    bus.emit('network:grant-standard-room-administrator', { memberId: identity.memberId });

    first.fire('identity', null, 'explicit');
    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(true);
    expect(
      getState('network.connectedPeers').find((peer) => peer.id === 'logout-device-b'),
    ).toMatchObject({
      isOp: true,
    });

    second.fire('identity', null, 'explicit');
    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(true);
    expect(
      getState('network.connectedPeers').filter((peer) => peer.isOp || peer.isAuthenticated),
    ).toHaveLength(0);
  });

  it('revokes the account grant only for a trusted account-deleted identity event', () => {
    const identity = verifiedIdentity();
    const conn = makeVerifiedIncomingConn('deleted-account-device', identity);
    handleHostIncomingConnection(conn);
    bus.emit('network:grant-standard-room-administrator', { memberId: identity.memberId });

    conn.fire('identity', null, 'deleted');

    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(false);
    expect(getState('network.connectedPeers')[0]).toMatchObject({
      isAuthenticated: false,
      isOp: false,
    });
  });

  it('keeps delegated permissions narrow when updating an administrator', () => {
    const identity = verifiedIdentity();
    const conn = makeVerifiedIncomingConn('limited-admin', identity);
    handleHostIncomingConnection(conn);
    bus.emit('network:grant-standard-room-administrator', {
      memberId: identity.memberId,
      permissions: {
        'media.add': true,
        'playback.control': false,
        'members.kick': false,
        'chat.notice': false,
      },
    });

    expect(getState('network.connectedPeers')[0].roomCapabilities).toEqual([
      'effects.control',
      'media.add',
      'queue.mutate',
      'asset.upload',
    ]);

    bus.emit('network:update-standard-room-administrator', {
      memberId: identity.memberId,
      permissions: {
        'media.add': false,
        'playback.control': true,
        'members.kick': false,
        'chat.notice': false,
      },
    });

    expect(getState('network.connectedPeers')[0].roomCapabilities).toEqual([
      'effects.control',
      'playback.control',
    ]);
    expect(conn.send).toHaveBeenLastCalledWith({
      type: MSG.OPERATOR_GRANT,
      capabilities: ['effects.control', 'playback.control'],
      silent: true,
    });
  });

  it('kicks all live devices for one verified member and revokes the grant', () => {
    const identity = verifiedIdentity();
    const first = makeVerifiedIncomingConn('kick-device-a', identity);
    const second = makeVerifiedIncomingConn('kick-device-b', identity);
    const other = makeVerifiedIncomingConn(
      'other-account-device',
      verifiedIdentity('member_zyxwvutsrqponmlkjihgfe', 'Jisu', 2),
    );
    handleHostIncomingConnection(first);
    handleHostIncomingConnection(second);
    handleHostIncomingConnection(other);
    bus.emit('network:grant-standard-room-administrator', { memberId: identity.memberId });

    bus.emit('network:request-kick-standard-room-member', { memberId: identity.memberId });

    expect(first.send).toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(second.send).toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(other.send).not.toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(false);
    vi.advanceTimersByTime(300);
    expect(first.close).toHaveBeenCalled();
    expect(second.close).toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
  });

  it('disconnects one physical device while preserving its sibling and member grant', () => {
    const identity = verifiedIdentity();
    const first = makeVerifiedIncomingConn('physical-device-a', identity);
    const second = makeVerifiedIncomingConn('physical-device-b', identity);
    handleHostIncomingConnection(first);
    handleHostIncomingConnection(second);
    completeStandardJoin(first);
    completeStandardJoin(second, BOOTSTRAP_ID_B);
    bus.emit('network:grant-standard-room-administrator', { memberId: identity.memberId });

    bus.emit('network:request-kick-standard-room-device', { peerId: 'physical-device-a' });

    expect(first.send).toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(second.send).not.toHaveBeenCalledWith({ type: MSG.KICK_DEVICE });
    expect(getState('network.standardRoomAdministrators').has(identity.memberId)).toBe(true);
    vi.advanceTimersByTime(300);
    expect(first.close).toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
  });
});

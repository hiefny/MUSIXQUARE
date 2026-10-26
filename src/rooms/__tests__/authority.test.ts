import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import type { ConnectedPeer, DataConnection, RoomContext } from '../../types/index.ts';
import {
  getAuthorityConnectionForTests as getAuthorityConnection,
  hasRoomCapability,
  isActiveStandardRoomCoordinator,
  isAuthoritativeConnection,
  isCoordinator,
  isStandardRoomMember,
  isStandardRoomRole,
  markStandardRoomAuthorityConfirmed,
  resetRoomContext,
  roomCapabilityStatus,
  setRoomContext,
  subscribeRoomAuthorityLifecycle,
  verifyPeerCapability,
  beginStandardRoomAccountAuthorityCheck,
  settleStandardRoomAccountAuthorityCheck,
  acceptStandardRoomAccountAuthorityIdentity,
  acceptStandardRoomHostIdentityProjection,
  resetStandardRoomAccountAuthorityCheck,
} from '../authority.ts';

function connection(peer: string): DataConnection {
  return { peer, open: true } as DataConnection;
}

function connectedPeer(
  conn: DataConnection,
  overrides: Partial<ConnectedPeer> = {},
): ConnectedPeer {
  return {
    id: conn.peer,
    slot: 1,
    label: 'Peer 1',
    conn,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: Date.now(),
    ...overrides,
  };
}

function proContext(overrides: Partial<RoomContext> = {}): RoomContext {
  return {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: 'member-coordinator',
    epoch: 1,
    snapshotRevision: 1,
    capabilities: ['playback.control'],
    ...overrides,
  };
}

beforeEach(() => {
  resetStandardRoomAccountAuthorityCheck();
  resetState();
  bus.clear();
});

describe('standard account authority feedback', () => {
  const input = { roomCode: '123456', peerId: 'guest-1', role: 'guest' as const };
  function join() {
    const conn = connection('host');
    setState('network.appRole', 'guest');
    setState('network.myId', input.peerId);
    setState('network.lastJoinCode', input.roomCode);
    setState('network.hostConn', conn);
    markStandardRoomAuthorityConfirmed(conn);
    return conn;
  }
  function roster(conn: DataConnection, memberId: string | null) {
    acceptStandardRoomHostIdentityProjection(conn, {
      id: input.peerId,
      label: 'Peer',
      isHost: false,
      isOp: false,
      status: 'connected',
      isAuthenticated: memberId !== null,
      ...(memberId ? { memberId } : {}),
    });
  }

  it.each(['identity-first', 'roster-first'])(
    'waits beyond an anonymous revoke until the verified account matches the host (%s)',
    (order) => {
      const conn = join();
      const check = beginStandardRoomAccountAuthorityCheck(input);
      roster(conn, null);
      expect(roomCapabilityStatus('asset.upload')).toBe('pending');
      expect(hasRoomCapability('asset.upload')).toBe(false);
      settleStandardRoomAccountAuthorityCheck(check, false);
      if (order === 'identity-first') {
        acceptStandardRoomAccountAuthorityIdentity('member-current');
        expect(roomCapabilityStatus('asset.upload')).toBe('pending');
        roster(conn, 'member-current');
      } else {
        roster(conn, 'member-current');
        expect(roomCapabilityStatus('asset.upload')).toBe('pending');
        acceptStandardRoomAccountAuthorityIdentity('member-current');
      }
      // Same member, confirmed host revoke: this is a real denial.
      expect(roomCapabilityStatus('asset.upload')).toBe('denied');
    },
  );

  it('honors the current host grant immediately while account feedback is pending', () => {
    const conn = join();
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['asset.upload']);
    const check = beginStandardRoomAccountAuthorityCheck(input);
    expect(hasRoomCapability('asset.upload')).toBe(true);
    expect(roomCapabilityStatus('asset.upload')).toBe('granted');
    settleStandardRoomAccountAuthorityCheck(check, false);
    acceptStandardRoomAccountAuthorityIdentity('member-current');
    roster(conn, 'member-current');
    expect(roomCapabilityStatus('asset.upload')).toBe('granted');
  });

  it('requires a fresh host projection when a changed account resolves to the same member', () => {
    const conn = join();
    roster(conn, 'member-current');
    setState('network.myMemberAuthenticated', true);
    const check = beginStandardRoomAccountAuthorityCheck(input, true);
    settleStandardRoomAccountAuthorityCheck(check, false);
    acceptStandardRoomAccountAuthorityIdentity('member-current');
    expect(roomCapabilityStatus('asset.upload')).toBe('pending');
    roster(conn, 'member-current');
    expect(roomCapabilityStatus('asset.upload')).toBe('denied');
  });

  it('does not hide definitive anonymous or server-cleared authority behind checking', () => {
    const conn = join();
    const check = beginStandardRoomAccountAuthorityCheck(input);
    settleStandardRoomAccountAuthorityCheck(check, true);
    expect(roomCapabilityStatus('asset.upload')).toBe('denied');
    roster(conn, null);
    beginStandardRoomAccountAuthorityCheck(input);
    acceptStandardRoomAccountAuthorityIdentity(null, 'explicit');
    expect(roomCapabilityStatus('asset.upload')).toBe('denied');
    beginStandardRoomAccountAuthorityCheck(input);
    acceptStandardRoomAccountAuthorityIdentity(null, 'deleted');
    expect(roomCapabilityStatus('asset.upload')).toBe('denied');
  });

  it('ignores old assertion completions and a predecessor identity while its successor is unresolved', () => {
    const conn = join();
    const first = beginStandardRoomAccountAuthorityCheck(input);
    beginStandardRoomAccountAuthorityCheck(input);
    settleStandardRoomAccountAuthorityCheck(first, true);
    acceptStandardRoomAccountAuthorityIdentity('member-old');
    roster(conn, 'member-old');
    expect(roomCapabilityStatus('asset.upload')).toBe('pending');
  });

  it('does not turn a confirmed member renewal into pending and retires checks at teardown', () => {
    join();
    setState('network.myMemberAuthenticated', true);
    expect(beginStandardRoomAccountAuthorityCheck(input)).toBeNull();
    expect(roomCapabilityStatus('asset.upload')).toBe('denied');
    const changed = beginStandardRoomAccountAuthorityCheck(input, true);
    expect(roomCapabilityStatus('asset.upload')).toBe('pending');
    resetStandardRoomAccountAuthorityCheck();
    settleStandardRoomAccountAuthorityCheck(changed, true);
    expect(roomCapabilityStatus('asset.upload')).toBe('denied');
    setState('network.hostConn', connection('replacement'));
    expect(roomCapabilityStatus('asset.upload')).toBe('pending');
  });
});

describe('room authority compatibility layer', () => {
  it('centralizes every standard and PRO authority lifecycle signal', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRoomAuthorityLifecycle(listener);

    setState('network.appRole', 'host');
    setState('network.hostConn', connection('host'));
    setState('network.sessionCode', '123456');
    setState('setup.sessionStarted', true);
    setRoomContext(proContext());
    setState('playback.mode', 'youtube');

    expect(listener).toHaveBeenCalledTimes(5);

    unsubscribe();
    setState('network.appRole', 'guest');
    setState('network.hostConn', null);
    setState('network.sessionCode', '654321');
    setState('setup.sessionStarted', false);
    setRoomContext({ ...proContext(), epoch: 2 });

    expect(listener).toHaveBeenCalledTimes(5);
  });

  it('projects setup-side roles only for standard rooms', () => {
    expect(isStandardRoomRole('host')).toBe(false);
    expect(isStandardRoomRole('guest')).toBe(false);

    setState('network.appRole', 'host');
    expect(isStandardRoomRole('host')).toBe(true);
    expect(isStandardRoomRole('guest')).toBe(false);

    setState('network.appRole', 'guest');
    expect(isStandardRoomRole('host')).toBe(false);
    expect(isStandardRoomRole('guest')).toBe(true);

    setRoomContext(proContext());
    expect(isStandardRoomRole('host')).toBe(false);
    expect(isStandardRoomRole('guest')).toBe(false);
  });

  it('identifies only the participant side of a standard room', () => {
    expect(isStandardRoomMember()).toBe(false);

    setState('network.appRole', 'host');
    expect(isStandardRoomMember()).toBe(false);

    setState('network.appRole', 'guest');
    expect(isStandardRoomMember()).toBe(true);

    setRoomContext(proContext());
    expect(isStandardRoomMember()).toBe(false);
  });

  it('opens standard timeline authority only after the room is actually active', () => {
    setState('network.appRole', 'host');
    setState('network.sessionCode', '100000');

    expect(isCoordinator()).toBe(true);
    expect(isActiveStandardRoomCoordinator()).toBe(false);

    setState('setup.sessionStarted', true);
    expect(isActiveStandardRoomCoordinator()).toBe(true);

    setState('network.sessionCode', '999999');
    expect(isActiveStandardRoomCoordinator()).toBe(true);

    setState('network.sessionCode', '000000');
    expect(isActiveStandardRoomCoordinator()).toBe(false);

    setState('network.sessionCode', '099999');
    expect(isActiveStandardRoomCoordinator()).toBe(false);

    setState('network.sessionCode', '12345');
    expect(isActiveStandardRoomCoordinator()).toBe(false);
  });

  it('preserves standard host and operator permissions', () => {
    setState('network.appRole', 'host');
    expect(isCoordinator()).toBe(true);
    expect(hasRoomCapability('queue.mutate')).toBe(true);
    expect(hasRoomCapability('room.configure')).toBe(true);
    expect(hasRoomCapability('chat.notice')).toBe(true);

    const host = connection('host');
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['playback.control', 'asset.upload']);
    expect(isCoordinator()).toBe(false);
    expect(getAuthorityConnection()).toBe(host);
    expect(isAuthoritativeConnection(host)).toBe(true);
    expect(hasRoomCapability('playback.control')).toBe(true);
    expect(hasRoomCapability('queue.mutate')).toBe(false);
    expect(hasRoomCapability('asset.upload')).toBe(true);
  });

  it('fails closed when stale operator state outlives the live host connection', () => {
    const host = connection('host');
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['asset.upload']);
    expect(hasRoomCapability('asset.upload')).toBe(true);
    expect(hasRoomCapability('queue.mutate')).toBe(false);

    host.open = false;
    expect(hasRoomCapability('queue.mutate')).toBe(false);
    expect(hasRoomCapability('asset.upload')).toBe(false);

    setState('network.hostConn', null);
    expect(hasRoomCapability('queue.mutate')).toBe(false);
    expect(hasRoomCapability('asset.upload')).toBe(false);
  });

  it('grants a standard guest operator nothing without an explicit grant list', () => {
    const host = connection('host');
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', null);

    expect(hasRoomCapability('media.add')).toBe(false);
    expect(hasRoomCapability('playback.control')).toBe(false);
    expect(hasRoomCapability('effects.control')).toBe(false);
    expect(hasRoomCapability('asset.upload')).toBe(false);

    setState('network.standardRoomCapabilities', []);
    expect(hasRoomCapability('playback.control')).toBe(false);
  });

  it('separates a standard owner sibling product authority from physical coordination', () => {
    const host = connection('physical-host');
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', [
      'media.add',
      'queue.mutate',
      'playback.control',
      'effects.control',
      'asset.upload',
      'members.manage',
      'chat.notice',
      'room.configure',
    ]);

    expect(hasRoomCapability('queue.mutate')).toBe(true);
    expect(hasRoomCapability('effects.control')).toBe(true);
    expect(hasRoomCapability('room.configure')).toBe(true);
    expect(hasRoomCapability('system-audio.publish')).toBe(false);
    expect(hasRoomCapability('coordinator.eligible')).toBe(false);
    expect(isCoordinator()).toBe(false);
    expect(getAuthorityConnection()).toBe(host);
  });

  it('authorizes queue mutation only for the exact live standard operator connection', () => {
    const live = connection('operator-1');
    const stale = connection('operator-1');
    setState('network.appRole', 'host');
    setState('network.activeHostConnByPeerId', new Map([[live.peer, live]]));
    setState('network.connectedPeers', [
      connectedPeer(live, {
        isOp: true,
        roomCapabilities: ['playback.control', 'asset.upload'],
      }),
    ]);

    expect(verifyPeerCapability(live, 'queue.mutate')).toBe(false);
    expect(verifyPeerCapability(live, 'asset.upload')).toBe(true);
    expect(verifyPeerCapability(stale, 'queue.mutate')).toBe(false);
  });

  it('uses only server-projected capabilities in a PRO room', () => {
    setRoomContext(proContext({ capabilities: ['queue.mutate', 'asset.upload'] }));
    setState('network.appRole', 'guest');
    setState('network.isOperator', true);

    expect(hasRoomCapability('queue.mutate')).toBe(true);
    expect(hasRoomCapability('asset.upload')).toBe(true);
    expect(hasRoomCapability('room.configure')).toBe(false);
    expect(hasRoomCapability('playback.control')).toBe(false);
  });

  it('ignores the host/operator compatibility projection for PRO authority', () => {
    setRoomContext(proContext({ role: 'member', coordinatorId: null, capabilities: [] }));
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('network.isOperator', true);

    expect(isCoordinator()).toBe(false);
    expect(hasRoomCapability('queue.mutate')).toBe(false);
    expect(hasRoomCapability('playback.control')).toBe(false);

    setRoomContext(
      proContext({
        role: 'member',
        coordinatorId: null,
        capabilities: ['playback.control'],
      }),
    );
    expect(hasRoomCapability('playback.control')).toBe(true);
    expect(hasRoomCapability('queue.mutate')).toBe(false);
  });

  it('keeps coordinator identity separate from owner/controller role', () => {
    setRoomContext(proContext({ role: 'coordinator' }));
    setState('network.appRole', 'host');
    expect(isCoordinator()).toBe(true);
    expect(getAuthorityConnection()).toBeNull();
  });

  it('rejects stale peer connections and unauthorized PRO peers', () => {
    const live = connection('member-2');
    const stale = connection('member-2');
    setRoomContext(proContext({ role: 'coordinator' }));
    setState('network.appRole', 'host');
    setState('network.activeHostConnByPeerId', new Map([[live.peer, live]]));
    setState('network.connectedPeers', [
      connectedPeer(live, { roomCapabilities: ['playback.control'] }),
    ]);

    expect(isAuthoritativeConnection(live)).toBe(true);
    expect(isAuthoritativeConnection(stale)).toBe(false);
    expect(verifyPeerCapability(live, 'playback.control')).toBe(true);
    expect(verifyPeerCapability(live, 'queue.mutate')).toBe(false);
    expect(verifyPeerCapability(stale, 'playback.control')).toBe(false);
  });
});

describe('room capability status', () => {
  function joinAsGuest(conn: DataConnection): void {
    setState('network.appRole', 'guest');
    setState('network.isConnecting', false);
    setState('setup.sessionStarted', true);
    setState('network.hostConn', conn);
  }

  it('always gives the physical standard host a definitive answer', () => {
    setState('network.appRole', 'host');

    expect(roomCapabilityStatus('playback.control')).toBe('granted');
    expect(roomCapabilityStatus('system-audio.publish')).toBe('granted');

    // A host tab that is not in a room yet keeps the same local answer.
    setState('setup.sessionStarted', false);
    expect(roomCapabilityStatus('room.configure')).toBe('granted');
  });

  it('keeps a standard guest pending until the host projects its role on the live link', () => {
    const host = connection('host');
    joinAsGuest(host);

    expect(roomCapabilityStatus('media.add')).toBe('pending');
    expect(roomCapabilityStatus('effects.control')).toBe('pending');
    expect(roomCapabilityStatus('room.configure')).toBe('pending');
    // Pending is feedback only; gating still fails closed.
    expect(hasRoomCapability('media.add')).toBe(false);

    markStandardRoomAuthorityConfirmed(host);
    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', ['effects.control', 'playback.control']);

    expect(roomCapabilityStatus('playback.control')).toBe('granted');
    expect(roomCapabilityStatus('effects.control')).toBe('granted');
    expect(roomCapabilityStatus('media.add')).toBe('denied');
    expect(roomCapabilityStatus('members.manage')).toBe('denied');
  });

  it('confirms a plain guest as denied once its revoke projection has arrived', () => {
    const host = connection('host');
    joinAsGuest(host);
    markStandardRoomAuthorityConfirmed(host);

    expect(roomCapabilityStatus('media.add')).toBe('denied');
    expect(roomCapabilityStatus('playback.control')).toBe('denied');
    expect(roomCapabilityStatus('chat.notice')).toBe('denied');
    expect(roomCapabilityStatus('room.configure')).toBe('denied');
  });

  it('returns to pending while reconnecting and on a replacement host link', () => {
    const first = connection('host');
    joinAsGuest(first);
    markStandardRoomAuthorityConfirmed(first);
    expect(roomCapabilityStatus('media.add')).toBe('denied');

    first.open = false;
    expect(roomCapabilityStatus('media.add')).toBe('pending');

    setState('network.hostConn', null);
    expect(roomCapabilityStatus('media.add')).toBe('pending');

    const second = connection('host');
    setState('network.hostConn', second);
    expect(roomCapabilityStatus('media.add')).toBe('pending');

    markStandardRoomAuthorityConfirmed(second);
    expect(roomCapabilityStatus('media.add')).toBe('denied');
  });

  it('treats a guest that is joining as pending and one outside a session as denied', () => {
    setState('network.appRole', 'guest');
    expect(roomCapabilityStatus('media.add')).toBe('denied');

    setState('network.isConnecting', true);
    expect(roomCapabilityStatus('media.add')).toBe('pending');

    setState('network.isConnecting', false);
    setState('setup.sessionStarted', true);
    expect(roomCapabilityStatus('media.add')).toBe('pending');

    setState('network.appRole', 'idle');
    expect(roomCapabilityStatus('media.add')).toBe('denied');
  });

  it('never leaves a guest pending for physical host roles it cannot be granted', () => {
    joinAsGuest(connection('host'));

    expect(roomCapabilityStatus('system-audio.publish')).toBe('denied');
    expect(roomCapabilityStatus('coordinator.eligible')).toBe('denied');
  });

  it('answers a PRO room from its loaded context only', () => {
    // Before the PRO snapshot creates its context, the setup guest is still
    // waiting like any other joining guest.
    setState('network.appRole', 'guest');
    setState('network.isConnecting', true);
    expect(roomCapabilityStatus('playback.control')).toBe('pending');

    setRoomContext(proContext({ capabilities: ['playback.control'] }));
    setState('network.appRole', 'host');
    setState('network.isConnecting', true);

    expect(roomCapabilityStatus('playback.control')).toBe('granted');
    expect(roomCapabilityStatus('media.add')).toBe('denied');
    expect(roomCapabilityStatus('room.configure')).toBe('denied');

    resetRoomContext();
    setState('network.appRole', 'idle');
    setState('network.isConnecting', false);
    expect(roomCapabilityStatus('playback.control')).toBe('denied');
  });

  it('keeps a pending PRO account projection fail-closed until its replacement is accepted', () => {
    const context = proContext({ capabilities: ['playback.control', 'system-audio.publish'] });
    setRoomContext(context, 'pending');

    expect(hasRoomCapability('playback.control')).toBe(false);
    expect(roomCapabilityStatus('playback.control')).toBe('pending');
    expect(roomCapabilityStatus('system-audio.publish')).toBe('pending');
    expect(roomCapabilityStatus('coordinator.eligible')).toBe('denied');

    setRoomContext(context);
    expect(roomCapabilityStatus('playback.control')).toBe('granted');
    expect(roomCapabilityStatus('media.add')).toBe('denied');

    setRoomContext(context, 'pending');
    setRoomContext(proContext({ capabilities: [] }));
    expect(roomCapabilityStatus('playback.control')).toBe('denied');
  });

  it('does not retain pending PRO authority after a room reset', () => {
    setRoomContext(proContext(), 'pending');
    resetRoomContext();

    expect(roomCapabilityStatus('playback.control')).toBe('denied');
    setRoomContext(proContext({ capabilities: [] }));
    expect(roomCapabilityStatus('playback.control')).toBe('denied');
  });
});

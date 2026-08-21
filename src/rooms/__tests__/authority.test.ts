import { beforeEach, describe, expect, it } from 'vitest';
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
  setRoomContext,
  verifyPeerCapability,
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

beforeEach(() => resetState());

describe('room authority compatibility layer', () => {
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

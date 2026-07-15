import { beforeEach, describe, expect, it } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import type { ConnectedPeer, DataConnection, RoomContext } from '../../types/index.ts';
import {
  getAuthorityConnectionForTests as getAuthorityConnection,
  hasRoomCapability,
  isAuthoritativeConnection,
  isCoordinator,
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
  it('preserves standard host and operator permissions', () => {
    setState('network.appRole', 'host');
    expect(isCoordinator()).toBe(true);
    expect(hasRoomCapability('queue.mutate')).toBe(true);
    expect(hasRoomCapability('room.configure')).toBe(true);

    const host = connection('host');
    setState('network.appRole', 'guest');
    setState('network.hostConn', host);
    setState('network.isOperator', true);
    expect(isCoordinator()).toBe(false);
    expect(getAuthorityConnection()).toBe(host);
    expect(isAuthoritativeConnection(host)).toBe(true);
    expect(hasRoomCapability('playback.control')).toBe(true);
    expect(hasRoomCapability('queue.mutate')).toBe(false);
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

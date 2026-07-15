import { getState, setState } from '../core/state.ts';
import type { DataConnection, RoomCapability, RoomContext } from '../types/index.ts';

const STANDARD_HOST_CAPABILITIES = new Set<RoomCapability>([
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'members.manage',
  'room.configure',
  'coordinator.eligible',
]);

const STANDARD_OPERATOR_CAPABILITIES = new Set<RoomCapability>([
  'playback.control',
  'effects.control',
]);

export function createIdleRoomContext(): RoomContext {
  return {
    kind: 'standard',
    roomId: null,
    role: 'idle',
    coordinatorId: null,
    epoch: 0,
    snapshotRevision: 0,
    capabilities: [],
  };
}

export function getRoomContext(): Readonly<RoomContext> {
  return getState('room.context');
}

export function setRoomContext(context: RoomContext): void {
  setState('room.context', {
    ...context,
    capabilities: [...new Set(context.capabilities)],
  });
}

export function resetRoomContext(): void {
  setState('room.context', createIdleRoomContext());
}

export function isCoordinator(): boolean {
  const context = getRoomContext();
  if (context.kind === 'pro') return context.role === 'coordinator';
  return getState('network.appRole') === 'host' && !getState('network.hostConn');
}

export function getAuthorityConnection(): DataConnection | null {
  if (isCoordinator()) return null;
  return getState('network.hostConn');
}

export function hasRoomCapability(capability: RoomCapability): boolean {
  const context = getRoomContext();
  if (context.kind === 'pro') return context.capabilities.includes(capability);

  if (getState('network.appRole') === 'host' && !getState('network.hostConn')) {
    return STANDARD_HOST_CAPABILITIES.has(capability);
  }
  if (getState('network.isOperator')) return STANDARD_OPERATOR_CAPABILITIES.has(capability);
  return false;
}

export function isAuthoritativeConnection(conn: DataConnection | null | undefined): boolean {
  if (!conn) return false;
  if (!isCoordinator()) return getAuthorityConnection() === conn;

  const peerId = conn.peer;
  return !!peerId && getState('network.activeHostConnByPeerId').get(peerId) === conn;
}

export function verifyPeerCapability(
  conn: DataConnection | null | undefined,
  capability: RoomCapability,
): boolean {
  if (!conn?.peer || !isCoordinator()) return false;
  if (getState('network.activeHostConnByPeerId').get(conn.peer) !== conn) return false;

  const peer = getState('network.connectedPeers').find(
    (candidate) => candidate.id === conn.peer && candidate.conn === conn,
  );
  if (!peer) return false;

  if (getRoomContext().kind === 'pro') {
    return peer.roomCapabilities?.includes(capability) === true;
  }
  return peer.isOp && STANDARD_OPERATOR_CAPABILITIES.has(capability);
}

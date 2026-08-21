import { getState, setState } from '../core/state.ts';
import type { DataConnection, RoomCapability, RoomContext } from '../types/index.ts';

const STANDARD_HOST_CAPABILITIES = new Set<RoomCapability>([
  'media.add',
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'system-audio.publish',
  'members.manage',
  'chat.notice',
  'room.configure',
  'coordinator.eligible',
]);

const STANDARD_OPERATOR_CAPABILITIES = new Set<RoomCapability>([
  'media.add',
  'playback.control',
  'effects.control',
  'asset.upload',
]);

function createIdleRoomContext(): RoomContext {
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

/**
 * Whether this tab currently owns a live standard-room timeline.
 *
 * `appRole === 'host'` is assigned while the setup flow is still creating a
 * room code, so it is not sufficient by itself for playback-authority work.
 */
export function isActiveStandardRoomCoordinator(): boolean {
  const context = getRoomContext();
  return (
    context.kind === 'standard' &&
    getState('setup.sessionStarted') &&
    /^[1-9]\d{5}$/.test(getState('network.sessionCode')) &&
    isCoordinator()
  );
}

/**
 * Whether the standard-room transport currently projects the requested setup
 * side. This is a lifecycle query, not a grant of room authority.
 */
export function isStandardRoomRole(role: 'host' | 'guest'): boolean {
  const context = getRoomContext();
  if (context.kind !== 'standard') return false;
  return getState('network.appRole') === role;
}

/** Whether this tab is the participant side of a standard room. */
export function isStandardRoomMember(): boolean {
  return isStandardRoomRole('guest');
}

function getAuthorityConnection(): DataConnection | null {
  if (isCoordinator()) return null;
  return getState('network.hostConn');
}

export { getAuthorityConnection as getAuthorityConnectionForTests };

export function hasRoomCapability(capability: RoomCapability): boolean {
  const context = getRoomContext();
  if (context.kind === 'pro') return context.capabilities.includes(capability);

  if (getState('network.appRole') === 'host' && !getState('network.hostConn')) {
    return STANDARD_HOST_CAPABILITIES.has(capability);
  }
  const hostConn = getState('network.hostConn');
  if (
    getState('network.appRole') === 'guest' &&
    hostConn?.open === true &&
    getState('network.isOperator')
  ) {
    const explicitCapabilities = getState('network.standardRoomCapabilities');
    if (explicitCapabilities !== null) return explicitCapabilities.includes(capability);
    return STANDARD_OPERATOR_CAPABILITIES.has(capability);
  }
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
  if (!peer.isOp) return false;
  if (peer.roomCapabilities) return peer.roomCapabilities.includes(capability);
  return STANDARD_OPERATOR_CAPABILITIES.has(capability);
}

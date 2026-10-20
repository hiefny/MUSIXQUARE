import { getState, setState } from '../core/state.ts';
import { bus } from '../core/events.ts';
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

/**
 * Subscribe to changes that can move this browser across a room-authority
 * lifecycle boundary.
 *
 * Consumers deliberately receive only a signal: authority must be re-read
 * through this module after every notification. Keeping the legacy standard
 * room role/connection projection behind this seam prevents feature modules
 * from treating those transport fields as authority grants of their own.
 */
export function subscribeRoomAuthorityLifecycle(listener: () => void): () => void {
  const unsubscribe = [
    bus.on('state:room.context', listener),
    bus.on('state:network.appRole', listener),
    bus.on('state:network.hostConn', listener),
    bus.on('state:network.sessionCode', listener),
    bus.on('state:setup.sessionStarted', listener),
  ];

  return () => {
    for (const dispose of unsubscribe) dispose();
  };
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

/**
 * Host links whose grant or revoke projection has reached this guest.
 *
 * The host sends a silent OPERATOR_GRANT or OPERATOR_REVOKE as soon as a
 * joining link is established (and again whenever the projection changes), so
 * a plain guest also learns its role. WELCOME is not enough: it precedes a
 * returning administrator's grant. A reconnect replaces the DataConnection, so
 * the new link starts unconfirmed without any explicit reset.
 */
const confirmedStandardAuthorityConnections = new WeakSet<DataConnection>();

/** Record that the standard-room host has projected this guest's role on `conn`. */
export function markStandardRoomAuthorityConfirmed(conn: DataConnection): void {
  confirmedStandardAuthorityConnections.add(conn);
}

/**
 * Capabilities a standard-room host can ever project to a guest (the owner's
 * other verified device receives all of them). Physical transport roles
 * (system audio, coordinator) stay on the host's own tab, so a guest's answer
 * for them never depends on a pending grant.
 */
const STANDARD_GUEST_GRANTABLE_CAPABILITIES = new Set<RoomCapability>(
  [...STANDARD_HOST_CAPABILITIES].filter(
    (capability) => capability !== 'system-audio.publish' && capability !== 'coordinator.eligible',
  ),
);

/**
 * Whether this browser has a definitive answer for a capability.
 *
 * `pending` is feedback only: gating stays on `hasRoomCapability()`, which
 * already treats every unconfirmed state as not allowed.
 */
export function roomCapabilityStatus(capability: RoomCapability): 'granted' | 'denied' | 'pending' {
  if (hasRoomCapability(capability)) return 'granted';
  // PRO capabilities arrive inside the authenticated snapshot that creates the
  // PRO context, and the physical standard host owns its own answer.
  if (!isStandardRoomMember()) return 'denied';
  if (!STANDARD_GUEST_GRANTABLE_CAPABILITIES.has(capability)) return 'denied';

  const hostConn = getState('network.hostConn');
  if (hostConn?.open === true) {
    return confirmedStandardAuthorityConnections.has(hostConn) ? 'denied' : 'pending';
  }
  // Without a live host link the answer is unknown while joining or while an
  // active session waits to reconnect. Outside a session it is simply denied.
  return getState('network.isConnecting') || getState('setup.sessionStarted')
    ? 'pending'
    : 'denied';
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

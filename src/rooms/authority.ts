import { getState, setState } from '../core/state.ts';
import { bus } from '../core/events.ts';
import type { DataConnection, DeviceInfo, RoomCapability, RoomContext } from '../types/index.ts';

interface StandardAccountAuthorityCheck {
  roomCode: string;
  peerId: string;
  conn: DataConnection | null;
  memberId: string | null | undefined;
  definitiveClear: boolean;
  assertionSettled: boolean;
}

let standardAccountAuthorityCheck: StandardAccountAuthorityCheck | null = null;
const standardHostIdentityProjections = new WeakMap<DataConnection, string | null>();

function currentStandardAccountAuthorityCheck(): StandardAccountAuthorityCheck | null {
  const check = standardAccountAuthorityCheck;
  return check &&
    isStandardRoomMember() &&
    getState('network.myId') === check.peerId &&
    getState('network.lastJoinCode') === check.roomCode &&
    (!check.conn || getState('network.hostConn') === check.conn)
    ? check
    : null;
}

/** The account assertion owner reports work; this projection never starts retries. */
export function beginStandardRoomAccountAuthorityCheck(
  input: { roomCode: string; peerId: string; role: 'host' | 'guest' },
  changedAccount = false,
): StandardAccountAuthorityCheck | null {
  if (
    input.role !== 'guest' ||
    !isStandardRoomMember() ||
    getState('network.myId') !== input.peerId ||
    getState('network.lastJoinCode') !== input.roomCode
  )
    return null;
  // An ordinary lease renewal must not turn a confirmed member's denial into
  // a pending answer merely because its account is available.
  if (
    !changedAccount &&
    !currentStandardAccountAuthorityCheck() &&
    getState('network.myMemberAuthenticated')
  ) {
    return null;
  }
  const check = {
    roomCode: input.roomCode,
    peerId: input.peerId,
    conn: getState('network.hostConn'),
    memberId: undefined,
    definitiveClear: false,
    assertionSettled: false,
  };
  // A roster from before this check cannot confirm its later host answer,
  // even when the account comes back with the same room-scoped member ID.
  if (check.conn) standardHostIdentityProjections.delete(check.conn);
  standardAccountAuthorityCheck = check;
  bus.emit('network:role-badge-update');
  return check;
}

export function resetStandardRoomAccountAuthorityCheck(): void {
  standardAccountAuthorityCheck = null;
}

function finishMatchedStandardAccountAuthorityCheck(check: StandardAccountAuthorityCheck): void {
  const conn = getState('network.hostConn');
  if (
    currentStandardAccountAuthorityCheck() === check &&
    conn &&
    check.memberId !== undefined &&
    standardHostIdentityProjections.has(conn) &&
    standardHostIdentityProjections.get(conn) === check.memberId
  ) {
    standardAccountAuthorityCheck = null;
  }
}

export function settleStandardRoomAccountAuthorityCheck(
  check: StandardAccountAuthorityCheck | null,
  anonymous: boolean,
): void {
  if (!check || standardAccountAuthorityCheck !== check) return;
  check.assertionSettled = true;
  if (anonymous) {
    check.memberId = null;
    check.definitiveClear = true;
  }
  finishMatchedStandardAccountAuthorityCheck(check);
  bus.emit('network:role-badge-update');
}

/** A signaling identity is server verified; expiry remains eligible for retry. */
export function acceptStandardRoomAccountAuthorityIdentity(
  memberId: string | null,
  clearReason?: 'explicit' | 'expired' | 'deleted',
): void {
  const check = currentStandardAccountAuthorityCheck();
  if (!check) return;
  if (clearReason === 'expired') return;
  if (!check.assertionSettled && memberId !== null) return;
  check.memberId = memberId;
  check.definitiveClear =
    memberId === null && (clearReason === 'explicit' || clearReason === 'deleted');
  finishMatchedStandardAccountAuthorityCheck(check);
  bus.emit('network:role-badge-update');
}

/** The host sends this existing roster after its ordered grant/revoke frame. */
export function acceptStandardRoomHostIdentityProjection(
  conn: DataConnection,
  device: DeviceInfo,
): void {
  if (getState('network.hostConn') !== conn || device.id !== getState('network.myId')) return;
  standardHostIdentityProjections.set(
    conn,
    device.isAuthenticated === true ? (device.memberId ?? null) : null,
  );
  const check = currentStandardAccountAuthorityCheck();
  if (check) finishMatchedStandardAccountAuthorityCheck(check);
  bus.emit('network:role-badge-update');
}

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

// Account reconciliation owns when a PRO projection is unresolved. Tie its
// feedback to that exact projection so replacement/reset cannot retain it.
const pendingProAuthorityContexts = new WeakSet<Readonly<RoomContext>>();

export function setRoomContext(
  context: RoomContext,
  authorityStatus: 'confirmed' | 'pending' = 'confirmed',
): void {
  const pending = context.kind === 'pro' && authorityStatus === 'pending';
  const projection = {
    ...context,
    capabilities: pending ? [] : [...new Set(context.capabilities)],
  };
  if (pending) pendingProAuthorityContexts.add(projection);
  setState('room.context', projection);
}

export function resetRoomContext(): void {
  standardAccountAuthorityCheck = null;
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
  if (currentStandardAccountAuthorityCheck()) return false;

  if (getState('network.appRole') === 'host' && !getState('network.hostConn')) {
    return STANDARD_HOST_CAPABILITIES.has(capability);
  }
  const hostConn = getState('network.hostConn');
  if (
    getState('network.appRole') === 'guest' &&
    hostConn?.open === true &&
    getState('network.isOperator')
  ) {
    return getState('network.standardRoomCapabilities')?.includes(capability) === true;
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
  const context = getRoomContext();
  if (context.kind === 'pro') {
    return capability !== 'coordinator.eligible' && pendingProAuthorityContexts.has(context)
      ? 'pending'
      : 'denied';
  }
  // The physical standard host owns its own answer.
  if (!isStandardRoomMember()) return 'denied';
  if (!STANDARD_GUEST_GRANTABLE_CAPABILITIES.has(capability)) return 'denied';

  const accountCheck = currentStandardAccountAuthorityCheck();
  if (accountCheck) return accountCheck.definitiveClear ? 'denied' : 'pending';

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

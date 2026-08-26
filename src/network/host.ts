/**
 * MUSIXQUARE — Host-Side Peer Connection Logic
 *
 * Manages: incoming guest connections, welcome messages, device list,
 * operator toggle, kick, and the fixed room-capacity guard.
 *
 * Avoids importing from peer.ts; host-side helpers stay on peer-state.ts.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MAX_GUEST_SLOTS, MSG } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { normalizeDevicePlatform } from '../core/platform.ts';
import type {
  ConnectedPeer,
  DataConnection,
  DeviceInfo,
  RoomCapability,
  StandardRoomPermissionSet,
} from '../types/index.ts';
import type {
  StandardRoomIdentityClearReason,
  StandardRoomMemberIdentity,
} from './transport/types.ts';
import { broadcastSystemMessage, sendLatestPinnedNotice } from '../chat/protocol.ts';

import {
  detectConnectionType,
  getPeer,
  getPeerLabelBySlot,
  getAvailablePeerSlot,
  assignPeerSlot,
  releasePeerSlot,
  safeSend,
  broadcastDeviceList,
} from './peer-state.ts';
import { showToast } from '../ui/toast.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { capabilitiesForProRoomRole } from '../pro-room/contracts.ts';
import {
  STANDARD_ROOM_FULL_PERMISSIONS,
  STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES,
  getStandardRoomAdministratorByKey,
  grantStandardRoomAdministrator,
  revokeStandardRoomAdministratorByKey,
  standardRoomAuthorityKey,
  standardRoomCapabilities,
  updateStandardRoomAdministratorPermissions,
} from './standard-room-authority.ts';
import { detachHostPeerConnection } from './host-peer-departure.ts';
import {
  JOIN_BOOTSTRAP_TIMEOUT_MS,
  isJoinBootstrapPayloadFrame,
  snapshotJoinBootstrapApplied,
  snapshotJoinBootstrapHello,
} from './join-bootstrap.ts';

let _hostJoinBootstrapToken = 0;

function describeJoinBootstrapFrame(value: unknown): string {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return typeof value;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
    const type =
      descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : null;
    return typeof type === 'string' && type.length <= 80 ? type : 'unknown';
  } catch {
    return 'unreadable';
  }
}

function isStandardRoom(): boolean {
  return getRoomContext().kind === 'standard';
}

function connectionDevicePlatform(conn: DataConnection) {
  const metadata = conn.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'other' as const;
  return normalizeDevicePlatform((metadata as Record<string, unknown>).devicePlatform);
}

function permissionsForStandardPeer(peer: ConnectedPeer): StandardRoomPermissionSet | null {
  if (!isStandardRoom()) return null;
  return getStandardRoomAdministratorByKey(standardRoomAuthorityKey(peer))?.permissions ?? null;
}

function isVerifiedStandardRoomOwnerDevice(peer: ConnectedPeer): boolean {
  const ownerMemberId = localStandardHostAuthorityKey();
  return (
    ownerMemberId !== null &&
    peer.isAuthenticated === true &&
    typeof peer.memberId === 'string' &&
    peer.memberId === ownerMemberId
  );
}

function sameCapabilities(a: RoomCapability[] | undefined, b: RoomCapability[]): boolean {
  return !!a && a.length === b.length && a.every((value, index) => value === b[index]);
}

function lostStatefulStandardControl(previous: ConnectedPeer, projected: ConnectedPeer): boolean {
  const before = previous.roomCapabilities ?? [];
  const after = projected.roomCapabilities ?? [];
  return (
    (before.includes('effects.control') && !after.includes('effects.control')) ||
    (before.includes('room.configure') && !after.includes('room.configure'))
  );
}

function sendStandardAuthorityProjection(peer: ConnectedPeer, silent = false): void {
  const conn = peer.conn as DataConnection | null;
  if (!conn?.open || !isStandardRoom()) return;
  if (peer.isOp) {
    safeSend(conn, {
      type: MSG.OPERATOR_GRANT,
      capabilities: [...(peer.roomCapabilities ?? [])],
      ...(silent ? { silent: true } : {}),
    });
    return;
  }
  safeSend(conn, { type: MSG.OPERATOR_REVOKE, ...(silent ? { silent: true } : {}) });
}

function projectStandardPeerAuthority(peer: ConnectedPeer): ConnectedPeer {
  // The host browser remains the sole WebRTC coordinator. A second device is
  // promoted only at the product request layer, and only when signaling has
  // cryptographically projected the exact same room-scoped member ID as the
  // currently authenticated physical host.
  if (isVerifiedStandardRoomOwnerDevice(peer)) {
    return {
      ...peer,
      isOp: true,
      standardRoomPermissions: undefined,
      roomCapabilities: [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES],
    };
  }
  const permissions = permissionsForStandardPeer(peer);
  const roomCapabilities = permissions ? standardRoomCapabilities(permissions) : [];
  return {
    ...peer,
    isOp: permissions !== null,
    standardRoomPermissions: permissions ? { ...permissions } : undefined,
    roomCapabilities,
  };
}

function reprojectAllStandardPeerAuthority(): void {
  if (!isStandardRoom() || getState('network.hostConn')) return;
  const peers = getState('network.connectedPeers');
  let changed = false;
  const next = peers.map((peer) => {
    const projected = projectStandardPeerAuthority(peer);
    const capabilities = projected.roomCapabilities ?? [];
    if (projected.isOp === peer.isOp && sameCapabilities(peer.roomCapabilities, capabilities)) {
      return peer;
    }
    changed = true;
    sendStandardAuthorityProjection(projected, true);
    if ((peer.isOp && !projected.isOp) || lostStatefulStandardControl(peer, projected)) {
      resyncDemotedStandardPeer(projected);
    }
    return projected;
  });
  if (!changed) return;
  setState('network.connectedPeers', next);
  broadcastDeviceList();
  bus.emit('network:role-badge-update');
}

function resyncDemotedStandardPeer(peer: ConnectedPeer): void {
  const conn = peer.conn as DataConnection | null;
  if (!conn?.open) return;
  bus.emit('effects:resync-peer', conn);
  safeSend(conn, {
    type: MSG.REPEAT_MODE,
    value: getState('playlist.repeatMode') || 0,
    _bootstrap: true,
  });
  safeSend(conn, {
    type: MSG.SHUFFLE_MODE,
    value: !!getState('playlist.isShuffle'),
    _bootstrap: true,
  });
}

function reprojectStandardAuthorityForKey(key: string, silent = false): void {
  if (!isStandardRoom()) return;
  const peers = getState('network.connectedPeers');
  let changed = false;
  const next = peers.map((peer) => {
    if (standardRoomAuthorityKey(peer) !== key) return peer;
    const projected = projectStandardPeerAuthority(peer);
    const capabilities = projected.roomCapabilities ?? [];
    if (projected.isOp === peer.isOp && sameCapabilities(peer.roomCapabilities, capabilities)) {
      return peer;
    }
    changed = true;
    sendStandardAuthorityProjection(projected, silent);
    if ((peer.isOp && !projected.isOp) || lostStatefulStandardControl(peer, projected)) {
      resyncDemotedStandardPeer(projected);
    }
    return projected;
  });
  if (changed) setState('network.connectedPeers', next);
}

function normalizeConnectionIdentity(
  identity: StandardRoomMemberIdentity | null | undefined,
): StandardRoomMemberIdentity | null {
  if (
    !identity ||
    identity.isAuthenticated !== true ||
    typeof identity.memberId !== 'string' ||
    !identity.memberId ||
    !Number.isSafeInteger(identity.memberDisplayNumber) ||
    typeof identity.nickname !== 'string' ||
    !identity.nickname.trim()
  ) {
    return null;
  }
  return identity;
}

function findStandardPeerByAuthorityKey(key: string): ConnectedPeer | null {
  return (
    getState('network.connectedPeers').find((peer) => standardRoomAuthorityKey(peer) === key) ??
    null
  );
}

function localStandardHostAuthorityKey(): string | null {
  if (!isStandardRoom() || getState('network.appRole') !== 'host' || getState('network.hostConn')) {
    return null;
  }
  const memberId = getState('network.myMemberId')?.trim();
  if (getState('network.myMemberAuthenticated') && memberId) return memberId;
  const peerId = getState('network.myId');
  return peerId ? `peer:${peerId}` : null;
}

function isLocalStandardHostMember(key: string): boolean {
  return localStandardHostAuthorityKey() === key;
}

function isOnlyLiveStandardMemberDevice(
  peer: ConnectedPeer,
  peers: readonly ConnectedPeer[],
): boolean {
  if (!isStandardRoom()) return true;
  const key = standardRoomAuthorityKey(peer);
  if (isLocalStandardHostMember(key)) return false;
  return !peers.some(
    (candidate) =>
      candidate.conn !== peer.conn &&
      candidate.status === 'connected' &&
      standardRoomAuthorityKey(candidate) === key,
  );
}

function hasRemainingStandardMemberDevice(
  departedPeer: ConnectedPeer | undefined,
  peers: readonly ConnectedPeer[],
): boolean {
  if (!departedPeer || !isStandardRoom()) return false;
  const key = standardRoomAuthorityKey(departedPeer);
  if (isLocalStandardHostMember(key)) return true;
  return peers.some(
    (candidate) => candidate.status === 'connected' && standardRoomAuthorityKey(candidate) === key,
  );
}

function grantStandardRoomAuthority(key: string, permissions: StandardRoomPermissionSet): boolean {
  if (!isStandardRoom() || getState('network.hostConn')) return false;
  const target = findStandardPeerByAuthorityKey(key);
  if (!target) return false;
  grantStandardRoomAdministrator(target, permissions);
  reprojectStandardAuthorityForKey(key);
  broadcastDeviceList();
  return true;
}

function revokeStandardRoomAuthority(key: string): boolean {
  if (!isStandardRoom() || getState('network.hostConn')) return false;
  const existed = getStandardRoomAdministratorByKey(key) !== null;
  revokeStandardRoomAdministratorByKey(key);
  reprojectStandardAuthorityForKey(key);
  broadcastDeviceList();
  return existed;
}

function updateStandardRoomAuthority(key: string, permissions: StandardRoomPermissionSet): boolean {
  if (!isStandardRoom() || getState('network.hostConn')) return false;
  if (!updateStandardRoomAdministratorPermissions(key, permissions)) return false;
  // The member is still an administrator; this frame only refreshes the
  // capability projection and must not look like a fresh promotion.
  reprojectStandardAuthorityForKey(key, true);
  broadcastDeviceList();
  return true;
}

function kickStandardRoomAuthorityKey(key: string): number {
  if (!isStandardRoom() || getState('network.hostConn')) return 0;
  revokeStandardRoomAuthority(key);
  const targets = getState('network.connectedPeers').filter(
    (peer) => standardRoomAuthorityKey(peer) === key,
  );
  for (const target of targets) {
    const conn = target.conn as DataConnection | null;
    if (!conn?.open) continue;
    safeSend(conn, { type: MSG.KICK_DEVICE });
    setManagedTimer(
      'kick-close-' + target.id,
      () => {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      },
      300,
    );
  }
  return targets.length;
}

function updateStandardConnectionIdentity(
  conn: DataConnection,
  fallbackLabel: string,
  value: StandardRoomMemberIdentity | null,
  clearReason?: StandardRoomIdentityClearReason,
): void {
  if (!isStandardRoom() || getState('network.activeHostConnByPeerId').get(conn.peer) !== conn) {
    return;
  }
  const peers = getState('network.connectedPeers');
  const current = peers.find((peer) => peer.id === conn.peer && peer.conn === conn);
  if (!current) return;

  const identity = normalizeConnectionIdentity(value);
  const previousKey = standardRoomAuthorityKey(current);
  const nextBase: ConnectedPeer = identity
    ? {
        ...current,
        label: identity.nickname,
        memberId: identity.memberId,
        memberDisplayNumber: identity.memberDisplayNumber,
        isAuthenticated: true,
      }
    : {
        ...current,
        label: fallbackLabel,
        memberId: undefined,
        memberDisplayNumber: undefined,
        isAuthenticated: false,
      };
  const nextKey = standardRoomAuthorityKey(nextBase);

  if (clearReason === 'deleted' && current.isAuthenticated && current.memberId) {
    revokeStandardRoomAdministratorByKey(current.memberId);
  }

  // One-off anonymous authority belongs to a physical connection. Logging in
  // must not silently convert it into a persistent account grant.
  if (previousKey !== nextKey && !current.isAuthenticated) {
    revokeStandardRoomAdministratorByKey(previousKey);
  }

  const administrator = getStandardRoomAdministratorByKey(nextKey);
  if (identity && administrator) {
    grantStandardRoomAdministrator(nextBase, administrator.permissions);
  }

  const projected = projectStandardPeerAuthority(nextBase);
  setState(
    'network.connectedPeers',
    peers.map((peer) => (peer.id === conn.peer && peer.conn === conn ? projected : peer)),
  );
  setState('network.peerLabels', {
    ...getState('network.peerLabels'),
    [conn.peer]: projected.label,
  });
  // Sign-in/out, lease refresh/expiry, and account projection repair may
  // temporarily narrow authority, but they are not room-owner grant/revoke
  // actions. Keep the fail-closed state transition while suppressing the
  // misleading administrator-status toast on current clients.
  sendStandardAuthorityProjection(projected, true);
  if ((current.isOp && !projected.isOp) || lostStatefulStandardControl(current, projected)) {
    resyncDemotedStandardPeer(projected);
  }
  broadcastDeviceList();
  bus.emit('network:role-badge-update');
}

// ─── Host: Incoming Connection ──────────────────────────────────────

export function handleHostIncomingConnection(conn: DataConnection): void {
  const peerId = conn.peer;
  const isProRoom = getRoomContext().kind === 'pro';
  let connectionEstablished = false;
  let dataChannelOpened = false;
  let preOpenBootstrapHello: ReturnType<typeof snapshotJoinBootstrapHello> = null;
  let bootstrapId: string | null = null;
  let bootstrapPhase: 'awaiting-hello' | 'sending' | 'awaiting-applied' | 'settled' | 'failed' =
    isProRoom ? 'settled' : 'awaiting-hello';
  const bootstrapTimerName = `conn-bootstrap-timeout-${peerId}-${++_hostJoinBootstrapToken}`;
  let detectedConnectionType: 'local' | 'remote' | null = null;
  let connectionTypePublished = false;
  const connectedPeers = getState('network.connectedPeers');
  const activeHostConnByPeerId = getState('network.activeHostConnByPeerId');

  // Duplicate connection handling
  const existingActiveConn = activeHostConnByPeerId.get(peerId);
  const connectionReplaced = !!existingActiveConn && existingActiveConn !== conn;
  const replacedConnectionWasVisible =
    connectionReplaced &&
    connectedPeers.some(
      (peer) =>
        peer.id === peerId && peer.conn === existingActiveConn && peer.status === 'connected',
    );
  if (existingActiveConn && existingActiveConn !== conn) {
    // The old anonymous authority grant belongs to this exact connection and
    // must not leak into a replacement that happens to reuse the peer ID.
    // Preserve its presentation slot while the successor is admitted below.
    const detached = detachHostPeerConnection(peerId, existingActiveConn, {
      preserveLabel: true,
      preserveSlot: true,
    });
    if (!detached) {
      const updatedConns = new Map(getState('network.activeHostConnByPeerId'));
      if (updatedConns.get(peerId) === existingActiveConn) {
        updatedConns.delete(peerId);
        setState('network.activeHostConnByPeerId', updatedConns);
      }
    }
    try {
      if (existingActiveConn.open) {
        existingActiveConn.send({ type: MSG.FORCE_CLOSE_DUPLICATE });
      }
    } catch {
      /* noop */
    }
    try {
      existingActiveConn.close();
    } catch {
      /* noop */
    }
  }

  // Remove lingering peer object with same id
  const peersAfterReplacement = getState('network.connectedPeers');
  for (const lingering of peersAfterReplacement) {
    if (lingering.id !== peerId) continue;
    detachHostPeerConnection(peerId, lingering.conn as DataConnection | null | undefined, {
      preserveLabel: true,
      preserveSlot: true,
    });
  }
  const filtered = getState('network.connectedPeers').filter((p) => p.id !== peerId);
  setState('network.connectedPeers', filtered);
  if (connectionReplaced) {
    // Capability advertisements, frozen delivery routes, and in-flight media
    // belong to the exact authenticated DataConnection, not merely peerId.
    // This is intentionally distinct from a user-visible leave event.
    bus.emit('network:peer-connection-replaced', peerId);
  }

  // Enforce max guests
  if (filtered.length >= MAX_GUEST_SLOTS) {
    // Clean up activeHostConnByPeerId entry set during duplicate handling above
    const cleanupConns = new Map(getState('network.activeHostConnByPeerId'));
    cleanupConns.delete(peerId);
    setState('network.activeHostConnByPeerId', cleanupConns);

    // Release old peer's slot and label — the old conn's close handler
    // will return early (activeHostConnByPeerId guard), so we must clean up here.
    releasePeerSlot(peerId);
    const currentLabels = getState('network.peerLabels');
    if (currentLabels && currentLabels[peerId]) {
      const { [peerId]: _, ...restLabels } = currentLabels;
      setState('network.peerLabels', restLabels);
    }

    const sendFullAndClose = () => {
      try {
        conn.send({
          type: MSG.SESSION_FULL,
          // i18nKey translates at the receiver (guest locale); message stays
          // as the back-compat fallback for older SW-cached bundles.
          i18nKey: 'network.session_full_detail',
          message: t('network.session_full_detail'),
        });
      } catch {
        /* noop */
      }
      setManagedTimer(
        'conn-close-' + conn.peer,
        () => {
          try {
            conn.close();
          } catch {
            /* noop */
          }
        },
        500,
      );
    };
    if (conn.open) sendFullAndClose();
    else conn.on('open', sendFullAndClose);
    return;
  }

  // Allocate slot
  const peerSlotByPeerId = getState('network.peerSlotByPeerId');
  const preferredSlot = peerSlotByPeerId.get(peerId) || null;
  const slot = getAvailablePeerSlot(preferredSlot, peerId);
  if (!slot) {
    const sendFullAndClose = () => {
      try {
        conn.send({
          type: MSG.SESSION_FULL,
          i18nKey: 'network.session_full_detail',
          message: t('network.session_full_detail'),
        });
      } catch {
        /* noop */
      }
      try {
        conn.close();
      } catch {
        /* noop */
      }
    };
    if (conn.open) sendFullAndClose();
    else conn.on('open', sendFullAndClose);
    return;
  }
  assignPeerSlot(peerId, slot);
  const fallbackDeviceName = getPeerLabelBySlot(slot);
  const connectionIdentity = isProRoom ? null : normalizeConnectionIdentity(conn.roomIdentity);
  const deviceName = connectionIdentity?.nickname ?? fallbackDeviceName;

  // Publish a new map so state subscribers observe the label assignment.
  setState('network.peerLabels', { ...getState('network.peerLabels'), [peerId]: deviceName });

  const activeConns = new Map(getState('network.activeHostConnByPeerId'));
  activeConns.set(peerId, conn);
  setState('network.activeHostConnByPeerId', activeConns);

  const basePeerObj: ConnectedPeer = {
    id: peerId,
    slot,
    label: deviceName,
    status: 'connecting' as string,
    conn,
    isOp: isProRoom,
    isDataTarget: false,
    joinOrder: slot,
    lastHeartbeat: Date.now(),
    preloadedQueueItemIds: new Set(),
    connectionType: 'unknown',
    devicePlatform: connectionDevicePlatform(conn),
    ...(connectionIdentity
      ? {
          memberId: connectionIdentity.memberId,
          memberDisplayNumber: connectionIdentity.memberDisplayNumber,
          isAuthenticated: true,
        }
      : { isAuthenticated: false }),
    ...(isProRoom ? { roomCapabilities: [...capabilitiesForProRoomRole('controller')] } : {}),
  };
  const peerObj = isProRoom ? basePeerObj : projectStandardPeerAuthority(basePeerObj);

  // Re-check max guests before adding (guards against TOCTOU race with concurrent connections)
  const currentPeers = getState('network.connectedPeers');
  if (currentPeers.length >= MAX_GUEST_SLOTS) {
    log.warn(`[Host] Max guests reached during slot allocation for ${peerId}, rejecting`);
    releasePeerSlot(peerId);
    // Clean up activeHostConnByPeerId to prevent stale entry + spurious close handler
    const cleanupConns = new Map(getState('network.activeHostConnByPeerId'));
    cleanupConns.delete(peerId);
    setState('network.activeHostConnByPeerId', cleanupConns);
    // Also drop the peerLabels entry we set above. The conn.on('close')
    // handler short-circuits on `activeHostConnByPeerId.get(peerId) !== conn`
    // (we just deleted it), so without an explicit cleanup here the label
    // stays in state across many failed concurrent joins.
    const labelsAfterReject = getState('network.peerLabels');
    if (labelsAfterReject && peerId in labelsAfterReject) {
      const { [peerId]: _drop, ...restLabels } = labelsAfterReject;
      setState('network.peerLabels', restLabels);
    }
    const sendFullAndClose = () => {
      try {
        conn.send({
          type: MSG.SESSION_FULL,
          i18nKey: 'network.session_full_detail',
          message: t('network.session_full_detail'),
        });
      } catch {
        /* noop */
      }
      try {
        conn.close();
      } catch {
        /* noop */
      }
    };
    if (conn.open) sendFullAndClose();
    else conn.on('open', sendFullAndClose);
    return;
  }
  setState('network.connectedPeers', [...currentPeers, peerObj]);

  conn.on('identity', (identity, clearReason) => {
    updateStandardConnectionIdentity(conn, fallbackDeviceName, identity, clearReason);
  });

  const welcomeFrame = () => ({
    type: MSG.WELCOME as typeof MSG.WELCOME,
    lockChannel: false,
    label: deviceName,
    chatFrozen: getState('network.chatFrozen') || false,
    slowmodeSeconds: getState('network.slowmodeSeconds') || 0,
    filterEnabled: getState('network.filterEnabled') || false,
  });

  const publishDetectedConnectionType = (isInitial: boolean): void => {
    if (
      !connectionEstablished ||
      !detectedConnectionType ||
      !conn.open ||
      getState('network.activeHostConnByPeerId').get(peerId) !== conn
    ) {
      return;
    }
    if (isInitial && connectionTypePublished) return;
    broadcastDeviceList();
    bus.emit('orchestrator:peer-type-detected', peerId, isInitial);
    connectionTypePublished = true;
  };

  const completeConnection = (): void => {
    if (
      connectionEstablished ||
      (!isProRoom && bootstrapPhase !== 'settled') ||
      !conn.open ||
      getState('network.activeHostConnByPeerId').get(peerId) !== conn
    ) {
      return;
    }
    clearManagedTimer(bootstrapTimerName);
    connectionEstablished = true;

    const peers = getState('network.connectedPeers');
    setState(
      'network.connectedPeers',
      peers.map((peer) =>
        peer.id === peerId && peer.conn === conn
          ? { ...peer, status: 'connected', lastHeartbeat: Date.now() }
          : peer,
      ),
    );

    const connected = getState('network.connectedPeers').find(
      (peer) => peer.id === peerId && peer.conn === conn,
    );
    if (!isProRoom && connected) {
      // Identity projection may settle before RTC open. Re-send the complete
      // grant/revoke projection after the live connection boundary so the
      // guest can definitively discard any authority intent retained while
      // disconnected. WELCOME's initial non-operator value is not sufficient:
      // it also precedes a legitimate reconnecting administrator's grant.
      sendStandardAuthorityProjection(connected, true);
    }

    const openedLabel = connected?.label ?? deviceName;
    if (
      !replacedConnectionWasVisible &&
      (!connected || isOnlyLiveStandardMemberDevice(connected, getState('network.connectedPeers')))
    ) {
      broadcastSystemMessage('chat.peer_connected', { name: openedLabel });
    }
    sendLatestPinnedNotice(conn);
    bus.emit('network:peer-connected', conn);
    broadcastDeviceList();
    bus.emit('network:role-badge-update');
    publishDetectedConnectionType(true);
    log.info(`[Host] ${openedLabel} connection established (peer: ${peerId})`);
  };

  const failJoinBootstrap = (reason: string): void => {
    if (isProRoom || bootstrapPhase === 'settled' || bootstrapPhase === 'failed') return;
    bootstrapPhase = 'failed';
    clearManagedTimer(bootstrapTimerName);
    if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) return;
    log.warn(`[Host] Standard-room join bootstrap failed for ${deviceName}: ${reason}`);
    const departure = detachHostPeerConnection(peerId, conn);
    if (departure) broadcastDeviceList();
    try {
      conn.close();
    } catch {
      /* noop */
    }
  };

  const sendJoinBootstrap = (
    hello: NonNullable<ReturnType<typeof snapshotJoinBootstrapHello>>,
  ): void => {
    if (
      isProRoom ||
      bootstrapPhase !== 'awaiting-hello' ||
      !conn.open ||
      getState('network.activeHostConnByPeerId').get(peerId) !== conn
    ) {
      failJoinBootstrap('unexpected HELLO');
      return;
    }

    bootstrapPhase = 'sending';
    bootstrapId = hello.bootstrapId;
    let acknowledgements = 0;
    let sent = false;
    let bootstrapFrameIndex = 0;
    let invalidFrame = false;
    bus.emit(
      'network:peer-bootstrap',
      conn,
      (frame) => {
        if (!isJoinBootstrapPayloadFrame(frame, bootstrapFrameIndex)) {
          invalidFrame = true;
          return false;
        }
        const didSend =
          getState('network.activeHostConnByPeerId').get(peerId) === conn &&
          conn.open &&
          safeSend(conn, frame as Parameters<typeof safeSend>[1]);
        if (didSend) bootstrapFrameIndex += 1;
        return didSend;
      },
      (success) => {
        acknowledgements += 1;
        sent = success;
      },
    );

    if (
      acknowledgements !== 1 ||
      !sent ||
      invalidFrame ||
      bootstrapFrameIndex !== 3 ||
      !conn.open ||
      getState('network.activeHostConnByPeerId').get(peerId) !== conn
    ) {
      failJoinBootstrap('queue authority send was not acknowledged');
      return;
    }
    bootstrapPhase = 'awaiting-applied';
  };

  const handleJoinBootstrapData = (data: unknown): void => {
    const hello = snapshotJoinBootstrapHello(data);
    if (hello) {
      sendJoinBootstrap(hello);
      return;
    }

    const applied = snapshotJoinBootstrapApplied(data);
    if (
      applied &&
      bootstrapPhase === 'awaiting-applied' &&
      bootstrapId !== null &&
      applied.bootstrapId === bootstrapId &&
      getState('network.activeHostConnByPeerId').get(peerId) === conn
    ) {
      bootstrapPhase = 'settled';
      clearManagedTimer(bootstrapTimerName);
      completeConnection();
      return;
    }

    failJoinBootstrap(
      applied
        ? 'APPLIED did not match this connection'
        : `unexpected frame (${describeJoinBootstrapFrame(data)})`,
    );
  };

  // Timeout: clean up peer if WebRTC open never fires (ICE stall)
  const openTimerName = 'conn-open-timeout-' + peerId;
  setManagedTimer(
    openTimerName,
    () => {
      if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) return;
      const peers = getState('network.connectedPeers');
      const stale = peers.find(
        (p) => p.id === peerId && p.conn === conn && p.status === 'connecting',
      );
      if (!stale) return;
      log.warn(`[Host] Connection open timeout for ${deviceName}: cleaning up stale peer`);
      const departure = detachHostPeerConnection(peerId, conn);
      if (!departure) return;
      try {
        conn.close();
      } catch {
        /* noop */
      }
      broadcastDeviceList();
    },
    15000,
  );

  conn.on('open', () => {
    if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) {
      log.debug(`[Host] Ignored late open from replaced connection: ${peerId}`);
      try {
        conn.close();
      } catch {
        /* noop */
      }
      return;
    }
    dataChannelOpened = true;
    clearManagedTimer(openTimerName);
    if (!safeSend(conn, welcomeFrame())) {
      if (isProRoom) {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      } else {
        failJoinBootstrap('WELCOME send failed');
      }
      return;
    }

    if (isProRoom) {
      // PRO rooms have independent server authority and retain the existing
      // transport-open completion boundary.
      completeConnection();
    } else {
      setManagedTimer(
        bootstrapTimerName,
        () => {
          if (
            bootstrapPhase === 'settled' ||
            bootstrapPhase === 'failed' ||
            getState('network.activeHostConnByPeerId').get(peerId) !== conn
          ) {
            return;
          }
          failJoinBootstrap('timed out');
        },
        JOIN_BOOTSTRAP_TIMEOUT_MS,
      );
      const queuedHello = preOpenBootstrapHello;
      preOpenBootstrapHello = null;
      if (queuedHello) sendJoinBootstrap(queuedHello);
    }

    // Poll for up to 10 seconds while ICE stabilizes, then classify this guest
    // as local or remote.
    detectConnectionType(conn)
      .then((type) => {
        if (!conn.open || getState('network.activeHostConnByPeerId').get(peerId) !== conn) return;
        const peers = getState('network.connectedPeers');
        const livePeer = peers.find((p) => p.id === peerId && p.conn === conn);
        if (livePeer) {
          // Immutable update: replace peer object with detected connection type
          setState(
            'network.connectedPeers',
            peers.map((p) => (p.id === peerId ? { ...p, connectionType: type } : p)),
          );
        }
        detectedConnectionType = type;
        log.info(`[Host] ${deviceName} connection type: ${type}`);
        publishDetectedConnectionType(true);
        // Worst-case fallback: detectConnectionType returns 'remote' both for
        // genuine WAN peers and for LAN peers whose ICE never produced a
        // succeeded candidate-pair within the 10s polling window. Recheck once
        // after 30s to give late-stabilizing LAN ICE a chance to reclassify.
        // Only acts on a 'remote' → 'local' flip; never demotes 'local'.
        if (type === 'remote' && conn.open) {
          setManagedTimer(
            'ice-fallback-' + peerId,
            async () => {
              if (!conn.open || getState('network.activeHostConnByPeerId').get(peerId) !== conn)
                return;
              const recheck = await detectConnectionType(conn);
              if (!conn.open || getState('network.activeHostConnByPeerId').get(peerId) !== conn)
                return;
              if (recheck !== 'local') return;
              const ps = getState('network.connectedPeers');
              const p = ps.find((x) => x.id === peerId && x.conn === conn);
              if (p && p.connectionType !== 'local') {
                setState(
                  'network.connectedPeers',
                  ps.map((x) => (x.id === peerId ? { ...x, connectionType: 'local' as const } : x)),
                );
                detectedConnectionType = 'local';
                log.info(`[Host] ${deviceName} reclassified as local on fallback`);
                publishDetectedConnectionType(false);
              }
            },
            30000,
          );
        }
      })
      .catch((e) => {
        log.warn('[Host] ICE detection error:', e);
      });
  });

  conn.on('data', (data: unknown) => {
    try {
      if (!isProRoom && !dataChannelOpened) {
        const hello = snapshotJoinBootstrapHello(data);
        if (!hello || preOpenBootstrapHello || bootstrapPhase !== 'awaiting-hello') {
          preOpenBootstrapHello = null;
          failJoinBootstrap('invalid pre-open frame');
          return;
        }
        preOpenBootstrapHello = hello;
        return;
      }
      if (!isProRoom && !connectionEstablished) {
        handleJoinBootstrapData(data);
        return;
      }
      // A late duplicate handshake frame has no authority after the exact
      // connection has crossed the application boundary.
      if (!isProRoom && (snapshotJoinBootstrapHello(data) || snapshotJoinBootstrapApplied(data))) {
        return;
      }
      bus.emit('network:data', data, conn);
    } catch (e) {
      log.error('[Host] Error in handleData', e);
      if (!isProRoom && !connectionEstablished) failJoinBootstrap('handler threw');
    }
  });

  conn.on('close', () => {
    clearManagedTimer(bootstrapTimerName);
    log.info(`[Host] Connection closed: ${peerId}`);

    // Ignore stale close events from replaced duplicate connections
    if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) return;

    const departure = detachHostPeerConnection(peerId, conn);
    if (!departure) return;
    const { peer: departedPeer, remainingPeers, label: currentLabel } = departure;

    bus.emit('network:peer-disconnected', peerId);
    broadcastDeviceList();

    const sessionStarted = getState('setup.sessionStarted');
    if (sessionStarted && connectionEstablished) {
      showToast(t('toast.device_disconnected', { name: currentLabel }));
      if (!hasRemainingStandardMemberDevice(departedPeer, remainingPeers)) {
        broadcastSystemMessage('chat.peer_disconnected', {
          name: departedPeer.label ?? currentLabel,
        });
      }
    }
    log.info(`[Host] ${currentLabel} disconnected`);
  });

  conn.on('error', (err: unknown) => {
    clearManagedTimer(bootstrapTimerName);
    log.error('[Host] Connection error:', err);

    if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) {
      try {
        conn.close();
      } catch {
        /* noop */
      }
      return;
    }

    const departure = detachHostPeerConnection(peerId, conn);
    if (!departure) return;
    const { peer: departedPeer, remainingPeers, label: errLabel } = departure;

    bus.emit('network:peer-disconnected', peerId);
    broadcastDeviceList();

    const sessionStarted = getState('setup.sessionStarted');
    if (sessionStarted && connectionEstablished) {
      showToast(t('toast.device_conn_error', { name: errLabel }));
      if (!hasRemainingStandardMemberDevice(departedPeer, remainingPeers)) {
        broadcastSystemMessage('chat.peer_disconnected', {
          name: departedPeer.label ?? errLabel,
        });
      }
    }
    try {
      conn.close();
    } catch {
      /* noop */
    }
  });
}

// ─── Host Bus Event Handlers ────────────────────────────────────────

bus.on('network:grant-standard-room-administrator', ({ memberId, permissions }) => {
  if (!memberId) return;
  grantStandardRoomAuthority(memberId, permissions ?? { ...STANDARD_ROOM_FULL_PERMISSIONS });
});

bus.on('network:revoke-standard-room-administrator', ({ memberId }) => {
  if (!memberId) return;
  revokeStandardRoomAuthority(memberId);
});

bus.on('network:update-standard-room-administrator', ({ memberId, permissions }) => {
  if (!memberId) return;
  updateStandardRoomAuthority(memberId, permissions);
});

bus.on('network:standard-room-account-deleted', ({ memberId }) => {
  if (!memberId) return;
  revokeStandardRoomAuthority(memberId);
});

bus.on('network:request-kick-standard-room-member', ({ memberId }) => {
  if (!memberId || getState('network.hostConn')) return;
  kickStandardRoomAuthorityKey(memberId);
});

bus.on('network:request-kick-standard-room-device', ({ peerId }) => {
  if (!isStandardRoom() || !peerId || getState('network.hostConn')) return;
  bus.emit('network:kick-physical-device', peerId);
});

// Signing the physical host in/out changes which verified account, if any,
// owns person-level product authority. Reproject live siblings immediately;
// transport ownership, the host connection, and room teardown stay untouched.
bus.on('state:network.myMemberId', reprojectAllStandardPeerAuthority);
bus.on('state:network.myMemberAuthenticated', reprojectAllStandardPeerAuthority);

// Host: Toggle operator permission on a peer
bus.on('network:toggle-operator', (peerId) => {
  if (!peerId) return;

  // PRO authority is server-issued and represented by room capabilities.
  // Never let the legacy ADMIN event mutate that compatibility projection.
  if (getRoomContext().kind === 'pro') return;

  // Only Host can toggle operator
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  const connectedPeers = getState('network.connectedPeers');
  const target = connectedPeers.find((peer) => peer.id === peerId);
  if (target) {
    // Account-owner product authority is derived from the signed member
    // projection, never from the legacy ADMIN directory. A stale hidden
    // toggle must not claim to grant/revoke it or emit contradictory toasts.
    if (isVerifiedStandardRoomOwnerDevice(target)) return;
    const conn = target.conn as DataConnection;
    // Bail before mutating shared state if the channel is gone — otherwise the
    // target never receives OPERATOR_GRANT while every other peer's UI shows
    // them as OP, leaving badge state and command authorization out of sync.
    if (!conn || !conn.open) {
      log.warn(`[OP] Cannot toggle operator for ${peerId}: connection not open`);
      return;
    }
    const key = standardRoomAuthorityKey(target);
    const wasGranted = getStandardRoomAdministratorByKey(key) !== null || target.isOp;
    if (wasGranted) revokeStandardRoomAuthority(key);
    else grantStandardRoomAuthority(key, { ...STANDARD_ROOM_FULL_PERMISSIONS });
    // Revoke: re-baseline the demoted guest's effect state. Their optimistic
    // local applies (slider preview / apply-before-request) may have raced the
    // revoke and were silently dropped by verifyOperator with no NACK — the
    // snapshot resend converges them back to room state. Ordered channel
    // guarantees it lands after OPERATOR_REVOKE. (Bus event, not a direct
    // import: effects.ts → peer.ts → host.ts would cycle.)
    if (wasGranted) {
      bus.emit('effects:resync-peer', conn);
      // Same race class for the playlist toggles: an optimistic repeat/shuffle
      // REQUEST_SETTING dies silently in verifyOperator after the revoke, and
      // the effects snapshot doesn't cover these. _bootstrap marks them as a
      // re-baseline, not a change — the handlers skip the toggle toast.
      safeSend(conn, {
        type: MSG.REPEAT_MODE,
        value: getState('playlist.repeatMode') || 0,
        _bootstrap: true,
      });
      safeSend(conn, {
        type: MSG.SHUFFLE_MODE,
        value: !!getState('playlist.isShuffle'),
        _bootstrap: true,
      });
    }
    showToast(
      t('toast.op_status', {
        label: target.label,
        status: wasGranted ? t('common.revoked') : t('common.granted'),
      }),
    );
  }
});

// Host: Kick a connected peer from the session
bus.on('network:kick-device', (peerId) => {
  if (!peerId) return;

  // Only host can kick
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  const connectedPeers = getState('network.connectedPeers');
  const target = connectedPeers.find((x) => x.id === peerId);
  if (!target) return;

  const targets = isStandardRoom()
    ? connectedPeers.filter(
        (peer) => standardRoomAuthorityKey(peer) === standardRoomAuthorityKey(target),
      )
    : [target];
  if (isStandardRoom()) {
    revokeStandardRoomAdministratorByKey(standardRoomAuthorityKey(target));
  }
  for (const kickedPeer of targets) {
    const conn = kickedPeer.conn as DataConnection | null;
    if (!conn?.open) continue;
    safeSend(conn, { type: MSG.KICK_DEVICE });
    setManagedTimer(
      'kick-close-' + kickedPeer.id,
      () => {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      },
      300,
    );
  }

  log.info(`[Host] Kicked ${targets.length} device(s) for ${target.label || peerId}`);
  showToast(t('toast.device_kicked', { name: target.label || peerId }));
});

// Disconnect exactly one physical connection while preserving any account-
// level administrator grant carried by its sibling devices.
bus.on('network:kick-physical-device', (peerId) => {
  if (!isStandardRoom() || !peerId || getState('network.hostConn')) return;
  const target = getState('network.connectedPeers').find((peer) => peer.id === peerId);
  const conn = target?.conn as DataConnection | null | undefined;
  if (!target || target.status !== 'connected' || !conn?.open) return;

  safeSend(conn, { type: MSG.KICK_DEVICE });
  setManagedTimer(
    'kick-physical-close-' + target.id,
    () => {
      try {
        conn.close();
      } catch {
        /* noop */
      }
    },
    300,
  );
  log.info(`[Host] Disconnected physical device ${target.id} for ${target.label || peerId}`);
  showToast(t('toast.device_kicked', { name: target.label || peerId }));
});

bus.on('network:room-password-changed', (password: string | null) => {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  const peer = getPeer();
  try {
    peer?.setRoomPassword?.(password);
  } catch (error) {
    log.warn('[Host] Failed to update room password:', error);
  }
});

bus.on('network:device-list', (list) => {
  if (Array.isArray(list)) {
    setState('network.lastKnownDeviceList', list as DeviceInfo[]);
    bus.emit('network:device-list-update', list);
  }
});

/**
 * File-byte routing policy.
 *
 * Physical ICE location (`connectionType`) and file delivery are deliberately
 * separate. A capable local guest can use temporary R2 delivery when direct
 * fanout would exceed the host's bounded eight-peer budget, while legacy
 * clients retain scarce direct slots and every other feature keeps the real
 * physical topology.
 *
 * A decision is frozen per transfer session. Peers already receiving a direct
 * stream never change transport mid-file. A late capable overflow guest uses
 * R2; a legacy overflow guest is explicit unsupported instead of expanding
 * direct fanout. A reconnect is a new authenticated connection and advertises
 * capability again.
 */

import { getState } from '../core/state.ts';
import type { ConnectedPeer, DataConnection, QueueItemId } from '../types/index.ts';

const MAX_DIRECT_LOCAL_FILE_GUESTS = 8;

type FileDeliveryMode = 'direct-local' | 'mixed' | 'r2-fanout';
type FilePeerDelivery = 'direct-local' | 'r2' | 'pending' | 'unsupported';

interface FrozenFileDelivery {
  mode: FileDeliveryMode;
  directPeerIds: Set<string>;
  r2PeerIds: Set<string>;
  pendingPeerIds: Set<string>;
  unsupportedPeerIds: Set<string>;
}

const MAX_RETAINED_SESSIONS = 64;
const hostPolicies = new Map<string, FrozenFileDelivery>();
const localR2CapablePeerIds = new Set<string>();

interface GuestDelivery {
  queueItemId: QueueItemId;
  sessionId: number;
  mode: 'direct-local' | 'r2';
}

const guestDeliveryByQueueItem = new Map<QueueItemId, GuestDelivery>();

function validSessionId(sessionId: number): boolean {
  return Number.isSafeInteger(sessionId) && sessionId > 0;
}

function roomIdentity(): string {
  return getState('network.sessionCode') || getState('network.myId') || 'room';
}

function policyKey(sessionId: number): string {
  return `${roomIdentity()}:${sessionId}`;
}

function connectedLocalGuests(): ConnectedPeer[] {
  return (getState('network.connectedPeers') || []).filter(
    (peer) => peer.status === 'connected' && !!peer.conn?.open && peer.connectionType === 'local',
  );
}

function sortByJoinOrder(peers: ConnectedPeer[]): ConnectedPeer[] {
  return [...peers].sort(
    (left, right) =>
      (left.joinOrder || 0) - (right.joinOrder || 0) || left.id.localeCompare(right.id),
  );
}

function pruneHostPolicies(): void {
  const active = activeSessionIds();
  while (hostPolicies.size > MAX_RETAINED_SESSIONS) {
    let removable: string | null = null;
    for (const key of hostPolicies.keys()) {
      const separator = key.lastIndexOf(':');
      const sessionId = Number(key.slice(separator + 1));
      if (!active.has(sessionId)) {
        removable = key;
        break;
      }
    }
    // An active transfer/resident/preload route is more important than the
    // soft history bound. It will become eligible on a later prune once state
    // moves on, without ever being re-frozen mid-session.
    if (!removable) break;
    hostPolicies.delete(removable);
  }
}

/** Freeze the delivery decision at the start of a file/preload session. */
export function freezeFileDeliveryMode(sessionId: number): FileDeliveryMode {
  if (!validSessionId(sessionId)) return 'direct-local';
  const key = policyKey(sessionId);
  const existing = hostPolicies.get(key);
  if (existing) return existing.mode;

  const localPeers = sortByJoinOrder(connectedLocalGuests());
  const directPeerIds = new Set<string>();
  const r2PeerIds = new Set<string>();
  const pendingPeerIds = new Set<string>();
  const unsupportedPeerIds = new Set<string>();
  let mode: FileDeliveryMode = 'direct-local';

  if (localPeers.length <= MAX_DIRECT_LOCAL_FILE_GUESTS) {
    for (const peer of localPeers) directPeerIds.add(peer.id);
  } else if (localPeers.every((peer) => localR2CapablePeerIds.has(peer.id))) {
    mode = 'r2-fanout';
    for (const peer of localPeers) r2PeerIds.add(peer.id);
  } else {
    mode = 'mixed';
    // A current client can consume the explicit local-audience R2 marker.
    // Legacy/unadvertised local clients cannot, so reserve the bounded direct
    // slots for them first and never grow P2P fanout beyond eight.
    const legacyPeers = localPeers.filter((peer) => !localR2CapablePeerIds.has(peer.id));
    const capablePeers = localPeers.filter((peer) => localR2CapablePeerIds.has(peer.id));
    for (const peer of legacyPeers) {
      if (directPeerIds.size < MAX_DIRECT_LOCAL_FILE_GUESTS) directPeerIds.add(peer.id);
      else unsupportedPeerIds.add(peer.id);
    }
    for (const peer of capablePeers) r2PeerIds.add(peer.id);
  }

  hostPolicies.set(key, {
    mode,
    directPeerIds,
    r2PeerIds,
    pendingPeerIds,
    unsupportedPeerIds,
  });
  pruneHostPolicies();
  return mode;
}

function peerForConnection(conn: DataConnection): ConnectedPeer | undefined {
  // Delivery capability and frozen route ownership belong to the exact live
  // DataConnection. Matching only peerId would let a replaced/stale socket
  // inherit the successor connection's authority.
  return (getState('network.connectedPeers') || []).find((peer) => peer.conn === conn);
}

function activeSessionIds(): Set<number> {
  const sessionIds = new Set<number>();
  const currentSessionId = Number(getState('transfer.currentSessionId'));
  const residentSessionId = Number(getState('files.current')?.sessionId);
  const preloadSessionId = Number(getState('preload.activeTarget')?.sessionId);
  if (validSessionId(currentSessionId)) sessionIds.add(currentSessionId);
  if (validSessionId(residentSessionId)) sessionIds.add(residentSessionId);
  if (validSessionId(preloadSessionId)) sessionIds.add(preloadSessionId);
  return sessionIds;
}

function assignLateLocalPeer(policy: FrozenFileDelivery, peerId: string): FilePeerDelivery {
  policy.pendingPeerIds.delete(peerId);
  if (policy.directPeerIds.has(peerId)) return 'direct-local';
  if (policy.r2PeerIds.has(peerId)) return 'r2';
  if (policy.unsupportedPeerIds.has(peerId)) return 'unsupported';

  const capable = localR2CapablePeerIds.has(peerId);
  if (policy.mode === 'r2-fanout') {
    if (capable) {
      policy.r2PeerIds.add(peerId);
      return 'r2';
    }
    // The frozen all-R2 recipients stay untouched, but a later legacy client
    // may safely use one of the otherwise-empty bounded direct slots.
    if (policy.directPeerIds.size < MAX_DIRECT_LOCAL_FILE_GUESTS) {
      policy.directPeerIds.add(peerId);
      return 'direct-local';
    }
    policy.unsupportedPeerIds.add(peerId);
    return 'unsupported';
  }

  if (policy.mode === 'mixed') {
    // Once a transfer already uses R2, keep every capable newcomer on R2 and
    // reserve the scarce direct slots for clients which cannot understand the
    // local-audience descriptor. Otherwise an early capable newcomer could
    // consume a free direct slot and strand a later legacy participant.
    if (capable) {
      policy.r2PeerIds.add(peerId);
      return 'r2';
    }
    if (policy.directPeerIds.size < MAX_DIRECT_LOCAL_FILE_GUESTS) {
      policy.directPeerIds.add(peerId);
      return 'direct-local';
    }
    policy.unsupportedPeerIds.add(peerId);
    return 'unsupported';
  }

  // Existing direct recipients never switch mid-transfer. A late local peer
  // may take a remaining direct slot; the ninth and later require capability.
  if (policy.directPeerIds.size < MAX_DIRECT_LOCAL_FILE_GUESTS) {
    policy.directPeerIds.add(peerId);
    return 'direct-local';
  }
  if (capable) {
    policy.r2PeerIds.add(peerId);
    return 'r2';
  }
  policy.unsupportedPeerIds.add(peerId);
  return 'unsupported';
}

/** Resolve a late local participant without changing any existing recipient. */
export function markLateLocalPeerForR2(peerId: string): void {
  const peer = (getState('network.connectedPeers') || []).find((item) => item.id === peerId);
  if (!peer || peer.status !== 'connected' || !peer.conn?.open || peer.connectionType !== 'local') {
    return;
  }

  for (const sessionId of activeSessionIds()) {
    const policy = hostPolicies.get(policyKey(sessionId));
    if (policy) assignLateLocalPeer(policy, peerId);
  }
}

/**
 * Record support advertised over the exact authenticated guest connection.
 * A pending or unsupported local peer may recover to R2 mid-session; a direct
 * peer remains direct until the next frozen transfer.
 */
export function markLocalFileR2Capable(peerId: string): number[] {
  if (!peerId) return [];
  localR2CapablePeerIds.add(peerId);
  const peer = (getState('network.connectedPeers') || []).find((item) => item.id === peerId);
  // Capability says what the client understands, not where it is. Wait for
  // ICE before choosing local direct/R2 or the existing remote R2 route.
  if (peer?.connectionType !== 'local') return [];

  const recoveredSessionIds: number[] = [];
  for (const [key, policy] of hostPolicies) {
    let recoveredToR2 = false;
    if (policy.unsupportedPeerIds.delete(peerId)) {
      policy.r2PeerIds.add(peerId);
      recoveredToR2 = true;
    } else if (policy.pendingPeerIds.delete(peerId)) {
      recoveredToR2 = assignLateLocalPeer(policy, peerId) === 'r2';
    }
    if (!recoveredToR2) continue;
    const separator = key.lastIndexOf(':');
    const sessionId = Number(key.slice(separator + 1));
    if (validSessionId(sessionId)) recoveredSessionIds.push(sessionId);
  }
  return recoveredSessionIds;
}

/** A reconnect is a new authenticated DataConnection and must advertise again. */
export function releaseFileDeliveryPeer(peerId: string): void {
  if (!peerId) return;
  localR2CapablePeerIds.delete(peerId);
  for (const policy of hostPolicies.values()) {
    policy.directPeerIds.delete(peerId);
    policy.r2PeerIds.delete(peerId);
    policy.pendingPeerIds.delete(peerId);
    policy.unsupportedPeerIds.delete(peerId);
  }
}

export function isLocalFileR2CapableForTests(peerId: string): boolean {
  return localR2CapablePeerIds.has(peerId);
}

/** Remote guests use existing R2 support; local guests follow the frozen policy. */
export function resolvePeerFileDelivery(peer: ConnectedPeer, sessionId: number): FilePeerDelivery {
  if (!validSessionId(sessionId)) return 'unsupported';
  let policy = hostPolicies.get(policyKey(sessionId));
  if (!policy) {
    freezeFileDeliveryMode(sessionId);
    policy = hostPolicies.get(policyKey(sessionId));
  }
  if (!policy) return 'unsupported';

  // Existing assignment wins over a mutable ICE label. The same exact direct
  // DataConnection remains send-eligible after a relabel; the session never
  // silently switches delivery engines mid-file.
  if (policy.r2PeerIds.has(peer.id)) return 'r2';
  if (policy.directPeerIds.has(peer.id)) return 'direct-local';

  // Only an unassigned peer may derive its frozen route from current topology.
  if (peer.connectionType === 'remote') {
    policy.pendingPeerIds.delete(peer.id);
    policy.unsupportedPeerIds.delete(peer.id);
    policy.r2PeerIds.add(peer.id);
    return 'r2';
  }

  if (peer.connectionType !== 'local') {
    policy.pendingPeerIds.add(peer.id);
    return 'pending';
  }

  policy.pendingPeerIds.delete(peer.id);
  if (policy.unsupportedPeerIds.has(peer.id)) return 'unsupported';
  return assignLateLocalPeer(policy, peer.id);
}

function shouldPeerUseR2(peer: ConnectedPeer, sessionId: number): boolean {
  return resolvePeerFileDelivery(peer, sessionId) === 'r2';
}

export function shouldConnectionUseR2(conn: DataConnection, sessionId: number): boolean {
  const peer = peerForConnection(conn);
  return !!peer && shouldPeerUseR2(peer, sessionId);
}

export function shouldConnectionUseDirect(conn: DataConnection, sessionId: number): boolean {
  const peer = peerForConnection(conn);
  return !!peer && resolvePeerFileDelivery(peer, sessionId) === 'direct-local';
}

export function isConnectionFileDeliveryUnsupported(
  conn: DataConnection,
  sessionId: number,
): boolean {
  const peer = peerForConnection(conn);
  return !peer || resolvePeerFileDelivery(peer, sessionId) === 'unsupported';
}

export function isConnectionFileDeliveryPending(conn: DataConnection, sessionId: number): boolean {
  const peer = peerForConnection(conn);
  return !!peer && resolvePeerFileDelivery(peer, sessionId) === 'pending';
}

export function getR2FileTargets(sessionId: number): DataConnection[] {
  if (!validSessionId(sessionId)) return [];
  return (getState('network.connectedPeers') || [])
    .filter(
      (peer) =>
        peer.status === 'connected' &&
        !!peer.conn?.open &&
        resolvePeerFileDelivery(peer, sessionId) === 'r2',
    )
    .map((peer) => peer.conn as DataConnection);
}

export function getDirectFilePeers(sessionId: number): ConnectedPeer[] {
  if (!validSessionId(sessionId)) return [];
  return (getState('network.connectedPeers') || []).filter(
    (peer) =>
      peer.status === 'connected' &&
      !!peer.conn?.open &&
      resolvePeerFileDelivery(peer, sessionId) === 'direct-local',
  );
}

export function getUnsupportedFileTargetsForTests(sessionId: number): DataConnection[] {
  if (!validSessionId(sessionId)) return [];
  return (getState('network.connectedPeers') || [])
    .filter(
      (peer) =>
        peer.status === 'connected' &&
        !!peer.conn?.open &&
        resolvePeerFileDelivery(peer, sessionId) === 'unsupported',
    )
    .map((peer) => peer.conn as DataConnection);
}

/** Guest-side route ownership, learned only from the authenticated host. */
export function recordGuestFileDelivery(
  queueItemId: QueueItemId,
  sessionId: number,
  mode: GuestDelivery['mode'],
): void {
  if (!queueItemId || !validSessionId(sessionId)) return;
  const previous = guestDeliveryByQueueItem.get(queueItemId);
  if (previous && previous.sessionId > sessionId) return;
  guestDeliveryByQueueItem.set(queueItemId, { queueItemId, sessionId, mode });
}

export function isGuestR2FileDelivery(
  queueItemId: QueueItemId | null,
  sessionId?: number,
): boolean {
  if (!queueItemId) return false;
  const delivery = guestDeliveryByQueueItem.get(queueItemId);
  if (!delivery || delivery.mode !== 'r2') return false;
  return sessionId === undefined || !validSessionId(sessionId) || delivery.sessionId === sessionId;
}

export function resetFileDeliveryPolicies(): void {
  hostPolicies.clear();
  localR2CapablePeerIds.clear();
  guestDeliveryByQueueItem.clear();
}

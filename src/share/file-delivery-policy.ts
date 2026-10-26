/**
 * File-byte routing policy.
 *
 * Physical ICE location (`connectionType`) and file delivery are deliberately
 * separate. Local guests receive direct P2P bytes while a transfer fits the
 * host's bounded eight-peer budget; a room of nine or more local guests uses
 * temporary R2 delivery for all of them, and every other feature keeps the real
 * physical topology. Every supported guest reads local-audience R2 descriptors,
 * so the route depends on room size alone.
 *
 * A decision is frozen per transfer session. Peers already receiving a direct
 * stream never change transport mid-file. A late local guest takes a free
 * direct slot of a direct session and uses R2 otherwise. A reconnect is a new
 * authenticated connection and gets a fresh assignment.
 */

import { getState } from '../core/state.ts';
import type { ConnectedPeer, DataConnection, QueueItemId } from '../types/index.ts';

const MAX_DIRECT_LOCAL_FILE_GUESTS = 8;

type FileDeliveryMode = 'direct-local' | 'r2-fanout';
/** 'pending' waits for ICE; 'unsupported' answers only a request without a valid session. */
type FilePeerDelivery = 'direct-local' | 'r2' | 'pending' | 'unsupported';

interface FrozenFileDelivery {
  mode: FileDeliveryMode;
  directPeerIds: Set<string>;
  r2PeerIds: Set<string>;
}

const MAX_RETAINED_SESSIONS = 64;
const hostPolicies = new Map<string, FrozenFileDelivery>();

interface GuestDelivery {
  queueItemId: QueueItemId;
  sessionId: number;
  mode: 'direct-local' | 'r2';
  hostConn: DataConnection | null;
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

  const localPeerIds = new Set(connectedLocalGuests().map((peer) => peer.id));
  const mode: FileDeliveryMode =
    localPeerIds.size <= MAX_DIRECT_LOCAL_FILE_GUESTS ? 'direct-local' : 'r2-fanout';

  hostPolicies.set(key, {
    mode,
    directPeerIds: mode === 'direct-local' ? localPeerIds : new Set<string>(),
    r2PeerIds: mode === 'r2-fanout' ? localPeerIds : new Set<string>(),
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

function assignLateLocalPeer(policy: FrozenFileDelivery, peerId: string): 'direct-local' | 'r2' {
  if (policy.directPeerIds.has(peerId)) return 'direct-local';
  if (policy.r2PeerIds.has(peerId)) return 'r2';

  // Existing recipients never switch mid-transfer. A late local peer may take a
  // remaining direct slot of a direct session; an all-R2 session stays all R2.
  if (policy.mode === 'direct-local' && policy.directPeerIds.size < MAX_DIRECT_LOCAL_FILE_GUESTS) {
    policy.directPeerIds.add(peerId);
    return 'direct-local';
  }
  policy.r2PeerIds.add(peerId);
  return 'r2';
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

/** A reconnect is a new authenticated DataConnection and gets a fresh route. */
export function releaseFileDeliveryPeer(peerId: string): void {
  if (!peerId) return;
  for (const policy of hostPolicies.values()) {
    policy.directPeerIds.delete(peerId);
    policy.r2PeerIds.delete(peerId);
  }
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
    policy.r2PeerIds.add(peer.id);
    return 'r2';
  }
  // ICE has not classified this peer yet, so its byte route stays undecided.
  if (peer.connectionType !== 'local') return 'pending';
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

/** Fail closed for a connection that is not a connected peer or a session that is not valid. */
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

/** Guest-side route ownership, learned only from the authenticated host. */
export function recordGuestFileDelivery(
  queueItemId: QueueItemId,
  sessionId: number,
  mode: GuestDelivery['mode'],
): void {
  if (!queueItemId || !validSessionId(sessionId)) return;
  const previous = guestDeliveryByQueueItem.get(queueItemId);
  const hostConn = getState('network.hostConn');
  if (previous && previous.hostConn === hostConn && previous.sessionId > sessionId) return;
  guestDeliveryByQueueItem.set(queueItemId, {
    queueItemId,
    sessionId,
    mode,
    hostConn,
  });
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

/** Keep an admitted direct session stable if its ICE classification changes. */
export function isGuestDirectFileDelivery(
  queueItemId: QueueItemId | null,
  sessionId: number | undefined,
): boolean {
  if (!queueItemId || !validSessionId(sessionId ?? 0)) return false;
  const delivery = guestDeliveryByQueueItem.get(queueItemId);
  return (
    delivery?.mode === 'direct-local' &&
    delivery.sessionId === sessionId &&
    delivery.hostConn === getState('network.hostConn')
  );
}

export function resetFileDeliveryPolicies(): void {
  hostPolicies.clear();
  guestDeliveryByQueueItem.clear();
}

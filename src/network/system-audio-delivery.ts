import type { ConnectedPeer } from '../types/index.ts';

/**
 * A direct system-audio call reuses the participant's already-connected
 * RTCPeerConnection. Keep the legacy fanout ceiling as a final guard, while
 * preferring that warm path for every currently supported system-audio room
 * (the product limit is lower than this ceiling).
 */
const MAX_DIRECT_SYSTEM_AUDIO_GUESTS = 8;

type SystemAudioPeerDelivery = 'direct' | 'sfu' | 'pending';
type SystemAudioShareDelivery = 'hybrid' | 'all-sfu';
type GuestSystemAudioShareRoute = 'unselected' | 'sfu-remote' | 'sfu-all' | 'direct';

let shareActive = false;
let shareDelivery: SystemAudioShareDelivery = 'hybrid';
const directPeerIds = new Set<string>();
const sfuPeerIds = new Set<string>();
const sfuAudienceByPeerId = new Map<string, 'remote' | 'all'>();
const fallbackDirectPeerIds = new Set<string>();
const failedDirectPeerIds = new Set<string>();
let guestShareRoute: GuestSystemAudioShareRoute = 'unselected';
let guestRejectLateDirectRoute = false;

export function getGuestSystemAudioShareRoute(): GuestSystemAudioShareRoute {
  return guestShareRoute;
}

export function freezeGuestSystemAudioSfuRoute(
  audience: 'remote' | 'all',
  rejectLateDirectRoute = false,
): boolean {
  const requested: GuestSystemAudioShareRoute = audience === 'all' ? 'sfu-all' : 'sfu-remote';
  if (guestShareRoute === 'unselected') guestShareRoute = requested;
  const accepted = guestShareRoute === requested;
  if (accepted && rejectLateDirectRoute) guestRejectLateDirectRoute = true;
  return accepted;
}

/** False means an all-audience SFU route already won and direct must be closed. */
export function claimGuestDirectSystemAudioRoute(): boolean {
  if (guestShareRoute === 'sfu-all' || guestRejectLateDirectRoute) return false;
  guestShareRoute = 'direct';
  return true;
}

export function resetGuestSystemAudioShareRoute(): void {
  guestShareRoute = 'unselected';
  guestRejectLateDirectRoute = false;
}

function isConnected(peer: ConnectedPeer): boolean {
  return peer.status === 'connected' && !!peer.id && peer.conn?.open === true;
}

function getOccupiedDirectPeerIds(additionalDirectPeerIds: Iterable<string> = []): Set<string> {
  return new Set([...directPeerIds, ...fallbackDirectPeerIds, ...additionalDirectPeerIds]);
}

function hasDirectCapacity(): boolean {
  return getOccupiedDirectPeerIds().size < MAX_DIRECT_SYSTEM_AUDIO_GUESTS;
}

/**
 * Freeze the route at share start. Every LAN participant can consume an
 * all-audience SFU publication (every guest since 8.4.38 can; the host stopped
 * reading the guests' capability marker in Phase 5 5B-OV2, old-version survey
 * OV-B05, and guests stopped sending it in Phase 5.5 train 3, OV-F06), so 9+
 * LAN guests start entirely on the SFU and a smaller LAN room takes direct
 * slots in join order.
 */
export function beginSystemAudioShareDelivery(
  peers: readonly ConnectedPeer[],
): SystemAudioShareDelivery {
  if (shareActive) return shareDelivery;

  shareActive = true;
  directPeerIds.clear();
  sfuPeerIds.clear();
  sfuAudienceByPeerId.clear();
  fallbackDirectPeerIds.clear();
  failedDirectPeerIds.clear();

  const connected = peers.filter(isConnected);
  const localPeers = connected.filter((peer) => peer.connectionType === 'local');
  shareDelivery = localPeers.length > MAX_DIRECT_SYSTEM_AUDIO_GUESTS ? 'all-sfu' : 'hybrid';

  if (shareDelivery === 'all-sfu') {
    for (const peer of connected) {
      if (peer.connectionType === 'local' || peer.connectionType === 'remote') {
        sfuPeerIds.add(peer.id);
        sfuAudienceByPeerId.set(peer.id, peer.connectionType === 'local' ? 'all' : 'remote');
      }
    }
    return shareDelivery;
  }

  // A hybrid share has at most eight LAN participants, so each one takes a
  // direct slot, in join order, before remote participants fill the rest.
  const orderedLocalPeers = [...localPeers].sort(
    (left, right) => (left.joinOrder || 0) - (right.joinOrder || 0),
  );
  for (const peer of orderedLocalPeers) directPeerIds.add(peer.id);
  // The system-audio product limit currently allows fewer listeners than the
  // direct fanout ceiling. Remote and not-yet-classified peers already own a
  // live RTCPeerConnection (including TURN when needed), so adding the audio
  // track there avoids rebuilding a second five-request SFU control plane.
  // Keep SFU as the overflow/failure route for a future larger room.
  for (const peer of connected) {
    if (directPeerIds.has(peer.id)) continue;
    if (hasDirectCapacity()) {
      directPeerIds.add(peer.id);
      continue;
    }
    if (peer.connectionType === 'remote') {
      sfuPeerIds.add(peer.id);
      sfuAudienceByPeerId.set(peer.id, 'remote');
    }
  }
  return shareDelivery;
}

/**
 * Resolve exactly once per participant for the active share. A ninth late LAN
 * participant goes to SFU while the original eight direct calls stay intact.
 */
export function resolveSystemAudioPeerDelivery(
  peer: ConnectedPeer | undefined,
): SystemAudioPeerDelivery {
  if (!peer || !isConnected(peer)) return 'pending';
  if (!shareActive) return 'pending';
  if (fallbackDirectPeerIds.has(peer.id)) {
    // An SFU failure may freeze this participant onto one of the shared eight
    // direct slots. That override must win over the earlier SFU assignment so
    // retry publication and final STOP filtering see the same route as the
    // host media-call layer.
    return 'direct';
  }
  if (directPeerIds.has(peer.id)) {
    // Delivery is frozen for the active share. ICE labels can be corrected
    // later, but changing transport under a live audio graph risks duplicate
    // P2P+SFU playback and violates the stable-route contract.
    return 'direct';
  }
  if (sfuPeerIds.has(peer.id)) {
    // Same freeze in the opposite direction. A peer that already consumed an
    // SFU publication must not be switched to a live P2P graph mid-share.
    return 'sfu';
  }

  if (peer.connectionType !== 'local') {
    if (hasDirectCapacity()) {
      directPeerIds.add(peer.id);
      return 'direct';
    }
    if (peer.connectionType === 'remote') {
      sfuPeerIds.add(peer.id);
      sfuAudienceByPeerId.set(peer.id, 'remote');
      return 'sfu';
    }
    return 'pending';
  }

  // A late LAN participant of an all-SFU share joins the SFU audience; in a
  // hybrid share it takes a free direct slot and otherwise the SFU.
  if (shareDelivery === 'hybrid' && hasDirectCapacity()) {
    directPeerIds.add(peer.id);
    return 'direct';
  }
  sfuPeerIds.add(peer.id);
  sfuAudienceByPeerId.set(peer.id, 'all');
  return 'sfu';
}

/** Audience is part of the frozen share route, never a live ICE-label lookup. */
export function getFrozenSystemAudioSfuAudience(peerId: string): 'remote' | 'all' | null {
  return sfuAudienceByPeerId.get(peerId) ?? null;
}

export function releaseSystemAudioPeerDelivery(peerId: string): void {
  directPeerIds.delete(peerId);
  sfuPeerIds.delete(peerId);
  sfuAudienceByPeerId.delete(peerId);
  fallbackDirectPeerIds.delete(peerId);
  failedDirectPeerIds.delete(peerId);
}

export function isSystemAudioDirectFailurePeer(peerId: string): boolean {
  return failedDirectPeerIds.has(peerId);
}

/**
 * Move one failed warm direct call onto the existing SFU recovery plane.
 * The caller must then publish/send an authenticated SFU_READY handoff frame.
 */
export function promoteSystemAudioPeerDeliveryToSfu(peer: ConnectedPeer | undefined): boolean {
  if (!peer || !shareActive || !isConnected(peer)) return false;
  if (sfuPeerIds.has(peer.id)) {
    fallbackDirectPeerIds.delete(peer.id);
    failedDirectPeerIds.add(peer.id);
    return true;
  }

  const audience = peer.connectionType === 'local' ? 'all' : 'remote';
  directPeerIds.delete(peer.id);
  fallbackDirectPeerIds.delete(peer.id);
  failedDirectPeerIds.add(peer.id);
  sfuPeerIds.add(peer.id);
  sfuAudienceByPeerId.set(peer.id, audience);
  return true;
}

/** Reserve one of the same eight direct calls for an SFU failure fallback. */
export function reserveSystemAudioFallbackDirect(peerId: string): boolean {
  if (!peerId) return false;
  if (directPeerIds.has(peerId) || fallbackDirectPeerIds.has(peerId)) return true;
  if (!hasDirectCapacity()) return false;
  fallbackDirectPeerIds.add(peerId);
  return true;
}

export function getRemainingDirectSystemAudioCapacity(
  additionalDirectPeerIds: Iterable<string> = [],
): number {
  const occupied = getOccupiedDirectPeerIds(additionalDirectPeerIds).size;
  return Math.max(0, MAX_DIRECT_SYSTEM_AUDIO_GUESTS - occupied);
}

export function endSystemAudioShareDelivery(): void {
  shareActive = false;
  shareDelivery = 'hybrid';
  directPeerIds.clear();
  sfuPeerIds.clear();
  sfuAudienceByPeerId.clear();
  fallbackDirectPeerIds.clear();
  failedDirectPeerIds.clear();
}

export function getSystemAudioShareDeliverySnapshot() {
  return {
    active: shareActive,
    mode: shareDelivery,
    directPeerIds: [...directPeerIds],
    sfuPeerIds: [...sfuPeerIds],
    sfuAudiences: Object.fromEntries(sfuAudienceByPeerId),
    fallbackDirectPeerIds: [...fallbackDirectPeerIds],
  };
}

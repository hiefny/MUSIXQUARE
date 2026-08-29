import type { ConnectedPeer } from '../types/index.ts';

/**
 * A direct system-audio call reuses the participant's already-connected
 * RTCPeerConnection. Keep the legacy fanout ceiling as a final guard, while
 * preferring that warm path for every currently supported system-audio room
 * (the product limit is lower than this ceiling).
 */
const MAX_DIRECT_SYSTEM_AUDIO_GUESTS = 8;

type SystemAudioPeerDelivery = 'direct' | 'sfu' | 'pending' | 'unsupported';
type SystemAudioShareDelivery = 'hybrid' | 'all-sfu';
type GuestSystemAudioShareRoute = 'unselected' | 'sfu-remote' | 'sfu-all' | 'direct';

let shareActive = false;
let shareDelivery: SystemAudioShareDelivery = 'hybrid';
const directPeerIds = new Set<string>();
const sfuPeerIds = new Set<string>();
const sfuAudienceByPeerId = new Map<string, 'remote' | 'all'>();
const fallbackDirectPeerIds = new Set<string>();
const failedDirectPeerIds = new Set<string>();
const localSfuCapablePeerIds = new Set<string>();
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

/** New clients advertise that they can consume an SFU publication on LAN. */
export function markLocalSystemAudioSfuCapable(peerId: string): void {
  if (peerId) localSfuCapablePeerIds.add(peerId);
}

export function unmarkLocalSystemAudioSfuCapable(peerId: string): void {
  localSfuCapablePeerIds.delete(peerId);
}

/** Feature negotiation belongs to one transport generation, not a room code. */
export function resetLocalSystemAudioSfuCapabilities(): void {
  localSfuCapablePeerIds.clear();
}

function getOccupiedDirectPeerIds(additionalDirectPeerIds: Iterable<string> = []): Set<string> {
  return new Set([...directPeerIds, ...fallbackDirectPeerIds, ...additionalDirectPeerIds]);
}

function hasDirectCapacity(): boolean {
  return getOccupiedDirectPeerIds().size < MAX_DIRECT_SYSTEM_AUDIO_GUESTS;
}

/**
 * Freeze the route at share start. When every LAN participant understands the
 * local-audience SFU marker, 9+ LAN guests start entirely on the SFU. Mixed
 * versions stay bounded: legacy LAN clients get the scarce direct slots first
 * and only capable overflow clients enter the SFU.
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
  const canStartAllSfu =
    localPeers.length > MAX_DIRECT_SYSTEM_AUDIO_GUESTS &&
    localPeers.every((peer) => localSfuCapablePeerIds.has(peer.id));
  shareDelivery = canStartAllSfu ? 'all-sfu' : 'hybrid';

  if (shareDelivery === 'all-sfu') {
    for (const peer of connected) {
      if (peer.connectionType === 'local' || peer.connectionType === 'remote') {
        sfuPeerIds.add(peer.id);
        sfuAudienceByPeerId.set(peer.id, peer.connectionType === 'local' ? 'all' : 'remote');
      }
    }
    return shareDelivery;
  }

  // Legacy LAN clients cannot use an all-audience SFU publication. Give them
  // direct slots before current clients so a mixed-version room degrades
  // safely instead of silently pushing host fanout above the hard budget.
  const orderedLocalPeers = [...localPeers].sort((left, right) => {
    const capabilityOrder =
      Number(localSfuCapablePeerIds.has(left.id)) - Number(localSfuCapablePeerIds.has(right.id));
    if (capabilityOrder !== 0) return capabilityOrder;
    return (left.joinOrder || 0) - (right.joinOrder || 0);
  });
  for (const peer of orderedLocalPeers) {
    if (directPeerIds.size < MAX_DIRECT_SYSTEM_AUDIO_GUESTS) directPeerIds.add(peer.id);
    else if (localSfuCapablePeerIds.has(peer.id)) {
      sfuPeerIds.add(peer.id);
      sfuAudienceByPeerId.set(peer.id, 'all');
    }
  }
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

  if (shareDelivery === 'all-sfu') {
    if (!localSfuCapablePeerIds.has(peer.id)) {
      // Do not move any existing SFU participant when a legacy client joins
      // an all-SFU share. The otherwise-unused direct budget can safely serve
      // up to eight late legacy listeners while the frozen SFU routes remain.
      if (hasDirectCapacity()) {
        directPeerIds.add(peer.id);
        return 'direct';
      }
      return 'unsupported';
    }
    sfuPeerIds.add(peer.id);
    sfuAudienceByPeerId.set(peer.id, 'all');
    return 'sfu';
  }

  if (hasDirectCapacity()) {
    directPeerIds.add(peer.id);
    return 'direct';
  }
  if (!localSfuCapablePeerIds.has(peer.id)) return 'unsupported';
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
  if (audience === 'all' && !localSfuCapablePeerIds.has(peer.id)) return false;

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
    capablePeerIds: [...localSfuCapablePeerIds],
  };
}

/**
 * MUSIXQUARE — Relay Orchestrator (Host-side)
 *
 * Manages relay topology: evaluates each peer after ICE detection,
 * assigns local peers as relay nodes for remote peers,
 * and handles dynamic reassignment when peers join/leave.
 *
 * Topology strategy:
 *   - Local peers  → host sends data directly (isDataTarget = true)
 *   - Remote peers  → routed through a local relay peer (isDataTarget = false)
 *   - Remote peers without relay → NO file transfer (isDataTarget = false)
 *
 * TURN cost policy (Free tier):
 *   File/audio data NEVER flows through TURN. Remote peers only receive
 *   file data via a local relay peer on the same LAN as the host.
 *   If no local relay is available, remote peers stay connected for
 *   control messages (play/pause/chat/YouTube) but receive no file data.
 *   TODO(pro): Pro tier could allow host-direct TURN transfer as fallback
 *   by setting isDataTarget = true for relay-less remote peers.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { safeSend } from './peer.ts';
import { registerHandler } from './protocol.ts';
import type { DataConnection, ProtocolMsg } from '../types/index.ts';
import type { StateTree } from '../core/state.ts';

// ─── Types ──────────────────────────────────────────────────────────

type ConnectedPeer = StateTree['network']['connectedPeers'][number];

// ─── Module State ────────────────────────────────────────────────────

/** remotePeerId → relayPeerId */
const relayAssignments = new Map<string, string>();

/**
 * Minimum peer count (guests, host excluded) to enable the relay topology.
 * Below this, every peer — local or remote — gets data directly from host.
 *
 * Why: in a small room (≤3 guests) the whole relay machinery is more trouble
 * than it's worth. Host→direct to everyone stays well under the multicast
 * fanout limit, and skipping assignRelayForPeer side-steps an entire class
 * of mid-join races where ICE briefly misclassifies a LAN peer as remote,
 * a relay gets assigned, the downstream peer dials and starts receiving
 * forwarded chunks, and ~1s later the classification flips back to local —
 * too late to avoid a double-send from host (unicast) and the relay guest
 * (forwarded). Above the threshold the traditional relay topology kicks in,
 * with TURN-cost policy for true remote peers still enforced.
 */
const RELAY_ACTIVATION_MIN_PEERS = 4;

// ─── Exported Lookups ────────────────────────────────────────────────

/**
 * Check if `senderPeerId` is the assigned relay for `originPeerId`.
 * Used by protocol.ts to validate _originPeer claims and prevent spoofing.
 */
export function isAssignedRelay(originPeerId: string, senderPeerId: string): boolean {
  return relayAssignments.get(originPeerId) === senderPeerId;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function isHost(): boolean {
  return getState('network.appRole') === 'host' && !getState('network.hostConn');
}

function getConnectedPeers(): readonly ConnectedPeer[] {
  return getState('network.connectedPeers') || [];
}

/** Update isDataTarget on a connected peer (immutable update) */
function setPeerDataTarget(peerId: string, value: boolean): void {
  const peers = getConnectedPeers();
  const peer = peers.find((p) => p.id === peerId);
  if (!peer) return;
  if (peer.isDataTarget === value) return;
  const updatedPeers = peers.map((p) => (p.id === peerId ? { ...p, isDataTarget: value } : p));
  setState('network.connectedPeers', updatedPeers);
}

// ─── Core Logic ──────────────────────────────────────────────────────

/**
 * Called after ICE type detection resolves for a peer.
 * Decides whether the peer gets direct data or relay.
 *
 * `isInitial` distinguishes the first evaluation right after a peer joins
 * (ICE classification just resolved) from a re-evaluation triggered by
 * topology changes (another peer leaving, threshold crossing, etc.).
 * Only initial evaluations emit `orchestrator:peer-joined`, which is what
 * file/system-audio bootstrap consumers listen on. Re-evaluations still
 * emit `peer-evaluated` for routing-only updates.
 */
function evaluatePeer(peerId: string, isInitial: boolean = false): void {
  if (!isHost()) return;

  const peers = getConnectedPeers();
  const peer = peers.find((p) => p.id === peerId);
  if (!peer || peer.status !== 'connected') return;

  const connType = peer.connectionType;

  // Small-room bypass: below the activation threshold, every peer is a
  // direct data target. This drops the relay assignment (if any was queued
  // from an earlier ICE flap) so a briefly-remote-classified peer can't
  // keep a stale downstream open on some other guest.
  if (peers.length < RELAY_ACTIVATION_MIN_PEERS) {
    if (relayAssignments.has(peerId)) {
      removeRelayAssignment(peerId);
    }
    setPeerDataTarget(peerId, true);
    // peer-evaluated has no listener by design — see line 88-97 doc comment.
    // Reserved for routing-only re-eval observability; file/audio bootstrap
    // listens on peer-joined (initial only) to avoid re-bootstrapping peers.
    bus.emit('orchestrator:peer-evaluated', peerId);
    if (isInitial) bus.emit('orchestrator:peer-joined', peerId);
    return;
  }

  if (connType === 'local') {
    // Local peer: host-direct data target.
    setPeerDataTarget(peerId, true);

    // If this peer was previously assigned a relay (reclassified remote→local), remove it
    if (relayAssignments.has(peerId)) {
      removeRelayAssignment(peerId);
    }

    // peer-evaluated: routing-only re-eval observability (no current listener).
    bus.emit('orchestrator:peer-evaluated', peerId);
    if (isInitial) bus.emit('orchestrator:peer-joined', peerId);
  } else if (connType === 'remote') {
    // Hard TURN-cost policy: remote peers do NOT receive file data or
    // system-audio streams. Host-direct would bill TURN egress, and the
    // previously-considered "local guest as relay" path also rides TURN
    // on the local↔remote leg (the two guests are on different networks,
    // so ICE resolves via TURN). Both routes risk runaway Metered.ca
    // usage, so block them. Remote peers stay connected for control
    // messages (play/pause/chat/YouTube sync) and Demo-track HTTP fetch,
    // which are the only sanctioned TURN uses.
    if (relayAssignments.has(peerId)) {
      removeRelayAssignment(peerId);
    }
    setPeerDataTarget(peerId, false);

    // peer-evaluated: routing-only re-eval observability (no current listener).
    bus.emit('orchestrator:peer-evaluated', peerId);
    if (isInitial) bus.emit('orchestrator:peer-joined', peerId);
  }
  // 'unknown' → ignore, event will fire again when detection completes
}

/**
 * Remove relay assignment for a peer.
 * If the peer is local (reclassified remote→local), it becomes a direct target.
 * If the peer is still remote, it loses file data (TURN cost policy).
 */
function removeRelayAssignment(peerId: string): void {
  if (!relayAssignments.has(peerId)) return;

  relayAssignments.delete(peerId);

  const peers = getConnectedPeers();
  const peer = peers.find((p) => p.id === peerId);

  if (peer?.connectionType === 'local') {
    // Reclassified to local — can receive directly from host
    setPeerDataTarget(peerId, true);
  } else {
    // Still remote — no file data (TURN cost policy)
    // TODO(pro): Allow host-direct TURN fallback for Pro tier users.
    setPeerDataTarget(peerId, false);
  }

  // Tell the peer to disconnect from its current relay
  if (peer) {
    safeSend(peer.conn as DataConnection, {
      type: MSG.ASSIGN_DATA_SOURCE,
      targetId: null,
    });
  }

  log.info(`[Orchestrator] Removed relay assignment for ${peer?.label || peerId}`);
}

/**
 * Called when any peer disconnects. Handles:
 * 1. Cleaning up if the peer was a downstream (had a relay assigned)
 * 2. Reassigning all downstreams if the peer was a relay node
 */
function handlePeerDisconnect(peerId: string): void {
  if (!isHost()) return;

  // 1. Drop the disconnected peer's own relay assignment (if any — legacy-safe).
  relayAssignments.delete(peerId);

  // 2. Drop any stale assignments where the disconnected peer was used as a
  //    relay. Remote peers don't get re-assigned — they receive control-only
  //    under the TURN-cost policy, so there's no "find another relay" step.
  for (const [downstream, relay] of Array.from(relayAssignments.entries())) {
    if (relay === peerId) {
      relayAssignments.delete(downstream);
    }
  }

  // 3. Threshold crossing re-evaluation: when the disconnect pushes peers.length
  //    below RELAY_ACTIVATION_MIN_PEERS (e.g. 4→3 transition), any still-
  //    attached peer's isDataTarget needs to match the small-room policy.
  const remaining = getConnectedPeers();
  for (const p of remaining) {
    if (p.id !== peerId && p.status === 'connected') {
      evaluatePeer(p.id);
    }
  }
}

// ─── Initialize ──────────────────────────────────────────────────────

export function initOrchestrator(): void {
  bus.on('orchestrator:peer-type-detected', (peerId: string) => {
    evaluatePeer(peerId, true);
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    handlePeerDisconnect(peerId);
  });

  // RELAY_DOWNSTREAM_LOST cleanup — under the TURN-cost policy no new relay
  // assignments happen, but legacy relay connections from old sessions can
  // still fire this on close. Just drop the stale entry.
  registerHandler(MSG.RELAY_DOWNSTREAM_LOST, (data: ProtocolMsg<'relay-downstream-lost'>) => {
    if (!isHost()) return;
    const lostPeerId = data.lostPeerId;
    if (lostPeerId) relayAssignments.delete(lostPeerId);
  });

  // Clear assignments on session leave (sessionCode becomes '')
  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      relayAssignments.clear();
    }
  });

  // Clear assignments on re-host (new session start with same code)
  bus.on('state:setup.sessionStarted', (started: unknown) => {
    if (started) {
      relayAssignments.clear();
    }
  });

  log.info('[Orchestrator] Relay orchestrator initialized');
}

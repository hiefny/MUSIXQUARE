/**
 * MUSIXQUARE 3.0 — Relay Orchestrator (Host-side)
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
import type { DataConnection } from '../types/index.ts';
import type { StateTree } from '../core/state.ts';

// ─── Types ──────────────────────────────────────────────────────────

type ConnectedPeer = StateTree['network']['connectedPeers'][number];

// ─── Module State ────────────────────────────────────────────────────

/** remotePeerId → relayPeerId */
const relayAssignments = new Map<string, string>();

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
  return !getState('network.hostConn');
}

function getConnectedPeers(): readonly ConnectedPeer[] {
  return getState('network.connectedPeers') || [];
}

function getDownstreamCount(relayPeerId: string): number {
  let count = 0;
  for (const v of relayAssignments.values()) {
    if (v === relayPeerId) count++;
  }
  return count;
}

/** Update isDataTarget on a connected peer (immutable update) */
function setPeerDataTarget(peerId: string, value: boolean): void {
  const peers = getConnectedPeers();
  const peer = peers.find(p => p.id === peerId);
  if (!peer) return;
  if (peer.isDataTarget === value) return;
  const updatedPeers = peers.map(p =>
    p.id === peerId ? { ...p, isDataTarget: value } : p,
  );
  setState('network.connectedPeers', updatedPeers);
}

// ─── Core Logic ──────────────────────────────────────────────────────

/**
 * Called after ICE type detection resolves for a peer.
 * Decides whether the peer gets direct data or relay.
 */
function evaluatePeer(peerId: string): void {
  if (!isHost()) return;

  const peers = getConnectedPeers();
  const peer = peers.find(p => p.id === peerId);
  if (!peer || peer.status !== 'connected') return;

  const connType = peer.connectionType;

  if (connType === 'local') {
    // Local peer: ensure direct data target
    setPeerDataTarget(peerId, true);

    // If this peer was previously assigned a relay (reclassified remote→local), remove it
    if (relayAssignments.has(peerId)) {
      removeRelayAssignment(peerId);
    }

    // New local peer available: check if any orphaned remotes can now use it
    reassignOrphanedRemotes();
  } else if (connType === 'remote') {
    assignRelayForPeer(peerId);
  }
  // 'unknown' → ignore, event will fire again when detection completes
}

/**
 * Find the best local peer to relay for a remote peer.
 */
function assignRelayForPeer(remotePeerId: string): void {
  const peers = getConnectedPeers();
  const remotePeer = peers.find(p => p.id === remotePeerId);
  if (!remotePeer) return;

  // Find local relay candidates
  const candidates = peers.filter(p =>
    p.id !== remotePeerId &&
    p.connectionType === 'local' &&
    p.status === 'connected' &&
    p.conn && (p.conn as DataConnection).open,
  );

  if (candidates.length === 0) {
    // No local relay available → remote peer stays without file data.
    // TURN cost policy: file data NEVER flows through TURN (relay/TURN).
    // Remote peer can still receive control messages (play/pause/chat/YouTube).
    // TODO(pro): Allow host-direct TURN fallback for Pro tier users.
    setPeerDataTarget(remotePeerId, false);
    relayAssignments.delete(remotePeerId);
    log.info(`[Orchestrator] No local relay for ${remotePeer.label || remotePeerId} → no file data (TURN blocked)`);
    return;
  }

  // Sort by downstream count (ascending), then joinOrder (ascending = more stable)
  candidates.sort((a, b) => {
    const loadA = getDownstreamCount(a.id);
    const loadB = getDownstreamCount(b.id);
    if (loadA !== loadB) return loadA - loadB;
    return (a.joinOrder || 0) - (b.joinOrder || 0);
  });

  const relay = candidates[0];
  const relayId = relay.id;

  // Skip if already assigned to this relay
  if (relayAssignments.get(remotePeerId) === relayId) return;

  // Assign
  setPeerDataTarget(remotePeerId, false);
  relayAssignments.set(remotePeerId, relayId);

  // Send ASSIGN_DATA_SOURCE to the remote peer
  safeSend(remotePeer.conn as DataConnection, {
    type: MSG.ASSIGN_DATA_SOURCE,
    targetId: relayId,
  });

  log.info(`[Orchestrator] Assigned ${relay.label || relayId} as relay for ${remotePeer.label || remotePeerId} (load: ${getDownstreamCount(relayId)})`);
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
  const peer = peers.find(p => p.id === peerId);

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

  // 1. Clean up if disconnected peer was a downstream
  relayAssignments.delete(peerId);

  // 2. Find all peers that were using the disconnected peer as relay
  const orphaned: string[] = [];
  for (const [downstream, relay] of relayAssignments.entries()) {
    if (relay === peerId) {
      orphaned.push(downstream);
    }
  }

  if (orphaned.length > 0) {
    log.info(`[Orchestrator] Relay node ${peerId} disconnected, reassigning ${orphaned.length} downstream peer(s)`);
    for (const downstreamId of orphaned) {
      relayAssignments.delete(downstreamId);
      // Re-evaluate: find another local relay, or no file data if none available
      assignRelayForPeer(downstreamId);
    }
  }

  // 3. If a local peer left, some remotes on host-fallback might now have no relay options
  //    (This is a no-op if nothing changed, but ensures consistency)
  reassignOrphanedRemotes();
}

/**
 * Check for remote peers without relay assignments and try to assign them.
 * Called when the local peer pool changes (new local joins, or old local leaves).
 */
function reassignOrphanedRemotes(): void {
  const peers = getConnectedPeers();

  for (const p of peers) {
    if (
      p.connectionType === 'remote' &&
      p.status === 'connected' &&
      !relayAssignments.has(p.id)
    ) {
      assignRelayForPeer(p.id);
    }
  }
}

// ─── Initialize ──────────────────────────────────────────────────────

export function initOrchestrator(): void {
  bus.on('orchestrator:peer-type-detected', (peerId: string) => {
    evaluatePeer(peerId);
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    handlePeerDisconnect(peerId);
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

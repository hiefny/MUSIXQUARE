/**
 * MUSIXQUARE Peer Routing Orchestrator (Host-side)
 *
 * Evaluates each peer after ICE detection and decides whether the host may
 * send local file data directly.
 *
 * Routing policy:
 *   - Local peers receive file data directly from the host.
 *   - Remote peers stay connected for control/chat/YouTube and use the
 *     encrypted remote-share path for local files.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import type { StateTree } from '../core/state.ts';

type ConnectedPeer = StateTree['network']['connectedPeers'][number];

function isHost(): boolean {
  return getState('network.appRole') === 'host' && !getState('network.hostConn');
}

function getConnectedPeers(): readonly ConnectedPeer[] {
  return getState('network.connectedPeers') || [];
}

function setPeerDataTarget(peerId: string, value: boolean): void {
  const peers = getConnectedPeers();
  const peer = peers.find((p) => p.id === peerId);
  if (!peer || peer.isDataTarget === value) return;

  setState(
    'network.connectedPeers',
    peers.map((p) => (p.id === peerId ? { ...p, isDataTarget: value } : p)),
  );
}

function evaluatePeer(peerId: string, isInitial = false): void {
  if (!isHost()) return;

  const peer = getConnectedPeers().find((p) => p.id === peerId);
  if (!peer || peer.status !== 'connected') return;

  const connType = peer.connectionType;
  if (connType === 'unknown') return;

  const wasDataTarget = peer.isDataTarget === true;
  const shouldBeDataTarget = connType === 'local';
  setPeerDataTarget(peerId, shouldBeDataTarget);
  bus.emit('orchestrator:peer-evaluated', peerId);
  if (isInitial) bus.emit('orchestrator:peer-joined', peerId);
  if (!isInitial && shouldBeDataTarget && !wasDataTarget) {
    bus.emit('orchestrator:peer-data-target-ready', peerId);
  }
}

function handlePeerDisconnect(peerId: string): void {
  if (!isHost()) return;

  for (const peer of getConnectedPeers()) {
    if (peer.id !== peerId && peer.status === 'connected') {
      evaluatePeer(peer.id);
    }
  }
}

export function initOrchestrator(): void {
  bus.on('orchestrator:peer-type-detected', (peerId: string, isInitial = true) => {
    evaluatePeer(peerId, isInitial);
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    handlePeerDisconnect(peerId);
  });

  log.info('[Orchestrator] Peer routing orchestrator initialized');
}

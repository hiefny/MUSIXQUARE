/**
 * Browser-host network runtime orchestrator.
 *
 * Owns initialization of the room-control and transport-liveness subdomains,
 * then routes local/remote data-plane targets after ICE classification. Clock
 * synchronization remains isolated in sync.ts.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import type { StateTree } from '../core/state.ts';
import { initHeartbeatMonitor } from './heartbeat-monitor.ts';
import { initRoomControl } from './room-control.ts';

type ConnectedPeer = StateTree['network']['connectedPeers'][number];

function isHost(): boolean {
  return getState('network.appRole') === 'host' && !getState('network.hostConn');
}

function getConnectedPeers(): readonly ConnectedPeer[] {
  return getState('network.connectedPeers') || [];
}

function setPeerDataTarget(peerId: string, value: boolean): void {
  const peers = getConnectedPeers();
  const peer = peers.find((candidate) => candidate.id === peerId);
  if (!peer || peer.isDataTarget === value) return;

  setState(
    'network.connectedPeers',
    peers.map((candidate) =>
      candidate.id === peerId ? { ...candidate, isDataTarget: value } : candidate,
    ),
  );
}

function evaluatePeer(peerId: string, isInitial = false): void {
  if (!isHost()) return;

  const peer = getConnectedPeers().find((candidate) => candidate.id === peerId);
  if (!peer || peer.status !== 'connected') return;

  const connectionType = peer.connectionType;
  if (connectionType === 'unknown') return;

  const wasDataTarget = peer.isDataTarget === true;
  const shouldBeDataTarget = connectionType === 'local';
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
  initRoomControl();
  initHeartbeatMonitor();

  bus.on('orchestrator:peer-type-detected', (peerId: string, isInitial = true) => {
    evaluatePeer(peerId, isInitial);
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    handlePeerDisconnect(peerId);
  });

  log.info('[Orchestrator] Network runtime initialized');
}

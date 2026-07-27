import { getState, setState } from '../core/state.ts';
import { clearManagedTimer } from '../core/timers.ts';
import type { ConnectedPeer, DataConnection } from '../types/index.ts';
import { releasePeerSlot } from './peer-state.ts';
import { removeDepartedAnonymousAdministrator } from './standard-room-authority.ts';

interface HostPeerDeparture {
  peer: ConnectedPeer;
  remainingPeers: ConnectedPeer[];
  connection: DataConnection | null;
  label: string;
}

interface DetachHostPeerOptions {
  preserveLabel?: boolean;
  preserveSlot?: boolean;
}

/**
 * Detach one exact host-side connection from every connection-scoped store.
 *
 * Peer IDs can be reused by a replacement connection, so this helper refuses
 * to mutate state when the live connection map already points at a successor.
 * Account administrator grants intentionally outlive a device connection;
 * anonymous grants are connection-scoped and are revoked here.
 */
export function detachHostPeerConnection(
  peerId: string,
  expectedConnection: DataConnection | null | undefined,
  options: DetachHostPeerOptions = {},
): HostPeerDeparture | null {
  const peers = getState('network.connectedPeers');
  const departedPeer = peers.find(
    (peer) => peer.id === peerId && (peer.conn ?? null) === (expectedConnection ?? null),
  );
  if (!departedPeer) return null;

  const activeConnections = getState('network.activeHostConnByPeerId');
  const activeConnection = activeConnections.get(peerId);
  if (activeConnection && activeConnection !== expectedConnection) return null;

  const remainingPeers = peers.filter((peer) => peer !== departedPeer);
  const hasSameIdSuccessor = remainingPeers.some((peer) => peer.id === peerId);

  if (activeConnection === expectedConnection) {
    const nextConnections = new Map(activeConnections);
    nextConnections.delete(peerId);
    setState('network.activeHostConnByPeerId', nextConnections);
  }

  // Fence the connection out of the canonical peer list before callers close
  // the transport. Chromium may synchronously emit close/error from close().
  setState('network.connectedPeers', remainingPeers);
  removeDepartedAnonymousAdministrator(departedPeer);

  if (!options.preserveSlot && !hasSameIdSuccessor) {
    releasePeerSlot(peerId);
  }

  const labels = getState('network.peerLabels');
  const label = labels?.[peerId] || departedPeer.label;
  if (!options.preserveLabel && !hasSameIdSuccessor && labels && peerId in labels) {
    const { [peerId]: _departed, ...remainingLabels } = labels;
    setState('network.peerLabels', remainingLabels);
  }

  clearManagedTimer('conn-open-timeout-' + peerId);
  clearManagedTimer('ice-fallback-' + peerId);

  return {
    peer: departedPeer,
    remainingPeers,
    connection: (departedPeer.conn as DataConnection | null | undefined) ?? null,
    label,
  };
}

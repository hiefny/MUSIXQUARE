/**
 * MUSIXQUARE — Host Heartbeat Monitor
 *
 * Owns transport-liveness observations and stale browser-host peer cleanup.
 * Synchronization code records heartbeat frames through this narrow port but
 * does not own participant lifecycle or RTC cleanup.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import type { ConnectedPeer, DataConnection } from '../types/index.ts';
import { broadcastDeviceList } from './peer.ts';
import { detachHostPeerConnection } from './host-peer-departure.ts';

const HEARTBEAT_STALE_THRESHOLD = 8_000;
const HEARTBEAT_CHECK_INTERVAL = 5_000;
// Browser/worker timers may be suspended while a mobile guest is backgrounded.
// A still-open RTC transport is stronger liveness evidence than the absence of
// an application heartbeat, so retain it through a bounded background grace.
// Truly dead/unknown transports keep the short stale threshold so abandoned
// slots cannot consume room capacity indefinitely.
const HEARTBEAT_LIVE_TRANSPORT_GRACE = 90_000;
const HEARTBEAT_RECOVERING_TRANSPORT_GRACE = 30_000;

// Keep the one-ping-per-peer hot path off the immutable state tree. Keying by
// the live connection also prevents a reconnect that reuses a peer id from
// inheriting the previous connection's lease.
const lastHeartbeatByConnection = new WeakMap<DataConnection, number>();

export function recordPeerHeartbeat(conn: DataConnection, now = Date.now()): void {
  try {
    if (!conn?.peer) return;
    const connected = getState('network.connectedPeers').some(
      (peer) => peer.id === conn.peer && peer.conn === conn && peer.status === 'connected',
    );
    if (connected) lastHeartbeatByConnection.set(conn, now);
  } catch (error) {
    log.debug('[Heartbeat] Liveness update error:', error);
  }
}

export function heartbeatTransportGrace(conn: DataConnection | undefined): number {
  if (!conn?.open) return HEARTBEAT_STALE_THRESHOLD;

  const pcState = conn.peerConnection?.connectionState;
  const dataState = conn.dataChannel?.readyState;
  const controlState = conn.controlChannel?.readyState;
  if (
    pcState === 'closed' ||
    pcState === 'failed' ||
    dataState === 'closed' ||
    controlState === 'closed'
  ) {
    return HEARTBEAT_STALE_THRESHOLD;
  }

  if (
    pcState === 'connected' &&
    (dataState === undefined || dataState === 'open') &&
    (controlState === undefined || controlState === 'open')
  ) {
    return HEARTBEAT_LIVE_TRANSPORT_GRACE;
  }

  if (pcState === 'disconnected' || pcState === 'connecting' || pcState === 'new') {
    return HEARTBEAT_RECOVERING_TRANSPORT_GRACE;
  }

  return HEARTBEAT_STALE_THRESHOLD;
}

function startHeartbeatMonitor(): void {
  stopHeartbeatMonitor();
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only the browser-host coordinator monitors peers.

  setManagedTimer(
    'heartbeat-monitor',
    () => {
      const currentHostConn = getState('network.hostConn');
      if (currentHostConn) {
        stopHeartbeatMonitor();
        return;
      }

      const now = Date.now();
      const connectedPeers = getState('network.connectedPeers');
      const stalePeers: ConnectedPeer[] = [];

      for (const peer of connectedPeers) {
        if (peer.status !== 'connected') continue;
        const conn = peer.conn as DataConnection | undefined;
        const lastHeartbeat =
          (conn ? lastHeartbeatByConnection.get(conn) : undefined) ??
          ((peer.lastHeartbeat as number) || 0);
        const elapsed = now - lastHeartbeat;
        const staleThreshold = heartbeatTransportGrace(conn);
        if (elapsed > staleThreshold) {
          log.warn(
            `[Heartbeat] Peer ${peer.label || peer.id} stale (${(elapsed / 1000).toFixed(1)}s; transport=${conn?.peerConnection?.connectionState ?? 'unknown'}) — marking disconnected`,
          );
          stalePeers.push(peer);
        }
      }

      if (stalePeers.length === 0) return;

      const departures = stalePeers
        .map((peer) =>
          detachHostPeerConnection(peer.id, peer.conn as DataConnection | null | undefined),
        )
        .filter((departure) => departure !== null);

      // Fence stale connections out of host state before physically closing
      // them. Some Chromium builds emit a synchronous RTCDataChannel error
      // from close(); host.ts must see that connection as stale and ignore it.
      for (const departure of departures) {
        try {
          departure.connection?.close();
        } catch {
          /* noop */
        }
      }

      for (const departure of departures) {
        bus.emit('network:peer-disconnected', departure.peer.id);
      }
      if (departures.length > 0) broadcastDeviceList();
    },
    HEARTBEAT_CHECK_INTERVAL,
    { interval: true },
  );

  log.info('[Heartbeat] Monitor started');
}

function stopHeartbeatMonitor(): void {
  clearManagedTimer('heartbeat-monitor');
}

export function initHeartbeatMonitor(): void {
  bus.on('state:setup.sessionStarted', (started) => {
    if (started) startHeartbeatMonitor();
    else stopHeartbeatMonitor();
  });

  log.info('[Heartbeat] Lifecycle handlers registered');
}

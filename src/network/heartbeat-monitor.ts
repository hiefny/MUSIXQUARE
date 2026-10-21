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
import { clearManagedTimer, getManagedTimer, setManagedTimer } from '../core/timers.ts';
import type { ConnectedPeer, DataConnection } from '../types/index.ts';
import { broadcastDeviceList } from './peer-state.ts';
import { detachHostPeerConnection } from './host-peer-departure.ts';

const HEARTBEAT_STALE_THRESHOLD = 8_000;
const HEARTBEAT_CHECK_INTERVAL = 5_000;
const HEARTBEAT_LIVE_TRANSPORT_GRACE = 90_000;
const HEARTBEAT_RECOVERING_TRANSPORT_GRACE = 30_000;
const HEARTBEAT_MONITOR_TIMER = 'heartbeat-monitor';

// Keying by the live connection prevents a reconnect that reuses a peer id
// from inheriting the previous connection's heartbeat lease.
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

function heartbeatTransportGrace(conn: DataConnection | undefined): number {
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

/**
 * Only a Standard host with a connected guest has peer liveness to watch.
 * PRO rooms are server-authoritative and keep their peer list empty.
 */
function heartbeatMonitorNeeded(): boolean {
  return (
    getState('setup.sessionStarted') &&
    !getState('network.hostConn') &&
    getState('room.context').kind !== 'pro' &&
    getState('network.connectedPeers').some((peer) => peer.status === 'connected')
  );
}

/** Re-armed on every relevant state edge, e.g. when the first guest connects. */
function syncHeartbeatMonitor(): void {
  if (!heartbeatMonitorNeeded()) {
    clearManagedTimer(HEARTBEAT_MONITOR_TIMER);
    return;
  }
  // Ping replies republish the peer list; keep the running cadence.
  if (getManagedTimer(HEARTBEAT_MONITOR_TIMER)) return;

  setManagedTimer(
    HEARTBEAT_MONITOR_TIMER,
    () => {
      if (!heartbeatMonitorNeeded()) {
        clearManagedTimer(HEARTBEAT_MONITOR_TIMER);
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
        const recoveryRemaining = (conn?.iceRecoveryDeadline ?? 0) - now;
        if (
          conn?.open &&
          recoveryRemaining > 0 &&
          recoveryRemaining <= 15_000 &&
          conn.dataChannel?.readyState === 'open' &&
          conn.controlChannel?.readyState === 'open'
        ) {
          // The transport owns one bounded ICE restart. A stale heartbeat
          // must not consume its grace early merely because ICE says failed.
          continue;
        }
        const staleThreshold = heartbeatTransportGrace(conn);
        if (elapsed > staleThreshold) {
          log.warn(
            `[Heartbeat] Peer ${peer.label || peer.id} stale (${(elapsed / 1_000).toFixed(1)}s; transport=${conn?.peerConnection?.connectionState ?? 'unknown'}): marking disconnected`,
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

export function initHeartbeatMonitor(): void {
  bus.on('state:setup.sessionStarted', syncHeartbeatMonitor);
  bus.on('state:network.hostConn', syncHeartbeatMonitor);
  bus.on('state:room.context', syncHeartbeatMonitor);
  bus.on('state:network.connectedPeers', syncHeartbeatMonitor);

  // initSync may run after setup state was already projected in tests, hot
  // recovery, or a retained page. Reconcile the current snapshot as well as
  // future state events.
  syncHeartbeatMonitor();

  log.info('[Heartbeat] Lifecycle handlers registered');
}

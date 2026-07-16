/**
 * MUSIXQUARE — Host-Side Peer Connection Logic
 *
 * Manages: incoming guest connections, welcome messages, device list,
 * operator toggle, kick, and the fixed room-capacity guard.
 *
 * Avoids importing from peer.ts; host-side helpers stay on peer-state.ts.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MAX_GUEST_SLOTS, MSG } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import type { ConnectedPeer, DataConnection, DeviceInfo } from '../types/index.ts';
import { broadcastSystemMessage, sendLatestPinnedNotice } from '../chat/protocol.ts';

import {
  detectConnectionType,
  getPeer,
  getPeerLabelBySlot,
  getAvailablePeerSlot,
  assignPeerSlot,
  releasePeerSlot,
  safeSend,
  broadcastDeviceList,
} from './peer-state.ts';
import { showToast } from '../ui/toast.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { capabilitiesForProRoomRole } from '../pro-room/contracts.ts';

// ─── Host: Incoming Connection ──────────────────────────────────────

export function handleHostIncomingConnection(conn: DataConnection): void {
  const peerId = conn.peer;
  const isProRoom = getRoomContext().kind === 'pro';
  const connectedPeers = getState('network.connectedPeers');
  const activeHostConnByPeerId = getState('network.activeHostConnByPeerId');

  // Duplicate connection handling
  const existingActiveConn = activeHostConnByPeerId.get(peerId);
  const connectionReplaced = !!existingActiveConn && existingActiveConn !== conn;
  if (existingActiveConn && existingActiveConn !== conn) {
    const updatedConns = new Map(activeHostConnByPeerId);
    updatedConns.set(peerId, conn);
    setState('network.activeHostConnByPeerId', updatedConns);
    try {
      if (existingActiveConn.open) {
        existingActiveConn.send({ type: MSG.FORCE_CLOSE_DUPLICATE });
      }
    } catch {
      /* noop */
    }
    try {
      existingActiveConn.close();
    } catch {
      /* noop */
    }
  }

  // Remove lingering peer object with same id
  const filtered = connectedPeers.filter((p) => p.id !== peerId);
  setState('network.connectedPeers', filtered);
  if (connectionReplaced) {
    // Capability advertisements, frozen delivery routes, and in-flight media
    // belong to the exact authenticated DataConnection, not merely peerId.
    // This is intentionally distinct from a user-visible leave event.
    bus.emit('network:peer-connection-replaced', peerId);
  }

  // Enforce max guests
  if (filtered.length >= MAX_GUEST_SLOTS) {
    // Clean up activeHostConnByPeerId entry set during duplicate handling above
    const cleanupConns = new Map(getState('network.activeHostConnByPeerId'));
    cleanupConns.delete(peerId);
    setState('network.activeHostConnByPeerId', cleanupConns);

    // Release old peer's slot and label — the old conn's close handler
    // will return early (activeHostConnByPeerId guard), so we must clean up here.
    releasePeerSlot(peerId);
    const currentLabels = getState('network.peerLabels');
    if (currentLabels && currentLabels[peerId]) {
      const { [peerId]: _, ...restLabels } = currentLabels;
      setState('network.peerLabels', restLabels);
    }

    const sendFullAndClose = () => {
      try {
        conn.send({
          type: MSG.SESSION_FULL,
          // i18nKey translates at the receiver (guest locale); message stays
          // as the back-compat fallback for older SW-cached bundles.
          i18nKey: 'network.session_full_detail',
          message: t('network.session_full_detail'),
        });
      } catch {
        /* noop */
      }
      setManagedTimer(
        'conn-close-' + conn.peer,
        () => {
          try {
            conn.close();
          } catch {
            /* noop */
          }
        },
        500,
      );
    };
    if (conn.open) sendFullAndClose();
    else conn.on('open', sendFullAndClose);
    return;
  }

  // Allocate slot
  const peerSlotByPeerId = getState('network.peerSlotByPeerId');
  const preferredSlot = peerSlotByPeerId.get(peerId) || null;
  const slot = getAvailablePeerSlot(preferredSlot, peerId);
  if (!slot) {
    const sendFullAndClose = () => {
      try {
        conn.send({
          type: MSG.SESSION_FULL,
          i18nKey: 'network.session_full_detail',
          message: t('network.session_full_detail'),
        });
      } catch {
        /* noop */
      }
      try {
        conn.close();
      } catch {
        /* noop */
      }
    };
    if (conn.open) sendFullAndClose();
    else conn.on('open', sendFullAndClose);
    return;
  }
  assignPeerSlot(peerId, slot);
  const deviceName = getPeerLabelBySlot(slot);

  // Publish a new map so state subscribers observe the label assignment.
  setState('network.peerLabels', { ...getState('network.peerLabels'), [peerId]: deviceName });

  const activeConns = new Map(getState('network.activeHostConnByPeerId'));
  activeConns.set(peerId, conn);
  setState('network.activeHostConnByPeerId', activeConns);

  const peerObj: ConnectedPeer = {
    id: peerId,
    slot,
    label: deviceName,
    status: 'connecting' as string,
    conn,
    isOp: isProRoom,
    isDataTarget: false,
    joinOrder: slot,
    lastHeartbeat: Date.now(),
    preloadedQueueItemIds: new Set(),
    connectionType: 'unknown',
    ...(isProRoom ? { roomCapabilities: [...capabilitiesForProRoomRole('controller')] } : {}),
  };

  // Re-check max guests before adding (guards against TOCTOU race with concurrent connections)
  const currentPeers = getState('network.connectedPeers');
  if (currentPeers.length >= MAX_GUEST_SLOTS) {
    log.warn(`[Host] Max guests reached during slot allocation for ${peerId}, rejecting`);
    releasePeerSlot(peerId);
    // Clean up activeHostConnByPeerId to prevent stale entry + spurious close handler
    const cleanupConns = new Map(getState('network.activeHostConnByPeerId'));
    cleanupConns.delete(peerId);
    setState('network.activeHostConnByPeerId', cleanupConns);
    // Also drop the peerLabels entry we set above. The conn.on('close')
    // handler short-circuits on `activeHostConnByPeerId.get(peerId) !== conn`
    // (we just deleted it), so without an explicit cleanup here the label
    // stays in state across many failed concurrent joins.
    const labelsAfterReject = getState('network.peerLabels');
    if (labelsAfterReject && peerId in labelsAfterReject) {
      const { [peerId]: _drop, ...restLabels } = labelsAfterReject;
      setState('network.peerLabels', restLabels);
    }
    const sendFullAndClose = () => {
      try {
        conn.send({
          type: MSG.SESSION_FULL,
          i18nKey: 'network.session_full_detail',
          message: t('network.session_full_detail'),
        });
      } catch {
        /* noop */
      }
      try {
        conn.close();
      } catch {
        /* noop */
      }
    };
    if (conn.open) sendFullAndClose();
    else conn.on('open', sendFullAndClose);
    return;
  }
  setState('network.connectedPeers', [...currentPeers, peerObj]);

  // Timeout: clean up peer if WebRTC open never fires (ICE stall)
  const openTimerName = 'conn-open-timeout-' + peerId;
  setManagedTimer(
    openTimerName,
    () => {
      if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) return;
      const peers = getState('network.connectedPeers');
      const stale = peers.find(
        (p) => p.id === peerId && p.conn === conn && p.status === 'connecting',
      );
      if (!stale) return;
      log.warn(`[Host] Connection open timeout for ${deviceName} — cleaning up stale peer`);
      setState(
        'network.connectedPeers',
        peers.filter((p) => p.id !== peerId),
      );
      const cleanConns = new Map(getState('network.activeHostConnByPeerId'));
      cleanConns.delete(peerId);
      setState('network.activeHostConnByPeerId', cleanConns);
      releasePeerSlot(peerId);
      const labels = getState('network.peerLabels');
      if (labels && labels[peerId]) {
        const { [peerId]: _, ...rest } = labels;
        setState('network.peerLabels', rest);
      }
      try {
        conn.close();
      } catch {
        /* noop */
      }
      broadcastDeviceList();
    },
    15000,
  );

  conn.on('open', () => {
    if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) {
      log.debug(`[Host] Ignored late open from replaced connection: ${peerId}`);
      try {
        conn.close();
      } catch {
        /* noop */
      }
      return;
    }
    clearManagedTimer(openTimerName);
    // Immutable update: replace peer object with updated status/heartbeat
    const peers = getState('network.connectedPeers');
    setState(
      'network.connectedPeers',
      peers.map((p) =>
        p.id === peerId ? { ...p, status: 'connected', lastHeartbeat: Date.now() } : p,
      ),
    );

    // Welcome message with host-assigned label
    try {
      conn.send({
        type: MSG.WELCOME,
        lockChannel: false,
        label: deviceName,
        chatFrozen: getState('network.chatFrozen') || false,
        slowmodeSeconds: getState('network.slowmodeSeconds') || 0,
        filterEnabled: getState('network.filterEnabled') || false,
      });
    } catch {
      /* noop */
    }

    // Ordered authority phase: the queue baseline is the first application
    // frame after WELCOME. All qid/media frames on the guest remain gated
    // until this phase completes.
    bus.emit('network:peer-bootstrap', conn);

    showToast(t('toast.device_connected', { name: deviceName }));
    broadcastSystemMessage('chat.peer_connected', { name: deviceName });

    sendLatestPinnedNotice(conn);

    // Emit event for other modules to send late-join bootstrap data.
    bus.emit('network:peer-connected', conn);

    // Poll for up to 10 seconds while ICE stabilizes, then classify this guest
    // as local or remote.
    detectConnectionType(conn)
      .then((type) => {
        if (!conn.open || getState('network.activeHostConnByPeerId').get(peerId) !== conn) return;
        const peers = getState('network.connectedPeers');
        const livePeer = peers.find((p) => p.id === peerId && p.conn === conn);
        if (livePeer) {
          // Immutable update: replace peer object with detected connection type
          setState(
            'network.connectedPeers',
            peers.map((p) => (p.id === peerId ? { ...p, connectionType: type } : p)),
          );
        }
        log.info(`[Host] ${deviceName} connection type: ${type}`);
        broadcastDeviceList();
        bus.emit('orchestrator:peer-type-detected', peerId);
        // Worst-case fallback: detectConnectionType returns 'remote' both for
        // genuine WAN peers and for LAN peers whose ICE never produced a
        // succeeded candidate-pair within the 10s polling window. Recheck once
        // after 30s to give late-stabilizing LAN ICE a chance to reclassify.
        // Only acts on a 'remote' → 'local' flip; never demotes 'local'.
        if (type === 'remote' && conn.open) {
          setManagedTimer(
            'ice-fallback-' + peerId,
            async () => {
              if (!conn.open || getState('network.activeHostConnByPeerId').get(peerId) !== conn)
                return;
              const recheck = await detectConnectionType(conn);
              if (!conn.open || getState('network.activeHostConnByPeerId').get(peerId) !== conn)
                return;
              if (recheck !== 'local') return;
              const ps = getState('network.connectedPeers');
              const p = ps.find((x) => x.id === peerId && x.conn === conn);
              if (p && p.connectionType !== 'local') {
                setState(
                  'network.connectedPeers',
                  ps.map((x) => (x.id === peerId ? { ...x, connectionType: 'local' as const } : x)),
                );
                log.info(`[Host] ${deviceName} reclassified as local on fallback`);
                broadcastDeviceList();
                bus.emit('orchestrator:peer-type-detected', peerId, false);
              }
            },
            30000,
          );
        }
      })
      .catch((e) => {
        log.warn('[Host] ICE detection error:', e);
      });

    // Broadcast updated device list to all peers
    broadcastDeviceList();
    bus.emit('network:role-badge-update');
    log.info(`[Host] ${deviceName} connected (peer: ${peerId})`);
  });

  conn.on('data', (data: unknown) => {
    try {
      bus.emit('network:data', data, conn);
    } catch (e) {
      log.error('[Host] Error in handleData', e);
    }
  });

  conn.on('close', () => {
    log.info(`[Host] Connection closed: ${peerId}`);

    // Ignore stale close events from replaced duplicate connections
    if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) return;

    // Clear ICE fallback timer to prevent firing on disconnected peer
    clearManagedTimer('ice-fallback-' + peerId);

    // Read current label BEFORE cleanup deletes it from peerLabels.
    // Captures rename (e.g. "Alice") instead of stale slot name ("GUEST 1").
    const currentLabel = getState('network.peerLabels')?.[peerId] || deviceName;

    const closeConns = new Map(getState('network.activeHostConnByPeerId'));
    closeConns.delete(peerId);
    setState('network.activeHostConnByPeerId', closeConns);
    releasePeerSlot(peerId);

    const peerLabelsOnClose = getState('network.peerLabels');
    if (peerLabelsOnClose) {
      const { [peerId]: _, ...restLabels } = peerLabelsOnClose;
      setState('network.peerLabels', restLabels);
    }

    const peers = getState('network.connectedPeers');
    setState(
      'network.connectedPeers',
      peers.filter((p) => p.id !== peerId),
    );

    bus.emit('network:peer-disconnected', peerId);
    broadcastDeviceList();

    const sessionStarted = getState('setup.sessionStarted');
    if (sessionStarted) {
      showToast(t('toast.device_disconnected', { name: currentLabel }));
      broadcastSystemMessage('chat.peer_disconnected', { name: currentLabel });
    }
    log.info(`[Host] ${currentLabel} disconnected`);
  });

  conn.on('error', (err: unknown) => {
    log.error('[Host] Connection error:', err);

    if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) {
      try {
        conn.close();
      } catch {
        /* noop */
      }
      return;
    }

    // Clear ICE fallback timer to prevent firing on disconnected peer
    clearManagedTimer('ice-fallback-' + peerId);

    const errLabel = getState('network.peerLabels')?.[peerId] || deviceName;

    const errConns = new Map(getState('network.activeHostConnByPeerId'));
    errConns.delete(peerId);
    setState('network.activeHostConnByPeerId', errConns);
    releasePeerSlot(peerId);

    const peerLabelsOnError = getState('network.peerLabels');
    if (peerLabelsOnError) {
      const { [peerId]: _, ...restLabelsErr } = peerLabelsOnError;
      setState('network.peerLabels', restLabelsErr);
    }

    const peers = getState('network.connectedPeers');
    setState(
      'network.connectedPeers',
      peers.filter((p) => p.id !== peerId),
    );

    bus.emit('network:peer-disconnected', peerId);
    broadcastDeviceList();

    const sessionStarted = getState('setup.sessionStarted');
    if (sessionStarted) {
      showToast(t('toast.device_conn_error', { name: errLabel }));
      broadcastSystemMessage('chat.peer_disconnected', { name: errLabel });
    }
    try {
      conn.close();
    } catch {
      /* noop */
    }
  });
}

// ─── Host Bus Event Handlers ────────────────────────────────────────

// Host: Toggle operator permission on a peer
bus.on('network:toggle-operator', (peerId) => {
  if (!peerId) return;

  // PRO authority is server-issued and represented by room capabilities.
  // Never let the legacy ADMIN event mutate that compatibility projection.
  if (getRoomContext().kind === 'pro') return;

  // Only Host can toggle operator
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  const connectedPeers = getState('network.connectedPeers');
  const idx = connectedPeers.findIndex((x) => x.id === peerId);
  if (idx !== -1) {
    const p = connectedPeers[idx];
    const conn = p.conn as DataConnection;
    // Bail before mutating shared state if the channel is gone — otherwise the
    // target never receives OPERATOR_GRANT while every other peer's UI shows
    // them as OP, leaving badge state and command authorization out of sync.
    if (!conn || !conn.open) {
      log.warn(`[OP] Cannot toggle operator for ${peerId} — connection not open`);
      return;
    }
    const newOp = !p.isOp;
    if (!safeSend(conn, { type: newOp ? MSG.OPERATOR_GRANT : MSG.OPERATOR_REVOKE })) {
      log.warn(`[OP] Failed to send operator status to ${peerId}`);
      return;
    }
    const updated = connectedPeers.map((peer, i) => (i === idx ? { ...peer, isOp: newOp } : peer));
    setState('network.connectedPeers', updated);
    broadcastDeviceList();
    // Revoke: re-baseline the demoted guest's effect state. Their optimistic
    // local applies (slider preview / apply-before-request) may have raced the
    // revoke and were silently dropped by verifyOperator with no NACK — the
    // snapshot resend converges them back to room state. Ordered channel
    // guarantees it lands after OPERATOR_REVOKE. (Bus event, not a direct
    // import: effects.ts → peer.ts → host.ts would cycle.)
    if (!newOp) {
      bus.emit('effects:resync-peer', conn);
      // Same race class for the playlist toggles: an optimistic repeat/shuffle
      // REQUEST_SETTING dies silently in verifyOperator after the revoke, and
      // the effects snapshot doesn't cover these. _bootstrap marks them as a
      // re-baseline, not a change — the handlers skip the toggle toast.
      safeSend(conn, {
        type: MSG.REPEAT_MODE,
        value: getState('playlist.repeatMode') || 0,
        _bootstrap: true,
      });
      safeSend(conn, {
        type: MSG.SHUFFLE_MODE,
        value: !!getState('playlist.isShuffle'),
        _bootstrap: true,
      });
    }
    showToast(
      t('toast.op_status', {
        label: p.label,
        status: newOp ? t('common.granted') : t('common.revoked'),
      }),
    );
  }
});

// Host: Kick a connected peer from the session
bus.on('network:kick-device', (peerId) => {
  if (!peerId) return;

  // Only host can kick
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  const connectedPeers = getState('network.connectedPeers');
  const target = connectedPeers.find((x) => x.id === peerId);
  if (!target) return;

  const conn = target.conn as DataConnection;
  if (conn && conn.open) {
    try {
      conn.send({ type: MSG.KICK_DEVICE });
    } catch {
      /* noop */
    }
    // Give message time to arrive before closing
    setManagedTimer(
      'kick-close-' + peerId,
      () => {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      },
      300,
    );
  }

  log.info(`[Host] Kicked peer ${target.label || peerId}`);
  showToast(t('toast.device_kicked', { name: target.label || peerId }));
});

bus.on('network:room-password-changed', (password: string | null) => {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  const peer = getPeer();
  try {
    peer?.setRoomPassword?.(password);
  } catch (error) {
    log.warn('[Host] Failed to update room password:', error);
  }
});

bus.on('network:device-list', (list) => {
  if (Array.isArray(list)) {
    setState('network.lastKnownDeviceList', list as DeviceInfo[]);
    bus.emit('network:device-list-update', list);
  }
});

// ─── Host: Rename Device ─────────────────────────────────────────

// Host renames itself — no network message needed
bus.on('network:rename-device', (newName: string) => {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host handles this path
  setState('network.myDeviceLabel', newName);
  broadcastDeviceList();
});

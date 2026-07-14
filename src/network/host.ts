/**
 * MUSIXQUARE — Host-Side Peer Connection Logic
 *
 * Manages: incoming guest connections, welcome messages, device list,
 * operator toggle, kick, max-guests resize.
 *
 * Avoids importing from peer.ts; host-side helpers stay on peer-state.ts.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import type { AnyProtocolMsg, ConnectedPeer, DataConnection, DeviceInfo } from '../types/index.ts';
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
import { getFilePlaybackApplicationSessionManager } from './file-playback-application-session.ts';
import {
  isFilePlaybackSessionSemanticCohortMismatchV2,
  snapshotFilePlaybackSessionHelloCandidateV2,
} from './file-playback-session-handshake.ts';
import { getFilePlaybackBuildProfile } from '../player/file-playback-build-profile.ts';
import { isFilePlaybackEngineV2Enabled } from '../player/file-playback-engine-gate.ts';

const FILE_PLAYBACK_ENGINE_V2_ENABLED = isFilePlaybackEngineV2Enabled();
const FILE_PLAYBACK_SEMANTIC_COHORT_ID = getFilePlaybackBuildProfile().semanticPlaybackCohortId;

// ─── Host: Incoming Connection ──────────────────────────────────────

let remoteGuestMessageShown = false;

function maybeBroadcastRemoteGuestMessage(): void {
  if (remoteGuestMessageShown) return;
  remoteGuestMessageShown = true;
  broadcastSystemMessage('chat.remote_guest_detected_system_message');
}

export function handleHostIncomingConnection(conn: DataConnection): void {
  const peerId = conn.peer;
  const connectedPeers = getState('network.connectedPeers');
  const activeHostConnByPeerId = getState('network.activeHostConnByPeerId');
  // The engine choice belongs to this module/connection lifetime. Gate-off
  // must never instantiate or consult the V2 application-session authority.
  const applicationSessions = FILE_PLAYBACK_ENGINE_V2_ENABLED
    ? getFilePlaybackApplicationSessionManager()
    : null;
  let applicationEstablished = false;
  let dataChannelOpened = false;
  let preOpenHello: ReturnType<typeof snapshotFilePlaybackSessionHelloCandidateV2> = null;
  let preOpenRejected = false;
  let semanticCohortMismatch = false;
  let semanticCohortMismatchUiPublished = false;
  let detectedConnectionType: 'local' | 'remote' | null = null;
  let connectionTypePublished = false;

  // Duplicate connection handling
  const existingActiveConn = activeHostConnByPeerId.get(peerId);
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
    applicationSessions?.closeConnection(existingActiveConn, false);
  }

  // Remove lingering peer object with same id
  const filtered = connectedPeers.filter((p) => p.id !== peerId);
  setState('network.connectedPeers', filtered);

  // Enforce max guests
  const maxGuestSlots = getState('network.maxGuestSlots');
  if (filtered.length >= maxGuestSlots) {
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
    isOp: false,
    isDataTarget: false,
    joinOrder: slot,
    lastHeartbeat: Date.now(),
    preloadedQueueItemIds: new Set(),
    connectionType: 'unknown',
  };

  // Re-check max guests before adding (guards against TOCTOU race with concurrent connections)
  const currentPeers = getState('network.connectedPeers');
  if (currentPeers.length >= getState('network.maxGuestSlots')) {
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

  const recordSemanticCohortMismatch = (): void => {
    semanticCohortMismatch = true;
    if (
      semanticCohortMismatchUiPublished ||
      getState('network.activeHostConnByPeerId').get(peerId) !== conn
    ) {
      return;
    }
    semanticCohortMismatchUiPublished = true;
    const message = t('error.peer_app_version_mismatch', { name: deviceName });
    showToast(message);
    // The rejected transport never became a room participant. Keep this
    // automatic diagnostic local to the host's gray system-message lane.
    bus.emit('chat:system-message', message);
  };

  const publishDetectedConnectionType = (isInitial: boolean): void => {
    if (
      !applicationEstablished ||
      !detectedConnectionType ||
      !conn.open ||
      getState('network.activeHostConnByPeerId').get(peerId) !== conn
    ) {
      return;
    }
    if (isInitial && connectionTypePublished) return;
    broadcastDeviceList();
    bus.emit('orchestrator:peer-type-detected', peerId, isInitial);
    if (detectedConnectionType === 'remote') maybeBroadcastRemoteGuestMessage();
    connectionTypePublished = true;
  };

  const completeApplicationSession = (): void => {
    if (
      applicationEstablished ||
      !conn.open ||
      getState('network.activeHostConnByPeerId').get(peerId) !== conn ||
      (FILE_PLAYBACK_ENGINE_V2_ENABLED && !applicationSessions?.establishedChannel(conn))
    ) {
      return;
    }
    applicationEstablished = true;
    const peers = getState('network.connectedPeers');
    setState(
      'network.connectedPeers',
      peers.map((p) =>
        p.id === peerId && p.conn === conn
          ? { ...p, status: 'connected', lastHeartbeat: Date.now() }
          : p,
      ),
    );

    showToast(t('toast.device_connected', { name: deviceName }));
    broadcastSystemMessage('chat.peer_connected', { name: deviceName });
    sendLatestPinnedNotice(conn);
    bus.emit('network:peer-connected', conn);
    bus.emit('network:role-badge-update');
    if (detectedConnectionType) publishDetectedConnectionType(true);
    else broadcastDeviceList();
    log.info(`[Host] ${deviceName} application session established (peer: ${peerId})`);
  };

  const welcomeFrame = () => ({
    type: MSG.WELCOME as typeof MSG.WELCOME,
    lockChannel: false,
    label: deviceName,
    chatFrozen: getState('network.chatFrozen') || false,
    slowmodeSeconds: getState('network.slowmodeSeconds') || 0,
    filterEnabled: getState('network.filterEnabled') || false,
  });

  const sendLegacyQueueBootstrap = (): boolean => {
    let acknowledgementCount = 0;
    let succeeded = false;
    let bootstrapIndex = 0;
    let invalidBootstrap = false;
    const expectedTypes = [MSG.PLAYLIST_UPDATE, MSG.REPEAT_MODE, MSG.SHUFFLE_MODE] as const;
    bus.emit(
      'network:peer-bootstrap',
      conn,
      (frame) => {
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
          invalidBootstrap = true;
          return false;
        }
        const message = frame as Record<string, unknown>;
        if (
          message.type !== expectedTypes[bootstrapIndex] ||
          (bootstrapIndex === 0 && message.bootstrap !== true) ||
          (bootstrapIndex > 0 && message._bootstrap !== true)
        ) {
          invalidBootstrap = true;
          return false;
        }
        if (!conn.open || getState('network.activeHostConnByPeerId').get(peerId) !== conn) {
          invalidBootstrap = true;
          return false;
        }
        if (!safeSend(conn, frame as AnyProtocolMsg)) {
          invalidBootstrap = true;
          return false;
        }
        bootstrapIndex += 1;
        return true;
      },
      (success) => {
        acknowledgementCount += 1;
        if (acknowledgementCount === 1) succeeded = success === true;
      },
    );
    return (
      !invalidBootstrap &&
      acknowledgementCount === 1 &&
      succeeded &&
      bootstrapIndex === expectedTypes.length
    );
  };

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
    dataChannelOpened = true;
    if (FILE_PLAYBACK_ENGINE_V2_ENABLED && preOpenRejected) {
      try {
        conn.close();
      } catch {
        /* noop */
      }
      return;
    }
    clearManagedTimer(openTimerName);
    if (FILE_PLAYBACK_ENGINE_V2_ENABLED) {
      if (!applicationSessions) {
        // A selected V2 build without its authority is an initialization
        // failure. Never reinterpret the connection as legacy.
        try {
          conn.close();
        } catch {
          /* noop */
        }
        return;
      }

      // Transport-open is not a room join in V2. Keep the peer out of
      // broadcasts and user-visible state until its exact APPLIED receipt.
      const peers = getState('network.connectedPeers');
      setState(
        'network.connectedPeers',
        peers.map((p) =>
          p.id === peerId ? { ...p, status: 'handshaking', lastHeartbeat: Date.now() } : p,
        ),
      );

      if (!applicationSessions.beginHostConnection(conn, peerId)) return;
      if (
        preOpenHello &&
        isFilePlaybackSessionSemanticCohortMismatchV2(
          preOpenHello,
          FILE_PLAYBACK_SEMANTIC_COHORT_ID,
        )
      ) {
        const queuedHello = preOpenHello;
        preOpenHello = null;
        recordSemanticCohortMismatch();
        const application = applicationSessions.receive(queuedHello, conn);
        if (application.updateRequired) recordSemanticCohortMismatch();
        return;
      }
      if (!applicationSessions.sendRequired(conn, welcomeFrame())) return;

      if (preOpenHello) {
        const queuedHello = preOpenHello;
        preOpenHello = null;
        const application = applicationSessions.receive(queuedHello, conn);
        if (application.updateRequired) recordSemanticCohortMismatch();
        if (!application.handled || applicationSessions.phase(conn) === 'none') return;
      }
    } else {
      // Legacy remains an exact RTC-open protocol: WELCOME first, followed by
      // the existing ordered queue/repeat/shuffle bootstrap contract. It does
      // not create a V2 session, clock, offer, run, or range authority.
      if (!safeSend(conn, welcomeFrame()) || !sendLegacyQueueBootstrap()) {
        try {
          conn.close();
        } catch {
          /* noop */
        }
        return;
      }
      completeApplicationSession();
    }

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
        detectedConnectionType = type;
        log.info(`[Host] ${deviceName} connection type: ${type}`);
        publishDetectedConnectionType(true);

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
                detectedConnectionType = 'local';
                log.info(`[Host] ${deviceName} reclassified as local on fallback`);
                publishDetectedConnectionType(connectionTypePublished ? false : true);
              }
            },
            30000,
          );
        }
      })
      .catch((e) => {
        log.warn('[Host] ICE detection error:', e);
      });

    if (FILE_PLAYBACK_ENGINE_V2_ENABLED) {
      log.info(`[Host] ${deviceName} transport open; awaiting APPLIED (peer: ${peerId})`);
    }
  });

  conn.on('data', (data: unknown) => {
    if (FILE_PLAYBACK_ENGINE_V2_ENABLED && !dataChannelOpened) {
      const hello = snapshotFilePlaybackSessionHelloCandidateV2(data);
      if (!hello || preOpenHello) {
        preOpenRejected = true;
        preOpenHello = null;
        try {
          conn.close();
        } catch {
          /* noop */
        }
        return;
      }
      preOpenHello = hello;
      return;
    }
    try {
      if (FILE_PLAYBACK_ENGINE_V2_ENABLED) {
        if (!applicationSessions) {
          try {
            conn.close();
          } catch {
            /* noop */
          }
          return;
        }
        if (isFilePlaybackSessionSemanticCohortMismatchV2(data, FILE_PLAYBACK_SEMANTIC_COHORT_ID)) {
          recordSemanticCohortMismatch();
        }
        const application = applicationSessions.receive(data, conn);
        if (application.updateRequired) recordSemanticCohortMismatch();
        if (application.handled) {
          if (application.established) completeApplicationSession();
          return;
        }
      }
      bus.emit('network:data', data, conn);
    } catch (e) {
      log.error('[Host] Error in handleData', e);
    }
  });

  conn.on('close', () => {
    log.info(`[Host] Connection closed: ${peerId}`);
    applicationSessions?.closeConnection(conn, false);

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
    if (applicationEstablished && sessionStarted && !semanticCohortMismatch) {
      showToast(t('toast.device_disconnected', { name: currentLabel }));
      broadcastSystemMessage('chat.peer_disconnected', { name: currentLabel });
    }
    log.info(`[Host] ${currentLabel} disconnected`);
  });

  conn.on('error', (err: unknown) => {
    log.error('[Host] Connection error:', err);
    applicationSessions?.closeConnection(conn, false);

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
    if (applicationEstablished && sessionStarted && !semanticCohortMismatch) {
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

// Host: resize peer slots when max guests changes
bus.on('network:max-guests-changed', (max: number) => {
  setState('network.maxGuestSlots', max);
  const oldSlots = getState('network.peerSlots');
  const newSlots = Array(max + 1).fill(null) as (string | null)[];
  // Preserve in-range assignments; collect occupants of truncated slots.
  // Slots can be sparse (mid-session departures leave holes), so a peer in a
  // high slot index may still FIT within the new count — relocate them into a
  // freed low slot instead of kicking. Kick only genuine overflow.
  const displacedPeerIds: string[] = [];
  for (let i = 1; i < oldSlots.length; i++) {
    if (i < newSlots.length) {
      newSlots[i] = oldSlots[i];
    } else if (oldSlots[i]) {
      displacedPeerIds.push(oldSlots[i]!);
    }
  }
  setState('network.peerSlots', newSlots);
  for (const peerId of displacedPeerIds) {
    const free = getAvailablePeerSlot(null, peerId);
    if (free) {
      // assignPeerSlot overwrites the peerSlotByPeerId entry; do NOT call
      // releasePeerSlot first (the old out-of-range index no longer exists
      // in the truncated array).
      assignPeerSlot(peerId, free);
      // Keep the ConnectedPeer record aligned with the canonical slot map.
      // label/joinOrder stay as-is
      // on purpose: label is join-time identity (rename semantics) and
      // joinOrder is join order, not slot. The device list exposes neither
      // slot nor anything relocation changes, so no re-broadcast needed.
      setState(
        'network.connectedPeers',
        getState('network.connectedPeers').map((p) => (p.id === peerId ? { ...p, slot: free } : p)),
      );
      log.info(`[Peer] Relocated ${peerId} to freed slot ${free} after max-guests resize`);
    } else {
      releasePeerSlot(peerId);
      bus.emit('network:kick-device', peerId);
    }
  }
  log.info(`[Peer] Max guest slots changed to ${max}`);
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

bus.on('state:network.sessionCode', () => {
  remoteGuestMessageShown = false;
});

// ─── Host: Rename Device ─────────────────────────────────────────

// Host renames itself — no network message needed
bus.on('network:rename-device', (newName: string) => {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host handles this path
  setState('network.myDeviceLabel', newName);
  broadcastDeviceList();
});

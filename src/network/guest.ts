/**
 * MUSIXQUARE — Guest-Side Peer Connection Logic
 *
 * Manages: outgoing connection to host, reconnect retry, guest protocol handlers
 * (welcome, session full, device list, operator, kick, force-close-duplicate).
 *
 * Imports from peer-state.ts (leaf) only — never from peer.ts.
 * Uses late-bound import for initNetwork (from peer.ts) to avoid circular deps.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import type { I18nKey } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { isCapabilityChallengeCancelled } from '../core/capability.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { getDevicePlatform } from '../core/platform.ts';
import { registerHandlers } from './protocol.ts';
import type { DataConnection, DeviceInfo, RoomCapability } from '../types/index.ts';

import { getPeer, detectConnectionType, safeSend } from './peer-state.ts';
import { startWorkerTimer } from './sync-worker.ts';
import { showToast } from '../ui/toast.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import {
  markProRoomTransportRecovered,
  requestProRoomTransportRecovery,
} from '../pro-room/transport-recovery.ts';

// ─── Late-bound initNetwork (avoids circular peer.ts ↔ guest.ts) ───

let _initNetwork: ((requestedId: string | null) => Promise<string>) | null = null;
let _guestJoinEpoch = 0;
type ConnectionType = 'local' | 'remote' | 'unknown';
let _hostReportedConnectionType: ConnectionType | null = null;
const _handledConnectionErrors = new WeakSet<DataConnection>();

function asConnectionType(value: unknown): ConnectionType | null {
  return value === 'local' || value === 'remote' || value === 'unknown' ? value : null;
}

function emitConnectionTypeChanged(): void {
  bus.emit('network:role-badge-update');
}

function applyGuestDetectedConnectionType(type: ConnectionType, source: string): boolean {
  const hostType = _hostReportedConnectionType;
  if (hostType && hostType !== 'unknown' && hostType !== type) {
    if (getState('network.connectionType') !== hostType) {
      setState('network.connectionType', hostType);
    }
    log.info(
      `[Peer] ${source} detected ${type}, but host reports ${hostType}; keeping host routing`,
    );
    emitConnectionTypeChanged();
    return false;
  }

  if (getState('network.connectionType') !== type) {
    setState('network.connectionType', type);
  }
  emitConnectionTypeChanged();
  return true;
}

function applyHostReportedConnectionType(type: ConnectionType): void {
  _hostReportedConnectionType = type;
  if (type === 'unknown') return;
  if (getState('network.connectionType') !== type) {
    setState('network.connectionType', type);
  }
  emitConnectionTypeChanged();
}

/** Called by peer.ts during bootstrap to inject initNetwork reference. */
export function setInitNetwork(fn: (requestedId: string | null) => Promise<string>): void {
  _initNetwork = fn;
}

function reportGuestConnectionFailure(error: unknown): void {
  if (getRoomContext().kind === 'pro') {
    // Coordinator-free PRO no longer enters through this PeerJS path. Keep a
    // fail-closed recovery seam for an in-flight legacy callback, but do not
    // publish a second orphaned error channel into the active app.
    if (getState('setup.sessionStarted')) requestProRoomTransportRecovery();
    return;
  }
  bus.emit('network:error', error);
}

/** Invalidate every callback/timer owned by the current provisional join. */
export function invalidateGuestJoinAttempt(): void {
  _guestJoinEpoch++;
}

function isCurrentGuestJoin(epoch: number): boolean {
  return epoch === _guestJoinEpoch;
}

function terminateGuestJoin(epoch: number): boolean {
  if (!isCurrentGuestJoin(epoch)) return false;
  _guestJoinEpoch++;
  clearManagedTimer('join-timeout');
  clearManagedTimer('join-retry');
  return true;
}

// ─── Guest: Join Session ────────────────────────────────────────────

/**
 * Connect to a host session as a guest.
 */
export function joinSession(
  hostId: string,
  roomPassword = '',
  retryAttempt = 0,
  ownerEpoch?: number,
): void {
  // Guard against duplicate calls (e.g. rapid double-click)
  // Only check on initial call — retries (retryAttempt > 0) must pass through
  // because isConnecting is already true from the initial call.
  if (retryAttempt === 0 && getState('network.isConnecting')) {
    log.warn('[Join] Already connecting — ignoring duplicate joinSession call');
    return;
  }

  const hostConn = getState('network.hostConn');
  if (hostConn) {
    if (hostConn.open) {
      log.warn('[Join] Already connected to host.');
      return;
    }
    try {
      hostConn.close();
    } catch {
      /* noop */
    }
    setState('network.hostConn', null);
  }

  // Clear the previous connection's ICE fallback timer so it cannot overwrite
  // the new connection's ICE classification.
  clearManagedTimer('guest-ice-fallback');
  _hostReportedConnectionType = null;

  if (!hostId) {
    bus.emit('network:error', new Error('NO_HOST_ID'));
    return;
  }

  const joinEpoch = retryAttempt === 0 ? ++_guestJoinEpoch : (ownerEpoch ?? _guestJoinEpoch);
  if (!isCurrentGuestJoin(joinEpoch)) return;

  setState('network.lastJoinCode', hostId);

  // Set connecting state on initial call (callers must NOT pre-set this)
  if (retryAttempt === 0) {
    setState('network.isConnecting', true);
    // Clear stale flag from previous cancelled join (startGuestFlow sets true
    // on back-button cancel, but if old conn never opened, close handler
    // never fires to reset it — leaving the flag stuck on true).
    setState('network.isIntentionalDisconnect', false);
  }

  const peer = getPeer();

  // Ensure peer exists and is open
  if (!peer) {
    if (retryAttempt > 3) {
      setState('network.isConnecting', false);
      reportGuestConnectionFailure(new Error('NETWORK_INIT_FAILED'));
      return;
    }
    if (!_initNetwork) {
      setState('network.isConnecting', false);
      reportGuestConnectionFailure(new Error('NETWORK_INIT_FAILED'));
      return;
    }
    _initNetwork(null)
      .then(() => {
        if (!isCurrentGuestJoin(joinEpoch)) return;
        joinSession(hostId, roomPassword, retryAttempt + 1, joinEpoch);
      })
      .catch((e) => {
        if (!isCurrentGuestJoin(joinEpoch)) return;
        // A user-cancelled capability/Turnstile challenge (peer.ts
        // rethrows it directly) or a back-out that makes network init no longer
        // active (NETWORK_INIT_CANCELLED) is intentional — it must NOT surface as
        // a red "network init failed" toast. Restore the join UI silently.
        if (
          isCapabilityChallengeCancelled(e) ||
          (e instanceof Error && e.message === 'NETWORK_INIT_CANCELLED')
        ) {
          setState('network.isConnecting', false);
          bus.emit('setup:guest-join-cancelled');
          return;
        }
        log.error('[Join] Failed to init peer', e);
        setState('network.isConnecting', false);
        const typedTransportError =
          e && typeof e === 'object' && typeof (e as Record<string, unknown>).type === 'string';
        reportGuestConnectionFailure(
          typedTransportError ? e : new Error('NETWORK_INIT_FAILED', { cause: e }),
        );
      });
    return;
  }

  if (!peer.open) {
    if (retryAttempt < 10) {
      setManagedTimer(
        'join-retry',
        () => {
          if (!isCurrentGuestJoin(joinEpoch)) return;
          joinSession(hostId, roomPassword, retryAttempt + 1, joinEpoch);
        },
        300,
      );
    } else {
      setState('network.isConnecting', false);
      reportGuestConnectionFailure(new Error('PEER_NOT_READY'));
    }
    return;
  }

  let conn: DataConnection;
  try {
    const channelMode = getState('audio.channelMode');
    conn = peer.connect(hostId, {
      reliable: true,
      metadata: { label: `mode-${channelMode}`, devicePlatform: getDevicePlatform() },
      roomPassword,
    });
  } catch (e) {
    log.error('[Join] peer.connect failed', e);
    setState('network.isConnecting', false);
    reportGuestConnectionFailure(new Error('CONNECT_FAILED'));
    return;
  }

  // Track the observed event; an adapter may expose conn.open before its open
  // callback has completed.
  let dataChannelOpened = false;
  let connectionEstablished = false;

  const completeConnection = (): void => {
    if (
      connectionEstablished ||
      !isCurrentGuestJoin(joinEpoch) ||
      getState('network.hostConn') !== conn ||
      !conn.open
    ) {
      return;
    }
    connectionEstablished = true;
    setState('network.isConnecting', false);
    startWorkerTimer('sync', 1000);
    bus.emit('sync:request-immediate-ping');
    bus.emit('network:peer-connected', conn);
    bus.emit('setup:guest-join-success');
    markProRoomTransportRecovered();
    log.info('[Join] Connection established with host:', hostId);
  };

  const handlePreOpenError = (err: unknown) => {
    if (dataChannelOpened || !terminateGuestJoin(joinEpoch)) return;
    log.warn('[Join] Host connection error before open', err);
    try {
      conn.close();
    } catch {
      /* noop */
    }
    setState('network.isConnecting', false);
    reportGuestConnectionFailure(err);
  };

  // Register data handling before `open`: PeerJS adapters can deliver the
  // host's lifecycle WELCOME before the guest-side callback has finished.
  const processInboundData = (data: unknown): void => {
    if (!isCurrentGuestJoin(joinEpoch) || getState('network.hostConn') !== conn) return;
    bus.emit('network:data', data, conn);
  };

  conn.on('data', (data: unknown) => {
    if (!isCurrentGuestJoin(joinEpoch)) return;
    processInboundData(data);
  });
  conn.on('error', handlePreOpenError);

  // Timeout if host is unreachable (10s — beyond this, the network is too
  // unstable for a real-time sync session anyway).
  setManagedTimer(
    'join-timeout',
    () => {
      if (!isCurrentGuestJoin(joinEpoch) || dataChannelOpened || getState('network.hostConn')) {
        return;
      }
      if (!terminateGuestJoin(joinEpoch)) return;
      log.warn('[Join] Connection timeout — data channel did not open in 10s');
      try {
        conn.close();
      } catch {
        /* noop */
      }
      setState('network.isConnecting', false);
      reportGuestConnectionFailure(new Error('HOST_UNREACHABLE'));
    },
    10000,
  );

  conn.on('open', () => {
    if (!isCurrentGuestJoin(joinEpoch)) {
      try {
        conn.close();
      } catch {
        /* noop */
      }
      return;
    }
    dataChannelOpened = true;
    clearManagedTimer('join-timeout');
    conn.off?.('error', handlePreOpenError);
    log.info('[Join] Connected to host:', hostId);

    setState('network.hostConn', conn);

    // close/error handlers are intentionally inside 'open' callback:
    // Before 'open' fires, the join-timeout timer handles failures.
    // Registering them here avoids premature cleanup from adapter close events
    // that can fire before the channel opens.
    _handledConnectionErrors.delete(conn);

    conn.on('close', () => {
      // Stale-conn no-op (parity with host.ts's per-peer close guard): once
      // this conn no longer owns network.hostConn — replaced by a rejoin, or
      // already nulled by leaveSession/rejoin cleanup — its close is
      // lifecycle noise. Concretely reachable via the double-join orphan
      // race: a pre-open conn abandoned by back-button cancel opens late,
      // the host force-closes it as a duplicate (the guest drops that frame
      // for non-current conns, so the intent flag never arms), and without
      // this return its close would reset isConnecting mid-connect and
      // surface a "disconnected" dialog (which also stops YouTube playback)
      // over the LIVE session. Accepted residual: if the intent flag was
      // armed while this conn was still current and the replacement opened
      // before this close fired, the flag stays armed until the next
      // joinSession entry resets it.
      if (getState('network.hostConn') !== conn) {
        log.debug('[Join] Stale connection closed — ignoring');
        return;
      }
      log.warn('[Join] Host connection closed');
      setState('network.hostConn', null);
      setState('network.isConnecting', false);

      if (_handledConnectionErrors.has(conn)) {
        // Don't reset isIntentionalDisconnect — the error handler already
        // determined intent. Resetting unconditionally here would mask
        // intentional disconnects (e.g. leaveSession) that race with close.
        return;
      }
      const isIntentional = getState('network.isIntentionalDisconnect');
      _handledConnectionErrors.add(conn);
      if (!isIntentional) {
        reportGuestConnectionFailure(new Error('HOST_DISCONNECTED'));
      }
      setState('network.isIntentionalDisconnect', false);
    });

    conn.on('error', (err: unknown) => {
      // Same stale-conn no-op as the close handler above: a replaced conn's
      // draining error (e.g. a malformed frame on a dying transport) must
      // not surface an error dialog over the live connection.
      if (getState('network.hostConn') !== conn) {
        log.debug('[Join] Stale connection error — ignoring', err);
        return;
      }
      log.error('[Join] Host connection error', err);
      setState('network.hostConn', null);
      setState('network.isConnecting', false);

      if (_handledConnectionErrors.has(conn)) return;

      const isIntentional = getState('network.isIntentionalDisconnect');
      _handledConnectionErrors.add(conn);
      if (!isIntentional) {
        reportGuestConnectionFailure(new Error('HOST_CONNECTION_ERROR'));
      }
    });

    completeConnection();

    // Detect local vs remote connection. The detectConnectionType function
    // now internally polls until ICE stabilizes (up to 10 seconds).
    detectConnectionType(conn).then((type) => {
      if (!conn.open || getState('network.hostConn') !== conn) return;
      const applied = applyGuestDetectedConnectionType(type, 'Initial ICE detection');
      if (applied) log.info(`[Peer] Connection type: ${type}`);

      // Worst-case fallback: see host.ts for rationale. Recheck once after
      // 30s to recover from a misclassified LAN peer where ICE was still
      // stabilizing during the initial poll.
      if (type === 'remote' && conn.open) {
        setManagedTimer(
          'guest-ice-fallback',
          async () => {
            if (!conn.open || getState('network.hostConn') !== conn) return;
            const recheck = await detectConnectionType(conn);
            if (!conn.open || getState('network.hostConn') !== conn) return;
            if (recheck === 'local' && getState('network.connectionType') !== 'local') {
              const appliedFallback = applyGuestDetectedConnectionType(
                'local',
                'Fallback ICE detection',
              );
              if (appliedFallback) log.info('[Peer] Reclassified as local on fallback');
            }
          },
          30000,
        );
      }
    });
  });
}

// ─── Guest Protocol Handlers ──────────────────────────────────────

function handleWelcome(data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop frames not arriving via hostConn. WELCOME is host-to-guest only; a
  // guest must not trust raw setup frames from any other peer.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  if (data.label) {
    setState('network.myDeviceLabel', String(data.label));
  }
  // Standard WELCOME starts a guest with isOp=false; a PRO controller's
  // authority came from the authenticated room snapshot and must not be
  // downgraded by this legacy compatibility frame.
  if (getRoomContext().kind === 'pro') setState('network.isOperator', true);
  else if (getState('network.isOperator')) setState('network.isOperator', false);
  // Sync chat moderation state from host (always set, even when false/0)
  setState('network.chatFrozen', !!data.chatFrozen);
  setState(
    'network.slowmodeSeconds',
    typeof data.slowmodeSeconds === 'number' ? data.slowmodeSeconds : 0,
  );
  setState('network.filterEnabled', !!data.filterEnabled);
  bus.emit('network:role-badge-update');
}

function handleSessionFull(data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop frames not arriving via hostConn. Without this, a malicious guest
  // (same session, raw frame over their own DataConnection) can send
  // {type:'session-full'} to the host. handleData routes it here, and the
  // event below triggers setup.ts startGuestFlow(), swapping the host's
  // entire session UI to guest-flow.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  // Prefer receiver-side translation (the host sent its OWN locale's text as
  // fallback — a Korean host's rejection must not render Korean on an English
  // guest). Mirrors handleOperatorToast: the translated !== key check guards
  // against leaking the raw key on a dictionary miss (older bundle).
  let msg = data.message ? String(data.message) : t('network.session_full');
  if (typeof data.i18nKey === 'string') {
    const translated = t(data.i18nKey as I18nKey);
    if (translated !== data.i18nKey) msg = translated;
  }

  setState('network.isIntentionalDisconnect', true);

  try {
    hostConn.close();
  } catch {
    /* noop */
  }
  setState('network.hostConn', null);
  setState('network.isConnecting', false);
  bus.emit('network:role-badge-update');
  bus.emit('network:session-full', msg);
}

function handleDeviceListUpdateMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop frames not arriving via hostConn. Without this, a malicious guest
  // can send {type:'device-list-update', list:[]} to any guest — the
  // amIStillConnected check below sees an empty list, fires
  // 'network:kicked-from-session', and setup.ts reloads the page in
  // 300ms. Single raw frame → forced session leave for the target.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  const list = Array.isArray(data.list) ? (data.list as DeviceInfo[]) : [];

  const myId = getState('network.myId');

  if (myId) {
    const amIStillConnected = list.find((p) => p && p.id === myId);
    if (!amIStillConnected) {
      log.warn('[Guest] Removed from Host device list. Leaving session...');
      setState('network.isIntentionalDisconnect', true);
      bus.emit('network:kicked-from-session');
      return; // Don't update state with a list that excludes us
    }
    if (amIStillConnected.label) {
      setState('network.myDeviceLabel', String(amIStillConnected.label));
    }
    if (typeof amIStillConnected.joinOrder === 'number') {
      setState('network.myJoinOrder', amIStillConnected.joinOrder);
    }
    // Trust host's connectionType over local ICE detection (host sees both sides)
    const hostConnType = asConnectionType(amIStillConnected.connectionType);
    if (hostConnType) applyHostReportedConnectionType(hostConnType);
  }

  setState('network.lastKnownDeviceList', list);
  bus.emit('network:device-list-update', list);
}

function handleForceCloseDuplicate(_data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop frames not arriving via hostConn. Without this, a peer can inject
  // {type:'force-close-duplicate'} to set
  // isIntentionalDisconnect=true on the target, suppressing the
  // HOST_DISCONNECTED error UI when the connection actually drops. The same
  // trust-boundary rule applies to handleWelcome and SYNC_PONG.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  log.warn('[Guest] Received force-close-duplicate — connection will close');
  // Mark as intentional so the close handler doesn't show HOST_DISCONNECTED error
  setState('network.isIntentionalDisconnect', true);
}

const STANDARD_GRANT_CAPABILITIES = new Set<RoomCapability>([
  'media.add',
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'members.manage',
  'chat.notice',
  'room.configure',
]);

function normalizeStandardGrantCapabilities(value: unknown): RoomCapability[] | null {
  if (!Array.isArray(value)) return null;
  return [
    ...new Set(
      value.filter(
        (capability): capability is RoomCapability =>
          typeof capability === 'string' &&
          STANDARD_GRANT_CAPABILITIES.has(capability as RoomCapability),
      ),
    ),
  ];
}

function handleOperatorGrant(data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop frames not arriving via hostConn. Without this, a peer can inject
  // {type:'operator-grant'} to flip the target's
  // network.isOperator=true client-side. Host-side verifyOperator in sync.ts
  // blocks actual privilege escalation, but the UI flip exposes OP
  // controls and shows a fake "OP granted" toast — sociotechnical confusion
  // + potential request flood as the user clicks newly-visible OP actions.
  // Apply the same trust-boundary rule as SYNC_PONG.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  // PRO controller authority comes from the authenticated room snapshot, not
  // legacy operator frames. Ratchet the compatibility flag back to true if a
  // stale frame/state ever reaches this path, without showing a misleading
  // grant/revoke toast.
  if (getRoomContext().kind === 'pro') {
    setState('network.isOperator', true);
    bus.emit('ui:play-btn-state', true);
    bus.emit('network:role-badge-update');
    return;
  }

  const wasOperator = getState('network.isOperator');
  const capabilities = normalizeStandardGrantCapabilities(data.capabilities);
  const isOwnerProjection = capabilities?.includes('room.configure') === true;
  setState('network.standardRoomCapabilities', capabilities);
  setState('network.isOperator', true);
  // `silent` was added compatibly: older hosts omit it, so transition
  // de-duplication remains the fallback during a rolling deployment. Current
  // hosts mark bootstrap/identity/capability projections silent and reserve
  // an unsilenced false -> true transition for a real room-owner grant.
  if (!wasOperator && data.silent !== true && !isOwnerProjection) {
    showToast(t('network.op_granted'));
  }
  bus.emit('ui:play-btn-state', true);
  bus.emit('network:role-badge-update');
}

function handleOperatorRevoke(data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop frames not arriving via hostConn. Without this, a peer can revoke
  // a legitimate OP guest's privileges client-side
  // (UI flip + fake "OP revoked" toast). Host still has the authoritative
  // OP list in connectedPeers, so requests would still authenticate, but
  // the user loses access to OP UI and is misled about their state. Apply the
  // same trust-boundary rule as handleOperatorGrant.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  if (getRoomContext().kind === 'pro') {
    setState('network.isOperator', true);
    bus.emit('ui:play-btn-state', true);
    bus.emit('network:role-badge-update');
    return;
  }

  const wasOperator = getState('network.isOperator');
  const wasOwnerProjection =
    getState('network.standardRoomCapabilities')?.includes('room.configure') === true;
  setState('network.standardRoomCapabilities', null);
  setState('network.isOperator', false);
  bus.emit('settings-sync:authority-revoked');
  // Always fail closed first. The toast belongs only to a real administrator
  // transition, not an ordinary guest's repeated projection or a transient
  // identity lease expiry that the refresh loop can restore.
  if (wasOperator && data.silent !== true && !wasOwnerProjection) {
    showToast(t('network.op_revoked'));
  }
  bus.emit('ui:play-btn-state', false);
  bus.emit('network:role-badge-update');
}

function handleKickDeviceMsg(_data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop frames not arriving via hostConn. Without this, a malicious guest
  // can send {type:'kick-device'} to the host — the bus.emit below triggers
  // setup.ts, which schedules a blocking hard reset. A single raw frame from
  // any session participant must never terminate the host's whole session.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;
  setState('network.isIntentionalDisconnect', true);
  bus.emit('network:kicked-explicitly');
}

function handleOperatorToast(data: Record<string, unknown>, conn?: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn || !getState('network.isOperator')) return;

  const params =
    data.i18nParams && typeof data.i18nParams === 'object' && !Array.isArray(data.i18nParams)
      ? (data.i18nParams as Record<string, string | number>)
      : undefined;
  if (typeof data.i18nKey === 'string') {
    const translated = t(data.i18nKey as I18nKey, params);
    // t() returns the raw key on dictionary miss — fall through to the
    // host-provided text fallback so OP guests on an older bundle render
    // a readable message instead of leaking the key string.
    if (translated !== data.i18nKey) {
      showToast(translated);
      return;
    }
  }
  if (typeof data.text === 'string') showToast(data.text);
}

// ─── Init Guest Protocol Handlers ─────────────────────────────────

export function initGuestProtocolHandlers(): void {
  registerHandlers({
    [MSG.WELCOME]: handleWelcome,
    [MSG.SESSION_FULL]: handleSessionFull,
    [MSG.DEVICE_LIST_UPDATE]: handleDeviceListUpdateMsg,
    [MSG.FORCE_CLOSE_DUPLICATE]: handleForceCloseDuplicate,
    [MSG.OPERATOR_GRANT]: handleOperatorGrant,
    [MSG.OPERATOR_REVOKE]: handleOperatorRevoke,
    [MSG.OPERATOR_TOAST]: handleOperatorToast,
    [MSG.KICK_DEVICE]: handleKickDeviceMsg,
  });

  bus.on('network:request-kick-standard-room-member', ({ memberId }) => {
    const hostConn = getState('network.hostConn') as DataConnection | null;
    if (
      getRoomContext().kind !== 'standard' ||
      !hostConn?.open ||
      !hasRoomCapability('members.manage') ||
      !memberId
    ) {
      return;
    }

    const target = getState('network.lastKnownDeviceList')?.find((device) => {
      const authorityKey =
        device.isAuthenticated === true && device.memberId ? device.memberId : `peer:${device.id}`;
      return authorityKey === memberId && !device.isHost && device.status === 'connected';
    });
    if (!target?.id) return;

    safeSend(hostConn, {
      type: MSG.REQUEST_KICK_DEVICE,
      targetPeerId: target.id,
    });
  });

  bus.on('network:request-kick-standard-room-device', ({ peerId }) => {
    const hostConn = getState('network.hostConn') as DataConnection | null;
    if (
      getRoomContext().kind !== 'standard' ||
      !hostConn?.open ||
      !hasRoomCapability('members.manage') ||
      !peerId
    ) {
      return;
    }

    const target = getState('network.lastKnownDeviceList')?.find(
      (device) => device.id === peerId && !device.isHost && device.status === 'connected',
    );
    if (!target) return;

    safeSend(hostConn, {
      type: MSG.REQUEST_KICK_PHYSICAL_DEVICE,
      targetPeerId: peerId,
    });
  });

  log.info('[Guest] Protocol handlers registered');
}

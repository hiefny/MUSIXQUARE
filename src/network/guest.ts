/**
 * MUSIXQUARE 3.0 — Guest-Side Peer Connection Logic
 *
 * Manages: outgoing connection to host, reconnect retry, guest protocol handlers
 * (welcome, session full, device list, operator, kick, force-close-duplicate).
 *
 * Imports from peer-state.ts (leaf) only — never from peer.ts.
 * Uses late-bound import for initNetwork (from peer.ts) to avoid circular deps.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { registerHandlers } from './protocol.ts';
import type { DataConnection, DeviceInfo } from '../types/index.ts';

import {
  getPeer,
  detectConnectionType,
} from './peer-state.ts';
import { showToast } from '../ui/toast.ts';

// ─── Late-bound initNetwork (avoids circular peer.ts ↔ guest.ts) ───

let _initNetwork: ((requestedId: string | null) => Promise<string>) | null = null;

/** Called by peer.ts during bootstrap to inject initNetwork reference. */
export function setInitNetwork(fn: (requestedId: string | null) => Promise<string>): void {
  _initNetwork = fn;
}

// ─── Guest: Join Session ────────────────────────────────────────────

/**
 * Connect to a host session as a guest.
 */
export function joinSession(hostId: string, retryAttempt = 0): void {
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
    try { hostConn.close(); } catch { /* noop */ }
    setState('network.hostConn', null);
  }

  // ── Reconnect cleanup ──
  // H-3: Close stale upstream relay — prevents old relay session from pumping
  // data into a new session context after reconnection.
  const staleRelay = getState('relay.upstreamDataConn');
  if (staleRelay) {
    try { staleRelay.close(); } catch { /* noop */ }
    setState('relay.upstreamDataConn', null);
  }

  // M-2: Clear ICE detection timers from previous connection — prevents stale
  // timers from overwriting the new connection's ICE classification.
  clearManagedTimer('guest-ice-detect');
  clearManagedTimer('guest-ice-redetect');

  if (!hostId) {
    bus.emit('network:error', new Error('NO_HOST_ID'));
    return;
  }

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
      bus.emit('network:error', new Error('NETWORK_INIT_FAILED'));
      return;
    }
    if (!_initNetwork) {
      setState('network.isConnecting', false);
      bus.emit('network:error', new Error('NETWORK_INIT_FAILED'));
      return;
    }
    _initNetwork(null)
      .then(() => joinSession(hostId, retryAttempt + 1))
      .catch((e) => {
        log.error('[Join] Failed to init peer', e);
        setState('network.isConnecting', false);
        bus.emit('network:error', new Error('NETWORK_INIT_FAILED'));
      });
    return;
  }

  if (!peer.open) {
    if (retryAttempt < 10) {
      setManagedTimer('join-retry', () => joinSession(hostId, retryAttempt + 1), 300);
    } else {
      setState('network.isConnecting', false);
      bus.emit('network:error', new Error('PEER_NOT_READY'));
    }
    return;
  }

  let conn: DataConnection;
  try {
    const channelMode = getState('audio.channelMode');
    conn = peer.connect(hostId, {
      reliable: true,
      metadata: { label: `mode-${channelMode}` },
    });
  } catch (e) {
    log.error('[Join] peer.connect failed', e);
    setState('network.isConnecting', false);
    bus.emit('network:error', new Error('CONNECT_FAILED'));
    return;
  }

  // Own flag — don't trust conn.open (PeerJS can set it true before 'open' event fires)
  let dataChannelOpened = false;

  // Register data handler BEFORE 'open' to avoid missing early messages
  // (e.g. WELCOME sent by host in its own 'open' handler).
  // Same pattern as relay.ts:247.
  conn.on('data', (data: unknown) => {
    bus.emit('network:data', data, conn);
  });

  // Timeout if host is unreachable (15s to allow TURN relay negotiation)
  setManagedTimer('join-timeout', () => {
    if (dataChannelOpened || getState('network.hostConn')) return;
    log.warn('[Join] Connection timeout — data channel did not open in 15s');
    try { conn.close(); } catch { /* noop */ }
    setState('network.isConnecting', false);
    bus.emit('network:error', new Error('HOST_UNREACHABLE'));
  }, 15000);

  conn.on('open', () => {
    dataChannelOpened = true;
    clearManagedTimer('join-timeout');
    log.info('[Join] Connected to host:', hostId);

    setState('network.hostConn', conn);
    setState('network.isConnecting', false);

    // close/error handlers are intentionally inside 'open' callback:
    // Before 'open' fires, the join-timeout timer handles failures.
    // Registering them here avoids premature cleanup from PeerJS
    // internal close events that can fire before the channel opens.
    (conn as unknown as Record<string, unknown>)._errorHandled = false;

    conn.on('close', () => {
      log.warn('[Join] Host connection closed');
      // Only clear hostConn if WE are still the current connection.
      // Prevents old conn's async close from nullifying a new connection.
      if (getState('network.hostConn') === conn) {
        setState('network.hostConn', null);
      }
      setState('network.isConnecting', false);

      if ((conn as unknown as Record<string, unknown>)._errorHandled) {
        // Don't reset isIntentionalDisconnect — the error handler already
        // determined intent. Resetting unconditionally here would mask
        // intentional disconnects (e.g. leaveSession) that race with close.
        return;
      }
      (conn as unknown as Record<string, unknown>)._errorHandled = true;

      const isIntentional = getState('network.isIntentionalDisconnect');
      if (!isIntentional) {
        bus.emit('network:error', new Error('HOST_DISCONNECTED'));
      }
      setState('network.isIntentionalDisconnect', false);
    });

    conn.on('error', (err: unknown) => {
      log.error('[Join] Host connection error', err);
      if (getState('network.hostConn') === conn) {
        setState('network.hostConn', null);
      }
      setState('network.isConnecting', false);

      if ((conn as unknown as Record<string, unknown>)._errorHandled) return;
      (conn as unknown as Record<string, unknown>)._errorHandled = true;

      bus.emit('network:error', new Error('HOST_CONNECTION_ERROR'));
    });

    // Start unified sync timer (replaces separate heartbeat + ping timers)
    bus.emit('worker:sync-command', { command: 'START_TIMER', id: 'sync', interval: 1000 });

    // Detect local vs remote connection after ICE stabilizes.
    // 1s is enough for LAN (host→host pair succeeds ~300-500ms).
    setManagedTimer('guest-ice-detect', async () => {
      const type = await detectConnectionType(conn);
      setState('network.connectionType', type);
      log.info(`[Peer] Connection type: ${type}`);
      bus.emit('network:role-badge-update');

      // Re-detect after 10s from connection open if classified as 'remote'
      // (ICE may not have stabilized at 1s for STUN/TURN)
      if (type === 'remote' && conn.open) {
        setManagedTimer('guest-ice-redetect', async () => {
          if (!conn.open) return;
          const recheck = await detectConnectionType(conn);
          if (recheck === 'local' && getState('network.connectionType') !== 'local') {
            setState('network.connectionType', 'local');
            log.info('[Peer] Reclassified as local on re-detection');
            bus.emit('network:role-badge-update');
          }
        }, 9000); // 1s + 9s = 10s from connection open
      }
    }, 1000);

    bus.emit('network:peer-connected', conn);
    bus.emit('setup:guest-join-success');
  });
}

// ─── Guest Protocol Handlers ──────────────────────────────────────

function handleWelcome(data: Record<string, unknown>): void {
  if (data.label) {
    setState('network.myDeviceLabel', String(data.label));
  }
  // Sync chat moderation state from host (always set, even when false/0)
  setState('network.chatFrozen', !!data.chatFrozen);
  setState('network.slowmodeSeconds', typeof data.slowmodeSeconds === 'number' ? data.slowmodeSeconds : 0);
  setState('network.filterEnabled', !!data.filterEnabled);
  bus.emit('network:role-badge-update');
}

function handleSessionFull(data: Record<string, unknown>): void {
  const msg = data.message ? String(data.message) : t('network.session_full');

  setState('network.isIntentionalDisconnect', true);

  const hostConn = getState('network.hostConn');
  if (hostConn) {
    try { hostConn.close(); } catch { /* noop */ }
    setState('network.hostConn', null);
  }
  setState('network.isConnecting', false);
  bus.emit('network:role-badge-update');
  bus.emit('network:session-full', msg);
}

function handleDeviceListUpdateMsg(data: Record<string, unknown>): void {
  const list = Array.isArray(data.list) ? data.list as DeviceInfo[] : [];

  const myId = getState('network.myId');
  const hostConn = getState('network.hostConn');

  if (hostConn && myId) {
    const amIStillConnected = list.find(p => p && p.id === myId);
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
    const hostConnType = (amIStillConnected as unknown as Record<string, unknown>).connectionType as string | undefined;
    if (hostConnType && hostConnType !== 'unknown') {
      setState('network.connectionType', hostConnType as 'local' | 'remote' | 'unknown');
      bus.emit('network:role-badge-update');
    }
  }

  setState('network.lastKnownDeviceList', list);
  bus.emit('network:device-list-update', list);
}

function handleForceCloseDuplicate(): void {
  log.warn('[Guest] Received force-close-duplicate — connection will close');
  // Mark as intentional so the close handler doesn't show HOST_DISCONNECTED error
  setState('network.isIntentionalDisconnect', true);
}

function handleOperatorGrant(): void {
  setState('network.isOperator', true);
  showToast(t('network.op_granted'));
  bus.emit('ui:play-btn-state', true);
  bus.emit('network:role-badge-update');
}

function handleOperatorRevoke(): void {
  setState('network.isOperator', false);
  showToast(t('network.op_revoked'));
  bus.emit('ui:play-btn-state', false);
  bus.emit('network:role-badge-update');
}

function handleKickDeviceMsg(): void {
  setState('network.isIntentionalDisconnect', true);
  bus.emit('network:kicked-explicitly');
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
    [MSG.KICK_DEVICE]: handleKickDeviceMsg,
  });

  // Guest: rename device → send request to host
  bus.on('network:rename-device', (newName: string) => {
    const hostConn = getState('network.hostConn') as DataConnection | null;
    if (!hostConn) return; // Only guests (who have a hostConn) use this path
    try {
      hostConn.send({ type: MSG.REQUEST_RENAME, newLabel: newName });
    } catch { /* ignore */ }
    // Optimistic local update
    setState('network.myDeviceLabel', newName);
  });

  log.info('[Guest] Protocol handlers registered');
}

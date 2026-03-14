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

  if (!hostId) {
    bus.emit('network:error', new Error('NO_HOST_ID'));
    return;
  }

  setState('network.lastJoinCode', hostId);

  // Set connecting state on initial call (callers must NOT pre-set this)
  if (retryAttempt === 0) {
    setState('network.isConnecting', true);
  }

  const peer = getPeer();

  // Ensure peer exists and is open
  if (!peer) {
    if (retryAttempt > 3) {
      bus.emit('network:error', new Error('NETWORK_INIT_FAILED'));
      return;
    }
    if (!_initNetwork) {
      bus.emit('network:error', new Error('NETWORK_INIT_FAILED'));
      return;
    }
    _initNetwork(null)
      .then(() => joinSession(hostId, retryAttempt + 1))
      .catch((e) => {
        log.error('[Join] Failed to init peer', e);
        bus.emit('network:error', new Error('NETWORK_INIT_FAILED'));
      });
    return;
  }

  if (!peer.open) {
    if (retryAttempt < 10) {
      setManagedTimer('join-retry', () => joinSession(hostId, retryAttempt + 1), 300);
    } else {
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
      setState('network.hostConn', null);
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
      setState('network.hostConn', null);
      setState('network.isConnecting', false);

      if ((conn as unknown as Record<string, unknown>)._errorHandled) return;
      (conn as unknown as Record<string, unknown>)._errorHandled = true;

      bus.emit('network:error', new Error('HOST_CONNECTION_ERROR'));
    });

    // Start heartbeat & ping timers for guest
    bus.emit('worker:sync-command', { command: 'START_TIMER', id: 'heartbeat', interval: 1000 });
    bus.emit('worker:sync-command', { command: 'START_TIMER', id: 'ping', interval: 2000 });

    // Detect local vs remote connection after ICE stabilizes
    setManagedTimer('guest-ice-detect', async () => {
      const type = await detectConnectionType(conn);
      setState('network.connectionType', type);
      log.info(`[Peer] Connection type: ${type}`);
      bus.emit('network:role-badge-update');

      // Re-detect after 10s if classified as 'remote' (ICE may not have stabilized at 1.5s)
      if (type === 'remote' && conn.open) {
        setManagedTimer('guest-ice-redetect', async () => {
          if (!conn.open) return;
          const recheck = await detectConnectionType(conn);
          if (recheck === 'local' && getState('network.connectionType') !== 'local') {
            setState('network.connectionType', 'local');
            log.info('[Peer] Reclassified as local on re-detection');
            bus.emit('network:role-badge-update');
          }
        }, 8500);
      }
    }, 1500);

    bus.emit('network:peer-connected', conn);
    bus.emit('setup:guest-join-success');
  });
}

// ─── Guest Protocol Handlers ──────────────────────────────────────

function handleWelcome(data: Record<string, unknown>): void {
  if (data.label) {
    setState('network.myDeviceLabel', String(data.label));
  }
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
  bus.emit('ui:show-toast', t('network.op_granted'));
  bus.emit('ui:play-btn-state', true);
  bus.emit('network:role-badge-update');
}

function handleOperatorRevoke(): void {
  setState('network.isOperator', false);
  bus.emit('ui:show-toast', t('network.op_revoked'));
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

  log.info('[Guest] Protocol handlers registered');
}

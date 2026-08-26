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
import { hasQueueAuthority } from './queue-authority.ts';
import {
  JOIN_BOOTSTRAP_TIMEOUT_MS,
  createJoinBootstrapId,
  isJoinBootstrapPayloadFrame,
} from './join-bootstrap.ts';
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

// Some PeerJS adapters can emit the host's first data frames before their
// guest-side `open` callback. Keep that ordered bootstrap window bounded, and
// publish it only after this exact connection becomes network.hostConn.
const PRE_OPEN_INBOUND_FRAME_LIMIT = 64;
const PRE_OPEN_INBOUND_BYTE_LIMIT = 512 * 1024;
const PRE_OPEN_INBOUND_MAX_DEPTH = 24;
const PRE_OPEN_INBOUND_MAX_NODES = 16_384;
const _preOpenTextEncoder = new TextEncoder();
const DEFAULT_GUEST_PRE_OPEN_TIMEOUT_MS = 10_000;
const MAX_GUEST_PRE_OPEN_TIMEOUT_MS = 15_000;

function guestPreOpenTimeoutMs(conn: DataConnection): number {
  const recommendation = conn.recommendedPreOpenTimeoutMs;
  if (typeof recommendation !== 'number' || !Number.isFinite(recommendation)) {
    return DEFAULT_GUEST_PRE_OPEN_TIMEOUT_MS;
  }
  // A provider may reserve bounded recovery time, but it cannot shorten the
  // ordinary UX or turn this application-owned deadline into an open wait.
  return Math.min(
    MAX_GUEST_PRE_OPEN_TIMEOUT_MS,
    Math.max(DEFAULT_GUEST_PRE_OPEN_TIMEOUT_MS, Math.trunc(recommendation)),
  );
}

interface PendingGuestInboundFrame {
  frame: Readonly<Record<string, unknown>>;
  bytes: number;
}

interface PendingGuestInbound {
  epoch: number;
  conn: DataConnection;
  frames: PendingGuestInboundFrame[];
  bytes: number;
}

let _pendingGuestInbound: PendingGuestInbound | null = null;

interface PreOpenEstimateContext {
  seen: WeakSet<object>;
  nodes: number;
}

function clearPendingGuestInbound(epoch?: number, conn?: DataConnection): void {
  const pending = _pendingGuestInbound;
  if (!pending) return;
  if (epoch !== undefined && pending.epoch !== epoch) return;
  if (conn !== undefined && pending.conn !== conn) return;
  pending.frames.length = 0;
  pending.bytes = 0;
  _pendingGuestInbound = null;
}

function takePendingGuestInbound(epoch: number, conn: DataConnection): PendingGuestInboundFrame[] {
  const pending = _pendingGuestInbound;
  if (!pending || pending.epoch !== epoch || pending.conn !== conn) return [];
  _pendingGuestInbound = null;
  return pending.frames;
}

function estimatePreOpenInboundBytes(
  value: unknown,
  remaining: number,
  depth: number,
  context: PreOpenEstimateContext,
): number | null {
  if (remaining < 0 || depth > PRE_OPEN_INBOUND_MAX_DEPTH) return null;
  if (value === null) return 4;
  if (typeof value === 'string') {
    const bytes = _preOpenTextEncoder.encode(value).byteLength;
    return bytes <= remaining ? bytes : null;
  }
  if (typeof value === 'number') return remaining >= 8 ? 8 : null;
  if (typeof value === 'boolean') return remaining >= 4 ? 4 : null;
  if (value === undefined) return remaining >= 1 ? 1 : null;
  if (typeof value !== 'object') return null;

  if (value instanceof ArrayBuffer) {
    return value.byteLength <= remaining ? value.byteLength : null;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength <= remaining ? value.byteLength : null;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return value.size <= remaining ? value.size : null;
  }

  if (context.seen.has(value)) return null;
  context.seen.add(value);
  context.nodes++;
  if (context.nodes > PRE_OPEN_INBOUND_MAX_NODES) return null;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return null;

  let bytes = Array.isArray(value) ? 8 : 16;
  if (bytes > remaining) return null;
  for (const [key, child] of Object.entries(value)) {
    const keyBytes = _preOpenTextEncoder.encode(key).byteLength + 4;
    if (bytes + keyBytes > remaining) return null;
    bytes += keyBytes;
    const childBytes = estimatePreOpenInboundBytes(child, remaining - bytes, depth + 1, context);
    if (childBytes === null || bytes + childBytes > remaining) return null;
    bytes += childBytes;
  }
  return bytes;
}

function snapshotPreOpenInboundFrame(data: unknown): PendingGuestInboundFrame | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof (data as Record<string, unknown>).type !== 'string') return null;

  try {
    const bytes = estimatePreOpenInboundBytes(data, PRE_OPEN_INBOUND_BYTE_LIMIT, 0, {
      seen: new WeakSet<object>(),
      nodes: 0,
    });
    if (bytes === null) return null;
    // Unlike JSON cloning, structuredClone preserves ArrayBuffer, typed-array,
    // Blob, and File payloads used by file bootstrap frames. Older Safari
    // keeps the already-decoded event payload by reference; inbound handlers
    // treat frames as immutable and the bounded queue owns that reference only
    // until the open callback drains it.
    const frame = (typeof structuredClone === 'function' ? structuredClone(data) : data) as Record<
      string,
      unknown
    >;
    return { frame: Object.freeze(frame), bytes };
  } catch {
    return null;
  }
}

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
  clearManagedTimer(`join-bootstrap-timeout-${_guestJoinEpoch}`);
  clearPendingGuestInbound();
  _guestJoinEpoch++;
}

function isCurrentGuestJoin(epoch: number): boolean {
  return epoch === _guestJoinEpoch;
}

function terminateGuestJoin(epoch: number): boolean {
  if (!isCurrentGuestJoin(epoch)) return false;
  clearPendingGuestInbound(epoch);
  clearManagedTimer(`join-bootstrap-timeout-${epoch}`);
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

  if (retryAttempt === 0) clearPendingGuestInbound();
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
  const requiresJoinBootstrap = getRoomContext().kind === 'standard';
  let bootstrapId: string | null = null;
  if (requiresJoinBootstrap) {
    try {
      bootstrapId = createJoinBootstrapId();
    } catch (error) {
      try {
        conn.close();
      } catch {
        /* noop */
      }
      setState('network.isConnecting', false);
      reportGuestConnectionFailure(error);
      return;
    }
  }
  const bootstrapTimerName = `join-bootstrap-timeout-${joinEpoch}`;
  let dataChannelOpened = false;
  let connectionEstablished = false;
  let bootstrapFrameIndex = 0;
  let welcomeReceived = false;
  let bootstrapFailed = false;
  _pendingGuestInbound = { epoch: joinEpoch, conn, frames: [], bytes: 0 };

  const completeConnection = (): void => {
    if (
      connectionEstablished ||
      (requiresJoinBootstrap &&
        (bootstrapFrameIndex !== 3 || !hasQueueAuthority(conn) || bootstrapFailed)) ||
      !isCurrentGuestJoin(joinEpoch) ||
      getState('network.hostConn') !== conn ||
      !conn.open
    ) {
      return;
    }
    clearManagedTimer(bootstrapTimerName);
    connectionEstablished = true;
    setState('network.isConnecting', false);
    startWorkerTimer('sync', 1000);
    bus.emit('sync:request-immediate-ping');
    bus.emit('network:peer-connected', conn);
    bus.emit('setup:guest-join-success');
    markProRoomTransportRecovered();
    log.info('[Join] Connection established with host:', hostId);
  };

  const failJoinBootstrap = (error: Error): void => {
    if (
      !requiresJoinBootstrap ||
      bootstrapFailed ||
      connectionEstablished ||
      !isCurrentGuestJoin(joinEpoch) ||
      getState('network.hostConn') !== conn
    ) {
      return;
    }
    bootstrapFailed = true;
    _handledConnectionErrors.add(conn);
    clearManagedTimer(bootstrapTimerName);
    if (!terminateGuestJoin(joinEpoch)) return;
    setState('network.hostConn', null);
    setState('network.isConnecting', false);
    try {
      conn.close();
    } catch {
      /* noop */
    }
    reportGuestConnectionFailure(error);
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

    if (requiresJoinBootstrap && !connectionEstablished) {
      const type =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>).type
          : null;
      if (type === MSG.WELCOME && bootstrapFrameIndex === 0 && !welcomeReceived) {
        welcomeReceived = true;
        bus.emit('network:data', data, conn);
        return;
      }
      if (type === MSG.SESSION_FULL || type === MSG.FORCE_CLOSE_DUPLICATE) {
        bus.emit('network:data', data, conn);
        return;
      }
      if (!isJoinBootstrapPayloadFrame(data, bootstrapFrameIndex)) {
        failJoinBootstrap(new Error('HOST_CONNECTION_ERROR'));
        return;
      }

      let acknowledgements = 0;
      let applied = false;
      bus.emit('network:peer-bootstrap-apply', data, conn, (success) => {
        acknowledgements += 1;
        applied = success;
      });
      if (
        acknowledgements !== 1 ||
        !applied ||
        !isCurrentGuestJoin(joinEpoch) ||
        getState('network.hostConn') !== conn ||
        !conn.open
      ) {
        failJoinBootstrap(new Error('HOST_CONNECTION_ERROR'));
        return;
      }

      bootstrapFrameIndex += 1;
      if (bootstrapFrameIndex !== 3) return;
      if (!hasQueueAuthority(conn) || bootstrapId === null) {
        failJoinBootstrap(new Error('HOST_CONNECTION_ERROR'));
        return;
      }
      if (
        !safeSend(conn, {
          type: MSG.JOIN_BOOTSTRAP_APPLIED,
          version: 1,
          bootstrapId,
        })
      ) {
        failJoinBootstrap(new Error('HOST_CONNECTION_ERROR'));
        return;
      }
      completeConnection();
      return;
    }
    bus.emit('network:data', data, conn);
  };

  conn.on('data', (data: unknown) => {
    if (!isCurrentGuestJoin(joinEpoch)) {
      clearPendingGuestInbound(joinEpoch, conn);
      return;
    }
    if (!dataChannelOpened) {
      const pending = _pendingGuestInbound;
      const snapshot = snapshotPreOpenInboundFrame(data);
      if (
        !pending ||
        pending.epoch !== joinEpoch ||
        pending.conn !== conn ||
        !snapshot ||
        pending.frames.length >= PRE_OPEN_INBOUND_FRAME_LIMIT ||
        pending.bytes + snapshot.bytes > PRE_OPEN_INBOUND_BYTE_LIMIT
      ) {
        if (!terminateGuestJoin(joinEpoch)) return;
        log.warn('[Join] Invalid or excessive data received before connection open');
        try {
          conn.close();
        } catch {
          /* noop */
        }
        setState('network.isConnecting', false);
        reportGuestConnectionFailure(new Error('HOST_CONNECTION_ERROR'));
        return;
      }
      pending.frames.push(snapshot);
      pending.bytes += snapshot.bytes;
      return;
    }
    processInboundData(data);
  });
  conn.on('error', handlePreOpenError);

  // Timeout if the host is unreachable. Only a transport with a bounded
  // fallback route may recommend extra time for its pre-open recovery stages.
  const preOpenTimeoutMs = guestPreOpenTimeoutMs(conn);
  setManagedTimer(
    'join-timeout',
    () => {
      if (!isCurrentGuestJoin(joinEpoch) || dataChannelOpened || getState('network.hostConn')) {
        return;
      }
      if (!terminateGuestJoin(joinEpoch)) return;
      log.warn(`[Join] Connection timeout — data channel did not open in ${preOpenTimeoutMs}ms`);
      try {
        conn.close();
      } catch {
        /* noop */
      }
      setState('network.isConnecting', false);
      reportGuestConnectionFailure(new Error('HOST_UNREACHABLE'));
    },
    preOpenTimeoutMs,
  );

  conn.on('open', () => {
    if (!isCurrentGuestJoin(joinEpoch)) {
      clearPendingGuestInbound(joinEpoch, conn);
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
      clearManagedTimer(bootstrapTimerName);
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
      clearManagedTimer(bootstrapTimerName);
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

    // Preserve the host's initial wire order. WELCOME and the playlist/effect
    // bootstrap can all arrive before this callback on fast or resumed data
    // channels. They must pass through the same exact-connection trust gate as
    // ordinary post-open frames.
    const pendingFrames = takePendingGuestInbound(joinEpoch, conn);
    for (const { frame } of pendingFrames) {
      if (!isCurrentGuestJoin(joinEpoch) || getState('network.hostConn') !== conn || !conn.open) {
        break;
      }
      processInboundData(frame);
    }

    if (
      !isCurrentGuestJoin(joinEpoch) ||
      getState('network.hostConn') !== conn ||
      !conn.open ||
      getState('network.isIntentionalDisconnect')
    ) {
      return;
    }

    if (requiresJoinBootstrap) {
      if (bootstrapId === null) {
        failJoinBootstrap(new Error('HOST_CONNECTION_ERROR'));
        return;
      }
      setManagedTimer(
        bootstrapTimerName,
        () => failJoinBootstrap(new Error('HOST_CONNECTION_ERROR')),
        JOIN_BOOTSTRAP_TIMEOUT_MS,
      );
      if (
        !safeSend(conn, {
          type: MSG.JOIN_BOOTSTRAP_HELLO,
          version: 1,
          bootstrapId,
        })
      ) {
        failJoinBootstrap(new Error('HOST_CONNECTION_ERROR'));
        return;
      }
    } else {
      completeConnection();
    }

    // Detect local vs remote connection. The detectConnectionType function
    // now internally polls until ICE stabilizes (up to 10 seconds).
    detectConnectionType(conn)
      .then((type) => {
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
      })
      .catch((error) => {
        log.warn('[Guest] Initial ICE detection failed', error);
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
  // Standard WELCOME starts a guest with isOp=false; a PRO compatibility
  // endpoint's authority came from the authenticated room snapshot and must not be
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

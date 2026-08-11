/**
 * MUSIXQUARE — WebRTC Transport Coordinator
 *
 * Orchestrates: network initialization, transport event wiring, session cleanup.
 * Re-exports public API from peer-state.ts, host.ts, guest.ts so that
 * external imports from '../network/peer.ts' continue to work unchanged.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState, batchSetState } from '../core/state.ts';
import { scheduleSessionReset } from '../core/session-reset.ts';
import { deactivateNoSleep } from '../core/wake-lock.ts';
import { showDialog } from '../ui/dialog.ts';
import { MAX_GUEST_SLOTS, TRANSFER_STATE, PLAYBACK_STATE } from '../core/constants.ts';
import { clearAllManagedTimers, clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { stopWorkerTimer } from './sync-worker.ts';
import type { DataConnection, AnyProtocolMsg, PeerInstance } from '../types/index.ts';
import { getRuntimeTransportConfig } from './transport/config.ts';
import { createTransportPeer, type TransportPeerOptions } from './transport/index.ts';
import type { TransportBackgroundRecoveryResult } from './transport/types.ts';
import { setPlaybackIdle } from '../player/ownership.ts';
import {
  requestProRoomLeave,
  requestProRoomSignalingReconnect,
} from '../pro-room/lifecycle-hook.ts';
import { isProRoomCode } from '../pro-room/room-code.ts';
import { requestProRoomTransportRecovery } from '../pro-room/transport-recovery.ts';
import {
  resetGuestSystemAudioShareRoute,
  resetLocalSystemAudioSfuCapabilities,
} from './system-audio-delivery.ts';
import { requestStandardRoomAccountAssertion } from '../account/room-identity.ts';
import { clearCurrentAccountLoginReturn } from '../account/login-return.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { getStandardRoomTurnCredentials } from './standard-room-prerequisites.ts';
import {
  canRecoverSignalingInPlace,
  publishSignalingExhausted,
  publishSignalingReconnectAttempt,
  publishSignalingRecovered,
  resetSignalingHealth,
  SIGNALING_RECOVERY_MAX_ATTEMPTS,
} from './signaling-health.ts';

// ─── Sub-module imports (only names used locally in this file) ───────

import {
  getPeer,
  setPeer,
  generateSessionCode,
  broadcast,
  broadcastExcept,
  broadcastDeviceList,
  cancelConnectionTypeWaiters,
} from './peer-state.ts';

import { handleHostIncomingConnection } from './host.ts';
import { setInitNetwork, initGuestProtocolHandlers, invalidateGuestJoinAttempt } from './guest.ts';

// ─── Re-exports (preserves external import surface) ─────────────────

export {
  broadcast,
  broadcastDeviceList,
  safeSend,
  sendToHost,
  canSendFileTo,
  filterEligiblePeers,
  isRemoteGuest,
  waitForGuestConnectionType,
} from './peer-state.ts';

export { joinSession } from './guest.ts';

type SystemAudioCallType =
  | 'system-audio'
  | 'system-audio-dual'
  | 'system-audio-stereo'
  | 'system-audio-synced';

type IncomingMediaConnection = {
  peer?: string;
  metadata?: Record<string, unknown>;
  close: () => void;
};

const SYSTEM_AUDIO_CALL_TYPES = new Set<string>([
  'system-audio',
  'system-audio-dual',
  'system-audio-stereo',
  'system-audio-synced',
]);

function isSystemAudioCallType(type: unknown): type is SystemAudioCallType {
  return typeof type === 'string' && SYSTEM_AUDIO_CALL_TYPES.has(type);
}

export function isTrustedSystemAudioMediaCall(mediaConn: {
  peer?: string;
  metadata?: Record<string, unknown>;
}): boolean {
  if (!isSystemAudioCallType(mediaConn.metadata?.type)) return false;

  const hostConn = getState('network.hostConn');
  return !!hostConn && typeof mediaConn.peer === 'string' && mediaConn.peer === hostConn.peer;
}

function closeIncomingMediaCall(mediaConn: IncomingMediaConnection): void {
  try {
    mediaConn.close();
  } catch {
    /* noop */
  }
}

function getSystemAudioCallChannel(
  type: SystemAudioCallType,
  metadata?: Record<string, unknown>,
): string {
  if (type === 'system-audio-dual') return 'DUAL';
  if (type === 'system-audio-stereo') return 'STEREO';
  if (type === 'system-audio-synced') return 'SYNCED';
  return (metadata?.channel as string) || 'L';
}

// ─── SDP Utils ──────────────────────────────────────────────────────

/**
 * Munge SDP to force Opus codec into high-fidelity stereo mode.
 * Fixes Chrome's tendency to downmix to 1-channel mono and limit bitrate.
 */
export function forceStereoSdp(sdp: string): string {
  let modified = sdp;
  const stereoParams = ['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000', 'useinbandfec=1'];

  // 1. Find opus payload types
  const opusPTs: string[] = [];
  const rtpmapRegex = /a=rtpmap:(\d+) opus\/48000\/2/g;
  let match;
  while ((match = rtpmapRegex.exec(sdp)) !== null) {
    opusPTs.push(match[1]);
  }

  // 2. Add/replace stereo params to ALL fmtp lines for these PTs
  for (const pt of opusPTs) {
    let foundFmtp = false;
    const fmtpRegex = new RegExp(`^a=fmtp:${pt}(?:(?:\\s+|;)([^\\r\\n]*))?$`, 'gm');
    modified = modified.replace(fmtpRegex, (_line, params: string | undefined) => {
      foundFmtp = true;
      const preservedParams = (params || '')
        .split(';')
        .map((param) => param.trim())
        .filter(Boolean)
        .filter((param) => !/^(stereo|sprop-stereo|maxaveragebitrate|useinbandfec)=/i.test(param));

      return `a=fmtp:${pt} ${[...preservedParams, ...stereoParams].join('; ')}`;
    });

    if (!foundFmtp) {
      // If no fmtp line exists, append it after the rtpmap line
      const rtpmapLine = new RegExp(`a=rtpmap:${pt} opus/48000/2`);
      modified = modified.replace(rtpmapLine, (line) => {
        return line + `\r\na=fmtp:${pt} ${stereoParams.join('; ')}`;
      });
    }
  }
  return modified;
}

// ─── TURN Config Helpers ────────────────────────────────────────────

interface NetworkInitOwner {
  epoch: number;
  requestedId: string | null;
  controller: AbortController;
  peer: PeerInstance | null;
  peerOpenSettled: boolean;
}

let _networkInitEpoch = 0;
let _activeNetworkInit: NetworkInitOwner | null = null;

function createNetworkInitCancelledError(cause?: unknown): Error {
  return cause === undefined
    ? new Error('NETWORK_INIT_CANCELLED')
    : new Error('NETWORK_INIT_CANCELLED', { cause });
}

function beginNetworkInit(requestedId: string | null): NetworkInitOwner {
  // A second setup attempt owns the singleton transport from this point on.
  // Abort is synchronous, so an older peer-open waiter settles before the new
  // attempt installs its own page-global timeout.
  _activeNetworkInit?.controller.abort();

  const owner: NetworkInitOwner = {
    epoch: ++_networkInitEpoch,
    requestedId,
    controller: new AbortController(),
    peer: null,
    peerOpenSettled: false,
  };
  _activeNetworkInit = owner;
  return owner;
}

function invalidateNetworkInit(): void {
  _networkInitEpoch++;
  _activeNetworkInit?.controller.abort();
  _activeNetworkInit = null;
}

function isNetworkInitStillActive(owner: NetworkInitOwner): boolean {
  if (
    owner.controller.signal.aborted ||
    owner.epoch !== _networkInitEpoch ||
    _activeNetworkInit !== owner
  ) {
    return false;
  }

  const appRole = getState('network.appRole');
  if (owner.requestedId) return appRole === 'host';
  return appRole === 'guest' && getState('network.isConnecting');
}

function assertNetworkInitStillActive(owner: NetworkInitOwner): void {
  if (!isNetworkInitStillActive(owner)) {
    throw createNetworkInitCancelledError();
  }
}

function waitForPeerOpen(peer: PeerInstance, owner: NetworkInitOwner): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearManagedTimer('peer-open-timeout');
      owner.controller.signal.removeEventListener('abort', onAbort);
      peer.off('open', onOpen);
      peer.off('error', onError);
    };
    const settleError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onOpen = (id: string) => {
      if (settled) return;
      if (!isNetworkInitStillActive(owner) || getPeer() !== peer) {
        settleError(createNetworkInitCancelledError());
        return;
      }
      // From this exact event onward, setupPeerEvents owns subsequent peer
      // errors. Before it, the init promise is the single error owner.
      owner.peerOpenSettled = true;
      settled = true;
      cleanup();
      resolve(id);
    };
    const onError = (err: unknown) => settleError(err);
    const onAbort = () => settleError(createNetworkInitCancelledError());

    peer.on('open', onOpen);
    peer.on('error', onError);
    owner.controller.signal.addEventListener('abort', onAbort, { once: true });

    // A transport may be locally ready before initNetwork attaches this
    // waiter. The facade must tolerate either timing so setup never waits
    // forever.
    if (peer.open && peer.id) {
      onOpen(peer.id);
      return;
    }
    if (!isNetworkInitStillActive(owner)) {
      onAbort();
      return;
    }

    setManagedTimer('peer-open-timeout', () => onError(new Error('PEER_OPEN_TIMEOUT')), 15000);
  });
}

// ─── Network Initialization ─────────────────────────────────────────

/**
 * Initialize the configured WebRTC transport with optional requested ID.
 * Returns the assigned peer ID.
 */
async function initNetwork(requestedId: string | null = null): Promise<string> {
  // Client feature advertisements are authenticated by the exact live data
  // connection. A newly-created transport must negotiate them again even if
  // the room code or peer IDs happen to be reused.
  resetLocalSystemAudioSfuCapabilities();
  resetGuestSystemAudioShareRoute();
  const owner = beginNetworkInit(requestedId);
  let ownedPeer: PeerInstance | null = null;

  // Clean up existing peer instance
  const oldPeer = getPeer();
  if (oldPeer) {
    // Revoke singleton ownership before destroy(), since some adapters emit
    // error/disconnected synchronously while being torn down.
    setPeer(null);
    try {
      oldPeer.destroy();
    } catch {
      /* noop */
    }
  }

  try {
    // ICE servers: STUN always, TURN via the Cloudflare app Worker.
    const isE2eBuild = import.meta.env.MODE === 'e2e';
    const iceServers: RTCIceServer[] = isE2eBuild
      ? []
      : [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];

    const transportConfig = getRuntimeTransportConfig();
    const canClaimWhileTurnLoads =
      !isE2eBuild && requestedId !== null && transportConfig.provider === 'cloudflare';
    const turnCredentialsRequest = isE2eBuild
      ? Promise.resolve(null)
      : getStandardRoomTurnCredentials(owner.controller.signal);

    if (canClaimWhileTurnLoads) {
      // Claim the random room at the signaling edge while capability/TURN is
      // loading. The transport gate below prevents even a guessed-code offer
      // from constructing RTCPeerConnection with the provisional STUN list.
      void turnCredentialsRequest.catch(() => undefined);
      const peerOpts: TransportPeerOptions = {
        debug: 2,
        provider: transportConfig.provider,
        signalingUrl: transportConfig.signalingUrl,
        peerJsServer: transportConfig.peerJsServer,
        config: {
          iceServers: [...iceServers],
          bundlePolicy: 'max-bundle',
        },
        deferRtcUntilConfigured: true,
        standardRoomAssertionProvider: requestStandardRoomAccountAssertion,
      };

      assertNetworkInitStillActive(owner);
      log.info(`[Network] Initializing ${transportConfig.provider} transport`);
      const newPeer = await createTransportPeer(requestedId, peerOpts);
      ownedPeer = newPeer;
      assertNetworkInitStillActive(owner);
      owner.peer = newPeer;
      setPeer(newPeer);
      setupPeerEvents(newPeer);

      const peerOpenRequest = waitForPeerOpen(newPeer, owner);
      const rtcConfigurationRequest = turnCredentialsRequest.then((turnCredentials) => {
        assertNetworkInitStillActive(owner);
        if (turnCredentials) {
          iceServers.push(...turnCredentials.iceServers);
          log.info(
            `[Network] TURN ICE servers loaded (${turnCredentials.provider}) via ${turnCredentials.source}`,
          );
        } else {
          log.warn(
            '[Network] TURN config unavailable ??STUN only (P2P will likely fail behind symmetric NAT)',
          );
        }
        if (!newPeer.setRtcConfiguration) {
          throw new Error('RTC_CONFIGURATION_GATE_UNAVAILABLE');
        }
        newPeer.setRtcConfiguration({
          iceServers: [...iceServers],
          bundlePolicy: 'max-bundle',
        });
      });
      const [id] = await Promise.all([peerOpenRequest, rtcConfigurationRequest]);

      assertNetworkInitStillActive(owner);
      if (getPeer() !== newPeer || !newPeer.open || newPeer.destroyed || newPeer.disconnected) {
        throw new Error('PEER_NOT_OPEN_AFTER_PREREQUISITES');
      }
      setState('network.myId', id);
      log.info('[Network] Peer opened:', id);
      bus.emit('network:peer-ready', id);
      return id;
    }

    assertNetworkInitStillActive(owner);
    const turnCredentials = await turnCredentialsRequest;
    assertNetworkInitStillActive(owner);
    if (turnCredentials) {
      iceServers.push(...turnCredentials.iceServers);
      log.info(
        `[Network] TURN ICE servers loaded (${turnCredentials.provider}) via ${turnCredentials.source}`,
      );
    } else {
      log.warn(
        '[Network] TURN config unavailable — STUN only (P2P will likely fail behind symmetric NAT)',
      );
    }

    const peerOpts: TransportPeerOptions = {
      debug: 2,
      provider: transportConfig.provider,
      signalingUrl: transportConfig.signalingUrl,
      peerJsServer: transportConfig.peerJsServer,
      config: {
        iceServers,
        bundlePolicy: 'max-bundle',
      },
      standardRoomAssertionProvider: requestStandardRoomAccountAssertion,
    };

    assertNetworkInitStillActive(owner);
    log.info(`[Network] Initializing ${transportConfig.provider} transport`);
    const newPeer = await createTransportPeer(requestedId, peerOpts);
    ownedPeer = newPeer;
    assertNetworkInitStillActive(owner);
    owner.peer = newPeer;
    setPeer(newPeer);
    setupPeerEvents(newPeer);

    // Cancellation owns an explicit rejection path: destroy() is not required
    // to emit an error, and setup cancellation also clears the timeout.
    const id = await waitForPeerOpen(newPeer, owner);

    assertNetworkInitStillActive(owner);
    setState('network.myId', id);
    log.info('[Network] Peer opened:', id);
    bus.emit('network:peer-ready', id);
    return id;
  } catch (error) {
    // Settle the sibling TURN/peer-open branch immediately. In particular,
    // Promise.all may reject before peer-open and its managed timeout would
    // otherwise survive this failed initialization for up to 15 seconds.
    owner.controller.abort(error);
    if (ownedPeer && getPeer() === ownedPeer) setPeer(null);
    try {
      if (ownedPeer && !ownedPeer.destroyed) ownedPeer.destroy();
    } catch {
      /* noop */
    }
    throw error;
  } finally {
    if (_activeNetworkInit === owner) _activeNetworkInit = null;
  }
}

// Inject initNetwork into guest.ts (late binding to avoid circular dep)
setInitNetwork(initNetwork);

// ─── Session Code ───────────────────────────────────────────────────

/**
 * Create a host session with a short 6-digit code.
 * Retries up to maxAttempts if ID is taken.
 */
export async function createHostSessionWithShortCode(maxAttempts = 12): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateSessionCode();
    try {
      await initNetwork(code);
      return code;
    } catch (err) {
      if (err && typeof err === 'object' && (err as Record<string, unknown>).type === 'id-taken') {
        continue;
      }
      throw err;
    }
  }
  throw new Error('SESSION_CODE_UNAVAILABLE');
}

// ─── Transport Event Setup ──────────────────────────────────────────

// ─── Signaling Reconnect ────────────────────────────────────────────
//
// Some transports do not auto-reconnect to their signaling server when the
// WebSocket drops — the application has to call reconnect() manually. Without this,
// a brief network blip leaves the peer stuck disconnected: existing data
// channels keep working (they're direct WebRTC) but new peers can't join
// because the signaling handshake is unavailable.
//
// We retry with exponential backoff. Each retry checks `peer.disconnected`
// before calling reconnect() — if a prior attempt already succeeded (or
// the user left the session), we bail and reset the counter.
//
// Backoff total: 1+2+4+8+15 = 30s across 5 attempts. After that an active,
// recoverable room keeps its existing channels/media and exposes the failed
// signaling state in Connect. A guest with no surviving room surface still
// falls through to the lost-session dialog below.
let _reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = SIGNALING_RECOVERY_MAX_ATTEMPTS;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

async function performScheduledPeerReconnect(expectedPeer: PeerInstance): Promise<void> {
  let peer = getPeer();
  if (!peer || peer !== expectedPeer || peer.destroyed) {
    _reconnectAttempts = 0;
    return;
  }
  if (!peer.disconnected) {
    log.info('[Transport] Already reconnected before scheduled attempt');
    publishSignalingRecovered();
    _reconnectAttempts = 0;
    return;
  }

  const proRoom =
    getState('room.context').kind === 'pro' || isProRoomCode(getState('network.sessionCode'));
  if (proRoom) {
    log.info('[Transport] Requesting a fresh PRO signaling ticket before reconnect');
    const credentialReady = await requestProRoomSignalingReconnect();
    peer = getPeer();
    if (!peer || peer !== expectedPeer || peer.destroyed) {
      _reconnectAttempts = 0;
      return;
    }
    if (!peer.disconnected) {
      publishSignalingRecovered();
      _reconnectAttempts = 0;
      return;
    }
    if (!credentialReady) {
      log.warn('[Transport] Fresh PRO signaling ticket unavailable; retrying with backoff');
      attemptPeerReconnect();
      return;
    }
  }

  log.info(`[Transport] Calling reconnect() (attempt ${_reconnectAttempts})`);
  try {
    peer.reconnect?.();
  } catch (error) {
    log.warn('[Transport] reconnect() threw:', (error as Error)?.message ?? error);
  }
  // Check after the next backoff window. If reconnect() succeeded, this sees
  // !peer.disconnected and resets the counter.
  attemptPeerReconnect();
}

function attemptPeerReconnect(): void {
  const peer = getPeer();
  if (!peer || peer.destroyed) {
    _reconnectAttempts = 0;
    return;
  }
  if (!peer.disconnected) {
    if (_reconnectAttempts > 0) {
      log.info('[Transport] Signaling reconnected');
      publishSignalingRecovered();
    }
    _reconnectAttempts = 0;
    return;
  }
  if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log.warn(
      `[Transport] Gave up on signaling reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts — new peers can't join until session restart`,
    );
    publishSignalingExhausted(MAX_RECONNECT_ATTEMPTS);
    return;
  }

  const delay = RECONNECT_BACKOFF_MS[_reconnectAttempts] ?? 15000;
  _reconnectAttempts++;
  publishSignalingReconnectAttempt(_reconnectAttempts, MAX_RECONNECT_ATTEMPTS);
  log.info(
    `[Transport] Scheduling signaling reconnect attempt ${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
  );

  setManagedTimer(
    'peer-signaling-reconnect',
    () => {
      // This timer belongs to the peer generation that scheduled it. A newer
      // init can replace the singleton before the backoff expires; never let
      // the old generation reconnect or reset counters for its successor.
      if (getPeer() !== peer) return;
      if (peer.destroyed) {
        _reconnectAttempts = 0;
        return;
      }
      void performScheduledPeerReconnect(peer);
    },
    delay,
  );
}

/**
 * Explicit user retry after the automatic signaling budget is exhausted.
 * Existing data channels and local media remain untouched.
 */
export function retryPeerSignalingConnection(): boolean {
  const peer = getPeer();
  if (
    !peer ||
    peer.destroyed ||
    !getState('setup.sessionStarted') ||
    getState('room.context').kind !== 'standard'
  ) {
    return false;
  }
  if (!peer.disconnected) {
    publishSignalingRecovered();
    return true;
  }

  clearManagedTimer('peer-signaling-reconnect');
  _reconnectAttempts = 1;
  publishSignalingReconnectAttempt(_reconnectAttempts, MAX_RECONNECT_ATTEMPTS);
  void performScheduledPeerReconnect(peer);
  return true;
}

function schedulePeerDisconnectGrace(peer: PeerInstance): void {
  setManagedTimer(
    'peer-disconnect-grace',
    () => {
      const currentPeer = getPeer();
      // Scope the grace period to the peer whose disconnect created it.
      // A replacement peer must be evaluated only by its own events.
      if (currentPeer !== peer || peer.destroyed || !peer.disconnected) return;

      // Skip the dialog if we still have a working channel ??the session
      // is functional even without signaling (no new peers can join, but
      // sync/playback for existing peers continues normally).
      const role = getState('network.appRole');
      if (role !== 'host' && role !== 'guest') return;
      if (role === 'host') {
        const peers = getState('network.connectedPeers') || [];
        const hasLive = peers.some((p) => (p.conn as DataConnection)?.open);
        if (hasLive) {
          log.info(
            '[Transport] Signaling disconnected but host has live data channels ??skipping dialog',
          );
          return;
        }
      } else if (role === 'guest') {
        const hostConn = getState('network.hostConn');
        if (hostConn?.open) {
          log.info(
            '[Transport] Signaling disconnected but guest hostConn still open ??skipping dialog',
          );
          return;
        }
      }

      if (getRoomContext().kind === 'standard' && canRecoverSignalingInPlace()) {
        log.info(
          '[Transport] Standard room can recover signaling in place ??skipping lost-session dialog',
        );
        return;
      }

      if (requestProRoomTransportRecovery()) {
        log.info('[Transport] PRO signaling is unavailable; topology recovery requested');
        return;
      }

      // No data channel or local media survived, so this is a full session
      // loss rather than the partial signaling state shown in Connect.
      resetSignalingHealth();
      showDialog({
        title: t('network.disconnected'),
        message: t('dialog.session_lost_msg'),
        buttonText: t('dialog.session_lost_btn'),
      }).then((res) => {
        if (res.action !== 'ok') return; // ESC / background dismiss
        scheduleSessionReset(t('dialog.refreshing_session'), () => window.location.reload());
      });
    },
    5000,
  );
}

/**
 * Explicit hidden-to-visible transport reconciliation. The lifecycle owner
 * supplies elapsed time; providers remain independent of document visibility.
 */
export function recoverPeerAfterBackground(hiddenMs: number): TransportBackgroundRecoveryResult {
  const peer = getPeer();
  if (!peer || peer.destroyed || !Number.isFinite(hiddenMs)) {
    return { status: 'not-applicable' };
  }

  const result = peer.recoverAfterBackground?.(hiddenMs) ?? { status: 'not-applicable' };
  if (result.status === 'stale-connection-closed') {
    // guest.ts owns the specific HOST_DISCONNECTED surface. Do not leave a
    // queued generic signaling-loss dialog behind it.
    clearManagedTimer('peer-disconnect-grace');
  } else if (result.status === 'monitoring' && peer.disconnected) {
    // The original one-shot signaling check may have fired while iOS still
    // exposed a stale-open hostConn. Re-arm it from the explicit foreground
    // recovery boundary so the post-resume state is evaluated once more.
    schedulePeerDisconnectGrace(peer);
  }
  return result;
}

function setupPeerEvents(peer: PeerInstance): void {
  peer.on('open', () => {
    if (getPeer() !== peer || getState('network.signalingHealth').status === 'healthy') return;
    clearManagedTimer('peer-signaling-reconnect');
    clearManagedTimer('peer-disconnect-grace');
    _reconnectAttempts = 0;
    publishSignalingRecovered();
  });

  peer.on('room-identity', (identity) => {
    if (getPeer() !== peer || getRoomContext().kind === 'pro') return;
    batchSetState({
      'network.myMemberId': identity?.memberId ?? null,
      'network.myMemberDisplayNumber': identity?.memberDisplayNumber ?? null,
      'network.myMemberAuthenticated': identity?.isAuthenticated === true,
      ...(identity?.nickname
        ? { 'network.myDeviceLabel': identity.nickname }
        : getState('network.appRole') === 'host'
          ? { 'network.myDeviceLabel': 'HOST' }
          : {}),
    });
    if (getState('network.appRole') === 'host') broadcastDeviceList();
  });

  peer.on('room-member-deleted', (memberId) => {
    if (getPeer() !== peer || getRoomContext().kind !== 'standard') return;
    bus.emit('network:standard-room-account-deleted', { memberId });
  });

  peer.on('pro-queue-addition', (frame) => {
    if (getPeer() !== peer) return;
    bus.emit('network:pro-queue-addition', frame);
  });

  peer.on('pro-epoch-advanced', () => {
    if (getPeer() !== peer) return;
    log.info('[Transport] PRO coordinator epoch advanced; rebuilding transport');
    requestProRoomTransportRecovery();
  });

  peer.on('error', (err: unknown) => {
    if (getPeer() !== peer) return;
    // waitForPeerOpen rejects the owning setup promise with this same error.
    // Do not also emit network:error here: guest/host setup will translate the
    // rejected init once, producing one user-facing failure.
    if (_activeNetworkInit?.peer === peer && !_activeNetworkInit.peerOpenSettled) {
      log.debug('[Transport] Peer initialization error delegated to init owner');
      return;
    }
    log.error('[Transport] Error:', err);
    const appRole = getState('network.appRole');
    const hostConn = getState('network.hostConn');

    // Defensive compatibility for callers that initialize before selecting a
    // role. Normal setup has already selected host/guest at this point.
    if (!appRole) return;

    if (appRole === 'host' && !hostConn) {
      if (err && typeof err === 'object' && (err as Record<string, unknown>).type === 'id-taken') {
        return; // Handled by retry loop
      }
      bus.emit('network:error', err);
    } else if (appRole === 'guest') {
      // Surface peer-level errors for guests too (e.g. network-offline, server-error)
      log.warn('[Transport] Guest peer error surfaced:', err);
      bus.emit('network:error', err);
    }
  });

  peer.on('disconnected', () => {
    if (getPeer() !== peer) return;
    log.warn('[Transport] Disconnected from signaling server');

    // Auto-reconnect: the active transport may not reconnect to its signaling server on
    // its own. Without this, a brief network blip permanently breaks
    // "new peer can join" until the user reloads. We retry with backoff;
    // existing data channels keep working throughout.
    _reconnectAttempts = 0; // fresh budget per disconnect event
    attemptPeerReconnect();

    // The transport 'disconnected' event fires when the WebSocket to the signaling server
    // drops. CRITICAL: existing peer-to-peer data channels are direct WebRTC
    // and survive this — only NEW peer connections are blocked. So a
    // signaling drop alone does NOT mean the session is dead.
    //
    // Do not assume other peers tear down their data connections on a
    // signaling drop; that assumption produces a
    // false-positive dialog: signaling blip → 5s grace → dialog appears
    // even though host/guest data channels are still alive and audio is
    // playing fine.
    //
    // Refined trigger:
    //   1. appRole must be set (post-bootstrap).
    //   2. After 5s grace, peer.disconnected must STILL be true.
    //   3. AND there must be no functional data connection (host: no live
    //      ConnectedPeer.conn; guest: hostConn closed). A standard host room
    //      with a valid code remains recoverable even before its first guest,
    //      so it stays in place and exposes the Connect-tab recovery action.
    const appRole = getState('network.appRole');
    if (appRole !== 'host' && appRole !== 'guest') return;

    schedulePeerDisconnectGrace(peer);
  });

  // System Audio: handle incoming media calls (WebRTC audio stream)
  peer.on('call', (mediaConn: unknown) => {
    if (getPeer() !== peer) {
      closeIncomingMediaCall(mediaConn as IncomingMediaConnection);
      return;
    }
    const mc = mediaConn as IncomingMediaConnection;
    const type = mc.metadata?.type;
    if (isSystemAudioCallType(type)) {
      if (!isTrustedSystemAudioMediaCall(mc)) {
        log.warn('[Transport] Rejected system-audio media call from non-host peer');
        closeIncomingMediaCall(mc);
        return;
      }

      bus.emit(
        'system-audio:incoming-call',
        mediaConn,
        getSystemAudioCallChannel(type, mc.metadata),
      );
      return;
    }

    closeIncomingMediaCall(mc);
  });

  peer.on('connection', (conn: DataConnection) => {
    if (getPeer() !== peer) {
      try {
        conn.close();
      } catch {
        /* noop */
      }
      return;
    }
    const appRole = getState('network.appRole');
    if (appRole !== 'host') {
      try {
        conn.close();
      } catch {
        /* noop */
      }
      return;
    }
    handleHostIncomingConnection(conn);
  });
}

// ─── Leave / Cleanup ────────────────────────────────────────────────

const PENDING_SETUP_TIMER_KEYS = [
  'peer-open-timeout',
  'peer-signaling-reconnect',
  'peer-disconnect-grace',
  'join-timeout',
  'join-retry',
  'guest-ice-fallback',
] as const;

/**
 * Release a provisional host/guest identity when setup returns to onboarding.
 * This intentionally leaves playlist, media, and user preferences untouched:
 * setup cancellation is not an active-session hard reset.
 */
export function cancelPendingSessionSetup(): void {
  if (getState('setup.sessionStarted')) return;
  deactivateNoSleep();
  resetLocalSystemAudioSfuCapabilities();
  resetGuestSystemAudioShareRoute();
  if (getState('room.context').kind === 'pro' || isProRoomCode(getState('network.lastJoinCode'))) {
    requestProRoomLeave();
  }
  invalidateGuestJoinAttempt();
  invalidateNetworkInit();

  const hostConn = getState('network.hostConn');
  const connectedPeers = getState('network.connectedPeers');
  const peer = getPeer();
  const hadOpenResources = !!peer || !!hostConn || connectedPeers.length > 0;

  if (hadOpenResources) setState('network.isIntentionalDisconnect', true);
  for (const timerKey of PENDING_SETUP_TIMER_KEYS) clearManagedTimer(timerKey);
  _reconnectAttempts = 0;
  resetSignalingHealth();

  try {
    hostConn?.close();
  } catch {
    /* noop */
  }
  for (const connectedPeer of connectedPeers) {
    try {
      (connectedPeer.conn as DataConnection | null)?.close();
    } catch {
      /* noop */
    }
  }
  if (peer) setPeer(null);
  try {
    peer?.destroy();
  } catch {
    /* noop */
  }

  batchSetState({
    'room.context': {
      kind: 'standard',
      roomId: null,
      role: 'idle',
      coordinatorId: null,
      epoch: 0,
      snapshotRevision: 0,
      capabilities: [],
    },
    'network.myId': null,
    'network.myJoinOrder': 0,
    'network.myMemberId': null,
    'network.myMemberDisplayNumber': null,
    'network.myMemberAuthenticated': false,
    'network.sessionCode': '',
    'network.lastJoinCode': '',
    'network.hostConn': null,
    'network.connectedPeers': [],
    'network.isConnecting': false,
    'network.connectionType': 'unknown',
    'network.lastKnownDeviceList': null,
    'network.peerLabels': {},
    'network.peerSlots': Array(MAX_GUEST_SLOTS + 1).fill(null) as (string | null)[],
    'network.peerSlotByPeerId': new Map<string, number>(),
    'network.activeHostConnByPeerId': new Map<string, DataConnection>(),
    'network.standardRoomAdministrators': new Map(),
    'network.standardRoomCapabilities': null,
    'network.signalingHealth': {
      status: 'healthy',
      attempt: 0,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
    },
  });

  if (hadOpenResources) {
    setManagedTimer(
      'setup-cancel-intent-reset',
      () => {
        if (getState('network.appRole') === 'idle' && !getState('setup.sessionStarted')) {
          setState('network.isIntentionalDisconnect', false);
        }
      },
      500,
    );
  } else {
    setState('network.isIntentionalDisconnect', false);
  }
}

/**
 * Leave the current session and clean up all network state.
 */
export function leaveSession(options: { preserveAccountLoginReturn?: boolean } = {}): void {
  deactivateNoSleep();
  // A user-confirmed leave must not let an abandoned OAuth route pull a later
  // PWA launch back into this room. Confirmed pagehide is different: it is the
  // boundary used by same-tab OAuth navigation and explicitly opts out below.
  if (!options.preserveAccountLoginReturn) clearCurrentAccountLoginReturn();
  resetLocalSystemAudioSfuCapabilities();
  resetGuestSystemAudioShareRoute();
  if (getState('room.context').kind === 'pro' || isProRoomCode(getState('network.sessionCode'))) {
    requestProRoomLeave();
  }
  invalidateGuestJoinAttempt();
  invalidateNetworkInit();
  log.debug('[Network] Leaving session — full cleanup...');

  setState('network.isIntentionalDisconnect', true);

  // ── 0. Stop system audio sharing ──
  bus.emit('system-audio:force-stop');

  // ── 1. Stop all background timers ──
  // The guest starts the worker `'sync'` timer on session join;
  // without an explicit STOP, the worker keeps ticking after leave and the
  // tick handler runs every second as a guarded noop (hostConn=null). Tell
  // the worker to drop the timer so the noop traffic stops.
  stopWorkerTimer('sync');
  // Service-worker polling belongs to the page, not to a room. Registration
  // runs once at bootstrap, so cancelling it here would disable hourly update
  // checks for the rest of this tab's lifetime after its first room exit.
  cancelConnectionTypeWaiters();
  clearAllManagedTimers({ except: ['sw-update-check'] });
  resetSignalingHealth();

  // ── 2. Stop media playback ──
  // Room teardown must invalidate every async load owner before state resets;
  // otherwise a native decode that settles later can republish old-room audio.
  bus.emit('player:stop-all-media', { cancelInFlight: true, clearBuffer: true });

  // ── 3. Close network connections ──
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    try {
      hostConn.close();
    } catch {
      /* noop */
    }
  }

  const connectedPeers = getState('network.connectedPeers');
  connectedPeers.forEach((p) => {
    try {
      const conn = p.conn as DataConnection | null;
      if (conn) conn.close();
    } catch {
      /* noop */
    }
  });

  // Destroy peer AFTER all connections are closed
  const peer = getPeer();
  if (peer) {
    setPeer(null);
    try {
      peer.destroy();
    } catch {
      /* noop */
    }
  }

  // ── 4. Clear peer slots and maps ──
  setState('network.activeHostConnByPeerId', new Map());
  setState('network.peerSlotByPeerId', new Map());
  setState('network.peerSlots', Array(MAX_GUEST_SLOTS + 1).fill(null) as (string | null)[]);

  // ── 5. Clear transfer state ──
  // Note: file/preload reorder buffers are module-local in transfer.ts/preload.ts
  // Clear the state-managed preload session state (correct key: preload.sessionState)
  setState('preload.sessionState', new Map());
  setState('preload.ackSent', new Map());

  // ── 6. Reset all state ──
  batchSetState({
    // Setup
    'setup.sessionStarted': false,
    // Provider-neutral room authority
    'room.context': {
      kind: 'standard',
      roomId: null,
      role: 'idle',
      coordinatorId: null,
      epoch: 0,
      snapshotRevision: 0,
      capabilities: [],
    },
    // Network
    'network.appRole': 'idle',
    'network.myId': null,
    'network.myDeviceLabel': 'HOST',
    'network.myJoinOrder': 0,
    'network.myMemberId': null,
    'network.myMemberDisplayNumber': null,
    'network.myMemberAuthenticated': false,
    'network.hostConn': null,
    'network.connectedPeers': [],
    'network.standardRoomAdministrators': new Map(),
    'network.isOperator': false,
    'network.standardRoomCapabilities': null,
    'network.isConnecting': false,
    'network.connectionType': 'unknown',
    'network.lastKnownDeviceList': null,
    'network.peerLabels': {},
    // Note: isIntentionalDisconnect is NOT reset here — async close handlers
    // may read it after batchSetState. Reset via delayed timer below.
    'network.sessionCode': '',
    'network.lastJoinCode': '',
    'network.roomPasswordRequired': false,
    'network.roomPassword': '',
    'network.peerSlots': Array(MAX_GUEST_SLOTS + 1).fill(null) as (string | null)[],
    'network.mutedPeers': new Set<string>(),
    'network.chatFrozen': false,
    'network.slowmodeSeconds': 0,
    'network.filterEnabled': false,
    'network.signalingHealth': {
      status: 'healthy',
      attempt: 0,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
    },
    // Playlist
    'playlist.items': [],
    'playlist.currentQueueItemId': null,
    'playlist.revision': 0,
    // Transfer
    'transfer.meta': null,
    'transfer.state': TRANSFER_STATE.IDLE,
    'transfer.receivedCount': 0,
    'transfer.localSessionId': 0,
    'transfer.currentSessionId': 0,
    'transfer.activeBroadcastSession': null,
    'transfer.lastReceivedCountSnapshot': 0,
    // Reset stale-chunk burst detection counters so a reconnect doesn't
    // carry over a mid-burst window from the prior session and trip the
    // early-recovery heuristic prematurely on its first post-reconnect chunk.
    'transfer.staleChunkBurstStart': 0,
    'transfer.staleChunkBurstCount': 0,
    // Recovery
    'recovery.pending': false,
    'recovery.retryCount': 0,
    // Files
    'files.current': null,
    // Preload
    'preload.isPreloading': false,
    'preload.sessionId': 0,
    'preload.activeTarget': null,
    'preload.ready': null,
    'preload.nextQueueItemId': null,
    // Playback lifecycle
    'playback.lifecycle': PLAYBACK_STATE.IDLE,
    'playback.loadSource': null,
    'playback.pendingPlayTime': undefined,
    'playback.pendingPlayTimeSetAt': 0,
    'playback.pendingRecoveryTarget': null,
    'playback.failedTrackKeys': new Set<string>(),
    // Sync
    'sync.localOffset': 0,
    'sync.youtubeLocalOffset': 0,
    'sync.youtubeCoordinatorAppliedOffset': 0,
    'sync.lastLatencyMs': 0,
    'sync.latencyHistory': [],
    // Player
    'player.startedAt': 0,
    'player.currentTrackMeta': null,
    'player.pausedAt': 0,
    'player.isSeeking': false,
    'player.isFirstTrackLoad': true,
    'player.decodeFailureCount': 0,
    // YouTube
    'youtube.currentSubIndex': -1,
    'youtube.subItemsMap': {},
    // System audio
    'systemAudio.isReceiving': false,
  });

  // ── 8. Reset UI ──
  setPlaybackIdle();

  // Delayed reset: allow async close handlers to read the flag first
  setManagedTimer(
    'intentional-disconnect-reset',
    () => setState('network.isIntentionalDisconnect', false),
    200,
  );

  log.debug('[Network] Session left — full cleanup complete.');
}

// ─── Bus Event Handlers ─────────────────────────────────────────

bus.on('network:broadcast', (data) => {
  if (data) broadcast(data as AnyProtocolMsg);
});

bus.on('network:broadcast-except', (peerId, data) => {
  if (data) broadcastExcept(peerId, data as AnyProtocolMsg);
});

// ─── Init Peer Protocol Handlers ──────────────────────────────────

export function initPeerHandlers(): void {
  initGuestProtocolHandlers();
  log.info('[Peer] Protocol handlers registered');
}

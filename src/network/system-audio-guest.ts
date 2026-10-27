/**
 * MUSIXQUARE — System Audio Guest Receiver
 *
 * Receives the original Standard-room stereo track over the direct call and
 * connects it as-is. The trust boundary, the end of reception, and the
 * call's source and decoder primer belong to the receive slot
 * (system-audio-receive-slot.ts), shared with the SFU and PRO receivers.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import { initAudio } from '../audio/engine.ts';
import { isSystemAudioPlaceholderMeta } from '../player/ownership.ts';
import { registerHandler } from './protocol.ts';
import { readSystemAudioStartSurface } from './system-audio-start.ts';
import { claimGuestDirectSystemAudioRoute } from './system-audio-delivery.ts';
import type { DataConnection, MediaConnection, TrackMeta } from '../types/index.ts';

import { forceStereoSdp } from './opus-stereo-sdp.ts';
import {
  applySystemAudioPlayoutDelay,
  SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS,
} from './system-audio-media.ts';
import {
  attachSystemAudioSource,
  awaitTrustedSystemAudioReceptionBoundary,
  beginTrustedSystemAudioReception,
  clearSystemAudioReceiveWatchdog,
  detachSystemAudioRoute,
  endTrustedSystemAudioReception,
  expireTrustedSystemAudioReception,
  getSystemAudioReceiveRouteSnapshot,
  getSystemAudioReceiveSlotDebugSnapshot,
  noteIgnoredSystemAudioStart,
  primeSystemAudioDecoder,
  registerSystemAudioReceiveRoute,
} from './system-audio-receive-slot.ts';
import { getAudioTrackStreamKey } from './webrtc-audio-decoder-primer.ts';

// ─── Tuning ───────────────────────────────────────────────────────
// The playout-delay hint and the receive deadline live in
// system-audio-media.ts with the other routes'.
// The direct call carries the one native stereo track, its only call type.
// 'STEREO' still labels its log lines, its timer names and its /debug sa
// channel record.
const SYSTEM_AUDIO_CHANNEL = 'STEREO';
const SYSTEM_AUDIO_REPLACEMENT_WATCHDOG = `sys-audio-guest-replacement-watchdog-${SYSTEM_AUDIO_CHANNEL}`;
// The direct call's route in the receive slot, which holds its source and
// decoder primer.
const DIRECT_ROUTE = 'standard-direct';

// ─── Module State ─────────────────────────────────────────────────

let _mediaConnStereo: MediaConnection | null = null;

let _initialUnmuteWaitSeq = 0;
let _replacementWatchdogConn: MediaConnection | null = null;

interface InitialUnmuteWaiter {
  mediaConn: MediaConnection;
  cancel: () => void;
}

const _initialUnmuteWaiters = new Set<InitialUnmuteWaiter>();

interface GuestChannelDebug {
  channel: string;
  incomingAt?: number;
  peerId?: string;
  metadataType?: string;
  answerAt?: number;
  answerError?: string;
  streamAt?: number;
  streamTracks: string[];
  graphAt?: number;
  graphError?: string;
  closedAt?: number;
  error?: string;
  pc?: RTCPeerConnection;
}

let _debugChannel: GuestChannelDebug | null = null;
let _debugLastStopAt = 0;

function errorToDebugString(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function closeMediaConnection(mediaConn: MediaConnection | null): void {
  if (!mediaConn) return;
  try {
    mediaConn.close();
  } catch {
    /* noop */
  }
}

function cancelInitialUnmuteWaiters(mediaConn?: MediaConnection): void {
  for (const waiter of [..._initialUnmuteWaiters]) {
    if (mediaConn && waiter.mediaConn !== mediaConn) continue;
    waiter.cancel();
  }
}

function replaceCurrentMediaConnection(mediaConn: MediaConnection): void {
  const previous = _mediaConnStereo;
  _mediaConnStereo = mediaConn;
  if (previous && previous !== mediaConn) {
    cancelInitialUnmuteWaiters(previous);
    closeMediaConnection(previous);
  }
}

function isCurrentMediaConnection(mediaConn: MediaConnection): boolean {
  return _mediaConnStereo === mediaConn;
}

function getDebugChannel(): GuestChannelDebug {
  _debugChannel ??= { channel: SYSTEM_AUDIO_CHANNEL, streamTracks: [] };
  return _debugChannel;
}

function readMetadataType(metadata: MediaConnection['metadata']): string {
  const type = metadata?.type;
  return typeof type === 'string' ? type : '-';
}

function isSystemAudioPlaceholder(): boolean {
  const currentMeta = getState('player.currentTrackMeta') as TrackMeta | null;
  return isSystemAudioPlaceholderMeta(currentMeta);
}

function clearReplacementWatchdog(mediaConn?: MediaConnection): void {
  if (mediaConn && _replacementWatchdogConn !== mediaConn) return;
  _replacementWatchdogConn = null;
  clearManagedTimer(SYSTEM_AUDIO_REPLACEMENT_WATCHDOG);
}

function armReplacementWatchdog(mediaConn: MediaConnection): void {
  _replacementWatchdogConn = mediaConn;
  setManagedTimer(
    SYSTEM_AUDIO_REPLACEMENT_WATCHDOG,
    () => {
      if (_replacementWatchdogConn !== mediaConn) return;
      _replacementWatchdogConn = null;
      if (!isCurrentMediaConnection(mediaConn)) return;

      log.warn(`[SysAudioGuest] Timed out waiting for replacement ${SYSTEM_AUDIO_CHANNEL} stream`);
      // The receive slot runs the routes' deadline reactions, ends the
      // reception and shows receive_failed, as its own deadline does.
      expireTrustedSystemAudioReception();
    },
    SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS,
  );
}

function describeAudioTracks(tracks: MediaStreamTrack[]): string {
  return (
    tracks
      .map((track) => `${track.id.slice(0, 8)}:${track.readyState}${track.muted ? ':muted' : ''}`)
      .join(', ') || 'none'
  );
}

function primeGuestWindowsAudioDecoder(tracks: MediaStreamTrack[]): void {
  primeSystemAudioDecoder(DIRECT_ROUTE, tracks, {
    streamKey: getAudioTrackStreamKey(SYSTEM_AUDIO_CHANNEL, tracks),
    label: SYSTEM_AUDIO_CHANNEL,
    logPrefix: '[SysAudioGuest]',
  });
}

async function waitForInitialUnmute(
  tracks: MediaStreamTrack[],
  mediaConn: MediaConnection,
): Promise<boolean> {
  if (tracks.length === 0 || tracks.every((track) => !track.muted)) return true;

  log.info(
    `[SysAudioGuest] ${SYSTEM_AUDIO_CHANNEL} stream arrived muted; waiting for unmute before graph attach`,
  );

  return new Promise<boolean>((resolve) => {
    const id = ++_initialUnmuteWaitSeq;
    const timeoutTimer = `sys-audio-guest-unmute-timeout-${id}`;
    const settleTimer = `sys-audio-guest-unmute-settle-${id}`;
    let settled = false;

    const cleanup = (): void => {
      _initialUnmuteWaiters.delete(waiter);
      clearManagedTimer(timeoutTimer);
      clearManagedTimer(settleTimer);
      tracks.forEach((track) => track.removeEventListener('unmute', check));
    };

    const done = (ready: boolean, reason: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      log.info(
        `[SysAudioGuest] ${SYSTEM_AUDIO_CHANNEL} graph attach after ${reason}: ${describeAudioTracks(tracks)}`,
      );
      resolve(ready);
    };

    const check = (): void => {
      if (tracks.every((track) => !track.muted)) {
        setManagedTimer(settleTimer, () => done(true, 'unmute'), 80);
      }
    };

    const waiter: InitialUnmuteWaiter = {
      mediaConn,
      cancel: () => done(false, 'cancel'),
    };
    _initialUnmuteWaiters.add(waiter);
    tracks.forEach((track) => track.addEventListener('unmute', check));
    setManagedTimer(timeoutTimer, () => done(true, 'unmute-timeout'), 2000);
    check();
  });
}

// ─── Public API ───────────────────────────────────────────────────

export function getSystemAudioGuestDebugSnapshot() {
  const slot = getSystemAudioReceiveSlotDebugSnapshot();
  // gotStereo and sourceStereo both mean "the direct call attached a source";
  // the primer is reported apart (it is taken before the trust boundary).
  const direct = getSystemAudioReceiveRouteSnapshot(DIRECT_ROUTE);
  const debugChannels = _debugChannel ? [_debugChannel] : [];
  const channels = debugChannels.map((channel) => ({
    channel: channel.channel,
    incomingAt: channel.incomingAt,
    peerId: channel.peerId,
    metadataType: channel.metadataType,
    answerAt: channel.answerAt,
    answerError: channel.answerError,
    streamAt: channel.streamAt,
    streamTracks: channel.streamTracks,
    graphAt: channel.graphAt,
    graphError: channel.graphError,
    closedAt: channel.closedAt,
    error: channel.error,
    pcState: channel.pc
      ? {
          connectionState: channel.pc.connectionState,
          iceConnectionState: channel.pc.iceConnectionState,
          signalingState: channel.pc.signalingState,
        }
      : null,
  }));

  return {
    systemReceiving: getState('systemAudio.isReceiving'),
    placeholder: isSystemAudioPlaceholder(),
    gotStereo: direct.sourceAttached,
    sourceStereo: direct.sourceAttached,
    decoderPrimer: direct.decoderPrimed,
    lastStartAt: slot.lastStartAt,
    lastStartIgnoredAt: slot.lastStartIgnoredAt,
    lastStartIgnoredReason: slot.lastStartIgnoredReason,
    lastStopAt: _debugLastStopAt,
    lastCleanupAt: slot.lastCleanupAt,
    watchdogArmedAt: slot.watchdogArmedAt,
    watchdogTimedOutAt: slot.watchdogTimedOutAt,
    watchdogActive: slot.watchdogActive,
    channels,
    peerConnections: debugChannels
      .filter((channel): channel is GuestChannelDebug & { pc: RTCPeerConnection } => !!channel.pc)
      .map((channel) => ({
        label: `guest:${channel.channel}:${(channel.peerId || '?').slice(0, 8)}`,
        pc: channel.pc,
      })),
  };
}

// ─── Handle Incoming Media Call ───────────────────────────────────

async function handleIncomingCall(mediaConn: MediaConnection): Promise<void> {
  log.info(`[SysAudioGuest] Incoming ${SYSTEM_AUDIO_CHANNEL} channel call`);
  const debug = getDebugChannel();
  debug.incomingAt = Date.now();
  debug.peerId = mediaConn.peer;
  debug.metadataType = readMetadataType(mediaConn.metadata);
  debug.answerAt = undefined;
  debug.answerError = undefined;
  debug.streamAt = undefined;
  debug.streamTracks = [];
  debug.graphAt = undefined;
  debug.graphError = undefined;
  debug.closedAt = undefined;
  debug.error = undefined;
  debug.pc = mediaConn.peerConnection;

  const previousConnection = _mediaConnStereo;
  replaceCurrentMediaConnection(mediaConn);
  if (
    previousConnection &&
    previousConnection !== mediaConn &&
    getState('systemAudio.isReceiving')
  ) {
    // The old graph remains connected until the new stream is attached, but a
    // same-channel PeerJS replacement can close its predecessor before ever
    // emitting `stream`. Track the exact successor independently of the
    // initial receive watchdog so a silent handoff cannot leave a permanent
    // receiving=true / no-audio state.
    armReplacementWatchdog(mediaConn);
  }

  const attachStream = async (remoteStream: MediaStream): Promise<void> => {
    if (!isCurrentMediaConnection(mediaConn)) return;
    log.info(`[SysAudioGuest] Received ${SYSTEM_AUDIO_CHANNEL} stream`);
    const streamTracks = remoteStream.getAudioTracks();
    log.info(
      `[SysAudioGuest] ${SYSTEM_AUDIO_CHANNEL} stream tracks: ${describeAudioTracks(streamTracks)}`,
    );
    debug.streamAt = Date.now();
    debug.streamTracks = streamTracks.map(
      (track) => `${track.id.slice(0, 8)}:${track.readyState}${track.muted ? ':muted' : ''}`,
    );
    debug.pc = mediaConn.peerConnection;
    if (streamTracks.length === 0) {
      throw new Error('zero-audio-tracks');
    }
    // Some Chromium builds leave a newly received WebRTC track muted until a
    // playing media element asks the decoder to consume it. Prime immediately
    // after validating the tracks so the bounded unmute wait below observes
    // the decoder wake-up instead of timing out before the primer is attached.
    primeGuestWindowsAudioDecoder(streamTracks);
    const unmuteWaitAccepted = await waitForInitialUnmute(streamTracks, mediaConn);
    if (!unmuteWaitAccepted || !isCurrentMediaConnection(mediaConn)) return;

    // PeerJS media and data channels are independently ordered. A stream can
    // arrive before the authenticated SYSTEM_AUDIO_START frame, or while the
    // prior file output is still draining. Do not connect that stream
    // to the audible graph until the exact trusted owner-switch boundary has
    // committed.
    const trustedReceptionReady =
      await awaitTrustedSystemAudioReceptionBoundary(SYSTEM_AUDIO_CHANNEL);
    if (!trustedReceptionReady || !isCurrentMediaConnection(mediaConn)) {
      if (isCurrentMediaConnection(mediaConn)) {
        closeMediaConnection(mediaConn);
      }
      return;
    }

    // Pin every audio receiver to the same playout-delay target so NetEq's
    // adaptive jitter buffer doesn't drift independently per device (the
    // rationale and tuning notes are in system-audio-media.ts). Direct-call
    // adapters expose the underlying RTCPeerConnection here.
    const pc = mediaConn.peerConnection;
    if (pc) {
      for (const receiver of pc.getReceivers()) applySystemAudioPlayoutDelay(receiver);
    }

    await initAudio();
    if (!isCurrentMediaConnection(mediaConn)) return;
    // The receive slot swaps the call's previous source for this stream and,
    // on a reception's first attach, sets receiving and claims the owner. The
    // primer above stays as it is: a later stream may already have replaced
    // it while this one waited.
    const attached = attachSystemAudioSource(
      DIRECT_ROUTE,
      { stream: remoteStream },
      {
        startsReception: 'first-for-slot',
        onConnected: () => {
          debug.graphAt = Date.now();
          debug.graphError = undefined;
          clearReplacementWatchdog(mediaConn);
        },
        connectedLog: `[SysAudioGuest] System audio connected to graph (${SYSTEM_AUDIO_CHANNEL})`,
      },
    );
    if (attached === 'not-receiving') {
      // The reception ended or another owner plays (5B-G1); the slot dropped
      // this route's source and primer. Keep the call open and current: a
      // guest close sends media-close, and while the share is active the
      // host hands this guest to the SFU with STOP, START and READY, whose
      // START would stop the successor. STOP or the reception's end closes
      // it through the end port. Its replacement deadline goes too, so it
      // cannot expire the reception (and close the call) later.
      clearReplacementWatchdog(mediaConn);
      return;
    }
    if (attached === 'graph-unavailable') {
      log.error('[SysAudioGuest] Audio graph not ready');
      throw new Error('audio-graph-not-ready');
    }
  };

  mediaConn.on('stream', (remoteStream: MediaStream) => {
    void attachStream(remoteStream).catch((error: unknown) => {
      // A replacement connection can win while initial unmute/audio init is
      // awaiting. A stale rejection must never tear down its successor.
      if (!isCurrentMediaConnection(mediaConn)) return;
      debug.graphError = errorToDebugString(error);
      log.warn(`[SysAudioGuest] ${SYSTEM_AUDIO_CHANNEL} stream graph failed:`, error);
      endTrustedSystemAudioReception();
      bus.emit('ui:show-toast', t('system_audio.receive_failed'));
    });
  });

  mediaConn.on('close', () => {
    cancelInitialUnmuteWaiters(mediaConn);
    if (!isCurrentMediaConnection(mediaConn)) return;
    log.info(`[SysAudioGuest] ${SYSTEM_AUDIO_CHANNEL} MediaConnection closed`);
    debug.closedAt = Date.now();
    clearReplacementWatchdog(mediaConn);
    _mediaConnStereo = null;
    endTrustedSystemAudioReception();
  });

  mediaConn.on('error', (err: unknown) => {
    if (!isCurrentMediaConnection(mediaConn)) return;
    log.warn(`[SysAudioGuest] ${SYSTEM_AUDIO_CHANNEL} error:`, err);
    debug.error = errorToDebugString(err);
    // Cloudflare media calls share the data RTCPeerConnection. Closing the
    // exact failed call lets the transport serialize an identity-fenced SDP
    // rollback before a later system-audio call reuses that connection.
    closeMediaConnection(mediaConn);
  });

  // Register stream/close/error handlers before answer(). Fast local desktop
  // peers can emit the stream event immediately after answering.
  try {
    mediaConn.answer(undefined, { sdpTransform: forceStereoSdp });
    debug.answerAt = Date.now();
    debug.answerError = undefined;
  } catch (err) {
    log.warn(`[SysAudioGuest] ${SYSTEM_AUDIO_CHANNEL} answer failed:`, err);
    debug.answerError = errorToDebugString(err);
    closeMediaConnection(mediaConn);
  }
}

// ─── End of Reception ─────────────────────────────────────────────

// The direct call's part of every reception end, whichever route ends it.
// The receive slot runs it after taking the restore point and before the
// receiving flag drops (system-audio-receive-slot.ts).
function endStandardDirectReception(): void {
  cancelInitialUnmuteWaiters();
  clearReplacementWatchdog();
  detachSystemAudioRoute(DIRECT_ROUTE);
  // Clear identities before close() so synchronous/stale close events cannot
  // recursively clean the graph or null a replacement connection.
  const mediaConnection = _mediaConnStereo;
  _mediaConnStereo = null;
  closeMediaConnection(mediaConnection);
}

registerSystemAudioReceiveRoute(DIRECT_ROUTE, { endReception: endStandardDirectReception });

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemAudioGuestListeners(): void {
  // Drop SYSTEM_AUDIO_START/STOP frames not arriving via hostConn. The host
  // triggers these via audio/system-capture.ts and guests only trust that
  // authenticated host connection. Without this guard, a peer can:
  //   - send raw SYSTEM_AUDIO_START → stopAllMedia() + clobber the receive
  //     slot's restore point + spoof a "Receiving System Audio" track on the
  //     target. Single-frame DoS on whatever the user is playing.
  //   - send raw SYSTEM_AUDIO_STOP → force endTrustedSystemAudioReception()
  //     on a guest legitimately receiving host's system audio. Single-frame
  //     DoS on the actual reception.
  function isHostBroadcast(conn: DataConnection | undefined): boolean {
    const hostConn = getState('network.hostConn');
    return !!hostConn && conn === hostConn;
  }

  registerHandler(
    MSG.SYSTEM_AUDIO_START,
    (data: Record<string, unknown>, conn?: DataConnection) => {
      if (!isHostBroadcast(conn)) {
        noteIgnoredSystemAudioStart(conn ? 'non-host-connection' : 'missing-connection');
        return;
      }
      if (isSystemAudioPlaceholder()) {
        noteIgnoredSystemAudioStart('duplicate-placeholder');
        log.debug('[SysAudioGuest] Duplicate system audio start ignored');
        return;
      }
      log.info('[SysAudioGuest] Host started system audio sharing');
      // The slot's 30 s receive deadline bounds the wait for a route.
      beginTrustedSystemAudioReception(readSystemAudioStartSurface(data), { deadline: 'slot' });
    },
  );

  registerHandler(
    MSG.SYSTEM_AUDIO_STOP,
    (_data: Record<string, unknown>, conn?: DataConnection) => {
      if (!isHostBroadcast(conn)) return;
      log.info('[SysAudioGuest] Host stopped system audio sharing');
      _debugLastStopAt = Date.now();
      endTrustedSystemAudioReception();
      bus.emit('system-audio:host-stopped');
    },
  );

  bus.on('system-audio:incoming-call', (mediaConn: unknown) => {
    if (!claimGuestDirectSystemAudioRoute()) {
      log.info('[SysAudioGuest] Ignored stale direct call after all-audience SFU route froze');
      try {
        (mediaConn as MediaConnection).close();
      } catch {
        /* noop */
      }
      return;
    }
    handleIncomingCall(mediaConn as MediaConnection).catch((e) =>
      log.error('[SysAudioGuest] handleIncomingCall failed:', e),
    );
  });

  bus.on('state:systemAudio.isReceiving', (value) => {
    if (value === true) clearSystemAudioReceiveWatchdog();
  });

  bus.on('system-audio:force-stop', () => {
    endTrustedSystemAudioReception();
  });
}

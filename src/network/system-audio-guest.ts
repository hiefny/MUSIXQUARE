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
const SYSTEM_AUDIO_REPLACEMENT_WATCHDOG_PREFIX = 'sys-audio-guest-replacement-watchdog';
const SYSTEM_AUDIO_CHANNEL = 'STEREO';
// The direct call's route in the receive slot, which holds its source and
// decoder primer.
const DIRECT_ROUTE = 'standard-direct';

// ─── Module State ─────────────────────────────────────────────────

let _mediaConnStereo: MediaConnection | null = null;

let _initialUnmuteWaitSeq = 0;
const _replacementWatchdogs = new Map<string, MediaConnection>();

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

const _debugChannels = new Map<string, GuestChannelDebug>();
let _debugLastStopAt = 0;

function errorToDebugString(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function currentMediaConnection(channel: string): MediaConnection | null {
  return channel === SYSTEM_AUDIO_CHANNEL ? _mediaConnStereo : null;
}

function setCurrentMediaConnection(channel: string, mediaConn: MediaConnection | null): boolean {
  if (channel !== SYSTEM_AUDIO_CHANNEL) return false;
  _mediaConnStereo = mediaConn;
  return true;
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

function replaceCurrentMediaConnection(channel: string, mediaConn: MediaConnection): boolean {
  const previous = currentMediaConnection(channel);
  if (!setCurrentMediaConnection(channel, mediaConn)) return false;
  if (previous && previous !== mediaConn) {
    cancelInitialUnmuteWaiters(previous);
    closeMediaConnection(previous);
  }
  return true;
}

function isCurrentMediaConnection(channel: string, mediaConn: MediaConnection): boolean {
  return currentMediaConnection(channel) === mediaConn;
}

function getDebugChannel(channel: string): GuestChannelDebug {
  const existing = _debugChannels.get(channel);
  if (existing) return existing;
  const created: GuestChannelDebug = { channel, streamTracks: [] };
  _debugChannels.set(channel, created);
  return created;
}

function readMetadataType(metadata: MediaConnection['metadata']): string {
  const type = metadata?.type;
  return typeof type === 'string' ? type : '-';
}

function isSystemAudioPlaceholder(): boolean {
  const currentMeta = getState('player.currentTrackMeta') as TrackMeta | null;
  return isSystemAudioPlaceholderMeta(currentMeta);
}

function replacementWatchdogName(channel: string): string {
  return `${SYSTEM_AUDIO_REPLACEMENT_WATCHDOG_PREFIX}-${channel}`;
}

function clearReplacementWatchdog(channel: string, mediaConn?: MediaConnection): void {
  if (mediaConn && _replacementWatchdogs.get(channel) !== mediaConn) return;
  _replacementWatchdogs.delete(channel);
  clearManagedTimer(replacementWatchdogName(channel));
}

function armReplacementWatchdog(channel: string, mediaConn: MediaConnection): void {
  _replacementWatchdogs.set(channel, mediaConn);
  setManagedTimer(
    replacementWatchdogName(channel),
    () => {
      if (_replacementWatchdogs.get(channel) !== mediaConn) return;
      _replacementWatchdogs.delete(channel);
      if (!isCurrentMediaConnection(channel, mediaConn)) return;

      log.warn(`[SysAudioGuest] Timed out waiting for replacement ${channel} stream`);
      // The receive slot runs the routes' deadline reactions, ends the
      // reception and shows receive_failed, as its own deadline does.
      expireTrustedSystemAudioReception();
    },
    SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS,
  );
}

function clearAllReplacementWatchdogs(): void {
  clearReplacementWatchdog(SYSTEM_AUDIO_CHANNEL);
}

function describeAudioTracks(tracks: MediaStreamTrack[]): string {
  return (
    tracks
      .map((track) => `${track.id.slice(0, 8)}:${track.readyState}${track.muted ? ':muted' : ''}`)
      .join(', ') || 'none'
  );
}

function primeGuestWindowsAudioDecoder(channel: string, tracks: MediaStreamTrack[]): void {
  primeSystemAudioDecoder(DIRECT_ROUTE, tracks, {
    streamKey: getAudioTrackStreamKey(channel, tracks),
    label: channel,
    logPrefix: '[SysAudioGuest]',
  });
}

async function waitForInitialUnmute(
  channel: string,
  tracks: MediaStreamTrack[],
  mediaConn: MediaConnection,
): Promise<boolean> {
  if (tracks.length === 0 || tracks.every((track) => !track.muted)) return true;

  log.info(
    `[SysAudioGuest] ${channel} stream arrived muted; waiting for unmute before graph attach`,
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
        `[SysAudioGuest] ${channel} graph attach after ${reason}: ${describeAudioTracks(tracks)}`,
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
  const channels = [..._debugChannels.values()].map((channel) => ({
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
    peerConnections: [..._debugChannels.values()]
      .filter((channel): channel is GuestChannelDebug & { pc: RTCPeerConnection } => !!channel.pc)
      .map((channel) => ({
        label: `guest:${channel.channel}:${(channel.peerId || '?').slice(0, 8)}`,
        pc: channel.pc,
      })),
  };
}

// ─── Handle Incoming Media Call ───────────────────────────────────

async function handleIncomingCall(mediaConn: MediaConnection, channel: string): Promise<void> {
  log.info(`[SysAudioGuest] Incoming ${channel} channel call`);
  const debug = getDebugChannel(channel);
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

  const previousConnection = currentMediaConnection(channel);
  if (!replaceCurrentMediaConnection(channel, mediaConn)) {
    log.warn(`[SysAudioGuest] Ignored unsupported channel call: ${channel}`);
    closeMediaConnection(mediaConn);
    return;
  }
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
    armReplacementWatchdog(channel, mediaConn);
  }

  const attachStream = async (remoteStream: MediaStream): Promise<void> => {
    if (!isCurrentMediaConnection(channel, mediaConn)) return;
    log.info(`[SysAudioGuest] Received ${channel} stream`);
    const streamTracks = remoteStream.getAudioTracks();
    log.info(`[SysAudioGuest] ${channel} stream tracks: ${describeAudioTracks(streamTracks)}`);
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
    primeGuestWindowsAudioDecoder(channel, streamTracks);
    const unmuteWaitAccepted = await waitForInitialUnmute(channel, streamTracks, mediaConn);
    if (!unmuteWaitAccepted || !isCurrentMediaConnection(channel, mediaConn)) return;

    // PeerJS media and data channels are independently ordered. A stream can
    // arrive before the authenticated SYSTEM_AUDIO_START frame, or while the
    // prior file output is still draining. Do not connect that stream
    // to the audible graph until the exact trusted owner-switch boundary has
    // committed.
    const trustedReceptionReady = await awaitTrustedSystemAudioReceptionBoundary(channel);
    if (!trustedReceptionReady || !isCurrentMediaConnection(channel, mediaConn)) {
      if (isCurrentMediaConnection(channel, mediaConn)) {
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
    if (!isCurrentMediaConnection(channel, mediaConn)) return;
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
          clearReplacementWatchdog(channel, mediaConn);
        },
        connectedLog: `[SysAudioGuest] System audio connected to graph (${channel})`,
      },
    );
    if (!attached) {
      log.error('[SysAudioGuest] Audio graph not ready');
      throw new Error('audio-graph-not-ready');
    }
  };

  mediaConn.on('stream', (remoteStream: MediaStream) => {
    void attachStream(remoteStream).catch((error: unknown) => {
      // A replacement connection can win while initial unmute/audio init is
      // awaiting. A stale rejection must never tear down its successor.
      if (!isCurrentMediaConnection(channel, mediaConn)) return;
      debug.graphError = errorToDebugString(error);
      log.warn(`[SysAudioGuest] ${channel} stream graph failed:`, error);
      endTrustedSystemAudioReception();
      bus.emit('ui:show-toast', t('system_audio.receive_failed'));
    });
  });

  mediaConn.on('close', () => {
    cancelInitialUnmuteWaiters(mediaConn);
    if (!isCurrentMediaConnection(channel, mediaConn)) return;
    log.info(`[SysAudioGuest] ${channel} MediaConnection closed`);
    debug.closedAt = Date.now();
    clearReplacementWatchdog(channel, mediaConn);
    setCurrentMediaConnection(channel, null);
    endTrustedSystemAudioReception();
  });

  mediaConn.on('error', (err: unknown) => {
    if (!isCurrentMediaConnection(channel, mediaConn)) return;
    log.warn(`[SysAudioGuest] ${channel} error:`, err);
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
    log.warn(`[SysAudioGuest] ${channel} answer failed:`, err);
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
  clearAllReplacementWatchdogs();
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

  bus.on('system-audio:incoming-call', (mediaConn: unknown, channel: string) => {
    if (channel !== SYSTEM_AUDIO_CHANNEL) {
      log.warn(`[SysAudioGuest] Rejected obsolete system-audio call type: ${channel}`);
      closeMediaConnection(mediaConn as MediaConnection);
      return;
    }
    if (!claimGuestDirectSystemAudioRoute()) {
      log.info('[SysAudioGuest] Ignored stale direct call after all-audience SFU route froze');
      try {
        (mediaConn as MediaConnection).close();
      } catch {
        /* noop */
      }
      return;
    }
    handleIncomingCall(mediaConn as MediaConnection, channel).catch((e) =>
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

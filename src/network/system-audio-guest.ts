/**
 * MUSIXQUARE — System Audio Guest (Dual-Stream WebRTC Receiver)
 *
 * Receives L and R mono streams from host via separate MediaConnections,
 * merges them into stereo via ChannelMerger, connects to audio graph.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import { getAudioContext } from '../audio/context.ts';
import { initAudio, getWidener } from '../audio/engine.ts';
import {
  requestLegacyBoundedV1OwnerSwitchStop,
  stopAllMedia,
} from '../player/transport.ts';
import { cancelIncomingFileTransfer } from '../storage/transfer.ts';
import { cancelRemoteShareWait } from '../share/remote-share.ts';
import {
  claimPlaybackOwner,
  createSystemAudioTrackMeta,
  isSystemAudioOwner,
  isSystemAudioPlaceholderMeta,
  releasePlaybackOwner,
  setPlaybackIdle,
  setSystemAudioReceiving,
  setPlaybackTrackMeta,
} from '../player/ownership.ts';
import { registerHandler } from './protocol.ts';
import { claimGuestDirectSystemAudioRoute } from './system-audio-delivery.ts';
import type { DataConnection, MediaConnection, TrackMeta } from '../types/index.ts';

import { forceStereoSdp } from './peer.ts';
import {
  cleanupWebRtcAudioDecoderPrimer,
  getAudioTrackStreamKey,
  primeWebRtcAudioDecoder,
  type WebRtcAudioDecoderPrimer,
} from './webrtc-audio-decoder-primer.ts';

// ─── Tuning ───────────────────────────────────────────────────────
//
// playoutDelayHint target for the WebRTC audio receivers. WebRTC's NetEq
// adapts each receiver's jitter buffer independently based on packet arrival
// pattern, so two guests in the same room drift in and out of phase with each
// other as their buffers grow/shrink at different times. Setting the same
// hint on every receiver nudges them all toward the same effective delay,
// narrowing the cross-device variance.
//
// Tuning rationale:
//   < 200ms — NetEq's natural adaptive range often exceeds this anyway, so
//             the hint doesn't cap anything and we get the same drift.
//   > 600ms — host pause/skip becomes obviously laggy on guests.
//   300-500ms — hint caps adaptation while keeping responsiveness acceptable.
//   500ms favors lower cross-device variance at the upper end of that range.
const SYSTEM_AUDIO_PLAYOUT_DELAY_S = 0.5;
const SYSTEM_AUDIO_RECEIVE_WATCHDOG = 'sys-audio-guest-receive-watchdog';
const SYSTEM_AUDIO_REPLACEMENT_WATCHDOG_PREFIX = 'sys-audio-guest-replacement-watchdog';
const SYSTEM_AUDIO_CHANNELS = ['L', 'R', 'DUAL', 'STEREO', 'SYNCED'] as const;
// A 9+ device share can require one bounded SFU publication retry before the
// guest subscription is ready. Keep the watchdog finite, but leave enough
// headroom for a busy venue/NAT so a healthy large-room join is not mistaken
// for a failed receive.
const SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS = 30_000;

type SystemAudioTrackMapping = Record<string, 'L' | 'R'>;

// ─── Module State ─────────────────────────────────────────────────

let _mediaConnL: MediaConnection | null = null;
let _mediaConnR: MediaConnection | null = null;
let _mediaConnDual: MediaConnection | null = null;
let _mediaConnStereo: MediaConnection | null = null;
let _mediaConnSynced: MediaConnection | null = null;
let _sourceL: MediaStreamAudioSourceNode | null = null;
let _sourceR: MediaStreamAudioSourceNode | null = null;
let _sourceStereo: MediaStreamAudioSourceNode | null = null;
let _merger: ChannelMergerNode | null = null;
let _decoderPrimer: WebRtcAudioDecoderPrimer | null = null;
let _gotL = false;
let _gotR = false;
let _gotStereo = false;
let _gotSynced = false;
let _prevTrackMeta: unknown = null;
let _trustedReceptionGeneration = 0;
let _pendingTrustedReceptionGeneration: number | null = null;
let _trustedReceptionWaitSeq = 0;
let _initialUnmuteWaitSeq = 0;
const _replacementWatchdogs = new Map<string, MediaConnection>();

interface TrustedReceptionWaiter {
  expectedGeneration: number;
  timerName: string;
  resolve: (ready: boolean) => void;
}

const _trustedReceptionWaiters = new Set<TrustedReceptionWaiter>();

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
let _debugLastStartAt = 0;
let _debugLastStartIgnoredAt = 0;
let _debugLastStartIgnoredReason = '';
let _debugLastStopAt = 0;
let _debugLastCleanupAt = 0;
let _debugWatchdogArmedAt = 0;
let _debugWatchdogTimedOutAt = 0;
let _debugWatchdogActive = false;

function errorToDebugString(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function currentMediaConnection(channel: string): MediaConnection | null {
  if (channel === 'L') return _mediaConnL;
  if (channel === 'R') return _mediaConnR;
  if (channel === 'DUAL') return _mediaConnDual;
  if (channel === 'STEREO') return _mediaConnStereo;
  if (channel === 'SYNCED') return _mediaConnSynced;
  return null;
}

function settleTrustedReceptionWaiters(generation: number, ready: boolean): void {
  for (const waiter of [..._trustedReceptionWaiters]) {
    if (waiter.expectedGeneration !== generation) continue;
    _trustedReceptionWaiters.delete(waiter);
    clearManagedTimer(waiter.timerName);
    waiter.resolve(ready);
  }
}

function cancelAllTrustedReceptionWaiters(): void {
  for (const waiter of [..._trustedReceptionWaiters]) {
    _trustedReceptionWaiters.delete(waiter);
    clearManagedTimer(waiter.timerName);
    waiter.resolve(false);
  }
}

export function awaitTrustedSystemAudioReceptionBoundary(
  channel: string,
): Promise<boolean> {
  if (isSystemAudioPlaceholder()) return Promise.resolve(true);

  const expectedGeneration =
    _pendingTrustedReceptionGeneration ?? _trustedReceptionGeneration + 1;
  const timerName =
    `sys-audio-guest-trust-gate-${channel}-${++_trustedReceptionWaitSeq}`;

  return new Promise<boolean>((resolve) => {
    const waiter: TrustedReceptionWaiter = {
      expectedGeneration,
      timerName,
      resolve,
    };
    _trustedReceptionWaiters.add(waiter);
    setManagedTimer(
      timerName,
      () => {
        if (!_trustedReceptionWaiters.delete(waiter)) return;
        resolve(false);
      },
      SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS,
    );

    // The trusted START may have committed between the first placeholder
    // check and waiter publication.
    if (
      expectedGeneration === _trustedReceptionGeneration &&
      isSystemAudioPlaceholder()
    ) {
      _trustedReceptionWaiters.delete(waiter);
      clearManagedTimer(timerName);
      resolve(true);
    }
  });
}

function setCurrentMediaConnection(channel: string, mediaConn: MediaConnection | null): boolean {
  if (channel === 'L') _mediaConnL = mediaConn;
  else if (channel === 'R') _mediaConnR = mediaConn;
  else if (channel === 'DUAL') _mediaConnDual = mediaConn;
  else if (channel === 'STEREO') _mediaConnStereo = mediaConn;
  else if (channel === 'SYNCED') _mediaConnSynced = mediaConn;
  else return false;
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

function replaceCurrentMediaConnection(channel: string, mediaConn: MediaConnection): boolean {
  const previous = currentMediaConnection(channel);
  if (!setCurrentMediaConnection(channel, mediaConn)) return false;
  if (previous && previous !== mediaConn) closeMediaConnection(previous);
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

function getSystemAudioTrackMapping(
  metadata: MediaConnection['metadata'],
): SystemAudioTrackMapping | null {
  const mapping = metadata?.mapping;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return null;

  const typed: SystemAudioTrackMapping = {};
  for (const [trackId, channel] of Object.entries(mapping)) {
    if (channel === 'L' || channel === 'R') typed[trackId] = channel;
  }
  return Object.keys(typed).length > 0 ? typed : null;
}

function clearReceiveWatchdog(): void {
  clearManagedTimer(SYSTEM_AUDIO_RECEIVE_WATCHDOG);
  _debugWatchdogActive = false;
}

function armReceiveWatchdog(): void {
  _debugWatchdogArmedAt = Date.now();
  _debugWatchdogActive = true;
  setManagedTimer(
    SYSTEM_AUDIO_RECEIVE_WATCHDOG,
    () => {
      if (getState('systemAudio.isReceiving')) return;
      if (!isSystemAudioPlaceholder()) return;

      _debugWatchdogActive = false;
      _debugWatchdogTimedOutAt = Date.now();
      log.warn('[SysAudioGuest] Timed out waiting for system audio stream');
      bus.emit('system-audio:receive-timeout');
      cleanupGuestSystemAudio();
      bus.emit('ui:show-toast', t('system_audio.receive_failed'));
    },
    SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS,
  );
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
      bus.emit('system-audio:receive-timeout');
      cleanupGuestSystemAudio();
      bus.emit('ui:show-toast', t('system_audio.receive_failed'));
    },
    SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS,
  );
}

function clearAllReplacementWatchdogs(): void {
  for (const channel of SYSTEM_AUDIO_CHANNELS) clearReplacementWatchdog(channel);
}

function describeAudioTracks(tracks: MediaStreamTrack[]): string {
  return (
    tracks
      .map((track) => `${track.id.slice(0, 8)}:${track.readyState}${track.muted ? ':muted' : ''}`)
      .join(', ') || 'none'
  );
}

function primeGuestWindowsAudioDecoder(channel: string, tracks: MediaStreamTrack[]): void {
  _decoderPrimer = primeWebRtcAudioDecoder(
    _decoderPrimer,
    tracks,
    getAudioTrackStreamKey(channel, tracks),
    channel,
    '[SysAudioGuest]',
  );
}

async function waitForInitialUnmute(channel: string, tracks: MediaStreamTrack[]): Promise<void> {
  if (tracks.length === 0 || tracks.every((track) => !track.muted)) return;

  log.info(
    `[SysAudioGuest] ${channel} stream arrived muted; waiting for unmute before graph attach`,
  );

  await new Promise<void>((resolve) => {
    const id = ++_initialUnmuteWaitSeq;
    const timeoutTimer = `sys-audio-guest-unmute-timeout-${id}`;
    const settleTimer = `sys-audio-guest-unmute-settle-${id}`;
    let settled = false;

    const cleanup = (): void => {
      clearManagedTimer(timeoutTimer);
      clearManagedTimer(settleTimer);
      tracks.forEach((track) => track.removeEventListener('unmute', check));
    };

    const done = (reason: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      log.info(
        `[SysAudioGuest] ${channel} graph attach after ${reason}: ${describeAudioTracks(tracks)}`,
      );
      resolve();
    };

    const check = (): void => {
      if (tracks.every((track) => !track.muted)) {
        setManagedTimer(settleTimer, () => done('unmute'), 80);
      }
    };

    tracks.forEach((track) => track.addEventListener('unmute', check));
    setManagedTimer(timeoutTimer, () => done('unmute-timeout'), 2000);
    check();
  });
}

// ─── SDP Munging ──────────────────────────────────────────────────

function applySdpMunge(mc: MediaConnection): void {
  const pc = mc.peerConnection;
  if (!pc) return;

  // Guest munges both local/remote to be safe
  const originalSetLocal = pc.setLocalDescription.bind(pc);
  pc.setLocalDescription = async (desc: RTCSessionDescriptionInit) => {
    if (desc && desc.sdp) desc.sdp = forceStereoSdp(desc.sdp);
    return originalSetLocal(desc);
  };

  const originalSetRemote = pc.setRemoteDescription.bind(pc);
  pc.setRemoteDescription = async (desc: RTCSessionDescriptionInit) => {
    if (desc && desc.sdp) desc.sdp = forceStereoSdp(desc.sdp);
    return originalSetRemote(desc);
  };
}

// ─── Public API ───────────────────────────────────────────────────

export function getSystemAudioGuestDebugSnapshot() {
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
    gotL: _gotL,
    gotR: _gotR,
    gotStereo: _gotStereo,
    gotSynced: _gotSynced,
    sourceL: !!_sourceL,
    sourceR: !!_sourceR,
    sourceStereo: !!_sourceStereo,
    merger: !!_merger,
    decoderPrimer: !!_decoderPrimer,
    lastStartAt: _debugLastStartAt,
    lastStartIgnoredAt: _debugLastStartIgnoredAt,
    lastStartIgnoredReason: _debugLastStartIgnoredReason,
    lastStopAt: _debugLastStopAt,
    lastCleanupAt: _debugLastCleanupAt,
    watchdogArmedAt: _debugWatchdogArmedAt,
    watchdogTimedOutAt: _debugWatchdogTimedOutAt,
    watchdogActive: _debugWatchdogActive,
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

  if (channel === 'STEREO' || channel === 'DUAL' || channel === 'SYNCED') {
    applySdpMunge(mediaConn);
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
    await waitForInitialUnmute(channel, streamTracks);
    if (!isCurrentMediaConnection(channel, mediaConn)) return;

    // PeerJS media and data channels are independently ordered. A stream can
    // arrive before the authenticated SYSTEM_AUDIO_START frame, or while the
    // prior bounded-file output is still draining. Do not connect that stream
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
    // adaptive jitter buffer doesn't drift independently per device. See the
    // SYSTEM_AUDIO_PLAYOUT_DELAY_S comment for the rationale + tuning notes.
    // Direct-call adapters expose the underlying RTCPeerConnection here.
    const pc = mediaConn.peerConnection;
    if (pc) {
      for (const r of pc.getReceivers()) {
        // playoutDelayHint is in the WebRTC spec but not in TS's lib.dom yet.
        // Chrome/Edge implement it; on browsers that don't, the assignment is
        // a no-op (still a regular property), so the cast is safe at runtime.
        const recv = r as RTCRtpReceiver & { playoutDelayHint?: number };
        if (recv.track && recv.track.kind === 'audio') {
          recv.playoutDelayHint = SYSTEM_AUDIO_PLAYOUT_DELAY_S;
        }
      }
    }

    await initAudio();
    if (!isCurrentMediaConnection(channel, mediaConn)) return;
    const ctx = getAudioContext();
    const widener = getWidener();
    if (!widener) {
      log.error('[SysAudioGuest] Audio graph not ready');
      throw new Error('audio-graph-not-ready');
    }

    if (channel === 'STEREO') {
      primeGuestWindowsAudioDecoder(channel, streamTracks);
      if (_sourceStereo) {
        try {
          _sourceStereo.disconnect();
        } catch {
          /* noop */
        }
      }
      _sourceStereo = ctx.createMediaStreamSource(remoteStream);
      _sourceStereo.connect(widener.input);
      _gotStereo = true;
    } else {
      // Merger-based dual-channel logic
      if (!_merger) {
        _merger = ctx.createChannelMerger(2);
        _merger.connect(widener.input);
      }

      if (channel === 'DUAL' || channel === 'SYNCED') {
        const tracks = remoteStream.getAudioTracks();

        if (_sourceL) {
          try {
            _sourceL.disconnect();
          } catch {
            /* noop */
          }
        }
        if (_sourceR) {
          try {
            _sourceR.disconnect();
          } catch {
            /* noop */
          }
        }

        // Use ID-to-Channel mapping from host if available (synced mode)
        const mapping = getSystemAudioTrackMapping(mediaConn.metadata);
        const connectDualTracks = (
          leftTrack: MediaStreamTrack,
          rightTrack: MediaStreamTrack,
          reason: string,
        ): void => {
          log.info(`[SysAudioGuest] ${reason}`);
          primeGuestWindowsAudioDecoder(channel, [leftTrack, rightTrack]);
          _sourceL = ctx.createMediaStreamSource(new MediaStream([leftTrack]));
          _sourceL.connect(_merger!, 0, 0);
          _gotL = true;
          _sourceR = ctx.createMediaStreamSource(new MediaStream([rightTrack]));
          _sourceR.connect(_merger!, 0, 1);
          _gotR = true;
        };

        if (mapping && tracks.length >= 2) {
          const mappedL = tracks.find((track) => mapping[track.id] === 'L');
          const mappedR = tracks.find((track) => mapping[track.id] === 'R');
          if (mappedL && mappedR) {
            connectDualTracks(
              mappedL,
              mappedR,
              'Using ID-based track mapping for crystal-clear stereo',
            );
          } else {
            log.warn(
              '[SysAudioGuest] Track ID mapping did not match remote IDs; falling back to track order',
            );
            connectDualTracks(tracks[0], tracks[1], 'Using track-order stereo fallback');
          }
        } else if (tracks.length >= 2) {
          // Standard track order (default)
          connectDualTracks(tracks[0], tracks[1], 'Using track-order stereo mapping');
        } else {
          // Failsafe: Upmix single track to center
          log.info(
            `[SysAudioGuest] ${channel} received with ONLY 1 track. Upmixing to mono-center.`,
          );
          primeGuestWindowsAudioDecoder(channel, [tracks[0]]);
          const monoSource = ctx.createMediaStreamSource(new MediaStream([tracks[0]]));
          monoSource.connect(_merger, 0, 0);
          monoSource.connect(_merger, 0, 1);
          _sourceL = monoSource;
          _gotL = true;
          _gotR = true;
        }

        if (channel === 'SYNCED') _gotSynced = true;
      } else {
        primeGuestWindowsAudioDecoder(channel, streamTracks);
        const source = ctx.createMediaStreamSource(remoteStream);
        if (channel === 'L') {
          if (_sourceL) {
            try {
              _sourceL.disconnect();
            } catch {
              /* noop */
            }
          }
          _sourceL = source;
          source.connect(_merger, 0, 0);
          _gotL = true;
        } else {
          if (_sourceR) {
            try {
              _sourceR.disconnect();
            } catch {
              /* noop */
            }
          }
          _sourceR = source;
          source.connect(_merger, 0, 1);
          _gotR = true;
        }
      }
    }

    debug.graphAt = Date.now();
    debug.graphError = undefined;
    clearReplacementWatchdog(channel, mediaConn);

    // Update state once at least one stream is connected
    if (!getState('systemAudio.isReceiving')) {
      clearReceiveWatchdog();
      setSystemAudioReceiving(true);
      claimPlaybackOwner('system-audio');
      bus.emit('visualizer:start');
      log.info(`[SysAudioGuest] System audio connected to graph (${channel})`);
    }
  };

  mediaConn.on('stream', (remoteStream: MediaStream) => {
    void attachStream(remoteStream).catch((error: unknown) => {
      // A replacement connection can win while initial unmute/audio init is
      // awaiting. A stale rejection must never tear down its successor.
      if (!isCurrentMediaConnection(channel, mediaConn)) return;
      debug.graphError = errorToDebugString(error);
      log.warn(`[SysAudioGuest] ${channel} stream graph failed:`, error);
      cleanupGuestSystemAudio();
      bus.emit('ui:show-toast', t('system_audio.receive_failed'));
    });
  });

  mediaConn.on('close', () => {
    if (!isCurrentMediaConnection(channel, mediaConn)) return;
    log.info(`[SysAudioGuest] ${channel} MediaConnection closed`);
    debug.closedAt = Date.now();
    clearReplacementWatchdog(channel, mediaConn);
    setCurrentMediaConnection(channel, null);
    if (channel === 'DUAL' || channel === 'SYNCED') {
      _gotL = false;
      _gotR = false;
      if (channel === 'SYNCED') _gotSynced = false;
    } else if (channel === 'L') {
      _gotL = false;
    } else if (channel === 'R') {
      _gotR = false;
    } else if (channel === 'STEREO') {
      _gotStereo = false;
    }
    if (!_gotL && !_gotR && !_gotStereo && !_gotSynced) cleanupGuestSystemAudio();
  });

  mediaConn.on('error', (err: unknown) => {
    if (!isCurrentMediaConnection(channel, mediaConn)) return;
    log.warn(`[SysAudioGuest] ${channel} error:`, err);
    debug.error = errorToDebugString(err);
  });

  // Register stream/close/error handlers before answer(). Fast local desktop
  // peers can emit the stream event immediately after answering.
  try {
    mediaConn.answer();
    debug.answerAt = Date.now();
    debug.answerError = undefined;
  } catch (err) {
    log.warn(`[SysAudioGuest] ${channel} answer failed:`, err);
    debug.answerError = errorToDebugString(err);
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────

// Shared by the direct-call and SFU receive adapters; this module owns the
// placeholder and previous-track metadata restoration contract.
export function cleanupGuestSystemAudio(): void {
  _trustedReceptionGeneration += 1;
  _pendingTrustedReceptionGeneration = null;
  cancelAllTrustedReceptionWaiters();
  _debugLastCleanupAt = Date.now();
  const wasSystemAudioPlaceholder = isSystemAudioPlaceholder();
  clearReceiveWatchdog();
  clearAllReplacementWatchdogs();
  if (_sourceL) {
    try {
      _sourceL.disconnect();
    } catch {
      /* noop */
    }
    _sourceL = null;
  }
  if (_sourceR) {
    try {
      _sourceR.disconnect();
    } catch {
      /* noop */
    }
    _sourceR = null;
  }
  if (_sourceStereo) {
    try {
      _sourceStereo.disconnect();
    } catch {
      /* noop */
    }
    _sourceStereo = null;
  }
  cleanupWebRtcAudioDecoderPrimer(_decoderPrimer);
  _decoderPrimer = null;
  if (_merger) {
    try {
      _merger.disconnect();
    } catch {
      /* noop */
    }
    _merger = null;
  }
  // Clear identities before close() so synchronous/stale close events cannot
  // recursively clean the graph or null a replacement connection.
  const mediaConnections = new Set([
    _mediaConnL,
    _mediaConnR,
    _mediaConnDual,
    _mediaConnStereo,
    _mediaConnSynced,
  ]);
  _mediaConnL = null;
  _mediaConnR = null;
  _mediaConnDual = null;
  _mediaConnStereo = null;
  _mediaConnSynced = null;
  for (const mediaConn of mediaConnections) closeMediaConnection(mediaConn);
  _gotL = false;
  _gotR = false;
  _gotStereo = false;
  _gotSynced = false;

  setSystemAudioReceiving(false);
  setPlaybackTrackMeta(_prevTrackMeta ?? null);
  _prevTrackMeta = null;
  if (isSystemAudioOwner() || wasSystemAudioPlaceholder) {
    releasePlaybackOwner('system-audio', {
      force: wasSystemAudioPlaceholder,
    });
    setPlaybackIdle();
  }
}

/**
 * Enter the trusted receive placeholder without requiring a legacy host
 * frame. PRO rooms call this only after the coordinator has fetched the
 * server-owned live-share lease.
 */
export function beginTrustedSystemAudioReception(): boolean {
  if (isSystemAudioPlaceholder() || _pendingTrustedReceptionGeneration !== null) {
    return false;
  }
  const generation = ++_trustedReceptionGeneration;
  _pendingTrustedReceptionGeneration = generation;
  const boundedStop = requestLegacyBoundedV1OwnerSwitchStop();
  if (boundedStop) {
    void boundedStop.settled
      .then((stopped) => {
        if (
          !stopped ||
          !boundedStop.isCurrent() ||
          generation !== _trustedReceptionGeneration ||
          isSystemAudioPlaceholder()
        ) {
          if (_pendingTrustedReceptionGeneration === generation) {
            _pendingTrustedReceptionGeneration = null;
          }
          settleTrustedReceptionWaiters(generation, false);
          return;
        }
        const committed = commitTrustedSystemAudioReception();
        if (_pendingTrustedReceptionGeneration === generation) {
          _pendingTrustedReceptionGeneration = null;
        }
        settleTrustedReceptionWaiters(generation, committed);
      })
      .catch((error) => {
        if (_pendingTrustedReceptionGeneration === generation) {
          _pendingTrustedReceptionGeneration = null;
        }
        settleTrustedReceptionWaiters(generation, false);
        log.warn('[SysAudioGuest] Bounded file-owner stop failed:', error);
      });
    return true;
  }
  const committed = commitTrustedSystemAudioReception();
  if (_pendingTrustedReceptionGeneration === generation) {
    _pendingTrustedReceptionGeneration = null;
  }
  settleTrustedReceptionWaiters(generation, committed);
  return committed;
}

function commitTrustedSystemAudioReception(): boolean {
  if (isSystemAudioPlaceholder()) return false;
  _debugLastStartAt = Date.now();
  _debugLastStartIgnoredReason = '';
  _prevTrackMeta = getState('player.currentTrackMeta') as TrackMeta | null;
  stopAllMedia({ silent: true, cancelInFlight: true });
  cancelIncomingFileTransfer('system-audio-start');
  cancelRemoteShareWait('system-audio-start');
  clearManagedTimer('preloadWatchdog');
  claimPlaybackOwner('system-audio', {
    pending: true,
    currentTrackMeta: createSystemAudioTrackMeta('receiving'),
  });
  bus.emit('system-audio:host-started');
  armReceiveWatchdog();
  return true;
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemAudioGuestListeners(): void {
  // Drop SYSTEM_AUDIO_START/STOP frames not arriving via hostConn. The host
  // triggers these via audio/system-capture.ts and guests only trust that
  // authenticated host connection. Without this guard, a peer can:
  //   - send raw SYSTEM_AUDIO_START → stopAllMedia() + clobber
  //     _prevTrackMeta + spoof a "Receiving System Audio" track on the
  //     target. Single-frame DoS on whatever the user is playing.
  //   - send raw SYSTEM_AUDIO_STOP → force cleanupGuestSystemAudio() on a
  //     guest legitimately receiving host's system audio. Single-frame
  //     DoS on the actual reception.
  function isHostBroadcast(conn: DataConnection | undefined): boolean {
    const hostConn = getState('network.hostConn');
    return !!hostConn && conn === hostConn;
  }

  registerHandler(
    MSG.SYSTEM_AUDIO_START,
    (_data: Record<string, unknown>, conn?: DataConnection) => {
      if (!isHostBroadcast(conn)) {
        _debugLastStartIgnoredAt = Date.now();
        _debugLastStartIgnoredReason = conn ? 'non-host-connection' : 'missing-connection';
        return;
      }
      if (isSystemAudioPlaceholder()) {
        _debugLastStartIgnoredAt = Date.now();
        _debugLastStartIgnoredReason = 'duplicate-placeholder';
        log.debug('[SysAudioGuest] Duplicate system audio start ignored');
        return;
      }
      log.info('[SysAudioGuest] Host started system audio sharing');
      beginTrustedSystemAudioReception();
    },
  );

  registerHandler(
    MSG.SYSTEM_AUDIO_STOP,
    (_data: Record<string, unknown>, conn?: DataConnection) => {
      if (!isHostBroadcast(conn)) return;
      log.info('[SysAudioGuest] Host stopped system audio sharing');
      _debugLastStopAt = Date.now();
      cleanupGuestSystemAudio();
      bus.emit('system-audio:host-stopped');
    },
  );

  bus.on('system-audio:incoming-call', (mediaConn: unknown, channel: string) => {
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
    if (value === true) clearReceiveWatchdog();
  });

  bus.on('system-audio:delivery-handoff', () => {
    if (getState('network.appRole') !== 'guest') return;
    if (!isSystemAudioPlaceholder()) return;
    // Preserve the current system-audio placeholder/previous-track restore
    // point, but make the replacement adapter earn the receiving state again.
    // This covers both SFU retry handoff and SFU -> bounded direct fallback.
    setSystemAudioReceiving(false);
    armReceiveWatchdog();
  });

  bus.on('system-audio:force-stop', () => {
    cleanupGuestSystemAudio();
  });
}

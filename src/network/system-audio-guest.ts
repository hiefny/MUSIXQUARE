/**
 * MUSIXQUARE 4.0 — System Audio Guest (Dual-Stream WebRTC Receiver)
 *
 * Receives L and R mono streams from host via separate MediaConnections,
 * merges them into stereo via ChannelMerger, connects to audio graph.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { APP_STATE, MSG } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import { getAudioContext } from '../audio/context.ts';
import { initAudio, getWidener } from '../audio/engine.ts';
import { stopAllMedia } from '../player/transport.ts';
import {
  claimPlaybackOwner,
  createSystemAudioTrackMeta,
  isAppStatePlayingSystemAudio,
  isSystemAudioPlaceholderMeta,
  releasePlaybackOwner,
  setSystemAudioReceiving,
  setPlaybackTrackMeta,
} from '../player/ownership.ts';
import { registerHandler } from './protocol.ts';
import type { DataConnection, MediaConnection, TrackMeta } from '../types/index.ts';

import { forceStereoSdp } from './peer.ts';
import {
  cleanupWindowsAudioDecoderPrimer,
  getAudioTrackStreamKey,
  primeWindowsAudioDecoder,
  type WindowsAudioDecoderPrimer,
} from './windows-audio-decoder-primer.ts';

// ─── Tuning ───────────────────────────────────────────────────────
//
// playoutDelayHint target for the WebRTC audio receivers. WebRTC's NetEq
// adapts each receiver's jitter buffer independently based on packet arrival
// pattern, so two guests in the same room drift in and out of phase with each
// other as their buffers grow/shrink at different times. Setting the same
// hint on every receiver nudges them all toward the same effective delay,
// narrowing the cross-device variance.
//
// Tuning rationale (heuristic — verify on real devices):
//   < 200ms — NetEq's natural adaptive range often exceeds this anyway, so
//             the hint doesn't cap anything and we get the same drift.
//   > 600ms — host pause/skip becomes obviously laggy on guests.
//   300-500ms — hint actually caps adaptation, while keeping responsiveness
//               acceptable. 0.4s as the starting point; revisit after real-
//               device tests on typical home routers.
const SYSTEM_AUDIO_PLAYOUT_DELAY_S = 0.5;
const SYSTEM_AUDIO_RECEIVE_WATCHDOG = 'sys-audio-guest-receive-watchdog';
const SYSTEM_AUDIO_RECEIVE_TIMEOUT_MS = 12_000;

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
let _decoderPrimer: WindowsAudioDecoderPrimer | null = null;
let _gotL = false;
let _gotR = false;
let _gotStereo = false;
let _gotSynced = false;
let _prevTrackMeta: unknown = null;
let _initialUnmuteWaitSeq = 0;

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
}

function armReceiveWatchdog(): void {
  setManagedTimer(
    SYSTEM_AUDIO_RECEIVE_WATCHDOG,
    () => {
      if (getState('systemAudio.isReceiving')) return;
      if (!isSystemAudioPlaceholder()) return;

      log.warn('[SysAudioGuest] Timed out waiting for system audio stream');
      bus.emit('system-audio:receive-timeout');
      cleanupGuestSystemAudio();
      bus.emit('ui:show-toast', t('system_audio.receive_failed'));
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

function primeGuestWindowsAudioDecoder(channel: string, tracks: MediaStreamTrack[]): void {
  _decoderPrimer = primeWindowsAudioDecoder(
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

export function isReceivingSystemAudio(): boolean {
  return _gotL || _gotR || _gotStereo || _gotSynced;
}

// ─── Handle Incoming Media Call ───────────────────────────────────

async function handleIncomingCall(mediaConn: MediaConnection, channel: string): Promise<void> {
  log.info(`[SysAudioGuest] Incoming ${channel} channel call`);

  if (channel === 'L') {
    if (_mediaConnL) {
      try {
        _mediaConnL.close();
      } catch {
        /* noop */
      }
    }
    _mediaConnL = mediaConn;
  } else if (channel === 'R') {
    if (_mediaConnR) {
      try {
        _mediaConnR.close();
      } catch {
        /* noop */
      }
    }
    _mediaConnR = mediaConn;
  } else if (channel === 'DUAL' || channel === 'SYNCED') {
    if (channel === 'DUAL') {
      if (_mediaConnDual) {
        try {
          _mediaConnDual.close();
        } catch {
          /* noop */
        }
      }
      _mediaConnDual = mediaConn;
    } else {
      if (_mediaConnSynced) {
        try {
          _mediaConnSynced.close();
        } catch {
          /* noop */
        }
      }
      _mediaConnSynced = mediaConn;
    }
  } else if (channel === 'STEREO') {
    if (_mediaConnStereo) {
      try {
        _mediaConnStereo.close();
      } catch {
        /* noop */
      }
    }
    _mediaConnStereo = mediaConn;
  }

  if (channel === 'STEREO' || channel === 'DUAL' || channel === 'SYNCED') {
    applySdpMunge(mediaConn);
  }

  mediaConn.on('stream', async (remoteStream: MediaStream) => {
    log.info(`[SysAudioGuest] Received ${channel} stream`);
    const streamTracks = remoteStream.getAudioTracks();
    log.info(`[SysAudioGuest] ${channel} stream tracks: ${describeAudioTracks(streamTracks)}`);
    await waitForInitialUnmute(channel, streamTracks);

    // Pin every audio receiver to the same playout-delay target so NetEq's
    // adaptive jitter buffer doesn't drift independently per device. See the
    // SYSTEM_AUDIO_PLAYOUT_DELAY_S comment for the rationale + tuning notes.
    // PeerJS/Cloudflare adapters expose the underlying RTCPeerConnection here.
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
    const ctx = getAudioContext();
    const widener = getWidener();
    if (!widener) {
      log.error('[SysAudioGuest] Audio graph not ready');
      return;
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
        if (tracks.length === 0) {
          log.warn(`[SysAudioGuest] ${channel} stream received but 0 tracks found`);
          return;
        }

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

    // Update state once at least one stream is connected
    if (!getState('systemAudio.isReceiving')) {
      clearReceiveWatchdog();
      setSystemAudioReceiving(true);
      claimPlaybackOwner('system-audio');
      bus.emit('visualizer:start');
      log.info(`[SysAudioGuest] System audio connected to graph (${channel})`);
    }
  });

  mediaConn.on('close', () => {
    log.info(`[SysAudioGuest] ${channel} MediaConnection closed`);
    if (channel === 'DUAL' || channel === 'SYNCED') {
      _gotL = false;
      _gotR = false;
      if (channel === 'DUAL') _mediaConnDual = null;
      else {
        _mediaConnSynced = null;
        _gotSynced = false;
      }
    } else if (channel === 'L') {
      _gotL = false;
      _mediaConnL = null;
    } else if (channel === 'R') {
      _gotR = false;
      _mediaConnR = null;
    } else if (channel === 'STEREO') {
      _gotStereo = false;
      _mediaConnStereo = null;
    }
    if (!_gotL && !_gotR && !_gotStereo && !_gotSynced) cleanupGuestSystemAudio();
  });

  mediaConn.on('error', (err: unknown) => {
    log.warn(`[SysAudioGuest] ${channel} error:`, err);
  });

  // Register stream/close/error handlers before answer(). Fast local desktop
  // peers can emit the PeerJS stream event immediately after answering.
  try {
    mediaConn.answer();
  } catch (err) {
    log.warn(`[SysAudioGuest] ${channel} answer failed:`, err);
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────

function cleanupGuestSystemAudio(): void {
  const wasSystemAudioPlaceholder = isSystemAudioPlaceholder();
  clearReceiveWatchdog();
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
  cleanupWindowsAudioDecoderPrimer(_decoderPrimer);
  _decoderPrimer = null;
  if (_merger) {
    try {
      _merger.disconnect();
    } catch {
      /* noop */
    }
    _merger = null;
  }
  if (_mediaConnL) {
    try {
      _mediaConnL.close();
    } catch {
      /* noop */
    }
    _mediaConnL = null;
  }
  if (_mediaConnR) {
    try {
      _mediaConnR.close();
    } catch {
      /* noop */
    }
    _mediaConnR = null;
  }
  if (_mediaConnDual) {
    try {
      _mediaConnDual.close();
    } catch {
      /* noop */
    }
    _mediaConnDual = null;
  }
  if (_mediaConnStereo) {
    try {
      _mediaConnStereo.close();
    } catch {
      /* noop */
    }
    _mediaConnStereo = null;
  }
  if (_mediaConnSynced) {
    try {
      _mediaConnSynced.close();
    } catch {
      /* noop */
    }
    _mediaConnSynced = null;
  }
  _gotL = false;
  _gotR = false;
  _gotStereo = false;
  _gotSynced = false;

  setSystemAudioReceiving(false);
  setPlaybackTrackMeta(_prevTrackMeta ?? null);
  _prevTrackMeta = null;
  if (isAppStatePlayingSystemAudio() || wasSystemAudioPlaceholder) {
    releasePlaybackOwner('system-audio', {
      force: wasSystemAudioPlaceholder,
      nextAppState: APP_STATE.IDLE,
    });
  }
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
      if (!isHostBroadcast(conn)) return;
      const currentMeta = getState('player.currentTrackMeta') as TrackMeta | null;
      if (isSystemAudioPlaceholder()) {
        log.debug('[SysAudioGuest] Duplicate system audio start ignored');
        return;
      }
      log.info('[SysAudioGuest] Host started system audio sharing');
      _prevTrackMeta = currentMeta;
      stopAllMedia({ silent: true, cancelInFlight: true });
      claimPlaybackOwner('system-audio', {
        pending: true,
        currentTrackMeta: createSystemAudioTrackMeta('receiving'),
      });
      armReceiveWatchdog();
    },
  );

  registerHandler(
    MSG.SYSTEM_AUDIO_STOP,
    (_data: Record<string, unknown>, conn?: DataConnection) => {
      if (!isHostBroadcast(conn)) return;
      log.info('[SysAudioGuest] Host stopped system audio sharing');
      cleanupGuestSystemAudio();
      bus.emit('system-audio:host-stopped');
    },
  );

  bus.on('system-audio:incoming-call', (mediaConn: unknown, channel: string) => {
    handleIncomingCall(mediaConn as MediaConnection, channel).catch((e) =>
      log.error('[SysAudioGuest] handleIncomingCall failed:', e),
    );
  });

  bus.on('state:systemAudio.isReceiving', (value) => {
    if (value === true) clearReceiveWatchdog();
  });

  bus.on('system-audio:force-stop', () => {
    cleanupGuestSystemAudio();
  });
}

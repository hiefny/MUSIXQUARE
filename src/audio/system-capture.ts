/**
 * MUSIXQUARE 4.0 — System Audio Capture
 *
 * Host-side module for capturing system audio via getDisplayMedia.
 * Splits into L/R mono MediaStreams for WebRTC transmission
 * (bypasses Chrome Opus mono limitation via dual-stream approach).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import {
  MSG,
  WARN_WHEN_MAX_SLOTS_AT_LEAST,
  type PlaybackActivityValue,
  type PlaybackModeValue,
} from '../core/constants.ts';
import { t } from '../i18n/index.ts';
import { getAudioContext } from './context.ts';
import { initAudio, getWidener, getMasterGain } from './engine.ts';
import { stopAllMedia } from '../player/transport.ts';
import {
  claimPlaybackOwner,
  createSystemAudioTrackMeta,
  getPlaybackModeActivitySnapshot,
  setPlaybackFilePaused,
  setPlaybackIdle,
  setPlaybackTrackMeta,
} from '../player/ownership.ts';
import { broadcast } from '../network/peer.ts';
import { broadcastSystemNotice, clearLatestPinnedNotice } from '../chat/protocol.ts';
import { showDialog } from '../ui/dialog.ts';
import { hasSysAudioWarned, markSysAudioWarned } from '../ui/large-room-warnings.ts';
import type { TrackMeta } from '../types/index.ts';

// ─── Module State ─────────────────────────────────────────────────

let _capturedStream: MediaStream | null = null;
let _sourceNode: MediaStreamAudioSourceNode | null = null;
let _streamL: MediaStream | null = null;
let _streamR: MediaStream | null = null;
let _destL: MediaStreamAudioDestinationNode | null = null;
let _destR: MediaStreamAudioDestinationNode | null = null;
// M15: Track intermediate graph nodes so cleanupCapture can disconnect them.
// Previously these were local variables in startSystemAudioCapture, leaking
// connected AudioNodes on each start/stop cycle.
let _splitter: ChannelSplitterNode | null = null;
let _stereoUpmix: GainNode | null = null;
let _debugLastCaptureStartedAt = 0;
let _debugLastCaptureStoppedAt = 0;
let _debugLastStartBroadcastAt = 0;
let _debugLastStopBroadcastAt = 0;
let _debugLastStreamsReadyAt = 0;

interface PreSystemAudioState {
  playback: {
    mode: PlaybackModeValue;
    activity: PlaybackActivityValue;
  };
  pausedAt: number;
  currentTrackMeta: TrackMeta | null;
  channelMode: number;
  trackIndex: number;
  subIndex: number;
}

let _preSysAudioState: PreSystemAudioState | null = null;

// ─── Public API ───────────────────────────────────────────────────

export function isSystemAudioActive(): boolean {
  return _capturedStream !== null && _capturedStream.active;
}

/** Get the L track stream */
export function getStreamL(): MediaStream | null {
  return _streamL;
}
/** Get the R track stream */
export function getStreamR(): MediaStream | null {
  return _streamR;
}

/** Get the original captured audio track as a stereo stream for local P2P fallback. */
export function getCapturedAudioStream(): MediaStream | null {
  const tracks = _capturedStream?.getAudioTracks() || [];
  if (tracks.length === 0) return null;
  return new MediaStream(tracks);
}

function describeTrack(track: MediaStreamTrack | undefined): string {
  if (!track) return 'none';
  return `${track.id.slice(0, 8)}:${track.readyState}${track.muted ? ':muted' : ''}`;
}

export function getSystemAudioCaptureDebugSnapshot(): Record<string, unknown> {
  const capturedTracks = _capturedStream?.getAudioTracks() || [];
  const leftTracks = _streamL?.getAudioTracks() || [];
  const rightTracks = _streamR?.getAudioTracks() || [];

  return {
    active: isSystemAudioActive(),
    capturedStreamActive: _capturedStream?.active ?? false,
    capturedTracks: capturedTracks.map(describeTrack),
    sourceNode: !!_sourceNode,
    splitter: !!_splitter,
    stereoUpmix: !!_stereoUpmix,
    destL: !!_destL,
    destR: !!_destR,
    streamLActive: _streamL?.active ?? false,
    streamRActive: _streamR?.active ?? false,
    streamLTracks: leftTracks.map(describeTrack),
    streamRTracks: rightTracks.map(describeTrack),
    lastCaptureStartedAt: _debugLastCaptureStartedAt,
    lastCaptureStoppedAt: _debugLastCaptureStoppedAt,
    lastStartBroadcastAt: _debugLastStartBroadcastAt,
    lastStopBroadcastAt: _debugLastStopBroadcastAt,
    lastStreamsReadyAt: _debugLastStreamsReadyAt,
  };
}

/**
 * Start system audio capture.
 * MUST be called from a user gesture handler (click event).
 */
export async function startSystemAudioCapture(): Promise<void> {
  if (isSystemAudioActive()) {
    log.warn('[SystemAudio] Already capturing');
    return;
  }

  // 0.5 Warn if many devices connected
  const connectedPeers = getState('network.connectedPeers');
  if (connectedPeers.length >= 4) {
    bus.emit('ui:show-toast', t('system_audio.many_devices_warning'));
  }

  // 0.6 Large-room soft warning: only when the host has opted into a bigger
  // slot cap (≥6). Once per session. The dialog's confirm click re-asserts
  // user activation so the getDisplayMedia call below still works.
  const maxSlots = getState('network.maxGuestSlots') ?? 3;
  if (maxSlots >= WARN_WHEN_MAX_SLOTS_AT_LEAST && !hasSysAudioWarned()) {
    const res = await showDialog({
      title: t('dialog.large_room_sysaudio.title'),
      message: t('dialog.large_room_sysaudio.message'),
      buttonText: t('dialog.continue'),
      secondaryText: t('common.cancel'),
    });
    if (res.action !== 'ok') return;
    markSysAudioWarned();
  }

  // 1. Capture FIRST (user gesture must be synchronous call stack)
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        channelCount: 2,
        sampleRate: 48000,
        autoGainControl: false,
        noiseSuppression: false,
        echoCancellation: false,
      },
    });
  } catch (e) {
    log.warn('[SystemAudio] getDisplayMedia denied or failed:', e);
    bus.emit('ui:show-toast', t('system_audio.capture_denied'));
    return;
  }

  // Discard video track
  for (const vt of stream.getVideoTracks()) vt.stop();

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    log.warn('[SystemAudio] No audio track');
    bus.emit('ui:show-toast', t('system_audio.no_audio_track'));
    return;
  }

  // 2. Save previous state
  // Note: `playlist.currentTrackIndex` isn't captured — `stopAllMedia({silent:true})`
  // below doesn't clobber it, so state is preserved in place and nothing to restore.
  const playback = getPlaybackModeActivitySnapshot();
  _preSysAudioState = {
    playback,
    pausedAt: getState('player.pausedAt'),
    currentTrackMeta: getState('player.currentTrackMeta'),
    channelMode: getState('audio.channelMode'),
    trackIndex: getState('playlist.currentTrackIndex'),
    subIndex: getState('youtube.currentSubIndex'),
  };

  // 3. Stop all current media
  stopAllMedia({ silent: true, cancelInFlight: true });

  // 3.5 UI only: show stereo button as active (actual channelMode unchanged)
  try {
    document
      .querySelectorAll('#grid-standard .ch-opt')
      .forEach((el) => el.classList.remove('active'));
    document.querySelector('#grid-standard .ch-opt[data-ch="0"]')?.classList.add('active');
  } catch {
    /* noop */
  }

  // 4. Init audio
  await initAudio();
  const ctx = getAudioContext();
  _capturedStream = stream;
  _debugLastCaptureStartedAt = Date.now();
  _sourceNode = ctx.createMediaStreamSource(stream);

  // 5. Connect to L and R mono MediaStream destinations for synced P2P
  _splitter = ctx.createChannelSplitter(2);
  const splitter = _splitter;
  _sourceNode.connect(splitter);

  _destL = ctx.createMediaStreamDestination();
  _destL.channelCount = 1;
  _destL.channelCountMode = 'explicit';
  splitter.connect(_destL, 0);
  _streamL = _destL.stream;

  _destR = ctx.createMediaStreamDestination();
  _destR.channelCount = 1;
  _destR.channelCountMode = 'explicit';
  splitter.connect(_destR, 1);
  _streamR = _destR.stream;

  log.info(
    `[SystemAudio] L/R mono streams created for synced P2P: L=${_streamL.id.slice(0, 8)}, R=${_streamR.id.slice(0, 8)}`,
  );

  // 6. Local graph: upmix for safety
  _stereoUpmix = ctx.createGain();
  const stereoUpmix = _stereoUpmix;
  stereoUpmix.channelCount = 2;
  stereoUpmix.channelCountMode = 'explicit';
  stereoUpmix.channelInterpretation = 'speakers';
  _sourceNode.connect(stereoUpmix);

  const widener = getWidener();
  if (widener) {
    stereoUpmix.connect(widener.input);
  } else {
    log.error('[SystemAudio] No widener found');
    cleanupCapture();
    return;
  }

  // 7. Host mute local (always mute — avoid double audio)
  muteLocalOutput(true);

  // 8. Update state
  // System audio is a real playback experience. Once it has successfully
  // started, later playlist clicks should behave like post-first-use actions
  // instead of falling back to the initial "ready, press Play" cue flow.
  setState('player.isFirstTrackLoad', false);
  claimPlaybackOwner('system-audio', {
    currentTrackMeta: createSystemAudioTrackMeta('sharing'),
  });

  // 9. Broadcast start + call guests with L/R streams
  _debugLastStartBroadcastAt = Date.now();
  broadcast({ type: MSG.SYSTEM_AUDIO_START });
  _debugLastStreamsReadyAt = Date.now();
  bus.emit('system-audio:streams-ready');

  // 9.1 Localized chat notice for everyone in the room. Same pattern as the
  // decode-skip notice — each device renders in its own locale.
  broadcastSystemNotice('chat.system_audio_started_notice');

  // 10. Advisory toast — latency is unavoidable, and the host's
  // desktop speakers would otherwise drown out the distributed feed.
  bus.emit('ui:show-toast', t('system_audio.started'));

  // 11. Start visualizer
  bus.emit('visualizer:start');

  // 11. Listen for browser "Stop sharing" button
  // Use a named function so cleanupCapture can remove it (prevents
  // recursive reentry: explicit stop → track.stop() → ended → stop again).
  const onTrackEnded = (): void => {
    audioTracks[0].removeEventListener('ended', onTrackEnded);
    log.info('[SystemAudio] Audio track ended (user stopped sharing)');
    stopSystemAudioCapture();
  };
  audioTracks[0].addEventListener('ended', onTrackEnded);

  log.info('[SystemAudio] Capture started (stereo-stream)');
}

/**
 * Stop system audio capture.
 *
 * `restore` (default true) controls whether the pre-share playback snapshot
 * is restored. Explicit user stops (공유 중지 button, browser "Stop sharing",
 * error cleanup) restore. The `system-audio:force-stop` path passes
 * restore:false — force-stop only ever fires from TRANSITION/teardown
 * contexts (stopAllMedia during a track/mode change, demo entry,
 * leaveSession) where another playback flow is already taking over.
 * Restoring there ran synchronously INSIDE that flow and stomped it:
 * pre-share YouTube resurrected room-wide while the clicked file's decode
 * aborted on the external-owner gate (SA-02,
 * docs/scenario-audit-2026-06-10.md).
 */
export function stopSystemAudioCapture(opts?: { restore?: boolean }): void {
  if (!isSystemAudioActive() && !_capturedStream) return;
  const shouldRestore = opts?.restore ?? true;

  _debugLastStopBroadcastAt = Date.now();
  broadcast({ type: MSG.SYSTEM_AUDIO_STOP });
  broadcastSystemNotice('chat.system_audio_stopped_notice');
  // Current participants should see the stop notice, but late joiners should not
  // inherit a stale "stopped" banner after regular playback resumes.
  clearLatestPinnedNotice();
  cleanupCapture();
  muteLocalOutput(false);

  if (shouldRestore && _preSysAudioState) {
    restorePreSystemAudioPlaybackState(_preSysAudioState);
  } else if (shouldRestore) {
    setPlaybackTrackMeta(null);
    setPlaybackIdle();
  } else {
    // Transition teardown: release system-audio ownership so the caller's
    // flow (play()/youtube:load) can claim the next mode — but do NOT touch
    // currentTrackMeta: the in-progress selection (e.g. playTrack) already
    // set the new track's meta before reaching us.
    setPlaybackIdle();
  }
  // Discard the snapshot in every path — a stale snapshot surviving a
  // transition would leak into a later explicit stop.
  _preSysAudioState = null;

  // Toast only on explicit stop. The copy promises the playlist resumes,
  // which is only (approximately) true on the restore path; on force-stop
  // transitions another flow's own UI takes over immediately and this toast
  // would stack a false claim on top of it.
  if (shouldRestore) bus.emit('ui:show-toast', t('system_audio.stopped'));
  _debugLastCaptureStoppedAt = Date.now();
  log.info('[SystemAudio] Capture stopped');
}

export function restorePreSystemAudioPlaybackState(snapshot: PreSystemAudioState): void {
  setState('player.pausedAt', snapshot.pausedAt);
  setPlaybackTrackMeta(snapshot.currentTrackMeta ?? null);

  // Restore channel UI to previous selection.
  try {
    document
      .querySelectorAll('#grid-standard .ch-opt')
      .forEach((el) => el.classList.remove('active'));
    document
      .querySelector(`#grid-standard .ch-opt[data-ch="${snapshot.channelMode}"]`)
      ?.classList.add('active');
  } catch {
    /* noop */
  }

  // YouTube was playing: restore through the room-wide YouTube command path.
  if (snapshot.playback.mode === 'youtube') {
    const meta = snapshot.currentTrackMeta;
    const playlist = getState('playlist.items') || [];
    const item = snapshot.trackIndex >= 0 ? playlist[snapshot.trackIndex] : undefined;
    const videoId = meta?.videoId || item?.videoId || null;
    const playlistId = meta?.playlistId || item?.playlistId || null;
    if (videoId || playlistId) {
      bus.emit('youtube:restore-room-playback', {
        videoId,
        playlistId,
        name: meta?.name || meta?.title || item?.name || item?.title || null,
        index: snapshot.trackIndex,
        autoplay: true,
        subIndex: snapshot.subIndex,
      });
    } else {
      setPlaybackFilePaused();
    }
    return;
  }

  if (snapshot.playback.activity === 'playing' || snapshot.playback.activity === 'paused') {
    setPlaybackFilePaused();
  } else {
    setPlaybackIdle();
  }
}

function muteLocalOutput(mute: boolean): void {
  const masterGain = getMasterGain();
  const ctx = getAudioContext();
  if (!masterGain) return;

  try {
    if (mute) masterGain.disconnect(ctx.destination);
    else masterGain.connect(ctx.destination);
  } catch (e) {
    log.debug('[SystemAudio] mute/unmute error:', e);
  }
}

// ─── Internals ────────────────────────────────────────────────────

function cleanupCapture(): void {
  if (_sourceNode) {
    try {
      _sourceNode.disconnect();
    } catch {
      /* noop */
    }
    _sourceNode = null;
  }
  // M15: Disconnect intermediate graph nodes that were previously leaked
  if (_splitter) {
    try {
      _splitter.disconnect();
    } catch {
      /* noop */
    }
    _splitter = null;
  }
  if (_stereoUpmix) {
    try {
      _stereoUpmix.disconnect();
    } catch {
      /* noop */
    }
    _stereoUpmix = null;
  }
  if (_destL) {
    try {
      _destL.disconnect();
    } catch {
      /* noop */
    }
    _destL = null;
  }
  if (_destR) {
    try {
      _destR.disconnect();
    } catch {
      /* noop */
    }
    _destR = null;
  }
  _streamL = null;
  _streamR = null;
  if (_capturedStream) {
    for (const track of _capturedStream.getTracks()) track.stop();
    _capturedStream = null;
  }
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemCaptureListeners(): void {
  bus.on('system-audio:start', () => {
    startSystemAudioCapture().catch((e) => {
      log.error('[SystemAudio] Unhandled error in startSystemAudioCapture:', e);
      stopSystemAudioCapture(); // Best-effort cleanup of half-initialized state
    });
  });
  bus.on('system-audio:stop', () => {
    stopSystemAudioCapture();
  });
  // force-stop = transition/teardown semantics (stopAllMedia track/mode
  // change, demo entry, leaveSession): another flow is taking over playback,
  // so never restore the pre-share snapshot here (SA-02).
  bus.on('system-audio:force-stop', () => {
    stopSystemAudioCapture({ restore: false });
  });
}

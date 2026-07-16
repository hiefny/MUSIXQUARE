/**
 * MUSIXQUARE — System Audio Capture
 *
 * Host-side module for capturing system audio via getDisplayMedia.
 * Splits into L/R mono MediaStreams for WebRTC transmission
 * (bypasses Chrome Opus mono limitation via dual-stream approach).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, type PlaybackActivityValue, type PlaybackModeValue } from '../core/constants.ts';
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
import { broadcastSystemMessage } from '../chat/protocol.ts';
import { getQueueItemById } from '../player/queue-model.ts';
import type { QueueItemId, TrackMeta } from '../types/index.ts';

// ─── Module State ─────────────────────────────────────────────────

let _capturedStream: MediaStream | null = null;
let _sourceNode: MediaStreamAudioSourceNode | null = null;
let _streamL: MediaStream | null = null;
let _streamR: MediaStream | null = null;
let _destL: MediaStreamAudioDestinationNode | null = null;
let _destR: MediaStreamAudioDestinationNode | null = null;
// Retain intermediate graph nodes so cleanupCapture can disconnect every
// connection created by a capture session.
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
  queueItemId: QueueItemId | null;
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
  // Capture stable identity instead of an array position: the occurrence may
  // move while system audio is active, while stopAllMedia preserves its ID.
  const playback = getPlaybackModeActivitySnapshot();
  _preSysAudioState = {
    playback,
    pausedAt: getState('player.pausedAt'),
    currentTrackMeta: getState('player.currentTrackMeta'),
    channelMode: getState('audio.channelMode'),
    queueItemId: getState('playlist.currentQueueItemId'),
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

  // 9.1 Localized transient system message for everyone in the room. Each
  // device renders the i18n key in its own locale.
  broadcastSystemMessage('chat.system_audio_started_system_message');

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
    // Enter the same room-wide lifecycle as the in-app Stop button. Calling
    // stopSystemAudioCapture() directly would leave host media calls, the SFU
    // publication, retry timers, and the frozen delivery policy alive.
    bus.emit('system-audio:stop');
  };
  audioTracks[0].addEventListener('ended', onTrackEnded);

  log.info('[SystemAudio] Capture started (stereo-stream)');
}

/**
 * Stop system audio capture.
 *
 * `restore` controls whether the pre-share playback snapshot is restored.
 * Explicit user stops and error cleanup restore by default. Transition and
 * teardown callers pass `restore:false` because another playback flow already
 * owns the target state; restoring the snapshot would overwrite that flow.
 */
function stopSystemAudioCapture(opts?: { restore?: boolean }): void {
  if (!isSystemAudioActive() && !_capturedStream) return;
  const shouldRestore = opts?.restore ?? true;

  _debugLastStopBroadcastAt = Date.now();
  broadcast({ type: MSG.SYSTEM_AUDIO_STOP });
  broadcastSystemMessage('chat.system_audio_stopped_system_message');
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
    const queueItemId = snapshot.queueItemId ?? meta?.queueItemId ?? null;
    const item = getQueueItemById(queueItemId);
    const videoId = meta?.videoId || item?.videoId || null;
    const playlistId = meta?.playlistId || item?.playlistId || null;
    if (queueItemId && (videoId || playlistId)) {
      bus.emit('youtube:restore-room-playback', {
        videoId,
        playlistId,
        name: meta?.name || meta?.title || item?.name || item?.title || null,
        queueItemId,
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
  // Disconnect every intermediate node retained for this capture session.
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
      // A late setup failure can happen after streams-ready. Route every
      // failure through the shared stop lifecycle so direct/SFU resources and
      // the frozen delivery policy are not left behind.
      bus.emit('system-audio:stop');
    });
  });
  bus.on('system-audio:stop', () => {
    stopSystemAudioCapture();
  });
  // force-stop is transition/teardown semantics: another flow is taking over,
  // so the pre-share snapshot must not be restored.
  bus.on('system-audio:force-stop', () => {
    stopSystemAudioCapture({ restore: false });
  });
}

/**
 * MUSIXQUARE 3.0 — System Audio Capture
 *
 * Host-side module for capturing system audio via getDisplayMedia
 * and connecting it to the existing Web Audio graph.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE, MSG } from '../core/constants.ts';
import { t } from '../i18n/index.ts';
import { getAudioContext } from './context.ts';
import { initAudio, getWidener, getMasterGain } from './engine.ts';
import { stopAllMedia } from '../player/transport.ts';
import { broadcast } from '../network/peer.ts';
import { callAllGuests, closeAllMediaConns } from '../network/system-audio-host.ts';

// ─── Module State ─────────────────────────────────────────────────

let _capturedStream: MediaStream | null = null;
let _sourceNode: MediaStreamAudioSourceNode | null = null;
let _preSysAudioState: {
  appState: string;
  pausedAt: number;
  currentTrackIndex: number;
  currentTrackMeta: unknown;
} | null = null;

// ─── Public API ───────────────────────────────────────────────────

export function isSystemAudioActive(): boolean {
  return _capturedStream !== null && _capturedStream.active;
}

export function getSystemAudioStream(): MediaStream | null {
  return _capturedStream;
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
      video: true,  // Chrome requires video: true
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

  // Discard video track — we only need audio
  for (const vt of stream.getVideoTracks()) {
    vt.stop();
  }

  // Verify audio track exists
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    log.warn('[SystemAudio] No audio track in captured stream');
    bus.emit('ui:show-toast', t('system_audio.no_audio_track'));
    return;
  }

  // 2. Save previous state for restoration
  _preSysAudioState = {
    appState: getState('appState'),
    pausedAt: getState('player.pausedAt'),
    currentTrackIndex: getState('playlist.currentTrackIndex'),
    currentTrackMeta: getState('player.currentTrackMeta'),
  };

  // 3. Stop all current media
  stopAllMedia({ silent: true });

  // 4. Init audio if needed
  await initAudio();

  // 5. Connect to audio graph
  const ctx = getAudioContext();
  _capturedStream = stream;
  _sourceNode = ctx.createMediaStreamSource(stream);

  // Force stereo upmix: getDisplayMedia often returns mono on some platforms.
  // Without this, channelSplitter only fills L channel → R is silent.
  const stereoUpmix = ctx.createGain();
  stereoUpmix.channelCount = 2;
  stereoUpmix.channelCountMode = 'explicit';
  stereoUpmix.channelInterpretation = 'speakers';
  _sourceNode.connect(stereoUpmix);

  const widener = getWidener();
  if (widener) {
    stereoUpmix.connect(widener.input);
  } else {
    log.error('[SystemAudio] No widener found — audio graph not ready');
    cleanupCapture();
    return;
  }

  // 6. Host mute local (avoid double audio — system already plays it)
  if (getState('systemAudio.hostMuteLocal')) {
    muteLocalOutput(true);
  }

  // 7. Update state
  setState('systemAudio.isSharing', true);
  setState('appState', APP_STATE.PLAYING_SYSTEM_AUDIO);
  setState('player.currentTrackMeta', { type: 'file', name: 'system-audio', title: 'System Audio Sharing' });

  // 8. Broadcast to guests & start media calls
  broadcast({ type: MSG.SYSTEM_AUDIO_START });
  callAllGuests();

  // 9. Start visualizer
  bus.emit('visualizer:start');

  // 10. Listen for browser "Stop sharing" button
  audioTracks[0].addEventListener('ended', () => {
    log.info('[SystemAudio] Audio track ended (user stopped sharing)');
    stopSystemAudioCapture();
  });

  log.info('[SystemAudio] Capture started');
}

/**
 * Stop system audio capture and restore previous state.
 */
export function stopSystemAudioCapture(): void {
  if (!isSystemAudioActive() && !_capturedStream) return;

  // 1. Broadcast stop to guests & close media connections
  broadcast({ type: MSG.SYSTEM_AUDIO_STOP });
  closeAllMediaConns();

  // 2. Cleanup capture
  cleanupCapture();

  // 3. Restore local output
  muteLocalOutput(false);

  // 4. Update state
  setState('systemAudio.isSharing', false);

  // 5. Restore previous state
  if (_preSysAudioState) {
    setState('player.pausedAt', _preSysAudioState.pausedAt);
    // Restore track meta (previous song or null → shows "No media")
    setState('player.currentTrackMeta', _preSysAudioState.currentTrackMeta ?? null);
    // Go to PAUSED if there was media loaded, otherwise IDLE
    if (_preSysAudioState.appState !== APP_STATE.IDLE) {
      setState('appState', APP_STATE.PAUSED);
    } else {
      setState('appState', APP_STATE.IDLE);
    }
    _preSysAudioState = null;
  } else {
    setState('player.currentTrackMeta', null);
    setState('appState', APP_STATE.IDLE);
  }

  log.info('[SystemAudio] Capture stopped');
}

/**
 * Toggle host local output mute (prevent double audio during system capture).
 */
export function muteLocalOutput(mute: boolean): void {
  const masterGain = getMasterGain();
  const ctx = getAudioContext();
  if (!masterGain) return;

  try {
    if (mute) {
      masterGain.disconnect(ctx.destination);
    } else {
      masterGain.connect(ctx.destination);
    }
    setState('systemAudio.hostMuteLocal', mute);
  } catch (e) {
    log.debug('[SystemAudio] mute/unmute error (may already be in target state):', e);
  }
}

// ─── Internals ────────────────────────────────────────────────────

function cleanupCapture(): void {
  if (_sourceNode) {
    try { _sourceNode.disconnect(); } catch { /* noop */ }
    _sourceNode = null;
  }
  if (_capturedStream) {
    for (const track of _capturedStream.getTracks()) {
      track.stop();
    }
    _capturedStream = null;
  }
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemCaptureListeners(): void {
  bus.on('system-audio:start', () => {
    startSystemAudioCapture();
  });

  bus.on('system-audio:stop', () => {
    stopSystemAudioCapture();
  });

  bus.on('system-audio:force-stop', () => {
    stopSystemAudioCapture();
  });
}

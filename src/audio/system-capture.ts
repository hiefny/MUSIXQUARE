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
import { APP_STATE, MSG } from '../core/constants.ts';
import { t } from '../i18n/index.ts';
import { getAudioContext } from './context.ts';
import { initAudio, getWidener, getMasterGain } from './engine.ts';
import { stopAllMedia } from '../player/transport.ts';
import { broadcast } from '../network/peer.ts';

// ─── Module State ─────────────────────────────────────────────────

let _capturedStream: MediaStream | null = null;
let _sourceNode: MediaStreamAudioSourceNode | null = null;
let _stereoStream: MediaStream | null = null;
let _stereoDest: MediaStreamAudioDestinationNode | null = null;
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

/** Get the stereo stream for P2P */
export function getStereoStream(): MediaStream | null { return _stereoStream; }

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
  _preSysAudioState = {
    appState: getState('appState'),
    pausedAt: getState('player.pausedAt'),
    currentTrackIndex: getState('playlist.currentTrackIndex'),
    currentTrackMeta: getState('player.currentTrackMeta'),
  };

  // 3. Stop all current media
  stopAllMedia({ silent: true });

  // 4. Init audio
  await initAudio();
  const ctx = getAudioContext();
  _capturedStream = stream;
  _sourceNode = ctx.createMediaStreamSource(stream);

  // 5. Connect to stereo MediaStream destination for P2P
  _stereoDest = ctx.createMediaStreamDestination();
  _stereoDest.channelCount = 2;
  _stereoDest.channelCountMode = 'explicit';
  
  // Create a dedicated upmixer for the network stream to ensure 2 channels
  const networkUpmix = ctx.createGain();
  networkUpmix.channelCount = 2;
  networkUpmix.channelCountMode = 'explicit';
  networkUpmix.channelInterpretation = 'speakers';
  
  _sourceNode.connect(networkUpmix);
  networkUpmix.connect(_stereoDest);
  _stereoStream = _stereoDest.stream;

  log.info(`[SystemAudio] Stereo stream created (upmixed): id=${_stereoStream.id.slice(0, 8)}`);

  // 6. Local graph: upmix for safety
  const stereoUpmix = ctx.createGain();
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
  setState('systemAudio.isSharing', true);
  setState('appState', APP_STATE.PLAYING_SYSTEM_AUDIO);
  setState('player.currentTrackMeta', { type: 'file', name: 'system-audio', title: 'System Audio Sharing' });

  // 9. Broadcast start + call guests with L/R streams
  broadcast({ type: MSG.SYSTEM_AUDIO_START });
  bus.emit('system-audio:streams-ready');

  // 10. Start visualizer
  bus.emit('visualizer:start');

  // 11. Listen for browser "Stop sharing" button
  audioTracks[0].addEventListener('ended', () => {
    log.info('[SystemAudio] Audio track ended (user stopped sharing)');
    stopSystemAudioCapture();
  });

  log.info('[SystemAudio] Capture started (stereo-stream)');
}

/**
 * Stop system audio capture and restore previous state.
 */
export function stopSystemAudioCapture(): void {
  if (!isSystemAudioActive() && !_capturedStream) return;

  broadcast({ type: MSG.SYSTEM_AUDIO_STOP });
  cleanupCapture();
  muteLocalOutput(false);

  setState('systemAudio.isSharing', false);

  if (_preSysAudioState) {
    setState('player.pausedAt', _preSysAudioState.pausedAt);
    setState('player.currentTrackMeta', _preSysAudioState.currentTrackMeta ?? null);
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

export function muteLocalOutput(mute: boolean): void {
  const masterGain = getMasterGain();
  const ctx = getAudioContext();
  if (!masterGain) return;

  try {
    if (mute) masterGain.disconnect(ctx.destination);
    else masterGain.connect(ctx.destination);
    setState('systemAudio.hostMuteLocal', mute);
  } catch (e) {
    log.debug('[SystemAudio] mute/unmute error:', e);
  }
}

// ─── Internals ────────────────────────────────────────────────────

function cleanupCapture(): void {
  if (_sourceNode) {
    try { _sourceNode.disconnect(); } catch { /* noop */ }
    _sourceNode = null;
  }
  if (_stereoDest) { try { _stereoDest.disconnect(); } catch { /* noop */ } _stereoDest = null; }
  _stereoStream = null;
  if (_capturedStream) {
    for (const track of _capturedStream.getTracks()) track.stop();
    _capturedStream = null;
  }
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemCaptureListeners(): void {
  bus.on('system-audio:start', () => { startSystemAudioCapture(); });
  bus.on('system-audio:stop', () => { stopSystemAudioCapture(); });
  bus.on('system-audio:force-stop', () => { stopSystemAudioCapture(); });
}

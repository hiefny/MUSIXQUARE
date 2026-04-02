/**
 * MUSIXQUARE 3.0 — System Audio Guest (MediaConnection Receiver)
 *
 * Handles incoming WebRTC media calls from the host
 * and connects received audio to the local Web Audio graph.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE, MSG } from '../core/constants.ts';
import { getAudioContext } from '../audio/context.ts';
import { initAudio, getWidener } from '../audio/engine.ts';
import { stopAllMedia } from '../player/transport.ts';
import { registerHandler } from './protocol.ts';
import type { MediaConnection } from 'peerjs';

/** Force Opus stereo in SDP */
function _forceOpusStereo(sdp: string): string {
  return sdp.replace(
    /a=fmtp:(\d+) (.+)/g,
    (match, pt, params) => {
      if (!/opus/i.test(sdp.substring(sdp.lastIndexOf('a=rtpmap:' + pt), sdp.indexOf('\r\n', sdp.lastIndexOf('a=rtpmap:' + pt))))) {
        return match;
      }
      let updated = params;
      if (!/stereo=/.test(updated)) updated += ';stereo=1';
      else updated = updated.replace(/stereo=\d/, 'stereo=1');
      if (!/sprop-stereo=/.test(updated)) updated += ';sprop-stereo=1';
      else updated = updated.replace(/sprop-stereo=\d/, 'sprop-stereo=1');
      return `a=fmtp:${pt} ${updated}`;
    }
  );
}

// ─── Module State ─────────────────────────────────────────────────

let _mediaConn: MediaConnection | null = null;
let _sourceNode: MediaStreamAudioSourceNode | null = null;
let _remoteStream: MediaStream | null = null;
let _isCleaningUp = false;

// ─── Public API ───────────────────────────────────────────────────

export function isReceivingSystemAudio(): boolean {
  return _remoteStream !== null && _remoteStream.active;
}

/**
 * Handle the SYSTEM_AUDIO_START protocol message from host.
 * Prepares the guest for incoming media call.
 */
export function handleSystemAudioStart(): void {
  log.info('[SysAudioGuest] Host started system audio sharing — preparing...');

  // Stop current playback to make room for incoming stream
  stopAllMedia({ silent: true });

  setState('player.currentTrackMeta', { type: 'file', name: 'system-audio', title: 'System Audio Sharing' });
}

/**
 * Handle the SYSTEM_AUDIO_STOP protocol message from host.
 */
export function handleSystemAudioStop(): void {
  log.info('[SysAudioGuest] Host stopped system audio sharing');
  cleanupGuestSystemAudio();
}

/**
 * Handle incoming media call from host.
 */
export async function handleIncomingMediaCall(mediaConn: MediaConnection): Promise<void> {
  log.info('[SysAudioGuest] Incoming system audio call — answering...');

  // Clean up any existing connection
  cleanupGuestSystemAudio();
  _isCleaningUp = false;

  _mediaConn = mediaConn;

  // Force Opus stereo on the answer SDP
  const pc = mediaConn.peerConnection as RTCPeerConnection | undefined;
  if (pc) {
    const origSetLocal = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = async (desc?: RTCLocalSessionDescriptionInit) => {
      if (desc?.sdp) desc = { ...desc, sdp: _forceOpusStereo(desc.sdp) };
      return origSetLocal(desc);
    };
  }

  // Answer without sending our own stream (receive-only)
  mediaConn.answer();

  mediaConn.on('stream', async (remoteStream: MediaStream) => {
    log.info('[SysAudioGuest] Received remote audio stream');
    _remoteStream = remoteStream;

    // Ensure audio is initialized
    await initAudio();

    const ctx = getAudioContext();
    const widener = getWidener();
    if (!widener) {
      log.error('[SysAudioGuest] Audio graph not ready');
      cleanupGuestSystemAudio();
      return;
    }

    // Connect remote stream to audio graph
    // Force stereo upmix: WebRTC may deliver mono even if host captured stereo
    _sourceNode = ctx.createMediaStreamSource(remoteStream);
    const stereoUpmix = ctx.createGain();
    stereoUpmix.channelCount = 2;
    stereoUpmix.channelCountMode = 'explicit';
    stereoUpmix.channelInterpretation = 'speakers';
    _sourceNode.connect(stereoUpmix);
    stereoUpmix.connect(widener.input);

    // Update state
    setState('systemAudio.isReceiving', true);
    setState('appState', APP_STATE.PLAYING_SYSTEM_AUDIO);

    // Start visualizer
    bus.emit('visualizer:start');

    log.info('[SysAudioGuest] System audio connected to graph');
  });

  mediaConn.on('close', () => {
    log.info('[SysAudioGuest] MediaConnection closed');
    cleanupGuestSystemAudio();
  });

  mediaConn.on('error', (err: unknown) => {
    log.warn('[SysAudioGuest] MediaConnection error:', err);
    cleanupGuestSystemAudio();
  });
}

// ─── Cleanup ──────────────────────────────────────────────────────

function cleanupGuestSystemAudio(): void {
  if (_isCleaningUp) return;
  _isCleaningUp = true;

  if (_sourceNode) {
    try { _sourceNode.disconnect(); } catch { /* noop */ }
    _sourceNode = null;
  }

  if (_mediaConn) {
    try { _mediaConn.close(); } catch { /* noop */ }
    _mediaConn = null;
  }

  _remoteStream = null;

  setState('systemAudio.isReceiving', false);

  // Only reset state if we were in system audio mode
  if (getState('appState') === APP_STATE.PLAYING_SYSTEM_AUDIO) {
    setState('appState', APP_STATE.IDLE);
  }

  _isCleaningUp = false;
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemAudioGuestListeners(): void {
  // Protocol handlers (DataConnection messages from host)
  registerHandler(MSG.SYSTEM_AUDIO_START, () => {
    handleSystemAudioStart();
  });

  registerHandler(MSG.SYSTEM_AUDIO_STOP, () => {
    handleSystemAudioStop();
  });

  // Bus handlers (MediaConnection events from peer.ts)
  bus.on('system-audio:incoming-call', (mediaConn: unknown) => {
    handleIncomingMediaCall(mediaConn as MediaConnection);
  });

  bus.on('system-audio:force-stop', () => {
    cleanupGuestSystemAudio();
  });
}

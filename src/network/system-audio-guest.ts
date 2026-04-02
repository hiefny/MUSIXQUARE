/**
 * MUSIXQUARE 4.0 — System Audio Guest (Dual-Stream WebRTC Receiver)
 *
 * Receives L and R mono streams from host via separate MediaConnections,
 * merges them into stereo via ChannelMerger, connects to audio graph.
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

// ─── Module State ─────────────────────────────────────────────────

let _mediaConnL: MediaConnection | null = null;
let _mediaConnR: MediaConnection | null = null;
let _sourceL: MediaStreamAudioSourceNode | null = null;
let _sourceR: MediaStreamAudioSourceNode | null = null;
let _merger: ChannelMergerNode | null = null;
let _gotL = false;
let _gotR = false;
let _prevTrackMeta: unknown = null;

// ─── Public API ───────────────────────────────────────────────────

export function isReceivingSystemAudio(): boolean {
  return _gotL || _gotR;
}

// ─── Handle Incoming Media Call ───────────────────────────────────

async function handleIncomingCall(mediaConn: MediaConnection, channel: string): Promise<void> {
  log.info(`[SysAudioGuest] Incoming ${channel} channel call`);

  if (channel === 'L') {
    if (_mediaConnL) { try { _mediaConnL.close(); } catch { /* noop */ } }
    _mediaConnL = mediaConn;
  } else {
    if (_mediaConnR) { try { _mediaConnR.close(); } catch { /* noop */ } }
    _mediaConnR = mediaConn;
  }

  mediaConn.answer();

  // Let browser manage jitter buffer — any fixed playoutDelayHint value
  // causes instability on some devices (iOS 26 stutters at 0, others at 100ms).

  mediaConn.on('stream', async (remoteStream: MediaStream) => {
    log.info(`[SysAudioGuest] Received ${channel} stream`);

    await initAudio();
    const ctx = getAudioContext();

    // Create merger on first stream
    if (!_merger) {
      const widener = getWidener();
      if (!widener) {
        log.error('[SysAudioGuest] Audio graph not ready');
        return;
      }
      _merger = ctx.createChannelMerger(2);
      _merger.connect(widener.input);
    }

    const source = ctx.createMediaStreamSource(remoteStream);

    if (channel === 'L') {
      if (_sourceL) { try { _sourceL.disconnect(); } catch { /* noop */ } }
      _sourceL = source;
      source.connect(_merger, 0, 0); // mono source → merger L input
      _gotL = true;
    } else {
      if (_sourceR) { try { _sourceR.disconnect(); } catch { /* noop */ } }
      _sourceR = source;
      source.connect(_merger, 0, 1); // mono source → merger R input
      _gotR = true;
    }

    // Update state once at least one stream is connected
    if (!getState('systemAudio.isReceiving')) {
      setState('systemAudio.isReceiving', true);
      setState('appState', APP_STATE.PLAYING_SYSTEM_AUDIO);
      bus.emit('visualizer:start');
      log.info('[SysAudioGuest] System audio connected to graph (stereo merge)');
    }
  });

  mediaConn.on('close', () => {
    log.info(`[SysAudioGuest] ${channel} MediaConnection closed`);
    if (channel === 'L') { _gotL = false; _mediaConnL = null; }
    else { _gotR = false; _mediaConnR = null; }
    if (!_gotL && !_gotR) cleanupGuestSystemAudio();
  });

  mediaConn.on('error', (err: unknown) => {
    log.warn(`[SysAudioGuest] ${channel} error:`, err);
  });
}

// ─── Cleanup ──────────────────────────────────────────────────────

function cleanupGuestSystemAudio(): void {
  if (_sourceL) { try { _sourceL.disconnect(); } catch { /* noop */ } _sourceL = null; }
  if (_sourceR) { try { _sourceR.disconnect(); } catch { /* noop */ } _sourceR = null; }
  if (_merger) { try { _merger.disconnect(); } catch { /* noop */ } _merger = null; }
  if (_mediaConnL) { try { _mediaConnL.close(); } catch { /* noop */ } _mediaConnL = null; }
  if (_mediaConnR) { try { _mediaConnR.close(); } catch { /* noop */ } _mediaConnR = null; }
  _gotL = false;
  _gotR = false;

  setState('systemAudio.isReceiving', false);
  setState('player.currentTrackMeta', _prevTrackMeta ?? null);
  _prevTrackMeta = null;
  if (getState('appState') === APP_STATE.PLAYING_SYSTEM_AUDIO) {
    setState('appState', APP_STATE.IDLE);
  }
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemAudioGuestListeners(): void {
  registerHandler(MSG.SYSTEM_AUDIO_START, () => {
    log.info('[SysAudioGuest] Host started system audio sharing');
    _prevTrackMeta = getState('player.currentTrackMeta');
    stopAllMedia({ silent: true });
    setState('player.currentTrackMeta', { type: 'file', name: 'system-audio', title: 'System Audio Sharing' });
  });

  registerHandler(MSG.SYSTEM_AUDIO_STOP, () => {
    log.info('[SysAudioGuest] Host stopped system audio sharing');
    cleanupGuestSystemAudio();
  });

  bus.on('system-audio:incoming-call', (mediaConn: unknown, channel: string) => {
    handleIncomingCall(mediaConn as MediaConnection, channel);
  });

  bus.on('system-audio:force-stop', () => {
    cleanupGuestSystemAudio();
  });
}

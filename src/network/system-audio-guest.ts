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
let _mediaConnDual: MediaConnection | null = null;
let _sourceL: MediaStreamAudioSourceNode | null = null;
let _sourceR: MediaStreamAudioSourceNode | null = null;
let _merger: ChannelMergerNode | null = null;
let _delayNode: DelayNode | null = null;
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
  } else if (channel === 'R') {
    if (_mediaConnR) { try { _mediaConnR.close(); } catch { /* noop */ } }
    _mediaConnR = mediaConn;
  } else if (channel === 'DUAL') {
    if (_mediaConnDual) { try { _mediaConnDual.close(); } catch { /* noop */ } }
    _mediaConnDual = mediaConn;
  }

  mediaConn.answer();

  // Browser manages jitter buffer — playoutDelayHint=0 causes iOS 26 stutter.

  mediaConn.on('stream', async (remoteStream: MediaStream) => {
    log.info(`[SysAudioGuest] Received ${channel} stream`);

    await initAudio();
    const ctx = getAudioContext();

    // Set generous playoutDelayHint to normalize jitter buffer across devices
    const receivers = mediaConn.peerConnection?.getReceivers() || [];
    for (const receiver of receivers) {
      if (receiver.track.kind === 'audio' && 'playoutDelayHint' in receiver) {
        (receiver as any).playoutDelayHint = 0.25;
      }
    }

    // Create merger on first stream
    if (!_merger) {
      const widener = getWidener();
      if (!widener) {
        log.error('[SysAudioGuest] Audio graph not ready');
        return;
      }
      _merger = ctx.createChannelMerger(2);
      _delayNode = ctx.createDelay(3.0);
      const lo = (getState('sync.localOffset') as number) || 0;
      _delayNode.delayTime.value = Math.max(0, lo);
      
      _merger.connect(_delayNode);
      _delayNode.connect(widener.input);
    }

    if (channel === 'DUAL') {
      const tracks = remoteStream.getAudioTracks();
      if (tracks.length < 2) {
        log.warn('[SysAudioGuest] Dual stream received but <2 tracks found');
        return;
      }
      
      const sysStreamL = new MediaStream([tracks[0]]);
      const sysStreamR = new MediaStream([tracks[1]]);
      
      if (_sourceL) { try { _sourceL.disconnect(); } catch { /* noop */ } }
      if (_sourceR) { try { _sourceR.disconnect(); } catch { /* noop */ } }
      
      _sourceL = ctx.createMediaStreamSource(sysStreamL);
      _sourceL.connect(_merger, 0, 0);
      _gotL = true;
      
      _sourceR = ctx.createMediaStreamSource(sysStreamR);
      _sourceR.connect(_merger, 0, 1);
      _gotR = true;
    } else {
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
    if (channel === 'DUAL') { _gotL = false; _gotR = false; _mediaConnDual = null; }
    else if (channel === 'L') { _gotL = false; _mediaConnL = null; }
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
  if (_delayNode) { try { _delayNode.disconnect(); } catch { /* noop */ } _delayNode = null; }
  if (_mediaConnL) { try { _mediaConnL.close(); } catch { /* noop */ } _mediaConnL = null; }
  if (_mediaConnR) { try { _mediaConnR.close(); } catch { /* noop */ } _mediaConnR = null; }
  if (_mediaConnDual) { try { _mediaConnDual.close(); } catch { /* noop */ } _mediaConnDual = null; }
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
    setState('player.currentTrackMeta', { type: 'file', name: 'system-audio-receiving', title: 'Receiving System Audio' });
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

  bus.on('state:sync.localOffset', (val: unknown) => {
    if (_delayNode) _delayNode.delayTime.value = Math.max(0, (val as number) || 0);
  });
}

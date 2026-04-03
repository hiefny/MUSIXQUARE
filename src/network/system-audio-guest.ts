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

import { forceStereoSdp } from './peer.ts';

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
let _gotL = false;
let _gotR = false;
let _gotStereo = false;
let _gotSynced = false;
let _prevTrackMeta: unknown = null;

// ─── SDP Munging ──────────────────────────────────────────────────

function applySdpMunge(mc: MediaConnection): void {
  const pc = (mc as any).peerConnection as RTCPeerConnection | undefined;
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
    if (_mediaConnL) { try { _mediaConnL.close(); } catch { /* noop */ } }
    _mediaConnL = mediaConn;
  } else if (channel === 'R') {
    if (_mediaConnR) { try { _mediaConnR.close(); } catch { /* noop */ } }
    _mediaConnR = mediaConn;
  } else if (channel === 'DUAL' || channel === 'SYNCED') {
    if (channel === 'DUAL') {
      if (_mediaConnDual) { try { _mediaConnDual.close(); } catch { /* noop */ } }
      _mediaConnDual = mediaConn;
    } else {
      if (_mediaConnSynced) { try { _mediaConnSynced.close(); } catch { /* noop */ } }
      _mediaConnSynced = mediaConn;
    }
  } else if (channel === 'STEREO') {
    if (_mediaConnStereo) { try { _mediaConnStereo.close(); } catch { /* noop */ } }
    _mediaConnStereo = mediaConn;
  }

  if (channel === 'STEREO' || channel === 'DUAL' || channel === 'SYNCED') {
    applySdpMunge(mediaConn);
  }

  mediaConn.answer();

  mediaConn.on('stream', async (remoteStream: MediaStream) => {
    log.info(`[SysAudioGuest] Received ${channel} stream`);

    await initAudio();
    const ctx = getAudioContext();
    const widener = getWidener();
    if (!widener) {
      log.error('[SysAudioGuest] Audio graph not ready');
      return;
    }

    if (channel === 'STEREO') {
      if (_sourceStereo) { try { _sourceStereo.disconnect(); } catch { /* noop */ } }
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

        if (_sourceL) { try { _sourceL.disconnect(); } catch { /* noop */ } }
        if (_sourceR) { try { _sourceR.disconnect(); } catch { /* noop */ } }

        // Use ID-to-Channel mapping from host if available (synced mode)
        const mapping = (mediaConn.metadata as any)?.mapping;

        if (mapping && tracks.length >= 2) {
          log.info('[SysAudioGuest] Using ID-based track mapping for crystal-clear stereo');
          for (const t of tracks) {
            const role = mapping[t.id];
            const source = ctx.createMediaStreamSource(new MediaStream([t]));
            if (role === 'L') {
              _sourceL = source;
              source.connect(_merger, 0, 0);
              _gotL = true;
            } else if (role === 'R') {
              _sourceR = source;
              source.connect(_merger, 0, 1);
              _gotR = true;
            }
          }
        } else if (tracks.length >= 2) {
          // Standard track order (default)
          _sourceL = ctx.createMediaStreamSource(new MediaStream([tracks[0]]));
          _sourceL.connect(_merger, 0, 0);
          _gotL = true;
          _sourceR = ctx.createMediaStreamSource(new MediaStream([tracks[1]]));
          _sourceR.connect(_merger, 0, 1);
          _gotR = true;
        } else {
          // Failsafe: Upmix single track to center
          log.info(`[SysAudioGuest] ${channel} received with ONLY 1 track. Upmixing to mono-center.`);
          const monoSource = ctx.createMediaStreamSource(new MediaStream([tracks[0]]));
          monoSource.connect(_merger, 0, 0);
          monoSource.connect(_merger, 0, 1);
          _sourceL = monoSource;
          _gotL = true; _gotR = true;
        }

        if (channel === 'SYNCED') _gotSynced = true;
      } else {
        const source = ctx.createMediaStreamSource(remoteStream);
        if (channel === 'L') {
          if (_sourceL) { try { _sourceL.disconnect(); } catch { /* noop */ } }
          _sourceL = source;
          source.connect(_merger, 0, 0);
          _gotL = true;
        } else {
          if (_sourceR) { try { _sourceR.disconnect(); } catch { /* noop */ } }
          _sourceR = source;
          source.connect(_merger, 0, 1);
          _gotR = true;
        }
      }
    }

    // Update state once at least one stream is connected
    if (!getState('systemAudio.isReceiving')) {
      setState('systemAudio.isReceiving', true);
      setState('appState', APP_STATE.PLAYING_SYSTEM_AUDIO);
      bus.emit('visualizer:start');
      log.info(`[SysAudioGuest] System audio connected to graph (${channel})`);
    }
  });

  mediaConn.on('close', () => {
    log.info(`[SysAudioGuest] ${channel} MediaConnection closed`);
    if (channel === 'DUAL' || channel === 'SYNCED') { 
      _gotL = false; _gotR = false; 
      if (channel === 'DUAL') _mediaConnDual = null; else { _mediaConnSynced = null; _gotSynced = false; }
    }
    else if (channel === 'L') { _gotL = false; _mediaConnL = null; }
    else if (channel === 'R') { _gotR = false; _mediaConnR = null; }
    else if (channel === 'STEREO') { _gotStereo = false; _mediaConnStereo = null; }
    if (!_gotL && !_gotR && !_gotStereo && !_gotSynced) cleanupGuestSystemAudio();
  });

  mediaConn.on('error', (err: unknown) => {
    log.warn(`[SysAudioGuest] ${channel} error:`, err);
  });
}

// ─── Cleanup ──────────────────────────────────────────────────────

function cleanupGuestSystemAudio(): void {
  if (_sourceL) { try { _sourceL.disconnect(); } catch { /* noop */ } _sourceL = null; }
  if (_sourceR) { try { _sourceR.disconnect(); } catch { /* noop */ } _sourceR = null; }
  if (_sourceStereo) { try { _sourceStereo.disconnect(); } catch { /* noop */ } _sourceStereo = null; }
  if (_merger) { try { _merger.disconnect(); } catch { /* noop */ } _merger = null; }
  if (_mediaConnL) { try { _mediaConnL.close(); } catch { /* noop */ } _mediaConnL = null; }
  if (_mediaConnR) { try { _mediaConnR.close(); } catch { /* noop */ } _mediaConnR = null; }
  if (_mediaConnDual) { try { _mediaConnDual.close(); } catch { /* noop */ } _mediaConnDual = null; }
  if (_mediaConnStereo) { try { _mediaConnStereo.close(); } catch { /* noop */ } _mediaConnStereo = null; }
  if (_mediaConnSynced) { try { _mediaConnSynced.close(); } catch { /* noop */ } _mediaConnSynced = null; }
  _gotL = false;
  _gotR = false;
  _gotStereo = false;
  _gotSynced = false;

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
}

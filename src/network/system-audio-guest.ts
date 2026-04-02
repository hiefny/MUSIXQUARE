/**
 * MUSIXQUARE 4.0 — System Audio Guest (PCM DataChannel Receiver)
 *
 * Receives raw Int16 stereo PCM chunks from host via DataConnection,
 * plays through ring buffer → ScriptProcessorNode → audio graph.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE, MSG } from '../core/constants.ts';
import { initAudio, getWidener } from '../audio/engine.ts';
import { stopAllMedia } from '../player/transport.ts';
import { registerHandler } from './protocol.ts';
import { startPcmReceiver, stopPcmReceiver, feedPcmChunk } from '../audio/pcm-stream.ts';
import { getAudioContext } from '../audio/context.ts';

// ─── Module State ─────────────────────────────────────────────────

let _receiverNode: AudioNode | null = null;

// ─── Public API ───────────────────────────────────────────────────

export function isReceivingSystemAudio(): boolean {
  return _receiverNode !== null;
}

// ─── Cleanup ──────────────────────────────────────────────────────

function cleanupGuestSystemAudio(): void {
  stopPcmReceiver();
  if (_receiverNode) {
    try { _receiverNode.disconnect(); } catch { /* noop */ }
    _receiverNode = null;
  }

  setState('systemAudio.isReceiving', false);

  if (getState('appState') === APP_STATE.PLAYING_SYSTEM_AUDIO) {
    setState('appState', APP_STATE.IDLE);
  }
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemAudioGuestListeners(): void {
  // Host starts system audio sharing
  registerHandler(MSG.SYSTEM_AUDIO_START, async (data) => {
    log.info('[SysAudioGuest] Host started system audio sharing — setting up PCM receiver...');

    // Stop current playback
    stopAllMedia({ silent: true });
    setState('player.currentTrackMeta', { type: 'file', name: 'system-audio', title: 'System Audio Sharing' });

    // Init audio
    await initAudio();

    const ctx = getAudioContext();
    const widener = getWidener();
    if (!widener) {
      log.error('[SysAudioGuest] Audio graph not ready');
      return;
    }

    // Start PCM receiver — returns an AudioWorkletNode (audio output)
    const sampleRate = (data as Record<string, unknown>).sampleRate as number || ctx.sampleRate;
    _receiverNode = await startPcmReceiver(sampleRate);
    if (_receiverNode) {
      _receiverNode.connect(widener.input);
    }

    // Update state
    setState('systemAudio.isReceiving', true);
    setState('appState', APP_STATE.PLAYING_SYSTEM_AUDIO);
    bus.emit('visualizer:start');

    log.info('[SysAudioGuest] PCM receiver connected to audio graph');
  });

  // Host stops system audio sharing
  registerHandler(MSG.SYSTEM_AUDIO_STOP, () => {
    log.info('[SysAudioGuest] Host stopped system audio sharing');
    cleanupGuestSystemAudio();
  });

  // Incoming PCM chunk from host
  registerHandler(MSG.SYSTEM_AUDIO_PCM, (data) => {
    const chunk = (data as Record<string, unknown>).chunk;
    if (chunk instanceof ArrayBuffer) {
      feedPcmChunk(chunk);
    }
  });

  bus.on('system-audio:force-stop', () => {
    cleanupGuestSystemAudio();
  });
}

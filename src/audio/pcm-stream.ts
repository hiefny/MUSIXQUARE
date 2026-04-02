/**
 * MUSIXQUARE 4.0 — PCM Streaming (AudioWorklet Transport)
 *
 * Ultra-low latency stereo audio over DataChannel.
 * Uses AudioWorklet (128 samples = ~2.7ms per frame) instead of
 * ScriptProcessorNode (256+ samples, main thread).
 *
 * Host: capture → AudioWorkletNode → Int16 PCM → broadcast via DataConnection
 * Guest: receive PCM → AudioWorkletNode ring buffer → widener → audio graph
 */

import { log } from '../core/log.ts';
import { MSG } from '../core/constants.ts';
import { getAudioContext } from './context.ts';
import { broadcast } from '../network/peer.ts';

// ─── Host: PCM Sender ─────────────────────────────────────────────

let _captureNode: AudioWorkletNode | null = null;
let _workletRegistered = false;

/**
 * Start extracting PCM from a MediaStreamAudioSourceNode and
 * broadcasting Int16 stereo chunks via DataConnection.
 */
export async function startPcmSender(sourceNode: MediaStreamAudioSourceNode): Promise<void> {
  stopPcmSender();

  const ctx = getAudioContext();

  // Register worklet processor (once)
  if (!_workletRegistered) {
    try {
      await ctx.audioWorklet.addModule(
        new URL('../workers/pcm-capture-processor.ts', import.meta.url)
      );
      _workletRegistered = true;
    } catch (e) {
      log.error('[PCM] Failed to register capture worklet:', e);
      return;
    }
  }

  _captureNode = new AudioWorkletNode(ctx, 'pcm-capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: 'explicit',
  });

  // Receive Int16 PCM chunks from audio thread → broadcast to peers
  _captureNode.port.onmessage = (e: MessageEvent) => {
    if (e.data instanceof ArrayBuffer) {
      broadcast({
        type: MSG.SYSTEM_AUDIO_PCM,
        chunk: e.data,
      } as any, false); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  };

  sourceNode.connect(_captureNode);

  log.info(`[PCM] AudioWorklet sender started: ${ctx.sampleRate}Hz, 128 samples/frame`);
}

export function stopPcmSender(): void {
  if (_captureNode) {
    _captureNode.port.postMessage('stop');
    try { _captureNode.disconnect(); } catch { /* noop */ }
    _captureNode = null;
    log.info('[PCM] Sender stopped');
  }
}

// ─── Guest: PCM Receiver ──────────────────────────────────────────

let _playbackNode: AudioWorkletNode | null = null;
let _playbackWorkletRegistered = false;

/**
 * Initialize the PCM receiver. Returns AudioWorkletNode to connect to audio graph.
 */
export async function startPcmReceiver(_sampleRate: number): Promise<AudioNode | null> {
  stopPcmReceiver();

  const ctx = getAudioContext();

  // Register worklet processor (once)
  if (!_playbackWorkletRegistered) {
    try {
      await ctx.audioWorklet.addModule(
        new URL('../workers/pcm-playback-processor.ts', import.meta.url)
      );
      _playbackWorkletRegistered = true;
    } catch (e) {
      log.error('[PCM] Failed to register playback worklet:', e);
      return null;
    }
  }

  _playbackNode = new AudioWorkletNode(ctx, 'pcm-playback-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  log.info(`[PCM] AudioWorklet receiver started`);
  return _playbackNode;
}

/**
 * Feed an incoming PCM chunk to the playback worklet.
 */
export function feedPcmChunk(chunk: ArrayBuffer): void {
  if (!_playbackNode) return;
  // Transfer buffer to audio thread (zero-copy)
  _playbackNode.port.postMessage(chunk, [chunk]);
}

export function stopPcmReceiver(): void {
  if (_playbackNode) {
    _playbackNode.port.postMessage('stop');
    try { _playbackNode.disconnect(); } catch { /* noop */ }
    _playbackNode = null;
    log.info('[PCM] Receiver stopped');
  }
}

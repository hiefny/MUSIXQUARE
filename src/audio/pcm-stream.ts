/**
 * MUSIXQUARE 4.0 — PCM Streaming (Stereo DataChannel Transport)
 *
 * Bypasses WebRTC Opus mono limitation by sending raw Int16 PCM
 * over PeerJS DataConnection. Guaranteed stereo on LAN.
 *
 * Host: capture → ScriptProcessorNode → Int16 PCM → broadcast via DataConnection
 * Guest: receive PCM → ring buffer → ScriptProcessorNode → widener → audio graph
 */

import { log } from '../core/log.ts';
import { MSG } from '../core/constants.ts';
import { getAudioContext } from './context.ts';
import { broadcast } from '../network/peer.ts';

// ─── Constants ────────────────────────────────────────────────────

const BUFFER_SIZE = 2048; // ~42ms at 48kHz — good latency/overhead balance

// ─── Host: PCM Sender ─────────────────────────────────────────────

let _processorNode: ScriptProcessorNode | null = null;

/**
 * Start extracting PCM from a MediaStreamAudioSourceNode and
 * broadcasting Int16 stereo chunks via DataConnection.
 */
export function startPcmSender(sourceNode: MediaStreamAudioSourceNode): void {
  stopPcmSender();

  const ctx = getAudioContext();

  // ScriptProcessorNode: captures raw PCM from the audio graph
  _processorNode = ctx.createScriptProcessor(BUFFER_SIZE, 2, 2);

  _processorNode.onaudioprocess = (e: AudioProcessingEvent) => {
    const left = e.inputBuffer.getChannelData(0);
    const right = e.inputBuffer.getChannelData(1);

    // Convert Float32 stereo → interleaved Int16 (halves bandwidth)
    const interleaved = new Int16Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      interleaved[i * 2] = Math.max(-32768, Math.min(32767, left[i] * 32767));
      interleaved[i * 2 + 1] = Math.max(-32768, Math.min(32767, right[i] * 32767));
    }

    broadcast({
      type: MSG.SYSTEM_AUDIO_PCM,
      chunk: interleaved.buffer,
    } as any, false); // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  // Connect: sourceNode → processor → (nowhere, just capture)
  // We need to connect output to something to keep it alive (Web Audio requirement)
  sourceNode.connect(_processorNode);
  _processorNode.connect(ctx.destination);

  // Mute the processor output (we don't want to hear it locally — host already hears system audio)
  // Actually, the processor must output to keep alive, but masterGain is disconnected from destination
  // during system audio mode (hostMuteLocal), so this won't produce audible output.

  log.info(`[PCM] Sender started: ${ctx.sampleRate}Hz, ${BUFFER_SIZE} samples/chunk`);
}

export function stopPcmSender(): void {
  if (_processorNode) {
    _processorNode.onaudioprocess = null;
    try { _processorNode.disconnect(); } catch { /* noop */ }
    _processorNode = null;
    log.info('[PCM] Sender stopped');
  }
}

// ─── Guest: PCM Receiver ──────────────────────────────────────────

const RING_BUFFER_SECONDS = 1; // 1 second ring buffer

let _receiverNode: ScriptProcessorNode | null = null;
let _ringL: Float32Array | null = null;
let _ringR: Float32Array | null = null;
let _writePos = 0;
let _readPos = 0;
let _ringSize = 0;
let _receiverStarted = false;

/**
 * Initialize the PCM receiver. Call once when SYSTEM_AUDIO_START arrives.
 * Returns the AudioNode to connect to the audio graph (widener.input).
 */
export function startPcmReceiver(sampleRate: number): ScriptProcessorNode | null {
  stopPcmReceiver();

  const ctx = getAudioContext();
  _ringSize = Math.ceil(sampleRate * RING_BUFFER_SECONDS);
  _ringL = new Float32Array(_ringSize);
  _ringR = new Float32Array(_ringSize);
  _writePos = 0;
  _readPos = 0;

  _receiverNode = ctx.createScriptProcessor(BUFFER_SIZE, 0, 2);

  _receiverNode.onaudioprocess = (e: AudioProcessingEvent) => {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);

    if (!_ringL || !_ringR) {
      outL.fill(0);
      outR.fill(0);
      return;
    }

    for (let i = 0; i < outL.length; i++) {
      if (_readPos !== _writePos) {
        outL[i] = _ringL[_readPos];
        outR[i] = _ringR[_readPos];
        _readPos = (_readPos + 1) % _ringSize;
      } else {
        // Buffer underrun — silence
        outL[i] = 0;
        outR[i] = 0;
      }
    }
  };

  _receiverStarted = true;
  log.info(`[PCM] Receiver started: ring=${_ringSize} samples`);
  return _receiverNode;
}

/**
 * Feed an incoming PCM chunk into the ring buffer.
 * Called from the protocol handler when SYSTEM_AUDIO_PCM arrives.
 */
export function feedPcmChunk(chunk: ArrayBuffer): void {
  if (!_ringL || !_ringR || !_receiverStarted) return;

  const int16 = new Int16Array(chunk);
  const samples = int16.length / 2; // interleaved stereo

  for (let i = 0; i < samples; i++) {
    _ringL[_writePos] = int16[i * 2] / 32767;
    _ringR[_writePos] = int16[i * 2 + 1] / 32767;
    _writePos = (_writePos + 1) % _ringSize;
  }
}

export function stopPcmReceiver(): void {
  _receiverStarted = false;
  if (_receiverNode) {
    _receiverNode.onaudioprocess = null;
    try { _receiverNode.disconnect(); } catch { /* noop */ }
    _receiverNode = null;
  }
  _ringL = null;
  _ringR = null;
  _writePos = 0;
  _readPos = 0;
  log.info('[PCM] Receiver stopped');
}

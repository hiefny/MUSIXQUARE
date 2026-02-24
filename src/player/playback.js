// @ts-check
/**
 * MUSIXQUARE 2.0 - Playback Controller
 *
 * 재생/일시정지/탐색 로직. Tone.js BufferSource 수명주기 관리.
 * 1.0의 play(), pause(), _internalPlay() 등을 캡슐화.
 *
 * Events emitted:
 *   bus.emit('playback:started', { offset, trackIndex })
 *   bus.emit('playback:paused', { position })
 *   bus.emit('playback:stopped')
 *   bus.emit('playback:ended')        - 트랙 자연 종료
 *   bus.emit('playback:position', seconds)  - 주기적 위치 업데이트
 *
 * Events consumed:
 *   audio:ready - 오디오 엔진 초기화 후 재생 가능
 */

import { bus } from '../core/events.js';
import { setState, getState } from '../core/state.js';
import { log } from '../core/log.js';
import { getMasterGain, isReady as isAudioReady } from '../audio/engine.js';

let source = null;       // Tone.js BufferSource
let startedAt = 0;       // Tone.now() when playback started
let pausedAt = 0;        // Position when paused
let isPlaying = false;
let positionInterval = null;

/**
 * Start playback from a given offset.
 * @param {any} buffer - Tone.js ToneAudioBuffer
 * @param {number} [offset=0] - Start position in seconds
 */
export async function play(buffer, offset = 0) {
  if (!isAudioReady()) {
    log.warn('[Playback] Audio not ready');
    return;
  }

  // Stop current source if any
  stop();

  const Tone = /** @type {any} */ (window).Tone;
  const masterGain = getMasterGain();

  source = new Tone.BufferSource(buffer);
  source.connect(masterGain);

  const safeOffset = Math.max(0, Math.min(offset, buffer.duration - 0.01));
  source.start(Tone.now(), safeOffset);
  startedAt = Tone.now() - safeOffset;
  isPlaying = true;

  setState('playback.status', 'playing_audio');
  setState('playback.position', safeOffset);
  bus.emit('playback:started', { offset: safeOffset, trackIndex: getState('playback.trackIndex') });

  // Track end
  source.onended = () => {
    if (isPlaying) {
      isPlaying = false;
      setState('playback.status', 'idle');
      bus.emit('playback:ended');
    }
  };

  _startPositionTracking();
  log.debug('[Playback] Playing from', safeOffset.toFixed(2) + 's');
}

/**
 * Pause playback.
 * @param {number} [position] - Override position (for sync)
 */
export function pause(position) {
  if (!isPlaying && position === undefined) return;

  const Tone = /** @type {any} */ (window).Tone;
  const pos = position ?? (Tone.now() - startedAt);

  if (source) {
    try { source.stop(); } catch (_) {}
    source.dispose();
    source = null;
  }

  pausedAt = pos;
  isPlaying = false;
  _stopPositionTracking();

  setState('playback.status', 'paused');
  setState('playback.position', pos);
  bus.emit('playback:paused', { position: pos });

  log.debug('[Playback] Paused at', pos.toFixed(2) + 's');
}

/** Stop playback completely. */
export function stop() {
  if (source) {
    try { source.stop(); } catch (_) {}
    source.dispose();
    source = null;
  }
  isPlaying = false;
  startedAt = 0;
  pausedAt = 0;
  _stopPositionTracking();
  setState('playback.status', 'idle');
  bus.emit('playback:stopped');
}

/**
 * Get current playback position in seconds.
 * @returns {number}
 */
export function getPosition() {
  if (!isPlaying) return pausedAt;
  const Tone = /** @type {any} */ (window).Tone;
  return Tone.now() - startedAt;
}

/** @returns {boolean} */
export function getIsPlaying() { return isPlaying; }

// ── Internal ──

function _startPositionTracking() {
  _stopPositionTracking();
  positionInterval = setInterval(() => {
    if (isPlaying) {
      const pos = getPosition();
      setState('playback.position', pos);
      bus.emit('playback:position', pos);
    }
  }, 250); // 4 updates/sec for UI
}

function _stopPositionTracking() {
  if (positionInterval) {
    clearInterval(positionInterval);
    positionInterval = null;
  }
}

// @ts-check
/**
 * MUSIXQUARE 2.0 - Audio Engine
 *
 * Tone.js 래핑. 오디오 컨텍스트 초기화, 노드 그래프 관리.
 * 1.0의 initAudio(), masterGain, channelSplitter 등을 캡슐화.
 *
 * 외부 의존: Tone.js (vendor, window.Tone)
 *
 * Events emitted:
 *   bus.emit('audio:ready')       - 오디오 컨텍스트 초기화 완료
 *   bus.emit('audio:suspended')   - 컨텍스트 일시정지 (브라우저 정책)
 *
 * Events consumed:
 *   state:audio.volume            - 볼륨 변경 반영
 *   state:audio.channelMode       - 채널 모드 변경 반영
 */

import { bus } from '../core/events.js';
import { getState } from '../core/state.js';
import { log } from '../core/log.js';

let masterGain = null;
let channelSplitter = null;
let channelMerger = null;
let initialized = false;

/**
 * Initialize the Tone.js audio context and master gain chain.
 * Must be called from a user gesture (click/touch).
 */
export async function initAudio() {
  if (initialized) return;
  const Tone = /** @type {any} */ (window).Tone;
  if (!Tone) {
    log.error('[Audio] Tone.js not loaded');
    return;
  }

  await Tone.start();
  log.info('[Audio] Tone.js context started');

  masterGain = new Tone.Gain(getState('audio.volume')).toDestination();

  // TODO: Port channel splitter/merger from 1.0
  // TODO: Port EQ/reverb/stereo-width chains

  initialized = true;
  bus.emit('audio:ready');
}

/**
 * Set master volume (0-1).
 * @param {number} vol
 */
export function setVolume(vol) {
  if (masterGain) {
    masterGain.gain.value = Math.max(0, Math.min(1, vol));
  }
}

/** @returns {boolean} */
export function isReady() { return initialized; }

/** Get the master gain node (for connecting sources). */
export function getMasterGain() { return masterGain; }

// React to state changes
bus.on('state:audio.volume', (vol) => setVolume(vol));

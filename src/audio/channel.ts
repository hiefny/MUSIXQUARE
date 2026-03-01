/**
 * MUSIXQUARE 2.0 — Channel Mode Routing
 * Extracted from original app.js lines 5127-5320
 *
 * Manages channel routing (Stereo/Left/Right/Sub) and 7.1 Surround mode.
 * Direct imports from engine.ts (same domain).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE } from '../core/constants.ts';
import {
  getMasterGain,
  getToneMerge,
  getGainL,
  getGainR,
  getPreamp,
  getGlobalLowPass,
  ensureSurroundNodes,
  getSurroundSplitter,
  getSurroundGain,
  initAudio,
  safeDisconnect,
} from './engine.ts';
import { applySettings } from './effects.ts';

// ─── Channel Mode ──────────────────────────────────────────────────

/**
 * Set the audio channel routing mode.
 * @param mode  0=Stereo, -1=Left, 1=Right, 2=Sub
 */
export function setChannelMode(mode: number): void {
  setState('audio.channelMode', mode);

  const mg = getMasterGain();
  if (!mg) return;

  const gL = getGainL();
  const gR = getGainR();
  const merge = getToneMerge();
  if (!gL || !gR || !merge) return;

  const lowPass = getGlobalLowPass();
  const subFreq = getState('audio.subFreq');
  const ramp = 0.05;

  // Reset LowPass to full range
  if (lowPass) (lowPass as { frequency: { value: number } }).frequency.value = 20000;

  // Reset routing
  safeDisconnect(gL);
  safeDisconnect(gR);

  // Reset gains
  gL.gain.value = 1;
  gR.gain.value = 1;

  if (mode === 0) {
    // Stereo: L→0, R→1
    gL.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);
    gL.gain.rampTo(1, ramp);
    gR.gain.rampTo(1, ramp);
  } else if (mode === -1) {
    // Left (Dual Mono): L→both
    gL.connect(merge, 0, 0);
    gL.connect(merge, 0, 1);
    gL.gain.rampTo(1, ramp);
  } else if (mode === 1) {
    // Right (Dual Mono): R→both
    gR.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);
    gR.gain.rampTo(1, ramp);
  } else if (mode === 2) {
    // Sub: L+R summed to both, with lowpass
    if (lowPass) (lowPass as { frequency: { value: number } }).frequency.value = subFreq;
    gL.connect(merge, 0, 0);
    gL.connect(merge, 0, 1);
    gR.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);
    // Instant gain drop to prevent +6dB spike
    gL.gain.value = 0.5;
    gR.gain.value = 0.5;
  } else {
    // Fallback: stereo
    gL.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);
    gL.gain.rampTo(1, ramp);
    gR.gain.rampTo(1, ramp);
  }

  applySettings();
}

// ─── 7.1 Surround Mode ────────────────────────────────────────────

/**
 * Toggle 7.1 surround mode on/off.
 */
export function toggleSurroundMode(enabled: boolean): void {
  setState('audio.isSurroundMode', enabled);

  if (enabled) {
    ensureSurroundNodes();
    const idx = getState('audio.surroundChannelIndex');
    if (idx === -1) setSurroundChannel(2); // Default to Center
    else setSurroundChannel(idx);
  } else {
    // Restore standard channel mode
    setChannelMode(getState('audio.channelMode'));
  }

  // Instant refresh: restart playback at current position if currently playing
  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
    bus.emit('audio:surround-toggled');
  }
}

/**
 * Set 7.1 surround channel index (0-7).
 *
 * 5.1 Layout: L(0), R(1), C(2), LFE(3), SL(4), SR(5)
 * 7.1 Layout: L(0), R(1), C(2), LFE(3), SL(4), SR(5), BL(6), BR(7)
 */
export function setSurroundChannel(idx: number): void {
  setState('audio.surroundChannelIndex', idx);

  const splitter = getSurroundSplitter();
  const sGain = getSurroundGain();
  if (!splitter || !sGain) return;

  const isSurround = getState('audio.isSurroundMode');
  if (!isSurround) return;

  const gL = getGainL();
  const gR = getGainR();
  const merge = getToneMerge();
  const preampNode = getPreamp();
  if (!gL || !gR || !merge || !preampNode) return;

  const lowPass = getGlobalLowPass();
  const subFreq = getState('audio.subFreq');

  try {
    safeDisconnect(sGain);
    sGain.connect(preampNode);
    safeDisconnect(splitter);

    // 5.1/7.1 compatibility routing
    if (idx === 6) {
      // Rear Left: fallback to Side Left for 5.1
      splitter.connect(sGain, 6, 0);
      splitter.connect(sGain, 4, 0);
    } else if (idx === 7) {
      // Rear Right: fallback to Side Right for 5.1
      splitter.connect(sGain, 7, 0);
      splitter.connect(sGain, 5, 0);
    } else if (idx === 3) {
      // LFE (Sub) - Direct
      splitter.connect(sGain, 3, 0);
    } else {
      // Standard 1:1 mapping
      splitter.connect(sGain, idx, 0);
    }

    // LowPass for LFE channel (rampTo avoids click on active signal path)
    if (lowPass) {
      (lowPass as { frequency: { rampTo: (v: number, t: number) => void } }).frequency.rampTo(
        idx === 3 ? subFreq : 20000, 0.02,
      );
    }

    // Force output to Dual Mono
    safeDisconnect(gL);
    safeDisconnect(gR);
    gL.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);
    gL.gain.rampTo(1, 0.1);
    gR.gain.rampTo(1, 0.1);

    const names = [
      'Front Left (L)', 'Front Right (R)', 'Center (Dialog)',
      'LFE (Sub)', 'Side Left', 'Side Right',
      'Rear Left (Back)', 'Rear Right (Back)',
    ];
    log.info(`[Surround] Channel set: ${names[idx]}`);
  } catch (e) {
    log.warn('[Surround] setSurroundChannel error:', e);
  }

}

/**
 * Set channel mode with audio init (called from UI).
 */
export async function setChannel(mode: number): Promise<void> {
  if (!getMasterGain()) await initAudio();
  setChannelMode(mode);
}

// ─── Bus Event Handlers ─────────────────────────────────────────

bus.on('audio:set-channel-mode', (mode: number) => {
  if (Number.isFinite(mode)) setChannel(mode).catch(e => log.warn('[Channel] setChannel failed:', e));
});

bus.on('audio:toggle-surround', (enabled: boolean) => {
  toggleSurroundMode(enabled);
});

bus.on('audio:set-surround-channel', (idx: number) => {
  if (Number.isFinite(idx) && idx >= 0 && idx <= 7) setSurroundChannel(idx);
});

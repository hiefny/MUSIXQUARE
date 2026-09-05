/**
 * MUSIXQUARE — Channel Mode Routing
 *
 * Manages channel routing (stereo/left/right/subwoofer) for the per-device
 * speaker roles exposed as Center, Left, Right, and Subwoofer.
 *
 * It also owns the dormant multichannel role and low-pass policy described in
 * the "7.1 Surround Mode" section below. FilePlaybackRoute alone owns the
 * stable input, splitter, and surround-gain connections.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import {
  getMasterGain,
  getToneMerge,
  getGainL,
  getGainR,
  getGlobalLowPass,
  initAudio,
  safeDisconnect,
} from './engine.ts';
import { applySettingsAsync } from './effects.ts';
import { getFullRangeFrequency, rampParam } from './helpers.ts';
import { RAMP_TIME_FAST } from './constants.ts';

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

  // Reset LowPass: skip full-range ramp when switching TO Sub (mode=2),
  // because Sub immediately sets its own target frequency and avoids a
  // transient burst of unfiltered bass during the full-range -> subFreq ramp.
  if (lowPass && mode !== 2) {
    rampParam(lowPass.frequency, getFullRangeFrequency(lowPass.context.sampleRate), RAMP_TIME_FAST);
  }

  // Reset routing
  safeDisconnect(gL);
  safeDisconnect(gR);

  // Reset gains with a short ramp to prevent audible clicks.
  // Skip for Sub mode (mode=2) — immediate .value=0.5 override avoids transient spike
  if (mode !== 2) {
    rampParam(gL.gain, 1, RAMP_TIME_FAST);
    rampParam(gR.gain, 1, RAMP_TIME_FAST);
  }

  if (mode === 0) {
    // Stereo: L→0, R→1
    gL.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);
  } else if (mode === -1) {
    // Left Only: L→both speakers
    gL.connect(merge, 0, 0);
    gL.connect(merge, 0, 1);
  } else if (mode === 1) {
    // Right Only: R→both speakers
    gR.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);
  } else if (mode === 2) {
    // Sub: L+R summed to both, with lowpass
    // Cancel earlier role ramps before connecting the immediate summing gain.
    rampParam(gL.gain, 0.5, 0);
    rampParam(gR.gain, 0.5, 0);
    if (lowPass) rampParam(lowPass.frequency, subFreq, RAMP_TIME_FAST);
    gL.connect(merge, 0, 0);
    gL.connect(merge, 0, 1);
    gR.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);
  } else {
    // Fallback: stereo
    gL.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);
  }

  applySettingsAsync();
}

// ─── 7.1 Surround Mode (dormant; no production UI) ────────────────
// Each device may select one source channel from FL/FR/C/LFE/SL/SR/BL/BR.
// FilePlaybackRoute implements 5.1 rear folding while this module retains the
// selected-role and LFE low-pass policy. The feature remains hidden because
// stereo sources leave most channels silent and the product has no placement
// or calibration flow. Exposing it requires an explicit product decision and
// UI for enabling the mode and assigning channels.

/**
 * Toggle 7.1 surround mode on/off.
 *
 * @internal Not called from the production UI.
 */
export function toggleSurroundMode(enabled: boolean): void {
  setState('audio.isSurroundMode', enabled);

  if (enabled) {
    const idx = getState('audio.surroundChannelIndex');
    if (idx === -1)
      setSurroundChannel(2); // Default to Center
    else setSurroundChannel(idx);
  } else {
    // FilePlaybackRoute owns the input, splitter, and surround gain. Publishing
    // the mode above switches that route back to the stereo widener; this
    // module only restores the per-device output-role/effect policy.
    setChannelMode(getState('audio.channelMode'));
  }
}

/**
 * Set 7.1 surround channel index (0-7).
 *
 * 5.1 Layout: L(0), R(1), C(2), LFE(3), SL(4), SR(5)
 * 7.1 Layout: L(0), R(1), C(2), LFE(3), SL(4), SR(5), BL(6), BR(7)
 *
 * @internal Not called from the production UI.
 */
export function setSurroundChannel(idx: number): void {
  // Validate channel index (0-7 for 7.1 surround)
  if (!Number.isFinite(idx) || idx < 0 || idx > 7) {
    log.warn(`[Surround] Invalid channel index: ${idx}`);
    return;
  }
  idx = Math.floor(idx);
  setState('audio.surroundChannelIndex', idx);

  const isSurround = getState('audio.isSurroundMode');
  if (!isSurround) return;

  const gL = getGainL();
  const gR = getGainR();
  const merge = getToneMerge();
  if (!gL || !gR || !merge) return;

  const lowPass = getGlobalLowPass();
  const subFreq = getState('audio.subFreq');

  try {
    // LowPass for LFE channel; ramping avoids clicks on the active signal path.
    if (lowPass) {
      const fullRange = getFullRangeFrequency(lowPass.context.sampleRate);
      rampParam(lowPass.frequency, idx === 3 ? subFreq : fullRange, RAMP_TIME_FAST);
    }

    // Force output to Dual Mono
    safeDisconnect(gL);
    safeDisconnect(gR);
    gL.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);
    rampParam(gL.gain, 1, RAMP_TIME_FAST);
    rampParam(gR.gain, 1, RAMP_TIME_FAST);

    const names = [
      'Front Left (L)',
      'Front Right (R)',
      'Center (Dialog)',
      'LFE (Sub)',
      'Side Left',
      'Side Right',
      'Rear Left (Back)',
      'Rear Right (Back)',
    ];
    log.info(`[Surround] Channel set: ${names[idx]}`);

    // Sync VirtualBass / LowPass / Preamp compensation to surround routing
    applySettingsAsync();
  } catch (e) {
    log.warn('[Surround] setSurroundChannel error:', e);
  }
}

/**
 * Set channel mode from UI.
 *
 * Persist the selected role before audio init so synchronous join/session
 * metadata reads see the user's choice even while the graph is still waking.
 */
async function setChannel(mode: number): Promise<void> {
  setChannelMode(mode);
  if (!getMasterGain()) {
    await initAudio();
    setChannelMode(getState('audio.channelMode'));
  }
}

// ─── Bus Event Handlers ─────────────────────────────────────────

bus.on('audio:set-channel-mode', (mode: number) => {
  if (Number.isFinite(mode))
    setChannel(mode).catch((e) => log.warn('[Channel] setChannel failed:', e));
});

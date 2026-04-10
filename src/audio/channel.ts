/**
 * MUSIXQUARE 3.0 — Channel Mode Routing
 *
 * Manages channel routing (Stereo/Left/Right/Sub) for the standard per-device
 * speaker role feature (exposed in the UI as "Role: Stereo / Left / Right / Sub").
 *
 * Also contains a **fully-implemented but intentionally hidden** 7.1 Surround
 * engine — see the "7.1 Surround Mode" section below for details.
 *
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
import { applySettingsAsync } from './effects.ts';
import { rampParam } from './helpers.ts';
import { FREQ_FULL_RANGE, RAMP_TIME_FAST } from './constants.ts';

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
  // because Sub immediately sets its own target frequency — avoids transient
  // burst of unfiltered bass during the 20kHz→subFreq ramp.
  if (lowPass && mode !== 2) rampParam(lowPass.frequency, FREQ_FULL_RANGE, RAMP_TIME_FAST);

  // Reset routing
  safeDisconnect(gL);
  safeDisconnect(gR);

  // Reset gains (rampTo prevents audible click, matches setSurroundChannel pattern)
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
    // Set gain BEFORE connecting to prevent +6dB spike
    gL.gain.value = 0.5;
    gR.gain.value = 0.5;
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

// ─── 7.1 Surround Mode (HIDDEN — not wired to any UI) ─────────────
//
// Status: WIP / intentionally hidden as of 2026-04.
//
// What this is:
//   Per-device multichannel routing for a true 7.1 layout — each device picks
//   one channel (FL/FR/C/LFE/SL/SR/BL/BR) from the source and plays only that
//   channel. Designed to turn a room full of phones into a physical 7.1 array.
//
// Implementation status: COMPLETE at the engine level.
//   - State: audio.isSurroundMode, audio.surroundChannelIndex
//   - Engine: ensureSurroundNodes / getSurroundSplitter / getSurroundGain (engine.ts)
//   - Bus events: audio:connect-surround, audio:disconnect-surround, audio:surround-toggled
//   - Playback integration: transport.ts:333, playback.ts:336
//   - 5.1 compatibility folding: BL+SL, BR+SR (see setSurroundChannel below)
//   - LFE channel automatically routes through the global lowpass
//
// Why it's hidden:
//   1. Source material: almost nobody has 7.1/5.1-mixed local audio/video files.
//      Streaming sources (Spotify/YouTube/Apple Music) are stereo-first.
//      With a stereo source, channels 2-7 of the ChannelSplitter are silent,
//      so enabling the mode would look like a broken "no audio" bug to users.
//   2. Deployment friction: requires 6-8 devices with deliberate room placement,
//      which conflicts with MUSIXQUARE's casual "throw a few phones together"
//      use case. The existing Stereo/Left/Right/Sub role covers casual surround.
//   3. Channel assignment UX: asking the user to label each phone as "Rear Left"
//      etc. needs a calibration flow (test tone → "that device is BL") that
//      isn't built yet.
//
// How to re-enable:
//   - Add a `toggleSurroundMode(bool)` entry point from the Settings UI.
//   - Add a channel-picker (0-7) that calls `setSurroundChannel(idx)`.
//   - Optionally: a stereo→pseudo-5.1 upmixer (center = (L+R)/2, rear = L-R
//     with delay/highcut, LFE = (L+R) lowpass) to make stereo sources audible
//     on non-FL/FR channels.
//
// Do NOT delete this code without an explicit decision — it is a feature
// in cold storage, not dead code.

/**
 * Toggle 7.1 surround mode on/off.
 *
 * @internal Not currently called from any UI. See the "HIDDEN" notice above.
 */
export function toggleSurroundMode(enabled: boolean): void {
  setState('audio.isSurroundMode', enabled);

  if (enabled) {
    ensureSurroundNodes();
    const idx = getState('audio.surroundChannelIndex');
    if (idx === -1) setSurroundChannel(2); // Default to Center
    else setSurroundChannel(idx);
  } else {
    // Disconnect surround nodes from the audio graph
    const splitter = getSurroundSplitter();
    const sGain = getSurroundGain();
    if (splitter) safeDisconnect(splitter);
    if (sGain) safeDisconnect(sGain);

    // Disconnect playerNode→splitter input (playerNode is in playback.ts scope)
    bus.emit('audio:disconnect-surround');

    // Restore standard channel mode (reconnects stereo path)
    setChannelMode(getState('audio.channelMode'));
  }

  // Instant refresh: restart playback at current position if currently playing
  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PLAYING_SYSTEM_AUDIO) {
    bus.emit('audio:surround-toggled');
  }
}

/**
 * Set 7.1 surround channel index (0-7).
 *
 * 5.1 Layout: L(0), R(1), C(2), LFE(3), SL(4), SR(5)
 * 7.1 Layout: L(0), R(1), C(2), LFE(3), SL(4), SR(5), BL(6), BR(7)
 *
 * @internal Not currently called from any UI. See the "HIDDEN" notice above
 *           `toggleSurroundMode`.
 */
export function setSurroundChannel(idx: number): void {
  // Validate channel index (0-7 for 7.1 surround)
  if (!Number.isFinite(idx) || idx < 0 || idx > 7) {
    log.warn(`[Surround] Invalid channel index: ${idx}`);
    return;
  }
  idx = Math.floor(idx);
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

    // Channel mapping — mirrors audio:connect-surround in engine.ts
    if (idx === 3) {
      // LFE (Sub) — direct
      splitter.connect(sGain, 3, 0);
    } else if (idx === 6) {
      // Rear Left (BL) — also include Side Left (SL) for 5.1 compatibility
      splitter.connect(sGain, 6, 0);
      splitter.connect(sGain, 4, 0);
    } else if (idx === 7) {
      // Rear Right (BR) — also include Side Right (SR) for 5.1 compatibility
      splitter.connect(sGain, 7, 0);
      splitter.connect(sGain, 5, 0);
    } else {
      // Standard 1:1 mapping (FL, FR, C, SL, SR)
      splitter.connect(sGain, idx, 0);
    }

    // LowPass for LFE channel (rampTo avoids click on active signal path)
    if (lowPass) {
      rampParam(lowPass.frequency, idx === 3 ? subFreq : FREQ_FULL_RANGE, RAMP_TIME_FAST);
    }

    // Force output to Dual Mono
    safeDisconnect(gL);
    safeDisconnect(gR);
    gL.connect(merge, 0, 0);
    gR.connect(merge, 0, 1);
    rampParam(gL.gain, 1, RAMP_TIME_FAST);
    rampParam(gR.gain, 1, RAMP_TIME_FAST);

    const names = [
      'Front Left (L)', 'Front Right (R)', 'Center (Dialog)',
      'LFE (Sub)', 'Side Left', 'Side Right',
      'Rear Left (Back)', 'Rear Right (Back)',
    ];
    log.info(`[Surround] Channel set: ${names[idx]}`);

    // Sync VirtualBass / LowPass / Preamp compensation to surround routing
    applySettingsAsync();
  } catch (e) {
    log.warn('[Surround] setSurroundChannel error:', e);
  }
}

/**
 * Set channel mode with audio init (called from UI).
 */
async function setChannel(mode: number): Promise<void> {
  if (!getMasterGain()) await initAudio();
  setChannelMode(mode);
}

// ─── Bus Event Handlers ─────────────────────────────────────────

bus.on('audio:set-channel-mode', (mode: number) => {
  if (Number.isFinite(mode)) setChannel(mode).catch(e => log.warn('[Channel] setChannel failed:', e));
});


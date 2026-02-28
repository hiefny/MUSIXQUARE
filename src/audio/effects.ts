/**
 * MUSIXQUARE 2.0 — Audio Effects
 * Extracted from original app.js lines 5342-5640
 *
 * Manages: Reverb (wet/dry + damping), 5-band EQ, Virtual Bass,
 * Stereo Width, Preamp gain compensation.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import { broadcast } from '../network/peer.ts';
import type { DataConnection, AnyProtocolMsg } from '../types/index.ts';
import {
  getMasterGain,
  getReverb,
  getRvbLowCut,
  getRvbHighCut,
  getRvbCrossFade,
  getEqNodes,
  getPreamp,
  getWidener,
  getGlobalLowPass,
  getVbFilter,
  getVbPostFilter,
  getVbGain,
} from './engine.ts';

// ─── Apply All Settings ────────────────────────────────────────────

/**
 * Synchronize all audio effect parameters to the Tone.js nodes.
 * Call after any setting change.
 */
export function applySettings(): void {
  if (!getMasterGain()) return;

  const reverbMix = getState('audio.reverbMix');
  const reverbDecay = getState('audio.reverbDecay');
  const reverbPreDelay = getState('audio.reverbPreDelay');
  const reverbLowCut = getState('audio.reverbLowCut');
  const reverbHighCut = getState('audio.reverbHighCut');
  const stereoWidth = getState('audio.stereoWidth');
  const virtualBass = getState('audio.virtualBass');
  const eqValues = getState('audio.eqValues');
  const userPreampGain = getState('audio.userPreampGain');
  const channelMode = getState('audio.channelMode');
  const isSurroundMode = getState('audio.isSurroundMode');
  const surroundChannelIndex = getState('audio.surroundChannelIndex');
  const subFreq = getState('audio.subFreq');

  // Reverb Mix (CrossFade)
  const crossFade = getRvbCrossFade();
  if (crossFade) crossFade.fade.rampTo(reverbMix, 0.1);

  // Reverb Engine Sync
  const rev = getReverb();
  if (rev) {
    let needsGenerate = false;
    if (rev.decay !== reverbDecay) {
      rev.decay = reverbDecay;
      needsGenerate = true;
    }
    if (rev.preDelay !== reverbPreDelay) {
      rev.preDelay = reverbPreDelay;
      needsGenerate = true;
    }
    if (needsGenerate) {
      rev.generate().catch(e => log.warn('[Reverb] generate() failed:', e));
    }
  }

  // Reverb damping filters (clamp to [0, 100] for safety)
  const rlc = getRvbLowCut();
  if (rlc) {
    const lFreq = 20 * Math.pow(50, Math.max(0, Math.min(100, reverbLowCut)) / 100);
    rlc.frequency.rampTo(lFreq, 0.1);
  }
  const rhc = getRvbHighCut();
  if (rhc) {
    const hFreq = 20000 * Math.pow(0.05, Math.max(0, Math.min(100, reverbHighCut)) / 100);
    rhc.frequency.rampTo(hFreq, 0.1);
  }

  // EQ Sync (clamp to [-12, 12] dB for safety)
  const nodes = getEqNodes();
  if (nodes && eqValues) {
    nodes.forEach((node, i) => {
      const clamped = Math.max(-12, Math.min(12, eqValues[i]));
      if (node.gain.value !== clamped) {
        node.gain.rampTo(clamped, 0.1);
      }
    });
  }

  // Stereo Width & Gain Compensation
  let compensation = 1.0;
  const wid = getWidener();
  if (wid) {
    wid.wet.rampTo(1, 0.1);
    wid.width.rampTo(stereoWidth * 0.5, 0.1);
    if (stereoWidth < 1.0) {
      compensation = 0.6 + 0.4 * stereoWidth;
    }
  }

  // Preamp
  const pre = getPreamp();
  if (pre) pre.gain.rampTo(userPreampGain * compensation, 0.1);

  // Virtual Bass
  const isWooferRole = channelMode === 2 || (isSurroundMode && surroundChannelIndex === 3);
  const vbf = getVbFilter();
  if (vbf) vbf.frequency.rampTo(subFreq, 0.1);
  const vbpf = getVbPostFilter();
  if (vbpf) {
    vbpf.frequency.rampTo(isWooferRole ? subFreq : 20000, 0.1);
  }
  const vbg = getVbGain();
  if (vbg) vbg.gain.rampTo(virtualBass, 0.1);

  // Global LowPass
  const lp = getGlobalLowPass();
  if (lp) {
    lp.frequency.rampTo(isWooferRole ? subFreq : 20000, 0.1);
  }
}

// ─── Reverb Controls ───────────────────────────────────────────────

export function setReverbParam(param: string, val: number, skipApply = false): void {
  const v = Number(val);
  if (!Number.isFinite(v)) return;

  switch (param) {
    case 'mix':
      setState('audio.reverbMix', v / 100);
      break;
    case 'decay':
      setState('audio.reverbDecay', v);
      break;
    case 'predelay':
      setState('audio.reverbPreDelay', v);
      break;
    case 'lowcut':
      setState('audio.reverbLowCut', v);
      break;
    case 'highcut':
      setState('audio.reverbHighCut', v);
      break;
  }

  if (!skipApply) applySettings();
}

export function resetReverb(): void {
  setReverbParam('mix', 0, true);
  setReverbParam('decay', 5.0, true);
  setReverbParam('predelay', 0.1, true);
  setReverbParam('lowcut', 0, true);
  setReverbParam('highcut', 0, true);
  applySettings();
}

// ─── EQ Controls ───────────────────────────────────────────────────

export function setEQ(idx: number, val: number): void {
  const bandIdx = Number(idx);
  const bandVal = Number(val);

  const eqValues = getState('audio.eqValues');
  if (!eqValues || bandIdx < 0 || bandIdx >= eqValues.length) return;

  const newValues = [...eqValues];
  newValues[bandIdx] = bandVal;
  setState('audio.eqValues', newValues);

  const nodes = getEqNodes();
  if (nodes?.[bandIdx]) {
    nodes[bandIdx].gain.rampTo(bandVal, 0.1);
  }

  // Update DOM label + slider (for sync from network)
  const label = document.getElementById(`eq-val-${bandIdx}`);
  if (label) label.innerText = bandVal > 0 ? `+${bandVal}` : String(bandVal);
  const bands = document.querySelectorAll('.eq-band');
  if (bands[bandIdx]) {
    const slider = bands[bandIdx].querySelector('.eq-slider') as HTMLInputElement | null;
    if (slider && parseFloat(slider.value) !== bandVal) slider.value = String(bandVal);
  }
}

export function resetEQ(): void {
  const nodes = getEqNodes();
  const count = nodes ? nodes.length : 5;
  setState('audio.eqValues', Array(count).fill(0));
  setState('audio.userPreampGain', 1.0);
  nodes?.forEach(node => node.gain.rampTo(0, 0.1));
  applySettings();
}

// ─── Preamp ────────────────────────────────────────────────────────

export function setPreamp(valDb: number): void {
  const db = Number(valDb);
  const linear = Math.pow(10, db / 20);
  setState('audio.userPreampGain', linear);
  applySettings();
}

// ─── Stereo Width ──────────────────────────────────────────────────

export function setStereoWidth(val: number): void {
  setState('audio.stereoWidth', val / 100);
  applySettings();
}

export function resetStereoWidth(): void {
  setStereoWidth(100);
}

// ─── Virtual Bass ──────────────────────────────────────────────────

export function setVirtualBass(val: number): void {
  setState('audio.virtualBass', val / 100);
  applySettings();
}

export function resetVirtualBass(): void {
  setVirtualBass(0);
}

// ─── Subwoofer Cutoff ──────────────────────────────────────────────

export function updateSubFreq(val: number): void {
  const freq = Number(val);
  setState('audio.subFreq', freq);

  const vbf = getVbFilter();
  if (vbf) vbf.frequency.rampTo(freq, 0.1);

  const channelMode = getState('audio.channelMode');
  const isSurroundMode = getState('audio.isSurroundMode');
  const surroundChannelIndex = getState('audio.surroundChannelIndex');
  const isSubMode = channelMode === 2 && !isSurroundMode;
  const isLFE = isSurroundMode && surroundChannelIndex === 3;

  const vbpf = getVbPostFilter();
  if (vbpf) {
    vbpf.frequency.rampTo((isSubMode || isLFE) ? freq : 20000, 0.1);
  }

  const lp = getGlobalLowPass();
  if (lp && (isSubMode || isLFE)) {
    lp.frequency.rampTo(freq, 0.1);
  }
}

// ─── Network Broadcast Helpers ───────────────────────────────────

/**
 * Broadcast an audio setting change (Host) or send REQUEST_SETTING (OP Guest).
 * Called only on 'change' event (slider release), not during 'input' (dragging).
 */
function _broadcastOrRequestSetting(msgType: string, value: number): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    // Host: broadcast to all peers
    broadcast({ type: msgType, value } as AnyProtocolMsg);
  } else {
    // Guest (OP): request Host to apply + broadcast
    const isOperator = getState('network.isOperator');
    if (isOperator) {
      hostConn.send({ type: MSG.REQUEST_SETTING, settingType: msgType, value });
    }
  }
}

function _broadcastOrRequestSettingEQ(band: number, value: number): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    broadcast({ type: MSG.EQ_UPDATE, band, value });
  } else {
    const isOperator = getState('network.isOperator');
    if (isOperator) {
      hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'eq', band, value });
    }
  }
}

// ─── Bus Event Handlers ─────────────────────────────────────────

/** Central audio effect dispatcher from settings UI */
bus.on('audio:update-effect', (type, param, value, isPreview) => {
  if (!Number.isFinite(value)) return;

  switch (type) {
    case 'reverb':
      setReverbParam(param, value);
      // Broadcast on release only (not while dragging)
      if (!isPreview) {
        const REVERB_MSG_MAP: Record<string, string> = {
          mix: MSG.REVERB, decay: MSG.REVERB_DECAY, predelay: MSG.REVERB_PREDELAY,
          lowcut: MSG.REVERB_LOWCUT, highcut: MSG.REVERB_HIGHCUT,
        };
        const msgType = REVERB_MSG_MAP[param];
        if (msgType) _broadcastOrRequestSetting(msgType, value);
      }
      break;
    case 'stereo':
      if (param === 'mix') {
        setStereoWidth(value);
        if (!isPreview) {
          const hostConn = getState('network.hostConn');
          if (!hostConn) {
            broadcast({ type: MSG.STEREO_WIDTH, value });
          } else {
            const isOperator = getState('network.isOperator');
            if (isOperator) {
              hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'stereo', value });
            }
          }
        }
      }
      break;
    case 'vbass':
      if (param === 'mix') {
        setVirtualBass(value);
        if (!isPreview) _broadcastOrRequestSetting(MSG.VBASS, value);
      }
      break;
    case 'cutoff':
      if (param === 'value') updateSubFreq(value);
      break;
    default:
      log.warn('[Effects] Unknown effect type:', type);
  }
});

/** Set preamp gain from dB value */
bus.on('audio:set-preamp', (value, isPreview) => {
  if (!Number.isFinite(value)) return;
  setPreamp(value);
  if (!isPreview) _broadcastOrRequestSetting(MSG.PREAMP, value);
});

/** Set EQ band */
bus.on('audio:set-eq', (band, value, isPreview) => {
  if (!Number.isFinite(band) || !Number.isFinite(value)) return;
  setEQ(band, value);
  if (!isPreview) {
    _broadcastOrRequestSettingEQ(band, value);
  }
});

/** Reset handlers — with OP/Host routing */
bus.on('audio:reset-reverb', () => {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    // Host: reset locally + broadcast
    resetReverb();
    broadcast({ type: MSG.REVERB, value: 0 });
    broadcast({ type: MSG.REVERB_DECAY, value: 5.0 });
    broadcast({ type: MSG.REVERB_PREDELAY, value: 0.1 });
    broadcast({ type: MSG.REVERB_LOWCUT, value: 0 });
    broadcast({ type: MSG.REVERB_HIGHCUT, value: 0 });
  } else {
    const isOperator = getState('network.isOperator');
    if (isOperator) {
      hostConn.send({ type: MSG.REQUEST_REVERB_RESET });
    }
  }
});

bus.on('audio:reset-eq', () => {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    // Host: reset locally + broadcast
    resetEQ();
    broadcast({ type: MSG.EQ_RESET });
  } else {
    const isOperator = getState('network.isOperator');
    if (isOperator) {
      hostConn.send({ type: MSG.REQUEST_EQ_RESET });
    }
  }
});

bus.on('audio:reset-stereo', () => {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    resetStereoWidth();
    broadcast({ type: MSG.STEREO_WIDTH, value: 100 });
  } else {
    const isOperator = getState('network.isOperator');
    if (isOperator) {
      hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'stereo', value: 100 });
    }
  }
});

bus.on('audio:reset-vbass', () => {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    resetVirtualBass();
    broadcast({ type: MSG.VBASS, value: 0 });
  } else {
    const isOperator = getState('network.isOperator');
    if (isOperator) {
      hostConn.send({ type: MSG.REQUEST_SETTING, settingType: MSG.VBASS, value: 0 });
    }
  }
});

/** Sync state defaults to Tone.js nodes after audio graph init */
bus.on('audio:ready', () => {
  log.info('[Effects] Audio ready — applying default settings');
  applySettings();
});

/**
 * Host: Send all current audio settings to a newly connected peer (late-join bootstrap).
 */
bus.on('network:peer-connected', (conn) => {
  if (!conn?.open) return;

  // Only Host bootstraps guests
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  try {
    const masterVolume = getState('audio.masterVolume');
    conn.send({ type: MSG.VOLUME, value: masterVolume });

    const reverbMix = getState('audio.reverbMix');
    conn.send({ type: MSG.REVERB, value: reverbMix * 100 });

    const reverbDecay = getState('audio.reverbDecay');
    conn.send({ type: MSG.REVERB_DECAY, value: reverbDecay });

    const reverbPreDelay = getState('audio.reverbPreDelay');
    conn.send({ type: MSG.REVERB_PREDELAY, value: reverbPreDelay });

    const reverbLowCut = getState('audio.reverbLowCut');
    conn.send({ type: MSG.REVERB_LOWCUT, value: reverbLowCut });

    const reverbHighCut = getState('audio.reverbHighCut');
    conn.send({ type: MSG.REVERB_HIGHCUT, value: reverbHighCut });

    const eqValues = getState('audio.eqValues');
    if (eqValues) {
      eqValues.forEach((val, i) => {
        conn.send({ type: MSG.EQ_UPDATE, band: i, value: val });
      });
    }

    const userPreampGain = getState('audio.userPreampGain');
    conn.send({ type: MSG.PREAMP, value: Math.round(20 * Math.log10(Math.max(userPreampGain, 1e-6))) });

    const stereoWidth = getState('audio.stereoWidth');
    conn.send({ type: MSG.STEREO_WIDTH, value: stereoWidth * 100 });

    const virtualBass = getState('audio.virtualBass');
    conn.send({ type: MSG.VBASS, value: virtualBass * 100 });

    log.debug('[Effects] Bootstrap: sent audio settings to new peer');
  } catch (e) {
    log.warn('[Effects] Bootstrap send failed:', e);
  }
});

// ─── Network Protocol Handlers (Host→Guest effect sync) ──────────

function handleVolume(data: Record<string, unknown>): void {
  if (data.value === undefined || data.value === null) return;
  const vol = Number(data.value);
  bus.emit('audio:set-volume', vol);
  bus.emit('ui:show-toast', `Volume: ${Math.round(vol * 100)}%`);
}

function handleEQUpdateMsg(data: Record<string, unknown>): void {
  if (data.band === undefined || data.value === undefined) return;
  setEQ(Number(data.band), Number(data.value));
}

function handlePreampMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  setPreamp(Number(data.value));
}

function handleEQResetMsg(): void {
  resetEQ();
}

function handleReverbMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  setReverbParam('mix', Number(data.value));
}

function handleReverbTypeMsg(data: Record<string, unknown>): void {
  if (!data.value) return;
  const type = String(data.value);
  switch (type) {
    case 'room':
      setState('audio.reverbDecay', 1.5);
      setState('audio.reverbPreDelay', 0.05);
      break;
    case 'hall':
      setState('audio.reverbDecay', 3.5);
      setState('audio.reverbPreDelay', 0.1);
      break;
    case 'space':
      setState('audio.reverbDecay', 7.0);
      setState('audio.reverbPreDelay', 0.2);
      break;
    default:
      return;
  }
  applySettings();
  bus.emit('ui:show-toast', t('toast.reverb_type', { type }));
}

function handleReverbDecayMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  setReverbParam('decay', Number(data.value));
}

function handleReverbPreDelayMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  setReverbParam('predelay', Number(data.value));
}

function handleReverbLowCutMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  setReverbParam('lowcut', Number(data.value));
}

function handleReverbHighCutMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  setReverbParam('highcut', Number(data.value));
}

function handleStereoWidthMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  setStereoWidth(Number(data.value));
}

function handleVBassMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  setVirtualBass(Number(data.value));
}

// ─── Operator Request Handlers (Host-side) ──────────────────────

function handleRequestEQReset(_data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only Host

  if (!verifyOperator(conn)) {
    log.warn(`[Effects] Rejected request-eq-reset from non-OP: ${conn?.peer}`);
    return;
  }

  resetEQ();
  broadcast({ type: MSG.EQ_RESET });
}

function handleRequestReverbReset(_data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn)) {
    log.warn(`[Effects] Rejected request-reverb-reset from non-OP: ${conn?.peer}`);
    return;
  }

  resetReverb();
  // Broadcast each reverb param reset individually so guests sync
  broadcast({ type: MSG.REVERB, value: 0 });
  broadcast({ type: MSG.REVERB_DECAY, value: 5.0 });
  broadcast({ type: MSG.REVERB_PREDELAY, value: 0.1 });
  broadcast({ type: MSG.REVERB_LOWCUT, value: 0 });
  broadcast({ type: MSG.REVERB_HIGHCUT, value: 0 });
}

// ─── Init Effects Protocol Handlers ──────────────────────────────

export function initEffectsHandlers(): void {
  registerHandlers({
    [MSG.VOLUME]: handleVolume,
    [MSG.EQ_UPDATE]: handleEQUpdateMsg,
    [MSG.PREAMP]: handlePreampMsg,
    [MSG.EQ_RESET]: handleEQResetMsg,
    [MSG.REVERB]: handleReverbMsg,
    [MSG.REVERB_TYPE]: handleReverbTypeMsg,
    [MSG.REVERB_DECAY]: handleReverbDecayMsg,
    [MSG.REVERB_PREDELAY]: handleReverbPreDelayMsg,
    [MSG.REVERB_LOWCUT]: handleReverbLowCutMsg,
    [MSG.REVERB_HIGHCUT]: handleReverbHighCutMsg,
    [MSG.STEREO_WIDTH]: handleStereoWidthMsg,
    [MSG.VBASS]: handleVBassMsg,
    [MSG.REQUEST_EQ_RESET]: handleRequestEQReset,
    [MSG.REQUEST_REVERB_RESET]: handleRequestReverbReset,
  });

  log.info('[Effects] Protocol handlers registered');
}

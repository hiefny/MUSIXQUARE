/**
 * MUSIXQUARE 3.0 — Audio Effects
 *
 * Manages: Reverb (wet/dry + damping), 5-band EQ, Virtual Bass,
 * Stereo Width, Preamp gain compensation.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { setManagedTimer } from '../core/timers.ts';
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
  getVbGain,
} from './engine.ts';

// ─── Constants ────────────────────────────────────────────────────
const RAMP_TIME = 0.1; // seconds — standard audio parameter ramp duration

// ─── Cached DOM Elements ──────────────────────────────────────────

// ─── Apply All Settings ────────────────────────────────────────────

/**
 * Synchronize all audio effect parameters to the Tone.js nodes.
 * Call after any setting change.
 */
export async function applySettings(): Promise<void> {
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
  if (crossFade) crossFade.fade.rampTo(reverbMix, RAMP_TIME);

  // Reverb Engine Sync (with retry on failure)
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
      await _generateReverbWithRetry(rev);
    }
  }

  // Reverb damping filters (clamp to [0, 100] for safety)
  const rlc = getRvbLowCut();
  if (rlc) {
    const lFreq = 20 * Math.pow(50, Math.max(0, Math.min(100, reverbLowCut)) / 100);
    rlc.frequency.rampTo(lFreq, RAMP_TIME);
  }
  const rhc = getRvbHighCut();
  if (rhc) {
    const hFreq = 20000 * Math.pow(0.05, Math.max(0, Math.min(100, reverbHighCut)) / 100);
    rhc.frequency.rampTo(hFreq, RAMP_TIME);
  }

  // EQ Sync (clamp to [-12, 12] dB for safety)
  const nodes = getEqNodes();
  if (nodes && nodes.length > 0 && eqValues) {
    nodes.forEach((node, i) => {
      if (!node?.gain) return;
      const raw = eqValues[i] ?? 0;
      const clamped = Math.max(-12, Math.min(12, raw));
      if (node.gain.value !== clamped) {
        node.gain.rampTo(clamped, RAMP_TIME);
      }
    });
  }

  // Stereo Width & Gain Compensation
  let compensation = 1.0;
  const wid = getWidener();
  if (wid) {
    if (wid.wet.value !== 1) wid.wet.rampTo(1, RAMP_TIME);
    wid.width.rampTo(stereoWidth * 0.5, RAMP_TIME);
    if (stereoWidth < 1.0) {
      compensation = 0.6 + 0.4 * stereoWidth;
    } else if (stereoWidth > 1.0) {
      // Wide stereo: compensate to prevent volume boost
      compensation = Math.max(0.5, 1.0 / (0.6 + 0.4 * stereoWidth));
    }
  }

  // Preamp
  const pre = getPreamp();
  if (pre) pre.gain.rampTo(userPreampGain * compensation, RAMP_TIME);

  // Virtual Bass — dual-band chain has fixed crossover points, just control output gain
  const isWooferRole = channelMode === 2 || (isSurroundMode && surroundChannelIndex === 3);
  const vbg = getVbGain();
  if (vbg) {
    // Mute VB in woofer/LFE mode (subwoofer doesn't need psychoacoustic bass)
    const targetGain = isWooferRole ? 0 : virtualBass;
    vbg.gain.rampTo(targetGain, RAMP_TIME);
  }

  // Global LowPass
  const lp = getGlobalLowPass();
  if (lp) {
    lp.frequency.rampTo(isWooferRole ? subFreq : 20000, RAMP_TIME);
  }
}

// ─── Reverb Generate with Retry ────────────────────────────────────

let _reverbGenerateInFlight = false;
let _reverbGeneratePending = false;
let _reverbGenerationId = 0;

async function _generateReverbWithRetry(rev: ReturnType<typeof getReverb>, maxRetries = 2): Promise<void> {
  if (_reverbGenerateInFlight) {
    _reverbGeneratePending = true;
    return;
  }
  _reverbGenerateInFlight = true;
  _reverbGeneratePending = false;
  const generationId = ++_reverbGenerationId;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Bail out if a newer generation was requested (prevents stale retries)
    if (generationId !== _reverbGenerationId) {
      _reverbGenerateInFlight = false;
      return;
    }
    let timeoutId: number | undefined;
    try {
      // Race with timeout — clear timer in finally to prevent leak
      await Promise.race([
        rev!.generate(),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error('timeout')), 3000);
        }),
      ]);
      _reverbGenerateInFlight = false;

      // Re-generate if params changed while in-flight (last-write-wins)
      if (_reverbGeneratePending && generationId === _reverbGenerationId) {
        _reverbGeneratePending = false;
        return _generateReverbWithRetry(rev, maxRetries);
      }
      return;
    } catch (e) {
      log.warn(`[Reverb] generate() attempt ${attempt + 1}/${maxRetries + 1} failed:`, e);
      if (attempt === maxRetries) {
        bus.emit('ui:show-toast', t('toast.reverb_init_fail'));
      }
    } finally {
      window.clearTimeout(timeoutId);
    }
  }
  _reverbGenerateInFlight = false;

  // Don't drop pending request — if params changed during failed retries, retry once more
  if (_reverbGeneratePending) {
    _reverbGeneratePending = false;
    return _generateReverbWithRetry(rev, maxRetries);
  }
}

// ─── Reverb Controls ───────────────────────────────────────────────

export function setReverbParam(param: string, val: number, skipApply = false): void {
  const v = Number(val);
  if (!Number.isFinite(v)) return;

  switch (param) {
    case 'mix':
      setState('audio.reverbMix', Math.max(0, Math.min(1, v / 100)));
      break;
    case 'decay':
      setState('audio.reverbDecay', Math.max(0.1, Math.min(30, v)));
      break;
    case 'predelay':
      setState('audio.reverbPreDelay', Math.max(0, Math.min(1, v)));
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

function resetReverb(): void {
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

  const clamped = Math.max(-12, Math.min(12, bandVal));
  const newValues = [...eqValues];
  newValues[bandIdx] = clamped;
  setState('audio.eqValues', newValues);

  const nodes = getEqNodes();
  if (nodes?.[bandIdx]) {
    nodes[bandIdx].gain.rampTo(clamped, RAMP_TIME);
  }

  // Notify UI layer to sync slider (avoids audio module doing DOM ops)
  bus.emit('ui:sync-eq-band', bandIdx, clamped);
}

export function resetEQ(): void {
  const nodes = getEqNodes();
  const count = nodes ? nodes.length : 5;
  setState('audio.eqValues', Array(count).fill(0));
  setState('audio.userPreampGain', 1.0);
  nodes?.forEach(node => node.gain.rampTo(0, RAMP_TIME));
  applySettings();
}

// ─── Preamp ────────────────────────────────────────────────────────

export function setPreamp(valDb: number): void {
  const db = Math.max(-48, Math.min(12, Number(valDb)));
  const linear = Math.pow(10, db / 20);
  setState('audio.userPreampGain', linear);
  applySettings();
}

// ─── Stereo Width ──────────────────────────────────────────────────

export function setStereoWidth(val: number): void {
  setState('audio.stereoWidth', Math.max(0, Math.min(2, val / 100)));
  applySettings();
}

export function resetStereoWidth(): void {
  setStereoWidth(100);
}

// ─── Virtual Bass ──────────────────────────────────────────────────

export function setVirtualBass(val: number): void {
  setState('audio.virtualBass', Math.max(0, Math.min(1, val / 100)));
  applySettings();
}

export function resetVirtualBass(): void {
  setVirtualBass(0);
}

// ─── Subwoofer Cutoff ──────────────────────────────────────────────

function updateSubFreq(val: number): void {
  const freq = Math.max(20, Math.min(500, Number(val)));
  if (!Number.isFinite(freq)) return;
  setState('audio.subFreq', freq);
  applySettings();
}

// ─── Network Broadcast Helpers ───────────────────────────────────

/**
 * Broadcast an audio setting change (Host) or send REQUEST_SETTING (OP Guest).
 * Called only on 'change' event (slider release), not during 'input' (dragging).
 */
function _broadcastOrRequestSetting(msgType: string, value: number | string): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    // Host: broadcast to all peers
    broadcast({ type: msgType, value } as AnyProtocolMsg);
  } else {
    // Guest (OP): request Host to apply + broadcast
    const isOperator = getState('network.isOperator');
    if (isOperator && hostConn.open) {
      hostConn.send({ type: MSG.REQUEST_SETTING, settingType: msgType, value });
    } else if (!isOperator) {
      bus.emit('ui:show-toast', t('toast.operator_required'));
    }
  }
}

function _broadcastOrRequestSettingEQ(band: number, value: number): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    broadcast({ type: MSG.EQ_UPDATE, band, value });
  } else {
    const isOperator = getState('network.isOperator');
    if (isOperator && hostConn.open) {
      hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'eq', band, value });
    } else {
      bus.emit('ui:show-toast', t('toast.operator_required'));
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
            if (isOperator && hostConn.open) {
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

/** Set EQ band */
bus.on('audio:set-eq', (band, value, isPreview) => {
  if (!Number.isFinite(band) || !Number.isFinite(value)) return;
  setEQ(band, value);
  if (!isPreview) {
    _broadcastOrRequestSettingEQ(band, value);
  }
});

/** Reverb preset type change from UI chip */
bus.on('audio:reverb-type-change', (type: string) => {
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    // OP Guest: only send REQUEST to host — host will broadcast back
    // (skip local apply to avoid double-application when broadcast arrives)
    const isOperator = getState('network.isOperator');
    if (isOperator && hostConn.open) {
      hostConn.send({ type: MSG.REQUEST_SETTING, settingType: MSG.REVERB_TYPE, value: type });
    } else if (!isOperator) {
      bus.emit('ui:show-toast', t('toast.operator_required'));
    }
  } else {
    // Host: apply locally + broadcast
    handleReverbTypeMsg({ value: type });
    broadcast({ type: MSG.REVERB_TYPE, value: type } as AnyProtocolMsg);
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
    if (isOperator && hostConn.open) {
      hostConn.send({ type: MSG.REQUEST_EQ_RESET });
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
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setPreamp(v);
}

// ─── Host-ctrl 변경 토스트 (게스트 전용, 디바운스) ────────────

function _notifyHostChanged(): void {
  // 호스트 연결 중인 게스트만 표시
  if (!getState('network.hostConn')) return;
  setManagedTimer('host-change-toast', () => {
    bus.emit('ui:show-toast', t('toast.host_changed_setting'));
  }, 300);
}

function handleEQResetMsg(): void {
  resetEQ();
  bus.emit('ui:sync-eq-preset', 'off');
  _notifyHostChanged();
}

function handleReverbMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  const v = Number(data.value);
  setReverbParam('mix', v);
  bus.emit('ui:sync-reverb-param', 'mix', v);
  _notifyHostChanged();
}

function handleReverbTypeMsg(data: Record<string, unknown>): void {
  if (data.value == null) return;
  const type = String(data.value);
  switch (type) {
    case 'off':
      resetReverb();
      bus.emit('ui:sync-reverb-preset', 'off');
      _notifyHostChanged();
      return;
    case 'studio':
      setState('audio.reverbMix', 0.3);
      setState('audio.reverbDecay', 1.0);
      setState('audio.reverbPreDelay', 0.02);
      setState('audio.reverbLowCut', 0);
      setState('audio.reverbHighCut', 0);
      break;
    case 'arena':
      setState('audio.reverbMix', 0.4);
      setState('audio.reverbDecay', 5.0);
      setState('audio.reverbPreDelay', 0.12);
      setState('audio.reverbLowCut', 0);
      setState('audio.reverbHighCut', 0);
      break;
    default:
      return;
  }
  applySettings();
  bus.emit('ui:sync-reverb-preset', type);
  _notifyHostChanged();
}

function handleReverbDecayMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  const v = Number(data.value);
  setReverbParam('decay', v);
  bus.emit('ui:sync-reverb-param', 'decay', v);
  _notifyHostChanged();
}

function handleReverbPreDelayMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  const v = Number(data.value);
  setReverbParam('predelay', v);
  bus.emit('ui:sync-reverb-param', 'predelay', v);
  _notifyHostChanged();
}

function handleReverbLowCutMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  const v = Number(data.value);
  setReverbParam('lowcut', v);
  bus.emit('ui:sync-reverb-param', 'lowcut', v);
  _notifyHostChanged();
}

function handleReverbHighCutMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  const v = Number(data.value);
  setReverbParam('highcut', v);
  bus.emit('ui:sync-reverb-param', 'highcut', v);
  _notifyHostChanged();
}

function handleStereoWidthMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setStereoWidth(v);
  bus.emit('ui:sync-surround', v > 100);
  _notifyHostChanged();
}

function handleVBassMsg(data: Record<string, unknown>): void {
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setVirtualBass(v);
  bus.emit('ui:sync-vbass', v > 0);
  _notifyHostChanged();
}

// ─── Operator Request Handlers (Host-side) ──────────────────────

function handleRequestEQReset(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only Host

  if (!verifyOperator(conn, data)) {
    log.warn(`[Effects] Rejected request-eq-reset from non-OP: ${conn?.peer}`);
    return;
  }

  resetEQ();
  broadcast({ type: MSG.EQ_RESET });
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
  });

  log.info('[Effects] Protocol handlers registered');
}

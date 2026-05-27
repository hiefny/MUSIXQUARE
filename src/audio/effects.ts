/**
 * MUSIXQUARE — Audio Effects (Native Web Audio API)
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
  getExciterGain,
} from './engine.ts';
import {
  rampParam,
  setCrossFade,
  generateReverbIR,
  getFullRangeFrequency,
  clampFilterFrequency,
} from './helpers.ts';
import { showToast } from '../ui/toast.ts';
import {
  RAMP_TIME,
  SUB_FREQ_MIN,
  SUB_FREQ_MAX,
  REVERB_DEFAULT_DECAY,
  REVERB_DEFAULT_PREDELAY,
  REVERB_LOWCUT_BASE,
  REVERB_LOWCUT_FACTOR,
  REVERB_HIGHCUT_BASE,
  REVERB_HIGHCUT_FACTOR,
  REVERB_PRESETS,
  STEREO_NARROW_BASE,
  STEREO_NARROW_SCALE,
  STEREO_WIDE_FLOOR,
  EXCITER_MIX_GAIN,
} from './constants.ts';

// ─── Apply All Settings ────────────────────────────────────────────

/** Fire-and-forget wrapper — prevents unhandled promise rejection from applySettings */
export function applySettingsAsync(): void {
  applySettings().catch((e) => log.warn('[Effects] applySettings failed:', e));
}

export async function applySettings(): Promise<void> {
  if (!getMasterGain()) return;

  const reverbMix = getState('audio.reverbMix');
  const reverbDecay = getState('audio.reverbDecay');
  const reverbPreDelay = getState('audio.reverbPreDelay');
  const reverbLowCut = getState('audio.reverbLowCut');
  const reverbHighCut = getState('audio.reverbHighCut');
  const stereoWidth = getState('audio.stereoWidth');
  const virtualBass = getState('audio.virtualBass');
  const exciterOn = getState('audio.exciter');
  const eqValues = getState('audio.eqValues');
  const userPreampGain = getState('audio.userPreampGain');
  const channelMode = getState('audio.channelMode');
  const isSurroundMode = getState('audio.isSurroundMode');
  const surroundChannelIndex = getState('audio.surroundChannelIndex');
  const subFreq = getState('audio.subFreq');

  // Reverb Mix (CrossFade)
  const crossFade = getRvbCrossFade();
  if (crossFade) setCrossFade(crossFade, reverbMix, RAMP_TIME);

  // Reverb damping filters
  const rlc = getRvbLowCut();
  if (rlc) {
    const lFreq =
      REVERB_LOWCUT_BASE *
      Math.pow(REVERB_LOWCUT_FACTOR, Math.max(0, Math.min(100, reverbLowCut)) / 100);
    rampParam(rlc.frequency, lFreq, RAMP_TIME);
  }
  const rhc = getRvbHighCut();
  if (rhc) {
    const hFreqRaw =
      REVERB_HIGHCUT_BASE *
      Math.pow(REVERB_HIGHCUT_FACTOR, Math.max(0, Math.min(100, reverbHighCut)) / 100);
    const hFreq =
      reverbHighCut <= 0
        ? getFullRangeFrequency(rhc.context.sampleRate)
        : clampFilterFrequency(hFreqRaw, rhc.context.sampleRate);
    rampParam(rhc.frequency, hFreq, RAMP_TIME);
  }

  // EQ Sync
  const nodes = getEqNodes();
  if (nodes && nodes.length > 0 && eqValues) {
    nodes.forEach((node, i) => {
      if (!node?.gain) return;
      const raw = eqValues[i] ?? 0;
      const clamped = Math.max(-12, Math.min(12, raw));
      if (node.gain.value !== clamped) {
        rampParam(node.gain, clamped, RAMP_TIME);
      }
    });
  }

  // Stereo Width & Gain Compensation
  let compensation = 1.0;
  const wid = getWidener();
  if (wid) {
    wid.setWidth(stereoWidth * 0.5, RAMP_TIME);
    if (stereoWidth < 1.0) {
      compensation = STEREO_NARROW_BASE + STEREO_NARROW_SCALE * stereoWidth;
    } else if (stereoWidth > 1.0) {
      compensation = Math.max(
        STEREO_WIDE_FLOOR,
        1.0 / (STEREO_NARROW_BASE + STEREO_NARROW_SCALE * stereoWidth),
      );
    }
  }

  // Preamp
  const pre = getPreamp();
  if (pre) rampParam(pre.gain, userPreampGain * compensation, RAMP_TIME);

  // Virtual Bass
  const isWooferRole = channelMode === 2 || (isSurroundMode && surroundChannelIndex === 3);
  const vbg = getVbGain();
  if (vbg) {
    const targetGain = isWooferRole ? 0 : virtualBass;
    rampParam(vbg.gain, targetGain, RAMP_TIME);
  }

  // Harmonic Exciter (toggle-only)
  // Suppress on the woofer role — the saturator's harmonics live above
  // 6 kHz, which the woofer's lowpass would chop out anyway, and feeding
  // the WaveShaper for nothing just wastes CPU on the device that needs
  // the most headroom for the sub-bass band.
  const exg = getExciterGain();
  if (exg) {
    const targetExGain = !isWooferRole && exciterOn ? EXCITER_MIX_GAIN : 0;
    rampParam(exg.gain, targetExGain, RAMP_TIME);
  }

  // Global LowPass
  const lp = getGlobalLowPass();
  if (lp) {
    const fullRange = getFullRangeFrequency(lp.context.sampleRate);
    rampParam(lp.frequency, isWooferRole ? subFreq : fullRange, RAMP_TIME);
  }

  // Master Volume
  const mg = getMasterGain();
  if (mg) {
    const masterVolume = getState('audio.masterVolume');
    rampParam(mg.gain, masterVolume, RAMP_TIME);
  }

  // Reverb IR regeneration (SYNCHRONOUS — no async/retry needed!)
  const rev = getReverb();
  if (rev) {
    // Check if decay or preDelay actually changed by comparing with stored values
    const currentDecay = _lastReverbDecay;
    const currentPreDelay = _lastReverbPreDelay;
    if (currentDecay !== reverbDecay || currentPreDelay !== reverbPreDelay) {
      _lastReverbDecay = reverbDecay;
      _lastReverbPreDelay = reverbPreDelay;
      rev.buffer = generateReverbIR(reverbDecay, reverbPreDelay);
    }
  }
}

// Track last reverb params to avoid unnecessary IR regeneration
let _lastReverbDecay = REVERB_DEFAULT_DECAY;
let _lastReverbPreDelay = REVERB_DEFAULT_PREDELAY;

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
      setState('audio.reverbLowCut', Math.max(0, Math.min(100, v)));
      break;
    case 'highcut':
      setState('audio.reverbHighCut', Math.max(0, Math.min(100, v)));
      break;
  }

  if (!skipApply) applySettingsAsync();
}

function resetReverb(): void {
  setReverbParam('mix', 0, true);
  setReverbParam('decay', REVERB_DEFAULT_DECAY, true);
  setReverbParam('predelay', REVERB_DEFAULT_PREDELAY, true);
  setReverbParam('lowcut', 0, true);
  setReverbParam('highcut', 0, true);
  applySettingsAsync();
}

// ─── EQ Controls ───────────────────────────────────────────────────

export function setEQ(idx: number, val: number): void {
  const bandIdx = Math.floor(Number(idx));
  const bandVal = Number(val);
  if (!Number.isFinite(bandIdx) || !Number.isFinite(bandVal)) return;

  const eqValues = getState('audio.eqValues');
  if (!eqValues || bandIdx < 0 || bandIdx >= eqValues.length) return;

  const clamped = Math.max(-12, Math.min(12, bandVal));
  const newValues = [...eqValues];
  newValues[bandIdx] = clamped;
  setState('audio.eqValues', newValues);

  const eqNodes = getEqNodes();
  if (eqNodes?.[bandIdx]) {
    rampParam(eqNodes[bandIdx].gain, clamped, RAMP_TIME);
  }

  bus.emit('ui:sync-eq-band', bandIdx, clamped);
}

export function resetEQ(): void {
  const eqNodes = getEqNodes();
  const count = eqNodes ? eqNodes.length : 5;
  setState('audio.eqValues', Array(count).fill(0));
  setState('audio.userPreampGain', 1.0);
  eqNodes?.forEach((node) => rampParam(node.gain, 0, RAMP_TIME));
  applySettingsAsync();
}

// ─── Preamp ────────────────────────────────────────────────────────

export function setPreamp(valDb: number): void {
  const db = Math.max(-48, Math.min(12, Number(valDb)));
  if (!Number.isFinite(db)) return;
  const linear = Math.pow(10, db / 20);
  setState('audio.userPreampGain', linear);
  applySettingsAsync();
}

// ─── Stereo Width ──────────────────────────────────────────────────

export function setStereoWidth(val: number): void {
  const v = Number(val);
  if (!Number.isFinite(v)) return;
  setState('audio.stereoWidth', Math.max(0, Math.min(2, v / 100)));
  applySettingsAsync();
}

export function resetStereoWidth(): void {
  setStereoWidth(100);
}

// ─── Virtual Bass ──────────────────────────────────────────────────

export function setVirtualBass(val: number): void {
  const v = Number(val);
  if (!Number.isFinite(v)) return;
  setState('audio.virtualBass', Math.max(0, Math.min(1, v / 100)));
  applySettingsAsync();
}

export function resetVirtualBass(): void {
  setVirtualBass(0);
}

// ─── Harmonic Exciter ──────────────────────────────────────────────

export function setExciter(on: boolean): void {
  setState('audio.exciter', !!on);
  applySettingsAsync();
}

export function resetExciter(): void {
  setExciter(false);
}

// ─── Subwoofer Cutoff ──────────────────────────────────────────────

function updateSubFreq(val: number): void {
  const freq = Math.max(SUB_FREQ_MIN, Math.min(SUB_FREQ_MAX, Number(val)));
  if (!Number.isFinite(freq)) return;
  setState('audio.subFreq', freq);
  applySettingsAsync();
}

// ─── Network Broadcast Helpers ───────────────────────────────────

function _broadcastOrRequestSetting(msgType: string, value: number | string): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    broadcast({ type: msgType, value } as AnyProtocolMsg);
  } else {
    const canRequest = getState('network.isOperator') || getState('demo.active');
    if (canRequest && hostConn.open) {
      hostConn.send({ type: MSG.REQUEST_SETTING, settingType: msgType, value });
    } else if (!canRequest) {
      showToast(t('toast.operator_required'));
    } else {
      showToast(t('toast.connection_closing'));
    }
  }
}

function _broadcastOrRequestSettingEQ(band: number, value: number): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    broadcast({ type: MSG.EQ_UPDATE, band, value });
  } else {
    const canRequest = getState('network.isOperator') || getState('demo.active');
    if (canRequest && hostConn.open) {
      hostConn.send({ type: MSG.REQUEST_SETTING, settingType: 'eq', band, value });
    } else if (!canRequest) {
      showToast(t('toast.operator_required'));
    } else {
      showToast(t('toast.connection_closing'));
    }
  }
}

// ─── Bus Event Handlers ─────────────────────────────────────────

bus.on('audio:update-effect', (type, param, value, isPreview) => {
  if (!Number.isFinite(value)) return;

  switch (type) {
    case 'reverb':
      setReverbParam(param, value);
      if (!isPreview) {
        const REVERB_MSG_MAP: Record<string, string> = {
          mix: MSG.REVERB,
          decay: MSG.REVERB_DECAY,
          predelay: MSG.REVERB_PREDELAY,
          lowcut: MSG.REVERB_LOWCUT,
          highcut: MSG.REVERB_HIGHCUT,
        };
        const msgType = REVERB_MSG_MAP[param];
        if (msgType) _broadcastOrRequestSetting(msgType, value);
      }
      break;
    case 'stereo':
      if (param === 'mix') {
        setStereoWidth(value);
        if (!isPreview) _broadcastOrRequestSetting(MSG.STEREO_WIDTH, value);
      }
      break;
    case 'vbass':
      if (param === 'mix') {
        setVirtualBass(value);
        if (!isPreview) _broadcastOrRequestSetting(MSG.VBASS, value);
      }
      break;
    case 'exciter':
      // value: 0 (off) | 1 (on). Toggle-only, no mid-range like vbass.
      if (param === 'mix') {
        const on = value > 0;
        setExciter(on);
        if (!isPreview) _broadcastOrRequestSetting(MSG.EXCITER, on ? 1 : 0);
      }
      break;
    case 'cutoff':
      if (param === 'value') updateSubFreq(value);
      break;
    default:
      log.warn('[Effects] Unknown effect type:', type);
  }
});

bus.on('audio:set-eq', (band, value, isPreview) => {
  if (!Number.isFinite(band) || !Number.isFinite(value)) return;
  setEQ(band, value);
  if (!isPreview) {
    _broadcastOrRequestSettingEQ(band, value);
  }
});

bus.on('audio:reverb-type-change', (type: string) => {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    // Host: apply locally + broadcast
    applyReverbType(type);
    broadcast({ type: MSG.REVERB_TYPE, value: type } as AnyProtocolMsg);
  } else {
    // Guest: request Host to change
    _broadcastOrRequestSetting(MSG.REVERB_TYPE, type);
  }
});

bus.on('audio:reset-eq', () => {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    resetEQ();
    broadcast({ type: MSG.EQ_RESET });
  } else {
    const canRequest = getState('network.isOperator') || getState('demo.active');
    if (canRequest && hostConn.open) {
      hostConn.send({ type: MSG.REQUEST_EQ_RESET });
    }
  }
});

bus.on('audio:ready', () => {
  log.info('[Effects] Audio ready — applying default settings');
  applySettingsAsync();
});

bus.on('network:peer-connected', (conn) => {
  if (!conn?.open) return;
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  try {
    const masterVolume = getState('audio.masterVolume');
    conn.send({ type: MSG.VOLUME, value: masterVolume, _bootstrap: true });

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
    conn.send({
      type: MSG.PREAMP,
      value: Math.round(20 * Math.log10(Math.max(userPreampGain, 1e-6))),
    });

    const stereoWidth = getState('audio.stereoWidth');
    conn.send({ type: MSG.STEREO_WIDTH, value: stereoWidth * 100 });

    const virtualBass = getState('audio.virtualBass');
    conn.send({ type: MSG.VBASS, value: virtualBass * 100 });

    const exciterOn = getState('audio.exciter');
    conn.send({ type: MSG.EXCITER, value: exciterOn ? 1 : 0 });

    log.debug('[Effects] Bootstrap: sent audio settings to new peer');
  } catch (e) {
    log.warn('[Effects] Bootstrap send failed:', e);
  }
});

// ─── Network Protocol Handlers ──────────────────────────────────

/**
 * Reject broadcast frames not arriving via hostConn. Effects messages flow
 * host→guest only — host triggers them through UI bus events / setState
 * (player-controls.ts:138, settings.ts handlers, etc.) and broadcasts to
 * guests; the host's own dispatcher never receives them on the legitimate
 * path. A raw frame at host means a malicious guest sent it directly to
 * mutate host's audio state. A raw frame at a guest from any conn other
 * than hostConn means a peer is spoofing host broadcasts.
 */
function isHostBroadcast(conn: DataConnection | undefined): boolean {
  const hostConn = getState('network.hostConn');
  return !!hostConn && conn === hostConn;
}

function handleVolume(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined || data.value === null) return;
  const vol = Math.max(0, Math.min(1, Number(data.value)));
  if (!Number.isFinite(vol)) return;
  bus.emit('audio:set-volume', vol);
  if (!data._bootstrap) {
    showToast(t('common.volume_percent', { val: Math.round(vol * 100) }));
  }
}

function handleEQUpdateMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.band === undefined || data.value === undefined) return;
  const band = Number(data.band);
  const value = Number(data.value);
  if (!Number.isFinite(band) || !Number.isFinite(value)) return;
  setEQ(band, value);
  _notifyHostChanged();
}

function handlePreampMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setPreamp(v);
  _notifyHostChanged();
}

function _notifyHostChanged(): void {
  if (!getState('network.hostConn')) return;
  setManagedTimer(
    'host-change-toast',
    () => {
      showToast(t('toast.host_changed_setting'));
    },
    300,
  );
}

function handleEQResetMsg(_data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  resetEQ();
  bus.emit('ui:sync-eq-preset', 'off');
  _notifyHostChanged();
}

function handleReverbMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('mix', v);
  bus.emit('ui:sync-reverb-param', 'mix', v);
  _notifyHostChanged();
}

// Trusted local-apply path for reverb preset selection. Called by both the
// network handler (after the isHostBroadcast auth guard) and the host's own
// `audio:reverb-type-change` bus listener at L362, which fires from host UI
// clicks (settings.ts:559,562) and from REQUEST_SETTING forwarded by an OP
// guest (playlist.ts:964). Extracting this avoids routing the host's own
// trusted action through the network handler — that path is now gated by
// isHostBroadcast(conn) which always returns false on host (hostConn=null),
// so calling handleReverbTypeMsg locally would silently no-op.
function applyReverbType(type: string): void {
  switch (type) {
    case 'off':
      resetReverb();
      bus.emit('ui:sync-reverb-preset', 'off');
      _notifyHostChanged();
      return;
    case 'studio': {
      const p = REVERB_PRESETS.studio;
      setState('audio.reverbMix', p.mix);
      setState('audio.reverbDecay', p.decay);
      setState('audio.reverbPreDelay', p.preDelay);
      setState('audio.reverbLowCut', p.lowCut);
      setState('audio.reverbHighCut', p.highCut);
      break;
    }
    case 'arena': {
      const p = REVERB_PRESETS.arena;
      setState('audio.reverbMix', p.mix);
      setState('audio.reverbDecay', p.decay);
      setState('audio.reverbPreDelay', p.preDelay);
      setState('audio.reverbLowCut', p.lowCut);
      setState('audio.reverbHighCut', p.highCut);
      break;
    }
    default:
      return;
  }
  applySettingsAsync();
  bus.emit('ui:sync-reverb-preset', type);
  _notifyHostChanged();
}

function handleReverbTypeMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value == null) return;
  applyReverbType(String(data.value));
}

function handleReverbDecayMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('decay', v);
  bus.emit('ui:sync-reverb-param', 'decay', v);
  _notifyHostChanged();
}

function handleReverbPreDelayMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('predelay', v);
  bus.emit('ui:sync-reverb-param', 'predelay', v);
  _notifyHostChanged();
}

function handleReverbLowCutMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('lowcut', v);
  bus.emit('ui:sync-reverb-param', 'lowcut', v);
  _notifyHostChanged();
}

function handleReverbHighCutMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('highcut', v);
  bus.emit('ui:sync-reverb-param', 'highcut', v);
  _notifyHostChanged();
}

function handleStereoWidthMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setStereoWidth(v);
  bus.emit('ui:sync-surround', v > 100);
  _notifyHostChanged();
}

function handleVBassMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setVirtualBass(v);
  bus.emit('ui:sync-vbass', v > 0);
  _notifyHostChanged();
}

function handleExciterMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  // Strict 0/1 — anything else is malformed. Mirrors protocol.ts validator.
  if (v !== 0 && v !== 1) return;
  const on = v === 1;
  setExciter(on);
  bus.emit('ui:sync-exciter', on);
  _notifyHostChanged();
}

function handleRequestEQReset(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

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
    [MSG.EXCITER]: handleExciterMsg,
    [MSG.REQUEST_EQ_RESET]: handleRequestEQReset,
  });

  log.info('[Effects] Protocol handlers registered');
}

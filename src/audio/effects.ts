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
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import {
  createDefaultRoomEffectsState,
  parseRoomEffectsState,
  type RoomEffectsState,
} from '../core/room-effects.ts';
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
import { hasRoomCapability } from '../rooms/authority.ts';
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

/** Apply settings without exposing a rejected promise to synchronous callers. */
export function applySettingsAsync(deferReverbImpulse = false): void {
  applySettings(deferReverbImpulse).catch((e) => log.warn('[Effects] applySettings failed:', e));
}

export async function applySettings(deferReverbImpulse = false): Promise<void> {
  if (!getMasterGain()) return;

  const reverbMix = getState('audio.reverbMix');
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

  // Decay/pre-delay previews arrive at pointer-event cadence. Mix, damping,
  // EQ, and every other cheap AudioParam above still apply immediately, while
  // the expensive impulse rebuild is coalesced. The slider's final `change`
  // event calls the non-deferred path and commits the exact final value.
  if (deferReverbImpulse) scheduleReverbImpulseRefresh();
  else {
    clearManagedTimer(REVERB_IR_REFRESH_TIMER);
    refreshReverbImpulse();
  }
}

// Track last reverb params to avoid unnecessary IR regeneration
let _lastReverbDecay = REVERB_DEFAULT_DECAY;
let _lastReverbPreDelay = REVERB_DEFAULT_PREDELAY;
let _lastReverbNode: ConvolverNode | null = null;
const REVERB_IR_REFRESH_TIMER = 'audio-reverb-ir-refresh';
const REVERB_IR_COALESCE_MS = 140;

function refreshReverbImpulse(): void {
  const rev = getReverb();
  if (!rev) return;
  const decay = getState('audio.reverbDecay');
  const preDelay = getState('audio.reverbPreDelay');
  const graphChanged = _lastReverbNode !== rev;
  _lastReverbNode = rev;
  // Engine initialization already installs the default impulse. Remember the
  // new graph without generating that same multi-megabyte buffer twice.
  if (graphChanged && decay === REVERB_DEFAULT_DECAY && preDelay === REVERB_DEFAULT_PREDELAY) {
    _lastReverbDecay = decay;
    _lastReverbPreDelay = preDelay;
    return;
  }
  if (!graphChanged && _lastReverbDecay === decay && _lastReverbPreDelay === preDelay) return;
  _lastReverbDecay = decay;
  _lastReverbPreDelay = preDelay;
  rev.buffer = generateReverbIR(decay, preDelay);
}

function scheduleReverbImpulseRefresh(): void {
  setManagedTimer(REVERB_IR_REFRESH_TIMER, refreshReverbImpulse, REVERB_IR_COALESCE_MS);
}

// ─── Reverb Controls ───────────────────────────────────────────────

export function setReverbParam(
  param: string,
  val: number,
  skipApply = false,
  deferReverbImpulse = false,
): void {
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

  if (!skipApply) applySettingsAsync(deferReverbImpulse);
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

function detectRoomReverbPreset(state: RoomEffectsState['reverb']): string {
  if (state.mixPercent === 0 && state.lowCutPercent === 0 && state.highCutPercent === 0) {
    return 'off';
  }
  const near = (left: number, right: number) => Math.abs(left - right) < 0.01;
  for (const [name, preset] of Object.entries(REVERB_PRESETS)) {
    if (
      near(state.mixPercent, preset.mix * 100) &&
      near(state.decaySeconds, preset.decay) &&
      near(state.preDelaySeconds, preset.preDelay) &&
      near(state.lowCutPercent, preset.lowCut) &&
      near(state.highCutPercent, preset.highCut)
    ) {
      return name;
    }
  }
  return 'advanced';
}

function detectRoomEqPreset(bands: readonly number[]): string {
  if (bands.every((band) => band === 0)) return 'off';
  const presets: Record<string, readonly number[]> = {
    bright: [0, -2, 0, 4, 6],
    warm: [5, 3, 0, -2, -3],
  };
  for (const [name, preset] of Object.entries(presets)) {
    if (preset.every((band, index) => band === bands[index])) return name;
  }
  return 'advanced';
}

/** Capture only room-wide DSP values. Device-local routing and sync stay out. */
export function captureRoomEffectsState(): RoomEffectsState {
  const candidate = {
    reverb: {
      mixPercent: getState('audio.reverbMix') * 100,
      decaySeconds: getState('audio.reverbDecay'),
      preDelaySeconds: getState('audio.reverbPreDelay'),
      lowCutPercent: getState('audio.reverbLowCut'),
      highCutPercent: getState('audio.reverbHighCut'),
    },
    equalizer: { bandsDb: [...getState('audio.eqValues')] },
    virtualBass: { strengthPercent: getState('audio.virtualBass') * 100 },
    virtualSurround: { widthPercent: getState('audio.stereoWidth') * 100 },
  };
  return parseRoomEffectsState(candidate) ?? createDefaultRoomEffectsState();
}

function broadcastRoomEffectsState(state: RoomEffectsState): void {
  broadcast({ type: MSG.REVERB, value: state.reverb.mixPercent } as AnyProtocolMsg);
  broadcast({ type: MSG.REVERB_DECAY, value: state.reverb.decaySeconds } as AnyProtocolMsg);
  broadcast({ type: MSG.REVERB_PREDELAY, value: state.reverb.preDelaySeconds } as AnyProtocolMsg);
  broadcast({ type: MSG.REVERB_LOWCUT, value: state.reverb.lowCutPercent } as AnyProtocolMsg);
  broadcast({ type: MSG.REVERB_HIGHCUT, value: state.reverb.highCutPercent } as AnyProtocolMsg);
  state.equalizer.bandsDb.forEach((value, band) => {
    broadcast({ type: MSG.EQ_UPDATE, band, value });
  });
  broadcast({
    type: MSG.STEREO_WIDTH,
    value: state.virtualSurround.widthPercent,
  } as AnyProtocolMsg);
  broadcast({ type: MSG.VBASS, value: state.virtualBass.strengthPercent } as AnyProtocolMsg);
}

/**
 * Re-baseline the room-wide DSP graph and settings UI without a change toast.
 * Persisted PRO state and Developer API commands both use this exact path.
 */
export function applyRoomEffectsState(
  value: RoomEffectsState,
  options: { broadcast?: boolean } = {},
): boolean {
  const state = parseRoomEffectsState(value);
  if (!state) return false;

  setState('audio.reverbMix', state.reverb.mixPercent / 100);
  setState('audio.reverbDecay', state.reverb.decaySeconds);
  setState('audio.reverbPreDelay', state.reverb.preDelaySeconds);
  setState('audio.reverbLowCut', state.reverb.lowCutPercent);
  setState('audio.reverbHighCut', state.reverb.highCutPercent);
  setState('audio.eqValues', [...state.equalizer.bandsDb]);
  setState('audio.stereoWidth', state.virtualSurround.widthPercent / 100);
  setState('audio.virtualBass', state.virtualBass.strengthPercent / 100);
  applySettingsAsync();

  bus.emit('ui:sync-reverb-param', 'mix', state.reverb.mixPercent);
  bus.emit('ui:sync-reverb-param', 'decay', state.reverb.decaySeconds);
  bus.emit('ui:sync-reverb-param', 'predelay', state.reverb.preDelaySeconds);
  bus.emit('ui:sync-reverb-param', 'lowcut', state.reverb.lowCutPercent);
  bus.emit('ui:sync-reverb-param', 'highcut', state.reverb.highCutPercent);
  bus.emit('ui:sync-reverb-preset', detectRoomReverbPreset(state.reverb));
  state.equalizer.bandsDb.forEach((band, index) => bus.emit('ui:sync-eq-band', index, band));
  bus.emit('ui:sync-eq-preset', detectRoomEqPreset(state.equalizer.bandsDb));
  bus.emit('ui:sync-surround', state.virtualSurround.widthPercent > 100);
  bus.emit('ui:sync-vbass', state.virtualBass.strengthPercent > 0);

  if (options.broadcast) broadcastRoomEffectsState(state);
  return true;
}

// ─── Harmonic Exciter ──────────────────────────────────────────────

export function setExciter(on: boolean): void {
  setState('audio.exciter', !!on);
  applySettingsAsync();
}

// ─── Subwoofer Cutoff ──────────────────────────────────────────────

function updateSubFreq(val: number): void {
  const freq = Math.max(SUB_FREQ_MIN, Math.min(SUB_FREQ_MAX, Number(val)));
  if (!Number.isFinite(freq)) return;
  setState('audio.subFreq', freq);
  applySettingsAsync();
}

// ─── Network Broadcast Helpers ───────────────────────────────────

function canControlRoomEffects(): boolean {
  return (
    getState('demo.active') ||
    !getState('setup.sessionStarted') ||
    hasRoomCapability('effects.control')
  );
}

function rejectRoomEffectsControl(): void {
  showToast(t('toast.operator_required'));
}

function _broadcastOrRequestSetting(msgType: string, value: number | string): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    broadcast({ type: msgType, value } as AnyProtocolMsg);
  } else {
    const canRequest = canControlRoomEffects();
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
    const canRequest = canControlRoomEffects();
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
  if (!canControlRoomEffects()) {
    if (!isPreview) rejectRoomEffectsControl();
    return;
  }

  switch (type) {
    case 'reverb': {
      const deferImpulse = !!isPreview && (param === 'decay' || param === 'predelay');
      setReverbParam(param, value, false, deferImpulse);
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
    }
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
  if (!canControlRoomEffects()) {
    if (!isPreview) rejectRoomEffectsControl();
    return;
  }
  setEQ(band, value);
  if (!isPreview) {
    _broadcastOrRequestSettingEQ(band, value);
  }
});

bus.on('audio:reverb-type-change', (type: string) => {
  if (!canControlRoomEffects()) {
    rejectRoomEffectsControl();
    return;
  }
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
  if (!canControlRoomEffects()) {
    rejectRoomEffectsControl();
    return;
  }
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    resetEQ();
    broadcast({ type: MSG.EQ_RESET });
  } else {
    const canRequest = canControlRoomEffects();
    if (canRequest && hostConn.open) {
      hostConn.send({ type: MSG.REQUEST_EQ_RESET });
    }
  }
});

bus.on('audio:ready', () => {
  log.info('[Effects] Audio ready — applying default settings');
  applySettingsAsync();
});

/**
 * Send the full effect-settings snapshot to one peer. `_bootstrap: true` on
 * every frame suppresses the receiver's "host changed a setting" toast —
 * a snapshot is a re-baseline, not a change.
 *
 * `includeVolume` is true only for the join bootstrap. Guest volume is local
 * after joining, so a mid-session resync must not overwrite it.
 */
function sendEffectsSnapshot(conn: DataConnection, includeVolume: boolean): void {
  try {
    if (includeVolume) {
      const masterVolume = getState('audio.masterVolume');
      conn.send({ type: MSG.VOLUME, value: masterVolume, _bootstrap: true });
    }

    const reverbMix = getState('audio.reverbMix');
    conn.send({ type: MSG.REVERB, value: reverbMix * 100, _bootstrap: true });

    const reverbDecay = getState('audio.reverbDecay');
    conn.send({ type: MSG.REVERB_DECAY, value: reverbDecay, _bootstrap: true });

    const reverbPreDelay = getState('audio.reverbPreDelay');
    conn.send({ type: MSG.REVERB_PREDELAY, value: reverbPreDelay, _bootstrap: true });

    const reverbLowCut = getState('audio.reverbLowCut');
    conn.send({ type: MSG.REVERB_LOWCUT, value: reverbLowCut, _bootstrap: true });

    const reverbHighCut = getState('audio.reverbHighCut');
    conn.send({ type: MSG.REVERB_HIGHCUT, value: reverbHighCut, _bootstrap: true });

    const eqValues = getState('audio.eqValues');
    if (eqValues) {
      eqValues.forEach((val, i) => {
        conn.send({ type: MSG.EQ_UPDATE, band: i, value: val, _bootstrap: true });
      });
    }

    const userPreampGain = getState('audio.userPreampGain');
    conn.send({
      type: MSG.PREAMP,
      value: Math.round(20 * Math.log10(Math.max(userPreampGain, 1e-6))),
      _bootstrap: true,
    });

    const stereoWidth = getState('audio.stereoWidth');
    conn.send({ type: MSG.STEREO_WIDTH, value: stereoWidth * 100, _bootstrap: true });

    const virtualBass = getState('audio.virtualBass');
    conn.send({ type: MSG.VBASS, value: virtualBass * 100, _bootstrap: true });

    const exciterOn = getState('audio.exciter');
    conn.send({ type: MSG.EXCITER, value: exciterOn ? 1 : 0, _bootstrap: true });

    log.debug('[Effects] Sent effect-settings snapshot to peer');
  } catch (e) {
    log.warn('[Effects] Snapshot send failed:', e);
  }
}

bus.on('network:peer-connected', (conn) => {
  if (!conn?.open) return;
  const hostConn = getState('network.hostConn');
  if (hostConn) return;
  sendEffectsSnapshot(conn, true);
});

// Re-baseline a demoted operator after any optimistic local changes that the
// host rejected during revocation. Volume remains guest-local.
bus.on('effects:resync-peer', (conn) => {
  if (getState('network.hostConn')) return; // host only
  if (!conn?.open) return;
  sendEffectsSnapshot(conn, false);
});

// ─── Network Protocol Handlers ──────────────────────────────────

/**
 * Reject broadcast frames not arriving via hostConn. Effects messages flow
 * host→guest only. A raw frame received by the host, or by a guest from any
 * connection other than `hostConn`, is not an authorized broadcast.
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
  _notifyHostChanged(data);
}

function handlePreampMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setPreamp(v);
  _notifyHostChanged(data);
}

function _notifyHostChanged(data?: Record<string, unknown>): void {
  if (!getState('network.hostConn')) return;
  // Snapshot frames (join bootstrap / revoke resync) are re-baselines, not
  // host actions — no toast. Mirrors handleVolume's _bootstrap handling.
  if (data?._bootstrap) return;
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
  _notifyHostChanged(data);
}

// Shared trusted apply path for host-local preset changes and authenticated
// host broadcasts. Keeping it separate from the network handler avoids
// subjecting host-local actions to the guest-side broadcast guard.
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
  _notifyHostChanged(data);
}

function handleReverbPreDelayMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('predelay', v);
  bus.emit('ui:sync-reverb-param', 'predelay', v);
  _notifyHostChanged(data);
}

function handleReverbLowCutMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('lowcut', v);
  bus.emit('ui:sync-reverb-param', 'lowcut', v);
  _notifyHostChanged(data);
}

function handleReverbHighCutMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('highcut', v);
  bus.emit('ui:sync-reverb-param', 'highcut', v);
  _notifyHostChanged(data);
}

function handleStereoWidthMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setStereoWidth(v);
  bus.emit('ui:sync-surround', v > 100);
  _notifyHostChanged(data);
}

function handleVBassMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setVirtualBass(v);
  bus.emit('ui:sync-vbass', v > 0);
  _notifyHostChanged(data);
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
  _notifyHostChanged(data);
}

function handleRequestEQReset(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data, 'effects.control')) {
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

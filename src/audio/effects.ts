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
import type { DataConnection, AnyProtocolMsg, RoomSettingsSyncState } from '../types/index.ts';
import {
  applyMasterVolume,
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
import { showRoomCapabilityRequired } from '../rooms/permission-feedback.ts';
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
  applyMasterVolume(RAMP_TIME);

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
  const count = eqNodes?.length ? eqNodes.length : 5;
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
    virtualTreble: { enabled: getState('audio.exciter') },
  };
  return parseRoomEffectsState(candidate) ?? createDefaultRoomEffectsState();
}

const SETTINGS_SYNC_STORAGE_KEY = 'musixquare-settings-sync';

interface SettingsAuthorityCache {
  roomKey: string;
  epoch: number;
  sequence: number;
  settings: RoomSettingsSyncState;
}

let settingsAuthorityCache: SettingsAuthorityCache | null = null;

interface PendingStandardSettingsPublish {
  roomKey: string;
  settings: RoomSettingsSyncState;
}

let pendingStandardSettingsPublish: PendingStandardSettingsPublish | null = null;
let pendingStandardSettingsRequestRoomKey: string | null = null;

/** @internal Focused protocol tests only. */
export function resetSettingsSyncAuthorityForTests(): void {
  settingsAuthorityCache = null;
  pendingStandardSettingsPublish = null;
  pendingStandardSettingsRequestRoomKey = null;
}

function currentSettingsRoomKey(): string {
  const context = getState('room.context');
  const roomId =
    context.roomId || getState('network.sessionCode') || getState('network.lastJoinCode') || 'idle';
  return `${context.kind}:${roomId}`;
}

function currentSettingsEpoch(): number {
  const epoch = getState('room.context').epoch;
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0;
}

function hasRetainedStandardSettingsAuthority(): boolean {
  if (
    getState('room.context').kind !== 'standard' ||
    getState('network.appRole') !== 'guest' ||
    !getState('network.isOperator')
  ) {
    return false;
  }
  return getState('network.standardRoomCapabilities')?.includes('effects.control') === true;
}

function hasPendingStandardSettingsIntent(): boolean {
  return (
    pendingStandardSettingsPublish?.roomKey === currentSettingsRoomKey() &&
    hasRetainedStandardSettingsAuthority()
  );
}

function rememberPendingStandardSettingsPublish(settings: RoomSettingsSyncState): void {
  pendingStandardSettingsPublish = {
    roomKey: currentSettingsRoomKey(),
    settings: parseSettingsSyncState(settings)!,
  };
}

function clearPendingStandardSettingsPublish(): void {
  pendingStandardSettingsPublish = null;
}

function rememberPendingStandardSettingsRequest(): void {
  pendingStandardSettingsRequestRoomKey = currentSettingsRoomKey();
}

function clearPendingStandardSettingsRequest(): void {
  pendingStandardSettingsRequestRoomKey = null;
}

function flushPendingStandardSettingsRequest(): boolean {
  if (!pendingStandardSettingsRequestRoomKey) return false;
  if (
    !isSettingsSyncEnabled() ||
    !getState('setup.sessionStarted') ||
    getState('room.context').kind !== 'standard' ||
    pendingStandardSettingsRequestRoomKey !== currentSettingsRoomKey()
  ) {
    clearPendingStandardSettingsRequest();
    return false;
  }
  const hostConn = getState('network.hostConn');
  if (!hostConn?.open || getState('network.isConnecting')) return false;
  try {
    hostConn.send({ type: MSG.REQUEST_SETTINGS_SYNC_SNAPSHOT, version: 1 });
    clearPendingStandardSettingsRequest();
    return true;
  } catch {
    return false;
  }
}

function flushPendingStandardSettingsPublish(): boolean {
  const pending = pendingStandardSettingsPublish;
  if (!pending) return false;
  if (
    !isSettingsSyncEnabled() ||
    !getState('setup.sessionStarted') ||
    getState('room.context').kind !== 'standard' ||
    pending.roomKey !== currentSettingsRoomKey()
  ) {
    clearPendingStandardSettingsPublish();
    return false;
  }
  const hostConn = getState('network.hostConn');
  if (
    !hostConn?.open ||
    getState('network.isConnecting') ||
    !getState('network.isOperator') ||
    getState('network.standardRoomCapabilities')?.includes('effects.control') !== true
  ) {
    return false;
  }
  try {
    hostConn.send({
      type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT,
      version: 1,
      settings: pending.settings,
    });
    clearPendingStandardSettingsPublish();
    return true;
  } catch {
    return false;
  }
}

function usesStandardSettingsSyncTransport(): boolean {
  return getState('room.context').kind === 'standard';
}

function parseSettingsSyncState(value: unknown): RoomSettingsSyncState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RoomSettingsSyncState>;
  const masterVolume = Number(candidate.masterVolume);
  const effects = parseRoomEffectsState(candidate.effects);
  if (!Number.isFinite(masterVolume) || masterVolume < 0 || masterVolume > 1 || !effects)
    return null;
  return { masterVolume, effects };
}

/** Capture the complete room-followed surface as one atomic payload. */
export function captureRoomSettingsSyncState(): RoomSettingsSyncState {
  return {
    masterVolume: Math.max(0, Math.min(1, getState('audio.masterVolume'))),
    effects: captureRoomEffectsState(),
  };
}

function ensureSettingsAuthorityCache(): SettingsAuthorityCache {
  const roomKey = currentSettingsRoomKey();
  const epoch = currentSettingsEpoch();
  if (!settingsAuthorityCache || settingsAuthorityCache.roomKey !== roomKey) {
    settingsAuthorityCache = {
      roomKey,
      epoch,
      // A follower has not accepted authority yet. The -1 sentinel lets the
      // coordinator's valid sequence 0 bootstrap outrank divergent local defaults.
      sequence: getState('network.hostConn') ? -1 : 0,
      settings: isSettingsSyncEnabled()
        ? captureRoomSettingsSyncState()
        : { masterVolume: 1, effects: createDefaultRoomEffectsState() },
    };
  } else if (settingsAuthorityCache.epoch !== epoch && !getState('network.hostConn')) {
    // A new coordinator epoch keeps the last accepted authority values but
    // starts a fresh sequence domain. This prevents stale previous-coordinator
    // packets from outranking the new relay.
    settingsAuthorityCache = {
      ...settingsAuthorityCache,
      epoch,
      sequence: 0,
    };
  }
  return settingsAuthorityCache;
}

function seedSettingsAuthorityForSession(): void {
  const isFollower = !!getState('network.hostConn');
  settingsAuthorityCache = {
    roomKey: currentSettingsRoomKey(),
    epoch: currentSettingsEpoch(),
    sequence: isFollower ? -1 : 0,
    settings: isSettingsSyncEnabled()
      ? captureRoomSettingsSyncState()
      : { masterVolume: 1, effects: createDefaultRoomEffectsState() },
  };
}

export function isSettingsSyncEnabled(): boolean {
  return getState('audio.settingsSyncEnabled');
}

/** Host in standard rooms; explicit effects controllers in PRO rooms. */
export function canPublishSynchronizedSettings(): boolean {
  if (!getState('setup.sessionStarted')) return false;
  const context = getState('room.context');
  if (context.kind === 'standard' && getState('network.appRole') === 'host') return true;
  return hasRoomCapability('effects.control');
}

/**
 * Followers with synchronization enabled cannot manufacture a competing
 * local volume. Controllers remain editable because their commit becomes the
 * newest canonical room snapshot.
 */
export function isSynchronizedVolumeLocked(): boolean {
  return (
    isSettingsSyncEnabled() && getState('setup.sessionStarted') && !canPublishSynchronizedSettings()
  );
}

function applySettingsSyncState(value: RoomSettingsSyncState): boolean {
  const settings = parseSettingsSyncState(value);
  if (!settings) return false;
  bus.emit('audio:set-volume', settings.masterVolume);
  // The audio engine normally commits this state in its event handler. Keep
  // the authority projection deterministic during early bootstrap/tests where
  // the engine listener is not mounted yet.
  if (getState('audio.masterVolume') !== settings.masterVolume) {
    setState('audio.masterVolume', settings.masterVolume);
  }
  return applyRoomEffectsState(settings.effects, { broadcast: false });
}

/**
 * Merge the PRO service's canonical DSP state into the local authority cache.
 * OFF devices retain it for a future opt-in without changing their audio.
 */
export function acceptCanonicalRoomSettings(
  effectsValue: RoomEffectsState,
  masterVolumeValue?: number,
): boolean {
  const effects = parseRoomEffectsState(effectsValue);
  const masterVolume = masterVolumeValue === undefined ? undefined : Number(masterVolumeValue);
  if (
    !effects ||
    (masterVolume !== undefined &&
      (!Number.isFinite(masterVolume) || masterVolume < 0 || masterVolume > 1))
  ) {
    return false;
  }
  const cached = ensureSettingsAuthorityCache();
  const settings = {
    effects,
    masterVolume: masterVolume ?? cached.settings.masterVolume,
  };
  settingsAuthorityCache = {
    ...cached,
    settings,
  };
  return !isSettingsSyncEnabled() || applySettingsSyncState(settings);
}

function sendAuthoritySnapshot(conn: DataConnection, bootstrap = false): void {
  if (!conn?.open) return;
  const cached = ensureSettingsAuthorityCache();
  conn.send({
    type: MSG.SETTINGS_SYNC_SNAPSHOT,
    version: 1,
    epoch: cached.epoch,
    sequence: cached.sequence,
    settings: cached.settings,
    ...(bootstrap ? { _bootstrap: true as const } : {}),
  });
  sendLegacySettingsSnapshot(conn, cached.settings);
}

function legacySettingsSnapshotFrames(settings: RoomSettingsSyncState): Record<string, unknown>[] {
  return [
    { type: MSG.VOLUME, value: settings.masterVolume, _bootstrap: true },
    { type: MSG.REVERB, value: settings.effects.reverb.mixPercent, _bootstrap: true },
    {
      type: MSG.REVERB_DECAY,
      value: settings.effects.reverb.decaySeconds,
      _bootstrap: true,
    },
    {
      type: MSG.REVERB_PREDELAY,
      value: settings.effects.reverb.preDelaySeconds,
      _bootstrap: true,
    },
    {
      type: MSG.REVERB_LOWCUT,
      value: settings.effects.reverb.lowCutPercent,
      _bootstrap: true,
    },
    {
      type: MSG.REVERB_HIGHCUT,
      value: settings.effects.reverb.highCutPercent,
      _bootstrap: true,
    },
    ...settings.effects.equalizer.bandsDb.map((value, band) => ({
      type: MSG.EQ_UPDATE,
      band,
      value,
      _bootstrap: true,
    })),
    {
      type: MSG.STEREO_WIDTH,
      value: settings.effects.virtualSurround.widthPercent,
      _bootstrap: true,
    },
    {
      type: MSG.VBASS,
      value: settings.effects.virtualBass.strengthPercent,
      _bootstrap: true,
    },
    {
      type: MSG.EXCITER,
      value: settings.effects.virtualTreble.enabled ? 1 : 0,
      _bootstrap: true,
    },
  ];
}

function sendLegacySettingsSnapshot(conn: DataConnection, settings: RoomSettingsSyncState): void {
  for (const frame of legacySettingsSnapshotFrames(settings)) conn.send(frame);
}

function broadcastLegacySettingsSnapshot(settings: RoomSettingsSyncState): void {
  for (const frame of legacySettingsSnapshotFrames(settings)) {
    broadcast(frame as AnyProtocolMsg);
  }
}

function commitCoordinatorSettingsAuthority(
  settingsValue: RoomSettingsSyncState,
  applyLocally: boolean,
): boolean {
  const settings = parseSettingsSyncState(settingsValue);
  if (!settings) return false;
  const cached = ensureSettingsAuthorityCache();
  const epoch = currentSettingsEpoch();
  const sequence = cached.epoch === epoch ? cached.sequence + 1 : 1;
  if (!Number.isSafeInteger(sequence)) return false;
  settingsAuthorityCache = {
    roomKey: currentSettingsRoomKey(),
    epoch,
    sequence,
    settings,
  };
  if (applyLocally && !applySettingsSyncState(settings)) return false;
  broadcast({
    type: MSG.SETTINGS_SYNC_SNAPSHOT,
    version: 1,
    epoch,
    sequence,
    settings,
  });
  broadcastLegacySettingsSnapshot(settings);
  return true;
}

/** Publish this controller's complete local state, never a partial update. */
function publishLocalSettingsAuthority(): boolean {
  if (!isSettingsSyncEnabled()) return false;
  // PRO rooms use the Durable Object settings-sync resource exclusively.
  // The runtime observes this same local mutation and performs the CAS PUT.
  if (!usesStandardSettingsSyncTransport()) return canPublishSynchronizedSettings();
  // An explicit local publish always supersedes a snapshot retained while the
  // host connection was closed. RTC can become open before peer-connected and
  // the definitive authority projection arrive; flushing first in that window
  // would send the older takeover and silently lose this newest UI edit.
  if (pendingStandardSettingsPublish && hasRetainedStandardSettingsAuthority()) {
    rememberPendingStandardSettingsPublish(captureRoomSettingsSyncState());
  }
  if (getState('network.hostConn') && getState('network.isConnecting')) {
    if (hasRetainedStandardSettingsAuthority()) {
      rememberPendingStandardSettingsPublish(captureRoomSettingsSyncState());
    }
    return false;
  }
  if (flushPendingStandardSettingsPublish()) return true;
  if (!canPublishSynchronizedSettings()) {
    if (hasRetainedStandardSettingsAuthority()) {
      rememberPendingStandardSettingsPublish(captureRoomSettingsSyncState());
    }
    return false;
  }
  const settings = captureRoomSettingsSyncState();
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    if (!hostConn.open) {
      rememberPendingStandardSettingsPublish(settings);
      return false;
    }
    try {
      hostConn.send({ type: MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT, version: 1, settings });
      clearPendingStandardSettingsPublish();
      return true;
    } catch {
      // `open` can remain true while the data channel is already closing.
      // Preserve the exact latest takeover for the replacement connection.
      rememberPendingStandardSettingsPublish(settings);
      return false;
    }
  }
  return commitCoordinatorSettingsAuthority(settings, false);
}

function requestCanonicalSettingsAuthority(): void {
  // PRO followers refresh through the server invalidation/runtime path.
  if (!usesStandardSettingsSyncTransport()) return;
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    rememberPendingStandardSettingsRequest();
    if (flushPendingStandardSettingsRequest()) return;
    // Re-apply the last accepted baseline while the replacement channel is
    // pending so an OFF follower's divergent local values do not remain live.
    applySettingsSyncState(ensureSettingsAuthorityCache().settings);
    return;
  }
  // A non-controller coordinator has no upstream relay. Rejoin the last
  // canonical values it retained while OFF without publishing local state.
  clearPendingStandardSettingsRequest();
  const cached = ensureSettingsAuthorityCache();
  applySettingsSyncState(cached.settings);
}

/** Persist and activate the per-device opt-in. Default is ON. */
export function setSettingsSyncEnabled(enabled: boolean): void {
  const normalized = !!enabled;
  const changed = getState('audio.settingsSyncEnabled') !== normalized;
  // Freeze the last canonical value before OFF-local edits can diverge. This
  // also covers a host that disables sync before the first peer arrives.
  if (!normalized && changed && getState('setup.sessionStarted')) {
    ensureSettingsAuthorityCache();
  }
  setState('audio.settingsSyncEnabled', normalized);
  try {
    localStorage.setItem(SETTINGS_SYNC_STORAGE_KEY, normalized ? 'on' : 'off');
  } catch {
    // Private browsing can make localStorage unavailable; state still works.
  }
  bus.emit('settings-sync:changed', normalized);
  if (!normalized) {
    clearPendingStandardSettingsPublish();
    clearPendingStandardSettingsRequest();
    return;
  }
  if (!changed) return;
  if (canPublishSynchronizedSettings()) bus.emit('settings-sync:publish-local');
  else if (hasRetainedStandardSettingsAuthority()) {
    rememberPendingStandardSettingsPublish(captureRoomSettingsSyncState());
  } else requestCanonicalSettingsAuthority();
}

function handleSettingsSyncPublishLocal(): void {
  publishLocalSettingsAuthority();
}

function handleSetVirtualEffects(state: {
  bass: boolean;
  treble: boolean;
  surround: boolean;
}): void {
  if (
    !state ||
    typeof state.bass !== 'boolean' ||
    typeof state.treble !== 'boolean' ||
    typeof state.surround !== 'boolean'
  ) {
    return;
  }
  if (!canAdjustLocalRoomEffects()) {
    rejectSynchronizedRoomEffectsControl();
    return;
  }

  const nextWidth = state.surround ? 1.2 : 1;
  const nextBass = state.bass ? 0.6 : 0;
  const changed =
    getState('audio.stereoWidth') !== nextWidth ||
    getState('audio.virtualBass') !== nextBass ||
    getState('audio.exciter') !== state.treble;

  if (changed) {
    setState('audio.stereoWidth', nextWidth);
    setState('audio.virtualBass', nextBass);
    setState('audio.exciter', state.treble);
    applySettingsAsync();
  }

  bus.emit('ui:sync-surround', state.surround);
  bus.emit('ui:sync-vbass', state.bass);
  bus.emit('ui:sync-exciter', state.treble);
  if (changed && isSettingsSyncEnabled()) publishLocalSettingsAuthority();
}

function handleSettingsSyncSessionStarted(started: unknown): void {
  // The host can deliver its bootstrap before the setup success projection.
  // Never overwrite an already-accepted authority snapshot in that ordering.
  if (!started) {
    settingsAuthorityCache = null;
    clearPendingStandardSettingsPublish();
    clearPendingStandardSettingsRequest();
    return;
  }
  if (!settingsAuthorityCache) seedSettingsAuthorityForSession();
}

function handleSettingsSyncRoomContextChanged(): void {
  if (
    pendingStandardSettingsPublish &&
    pendingStandardSettingsPublish.roomKey !== currentSettingsRoomKey()
  ) {
    clearPendingStandardSettingsPublish();
  }
  if (
    pendingStandardSettingsRequestRoomKey &&
    pendingStandardSettingsRequestRoomKey !== currentSettingsRoomKey()
  ) {
    clearPendingStandardSettingsRequest();
  }
  if (
    getState('setup.sessionStarted') &&
    settingsAuthorityCache?.roomKey !== currentSettingsRoomKey()
  ) {
    seedSettingsAuthorityForSession();
  }
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
  broadcast({ type: MSG.EXCITER, value: state.virtualTreble.enabled ? 1 : 0 } as AnyProtocolMsg);
}

/**
 * Re-baseline the room-wide DSP graph and settings UI without a change toast.
 * Persisted PRO state and Developer API commands both use this exact path.
 */
function applyRoomEffectsState(
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
  setState('audio.exciter', state.virtualTreble.enabled);
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
  bus.emit('ui:sync-exciter', state.virtualTreble.enabled);

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

function canAdjustLocalRoomEffects(): boolean {
  return !isSettingsSyncEnabled() || canControlRoomEffects();
}

/** @internal Device-output controls never enter room settings authority. */
function isDeviceLocalEffectType(type: string): boolean {
  return type === 'cutoff';
}

/** Explain the sync-specific authority rule without implying owner-only access. */
function rejectSynchronizedRoomEffectsControl(): void {
  showRoomCapabilityRequired('effects.control');
}

function _broadcastOrRequestSetting(_msgType: string, _value: number | string): void {
  if (!isSettingsSyncEnabled()) return;
  if (!publishLocalSettingsAuthority() && canControlRoomEffects()) {
    const hostConn = getState('network.hostConn');
    if (hostConn && !hostConn.open) showToast(t('toast.connection_closing'));
  }
}

function _broadcastOrRequestSettingEQ(_band: number, _value: number): void {
  _broadcastOrRequestSetting('eq', 0);
}

// ─── Bus Event Handlers ─────────────────────────────────────────

bus.on('audio:update-effect', (type, param, value, isPreview) => {
  if (!Number.isFinite(value)) return;
  // Subwoofer cutoff belongs to the per-device output role. It never enters
  // the synchronized room DSP snapshot and must remain locally adjustable.
  if (!isDeviceLocalEffectType(type) && !canAdjustLocalRoomEffects()) {
    if (!isPreview) rejectSynchronizedRoomEffectsControl();
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
  if (!canAdjustLocalRoomEffects()) {
    if (!isPreview) rejectSynchronizedRoomEffectsControl();
    return;
  }
  setEQ(band, value);
  if (!isPreview) {
    _broadcastOrRequestSettingEQ(band, value);
  }
});

bus.on('audio:reverb-type-change', (type: string) => {
  if (!canAdjustLocalRoomEffects()) {
    rejectSynchronizedRoomEffectsControl();
    return;
  }
  applyReverbType(type, false);
  _broadcastOrRequestSetting(MSG.REVERB_TYPE, type);
});

bus.on('audio:reset-eq', () => {
  if (!canAdjustLocalRoomEffects()) {
    rejectSynchronizedRoomEffectsControl();
    return;
  }
  resetEQ();
  if (isSettingsSyncEnabled()) publishLocalSettingsAuthority();
});

bus.on('audio:ready', () => {
  log.info('[Effects] Audio ready: applying default settings');
  applySettingsAsync();
});

/**
 * Send the full effect-settings snapshot to one peer. `_bootstrap: true` on
 * every frame suppresses the receiver's "host changed a setting" toast —
 * a snapshot is a re-baseline, not a change.
 *
 * The atomic settings contract includes volume on both join and resync.
 */
function sendEffectsSnapshot(conn: DataConnection, includeVolume: boolean): void {
  try {
    // `includeVolume` is retained in the private signature while callers roll
    // together; the atomic contract always includes volume and every DSP value.
    void includeVolume;
    sendAuthoritySnapshot(conn, true);
    log.debug('[Effects] Sent synchronized settings snapshot to peer');
  } catch (e) {
    log.warn('[Effects] Snapshot send failed:', e);
  }
}

function handleSettingsSyncPeerConnected(conn: DataConnection): void {
  if (!usesStandardSettingsSyncTransport()) return;
  if (flushPendingStandardSettingsPublish()) return;
  if (flushPendingStandardSettingsRequest()) return;
  if (!conn?.open) return;
  const hostConn = getState('network.hostConn');
  if (hostConn) return;
  sendEffectsSnapshot(conn, true);
}

function handleSettingsSyncAuthorityProjectionChanged(): void {
  if (pendingStandardSettingsPublish) {
    const capabilities = getState('network.standardRoomCapabilities');
    if (
      getState('network.hostConn')?.open &&
      getState('network.isOperator') &&
      capabilities !== null &&
      !capabilities.includes('effects.control')
    ) {
      clearPendingStandardSettingsPublish();
    } else {
      flushPendingStandardSettingsPublish();
    }
  }
  flushPendingStandardSettingsRequest();
}

function handleSettingsSyncAuthorityRevoked(): void {
  clearPendingStandardSettingsPublish();
}

// Re-baseline a demoted operator after any optimistic local changes that the
// host rejected during revocation.
function handleSettingsSyncPeerResync(conn: DataConnection): void {
  if (!usesStandardSettingsSyncTransport()) return;
  if (getState('network.hostConn')) return; // host only
  if (!conn?.open) return;
  sendEffectsSnapshot(conn, false);
}

function registerSettingsSyncBusHandlers(): void {
  // EventBus stores stable callbacks in Sets, so this is safe both at module
  // load and from initEffectsHandlers after a test/application bus reset.
  bus.on('settings-sync:publish-local', handleSettingsSyncPublishLocal);
  bus.on('audio:set-virtual-effects', handleSetVirtualEffects);
  bus.on('state:setup.sessionStarted', handleSettingsSyncSessionStarted);
  bus.on('state:room.context', handleSettingsSyncRoomContextChanged);
  bus.on('network:peer-connected', handleSettingsSyncPeerConnected);
  bus.on('effects:resync-peer', handleSettingsSyncPeerResync);
  bus.on('state:network.hostConn', handleSettingsSyncAuthorityProjectionChanged);
  bus.on('state:network.standardRoomCapabilities', handleSettingsSyncAuthorityProjectionChanged);
  bus.on('state:network.isOperator', handleSettingsSyncAuthorityProjectionChanged);
  bus.on('settings-sync:authority-revoked', handleSettingsSyncAuthorityRevoked);
}

registerSettingsSyncBusHandlers();

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

function handleSettingsSyncSnapshot(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!usesStandardSettingsSyncTransport()) return;
  if (!isHostBroadcast(conn)) return;
  const epoch = Number(data.epoch);
  const sequence = Number(data.sequence);
  const settings = parseSettingsSyncState(data.settings);
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !settings
  ) {
    return;
  }
  const cached = ensureSettingsAuthorityCache();
  if (epoch < cached.epoch || (epoch === cached.epoch && sequence < cached.sequence)) return;
  if (
    epoch === cached.epoch &&
    sequence === cached.sequence &&
    JSON.stringify(settings) !== JSON.stringify(cached.settings)
  ) {
    log.warn('[Effects] Rejected conflicting equal-sequence settings snapshot');
    return;
  }
  settingsAuthorityCache = {
    roomKey: currentSettingsRoomKey(),
    epoch,
    sequence,
    settings,
  };
  if (pendingStandardSettingsRequestRoomKey === currentSettingsRoomKey()) {
    clearPendingStandardSettingsRequest();
  }
  // A disconnected administrator that explicitly opted back in owns a frozen
  // local takeover intent. Cache bootstrap authority for later, but do not
  // overwrite that local surface before it can be published on reconnect.
  if (hasPendingStandardSettingsIntent()) return;
  if (isSettingsSyncEnabled()) applySettingsSyncState(settings);
}

function handleRequestSettingsSyncSnapshot(
  _data: Record<string, unknown>,
  conn: DataConnection,
): void {
  if (!usesStandardSettingsSyncTransport()) return;
  if (getState('network.hostConn')) return;
  sendAuthoritySnapshot(conn, true);
}

function handlePublishSettingsSyncSnapshot(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  if (!usesStandardSettingsSyncTransport()) return;
  if (getState('network.hostConn')) return;
  if (!verifyOperator(conn, data, 'effects.control')) {
    log.warn(`[Effects] Rejected settings authority publish from non-controller: ${conn?.peer}`);
    return;
  }
  const settings = parseSettingsSyncState(data.settings);
  if (!settings) return;
  // A coordinator that opted out remains locally divergent while still
  // sequencing and relaying the newest authorized admin snapshot.
  commitCoordinatorSettingsAuthority(settings, isSettingsSyncEnabled());
}

function shouldApplyLegacySettingsFrame(conn?: DataConnection): boolean {
  return (
    usesStandardSettingsSyncTransport() &&
    isSettingsSyncEnabled() &&
    isHostBroadcast(conn) &&
    !hasPendingStandardSettingsIntent()
  );
}

function handleVolume(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
  if (data.value === undefined || data.value === null) return;
  const vol = Math.max(0, Math.min(1, Number(data.value)));
  if (!Number.isFinite(vol)) return;
  bus.emit('audio:set-volume', vol);
  if (!data._bootstrap) {
    showToast(t('common.volume_percent', { val: Math.round(vol * 100) }));
  }
}

function handleEQUpdateMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
  if (data.band === undefined || data.value === undefined) return;
  const band = Number(data.band);
  const value = Number(data.value);
  if (!Number.isFinite(band) || !Number.isFinite(value)) return;
  setEQ(band, value);
  _notifyHostChanged(data);
}

function handlePreampMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
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
  if (!shouldApplyLegacySettingsFrame(conn)) return;
  resetEQ();
  bus.emit('ui:sync-eq-preset', 'off');
  _notifyHostChanged();
}

function handleReverbMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
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
function applyReverbType(type: string, notify = true): void {
  switch (type) {
    case 'off':
      resetReverb();
      bus.emit('ui:sync-reverb-preset', 'off');
      if (notify) _notifyHostChanged();
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
  if (notify) _notifyHostChanged();
}

function handleReverbTypeMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
  if (data.value == null) return;
  applyReverbType(String(data.value), !data._bootstrap);
}

function handleReverbDecayMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('decay', v);
  bus.emit('ui:sync-reverb-param', 'decay', v);
  _notifyHostChanged(data);
}

function handleReverbPreDelayMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('predelay', v);
  bus.emit('ui:sync-reverb-param', 'predelay', v);
  _notifyHostChanged(data);
}

function handleReverbLowCutMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('lowcut', v);
  bus.emit('ui:sync-reverb-param', 'lowcut', v);
  _notifyHostChanged(data);
}

function handleReverbHighCutMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setReverbParam('highcut', v);
  bus.emit('ui:sync-reverb-param', 'highcut', v);
  _notifyHostChanged(data);
}

function handleStereoWidthMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setStereoWidth(v);
  bus.emit('ui:sync-surround', v > 100);
  _notifyHostChanged(data);
}

function handleVBassMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
  if (data.value === undefined) return;
  const v = Number(data.value);
  if (!Number.isFinite(v)) return;
  setVirtualBass(v);
  bus.emit('ui:sync-vbass', v > 0);
  _notifyHostChanged(data);
}

function handleExciterMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!shouldApplyLegacySettingsFrame(conn)) return;
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
  registerSettingsSyncBusHandlers();
  registerHandlers({
    [MSG.SETTINGS_SYNC_SNAPSHOT]: handleSettingsSyncSnapshot,
    [MSG.REQUEST_SETTINGS_SYNC_SNAPSHOT]: handleRequestSettingsSyncSnapshot,
    [MSG.PUBLISH_SETTINGS_SYNC_SNAPSHOT]: handlePublishSettingsSyncSnapshot,
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

/** @internal Focused audio/settings synchronization tests only. */
export {
  applyRoomEffectsState as applyRoomEffectsStateForTests,
  canAdjustLocalRoomEffects as canAdjustLocalRoomEffectsForTests,
  isDeviceLocalEffectType as isDeviceLocalEffectTypeForTests,
  publishLocalSettingsAuthority as publishLocalSettingsAuthorityForTests,
};

/**
 * MUSIXQUARE — Settings Panel (UI)
 *
 * Manages: Theme, channel mode selection, EQ/reverb/stereo/vbass sliders,
 * device list rendering.
 */

import { log } from '../core/log.ts';
import { bus, createBusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import {
  REVERB_DEFAULT_DECAY,
  REVERB_DEFAULT_PREDELAY,
  REVERB_HIGHCUT_BASE,
  REVERB_HIGHCUT_FACTOR,
  REVERB_LOWCUT_BASE,
  REVERB_LOWCUT_FACTOR,
  REVERB_PRESETS as AUDIO_REVERB_PRESETS,
} from '../audio/constants.ts';
import { isPlaybackModeSystemAudio } from '../player/ownership.ts';
import {
  getLanguageMode,
  getResolvedLanguage,
  getSupportedSystemLanguage,
  LANGUAGE_OPTIONS,
  setLanguageMode,
  t,
  type LanguageCode,
} from '../i18n/index.ts';
import { getStandardRolePreset } from './player-controls.ts';
import { syncRangeProgress } from './range-drag.ts';
import { showToast } from './toast.ts';
import { syncAppThemeChrome, syncDemoThemeChrome } from './theme-chrome.ts';
import { initCustomScrollbar } from './custom-scrollbar.ts';
import { syncOverlayState } from './dom.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import { isUiSoundsEnabled, playUiTouchSound, setUiSoundsEnabled } from '../audio/ui-sounds.ts';
import { applyUserTextFontFallback } from './user-text-font.ts';

// ─── Host-Ctrl Lock (Guest cannot change host-controlled settings) ──

const HOST_CTRL_LOCK_IDS = [
  'grid-reverb',
  'reverb-sliders-area',
  'grid-eq',
  'eq-sliders-area',
  'grid-surround',
  'grid-vbass',
  'grid-exciter',
] as const;

function _isGuestLocked(): boolean {
  if (getRoomContext().kind === 'pro') return !hasRoomCapability('room.configure');
  const hostConn = getState('network.hostConn');
  return !!hostConn && !hasRoomCapability('effects.control');
}

function _showHostCtrlLockedToast(): void {
  showToast(t('toast.host_only'));
}

function _guardHostCtrl(): boolean {
  if (_isGuestLocked()) {
    _showHostCtrlLockedToast();
    return true;
  }
  return false;
}

function _handleHostCtrlLockedAttempt(event: Event): void {
  if (!_isGuestLocked()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  _showHostCtrlLockedToast();
}

function _bindHostCtrlLockedAttemptToasts(): void {
  HOST_CTRL_LOCK_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.hostCtrlToastBound === '1') return;
    el.dataset.hostCtrlToastBound = '1';
    el.addEventListener('click', _handleHostCtrlLockedAttempt, { capture: true });
  });
}

function _updateHostCtrlLockUI(): void {
  const locked = _isGuestLocked();
  HOST_CTRL_LOCK_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle('host-ctrl-locked', locked);
      el.setAttribute('aria-disabled', locked ? 'true' : 'false');
      // Disable range inputs to prevent visual desync (slider moves but audio unchanged)
      el.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => {
        input.disabled = locked;
      });
    }
  });
}

function syncUiSoundsControls(enabled = isUiSoundsEnabled()): void {
  document.querySelectorAll<HTMLElement>('#grid-ui-sounds [data-ui-sounds]').forEach((button) => {
    const active = (button.dataset.uiSounds === 'on') === enabled;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

// ─── Theme ───────────────────────────────────────────────────────

export function setTheme(mode: string, save = true): void {
  const originalMode = mode;
  // Migrate legacy 'system' → resolve to actual value
  if (mode === 'system') {
    mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.querySelectorAll('#grid-theme .ch-opt').forEach((el) => el.classList.remove('active'));
  document.querySelector(`#grid-theme .ch-opt[data-theme="${mode}"]`)?.classList.add('active');

  document.documentElement.setAttribute('data-theme', mode);

  if (save) {
    try {
      localStorage.setItem('musixquare-theme', originalMode);
    } catch {
      /* ignore */
    }
  }

  // Update meta tags for PWA/browser integration.
  // Demo mode has a different visible bottom surface, so keep browser chrome
  // matched to that panel while the overlay is active.
  if (document.body.classList.contains('mode-demo')) syncDemoThemeChrome(mode);
  else syncAppThemeChrome(mode);
}

// ─── Channel Mode (Standard) ─────────────────────────────────────

function syncRoleDiagrams(mode: number): void {
  document
    .querySelectorAll<HTMLElement>('[data-role-diagram] .graphic-speaker[data-role-mode]')
    .forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.roleMode) === mode);
    });
}

export function selectStandardChannelButton(mode: number): void {
  const all = document.querySelectorAll('#grid-standard .ch-opt[data-ch]');
  all.forEach((e) => e.classList.remove('active'));
  const el = document.querySelector(`#grid-standard .ch-opt[data-ch="${mode}"]`);
  if (el) el.classList.add('active');
  syncRoleDiagrams(mode);

  const wooferCtrl = document.getElementById('woofer-cutoff-control');
  if (wooferCtrl) {
    if (mode === 2) {
      wooferCtrl.classList.remove('collapsed');
    } else {
      wooferCtrl.classList.add('collapsed');
    }
  }
}

function setChannel(mode: number): void {
  selectStandardChannelButton(mode);
  bus.emit('audio:set-channel-mode', mode);

  const preset = getStandardRolePreset(mode);
  showToast(t(preset.placementToastKey));
}

// ─── Value Display Helpers ────────────────────────────────────────

function _setDisp(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
}

function setRangeValue(slider: HTMLInputElement, value: number | string): void {
  slider.value = String(value);
  syncRangeProgress(slider);
}

function setRangeValueById(id: string, value: number | string): HTMLInputElement | null {
  const slider = document.getElementById(id) as HTMLInputElement | null;
  if (slider) setRangeValue(slider, value);
  return slider;
}

function formatReverbValDisp(param: string, v: number): void {
  switch (param) {
    case 'mix':
      _setDisp('val-reverb', v + '%');
      break;
    case 'decay':
      _setDisp('val-rvb-decay', parseFloat(v.toFixed(1)) + 's');
      break;
    case 'predelay':
      _setDisp('val-rvb-predelay', parseFloat(v.toFixed(2)) + 's');
      break;
    case 'lowcut': {
      const lFreq = REVERB_LOWCUT_BASE * Math.pow(REVERB_LOWCUT_FACTOR, v / 100);
      _setDisp(
        'val-rvb-lowcut',
        lFreq >= 1000 ? (lFreq / 1000).toFixed(1) + 'kHz' : Math.round(lFreq) + 'Hz',
      );
      break;
    }
    case 'highcut': {
      const hFreq = REVERB_HIGHCUT_BASE * Math.pow(REVERB_HIGHCUT_FACTOR, v / 100);
      _setDisp(
        'val-rvb-highcut',
        hFreq >= 1000 ? (hFreq / 1000).toFixed(1) + 'kHz' : Math.round(hFreq) + 'Hz',
      );
      break;
    }
  }
}

// ─── Audio Effects Helpers ────────────────────────────────────────

/**
 * During system-audio sharing the host's effect chain is only heard by the
 * guests (the host still hears raw system audio). Nudge the host with a
 * toast the first time they commit a change after a short cooldown.
 *
 * Returns `true` when the host is in sharing mode — callers that would
 * normally show a generic warning (e.g. distortion_warn) can use this to
 * skip theirs and avoid stacking.
 */
const _GUEST_ONLY_TOAST_COOLDOWN_MS = 5000;
let _guestOnlyToastLastAt = 0;
function _notifyGuestOnlyEffects(): boolean {
  if (getState('network.hostConn')) return false; // this client is a guest
  if (!isPlaybackModeSystemAudio()) return false;
  const now = Date.now();
  if (now - _guestOnlyToastLastAt > _GUEST_ONLY_TOAST_COOLDOWN_MS) {
    _guestOnlyToastLastAt = now;
    showToast(t('system_audio.effects_guest_only'));
  }
  return true;
}

function updateAudioEffect(type: string, param: string, value: number, isPreview = false): void {
  if (type === 'reverb') formatReverbValDisp(param, value);
  else if (type === 'cutoff') _setDisp('val-cutoff', value + ' Hz');

  bus.emit('audio:update-effect', type, param, value, isPreview);
  if (!isPreview && type !== 'cutoff') _notifyGuestOnlyEffects();
}

function setEQ(band: number, value: number, isPreview = false): void {
  _setDisp(`eq-val-${band}`, value > 0 ? `+${value}` : String(value));
  bus.emit('audio:set-eq', band, value, isPreview);
  if (!isPreview) _notifyGuestOnlyEffects();
}

// ─── Reverb Preset Chips ───────────────────────────────────────

interface ReverbUiPreset {
  mix: number;
  decay: number;
  predelay: number;
  lowcut: number;
  highcut: number;
}

const REVERB_DEFAULTS: ReverbUiPreset = {
  mix: 0,
  decay: REVERB_DEFAULT_DECAY,
  predelay: REVERB_DEFAULT_PREDELAY,
  lowcut: 0,
  highcut: 0,
};

const REVERB_PRESETS = Object.fromEntries(
  Object.entries(AUDIO_REVERB_PRESETS).map(([name, preset]) => [
    name,
    {
      mix: preset.mix * 100,
      decay: preset.decay,
      predelay: preset.preDelay,
      lowcut: preset.lowCut,
      highcut: preset.highCut,
    },
  ]),
) as Record<string, ReverbUiPreset>;

function clearReverbChipActive(): void {
  document.querySelectorAll('#grid-reverb .ch-opt').forEach((el) => el.classList.remove('active'));
}

/**
 * Read current slider values and detect which preset (if any) matches.
 * Returns 'off', 'studio', 'arena', or 'advanced'.
 */
function detectReverbPreset(): string {
  const mix = Number(
    (document.getElementById('reverb-slider') as HTMLInputElement | null)?.value ??
      REVERB_DEFAULTS.mix,
  );
  const decay = Number(
    (document.getElementById('reverb-decay-slider') as HTMLInputElement | null)?.value ??
      REVERB_DEFAULTS.decay,
  );
  const predelay = Number(
    (document.getElementById('reverb-predelay-slider') as HTMLInputElement | null)?.value ??
      REVERB_DEFAULTS.predelay,
  );
  const lowcut = Number(
    (document.getElementById('reverb-lowcut-slider') as HTMLInputElement | null)?.value ??
      REVERB_DEFAULTS.lowcut,
  );
  const highcut = Number(
    (document.getElementById('reverb-highcut-slider') as HTMLInputElement | null)?.value ??
      REVERB_DEFAULTS.highcut,
  );

  // Off: mix is 0 and no cut filters active
  if (mix === 0 && lowcut === 0 && highcut === 0) return 'off';

  // Check named presets against UI values derived from audio constants.
  // Use epsilon comparison for floats — slider values may have rounding drift.
  const nearEq = (a: number, b: number) => Math.abs(a - b) < 0.01;
  for (const [name, p] of Object.entries(REVERB_PRESETS)) {
    if (
      nearEq(mix, p.mix) &&
      nearEq(decay, p.decay) &&
      nearEq(predelay, p.predelay) &&
      nearEq(lowcut, p.lowcut) &&
      nearEq(highcut, p.highcut)
    ) {
      return name;
    }
  }

  return 'advanced';
}

function setReverbSlidersVisible(visible: boolean): void {
  const area = document.getElementById('reverb-sliders-area');
  if (!area) return;
  if (visible) {
    area.classList.remove('collapsed');
  } else {
    area.classList.add('collapsed');
  }
}

function syncReverbSlidersToPreset(type: string): void {
  clearReverbChipActive();

  if (type === 'off') {
    setRangeValueById('reverb-slider', REVERB_DEFAULTS.mix);
    setRangeValueById('reverb-decay-slider', REVERB_DEFAULTS.decay);
    setRangeValueById('reverb-predelay-slider', REVERB_DEFAULTS.predelay);
    setRangeValueById('reverb-lowcut-slider', REVERB_DEFAULTS.lowcut);
    setRangeValueById('reverb-highcut-slider', REVERB_DEFAULTS.highcut);
    formatReverbValDisp('mix', REVERB_DEFAULTS.mix);
    formatReverbValDisp('decay', REVERB_DEFAULTS.decay);
    formatReverbValDisp('predelay', REVERB_DEFAULTS.predelay);
    formatReverbValDisp('lowcut', REVERB_DEFAULTS.lowcut);
    formatReverbValDisp('highcut', REVERB_DEFAULTS.highcut);
    document.querySelector('#grid-reverb .ch-opt[data-rvb-type="off"]')?.classList.add('active');
    setReverbSlidersVisible(false);
    return;
  }

  if (type === 'advanced') {
    document
      .querySelector('#grid-reverb .ch-opt[data-rvb-type="advanced"]')
      ?.classList.add('active');
    setReverbSlidersVisible(true);
    return;
  }

  const preset = REVERB_PRESETS[type];
  if (!preset) return;

  setRangeValueById('reverb-slider', preset.mix);
  setRangeValueById('reverb-decay-slider', preset.decay);
  setRangeValueById('reverb-predelay-slider', preset.predelay);
  setRangeValueById('reverb-lowcut-slider', preset.lowcut);
  setRangeValueById('reverb-highcut-slider', preset.highcut);

  formatReverbValDisp('mix', preset.mix);
  formatReverbValDisp('decay', preset.decay);
  formatReverbValDisp('predelay', preset.predelay);
  formatReverbValDisp('lowcut', preset.lowcut);
  formatReverbValDisp('highcut', preset.highcut);

  document.querySelector(`#grid-reverb .ch-opt[data-rvb-type="${type}"]`)?.classList.add('active');
  setReverbSlidersVisible(false);
}

function resetEQ(): void {
  bus.emit('audio:reset-eq');
  for (let i = 0; i < 5; i++) {
    setRangeValueById(`eq-slider-${i}`, 0);
    _setDisp(`eq-val-${i}`, '0');
  }
  clearEqChipActive();
  document.querySelector('#grid-eq .ch-opt[data-eq-type="off"]')?.classList.add('active');
  setEqSlidersVisible(false);
}

// ─── EQ Preset Chips ───────────────────────────────────────────

const EQ_PRESETS: Record<string, number[]> = {
  bright: [0, -2, 0, 4, 6],
  warm: [5, 3, 0, -2, -3],
};

function clearEqChipActive(): void {
  document.querySelectorAll('#grid-eq .ch-opt').forEach((el) => el.classList.remove('active'));
}

function setEqSlidersVisible(visible: boolean): void {
  const area = document.getElementById('eq-sliders-area');
  if (!area) return;
  if (visible) {
    area.classList.remove('collapsed');
  } else {
    area.classList.add('collapsed');
  }
}

function syncEqSlidersToPreset(type: string): void {
  clearEqChipActive();

  if (type === 'off') {
    document.querySelector('#grid-eq .ch-opt[data-eq-type="off"]')?.classList.add('active');
    for (let i = 0; i < 5; i++) {
      setRangeValueById(`eq-slider-${i}`, 0);
      _setDisp(`eq-val-${i}`, '0');
    }
    setEqSlidersVisible(false);
    return;
  }

  if (type === 'advanced') {
    document.querySelector('#grid-eq .ch-opt[data-eq-type="advanced"]')?.classList.add('active');
    setEqSlidersVisible(true);
    return;
  }

  const preset = EQ_PRESETS[type];
  if (!preset) return;

  for (let i = 0; i < 5; i++) {
    setRangeValueById(`eq-slider-${i}`, preset[i]);
    const v = preset[i];
    _setDisp(`eq-val-${i}`, v > 0 ? `+${v}` : String(v));
  }

  document.querySelector(`#grid-eq .ch-opt[data-eq-type="${type}"]`)?.classList.add('active');
  setEqSlidersVisible(false);
}

function readEqSliderValues(): number[] | null {
  const values: number[] = [];
  for (let i = 0; i < 5; i++) {
    const slider = document.getElementById(`eq-slider-${i}`) as HTMLInputElement | null;
    if (!slider) return null;
    const value = Number(slider.value);
    values.push(Number.isFinite(value) ? value : 0);
  }
  return values;
}

function detectEqPreset(): string {
  const values = readEqSliderValues();
  if (!values) return 'advanced';
  if (values.every((value) => value === 0)) return 'off';

  for (const [name, preset] of Object.entries(EQ_PRESETS)) {
    if (preset.every((value, index) => values[index] === value)) return name;
  }

  return 'advanced';
}

function syncEqPresetFromCurrentSliders(): void {
  const detected = detectEqPreset();
  clearEqChipActive();
  document.querySelector(`#grid-eq .ch-opt[data-eq-type="${detected}"]`)?.classList.add('active');
  setEqSlidersVisible(detected === 'advanced');
}

function setSurroundOn(on: boolean): void {
  // Chip visuals sync before the idempotence guard: when state changed without
  // a ui:sync event (e.g. an OP's REQUEST_SETTING applied host-side), a click
  // on the already-true value must still heal the stale chip.
  document
    .querySelectorAll('#grid-surround .ch-opt')
    .forEach((el) => el.classList.remove('active'));
  document
    .querySelector(`#grid-surround .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)
    ?.classList.add('active');

  // Avoid duplicate feedback from repeated activation of the selected chip.
  const currentWidth = getState('audio.stereoWidth');
  const alreadyOn = currentWidth > 1;
  if (on === alreadyOn) return;
  bus.emit('audio:update-effect', 'stereo', 'mix', on ? 120 : 100, false);
  if (on) {
    // Host sharing system audio: route to guest-only notice instead of
    // distortion warning to avoid stacking two toasts.
    if (!_notifyGuestOnlyEffects()) showToast(t('toast.distortion_warn'));
  }
}

function setVisualizerMode(mode: 'circular' | 'spectrum'): void {
  document
    .querySelectorAll('#grid-visualizer .ch-opt')
    .forEach((el) => el.classList.remove('active'));
  document.querySelector(`#grid-visualizer .ch-opt[data-viz="${mode}"]`)?.classList.add('active');
  try {
    localStorage.setItem('musixquare-viz-mode', mode);
  } catch {
    /* Safari private mode */
  }
  bus.emit('visualizer:set-type', mode);
}

function setVBassOn(on: boolean): void {
  document.querySelectorAll('#grid-vbass .ch-opt').forEach((el) => el.classList.remove('active'));
  document
    .querySelector(`#grid-vbass .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)
    ?.classList.add('active');
  bus.emit('audio:update-effect', 'vbass', 'mix', on ? 60 : 0, false);
  if (on) {
    if (!_notifyGuestOnlyEffects()) showToast(t('toast.distortion_warn'));
  }
}

function setExciterOn(on: boolean): void {
  document.querySelectorAll('#grid-exciter .ch-opt').forEach((el) => el.classList.remove('active'));
  document
    .querySelector(`#grid-exciter .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)
    ?.classList.add('active');
  // Wire shape is 0|1 so it survives the REQUEST_SETTING number validator.
  // effects.ts converts back to boolean for setState.
  bus.emit('audio:update-effect', 'exciter', 'mix', on ? 1 : 0, false);
  if (on) {
    if (!_notifyGuestOnlyEffects()) showToast(t('toast.distortion_warn'));
  }
}

// ─── Device List ─────────────────────────────────────────────────

interface DeviceListRow {
  id?: unknown;
  label?: unknown;
  isOp?: unknown;
  isHost?: unknown;
  status?: unknown;
}

function isDeviceListRow(value: unknown): value is DeviceListRow {
  return value !== null && typeof value === 'object';
}

function renderDeviceList(list: ReadonlyArray<DeviceListRow>): void {
  const container = document.getElementById('device-list');
  if (!container) return;

  container.replaceChildren();

  list.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'section-row';

    const name = document.createElement('span');
    name.className = 'd-name';
    name.textContent = String(p.label || t('common.peer'));
    applyUserTextFontFallback(name, name.textContent);

    const shortId = document.createElement('span');
    shortId.style.cssText = 'font-size:11px; opacity:0.5; margin-left:4px;';
    shortId.textContent = `(${String(p.id || '').slice(-4)})`;
    name.appendChild(document.createTextNode(' '));
    name.appendChild(shortId);

    const statusClass = p.status === 'connected' ? 'active' : 'inactive';
    const statusText = p.status === 'connected' ? t('common.connected') : t('common.disconnected');

    const status = document.createElement('span');
    status.className = `d-status ${statusClass}`;
    status.textContent = statusText;

    row.appendChild(name);

    row.appendChild(status);

    container.appendChild(row);
  });
}

// ─── Lifecycle ──────────────────────────────────────────────────────

const _busScope = createBusScope();

function refreshLanguageControls(): void {
  const mode = getLanguageMode();
  const resolved = getResolvedLanguage();

  document.querySelectorAll('#grid-lang .ch-opt').forEach((el) => el.classList.remove('active'));
  document
    .getElementById(mode === 'system' ? 'btn-language-system' : 'btn-language-select')
    ?.classList.add('active');

  document.querySelectorAll<HTMLElement>('.language-option[data-lang]').forEach((option) => {
    const active = option.dataset.lang === resolved;
    option.classList.toggle('active', active);
    option.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function renderLanguageOptions(): void {
  const list = document.getElementById('language-list');
  if (!list || list.dataset.rendered === 'true') return;

  const systemLanguage = getSupportedSystemLanguage();
  const systemOption = systemLanguage
    ? LANGUAGE_OPTIONS.find((language) => language.code === systemLanguage)
    : undefined;
  const languageOptions = systemOption
    ? [systemOption, ...LANGUAGE_OPTIONS.filter((language) => language.code !== systemLanguage)]
    : LANGUAGE_OPTIONS;

  const fragment = document.createDocumentFragment();
  for (const lang of languageOptions) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'language-option';
    option.dataset.lang = lang.code;
    option.setAttribute('aria-pressed', 'false');

    const label = document.createElement('span');
    label.className = 'language-option-label';

    const nativeName = document.createElement('span');
    nativeName.className = 'language-option-native';
    nativeName.lang = lang.htmlLang;
    nativeName.textContent = lang.nativeName;
    label.appendChild(nativeName);

    if (String(lang.englishName) !== String(lang.nativeName)) {
      const englishName = document.createElement('span');
      englishName.className = 'language-option-english';
      englishName.lang = 'en';
      englishName.textContent = lang.englishName;
      label.appendChild(englishName);
    }

    const check = document.createElement('span');
    check.className = 'language-option-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 6.9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    option.appendChild(label);
    option.appendChild(check);
    option.addEventListener('click', () => {
      setLanguageMode(lang.code);
      refreshLanguageControls();
      bus.emit('ui:scrollbar-relayout');
    });

    fragment.appendChild(option);
  }

  list.appendChild(fragment);
  list.dataset.rendered = 'true';
  initCustomScrollbar(list);
  bindLanguageScrollMask();
  updateLanguageScrollMask();
  refreshLanguageControls();
}

function updateLanguageScrollMask(): void {
  const list = document.getElementById('language-list');
  if (!list) return;

  const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
  const hasOverflow = maxScrollTop > 2;
  const scrollTop = list.scrollTop;

  list.classList.toggle('can-scroll-up', hasOverflow && scrollTop > 2);
  list.classList.toggle('can-scroll-down', hasOverflow && scrollTop < maxScrollTop - 2);
}

function bindLanguageScrollMask(): void {
  const list = document.getElementById('language-list');
  if (!list || list.dataset.scrollMaskBound === '1') return;

  list.dataset.scrollMaskBound = '1';
  list.addEventListener('scroll', () => updateLanguageScrollMask(), { passive: true });
}

let _languageDialogPreviousFocus: HTMLElement | null = null;

function openLanguageDialog(): void {
  renderLanguageOptions();
  refreshLanguageControls();

  const overlay = document.getElementById('language-dialog-overlay');
  if (!overlay) return;
  _languageDialogPreviousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : document.getElementById('btn-language-select');
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  syncOverlayState('language-dialog-overlay');

  setManagedTimer(
    'language-dialog-focus',
    () => {
      const active =
        document.querySelector<HTMLElement>(
          `.language-option[data-lang="${getResolvedLanguage() as LanguageCode}"]`,
        ) || document.querySelector<HTMLElement>('.language-option');
      active?.focus();
      bus.emit('ui:scrollbar-relayout');
      updateLanguageScrollMask();
    },
    0,
  );
}

function closeLanguageDialog(): void {
  const overlay = document.getElementById('language-dialog-overlay');
  if (!overlay) return;
  const wasShown = overlay.classList.contains('show');
  clearManagedTimer('language-dialog-focus');
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  syncOverlayState();

  const previousFocus = _languageDialogPreviousFocus;
  _languageDialogPreviousFocus = null;
  if (!wasShown) return;

  const fallback = document.getElementById('btn-language-select');
  const target = previousFocus?.isConnected ? previousFocus : fallback;
  target?.focus();
}

export function initSettings(): void {
  _busScope.dispose();
  const $on = (id: string, evt: string, fn: EventListener) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  };

  _bindHostCtrlLockedAttemptToasts();

  // UI sounds are a local-only preference and default to off. The buttons
  // opt out of the global click sound so enabling produces exactly one preview.
  document.querySelectorAll<HTMLElement>('#grid-ui-sounds [data-ui-sounds]').forEach((button) => {
    button.addEventListener('click', () => {
      const enabled = button.dataset.uiSounds === 'on';
      setUiSoundsEnabled(enabled);
      if (enabled) playUiTouchSound({ force: true });
    });
  });
  _busScope.on('ui:ui-sounds-changed', syncUiSoundsControls);
  syncUiSoundsControls();

  // Theme grid
  document.querySelectorAll<HTMLElement>('#grid-theme .ch-opt[data-theme]').forEach((opt) => {
    opt.addEventListener('click', () => setTheme(opt.dataset.theme!));
  });

  // Language controls
  renderLanguageOptions();
  $on('btn-language-select', 'click', () => openLanguageDialog());
  $on('btn-language-system', 'click', () => setLanguageMode('system'));
  $on('btn-language-dialog-done', 'click', () => closeLanguageDialog());
  const languageOverlay = document.getElementById('language-dialog-overlay');
  languageOverlay?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeLanguageDialog();
  });
  refreshLanguageControls();

  // Channel grid (standard)
  document.querySelectorAll<HTMLElement>('#grid-standard .ch-opt[data-ch]').forEach((el) => {
    el.addEventListener('click', () => {
      // Host: block channel change during system audio sharing
      if (!getState('network.hostConn') && isPlaybackModeSystemAudio()) {
        showToast(t('system_audio.host_channel_locked'));
        return;
      }
      setChannel(parseInt(el.dataset.ch!, 10));
    });
  });

  document
    .querySelectorAll<HTMLElement>(
      '[data-role-diagram="settings"] .graphic-speaker[data-role-mode]',
    )
    .forEach((el) => {
      el.addEventListener('click', () => {
        if (!getState('network.hostConn') && isPlaybackModeSystemAudio()) {
          showToast(t('system_audio.host_channel_locked'));
          return;
        }
        const mode = Number(el.dataset.roleMode);
        if (Number.isFinite(mode)) setChannel(mode);
      });
    });

  // Subwoofer cutoff
  $on('cutoff-slider', 'input', function (this: HTMLInputElement) {
    updateAudioEffect('cutoff', 'value', Number(this.value), true);
  });
  $on('cutoff-slider', 'change', function (this: HTMLInputElement) {
    updateAudioEffect('cutoff', 'value', Number(this.value));
  });
  $on('cutoff-slider', 'dblclick', function (this: HTMLInputElement) {
    updateAudioEffect('cutoff', 'value', 120);
    setRangeValue(this, 120);
  });

  // Reverb preset grid
  document.querySelectorAll<HTMLElement>('#grid-reverb .ch-opt[data-rvb-type]').forEach((opt) => {
    opt.addEventListener('click', () => {
      if (_guardHostCtrl()) return;
      const type = opt.dataset.rvbType!;
      syncReverbSlidersToPreset(type);
      // Off resets reverb; Hall/Space apply preset; Advanced is UI-only
      if (type === 'off') {
        bus.emit('audio:reverb-type-change', 'off');
        _notifyGuestOnlyEffects();
      } else if (type !== 'advanced') {
        bus.emit('audio:reverb-type-change', type);
        _notifyGuestOnlyEffects();
      }
    });
  });

  const reverbSliders = [
    { id: 'reverb-slider', param: 'mix', resetVal: REVERB_DEFAULTS.mix },
    { id: 'reverb-decay-slider', param: 'decay', resetVal: REVERB_DEFAULTS.decay },
    { id: 'reverb-predelay-slider', param: 'predelay', resetVal: REVERB_DEFAULTS.predelay },
    { id: 'reverb-lowcut-slider', param: 'lowcut', resetVal: REVERB_DEFAULTS.lowcut },
    { id: 'reverb-highcut-slider', param: 'highcut', resetVal: REVERB_DEFAULTS.highcut },
  ];
  reverbSliders.forEach(({ id, param, resetVal }) => {
    $on(id, 'input', function (this: HTMLInputElement) {
      if (_isGuestLocked()) return;
      updateAudioEffect('reverb', param, Number(this.value), true);
    });
    $on(id, 'change', function (this: HTMLInputElement) {
      if (_isGuestLocked()) return;
      updateAudioEffect('reverb', param, Number(this.value));
    });
    $on(id, 'dblclick', function (this: HTMLInputElement) {
      if (_guardHostCtrl()) return;
      updateAudioEffect('reverb', param, resetVal);
      setRangeValue(this, resetVal);
    });
  });

  // Guest UI sync: when host changes reverb preset
  _busScope.on('ui:sync-reverb-preset', (type: string) => {
    syncReverbSlidersToPreset(type);
  });

  // EQ preset grid
  document.querySelectorAll<HTMLElement>('#grid-eq .ch-opt[data-eq-type]').forEach((opt) => {
    opt.addEventListener('click', () => {
      if (_guardHostCtrl()) return;
      const type = opt.dataset.eqType!;
      if (type === 'off') {
        resetEQ(); // resetEQ triggers ui:sync-eq-preset('off') which calls syncEqSlidersToPreset
        return;
      }
      syncEqSlidersToPreset(type);
      if (type !== 'advanced') {
        const preset = EQ_PRESETS[type];
        if (preset) {
          for (let i = 0; i < 5; i++) setEQ(i, preset[i]);
        }
      }
    });
  });

  // Guest UI sync: when host changes EQ preset
  _busScope.on('ui:sync-eq-preset', (type: string) => {
    syncEqSlidersToPreset(type);
  });

  // EQ sliders
  for (let i = 0; i < 5; i++) {
    $on(`eq-slider-${i}`, 'input', function (this: HTMLInputElement) {
      if (_isGuestLocked()) return;
      setEQ(i, Number(this.value), true);
    });
    $on(`eq-slider-${i}`, 'change', function (this: HTMLInputElement) {
      if (_isGuestLocked()) return;
      setEQ(i, Number(this.value));
    });
    $on(`eq-slider-${i}`, 'dblclick', () => {
      if (_guardHostCtrl()) return;
      setEQ(i, 0);
      const el = document.getElementById(`eq-slider-${i}`) as HTMLInputElement;
      if (el) setRangeValue(el, 0);
    });
  }

  // Virtual Surround ON/OFF grid
  document.querySelectorAll<HTMLElement>('#grid-surround .ch-opt[data-toggle]').forEach((opt) => {
    opt.addEventListener('click', () => {
      if (_guardHostCtrl()) return;
      setSurroundOn(opt.dataset.toggle === 'on');
    });
  });

  // Virtual Bass ON/OFF grid
  document.querySelectorAll<HTMLElement>('#grid-vbass .ch-opt[data-toggle]').forEach((opt) => {
    opt.addEventListener('click', () => {
      if (_guardHostCtrl()) return;
      setVBassOn(opt.dataset.toggle === 'on');
    });
  });

  // Exciter ON/OFF grid (subtle high-frequency harmonic enhancer)
  document.querySelectorAll<HTMLElement>('#grid-exciter .ch-opt[data-toggle]').forEach((opt) => {
    opt.addEventListener('click', () => {
      if (_guardHostCtrl()) return;
      setExciterOn(opt.dataset.toggle === 'on');
    });
  });

  // Visualizer mode grid
  document.querySelectorAll<HTMLElement>('#grid-visualizer .ch-opt[data-viz]').forEach((opt) => {
    opt.addEventListener('click', () =>
      setVisualizerMode(opt.dataset.viz as 'circular' | 'spectrum'),
    );
  });

  // Manual sync popup
  $on('btn-nudge-minus10', 'click', () => bus.emit('sync:nudge', -10));
  $on('btn-nudge-minus1', 'click', () => bus.emit('sync:nudge', -1));
  $on('btn-nudge-plus1', 'click', () => bus.emit('sync:nudge', 1));
  $on('btn-nudge-plus10', 'click', () => bus.emit('sync:nudge', 10));
  $on('btn-auto-sync', 'click', () => bus.emit('sync:auto-sync'));
  $on('btn-sync-done', 'click', () => bus.emit('sync:close-manual'));

  // ─── Guest UI Sync: host broadcasts setting changes ──────────

  // Reverb individual slider sync (from host broadcast)
  _busScope.on('ui:sync-reverb-param', (param: string, value: number) => {
    const sliderMap: Record<string, string> = {
      mix: 'reverb-slider',
      decay: 'reverb-decay-slider',
      predelay: 'reverb-predelay-slider',
      lowcut: 'reverb-lowcut-slider',
      highcut: 'reverb-highcut-slider',
    };
    const sliderId = sliderMap[param];
    if (sliderId) {
      setRangeValueById(sliderId, value);
    }
    formatReverbValDisp(param, value);

    // Sync preset chip: detect if current values match a named preset
    const detected = detectReverbPreset();
    clearReverbChipActive();
    document
      .querySelector(`#grid-reverb .ch-opt[data-rvb-type="${detected}"]`)
      ?.classList.add('active');
    setReverbSlidersVisible(detected === 'advanced');
  });

  // Surround toggle sync (from host broadcast)
  _busScope.on('ui:sync-surround', (on: boolean) => {
    document
      .querySelectorAll('#grid-surround .ch-opt[data-toggle]')
      .forEach((el) => el.classList.remove('active'));
    document
      .querySelector(`#grid-surround .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)
      ?.classList.add('active');
  });

  // Virtual Bass toggle sync (from host broadcast)
  _busScope.on('ui:sync-vbass', (on: boolean) => {
    document
      .querySelectorAll('#grid-vbass .ch-opt[data-toggle]')
      .forEach((el) => el.classList.remove('active'));
    document
      .querySelector(`#grid-vbass .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)
      ?.classList.add('active');
  });

  // Exciter toggle sync (from host broadcast)
  _busScope.on('ui:sync-exciter', (on: boolean) => {
    document
      .querySelectorAll('#grid-exciter .ch-opt[data-toggle]')
      .forEach((el) => el.classList.remove('active'));
    document
      .querySelector(`#grid-exciter .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)
      ?.classList.add('active');
  });

  // EQ band slider/label sync (from audio module via bus, avoids audio→DOM coupling)
  _busScope.on('ui:sync-eq-band', (bandIdx: number, value: number) => {
    _setDisp(`eq-val-${bandIdx}`, value > 0 ? `+${value}` : String(value));
    const slider = document.getElementById(`eq-slider-${bandIdx}`) as HTMLInputElement | null;
    if (slider && parseFloat(slider.value) !== value) setRangeValue(slider, value);
    syncEqPresetFromCurrentSliders();
  });

  // ─── Host-Ctrl Lock UI update on role change ──────────────────

  // Update lock state when connection/role changes (fires on connect, OP grant/revoke, session start)
  _busScope.on('network:role-badge-update', () => _updateHostCtrlLockUI());
  _busScope.on('state:network.hostConn', () => _updateHostCtrlLockUI());
  _busScope.on('state:network.appRole', () => _updateHostCtrlLockUI());
  _busScope.on('state:network.standardRoomCapabilities', () => _updateHostCtrlLockUI());
  _updateHostCtrlLockUI();

  // Device list events
  _busScope.on('network:device-list-update', (list: unknown[]) => {
    if (Array.isArray(list)) renderDeviceList(list.filter(isDeviceListRow));
  });

  _busScope.on('state:room.context', () => {
    const list = getState('network.lastKnownDeviceList') || [];
    renderDeviceList(list.filter(isDeviceListRow));
    _updateHostCtrlLockUI();
  });

  // Language switch → re-render device list so status/grant-revoke button
  // labels pick up the new locale (those strings are composed at render
  // time via t() and don't carry data-i18n attributes).
  // Source must be lastKnownDeviceList (the canonical broadcast list):
  // connectedPeers is host-only raw state — empty on guests, missing the
  // host's own row — and re-rendering from it wipes the list.
  _busScope.on('i18n:changed', () => {
    const list = getState('network.lastKnownDeviceList') || [];
    renderDeviceList(list.filter(isDeviceListRow));
    refreshLanguageControls();
    updateLanguageScrollMask();
  });

  // Initial theme: restore from localStorage (defaults to system; 'system' auto-resolves)
  try {
    const savedTheme = localStorage.getItem('musixquare-theme');
    setTheme(savedTheme || 'system', false);
  } catch {
    setTheme('system', false);
  }

  // Restore visualizer mode
  try {
    const savedViz = localStorage.getItem('musixquare-viz-mode');
    if (savedViz === 'spectrum') setVisualizerMode('spectrum');
  } catch {
    /* ignore */
  }

  // ─── Desktop Settings Sub-Tab Navigation ──────────────────────
  initSettingsSubtabs();

  log.info('[Settings] Initialized');
}

// ─── Settings Sub-Tab Switching (Desktop) ─────────────────────────

function initSettingsSubtabs(): void {
  document.querySelectorAll<HTMLElement>('.subtab-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const subtab = btn.dataset.subtab;
      if (subtab) switchSettingsSubtab(subtab);
    });
  });
}

function switchSettingsSubtab(id: string): void {
  document
    .querySelectorAll<HTMLElement>('.subtab-pill')
    .forEach((p) => p.classList.toggle('active', p.dataset.subtab === id));
  document
    .querySelectorAll<HTMLElement>('.settings-subtab-panel')
    .forEach((p) => p.classList.toggle('active', p.dataset.panel === id));
}

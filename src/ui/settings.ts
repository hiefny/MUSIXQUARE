/**
 * MUSIXQUARE 3.0 — Settings Panel (UI)
 *
 * Manages: Theme, channel mode selection, EQ/reverb/stereo/vbass sliders,
 * device list rendering.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { setLanguageMode, t } from '../i18n/index.ts';
import { getStandardRolePreset } from './player-controls.ts';

// ─── Host-Ctrl Lock (Guest cannot change host-controlled settings) ──

/** Returns true if user is a non-OP guest (should be blocked from host-ctrl settings) */
function _isGuestLocked(): boolean {
  const hostConn = getState('network.hostConn');
  if (!hostConn) return false; // Host — never locked
  return !getState('network.isOperator');
}

/** Show toast + return true if guest is locked */
function _guardHostCtrl(): boolean {
  if (_isGuestLocked()) {
    bus.emit('ui:show-toast', t('toast.operator_required'));
    return true;
  }
  return false;
}

/** Apply or remove visual lock on host-ctrl sections */
function _updateHostCtrlLockUI(): void {
  const locked = _isGuestLocked();
  const hostCtrlIds = ['grid-reverb', 'reverb-sliders-area', 'grid-eq', 'eq-sliders-area', 'grid-surround', 'grid-vbass'];
  hostCtrlIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('host-ctrl-locked', locked);
  });
}

// ─── Theme ───────────────────────────────────────────────────────

export function setTheme(mode: string): void {
  // Migrate legacy 'system' → resolve to actual value
  if (mode === 'system') {
    mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.querySelectorAll('#grid-theme .ch-opt').forEach(el => el.classList.remove('active'));
  document.querySelector(`#grid-theme .ch-opt[data-theme="${mode}"]`)?.classList.add('active');

  document.documentElement.setAttribute('data-theme', mode);

  // Persist preference
  try { localStorage.setItem('musixquare-theme', mode); } catch { /* ignore */ }

  // Update meta tags for PWA/browser integration
  document.documentElement.style.colorScheme = mode;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', mode === 'dark' ? '#000000' : '#f2f2f7');
  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (schemeMeta) schemeMeta.setAttribute('content', mode);
}

// ─── Channel Mode (Standard) ─────────────────────────────────────

export function selectStandardChannelButton(mode: number): void {
  const all = document.querySelectorAll('#grid-standard .ch-opt[data-ch]');
  all.forEach(e => e.classList.remove('active'));
  const el = document.querySelector(`#grid-standard .ch-opt[data-ch="${mode}"]`);
  if (el) el.classList.add('active');

  // Sync woofer cutoff slider visibility
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
  bus.emit('ui:show-toast', t(preset.placementToastKey));
}

// ─── Value Display Helpers ────────────────────────────────────────

function _setDisp(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
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
      const lFreq = 20 * Math.pow(50, v / 100);
      _setDisp('val-rvb-lowcut', lFreq >= 1000 ? (lFreq / 1000).toFixed(1) + 'kHz' : Math.round(lFreq) + 'Hz');
      break;
    }
    case 'highcut': {
      const hFreq = 20000 * Math.pow(0.05, v / 100);
      _setDisp('val-rvb-highcut', hFreq >= 1000 ? (hFreq / 1000).toFixed(1) + 'kHz' : Math.round(hFreq) + 'Hz');
      break;
    }
  }
}

// ─── Audio Effects Helpers ────────────────────────────────────────

function updateAudioEffect(type: string, param: string, value: number, isPreview = false): void {
  // Update value display
  if (type === 'reverb') formatReverbValDisp(param, value);
  else if (type === 'cutoff') _setDisp('val-cutoff', value + ' Hz');

  bus.emit('audio:update-effect', type, param, value, isPreview);
}

function setEQ(band: number, value: number, isPreview = false): void {
  _setDisp(`eq-val-${band}`, value > 0 ? `+${value}` : String(value));
  bus.emit('audio:set-eq', band, value, isPreview);
}


// ─── Reverb Preset Chips ───────────────────────────────────────

const REVERB_PRESETS: Record<string, { mix: number; decay: number; predelay: number }> = {
  studio:  { mix: 30, decay: 1.0, predelay: 0.02 },
  arena: { mix: 40, decay: 5.0, predelay: 0.12 },
};

function clearReverbChipActive(): void {
  document.querySelectorAll('#grid-reverb .ch-opt').forEach(el => el.classList.remove('active'));
}

/**
 * Read current slider values and detect which preset (if any) matches.
 * Returns 'off', 'studio', 'arena', or 'advanced'.
 */
function detectReverbPreset(): string {
  const mix      = Number((document.getElementById('reverb-slider') as HTMLInputElement | null)?.value ?? 0);
  const decay    = Number((document.getElementById('reverb-decay-slider') as HTMLInputElement | null)?.value ?? 5);
  const predelay = Number((document.getElementById('reverb-predelay-slider') as HTMLInputElement | null)?.value ?? 0.1);
  const lowcut   = Number((document.getElementById('reverb-lowcut-slider') as HTMLInputElement | null)?.value ?? 0);
  const highcut  = Number((document.getElementById('reverb-highcut-slider') as HTMLInputElement | null)?.value ?? 0);

  // Off: mix is 0 and no cut filters active
  if (mix === 0 && lowcut === 0 && highcut === 0) return 'off';

  // Check named presets (lowcut/highcut must be 0 to match).
  // Use epsilon comparison for floats — slider values may have rounding drift.
  const nearEq = (a: number, b: number) => Math.abs(a - b) < 0.01;
  if (lowcut === 0 && highcut === 0) {
    for (const [name, p] of Object.entries(REVERB_PRESETS)) {
      if (nearEq(mix, p.mix) && nearEq(decay, p.decay) && nearEq(predelay, p.predelay)) return name;
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
    // Off: reset reverb, reset slider values to defaults, hide sliders
    const defaults = { mix: 0, decay: 5.0, predelay: 0.1, lowcut: 0, highcut: 0 };
    const mixSlider = document.getElementById('reverb-slider') as HTMLInputElement | null;
    const decaySlider = document.getElementById('reverb-decay-slider') as HTMLInputElement | null;
    const predelaySlider = document.getElementById('reverb-predelay-slider') as HTMLInputElement | null;
    const lowcutSlider = document.getElementById('reverb-lowcut-slider') as HTMLInputElement | null;
    const highcutSlider = document.getElementById('reverb-highcut-slider') as HTMLInputElement | null;
    if (mixSlider) mixSlider.value = String(defaults.mix);
    if (decaySlider) decaySlider.value = String(defaults.decay);
    if (predelaySlider) predelaySlider.value = String(defaults.predelay);
    if (lowcutSlider) lowcutSlider.value = String(defaults.lowcut);
    if (highcutSlider) highcutSlider.value = String(defaults.highcut);
    formatReverbValDisp('mix', defaults.mix);
    formatReverbValDisp('decay', defaults.decay);
    formatReverbValDisp('predelay', defaults.predelay);
    formatReverbValDisp('lowcut', defaults.lowcut);
    formatReverbValDisp('highcut', defaults.highcut);
    document.querySelector('#grid-reverb .ch-opt[data-rvb-type="off"]')?.classList.add('active');
    setReverbSlidersVisible(false);
    return;
  }

  if (type === 'advanced') {
    // Advanced: show sliders, mark chip active
    document.querySelector('#grid-reverb .ch-opt[data-rvb-type="advanced"]')?.classList.add('active');
    setReverbSlidersVisible(true);
    return;
  }

  const preset = REVERB_PRESETS[type];
  if (!preset) return;

  // Update slider positions (for when user switches to Advanced later)
  const mixSlider = document.getElementById('reverb-slider') as HTMLInputElement | null;
  const decaySlider = document.getElementById('reverb-decay-slider') as HTMLInputElement | null;
  const predelaySlider = document.getElementById('reverb-predelay-slider') as HTMLInputElement | null;
  const lowcutSlider = document.getElementById('reverb-lowcut-slider') as HTMLInputElement | null;
  const highcutSlider = document.getElementById('reverb-highcut-slider') as HTMLInputElement | null;
  if (mixSlider) mixSlider.value = String(preset.mix);
  if (decaySlider) decaySlider.value = String(preset.decay);
  if (predelaySlider) predelaySlider.value = String(preset.predelay);
  // Reset lowcut/highcut to defaults when switching presets (presets don't define them)
  if (lowcutSlider) lowcutSlider.value = '0';
  if (highcutSlider) highcutSlider.value = '0';

  // Update value displays
  formatReverbValDisp('mix', preset.mix);
  formatReverbValDisp('decay', preset.decay);
  formatReverbValDisp('predelay', preset.predelay);
  formatReverbValDisp('lowcut', 0);
  formatReverbValDisp('highcut', 0);

  // Update chip active state + hide sliders
  document.querySelector(`#grid-reverb .ch-opt[data-rvb-type="${type}"]`)?.classList.add('active');
  setReverbSlidersVisible(false);
}

function resetEQ(): void {
  bus.emit('audio:reset-eq');
  // Reset slider UI
  for (let i = 0; i < 5; i++) {
    const eq = document.getElementById(`eq-slider-${i}`) as HTMLInputElement | null;
    if (eq) eq.value = '0';
    _setDisp(`eq-val-${i}`, '0');
  }
  clearEqChipActive();
  document.querySelector('#grid-eq .ch-opt[data-eq-type="off"]')?.classList.add('active');
  setEqSlidersVisible(false);
}

// ─── EQ Preset Chips ───────────────────────────────────────────

const EQ_PRESETS: Record<string, number[]> = {
  bright: [0, -2, 0, 4, 6],
  warm:   [5, 3, 0, -2, -3],
};

function clearEqChipActive(): void {
  document.querySelectorAll('#grid-eq .ch-opt').forEach(el => el.classList.remove('active'));
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
    // Zero all slider DOM values so switching to Advanced shows flat EQ
    for (let i = 0; i < 5; i++) {
      const slider = document.getElementById(`eq-slider-${i}`) as HTMLInputElement | null;
      if (slider) slider.value = '0';
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

  // Update slider positions (for when user switches to Advanced later)
  for (let i = 0; i < 5; i++) {
    const slider = document.getElementById(`eq-slider-${i}`) as HTMLInputElement | null;
    if (slider) slider.value = String(preset[i]);
    const v = preset[i];
    _setDisp(`eq-val-${i}`, v > 0 ? `+${v}` : String(v));
  }

  document.querySelector(`#grid-eq .ch-opt[data-eq-type="${type}"]`)?.classList.add('active');
  setEqSlidersVisible(false);
}

function setSurroundOn(on: boolean): void {
  // Guard: skip if already in requested state (prevents dblclick duplicate toast)
  const currentWidth = getState('audio.stereoWidth');
  const alreadyOn = currentWidth > 1;
  if (on === alreadyOn) return;

  document.querySelectorAll('#grid-surround .ch-opt').forEach(el => el.classList.remove('active'));
  document.querySelector(`#grid-surround .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)?.classList.add('active');
  // ON: 120%, OFF: 100%
  bus.emit('audio:update-effect', 'stereo', 'mix', on ? 120 : 100, false);
  if (on) bus.emit('ui:show-toast', t('toast.distortion_warn'));
}

function setBatterySaver(on: boolean): void {
  document.querySelectorAll('#grid-battery .ch-opt').forEach(el => el.classList.remove('active'));
  document.querySelector(`#grid-battery .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)?.classList.add('active');
  try { localStorage.setItem('musixquare-battery-saver', on ? '1' : '0'); } catch { /* Safari private mode */ }
  bus.emit('visualizer:battery-saver', on);
  if (on) bus.emit('ui:show-toast', t('toast.battery_saver_on'));
}

function setVBassOn(on: boolean): void {
  document.querySelectorAll('#grid-vbass .ch-opt').forEach(el => el.classList.remove('active'));
  document.querySelector(`#grid-vbass .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)?.classList.add('active');
  // ON: 60%, OFF: 0%
  bus.emit('audio:update-effect', 'vbass', 'mix', on ? 60 : 0, false);
  if (on) bus.emit('ui:show-toast', t('toast.distortion_warn'));
}

// ─── Device List ─────────────────────────────────────────────────

export function renderDeviceList(list: Array<Record<string, unknown>>): void {
  const container = document.getElementById('device-list');
  if (!container) return;

  container.innerHTML = '';

  list.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'section-row';

    const name = document.createElement('span');
    name.className = 'd-name';
    name.textContent = String(p.label || 'Device');

    const shortId = document.createElement('span');
    shortId.style.cssText = 'font-size:11px; opacity:0.5; margin-left:4px;';
    shortId.textContent = `(${String(p.id || '').slice(-4)})`;
    name.appendChild(document.createTextNode(' '));
    name.appendChild(shortId);

    if (p.isOp) {
      const op = document.createElement('span');
      op.style.cssText = 'color:var(--primary); font-size:10px; font-weight:bold; margin-left:4px;';
      op.textContent = 'OP';
      name.appendChild(document.createTextNode(' '));
      name.appendChild(op);
    }

    const statusClass = p.status === 'connected' ? 'active' : 'inactive';
    const statusText = p.status === 'connected' ? t('common.connected') : t('common.disconnected');

    const status = document.createElement('span');
    status.className = `d-status ${statusClass}`;
    status.textContent = statusText;

    row.appendChild(name);

    const hostConn = getState('network.hostConn');
    if (hostConn) {
      row.appendChild(status);
    } else {
      const right = document.createElement('div');
      right.style.cssText = 'display:flex; gap:4px; align-items:center;';

      if (!p.isHost && p.status === 'connected') {
        const opBtn = document.createElement('button');
        opBtn.className = `btn-action ${p.isOp ? 'active' : ''}`;
        opBtn.dataset.opPeer = String(p.id || '');
        opBtn.style.cssText = `font-size:10px; padding:4px 8px; margin-right:8px; ${p.isOp ? 'background:var(--primary); color:white; border:none;' : ''}`;
        opBtn.textContent = p.isOp ? t('common.revoke') : t('common.grant');

        opBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const peerId = opBtn.dataset.opPeer;
          if (peerId) bus.emit('network:toggle-operator', peerId);
        });

        right.appendChild(opBtn);
      }

      right.appendChild(status);
      row.appendChild(right);
    }

    container.appendChild(row);
  });
}

// ─── Init ────────────────────────────────────────────────────────

export function initSettings(): void {
  const $on = (id: string, evt: string, fn: EventListener) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  };

  // Theme grid
  document.querySelectorAll<HTMLElement>('#grid-theme .ch-opt[data-theme]').forEach(opt => {
    opt.addEventListener('click', () => setTheme(opt.dataset.theme!));
  });

  // Language grid
  document.querySelectorAll<HTMLElement>('#grid-lang .ch-opt[data-lang]').forEach(opt => {
    opt.addEventListener('click', () => setLanguageMode(opt.dataset.lang!));
  });

  // Channel grid (standard)
  document.querySelectorAll<HTMLElement>('#grid-standard .ch-opt[data-ch]').forEach(el => {
    el.addEventListener('click', () => {
      // Role selection is always allowed — each device picks its own speaker role
      setChannel(parseInt(el.dataset.ch!, 10));
    });
  });

  // Subwoofer cutoff
  $on('cutoff-slider', 'input', function (this: HTMLInputElement) { updateAudioEffect('cutoff', 'value', Number(this.value), true); });
  $on('cutoff-slider', 'change', function (this: HTMLInputElement) { updateAudioEffect('cutoff', 'value', Number(this.value)); });
  $on('cutoff-slider', 'dblclick', function (this: HTMLInputElement) { updateAudioEffect('cutoff', 'value', 120); this.value = '120'; });

  // Reverb preset grid
  document.querySelectorAll<HTMLElement>('#grid-reverb .ch-opt[data-rvb-type]').forEach(opt => {
    opt.addEventListener('click', () => {
      if (_guardHostCtrl()) return;
      const type = opt.dataset.rvbType!;
      syncReverbSlidersToPreset(type);
      // Off resets reverb; Hall/Space apply preset; Advanced is UI-only
      if (type === 'off') {
        bus.emit('audio:reverb-type-change', 'off');
      } else if (type !== 'advanced') {
        bus.emit('audio:reverb-type-change', type);
      }
    });
  });

  const reverbSliders = [
    { id: 'reverb-slider', param: 'mix', resetVal: 0 },
    { id: 'reverb-decay-slider', param: 'decay', resetVal: 5.0 },
    { id: 'reverb-predelay-slider', param: 'predelay', resetVal: 0.1 },
    { id: 'reverb-lowcut-slider', param: 'lowcut', resetVal: 0 },
    { id: 'reverb-highcut-slider', param: 'highcut', resetVal: 0 },
  ];
  reverbSliders.forEach(({ id, param, resetVal }) => {
    $on(id, 'input', function (this: HTMLInputElement) { if (_isGuestLocked()) return; updateAudioEffect('reverb', param, Number(this.value), true); });
    $on(id, 'change', function (this: HTMLInputElement) { if (_isGuestLocked()) return; updateAudioEffect('reverb', param, Number(this.value)); });
    $on(id, 'dblclick', function (this: HTMLInputElement) { if (_guardHostCtrl()) return; updateAudioEffect('reverb', param, resetVal); this.value = String(resetVal); });
  });

  // Guest UI sync: when host changes reverb preset
  bus.on('ui:sync-reverb-preset', (type: string) => {
    syncReverbSlidersToPreset(type);
  });

  // EQ preset grid
  document.querySelectorAll<HTMLElement>('#grid-eq .ch-opt[data-eq-type]').forEach(opt => {
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
  bus.on('ui:sync-eq-preset', (type: string) => {
    syncEqSlidersToPreset(type);
  });

  // EQ sliders
  for (let i = 0; i < 5; i++) {
    $on(`eq-slider-${i}`, 'input', function (this: HTMLInputElement) { if (_isGuestLocked()) return; setEQ(i, Number(this.value), true); });
    $on(`eq-slider-${i}`, 'change', function (this: HTMLInputElement) { if (_isGuestLocked()) return; setEQ(i, Number(this.value)); });
    $on(`eq-slider-${i}`, 'dblclick', () => { if (_guardHostCtrl()) return; setEQ(i, 0); const el = document.getElementById(`eq-slider-${i}`) as HTMLInputElement; if (el) el.value = '0'; });
  }

  // Virtual Surround ON/OFF grid
  document.querySelectorAll<HTMLElement>('#grid-surround .ch-opt[data-toggle]').forEach(opt => {
    opt.addEventListener('click', () => { if (_guardHostCtrl()) return; setSurroundOn(opt.dataset.toggle === 'on'); });
  });

  // Virtual Bass ON/OFF grid
  document.querySelectorAll<HTMLElement>('#grid-vbass .ch-opt[data-toggle]').forEach(opt => {
    opt.addEventListener('click', () => { if (_guardHostCtrl()) return; setVBassOn(opt.dataset.toggle === 'on'); });
  });

  // Battery Saver ON/OFF grid
  document.querySelectorAll<HTMLElement>('#grid-battery .ch-opt[data-toggle]').forEach(opt => {
    opt.addEventListener('click', () => setBatterySaver(opt.dataset.toggle === 'on'));
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
  bus.on('ui:sync-reverb-param', (param: string, value: number) => {
    const sliderMap: Record<string, string> = {
      mix: 'reverb-slider', decay: 'reverb-decay-slider', predelay: 'reverb-predelay-slider',
      lowcut: 'reverb-lowcut-slider', highcut: 'reverb-highcut-slider',
    };
    const sliderId = sliderMap[param];
    if (sliderId) {
      const slider = document.getElementById(sliderId) as HTMLInputElement | null;
      if (slider) slider.value = String(value);
    }
    formatReverbValDisp(param, value);

    // Sync preset chip: detect if current values match a named preset
    const detected = detectReverbPreset();
    clearReverbChipActive();
    document.querySelector(`#grid-reverb .ch-opt[data-rvb-type="${detected}"]`)?.classList.add('active');
    setReverbSlidersVisible(detected === 'advanced');
  });

  // Surround toggle sync (from host broadcast)
  bus.on('ui:sync-surround', (on: boolean) => {
    document.querySelectorAll('#grid-surround .ch-opt[data-toggle]').forEach(el => el.classList.remove('active'));
    document.querySelector(`#grid-surround .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)?.classList.add('active');
  });

  // Virtual Bass toggle sync (from host broadcast)
  bus.on('ui:sync-vbass', (on: boolean) => {
    document.querySelectorAll('#grid-vbass .ch-opt[data-toggle]').forEach(el => el.classList.remove('active'));
    document.querySelector(`#grid-vbass .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)?.classList.add('active');
  });

  // EQ band slider/label sync (from audio module via bus, avoids audio→DOM coupling)
  bus.on('ui:sync-eq-band', (bandIdx: number, value: number) => {
    _setDisp(`eq-val-${bandIdx}`, value > 0 ? `+${value}` : String(value));
    const slider = document.getElementById(`eq-slider-${bandIdx}`) as HTMLInputElement | null;
    if (slider && parseFloat(slider.value) !== value) slider.value = String(value);
  });

  // ─── Host-Ctrl Lock UI update on role change ──────────────────

  // Update lock state when connection/role changes (fires on connect, OP grant/revoke, session start)
  bus.on('network:role-badge-update', () => _updateHostCtrlLockUI());

  // Device list events
  bus.on('network:device-list-update', (list: unknown[]) => {
    if (Array.isArray(list)) renderDeviceList(list as Array<Record<string, unknown>>);
  });

  // Initial theme: restore from localStorage (defaults to dark; 'system' auto-resolves)
  try {
    const savedTheme = localStorage.getItem('musixquare-theme');
    setTheme(savedTheme || 'dark');
  } catch { setTheme('dark'); }

  // Restore battery saver state
  try {
    if (localStorage.getItem('musixquare-battery-saver') === '1') setBatterySaver(true);
  } catch { /* ignore */ }

  // ─── Desktop Settings Sub-Tab Navigation ──────────────────────
  initSettingsSubtabs();

  log.info('[Settings] Initialized');
}

// ─── Settings Sub-Tab Switching (Desktop) ─────────────────────────

function initSettingsSubtabs(): void {
  document.querySelectorAll<HTMLElement>('.subtab-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const subtab = btn.dataset.subtab;
      if (subtab) switchSettingsSubtab(subtab);
    });
  });
}

function switchSettingsSubtab(id: string): void {
  document.querySelectorAll<HTMLElement>('.subtab-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.subtab === id),
  );
  document.querySelectorAll<HTMLElement>('.settings-subtab-panel').forEach(p =>
    p.classList.toggle('active', p.dataset.panel === id),
  );
}

/**
 * MUSIXQUARE 2.0 — Settings Panel (UI)
 * Extracted from original app.js
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

// ─── Cached Listeners (for cleanup on reinit) ────────────────────
let _themeChangeHandler: (() => void) | null = null;

// ─── Theme ───────────────────────────────────────────────────────

export function setTheme(mode: string): void {
  document.querySelectorAll('.theme-opt').forEach(el => el.classList.remove('active'));
  const id = mode === 'light' ? 'theme-light' : mode === 'dark' ? 'theme-dark' : 'theme-system';
  document.getElementById(id)?.classList.add('active');

  // Sliding pill
  const pillIndex = mode === 'light' ? 0 : mode === 'dark' ? 1 : 2;
  document.querySelectorAll<HTMLElement>('.theme-selector').forEach(sel => {
    sel.style.setProperty('--pill-index', String(pillIndex));
  });

  let resolved = mode;
  if (mode === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', resolved);

  // Persist preference
  try { localStorage.setItem('musixquare-theme', mode); } catch { /* ignore */ }

  // Update meta tags for PWA/browser integration
  document.documentElement.style.colorScheme = resolved;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', resolved === 'dark' ? '#000000' : '#f2f2f7');
  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (schemeMeta) schemeMeta.setAttribute('content', resolved);
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

  // Show woofer cutoff slider only when subwoofer (mode 2) is selected
  const wooferCtrl = document.getElementById('woofer-cutoff-control');
  if (wooferCtrl) {
    if (mode === 2) {
      wooferCtrl.classList.remove('collapsed');
    } else {
      wooferCtrl.classList.add('collapsed');
    }
  }
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
      _setDisp('val-rvb-decay', v + 's');
      break;
    case 'predelay':
      _setDisp('val-rvb-predelay', v + 's');
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

function resetReverb(): void {
  bus.emit('audio:reset-reverb');
  // Reset slider UI
  const defaults: Record<string, number> = {
    'reverb-slider': 0,
    'reverb-decay-slider': 5.0,
    'reverb-predelay-slider': 0.1,
    'reverb-lowcut-slider': 0,
    'reverb-highcut-slider': 0,
  };
  for (const [id, val] of Object.entries(defaults)) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = String(val);
  }
  // Reset value displays
  _setDisp('val-reverb', '0%');
  _setDisp('val-rvb-decay', '5.0s');
  _setDisp('val-rvb-predelay', '0.1s');
  _setDisp('val-rvb-lowcut', '20Hz');
  _setDisp('val-rvb-highcut', '20.0kHz');
  // Clear chip active state + hide sliders, activate Off
  clearReverbChipActive();
  document.querySelector('#grid-reverb .ch-opt[data-rvb-type="off"]')?.classList.add('active');
  setReverbSlidersVisible(false);
}

// ─── Reverb Preset Chips ───────────────────────────────────────

const REVERB_PRESETS: Record<string, { mix: number; decay: number; predelay: number }> = {
  studio:  { mix: 30, decay: 1.0, predelay: 0.02 },
  arena: { mix: 40, decay: 5.0, predelay: 0.12 },
};

function clearReverbChipActive(): void {
  document.querySelectorAll('#grid-reverb .ch-opt').forEach(el => el.classList.remove('active'));
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
    // Off: reset reverb, hide sliders
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
  if (mixSlider) mixSlider.value = String(preset.mix);
  if (decaySlider) decaySlider.value = String(preset.decay);
  if (predelaySlider) predelaySlider.value = String(preset.predelay);

  // Update value displays
  formatReverbValDisp('mix', preset.mix);
  formatReverbValDisp('decay', preset.decay);
  formatReverbValDisp('predelay', preset.predelay);

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
  document.querySelectorAll('#grid-surround .ch-opt').forEach(el => el.classList.remove('active'));
  document.querySelector(`#grid-surround .ch-opt[data-toggle="${on ? 'on' : 'off'}"]`)?.classList.add('active');
  // ON: 120%, OFF: 100%
  bus.emit('audio:update-effect', 'stereo', 'mix', on ? 120 : 100, false);
  if (on) bus.emit('ui:show-toast', t('toast.distortion_warn'));
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
    const statusText = p.status === 'connected' ? 'Connected' : 'Disconnected';

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
        opBtn.textContent = p.isOp ? 'REVOKE' : 'GRANT';

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

  // Theme
  $on('theme-light', 'click', () => setTheme('light'));
  $on('theme-dark', 'click', () => setTheme('dark'));
  $on('theme-system', 'click', () => setTheme('system'));

  // Language
  $on('lang-ko', 'click', () => setLanguageMode('ko'));
  $on('lang-en', 'click', () => setLanguageMode('en'));
  $on('lang-system', 'click', () => setLanguageMode('system'));

  // Channel grid (standard)
  document.querySelectorAll<HTMLElement>('#grid-standard .ch-opt[data-ch]').forEach(el => {
    el.addEventListener('click', () => setChannel(parseInt(el.dataset.ch!, 10)));
  });

  // Surround toggle
  $on('btn-surround-toggle', 'click', () => {
    const current = getState('audio.isSurroundMode');
    bus.emit('audio:toggle-surround', !current);

    // Toggle UI grid visibility
    const stdGrid = document.getElementById('grid-standard');
    const surrGrid = document.getElementById('grid-surround');
    if (stdGrid) stdGrid.style.display = !current ? 'none' : '';
    if (surrGrid) surrGrid.style.display = !current ? '' : 'none';

    // Toggle button active state
    const btn = document.getElementById('btn-surround-toggle');
    if (btn) btn.classList.toggle('active', !current);
  });

  // Surround channel grid buttons
  document.querySelectorAll<HTMLElement>('#grid-surround .ch-opt[data-surround-ch]').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.surroundCh!, 10);
      bus.emit('audio:set-surround-channel', idx);

      // Highlight active button
      document.querySelectorAll('#grid-surround .ch-opt[data-surround-ch]').forEach(
        e => e.classList.remove('active'),
      );
      el.classList.add('active');
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
      syncEqSlidersToPreset(type);
      if (type === 'off') {
        resetEQ();
      } else if (type !== 'advanced') {
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

  // ─── Host-Ctrl Lock UI update on role change ──────────────────

  // Update lock state when connection/role changes (fires on connect, OP grant/revoke, session start)
  bus.on('network:role-badge-update', () => _updateHostCtrlLockUI());

  // Device list events
  bus.on('network:device-list-update', (list: unknown[]) => {
    if (Array.isArray(list)) renderDeviceList(list as Array<Record<string, unknown>>);
  });

  // Theme: listen for system change (with cleanup for reinit safety)
  try {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    if (_themeChangeHandler) mql.removeEventListener('change', _themeChangeHandler);
    _themeChangeHandler = () => {
      const themeSystem = document.getElementById('theme-system');
      if (themeSystem?.classList.contains('active')) {
        setTheme('system');
      }
    };
    mql.addEventListener('change', _themeChangeHandler);
  } catch { /* ignore */ }

  // Initial theme: restore from localStorage or default to system
  const savedTheme = localStorage.getItem('musixquare-theme');
  setTheme(savedTheme || 'system');

  log.info('[Settings] Initialized');
}

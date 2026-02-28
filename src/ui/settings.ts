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
import { setLanguageMode } from '../i18n/index.ts';

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
}

function setChannel(mode: number): void {
  selectStandardChannelButton(mode);
  bus.emit('audio:set-channel-mode', mode);
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
  else if (type === 'stereo') _setDisp('val-width', value + '%');
  else if (type === 'vbass') _setDisp('val-vbass', value + '%');

  bus.emit('audio:update-effect', type, param, value, isPreview);
}

function setPreamp(value: number, isPreview = false): void {
  _setDisp('val-preamp', (value > 0 ? '+' : '') + value + 'dB');
  bus.emit('audio:set-preamp', value, isPreview);
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
}

function resetEQ(): void {
  bus.emit('audio:reset-eq');
  // Reset slider UI
  const preamp = document.getElementById('preamp-slider') as HTMLInputElement | null;
  if (preamp) preamp.value = '0';
  _setDisp('val-preamp', '0dB');
  for (let i = 0; i < 5; i++) {
    const eq = document.getElementById(`eq-slider-${i}`) as HTMLInputElement | null;
    if (eq) eq.value = '0';
    _setDisp(`eq-val-${i}`, '0');
  }
}

function resetStereo(): void {
  bus.emit('audio:reset-stereo');
  const el = document.getElementById('width-slider') as HTMLInputElement | null;
  if (el) el.value = '100';
  _setDisp('val-width', '100%');
}

function resetVBass(): void {
  bus.emit('audio:reset-vbass');
  const el = document.getElementById('vbass-slider') as HTMLInputElement | null;
  if (el) el.value = '0';
  _setDisp('val-vbass', '0%');
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

  // Reverb
  $on('btn-reset-reverb', 'click', () => resetReverb());
  const reverbSliders = [
    { id: 'reverb-slider', param: 'mix', resetVal: 0 },
    { id: 'reverb-decay-slider', param: 'decay', resetVal: 5.0 },
    { id: 'reverb-predelay-slider', param: 'predelay', resetVal: 0.1 },
    { id: 'reverb-lowcut-slider', param: 'lowcut', resetVal: 0 },
    { id: 'reverb-highcut-slider', param: 'highcut', resetVal: 0 },
  ];
  reverbSliders.forEach(({ id, param, resetVal }) => {
    $on(id, 'input', function (this: HTMLInputElement) { updateAudioEffect('reverb', param, Number(this.value), true); });
    $on(id, 'change', function (this: HTMLInputElement) { updateAudioEffect('reverb', param, Number(this.value)); });
    $on(id, 'dblclick', function (this: HTMLInputElement) { updateAudioEffect('reverb', param, resetVal); this.value = String(resetVal); });
  });

  // EQ
  $on('btn-reset-eq', 'click', () => resetEQ());
  $on('preamp-slider', 'input', function (this: HTMLInputElement) { setPreamp(Number(this.value), true); });
  $on('preamp-slider', 'change', function (this: HTMLInputElement) { setPreamp(Number(this.value)); });
  $on('preamp-slider', 'dblclick', () => { setPreamp(0); const el = document.getElementById('preamp-slider') as HTMLInputElement; if (el) el.value = '0'; });
  for (let i = 0; i < 5; i++) {
    $on(`eq-slider-${i}`, 'input', function (this: HTMLInputElement) { setEQ(i, Number(this.value), true); });
    $on(`eq-slider-${i}`, 'change', function (this: HTMLInputElement) { setEQ(i, Number(this.value)); });
    $on(`eq-slider-${i}`, 'dblclick', () => { setEQ(i, 0); const el = document.getElementById(`eq-slider-${i}`) as HTMLInputElement; if (el) el.value = '0'; });
  }

  // Stereo Width
  $on('btn-reset-stereo', 'click', () => resetStereo());
  $on('width-slider', 'input', function (this: HTMLInputElement) { updateAudioEffect('stereo', 'mix', Number(this.value), true); });
  $on('width-slider', 'change', function (this: HTMLInputElement) { updateAudioEffect('stereo', 'mix', Number(this.value)); });
  $on('width-slider', 'dblclick', () => resetStereo());

  // Virtual Bass
  $on('btn-reset-vbass', 'click', () => resetVBass());
  $on('vbass-slider', 'input', function (this: HTMLInputElement) { updateAudioEffect('vbass', 'mix', Number(this.value), true); });
  $on('vbass-slider', 'change', function (this: HTMLInputElement) { updateAudioEffect('vbass', 'mix', Number(this.value)); });
  $on('vbass-slider', 'dblclick', () => { updateAudioEffect('vbass', 'mix', 0); const el = document.getElementById('vbass-slider') as HTMLInputElement; if (el) el.value = '0'; });

  // Manual sync popup
  $on('btn-nudge-minus10', 'click', () => bus.emit('sync:nudge', -10));
  $on('btn-nudge-minus1', 'click', () => bus.emit('sync:nudge', -1));
  $on('btn-nudge-plus1', 'click', () => bus.emit('sync:nudge', 1));
  $on('btn-nudge-plus10', 'click', () => bus.emit('sync:nudge', 10));
  $on('btn-auto-sync', 'click', () => bus.emit('sync:auto-sync'));
  $on('btn-sync-done', 'click', () => bus.emit('sync:close-manual'));

  // Device list events
  bus.on('network:device-list-update', (list: unknown[]) => {
    if (Array.isArray(list)) renderDeviceList(list as Array<Record<string, unknown>>);
  });

  // Theme: listen for system change
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const themeSystem = document.getElementById('theme-system');
      if (themeSystem?.classList.contains('active')) {
        setTheme('system');
      }
    });
  } catch { /* ignore */ }

  // Initial theme: restore from localStorage or default to system
  const savedTheme = localStorage.getItem('musixquare-theme');
  setTheme(savedTheme || 'system');

  log.info('[Settings] Initialized');
}

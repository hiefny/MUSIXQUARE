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
import { MSG } from '../core/constants.ts';
import { showToast } from './toast.ts';
import { setLanguageMode } from './i18n.ts';
import { getRoleLabelByChannelMode } from './player-controls.ts';
import type { DataConnection } from '../types/index.ts';

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
}

// ─── Channel Mode (Standard) ─────────────────────────────────────

export function selectStandardChannelButton(mode: number): void {
  const all = document.querySelectorAll('#grid-standard .ch-opt[data-ch]');
  all.forEach(e => e.classList.remove('active'));
  const el = document.querySelector(`#grid-standard .ch-opt[data-ch="${mode}"]`);
  if (el) el.classList.add('active');
}

function setChannel(mode: number, el: Element): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) {
    showToast('역할이 자동 설정되어 변경할 수 없어요.');
    return;
  }

  selectStandardChannelButton(mode);
  bus.emit('audio:set-channel-mode', mode);
}

// ─── Audio Effects Helpers ────────────────────────────────────────

function updateAudioEffect(type: string, param: string, value: unknown, isPreview = false): void {
  bus.emit('audio:update-effect', type, param, value, isPreview);
}

function setPreamp(value: unknown, isPreview = false): void {
  bus.emit('audio:set-preamp', value, isPreview);
}

function setEQ(band: number, value: unknown, isPreview = false): void {
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
}

function resetEQ(): void {
  bus.emit('audio:reset-eq');
  // Reset slider UI
  const preamp = document.getElementById('preamp-slider') as HTMLInputElement | null;
  if (preamp) preamp.value = '0';
  for (let i = 0; i < 5; i++) {
    const eq = document.getElementById(`eq-slider-${i}`) as HTMLInputElement | null;
    if (eq) eq.value = '0';
  }
}

function resetStereo(): void {
  bus.emit('audio:reset-stereo');
  const el = document.getElementById('width-slider') as HTMLInputElement | null;
  if (el) el.value = '100';
}

function resetVBass(): void {
  bus.emit('audio:reset-vbass');
  const el = document.getElementById('vbass-slider') as HTMLInputElement | null;
  if (el) el.value = '0';
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
    shortId.textContent = `(${String(p.id || '').substr(-4)})`;
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

    const hostConn = getState<DataConnection | null>('network.hostConn');
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

  // Channel grid
  document.querySelectorAll<HTMLElement>('#grid-standard .ch-opt[data-ch]').forEach(el => {
    el.addEventListener('click', () => setChannel(parseInt(el.dataset.ch!, 10), el));
  });

  // Subwoofer cutoff
  $on('cutoff-slider', 'input', function (this: HTMLInputElement) { bus.emit('audio:update-effect', 'cutoff', 'value', this.value, true); });
  $on('cutoff-slider', 'dblclick', function (this: HTMLInputElement) { bus.emit('audio:update-effect', 'cutoff', 'value', 120); this.value = '120'; });

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
    $on(id, 'input', function (this: HTMLInputElement) { updateAudioEffect('reverb', param, this.value, true); });
    $on(id, 'change', function (this: HTMLInputElement) { updateAudioEffect('reverb', param, this.value); });
    $on(id, 'dblclick', function (this: HTMLInputElement) { updateAudioEffect('reverb', param, resetVal); this.value = String(resetVal); });
  });

  // EQ
  $on('btn-reset-eq', 'click', () => resetEQ());
  $on('preamp-slider', 'input', function (this: HTMLInputElement) { setPreamp(this.value, true); });
  $on('preamp-slider', 'change', function (this: HTMLInputElement) { setPreamp(this.value); });
  $on('preamp-slider', 'dblclick', () => { setPreamp(0); const el = document.getElementById('preamp-slider') as HTMLInputElement; if (el) el.value = '0'; });
  for (let i = 0; i < 5; i++) {
    $on(`eq-slider-${i}`, 'input', function (this: HTMLInputElement) { setEQ(i, this.value, true); });
    $on(`eq-slider-${i}`, 'change', function (this: HTMLInputElement) { setEQ(i, this.value); });
    $on(`eq-slider-${i}`, 'dblclick', () => { setEQ(i, 0); const el = document.getElementById(`eq-slider-${i}`) as HTMLInputElement; if (el) el.value = '0'; });
  }

  // Stereo Width
  $on('btn-reset-stereo', 'click', () => resetStereo());
  $on('width-slider', 'input', function (this: HTMLInputElement) { updateAudioEffect('stereo', 'mix', this.value, true); });
  $on('width-slider', 'change', function (this: HTMLInputElement) { updateAudioEffect('stereo', 'mix', this.value); });
  $on('width-slider', 'dblclick', () => resetStereo());

  // Virtual Bass
  $on('btn-reset-vbass', 'click', () => resetVBass());
  $on('vbass-slider', 'input', function (this: HTMLInputElement) { updateAudioEffect('vbass', 'mix', this.value, true); });
  $on('vbass-slider', 'change', function (this: HTMLInputElement) { updateAudioEffect('vbass', 'mix', this.value); });
  $on('vbass-slider', 'dblclick', () => { updateAudioEffect('vbass', 'mix', 0); const el = document.getElementById('vbass-slider') as HTMLInputElement; if (el) el.value = '0'; });

  // Manual sync popup
  $on('btn-nudge-minus10', 'click', () => bus.emit('sync:nudge', -10));
  $on('btn-nudge-minus1', 'click', () => bus.emit('sync:nudge', -1));
  $on('btn-nudge-plus1', 'click', () => bus.emit('sync:nudge', 1));
  $on('btn-nudge-plus10', 'click', () => bus.emit('sync:nudge', 10));
  $on('btn-auto-sync', 'click', () => bus.emit('sync:auto-sync'));
  $on('btn-sync-done', 'click', () => bus.emit('sync:close-manual'));

  // Device list events
  bus.on('network:device-list-update', ((...args: unknown[]) => {
    const list = args[0] as Array<Record<string, unknown>>;
    if (Array.isArray(list)) renderDeviceList(list);
  }) as (...args: unknown[]) => void);

  // Theme: listen for system change
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const themeSystem = document.getElementById('theme-system');
      if (themeSystem?.classList.contains('active')) {
        setTheme('system');
      }
    });
  } catch { /* ignore */ }

  // Initial theme: system
  setTheme('system');

  log.info('[Settings] Initialized');
}

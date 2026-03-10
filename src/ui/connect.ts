/**
 * MUSIXQUARE 2.0 — Connect Tab (UI)
 *
 * Manages: QR code generation for session joining, max-device slider,
 * connected device list rendering (mobile + desktop sub-panel).
 */

import QRCode from 'qrcode';
import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MIN_GUEST_SLOTS, MAX_GUEST_SLOTS_LIMIT } from '../core/constants.ts';
import { t, getResolvedLanguage } from '../i18n/index.ts';
import { showDialog } from './dialog.ts';

// ─── Host-Ctrl Lock (shared pattern) ────────────────────────────

function _isGuestLocked(): boolean {
  const hostConn = getState('network.hostConn');
  if (!hostConn) return false;
  return !getState('network.isOperator');
}

function _guardHostCtrl(): boolean {
  if (_isGuestLocked()) {
    bus.emit('ui:show-toast', t('toast.operator_required'));
    return true;
  }
  return false;
}

// ─── QR Code Generation ─────────────────────────────────────────

async function generateQR(containerId: string): Promise<void> {
  const container = document.getElementById(containerId);
  if (!container) return;

  const sessionCode = getState('network.sessionCode') || '';
  const sessionStarted = getState('setup.sessionStarted');

  if (!sessionStarted || !sessionCode || !/^\d{6}$/.test(sessionCode)) {
    container.innerHTML = `<p class="qr-placeholder">${t('connect.no_session')}</p>`;
    return;
  }

  container.innerHTML = `<p class="qr-placeholder">${t('connect.generating_qr')}</p>`;

  try {
    const base = `${location.origin}${location.pathname}`;
    const url = `${base}?join=${sessionCode}`;

    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, url, {
      width: 200,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });

    container.innerHTML = '';
    container.appendChild(canvas);
  } catch (e) {
    log.warn('[Connect] QR generation failed', e);
    container.innerHTML = `<p class="qr-placeholder">${t('connect.no_session')}</p>`;
  }
}

function refreshAllQR(): void {
  generateQR('qr-container');
  generateQR('desktop-qr-container');
}

// ─── Max Device Stepper (−  N  +) ───────────────────────────────

const VALUE_IDS = ['max-device-value', 'desktop-max-device-value'];

function _applyValue(value: number): void {
  const clamped = Math.max(MIN_GUEST_SLOTS, Math.min(MAX_GUEST_SLOTS_LIMIT, value));
  const cur = getState('network.maxGuestSlots') ?? 3;

  // Prevent reducing below current connected device count
  const peers = (getState('network.connectedPeers') as unknown[]) || [];
  if (clamped < peers.length && clamped < cur) {
    bus.emit('ui:show-toast', t('connect.cannot_reduce', { count: peers.length }));
    syncAllValues(cur);  // revert display
    return;
  }

  syncAllValues(clamped);
  if (clamped !== cur) bus.emit('network:max-guests-changed', clamped);
}

function initStepper(stepperId: string): void {
  const stepper = document.getElementById(stepperId);
  if (!stepper) return;

  const current = getState('network.maxGuestSlots') ?? 3;
  syncAllValues(current);

  // +/- button clicks
  stepper.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.stepper-btn') as HTMLElement | null;
    if (!btn) return;

    if (_guardHostCtrl()) return;

    const dir = parseInt(btn.dataset.dir || '0', 10);
    const cur = getState('network.maxGuestSlots') ?? 3;
    _applyValue(cur + dir);
  });

  // Tap on value → inline input
  stepper.addEventListener('click', (e) => {
    const span = (e.target as HTMLElement).closest('.stepper-value') as HTMLElement | null;
    if (!span || span.querySelector('input')) return;
    if (_guardHostCtrl()) return;

    const cur = getState('network.maxGuestSlots') ?? 3;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'stepper-input';
    input.inputMode = 'numeric';
    input.min = String(MIN_GUEST_SLOTS);
    input.max = String(MAX_GUEST_SLOTS_LIMIT);
    input.value = String(cur);

    span.textContent = '';
    span.classList.add('editing');
    span.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const raw = parseInt(input.value, 10);
      // Remove input, restore span text before syncing
      span.classList.remove('editing');
      if (input.parentNode) input.remove();
      if (!isNaN(raw)) _applyValue(raw);
      else syncAllValues(cur);  // restore on invalid
    };

    input.addEventListener('blur', () => {
      commit();
    }, { once: true });

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { input.blur(); }
      if (ev.key === 'Escape') { input.value = ''; input.blur(); }
    });
  });
}

function syncAllValues(value: number): void {
  VALUE_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  });
  // Update disabled state on all stepper buttons
  document.querySelectorAll<HTMLButtonElement>('.stepper-btn[data-dir="-1"]').forEach(btn => {
    btn.disabled = value <= MIN_GUEST_SLOTS;
  });
  document.querySelectorAll<HTMLButtonElement>('.stepper-btn[data-dir="1"]').forEach(btn => {
    btn.disabled = value >= MAX_GUEST_SLOTS_LIMIT;
  });
}

// ─── Device List Rendering ──────────────────────────────────────

let _lastDeviceCount = 0;

function _updateDeviceTitles(): void {
  const titleText = _deviceListTitle(_lastDeviceCount);
  ['connect-device-title', 'desktop-device-title'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = titleText;
  });
}

function _deviceListTitle(count: number): string {
  if (count === 1 && getResolvedLanguage() === 'en') {
    return t('connect.device_list_one', { count });
  }
  return t('connect.device_list', { count });
}

function renderConnectDeviceList(list: Array<Record<string, unknown>>): void {
  _lastDeviceCount = list.length;
  _updateDeviceTitles();

  const containers = [
    document.getElementById('connect-device-list'),
    document.getElementById('desktop-device-list'),
  ].filter(Boolean) as HTMLElement[];

  containers.forEach(container => {
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
      const statusText = p.status === 'connected' ? t('connect.status_connected') : t('connect.status_disconnected');

      const status = document.createElement('span');
      status.className = `d-status ${statusClass}`;
      status.textContent = statusText;

      row.appendChild(name);

      const hostConn = getState('network.hostConn');
      if (hostConn) {
        // Guest view — just show status
        row.appendChild(status);
      } else {
        // Host view — show OP grant/revoke button
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

        // Kick button (non-host, connected peers only)
        if (!p.isHost && p.status === 'connected') {
          const kickBtn = document.createElement('button');
          kickBtn.type = 'button';
          kickBtn.className = 'btn-kick-device';
          kickBtn.dataset.kickPeer = String(p.id || '');
          kickBtn.setAttribute('aria-label', t('connect.kick_title'));
          kickBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

          kickBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const peerId = kickBtn.dataset.kickPeer;
            if (!peerId) return;
            const result = await showDialog({
              title: t('connect.kick_title'),
              message: t('connect.kick_message'),
              buttonText: t('connect.kick_yes'),
              secondaryText: t('connect.kick_no'),
            });
            if (result.action !== 'ok') return;
            bus.emit('network:kick-device', peerId);
          });

          right.appendChild(kickBtn);
        }

        row.appendChild(right);
      }

      container.appendChild(row);
    });
  });
}

// ─── Init ───────────────────────────────────────────────────────

export function initConnect(): void {
  // Init both sliders (mobile + desktop)
  // Init both steppers (mobile + desktop)
  initStepper('max-device-stepper');
  initStepper('desktop-max-device-stepper');

  // QR refresh when connect tab is opened
  bus.on('ui:connect-tab-opened', () => {
    refreshAllQR();
  });

  // QR refresh when session starts (sessionCode changes)
  bus.on('ui:settings-tab-opened', () => {
    // Desktop sub-tab may show connect panel — refresh QR
    refreshAllQR();
  });

  // Set initial device count title
  _updateDeviceTitles();

  // Re-render title on language change
  new MutationObserver(() => _updateDeviceTitles())
    .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  // Device list updates → render in connect containers
  bus.on('network:device-list-update', (list: unknown[]) => {
    if (Array.isArray(list)) {
      renderConnectDeviceList(list as Array<Record<string, unknown>>);
    }
  });

  // Session code changes → refresh QR
  bus.on('state:network.sessionCode', () => {
    refreshAllQR();
  });

  // Session started → refresh QR (code is set before sessionStarted becomes true)
  bus.on('state:setup.sessionStarted', () => {
    refreshAllQR();
  });

  // Initial render
  refreshAllQR();

  log.info('[Connect] Initialized');
}

/**
 * MUSIXQUARE 3.0 — Connect Tab (UI)
 *
 * Manages: QR code generation for session joining, max-device slider,
 * connected device list rendering (mobile + desktop sub-panel).
 */

import QRCode from 'qrcode';
import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MIN_GUEST_SLOTS, MAX_GUEST_SLOTS_LIMIT, RESERVED_NAMES } from '../core/constants.ts';
import { t, getResolvedLanguage } from '../i18n/index.ts';
import { showDialog } from './dialog.ts';
import { containsProfanity } from '../chat/profanity.ts';

let _langObserver: MutationObserver | null = null;

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

const _qrGeneration = new Map<string, number>();

async function generateQR(containerId: string): Promise<void> {
  const gen = (_qrGeneration.get(containerId) ?? 0) + 1;
  _qrGeneration.set(containerId, gen);

  const container = document.getElementById(containerId);
  if (!container) return;

  const sessionCode = getState('network.sessionCode') || '';
  const sessionStarted = getState('setup.sessionStarted');

  if (!sessionStarted || !sessionCode || !/^\d{6}$/.test(sessionCode)) {
    const p = document.createElement('p');
    p.className = 'qr-placeholder';
    p.textContent = t('connect.no_session');
    container.replaceChildren(p);
    return;
  }

  const loadingP = document.createElement('p');
  loadingP.className = 'qr-placeholder';
  loadingP.textContent = t('connect.generating_qr');
  container.replaceChildren(loadingP);

  try {
    const base = `${location.origin}${location.pathname}`;
    const url = `${base}?join=${sessionCode}`;

    // Generate SVG string — transparent background, currentColor-friendly
    const svgString = await QRCode.toString(url, {
      type: 'svg',
      margin: 2,
      color: {
        dark: '#000000',
        light: '#00000000',  // Fully transparent background
      },
    });

    // Discard stale result if another generateQR call started for this container
    if (_qrGeneration.get(containerId) !== gen) return;

    container.innerHTML = svgString;

    // Apply CSS class for theme-aware coloring
    const svg = container.querySelector('svg');
    if (svg) {
      svg.classList.add('qr-svg');
      svg.removeAttribute('width');
      svg.removeAttribute('height');
    }

    // Copy invite link button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-copy-invite-link';
    copyBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg><span data-i18n="connect.copy_invite_link">${t('connect.copy_invite_link')}</span>`;
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        bus.emit('ui:show-toast', t('connect.link_copied'));
      } catch {
        bus.emit('ui:show-toast', t('toast.copy_failed'));
      }
    });
    container.appendChild(copyBtn);
  } catch (e) {
    if (_qrGeneration.get(containerId) !== gen) return;
    log.warn('[Connect] QR generation failed', e);
    const errP = document.createElement('p');
    errP.className = 'qr-placeholder';
    errP.textContent = t('connect.no_session');
    container.replaceChildren(errP);
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

  // Prevent reducing below current connected device count (only count peers with open connections)
  const allPeers = getState('network.connectedPeers') || [];
  const peers = allPeers.filter(p => p.conn?.open !== false);
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
      row.className = 'device-row';

      // Join order number (replaces old status dot)
      const orderBadge = document.createElement('span');
      orderBadge.className = 'd-order';
      const idx = typeof p.joinOrder === 'number' ? p.joinOrder : '?';
      orderBadge.textContent = `${idx}`;
      row.appendChild(orderBadge);

      // Device name + short ID + OP badge
      const name = document.createElement('span');
      name.className = 'd-name';
      name.textContent = String(p.label || t('common.peer'));


      if (p.isOp) {
        const op = document.createElement('span');
        op.className = 'd-op-badge';
        op.textContent = 'OP';
        name.appendChild(document.createTextNode(' '));
        name.appendChild(op);
      }

      row.appendChild(name);

      // Action buttons (host view only, non-host peers only)
      const hostConn = getState('network.hostConn');
      if (!hostConn && !p.isHost && p.status === 'connected') {
        const actions = document.createElement('div');
        actions.className = 'd-actions';

        const opBtn = document.createElement('button');
        opBtn.className = `d-op-btn ${p.isOp ? 'active' : ''}`;
        opBtn.dataset.opPeer = String(p.id || '');
        opBtn.textContent = p.isOp ? t('common.revoke') : t('common.grant');
        opBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const peerId = opBtn.dataset.opPeer;
          if (peerId) bus.emit('network:toggle-operator', peerId);
        });
        actions.appendChild(opBtn);

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
        actions.appendChild(kickBtn);

        row.appendChild(actions);
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

  // Re-render title on language change (disconnect previous on re-init)
  if (_langObserver) _langObserver.disconnect();
  _langObserver = new MutationObserver(() => _updateDeviceTitles());
  _langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

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

  // Leave Session buttons (mobile + desktop)
  const leaveHandler = () => {
    showDialog({
      title: t('dialog.return_home_title'),
      message: `${t('dialog.return_home_msg')}\n${t('dialog.return_home_detail')}`,
      buttonText: t('common.ok'),
      secondaryText: t('common.cancel'),
    }).then(res => {
      if (res && res.action === 'ok') {
        bus.emit('ui:show-loader', true, t('dialog.leaving_session'));
        setTimeout(() => window.location.reload(), 300);
      }
    });
  };
  document.getElementById('btn-leave-session')?.addEventListener('click', leaveHandler);
  document.getElementById('desktop-btn-leave-session')?.addEventListener('click', leaveHandler);

  // Rename Device buttons (mobile + desktop)
  const renameHandler = async () => {
    const currentLabel = getState('network.myDeviceLabel') || '';
    const isDefault = currentLabel === 'HOST' || currentLabel.startsWith('Peer');
    const result = await showDialog({
      title: t('connect.rename_title'),
      message: t('connect.rename_message'),
      inputField: {
        placeholder: t('connect.rename_placeholder'),
        defaultValue: isDefault ? '' : currentLabel,
        maxLength: 20,
        hint: `${t('connect.rename_current')}: ${currentLabel}`,
        validator: (val) => {
          const name = val.trim();
          if (!name) return t('connect.rename_reserved');
          const isHostSelf = !getState('network.hostConn');
          if (RESERVED_NAMES.some(r => name.toLowerCase() === r.toLowerCase())) {
            // HOST가 "host"/"방장"/"호스트"로 되돌리는 건 허용
            if (!isHostSelf || !['host', '방장', '호스트'].includes(name.toLowerCase())) {
              return t('connect.rename_reserved');
            }
          }
          if (/^#\d+$/.test(name)) {
            return t('connect.rename_reserved');
          }
          // HOST가 "host"/"방장"/"호스트"로 되돌릴 때는 profanity 체크 스킵
          const isHostRestore = isHostSelf && ['host', '방장', '호스트'].includes(name.toLowerCase());
          if (!isHostRestore && containsProfanity(name)) {
            return t('connect.rename_profanity');
          }
          // Check against host's own label + all peers
          const hostLabel = getState('network.myDeviceLabel') || '';
          if (hostLabel && name.toLowerCase() === hostLabel.toLowerCase() && name !== currentLabel) {
            return t('connect.rename_duplicate');
          }
          const peers = getState('network.connectedPeers') || [];
          if (peers.some(p => p.label.toLowerCase() === name.toLowerCase())) {
            return t('connect.rename_duplicate');
          }
          return null;
        },
      },
      buttonText: t('common.ok'),
      secondaryText: t('common.cancel'),
    });
    if (result.action !== 'ok') return;
    const newName = (result.inputValue || '').trim();
    if (!newName || newName.length > 20) return;
    bus.emit('network:rename-device', newName);
  };
  document.getElementById('btn-rename-device')?.addEventListener('click', renameHandler);
  document.getElementById('desktop-btn-rename-device')?.addEventListener('click', renameHandler);

  // Initial render
  refreshAllQR();

  log.info('[Connect] Initialized');
}

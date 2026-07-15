/**
 * MUSIXQUARE — Connect Tab (UI)
 *
 * Manages: QR code generation for session joining, max-device slider,
 * connected device list rendering (mobile + desktop sub-panel).
 */

import QRCode from 'qrcode';
import { log } from '../core/log.ts';
import { bus, createBusScope } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import {
  DEFAULT_MAX_GUEST_SLOTS,
  DEVICE_LABEL_SANITIZE_RE,
  MIN_GUEST_SLOTS,
  MAX_GUEST_SLOTS_LIMIT,
  RESERVED_NAMES,
} from '../core/constants.ts';
import { getOtherDeviceLabels } from '../network/guards.ts';
import { t } from '../i18n/index.ts';
import { showDialog } from './dialog.ts';
import { containsProfanity } from '../chat/profanity.ts';
import { showToast } from './toast.ts';
import { copyTextToClipboard } from './dom.ts';
import { scheduleSessionReset } from '../core/session-reset.ts';

let _langObserver: MutationObserver | null = null;
let _lastDeviceList: Array<Record<string, unknown>> = [];

// ─── Host-Ctrl Lock (shared pattern) ────────────────────────────

function _canEditHostOwnedSetting(): boolean {
  return getState('network.appRole') === 'host' && !getState('network.hostConn');
}

function _guardHostSettingCtrl(): boolean {
  if (!_canEditHostOwnedSetting()) {
    showToast(t('toast.host_setting_required'));
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
    p.setAttribute('data-i18n', 'connect.no_session');
    p.textContent = t('connect.no_session');
    container.replaceChildren(p);
    return;
  }

  const loadingP = document.createElement('p');
  loadingP.className = 'qr-placeholder';
  loadingP.setAttribute('data-i18n', 'connect.generating_qr');
  loadingP.textContent = t('connect.generating_qr');
  container.replaceChildren(loadingP);

  try {
    // QR: uppercase alphanumeric mode for smallest QR
    const qrUrl = `MUSIXQUARE.COM/${sessionCode}`;
    // Clipboard: normal readable URL. Invite OG cards use English copy, so the
    // URL needs no per-host-language query suffix.
    const shareUrl = `${location.origin}/${sessionCode}`;

    // Generate SVG string — transparent background, currentColor-friendly
    const svgString = await QRCode.toString(qrUrl, {
      type: 'svg',
      margin: 2,
      errorCorrectionLevel: 'L',
      color: {
        dark: '#000000',
        light: '#00000000', // Fully transparent background
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
      // Route through copyTextToClipboard so the textarea+execCommand fallback
      // kicks in on insecure contexts (HTTP LAN) and restricted webviews
      // (Toss in-app) where navigator.clipboard may reject or be absent.
      const ok = await copyTextToClipboard(shareUrl);
      showToast(ok ? t('connect.link_copied') : t('toast.copy_failed'));
    });
    container.appendChild(copyBtn);
  } catch (e) {
    if (_qrGeneration.get(containerId) !== gen) return;
    log.warn('[Connect] QR generation failed', e);
    const errP = document.createElement('p');
    errP.className = 'qr-placeholder';
    errP.setAttribute('data-i18n', 'connect.no_session');
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
const HOST_OWNED_SECTION_SELECTORS = ['.room-password-section', '.max-guests-section'];

function _applyValue(value: number): void {
  const clamped = Math.max(MIN_GUEST_SLOTS, Math.min(MAX_GUEST_SLOTS_LIMIT, value));
  const cur = getState('network.maxGuestSlots') ?? DEFAULT_MAX_GUEST_SLOTS;

  // Prevent reducing below current connected device count (only count peers with open connections)
  const allPeers = getState('network.connectedPeers') || [];
  const peers = allPeers.filter((p) => p.conn?.open !== false);
  if (clamped < peers.length && clamped < cur) {
    showToast(t('connect.cannot_reduce', { count: peers.length }));
    syncAllValues(cur); // revert display
    return;
  }

  syncAllValues(clamped);
  if (clamped !== cur) bus.emit('network:max-guests-changed', clamped);
}

function initStepper(stepperId: string): void {
  const stepper = document.getElementById(stepperId);
  if (!stepper) return;

  const current = getState('network.maxGuestSlots') ?? DEFAULT_MAX_GUEST_SLOTS;
  syncAllValues(current);

  // +/- button clicks
  stepper.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.stepper-btn') as HTMLElement | null;
    if (!btn) return;

    if (_guardHostSettingCtrl()) return;

    const dir = parseInt(btn.dataset.dir || '0', 10);
    const cur = getState('network.maxGuestSlots') ?? DEFAULT_MAX_GUEST_SLOTS;
    _applyValue(cur + dir);
  });

  // Tap on value → inline input
  stepper.addEventListener('click', (e) => {
    const span = (e.target as HTMLElement).closest('.stepper-value') as HTMLElement | null;
    if (!span || span.querySelector('input')) return;
    if (_guardHostSettingCtrl()) return;

    const cur = getState('network.maxGuestSlots') ?? DEFAULT_MAX_GUEST_SLOTS;
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
      else syncAllValues(cur); // restore on invalid
    };

    input.addEventListener(
      'blur',
      () => {
        commit();
      },
      { once: true },
    );

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        input.blur();
      }
      if (ev.key === 'Escape') {
        input.value = '';
        input.blur();
      }
    });
  });
}

function syncAllValues(value: number): void {
  VALUE_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  });
  // Update disabled state on all stepper buttons
  document.querySelectorAll<HTMLButtonElement>('.stepper-btn[data-dir="-1"]').forEach((btn) => {
    btn.disabled = value <= MIN_GUEST_SLOTS;
  });
  document.querySelectorAll<HTMLButtonElement>('.stepper-btn[data-dir="1"]').forEach((btn) => {
    btn.disabled = value >= MAX_GUEST_SLOTS_LIMIT;
  });
}

// ─── Room Password ───────────────────────────────────────────────

const ROOM_PASSWORD_TOGGLE_IDS = ['room-password-toggle', 'desktop-room-password-toggle'];
const ROOM_PASSWORD_CODE_ROW_IDS = ['room-password-code-row', 'desktop-room-password-code-row'];
const ROOM_PASSWORD_CODE_IDS = ['room-password-code', 'desktop-room-password-code'];
const ROOM_PASSWORD_REFRESH_IDS = ['room-password-refresh', 'desktop-room-password-refresh'];
const ROOM_PASSWORD_OFF_TEXT = '- - - - - - - -';

function _formatRoomPassword(password: string): string {
  return password.replace(/^(\d{4})(\d{4})$/, '$1-$2');
}

function _canEditRoomPassword(): boolean {
  return _canEditHostOwnedSetting();
}

function _guardRoomPasswordCtrl(): boolean {
  return _guardHostSettingCtrl();
}

function _generateRoomPassword(): string {
  try {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return String(values[0]! % 100_000_000).padStart(8, '0');
  } catch {
    return String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
  }
}

function _applyRoomPassword(password: string | null): void {
  const next = password && /^\d{8}$/.test(password) ? password : '';
  setState('network.roomPasswordRequired', !!next);
  setState('network.roomPassword', next);
  bus.emit('network:room-password-changed', next || null);
  syncRoomPasswordControls();
}

function syncRoomPasswordControls(): void {
  const password = getState('network.roomPassword') || '';
  const active = getState('network.roomPasswordRequired') && /^\d{8}$/.test(password);
  const canEdit = _canEditRoomPassword();

  ROOM_PASSWORD_TOGGLE_IDS.forEach((id) => {
    const toggle = document.getElementById(id) as HTMLButtonElement | null;
    if (!toggle) return;
    toggle.classList.toggle('active', active);
    toggle.setAttribute('aria-pressed', active ? 'true' : 'false');
    toggle.disabled = false;
    toggle.setAttribute('aria-disabled', canEdit ? 'false' : 'true');
    toggle.style.background = active ? 'rgba(var(--primary-rgb), 0.18)' : '';
    const knob = toggle.querySelector('.room-password-toggle-knob') as HTMLElement | null;
    if (knob) {
      knob.style.background = active ? 'var(--primary)' : '';
      knob.style.transform = active ? 'translateX(20px)' : '';
    }
  });

  ROOM_PASSWORD_CODE_ROW_IDS.forEach((id) => {
    const row = document.getElementById(id) as HTMLElement | null;
    if (row) row.hidden = false;
  });

  ROOM_PASSWORD_CODE_IDS.forEach((id) => {
    const code = document.getElementById(id);
    if (!code) return;
    code.textContent = active ? _formatRoomPassword(password) : ROOM_PASSWORD_OFF_TEXT;
    code.classList.toggle('is-placeholder', !active);
  });

  ROOM_PASSWORD_REFRESH_IDS.forEach((id) => {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (!button) return;
    button.hidden = !active;
    button.disabled = !active;
    button.setAttribute('aria-disabled', canEdit ? 'false' : 'true');
  });
}

function syncHostOwnedConnectSections(): void {
  const visible = _canEditHostOwnedSetting();
  HOST_OWNED_SECTION_SELECTORS.forEach((selector) => {
    document.querySelectorAll<HTMLElement>(selector).forEach((section) => {
      section.hidden = !visible;
      section.setAttribute('aria-hidden', visible ? 'false' : 'true');
    });
  });
}

function initRoomPasswordControls(): void {
  ROOM_PASSWORD_TOGGLE_IDS.forEach((id) => {
    const toggle = document.getElementById(id);
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      if (_guardRoomPasswordCtrl()) return;

      if (getState('network.roomPasswordRequired')) {
        _applyRoomPassword(null);
        showToast(t('connect.room_password_disabled'));
        return;
      }

      _applyRoomPassword(_generateRoomPassword());
      showToast(t('connect.room_password_enabled'));
    });
  });

  ROOM_PASSWORD_REFRESH_IDS.forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.addEventListener('click', () => {
      if (_guardRoomPasswordCtrl()) return;
      _applyRoomPassword(_generateRoomPassword());
    });
  });

  syncRoomPasswordControls();
}

// ─── Device List Rendering ──────────────────────────────────────

let _lastDeviceCount = 0;

function _updateDeviceTitles(): void {
  const titleText = _deviceListTitle(_lastDeviceCount);
  ['connect-device-title', 'desktop-device-title'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = titleText;
  });
}

function _deviceListTitle(count: number): string {
  return t('connect.device_list', { count });
}

function renderConnectDeviceList(list: Array<Record<string, unknown>>): void {
  _lastDeviceList = list;
  _lastDeviceCount = list.length;
  _updateDeviceTitles();

  const containers = [
    document.getElementById('connect-device-list'),
    document.getElementById('desktop-device-list'),
  ].filter(Boolean) as HTMLElement[];

  containers.forEach((container) => {
    container.replaceChildren();

    list.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'device-row';

      // Join order number
      const orderBadge = document.createElement('span');
      orderBadge.className = 'd-order';
      const idx = typeof p.joinOrder === 'number' ? p.joinOrder : '?';
      orderBadge.textContent = `${idx}`;
      row.appendChild(orderBadge);

      // Device name + short ID + admin badge
      const name = document.createElement('span');
      name.className = 'd-name';
      name.textContent = String(p.label || t('common.peer'));

      if (p.isOp) {
        const op = document.createElement('span');
        op.className = 'd-op-badge';
        op.textContent = 'ADMIN';
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
        kickBtn.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
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

// ─── Lifecycle ──────────────────────────────────────────────────────

const _busScope = createBusScope();

export function initConnect(): void {
  _busScope.dispose();

  initStepper('max-device-stepper');
  initStepper('desktop-max-device-stepper');
  initRoomPasswordControls();
  syncHostOwnedConnectSections();

  // Slot-guide ⓘ buttons (mobile + desktop). Same info dialog either way.
  const openSlotGuide = () => {
    showDialog({
      title: t('connect.slot_guide.title'),
      message: t('connect.slot_guide.body'),
      buttonText: t('common.ok'),
    });
  };
  const slotGuideMobile = document.getElementById('slot-guide-btn-mobile');
  const slotGuideDesktop = document.getElementById('slot-guide-btn-desktop');
  slotGuideMobile?.addEventListener('click', openSlotGuide);
  slotGuideDesktop?.addEventListener('click', openSlotGuide);

  // QR refresh when connect tab is opened
  _busScope.on('ui:connect-tab-opened', () => {
    refreshAllQR();
  });

  // Desktop sub-tab may show connect panel — refresh QR
  _busScope.on('ui:settings-tab-opened', () => {
    refreshAllQR();
  });

  // Set initial device count title
  _updateDeviceTitles();

  // Re-render title on language change (disconnect previous on re-init)
  if (_langObserver) _langObserver.disconnect();
  _langObserver = new MutationObserver(() => {
    _updateDeviceTitles();
    syncRoomPasswordControls();
  });
  _langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  _busScope.on('i18n:changed', () => {
    _updateDeviceTitles();
    syncRoomPasswordControls();
    if (_lastDeviceList.length > 0) renderConnectDeviceList(_lastDeviceList);
  });

  _busScope.on('network:device-list-update', (list: unknown[]) => {
    if (Array.isArray(list)) {
      renderConnectDeviceList(list as Array<Record<string, unknown>>);
    }
  });

  // sessionCode is set before sessionStarted — both trigger QR refresh
  _busScope.on('state:network.sessionCode', () => {
    refreshAllQR();
  });
  _busScope.on('state:setup.sessionStarted', () => {
    refreshAllQR();
    syncRoomPasswordControls();
    syncHostOwnedConnectSections();
  });
  _busScope.on('state:network.roomPasswordRequired', () => syncRoomPasswordControls());
  _busScope.on('state:network.roomPassword', () => syncRoomPasswordControls());
  _busScope.on('state:network.hostConn', () => {
    syncRoomPasswordControls();
    syncHostOwnedConnectSections();
  });
  _busScope.on('state:network.appRole', () => {
    syncRoomPasswordControls();
    syncHostOwnedConnectSections();
  });

  // Leave Session buttons (mobile + desktop)
  const leaveHandler = () => {
    showDialog({
      title: t('dialog.return_home_title'),
      message: `${t('dialog.return_home_msg')}\n${t('dialog.return_home_detail')}`,
      buttonText: t('common.ok'),
      secondaryText: t('common.cancel'),
    }).then((res) => {
      if (res && res.action === 'ok') {
        scheduleSessionReset(t('dialog.leaving_session'), () => window.location.reload());
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
          // Mirror the host's sanitize (handleRequestRename) so a name that
          // strips into a reserved/duplicate/empty string fails HERE with
          // feedback instead of being silently rejected by the host.
          const name = val.replace(DEVICE_LABEL_SANITIZE_RE, '').trim();
          if (!name) return t('connect.rename_empty');
          const isHostSelf = !getState('network.hostConn');
          if (RESERVED_NAMES.some((r) => name.toLowerCase() === r.toLowerCase())) {
            // Let the host restore one of its reserved default labels.
            if (!isHostSelf || !['host', '방장', '호스트'].includes(name.toLowerCase())) {
              return t('connect.rename_reserved');
            }
          }
          if (/^#\d+$/.test(name)) {
            return t('connect.rename_reserved');
          }
          // Reserved default host labels bypass the profanity dictionary.
          const isHostRestore =
            isHostSelf && ['host', '방장', '호스트'].includes(name.toLowerCase());
          if (!isHostRestore && containsProfanity(name)) {
            return t('connect.rename_profanity');
          }
          const hostLabel = getState('network.myDeviceLabel') || '';
          if (
            hostLabel &&
            name.toLowerCase() === hostLabel.toLowerCase() &&
            name !== currentLabel
          ) {
            return t('connect.rename_duplicate');
          }
          // Role-aware duplicate check: connectedPeers is host-only state
          // (ALWAYS empty on a guest) — getOtherDeviceLabels reads the
          // device-list broadcast on guests, matching what the host's
          // handleRequestRename will silently reject.
          if (getOtherDeviceLabels().some((l) => l.toLowerCase() === name.toLowerCase())) {
            return t('connect.rename_duplicate');
          }
          return null;
        },
      },
      buttonText: t('common.ok'),
      secondaryText: t('common.cancel'),
    });
    if (result.action !== 'ok') return;
    // Send exactly what the validator validated (same strip as the host's).
    const newName = (result.inputValue || '').replace(DEVICE_LABEL_SANITIZE_RE, '').trim();
    if (!newName || newName.length > 20) return;
    bus.emit('network:rename-device', newName);
    showToast(t('chat.cmd_nick_changed', { name: newName }));
  };
  document.getElementById('btn-rename-device')?.addEventListener('click', renameHandler);
  document.getElementById('desktop-btn-rename-device')?.addEventListener('click', renameHandler);

  // Initial render
  refreshAllQR();

  log.info('[Connect] Initialized');
}

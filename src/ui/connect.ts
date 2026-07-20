/**
 * MUSIXQUARE — Connect Tab (UI)
 *
 * Manages: QR code generation for session joining and connected device list
 * rendering (mobile + desktop sub-panel).
 */

import { log } from '../core/log.ts';
import { bus, createBusScope } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import {
  DEVICE_LABEL_SANITIZE_RE,
  PRO_GENERATED_PEER_NAME_RE,
  RESERVED_NAMES,
} from '../core/constants.ts';
import { getOtherDeviceLabels } from '../network/guards.ts';
import { t } from '../i18n/index.ts';
import { showDialog } from './dialog.ts';
import { containsProfanity } from '../chat/profanity.ts';
import { showToast } from './toast.ts';
import { copyTextToClipboard } from './dom.ts';
import { scheduleSessionReset } from '../core/session-reset.ts';
import { navigateToAppHome } from '../core/navigation.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import { normalizeProRoomPin } from '../pro-room/room-code.ts';

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
    // QR generation happens only after a session exists. Keep its sizeable
    // encoder out of the first-load graph while preserving the existing
    // loading placeholder and stale-generation guard around the await.
    const { default: QRCode } = await import('qrcode');
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

// ─── Room Password ───────────────────────────────────────────────

const ROOM_PASSWORD_TOGGLE_IDS = ['room-password-toggle', 'desktop-room-password-toggle'];
const ROOM_PASSWORD_CODE_ROW_IDS = ['room-password-code-row', 'desktop-room-password-code-row'];
const ROOM_PASSWORD_CODE_IDS = ['room-password-code', 'desktop-room-password-code'];
const ROOM_PASSWORD_REFRESH_IDS = ['room-password-refresh', 'desktop-room-password-refresh'];
const ROOM_PASSWORD_OFF_TEXT = '- - - - - - - -';
const PRO_ROOM_PASSWORD_MASKED_TEXT = '••••-••••';
const ROOM_PASSWORD_REFRESH_PATH =
  'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8S7.58 20 12 20c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h8V3z';
const ROOM_PASSWORD_EDIT_PATH =
  'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.04a.996.996 0 0 0 0-1.41l-2.51-2.51a.996.996 0 0 0-1.41 0l-1.96 1.96 3.75 3.75 2.13-1.79z';
let _proPinChangeInFlight = false;

function _isProRoom(): boolean {
  return getRoomContext().kind === 'pro';
}

function _formatRoomPassword(password: string): string {
  return password.replace(/^(\d{4})(\d{4})$/, '$1-$2');
}

function _canEditRoomPassword(): boolean {
  if (_isProRoom()) return hasRoomCapability('room.configure');
  return _canEditHostOwnedSetting();
}

function _guardRoomPasswordCtrl(): boolean {
  if (_isProRoom()) {
    if (hasRoomCapability('room.configure')) return false;
    showToast(t('pro.owner_only'));
    return true;
  }
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
  const isProRoom = _isProRoom();
  const password = getState('network.roomPassword') || '';
  const active =
    isProRoom || (getState('network.roomPasswordRequired') && /^\d{8}$/.test(password));
  const canEdit = _canEditRoomPassword();

  document
    .querySelectorAll<HTMLElement>('.room-password-section .section-title')
    .forEach((title) => {
      const key = isProRoom ? 'pro.pin_change_title' : 'connect.room_password_title';
      title.setAttribute('data-i18n', key);
      title.textContent = t(key);
    });

  ROOM_PASSWORD_TOGGLE_IDS.forEach((id) => {
    const toggle = document.getElementById(id) as HTMLButtonElement | null;
    if (!toggle) return;
    toggle.hidden = isProRoom;
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
    code.textContent = isProRoom
      ? PRO_ROOM_PASSWORD_MASKED_TEXT
      : active
        ? _formatRoomPassword(password)
        : ROOM_PASSWORD_OFF_TEXT;
    code.classList.toggle('is-placeholder', !active);
  });

  ROOM_PASSWORD_REFRESH_IDS.forEach((id) => {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (!button) return;
    const ariaKey = isProRoom ? 'pro.pin_change_title' : 'connect.room_password_refresh_aria';
    button.setAttribute('data-i18n-aria-label', ariaKey);
    button.setAttribute('aria-label', t(ariaKey));
    const path = button.querySelector('path');
    if (path)
      path.setAttribute('d', isProRoom ? ROOM_PASSWORD_EDIT_PATH : ROOM_PASSWORD_REFRESH_PATH);
    button.hidden = !active || !canEdit;
    button.disabled = !active || !canEdit || _proPinChangeInFlight;
    button.setAttribute(
      'aria-disabled',
      !active || !canEdit || _proPinChangeInFlight ? 'true' : 'false',
    );
  });
}

function syncHostOwnedConnectSections(): void {
  const isProRoom = _isProRoom();
  const passwordVisible = isProRoom
    ? hasRoomCapability('room.configure')
    : _canEditHostOwnedSetting();
  document.querySelectorAll<HTMLElement>('.room-password-section').forEach((section) => {
    section.hidden = !passwordVisible;
    section.setAttribute('aria-hidden', passwordVisible ? 'false' : 'true');
  });
}

async function changeProRoomPin(): Promise<void> {
  if (_proPinChangeInFlight || _guardRoomPasswordCtrl()) return;

  const result = await showDialog({
    title: t('pro.pin_change_title'),
    message: t('pro.pin_change_message'),
    inputField: {
      placeholder: t('dialog.room_password_placeholder'),
      maxLength: 8,
      inputMode: 'numeric',
      pattern: '[0-9]*',
      autocomplete: 'new-password',
      splitEvery: 4,
      separator: '-',
      validator: (value) =>
        normalizeProRoomPin(value) ? null : t('connect.room_password_invalid'),
    },
    buttonText: t('common.ok'),
    secondaryText: t('common.cancel'),
    defaultFocus: 'primary',
  });
  const pin = result.action === 'ok' ? normalizeProRoomPin(result.inputValue) : null;
  if (!pin) return;
  if (!_isProRoom() || !hasRoomCapability('room.configure')) {
    showToast(t('pro.owner_only'));
    return;
  }

  _proPinChangeInFlight = true;
  syncRoomPasswordControls();
  try {
    // Lazy-load the PRO runtime so the standard-room connect UI does not pull
    // the persistent-room/network bridge into its eager module graph.
    const { changeActiveProRoomPin } = await import('../pro-room/runtime.ts');
    await changeActiveProRoomPin(pin);
    showToast(t('pro.pin_changed'));
  } catch (error) {
    log.warn('[Connect] PRO room password change failed', error);
    showToast(t('error.network_generic'));
  } finally {
    _proPinChangeInFlight = false;
    syncRoomPasswordControls();
  }
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
      if (_isProRoom()) {
        void changeProRoomPin();
        return;
      }
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
  const isProRoom = _isProRoom();

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

      if (p.isOp && !isProRoom) {
        const op = document.createElement('span');
        op.className = 'd-op-badge';
        op.textContent = 'ADMIN';
        name.appendChild(document.createTextNode(' '));
        name.appendChild(op);
      }

      row.appendChild(name);

      // Standard-room host behavior stays unchanged. In a PRO room, any
      // authenticated member with members.manage asks the room server to
      // remove another connected participant.
      const hostConn = getState('network.hostConn');
      const peerId = typeof p.id === 'string' ? p.id : '';
      const canRequestProKick = isProRoom && hasRoomCapability('members.manage');
      const canKick = !hostConn || canRequestProKick;
      if (
        canKick &&
        peerId &&
        peerId !== getState('network.myId') &&
        !p.isHost &&
        p.status === 'connected'
      ) {
        const actions = document.createElement('div');
        actions.className = 'd-actions';

        // PRO participants derive their controller authority from the room
        // capability snapshot. The legacy ADMIN toggle must not suggest that
        // this authority can be granted or revoked peer-to-peer.
        if (!isProRoom) {
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
        }

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
          if (_isProRoom()) {
            if (!hasRoomCapability('members.manage')) return;
            bus.emit('pro-room:kick-member', peerId);
            return;
          }
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

  initRoomPasswordControls();
  syncHostOwnedConnectSections();

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
  _busScope.on('state:room.context', () => {
    syncRoomPasswordControls();
    syncHostOwnedConnectSections();
    if (_lastDeviceList.length > 0) renderConnectDeviceList(_lastDeviceList);
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
        scheduleSessionReset(t('dialog.leaving_session'), navigateToAppHome);
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
          // PRO members intentionally have no browser host connection. That
          // must not grant any member (including the room owner) the ordinary
          // room host's reserved-name restoration exception.
          const isHostSelf = getRoomContext().kind !== 'pro' && !getState('network.hostConn');
          if (RESERVED_NAMES.some((r) => name.toLowerCase() === r.toLowerCase())) {
            // Let the host restore one of its reserved default labels.
            if (!isHostSelf || !['host', '방장', '호스트'].includes(name.toLowerCase())) {
              return t('connect.rename_reserved');
            }
          }
          if (/^#\d+$/.test(name)) {
            return t('connect.rename_reserved');
          }
          if (getRoomContext().kind === 'pro' && PRO_GENERATED_PEER_NAME_RE.test(name)) {
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

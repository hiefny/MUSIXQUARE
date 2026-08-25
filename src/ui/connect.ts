/**
 * MUSIXQUARE — Connect Tab (UI)
 *
 * Manages: QR code generation for session joining and connected device list
 * rendering (mobile + desktop sub-panel).
 */

import { log } from '../core/log.ts';
import { bus, createBusScope } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { t } from '../i18n/index.ts';
import { showDialog } from './dialog.ts';
import { showToast } from './toast.ts';
import { copyTextToClipboard, syncOverlayState } from './dom.ts';
import { scheduleSessionReset } from '../core/session-reset.ts';
import { navigateToAppHome } from '../core/navigation.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import { retryPeerSignalingConnection } from '../network/peer.ts';
import { normalizeProRoomPin } from '../pro-room/room-code.ts';
import { restartProRoomTransportRecovery } from '../pro-room/transport-recovery.ts';
import { requestAccountNicknameChange } from './account.ts';
import { applyUserTextFontFallback } from './user-text-font.ts';
import { groupConnectedRoomMembers, type ConnectedRoomMember } from '../rooms/member-directory.ts';
import type {
  DeviceInfo,
  DevicePlatform,
  RoomCapability,
  StandardRoomPermissionSet,
} from '../types/index.ts';
import type {
  ProRoomAdministrator,
  ProRoomPermission,
  ProRoomPermissionSet,
} from '../pro-room/contracts.ts';

let _langObserver: MutationObserver | null = null;
let _lastDeviceList: DeviceInfo[] = [];
let _lastProAdministrators: ProRoomAdministrator[] = [];
const _expandedDeviceMemberKeys = new Set<string>();
let _deviceExpansionRoomBoundary = '';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDevicePlatform(value: unknown): value is DevicePlatform {
  return (
    value === 'ios' ||
    value === 'android' ||
    value === 'windows' ||
    value === 'macos' ||
    value === 'linux' ||
    value === 'other'
  );
}

function isRoomCapability(value: unknown): value is RoomCapability {
  return (
    value === 'media.add' ||
    value === 'queue.mutate' ||
    value === 'playback.control' ||
    value === 'effects.control' ||
    value === 'asset.upload' ||
    value === 'system-audio.publish' ||
    value === 'members.manage' ||
    value === 'chat.notice' ||
    value === 'room.configure' ||
    value === 'coordinator.eligible'
  );
}

function isDeviceInfo(value: unknown): value is DeviceInfo {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    typeof value.isOp === 'boolean' &&
    typeof value.isHost === 'boolean' &&
    typeof value.status === 'string' &&
    (value.joinOrder === undefined || typeof value.joinOrder === 'number') &&
    (value.connectionType === undefined || typeof value.connectionType === 'string') &&
    (value.devicePlatform === undefined || isDevicePlatform(value.devicePlatform)) &&
    (value.memberId === undefined || typeof value.memberId === 'string') &&
    (value.memberDisplayNumber === undefined || typeof value.memberDisplayNumber === 'number') &&
    (value.isAuthenticated === undefined || typeof value.isAuthenticated === 'boolean') &&
    (value.role === undefined ||
      value.role === 'owner' ||
      value.role === 'controller' ||
      value.role === 'member') &&
    (value.capabilities === undefined ||
      (Array.isArray(value.capabilities) && value.capabilities.every(isRoomCapability)))
  );
}

function normalizeDeviceInfo(value: unknown): DeviceInfo | null {
  if (isDeviceInfo(value)) return value;
  if (!isRecord(value)) return null;

  // PeerJS BinaryPack serializes an own-property `undefined` as `null`.
  // Remove only nullable optional fields before applying the strict validator;
  // malformed non-null authority data still rejects the whole projection.
  const normalized = { ...value };
  if (normalized.joinOrder === null) delete normalized.joinOrder;
  if (normalized.connectionType === null) delete normalized.connectionType;
  if (normalized.devicePlatform === null) delete normalized.devicePlatform;
  if (normalized.memberId === null) delete normalized.memberId;
  if (normalized.memberDisplayNumber === null) delete normalized.memberDisplayNumber;
  if (normalized.isAuthenticated === null) delete normalized.isAuthenticated;
  if (normalized.role === null) delete normalized.role;
  if (normalized.capabilities === null) delete normalized.capabilities;

  return isDeviceInfo(normalized) ? normalized : null;
}

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
const INVITE_LINK_ICON_PATH =
  'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z';
const SIGNALING_RECOVERY_ICON_PATH =
  'M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h8V3l-3.35 3.35z';

async function generateQR(containerId: string): Promise<void> {
  const gen = (_qrGeneration.get(containerId) ?? 0) + 1;
  _qrGeneration.set(containerId, gen);

  const container = document.getElementById(containerId);
  if (!container) return;

  const sessionCode = getState('network.sessionCode') || '';
  const sessionStarted = getState('setup.sessionStarted');
  const shouldRestoreInviteFocus = container.contains(document.activeElement);

  if (!sessionStarted || !sessionCode || !/^\d{6}$/.test(sessionCode)) {
    const p = document.createElement('p');
    p.className = 'qr-placeholder';
    p.setAttribute('data-i18n', 'connect.no_session');
    p.textContent = t('connect.no_session');
    container.replaceChildren(p);
    renderSignalingRecoveryControls();
    return;
  }

  const loadingP = document.createElement('p');
  loadingP.className = 'qr-placeholder';
  loadingP.setAttribute('data-i18n', 'connect.generating_qr');
  loadingP.textContent = t('connect.generating_qr');
  container.replaceChildren(loadingP);
  renderSignalingRecoveryControls();

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
    copyBtn.type = 'button';
    copyBtn.className = 'btn-copy-invite-link';
    copyBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${INVITE_LINK_ICON_PATH}"/></svg><span class="material-elastic-spinner signaling-recovery-spinner" aria-hidden="true"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" pathLength="100"></circle></svg></span><span data-i18n="connect.copy_invite_link">${t('connect.copy_invite_link')}</span>`;
    const copyInviteLink = async (): Promise<void> => {
      const healthStatus = getState('network.signalingHealth').status;
      if (_manualSignalingRecovery || healthStatus === 'reconnecting') return;
      if (healthStatus === 'exhausted') {
        await beginManualSignalingRecovery();
        return;
      }
      // Route through copyTextToClipboard so the textarea+execCommand fallback
      // kicks in on insecure contexts (HTTP LAN) and restricted webviews
      // (Toss in-app) where navigator.clipboard may reject or be absent.
      const ok = await copyTextToClipboard(shareUrl);
      showToast(ok ? t('connect.link_copied') : t('toast.copy_failed'));
    };
    copyBtn.addEventListener('click', () => {
      copyInviteLink().catch((error) => {
        log.warn('[Connect] Invite-link copy failed', error);
        showToast(t('toast.copy_failed'));
      });
    });
    container.appendChild(copyBtn);
    syncSignalingInviteButtons();
    renderSignalingRecoveryControls();
    if (
      shouldRestoreInviteFocus &&
      _signalingRecoveryDialogState === 'closed' &&
      (document.activeElement === document.body ||
        document.activeElement === document.documentElement)
    ) {
      try {
        copyBtn.focus({ preventScroll: true });
      } catch {
        copyBtn.focus();
      }
    }
  } catch (e) {
    if (_qrGeneration.get(containerId) !== gen) return;
    log.warn('[Connect] QR generation failed', e);
    const errP = document.createElement('p');
    errP.className = 'qr-placeholder';
    errP.setAttribute('data-i18n', 'connect.no_session');
    errP.textContent = t('connect.no_session');
    container.replaceChildren(errP);
    renderSignalingRecoveryControls();
  }
}

function refreshAllQR(): void {
  generateQR('qr-container').catch((error) => {
    log.warn('[Connect] Mobile QR refresh failed', error);
  });
  generateQR('desktop-qr-container').catch((error) => {
    log.warn('[Connect] Desktop QR refresh failed', error);
  });
}

const SIGNALING_RECOVERY_OVERLAY_ID = 'signaling-recovery-overlay';

type SignalingRecoveryDialogState = 'closed' | 'failed';

interface ManualSignalingRecovery {
  readonly boundary: string;
  retryStarted: boolean;
}

let _manualSignalingRecovery: ManualSignalingRecovery | null = null;
let _signalingRecoveryDialogState: SignalingRecoveryDialogState = 'closed';
let _signalingRecoveryDialogBoundary: string | null = null;
let _signalingRecoveryDialogPreviousFocus: HTMLElement | null = null;

function signalingRecoveryBoundary(): string {
  const room = getRoomContext();
  return [
    room.kind,
    room.roomId ?? '',
    getState('network.appRole'),
    getState('network.sessionCode'),
  ].join(':');
}

function syncSignalingInviteButtons(): void {
  const health = getState('network.signalingHealth');
  const mode =
    _manualSignalingRecovery || health.status === 'reconnecting'
      ? 'recovering'
      : health.status === 'exhausted'
        ? 'recover'
        : 'copy';
  const labelKey =
    mode === 'recovering'
      ? 'connect.signaling_recovering'
      : mode === 'recover'
        ? 'connect.signaling_recover_action'
        : 'connect.copy_invite_link';
  const label = t(labelKey);

  document.querySelectorAll<HTMLButtonElement>('.btn-copy-invite-link').forEach((button) => {
    button.dataset.mode = mode;
    // Keep the pressed trigger focusable while work is in flight. Native
    // `disabled` drops focus to <body> in Chromium; the click guard above
    // provides the same single-flight behavior without losing context.
    button.disabled = false;
    button.setAttribute('aria-disabled', mode === 'recovering' ? 'true' : 'false');
    button.setAttribute('aria-busy', mode === 'recovering' ? 'true' : 'false');
    button.setAttribute('aria-live', 'polite');
    button.setAttribute('aria-atomic', 'true');
    button.setAttribute('aria-label', label);

    const text = button.querySelector<HTMLElement>('span[data-i18n]');
    if (text) {
      text.setAttribute('data-i18n', labelKey);
      text.textContent = label;
    }
    button
      .querySelector('path')
      ?.setAttribute('d', mode === 'copy' ? INVITE_LINK_ICON_PATH : SIGNALING_RECOVERY_ICON_PATH);
  });
}

function closeSignalingRecoveryDialog(focusRecoveryButton = false): void {
  const overlay = document.getElementById(SIGNALING_RECOVERY_OVERLAY_ID);
  if (overlay) {
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    syncOverlayState();
  }

  _signalingRecoveryDialogState = 'closed';
  _signalingRecoveryDialogBoundary = null;
  const previousFocus = _signalingRecoveryDialogPreviousFocus;
  _signalingRecoveryDialogPreviousFocus = null;
  const recoveryButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.btn-copy-invite-link'),
  );
  const recoveryButton =
    previousFocus instanceof HTMLButtonElement &&
    previousFocus.matches('.btn-copy-invite-link') &&
    previousFocus.isConnected
      ? previousFocus
      : recoveryButtons.find((button) => button.offsetParent !== null) ||
        recoveryButtons[0] ||
        null;
  const focusTarget = focusRecoveryButton ? recoveryButton : previousFocus;
  if (focusTarget instanceof HTMLElement && focusTarget.isConnected) {
    try {
      focusTarget.focus({ preventScroll: true });
    } catch {
      /* ignore stale focus targets */
    }
  }
}

function syncSignalingRecoveryDialogCopy(): void {
  if (_signalingRecoveryDialogState === 'closed') return;
  const title = document.getElementById('signaling-recovery-title');
  const message = document.getElementById('signaling-recovery-message');
  const confirm = document.getElementById(
    'btn-signaling-recovery-confirm',
  ) as HTMLButtonElement | null;
  const retry = document.getElementById('btn-signaling-recovery-retry') as HTMLButtonElement | null;
  if (!title || !message || !confirm || !retry) return;

  const titleText = t('connect.signaling_failed');
  const messageText = t('connect.signaling_exhausted');
  title.textContent = titleText;
  message.textContent = messageText;
  confirm.textContent = t('common.ok');
  retry.textContent = t('connect.signaling_retry');
  applyUserTextFontFallback(title, titleText);
  applyUserTextFontFallback(message, messageText);
}

function setSignalingRecoveryDialogState(
  state: Exclude<SignalingRecoveryDialogState, 'closed'>,
  boundary = signalingRecoveryBoundary(),
): void {
  const overlay = document.getElementById(SIGNALING_RECOVERY_OVERLAY_ID);
  const dialog = document.getElementById('signaling-recovery-dialog');
  const title = document.getElementById('signaling-recovery-title');
  const message = document.getElementById('signaling-recovery-message');
  const actions = document.getElementById('signaling-recovery-actions');
  const confirm = document.getElementById(
    'btn-signaling-recovery-confirm',
  ) as HTMLButtonElement | null;
  const retry = document.getElementById('btn-signaling-recovery-retry') as HTMLButtonElement | null;

  if (!overlay || !dialog || !title || !message || !actions || !confirm || !retry) {
    if (state === 'failed') {
      showDialog({
        title: t('connect.signaling_failed'),
        message: t('connect.signaling_exhausted'),
        buttonText: t('connect.signaling_retry'),
        secondaryText: t('common.ok'),
      })
        .then((result) => {
          if (result.action !== 'ok') return;
          beginManualSignalingRecovery().catch((error) => {
            log.warn('[Connect] Signaling recovery retry failed', error);
          });
        })
        .catch((error) => {
          log.warn('[Connect] Signaling recovery dialog failed', error);
        });
    }
    return;
  }

  const wasOpen = overlay.classList.contains('show');
  if (!wasOpen) {
    _signalingRecoveryDialogPreviousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  _signalingRecoveryDialogState = state;
  _signalingRecoveryDialogBoundary = boundary;
  dialog.dataset.state = state;
  dialog.setAttribute('aria-busy', 'false');
  actions.hidden = false;
  syncSignalingRecoveryDialogCopy();

  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  syncOverlayState(SIGNALING_RECOVERY_OVERLAY_ID);

  try {
    confirm.focus({ preventScroll: true });
  } catch {
    /* ignore focus failures in detached test documents */
  }
}

function initSignalingRecoveryDialog(): void {
  const overlay = document.getElementById(SIGNALING_RECOVERY_OVERLAY_ID);
  const dialog = document.getElementById('signaling-recovery-dialog');
  const confirm = document.getElementById(
    'btn-signaling-recovery-confirm',
  ) as HTMLButtonElement | null;
  const retry = document.getElementById('btn-signaling-recovery-retry') as HTMLButtonElement | null;
  if (!overlay || !dialog || !confirm || !retry || overlay.dataset.bound === 'true') return;
  overlay.dataset.bound = 'true';

  confirm.addEventListener('click', () => closeSignalingRecoveryDialog());
  retry.addEventListener('click', () => {
    beginManualSignalingRecovery().catch((error) => {
      log.warn('[Connect] Manual signaling recovery failed', error);
    });
    closeSignalingRecoveryDialog(true);
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusables = [confirm, retry].filter((button) => !button.hidden && !button.disabled);
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

async function retrySignalingConnection(): Promise<boolean> {
  // Manual recovery begins on the next microtask. The former dynamic imports
  // supplied this boundary implicitly; keep it explicit so a stale inherited
  // `exhausted` render cannot be mistaken for the result of the new attempt.
  await Promise.resolve();
  if (getRoomContext().kind === 'pro') {
    return restartProRoomTransportRecovery();
  }
  return retryPeerSignalingConnection();
}

function finishManualSignalingRecovery(
  recovery: ManualSignalingRecovery,
  outcome: 'recovered' | 'failed',
): void {
  if (_manualSignalingRecovery !== recovery) return;
  _manualSignalingRecovery = null;
  syncSignalingInviteButtons();

  if (outcome === 'recovered') {
    return;
  }

  setSignalingRecoveryDialogState('failed', recovery.boundary);
}

async function beginManualSignalingRecovery(): Promise<void> {
  if (_manualSignalingRecovery || getState('network.signalingHealth').status !== 'exhausted') {
    return;
  }

  const recovery: ManualSignalingRecovery = {
    boundary: signalingRecoveryBoundary(),
    retryStarted: false,
  };
  _manualSignalingRecovery = recovery;
  syncSignalingInviteButtons();

  let started = false;
  try {
    started = await retrySignalingConnection();
  } catch (error) {
    log.warn('[Connect] Could not restart signaling recovery', error);
  }
  if (_manualSignalingRecovery !== recovery) return;

  recovery.retryStarted = started;
  const health = getState('network.signalingHealth');
  if (!started || health.status === 'exhausted') {
    finishManualSignalingRecovery(recovery, 'failed');
  } else if (health.status === 'healthy' || health.status === 'recovered') {
    finishManualSignalingRecovery(recovery, 'recovered');
  }
}

function renderSignalingRecoveryControls(): void {
  const health = getState('network.signalingHealth');
  const visible =
    getState('setup.sessionStarted') && /^\d{6}$/.test(getState('network.sessionCode'));
  const boundary = signalingRecoveryBoundary();
  const recovery = _manualSignalingRecovery;

  if (recovery && (!visible || recovery.boundary !== boundary)) {
    _manualSignalingRecovery = null;
    syncSignalingInviteButtons();
    if (_signalingRecoveryDialogState !== 'closed') closeSignalingRecoveryDialog();
  } else if (recovery && (health.status === 'healthy' || health.status === 'recovered')) {
    finishManualSignalingRecovery(recovery, 'recovered');
  } else if (recovery?.retryStarted && health.status === 'exhausted') {
    finishManualSignalingRecovery(recovery, 'failed');
  } else if (
    _signalingRecoveryDialogState !== 'closed' &&
    (!visible ||
      _signalingRecoveryDialogBoundary !== boundary ||
      (_signalingRecoveryDialogState === 'failed' && health.status !== 'exhausted'))
  ) {
    closeSignalingRecoveryDialog();
  }

  syncSignalingInviteButtons();
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

function _generateRoomPassword(): string | null {
  try {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return String(values[0]! % 100_000_000).padStart(8, '0');
  } catch (error) {
    log.warn('[Connect] Secure room password generation unavailable', error);
    return null;
  }
}

function _applyFreshRoomPassword(): boolean {
  const password = _generateRoomPassword();
  if (!password) {
    showToast(t('error.network_generic'));
    return false;
  }
  _applyRoomPassword(password);
  return true;
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

      if (_applyFreshRoomPassword()) showToast(t('connect.room_password_enabled'));
    });
  });

  ROOM_PASSWORD_REFRESH_IDS.forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.addEventListener('click', () => {
      if (_isProRoom()) {
        changeProRoomPin().catch((error) => {
          log.warn('[Connect] PRO room PIN change failed', error);
          showToast(t('error.network_generic'));
        });
        return;
      }
      if (_guardRoomPasswordCtrl()) return;
      _applyFreshRoomPassword();
    });
  });

  syncRoomPasswordControls();
}

// ─── Device List Rendering ──────────────────────────────────────

let _lastDeviceCount = 0;

const ADMIN_PERMISSION_KEYS = [
  'media.add',
  'playback.control',
  'members.kick',
  'chat.notice',
] as const satisfies readonly ProRoomPermission[];
const FULL_ADMIN_PERMISSIONS: Readonly<ProRoomPermissionSet> = Object.freeze({
  'media.add': true,
  'playback.control': true,
  'members.kick': true,
  'chat.notice': true,
});
const CROWN_PATH = 'M5 16 3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm1 2h12v2H6z';
const CROWN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${CROWN_PATH}"/></svg>`;
const SETTINGS_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.1 7.1 0 0 0-1.62-.94L14.38 2.8A.49.49 0 0 0 13.89 2h-3.84a.49.49 0 0 0-.49.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.61.22L2.66 8.47a.5.5 0 0 0 .12.64l2.03 1.58c-.05.31-.09.65-.09.98s.03.66.08.97l-2.02 1.58a.49.49 0 0 0-.12.64l1.92 3.32c.13.23.4.31.63.22l2.37-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.49.41h3.84c.25 0 .46-.17.49-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.37.96c.23.09.5.01.63-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.02-1.58zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/></svg>';
const REVOKE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.41 4.29 19.71 2.88 18.3 9.17 12 2.88 5.7 4.29 4.29 10.59 10.59 16.89 4.29z"/></svg>';

interface AdministratorView {
  memberId: string;
  memberDisplayNumber: number;
  displayName: string;
  isOwner: boolean;
  permissions: ProRoomPermissionSet;
  inheritedPermissions: ProRoomPermission[];
  onlineDeviceCount: number;
}

let _permissionDialogTarget: AdministratorView | null = null;
let _permissionDialogPreviousFocus: HTMLElement | null = null;
let _permissionDialogPreviousContainerId: string | null = null;
let _permissionDialogBusy = false;
let _permissionDialogInitializedFor: HTMLElement | null = null;
let _permissionDialogRoomBoundary: {
  kind: string;
  roomId: string | null;
  epoch: number;
} | null = null;

function memberAuthorityKey(member: ConnectedRoomMember): string {
  return member.memberId || `peer:${member.deviceIds[0] || member.key}`;
}

function clonePermissions(
  permissions: Readonly<StandardRoomPermissionSet | ProRoomPermissionSet>,
): ProRoomPermissionSet {
  return {
    'media.add': permissions['media.add'] === true,
    'playback.control': permissions['playback.control'] === true,
    'members.kick': permissions['members.kick'] === true,
    'chat.notice': permissions['chat.notice'] === true,
  };
}

function compareStandardAdministratorText(left: string, right: string): number {
  // Ordinary rooms have a host-owned directory rather than the PRO server
  // projection. Keep this independent sort deterministic across UI locales.
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function _canManageAdministrators(): boolean {
  if (_isProRoom()) return hasRoomCapability('room.configure');
  return _canEditHostOwnedSetting();
}

function _administratorsForMembers(members: readonly ConnectedRoomMember[]): AdministratorView[] {
  if (_isProRoom()) {
    return _lastProAdministrators.map((administrator) => ({
      memberId: administrator.memberId,
      memberDisplayNumber: administrator.memberDisplayNumber,
      displayName: administrator.displayName,
      isOwner: administrator.role === 'owner',
      permissions: clonePermissions(administrator.permissions),
      inheritedPermissions: [...administrator.inheritedPermissions],
      onlineDeviceCount: administrator.onlineDeviceCount,
    }));
  }

  const views: AdministratorView[] = [];
  const host = members.find((member) => member.isHost);
  if (host) {
    views.push({
      // The room-owner row follows the verified person-level identity so all
      // of that owner's devices remain one row. Transport coordination and
      // PIN/administrator editing are still anchored to hostDeviceId and the
      // physical-host gates above; this grouping grants no transport role.
      memberId: memberAuthorityKey(host),
      memberDisplayNumber: host.memberDisplayNumber,
      displayName: host.label || t('common.peer'),
      isOwner: true,
      permissions: clonePermissions(FULL_ADMIN_PERMISSIONS),
      inheritedPermissions: [...ADMIN_PERMISSION_KEYS],
      onlineDeviceCount: host.deviceCount,
    });
  }

  if (_canEditHostOwnedSetting()) {
    for (const administrator of getState('network.standardRoomAdministrators').values()) {
      const connected = members.find(
        (member) => memberAuthorityKey(member) === administrator.memberId,
      );
      views.push({
        memberId: administrator.memberId,
        memberDisplayNumber: administrator.memberDisplayNumber,
        displayName: administrator.displayName,
        isOwner: false,
        permissions: clonePermissions(administrator.permissions),
        inheritedPermissions: [],
        onlineDeviceCount: connected?.deviceCount ?? 0,
      });
    }
  }

  // The persistent administrator directory is host-owned. Other participants
  // still receive a sanitized live projection in DEVICE_LIST_UPDATE, so merge
  // those connected administrators for an accurate read-only list without
  // exposing offline grants or creating a second authority source.
  const knownAdministratorIds = new Set(views.map((view) => view.memberId));
  for (const member of members) {
    if (member.isHost || !member.isAdministrator) continue;
    const memberId = memberAuthorityKey(member);
    if (knownAdministratorIds.has(memberId)) continue;
    const capabilities = new Set(member.capabilities);
    const hasExplicitCapabilities = capabilities.size > 0;
    views.push({
      memberId,
      memberDisplayNumber: member.memberDisplayNumber,
      displayName: member.label || t('common.peer'),
      isOwner: false,
      permissions: {
        'media.add': hasExplicitCapabilities
          ? capabilities.has('media.add') || capabilities.has('asset.upload')
          : true,
        'playback.control': hasExplicitCapabilities ? capabilities.has('playback.control') : true,
        'members.kick': capabilities.has('members.manage'),
        'chat.notice': capabilities.has('chat.notice'),
      },
      inheritedPermissions: [],
      onlineDeviceCount: member.deviceCount,
    });
    knownAdministratorIds.add(memberId);
  }

  return views.sort((left, right) => {
    const ownerOrder = Number(right.isOwner) - Number(left.isOwner);
    if (ownerOrder !== 0) return ownerOrder;

    const leftOnline = left.onlineDeviceCount > 0;
    const rightOnline = right.onlineDeviceCount > 0;
    const onlineOrder = Number(rightOnline) - Number(leftOnline);
    if (onlineOrder !== 0) return onlineOrder;

    if (leftOnline) {
      const displayNumberOrder = left.memberDisplayNumber - right.memberDisplayNumber;
      if (displayNumberOrder !== 0) return displayNumberOrder;
    } else {
      const displayNameOrder = compareStandardAdministratorText(
        left.displayName,
        right.displayName,
      );
      if (displayNameOrder !== 0) return displayNameOrder;
    }

    return compareStandardAdministratorText(left.memberId, right.memberId);
  });
}

function _administratorListTitle(count: number): string {
  return t('connect.administrator_list', { count });
}

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

function _administratorActionButton(
  className: string,
  ariaLabel: string,
  icon: string,
  handler: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `administrator-action-button ${className}`;
  button.setAttribute('aria-label', ariaLabel);
  button.title = ariaLabel;
  button.innerHTML = icon;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    handler();
  });
  return button;
}

function renderAdministratorLists(members: readonly ConnectedRoomMember[]): void {
  const administrators = _administratorsForMembers(members);
  const canManage = _canManageAdministrators();
  reconcileAdministratorPermissionsDialog(administrators);
  const sectionIds = ['connect-administrator-section', 'desktop-administrator-section'];
  const titleIds = ['connect-administrator-title', 'desktop-administrator-title'];
  const containerIds = ['connect-administrator-list', 'desktop-administrator-list'];

  sectionIds.forEach((id) => {
    const section = document.getElementById(id) as HTMLElement | null;
    if (section) section.hidden = administrators.length === 0;
  });
  titleIds.forEach((id) => {
    const title = document.getElementById(id);
    // The owner is visibly the first yellow-crown row, so include that person
    // in the section count instead of presenting the confusing "0 admins"
    // state beside a non-empty list.
    if (title) title.textContent = _administratorListTitle(administrators.length);
  });

  containerIds.forEach((id) => {
    const container = document.getElementById(id);
    if (!container) return;
    container.setAttribute('role', 'list');
    container.replaceChildren();

    for (const administrator of administrators) {
      const row = document.createElement('div');
      row.setAttribute('role', 'listitem');
      row.className = `device-row administrator-row${administrator.onlineDeviceCount ? '' : ' is-offline'}`;
      row.dataset.memberId = administrator.memberId;

      const crown = document.createElement('span');
      crown.className = `administrator-crown${administrator.isOwner ? ' owner' : ''}`;
      crown.setAttribute('role', 'img');
      crown.setAttribute(
        'aria-label',
        t(administrator.isOwner ? 'connect.room_owner_role' : 'connect.administrator_role'),
      );
      crown.innerHTML = CROWN_ICON;
      row.appendChild(crown);

      const name = document.createElement('span');
      name.className = 'd-name';
      const nameLabel = document.createElement('span');
      nameLabel.className = 'd-name-label';
      nameLabel.textContent = administrator.displayName || t('common.peer');
      applyUserTextFontFallback(nameLabel, nameLabel.textContent);
      name.appendChild(nameLabel);
      row.appendChild(name);

      if (canManage && !administrator.isOwner) {
        const actions = document.createElement('div');
        actions.className = 'd-actions';
        actions.appendChild(
          _administratorActionButton(
            'settings',
            t('connect.administrator_settings_aria', { name: administrator.displayName }),
            SETTINGS_ICON,
            () => openAdministratorPermissionsDialog(administrator),
          ),
        );
        actions.appendChild(
          _administratorActionButton(
            'revoke',
            t('connect.administrator_revoke_aria', { name: administrator.displayName }),
            REVOKE_ICON,
            () => {
              confirmRevokeAdministrator(administrator).catch((error) => {
                log.warn('[Connect] Administrator revoke confirmation failed', error);
                showToast(t('error.network_generic'));
              });
            },
          ),
        );
        row.appendChild(actions);
      }

      container.appendChild(row);
    }
  });
}

async function updateAdministrator(
  memberId: string,
  permissions: ProRoomPermissionSet,
): Promise<void> {
  if (_isProRoom()) {
    const { updateActiveProRoomAdministrator } = await import('../pro-room/runtime.ts');
    await updateActiveProRoomAdministrator(memberId, permissions);
    return;
  }
  bus.emit('network:update-standard-room-administrator', { memberId, permissions });
}

async function grantAdministrator(member: ConnectedRoomMember): Promise<void> {
  const memberId = memberAuthorityKey(member);
  if (_isProRoom()) {
    if (!member.memberId || !hasRoomCapability('room.configure')) return;
    const { updateActiveProRoomAdministrator } = await import('../pro-room/runtime.ts');
    await updateActiveProRoomAdministrator(
      member.memberId,
      clonePermissions(FULL_ADMIN_PERMISSIONS),
    );
    return;
  }
  if (!_canEditHostOwnedSetting()) return;
  bus.emit('network:grant-standard-room-administrator', {
    memberId,
    permissions: clonePermissions(FULL_ADMIN_PERMISSIONS),
  });
}

async function revokeAdministrator(memberId: string): Promise<void> {
  if (_isProRoom()) {
    const { revokeActiveProRoomAdministrator } = await import('../pro-room/runtime.ts');
    await revokeActiveProRoomAdministrator(memberId);
    return;
  }
  bus.emit('network:revoke-standard-room-administrator', { memberId });
}

async function confirmRevokeAdministrator(administrator: AdministratorView): Promise<void> {
  if (!_canManageAdministrators()) return;
  const result = await showDialog({
    title: t('connect.administrator_revoke_title'),
    message: t('connect.administrator_revoke_message', { name: administrator.displayName }),
    buttonText: t('common.revoke'),
    secondaryText: t('common.cancel'),
  });
  if (result.action !== 'ok' || !_canManageAdministrators()) return;
  try {
    await revokeAdministrator(administrator.memberId);
  } catch (error) {
    log.warn('[Connect] Could not revoke administrator', error);
    showToast(t('error.network_generic'));
  }
}

async function kickRoomMember(member: ConnectedRoomMember): Promise<void> {
  if (_isProRoom()) {
    if (!member.memberId) return;
    const { kickActiveProRoomMember } = await import('../pro-room/runtime.ts');
    await kickActiveProRoomMember(member.memberId);
    return;
  }
  bus.emit('network:request-kick-standard-room-member', {
    memberId: memberAuthorityKey(member),
  });
}

async function kickRoomPhysicalDevice(device: DeviceInfo): Promise<void> {
  if (_isProRoom()) {
    const { kickActiveProRoomPresence } = await import('../pro-room/runtime.ts');
    await kickActiveProRoomPresence(device.id);
    return;
  }
  bus.emit('network:request-kick-standard-room-device', { peerId: device.id });
}

function deviceExpansionRoomBoundary(): string {
  const room = getRoomContext();
  return `${room.kind}:${room.roomId ?? ''}:${room.epoch}`;
}

function syncDeviceExpansionRoomBoundary(): void {
  const boundary = deviceExpansionRoomBoundary();
  if (_deviceExpansionRoomBoundary === boundary) return;
  _deviceExpansionRoomBoundary = boundary;
  _expandedDeviceMemberKeys.clear();
}

function shortDeviceCode(deviceId: string): string {
  const compact = deviceId.replace(/[^A-Za-z0-9]/g, '');
  return (compact.slice(-4) || deviceId.slice(-4) || '----').toUpperCase();
}

function devicePlatformName(platform: DevicePlatform | undefined): string {
  switch (platform) {
    case 'ios':
      return 'iOS';
    case 'android':
      return 'Android';
    case 'windows':
      return 'Windows';
    case 'macos':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return t('connect.platform_other');
  }
}

function deviceDisplayName(device: DeviceInfo): string {
  return t('connect.device_label', {
    platform: devicePlatformName(device.devicePlatform),
    code: shortDeviceCode(device.id),
  });
}

function isAuthenticatedSiblingDevice(
  currentDevice: DeviceInfo | undefined,
  targetDevice: DeviceInfo,
): boolean {
  return (
    currentDevice?.id !== targetDevice.id &&
    currentDevice?.isAuthenticated === true &&
    targetDevice.isAuthenticated === true &&
    typeof currentDevice.memberId === 'string' &&
    currentDevice.memberId.length > 0 &&
    currentDevice.memberId === targetDevice.memberId
  );
}

function syncExpandedDeviceMember(memberKey: string): void {
  const expanded = _expandedDeviceMemberKeys.has(memberKey);
  document.querySelectorAll<HTMLElement>('.device-entry').forEach((entry) => {
    if (entry.dataset.memberKey !== memberKey) return;
    const toggle = entry.querySelector<HTMLButtonElement>('.device-expand-toggle');
    const sublist = entry.querySelector<HTMLElement>('.device-sublist');
    toggle?.setAttribute('aria-expanded', String(expanded));
    toggle?.classList.toggle('active', expanded);
    if (sublist) sublist.hidden = !expanded;
  });
}

function toggleExpandedDeviceMember(memberKey: string): void {
  if (_expandedDeviceMemberKeys.has(memberKey)) _expandedDeviceMemberKeys.delete(memberKey);
  else _expandedDeviceMemberKeys.add(memberKey);
  syncExpandedDeviceMember(memberKey);
}

function permissionRows(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-administrator-permission]'),
  );
}

function syncPermissionDialogRows(administrator: AdministratorView): void {
  const inherited = new Set(administrator.inheritedPermissions);
  for (const row of permissionRows()) {
    const key = row.dataset.administratorPermission as ProRoomPermission | undefined;
    if (!key) continue;
    // Only the owner has immutable authority, and the owner dialog cannot be
    // opened. A legacy controller may still arrive with playback listed as an
    // inherited permission; expose it as an ordinary explicit toggle so the
    // next save migrates that controller to the new permission model.
    const isInherited = administrator.isOwner && inherited.has(key);
    row.disabled = isInherited;
    row.setAttribute(
      'aria-checked',
      administrator.permissions[key] || isInherited ? 'true' : 'false',
    );
    if (key === 'playback.control') {
      const label = row.querySelector<HTMLElement>('.administrator-permission-inherited');
      if (label) label.hidden = !isInherited;
    }
  }
}

function closeAdministratorPermissionsDialogInternal(ignoreBusy: boolean): void {
  if (_permissionDialogBusy && !ignoreBusy) return;
  const overlay = document.getElementById('administrator-permissions-overlay');
  if (!overlay?.classList.contains('show')) return;
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  syncOverlayState();
  const targetMemberId = _permissionDialogTarget?.memberId || null;
  const previousFocus = _permissionDialogPreviousFocus;
  const previousContainerId = _permissionDialogPreviousContainerId;
  _permissionDialogTarget = null;
  _permissionDialogPreviousFocus = null;
  _permissionDialogPreviousContainerId = null;
  _permissionDialogRoomBoundary = null;
  queueMicrotask(() => {
    if (previousFocus?.isConnected) {
      previousFocus.focus();
      return;
    }
    const preferredContainer = previousContainerId
      ? document.getElementById(previousContainerId)
      : null;
    const containers = [
      preferredContainer,
      document.getElementById('connect-administrator-list'),
      document.getElementById('desktop-administrator-list'),
    ].filter((container, index, all): container is HTMLElement =>
      Boolean(container && all.indexOf(container) === index),
    );
    for (const container of containers) {
      const replacementRow = Array.from(
        container.querySelectorAll<HTMLElement>('.administrator-row'),
      ).find((row) => row.dataset.memberId === targetMemberId);
      const replacementButton = replacementRow?.querySelector<HTMLButtonElement>(
        '.administrator-action-button.settings',
      );
      if (replacementButton) {
        replacementButton.focus();
        return;
      }
    }
    const fallbackTitleId = previousContainerId?.replace(/-list$/, '-title');
    const fallback = fallbackTitleId ? document.getElementById(fallbackTitleId) : null;
    if (fallback && fallback.offsetParent !== null) {
      fallback.tabIndex = -1;
      fallback.focus();
      return;
    }
    // The member can disappear while this dialog is open. In that case the
    // administrator section is hidden together with its title, so focusing it
    // silently falls back to <body>. Keep keyboard users anchored in the
    // connection UI instead.
    const connectionFallbacks = [
      ...document.querySelectorAll<HTMLElement>('[data-subtab="connect"].active'),
      document.getElementById('nav-connect'),
    ];
    const connectionControl = connectionFallbacks.find(
      (candidate): candidate is HTMLElement => !!candidate && candidate.offsetParent !== null,
    );
    if (connectionControl) {
      connectionControl.focus();
    }
  });
}

function closeAdministratorPermissionsDialog(): void {
  closeAdministratorPermissionsDialogInternal(false);
}

function invalidateAdministratorPermissionsDialog(): void {
  closeAdministratorPermissionsDialogInternal(true);
}

function permissionSetsEqual(
  left: Readonly<ProRoomPermissionSet>,
  right: Readonly<ProRoomPermissionSet>,
): boolean {
  return ADMIN_PERMISSION_KEYS.every((key) => left[key] === right[key]);
}

function inheritedPermissionsEqual(
  left: readonly ProRoomPermission[],
  right: readonly ProRoomPermission[],
): boolean {
  return left.length === right.length && left.every((permission) => right.includes(permission));
}

function syncAdministratorPermissionsDialogTitle(administrator: AdministratorView): void {
  const title = document.getElementById('administrator-permissions-title');
  if (!title) return;
  const displayName = administrator.displayName || t('common.peer');
  const text = t('connect.permissions_title', { name: displayName });
  title.textContent = text;
  applyUserTextFontFallback(title, text);
}

function reconcileAdministratorPermissionsDialog(
  administrators: readonly AdministratorView[],
): void {
  const overlay = document.getElementById('administrator-permissions-overlay');
  const target = _permissionDialogTarget;
  if (!target || !overlay?.classList.contains('show')) return;

  const current = administrators.find(
    (administrator) => administrator.memberId === target.memberId,
  );
  if (
    !_canManageAdministrators() ||
    !current ||
    current.isOwner ||
    !permissionSetsEqual(current.permissions, target.permissions) ||
    !inheritedPermissionsEqual(current.inheritedPermissions, target.inheritedPermissions)
  ) {
    // A real authority/target transition invalidates the draft. Closing is
    // safer than letting a stale permission set overwrite a concurrent server
    // change; identical heartbeat projections compare equal and remain open.
    invalidateAdministratorPermissionsDialog();
    return;
  }

  _permissionDialogTarget = {
    ...current,
    permissions: clonePermissions(current.permissions),
    inheritedPermissions: [...current.inheritedPermissions],
  };
  syncAdministratorPermissionsDialogTitle(current);
}

function openAdministratorPermissionsDialog(administrator: AdministratorView): void {
  if (!_canManageAdministrators() || administrator.isOwner) return;
  const overlay = document.getElementById('administrator-permissions-overlay');
  const title = document.getElementById('administrator-permissions-title');
  if (!overlay || !title) return;
  _permissionDialogTarget = {
    ...administrator,
    permissions: clonePermissions(administrator.permissions),
    inheritedPermissions: [...administrator.inheritedPermissions],
  };
  _permissionDialogPreviousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  _permissionDialogPreviousContainerId =
    _permissionDialogPreviousFocus?.closest<HTMLElement>('.administrator-list')?.id || null;
  const roomContext = getRoomContext();
  _permissionDialogRoomBoundary = {
    kind: roomContext.kind,
    roomId: roomContext.roomId,
    epoch: roomContext.epoch,
  };
  syncAdministratorPermissionsDialogTitle(administrator);
  syncPermissionDialogRows(_permissionDialogTarget);
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  syncOverlayState('administrator-permissions-overlay');
  queueMicrotask(() => {
    const firstEditableRow = permissionRows().find((row) => !row.disabled);
    try {
      firstEditableRow?.focus({ preventScroll: true });
    } catch {
      firstEditableRow?.focus();
    }
  });
}

async function saveAdministratorPermissions(): Promise<void> {
  const target = _permissionDialogTarget;
  if (!target || _permissionDialogBusy || !_canManageAdministrators()) return;
  const permissions = clonePermissions(target.permissions);
  for (const row of permissionRows()) {
    const key = row.dataset.administratorPermission as ProRoomPermission | undefined;
    if (!key) continue;
    permissions[key] = row.getAttribute('aria-checked') === 'true';
  }

  const dialog = document.getElementById('administrator-permissions-dialog');
  _permissionDialogBusy = true;
  dialog?.setAttribute('aria-busy', 'true');
  try {
    await updateAdministrator(target.memberId, permissions);
    _permissionDialogBusy = false;
    dialog?.setAttribute('aria-busy', 'false');
    closeAdministratorPermissionsDialog();
  } catch (error) {
    _permissionDialogBusy = false;
    dialog?.setAttribute('aria-busy', 'false');
    log.warn('[Connect] Could not update administrator permissions', error);
    showToast(t('error.network_generic'));
  }
}

function initAdministratorPermissionsDialog(): void {
  const overlay = document.getElementById('administrator-permissions-overlay');
  if (!overlay || _permissionDialogInitializedFor === overlay) return;
  _permissionDialogInitializedFor = overlay;

  permissionRows().forEach((row) => {
    row.addEventListener('click', () => {
      if (row.disabled || _permissionDialogBusy) return;
      row.setAttribute(
        'aria-checked',
        row.getAttribute('aria-checked') === 'true' ? 'false' : 'true',
      );
    });
  });
  document
    .getElementById('btn-administrator-permissions-cancel')
    ?.addEventListener('click', closeAdministratorPermissionsDialog);
  document.getElementById('btn-administrator-permissions-save')?.addEventListener('click', () => {
    saveAdministratorPermissions().catch((error) => {
      log.warn('[Connect] Administrator permission save failed', error);
      showToast(t('error.network_generic'));
    });
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeAdministratorPermissionsDialog();
  });
  overlay.addEventListener('keydown', (event) => {
    if (!overlay.classList.contains('show')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAdministratorPermissionsDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hidden);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function renderConnectDeviceList(list: readonly unknown[]): void {
  const devices = list
    .map(normalizeDeviceInfo)
    .filter((device): device is DeviceInfo => device !== null);
  _lastDeviceList = devices;
  _lastDeviceCount = devices.length;
  _updateDeviceTitles();
  syncDeviceExpansionRoomBoundary();
  const isProRoom = _isProRoom();
  const currentDeviceId = getState('network.myId') || '';
  const deviceById = new Map(
    devices
      .filter((device) => device && typeof device.id === 'string' && device.id)
      .map((device) => [device.id, device] as const),
  );
  const members = groupConnectedRoomMembers(devices, currentDeviceId);
  const renderBoundary = deviceExpansionRoomBoundary();
  const expandableKeys = new Set(
    members.filter((member) => member.deviceCount > 1).map((member) => member.key),
  );
  for (const key of _expandedDeviceMemberKeys) {
    if (!expandableKeys.has(key)) _expandedDeviceMemberKeys.delete(key);
  }
  const administrators = _administratorsForMembers(members);
  const administratorIds = new Set(administrators.map((administrator) => administrator.memberId));
  const ownerIds = new Set(
    administrators
      .filter((administrator) => administrator.isOwner)
      .map((administrator) => administrator.memberId),
  );
  renderAdministratorLists(members);

  const containers = [
    document.getElementById('connect-device-list'),
    document.getElementById('desktop-device-list'),
  ].filter(Boolean) as HTMLElement[];

  containers.forEach((container) => {
    container.setAttribute('role', 'list');
    container.replaceChildren();

    members.forEach((member, memberIndex) => {
      const entry = document.createElement('div');
      entry.setAttribute('role', 'listitem');
      entry.className = 'device-entry';
      entry.dataset.memberKey = member.key;
      entry.dataset.memberId = member.memberId || '';

      const row = document.createElement('div');
      row.className = `device-row${member.isCurrent ? ' is-current-member' : ''}`;
      row.dataset.memberId = member.memberId || '';
      if (member.isCurrent) {
        row.setAttribute('aria-current', 'true');
        row.dataset.currentDeviceRole = member.isCurrentDeviceHost
          ? 'host'
          : member.isCurrentDeviceAdministrator
            ? 'administrator'
            : 'member';
      }

      const orderBadge = document.createElement('span');
      orderBadge.className = 'd-order';
      orderBadge.textContent = `#${member.memberDisplayNumber}`;
      row.appendChild(orderBadge);

      // Account-linked devices collapse into one person row. Identical
      // nicknames from different memberIds still remain separate rows.
      const name = document.createElement('span');
      name.className = 'd-name';
      const nameLabel = document.createElement('span');
      nameLabel.className = 'd-name-label';
      nameLabel.textContent = member.label || t('common.peer');
      applyUserTextFontFallback(nameLabel, nameLabel.textContent);
      name.appendChild(nameLabel);
      row.appendChild(name);

      const authorityKey = memberAuthorityKey(member);
      const isAdministrator = administratorIds.has(authorityKey) || member.isAdministrator;
      const isRoomOwner = ownerIds.has(authorityKey);
      const canManageAdministrators = _canManageAdministrators();
      const canGrant =
        canManageAdministrators &&
        !member.isCurrent &&
        !member.isHost &&
        !isAdministrator &&
        (!isProRoom || !!member.memberId);
      const canKick =
        hasRoomCapability('members.manage') &&
        !member.isCurrent &&
        !member.isHost &&
        !isRoomOwner &&
        (!isAdministrator || canManageAdministrators) &&
        member.status === 'connected';
      const canExpand = member.deviceCount > 1;

      if (canGrant || canKick || canExpand) {
        const actions = document.createElement('div');
        actions.className = 'd-actions';

        if (canGrant) {
          const opBtn = document.createElement('button');
          opBtn.type = 'button';
          opBtn.className = 'd-op-btn administrator-action-button administrator-state-button grant';
          opBtn.dataset.administratorState = 'inactive';
          const grantLabel = t('common.grant');
          opBtn.setAttribute('aria-label', grantLabel);
          opBtn.title = grantLabel;
          opBtn.innerHTML = CROWN_ICON;
          opBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            opBtn.disabled = true;
            grantAdministrator(member)
              .catch((error) => {
                log.warn('[Connect] Could not grant administrator', error);
                showToast(t('error.network_generic'));
              })
              .finally(() => {
                opBtn.disabled = false;
              });
          });
          actions.appendChild(opBtn);
        }

        if (canExpand) {
          const expanded = _expandedDeviceMemberKeys.has(member.key);
          const sublistId = `${container.id}-device-sublist-${memberIndex}`;
          const expandBtn = document.createElement('button');
          expandBtn.type = 'button';
          expandBtn.className = `device-expand-toggle${expanded ? ' active' : ''}`;
          expandBtn.setAttribute('aria-expanded', String(expanded));
          expandBtn.setAttribute('aria-controls', sublistId);
          expandBtn.setAttribute(
            'aria-label',
            t('connect.device_toggle', { name: member.label || t('common.peer') }),
          );
          expandBtn.innerHTML =
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 9 5.5 5.5L17.5 9"/></svg>';
          expandBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleExpandedDeviceMember(member.key);
          });
          actions.appendChild(expandBtn);
        }

        if (canKick) {
          const kickBtn = document.createElement('button');
          kickBtn.type = 'button';
          kickBtn.className = 'btn-kick-device';
          kickBtn.setAttribute('aria-label', t('connect.kick_title'));
          kickBtn.innerHTML =
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
          kickBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const confirmAndKickMember = async (): Promise<void> => {
              const result = await showDialog({
                title: t('connect.kick_title'),
                message: t('connect.kick_member_message', { name: member.label }),
                buttonText: t('connect.kick_yes'),
                secondaryText: t('common.cancel'),
              });
              if (
                result.action !== 'ok' ||
                !hasRoomCapability('members.manage') ||
                isRoomOwner ||
                (isAdministrator && !_canManageAdministrators())
              ) {
                return;
              }
              await kickRoomMember(member);
            };
            confirmAndKickMember().catch((error) => {
              log.warn('[Connect] Could not remove member', error);
              showToast(t('error.network_generic'));
            });
          });
          actions.appendChild(kickBtn);
        }

        row.appendChild(actions);
      }

      entry.appendChild(row);

      if (canExpand) {
        const sublist = document.createElement('ul');
        sublist.id = `${container.id}-device-sublist-${memberIndex}`;
        sublist.className = 'device-sublist';
        sublist.hidden = !_expandedDeviceMemberKeys.has(member.key);

        member.deviceIds.forEach((deviceId, deviceIndex) => {
          const device = deviceById.get(deviceId);
          if (!device) return;
          const isCurrentDevice = device.id === (getState('network.myId') || '');
          const subrow = document.createElement('li');
          subrow.className = `device-subrow${isCurrentDevice ? ' is-current-device' : ''}`;
          subrow.dataset.deviceId = device.id;
          if (isCurrentDevice) subrow.setAttribute('aria-current', 'true');

          const subIndex = document.createElement('span');
          subIndex.className = 'device-sub-index';
          subIndex.textContent = String(deviceIndex + 1);
          subIndex.setAttribute('aria-hidden', 'true');

          const subName = document.createElement('span');
          subName.className = 'device-sub-name';
          const displayName = deviceDisplayName(device);
          subName.textContent = displayName;
          applyUserTextFontFallback(subName, displayName);
          subrow.append(subIndex, subName);

          if (isCurrentDevice) {
            const current = document.createElement('span');
            current.className = 'sr-only';
            current.textContent = `, ${t('connect.current_device')}`;
            subrow.appendChild(current);
          }

          const ownAuthenticatedSibling =
            member.isCurrent &&
            member.isAuthenticated &&
            isAuthenticatedSiblingDevice(deviceById.get(currentDeviceId), device);
          const canKickPhysicalDevice =
            hasRoomCapability('members.manage') &&
            !isCurrentDevice &&
            device.status === 'connected' &&
            (ownAuthenticatedSibling ? isProRoom || device.isHost !== true : canKick);
          if (canKickPhysicalDevice) {
            const kickDeviceBtn = document.createElement('button');
            kickDeviceBtn.type = 'button';
            kickDeviceBtn.className = 'btn-kick-physical-device';
            kickDeviceBtn.setAttribute('aria-label', `${t('connect.kick_title')}: ${displayName}`);
            kickDeviceBtn.innerHTML =
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
            kickDeviceBtn.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              const confirmAndKickPhysicalDevice = async (): Promise<void> => {
                if (deviceExpansionRoomBoundary() !== renderBoundary) return;
                const result = await showDialog({
                  title: t('connect.kick_title'),
                  message: t('connect.kick_message', { name: displayName }),
                  buttonText: t('connect.kick_yes'),
                  secondaryText: t('common.cancel'),
                });
                if (
                  result.action !== 'ok' ||
                  !hasRoomCapability('members.manage') ||
                  deviceExpansionRoomBoundary() !== renderBoundary
                ) {
                  return;
                }

                // The confirmation dialog can outlive a room switch or a
                // heartbeat update. Re-resolve every identity and authority
                // decision from the latest projection before dispatching.
                const latestDevices = _lastDeviceList;
                const latestDeviceById = new Map(
                  latestDevices
                    .filter((candidate) => candidate && typeof candidate.id === 'string')
                    .map((candidate) => [candidate.id, candidate] as const),
                );
                const latestCurrentDeviceId = getState('network.myId') || '';
                const latestTarget = latestDeviceById.get(device.id);
                if (
                  !latestTarget ||
                  latestTarget.id === latestCurrentDeviceId ||
                  latestTarget.status !== 'connected'
                ) {
                  return;
                }

                const latestMembers = groupConnectedRoomMembers(
                  latestDevices,
                  latestCurrentDeviceId,
                );
                const latestMember = latestMembers.find((candidate) =>
                  candidate.deviceIds.includes(latestTarget.id),
                );
                if (!latestMember) return;
                const latestAdministrators = _administratorsForMembers(latestMembers);
                const latestAuthorityKey = memberAuthorityKey(latestMember);
                const latestIsAdministrator =
                  latestMember.isAdministrator ||
                  latestAdministrators.some(
                    (administrator) => administrator.memberId === latestAuthorityKey,
                  );
                const latestIsRoomOwner = latestAdministrators.some(
                  (administrator) =>
                    administrator.isOwner && administrator.memberId === latestAuthorityKey,
                );
                const ownAuthenticatedSiblingNow =
                  latestMember.isCurrent &&
                  latestMember.isAuthenticated &&
                  isAuthenticatedSiblingDevice(
                    latestDeviceById.get(latestCurrentDeviceId),
                    latestTarget,
                  );
                if (
                  ownAuthenticatedSiblingNow
                    ? !_isProRoom() && latestTarget.isHost === true
                    : latestMember.isCurrent ||
                      latestMember.isHost ||
                      latestTarget.isHost === true ||
                      latestIsRoomOwner ||
                      (latestIsAdministrator && !_canManageAdministrators())
                ) {
                  return;
                }
                await kickRoomPhysicalDevice(latestTarget);
              };
              confirmAndKickPhysicalDevice().catch((error) => {
                log.warn('[Connect] Could not disconnect physical device', error);
                showToast(t('error.network_generic'));
              });
            });
            subrow.appendChild(kickDeviceBtn);
          }

          sublist.appendChild(subrow);
        });

        entry.appendChild(sublist);
      }

      container.appendChild(entry);
    });
  });
}

// ─── Lifecycle ──────────────────────────────────────────────────────

const _busScope = createBusScope();

export function initConnect(): void {
  _busScope.dispose();

  initSignalingRecoveryDialog();
  renderSignalingRecoveryControls();
  initRoomPasswordControls();
  initAdministratorPermissionsDialog();
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

  const initialRoomContext = getRoomContext();
  let connectAuthorityBoundary = {
    kind: initialRoomContext.kind,
    roomId: initialRoomContext.roomId,
    canManageAdministrators: _canManageAdministrators(),
    canKickMembers: hasRoomCapability('members.manage'),
  };

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
    renderConnectDeviceList(_lastDeviceList);
    renderSignalingRecoveryControls();
    syncSignalingRecoveryDialogCopy();
  });

  _busScope.on('network:device-list-update', (list: unknown[]) => {
    if (Array.isArray(list)) {
      renderConnectDeviceList(list);
    }
  });
  _busScope.on('state:network.standardRoomAdministrators', () => {
    if (!_isProRoom()) renderConnectDeviceList(_lastDeviceList);
  });
  _busScope.on('state:network.myId', () => renderConnectDeviceList(_lastDeviceList));
  _busScope.on('pro-room:administrators-updated', (administrators) => {
    _lastProAdministrators = administrators.map((administrator) => ({
      ...administrator,
      permissions: clonePermissions(administrator.permissions),
      inheritedPermissions: [...administrator.inheritedPermissions],
    }));
    if (_isProRoom()) renderConnectDeviceList(_lastDeviceList);
  });

  // sessionCode is set before sessionStarted — both trigger QR refresh
  _busScope.on('state:network.sessionCode', () => {
    refreshAllQR();
    renderSignalingRecoveryControls();
  });
  _busScope.on('state:setup.sessionStarted', () => {
    refreshAllQR();
    syncRoomPasswordControls();
    syncHostOwnedConnectSections();
    renderSignalingRecoveryControls();
  });
  _busScope.on('state:network.roomPasswordRequired', () => syncRoomPasswordControls());
  _busScope.on('state:network.roomPassword', () => syncRoomPasswordControls());
  _busScope.on('state:network.hostConn', () => {
    syncRoomPasswordControls();
    syncHostOwnedConnectSections();
    renderSignalingRecoveryControls();
  });
  _busScope.on('state:network.appRole', () => {
    syncRoomPasswordControls();
    syncHostOwnedConnectSections();
    renderSignalingRecoveryControls();
  });
  _busScope.on('state:network.signalingHealth', renderSignalingRecoveryControls);
  _busScope.on('state:room.context', () => {
    syncRoomPasswordControls();
    syncHostOwnedConnectSections();
    renderSignalingRecoveryControls();
    const roomContext = getRoomContext();
    const nextAuthorityBoundary = {
      kind: roomContext.kind,
      roomId: roomContext.roomId,
      canManageAdministrators: _canManageAdministrators(),
      canKickMembers: hasRoomCapability('members.manage'),
    };
    const dialogRoomChanged =
      _permissionDialogRoomBoundary !== null &&
      (_permissionDialogRoomBoundary.kind !== roomContext.kind ||
        _permissionDialogRoomBoundary.roomId !== roomContext.roomId ||
        _permissionDialogRoomBoundary.epoch !== roomContext.epoch);
    if (dialogRoomChanged || (_permissionDialogTarget && !_canManageAdministrators())) {
      invalidateAdministratorPermissionsDialog();
    }
    const authorityPresentationChanged =
      connectAuthorityBoundary.kind !== nextAuthorityBoundary.kind ||
      connectAuthorityBoundary.roomId !== nextAuthorityBoundary.roomId ||
      connectAuthorityBoundary.canManageAdministrators !==
        nextAuthorityBoundary.canManageAdministrators ||
      connectAuthorityBoundary.canKickMembers !== nextAuthorityBoundary.canKickMembers;
    connectAuthorityBoundary = nextAuthorityBoundary;
    if (!authorityPresentationChanged) return;

    if (!_isProRoom()) {
      _lastProAdministrators = [];
      renderConnectDeviceList(_lastDeviceList);
      return;
    }
    void import('../pro-room/runtime.ts')
      .then(({ getActiveProRoomAdministrators }) => {
        if (!_isProRoom()) return;
        _lastProAdministrators = getActiveProRoomAdministrators();
        renderConnectDeviceList(_lastDeviceList);
      })
      .catch((error) => {
        log.warn('[Connect] Could not refresh PRO administrators after authority change', error);
        if (!_isProRoom()) return;
        // Do not leave a previous room's authority projection on screen after
        // a deploy-skew/offline chunk failure.
        _lastProAdministrators = [];
        renderConnectDeviceList(_lastDeviceList);
        showToast(t('error.network_generic'));
      });
  });

  // Leave Session buttons (mobile + desktop)
  const leaveHandler = () => {
    showDialog({
      title: t('dialog.return_home_title'),
      message: `${t('dialog.return_home_msg')}\n${t('dialog.return_home_detail')}`,
      buttonText: t('common.ok'),
      secondaryText: t('common.cancel'),
    })
      .then((res) => {
        if (res && res.action === 'ok') {
          scheduleSessionReset(t('dialog.leaving_session'), navigateToAppHome);
        }
      })
      .catch((error) => {
        log.warn('[Connect] Leave-session dialog failed', error);
      });
  };
  document.getElementById('btn-leave-session')?.addEventListener('click', leaveHandler);
  document.getElementById('desktop-btn-leave-session')?.addEventListener('click', leaveHandler);

  // Account nickname buttons (mobile + desktop)
  const nicknameChangeHandler = () => {
    requestAccountNicknameChange().catch((error) => {
      log.warn('[Connect] Account nickname change failed', error);
      showToast(t('error.network_generic'));
    });
  };
  document.getElementById('btn-change-nickname')?.addEventListener('click', nicknameChangeHandler);
  document
    .getElementById('desktop-btn-change-nickname')
    ?.addEventListener('click', nicknameChangeHandler);

  // Initial render
  refreshAllQR();
  renderConnectDeviceList(_lastDeviceList);

  log.info('[Connect] Initialized');
}

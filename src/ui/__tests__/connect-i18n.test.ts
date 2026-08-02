/**
 * @vitest-environment jsdom
 */
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { setLanguageMode } from '../../i18n/index.ts';
import type { DataConnection, RoomContext } from '../../types/index.ts';
import {
  changeActiveProRoomPin,
  getActiveProRoomAdministrators,
  kickActiveProRoomMember,
  kickActiveProRoomPresence,
  revokeActiveProRoomAdministrator,
  updateActiveProRoomAdministrator,
} from '../../pro-room/runtime.ts';
import { showToast } from '../toast.ts';
import { showDialog, type DialogResult } from '../dialog.ts';
import { copyTextToClipboard } from '../dom.ts';
import { initConnect } from '../connect.ts';
import { retryPeerSignalingConnection } from '../../network/peer.ts';
import { restartProRoomTransportRecovery } from '../../pro-room/transport-recovery.ts';
import { __resetAccountStateForTests, applyAccountSession } from '../../account/state.ts';
import type { ProRoomAdministrator } from '../../pro-room/contracts.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

vi.mock('../dialog.ts', () => ({
  showDialog: vi.fn(),
}));

vi.mock('../dom.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dom.ts')>();
  return {
    ...actual,
    copyTextToClipboard: vi.fn(async () => true),
  };
});

vi.mock('../../network/peer.ts', () => ({
  retryPeerSignalingConnection: vi.fn(() => true),
}));

vi.mock('../../pro-room/transport-recovery.ts', () => ({
  restartProRoomTransportRecovery: vi.fn(() => true),
}));

vi.mock('../../pro-room/runtime.ts', () => ({
  changeActiveProRoomPin: vi.fn(),
  getActiveProRoomAdministrators: vi.fn(() => []),
  kickActiveProRoomMember: vi.fn(),
  kickActiveProRoomPresence: vi.fn(),
  revokeActiveProRoomAdministrator: vi.fn(),
  updateActiveProRoomAdministrator: vi.fn(),
}));

const mockedShowDialog = vi.mocked(showDialog);
const mockedCopyTextToClipboard = vi.mocked(copyTextToClipboard);
const mockedRetryPeerSignalingConnection = vi.mocked(retryPeerSignalingConnection);
const mockedRestartProRoomTransportRecovery = vi.mocked(restartProRoomTransportRecovery);
const mockedChangeActiveProRoomPin = vi.mocked(changeActiveProRoomPin);
const mockedGetActiveProRoomAdministrators = vi.mocked(getActiveProRoomAdministrators);
const mockedKickActiveProRoomMember = vi.mocked(kickActiveProRoomMember);
const mockedKickActiveProRoomPresence = vi.mocked(kickActiveProRoomPresence);
const mockedRevokeActiveProRoomAdministrator = vi.mocked(revokeActiveProRoomAdministrator);
const mockedUpdateActiveProRoomAdministrator = vi.mocked(updateActiveProRoomAdministrator);
const FULL_ADMIN_PERMISSIONS_FOR_TEST = {
  'media.add': true,
  'playback.control': true,
  'members.kick': true,
  'chat.notice': true,
} as const;

beforeEach(() => {
  __resetAccountStateForTests();
  applyAccountSession({
    configured: true,
    authenticated: true,
    account: { nickname: 'Tester', profileComplete: true },
    statsScope: 's'.repeat(43),
  });
  resetState();
  bus.clear();
  vi.clearAllMocks();
  mockedCopyTextToClipboard.mockResolvedValue(true);
  mockedRetryPeerSignalingConnection.mockReturnValue(true);
  mockedRestartProRoomTransportRecovery.mockReturnValue(true);
  localStorage.clear();
  document.body.innerHTML = `
    <div id="qr-container"></div>
    <div id="desktop-qr-container"></div>
    <div class="section-group room-password-section">
      <span class="section-title" data-i18n="connect.room_password_title"></span>
      <button type="button" class="room-password-toggle" id="room-password-toggle">
        <span class="room-password-toggle-knob"></span>
      </button>
      <span id="room-password-code"></span>
      <button type="button" class="room-password-refresh" id="room-password-refresh">
        <svg><path d="refresh"></path></svg>
      </button>
      <div id="room-password-code-row"></div>
    </div>
    <div id="connect-device-title"></div>
    <div id="desktop-device-title"></div>
    <section id="connect-administrator-section" hidden>
      <div id="connect-administrator-title"></div>
      <div id="connect-administrator-list"></div>
    </section>
    <section id="desktop-administrator-section" hidden>
      <div id="desktop-administrator-title"></div>
      <div id="desktop-administrator-list"></div>
    </section>
    <div id="connect-device-list"></div>
    <div id="desktop-device-list"></div>
    <button id="btn-change-nickname"></button>
    <button id="desktop-btn-change-nickname"></button>
    <div id="signaling-recovery-overlay" aria-hidden="true">
      <div
        id="signaling-recovery-dialog"
        role="dialog"
        aria-busy="false"
        data-state="failed"
        tabindex="-1"
      >
        <span id="signaling-recovery-title"></span>
        <div id="signaling-recovery-message"></div>
        <div id="signaling-recovery-actions">
          <button id="btn-signaling-recovery-confirm"></button>
          <button id="btn-signaling-recovery-retry"></button>
        </div>
      </div>
    </div>
    <div id="administrator-permissions-overlay" aria-hidden="true">
      <div
        id="administrator-permissions-dialog"
        aria-busy="false"
        aria-labelledby="administrator-permissions-title"
      >
        <span id="administrator-permissions-title"></span>
        <button data-administrator-permission="media.add" role="switch" aria-checked="false"></button>
        <button data-administrator-permission="playback.control" role="switch" aria-checked="false">
          <small class="administrator-permission-inherited" hidden></small>
        </button>
        <button data-administrator-permission="members.kick" role="switch" aria-checked="false"></button>
        <button data-administrator-permission="chat.notice" role="switch" aria-checked="false"></button>
        <button id="btn-administrator-permissions-cancel"></button>
        <button id="btn-administrator-permissions-save"></button>
      </div>
    </div>
  `;
  setLanguageMode('ko');
});

function makeConnection(peer = 'host-1'): DataConnection {
  return { peer, open: true } as DataConnection;
}

async function startHostSessionWithQR(): Promise<HTMLButtonElement> {
  setState('network.appRole', 'host');
  initConnect();
  setState('network.sessionCode', '123456');
  setState('setup.sessionStarted', true);
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.btn-copy-invite-link')).toHaveLength(2);
  });
  return document.querySelector<HTMLButtonElement>('.btn-copy-invite-link')!;
}

describe('connect signaling health status', () => {
  it('keeps a shared Material Elastic spinner in generated recovery buttons', async () => {
    const button = await startHostSessionWithQR();
    const spinner = button.querySelector<HTMLElement>(
      '.signaling-recovery-spinner.material-elastic-spinner',
    );

    expect(spinner).not.toBeNull();
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(spinner?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 44 44');
    expect(spinner?.querySelector('circle')?.getAttribute('r')).toBe('18');
    expect(spinner?.querySelector('circle')?.getAttribute('pathLength')).toBe('100');
    expect(button.querySelector('span[data-i18n]')?.textContent).toBe('초대 링크 복사하기');
  });

  it('shows a compact healthy status only while a room is active', () => {
    initConnect();
    const initialStatuses = document.querySelectorAll<HTMLElement>('.signaling-health-status');
    expect(initialStatuses).toHaveLength(2);
    for (const status of initialStatuses) expect(status.hidden).toBe(true);

    setState('network.appRole', 'host');
    setState('network.sessionCode', '123456');
    setState('setup.sessionStarted', true);

    const statuses = document.querySelectorAll<HTMLElement>('.signaling-health-status');
    for (const status of statuses) {
      expect(status.hidden).toBe(false);
      expect(status.dataset.status).toBe('healthy');
      expect(status.textContent).toBe('연결 서버 정상');
    }
  });

  it('maps reconnecting to yellow recovery copy and recovered back to healthy', () => {
    setState('setup.sessionStarted', true);
    setState('network.appRole', 'guest');
    setState('network.sessionCode', '123456');
    setState('network.hostConn', makeConnection());
    initConnect();

    setState('network.signalingHealth', {
      status: 'reconnecting',
      attempt: 2,
      maxAttempts: 5,
    });

    const statuses = document.querySelectorAll<HTMLElement>('.signaling-health-status');
    expect(statuses).toHaveLength(2);
    for (const status of statuses) {
      expect(status.hidden).toBe(false);
      expect(status.getAttribute('role')).toBeNull();
      const message = status.querySelector<HTMLElement>('.signaling-health-message');
      expect(message?.getAttribute('role')).toBe('status');
      expect(message?.getAttribute('aria-live')).toBe('polite');
      expect(message?.getAttribute('aria-atomic')).toBe('true');
      expect(message?.getAttribute('aria-busy')).toBe('true');
      expect(status.dataset.status).toBe('reconnecting');
      expect(status.textContent).toBe('연결 복구 중');
    }

    setState('network.signalingHealth', {
      status: 'recovered',
      attempt: 0,
      maxAttempts: 5,
    });

    for (const status of statuses) {
      expect(status.hidden).toBe(false);
      expect(status.dataset.status).toBe('healthy');
      expect(status.textContent).toBe('연결 서버 정상');
      expect(
        status.querySelector<HTMLElement>('.signaling-health-message')?.getAttribute('aria-busy'),
      ).toBe('false');
    }
  });

  it('replaces both invite buttons with one recovery action after exhaustion', async () => {
    await startHostSessionWithQR();
    setState('network.signalingHealth', {
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });

    const status = document.querySelector<HTMLElement>('.signaling-health-status');
    const message = status?.querySelector<HTMLElement>('.signaling-health-message');
    expect(status?.hidden).toBe(false);
    expect(status?.dataset.status).toBe('exhausted');
    expect(status?.textContent).toBe('연결 복구 실패');
    expect(message?.getAttribute('aria-busy')).toBe('false');
    expect(status?.querySelector('.signaling-health-actions')).toBeNull();
    bus.emit('ui:connect-tab-opened');
    await vi.waitFor(() => {
      const regenerated = document.querySelectorAll<HTMLButtonElement>('.btn-copy-invite-link');
      expect(regenerated).toHaveLength(2);
      for (const button of regenerated) expect(button.dataset.mode).toBe('recover');
    });
    const buttons = document.querySelectorAll<HTMLButtonElement>('.btn-copy-invite-link');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      const status = button.previousElementSibling as HTMLElement | null;
      expect(status?.classList.contains('signaling-health-status')).toBe(true);
      expect(status?.parentElement).toBe(button.parentElement);
      expect(status?.previousElementSibling?.classList.contains('qr-svg')).toBe(true);
      expect(button.dataset.mode).toBe('recover');
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-disabled')).toBe('false');
      expect(button.textContent).toBe('복구');
    }
  });

  it('uses the unboxed MUSIXQUARE status row and dedicated recovery dialog shell', async () => {
    const [stylesheet, markup, domSource] = await Promise.all([
      readFile('css/style.css', 'utf8'),
      readFile('index.html', 'utf8'),
      readFile('src/ui/dom.ts', 'utf8'),
    ]);
    const statusRules = stylesheet.match(/\.signaling-health-status\s*\{([^}]*)\}/)?.[1] ?? '';
    const qrContainerRules = stylesheet.match(/\.qr-container\s*\{([^}]*)\}/)?.[1] ?? '';
    const inviteButtonRules = stylesheet.match(/\.btn-copy-invite-link\s*\{([^}]*)\}/)?.[1] ?? '';
    const recoveryButtonRules =
      stylesheet.match(
        /\.btn-copy-invite-link\[data-mode='recover'\],\s*\.btn-copy-invite-link\[data-mode='recovering'\]\s*\{([^}]*)\}/,
      )?.[1] ?? '';
    const recoveringIconRules =
      stylesheet.match(
        /\.btn-copy-invite-link\[data-mode='recovering'\] > svg\s*\{([^}]*)\}/,
      )?.[1] ?? '';
    const recoveringSpinnerRules =
      stylesheet.match(/\.signaling-recovery-spinner\s*\{([^}]*)\}/)?.[1] ?? '';
    const activeRecoveringSpinnerRules =
      stylesheet.match(
        /\.btn-copy-invite-link\[data-mode='recovering'\] \.signaling-recovery-spinner\s*\{([^}]*)\}/,
      )?.[1] ?? '';

    expect(qrContainerRules).toContain('gap: 12px');
    expect(statusRules).toContain('display: flex');
    expect(statusRules).toContain('justify-content: center');
    expect(statusRules).toContain('gap: 11px');
    expect(statusRules).toContain('margin: 0');
    expect(inviteButtonRules).toContain('margin: 0');
    expect(inviteButtonRules).toContain('border: none');
    expect(recoveryButtonRules).toContain('border: none');
    expect(recoveryButtonRules).toContain('background: rgba(245, 158, 11, 0.08)');
    expect(recoveryButtonRules).toContain('color: var(--warning-filled)');
    expect(recoveryButtonRules).toContain('box-shadow: none');
    expect(statusRules).toContain('color: var(--text-main)');
    expect(statusRules).toContain('font-weight: 600');
    expect(statusRules).toContain('transform: translateY(-8px)');
    expect(stylesheet).toContain('box-shadow: 0 0 0 4px rgba(32, 164, 90, 0.12)');
    expect(stylesheet).toContain('box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.13)');
    expect(stylesheet).toContain('box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.12)');
    expect(statusRules).not.toContain('border:');
    expect(statusRules).not.toContain('background:');
    expect(stylesheet).toContain(
      ".signaling-health-status[data-status='exhausted'] .signaling-health-indicator",
    );
    expect(stylesheet).toContain('background: var(--danger-filled)');
    expect(stylesheet).not.toContain(
      '.signaling-health-status:not([hidden]) + .btn-copy-invite-link',
    );
    expect(recoveringIconRules).toContain('display: none');
    expect(recoveringIconRules).not.toContain('animation:');
    expect(recoveringSpinnerRules).toContain('--material-elastic-size: 20px');
    expect(recoveringSpinnerRules).toContain('display: none');
    expect(activeRecoveringSpinnerRules).toContain('display: block');
    expect(stylesheet).not.toContain(".btn-copy-invite-link[data-mode='recovering']::before");
    expect(stylesheet).toContain('@keyframes material-elastic-dash');
    expect(markup).toContain('id="signaling-recovery-overlay"');
    expect(markup).toContain('aria-labelledby="signaling-recovery-title"');
    expect(markup).not.toContain('signaling-recovery-visual');
    expect(domSource).toContain("{ id: 'signaling-recovery-overlay', cls: 'show'");
    expect(stylesheet).not.toContain(".signaling-recovery-dialog[data-state='retrying']");
    expect(stylesheet).not.toContain('.signaling-recovery-header');
    expect(stylesheet).toContain(
      "[data-theme='light'] .btn-copy-invite-link[data-mode='copy']:hover",
    );
    expect(stylesheet).not.toContain("[data-theme='light'] .btn-copy-invite-link:hover");
  });

  it('opens the requested failure dialog only after a manual recovery fails', async () => {
    const button = await startHostSessionWithQR();
    setState('network.signalingHealth', {
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });
    mockedRetryPeerSignalingConnection.mockImplementationOnce(() => {
      setState('network.signalingHealth', {
        status: 'reconnecting',
        attempt: 1,
        maxAttempts: 5,
      });
      return true;
    });

    button.focus();
    button.click();
    // Re-rendering while the dynamic import is still pending must not treat
    // the inherited exhausted state as the result of the new retry.
    setState('network.signalingHealth', {
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });
    expect(document.activeElement).toBe(button);
    expect(document.getElementById('signaling-recovery-overlay')?.classList.contains('show')).toBe(
      false,
    );
    await vi.waitFor(() => expect(mockedRetryPeerSignalingConnection).toHaveBeenCalledOnce());
    expect(mockedCopyTextToClipboard).not.toHaveBeenCalled();
    expect(button.dataset.mode).toBe('recovering');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(document.getElementById('signaling-recovery-overlay')?.classList.contains('show')).toBe(
      false,
    );

    setState('network.signalingHealth', {
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });

    const overlay = document.getElementById('signaling-recovery-overlay')!;
    expect(overlay.classList.contains('show')).toBe(true);
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(document.getElementById('signaling-recovery-dialog')?.dataset.state).toBe('failed');
    expect(document.getElementById('signaling-recovery-title')?.textContent).toBe('연결 복구 실패');
    expect(document.getElementById('signaling-recovery-message')?.textContent).toBe(
      '연결 서버가 응답하지 않아요.\n새 참여자를 초대할 수 없어요.',
    );
    expect(document.getElementById('btn-signaling-recovery-confirm')?.textContent).toBe('확인');
    expect(document.getElementById('btn-signaling-recovery-retry')?.textContent).toBe('재시도');

    document.getElementById('btn-signaling-recovery-confirm')?.click();
    expect(overlay.classList.contains('show')).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(getState('network.sessionCode')).toBe('123456');
    expect(getState('setup.sessionStarted')).toBe(true);
    expect(getState('network.signalingHealth').status).toBe('exhausted');
  });

  it('restores focus when QR refresh replaces an in-flight recovery trigger', async () => {
    const originalButton = await startHostSessionWithQR();
    setState('network.signalingHealth', {
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });
    mockedRetryPeerSignalingConnection.mockImplementationOnce(() => {
      setState('network.signalingHealth', {
        status: 'reconnecting',
        attempt: 1,
        maxAttempts: 5,
      });
      return true;
    });

    originalButton.focus();
    originalButton.click();
    await vi.waitFor(() => expect(mockedRetryPeerSignalingConnection).toHaveBeenCalledOnce());

    bus.emit('ui:connect-tab-opened');
    await vi.waitFor(() => {
      const replacement = document.querySelector<HTMLButtonElement>('.btn-copy-invite-link');
      expect(replacement).not.toBe(originalButton);
      expect(document.activeElement).toBe(replacement);
      expect(replacement?.getAttribute('aria-disabled')).toBe('true');
    });
  });

  it('keeps the same recovery action available to a PRO room member', async () => {
    setState('network.appRole', 'guest');
    setState('room.context', {
      kind: 'pro',
      roomId: '123456',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    initConnect();
    setState('network.sessionCode', '123456');
    setState('setup.sessionStarted', true);
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.btn-copy-invite-link')).toHaveLength(2);
    });
    setState('network.signalingHealth', {
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });
    mockedRestartProRoomTransportRecovery.mockImplementationOnce(() => {
      setState('network.signalingHealth', {
        status: 'reconnecting',
        attempt: 1,
        maxAttempts: 5,
      });
      return true;
    });

    document.querySelector<HTMLButtonElement>('.btn-copy-invite-link')?.click();
    await vi.waitFor(() => expect(mockedRestartProRoomTransportRecovery).toHaveBeenCalledOnce());
    expect(mockedRetryPeerSignalingConnection).not.toHaveBeenCalled();

    const currentRoom = getState('room.context');
    setState('room.context', {
      ...currentRoom,
      epoch: currentRoom.epoch + 1,
      snapshotRevision: currentRoom.snapshotRevision + 1,
    });
    expect(document.querySelector<HTMLButtonElement>('.btn-copy-invite-link')?.dataset.mode).toBe(
      'recovering',
    );

    setState('network.signalingHealth', {
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });
    expect(document.getElementById('signaling-recovery-overlay')?.classList.contains('show')).toBe(
      true,
    );
  });

  it('closes the failure modal during retry and reopens it only after another failure', async () => {
    const button = await startHostSessionWithQR();
    const reconnecting = () => {
      setState('network.signalingHealth', {
        status: 'reconnecting',
        attempt: 1,
        maxAttempts: 5,
      });
      return true;
    };
    mockedRetryPeerSignalingConnection.mockImplementation(reconnecting);
    setState('network.signalingHealth', {
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });

    button.click();
    await vi.waitFor(() => expect(mockedRetryPeerSignalingConnection).toHaveBeenCalledTimes(1));
    setState('network.signalingHealth', {
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });

    document.getElementById('btn-signaling-recovery-retry')?.click();
    const overlay = document.getElementById('signaling-recovery-overlay')!;
    const dialog = document.getElementById('signaling-recovery-dialog')!;
    const actions = document.getElementById('signaling-recovery-actions')!;
    expect(overlay.classList.contains('show')).toBe(false);
    expect(button.dataset.mode).toBe('recovering');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    await vi.waitFor(() => expect(mockedRetryPeerSignalingConnection).toHaveBeenCalledTimes(2));

    setState('network.signalingHealth', {
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });
    expect(overlay.classList.contains('show')).toBe(true);
    expect(dialog.dataset.state).toBe('failed');
    expect(dialog.getAttribute('aria-busy')).toBe('false');
    expect(actions.hidden).toBe(false);

    document.getElementById('btn-signaling-recovery-retry')?.click();
    await vi.waitFor(() => expect(mockedRetryPeerSignalingConnection).toHaveBeenCalledTimes(3));
    expect(overlay.classList.contains('show')).toBe(false);
    expect(button.dataset.mode).toBe('recovering');
    setState('network.signalingHealth', {
      status: 'recovered',
      attempt: 0,
      maxAttempts: 5,
    });

    expect(overlay.classList.contains('show')).toBe(false);
    expect(button.dataset.mode).toBe('copy');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('초대 링크 복사하기');
  });
});

describe('connect i18n refresh', () => {
  it('keeps generated QR placeholders translatable', () => {
    initConnect();

    const placeholder = document.querySelector<HTMLElement>('#qr-container .qr-placeholder');
    expect(placeholder?.getAttribute('data-i18n')).toBe('connect.no_session');

    setLanguageMode('en');

    expect(placeholder?.textContent).toBe('Start a session first');
  });

  it('rerenders dynamic device actions on language changes', () => {
    setState('network.appRole', 'host');
    initConnect();

    bus.emit('network:device-list-update', [
      { id: 'peer-1', label: '', joinOrder: 1, status: 'connected', isHost: false, isOp: false },
    ]);

    setLanguageMode('en');

    expect(document.querySelector<HTMLElement>('.d-name')?.textContent).toContain('Peer');
    expect(document.querySelector<HTMLButtonElement>('.d-op-btn')?.textContent).toBe('Grant');
    expect(document.querySelector<HTMLButtonElement>('.btn-kick-device')?.ariaLabel).toBe(
      'Kick device',
    );
  });

  it('removes inline ADMIN badges and keeps authority in the dedicated section', () => {
    setState('network.appRole', 'host');
    initConnect();

    const deviceList = [
      {
        id: 'peer-1',
        label: 'Peer 1',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: true,
      },
    ];
    setState('network.lastKnownDeviceList', deviceList);
    bus.emit('network:device-list-update', deviceList);

    expect(document.querySelector('.d-op-badge')).toBeNull();
    expect(document.querySelector('.d-op-btn')).toBeNull();

    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'host-1',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage'],
    });

    expect(document.querySelector('.d-op-badge')).toBeNull();
    expect(document.querySelector('.d-op-btn')).toBeNull();
  });

  it('lets a capable PRO member request another member kick through the room server', async () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'controller-device');
    setState('network.hostConn', null);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage'],
    });
    mockedShowDialog.mockResolvedValue({ action: 'ok' });
    initConnect();
    bus.emit('pro-room:administrators-updated', [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
      {
        memberId: 'controller-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        displayName: 'Me',
        role: 'controller',
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': false,
        },
        inheritedPermissions: ['playback.control'],
        onlineDeviceCount: 1,
      },
    ]);

    bus.emit('network:device-list-update', [
      {
        id: 'controller-device',
        label: 'Me',
        joinOrder: 0,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'controller-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
      },
      {
        id: 'target-device',
        label: 'Friend',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: false,
        memberId: 'target-member',
        memberDisplayNumber: 2,
        isAuthenticated: true,
      },
      {
        id: 'offline-member',
        label: 'Offline',
        joinOrder: 2,
        status: 'disconnected',
        isHost: false,
        isOp: false,
        memberId: 'offline-member',
        memberDisplayNumber: 3,
        isAuthenticated: true,
      },
    ]);

    const kickButtons = document.querySelectorAll<HTMLButtonElement>('.btn-kick-device');
    expect(kickButtons).toHaveLength(2);
    kickButtons[0]?.click();

    expect(mockedShowDialog).toHaveBeenCalledWith({
      title: '강제퇴장 시키기',
      message: 'Friend 님과 연결된 모든 기기를 내보낼까요?',
      buttonText: '내보내기',
      secondaryText: '취소',
    });

    await vi.waitFor(() =>
      expect(mockedKickActiveProRoomMember).toHaveBeenCalledWith('target-member'),
    );
  });

  it('lets the PRO owner atomically kick an online administrator', async () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-device');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage', 'room.configure'],
    });
    mockedShowDialog.mockResolvedValue({ action: 'ok' });
    initConnect();
    bus.emit('pro-room:administrators-updated', [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
      {
        memberId: 'admin-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        displayName: 'Admin',
        role: 'controller',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: ['playback.control'],
        onlineDeviceCount: 1,
      },
    ]);
    bus.emit('network:device-list-update', [
      {
        id: 'owner-device',
        label: 'Owner',
        joinOrder: 0,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
      },
      {
        id: 'admin-device',
        label: 'Admin',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'admin-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
      },
    ]);

    document
      .querySelector<HTMLButtonElement>(
        '#connect-device-list [data-member-id="admin-member"] .btn-kick-device',
      )
      ?.click();

    await vi.waitFor(() =>
      expect(mockedKickActiveProRoomMember).toHaveBeenCalledWith('admin-member'),
    );
  });

  it('keeps another administrator protected from a delegated PRO administrator', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'controller-device');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage'],
    });
    initConnect();
    bus.emit('pro-room:administrators-updated', [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 0,
      },
      {
        memberId: 'controller-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        displayName: 'Me',
        role: 'controller',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: ['playback.control'],
        onlineDeviceCount: 1,
      },
      {
        memberId: 'other-admin',
        memberDisplayNumber: 2,
        isAuthenticated: true,
        displayName: 'Other admin',
        role: 'controller',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: ['playback.control'],
        onlineDeviceCount: 1,
      },
    ]);
    bus.emit('network:device-list-update', [
      {
        id: 'controller-device',
        label: 'Me',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'controller-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
      },
      {
        id: 'other-admin-device',
        label: 'Other admin',
        joinOrder: 2,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'other-admin',
        memberDisplayNumber: 2,
        isAuthenticated: true,
      },
      {
        id: 'ordinary-device',
        label: 'Ordinary member',
        joinOrder: 3,
        status: 'connected',
        isHost: false,
        isOp: false,
        memberId: 'ordinary-member',
        memberDisplayNumber: 3,
        isAuthenticated: true,
      },
    ]);

    expect(
      document.querySelector(
        '#connect-device-list [data-member-id="other-admin"] .btn-kick-device',
      ),
    ).toBeNull();
    expect(
      document.querySelector(
        '#connect-device-list [data-member-id="ordinary-member"] .btn-kick-device',
      ),
    ).not.toBeNull();
  });

  it('lets the ordinary-room host atomically kick an online administrator', async () => {
    setState('network.appRole', 'host');
    setState('network.myId', 'host-device');
    setState(
      'network.standardRoomAdministrators',
      new Map([
        [
          'admin-member',
          {
            memberId: 'admin-member',
            memberDisplayNumber: 1,
            isAuthenticated: true,
            displayName: 'Admin',
            permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
          },
        ],
      ]),
    );
    mockedShowDialog.mockResolvedValue({ action: 'ok' });
    const kick = vi.fn();
    bus.on('network:request-kick-standard-room-member', kick);
    initConnect();
    bus.emit('network:device-list-update', [
      {
        id: 'host-device',
        label: 'Host',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
      },
      {
        id: 'admin-device',
        label: 'Admin',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'admin-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
      },
    ]);

    document
      .querySelector<HTMLButtonElement>(
        '#connect-device-list [data-member-id="admin-member"] .btn-kick-device',
      )
      ?.click();

    await vi.waitFor(() => expect(kick).toHaveBeenCalledWith({ memberId: 'admin-member' }));
  });

  it('never exposes PRO member management to an ordinary-room guest', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'ordinary-guest');
    setState('network.hostConn', makeConnection('123456'));
    initConnect();

    bus.emit('network:device-list-update', [
      {
        id: '123456',
        label: 'Host',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
      },
      {
        id: 'other-guest',
        label: 'Other',
        joinOrder: 2,
        status: 'connected',
        isHost: false,
        isOp: false,
      },
    ]);

    expect(document.querySelector('.btn-kick-device')).toBeNull();
  });
});

describe('member-level connection and administrator UI', () => {
  it('applies script-aware fonts to mobile and desktop member/admin names', () => {
    setState('network.appRole', 'host');
    setState(
      'network.standardRoomAdministrators',
      new Map([
        [
          'member-thai',
          {
            memberId: 'member-thai',
            memberDisplayNumber: 2,
            isAuthenticated: true,
            displayName: 'สวัสดี',
            permissions: {
              'media.add': true,
              'playback.control': true,
              'members.kick': false,
              'chat.notice': false,
            },
          },
        ],
      ]),
    );
    initConnect();

    bus.emit('network:device-list-update', [
      {
        id: 'host',
        label: 'Host',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
      },
      {
        id: 'peer-ru',
        label: 'Привет',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: false,
      },
      {
        id: 'admin-thai',
        label: 'สวัสดี',
        joinOrder: 2,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'member-thai',
        memberDisplayNumber: 2,
        isAuthenticated: true,
      },
    ]);

    for (const listId of ['connect-device-list', 'desktop-device-list']) {
      const russianName = Array.from(
        document.querySelectorAll<HTMLElement>(`#${listId} .d-name-label`),
      ).find((element) => element.textContent === 'Привет');
      expect(russianName?.classList, listId).toContain('user-text-font-ru');
    }
    for (const listId of ['connect-administrator-list', 'desktop-administrator-list']) {
      const thaiName = Array.from(
        document.querySelectorAll<HTMLElement>(`#${listId} .d-name-label`),
      ).find((element) => element.textContent === 'สวัสดี');
      expect(thaiName?.classList, listId).toContain('user-text-font-th');
    }
  });

  it('keeps the current member blue without a display-row background', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    expect(stylesheet).toMatch(
      /\.device-row\.is-current-member\s*{\s*background:\s*transparent;\s*}/,
    );
    expect(stylesheet).toMatch(
      /\.device-row\.is-current-member \.d-order,\s*\.device-row\.is-current-member \.d-name\s*{[^}]*color:\s*var\(--primary\);/s,
    );
  });

  it('groups only matching memberIds, keeps duplicate nicknames separate, and highlights my row', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'minsu-phone');
    initConnect();

    bus.emit('network:device-list-update', [
      {
        id: 'host',
        label: 'Host',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
      },
      {
        id: 'minsu-laptop',
        label: 'Minsu',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: false,
        memberId: 'member-minsu',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        devicePlatform: 'windows',
      },
      {
        id: 'minsu-phone',
        label: 'Minsu',
        joinOrder: 2,
        status: 'connected',
        isHost: false,
        isOp: false,
        memberId: 'member-minsu',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        devicePlatform: 'ios',
      },
      {
        id: 'minsu-tablet',
        label: 'Minsu',
        joinOrder: 3,
        status: 'connected',
        isHost: false,
        isOp: false,
        memberId: 'member-minsu',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        devicePlatform: 'android',
      },
      {
        id: 'same-name-other-account',
        label: 'Minsu',
        joinOrder: 4,
        status: 'connected',
        isHost: false,
        isOp: false,
        memberId: 'member-other',
        memberDisplayNumber: 4,
        isAuthenticated: true,
      },
      {
        id: 'anonymous',
        label: 'Peer 5',
        joinOrder: 5,
        status: 'connected',
        isHost: false,
        isOp: false,
      },
    ]);

    const rows = document.querySelectorAll<HTMLElement>('#connect-device-list .device-row');
    expect(rows).toHaveLength(4);
    expect(document.getElementById('connect-device-title')?.textContent).toBe('연결된 기기 6대');
    expect([...rows].filter((row) => row.textContent?.includes('Minsu'))).toHaveLength(2);
    const mine = document.querySelector<HTMLElement>(
      '#connect-device-list .device-row.is-current-member',
    );
    expect(mine?.textContent).toContain('#1');
    expect(mine?.querySelector('.d-name-label')?.textContent).toBe('Minsu');
    expect(mine?.getAttribute('aria-current')).toBe('true');
    const mineEntry = mine?.closest<HTMLElement>('.device-entry');
    const toggle = mineEntry?.querySelector<HTMLButtonElement>('.device-expand-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(mineEntry?.querySelector('.device-sublist')?.hasAttribute('hidden')).toBe(true);
    toggle?.click();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const devices = mineEntry?.querySelectorAll<HTMLElement>('.device-subrow');
    expect(devices).toHaveLength(3);
    expect(devices?.[0]?.textContent).toContain('Windows');
    expect(devices?.[1]?.textContent).toContain('iOS');
    expect(devices?.[1]?.querySelector('.device-sub-name')?.textContent).toBe('iOS 기기 (HONE)');
    expect(devices?.[1]?.classList.contains('is-current-device')).toBe(true);
    expect(devices?.[1]?.getAttribute('aria-current')).toBe('true');
    expect(devices?.[2]?.textContent).toContain('Android');
  });

  it('keeps an expanded device sublist open across heartbeat rerenders and syncs both layouts', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'viewer-device');
    setState('room.context', {
      kind: 'pro',
      roomId: '000077',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    initConnect();
    const deviceList = [
      {
        id: 'viewer-device',
        label: 'Viewer',
        joinOrder: 0,
        status: 'connected',
        isHost: false,
        isOp: false,
        memberId: 'viewer-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
      },
      {
        id: 'friend-ios-A7F2',
        label: 'Friend',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: false,
        memberId: 'friend-member',
        memberDisplayNumber: 2,
        isAuthenticated: true,
        devicePlatform: 'ios',
      },
      {
        id: 'friend-windows-B9C4',
        label: 'Friend',
        joinOrder: 2,
        status: 'connected',
        isHost: false,
        isOp: false,
        memberId: 'friend-member',
        memberDisplayNumber: 2,
        isAuthenticated: true,
        devicePlatform: 'windows',
      },
    ];

    bus.emit('network:device-list-update', deviceList);
    document
      .querySelector<HTMLButtonElement>(
        '#connect-device-list [data-member-id="friend-member"] .device-expand-toggle',
      )
      ?.click();

    for (const listId of ['connect-device-list', 'desktop-device-list']) {
      const entry = document.querySelector<HTMLElement>(
        `#${listId} [data-member-id="friend-member"].device-entry`,
      );
      expect(entry?.querySelector('.device-expand-toggle')?.getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(entry?.querySelector('.device-sublist')?.hasAttribute('hidden')).toBe(false);
    }

    bus.emit('network:device-list-update', deviceList);

    for (const listId of ['connect-device-list', 'desktop-device-list']) {
      const entry = document.querySelector<HTMLElement>(
        `#${listId} [data-member-id="friend-member"].device-entry`,
      );
      expect(entry?.querySelector('.device-expand-toggle')?.getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(entry?.querySelector('.device-sublist')?.hasAttribute('hidden')).toBe(false);
      expect(entry?.querySelectorAll('.device-subrow')).toHaveLength(2);
    }
    const mobileControls = document
      .querySelector<HTMLButtonElement>(
        '#connect-device-list [data-member-id="friend-member"] .device-expand-toggle',
      )
      ?.getAttribute('aria-controls');
    const desktopControls = document
      .querySelector<HTMLButtonElement>(
        '#desktop-device-list [data-member-id="friend-member"] .device-expand-toggle',
      )
      ?.getAttribute('aria-controls');
    expect(mobileControls).not.toBe(desktopControls);
  });

  it('disconnects one selected PRO device without using the account-wide kick action', async () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-device');
    setState('room.context', {
      kind: 'pro',
      roomId: '000078',
      role: 'coordinator',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage', 'room.configure'],
    });
    mockedShowDialog.mockResolvedValue({ action: 'ok' });
    initConnect();
    bus.emit('pro-room:administrators-updated', [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
    ]);
    const supportedDeviceList: Array<Record<string, unknown>> = [
      {
        id: 'owner-device',
        label: 'Owner',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        devicePlatform: 'windows',
      },
      {
        id: 'friend-ios-A7F2',
        label: 'Friend',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: false,
        memberId: 'friend-member',
        memberDisplayNumber: 2,
        isAuthenticated: true,
        devicePlatform: 'ios',
      },
      {
        id: 'friend-windows-B9C4',
        label: 'Friend',
        joinOrder: 2,
        status: 'connected',
        isHost: false,
        isOp: false,
        memberId: 'friend-member',
        memberDisplayNumber: 2,
        isAuthenticated: true,
        devicePlatform: 'windows',
      },
    ];
    bus.emit('network:device-list-update', supportedDeviceList);
    const targetEntry = document.querySelector<HTMLElement>(
      '#connect-device-list [data-member-id="friend-member"].device-entry',
    );
    targetEntry?.querySelector<HTMLButtonElement>('.device-expand-toggle')?.click();
    expect(targetEntry?.querySelector('.device-expand-toggle')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    const kickPhysicalDeviceButton = targetEntry?.querySelector<HTMLButtonElement>(
      '.btn-kick-physical-device',
    );
    expect(kickPhysicalDeviceButton?.getAttribute('aria-label')).toContain('iOS 기기 (A7F2)');
    kickPhysicalDeviceButton?.click();

    expect(mockedShowDialog).toHaveBeenCalledWith({
      title: '강제퇴장 시키기',
      message: 'iOS 기기 (A7F2)를 내보낼까요?',
      buttonText: '내보내기',
      secondaryText: '취소',
    });

    await vi.waitFor(() =>
      expect(mockedKickActiveProRoomPresence).toHaveBeenCalledWith('friend-ios-A7F2'),
    );
    expect(mockedKickActiveProRoomMember).not.toHaveBeenCalled();
  });

  it('lets the PRO owner disconnect only a sibling device while protecting the current and offline devices', async () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-current-A7F1');
    setState('room.context', {
      kind: 'pro',
      roomId: '000079',
      role: 'coordinator',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage', 'room.configure'],
    });
    mockedShowDialog.mockResolvedValue({ action: 'ok' });
    initConnect();
    bus.emit('pro-room:administrators-updated', [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 2,
      },
    ]);
    bus.emit('network:device-list-update', [
      {
        id: 'owner-current-A7F1',
        label: 'Owner',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        devicePlatform: 'windows',
      },
      {
        id: 'owner-sibling-A7F2',
        label: 'Owner',
        joinOrder: 1,
        status: 'connected',
        // Every owner presence is projected as a host-like product role in
        // PRO rooms. That must not hide the exact action for my other device.
        isHost: true,
        isOp: true,
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        devicePlatform: 'ios',
      },
      {
        id: 'owner-offline-A7F3',
        label: 'Owner',
        joinOrder: 2,
        status: 'disconnected',
        isHost: true,
        isOp: true,
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        devicePlatform: 'android',
      },
    ]);

    const ownerEntry = document.querySelector<HTMLElement>(
      '#connect-device-list [data-member-id="owner-member"].device-entry',
    );
    ownerEntry?.querySelector<HTMLButtonElement>('.device-expand-toggle')?.click();
    const current = ownerEntry?.querySelector<HTMLElement>('[data-device-id="owner-current-A7F1"]');
    const sibling = ownerEntry?.querySelector<HTMLElement>('[data-device-id="owner-sibling-A7F2"]');
    const offline = ownerEntry?.querySelector<HTMLElement>('[data-device-id="owner-offline-A7F3"]');

    expect(current?.getAttribute('aria-current')).toBe('true');
    expect(current?.querySelector('.btn-kick-physical-device')).toBeNull();
    expect(current?.querySelector('.sr-only')?.textContent).toContain('현재');
    expect(offline?.querySelector('.btn-kick-physical-device')).toBeNull();
    expect(ownerEntry?.querySelector('.btn-kick-device')).toBeNull();

    const kickSibling = sibling?.querySelector<HTMLButtonElement>('.btn-kick-physical-device');
    expect(kickSibling?.getAttribute('aria-label')).toContain('iOS');
    expect(kickSibling?.getAttribute('aria-label')).toContain('A7F2');
    kickSibling?.click();

    await vi.waitFor(() =>
      expect(mockedKickActiveProRoomPresence).toHaveBeenCalledWith('owner-sibling-A7F2'),
    );
    expect(mockedKickActiveProRoomPresence).toHaveBeenCalledTimes(1);
    expect(mockedKickActiveProRoomMember).not.toHaveBeenCalled();
  });

  it('lets the standard-room host disconnect an authenticated sibling without targeting itself', async () => {
    setState('network.appRole', 'host');
    setState('network.myId', 'standard-host-current');
    setState('network.hostConn', null);
    setState('room.context', {
      kind: 'standard',
      roomId: '123456',
      role: 'coordinator',
      coordinatorId: 'standard-host-current',
      epoch: 0,
      snapshotRevision: 0,
      capabilities: [],
    });
    mockedShowDialog.mockResolvedValue({ action: 'ok' });
    const requestExactKick = vi.fn();
    bus.on('network:request-kick-standard-room-device', requestExactKick);
    initConnect();
    const devices: Array<Record<string, unknown>> = [
      {
        id: 'standard-host-current',
        label: 'Standard owner',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
        memberId: 'standard-owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        devicePlatform: 'windows',
      },
      {
        id: 'standard-owner-sibling',
        label: 'Standard owner',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'standard-owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        devicePlatform: 'ios',
      },
    ];
    bus.emit('network:device-list-update', devices);

    const ownerEntry = document.querySelector<HTMLElement>(
      '#connect-device-list [data-member-id="standard-owner-member"].device-entry',
    );
    ownerEntry?.querySelector<HTMLButtonElement>('.device-expand-toggle')?.click();
    expect(
      ownerEntry?.querySelector(
        '[data-device-id="standard-host-current"] .btn-kick-physical-device',
      ),
    ).toBeNull();

    const siblingKick = ownerEntry?.querySelector<HTMLButtonElement>(
      '[data-device-id="standard-owner-sibling"] .btn-kick-physical-device',
    );
    siblingKick?.click();

    await vi.waitFor(() =>
      expect(requestExactKick).toHaveBeenCalledWith({ peerId: 'standard-owner-sibling' }),
    );
    expect(requestExactKick).toHaveBeenCalledTimes(1);

    let resolveOfflineDialog!: (result: DialogResult) => void;
    mockedShowDialog.mockReturnValueOnce(
      new Promise<DialogResult>((resolve) => {
        resolveOfflineDialog = resolve;
      }),
    );
    siblingKick?.click();
    bus.emit(
      'network:device-list-update',
      devices.map((device) =>
        device.id === 'standard-owner-sibling' ? { ...device, status: 'disconnected' } : device,
      ),
    );
    resolveOfflineDialog({ action: 'ok' });
    await Promise.resolve();
    expect(requestExactKick).toHaveBeenCalledTimes(1);

    bus.emit('network:device-list-update', devices);
    const refreshedEntry = document.querySelector<HTMLElement>(
      '#connect-device-list [data-member-id="standard-owner-member"].device-entry',
    );
    refreshedEntry?.querySelector<HTMLButtonElement>('.device-expand-toggle')?.click();
    const refreshedSiblingKick = refreshedEntry?.querySelector<HTMLButtonElement>(
      '[data-device-id="standard-owner-sibling"] .btn-kick-physical-device',
    );
    let resolveRoomSwitchDialog!: (result: DialogResult) => void;
    mockedShowDialog.mockReturnValueOnce(
      new Promise<DialogResult>((resolve) => {
        resolveRoomSwitchDialog = resolve;
      }),
    );
    refreshedSiblingKick?.click();
    setState('room.context', {
      kind: 'standard',
      roomId: '654321',
      role: 'coordinator',
      coordinatorId: 'standard-host-current',
      epoch: 1,
      snapshotRevision: 0,
      capabilities: [],
    });
    resolveRoomSwitchDialog({ action: 'ok' });
    await Promise.resolve();
    expect(requestExactKick).toHaveBeenCalledTimes(1);
  });

  it('keeps sibling exact actions capability-gated and protects other PRO authorities', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'controller-current');
    const authorizedContext: RoomContext = {
      kind: 'pro',
      roomId: '000080',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage'],
    };
    setState('room.context', authorizedContext);
    initConnect();
    bus.emit('pro-room:administrators-updated', [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 2,
      },
      {
        memberId: 'controller-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        displayName: 'Controller',
        role: 'controller',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: [],
        onlineDeviceCount: 2,
      },
      {
        memberId: 'other-controller-member',
        memberDisplayNumber: 2,
        isAuthenticated: true,
        displayName: 'Other controller',
        role: 'controller',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: [],
        onlineDeviceCount: 2,
      },
    ]);
    const devices = [
      {
        id: 'owner-a',
        label: 'Owner',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        devicePlatform: 'windows',
      },
      {
        id: 'owner-b',
        label: 'Owner',
        joinOrder: 1,
        status: 'connected',
        isHost: true,
        isOp: true,
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        devicePlatform: 'ios',
      },
      {
        id: 'controller-current',
        label: 'Controller',
        joinOrder: 2,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'controller-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        devicePlatform: 'windows',
      },
      {
        id: 'controller-sibling',
        label: 'Controller',
        joinOrder: 3,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'controller-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        devicePlatform: 'ios',
      },
      {
        id: 'other-controller-a',
        label: 'Other controller',
        joinOrder: 4,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'other-controller-member',
        memberDisplayNumber: 2,
        isAuthenticated: true,
        devicePlatform: 'android',
      },
      {
        id: 'other-controller-b',
        label: 'Other controller',
        joinOrder: 5,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'other-controller-member',
        memberDisplayNumber: 2,
        isAuthenticated: true,
        devicePlatform: 'linux',
      },
    ];
    bus.emit('network:device-list-update', devices);

    const entry = (memberId: string) =>
      document.querySelector<HTMLElement>(
        `#connect-device-list [data-member-id="${memberId}"].device-entry`,
      );
    for (const memberId of ['owner-member', 'controller-member', 'other-controller-member']) {
      entry(memberId)?.querySelector<HTMLButtonElement>('.device-expand-toggle')?.click();
    }

    expect(
      entry('controller-member')?.querySelector(
        '[data-device-id="controller-sibling"] .btn-kick-physical-device',
      ),
    ).not.toBeNull();
    expect(entry('owner-member')?.querySelector('.btn-kick-physical-device')).toBeNull();
    expect(entry('other-controller-member')?.querySelector('.btn-kick-physical-device')).toBeNull();

    setState('room.context', { ...authorizedContext, capabilities: [] });
    bus.emit('network:device-list-update', devices);
    expect(entry('controller-member')?.querySelector('.btn-kick-physical-device')).toBeNull();
  });

  it('shows connected standard administrators to non-host participants from the live projection', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'viewer');
    setState('network.hostConn', makeConnection('host'));
    setState(
      'network.standardRoomAdministrators',
      new Map([
        [
          'stale-host-local-entry',
          {
            memberId: 'stale-host-local-entry',
            memberDisplayNumber: 9,
            isAuthenticated: true,
            displayName: 'Must not leak from old host state',
            permissions: {
              'media.add': true,
              'playback.control': true,
              'members.kick': true,
              'chat.notice': true,
            },
          },
        ],
      ]),
    );
    initConnect();

    bus.emit('network:device-list-update', [
      {
        id: 'host',
        label: 'Host',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
      },
      {
        id: 'admin-phone',
        label: 'Minsu',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'member-minsu',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        capabilities: ['media.add', 'playback.control', 'chat.notice'],
      },
      {
        id: 'viewer',
        label: 'Viewer',
        joinOrder: 2,
        status: 'connected',
        isHost: false,
        isOp: false,
      },
    ]);

    const rows = document.querySelectorAll<HTMLElement>(
      '#connect-administrator-list .administrator-row',
    );
    expect(rows).toHaveLength(2);
    expect(document.body.textContent).not.toContain('Must not leak from old host state');
    expect(rows[1]?.dataset.memberId).toBe('member-minsu');
    expect(rows[1]?.textContent).toContain('Minsu');
    expect(rows[1]?.querySelector('.administrator-action-button')).toBeNull();
    expect(rows[0]?.querySelector('.administrator-crown')?.getAttribute('aria-label')).toBe(
      '방 소유자',
    );
    expect(rows[1]?.querySelector('.administrator-crown')?.getAttribute('aria-label')).toBe(
      '관리자',
    );
  });

  it('groups the owner account while keeping the current device physically non-host', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'guest-phone');
    initConnect();

    bus.emit('network:device-list-update', [
      {
        id: 'host-browser',
        label: 'Minsu',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
        memberId: 'member-minsu',
        memberDisplayNumber: 0,
        isAuthenticated: true,
      },
      {
        id: 'guest-phone',
        label: 'Minsu',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'member-minsu',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        capabilities: [
          'media.add',
          'queue.mutate',
          'playback.control',
          'effects.control',
          'asset.upload',
          'members.manage',
          'chat.notice',
          'room.configure',
        ],
      },
    ]);

    const current = document.querySelector<HTMLElement>(
      '#connect-device-list .device-row.is-current-member',
    );
    const owner = document.querySelector<HTMLElement>(
      '#connect-administrator-list .administrator-row',
    );
    expect(current?.dataset.currentDeviceRole).toBe('administrator');
    expect(owner?.dataset.memberId).toBe('member-minsu');
  });

  it('includes the owner in the administrator count and keeps offline accounts visible', () => {
    setState('network.appRole', 'host');
    setState(
      'network.standardRoomAdministrators',
      new Map([
        [
          'member-online',
          {
            memberId: 'member-online',
            memberDisplayNumber: 1,
            isAuthenticated: true,
            displayName: 'Online admin',
            permissions: {
              'media.add': true,
              'playback.control': true,
              'members.kick': false,
              'chat.notice': false,
            },
          },
        ],
        [
          'member-offline',
          {
            memberId: 'member-offline',
            memberDisplayNumber: 2,
            isAuthenticated: true,
            displayName: 'Offline admin',
            permissions: {
              'media.add': true,
              'playback.control': false,
              'members.kick': false,
              'chat.notice': false,
            },
          },
        ],
      ]),
    );
    initConnect();

    bus.emit('network:device-list-update', [
      {
        id: 'host',
        label: 'Host',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
      },
      {
        id: 'admin-device',
        label: 'Online admin',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'member-online',
        memberDisplayNumber: 1,
        isAuthenticated: true,
      },
    ]);

    expect(document.getElementById('connect-administrator-title')?.textContent).toBe('관리자 3명');
    const rows = document.querySelectorAll<HTMLElement>(
      '#connect-administrator-list .administrator-row',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('.administrator-crown.owner')).not.toBeNull();
    expect(rows[2]?.classList.contains('is-offline')).toBe(true);
    expect(rows[2]?.textContent).toContain('Offline admin');
    expect(rows[0]?.querySelector('.administrator-action-button')).toBeNull();
    expect(rows[1]?.querySelectorAll('.administrator-action-button')).toHaveLength(2);
    expect(
      rows[1]?.querySelector('.administrator-action-button.revoke path')?.getAttribute('d'),
    ).toBe(
      'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.41 4.29 19.71 2.88 18.3 9.17 12 2.88 5.7 4.29 4.29 10.59 10.59 16.89 4.29z',
    );
  });

  it('orders ordinary-room administrators by presence and deterministic offline nickname', () => {
    setState('network.appRole', 'host');
    const administrator = (memberId: string, memberDisplayNumber: number, displayName: string) => ({
      memberId,
      memberDisplayNumber,
      isAuthenticated: true,
      displayName,
      permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
    });
    setState(
      'network.standardRoomAdministrators',
      new Map([
        ['member-zulu', administrator('member-zulu', 1, 'Zulu Offline')],
        ['member-korean', administrator('member-korean', 3, '가나다 Offline')],
        ['member-same-z', administrator('member-same-z', 4, 'Same Offline')],
        ['member-online-high', administrator('member-online-high', 7, 'Online High')],
        ['member-alpha', administrator('member-alpha', 8, 'Alpha Offline')],
        ['member-same-a', administrator('member-same-a', 9, 'Same Offline')],
        ['member-online-low', administrator('member-online-low', 2, 'Online Low')],
      ]),
    );
    initConnect();

    bus.emit('network:device-list-update', [
      {
        id: 'host',
        label: 'Host',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
      },
      {
        id: 'online-high-device',
        label: 'Online High',
        joinOrder: 7,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'member-online-high',
        memberDisplayNumber: 7,
        isAuthenticated: true,
      },
      {
        id: 'online-low-device',
        label: 'Online Low',
        joinOrder: 2,
        status: 'connected',
        isHost: false,
        isOp: true,
        memberId: 'member-online-low',
        memberDisplayNumber: 2,
        isAuthenticated: true,
      },
    ]);

    const expectedMemberIds = [
      'peer:host',
      'member-online-low',
      'member-online-high',
      'member-alpha',
      'member-same-a',
      'member-same-z',
      'member-zulu',
      'member-korean',
    ];
    for (const listId of ['connect-administrator-list', 'desktop-administrator-list']) {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(`#${listId} .administrator-row`),
      );
      expect(
        rows.map((row) => row.dataset.memberId),
        listId,
      ).toEqual(expectedMemberIds);
      expect(rows.slice(1, 3).every((row) => !row.classList.contains('is-offline'))).toBe(true);
      expect(rows.slice(3).every((row) => row.classList.contains('is-offline'))).toBe(true);
    }
  });

  it('shows one administrator for an owner-only PRO room', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-device');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    initConnect();

    bus.emit('pro-room:administrators-updated', [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
    ]);

    expect(document.getElementById('connect-administrator-title')?.textContent).toBe('관리자 1명');
    expect(
      document.querySelectorAll('#connect-administrator-list .administrator-row'),
    ).toHaveLength(1);
  });

  it('preserves the PRO server order on mobile and desktop and keeps actions member-bound', async () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-device');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    const administrator = (
      memberId: string,
      memberDisplayNumber: number,
      displayName: string,
      onlineDeviceCount: number,
      role: 'owner' | 'controller' = 'controller',
    ): ProRoomAdministrator => ({
      memberId,
      memberDisplayNumber,
      isAuthenticated: true,
      displayName,
      role,
      permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
      inheritedPermissions:
        role === 'owner' ? ['media.add', 'playback.control', 'members.kick', 'chat.notice'] : [],
      onlineDeviceCount,
    });
    // This fixture is deliberately not locally sortable by presence, member
    // number, or nickname. The client must treat the Worker projection as the
    // canonical sequence instead of introducing a second ordering policy.
    const projection = [
      administrator('owner-member', 0, 'Owner', 0, 'owner'),
      administrator('member-online-high', 7, 'Online High', 2),
      administrator('member-alpha', 1, 'Alpha Offline', 0),
      administrator('member-online-low', 2, 'Online Low', 1),
      administrator('member-same-z', 4, 'Same Offline', 0),
      administrator('member-same-a', 9, 'Same Offline', 0),
    ];
    const expectedMemberIds = projection.map(({ memberId }) => memberId);
    mockedGetActiveProRoomAdministrators.mockReturnValue(projection);
    mockedShowDialog.mockResolvedValue({ action: 'ok' });
    initConnect();
    bus.emit('pro-room:administrators-updated', projection);

    for (const listId of ['connect-administrator-list', 'desktop-administrator-list']) {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(`#${listId} .administrator-row`),
      );
      expect(
        rows.map((row) => row.dataset.memberId),
        listId,
      ).toEqual(expectedMemberIds);
    }

    const mobileRows = document.querySelectorAll<HTMLElement>(
      '#connect-administrator-list .administrator-row',
    );
    expect(mobileRows[5]?.dataset.memberId).toBe('member-same-a');
    mobileRows[5]
      ?.querySelector<HTMLButtonElement>('.administrator-action-button.settings')
      ?.click();
    document.getElementById('btn-administrator-permissions-save')?.click();
    await vi.waitFor(() =>
      expect(mockedUpdateActiveProRoomAdministrator).toHaveBeenCalledWith(
        'member-same-a',
        FULL_ADMIN_PERMISSIONS_FOR_TEST,
      ),
    );

    const desktopRows = document.querySelectorAll<HTMLElement>(
      '#desktop-administrator-list .administrator-row',
    );
    expect(desktopRows[2]?.dataset.memberId).toBe('member-alpha');
    desktopRows[2]
      ?.querySelector<HTMLButtonElement>('.administrator-action-button.revoke')
      ?.click();
    await vi.waitFor(() =>
      expect(mockedRevokeActiveProRoomAdministrator).toHaveBeenCalledWith('member-alpha'),
    );
  });

  it('uses the edited member name as the localized accessible permission-dialog title', async () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-device');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    const administrators: ProRoomAdministrator[] = [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
      {
        memberId: 'admin-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        displayName: 'MUSIXQUARE',
        role: 'controller',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: [],
        onlineDeviceCount: 1,
      },
    ];
    initConnect();
    bus.emit('pro-room:administrators-updated', administrators);
    document
      .querySelector<HTMLButtonElement>(
        '#connect-administrator-list .administrator-action-button.settings',
      )
      ?.click();

    const dialog = document.getElementById('administrator-permissions-dialog');
    const title = document.getElementById('administrator-permissions-title');
    expect(title?.textContent).toBe('MUSIXQUARE님의 권한');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('administrator-permissions-title');
    expect(dialog?.hasAttribute('aria-describedby')).toBe(false);
    expect(document.getElementById('administrator-permissions-member')).toBeNull();

    setLanguageMode('en');
    await vi.waitFor(() => expect(title?.textContent).toBe('MUSIXQUARE’s permissions'));
  });

  it('keeps administrator layout aligned and permission rows free of pill hover fills', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const markup = await readFile('index.html', 'utf8');
    const desktopStylesheet = await readFile('css/desktop.css', 'utf8');
    const deviceSubrowRules = stylesheet.match(/\.device-subrow\s*\{([^}]*)\}/)?.[1] ?? '';
    const nameLabelRules = stylesheet.match(/\.device-row \.d-name-label\s*\{([^}]*)\}/)?.[1] ?? '';
    const administratorRowRules = stylesheet.match(/\.administrator-row\s*\{([^}]*)\}/)?.[1] ?? '';
    const administratorNameRules =
      stylesheet.match(/\.administrator-row \.d-name\s*\{([^}]*)\}/)?.[1] ?? '';
    const dialogRules =
      stylesheet.match(/\.dialog\.administrator-permissions-dialog\s*\{([^}]*)\}/)?.[1] ?? '';
    const shownDialogRules =
      stylesheet.match(
        /\.administrator-permissions-overlay\.show\s+\.administrator-permissions-dialog\s*\{([^}]*)\}/,
      )?.[1] ?? '';
    const headerRules =
      stylesheet.match(
        /\.dialog\.administrator-permissions-dialog\s+\.administrator-permissions-header\s*\{([^}]*)\}/,
      )?.[1] ?? '';
    const titleRules =
      stylesheet.match(/\.administrator-permissions-header \.dialog-title\s*\{([^}]*)\}/)?.[1] ??
      '';
    const listRules = stylesheet.match(/\.administrator-permissions-list\s*\{([^}]*)\}/)?.[1] ?? '';
    const actionRules =
      stylesheet.match(
        /\.administrator-permissions-dialog\s+\.dialog-actions\s*\{([^}]*)\}/,
      )?.[1] ?? '';
    const permissionRowRules =
      stylesheet.match(/\.administrator-permission-row\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(desktopStylesheet).toMatch(
      /#desktop-connect-content \.qr-container,\s*#desktop-connect-content \.administrator-list,\s*#desktop-connect-content \.device-list,/,
    );
    expect(stylesheet).toMatch(
      /\.administrator-permission-row:hover,\s*\.administrator-permission-row:focus-visible\s*{\s*background:\s*transparent;/,
    );
    expect(stylesheet).not.toContain('.d-device-count');
    expect(deviceSubrowRules).toContain('font-size: 13px');
    expect(deviceSubrowRules).toContain('color: var(--text-sub)');
    expect(stylesheet).toContain('.device-subrow.is-current-device');
    expect(nameLabelRules).toContain('display: block');
    // Keep the disclosure control in the action rail while still allowing a
    // long nickname to shrink into the existing ellipsis boundary.
    expect(nameLabelRules).toContain('flex: 0 1 auto');
    expect(nameLabelRules).toContain('text-overflow: ellipsis');
    expect(nameLabelRules).toContain('white-space: nowrap');
    expect(administratorRowRules).toContain('min-width: 0');
    expect(administratorNameRules).toContain('overflow: hidden');
    expect(dialogRules).toContain('transform: translateY(18px)');
    expect(dialogRules).not.toContain('scale(');
    expect(shownDialogRules).toContain('transform: translateY(0)');
    expect(shownDialogRules).not.toContain('scale(');
    expect(headerRules).toContain('padding: 30px 32px 26px');
    expect(titleRules).toContain('width: 100%');
    expect(titleRules).toContain('overflow-wrap: anywhere');
    expect(markup).toContain('aria-labelledby="administrator-permissions-title"');
    expect(markup).not.toContain('administrator-permissions-member');
    expect(listRules).toContain('flex: 1 1 auto');
    expect(listRules).toContain('padding: 8px 32px 24px');
    expect(listRules).toContain('gap: 4px');
    expect(listRules).toContain('overflow-y: auto');
    expect(listRules).toContain('-webkit-overflow-scrolling: touch');
    expect(permissionRowRules).toContain('min-height: 48px');
    expect(permissionRowRules).toContain('padding: 0 8px');
    expect(actionRules).toContain('padding-top: 8px');
  });

  it('matches main-row removal icons to expand chevrons without enlarging device subrow removal', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const expandIconRules =
      stylesheet.match(/\.expand-toggle svg,\s*\.device-expand-toggle svg\s*\{([^}]*)\}/)?.[1] ??
      '';
    const playlistExpandButtonRules = stylesheet.match(/\.expand-toggle\s*\{([^}]*)\}/)?.[1] ?? '';
    const playlistRemoveIconRules =
      stylesheet.match(/\.btn-playlist-remove svg\s*\{([^}]*)\}/)?.[1] ?? '';
    const playlistRemoveButtonRules =
      stylesheet.match(/\.btn-playlist-remove\s*\{([^}]*)\}/)?.[1] ?? '';
    const memberKickIconRules = stylesheet.match(/\.btn-kick-device svg\s*\{([^}]*)\}/)?.[1] ?? '';
    const memberKickButtonRules = stylesheet.match(/\.btn-kick-device\s*\{([^}]*)\}/)?.[1] ?? '';
    const kickButtonBaseRules =
      stylesheet.match(/\.btn-kick-device,\s*\.btn-kick-physical-device\s*\{([^}]*)\}/)?.[1] ?? '';
    const physicalDeviceKickIconRules =
      stylesheet.match(/\.btn-kick-physical-device svg\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(expandIconRules).toContain('width: 22px');
    expect(expandIconRules).toContain('height: 22px');
    expect(expandIconRules).toContain('fill: none');
    expect(expandIconRules).toContain('stroke: currentColor');
    expect(expandIconRules).toContain('stroke-width: 1.8');
    expect(expandIconRules).toContain('stroke-linecap: butt');
    expect(expandIconRules).toContain('stroke-linejoin: miter');
    expect(playlistExpandButtonRules).toContain('width: 44px');
    expect(playlistExpandButtonRules).toContain('height: 44px');
    expect(playlistExpandButtonRules).toContain('margin: -8px');
    expect(playlistExpandButtonRules).toContain('flex: 0 0 44px');
    expect(playlistRemoveButtonRules).toContain('opacity: 1');
    expect(playlistRemoveButtonRules).toContain('color: var(--text-muted)');
    expect(playlistRemoveIconRules).toContain('width: 16px');
    expect(playlistRemoveIconRules).toContain('height: 16px');
    expect(playlistRemoveIconRules).toContain('stroke: currentColor');
    expect(playlistRemoveIconRules).toContain('stroke-width: 0.5');
    expect(memberKickIconRules).toContain('width: 16px');
    expect(memberKickIconRules).toContain('height: 16px');
    expect(memberKickIconRules).toContain('stroke: currentColor');
    expect(memberKickIconRules).toContain('stroke-width: 0.5');
    expect(memberKickButtonRules).toContain('opacity: 1');
    expect(kickButtonBaseRules).toContain('color: var(--text-muted)');
    expect(physicalDeviceKickIconRules).toContain('width: 16px');
    expect(physicalDeviceKickIconRules).toContain('height: 16px');
    expect(physicalDeviceKickIconRules).not.toContain('stroke-width');
  });

  it('shares crown colors with chat and distinguishes online from offline administrators', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const administratorCrownRules =
      stylesheet.match(/\.administrator-crown\s*\{([^}]*)\}/)?.[1] ?? '';
    const ownerCrownRules =
      stylesheet.match(/\.administrator-crown\.owner\s*\{([^}]*)\}/)?.[1] ?? '';
    const chatHostCrownRules = stylesheet.match(/\.chat-badge-host\s*\{([^}]*)\}/)?.[1] ?? '';
    const chatAdministratorCrownRules =
      stylesheet.match(/\.chat-badge-op\s*\{([^}]*)\}/)?.[1] ?? '';
    const chatCrownRules = stylesheet.match(/\.chat-crown\s*\{([^}]*)\}/)?.[1] ?? '';
    const authenticatedRoleDotRules =
      stylesheet.match(/\.role-badge\.account-authenticated\s+\.role-dot\s*\{([^}]*)\}/)?.[1] ?? '';
    const onlineAdministratorNameRules =
      stylesheet.match(/\.administrator-row:not\(\.is-offline\)\s+\.d-name\s*\{([^}]*)\}/)?.[1] ??
      '';
    const offlineAdministratorNameRules =
      stylesheet.match(/\.administrator-row\.is-offline\s+\.d-name\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(ownerCrownRules).toContain('color: #f5c842');
    expect(chatHostCrownRules).toContain('color: #f5c842');
    expect(administratorCrownRules).toContain('color: var(--text-muted)');
    expect(chatAdministratorCrownRules).toContain('color: var(--text-muted)');
    expect(chatCrownRules).toContain('top: -1px');
    expect(authenticatedRoleDotRules).toContain('background: white');
    expect(authenticatedRoleDotRules).not.toContain('opacity:');
    expect(onlineAdministratorNameRules).toContain('color: var(--text-main)');
    expect(onlineAdministratorNameRules).toContain('font-weight: 600');
    expect(offlineAdministratorNameRules).toContain('color: var(--text-muted)');
    expect(offlineAdministratorNameRules).toContain('font-weight: 500');
  });

  it('focuses the permission switches without scrolling the modal', async () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-device');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    const fullPermissions = {
      'media.add': true,
      'playback.control': true,
      'members.kick': true,
      'chat.notice': true,
    } as const;
    const administrators = [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner' as const,
        permissions: { ...fullPermissions },
        inheritedPermissions: [
          'media.add' as const,
          'playback.control' as const,
          'members.kick' as const,
          'chat.notice' as const,
        ],
        onlineDeviceCount: 1,
      },
      {
        memberId: 'admin-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        displayName: 'Admin',
        role: 'controller' as const,
        permissions: { ...fullPermissions },
        inheritedPermissions: [],
        onlineDeviceCount: 1,
      },
    ];
    initConnect();
    bus.emit('pro-room:administrators-updated', administrators);

    const firstSwitch = document.querySelector<HTMLButtonElement>(
      '[data-administrator-permission="media.add"]',
    );
    const focus = vi.spyOn(firstSwitch!, 'focus');
    document
      .querySelector<HTMLButtonElement>(
        '#connect-administrator-list .administrator-action-button.settings',
      )
      ?.click();
    await Promise.resolve();

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('preserves an unsaved permission draft across revision-only room context pulses', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-device');
    const context = {
      kind: 'pro' as const,
      roomId: '000001',
      role: 'member' as const,
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure' as const],
    };
    setState('room.context', context);
    const administrators: ProRoomAdministrator[] = [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
      {
        memberId: 'admin-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        displayName: 'Admin',
        role: 'controller',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: [],
        onlineDeviceCount: 1,
      },
    ];
    initConnect();
    bus.emit('pro-room:administrators-updated', administrators);
    const oldSettings = document.querySelector<HTMLButtonElement>(
      '#connect-administrator-list .administrator-action-button.settings',
    );
    oldSettings?.click();
    const mediaPermission = document.querySelector<HTMLButtonElement>(
      '[data-administrator-permission="media.add"]',
    )!;
    mediaPermission.click();

    setState('room.context', { ...context, snapshotRevision: 2 });

    expect(
      document.getElementById('administrator-permissions-overlay')?.classList.contains('show'),
    ).toBe(true);
    expect(mediaPermission.getAttribute('aria-checked')).toBe('false');
    expect(oldSettings?.isConnected).toBe(true);
  });

  it('closes a permission draft when its room incarnation or management authority is lost', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-device');
    const context = {
      kind: 'pro' as const,
      roomId: '000001',
      role: 'member' as const,
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure' as const],
    };
    setState('room.context', context);
    const administrators: ProRoomAdministrator[] = [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: ['media.add', 'playback.control', 'members.kick', 'chat.notice'],
        onlineDeviceCount: 1,
      },
      {
        memberId: 'admin-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        displayName: 'Admin',
        role: 'controller',
        permissions: { ...FULL_ADMIN_PERMISSIONS_FOR_TEST },
        inheritedPermissions: [],
        onlineDeviceCount: 1,
      },
    ];
    initConnect();
    bus.emit('pro-room:administrators-updated', administrators);
    document
      .querySelector<HTMLButtonElement>(
        '#connect-administrator-list .administrator-action-button.settings',
      )
      ?.click();

    setState('room.context', { ...context, epoch: 2, snapshotRevision: 2 });
    expect(
      document.getElementById('administrator-permissions-overlay')?.classList.contains('show'),
    ).toBe(false);

    setState('room.context', { ...context, epoch: 2, snapshotRevision: 3 });
    bus.emit('pro-room:administrators-updated', administrators);
    document
      .querySelector<HTMLButtonElement>(
        '#connect-administrator-list .administrator-action-button.settings',
      )
      ?.click();
    setState('room.context', { ...context, roomId: '000002', snapshotRevision: 1 });
    expect(
      document.getElementById('administrator-permissions-overlay')?.classList.contains('show'),
    ).toBe(false);

    setState('room.context', { ...context, snapshotRevision: 4 });
    bus.emit('pro-room:administrators-updated', administrators);
    document
      .querySelector<HTMLButtonElement>(
        '#connect-administrator-list .administrator-action-button.settings',
      )
      ?.click();
    setState('room.context', { ...context, snapshotRevision: 5, capabilities: [] });

    expect(
      document.getElementById('administrator-permissions-overlay')?.classList.contains('show'),
    ).toBe(false);
  });

  it('migrates legacy inherited PRO playback control to an editable explicit permission', async () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-device');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    const administrators = [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner' as const,
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: [
          'media.add' as const,
          'playback.control' as const,
          'members.kick' as const,
          'chat.notice' as const,
        ],
        onlineDeviceCount: 1,
      },
      {
        memberId: 'admin-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        displayName: 'Admin',
        role: 'controller' as const,
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': false,
          'chat.notice': false,
        },
        inheritedPermissions: ['playback.control' as const],
        onlineDeviceCount: 0,
      },
    ];
    mockedGetActiveProRoomAdministrators.mockReturnValue(administrators);
    initConnect();
    bus.emit('pro-room:administrators-updated', administrators);

    document
      .querySelector<HTMLButtonElement>(
        '#connect-administrator-list .administrator-action-button.settings',
      )
      ?.click();

    const playback = document.querySelector<HTMLButtonElement>(
      '[data-administrator-permission="playback.control"]',
    );
    const media = document.querySelector<HTMLButtonElement>(
      '[data-administrator-permission="media.add"]',
    );
    expect(playback?.disabled).toBe(false);
    expect(playback?.getAttribute('aria-checked')).toBe('true');
    expect(
      playback?.querySelector<HTMLElement>('.administrator-permission-inherited')?.hidden,
    ).toBe(true);
    playback?.click();
    media?.click();
    document.getElementById('btn-administrator-permissions-save')?.click();

    await vi.waitFor(() =>
      expect(mockedUpdateActiveProRoomAdministrator).toHaveBeenCalledWith('admin-member', {
        'media.add': false,
        'playback.control': false,
        'members.kick': false,
        'chat.notice': false,
      }),
    );
  });

  it('restores focus to a replacement settings button after the administrator list rerenders', async () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-device');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    const administrators = [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner' as const,
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': true,
          'chat.notice': true,
        },
        inheritedPermissions: [
          'media.add' as const,
          'playback.control' as const,
          'members.kick' as const,
          'chat.notice' as const,
        ],
        onlineDeviceCount: 1,
      },
      {
        memberId: 'admin-member',
        memberDisplayNumber: 1,
        isAuthenticated: true,
        displayName: 'Admin',
        role: 'controller' as const,
        permissions: {
          'media.add': true,
          'playback.control': true,
          'members.kick': false,
          'chat.notice': false,
        },
        inheritedPermissions: ['playback.control' as const],
        onlineDeviceCount: 1,
      },
    ];
    initConnect();
    bus.emit('pro-room:administrators-updated', administrators);
    const oldSettings = document.querySelector<HTMLButtonElement>(
      '#connect-administrator-list .administrator-action-button.settings',
    );
    oldSettings?.focus();
    oldSettings?.click();

    bus.emit(
      'pro-room:administrators-updated',
      administrators.map((item) => ({ ...item })),
    );
    expect(oldSettings?.isConnected).toBe(false);
    document.getElementById('btn-administrator-permissions-cancel')?.click();
    await Promise.resolve();

    expect(document.activeElement).toBe(
      document.querySelector('#connect-administrator-list .administrator-action-button.settings'),
    );
  });

  it('restores focus to the visible connection control when the edited administrator disappears', async () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'owner-device');
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    const connectionControl = document.createElement('button');
    connectionControl.id = 'nav-connect';
    Object.defineProperty(connectionControl, 'offsetParent', { get: () => document.body });
    document.body.appendChild(connectionControl);
    const fullPermissions = {
      'media.add': true,
      'playback.control': true,
      'members.kick': true,
      'chat.notice': true,
    } as const;
    const administrators = [
      {
        memberId: 'owner-member',
        memberDisplayNumber: 0,
        isAuthenticated: true,
        displayName: 'Owner',
        role: 'owner' as const,
        permissions: { ...fullPermissions },
        inheritedPermissions: [
          'media.add' as const,
          'playback.control' as const,
          'members.kick' as const,
          'chat.notice' as const,
        ],
        onlineDeviceCount: 1,
      },
      {
        memberId: 'admin-member',
        memberDisplayNumber: 1,
        isAuthenticated: false,
        displayName: 'Admin',
        role: 'controller' as const,
        permissions: { ...fullPermissions },
        inheritedPermissions: ['playback.control' as const],
        onlineDeviceCount: 1,
      },
    ];
    initConnect();
    bus.emit('pro-room:administrators-updated', administrators);
    const settingsButton = document.querySelector<HTMLButtonElement>(
      '#desktop-administrator-list .administrator-action-button.settings',
    );
    settingsButton?.focus();
    settingsButton?.click();
    expect(
      document.getElementById('administrator-permissions-overlay')?.classList.contains('show'),
    ).toBe(true);

    // The edited anonymous administrator leaves while a responsive breakpoint
    // also hides the desktop administrator section that opened the dialog.
    bus.emit('pro-room:administrators-updated', [administrators[0]]);
    document.getElementById('desktop-administrator-section')?.setAttribute('hidden', '');
    expect(
      document.getElementById('administrator-permissions-overlay')?.classList.contains('show'),
    ).toBe(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(document.activeElement).toBe(connectionControl);
  });
});

describe('connect host-owned room password controls', () => {
  it('hides the room password controls from guests', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection());

    initConnect();

    expect(document.querySelector<HTMLElement>('.room-password-section')?.hidden).toBe(true);
  });

  it('shows the room password controls on the host', () => {
    setState('network.appRole', 'host');

    initConnect();

    expect(document.querySelector<HTMLElement>('.room-password-section')?.hidden).toBe(false);
  });

  it('shows masked PIN editing to a PRO owner', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('coordinator'));
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'coordinator',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });

    initConnect();

    expect(document.querySelector<HTMLElement>('.room-password-section')?.hidden).toBe(false);
    expect(document.getElementById('room-password-toggle')?.hidden).toBe(true);
    expect(document.getElementById('room-password-code')?.textContent).toBe('••••-••••');
    expect(document.getElementById('room-password-refresh')?.getAttribute('aria-label')).toBe(
      '방 암호 변경',
    );
    expect(document.querySelector('.room-password-refresh path')?.getAttribute('d')).toContain(
      'M3 17.25',
    );
  });

  it('keeps owner-only PRO settings hidden from regular PRO members', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('coordinator'));
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'coordinator',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['media.add', 'asset.upload'],
    });

    initConnect();

    expect(document.querySelector<HTMLElement>('.room-password-section')?.hidden).toBe(true);
  });

  it('changes the active PRO PIN through the owner-only pencil action', async () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection('coordinator'));
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'coordinator',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    mockedShowDialog.mockResolvedValue({ action: 'ok', inputValue: '12345678' });
    mockedChangeActiveProRoomPin.mockResolvedValue();
    initConnect();

    document.getElementById('room-password-refresh')?.click();

    await vi.waitFor(() => expect(mockedChangeActiveProRoomPin).toHaveBeenCalledWith('12345678'));
    expect(mockedShowDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '방 암호 변경',
        message: '새 8자리 암호를 설정해 주세요. 모든 참여자가 다시 입장해야 해요.',
        inputField: expect.objectContaining({ maxLength: 8, inputMode: 'numeric' }),
      }),
    );
    expect(showToast).toHaveBeenCalledWith('방 암호를 변경했어요.');
  });
});

describe('connect permission toasts', () => {
  it('tells guests that only the host can change the room password setting', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection());

    initConnect();

    const toggle = document.getElementById('room-password-toggle') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');

    toggle.click();

    expect(showToast).toHaveBeenCalledWith('방장만 이 설정을 변경할 수 있어요');
    expect(getState('network.roomPasswordRequired')).toBe(false);
  });
});

describe('connect account nickname authority', () => {
  it('keeps the server-owned Peer N namespace unavailable in the PRO nickname dialog', async () => {
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('network.myId', 'member-1');
    setState('network.myDeviceLabel', 'Peer 1');
    setState('network.lastKnownDeviceList', [
      {
        id: 'member-1',
        label: 'Peer 1',
        joinOrder: 0,
        status: 'connected',
        isHost: false,
        isOp: true,
      },
    ]);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    mockedShowDialog.mockResolvedValue({ action: 'cancel' });
    initConnect();

    document.getElementById('btn-change-nickname')?.click();

    await vi.waitFor(() => expect(mockedShowDialog).toHaveBeenCalled());
    const options = mockedShowDialog.mock.calls.at(-1)?.[0];
    if (!options || typeof options === 'string')
      throw new Error('expected nickname dialog options');
    const validator = options.inputField?.validator;
    expect(validator?.('pEeR')).toBe(validator?.('HOST'));
    expect(validator?.('Studio_Tab')).toBeNull();
  });

  it('does not treat a server-authority PRO owner as the reserved HOST identity', async () => {
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('network.myId', 'owner-member');
    setState('network.myDeviceLabel', 'Owner');
    setState('network.lastKnownDeviceList', [
      {
        id: 'owner-member',
        label: 'Owner',
        joinOrder: 0,
        status: 'connected',
        isHost: false,
        isOp: true,
      },
    ]);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: null,
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['room.configure'],
    });
    mockedShowDialog.mockResolvedValue({ action: 'cancel' });
    initConnect();

    document.getElementById('btn-change-nickname')?.click();

    await vi.waitFor(() => expect(mockedShowDialog).toHaveBeenCalled());
    const options = mockedShowDialog.mock.calls.at(-1)?.[0];
    if (!options || typeof options === 'string')
      throw new Error('expected nickname dialog options');
    expect(options?.inputField?.validator?.('HOST')).toBe('사용할 수 없는 이름이에요.');
  });
});

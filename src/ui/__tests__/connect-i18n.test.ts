/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { setLanguageMode } from '../../i18n/index.ts';
import type { DataConnection } from '../../types/index.ts';
import { changeActiveProRoomPin } from '../../pro-room/runtime.ts';
import { showToast } from '../toast.ts';
import { showDialog } from '../dialog.ts';
import { initConnect } from '../connect.ts';

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

vi.mock('../../pro-room/runtime.ts', () => ({
  changeActiveProRoomPin: vi.fn(),
}));

const mockedShowDialog = vi.mocked(showDialog);
const mockedChangeActiveProRoomPin = vi.mocked(changeActiveProRoomPin);

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
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
    <div class="section-group max-guests-section">
      <div class="number-stepper" id="max-device-stepper">
        <button type="button" class="stepper-btn" data-dir="-1"></button>
        <span class="stepper-value" id="max-device-value">3</span>
        <button type="button" class="stepper-btn" data-dir="1"></button>
      </div>
    </div>
    <div id="connect-device-title"></div>
    <div id="desktop-device-title"></div>
    <div id="connect-device-list"></div>
    <div id="desktop-device-list"></div>
  `;
  setLanguageMode('ko');
});

function makeConnection(peer = 'host-1'): DataConnection {
  return { peer, open: true } as DataConnection;
}

describe('connect i18n refresh', () => {
  it('keeps generated QR placeholders translatable', () => {
    initConnect();

    const placeholder = document.querySelector<HTMLElement>('#qr-container .qr-placeholder');
    expect(placeholder?.getAttribute('data-i18n')).toBe('connect.no_session');

    setLanguageMode('en');

    expect(placeholder?.textContent).toBe('Start a session first');
  });

  it('rerenders dynamic device actions on language changes', () => {
    initConnect();

    bus.emit('network:device-list-update', [
      { id: 'peer-1', label: '', joinOrder: 1, status: 'connected', isHost: false, isOp: false },
    ]);

    setLanguageMode('en');

    expect(document.querySelector<HTMLElement>('.d-name')?.textContent).toContain('Peer');
    expect(document.querySelector<HTMLButtonElement>('.d-op-btn')?.textContent).toBe('Grant admin');
    expect(document.querySelector<HTMLButtonElement>('.btn-kick-device')?.ariaLabel).toBe(
      'Kick device',
    );
  });

  it('hides legacy ADMIN controls in a PRO room while preserving kick', () => {
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

    expect(document.querySelector('.d-op-badge')).not.toBeNull();
    expect(document.querySelector('.d-op-btn')).not.toBeNull();

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
    expect(document.querySelectorAll('.btn-kick-device')).toHaveLength(2);
  });

  it('lets a PRO member controller request another member kick through the coordinator', async () => {
    const send = vi.fn();
    setState('network.appRole', 'guest');
    setState('network.myId', 'controller-member');
    setState('network.hostConn', {
      peer: '000001',
      open: true,
      send,
    } as unknown as DataConnection);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'owner-participant',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['members.manage'],
    });
    mockedShowDialog.mockResolvedValue({ action: 'ok' });
    initConnect();

    bus.emit('network:device-list-update', [
      {
        id: '000001',
        label: 'Coordinator',
        joinOrder: 0,
        status: 'connected',
        isHost: true,
        isOp: true,
      },
      {
        id: 'controller-member',
        label: 'Me',
        joinOrder: 1,
        status: 'connected',
        isHost: false,
        isOp: true,
      },
      {
        id: 'target-member',
        label: 'Friend',
        joinOrder: 2,
        status: 'connected',
        isHost: false,
        isOp: true,
      },
      {
        id: 'offline-member',
        label: 'Offline',
        joinOrder: 3,
        status: 'disconnected',
        isHost: false,
        isOp: true,
      },
    ]);

    const kickButtons = document.querySelectorAll<HTMLButtonElement>('.btn-kick-device');
    expect(kickButtons).toHaveLength(2);
    expect([...kickButtons].every((button) => button.dataset.kickPeer === 'target-member')).toBe(
      true,
    );
    kickButtons[0]?.click();

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'request-kick-device',
        targetPeerId: 'target-member',
      }),
    );
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

describe('connect host-owned admission controls', () => {
  it('hides controls from guests because the values are host-local admission policy', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection());

    initConnect();

    expect(document.querySelector<HTMLElement>('.room-password-section')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.max-guests-section')?.hidden).toBe(true);
  });

  it('shows controls on the host', () => {
    setState('network.appRole', 'host');

    initConnect();

    expect(document.querySelector<HTMLElement>('.room-password-section')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.max-guests-section')?.hidden).toBe(false);
  });

  it('shows only masked PIN editing to a PRO owner and hides legacy guest limits', () => {
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
    expect(document.querySelector<HTMLElement>('.max-guests-section')?.hidden).toBe(true);
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
      capabilities: ['queue.mutate', 'asset.upload'],
    });

    initConnect();

    expect(document.querySelector<HTMLElement>('.room-password-section')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.max-guests-section')?.hidden).toBe(true);
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

  it('keeps max-device controls host-only, even for operator guests', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', makeConnection());
    setState('network.isOperator', true);

    initConnect();
    const beforeSlots = getState('network.maxGuestSlots');
    document
      .querySelector<HTMLButtonElement>('#max-device-stepper .stepper-btn[data-dir="1"]')
      ?.click();

    expect(showToast).toHaveBeenCalledWith('방장만 이 설정을 변경할 수 있어요');
    expect(getState('network.maxGuestSlots')).toBe(beforeSlots);
  });
});

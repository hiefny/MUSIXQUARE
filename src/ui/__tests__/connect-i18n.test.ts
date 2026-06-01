/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { setLanguageMode } from '../../i18n/index.ts';
import type { DataConnection } from '../../types/index.ts';
import { showToast } from '../toast.ts';
import { initConnect } from '../connect.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = `
    <div id="qr-container"></div>
    <div id="desktop-qr-container"></div>
    <button type="button" class="room-password-toggle" id="room-password-toggle"></button>
    <span id="room-password-code"></span>
    <button type="button" class="room-password-refresh" id="room-password-refresh"></button>
    <div id="room-password-code-row"></div>
    <div class="number-stepper" id="max-device-stepper">
      <button type="button" class="stepper-btn" data-dir="-1"></button>
      <span class="stepper-value" id="max-device-value">3</span>
      <button type="button" class="stepper-btn" data-dir="1"></button>
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
    expect(document.querySelector<HTMLButtonElement>('.d-op-btn')?.textContent).toBe(
      'Grant admin',
    );
    expect(document.querySelector<HTMLButtonElement>('.btn-kick-device')?.ariaLabel).toBe(
      'Kick device',
    );
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
    document.querySelector<HTMLButtonElement>('#max-device-stepper .stepper-btn[data-dir="1"]')
      ?.click();

    expect(showToast).toHaveBeenCalledWith('방장만 이 설정을 변경할 수 있어요');
    expect(getState('network.maxGuestSlots')).toBe(beforeSlots);
  });
});

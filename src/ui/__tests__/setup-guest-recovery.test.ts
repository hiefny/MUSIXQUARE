/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actions: [] as Array<Record<string, unknown>>,
  joinSession: vi.fn(),
  pendingAutoCode: null as string | null,
  pendingRole: 0 as number | null,
  setupRenderActions: vi.fn((buttons: Array<Record<string, unknown>>) => {
    mocks.actions = buttons;
  }),
  setupSetGuestJoinError: vi.fn(),
  showToast: vi.fn(),
  state: new Map<string, unknown>(),
}));

vi.mock('../../core/state.ts', () => ({
  getState: (key: string) => mocks.state.get(key),
  setState: (key: string, value: unknown) => mocks.state.set(key, value),
}));

vi.mock('../../core/timers.ts', () => ({
  clearManagedTimer: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  joinSession: mocks.joinSession,
}));

vi.mock('../dom.ts', () => ({
  animateTransition: vi.fn((apply: () => void) => apply()),
}));

vi.mock('../../core/session-reset.ts', () => ({
  scheduleSessionReset: vi.fn(),
}));

vi.mock('../dialog.ts', () => ({
  showDialog: vi.fn(),
}));

vi.mock('../../youtube/player.ts', () => ({
  precreateYouTubePlayer: vi.fn(),
}));

vi.mock('../setup-start.ts', () => ({
  prepareSetupStartFromGesture: vi.fn(),
}));

vi.mock('../../pro-room/room-code.ts', () => ({
  isProRoomCode: vi.fn(() => false),
}));

vi.mock('../../pro-room/setup-flow.ts', () => ({
  enterProRoomFromSetup: vi.fn(),
}));

vi.mock('../setup-shared.ts', () => ({
  t: (key: string) => key,
  bus: { emit: vi.fn() },
  showToast: mocks.showToast,
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  selectStandardChannelButton: vi.fn(),
  BACK_SVG: '<svg></svg>',
  getPendingGuestRoleMode: () => mocks.pendingRole,
  setPendingGuestRoleMode: (value: number | null) => {
    mocks.pendingRole = value;
  },
  getPendingAutoJoinCode: () => mocks.pendingAutoCode,
  setupSetAutoJoinCode: vi.fn(),
  setOnInviteLinkRoleSelected: vi.fn(),
  setupEl: (id: string) => document.getElementById(id),
  stopObAutoSlide: vi.fn(),
  setupShowCodeArea: vi.fn(),
  setupShowAutoJoinArea: vi.fn(),
  setupShowJoinArea: vi.fn(),
  setupShowWelcome: vi.fn(),
  setupShowRoleArea: vi.fn(),
  setupHighlightJoinRole: vi.fn(),
  setupSetGuestJoinBusy: vi.fn(),
  setupSetGuestJoinError: mocks.setupSetGuestJoinError,
  setupRenderActions: mocks.setupRenderActions,
}));

import {
  handleSetupJoinWithRole,
  restoreGuestJoinControlsAfterFailure,
  setGuestGoBack,
} from '../setup-guest.ts';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actions = [];
  mocks.pendingAutoCode = null;
  mocks.pendingRole = 0;
  mocks.state.clear();
  mocks.state.set('network.appRole', 'guest');
  document.body.innerHTML = `
    <input id="setup-join-code" value="123456">
    <div id="ob-slider-area"></div>
  `;
});

describe('guest setup recovery', () => {
  it('preserves the entered code and exposes inline Retry and Back actions', async () => {
    const goBack = vi.fn();
    setGuestGoBack(goBack);

    await handleSetupJoinWithRole(0);
    expect(mocks.joinSession).toHaveBeenCalledWith('123456');

    const input = document.getElementById('setup-join-code') as HTMLInputElement;
    input.disabled = true;
    restoreGuestJoinControlsAfterFailure('error.host_unreachable');

    expect(input.value).toBe('123456');
    expect(input.disabled).toBe(false);
    expect(mocks.setupSetGuestJoinError).toHaveBeenLastCalledWith('error.host_unreachable', false);
    expect(mocks.actions[0]).toMatchObject({
      id: 'btn-setup-back',
      ariaLabel: 'dialog.go_back',
    });
    expect(mocks.actions[1]).toMatchObject({
      id: 'btn-setup-confirm',
      text: 'common.retry',
    });

    const retry = mocks.actions[1]?.onClick as (() => void) | undefined;
    retry?.();
    expect(mocks.joinSession).toHaveBeenCalledTimes(2);
    expect(input.value).toBe('123456');

    restoreGuestJoinControlsAfterFailure('error.host_unreachable');
    const back = mocks.actions[0]?.onClick as (() => void) | undefined;
    back?.();
    expect(goBack).toHaveBeenCalledOnce();
  });

  it('shows invalid code feedback inline without a transient toast', async () => {
    const input = document.getElementById('setup-join-code') as HTMLInputElement;
    input.value = '123';

    await handleSetupJoinWithRole(0);

    expect(mocks.joinSession).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
    expect(mocks.setupSetGuestJoinError).toHaveBeenLastCalledWith('setup.six_digit_enter');
    expect(document.activeElement).toBe(input);
  });
});

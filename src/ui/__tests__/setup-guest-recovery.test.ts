/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actions: [] as Array<Record<string, unknown>>,
  busEmit: vi.fn(),
  enterProRoomFromSetup: vi.fn(),
  isProRoomCode: vi.fn(() => false),
  joinSession: vi.fn(),
  prepareFromGesture: vi.fn<() => Promise<boolean> | null>(() => null),
  primeReady: true,
  waitForPrimeReady: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  scannerCallbacks: null as null | {
    onStartFromGesture?: () => void;
    onCode: (code: string) => void;
  },
  pendingAutoCode: null as string | null,
  pendingRole: 0 as number | null,
  scheduleDocumentReload: vi.fn(),
  scheduleSessionReset: vi.fn(),
  setupRenderActions: vi.fn((buttons: Array<Record<string, unknown>>) => {
    mocks.actions = buttons;
    const area = document.getElementById('setup-actions');
    if (area) {
      area.replaceChildren();
      for (const spec of buttons) {
        const button = document.createElement('button');
        button.id = String(spec.id);
        button.textContent = String(spec.text ?? '');
        button.disabled = !!spec.disabled;
        if (spec.onClick) button.addEventListener('click', spec.onClick as () => void);
        area.appendChild(button);
      }
    }
  }),
  setupSetGuestJoinError: vi.fn((message: string | null, inviteLink = false) => {
    const renderError = (id: string, value: string | null): void => {
      const error = document.getElementById(id);
      if (!error) return;
      const normalized = typeof value === 'string' ? value.trim() : '';
      error.textContent = normalized;
      error.hidden = normalized.length === 0;
    };

    renderError('setup-guest-error', inviteLink ? null : message);
    renderError('setup-auto-join-error', inviteLink ? message : null);

    const input = document.getElementById('setup-join-code');
    if (!input) return;
    if (message && !inviteLink) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }),
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
  scheduleDocumentReload: mocks.scheduleDocumentReload,
  scheduleSessionReset: mocks.scheduleSessionReset,
}));

vi.mock('../dialog.ts', () => ({
  showDialog: vi.fn(),
}));

vi.mock('../../youtube/player.ts', () => ({
  precreateYouTubePlayer: vi.fn(),
  isYouTubePrimeReadyForGesture: () => mocks.primeReady,
  waitForYouTubePrimeReady: mocks.waitForPrimeReady,
}));

vi.mock('../setup-start.ts', () => ({
  prepareSetupStartFromGesture: mocks.prepareFromGesture,
}));

vi.mock('../setup-qr-scanner.ts', () => ({
  stopGuestQrScanner: vi.fn(),
  initGuestQrScanner: (callbacks: typeof mocks.scannerCallbacks) => {
    mocks.scannerCallbacks = callbacks;
  },
}));

vi.mock('../../pro-room/room-code.ts', () => ({
  isProRoomCode: mocks.isProRoomCode,
}));

vi.mock('../../pro-room/setup-flow.ts', () => ({
  enterProRoomFromSetup: mocks.enterProRoomFromSetup,
}));

vi.mock('../setup-shared.ts', () => ({
  t: (key: string) => key,
  bus: { emit: mocks.busEmit },
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
  getSetupOverlayAbort: () => null,
  setupSetAutoJoinCode: vi.fn(),
  setOnInviteLinkRoleSelected: vi.fn(),
  setupEl: (id: string) => document.getElementById(id),
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
  startGuestFlow,
  clearPendingRoomPasswordJoin,
  promptForRoomPassword,
} from '../setup-guest.ts';
import { showDialog } from '../dialog.ts';

beforeEach(() => {
  clearPendingRoomPasswordJoin();
  vi.clearAllMocks();
  mocks.primeReady = true;
  mocks.waitForPrimeReady.mockReset().mockResolvedValue(undefined);
  mocks.prepareFromGesture.mockReset().mockReturnValue(null);
  mocks.scannerCallbacks = null;
  mocks.busEmit.mockReset();
  mocks.enterProRoomFromSetup.mockReset();
  mocks.isProRoomCode.mockReset();
  mocks.isProRoomCode.mockReturnValue(false);
  mocks.actions = [];
  mocks.pendingAutoCode = null;
  mocks.pendingRole = 0;
  mocks.state.clear();
  mocks.state.set('network.appRole', 'guest');
  mocks.state.set('room.context', { kind: 'standard' });
  document.body.innerHTML = `
    <input id="setup-join-code" value="123456" aria-describedby="setup-guest-error">
    <p id="setup-guest-error" role="alert" hidden></p>
    <p id="setup-auto-join-error" role="alert" hidden></p>
    <div id="ob-slider-area"></div>
    <div id="setup-actions"></div>
    <button id="btn-setup-qr-scan"></button>
  `;
});

describe('guest setup recovery', () => {
  it.each([false, true])(
    'waits for a ready iframe before the real Start tap (invite=%s)',
    async (invite) => {
      let ready!: () => void;
      mocks.primeReady = false;
      mocks.waitForPrimeReady.mockReturnValue(
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
      );
      mocks.pendingAutoCode = invite ? '123456' : null;
      startGuestFlow();
      const input = document.getElementById('setup-join-code') as HTMLInputElement;
      input.value = '123456';
      const start = document.getElementById('btn-setup-confirm') as HTMLButtonElement;
      expect(start.disabled).toBe(true);
      expect(start.textContent).toBe('common.wait');
      start.click();
      await handleSetupJoinWithRole(0); // Enter must not bypass the disabled control.
      expect(mocks.prepareFromGesture).not.toHaveBeenCalled();
      expect(mocks.joinSession).not.toHaveBeenCalled();
      mocks.primeReady = true;
      ready();
      await Promise.resolve();
      expect(start.disabled).toBe(false);
      expect(mocks.prepareFromGesture).not.toHaveBeenCalled();
      start.click();
      expect(mocks.prepareFromGesture).toHaveBeenCalledOnce();
      expect(mocks.joinSession).toHaveBeenCalledWith('123456');
    },
  );

  it.each([false, true])(
    'preserves the gesture proof before Standard/PRO admission (pro=%s)',
    async (pro) => {
      let complete!: (accepted: boolean) => void;
      mocks.prepareFromGesture.mockReturnValue(
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
      );
      mocks.isProRoomCode.mockReturnValue(pro);
      mocks.enterProRoomFromSetup.mockResolvedValue(true);
      const joining = handleSetupJoinWithRole(0);
      expect(mocks.prepareFromGesture).toHaveBeenCalledOnce();
      await handleSetupJoinWithRole(0);
      expect(mocks.prepareFromGesture).toHaveBeenCalledOnce();
      expect(mocks.joinSession).not.toHaveBeenCalled();
      expect(mocks.enterProRoomFromSetup).not.toHaveBeenCalled();
      complete(true);
      await joining;
      expect(pro ? mocks.enterProRoomFromSetup : mocks.joinSession).toHaveBeenCalledOnce();
    },
  );

  it('uses the scan tap activation and never primes from asynchronous QR recognition', async () => {
    let complete!: (accepted: boolean) => void;
    mocks.prepareFromGesture.mockReturnValue(
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }),
    );
    startGuestFlow();
    mocks.scannerCallbacks?.onStartFromGesture?.();
    expect(mocks.prepareFromGesture).toHaveBeenCalledOnce();
    mocks.scannerCallbacks?.onCode('654321');
    expect(mocks.prepareFromGesture).toHaveBeenCalledOnce();
    expect(mocks.joinSession).not.toHaveBeenCalled();
    complete(true);
    await vi.waitFor(() => expect(mocks.joinSession).toHaveBeenCalledWith('654321'));
  });

  it('does not admit a canceled attempt after its late activation proof', async () => {
    let complete!: (accepted: boolean) => void;
    mocks.prepareFromGesture.mockReturnValue(
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }),
    );
    const joining = handleSetupJoinWithRole(0);
    clearPendingRoomPasswordJoin();
    complete(true);
    await joining;
    expect(mocks.joinSession).not.toHaveBeenCalled();
  });

  it('continues room admission after a bounded, unsuccessful autoplay attempt', async () => {
    mocks.prepareFromGesture.mockResolvedValue(false);
    await handleSetupJoinWithRole(0);
    expect(mocks.joinSession).toHaveBeenCalledWith('123456');
  });

  it('uses the password confirmation gesture before retrying room admission', async () => {
    await handleSetupJoinWithRole(0);
    mocks.joinSession.mockClear();
    mocks.prepareFromGesture.mockClear();
    let complete!: (accepted: boolean) => void;
    mocks.prepareFromGesture.mockReturnValue(
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }),
    );
    vi.mocked(showDialog).mockImplementationOnce(async (options) => {
      if (typeof options === 'object') options.onPrimaryActivation?.();
      return { action: 'ok', inputValue: '12345678' };
    });
    const retrying = promptForRoomPassword();
    expect(mocks.prepareFromGesture).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(mocks.joinSession).not.toHaveBeenCalled();
    complete(true);
    await retrying;
    expect(mocks.joinSession).toHaveBeenCalledWith('123456', '12345678');
  });

  it('joins exactly once through the signaling-owned path without a control-plane preflight', async () => {
    await handleSetupJoinWithRole(0);

    expect(mocks.joinSession).toHaveBeenCalledOnce();
    expect(mocks.joinSession).toHaveBeenCalledWith('123456');
    expect(mocks.actions[0]).toMatchObject({ id: 'btn-setup-back', disabled: true });
  });

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

    const retry = mocks.actions[1]?.onClick as (() => Promise<void>) | undefined;
    await retry?.();
    expect(mocks.joinSession).toHaveBeenCalledTimes(2);
    expect(input.value).toBe('123456');

    restoreGuestJoinControlsAfterFailure('error.host_unreachable');
    const back = mocks.actions[0]?.onClick as (() => void) | undefined;
    back?.();
    expect(goBack).toHaveBeenCalledOnce();
  });

  it('renders a real Refresh action instead of retrying a terminal lazy failure', () => {
    restoreGuestJoinControlsAfterFailure('dialog.sw_update_msg', true);

    expect(mocks.actions[1]).toMatchObject({
      id: 'btn-setup-confirm',
      text: 'common.refresh',
    });
    const refresh = mocks.actions[1]?.onClick as (() => void) | undefined;
    refresh?.();

    expect(mocks.joinSession).not.toHaveBeenCalled();
    expect(mocks.scheduleDocumentReload).toHaveBeenCalledWith('dialog.refreshing_session');
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

  it('keeps a failed PRO invite join on its auto-join error and retries the same code', async () => {
    const goBack = vi.fn();
    const failure = new Error('PRO room unavailable');
    setGuestGoBack(goBack);
    mocks.pendingAutoCode = '000001';
    mocks.isProRoomCode.mockReturnValue(true);
    mocks.enterProRoomFromSetup.mockRejectedValue(failure);
    mocks.busEmit.mockImplementation((event: string, payload?: unknown) => {
      if (event !== 'setup:guest-join-failure') return;
      restoreGuestJoinControlsAfterFailure(
        (payload as { userMessage?: string } | undefined)?.userMessage ?? null,
      );
    });

    startGuestFlow();
    const start = mocks.actions[1]?.onClick as (() => Promise<void>) | undefined;
    await start?.();

    expect(mocks.enterProRoomFromSetup).toHaveBeenNthCalledWith(1, '000001');
    expect(mocks.busEmit).toHaveBeenCalledWith('setup:guest-join-failure', {
      error: failure,
      userMessage: 'pro.connect_failed',
    });
    expect(mocks.setupSetGuestJoinError).toHaveBeenLastCalledWith('pro.connect_failed', true);

    const guestError = document.getElementById('setup-guest-error') as HTMLElement;
    const autoJoinError = document.getElementById('setup-auto-join-error') as HTMLElement;
    expect(guestError.textContent).toBe('');
    expect(guestError.hidden).toBe(true);
    expect(autoJoinError.textContent).toBe('pro.connect_failed');
    expect(autoJoinError.hidden).toBe(false);

    expect(mocks.actions[0]).toMatchObject({
      id: 'btn-setup-back',
      ariaLabel: 'dialog.go_back',
    });
    expect(mocks.actions[1]).toMatchObject({
      id: 'btn-setup-confirm',
      text: 'common.retry',
    });

    const retry = mocks.actions[1]?.onClick as (() => Promise<void>) | undefined;
    const back = mocks.actions[0]?.onClick as (() => void) | undefined;
    await retry?.();
    expect(mocks.enterProRoomFromSetup).toHaveBeenNthCalledWith(2, '000001');

    back?.();
    expect(mocks.scheduleSessionReset).toHaveBeenCalledWith(
      'dialog.leaving_session',
      expect.any(Function),
    );
    expect(goBack).not.toHaveBeenCalled();
  });

  it('keeps a terminal PRO lazy failure on a dedicated Refresh action', async () => {
    const input = document.getElementById('setup-join-code') as HTMLInputElement;
    input.value = '000001';
    mocks.isProRoomCode.mockReturnValue(true);
    mocks.enterProRoomFromSetup.mockResolvedValue('reload-required');

    await handleSetupJoinWithRole(0);

    expect(mocks.actions[0]).toMatchObject({ id: 'btn-setup-back', disabled: true });
    expect(mocks.actions[1]).toMatchObject({
      id: 'btn-setup-confirm',
      text: 'common.refresh',
    });
    expect(mocks.busEmit).not.toHaveBeenCalledWith('setup:guest-join-success');
    expect(mocks.busEmit).not.toHaveBeenCalledWith('setup:guest-join-failure', expect.anything());

    const refresh = mocks.actions[1]?.onClick as (() => void) | undefined;
    refresh?.();
    expect(mocks.scheduleDocumentReload).toHaveBeenCalledWith('dialog.refreshing_session');
  });
});

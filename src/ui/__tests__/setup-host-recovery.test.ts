/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actions: [] as Array<Record<string, unknown>>,
  animateTransition: vi.fn((apply: () => void) => apply()),
  createSession: vi.fn(),
  flowId: 0,
  preloadQrEncoder: vi.fn(),
  revealQr: vi.fn(async () => true),
  scheduleDocumentReload: vi.fn(),
  setupRenderActions: vi.fn((buttons: Array<Record<string, unknown>>) => {
    mocks.actions = buttons;
  }),
  setupSetCode: vi.fn(),
  setupSetHostError: vi.fn(),
  state: new Map<string, unknown>(),
}));

vi.mock('../../core/state.ts', () => ({
  getState: (key: string) => mocks.state.get(key),
  setState: (key: string, value: unknown) => mocks.state.set(key, value),
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn(),
}));

vi.mock('../../core/session-reset.ts', () => ({
  scheduleDocumentReload: mocks.scheduleDocumentReload,
}));

vi.mock('../../chat/protocol.ts', () => ({
  clearLatestPinnedNotice: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  createHostSessionWithShortCode: mocks.createSession,
  broadcastDeviceList: vi.fn(),
}));

vi.mock('../../youtube/player.ts', () => ({
  precreateYouTubePlayer: vi.fn(),
}));

vi.mock('../setup-start.ts', () => ({
  prepareSetupStartFromGesture: vi.fn(),
}));

vi.mock('../dom.ts', () => ({
  animateTransition: mocks.animateTransition,
}));

vi.mock('../setup-host-invite.ts', () => ({
  finishHostInviteLoading: vi.fn(),
  preloadHostInviteQrEncoder: mocks.preloadQrEncoder,
  resetHostInviteVisual: vi.fn(),
  revealHostInviteQr: mocks.revealQr,
}));

vi.mock('../setup-shared.ts', () => ({
  t: (key: string) => key,
  bus: { emit: vi.fn() },
  showToast: vi.fn(),
  updateRoleBadge: vi.fn(),
  updateInviteCodeUI: vi.fn(),
  selectStandardChannelButton: vi.fn(),
  BACK_SVG: '<svg></svg>',
  getHostCodeFlowId: () => mocks.flowId,
  getSetupOverlayAbort: () => null,
  incrementHostCodeFlowId: () => ++mocks.flowId,
  setupEl: (id: string) => document.getElementById(id),
  setupShowJoinArea: vi.fn(),
  setupShowAutoJoinArea: vi.fn(),
  setupShowCodeArea: vi.fn(),
  setupShowWelcome: vi.fn(),
  setupShowRoleArea: vi.fn(),
  setupHighlightJoinRole: vi.fn(),
  setupSetHostError: mocks.setupSetHostError,
  setupSetCode: mocks.setupSetCode,
  setupRenderActions: mocks.setupRenderActions,
  setupRenderActionsInTransition: (
    buttons: Array<Record<string, unknown>>,
    _layout?: string,
    onRendered?: () => void,
  ) =>
    mocks.animateTransition(() => {
      mocks.setupRenderActions(buttons);
      onRendered?.();
    }),
  hideSetupOverlay: vi.fn(),
}));

import { setHostGoBack, startHostFlow } from '../setup-host.ts';
import { createLazyFeatureLoadError } from '../../core/lazy-feature-failure.ts';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.animateTransition.mockImplementation((apply: () => void) => apply());
  mocks.createSession.mockReset();
  mocks.actions = [];
  mocks.flowId = 0;
  mocks.state.clear();
  mocks.state.set('network.appRole', 'idle');
  document.body.innerHTML = '<input id="setup-code"><div id="ob-slider-area"></div>';
});

describe('host setup recovery', () => {
  it('starts exactly one signaling-owned room creation without a control-plane preflight', async () => {
    let releaseCreation!: (code: string) => void;
    mocks.createSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseCreation = resolve;
        }),
    );

    startHostFlow();

    const carousel = document.getElementById('ob-slider-area')!;
    expect(carousel.hidden).toBe(true);
    expect(carousel.style.display).toBe('');
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.actions[1]).toMatchObject({
      id: 'btn-setup-confirm',
      text: 'common.wait',
      disabled: true,
    });

    releaseCreation('654321');
    await vi.waitFor(() => expect(mocks.setupSetCode).toHaveBeenCalledWith('654321'));
  });

  it('hides the carousel inside the setup transition so the outgoing snapshot keeps it', () => {
    const queued: Array<() => void> = [];
    mocks.animateTransition.mockImplementation((apply: () => void) => {
      queued.push(apply);
    });
    mocks.createSession.mockReturnValueOnce(new Promise<string>(() => {}));

    startHostFlow();

    // The browser captures the outgoing screen before it runs the callback.
    const carousel = document.getElementById('ob-slider-area')!;
    expect(carousel.hidden).toBe(false);
    queued.forEach((apply) => apply());
    expect(carousel.hidden).toBe(true);
  });

  it('swaps the actions inside the setup transition so the outgoing snapshot keeps them', () => {
    const queued: Array<() => void> = [];
    mocks.animateTransition.mockImplementation((apply: () => void) => {
      queued.push(apply);
    });
    mocks.createSession.mockReturnValueOnce(new Promise<string>(() => {}));
    mocks.actions = [{ id: 'btn-setup-host' }, { id: 'btn-setup-guest' }];

    startHostFlow();

    // Swapped before the capture, one row of buttons would re-center the
    // outgoing carousel and change outside the crossfade.
    const ids = () => mocks.actions.map((action) => action.id);
    expect(ids()).toEqual(['btn-setup-host', 'btn-setup-guest']);
    queued.forEach((apply) => apply());
    expect(ids()).toEqual(['btn-setup-back', 'btn-setup-confirm']);
  });

  it('starts loading the QR encoder with each room request, before its code arrives', async () => {
    mocks.createSession
      .mockRejectedValueOnce(new Error('signaling unavailable'))
      .mockResolvedValueOnce('123456');

    startHostFlow();

    expect(mocks.preloadQrEncoder).toHaveBeenCalledOnce();
    expect(mocks.preloadQrEncoder.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createSession.mock.invocationCallOrder[0]!,
    );
    await vi.waitFor(() => {
      expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('error.session_create_fail');
    });

    const retry = mocks.actions[1]?.onClick as (() => void) | undefined;
    retry?.();

    expect(mocks.preloadQrEncoder).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(mocks.revealQr).toHaveBeenCalledWith('123456', expect.any(Function));
    });
  });

  it('discards a late signaling result when Back wins the room-creation race', async () => {
    let releaseCreation!: (code: string) => void;
    const goBack = vi.fn(() => {
      mocks.flowId++;
    });
    setHostGoBack(goBack);
    mocks.createSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseCreation = resolve;
        }),
    );

    startHostFlow();
    const back = mocks.actions[0]?.onClick as (() => void) | undefined;
    back?.();
    releaseCreation('654321');
    await Promise.resolve();

    expect(goBack).toHaveBeenCalledOnce();
    expect(mocks.setupSetCode).not.toHaveBeenCalled();
  });

  it('keeps a creation failure inline until the user explicitly retries or goes back', async () => {
    const goBack = vi.fn();
    setHostGoBack(goBack);
    mocks.createSession
      .mockRejectedValueOnce(new Error('signaling unavailable'))
      .mockResolvedValueOnce('123456');

    startHostFlow();

    await vi.waitFor(() => {
      expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('error.session_create_fail');
    });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.actions).toHaveLength(2);
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

    await vi.waitFor(() => {
      expect(mocks.setupSetCode).toHaveBeenCalledWith('123456');
    });
    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(mocks.state.get('network.sessionCode')).toBe('123456');

    const back = mocks.actions[0]?.onClick as (() => void) | undefined;
    back?.();
    expect(goBack).toHaveBeenCalledOnce();
  });

  it('replaces a fake retry with Refresh after a terminal room-feature failure', async () => {
    mocks.createSession.mockRejectedValueOnce(
      createLazyFeatureLoadError('room-session', new TypeError('chunk unavailable')),
    );

    startHostFlow();

    await vi.waitFor(() => {
      expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('dialog.sw_update_msg');
    });
    expect(mocks.actions[1]).toMatchObject({
      id: 'btn-setup-confirm',
      text: 'common.refresh',
    });

    const refresh = mocks.actions[1]?.onClick as (() => void) | undefined;
    refresh?.();
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.scheduleDocumentReload).toHaveBeenCalledWith('dialog.refreshing_session');
  });
});

/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actions: [] as Array<Record<string, unknown>>,
  createSession: vi.fn(),
  waitForReadiness: vi.fn<
    (
      signal?: AbortSignal,
      onAttempt?: (progress: { attempt: number; maxAttempts: number }) => void,
    ) => Promise<void>
  >(async () => undefined),
  flowId: 0,
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

vi.mock('../../chat/protocol.ts', () => ({
  clearLatestPinnedNotice: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  createHostSessionWithShortCode: mocks.createSession,
  broadcastDeviceList: vi.fn(),
}));

vi.mock('../../network/standard-room-prerequisites.ts', () => ({
  waitForStandardRoomReadiness: mocks.waitForReadiness,
}));

vi.mock('../../youtube/player.ts', () => ({
  precreateYouTubePlayer: vi.fn(),
}));

vi.mock('../setup-start.ts', () => ({
  prepareSetupStartFromGesture: vi.fn(),
}));

vi.mock('../dom.ts', () => ({
  animateTransition: vi.fn((apply: () => void) => apply()),
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
  hideSetupOverlay: vi.fn(),
}));

import { setHostGoBack, startHostFlow } from '../setup-host.ts';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSession.mockReset();
  mocks.waitForReadiness.mockReset();
  mocks.waitForReadiness.mockResolvedValue(undefined);
  mocks.actions = [];
  mocks.flowId = 0;
  mocks.state.clear();
  mocks.state.set('network.appRole', 'idle');
  document.body.innerHTML = '<input id="setup-code"><div id="ob-slider-area"></div>';
});

describe('host setup recovery', () => {
  it('creates exactly one room only after the read-only readiness boundary succeeds', async () => {
    let releaseReadiness!: () => void;
    mocks.waitForReadiness.mockImplementationOnce((_signal, onAttempt) => {
      onAttempt?.({ attempt: 2, maxAttempts: 3 });
      return new Promise<void>((resolve) => {
        releaseReadiness = resolve;
      });
    });
    mocks.createSession.mockResolvedValueOnce('654321');

    startHostFlow();

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.actions[0]).toMatchObject({ id: 'btn-setup-back' });
    expect(mocks.actions[0]).not.toHaveProperty('disabled');
    expect(mocks.actions[1]).toMatchObject({
      id: 'btn-setup-confirm',
      text: 'connect.signaling_reconnecting',
      disabled: true,
    });

    releaseReadiness();
    await vi.waitFor(() => expect(mocks.setupSetCode).toHaveBeenCalledWith('654321'));
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it('does not create a room when Back wins a readiness race', async () => {
    let releaseReadiness!: () => void;
    const goBack = vi.fn(() => {
      mocks.flowId++;
    });
    setHostGoBack(goBack);
    mocks.waitForReadiness.mockImplementationOnce((_signal, onAttempt) => {
      onAttempt?.({ attempt: 1, maxAttempts: 3 });
      return new Promise<void>((resolve) => {
        releaseReadiness = resolve;
      });
    });

    startHostFlow();
    const back = mocks.actions[0]?.onClick as (() => void) | undefined;
    back?.();
    releaseReadiness();
    await Promise.resolve();
    await Promise.resolve();

    expect(goBack).toHaveBeenCalledOnce();
    expect(mocks.createSession).not.toHaveBeenCalled();
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
    expect(mocks.waitForReadiness).toHaveBeenCalledTimes(1);
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
});

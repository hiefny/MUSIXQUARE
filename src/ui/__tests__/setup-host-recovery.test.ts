/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actions: [] as Array<Record<string, unknown>>,
  animateTransition: vi.fn((apply: () => void) => apply()),
  createSession: vi.fn(),
  flowId: 0,
  preloadQrEncoder: vi.fn(),
  resetVisual: vi.fn(),
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
  resetHostInviteVisual: mocks.resetVisual,
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
import { requestForcedAppUpdateFor, setForcedAppUpdateHandler } from '../../core/app-build.ts';
import { createLazyFeatureLoadError } from '../../core/lazy-feature-failure.ts';

/** The browser's own network report, as navigator.onLine gives it. */
function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

/**
 * What room creation rejects with when every setup route of an offline device
 * failed: the HTTPS bridge's error event, with no HTTP answer.
 */
function bridgeErrorWithoutAnswer(): Event {
  return Object.assign(new Event('error'), {
    phase: 'open',
    status: null,
    cause: new TypeError('Failed to fetch'),
  });
}

/** What a dynamic import rejects with when its chunk cannot be fetched. */
function chunkFailure(): TypeError {
  return new TypeError('Failed to fetch dynamically imported module');
}

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

  it('batches each attempt’s step transition before it shows the loading spinner again', async () => {
    mocks.createSession
      .mockRejectedValueOnce(new Error('signaling unavailable'))
      .mockReturnValueOnce(new Promise<string>(() => {}));

    // The Host tap: the welcome-to-host and step transitions come first.
    startHostFlow();
    const firstReset = mocks.resetVisual.mock.invocationCallOrder[0]!;
    expect(
      mocks.animateTransition.mock.invocationCallOrder.filter((order) => order < firstReset),
    ).toHaveLength(2);
    await vi.waitFor(() => {
      expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('error.session_create_fail');
    });

    // Retry has no transition of its own batched before the step's: the
    // spinner would show at once, inside that transition's images
    // (setup-host-invite.ts waits only for one already batched).
    mocks.animateTransition.mockClear();
    mocks.resetVisual.mockClear();
    const retry = mocks.actions[1]?.onClick as (() => void) | undefined;
    retry?.();
    expect(mocks.resetVisual).toHaveBeenCalledOnce();
    expect(mocks.animateTransition.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.resetVisual.mock.invocationCallOrder[0]!,
    );
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

  describe('a refusal below the App build floor (forced update, train 9.0.14)', () => {
    afterEach(() => {
      setForcedAppUpdateHandler({ request: () => false, isPending: () => false });
    });

    function refusal(answer: boolean): Error {
      setForcedAppUpdateHandler({ request: () => answer, isPending: () => false });
      const error = Object.assign(new Error('APP_UPDATE_REQUIRED'), {
        type: 'app-update-required',
      });
      requestForcedAppUpdateFor(error, { minAppBuild: 786, admitted: false, returnCode: null });
      return error;
    }

    it('shows no creation error text when the forced update took it over, and keeps Retry', async () => {
      mocks.createSession.mockRejectedValueOnce(refusal(true));

      startHostFlow();

      await vi.waitFor(() => {
        expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.retry' });
      });
      expect(mocks.setupSetHostError).toHaveBeenLastCalledWith(null);
      expect(mocks.setupSetHostError).not.toHaveBeenCalledWith('error.session_create_fail');
    });

    it('hides the text by the pending query alone', async () => {
      setForcedAppUpdateHandler({ request: () => true, isPending: () => true });
      mocks.createSession.mockRejectedValueOnce(new Error('APP_UPDATE_REQUIRED'));

      startHostFlow();

      await vi.waitFor(() => {
        expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.retry' });
      });
      expect(mocks.setupSetHostError).not.toHaveBeenCalledWith('error.session_create_fail');
    });

    it('shows the ordinary creation error when the port declined (the loop guard)', async () => {
      mocks.createSession.mockRejectedValueOnce(refusal(false));

      startHostFlow();

      await vi.waitFor(() => {
        expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('error.session_create_fail');
      });
    });

    // Offline room guidance: the forced update stays first while offline too.
    describe('with no network', () => {
      beforeEach(() => setOnline(false));
      afterEach(() => {
        Reflect.deleteProperty(navigator, 'onLine');
      });

      it('shows no creation error text when the forced update took it over', async () => {
        mocks.createSession.mockRejectedValueOnce(refusal(true));

        startHostFlow();

        await vi.waitFor(() => {
          expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.retry' });
        });
        expect(mocks.setupSetHostError).toHaveBeenLastCalledWith(null);
        expect(mocks.setupSetHostError).not.toHaveBeenCalledWith('error.network_issue');
      });

      it('hides the text while the forced dialog is up, even for a failure with no answer', async () => {
        setForcedAppUpdateHandler({ request: () => true, isPending: () => true });
        mocks.createSession.mockRejectedValueOnce(bridgeErrorWithoutAnswer());

        startHostFlow();

        await vi.waitFor(() => {
          expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.retry' });
        });
        expect(mocks.setupSetHostError).toHaveBeenLastCalledWith(null);
        expect(mocks.setupSetHostError).not.toHaveBeenCalledWith('error.network_issue');
      });

      it('shows the ordinary creation error when the port declined', async () => {
        mocks.createSession.mockRejectedValueOnce(refusal(false));

        startHostFlow();

        await vi.waitFor(() => {
          expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('error.session_create_fail');
        });
      });
    });
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

  // Offline room guidance: when the browser reports no network at the moment
  // creation fails, and no server answered, the line names the network. The
  // buttons stay as they are, and nothing is checked before the attempt.
  describe('a device with no network', () => {
    beforeEach(() => setOnline(false));
    afterEach(() => {
      Reflect.deleteProperty(navigator, 'onLine');
    });

    it('names the network when every setup route failed without an answer, and keeps Retry', async () => {
      mocks.createSession
        .mockRejectedValueOnce(bridgeErrorWithoutAnswer())
        .mockResolvedValueOnce('482913');

      startHostFlow();

      await vi.waitFor(() => {
        expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('error.network_issue');
      });
      expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.retry' });

      const retry = mocks.actions[1]?.onClick as (() => void) | undefined;
      retry?.();

      await vi.waitFor(() => {
        expect(mocks.setupSetCode).toHaveBeenCalledWith('482913');
      });
      expect(mocks.createSession).toHaveBeenCalledTimes(2);
    });

    it.each([
      [
        'admission timeout on a network that hangs',
        () => Object.assign(new Error('SIGNALING_HOST_ADMISSION_TIMEOUT'), { type: 'network' }),
      ],
      ['peer-open deadline', () => new Error('PEER_OPEN_TIMEOUT')],
    ])('names the network for an offline %s', async (_label, failure) => {
      mocks.createSession.mockRejectedValueOnce(failure());

      startHostFlow();

      await vi.waitFor(() => {
        expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('error.network_issue');
      });
      expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.retry' });
    });

    it('says network, not update, for a room chunk that failed offline, and keeps Refresh', async () => {
      mocks.createSession.mockRejectedValueOnce(
        createLazyFeatureLoadError('room-session', chunkFailure()),
      );

      startHostFlow();

      await vi.waitFor(() => {
        expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('error.network_issue');
      });
      expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.refresh' });

      const refresh = mocks.actions[1]?.onClick as (() => void) | undefined;
      refresh?.();
      expect(mocks.createSession).toHaveBeenCalledOnce();
      expect(mocks.scheduleDocumentReload).toHaveBeenCalledWith('dialog.refreshing_session');
    });

    it('keeps the network line for a chunk that failed offline when Create meets it again after the network returns', async () => {
      // The room feature loader keeps its first failure for the document.
      const latched = createLazyFeatureLoadError('room-session', chunkFailure());
      setOnline(true);
      mocks.createSession.mockRejectedValueOnce(latched);

      startHostFlow();

      await vi.waitFor(() => {
        expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('error.network_issue');
      });
      expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.refresh' });
    });

    it('keeps the creation error for a server answer', async () => {
      mocks.createSession.mockRejectedValueOnce(
        Object.assign(new Error('SIGNALING_ERROR'), { type: 'server-error' }),
      );

      startHostFlow();

      await vi.waitFor(() => {
        expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('error.session_create_fail');
      });
      expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.retry' });
    });

    it('keeps the update line for a room chunk that failed while the browser reported a network', async () => {
      setOnline(true);
      const failedOnline = createLazyFeatureLoadError('room-session', chunkFailure());
      setOnline(false);
      mocks.createSession.mockRejectedValueOnce(failedOnline);

      startHostFlow();

      await vi.waitFor(() => {
        expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('dialog.sw_update_msg');
      });
      expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.refresh' });
    });

    it('keeps the creation error for the same failure while the browser reports a network', async () => {
      setOnline(true);
      mocks.createSession.mockRejectedValueOnce(bridgeErrorWithoutAnswer());

      startHostFlow();

      await vi.waitFor(() => {
        expect(mocks.setupSetHostError).toHaveBeenLastCalledWith('error.session_create_fail');
      });
      expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.retry' });
    });

    it('checks nothing before the attempt: a room created offline shows its code and no line', async () => {
      mocks.createSession.mockResolvedValueOnce('482913');

      startHostFlow();

      await vi.waitFor(() => {
        expect(mocks.setupSetCode).toHaveBeenCalledWith('482913');
      });
      expect(mocks.createSession).toHaveBeenCalledOnce();
      expect(mocks.setupSetHostError.mock.calls.every(([text]) => text === null)).toBe(true);
      expect(mocks.actions[1]).toMatchObject({ id: 'btn-setup-confirm', text: 'common.start' });
    });
  });
});

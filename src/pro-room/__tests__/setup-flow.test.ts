/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProRoomApiError } from '../api.ts';
import {
  __accountLoginReturnForTests,
  rememberAccountLoginReturn,
} from '../../account/login-return.ts';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  bootstrap: vi.fn(),
  getState: vi.fn(),
  join: vi.fn(),
  recoverOwner: vi.fn(),
  resume: vi.fn(),
  transferOwner: vi.fn(),
  loginPopup: vi.fn(),
  showDialog: vi.fn(),
  takeClaims: vi.fn(),
  announceTakeover: vi.fn(),
}));

vi.mock('../../core/state.ts', () => ({ getState: mocks.getState }));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: mocks.showDialog }));
vi.mock('../../account/session.ts', () => ({ requestAccountLoginPopup: mocks.loginPopup }));
vi.mock('../claim-fragment.ts', () => ({
  takeProRoomClaimsFromFragment: mocks.takeClaims,
}));
vi.mock('../tab-handoff.ts', () => ({
  announceProRoomTabTakeover: mocks.announceTakeover,
}));
vi.mock('../runtime.ts', () => ({
  activateProRoom: mocks.activate,
  getProRoomBootstrap: mocks.bootstrap,
  joinProRoom: mocks.join,
  recoverProRoomOwner: mocks.recoverOwner,
  resumeProRoom: mocks.resume,
  transferProRoomOwner: mocks.transferOwner,
}));

import { clearPendingSessionRequestIdsForTests, enterProRoomFromSetup } from '../setup-flow.ts';

const ROOM_CODE = '000001';
const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getState.mockReturnValue('Peer 1');
  mocks.takeClaims.mockReturnValue({
    activationClaimToken: null,
    activationClaimPresent: false,
    ownerRecoveryClaimToken: null,
    ownerRecoveryClaimPresent: false,
    ownerTransferClaimToken: null,
    ownerTransferClaimPresent: false,
  });
  mocks.resume.mockResolvedValue({});
  mocks.join.mockResolvedValue({});
  mocks.activate.mockResolvedValue({});
  mocks.recoverOwner.mockResolvedValue({});
  mocks.transferOwner.mockResolvedValue({});
  mocks.loginPopup.mockResolvedValue('authenticated');
  sessionStorage.clear();
  localStorage.clear();
  clearPendingSessionRequestIdsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PRO room setup flow', () => {
  it('resumes an active cookie session without opening a PIN dialog', async () => {
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.resume).toHaveBeenCalledWith(ROOM_CODE, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.showDialog).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it('aborts a stalled entry operation instead of leaving setup busy forever', async () => {
    vi.useFakeTimers();
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    const resumeSignal: { current: AbortSignal | null } = { current: null };
    mocks.resume.mockImplementation((_code: string, options: { signal?: AbortSignal } = {}) => {
      resumeSignal.current = options.signal ?? null;
      // Model a mobile request that never reports either success or failure
      // after the document returns from an OAuth window.
      return new Promise<never>(() => undefined);
    });

    const entering = enterProRoomFromSetup(ROOM_CODE);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.resume).toHaveBeenCalledOnce();
    const rejection = expect(entering).rejects.toMatchObject({
      code: 'PRO_ROOM_ENTRY_TIMEOUT',
      status: 408,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    expect(resumeSignal.current?.aborted).toBe(true);
  });

  it('routes active 000001 to the PIN prompt and normalizes grouped input', async () => {
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume.mockRejectedValue(new ProRoomApiError('SESSION_REQUIRED', 401));
    mocks.showDialog.mockResolvedValue({ action: 'ok', inputValue: '2002-0924' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.showDialog).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'pro.pin_title',
        message: 'pro.pin_message',
        inputField: expect.objectContaining({ autocomplete: 'current-password' }),
      }),
    );
    expect(mocks.showDialog).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'pro.activation_title' }),
    );
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.join).toHaveBeenCalledWith(
      {
        code: ROOM_CODE,
        pin: '20020924',
        requestId: expect.stringMatching(/^mxqr-pro-[a-f0-9]{48}$/u),
      },
      expect.any(AbortSignal),
    );
  });

  it('keeps the existing tab connected when takeover confirmation is cancelled', async () => {
    vi.useFakeTimers();
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume.mockRejectedValue(new ProRoomApiError('PRESENCE_ACTIVE_ELSEWHERE', 409));
    mocks.showDialog.mockResolvedValueOnce({ action: 'secondary' });

    const entering = enterProRoomFromSetup(ROOM_CODE);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.showDialog).not.toHaveBeenCalled();

    await vi.advanceTimersToNextTimerAsync();
    await expect(entering).resolves.toBe(false);

    expect(mocks.resume).toHaveBeenCalledTimes(2);
    expect(mocks.showDialog).toHaveBeenCalledWith({
      title: 'pro.active_tab_title',
      message: 'pro.active_tab_message',
      buttonText: 'pro.use_this_tab',
      secondaryText: 'common.cancel',
      dismissible: false,
      defaultFocus: 'secondary',
    });
    expect(mocks.announceTakeover).not.toHaveBeenCalled();
  });

  it('silently resumes when a reload close settles during the active-tab grace window', async () => {
    vi.useFakeTimers();
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume
      .mockRejectedValueOnce(new ProRoomApiError('PRESENCE_ACTIVE_ELSEWHERE', 409))
      .mockResolvedValueOnce({});

    const entering = enterProRoomFromSetup(ROOM_CODE);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.showDialog).not.toHaveBeenCalled();

    await vi.advanceTimersToNextTimerAsync();
    await expect(entering).resolves.toBe(true);

    expect(mocks.resume).toHaveBeenCalledTimes(2);
    expect(mocks.resume).toHaveBeenNthCalledWith(2, ROOM_CODE, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.showDialog).not.toHaveBeenCalled();
    expect(mocks.announceTakeover).not.toHaveBeenCalled();
  });

  it('moves the room to this tab only after explicit confirmation', async () => {
    vi.useFakeTimers();
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume
      .mockRejectedValueOnce(new ProRoomApiError('PRESENCE_ACTIVE_ELSEWHERE', 409))
      .mockRejectedValueOnce(new ProRoomApiError('PRESENCE_ACTIVE_ELSEWHERE', 409))
      .mockResolvedValueOnce({});
    mocks.showDialog.mockResolvedValueOnce({ action: 'ok' });

    const entering = enterProRoomFromSetup(ROOM_CODE);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersToNextTimerAsync();
    await expect(entering).resolves.toBe(true);

    expect(mocks.resume).toHaveBeenNthCalledWith(1, ROOM_CODE, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.resume).toHaveBeenNthCalledWith(2, ROOM_CODE, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.resume).toHaveBeenNthCalledWith(3, ROOM_CODE, {
      takeover: true,
      signal: expect.any(AbortSignal),
    });
    expect(mocks.announceTakeover).toHaveBeenCalledWith(ROOM_CODE);
  });

  it('silently reclaims this tab after a same-tab PWA login return', async () => {
    rememberAccountLoginReturn('/000001', ROOM_CODE, { allowSilentTakeover: true });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume
      .mockRejectedValueOnce(new ProRoomApiError('PRESENCE_ACTIVE_ELSEWHERE', 409))
      .mockResolvedValueOnce({});

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.resume).toHaveBeenNthCalledWith(1, ROOM_CODE, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.resume).toHaveBeenNthCalledWith(2, ROOM_CODE, {
      takeover: true,
      signal: expect.any(AbortSignal),
    });
    expect(mocks.showDialog).not.toHaveBeenCalled();
    expect(mocks.announceTakeover).toHaveBeenCalledWith(ROOM_CODE);
    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
  });

  it('does not reclaim from a same-context route hint created before presence existed', async () => {
    vi.useFakeTimers();
    rememberAccountLoginReturn('/000001', ROOM_CODE);
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume.mockRejectedValue(new ProRoomApiError('PRESENCE_ACTIVE_ELSEWHERE', 409));
    mocks.showDialog.mockResolvedValueOnce({ action: 'secondary' });

    const entering = enterProRoomFromSetup(ROOM_CODE);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersToNextTimerAsync();
    await expect(entering).resolves.toBe(false);

    expect(mocks.resume).toHaveBeenCalledTimes(2);
    expect(mocks.showDialog).toHaveBeenCalledOnce();
    expect(mocks.announceTakeover).not.toHaveBeenCalled();
  });

  it('normally resumes a closed PWA from its durable route hint', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    rememberAccountLoginReturn('/000001?panel=connect', ROOM_CODE);
    sessionStorage.clear();
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.resume).toHaveBeenCalledWith(ROOM_CODE, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.showDialog).not.toHaveBeenCalled();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
  });

  it('never silently takes over an active tab from a durable PWA relaunch hint', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    rememberAccountLoginReturn('/000001', ROOM_CODE);
    sessionStorage.clear();
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume.mockRejectedValue(new ProRoomApiError('PRESENCE_ACTIVE_ELSEWHERE', 409));
    mocks.showDialog.mockResolvedValueOnce({ action: 'secondary' });

    const entering = enterProRoomFromSetup(ROOM_CODE);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersToNextTimerAsync();
    await expect(entering).resolves.toBe(false);

    expect(mocks.resume).toHaveBeenCalledTimes(2);
    expect(mocks.showDialog).toHaveBeenCalledWith({
      title: 'pro.active_tab_title',
      message: 'pro.active_tab_message',
      buttonText: 'pro.use_this_tab',
      secondaryText: 'common.cancel',
      dismissible: false,
      defaultFocus: 'secondary',
    });
    expect(mocks.announceTakeover).not.toHaveBeenCalled();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
  });

  it('re-prompts after an invalid PIN and never retries unrelated failures', async () => {
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume.mockRejectedValue(new ProRoomApiError('SESSION_REQUIRED', 401));
    mocks.showDialog
      .mockResolvedValueOnce({ action: 'ok', inputValue: '11111111' })
      .mockResolvedValueOnce({ action: 'ok', inputValue: '22222222' });
    mocks.join
      .mockRejectedValueOnce(new ProRoomApiError('PIN_INVALID', 401))
      .mockResolvedValueOnce({});

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.showDialog).toHaveBeenCalledTimes(2);
    expect(mocks.showDialog.mock.calls[1]?.[0]).toMatchObject({
      message: 'pro.pin_retry_message',
    });
    expect(mocks.join).toHaveBeenLastCalledWith(
      expect.objectContaining({ pin: '22222222' }),
      expect.any(AbortSignal),
    );
    expect(mocks.join.mock.calls[0]?.[0].requestId).not.toBe(
      mocks.join.mock.calls[1]?.[0].requestId,
    );
  });

  it('reuses the tab-scoped admission id after an uncertain response and clears it on success', async () => {
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume.mockRejectedValue(new ProRoomApiError('SESSION_REQUIRED', 401));
    mocks.showDialog.mockResolvedValue({ action: 'ok', inputValue: '12345678' });
    mocks.join
      .mockRejectedValueOnce(new ProRoomApiError('PRO_ROOM_API_UNAVAILABLE', 502))
      .mockResolvedValueOnce({});

    await expect(enterProRoomFromSetup(ROOM_CODE)).rejects.toMatchObject({
      code: 'PRO_ROOM_API_UNAVAILABLE',
      status: 502,
    });
    const retainedRequestId = mocks.join.mock.calls[0]?.[0].requestId;
    expect(retainedRequestId).toMatch(/^mxqr-pro-[a-f0-9]{48}$/u);
    expect(sessionStorage.getItem(`mxqr-pro-session-request:${ROOM_CODE}`)).toBe(retainedRequestId);

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);
    expect(mocks.join.mock.calls[1]?.[0].requestId).toBe(retainedRequestId);
    expect(sessionStorage.getItem(`mxqr-pro-session-request:${ROOM_CODE}`)).toBeNull();
  });

  it('clears an outcome-unknown admission id when its cookie session resumes', async () => {
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume.mockRejectedValueOnce(new ProRoomApiError('SESSION_REQUIRED', 401));
    mocks.showDialog.mockResolvedValue({ action: 'ok', inputValue: '12345678' });
    mocks.join.mockRejectedValueOnce(new ProRoomApiError('PRO_ROOM_API_UNAVAILABLE', 502));

    await expect(enterProRoomFromSetup(ROOM_CODE)).rejects.toMatchObject({ status: 502 });
    const retainedRequestId = sessionStorage.getItem(`mxqr-pro-session-request:${ROOM_CODE}`);
    expect(retainedRequestId).toMatch(/^mxqr-pro-[a-f0-9]{48}$/u);

    mocks.resume.mockResolvedValueOnce({});
    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.join).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(`mxqr-pro-session-request:${ROOM_CODE}`)).toBeNull();
  });

  it('keeps the same pending admission id when sessionStorage is denied', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume.mockRejectedValue(new ProRoomApiError('SESSION_REQUIRED', 401));
    mocks.showDialog.mockResolvedValue({ action: 'ok', inputValue: '12345678' });
    mocks.join
      .mockRejectedValueOnce(new ProRoomApiError('PRO_ROOM_API_UNAVAILABLE', 502))
      .mockResolvedValueOnce({});

    await expect(enterProRoomFromSetup(ROOM_CODE)).rejects.toMatchObject({ status: 502 });
    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);
    expect(mocks.join.mock.calls[1]?.[0].requestId).toBe(mocks.join.mock.calls[0]?.[0].requestId);
  });

  it('rotates the pending admission id after a definitive replay fence', async () => {
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume.mockRejectedValue(new ProRoomApiError('SESSION_REQUIRED', 401));
    mocks.showDialog.mockResolvedValue({ action: 'ok', inputValue: '12345678' });
    mocks.join
      .mockRejectedValueOnce(new ProRoomApiError('SESSION_REPLAY_UNAVAILABLE', 409))
      .mockResolvedValueOnce({});

    await expect(enterProRoomFromSetup(ROOM_CODE)).rejects.toMatchObject({
      code: 'SESSION_REPLAY_UNAVAILABLE',
      status: 409,
    });
    const fencedRequestId = mocks.join.mock.calls[0]?.[0].requestId;
    expect(sessionStorage.getItem(`mxqr-pro-session-request:${ROOM_CODE}`)).toBeNull();

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);
    expect(mocks.join.mock.calls[1]?.[0].requestId).not.toBe(fencedRequestId);
  });

  it('activates a claimed room with its derived temporary PIN and chosen owner PIN', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: CLAIM,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
    });
    mocks.bootstrap.mockResolvedValue({
      roomCode: ROOM_CODE,
      status: 'activation_required',
    });
    mocks.showDialog.mockResolvedValue({ action: 'ok', inputValue: '87654321' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.activate).toHaveBeenCalledWith(
      {
        code: ROOM_CODE,
        claimToken: CLAIM,
        temporaryPin: '00000001',
        newPin: '87654321',
        ownerName: 'Peer 1',
      },
      expect.any(AbortSignal),
    );
  });

  it('keeps an activation claim in memory across popup login and retries it after profile completion', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: CLAIM,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'activation_required' });
    mocks.activate
      .mockRejectedValueOnce(new ProRoomApiError('ACCOUNT_SESSION_REQUIRED', 401))
      .mockResolvedValueOnce({});
    mocks.showDialog.mockImplementation(
      async (options: { title?: string; onPrimaryActivation?: () => void }) => {
        if (options.title === 'pro.activation_title') {
          return { action: 'ok', inputValue: '87654321' };
        }
        if (options.title === 'pro.claim_login_title') {
          options.onPrimaryActivation?.();
          return { action: 'ok' };
        }
        return { action: 'ok' };
      },
    );

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.takeClaims).toHaveBeenCalledOnce();
    expect(mocks.loginPopup).toHaveBeenCalledOnce();
    expect(mocks.activate).toHaveBeenCalledTimes(2);
    expect(mocks.activate.mock.calls.map(([input]) => input.claimToken)).toEqual([CLAIM, CLAIM]);
    expect(JSON.stringify(sessionStorage)).not.toContain(CLAIM);
    expect(JSON.stringify(localStorage)).not.toContain(CLAIM);
  });

  it('explains the one-PRO-room account limit without replaying the activation claim', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: CLAIM,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'activation_required' });
    mocks.activate.mockRejectedValue(new ProRoomApiError('ACCOUNT_PRO_ROOM_LIMIT_REACHED', 409));
    mocks.showDialog
      .mockResolvedValueOnce({ action: 'ok', inputValue: '87654321' })
      .mockResolvedValueOnce({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.activate).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenLastCalledWith({
      title: 'pro.claim_account_capacity_title',
      message: 'pro.claim_account_capacity_message',
      buttonText: 'common.ok',
    });
  });

  it('retains the claim after a blocked popup and allows an in-place login retry', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: CLAIM,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'activation_required' });
    mocks.activate
      .mockRejectedValueOnce(new ProRoomApiError('ACCOUNT_SESSION_REQUIRED', 401))
      .mockResolvedValueOnce({});
    mocks.loginPopup.mockResolvedValueOnce('blocked').mockResolvedValueOnce('authenticated');
    mocks.showDialog.mockImplementation(
      async (options: { title?: string; onPrimaryActivation?: () => void }) => {
        if (options.title === 'pro.activation_title') {
          return { action: 'ok', inputValue: '87654321' };
        }
        if (options.title === 'pro.claim_login_title') {
          options.onPrimaryActivation?.();
          return { action: 'ok' };
        }
        return { action: 'ok' };
      },
    );

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.loginPopup).toHaveBeenCalledTimes(2);
    const loginDialogs = mocks.showDialog.mock.calls
      .map(([options]) => options)
      .filter((options) => options.title === 'pro.claim_login_title');
    expect(loginDialogs.map((options) => options.message)).toEqual([
      'pro.claim_login_message',
      'pro.claim_popup_blocked_message',
    ]);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it('keeps unclaimed 000000 at activation guidance without opening a PIN prompt', async () => {
    const unclaimedRoomCode = '000000';
    mocks.bootstrap.mockResolvedValue({
      roomCode: unclaimedRoomCode,
      status: 'activation_required',
    });
    mocks.showDialog.mockResolvedValue({ action: 'ok' });

    await expect(enterProRoomFromSetup(unclaimedRoomCode)).resolves.toBe(false);

    expect(mocks.showDialog).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenCalledWith({
      title: 'pro.not_ready_title',
      message: 'pro.not_ready_message',
      buttonText: 'common.ok',
    });
    expect(mocks.showDialog.mock.calls[0]?.[0]).not.toHaveProperty('inputField');
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it('treats an activation claim for an already-active room as a terminal used link', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: CLAIM,
      activationClaimPresent: true,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.showDialog.mockResolvedValue({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.showDialog).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenCalledWith({
      title: 'pro.claim_unavailable_title',
      message: 'pro.new_link_message',
      buttonText: 'common.ok',
    });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'malformed activation',
      claims: {
        activationClaimToken: null,
        activationClaimPresent: true,
        ownerRecoveryClaimToken: null,
        ownerRecoveryClaimPresent: false,
        ownerTransferClaimToken: null,
        ownerTransferClaimPresent: false,
      },
    },
    {
      name: 'malformed recovery',
      claims: {
        activationClaimToken: null,
        activationClaimPresent: false,
        ownerRecoveryClaimToken: null,
        ownerRecoveryClaimPresent: true,
        ownerTransferClaimToken: null,
        ownerTransferClaimPresent: false,
      },
    },
    {
      name: 'malformed transfer',
      claims: {
        activationClaimToken: null,
        activationClaimPresent: false,
        ownerRecoveryClaimToken: null,
        ownerRecoveryClaimPresent: false,
        ownerTransferClaimToken: null,
        ownerTransferClaimPresent: true,
      },
    },
    {
      name: 'mixed purposes',
      claims: {
        activationClaimToken: CLAIM,
        activationClaimPresent: true,
        ownerRecoveryClaimToken: CLAIM,
        ownerRecoveryClaimPresent: true,
        ownerTransferClaimToken: null,
        ownerTransferClaimPresent: false,
      },
    },
  ])('rejects $name locally before bootstrap can fail', async ({ claims }) => {
    mocks.takeClaims.mockReturnValue(claims);
    mocks.bootstrap.mockRejectedValue(new ProRoomApiError('HTTP_503', 503));
    mocks.showDialog.mockResolvedValue({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.recoverOwner).not.toHaveBeenCalled();
    expect(mocks.transferOwner).not.toHaveBeenCalled();
    expect(mocks.showDialog).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenCalledWith({
      title: 'pro.claim_unavailable_title',
      message: 'pro.new_link_message',
      buttonText: 'common.ok',
    });
  });

  it('recovers an active owner before cookie resume or the normal PIN flow', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      ownerRecoveryClaimToken: CLAIM,
      ownerRecoveryClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.recoverOwner).toHaveBeenCalledWith(
      {
        code: ROOM_CODE,
        claimToken: CLAIM,
      },
      expect.any(AbortSignal),
    );
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
    expect(mocks.showDialog).not.toHaveBeenCalled();
    expect(mocks.takeClaims.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
      mocks.bootstrap.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('rejects a recycled recovery claim before generic suspended-room guidance', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      activationClaimPresent: false,
      ownerRecoveryClaimToken: CLAIM,
      ownerRecoveryClaimPresent: true,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'suspended' });
    mocks.showDialog.mockResolvedValue({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.recoverOwner).not.toHaveBeenCalled();
    expect(mocks.showDialog).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenCalledWith({
      title: 'pro.claim_unavailable_title',
      message: 'pro.new_link_message',
      buttonText: 'common.ok',
    });
    expect(mocks.showDialog).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'pro.suspended_title' }),
    );
  });

  it('continues the same recovery claim after login without probing a stale owner cookie', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      activationClaimPresent: false,
      ownerRecoveryClaimToken: CLAIM,
      ownerRecoveryClaimPresent: true,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.recoverOwner
      .mockRejectedValueOnce(new ProRoomApiError('ACCOUNT_SESSION_REQUIRED', 401))
      .mockResolvedValueOnce({});
    mocks.showDialog.mockImplementation(
      async (options: { title?: string; onPrimaryActivation?: () => void }) => {
        if (options.title === 'pro.claim_existing_account_title') {
          options.onPrimaryActivation?.();
          return { action: 'ok' };
        }
        return { action: 'ok' };
      },
    );

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.loginPopup).toHaveBeenCalledOnce();
    expect(mocks.recoverOwner).toHaveBeenCalledTimes(2);
    expect(mocks.recoverOwner.mock.calls.map(([input]) => input.claimToken)).toEqual([
      CLAIM,
      CLAIM,
    ]);
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it('does not create a nickname for an incomplete recovery identity and keeps the claim for account switching', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      activationClaimPresent: false,
      ownerRecoveryClaimToken: CLAIM,
      ownerRecoveryClaimPresent: true,
      ownerTransferClaimToken: null,
      ownerTransferClaimPresent: false,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.recoverOwner
      .mockRejectedValueOnce(new ProRoomApiError('ACCOUNT_SESSION_REQUIRED', 401))
      .mockResolvedValueOnce({});
    mocks.loginPopup
      .mockResolvedValueOnce('profile-incomplete')
      .mockResolvedValueOnce('authenticated');
    mocks.showDialog.mockImplementation(
      async (options: { title?: string; onPrimaryActivation?: () => void }) => {
        if (options.title === 'pro.claim_existing_account_title') {
          options.onPrimaryActivation?.();
          return { action: 'ok' };
        }
        return { action: 'ok' };
      },
    );

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.loginPopup).toHaveBeenNthCalledWith(1, {
      acceptIncompleteProfile: true,
      forceGoogleAccountChooser: false,
    });
    expect(mocks.loginPopup).toHaveBeenNthCalledWith(2, {
      acceptIncompleteProfile: true,
      forceGoogleAccountChooser: true,
    });
    expect(mocks.recoverOwner).toHaveBeenCalledTimes(2);
    expect(mocks.recoverOwner.mock.calls.map(([input]) => input.claimToken)).toEqual([
      CLAIM,
      CLAIM,
    ]);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it('continues the same transfer claim after login', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      activationClaimPresent: false,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: CLAIM,
      ownerTransferClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'suspended' });
    mocks.transferOwner
      .mockRejectedValueOnce(new ProRoomApiError('ACCOUNT_SESSION_REQUIRED', 401))
      .mockResolvedValueOnce({});
    mocks.showDialog.mockImplementation(
      async (options: { title?: string; onPrimaryActivation?: () => void }) => {
        if (options.title === 'pro.transfer_title') {
          return { action: 'ok', inputValue: '87654321' };
        }
        if (options.title === 'pro.claim_existing_account_title') {
          options.onPrimaryActivation?.();
          return { action: 'ok' };
        }
        return { action: 'ok' };
      },
    );

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.loginPopup).toHaveBeenCalledOnce();
    expect(mocks.transferOwner).toHaveBeenCalledTimes(2);
    const inputs = mocks.transferOwner.mock.calls.map(([input]) => input);
    expect(inputs.map((input) => input.claimToken)).toEqual([CLAIM, CLAIM]);
    expect(inputs[1]?.requestId).toBe(inputs[0]?.requestId);
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it('keeps a transfer claim in memory while an incomplete account chooses the linked Google account', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      activationClaimPresent: false,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: CLAIM,
      ownerTransferClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'suspended' });
    mocks.transferOwner
      .mockRejectedValueOnce(new ProRoomApiError('ACCOUNT_SESSION_REQUIRED', 401))
      .mockResolvedValueOnce({});
    mocks.loginPopup
      .mockResolvedValueOnce('profile-incomplete')
      .mockResolvedValueOnce('authenticated');
    mocks.showDialog.mockImplementation(
      async (options: { title?: string; onPrimaryActivation?: () => void }) => {
        if (options.title === 'pro.transfer_title') {
          return { action: 'ok', inputValue: '87654321' };
        }
        if (options.title === 'pro.claim_existing_account_title') {
          options.onPrimaryActivation?.();
          return { action: 'ok' };
        }
        return { action: 'ok' };
      },
    );

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.loginPopup).toHaveBeenNthCalledWith(1, {
      acceptIncompleteProfile: true,
      forceGoogleAccountChooser: false,
    });
    expect(mocks.loginPopup).toHaveBeenNthCalledWith(2, {
      acceptIncompleteProfile: true,
      forceGoogleAccountChooser: true,
    });
    expect(mocks.showDialog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        title: 'pro.claim_existing_account_title',
        message: 'pro.claim_existing_account_message',
        buttonText: 'pro.claim_login_button',
        secondaryText: 'common.cancel',
      }),
    );
    expect(mocks.showDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'pro.claim_existing_account_title',
        message: 'pro.claim_existing_account_message',
        buttonText: 'pro.claim_choose_account_button',
        secondaryText: 'common.cancel',
      }),
    );
    expect(mocks.transferOwner).toHaveBeenCalledTimes(2);
    expect(mocks.transferOwner.mock.calls.map(([input]) => input.claimToken)).toEqual([
      CLAIM,
      CLAIM,
    ]);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it('cancels an incomplete-account transfer without opening generic login guidance or replaying the claim', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      activationClaimPresent: false,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: CLAIM,
      ownerTransferClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'suspended' });
    mocks.transferOwner.mockRejectedValue(new ProRoomApiError('ACCOUNT_SESSION_REQUIRED', 401));
    mocks.loginPopup.mockResolvedValueOnce('profile-incomplete');
    mocks.showDialog.mockImplementation(
      async (options: { title?: string; onPrimaryActivation?: () => void }) => {
        if (options.title === 'pro.transfer_title') {
          return { action: 'ok', inputValue: '87654321' };
        }
        if (options.title === 'pro.claim_existing_account_title') {
          if (mocks.loginPopup.mock.calls.length === 0) {
            options.onPrimaryActivation?.();
            return { action: 'ok' };
          }
          return { action: 'secondary' };
        }
        return { action: 'ok' };
      },
    );

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.loginPopup).toHaveBeenCalledOnce();
    expect(mocks.transferOwner).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'pro.claim_existing_account_title' }),
    );
    expect(mocks.showDialog).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'account.login_cancelled' }),
    );
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it('transfers ownership with a new PIN and one memory-only request id across retries', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: CLAIM,
      ownerTransferClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.transferOwner
      .mockRejectedValueOnce(new ProRoomApiError('HTTP_503', 503))
      .mockResolvedValueOnce({});
    mocks.resume.mockRejectedValue(new ProRoomApiError('SESSION_REQUIRED', 401));
    mocks.showDialog
      .mockResolvedValueOnce({ action: 'ok', inputValue: '8765-4321' })
      .mockResolvedValueOnce({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.transferOwner).toHaveBeenCalledTimes(2);
    const inputs = mocks.transferOwner.mock.calls.map(([input]) => input);
    expect(inputs.map((input) => input.claimToken)).toEqual([CLAIM, CLAIM]);
    expect(inputs.map((input) => input.newPin)).toEqual(['87654321', '87654321']);
    expect(inputs[0]?.requestId).toMatch(/^mxqr-pro-[a-f0-9]{48}$/);
    expect(inputs[1]?.requestId).toBe(inputs[0]?.requestId);
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.takeClaims).toHaveBeenCalledOnce();
    expect(JSON.stringify(sessionStorage)).not.toContain(CLAIM);
    expect(JSON.stringify(localStorage)).not.toContain(CLAIM);
  });

  it('shows one account-conflict confirmation for a transfer target mismatch', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: CLAIM,
      ownerTransferClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.transferOwner.mockRejectedValue(
      new ProRoomApiError('OWNER_TRANSFER_TARGET_ACCOUNT_MISMATCH', 409),
    );
    mocks.showDialog
      .mockResolvedValueOnce({ action: 'ok', inputValue: '87654321' })
      .mockResolvedValueOnce({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.transferOwner).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenLastCalledWith({
      title: 'pro.claim_account_conflict_title',
      message: 'pro.claim_account_conflict_message',
      buttonText: 'common.ok',
    });
  });

  it('does not retry a transfer link rejected by an unknown 4xx or rate limit', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: CLAIM,
      ownerTransferClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.transferOwner.mockRejectedValue(new ProRoomApiError('RATE_LIMITED', 429));
    mocks.showDialog
      .mockResolvedValueOnce({ action: 'ok', inputValue: '87654321' })
      .mockResolvedValueOnce({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.transferOwner).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenLastCalledWith({
      title: 'pro.claim_failed_title',
      message: 'pro.claim_failed_message',
      buttonText: 'common.ok',
    });
  });

  it.each(['OWNER_TRANSFER_CLAIM_EXPIRED', 'OWNER_TRANSFER_CLAIM_USED'])(
    'treats %s as terminal without retrying it',
    async (errorCode) => {
      mocks.takeClaims.mockReturnValue({
        activationClaimToken: null,
        ownerRecoveryClaimToken: null,
        ownerRecoveryClaimPresent: false,
        ownerTransferClaimToken: CLAIM,
        ownerTransferClaimPresent: true,
      });
      mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
      mocks.transferOwner.mockRejectedValue(new ProRoomApiError(errorCode, 409));
      mocks.showDialog
        .mockResolvedValueOnce({ action: 'ok', inputValue: '87654321' })
        .mockResolvedValueOnce({ action: 'ok' });

      await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

      expect(mocks.transferOwner).toHaveBeenCalledOnce();
      expect(mocks.showDialog).toHaveBeenLastCalledWith({
        title: 'pro.claim_unavailable_title',
        message: 'pro.new_link_message',
        buttonText: 'common.ok',
      });
    },
  );

  it.each([
    ['PRO_ROOM_NOT_FOUND', 404],
    ['PRO_ROOM_DECOMMISSIONED', 410],
  ])(
    'treats claim HTTP %i responses as unavailable without retrying',
    async (errorCode, status) => {
      mocks.takeClaims.mockReturnValue({
        activationClaimToken: null,
        ownerRecoveryClaimToken: null,
        ownerRecoveryClaimPresent: false,
        ownerTransferClaimToken: CLAIM,
        ownerTransferClaimPresent: true,
      });
      mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
      mocks.transferOwner.mockRejectedValue(new ProRoomApiError(errorCode, status));
      mocks.showDialog
        .mockResolvedValueOnce({ action: 'ok', inputValue: '87654321' })
        .mockResolvedValueOnce({ action: 'ok' });

      await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

      expect(mocks.transferOwner).toHaveBeenCalledOnce();
      expect(mocks.showDialog).toHaveBeenLastCalledWith({
        title: 'pro.claim_unavailable_title',
        message: 'pro.new_link_message',
        buttonText: 'common.ok',
      });
    },
  );

  it('discards a used owner recovery claim and directs the user to a new link', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      ownerRecoveryClaimToken: CLAIM,
      ownerRecoveryClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.recoverOwner.mockRejectedValue(new ProRoomApiError('RECOVERY_CLAIM_USED', 409));
    mocks.showDialog.mockResolvedValue({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.showDialog).toHaveBeenCalledWith({
      title: 'pro.claim_unavailable_title',
      message: 'pro.new_link_message',
      buttonText: 'common.ok',
    });
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it('does not retry a recovery claim when the room recovery ledger is full', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      ownerRecoveryClaimToken: CLAIM,
      ownerRecoveryClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.recoverOwner.mockRejectedValue(new ProRoomApiError('RECOVERY_CAPACITY_EXCEEDED', 409));
    mocks.showDialog.mockResolvedValue({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.recoverOwner).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenCalledWith({
      title: 'pro.claim_unavailable_title',
      message: 'pro.new_link_message',
      buttonText: 'common.ok',
    });
  });

  it('scrubs and rejects a malformed recovery fragment as the same generic failure', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.showDialog.mockResolvedValue({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.recoverOwner).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
    expect(mocks.showDialog).toHaveBeenCalledWith({
      title: 'pro.claim_unavailable_title',
      message: 'pro.new_link_message',
      buttonText: 'common.ok',
    });
  });

  it('retains an activation claim in memory across a transient retry only', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: CLAIM,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
    });
    mocks.bootstrap.mockResolvedValue({
      roomCode: ROOM_CODE,
      status: 'activation_required',
    });
    mocks.showDialog
      .mockResolvedValueOnce({ action: 'ok', inputValue: '87654321' })
      .mockResolvedValueOnce({ action: 'ok' });
    mocks.activate
      .mockRejectedValueOnce(new ProRoomApiError('HTTP_503', 503))
      .mockResolvedValueOnce({});

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.takeClaims).toHaveBeenCalledOnce();
    expect(mocks.activate).toHaveBeenCalledTimes(2);
    expect(mocks.activate.mock.calls.map(([input]) => input.claimToken)).toEqual([CLAIM, CLAIM]);
    expect(mocks.showDialog.mock.calls[1]?.[0]).toMatchObject({
      title: 'pro.claim_retry_title',
      message: 'pro.claim_retry_message',
      buttonText: 'common.retry',
      secondaryText: 'common.close',
      dismissible: false,
    });
    expect(JSON.stringify(sessionStorage)).not.toContain(CLAIM);
    expect(JSON.stringify(localStorage)).not.toContain(CLAIM);
  });

  it('retains a scrubbed claim when the initial bootstrap request must be retried', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: CLAIM,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
    });
    mocks.bootstrap
      .mockRejectedValueOnce(new ProRoomApiError('HTTP_503', 503))
      .mockResolvedValueOnce({ roomCode: ROOM_CODE, status: 'activation_required' });
    mocks.showDialog
      .mockResolvedValueOnce({ action: 'ok' })
      .mockResolvedValueOnce({ action: 'ok', inputValue: '87654321' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.takeClaims).toHaveBeenCalledOnce();
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);
    expect(mocks.activate).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: CLAIM }),
      expect.any(AbortSignal),
    );
  });

  it('recovers an uncertain activation success through its cookie before replaying the claim', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: CLAIM,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
    });
    mocks.bootstrap
      .mockResolvedValueOnce({ roomCode: ROOM_CODE, status: 'activation_required' })
      .mockResolvedValueOnce({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.showDialog
      .mockResolvedValueOnce({ action: 'ok', inputValue: '87654321' })
      .mockResolvedValueOnce({ action: 'ok' });
    mocks.activate.mockRejectedValueOnce(new ProRoomApiError('PRO_ROOM_ENTRY_TIMEOUT', 408));
    mocks.resume.mockResolvedValueOnce({});

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.activate).toHaveBeenCalledOnce();
    expect(mocks.resume).toHaveBeenCalledWith(ROOM_CODE, {
      signal: expect.any(AbortSignal),
    });
  });

  it('retains a recovery claim across a transient failure and explicit retry', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      ownerRecoveryClaimToken: CLAIM,
      ownerRecoveryClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.recoverOwner
      .mockRejectedValueOnce(new ProRoomApiError('HTTP_503', 503))
      .mockResolvedValueOnce({});
    mocks.resume.mockRejectedValue(new ProRoomApiError('SESSION_REQUIRED', 401));
    mocks.showDialog.mockResolvedValueOnce({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.recoverOwner).toHaveBeenCalledTimes(2);
    expect(mocks.recoverOwner.mock.calls.map(([input]) => input.claimToken)).toEqual([
      CLAIM,
      CLAIM,
    ]);
  });

  it('closes a transient retry prompt without adding terminal-link guidance', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: CLAIM,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
    });
    mocks.bootstrap.mockResolvedValue({
      roomCode: ROOM_CODE,
      status: 'activation_required',
    });
    mocks.showDialog
      .mockResolvedValueOnce({ action: 'ok', inputValue: '87654321' })
      .mockResolvedValueOnce({ action: 'secondary' });
    mocks.activate.mockRejectedValueOnce(new ProRoomApiError('HTTP_503', 503));

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.activate).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenCalledTimes(2);
    expect(mocks.showDialog.mock.calls[1]?.[0]).toMatchObject({
      title: 'pro.claim_retry_title',
      secondaryText: 'common.close',
    });
    expect(JSON.stringify(sessionStorage)).not.toContain(CLAIM);
    expect(JSON.stringify(localStorage)).not.toContain(CLAIM);
  });

  it('does not connect a suspended room', async () => {
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'suspended' });
    mocks.showDialog.mockResolvedValue({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it('allows a valid transfer claim to recover a suspended room', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      ownerRecoveryClaimToken: null,
      ownerRecoveryClaimPresent: false,
      ownerTransferClaimToken: CLAIM,
      ownerTransferClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'suspended' });
    mocks.showDialog.mockResolvedValueOnce({ action: 'ok', inputValue: '87654321' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.transferOwner).toHaveBeenCalledOnce();
    expect(mocks.showDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'pro.transfer_title' }),
    );
    expect(mocks.showDialog).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'pro.suspended_title' }),
    );
  });

  it('rejects a transfer URL that also carries another ownership claim', async () => {
    mocks.takeClaims.mockReturnValue({
      activationClaimToken: null,
      ownerRecoveryClaimToken: CLAIM,
      ownerRecoveryClaimPresent: true,
      ownerTransferClaimToken: CLAIM,
      ownerTransferClaimPresent: true,
    });
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'suspended' });
    mocks.showDialog.mockResolvedValueOnce({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.transferOwner).not.toHaveBeenCalled();
    expect(mocks.recoverOwner).not.toHaveBeenCalled();
    expect(mocks.showDialog).toHaveBeenCalledWith({
      title: 'pro.claim_unavailable_title',
      message: 'pro.new_link_message',
      buttonText: 'common.ok',
    });
  });
});

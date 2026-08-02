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
  showDialog: vi.fn(),
  takeClaims: vi.fn(),
  announceTakeover: vi.fn(),
}));

vi.mock('../../core/state.ts', () => ({ getState: mocks.getState }));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: mocks.showDialog }));
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
}));

import { enterProRoomFromSetup } from '../setup-flow.ts';

const ROOM_CODE = '000001';
const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getState.mockReturnValue('Peer 1');
  mocks.takeClaims.mockReturnValue({
    activationClaimToken: null,
    ownerRecoveryClaimToken: null,
    ownerRecoveryClaimPresent: false,
  });
  mocks.resume.mockResolvedValue({});
  mocks.join.mockResolvedValue({});
  mocks.activate.mockResolvedValue({});
  mocks.recoverOwner.mockResolvedValue({});
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
      secondaryText: 'pro.request_new_link',
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

  it('offers a new-link path without persisting a transient activation claim', async () => {
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
      .mockResolvedValueOnce({ action: 'secondary' })
      .mockResolvedValueOnce({ action: 'ok' });
    mocks.activate.mockRejectedValueOnce(new ProRoomApiError('HTTP_503', 503));

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);

    expect(mocks.activate).toHaveBeenCalledOnce();
    expect(mocks.showDialog.mock.calls[2]?.[0]).toEqual({
      title: 'pro.claim_unavailable_title',
      message: 'pro.new_link_message',
      buttonText: 'common.ok',
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
});

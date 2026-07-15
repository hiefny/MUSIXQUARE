/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProRoomApiError } from '../api.ts';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  bootstrap: vi.fn(),
  getState: vi.fn(),
  join: vi.fn(),
  recoverOwner: vi.fn(),
  resume: vi.fn(),
  showDialog: vi.fn(),
  takeClaims: vi.fn(),
}));

vi.mock('../../core/state.ts', () => ({ getState: mocks.getState }));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: mocks.showDialog }));
vi.mock('../claim-fragment.ts', () => ({
  takeProRoomClaimsFromFragment: mocks.takeClaims,
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
});

describe('PRO room setup flow', () => {
  it('resumes an active cookie session without opening a PIN dialog', async () => {
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.resume).toHaveBeenCalledWith(ROOM_CODE);
    expect(mocks.showDialog).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it('falls back to an eight-digit PIN only when the cookie session is missing', async () => {
    mocks.bootstrap.mockResolvedValue({ roomCode: ROOM_CODE, status: 'pin_required' });
    mocks.resume.mockRejectedValue(new ProRoomApiError('SESSION_REQUIRED', 401));
    mocks.showDialog.mockResolvedValue({ action: 'ok', inputValue: '1234-5678' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(true);

    expect(mocks.join).toHaveBeenCalledWith({
      code: ROOM_CODE,
      pin: '12345678',
      displayName: 'Peer 1',
    });
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
    expect(mocks.join).toHaveBeenLastCalledWith(expect.objectContaining({ pin: '22222222' }));
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

    expect(mocks.activate).toHaveBeenCalledWith({
      code: ROOM_CODE,
      claimToken: CLAIM,
      temporaryPin: '00000001',
      newPin: '87654321',
      ownerName: 'Peer 1',
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

    expect(mocks.recoverOwner).toHaveBeenCalledWith({
      code: ROOM_CODE,
      claimToken: CLAIM,
      displayName: 'Peer 1',
    });
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
    expect(mocks.showDialog).not.toHaveBeenCalled();
    expect(mocks.takeClaims.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
      mocks.bootstrap.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('fails owner recovery generically without exposing details or falling back to PIN', async () => {
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
      title: 'pro.suspended_title',
      message: 'pro.connect_failed',
      buttonText: 'common.ok',
    });
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.join).not.toHaveBeenCalled();
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
  });

  it('does not expose an unclaimed room or connect a suspended room', async () => {
    mocks.bootstrap.mockResolvedValueOnce({
      roomCode: ROOM_CODE,
      status: 'activation_required',
    });
    mocks.showDialog.mockResolvedValueOnce({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);
    expect(mocks.activate).not.toHaveBeenCalled();

    mocks.bootstrap.mockResolvedValueOnce({ roomCode: ROOM_CODE, status: 'suspended' });
    mocks.showDialog.mockResolvedValueOnce({ action: 'ok' });

    await expect(enterProRoomFromSetup(ROOM_CODE)).resolves.toBe(false);
    expect(mocks.resume).not.toHaveBeenCalled();
  });
});

/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProRoomApiError } from '../api.ts';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  bootstrap: vi.fn(),
  getState: vi.fn(),
  join: vi.fn(),
  resume: vi.fn(),
  showDialog: vi.fn(),
  takeClaim: vi.fn(),
}));

vi.mock('../../core/state.ts', () => ({ getState: mocks.getState }));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: mocks.showDialog }));
vi.mock('../claim-fragment.ts', () => ({
  takeProRoomClaimFromFragment: mocks.takeClaim,
}));
vi.mock('../runtime.ts', () => ({
  activateProRoom: mocks.activate,
  getProRoomBootstrap: mocks.bootstrap,
  joinProRoom: mocks.join,
  resumeProRoom: mocks.resume,
}));

import { enterProRoomFromSetup } from '../setup-flow.ts';

const ROOM_CODE = '000001';
const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getState.mockReturnValue('Peer 1');
  mocks.takeClaim.mockReturnValue(null);
  mocks.resume.mockResolvedValue({});
  mocks.join.mockResolvedValue({});
  mocks.activate.mockResolvedValue({});
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
    mocks.takeClaim.mockReturnValue(CLAIM);
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
      ownerName: 'Owner',
    });
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

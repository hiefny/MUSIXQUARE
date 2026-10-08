/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAccountStateForTests,
  applyAccountSession,
  setAccountAnonymous,
} from '../../account/state.ts';
import type { AccountSessionResponse } from '../../account/api.ts';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), login: vi.fn(), dialog: vi.fn() }));
vi.mock('../../account/session.ts', () => ({
  reconcileAccountLoginSession: mocks.refresh,
  requestAccountLoginPopup: mocks.login,
}));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: mocks.dialog }));
vi.mock('../../i18n/index.ts', () => ({
  t: (key: string, params?: { name?: string }) => (params?.name ? `${key}:${params.name}` : key),
}));

import {
  captureActivationAccountIntent,
  confirmProRoomActivationAccount,
} from '../activation-account.ts';

const A: AccountSessionResponse = {
  configured: true,
  authenticated: true,
  account: { nickname: 'Account A', profileComplete: true },
  statsScope: 'a'.repeat(43),
};
const B: AccountSessionResponse = {
  ...A,
  account: { nickname: 'Account B', profileComplete: true },
  statsScope: 'b'.repeat(43),
};
const ANONYMOUS: AccountSessionResponse = {
  configured: true,
  authenticated: false,
  account: null,
  statsScope: null,
};
let session: AccountSessionResponse;

beforeEach(() => {
  vi.resetAllMocks();
  __resetAccountStateForTests();
  session = A;
  mocks.refresh.mockImplementation(async () => {
    applyAccountSession(session);
    return session;
  });
  mocks.login.mockResolvedValue('authenticated');
  mocks.dialog.mockResolvedValue({ action: 'ok' });
});

describe('PRO activation account confirmation', () => {
  it('refreshes and explicitly confirms the named account with two stacked buttons', async () => {
    await expect(confirmProRoomActivationAccount()).resolves.toBe(A.statsScope);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'pro.activation_account_message:Account A',
        buttonText: 'pro.activation_account_continue',
        secondaryText: 'pro.activation_account_switch',
        actionLayout: 'stacked',
        dismissible: true,
      }),
    );
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('requires explicit account confirmation after an anonymous user signs in', async () => {
    session = ANONYMOUS;
    mocks.login.mockImplementation(async () => {
      session = B;
      return 'authenticated';
    });
    mocks.dialog.mockImplementationOnce(async (options) => {
      expect(options.message).toBe('pro.activation_account_login_message');
      options.onPrimaryActivation();
      return { action: 'ok' };
    });
    await expect(confirmProRoomActivationAccount()).resolves.toBe(B.statsScope);
    expect(mocks.dialog).toHaveBeenCalledTimes(2);
    expect(mocks.dialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'pro.activation_account_message:Account B' }),
    );
    expect(mocks.login).toHaveBeenCalledWith({ forceGoogleAccountChooser: true });
  });

  it('opens the account chooser in the secondary gesture and confirms the replacement account', async () => {
    mocks.login.mockImplementation(async () => {
      session = B;
      return 'authenticated';
    });
    mocks.dialog.mockImplementationOnce(async (options) => {
      options.onSecondaryActivation();
      expect(mocks.login).toHaveBeenCalledWith({ forceGoogleAccountChooser: true });
      return { action: 'secondary' };
    });
    await expect(confirmProRoomActivationAccount()).resolves.toBe(B.statsScope);
    expect(mocks.dialog).toHaveBeenCalledTimes(2);
  });

  it('completes a signed-in nickname before confirming that account without another Google sign-in', async () => {
    session = { ...A, account: { nickname: '', profileComplete: false } };
    mocks.login.mockImplementation(async () => {
      expect(mocks.dialog).not.toHaveBeenCalled();
      session = A;
      return 'authenticated';
    });
    await expect(confirmProRoomActivationAccount()).resolves.toBe(A.statsScope);
    expect(mocks.login).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.dialog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'pro.activation_account_message:Account A' }),
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it('stops activation when nickname setup is deferred without inventing an account name', async () => {
    session = { ...A, account: { nickname: '', profileComplete: false } };
    mocks.login.mockResolvedValue('cancelled');
    await expect(confirmProRoomActivationAccount()).resolves.toBeNull();
    expect(mocks.dialog).not.toHaveBeenCalled();
  });

  it('offers a retry after nickname setup fails without accepting the incomplete account', async () => {
    session = { ...A, account: { nickname: '', profileComplete: false } };
    mocks.login.mockResolvedValue('error');
    mocks.dialog.mockResolvedValue({ action: 'secondary' });
    await expect(confirmProRoomActivationAccount()).resolves.toBeNull();
    expect(mocks.dialog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'pro.activation_account_unavailable' }),
    );
  });

  it.each(['blocked', 'cancelled', 'error'])(
    'retains account choice after popup %s without treating it as consent',
    async (outcome) => {
      mocks.login.mockResolvedValue(outcome);
      mocks.dialog
        .mockImplementationOnce(async (options) => {
          options.onSecondaryActivation();
          return { action: 'secondary' };
        })
        .mockResolvedValueOnce({ action: 'close' });
      await expect(confirmProRoomActivationAccount()).resolves.toBeNull();
      expect(mocks.dialog).toHaveBeenCalledTimes(2);
      expect(mocks.dialog.mock.calls[1]?.[0].message).toContain(
        'pro.activation_account_message:Account A',
      );
    },
  );

  it('cancels without opening login or confirming an account', async () => {
    mocks.dialog.mockResolvedValue({ action: 'close' });
    await expect(confirmProRoomActivationAccount()).resolves.toBeNull();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('does not fall through to a stale cached account when the fresh read fails', async () => {
    applyAccountSession(A);
    mocks.refresh.mockRejectedValueOnce(new Error('offline'));
    mocks.dialog.mockResolvedValueOnce({ action: 'secondary' });
    await expect(confirmProRoomActivationAccount()).resolves.toBeNull();
    expect(mocks.dialog).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'pro.activation_account_unavailable' }),
    );
  });

  it('discards an open confirmation when the account changes and displays the new identity', async () => {
    mocks.dialog.mockImplementationOnce(async (options) => {
      session = B;
      applyAccountSession(B);
      expect(options.signal.aborted).toBe(true);
      return { action: 'ok' };
    });
    await expect(confirmProRoomActivationAccount()).resolves.toBe(B.statsScope);
    expect(mocks.dialog).toHaveBeenCalledTimes(2);
  });

  it('invalidates a confirmed intent across logout even if the original scope reappears', () => {
    applyAccountSession(A);
    const intent = captureActivationAccountIntent(A.statsScope!);
    expect(intent.isCurrent()).toBe(true);
    setAccountAnonymous();
    applyAccountSession(A);
    expect(intent.signal.aborted).toBe(true);
    expect(intent.isCurrent()).toBe(false);
    intent.dispose();
  });
});

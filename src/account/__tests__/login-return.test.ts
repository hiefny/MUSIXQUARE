/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __accountLoginReturnForTests,
  clearAccountLoginReturn,
  hasAccountLoginReturnForRoom,
  rememberAccountLoginReturn,
  restoreAccountLoginReturnPath,
} from '../login-return.ts';

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.useRealTimers();
});

describe('same-tab account login return', () => {
  it('recovers a successful callback that the installed shell reopened at its start URL', () => {
    rememberAccountLoginReturn('/000001?panel=connect#account', '000001');

    expect(restoreAccountLoginReturnPath()).toBe(true);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/000001?panel=connect#account',
    );
    expect(hasAccountLoginReturnForRoom('000001')).toBe(true);
  });

  it('restores the intended PRO route before setup and preserves an auth outcome marker', () => {
    rememberAccountLoginReturn('/000001?panel=connect#account', '000001');
    window.history.replaceState({}, '', '/?accountAuth=cancelled');

    expect(restoreAccountLoginReturnPath()).toBe(true);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/000001?panel=connect&accountAuth=cancelled#account',
    );
    expect(hasAccountLoginReturnForRoom('000001')).toBe(true);

    clearAccountLoginReturn();
    expect(hasAccountLoginReturnForRoom('000001')).toBe(false);
  });

  it('rejects expired or external-looking stored return paths', () => {
    const key = __accountLoginReturnForTests.STORAGE_KEY;
    sessionStorage.setItem(
      key,
      JSON.stringify({
        returnTo: '/000001',
        roomCode: '000001',
        createdAt: Date.now() - 15 * 60 * 1000 - 1,
      }),
    );
    expect(hasAccountLoginReturnForRoom('000001')).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();

    sessionStorage.setItem(
      key,
      JSON.stringify({ returnTo: '//evil.example', roomCode: '000001', createdAt: Date.now() }),
    );
    expect(restoreAccountLoginReturnPath()).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
  });
});

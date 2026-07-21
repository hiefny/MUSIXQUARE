/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __accountLoginReturnForTests,
  clearAccountLoginReturn,
  consumeAccountLoginReturnForRoom,
  rememberAccountLoginReturn,
  restoreAccountLoginReturnPath,
  sanitizeAccountLoginReturnPath,
} from '../login-return.ts';

function runAsInstalledPwa(): void {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('account login return continuity', () => {
  it('keeps an exact same-context callback route and consumes its takeover marker once', () => {
    rememberAccountLoginReturn('/000001?panel=connect#account', '000001', {
      allowSilentTakeover: true,
    });

    expect(restoreAccountLoginReturnPath()).toBe(true);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/000001?panel=connect#account',
    );
    expect(consumeAccountLoginReturnForRoom('000001')).toEqual({
      allowSilentTakeover: true,
      source: 'same-context',
    });
    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
  });

  it('restores a closed PWA from durable route-only state without granting silent takeover', () => {
    runAsInstalledPwa();
    rememberAccountLoginReturn('/000001?panel=connect#account', '000001', {
      allowSilentTakeover: true,
    });
    const durableRaw = localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY);

    expect(durableRaw).not.toContain('panel');
    expect(durableRaw).not.toContain('#account');
    expect(JSON.parse(durableRaw || '{}')).toMatchObject({
      returnTo: '/000001',
      roomCode: '000001',
    });

    // Model closing the provider-owned PWA window and launching the manifest
    // start URL in a completely new top-level browsing context.
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');

    expect(restoreAccountLoginReturnPath()).toBe(true);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/000001',
    );
    expect(consumeAccountLoginReturnForRoom('000001')).toEqual({
      allowSilentTakeover: false,
      source: 'pwa-relaunch',
    });
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
  });

  it('scrubs PRO claims and credential-shaped query values before OAuth storage', () => {
    const raw =
      '/000001?panel=connect&pin=12345678&token=session-secret#view=setup&pro-recovery=claim-secret';
    expect(sanitizeAccountLoginReturnPath(raw)).toBe('/000001?panel=connect');

    rememberAccountLoginReturn(raw, '000001', { allowSilentTakeover: true });

    const sessionRaw = sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY);
    const durableRaw = localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY);
    expect(sessionRaw).not.toContain('12345678');
    expect(sessionRaw).not.toContain('session-secret');
    expect(sessionRaw).not.toContain('claim-secret');
    expect(JSON.parse(sessionRaw || '{}')).toMatchObject({
      returnTo: '/000001?panel=connect',
    });
    expect(durableRaw).not.toContain('12345678');
    expect(durableRaw).not.toContain('session-secret');
    expect(durableRaw).not.toContain('claim-secret');
  });

  it('preserves a provider cancellation marker while restoring the intended PRO route', () => {
    rememberAccountLoginReturn('/000001?panel=connect#account', '000001', {
      allowSilentTakeover: true,
    });
    window.history.replaceState({}, '', '/?accountAuth=cancelled');

    expect(restoreAccountLoginReturnPath()).toBe(true);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/000001?panel=connect&accountAuth=cancelled#account',
    );
    expect(consumeAccountLoginReturnForRoom('000001')).toEqual({
      allowSilentTakeover: true,
      source: 'same-context',
    });
    expect(sessionStorage.getItem(__accountLoginReturnForTests.SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
  });

  it('does not apply a shared durable hint in an ordinary browser tab', () => {
    rememberAccountLoginReturn('/000001', '000001');
    sessionStorage.clear();

    expect(restoreAccountLoginReturnPath()).toBe(false);
    expect(window.location.pathname).toBe('/');
    expect(consumeAccountLoginReturnForRoom('000001')).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).not.toBeNull();
  });

  it('rejects and cleans expired, damaged, or credential-bearing durable state', () => {
    runAsInstalledPwa();
    const { SESSION_STORAGE_KEY, DURABLE_STORAGE_KEY, MAX_AGE_MS } = __accountLoginReturnForTests;
    localStorage.setItem(
      DURABLE_STORAGE_KEY,
      JSON.stringify({
        attemptId: 'attempt-expired-123',
        returnTo: '/000001',
        roomCode: '000001',
        createdAt: Date.now() - MAX_AGE_MS - 1,
      }),
    );
    expect(restoreAccountLoginReturnPath()).toBe(false);
    expect(localStorage.getItem(DURABLE_STORAGE_KEY)).toBeNull();

    localStorage.setItem(
      DURABLE_STORAGE_KEY,
      JSON.stringify({
        attemptId: 'attempt-secret-1234',
        returnTo: '/000001#pro-recovery=secret',
        roomCode: '000001',
        createdAt: Date.now(),
      }),
    );
    expect(restoreAccountLoginReturnPath()).toBe(false);
    expect(localStorage.getItem(DURABLE_STORAGE_KEY)).toBeNull();

    sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ returnTo: '//evil.example', roomCode: '000001', createdAt: Date.now() }),
    );
    expect(restoreAccountLoginReturnPath()).toBe(false);
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('clears only the abandoned attempt when another tab has written a newer one', () => {
    const firstAttempt = rememberAccountLoginReturn('/000001', '000001');
    const secondAttempt = rememberAccountLoginReturn('/000002', '000002');
    expect(firstAttempt).not.toBeNull();
    expect(secondAttempt).not.toBe(firstAttempt);

    clearAccountLoginReturn(firstAttempt!);

    expect(
      JSON.parse(sessionStorage.getItem(__accountLoginReturnForTests.STORAGE_KEY) || '{}'),
    ).toMatchObject({ attemptId: secondAttempt, roomCode: '000002' });
    expect(
      JSON.parse(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY) || '{}'),
    ).toMatchObject({ attemptId: secondAttempt, roomCode: '000002' });

    clearAccountLoginReturn();
    expect(sessionStorage.getItem(__accountLoginReturnForTests.STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(__accountLoginReturnForTests.DURABLE_STORAGE_KEY)).toBeNull();
  });
});

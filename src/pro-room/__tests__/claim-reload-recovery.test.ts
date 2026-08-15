/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetDocumentReloadForTests,
  capturePendingClaimReloadGuard,
  requestDocumentReload,
} from '../../core/document-reload.ts';
import { takeProRoomClaimsFromFragment } from '../claim-fragment.ts';

type DocumentReloadAttempt = Parameters<Parameters<typeof requestDocumentReload>[0]>[0];

const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;

afterEach(() => {
  __resetDocumentReloadForTests();
  history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
});

describe.each([
  ['activation', 'pro-claim'],
  ['recovery', 'pro-recovery'],
  ['transfer', 'pro-transfer'],
] as const)('%s claim reload recovery', (_purpose, key) => {
  it('restores one canonical fragment only during navigation and scrubs it on recovery', () => {
    history.replaceState({ test: true }, '', `/000001?lang=ko#${key}=${CLAIM}`);
    takeProRoomClaimsFromFragment();
    expect(location.href).toBe('http://localhost:3000/000001?lang=ko');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    let attempt: DocumentReloadAttempt | undefined;
    requestDocumentReload((value) => {
      attempt = value;
    });
    const navigate = vi.fn(() => {
      expect(location.pathname).toBe('/000001');
      expect(location.search).toBe('?lang=ko');
      expect(location.hash).toBe(`#${key}=${CLAIM}`);
      expect(new URLSearchParams(location.search).has(key)).toBe(false);
    });

    expect(location.hash).toBe('');
    attempt!.navigate(navigate);
    expect(navigate).toHaveBeenCalledOnce();
    attempt!.recover();
    expect(location.href).toBe('http://localhost:3000/000001?lang=ko');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    capturePendingClaimReloadGuard()?.release();
  });
});

it('restores a trailing-slash claim again after a recovered reload attempt', () => {
  history.replaceState({ test: true }, '', `/000001/?lang=ko#pro-claim=${CLAIM}`);
  takeProRoomClaimsFromFragment();
  expect(location.href).toBe('http://localhost:3000/000001/?lang=ko');

  for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
    let attempt: DocumentReloadAttempt | undefined;
    requestDocumentReload((value) => {
      attempt = value;
    });
    attempt!.navigate(() => {
      expect(location.href).toBe(`http://localhost:3000/000001?lang=ko#pro-claim=${CLAIM}`);
    });
    attempt!.recover();
    expect(location.href).toBe('http://localhost:3000/000001/?lang=ko');
  }
});

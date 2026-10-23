/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capturePendingClaimReloadGuard } from '../../core/document-reload.ts';
import {
  NAVIGATION_COMMIT_TIMEOUT_MS,
  RESET_PAINT_FALLBACK_MS,
} from '../../core/navigation-contract.ts';
import { __resetPageNavigationForTests, scheduleDocumentReload } from '../../core/session-reset.ts';
import {
  stubNavigationSinks,
  type NavigationSinks,
} from '../../core/__tests__/__helpers__/navigation-sinks.ts';
import { takeProRoomClaimsFromFragment } from '../claim-fragment.ts';

const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
  window,
  'requestAnimationFrame',
);
let sinks: NavigationSinks;

beforeEach(() => {
  vi.useFakeTimers();
  // Frames suspended: the reset runs its action on the paint fallback.
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: undefined });
  sinks = stubNavigationSinks();
});

afterEach(() => {
  __resetPageNavigationForTests();
  vi.unstubAllGlobals();
  if (originalRequestAnimationFrame) {
    Object.defineProperty(window, 'requestAnimationFrame', originalRequestAnimationFrame);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
});

/** One app reload through the navigation owner that does not leave this document. */
function reloadThatReturns(): void {
  scheduleDocumentReload('Refreshing');
  vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS);
  vi.advanceTimersByTime(NAVIGATION_COMMIT_TIMEOUT_MS);
}

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

    scheduleDocumentReload('Refreshing');
    expect(location.hash).toBe('');
    vi.advanceTimersByTime(RESET_PAINT_FALLBACK_MS);

    expect(sinks.calls).toEqual([
      {
        op: 'reload',
        url: null,
        hrefAtCall: `http://localhost:3000/000001?lang=ko#${key}=${CLAIM}`,
      },
    ]);
    expect(new URLSearchParams(location.search).has(key)).toBe(false);
    vi.advanceTimersByTime(NAVIGATION_COMMIT_TIMEOUT_MS);
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
    reloadThatReturns();
    expect(sinks.calls.at(-1)?.hrefAtCall).toBe(
      `http://localhost:3000/000001?lang=ko#pro-claim=${CLAIM}`,
    );
    expect(location.href).toBe('http://localhost:3000/000001/?lang=ko');
  }
  expect(sinks.count('reload')).toBe(2);
});

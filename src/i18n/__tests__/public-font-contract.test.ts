/**
 * @vitest-environment jsdom
 */
/**
 * The public pages' font sheet groups (src/i18n/public-font-contract.ts):
 * first.css holds what the app's own loader declares in phase A for the
 * Korean and English UIs under a browser that names no Japanese or Chinese,
 * and rest.css every other app sheet in contract order. The app's loader
 * (src/i18n/locale-fonts.ts) is driven here the way locale-fonts.test.ts
 * drives it, so the copy follows the owner without the owner knowing it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_FONT_SHEETS } from '../app-font-contract.ts';
import { PUBLIC_FONT_SHEET_GROUPS } from '../public-font-contract.ts';

const sheets = vi.hoisted(() => ({ requests: [] as string[] }));

vi.mock('../retryable-stylesheet.ts', () => ({
  createRetryableStylesheet: (sourceName: string) =>
    Object.assign(
      () => {
        sheets.requests.push(sourceName);
        return Promise.resolve();
      },
      { abandon: () => undefined, redeclare: () => true },
    ),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function setLanguages(languages: readonly string[]): void {
  Object.defineProperty(navigator, 'languages', { configurable: true, value: languages });
  Object.defineProperty(navigator, 'language', { configurable: true, value: languages[0] ?? '' });
}

/** The sheets a fresh app loader requests in phase A for a UI language. */
async function phaseA(code: 'ko' | 'en'): Promise<string[]> {
  vi.resetModules();
  sheets.requests.length = 0;
  const runtime = (await import('../locale-fonts.ts')).default;
  await runtime.loadLanguageFonts(code);
  return [...sheets.requests];
}

beforeEach(() => {
  sheets.requests.length = 0;
  // Idle callbacks that never run keep phase B and the prefetch out.
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 1),
  });
  Object.defineProperty(window, 'cancelIdleCallback', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'complete' });
  document.documentElement.removeAttribute('data-mxqr-han-order');
  setLanguages(['en-US']);
});

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  Reflect.deleteProperty(window, 'requestIdleCallback');
  Reflect.deleteProperty(window, 'cancelIdleCallback');
  Reflect.deleteProperty(document, 'readyState');
  Reflect.deleteProperty(navigator, 'languages');
  Reflect.deleteProperty(navigator, 'language');
  document.documentElement.removeAttribute('data-mxqr-han-order');
  vi.restoreAllMocks();
});

describe('the public font sheet groups', () => {
  it('put Inter, MUSIXQUARE Hangul and Noto Sans KR first', () => {
    expect(PUBLIC_FONT_SHEET_GROUPS.first).toEqual(['font-inter', 'font-hangul', 'font-noto-kr']);
  });

  it.each(['en', 'ko'] as const)(
    "match the app loader's phase A for the %s UI under browser languages en-US",
    async (code) => {
      expect(await phaseA(code)).toEqual([...PUBLIC_FONT_SHEET_GROUPS.first]);
    },
  );

  it('put every other app sheet in rest, in contract order', () => {
    const ids = APP_FONT_SHEETS.map(({ id }) => id);
    expect(PUBLIC_FONT_SHEET_GROUPS.rest).toEqual(
      ids.filter((id) => !PUBLIC_FONT_SHEET_GROUPS.first.includes(id)),
    );
    expect(PUBLIC_FONT_SHEET_GROUPS.rest).toHaveLength(14);
    expect([...PUBLIC_FONT_SHEET_GROUPS.first, ...PUBLIC_FONT_SHEET_GROUPS.rest].sort()).toEqual(
      [...ids].sort(),
    );
  });
});

/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_FONT_SHEETS } from '../app-font-contract.ts';
import {
  FONT_SHEETS_IDLE_TIMEOUT_MS,
  FONT_SHEET_RETRY_DELAY_MS,
  FONT_SHEET_RETRY_LIMIT,
} from '../font-loading-policy.ts';
import type { LanguageCode } from '../locales.ts';

/**
 * The app font owner, driven through its public API with the stylesheet
 * loaders, idle callbacks, timers, document state and Font Loading API
 * replaced. Each test imports a fresh module.
 */

const sheets = vi.hoisted(() => ({
  /** Source names the module created a loader for, in creation order. */
  registered: [] as string[],
  /** Every loader call, in order. */
  requests: [] as string[],
  /** Per-sheet behaviour; a sheet without one loads at once. */
  behaviour: new Map<string, () => Promise<unknown>>(),
}));

vi.mock('../retryable-stylesheet.ts', () => ({
  createRetryableStylesheet: (sourceName: string) => {
    sheets.registered.push(sourceName);
    return () => {
      sheets.requests.push(sourceName);
      return sheets.behaviour.get(sourceName)?.() ?? Promise.resolve();
    };
  },
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Runtime = (typeof import('../locale-fonts.ts'))['default'];

interface IdleRequest {
  readonly callback: IdleRequestCallback;
  readonly options: IdleRequestOptions | undefined;
  cancelled: boolean;
}

let idleRequests: IdleRequest[] = [];
let readyState: DocumentReadyState = 'complete';
let visibilityState: DocumentVisibilityState = 'visible';

function installIdleCallbacks(): void {
  idleRequests = [];
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    writable: true,
    value: vi.fn((callback: IdleRequestCallback, options?: IdleRequestOptions) => {
      idleRequests.push({ callback, options, cancelled: false });
      return idleRequests.length;
    }),
  });
  Object.defineProperty(window, 'cancelIdleCallback', {
    configurable: true,
    writable: true,
    value: vi.fn((handle: number) => {
      const request = idleRequests[handle - 1];
      if (request) request.cancelled = true;
    }),
  });
}

function removeIdleCallbacks(): void {
  Reflect.deleteProperty(window, 'requestIdleCallback');
  Reflect.deleteProperty(window, 'cancelIdleCallback');
}

function pendingIdle(): IdleRequest[] {
  return idleRequests.filter((request) => !request.cancelled);
}

/** Run every pending idle callback once, then let the loads settle. */
async function runIdle(): Promise<void> {
  const due = pendingIdle();
  for (const request of due) request.cancelled = true;
  for (const request of due) request.callback({ didTimeout: false, timeRemaining: () => 50 });
  await settle();
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function setLanguages(languages: readonly string[]): void {
  Object.defineProperty(navigator, 'languages', { configurable: true, value: languages });
  Object.defineProperty(navigator, 'language', { configurable: true, value: languages[0] ?? '' });
}

function setVisibility(state: DocumentVisibilityState): void {
  visibilityState = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function freshRuntime(): Promise<Runtime> {
  vi.resetModules();
  sheets.registered.length = 0;
  return (await import('../locale-fonts.ts')).default;
}

function failing(times: number): () => Promise<unknown> {
  let remaining = times;
  return () => {
    if (remaining > 0) {
      remaining -= 1;
      return Promise.reject(new Error('temporary chunk failure'));
    }
    return Promise.resolve();
  };
}

const APP_SHEET_IDS = APP_FONT_SHEETS.map(({ id }) => id);

// Every fresh module instance adds its own window and document listeners.
// Remove them after each test so an earlier instance never answers a later
// test's events.
const listeners: [EventTarget, string, EventListenerOrEventListenerObject][] = [];

function recordListeners(target: Window | Document): void {
  const add = target.addEventListener.bind(target);
  vi.spyOn(target, 'addEventListener').mockImplementation(
    (type: string, listener: EventListenerOrEventListenerObject | null, options?: unknown) => {
      if (!listener) return;
      listeners.push([target, type, listener]);
      add(type, listener, options as AddEventListenerOptions);
    },
  );
}

/** Fake only the timers; idle callbacks stay the test's own. */
function useFakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
}

beforeEach(() => {
  sheets.requests.length = 0;
  sheets.behaviour.clear();
  readyState = 'complete';
  visibilityState = 'visible';
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => readyState });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
  document.documentElement.removeAttribute('data-mxqr-han-order');
  setLanguages(['en-US']);
  installIdleCallbacks();
  recordListeners(window);
  recordListeners(document);
});

afterEach(() => {
  for (const [target, type, listener] of listeners.splice(0)) {
    target.removeEventListener(type, listener);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  removeIdleCallbacks();
  Reflect.deleteProperty(document, 'readyState');
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(document, 'fonts');
  Reflect.deleteProperty(navigator, 'languages');
  Reflect.deleteProperty(navigator, 'language');
  Reflect.deleteProperty(navigator, 'connection');
  Reflect.deleteProperty(window, '__MUSIXQUARE_FONTS_SETTLED__');
  document.documentElement.removeAttribute('data-mxqr-han-order');
});

describe('app font sheets', () => {
  it('creates one loader per app sheet and none for the static pages’ sheets', async () => {
    await freshRuntime();
    expect([...sheets.registered].sort()).toEqual([...APP_SHEET_IDS].sort());
  });

  it('imports each sheet from its contract path, one literal import per sheet', () => {
    const source = readFileSync('src/i18n/locale-fonts.ts', 'utf8');
    const imports = [
      ...source.matchAll(
        /createRetryableStylesheet\(\s*'([^']+)',\s*\(\)\s*=>\s*import\('\.\.\/\.\.\/([^']+)'\),?\s*\)/gu,
      ),
    ].map((match) => [match[1], match[2]]);

    expect(imports).toEqual(APP_FONT_SHEETS.map(({ id, path }) => [id, path]));
    expect(source.match(/\bimport\(/gu)).toHaveLength(APP_FONT_SHEETS.length);
  });
});

describe('phase A', () => {
  it.each([
    ['ko', ['en-US'], ['font-inter', 'font-noto-kr']],
    ['en', ['en-US'], ['font-inter', 'font-noto-kr']],
    ['fr', ['fr-FR'], ['font-inter', 'font-noto-kr']],
    ['ru', ['ru-RU'], ['font-inter', 'font-noto-kr']],
    ['el', ['el-GR'], ['font-inter', 'font-noto-kr']],
    ['ko', ['ja-JP', 'ko-KR'], ['font-inter', 'font-noto-kr', 'font-noto-jp']],
    ['en', ['ja-JP', 'ko-KR'], ['font-inter', 'font-noto-jp']],
    ['en', ['zh-TW'], ['font-inter', 'font-noto-tc']],
    ['ja', ['en-US'], ['font-inter', 'font-noto-jp']],
    ['ja', ['zh-CN'], ['font-inter', 'font-noto-jp']],
    ['zh-hans', ['en-US'], ['font-inter', 'font-noto-sc']],
    ['zh-hant', ['ja-JP'], ['font-inter', 'font-noto-tc']],
    ['th', ['th-TH'], ['font-inter', 'font-noto-thai', 'font-noto-kr']],
    ['ar', ['ar'], ['font-inter', 'noto-arabic', 'font-noto-kr']],
    ['fa', ['fa'], ['font-inter', 'noto-arabic', 'font-noto-kr']],
    ['he', ['he'], ['font-inter', 'noto-hebrew', 'font-noto-kr']],
    ['hi', ['hi'], ['font-inter', 'noto-devanagari', 'font-noto-kr']],
    ['mr', ['mr'], ['font-inter', 'noto-devanagari', 'font-noto-kr']],
    ['pa', ['pa'], ['font-inter', 'noto-gurmukhi', 'font-noto-kr']],
  ] as const)('the %s UI with browser languages %j loads %j', async (code, languages, expected) => {
    setLanguages(languages);
    const runtime = await freshRuntime();

    await runtime.loadLanguageFonts(code);

    expect(sheets.requests).toEqual(expected);
  });

  it('loads the same sheets in the same order for the Korean and English UIs', async () => {
    for (const languages of [['ko-KR'], ['en-US'], ['ja-JP'], ['zh-CN', 'ko-KR']]) {
      setLanguages(languages);
      sheets.requests.length = 0;
      await (await freshRuntime()).loadLanguageFonts('ko');
      const korean = [...sheets.requests];
      sheets.requests.length = 0;
      await (await freshRuntime()).loadLanguageFonts('en');
      // A Korean UI also needs Korean for its own words when the browser
      // prefers another Han order; with Korean first they are identical.
      if (languages[0] === 'ko-KR' || languages[0] === 'en-US') {
        expect(sheets.requests, languages.join()).toEqual(korean);
      } else {
        expect(korean.filter((id) => id !== 'font-noto-kr')).toEqual(sheets.requests);
      }
    }
  });

  it('shares concurrent requests and never requests a declared sheet again', async () => {
    let finish!: () => void;
    sheets.behaviour.set(
      'font-noto-kr',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const runtime = await freshRuntime();

    const first = runtime.loadLanguageFonts('ko');
    const second = runtime.loadLanguageFonts('en');
    expect(sheets.requests).toEqual(['font-inter', 'font-noto-kr']);
    finish();
    await Promise.all([first, second]);
    await runtime.loadLanguageFonts('ko');

    expect(sheets.requests).toEqual(['font-inter', 'font-noto-kr']);
  });

  it('resolves without rejecting when a sheet fails', async () => {
    sheets.behaviour.set('font-noto-kr', failing(1));
    const runtime = await freshRuntime();

    await expect(runtime.loadLanguageFonts('ko')).resolves.toBeUndefined();
  });

  it('tries a failed sheet again at once on the next language request', async () => {
    sheets.behaviour.set('font-noto-kr', failing(1));
    const runtime = await freshRuntime();

    await runtime.loadLanguageFonts('ko');
    await runtime.loadLanguageFonts('en');

    expect(sheets.requests).toEqual(['font-inter', 'font-noto-kr', 'font-noto-kr']);
  });
});

describe('startup Han order', () => {
  it.each([
    [['ko-KR', 'ja-JP'], null],
    [['en-US'], null],
    [['ja-JP', 'ko-KR'], 'ja'],
    [['zh-CN'], 'zh-hans'],
    [['zh-HK'], 'zh-hant'],
  ] as const)('marks the document for browser languages %j', async (languages, attribute) => {
    setLanguages(languages);
    const runtime = await freshRuntime();
    expect(document.documentElement.hasAttribute('data-mxqr-han-order')).toBe(false);

    await runtime.loadLanguageFonts('en');

    expect(document.documentElement.getAttribute('data-mxqr-han-order')).toBe(attribute);
  });

  it('is chosen once per page and survives language changes', async () => {
    setLanguages(['ja-JP']);
    const runtime = await freshRuntime();
    await runtime.loadLanguageFonts('ko');

    setLanguages(['zh-TW']);
    window.dispatchEvent(new Event('languagechange'));
    await runtime.loadLanguageFonts('zh-hans');
    await runtime.loadLanguageFonts('en');

    expect(document.documentElement.getAttribute('data-mxqr-han-order')).toBe('ja');
    expect(sheets.requests).not.toContain('font-noto-tc');
  });
});

describe('phase B', () => {
  it('declares every other sheet after window load and the first idle slice', async () => {
    readyState = 'loading';
    const runtime = await freshRuntime();

    await runtime.loadLanguageFonts('ko');
    expect(idleRequests).toHaveLength(0);

    readyState = 'complete';
    window.dispatchEvent(new Event('load'));
    expect(pendingIdle()).toHaveLength(1);
    expect(pendingIdle()[0]?.options).toEqual({ timeout: FONT_SHEETS_IDLE_TIMEOUT_MS });
    expect(sheets.requests).toEqual(['font-inter', 'font-noto-kr']);

    await runIdle();

    expect([...sheets.requests].sort()).toEqual([...APP_SHEET_IDS].sort());
  });

  it('waits only for an idle slice when the document has already loaded', async () => {
    const runtime = await freshRuntime();

    await runtime.loadLanguageFonts('en');
    expect(pendingIdle()).toHaveLength(1);
    await runIdle();

    expect(sheets.requests).toHaveLength(APP_SHEET_IDS.length);
  });

  it('runs once per page whatever the language changes', async () => {
    const runtime = await freshRuntime();

    await runtime.loadLanguageFonts('en');
    await runtime.loadLanguageFonts('ja');
    await runtime.loadLanguageFonts('ar');
    expect(pendingIdle()).toHaveLength(1);
    await runIdle();
    await runtime.loadLanguageFonts('zh-hant');

    expect(sheets.requests.slice().sort()).toEqual([...APP_SHEET_IDS].sort());
    expect(idleRequests).toHaveLength(1);
  });

  it('uses a timer for the slice where requestIdleCallback is missing', async () => {
    removeIdleCallbacks();
    useFakeTimers();
    const runtime = await freshRuntime();

    await runtime.loadLanguageFonts('en');
    expect(sheets.requests).toHaveLength(2);
    await vi.runOnlyPendingTimersAsync();

    expect(sheets.requests).toHaveLength(APP_SHEET_IDS.length);
  });

  it('declares every family even with data saver on', async () => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { saveData: true, effectiveType: '2g' },
    });
    const runtime = await freshRuntime();

    await runtime.loadLanguageFonts('en');
    await runIdle();

    expect(sheets.requests).toHaveLength(APP_SHEET_IDS.length);
  });

  it('resolves the fonts-settled hook once every sheet is declared', async () => {
    let finishThai!: () => void;
    sheets.behaviour.set(
      'font-noto-thai',
      () =>
        new Promise<void>((resolve) => {
          finishThai = resolve;
        }),
    );
    const runtime = await freshRuntime();
    const hook = window.__MUSIXQUARE_FONTS_SETTLED__;
    expect(hook).toBeInstanceOf(Promise);
    let done = false;
    const watched = hook?.then(() => {
      done = true;
    });

    await runtime.loadLanguageFonts('ko');
    await runIdle();
    expect(done).toBe(false);

    finishThai();
    await watched;
    expect(done).toBe(true);
  });

  it('settles the hook even when a sheet fails', async () => {
    sheets.behaviour.set('noto-hebrew', failing(Number.POSITIVE_INFINITY));
    const runtime = await freshRuntime();

    await runtime.loadLanguageFonts('ko');
    await runIdle();

    await expect(window.__MUSIXQUARE_FONTS_SETTLED__).resolves.toBeUndefined();
  });

  it('stops at pagehide and resumes when the page comes back from the back-forward cache', async () => {
    const runtime = await freshRuntime();

    await runtime.loadLanguageFonts('ko');
    expect(pendingIdle()).toHaveLength(1);
    window.dispatchEvent(new Event('pagehide'));
    expect(pendingIdle()).toHaveLength(0);

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    expect(pendingIdle()).toHaveLength(0);

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(pendingIdle()).toHaveLength(1);
    await runIdle();

    expect(sheets.requests).toHaveLength(APP_SHEET_IDS.length);
  });
});

describe('sheet retries', () => {
  it('retries a failed sheet in a visible idle slice after the delay, a bounded number of times', async () => {
    useFakeTimers();
    sheets.behaviour.set('font-noto-sc', failing(Number.POSITIVE_INFINITY));
    const runtime = await freshRuntime();
    await runtime.loadLanguageFonts('en');
    await runIdle();
    const scRequests = () => sheets.requests.filter((id) => id === 'font-noto-sc').length;
    expect(scRequests()).toBe(1);

    for (let retry = 1; retry <= FONT_SHEET_RETRY_LIMIT; retry += 1) {
      await vi.advanceTimersByTimeAsync(FONT_SHEET_RETRY_DELAY_MS - 1);
      expect(pendingIdle()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(pendingIdle()).toHaveLength(1);
      expect(pendingIdle()[0]?.options).toEqual({ timeout: FONT_SHEETS_IDLE_TIMEOUT_MS });
      await runIdle();
      expect(scRequests()).toBe(1 + retry);
    }

    await vi.advanceTimersByTimeAsync(FONT_SHEET_RETRY_DELAY_MS * 4);
    expect(pendingIdle()).toHaveLength(0);
    expect(scRequests()).toBe(1 + FONT_SHEET_RETRY_LIMIT);
  });

  it('retries at once when the browser comes back online', async () => {
    useFakeTimers();
    sheets.behaviour.set('font-noto-tc', failing(1));
    const runtime = await freshRuntime();
    await runtime.loadLanguageFonts('en');
    await runIdle();

    window.dispatchEvent(new Event('online'));
    await settle();

    expect(sheets.requests.filter((id) => id === 'font-noto-tc')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(FONT_SHEET_RETRY_DELAY_MS);
    expect(pendingIdle()).toHaveLength(0);
  });

  it('holds a retry while the page is hidden and runs it once visible', async () => {
    useFakeTimers();
    sheets.behaviour.set('font-noto-jp', failing(1));
    const runtime = await freshRuntime();
    await runtime.loadLanguageFonts('en');
    await runIdle();
    setVisibility('hidden');

    await vi.advanceTimersByTimeAsync(FONT_SHEET_RETRY_DELAY_MS);
    expect(pendingIdle()).toHaveLength(0);

    setVisibility('visible');
    expect(pendingIdle()).toHaveLength(1);
    await runIdle();

    expect(sheets.requests.filter((id) => id === 'font-noto-jp')).toHaveLength(2);
  });

  it('clears a pending retry at pagehide and resumes it from the back-forward cache', async () => {
    useFakeTimers();
    sheets.behaviour.set('noto-arabic', failing(1));
    const runtime = await freshRuntime();
    await runtime.loadLanguageFonts('en');
    await runIdle();

    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(FONT_SHEET_RETRY_DELAY_MS * 2);
    expect(pendingIdle()).toHaveLength(0);

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await runIdle();

    expect(sheets.requests.filter((id) => id === 'noto-arabic')).toHaveLength(2);
  });
});

describe('language name glyph warming', () => {
  function installFontSet() {
    const load = vi.fn((_font: string, _text?: string) => Promise.resolve([{} as FontFace]));
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load } });
    return load;
  }

  it.each([
    ['ko', '한국어', 'font-noto-kr', 'Noto Sans KR'],
    ['ja', '日本語', 'font-noto-jp', 'Noto Sans JP'],
    ['zh-hans', '简体中文', 'font-noto-sc', 'Noto Sans SC'],
    ['zh-hant', '繁體中文', 'font-noto-tc', 'Noto Sans TC'],
    ['th', 'ไทย', 'font-noto-thai', 'Noto Sans Thai'],
    ['ar', 'العربية', 'noto-arabic', 'Noto Sans Arabic'],
    ['he', 'עברית', 'noto-hebrew', 'Noto Sans Hebrew'],
    ['hi', 'हिन्दी', 'noto-devanagari', 'Noto Sans Devanagari'],
    ['gu', 'ગુજરાતી', 'noto-gujarati', 'Noto Sans Gujarati'],
    ['pa', 'ਪੰਜਾਬੀ', 'noto-gurmukhi', 'Noto Sans Gurmukhi'],
    ['en', 'English', 'font-inter', 'Inter'],
    ['vi', 'Tiếng Việt', 'font-inter', 'Inter'],
    ['ru', 'Русский', 'font-inter', 'Inter'],
    ['el', 'Ελληνικά', 'font-inter', 'Inter'],
  ] as const)('warms the %s name in its own face', async (code, name, sheet, family) => {
    const glyphs = installFontSet();
    const runtime = await freshRuntime();

    await expect(runtime.preloadNativeNameGlyphs(code as LanguageCode, name)).resolves.toBe(true);

    expect(sheets.requests).toEqual([sheet]);
    expect(glyphs).toHaveBeenCalledWith(
      `700 15px "${family}"`,
      [...new Set(Array.from(name).filter((character) => !/\s/u.test(character)))].join(''),
    );
  });

  it('waits for the sheet before requesting the glyph sample', async () => {
    let finish!: () => void;
    sheets.behaviour.set(
      'font-noto-jp',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const glyphs = installFontSet();
    const runtime = await freshRuntime();

    const preload = runtime.preloadNativeNameGlyphs('ja', '日本語');
    await settle();
    expect(glyphs).not.toHaveBeenCalled();

    finish();
    await expect(preload).resolves.toBe(true);
    expect(glyphs).toHaveBeenCalledExactlyOnceWith('700 15px "Noto Sans JP"', '日本語');
  });

  it('shares concurrent and completed requests', async () => {
    const glyphs = installFontSet();
    const runtime = await freshRuntime();

    const first = runtime.preloadNativeNameGlyphs('ru', 'Русский');
    expect(runtime.preloadNativeNameGlyphs('ru', 'Русский')).toBe(first);
    await expect(first).resolves.toBe(true);
    await expect(runtime.preloadNativeNameGlyphs('ru', 'Русский')).resolves.toBe(true);

    expect(glyphs).toHaveBeenCalledOnce();
    expect(sheets.requests).toEqual(['font-inter']);
  });

  it('warms only newly met characters as a name grows', async () => {
    const glyphs = installFontSet();
    const runtime = await freshRuntime();

    await runtime.preloadNativeNameGlyphs('ko', '한국');
    await runtime.preloadNativeNameGlyphs('ko', '한국어');

    expect(glyphs.mock.calls).toEqual([
      ['700 15px "Noto Sans KR"', '한국'],
      ['700 15px "Noto Sans KR"', '어'],
    ]);
  });

  it('keeps sheet and glyph failures retryable without rejecting', async () => {
    sheets.behaviour.set('font-noto-thai', failing(1));
    const glyphs = installFontSet();
    glyphs
      .mockRejectedValueOnce(new Error('temporary glyph failure'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{} as FontFace]);
    const runtime = await freshRuntime();

    await expect(runtime.preloadNativeNameGlyphs('th', 'ไทย')).resolves.toBe(false);
    expect(glyphs).not.toHaveBeenCalled();
    await expect(runtime.preloadNativeNameGlyphs('th', 'ไทย')).resolves.toBe(false);
    await expect(runtime.preloadNativeNameGlyphs('th', 'ไทย')).resolves.toBe(false);
    await expect(runtime.preloadNativeNameGlyphs('th', 'ไทย')).resolves.toBe(true);

    expect(glyphs).toHaveBeenCalledTimes(3);
  });

  it('relies on natural rendering where the Font Loading API is missing', async () => {
    const runtime = await freshRuntime();

    await expect(runtime.preloadNativeNameGlyphs('ja', '日本語')).resolves.toBe(true);
    expect(sheets.requests).toEqual(['font-noto-jp']);
  });
});

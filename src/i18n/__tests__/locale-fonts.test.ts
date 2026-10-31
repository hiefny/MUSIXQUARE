/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_FONT_SHEETS } from '../app-font-contract.ts';
import {
  FONT_PREFETCH_BATCH_FACES,
  FONT_PREFETCH_IDLE_FALLBACK_MS,
  FONT_PREFETCH_MAX_BYTES,
  FONT_PREFETCH_MAX_FACES,
  FONT_PREFETCH_QUIET_MS,
  FONT_SHEETS_IDLE_TIMEOUT_MS,
  FONT_SHEET_ATTEMPT_TIMEOUT_MAX_MS,
  FONT_SHEET_ATTEMPT_TIMEOUT_MS,
  FONT_SHEET_RETRY_DELAY_MS,
  FONT_SHEET_RETRY_LIMIT,
} from '../font-loading-policy.ts';
import { FONT_PREFETCH_BY_LANGUAGE } from '../font-prefetch-samples.ts';
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
  /** Sheets whose attempt in flight the module gave up, in order. */
  abandoned: [] as string[],
  /** Sheets the module declared again with a fresh link, in order. */
  redeclared: [] as string[],
}));

vi.mock('../retryable-stylesheet.ts', () => ({
  createRetryableStylesheet: (sourceName: string) => {
    sheets.registered.push(sourceName);
    return Object.assign(
      () => {
        sheets.requests.push(sourceName);
        return sheets.behaviour.get(sourceName)?.() ?? Promise.resolve();
      },
      {
        abandon: () => {
          sheets.abandoned.push(sourceName);
        },
        redeclare: () => {
          sheets.redeclared.push(sourceName);
          return true;
        },
      },
    );
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
  sheets.abandoned.length = 0;
  sheets.redeclared.length = 0;
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
  // Every module instance stops its timers and idle callbacks first.
  window.dispatchEvent(new Event('pagehide'));
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
  Reflect.deleteProperty(navigator, 'onLine');
  Reflect.deleteProperty(window, '__MUSIXQUARE_FONTS_SETTLED__');
  Reflect.deleteProperty(globalThis, 'caches');
  vi.doUnmock('../font-prefetch-samples.ts');
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
    ['en', ['ja-JP', 'ko-KR'], ['font-inter', 'font-noto-kr', 'font-noto-jp']],
    ['en', ['zh-TW'], ['font-inter', 'font-noto-kr', 'font-noto-tc']],
    ['fr', ['ja-JP'], ['font-inter', 'font-noto-kr', 'font-noto-jp']],
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

  it('loads the same sheets in the same order for the Korean and English UIs under every Han order', async () => {
    // Until phase B, a Hangul nickname or room member name must not draw in a
    // device font in one UI and in Noto Sans KR in the other, whatever the
    // browser's first CJK language.
    for (const languages of [['ko-KR'], ['en-US'], ['ja-JP'], ['zh-CN', 'ko-KR'], ['zh-HK']]) {
      setLanguages(languages);
      sheets.requests.length = 0;
      await (await freshRuntime()).loadLanguageFonts('ko');
      const korean = [...sheets.requests];
      sheets.requests.length = 0;
      await (await freshRuntime()).loadLanguageFonts('en');
      expect(sheets.requests, languages.join()).toEqual(korean);
      expect(korean, languages.join()).toContain('font-noto-kr');
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

  /** Phase A and B with font-noto-sc always failing, then every timer retry used up. */
  async function exhaustScRetries(): Promise<() => number> {
    useFakeTimers();
    sheets.behaviour.set('font-noto-sc', failing(Number.POSITIVE_INFINITY));
    const runtime = await freshRuntime();
    await runtime.loadLanguageFonts('en');
    await runIdle();
    for (let retry = 1; retry <= FONT_SHEET_RETRY_LIMIT; retry += 1) {
      await vi.advanceTimersByTimeAsync(FONT_SHEET_RETRY_DELAY_MS);
      await runIdle();
    }
    const scRequests = () => sheets.requests.filter((id) => id === 'font-noto-sc').length;
    expect(scRequests()).toBe(1 + FONT_SHEET_RETRY_LIMIT);
    await vi.advanceTimersByTimeAsync(FONT_SHEET_RETRY_DELAY_MS * 4);
    expect(pendingIdle()).toHaveLength(0);
    return scRequests;
  }

  it.each([
    ['the browser comes back online', () => window.dispatchEvent(new Event('online'))],
    [
      'the page becomes visible',
      () => {
        setVisibility('hidden');
        setVisibility('visible');
      },
    ],
    [
      'the page comes back from the back-forward cache',
      () => {
        window.dispatchEvent(new Event('pagehide'));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      },
    ],
  ])('retries a sheet whose timer retries are used up when %s', async (_when, trigger) => {
    const scRequests = await exhaustScRetries();

    trigger();
    await settle();
    await runIdle();

    expect(scRequests()).toBe(2 + FONT_SHEET_RETRY_LIMIT);
  });

  it('starts a full set of timer retries again after such a fresh chance', async () => {
    const scRequests = await exhaustScRetries();

    window.dispatchEvent(new Event('online'));
    await settle();
    for (let retry = 1; retry <= FONT_SHEET_RETRY_LIMIT; retry += 1) {
      await vi.advanceTimersByTimeAsync(FONT_SHEET_RETRY_DELAY_MS);
      await runIdle();
    }

    expect(scRequests()).toBe(2 + 2 * FONT_SHEET_RETRY_LIMIT);
  });

  it('makes no timer retry while the browser is offline and keeps the retry for online', async () => {
    useFakeTimers();
    sheets.behaviour.set('font-noto-sc', failing(Number.POSITIVE_INFINITY));
    const runtime = await freshRuntime();
    await runtime.loadLanguageFonts('en');
    await runIdle();
    const scRequests = () => sheets.requests.filter((id) => id === 'font-noto-sc').length;
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });

    await vi.advanceTimersByTimeAsync(FONT_SHEET_RETRY_DELAY_MS * (FONT_SHEET_RETRY_LIMIT + 2));
    await runIdle();
    expect(scRequests()).toBe(1);

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(scRequests()).toBe(2);
    // The offline time used none of the timer retries.
    for (let retry = 1; retry <= FONT_SHEET_RETRY_LIMIT; retry += 1) {
      await vi.advanceTimersByTimeAsync(FONT_SHEET_RETRY_DELAY_MS);
      await runIdle();
    }
    expect(scRequests()).toBe(2 + FONT_SHEET_RETRY_LIMIT);
  });

  it('gives up an attempt that never settles at the deadline and retries the sheet later', async () => {
    useFakeTimers();
    let hang = true;
    sheets.behaviour.set('font-noto-tc', () =>
      hang ? new Promise<void>(() => undefined) : Promise.resolve(),
    );
    const runtime = await freshRuntime();
    await runtime.loadLanguageFonts('en');
    await runIdle();
    const tcRequests = () => sheets.requests.filter((id) => id === 'font-noto-tc').length;
    let phaseBSettled = false;
    window.__MUSIXQUARE_FONTS_SETTLED__?.then(
      () => {
        phaseBSettled = true;
      },
      () => undefined,
    );

    await vi.advanceTimersByTimeAsync(FONT_SHEET_ATTEMPT_TIMEOUT_MS - 1);
    expect(sheets.abandoned).toEqual([]);
    expect(phaseBSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sheets.abandoned).toEqual(['font-noto-tc']);
    // One stalled sheet no longer holds phase B open.
    expect(phaseBSettled).toBe(true);

    hang = false;
    await vi.advanceTimersByTimeAsync(FONT_SHEET_RETRY_DELAY_MS);
    await runIdle();
    expect(tcRequests()).toBe(2);
    // A declared sheet is never requested again.
    await runtime.loadLanguageFonts('zh-hant');
    expect(tcRequests()).toBe(2);
  });

  it('doubles the deadline of each later attempt of a sheet, up to a cap', async () => {
    // A slow but working connection (slow-2g) needs longer than the first
    // deadline for the larger sheets; a fixed deadline would never let it finish.
    useFakeTimers();
    sheets.behaviour.set('font-noto-kr', () => new Promise<void>(() => undefined));
    const runtime = await freshRuntime();
    const deadlines: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      runtime.loadLanguageFonts('ko').catch(() => undefined);
      await settle();
      const abandonedBefore = sheets.abandoned.length;
      let waited = 0;
      while (sheets.abandoned.length === abandonedBefore && waited < 600_000) {
        await vi.advanceTimersByTimeAsync(1_000);
        waited += 1_000;
      }
      deadlines.push(waited);
    }

    const first = FONT_SHEET_ATTEMPT_TIMEOUT_MS;
    const cap = FONT_SHEET_ATTEMPT_TIMEOUT_MAX_MS;
    expect(cap).toBeGreaterThan(first);
    expect(deadlines).toEqual(
      Array.from({ length: 6 }, (_, attempt) => Math.min(first * 2 ** attempt, cap)),
    );
  });

  it('shares one stalled attempt until its deadline, then lets an explicit request try again', async () => {
    useFakeTimers();
    sheets.behaviour.set('font-noto-kr', () => new Promise<void>(() => undefined));
    const runtime = await freshRuntime();
    runtime.loadLanguageFonts('ko').catch(() => undefined);
    runtime.loadLanguageFonts('en').catch(() => undefined);
    await settle();
    const krRequests = () => sheets.requests.filter((id) => id === 'font-noto-kr').length;
    expect(krRequests()).toBe(1);

    await vi.advanceTimersByTimeAsync(FONT_SHEET_ATTEMPT_TIMEOUT_MS);
    sheets.behaviour.delete('font-noto-kr');
    runtime.loadLanguageFonts('ko').catch(() => undefined);
    await settle();

    expect(krRequests()).toBe(2);
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

describe("phase C: idle prefetch of the UI language's frequent shards", () => {
  /** A face of the document's font set as phase C reads it. */
  interface FaceStub {
    readonly family: string;
    readonly unicodeRange: string;
    status: FontFaceLoadStatus;
  }

  interface FontSetStub {
    readonly load: ReturnType<typeof vi.fn<(font: string, text?: string) => Promise<FontFace[]>>>;
    readonly check: ReturnType<typeof vi.fn<(font: string, text?: string) => boolean>>;
    /** The faces the set iterates, like the CSS-connected faces of the app sheets. */
    readonly faces: FaceStub[];
    /** Finish the oldest unfinished load. */
    finish(): void;
  }

  function installFontSet(options: { settleAtOnce?: boolean } = {}): FontSetStub {
    const unfinished: (() => void)[] = [];
    const faces: FaceStub[] = [];
    const load = vi.fn<(font: string, text?: string) => Promise<FontFace[]>>(
      () =>
        new Promise<FontFace[]>((resolve) => {
          if (options.settleAtOnce) resolve([{} as FontFace]);
          else unfinished.push(() => resolve([{} as FontFace]));
        }),
    );
    const check = vi.fn<(font: string, text?: string) => boolean>(() => false);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load, check, [Symbol.iterator]: () => faces[Symbol.iterator]() },
    });
    return {
      load,
      check,
      faces,
      finish() {
        unfinished.shift()?.();
      },
    };
  }

  const KO = FONT_PREFETCH_BY_LANGUAGE.ko!;
  const JA = FONT_PREFETCH_BY_LANGUAGE.ja!;
  const samplesOf = (shards: readonly { sample: string }[]) =>
    shards.map(({ sample }) => sample).join('');

  /** Phase A and B for a UI language, leaving phase C in its quiet period. */
  async function throughPhaseB(code: LanguageCode) {
    useFakeTimers();
    const runtime = await freshRuntime();
    await runtime.loadLanguageFonts(code);
    await runIdle();
    return runtime;
  }

  it('starts after the quiet period and loads one batch per idle slice, waiting for each', async () => {
    const fonts = installFontSet();
    await throughPhaseB('ko');

    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS - 1);
    expect(pendingIdle()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pendingIdle()).toHaveLength(1);
    // An idle slice without a timeout: the prefetch never forces its way in.
    expect(pendingIdle()[0]?.options).toBeUndefined();

    const batches: string[] = [];
    for (let start = 0; start < KO.shards.length; start += FONT_PREFETCH_BATCH_FACES) {
      await runIdle();
      expect(fonts.load).toHaveBeenCalledTimes(batches.length + 1);
      const [font, text] = fonts.load.mock.calls.at(-1) ?? [];
      expect(font).toBe('400 16px "Noto Sans KR"');
      batches.push(text ?? '');
      expect(pendingIdle()).toHaveLength(0);
      fonts.finish();
      await settle();
    }

    expect(batches).toEqual(
      Array.from({ length: Math.ceil(KO.shards.length / FONT_PREFETCH_BATCH_FACES) }, (_, index) =>
        samplesOf(
          KO.shards.slice(
            index * FONT_PREFETCH_BATCH_FACES,
            (index + 1) * FONT_PREFETCH_BATCH_FACES,
          ),
        ),
      ),
    );
    expect(pendingIdle()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS * 3);
    expect(pendingIdle()).toHaveLength(0);
    expect(fonts.load).toHaveBeenCalledTimes(batches.length);
  });

  it('skips faces the page already loaded, read from the faces themselves', async () => {
    const fonts = installFontSet({ settleAtOnce: true });
    // Chromium answers check() with true for a face that has not loaded (the
    // local font identity E2E measured it), so it cannot tell what is loaded.
    fonts.check.mockReturnValue(true);
    const codePoint = (shard: { sample: string }) =>
      (shard.sample.codePointAt(0) ?? 0).toString(16).toUpperCase();
    // Each shard's face declares its sample among other letters; the first has loaded.
    for (const [index, shard] of KO.shards.entries()) {
      fonts.faces.push({
        family: '"Noto Sans KR"',
        unicodeRange: `U+0041-005A, U+${codePoint(shard)}, U+E000-E00${index % 10}`,
        status: index === 0 ? 'loaded' : 'unloaded',
      });
    }
    // Another family declaring the same letters never counts.
    fonts.faces.unshift({
      family: 'Noto Sans JP',
      unicodeRange: KO.shards.map((shard) => `U+${codePoint(shard)}`).join(', '),
      status: 'loaded',
    });
    await throughPhaseB('ko');
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);

    await runIdle();

    expect(fonts.load.mock.calls[0]?.[1]).toBe(
      samplesOf(KO.shards.slice(1, 1 + FONT_PREFETCH_BATCH_FACES)),
    );
  });

  it('prefetches a shard whose face the page has not declared yet', async () => {
    const fonts = installFontSet({ settleAtOnce: true });
    fonts.check.mockReturnValue(true);
    await throughPhaseB('ko');
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);

    await runIdle();

    expect(fonts.load.mock.calls[0]?.[1]).toBe(
      samplesOf(KO.shards.slice(0, FONT_PREFETCH_BATCH_FACES)),
    );
  });

  it.each([
    ['face', 30, 1_000, FONT_PREFETCH_MAX_FACES],
    ['byte', 30, 60_000, Math.floor(FONT_PREFETCH_MAX_BYTES / 60_000)],
  ])('stops at the %s cap', async (_cap, count, bytes, expected) => {
    vi.doMock('../font-prefetch-samples.ts', () => ({
      FONT_PREFETCH_BY_LANGUAGE: {
        ko: {
          family: 'Noto Sans KR',
          shards: Array.from({ length: count }, (_, index) => ({
            shard: 119 - index,
            sample: String.fromCodePoint(0xac00 + index),
            bytes,
          })),
        },
      },
    }));
    const fonts = installFontSet({ settleAtOnce: true });
    await throughPhaseB('ko');
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);

    for (let slice = 0; slice < count; slice += 1) await runIdle();

    const requested = fonts.load.mock.calls.flatMap(([, text]) => [...(text ?? '')]);
    expect(requested).toHaveLength(expected);
  });

  it.each([
    [
      'data saver',
      () =>
        Object.defineProperty(navigator, 'connection', {
          configurable: true,
          value: { saveData: true },
        }),
    ],
    [
      'slow-2g',
      () =>
        Object.defineProperty(navigator, 'connection', {
          configurable: true,
          value: { effectiveType: 'slow-2g' },
        }),
    ],
    [
      '2g',
      () =>
        Object.defineProperty(navigator, 'connection', {
          configurable: true,
          value: { effectiveType: '2g' },
        }),
    ],
    [
      'offline',
      () => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }),
    ],
  ])('skips the whole pass with %s', async (_condition, apply) => {
    apply();
    const fonts = installFontSet({ settleAtOnce: true });
    await throughPhaseB('ko');
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);
    await runIdle();
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_IDLE_FALLBACK_MS * 4);

    expect(fonts.load).not.toHaveBeenCalled();
  });

  it('enters its quiet period once its own sheet is declared, even while another sheet stalls', async () => {
    const fonts = installFontSet({ settleAtOnce: true });
    sheets.behaviour.set('font-noto-tc', () => new Promise<void>(() => undefined));
    await throughPhaseB('ko');

    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);
    await runIdle();

    expect(fonts.load.mock.calls[0]?.[0]).toBe('400 16px "Noto Sans KR"');
  });

  it('prefetches nothing for a UI without a list', async () => {
    const fonts = installFontSet({ settleAtOnce: true });
    await throughPhaseB('en');
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS * 2);

    expect(pendingIdle()).toHaveLength(0);
    expect(fonts.load).not.toHaveBeenCalled();
  });

  it('uses a timer chain where requestIdleCallback is missing', async () => {
    removeIdleCallbacks();
    const fonts = installFontSet({ settleAtOnce: true });
    useFakeTimers();
    const runtime = await freshRuntime();
    await runtime.loadLanguageFonts('ko');
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);
    expect(fonts.load).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_IDLE_FALLBACK_MS - 1);
    expect(fonts.load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fonts.load).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_IDLE_FALLBACK_MS);
    expect(fonts.load).toHaveBeenCalledTimes(2);
  });

  it('pauses while hidden and resumes with a fresh idle slice when visible', async () => {
    const fonts = installFontSet();
    await throughPhaseB('ko');
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);
    expect(pendingIdle()).toHaveLength(1);

    setVisibility('hidden');
    expect(pendingIdle()).toHaveLength(0);
    setVisibility('visible');
    expect(pendingIdle()).toHaveLength(1);

    await runIdle();
    setVisibility('hidden');
    fonts.finish();
    await settle();
    expect(pendingIdle()).toHaveLength(0);
    setVisibility('visible');
    expect(pendingIdle()).toHaveLength(1);
  });

  it('starts a new list when the language changes, within the same page budget', async () => {
    const fonts = installFontSet();
    const runtime = await throughPhaseB('ko');
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);
    await runIdle();
    expect(fonts.load.mock.calls[0]?.[0]).toBe('400 16px "Noto Sans KR"');

    await runtime.loadLanguageFonts('ja');
    fonts.finish();
    await settle();
    await runIdle();

    expect(fonts.load.mock.calls[1]).toEqual([
      '400 16px "Noto Sans JP"',
      samplesOf(JA.shards.slice(0, FONT_PREFETCH_BATCH_FACES)),
    ]);
    // The page budget counts every prefetched face across languages.
    for (let slice = 0; slice < 20; slice += 1) {
      fonts.finish();
      await settle();
      await runIdle();
    }
    const requested = fonts.load.mock.calls.flatMap(([, text]) => [...(text ?? '')]);
    expect(requested.length).toBeLessThanOrEqual(FONT_PREFETCH_MAX_FACES);
  });

  it('stops at pagehide and resumes from the back-forward cache', async () => {
    const fonts = installFontSet({ settleAtOnce: true });
    await throughPhaseB('ko');

    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS * 2);
    expect(pendingIdle()).toHaveLength(0);

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);
    expect(pendingIdle()).toHaveLength(1);
    await runIdle();
    expect(fonts.load).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event('pagehide'));
    expect(pendingIdle()).toHaveLength(0);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(pendingIdle()).toHaveLength(1);
  });

  it('runs one pass per page load', async () => {
    const fonts = installFontSet({ settleAtOnce: true });
    const runtime = await throughPhaseB('ko');
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);
    for (let slice = 0; slice < KO.shards.length; slice += 1) await runIdle();
    const calls = fonts.load.mock.calls.length;
    expect(calls).toBe(Math.ceil(KO.shards.length / FONT_PREFETCH_BATCH_FACES));

    await runtime.loadLanguageFonts('ko');
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS * 2);
    await runIdle();

    expect(fonts.load).toHaveBeenCalledTimes(calls);
  });

  /**
   * The Noto Sans KR faces in their sheet's order, after a few faces of
   * another family, with every unicode-range read counted.
   */
  function installCountingFontSet() {
    let reads = 0;
    const counted = (family: string, range: string) => {
      const face = { family, status: 'unloaded' as FontFaceLoadStatus };
      Object.defineProperty(face, 'unicodeRange', {
        get: () => {
          reads += 1;
          return range;
        },
      });
      return face;
    };
    const css = readFileSync('css/fonts/app/font-noto-kr.css', 'utf8');
    const ranges = [...css.matchAll(/unicode-range:\s*([^;]+);/gu)].map((match) =>
      (match[1] ?? '').trim(),
    );
    expect(ranges.length).toBeGreaterThan(KO.shards.length);
    const faces = [
      ...Array.from({ length: 7 }, () => counted('Inter', 'U+0000-00FF')),
      ...ranges.map((range) => counted('"Noto Sans KR"', range)),
    ];
    const load = vi.fn((_font: string, _text?: string) => Promise.resolve([{} as FontFace]));
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load, check: vi.fn(() => false), [Symbol.iterator]: () => faces[Symbol.iterator]() },
    });
    return { load, reads: () => reads };
  }

  it('reads at most one unicode-range per shard over a whole pass, and none outside an idle slice', async () => {
    const fonts = installCountingFontSet();
    await throughPhaseB('ko');

    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);
    // The quiet period ends in a plain timer task, which only arms an idle slice.
    expect(pendingIdle()).toHaveLength(1);
    expect(fonts.reads()).toBe(0);

    for (let slice = 0; slice < KO.shards.length; slice += 1) await runIdle();

    expect(fonts.load).toHaveBeenCalledTimes(
      Math.ceil(KO.shards.length / FONT_PREFETCH_BATCH_FACES),
    );
    expect(fonts.reads()).toBeLessThanOrEqual(KO.shards.length);
  });

  it("waits for its family's sheet and prefetches once a retry declares it", async () => {
    const fonts = installFontSet({ settleAtOnce: true });
    sheets.behaviour.set('font-noto-kr', failing(2));
    await throughPhaseB('ko');
    const krRequests = () => sheets.requests.filter((id) => id === 'font-noto-kr').length;
    expect(krRequests()).toBe(2);

    await vi.advanceTimersByTimeAsync(Math.max(FONT_PREFETCH_QUIET_MS, FONT_SHEET_RETRY_DELAY_MS));
    await runIdle();
    expect(krRequests()).toBe(3);
    expect(fonts.load).not.toHaveBeenCalled();

    await runIdle();
    expect(fonts.load.mock.calls[0]).toEqual([
      '400 16px "Noto Sans KR"',
      samplesOf(KO.shards.slice(0, FONT_PREFETCH_BATCH_FACES)),
    ]);
  });

  it('releases the budget of a batch that drew no face and waits until asked again', async () => {
    const fonts = installFontSet({ settleAtOnce: true });
    fonts.load.mockResolvedValueOnce([]);
    const runtime = await throughPhaseB('ko');
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);

    await runIdle();
    await settle();
    expect(fonts.load).toHaveBeenCalledOnce();
    expect(pendingIdle()).toHaveLength(0);

    await runtime.loadLanguageFonts('ko');
    for (let slice = 0; slice < KO.shards.length; slice += 1) await runIdle();

    expect(fonts.load.mock.calls[1]?.[1]).toBe(fonts.load.mock.calls[0]?.[1]);
    const requested = fonts.load.mock.calls.slice(1).flatMap(([, text]) => [...(text ?? '')]);
    expect(requested).toEqual([...samplesOf(KO.shards)]);
  });

  it('never touches CacheStorage', async () => {
    const cacheStorage = {
      open: vi.fn(),
      match: vi.fn(),
      has: vi.fn(),
      keys: vi.fn(),
      delete: vi.fn(),
    };
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: cacheStorage });
    installFontSet({ settleAtOnce: true });
    await throughPhaseB('ko');
    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);
    for (let slice = 0; slice < KO.shards.length; slice += 1) await runIdle();

    for (const method of Object.values(cacheStorage)) expect(method).not.toHaveBeenCalled();
  });
});

describe('failed face recovery', () => {
  // A WOFF2 download that fails leaves its CSS-connected face in 'error' for
  // the life of the document; the browser never fetches it again. Declaring
  // the sheet again gives the browser fresh faces to fetch on demand.
  interface FaceStub {
    readonly family: string;
    readonly unicodeRange: string;
    status: FontFaceLoadStatus;
  }

  function installFaces(
    faces: FaceStub[],
    load: (font: string, text?: string) => Promise<FontFace[]> = () => Promise.resolve([]),
  ): void {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        load: vi.fn(load),
        check: vi.fn(() => false),
        [Symbol.iterator]: () => faces[Symbol.iterator](),
      },
    });
  }

  const FAILED_INTER: FaceStub = { family: 'Inter', unicodeRange: 'U+0000-00FF', status: 'error' };

  async function declaredEverywhere(code: LanguageCode = 'en'): Promise<Runtime> {
    useFakeTimers();
    const runtime = await freshRuntime();
    await runtime.loadLanguageFonts(code);
    await runIdle();
    return runtime;
  }

  it.each([
    ['the browser comes back online', () => window.dispatchEvent(new Event('online'))],
    [
      'the page becomes visible',
      () => {
        setVisibility('hidden');
        setVisibility('visible');
      },
    ],
    [
      'the page comes back from the back-forward cache',
      () => {
        window.dispatchEvent(new Event('pagehide'));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      },
    ],
  ])(
    'declares a sheet again once when one of its faces failed, when %s',
    async (_when, trigger) => {
      installFaces([
        { family: '"Noto Sans KR"', unicodeRange: 'U+AC00', status: 'loaded' },
        { ...FAILED_INTER },
        { family: 'Inter', unicodeRange: 'U+0100-024F', status: 'error' },
      ]);
      await declaredEverywhere();

      trigger();
      await settle();

      expect(sheets.redeclared).toEqual(['font-inter']);
    },
  );

  it('declares nothing again while every face has loaded or is not needed yet', async () => {
    installFaces([
      { family: 'Inter', unicodeRange: 'U+0000-00FF', status: 'loaded' },
      { family: 'Noto Sans KR', unicodeRange: 'U+AC00', status: 'unloaded' },
      { family: 'Noto Sans JP', unicodeRange: 'U+3041', status: 'loading' },
    ]);
    await declaredEverywhere();

    window.dispatchEvent(new Event('online'));
    setVisibility('visible');
    await settle();

    expect(sheets.redeclared).toEqual([]);
  });

  it('declares a sheet again at most FONT_SHEET_RETRY_LIMIT times per page', async () => {
    installFaces([{ ...FAILED_INTER }]);
    await declaredEverywhere();

    for (let event = 0; event < FONT_SHEET_RETRY_LIMIT + 2; event += 1) {
      window.dispatchEvent(new Event('online'));
      await settle();
    }

    expect(sheets.redeclared).toEqual(Array(FONT_SHEET_RETRY_LIMIT).fill('font-inter'));
  });

  it('leaves a sheet that is not declared to the sheet retries', async () => {
    installFaces([{ ...FAILED_INTER }]);
    sheets.behaviour.set('font-inter', failing(Number.POSITIVE_INFINITY));
    await declaredEverywhere();

    window.dispatchEvent(new Event('online'));
    await settle();

    expect(sheets.redeclared).toEqual([]);
  });

  it('declares its family again after a rejected phase C batch', async () => {
    installFaces([{ family: 'Noto Sans KR', unicodeRange: 'U+AC00-D7A3', status: 'error' }], () =>
      Promise.reject(new Error('NetworkError')),
    );
    await declaredEverywhere('ko');
    expect(sheets.redeclared).toEqual([]);

    await vi.advanceTimersByTimeAsync(FONT_PREFETCH_QUIET_MS);
    await runIdle();
    await settle();

    expect(sheets.redeclared).toEqual(['font-noto-kr']);
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

/**
 * The app's font owner: the only code that loads the app's font sheets
 * (src/i18n/app-font-contract.ts) and asks the browser for their faces. The
 * static pages load their own sheets through static-page-fonts.ts.
 *
 * Importing a sheet only declares its @font-face rules; the browser fetches a
 * WOFF2 shard when text needs one of its glyphs. Every family is declared in
 * every UI, so the same text is drawn by the same faces whatever the UI
 * language, and the phases only decide how early each sheet is declared:
 *
 * - Phase A, when a language applies (i18n/index.ts): Inter, the UI's own
 *   script sheet and the first family of the UI's Han order. The Korean and
 *   English UIs therefore declare the same sheets at the same moment.
 * - Phase B, after window load and the first idle slice: every other sheet.
 *   It ignores data saver because it is correctness, not prefetch.
 *
 * A failed sheet is retried on 'online' or on a later visible idle slice, a
 * bounded number of times (font-loading-policy.ts holds the values). Explicit
 * requests (a language change, the language picker) try a failed sheet again
 * at once. pagehide stops every pending timer and idle callback, and a page
 * restored from the back-forward cache resumes what was left.
 *
 * The first request also applies the startup Han order (startup-han-order.ts)
 * as html[data-mxqr-han-order], once per page.
 */

import { log } from '../core/log.ts';
import {
  APP_FONT_SHEETS,
  HAN_ORDER_FONT_SHEET,
  SCRIPT_FONT_SHEET_BY_LANGUAGE,
  type AppFontSheetId,
} from './app-font-contract.ts';
import {
  FONT_SHEETS_IDLE_TIMEOUT_MS,
  FONT_SHEET_RETRY_DELAY_MS,
  FONT_SHEET_RETRY_LIMIT,
} from './font-loading-policy.ts';
import { resolveHanOrder, type HanOrder } from './startup-han-order.ts';
import type { LanguageCode } from './locales.ts';
import { createRetryableStylesheet } from './retryable-stylesheet.ts';

type SheetLoader = () => Promise<unknown>;

// One literal dynamic import per sheet, so the build emits each as its own
// lazy CSS chunk. locale-fonts.test.ts pins these paths to the contract.
const SHEET_LOADERS: Readonly<Record<AppFontSheetId, SheetLoader>> = {
  'font-inter': createRetryableStylesheet(
    'font-inter',
    () => import('../../css/fonts/app/font-inter.css'),
  ),
  'font-noto-kr': createRetryableStylesheet(
    'font-noto-kr',
    () => import('../../css/fonts/app/font-noto-kr.css'),
  ),
  'font-noto-jp': createRetryableStylesheet(
    'font-noto-jp',
    () => import('../../css/fonts/app/font-noto-jp.css'),
  ),
  'font-noto-sc': createRetryableStylesheet(
    'font-noto-sc',
    () => import('../../css/fonts/app/font-noto-sc.css'),
  ),
  'font-noto-tc': createRetryableStylesheet(
    'font-noto-tc',
    () => import('../../css/fonts/app/font-noto-tc.css'),
  ),
  'font-noto-thai': createRetryableStylesheet(
    'font-noto-thai',
    () => import('../../css/fonts/app/font-noto-thai.css'),
  ),
  'noto-arabic': createRetryableStylesheet(
    'noto-arabic',
    () => import('../../css/fonts/noto-arabic.css'),
  ),
  'noto-hebrew': createRetryableStylesheet(
    'noto-hebrew',
    () => import('../../css/fonts/noto-hebrew.css'),
  ),
  'noto-devanagari': createRetryableStylesheet(
    'noto-devanagari',
    () => import('../../css/fonts/noto-devanagari.css'),
  ),
  'noto-bengali': createRetryableStylesheet(
    'noto-bengali',
    () => import('../../css/fonts/noto-bengali.css'),
  ),
  'noto-tamil': createRetryableStylesheet(
    'noto-tamil',
    () => import('../../css/fonts/noto-tamil.css'),
  ),
  'noto-telugu': createRetryableStylesheet(
    'noto-telugu',
    () => import('../../css/fonts/noto-telugu.css'),
  ),
  'noto-gujarati': createRetryableStylesheet(
    'noto-gujarati',
    () => import('../../css/fonts/noto-gujarati.css'),
  ),
  'noto-kannada': createRetryableStylesheet(
    'noto-kannada',
    () => import('../../css/fonts/noto-kannada.css'),
  ),
  'noto-malayalam': createRetryableStylesheet(
    'noto-malayalam',
    () => import('../../css/fonts/noto-malayalam.css'),
  ),
  'noto-gurmukhi': createRetryableStylesheet(
    'noto-gurmukhi',
    () => import('../../css/fonts/noto-gurmukhi.css'),
  ),
};

const SHEET_FAMILY = new Map<AppFontSheetId, string>(
  APP_FONT_SHEETS.map(({ id, family }) => [id, family]),
);

const HAN_UI_LANGUAGES: ReadonlySet<string> = new Set<HanOrder>(['ja', 'zh-hans', 'zh-hant']);

type Cancel = () => void;

/** Run in the next idle slice, at most timeoutMs later; the next task without rIC. */
function afterIdle(callback: () => void, timeoutMs: number): Cancel {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(() => callback(), { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(callback, 0);
  return () => window.clearTimeout(handle);
}

function afterDelay(callback: () => void, delayMs: number): Cancel {
  const handle = window.setTimeout(callback, delayMs);
  return () => window.clearTimeout(handle);
}

function isPageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

// ─── Sheets ─────────────────────────────────────────────────────────

interface SheetState {
  loaded: boolean;
  failed: boolean;
  inFlight: Promise<boolean> | null;
  automaticRetries: number;
}

const sheetStates = new Map<AppFontSheetId, SheetState>(
  APP_FONT_SHEETS.map(({ id }) => [
    id,
    { loaded: false, failed: false, inFlight: null, automaticRetries: 0 },
  ]),
);

function sheetState(id: AppFontSheetId): SheetState {
  const state = sheetStates.get(id);
  if (!state) throw new Error(`Unknown app font sheet: ${id}`);
  return state;
}

/**
 * Resolve true once the sheet's rules are declared, false after a failure.
 * Concurrent callers share one attempt; a loaded sheet is never fetched again.
 */
function loadSheet(id: AppFontSheetId): Promise<boolean> {
  const state = sheetState(id);
  if (state.loaded) return Promise.resolve(true);
  if (state.inFlight) return state.inFlight;

  const attempt = SHEET_LOADERS[id]()
    .then(
      () => true,
      (error: unknown) => {
        log.warn(`[i18n] Failed to load the font sheet "${id}"`, error);
        return false;
      },
    )
    .then((declared) => {
      state.inFlight = null;
      state.loaded = declared;
      state.failed = !declared;
      if (!declared) armRetry();
      return declared;
    });
  state.inFlight = attempt;
  return attempt;
}

/** Load sheets in the background, then run onSettled; loadSheet never rejects. */
function declareSheets(ids: readonly AppFontSheetId[], onSettled?: () => void): void {
  Promise.all(ids.map((id) => loadSheet(id)))
    .then(() => onSettled?.())
    .catch((error: unknown) => {
      log.warn('[i18n] Font sheet bookkeeping failed', error);
    });
}

// ─── Retry ──────────────────────────────────────────────────────────

let cancelRetry: Cancel | null = null;
let retryWaitsForVisibility = false;

function retryableSheets(): AppFontSheetId[] {
  return APP_FONT_SHEETS.map(({ id }) => id).filter((id) => {
    const state = sheetState(id);
    return state.failed && !state.inFlight && state.automaticRetries < FONT_SHEET_RETRY_LIMIT;
  });
}

function armRetry(): void {
  if (cancelRetry || retryWaitsForVisibility || retryableSheets().length === 0) return;
  cancelRetry = afterDelay(() => {
    cancelRetry = null;
    if (!isPageVisible()) {
      retryWaitsForVisibility = true;
      return;
    }
    cancelRetry = afterIdle(() => {
      cancelRetry = null;
      retryFailedSheets();
    }, FONT_SHEETS_IDLE_TIMEOUT_MS);
  }, FONT_SHEET_RETRY_DELAY_MS);
}

function retryFailedSheets(): void {
  cancelRetry?.();
  cancelRetry = null;
  retryWaitsForVisibility = false;
  const retrying = retryableSheets();
  for (const id of retrying) sheetState(id).automaticRetries += 1;
  declareSheets(retrying);
}

// ─── Han order ──────────────────────────────────────────────────────

let startupHanOrder: HanOrder | null = null;

function applyStartupHanOrder(): HanOrder {
  if (startupHanOrder) return startupHanOrder;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
  startupHanOrder = resolveHanOrder(languages);
  if (startupHanOrder !== 'ko') {
    document.documentElement.setAttribute('data-mxqr-han-order', startupHanOrder);
  }
  return startupHanOrder;
}

function phaseASheets(code: LanguageCode, hanOrder: HanOrder): AppFontSheetId[] {
  const uiHanOrder = HAN_UI_LANGUAGES.has(code) ? (code as HanOrder) : hanOrder;
  const sheets: AppFontSheetId[] = ['font-inter'];
  for (const id of [SCRIPT_FONT_SHEET_BY_LANGUAGE[code], HAN_ORDER_FONT_SHEET[uiHanOrder]]) {
    if (id && !sheets.includes(id)) sheets.push(id);
  }
  return sheets;
}

// ─── Phase B ────────────────────────────────────────────────────────

type PhaseB = 'waiting' | 'running' | 'done';

let phaseB: PhaseB = 'waiting';
let cancelPhaseB: Cancel | null = null;
let resolveSettled!: () => void;
const settled = new Promise<void>((resolve) => {
  resolveSettled = resolve;
});

function armPhaseB(): void {
  if (phaseB !== 'waiting' || cancelPhaseB) return;
  if (document.readyState === 'complete') {
    cancelPhaseB = afterIdle(runPhaseB, FONT_SHEETS_IDLE_TIMEOUT_MS);
    return;
  }
  const onLoad = () => {
    cancelPhaseB = null;
    armPhaseB();
  };
  window.addEventListener('load', onLoad, { once: true });
  cancelPhaseB = () => window.removeEventListener('load', onLoad);
}

function runPhaseB(): void {
  cancelPhaseB = null;
  if (phaseB !== 'waiting') return;
  phaseB = 'running';
  declareSheets(
    APP_FONT_SHEETS.map(({ id }) => id),
    () => {
      phaseB = 'done';
      resolveSettled();
    },
  );
}

// ─── Lifecycle ──────────────────────────────────────────────────────

let started = false;

function suspend(): void {
  cancelPhaseB?.();
  cancelPhaseB = null;
  if (cancelRetry) {
    cancelRetry();
    cancelRetry = null;
    retryWaitsForVisibility = true;
  }
}

function resume(): void {
  armPhaseB();
  if (retryWaitsForVisibility && isPageVisible()) {
    retryWaitsForVisibility = false;
    armRetryNow();
  }
}

function armRetryNow(): void {
  if (cancelRetry || retryableSheets().length === 0) return;
  cancelRetry = afterIdle(() => {
    cancelRetry = null;
    retryFailedSheets();
  }, FONT_SHEETS_IDLE_TIMEOUT_MS);
}

function start(): HanOrder {
  const hanOrder = applyStartupHanOrder();
  if (started) return hanOrder;
  started = true;
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) resume();
  });
  window.addEventListener('online', () => {
    if (retryableSheets().length > 0) retryFailedSheets();
  });
  document.addEventListener('visibilitychange', () => {
    if (!isPageVisible() || !retryWaitsForVisibility) return;
    retryWaitsForVisibility = false;
    armRetryNow();
  });
  armPhaseB();
  return hanOrder;
}

// ─── Phase A ────────────────────────────────────────────────────────

/**
 * Phase A for a UI language. Resolves once its sheets are declared or have
 * failed; never rejects, so a stalled sheet cannot hold the UI.
 */
function loadLanguageFonts(code: LanguageCode): Promise<void> {
  const hanOrder = start();
  return Promise.all(phaseASheets(code, hanOrder).map((id) => loadSheet(id))).then(() => undefined);
}

// ─── Glyph warming ──────────────────────────────────────────────────

const loadedGlyphCharacters = new Map<AppFontSheetId, Set<string>>();
const inFlightGlyphCharacters = new Map<AppFontSheetId, Map<string, Promise<boolean>>>();
const inFlightGlyphSamples = new Map<string, Promise<boolean>>();
const MAX_TRACKED_GLYPH_CHARACTERS_PER_SHEET = 4_096;

/**
 * Load only the unicode-range shards needed to render a known piece of text.
 * Declaring a sheet does not fetch a shard for hidden UI; FontFaceSet.load()
 * performs that final glyph request without making the caller wait to render.
 */
function preloadSheetGlyphs(id: AppFontSheetId, text: string): Promise<boolean> {
  const sample = text.trim();
  if (!sample) return loadSheet(id);

  const cacheKey = `${id}\u0000${sample}`;
  const existing = inFlightGlyphSamples.get(cacheKey);
  if (existing) return existing;

  const loaded = loadedGlyphCharacters.get(id) ?? new Set<string>();
  if (!loadedGlyphCharacters.has(id)) loadedGlyphCharacters.set(id, loaded);
  const characterTasks = inFlightGlyphCharacters.get(id) ?? new Map<string, Promise<boolean>>();
  if (!inFlightGlyphCharacters.has(id)) inFlightGlyphCharacters.set(id, characterTasks);

  const uniqueCharacters = [
    ...new Set(Array.from(sample).filter((character) => !/\s/u.test(character))),
  ];
  const sharedTasks = new Set<Promise<boolean>>();
  const freshCharacters: string[] = [];
  for (const character of uniqueCharacters) {
    if (loaded.has(character)) continue;
    const characterTask = characterTasks.get(character);
    if (characterTask) sharedTasks.add(characterTask);
    else freshCharacters.push(character);
  }

  if (freshCharacters.length > 0) {
    const freshSample = freshCharacters.join('');
    const freshTask = loadSheet(id)
      .then(async (declared) => {
        // loadSheet resolves false after a failed CSS request so rendering is
        // never blocked. Keep these characters retryable then.
        if (!declared) return false;

        const fontSet = typeof document === 'undefined' ? undefined : document.fonts;
        if (fontSet && typeof fontSet.load === 'function') {
          const faces = await fontSet.load(`700 15px "${SHEET_FAMILY.get(id)}"`, freshSample);
          if (faces.length === 0) return false;
        }

        // Older browsers fetch the shard naturally once text renders. Track
        // code points, not whole inputs, so the cache stays bounded.
        for (const character of freshCharacters) {
          loaded.delete(character);
          loaded.add(character);
          while (loaded.size > MAX_TRACKED_GLYPH_CHARACTERS_PER_SHEET) {
            const oldest = loaded.values().next().value;
            if (oldest === undefined) break;
            loaded.delete(oldest);
          }
        }
        return true;
      })
      .catch((error: unknown) => {
        // Glyph warming is opportunistic and must never delay or reject a
        // render. Do not cache failures so a later request can retry.
        log.warn(`[i18n] Failed to preload font glyphs from "${id}"`, error);
        return false;
      })
      .finally(() => {
        for (const character of freshCharacters) {
          if (characterTasks.get(character) === freshTask) characterTasks.delete(character);
        }
      });
    for (const character of freshCharacters) characterTasks.set(character, freshTask);
    sharedTasks.add(freshTask);
  }

  const pending =
    sharedTasks.size === 0
      ? Promise.resolve(true)
      : Promise.all([...sharedTasks]).then((results) => results.every(Boolean));
  const tracked = pending.finally(() => {
    if (inFlightGlyphSamples.get(cacheKey) === tracked) inFlightGlyphSamples.delete(cacheKey);
  });

  inFlightGlyphSamples.set(cacheKey, tracked);
  return tracked;
}

/**
 * Warm a language's native name (the language picker) in the face that draws
 * its script: Inter for Latin, Cyrillic and Greek names, the script's own
 * sheet for every other.
 */
function preloadNativeNameGlyphs(code: LanguageCode, nativeName: string): Promise<boolean> {
  start();
  return preloadSheetGlyphs(SCRIPT_FONT_SHEET_BY_LANGUAGE[code] ?? 'font-inter', nativeName);
}

// ─── E2E test hook ──────────────────────────────────────────────────
// Resolves once phase B has declared every sheet (or given up on one), so
// layout specs can measure with the final faces. Dev / e2e build / explicit
// opt-in only, never the normal production bundle (the gate mirrors
// player/ownership.ts and is read inline from import.meta.env).
const _shouldExposeTestHooks =
  import.meta.env.DEV ||
  import.meta.env.MODE === 'e2e' ||
  import.meta.env.VITE_MUSIXQUARE_TEST_HOOKS === '1';

declare global {
  interface Window {
    __MUSIXQUARE_FONTS_SETTLED__?: Promise<void>;
  }
}

if (typeof window !== 'undefined' && _shouldExposeTestHooks) {
  window.__MUSIXQUARE_FONTS_SETTLED__ = settled;
}

const localeFontRuntime = Object.freeze({ loadLanguageFonts, preloadNativeNameGlyphs });

export default localeFontRuntime;

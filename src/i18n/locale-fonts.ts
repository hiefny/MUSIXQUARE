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
 *   script sheet, Noto Sans KR for every UI that is not Japanese or Chinese,
 *   and the first family of the UI's Han order. The Korean and English UIs
 *   therefore declare the same sheets at the same moment under every Han
 *   order.
 * - Phase B, after window load and the first idle slice: every other sheet.
 *   It ignores data saver because it is correctness, not prefetch.
 * - Phase C, a quiet period after phase B starts: the Korean, Japanese and
 *   Chinese UIs load their own family's most frequent shards
 *   (font-prefetch-samples.ts) in idle slices, a few faces per batch, within a
 *   face and byte budget per page load, so new text in those characters draws
 *   without a swap. A batch runs only once the family's sheet is declared and
 *   counts against the budget only when it drew a face. It reads faces only
 *   inside idle slices, and finds a shard's face by its place in the sheet. It
 *   is skipped on data saver, 2G or offline, pauses while the page is hidden,
 *   and follows a language change. It only asks FontFaceSet.load(); the
 *   service worker stays the only writer of CacheStorage.
 *
 * A sheet attempt that does not settle within its deadline
 * (FONT_SHEET_ATTEMPT_TIMEOUT_MS, doubled for each later attempt of the sheet)
 * is abandoned and counts as a failure. A failed sheet is retried by a timer in a
 * later visible idle slice a bounded number of times, never while the browser
 * is offline, and again at once on 'online', when the page becomes visible and
 * when it comes back from the back-forward cache, each of which grants a full
 * set of timer retries again (font-loading-policy.ts holds the values).
 * Explicit requests (a language change, the language picker) try a failed
 * sheet again at once. A face whose WOFF2 download failed stays in 'error', so
 * the same events (and a rejected phase C batch) declare its sheet again, a
 * bounded number of times. pagehide stops every pending timer and idle callback,
 * and a page restored from the back-forward cache resumes what was left.
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
} from './font-loading-policy.ts';
import { FONT_PREFETCH_BY_LANGUAGE } from './font-prefetch-samples.ts';
import { resolveHanOrder, type HanOrder } from './startup-han-order.ts';
import type { LanguageCode } from './locales.ts';
import { createRetryableStylesheet, type RetryableStylesheet } from './retryable-stylesheet.ts';

// One literal dynamic import per sheet, so the build emits each as its own
// lazy CSS chunk. locale-fonts.test.ts pins these paths to the contract.
const SHEET_LOADERS: Readonly<Record<AppFontSheetId, RetryableStylesheet>> = {
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

const FAMILY_SHEET = new Map<string, AppFontSheetId>(
  APP_FONT_SHEETS.map(({ id, family }) => [family, id]),
);

/** A FontFace family as the app's sheets name it (browsers may report it quoted). */
function faceFamily(face: FontFace): string {
  return face.family.replace(/^(['"])(.*)\1$/su, '$2');
}

const APP_SHEET_IDS: readonly AppFontSheetId[] = APP_FONT_SHEETS.map(({ id }) => id);

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
  /** Attempts started, which double each attempt's deadline. */
  attempts: number;
}

const sheetStates = new Map<AppFontSheetId, SheetState>(
  APP_FONT_SHEETS.map(({ id }) => [
    id,
    { loaded: false, failed: false, inFlight: null, automaticRetries: 0, attempts: 0 },
  ]),
);

function sheetState(id: AppFontSheetId): SheetState {
  const state = sheetStates.get(id);
  if (!state) throw new Error(`Unknown app font sheet: ${id}`);
  return state;
}

/**
 * Resolve true once the sheet's rules are declared, false after a failure or
 * when the attempt is abandoned at its deadline. Concurrent callers share one
 * attempt; a loaded sheet is never fetched again.
 */
function loadSheet(id: AppFontSheetId): Promise<boolean> {
  const state = sheetState(id);
  if (state.loaded) return Promise.resolve(true);
  if (state.inFlight) return state.inFlight;

  const loader = SHEET_LOADERS[id];
  const deadlineMs = Math.min(
    FONT_SHEET_ATTEMPT_TIMEOUT_MS * 2 ** state.attempts,
    FONT_SHEET_ATTEMPT_TIMEOUT_MAX_MS,
  );
  state.attempts += 1;
  let cancelDeadline: Cancel = () => undefined;
  const deadline = new Promise<boolean>((resolve) => {
    cancelDeadline = afterDelay(() => {
      log.warn(`[i18n] The font sheet "${id}" did not load in time; abandoning the request`);
      loader.abandon();
      resolve(false);
    }, deadlineMs);
  });
  const request = loader().then(
    () => true,
    (error: unknown) => {
      log.warn(`[i18n] Failed to load the font sheet "${id}"`, error);
      return false;
    },
  );
  const attempt = Promise.race([request, deadline]).then((declared) => {
    cancelDeadline();
    state.inFlight = null;
    state.loaded = declared;
    state.failed = !declared;
    if (declared) onSheetDeclared(id);
    else armRetry();
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
let retryWaitsForOnline = false;

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Failed sheets that may be retried now: not in flight and with timer retries left. */
function retryableSheets(): AppFontSheetId[] {
  return APP_SHEET_IDS.filter((id) => {
    const state = sheetState(id);
    return state.failed && !state.inFlight && state.automaticRetries < FONT_SHEET_RETRY_LIMIT;
  });
}

/** Arm the next timer retry: after the delay, in a visible idle slice, only while online. */
function armRetry(): void {
  if (cancelRetry || retryWaitsForVisibility || retryWaitsForOnline) return;
  if (retryableSheets().length === 0) return;
  cancelRetry = afterDelay(() => {
    cancelRetry = null;
    if (isOffline()) {
      retryWaitsForOnline = true;
      return;
    }
    if (!isPageVisible()) {
      retryWaitsForVisibility = true;
      return;
    }
    cancelRetry = afterIdle(() => {
      cancelRetry = null;
      if (isOffline()) {
        retryWaitsForOnline = true;
        return;
      }
      retryFailedSheets(true);
    }, FONT_SHEETS_IDLE_TIMEOUT_MS);
  }, FONT_SHEET_RETRY_DELAY_MS);
}

/**
 * Retry every retryable failed sheet now. Only timer retries count against
 * FONT_SHEET_RETRY_LIMIT; the fresh chances below do not.
 */
function retryFailedSheets(counted: boolean): void {
  cancelRetry?.();
  cancelRetry = null;
  retryWaitsForVisibility = false;
  retryWaitsForOnline = false;
  const retrying = retryableSheets();
  if (counted) for (const id of retrying) sheetState(id).automaticRetries += 1;
  declareSheets(retrying);
}

/**
 * A fresh chance for every failed sheet: 'online', a page becoming visible and
 * a page restored from the back-forward cache grant a full set of timer
 * retries again, so a long outage cannot leave the page in device fonts.
 */
function renewRetries(): void {
  for (const id of APP_SHEET_IDS) {
    const state = sheetState(id);
    if (state.failed) state.automaticRetries = 0;
  }
}

/** Retry failed sheets in the next idle slice, unless a retry is already armed. */
function armRetryNow(): void {
  if (cancelRetry || retryableSheets().length === 0) return;
  cancelRetry = afterIdle(() => {
    cancelRetry = null;
    if (isOffline()) {
      retryWaitsForOnline = true;
      return;
    }
    retryFailedSheets(false);
  }, FONT_SHEETS_IDLE_TIMEOUT_MS);
}

function onOnline(): void {
  retryWaitsForOnline = false;
  renewRetries();
  if (retryableSheets().length > 0) retryFailedSheets(false);
  recoverFailedFaces();
}

function onVisible(): void {
  renewRetries();
  retryWaitsForVisibility = false;
  armRetryNow();
  recoverFailedFaces();
}

// ─── Failed faces ───────────────────────────────────────────────────

const redeclarations = new Map<AppFontSheetId, number>();

/**
 * A WOFF2 download that fails leaves its CSS-connected face in 'error' for
 * the life of the document, and the browser never fetches it again. Declare
 * each loaded sheet with such a face again, once per call and at most
 * FONT_SHEET_RETRY_LIMIT times per sheet per page; the browser then fetches
 * the fresh faces on demand (from the service worker or HTTP cache, or the
 * network). Runs on 'online', a visible page, a page restored from the
 * back-forward cache and after a rejected phase C batch.
 */
function recoverFailedFaces(): void {
  if (typeof document === 'undefined' || !document.fonts) return;
  const affected = new Set<AppFontSheetId>();
  try {
    for (const face of document.fonts) {
      if (face.status !== 'error') continue;
      const id = FAMILY_SHEET.get(faceFamily(face));
      if (id) affected.add(id);
    }
  } catch {
    return;
  }
  for (const id of affected) {
    const count = redeclarations.get(id) ?? 0;
    if (!sheetState(id).loaded || count >= FONT_SHEET_RETRY_LIMIT) continue;
    if (!SHEET_LOADERS[id].redeclare()) continue;
    redeclarations.set(id, count + 1);
    shardFaces.clear();
    log.info(`[i18n] Declared the font sheet "${id}" again after a face failed to load`);
  }
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

/**
 * Inter, the UI's own script sheet, then Noto Sans KR for every UI that is not
 * Japanese or Chinese, and the first family of the UI's Han order. Noto Sans
 * KR is there whatever the Han order, so the Korean and English UIs declare
 * the same sheets: a Hangul name shown before phase B draws alike in both.
 */
function phaseASheets(code: LanguageCode, hanOrder: HanOrder): AppFontSheetId[] {
  const hanUi = HAN_UI_LANGUAGES.has(code);
  const uiHanOrder = hanUi ? (code as HanOrder) : hanOrder;
  const sheets: AppFontSheetId[] = ['font-inter'];
  for (const id of [
    SCRIPT_FONT_SHEET_BY_LANGUAGE[code],
    hanUi ? undefined : HAN_ORDER_FONT_SHEET.ko,
    HAN_ORDER_FONT_SHEET[uiHanOrder],
  ]) {
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
  // Phase C waits on its own family's sheet, not on all of phase B, so one
  // stalled sheet cannot hold the prefetch back.
  enterPhaseC();
  declareSheets(APP_SHEET_IDS, () => {
    phaseB = 'done';
    resolveSettled();
  });
}

// ─── Phase C ────────────────────────────────────────────────────────

type PrefetchList = NonNullable<(typeof FONT_PREFETCH_BY_LANGUAGE)[LanguageCode]>;
type PrefetchShard = PrefetchList['shards'][number];
type PhaseC = 'waiting' | 'quiet' | 'running' | 'done';

interface NetworkInformationLike {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

let phaseC: PhaseC = 'waiting';
let cancelPhaseC: Cancel | null = null;
let prefetchPausedForVisibility = false;
let prefetchBatchInFlight = false;
/** A batch drew no face; phase C waits until its sheet is declared or a language applies. */
let prefetchStalled = false;
/** The UI language whose list phase C follows: the last phase A request. */
let prefetchLanguage: LanguageCode | null = null;
let prefetchedFaces = 0;
let prefetchedBytes = 0;
const prefetchedShards = new Set<string>();

function canPrefetch(): boolean {
  if (typeof document === 'undefined' || typeof document.fonts?.load !== 'function') return false;
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return (
    connection?.saveData !== true &&
    connection?.effectiveType !== 'slow-2g' &&
    connection?.effectiveType !== '2g' &&
    navigator.onLine !== false
  );
}

/** Whether a unicode-range value ('U+AC00, U+AC02-AC03, U+4??') holds a code point. */
function rangeHolds(unicodeRange: string, codePoint: number): boolean {
  for (const part of unicodeRange.split(',')) {
    const match = /^\s*U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?\s*$/iu.exec(part);
    if (!match?.[1]) continue;
    const start = Number.parseInt(match[1].replace(/\?/gu, '0'), 16);
    const end = Number.parseInt(match[2] ?? match[1].replace(/\?/gu, 'F'), 16);
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}

/** The faces of a family in document order (reading each face's family only). */
function familyFaces(family: string): FontFace[] {
  const faces: FontFace[] = [];
  try {
    for (const face of document.fonts) {
      if (faceFamily(face) === family) faces.push(face);
    }
  } catch {
    return [];
  }
  return faces;
}

/** The face that declares each shard, found once per page (cleared when a sheet is declared again). */
const shardFaces = new Map<string, FontFace>();

/**
 * The face of a shard: the face at the shard's recorded place among its
 * family's faces, confirmed with that one unicode-range, and remembered. The
 * KR sheet's 120 ranges hold about 6,200 parts, so parsing every preceding
 * range for each sample was a long task on a slow phone. A scan is the
 * fallback when the faces moved (a sheet declared again, say).
 */
function shardFace(
  family: string,
  shard: PrefetchShard,
  faces: readonly FontFace[],
): FontFace | null {
  const key = `${family}#${shard.shard}`;
  const known = shardFaces.get(key);
  if (known) return known;
  const codePoint = shard.sample.codePointAt(0);
  if (codePoint === undefined) return null;
  let found: FontFace | null;
  try {
    const placed = faces[shard.face];
    found =
      placed && rangeHolds(placed.unicodeRange, codePoint)
        ? placed
        : (faces.find((face) => rangeHolds(face.unicodeRange, codePoint)) ?? null);
  } catch {
    return null;
  }
  if (found) shardFaces.set(key, found);
  return found;
}

/** The current UI language's prefetch list, if it has one. */
function currentPrefetchList(): PrefetchList | undefined {
  return prefetchLanguage ? FONT_PREFETCH_BY_LANGUAGE[prefetchLanguage] : undefined;
}

/** Whether the list's family sheet is declared, so its faces exist to load. */
function prefetchSheetDeclared(list: PrefetchList): boolean {
  const id = FAMILY_SHEET.get(list.family);
  return id !== undefined && sheetState(id).loaded;
}

/** A cheap check, without reading any face: a shard of the list is left and the face budget is not spent. */
function hasPrefetchLeft(list: PrefetchList): boolean {
  return (
    prefetchedFaces < FONT_PREFETCH_MAX_FACES &&
    list.shards.some((shard) => !prefetchedShards.has(`${list.family}#${shard.shard}`))
  );
}

/**
 * The next shards of the current list, in frequency order, that fit the page
 * budget. Whether a shard has loaded is read from its face itself:
 * FontFaceSet.check() returned true in Chromium 153 for a shard whose face had
 * not loaded (measured by e2e/font-identity.test.ts), so every shard looked
 * loaded. Runs only inside an idle slice.
 */
function nextPrefetchBatch(): { family: string; shards: PrefetchShard[] } | null {
  const list = currentPrefetchList();
  if (!list) return null;
  const faces = familyFaces(list.family);
  const shards: PrefetchShard[] = [];
  let faceCount = prefetchedFaces;
  let bytes = prefetchedBytes;
  for (const shard of list.shards) {
    if (shards.length === FONT_PREFETCH_BATCH_FACES) break;
    const key = `${list.family}#${shard.shard}`;
    if (prefetchedShards.has(key)) continue;
    if (shardFace(list.family, shard, faces)?.status === 'loaded') {
      prefetchedShards.add(key);
      continue;
    }
    if (faceCount + 1 > FONT_PREFETCH_MAX_FACES || bytes + shard.bytes > FONT_PREFETCH_MAX_BYTES) {
      break;
    }
    faceCount += 1;
    bytes += shard.bytes;
    shards.push(shard);
  }
  return shards.length > 0 ? { family: list.family, shards } : null;
}

/** An idle slice without a timeout; a timer chain where requestIdleCallback is missing. */
function afterPrefetchIdle(callback: () => void): Cancel {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(() => callback());
    return () => window.cancelIdleCallback(handle);
  }
  return afterDelay(callback, FONT_PREFETCH_IDLE_FALLBACK_MS);
}

function enterPhaseC(): void {
  if (phaseC !== 'waiting' || !canPrefetch()) return;
  phaseC = 'quiet';
  armPrefetchQuiet();
}

function armPrefetchQuiet(): void {
  if (phaseC !== 'quiet' || cancelPhaseC) return;
  cancelPhaseC = afterDelay(() => {
    cancelPhaseC = null;
    if (!canPrefetch()) {
      phaseC = 'done';
      return;
    }
    phaseC = 'running';
    schedulePrefetchBatch();
  }, FONT_PREFETCH_QUIET_MS);
}

/**
 * Arm the next batch's idle slice. This may run in any task (the quiet
 * period's timer, a batch's completion, a language change), so it reads no
 * face; the idle slice picks the batch.
 */
function schedulePrefetchBatch(): void {
  if (phaseC !== 'running' || cancelPhaseC || prefetchBatchInFlight || prefetchStalled) return;
  if (!isPageVisible()) {
    prefetchPausedForVisibility = true;
    return;
  }
  const list = currentPrefetchList();
  if (!list || !prefetchSheetDeclared(list) || !hasPrefetchLeft(list)) return;
  cancelPhaseC = afterPrefetchIdle(runPrefetchBatch);
}

function runPrefetchBatch(): void {
  cancelPhaseC = null;
  if (phaseC !== 'running') return;
  if (!isPageVisible()) {
    prefetchPausedForVisibility = true;
    return;
  }
  if (!canPrefetch()) {
    phaseC = 'done';
    return;
  }
  const list = currentPrefetchList();
  if (!list || !prefetchSheetDeclared(list)) return;
  const batch = nextPrefetchBatch();
  if (!batch) return;
  const keys = batch.shards.map(({ shard }) => `${batch.family}#${shard}`);
  const batchBytes = batch.shards.reduce((sum, { bytes }) => sum + bytes, 0);
  // Reserve the batch while it loads; a result with no face releases it.
  for (const key of keys) prefetchedShards.add(key);
  prefetchedFaces += keys.length;
  prefetchedBytes += batchBytes;
  prefetchBatchInFlight = true;
  // A FontFace load cannot be aborted, so a batch in flight always finishes.
  document.fonts
    .load(`400 16px "${batch.family}"`, batch.shards.map(({ sample }) => sample).join(''))
    .then(
      (faces) => {
        if (faces.length > 0) return;
        // No face matched: the family's faces are missing. Release the
        // reservation and wait until the sheet is declared or asked for again.
        for (const key of keys) prefetchedShards.delete(key);
        prefetchedFaces -= keys.length;
        prefetchedBytes -= batchBytes;
        prefetchStalled = true;
        log.warn(`[i18n] Font prefetch of ${batch.family} drew no face; waiting for its sheet`);
      },
      (error: unknown) => {
        log.warn(`[i18n] Font prefetch of ${batch.family} failed`, error);
        recoverFailedFaces();
      },
    )
    .then(() => {
      prefetchBatchInFlight = false;
      schedulePrefetchBatch();
    })
    .catch((error: unknown) => {
      log.warn('[i18n] Font prefetch bookkeeping failed', error);
    });
}

/** A sheet was declared: phase C may have been waiting for it. */
function onSheetDeclared(id: AppFontSheetId): void {
  const list = currentPrefetchList();
  if (!list || FAMILY_SHEET.get(list.family) !== id) return;
  prefetchStalled = false;
  schedulePrefetchBatch();
}

function suspendPrefetch(): void {
  cancelPhaseC?.();
  cancelPhaseC = null;
}

function resumePrefetch(): void {
  if (phaseC === 'quiet') armPrefetchQuiet();
  else schedulePrefetchBatch();
}

function onPrefetchVisibility(): void {
  if (!isPageVisible()) {
    if (phaseC === 'running' && cancelPhaseC) {
      cancelPhaseC();
      cancelPhaseC = null;
      prefetchPausedForVisibility = true;
    }
    return;
  }
  if (!prefetchPausedForVisibility) return;
  prefetchPausedForVisibility = false;
  schedulePrefetchBatch();
}

// ─── Lifecycle ──────────────────────────────────────────────────────

let started = false;

function suspend(): void {
  cancelPhaseB?.();
  cancelPhaseB = null;
  suspendPrefetch();
  if (cancelRetry) {
    cancelRetry();
    cancelRetry = null;
    retryWaitsForVisibility = true;
  }
}

function resume(): void {
  armPhaseB();
  resumePrefetch();
  if (isPageVisible()) onVisible();
}

function start(): HanOrder {
  const hanOrder = applyStartupHanOrder();
  if (started) return hanOrder;
  started = true;
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) resume();
  });
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', () => {
    onPrefetchVisibility();
    if (isPageVisible()) onVisible();
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
  // Phase C follows the new language: its list replaces the old one, within
  // the same page budget.
  prefetchLanguage = code;
  prefetchStalled = false;
  schedulePrefetchBatch();
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

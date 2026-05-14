/**
 * MUSIXQUARE — Toast & Loader
 *
 * Manages: Toast notifications, header loading bar.
 */

import { log } from '../core/log.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { suppressViewTransitions } from './dom.ts';

const TOAST_MAX_LINE_CHARS = 50;
const TOAST_DYNAMIC_VALUE_CHARS = 28;
const ELLIPSIS = '…';

// ─── Loader (Header Progress Bar) ────────────────────────────────

export function updateLoader(percent: number): void {
  const progressBg = document.getElementById('header-progress-bg');
  if (progressBg) {
    (progressBg as HTMLElement).style.width = `${percent}%`;
  }
}

// Ref-counted loader holders. Each unique `id` is one "hold"; the loader
// stays visible while any hold is active. Callers without an explicit id
// share a default slot — existing single-slot usage is unchanged. Callers
// that need to overlap with other flows should pass a unique id so one
// flow's hide doesn't prematurely close another flow's loader.
const _loaderHolders = new Set<string>();
const DEFAULT_LOADER_ID = '_default';

export function showLoader(show: boolean, txt?: string, id?: string): void {
  const key = id ?? DEFAULT_LOADER_ID;
  const header = document.getElementById('main-header');
  const loadingText = document.getElementById('header-loading-text');
  const progressBg = document.getElementById('header-progress-bg') as HTMLElement | null;

  if (show) {
    _loaderHolders.add(key);
    clearManagedTimer('loader-reset');
    // Suppress View Transitions while the loading CSS transition plays
    // (1s transform + buffer) to prevent snapshot-replay double-animation
    suppressViewTransitions(1200);
    header?.classList.add('loading');
    if (txt && loadingText) loadingText.innerText = txt;
    if (
      progressBg &&
      (!progressBg.style.width ||
        progressBg.style.width === '0%' ||
        progressBg.style.width === '0px')
    ) {
      progressBg.style.width = '0%';
    }
  } else {
    _loaderHolders.delete(key);
    if (_loaderHolders.size > 0) return;
    // Suppress through the reverse CSS transition as well
    suppressViewTransitions(1200);
    header?.classList.remove('loading');
    setManagedTimer(
      'loader-reset',
      () => {
        if (progressBg) progressBg.style.width = '0%';
      },
      400,
    );
  }
}

// ─── Toast ───────────────────────────────────────────────────────

function charCount(value: string): number {
  return Array.from(value).length;
}

function sliceChars(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join('');
}

function truncateValue(value: string, maxChars: number): string {
  if (charCount(value) <= maxChars) return value;

  const extension = value.match(/(\.[a-z0-9]{1,8})$/i)?.[1] || '';
  const suffixLength = charCount(extension);

  if (extension && maxChars > suffixLength + 2) {
    const headLength = maxChars - suffixLength - charCount(ELLIPSIS);
    return `${sliceChars(value, 0, headLength)}${ELLIPSIS}${extension}`;
  }

  return `${sliceChars(value, 0, Math.max(1, maxChars - charCount(ELLIPSIS)))}${ELLIPSIS}`;
}

function truncateQuotedValues(line: string): string {
  return line.replace(/"([^"]+)"/g, (match, value: string) => {
    const overhead = charCount(line) - charCount(value);
    const lineFitLimit = TOAST_MAX_LINE_CHARS - overhead;
    const valueLimit = Math.min(TOAST_DYNAMIC_VALUE_CHARS, Math.max(8, lineFitLimit));
    if (charCount(value) <= valueLimit) return match;
    return `"${truncateValue(value, valueLimit)}"`;
  });
}

function truncateColonValue(line: string): string {
  if (charCount(line) <= TOAST_MAX_LINE_CHARS) return line;

  const colonIndex = line.indexOf(': ');
  if (colonIndex < 0) return line;

  const prefix = line.slice(0, colonIndex + 2);
  const value = line.slice(colonIndex + 2);
  const remaining = TOAST_MAX_LINE_CHARS - charCount(prefix);
  if (remaining < 8) return line;

  return `${prefix}${truncateValue(value, remaining)}`;
}

function formatToastLine(line: string): string {
  let formatted = truncateQuotedValues(line);
  formatted = truncateColonValue(formatted);

  if (charCount(formatted) <= TOAST_MAX_LINE_CHARS) return formatted;
  return truncateValue(formatted, TOAST_MAX_LINE_CHARS);
}

function formatToastText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(formatToastLine)
    .join('\n');
}

export function showToast(msg: unknown): void {
  try {
    const t = document.getElementById('toast');
    const msgEl = document.getElementById('toast-msg');
    const text = msg === undefined || msg === null ? '' : String(msg);
    const displayText = formatToastText(text);

    if (!t || !msgEl) {
      console.info('[Toast]', displayText);
      return;
    }

    msgEl.innerText = displayText;
    msgEl.title = displayText === text ? '' : text;
    // If `.show` is already on (back-to-back toasts), briefly remove it and
    // force a reflow so the entrance animation replays — otherwise the new
    // text swaps in mid-display without any visual cue.
    if (t.classList.contains('show')) {
      t.classList.remove('show');
      // Access offsetWidth to flush pending style changes before re-adding.
      void t.offsetWidth;
    }
    t.classList.add('show');

    setManagedTimer(
      'toast-hide',
      () => {
        try {
          t.classList.remove('show');
        } catch {
          /* noop */
        }
      },
      2000,
    );
  } catch {
    console.info('[Toast fallback]', msg);
  }
}

// ─── Init ────────────────────────────────────────────────────────

export function initToast(): void {
  log.info('[Toast] Initialized');
}

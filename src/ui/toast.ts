/** Toast notifications and the shared header progress indicator. */

import { log } from '../core/log.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { suppressViewTransitions } from './dom.ts';

const TOAST_MAX_LINE_CHARS = 50;
const TOAST_DYNAMIC_VALUE_CHARS = 28;
const ELLIPSIS = '…';

// ─── Loader (Header Progress Bar) ────────────────────────────────

const DEFAULT_LOADER_ID = '_default';

interface LoaderHolder {
  text: string;
  percent: number;
  order: number;
}

// A holder owns the full visual state, not only a visibility hold. This lets a
// foreground operation temporarily cover a background transfer and restore
// the background operation's exact text/progress when it finishes.
const _loaderHolders = new Map<string, LoaderHolder>();
let _loaderOrder = 0;

function displayedProgress(progressBg: HTMLElement | null): number {
  if (!progressBg) return 0;
  const parsed = Number.parseFloat(progressBg.style.width);
  return Number.isFinite(parsed) ? parsed : 0;
}

function foregroundLoader(): [string, LoaderHolder] | null {
  let foreground: [string, LoaderHolder] | null = null;
  for (const entry of _loaderHolders) {
    if (!foreground || entry[1].order > foreground[1].order) foreground = entry;
  }
  return foreground;
}

function renderLoader(holder: LoaderHolder): void {
  const loadingText = document.getElementById('header-loading-text');
  const progressBg = document.getElementById('header-progress-bg') as HTMLElement | null;
  if (loadingText) loadingText.innerText = holder.text;
  if (progressBg) progressBg.style.width = `${holder.percent}%`;
}

export function updateLoader(percent: number, id?: string): void {
  // Explicit IDs are strict ownership tokens. Once removed, a late callback
  // with that ID must not repaint a newer operation's loader.
  if (id !== undefined) {
    const holder = _loaderHolders.get(id);
    if (!holder) return;
    holder.percent = percent;
    if (foregroundLoader()?.[0] === id) renderLoader(holder);
    return;
  }

  // No-ID callers own the default holder. If a named operation is temporarily
  // in front, retain the default operation's tick without repainting that
  // foreground. Named flows must use their ID for the same reason.
  const target = _loaderHolders.get(DEFAULT_LOADER_ID);
  if (target) {
    target.percent = percent;
    if (foregroundLoader()?.[0] === DEFAULT_LOADER_ID) renderLoader(target);
    return;
  }

  // Some older flows publish a progress tick before acquiring a holder. Keep
  // that harmless direct-DOM behavior only when no operation currently owns
  // the surface; otherwise it could corrupt an unrelated named transfer.
  if (_loaderHolders.size > 0) return;
  const progressBg = document.getElementById('header-progress-bg') as HTMLElement | null;
  if (progressBg) progressBg.style.width = `${percent}%`;
}

export function showLoader(show: boolean, txt?: string, id?: string): void {
  const key = id ?? DEFAULT_LOADER_ID;
  const header = document.getElementById('main-header');
  const loadingText = document.getElementById('header-loading-text');
  const progressBg = document.getElementById('header-progress-bg') as HTMLElement | null;

  if (show) {
    const existing = _loaderHolders.get(key);
    const holder: LoaderHolder = existing
      ? {
          ...existing,
          text: txt ?? existing.text,
        }
      : {
          text: txt ?? loadingText?.innerText ?? '',
          // Retaining the displayed value preserves the legacy quick
          // hide/show transition. New determinate flows should publish their
          // initial 0 tick.
          percent: key === DEFAULT_LOADER_ID ? displayedProgress(progressBg) : 0,
          order: ++_loaderOrder,
        };
    _loaderHolders.set(key, holder);
    clearManagedTimer('loader-reset');
    // Suppress View Transitions while the loading CSS transition plays
    // (1s transform + buffer) to prevent snapshot-replay double-animation
    suppressViewTransitions(1200);
    header?.classList.add('loading');
    // Repeated progress/text updates for an existing background holder must
    // not promote it over a newer foreground operation.
    if (foregroundLoader()?.[0] === key) renderLoader(holder);
  } else {
    _loaderHolders.delete(key);
    const foreground = foregroundLoader();
    if (foreground) {
      renderLoader(foreground[1]);
      return;
    }
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
  return text.replace(/\r\n?/g, '\n').split('\n').map(formatToastLine).join('\n');
}

export function showToast(msg: unknown, options: { durationMs?: number } = {}): void {
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
      Math.max(1000, options.durationMs || 2000),
    );
  } catch {
    console.info('[Toast fallback]', msg);
  }
}

// ─── Init ────────────────────────────────────────────────────────

export function initToast(): void {
  log.info('[Toast] Initialized');
}

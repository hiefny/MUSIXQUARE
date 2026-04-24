/**
 * MUSIXQUARE — Toast & Loader
 *
 * Manages: Toast notifications, header loading bar.
 */

import { log } from '../core/log.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { suppressViewTransitions } from './dom.ts';

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
    if (progressBg && (!progressBg.style.width || progressBg.style.width === '0%' || progressBg.style.width === '0px')) {
      progressBg.style.width = '0%';
    }
  } else {
    _loaderHolders.delete(key);
    if (_loaderHolders.size > 0) return;
    // Suppress through the reverse CSS transition as well
    suppressViewTransitions(1200);
    header?.classList.remove('loading');
    setManagedTimer('loader-reset', () => {
      if (progressBg) progressBg.style.width = '0%';
    }, 400);
  }
}

// ─── Toast ───────────────────────────────────────────────────────

export function showToast(msg: unknown): void {
  try {
    const t = document.getElementById('toast');
    const msgEl = document.getElementById('toast-msg');
    const text = (msg === undefined || msg === null) ? '' : String(msg);

    if (!t || !msgEl) {
      console.info('[Toast]', text);
      return;
    }

    msgEl.innerText = text;
    // If `.show` is already on (back-to-back toasts), briefly remove it and
    // force a reflow so the entrance animation replays — otherwise the new
    // text swaps in mid-display without any visual cue.
    if (t.classList.contains('show')) {
      t.classList.remove('show');
      // Access offsetWidth to flush pending style changes before re-adding.
      void t.offsetWidth;
    }
    t.classList.add('show');

    setManagedTimer('toast-hide', () => {
      try { t.classList.remove('show'); } catch { /* noop */ }
    }, 2000);
  } catch {
    console.info('[Toast fallback]', msg);
  }
}

// ─── Init ────────────────────────────────────────────────────────

export function initToast(): void {
  log.info('[Toast] Initialized');
}

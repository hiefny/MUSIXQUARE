/**
 * MUSIXQUARE 3.0 — Toast & Loader
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

export function showLoader(show: boolean, txt?: string): void {
  const header = document.getElementById('main-header');
  const loadingText = document.getElementById('header-loading-text');
  const progressBg = document.getElementById('header-progress-bg') as HTMLElement | null;

  if (show) {
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

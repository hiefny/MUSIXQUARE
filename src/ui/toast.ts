/**
 * MUSIXQUARE 2.0 — Toast & Loader
 * Extracted from original app.js lines 10097-10148
 *
 * Manages: Toast notifications, header loading bar.
 */

import { log } from '../core/log.ts';
import { i18nTranslate } from './i18n.ts';

// ─── Loader (Header Progress Bar) ────────────────────────────────

let _loaderResetTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (_loaderResetTimer) { clearTimeout(_loaderResetTimer); _loaderResetTimer = null; }
    header?.classList.add('loading');
    if (txt && loadingText) loadingText.innerText = i18nTranslate(txt) ?? '';
    if (progressBg && (progressBg.style.width === '0px' || progressBg.style.width === '')) {
      progressBg.style.width = '0%';
    }
  } else {
    header?.classList.remove('loading');
    _loaderResetTimer = setTimeout(() => {
      if (progressBg) progressBg.style.width = '0%';
      _loaderResetTimer = null;
    }, 400);
  }
}

// ─── Toast ───────────────────────────────────────────────────────

let _toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(msg: unknown): void {
  try {
    const t = document.getElementById('toast');
    const msgEl = document.getElementById('toast-msg');
    const text = (msg === undefined || msg === null) ? '' : String(msg);

    if (!t || !msgEl) {
      console.info('[Toast]', text);
      return;
    }

    msgEl.innerText = i18nTranslate(text) ?? '';
    t.classList.add('show');

    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      try { t.classList.remove('show'); } catch { /* noop */ }
    }, 2000);
  } catch (e) {
    console.info('[Toast fallback]', msg);
  }
}

// ─── Init ────────────────────────────────────────────────────────

export function initToast(): void {
  log.info('[Toast] Initialized');
}

/**
 * MUSIXQUARE 2.0 — Toast & Loader
 * Extracted from original app.js lines 10097-10148
 *
 * Manages: Toast notifications, header loading bar.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { i18nTranslate } from './i18n.ts';

// ─── Loader (Toss: Chat Preview Button Progress) ─────────────────

let _loaderResetTimer: ReturnType<typeof setTimeout> | null = null;
let _lastSystemMsgBase: string | null = null;

export function updateLoader(percent: number): void {
  const progressBg = document.getElementById('chat-preview-progress-bg');
  if (progressBg) {
    (progressBg as HTMLElement).style.width = `${percent}%`;
  }
}

export function showLoader(show: boolean, txt?: string): void {
  const chatBtn = document.getElementById('chat-preview-btn');
  const chatText = document.getElementById('chat-preview-text');
  const progressBg = document.getElementById('chat-preview-progress-bg') as HTMLElement | null;

  if (show) {
    if (_loaderResetTimer) { clearTimeout(_loaderResetTimer); _loaderResetTimer = null; }
    chatBtn?.classList.add('loading');
    if (txt && chatText) {
      if (!chatText.dataset.originalText) {
        chatText.dataset.originalText = chatText.textContent || '';
      }
      chatText.innerText = i18nTranslate(txt) ?? '';

      // Emit system message to chat (deduplicate % updates)
      const translated = i18nTranslate(txt) ?? txt;
      const base = translated.replace(/\d+%/, '').trim();
      if (base !== _lastSystemMsgBase) {
        _lastSystemMsgBase = base;
        bus.emit('chat:system-message', translated);
      }
    }
    if (progressBg && (progressBg.style.width === '0px' || progressBg.style.width === '')) {
      progressBg.style.width = '0%';
    }
  } else {
    chatBtn?.classList.remove('loading');
    if (chatText?.dataset.originalText) {
      chatText.innerText = chatText.dataset.originalText;
      delete chatText.dataset.originalText;
    }
    _lastSystemMsgBase = null;
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
  } catch {
    console.info('[Toast fallback]', msg);
  }
}

// ─── Init ────────────────────────────────────────────────────────

export function initToast(): void {
  log.info('[Toast] Initialized');
}

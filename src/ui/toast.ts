/**
 * MUSIXQUARE 2.0 — Toast & Loader
 * Extracted from original app.js lines 10097-10148
 *
 * Manages: Toast notifications, header loading bar.
 */

import { log } from '../core/log.ts';
import { i18nTranslate } from './i18n.ts';
import { bus } from '../core/events.ts';

// ─── Loader (Chat Preview Bar Progress) ─────────────────────────

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
      // Save original text to restore after loading
      if (!chatText.dataset.originalText) {
        chatText.dataset.originalText = chatText.textContent || '';
      }
      chatText.textContent = i18nTranslate(txt) ?? '';
    }
    if (progressBg && (progressBg.style.width === '0px' || progressBg.style.width === '')) {
      progressBg.style.width = '0%';
    }

    // System chat message — skip percentage-only updates
    if (txt) {
      const baseMsg = txt.replace(/\s*\d+%/, '');
      if (baseMsg !== _lastSystemMsgBase) {
        _lastSystemMsgBase = baseMsg;
        bus.emit('chat:system-message', i18nTranslate(txt) ?? txt);
      }
    }
  } else {
    _lastSystemMsgBase = null;
    chatBtn?.classList.remove('loading');
    // Restore original chat preview text
    if (chatText && chatText.dataset.originalText !== undefined) {
      chatText.textContent = chatText.dataset.originalText;
      delete chatText.dataset.originalText;
    }
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

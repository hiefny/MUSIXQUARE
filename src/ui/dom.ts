/**
 * MUSIXQUARE 2.0 — DOM Utilities
 * Extracted from original app.js
 *
 * Manages: animateTransition, escapeHtml, updateTitleWithMarquee,
 * copyTextToClipboard, toggleFullscreen.
 */

import { log } from '../core/log.ts';

// ─── Batch View Transition ───────────────────────────────────────

let _batchedTransitionCb: (() => void) | null = null;

export function animateTransition(callback: () => void): void {
  if (!(document as unknown as Record<string, unknown>).startViewTransition) {
    callback();
    return;
  }

  if (_batchedTransitionCb !== null) {
    const oldCb = _batchedTransitionCb;
    _batchedTransitionCb = () => { oldCb(); callback(); };
    return;
  }

  _batchedTransitionCb = callback;
  Promise.resolve().then(() => {
    const cb = _batchedTransitionCb;
    _batchedTransitionCb = null;
    if (!cb) return;
    let executed = false;
    try {
      (document as unknown as Record<string, (...args: unknown[]) => void>).startViewTransition(() => {
        executed = true;
        cb();
      });
    } catch {
      if (!executed) cb();
    }
  });
}

// ─── HTML Escaping ───────────────────────────────────────────────

const _ESCAPE_HTML_RE = /[&<>"']/;
const _ESCAPE_HTML_RE_G = /[&<>"']/g;
const _ESCAPE_HTML_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (!_ESCAPE_HTML_RE.test(str)) return str;
  return str.replace(_ESCAPE_HTML_RE_G, (ch) => _ESCAPE_HTML_MAP[ch] || ch);
}

export const escapeAttr = escapeHtml;

// ─── Marquee Title ───────────────────────────────────────────────

export function updateTitleWithMarquee(text: string): void {
  const el = document.getElementById('track-title');
  if (!el) return;

  el.classList.remove('marquee');
  el.style.animation = 'none';
  el.innerText = text;
  el.removeAttribute('data-text');

  el.style.removeProperty('--marquee-offset');
  el.style.removeProperty('--marquee-duration');

  setTimeout(() => {
    const parent = el.parentElement;
    if (!parent) return;

    const overflowWidth = el.scrollWidth - parent.clientWidth;
    const targetOffset = -(overflowWidth + 32);

    if (overflowWidth > 0) {
      el.classList.add('marquee');
      el.style.setProperty('--marquee-offset', `${targetOffset}px`);

      const speed = 40;
      const travelDuration = (Math.abs(targetOffset) / speed);
      const totalDuration = travelDuration * 2 + 4;
      el.style.setProperty('--marquee-duration', `${totalDuration}s`);
      el.style.animation = '';
    }
  }, 100);
}

// ─── Clipboard ───────────────────────────────────────────────────

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    log.warn('[Clipboard] Copy failed:', e);
    return false;
  }
}

// ─── Fullscreen ──────────────────────────────────────────────────

export function toggleFullscreen(): void {
  try {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  } catch (e) {
    log.debug('[Fullscreen] Toggle failed:', e);
  }
}

// ─── Overlay Open Class ──────────────────────────────────────────

const _OVERLAY_IDS = ['setup-overlay', 'media-source-overlay', 'youtube-url-overlay'];

export function updateOverlayOpenClass(): void {
  try {
    const anyActive = _OVERLAY_IDS.some((id) => {
      const el = document.getElementById(id);
      return !!(el && el.classList.contains('active'));
    });
    if (document.body) document.body.classList.toggle('overlay-open', anyActive);
  } catch { /* ignore */ }
}

export function initOverlayOpenObserver(): void {
  try {
    const obs = new MutationObserver(() => updateOverlayOpenClass());
    _OVERLAY_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  } catch { /* ignore */ }

  updateOverlayOpenClass();
}

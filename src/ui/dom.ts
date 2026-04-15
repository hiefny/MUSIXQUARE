/**
 * MUSIXQUARE 3.0 — DOM Utilities
 *
 * Manages: animateTransition, escapeHtml, updateTitleWithMarquee,
 * copyTextToClipboard.
 */

import { log } from '../core/log.ts';
import { setManagedTimer } from '../core/timers.ts';

// ─── Batch View Transition ───────────────────────────────────────

let _batchedTransitionCb: (() => void) | null = null;

let _suppressViewTransitionUntil = 0;

/** Suppress View Transitions for the given duration (ms). */
export function suppressViewTransitions(durationMs: number): void {
  _suppressViewTransitionUntil = Date.now() + durationMs;
}

export function animateTransition(callback: () => void): void {
  // Skip View Transitions while the header loading-bar CSS transition
  // is in progress — startViewTransition snapshots replay CSS transitions,
  // causing the loading animation to appear twice.
  if (Date.now() < _suppressViewTransitionUntil || !(document as unknown as Record<string, unknown>).startViewTransition) {
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
      // startViewTransition returns a ViewTransition object whose
      // `ready` / `finished` / `updateCallbackDone` Promises reject when
      // the transition is aborted (e.g. another transition supersedes
      // this one, or the document visibility flips mid-animation). The
      // callback still runs, so the abort has no user-facing impact —
      // but an uncaught rejection lands in the global `unhandledrejection`
      // handler and shows up in console as "InvalidStateError: Transition
      // was aborted because of invalid state". Silence the benign ones.
      const vt = (document as unknown as Record<string, (...args: unknown[]) => unknown>).startViewTransition(() => {
        executed = true;
        cb();
      }) as { ready?: Promise<void>; finished?: Promise<void>; updateCallbackDone?: Promise<void> } | undefined;
      vt?.ready?.catch(() => { /* noop — benign abort */ });
      vt?.finished?.catch(() => { /* noop — benign abort */ });
      vt?.updateCallbackDone?.catch(() => { /* noop — benign abort */ });
    } catch {
      if (!executed) cb();
    }
  });
}

// ─── HTML Escaping ───────────────────────────────────────────────

// ─── Overlay Inert Management ────────────────────────────────────
// When a fullscreen overlay is active, set `inert` on all sibling elements
// of <body> children so keyboard focus is trapped inside the overlay.
// The OVERLAY_IDS list covers the three main overlays that lack focus traps.

const OVERLAY_IDS = ['setup-overlay', 'media-source-overlay', 'youtube-url-overlay'];

/**
 * Observe overlay .active class changes and toggle `inert` on non-overlay
 * body children. Uses a single MutationObserver on <body> for efficiency.
 */
export function initOverlayInertObserver(): void {
  function syncInert(): void {
    const anyOverlayActive = OVERLAY_IDS.some(id => {
      const el = document.getElementById(id);
      return el?.classList.contains('active');
    });
    // Toggle inert on all direct children of body that aren't the active overlay
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (OVERLAY_IDS.includes(child.id)) continue;
      if (anyOverlayActive) {
        child.setAttribute('inert', '');
      } else {
        child.removeAttribute('inert');
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'class') {
        const target = m.target as HTMLElement;
        if (OVERLAY_IDS.includes(target.id)) {
          syncInert();
          return;
        }
      }
    }
  });

  // Observe each overlay element for class changes
  for (const id of OVERLAY_IDS) {
    const el = document.getElementById(id);
    if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  }

  // Initial sync
  syncInert();
}

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

let _currentMarqueeText: string | null = null;
let _marqueeResizeListenerAdded = false;

function applyMarquee(el: HTMLElement): void {
  el.classList.remove('marquee');
  el.style.animation = 'none';
  el.style.removeProperty('--marquee-offset');
  el.style.removeProperty('--marquee-duration');

  requestAnimationFrame(() => {
    const parent = el.parentElement;
    if (!parent) return;

    const overflowWidth = el.scrollWidth - parent.clientWidth;
    const targetOffset = -(overflowWidth + 32);

    if (overflowWidth > 0) {
      el.classList.add('marquee');
      el.style.setProperty('--marquee-offset', `${targetOffset}px`);

      const speed = 40;
      const travelDuration = Math.abs(targetOffset) / speed;
      const totalDuration = travelDuration * 2 + 4;
      el.style.setProperty('--marquee-duration', `${totalDuration}s`);
      el.style.animation = '';
    } else {
      el.style.removeProperty('animation');
    }
  });
}

function onMarqueeResize(): void {
  setManagedTimer('marquee-resize', () => {
    if (!_currentMarqueeText) return;
    const el = document.getElementById('track-title');
    if (!el) return;
    applyMarquee(el);
  }, 250);
}

export function updateTitleWithMarquee(text: string): void {
  const el = document.getElementById('track-title');
  if (!el) return;

  // Skip if text hasn't changed — prevents marquee animation restart flicker
  if (text === _currentMarqueeText) return;

  _currentMarqueeText = text;
  el.innerText = text;
  el.removeAttribute('data-text');
  applyMarquee(el);

  if (!_marqueeResizeListenerAdded) {
    _marqueeResizeListenerAdded = true;
    window.addEventListener('resize', onMarqueeResize);
  }
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

// ─── Overlay Open Class ──────────────────────────────────────────

const _OVERLAY_IDS = ['setup-overlay', 'media-source-overlay', 'youtube-url-overlay'];
let _overlayObserver: MutationObserver | null = null;

export function updateOverlayOpenClass(): void {
  try {
    const anyActive = _OVERLAY_IDS.some((id) => {
      const el = document.getElementById(id);
      return !!(el && el.classList.contains('active'));
    });
    if (document.body) document.body.classList.toggle('overlay-open', anyActive);
  } catch (e) { log.debug('[DOM] Overlay class toggle error:', e); }
}

export function initOverlayOpenObserver(): void {
  // Disconnect previous observer to prevent memory leak on reinit
  if (_overlayObserver) {
    _overlayObserver.disconnect();
    _overlayObserver = null;
  }

  try {
    _overlayObserver = new MutationObserver(() => updateOverlayOpenClass());
    _OVERLAY_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) _overlayObserver!.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  } catch (e) { log.debug('[DOM] Overlay observer init error:', e); }

  updateOverlayOpenClass();
}

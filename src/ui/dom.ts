/**
 * MUSIXQUARE — DOM Utilities
 *
 * Manages: animateTransition, escapeHtml, updateTitleWithMarquee,
 * copyTextToClipboard.
 */

import { log } from '../core/log.ts';
import { setManagedTimer } from '../core/timers.ts';

// ─── Batch View Transition ───────────────────────────────────────

let _batchedTransitionCb: (() => void) | null = null;

let _suppressViewTransitionUntil = 0;

interface ViewTransitionLike {
  ready?: Promise<void>;
  finished?: Promise<void>;
  updateCallbackDone?: Promise<void>;
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void) => ViewTransitionLike;
};

/** Suppress View Transitions for the given duration (ms). */
export function suppressViewTransitions(durationMs: number): void {
  _suppressViewTransitionUntil = Date.now() + durationMs;
}

export function animateTransition(callback: () => void): void {
  const transitionDocument = document as DocumentWithViewTransition;
  // Skip View Transitions while the header loading-bar CSS transition
  // is in progress — startViewTransition snapshots replay CSS transitions,
  // causing the loading animation to appear twice.
  if (
    Date.now() < _suppressViewTransitionUntil ||
    !transitionDocument.startViewTransition
  ) {
    callback();
    return;
  }

  if (_batchedTransitionCb !== null) {
    const oldCb = _batchedTransitionCb;
    _batchedTransitionCb = () => {
      oldCb();
      callback();
    };
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
      const vt = transitionDocument.startViewTransition(() => {
        executed = true;
        cb();
      });
      vt?.ready?.catch(() => {
        /* noop — benign abort */
      });
      vt?.finished?.catch(() => {
        /* noop — benign abort */
      });
      vt?.updateCallbackDone?.catch(() => {
        /* noop — benign abort */
      });
    } catch {
      if (!executed) cb();
    }
  });
}

// ─── HTML Escaping ───────────────────────────────────────────────

// ─── Overlay Registry (single source of truth) ───────────────────
// One declaration table feeds two effects, both driven by the same set
// of class-attribute mutations:
//
//   1. `body.overlay-open` toggle — used by CSS to hide page chrome
//      (header / bottom-nav) under fullscreen onboarding overlays.
//      Centered overlays (the dialog) opt out via `fullscreen: false`.
//
//   2. Modal stack inert/focus trap — every body child except the
//      topmost shown overlay gets `inert`, so keyboard Tab is trapped
//      inside the active modal and pointer hits can't fall through.
//
// History
// ───────
// [a3c84db] introduced the inert focus-trap with a flat allowlist of
// the three fullscreen onboarding overlays. dialog-overlay was a body
// child too, so when the SW update prompt opened over the setup screen
// the dialog rendered correctly but was itself inerted — taps fell
// through to setup ([1b09816]). The first cut at this rewrite fixed
// the click-through with a LIFO modal stack ([f0848c7]) but kept two
// MutationObservers watching the same element set for two effects.
// This pass collapses them into one observer + one registry: change
// detection runs once per class mutation, both effects derive from the
// same `OVERLAYS` array.

interface OverlayDef {
  id: string;
  /** Class on the element that means "currently shown/active". */
  cls: string;
  /**
   * `true` for fullscreen overlays whose presence should hide page
   * chrome via `body.overlay-open`. Centered modals (dialog) keep
   * the chrome visible underneath the dim backdrop.
   */
  fullscreen: boolean;
}

const OVERLAYS: readonly OverlayDef[] = [
  { id: 'setup-overlay', cls: 'active', fullscreen: true },
  { id: 'demo-overlay', cls: 'active', fullscreen: true },
  { id: 'media-source-overlay', cls: 'active', fullscreen: true },
  { id: 'youtube-url-overlay', cls: 'active', fullscreen: true },
  { id: 'dialog-overlay', cls: 'show', fullscreen: false },
] as const;

function isShown(o: OverlayDef): boolean {
  const el = document.getElementById(o.id);
  return !!el?.classList.contains(o.cls);
}

// ─── Effect 1: body.overlay-open class ───────────────────────────
// Exported for hot-path callers (setup-shared, player-controls) that
// flip `.active` and want the body class updated synchronously without
// waiting for the MutationObserver microtask.
export function updateOverlayOpenClass(): void {
  try {
    const anyFullscreenActive = OVERLAYS.some((o) => o.fullscreen && isShown(o));
    if (document.body) document.body.classList.toggle('overlay-open', anyFullscreenActive);
  } catch (e) {
    log.debug('[DOM] Overlay class toggle error:', e);
  }
}

// ─── Effect 2: modal stack inert ─────────────────────────────────
// LIFO order: index 0 = oldest currently-shown modal, last index = top.
// Module-scoped so successive open/close events preserve stack order
// without re-deriving it from the DOM.
const _modalStack: string[] = [];

/** @internal Test-only helper to reset stack between cases. */
export function __resetModalStackForTests(): void {
  _modalStack.length = 0;
}

function syncModalStack(): void {
  // 1. Drop modals that are no longer shown (preserves order of survivors).
  for (let i = _modalStack.length - 1; i >= 0; i--) {
    const o = OVERLAYS.find((x) => x.id === _modalStack[i]);
    if (!o || !isShown(o)) _modalStack.splice(i, 1);
  }

  // 2. Append modals that have just become shown, in OVERLAYS declaration
  //    order (only matters when multiple appear on the same tick).
  for (const o of OVERLAYS) {
    if (isShown(o) && !_modalStack.includes(o.id)) _modalStack.push(o.id);
  }

  // Centered dialogs are confirmations/alerts, so they must remain the
  // interactive layer even if a fullscreen overlay re-syncs after them.
  const top =
    [..._modalStack].reverse().find((id) => {
      const overlay = OVERLAYS.find((x) => x.id === id);
      return overlay && !overlay.fullscreen;
    }) ?? (_modalStack.length > 0 ? _modalStack[_modalStack.length - 1] : null);

  // 3. Apply inert to every body child except the top of the stack. With
  //    the stack empty (no modals open), nothing is inert.
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (top !== null && child.id !== top) {
      child.setAttribute('inert', '');
    } else {
      child.removeAttribute('inert');
    }
  }
}

export function syncOverlayState(): void {
  updateOverlayOpenClass();
  syncModalStack();
}

// ─── Observer (single watcher, both effects) ─────────────────────

let _overlayObserver: MutationObserver | null = null;

/**
 * Watch every overlay in {@link OVERLAYS} for class changes and run both
 * the `body.overlay-open` toggle and the modal stack sync on each tick.
 * One MutationObserver, one observe() call per overlay.
 *
 * Idempotent — disconnects any prior observer, so test harnesses that
 * reinit the page can safely re-run setup without leaking observers.
 */
export function initOverlayObservers(): void {
  if (_overlayObserver) {
    _overlayObserver.disconnect();
    _overlayObserver = null;
  }

  try {
    _overlayObserver = new MutationObserver(() => {
      syncOverlayState();
    });
    for (const o of OVERLAYS) {
      const el = document.getElementById(o.id);
      if (el) _overlayObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
  } catch (e) {
    log.debug('[DOM] Overlay observer init error:', e);
  }

  syncOverlayState();
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
    const targetOffset = -overflowWidth;

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
  setManagedTimer(
    'marquee-resize',
    () => {
      if (!_currentMarqueeText) return;
      const el = document.getElementById('track-title');
      if (!el) return;
      applyMarquee(el);
    },
    250,
  );
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

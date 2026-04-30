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

/** Suppress View Transitions for the given duration (ms). */
export function suppressViewTransitions(durationMs: number): void {
  _suppressViewTransitionUntil = Date.now() + durationMs;
}

export function animateTransition(callback: () => void): void {
  // Skip View Transitions while the header loading-bar CSS transition
  // is in progress — startViewTransition snapshots replay CSS transitions,
  // causing the loading animation to appear twice.
  if (
    Date.now() < _suppressViewTransitionUntil ||
    !(document as unknown as Record<string, unknown>).startViewTransition
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
      const vt = (
        document as unknown as Record<string, (...args: unknown[]) => unknown>
      ).startViewTransition(() => {
        executed = true;
        cb();
      }) as
        | { ready?: Promise<void>; finished?: Promise<void>; updateCallbackDone?: Promise<void> }
        | undefined;
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

// ─── Modal Stack Management (focus trap via inert) ───────────────
// Modals can stack on top of each other (e.g. the SW update dialog opening
// over the initial setup overlay). Tab focus must stay inside the *topmost*
// modal — every other body child, including modals further down the stack,
// gets the HTML5 `inert` attribute so keyboard nav can't escape and pointer
// hits don't fall through.
//
// Each entry pairs a modal element id with the class that signals "this
// modal is currently showing". History: setup/media/youtube overlays use
// `.active` (legacy onboarding markup), dialog-overlay uses `.show`. We
// keep them in one list rather than two parallel mechanisms.
//
// History note
// ────────────
// [a3c84db] introduced the original observer with a flat `OVERLAY_IDS`
// allowlist — anything not on the list got inerted. That worked for the
// three onboarding overlays but missed dialog-overlay, which is also a
// body child. When the SW update dialog opened over the setup screen it
// was rendered correctly but inerted, so taps fell through to the setup
// content underneath — see [1b09816]. The band-aid there added a
// `NEVER_INERT_IDS` skip-list, which fixed the click-through but left
// the wrong focus model: with both overlays "interactive", Tab could
// reach focusable controls underneath the dialog. This rewrite moves to
// proper LIFO stacking so only the top stays interactive.

interface ModalDef {
  id: string;
  /** Class on the element that means "currently shown/active". */
  cls: string;
}

const MODALS: readonly ModalDef[] = [
  { id: 'setup-overlay', cls: 'active' },
  { id: 'media-source-overlay', cls: 'active' },
  { id: 'youtube-url-overlay', cls: 'active' },
  { id: 'dialog-overlay', cls: 'show' },
] as const;

// LIFO order: index 0 = oldest currently-shown modal, last index = top.
// Module-scoped so successive open/close events preserve stack order
// without re-deriving it from the DOM.
const _modalStack: string[] = [];

/** @internal Test-only helper to reset stack between cases. */
export function __resetModalStackForTests(): void {
  _modalStack.length = 0;
}

function isShown(def: ModalDef): boolean {
  const el = document.getElementById(def.id);
  return !!el?.classList.contains(def.cls);
}

function syncModalStack(): void {
  // 1. Drop modals that are no longer shown (preserves order of survivors).
  for (let i = _modalStack.length - 1; i >= 0; i--) {
    const def = MODALS.find((m) => m.id === _modalStack[i]);
    if (!def || !isShown(def)) _modalStack.splice(i, 1);
  }

  // 2. Append modals that have just become shown, in MODALS declaration order
  //    (only relevant when multiple appear on the same tick — single openings
  //    just push one entry).
  for (const def of MODALS) {
    if (isShown(def) && !_modalStack.includes(def.id)) _modalStack.push(def.id);
  }

  const top = _modalStack.length > 0 ? _modalStack[_modalStack.length - 1] : null;

  // 3. Apply inert to every body child except the top of the stack. When the
  //    stack is empty (no modals open), nothing should be inert.
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (top !== null && child.id !== top) {
      child.setAttribute('inert', '');
    } else {
      child.removeAttribute('inert');
    }
  }
}

/**
 * Watch every modal in {@link MODALS} for class changes and keep the body's
 * `inert` distribution in sync with the modal stack. One MutationObserver
 * total, attached per modal element.
 */
export function initOverlayInertObserver(): void {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== 'attributes' || m.attributeName !== 'class') continue;
      const target = m.target as HTMLElement;
      if (MODALS.some((d) => d.id === target.id)) {
        syncModalStack();
        return;
      }
    }
  });

  for (const def of MODALS) {
    const el = document.getElementById(def.id);
    if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  }

  syncModalStack();
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
  } catch (e) {
    log.debug('[DOM] Overlay class toggle error:', e);
  }
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
  } catch (e) {
    log.debug('[DOM] Overlay observer init error:', e);
  }

  updateOverlayOpenClass();
}

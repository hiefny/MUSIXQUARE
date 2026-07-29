/**
 * MUSIXQUARE — DOM Utilities
 *
 * Manages: animateTransition, escapeHtml, updateTitleWithMarquee,
 * copyTextToClipboard.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
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
  if (Date.now() < _suppressViewTransitionUntil || !transitionDocument.startViewTransition) {
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
// A flat overlay allowlist can inert a dialog opened above another overlay,
// making taps fall through to the screen underneath. Keep a LIFO modal stack
// and derive both chrome visibility and inert state from one observer and the
// same `OVERLAYS` registry.

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

const OVERLAYS = [
  { id: 'setup-overlay', cls: 'active', fullscreen: true },
  { id: 'demo-overlay', cls: 'active', fullscreen: true },
  { id: 'media-source-overlay', cls: 'active', fullscreen: true },
  { id: 'youtube-url-overlay', cls: 'active', fullscreen: true },
  { id: 'dialog-overlay', cls: 'show', fullscreen: false },
  { id: 'signaling-recovery-overlay', cls: 'show', fullscreen: false },
  { id: 'account-dialog-overlay', cls: 'show', fullscreen: false },
  { id: 'administrator-permissions-overlay', cls: 'show', fullscreen: false },
  { id: 'language-dialog-overlay', cls: 'show', fullscreen: false },
  { id: 'manual-sync-overlay', cls: 'show', fullscreen: false },
] as const satisfies readonly OverlayDef[];
type OverlayId = (typeof OVERLAYS)[number]['id'];

function isShown(o: OverlayDef): boolean {
  const el = document.getElementById(o.id);
  return !!el?.classList.contains(o.cls);
}

/**
 * Return whether a modal/fullscreen layer currently owns the product surface.
 *
 * Most overlays live in the shared registry above. A few feature-specific
 * diagnostic/sync layers are created outside that registry, so include them
 * here as well. This keeps global gestures such as file drop from acting
 * through a visible overlay while leaving ordinary drawers (for example,
 * chat) interactive.
 */
export function isAnyOverlayShown(): boolean {
  if (OVERLAYS.some(isShown)) return true;
  if (document.querySelector('#chat-drawer.open[aria-modal="true"]')) return true;
  if (document.getElementById('youtube-ios-sync-overlay')) return true;
  return document.querySelector('.debug-memory-overlay') !== null;
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
const CENTERED_OVERLAY_Z_INDEX_BASE = 6000;
const CENTERED_OVERLAY_Z_INDEX_STEP = 10;
const OVERLAY_INERT_OWNER = 'overlay-stack';

interface ManagedInertState {
  readonly owners: Set<string>;
  readonly initiallyInert: boolean;
}

const _managedInert = new WeakMap<HTMLElement, ManagedInertState>();

/**
 * Own an element's inert state without clearing another surface's lock.
 *
 * Mobile chat and the modal stack can overlap. Directly toggling `inert`
 * from either subsystem lets the first one that closes re-enable the page
 * behind the other. Owners release only their own claim; a pre-existing
 * unmanaged inert state is also preserved.
 */
export function setElementInertForOwner(
  element: HTMLElement,
  owner: string,
  makeInert: boolean,
): void {
  let state = _managedInert.get(element);
  if (makeInert) {
    if (!state) {
      state = {
        owners: new Set<string>(),
        initiallyInert: Boolean(element.inert || element.hasAttribute('inert')),
      };
      _managedInert.set(element, state);
    }
    state.owners.add(owner);
    element.inert = true;
    element.setAttribute('inert', '');
    return;
  }

  if (!state) return;
  state.owners.delete(owner);
  if (state.owners.size > 0) {
    element.inert = true;
    element.setAttribute('inert', '');
    return;
  }

  element.inert = state.initiallyInert;
  if (state.initiallyInert) element.setAttribute('inert', '');
  else element.removeAttribute('inert');
  _managedInert.delete(element);
}

/** @internal Test-only helper to reset stack between cases. */
export function __resetModalStackForTests(): void {
  _modalStack.length = 0;
  for (const child of Array.from(document.body?.children ?? [])) {
    if (child instanceof HTMLElement) {
      setElementInertForOwner(child, OVERLAY_INERT_OWNER, false);
    }
  }
}

function promoteOverlayToTop(id: OverlayId | undefined): void {
  if (!id) return;
  const overlay = OVERLAYS.find((x) => x.id === id);
  if (!overlay || !isShown(overlay)) return;

  const index = _modalStack.indexOf(id);
  if (index !== -1) _modalStack.splice(index, 1);
  _modalStack.push(id);
}

function applyCenteredOverlayZIndexes(): void {
  for (const o of OVERLAYS) {
    if (o.fullscreen) continue;
    const el = document.getElementById(o.id);
    if (!el) continue;

    const stackIndex = _modalStack.indexOf(o.id);
    if (stackIndex === -1 || !isShown(o)) {
      el.style.removeProperty('z-index');
      continue;
    }

    el.style.zIndex = String(
      CENTERED_OVERLAY_Z_INDEX_BASE + stackIndex * CENTERED_OVERLAY_Z_INDEX_STEP,
    );
  }
}

function syncModalStack(preferredTopOverlayId?: OverlayId): void {
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

  // Synchronous open paths know which overlay was just opened. Promote it
  // after catch-up scanning so observer timing cannot invert two dialogs.
  promoteOverlayToTop(preferredTopOverlayId);

  // Centered dialogs are confirmations/alerts, so they must remain the
  // interactive layer even if a fullscreen overlay re-syncs after them.
  const top =
    [..._modalStack].reverse().find((id) => {
      const overlay = OVERLAYS.find((x) => x.id === id);
      return overlay && !overlay.fullscreen;
    }) ?? (_modalStack.length > 0 ? _modalStack[_modalStack.length - 1] : null);

  applyCenteredOverlayZIndexes();

  // 3. Apply inert to every body child except the top of the stack. With
  //    the stack empty (no modals open), nothing is inert.
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    setElementInertForOwner(child, OVERLAY_INERT_OWNER, top !== null && child.id !== top);
  }
}

export function syncOverlayState(preferredTopOverlayId?: OverlayId): void {
  updateOverlayOpenClass();
  syncModalStack(preferredTopOverlayId);
  if (preferredTopOverlayId) {
    const overlay = document.getElementById(preferredTopOverlayId);
    const definition = OVERLAYS.find((candidate) => candidate.id === preferredTopOverlayId);
    if (overlay && definition && overlay.classList.contains(definition.cls)) {
      // Opening a previously hidden surface can change both its scroll owner
      // and its measured height. Scope the reveal so background tabs/dialogs
      // stay quiet while overflowing content advertises itself once.
      bus.emit('ui:scrollbar-reveal', overlay);
    }
  }
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

// ─── contentEditable Placeholder Normalization ───────────────────

/**
 * contentEditable leaves a stray <br> after you type then delete everything,
 * so the element is no longer :empty and the CSS placeholder
 * (:empty::before) never comes back. Normalize to truly empty so it
 * reappears. Skips during IME composition so in-progress Hangul/CJK isn't
 * clobbered (programmatic innerHTML writes don't refire 'input').
 *
 * Call from an 'input' event handler of any placeholder-bearing
 * contentEditable (chat input, YouTube URL input, dialog inputs).
 */
export function normalizeEmptyContentEditable(el: HTMLElement, e: Event): void {
  if (!(e as InputEvent).isComposing && el.textContent === '' && el.innerHTML !== '') {
    el.innerHTML = '';
  }
}

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
  if (text === _currentMarqueeText && el.innerText === text) return;

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
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      log.warn('[Clipboard] Async API failed; trying the DOM fallback:', error);
    }
  }

  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand('copy');
  } catch (e) {
    log.warn('[Clipboard] Copy failed:', e);
    return false;
  } finally {
    textarea?.remove();
  }
}

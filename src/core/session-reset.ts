/**
 * Coordinates every app-owned hard reset/navigation.
 *
 * The reset overlay is shown synchronously so the page cannot accept another
 * interaction while teardown or navigation is pending. The actual action is
 * deferred until the browser has had a chance to paint the overlay. A native
 * timeout backs up requestAnimationFrame because background tabs may suspend
 * animation frames, and managed timers can be cleared by leaveSession().
 */

import { markIntentionalNav } from './page-lifecycle.ts';

const OVERLAY_ID = 'session-reset-overlay';
const MESSAGE_ID = 'session-reset-message';
const FALLBACK_DELAY_MS = 120;

let _resetPending = false;

function blockInteraction(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function installInteractionBlockers(): void {
  for (const eventName of [
    'keydown',
    'keyup',
    'pointerdown',
    'pointerup',
    'click',
    'touchstart',
    'touchend',
    'wheel',
  ]) {
    window.addEventListener(eventName, blockInteraction, {
      capture: true,
      passive: false,
    });
  }
}

function ensureOverlay(): HTMLElement {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing instanceof HTMLElement) return existing;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'session-reset-overlay';
  overlay.hidden = true;
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'assertive');
  overlay.setAttribute('aria-atomic', 'true');
  overlay.setAttribute('aria-hidden', 'true');

  const status = document.createElement('div');
  status.className = 'session-reset-status';

  const spinner = document.createElement('span');
  spinner.className = 'session-reset-spinner';
  spinner.setAttribute('aria-hidden', 'true');

  const message = document.createElement('p');
  message.id = MESSAGE_ID;
  message.className = 'session-reset-message';

  status.append(spinner, message);
  overlay.append(status);
  document.body.append(overlay);
  return overlay;
}

function showResetOverlay(message: string): void {
  const overlay = ensureOverlay();
  const messageEl = overlay.querySelector<HTMLElement>(`#${MESSAGE_ID}`);
  if (messageEl) messageEl.textContent = message;
  installInteractionBlockers();

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement !== overlay) {
    activeElement.blur();
  }

  for (const child of document.body.children) {
    if (child === overlay || !(child instanceof HTMLElement)) continue;
    child.inert = true;
  }

  document.documentElement.classList.add('session-reset-pending');
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  overlay.setAttribute('aria-busy', 'true');
  overlay.classList.add('show');

  try {
    overlay.focus({ preventScroll: true });
  } catch {
    overlay.focus();
  }
}

/**
 * Show the blocking reset UI now, then run the supplied hard-navigation action
 * after the overlay has painted. Only the first request in a document wins.
 */
export function scheduleSessionReset(message: string, action: () => void): void {
  if (_resetPending) return;
  _resetPending = true;
  showResetOverlay(message);

  let actionStarted = false;
  let fallbackTimer = 0;
  const runOnce = () => {
    if (actionStarted) return;
    actionStarted = true;
    window.clearTimeout(fallbackTimer);
    markIntentionalNav();
    action();
  };

  fallbackTimer = window.setTimeout(runOnce, FALLBACK_DELAY_MS);
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => window.requestAnimationFrame(runOnce));
  }
}

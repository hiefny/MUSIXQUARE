/**
 * MUSIXQUARE — Setup Shared State & Helpers
 *
 * Shared module-level state, UI helper functions, onboarding slider,
 * desktop left-panel sync, and button rendering used by setup-host,
 * setup-guest, and setup (orchestrator).
 *
 * IMPORTANT: This file must NOT import from setup.ts, setup-host.ts,
 * or setup-guest.ts to avoid circular dependencies.
 */

import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { isCompactLandscape } from '../core/platform.ts';
import { animateTransition, updateOverlayOpenClass } from './dom.ts';
import { showToast } from './toast.ts';
import {
  updateRoleBadge,
  updateInviteCodeUI,
  showPlacementToastForChannel,
} from './player-controls.ts';
import { activateNoSleep } from '../core/wake-lock.ts';
import { selectStandardChannelButton } from './settings.ts';
import { setCurrentState } from '../core/aria-state.ts';

// ─── Constants ───────────────────────────────────────────────────
const TOTAL_OB_SLIDES = 4;
const OB_CAROUSEL_AUTOPLAY_DELAY_MS = 6000;
const OB_CAROUSEL_AUTOPLAY_TIMER = 'setup-ob-carousel-autoplay';
const OB_CAROUSEL_SWIPE_THRESHOLD_PX = 50;

export const BACK_SVG =
  '<svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>';

// ─── Shared State ────────────────────────────────────────────────

let _currentObSlide = 0;
let _setupOverlayEverShown = false;
let _pendingGuestRoleMode: number | null = null;
let _hostCodeFlowId = 0;
let _setupOverlayAbort: AbortController | null = null;
let _pendingAutoJoinCode: string | null = null;
let _obCarouselInitialized = false;
let _obCarouselUserStopped = false;
let _obCarouselHoverPaused = false;
let _obCarouselReducedMotion = false;
let _obCarouselGreetingReady = false;

// ─── State Accessors ─────────────────────────────────────────────

export function setCurrentObSlide(v: number): void {
  _currentObSlide = v;
}

export function getSetupOverlayEverShown(): boolean {
  return _setupOverlayEverShown;
}

export function getPendingGuestRoleMode(): number | null {
  return _pendingGuestRoleMode;
}
export function setPendingGuestRoleMode(v: number | null): void {
  _pendingGuestRoleMode = v;
}

export function getHostCodeFlowId(): number {
  return _hostCodeFlowId;
}
export function incrementHostCodeFlowId(): number {
  return ++_hostCodeFlowId;
}

export function getSetupOverlayAbort(): AbortController | null {
  return _setupOverlayAbort;
}
export function setSetupOverlayAbort(v: AbortController | null): void {
  _setupOverlayAbort = v;
}

export function getPendingAutoJoinCode(): string | null {
  return _pendingAutoJoinCode;
}
export function setPendingAutoJoinCode(v: string | null): void {
  _pendingAutoJoinCode = v;
}

/** Callback invoked when a role card is tapped in invite-link mode (set by setup-guest.ts) */
let _onInviteLinkRoleSelected: (() => void) | null = null;
export function setOnInviteLinkRoleSelected(fn: (() => void) | null): void {
  _onInviteLinkRoleSelected = fn;
}

// ─── Desktop Left Panel Sync ─────────────────────────────────────

let _desktopSyncedDiagram: HTMLElement | null = null;
let _desktopSyncedDiagramParent: HTMLElement | null = null;
let _desktopSyncedDiagramNextSibling: Node | null = null;

function isDesktopLayout(): boolean {
  return window.matchMedia('(min-width: 1280px)').matches || isCompactLandscape();
}

function _restoreDesktopDiagram(): void {
  if (_desktopSyncedDiagram && _desktopSyncedDiagramParent) {
    try {
      _desktopSyncedDiagramParent.insertBefore(
        _desktopSyncedDiagram,
        _desktopSyncedDiagramNextSibling || null,
      );
    } catch {
      /* ignore */
    }
  }
  _desktopSyncedDiagram = null;
  _desktopSyncedDiagramParent = null;
  _desktopSyncedDiagramNextSibling = null;
  const hc = document.getElementById('desktop-step-header');
  const dc = document.getElementById('desktop-diagram-area');
  if (hc) hc.replaceChildren();
  if (dc) dc.replaceChildren();
}

export function syncDesktopLeftPanel(): void {
  const headerContainer = document.getElementById('desktop-step-header');
  const diagramContainer = document.getElementById('desktop-diagram-area');
  if (!headerContainer || !diagramContainer) return;

  if (!isDesktopLayout()) {
    _restoreDesktopDiagram();
    return;
  }

  if (_desktopSyncedDiagram && _desktopSyncedDiagramParent) {
    try {
      _desktopSyncedDiagramParent.insertBefore(
        _desktopSyncedDiagram,
        _desktopSyncedDiagramNextSibling || null,
      );
    } catch {
      /* ignore */
    }
    _desktopSyncedDiagram = null;
    _desktopSyncedDiagramParent = null;
    _desktopSyncedDiagramNextSibling = null;
  }
  diagramContainer.replaceChildren();
  headerContainer.replaceChildren();

  const areas: Array<{ id: string; diagram: (el: HTMLElement) => HTMLElement | null }> = [
    { id: 'setup-welcome-area', diagram: () => document.getElementById('ob-slider-area') },
    {
      id: 'setup-role-area',
      diagram: (el) => el.querySelector('.setup-graphic-container') as HTMLElement | null,
    },
    {
      id: 'setup-join-area',
      diagram: (el) => el.querySelector('.setup-guide-unified') as HTMLElement | null,
    },
    { id: 'setup-auto-join-area', diagram: () => null },
    {
      id: 'setup-code-area',
      diagram: (el) => el.querySelector('.setup-guide-unified') as HTMLElement | null,
    },
  ];

  for (const area of areas) {
    const areaEl = document.getElementById(area.id) as HTMLElement | null;
    if (!areaEl || areaEl.style.display === 'none') continue;

    const headerSrc = areaEl.querySelector('.setup-header-text');
    if (headerSrc) headerContainer.innerHTML = headerSrc.innerHTML;

    const diagramEl = area.diagram(areaEl);
    if (diagramEl) {
      _desktopSyncedDiagramParent = diagramEl.parentElement as HTMLElement | null;
      _desktopSyncedDiagramNextSibling = diagramEl.nextSibling;
      _desktopSyncedDiagram = diagramEl;
      diagramContainer.appendChild(diagramEl);
    }
    break;
  }
}

// ─── Setup Helpers ───────────────────────────────────────────────

export function setupEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function scheduleSetupScrollbarReveal(): void {
  setManagedTimer(
    'setup-scrollbar-reveal',
    () => {
      const overlay = setupEl('setup-overlay');
      if (overlay?.classList.contains('active')) bus.emit('ui:scrollbar-reveal', overlay);
    },
    0,
  );
}

export function showSetupOverlay(): void {
  animateTransition(() => {
    const ov = setupEl('setup-overlay');
    if (ov) ov.classList.add('active');
    updateOverlayOpenClass();
    try {
      document.documentElement.classList.remove('setup-boot-block');
    } catch {
      /* ignore */
    }
    _setupOverlayEverShown = true;
    scheduleSetupScrollbarReveal();
    scheduleObCarouselAutoplay();
  });
}

export function hideSetupOverlay(): void {
  activateNoSleep();
  clearObCarouselAutoplayTimer();
  if (_setupOverlayAbort) {
    _setupOverlayAbort.abort();
    _setupOverlayAbort = null;
  }

  const overlay = setupEl('setup-overlay');
  if (overlay) overlay.classList.remove('active');
  updateOverlayOpenClass();
  try {
    document.documentElement.classList.remove('setup-boot-block');
  } catch {
    /* ignore */
  }
  try {
    requestAnimationFrame(() => {
      try {
        void document.documentElement.offsetHeight;
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }

  // Trigger entrance OUTSIDE animateTransition so CSS transitions work
  // (startViewTransition snapshots can swallow CSS transitions)
  requestAnimationFrame(() => bus.emit('setup:app-entrance'));
}

// Bare DOM-toggling primitives. Callers that change MULTIPLE areas in
// a row (role flow entry, welcome return, etc.) MUST wrap the batch in
// a single animateTransition(). Multiple startViewTransition() calls in one
// setup change supersede each other and produce aborted-transition errors.
export function setupShowCodeArea(show: boolean): void {
  const box = setupEl('setup-code-area');
  const becameVisible = !!box && show && box.style.display !== 'flex';
  if (box) box.style.display = show ? 'flex' : 'none';
  syncDesktopLeftPanel();
  if (becameVisible) scheduleSetupScrollbarReveal();
}

export function setupSetCode(code: string): void {
  animateTransition(() => {
    const el = setupEl('setup-code');
    if (el) {
      if (el.tagName === 'INPUT') (el as HTMLInputElement).value = code || '------';
      else el.textContent = code || '------';
    }
    setupShowCodeArea(!!code);
  });
}

export function setupShowJoinArea(show: boolean): void {
  const el = setupEl('setup-join-area');
  const becameVisible = !!el && show && el.style.display !== 'flex';
  if (el) el.style.display = show ? 'flex' : 'none';
  syncDesktopLeftPanel();
  if (becameVisible) scheduleSetupScrollbarReveal();
}

export function setupShowAutoJoinArea(show: boolean): void {
  const el = setupEl('setup-auto-join-area');
  const becameVisible = !!el && show && el.style.display !== 'flex';
  if (el) el.style.display = show ? 'flex' : 'none';
  syncDesktopLeftPanel();
  if (becameVisible) scheduleSetupScrollbarReveal();
}

export function setupSetAutoJoinCode(code: string): void {
  const el = setupEl('setup-auto-join-subtitle');
  if (el) el.textContent = t('setup.join_session_subtitle', { code });
}

export function setupShowRoleArea(show: boolean): void {
  const el = setupEl('setup-role-area');
  const becameVisible = !!el && show && el.style.display !== 'flex';
  if (el) el.style.display = show ? 'flex' : 'none';
  syncDesktopLeftPanel();
  if (becameVisible) scheduleSetupScrollbarReveal();
}

export function setupShowWelcome(show: boolean): void {
  const el = setupEl('setup-welcome-area');
  const becameVisible = !!el && show && el.style.display !== 'flex';
  if (el) el.style.display = show ? 'flex' : 'none';
  syncDesktopLeftPanel();
  if (show) scheduleObCarouselAutoplay();
  else clearObCarouselAutoplayTimer();
  if (becameVisible) scheduleSetupScrollbarReveal();
}

export function setupSetGuestJoinBusy(busy: boolean): void {
  const input = setupEl('setup-join-code') as HTMLInputElement | null;
  if (input) input.disabled = !!busy;

  const grid = setupEl('setup-role-grid') as HTMLElement | null;
  if (grid) {
    grid.style.pointerEvents = busy ? 'none' : 'auto';
    grid.style.opacity = busy ? '0.6' : '1';
  }
}

function setupSetInlineError(id: string, message: string | null): void {
  const error = setupEl(id);
  if (!error) return;
  const normalized = typeof message === 'string' ? message.trim() : '';
  error.textContent = normalized;
  error.hidden = normalized.length === 0;
}

export function setupSetHostError(message: string | null): void {
  setupSetInlineError('setup-host-error', message);
}

export function setupSetGuestJoinError(message: string | null, inviteLink = false): void {
  setupSetInlineError('setup-guest-error', inviteLink ? null : message);
  setupSetInlineError('setup-auto-join-error', inviteLink ? message : null);

  const input = setupEl('setup-join-code');
  if (input) {
    if (message && !inviteLink) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

export function setupHighlightJoinRole(mode: number | null): void {
  const opts = document.querySelectorAll<HTMLElement>('#setup-role-grid .ch-opt[data-join-ch]');
  opts.forEach((option) => {
    const selected = mode !== null && Number(option.dataset.joinCh) === mode;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-pressed', String(selected));
  });

  const speakers = document.querySelectorAll<HTMLElement>('.setup-graphic-svg .graphic-speaker');
  speakers.forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.roleMode) === mode);
  });
}

// ─── Button Rendering ────────────────────────────────────────────

interface SetupButton {
  id: string;
  text?: string;
  html?: string;
  ariaLabel?: string;
  kind?: 'primary' | 'secondary' | 'text-link' | 'icon-only';
  disabled?: boolean;
  onClick?: (() => void) | null;
}

export function setupRenderActions(
  buttons: SetupButton[],
  layout: 'row' | 'vertical' | 'horizontal-with-back' = 'row',
): void {
  const area = setupEl('setup-actions');
  if (!area) return;
  area.replaceChildren();

  area.classList.remove('vertical', 'horizontal-with-back');
  if (layout === 'vertical') area.classList.add('vertical');
  else if (layout === 'horizontal-with-back') area.classList.add('horizontal-with-back');

  buttons.forEach((btn) => {
    const b = document.createElement('button');
    b.id = btn.id;
    b.type = 'button';

    if (btn.kind === 'secondary') b.className = 'btn-ob-secondary';
    else if (btn.kind === 'text-link') b.className = 'btn-ob-text-link';
    else if (btn.kind === 'icon-only') b.className = 'btn-ob-icon';
    else b.className = 'btn-ob-primary';

    if (btn.html) b.innerHTML = btn.html;
    else if (btn.text) b.textContent = btn.text;
    if (btn.ariaLabel) b.setAttribute('aria-label', btn.ariaLabel);

    if (btn.disabled) b.disabled = true;
    if (btn.onClick) b.addEventListener('click', btn.onClick);
    area.appendChild(b);
  });
}

// ─── Onboarding Slider ──────────────────────────────────────────

function clearObCarouselAutoplayTimer(): void {
  clearManagedTimer(OB_CAROUSEL_AUTOPLAY_TIMER);
}

function isObCarouselWelcomeVisible(): boolean {
  const overlay = setupEl('setup-overlay');
  const welcome = setupEl('setup-welcome-area');
  return (
    !!overlay?.classList.contains('active') &&
    !!welcome &&
    !welcome.hidden &&
    welcome.style.display !== 'none'
  );
}

function canScheduleObCarouselAutoplay(): boolean {
  return (
    _obCarouselInitialized &&
    _obCarouselGreetingReady &&
    !_obCarouselUserStopped &&
    !_obCarouselReducedMotion &&
    !_obCarouselHoverPaused &&
    !document.hidden &&
    isObCarouselWelcomeVisible()
  );
}

function hasHoverCapableInput(): boolean {
  try {
    return window.matchMedia('(any-hover: hover)').matches;
  } catch {
    return false;
  }
}

function updateObCarouselA11y(): void {
  const track = setupEl('ob-slider-track');
  const autoplayEligible = !_obCarouselUserStopped && !_obCarouselReducedMotion;
  if (track) track.setAttribute('aria-live', autoplayEligible ? 'off' : 'polite');

  document.querySelectorAll<HTMLElement>('.ob-dot').forEach((dot, idx) => {
    const position = `${idx + 1} / ${TOTAL_OB_SLIDES}`;
    dot.setAttribute(
      'aria-label',
      autoplayEligible ? `${position} \u2014 ${t('setup.carousel_pause')}` : position,
    );
  });
}

function scheduleObCarouselAutoplay(): void {
  // A named one-shot timer gives every resume a fresh dwell and cannot catch
  // up multiple slides after a background-tab throttle.
  clearObCarouselAutoplayTimer();
  if (!canScheduleObCarouselAutoplay()) return;

  setManagedTimer(
    OB_CAROUSEL_AUTOPLAY_TIMER,
    () => {
      if (!canScheduleObCarouselAutoplay()) return;
      nextObSlide(true);
    },
    OB_CAROUSEL_AUTOPLAY_DELAY_MS,
  );
}

function stopObCarouselForUser(): void {
  _obCarouselUserStopped = true;
  updateObCarouselA11y();
  clearObCarouselAutoplayTimer();
}

export function notifyObCarouselGreetingReady(): void {
  _obCarouselGreetingReady = true;
  scheduleObCarouselAutoplay();
}

/**
 * Bind the welcome carousel for one setup-overlay lifetime.
 * Manual, focus, and touch interaction is a sticky stop for this welcome
 * visit. Hover and page visibility only suspend rotation temporarily.
 */
export function initObCarousel(signal: AbortSignal): void {
  clearObCarouselAutoplayTimer();
  _obCarouselInitialized = true;
  _obCarouselUserStopped = false;
  _obCarouselHoverPaused = false;
  const greetingRows = document.querySelectorAll<HTMLElement>('.setup-greeting-row');
  _obCarouselGreetingReady =
    greetingRows.length === 0 ||
    Array.from(greetingRows).some((row) => row.classList.contains('is-visible'));

  let reducedMotionQuery: MediaQueryList | null = null;
  try {
    reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  } catch {
    /* matchMedia is absent only in old or synthetic DOMs */
  }
  _obCarouselReducedMotion = reducedMotionQuery?.matches === true;

  const handleReducedMotionChange = (event: MediaQueryListEvent): void => {
    _obCarouselReducedMotion = event.matches;
    updateObCarouselA11y();
    if (event.matches) clearObCarouselAutoplayTimer();
    else scheduleObCarouselAutoplay();
  };
  let removeReducedMotionListener = (): void => undefined;
  if (reducedMotionQuery) {
    if (typeof reducedMotionQuery.addEventListener === 'function') {
      reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
      removeReducedMotionListener = () =>
        reducedMotionQuery?.removeEventListener('change', handleReducedMotionChange);
    } else {
      reducedMotionQuery.addListener(handleReducedMotionChange);
      removeReducedMotionListener = () =>
        reducedMotionQuery?.removeListener(handleReducedMotionChange);
    }
  }

  const area = setupEl('ob-slider-area');
  const btnNext = setupEl('ob-next');
  const btnPrev = setupEl('ob-prev');

  btnNext?.addEventListener('click', () => nextObSlide(false), { signal });
  btnPrev?.addEventListener('click', () => prevObSlide(false), { signal });

  document.querySelectorAll<HTMLElement>('.ob-dot').forEach((dot) => {
    dot.addEventListener(
      'click',
      (event) => {
        const dotEl = (event.target as HTMLElement).closest('.ob-dot') as HTMLElement | null;
        const idx = Number.parseInt(dotEl?.dataset.idx ?? '', 10);
        if (Number.isNaN(idx)) return;
        stopObCarouselForUser();
        setCurrentObSlide(idx);
        updateObSlider();
      },
      { signal },
    );
  });

  area?.addEventListener(
    'mouseenter',
    () => {
      if (!hasHoverCapableInput()) return;
      _obCarouselHoverPaused = true;
      clearObCarouselAutoplayTimer();
    },
    { signal },
  );
  area?.addEventListener(
    'mouseleave',
    () => {
      _obCarouselHoverPaused = false;
      scheduleObCarouselAutoplay();
    },
    { signal },
  );
  area?.addEventListener('focusin', stopObCarouselForUser, { signal });

  let touchStartX: number | null = null;
  const viewport = setupEl('ob-slider-viewport');
  if (viewport) {
    viewport.addEventListener(
      'touchstart',
      (event) => {
        touchStartX = (event as TouchEvent).touches[0]?.clientX ?? null;
        stopObCarouselForUser();
      },
      { passive: true, signal },
    );
    viewport.addEventListener(
      'touchend',
      (event) => {
        const endX = (event as TouchEvent).changedTouches[0]?.clientX;
        const diff = touchStartX != null && endX != null ? touchStartX - endX : 0;
        touchStartX = null;
        if (Math.abs(diff) > OB_CAROUSEL_SWIPE_THRESHOLD_PX) {
          if (diff > 0) nextObSlide(false);
          else prevObSlide(false);
        }
      },
      { signal },
    );
    viewport.addEventListener(
      'touchcancel',
      () => {
        touchStartX = null;
      },
      { signal },
    );
  }

  document.addEventListener(
    'visibilitychange',
    () => {
      // Browsers may omit mouseleave/touchcancel while a page is backgrounded.
      // Normalize those transient inputs so a stale gesture cannot suppress
      // rotation forever or turn a late touchend into an accidental swipe.
      touchStartX = null;
      if (document.hidden) {
        _obCarouselHoverPaused = false;
        clearObCarouselAutoplayTimer();
        return;
      }

      _obCarouselHoverPaused = hasHoverCapableInput() && area?.matches(':hover') === true;
      scheduleObCarouselAutoplay();
    },
    { signal },
  );

  const unsubscribeLanguageChange = bus.on('i18n:changed', updateObCarouselA11y);

  const dispose = () => {
    unsubscribeLanguageChange();
    removeReducedMotionListener();
    clearObCarouselAutoplayTimer();
    _obCarouselInitialized = false;
    _obCarouselHoverPaused = false;
    touchStartX = null;
    _obCarouselGreetingReady = false;
  };
  signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) {
    dispose();
    return;
  }

  updateObCarouselA11y();
  scheduleObCarouselAutoplay();
}

export function updateObSlider(): void {
  const track = setupEl('ob-slider-track');
  const dots = document.querySelectorAll('.ob-dot');
  if (!track) return;

  (track as HTMLElement).style.transform = `translateX(-${_currentObSlide * 100}%)`;
  dots.forEach((dot, idx) => {
    setCurrentState(dot, idx === _currentObSlide);
  });

  // Fade in/out slide content
  const slides = track.querySelectorAll('.ob-slide');
  slides.forEach((slide, idx) => {
    const current = idx === _currentObSlide;
    slide.classList.toggle('active', current);
    slide.setAttribute('aria-hidden', String(!current));
    if (slide instanceof HTMLElement) slide.inert = !current;
    slide.toggleAttribute('inert', !current);
  });
}

function nextObSlide(isAuto = false): void {
  if (!isAuto) stopObCarouselForUser();
  if (_currentObSlide < TOTAL_OB_SLIDES - 1) _currentObSlide++;
  else _currentObSlide = 0;
  updateObSlider();
  if (isAuto) scheduleObCarouselAutoplay();
}

function prevObSlide(isAuto = false): void {
  if (!isAuto) stopObCarouselForUser();
  if (_currentObSlide > 0) _currentObSlide--;
  else _currentObSlide = TOTAL_OB_SLIDES - 1;
  updateObSlider();
  if (isAuto) scheduleObCarouselAutoplay();
}

// ─── Role Selection Helpers ──────────────────────────────────────

export function handleSetupRolePreview(mode: number): void {
  const appRole = getState('network.appRole');
  if (appRole !== 'guest' && appRole !== 'host') return;
  // This preview is visual-only and does not change the join path. Any UI that
  // exposes role choices must also update setPendingGuestRoleMode and emit
  // audio:set-channel-mode.
  setupHighlightJoinRole(mode);
  showPlacementToastForChannel(mode);

  // Invite-link flow: re-render actions to enable the "Start" button
  if (_pendingAutoJoinCode && _onInviteLinkRoleSelected) {
    _onInviteLinkRoleSelected();
    return;
  }

  // Normal flow: upgrade "Next" button from secondary to primary
  const nextBtn = document.getElementById('btn-setup-next');
  if (nextBtn) {
    nextBtn.classList.remove('btn-ob-secondary');
    nextBtn.classList.add('btn-ob-primary');
  }
}

// ─── Re-exported utilities (convenience for sub-modules) ─────────

export {
  t,
  bus,
  getState,
  showToast,
  updateRoleBadge,
  updateInviteCodeUI,
  activateNoSleep,
  selectStandardChannelButton,
};

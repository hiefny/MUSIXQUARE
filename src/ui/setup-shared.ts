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
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
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

// ─── Constants ───────────────────────────────────────────────────
export const TOTAL_OB_SLIDES = 4;

export const BACK_SVG =
  '<svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>';

// ─── Shared State ────────────────────────────────────────────────

let _currentObSlide = 0;
let _setupOverlayEverShown = false;
let _pendingSetupRole: number | null = null;
let _pendingGuestRoleMode: number | null = null;
let _hostCodeFlowId = 0;
let _setupOverlayAbort: AbortController | null = null;
let _pendingAutoJoinCode: string | null = null;

// ─── State Accessors ─────────────────────────────────────────────

export function getCurrentObSlide(): number {
  return _currentObSlide;
}
export function setCurrentObSlide(v: number): void {
  _currentObSlide = v;
}

export function getSetupOverlayEverShown(): boolean {
  return _setupOverlayEverShown;
}

export function getPendingSetupRole(): number | null {
  return _pendingSetupRole;
}
export function setPendingSetupRole(v: number | null): void {
  _pendingSetupRole = v;
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
export function getOnInviteLinkRoleSelected(): (() => void) | null {
  return _onInviteLinkRoleSelected;
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
  });
}

export function hideSetupOverlay(): void {
  activateNoSleep();
  if (_setupOverlayAbort) {
    _setupOverlayAbort.abort();
    _setupOverlayAbort = null;
  }

  const overlay = setupEl('setup-overlay');
  if (overlay) overlay.classList.remove('active');
  updateOverlayOpenClass();
  stopObAutoSlide();
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
// a single animateTransition() — each area function used to self-wrap,
// which meant a 4-step setup transition kicked off 4 separate
// startViewTransition() calls, with each superseding/aborting the last
// and spamming "InvalidStateError: Transition was aborted" rejections.
export function setupShowCodeArea(show: boolean): void {
  const box = setupEl('setup-code-area');
  if (box) box.style.display = show ? 'flex' : 'none';
  syncDesktopLeftPanel();
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
  if (el) el.style.display = show ? 'flex' : 'none';
  syncDesktopLeftPanel();
}

export function setupShowAutoJoinArea(show: boolean): void {
  const el = setupEl('setup-auto-join-area');
  if (el) el.style.display = show ? 'flex' : 'none';
  syncDesktopLeftPanel();
}

export function setupSetAutoJoinCode(code: string): void {
  const el = setupEl('setup-auto-join-subtitle');
  if (el) el.textContent = t('setup.join_session_subtitle', { code });
}

export function setupShowRoleArea(show: boolean): void {
  const el = setupEl('setup-role-area');
  if (el) el.style.display = show ? 'flex' : 'none';
  syncDesktopLeftPanel();
}

export function setupShowWelcome(show: boolean): void {
  const el = setupEl('setup-welcome-area');
  if (el) el.style.display = show ? 'flex' : 'none';
  syncDesktopLeftPanel();
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

export function setupHighlightJoinRole(mode: number | null): void {
  const opts = document.querySelectorAll<HTMLElement>('#setup-role-grid .ch-opt[data-join-ch]');
  opts.forEach((o) => o.classList.remove('selected'));
  if (mode !== null && mode !== undefined) {
    const el = document.querySelector(`#setup-role-grid .ch-opt[data-join-ch="${mode}"]`);
    if (el) el.classList.add('selected');
  }

  const speakers = document.querySelectorAll<HTMLElement>('.setup-graphic-svg .graphic-speaker');
  speakers.forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.roleMode) === mode);
  });
}

// ─── Button Rendering ────────────────────────────────────────────

export interface SetupButton {
  id: string;
  text?: string;
  html?: string;
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

    if (btn.disabled) b.disabled = true;
    if (btn.onClick) b.addEventListener('click', btn.onClick);
    area.appendChild(b);
  });
}

// ─── Onboarding Slider ──────────────────────────────────────────

export function startObAutoSlide(): void {
  stopObAutoSlide();
  setManagedTimer(
    'obAutoSlideTimer',
    () => {
      nextObSlide(true);
    },
    5000,
    { interval: true },
  );
}

export function stopObAutoSlide(): void {
  clearManagedTimer('obAutoSlideTimer');
}

export function updateObSlider(): void {
  const track = setupEl('ob-slider-track');
  const dots = document.querySelectorAll('.ob-dot');
  if (!track) return;

  (track as HTMLElement).style.transform = `translateX(-${_currentObSlide * 100}%)`;
  dots.forEach((dot, idx) => {
    dot.classList.toggle('active', idx === _currentObSlide);
  });

  // Fade in/out slide content
  const slides = track.querySelectorAll('.ob-slide');
  slides.forEach((slide, idx) => {
    slide.classList.toggle('active', idx === _currentObSlide);
  });
}

export function nextObSlide(isAuto = false): void {
  if (_currentObSlide < TOTAL_OB_SLIDES - 1) _currentObSlide++;
  else _currentObSlide = 0;
  updateObSlider();
  if (isAuto !== true) startObAutoSlide();
}

export function prevObSlide(): void {
  if (_currentObSlide > 0) _currentObSlide--;
  else _currentObSlide = TOTAL_OB_SLIDES - 1;
  updateObSlider();
  startObAutoSlide();
}

// ─── Role Selection Helpers ──────────────────────────────────────

export function handleSetupRolePreview(mode: number): void {
  const appRole = getState('network.appRole');
  if (appRole !== 'guest' && appRole !== 'host') return;
  _pendingSetupRole = mode;
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

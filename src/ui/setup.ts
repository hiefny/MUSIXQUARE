/**
 * MUSIXQUARE 2.0 — Setup Flow (UI)
 * Extracted from original app.js lines 2123-3062
 *
 * Manages: Setup overlay, host/guest role selection, onboarding slider,
 * invite code display, desktop left-panel sync.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { animateTransition, updateOverlayOpenClass } from './dom.ts';
import { showToast } from './toast.ts';
import { showDialog } from './dialog.ts';
import {
  updateRoleBadge, updateInviteCodeUI,
  showPlacementToastForChannel,
} from './player-controls.ts';
import { selectStandardChannelButton } from './settings.ts';
import { createHostSessionWithShortCode, leaveSession } from '../network/peer.ts';
import { joinSession } from '../network/peer.ts';
import type { DataConnection } from '../types/index.ts';

// ─── Constants ───────────────────────────────────────────────────

const PEER_NAME_PREFIX = 'Peer';
const TOTAL_OB_SLIDES = 4;

// ─── State ───────────────────────────────────────────────────────

let _currentObSlide = 0;
let _setupOverlayEverShown = false;
let _pendingSetupRole: number | null = null;
let _pendingGuestRoleMode: number | null = null;

// ─── Desktop Left Panel Sync ─────────────────────────────────────

let _desktopSyncedDiagram: HTMLElement | null = null;
let _desktopSyncedDiagramParent: HTMLElement | null = null;
let _desktopSyncedDiagramNextSibling: Node | null = null;

function isDesktopLayout(): boolean {
  return window.matchMedia('(min-width: 1280px)').matches;
}

function _restoreDesktopDiagram(): void {
  if (_desktopSyncedDiagram && _desktopSyncedDiagramParent) {
    try {
      _desktopSyncedDiagramParent.insertBefore(_desktopSyncedDiagram, _desktopSyncedDiagramNextSibling || null);
    } catch { /* ignore */ }
  }
  _desktopSyncedDiagram = null;
  _desktopSyncedDiagramParent = null;
  _desktopSyncedDiagramNextSibling = null;
  const hc = document.getElementById('desktop-step-header');
  const dc = document.getElementById('desktop-diagram-area');
  if (hc) hc.innerHTML = '';
  if (dc) dc.innerHTML = '';
}

function syncDesktopLeftPanel(): void {
  const headerContainer = document.getElementById('desktop-step-header');
  const diagramContainer = document.getElementById('desktop-diagram-area');
  if (!headerContainer || !diagramContainer) return;

  if (!isDesktopLayout()) {
    _restoreDesktopDiagram();
    return;
  }

  if (_desktopSyncedDiagram && _desktopSyncedDiagramParent) {
    try {
      _desktopSyncedDiagramParent.insertBefore(_desktopSyncedDiagram, _desktopSyncedDiagramNextSibling || null);
    } catch { /* ignore */ }
    _desktopSyncedDiagram = null;
    _desktopSyncedDiagramParent = null;
    _desktopSyncedDiagramNextSibling = null;
  }
  diagramContainer.innerHTML = '';
  headerContainer.innerHTML = '';

  const areas: Array<{ id: string; diagram: (el: HTMLElement) => HTMLElement | null }> = [
    { id: 'setup-welcome-area', diagram: () => document.getElementById('ob-slider-area') },
    { id: 'setup-role-area', diagram: (el) => el.querySelector('.setup-graphic-container') as HTMLElement | null },
    { id: 'setup-join-area', diagram: (el) => el.querySelector('.setup-guide-unified') as HTMLElement | null },
    { id: 'setup-code-area', diagram: (el) => el.querySelector('.setup-guide-unified') as HTMLElement | null },
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

function setupEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function showSetupOverlay(): void {
  animateTransition(() => {
    const ov = setupEl('setup-overlay');
    if (ov) ov.classList.add('active');
    updateOverlayOpenClass();
    try { document.documentElement.classList.remove('setup-boot-block'); } catch { /* ignore */ }
    _setupOverlayEverShown = true;
  });
}

function hideSetupOverlay(): void {
  animateTransition(() => {
    const overlay = setupEl('setup-overlay');
    if (overlay) overlay.classList.remove('active');
    updateOverlayOpenClass();
    stopObAutoSlide();
    try { document.documentElement.classList.remove('setup-boot-block'); } catch { /* ignore */ }
    try {
      requestAnimationFrame(() => {
        try { void document.documentElement.offsetHeight; } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
  });
}

function setupShowCodeArea(show: boolean): void {
  animateTransition(() => {
    const box = setupEl('setup-code-area');
    if (box) box.style.display = show ? 'flex' : 'none';
    syncDesktopLeftPanel();
  });
}

function setupSetCode(code: string): void {
  const el = setupEl('setup-code');
  if (el) {
    if (el.tagName === 'INPUT') (el as HTMLInputElement).value = code || '------';
    else el.textContent = code || '------';
  }
  setupShowCodeArea(!!code);
}

function setupShowInstruction(show: boolean, text = ''): void {
  const el = setupEl('setup-instruction');
  if (!el) return;
  el.style.display = show ? 'block' : 'none';
  el.textContent = text || '';
}

function setupShowJoinArea(show: boolean): void {
  animateTransition(() => {
    const el = setupEl('setup-join-area');
    if (el) el.style.display = show ? 'flex' : 'none';
    syncDesktopLeftPanel();
  });
}

function setupShowRoleArea(show: boolean): void {
  animateTransition(() => {
    const el = setupEl('setup-role-area');
    if (el) el.style.display = show ? 'flex' : 'none';
    syncDesktopLeftPanel();
  });
}

function setupShowWelcome(show: boolean): void {
  animateTransition(() => {
    const el = setupEl('setup-welcome-area');
    if (el) el.style.display = show ? 'flex' : 'none';
    syncDesktopLeftPanel();
  });
}

function setupSetGuestJoinBusy(busy: boolean): void {
  const input = setupEl('setup-join-code') as HTMLInputElement | null;
  if (input) input.disabled = !!busy;

  const grid = setupEl('setup-role-grid') as HTMLElement | null;
  if (grid) {
    grid.style.pointerEvents = busy ? 'none' : 'auto';
    grid.style.opacity = busy ? '0.6' : '1';
  }
}

function setupHighlightJoinRole(mode: number | null): void {
  const opts = document.querySelectorAll<HTMLElement>('#setup-role-grid .ch-opt[data-join-ch]');
  opts.forEach(o => o.classList.remove('selected'));
  if (mode !== null && mode !== undefined) {
    const el = document.querySelector(`#setup-role-grid .ch-opt[data-join-ch="${mode}"]`);
    if (el) el.classList.add('selected');
  }

  const speakers = document.querySelectorAll<HTMLElement>('.setup-graphic-svg .graphic-speaker');
  speakers.forEach(el => el.classList.remove('active'));

  let targetId: string | null = null;
  if (mode === -1) targetId = 'svg-spk-l';
  else if (mode === 1) targetId = 'svg-spk-r';
  else if (mode === 0) targetId = 'svg-spk-center';
  else if (mode === 2) targetId = 'svg-spk-woofer';

  if (targetId) {
    const spk = document.getElementById(targetId);
    if (spk) spk.classList.add('active');
  }
}

// ─── Button Rendering ────────────────────────────────────────────

interface SetupButton {
  id: string;
  text?: string;
  html?: string;
  kind?: 'primary' | 'secondary' | 'text-link' | 'icon-only';
  disabled?: boolean;
  onClick?: (() => void) | null;
}

function setupRenderActions(buttons: SetupButton[], layout: 'row' | 'vertical' | 'horizontal-with-back' = 'row'): void {
  const area = setupEl('setup-actions');
  if (!area) return;
  area.innerHTML = '';

  area.classList.remove('vertical', 'horizontal-with-back');
  if (layout === 'vertical') area.classList.add('vertical');
  else if (layout === 'horizontal-with-back') area.classList.add('horizontal-with-back');

  buttons.forEach(btn => {
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

const BACK_SVG = '<svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>';

// ─── Onboarding Slider ──────────────────────────────────────────

function startObAutoSlide(): void {
  stopObAutoSlide();
  setManagedTimer('obAutoSlideTimer', () => {
    nextObSlide(true);
  }, 5000, { interval: true });
}

function stopObAutoSlide(): void {
  clearManagedTimer('obAutoSlideTimer');
}

function updateObSlider(): void {
  const track = setupEl('ob-slider-track');
  const dots = document.querySelectorAll('.ob-dot');
  if (!track) return;

  (track as HTMLElement).style.transform = `translateX(-${_currentObSlide * 100}%)`;
  dots.forEach((dot, idx) => {
    dot.classList.toggle('active', idx === _currentObSlide);
  });
}

function nextObSlide(isAuto = false): void {
  if (_currentObSlide < TOTAL_OB_SLIDES - 1) _currentObSlide++;
  else _currentObSlide = 0;
  updateObSlider();
  if (isAuto !== true) startObAutoSlide();
}

function prevObSlide(): void {
  if (_currentObSlide > 0) _currentObSlide--;
  else _currentObSlide = TOTAL_OB_SLIDES - 1;
  updateObSlider();
  startObAutoSlide();
}

// ─── Role Selection Buttons ──────────────────────────────────────

function showRoleSelectionButtons(): void {
  setupRenderActions([
    { id: 'btn-setup-host', text: '제가 방장할래요', kind: 'primary', onClick: startHostFlow },
    { id: 'btn-setup-guest', text: '모임에 참여할래요', kind: 'secondary', onClick: startGuestFlow },
  ], 'vertical');
}

// ─── Handle Role Preview ─────────────────────────────────────────

function handleSetupRolePreview(mode: number): void {
  const appRole = getState<string>('network.appRole');
  if (appRole !== 'guest' && appRole !== 'host') return;
  _pendingSetupRole = mode;
  setupHighlightJoinRole(mode);
  showPlacementToastForChannel(mode);

  const nextBtn = document.getElementById('btn-setup-next');
  if (nextBtn) {
    nextBtn.classList.remove('btn-ob-secondary');
    nextBtn.classList.add('btn-ob-primary');
  }
}

// ─── Host Flow ───────────────────────────────────────────────────

function startHostFlow(): void {
  bus.emit('audio:activate');

  setState('network.appRole', 'host');
  setState('setup.sessionStarted', false);
  _pendingSetupRole = null;

  setupShowJoinArea(false);
  setupShowCodeArea(false);
  setupShowWelcome(false);
  setupShowRoleArea(true);
  setupShowInstruction(false);
  setupHighlightJoinRole(null);

  const sliderArea = setupEl('ob-slider-area');
  if (sliderArea) {
    sliderArea.style.display = 'none';
    stopObAutoSlide();
  }

  setupRenderActions([
    { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => initSetupOverlay() },
    {
      id: 'btn-setup-next', text: '다음으로', kind: 'primary',
      onClick: () => {
        if (_pendingSetupRole !== null) proceedToHostCode(_pendingSetupRole);
        else showToast('역할을 선택해주세요');
      },
    },
  ], 'horizontal-with-back');
}

async function proceedToHostCode(mode: number): Promise<void> {
  const appRole = getState<string>('network.appRole');
  if (appRole !== 'host') return;

  try {
    selectStandardChannelButton(mode);
    bus.emit('audio:set-channel-mode', mode);
  } catch (e) { log.warn(e); }

  setupShowRoleArea(false);
  setupShowCodeArea(true);

  const codeEl = setupEl('setup-code');
  if (codeEl) {
    if (codeEl.tagName === 'INPUT') (codeEl as HTMLInputElement).value = '------';
    else codeEl.textContent = '------';
  }

  setupRenderActions([
    { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => startHostFlow() },
    { id: 'btn-setup-confirm', text: '잠시만요...', kind: 'secondary', disabled: true },
  ], 'horizontal-with-back');

  try {
    const code = await createHostSessionWithShortCode();

    setState('network.sessionCode', code);
    setupSetCode(code);
    updateInviteCodeUI();
    setState('network.myDeviceLabel', 'HOST');
    updateRoleBadge();
    setupShowInstruction(false);

    setupRenderActions([
      { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => startHostFlow() },
      { id: 'btn-setup-confirm', text: '시작하기', kind: 'primary', onClick: () => startSessionFromHost() },
    ], 'horizontal-with-back');
  } catch (e) {
    log.error('[Setup] Host session init failed', e);
    showToast('세션을 만들지 못했어요');
    startHostFlow();
  }
}

function startSessionFromHost(): void {
  const appRole = getState<string>('network.appRole');
  if (appRole !== 'host') return;

  setState('setup.sessionStarted', true);
  hideSetupOverlay();
  showToast('초대 코드는 설정과 도움말에서 확인할 수 있어요');
  updateRoleBadge();

  setTimeout(() => {
    const btn = document.getElementById('btn-media-source');
    if (btn) {
      btn.classList.add('blink-hint');
      btn.addEventListener('animationend', () => {
        btn.classList.remove('blink-hint');
      }, { once: true });
    }
  }, 400);
}

// ─── Guest Flow ──────────────────────────────────────────────────

function startGuestFlow(): void {
  bus.emit('audio:activate');

  setState('network.appRole', 'guest');
  setState('setup.sessionStarted', false);
  _pendingSetupRole = null;

  updateInviteCodeUI();

  setupShowCodeArea(false);
  setupShowJoinArea(false);
  setupShowWelcome(false);
  setupShowRoleArea(true);
  setupShowInstruction(false);
  setupHighlightJoinRole(null);
  setupSetGuestJoinBusy(false);

  const sliderArea = setupEl('ob-slider-area');
  if (sliderArea) {
    sliderArea.style.display = 'none';
    stopObAutoSlide();
  }

  setupRenderActions([
    { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => initSetupOverlay() },
    {
      id: 'btn-setup-next', text: '다음으로', kind: 'primary',
      onClick: () => {
        if (_pendingSetupRole !== null) proceedToGuestCode(_pendingSetupRole);
        else showToast('역할을 선택해주세요');
      },
    },
  ], 'horizontal-with-back');

  setState('network.myDeviceLabel', '참가자');
  updateRoleBadge();
}

function proceedToGuestCode(mode: number): void {
  _pendingGuestRoleMode = mode;

  setupShowRoleArea(false);
  setupShowJoinArea(true);
  setupShowInstruction(false);

  setupRenderActions([
    { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => startGuestFlow() },
    { id: 'btn-setup-confirm', text: '시작하기', kind: 'primary', onClick: () => handleSetupJoinWithRole(_pendingGuestRoleMode!) },
  ], 'horizontal-with-back');

  const input = setupEl('setup-join-code') as HTMLInputElement | null;
  if (input) {
    input.value = '';
    input.focus();
  }
}

async function handleSetupJoinWithRole(mode: number | null): Promise<void> {
  if (mode === null || mode === undefined) {
    showToast('역할을 선택해 주세요');
    return;
  }

  const appRole = getState<string>('network.appRole');
  if (appRole !== 'guest') return;

  const input = setupEl('setup-join-code') as HTMLInputElement | null;
  const codeRaw = (input ? input.value : '').trim();
  const code = codeRaw.replace(/\s+/g, '');

  if (!/^\d{6}$/.test(code)) {
    showToast('6자리 코드를 입력해 주세요');
    if (input) input.focus();
    return;
  }

  setState('network.lastJoinCode', code);
  updateInviteCodeUI();

  try {
    selectStandardChannelButton(mode);
    bus.emit('audio:set-channel-mode', mode);
  } catch (e) { log.warn('[Setup] setChannelMode failed', e); }

  setState('network.myDeviceLabel', PEER_NAME_PREFIX);
  updateRoleBadge();

  setupSetGuestJoinBusy(true);
  setState('network.isConnecting', true);
  updateRoleBadge();

  setupRenderActions([
    { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => startGuestFlow() },
    { id: 'btn-setup-confirm', text: '참가하는 중...', kind: 'primary', disabled: true },
  ], 'horizontal-with-back');

  joinSession(code);
}

// ─── Init ────────────────────────────────────────────────────────

function initSetupOverlay(): void {
  const sliderArea = setupEl('ob-slider-area');
  if (sliderArea) sliderArea.style.display = 'block';

  setupShowCodeArea(false);
  setupShowJoinArea(false);
  setupShowRoleArea(false);
  setupShowWelcome(true);
  setupShowInstruction(false, '');
  setupSetGuestJoinBusy(false);

  setState('network.appRole', 'idle');
  setState('network.sessionCode', '');
  _currentObSlide = 0;
  setState('setup.sessionStarted', false);
  _pendingSetupRole = null;
  _pendingGuestRoleMode = null;

  updateRoleBadge();
  updateObSlider();
  showRoleSelectionButtons();

  const showAndStart = () => {
    try { bus.emit('platform:freeze-layout'); } catch { /* ignore */ }
    showSetupOverlay();
    startObAutoSlide();
  };

  if (!_setupOverlayEverShown) {
    try { document.documentElement.classList.add('setup-boot-block'); } catch { /* ignore */ }
  }
  showAndStart();

  // Bind slider events
  const btnNext = setupEl('ob-next');
  if (btnNext) btnNext.onclick = () => nextObSlide(false);
  const btnPrev = setupEl('ob-prev');
  if (btnPrev) btnPrev.onclick = () => prevObSlide();

  document.querySelectorAll<HTMLElement>('.ob-dot').forEach(dot => {
    dot.onclick = (e) => {
      const dotEl = (e.target as HTMLElement).closest('.ob-dot') as HTMLElement | null;
      const idx = parseInt(dotEl?.dataset?.idx || '', 10);
      if (isNaN(idx)) return;
      _currentObSlide = idx;
      updateObSlider();
      startObAutoSlide();
    };
  });

  // Swipe
  const viewport = setupEl('ob-slider-viewport');
  if (viewport) {
    let startX = 0;
    viewport.ontouchstart = (e) => { startX = (e as TouchEvent).touches?.[0]?.clientX ?? 0; };
    viewport.ontouchend = (e) => {
      const endX = (e as TouchEvent).changedTouches?.[0]?.clientX;
      if (endX === undefined) return;
      const diff = startX - endX;
      if (Math.abs(diff) > 50) {
        if (diff > 0) nextObSlide(false);
        else prevObSlide();
      }
    };
  }
}

export function initSetup(): void {
  // Desktop layout listener
  try {
    const mql = window.matchMedia('(min-width: 1280px)');
    mql.addEventListener('change', () => syncDesktopLeftPanel());
  } catch { /* ignore */ }

  // Role grid click handler (event delegation)
  const roleGrid = document.getElementById('setup-role-grid');
  if (roleGrid) {
    roleGrid.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.ch-opt') as HTMLElement | null;
      if (!item) return;
      const mode = parseInt(item.dataset.joinCh || '', 10);
      if (isNaN(mode)) return;
      handleSetupRolePreview(mode);
    });
  }

  // SVG speaker click
  function handleSpeakerClick(e: Event): void {
    const item = (e.target as HTMLElement).closest('.graphic-speaker') as HTMLElement | null;
    if (!item) return;
    const SVG_ID_TO_MODE: Record<string, number> = { 'svg-spk-l': -1, 'svg-spk-r': 1, 'svg-spk-center': 0, 'svg-spk-woofer': 2 };
    const mode = SVG_ID_TO_MODE[item.id];
    if (mode !== undefined) handleSetupRolePreview(mode);
  }

  const roleArea = document.getElementById('setup-role-area');
  if (roleArea) roleArea.addEventListener('click', handleSpeakerClick);
  const desktopDiagramArea = document.getElementById('desktop-diagram-area');
  if (desktopDiagramArea) desktopDiagramArea.addEventListener('click', handleSpeakerClick);

  // Setup join code input
  const joinInput = document.getElementById('setup-join-code') as HTMLInputElement | null;
  if (joinInput) {
    joinInput.addEventListener('input', () => {
      const raw = joinInput.value || '';
      const digits = raw.replace(/\D+/g, '').slice(0, 6);
      if (raw !== digits) joinInput.value = digits;
    });
    joinInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (_pendingGuestRoleMode !== null) {
        handleSetupJoinWithRole(_pendingGuestRoleMode);
      }
    });
  }

  // PeerJS ready (peer ID assigned)
  bus.on('network:peer-ready', ((...args: unknown[]) => {
    const peerId = args[0] as string;
    const myIdEl = document.getElementById('my-id');
    if (myIdEl && peerId) myIdEl.innerText = peerId;
    updateRoleBadge();
  }) as (...args: unknown[]) => void);

  // Session started (backward compat with legacy hosts)
  bus.on('setup:hide-overlay', ((..._args: unknown[]) => {
    hideSetupOverlay();
    updateRoleBadge();
  }) as (...args: unknown[]) => void);

  // Guest join success/failure events
  bus.on('setup:guest-join-success', ((..._args: unknown[]) => {
    setState('network.isConnecting', false);
    updateRoleBadge();
    hideSetupOverlay();
  }) as (...args: unknown[]) => void);

  bus.on('setup:guest-join-failure', ((...args: unknown[]) => {
    setState('network.isConnecting', false);
    updateRoleBadge();
    showToast('참가하지 못했어요. 같은 Wi‑Fi에 연결되어 있는지 확인해 보세요.');

    setupRenderActions([
      { id: 'btn-setup-back', html: BACK_SVG, kind: 'icon-only', onClick: () => startGuestFlow() },
      { id: 'btn-setup-confirm', text: '시작하기', kind: 'primary', onClick: () => handleSetupJoinWithRole(_pendingGuestRoleMode!) },
    ], 'horizontal-with-back');

    const input = setupEl('setup-join-code') as HTMLInputElement | null;
    if (input) {
      input.disabled = false;
      input.focus();
    }
    setupSetGuestJoinBusy(false);
  }) as (...args: unknown[]) => void);

  // Return to main event
  bus.on('app:return-to-main', ((..._args: unknown[]) => {
    leaveSession();
    initSetupOverlay();
  }) as (...args: unknown[]) => void);

  // Network error handling (connection failures, timeouts, etc.)
  bus.on('network:error', ((...args: unknown[]) => {
    const err = args[0] as Record<string, unknown> | null;
    const msg = (err as Error | null)?.message || '';
    const peerType = (err && typeof err === 'object') ? String(err.type || '') : '';
    let userMsg = '네트워크 오류가 발생했어요';

    // Our custom error messages
    if (msg === 'HOST_UNREACHABLE') userMsg = '호스트에 연결할 수 없어요. 같은 Wi‑Fi에 있는지 확인해 보세요.';
    else if (msg === 'HOST_DISCONNECTED') userMsg = '호스트와 연결이 끊어졌어요';
    else if (msg === 'HOST_CONNECTION_ERROR') userMsg = '호스트 연결 중 오류가 발생했어요';
    else if (msg === 'CONNECT_FAILED') userMsg = '연결에 실패했어요';
    else if (msg === 'PEER_NOT_READY') userMsg = '피어 연결이 아직 준비되지 않았어요';
    else if (msg === 'NETWORK_INIT_FAILED') userMsg = '네트워크 초기화에 실패했어요';
    else if (msg === 'NO_HOST_ID') userMsg = '호스트 ID가 없어요';
    // PeerJS native error types
    else if (peerType === 'peer-unavailable') userMsg = '상대방을 찾을 수 없어요. 코드를 다시 확인해 주세요.';
    else if (peerType === 'network') userMsg = '네트워크 연결에 문제가 있어요. 인터넷 연결을 확인해 주세요.';
    else if (peerType === 'server-error') userMsg = '시그널링 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.';
    else if (peerType === 'socket-error' || peerType === 'socket-closed') userMsg = '서버와의 연결이 끊어졌어요.';
    else if (peerType === 'unavailable-id') userMsg = '세션 ID를 사용할 수 없어요. 다시 시도해 주세요.';
    else if (peerType === 'webrtc') userMsg = 'WebRTC 연결에 실패했어요. 브라우저 설정을 확인해 주세요.';

    const isConnecting = getState<boolean>('network.isConnecting');
    if (isConnecting) {
      // Still trying to join — emit failure for UI reset
      showToast(userMsg);
      bus.emit('setup:guest-join-failure', err);
    } else if (msg === 'HOST_DISCONNECTED' || msg === 'HOST_CONNECTION_ERROR') {
      // Post-connection disconnect: show dialog + re-enable join
      showDialog({
        title: '연결이 끊어졌어요',
        message: `${userMsg}\n다시 연결하시겠어요?`,
        buttonText: '다시 연결',
        secondaryText: '돌아가기',
      }).then(res => {
        if (res.action === 'ok') {
          // Pre-fill the join code and re-enable join flow
          const lastCode = getState<string>('network.lastJoinCode') || '';
          startGuestFlow();
          if (lastCode) {
            const input = setupEl('setup-join-code') as HTMLInputElement | null;
            if (input) { input.value = lastCode; input.focus(); }
          }
        } else {
          initSetupOverlay();
        }
      });
    } else {
      showToast(userMsg);
    }
  }) as (...args: unknown[]) => void);

  // Session full (guest rejected by full host)
  bus.on('network:session-full', ((...args: unknown[]) => {
    const msg = args[0] as string || '세션이 가득 찼어요';
    showDialog({ title: '참가할 수 없어요', message: String(msg) });
    startGuestFlow();
  }) as (...args: unknown[]) => void);

  // Kicked from session (guest removed from host device list)
  bus.on('network:kicked-from-session', ((..._args: unknown[]) => {
    showToast('호스트에서 연결이 종료되었습니다');
    bus.emit('app:return-to-main');
  }) as (...args: unknown[]) => void);

  // Initial overlay
  initSetupOverlay();

  log.info('[Setup] Initialized');
}

/**
 * MUSIXQUARE — Chat UI Shell
 *
 * Owns: chat drawer (open/close, swipe-to-dismiss), preview text and unread
 * badge, sendChatMessage (input + command intercept + freeze/slowmode/filter
 * checks), command autocomplete ghost text, and init wiring. DOM rendering
 * primitives live in chat-render.ts; incoming protocol handlers live in
 * chat/protocol.ts.
 */

import { log } from '../core/log.ts';
import { bus, createBusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG, PEER_NAME_PREFIX, MAX_MSG_LENGTH } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { sendToHost } from '../network/peer.ts';
import { t } from '../i18n/index.ts';
import { getRoleLabelByChannelMode } from './player-controls.ts';
import {
  parseCommand,
  executeCommand,
  shouldBroadcastCommand,
  getAvailableCommands,
  getCommandArgHint,
} from '../chat/commands.ts';
import { createProRoomIdempotencyKey } from '../pro-room/idempotency.ts';
import { sendProRoomRealtime } from '../pro-room/network-bridge.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import { filterProfanity } from '../chat/profanity.ts';
import { clearLatestPinnedNotice, registerChatProtocolHandlers } from '../chat/protocol.ts';
import {
  addChatMessage,
  addSystemChatMessage,
  addNoticeChatMessage,
  clearPinnedNotice,
  formatChatDisplayName,
  isContainerAtBottom,
} from './chat-render.ts';
import { seekTo } from '../player/transport.ts';
import { showToast } from './toast.ts';
import { normalizeEmptyContentEditable, setElementInertForOwner } from './dom.ts';
import { applyUserTextFontFallback } from './user-text-font.ts';
import {
  canCollapseChatDrawerFullToHalf,
  canExpandChatDrawer,
  canUseChatDrawerHalfDetent,
  getChatDrawerFullDismissThreshold,
  getInitialChatDrawerDetent,
  resolveChatDrawerRelease,
  type ChatDrawerDetent,
  type ChatDrawerViewportContext,
} from './chat-drawer-detents.ts';
import { scrollToWithPreferredMotion } from './scroll-motion.ts';

// ─── Chat State ──────────────────────────────────────────────────

let _unreadCount = 0;
let _chatDrawerState: 'closed' | ChatDrawerDetent = 'closed';
let _chatDrawerReturnFocus: HTMLElement | null = null;

function isChatDrawerOpen(): boolean {
  return _chatDrawerState !== 'closed';
}

// ─── Helpers ─────────────────────────────────────────────────────

function _getChatLabelBase(): string {
  const hostConn = getState('network.hostConn');
  const myDeviceLabel = getState('network.myDeviceLabel') || '';
  const label = myDeviceLabel.trim();

  if (!hostConn) {
    // Host: use custom label if set, otherwise raw 'HOST' (matches device list)
    return label || 'HOST';
  }

  if (!label || label === 'HOST' || label === 'Guest' || label === t('common.guest'))
    return PEER_NAME_PREFIX;

  const role0 = getRoleLabelByChannelMode(0);
  const roleL = getRoleLabelByChannelMode(-1);
  const roleR = getRoleLabelByChannelMode(1);
  const roleS = getRoleLabelByChannelMode(2);
  if (label === role0 || label === roleL || label === roleR || label === roleS)
    return PEER_NAME_PREFIX;

  return label;
}

// ─── Chat Preview ────────────────────────────────────────────────

function updateChatPreview(sender: string, text: string): void {
  const previewBtn = document.getElementById('chat-preview-btn');
  if (!previewBtn) return;

  const previewText = previewBtn.querySelector('.chat-preview-text');
  if (previewText instanceof HTMLElement) {
    previewText.textContent = `${sender}: ${text}`;
    applyUserTextFontFallback(previewText, previewText.textContent);
  }
}

function incrementUnread(): void {
  if (isChatDrawerOpen()) return;
  _unreadCount++;
  const badge = document.getElementById('chat-preview-badge');
  if (badge) {
    badge.textContent = _unreadCount > 9 ? '9+' : String(_unreadCount);
    badge.classList.add('show');
  }
}

function resetUnread(): void {
  _unreadCount = 0;
  const badge = document.getElementById('chat-preview-badge');
  if (badge) {
    badge.textContent = '0';
    badge.classList.remove('show');
  }
}

// ─── Chat Drawer ─────────────────────────────────────────────────

/**
 * Safety net for ui:scrollbar-relayout in case transitionend never fires.
 * The open transform lasts 600ms. A slightly longer fallback absorbs timing
 * skew across browsers and survives a toggle that supersedes a previous
 * transition before it had a chance to emit transitionend.
 */
const CHAT_DRAWER_RELAYOUT_FALLBACK_MS = 700;
const CHAT_DRAWER_HEIGHT_SETTLE_FALLBACK_MS = 400;
const _isDesktop = window.matchMedia('(min-width: 1280px)');
let _chatDrawerBottomAnchorFrame: number | null = null;
let _chatDrawerBottomAnchorAC: AbortController | null = null;
let _pendingChatDrawerSnap: {
  drawer: HTMLElement;
  listener: (event: TransitionEvent) => void;
  frame: number;
} | null = null;
let _pendingChatDrawerTransition: {
  drawer: HTMLElement;
  listener: (event: TransitionEvent) => void;
} | null = null;
let _chatTouchContainmentAC: AbortController | null = null;
let _chatTouchStartY = 0;

function stopChatDrawerBottomAnchor(): void {
  _chatDrawerBottomAnchorAC?.abort();
  _chatDrawerBottomAnchorAC = null;
  if (_chatDrawerBottomAnchorFrame !== null) {
    window.cancelAnimationFrame(_chatDrawerBottomAnchorFrame);
    _chatDrawerBottomAnchorFrame = null;
  }
}

function scrollChatMessagesToBottom(messages: HTMLElement): void {
  messages.scrollTop = messages.scrollHeight;
}

/**
 * A shrinking overflow container keeps its old scrollTop, which can push the
 * newest messages below the visible viewport during a full -> half snap.
 * Preserve bottom anchoring only when the user was already at the bottom;
 * users reading older messages keep their exact scroll position.
 */
function maintainChatDrawerBottomAnchor(
  drawer: HTMLElement,
  messages: HTMLElement,
  onUserTakeover: () => void,
): void {
  stopChatDrawerBottomAnchor();
  const controller = new AbortController();
  _chatDrawerBottomAnchorAC = controller;
  const deadline = window.performance.now() + CHAT_DRAWER_HEIGHT_SETTLE_FALLBACK_MS;

  const pinNextFrame = (timestamp: number): void => {
    if (_chatDrawerBottomAnchorAC !== controller) return;
    scrollChatMessagesToBottom(messages);
    if (timestamp >= deadline) {
      stopChatDrawerBottomAnchor();
      return;
    }
    _chatDrawerBottomAnchorFrame = window.requestAnimationFrame(pinNextFrame);
  };

  const stopOnHeightTransition = (event: TransitionEvent): void => {
    if (event.target === drawer && event.propertyName === 'height') stopChatDrawerBottomAnchor();
  };
  drawer.addEventListener('transitionend', stopOnHeightTransition, { signal: controller.signal });

  // Let an immediate user gesture take ownership of the scroll position.
  const stopForUser = (): void => {
    onUserTakeover();
    stopChatDrawerBottomAnchor();
  };
  for (const eventName of ['pointerdown', 'touchstart', 'wheel'] as const) {
    drawer.addEventListener(eventName, stopForUser, {
      passive: true,
      signal: controller.signal,
    });
  }

  scrollChatMessagesToBottom(messages);
  _chatDrawerBottomAnchorFrame = window.requestAnimationFrame(pinNextFrame);
}

function clearPendingChatDrawerSnap(): void {
  if (!_pendingChatDrawerSnap) return;
  const { drawer, listener, frame } = _pendingChatDrawerSnap;
  drawer.removeEventListener('transitionend', listener);
  window.cancelAnimationFrame(frame);
  _pendingChatDrawerSnap = null;
}

function clearPendingChatDrawerTransition(): void {
  clearManagedTimer('chat-drawer-relayout');
  if (!_pendingChatDrawerTransition) return;
  const { drawer, listener } = _pendingChatDrawerTransition;
  drawer.removeEventListener('transitionend', listener);
  _pendingChatDrawerTransition = null;
}

function getChatDrawerViewportHeight(): number {
  const cssHeight = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue('--app-height'),
  );
  if (Number.isFinite(cssHeight) && cssHeight > 0) return cssHeight;
  return Math.max(0, window.innerHeight || document.documentElement.clientHeight);
}

function getChatDrawerStageBottom(): number | null {
  const playTab = document.getElementById('tab-play');
  if (playTab && !playTab.classList.contains('active')) return null;

  const selector = document.body.classList.contains('mode-youtube')
    ? '.video-wrapper'
    : '.vinyl-wrapper';
  const stage = document.querySelector<HTMLElement>(selector);
  if (!stage) return null;

  const style = window.getComputedStyle(stage);
  const rect = stage.getBoundingClientRect();
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    rect.width <= 1 ||
    rect.height <= 1 ||
    rect.right <= 0 ||
    rect.left >= window.innerWidth ||
    rect.bottom <= 0 ||
    rect.top >= getChatDrawerViewportHeight()
  ) {
    return null;
  }
  return rect.bottom;
}

function getChatDrawerViewportContext(): ChatDrawerViewportContext {
  const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth);
  const viewportHeight = getChatDrawerViewportHeight();
  return {
    viewportWidth,
    viewportHeight,
    isPortrait: viewportHeight >= viewportWidth,
    stageBottom: getChatDrawerStageBottom(),
  };
}

const CHAT_DRAWER_BACKGROUND_SELECTOR = [
  '.skip-link',
  '#main-header',
  '.tab-content',
  '.nav-blur-halo',
  '.bottom-nav',
].join(',');

function isMobileChatDrawer(): boolean {
  return getChatDrawerViewportContext().viewportWidth < 1280;
}

function setChatDrawerBackgroundInert(makeInert: boolean): void {
  for (const element of document.querySelectorAll<HTMLElement>(CHAT_DRAWER_BACKGROUND_SELECTOR)) {
    setElementInertForOwner(element, 'chat-drawer', makeInert);
  }
}

function updateChatDrawerHandleAccessibility(drawer: HTMLElement): void {
  const header = drawer.querySelector<HTMLElement>('.chat-drawer-header');
  const closeButton = drawer.querySelector<HTMLButtonElement>('.chat-drawer-close');
  if (!header) return;

  if (!isMobileChatDrawer() || !isChatDrawerOpen()) {
    header.removeAttribute('role');
    header.removeAttribute('aria-label');
    header.removeAttribute('aria-orientation');
    header.removeAttribute('aria-valuemin');
    header.removeAttribute('aria-valuemax');
    header.removeAttribute('aria-valuenow');
    header.removeAttribute('aria-keyshortcuts');
    header.tabIndex = -1;
    if (closeButton) closeButton.tabIndex = isMobileChatDrawer() ? -1 : 0;
    return;
  }

  header.setAttribute('aria-label', t('chat.title'));
  const hasMultipleDetents = canUseChatDrawerHalfDetent(getChatDrawerViewportContext());
  if (hasMultipleDetents) {
    // A focusable separator is the ARIA pattern for a real resize handle.
    header.setAttribute('role', 'separator');
    header.setAttribute('aria-orientation', 'horizontal');
    header.setAttribute('aria-valuemin', '50');
    header.setAttribute('aria-valuemax', '100');
    header.setAttribute('aria-valuenow', drawer.dataset.chatSnap === 'full' ? '100' : '50');
    header.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Home End Enter Space Escape');
  } else {
    // Short landscape phones expose only the full detent. Advertising a
    // 50..100 separator range there suggests a resize action that cannot
    // succeed, so present the tappable handle as a close button instead.
    header.setAttribute('role', 'button');
    header.removeAttribute('aria-orientation');
    header.removeAttribute('aria-valuemin');
    header.removeAttribute('aria-valuemax');
    header.removeAttribute('aria-valuenow');
    header.setAttribute('aria-keyshortcuts', 'Enter Space Escape');
  }
  header.tabIndex = 0;
  if (closeButton) closeButton.tabIndex = -1;
}

function syncChatDrawerModalAccessibility(
  drawer: HTMLElement,
  opening: boolean,
  focusTarget: 'handle' | 'dialog' | null = null,
): void {
  const mobile = isMobileChatDrawer();
  drawer.setAttribute('aria-label', t('chat.title'));
  drawer.setAttribute('role', mobile ? 'dialog' : 'region');
  if (mobile && opening) drawer.setAttribute('aria-modal', 'true');
  else drawer.removeAttribute('aria-modal');

  setChatDrawerBackgroundInert(mobile && opening);
  updateChatDrawerHandleAccessibility(drawer);

  if (mobile && opening && focusTarget) {
    const target =
      focusTarget === 'handle' ? drawer.querySelector<HTMLElement>('.chat-drawer-header') : drawer;
    target?.focus({ preventScroll: true });
  }
}

function getChatDrawerFocusableElements(drawer: HTMLElement): HTMLElement[] {
  return Array.from(
    drawer.querySelectorAll<HTMLElement>(
      'button, input, textarea, select, a[href], [contenteditable="true"], [tabindex]',
    ),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute('disabled') &&
      !element.hidden &&
      element.getAttribute('aria-hidden') !== 'true',
  );
}

function handleChatDrawerKeyboard(event: KeyboardEvent): void {
  if (!isChatDrawerOpen() || !isMobileChatDrawer()) return;
  const drawer = document.getElementById('chat-drawer');
  if (!drawer) return;

  if (event.key === 'Escape') {
    // Command autocomplete owns its first Escape. Only the unhandled Escape
    // reaches the modal drawer.
    if (event.defaultPrevented) return;
    event.preventDefault();
    toggleChatDrawer();
    return;
  }

  const header = drawer.querySelector<HTMLElement>('.chat-drawer-header');
  if (header && event.target === header) {
    const context = getChatDrawerViewportContext();
    const isResizeHandle = header.getAttribute('role') === 'separator';
    if (isResizeHandle && (event.key === 'ArrowUp' || event.key === 'Home')) {
      if (canExpandChatDrawer(context)) {
        event.preventDefault();
        drawer.dataset.chatSnapSource = 'keyboard';
        setChatDrawerDetent(drawer, 'full', true);
      }
      return;
    }
    if (isResizeHandle && (event.key === 'ArrowDown' || event.key === 'End')) {
      event.preventDefault();
      if (_chatDrawerState === 'full' && canCollapseChatDrawerFullToHalf(context)) {
        drawer.dataset.chatSnapSource = 'keyboard';
        setChatDrawerDetent(drawer, 'half', true);
      } else {
        toggleChatDrawer();
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleChatDrawer();
      return;
    }
  }

  if (event.key !== 'Tab') return;
  const focusable = getChatDrawerFocusableElements(drawer);
  if (focusable.length === 0) {
    event.preventDefault();
    drawer.focus({ preventScroll: true });
    return;
  }

  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
  const nextIndex = event.shiftKey
    ? currentIndex <= 0
      ? focusable.length - 1
      : currentIndex - 1
    : currentIndex < 0 || currentIndex === focusable.length - 1
      ? 0
      : currentIndex + 1;
  event.preventDefault();
  focusable[nextIndex]?.focus({ preventScroll: true });
}

function clearChatDrawerLiveGeometry(drawer: HTMLElement): void {
  clearPendingChatDrawerSnap();
  stopChatDrawerBottomAnchor();
  drawer.classList.remove('is-dragging');
  drawer.classList.remove('is-snapping');
  drawer.style.removeProperty('--chat-live-height');
  drawer.style.removeProperty('--chat-offset-y');
}

function getChatDrawerRenderedOffsetY(drawer: HTMLElement): number {
  const transform = window.getComputedStyle(drawer).transform;
  if (transform && transform !== 'none') {
    const matrix3d = transform.match(/^matrix3d\((.+)\)$/);
    if (matrix3d) {
      const values = matrix3d[1].split(',').map(Number);
      const translateY = values[13];
      if (Number.isFinite(translateY)) return Math.max(0, translateY);
    }

    const matrix = transform.match(/^matrix\((.+)\)$/);
    if (matrix) {
      const values = matrix[1].split(',').map(Number);
      const translateY = values[5];
      if (Number.isFinite(translateY)) return Math.max(0, translateY);
    }
  }

  const liveOffset = Number.parseFloat(drawer.style.getPropertyValue('--chat-offset-y'));
  return Number.isFinite(liveOffset) ? Math.max(0, liveOffset) : 0;
}

function setChatDrawerDetent(
  drawer: HTMLElement,
  detent: ChatDrawerDetent,
  animated: boolean,
): void {
  const viewportHeight = getChatDrawerViewportHeight();
  const targetHeight = viewportHeight * (detent === 'half' ? 0.5 : 1);
  const currentRect = drawer.getBoundingClientRect();
  const currentHeight = currentRect.height || targetHeight;
  const currentOffsetY = getChatDrawerRenderedOffsetY(drawer);
  const messages = document.getElementById('chat-messages');
  let keepMessagesAtBottom = messages ? isContainerAtBottom(messages) : false;

  clearPendingChatDrawerSnap();
  stopChatDrawerBottomAnchor();

  if (!animated || !isChatDrawerOpen()) {
    drawer.classList.remove('is-dragging');
    drawer.classList.remove('is-snapping');
    drawer.dataset.chatSnap = detent;
    drawer.style.removeProperty('--chat-live-height');
    drawer.style.removeProperty('--chat-offset-y');
    _chatDrawerState = detent;
    updateChatDrawerHandleAccessibility(drawer);
    if (keepMessagesAtBottom && messages) scrollChatMessagesToBottom(messages);
    return;
  }

  drawer.style.setProperty('--chat-live-height', `${currentHeight}px`);
  drawer.style.setProperty('--chat-offset-y', `${currentOffsetY}px`);
  drawer.classList.add('is-dragging');
  drawer.classList.add('is-snapping');
  // First commit the exact finger-tracked geometry with the source detent's
  // shape. Only after transitions are restored do we switch to the target
  // detent, so safe-area padding and corner radius animate with the height
  // instead of popping at release.
  void drawer.offsetHeight;
  drawer.classList.remove('is-dragging');
  void drawer.offsetHeight;
  drawer.dataset.chatSnap = detent;
  _chatDrawerState = detent;
  updateChatDrawerHandleAccessibility(drawer);
  drawer.style.setProperty('--chat-live-height', `${targetHeight}px`);
  drawer.style.setProperty('--chat-offset-y', '0px');
  if (keepMessagesAtBottom && messages) {
    maintainChatDrawerBottomAnchor(drawer, messages, () => {
      keepMessagesAtBottom = false;
    });
  }
  bus.emit('ui:scrollbar-relayout');

  let settled = false;
  const settleSnap = (): void => {
    if (settled) return;
    settled = true;
    clearPendingChatDrawerSnap();
    stopChatDrawerBottomAnchor();
    drawer.classList.remove('is-snapping');
    drawer.style.removeProperty('--chat-live-height');
    drawer.style.removeProperty('--chat-offset-y');
    if (keepMessagesAtBottom && messages) scrollChatMessagesToBottom(messages);
    if (isChatDrawerOpen() && drawer.classList.contains('open')) {
      bus.emit('ui:scrollbar-reveal', drawer);
    }
  };
  const onHeightTransitionEnd = (event: TransitionEvent): void => {
    if (event.target === drawer && event.propertyName === 'height') settleSnap();
  };
  const deadline = window.performance.now() + CHAT_DRAWER_HEIGHT_SETTLE_FALLBACK_MS;
  const pendingSnap = { drawer, listener: onHeightTransitionEnd, frame: 0 };
  const settleAfterDeadline = (timestamp: number): void => {
    if (_pendingChatDrawerSnap !== pendingSnap) return;
    if (timestamp >= deadline) {
      settleSnap();
      return;
    }
    pendingSnap.frame = window.requestAnimationFrame(settleAfterDeadline);
  };
  drawer.addEventListener('transitionend', onHeightTransitionEnd);
  _pendingChatDrawerSnap = pendingSnap;
  pendingSnap.frame = window.requestAnimationFrame(settleAfterDeadline);
}

function blurChatDrawerInput(drawer: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && drawer.contains(active)) active.blur();
}

export function toggleChatDrawer(
  openFocus: 'handle' | 'dialog' = 'handle',
  preserveLiveGeometryOnClose = false,
): void {
  const drawer = document.getElementById('chat-drawer');
  if (!drawer) return;

  const opening = !isChatDrawerOpen();
  if (opening) {
    const active = document.activeElement;
    _chatDrawerReturnFocus =
      active instanceof HTMLElement && active !== document.body ? active : null;
    const context = getChatDrawerViewportContext();
    const detent = _isDesktop.matches ? 'full' : getInitialChatDrawerDetent(context);
    drawer.dataset.chatSnapSource = 'policy';
    _chatDrawerLayoutMode = getChatDrawerLayoutMode(context);
    setChatDrawerDetent(drawer, detent, false);
  } else {
    _cancelActiveChatDrawerDrag?.(false);
    blurChatDrawerInput(drawer);
    if (preserveLiveGeometryOnClose) {
      clearPendingChatDrawerSnap();
      stopChatDrawerBottomAnchor();
      drawer.classList.remove('is-dragging');
      drawer.classList.remove('is-snapping');
      // Commit the finger-tracked position as the transition's start frame.
      // Removing the live geometry before closing makes the sheet jump back to
      // its detent and only then animate off-screen.
      void drawer.offsetHeight;
    } else {
      clearChatDrawerLiveGeometry(drawer);
    }
    _chatDrawerState = 'closed';
    delete drawer.dataset.chatSnapSource;
  }
  drawer.classList.toggle('open', opening);
  syncChatDrawerModalAccessibility(drawer, opening, opening ? openFocus : null);

  // Sync backdrop
  const backdrop = document.getElementById('chat-backdrop');
  if (backdrop) backdrop.classList.toggle('open', opening);

  if (opening) {
    resetUnread();
    const messages = document.getElementById('chat-messages');
    if (messages) messages.scrollTop = messages.scrollHeight;
    // Do not auto-focus: that would open the keyboard immediately.
  } else {
    const returnFocus = _chatDrawerReturnFocus;
    _chatDrawerReturnFocus = null;
    queueMicrotask(() => {
      const active = document.activeElement;
      if (
        returnFocus?.isConnected &&
        (!active || active === document.body || drawer.contains(active))
      ) {
        returnFocus.focus({ preventScroll: true });
      }
    });
  }

  // Custom scrollbars inside the drawer track viewport coordinates via
  // getBoundingClientRect(). The drawer's open/close animation is a CSS
  // transform on an ancestor — neither ResizeObserver nor MutationObserver
  // on the inner container catches it. Signal a relayout now (for the
  // open frame) and again after the transform transition truly ends so
  // the track lands in the final visible position. A fixed 250ms timer
  // turned out to be brittle — Chrome on Android sometimes finishes the
  // transition ~5–10ms after the timer fired and the resulting updateLayout
  // measured a still-mid-flight rect, leaving the scrollbar shorter than
  // the messages area and offset toward the input bar (the user repro).
  // transitionend fires precisely at the end of the transform animation;
  // a 700ms safety timer covers browsers that occasionally drop the event
  // (e.g. when the drawer is toggled again before the previous transition
  // resolves).
  const drawerEl = drawer as HTMLElement;
  const settleDrawerScrollbar = (): void => {
    if (isChatDrawerOpen() && drawerEl.classList.contains('open')) {
      bus.emit('ui:scrollbar-reveal', drawerEl);
    } else {
      if (preserveLiveGeometryOnClose) clearChatDrawerLiveGeometry(drawerEl);
      bus.emit('ui:scrollbar-relayout');
    }
  };
  // Reposition immediately, but reveal only once the moving surface reaches
  // its final geometry. This avoids restarting the fade timer twice per open.
  clearPendingChatDrawerTransition();
  bus.emit('ui:scrollbar-relayout');
  let settled = false;
  const settleOnce = (): void => {
    if (settled) return;
    settled = true;
    clearPendingChatDrawerTransition();
    settleDrawerScrollbar();
  };
  const onTransitionEnd = (e: TransitionEvent) => {
    if (e.target !== drawerEl || e.propertyName !== 'transform') return;
    settleOnce();
  };
  _pendingChatDrawerTransition = { drawer: drawerEl, listener: onTransitionEnd };
  drawerEl.addEventListener('transitionend', onTransitionEnd);
  setManagedTimer('chat-drawer-relayout', settleOnce, CHAT_DRAWER_RELAYOUT_FALLBACK_MS);
}

// ─── Chat Drawer: Swipe-to-Dismiss ──────────────────────────────
const CHAT_DRAWER_PULL_MAX = 22;
const CHAT_DRAWER_PULL_RESISTANCE = 88;
let _chatDrawerGestureAC: AbortController | null = null;
let _chatDrawerMouseDragAC: AbortController | null = null;
let _cancelActiveChatDrawerDrag: ((restoreDetent?: boolean) => void) | null = null;

function resistedDistance(distance: number): number {
  if (distance <= 0) return 0;
  return CHAT_DRAWER_PULL_MAX * (1 - Math.exp(-distance / CHAT_DRAWER_PULL_RESISTANCE));
}

function setChatDrawerLiveGeometry(drawer: HTMLElement, height: number, offsetY = 0): void {
  drawer.style.setProperty('--chat-live-height', `${Math.max(0, height)}px`);
  drawer.style.setProperty('--chat-offset-y', `${Math.max(0, offsetY)}px`);
}

function initChatSwipeToDismiss(): void {
  const header = document.querySelector('.chat-drawer-header') as HTMLElement | null;
  const drawer = document.getElementById('chat-drawer');
  if (!header || !drawer) return;

  _cancelActiveChatDrawerDrag?.(false);
  _chatDrawerGestureAC?.abort();
  _chatDrawerMouseDragAC?.abort();
  _chatDrawerGestureAC = new AbortController();
  _chatDrawerMouseDragAC = null;
  const { signal: gestureSignal } = _chatDrawerGestureAC;

  let startY = 0;
  let rawDeltaY = 0;
  let dragDistanceY = 0;
  let startDetent: ChatDrawerDetent = 'half';
  let halfHeight = 0;
  let fullHeight = 0;
  let startRenderedHeight = 0;
  let startRenderedOffsetY = 0;
  let canExpandToFull = false;
  let canCollapseFullToHalf = false;
  let keepMessagesAtBottom = false;
  let isDragging = false;

  const startDrag = (y: number): boolean => {
    if (_isDesktop.matches || !isChatDrawerOpen()) return false;

    const context = getChatDrawerViewportContext();
    startY = y;
    rawDeltaY = 0;
    dragDistanceY = 0;
    startDetent = _chatDrawerState === 'full' ? 'full' : 'half';
    fullHeight = context.viewportHeight;
    halfHeight = fullHeight * 0.5;
    canExpandToFull = canExpandChatDrawer(context);
    canCollapseFullToHalf = canCollapseChatDrawerFullToHalf(context);
    const currentRect = drawer.getBoundingClientRect();
    startRenderedHeight = currentRect.height || (startDetent === 'full' ? fullHeight : halfHeight);
    startRenderedOffsetY = getChatDrawerRenderedOffsetY(drawer);
    const messages = document.getElementById('chat-messages');
    keepMessagesAtBottom = messages ? isContainerAtBottom(messages) : false;
    isDragging = true;
    clearPendingChatDrawerSnap();
    stopChatDrawerBottomAnchor();
    setChatDrawerLiveGeometry(drawer, startRenderedHeight, startRenderedOffsetY);
    drawer.classList.add('is-dragging');
    return true;
  };

  const setDragGeometry = (height: number, offsetY = 0): void => {
    setChatDrawerLiveGeometry(drawer, height, offsetY);
    if (!keepMessagesAtBottom) return;
    const messages = document.getElementById('chat-messages');
    if (messages) scrollChatMessagesToBottom(messages);
  };

  const moveDrag = (y: number) => {
    if (!isDragging) return;
    rawDeltaY = y - startY;
    dragDistanceY = Math.abs(rawDeltaY);

    if (startDetent === 'half') {
      if (rawDeltaY < 0 && canExpandToFull) {
        const requestedHeight = startRenderedHeight - rawDeltaY;
        const overshoot = Math.max(0, requestedHeight - fullHeight);
        setDragGeometry(
          Math.min(fullHeight, requestedHeight) + resistedDistance(overshoot),
          Math.max(0, startRenderedOffsetY + rawDeltaY),
        );
      } else if (rawDeltaY < 0) {
        setDragGeometry(
          startRenderedHeight + resistedDistance(-rawDeltaY),
          Math.max(0, startRenderedOffsetY + rawDeltaY),
        );
      } else {
        setDragGeometry(startRenderedHeight, startRenderedOffsetY + rawDeltaY);
      }
      return;
    }

    if (rawDeltaY < 0) {
      const requestedHeight = startRenderedHeight - rawDeltaY;
      const overshoot = Math.max(0, requestedHeight - fullHeight);
      setDragGeometry(
        Math.min(fullHeight, requestedHeight) + resistedDistance(overshoot),
        Math.max(0, startRenderedOffsetY + rawDeltaY),
      );
    } else if (canCollapseFullToHalf) {
      const requestedHeight = startRenderedHeight - rawDeltaY;
      const belowHalf = Math.max(0, halfHeight - requestedHeight);
      setDragGeometry(
        Math.max(halfHeight, requestedHeight),
        startRenderedOffsetY + resistedDistance(belowHalf),
      );
    } else {
      setDragGeometry(startRenderedHeight, startRenderedOffsetY + rawDeltaY);
    }
  };

  const endDrag = (cancelled = false) => {
    if (!isDragging) return;
    isDragging = false;

    const target = resolveChatDrawerRelease({
      startDetent,
      deltaY: rawDeltaY,
      canExpand: canExpandToFull,
      canCollapseFullToHalf,
      fullDismissThreshold: getChatDrawerFullDismissThreshold(fullHeight),
      cancelled,
    });

    if (target === 'closed') {
      toggleChatDrawer('handle', true);
      return;
    }

    drawer.dataset.chatSnapSource = 'gesture';
    setChatDrawerDetent(drawer, target, true);
  };
  _cancelActiveChatDrawerDrag = (restoreDetent = true) => {
    if (!isDragging) return;
    if (restoreDetent) {
      endDrag(true);
      return;
    }

    isDragging = false;
    _chatDrawerMouseDragAC?.abort();
    _chatDrawerMouseDragAC = null;
    drawer.classList.remove('is-dragging');
  };

  // Touch events
  header.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch) startDrag(touch.clientY);
    },
    { passive: true, signal: gestureSignal },
  );
  header.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch) moveDrag(touch.clientY);
    },
    { passive: true, signal: gestureSignal },
  );
  header.addEventListener('touchend', () => endDrag(), { signal: gestureSignal });
  header.addEventListener('touchcancel', () => endDrag(true), { signal: gestureSignal });

  // Mouse events (for small-screen PC users)
  // Attach window listeners only during active drag to prevent permanent leak.
  // An AbortController lets us nuke every window listener atomically — including
  // the blur fallback for the "mousedown then tab-switch without mouseup" case
  // that would otherwise strand dangling handlers.
  const teardownDrag = () => {
    _chatDrawerMouseDragAC?.abort();
    _chatDrawerMouseDragAC = null;
  };
  const onMouseUp = () => {
    endDrag();
    teardownDrag();
  };
  header.addEventListener(
    'mousedown',
    (e: MouseEvent) => {
      if (e.button !== 0) return;
      teardownDrag();
      if (!startDrag(e.clientY)) return;
      e.preventDefault();
      _chatDrawerMouseDragAC = new AbortController();
      const { signal } = _chatDrawerMouseDragAC;
      window.addEventListener('mousemove', (ev: MouseEvent) => moveDrag(ev.clientY), { signal });
      window.addEventListener('mouseup', onMouseUp, { signal });
      window.addEventListener(
        'blur',
        () => {
          endDrag(true);
          teardownDrag();
        },
        { signal },
      );
    },
    { signal: gestureSignal },
  );

  // Header click to close (tap or click without drag)
  header.addEventListener(
    'click',
    () => {
      if (_isDesktop.matches || !isChatDrawerOpen()) return;
      if (dragDistanceY < 5) toggleChatDrawer();
    },
    { signal: gestureSignal },
  );
}

let _chatDrawerViewportAC: AbortController | null = null;
let _chatDrawerLayoutMode: 'desktop' | 'portrait' | 'landscape' | null = null;

function getChatDrawerLayoutMode(
  context: ChatDrawerViewportContext,
): 'desktop' | 'portrait' | 'landscape' {
  if (context.viewportWidth >= 1280) return 'desktop';
  return context.isPortrait ? 'portrait' : 'landscape';
}

function initChatDrawerViewportReconciliation(): void {
  _chatDrawerViewportAC?.abort();
  _chatDrawerViewportAC = new AbortController();
  const { signal } = _chatDrawerViewportAC;

  const scheduleReconciliation = () => {
    if (document.documentElement.classList.contains('keyboard-open')) return;

    setManagedTimer(
      'chat-drawer-viewport-reconcile',
      () => {
        if (!isChatDrawerOpen() || document.documentElement.classList.contains('keyboard-open')) {
          return;
        }

        const drawer = document.getElementById('chat-drawer');
        if (!drawer) return;

        _cancelActiveChatDrawerDrag?.(false);
        const context = getChatDrawerViewportContext();
        const nextMode = getChatDrawerLayoutMode(context);
        const modeChanged = _chatDrawerLayoutMode !== null && _chatDrawerLayoutMode !== nextMode;
        _chatDrawerLayoutMode = nextMode;
        syncChatDrawerModalAccessibility(drawer, true);

        if (nextMode === 'desktop') {
          clearChatDrawerLiveGeometry(drawer);
          return;
        }

        if (modeChanged) {
          drawer.dataset.chatSnapSource = 'policy';
          setChatDrawerDetent(drawer, getInitialChatDrawerDetent(context), true);
          return;
        }

        if (_chatDrawerState === 'half' && !canUseChatDrawerHalfDetent(context)) {
          drawer.dataset.chatSnapSource = 'policy';
          setChatDrawerDetent(drawer, 'full', true);
          return;
        }

        if (
          _chatDrawerState === 'full' &&
          drawer.dataset.chatSnapSource === 'policy' &&
          canUseChatDrawerHalfDetent(context)
        ) {
          setChatDrawerDetent(drawer, 'half', true);
        }
      },
      550,
    );
  };

  const handleOrientationChange = () => {
    if (
      isChatDrawerOpen() &&
      !document.documentElement.classList.contains('keyboard-open') &&
      !_isDesktop.matches
    ) {
      const drawer = document.getElementById('chat-drawer');
      if (drawer) {
        _cancelActiveChatDrawerDrag?.(false);
        // Orientation metrics settle asynchronously on mobile browsers. Full
        // is the only interim detent guaranteed not to cover media partially;
        // the debounced measurement below can safely restore half afterward.
        drawer.dataset.chatSnapSource = 'policy';
        setChatDrawerDetent(drawer, 'full', false);
      }
    }
    scheduleReconciliation();
  };

  window.addEventListener('resize', scheduleReconciliation, { passive: true, signal });
  window.addEventListener('orientationchange', handleOrientationChange, {
    passive: true,
    signal,
  });
  window.visualViewport?.addEventListener('resize', scheduleReconciliation, {
    passive: true,
    signal,
  });
}

function canScrollVertically(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  if (!/(auto|scroll|overlay)/.test(style.overflowY)) return false;
  return el.scrollHeight > el.clientHeight + 1;
}

function getScrollableChatElement(
  target: EventTarget | null,
  drawer: HTMLElement,
): HTMLElement | null {
  if (!(target instanceof Element)) return null;

  let el: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement;
  while (el && el !== drawer) {
    if (canScrollVertically(el)) return el;
    el = el.parentElement;
  }
  return null;
}

function shouldContainDrawerTouch(e: TouchEvent, drawer: HTMLElement): boolean {
  if (!isChatDrawerOpen() || !drawer.classList.contains('open')) return false;
  if (e.touches.length !== 1) return true;

  const scrollable = getScrollableChatElement(e.target, drawer);
  if (!scrollable) return true;

  const deltaY = e.touches[0].clientY - _chatTouchStartY;
  if (Math.abs(deltaY) < 1) return false;

  const atTop = scrollable.scrollTop <= 0;
  const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1;
  return (deltaY > 0 && atTop) || (deltaY < 0 && atBottom);
}

function initChatTouchContainment(): void {
  _chatTouchContainmentAC?.abort();
  _chatTouchContainmentAC = new AbortController();
  const { signal } = _chatTouchContainmentAC;
  const drawer = document.getElementById('chat-drawer') as HTMLElement | null;
  const backdrop = document.getElementById('chat-backdrop');
  if (!drawer) return;

  drawer.addEventListener(
    'touchstart',
    (e) => {
      _chatTouchStartY = e.touches[0]?.clientY ?? 0;
    },
    { passive: true, signal },
  );
  drawer.addEventListener(
    'touchmove',
    (e) => {
      if (shouldContainDrawerTouch(e, drawer) && e.cancelable) e.preventDefault();
    },
    { passive: false, signal },
  );
  backdrop?.addEventListener(
    'touchmove',
    (e) => {
      if (isChatDrawerOpen() && e.cancelable) e.preventDefault();
    },
    { passive: false, signal },
  );
}

// ─── Send & Receive ──────────────────────────────────────────────

let _lastSentTime = 0;

let _lastSentText = '';
let _lastSentTs = 0;

export function sendChatMessage(): void {
  const input = document.getElementById('chat-input') as HTMLDivElement | null;
  if (!input) return;
  let text = (input.textContent || '').trim();
  if (!text) return;

  // Dedup: block identical message within 500ms (guards against double-fire from
  // duplicate event handlers, network reconnection glitches, or platform-specific quirks)
  const now = Date.now();
  if (text === _lastSentText && now - _lastSentTs < 500) return;

  // ── Command intercept ──
  const initialCommand = parseCommand(text);
  const isVisibleBotCommand = initialCommand ? shouldBroadcastCommand(initialCommand) : false;
  if (initialCommand && !isVisibleBotCommand) {
    // This submission has passed parsing and is accepted for local
    // execution. Policy-rejected attempts below deliberately do not update
    // the stamp, so an immediately permitted retry cannot disappear into the
    // double-fire guard.
    _lastSentText = text;
    _lastSentTs = now;
    input.contentEditable = 'false';
    input.replaceChildren();
    void input.offsetHeight; // Force reflow
    input.contentEditable = 'true';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    executeCommand(initialCommand);
    return;
  }

  // ── Freeze check ──
  const chatFrozen = getState('network.chatFrozen');
  const hostConn = getState('network.hostConn');
  const isProRoom = getRoomContext().kind === 'pro';
  const isHost = !isProRoom && (!hostConn || hasRoomCapability('room.configure'));
  const myId = getState('network.myId') || '';
  const ownProParticipant = isProRoom
    ? (getState('network.lastKnownDeviceList') || []).find((participant) => participant.id === myId)
    : undefined;
  const isOp = isProRoom
    ? ownProParticipant?.role === 'owner' || ownProParticipant?.role === 'controller'
    : getState('network.isOperator') || false;
  if (chatFrozen && !isHost && !isOp) {
    addSystemChatMessage(t('chat.cmd_frozen_blocked'));
    return;
  }

  // ── Slowmode check ──
  const slowmode = getState('network.slowmodeSeconds');
  if (slowmode > 0 && !isHost && !isOp) {
    const elapsed = (Date.now() - _lastSentTime) / 1000;
    if (elapsed < slowmode) {
      addSystemChatMessage(t('chat.cmd_slowmode_wait', { sec: Math.ceil(slowmode - elapsed) }));
      return;
    }
  }
  // Record the double-fire key only after every policy gate accepted the
  // submission. This preserves duplicate-handler protection without turning
  // a visible freeze/slowmode rejection into a silent rejection on retry.
  _lastSentText = text;
  _lastSentTs = now;
  _lastSentTime = Date.now();

  if (text.length > MAX_MSG_LENGTH) {
    text = text.substring(0, MAX_MSG_LENGTH);
    showToast(t('chat.msg_truncated', { max: MAX_MSG_LENGTH }));
  }

  // ── Profanity filter (own messages too) ──
  if (getState('network.filterEnabled')) {
    text = filterProfanity(text);
  }

  // Reparse the final, bounded/filtered text so the model receives exactly
  // what every participant sees in the ordinary chat bubble.
  const visibleBotCommand = isVisibleBotCommand ? parseCommand(text) : null;
  const botRequestId =
    visibleBotCommand && shouldBroadcastCommand(visibleBotCommand)
      ? createProRoomIdempotencyKey()
      : undefined;

  const senderLabel = _getChatLabelBase();
  const displayName = formatChatDisplayName(senderLabel);
  const myJoinOrder =
    ownProParticipant?.memberDisplayNumber ??
    getState('network.myMemberDisplayNumber') ??
    getState('network.myJoinOrder') ??
    0;
  const localBadge = isProRoom
    ? ownProParticipant?.role === 'owner'
      ? 'host'
      : ownProParticipant?.role === 'controller'
        ? 'op'
        : undefined
    : isHost
      ? 'host'
      : isOp
        ? 'op'
        : undefined;
  const senderMemberId = ownProParticipant?.memberId || getState('network.myMemberId') || '';
  const senderKey = senderMemberId || myId;
  addChatMessage(displayName, text, true, localBadge, myJoinOrder, senderKey);

  const chatMsg = {
    type: MSG.CHAT,
    senderId: myId,
    ...(senderMemberId ? { senderMemberId } : {}),
    sender: senderLabel,
    senderLabel: senderLabel,
    isHost,
    isOp,
    text: text,
    ts: Date.now(),
    joinOrder: myJoinOrder,
    ...(botRequestId ? { botRequestId } : {}),
  };

  if (isProRoom) {
    const sent = sendProRoomRealtime('chat', {
      kind: 'message',
      text,
      clientTs: chatMsg.ts,
      ...(botRequestId ? { botRequestId } : {}),
    });
    if (!sent) addSystemChatMessage(t('pro.connect_failed'));
  } else if (!hostConn) {
    bus.emit('network:broadcast', chatMsg);
  } else {
    sendToHost(chatMsg);
  }

  if (botRequestId && visibleBotCommand) {
    executeCommand(visibleBotCommand, { botRequestId });
  }

  // iOS Korean IME reset: a contentEditable toggle alone leaves the
  // OS-level composition buffer with the last committed char of the
  // previous message ("요안녕하세요" instead of "안녕하세요" on the next
  // send). Transferring focus to an off-screen dummy <input> for one
  // synchronous tick forces iOS to close the IME session bound to
  // chat-input; returning focus immediately starts a clean session.
  // Keyboard stays up because iOS preserves it across focusable
  // elements inside the same user-gesture stack.
  //
  const dummy = document.getElementById('chat-ime-dummy') as HTMLInputElement | null;
  if (dummy) {
    dummy.focus();
    input.replaceChildren();
    input.focus();
  } else {
    // Last-resort reset for unexpected DOM; it may not fully clear the iOS buffer.
    input.contentEditable = 'false';
    input.replaceChildren();
    void input.offsetHeight;
    input.contentEditable = 'true';
    input.focus();
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// ─── Event Delegation ────────────────────────────────────────────

let _chatDelegationAC: AbortController | null = null;
let _langObserver: MutationObserver | null = null;

function initChatEventDelegation(): void {
  // Tear down previous listeners on re-init
  _chatDelegationAC?.abort();
  _chatDelegationAC = new AbortController();
  const { signal } = _chatDelegationAC;

  // Timestamp seeking
  document.addEventListener(
    'click',
    (e) => {
      const target = (e.target as HTMLElement)?.closest?.('.chat-timestamp[data-seek]');
      if (!target) return;
      const sec = Number(target.getAttribute('data-seek'));
      if (Number.isFinite(sec)) seekTo(sec);
    },
    { signal },
  );

  document.addEventListener(
    'keydown',
    (e) => {
      const target = (e.target as HTMLElement)?.closest?.('.chat-timestamp[data-seek]');
      if (!target) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      const sec = Number(target.getAttribute('data-seek'));
      if (Number.isFinite(sec)) seekTo(sec);
    },
    { signal },
  );

  // YouTube button in chat
  document.addEventListener(
    'click',
    (e) => {
      const btn = (e.target as HTMLElement)?.closest?.('.chat-youtube-btn[data-youtube-url]');
      if (!btn) return;
      const url = btn.getAttribute('data-youtube-url');
      if (url) bus.emit('youtube:load-from-chat', url);
    },
    { signal },
  );
}

// ─── Init ────────────────────────────────────────────────────────

const _busScope = createBusScope();
let _chatUiAC: AbortController | null = null;

export function initChat(): void {
  // Release any prior-init subscriptions so HMR / future re-init paths
  // don't stack duplicate chat-message and drawer toggle handlers.
  // Matches the pattern in player-controls / playlist-view / connect.
  _busScope.dispose();
  _chatUiAC?.abort();
  stopChatDrawerBottomAnchor();
  _chatUiAC = new AbortController();
  const { signal: uiSignal } = _chatUiAC;

  registerChatProtocolHandlers();

  initChatEventDelegation();
  initChatSwipeToDismiss();
  initChatDrawerViewportReconciliation();
  initChatTouchContainment();
  const chatDrawer = document.getElementById('chat-drawer');
  if (chatDrawer) syncChatDrawerModalAccessibility(chatDrawer, isChatDrawerOpen());
  document.addEventListener('keydown', handleChatDrawerKeyboard, { signal: uiSignal });

  // Backdrop tap to close
  const backdrop = document.getElementById('chat-backdrop');
  if (backdrop)
    backdrop.addEventListener(
      'click',
      () => {
        if (isChatDrawerOpen()) toggleChatDrawer();
      },
      { signal: uiSignal },
    );

  const chatMessages = document.getElementById('chat-messages');
  const scrollDownBtn = document.getElementById('btn-chat-scroll-down');

  if (chatMessages && scrollDownBtn) {
    const refreshScrollDownButton = (): void => {
      const show = !isContainerAtBottom(chatMessages);
      scrollDownBtn.classList.toggle('show', show);
      scrollDownBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
      scrollDownBtn.tabIndex = show ? 0 : -1;
      if (!show && document.activeElement === scrollDownBtn) {
        chatMessages.focus({ preventScroll: true });
      }
    };

    // `passive: true` is the modern default for scroll listeners but we
    // mark it explicitly — Safari ≤ 11 still required the hint, and the
    // browsers that don't need it ignore the option harmlessly.
    chatMessages.addEventListener('scroll', refreshScrollDownButton, {
      passive: true,
      signal: uiSignal,
    });

    scrollDownBtn.addEventListener(
      'click',
      () => {
        scrollToWithPreferredMotion(chatMessages, chatMessages.scrollHeight);
      },
      { signal: uiSignal },
    );
    refreshScrollDownButton();
  }

  // Wire up UI buttons
  const sendBtn = document.getElementById('btn-chat-send');
  if (sendBtn) {
    const handleSend = (e: Event) => {
      e.preventDefault(); // Prevent input blur
      sendChatMessage();
      const chatInput = document.getElementById('chat-input') as HTMLDivElement | null;
      if (chatInput) chatInput.focus();
    };
    sendBtn.addEventListener('pointerdown', handleSend, { signal: uiSignal });
    sendBtn.addEventListener(
      'click',
      (e) => {
        // Fallback for keyboard accessibility (Space/Enter on button)
        if (e.detail !== 0) return; // Ignore if triggered by mouse/touch pointerdown
        handleSend(e);
      },
      { signal: uiSignal },
    );
  }

  const closeBtn = document.getElementById('btn-chat-close');
  if (closeBtn) closeBtn.addEventListener('click', () => toggleChatDrawer(), { signal: uiSignal });

  const previewBtn = document.getElementById('chat-preview-btn');
  if (previewBtn) {
    previewBtn.addEventListener(
      'click',
      (event) => {
        // Pointer/touch users should not see the full-width drag handle rendered
        // as a selected control. Keyboard and AT activation keep the visible,
        // actionable handle focus.
        const openFocus = event instanceof MouseEvent && event.detail > 0 ? 'dialog' : 'handle';
        toggleChatDrawer(openFocus);
      },
      { signal: uiSignal },
    );
  }

  // Chat input: send on Enter + command autocomplete
  const chatInput = document.getElementById('chat-input') as HTMLDivElement | null;
  if (chatInput) {
    // Create autocomplete dropdown
    const wrapper = chatInput.closest('.chat-input-wrapper');
    if (wrapper) {
      (wrapper as HTMLElement).style.position = 'relative';
      wrapper
        .querySelectorAll(':scope > .chat-cmd-suggest, :scope > .chat-cmd-ghost')
        .forEach((element) => element.remove());
    }
    const suggest = document.createElement('div');
    suggest.id = 'chat-command-suggestions';
    suggest.className = 'chat-cmd-suggest';
    suggest.setAttribute('role', 'listbox');
    suggest.style.display = 'none';
    if (wrapper) wrapper.appendChild(suggest);

    chatInput.setAttribute('role', 'combobox');
    chatInput.setAttribute('aria-autocomplete', 'list');
    chatInput.setAttribute('aria-haspopup', 'listbox');
    chatInput.setAttribute('aria-controls', suggest.id);
    chatInput.setAttribute('aria-expanded', 'false');

    // Ghost text overlay for argument hints
    const ghost = document.createElement('div');
    ghost.className = 'chat-cmd-ghost';
    if (wrapper) wrapper.appendChild(ghost);

    /** Read text from contenteditable div */
    function getInputValue(): string {
      return chatInput!.textContent || '';
    }

    /** Write text to contenteditable div and place cursor at end */
    function setInputValue(text: string): void {
      chatInput!.textContent = text;
      applyUserTextFontFallback(chatInput!, text);
      // Place cursor at end
      if (text) {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(chatInput!);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    }

    function updateGhost(): void {
      const val = getInputValue();
      // Match "/commandname " (with trailing space)
      const match = val.match(/^\/(\w+)\s/);
      if (match) {
        const hint = getCommandArgHint(match[1]);
        if (hint) {
          // Count how many args the user has typed so far
          const afterCmd = val.slice(match[0].length);
          const typedArgs = afterCmd ? afterCmd.split(/\s+/).filter(Boolean) : [];
          // Split hint into bracket groups: ["[on | off]"] or ["[기기]", "[내용]"]
          const hintParts = hint.match(/\[[^\]]*\]/g) || [];
          // Remove already-filled arg hints
          const remaining = hintParts.slice(typedArgs.length);
          if (remaining.length > 0) {
            const typed = document.createElement('span');
            typed.className = 'chat-cmd-ghost-typed';
            typed.textContent = val;
            const hintNode = document.createElement('span');
            hintNode.className = 'chat-cmd-ghost-hint';
            hintNode.textContent = remaining.join(' ');
            ghost.replaceChildren(typed, hintNode);
            ghost.style.display = '';
            return;
          }
        }
      }
      ghost.style.display = 'none';
    }

    let _suggestIdx = 0;
    let _suggestItems: { name: string; usage: string; description: string }[] = [];

    function syncSuggestSelection(scroll = false): void {
      const options = Array.from(suggest.querySelectorAll<HTMLElement>('.chat-cmd-item'));
      options.forEach((element, index) => {
        const active = index === _suggestIdx;
        element.classList.toggle('active', active);
        element.setAttribute('aria-selected', String(active));
      });

      const activeOption = options[_suggestIdx];
      if (activeOption) {
        chatInput!.setAttribute('aria-activedescendant', activeOption.id);
        if (scroll) activeOption.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
      } else {
        chatInput!.removeAttribute('aria-activedescendant');
      }
    }

    function showSuggest(items: { name: string; usage: string; description: string }[]): void {
      _suggestItems = items;
      _suggestIdx = 0;
      if (!items.length) {
        hideSuggest();
        return;
      }
      suggest.replaceChildren(
        ...items.map((it, i) => {
          const item = document.createElement('div');
          item.id = `chat-command-option-${i}`;
          item.className = 'chat-cmd-item';
          item.dataset.idx = String(i);
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', 'false');

          const usage = document.createElement('span');
          usage.className = 'chat-cmd-usage';
          usage.textContent = it.usage;

          const desc = document.createElement('span');
          desc.className = 'chat-cmd-desc';
          desc.textContent = it.description;

          item.append(usage, document.createTextNode(' '), desc);
          return item;
        }),
      );
      suggest.style.display = '';
      chatInput!.setAttribute('aria-expanded', 'true');
      syncSuggestSelection();
    }

    function hideSuggest(): void {
      suggest.style.display = 'none';
      _suggestItems = [];
      chatInput!.setAttribute('aria-expanded', 'false');
      chatInput!.removeAttribute('aria-activedescendant');
    }

    function applySuggest(): void {
      const item = _suggestItems[_suggestIdx];
      if (!item || !chatInput) return;
      setInputValue(`/${item.name} `);
      chatInput.focus();
      hideSuggest();
      updateGhost();
    }

    // Paste handler: strip HTML, paste plain text only
    chatInput.addEventListener(
      'paste',
      (e) => {
        e.preventDefault();
        const text = e.clipboardData?.getData('text/plain') || '';
        // Remove line breaks and limit length
        const clean = text.replace(/[\r\n]/g, ' ').substring(0, MAX_MSG_LENGTH);
        document.execCommand('insertText', false, clean);
      },
      { signal: uiSignal },
    );

    // Prevent line breaks in contenteditable
    chatInput.addEventListener(
      'beforeinput',
      (e) => {
        if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
          e.preventDefault();
          return;
        }
        // Enforce maxlength
        if (e.inputType === 'insertText') {
          const current = getInputValue();
          const incoming = e.data || '';
          if (current.length + incoming.length > MAX_MSG_LENGTH) {
            e.preventDefault();
            // Insert only what fits
            const remaining = MAX_MSG_LENGTH - current.length;
            if (remaining > 0) {
              document.execCommand('insertText', false, incoming.substring(0, remaining));
            }
          }
        }
      },
      { signal: uiSignal },
    );

    // Drop handler: prevent dropping rich content
    chatInput.addEventListener(
      'drop',
      (e) => {
        e.preventDefault();
      },
      { signal: uiSignal },
    );

    // Input event: filter commands + ghost text
    chatInput.addEventListener(
      'input',
      (e) => {
        // Stray-<br> placeholder restore — shared helper, see dom.ts.
        normalizeEmptyContentEditable(chatInput, e);
        const val = getInputValue();
        applyUserTextFontFallback(chatInput, val);
        updateGhost();
        if (!val.startsWith('/') || val.includes(' ')) {
          hideSuggest();
          return;
        }
        const query = val.slice(1).toLowerCase();
        const matches = getAvailableCommands(query);
        showSuggest(matches);
      },
      { signal: uiSignal },
    );

    // Click on suggest item
    suggest.addEventListener(
      'mousedown',
      (e) => {
        e.preventDefault(); // Keep focus on input
        const el = (e.target as HTMLElement).closest('.chat-cmd-item') as HTMLElement | null;
        if (el) {
          _suggestIdx = parseInt(el.dataset.idx || '0', 10);
          applySuggest();
        }
      },
      { signal: uiSignal },
    );

    // Blur: hide suggest (with delay for click to register)
    chatInput.addEventListener(
      'blur',
      () => {
        setManagedTimer('chat-hide-suggest', hideSuggest, 150);
      },
      { signal: uiSignal },
    );

    chatInput.addEventListener(
      'keydown',
      (e) => {
        // Autocomplete navigation
        if (_suggestItems.length && suggest.style.display !== 'none') {
          if (e.key === 'Tab') {
            e.preventDefault();
            applySuggest();
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            _suggestIdx = (_suggestIdx + 1) % _suggestItems.length;
            syncSuggestSelection(true);
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            _suggestIdx = (_suggestIdx - 1 + _suggestItems.length) % _suggestItems.length;
            syncSuggestSelection(true);
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            hideSuggest();
            return;
          }
          if (e.key === 'Enter') {
            hideSuggest();
            // Fall through to normal Enter send below
          }
        }

        // Normal Enter: send message
        if (e.key === 'Enter' && !e.shiftKey) {
          // On macOS/iOS, defer Enter while IME composition is active and send as
          // soon as composition finishes. This preserves one-press send without
          // duplicating the committed character.
          if (e.isComposing) {
            _isConfirmingIME = true;
            return;
          }

          e.preventDefault();
          sendChatMessage();
        }
      },
      { signal: uiSignal },
    );

    let _isConfirmingIME = false;
    chatInput.addEventListener(
      'compositionend',
      () => {
        // If Enter was pressed during composition, trigger send now that it's finished.
        if (_isConfirmingIME) {
          _isConfirmingIME = false;
          // Zero-delay timeout is more stable for IME-to-DOM sync on Safari/Mac than rAF.
          setManagedTimer(
            'chat-ime-send',
            () => {
              sendChatMessage();
            },
            0,
          );
        }
      },
      { signal: uiSignal },
    );

    // Re-render ghost text on language change. Store the observer ref so
    // re-init (HMR, future re-wiring) disconnects the prior one instead of
    // stacking. Matches the connect.ts _langObserver pattern.
    if (_langObserver) _langObserver.disconnect();
    _langObserver = new MutationObserver(() => updateGhost());
    _langObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['lang'],
    });

    // platform.ts manages keyboard-open through visualViewport detection before
    // focus, preventing layout thrashing. Keep the delayed blur handler as
    // safety-net cleanup in case the
    // visualViewport.resize event doesn't fire (e.g. external keyboard).
    chatInput.addEventListener(
      'blur',
      () => {
        setManagedTimer(
          'kb-blur-guard',
          () => {
            const active = document.activeElement;
            if (!active?.matches('input, textarea, [contenteditable="true"]')) {
              document.documentElement.classList.remove('keyboard-open');
            }
          },
          400,
        );
      },
      { signal: uiSignal },
    );
  }

  // Render primitives emit this when a chat, whisper, or banner-only notice
  // reaches the UI.
  // Keeps drawer/unread state out of chat-render.ts (single-direction dep).
  _busScope.on('chat:message-rendered', (sender: string, text: string, isMine: boolean) => {
    updateChatPreview(sender, text);
    if (!isMine) incrementUnread();
  });

  // Close chat drawer (used by YouTube load-from-chat)
  _busScope.on('ui:close-chat-drawer', () => {
    if (isChatDrawerOpen()) toggleChatDrawer();
  });

  // System messages from loader (avoids circular import with toast.ts)
  _busScope.on('chat:system-message', (text: string) => {
    addSystemChatMessage(text);
  });

  // Notice messages (host-side for OP-initiated notices)
  _busScope.on('chat:notice-message', (sender: string, text: string, timestamp?: number) => {
    addNoticeChatMessage(sender, text, timestamp);
  });

  // Muted state: disable input
  _busScope.on('chat:muted-state-changed', (isMuted: boolean) => {
    const chatInput = document.getElementById('chat-input') as HTMLDivElement | null;
    if (chatInput) {
      chatInput.setAttribute(
        'data-placeholder',
        isMuted ? t('chat.muted_placeholder') : t('chat.placeholder'),
      );
      // Swap the i18n retranslation key in lockstep — otherwise a language
      // switch while muted rewrites data-placeholder back to the normal copy
      // (same pattern as the media button in player-controls.ts).
      chatInput.setAttribute(
        'data-i18n-data-placeholder',
        isMuted ? 'chat.muted_placeholder' : 'chat.placeholder',
      );
      chatInput.contentEditable = isMuted ? 'false' : 'true';
      chatInput.dataset.disabled = isMuted ? 'true' : 'false';
    }
  });

  // Clear all chat messages
  _busScope.on('chat:clear-all', () => {
    const container = document.getElementById('chat-messages');
    if (container) {
      container.replaceChildren();
      addSystemChatMessage(t('chat.cmd_clear'));
    }
    resetUnread();
    clearLatestPinnedNotice();
    clearPinnedNotice();
  });

  // Pinned notice: tap anywhere on the banner to dismiss
  const pinnedBanner = document.getElementById('chat-pinned-notice');
  pinnedBanner?.addEventListener('click', clearPinnedNotice);
  pinnedBanner?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      clearPinnedNotice();
    }
  });

  log.info('[Chat] Initialized');
}

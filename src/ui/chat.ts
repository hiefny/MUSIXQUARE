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
import { normalizeEmptyContentEditable } from './dom.ts';

// ─── Chat State ──────────────────────────────────────────────────

let _unreadCount = 0;
let _isChatDrawerOpen = false;

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
  if (previewText) {
    previewText.textContent = `${sender}: ${text}`;
  }
}

function incrementUnread(): void {
  if (_isChatDrawerOpen) return;
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
 * The drawer's CSS transform transition is 200ms; doubling that absorbs
 * timing skew across browsers (Chrome on Android occasionally finishes
 * 5-10ms late) and survives a toggle that supersedes a previous
 * transition before it had a chance to emit transitionend.
 */
const CHAT_DRAWER_RELAYOUT_FALLBACK_MS = 400;
let _chatTouchContainmentAC: AbortController | null = null;
let _chatTouchStartY = 0;

export function toggleChatDrawer(): void {
  const drawer = document.getElementById('chat-drawer');
  if (!drawer) return;

  _isChatDrawerOpen = !_isChatDrawerOpen;
  drawer.classList.toggle('open', _isChatDrawerOpen);

  // Sync backdrop
  const backdrop = document.getElementById('chat-backdrop');
  if (backdrop) backdrop.classList.toggle('open', _isChatDrawerOpen);

  if (_isChatDrawerOpen) {
    resetUnread();
    const messages = document.getElementById('chat-messages');
    if (messages) messages.scrollTop = messages.scrollHeight;
    // Do not auto-focus: that would open the keyboard immediately.
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
  // a 400ms safety timer covers browsers that occasionally drop the event
  // (e.g. when the drawer is toggled again before the previous transition
  // resolves).
  bus.emit('ui:scrollbar-relayout');
  const drawerEl = drawer as HTMLElement;
  const onTransitionEnd = (e: TransitionEvent) => {
    if (e.propertyName !== 'transform') return;
    drawerEl.removeEventListener('transitionend', onTransitionEnd);
    clearManagedTimer('chat-drawer-relayout');
    bus.emit('ui:scrollbar-relayout');
  };
  drawerEl.addEventListener('transitionend', onTransitionEnd);
  setManagedTimer(
    'chat-drawer-relayout',
    () => {
      drawerEl.removeEventListener('transitionend', onTransitionEnd);
      bus.emit('ui:scrollbar-relayout');
    },
    CHAT_DRAWER_RELAYOUT_FALLBACK_MS,
  );
}

// ─── Chat Drawer: Swipe-to-Dismiss ──────────────────────────────
const SWIPE_DISMISS_THRESHOLD = 100; // px
const CHAT_DRAWER_PULL_MAX = 22;
const CHAT_DRAWER_PULL_RESISTANCE = 88;
const CHAT_DRAWER_STRETCH_RESET_MS = 260;
const _isDesktop = window.matchMedia('(min-width: 1280px)');

function setChatDrawerStretch(drawer: HTMLElement, baseHeight: number, pullPx: number): void {
  clearManagedTimer('chat-drawer-stretch-reset');
  drawer.style.maxHeight = `${baseHeight + CHAT_DRAWER_PULL_MAX}px`;
  drawer.style.height = `${baseHeight + pullPx}px`;
}

function resetChatDrawerStretch(drawer: HTMLElement, baseHeight: number, animated: boolean): void {
  clearManagedTimer('chat-drawer-stretch-reset');
  if (!drawer.style.height) return;

  if (!animated || baseHeight <= 0) {
    drawer.style.height = '';
    drawer.style.maxHeight = '';
    return;
  }

  drawer.style.transition = `height ${CHAT_DRAWER_STRETCH_RESET_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
  drawer.style.height = `${baseHeight}px`;
  setManagedTimer(
    'chat-drawer-stretch-reset',
    () => {
      drawer.style.height = '';
      drawer.style.maxHeight = '';
      drawer.style.transition = '';
    },
    CHAT_DRAWER_STRETCH_RESET_MS,
  );
}

function initChatSwipeToDismiss(): void {
  const header = document.querySelector('.chat-drawer-header') as HTMLElement | null;
  const drawer = document.getElementById('chat-drawer');
  if (!header || !drawer) return;

  let startY = 0;
  let deltaY = 0;
  let dragDistanceY = 0;
  let baseDrawerHeight = 0;
  let isDragging = false;

  const startDrag = (y: number) => {
    if (_isDesktop.matches || !_isChatDrawerOpen) return;
    startY = y;
    deltaY = 0;
    dragDistanceY = 0;
    baseDrawerHeight = drawer.getBoundingClientRect().height;
    isDragging = true;
    drawer.style.transition = 'none';
  };

  const moveDrag = (y: number) => {
    if (!isDragging) return;
    const rawDeltaY = y - startY;
    dragDistanceY = Math.abs(rawDeltaY);
    if (rawDeltaY >= 0) {
      deltaY = rawDeltaY;
      setChatDrawerStretch(drawer, baseDrawerHeight, 0);
    } else {
      deltaY = 0;
      const pullPx = CHAT_DRAWER_PULL_MAX * (1 - Math.exp(rawDeltaY / CHAT_DRAWER_PULL_RESISTANCE));
      setChatDrawerStretch(drawer, baseDrawerHeight, pullPx);
    }
    drawer.style.transform = `translateY(${deltaY}px)`;
  };

  const endDrag = () => {
    if (!isDragging) return;
    isDragging = false;
    if (deltaY > SWIPE_DISMISS_THRESHOLD) {
      resetChatDrawerStretch(drawer, baseDrawerHeight, false);
      drawer.style.transition = '';
      drawer.style.transform = '';
      toggleChatDrawer();
      return;
    }
    drawer.style.transition = '';
    drawer.style.transform = '';
    resetChatDrawerStretch(drawer, baseDrawerHeight, true);
  };

  // Touch events
  header.addEventListener('touchstart', (e: TouchEvent) => startDrag(e.touches[0].clientY), {
    passive: true,
  });
  header.addEventListener('touchmove', (e: TouchEvent) => moveDrag(e.touches[0].clientY), {
    passive: true,
  });
  header.addEventListener('touchend', endDrag);
  header.addEventListener('touchcancel', endDrag);

  // Mouse events (for small-screen PC users)
  // Attach window listeners only during active drag to prevent permanent leak.
  // An AbortController lets us nuke every window listener atomically — including
  // the blur fallback for the "mousedown then tab-switch without mouseup" case
  // that would otherwise strand dangling handlers.
  let dragAC: AbortController | null = null;
  const teardownDrag = () => {
    dragAC?.abort();
    dragAC = null;
  };
  const onMouseUp = () => {
    endDrag();
    teardownDrag();
  };
  header.addEventListener('mousedown', (e: MouseEvent) => {
    // If a previous drag never received mouseup (tab switch, devtools grab),
    // abort its listeners before starting a new one so they don't accumulate.
    teardownDrag();
    startDrag(e.clientY);
    e.preventDefault(); // prevent text selection while dragging
    dragAC = new AbortController();
    const { signal } = dragAC;
    window.addEventListener('mousemove', (ev: MouseEvent) => moveDrag(ev.clientY), { signal });
    window.addEventListener('mouseup', onMouseUp, { signal });
    window.addEventListener('blur', onMouseUp, { signal });
  });

  // Header click to close (tap or click without drag)
  header.addEventListener('click', () => {
    if (_isDesktop.matches || !_isChatDrawerOpen) return;
    if (dragDistanceY < 5) toggleChatDrawer(); // only if no significant drag occurred
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
  if (!_isChatDrawerOpen || !drawer.classList.contains('open')) return false;
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
      if (_isChatDrawerOpen && e.cancelable) e.preventDefault();
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
  _lastSentText = text;
  _lastSentTs = now;

  // ── Command intercept ──
  const initialCommand = parseCommand(text);
  const isVisibleBotCommand = initialCommand ? shouldBroadcastCommand(initialCommand) : false;
  if (initialCommand && !isVisibleBotCommand) {
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
  const isHost = !hostConn;
  const isOp = getState('network.isOperator') || false;
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
  const myJoinOrder = getState('network.myJoinOrder') ?? 0;
  addChatMessage(displayName, text, true, isHost ? 'host' : isOp ? 'op' : undefined, myJoinOrder);

  const myId = getState('network.myId') || '';
  const chatMsg = {
    type: MSG.CHAT,
    senderId: myId,
    sender: senderLabel,
    senderLabel: senderLabel,
    isHost,
    isOp,
    text: text,
    ts: Date.now(),
    joinOrder: myJoinOrder,
    ...(botRequestId ? { botRequestId } : {}),
  };

  if (!hostConn) {
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

export function initChat(): void {
  // Release any prior-init subscriptions so HMR / future re-init paths
  // don't stack duplicate chat-message and drawer toggle handlers.
  // Matches the pattern in player-controls / playlist-view / connect.
  _busScope.dispose();

  registerChatProtocolHandlers();

  initChatEventDelegation();
  initChatSwipeToDismiss();
  initChatTouchContainment();

  // Backdrop tap to close
  const backdrop = document.getElementById('chat-backdrop');
  if (backdrop)
    backdrop.addEventListener('click', () => {
      if (_isChatDrawerOpen) toggleChatDrawer();
    });

  const chatMessages = document.getElementById('chat-messages');
  const scrollDownBtn = document.getElementById('btn-chat-scroll-down');

  if (chatMessages && scrollDownBtn) {
    // `passive: true` is the modern default for scroll listeners but we
    // mark it explicitly — Safari ≤ 11 still required the hint, and the
    // browsers that don't need it ignore the option harmlessly.
    chatMessages.addEventListener(
      'scroll',
      () => {
        scrollDownBtn.classList.toggle('show', !isContainerAtBottom(chatMessages));
      },
      { passive: true },
    );

    scrollDownBtn.addEventListener('click', () => {
      chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
    });
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
    sendBtn.addEventListener('pointerdown', handleSend);
    sendBtn.addEventListener('click', (e) => {
      // Fallback for keyboard accessibility (Space/Enter on button)
      if (e.detail !== 0) return; // Ignore if triggered by mouse/touch pointerdown
      handleSend(e);
    });
  }

  const closeBtn = document.getElementById('btn-chat-close');
  if (closeBtn) closeBtn.addEventListener('click', toggleChatDrawer);

  const previewBtn = document.getElementById('chat-preview-btn');
  if (previewBtn) previewBtn.addEventListener('click', toggleChatDrawer);

  // Chat input: send on Enter + command autocomplete
  const chatInput = document.getElementById('chat-input') as HTMLDivElement | null;
  if (chatInput) {
    // Create autocomplete dropdown
    const wrapper = chatInput.closest('.chat-input-wrapper');
    if (wrapper) {
      (wrapper as HTMLElement).style.position = 'relative';
    }
    const suggest = document.createElement('div');
    suggest.className = 'chat-cmd-suggest';
    suggest.style.display = 'none';
    if (wrapper) wrapper.appendChild(suggest);

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

    function showSuggest(items: { name: string; usage: string; description: string }[]): void {
      _suggestItems = items;
      _suggestIdx = 0;
      if (!items.length) {
        suggest.style.display = 'none';
        return;
      }
      suggest.replaceChildren(
        ...items.map((it, i) => {
          const item = document.createElement('div');
          item.className = `chat-cmd-item${i === 0 ? ' active' : ''}`;
          item.dataset.idx = String(i);

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
    }

    function hideSuggest(): void {
      suggest.style.display = 'none';
      _suggestItems = [];
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
    chatInput.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') || '';
      // Remove line breaks and limit length
      const clean = text.replace(/[\r\n]/g, ' ').substring(0, MAX_MSG_LENGTH);
      document.execCommand('insertText', false, clean);
    });

    // Prevent line breaks in contenteditable
    chatInput.addEventListener('beforeinput', (e) => {
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
    });

    // Drop handler: prevent dropping rich content
    chatInput.addEventListener('drop', (e) => {
      e.preventDefault();
    });

    // Input event: filter commands + ghost text
    chatInput.addEventListener('input', (e) => {
      // Stray-<br> placeholder restore — shared helper, see dom.ts.
      normalizeEmptyContentEditable(chatInput, e);
      const val = getInputValue();
      updateGhost();
      if (!val.startsWith('/') || val.includes(' ')) {
        hideSuggest();
        return;
      }
      const query = val.slice(1).toLowerCase();
      const matches = getAvailableCommands(query);
      showSuggest(matches);
    });

    // Click on suggest item
    suggest.addEventListener('mousedown', (e) => {
      e.preventDefault(); // Keep focus on input
      const el = (e.target as HTMLElement).closest('.chat-cmd-item') as HTMLElement | null;
      if (el) {
        _suggestIdx = parseInt(el.dataset.idx || '0', 10);
        applySuggest();
      }
    });

    // Blur: hide suggest (with delay for click to register)
    chatInput.addEventListener('blur', () => {
      setManagedTimer('chat-hide-suggest', hideSuggest, 150);
    });

    chatInput.addEventListener('keydown', (e) => {
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
          suggest.querySelectorAll('.chat-cmd-item').forEach((el, i) => {
            el.classList.toggle('active', i === _suggestIdx);
            if (i === _suggestIdx) el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          });
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          _suggestIdx = (_suggestIdx - 1 + _suggestItems.length) % _suggestItems.length;
          suggest.querySelectorAll('.chat-cmd-item').forEach((el, i) => {
            el.classList.toggle('active', i === _suggestIdx);
            if (i === _suggestIdx) el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          });
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
    });

    let _isConfirmingIME = false;
    chatInput.addEventListener('compositionend', () => {
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
    });

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
    chatInput.addEventListener('blur', () => {
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
    });
  }

  // Render primitives emit this when a chat, whisper, or banner-only notice
  // reaches the UI.
  // Keeps drawer/unread state out of chat-render.ts (single-direction dep).
  _busScope.on('chat:message-rendered', (sender: string, text: string, isMine: boolean) => {
    updateChatPreview(sender, text);
    if (!isMine) incrementUnread();
  });

  // Bus event for toggling drawer from other modules
  _busScope.on('ui:toggle-chat-drawer', () => {
    toggleChatDrawer();
  });

  // Close chat drawer (used by YouTube load-from-chat)
  _busScope.on('ui:close-chat-drawer', () => {
    if (_isChatDrawerOpen) toggleChatDrawer();
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

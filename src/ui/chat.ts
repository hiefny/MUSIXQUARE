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
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG, PEER_NAME_PREFIX } from '../core/constants.ts';
import { setManagedTimer } from '../core/timers.ts';
import { sendToHost } from '../network/peer.ts';
import { escapeHtml } from './dom.ts';
import { t } from '../i18n/index.ts';
import { getRoleLabelByChannelMode } from './player-controls.ts';
import { parseCommand, executeCommand, getAvailableCommands, getCommandArgHint } from '../chat/commands.ts';
import { filterProfanity } from '../chat/profanity.ts';
import { registerChatProtocolHandlers } from '../chat/protocol.ts';
import {
  addChatMessage,
  addSystemChatMessage,
  addNoticeChatMessage,
  clearPinnedNotice,
  formatChatDisplayName,
  MAX_MSG_LENGTH,
} from './chat-render.ts';
import { seekTo } from '../player/transport.ts';
import { showToast } from './toast.ts';

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

  if (!label || label === 'HOST' || label === 'Guest' || label === t('common.guest')) return PEER_NAME_PREFIX;

  const role0 = getRoleLabelByChannelMode(0);
  const roleL = getRoleLabelByChannelMode(-1);
  const roleR = getRoleLabelByChannelMode(1);
  const roleS = getRoleLabelByChannelMode(2);
  if (label === role0 || label === roleL || label === roleR || label === roleS) return PEER_NAME_PREFIX;

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
    // Removed automatic focus to prevent the keyboard from opening immediately.
  }
}

// ─── Chat Drawer: Swipe-to-Dismiss ──────────────────────────────
const SWIPE_DISMISS_THRESHOLD = 100; // px
const _isDesktop = window.matchMedia('(min-width: 1280px)');

function initChatSwipeToDismiss(): void {
  const header = document.querySelector('.chat-drawer-header') as HTMLElement | null;
  const drawer = document.getElementById('chat-drawer');
  if (!header || !drawer) return;

  let startY = 0;
  let deltaY = 0;
  let isDragging = false;

  const startDrag = (y: number) => {
    if (_isDesktop.matches || !_isChatDrawerOpen) return;
    startY = y;
    deltaY = 0;
    isDragging = true;
    drawer.style.transition = 'none';
  };

  const moveDrag = (y: number) => {
    if (!isDragging) return;
    deltaY = Math.max(0, y - startY);
    drawer.style.transform = `translateY(${deltaY}px)`;
  };

  const endDrag = () => {
    if (!isDragging) return;
    isDragging = false;
    drawer.style.transition = '';
    drawer.style.transform = '';
    if (deltaY > SWIPE_DISMISS_THRESHOLD) {
      toggleChatDrawer();
    }
  };

  // Touch events
  header.addEventListener('touchstart', (e: TouchEvent) => startDrag(e.touches[0].clientY), { passive: true });
  header.addEventListener('touchmove', (e: TouchEvent) => moveDrag(e.touches[0].clientY), { passive: true });
  header.addEventListener('touchend', endDrag);
  header.addEventListener('touchcancel', endDrag);

  // Mouse events (for small-screen PC users)
  // Attach window listeners only during active drag to prevent permanent leak
  const onMouseMove = (e: MouseEvent) => moveDrag(e.clientY);
  const onMouseUp = () => {
    endDrag();
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };
  header.addEventListener('mousedown', (e: MouseEvent) => {
    startDrag(e.clientY);
    e.preventDefault(); // prevent text selection while dragging
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });

  // Header click to close (tap or click without drag)
  header.addEventListener('click', () => {
    if (_isDesktop.matches || !_isChatDrawerOpen) return;
    if (deltaY < 5) toggleChatDrawer(); // only if no significant drag occurred
  });
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
  const cmd = parseCommand(text);
  if (cmd) {
    (input as any).contentEditable = 'false';
    input.innerHTML = '';
    void input.offsetHeight; // Force reflow
    (input as any).contentEditable = 'true';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    executeCommand(cmd);
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

  const senderLabel = _getChatLabelBase();
  const channelMode = getState('audio.channelMode') ?? 0;
  const senderRole = getRoleLabelByChannelMode(channelMode);
  const displayName = formatChatDisplayName(senderLabel);
  const myJoinOrder = getState('network.myJoinOrder') ?? 0;
  addChatMessage(displayName, text, true, isHost ? 'host' : isOp ? 'op' : undefined, myJoinOrder);

  const myId = getState('network.myId') || '';
  const chatMsg = {
    type: MSG.CHAT,
    senderId: myId,
    sender: senderLabel,
    senderLabel: senderLabel,
    senderRole: senderRole,
    isHost,
    isOp,
    text: text,
    ts: Date.now(),
    joinOrder: myJoinOrder,
  };

  if (!hostConn) {
    bus.emit('network:broadcast', chatMsg);
  } else {
    sendToHost(chatMsg);
  }

  // iOS Korean IME leak fix: a contentEditable toggle alone leaves the
  // OS-level composition buffer with the last committed char of the
  // previous message ("요안녕하세요" instead of "안녕하세요" on the next
  // send). Transferring focus to an off-screen dummy <input> for one
  // synchronous tick forces iOS to close the IME session bound to
  // chat-input; returning focus immediately starts a clean session.
  // Keyboard stays up because iOS preserves it across focusable
  // elements inside the same user-gesture stack.
  //
  // See .workshop/iosinputtest.html for the A/B that landed on this
  // (variant 15: dummySwapSync). Simpler alternatives (compositionend
  // dispatch, Selection.removeAllRanges, contenteditable removeAttr)
  // either didn't stop the leak or dropped post-send focus.
  const dummy = document.getElementById('chat-ime-dummy') as HTMLInputElement | null;
  if (dummy) {
    dummy.focus();
    input.innerHTML = '';
    input.focus();
  } else {
    // Fallback for unexpected DOM: legacy toggle (leak still possible on iOS).
    (input as any).contentEditable = 'false';
    input.innerHTML = '';
    void input.offsetHeight;
    (input as any).contentEditable = 'true';
    input.focus();
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// ─── Event Delegation ────────────────────────────────────────────

let _chatDelegationAC: AbortController | null = null;

function initChatEventDelegation(): void {
  // Tear down previous listeners on re-init
  _chatDelegationAC?.abort();
  _chatDelegationAC = new AbortController();
  const { signal } = _chatDelegationAC;

  // Timestamp seeking
  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement)?.closest?.('.chat-timestamp[data-seek]');
    if (!target) return;
    const sec = Number(target.getAttribute('data-seek'));
    if (Number.isFinite(sec)) seekTo(sec);
  }, { signal });

  document.addEventListener('keydown', (e) => {
    const target = (e.target as HTMLElement)?.closest?.('.chat-timestamp[data-seek]');
    if (!target) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    const sec = Number(target.getAttribute('data-seek'));
    if (Number.isFinite(sec)) seekTo(sec);
  }, { signal });

  // YouTube button in chat
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement)?.closest?.('.chat-youtube-btn[data-youtube-url]');
    if (!btn) return;
    const url = btn.getAttribute('data-youtube-url');
    if (url) bus.emit('youtube:load-from-chat', url);
  }, { signal });
}

// ─── Init ────────────────────────────────────────────────────────

export function initChat(): void {
  registerChatProtocolHandlers();

  initChatEventDelegation();
  initChatSwipeToDismiss();

  // Backdrop tap to close
  const backdrop = document.getElementById('chat-backdrop');
  if (backdrop) backdrop.addEventListener('click', () => {
    if (_isChatDrawerOpen) toggleChatDrawer();
  });

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
            ghost.innerHTML = `<span class="chat-cmd-ghost-typed">${escapeHtml(val)}</span><span class="chat-cmd-ghost-hint">${escapeHtml(remaining.join(' '))}</span>`;
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
      if (!items.length) { suggest.style.display = 'none'; return; }
      suggest.innerHTML = items.map((it, i) =>
        `<div class="chat-cmd-item${i === 0 ? ' active' : ''}" data-idx="${i}"><span class="chat-cmd-usage">${escapeHtml(it.usage)}</span> <span class="chat-cmd-desc">${escapeHtml(it.description)}</span></div>`
      ).join('');
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
    chatInput.addEventListener('input', () => {
      const val = getInputValue();
      updateGhost();
      if (!val.startsWith('/') || val.includes(' ')) { hideSuggest(); return; }
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
        // Mac/iOS IME Fix: If the user is currently composing a character (Korean/Japanese/etc),
        // we flag that we want to send it as soon as the composition is finished.
        // This achieves "Enter once = Send" without the duplicated character bug.
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
        setManagedTimer('chat-ime-send', () => {
          sendChatMessage();
        }, 0);
      }
    });

    // Re-render ghost text on language change
    new MutationObserver(() => updateGhost()).observe(
      document.documentElement, { attributes: true, attributeFilter: ['lang'] });

    // keyboard-open class is now managed by platform.ts via visualViewport
    // detection — fires proactively before focus, preventing layout thrashing.
    // Blur handler retained as safety-net cleanup (delayed) in case the
    // visualViewport.resize event doesn't fire (e.g. external keyboard).
    chatInput.addEventListener('blur', () => {
      setManagedTimer('kb-blur-guard', () => {
        const active = document.activeElement;
        if (!active?.matches('input, textarea, [contenteditable="true"]')) {
          document.documentElement.classList.remove('keyboard-open');
        }
      }, 400);
    });
  }

  // Render primitives emit this when a chat/whisper/notice DOM append completes.
  // Keeps drawer/unread state out of chat-render.ts (single-direction dep).
  bus.on('chat:message-rendered', (sender: string, text: string, isMine: boolean) => {
    updateChatPreview(sender, text);
    if (!isMine) incrementUnread();
  });

  // Bus event for toggling drawer from other modules
  bus.on('ui:toggle-chat-drawer', () => {
    toggleChatDrawer();
  });

  // Close chat drawer (used by YouTube load-from-chat)
  bus.on('ui:close-chat-drawer', () => {
    if (_isChatDrawerOpen) toggleChatDrawer();
  });

  // System messages from loader (avoids circular import with toast.ts)
  bus.on('chat:system-message', (text: string) => {
    addSystemChatMessage(text);
  });

  // Notice messages (host-side for OP-initiated notices)
  bus.on('chat:notice-message', (sender: string, text: string) => {
    addNoticeChatMessage(sender, text);
  });

  // Muted state: disable input
  bus.on('chat:muted-state-changed', (isMuted: boolean) => {
    const chatInput = document.getElementById('chat-input') as HTMLDivElement | null;
    if (chatInput) {
      chatInput.setAttribute('data-placeholder', isMuted ? t('chat.muted_placeholder') : t('chat.placeholder'));
      chatInput.contentEditable = isMuted ? 'false' : 'true';
      chatInput.dataset.disabled = isMuted ? 'true' : 'false';
    }
  });

  // Clear all chat messages
  bus.on('chat:clear-all', () => {
    const container = document.getElementById('chat-messages');
    if (container) {
      container.innerHTML = '';
      addSystemChatMessage(t('chat.cmd_clear'));
    }
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

  // Custom scrollbar (desktop only — floats above content)
  // Custom scrollbar now handled globally by custom-scrollbar.ts

  log.info('[Chat] Initialized');
}

// Custom scrollbar is now handled by src/ui/custom-scrollbar.ts

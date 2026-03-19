/**
 * MUSIXQUARE 3.0 — Chat System
 *
 * Manages: sendChatMessage, addChatMessage, parseMessageContent,
 * chat drawer toggle, YouTube oEmbed title in chat.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, PEER_NAME_PREFIX } from '../core/constants.ts';
import { setManagedTimer } from '../core/timers.ts';
import { registerHandlers } from '../network/protocol.ts';
import { sendToHost } from '../network/peer.ts';
import { escapeHtml, escapeAttr } from './dom.ts';
import { t } from '../i18n/index.ts';
import { getRoleLabelByChannelMode } from './player-controls.ts';
import { fetchOEmbedTitle } from '../youtube/search.ts';
import { parseCommand, executeCommand, getAvailableCommands } from '../chat/commands.ts';
import { filterProfanity } from '../chat/profanity.ts';
import type { DataConnection } from '../types/index.ts';

const MAX_CHAT_MESSAGES = 200;

// ─── Chat State ──────────────────────────────────────────────────

let _unreadCount = 0;
let _isChatDrawerOpen = false;

// ─── Helpers ─────────────────────────────────────────────────────

function _getChatLabelBase(): string {
  const hostConn = getState('network.hostConn');
  const myDeviceLabel = getState('network.myDeviceLabel') || '';
  const label = myDeviceLabel.trim();

  if (!hostConn) {
    // Host: use custom label if set, otherwise default 'Host'
    return (label && label !== 'HOST') ? label : 'Host';
  }

  if (!label || label === 'HOST' || label === 'Guest' || label === t('common.guest')) return PEER_NAME_PREFIX;

  const role0 = getRoleLabelByChannelMode(0);
  const roleL = getRoleLabelByChannelMode(-1);
  const roleR = getRoleLabelByChannelMode(1);
  const roleS = getRoleLabelByChannelMode(2);
  if (label === role0 || label === roleL || label === roleR || label === roleS) return PEER_NAME_PREFIX;

  return label;
}

function _formatChatDisplayName(label: string): string {
  const l = (label && label.trim()) ? label.trim() : PEER_NAME_PREFIX;
  return l;
}

function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// ─── Parse Message Content ───────────────────────────────────────

const _ytRegex = /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[a-zA-Z0-9_-]{11}[^\s]*/gi;
const _tsRegex = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;
const _combinedRegex = new RegExp(
  `(${_ytRegex.source})|(${_tsRegex.source})`,
  'gi'
);

function parseMessageContent(text: string): string {
  // Reset lastIndex for global regexes reused across calls
  _ytRegex.lastIndex = 0;
  _tsRegex.lastIndex = 0;
  _combinedRegex.lastIndex = 0;

  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = _combinedRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result += escapeHtml(text.slice(lastIndex, match.index));
    }

    const matchedText = match[0];

    _ytRegex.lastIndex = 0;
    if (_ytRegex.test(matchedText)) {
      const cleanUrl = matchedText.startsWith('http') ? matchedText : 'https://' + matchedText;
      const uniqueId = 'yt-' + Math.random().toString(36).substring(2, 11);

      result += `
        <button type="button" class="chat-youtube-btn" data-youtube-url="${escapeAttr(cleanUrl)}" aria-label="${escapeAttr(t('youtube.open_link'))}" aria-describedby="${uniqueId}">
          <div class="chat-yt-play-row">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg>
            YouTube
          </div>
          <div id="${uniqueId}" class="chat-yt-title">${escapeHtml(matchedText)}</div>
        </button>
      `;

      setManagedTimer(`yt-chat-title-${uniqueId}`, () => updateYouTubeChatTitle(uniqueId, cleanUrl), 100);
    } else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(matchedText)) {
      const seconds = parseTimestamp(matchedText);
      result += `<span class="chat-timestamp" role="button" tabindex="0" aria-label="Seek to ${escapeAttr(matchedText)}" data-seek="${seconds}">${escapeHtml(matchedText)}</span>`;
    } else {
      result += escapeHtml(matchedText);
    }

    lastIndex = _combinedRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    result += escapeHtml(text.slice(lastIndex));
  }

  return result;
}

async function updateYouTubeChatTitle(elementId: string, url: string): Promise<void> {
  try {
    const title = await fetchOEmbedTitle(url);
    if (title) {
      const el = document.getElementById(elementId);
      if (el) el.textContent = title;
    }
  } catch { /* ignore */ }
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
    const input = document.getElementById('chat-input') as HTMLInputElement | null;
    if (input) setManagedTimer('chat-input-focus', () => input.focus(), 300);
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
  header.addEventListener('mousedown', (e: MouseEvent) => {
    startDrag(e.clientY);
    e.preventDefault(); // prevent text selection while dragging
  });
  window.addEventListener('mousemove', (e: MouseEvent) => moveDrag(e.clientY));
  window.addEventListener('mouseup', endDrag);

  // Header click to close (tap or click without drag)
  header.addEventListener('click', () => {
    if (_isDesktop.matches || !_isChatDrawerOpen) return;
    if (deltaY < 5) toggleChatDrawer(); // only if no significant drag occurred
  });
}

// ─── Send & Receive ──────────────────────────────────────────────

const MAX_MSG_LENGTH = 500;

let _lastSentTime = 0;

export function sendChatMessage(): void {
  const input = document.getElementById('chat-input') as HTMLInputElement | null;
  if (!input) return;
  let text = input.value.trim();
  if (!text) return;

  // ── Command intercept ──
  const cmd = parseCommand(text);
  if (cmd) {
    input.value = '';
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
  if (slowmode > 0 && !isHost) {
    const elapsed = (Date.now() - _lastSentTime) / 1000;
    if (elapsed < slowmode) {
      addSystemChatMessage(t('chat.cmd_slowmode_wait', { sec: Math.ceil(slowmode - elapsed) }));
      return;
    }
  }
  _lastSentTime = Date.now();

  if (text.length > MAX_MSG_LENGTH) {
    text = text.substring(0, MAX_MSG_LENGTH);
    bus.emit('ui:show-toast', t('chat.msg_truncated', { max: MAX_MSG_LENGTH }));
  }

  // ── Profanity filter (own messages too) ──
  if (getState('network.filterEnabled')) {
    text = filterProfanity(text);
  }

  const senderLabel = _getChatLabelBase();
  const channelMode = getState('audio.channelMode') ?? 0;
  const senderRole = getRoleLabelByChannelMode(channelMode);
  const displayName = _formatChatDisplayName(senderLabel);
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

  input.value = '';
}

function pruneOldMessages(container: HTMLElement): void {
  while (container.children.length > MAX_CHAT_MESSAGES) {
    container.removeChild(container.children[0]);
  }
}

const CROWN_SVG = '<svg class="chat-crown" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5z"/></svg>';

export function addChatMessage(sender: string, text: string, isMine: boolean, badge?: 'host' | 'op', joinOrder?: number): void {
  const container = document.getElementById('chat-messages');

  if (container) {
    const empty = container.querySelector('.chat-empty');
    if (empty) empty.remove();

    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    const group = document.createElement('div');
    group.className = `chat-group ${isMine ? 'mine' : 'others'}`;

    const senderNode = document.createElement('div');
    senderNode.className = 'chat-sender';
    if (badge) {
      const crown = document.createElement('span');
      crown.className = `chat-badge-${badge}`;
      crown.innerHTML = CROWN_SVG;
      senderNode.appendChild(crown);
    }
    senderNode.appendChild(document.createTextNode(sender));
    if (typeof joinOrder === 'number') {
      const orderSpan = document.createElement('span');
      orderSpan.className = 'chat-join-order';
      orderSpan.textContent = ` #${joinOrder}`;
      senderNode.appendChild(orderSpan);
    }
    group.appendChild(senderNode);

    const row = document.createElement('div');
    row.className = 'chat-row';

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isMine ? 'mine' : 'others'}`;
    const chatTextDiv = document.createElement('div');
    chatTextDiv.className = 'chat-text';
    chatTextDiv.innerHTML = parseMessageContent(text);
    bubble.appendChild(chatTextDiv);

    try {
      if (bubble.querySelector('.chat-youtube-btn')) bubble.classList.add('has-youtube');
    } catch { /* ignore */ }

    const timeNode = document.createElement('div');
    timeNode.className = 'chat-time';
    timeNode.innerText = timeStr;

    if (isMine) {
      row.appendChild(timeNode);
      row.appendChild(bubble);
    } else {
      row.appendChild(bubble);
      row.appendChild(timeNode);
    }

    group.appendChild(row);
    container.appendChild(group);
    pruneOldMessages(container);
    container.scrollTop = container.scrollHeight;
  }

  updateChatPreview(sender, text);

  if (!isMine) {
    incrementUnread();
  }
}

// ─── System Message (no preview update, no unread increment) ────

export function addSystemChatMessage(text: string): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();

  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  const group = document.createElement('div');
  group.className = 'chat-group others system';

  const senderNode = document.createElement('div');
  senderNode.className = 'chat-sender';
  senderNode.innerText = t('common.system');
  group.appendChild(senderNode);

  const row = document.createElement('div');
  row.className = 'chat-row';

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble others system';
  const chatTextDiv = document.createElement('div');
  chatTextDiv.className = 'chat-text';
  chatTextDiv.textContent = text;
  bubble.appendChild(chatTextDiv);

  const timeNode = document.createElement('div');
  timeNode.className = 'chat-time';
  timeNode.innerText = timeStr;

  row.appendChild(bubble);
  row.appendChild(timeNode);
  group.appendChild(row);
  container.appendChild(group);
  pruneOldMessages(container);
  container.scrollTop = container.scrollHeight;
}

// ─── Whisper Message ─────────────────────────────────────────────

export function addWhisperMessage(peerLabel: string, text: string, isSent: boolean): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();

  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  const group = document.createElement('div');
  group.className = `chat-group ${isSent ? 'mine' : 'others'} whisper`;

  const senderNode = document.createElement('div');
  senderNode.className = 'chat-sender whisper-label';
  senderNode.textContent = isSent
    ? t('chat.cmd_whisper_to', { name: peerLabel })
    : t('chat.cmd_whisper_from', { name: peerLabel });
  group.appendChild(senderNode);

  const row = document.createElement('div');
  row.className = 'chat-row';

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${isSent ? 'mine' : 'others'} whisper`;
  const chatTextDiv = document.createElement('div');
  chatTextDiv.className = 'chat-text';
  chatTextDiv.innerHTML = parseMessageContent(text);
  bubble.appendChild(chatTextDiv);

  const timeNode = document.createElement('div');
  timeNode.className = 'chat-time';
  timeNode.innerText = timeStr;

  if (isSent) { row.appendChild(timeNode); row.appendChild(bubble); }
  else { row.appendChild(bubble); row.appendChild(timeNode); }

  group.appendChild(row);
  container.appendChild(group);
  pruneOldMessages(container);
  container.scrollTop = container.scrollHeight;
}

// ─── Notice Message ─────────────────────────────────────────────

export function addNoticeChatMessage(sender: string, text: string): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();

  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  const group = document.createElement('div');
  group.className = 'chat-group others notice';

  const senderNode = document.createElement('div');
  senderNode.className = 'chat-sender notice-label';
  senderNode.textContent = `${t('chat.cmd_notice_prefix')} — ${sender}`;
  group.appendChild(senderNode);

  const row = document.createElement('div');
  row.className = 'chat-row';

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble others notice';
  const chatTextDiv = document.createElement('div');
  chatTextDiv.className = 'chat-text';
  chatTextDiv.textContent = text;
  bubble.appendChild(chatTextDiv);

  const timeNode = document.createElement('div');
  timeNode.className = 'chat-time';
  timeNode.innerText = timeStr;

  row.appendChild(bubble);
  row.appendChild(timeNode);
  group.appendChild(row);
  container.appendChild(group);
  pruneOldMessages(container);
  container.scrollTop = container.scrollHeight;

  incrementUnread();
}

// ─── Handler for Incoming Chat ───────────────────────────────────

function handleChatMessage(data: Record<string, unknown>, conn: DataConnection): void {
  const myId = getState('network.myId') || '';
  const senderId = data.senderId as string || '';
  const isMine = senderId === myId;
  const hostConn = getState('network.hostConn');

  // ── Host-side enforcement: mute, freeze ──
  if (!hostConn && !isMine) {
    const senderPeerId = (data._originPeer as string) || senderId || conn?.peer || '';
    // Muted user — silently drop
    if (getState('network.mutedPeers').has(senderPeerId)) return;
    // Frozen chat — non-OP non-host blocked
    if (getState('network.chatFrozen') && !data.isHost && !data.isOp) return;
  }

  const senderLabel = (data.senderLabel as string) || (data.sender as string) || PEER_NAME_PREFIX;
  const displayName = _formatChatDisplayName(senderLabel);
  let text = (data.text as string) || '';
  if (text.length > MAX_MSG_LENGTH) text = text.substring(0, MAX_MSG_LENGTH);

  // ── Host-side profanity filter ──
  if (!hostConn && getState('network.filterEnabled')) {
    text = filterProfanity(text);
    data.text = text; // Update data so relay sends filtered text
  }

  const badge: 'host' | 'op' | undefined = data.isHost ? 'host' : data.isOp ? 'op' : undefined;
  const joinOrder = typeof data.joinOrder === 'number' ? data.joinOrder : undefined;
  addChatMessage(displayName, text, isMine, badge, joinOrder);

  // Relay to downstream peers (Host only), excluding the sender to avoid duplicates
  if (!hostConn) {
    const senderPeerId = senderId || conn?.peer || '';
    bus.emit('network:broadcast-except', senderPeerId, data);
  }
}

// ─── Chat Command Protocol Handlers ─────────────────────────────

function handleChatMute(data: Record<string, unknown>): void {
  const targetId = data.targetId as string;
  const targetLabel = data.targetLabel as string;
  const myId = getState('network.myId') || '';

  if (targetId === myId) {
    bus.emit('chat:muted-state-changed', true);
  }
  addSystemChatMessage(t('chat.cmd_muted', { name: targetLabel }));
}

function handleChatUnmute(data: Record<string, unknown>): void {
  const targetId = data.targetId as string;
  const targetLabel = data.targetLabel as string;
  const myId = getState('network.myId') || '';

  if (targetId === myId) {
    bus.emit('chat:muted-state-changed', false);
  }
  addSystemChatMessage(t('chat.cmd_unmuted', { name: targetLabel }));
}

function handleChatFreeze(): void {
  setState('network.chatFrozen', true);
  addSystemChatMessage(t('chat.cmd_frozen'));
}

function handleChatUnfreeze(): void {
  setState('network.chatFrozen', false);
  addSystemChatMessage(t('chat.cmd_unfrozen'));
}

function handleChatClear(): void {
  bus.emit('chat:clear-all');
}

function handleChatWhisper(data: Record<string, unknown>): void {
  const myId = getState('network.myId') || '';
  const targetId = data.targetId as string || '';
  const senderId = data.senderId as string || '';
  const senderLabel = data.senderLabel as string || '';
  const text = data.text as string || '';
  const hostConn = getState('network.hostConn');

  // Host relays whisper to target only
  if (!hostConn && senderId !== myId) {
    if (targetId === myId) {
      // Whisper is for us (the host)
      addWhisperMessage(senderLabel, text, false);
    } else {
      // Relay to target peer only
      const connMap = getState('network.activeHostConnByPeerId');
      const targetConn = connMap.get(targetId);
      if (targetConn) targetConn.send(data);
    }
    return;
  }

  // Guest receiving whisper
  if (senderId !== myId) {
    addWhisperMessage(senderLabel, text, false);
  }
}

function handleChatNotice(data: Record<string, unknown>): void {
  const senderLabel = data.senderLabel as string || '';
  const text = data.text as string || '';
  addNoticeChatMessage(senderLabel, text);
}

function handleChatSlowmode(data: Record<string, unknown>): void {
  const seconds = data.seconds as number || 0;
  setState('network.slowmodeSeconds', seconds);
  addSystemChatMessage(seconds > 0
    ? t('chat.cmd_slowmode_on', { sec: seconds })
    : t('chat.cmd_slowmode_off'));
}

function handleChatSystem(data: Record<string, unknown>): void {
  const text = data.text as string || '';
  if (text) addSystemChatMessage(text);
}

// ─── Event Delegation ────────────────────────────────────────────

function initChatEventDelegation(): void {
  // Timestamp seeking
  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement)?.closest?.('.chat-timestamp[data-seek]');
    if (!target) return;
    const sec = Number(target.getAttribute('data-seek'));
    if (Number.isFinite(sec)) bus.emit('player:seek-to-time', sec);
  });

  document.addEventListener('keydown', (e) => {
    const target = (e.target as HTMLElement)?.closest?.('.chat-timestamp[data-seek]');
    if (!target) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    const sec = Number(target.getAttribute('data-seek'));
    if (Number.isFinite(sec)) bus.emit('player:seek-to-time', sec);
  });

  // YouTube button in chat
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement)?.closest?.('.chat-youtube-btn[data-youtube-url]');
    if (!btn) return;
    const url = btn.getAttribute('data-youtube-url');
    if (url) bus.emit('youtube:load-from-chat', url);
  });
}

// ─── Init ────────────────────────────────────────────────────────

export function initChat(): void {
  registerHandlers({
    [MSG.CHAT]: handleChatMessage,
    [MSG.CHAT_MUTE]: handleChatMute,
    [MSG.CHAT_UNMUTE]: handleChatUnmute,
    [MSG.CHAT_FREEZE]: handleChatFreeze,
    [MSG.CHAT_UNFREEZE]: handleChatUnfreeze,
    [MSG.CHAT_CLEAR]: handleChatClear,
    [MSG.CHAT_WHISPER]: handleChatWhisper,
    [MSG.CHAT_NOTICE]: handleChatNotice,
    [MSG.CHAT_SLOWMODE]: handleChatSlowmode,
    [MSG.CHAT_SYSTEM]: handleChatSystem,
  });

  initChatEventDelegation();
  initChatSwipeToDismiss();

  // Backdrop tap to close
  const backdrop = document.getElementById('chat-backdrop');
  if (backdrop) backdrop.addEventListener('click', () => {
    if (_isChatDrawerOpen) toggleChatDrawer();
  });

  // Wire up UI buttons
  const sendBtn = document.getElementById('btn-chat-send');
  if (sendBtn) sendBtn.addEventListener('click', sendChatMessage);

  const closeBtn = document.getElementById('btn-chat-close');
  if (closeBtn) closeBtn.addEventListener('click', toggleChatDrawer);

  const previewBtn = document.getElementById('chat-preview-btn');
  if (previewBtn) previewBtn.addEventListener('click', toggleChatDrawer);

  // Chat input: send on Enter + command autocomplete
  const chatInput = document.getElementById('chat-input') as HTMLInputElement | null;
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
      chatInput.value = `/${item.name} `;
      chatInput.focus();
      hideSuggest();
    }

    // Input event: filter commands
    chatInput.addEventListener('input', () => {
      const val = chatInput.value;
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
      setTimeout(hideSuggest, 150);
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
          suggest.querySelectorAll('.chat-cmd-item').forEach((el, i) =>
            el.classList.toggle('active', i === _suggestIdx));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          _suggestIdx = (_suggestIdx - 1 + _suggestItems.length) % _suggestItems.length;
          suggest.querySelectorAll('.chat-cmd-item').forEach((el, i) =>
            el.classList.toggle('active', i === _suggestIdx));
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hideSuggest();
          return;
        }
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          applySuggest();
          return;
        }
      }

      // Normal Enter: send message
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }

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

  // Muted state: disable input
  bus.on('chat:muted-state-changed', (isMuted: boolean) => {
    const chatInput = document.getElementById('chat-input') as HTMLInputElement | null;
    if (chatInput) {
      chatInput.placeholder = isMuted ? t('chat.muted_placeholder') : t('chat.placeholder');
      chatInput.disabled = isMuted;
    }
  });

  // Clear all chat messages
  bus.on('chat:clear-all', () => {
    const container = document.getElementById('chat-messages');
    if (container) {
      container.innerHTML = '';
      addSystemChatMessage(t('chat.cmd_clear'));
    }
  });

  log.info('[Chat] Initialized');
}

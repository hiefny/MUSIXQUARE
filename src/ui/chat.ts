/**
 * MUSIXQUARE 2.0 — Chat System
 * Extracted from original app.js lines 10624-10860
 *
 * Manages: sendChatMessage, addChatMessage, parseMessageContent,
 * chat drawer toggle, YouTube oEmbed title in chat.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { registerHandlers } from '../network/protocol.ts';
import { escapeHtml, escapeAttr } from './dom.ts';
import { showToast } from './toast.ts';
import { fetchOEmbedTitle } from '../youtube/search.ts';
import type { DataConnection } from '../types/index.ts';

// ─── Constants ───────────────────────────────────────────────────

const PEER_NAME_PREFIX = 'Peer';

const STANDARD_ROLE_MAP: Record<string, { label: string }> = {
  '0': { label: 'Original' },
  '-1': { label: 'Left' },
  '1': { label: 'Right' },
  '2': { label: 'Woofer' },
};

function getRoleLabelByChannelMode(mode: number): string {
  return (STANDARD_ROLE_MAP[String(mode)] || STANDARD_ROLE_MAP['0']).label;
}

// ─── Chat State ──────────────────────────────────────────────────

let _lastChatSender = '';
let _lastChatText = '';
let _unreadCount = 0;
let _isChatDrawerOpen = false;

// ─── Helpers ─────────────────────────────────────────────────────

function _getChatLabelBase(): string {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (!hostConn) return 'Host';

  const myDeviceLabel = getState<string>('network.myDeviceLabel') || '';
  const label = myDeviceLabel.trim();

  if (!label || label === 'HOST' || label === 'Guest' || label === '참가자') return PEER_NAME_PREFIX;

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

function parseMessageContent(text: string): string {
  const ytRegex = /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[a-zA-Z0-9_-]{11}[^\s]*/gi;
  const tsRegex = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;

  const combinedRegex = new RegExp(
    `(${ytRegex.source})|(${tsRegex.source})`,
    'gi'
  );

  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combinedRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result += escapeHtml(text.slice(lastIndex, match.index));
    }

    const matchedText = match[0];

    ytRegex.lastIndex = 0;
    if (ytRegex.test(matchedText)) {
      const cleanUrl = matchedText.startsWith('http') ? matchedText : 'https://' + matchedText;
      const uniqueId = 'yt-' + Math.random().toString(36).substr(2, 9);

      result += `
        <button type="button" class="chat-youtube-btn" data-youtube-url="${escapeAttr(cleanUrl)}" aria-label="YouTube 링크 열기" aria-describedby="${uniqueId}">
          <div class="chat-yt-play-row">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg>
            YouTube
          </div>
          <div id="${uniqueId}" class="chat-yt-title">${escapeHtml(matchedText)}</div>
        </button>
      `;

      setTimeout(() => updateYouTubeChatTitle(uniqueId, cleanUrl), 100);
    } else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(matchedText)) {
      const seconds = parseTimestamp(matchedText);
      result += `<span class="chat-timestamp" role="button" tabindex="0" data-seek="${seconds}">${escapeHtml(matchedText)}</span>`;
    } else {
      result += escapeHtml(matchedText);
    }

    lastIndex = combinedRegex.lastIndex;
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

  if (_isChatDrawerOpen) {
    resetUnread();
    const messages = document.getElementById('chat-messages');
    if (messages) messages.scrollTop = messages.scrollHeight;
    const input = document.getElementById('chat-input') as HTMLInputElement | null;
    if (input) setTimeout(() => input.focus(), 300);
  }
}

// ─── Send & Receive ──────────────────────────────────────────────

export function sendChatMessage(): void {
  const input = document.getElementById('chat-input') as HTMLInputElement | null;
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const senderLabel = _getChatLabelBase();
  const channelMode = getState<number>('audio.channelMode') ?? 0;
  const senderRole = getRoleLabelByChannelMode(channelMode);
  const displayName = _formatChatDisplayName(senderLabel);

  addChatMessage(displayName, text, true);

  const myId = getState<string>('network.myId') || '';
  const chatMsg = {
    type: MSG.CHAT,
    senderId: myId,
    sender: senderLabel,
    senderLabel: senderLabel,
    senderRole: senderRole,
    text: text,
    ts: Date.now(),
  };

  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (!hostConn) {
    bus.emit('network:broadcast', chatMsg);
  } else {
    if (hostConn.open) hostConn.send(chatMsg);
  }

  input.value = '';
}

export function addChatMessage(sender: string, text: string, isMine: boolean): void {
  const container = document.getElementById('chat-messages');

  if (container) {
    const empty = container.querySelector('.chat-empty');
    if (empty) empty.remove();

    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    const group = document.createElement('div');
    group.className = `chat-group ${isMine ? 'mine' : 'others'}`;

    if (!isMine) {
      const senderNode = document.createElement('div');
      senderNode.className = 'chat-sender';
      senderNode.innerText = sender;
      group.appendChild(senderNode);
    }

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
    container.scrollTop = container.scrollHeight;
  }

  _lastChatSender = sender;
  _lastChatText = text;
  updateChatPreview(sender, text);

  if (!isMine) {
    incrementUnread();
  }
}

// ─── Handler for Incoming Chat ───────────────────────────────────

function handleChatMessage(data: Record<string, unknown>, conn: DataConnection): void {
  const myId = getState<string>('network.myId') || '';
  const senderId = data.senderId as string || '';
  const isMine = senderId === myId;

  const senderLabel = (data.senderLabel as string) || (data.sender as string) || PEER_NAME_PREFIX;
  const displayName = _formatChatDisplayName(senderLabel);
  const text = (data.text as string) || '';

  addChatMessage(displayName, text, isMine);

  // Relay to downstream peers (Host only), excluding the sender to avoid duplicates
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (!hostConn) {
    const senderPeerId = conn?.peer || (senderId as string) || '';
    bus.emit('network:broadcast-except', senderPeerId, data);
  }
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

// ─── Emoji Insertion ─────────────────────────────────────────────

function insertEmoji(emoji: string): void {
  const input = document.getElementById('chat-input') as HTMLInputElement | null;
  if (input) {
    input.value += emoji;
    input.focus();
  }
}

// Expose globally for emoji picker buttons in HTML
(window as unknown as Record<string, unknown>).insertEmoji = insertEmoji;

// ─── Init ────────────────────────────────────────────────────────

export function initChat(): void {
  registerHandlers({
    [MSG.CHAT]: handleChatMessage,
  });

  initChatEventDelegation();

  // Wire up UI buttons
  const sendBtn = document.getElementById('btn-chat-send');
  if (sendBtn) sendBtn.addEventListener('click', sendChatMessage);

  const closeBtn = document.getElementById('btn-chat-close');
  if (closeBtn) closeBtn.addEventListener('click', toggleChatDrawer);

  const previewBtn = document.getElementById('chat-preview-btn');
  if (previewBtn) previewBtn.addEventListener('click', toggleChatDrawer);

  // Chat input: send on Enter
  const chatInput = document.getElementById('chat-input') as HTMLInputElement | null;
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }

  // Bus event for toggling drawer from other modules
  bus.on('ui:toggle-chat-drawer', ((..._args: unknown[]) => {
    toggleChatDrawer();
  }) as (...args: unknown[]) => void);

  // Close chat drawer (used by YouTube load-from-chat)
  bus.on('ui:close-chat-drawer', ((..._args: unknown[]) => {
    if (_isChatDrawerOpen) toggleChatDrawer();
  }) as (...args: unknown[]) => void);

  log.info('[Chat] Initialized');
}

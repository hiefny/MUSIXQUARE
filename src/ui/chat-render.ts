/**
 * MUSIXQUARE — Chat Render Primitives
 *
 * Pure DOM rendering for chat: bubble groups, system/whisper/notice messages,
 * inline YouTube buttons, timestamp links. No drawer/unread state — render
 * funcs emit `chat:message-rendered` so ui/chat.ts can update the preview
 * and unread badge. Importable by commands.ts and chat/protocol.ts without
 * dragging in the full chat UI shell.
 */

import { bus } from '../core/events.ts';
import { setManagedTimer } from '../core/timers.ts';
import { PEER_NAME_PREFIX } from '../core/constants.ts';
import { escapeHtml, escapeAttr } from './dom.ts';
import { t } from '../i18n/index.ts';
import { fetchOEmbedTitle } from '../youtube/search.ts';

export const MAX_CHAT_MESSAGES = 200;
export const MAX_SENDER_LABEL_LENGTH = 30;
export const MAX_MSG_LENGTH = 500;

const CROWN_SVG = '<svg class="chat-crown" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5z"/></svg>';

// ─── Label Helper ────────────────────────────────────────────────

export function formatChatDisplayName(label: string): string {
  const l = (label && label.trim()) ? label.trim() : PEER_NAME_PREFIX;
  return l;
}

// ─── Parse Message Content ───────────────────────────────────────

function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// Non-global for .test() — avoids fragile lastIndex resets
const _ytTestRegex = /(https?:\/\/)?(www\.)?(youtube\.com\/playlist\?list=|youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[a-zA-Z0-9_-]+[^\s]*/i;
const _ytSource = _ytTestRegex.source;
const _tsSource = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/.source;
// Global combined regex for exec() loop
const _combinedRegex = new RegExp(`(${_ytSource})|(${_tsSource})`, 'gi');

export function parseMessageContent(text: string): string {
  _combinedRegex.lastIndex = 0;

  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = _combinedRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result += escapeHtml(text.slice(lastIndex, match.index));
    }

    const matchedText = match[0];

    if (_ytTestRegex.test(matchedText)) {
      const cleanUrl = matchedText.startsWith('http') ? matchedText : 'https://' + matchedText;
      const uniqueId = 'yt-' + Math.random().toString(36).substring(2, 11);

      result += `
        <button type="button" class="chat-youtube-btn" data-youtube-url="${escapeAttr(cleanUrl)}" aria-label="${escapeAttr(t('youtube.open_link'))}" aria-describedby="${uniqueId}">
          <div class="chat-yt-play-row">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg>
            <span class="chat-yt-label">YouTube</span>
          </div>
          <div id="${uniqueId}" class="chat-yt-title">${escapeHtml(matchedText)}</div>
        </button>
      `;

      setManagedTimer(`yt-chat-title-${uniqueId}`, () => updateYouTubeChatTitle(uniqueId, cleanUrl), 100);
    } else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(matchedText)) {
      const seconds = parseTimestamp(matchedText);
      result += `<span class="chat-timestamp" role="button" tabindex="0" aria-label="${escapeAttr(t('chat.seek_to', { time: matchedText }))}" data-seek="${seconds}">${escapeHtml(matchedText)}</span>`;
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

// ─── DOM Helpers ─────────────────────────────────────────────────

function pruneOldMessages(container: HTMLElement): void {
  while (container.children.length > MAX_CHAT_MESSAGES) {
    container.removeChild(container.children[0]);
  }
}

// ─── Render: Regular Chat Message ────────────────────────────────

export function addChatMessage(sender: string, text: string, isMine: boolean, badge?: 'host' | 'op', joinOrder?: number): void {
  const container = document.getElementById('chat-messages');

  if (container) {
    const empty = container.querySelector('.chat-empty');
    if (empty) empty.remove();

    // Desktop: hide chat title when messages exist
    const drawer = document.getElementById('chat-drawer');
    if (drawer) drawer.classList.add('has-messages');

    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    // Check if we can append to the previous group (same sender + same minute)
    const lastGroup = container.lastElementChild as HTMLElement | null;
    const lastSenderId = lastGroup?.dataset.senderId;
    const lastTimeStr = lastGroup?.dataset.timeStr;
    const canGroup = lastGroup
      && !lastGroup.classList.contains('system')
      && lastSenderId === sender
      && lastTimeStr === timeStr
      && ((isMine && lastGroup.classList.contains('mine')) || (!isMine && lastGroup.classList.contains('others')));

    if (canGroup && lastGroup) {
      // Remove time from the previous row's last bubble
      const prevRows = lastGroup.querySelectorAll('.chat-row');
      const prevLastRow = prevRows[prevRows.length - 1];
      if (prevLastRow) {
        const prevTime = prevLastRow.querySelector('.chat-time');
        if (prevTime) prevTime.remove();
      }

      // Add new row to existing group
      const row = document.createElement('div');
      row.className = 'chat-row';

      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${isMine ? 'mine' : 'others'}`;
      const chatTextDiv = document.createElement('div');
      chatTextDiv.className = 'chat-text';
      chatTextDiv.innerHTML = parseMessageContent(text);
      bubble.appendChild(chatTextDiv);
      try { if (bubble.querySelector('.chat-youtube-btn')) bubble.classList.add('has-youtube'); } catch { /* ignore */ }

      const timeNode = document.createElement('div');
      timeNode.className = 'chat-time';
      timeNode.innerText = timeStr;

      if (isMine) { row.appendChild(timeNode); row.appendChild(bubble); }
      else { row.appendChild(bubble); row.appendChild(timeNode); }

      lastGroup.appendChild(row);
      lastGroup.dataset.timeStr = timeStr;
    } else {
      // Create new group
      const group = document.createElement('div');
      group.className = `chat-group ${isMine ? 'mine' : 'others'}`;
      group.dataset.senderId = sender;
      group.dataset.timeStr = timeStr;

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
      try { if (bubble.querySelector('.chat-youtube-btn')) bubble.classList.add('has-youtube'); } catch { /* ignore */ }

      const timeNode = document.createElement('div');
      timeNode.className = 'chat-time';
      timeNode.innerText = timeStr;

      if (isMine) { row.appendChild(timeNode); row.appendChild(bubble); }
      else { row.appendChild(bubble); row.appendChild(timeNode); }

      group.appendChild(row);
      container.appendChild(group);
    }

    // Update time when minute changes on existing group
    if (canGroup && lastGroup) {
      const allRows = lastGroup.querySelectorAll('.chat-row');
      const lastRow = allRows[allRows.length - 1];
      if (lastRow && !lastRow.querySelector('.chat-time')) {
        const timeNode = document.createElement('div');
        timeNode.className = 'chat-time';
        timeNode.innerText = timeStr;
        if (isMine) lastRow.insertBefore(timeNode, lastRow.firstChild);
        else lastRow.appendChild(timeNode);
      }
    }

    pruneOldMessages(container);
    container.scrollTop = container.scrollHeight;
  }

  bus.emit('chat:message-rendered', sender, text, isMine);
}

// ─── Render: System Message ──────────────────────────────────────
// System messages bypass `chat:message-rendered` on purpose: they're local
// notices (command output, errors) that shouldn't touch preview/unread.

export function addSystemChatMessage(text: string): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();

  const drawer = document.getElementById('chat-drawer');
  if (drawer) drawer.classList.add('has-messages');

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
  // First line bold if multi-line (command output headers like /help, /users, /debug)
  const msgLines = text.split('\n');
  if (msgLines.length > 1) {
    const strong = document.createElement('strong');
    strong.textContent = msgLines[0];
    chatTextDiv.appendChild(strong);
    chatTextDiv.appendChild(document.createTextNode('\n' + msgLines.slice(1).join('\n')));
  } else {
    chatTextDiv.textContent = text;
  }
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

// ─── Render: Whisper Message ─────────────────────────────────────

export function addWhisperMessage(peerLabel: string, text: string, isSent: boolean): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();

  const drawer = document.getElementById('chat-drawer');
  if (drawer) drawer.classList.add('has-messages');

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

  // isMine=isSent so chat.ts's handler skips incrementUnread for outgoing
  // whispers but still updates preview for both directions.
  bus.emit('chat:message-rendered', peerLabel, text, isSent);
}

// ─── Render: Notice Message ──────────────────────────────────────

export function addNoticeChatMessage(sender: string, text: string): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();

  const drawer = document.getElementById('chat-drawer');
  if (drawer) drawer.classList.add('has-messages');

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

  // Also pin above the feed so a fast-scrolling chat doesn't bury it.
  setPinnedNotice(sender, text);

  bus.emit('chat:message-rendered', sender, text, false);
}

// ─── Pinned Notice Banner ────────────────────────────────────────

export function setPinnedNotice(sender: string, text: string): void {
  const banner = document.getElementById('chat-pinned-notice');
  const label = document.getElementById('chat-pinned-notice-label');
  const body = document.getElementById('chat-pinned-notice-text');
  if (!banner || !label || !body) return;
  label.textContent = `${t('chat.cmd_notice_prefix')} — ${sender}`;
  body.textContent = text;
  banner.hidden = false;
  // Hide the chat title once a notice is pinned — same rule as first message.
  const drawer = document.getElementById('chat-drawer');
  if (drawer) drawer.classList.add('has-messages');
}

export function clearPinnedNotice(): void {
  const banner = document.getElementById('chat-pinned-notice');
  if (banner) banner.hidden = true;
}

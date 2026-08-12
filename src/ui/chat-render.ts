/**
 * MUSIXQUARE — Chat Render Primitives
 *
 * Pure DOM rendering for chat: bubble groups, system/whisper messages, pinned
 * notice banners, inline YouTube buttons, timestamp links. No drawer/unread
 * state — render funcs emit `chat:message-rendered` so ui/chat.ts can update
 * the preview and unread badge. Importable by commands.ts and chat/protocol.ts
 * without dragging in the full chat UI shell.
 */

import { bus } from '../core/events.ts';
import { setManagedTimer } from '../core/timers.ts';
import { PEER_NAME_PREFIX } from '../core/constants.ts';
import { escapeHtml, escapeAttr } from './dom.ts';
import { applyUserTextFontFallback } from './user-text-font.ts';
import { t } from '../i18n/index.ts';
// Import the pure oEmbed fetcher leaf, NOT youtube/search.ts — the search
// module pulls in the network/peer facade (broadcast) and would re-create
// the ui/network/chat/youtube import cycle.
import { fetchOEmbedTitle } from '../youtube/oembed.ts';

// Render-owned DOM prune cap. The chat WIRE caps (MAX_MSG_LENGTH,
// MAX_SENDER_LABEL_LENGTH) live in core/constants.ts — protocol code must
// not import them from a render module.
const MAX_CHAT_MESSAGES = 200;

// Sticky-bottom tolerance: how close to the bottom (in CSS px) counts as
// "still at the bottom" when deciding whether a new message should auto-
// scroll the chat. Browsers can leave fractional pixel offsets after
// momentum scroll; a flat ≤24 cutoff would let a sub-pixel jitter flip
// the user out of sticky mode mid-conversation.
const STICKY_BOTTOM_TOLERANCE_PX = 25;

/**
 * True iff the user is currently scrolled to the bottom (within tolerance)
 * of a chat-messages-style container. Used by every render function to
 * decide whether a new message should auto-scroll. Capture the value
 * BEFORE mutating the DOM so the next-tick scroll reflects the user's
 * pre-message intent, not the new content's geometry.
 */
function isContainerAtBottom(container: HTMLElement): boolean {
  return (
    container.scrollHeight - container.scrollTop - container.clientHeight <
    STICKY_BOTTOM_TOLERANCE_PX
  );
}

export { isContainerAtBottom };

const CROWN_SVG =
  '<svg class="chat-crown" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5 16 3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm1 2h12v2H6z"/></svg>';

// ─── Label Helper ────────────────────────────────────────────────

export function formatChatDisplayName(label: string): string {
  const l = label && label.trim() ? label.trim() : PEER_NAME_PREFIX;
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
const _ytTestRegex =
  /(https?:\/\/)?(www\.)?(youtube\.com\/playlist\?list=|youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[a-zA-Z0-9_-]+[^\s]*/i;
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

      setManagedTimer(
        `yt-chat-title-${uniqueId}`,
        () => updateYouTubeChatTitle(uniqueId, cleanUrl),
        100,
      );
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

function renderParsedChatContent(target: HTMLElement, text: string): void {
  // Keep chat HTML insertion constrained to parseMessageContent's escaped output.
  target.innerHTML = parseMessageContent(text);
  applyUserTextFontFallback(target, text);
}

/**
 * Keep the original wire text beside a user-authored bubble. Reading the
 * rendered text back is lossy because an oEmbed title can replace a YouTube
 * URL after render. The delegated copy gesture therefore consumes this inert
 * dataset value and never includes the sender, timestamp, or accessibility
 * hint.
 */
function makeUserChatBubbleCopyable(bubble: HTMLElement, text: string): void {
  bubble.dataset.chatCopyText = text;
  bubble.tabIndex = 0;
  bubble.setAttribute('role', 'group');
  bubble.setAttribute('aria-describedby', 'chat-copy-hint');
}

async function updateYouTubeChatTitle(elementId: string, url: string): Promise<void> {
  try {
    const title = await fetchOEmbedTitle(url);
    if (title) {
      const el = document.getElementById(elementId);
      if (el) {
        el.textContent = title;
        applyUserTextFontFallback(el, title);
      }
    }
  } catch {
    /* ignore */
  }
}

// ─── DOM Helpers ─────────────────────────────────────────────────

function pruneOldMessages(container: HTMLElement): void {
  let overflow = container.querySelectorAll('.chat-row').length - MAX_CHAT_MESSAGES;
  if (overflow <= 0) return;

  for (const group of container.querySelectorAll<HTMLElement>('.chat-group')) {
    for (const row of group.querySelectorAll<HTMLElement>(':scope > .chat-row')) {
      if (overflow <= 0) return;
      row.remove();
      overflow -= 1;
    }
    // A sender label without any message is not useful and would also keep
    // accumulating as the row cap advances through old groups.
    if (!group.querySelector(':scope > .chat-row')) group.remove();
  }
}

// ─── Render: Regular Chat Message ────────────────────────────────

export function addChatMessage(
  sender: string,
  text: string,
  isMine: boolean,
  badge?: 'host' | 'op',
  joinOrder?: number,
  senderKey?: string,
): void {
  const container = document.getElementById('chat-messages');

  if (container) {
    const isAtBottom = isContainerAtBottom(container);
    const empty = container.querySelector('.chat-empty');
    if (empty) empty.remove();

    // Desktop: hide chat title when messages exist
    const drawer = document.getElementById('chat-drawer');
    if (drawer) drawer.classList.add('has-messages');

    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    // A display label is presentation, never identity. Account-aware rooms
    // pass a stable room-member key so several devices owned by one person
    // share a bubble group, while two people choosing the same nickname stay
    // separate. Legacy callers retain their existing sender-label grouping.
    const groupingKey = senderKey?.trim() || sender;

    // Check if we can append to the previous group (same member + same minute)
    const lastGroup = container.lastElementChild as HTMLElement | null;
    const lastSenderId = lastGroup?.dataset.senderId;
    const lastTimeStr = lastGroup?.dataset.timeStr;
    const canGroup =
      lastGroup &&
      !lastGroup.classList.contains('system') &&
      lastSenderId === groupingKey &&
      lastTimeStr === timeStr &&
      ((isMine && lastGroup.classList.contains('mine')) ||
        (!isMine && lastGroup.classList.contains('others')));

    if (canGroup && lastGroup) {
      const prevRows = lastGroup.querySelectorAll('.chat-row');
      const prevLastRow = prevRows[prevRows.length - 1];
      if (prevLastRow) {
        const prevTime = prevLastRow.querySelector('.chat-time');
        if (prevTime) prevTime.remove();
      }

      const row = document.createElement('div');
      // The first message animates with its newly-created group. Continuation
      // messages reuse that group, so mark the new row as the animation owner.
      // Without this class only the first bubble from a sender ever animates.
      row.className = 'chat-row chat-enter';

      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${isMine ? 'mine' : 'others'}`;
      const chatTextDiv = document.createElement('div');
      chatTextDiv.className = 'chat-text';
      renderParsedChatContent(chatTextDiv, text);
      bubble.appendChild(chatTextDiv);
      makeUserChatBubbleCopyable(bubble, text);
      try {
        if (bubble.querySelector('.chat-youtube-btn')) bubble.classList.add('has-youtube');
      } catch {
        /* ignore */
      }

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

      lastGroup.appendChild(row);
      lastGroup.dataset.timeStr = timeStr;
    } else {
      const group = document.createElement('div');
      group.className = `chat-group chat-enter ${isMine ? 'mine' : 'others'}`;
      group.dataset.senderId = groupingKey;
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
      applyUserTextFontFallback(senderNode, sender);
      group.appendChild(senderNode);

      const row = document.createElement('div');
      row.className = 'chat-row';

      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${isMine ? 'mine' : 'others'}`;
      const chatTextDiv = document.createElement('div');
      chatTextDiv.className = 'chat-text';
      renderParsedChatContent(chatTextDiv, text);
      bubble.appendChild(chatTextDiv);
      makeUserChatBubbleCopyable(bubble, text);
      try {
        if (bubble.querySelector('.chat-youtube-btn')) bubble.classList.add('has-youtube');
      } catch {
        /* ignore */
      }

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
    if (isAtBottom || isMine) container.scrollTop = container.scrollHeight;
  }

  bus.emit('chat:message-rendered', sender, text, isMine);
}

// ─── Render: System Message ──────────────────────────────────────
// System messages bypass `chat:message-rendered` on purpose: they're local
// notices (command output, errors) that shouldn't touch preview/unread.

export function addSystemChatMessage(text: string): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const isAtBottom = isContainerAtBottom(container);
  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();

  const drawer = document.getElementById('chat-drawer');
  if (drawer) drawer.classList.add('has-messages');

  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  const group = document.createElement('div');
  group.className = 'chat-group chat-enter others system';

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
  applyUserTextFontFallback(chatTextDiv, text);
  bubble.appendChild(chatTextDiv);

  const timeNode = document.createElement('div');
  timeNode.className = 'chat-time';
  timeNode.innerText = timeStr;

  row.appendChild(bubble);
  row.appendChild(timeNode);
  group.appendChild(row);
  container.appendChild(group);
  pruneOldMessages(container);
  if (isAtBottom) container.scrollTop = container.scrollHeight;
}

// ─── Render: BOT Message ─────────────────────────────────────────

type BotChatMessageState = 'typing' | 'complete';

function findBotChatGroup(container: HTMLElement, requestId: string): HTMLElement | null {
  for (const candidate of container.querySelectorAll<HTMLElement>('.chat-group.bot')) {
    if (candidate.dataset.botRequestId === requestId) return candidate;
  }
  return null;
}

function renderBotTypingIndicator(target: HTMLElement): void {
  const indicator = document.createElement('span');
  indicator.className = 'chat-bot-typing';
  indicator.setAttribute('aria-hidden', 'true');

  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement('span');
    dot.className = 'chat-bot-typing-dot';
    indicator.appendChild(dot);
  }

  target.replaceChildren(indicator);
}

function createBotChatGroup(requestId: string): HTMLElement {
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  const group = document.createElement('div');
  group.className = 'chat-group chat-enter others bot';
  group.dataset.botRequestId = requestId;
  group.dataset.botState = 'typing';

  const senderNode = document.createElement('div');
  senderNode.className = 'chat-sender';
  senderNode.textContent = 'BOT';
  group.appendChild(senderNode);

  const row = document.createElement('div');
  row.className = 'chat-row';

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble others bot is-typing';
  bubble.setAttribute('role', 'status');
  bubble.setAttribute('aria-live', 'polite');
  bubble.setAttribute('aria-atomic', 'true');
  bubble.setAttribute('aria-busy', 'true');
  bubble.setAttribute('aria-label', t('chat.bot_processing'));

  const chatTextDiv = document.createElement('div');
  chatTextDiv.className = 'chat-text';
  renderBotTypingIndicator(chatTextDiv);
  bubble.appendChild(chatTextDiv);

  const timeNode = document.createElement('div');
  timeNode.className = 'chat-time';
  timeNode.innerText = timeStr;

  row.appendChild(bubble);
  row.appendChild(timeNode);
  group.appendChild(row);
  return group;
}

/**
 * Create or update the single BOT bubble owned by a request.
 *
 * Typing calls are idempotent. The first terminal call replaces the typing
 * indicator in the existing bubble and emits one render event; later terminal
 * replays are ignored so retries cannot duplicate preview/unread updates.
 */
export function upsertBotChatMessage(
  requestId: string,
  state: BotChatMessageState,
  text = '',
): void {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId) return;

  const container = document.getElementById('chat-messages');
  if (!container) return;
  const isAtBottom = isContainerAtBottom(container);

  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();

  const drawer = document.getElementById('chat-drawer');
  if (drawer) drawer.classList.add('has-messages');

  let group = findBotChatGroup(container, normalizedRequestId);
  if (!group) {
    group = createBotChatGroup(normalizedRequestId);
    container.appendChild(group);
  }

  if (state === 'complete' && group.dataset.botState !== 'complete') {
    const bubble = group.querySelector<HTMLElement>('.chat-bubble.bot');
    const chatText = bubble?.querySelector<HTMLElement>('.chat-text');
    if (bubble && chatText) {
      // Keep model-authored content inert: BOT replies never create embedded
      // controls or timestamp actions from their text.
      chatText.textContent = text;
      applyUserTextFontFallback(chatText, text);
      bubble.classList.remove('is-typing');
      bubble.classList.add('is-complete');
      bubble.setAttribute('aria-busy', 'false');
      bubble.removeAttribute('aria-label');
      group.dataset.botState = 'complete';
      bus.emit('chat:message-rendered', 'BOT', text, false);
    }
  }

  pruneOldMessages(container);
  if (isAtBottom) container.scrollTop = container.scrollHeight;
}

// ─── Render: Whisper Message ─────────────────────────────────────

export function addWhisperMessage(peerLabel: string, text: string, isSent: boolean): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const isAtBottom = isContainerAtBottom(container);
  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();

  const drawer = document.getElementById('chat-drawer');
  if (drawer) drawer.classList.add('has-messages');

  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  const group = document.createElement('div');
  group.className = `chat-group chat-enter ${isSent ? 'mine' : 'others'} whisper`;

  const senderNode = document.createElement('div');
  senderNode.className = 'chat-sender whisper-label';
  senderNode.textContent = isSent
    ? t('chat.cmd_whisper_to', { name: peerLabel })
    : t('chat.cmd_whisper_from', { name: peerLabel });
  applyUserTextFontFallback(senderNode, senderNode.textContent || peerLabel);
  group.appendChild(senderNode);

  const row = document.createElement('div');
  row.className = 'chat-row';

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${isSent ? 'mine' : 'others'} whisper`;
  const chatTextDiv = document.createElement('div');
  chatTextDiv.className = 'chat-text';
  renderParsedChatContent(chatTextDiv, text);
  bubble.appendChild(chatTextDiv);
  makeUserChatBubbleCopyable(bubble, text);

  const timeNode = document.createElement('div');
  timeNode.className = 'chat-time';
  timeNode.innerText = timeStr;

  if (isSent) {
    row.appendChild(timeNode);
    row.appendChild(bubble);
  } else {
    row.appendChild(bubble);
    row.appendChild(timeNode);
  }

  group.appendChild(row);
  container.appendChild(group);
  pruneOldMessages(container);
  if (isAtBottom || isSent) container.scrollTop = container.scrollHeight;

  // isMine=isSent so chat.ts's handler skips incrementUnread for outgoing
  // whispers but still updates preview for both directions.
  bus.emit('chat:message-rendered', peerLabel, text, isSent);
}

// ─── Render: Notice Message ──────────────────────────────────────

function formatNoticeTime(timestamp: number | undefined): string {
  const date = new Date(typeof timestamp === 'number' ? timestamp : Date.now());
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getHours().toString().padStart(2, '0')}:${date
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

export function addNoticeChatMessage(sender: string, text: string, timestamp?: number): void {
  setPinnedNotice(sender, text, timestamp);

  // Notices live only in the pinned banner. Keep preview/unread behavior
  // so users still notice a room-wide announcement while the drawer is closed.
  bus.emit('chat:message-rendered', sender || t('chat.cmd_notice_prefix'), text, false);
}

// ─── Pinned Notice Banner ────────────────────────────────────────

function playPinnedNoticeAttentionHint(banner: HTMLElement): void {
  banner.classList.remove('notice-attention-hint');
  // Force a reflow so a fast follow-up notice restarts the attention animation.
  void banner.offsetWidth;
  banner.classList.add('notice-attention-hint');
  banner.addEventListener(
    'animationend',
    () => {
      banner.classList.remove('notice-attention-hint');
    },
    { once: true },
  );
}

function setPinnedNotice(sender: string, text: string, timestamp?: number): void {
  const banner = document.getElementById('chat-pinned-notice');
  const label = document.getElementById('chat-pinned-notice-label');
  const time = document.getElementById('chat-pinned-notice-time');
  const body = document.getElementById('chat-pinned-notice-text');
  if (!banner || !label || !body) return;
  // Keep an empty-sender fallback for older system-originated pinned notices.
  // New automatic application events use gray CHAT_SYSTEM rows instead.
  const displayName = sender || t('chat.system_sender');
  label.textContent = `${t('chat.cmd_notice_prefix')} · ${displayName}`;
  applyUserTextFontFallback(label, label.textContent || displayName);
  if (time) time.textContent = formatNoticeTime(timestamp);
  body.textContent = text;
  applyUserTextFontFallback(body, text);
  banner.hidden = false;
  playPinnedNoticeAttentionHint(banner);
  // Hide the chat title once a notice is pinned — same rule as first message.
  const drawer = document.getElementById('chat-drawer');
  if (drawer) drawer.classList.add('has-messages');
}

export function clearPinnedNotice(): void {
  const banner = document.getElementById('chat-pinned-notice');
  if (banner) {
    banner.hidden = true;
    banner.classList.remove('notice-attention-hint');
  }
}

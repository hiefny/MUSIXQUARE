/**
 * MUSIXQUARE — Chat Protocol Handlers
 *
 * Handles incoming chat protocol messages: regular chat, admin commands
 * (mute/unmute, freeze/unfreeze, clear, slowmode, filter), whisper, notice, system.
 * Isolated from ui/chat.ts to separate network concerns from rendering.
 */

import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import {
  MSG,
  PEER_NAME_PREFIX,
  MAX_MSG_LENGTH,
  MAX_SENDER_LABEL_LENGTH,
} from '../core/constants.ts';
import { registerHandlers } from '../network/protocol.ts';
import { broadcast, safeSend } from '../network/peer-state.ts';
import { t } from '../i18n/index.ts';
import type { I18nKey } from '../i18n/index.ts';
import { filterProfanity } from './profanity.ts';
import {
  addChatMessage,
  addSystemChatMessage,
  addWhisperMessage,
  addNoticeChatMessage,
  formatChatDisplayName,
} from '../ui/chat-render.ts';
import type { DataConnection } from '../types/index.ts';

type PinnedNoticePayload = {
  type: typeof MSG.CHAT_NOTICE;
  senderLabel: string;
  text: string;
  ts: number;
  i18nKey?: string;
  i18nParams?: Record<string, string | number>;
};

let _latestPinnedNotice: PinnedNoticePayload | null = null;

function isNoticeParams(value: unknown): value is Record<string, string | number> {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).every((v) => typeof v === 'string' || typeof v === 'number');
}

function normalizePinnedNoticePayload(data: Record<string, unknown>): PinnedNoticePayload | null {
  let senderLabel = (data.senderLabel as string) || '';
  if (senderLabel.length > MAX_SENDER_LABEL_LENGTH)
    senderLabel = senderLabel.substring(0, MAX_SENDER_LABEL_LENGTH);
  let text = (data.text as string) || '';
  if (text.length > MAX_MSG_LENGTH) text = text.substring(0, MAX_MSG_LENGTH);
  if (!text) return null;

  const notice: PinnedNoticePayload = {
    type: MSG.CHAT_NOTICE,
    senderLabel,
    text,
    ts: typeof data.ts === 'number' ? data.ts : Date.now(),
  };

  if (typeof data.i18nKey === 'string' && data.i18nKey.length < 128) {
    notice.i18nKey = data.i18nKey;
  }
  if (isNoticeParams(data.i18nParams)) {
    notice.i18nParams = data.i18nParams;
  }

  return notice;
}

export function rememberPinnedNotice(data: Record<string, unknown>): void {
  _latestPinnedNotice = normalizePinnedNoticePayload(data);
}

export function clearLatestPinnedNotice(): void {
  _latestPinnedNotice = null;
}

export function sendLatestPinnedNotice(conn: DataConnection | null | undefined): boolean {
  if (!_latestPinnedNotice) return false;
  safeSend(conn, { ..._latestPinnedNotice });
  return true;
}

// ─── Dedup ───────────────────────────────────────────────────────

const _recentMsgIds = new Set<string>();

// ─── Server-side Rate Limit (host only) ─────────────────────────
//
// Client-side slowmode (ui/chat.ts) is enforceable only by well-behaved
// guests. A malicious peer can bypass sendChatMessage() and push raw CHAT
// frames over the DataConnection. Without a host-side cap, one peer can
// flood every other guest through host fanout.
//
// Token-bucket per peer: BURST messages instant, then one every REFILL_MS.
// This runs on the host before fanout, so a floodbot costs at most BURST
// messages of host CPU and downstream bandwidth.

const CHAT_RATE_BURST = 10;
const CHAT_RATE_REFILL_MS = 1000; // ~1 msg/sec sustained after burst
const _rateBuckets = new Map<string, { tokens: number; lastRefill: number }>();

function allowChatFromPeer(peerId: string): boolean {
  if (!peerId) return true; // can't rate-limit without an id; fail open
  const now = Date.now();
  let bucket = _rateBuckets.get(peerId);
  if (!bucket) {
    bucket = { tokens: CHAT_RATE_BURST, lastRefill: now };
    _rateBuckets.set(peerId, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  if (elapsed > 0) {
    const refill = Math.floor(elapsed / CHAT_RATE_REFILL_MS);
    if (refill > 0) {
      bucket.tokens = Math.min(CHAT_RATE_BURST, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * Drop any rate-limit state for a peer (call on peer disconnect so the
 * bucket map doesn't grow unbounded across long-lived sessions).
 */
export function resetChatRateLimit(peerId: string): void {
  _rateBuckets.delete(peerId);
}

// ─── Host Guard ──────────────────────────────────────────────────

/**
 * Guest-side guard: admin chat commands (freeze/unfreeze/clear/slowmode/filter/system)
 * must only be processed when they arrive from the host connection.
 */
function isFromHost(conn?: DataConnection): boolean {
  const hostConn = getState('network.hostConn');
  if (!hostConn) return true; // We ARE the host — always accept
  return conn === hostConn;
}

// ─── Incoming Chat Message ───────────────────────────────────────

function handleChatMessage(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');

  // Drop CHAT frames not arriving via hostConn. Guests only trust chat
  // broadcasts from the authenticated host connection, matching the admin
  // and system-message handlers below.
  // Placed before dedup so a malicious peer cannot poison _recentMsgIds with
  // a victim's predicted (senderId, ts) pair to drop their legitimate message.
  if (hostConn && !isFromHost(conn)) return;

  // Dedup: drop duplicate messages (same sender + timestamp).
  // On host, derive sender from authenticated peer ID — data.senderId is
  // attacker-controllable on raw frames (host's hostConn is null so the guard
  // above doesn't apply on host), so a malicious guest could pre-poison the
  // dedup set with someone else's predicted (senderId, ts) pair to drop their
  // legitimate message. On guest, host has already sanitized data.senderId
  // before broadcasting, so trusting it keeps dedup keys stable.
  const dedupSender = !hostConn ? conn?.peer || '' : (data.senderId as string) || '';
  const msgKey = `${dedupSender}:${data.ts}`;
  if (_recentMsgIds.has(msgKey)) return;
  _recentMsgIds.add(msgKey);
  // Keep set bounded (last 50 messages)
  if (_recentMsgIds.size > 50) {
    const first = _recentMsgIds.values().next().value;
    if (first) _recentMsgIds.delete(first);
  }

  const myId = getState('network.myId') || '';
  const senderId = (data.senderId as string) || '';
  const isMine = senderId === myId;

  // Already displayed locally in sendChatMessage() — drop echo-back
  if (isMine) return;

  // ── Host-side enforcement: rate limit, mute, freeze ──
  if (!hostConn && !isMine) {
    const senderPeerId = conn?.peer || '';
    // Rate limit: silently drop frames over the burst+refill threshold.
    if (!allowChatFromPeer(senderPeerId)) return;
    // Muted user — silently drop
    if (getState('network.mutedPeers').has(senderPeerId)) return;
    // Frozen chat — verify OP status from host's own peer list (don't trust client data)
    if (getState('network.chatFrozen')) {
      const peers = getState('network.connectedPeers');
      const peerEntry = peers.find((p: { id: string }) => p.id === senderPeerId);
      const actualIsOp = peerEntry?.isOp ?? false;
      if (!actualIsOp) return;
    }
  }

  let senderLabel = (data.senderLabel as string) || (data.sender as string) || PEER_NAME_PREFIX;
  if (senderLabel.length > MAX_SENDER_LABEL_LENGTH)
    senderLabel = senderLabel.substring(0, MAX_SENDER_LABEL_LENGTH);
  const displayName = formatChatDisplayName(senderLabel);
  let text = (data.text as string) || '';
  if (text.length > MAX_MSG_LENGTH) text = text.substring(0, MAX_MSG_LENGTH);

  // ── Host-side profanity filter ──
  if (!hostConn && getState('network.filterEnabled')) {
    text = filterProfanity(text);
  }
  // Write the truncated (and possibly filtered) text back BEFORE the fan-out:
  // the broadcast below sends `data` by reference, and without this an
  // oversized payload would relay at full size to N-1 guests even though
  // every renderer caps at MAX_MSG_LENGTH (wire amplification; the whisper
  // handler already writes back — this mirrors it).
  if (!hostConn) {
    data.text = text;
  }

  // ── Badge derivation: Host-side uses authoritative peer list, guest trusts host ──
  // A malicious guest could send { isHost: true } or { isOp: true } to spoof badges.
  // On the host, we derive the badge from our own connectedPeers list (source of truth)
  // and overwrite data.isHost/isOp BEFORE broadcasting, so guests receive the
  // correct badge regardless of what the original sender claimed.
  let badge: 'host' | 'op' | undefined;
  if (!hostConn) {
    // Host: derive from authoritative peer list
    const senderPeerId = conn?.peer || '';
    const peers = getState('network.connectedPeers');
    const peerEntry = peers.find((p: { id: string }) => p.id === senderPeerId);
    const isOp = peerEntry?.isOp ?? false;
    badge = isOp ? 'op' : undefined; // only host gets 'host' badge (set below)
    // Overwrite untrusted identity + badge fields before broadcast. Without
    // overwriting senderId/senderLabel/joinOrder, a malicious peer that pushed
    // a raw CHAT frame with someone else's senderId would have the spoofed
    // identity reach every downstream guest verbatim — mirrors WHISPER L243-245.
    data.isHost = false;
    data.isOp = isOp;
    data.senderId = senderPeerId;
    if (peerEntry) {
      data.senderLabel = peerEntry.label.substring(0, MAX_SENDER_LABEL_LENGTH);
      data.joinOrder = peerEntry.joinOrder;
    }
  } else {
    // Guest: trust broadcast data (host already sanitized it)
    badge = data.isHost ? 'host' : data.isOp ? 'op' : undefined;
  }

  const joinOrder = typeof data.joinOrder === 'number' ? data.joinOrder : undefined;
  addChatMessage(displayName, text, isMine, badge, joinOrder);

  // Broadcast to other peers (Host only), excluding the sender to avoid duplicates.
  if (!hostConn) {
    const senderPeerId = conn?.peer || '';
    bus.emit('network:broadcast-except', senderPeerId, data);
  }
}

// ─── Admin Handlers ──────────────────────────────────────────────

function handleChatMute(data: Record<string, unknown>, conn?: DataConnection): void {
  // Host should never receive a raw chat-mute — legitimate path is the
  // host's own REQUEST_CHAT_COMMAND 'mute' branch in sync.ts:222 which
  // calls setState + broadcast directly. A raw frame at host with
  // targetId === hostId triggers a fake muted-state UI flip + spams
  // addSystemChatMessage. isFromHost on host returns true (no hostConn),
  // so the guest-side guard alone doesn't cover us.
  if (!getState('network.hostConn')) return;
  if (!isFromHost(conn)) return;
  const targetId = data.targetId as string;
  const targetLabel = data.targetLabel as string;
  const myId = getState('network.myId') || '';

  if (targetId === myId) {
    bus.emit('chat:muted-state-changed', true);
  }
  addSystemChatMessage(t('chat.cmd_muted', { name: targetLabel }));
}

function handleChatUnmute(data: Record<string, unknown>, conn?: DataConnection): void {
  // Same threat model as handleChatMute — host-side guard required.
  if (!getState('network.hostConn')) return;
  if (!isFromHost(conn)) return;
  const targetId = data.targetId as string;
  const targetLabel = data.targetLabel as string;
  const myId = getState('network.myId') || '';

  if (targetId === myId) {
    bus.emit('chat:muted-state-changed', false);
  }
  addSystemChatMessage(t('chat.cmd_unmuted', { name: targetLabel }));
}

function handleChatFreeze(_data: Record<string, unknown>, conn?: DataConnection): void {
  // Host should never receive a raw chat-freeze — legitimate path is
  // host's own cmdFreeze() which calls setState directly. A raw frame at
  // host means a malicious guest sent it over their own DataConnection
  // to flip network.chatFrozen=true, which then silently drops every
  // non-OP guest's message in handleChatMessage L128-133 — disabling
  // chat for the whole session. isFromHost(conn) returns true on host
  // (L83 `!hostConn`), so the guest-side guard alone doesn't cover us.
  if (!getState('network.hostConn')) return;
  if (!isFromHost(conn)) return;
  (setState as (p: string, v: boolean) => void)('network.chatFrozen', true);
  addSystemChatMessage(t('chat.cmd_frozen'));
}

function handleChatUnfreeze(_data: Record<string, unknown>, conn?: DataConnection): void {
  // Same threat model as handleChatFreeze — host-side guard required.
  if (!getState('network.hostConn')) return;
  if (!isFromHost(conn)) return;
  (setState as (p: string, v: boolean) => void)('network.chatFrozen', false);
  addSystemChatMessage(t('chat.cmd_unfrozen'));
}

function handleChatClear(_data: Record<string, unknown>, conn?: DataConnection): void {
  // Host should never receive a raw chat-clear — legitimate path is the
  // host's own REQUEST_CHAT_COMMAND 'clear' branch in sync.ts:247 which
  // calls bus.emit('chat:clear-all') directly. A single raw frame at
  // host wipes the host's entire chat UI. isFromHost on host returns
  // true (no hostConn), so the guest-side guard alone doesn't cover us.
  if (!getState('network.hostConn')) return;
  if (!isFromHost(conn)) return;
  bus.emit('chat:clear-all');
}

function handleChatWhisper(data: Record<string, unknown>, conn?: DataConnection): void {
  const myId = getState('network.myId') || '';
  const hostConn = getState('network.hostConn');
  const targetId = (data.targetId as string) || '';
  const senderId = (data.senderId as string) || '';

  // Length caps on every inbound whisper — MSG.CHAT truncates via the
  // `handleChatMessage` path, but whisper went straight to `targetConn.send`
  // with no limit, letting a peer ship a 10MB text to any target's renderer
  // (parseMessageContent → escapeHtml → innerHTML on a multi-MB string).
  let labelIn = (data.senderLabel as string) || '';
  if (labelIn.length > MAX_SENDER_LABEL_LENGTH)
    labelIn = labelIn.substring(0, MAX_SENDER_LABEL_LENGTH);
  let textIn = (data.text as string) || '';
  if (textIn.length > MAX_MSG_LENGTH) textIn = textIn.substring(0, MAX_MSG_LENGTH);
  data.senderLabel = labelIn;
  data.text = textIn;

  if (!hostConn) {
    // Host side — enforce rate-limit + authoritative label derivation.
    const senderPeerId = conn?.peer || '';
    if (!allowChatFromPeer(senderPeerId)) return;
    if (getState('network.mutedPeers').has(senderPeerId)) return;

    // Authoritative label/id from peer list — a malicious guest could set
    // `senderLabel: 'HOST'` + `senderId: '<hostId>'` and the host would
    // have forwarded those raw to the target without this re-derivation.
    const peers = getState('network.connectedPeers');
    const peerEntry = peers.find((p: { id: string }) => p.id === senderPeerId);
    if (!peerEntry) return;
    data.senderId = senderPeerId;
    data.senderLabel = peerEntry.label.substring(0, MAX_SENDER_LABEL_LENGTH);
    data.joinOrder = peerEntry.joinOrder;

    if (targetId === myId) {
      addWhisperMessage(data.senderLabel as string, data.text as string, false);
    } else {
      const connMap = getState('network.activeHostConnByPeerId');
      const targetConn = connMap.get(targetId);
      if (targetConn) targetConn.send(data);
    }
    return;
  }

  // Guest side — only trust whispers that arrived via the host connection,
  // defending against future mesh/guest-to-guest topologies where a peer
  // could otherwise spoof a HOST whisper directly.
  if (!isFromHost(conn)) return;

  if (senderId !== myId) {
    addWhisperMessage(data.senderLabel as string, data.text as string, false);
  }
}

function handleChatNotice(data: Record<string, unknown>, conn?: DataConnection): void {
  const hostConn = getState('network.hostConn');

  // Host should never receive a raw CHAT_NOTICE — the legitimate notice
  // path is REQUEST_CHAT_COMMAND → sync.ts:handleRequestChatCommand →
  // broadcast. A raw CHAT_NOTICE arriving at the host is a spoofing attempt.
  if (!hostConn) return;

  // Guest side — trust only notices broadcast by the host.
  if (!isFromHost(conn)) return;

  let senderLabel = (data.senderLabel as string) || '';
  if (senderLabel.length > MAX_SENDER_LABEL_LENGTH)
    senderLabel = senderLabel.substring(0, MAX_SENDER_LABEL_LENGTH);
  let text = (data.text as string) || '';
  if (text.length > MAX_MSG_LENGTH) text = text.substring(0, MAX_MSG_LENGTH);

  // If the host attached an i18n key, render it in this device's locale so
  // ko/en users each see their own language. Falls back to `text` if t() returns
  // the key unchanged (key missing in this client's dictionary — older client
  // or typo). The cast is because the network payload is a runtime string but
  // t() expects the I18nKey string-literal union; the dict lookup itself
  // safely returns the key as the rendered string when not found.
  const i18nKey = data.i18nKey as string | undefined;
  if (i18nKey) {
    const i18nParams = data.i18nParams as Record<string, string | number> | undefined;
    const localized = t(i18nKey as I18nKey, i18nParams);
    if (localized !== i18nKey) text = localized;
  }

  const timestamp = typeof data.ts === 'number' ? data.ts : Date.now();
  addNoticeChatMessage(senderLabel, text, timestamp);
}

function handleChatSlowmode(data: Record<string, unknown>, conn?: DataConnection): void {
  // Host should never receive a raw chat-slowmode — legitimate path is
  // host's own cmdSlowmode() which calls setState directly. A raw frame
  // at host lets a malicious guest set network.slowmodeSeconds, and the
  // host's WELCOME payload (network/host.ts:234) propagates it to every
  // future joiner — locking new guests out of chat (ui/chat.ts:288). Mirrors
  // handleChatFreeze / handleChatUnfreeze / handleChatFilter; isFromHost on
  // host returns true, so the guest-side guard alone doesn't cover us.
  if (!getState('network.hostConn')) return;
  if (!isFromHost(conn)) return;
  const seconds = (data.seconds as number) || 0;
  (setState as (p: string, v: number) => void)('network.slowmodeSeconds', seconds);
  addSystemChatMessage(
    seconds > 0 ? t('chat.cmd_slowmode_on', { sec: seconds }) : t('chat.cmd_slowmode_off'),
  );
}

function handleChatFilter(data: Record<string, unknown>, conn?: DataConnection): void {
  // Host should never receive a raw chat-filter — legitimate path is
  // host's own cmdFilter() which calls setState directly. A raw frame
  // at host lets a malicious guest flip network.filterEnabled, either
  // forcing profanity censorship on every chat or silently disabling
  // it (handleChatMessage L144-147 reads this flag). isFromHost on
  // host returns true, so the guest-side guard alone doesn't cover us.
  if (!getState('network.hostConn')) return;
  if (!isFromHost(conn)) return;
  const on = !!data.on;
  (setState as (p: string, v: boolean) => void)('network.filterEnabled', on);
  addSystemChatMessage(on ? t('chat.cmd_filter_on') : t('chat.cmd_filter_off'));
}

function handleChatSystem(data: Record<string, unknown>, conn?: DataConnection): void {
  // Host should never receive a raw chat-system — host injects system
  // chat lines via local addSystemChatMessage() calls (no network round
  // trip). A raw frame at host injects arbitrary text into the host's
  // own system chat (escapeHtml blocks XSS but social-engineering text
  // passes). isFromHost on host returns true (no hostConn), so the
  // guest-side guard alone doesn't cover us.
  if (!getState('network.hostConn')) return;
  if (!isFromHost(conn)) return;
  let text = (data.text as string) || '';
  if (text.length > MAX_MSG_LENGTH) text = text.substring(0, MAX_MSG_LENGTH);

  const i18nKey = data.i18nKey as string | undefined;
  if (i18nKey) {
    const i18nParams = isNoticeParams(data.i18nParams) ? data.i18nParams : undefined;
    const localized = t(i18nKey as I18nKey, i18nParams);
    if (localized !== i18nKey) text = localized;
  }

  if (text) addSystemChatMessage(text);
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Broadcast a localized system chat-notice to every device in the room.
 *
 * Each receiver looks up `i18nKey` in its own dictionary at render time, so a
 * single host-side broadcast renders in ko on Korean clients and en on English
 * clients without the host needing to know each guest's locale. The host's own
 * chat is updated locally (broadcast() doesn't loopback) using the host's
 * locale via the `chat:notice-message` bus event — same pattern as
 * sync.ts:285-287's OP /notice command.
 *
 * `text` is sent in the host's locale as a fallback so any older client that
 * doesn't have the i18nKey yet still displays a readable message instead of
 * the raw key.
 */
export function broadcastSystemNotice(
  i18nKey: I18nKey,
  params?: Record<string, string | number>,
): void {
  const fallbackText = t(i18nKey, params);
  const ts = Date.now();
  const payload = {
    type: MSG.CHAT_NOTICE,
    senderLabel: '',
    text: fallbackText,
    ts,
    i18nKey,
    ...(params ? { i18nParams: params } : {}),
  };
  rememberPinnedNotice(payload);
  broadcast(payload);
  bus.emit('chat:notice-message', '', fallbackText, ts);
}

/**
 * Send the same localized system notice shape to one peer only.
 *
 * This does not update the room's remembered latest notice; use
 * broadcastSystemNotice() for room-wide notices that late joiners should see.
 */
export function sendSystemNotice(
  conn: DataConnection | null | undefined,
  i18nKey: I18nKey,
  params?: Record<string, string | number>,
): void {
  const fallbackText = t(i18nKey, params);
  safeSend(conn, {
    type: MSG.CHAT_NOTICE,
    senderLabel: '',
    text: fallbackText,
    ts: Date.now(),
    i18nKey,
    ...(params ? { i18nParams: params } : {}),
  });
}

export function registerChatProtocolHandlers(): void {
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
    [MSG.CHAT_FILTER]: handleChatFilter,
    [MSG.CHAT_SYSTEM]: handleChatSystem,
  });

  // Drop rate-limit buckets for peers that leave, so the map doesn't
  // accumulate entries across long-running host sessions.
  bus.on('network:peer-disconnected', (peerId: string) => {
    resetChatRateLimit(peerId);
    // Also drop the departed peer from the mute set — otherwise a left guest's
    // id lingers for the whole host session (unbounded across churn, and could
    // mis-apply if the transport ever reused the id). Immutable replace so
    // subscribers fire.
    const muted = getState('network.mutedPeers');
    if (muted.has(peerId)) {
      const next = new Set(muted);
      next.delete(peerId);
      setState('network.mutedPeers', next);
    }
  });
}

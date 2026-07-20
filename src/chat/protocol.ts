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
  BOT_RATE_LIMIT_MAX_RETRY_SECONDS,
} from '../core/constants.ts';
import { registerHandlers } from '../network/protocol.ts';
import { broadcast, safeSend } from '../network/peer-state.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { sendProRoomRealtime, type ProRealtimeRelayEnvelope } from '../pro-room/network-bridge.ts';
import { getResolvedLanguage, t } from '../i18n/index.ts';
import type { I18nKey } from '../i18n/index.ts';
import { filterProfanity } from './profanity.ts';
import {
  addChatMessage,
  addSystemChatMessage,
  addWhisperMessage,
  addNoticeChatMessage,
  formatChatDisplayName,
  upsertBotChatMessage,
} from '../ui/chat-render.ts';
import type { DataConnection, DeviceInfo } from '../types/index.ts';
import { formatBotRetryDuration } from './bot-rate-limit.ts';
import { extractBotPrompt } from './bot-syntax.ts';
import { playAnnouncementSound, playChatSystemEventSound } from '../audio/ui-sounds.ts';

type PinnedNoticePayload = {
  type: typeof MSG.CHAT_NOTICE;
  senderLabel: string;
  text: string;
  ts: number;
  i18nKey?: string;
  i18nParams?: Record<string, string | number>;
  attention?: boolean;
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
  if (data.attention === true) notice.attention = true;

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
  // Hydration is visual only: a participant joining later must not hear the
  // publish chime for an announcement that already existed.
  safeSend(conn, { ..._latestPinnedNotice, attention: false });
  return true;
}

// ─── Dedup ───────────────────────────────────────────────────────

const _recentMsgIds = new Set<string>();
const STANDARD_ROOM_MEMBER_ID_RE = /^member_[A-Za-z0-9_-]{22}$/;

export type BotChatResult =
  | { kind: 'answer'; text: string }
  | { kind: 'added'; count: number; playbackChanged: boolean }
  | { kind: 'failed' }
  | { kind: 'rate_limited'; retryAfterSeconds: number };

type BotChatRequest = {
  ownerId: string;
  roomId: string;
  state: 'pending' | 'complete';
  expiresAt: number;
};

const BOT_REQUEST_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const BOT_REQUEST_TTL_MS = 60_000;
const BOT_REQUEST_MAX_ITEMS = 100;
const _botChatRequests = new Map<string, BotChatRequest>();

function getBotRoomId(): string | null {
  const room = getRoomContext();
  return room.kind === 'pro' ? room.roomId : null;
}

function isBotCommandText(text: string): boolean {
  return extractBotPrompt(text) !== null;
}

function cleanupBotChatRequests(now = Date.now()): void {
  for (const [requestId, request] of _botChatRequests) {
    if (request.expiresAt <= now) _botChatRequests.delete(requestId);
  }
  while (_botChatRequests.size > BOT_REQUEST_MAX_ITEMS) {
    const oldest = _botChatRequests.keys().next().value as string | undefined;
    if (!oldest) break;
    _botChatRequests.delete(oldest);
  }
}

function rememberBotChatRequest(
  requestId: string,
  ownerId: string,
  roomId = getBotRoomId() ?? '',
): boolean {
  if (!roomId || getBotRoomId() !== roomId || !BOT_REQUEST_ID_RE.test(requestId) || !ownerId) {
    return false;
  }
  const now = Date.now();
  cleanupBotChatRequests(now);
  const existing = _botChatRequests.get(requestId);
  if (existing && (existing.ownerId !== ownerId || existing.roomId !== roomId)) return false;
  if (existing?.state === 'complete') return false;
  _botChatRequests.set(requestId, {
    ownerId,
    roomId,
    state: 'pending',
    expiresAt: now + BOT_REQUEST_TTL_MS,
  });
  cleanupBotChatRequests(now);
  return true;
}

function normalizeBotChatResult(result: BotChatResult): BotChatResult | null {
  switch (result.kind) {
    case 'answer': {
      const text = result.text.trim();
      return text && text.length <= MAX_MSG_LENGTH ? { kind: 'answer', text } : null;
    }
    case 'added':
      return Number.isSafeInteger(result.count) && result.count >= 1 && result.count <= 3
        ? { kind: 'added', count: result.count, playbackChanged: result.playbackChanged === true }
        : null;
    case 'failed':
      return { kind: 'failed' };
    case 'rate_limited':
      return Number.isSafeInteger(result.retryAfterSeconds) &&
        result.retryAfterSeconds >= 1 &&
        result.retryAfterSeconds <= BOT_RATE_LIMIT_MAX_RETRY_SECONDS
        ? { kind: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds }
        : null;
    default:
      return null;
  }
}

function localizeBotChatResult(result: BotChatResult): string {
  switch (result.kind) {
    case 'answer':
      return result.text;
    case 'added':
      return t(result.playbackChanged ? 'chat.bot_added_and_playing' : 'chat.bot_added_tracks', {
        count: result.count,
      });
    case 'failed':
      return t('chat.bot_failed');
    case 'rate_limited':
      return t('chat.bot_rate_limited', {
        duration: formatBotRetryDuration(result.retryAfterSeconds, getResolvedLanguage()),
      });
  }
}

function completeBotChatRequest(requestId: string, result: BotChatResult, roomId: string): boolean {
  const now = Date.now();
  cleanupBotChatRequests(now);
  const request = _botChatRequests.get(requestId);
  if (
    !request ||
    request.roomId !== roomId ||
    request.state !== 'pending' ||
    request.expiresAt <= now
  ) {
    return false;
  }
  request.state = 'complete';
  request.expiresAt = now + BOT_REQUEST_TTL_MS;
  upsertBotChatMessage(requestId, 'complete', localizeBotChatResult(result));
  return true;
}

/** Register the requester's locally rendered BOT placeholder before the API call. */
export function beginLocalBotChatRequest(
  requestId: string,
  roomId = getBotRoomId() ?? '',
): boolean {
  const myId = getState('network.myId') || '';
  if (!rememberBotChatRequest(requestId, myId, roomId)) return false;
  upsertBotChatMessage(requestId, 'typing');
  return true;
}

/** Complete the local BOT bubble and relay one terminal result through chat authority. */
export function publishBotChatResult(
  requestId: string,
  result: BotChatResult,
  roomId = getBotRoomId() ?? '',
): boolean {
  if (!roomId || getBotRoomId() !== roomId) return false;
  const normalized = normalizeBotChatResult(result);
  const myId = getState('network.myId') || '';
  const request = _botChatRequests.get(requestId);
  if (!normalized || !request || request.ownerId !== myId || request.roomId !== roomId)
    return false;
  if (!completeBotChatRequest(requestId, normalized, roomId)) return false;

  const frame = {
    type: MSG.CHAT_BOT_RESULT,
    requestId,
    senderId: myId,
    result: normalized,
  } as const;
  const hostConn = getState('network.hostConn');
  if (getRoomContext().kind === 'pro') {
    sendProRoomRealtime('chat', {
      kind: 'bot-result',
      requestId,
      result: normalized,
    });
  } else if (hostConn) safeSend(hostConn, frame);
  else broadcast(frame);
  return true;
}

/** Accept a signaling-validated, server-attributed PRO chat relay. */
export function receiveProRoomRealtimeChat(frame: ProRealtimeRelayEnvelope): void {
  if (frame.channel !== 'chat' || getRoomContext().kind !== 'pro') return;
  const payload = frame.payload;
  const kind = payload.kind;
  const senderId = frame.sender.participantId;
  const senderLabel =
    (typeof frame.sender.displayName === 'string' &&
      frame.sender.displayName.trim().slice(0, MAX_SENDER_LABEL_LENGTH)) ||
    PEER_NAME_PREFIX;
  const myId = getState('network.myId') || '';
  // The server relay authenticates the physical sender. Resolve its current
  // room-member projection separately: participantId remains the dedup/rate
  // identity while memberId controls presentation across a user's devices.
  const devices = getState('network.lastKnownDeviceList') || [];
  const participant = devices.find((candidate) => candidate.id === senderId);
  const localParticipant = devices.find((candidate) => candidate.id === myId);
  const localMemberId = getState('network.myMemberId') || localParticipant?.memberId || '';
  // Prefer the room-service-signed member identity carried by the signaling
  // relay. Presence remains a rolling-deploy fallback, but can no longer race
  // the first chat message and split one account's opening bubble by device.
  const senderMemberId = frame.sender.memberId || participant?.memberId || '';
  const senderKey = senderMemberId || senderId;
  if (senderId === myId) return;

  if (kind === 'message') {
    const text = typeof payload.text === 'string' ? payload.text.slice(0, MAX_MSG_LENGTH) : '';
    if (!text) return;
    const displayName = formatChatDisplayName(participant?.label || senderLabel);
    const isSameLocalMember = !!senderMemberId && senderMemberId === localMemberId;
    addChatMessage(
      displayName,
      getState('network.filterEnabled') ? filterProfanity(text) : text,
      isSameLocalMember,
      proRoomChatBadge(participant),
      participant?.memberDisplayNumber ?? participant?.joinOrder,
      senderKey,
    );
    const botRequestId =
      typeof payload.botRequestId === 'string' && BOT_REQUEST_ID_RE.test(payload.botRequestId)
        ? payload.botRequestId
        : '';
    if (botRequestId && isBotCommandText(text)) {
      if (rememberBotChatRequest(botRequestId, senderId)) {
        upsertBotChatMessage(botRequestId, 'typing');
      }
    }
    return;
  }

  if (kind === 'bot-result') {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const normalized = normalizeBotChatResult(payload.result as BotChatResult);
    const request = requestId ? _botChatRequests.get(requestId) : null;
    if (requestId && normalized && request?.ownerId === senderId) {
      completeBotChatRequest(requestId, normalized, getBotRoomId() ?? '');
    }
    return;
  }

  if (kind === 'system') {
    let text = typeof payload.text === 'string' ? payload.text.slice(0, MAX_MSG_LENGTH) : '';
    const i18nKey = typeof payload.i18nKey === 'string' ? payload.i18nKey : '';
    const i18nParams = isNoticeParams(payload.i18nParams) ? payload.i18nParams : undefined;
    if (i18nKey) {
      const localized = t(i18nKey as I18nKey, i18nParams);
      if (localized !== i18nKey) text = localized;
    }
    if (text) {
      addSystemChatMessage(text);
      playChatSystemEventSound(i18nKey || undefined, i18nParams);
    }
    return;
  }

  if (kind === 'notice') {
    const text = typeof payload.text === 'string' ? payload.text.slice(0, MAX_MSG_LENGTH) : '';
    if (text) addNoticeChatMessage(senderLabel, text, Date.now());
    return;
  }

  if (kind === 'whisper') {
    const targetId =
      typeof payload.targetParticipantId === 'string' ? payload.targetParticipantId : '';
    const text = typeof payload.text === 'string' ? payload.text.slice(0, MAX_MSG_LENGTH) : '';
    if (targetId === myId && text) addWhisperMessage(senderLabel, text, false);
    return;
  }

  if (kind === 'clear') {
    bus.emit('chat:clear-all');
  } else if (
    kind === 'mute' &&
    typeof payload.targetParticipantId === 'string' &&
    typeof payload.on === 'boolean'
  ) {
    const targetId = payload.targetParticipantId;
    const targetLabel =
      (getState('network.lastKnownDeviceList') || []).find((candidate) => candidate.id === targetId)
        ?.label ?? t('common.peer');
    if (targetId === myId) bus.emit('chat:muted-state-changed', payload.on);
    addSystemChatMessage(
      payload.on
        ? t('chat.cmd_muted', { name: targetLabel })
        : t('chat.cmd_unmuted', { name: targetLabel }),
    );
  } else if (kind === 'freeze' && typeof payload.on === 'boolean') {
    setState('network.chatFrozen', payload.on);
    addSystemChatMessage(payload.on ? t('chat.cmd_frozen') : t('chat.cmd_unfrozen'));
  } else if (kind === 'filter' && typeof payload.on === 'boolean') {
    setState('network.filterEnabled', payload.on);
    addSystemChatMessage(payload.on ? t('chat.cmd_filter_on') : t('chat.cmd_filter_off'));
  } else if (
    kind === 'slowmode' &&
    Number.isSafeInteger(payload.seconds) &&
    (payload.seconds as number) >= 0
  ) {
    setState('network.slowmodeSeconds', payload.seconds as number);
  }
}

function proRoomChatBadge(participant: DeviceInfo | undefined): 'host' | 'op' | undefined {
  return participant?.role === 'owner'
    ? 'host'
    : participant?.role === 'controller'
      ? 'op'
      : undefined;
}

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
function resetChatRateLimit(peerId: string): void {
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
  // On the coordinator, the connection is the identity. Never let an inbound
  // guest frame claim the coordinator's own senderId and trigger the local
  // echo shortcut before authoritative identity rewriting.
  const senderId = !hostConn ? conn?.peer || '' : (data.senderId as string) || '';
  const isPhysicalEcho = senderId === myId;

  // Already displayed locally in sendChatMessage() — drop echo-back
  if (isPhysicalEcho) return;

  // ── Host-side enforcement: rate limit, mute, freeze ──
  if (!hostConn && !isPhysicalEcho) {
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
  let senderMemberId = '';
  if (!hostConn) {
    // Host: derive from authoritative peer list
    const senderPeerId = conn?.peer || '';
    const peers = getState('network.connectedPeers');
    const peerEntry = peers.find((p: { id: string }) => p.id === senderPeerId);
    const isOp = peerEntry?.isOp ?? false;
    const isAccountOwner =
      peerEntry?.isAuthenticated === true &&
      peerEntry.roomCapabilities?.includes('room.configure') === true;
    badge = isAccountOwner ? 'host' : isOp ? 'op' : undefined;
    // Overwrite untrusted identity + badge fields before broadcast. Without
    // overwriting senderId/senderLabel/joinOrder, a malicious peer that pushed
    // a raw CHAT frame with someone else's senderId would have the spoofed
    // identity reach every downstream guest verbatim. Mirror the WHISPER handler.
    data.isHost = isAccountOwner;
    data.isOp = isOp;
    data.senderId = senderPeerId;
    if (peerEntry) {
      senderLabel = peerEntry.label.substring(0, MAX_SENDER_LABEL_LENGTH);
      data.joinOrder = peerEntry.memberDisplayNumber ?? peerEntry.joinOrder;
      senderMemberId =
        typeof peerEntry.memberId === 'string' &&
        STANDARD_ROOM_MEMBER_ID_RE.test(peerEntry.memberId)
          ? peerEntry.memberId
          : '';
      if (senderMemberId) data.senderMemberId = senderMemberId;
      else delete data.senderMemberId;
    } else {
      // An authenticated connection can race the first device-list commit,
      // but its untrusted frame still must not choose the coordinator's local
      // display name. Keep a neutral fallback until authoritative state lands.
      senderLabel = PEER_NAME_PREFIX;
      delete data.joinOrder;
      delete data.senderMemberId;
    }
    data.senderLabel = senderLabel;
  } else {
    // Guest: trust broadcast data (host already sanitized it)
    badge = data.isHost ? 'host' : data.isOp ? 'op' : undefined;
    senderMemberId =
      typeof data.senderMemberId === 'string' &&
      STANDARD_ROOM_MEMBER_ID_RE.test(data.senderMemberId)
        ? data.senderMemberId
        : '';
  }

  const displayName = formatChatDisplayName(senderLabel);
  const joinOrder = typeof data.joinOrder === 'number' ? data.joinOrder : undefined;
  const localMemberId = getState('network.myMemberId') || '';
  const isSameLocalMember = !!senderMemberId && senderMemberId === localMemberId;
  addChatMessage(
    displayName,
    text,
    isSameLocalMember,
    badge,
    joinOrder,
    senderMemberId || senderId,
  );

  // A valid BOT command remains an ordinary user chat row. Its opaque request
  // id only adds a separate, update-in-place BOT response bubble. On the host,
  // bind that id to the authenticated connection identity before fan-out;
  // guests trust the already-sanitized senderId from their host connection.
  const botRequestId = typeof data.botRequestId === 'string' ? data.botRequestId : '';
  const botOwnerId = !hostConn ? conn?.peer || '' : (data.senderId as string) || '';
  const isValidBotRequest =
    !!botRequestId && isBotCommandText(text) && rememberBotChatRequest(botRequestId, botOwnerId);
  if (isValidBotRequest) {
    upsertBotChatMessage(botRequestId, 'typing');
  } else if (!hostConn && Object.prototype.hasOwnProperty.call(data, 'botRequestId')) {
    // Do not propagate BOT metadata outside a PRO room, on non-BOT text,
    // or when an id is already owned by another participant.
    delete data.botRequestId;
  }

  // Broadcast a canonical payload to other peers (Host only), excluding the
  // sender to avoid duplicates. Never fan out the inbound object itself: the
  // CHAT validator intentionally validates the known fields, so an attacker
  // could otherwise attach a large unknown property and multiply it across
  // every downstream connection even though the rendered text is bounded.
  if (!hostConn) {
    const senderPeerId = conn?.peer || '';
    const relayPayload: Record<string, unknown> = {
      type: MSG.CHAT,
      senderId: senderPeerId,
      ...(senderMemberId ? { senderMemberId } : {}),
      sender: senderLabel,
      senderLabel,
      isHost: badge === 'host',
      isOp: badge === 'op',
      text,
      ts: typeof data.ts === 'number' && Number.isFinite(data.ts) ? data.ts : Date.now(),
    };
    if (typeof joinOrder === 'number') relayPayload.joinOrder = joinOrder;
    if (isValidBotRequest) relayPayload.botRequestId = botRequestId;
    bus.emit('network:broadcast-except', senderPeerId, relayPayload);
  }
}

function handleChatBotResult(data: Record<string, unknown>, conn: DataConnection): void {
  const roomId = getBotRoomId();
  if (!roomId) return;
  const normalized = normalizeBotChatResult(data.result as BotChatResult);
  if (!normalized) return;

  const hostConn = getState('network.hostConn');
  const requestId = data.requestId as string;
  const claimedOwnerId = data.senderId as string;
  cleanupBotChatRequests();
  const request = _botChatRequests.get(requestId);
  if (
    !request ||
    request.roomId !== roomId ||
    request.state !== 'pending' ||
    request.ownerId !== claimedOwnerId
  ) {
    return;
  }

  if (!hostConn) {
    // Coordinator: only the same authenticated peer that introduced the
    // ordinary /bot CHAT row may complete it. A terminal frame is accepted
    // once, then fanned out without echoing to the requester (already updated
    // locally when its API call completed).
    const senderPeerId = conn?.peer || '';
    if (!senderPeerId || senderPeerId !== claimedOwnerId) return;
    if (!completeBotChatRequest(requestId, normalized, roomId)) return;
    data.senderId = senderPeerId;
    data.result = normalized;
    bus.emit('network:broadcast-except', senderPeerId, data);
    return;
  }

  // Member: terminal BOT results are authority frames and therefore only
  // arrive from the current coordinator connection. The earlier CHAT mapping
  // still binds them to the original requester across coordinator handoff.
  if (!isFromHost(conn)) return;
  completeBotChatRequest(requestId, normalized, roomId);
}

// ─── Admin Handlers ──────────────────────────────────────────────

function handleChatMute(data: Record<string, unknown>, conn?: DataConnection): void {
  // Host should never receive a raw chat-mute — legitimate path is the
  // host's own REQUEST_CHAT_COMMAND 'mute' branch in network/sync.ts, which
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
  // non-OP guest's message in handleChatMessage, disabling chat for the whole
  // session. isFromHost(conn) returns true on a host with no hostConn, so the
  // guest-side guard alone doesn't cover us.
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
  // host's own REQUEST_CHAT_COMMAND 'clear' branch in network/sync.ts, which
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
    const senderLabel = peerEntry.label.substring(0, MAX_SENDER_LABEL_LENGTH);
    const relayPayload = {
      type: MSG.CHAT_WHISPER,
      senderId: senderPeerId,
      senderLabel,
      targetId,
      text: textIn,
      ts: typeof data.ts === 'number' && Number.isFinite(data.ts) ? data.ts : Date.now(),
      joinOrder: peerEntry.joinOrder,
    };

    if (targetId === myId) {
      addWhisperMessage(senderLabel, textIn, false);
    } else {
      const connMap = getState('network.activeHostConnByPeerId');
      const targetConn = connMap.get(targetId);
      // Relay only the protocol's known fields. The validator intentionally
      // permits rolling-compatible input shapes, so forwarding the inbound
      // object itself would let an authenticated peer attach an arbitrary
      // nested payload and amplify it through the coordinator to its target.
      if (targetConn) targetConn.send(relayPayload);
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
  if (data.attention === true) playAnnouncementSound();
}

function handleChatSlowmode(data: Record<string, unknown>, conn?: DataConnection): void {
  // Host should never receive a raw chat-slowmode — legitimate path is
  // host's own cmdSlowmode() which calls setState directly. A raw frame
  // at host lets a malicious guest set network.slowmodeSeconds, and the
  // host's WELCOME payload propagates it to every future joiner, locking new
  // guests out of chat. Mirrors
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
  // it (handleChatMessage reads this flag). isFromHost on
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
  const i18nParams = isNoticeParams(data.i18nParams) ? data.i18nParams : undefined;
  if (i18nKey) {
    const localized = t(i18nKey as I18nKey, i18nParams);
    if (localized !== i18nKey) text = localized;
  }

  if (text) {
    addSystemChatMessage(text);
    playChatSystemEventSound(i18nKey, i18nParams);
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Broadcast a localized, transient system-message row to every device.
 *
 * Automatic application events belong here. The pinned CHAT_NOTICE channel is
 * reserved for human-authored room notices and MUSIXQUARE operations notices.
 */
export function broadcastSystemMessage(
  i18nKey: I18nKey,
  params?: Record<string, string | number>,
): void {
  const fallbackText = t(i18nKey, params);
  const frame = {
    type: MSG.CHAT_SYSTEM,
    text: fallbackText,
    i18nKey,
    ...(params ? { i18nParams: params } : {}),
  } as const;
  if (getRoomContext().kind === 'pro') {
    sendProRoomRealtime('chat', {
      kind: 'system',
      text: fallbackText,
      i18nKey,
      ...(params ? { i18nParams: params } : {}),
    });
  } else {
    broadcast(frame);
  }
  announceSystemMessageLocally(i18nKey, params);
}

/** Render an already server-fanned-out automatic event on this device only. */
export function announceSystemMessageLocally(
  i18nKey: I18nKey,
  params?: Record<string, string | number>,
): void {
  const fallbackText = t(i18nKey, params);
  bus.emit('chat:system-message', fallbackText);
  playChatSystemEventSound(i18nKey, params);
}

/**
 * Send a localized, transient system-message row to one peer only.
 */
export function sendSystemMessage(
  conn: DataConnection | null | undefined,
  i18nKey: I18nKey,
  params?: Record<string, string | number>,
): void {
  const fallbackText = t(i18nKey, params);
  safeSend(conn, {
    type: MSG.CHAT_SYSTEM,
    text: fallbackText,
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
    [MSG.CHAT_BOT_RESULT]: handleChatBotResult,
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

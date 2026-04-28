/**
 * MUSIXQUARE — Chat Protocol Handlers
 *
 * Handles incoming chat protocol messages: regular chat, admin commands
 * (mute/unmute, freeze/unfreeze, clear, slowmode, filter), whisper, notice, system.
 * Isolated from ui/chat.ts to separate network concerns from rendering.
 */

import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, PEER_NAME_PREFIX } from '../core/constants.ts';
import { registerHandlers } from '../network/protocol.ts';
import { t } from '../i18n/index.ts';
import { filterProfanity } from './profanity.ts';
import {
  addChatMessage,
  addSystemChatMessage,
  addWhisperMessage,
  addNoticeChatMessage,
  formatChatDisplayName,
  MAX_MSG_LENGTH,
  MAX_SENDER_LABEL_LENGTH,
} from '../ui/chat-render.ts';
import type { DataConnection } from '../types/index.ts';

// ─── Dedup ───────────────────────────────────────────────────────

const _recentMsgIds = new Set<string>();

// ─── Server-side Rate Limit (host only) ─────────────────────────
//
// Client-side slowmode (ui/chat.ts) is enforceable only by well-behaved
// guests. A malicious peer can bypass sendChatMessage() and push raw CHAT
// frames over the DataConnection. Without a host-side cap, one peer can
// hose the relay loop and flood every other guest.
//
// Token-bucket per peer: BURST messages instant, then one every REFILL_MS.
// This runs on the host before relay, so a floodbot costs at most BURST
// messages of host CPU and 0 messages of downstream bandwidth.

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
 * must only be processed when they arrive from the host connection. Without this,
 * a compromised relay node could inject these commands and silence all guests.
 */
function isFromHost(conn?: DataConnection): boolean {
  const hostConn = getState('network.hostConn');
  if (!hostConn) return true; // We ARE the host — always accept
  return conn === hostConn;
}

// ─── Incoming Chat Message ───────────────────────────────────────

function handleChatMessage(data: Record<string, unknown>, conn: DataConnection): void {
  // Dedup: drop duplicate messages (same sender + timestamp)
  const msgKey = `${data.senderId}:${data.ts}`;
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

  const hostConn = getState('network.hostConn');

  // Drop CHAT frames not arriving via hostConn. Without this, a peer can
  // open a DATA_RELAY connection directly to a relay-capable guest
  // (peer.ts:292 routes any incoming `metadata.type === DATA_RELAY` to
  // handleRelayConnection without auth) and inject a raw {isHost:true,
  // senderLabel:'HOST'} frame, spoofing the HOST badge in the L165 guest
  // branch. Mirrors WHISPER L268 / NOTICE L284 / SYSTEM L312 / mute /
  // unmute / freeze / unfreeze / clear / slowmode / filter — every other
  // chat handler already had this guard; CHAT was the gap.
  if (hostConn && !isFromHost(conn)) return;

  // ── Host-side enforcement: rate limit, mute, freeze ──
  if (!hostConn && !isMine) {
    const senderPeerId = (data._originPeer as string) || conn?.peer || '';
    // Rate limit: silently drop frames over the burst+refill threshold so
    // a flooding peer can't saturate the relay path to every other guest.
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
    data.text = text; // Update data so relay sends filtered text
  }

  // ── Badge derivation: Host-side uses authoritative peer list, guest trusts relay ──
  // A malicious guest could send { isHost: true } or { isOp: true } to spoof badges.
  // On the host, we derive the badge from our own connectedPeers list (source of truth)
  // and overwrite data.isHost/isOp BEFORE relaying, so downstream guests receive the
  // correct badge regardless of what the original sender claimed.
  let badge: 'host' | 'op' | undefined;
  if (!hostConn) {
    // Host: derive from authoritative peer list
    const senderPeerId = (data._originPeer as string) || conn?.peer || '';
    const peers = getState('network.connectedPeers');
    const peerEntry = peers.find((p: { id: string }) => p.id === senderPeerId);
    const isOp = peerEntry?.isOp ?? false;
    badge = isOp ? 'op' : undefined; // only host gets 'host' badge (set below)
    // Overwrite untrusted identity + badge fields before relay. Without
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
    // Guest: trust relayed data (host already sanitized it)
    badge = data.isHost ? 'host' : data.isOp ? 'op' : undefined;
  }

  const joinOrder = typeof data.joinOrder === 'number' ? data.joinOrder : undefined;
  addChatMessage(displayName, text, isMine, badge, joinOrder);

  // Relay to downstream peers (Host only), excluding the sender to avoid duplicates
  if (!hostConn) {
    const senderPeerId = (data._originPeer as string) || conn?.peer || '';
    bus.emit('network:broadcast-except', senderPeerId, data);
  }
}

// ─── Admin Handlers ──────────────────────────────────────────────

function handleChatMute(data: Record<string, unknown>, conn?: DataConnection): void {
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
    const senderPeerId = (data._originPeer as string) || conn?.peer || '';
    if (!allowChatFromPeer(senderPeerId)) return;
    if (getState('network.mutedPeers').has(senderPeerId)) return;

    // Authoritative label/id from peer list — a malicious guest could set
    // `senderLabel: 'HOST'` + `senderId: '<hostId>'` and host-relay would
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

  // Guest side — trust only notices relayed by the host.
  if (!isFromHost(conn)) return;

  let senderLabel = (data.senderLabel as string) || '';
  if (senderLabel.length > MAX_SENDER_LABEL_LENGTH)
    senderLabel = senderLabel.substring(0, MAX_SENDER_LABEL_LENGTH);
  let text = (data.text as string) || '';
  if (text.length > MAX_MSG_LENGTH) text = text.substring(0, MAX_MSG_LENGTH);

  addNoticeChatMessage(senderLabel, text);
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
  if (!isFromHost(conn)) return;
  const text = (data.text as string) || '';
  if (text) addSystemChatMessage(text);
}

// ─── Public API ──────────────────────────────────────────────────

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
  });
}

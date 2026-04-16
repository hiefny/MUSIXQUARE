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
  const senderId = data.senderId as string || '';
  const isMine = senderId === myId;

  // Already displayed locally in sendChatMessage() — drop echo-back
  if (isMine) return;

  const hostConn = getState('network.hostConn');

  // ── Host-side enforcement: mute, freeze ──
  if (!hostConn && !isMine) {
    const senderPeerId = (data._originPeer as string) || senderId || conn?.peer || '';
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
  if (senderLabel.length > MAX_SENDER_LABEL_LENGTH) senderLabel = senderLabel.substring(0, MAX_SENDER_LABEL_LENGTH);
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
    const senderPeerId = (data._originPeer as string) || senderId || conn?.peer || '';
    const peers = getState('network.connectedPeers');
    const peerEntry = peers.find((p: { id: string }) => p.id === senderPeerId);
    const isOp = peerEntry?.isOp ?? false;
    badge = isOp ? 'op' : undefined; // only host gets 'host' badge (set below)
    // Overwrite untrusted badge fields before relay
    data.isHost = false;
    data.isOp = isOp;
  } else {
    // Guest: trust relayed data (host already sanitized it)
    badge = data.isHost ? 'host' : data.isOp ? 'op' : undefined;
  }

  const joinOrder = typeof data.joinOrder === 'number' ? data.joinOrder : undefined;
  addChatMessage(displayName, text, isMine, badge, joinOrder);

  // Relay to downstream peers (Host only), excluding the sender to avoid duplicates
  if (!hostConn) {
    const senderPeerId = senderId || conn?.peer || '';
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
  if (!isFromHost(conn)) return;
  (setState as (p: string, v: boolean) => void)('network.chatFrozen', true);
  addSystemChatMessage(t('chat.cmd_frozen'));
}

function handleChatUnfreeze(_data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isFromHost(conn)) return;
  (setState as (p: string, v: boolean) => void)('network.chatFrozen', false);
  addSystemChatMessage(t('chat.cmd_unfrozen'));
}

function handleChatClear(_data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isFromHost(conn)) return;
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

function handleChatSlowmode(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isFromHost(conn)) return;
  const seconds = data.seconds as number || 0;
  (setState as (p: string, v: number) => void)('network.slowmodeSeconds', seconds);
  addSystemChatMessage(seconds > 0
    ? t('chat.cmd_slowmode_on', { sec: seconds })
    : t('chat.cmd_slowmode_off'));
}

function handleChatFilter(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isFromHost(conn)) return;
  const on = !!data.on;
  (setState as (p: string, v: boolean) => void)('network.filterEnabled', on);
  addSystemChatMessage(on
    ? t('chat.cmd_filter_on')
    : t('chat.cmd_filter_off'));
}

function handleChatSystem(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isFromHost(conn)) return;
  const text = data.text as string || '';
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
}

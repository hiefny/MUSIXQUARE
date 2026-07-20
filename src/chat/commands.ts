/**
 * MUSIXQUARE — Chat Commands
 *
 * Parses and executes slash commands from chat input.
 * Local-only commands (/help, /users) never leave the device.
 * Admin commands reuse existing bus events or send protocol messages.
 */

import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import {
  DEVICE_LABEL_SANITIZE_RE,
  MSG,
  PEER_NAME_PREFIX,
  PRO_GENERATED_PEER_NAME_RE,
  RESERVED_NAMES,
  HOST_SELF_NAMES,
  BOT_RATE_LIMIT_MAX_RETRY_SECONDS,
} from '../core/constants.ts';
import { getOtherDeviceLabels } from '../network/guards.ts';
import { sendToHost } from '../network/peer.ts';
import { getRoomContext } from '../rooms/authority.ts';
import { createProRoomIdempotencyKey } from '../pro-room/idempotency.ts';
import { sendProRoomRealtime } from '../pro-room/network-bridge.ts';
import { t } from '../i18n/index.ts';
import {
  addSystemChatMessage,
  addWhisperMessage,
  addNoticeChatMessage,
} from '../ui/chat-render.ts';
import { containsProfanity } from './profanity.ts';
import type { ConnectedPeer } from '../types/index.ts';
import {
  beginLocalBotChatRequest,
  publishBotChatResult,
  rememberPinnedNotice,
  type BotChatResult,
} from './protocol.ts';
import { playAnnouncementSound } from '../audio/ui-sounds.ts';
import { cmdDebug } from './debug-console.ts';
import { extractBotPrompt } from './bot-syntax.ts';

// ─── Types ──────────────────────────────────────────────────────

interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

interface CommandExecutionContext {
  /** Shared by the visible CHAT request, the server call, and its BOT reply. */
  botRequestId?: string;
}

type Permission = 'host' | 'host+op' | 'all';

interface CommandDef {
  permission: Permission;
  execute: (args: string[], rawArgs: string, context?: CommandExecutionContext) => void;
  usage: string;
  description: string;
  suggestWhen?: () => boolean;
  hidden?: boolean; // Hidden from /help output
  hideFromSuggest?: boolean; // Hidden from autocomplete dropdown
}

// ─── Target Resolution ──────────────────────────────────────────

function resolveTarget(arg: string): { peerId: string; label: string } | null {
  if (!arg) return null;

  const myId = getState('network.myId');
  const hostConn = getState('network.hostConn');
  const deviceList = getState('network.lastKnownDeviceList') || [];

  // 1. By join-order number (#N)
  if (arg.startsWith('#')) {
    const order = parseInt(arg.slice(1), 10);
    if (isNaN(order)) return null;

    // Is it me?
    const myOrder = getState('network.myJoinOrder');
    if (order === myOrder && myId) {
      return {
        peerId: myId,
        label: getState('network.myDeviceLabel') || (hostConn ? 'ME' : 'HOST'),
      };
    }

    // Is it someone in the session?
    const target = deviceList.find((d) => d.joinOrder === order);
    if (target && target.id) return { peerId: target.id, label: target.label };

    // Fallback: if we are a guest and targeting #0, and it's not in the list for some reason
    if (order === 0 && hostConn) {
      return { peerId: hostConn.peer, label: 'HOST' };
    }

    return null;
  }

  // 2. By nickname (case-insensitive)
  const lower = arg.toLowerCase();

  // Is it me?
  const myLabel = (getState('network.myDeviceLabel') || '').toLowerCase();
  if (myLabel === lower && myId) {
    return { peerId: myId, label: getState('network.myDeviceLabel') || 'ME' };
  }

  // Is it someone in the session?
  const target = deviceList.find((d) => d.label.toLowerCase() === lower);
  if (target && target.id) return { peerId: target.id, label: target.label };

  return null;
}

// ─── Permission Check ───────────────────────────────────────────

function isHost(): boolean {
  return !getState('network.hostConn');
}

function isStandardRoom(): boolean {
  return getRoomContext().kind !== 'pro';
}

function hasPermission(perm: Permission): boolean {
  if (perm === 'all') return true;
  if (perm === 'host') return isHost();
  if (perm === 'host+op') return isHost() || getState('network.isOperator');
  return false;
}

// ─── Command Implementations ────────────────────────────────────

function cmdKick(args: string[]): void {
  if (!args[0]) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: t('chat.cmd_u_kick') }));
    return;
  }
  const target = resolveTarget(args[0]);
  if (!target) {
    addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] }));
    return;
  }
  bus.emit(
    getRoomContext().kind === 'pro' ? 'pro-room:kick-member' : 'network:kick-device',
    target.peerId,
  );
}

function cmdOp(args: string[]): void {
  // PRO authority is server-issued and equal for every live member. Never
  // recreate the legacy browser-admin hierarchy through a hidden command.
  if (!isStandardRoom()) return;

  if (!args[0]) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: t('chat.cmd_u_op') }));
    return;
  }
  const target = resolveTarget(args[0]);
  if (!target) {
    addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] }));
    return;
  }
  if (target.peerId === getState('network.myId')) {
    addSystemChatMessage(t('chat.cmd_already_op', { name: target.label }));
    return;
  }
  const peers = getState('network.connectedPeers') as ConnectedPeer[];
  const peer = peers.find((p) => p.id === target.peerId);
  if (!peer) {
    addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] }));
    return;
  }
  if (peer.isOp) {
    addSystemChatMessage(t('chat.cmd_already_op', { name: target.label }));
    return;
  }
  bus.emit('network:toggle-operator', target.peerId);
}

function cmdDeop(args: string[]): void {
  if (!isStandardRoom()) return;

  if (!args[0]) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: t('chat.cmd_u_deop') }));
    return;
  }
  const target = resolveTarget(args[0]);
  if (!target) {
    addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] }));
    return;
  }
  if (target.peerId === getState('network.myId')) {
    addSystemChatMessage(t('chat.cmd_no_permission'));
    return;
  }
  const peers = getState('network.connectedPeers') as ConnectedPeer[];
  const peer = peers.find((p) => p.id === target.peerId);
  if (!peer) {
    addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] }));
    return;
  }
  if (!peer.isOp) {
    addSystemChatMessage(t('chat.cmd_not_op', { name: target.label }));
    return;
  }
  bus.emit('network:toggle-operator', target.peerId);
}

function cmdFreeze(args: string[]): void {
  const flag = args[0]?.toLowerCase();
  if (flag !== 'on' && flag !== 'off') {
    addSystemChatMessage(t('chat.cmd_usage', { usage: '/freeze on|off' }));
    return;
  }
  const on = flag === 'on';
  setState('network.chatFrozen', on);
  if (getRoomContext().kind === 'pro') {
    sendProRoomRealtime('chat', { kind: 'freeze', on });
  } else {
    bus.emit('network:broadcast', { type: on ? MSG.CHAT_FREEZE : MSG.CHAT_UNFREEZE });
  }
  addSystemChatMessage(on ? t('chat.cmd_frozen') : t('chat.cmd_unfrozen'));
}

function cmdMute(args: string[]): void {
  if (!args[0]) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: t('chat.cmd_u_mute') }));
    return;
  }
  const target = resolveTarget(args[0]);
  if (!target) {
    addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] }));
    return;
  }

  if (getRoomContext().kind === 'pro') {
    sendProRoomRealtime('chat', {
      kind: 'mute',
      targetParticipantId: target.peerId,
      on: true,
    });
    addSystemChatMessage(t('chat.cmd_muted', { name: target.label }));
  } else if (isHost()) {
    // Host executes directly
    const current = getState('network.mutedPeers');
    setState('network.mutedPeers', new Set([...current, target.peerId]));
    bus.emit('network:broadcast', {
      type: MSG.CHAT_MUTE,
      targetId: target.peerId,
      targetLabel: target.label,
    });
    addSystemChatMessage(t('chat.cmd_muted', { name: target.label }));
  } else {
    // OP guest sends request to host
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'mute', args });
  }
}

function cmdUnmute(args: string[]): void {
  if (!args[0]) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: t('chat.cmd_u_unmute') }));
    return;
  }
  const target = resolveTarget(args[0]);
  if (!target) {
    addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] }));
    return;
  }

  if (getRoomContext().kind === 'pro') {
    sendProRoomRealtime('chat', {
      kind: 'mute',
      targetParticipantId: target.peerId,
      on: false,
    });
    addSystemChatMessage(t('chat.cmd_unmuted', { name: target.label }));
  } else if (isHost()) {
    const current = getState('network.mutedPeers');
    const next = new Set([...current]);
    next.delete(target.peerId);
    setState('network.mutedPeers', next);
    bus.emit('network:broadcast', {
      type: MSG.CHAT_UNMUTE,
      targetId: target.peerId,
      targetLabel: target.label,
    });
    addSystemChatMessage(t('chat.cmd_unmuted', { name: target.label }));
  } else {
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'unmute', args });
  }
}

function cmdClear(): void {
  if (getRoomContext().kind === 'pro') {
    sendProRoomRealtime('chat', { kind: 'clear' });
    bus.emit('chat:clear-all');
  } else if (isHost()) {
    bus.emit('network:broadcast', { type: MSG.CHAT_CLEAR });
    bus.emit('chat:clear-all');
  } else {
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'clear', args: [] });
  }
}

function cmdFilter(args: string[]): void {
  const on = args[0]?.toLowerCase() === 'on';
  const off = args[0]?.toLowerCase() === 'off';
  if (!on && !off) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: '/filter on|off' }));
    return;
  }

  if (getRoomContext().kind === 'pro') {
    setState('network.filterEnabled', on);
    sendProRoomRealtime('chat', { kind: 'filter', on });
    addSystemChatMessage(on ? t('chat.cmd_filter_on') : t('chat.cmd_filter_off'));
  } else if (isHost()) {
    setState('network.filterEnabled', on);
    bus.emit('network:broadcast', { type: MSG.CHAT_FILTER, on });
    addSystemChatMessage(on ? t('chat.cmd_filter_on') : t('chat.cmd_filter_off'));
  } else {
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'filter', args });
  }
}

function cmdSlowmode(args: string[]): void {
  const sec = parseInt(args[0] || '0', 10);
  if (isNaN(sec) || sec < 0 || sec > 60) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: '/slowmode 0~60' }));
    return;
  }

  if (getRoomContext().kind === 'pro') {
    setState('network.slowmodeSeconds', sec);
    sendProRoomRealtime('chat', { kind: 'slowmode', seconds: sec });
    addSystemChatMessage(sec > 0 ? t('chat.cmd_slowmode_on', { sec }) : t('chat.cmd_slowmode_off'));
  } else if (isHost()) {
    setState('network.slowmodeSeconds', sec);
    bus.emit('network:broadcast', { type: MSG.CHAT_SLOWMODE, seconds: sec });
    addSystemChatMessage(sec > 0 ? t('chat.cmd_slowmode_on', { sec }) : t('chat.cmd_slowmode_off'));
  } else {
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'slowmode', args });
  }
}

function cmdNotice(_: string[], rawArgs: string): void {
  if (!rawArgs.trim()) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: t('chat.cmd_u_notice') }));
    return;
  }
  const senderLabel = getState('network.myDeviceLabel') || 'HOST';
  const payload = {
    type: MSG.CHAT_NOTICE,
    senderLabel,
    text: rawArgs.trim(),
    ts: Date.now(),
    attention: true,
  };

  if (getRoomContext().kind === 'pro') {
    rememberPinnedNotice(payload);
    sendProRoomRealtime('chat', { kind: 'notice', text: rawArgs.trim() });
    addNoticeChatMessage(senderLabel, rawArgs.trim(), payload.ts);
    playAnnouncementSound();
  } else if (isHost()) {
    rememberPinnedNotice(payload);
    bus.emit('network:broadcast', payload);
    addNoticeChatMessage(senderLabel, rawArgs.trim(), payload.ts);
    playAnnouncementSound();
  } else {
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'notice', args: [rawArgs.trim()] });
  }
}

function cmdNick(_: string[], rawArgs: string): void {
  // Mirror the host's sanitize (handleRequestRename) so a name that strips
  // into a reserved/duplicate/empty string fails HERE with feedback instead
  // of being silently rejected by the host.
  const newName = rawArgs.replace(DEVICE_LABEL_SANITIZE_RE, '').trim();
  if (!newName) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: t('chat.cmd_u_nick') }));
    return;
  }
  if (newName.length > 20) {
    addSystemChatMessage(t('chat.cmd_nick_too_long'));
    return;
  }
  // A coordinator-free PRO endpoint also has no hostConn, but that is an
  // internal compatibility shape rather than the reserved HOST identity.
  const isHostSelf = isStandardRoom() && !getState('network.hostConn');
  const nameLower = newName.toLowerCase();
  const isHostRestore = isHostSelf && (HOST_SELF_NAMES as readonly string[]).includes(nameLower);
  if (RESERVED_NAMES.some((r) => nameLower === r.toLowerCase())) {
    if (!isHostRestore) {
      addSystemChatMessage(t('connect.rename_reserved'));
      return;
    }
  }
  if (/^#\d+$/.test(newName)) {
    addSystemChatMessage(t('connect.rename_reserved'));
    return;
  }
  if (getRoomContext().kind === 'pro' && PRO_GENERATED_PEER_NAME_RE.test(newName)) {
    addSystemChatMessage(t('connect.rename_reserved'));
    return;
  }
  if (!isHostRestore && containsProfanity(newName)) {
    addSystemChatMessage(t('connect.rename_profanity'));
    return;
  }
  // Role-aware duplicate check: connectedPeers is host-only state (ALWAYS
  // empty on a guest) — getOtherDeviceLabels reads the device-list broadcast
  // on guests, matching what the host's handleRequestRename will silently
  // reject.
  if (getOtherDeviceLabels().some((label) => label.toLowerCase() === newName.toLowerCase())) {
    addSystemChatMessage(t('connect.rename_duplicate'));
    return;
  }
  bus.emit('network:rename-device', newName);
  addSystemChatMessage(t('chat.cmd_nick_changed', { name: newName }));
}

function cmdWhisper(args: string[], rawArgs: string): void {
  if (!args[0]) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: t('chat.cmd_u_w') }));
    return;
  }
  const target = resolveTarget(args[0]);
  if (!target) {
    addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] }));
    return;
  }

  // Extract message (everything after the target identifier)
  const msgStart = rawArgs.indexOf(args[0]) + args[0].length;
  const msg = rawArgs.slice(msgStart).trim();
  if (!msg) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: t('chat.cmd_u_w') }));
    return;
  }

  const myId = getState('network.myId') || '';
  const myLabel = getState('network.myDeviceLabel') || '';
  const myJoinOrder = getState('network.myJoinOrder') ?? 0;
  const payload = {
    type: MSG.CHAT_WHISPER,
    senderId: myId,
    senderLabel: myLabel,
    targetId: target.peerId,
    text: msg,
    ts: Date.now(),
    joinOrder: myJoinOrder,
  };

  if (getRoomContext().kind === 'pro') {
    sendProRoomRealtime('chat', {
      kind: 'whisper',
      targetParticipantId: target.peerId,
      text: msg,
    });
  } else if (isHost()) {
    // Host sends directly to target
    const connMap = getState('network.activeHostConnByPeerId');
    const conn = connMap.get(target.peerId);
    if (conn) conn.send(payload);
  } else {
    // Guest sends to host, host forwards to target
    sendToHost(payload);
  }

  // Show locally as "whisper to X"
  addWhisperMessage(target.label, msg, true);
}

function cmdHelp(): void {
  const lines: string[] = [t('chat.cmd_help_title')];
  const role = isHost() ? 'host' : getState('network.isOperator') ? 'op' : 'user';

  for (const [, def] of _allCommandEntries()) {
    if (def.hidden) continue;
    if (def.suggestWhen && !def.suggestWhen()) continue;
    if (
      def.permission === 'all' ||
      (def.permission === 'host' && role === 'host') ||
      (def.permission === 'host+op' && (role === 'host' || role === 'op'))
    ) {
      lines.push(`${def.usage} - ${def.description}`);
    }
  }
  lines.push(t('chat.cmd_help_target_hint'));
  addSystemChatMessage(lines.join('\n'));
}

function cmdUsers(): void {
  const isProRoom = getRoomContext().kind === 'pro';
  const deviceList = getState('network.lastKnownDeviceList') || [];
  const myId = getState('network.myId');
  const myOrder = getState('network.myJoinOrder') ?? 0;
  const myLabel =
    getState('network.myDeviceLabel') ||
    (isProRoom ? PEER_NAME_PREFIX : myOrder === 0 ? 'HOST' : 'ME');

  const lines: string[] = [t('chat.cmd_users_title')];

  // If we don't have a device list yet (early join or host-only), build a fallback list
  let displayList = deviceList;
  if (!displayList || displayList.length === 0) {
    displayList = [
      {
        id: myId || '',
        label: myLabel || 'ME',
        isHost: !isProRoom && myOrder === 0,
        isOp: true, // Self is always authorized for self-view
        joinOrder: myOrder,
        status: 'connected',
      },
    ];
  }

  // Sort and format each user
  const sorted = [...displayList].sort((a, b) => (a.joinOrder ?? 0) - (b.joinOrder ?? 0));

  for (const d of sorted) {
    const isMe = d.id === myId;
    const flags: string[] = [];
    // PRO exposes no host/admin rank: all live participants share the same
    // controls and the server is the only manager. Keep only the local-self
    // marker even though the compatibility device list marks every member op.
    if (!isProRoom && d.isHost) flags.push('HOST');
    if (!isProRoom && d.isOp && !d.isHost) flags.push('ADMIN');
    if (isMe) flags.push(t('chat.cmd_users_me'));

    const suffix = flags.length ? ` [${flags.join(', ')}]` : '';
    lines.push(`#${d.joinOrder}. ${d.label}${suffix}`);
  }

  addSystemChatMessage(lines.join('\n'));
}

function getBotRoomId(): string | null {
  const room = getRoomContext();
  return room.kind === 'pro' ? room.roomId : null;
}

function isBotRoom(): boolean {
  return getBotRoomId() !== null;
}

const _botRequestsInFlight = new Map<string, { requestId: string }>();

function getBotRateLimitRetryAfter(error: unknown): number | null {
  if (error === null || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; retryAfterSeconds?: unknown };
  if (candidate.code !== 'RATE_LIMITED') return null;
  const retryAfterSeconds = candidate.retryAfterSeconds;
  if (
    typeof retryAfterSeconds !== 'number' ||
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds <= 0 ||
    retryAfterSeconds > BOT_RATE_LIMIT_MAX_RETRY_SECONDS
  ) {
    return null;
  }
  const rounded = Math.max(1, Math.ceil(retryAfterSeconds));
  return rounded <= BOT_RATE_LIMIT_MAX_RETRY_SECONDS ? rounded : null;
}

async function runBotCommand(rawArgs: string, requestId?: string): Promise<void> {
  const roomId = getBotRoomId();
  if (!roomId) {
    addSystemChatMessage(t('chat.bot_unavailable'));
    return;
  }
  const prompt = rawArgs.trim();
  if (!prompt) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: t('chat.cmd_u_bot') }));
    return;
  }
  if (_botRequestsInFlight.has(roomId)) {
    addSystemChatMessage(t('chat.bot_processing'));
    return;
  }

  const resolvedRequestId = requestId ?? createProRoomIdempotencyKey();
  if (!beginLocalBotChatRequest(resolvedRequestId, roomId)) {
    addSystemChatMessage(t('chat.bot_failed'));
    return;
  }

  const operation = { requestId: resolvedRequestId };
  _botRequestsInFlight.set(roomId, operation);
  try {
    const { requestActiveProRoomBotCommand } = await import('../pro-room/runtime.ts');
    if (getBotRoomId() !== roomId) return;
    const result = await requestActiveProRoomBotCommand(roomId, prompt, resolvedRequestId);
    if (getBotRoomId() !== roomId) return;
    const terminal: BotChatResult =
      result.addedCount > 0
        ? {
            kind: 'added',
            count: result.addedCount,
            playbackChanged: result.playbackChanged,
          }
        : { kind: 'answer', text: result.summary };
    publishBotChatResult(resolvedRequestId, terminal);
  } catch (error) {
    if (getBotRoomId() !== roomId) return;
    if (
      error !== null &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'BOT_SESSION_SUPERSEDED'
    ) {
      return;
    }
    const retryAfterSeconds = getBotRateLimitRetryAfter(error);
    const terminal: BotChatResult =
      retryAfterSeconds === null ? { kind: 'failed' } : { kind: 'rate_limited', retryAfterSeconds };
    publishBotChatResult(resolvedRequestId, terminal);
  } finally {
    if (_botRequestsInFlight.get(roomId) === operation) _botRequestsInFlight.delete(roomId);
  }
}

function cmdBot(_args: string[], rawArgs: string, context?: CommandExecutionContext): void {
  void runBotCommand(rawArgs, context?.botRequestId);
}

// ─── Command Registry ───────────────────────────────────────────

// usage/description use i18n keys, resolved at access time via getAvailableCommands()
const COMMANDS_DEF: Record<
  string,
  Omit<CommandDef, 'usage' | 'description'> & { usageKey: string; descKey: string }
> = {
  help: {
    permission: 'all',
    execute: cmdHelp,
    usageKey: 'chat.cmd_u_help',
    descKey: 'chat.cmd_d_help',
    hidden: true,
  },
  users: {
    permission: 'all',
    execute: cmdUsers,
    usageKey: 'chat.cmd_u_users',
    descKey: 'chat.cmd_d_users',
  },
  bot: {
    permission: 'all',
    execute: cmdBot,
    usageKey: 'chat.cmd_u_bot',
    descKey: 'chat.cmd_d_bot',
    suggestWhen: isBotRoom,
  },
  clear: {
    permission: 'host+op',
    execute: cmdClear,
    usageKey: 'chat.cmd_u_clear',
    descKey: 'chat.cmd_d_clear',
  },
  filter: {
    permission: 'host+op',
    execute: cmdFilter,
    usageKey: 'chat.cmd_u_filter',
    descKey: 'chat.cmd_d_filter',
  },
  freeze: {
    permission: 'host',
    execute: cmdFreeze,
    usageKey: 'chat.cmd_u_freeze',
    descKey: 'chat.cmd_d_freeze',
  },
  slowmode: {
    permission: 'host+op',
    execute: cmdSlowmode,
    usageKey: 'chat.cmd_u_slowmode',
    descKey: 'chat.cmd_d_slowmode',
  },
  w: { permission: 'all', execute: cmdWhisper, usageKey: 'chat.cmd_u_w', descKey: 'chat.cmd_d_w' },
  notice: {
    permission: 'host+op',
    execute: cmdNotice,
    usageKey: 'chat.cmd_u_notice',
    descKey: 'chat.cmd_d_notice',
  },
  nick: {
    permission: 'all',
    execute: cmdNick,
    usageKey: 'chat.cmd_u_nick',
    descKey: 'chat.cmd_d_nick',
  },
  kick: {
    permission: 'host',
    execute: cmdKick,
    usageKey: 'chat.cmd_u_kick',
    descKey: 'chat.cmd_d_kick',
  },
  op: {
    permission: 'host',
    execute: cmdOp,
    usageKey: 'chat.cmd_u_op',
    descKey: 'chat.cmd_d_op',
    suggestWhen: isStandardRoom,
  },
  deop: {
    permission: 'host',
    execute: cmdDeop,
    usageKey: 'chat.cmd_u_deop',
    descKey: 'chat.cmd_d_deop',
    suggestWhen: isStandardRoom,
  },
  mute: {
    permission: 'host+op',
    execute: cmdMute,
    usageKey: 'chat.cmd_u_mute',
    descKey: 'chat.cmd_d_mute',
  },
  unmute: {
    permission: 'host+op',
    execute: cmdUnmute,
    usageKey: 'chat.cmd_u_unmute',
    descKey: 'chat.cmd_d_unmute',
  },
  whisper: {
    permission: 'all',
    execute: cmdWhisper,
    usageKey: 'chat.cmd_u_whisper',
    descKey: 'chat.cmd_d_w',
    hidden: true,
    hideFromSuggest: true,
  },
  debug: {
    permission: 'all',
    execute: cmdDebug,
    usageKey: 'chat.cmd_u_debug',
    descKey: 'chat.cmd_d_debug',
  },
};

// Resolve i18n at access time
function _resolveCommand(name: string): CommandDef | undefined {
  const def = COMMANDS_DEF[name];
  if (!def) return undefined;
  return {
    ...def,
    usage: t(def.usageKey as Parameters<typeof t>[0]),
    description: t(def.descKey as Parameters<typeof t>[0]),
  };
}

// For iteration (help list, autocomplete)
function _allCommandEntries(): [string, CommandDef][] {
  return Object.entries(COMMANDS_DEF).map(([name, def]) => [
    name,
    {
      ...def,
      usage: t(def.usageKey as Parameters<typeof t>[0]),
      description: t(def.descKey as Parameters<typeof t>[0]),
    },
  ]);
}

// ─── Public API ─────────────────────────────────────────────────

export function parseCommand(input: string): ParsedCommand | null {
  if (!input.startsWith('/')) return null;
  if (input.startsWith('//') && (input === '//' || extractBotPrompt(input) !== null)) {
    const rawArgs = input.slice(2);
    const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
    return { name: 'bot', args, rawArgs };
  }
  const spaceIdx = input.indexOf(' ');
  const name = (spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)).toLowerCase();
  const rawArgs = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1);
  const args = rawArgs ? rawArgs.split(/\s+/) : [];
  return { name, args, rawArgs };
}

export function getAvailableCommands(
  filter = '',
): { name: string; usage: string; description: string }[] {
  const result: { name: string; usage: string; description: string }[] = [];
  const query = filter.toLowerCase();
  for (const [name, def] of _allCommandEntries()) {
    if (def.hideFromSuggest) continue;
    if (def.suggestWhen && !def.suggestWhen()) continue;
    if (!hasPermission(def.permission)) continue;
    if (query && !name.startsWith(query)) continue;
    result.push({ name, usage: def.usage, description: def.description });
  }
  return result;
}

/** Returns the argument hint for a command, e.g. "/freeze" → "[on | off]" */
export function getCommandArgHint(cmdName: string): string {
  const def = _resolveCommand(cmdName.toLowerCase());
  if (!def) return '';
  const spaceIdx = def.usage.indexOf(' ');
  return spaceIdx === -1 ? '' : def.usage.slice(spaceIdx + 1);
}

/**
 * Only a valid, locally executable BOT request is intentionally visible as
 * ordinary room chat. Every other slash command remains a local command.
 */
export function shouldBroadcastCommand(cmd: ParsedCommand): boolean {
  const roomId = getBotRoomId();
  return (
    cmd.name === 'bot' &&
    roomId !== null &&
    cmd.rawArgs.trim().length > 0 &&
    !_botRequestsInFlight.has(roomId)
  );
}

export function executeCommand(cmd: ParsedCommand, context?: CommandExecutionContext): void {
  const def = _resolveCommand(cmd.name);
  if (!def) {
    addSystemChatMessage(t('chat.cmd_unknown', { cmd: cmd.name }));
    return;
  }
  if (!hasPermission(def.permission)) {
    addSystemChatMessage(t('chat.cmd_no_permission'));
    return;
  }
  if (context) def.execute(cmd.args, cmd.rawArgs, context);
  else def.execute(cmd.args, cmd.rawArgs);
}

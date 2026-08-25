/**
 * MUSIXQUARE — Chat Commands
 *
 * Parses and executes slash commands from chat input.
 * Local-only commands (/help, /users) never leave the device.
 * Admin commands reuse existing bus events or send protocol messages.
 */

import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, PEER_NAME_PREFIX, BOT_RATE_LIMIT_MAX_RETRY_SECONDS } from '../core/constants.ts';
import { sendToHost } from '../network/peer.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import { roomCapabilityRequiredMessage } from '../rooms/permission-feedback.ts';
import { createProRoomIdempotencyKey } from '../pro-room/idempotency.ts';
import { sendProRoomRealtime } from '../pro-room/network-bridge.ts';
import { t } from '../i18n/index.ts';
import {
  addSystemChatMessage,
  addWhisperMessage,
  addNoticeChatMessage,
} from '../ui/chat-render.ts';
import type { ConnectedPeer, DeviceInfo } from '../types/index.ts';
import { groupConnectedRoomMembers } from '../rooms/member-directory.ts';
import {
  beginLocalBotChatRequest,
  publishBotChatResult,
  rememberPinnedNotice,
  type BotChatResult,
} from './protocol.ts';
import { playAnnouncementSound } from '../audio/ui-sounds.ts';
import { extractBotPrompt } from './bot-syntax.ts';
import { isAccountAuthenticated } from '../account/state.ts';
import {
  accountNicknameMutationErrorMessage,
  normalizeAccountNickname,
  updateCurrentAccountNickname,
  validateAccountNickname,
} from '../account/nickname.ts';

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

type Permission = 'host' | 'physical-host' | 'members' | 'notice' | 'bot' | 'all';

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

interface ResolvedCommandTarget {
  peerId: string;
  label: string;
  /** Server-issued person identity when the room exposes one. */
  memberId: string | null;
}

function resolvedTarget(device: Readonly<DeviceInfo>): ResolvedCommandTarget {
  return {
    peerId: device.id,
    label: device.label,
    memberId: typeof device.memberId === 'string' && device.memberId ? device.memberId : null,
  };
}

function firstConnected(devices: readonly Readonly<DeviceInfo>[]): Readonly<DeviceInfo> | null {
  return devices.find((device) => device.status === 'connected') || devices[0] || null;
}

function resolveTarget(arg: string): ResolvedCommandTarget | null {
  if (!arg) return null;

  const myId = getState('network.myId');
  const hostConn = getState('network.hostConn');
  const deviceList = (getState('network.lastKnownDeviceList') || []) as DeviceInfo[];

  // 1. By join-order number (#N)
  if (arg.startsWith('#')) {
    const order = parseInt(arg.slice(1), 10);
    if (isNaN(order)) return null;

    // Is it me?
    const myMemberDisplayNumber = getState('network.myMemberDisplayNumber');
    const myOrder = getState('network.myJoinOrder');
    if (
      order === (typeof myMemberDisplayNumber === 'number' ? myMemberDisplayNumber : myOrder) &&
      myId
    ) {
      return {
        peerId: myId,
        label: getState('network.myDeviceLabel') || (hostConn ? 'ME' : 'HOST'),
        memberId: getState('network.myMemberId') || null,
      };
    }

    // The connection UI displays the person-level memberDisplayNumber. Resolve
    // that visible number first and choose one connected transport as the
    // delivery representative. Account-wide commands carry memberId below, so
    // they still affect every device owned by that member.
    const memberTarget = firstConnected(
      deviceList.filter((device) => device.memberDisplayNumber === order),
    );
    if (memberTarget) return resolvedTarget(memberTarget);

    // Cached/legacy room projections expose only the physical joinOrder. Keep
    // that historical syntax as a fallback without letting it override a
    // currently visible person-level number.
    const legacyTarget = firstConnected(
      deviceList.filter(
        (device) => device.memberDisplayNumber === undefined && device.joinOrder === order,
      ),
    );
    if (legacyTarget) return resolvedTarget(legacyTarget);

    // Fallback: if we are a guest and targeting #0, and it's not in the list for some reason
    if (order === 0 && hostConn) {
      return { peerId: hostConn.peer, label: 'HOST', memberId: null };
    }

    return null;
  }

  // 2. By nickname (case-insensitive)
  const lower = arg.toLowerCase();

  // Is it me?
  const myLabel = (getState('network.myDeviceLabel') || '').toLowerCase();
  if (myLabel === lower && myId) {
    return {
      peerId: myId,
      label: getState('network.myDeviceLabel') || 'ME',
      memberId: getState('network.myMemberId') || null,
    };
  }

  // Is it someone in the session?
  const target = deviceList.find((d) => d.label.toLowerCase() === lower);
  if (target && target.id) return resolvedTarget(target);

  return null;
}

// ─── Permission Check ───────────────────────────────────────────

function isHost(): boolean {
  return hasRoomCapability('room.configure');
}

function isPhysicalStandardHost(): boolean {
  return (
    isStandardRoom() && getState('network.appRole') === 'host' && !getState('network.hostConn')
  );
}

function isStandardRoom(): boolean {
  return getRoomContext().kind !== 'pro';
}

function hasPermission(perm: Permission): boolean {
  if (perm === 'all') return true;
  if (perm === 'host') return isHost();
  if (perm === 'physical-host') return isPhysicalStandardHost();
  if (perm === 'members') return hasRoomCapability('members.manage');
  if (perm === 'notice') return hasRoomCapability('chat.notice');
  if (perm === 'bot') return canUseBot();
  return false;
}

function permissionDeniedMessage(permission: Permission): string {
  if (permission === 'members') return roomCapabilityRequiredMessage('members.manage');
  if (permission === 'notice') return roomCapabilityRequiredMessage('chat.notice');
  if (permission === 'host') {
    return roomCapabilityRequiredMessage('room.configure');
  }
  if (permission === 'physical-host') return t('toast.host_setting_required');
  return t('chat.cmd_no_permission');
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
  if (getRoomContext().kind === 'pro') {
    bus.emit('pro-room:kick-member', target.memberId || target.peerId);
    return;
  }
  const memberId = target.memberId || `peer:${target.peerId}`;
  bus.emit('network:request-kick-standard-room-member', { memberId });
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
  if (getRoomContext().kind === 'pro') {
    setState('network.chatFrozen', on);
    sendProRoomRealtime('chat', { kind: 'freeze', on });
  } else if (isPhysicalStandardHost()) {
    setState('network.chatFrozen', on);
    bus.emit('network:broadcast', { type: on ? MSG.CHAT_FREEZE : MSG.CHAT_UNFREEZE });
  } else {
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'freeze', args: [flag] });
    return;
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
  } else if (isPhysicalStandardHost()) {
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
  } else if (isPhysicalStandardHost()) {
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
  } else if (isPhysicalStandardHost()) {
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
  } else if (isPhysicalStandardHost()) {
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
  } else if (isPhysicalStandardHost()) {
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
  } else if (isPhysicalStandardHost()) {
    rememberPinnedNotice(payload);
    bus.emit('network:broadcast', payload);
    addNoticeChatMessage(senderLabel, rawArgs.trim(), payload.ts);
    playAnnouncementSound();
  } else {
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'notice', args: [rawArgs.trim()] });
  }
}

function cmdNick(_: string[], rawArgs: string): void {
  const newName = normalizeAccountNickname(rawArgs);
  if (!newName) {
    addSystemChatMessage(t('chat.cmd_usage', { usage: t('chat.cmd_u_nick') }));
    return;
  }

  if (!isAccountAuthenticated()) {
    bus.emit('account:open');
    return;
  }

  const validationError = validateAccountNickname(newName);
  if (validationError) {
    addSystemChatMessage(validationError);
    return;
  }

  void updateCurrentAccountNickname(newName)
    .then((nickname) => {
      addSystemChatMessage(t('chat.cmd_nick_changed', { name: nickname }));
    })
    .catch((error: unknown) => {
      addSystemChatMessage(accountNicknameMutationErrorMessage(error));
    });
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
  } else if (isPhysicalStandardHost()) {
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

  for (const [, def] of _allCommandEntries()) {
    if (def.hidden) continue;
    if (def.suggestWhen && !def.suggestWhen()) continue;
    if (hasPermission(def.permission)) {
      lines.push(`${def.usage} - ${def.description}`);
    }
  }
  lines.push(t('chat.cmd_help_target_hint'));
  addSystemChatMessage(lines.join('\n'));
}

function cmdUsers(): void {
  const isProRoom = getRoomContext().kind === 'pro';
  const deviceList = (getState('network.lastKnownDeviceList') || []) as DeviceInfo[];
  const myId = getState('network.myId');
  const myOrder = getState('network.myJoinOrder') ?? 0;
  const myLabel =
    getState('network.myDeviceLabel') ||
    (isProRoom ? PEER_NAME_PREFIX : myOrder === 0 ? 'HOST' : 'ME');

  const lines: string[] = [t('chat.cmd_users_title')];

  // If we don't have a device list yet (early join or host-only), build a fallback list
  let displayList: DeviceInfo[] = deviceList;
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

  // Match the connection tab's person-level projection. This keeps the number
  // shown by /users usable by /kick, /w, and the other target commands even
  // when several physical devices belong to one signed-in account.
  const members = groupConnectedRoomMembers(displayList, myId || '');

  for (const member of members) {
    const flags: string[] = [];
    // PRO exposes no host/admin rank: all live participants share the same
    // controls and the server is the only manager. Keep only the local-self
    // marker even though the compatibility device list marks every member op.
    const isStandardOwnerDevice =
      !isProRoom &&
      (member.isHost || (member.isAuthenticated && member.capabilities.includes('room.configure')));
    if (isStandardOwnerDevice) flags.push('HOST');
    if (!isProRoom && member.isAdministrator && !isStandardOwnerDevice) flags.push('ADMIN');
    if (member.isCurrent) flags.push(t('chat.cmd_users_me'));

    const suffix = flags.length ? ` [${flags.join(', ')}]` : '';
    const deviceCount = member.deviceCount > 1 ? ` (${member.deviceCount})` : '';
    lines.push(`#${member.memberDisplayNumber}. ${member.label}${deviceCount}${suffix}`);
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

function canUseBot(): boolean {
  if (!isBotRoom()) return false;
  const myId = getState('network.myId');
  if (!myId) return false;
  const viewer = (getState('network.lastKnownDeviceList') || []).find(
    (device) => device.id === myId,
  );
  return viewer?.role === 'owner' || viewer?.role === 'controller';
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
  runBotCommand(rawArgs, context?.botRequestId).catch((error) => {
    log.error('[Chat] Bot command failed outside its request boundary', error);
  });
}

async function cmdDebugLazy(args: string[], _rawArgs: string): Promise<void> {
  // The diagnostics console is a manual-only surface. Keep its DOM renderer
  // and snapshot formatters out of the startup graph, while preserving the
  // synchronous command dispatcher contract for every ordinary command.
  try {
    const debugConsole = await import('./debug-console.ts');
    debugConsole.cmdDebug(args);
  } catch (error) {
    log.error('[Chat] Failed to load the debug console', error);
  }
}

function cmdDebugCommand(args: string[], rawArgs: string): void {
  cmdDebugLazy(args, rawArgs).catch((error) => {
    log.error('[Chat] Debug command failed outside its lazy-load boundary', error);
  });
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
    permission: 'bot',
    execute: cmdBot,
    usageKey: 'chat.cmd_u_bot',
    descKey: 'chat.cmd_d_bot',
    suggestWhen: isBotRoom,
  },
  clear: {
    permission: 'host',
    execute: cmdClear,
    usageKey: 'chat.cmd_u_clear',
    descKey: 'chat.cmd_d_clear',
  },
  filter: {
    permission: 'host',
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
    permission: 'host',
    execute: cmdSlowmode,
    usageKey: 'chat.cmd_u_slowmode',
    descKey: 'chat.cmd_d_slowmode',
  },
  w: { permission: 'all', execute: cmdWhisper, usageKey: 'chat.cmd_u_w', descKey: 'chat.cmd_d_w' },
  notice: {
    permission: 'notice',
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
    permission: 'members',
    execute: cmdKick,
    usageKey: 'chat.cmd_u_kick',
    descKey: 'chat.cmd_d_kick',
  },
  op: {
    permission: 'physical-host',
    execute: cmdOp,
    usageKey: 'chat.cmd_u_op',
    descKey: 'chat.cmd_d_op',
    suggestWhen: isStandardRoom,
  },
  deop: {
    permission: 'physical-host',
    execute: cmdDeop,
    usageKey: 'chat.cmd_u_deop',
    descKey: 'chat.cmd_d_deop',
    suggestWhen: isStandardRoom,
  },
  mute: {
    permission: 'host',
    execute: cmdMute,
    usageKey: 'chat.cmd_u_mute',
    descKey: 'chat.cmd_d_mute',
  },
  unmute: {
    permission: 'host',
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
    execute: cmdDebugCommand,
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
    canUseBot() &&
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
    addSystemChatMessage(permissionDeniedMessage(def.permission));
    return;
  }
  if (context) def.execute(cmd.args, cmd.rawArgs, context);
  else def.execute(cmd.args, cmd.rawArgs);
}

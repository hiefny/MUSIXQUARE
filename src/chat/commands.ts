/**
 * MUSIXQUARE 3.0 — Chat Commands
 *
 * Parses and executes slash commands from chat input.
 * Local-only commands (/help, /users) never leave the device.
 * Admin commands reuse existing bus events or send protocol messages.
 */

import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, RESERVED_NAMES } from '../core/constants.ts';
import { sendToHost } from '../network/peer.ts';
import { t } from '../i18n/index.ts';
import { addSystemChatMessage, addWhisperMessage, addNoticeChatMessage } from '../ui/chat.ts';
import { containsProfanity } from './profanity.ts';
import type { ConnectedPeer } from '../types/index.ts';

// ─── Types ──────────────────────────────────────────────────────

interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

type Permission = 'host' | 'host+op' | 'all';

interface CommandDef {
  permission: Permission;
  execute: (args: string[], rawArgs: string) => void;
  usage: string;
  description: string;
  hidden?: boolean;       // /help 출력 목록에서 숨김
  hideFromSuggest?: boolean; // 자동완성 드롭다운에서 숨김
}

// ─── Target Resolution ──────────────────────────────────────────

function resolveTarget(arg: string): { peerId: string; label: string } | null {
  if (!arg) return null;
  const peers = getState('network.connectedPeers') as ConnectedPeer[];

  // #번호 방식
  if (arg.startsWith('#')) {
    const order = parseInt(arg.slice(1), 10);
    if (!isNaN(order)) {
      const peer = peers.find(p => p.joinOrder === order);
      if (peer) return { peerId: peer.id, label: peer.label };
    }
    return null;
  }

  // 닉네임 방식 (대소문자 무시)
  const lower = arg.toLowerCase();
  const peer = peers.find(p => p.label.toLowerCase() === lower);
  if (peer) return { peerId: peer.id, label: peer.label };
  return null;
}

// ─── Permission Check ───────────────────────────────────────────

function isHost(): boolean {
  return !getState('network.hostConn');
}

function hasPermission(perm: Permission): boolean {
  if (perm === 'all') return true;
  if (perm === 'host') return isHost();
  if (perm === 'host+op') return isHost() || getState('network.isOperator');
  return false;
}

// ─── Command Implementations ────────────────────────────────────

function cmdKick(args: string[]): void {
  if (!args[0]) { addSystemChatMessage(t('chat.cmd_usage', { usage: '/kick #번호' })); return; }
  const target = resolveTarget(args[0]);
  if (!target) { addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] })); return; }
  bus.emit('network:kick-device', target.peerId);
}

function cmdOp(args: string[]): void {
  if (!args[0]) { addSystemChatMessage(t('chat.cmd_usage', { usage: '/op #번호' })); return; }
  const target = resolveTarget(args[0]);
  if (!target) { addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] })); return; }
  const peers = getState('network.connectedPeers') as ConnectedPeer[];
  const peer = peers.find(p => p.id === target.peerId);
  if (peer?.isOp) { addSystemChatMessage(t('chat.cmd_already_op', { name: target.label })); return; }
  bus.emit('network:toggle-operator', target.peerId);
}

function cmdDeop(args: string[]): void {
  if (!args[0]) { addSystemChatMessage(t('chat.cmd_usage', { usage: '/deop #번호' })); return; }
  const target = resolveTarget(args[0]);
  if (!target) { addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] })); return; }
  const peers = getState('network.connectedPeers') as ConnectedPeer[];
  const peer = peers.find(p => p.id === target.peerId);
  if (!peer?.isOp) { addSystemChatMessage(t('chat.cmd_not_op', { name: target.label })); return; }
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
  bus.emit('network:broadcast', { type: on ? MSG.CHAT_FREEZE : MSG.CHAT_UNFREEZE });
  addSystemChatMessage(on ? t('chat.cmd_frozen') : t('chat.cmd_unfrozen'));
}

function cmdMute(args: string[]): void {
  if (!args[0]) { addSystemChatMessage(t('chat.cmd_usage', { usage: '/mute #번호' })); return; }
  const target = resolveTarget(args[0]);
  if (!target) { addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] })); return; }

  if (isHost()) {
    // Host executes directly
    const current = getState('network.mutedPeers');
    setState('network.mutedPeers', new Set([...current, target.peerId]));
    bus.emit('network:broadcast', { type: MSG.CHAT_MUTE, targetId: target.peerId, targetLabel: target.label });
    addSystemChatMessage(t('chat.cmd_muted', { name: target.label }));
  } else {
    // OP guest sends request to host
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'mute', args });
  }
}

function cmdUnmute(args: string[]): void {
  if (!args[0]) { addSystemChatMessage(t('chat.cmd_usage', { usage: '/unmute #번호' })); return; }
  const target = resolveTarget(args[0]);
  if (!target) { addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] })); return; }

  if (isHost()) {
    const current = getState('network.mutedPeers');
    const next = new Set([...current]);
    next.delete(target.peerId);
    setState('network.mutedPeers', next);
    bus.emit('network:broadcast', { type: MSG.CHAT_UNMUTE, targetId: target.peerId, targetLabel: target.label });
    addSystemChatMessage(t('chat.cmd_unmuted', { name: target.label }));
  } else {
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'unmute', args });
  }
}

function cmdClear(): void {
  if (isHost()) {
    bus.emit('network:broadcast', { type: MSG.CHAT_CLEAR });
    bus.emit('chat:clear-all');
  } else {
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'clear', args: [] });
  }
}

function cmdFilter(args: string[]): void {
  const on = args[0]?.toLowerCase() === 'on';
  const off = args[0]?.toLowerCase() === 'off';
  if (!on && !off) { addSystemChatMessage(t('chat.cmd_usage', { usage: '/filter on|off' })); return; }

  if (isHost()) {
    setState('network.filterEnabled', on);
    const sysText = on ? t('chat.cmd_filter_on') : t('chat.cmd_filter_off');
    bus.emit('network:broadcast', { type: MSG.CHAT_SYSTEM, text: sysText });
    addSystemChatMessage(sysText);
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

  if (isHost()) {
    setState('network.slowmodeSeconds', sec);
    bus.emit('network:broadcast', { type: MSG.CHAT_SLOWMODE, seconds: sec });
    addSystemChatMessage(sec > 0
      ? t('chat.cmd_slowmode_on', { sec })
      : t('chat.cmd_slowmode_off'));
  } else {
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'slowmode', args });
  }
}

function cmdNotice(_: string[], rawArgs: string): void {
  if (!rawArgs.trim()) { addSystemChatMessage(t('chat.cmd_usage', { usage: '/notice 메시지' })); return; }
  const senderLabel = getState('network.myDeviceLabel') || 'HOST';
  const payload = { type: MSG.CHAT_NOTICE, senderLabel, text: rawArgs.trim(), ts: Date.now() };

  if (isHost()) {
    bus.emit('network:broadcast', payload);
    addNoticeChatMessage(senderLabel, rawArgs.trim());
  } else {
    sendToHost({ type: MSG.REQUEST_CHAT_COMMAND, command: 'notice', args: [rawArgs.trim()] });
  }
}

function cmdNick(_: string[], rawArgs: string): void {
  const newName = rawArgs.trim();
  if (!newName) { addSystemChatMessage(t('chat.cmd_usage', { usage: '/nick 새이름' })); return; }
  if (newName.length > 20) { addSystemChatMessage(t('chat.cmd_nick_too_long')); return; }
  const isHostSelf = !getState('network.hostConn');
  if (RESERVED_NAMES.some(r => newName.toLowerCase() === r.toLowerCase())) {
    if (!isHostSelf || !['host', '방장', '호스트'].includes(newName.toLowerCase())) {
      addSystemChatMessage(t('connect.rename_reserved'));
      return;
    }
  }
  if (/^#\d+$/.test(newName)) {
    addSystemChatMessage(t('connect.rename_reserved'));
    return;
  }
  if (containsProfanity(newName)) {
    addSystemChatMessage(t('connect.rename_profanity'));
    return;
  }
  const peers = getState('network.connectedPeers') as ConnectedPeer[];
  if (peers.some(p => p.label.toLowerCase() === newName.toLowerCase())) {
    addSystemChatMessage(t('connect.rename_duplicate'));
    return;
  }
  bus.emit('network:rename-device', newName);
  addSystemChatMessage(t('chat.cmd_nick_changed', { name: newName }));
}

function cmdWhisper(args: string[], rawArgs: string): void {
  if (!args[0]) { addSystemChatMessage(t('chat.cmd_usage', { usage: '/w #번호 메시지' })); return; }
  const target = resolveTarget(args[0]);
  if (!target) { addSystemChatMessage(t('chat.cmd_target_not_found', { target: args[0] })); return; }

  // Extract message (everything after the target identifier)
  const msgStart = rawArgs.indexOf(args[0]) + args[0].length;
  const msg = rawArgs.slice(msgStart).trim();
  if (!msg) { addSystemChatMessage(t('chat.cmd_usage', { usage: '/w #번호 메시지' })); return; }

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

  if (isHost()) {
    // Host sends directly to target
    const connMap = getState('network.activeHostConnByPeerId');
    const conn = connMap.get(target.peerId);
    if (conn) conn.send(payload);
  } else {
    // Guest sends to host, host relays to target
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
    if (def.permission === 'all'
      || (def.permission === 'host' && role === 'host')
      || (def.permission === 'host+op' && (role === 'host' || role === 'op'))) {
      lines.push(`${def.usage} - ${def.description}`);
    }
  }
  addSystemChatMessage(lines.join('\n'));
}

function cmdUsers(): void {
  const peers = getState('network.connectedPeers') as ConnectedPeer[];
  const myLabel = getState('network.myDeviceLabel') || 'HOST';
  const myOrder = getState('network.myJoinOrder') ?? 0;

  const lines: string[] = [t('chat.cmd_users_title')];
  lines.push(`#${myOrder}. ${myLabel} (${t('chat.cmd_users_me')})`);

  for (const p of peers) {
    const flags: string[] = [];
    if (p.isOp) flags.push('OP');
    const suffix = flags.length ? ` [${flags.join(', ')}]` : '';
    lines.push(`#${p.joinOrder}. ${p.label}${suffix}`);
  }

  addSystemChatMessage(lines.join('\n'));
}

// ─── Command Registry ───────────────────────────────────────────

// usage/description use i18n keys, resolved at access time via getAvailableCommands()
const COMMANDS_DEF: Record<string, Omit<CommandDef, 'usage' | 'description'> & { usageKey: string; descKey: string }> = {
  help:     { permission: 'all',     execute: cmdHelp,     usageKey: 'chat.cmd_u_help',     descKey: 'chat.cmd_d_help',     hidden: true },
  users:    { permission: 'all',     execute: cmdUsers,    usageKey: 'chat.cmd_u_users',    descKey: 'chat.cmd_d_users' },
  clear:    { permission: 'host+op', execute: cmdClear,    usageKey: 'chat.cmd_u_clear',    descKey: 'chat.cmd_d_clear' },
  filter:   { permission: 'host+op', execute: cmdFilter,   usageKey: 'chat.cmd_u_filter',   descKey: 'chat.cmd_d_filter' },
  freeze:   { permission: 'host',    execute: cmdFreeze,   usageKey: 'chat.cmd_u_freeze',   descKey: 'chat.cmd_d_freeze' },
  slowmode: { permission: 'host+op', execute: cmdSlowmode, usageKey: 'chat.cmd_u_slowmode', descKey: 'chat.cmd_d_slowmode' },
  w:        { permission: 'all',     execute: cmdWhisper,  usageKey: 'chat.cmd_u_w',        descKey: 'chat.cmd_d_w' },
  notice:   { permission: 'host+op', execute: cmdNotice,   usageKey: 'chat.cmd_u_notice',   descKey: 'chat.cmd_d_notice' },
  nick:     { permission: 'all',     execute: cmdNick,     usageKey: 'chat.cmd_u_nick',     descKey: 'chat.cmd_d_nick' },
  kick:     { permission: 'host',    execute: cmdKick,     usageKey: 'chat.cmd_u_kick',     descKey: 'chat.cmd_d_kick' },
  op:       { permission: 'host',    execute: cmdOp,       usageKey: 'chat.cmd_u_op',       descKey: 'chat.cmd_d_op' },
  deop:     { permission: 'host',    execute: cmdDeop,     usageKey: 'chat.cmd_u_deop',     descKey: 'chat.cmd_d_deop' },
  mute:     { permission: 'host+op', execute: cmdMute,     usageKey: 'chat.cmd_u_mute',     descKey: 'chat.cmd_d_mute' },
  unmute:   { permission: 'host+op', execute: cmdUnmute,   usageKey: 'chat.cmd_u_unmute',   descKey: 'chat.cmd_d_unmute' },
  whisper:  { permission: 'all',     execute: cmdWhisper,  usageKey: 'chat.cmd_u_whisper',  descKey: 'chat.cmd_d_w', hidden: true, hideFromSuggest: true },
};

// Resolve i18n at access time
function _resolveCommand(name: string): CommandDef | undefined {
  const def = COMMANDS_DEF[name];
  if (!def) return undefined;
  return { ...def, usage: t(def.usageKey as Parameters<typeof t>[0]), description: t(def.descKey as Parameters<typeof t>[0]) };
}

// For iteration (help list, autocomplete)
function _allCommandEntries(): [string, CommandDef][] {
  return Object.entries(COMMANDS_DEF).map(([name, def]) => [name, { ...def, usage: t(def.usageKey as Parameters<typeof t>[0]), description: t(def.descKey as Parameters<typeof t>[0]) }]);
}

// ─── Public API ─────────────────────────────────────────────────

export function parseCommand(input: string): ParsedCommand | null {
  if (!input.startsWith('/')) return null;
  const spaceIdx = input.indexOf(' ');
  const name = (spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)).toLowerCase();
  const rawArgs = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1);
  const args = rawArgs ? rawArgs.split(/\s+/) : [];
  return { name, args, rawArgs };
}

export function getAvailableCommands(filter = ''): { name: string; usage: string; description: string }[] {
  const result: { name: string; usage: string; description: string }[] = [];
  const query = filter.toLowerCase();
  for (const [name, def] of _allCommandEntries()) {
    if ((def as unknown as Record<string, unknown>).hideFromSuggest) continue;
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

export function executeCommand(cmd: ParsedCommand): void {
  const def = _resolveCommand(cmd.name);
  if (!def) {
    addSystemChatMessage(t('chat.cmd_unknown', { cmd: cmd.name }));
    return;
  }
  if (!hasPermission(def.permission)) {
    addSystemChatMessage(t('chat.cmd_no_permission'));
    return;
  }
  def.execute(cmd.args, cmd.rawArgs);
}

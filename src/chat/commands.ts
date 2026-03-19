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
  hidden?: boolean;
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

function cmdFreeze(): void {
  setState('network.chatFrozen', true);
  bus.emit('network:broadcast', { type: MSG.CHAT_FREEZE });
  addSystemChatMessage(t('chat.cmd_frozen'));
}

function cmdUnfreeze(): void {
  setState('network.chatFrozen', false);
  bus.emit('network:broadcast', { type: MSG.CHAT_UNFREEZE });
  addSystemChatMessage(t('chat.cmd_unfrozen'));
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
  setState('network.filterEnabled', on);
  addSystemChatMessage(on ? t('chat.cmd_filter_on') : t('chat.cmd_filter_off'));
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

  for (const [name, def] of Object.entries(COMMANDS)) {
    if (def.hidden) continue;
    if (def.permission === 'all'
      || (def.permission === 'host' && role === 'host')
      || (def.permission === 'host+op' && (role === 'host' || role === 'op'))) {
      lines.push(`/${name} — ${def.description}`);
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

const COMMANDS: Record<string, CommandDef> = {
  kick:     { permission: 'host',    execute: cmdKick,     usage: '/kick #번호|이름',          description: '기기 강퇴' },
  op:       { permission: 'host',    execute: cmdOp,       usage: '/op #번호|이름',            description: '관리자 권한 부여' },
  deop:     { permission: 'host',    execute: cmdDeop,     usage: '/deop #번호|이름',           description: '관리자 권한 회수' },
  freeze:   { permission: 'host',    execute: cmdFreeze,   usage: '/freeze',                  description: '채팅 잠금' },
  unfreeze: { permission: 'host',    execute: cmdUnfreeze, usage: '/unfreeze',                 description: '채팅 잠금 해제' },
  mute:     { permission: 'host+op', execute: cmdMute,     usage: '/mute #번호|이름',           description: '채팅 금지' },
  unmute:   { permission: 'host+op', execute: cmdUnmute,   usage: '/unmute #번호|이름',          description: '채팅 금지 해제' },
  clear:    { permission: 'host+op', execute: cmdClear,    usage: '/clear',                   description: '채팅 내역 삭제' },
  filter:   { permission: 'host+op', execute: cmdFilter,   usage: '/filter on|off',           description: '비속어 필터' },
  slowmode: { permission: 'host+op', execute: cmdSlowmode, usage: '/slowmode 초',              description: '슬로우 모드' },
  notice:   { permission: 'host+op', execute: cmdNotice,   usage: '/notice 메시지',             description: '공지 메시지' },
  nick:     { permission: 'all',     execute: cmdNick,     usage: '/nick 새이름',               description: '닉네임 변경' },
  w:        { permission: 'all',     execute: cmdWhisper,  usage: '/w #번호 메시지',             description: '귓속말' },
  whisper:  { permission: 'all',     execute: cmdWhisper,  usage: '/whisper #번호 메시지',       description: '귓속말', hidden: true },
  help:     { permission: 'all',     execute: cmdHelp,     usage: '/help',                    description: '명령어 목록', hidden: true },
  users:    { permission: 'all',     execute: cmdUsers,    usage: '/users',                   description: '접속자 목록' },
};

// ─── Public API ─────────────────────────────────────────────────

export function parseCommand(input: string): ParsedCommand | null {
  if (!input.startsWith('/')) return null;
  const spaceIdx = input.indexOf(' ');
  const name = (spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)).toLowerCase();
  const rawArgs = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1);
  const args = rawArgs ? rawArgs.split(/\s+/) : [];
  return { name, args, rawArgs };
}

export function executeCommand(cmd: ParsedCommand): void {
  const def = COMMANDS[cmd.name];
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

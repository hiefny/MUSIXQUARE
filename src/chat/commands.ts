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
import { showToast } from '../ui/toast.ts';
import { getDetectedBPM, setPartyMode } from '../audio/beat-detector.ts';

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
  hidden?: boolean;       // Hidden from /help output
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
      return { peerId: myId, label: getState('network.myDeviceLabel') || (hostConn ? 'ME' : 'HOST') };
    }

    // Is it someone in the session?
    const target = deviceList.find(d => d.joinOrder === order);
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
  const target = deviceList.find(d => d.label.toLowerCase() === lower);
  if (target && target.id) return { peerId: target.id, label: target.label };

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
  const isHostRestore = isHostSelf && ['host', '방장', '호스트'].includes(newName.toLowerCase());
  if (!isHostRestore && containsProfanity(newName)) {
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
  const deviceList = getState('network.lastKnownDeviceList') || [];
  const myId = getState('network.myId');
  const myOrder = getState('network.myJoinOrder') ?? 0;
  const myLabel = getState('network.myDeviceLabel') || (myOrder === 0 ? 'HOST' : 'ME');

  const lines: string[] = [t('chat.cmd_users_title')];

  // If we don't have a device list yet (early join or host-only), build a fallback list
  let displayList = deviceList;
  if (!displayList || displayList.length === 0) {
    displayList = [{
      id: myId || '',
      label: myLabel || 'ME',
      isHost: myOrder === 0,
      isOp: true, // Self is always authorized for self-view
      joinOrder: myOrder,
      status: 'connected'
    }];
  }

  // Sort and format each user
  const sorted = [...displayList].sort((a, b) => (a.joinOrder ?? 0) - (b.joinOrder ?? 0));

  for (const d of sorted) {
    const isMe = d.id === myId;
    const flags: string[] = [];
    if (d.isHost) flags.push('HOST');
    if (d.isOp && !d.isHost) flags.push('OP');
    if (isMe) flags.push(t('chat.cmd_users_me'));

    const suffix = flags.length ? ` [${flags.join(', ')}]` : '';
    lines.push(`#${d.joinOrder}. ${d.label}${suffix}`);
  }

  addSystemChatMessage(lines.join('\n'));
}

function _parseBrowser(ua: string): string {
  // Order matters: check specific browsers before generic ones
  if (/SamsungBrowser\/([\d.]+)/.test(ua)) return `Samsung Internet ${RegExp.$1}`;
  if (/OPR\/([\d.]+)/.test(ua) || /Opera\/([\d.]+)/.test(ua)) return `Opera ${RegExp.$1}`;
  if (/Edg\/([\d.]+)/.test(ua)) return `Microsoft Edge ${RegExp.$1}`;
  if (/Whale\/([\d.]+)/.test(ua)) return `Naver Whale ${RegExp.$1}`;
  if (/Firefox\/([\d.]+)/.test(ua)) return `Firefox ${RegExp.$1}`;
  if (/CriOS\/([\d.]+)/.test(ua)) return `Chrome iOS ${RegExp.$1}`;
  if (/FxiOS\/([\d.]+)/.test(ua)) return `Firefox iOS ${RegExp.$1}`;
  if (/Version\/([\d.]+).*Safari/.test(ua)) return `Safari ${RegExp.$1}`;
  if (/Chrome\/([\d.]+)/.test(ua)) return `Chrome ${RegExp.$1}`;
  return ua.slice(0, 50);
}

function _parseOS(ua: string): string {
  if (/iPhone OS ([\d_]+)/.test(ua)) return `iOS ${RegExp.$1.replace(/_/g, '.')}`;
  if (/iPad.*OS ([\d_]+)/.test(ua)) return `iPadOS ${RegExp.$1.replace(/_/g, '.')}`;
  if (/Mac OS X ([\d_.]+)/.test(ua)) return `macOS ${RegExp.$1.replace(/_/g, '.')}`;
  if (/Android ([\d.]+)/.test(ua)) return `Android ${RegExp.$1}`;
  if (/Windows NT ([\d.]+)/.test(ua)) {
    const ver: Record<string, string> = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
    return `Windows ${ver[RegExp.$1] || RegExp.$1}`;
  }
  if (/CrOS/.test(ua)) return 'Chrome OS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

function cmdDebug(): void {
  const lines: string[] = ['SYSTEM DEBUG INFO'];

  // Device & Browser
  const ua = navigator.userAgent;
  const browser = _parseBrowser(ua);
  const os = _parseOS(ua);
  const lang = navigator.language;
  const screen = `${window.screen.width}×${window.screen.height}`;
  const viewport = `${window.innerWidth}×${window.innerHeight}`;
  const dpr = window.devicePixelRatio?.toFixed(1) || '?';
  const touch = 'ontouchstart' in window ? 'yes' : 'no';
  const standalone = (window.matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as Record<string, unknown>).standalone) ? 'yes' : 'no';
  lines.push(`[Browser] ${browser}`);
  lines.push(`[OS] ${os}`);
  lines.push(`[Screen] ${screen} (${viewport}) @${dpr}x | touch:${touch} | PWA:${standalone}`);
  lines.push(`[Lang] ${lang}`);

  // Network
  const connType = getState('network.connectionType') || 'unknown';
  const sessionCode = getState('network.sessionCode') || '-';
  const myId = getState('network.myId') || '-';
  const myOrder = getState('network.myJoinOrder') ?? 0;
  const myLabel = getState('network.myDeviceLabel') || '-';
  const peers = getState('network.connectedPeers') as ConnectedPeer[];
  const isOp = getState('network.isOperator') ? 'yes' : 'no';
  lines.push(`[Network] #${myOrder} ${myLabel} | code:${sessionCode} | conn:${connType} | OP:${isOp}`);
  lines.push(`[PeerID] ${myId}`);
  lines.push(`[Peers] ${peers.length} connected`);
  for (const p of peers) {
    const flags = [p.isOp ? 'OP' : '', (p as unknown as Record<string, unknown>).connectionType || ''].filter(Boolean).join(',');
    lines.push(`  #${p.joinOrder} ${p.label} [${flags}]`);
  }

  // Chat moderation
  const frozen = getState('network.chatFrozen') ? 'ON' : 'off';
  const slowmode = getState('network.slowmodeSeconds');
  const filter = getState('network.filterEnabled') ? 'ON' : 'off';
  const mutedCount = getState('network.mutedPeers').size;
  lines.push(`[Chat] freeze:${frozen} | slowmode:${slowmode}s | filter:${filter} | muted:${mutedCount}`);

  // Audio
  const appState = getState('appState') || 'IDLE';
  const channelMode = getState('audio.channelMode') ?? 0;
  const channelNames: Record<number, string> = { 0: 'Center', '-1': 'Left', 1: 'Right', 2: 'Subwoofer' };
  const chName = channelNames[channelMode] || String(channelMode);
  const reverbMix = getState('audio.reverbMix') ?? 0;
  const eqValues = getState('audio.eqValues') || [];
  const eqActive = Array.isArray(eqValues) && eqValues.some((v: number) => v !== 0);
  const vbass = getState('audio.virtualBass') ?? 0;
  const volume = getState('audio.masterVolume') ?? 1;
  lines.push(`[Audio] state:${appState} | ch:${chName} | vol:${Math.round(volume * 100)}%`);
  lines.push(`[FX] EQ:${eqActive ? 'ON' : 'off'} | reverb:${reverbMix > 0 ? `${Math.round(reverbMix * 100)}%` : 'off'} | vbass:${vbass > 0 ? 'ON' : 'off'}`);

  // Try to get AudioContext info
  try {
    const ctx = (window as unknown as Record<string, unknown>).__mxqr_audio_ctx as AudioContext | undefined;
    if (ctx) {
      lines.push(`[AudioCtx] sr:${ctx.sampleRate}Hz | state:${ctx.state} | time:${ctx.currentTime.toFixed(1)}s`);
    }
  } catch { /* ignore */ }

  // Playlist
  const trackIdx = getState('playlist.currentTrackIndex') ?? -1;
  const playlist = getState('playlist.items') || [];
  const currentTitle = trackIdx >= 0 && playlist[trackIdx]
    ? (playlist[trackIdx] as unknown as Record<string, unknown>).title || 'untitled'
    : '-';
  lines.push(`[Playlist] ${playlist.length} tracks | current:#${trackIdx} ${currentTitle}`);

  // Session timing
  const sessionStarted = getState('setup.sessionStarted');
  lines.push(`[Session] started:${sessionStarted ? 'yes' : 'no'}`);

  // Memory (if available)
  try {
    const perf = performance as unknown as Record<string, unknown>;
    const mem = perf.memory as { usedJSHeapSize: number; jsHeapSizeLimit: number } | undefined;
    if (mem) {
      const used = (mem.usedJSHeapSize / 1048576).toFixed(1);
      const limit = (mem.jsHeapSizeLimit / 1048576).toFixed(0);
      lines.push(`[Memory] ${used}MB / ${limit}MB`);
    }
  } catch { /* ignore */ }

  // Network info (if available)
  try {
    const conn = (navigator as unknown as Record<string, unknown>).connection as Record<string, unknown> | undefined;
    if (conn) {
      lines.push(`[NetInfo] type:${conn.effectiveType || '?'} | downlink:${conn.downlink || '?'}Mbps | rtt:${conn.rtt || '?'}ms`);
    }
  } catch { /* ignore */ }

  const debugText = lines.join('\n');
  addSystemChatMessage(debugText);

  // Auto-copy to clipboard
  try {
    navigator.clipboard.writeText(debugText).then(() => {
      showToast(t('chat.debug_copied'));
    }).catch(() => { /* clipboard not available */ });
  } catch { /* ignore */ }
}

function cmdParty(args: string[]): void {
  const flag = args[0]?.toLowerCase();
  if (flag !== 'on' && flag !== 'off') {
    addSystemChatMessage('/party on|off');
    return;
  }
  const on = flag === 'on';
  setPartyMode(on);

  if (on) {
    const bpm = getDetectedBPM();
    addSystemChatMessage(bpm > 0
      ? `🎉 Party mode ON — ${bpm} BPM`
      : '🎉 Party mode ON — BPM detecting...');
  } else {
    addSystemChatMessage('Party mode OFF');
  }
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
  debug:    { permission: 'all',     execute: cmdDebug,    usageKey: 'chat.cmd_u_debug',    descKey: 'chat.cmd_d_debug' },
  party:    { permission: 'all',     execute: cmdParty,    usageKey: 'chat.cmd_u_party',    descKey: 'chat.cmd_d_party',    hidden: true, hideFromSuggest: true },
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

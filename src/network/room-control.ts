/**
 * MUSIXQUARE — Room Control Plane
 *
 * Owns participant-removal requests and delegated chat administration for the
 * browser-hosted room transport. Clock synchronization deliberately does not
 * import or mutate these authority surfaces.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, MAX_MSG_LENGTH, MAX_SENDER_LABEL_LENGTH } from '../core/constants.ts';
import type { DataConnection } from '../types/index.ts';
import { registerHandlers } from './protocol.ts';
import { broadcast } from './peer.ts';
import { rememberPinnedNotice } from '../chat/protocol.ts';
import { playAnnouncementSound } from '../audio/ui-sounds.ts';
import { getRoomContext, verifyPeerCapability } from '../rooms/authority.ts';

type RequestedKickScope = 'member' | 'physical';

export function resolveRequestedKickTarget(
  data: Record<string, unknown>,
  conn: DataConnection,
  scope: RequestedKickScope,
): string | null {
  const room = getRoomContext();
  if (getState('network.hostConn') || getState('network.appRole') !== 'host') return null;
  if (room.kind === 'pro') {
    if (
      room.role !== 'coordinator' ||
      !room.coordinatorId ||
      room.epoch < 1 ||
      !room.capabilities.includes('members.manage') ||
      room.roomId !== getState('network.sessionCode')
    ) {
      return null;
    }
  }

  const senderId = conn?.peer;
  if (!senderId || !conn.open || !verifyPeerCapability(conn, 'members.manage')) return null;

  const peers = getState('network.connectedPeers');
  const activeConnections = getState('network.activeHostConnByPeerId');
  const sender = peers.find(
    (peer) =>
      peer.id === senderId &&
      peer.conn === conn &&
      peer.status === 'connected' &&
      activeConnections.get(senderId) === conn,
  );
  if (!sender) return null;

  const targetPeerId = data.targetPeerId as string;
  const coordinatorTransportId = getState('network.myId');
  if (
    targetPeerId === senderId ||
    targetPeerId === coordinatorTransportId ||
    targetPeerId === room.coordinatorId
  ) {
    return null;
  }

  const target = peers.find((peer) => peer.id === targetPeerId);
  const targetConnection = target?.conn as DataConnection | null | undefined;
  if (
    !target ||
    target.status !== 'connected' ||
    !targetConnection?.open ||
    activeConnections.get(targetPeerId) !== targetConnection
  ) {
    return null;
  }

  if (room.kind === 'standard') {
    const sameClaimedMember =
      typeof sender.memberId === 'string' &&
      sender.memberId.length > 0 &&
      sender.memberId === target.memberId;
    const sameAuthenticatedMember =
      sameClaimedMember && sender.isAuthenticated === true && target.isAuthenticated === true;

    if (scope === 'member') {
      // Member-wide removal also revokes account authority, so it must never
      // target the caller's own account or another administrator.
      if (target.isOp || sameClaimedMember) return null;
    } else {
      // Exact removal may disconnect a verified sibling connection while
      // preserving the shared account grant. Unverified identity collisions
      // fail closed, and administrators from other accounts remain protected.
      if (
        (sameClaimedMember && !sameAuthenticatedMember) ||
        (target.isOp && !sameAuthenticatedMember)
      ) {
        return null;
      }
    }
  }

  return targetPeerId;
}

export function handleRequestKickDevice(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  const targetPeerId = resolveRequestedKickTarget(data, conn, 'member');
  if (!targetPeerId) return;

  // The established member-level path expands authenticated targets to every
  // sibling connection and revokes account-level administrator authority.
  bus.emit('network:kick-device', targetPeerId);
}

export function handleRequestKickPhysicalDevice(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  // PRO removals are server-authoritative (`/presence/kick`). Never let a
  // peer frame bypass the Worker’s owner/administrator protections and turn
  // the coordinator transport into an alternate exact-kick endpoint.
  if (getRoomContext().kind !== 'standard') return;
  const targetPeerId = resolveRequestedKickTarget(data, conn, 'physical');
  if (!targetPeerId) return;

  // Exact connection removal deliberately preserves sibling devices and the
  // member's account-level administrator grant.
  bus.emit('network:kick-physical-device', targetPeerId);
}

export function resolveChatTargetForHost(
  arg: string,
): { peerId: string; label: string } | null {
  const peers = getState('network.connectedPeers');
  if (arg.startsWith('#')) {
    const order = parseInt(arg.slice(1), 10);
    if (!Number.isNaN(order)) {
      const peer = peers.find((candidate) => candidate.joinOrder === order);
      if (peer) return { peerId: peer.id, label: peer.label };
    }
    return null;
  }

  const lower = arg.toLowerCase();
  const peer = peers.find((candidate) => candidate.label.toLowerCase() === lower);
  return peer ? { peerId: peer.id, label: peer.label } : null;
}

export function handleRequestChatCommand(
  data: Record<string, unknown>,
  conn: DataConnection,
): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only the browser-host coordinator processes this path.

  const peerId = conn?.peer;
  if (!peerId) return;

  const peers = getState('network.connectedPeers');
  const peer = peers.find((candidate) => candidate.id === peerId && candidate.conn === conn);
  if (!peer) return;

  const command = data.command as string;
  const args = (data.args as string[]) || [];
  if (getRoomContext().kind === 'standard') {
    const capability = command === 'notice' ? 'chat.notice' : 'room.configure';
    if (!verifyPeerCapability(conn, capability)) return;
  } else if (!peer.isOp) {
    return;
  }

  switch (command) {
    case 'freeze': {
      const flag = args[0]?.toLowerCase();
      if (flag !== 'on' && flag !== 'off') return;
      const on = flag === 'on';
      setState('network.chatFrozen', on);
      broadcast({ type: on ? MSG.CHAT_FREEZE : MSG.CHAT_UNFREEZE });
      bus.emit('chat:system-message', on ? t('chat.cmd_frozen') : t('chat.cmd_unfrozen'));
      break;
    }
    case 'mute': {
      const targetArg = args[0];
      if (!targetArg) return;
      const target = resolveChatTargetForHost(targetArg);
      if (!target) return;
      const current = getState('network.mutedPeers');
      setState('network.mutedPeers', new Set([...current, target.peerId]));
      broadcast({ type: MSG.CHAT_MUTE, targetId: target.peerId, targetLabel: target.label });
      bus.emit('chat:system-message', t('chat.cmd_muted', { name: target.label }));
      break;
    }
    case 'unmute': {
      const targetArg = args[0];
      if (!targetArg) return;
      const target = resolveChatTargetForHost(targetArg);
      if (!target) return;
      const current = getState('network.mutedPeers');
      const next = new Set([...current]);
      next.delete(target.peerId);
      setState('network.mutedPeers', next);
      broadcast({ type: MSG.CHAT_UNMUTE, targetId: target.peerId, targetLabel: target.label });
      bus.emit('chat:system-message', t('chat.cmd_unmuted', { name: target.label }));
      break;
    }
    case 'clear':
      broadcast({ type: MSG.CHAT_CLEAR });
      bus.emit('chat:clear-all');
      break;
    case 'slowmode': {
      const seconds = parseInt(args[0] || '0', 10);
      if (Number.isNaN(seconds) || seconds < 0 || seconds > 60) return;
      setState('network.slowmodeSeconds', seconds);
      broadcast({ type: MSG.CHAT_SLOWMODE, seconds });
      bus.emit(
        'chat:system-message',
        seconds > 0
          ? t('chat.cmd_slowmode_on', { sec: seconds })
          : t('chat.cmd_slowmode_off'),
      );
      break;
    }
    case 'filter': {
      const on = args[0]?.toLowerCase() === 'on';
      setState('network.filterEnabled', on);
      broadcast({ type: MSG.CHAT_FILTER, on });
      bus.emit('chat:system-message', on ? t('chat.cmd_filter_on') : t('chat.cmd_filter_off'));
      break;
    }
    case 'notice': {
      // Cap length before broadcast so an operator cannot amplify an unbounded
      // argument to every connected participant.
      const text = args.join(' ').trim().slice(0, MAX_MSG_LENGTH);
      if (!text) return;
      const peerLabel = (peer.label || 'OP').substring(0, MAX_SENDER_LABEL_LENGTH);
      const noticePayload = {
        type: MSG.CHAT_NOTICE,
        senderLabel: peerLabel,
        text,
        ts: Date.now(),
        attention: true,
      };
      rememberPinnedNotice(noticePayload);
      broadcast(noticePayload);
      bus.emit('chat:notice-message', peerLabel, text, noticePayload.ts);
      playAnnouncementSound();
      break;
    }
    default:
      log.warn(`[RoomControl] Unknown chat command from operator: ${command}`);
  }
}

export function initRoomControl(): void {
  registerHandlers({
    [MSG.REQUEST_KICK_DEVICE]: handleRequestKickDevice,
    [MSG.REQUEST_KICK_PHYSICAL_DEVICE]: handleRequestKickPhysicalDevice,
    [MSG.REQUEST_CHAT_COMMAND]: handleRequestChatCommand,
  });

  log.info('[RoomControl] Handlers registered');
}

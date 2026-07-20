import { getState, setState } from '../core/state.ts';
import type {
  ConnectedPeer,
  RoomCapability,
  StandardRoomAdministrator,
  StandardRoomPermissionSet,
} from '../types/index.ts';

export const STANDARD_ROOM_FULL_PERMISSIONS: Readonly<StandardRoomPermissionSet> = Object.freeze({
  'media.add': true,
  'playback.control': true,
  'members.kick': true,
  'chat.notice': true,
});

/**
 * Product controls that another verified device of the ordinary-room host's
 * account may route back through the physical host.
 *
 * This deliberately excludes `system-audio.publish` and
 * `coordinator.eligible`: those are physical transport roles, not
 * person-level product authority. The room PIN and administrator directory
 * also remain physical-host-owned even though `room.configure` is projected;
 * the latter is used only by established request/response paths such as queue
 * mode and chat-room controls.
 */
export const STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES: readonly RoomCapability[] = Object.freeze([
  'media.add',
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'members.manage',
  'chat.notice',
  'room.configure',
]);

function normalizeStandardRoomPermissions(
  permissions: StandardRoomPermissionSet,
): StandardRoomPermissionSet {
  return {
    'media.add': permissions['media.add'] === true,
    'playback.control': permissions['playback.control'] === true,
    'members.kick': permissions['members.kick'] === true,
    'chat.notice': permissions['chat.notice'] === true,
  };
}

export function standardRoomAuthorityKey(
  peer: Pick<ConnectedPeer, 'id' | 'memberId' | 'isAuthenticated'>,
): string {
  return peer.isAuthenticated && peer.memberId ? peer.memberId : `peer:${peer.id}`;
}

export function standardRoomCapabilities(permissions: StandardRoomPermissionSet): RoomCapability[] {
  const capabilities: RoomCapability[] = [];
  if (permissions['media.add']) capabilities.push('media.add', 'asset.upload');
  if (permissions['playback.control']) capabilities.push('playback.control');
  if (permissions['members.kick']) capabilities.push('members.manage');
  if (permissions['chat.notice']) capabilities.push('chat.notice');
  return capabilities;
}

export function getStandardRoomAdministratorByKey(key: string): StandardRoomAdministrator | null {
  return getState('network.standardRoomAdministrators').get(key) ?? null;
}

export function grantStandardRoomAdministrator(
  peer: Pick<
    ConnectedPeer,
    'id' | 'label' | 'joinOrder' | 'memberId' | 'memberDisplayNumber' | 'isAuthenticated'
  >,
  permissions: StandardRoomPermissionSet = { ...STANDARD_ROOM_FULL_PERMISSIONS },
): StandardRoomAdministrator {
  const administrator: StandardRoomAdministrator = {
    memberId: peer.memberId ?? `peer:${peer.id}`,
    memberDisplayNumber: peer.memberDisplayNumber ?? peer.joinOrder,
    isAuthenticated: peer.isAuthenticated === true,
    displayName: peer.label,
    permissions: normalizeStandardRoomPermissions(permissions),
  };
  const next = new Map(getState('network.standardRoomAdministrators'));
  next.set(standardRoomAuthorityKey(peer), administrator);
  setState('network.standardRoomAdministrators', next);
  return administrator;
}

function revokeStandardRoomAdministrator(
  peer: Pick<ConnectedPeer, 'id' | 'memberId' | 'isAuthenticated'>,
): void {
  const next = new Map(getState('network.standardRoomAdministrators'));
  next.delete(standardRoomAuthorityKey(peer));
  setState('network.standardRoomAdministrators', next);
}

export function revokeStandardRoomAdministratorByKey(key: string): void {
  const next = new Map(getState('network.standardRoomAdministrators'));
  next.delete(key);
  setState('network.standardRoomAdministrators', next);
}

export function updateStandardRoomAdministratorPermissions(
  key: string,
  permissions: StandardRoomPermissionSet,
): boolean {
  const current = getState('network.standardRoomAdministrators').get(key);
  if (!current) return false;
  const next = new Map(getState('network.standardRoomAdministrators'));
  next.set(key, {
    ...current,
    permissions: normalizeStandardRoomPermissions(permissions),
  });
  setState('network.standardRoomAdministrators', next);
  return true;
}

export function removeDepartedAnonymousAdministrator(peer: ConnectedPeer): void {
  if (peer.isAuthenticated && peer.memberId) return;
  revokeStandardRoomAdministrator(peer);
}

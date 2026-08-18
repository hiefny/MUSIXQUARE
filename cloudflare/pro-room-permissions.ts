import { hasExactKeys } from './pro-room-validation.ts';

export type ProRoomPermission = 'media.add' | 'playback.control' | 'members.kick' | 'chat.notice';

export type ProRoomPermissionSet = Record<ProRoomPermission, boolean>;

export type ProRoomCapability =
  | 'queue.mutate'
  | 'playback.control'
  | 'effects.control'
  | 'asset.upload'
  | 'members.manage'
  | 'room.configure';

export type ProRoomRole = 'owner' | 'controller' | 'member';

/**
 * Pure PRO-room permission and capability projections.
 *
 * Keep this module free of Durable Object, request, and storage access. The
 * Worker owns authentication and persistence; this leaf owns only the stable
 * v1 permission schema and its role/capability projection.
 */

const CONTROLLER_CAPABILITIES: readonly ProRoomCapability[] = Object.freeze([
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'members.manage',
]);
const MEMBER_CAPABILITIES: readonly ProRoomCapability[] = Object.freeze([]);
const OWNER_CAPABILITIES: readonly ProRoomCapability[] = Object.freeze([
  ...CONTROLLER_CAPABILITIES,
  'room.configure',
]);

export const PRO_ROOM_PERMISSION_KEYS: readonly ProRoomPermission[] = Object.freeze([
  'media.add',
  'playback.control',
  'members.kick',
  'chat.notice',
]);

const PRO_INTERNAL_AUTHORITY_PERMISSIONS: ReadonlySet<string> = new Set([
  ...PRO_ROOM_PERMISSION_KEYS,
  'room.configure',
  'chat.manage',
  'bot.result',
  'system.broadcast',
  'system-audio.signal',
]);

const PRO_SYSTEM_MESSAGE_PERMISSION: ReadonlyMap<string, string> = new Map([
  ['chat.decode_skip_system_message', 'playback.control'],
  ['chat.system_audio_started_system_message', 'room.configure'],
  ['chat.system_audio_stopped_system_message', 'room.configure'],
]);

export const MEMBER_PERMISSIONS: Readonly<ProRoomPermissionSet> = Object.freeze({
  'media.add': false,
  'playback.control': false,
  'members.kick': false,
  'chat.notice': false,
});

export const DELEGATED_ADMIN_PERMISSIONS: Readonly<ProRoomPermissionSet> = Object.freeze({
  'media.add': true,
  'playback.control': true,
  'members.kick': true,
  'chat.notice': true,
});

export const OWNER_PERMISSIONS: Readonly<ProRoomPermissionSet> = DELEGATED_ADMIN_PERMISSIONS;

export function clonePermissionSet(
  permissions: Readonly<ProRoomPermissionSet>,
): ProRoomPermissionSet {
  return {
    'media.add': permissions['media.add'] === true,
    'playback.control': permissions['playback.control'] === true,
    'members.kick': permissions['members.kick'] === true,
    'chat.notice': permissions['chat.notice'] === true,
  };
}

function isPermissionSet(value: Record<string, unknown>): value is ProRoomPermissionSet {
  return PRO_ROOM_PERMISSION_KEYS.every((key) => typeof value[key] === 'boolean');
}

export function normalizePermissionSet(
  value: unknown,
  fallback: Readonly<ProRoomPermissionSet> | null = null,
): ProRoomPermissionSet | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback ? clonePermissionSet(fallback) : null;
  }
  if (!hasExactKeys(value, PRO_ROOM_PERMISSION_KEYS)) return null;
  if (!isPermissionSet(value)) return null;
  return clonePermissionSet(value);
}

export function isProInternalAuthorityPermission(permission: string): boolean {
  return PRO_INTERNAL_AUTHORITY_PERMISSIONS.has(permission);
}

export function requiredProSystemMessagePermission(i18nKey: string): string | null {
  return PRO_SYSTEM_MESSAGE_PERMISSION.get(i18nKey) ?? null;
}

export function capabilitiesFromPermissions(
  role: ProRoomRole,
  permissions: Readonly<ProRoomPermissionSet>,
): ProRoomCapability[] {
  if (role === 'owner') return [...OWNER_CAPABILITIES];
  if (role === 'member') return [...MEMBER_CAPABILITIES];

  // `media.add` is the stable v1 wire/storage key for media management.
  // Project queue.mutate for add, remove, and reorder while retaining the
  // existing key across rolling clients. Playback remains independently
  // delegated.
  const effective: ProRoomCapability[] = permissions['media.add']
    ? ['effects.control', 'queue.mutate']
    : ['effects.control'];
  if (permissions['playback.control']) effective.push('playback.control');
  if (permissions['media.add']) effective.push('asset.upload');
  if (permissions['members.kick']) effective.push('members.manage');
  return effective;
}

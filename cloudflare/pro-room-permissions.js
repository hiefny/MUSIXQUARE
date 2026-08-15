import { hasExactKeys } from './pro-room-validation.js';

/**
 * Pure PRO-room permission and capability projections.
 *
 * Keep this module free of Durable Object, request, and storage access. The
 * Worker owns authentication and persistence; this leaf owns only the stable
 * v1 permission schema and its role/capability projection.
 */

const CONTROLLER_CAPABILITIES = Object.freeze([
  'queue.mutate',
  'playback.control',
  'effects.control',
  'asset.upload',
  'members.manage',
]);
const MEMBER_CAPABILITIES = Object.freeze([]);
const OWNER_CAPABILITIES = Object.freeze([...CONTROLLER_CAPABILITIES, 'room.configure']);

export const PRO_ROOM_PERMISSION_KEYS = Object.freeze([
  'media.add',
  'playback.control',
  'members.kick',
  'chat.notice',
]);

const PRO_INTERNAL_AUTHORITY_PERMISSIONS = new Set([
  ...PRO_ROOM_PERMISSION_KEYS,
  'room.configure',
  'chat.manage',
  'bot.result',
  'system.broadcast',
]);

const PRO_SYSTEM_MESSAGE_PERMISSION = new Map([
  ['chat.decode_skip_system_message', 'playback.control'],
  ['chat.system_audio_started_system_message', 'room.configure'],
  ['chat.system_audio_stopped_system_message', 'room.configure'],
]);

export const MEMBER_PERMISSIONS = Object.freeze({
  'media.add': false,
  'playback.control': false,
  'members.kick': false,
  'chat.notice': false,
});

export const DELEGATED_ADMIN_PERMISSIONS = Object.freeze({
  'media.add': true,
  'playback.control': true,
  'members.kick': true,
  'chat.notice': true,
});

export const OWNER_PERMISSIONS = DELEGATED_ADMIN_PERMISSIONS;

export function clonePermissionSet(permissions) {
  return Object.fromEntries(
    PRO_ROOM_PERMISSION_KEYS.map((key) => [key, permissions[key] === true]),
  );
}

export function normalizePermissionSet(value, fallback = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback ? clonePermissionSet(fallback) : null;
  }
  if (!hasExactKeys(value, PRO_ROOM_PERMISSION_KEYS)) return null;
  if (PRO_ROOM_PERMISSION_KEYS.some((key) => typeof value[key] !== 'boolean')) return null;
  return clonePermissionSet(value);
}

export function isProInternalAuthorityPermission(permission) {
  return PRO_INTERNAL_AUTHORITY_PERMISSIONS.has(permission);
}

export function requiredProSystemMessagePermission(i18nKey) {
  return PRO_SYSTEM_MESSAGE_PERMISSION.get(i18nKey) ?? null;
}

export function capabilitiesFromPermissions(role, permissions) {
  if (role === 'owner') return [...OWNER_CAPABILITIES];
  if (role === 'member') return [...MEMBER_CAPABILITIES];

  // `media.add` is the stable v1 wire/storage key for media management.
  // Project queue.mutate for add, remove, and reorder while retaining the
  // existing key across rolling clients. Playback remains independently
  // delegated.
  const effective = permissions['media.add']
    ? ['effects.control', 'queue.mutate']
    : ['effects.control'];
  if (permissions['playback.control']) effective.push('playback.control');
  if (permissions['media.add']) effective.push('asset.upload');
  if (permissions['members.kick']) effective.push('members.manage');
  return effective;
}

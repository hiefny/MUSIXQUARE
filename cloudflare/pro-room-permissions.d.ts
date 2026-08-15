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

export const PRO_ROOM_PERMISSION_KEYS: readonly ProRoomPermission[];
export const MEMBER_PERMISSIONS: Readonly<ProRoomPermissionSet>;
export const DELEGATED_ADMIN_PERMISSIONS: Readonly<ProRoomPermissionSet>;
export const OWNER_PERMISSIONS: Readonly<ProRoomPermissionSet>;

export function clonePermissionSet(
  permissions: Readonly<ProRoomPermissionSet>,
): ProRoomPermissionSet;

export function normalizePermissionSet(
  value: unknown,
  fallback?: Readonly<ProRoomPermissionSet> | null,
): ProRoomPermissionSet | null;

export function isProInternalAuthorityPermission(permission: string): boolean;

export function requiredProSystemMessagePermission(i18nKey: string): string | null;

export function capabilitiesFromPermissions(
  role: ProRoomRole,
  permissions: Readonly<ProRoomPermissionSet>,
): ProRoomCapability[];

import { describe, expect, it } from 'vitest';

import {
  capabilitiesFromPermissions,
  clonePermissionSet,
  DELEGATED_ADMIN_PERMISSIONS,
  isProInternalAuthorityPermission,
  MEMBER_PERMISSIONS,
  normalizePermissionSet,
  OWNER_PERMISSIONS,
  PRO_ROOM_PERMISSION_KEYS,
  requiredProSystemMessagePermission,
} from '../../../cloudflare/pro-room-permissions.ts';

describe('PRO room permission projection', () => {
  it('keeps owner, member, and delegated controller capabilities distinct', () => {
    expect(capabilitiesFromPermissions('owner', OWNER_PERMISSIONS)).toEqual([
      'queue.mutate',
      'playback.control',
      'effects.control',
      'asset.upload',
      'members.manage',
      'room.configure',
    ]);
    expect(capabilitiesFromPermissions('member', MEMBER_PERMISSIONS)).toEqual([]);
    expect(
      capabilitiesFromPermissions('controller', {
        ...MEMBER_PERMISSIONS,
        'media.add': true,
        'members.kick': true,
      }),
    ).toEqual(['effects.control', 'queue.mutate', 'asset.upload', 'members.manage']);
  });

  it('normalizes only the exact v1 boolean permission schema', () => {
    expect(PRO_ROOM_PERMISSION_KEYS).toEqual([
      'media.add',
      'playback.control',
      'members.kick',
      'chat.notice',
    ]);
    expect(normalizePermissionSet(DELEGATED_ADMIN_PERMISSIONS)).toEqual(
      DELEGATED_ADMIN_PERMISSIONS,
    );
    expect(normalizePermissionSet({ ...MEMBER_PERMISSIONS, extra: true })).toBeNull();
    expect(normalizePermissionSet({ ...MEMBER_PERMISSIONS, 'media.add': 'yes' })).toBeNull();
    expect(normalizePermissionSet(null, MEMBER_PERMISSIONS)).toEqual(MEMBER_PERMISSIONS);
  });

  it('pins internal authority and system-message permission lookups', () => {
    expect(isProInternalAuthorityPermission('room.configure')).toBe(true);
    expect(isProInternalAuthorityPermission('system.broadcast')).toBe(true);
    expect(isProInternalAuthorityPermission('system-audio.signal')).toBe(true);
    expect(isProInternalAuthorityPermission('unknown.permission')).toBe(false);
    expect(requiredProSystemMessagePermission('chat.decode_skip_system_message')).toBe(
      'playback.control',
    );
    expect(requiredProSystemMessagePermission('chat.system_audio_started_system_message')).toBe(
      'room.configure',
    );
    expect(requiredProSystemMessagePermission('unknown.message')).toBeNull();
  });

  it('returns independent mutable projections from frozen defaults', () => {
    const first = clonePermissionSet(OWNER_PERMISSIONS);
    const second = clonePermissionSet(OWNER_PERMISSIONS);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first['media.add'] = false;
    expect(second['media.add']).toBe(true);
  });
});

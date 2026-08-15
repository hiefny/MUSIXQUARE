import { describe, expect, it } from 'vitest';
import {
  cloneProRoomAdministrators,
  reconcileProRoomAdministratorDirectory,
} from '../administrator-directory.ts';
import type { ProRoomAdministrator } from '../contracts.ts';

function administrator(overrides: Partial<ProRoomAdministrator> = {}): ProRoomAdministrator {
  return {
    memberId: 'member_0000000001',
    memberDisplayNumber: 1,
    isAuthenticated: true,
    displayName: 'Owner',
    role: 'owner',
    permissions: {
      'media.add': true,
      'playback.control': true,
      'members.kick': true,
      'chat.notice': true,
    },
    inheritedPermissions: ['media.add', 'playback.control'],
    onlineDeviceCount: 1,
    ...overrides,
  };
}

describe('PRO administrator directory policy', () => {
  it('deep-clones mutable permission projections', () => {
    const source = administrator();
    const [clone] = cloneProRoomAdministrators([source]);

    expect(clone).toEqual(source);
    expect(clone).not.toBe(source);
    expect(clone!.permissions).not.toBe(source.permissions);
    expect(clone!.inheritedPermissions).not.toBe(source.inheritedPermissions);
  });

  it('treats inherited permission order as irrelevant but directory order as authoritative', () => {
    const owner = administrator();
    const reorderedPermissions = administrator({
      inheritedPermissions: ['playback.control', 'media.add'],
    });
    const controller = administrator({
      memberId: 'member_0000000002',
      memberDisplayNumber: 2,
      displayName: 'Controller',
      role: 'controller',
    });

    expect(reconcileProRoomAdministratorDirectory([owner], [reorderedPermissions]).changed).toBe(
      false,
    );
    expect(
      reconcileProRoomAdministratorDirectory([owner, controller], [controller, owner]).changed,
    ).toBe(true);
  });

  it('suppresses unchanged publication while returning a detached projection', () => {
    const current = [administrator()];
    const result = reconcileProRoomAdministratorDirectory(
      current,
      cloneProRoomAdministrators(current),
    );

    expect(result.changed).toBe(false);
    result.projection[0]!.permissions['media.add'] = false;
    expect(current[0]!.permissions['media.add']).toBe(true);
  });

  it('separates retained state from both incoming data and published projections', () => {
    const incoming = [administrator({ displayName: 'Renamed' })];
    const result = reconcileProRoomAdministratorDirectory([], incoming);
    expect(result.changed).toBe(true);
    if (!result.changed) throw new Error('Expected a changed directory');

    incoming[0]!.permissions['media.add'] = false;
    result.projection[0]!.permissions['playback.control'] = false;

    expect(result.accepted[0]).toMatchObject({
      displayName: 'Renamed',
      permissions: { 'media.add': true, 'playback.control': true },
    });
  });
});

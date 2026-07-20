import { describe, expect, it } from 'vitest';
import type { DeviceInfo } from '../../types/index.ts';
import { groupConnectedRoomMembers } from '../member-directory.ts';

function device(overrides: Partial<DeviceInfo> & Pick<DeviceInfo, 'id'>): DeviceInfo {
  return {
    label: 'Peer',
    isOp: false,
    isHost: false,
    status: 'connected',
    ...overrides,
  };
}

describe('room member directory projection', () => {
  it('groups several physical devices belonging to one verified room member', () => {
    const members = groupConnectedRoomMembers(
      [
        device({
          id: 'minsu-phone',
          label: 'Minsu',
          memberId: 'member-minsu',
          memberDisplayNumber: 1,
          isAuthenticated: true,
          joinOrder: 1,
          capabilities: ['playback.control'],
        }),
        device({
          id: 'minsu-laptop',
          label: 'Minsu',
          memberId: 'member-minsu',
          memberDisplayNumber: 1,
          isAuthenticated: true,
          isOp: true,
          joinOrder: 4,
          capabilities: ['media.add', 'playback.control'],
        }),
        device({
          id: 'minsu-tablet',
          label: 'Minsu',
          memberId: 'member-minsu',
          memberDisplayNumber: 1,
          isAuthenticated: true,
          joinOrder: 7,
        }),
      ],
      'minsu-laptop',
    );

    expect(members).toEqual([
      expect.objectContaining({
        key: 'member:member-minsu',
        memberDisplayNumber: 1,
        label: 'Minsu',
        deviceCount: 3,
        isAuthenticated: true,
        isCurrent: true,
        isAdministrator: true,
        capabilities: ['playback.control', 'media.add'],
        deviceIds: ['minsu-phone', 'minsu-laptop', 'minsu-tablet'],
      }),
    ]);
  });

  it('never merges different members merely because their nicknames match', () => {
    const members = groupConnectedRoomMembers(
      [
        device({
          id: 'first',
          label: 'Minsu',
          memberId: 'member-one',
          memberDisplayNumber: 1,
        }),
        device({
          id: 'second',
          label: 'Minsu',
          memberId: 'member-two',
          memberDisplayNumber: 2,
        }),
      ],
      '',
    );

    expect(members).toHaveLength(2);
    expect(members.map((member) => member.key)).toEqual(['member:member-one', 'member:member-two']);
  });

  it('keeps anonymous legacy devices separate even when their labels match', () => {
    const members = groupConnectedRoomMembers(
      [device({ id: 'peer-a', label: 'Peer 1' }), device({ id: 'peer-b', label: 'Peer 1' })],
      '',
    );

    expect(members.map((member) => member.key)).toEqual(['device:peer-a', 'device:peer-b']);
  });

  it('groups owner devices while keeping physical host role separate', () => {
    const members = groupConnectedRoomMembers(
      [
        device({
          id: 'host-browser',
          label: 'Minsu',
          isHost: true,
          isOp: true,
          memberId: 'member-minsu',
          memberDisplayNumber: 0,
          isAuthenticated: true,
          joinOrder: 0,
        }),
        device({
          id: 'guest-phone',
          label: 'Minsu',
          isOp: true,
          memberId: 'member-minsu',
          memberDisplayNumber: 0,
          isAuthenticated: true,
          joinOrder: 1,
        }),
      ],
      'guest-phone',
    );

    expect(members).toEqual([
      expect.objectContaining({
        deviceCount: 2,
        isCurrent: true,
        isHost: true,
        isAdministrator: true,
        hostDeviceId: 'host-browser',
        isCurrentDeviceHost: false,
        isCurrentDeviceAdministrator: true,
      }),
    ]);
  });
});

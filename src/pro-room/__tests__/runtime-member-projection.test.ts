import { describe, expect, it } from 'vitest';
import type { ProRoomPresenceParticipant, ProRoomSnapshot } from '../contracts.ts';
import {
  diffProPresenceMembers,
  projectAuthoritativeProDevices,
  projectProPresenceMembers,
} from '../presence-projection.ts';

function diffProRoomPresenceMembersForTests(
  previous: readonly ProRoomPresenceParticipant[],
  current: readonly ProRoomPresenceParticipant[],
): { joined: string[]; departed: string[] } {
  const delta = diffProPresenceMembers(
    projectProPresenceMembers(previous),
    projectProPresenceMembers(current),
  );
  return {
    joined: delta.joined.map((member) => member.displayName),
    departed: delta.departed.map((member) => member.displayName),
  };
}

function participant(
  participantId: string,
  memberId: string,
  role: ProRoomPresenceParticipant['role'],
  memberDisplayNumber: number,
): ProRoomPresenceParticipant {
  return {
    participantId,
    memberId,
    memberDisplayNumber,
    isAuthenticated: !memberId.startsWith('anonymous-member-'),
    displayName: memberId === 'member-owner' ? 'Owner' : 'Minsu',
    devicePlatform: 'other',
    role,
    capabilities:
      role === 'owner'
        ? ['queue.mutate', 'playback.control', 'room.configure']
        : role === 'controller'
          ? ['playback.control', 'asset.upload']
          : ['playback.control'],
    joinedAtMs: memberDisplayNumber * 100 + Number(participantId.at(-1) || 0),
  };
}

function snapshot(participants: ProRoomPresenceParticipant[]): ProRoomSnapshot {
  const viewer = participants[1] ?? participants[0];
  return {
    roomCode: '000001',
    presence: {
      revision: 5,
      coordinatorEpoch: 9,
      coordinatorParticipantId: null,
      participants,
    },
    viewer: viewer
      ? {
          memberId: viewer.memberId || viewer.participantId,
          memberDisplayNumber: viewer.memberDisplayNumber,
          isAuthenticated: viewer.isAuthenticated,
          participantId: viewer.participantId,
          presenceIncarnationId: `presence-${viewer.participantId}`,
          displayName: viewer.displayName,
          role: viewer.role,
          capabilities: viewer.capabilities || [],
          coordinatorEligible: false,
        }
      : null,
  } as ProRoomSnapshot;
}

describe('PRO physical-device member projection', () => {
  it('retains physical transport rows while projecting member identity and authority', () => {
    const owner = participant('device-0', 'member-owner', 'owner', 0);
    const controllerPhone = participant('device-1', 'member-minsu', 'controller', 1);
    const controllerTablet = participant('device-2', 'member-minsu', 'controller', 1);
    const member = participant('device-3', 'member-guest', 'member', 2);

    const projected = projectAuthoritativeProDevices(
      snapshot([owner, controllerPhone, controllerTablet, member]),
    );

    expect(projected.list).toHaveLength(4);
    expect(projected.list[0]).toMatchObject({
      id: 'device-0',
      memberId: 'member-owner',
      memberDisplayNumber: 0,
      role: 'owner',
      isHost: true,
      isOp: true,
    });
    expect(projected.list[1]).toMatchObject({
      id: 'device-1',
      memberId: 'member-minsu',
      memberDisplayNumber: 1,
      role: 'controller',
      isHost: false,
      isOp: true,
      capabilities: ['playback.control', 'asset.upload'],
    });
    expect(projected.list[2]).toMatchObject({
      id: 'device-2',
      memberId: 'member-minsu',
      memberDisplayNumber: 1,
      role: 'controller',
      isOp: true,
    });
    expect(projected.list[3]).toMatchObject({
      id: 'device-3',
      role: 'member',
      isHost: false,
      isOp: false,
    });
  });

  it('announces the first device join and final device leave once per member', () => {
    const phone = participant('device-1', 'member-minsu', 'controller', 1);
    const tablet = participant('device-2', 'member-minsu', 'controller', 1);
    const sameNicknameOtherAccount = {
      ...participant('device-3', 'member-other', 'member', 2),
      displayName: 'Minsu',
    };

    expect(diffProRoomPresenceMembersForTests([phone], [phone, tablet])).toEqual({
      joined: [],
      departed: [],
    });
    expect(diffProRoomPresenceMembersForTests([phone, tablet], [tablet])).toEqual({
      joined: [],
      departed: [],
    });
    expect(diffProRoomPresenceMembersForTests([tablet], [])).toEqual({
      joined: [],
      departed: ['Minsu'],
    });
    expect(diffProRoomPresenceMembersForTests([phone], [phone, sameNicknameOtherAccount])).toEqual({
      joined: ['Minsu'],
      departed: [],
    });
  });

  it('keeps distinct anonymous member identities device-scoped', () => {
    const first = participant('anonymous-1', 'anonymous-member-1', 'member', 1);
    const second = participant('anonymous-2', 'anonymous-member-2', 'member', 2);

    expect(diffProRoomPresenceMembersForTests([first], [first, second])).toEqual({
      joined: ['Minsu'],
      departed: [],
    });
  });

  it('does not announce login, logout, or account replacement as physical presence changes', () => {
    const anonymous = participant('device-1', 'anonymous-member-1', 'member', 1);
    const signedIn = participant('device-1', 'member-minsu', 'controller', 1);
    const replacementAccount = {
      ...participant('device-1', 'member-other', 'member', 2),
      displayName: 'Jisu',
    };

    expect(diffProRoomPresenceMembersForTests([anonymous], [signedIn])).toEqual({
      joined: [],
      departed: [],
    });
    expect(diffProRoomPresenceMembersForTests([signedIn], [anonymous])).toEqual({
      joined: [],
      departed: [],
    });
    expect(diffProRoomPresenceMembersForTests([signedIn], [replacementAccount])).toEqual({
      joined: [],
      departed: [],
    });
  });

  it('still announces real joins and leaves when another participant rebinds identity', () => {
    const anonymous = participant('device-1', 'anonymous-member-1', 'member', 1);
    const signedIn = participant('device-1', 'member-minsu', 'controller', 1);
    const genuinelyJoined = participant('device-2', 'member-jisu', 'member', 2);

    expect(diffProRoomPresenceMembersForTests([anonymous], [signedIn, genuinelyJoined])).toEqual({
      joined: ['Minsu'],
      departed: [],
    });
    expect(
      diffProRoomPresenceMembersForTests(
        [signedIn, genuinelyJoined],
        [participant('device-1', 'anonymous-member-1', 'member', 1)],
      ),
    ).toEqual({
      joined: [],
      departed: ['Minsu'],
    });
  });
});

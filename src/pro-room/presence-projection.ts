import type { ProRoomPresenceParticipant, ProRoomSnapshot } from './contracts.ts';

interface AcceptedProPresenceMember {
  key: string;
  memberId: string | null;
  displayName: string;
  joinedAtMs: number;
}

export interface ProPresenceMemberProjection {
  members: Map<string, AcceptedProPresenceMember>;
  participantMemberKeys: Map<string, string>;
}

interface ProPresenceMemberDelta {
  joined: AcceptedProPresenceMember[];
  departed: AcceptedProPresenceMember[];
}

function proPresenceMemberKey(participant: ProRoomPresenceParticipant): string {
  const memberId = participant.memberId?.trim();
  return memberId ? `member:${memberId}` : `participant:${participant.participantId}`;
}

export function projectProPresenceMembers(
  participants: readonly ProRoomPresenceParticipant[],
): ProPresenceMemberProjection {
  const members = new Map<string, AcceptedProPresenceMember>();
  const participantMemberKeys = new Map<string, string>();

  for (const participant of participants) {
    const key = proPresenceMemberKey(participant);
    participantMemberKeys.set(participant.participantId, key);

    const existing = members.get(key);
    if (!existing || participant.joinedAtMs < existing.joinedAtMs) {
      members.set(key, {
        key,
        memberId: participant.memberId?.trim() || null,
        displayName: participant.displayName,
        joinedAtMs: participant.joinedAtMs,
      });
    }
  }

  return { members, participantMemberKeys };
}

export function diffProPresenceMembers(
  previous: ProPresenceMemberProjection,
  current: ProPresenceMemberProjection,
): ProPresenceMemberDelta {
  // Identity attachment/detachment can move one still-connected participant
  // from a device key to an account key (or between account keys). A new
  // member row is a physical join only when at least one participantId in it
  // is itself new; likewise a vanished row is a leave only when at least one
  // participantId actually disappeared. This preserves member-level first/
  // last notices without announcing login, logout, or lease expiry as motion.
  const physicallyJoinedMemberKeys = new Set<string>();
  for (const [participantId, key] of current.participantMemberKeys) {
    if (!previous.participantMemberKeys.has(participantId)) {
      physicallyJoinedMemberKeys.add(key);
    }
  }

  const physicallyDepartedMemberKeys = new Set<string>();
  for (const [participantId, key] of previous.participantMemberKeys) {
    if (!current.participantMemberKeys.has(participantId)) {
      physicallyDepartedMemberKeys.add(key);
    }
  }

  return {
    joined: [...current.members.values()]
      .filter(
        (member) => !previous.members.has(member.key) && physicallyJoinedMemberKeys.has(member.key),
      )
      .sort(
        (left, right) => left.joinedAtMs - right.joinedAtMs || left.key.localeCompare(right.key),
      ),
    departed: [...previous.members.values()]
      .filter(
        (member) =>
          !current.members.has(member.key) && physicallyDepartedMemberKeys.has(member.key),
      )
      .sort(
        (left, right) => left.joinedAtMs - right.joinedAtMs || left.key.localeCompare(right.key),
      ),
  };
}

export function projectAuthoritativeProDevices(snapshot: ProRoomSnapshot) {
  const viewerId = snapshot.viewer?.participantId ?? '';
  const participants = [...snapshot.presence.participants].sort(
    (left, right) =>
      left.joinedAtMs - right.joinedAtMs || left.participantId.localeCompare(right.participantId),
  );
  const list = participants.map((participant, index) => ({
    id: participant.participantId,
    label: participant.displayName,
    // Transport topology remains coordinator-free, but room ownership and
    // delegated authority are still meaningful product roles.
    isOp: participant.role === 'owner' || participant.role === 'controller',
    isHost: participant.role === 'owner',
    status: 'connected',
    joinOrder: index,
    connectionType: 'remote' as const,
    memberId: participant.memberId,
    memberDisplayNumber: participant.memberDisplayNumber,
    isAuthenticated: participant.isAuthenticated === true,
    role: participant.role,
    capabilities: participant.capabilities ? [...participant.capabilities] : undefined,
  }));
  const ownIndex = participants.findIndex((participant) => participant.participantId === viewerId);
  const ownParticipant = ownIndex >= 0 ? participants[ownIndex] : null;
  return { participants, list, ownIndex, ownParticipant };
}

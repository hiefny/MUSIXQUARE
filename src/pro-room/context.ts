import type { RoomCapability, RoomContext } from '../types/index.ts';
import type { ProRoomSnapshot } from './contracts.ts';

function projectClientCapabilities(snapshot: ProRoomSnapshot): RoomCapability[] {
  const viewer = snapshot.viewer;
  if (!viewer) return [];

  const capabilities = new Set<RoomCapability>(
    viewer.capabilities.filter(
      (capability): capability is Exclude<typeof capability, 'coordinator.eligible'> =>
        capability !== 'coordinator.eligible',
    ),
  );

  if (snapshot.authorityVersion === 1 && snapshot.administrators) {
    const administrator = snapshot.administrators.find(
      (candidate) => candidate.memberId === viewer.memberId,
    );
    if (administrator?.permissions['media.add']) capabilities.add('media.add');
    if (administrator?.permissions['chat.notice']) capabilities.add('chat.notice');
    if (administrator?.role === 'owner') capabilities.add('system-audio.publish');
  } else {
    // During a rolling deployment, the previous PRO worker can only project
    // its coarse capability vocabulary. Preserve that worker's established
    // authority without widening the new member model: upload authority maps
    // to media.add, and member-management authority maps to chat.notice.
    if (capabilities.has('asset.upload')) capabilities.add('media.add');
    if (capabilities.has('members.manage')) capabilities.add('chat.notice');
    // Preserve the pre-authority equal-member live-capture contract while
    // cached clients converge. Authority v1 narrows this to the owner above.
    if (capabilities.has('media.add')) capabilities.add('system-audio.publish');
  }

  return [...capabilities];
}

/** Project an authenticated PRO participant into the shared application shell. */
export function projectProRoomContext(snapshot: ProRoomSnapshot): RoomContext | null {
  const viewer = snapshot.viewer;
  if (snapshot.status !== 'active' || !viewer) return null;

  return {
    kind: 'pro',
    roomId: snapshot.roomCode,
    // PRO playback authority belongs exclusively to the room Durable Object.
    // `member` therefore means an equal local playback endpoint, never a
    // browser subordinate to another participant.
    role: 'member',
    coordinatorId: null,
    epoch: snapshot.presence.coordinatorEpoch,
    snapshotRevision: snapshot.revision,
    capabilities: projectClientCapabilities(snapshot),
  };
}

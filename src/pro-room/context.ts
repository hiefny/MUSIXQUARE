import type { RoomContext } from '../types/index.ts';
import type { ProRoomSnapshot } from './contracts.ts';

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
    capabilities: viewer.capabilities.filter((capability) => capability !== 'coordinator.eligible'),
  };
}

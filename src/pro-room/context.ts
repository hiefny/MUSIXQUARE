import type { RoomContext } from '../types/index.ts';
import type { ProRoomSnapshot } from './contracts.ts';

/**
 * Project an already-validated authenticated PRO snapshot into the provider-
 * neutral authority context used by the legacy application shell.
 */
export function projectProRoomContext(snapshot: ProRoomSnapshot): RoomContext | null {
  const viewer = snapshot.viewer;
  if (snapshot.status !== 'active' || !viewer) return null;

  const isCoordinator =
    snapshot.presence.coordinatorParticipantId !== null &&
    snapshot.presence.coordinatorParticipantId === viewer.participantId;

  return {
    kind: 'pro',
    roomId: snapshot.roomCode,
    role: isCoordinator ? 'coordinator' : 'member',
    coordinatorId: snapshot.presence.coordinatorParticipantId,
    epoch: snapshot.presence.coordinatorEpoch,
    snapshotRevision: snapshot.revision,
    capabilities: [...viewer.capabilities],
  };
}

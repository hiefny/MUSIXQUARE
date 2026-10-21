import type {
  ProRoomHeartbeat,
  ProRoomSnapshot,
  ProRoomSystemAudioState,
} from '../../contracts.ts';

/** The system-audio state of a room where nobody has ever shared. */
export function idleProSystemAudio(generation = 0): ProRoomSystemAudioState {
  return {
    generation,
    status: 'idle',
    ownerParticipantId: null,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  };
}

/**
 * A parsed presence heartbeat reply. Every reply carries the room's
 * system-audio state; fixtures that do not exercise sharing use an idle room.
 */
export function proHeartbeat(
  snapshot: ProRoomSnapshot,
  systemAudio: ProRoomSystemAudioState = idleProSystemAudio(),
): ProRoomHeartbeat {
  return { snapshot, systemAudio };
}

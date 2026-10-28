import type {
  ProRoomAdministrator,
  ProRoomPresenceSnapshot,
  ProRoomSnapshot,
  ProRoomViewerSnapshot,
} from '../../contracts.ts';

/**
 * Wire fixtures for the PRO room snapshot and the administrator directory
 * (Phase 5.5 step T0).
 *
 * Snapshot schemaVersion 1 carries four constant keys from the retired
 * browser-coordinator era: `presence.coordinatorParticipantId` (null),
 * `viewer.coordinatorEligible` (false), `memberIdentityVersion` (1) and
 * `authorityVersion` (1). The administrator directory answer carries
 * `authorityVersion` (1) as well. A fixture spells every other field and lets
 * these helpers add the schema version and the four keys, so no fixture
 * writes them itself.
 *
 * The output is today's v1 wire, which is also the parsed (memory) shape: the
 * keys come out in the parser's order. When the App starts accepting snapshot
 * v2, that change's code commit switches this default output to the v2 wire
 * (the memory shape both wires then parse to) and keeps the v1 wire in a
 * helper of its own, so the rows that compare a parsed snapshot with its
 * fixture keep passing. The switch belongs in the code commit, not in its
 * test-first commit, where the parent's v1-only parser would refuse every
 * fixture at once.
 */

/** A presence block without its coordinator-era key. */
export type ProPresenceFields = Omit<ProRoomPresenceSnapshot, 'coordinatorParticipantId'>;

/** A viewer without its coordinator-era key. */
export type ProViewerFields = Omit<ProRoomViewerSnapshot, 'coordinatorEligible'>;

/** Every snapshot field a fixture chooses: all but the schema version and the version keys. */
export type ProSnapshotFields = Omit<
  ProRoomSnapshot,
  'schemaVersion' | 'memberIdentityVersion' | 'authorityVersion' | 'presence' | 'viewer'
> & {
  presence: ProPresenceFields;
  viewer: ProViewerFields | null;
};

/** The snapshot's presence block on the wire. */
export function proPresence(fields: ProPresenceFields): ProRoomPresenceSnapshot {
  return {
    coordinatorEpoch: fields.coordinatorEpoch,
    revision: fields.revision,
    coordinatorParticipantId: null,
    participants: fields.participants,
  };
}

/** The snapshot's viewer on the wire. */
export function proViewer(fields: ProViewerFields): ProRoomViewerSnapshot {
  return {
    memberId: fields.memberId,
    memberDisplayNumber: fields.memberDisplayNumber,
    isAuthenticated: fields.isAuthenticated,
    participantId: fields.participantId,
    presenceIncarnationId: fields.presenceIncarnationId,
    displayName: fields.displayName,
    role: fields.role,
    capabilities: fields.capabilities,
    coordinatorEligible: false,
  };
}

/** A complete PRO room snapshot on the wire. */
export function proSnapshot(fields: ProSnapshotFields): ProRoomSnapshot {
  return {
    schemaVersion: 1,
    roomCode: fields.roomCode,
    status: fields.status,
    ...(fields.passwordRequired === undefined ? {} : { passwordRequired: fields.passwordRequired }),
    runtime: fields.runtime,
    revision: fields.revision,
    playlistRevision: fields.playlistRevision,
    effectsRevision: fields.effectsRevision,
    queueModeRevision: fields.queueModeRevision,
    playlist: fields.playlist,
    currentQueueItemId: fields.currentQueueItemId,
    playback: fields.playback,
    presence: proPresence(fields.presence),
    quota: fields.quota,
    viewer: fields.viewer === null ? null : proViewer(fields.viewer),
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: fields.administrators,
    ...(fields.playlistSlots === undefined ? {} : { playlistSlots: fields.playlistSlots }),
  };
}

/** The administrator directory answer of GET, PUT and DELETE `/administrators` on the wire. */
export function proAdministratorDirectory(administrators: ProRoomAdministrator[]): {
  authorityVersion: 1;
  administrators: ProRoomAdministrator[];
} {
  return { authorityVersion: 1, administrators };
}

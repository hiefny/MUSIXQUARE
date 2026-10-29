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
 * `authorityVersion` (1) as well. Snapshot schemaVersion 2 carries none of
 * them, and neither does the directory answer that goes with it. A fixture
 * spells every other field and lets these helpers add the schema version and
 * the four keys, so no fixture writes them itself.
 *
 * `proSnapshotV1` and `proSnapshotV2` build one wire version each, for rows
 * that pin a version. The default output is the v2 wire, which is also the
 * parsed (memory) shape that both wires parse to: the keys come out in the
 * parser's order, so the rows that compare a parsed snapshot with its fixture
 * pass for either wire. The default switched from the v1 wire in the code
 * commit of the App change that started accepting v2, not in its test-first
 * commit, where the parent's v1-only parser would have refused every fixture.
 */

/** A presence block: the memory shape, which has no coordinator-era key. */
export type ProPresenceFields = ProRoomPresenceSnapshot;

/** A viewer: the memory shape, which has no coordinator-era key. */
export type ProViewerFields = ProRoomViewerSnapshot;

/** Every snapshot field a fixture chooses: all but the schema version. */
export type ProSnapshotFields = Omit<ProRoomSnapshot, 'schemaVersion' | 'presence' | 'viewer'> & {
  presence: ProPresenceFields;
  viewer: ProViewerFields | null;
};

/** Snapshot schemaVersion 1 on the wire: every field and the four coordinator-era keys. */
export type ProSnapshotV1Wire = Omit<ProSnapshotFields, 'presence' | 'viewer'> & {
  schemaVersion: 1;
  presence: ProPresenceFields & { coordinatorParticipantId: string | null };
  viewer: (ProViewerFields & { coordinatorEligible: boolean }) | null;
  memberIdentityVersion: 1;
  authorityVersion: 1;
};

/** Snapshot schemaVersion 2 on the wire: every field and none of the four keys. */
export type ProSnapshotV2Wire = ProSnapshotFields & { schemaVersion: 2 };

function presenceV1(fields: ProPresenceFields): ProSnapshotV1Wire['presence'] {
  return {
    coordinatorEpoch: fields.coordinatorEpoch,
    revision: fields.revision,
    coordinatorParticipantId: null,
    participants: fields.participants,
  };
}

function presenceV2(fields: ProPresenceFields): ProPresenceFields {
  return {
    coordinatorEpoch: fields.coordinatorEpoch,
    revision: fields.revision,
    participants: fields.participants,
  };
}

function viewerV1(fields: ProViewerFields): ProViewerFields & { coordinatorEligible: boolean } {
  return { ...viewerV2(fields), coordinatorEligible: false };
}

function viewerV2(fields: ProViewerFields): ProViewerFields {
  return {
    memberId: fields.memberId,
    memberDisplayNumber: fields.memberDisplayNumber,
    isAuthenticated: fields.isAuthenticated,
    participantId: fields.participantId,
    presenceIncarnationId: fields.presenceIncarnationId,
    displayName: fields.displayName,
    role: fields.role,
    capabilities: fields.capabilities,
  };
}

/** A complete snapshot schemaVersion 1 on the wire. */
export function proSnapshotV1(fields: ProSnapshotFields): ProSnapshotV1Wire {
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
    presence: presenceV1(fields.presence),
    quota: fields.quota,
    viewer: fields.viewer === null ? null : viewerV1(fields.viewer),
    memberIdentityVersion: 1,
    authorityVersion: 1,
    administrators: fields.administrators,
    ...(fields.playlistSlots === undefined ? {} : { playlistSlots: fields.playlistSlots }),
  };
}

/** A complete snapshot schemaVersion 2 on the wire, with its keys in the parser's order. */
export function proSnapshotV2(fields: ProSnapshotFields): ProSnapshotV2Wire {
  return {
    schemaVersion: 2,
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
    presence: presenceV2(fields.presence),
    quota: fields.quota,
    viewer: fields.viewer === null ? null : viewerV2(fields.viewer),
    administrators: fields.administrators,
    ...(fields.playlistSlots === undefined ? {} : { playlistSlots: fields.playlistSlots }),
  };
}

/** The snapshot's presence block in the default output. */
export function proPresence(fields: ProPresenceFields): ProRoomPresenceSnapshot {
  return presenceV2(fields);
}

/** The snapshot's viewer in the default output. */
export function proViewer(fields: ProViewerFields): ProRoomViewerSnapshot {
  return viewerV2(fields);
}

/** A complete PRO room snapshot in the default output. */
export function proSnapshot(fields: ProSnapshotFields): ProRoomSnapshot {
  return proSnapshotV2(fields);
}

/** The administrator directory answer that goes with snapshot schemaVersion 1. */
export function proAdministratorDirectoryV1(administrators: ProRoomAdministrator[]): {
  authorityVersion: 1;
  administrators: ProRoomAdministrator[];
} {
  return { authorityVersion: 1, administrators };
}

/** The administrator directory answer that goes with snapshot schemaVersion 2. */
export function proAdministratorDirectoryV2(administrators: ProRoomAdministrator[]): {
  administrators: ProRoomAdministrator[];
} {
  return { administrators };
}

/** The administrator directory answer of GET, PUT and DELETE `/administrators` in the default output. */
export function proAdministratorDirectory(administrators: ProRoomAdministrator[]): {
  administrators: ProRoomAdministrator[];
} {
  return proAdministratorDirectoryV2(administrators);
}

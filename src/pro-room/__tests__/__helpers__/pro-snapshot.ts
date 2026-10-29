import { PLAYLIST_SLOT_COUNT } from '../../../core/constants.ts';
import type { PlaylistSlotSummary, PlaylistSlotsSummary } from '../../../types/index.ts';
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
 * Every PRO Worker since release W sends the entry policy (`passwordRequired`)
 * and the playlist summaries (`playlistSlots`) with every snapshot, on either
 * wire. A fixture may leave them out: both builders then add a room that asks
 * for the PIN and has one playlist, the fixture's own, in the first slot.
 *
 * `proSnapshotV1` and `proSnapshotV2` build one wire version each, for rows
 * that pin a version. The default output is the v2 wire, which is also the
 * parsed (memory) shape: the keys come out in the parser's order, so the rows
 * that compare a parsed snapshot with its fixture pass. The App reads only
 * the v2 wire; the v1 builder remains for the rows that pin its refusal.
 */

/** A presence block: the memory shape, which has no coordinator-era key. */
export type ProPresenceFields = ProRoomPresenceSnapshot;

/** A viewer: the memory shape, which has no coordinator-era key. */
export type ProViewerFields = ProRoomViewerSnapshot;

/**
 * Every snapshot field a fixture chooses: all but the schema version. The
 * entry policy and the playlist summaries may be left out (see above).
 */
export type ProSnapshotFields = Omit<
  ProRoomSnapshot,
  'schemaVersion' | 'presence' | 'viewer' | 'passwordRequired' | 'playlistSlots'
> & {
  presence: ProPresenceFields;
  viewer: ProViewerFields | null;
  passwordRequired?: boolean;
  playlistSlots?: PlaylistSlotsSummary;
};

/** Snapshot schemaVersion 1 on the wire: every field and the four coordinator-era keys. */
export type ProSnapshotV1Wire = Omit<ProRoomSnapshot, 'schemaVersion' | 'presence' | 'viewer'> & {
  schemaVersion: 1;
  presence: ProPresenceFields & { coordinatorParticipantId: string | null };
  viewer: (ProViewerFields & { coordinatorEligible: boolean }) | null;
  memberIdentityVersion: 1;
  authorityVersion: 1;
};

/** Snapshot schemaVersion 2 on the wire: every field and none of the four keys. */
export type ProSnapshotV2Wire = ProRoomSnapshot;

/** One playlist's summary: its length, and its file sizes added up (null without files). */
function playlistSummary(playlist: ProSnapshotFields['playlist']): PlaylistSlotSummary {
  let bytes: number | null = null;
  for (const item of playlist) {
    if (item.source.kind === 'pro-r2') bytes = (bytes ?? 0) + item.source.byteLength;
  }
  return { count: playlist.length, bytes };
}

/** The playlist summaries of a room whose only playlist is `playlist`, in the first slot. */
function onePlaylistSlots(playlist: ProSnapshotFields['playlist']): PlaylistSlotsSummary {
  return {
    activeSlot: 0,
    slots: Array.from({ length: PLAYLIST_SLOT_COUNT }, (_, slot) =>
      slot === 0 ? playlistSummary(playlist) : { count: 0, bytes: null },
    ),
  };
}

/**
 * `snapshot` with the active entry of its playlist summaries recounted from
 * its playlist, as a PRO Worker sends it; the other playlists stay. The App
 * refuses a snapshot whose active playlist count differs from its playlist,
 * so a fixture that changes the playlist of a snapshot it already built
 * passes the result through here.
 */
export function recountProPlaylist<T extends Pick<ProSnapshotFields, 'playlist' | 'playlistSlots'>>(
  snapshot: T,
): T & { playlistSlots: PlaylistSlotsSummary } {
  const { activeSlot, slots } = snapshot.playlistSlots ?? onePlaylistSlots([]);
  return {
    ...snapshot,
    playlistSlots: {
      activeSlot,
      slots: slots.map((slot, index) =>
        index === activeSlot ? playlistSummary(snapshot.playlist) : slot,
      ),
    },
  };
}

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

/** A complete snapshot schemaVersion 1 on the wire, as the last PRO Worker that sent it did. */
export function proSnapshotV1(fields: ProSnapshotFields): ProSnapshotV1Wire {
  return {
    schemaVersion: 1,
    roomCode: fields.roomCode,
    status: fields.status,
    passwordRequired: fields.passwordRequired ?? true,
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
    playlistSlots: fields.playlistSlots ?? onePlaylistSlots(fields.playlist),
  };
}

/** A complete snapshot schemaVersion 2 on the wire, with its keys in the parser's order. */
export function proSnapshotV2(fields: ProSnapshotFields): ProSnapshotV2Wire {
  return {
    schemaVersion: 2,
    roomCode: fields.roomCode,
    status: fields.status,
    passwordRequired: fields.passwordRequired ?? true,
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
    playlistSlots: fields.playlistSlots ?? onePlaylistSlots(fields.playlist),
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

/** The administrator directory answer that went with snapshot schemaVersion 1. */
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

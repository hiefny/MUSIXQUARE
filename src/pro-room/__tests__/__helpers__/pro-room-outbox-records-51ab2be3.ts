/**
 * Frozen durable signaling-outbox records of main 51ab2be3 (the PRO Worker
 * deployed as ae5ac945), for mixed-version tests across the Phase 1 outbox
 * and duration owners (plan steps C7-4 and C7-6, registry RO-07). Like the
 * frozen C9 runtime in src/network/transport/__tests__/fixtures, these are
 * spelled out key by key in that version's order and never derived from the
 * Worker under test.
 *
 * Both directions of a rollback across the change rest on them:
 * - old to new: the Worker under test must load and deliver these records;
 * - new to old: what the Worker under test writes must equal them byte for
 *   byte, because 51ab2be3's loaders keep exactly these key sets
 *   (`hasExactKeys` in normalizeLoadedPresenceBroadcast and
 *   normalizeStoredPlaybackBroadcastRecord) with attempts up to
 *   OUTBOX_ATTEMPT_CAP_51AB2BE3, and drop any other record on load.
 * The suites first ran against 51ab2be3 itself with these records (the C7-4
 * tests commit); that run is the evidence that the old version writes and
 * accepts them.
 */

/** SIGNALING_BROADCAST_RETRY_MAX_ATTEMPTS at 51ab2be3: the load-time cap of both lanes. */
export const OUTBOX_ATTEMPT_CAP_51AB2BE3 = 16;

/** `pendingPresenceBroadcast` as 51ab2be3 writes it. */
export function presenceMarker51ab2be3(fields: {
  coordinatorEpoch: number;
  presenceRevision: number;
  roomRevision: number;
  retryAtMs: number;
  attempts: number;
}) {
  return {
    coordinatorEpoch: fields.coordinatorEpoch,
    presenceRevision: fields.presenceRevision,
    roomRevision: fields.roomRevision,
    retryAtMs: fields.retryAtMs,
    attempts: fields.attempts,
  };
}

interface RecordFields {
  coordinatorEpoch: number;
  /** null for a direct COMMIT, which has no transition. */
  transitionId: string | null;
  basePlaybackRevision: number;
  targets: string[];
  serverTimeMs: number;
  createdAtMs: number;
  attempts: number;
  retryAtMs: number;
}

function playbackRecord(
  kind: 'prepare' | 'cancel' | 'commit',
  fields: RecordFields,
  event: Record<string, unknown>,
) {
  return {
    kind,
    coordinatorEpoch: fields.coordinatorEpoch,
    transitionId: fields.transitionId,
    basePlaybackRevision: fields.basePlaybackRevision,
    playbackRevision: fields.basePlaybackRevision + 1,
    targets: [...fields.targets],
    event,
    createdAtMs: fields.createdAtMs,
    attempts: fields.attempts,
    retryAtMs: fields.retryAtMs,
  };
}

/** One `pendingPlaybackBroadcasts` PREPARE record as 51ab2be3 writes it. */
export function prepareRecord51ab2be3(
  fields: RecordFields & { deadlineAtMs: number; target: Record<string, unknown> },
) {
  return playbackRecord('prepare', fields, {
    type: 'pro-playback-prepare',
    transitionId: fields.transitionId,
    serverTimeMs: fields.serverTimeMs,
    deadlineAtMs: fields.deadlineAtMs,
    basePlaybackRevision: fields.basePlaybackRevision,
    target: structuredClone(fields.target),
  });
}

/** One CANCEL record as 51ab2be3 writes it. */
export function cancelRecord51ab2be3(fields: RecordFields & { reason: string }) {
  return playbackRecord('cancel', fields, {
    type: 'pro-playback-cancel',
    transitionId: fields.transitionId,
    serverTimeMs: fields.serverTimeMs,
    reason: fields.reason,
  });
}

/** One COMMIT record as 51ab2be3 writes it. */
export function commitRecord51ab2be3(
  fields: RecordFields & { executeAtMs: number; playback: Record<string, unknown> },
) {
  return playbackRecord('commit', fields, {
    type: 'pro-playback-commit',
    transitionId: fields.transitionId,
    serverTimeMs: fields.serverTimeMs,
    executeAtMs: fields.executeAtMs,
    playback: structuredClone(fields.playback),
  });
}

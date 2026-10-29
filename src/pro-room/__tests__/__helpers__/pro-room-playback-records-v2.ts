/**
 * Frozen PRO playback records of the first PRO Worker that sends PRO snapshot
 * schemaVersion 2, for the mixed-version tests of that Worker. They are
 * spelled out key by key in the order that Worker writes them and never
 * derived from the Worker under test.
 *
 * That Worker names the start kind of every transition in `timingMode`
 * ('zero-start' or 'scheduled-control'), always as the last key: on the
 * stored `pendingPlaybackTransition`, and on the PREPARE and transition
 * COMMIT events of its `pendingPlaybackBroadcasts` records. Every transition
 * has the 3000 ms barrier and every transition COMMIT the 700 ms lead,
 * whatever its kind. A CANCEL and a direct COMMIT name no kind and keep the
 * shapes of pro-room-outbox-records-51ab2be3.ts.
 *
 * Both directions of a rollback across that Worker rest on them:
 * - new to old: what that Worker stores must equal these records byte for
 *   byte;
 * - old to new: its failed release, and a manual rollback, return to the
 *   9.0.22 PRO Worker, the first that reads `timingMode`. That Worker must
 *   load these records across a cold restart, keep their kind, deliver the
 *   outbox records in order and commit the transition, because an older
 *   loader drops any other record (`hasExactKeys` in
 *   normalizeStoredPlaybackTransition and
 *   normalizeStoredPlaybackBroadcastRecord).
 * The rows that load them passed on the parent of the tests commit that added
 * them, whose playback code matches 9.0.22's. The evidence that the rollback
 * Worker accepts them is a separate run with cloudflare/pro-room-worker.ts
 * swapped to the 9.0.22 PRO Worker: the three rollback rows (the in-order
 * delivery row and both frozen v2 record cold-restart rows) pass there.
 */

/** The barrier: a stored transition's deadline after its creation, and a PREPARE's after its send. */
const TRANSITION_DEADLINE_MS_V2 = 3_000;

/** The lead of a transition COMMIT: its execution after its send. */
const TRANSITION_COMMIT_LEAD_MS_V2 = 700;

type TimingModeV2 = 'zero-start' | 'scheduled-control';

interface StoredTransitionFields {
  transitionId: string;
  coordinatorEpoch: number;
  basePlaybackRevision: number;
  createdAtMs: number;
  target: Record<string, unknown>;
  /** Presence incarnations that must report READY before an early COMMIT. */
  cohort: string[];
  ready?: Record<string, 'ready' | 'failed'>;
  developerCommandId?: string | null;
}

function storedTransition(fields: StoredTransitionFields) {
  return {
    transitionId: fields.transitionId,
    coordinatorEpoch: fields.coordinatorEpoch,
    basePlaybackRevision: fields.basePlaybackRevision,
    createdAtMs: fields.createdAtMs,
    deadlineAtMs: fields.createdAtMs + TRANSITION_DEADLINE_MS_V2,
    target: structuredClone(fields.target),
    cohort: [...fields.cohort],
    ready: { ...fields.ready },
    developerCommandId: fields.developerCommandId ?? null,
  };
}

/**
 * A transition as that Worker stores it: a zero-start for select, next,
 * previous, ended, unavailable and play from idle, a scheduled-control for
 * play from paused and seek while playing.
 */
export function storedTransitionV2(fields: StoredTransitionFields & { timingMode: TimingModeV2 }) {
  return { ...storedTransition(fields), timingMode: fields.timingMode };
}

/** The wake transition of a sleeping room that resumes playing. */
export function wakeTransitionV2(fields: StoredTransitionFields) {
  return {
    ...storedTransition(fields),
    resumeFromSleep: true as const,
    timingMode: 'scheduled-control' as const,
  };
}

interface RecordFields {
  coordinatorEpoch: number;
  transitionId: string;
  basePlaybackRevision: number;
  targets: string[];
  /** When the event was sent: the transition's creation or its COMMIT. */
  serverTimeMs: number;
  createdAtMs: number;
  attempts: number;
  retryAtMs: number;
  timingMode: TimingModeV2;
}

function playbackRecord(
  kind: 'prepare' | 'commit',
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

/** One `pendingPlaybackBroadcasts` PREPARE record as that Worker writes it. */
export function prepareRecordV2(fields: RecordFields & { target: Record<string, unknown> }) {
  return playbackRecord('prepare', fields, {
    type: 'pro-playback-prepare',
    transitionId: fields.transitionId,
    serverTimeMs: fields.serverTimeMs,
    deadlineAtMs: fields.serverTimeMs + TRANSITION_DEADLINE_MS_V2,
    basePlaybackRevision: fields.basePlaybackRevision,
    target: structuredClone(fields.target),
    timingMode: fields.timingMode,
  });
}

/**
 * One transition COMMIT record as that Worker writes it. Its playback is the
 * committed target, which executes with the COMMIT.
 */
export function transitionCommitRecordV2(
  fields: RecordFields & { playback: Record<string, unknown> },
) {
  const executeAtMs = fields.serverTimeMs + TRANSITION_COMMIT_LEAD_MS_V2;
  return playbackRecord('commit', fields, {
    type: 'pro-playback-commit',
    transitionId: fields.transitionId,
    serverTimeMs: fields.serverTimeMs,
    executeAtMs,
    playback: { ...structuredClone(fields.playback), updatedAtMs: executeAtMs },
    timingMode: fields.timingMode,
  });
}

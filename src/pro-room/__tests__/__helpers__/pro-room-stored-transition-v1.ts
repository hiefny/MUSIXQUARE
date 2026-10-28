/**
 * Frozen `pendingPlaybackTransition` records of the PRO room as every PRO
 * Worker before PRO snapshot v2 stores them, for mixed-version tests of the
 * snapshot v2 steps (the stored-transition half of what the outbox records of
 * pro-room-outbox-records-51ab2be3.ts pin). They are spelled out key by key in
 * the order those Workers write and load them, and never derived from the
 * Worker under test.
 *
 * These records have no `timingMode`: a zero-start transition is told from a
 * scheduled-control one only by its deadline, 2999 ms after creation instead
 * of 3000 ms (the encoding of 3454421b, 2026-07-20; the writer and the loader
 * normalizeStoredPlaybackTransition have kept it since). A wake transition is
 * scheduled-control and adds `resumeFromSleep: true`.
 *
 * Both directions of a rollback across the snapshot v2 steps rest on them:
 * - old to new: a Worker that also reads `timingMode` must still load these
 *   records and commit a 2999 ms one with the zero-start lead;
 * - new to old: until a Worker writes `timingMode`, what it stores must equal
 *   these records byte for byte, because the older loaders keep exactly this
 *   key set (`hasExactKeys` with the one optional key `resumeFromSleep`) and
 *   null any other record on load, with no CANCEL.
 * The suite first ran against the 9.0.20 release candidate (e1e638bf) with
 * these records; that run is the evidence that the pre-v2 Worker writes and
 * accepts them.
 */

/** The zero-start mark of a pre-v2 stored transition: its deadline offset. */
export const ZERO_START_DEADLINE_MS_V1 = 2_999;

/** The deadline offset of every other pre-v2 stored transition. */
export const TRANSITION_DEADLINE_MS_V1 = 3_000;

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

function storedTransition(fields: StoredTransitionFields, deadlineMs: number) {
  return {
    transitionId: fields.transitionId,
    coordinatorEpoch: fields.coordinatorEpoch,
    basePlaybackRevision: fields.basePlaybackRevision,
    createdAtMs: fields.createdAtMs,
    deadlineAtMs: fields.createdAtMs + deadlineMs,
    target: structuredClone(fields.target),
    cohort: [...fields.cohort],
    ready: { ...fields.ready },
    developerCommandId: fields.developerCommandId ?? null,
  };
}

/**
 * A zero-start transition (select, next, previous, ended, unavailable, or play
 * from idle) as a pre-v2 Worker stores it.
 */
export function zeroStartTransitionV1(fields: StoredTransitionFields) {
  return storedTransition(fields, ZERO_START_DEADLINE_MS_V1);
}

/** A scheduled-control transition (play from paused, seek while playing). */
export function scheduledControlTransitionV1(fields: StoredTransitionFields) {
  return storedTransition(fields, TRANSITION_DEADLINE_MS_V1);
}

/** The wake transition of a sleeping room that resumes playing. */
export function wakeTransitionV1(fields: StoredTransitionFields) {
  return { ...storedTransition(fields, TRANSITION_DEADLINE_MS_V1), resumeFromSleep: true as const };
}

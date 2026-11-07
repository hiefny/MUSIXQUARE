/**
 * MUSIXQUARE — Audio output recovery counts (an RO-01 observer, not an owner)
 *
 * On-device numbers for `/debug sync` (Phase 7 7A-1): how often this page
 * asked the shared AudioContext to resume and from where, which recovery
 * deadlines fired, how long recoveries waited for clock verification, and the
 * suspends, dialog requests, refused taps and overlaps the Phase 7 trains are
 * judged by. Nothing here is sent anywhere.
 *
 * The owners (both in context-recovery.ts since Phase 7 7C-4) and the
 * primitives they share in context.ts, the recovery dialog (app.ts) and UI
 * sounds (ui-sounds.ts) report events; this module keeps monotonic counts,
 * one time sum and one maximum, never a copy of owner state and no
 * identifiers. Where a count needs an owner's answer (live suspend leases on
 * a context, an attempt waiting for a tap: since Phase 7 7B-3 the owner's
 * holding answer, the one UI sounds ask), the owner registers a read-only
 * query that is called at that moment. Counts live in numbered slots of one
 * typed array; their names live only in the lazy reader
 * (diagnostics/sync-flight-recorder.ts).
 *
 * A mock-free leaf on purpose: test files replace context.ts, core/log.ts and
 * core/timers.ts with factories, so it imports none of them and reads time
 * from performance.now(). context-recovery.ts imports context.ts, so
 * context.ts could not count inside the owner.
 *
 * Owner decision Q4 (2026-11-02): the page's counts are kept for the next
 * page in this tab. The page navigation owner (RO-23) calls
 * keepAudioRecoveryForNextPage at each pagehide; the next page reads and
 * removes the value once at start and keeps it only when that page is a
 * reload. The reader drops a value from another label set and shows a value
 * from another build with its build number on its own line, never added to
 * this page's counts.
 */

import { PREVIOUS_AUDIO_RECOVERY_KEY } from '../core/navigation-contract.ts';

// ── Slots ────────────────────────────────────────────────────────────
// Resume attempts, by where the native resume() was asked for.
/**
 * context-recovery.ts: the play-request restart's gesture resume (context.ts
 * until Phase 7 7C-4).
 */
export const RESUME_PLAY_REQUEST = 0;
/** context-recovery.ts: the playback scope's gesture resume. */
export const RESUME_PLAY_GESTURE = 1;
/**
 * context-recovery.ts: the recovery dialog's own gesture resume (no owner
 * attempt), counted in app.ts until Phase 7 7C-2.
 */
export const RESUME_DIALOG = 2;
/** context-recovery.ts: an automatic resume, with or without an attempt. */
export const RESUME_AUTO = 3;
export const RESUME_ENSURE_RUNNING = 4;
export const RESUME_PROBE = 5;
/** context-recovery.ts: undoing a retired suspend (context.ts until Phase 7 7C-4). */
export const RESUME_RETIRE = 6;
export const RESUME_UI_SOUND = 7;
// Deadlines that fired: the timer settled before what it watched.
export const DEADLINE_PLAY_REQUEST_PREPARE = 8;
export const DEADLINE_PLAY_REQUEST_RESUME = 9;
export const DEADLINE_PLAY_REQUEST_WATCHDOG = 10;
export const DEADLINE_LATE_SUSPEND_FENCE = 11;
export const DEADLINE_RETIRE_CLEANUP = 12;
export const DEADLINE_ENSURE_RUNNING = 13;
export const DEADLINE_PROBE = 14;
export const DEADLINE_SCOPE_PREPARE = 15;
export const DEADLINE_SCOPE_WATCHDOG = 16;
export const DEADLINE_AUTO_RESUME = 17;
export const DEADLINE_GESTURE_RESUME = 18;
export const DEADLINE_GESTURE_FLOW = 19;
export const DEADLINE_CLOCK_REQUIREMENT = 20;
/** Every deadline started, fired or not. */
export const DEADLINES_WATCHED = 21;
// Clock verification waits and how each ended.
export const CLOCK_WAITS = 22;
export const CLOCK_CONFIRMED = 23;
export const CLOCK_CANCELLED = 24;
/** The wait ended without a confirmed clock and the attempt went back to recovery. */
export const CLOCK_RECOVERY_NEEDED = 25;
export const CLOCK_WAIT_TOTAL_MS = 26;
export const CLOCK_WAIT_MAX_MS = 27;
// Suspends.
export const SUSPEND_CALLS = 28;
/** A native suspend that was its attempt's second or later. */
export const SECOND_SUSPENDS = 29;
/** An attempt waiting for a tap went back to suspending because the context ran. */
export const RESUSPENDED_AFTER_RUNNING = 30;
// The rest.
export const DIALOG_REQUESTS_PLAY = 31;
export const DIALOG_REQUESTS_RETURN = 32;
export const CONTEXT_RECOVERED_REJOINS = 33;
export const TAPS_REFUSED = 34;
export const LEASES_AT_ONCE_MAX = 35;
export const UI_SOUND_RESUMES_WHILE_WAITING = 36;

/** How many slots there are; a kept value has one number per slot. */
export const AUDIO_RECOVERY_SLOTS = 37;

const counts = new Float64Array(AUDIO_RECOVERY_SLOTS);

/** Bump this page's slot by one. */
export function countAudioRecovery(slot: number): void {
  counts[slot] += 1;
}

/**
 * One deadline race: Promise.race([flight, deadline]), as the caller wrote
 * it before, and the same promise. The deadline counts only when its timer
 * settles first, so a flight that wins leaves it alone.
 */
export function raceAudioRecoveryDeadline<F, D>(
  slot: number,
  flight: PromiseLike<F>,
  deadline: PromiseLike<D>,
): Promise<Awaited<F> | Awaited<D>> {
  counts[DEADLINES_WATCHED] += 1;
  let flightSettled = false;
  const settled = (): void => {
    flightSettled = true;
  };
  // Promise.resolve returns a native promise itself and survives a test
  // double that returns no promise at all.
  Promise.resolve(flight).then(settled, settled);
  Promise.resolve(deadline).then(() => {
    if (!flightSettled) counts[slot] += 1;
  }, settled);
  return Promise.race([flight, deadline]);
}

const WAIT = 'awaiting-clock-verification';
const waitStarts = new WeakMap<object, number>();

/**
 * Each owner's one phase funnel reports every change of an attempt's phase:
 * a clock verification wait starts and ends here, and an attempt waiting for
 * a tap that goes back to suspending is a re-suspend after running.
 */
export function countAudioRecoveryPhase(attempt: object, from: string, to: string): void {
  if (to === WAIT) {
    counts[CLOCK_WAITS] += 1;
    waitStarts.set(attempt, performance.now());
  } else if (from === WAIT) {
    const waited = Math.max(0, performance.now() - (waitStarts.get(attempt) ?? 0));
    counts[CLOCK_WAIT_TOTAL_MS] += waited;
    counts[CLOCK_WAIT_MAX_MS] = Math.max(counts[CLOCK_WAIT_MAX_MS], waited);
    counts[
      to === 'completed'
        ? CLOCK_CONFIRMED
        : to === 'cancelled'
          ? CLOCK_CANCELLED
          : CLOCK_RECOVERY_NEEDED
    ] += 1;
  } else if (from === 'awaiting-gesture' && to === 'preparing-suspend') {
    counts[RESUSPENDED_AFTER_RUNNING] += 1;
  }
}

type WaitingForTap = () => boolean;
type LiveSuspendLeases = (context: AudioContext) => number;
const waitingForTap: WaitingForTap[] = [];
const liveSuspendLeases: LiveSuspendLeases[] = [];

/**
 * An owner's read-only queries, registered once when its module loads. Since
 * Phase 7 7B-4 the one suspend ledger answers for the live leases, so the
 * playback scope registers its holding answer alone; since 7C-4 both register
 * from context-recovery.ts, the ledger's first.
 */
export function registerAudioRecoveryOwner(
  isWaitingForTap: WaitingForTap,
  countLiveSuspendLeases?: LiveSuspendLeases,
): void {
  waitingForTap.push(isWaitingForTap);
  if (countLiveSuspendLeases) liveSuspendLeases.push(countLiveSuspendLeases);
}

/** A native suspend on `context`; `attempts` is its attempt's suspends so far, this one included. */
export function countAudioSuspend(context: AudioContext, attempts: number): void {
  counts[SUSPEND_CALLS] += 1;
  if (attempts > 1) counts[SECOND_SUSPENDS] += 1;
  let live = 0;
  for (const query of liveSuspendLeases) live += query(context);
  counts[LEASES_AT_ONCE_MAX] = Math.max(counts[LEASES_AT_ONCE_MAX], live);
}

/**
 * UI sounds resume the context; count it, and whether an owner was waiting
 * for a tap. Since Phase 7 7B-3 UI sounds ask the same owners first and do
 * not wake a held context, so the second count stays 0 unless that rule
 * breaks.
 */
export function countUiSoundResume(): void {
  counts[RESUME_UI_SOUND] += 1;
  if (waitingForTap.some((query) => query())) counts[UI_SOUND_RESUMES_WHILE_WAITING] += 1;
}

// ── Owner decision Q4: the previous page in this tab ─────────────────
/**
 * Bump when the slots change: a kept value of another set is dropped. The
 * value is "<label set> <build> <every slot>", parsed by the lazy reader.
 */
export const AUDIO_RECOVERY_LABEL_SET = 1;

let previousPage: string | null = null;

/** The page navigation owner's pagehide callback: keep this page's counts, if any. */
export function keepAudioRecoveryForNextPage(): void {
  if (!counts.some(Boolean)) return;
  const build = typeof __MXQR_APP_VERSION__ === 'undefined' ? 'unknown' : __MXQR_APP_VERSION__;
  try {
    sessionStorage.setItem(
      PREVIOUS_AUDIO_RECOVERY_KEY,
      `${AUDIO_RECOVERY_LABEL_SET} ${build} ${counts.join(' ')}`,
    );
  } catch {
    // Refused storage only drops the next page's line.
  }
}

/**
 * Read and remove the previous page's counts once, at page start. Only a
 * reload keeps them: sessionStorage is copied into a tab opened from this
 * one, whose first page is not this tab's next page.
 */
export function takeAudioRecoveryFromPreviousPage(): void {
  try {
    const kept = sessionStorage.getItem(PREVIOUS_AUDIO_RECOVERY_KEY);
    if (kept === null) return;
    sessionStorage.removeItem(PREVIOUS_AUDIO_RECOVERY_KEY);
    const navigation = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    if (navigation?.type === 'reload') previousPage = kept;
  } catch {
    // Refused storage, or no navigation timing: no previous page line.
  }
}

/**
 * For the lazy reader: this page's slots, and the previous page's kept value
 * in this tab when this page is its reload (unparsed).
 */
export function readAudioRecoveryCounts(): readonly [
  counts: readonly number[],
  previous: string | null,
] {
  return [Array.from(counts), previousPage];
}

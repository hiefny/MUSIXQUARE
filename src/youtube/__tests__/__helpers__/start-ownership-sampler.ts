/**
 * YouTube start-ownership truth-table sampler: the public start-owner
 * queries, and the inline composites the readers build from them, sampled
 * at rest and inside transitions.
 *
 * Factories only. This module declares no vi.mock and keeps no state between
 * probes: the test file owns every module mock, and each probe is disposed by
 * its row.
 *
 * Each column maps to its live query in exactly one place
 * (START_OWNERSHIP_COLUMNS), so a later change that moves a query behind
 * another owner re-points that one entry and leaves every expected array
 * alone. Every read is pure. The composite columns compose public queries
 * exactly as the inline reader code composes them today:
 * - auxHeld: protocol || autoSync, the auxiliary YOUTUBE_STATE suppression
 *   in iframe.ts's state handler (not its nudge timer or 300 ms dedupe);
 * - beatHeld: owned || autoSync, what holds a periodic host heartbeat in
 *   sync.ts's broadcaster (not the manual-offset transaction, the manual
 *   dedupe or the nudge, which are other owners);
 * - unMuteHeld: a zero-start hard-mute phase (muting, warming, settling, read
 *   through the public snapshot) || fallback || proMute, the guard player.ts
 *   applies before a volume or PRO pause-gate unMute. This column is the
 *   sampler's own view: player.ts's phase list is private, so the column
 *   retypes it and a change to the real guard leaves the column alone.
 *   applyVolumeAndReadUnMute pins the real guard by its effect instead.
 *
 * A probe records a sample line '<ms since t0> <label> <phase> <true column
 * tokens, in column order> <playback.activity>' at these points:
 * - 'rest' after every 10 ms fake-time step, and once when the probe starts;
 * - 'step:<label>' right after a scripted action's synchronous call returns,
 *   then 'micro' after five resolved promises with no timer advance;
 * - 'notify:<state>:before' and 'notify:<state>:after' around every App
 *   iframe state notification (fake-yt-player.ts delivers it inside the
 *   command that caused it, or a task later with __stateNotifyDelayMs);
 * - 'ready@<ctx>' inside every youtube:zero-start-readiness-changed emission
 *   and 'loading:<busy|idle>:<owner|->@<ctx>' inside every
 *   youtube:sync-loading emission, where <ctx> is the innermost open step or
 *   notification, or else 'timer' inside a fake timer's callback,
 *   'timer-micro' in a microtask that callback scheduled (run before the next
 *   timer), and 'micro' in any other microtask (the flush after a step, or a
 *   step's chain that outlasts it). A source whose emission moves from its
 *   timer callback into a microtask therefore changes its line.
 * Rest, step, micro and notify lines are kept only when '<phase> <tokens>
 * <activity>' differs from the last kept line of any kind; ready and loading
 * lines are always kept, so each source's emission instant stays pinned.
 *
 * On an App host it also records the wire effects of two composites:
 * - aux: '<ms> notify:<state> <phase> sent|held' for each iframe
 *   notification, 'sent' when a broadcast youtube-state frame left during it
 *   (the phase is the one the notification arrived in);
 * - beat: '<ms> beat <phase> sent|held' at each heartbeat tick (multiples of
 *   HEARTBEAT_INTERVAL_MS after t0), 'sent' when a youtube-sync frame with
 *   isManual false left at that instant.
 */
import { MSG } from '../../../core/constants.ts';
import { bus } from '../../../core/events.ts';
import { getState } from '../../../core/state.ts';
import { HEARTBEAT_INTERVAL_MS } from '../../constants.ts';
import { proYouTubeAuthorityOwnsHardMute } from '../../iframe.ts';
import { isStandardHostYouTubeLocalStartPending } from '../../local-offset.ts';
import {
  isProPlaybackPauseGatePendingFromIframe,
  isYouTubeAutoSyncPending,
  isYouTubeZeroStartExternalFallbackActiveFromIframe,
  isYouTubeZeroStartExternalFallbackPendingFromSync,
} from '../../player-runtime-bridge.ts';
import { isGuestYouTubeTransitionPending } from '../../sync.ts';
import {
  getYouTubeZeroStartPendingCanonicalPosition,
  getYouTubeZeroStartSnapshot,
  isYouTubeZeroStartInFlight,
  isYouTubeZeroStartProtocolActive,
} from '../../zero-start.ts';
import { isYouTubeZeroStartSyncOwned } from '../../zero-start-ownership.ts';
import type { FakeYtPlayer } from './fake-yt-player.ts';
import type { ScriptedIframeApi } from './scripted-iframe-api.ts';
import type { SentFrame } from './standard-start-harness.ts';

/** The parts of the fake clock (@sinonjs/fake-timers) that runTimersFor steps with. */
interface FakeTimerClock {
  readonly now: number;
  /** Runs the first pending timer alone, at its own instant; no microtask runs. */
  next(): number;
  /**
   * Set while a tick runs. A zero-delay timer scheduled then is due 1 ms
   * later, not at once, and vi.advanceTimersByTimeAsync() keeps it set
   * between timers, so the microtasks a timer schedules see it set.
   */
  duringTick: boolean;
}

/** The clock vi.useFakeTimers() installed; fake-timers hangs it on the faked setTimeout. */
function installedFakeClock(): FakeTimerClock {
  const clock = (globalThis.setTimeout as unknown as { clock?: FakeTimerClock }).clock;
  if (typeof clock?.next !== 'function') {
    throw new Error('start-ownership sampler: install vi.useFakeTimers() before advancing');
  }
  return clock;
}

/**
 * The host's own setImmediate, read when this module loads (before a test
 * installs fake timers), which the fake clock also uses between timers.
 */
const nativeSetImmediate = globalThis.setImmediate;

/** One native task: every microtask queued before it has run when it resolves. */
function nativeTask(): Promise<void> {
  if ('clock' in nativeSetImmediate) {
    throw new Error('start-ownership sampler: loaded while fake timers were installed');
  }
  return new Promise((resolve) => {
    nativeSetImmediate(() => resolve());
  });
}

/** The zero-start phases in which player.ts's own hard-mute guard holds an unMute. */
const ZERO_START_HARD_MUTE_PHASES: ReadonlySet<string> = new Set(['muting', 'warming', 'settling']);

function zeroStartPhase(): string {
  return getYouTubeZeroStartSnapshot()?.phase ?? 'none';
}

/** The truth-table columns, in line order: token and the live query it reads. */
export const START_OWNERSHIP_COLUMNS: ReadonlyArray<readonly [string, () => boolean]> = [
  ['owned', () => isYouTubeZeroStartSyncOwned()],
  ['inFlight', () => isYouTubeZeroStartInFlight()],
  ['protocol', () => isYouTubeZeroStartProtocolActive()],
  ['fallback', () => isYouTubeZeroStartExternalFallbackActiveFromIframe()],
  ['fallbackPending', () => isYouTubeZeroStartExternalFallbackPendingFromSync()],
  ['autoSync', () => isYouTubeAutoSyncPending()],
  ['hostHold', () => isStandardHostYouTubeLocalStartPending()],
  ['heldAt', () => getYouTubeZeroStartPendingCanonicalPosition() !== null],
  ['guestPending', () => isGuestYouTubeTransitionPending()],
  ['proMute', () => proYouTubeAuthorityOwnsHardMute()],
  ['pauseGate', () => isProPlaybackPauseGatePendingFromIframe()],
  ['auxHeld', () => isYouTubeZeroStartProtocolActive() || isYouTubeAutoSyncPending()],
  ['beatHeld', () => isYouTubeZeroStartSyncOwned() || isYouTubeAutoSyncPending()],
  [
    'unMuteHeld',
    () =>
      ZERO_START_HARD_MUTE_PHASES.has(zeroStartPhase()) ||
      isYouTubeZeroStartExternalFallbackActiveFromIframe() ||
      proYouTubeAuthorityOwnsHardMute(),
  ],
];

export interface StartOwnershipSample {
  /** The App's zero-start phase ('none' without a controller). */
  readonly phase: string;
  /** The tokens of the true columns, in column order. */
  readonly tokens: readonly string[];
  readonly activity: string;
}

/** Every column, the zero-start phase and playback.activity, read now. */
export function sampleStartOwnership(): StartOwnershipSample {
  return {
    phase: zeroStartPhase(),
    tokens: START_OWNERSHIP_COLUMNS.filter(([, read]) => read()).map(([token]) => token),
    activity: String(getState('playback.activity')),
  };
}

function formatSample({ phase, tokens, activity }: StartOwnershipSample): string {
  return [phase, ...tokens, activity].join(' ');
}

/**
 * Apply the App's own volume change now (youtube:set-volume, to
 * `volumePercent`) and report '<ms> <phase> column:<held|free>
 * iframe:<unMute|none>': whether the unMuteHeld column holds an unMute at
 * this instant, and whether `fake` received unMute() inside the change. The
 * second half is player.ts's real guard, read by its effect.
 */
export function applyVolumeAndReadUnMute(
  fake: FakeYtPlayer,
  nowMs: number,
  volumePercent = 50,
): string {
  const { phase, tokens } = sampleStartOwnership();
  const from = fake.__log.length;
  bus.emit('youtube:set-volume', volumePercent);
  const unMuted = fake.__log.slice(from).some(({ op }) => op === 'unMute');
  const column = tokens.includes('unMuteHeld') ? 'held' : 'free';
  return `${nowMs} ${phase} column:${column} iframe:${unMuted ? 'unMute' : 'none'}`;
}

export interface StartOwnershipProbeOptions {
  /** The scripted IFrame API whose iframes are the App's. */
  readonly api: ScriptedIframeApi;
  /** Frames the App sent (the rig's recorder); needed for the host effects. */
  readonly sent?: readonly SentFrame[];
  /** Milliseconds since the row's t0. */
  readonly now: () => number;
  /** Record the aux and beat wire effects (App host rows only). */
  readonly isHost: boolean;
}

export interface StartOwnershipProbe {
  readonly samples: string[];
  readonly aux: string[];
  readonly beat: string[];
  /** Run one scripted action synchronously, then flush five microtasks. */
  step(label: string, run: () => void): Promise<void>;
  /** Advance fake time to t0 + relativeMs in 10 ms steps. */
  advanceTo(relativeMs: number): Promise<void>;
  dispose(): void;
}

/**
 * Start sampling now. Register it after the App's own listeners (that is,
 * after the rig is set up), so a ready or loading line reads what the App's
 * listeners just saw.
 */
export function probeStartOwnership(options: StartOwnershipProbeOptions): StartOwnershipProbe {
  const samples: string[] = [];
  const aux: string[] = [];
  const beat: string[] = [];
  const contexts: string[] = [];
  const restorers: Array<() => void> = [];
  const wrapped = new WeakSet<FakeYtPlayer>();
  // Outside a step, a notification and a timer advance, only a microtask can run.
  let ambient = 'micro';
  let lastState: string | null = null;

  const context = () => contexts.at(-1) ?? ambient;

  /**
   * Advance fake time by `ms`, one timer callback at a time: each callback
   * runs alone with ambient 'timer', then one native task drains the
   * microtasks it scheduled with ambient 'timer-micro', before the next
   * callback. This is the order vi.advanceTimersByTimeAsync() runs them in
   * (a native task after each timer), with the two kinds of work told apart.
   * Microtasks still pending when the advance starts (a step's chain longer
   * than its five flushes) run first, with ambient 'micro'. The drain keeps
   * the clock's duringTick flag set as that tick does, so a zero-delay timer
   * a timer's microtask schedules (the rig's one-task link, for one) is due
   * 1 ms later, as before.
   */
  async function runTimersFor(ms: number): Promise<void> {
    const clock = installedFakeClock();
    const target = clock.now + ms;
    await nativeTask();
    // A sentinel at the target bounds clock.next(). A timer that a callback
    // schedules for the target instant itself sorts after the sentinel, so
    // another pass runs until a sentinel fires with nothing before it.
    for (let pass = 0; ; pass += 1) {
      let reached = false;
      let ranOther = false;
      setTimeout(() => {
        reached = true;
      }, target - clock.now);
      for (;;) {
        ambient = 'timer';
        try {
          clock.next();
        } finally {
          ambient = 'timer-micro';
        }
        // The sentinel queues nothing, so it takes no native task: the count
        // stays one per timer, as in the fake clock's own tick, and work that
        // waits on native tasks keeps its pace in fake time.
        if (reached) break;
        ranOther = true;
        clock.duringTick = true;
        try {
          await nativeTask();
        } finally {
          clock.duringTick = false;
        }
      }
      ambient = 'micro';
      if (pass > 0 && !ranOther) return;
    }
  }
  const keep = (label: string, always = false) => {
    wrapNewIframes();
    const state = formatSample(sampleStartOwnership());
    if (!always && state === lastState) return;
    lastState = state;
    samples.push(`${options.now()} ${label} ${state}`);
  };

  function wrapNewIframes(): void {
    for (const { fake } of options.api.iframes) {
      if (wrapped.has(fake)) continue;
      wrapped.add(fake);
      const original = fake.__onStateChange;
      restorers.push(() => {
        fake.__onStateChange = original;
      });
      fake.__onStateChange = (event) => {
        const label = `notify:${event.data}`;
        const sentFrom = options.sent?.length ?? 0;
        const auxIndex = options.isHost ? aux.push('') - 1 : -1;
        const arrivedIn = zeroStartPhase();
        const at = options.now();
        keep(`${label}:before`);
        contexts.push(label);
        try {
          original?.(event);
        } finally {
          contexts.pop();
        }
        keep(`${label}:after`);
        if (auxIndex >= 0) {
          const stateSent = (options.sent ?? [])
            .slice(sentFrom)
            .some(({ via, type }) => via === 'broadcast' && type === MSG.YOUTUBE_STATE);
          aux[auxIndex] = `${at} ${label} ${arrivedIn} ${stateSent ? 'sent' : 'held'}`;
        }
      };
    }
  }

  const offReady = bus.on('youtube:zero-start-readiness-changed', () => {
    keep(`ready@${context()}`, true);
  });
  const offLoading = bus.on('youtube:sync-loading', (busy, owner) => {
    keep(`loading:${busy ? 'busy' : 'idle'}:${owner ?? '-'}@${context()}`, true);
  });
  keep('rest');

  return {
    samples,
    aux,
    beat,
    async step(label, run) {
      contexts.push(`step:${label}`);
      try {
        run();
      } finally {
        contexts.pop();
      }
      keep(`step:${label}`);
      for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
      keep('micro');
    },
    async advanceTo(relativeMs) {
      while (options.now() < relativeMs) {
        await runTimersFor(Math.min(10, relativeMs - options.now()));
        keep('rest');
        const at = options.now();
        if (options.isHost && at > 0 && at % HEARTBEAT_INTERVAL_MS === 0) {
          const beatSent = (options.sent ?? []).some(
            ({ type, frame, at: sentAt }) =>
              type === MSG.YOUTUBE_SYNC && frame.isManual === false && sentAt === at,
          );
          beat.push(`${at} beat ${zeroStartPhase()} ${beatSent ? 'sent' : 'held'}`);
        }
      }
    },
    dispose() {
      offReady();
      offLoading();
      for (const restore of restorers.splice(0)) restore();
    },
  };
}

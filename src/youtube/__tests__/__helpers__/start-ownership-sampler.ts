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
 *   applies before a volume or PRO pause-gate unMute.
 *
 * A probe records a sample line '<ms since t0> <label> <phase> <true column
 * tokens, in column order> <playback.activity>' at these points:
 * - 'rest' after every 10 ms fake-time step, and once when the probe starts;
 * - 'step:<label>' right after a scripted action's synchronous call returns,
 *   then 'micro' after five resolved promises with no timer advance;
 * - 'notify:<state>:before' and 'notify:<state>:after' around every App
 *   iframe state notification (fake-yt-player.ts calls it synchronously from
 *   the command that caused it);
 * - 'ready@<ctx>' inside every youtube:zero-start-readiness-changed emission
 *   and 'loading:<busy|idle>:<owner|->@<ctx>' inside every
 *   youtube:sync-loading emission, where <ctx> is the innermost open step or
 *   notification, or else 'timer' while fake time advances and 'micro'
 *   otherwise (a microtask that runs with no timer advance, such as the
 *   flush after a step).
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
import { vi } from 'vitest';
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
        ambient = 'timer';
        try {
          await vi.advanceTimersByTimeAsync(Math.min(10, relativeMs - options.now()));
        } finally {
          ambient = 'micro';
        }
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

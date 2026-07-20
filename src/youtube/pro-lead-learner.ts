/**
 * Participant-local YouTube lead learning for coordinator-free PRO rooms.
 *
 * This module deliberately has no player, DOM, timer, storage, or transport
 * dependency. Callers collect two server-timeline drift samples from the same
 * immutable playback occurrence and pass the eligibility facts explicitly.
 * A successful round affects only the lead returned for a future start; it
 * can never seek or otherwise mutate the currently playing iframe.
 */

export type ProYouTubeLeadPlatform = 'ios' | 'android' | 'other';

export const PRO_YOUTUBE_LEAD_SAMPLE_EARLY_MS = 800 as const;
export const PRO_YOUTUBE_LEAD_SAMPLE_LATE_MS = 2_000 as const;

export interface ProYouTubeLeadSample {
  /** Only the two bounded post-start checkpoints are accepted. */
  checkpointMs: typeof PRO_YOUTUBE_LEAD_SAMPLE_EARLY_MS | typeof PRO_YOUTUBE_LEAD_SAMPLE_LATE_MS;
  /** Local canonical timeline minus the server-predicted canonical timeline. */
  timelineDriftMs: number;
  /** Visibility is supplied by the caller; this module never reads the DOM. */
  visible: boolean;
  /** True while the iframe is buffering rather than advancing normally. */
  buffering: boolean;
  /** YouTube ad playback is not a valid sample of the content timeline. */
  adActive: boolean;
  /** The resident video/queue occurrence still matches the sampled run. */
  identityMatches: boolean;
  /** The sampled server playback revision is still current. */
  revisionMatches: boolean;
}

interface ProYouTubeLeadRound {
  early: Readonly<ProYouTubeLeadSample>;
  late: Readonly<ProYouTubeLeadSample>;
}

interface ProYouTubeLeadState {
  platform: ProYouTubeLeadPlatform;
  /** Fixed audible-output seed. Timeline observations never rewrite it. */
  audibleBaseLeadMs: number;
  /** Session-local learned correction applied in addition to the base. */
  timelineLeadMs: number;
  /** Rounded scheduling lead for the next eligible zero-start. */
  totalLeadMs: number;
  acceptedRounds: number;
}

type ProYouTubeLeadRejectionReason = 'invalid-sample' | 'ineligible-sample' | 'unstable-samples';

type ProYouTubeLeadLearningResult =
  | {
      accepted: false;
      updated: false;
      reason: ProYouTubeLeadRejectionReason;
      state: ProYouTubeLeadState;
    }
  | {
      accepted: true;
      updated: boolean;
      reason: 'deadband' | 'updated';
      state: ProYouTubeLeadState;
      stableTimelineDriftMs: number;
      estimatedTimelineErrorMs: number;
      appliedTimelineDeltaMs: number;
    };

const AUDIBLE_BASE_LEAD_MS: Readonly<Record<ProYouTubeLeadPlatform, number>> = Object.freeze({
  ios: 0,
  android: 250,
  other: 0,
});

const GENERAL_STABILITY_LIMIT_MS = 60;
const ANDROID_STABILITY_LIMIT_MS = 25;
const GENERAL_EMA_RATE = 0.25;
const ANDROID_EMA_RATE = 0.35;
const ANDROID_ERROR_DEADBAND_MS = 15;
const MAX_ROUND_CHANGE_MS = 50;
const MAX_TIMELINE_LEAD_MS = 300;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function copyState(state: Readonly<ProYouTubeLeadState>): ProYouTubeLeadState {
  return {
    platform: state.platform,
    audibleBaseLeadMs: state.audibleBaseLeadMs,
    timelineLeadMs: state.timelineLeadMs,
    totalLeadMs: state.totalLeadMs,
    acceptedRounds: state.acceptedRounds,
  };
}

function sampleIsEligible(sample: Readonly<ProYouTubeLeadSample>): boolean {
  return (
    sample.visible &&
    !sample.buffering &&
    !sample.adActive &&
    sample.identityMatches &&
    sample.revisionMatches
  );
}

function samplesHaveExpectedShape(round: Readonly<ProYouTubeLeadRound>): boolean {
  return (
    round.early.checkpointMs === PRO_YOUTUBE_LEAD_SAMPLE_EARLY_MS &&
    round.late.checkpointMs === PRO_YOUTUBE_LEAD_SAMPLE_LATE_MS &&
    Number.isFinite(round.early.timelineDriftMs) &&
    Number.isFinite(round.late.timelineDriftMs)
  );
}

export function getProYouTubeAudibleBaseLeadMs(platform: ProYouTubeLeadPlatform): number {
  return AUDIBLE_BASE_LEAD_MS[platform];
}

function createProYouTubeLeadState(platform: ProYouTubeLeadPlatform): ProYouTubeLeadState {
  const audibleBaseLeadMs = getProYouTubeAudibleBaseLeadMs(platform);
  return {
    platform,
    audibleBaseLeadMs,
    timelineLeadMs: 0,
    totalLeadMs: audibleBaseLeadMs,
    acceptedRounds: 0,
  };
}

/**
 * Apply one complete 0.8s/2.0s observation round.
 *
 * The fixed audible base is subtracted before the EMA so an Android timeline
 * that is intentionally about 250ms ahead is treated as aligned, not as an
 * error to remove. The returned correction is for a later start only.
 */
function learnProYouTubeLead(
  current: Readonly<ProYouTubeLeadState>,
  round: Readonly<ProYouTubeLeadRound>,
): ProYouTubeLeadLearningResult {
  const state = copyState(current);
  const audibleBaseLeadMs = getProYouTubeAudibleBaseLeadMs(state.platform);
  state.audibleBaseLeadMs = audibleBaseLeadMs;
  state.timelineLeadMs = clamp(
    Number.isFinite(state.timelineLeadMs) ? state.timelineLeadMs : 0,
    -MAX_TIMELINE_LEAD_MS,
    MAX_TIMELINE_LEAD_MS,
  );
  state.totalLeadMs = Math.round(audibleBaseLeadMs + state.timelineLeadMs);

  if (!samplesHaveExpectedShape(round)) {
    return { accepted: false, updated: false, reason: 'invalid-sample', state };
  }
  if (!sampleIsEligible(round.early) || !sampleIsEligible(round.late)) {
    return { accepted: false, updated: false, reason: 'ineligible-sample', state };
  }

  const android = state.platform === 'android';
  const stabilityLimitMs = android ? ANDROID_STABILITY_LIMIT_MS : GENERAL_STABILITY_LIMIT_MS;
  if (Math.abs(round.early.timelineDriftMs - round.late.timelineDriftMs) > stabilityLimitMs) {
    return { accepted: false, updated: false, reason: 'unstable-samples', state };
  }

  const stableTimelineDriftMs = (round.early.timelineDriftMs + round.late.timelineDriftMs) / 2;
  const estimatedTimelineErrorMs = stableTimelineDriftMs - audibleBaseLeadMs;
  state.acceptedRounds += 1;

  if (android && Math.abs(estimatedTimelineErrorMs) < ANDROID_ERROR_DEADBAND_MS) {
    return {
      accepted: true,
      updated: false,
      reason: 'deadband',
      state,
      stableTimelineDriftMs,
      estimatedTimelineErrorMs,
      appliedTimelineDeltaMs: 0,
    };
  }

  const emaRate = android ? ANDROID_EMA_RATE : GENERAL_EMA_RATE;
  const requestedDeltaMs = clamp(
    -estimatedTimelineErrorMs * emaRate,
    -MAX_ROUND_CHANGE_MS,
    MAX_ROUND_CHANGE_MS,
  );
  const previousTimelineLeadMs = state.timelineLeadMs;
  state.timelineLeadMs = clamp(
    previousTimelineLeadMs + requestedDeltaMs,
    -MAX_TIMELINE_LEAD_MS,
    MAX_TIMELINE_LEAD_MS,
  );
  state.totalLeadMs = Math.round(audibleBaseLeadMs + state.timelineLeadMs);
  const appliedTimelineDeltaMs = state.timelineLeadMs - previousTimelineLeadMs;

  return {
    accepted: true,
    updated: appliedTimelineDeltaMs !== 0,
    reason: 'updated',
    state,
    stableTimelineDriftMs,
    estimatedTimelineErrorMs,
    appliedTimelineDeltaMs,
  };
}

/**
 * Session-memory wrapper for the pure learning function.
 *
 * One instance belongs to one browser endpoint. Nothing is written to
 * localStorage, IndexedDB, cookies, an account, or the room server.
 */
export class ProYouTubeLeadSession {
  readonly #states = new Map<ProYouTubeLeadPlatform, ProYouTubeLeadState>();

  get(platform: ProYouTubeLeadPlatform): ProYouTubeLeadState {
    const state = this.#states.get(platform) ?? createProYouTubeLeadState(platform);
    if (!this.#states.has(platform)) this.#states.set(platform, state);
    return copyState(state);
  }

  learn(
    platform: ProYouTubeLeadPlatform,
    round: Readonly<ProYouTubeLeadRound>,
  ): ProYouTubeLeadLearningResult {
    const result = learnProYouTubeLead(this.get(platform), round);
    if (result.accepted) this.#states.set(platform, copyState(result.state));
    return { ...result, state: copyState(result.state) };
  }

  clear(): void {
    this.#states.clear();
  }
}

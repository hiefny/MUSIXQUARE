import { describe, expect, it } from 'vitest';
import {
  PRO_YOUTUBE_LEAD_SAMPLE_EARLY_MS,
  PRO_YOUTUBE_LEAD_SAMPLE_LATE_MS,
  ProYouTubeLeadSession,
  getProYouTubeAudibleBaseLeadMs,
  type ProYouTubeLeadSample,
} from '../pro-lead-learner.ts';

type ProYouTubeLeadRound = Parameters<ProYouTubeLeadSession['learn']>[1];

function sample(
  checkpointMs: 800 | 2_000,
  timelineDriftMs: number,
  overrides: Partial<ProYouTubeLeadSample> = {},
): ProYouTubeLeadSample {
  return {
    checkpointMs,
    timelineDriftMs,
    visible: true,
    buffering: false,
    adActive: false,
    identityMatches: true,
    revisionMatches: true,
    ...overrides,
  };
}

function round(
  earlyDriftMs: number,
  lateDriftMs: number,
  earlyOverrides: Partial<ProYouTubeLeadSample> = {},
  lateOverrides: Partial<ProYouTubeLeadSample> = {},
): ProYouTubeLeadRound {
  return {
    early: sample(PRO_YOUTUBE_LEAD_SAMPLE_EARLY_MS, earlyDriftMs, earlyOverrides),
    late: sample(PRO_YOUTUBE_LEAD_SAMPLE_LATE_MS, lateDriftMs, lateOverrides),
  };
}

function learnFresh(platform: 'ios' | 'android' | 'other', samples: ProYouTubeLeadRound) {
  return new ProYouTubeLeadSession().learn(platform, samples);
}

describe('PRO YouTube per-device lead learner', () => {
  it('keeps the audible platform seed separate from the learned timeline lead', () => {
    expect(getProYouTubeAudibleBaseLeadMs('ios')).toBe(0);
    expect(getProYouTubeAudibleBaseLeadMs('android')).toBe(250);
    expect(getProYouTubeAudibleBaseLeadMs('other')).toBe(0);

    expect(new ProYouTubeLeadSession().get('ios')).toMatchObject({
      audibleBaseLeadMs: 0,
      timelineLeadMs: 0,
      totalLeadMs: 0,
    });
    expect(new ProYouTubeLeadSession().get('android')).toMatchObject({
      audibleBaseLeadMs: 250,
      timelineLeadMs: 0,
      totalLeadMs: 250,
    });
  });

  it('learns from a stable general-platform 0.8s/2.0s pair with EMA 0.25', () => {
    const result = learnFresh('other', round(-100, -80));

    expect(result).toMatchObject({
      accepted: true,
      updated: true,
      reason: 'updated',
      stableTimelineDriftMs: -90,
      estimatedTimelineErrorMs: -90,
      appliedTimelineDeltaMs: 22.5,
      state: {
        audibleBaseLeadMs: 0,
        timelineLeadMs: 22.5,
        totalLeadMs: 23,
        acceptedRounds: 1,
      },
    });
  });

  it('uses Android stability 25ms and EMA 0.35 without rewriting the 250ms base', () => {
    const accepted = learnFresh('android', round(190, 210));
    expect(accepted).toMatchObject({
      accepted: true,
      updated: true,
      stableTimelineDriftMs: 200,
      estimatedTimelineErrorMs: -50,
      appliedTimelineDeltaMs: 17.5,
      state: {
        audibleBaseLeadMs: 250,
        timelineLeadMs: 17.5,
        totalLeadMs: 268,
      },
    });

    const rejected = learnFresh('android', round(190, 216));
    expect(rejected).toMatchObject({
      accepted: false,
      reason: 'unstable-samples',
      state: { audibleBaseLeadMs: 250, timelineLeadMs: 0, acceptedRounds: 0 },
    });
  });

  it('accepts the Android pair but makes no change inside the 15ms deadband', () => {
    const result = learnFresh('android', round(258, 260));

    expect(result).toMatchObject({
      accepted: true,
      updated: false,
      reason: 'deadband',
      stableTimelineDriftMs: 259,
      estimatedTimelineErrorMs: 9,
      appliedTimelineDeltaMs: 0,
      state: { audibleBaseLeadMs: 250, timelineLeadMs: 0, totalLeadMs: 250 },
    });
  });

  it('rejects a general-platform pair whose two samples differ by more than 60ms', () => {
    const result = learnFresh('ios', round(-10, 51));

    expect(result).toMatchObject({
      accepted: false,
      updated: false,
      reason: 'unstable-samples',
      state: { timelineLeadMs: 0, acceptedRounds: 0 },
    });
  });

  it.each([
    ['hidden', { visible: false }],
    ['buffering', { buffering: true }],
    ['ad', { adActive: true }],
    ['identity mismatch', { identityMatches: false }],
    ['revision mismatch', { revisionMatches: false }],
  ])('rejects an otherwise stable %s sample', (_label, overrides) => {
    const result = learnFresh('other', round(-40, -40, overrides));

    expect(result).toMatchObject({
      accepted: false,
      updated: false,
      reason: 'ineligible-sample',
      state: { timelineLeadMs: 0, acceptedRounds: 0 },
    });
  });

  it('rejects non-finite or incorrectly checkpointed observations', () => {
    const nonFinite = learnFresh('other', round(Number.NaN, 0));
    expect(nonFinite.reason).toBe('invalid-sample');

    const validRound = round(0, 0);
    const wrongCheckpoint: ProYouTubeLeadRound = {
      early: { ...validRound.early, checkpointMs: PRO_YOUTUBE_LEAD_SAMPLE_LATE_MS },
      late: validRound.late,
    };
    const misplaced = learnFresh('other', wrongCheckpoint);
    expect(misplaced.reason).toBe('invalid-sample');
  });

  it('bounds each round to 50ms and the session timeline lead to 300ms', () => {
    const session = new ProYouTubeLeadSession();

    const first = session.learn('other', round(-1_000, -1_000));
    expect(first).toMatchObject({
      accepted: true,
      appliedTimelineDeltaMs: 50,
      state: { timelineLeadMs: 50, totalLeadMs: 50 },
    });

    for (let index = 0; index < 8; index += 1) {
      session.learn('other', round(-1_000, -1_000));
    }
    expect(session.get('other')).toMatchObject({ timelineLeadMs: 300, totalLeadMs: 300 });

    const capped = session.learn('other', round(-1_000, -1_000));
    expect(capped).toMatchObject({
      accepted: true,
      updated: false,
      appliedTimelineDeltaMs: 0,
      state: { timelineLeadMs: 300 },
    });
  });

  it('keeps accepted learning only in the session instance and clears back to the seed', () => {
    const firstSession = new ProYouTubeLeadSession();
    firstSession.learn('android', round(190, 210));
    expect(firstSession.get('android').timelineLeadMs).toBe(17.5);

    const separateSession = new ProYouTubeLeadSession();
    expect(separateSession.get('android')).toMatchObject({
      audibleBaseLeadMs: 250,
      timelineLeadMs: 0,
      totalLeadMs: 250,
    });

    firstSession.clear();
    expect(firstSession.get('android')).toMatchObject({
      audibleBaseLeadMs: 250,
      timelineLeadMs: 0,
      totalLeadMs: 250,
      acceptedRounds: 0,
    });
  });
});

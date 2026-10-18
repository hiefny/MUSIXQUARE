/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStandardStartObservations,
  resetStandardStartObservations,
} from '../../diagnostics/standard-start-observations.ts';
import {
  recordAutomaticRealignObservation,
  resetAutomaticRealignObservations,
} from '../automatic-realign-observations.ts';
import { STANDARD_AUTO_REALIGN_DRIFT_THRESHOLD_MS } from '../constants.ts';

function observation() {
  return {
    occurrenceKey: 'private-room-peer-queue-video',
    stage: 'blocked' as const,
    reason: 'uncertainty',
    driftMs: -300,
    triggerMs: STANDARD_AUTO_REALIGN_DRIFT_THRESHOLD_MS,
    clock: {
      epoch: 3,
      offsetMs: -20,
      rttMs: 218,
      selectedAgeMs: 100,
      newestSampleAgeMs: 50,
      uncertaintyMs: 114,
    },
  };
}

beforeEach(() => {
  resetAutomaticRealignObservations();
  resetStandardStartObservations();
  vi.spyOn(performance, 'now').mockReturnValue(0);
});

afterEach(() => {
  resetAutomaticRealignObservations();
  resetStandardStartObservations();
  vi.restoreAllMocks();
});

describe('automatic realign observations', () => {
  it('records fixed numeric evidence without the occurrence identity or extra fields', () => {
    const input = {
      ...observation(),
      roomId: 'private-room',
      message: 'https://private.example/video',
    };
    recordAutomaticRealignObservation(input);
    expect(getStandardStartObservations().playback[0]).toMatchObject({
      kind: 'youtube-automatic-realign-blocked',
      detail: {
        reason: 'uncertainty',
        epoch: 3,
        selectedOffsetMs: -20,
        selectedRttMs: 218,
        selectedAgeMs: 100,
        newestSampleAgeMs: 50,
        uncertaintyMs: 114,
        timelineDriftMs: -300,
        triggerMs: STANDARD_AUTO_REALIGN_DRIFT_THRESHOLD_MS,
      },
    });
    expect(JSON.stringify(getStandardStartObservations())).not.toContain('private');
  });

  it('dedupes each blocked reason for 20 seconds without extending its deadline on every beat', () => {
    recordAutomaticRealignObservation(observation());
    vi.mocked(performance.now).mockReturnValue(10_000);
    recordAutomaticRealignObservation(observation());
    recordAutomaticRealignObservation({ ...observation(), reason: 'replies-stale' });
    recordAutomaticRealignObservation(observation());
    vi.mocked(performance.now).mockReturnValue(19_999);
    recordAutomaticRealignObservation(observation());
    expect(getStandardStartObservations().playback.map((item) => item.detail.reason)).toEqual([
      'uncertainty',
      'replies-stale',
    ]);
    vi.mocked(performance.now).mockReturnValue(20_000);
    recordAutomaticRealignObservation(observation());
    recordAutomaticRealignObservation({ ...observation(), reason: 'replies-stale' });
    expect(getStandardStartObservations().playback).toHaveLength(3);
  });

  it('records every admitted/recovery event while preserving blocked dedupe', () => {
    recordAutomaticRealignObservation(observation());
    for (let index = 0; index < 2; index += 1) {
      recordAutomaticRealignObservation({
        ...observation(),
        stage: 'admitted',
        reason: 'admitted',
      });
      recordAutomaticRealignObservation({
        ...observation(),
        stage: 'recovery',
        reason: 'late-release',
      });
    }
    recordAutomaticRealignObservation(observation());
    expect(getStandardStartObservations().playback).toHaveLength(5);
  });

  it('resets dedupe for a new current occurrence and explicit reset, retaining prior evidence', () => {
    recordAutomaticRealignObservation(observation());
    recordAutomaticRealignObservation({ ...observation(), occurrenceKey: 'new-private-video' });
    expect(getStandardStartObservations().playback).toHaveLength(2);
    resetAutomaticRealignObservations();
    recordAutomaticRealignObservation({ ...observation(), occurrenceKey: 'new-private-video' });
    expect(getStandardStartObservations().playback).toHaveLength(3);
  });

  it('uses monotonic TTL despite wall-clock changes and recovers from a backwards test clock', () => {
    vi.mocked(performance.now).mockReturnValue(100);
    recordAutomaticRealignObservation(observation());
    vi.spyOn(Date, 'now').mockReturnValue(0);
    vi.mocked(performance.now).mockReturnValue(20_099);
    recordAutomaticRealignObservation(observation());
    expect(getStandardStartObservations().playback).toHaveLength(1);
    vi.mocked(performance.now).mockReturnValue(20_100);
    recordAutomaticRealignObservation(observation());
    vi.mocked(performance.now).mockReturnValue(0);
    recordAutomaticRealignObservation(observation());
    expect(getStandardStartObservations().playback).toHaveLength(3);
  });

  it('normalizes nonfinite metrics and retains unknown quality as null', () => {
    recordAutomaticRealignObservation({
      ...observation(),
      driftMs: Number.NaN,
      triggerMs: Number.POSITIVE_INFINITY,
      clock: {
        epoch: Number.NaN,
        offsetMs: Number.NEGATIVE_INFINITY,
        rttMs: null,
        selectedAgeMs: Number.NaN,
        newestSampleAgeMs: null,
        uncertaintyMs: Number.POSITIVE_INFINITY,
      },
    });
    expect(getStandardStartObservations().playback[0].detail).toEqual({
      reason: 'uncertainty',
      epoch: null,
      selectedOffsetMs: null,
      selectedRttMs: null,
      selectedAgeMs: null,
      newestSampleAgeMs: null,
      uncertaintyMs: null,
      timelineDriftMs: null,
      triggerMs: null,
    });
  });

  it('drops invalid or mismatched categories without consuming dedupe or logging strings', () => {
    recordAutomaticRealignObservation({ ...observation(), reason: 'https://private.example' });
    recordAutomaticRealignObservation({ ...observation(), reason: 'recovery' });
    recordAutomaticRealignObservation({ ...observation(), stage: 'admitted' });
    recordAutomaticRealignObservation({ ...observation(), stage: 'recovery' });
    expect(getStandardStartObservations().playback).toHaveLength(0);
    recordAutomaticRealignObservation(observation());
    expect(getStandardStartObservations().playback).toHaveLength(1);
  });

  it('drops an invalid monotonic reading without poisoning later recording', () => {
    vi.mocked(performance.now).mockReturnValue(Number.NaN);
    recordAutomaticRealignObservation(observation());
    vi.mocked(performance.now).mockReturnValue(0);
    expect(getStandardStartObservations().playback).toHaveLength(0);
    recordAutomaticRealignObservation(observation());
    expect(getStandardStartObservations().playback).toHaveLength(1);
  });

  it('has no network, persistent storage, timers, or console side effects', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const logs = ['log', 'debug', 'info', 'warn', 'error'].map((method) =>
      vi.spyOn(console, method as 'log'),
    );
    recordAutomaticRealignObservation(observation());
    resetAutomaticRealignObservations();
    expect(fetch).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

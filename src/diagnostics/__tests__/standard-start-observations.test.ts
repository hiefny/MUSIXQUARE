/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStandardStartObservations,
  recordStandardStartObservation,
  resetStandardStartObservations,
} from '../standard-start-observations.ts';

beforeEach(() => {
  resetStandardStartObservations();
});

afterEach(() => {
  resetStandardStartObservations();
  vi.restoreAllMocks();
});

describe('Standard start observations', () => {
  it('bounds clock and playback independently and preserves each ring order', () => {
    recordStandardStartObservation('youtube-rendezvous-start', { operationId: 0 });
    for (let selectedSampleId = 0; selectedSampleId < 1_300; selectedSampleId += 1) {
      recordStandardStartObservation('clock-selection', { selectedSampleId });
    }
    let snapshot = getStandardStartObservations();
    expect(snapshot.clock).toHaveLength(1_200);
    expect(snapshot.clock[0].detail.selectedSampleId).toBe(100);
    expect(snapshot.clock.at(-1)?.detail.selectedSampleId).toBe(1_299);
    expect(snapshot.playback.map((record) => record.detail.operationId)).toEqual([0]);

    for (let operationId = 1; operationId < 600; operationId += 1) {
      recordStandardStartObservation('youtube-rendezvous-release', { operationId });
    }
    snapshot = getStandardStartObservations();
    expect(snapshot.playback).toHaveLength(512);
    expect(snapshot.playback[0].detail.operationId).toBe(88);
    expect(snapshot.playback.at(-1)?.detail.operationId).toBe(599);
    expect(snapshot.clock).toHaveLength(1_200);
    expect(snapshot.clock[0].detail.selectedSampleId).toBe(100);
  });

  it('expires both families by monotonic time on reads despite wall-clock changes', () => {
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(100);
    recordStandardStartObservation('clock-selection', { selectedSampleId: 1 });
    recordStandardStartObservation('youtube-rendezvous-start', { operationId: 1 });
    vi.spyOn(Date, 'now').mockReturnValue(0);
    monotonic.mockReturnValue(20 * 60 * 1_000 + 100);
    expect(getStandardStartObservations().clock).toHaveLength(1);
    expect(getStandardStartObservations().playback).toHaveLength(1);
    monotonic.mockReturnValue(20 * 60 * 1_000 + 101);
    expect(getStandardStartObservations()).toEqual({ clock: [], playback: [] });
  });

  it('prunes expired records when a new observation is written', () => {
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
    recordStandardStartObservation('clock-continuity', { epoch: 1 });
    recordStandardStartObservation('youtube-rendezvous-release', { operationId: 1 });
    monotonic.mockReturnValue(20 * 60 * 1_000 + 1);
    recordStandardStartObservation('clock-selection', { epoch: 2 });
    // A read at the old time cannot itself expire the old records. Their
    // absence therefore proves pruning occurred during the preceding write.
    monotonic.mockReturnValue(0);
    const snapshot = getStandardStartObservations();
    expect(snapshot.clock.map((record) => record.detail.epoch)).toEqual([2]);
    expect(snapshot.playback).toEqual([]);
  });

  it('copies input, both snapshot arrays, records, and primitive details', () => {
    const detail = { operationId: 1, releaseLatenessMs: 30 };
    recordStandardStartObservation('youtube-rendezvous-release', detail);
    recordStandardStartObservation('clock-selection', { epoch: 1 });
    detail.releaseLatenessMs = 90;
    const first = getStandardStartObservations();
    first.playback[0].detail.releaseLatenessMs = 88;
    first.playback[0].kind = 'changed';
    first.playback.length = 0;
    first.clock[0].detail.epoch = 99;
    first.clock.length = 0;
    const second = getStandardStartObservations();
    expect(second.playback[0]).toMatchObject({
      kind: 'youtube-rendezvous-release',
      detail: { operationId: 1, releaseLatenessMs: 30 },
    });
    expect(second.clock[0].detail.epoch).toBe(1);
  });

  it('keeps only finite metrics and fixed categories without raw identities', () => {
    const privateValue = 'private-room-peer-video-filename';
    recordStandardStartObservation('youtube-rendezvous-sample', {
      operationId: 2,
      releaseLatenessMs: Number.NaN,
      timelineDriftMs: Number.POSITIVE_INFINITY,
      clockOffsetDeltaMs: Number.NEGATIVE_INFINITY,
      clockStable: false,
      eligible: true,
      nextLatencyMs: null,
      reason: 'clock-changed',
      previousSampleId: privateValue,
      roomId: privateValue,
      peerId: privateValue,
      queueItemId: privateValue,
      videoId: privateValue,
      title: privateValue,
      filename: privateValue,
      message: privateValue,
      source: 'https://private.example/path',
      [privateValue]: 1,
    });
    recordStandardStartObservation('clock-continuity', {
      reason: 'clock-step' + 'x'.repeat(10_000),
      previousEpoch: 1,
      epoch: 2,
      sameEpoch: false,
      disjointIntervals: null,
      localClockStepMs: 500,
    });
    const snapshot = getStandardStartObservations();
    expect(snapshot.playback[0].detail).toEqual({
      operationId: 2,
      releaseLatenessMs: null,
      timelineDriftMs: null,
      clockOffsetDeltaMs: null,
      clockStable: false,
      eligible: true,
      nextLatencyMs: null,
      reason: 'clock-changed',
    });
    expect(snapshot.clock[0].detail).toEqual({
      previousEpoch: 1,
      epoch: 2,
      sameEpoch: false,
      disjointIntervals: null,
      localClockStepMs: 500,
    });
    expect(JSON.stringify(snapshot)).not.toContain(privateValue);
    expect(JSON.stringify(snapshot)).not.toContain('https://');
    recordStandardStartObservation(privateValue, { operationId: 3 });
    recordStandardStartObservation('clock-selection' + 'x'.repeat(10_000), { epoch: 3 });
    expect(getStandardStartObservations().clock).toHaveLength(1);
    expect(getStandardStartObservations().playback).toHaveLength(1);
  });

  it('ignores accessors, inherited fields and nonprimitive values without executing getters', () => {
    const getter = vi.fn(() => 'private');
    const detail = Object.create({ operationId: 99 }) as Record<
      string,
      string | number | boolean | null
    >;
    Object.defineProperty(detail, 'reason', { get: getter, enumerable: true });
    Object.defineProperty(detail, 'releaseLatenessMs', {
      value: { secret: 'private' },
      enumerable: true,
    });
    detail.timelineDriftMs = -30;
    recordStandardStartObservation('youtube-rendezvous-sample', detail);
    expect(getter).not.toHaveBeenCalled();
    expect(getStandardStartObservations().playback[0].detail).toEqual({ timelineDriftMs: -30 });
  });

  it('has no storage, network or console side effects and resets both families', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const save = vi.spyOn(Storage.prototype, 'setItem');
    const logs = ['log', 'debug', 'info', 'warn', 'error'].map((method) =>
      vi.spyOn(console, method as 'log'),
    );
    recordStandardStartObservation('clock-selection', { selectedSampleId: 1 });
    recordStandardStartObservation('youtube-rendezvous-start', { operationId: 1 });
    expect(getStandardStartObservations().clock).toHaveLength(1);
    expect(getStandardStartObservations().playback).toHaveLength(1);
    resetStandardStartObservations();
    expect(getStandardStartObservations()).toEqual({ clock: [], playback: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getProStartObservations,
  recordProStartObservation,
  resetProStartObservations,
} from '../pro-start-observations.ts';

beforeEach(() => {
  resetProStartObservations();
});

afterEach(() => {
  resetProStartObservations();
  vi.restoreAllMocks();
});

describe('PRO start observations', () => {
  it('retains only the latest 512 observations in order', () => {
    for (let generation = 0; generation < 600; generation += 1) {
      recordProStartObservation('clock-sample', { generation, rttMs: 20 });
    }
    const records = getProStartObservations();
    expect(records).toHaveLength(512);
    expect(records[0].detail.generation).toBe(88);
    expect(records.at(-1)?.detail.generation).toBe(599);
  });

  it('expires on reads and writes using monotonic time despite wall-clock changes', () => {
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(100);
    recordProStartObservation('clock-sample', { generation: 1 });
    vi.spyOn(Date, 'now').mockReturnValue(0);
    monotonic.mockReturnValue(20 * 60 * 1_000 + 100);
    expect(getProStartObservations()).toHaveLength(1);
    monotonic.mockReturnValue(20 * 60 * 1_000 + 101);
    expect(getProStartObservations()).toEqual([]);

    recordProStartObservation('clock-sample', { generation: 2 });
    monotonic.mockReturnValue(40 * 60 * 1_000 + 102);
    recordProStartObservation('clock-sample', { generation: 3 });
    expect(getProStartObservations().map((record) => record.detail.generation)).toEqual([3]);
  });

  it('copies both input and returned snapshots', () => {
    const detail = { generation: 1, rttMs: 20 };
    recordProStartObservation('clock-sample', detail);
    detail.rttMs = 99;
    const first = getProStartObservations();
    first[0].detail.rttMs = 88;
    first[0].kind = 'changed';
    first.length = 0;
    expect(getProStartObservations()[0]).toMatchObject({
      kind: 'clock-sample',
      detail: { generation: 1, rttMs: 20 },
    });
  });

  it('retains only finite metrics and known categories, never raw identities or messages', () => {
    const secret = 'private-room-peer-video-filename';
    recordProStartObservation('youtube-sample', {
      generation: 1,
      rttMs: Number.NaN,
      offsetMs: Number.POSITIVE_INFINITY,
      uncertaintyMs: Number.NEGATIVE_INFINITY,
      eligible: true,
      platform: 'android',
      reason: 'scheduled-control-observation-only',
      sampleId: secret,
      roomId: secret,
      peerId: secret,
      transitionId: secret,
      queueItemId: secret,
      videoId: secret,
      title: secret,
      filename: secret,
      message: secret,
      [secret]: 1,
      path: 'https://private.example/path',
      source: 'connection' + 'x'.repeat(10_000),
    });
    expect(getProStartObservations()[0].detail).toEqual({
      generation: 1,
      rttMs: null,
      offsetMs: null,
      uncertaintyMs: null,
      eligible: true,
      platform: 'android',
      reason: 'scheduled-control-observation-only',
    });
    expect(JSON.stringify(getProStartObservations())).not.toContain(secret);
    recordProStartObservation(secret, { generation: 2 });
    recordProStartObservation('clock-sample' + 'x'.repeat(10_000), { generation: 3 });
    expect(getProStartObservations()).toHaveLength(1);
  });

  it('ignores inherited fields, accessors, and nonprimitive data without executing getters', () => {
    const getter = vi.fn(() => 'private');
    const detail = Object.create({ offsetMs: 99 }) as Record<
      string,
      string | number | boolean | null
    >;
    Object.defineProperty(detail, 'reason', { get: getter, enumerable: true });
    Object.defineProperty(detail, 'rttMs', { value: { secret: 'private' }, enumerable: true });
    detail.generation = 1;
    recordProStartObservation('clock-sample', detail);
    expect(getter).not.toHaveBeenCalled();
    expect(getProStartObservations()[0].detail).toEqual({ generation: 1 });
  });

  it('has no storage, network, or console side effects and can be reset', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const save = vi.spyOn(Storage.prototype, 'setItem');
    const logs = ['log', 'debug', 'info', 'warn', 'error'].map((method) =>
      vi.spyOn(console, method as 'log'),
    );
    recordProStartObservation('youtube-release', { platform: 'other', revision: 1 });
    expect(getProStartObservations()).toHaveLength(1);
    resetProStartObservations();
    expect(getProStartObservations()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

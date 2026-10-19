import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getClockCorrectionQuality,
  getClockOffset,
  getSharedClockDiagnostics,
  isClockCalibrated,
  processSyncPong,
  registerPing,
  resetClockSamples,
  resetClockState,
} from '../shared-clock.ts';
import {
  getStandardStartObservations,
  resetStandardStartObservations,
} from '../../diagnostics/standard-start-observations.ts';

const BASE = 1_700_000_000_000;
// The host wall clock is ahead of this guest; the estimate must recover it.
const TRUE_OFFSET_MS = 1_234;
const QUIET_LEG_MS = 4;

let mono = 0;
let ping = 0;
let hostStepMs = 0;

function advance(ms: number): void {
  mono += ms;
  vi.advanceTimersByTime(ms);
}

/** Host time is sampled when the ping arrives; each leg may queue separately. */
function exchange(upMs: number, downMs: number) {
  registerPing(++ping);
  advance(upMs);
  const hostTime = Date.now() + TRUE_OFFSET_MS + hostStepMs;
  advance(downMs);
  return processSyncPong(ping, hostTime);
}

/** Deterministic 250..700ms queueing behind file data. */
function queueDelayMs(index: number): number {
  return 250 + ((index * 37) % 11) * 45;
}

function quietSeconds(seconds: number): void {
  for (let second = 0; second < seconds; second += 1) {
    expect(exchange(QUIET_LEG_MS, QUIET_LEG_MS)).not.toBeNull();
    advance(1_000 - 2 * QUIET_LEG_MS);
  }
}

/** One reply per second while one leg queues behind file data. */
function transferSeconds(seconds: number, leg: 'ping' | 'pong', onSecond?: () => void) {
  const rawBiases: number[] = [];
  for (let second = 0; second < seconds; second += 1) {
    const queued = queueDelayMs(second);
    const up = QUIET_LEG_MS + (leg === 'ping' ? queued : 0);
    const down = QUIET_LEG_MS + (leg === 'pong' ? queued : 0);
    const result = exchange(up, down);
    expect(result).not.toBeNull();
    rawBiases.push(result!.offset - TRUE_OFFSET_MS);
    onSecond?.();
    advance(1_000 - up - down);
  }
  return rawBiases;
}

function selections(reason?: string) {
  return getStandardStartObservations().clock.filter(
    (record) =>
      record.kind === 'clock-selection' &&
      (reason === undefined || record.detail.reason === reason),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  mono = ping = hostStepMs = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
  resetClockState();
  resetStandardStartObservations();
});

afterEach(() => {
  resetClockState();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('clock retention during a long file transfer', () => {
  it.each(['pong', 'ping'] as const)(
    'keeps the quiet offset selected through 100 seconds of %s queueing',
    (leg) => {
      quietSeconds(10);
      expect(getClockOffset()).toBe(TRUE_OFFSET_MS);
      const epoch = getClockCorrectionQuality().epoch;
      let maxSelectedBiasMs = 0;
      const rawBiases = transferSeconds(100, leg, () => {
        maxSelectedBiasMs = Math.max(
          maxSelectedBiasMs,
          Math.abs(getClockOffset() - TRUE_OFFSET_MS),
        );
        expect(getClockCorrectionQuality()).toMatchObject({
          eligible: true,
          reason: 'fresh',
          rttMs: 2 * QUIET_LEG_MS,
          uncertaintyMs: QUIET_LEG_MS + 5,
          epoch,
        });
      });
      // Every queued reply alone would bias the midpoint by half its queueing,
      // and 100 of them exceed the 60-sample pool the old eviction cycled.
      const minRawBias = Math.min(...rawBiases.map(Math.abs));
      expect(minRawBias).toBeGreaterThanOrEqual(125);
      expect(rawBiases.every((bias) => Math.sign(bias) === (leg === 'pong' ? -1 : 1))).toBe(true);
      expect(maxSelectedBiasMs).toBeLessThanOrEqual(QUIET_LEG_MS);
      expect(getSharedClockDiagnostics()).toMatchObject({
        sampleCount: 60,
        bestRttMs: 2 * QUIET_LEG_MS,
      });
      expect(selections('expired')).toHaveLength(0);
    },
  );

  it('falls back to queued replies only when the quiet samples reach the 120s age limit', () => {
    quietSeconds(10);
    const lastQuietAt = Date.now() - 1_000 + 2 * QUIET_LEG_MS;
    const epoch = getClockCorrectionQuality().epoch;
    let fellBackAt: number | null = null;
    transferSeconds(130, 'pong', () => {
      if (fellBackAt === null && getClockOffset() !== TRUE_OFFSET_MS) fellBackAt = Date.now();
    });
    expect(fellBackAt).not.toBeNull();
    expect(fellBackAt! - lastQuietAt).toBeGreaterThanOrEqual(120_000);
    expect(fellBackAt! - lastQuietAt).toBeLessThan(121_000);
    // The best queued reply is selected and its uncertainty is exposed.
    const quality = getClockCorrectionQuality();
    expect(quality).toMatchObject({ eligible: true, reason: 'fresh', epoch });
    expect(quality.rttMs).toBeGreaterThanOrEqual(258);
    expect(Math.abs(getClockOffset() - TRUE_OFFSET_MS)).toBeLessThanOrEqual(
      quality.uncertaintyMs! - 5,
    );
    expect(selections('expired').length).toBeGreaterThan(0);
  });

  it('never evicts the newest reply even when it is the worst', () => {
    quietSeconds(3);
    for (let index = 0; index < 70; index += 1) {
      // Each reply queues longer than every earlier one.
      expect(exchange(QUIET_LEG_MS, 300 + index * 10)).not.toBeNull();
      expect(getSharedClockDiagnostics().newestSampleAgeMs).toBe(0);
      advance(200);
      expect(getClockCorrectionQuality()).toMatchObject({ eligible: true, reason: 'fresh' });
    }
    expect(getSharedClockDiagnostics()).toMatchObject({ sampleCount: 60, bestRttMs: 8 });
  });

  it('still flushes the retained clock after an actual host clock step', () => {
    quietSeconds(10);
    transferSeconds(30, 'pong');
    const epoch = getClockCorrectionQuality().epoch;
    hostStepMs = 5_000;
    expect(exchange(QUIET_LEG_MS, QUIET_LEG_MS)).not.toBeNull();
    expect(getClockOffset()).toBe(TRUE_OFFSET_MS + 5_000);
    expect(getClockCorrectionQuality().epoch).toBe(epoch + 1);
    expect(getSharedClockDiagnostics().sampleCount).toBe(1);
    expect(selections().at(-1)!.detail).toMatchObject({ reason: 'clock-step' });
  });
});

describe('forced re-lock during a file transfer', () => {
  function establishQuietClockThenTransfer(): number {
    quietSeconds(10);
    transferSeconds(30, 'pong');
    return getSharedClockDiagnostics().sampleCount;
  }

  it('restores the quiet clock when the first reply queued behind file data', () => {
    const pooled = establishQuietClockThenTransfer();
    const epoch = getClockCorrectionQuality().epoch;
    resetClockSamples();
    // The established cold-start contract is unchanged until a reply arrives.
    expect(isClockCalibrated()).toBe(false);
    expect(getClockOffset()).toBe(0);
    expect(getSharedClockDiagnostics()).toMatchObject({ sampleCount: 0, pongsReceived: 0 });

    const result = exchange(QUIET_LEG_MS, QUIET_LEG_MS + 600);
    expect(result!.offset - TRUE_OFFSET_MS).toBe(-300);
    expect(getClockOffset()).toBe(TRUE_OFFSET_MS);
    expect(getClockCorrectionQuality()).toMatchObject({
      eligible: true,
      rttMs: 2 * QUIET_LEG_MS,
      epoch: epoch + 1,
    });
    expect(getSharedClockDiagnostics()).toMatchObject({
      sampleCount: pooled + 1,
      pongsReceived: 1,
    });
    expect(selections().at(-1)!.detail).toMatchObject({
      reason: 'restore',
      previousSampleId: null,
      selectedOffsetMs: TRUE_OFFSET_MS,
      selectedRttMs: 2 * QUIET_LEG_MS,
    });
  });

  it('keeps samples set aside across a repeated reset before any reply', () => {
    establishQuietClockThenTransfer();
    resetClockSamples();
    resetClockSamples();
    exchange(QUIET_LEG_MS, QUIET_LEG_MS + 500);
    expect(getClockOffset()).toBe(TRUE_OFFSET_MS);
    expect(selections('restore')).toHaveLength(1);
  });

  it('keeps samples set aside past a reply rejected for a wall/monotonic mismatch', () => {
    establishQuietClockThenTransfer();
    resetClockSamples();
    registerPing(++ping);
    advance(4);
    // Wall time alone jumps while this exchange is in flight.
    vi.setSystemTime(Date.now() + 500);
    expect(processSyncPong(ping, Date.now() + TRUE_OFFSET_MS)).toBeNull();
    vi.setSystemTime(Date.now() - 500);
    exchange(QUIET_LEG_MS, QUIET_LEG_MS + 500);
    expect(getClockOffset()).toBe(TRUE_OFFSET_MS);
    expect(selections('restore')).toHaveLength(1);
  });

  it('starts cold when a precise fresh reply disproves the set-aside clock', () => {
    establishQuietClockThenTransfer();
    resetClockSamples();
    hostStepMs = 300;
    exchange(QUIET_LEG_MS, QUIET_LEG_MS);
    expect(getClockOffset()).toBe(TRUE_OFFSET_MS + 300);
    expect(getSharedClockDiagnostics().sampleCount).toBe(1);
    expect(selections('restore')).toHaveLength(0);
  });

  it('starts cold after an observable local wall-clock step', () => {
    establishQuietClockThenTransfer();
    resetClockSamples();
    vi.setSystemTime(Date.now() + 1_000);
    const result = exchange(QUIET_LEG_MS, QUIET_LEG_MS + 500);
    expect(getClockOffset()).toBe(result!.offset);
    expect(getSharedClockDiagnostics().sampleCount).toBe(1);
    expect(selections('restore')).toHaveLength(0);
  });

  it('starts cold once the set-aside samples have aged out', () => {
    establishQuietClockThenTransfer();
    resetClockSamples();
    advance(120_000);
    const result = exchange(QUIET_LEG_MS, QUIET_LEG_MS + 500);
    expect(getClockOffset()).toBe(result!.offset);
    expect(getSharedClockDiagnostics().sampleCount).toBe(1);
    expect(selections('restore')).toHaveLength(0);
  });

  it('discards set-aside samples on a full reset such as a new host connection', () => {
    establishQuietClockThenTransfer();
    resetClockSamples();
    resetClockState();
    const result = exchange(QUIET_LEG_MS, QUIET_LEG_MS + 500);
    expect(getClockOffset()).toBe(result!.offset);
    expect(getSharedClockDiagnostics().sampleCount).toBe(1);
    expect(selections('restore')).toHaveLength(0);
  });
});

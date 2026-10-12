import { vi } from 'vitest';
import type * as ClockModule from '../../network-bridge.ts';
import type { ProRoomClockSnapshot } from '../../network-bridge.ts';

/**
 * Adapt existing controller fixtures to immutable clock estimates while
 * retaining each fixture's calibrated, pending, failed, and aborted waits.
 * Network clock selection itself is covered by network-bridge.test.ts.
 */
export function installProClockSnapshotMocks(
  clock: typeof ClockModule,
  options: { retainSuccessfulAcquisition?: boolean } = {},
): Array<{ mockRestore(): void }> {
  let nextSample = 0;
  let acquired: ProRoomClockSnapshot | null = null;
  const issued = new WeakSet<ProRoomClockSnapshot>();
  function snapshot(): ProRoomClockSnapshot {
    const result = Object.freeze({
      generation: 1,
      sampleId: ++nextSample,
      offsetMs: clock.getProRoomServerNow() - Date.now(),
      rttMs: 0,
      sampledAtMs: performance.now(),
      roundId: null,
      source: 'ready' as const,
    });
    issued.add(result);
    return result;
  }
  const capture = vi
    .spyOn(clock, 'captureProRoomServerClockSnapshot')
    .mockImplementation(() =>
      clock.isProRoomServerClockCalibrated()
        ? snapshot()
        : options.retainSuccessfulAcquisition
          ? acquired
          : null,
    );
  const current = vi
    .spyOn(clock, 'isProRoomClockSnapshotCurrent')
    .mockImplementation((value) => issued.has(value));
  const acquire = vi
    .spyOn(clock, 'acquireProRoomServerClock')
    .mockImplementation(async (options) => {
      if (options.signal?.aborted) return null;
      if (!options.fresh) {
        const current = clock.captureProRoomServerClockSnapshot();
        if (current) return current;
      }
      const ready = await clock.proRoomServerBridge.waitForFreshClockCalibration({
        serverDeadlineAtMs: options.serverDeadlineAtMs ?? Number.MAX_SAFE_INTEGER,
        fallbackTimeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      if (!ready || options.signal?.aborted) return null;
      acquired = snapshot();
      return acquired;
    });
  return [capture, current, acquire];
}

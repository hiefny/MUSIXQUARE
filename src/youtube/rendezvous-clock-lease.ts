import { getClockCorrectionQuality } from '../network/shared-clock.ts';
import { captureRendezvousClock } from './rendezvous-calibration.ts';

// One short automatic correction must not reinterpret its target halfway through
// preparation because an ordinary clock sample displaced the selected sample.
// This lease is not a better clock estimator and does not authorize correction.
const WALL_MONOTONIC_TOLERANCE_MS = 50;

export function captureRendezvousClockLease() {
  const clock = captureRendezvousClock();
  const epoch = getClockCorrectionQuality().epoch;
  return {
    clock,
    epoch,
    hostNow(): number {
      return clock.hostMs + performance.now() - clock.monotonicMs;
    },
    isContinuous(): boolean {
      const elapsed = performance.now() - clock.monotonicMs;
      return (
        clock.calibrated &&
        Number.isFinite(elapsed) &&
        elapsed >= 0 &&
        getClockCorrectionQuality().epoch === epoch &&
        Math.abs(Date.now() - clock.wallMs - elapsed) <= WALL_MONOTONIC_TOLERANCE_MS
      );
    },
  };
}

export type RendezvousClockLease = ReturnType<typeof captureRendezvousClockLease>;

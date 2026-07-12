import {
  ClockEstimator,
  mapPerformanceTimeToContext,
  monotonicNow,
  type ClockEstimatorOptions,
  type ClockQuality,
  type ClockSampleResult,
  type MonotonicNow,
} from '../network/clock-estimator.ts';

export interface FilePlaybackClockBindings {
  /** Current time in the authoritative host monotonic clock domain. */
  readonly nowRoomTimeMs: () => number;
  /** Map a host-room timestamp onto this device's AudioContext timeline. */
  readonly roomTimeMsToContextTime: (roomTimeMs: number) => number;
  /** Map a local performance timestamp onto this device's AudioContext timeline. */
  readonly localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
}

export interface FilePlaybackClockOptions {
  readonly now?: MonotonicNow;
  readonly estimatorOptions?: Omit<ClockEstimatorOptions, 'now'>;
}

/**
 * Shared monotonic clock facade for file playback.
 *
 * Deadline truth remains independent from AudioContext.currentTime. The audio
 * clock is consulted only to translate a room timestamp into a render frame,
 * so an iOS interruption cannot freeze rendezvous expiry.
 */
export class FilePlaybackClock {
  readonly #now: MonotonicNow;
  readonly #estimator: ClockEstimator;

  constructor(options: FilePlaybackClockOptions = {}) {
    this.#now = options.now ?? monotonicNow;
    this.#estimator = new ClockEstimator({
      ...options.estimatorOptions,
      now: this.#now,
    });
  }

  estimator(): ClockEstimator {
    return this.#estimator;
  }

  setHost(active: boolean): void {
    this.#estimator.setHostClock(active);
  }

  isHost(): boolean {
    return this.#estimator.isHostClock();
  }

  quality(): ClockQuality {
    return this.#estimator.quality();
  }

  qualityAtLocalTime(localPerformanceTimeMs: number): ClockQuality {
    return this.#estimator.qualityAtLocalTime(localPerformanceTimeMs);
  }

  nowRoomTimeMs(): number {
    return this.#estimator.hostNow();
  }

  nowRoomTimeMsAtLocalTime(localPerformanceTimeMs: number): number {
    return this.#estimator.hostNowAtLocalTime(localPerformanceTimeMs);
  }

  addNtpSample(t0: number, t1: number, t2: number, t3: number): ClockSampleResult {
    return this.#estimator.addNtpSample(t0, t1, t2, t3);
  }

  handleWake(): void {
    this.#estimator.handleWake();
  }

  reset(): void {
    this.#estimator.resetState();
  }

  bindAudioContext(context: AudioContext): FilePlaybackClockBindings {
    const mapLocal = (localPerformanceTimeMs: number): number =>
      mapPerformanceTimeToContext(context, localPerformanceTimeMs, {
        now: this.#now,
      }).contextTime;

    return Object.freeze({
      nowRoomTimeMs: () => this.nowRoomTimeMs(),
      roomTimeMsToContextTime: (roomTimeMs: number) =>
        mapLocal(this.#estimator.hostToLocal(roomTimeMs)),
      localPerformanceMsToContextTime: mapLocal,
    });
  }
}

const filePlaybackClock = new FilePlaybackClock();

export function getFilePlaybackClock(): FilePlaybackClock {
  return filePlaybackClock;
}

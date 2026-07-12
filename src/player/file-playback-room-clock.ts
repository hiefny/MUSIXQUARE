import type { ClockQuality } from '../network/clock-estimator.ts';
import { FilePlaybackClock, type FilePlaybackClockBindings } from './file-playback-clock.ts';

export type FilePlaybackRoomClockRole = 'host' | 'guest';

export interface FilePlaybackRoomClockProvider {
  nowRoomTimeMs(): number;
  quality(): Readonly<ClockQuality>;
  bindAudioContext(context: AudioContext): FilePlaybackClockBindings;
  handleWake(): void;
}

export interface FilePlaybackRoomClockLease {
  readonly role: FilePlaybackRoomClockRole;
}

export interface FilePlaybackRoomClockOptions {
  readonly createHostClock?: () => FilePlaybackClock;
}

interface ActiveRoomClock {
  readonly lease: FilePlaybackRoomClockLease;
  readonly provider: FilePlaybackRoomClockProvider;
}

function assertProvider(value: FilePlaybackRoomClockProvider): void {
  if (
    !value ||
    typeof value.nowRoomTimeMs !== 'function' ||
    typeof value.quality !== 'function' ||
    typeof value.bindAudioContext !== 'function' ||
    typeof value.handleWake !== 'function'
  ) {
    throw new TypeError('File playback room clock provider is invalid');
  }
}

/**
 * Revocable process-local authority for the room clock used by file sources.
 * A source binding from an old room/connection throws after replacement, so a
 * stale decode continuation cannot schedule audio against a successor clock.
 */
export class FilePlaybackRoomClock {
  readonly #createHostClock: () => FilePlaybackClock;
  #active: ActiveRoomClock | null = null;

  constructor(options: FilePlaybackRoomClockOptions = {}) {
    this.#createHostClock = options.createHostClock ?? (() => new FilePlaybackClock());
  }

  role(): FilePlaybackRoomClockRole | null {
    return this.#active?.lease.role ?? null;
  }

  beginHostSession(): FilePlaybackRoomClockLease {
    const clock = this.#createHostClock();
    clock.reset();
    clock.setHost(true);
    return this.#replace('host', clock);
  }

  bindGuestSession(provider: FilePlaybackRoomClockProvider): FilePlaybackRoomClockLease {
    assertProvider(provider);
    return this.#replace('guest', provider);
  }

  clear(lease: FilePlaybackRoomClockLease): boolean {
    if (this.#active?.lease !== lease) return false;
    this.#active = null;
    return true;
  }

  quality(): Readonly<ClockQuality> {
    return this.#requireActive().provider.quality();
  }

  nowRoomTimeMs(): number {
    return this.#requireActive().provider.nowRoomTimeMs();
  }

  handleWake(): void {
    this.#requireActive().provider.handleWake();
  }

  bindAudioContext(context: AudioContext): FilePlaybackClockBindings {
    const active = this.#requireActive();
    const bindings = active.provider.bindAudioContext(context);
    if (
      !bindings ||
      typeof bindings.nowRoomTimeMs !== 'function' ||
      typeof bindings.roomTimeMsToContextTime !== 'function' ||
      typeof bindings.localPerformanceMsToContextTime !== 'function'
    ) {
      throw new TypeError('File playback room clock bindings are invalid');
    }

    const assertCurrent = (): void => {
      if (this.#active !== active) throw new Error('FILE_PLAYBACK_ROOM_CLOCK_REVOKED');
    };
    return Object.freeze({
      nowRoomTimeMs: () => {
        assertCurrent();
        return bindings.nowRoomTimeMs();
      },
      roomTimeMsToContextTime: (roomTimeMs: number) => {
        assertCurrent();
        return bindings.roomTimeMsToContextTime(roomTimeMs);
      },
      localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => {
        assertCurrent();
        return bindings.localPerformanceMsToContextTime(localPerformanceTimeMs);
      },
    });
  }

  #replace(
    role: FilePlaybackRoomClockRole,
    provider: FilePlaybackRoomClockProvider,
  ): FilePlaybackRoomClockLease {
    assertProvider(provider);
    const lease = Object.freeze({ role });
    this.#active = Object.freeze({ lease, provider });
    return lease;
  }

  #requireActive(): ActiveRoomClock {
    const active = this.#active;
    if (!active) throw new Error('FILE_PLAYBACK_ROOM_CLOCK_UNAVAILABLE');
    return active;
  }
}

const filePlaybackRoomClock = new FilePlaybackRoomClock();

export function getFilePlaybackRoomClock(): FilePlaybackRoomClock {
  return filePlaybackRoomClock;
}

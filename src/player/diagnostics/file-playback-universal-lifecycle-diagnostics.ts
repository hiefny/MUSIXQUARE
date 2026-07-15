const FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS = Object.freeze([
  'roomOwners',
  'connectionOwners',
  'playbackSources',
  'encodedSources',
  'decoderGenerations',
  'workers',
  'ports',
  'rings',
  'pendingReads',
  'retryWaits',
  'timers',
] as const);

type FilePlaybackUniversalLifecycleKind = (typeof FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS)[number];

interface FilePlaybackUniversalLifecycleKindSnapshot {
  readonly live: number;
  readonly retiring: number;
  readonly unconfirmed: number;
  readonly acquiredTotal: number;
  readonly releasedTotal: number;
  readonly highWater: number;
}

type FilePlaybackUniversalLifecycleKindSnapshots = Readonly<{
  [Kind in FilePlaybackUniversalLifecycleKind]: FilePlaybackUniversalLifecycleKindSnapshot;
}>;

interface FilePlaybackUniversalLifecycleSnapshot {
  readonly sequence: number;
  readonly invariantFaults: number;
  readonly forcedRetirements: number;
  readonly quiescent: boolean;
  readonly kinds: FilePlaybackUniversalLifecycleKindSnapshots;
}

/**
 * A retirement handle deliberately appears only after beginRetire(). Call
 * release() only after the owned resource's close ACK or awaited cleanup has
 * completed successfully. A timeout or forced cleanup must use
 * forceUnconfirmed() instead.
 */
export interface FilePlaybackUniversalLifecycleRetirement {
  readonly release: () => void;
  readonly forceUnconfirmed: () => void;
}

/** An opaque, one-shot ownership lease. It contains no diagnostic identity. */
export interface FilePlaybackUniversalLifecycleLease {
  readonly beginRetire: () => FilePlaybackUniversalLifecycleRetirement;
  readonly forceUnconfirmed: () => void;
}

interface FilePlaybackUniversalLifecycleDiagnostics {
  readonly acquire: (
    kind: FilePlaybackUniversalLifecycleKind,
  ) => FilePlaybackUniversalLifecycleLease;
  readonly snapshot: () => FilePlaybackUniversalLifecycleSnapshot;
}

interface FilePlaybackUniversalLifecycleDiagnosticsOptions {
  /**
   * The largest exactly projected counter value. New acquisitions are refused
   * before per-kind accounting could exceed this ceiling.
   */
  readonly counterLimit?: number;
}

type LeaseState = 'live' | 'retiring' | 'unconfirmed' | 'released';

interface MutableKindCounters {
  live: number;
  retiring: number;
  unconfirmed: number;
  acquiredTotal: number;
  releasedTotal: number;
  highWater: number;
}

const KIND_SET: ReadonlySet<string> = new Set(FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS);

function isLifecycleKind(value: unknown): value is FilePlaybackUniversalLifecycleKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

function createMutableKindCounters(): MutableKindCounters {
  return {
    live: 0,
    retiring: 0,
    unconfirmed: 0,
    acquiredTotal: 0,
    releasedTotal: 0,
    highWater: 0,
  };
}

function createMutableKindMap(): Record<FilePlaybackUniversalLifecycleKind, MutableKindCounters> {
  return {
    roomOwners: createMutableKindCounters(),
    connectionOwners: createMutableKindCounters(),
    playbackSources: createMutableKindCounters(),
    encodedSources: createMutableKindCounters(),
    decoderGenerations: createMutableKindCounters(),
    workers: createMutableKindCounters(),
    ports: createMutableKindCounters(),
    rings: createMutableKindCounters(),
    pendingReads: createMutableKindCounters(),
    retryWaits: createMutableKindCounters(),
    timers: createMutableKindCounters(),
  };
}

function outstanding(counters: MutableKindCounters): number {
  return counters.live + counters.retiring + counters.unconfirmed;
}

function assertCounterLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('Lifecycle diagnostic counter limit must be a positive safe integer');
  }
  return value;
}

class FilePlaybackUniversalLifecycleDiagnosticsLedger implements FilePlaybackUniversalLifecycleDiagnostics {
  readonly #counterLimit: number;
  readonly #counterLimitBigInt: bigint;
  readonly #kinds = createMutableKindMap();
  #sequence = 0n;
  #invariantFaults = 0n;
  #forcedRetirements = 0n;

  constructor(options: FilePlaybackUniversalLifecycleDiagnosticsOptions) {
    this.#counterLimit = assertCounterLimit(options.counterLimit ?? Number.MAX_SAFE_INTEGER);
    this.#counterLimitBigInt = BigInt(this.#counterLimit);
  }

  acquire(kind: FilePlaybackUniversalLifecycleKind): FilePlaybackUniversalLifecycleLease {
    if (!isLifecycleKind(kind)) {
      this.#recordFault();
      throw new RangeError('Unknown lifecycle diagnostic kind');
    }

    const counters = this.#kinds[kind];
    if (counters.acquiredTotal >= this.#counterLimit) {
      this.#recordFault();
      throw new RangeError('Lifecycle diagnostic acquisition counter exhausted');
    }

    counters.live += 1;
    counters.acquiredTotal += 1;
    counters.highWater = Math.max(counters.highWater, outstanding(counters));
    this.#recordTransition(kind);

    let state: LeaseState = 'live';

    const invalidTransition = (): void => {
      this.#recordFault();
    };

    const release = (): void => {
      if (state !== 'retiring' || counters.retiring < 1) {
        invalidTransition();
        return;
      }
      counters.retiring -= 1;
      counters.releasedTotal += 1;
      state = 'released';
      this.#recordTransition(kind);
    };

    const forceUnconfirmed = (): void => {
      if (state === 'live' && counters.live >= 1) {
        counters.live -= 1;
      } else if (state === 'retiring' && counters.retiring >= 1) {
        counters.retiring -= 1;
      } else {
        invalidTransition();
        return;
      }

      counters.unconfirmed += 1;
      state = 'unconfirmed';
      this.#forcedRetirements += 1n;
      this.#recordTransition(kind);
    };

    const retirement = Object.freeze<FilePlaybackUniversalLifecycleRetirement>({
      release,
      forceUnconfirmed,
    });

    const beginRetire = (): FilePlaybackUniversalLifecycleRetirement => {
      if (state !== 'live' || counters.live < 1) {
        invalidTransition();
        return retirement;
      }
      counters.live -= 1;
      counters.retiring += 1;
      state = 'retiring';
      this.#recordTransition(kind);
      return retirement;
    };

    return Object.freeze<FilePlaybackUniversalLifecycleLease>({
      beginRetire,
      forceUnconfirmed,
    });
  }

  snapshot(): FilePlaybackUniversalLifecycleSnapshot {
    const kinds = {} as Record<
      FilePlaybackUniversalLifecycleKind,
      FilePlaybackUniversalLifecycleKindSnapshot
    >;
    let quiescent = true;

    for (const kind of FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS) {
      const counters = this.#kinds[kind];
      if (outstanding(counters) !== 0) quiescent = false;
      kinds[kind] = Object.freeze({
        live: counters.live,
        retiring: counters.retiring,
        unconfirmed: counters.unconfirmed,
        acquiredTotal: counters.acquiredTotal,
        releasedTotal: counters.releasedTotal,
        highWater: counters.highWater,
      });
    }

    return Object.freeze({
      sequence: this.#projectGlobalCounter(this.#sequence),
      invariantFaults: this.#projectGlobalCounter(this.#invariantFaults),
      forcedRetirements: this.#projectGlobalCounter(this.#forcedRetirements),
      quiescent,
      kinds: Object.freeze(kinds),
    });
  }

  #recordTransition(kind: FilePlaybackUniversalLifecycleKind): void {
    this.#sequence += 1n;
    const counters = this.#kinds[kind];
    if (counters.acquiredTotal !== counters.releasedTotal + outstanding(counters)) {
      this.#invariantFaults += 1n;
    }
  }

  #recordFault(): void {
    this.#sequence += 1n;
    this.#invariantFaults += 1n;
  }

  #projectGlobalCounter(value: bigint): number {
    return value > this.#counterLimitBigInt ? this.#counterLimit : Number(value);
  }
}

function createFilePlaybackUniversalLifecycleDiagnostics(
  options: FilePlaybackUniversalLifecycleDiagnosticsOptions = {},
): FilePlaybackUniversalLifecycleDiagnostics {
  const ledger = new FilePlaybackUniversalLifecycleDiagnosticsLedger(options);
  return Object.freeze({
    acquire: (kind: FilePlaybackUniversalLifecycleKind) => ledger.acquire(kind),
    snapshot: () => ledger.snapshot(),
  });
}

const sharedDiagnostics = createFilePlaybackUniversalLifecycleDiagnostics();

export const filePlaybackUniversalLifecycleKindsForTests = FILE_PLAYBACK_UNIVERSAL_LIFECYCLE_KINDS;
export type FilePlaybackUniversalLifecycleKindForTests = FilePlaybackUniversalLifecycleKind;
export type FilePlaybackUniversalLifecycleSnapshotForTests = FilePlaybackUniversalLifecycleSnapshot;
export const createFilePlaybackUniversalLifecycleDiagnosticsForTests =
  createFilePlaybackUniversalLifecycleDiagnostics;

export function acquireFilePlaybackUniversalLifecycleLease(
  kind: FilePlaybackUniversalLifecycleKind,
): FilePlaybackUniversalLifecycleLease {
  return sharedDiagnostics.acquire(kind);
}

export function getFilePlaybackUniversalLifecycleSnapshotForTests(): FilePlaybackUniversalLifecycleSnapshot {
  return sharedDiagnostics.snapshot();
}

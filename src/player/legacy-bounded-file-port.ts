import {
  FilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from './file-playback-manager.ts';
import {
  createFilePlaybackCutoverTarget,
  createFilePlaybackSourceSnapshot,
  type FilePlaybackCutoverSource,
  type FilePlaybackPauseTransitionIntent,
  type FilePlaybackPosition,
  type FilePlaybackSeekTransitionIntent,
  type FilePlaybackSourceSnapshot,
} from './file-playback-source.ts';
import type { FilePlaybackEndedTransitionIntent } from './file-playback-ended-transition.ts';
import type { RevisionedPlaybackRun } from './rendezvous-contract.ts';
import type { QueueItemId } from '../types/index.ts';
import { isEncodedAudioSourceIdentity } from './sources/encoded-audio-source.ts';
import type {
  LegacyBoundedFileControlOutcome,
  LegacyBoundedFileLease,
  LegacyBoundedFileOpenedSource,
  LegacyBoundedFileOpener,
  LegacyBoundedFilePlayInput,
  LegacyBoundedFilePortContract,
  LegacyBoundedFilePortOptions,
  LegacyBoundedFilePreparation,
  LegacyBoundedFilePrepareInput,
  LegacyBoundedFilePrepareOutcome,
  LegacyBoundedFileScheduleOutcome,
  LegacyBoundedFileScope,
  LegacyBoundedFileSeekInput,
  LegacyBoundedFileTimedControlInput,
} from './legacy-bounded-file-port-contract.ts';

// Revisioned sources reject a pause/seek/stop target that is already at the
// audio render cursor. A tiny local lead keeps "pause now" perceptually
// immediate while avoiding the former 200ms room-wide control delay.
const IMMEDIATE_CONTROL_LEAD_MS = 25;

type RecordPhase =
  | 'opening'
  | 'staging'
  | 'staged'
  | 'committing'
  | 'scheduled'
  | 'current'
  | 'paused'
  | 'retiring'
  | 'retired';

interface LeaseRecord {
  readonly lease: LegacyBoundedFileLease;
  readonly scope: Readonly<LegacyBoundedFileScope>;
  readonly serial: number;
  readonly controller: AbortController;
  readonly open: LegacyBoundedFileOpener;
  live: boolean;
  phase: RecordPhase;
  port: FilePlaybackCutoverCandidatePort | null;
  audioContext: AudioContext | null;
  runId: string | null;
  revision: number;
  readyPromise: Promise<LegacyBoundedFilePrepareOutcome>;
  commitStartAtRoomTimeMs: number | null;
  commitPositionSeconds: number | null;
  schedulePromise: Promise<LegacyBoundedFileScheduleOutcome> | null;
  commitPromise: Promise<LegacyBoundedFileControlOutcome> | null;
  transitionPromise: Promise<LegacyBoundedFileControlOutcome> | null;
  cleanupPromise: Promise<void> | null;
}

interface PlayOperation {
  readonly schedule: Promise<LegacyBoundedFileScheduleOutcome>;
  readonly commit: Promise<LegacyBoundedFileControlOutcome>;
}

type StartedWaitOutcome =
  | Readonly<{ readonly status: 'started' }>
  | Readonly<{ readonly status: 'aborted' }>
  | Readonly<{ readonly status: 'rejected'; readonly error: unknown }>;

const SCOPE_KEYS = Object.freeze([
  'roomEpoch',
  'bridgeGeneration',
  'bindingId',
  'queueItemId',
  'sourceIdentity',
  'descriptorId',
  'descriptorVersion',
] as const);
const SCOPE_KEY_SET: ReadonlySet<PropertyKey> = new Set(SCOPE_KEYS);
const MAX_IDENTIFIER_LENGTH = 256;
const LOCAL_PARTICIPANT_ID = 'legacy-bounded-local';
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && !Object.is(value, -0)
  );
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_IDENTIFIER_LENGTH && IDENTIFIER_RE.test(value)
  );
}

function isQueueItemId(value: unknown): value is QueueItemId {
  return typeof value === 'string' && QUEUE_ITEM_ID_RE.test(value);
}

function readScope(value: unknown): Readonly<LegacyBoundedFileScope> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== SCOPE_KEYS.length ||
      keys.some((key) => !SCOPE_KEY_SET.has(key)) ||
      keys.some((key) => {
        const descriptor = descriptors[key as keyof typeof descriptors];
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
      })
    ) {
      return null;
    }
    const roomEpoch = descriptors.roomEpoch?.value as unknown;
    const bridgeGeneration = descriptors.bridgeGeneration?.value as unknown;
    const bindingId = descriptors.bindingId?.value as unknown;
    const queueItemId = descriptors.queueItemId?.value as unknown;
    const sourceIdentity = descriptors.sourceIdentity?.value as unknown;
    const descriptorId = descriptors.descriptorId?.value as unknown;
    const descriptorVersion = descriptors.descriptorVersion?.value as unknown;
    if (
      !isBoundedIdentifier(roomEpoch) ||
      !isBoundedIdentifier(bridgeGeneration) ||
      !isBoundedIdentifier(bindingId) ||
      !isQueueItemId(queueItemId) ||
      !isEncodedAudioSourceIdentity(sourceIdentity) ||
      !isBoundedIdentifier(descriptorId) ||
      !isPositiveSafeInteger(descriptorVersion)
    ) {
      return null;
    }
    return freezeRecord({
      roomEpoch,
      bridgeGeneration,
      bindingId,
      queueItemId,
      sourceIdentity,
      descriptorId,
      descriptorVersion,
    });
  } catch {
    return null;
  }
}

function sameScope(
  left: Readonly<LegacyBoundedFileScope>,
  right: Readonly<LegacyBoundedFileScope>,
): boolean {
  return (
    left.roomEpoch === right.roomEpoch &&
    left.bridgeGeneration === right.bridgeGeneration &&
    left.bindingId === right.bindingId &&
    left.queueItemId === right.queueItemId &&
    left.sourceIdentity === right.sourceIdentity &&
    left.descriptorId === right.descriptorId &&
    left.descriptorVersion === right.descriptorVersion
  );
}

function sameRoomBoundary(
  left: Readonly<LegacyBoundedFileScope>,
  right: Readonly<LegacyBoundedFileScope>,
): boolean {
  return left.roomEpoch === right.roomEpoch && left.bridgeGeneration === right.bridgeGeneration;
}

function createOpaqueLease(): LegacyBoundedFileLease {
  return Object.freeze(Object.create(null)) as LegacyBoundedFileLease;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function superseded(): LegacyBoundedFileControlOutcome {
  return freezeRecord({ status: 'superseded' as const });
}

function failed(error: unknown): LegacyBoundedFileControlOutcome {
  return freezeRecord({ status: 'failed' as const, error });
}

function applied(snapshot: FilePlaybackSourceSnapshot | null): LegacyBoundedFileControlOutcome {
  return freezeRecord({ status: 'applied' as const, snapshot });
}

function rejected(
  reason: Extract<LegacyBoundedFileControlOutcome, { readonly status: 'rejected' }>['reason'],
): LegacyBoundedFileControlOutcome {
  return freezeRecord({ status: 'rejected' as const, reason });
}

function scheduleSuperseded(): LegacyBoundedFileScheduleOutcome {
  return freezeRecord({ status: 'superseded' as const });
}

function scheduleFailed(error: unknown): LegacyBoundedFileScheduleOutcome {
  return freezeRecord({ status: 'failed' as const, error });
}

function scheduleRejected(
  reason: Extract<LegacyBoundedFileScheduleOutcome, { readonly status: 'rejected' }>['reason'],
): LegacyBoundedFileScheduleOutcome {
  return freezeRecord({ status: 'rejected' as const, reason });
}

function scheduled(
  startAtRoomTimeMs: number,
  snapshot: FilePlaybackSourceSnapshot,
  settled: Promise<LegacyBoundedFileControlOutcome>,
): LegacyBoundedFileScheduleOutcome {
  return freezeRecord({
    status: 'scheduled' as const,
    startAtRoomTimeMs,
    snapshot,
    settled,
  });
}

function waitForStartedOrAbort(
  signal: AbortSignal,
  started: Promise<unknown>,
): Promise<StartedWaitOutcome> {
  if (signal.aborted) {
    return Promise.resolve(freezeRecord({ status: 'aborted' as const }));
  }
  return new Promise<StartedWaitOutcome>((resolve) => {
    let complete = false;
    const settle = (outcome: StartedWaitOutcome): void => {
      if (complete) return;
      complete = true;
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => {
      settle(freezeRecord({ status: 'aborted' as const }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve(started).then(
      () => settle(freezeRecord({ status: 'started' as const })),
      (error: unknown) =>
        settle(freezeRecord({ status: 'rejected' as const, error })),
    );
  });
}

function safeContextForDestination(destination: AudioNode): AudioContext | null {
  try {
    const context = destination.context;
    if (
      context === null ||
      typeof context !== 'object' ||
      typeof context.createGain !== 'function' ||
      typeof context.currentTime !== 'number' ||
      !Number.isFinite(context.currentTime) ||
      typeof context.sampleRate !== 'number' ||
      !Number.isFinite(context.sampleRate) ||
      context.sampleRate <= 0
    ) {
      return null;
    }
    return context as AudioContext;
  } catch {
    return null;
  }
}

type OpenedSourceRead =
  | Readonly<{ readonly status: 'unsupported' }>
  | Readonly<{ readonly status: 'valid'; readonly value: LegacyBoundedFileOpenedSource }>
  | Readonly<{
      readonly status: 'malformed';
      readonly discoveredSource: FilePlaybackCutoverSource | null;
    }>;

function discoverDestroyableSource(value: unknown): FilePlaybackCutoverSource | null {
  try {
    if (value === null || typeof value !== 'object') return null;
    let cursor: object | null = value;
    while (cursor) {
      const destroy = Object.getOwnPropertyDescriptor(cursor, 'destroy');
      if (destroy) {
        return Object.hasOwn(destroy, 'value') && typeof destroy.value === 'function'
          ? (value as FilePlaybackCutoverSource)
          : null;
      }
      cursor = Reflect.getPrototypeOf(cursor) as object | null;
    }
    return null;
  } catch {
    return null;
  }
}

const CUTOVER_SOURCE_METHODS = Object.freeze([
  'prepare',
  'connect',
  'primeForCutover',
  'arm',
  'armForCutover',
  'finalize',
  'cancel',
  'pause',
  'seek',
  'pauseRevisioned',
  'seekRevisioned',
  'positionAt',
  'getSnapshot',
  'destroy',
] as const);

function hasDataMethod(value: object, key: string): boolean {
  let cursor: object | null = value;
  while (cursor) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor)
      return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function';
    cursor = Reflect.getPrototypeOf(cursor) as object | null;
  }
  return false;
}

function hasCutoverSourceContract(value: unknown): value is FilePlaybackCutoverSource {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      CUTOVER_SOURCE_METHODS.every((method) => hasDataMethod(value, method))
    );
  } catch {
    return false;
  }
}

function readOpenedSource(value: unknown): OpenedSourceRead {
  if (value === null) return freezeRecord({ status: 'unsupported' as const });
  try {
    if (typeof value !== 'object' || Array.isArray(value)) {
      return freezeRecord({ status: 'malformed' as const, discoveredSource: null });
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const source = descriptors.source;
    const destination = descriptors.destination;
    const discoveredSource =
      source && Object.hasOwn(source, 'value') ? discoverDestroyableSource(source.value) : null;
    if (
      Reflect.ownKeys(descriptors).length !== 2 ||
      !source?.enumerable ||
      !Object.hasOwn(source, 'value') ||
      !destination?.enumerable ||
      !Object.hasOwn(destination, 'value') ||
      source.value === null ||
      typeof source.value !== 'object' ||
      destination.value === null ||
      typeof destination.value !== 'object'
    ) {
      return freezeRecord({ status: 'malformed' as const, discoveredSource });
    }
    return freezeRecord({
      status: 'valid' as const,
      value: freezeRecord({
        source: source.value as FilePlaybackCutoverSource,
        destination: destination.value as AudioNode,
      }),
    });
  } catch {
    return freezeRecord({ status: 'malformed' as const, discoveredSource: null });
  }
}

async function destroyUntransferredSource(source: FilePlaybackCutoverSource): Promise<void> {
  await Promise.resolve(source.destroy());
}

/**
 * A deliberately narrow adapter between stable V1 room truth and the bounded
 * native renderer. It owns no room state, transport, UI, or connection.
 */
class LegacyBoundedFilePort implements LegacyBoundedFilePortContract {
  readonly #manager = new FilePlaybackManager();
  readonly #nowRoomTimeMs: () => number;
  readonly #leases = new WeakMap<object, LeaseRecord>();
  readonly #records = new Set<LeaseRecord>();
  #candidate: LeaseRecord | null = null;
  #current: LeaseRecord | null = null;
  #serial = 0;

  constructor(options: LegacyBoundedFilePortOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      typeof options.nowRoomTimeMs !== 'function'
    ) {
      throw new TypeError('Legacy bounded file port options are invalid');
    }
    this.#nowRoomTimeMs = options.nowRoomTimeMs;
  }

  prepare(input: LegacyBoundedFilePrepareInput): LegacyBoundedFilePreparation {
    const scope = readScope(input?.scope);
    const open = input?.open;
    if (!scope || typeof open !== 'function') {
      throw new TypeError('Legacy bounded file preparation is invalid');
    }
    if (this.#serial >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Legacy bounded file lease serial exhausted');
    }
    this.#serial += 1;
    const lease = createOpaqueLease();
    const ready = deferred<LegacyBoundedFilePrepareOutcome>();
    const record: LeaseRecord = {
      lease,
      scope,
      serial: this.#serial,
      controller: new AbortController(),
      open,
      live: true,
      phase: 'opening',
      port: null,
      audioContext: null,
      runId: null,
      revision: 0,
      readyPromise: ready.promise,
      commitStartAtRoomTimeMs: null,
      commitPositionSeconds: null,
      schedulePromise: null,
      commitPromise: null,
      transitionPromise: null,
      cleanupPromise: null,
    };

    const previous = this.#candidate;
    if (previous) {
      this.#invalidate(previous, 'Legacy bounded candidate was superseded');
      void this.#joinRetirement(previous).catch(() => undefined);
    }
    this.#candidate = record;
    this.#leases.set(lease, record);
    this.#records.add(record);
    void this.#prepareRecord(record).then(ready.resolve);
    return freezeRecord({ lease, ready: ready.promise });
  }

  schedulePlay(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    input: LegacyBoundedFilePlayInput,
  ): Promise<LegacyBoundedFileScheduleOutcome> {
    return this.#beginPlay(lease, scope, input).schedule;
  }

  commitPlay(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    input: LegacyBoundedFilePlayInput,
  ): Promise<LegacyBoundedFileControlOutcome> {
    return this.#beginPlay(lease, scope, input).commit;
  }

  #beginPlay(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    input: LegacyBoundedFilePlayInput,
  ): PlayOperation {
    const record = this.#lookup(lease, scope);
    const startAtRoomTimeMs = input?.startAtRoomTimeMs;
    const positionSeconds = input?.positionSeconds;
    if (!record || this.#candidate !== record || !record.port) {
      return freezeRecord({
        schedule: Promise.resolve(scheduleSuperseded()),
        commit: Promise.resolve(superseded()),
      });
    }
    if (!finiteNonNegative(startAtRoomTimeMs) || !finiteNonNegative(positionSeconds)) {
      const error = new TypeError('Bounded start input is invalid');
      return freezeRecord({
        schedule: Promise.resolve(scheduleFailed(error)),
        commit: Promise.resolve(failed(error)),
      });
    }
    if (record.schedulePromise || record.commitPromise) {
      if (
        record.schedulePromise &&
        record.commitPromise &&
        record.commitStartAtRoomTimeMs === startAtRoomTimeMs &&
        record.commitPositionSeconds === positionSeconds
      ) {
        return freezeRecord({
          schedule: record.schedulePromise,
          commit: record.commitPromise,
        });
      }
      return freezeRecord({
        schedule: Promise.resolve(scheduleRejected('busy')),
        commit: Promise.resolve(rejected('busy')),
      });
    }
    if (record.phase !== 'staged') {
      return freezeRecord({
        schedule: Promise.resolve(scheduleSuperseded()),
        commit: Promise.resolve(superseded()),
      });
    }

    const commit = deferred<LegacyBoundedFileControlOutcome>();
    record.commitStartAtRoomTimeMs = startAtRoomTimeMs;
    record.commitPositionSeconds = positionSeconds;
    record.phase = 'committing';
    const scheduleTask = this.#scheduleRecord(
      record,
      startAtRoomTimeMs,
      positionSeconds,
      commit.promise,
      commit.resolve,
    );
    record.schedulePromise = scheduleTask;
    record.commitPromise = commit.promise;
    void scheduleTask.then((outcome) => {
      if (outcome.status === 'scheduled') return;
      if (outcome.status === 'rejected') {
        commit.resolve(rejected(outcome.reason));
      } else if (outcome.status === 'superseded') {
        commit.resolve(superseded());
      } else {
        commit.resolve(failed(outcome.error));
      }
    });
    const settleCommit = () => {
      if (record.commitPromise !== commit.promise) return;
      record.schedulePromise = null;
      record.commitPromise = null;
      record.commitStartAtRoomTimeMs = null;
      record.commitPositionSeconds = null;
      if (record.live && this.#candidate === record && record.phase === 'committing') {
        record.phase = 'staged';
      }
    };
    void commit.promise.then(settleCommit, settleCommit);
    return freezeRecord({ schedule: scheduleTask, commit: commit.promise });
  }

  pause(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    input: LegacyBoundedFileTimedControlInput,
  ): Promise<LegacyBoundedFileControlOutcome> {
    return this.#transition(lease, scope, 'pause', input?.atRoomTimeMs, null);
  }

  seek(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    input: LegacyBoundedFileSeekInput,
  ): Promise<LegacyBoundedFileControlOutcome> {
    return this.#transition(lease, scope, 'seek', input?.atRoomTimeMs, input?.positionSeconds);
  }

  stop(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    input: LegacyBoundedFileTimedControlInput,
  ): Promise<LegacyBoundedFileControlOutcome> {
    const record = this.#lookup(lease, scope);
    if (!record || this.#current !== record || !record.port) {
      return Promise.resolve(superseded());
    }
    if (record.transitionPromise) return Promise.resolve(rejected('busy'));
    const atRoomTimeMs = input?.atRoomTimeMs;
    if (!finiteNonNegative(atRoomTimeMs)) {
      return Promise.resolve(failed(new TypeError('Bounded stop time is invalid')));
    }
    const task = this.#stopRecord(record, atRoomTimeMs);
    record.transitionPromise = task;
    const settleStop = () => {
      if (record.transitionPromise === task) record.transitionPromise = null;
    };
    void task.then(settleStop, settleStop);
    return task;
  }

  snapshot(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
  ): FilePlaybackSourceSnapshot | null {
    const record = this.#lookup(lease, scope);
    if (!record?.port || this.#current !== record) return null;
    return this.#manager.currentCutoverSnapshot(record.port);
  }

  position(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    localPerformanceTimeMs: number,
  ): FilePlaybackPosition | null {
    const record = this.#lookup(lease, scope);
    if (!record?.port || this.#current !== record || !finiteNonNegative(localPerformanceTimeMs)) {
      return null;
    }
    try {
      return this.#manager.currentCutoverPosition(record.port, localPerformanceTimeMs);
    } catch {
      this.#invalidate(record, 'Legacy bounded position observation failed');
      void this.#joinRetirement(record).catch(() => undefined);
      return null;
    }
  }

  retire(lease: LegacyBoundedFileLease, scope: LegacyBoundedFileScope): Promise<void> {
    const record = this.#lookup(lease, scope);
    if (!record) return Promise.resolve();
    this.#invalidate(record, 'Legacy bounded lease was retired');
    return this.#joinRetirement(record);
  }

  clearRoom(scope: LegacyBoundedFileScope): Promise<void> {
    const canonical = readScope(scope);
    if (!canonical) return Promise.reject(new TypeError('Legacy bounded room scope is invalid'));
    const cleanups: Promise<void>[] = [];
    for (const record of this.#records) {
      if (!sameRoomBoundary(record.scope, canonical)) continue;
      this.#invalidate(record, 'Legacy bounded room scope was cleared');
      cleanups.push(this.#joinRetirement(record));
    }
    return Promise.all(cleanups).then(() => undefined);
  }

  async clear(): Promise<void> {
    const cleanups: Promise<void>[] = [];
    for (const record of this.#records) {
      this.#invalidate(record, 'Legacy bounded file port was cleared');
      cleanups.push(this.#joinRetirement(record));
    }
    const failures: unknown[] = [];
    const settled = await Promise.allSettled(cleanups);
    for (const result of settled) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    try {
      await this.#manager.clear();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Legacy bounded clear cleanup failed');
    }
  }

  async #prepareRecord(record: LeaseRecord): Promise<LegacyBoundedFilePrepareOutcome> {
    let openedSource: FilePlaybackCutoverSource | null = null;
    let transferred = false;
    try {
      const openedRead = readOpenedSource(await record.open(record.controller.signal));
      if (openedRead.status === 'unsupported') {
        if (!record.live || record.controller.signal.aborted) {
          return freezeRecord({ status: 'superseded' as const });
        }
        this.#invalidate(record, 'Legacy bounded source is unsupported');
        void this.#joinRetirement(record).catch(() => undefined);
        return freezeRecord({
          status: 'fallback' as const,
          reason: 'unsupported-source' as const,
        });
      }
      if (openedRead.status === 'malformed') {
        if (openedRead.discoveredSource) {
          await destroyUntransferredSource(openedRead.discoveredSource);
        }
        if (!record.live || record.controller.signal.aborted) {
          return freezeRecord({ status: 'superseded' as const });
        }
        throw new TypeError('Legacy bounded opener returned a malformed result');
      }
      const opened = openedRead.value;
      openedSource = opened.source;
      if (!hasCutoverSourceContract(openedSource)) {
        const discovered = discoverDestroyableSource(openedSource);
        if (discovered) await destroyUntransferredSource(discovered);
        openedSource = null;
        throw new TypeError('Opened source does not implement the bounded cutover contract');
      }
      if (!record.live || this.#candidate !== record || record.controller.signal.aborted) {
        await destroyUntransferredSource(openedSource);
        openedSource = null;
        return freezeRecord({ status: 'superseded' as const });
      }
      if (openedSource.queueItemId !== record.scope.queueItemId) {
        throw new TypeError('Opened bounded source queue identity is not exact');
      }
      if (openedSource.backend !== 'bounded-stream') {
        await destroyUntransferredSource(openedSource);
        openedSource = null;
        this.#invalidate(record, 'Legacy bounded source requires V1 fallback');
        void this.#joinRetirement(record).catch(() => undefined);
        return freezeRecord({
          status: 'fallback' as const,
          reason: 'unsupported-source' as const,
        });
      }
      const audioContext = safeContextForDestination(opened.destination);
      if (!audioContext) throw new TypeError('Opened bounded destination has no AudioContext');
      record.audioContext = audioContext;
      record.phase = 'staging';
      transferred = true;
      const port = await this.#manager.stageCutoverCandidate({
        source: openedSource,
        destination: opened.destination,
        authority: () => record.live && (this.#candidate === record || this.#current === record),
      });
      openedSource = null;
      record.port = port;
      if (!record.live || this.#candidate !== record || record.controller.signal.aborted) {
        await this.#manager.retireExactCutoverPort(port);
        return freezeRecord({ status: 'superseded' as const });
      }
      record.phase = 'staged';
      return freezeRecord({
        status: 'ready' as const,
        snapshot: createFilePlaybackSourceSnapshot(opened.source.getSnapshot()),
      });
    } catch (error) {
      let failure = error;
      if (openedSource && !transferred) {
        try {
          await destroyUntransferredSource(openedSource);
        } catch (cleanupError) {
          if (record.live)
            failure = new AggregateError([failure, cleanupError], 'Open and cleanup failed');
        }
      }
      if (record.port) {
        try {
          await this.#manager.retireExactCutoverPort(record.port);
        } catch (cleanupError) {
          if (record.live)
            failure = new AggregateError([failure, cleanupError], 'Prepare and cleanup failed');
        }
      }
      if (!record.live || record.controller.signal.aborted) {
        return freezeRecord({ status: 'superseded' as const });
      }
      this.#invalidate(record, 'Legacy bounded preparation failed');
      void this.#joinRetirement(record).catch(() => undefined);
      return freezeRecord({ status: 'failed' as const, error: failure });
    }
  }

  async #scheduleRecord(
    record: LeaseRecord,
    startAtRoomTimeMs: number,
    positionSeconds: number,
    settled: Promise<LegacyBoundedFileControlOutcome>,
    settle: (outcome: LegacyBoundedFileControlOutcome) => void,
  ): Promise<LegacyBoundedFileScheduleOutcome> {
    const port = record.port;
    if (!port) return scheduleSuperseded();
    try {
      const now = this.#readRoomTime();
      if (startAtRoomTimeMs <= now) {
        record.phase = 'staged';
        return scheduleFailed(new RangeError('Bounded start time is not in the future'));
      }
      const revision = 1;
      const runId = `legacy-bounded-${record.serial}`;
      const rendezvousId = `legacy-bounded-${record.serial}-start`;
      const primedSnapshot = createFilePlaybackSourceSnapshot(
        await this.#manager.primeCutoverCandidate(
          port,
          positionSeconds,
          record.controller.signal,
        ),
      );
      if (!record.live || this.#candidate !== record || record.controller.signal.aborted) {
        await this.#manager.retireExactCutoverPort(port);
        return scheduleSuperseded();
      }
      const postPrimeRoomTimeMs = this.#readRoomTime();
      if (startAtRoomTimeMs <= postPrimeRoomTimeMs) {
        // Manager prime is one-shot and fixes this candidate to one exact
        // position. Conservatively retire on a missed start rather than
        // expose a hidden same-position-only retry rule.
        this.#invalidate(record, 'Legacy bounded start expired while priming');
        await this.#joinRetirement(record);
        return scheduleFailed(new RangeError('Bounded start expired while priming'));
      }
      const finalizeByRoomTimeMs =
        postPrimeRoomTimeMs + (startAtRoomTimeMs - postPrimeRoomTimeMs) / 2;
      const arm = freezeRecord({
        protocolVersion: 2 as const,
        kind: 'rendezvous-arm' as const,
        queueItemId: record.scope.queueItemId,
        runId,
        revision,
        rendezvousId,
        recipientId: LOCAL_PARTICIPANT_ID,
        positionSeconds,
        playbackRate: 1,
        startAtRoomTimeMs,
        finalizeByRoomTimeMs,
      });
      const armed = await this.#manager.armCutoverCandidate(port, arm);
      if (!record.live || this.#candidate !== record) {
        await this.#manager.retireExactCutoverPort(port);
        return scheduleSuperseded();
      }
      if (armed.status !== 'armed') {
        this.#invalidate(record, 'Legacy bounded arm was rejected');
        await this.#joinRetirement(record);
        return scheduleFailed(new Error('Bounded source rejected arm'));
      }
      const finalizedAtRoomTimeMs = this.#readRoomTime();
      if (finalizedAtRoomTimeMs > startAtRoomTimeMs) {
        this.#invalidate(record, 'Legacy bounded finalization missed start');
        await this.#joinRetirement(record);
        return scheduleFailed(new Error('Bounded finalization missed its start boundary'));
      }
      const finalization = await this.#manager.finalizeCutoverCandidate(
        port,
        freezeRecord({
          protocolVersion: 2 as const,
          kind: 'rendezvous-finalize' as const,
          queueItemId: record.scope.queueItemId,
          runId,
          revision,
          rendezvousId,
          recipientId: LOCAL_PARTICIPANT_ID,
          startAtRoomTimeMs,
          finalizedAtRoomTimeMs,
        }),
      );
      if (!record.live || this.#candidate !== record || record.controller.signal.aborted) {
        await this.#manager.retireExactCutoverPort(port);
        return scheduleSuperseded();
      }
      record.phase = 'scheduled';
      void this.#settleScheduledRecord(
        record,
        runId,
        revision,
        finalization.started,
      ).then(settle);
      return scheduled(startAtRoomTimeMs, primedSnapshot, settled);
    } catch (error) {
      const wasLive = record.live && this.#candidate === record;
      let failure = error;
      this.#invalidate(record, 'Legacy bounded scheduling failed');
      try {
        await this.#joinRetirement(record);
      } catch (cleanupError) {
        if (wasLive)
          failure = new AggregateError([failure, cleanupError], 'Scheduling and cleanup failed');
      }
      this.#reconcileManagerCurrent();
      return wasLive ? scheduleFailed(failure) : scheduleSuperseded();
    }
  }

  async #settleScheduledRecord(
    record: LeaseRecord,
    runId: string,
    revision: number,
    started: Promise<unknown>,
  ): Promise<LegacyBoundedFileControlOutcome> {
    const port = record.port;
    if (!port) return superseded();
    const start = await waitForStartedOrAbort(record.controller.signal, started);
    if (start.status === 'aborted') return superseded();
    if (start.status === 'rejected') {
      const wasLive = record.live && this.#candidate === record;
      let failure = start.error;
      this.#invalidate(record, 'Legacy bounded start evidence failed');
      try {
        await this.#joinRetirement(record);
      } catch (cleanupError) {
        if (wasLive) {
          failure = new AggregateError(
            [failure, cleanupError],
            'Start evidence and cleanup failed',
          );
        }
      }
      this.#reconcileManagerCurrent();
      return wasLive ? failed(failure) : superseded();
    }
    if (
      !record.live ||
      this.#candidate !== record ||
      this.#manager.currentCutoverPort() !== port
    ) {
      this.#invalidate(record, 'Legacy bounded manager current changed during commit');
      try {
        await this.#joinRetirement(record);
      } catch {
        // A superseded commit cannot regain authority because cleanup failed.
      }
      this.#reconcileManagerCurrent();
      return superseded();
    }
    const previous = this.#current;
    this.#candidate = null;
    this.#current = record;
    record.phase = 'current';
    record.runId = runId;
    record.revision = revision;
    if (previous && previous !== record) {
      this.#invalidate(previous, 'Legacy bounded current was replaced');
      void this.#joinRetirement(previous).catch(() => undefined);
    }
    return applied(this.#manager.currentCutoverSnapshot(port));
  }

  #transition(
    lease: LegacyBoundedFileLease,
    scope: LegacyBoundedFileScope,
    kind: 'pause' | 'seek',
    atRoomTimeMs: number,
    positionSeconds: number | null,
  ): Promise<LegacyBoundedFileControlOutcome> {
    const record = this.#lookup(lease, scope);
    if (!record || this.#current !== record || !record.port) {
      return Promise.resolve(superseded());
    }
    if (
      !finiteNonNegative(atRoomTimeMs) ||
      (kind === 'seek' && !finiteNonNegative(positionSeconds))
    ) {
      return Promise.resolve(failed(new TypeError(`Bounded ${kind} input is invalid`)));
    }
    if (record.transitionPromise) return Promise.resolve(rejected('busy'));
    const task = this.#runTransition(record, kind, atRoomTimeMs, positionSeconds);
    record.transitionPromise = task;
    const settleTransition = () => {
      if (record.transitionPromise === task) record.transitionPromise = null;
    };
    void task.then(settleTransition, settleTransition);
    return task;
  }

  async #runTransition(
    record: LeaseRecord,
    kind: 'pause' | 'seek',
    atRoomTimeMs: number,
    positionSeconds: number | null,
  ): Promise<LegacyBoundedFileControlOutcome> {
    const port = record.port;
    if (!port) return superseded();
    const snapshot = this.#manager.currentCutoverSnapshot(port);
    const from = this.#exactCurrentRun(record, snapshot);
    if (!from || from.revision >= Number.MAX_SAFE_INTEGER) {
      return this.#failAndRetire(record, new Error('Bounded current revision is not exact'));
    }
    const to = freezeRecord({ ...from, revision: from.revision + 1 });
    try {
      const effectiveAtRoomTimeMs = Math.max(
        atRoomTimeMs,
        this.#readRoomTime() + IMMEDIATE_CONTROL_LEAD_MS,
      );
      const result = await (async () => {
        if (kind === 'pause') {
          const intent: FilePlaybackPauseTransitionIntent = freezeRecord({
            kind: 'file-playback-pause-transition' as const,
            from,
            to,
            atRoomTimeMs: effectiveAtRoomTimeMs,
          });
          return this.#manager.pauseCurrentCutover(port, intent);
        }
        const intent: FilePlaybackSeekTransitionIntent = freezeRecord({
          kind: 'file-playback-seek-transition' as const,
          from,
          to,
          positionSeconds: positionSeconds as number,
          atRoomTimeMs: effectiveAtRoomTimeMs,
        });
        return this.#manager.seekCurrentCutover(port, intent);
      })();
      if (!record.live || this.#current !== record) return superseded();
      if (result.status === 'rejected') return rejected(result.reason);
      await result.applied;
      if (!record.live || this.#current !== record) return superseded();
      record.revision = to.revision;
      record.phase = 'paused';
      return applied(this.#manager.currentCutoverSnapshot(port));
    } catch (error) {
      if (!record.live || this.#current !== record) return superseded();
      return this.#failAndRetire(record, error);
    }
  }

  async #stopRecord(
    record: LeaseRecord,
    atRoomTimeMs: number,
  ): Promise<LegacyBoundedFileControlOutcome> {
    const port = record.port;
    const audioContext = record.audioContext;
    if (!port || !audioContext) return superseded();
    try {
      const snapshot = this.#manager.currentCutoverSnapshot(port);
      const from = this.#exactCurrentRun(record, snapshot);
      if (!from || from.revision >= Number.MAX_SAFE_INTEGER) {
        return this.#failAndRetire(record, new Error('Bounded current revision is not exact'));
      }
      const nowRoomTimeMs = this.#readRoomTime();
      const to = freezeRecord({ ...from, revision: from.revision + 1 });

      // Natural EOF is already physically stopped and cannot accept a future
      // scheduled stop. Retire it through the manager's exact ended-evidence
      // path instead of misclassifying normal completion as renderer failure.
      if (snapshot?.phase === 'ended') {
        const endedIntent: Readonly<FilePlaybackEndedTransitionIntent> = freezeRecord({
          kind: 'file-playback-ended-transition' as const,
          from,
          to,
          observedAtRoomTimeMs: nowRoomTimeMs,
        });
        await this.#manager.retireEndedCurrent(port, endedIntent);
        const wasCurrent = record.live && this.#current === record;
        this.#invalidate(record, 'Legacy bounded natural end was retired');
        await this.#joinRetirement(record);
        if (!wasCurrent) return superseded();
        record.revision = to.revision;
        return applied(null);
      }

      const effectiveAtRoomTimeMs = Math.max(
        atRoomTimeMs,
        nowRoomTimeMs + IMMEDIATE_CONTROL_LEAD_MS,
      );
      const contextTimeSeconds =
        audioContext.currentTime + (effectiveAtRoomTimeMs - nowRoomTimeMs) / 1_000;
      const result = await this.#manager.stopCurrentCutover(port, {
        kind: 'file-playback-stop-transition',
        from,
        to,
        atRoomTimeMs: effectiveAtRoomTimeMs,
        target: createFilePlaybackCutoverTarget(
          audioContext,
          contextTimeSeconds,
          Math.round(contextTimeSeconds * audioContext.sampleRate),
        ),
      });
      await result.applied;
      const wasCurrent = record.live && this.#current === record;
      this.#invalidate(record, 'Legacy bounded stop was applied');
      await this.#joinRetirement(record);
      if (!wasCurrent) return superseded();
      record.revision = to.revision;
      return applied(null);
    } catch (error) {
      if (!record.live || this.#current !== record) return superseded();
      return this.#failAndRetire(record, error);
    }
  }

  async #failAndRetire(
    record: LeaseRecord,
    error: unknown,
  ): Promise<LegacyBoundedFileControlOutcome> {
    let failure = error;
    this.#invalidate(record, 'Legacy bounded native operation failed');
    try {
      await this.#joinRetirement(record);
    } catch (cleanupError) {
      failure = new AggregateError([failure, cleanupError], 'Native operation and cleanup failed');
    }
    return failed(failure);
  }

  #exactCurrentRun(
    record: LeaseRecord,
    snapshot: FilePlaybackSourceSnapshot | null,
  ): Readonly<RevisionedPlaybackRun> | null {
    const run = snapshot?.run;
    if (
      !run ||
      record.runId === null ||
      run.queueItemId !== record.scope.queueItemId ||
      run.runId !== record.runId ||
      run.revision !== record.revision
    ) {
      return null;
    }
    return freezeRecord({
      queueItemId: run.queueItemId,
      runId: run.runId,
      revision: run.revision,
    });
  }

  #lookup(lease: LegacyBoundedFileLease, scope: LegacyBoundedFileScope): LeaseRecord | null {
    if (lease === null || typeof lease !== 'object') return null;
    const canonical = readScope(scope);
    if (!canonical) return null;
    const record = this.#leases.get(lease);
    return record && record.live && sameScope(record.scope, canonical) ? record : null;
  }

  #invalidate(record: LeaseRecord, reason: string): void {
    if (!record.live) return;
    record.live = false;
    this.#leases.delete(record.lease);
    record.phase = 'retiring';
    if (this.#candidate === record) this.#candidate = null;
    if (this.#current === record) this.#current = null;
    if (!record.controller.signal.aborted) {
      record.controller.abort(new DOMException(reason, 'AbortError'));
    }
  }

  #joinRetirement(record: LeaseRecord): Promise<void> {
    if (record.cleanupPromise) return record.cleanupPromise;
    const ownedPort = record.port;
    const cleanup = (async () => {
      try {
        // Logical retirement cannot be held hostage by an opener that ignores
        // AbortSignal. A source that appears later is destroyed by
        // #prepareRecord; a manager capability already known here is joined.
        if (ownedPort) await this.#manager.retireExactCutoverPort(ownedPort);
      } finally {
        record.phase = 'retired';
        this.#records.delete(record);
      }
    })();
    record.cleanupPromise = cleanup;
    return cleanup;
  }

  #reconcileManagerCurrent(): void {
    const current = this.#current;
    if (!current?.port || this.#manager.currentCutoverPort() === current.port) return;
    this.#invalidate(current, 'Legacy bounded manager revoked the current renderer');
    void this.#joinRetirement(current).catch(() => undefined);
  }

  #readRoomTime(): number {
    const value = this.#nowRoomTimeMs();
    if (!finiteNonNegative(value)) throw new Error('Legacy bounded room clock is invalid');
    return value;
  }
}

/**
 * Construct the product port behind its lease-scoped contract. The concrete
 * class remains private so callers cannot grow a dependency on implementation
 * state beyond the V1 bridge lifecycle.
 */
export function createLegacyBoundedFilePort(
  options: LegacyBoundedFilePortOptions,
): LegacyBoundedFilePortContract {
  return new LegacyBoundedFilePort(options);
}

/** White-box seam for port-only contract tests. */
export { LegacyBoundedFilePort as LegacyBoundedFilePortForTests };

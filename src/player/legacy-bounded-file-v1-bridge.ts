import type {
  LegacyBoundedFileControlOutcome,
  LegacyBoundedFileLease,
  LegacyBoundedFileOpener,
  LegacyBoundedFilePortContract,
  LegacyBoundedFilePrepareOutcome,
  LegacyBoundedFileScheduleOutcome,
  LegacyBoundedFileScope,
} from './legacy-bounded-file-port-contract.ts';
import { isEncodedAudioSourceIdentity } from './sources/encoded-audio-source.ts';

type LegacyBoundedV1CanonicalPhase = 'idle' | 'playing' | 'paused' | 'stopped';
type LegacyBoundedV1OperationKind =
  | 'prepare'
  | 'play'
  | 'pause'
  | 'seek-paused'
  | 'seek-playing'
  | 'stop'
  | 'retire';

export interface LegacyBoundedV1BridgeSnapshot {
  readonly schemaVersion: 1;
  readonly scope: Readonly<LegacyBoundedFileScope> | null;
  readonly phase: LegacyBoundedV1CanonicalPhase;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly anchorRoomTimeMs: number | null;
  readonly pending: Readonly<{
    readonly token: number;
    readonly kind: LegacyBoundedV1OperationKind;
  }> | null;
  readonly renderer: Readonly<{
    readonly hasCurrent: boolean;
    readonly hasCandidate: boolean;
  }>;
  readonly fallbackRequired: boolean;
}

interface LegacyBoundedV1MediaInput {
  readonly scope: LegacyBoundedFileScope;
  readonly open: LegacyBoundedFileOpener;
}

interface LegacyBoundedV1PlayInput extends LegacyBoundedV1MediaInput {
  readonly positionSeconds: number;
  readonly startAtRoomTimeMs: number;
}

interface LegacyBoundedV1TimedPositionInput {
  readonly scope: LegacyBoundedFileScope;
  readonly positionSeconds: number;
  readonly atRoomTimeMs: number;
}

interface LegacyBoundedV1PlayingSeekInput extends LegacyBoundedV1MediaInput {
  readonly positionSeconds: number;
  readonly startAtRoomTimeMs: number;
}

export type LegacyBoundedV1PrepareOutcome =
  | Readonly<{
      readonly status: 'ready';
      readonly snapshot: LegacyBoundedV1BridgeSnapshot;
    }>
  | Readonly<{
      readonly status: 'fallback';
      readonly reason: 'unsupported-source';
      readonly snapshot: LegacyBoundedV1BridgeSnapshot;
    }>
  | Readonly<{
      readonly status: 'superseded';
      readonly snapshot: LegacyBoundedV1BridgeSnapshot;
    }>
  | Readonly<{
      readonly status: 'failed';
      readonly error: unknown;
      readonly snapshot: LegacyBoundedV1BridgeSnapshot;
    }>;

export type LegacyBoundedV1ControlOutcome =
  | Readonly<{
      readonly status: 'applied';
      readonly snapshot: LegacyBoundedV1BridgeSnapshot;
    }>
  | Readonly<{
      readonly status: 'fallback';
      readonly reason: 'unsupported-source' | 'renderer-unavailable';
      readonly snapshot: LegacyBoundedV1BridgeSnapshot;
    }>
  | Readonly<{
      readonly status: 'superseded';
      readonly snapshot: LegacyBoundedV1BridgeSnapshot;
    }>
  | Readonly<{
      readonly status: 'failed';
      readonly error: unknown;
      readonly snapshot: LegacyBoundedV1BridgeSnapshot;
    }>;

export type LegacyBoundedV1ScheduleOutcome =
  | Readonly<{
      readonly status: 'scheduled';
      readonly startAtRoomTimeMs: number;
      readonly snapshot: LegacyBoundedV1BridgeSnapshot;
      readonly settled: Promise<LegacyBoundedV1ControlOutcome>;
    }>
  | Exclude<LegacyBoundedV1ControlOutcome, { readonly status: 'applied' }>;

interface LegacyBoundedV1BridgeOptions {
  readonly port: LegacyBoundedFilePortContract;
  /** The same monotonic room clock sampled by stable V1 playback control. */
  readonly nowRoomTimeMs: () => number;
}

export interface LegacyBoundedFileV1BridgeContract {
  snapshot(): LegacyBoundedV1BridgeSnapshot;
  prepare(input: LegacyBoundedV1MediaInput): Promise<LegacyBoundedV1PrepareOutcome>;
  play(input: LegacyBoundedV1PlayInput): Promise<LegacyBoundedV1ControlOutcome>;
  schedulePlay(input: LegacyBoundedV1PlayInput): Promise<LegacyBoundedV1ScheduleOutcome>;
  pause(input: LegacyBoundedV1TimedPositionInput): Promise<LegacyBoundedV1ControlOutcome>;
  seekPaused(input: LegacyBoundedV1TimedPositionInput): Promise<LegacyBoundedV1ControlOutcome>;
  seekPlaying(input: LegacyBoundedV1PlayingSeekInput): Promise<LegacyBoundedV1ControlOutcome>;
  scheduleSeekPlaying(
    input: LegacyBoundedV1PlayingSeekInput,
  ): Promise<LegacyBoundedV1ScheduleOutcome>;
  stop(input: LegacyBoundedV1TimedPositionInput): Promise<LegacyBoundedV1ControlOutcome>;
  retire(scope: LegacyBoundedFileScope): Promise<LegacyBoundedV1ControlOutcome>;
}

interface CanonicalTimeline {
  scope: Readonly<LegacyBoundedFileScope> | null;
  phase: LegacyBoundedV1CanonicalPhase;
  positionSeconds: number;
  durationSeconds: number | null;
  anchorRoomTimeMs: number | null;
  fallbackRequired: boolean;
}

interface CandidateRecord {
  readonly lease: LegacyBoundedFileLease;
  readonly scope: Readonly<LegacyBoundedFileScope>;
  readonly open: LegacyBoundedFileOpener;
  durationSeconds: number | null;
  readonly ready: Promise<LegacyBoundedFilePrepareOutcome>;
  claimToken: number | null;
}

interface CurrentRecord {
  readonly lease: LegacyBoundedFileLease;
  readonly scope: Readonly<LegacyBoundedFileScope>;
  readonly durationSeconds: number;
  nativePhase: 'playing' | 'paused';
}

interface PendingOperation<T> {
  readonly token: number;
  readonly kind: LegacyBoundedV1OperationKind;
  readonly key: string;
  readonly promise: Promise<T>;
  readonly scheduledPromise?: Promise<LegacyBoundedV1ScheduleOutcome>;
  readonly controller: AbortController;
}

interface ReplacementOperation {
  readonly scheduled: Promise<LegacyBoundedV1ScheduleOutcome>;
  readonly settled: Promise<LegacyBoundedV1ControlOutcome>;
}

type CancelableWait<T> =
  | Readonly<{ readonly status: 'fulfilled'; readonly value: T }>
  | Readonly<{ readonly status: 'rejected'; readonly error: unknown }>
  | Readonly<{ readonly status: 'cancelled' }>;

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
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_RE.test(value);
}

function canonicalScope(value: unknown): Readonly<LegacyBoundedFileScope> | null {
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
      !boundedIdentifier(roomEpoch) ||
      !boundedIdentifier(bridgeGeneration) ||
      !boundedIdentifier(bindingId) ||
      typeof queueItemId !== 'string' ||
      !QUEUE_ITEM_ID_RE.test(queueItemId) ||
      !isEncodedAudioSourceIdentity(sourceIdentity) ||
      !boundedIdentifier(descriptorId) ||
      typeof descriptorVersion !== 'number' ||
      !Number.isSafeInteger(descriptorVersion) ||
      descriptorVersion <= 0
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

function scopeKey(scope: Readonly<LegacyBoundedFileScope>): string {
  return JSON.stringify(SCOPE_KEYS.map((key) => scope[key]));
}

function positionKey(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

function mediaInput(input: LegacyBoundedV1MediaInput): Readonly<{
  scope: Readonly<LegacyBoundedFileScope>;
  open: LegacyBoundedFileOpener;
}> | null {
  const scope = canonicalScope(input?.scope);
  const open = input?.open;
  if (!scope || typeof open !== 'function') return null;
  return freezeRecord({ scope, open });
}

function validPosition(
  positionSeconds: unknown,
  durationSeconds: number | null,
): positionSeconds is number {
  return (
    finiteNonNegative(positionSeconds) &&
    (durationSeconds === null || positionSeconds <= durationSeconds)
  );
}

function readyDuration(outcome: LegacyBoundedFilePrepareOutcome): number | null {
  return outcome.status === 'ready' && finitePositive(outcome.snapshot.durationSeconds)
    ? outcome.snapshot.durationSeconds
    : null;
}

/**
 * A local renderer bridge under stable V1 authority.
 *
 * It owns no transport, room membership, wire sequence, application state, or
 * global singleton. The canonical timeline below is only the exact V1
 * projection supplied through these controls; native renderer evidence never
 * rewrites it.
 */
class LegacyBoundedFileV1Bridge implements LegacyBoundedFileV1BridgeContract {
  readonly #port: LegacyBoundedFilePortContract;
  readonly #nowRoomTimeMs: () => number;
  readonly #timeline: CanonicalTimeline = {
    scope: null,
    phase: 'idle',
    positionSeconds: 0,
    durationSeconds: null,
    anchorRoomTimeMs: null,
    fallbackRequired: false,
  };
  #candidate: CandidateRecord | null = null;
  #current: CurrentRecord | null = null;
  #pending: PendingOperation<unknown> | null = null;
  #token = 0;

  constructor(options: LegacyBoundedV1BridgeOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      options.port === null ||
      typeof options.port !== 'object' ||
      typeof options.nowRoomTimeMs !== 'function'
    ) {
      throw new TypeError('Legacy bounded V1 bridge options are invalid');
    }
    this.#port = options.port;
    this.#nowRoomTimeMs = options.nowRoomTimeMs;
  }

  snapshot(): LegacyBoundedV1BridgeSnapshot {
    const positionSeconds = this.#projectPosition();
    return freezeRecord({
      schemaVersion: 1 as const,
      scope: this.#timeline.scope,
      phase: this.#timeline.phase,
      positionSeconds,
      durationSeconds: this.#timeline.durationSeconds,
      anchorRoomTimeMs: this.#timeline.anchorRoomTimeMs,
      pending: this.#pending
        ? freezeRecord({ token: this.#pending.token, kind: this.#pending.kind })
        : null,
      renderer: freezeRecord({
        hasCurrent: this.#current !== null,
        hasCandidate: this.#candidate !== null,
      }),
      fallbackRequired: this.#timeline.fallbackRequired,
    });
  }

  prepare(input: LegacyBoundedV1MediaInput): Promise<LegacyBoundedV1PrepareOutcome> {
    const media = mediaInput(input);
    if (!media) {
      return Promise.resolve(
        this.#prepareFailed(new TypeError('V1 bounded media input is invalid')),
      );
    }
    const key = `prepare:${scopeKey(media.scope)}`;
    const duplicate = this.#duplicate<LegacyBoundedV1PrepareOutcome>('prepare', key);
    if (duplicate) return duplicate;
    if (this.#pending && this.#pending.kind !== 'prepare') {
      return Promise.resolve(
        this.#prepareFailed(new Error('A V1 bounded control operation is already pending')),
      );
    }

    let candidate: CandidateRecord;
    try {
      candidate = this.#candidateFor(media);
    } catch (error) {
      return Promise.resolve(this.#prepareFailed(error));
    }
    const prior = null;
    const token = this.#nextToken();
    const promise = this.#afterPending(prior, () => this.#runPrepare(token, candidate));
    this.#pending = { token, kind: 'prepare', key, promise, controller: new AbortController() };
    return promise;
  }

  play(input: LegacyBoundedV1PlayInput): Promise<LegacyBoundedV1ControlOutcome> {
    return this.#startReplacement('play', input, false).settled;
  }

  schedulePlay(input: LegacyBoundedV1PlayInput): Promise<LegacyBoundedV1ScheduleOutcome> {
    return this.#startReplacement('play', input, false).scheduled;
  }

  pause(input: LegacyBoundedV1TimedPositionInput): Promise<LegacyBoundedV1ControlOutcome> {
    const exact = this.#timedPositionInput(input);
    if (!exact) {
      return Promise.resolve(
        this.#controlFailed(new TypeError('V1 bounded pause input is invalid')),
      );
    }
    if (!this.#ownsCanonicalScope(exact.scope)) return Promise.resolve(this.#superseded());
    const key = `pause:${scopeKey(exact.scope)}:${positionKey(exact.positionSeconds)}:${positionKey(exact.atRoomTimeMs)}`;
    const duplicate = this.#duplicate<LegacyBoundedV1ControlOutcome>('pause', key);
    if (duplicate) return duplicate;

    const prior = this.#nativeDrain();
    const token = this.#nextToken();
    const candidate = this.#takeCandidate();
    this.#setPaused(exact.positionSeconds);
    const current = this.#current;
    const promise = this.#afterPending(prior, () =>
      this.#runPause(token, current, candidate, exact.atRoomTimeMs),
    );
    this.#pending = { token, kind: 'pause', key, promise, controller: new AbortController() };
    return promise;
  }

  seekPaused(input: LegacyBoundedV1TimedPositionInput): Promise<LegacyBoundedV1ControlOutcome> {
    const exact = this.#timedPositionInput(input);
    if (!exact) {
      return Promise.resolve(
        this.#controlFailed(new TypeError('V1 bounded paused seek input is invalid')),
      );
    }
    if (!this.#ownsCanonicalScope(exact.scope) || this.#timeline.phase !== 'paused') {
      return Promise.resolve(this.#superseded());
    }
    const key = `seek-paused:${scopeKey(exact.scope)}:${positionKey(exact.positionSeconds)}:${positionKey(exact.atRoomTimeMs)}`;
    const duplicate = this.#duplicate<LegacyBoundedV1ControlOutcome>('seek-paused', key);
    if (duplicate) return duplicate;

    // Before the first native start there is no current renderer to seek. The
    // staged source is position-agnostic until commitPlay, so the canonical V1
    // paused position is already the complete operation. Retaining the exact
    // candidate lets the following PLAY prime it at this fresh position.
    if (
      !this.#pending &&
      !this.#current &&
      this.#candidate?.claimToken === null &&
      sameScope(this.#candidate.scope, exact.scope)
    ) {
      this.#setPaused(exact.positionSeconds);
      return Promise.resolve(
        freezeRecord({ status: 'applied' as const, snapshot: this.snapshot() }),
      );
    }

    const prior = this.#nativeDrain();
    const token = this.#nextToken();
    this.#setPaused(exact.positionSeconds);
    const current = this.#current;
    const promise = this.#afterPending(prior, () =>
      this.#runPausedSeek(token, current, exact.positionSeconds, exact.atRoomTimeMs),
    );
    this.#pending = {
      token,
      kind: 'seek-paused',
      key,
      promise,
      controller: new AbortController(),
    };
    return promise;
  }

  seekPlaying(input: LegacyBoundedV1PlayingSeekInput): Promise<LegacyBoundedV1ControlOutcome> {
    return this.#startReplacement('seek-playing', input, true).settled;
  }

  scheduleSeekPlaying(
    input: LegacyBoundedV1PlayingSeekInput,
  ): Promise<LegacyBoundedV1ScheduleOutcome> {
    return this.#startReplacement('seek-playing', input, true).scheduled;
  }

  stop(input: LegacyBoundedV1TimedPositionInput): Promise<LegacyBoundedV1ControlOutcome> {
    const exact = this.#timedPositionInput(input);
    if (!exact) {
      return Promise.resolve(
        this.#controlFailed(new TypeError('V1 bounded stop input is invalid')),
      );
    }
    if (!this.#ownsCanonicalScope(exact.scope)) return Promise.resolve(this.#superseded());
    const key = `stop:${scopeKey(exact.scope)}:${positionKey(exact.positionSeconds)}:${positionKey(exact.atRoomTimeMs)}`;
    const duplicate = this.#duplicate<LegacyBoundedV1ControlOutcome>('stop', key);
    if (duplicate) return duplicate;

    const prior = this.#nativeDrain();
    const token = this.#nextToken();
    const candidate = this.#takeCandidate();
    this.#timeline.phase = 'stopped';
    this.#timeline.positionSeconds = exact.positionSeconds;
    this.#timeline.anchorRoomTimeMs = null;
    const current = this.#current;
    const promise = this.#afterPending(prior, () =>
      this.#runStop(token, current, candidate, exact.atRoomTimeMs),
    );
    this.#pending = { token, kind: 'stop', key, promise, controller: new AbortController() };
    return promise;
  }

  retire(scope: LegacyBoundedFileScope): Promise<LegacyBoundedV1ControlOutcome> {
    const exactScope = canonicalScope(scope);
    if (!exactScope) {
      return Promise.resolve(this.#superseded());
    }
    const key = `retire:${scopeKey(exactScope)}`;
    const duplicate = this.#duplicate<LegacyBoundedV1ControlOutcome>('retire', key);
    if (duplicate) return duplicate;
    if (!this.#ownsAnyScope(exactScope)) {
      return Promise.resolve(this.#superseded());
    }

    const prior = this.#pending?.kind === 'retire' ? this.#pending.promise : null;
    const token = this.#nextToken();
    const candidate = this.#takeCandidate();
    const current = this.#takeCurrent();
    if (this.#timeline.scope && sameScope(this.#timeline.scope, exactScope)) {
      this.#timeline.scope = null;
      this.#timeline.phase = 'idle';
      this.#timeline.positionSeconds = 0;
      this.#timeline.durationSeconds = null;
      this.#timeline.anchorRoomTimeMs = null;
      this.#timeline.fallbackRequired = false;
    }
    const promise = this.#afterPending(prior, () => this.#runRetire(token, candidate, current));
    this.#pending = { token, kind: 'retire', key, promise, controller: new AbortController() };
    return promise;
  }

  #startReplacement(
    kind: 'play' | 'seek-playing',
    input: LegacyBoundedV1PlayInput | LegacyBoundedV1PlayingSeekInput,
    requirePlaying: boolean,
  ): ReplacementOperation {
    const media = mediaInput(input);
    const positionSeconds = input?.positionSeconds;
    const startAtRoomTimeMs = input?.startAtRoomTimeMs;
    if (!media || !finiteNonNegative(positionSeconds) || !finiteNonNegative(startAtRoomTimeMs)) {
      return this.#immediateReplacement(
        this.#controlFailed(new TypeError(`V1 bounded ${kind} input is invalid`)),
      );
    }
    if (
      requirePlaying &&
      (!this.#ownsCanonicalScope(media.scope) || this.#timeline.phase !== 'playing')
    ) {
      return this.#immediateReplacement(this.#superseded());
    }
    const key = `${kind}:${scopeKey(media.scope)}:${positionKey(positionSeconds)}:${positionKey(startAtRoomTimeMs)}`;
    const duplicate = this.#duplicateReplacement(kind, key);
    if (duplicate) return duplicate;

    let candidate: CandidateRecord;
    try {
      candidate = this.#candidateFor(media);
    } catch (error) {
      const previous = this.#takeCurrent();
      if (previous) void this.#retireRecord(previous);
      this.#setUnavailable(media.scope);
      return this.#immediateReplacement(this.#controlFailed(error));
    }
    const prior = this.#nativeDrain();
    const token = this.#nextToken();
    candidate.claimToken = token;
    this.#timeline.scope = media.scope;
    this.#timeline.phase = 'playing';
    this.#timeline.positionSeconds = positionSeconds;
    this.#timeline.durationSeconds =
      candidate.durationSeconds ??
      (this.#current && sameScope(this.#current.scope, media.scope)
        ? this.#current.durationSeconds
        : null);
    this.#timeline.anchorRoomTimeMs = startAtRoomTimeMs;
    this.#timeline.fallbackRequired = false;
    let scheduledSettled = false;
    let resolveScheduled!: (outcome: LegacyBoundedV1ScheduleOutcome) => void;
    const scheduledPromise = new Promise<LegacyBoundedV1ScheduleOutcome>((resolve) => {
      resolveScheduled = (outcome) => {
        if (scheduledSettled) return;
        scheduledSettled = true;
        resolve(outcome);
      };
    });
    const promise = this.#afterPending(prior, () =>
      this.#runReplacement(token, candidate, positionSeconds, startAtRoomTimeMs, (outcome) => {
        resolveScheduled(
          freezeRecord({
            status: 'scheduled' as const,
            startAtRoomTimeMs: outcome.startAtRoomTimeMs,
            snapshot: this.snapshot(),
            settled: promise,
          }),
        );
      }),
    );
    void promise.then(
      (outcome) => {
        if (outcome.status !== 'applied') resolveScheduled(outcome);
      },
      (error) =>
        resolveScheduled(
          freezeRecord({
            status: 'failed' as const,
            error,
            snapshot: this.snapshot(),
          }),
        ),
    );
    this.#pending = {
      token,
      kind,
      key,
      promise,
      scheduledPromise,
      controller: new AbortController(),
    };
    return freezeRecord({ scheduled: scheduledPromise, settled: promise });
  }

  async #runPrepare(
    token: number,
    candidate: CandidateRecord,
  ): Promise<LegacyBoundedV1PrepareOutcome> {
    const waited = await this.#waitCancelable(token, candidate.ready);
    if (waited.status === 'cancelled') return this.#prepareSuperseded();
    if (waited.status === 'rejected') {
      if (!this.#isToken(token)) return this.#prepareSuperseded();
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#prepareSuperseded();
      this.#setUnavailable(candidate.scope);
      this.#finishToken(token);
      return this.#prepareFailed(waited.error);
    }
    const outcome = waited.value;
    if (!this.#isToken(token)) return this.#prepareSuperseded();
    if (outcome.status === 'ready') {
      const durationSeconds = readyDuration(outcome);
      if (durationSeconds === null) {
        await this.#retireFailedReplacement(candidate);
        if (!this.#isToken(token)) return this.#prepareSuperseded();
        this.#setUnavailable(candidate.scope);
        this.#finishToken(token);
        return freezeRecord({
          status: 'fallback' as const,
          reason: 'unsupported-source' as const,
          snapshot: this.snapshot(),
        });
      }
      candidate.durationSeconds = durationSeconds;
      const previous = this.#takeCurrent();
      this.#timeline.scope = candidate.scope;
      this.#timeline.phase = 'stopped';
      this.#timeline.positionSeconds = 0;
      this.#timeline.durationSeconds = durationSeconds;
      this.#timeline.anchorRoomTimeMs = null;
      this.#timeline.fallbackRequired = false;
      if (previous) await this.#retireRecord(previous);
      if (!this.#isToken(token)) {
        await this.#retireIfUnowned(candidate);
        return this.#prepareSuperseded();
      }
      this.#finishToken(token);
      return freezeRecord({ status: 'ready', snapshot: this.snapshot() });
    }
    if (outcome.status === 'fallback') {
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#prepareSuperseded();
      this.#setUnavailable(candidate.scope);
      this.#finishToken(token);
      return freezeRecord({
        status: 'fallback' as const,
        reason: 'unsupported-source' as const,
        snapshot: this.snapshot(),
      });
    }
    if (outcome.status === 'superseded') {
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#prepareSuperseded();
      this.#setUnavailable(candidate.scope);
      this.#finishToken(token);
      return this.#prepareSuperseded();
    }
    await this.#retireFailedReplacement(candidate);
    if (!this.#isToken(token)) return this.#prepareSuperseded();
    this.#setUnavailable(candidate.scope);
    this.#finishToken(token);
    return this.#prepareFailed(outcome.error);
  }

  async #runReplacement(
    token: number,
    candidate: CandidateRecord,
    positionSeconds: number,
    startAtRoomTimeMs: number,
    onScheduled: (
      outcome: Extract<LegacyBoundedFileScheduleOutcome, { readonly status: 'scheduled' }>,
    ) => void,
  ): Promise<LegacyBoundedV1ControlOutcome> {
    const waitedPreparation = await this.#waitCancelable(token, candidate.ready);
    if (waitedPreparation.status === 'cancelled') {
      await this.#retireIfUnowned(candidate);
      return this.#superseded();
    }
    if (waitedPreparation.status === 'rejected') {
      if (!this.#isToken(token)) return this.#superseded();
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#controlFailed(waitedPreparation.error);
    }
    const prepared = waitedPreparation.value;
    if (!this.#isToken(token)) {
      await this.#retireIfUnowned(candidate);
      return this.#superseded();
    }
    if (prepared.status === 'fallback') {
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return freezeRecord({
        status: 'fallback' as const,
        reason: 'unsupported-source' as const,
        snapshot: this.snapshot(),
      });
    }
    if (prepared.status === 'superseded') {
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#superseded();
      this.#finishToken(token);
      return this.#superseded();
    }
    if (prepared.status === 'failed') {
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#controlFailed(prepared.error);
    }
    const durationSeconds = readyDuration(prepared);
    if (durationSeconds === null) {
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#fallbackUnsupported();
    }
    candidate.durationSeconds = durationSeconds;
    this.#timeline.durationSeconds = durationSeconds;
    if (!validPosition(positionSeconds, durationSeconds)) {
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#controlFailed(
        new RangeError('V1 bounded position is after the authoritative media duration'),
      );
    }

    const waitedSchedule = await this.#waitCancelable(
      token,
      this.#port.schedulePlay(candidate.lease, candidate.scope, {
        positionSeconds,
        startAtRoomTimeMs,
      }),
    );
    if (waitedSchedule.status === 'cancelled') {
      await this.#retireIfUnowned(candidate);
      return this.#superseded();
    }
    if (waitedSchedule.status === 'rejected') {
      if (!this.#isToken(token)) return this.#superseded();
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#controlFailed(waitedSchedule.error);
    }
    const scheduled = waitedSchedule.value;
    if (!this.#isToken(token)) {
      await this.#retireIfUnowned(candidate);
      return this.#superseded();
    }
    if (scheduled.status !== 'scheduled') {
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#controlOutcomeFromPortFailure(scheduled);
    }
    onScheduled(scheduled);

    const waitedCommit = await this.#waitCancelable(token, scheduled.settled);
    if (waitedCommit.status === 'cancelled') {
      await this.#retireIfUnowned(candidate);
      return this.#superseded();
    }
    if (waitedCommit.status === 'rejected') {
      if (!this.#isToken(token)) return this.#superseded();
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#controlFailed(waitedCommit.error);
    }
    const committed = waitedCommit.value;
    if (!this.#isToken(token)) {
      await this.#retireIfUnowned(candidate);
      return this.#superseded();
    }
    if (committed.status !== 'applied') {
      await this.#retireFailedReplacement(candidate);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#controlOutcomeFromPortFailure(committed);
    }

    const previous = this.#current;
    this.#candidate = this.#candidate === candidate ? null : this.#candidate;
    this.#current = {
      lease: candidate.lease,
      scope: candidate.scope,
      durationSeconds,
      nativePhase: 'playing',
    };
    this.#finishToken(token);
    if (previous && previous.lease !== candidate.lease) {
      void this.#retireRecord(previous);
    }
    return freezeRecord({ status: 'applied', snapshot: this.snapshot() });
  }

  async #runPause(
    token: number,
    current: CurrentRecord | null,
    candidate: CandidateRecord | null,
    atRoomTimeMs: number,
  ): Promise<LegacyBoundedV1ControlOutcome> {
    if (!current) {
      return this.#runCandidatePause(token, candidate);
    }
    if (candidate) await this.#retireRecord(candidate);
    if (!this.#isToken(token)) return this.#superseded();
    if (current.nativePhase === 'paused') {
      this.#finishToken(token);
      return freezeRecord({ status: 'applied', snapshot: this.snapshot() });
    }
    let outcome: LegacyBoundedFileControlOutcome;
    try {
      outcome = await this.#port.pause(current.lease, current.scope, { atRoomTimeMs });
    } catch (error) {
      await this.#localizeCurrentFailure(current);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#controlFailed(error);
    }
    if (outcome.status === 'applied') {
      if (this.#current === current) current.nativePhase = 'paused';
      if (!this.#isToken(token)) return this.#superseded();
      this.#finishToken(token);
      return freezeRecord({ status: 'applied', snapshot: this.snapshot() });
    }
    await this.#localizeCurrentFailure(current);
    if (!this.#isToken(token)) return this.#superseded();
    this.#timeline.fallbackRequired = true;
    this.#finishToken(token);
    return this.#controlOutcomeFromPortFailure(outcome);
  }

  /**
   * PAUSE can supersede the very first PLAY before native start evidence has
   * promoted a candidate to current. That is a normal user race, not renderer
   * failure. Keep an unclaimed staged candidate, or retire a one-shot claimed
   * candidate and stage a fresh exact incarnation for the later resume.
   */
  async #runCandidatePause(
    token: number,
    candidate: CandidateRecord | null,
  ): Promise<LegacyBoundedV1ControlOutcome> {
    // A successor can synchronously supersede PAUSE before this deferred body
    // gets its first microtask. In that case it may already have installed a
    // fresh candidate. Never republish this retired predecessor over the
    // successor's exact lease.
    if (!this.#isToken(token)) {
      if (candidate) await this.#retireIfUnowned(candidate);
      return this.#superseded();
    }
    if (!candidate) {
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#fallbackUnavailable();
    }

    let pausedCandidate = candidate;
    if (candidate.claimToken !== null) {
      await this.#retireRecord(candidate);
      if (!this.#isToken(token)) return this.#superseded();
      try {
        pausedCandidate = this.#candidateFor({
          scope: candidate.scope,
          open: candidate.open,
        });
      } catch (error) {
        this.#timeline.fallbackRequired = true;
        this.#finishToken(token);
        return this.#controlFailed(error);
      }
    } else {
      // Re-publish the candidate taken by pause() before waiting. A successor
      // PLAY may atomically claim it; cancellation then leaves that successor's
      // lease untouched through #retireIfUnowned.
      this.#candidate = candidate;
    }

    const waited = await this.#waitCancelable(token, pausedCandidate.ready);
    if (waited.status === 'cancelled') {
      await this.#retireIfUnowned(pausedCandidate);
      return this.#superseded();
    }
    if (waited.status === 'rejected') {
      this.#dropCandidate(pausedCandidate);
      await this.#retireRecord(pausedCandidate);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#controlFailed(waited.error);
    }
    if (!this.#isToken(token)) {
      await this.#retireIfUnowned(pausedCandidate);
      return this.#superseded();
    }

    const prepared = waited.value;
    if (prepared.status === 'ready') {
      const durationSeconds = readyDuration(prepared);
      if (durationSeconds === null) {
        this.#dropCandidate(pausedCandidate);
        await this.#retireRecord(pausedCandidate);
        this.#timeline.fallbackRequired = true;
        this.#finishToken(token);
        return this.#fallbackUnsupported();
      }
      pausedCandidate.durationSeconds = durationSeconds;
      this.#timeline.durationSeconds = durationSeconds;
      this.#timeline.fallbackRequired = false;
      this.#finishToken(token);
      return freezeRecord({ status: 'applied', snapshot: this.snapshot() });
    }

    this.#dropCandidate(pausedCandidate);
    this.#finishToken(token);
    if (prepared.status === 'fallback') {
      this.#timeline.fallbackRequired = true;
      return freezeRecord({
        status: 'fallback' as const,
        reason: 'unsupported-source' as const,
        snapshot: this.snapshot(),
      });
    }
    if (prepared.status === 'superseded') return this.#superseded();
    this.#timeline.fallbackRequired = true;
    return this.#controlFailed(prepared.error);
  }

  async #runPausedSeek(
    token: number,
    current: CurrentRecord | null,
    positionSeconds: number,
    atRoomTimeMs: number,
  ): Promise<LegacyBoundedV1ControlOutcome> {
    if (!current || current.nativePhase !== 'paused') {
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#fallbackUnavailable();
    }
    let outcome: LegacyBoundedFileControlOutcome;
    try {
      outcome = await this.#port.seek(current.lease, current.scope, {
        positionSeconds,
        atRoomTimeMs,
      });
    } catch (error) {
      await this.#localizeCurrentFailure(current);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#controlFailed(error);
    }
    if (outcome.status === 'applied') {
      if (!this.#isToken(token)) return this.#superseded();
      this.#finishToken(token);
      return freezeRecord({ status: 'applied', snapshot: this.snapshot() });
    }
    await this.#localizeCurrentFailure(current);
    if (!this.#isToken(token)) return this.#superseded();
    this.#timeline.fallbackRequired = true;
    this.#finishToken(token);
    return this.#controlOutcomeFromPortFailure(outcome);
  }

  async #runStop(
    token: number,
    current: CurrentRecord | null,
    candidate: CandidateRecord | null,
    atRoomTimeMs: number,
  ): Promise<LegacyBoundedV1ControlOutcome> {
    if (candidate) await this.#retireRecord(candidate);
    if (!this.#isToken(token)) return this.#superseded();
    if (!current) {
      this.#finishToken(token);
      return freezeRecord({ status: 'applied', snapshot: this.snapshot() });
    }
    if (this.#current !== current) {
      if (
        this.#current === null &&
        this.#candidate === null &&
        this.#timeline.scope !== null &&
        sameScope(this.#timeline.scope, current.scope) &&
        this.#timeline.phase === 'stopped'
      ) {
        this.#finishToken(token);
        return freezeRecord({ status: 'applied', snapshot: this.snapshot() });
      }
      return this.#superseded();
    }
    let outcome: LegacyBoundedFileControlOutcome;
    try {
      outcome = await this.#port.stop(current.lease, current.scope, { atRoomTimeMs });
    } catch (error) {
      await this.#localizeCurrentFailure(current);
      if (!this.#isToken(token)) return this.#superseded();
      this.#timeline.fallbackRequired = true;
      this.#finishToken(token);
      return this.#controlFailed(error);
    }
    if (outcome.status === 'applied') {
      this.#current = this.#current === current ? null : this.#current;
      if (!this.#isToken(token)) return this.#superseded();
      this.#finishToken(token);
      return freezeRecord({ status: 'applied', snapshot: this.snapshot() });
    }
    await this.#retireRecord(current);
    this.#current = this.#current === current ? null : this.#current;
    if (!this.#isToken(token)) return this.#superseded();
    this.#timeline.fallbackRequired = true;
    this.#finishToken(token);
    return this.#controlOutcomeFromPortFailure(outcome);
  }

  async #runRetire(
    token: number,
    candidate: CandidateRecord | null,
    current: CurrentRecord | null,
  ): Promise<LegacyBoundedV1ControlOutcome> {
    const settled = await Promise.allSettled(
      [candidate, current]
        .filter((record): record is CandidateRecord | CurrentRecord => record !== null)
        .map((record) => this.#retireRecord(record)),
    );
    if (!this.#isToken(token)) return this.#superseded();
    this.#finishToken(token);
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      return this.#controlFailed(
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'V1 bounded renderer retirement failed'),
      );
    }
    return freezeRecord({ status: 'applied', snapshot: this.snapshot() });
  }

  #candidateFor(
    media: Readonly<{
      scope: Readonly<LegacyBoundedFileScope>;
      open: LegacyBoundedFileOpener;
    }>,
  ): CandidateRecord {
    const existing = this.#candidate;
    if (existing && existing.claimToken === null && sameScope(existing.scope, media.scope)) {
      return existing;
    }
    if (existing) {
      this.#candidate = null;
      void this.#retireRecord(existing);
    }
    const preparation = this.#port.prepare({ scope: media.scope, open: media.open });
    const candidate: CandidateRecord = {
      lease: preparation.lease,
      scope: media.scope,
      open: media.open,
      durationSeconds: null,
      ready: preparation.ready,
      claimToken: null,
    };
    this.#candidate = candidate;
    return candidate;
  }

  #timedPositionInput(input: LegacyBoundedV1TimedPositionInput): Readonly<{
    scope: Readonly<LegacyBoundedFileScope>;
    positionSeconds: number;
    atRoomTimeMs: number;
  }> | null {
    const scope = canonicalScope(input?.scope);
    const duration = this.#timeline.durationSeconds;
    if (
      !scope ||
      !validPosition(input?.positionSeconds, duration) ||
      !finiteNonNegative(input?.atRoomTimeMs)
    ) {
      return null;
    }
    return freezeRecord({
      scope,
      positionSeconds: input.positionSeconds,
      atRoomTimeMs: input.atRoomTimeMs,
    });
  }

  #setPaused(positionSeconds: number): void {
    this.#timeline.phase = 'paused';
    this.#timeline.positionSeconds = positionSeconds;
    this.#timeline.anchorRoomTimeMs = null;
  }

  #projectPosition(): number {
    const duration = this.#timeline.durationSeconds;
    const position = this.#timeline.positionSeconds;
    if (
      this.#timeline.phase !== 'playing' ||
      this.#timeline.anchorRoomTimeMs === null ||
      duration === null
    ) {
      return position;
    }
    let now: number;
    try {
      now = this.#nowRoomTimeMs();
    } catch {
      return position;
    }
    if (!finiteNonNegative(now)) return position;
    const elapsedSeconds = Math.max(0, now - this.#timeline.anchorRoomTimeMs) / 1_000;
    return Math.min(duration, position + elapsedSeconds);
  }

  #ownsCanonicalScope(scope: Readonly<LegacyBoundedFileScope>): boolean {
    return this.#timeline.scope !== null && sameScope(this.#timeline.scope, scope);
  }

  #ownsAnyScope(scope: Readonly<LegacyBoundedFileScope>): boolean {
    return (
      this.#ownsCanonicalScope(scope) ||
      (this.#candidate !== null && sameScope(this.#candidate.scope, scope)) ||
      (this.#current !== null && sameScope(this.#current.scope, scope))
    );
  }

  #nextToken(): number {
    if (this.#token >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Legacy bounded V1 operation token exhausted');
    }
    const previous = this.#pending;
    if (previous && !previous.controller.signal.aborted) {
      previous.controller.abort(
        new DOMException('V1 bounded operation was superseded', 'AbortError'),
      );
    }
    this.#token += 1;
    this.#pending = null;
    return this.#token;
  }

  #isToken(token: number): boolean {
    return this.#pending?.token === token;
  }

  #finishToken(token: number): void {
    if (this.#pending?.token === token) this.#pending = null;
  }

  #duplicate<T>(kind: LegacyBoundedV1OperationKind, key: string): Promise<T> | null {
    const pending = this.#pending;
    return pending?.kind === kind && pending.key === key ? (pending.promise as Promise<T>) : null;
  }

  #duplicateReplacement(kind: 'play' | 'seek-playing', key: string): ReplacementOperation | null {
    const pending = this.#pending;
    if (pending?.kind !== kind || pending.key !== key || !pending.scheduledPromise) {
      return null;
    }
    return freezeRecord({
      scheduled: pending.scheduledPromise,
      settled: pending.promise as Promise<LegacyBoundedV1ControlOutcome>,
    });
  }

  #immediateReplacement(outcome: LegacyBoundedV1ControlOutcome): ReplacementOperation {
    const scheduled: LegacyBoundedV1ScheduleOutcome =
      outcome.status === 'applied'
        ? freezeRecord({
            status: 'failed' as const,
            error: new Error('A bounded replacement cannot apply before scheduling'),
            snapshot: this.snapshot(),
          })
        : outcome;
    return freezeRecord({
      scheduled: Promise.resolve(scheduled),
      settled: Promise.resolve(outcome),
    });
  }

  #nativeDrain(): Promise<unknown> | null {
    const pending = this.#pending;
    return pending &&
      (pending.kind === 'prepare' ||
        pending.kind === 'pause' ||
        pending.kind === 'seek-paused' ||
        pending.kind === 'stop' ||
        pending.kind === 'retire')
      ? pending.promise
      : null;
  }

  #afterPending<T>(prior: Promise<unknown> | null, run: () => Promise<T>): Promise<T> {
    return (
      prior
        ? prior.then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve()
    ).then(run);
  }

  #waitCancelable<T>(token: number, promise: Promise<T>): Promise<CancelableWait<T>> {
    const pending = this.#pending;
    if (!pending || pending.token !== token || pending.controller.signal.aborted) {
      return Promise.resolve(freezeRecord({ status: 'cancelled' as const }));
    }
    const signal = pending.controller.signal;
    return new Promise<CancelableWait<T>>((resolve) => {
      let settled = false;
      const finish = (outcome: CancelableWait<T>) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish(freezeRecord({ status: 'cancelled' as const }));
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.then(
        (value) => finish(freezeRecord({ status: 'fulfilled' as const, value })),
        (error) => finish(freezeRecord({ status: 'rejected' as const, error })),
      );
    });
  }

  #takeCandidate(): CandidateRecord | null {
    const candidate = this.#candidate;
    this.#candidate = null;
    return candidate;
  }

  #takeCurrent(): CurrentRecord | null {
    const current = this.#current;
    this.#current = null;
    return current;
  }

  #dropCandidate(candidate: CandidateRecord): void {
    if (this.#candidate === candidate) this.#candidate = null;
  }

  async #retireIfUnowned(candidate: CandidateRecord): Promise<void> {
    if (this.#candidate === candidate || this.#current?.lease === candidate.lease) return;
    await this.#retireRecord(candidate);
  }

  async #retireFailedReplacement(candidate: CandidateRecord): Promise<void> {
    this.#dropCandidate(candidate);
    const previous = this.#takeCurrent();
    await Promise.allSettled([
      this.#retireRecord(candidate),
      ...(previous ? [this.#retireRecord(previous)] : []),
    ]);
  }

  #setUnavailable(scope: Readonly<LegacyBoundedFileScope>): void {
    this.#timeline.scope = scope;
    this.#timeline.phase = 'stopped';
    this.#timeline.positionSeconds = 0;
    this.#timeline.durationSeconds = null;
    this.#timeline.anchorRoomTimeMs = null;
    this.#timeline.fallbackRequired = true;
  }

  async #localizeCurrentFailure(current: CurrentRecord): Promise<void> {
    if (this.#current === current) this.#current = null;
    await this.#retireRecord(current);
  }

  async #retireRecord(record: CandidateRecord | CurrentRecord): Promise<void> {
    try {
      await this.#port.retire(record.lease, record.scope);
    } catch {
      // Renderer cleanup failure is deliberately local. It never acquires a
      // transport callback or changes the stable V1 canonical projection.
    }
  }

  #prepareSuperseded(): LegacyBoundedV1PrepareOutcome {
    return freezeRecord({ status: 'superseded', snapshot: this.snapshot() });
  }

  #prepareFailed(error: unknown): LegacyBoundedV1PrepareOutcome {
    return freezeRecord({ status: 'failed', error, snapshot: this.snapshot() });
  }

  #superseded(): LegacyBoundedV1ControlOutcome {
    return freezeRecord({ status: 'superseded', snapshot: this.snapshot() });
  }

  #fallbackUnavailable(): LegacyBoundedV1ControlOutcome {
    return freezeRecord({
      status: 'fallback' as const,
      reason: 'renderer-unavailable' as const,
      snapshot: this.snapshot(),
    });
  }

  #fallbackUnsupported(): LegacyBoundedV1ControlOutcome {
    return freezeRecord({
      status: 'fallback' as const,
      reason: 'unsupported-source' as const,
      snapshot: this.snapshot(),
    });
  }

  #controlFailed(error: unknown): LegacyBoundedV1ControlOutcome {
    return freezeRecord({ status: 'failed', error, snapshot: this.snapshot() });
  }

  #controlOutcomeFromPortFailure(
    outcome: Exclude<LegacyBoundedFileControlOutcome, { readonly status: 'applied' }>,
  ): LegacyBoundedV1ControlOutcome {
    if (outcome.status === 'superseded') return this.#superseded();
    if (outcome.status === 'failed') return this.#controlFailed(outcome.error);
    return this.#controlFailed(
      new Error(`Bounded renderer rejected V1 control: ${outcome.reason}`),
    );
  }
}

export function createLegacyBoundedFileV1Bridge(
  options: LegacyBoundedV1BridgeOptions,
): LegacyBoundedFileV1BridgeContract {
  return new LegacyBoundedFileV1Bridge(options);
}

/**
 * White-box seam for bridge-only contract tests. Product code constructs only
 * through createLegacyBoundedFileV1Bridge and receives the narrow interface.
 */
export { LegacyBoundedFileV1Bridge as LegacyBoundedFileV1BridgeForTests };

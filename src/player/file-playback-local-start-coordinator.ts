import {
  FilePlaybackAssetRegistry,
  parseFilePlaybackAssetBinding,
  type FilePlaybackAssetBinding,
  type FilePlaybackAssetLease,
  type FilePlaybackAssetMetadata,
  type FilePlaybackAssetSnapshot,
} from './file-playback-asset-registry.ts';
import {
  stageFilePlaybackAssetSource,
  type StageFilePlaybackAssetSourceOptions,
  type StagedFilePlaybackAssetSource,
} from './file-playback-asset-source-stager.ts';
import type { FilePlaybackClockBindings } from './file-playback-clock.ts';
import {
  FilePlaybackManager,
  isExactFilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from './file-playback-manager.ts';
import {
  createAudioBufferPlaybackStartEvidence,
  createStreamingPlaybackStartEvidence,
  type FilePlaybackBackend,
  type FilePlaybackCancelIntent,
  type FilePlaybackStartEvidence,
} from './file-playback-source.ts';
import type { OrdinaryAudioDecoder } from './file-playback-source-factory.ts';
import {
  snapshotFilePlaybackBoundedRoutePolicy,
  type FilePlaybackBoundedRoutePolicy,
} from './file-playback-bounded-route-policy.ts';
import { ManagerCutoverRendezvousParticipant } from './manager-cutover-rendezvous-participant.ts';
import {
  readPlaybackAttemptIdentity,
  readPlaybackStateIdentity,
  sameState,
  type PlaybackAttemptIdentity,
  type PlaybackStateIdentity,
} from './playback-identity.ts';
import {
  HostRendezvousCoordinator,
  type HostRendezvousAttempt,
  type HostRendezvousAttemptSnapshot,
} from './rendezvous-coordinator.ts';

const STAGE_OPTION_KEYS = Object.freeze([
  'registry',
  'roomToken',
  'assetLease',
  'expectedBinding',
  'manager',
  'audioContext',
  'destination',
  'clockBindings',
  'signal',
  'isCurrent',
  'decodeOrdinaryAudio',
  'playbackState',
  'participantId',
  'rttP95Ms',
  'armP95Ms',
  'boundedRoutePolicy',
  'runtimeForTests',
] as const);
const REQUIRED_STAGE_OPTION_KEYS = STAGE_OPTION_KEYS.filter(
  (key) => key !== 'boundedRoutePolicy' && key !== 'runtimeForTests',
);
const START_OPTION_KEYS = Object.freeze([
  ...STAGE_OPTION_KEYS.filter((key) => key !== 'runtimeForTests'),
  'positionSeconds',
  'playbackRate',
  'rendezvousCoordinator',
  'runtimeForTests',
] as const);
const REQUIRED_START_OPTION_KEYS = START_OPTION_KEYS.filter(
  (key) => key !== 'boundedRoutePolicy' && key !== 'runtimeForTests',
);
const COMPLETE_OPTION_KEYS = Object.freeze(['staged', 'attempt'] as const);
const CLOCK_KEYS = Object.freeze([
  'nowRoomTimeMs',
  'roomTimeMsToContextTime',
  'localPerformanceMsToContextTime',
] as const);
const RUNTIME_KEYS = Object.freeze([
  'stageAssetSourceForTests',
  'beforeParticipantCommitForTests',
] as const);
const STAGED_KEYS = Object.freeze([
  'cutoverPort',
  'backend',
  'sourceIdentity',
  'asset',
  'metadata',
  'readiness',
] as const);
const ASSET_KEYS = Object.freeze([
  'queueItemId',
  'sourceIdentity',
  'transferSessionId',
  'kind',
  'size',
  'name',
  'mime',
] as const);
const METADATA_KEYS = Object.freeze(['name', 'mime'] as const);
const READINESS_KEYS = Object.freeze([
  'durationSeconds',
  'bufferedAheadSeconds',
  'outputSampleRateHz',
  'channelCount',
] as const);
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_COORDINATOR_SETTLEMENT_TURNS = 32;

type ExactRecord = Readonly<Record<string, unknown>>;
type DataMethod = (...args: never[]) => unknown;
type StageAssetSource = (
  options: StageFilePlaybackAssetSourceOptions,
) => Promise<Readonly<StagedFilePlaybackAssetSource>>;

/** Deliberately narrow seams for deterministic native-boundary tests. */
export interface FilePlaybackLocalStartCoordinatorRuntimeForTests {
  readonly stageAssetSourceForTests?: StageAssetSource;
  readonly beforeParticipantCommitForTests?: () => void;
}

export interface StageLocalFilePlaybackParticipantOptions {
  readonly registry: FilePlaybackAssetRegistry;
  readonly roomToken: object;
  readonly assetLease: FilePlaybackAssetLease;
  readonly expectedBinding: FilePlaybackAssetBinding;
  readonly manager: FilePlaybackManager;
  readonly audioContext: AudioContext;
  readonly destination: AudioNode;
  readonly clockBindings: FilePlaybackClockBindings;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly decodeOrdinaryAudio: OrdinaryAudioDecoder;
  readonly playbackState: PlaybackStateIdentity;
  readonly participantId: string;
  readonly rttP95Ms: number;
  readonly armP95Ms: number;
  /** Fixed for this staging boundary; omission preserves the current bounded route. */
  readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
  readonly runtimeForTests?: FilePlaybackLocalStartCoordinatorRuntimeForTests;
}

export interface StartLocalFilePlaybackOptions extends StageLocalFilePlaybackParticipantOptions {
  readonly positionSeconds: number;
  readonly playbackRate: number;
  /** One coordinator owned for the entire room lifetime. */
  readonly rendezvousCoordinator: HostRendezvousCoordinator;
}

export interface LocalFilePlaybackSourceDescriptor {
  readonly identity: string;
  readonly metadata: Readonly<FilePlaybackAssetMetadata>;
}

/**
 * Exact silent local candidate exposed only so one room-owned rendezvous can
 * include its participant. Native ownership and authority fences remain in
 * this module until completion or retirement.
 */
export interface StagedLocalFilePlaybackParticipant {
  readonly port: FilePlaybackCutoverCandidatePort;
  readonly backend: FilePlaybackBackend;
  readonly source: Readonly<LocalFilePlaybackSourceDescriptor>;
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
  readonly playbackState: Readonly<PlaybackStateIdentity>;
  readonly participant: ManagerCutoverRendezvousParticipant;
}

export interface CompleteLocalFilePlaybackParticipantOptions {
  readonly staged: StagedLocalFilePlaybackParticipant;
  readonly attempt: HostRendezvousAttempt;
}

export interface LocalFilePlaybackSchedule {
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly createdAtRoomTimeMs: number;
  readonly leadTimeMs: number;
  readonly finalizeByRoomTimeMs: number;
  readonly startAtRoomTimeMs: number;
}

/** Body-free runtime authority returned only after exact physical start evidence. */
export interface StartedLocalFilePlayback {
  readonly port: FilePlaybackCutoverCandidatePort;
  readonly backend: FilePlaybackBackend;
  readonly source: Readonly<LocalFilePlaybackSourceDescriptor>;
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
  readonly attempt: Readonly<PlaybackAttemptIdentity>;
  readonly schedule: Readonly<LocalFilePlaybackSchedule>;
  readonly startEvidence: Readonly<FilePlaybackStartEvidence>;
}

interface RuntimeSnapshot {
  readonly stageAssetSource: StageAssetSource;
  readonly beforeParticipantCommit: (() => void) | null;
}

interface StagedParticipantAuthority {
  readonly manager: FilePlaybackManager;
  readonly signal: AbortSignal;
  readonly assertAuthority: () => void;
  readonly runtime: RuntimeSnapshot;
  readonly participant: ManagerCutoverRendezvousParticipant;
  readonly port: FilePlaybackCutoverCandidatePort;
  readonly backend: FilePlaybackBackend;
  readonly source: Readonly<LocalFilePlaybackSourceDescriptor>;
  readonly asset: Readonly<FilePlaybackAssetSnapshot>;
  readonly playbackState: Readonly<PlaybackStateIdentity>;
  readonly participantId: string;
  abortListener: (() => void) | null;
  attempt: HostRendezvousAttempt | null;
  attemptIdentity: Readonly<PlaybackAttemptIdentity> | null;
  completionPromise: Promise<Readonly<StartedLocalFilePlayback>> | null;
  retirementPromise: Promise<void> | null;
  committed: boolean;
}

const STAGED_PARTICIPANT_AUTHORITIES = new WeakMap<
  StagedLocalFilePlaybackParticipant,
  StagedParticipantAuthority
>();

const trustedAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const trustedManagerCurrentPort = FilePlaybackManager.prototype.currentCutoverPort;
const trustedManagerCurrentSnapshot = FilePlaybackManager.prototype.currentCutoverSnapshot;
const trustedManagerRetireCandidate = FilePlaybackManager.prototype.retireCutoverCandidate;
const trustedManagerRetireCurrent = FilePlaybackManager.prototype.retireCurrentCutover;
const trustedRendezvousStart = HostRendezvousCoordinator.prototype.start;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactRecord(value: unknown, keys: readonly string[]): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = new Set<string>(keys);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotOptions(
  value: unknown,
  optionKeys: readonly string[],
  requiredOptionKeys: readonly string[],
): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(optionKeys);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      requiredOptionKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of optionKeys) {
      const descriptor = descriptors[key];
      if ((key === 'boundedRoutePolicy' || key === 'runtimeForTests') && !descriptor) {
        snapshot[key] = undefined;
        continue;
      }
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotOptionalMethods(value: unknown): Readonly<Record<string, DataMethod>> | null {
  if (value === undefined) return Object.freeze(Object.create(null));
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set<string>(RUNTIME_KEYS);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;
    const snapshot = Object.create(null) as Record<string, DataMethod>;
    for (const key of RUNTIME_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if (
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function'
      ) {
        return null;
      }
      snapshot[key] = descriptor.value as DataMethod;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function runtimeSnapshot(value: unknown): RuntimeSnapshot | null {
  const methods = snapshotOptionalMethods(value);
  if (!methods) return null;
  return Object.freeze({
    stageAssetSource:
      (methods.stageAssetSourceForTests as StageAssetSource | undefined) ??
      stageFilePlaybackAssetSource,
    beforeParticipantCommit:
      (methods.beforeParticipantCommitForTests as (() => void) | undefined) ?? null,
  });
}

function clockSnapshot(value: unknown): Readonly<FilePlaybackClockBindings> | null {
  const snapshot = snapshotExactRecord(value, CLOCK_KEYS);
  if (
    !snapshot ||
    typeof snapshot.nowRoomTimeMs !== 'function' ||
    typeof snapshot.roomTimeMsToContextTime !== 'function' ||
    typeof snapshot.localPerformanceMsToContextTime !== 'function'
  ) {
    return null;
  }
  const receiver = value as FilePlaybackClockBindings;
  const nowRoomTimeMs = snapshot.nowRoomTimeMs as FilePlaybackClockBindings['nowRoomTimeMs'];
  const roomTimeMsToContextTime =
    snapshot.roomTimeMsToContextTime as FilePlaybackClockBindings['roomTimeMsToContextTime'];
  const localPerformanceMsToContextTime =
    snapshot.localPerformanceMsToContextTime as FilePlaybackClockBindings['localPerformanceMsToContextTime'];
  return freezeCanonical({
    nowRoomTimeMs: () => Reflect.apply(nowRoomTimeMs, receiver, []),
    roomTimeMsToContextTime: (roomTimeMs: number) =>
      Reflect.apply(roomTimeMsToContextTime, receiver, [roomTimeMs]),
    localPerformanceMsToContextTime: (localPerformanceTimeMs: number) =>
      Reflect.apply(localPerformanceMsToContextTime, receiver, [localPerformanceTimeMs]),
  });
}

function exactRegistry(value: unknown): value is FilePlaybackAssetRegistry {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      Reflect.getPrototypeOf(value) === FilePlaybackAssetRegistry.prototype
    );
  } catch {
    return false;
  }
}

function exactRendezvousCoordinator(value: unknown): value is HostRendezvousCoordinator {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      Reflect.getPrototypeOf(value) === HostRendezvousCoordinator.prototype
    );
  } catch {
    return false;
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function throwIfAborted(signal: AbortSignal): void {
  Reflect.apply(trustedAbortThrowIfAborted, signal, []);
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason as unknown;
  if (reason instanceof Error) return reason;
  const error = new Error('Local file playback start was aborted');
  error.name = 'AbortError';
  return error;
}

function observePromise(value: Promise<unknown>): void {
  void value.then(
    () => undefined,
    () => undefined,
  );
}

function assertNativePromise<T>(value: unknown, label: string): asserts value is Promise<T> {
  if (!(value instanceof Promise)) throw new TypeError(`${label} must return a native Promise`);
}

function abortable<T>(
  task: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void,
  onLateValue?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      try {
        onAbort();
      } catch {
        // Exact retirement is also independently scheduled by the caller.
      }
      reject(createAbortError(signal));
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
    void task.then(
      (value) => {
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function canonicalAsset(value: unknown): Readonly<FilePlaybackAssetSnapshot> | null {
  const snapshot = snapshotExactRecord(value, ASSET_KEYS);
  const binding = snapshot
    ? parseFilePlaybackAssetBinding({
        queueItemId: snapshot.queueItemId,
        sourceIdentity: snapshot.sourceIdentity,
        transferSessionId: snapshot.transferSessionId,
      })
    : null;
  if (
    !snapshot ||
    !binding ||
    (snapshot.kind !== 'blob' &&
      snapshot.kind !== 'peer-range' &&
      snapshot.kind !== 'r2-records') ||
    typeof snapshot.size !== 'number' ||
    !Number.isSafeInteger(snapshot.size) ||
    snapshot.size <= 0 ||
    typeof snapshot.name !== 'string' ||
    snapshot.name.length === 0 ||
    typeof snapshot.mime !== 'string' ||
    snapshot.mime.length === 0
  ) {
    return null;
  }
  return freezeCanonical({
    ...binding,
    kind: snapshot.kind,
    size: snapshot.size,
    name: snapshot.name,
    mime: snapshot.mime,
  });
}

function canonicalMetadata(
  value: unknown,
  asset: Readonly<FilePlaybackAssetSnapshot>,
): Readonly<FilePlaybackAssetMetadata> | null {
  const metadata = snapshotExactRecord(value, METADATA_KEYS);
  if (!metadata || metadata.name !== asset.name || metadata.mime !== asset.mime) return null;
  return freezeCanonical({ name: asset.name, mime: asset.mime });
}

function canonicalReadiness(
  value: unknown,
): Readonly<StagedFilePlaybackAssetSource['readiness']> | null {
  const readiness = snapshotExactRecord(value, READINESS_KEYS);
  if (
    !readiness ||
    typeof readiness.durationSeconds !== 'number' ||
    !Number.isFinite(readiness.durationSeconds) ||
    readiness.durationSeconds <= 0 ||
    typeof readiness.bufferedAheadSeconds !== 'number' ||
    !Number.isFinite(readiness.bufferedAheadSeconds) ||
    readiness.bufferedAheadSeconds < 0 ||
    readiness.bufferedAheadSeconds > readiness.durationSeconds ||
    typeof readiness.outputSampleRateHz !== 'number' ||
    !Number.isSafeInteger(readiness.outputSampleRateHz) ||
    readiness.outputSampleRateHz <= 0 ||
    typeof readiness.channelCount !== 'number' ||
    !Number.isSafeInteger(readiness.channelCount) ||
    readiness.channelCount <= 0
  ) {
    return null;
  }
  return freezeCanonical({
    durationSeconds: readiness.durationSeconds,
    bufferedAheadSeconds: readiness.bufferedAheadSeconds,
    outputSampleRateHz: readiness.outputSampleRateHz,
    channelCount: readiness.channelCount,
  });
}

function canonicalStagedResult(
  value: unknown,
  expectedBinding: Readonly<FilePlaybackAssetBinding>,
): Readonly<StagedFilePlaybackAssetSource> | null {
  const snapshot = snapshotExactRecord(value, STAGED_KEYS);
  const asset = snapshot ? canonicalAsset(snapshot.asset) : null;
  const metadata = asset ? canonicalMetadata(snapshot?.metadata, asset) : null;
  const readiness = snapshot ? canonicalReadiness(snapshot.readiness) : null;
  if (
    !snapshot ||
    !asset ||
    !metadata ||
    !readiness ||
    (snapshot.backend !== 'audio-buffer' && snapshot.backend !== 'bounded-stream') ||
    snapshot.sourceIdentity !== asset.sourceIdentity ||
    asset.queueItemId !== expectedBinding.queueItemId ||
    asset.sourceIdentity !== expectedBinding.sourceIdentity ||
    asset.transferSessionId !== expectedBinding.transferSessionId ||
    snapshot.cutoverPort === null ||
    typeof snapshot.cutoverPort !== 'object'
  ) {
    return null;
  }
  return freezeCanonical({
    cutoverPort: snapshot.cutoverPort as FilePlaybackCutoverCandidatePort,
    backend: snapshot.backend,
    sourceIdentity: asset.sourceIdentity,
    asset,
    metadata,
    readiness,
  });
}

function canonicalStartEvidence(value: unknown): Readonly<FilePlaybackStartEvidence> | null {
  const kind = (() => {
    try {
      return value && typeof value === 'object'
        ? Object.getOwnPropertyDescriptor(value, 'kind')?.value
        : null;
    } catch {
      return null;
    }
  })();
  try {
    if (kind === 'webaudio-schedule-passed') {
      const snapshot = snapshotExactRecord(value, ['kind', 'targetFrame']);
      return snapshot
        ? createAudioBufferPlaybackStartEvidence(snapshot.targetFrame as number)
        : null;
    }
    if (kind === 'worklet-observed') {
      const snapshot = snapshotExactRecord(value, ['kind', 'targetFrame', 'actualStartFrame']);
      return snapshot
        ? createStreamingPlaybackStartEvidence(
            snapshot.targetFrame as number,
            snapshot.actualStartFrame as number,
          )
        : null;
    }
  } catch {
    return null;
  }
  return null;
}

function canonicalAttempt(
  state: Readonly<PlaybackStateIdentity>,
  rendezvousId: string,
): Readonly<PlaybackAttemptIdentity> {
  const attempt = readPlaybackAttemptIdentity({ ...state, rendezvousId });
  if (!attempt) throw new TypeError('Local playback attempt identity is invalid');
  return freezeCanonical({
    queueItemId: attempt.queueItemId,
    runId: attempt.runId,
    revision: attempt.revision,
    rendezvousId: attempt.rendezvousId,
  });
}

function readAcceptedSchedule(
  value: HostRendezvousAttemptSnapshot,
  state: Readonly<PlaybackStateIdentity>,
  participantId: string,
): Readonly<LocalFilePlaybackSchedule> | null {
  const matchingParticipants = value.participants.filter(
    (participant) => participant.participantId === participantId,
  );
  const participant = matchingParticipants.length === 1 ? matchingParticipants[0] : null;
  if (
    (value.status !== 'open' && value.status !== 'complete') ||
    value.reasonCode !== null ||
    value.run.queueItemId !== state.queueItemId ||
    value.run.runId !== state.runId ||
    value.run.revision !== state.revision ||
    participant?.participantId !== participantId ||
    participant.armStatus !== 'armed' ||
    participant.finalizeStatus !== 'accepted' ||
    !isFiniteNonNegative(value.positionSeconds) ||
    !isFiniteNonNegative(value.createdAtRoomTimeMs) ||
    !isFiniteNonNegative(value.leadTimeMs) ||
    !isFiniteNonNegative(value.finalizeByRoomTimeMs) ||
    !isFiniteNonNegative(value.startAtRoomTimeMs) ||
    !Number.isFinite(value.playbackRate) ||
    value.playbackRate <= 0 ||
    value.finalizeByRoomTimeMs > value.startAtRoomTimeMs
  ) {
    return null;
  }
  return freezeCanonical({
    positionSeconds: value.positionSeconds,
    playbackRate: value.playbackRate,
    createdAtRoomTimeMs: value.createdAtRoomTimeMs,
    leadTimeMs: value.leadTimeMs,
    finalizeByRoomTimeMs: value.finalizeByRoomTimeMs,
    startAtRoomTimeMs: value.startAtRoomTimeMs,
  });
}

function currentPort(manager: FilePlaybackManager): FilePlaybackCutoverCandidatePort | null {
  return Reflect.apply(trustedManagerCurrentPort, manager, []);
}

function assertNewerThanCurrent(
  manager: FilePlaybackManager,
  requestedState: Readonly<PlaybackStateIdentity>,
): void {
  const port = currentPort(manager);
  if (port === null) return;
  const snapshot = Reflect.apply(trustedManagerCurrentSnapshot, manager, [port]);
  const currentState = snapshot ? readPlaybackStateIdentity(snapshot.run) : null;
  if (!currentState) {
    throw new Error('The current file playback state could not be verified');
  }
  if (
    currentState.revision === Number.MAX_SAFE_INTEGER ||
    requestedState.revision !== currentState.revision + 1
  ) {
    throw new RangeError('A candidate start must be the exact next playback revision');
  }
}

function scheduleExactRetirement(
  manager: FilePlaybackManager,
  port: FilePlaybackCutoverCandidatePort,
): void {
  let cleanup: Promise<unknown>;
  try {
    if (currentPort(manager) === port) {
      cleanup = Reflect.apply(trustedManagerRetireCurrent, manager, [port]);
    } else {
      cleanup = Reflect.apply(trustedManagerRetireCandidate, manager, [port]).then((retired) =>
        retired === true ? true : Reflect.apply(trustedManagerRetireCurrent, manager, [port]),
      );
    }
  } catch {
    return;
  }
  observePromise(cleanup);
}

function cancelAttempt(attempt: HostRendezvousAttempt | null, reasonCode: string): void {
  if (!attempt) return;
  try {
    attempt.cancel(reasonCode);
  } catch {
    // Exact manager-port retirement remains the final cleanup fence.
  }
}

async function awaitAcceptedSchedule(
  attempt: HostRendezvousAttempt,
  state: Readonly<PlaybackStateIdentity>,
  participantId: string,
  signal: AbortSignal,
  assertAuthority: () => void,
  onAbort: () => void,
): Promise<Readonly<LocalFilePlaybackSchedule>> {
  for (let turn = 0; turn < MAX_COORDINATOR_SETTLEMENT_TURNS; turn += 1) {
    const snapshot = attempt.getSnapshot();
    const schedule = readAcceptedSchedule(snapshot, state, participantId);
    if (schedule) return schedule;
    const matchingOutcomes = snapshot.participants.filter(
      (outcome) => outcome.participantId === participantId,
    );
    const outcome = matchingOutcomes.length === 1 ? matchingOutcomes[0] : null;
    if (
      snapshot.status === 'cancelled' ||
      snapshot.status === 'superseded' ||
      snapshot.reasonCode !== null ||
      outcome === null ||
      (outcome && outcome.armStatus !== 'pending' && outcome.armStatus !== 'armed') ||
      (outcome && outcome.finalizeStatus !== 'pending' && outcome.finalizeStatus !== 'accepted')
    ) {
      throw new Error('Local playback rendezvous did not accept the participant');
    }
    assertAuthority();
    await abortable(Promise.resolve(), signal, onAbort);
    assertAuthority();
  }
  throw new Error('Local playback rendezvous did not settle after start evidence');
}

function removeStagedAbortListener(authority: StagedParticipantAuthority): void {
  const listener = authority.abortListener;
  if (!listener) return;
  authority.abortListener = null;
  authority.signal.removeEventListener('abort', listener);
}

async function retireExactPort(
  manager: FilePlaybackManager,
  port: FilePlaybackCutoverCandidatePort,
): Promise<void> {
  try {
    if (currentPort(manager) === port) {
      await Reflect.apply(trustedManagerRetireCurrent, manager, [port]);
      return;
    }
    const retired = await Reflect.apply(trustedManagerRetireCandidate, manager, [port]);
    if (retired !== true) await Reflect.apply(trustedManagerRetireCurrent, manager, [port]);
  } catch {
    // Exact-port retirement is best effort and never touches another candidate.
  }
}

function beginStagedRetirement(
  authority: StagedParticipantAuthority,
  reasonCode: string,
): Promise<void> {
  if (authority.committed) return Promise.resolve();
  if (authority.retirementPromise) return authority.retirementPromise;
  removeStagedAbortListener(authority);
  const retirement = Promise.resolve().then(async () => {
    const attemptIdentity = authority.attemptIdentity;
    if (attemptIdentity) {
      const cancelIntent: Readonly<FilePlaybackCancelIntent> = freezeCanonical({
        kind: 'file-playback-cancel' as const,
        ...attemptIdentity,
        reasonCode,
      });
      try {
        await authority.participant.cancel(cancelIntent);
      } catch {
        // The direct exact-port fence below remains authoritative.
      }
    }
    await retireExactPort(authority.manager, authority.port);
  });
  authority.retirementPromise = retirement;
  observePromise(retirement);
  return retirement;
}

function assertUsableStagedAuthority(authority: StagedParticipantAuthority): void {
  authority.assertAuthority();
  if (authority.retirementPromise) {
    throw new Error('Local playback construction was retired');
  }
}

function initialAttemptIdentity(
  attempt: HostRendezvousAttempt,
  state: Readonly<PlaybackStateIdentity>,
  participantId: string,
): Readonly<PlaybackAttemptIdentity> {
  const snapshot = attempt.getSnapshot();
  const matchingParticipants = snapshot.participants.filter(
    (participant) => participant.participantId === participantId,
  );
  if (
    (snapshot.status !== 'open' && snapshot.status !== 'complete') ||
    snapshot.reasonCode !== null ||
    snapshot.run.queueItemId !== state.queueItemId ||
    snapshot.run.runId !== state.runId ||
    snapshot.run.revision !== state.revision ||
    snapshot.rendezvousId !== attempt.rendezvousId ||
    snapshot.startAtRoomTimeMs !== attempt.startAtRoomTimeMs ||
    snapshot.finalizeByRoomTimeMs !== attempt.finalizeByRoomTimeMs ||
    matchingParticipants.length !== 1
  ) {
    throw new Error('Local playback participant does not belong to the exact room attempt');
  }
  return canonicalAttempt(state, snapshot.rendezvousId);
}

/**
 * Stages one manager-owned silent candidate and returns its exact participant.
 * This function never starts a rendezvous and cannot make the candidate audible.
 */
export async function stageLocalFilePlaybackParticipant(
  options: StageLocalFilePlaybackParticipantOptions,
): Promise<Readonly<StagedLocalFilePlaybackParticipant>> {
  const input = snapshotOptions(options, STAGE_OPTION_KEYS, REQUIRED_STAGE_OPTION_KEYS);
  if (!input) throw new TypeError('Local file playback stage options are invalid');
  const boundedRoutePolicy =
    input.boundedRoutePolicy === undefined
      ? null
      : snapshotFilePlaybackBoundedRoutePolicy(input.boundedRoutePolicy);

  const registry = input.registry;
  const roomToken = input.roomToken;
  const assetLease = input.assetLease;
  const expectedBinding = parseFilePlaybackAssetBinding(input.expectedBinding);
  const manager = input.manager;
  const audioContext = input.audioContext;
  const destination = input.destination;
  const clock = clockSnapshot(input.clockBindings);
  const signal = input.signal;
  const isCurrent = input.isCurrent;
  const decodeOrdinaryAudio = input.decodeOrdinaryAudio;
  const playbackState = readPlaybackStateIdentity(input.playbackState);
  const participantId = input.participantId;
  const rttP95Ms = input.rttP95Ms;
  const armP95Ms = input.armP95Ms;
  const runtime = runtimeSnapshot(input.runtimeForTests);

  if (!exactRegistry(registry)) {
    throw new TypeError('An exact file playback asset registry is required');
  }
  if (roomToken === null || typeof roomToken !== 'object') {
    throw new TypeError('An opaque file playback room token is required');
  }
  if (assetLease === null || typeof assetLease !== 'object' || !expectedBinding) {
    throw new TypeError('An exact file playback asset lease and binding are required');
  }
  if (!isExactFilePlaybackManager(manager)) {
    throw new TypeError('An exact file playback manager is required');
  }
  if (
    audioContext === null ||
    typeof audioContext !== 'object' ||
    destination === null ||
    typeof destination !== 'object'
  ) {
    throw new TypeError('Local file playback audio graph dependencies are required');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('An exact local file playback AbortSignal is required');
  }
  if (typeof isCurrent !== 'function' || typeof decodeOrdinaryAudio !== 'function') {
    throw new TypeError('Local playback callbacks are invalid');
  }
  if (!clock || !runtime || !playbackState) {
    throw new TypeError('Local playback clock, runtime, or state identity is invalid');
  }
  if (playbackState.queueItemId !== expectedBinding.queueItemId) {
    throw new TypeError('Playback state and asset binding queue identities differ');
  }
  if (!isBoundedIdentifier(participantId)) {
    throw new TypeError('Local playback participant ID is invalid');
  }
  if (!isFiniteNonNegative(rttP95Ms) || !isFiniteNonNegative(armP95Ms)) {
    throw new RangeError('Local playback rendezvous metrics must be finite and non-negative');
  }

  let checkingAuthority = false;
  const assertAuthority = (): void => {
    throwIfAborted(signal);
    if (checkingAuthority) throw new Error('Local playback authority was re-entered');
    checkingAuthority = true;
    let accepted: unknown;
    try {
      accepted = Reflect.apply(isCurrent as () => boolean, undefined, []);
    } finally {
      checkingAuthority = false;
    }
    if (accepted !== true) throw new Error('Local playback start was superseded');
    throwIfAborted(signal);
  };
  const wrappedIsCurrent = (): boolean => {
    assertAuthority();
    return true;
  };
  let rawStaged: Readonly<StagedFilePlaybackAssetSource> | null = null;
  let staged: Readonly<StagedFilePlaybackAssetSource> | null = null;
  let authority: StagedParticipantAuthority | null = null;

  const retireLateStage = (value: Readonly<StagedFilePlaybackAssetSource>): void => {
    const late = canonicalStagedResult(value, expectedBinding);
    if (late) scheduleExactRetirement(manager, late.cutoverPort);
  };

  try {
    assertAuthority();
    assertNewerThanCurrent(manager, playbackState);
    const stageTask = Reflect.apply(runtime.stageAssetSource, undefined, [
      {
        registry,
        roomToken,
        assetLease,
        expectedBinding,
        manager,
        audioContext: audioContext as AudioContext,
        destination: destination as AudioNode,
        clockBindings: clock,
        signal,
        isCurrent: wrappedIsCurrent,
        decodeOrdinaryAudio: decodeOrdinaryAudio as OrdinaryAudioDecoder,
        ...(boundedRoutePolicy ? { boundedRoutePolicy } : {}),
      },
    ]);
    assertNativePromise<Readonly<StagedFilePlaybackAssetSource>>(
      stageTask,
      'Local file playback stager',
    );
    rawStaged = await abortable(stageTask, signal, () => undefined, retireLateStage);
    staged = canonicalStagedResult(rawStaged, expectedBinding);
    if (!staged) {
      throw new TypeError('Local file playback stager returned an invalid result');
    }
    assertAuthority();
    if (staged.asset.queueItemId !== playbackState.queueItemId) {
      throw new Error('Staged asset does not identify the requested playback state');
    }
    assertNewerThanCurrent(manager, playbackState);

    const canonicalState = freezeCanonical({
      queueItemId: playbackState.queueItemId,
      runId: playbackState.runId,
      revision: playbackState.revision,
    });
    const source = freezeCanonical({
      identity: staged.sourceIdentity,
      metadata: staged.metadata,
    });
    const participant = new ManagerCutoverRendezvousParticipant({
      participantId: participantId as string,
      rttP95Ms: rttP95Ms as number,
      armP95Ms: armP95Ms as number,
      manager,
      candidatePort: staged.cutoverPort,
    });
    const construction = freezeCanonical({
      port: staged.cutoverPort,
      backend: staged.backend,
      source,
      asset: staged.asset,
      playbackState: canonicalState,
      participant,
    });
    authority = {
      manager,
      signal,
      assertAuthority,
      runtime,
      participant,
      port: staged.cutoverPort,
      backend: staged.backend,
      source,
      asset: staged.asset,
      playbackState: canonicalState,
      participantId: participantId as string,
      abortListener: null,
      attempt: null,
      attemptIdentity: null,
      completionPromise: null,
      retirementPromise: null,
      committed: false,
    };
    STAGED_PARTICIPANT_AUTHORITIES.set(construction, authority);
    const abortListener = () => {
      if (authority) void beginStagedRetirement(authority, 'local-start-aborted');
    };
    authority.abortListener = abortListener;
    signal.addEventListener('abort', abortListener, { once: true });
    assertAuthority();
    return construction;
  } catch (error) {
    if (authority) {
      void beginStagedRetirement(
        authority,
        signal instanceof AbortSignal && signal.aborted
          ? 'local-start-aborted'
          : 'local-stage-failed',
      );
    } else if (staged) {
      scheduleExactRetirement(manager, staged.cutoverPort);
    } else if (rawStaged) {
      retireLateStage(rawStaged);
    }
    throw error;
  }
}

/** Retires one exact uncommitted local construction without cancelling its room attempt. */
export function retireLocalFilePlaybackParticipant(
  staged: StagedLocalFilePlaybackParticipant,
  reasonCode = 'local-participant-retired',
): Promise<void> {
  const authority = STAGED_PARTICIPANT_AUTHORITIES.get(staged);
  if (!authority) return Promise.reject(new TypeError('Local playback construction is invalid'));
  if (!isBoundedIdentifier(reasonCode)) {
    return Promise.reject(new TypeError('Local playback retirement reason is invalid'));
  }
  return beginStagedRetirement(authority, reasonCode);
}

async function executeLocalParticipantCompletion(
  authority: StagedParticipantAuthority,
  attempt: HostRendezvousAttempt,
): Promise<Readonly<StartedLocalFilePlayback>> {
  try {
    assertUsableStagedAuthority(authority);
    const attemptIdentity = initialAttemptIdentity(
      attempt,
      authority.playbackState,
      authority.participantId,
    );
    authority.attemptIdentity = attemptIdentity;
    assertUsableStagedAuthority(authority);

    const startedTask = authority.participant.started(attemptIdentity);
    assertNativePromise<FilePlaybackStartEvidence>(startedTask, 'Local playback start evidence');
    const rawEvidence = await abortable(startedTask, authority.signal, () => {
      void beginStagedRetirement(authority, 'local-start-aborted');
    });
    assertUsableStagedAuthority(authority);
    const startEvidence = canonicalStartEvidence(rawEvidence);
    if (!startEvidence) throw new Error('Local playback start evidence was invalid');

    const schedule = await awaitAcceptedSchedule(
      attempt,
      authority.playbackState,
      authority.participantId,
      authority.signal,
      () => assertUsableStagedAuthority(authority),
      () => void beginStagedRetirement(authority, 'local-start-aborted'),
    );
    assertUsableStagedAuthority(authority);
    if (
      attempt.startAtRoomTimeMs !== schedule.startAtRoomTimeMs ||
      attempt.finalizeByRoomTimeMs !== schedule.finalizeByRoomTimeMs
    ) {
      throw new Error('Local playback rendezvous schedule changed unexpectedly');
    }

    const beforeCommitPort = currentPort(authority.manager);
    const beforeCommitSnapshot = Reflect.apply(trustedManagerCurrentSnapshot, authority.manager, [
      authority.port,
    ]);
    if (
      beforeCommitPort !== authority.port ||
      beforeCommitSnapshot === null ||
      beforeCommitSnapshot.queueItemId !== authority.playbackState.queueItemId ||
      beforeCommitSnapshot.backend !== authority.backend ||
      beforeCommitSnapshot.phase !== 'playing' ||
      !sameState(beforeCommitSnapshot.run, authority.playbackState)
    ) {
      throw new Error('Local playback candidate is not the exact physical current renderer');
    }
    assertUsableStagedAuthority(authority);
    authority.runtime.beforeParticipantCommit?.();
    assertUsableStagedAuthority(authority);
    if (!attempt.commitParticipant(authority.participantId)) {
      throw new Error('Local playback participant commit was rejected');
    }
    if (
      currentPort(authority.manager) !== authority.port ||
      !sameState(
        Reflect.apply(trustedManagerCurrentSnapshot, authority.manager, [authority.port])?.run,
        authority.playbackState,
      )
    ) {
      throw new Error('Local playback renderer changed during logical commit');
    }

    const result = freezeCanonical({
      port: authority.port,
      backend: authority.backend,
      source: authority.source,
      asset: authority.asset,
      attempt: attemptIdentity,
      schedule,
      startEvidence,
    });
    authority.committed = true;
    removeStagedAbortListener(authority);
    return result;
  } catch (error) {
    void beginStagedRetirement(
      authority,
      authority.signal.aborted ? 'local-start-aborted' : 'local-start-failed',
    );
    throw error;
  }
}

/**
 * Completes only the named local participant in a room-owned rendezvous. Other
 * participants may remain pending or fail independently.
 */
export function completeLocalFilePlaybackParticipant(
  options: CompleteLocalFilePlaybackParticipantOptions,
): Promise<Readonly<StartedLocalFilePlayback>> {
  const input = snapshotExactRecord(options, COMPLETE_OPTION_KEYS);
  if (!input) return Promise.reject(new TypeError('Local playback completion options are invalid'));
  const staged = input.staged as StagedLocalFilePlaybackParticipant;
  const authority = STAGED_PARTICIPANT_AUTHORITIES.get(staged);
  if (!authority) return Promise.reject(new TypeError('Local playback construction is invalid'));
  const attempt = input.attempt;
  if (attempt === null || typeof attempt !== 'object') {
    return Promise.reject(new TypeError('A room-owned rendezvous attempt is required'));
  }
  if (authority.completionPromise) {
    return authority.attempt === attempt
      ? authority.completionPromise
      : Promise.reject(
          new Error('Local playback construction is already bound to another attempt'),
        );
  }
  if (authority.retirementPromise) {
    return Promise.reject(new Error('Local playback construction is already retired'));
  }
  authority.attempt = attempt as HostRendezvousAttempt;
  const completion = Promise.resolve().then(() =>
    executeLocalParticipantCompletion(authority, attempt as HostRendezvousAttempt),
  );
  authority.completionPromise = completion;
  return completion;
}

/**
 * Compatibility composition for the existing one-local-participant path.
 * New room orchestration must stage, start its shared attempt, and complete
 * through the split APIs above.
 */
export async function startLocalFilePlayback(
  options: StartLocalFilePlaybackOptions,
): Promise<Readonly<StartedLocalFilePlayback>> {
  const input = snapshotOptions(options, START_OPTION_KEYS, REQUIRED_START_OPTION_KEYS);
  if (!input) throw new TypeError('Local file playback start options are invalid');
  const boundedRoutePolicy =
    input.boundedRoutePolicy === undefined
      ? null
      : snapshotFilePlaybackBoundedRoutePolicy(input.boundedRoutePolicy);
  const positionSeconds = input.positionSeconds;
  const playbackRate = input.playbackRate;
  const rendezvousCoordinator = input.rendezvousCoordinator;
  if (!exactRendezvousCoordinator(rendezvousCoordinator)) {
    throw new TypeError('A room-owned rendezvous coordinator is required');
  }
  if (!isFiniteNonNegative(positionSeconds)) {
    throw new RangeError('Local playback position must be finite and non-negative');
  }
  if (!Number.isFinite(playbackRate) || (playbackRate as number) <= 0) {
    throw new RangeError('Local playback rate must be finite and positive');
  }

  let staged: Readonly<StagedLocalFilePlaybackParticipant> | null = null;
  let attempt: HostRendezvousAttempt | null = null;
  try {
    staged = await stageLocalFilePlaybackParticipant({
      registry: input.registry as FilePlaybackAssetRegistry,
      roomToken: input.roomToken as object,
      assetLease: input.assetLease as FilePlaybackAssetLease,
      expectedBinding: input.expectedBinding as FilePlaybackAssetBinding,
      manager: input.manager as FilePlaybackManager,
      audioContext: input.audioContext as AudioContext,
      destination: input.destination as AudioNode,
      clockBindings: input.clockBindings as FilePlaybackClockBindings,
      signal: input.signal as AbortSignal,
      isCurrent: input.isCurrent as () => boolean,
      decodeOrdinaryAudio: input.decodeOrdinaryAudio as OrdinaryAudioDecoder,
      playbackState: input.playbackState as PlaybackStateIdentity,
      participantId: input.participantId as string,
      rttP95Ms: input.rttP95Ms as number,
      armP95Ms: input.armP95Ms as number,
      ...(boundedRoutePolicy ? { boundedRoutePolicy } : {}),
      runtimeForTests: input.runtimeForTests as
        | FilePlaybackLocalStartCoordinatorRuntimeForTests
        | undefined,
    });
    attempt = Reflect.apply(trustedRendezvousStart, rendezvousCoordinator, [
      {
        run: staged.playbackState,
        positionSeconds: positionSeconds as number,
        playbackRate: playbackRate as number,
        participants: [staged.participant],
      },
    ]);
    const result = await completeLocalFilePlaybackParticipant({ staged, attempt });
    if (
      result.schedule.positionSeconds !== positionSeconds ||
      result.schedule.playbackRate !== playbackRate
    ) {
      throw new Error('Local playback rendezvous schedule changed unexpectedly');
    }
    return result;
  } catch (error) {
    cancelAttempt(
      attempt,
      input.signal instanceof AbortSignal && input.signal.aborted
        ? 'local-start-aborted'
        : 'local-start-failed',
    );
    if (staged) {
      void retireLocalFilePlaybackParticipant(
        staged,
        input.signal instanceof AbortSignal && input.signal.aborted
          ? 'local-start-aborted'
          : 'local-start-failed',
      );
    }
    throw error;
  }
}

import type { QueueItemId } from '../types/index.ts';
import {
  createFilePlaybackEndedTransitionEvidence,
  readFilePlaybackEndedTransitionIntent,
  sameFilePlaybackEndedTransitionIntent,
  type FilePlaybackEndedTransitionEvidence,
  type FilePlaybackEndedTransitionIntent,
} from './file-playback-ended-transition.ts';
import {
  createFilePlaybackScheduledTransitionResult,
  createFilePlaybackSourceSnapshot,
  readFilePlaybackCutoverTarget,
  readFilePlaybackPauseTransitionIntent,
  readFilePlaybackSeekTransitionIntent,
  readFilePlaybackStartEvidence,
  readFilePlaybackTransitionEvidence,
  readFilePlaybackTransitionResult,
  sameFilePlaybackTransitionIntent,
  type FilePlaybackCutoverArmResult,
  type FilePlaybackCutoverSource,
  type FilePlaybackCutoverTarget,
  type FilePlaybackSource,
  type FilePlaybackPosition,
  type FilePlaybackPauseTransitionIntent,
  type FilePlaybackSeekTransitionIntent,
  type FilePlaybackSourceSnapshot,
  type FilePlaybackStartEvidence,
  type FilePlaybackTransitionEvidence,
  type FilePlaybackTransitionIntent,
  type FilePlaybackTransitionResult,
} from './file-playback-source.ts';
import { readPlaybackStateIdentity } from './playback-identity.ts';
import {
  createFilePlaybackStopTransitionEvidence,
  createFilePlaybackStopTransitionResult,
  readFilePlaybackStopTransitionIntent,
  sameFilePlaybackStopTransitionIntent,
  type FilePlaybackStopTransitionEvidence,
  type FilePlaybackStopTransitionIntent,
  type FilePlaybackStopTransitionResult,
} from './file-playback-stop-transition.ts';
import {
  readRendezvousArmIntent,
  readRendezvousArmReceipt,
  readRendezvousFinalizeIntent,
  readRendezvousFinalizeReceipt,
  validateRendezvousArmReceipt,
  validateRendezvousFinalizeReceipt,
  type RendezvousArmIntent,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
} from './rendezvous-contract.ts';

export interface FilePlaybackManagerSnapshot {
  readonly active: FilePlaybackSourceSnapshot | null;
  readonly standby: FilePlaybackSourceSnapshot | null;
}

export type FilePlaybackPublication =
  | {
      readonly published: true;
      readonly snapshot: FilePlaybackSourceSnapshot;
    }
  | {
      readonly published: false;
      readonly reason: 'superseded' | 'duplicates-active';
      readonly snapshot: FilePlaybackSourceSnapshot;
    };

/** A synchronous authority fence owned by the caller that created a source. */
export type FilePlaybackActivationAuthority = () => boolean;

declare const cutoverCandidatePortBrand: unique symbol;

/**
 * An opaque, process-local capability for one staged renderer. Runtime
 * authority is held only in the manager's WeakMap; the object has no readable
 * identity or source properties and a structurally forged value is inert.
 */
export type FilePlaybackCutoverCandidatePort = object & {
  readonly [cutoverCandidatePortBrand]: never;
};

export interface FilePlaybackCutoverCandidateOptions {
  readonly source: FilePlaybackCutoverSource;
  readonly destination: AudioNode;
  readonly authority?: FilePlaybackActivationAuthority;
}

export interface FilePlaybackCutoverFinalization {
  readonly receipt: RendezvousFinalizeReceipt;
  readonly target: FilePlaybackCutoverTarget;
  readonly started: Promise<FilePlaybackStartEvidence>;
}

type CutoverRecordPhase =
  | 'staging'
  | 'staged'
  | 'arming'
  | 'armed'
  | 'finalizing'
  | 'scheduled'
  | 'current'
  | 'retiring'
  | 'failed';

interface CutoverRecord {
  readonly state: ManagedSource;
  readonly source: FilePlaybackCutoverSource;
  readonly queueItemId: QueueItemId;
  readonly backend: FilePlaybackSourceSnapshot['backend'];
  readonly destination: AudioNode;
  readonly audioContext: AudioContext;
  readonly authority: FilePlaybackActivationAuthority | null;
  readonly port: FilePlaybackCutoverCandidatePort;
  gate: GainNode | null;
  phase: CutoverRecordPhase;
  revoked: boolean;
  authorityError: AuthorityError;
  armIntent: Readonly<RendezvousArmIntent> | null;
  armPromise: Promise<FilePlaybackCutoverArmResult> | null;
  armResult: FilePlaybackCutoverArmResult | null;
  finalizeIntent: Readonly<RendezvousFinalizeIntent> | null;
  finalizePromise: Promise<FilePlaybackCutoverFinalization> | null;
  target: FilePlaybackCutoverTarget | null;
  managedStarted: Promise<FilePlaybackStartEvidence> | null;
  currentTransitionIntent: Readonly<FilePlaybackTransitionIntent> | null;
  currentTransitionPromise: Promise<FilePlaybackTransitionResult> | null;
  currentTransitionPending: boolean;
  currentStopIntent: Readonly<FilePlaybackStopTransitionIntent> | null;
  currentStopPromise: Promise<FilePlaybackStopTransitionResult> | null;
  currentStopApplied: ReturnType<
    typeof createDeferredPromise<FilePlaybackStopTransitionEvidence>
  > | null;
  currentStopTimer: ReturnType<typeof globalThis.setTimeout> | null;
  currentStopDeadlineMonotonicMs: number | null;
  currentStopPending: boolean;
  supersededCurrentStop: boolean;
  gatesScheduled: boolean;
  cleanupPromise: Promise<void> | null;
}

/** Source-free tombstone used only for exact retries of an applied STOP. */
interface CompletedCutoverStop {
  readonly audioContext: WeakRef<AudioContext>;
  readonly from: Readonly<{ queueItemId: QueueItemId; runId: string; revision: number }>;
  readonly to: Readonly<{ queueItemId: QueueItemId; runId: string; revision: number }>;
  readonly atRoomTimeMs: number;
  readonly contextTimeSeconds: number;
  readonly targetFrame: number;
  readonly promise: WeakRef<Promise<FilePlaybackStopTransitionResult>>;
}

/** Source-free tombstone used only for an exact ended-retirement retry. */
interface CompletedCutoverEnd {
  readonly intent: Readonly<FilePlaybackEndedTransitionIntent>;
  readonly promise: WeakRef<Promise<Readonly<FilePlaybackEndedTransitionEvidence>>>;
}

const CURRENT_STOP_MAX_LEAD_SECONDS = 30;
const CURRENT_STOP_EVIDENCE_GRACE_MS = 2_000;
const CURRENT_STOP_MIN_POLL_MS = 4;
const CURRENT_STOP_MAX_POLL_MS = 50;
const EXACT_FILE_PLAYBACK_MANAGERS = new WeakSet<object>();

interface ManagedSource {
  readonly source: FilePlaybackSource;
  preparePromise: Promise<FilePlaybackSourceSnapshot> | null;
  destroyPromise: Promise<void> | null;
  destroyed: boolean;
  lastSnapshot: FilePlaybackSourceSnapshot;
}

interface PendingOperation {
  readonly state: ManagedSource;
  readonly cancelled: Promise<void>;
  cancel(): void;
}

interface PendingStandbyOperation extends PendingOperation {
  promise: Promise<FilePlaybackPublication>;
}

interface PendingActiveOperation extends PendingOperation {
  readonly destination: AudioNode;
  readonly authority: FilePlaybackActivationAuthority | null;
  authorityError: AuthorityError;
  promise: Promise<FilePlaybackPublication>;
}

type AuthorityError =
  | { readonly present: false }
  | { readonly present: true; readonly error: unknown };

type PendingOutcome<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'cancelled' };

function createPendingOperation<T extends PendingOperation>(
  operation: Omit<T, 'cancelled' | 'cancel'>,
): T {
  let cancelled = false;
  let resolveCancelled!: () => void;
  const cancelledPromise = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  return {
    ...operation,
    cancelled: cancelledPromise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      resolveCancelled();
    },
  } as T;
}

function waitForOperation<T>(
  operation: PendingOperation,
  task: Promise<T>,
): Promise<PendingOutcome<T>> {
  return Promise.race([
    task.then(
      (value): PendingOutcome<T> => ({ kind: 'value', value }),
      (error: unknown): PendingOutcome<T> => ({ kind: 'error', error }),
    ),
    operation.cancelled.then((): PendingOutcome<T> => ({ kind: 'cancelled' })),
  ]);
}

const CUTOVER_OPTION_KEYS = new Set<PropertyKey>(['source', 'destination', 'authority']);
const POSITION_KEYS = new Set<PropertyKey>([
  'queueItemId',
  'run',
  'phase',
  'positionSeconds',
  'bufferedAheadSeconds',
  'underrunCount',
]);
const POSITION_PHASES = new Set([
  'new',
  'preparing',
  'ready',
  'connected',
  'armed',
  'playing',
  'paused',
  'ended',
  'cancelled',
  'failed',
  'destroyed',
]);

function readCutoverCandidateOptions(value: unknown): FilePlaybackCutoverCandidateOptions | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length < 2 || keys.length > 3 || keys.some((key) => !CUTOVER_OPTION_KEYS.has(key))) {
      return null;
    }
    const sourceDescriptor = descriptors.source;
    const destinationDescriptor = descriptors.destination;
    const authorityDescriptor = descriptors.authority;
    if (
      !sourceDescriptor?.enumerable ||
      !Object.hasOwn(sourceDescriptor, 'value') ||
      !destinationDescriptor?.enumerable ||
      !Object.hasOwn(destinationDescriptor, 'value') ||
      (authorityDescriptor !== undefined &&
        (!authorityDescriptor.enumerable || !Object.hasOwn(authorityDescriptor, 'value')))
    ) {
      return null;
    }
    const source = sourceDescriptor.value as unknown;
    const destination = destinationDescriptor.value as unknown;
    const authority = authorityDescriptor?.value as unknown;
    if (
      source === null ||
      typeof source !== 'object' ||
      destination === null ||
      typeof destination !== 'object' ||
      (authority !== undefined && typeof authority !== 'function')
    ) {
      return null;
    }
    return Object.freeze(
      Object.assign(Object.create(null), {
        source: source as FilePlaybackCutoverSource,
        destination: destination as AudioNode,
        ...(authority === undefined
          ? {}
          : { authority: authority as FilePlaybackActivationAuthority }),
      }),
    ) as FilePlaybackCutoverCandidateOptions;
  } catch {
    return null;
  }
}

function readCutoverPosition(
  value: unknown,
  expectedQueueItemId: QueueItemId,
): FilePlaybackPosition | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== POSITION_KEYS.size ||
      keys.some((key) => !POSITION_KEYS.has(key)) ||
      keys.some((key) => {
        const descriptor = descriptors[key as keyof typeof descriptors];
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
      })
    ) {
      return null;
    }
    if (descriptors.queueItemId?.value !== expectedQueueItemId) return null;
    const runValue = descriptors.run?.value;
    const run = runValue === null ? null : readPlaybackStateIdentity(runValue);
    if (runValue !== null && (!run || run.queueItemId !== expectedQueueItemId)) return null;
    const phase = descriptors.phase?.value;
    const positionSeconds = descriptors.positionSeconds?.value;
    const bufferedAheadSeconds = descriptors.bufferedAheadSeconds?.value;
    const underrunCount = descriptors.underrunCount?.value;
    if (
      typeof phase !== 'string' ||
      !POSITION_PHASES.has(phase) ||
      typeof positionSeconds !== 'number' ||
      !Number.isFinite(positionSeconds) ||
      positionSeconds < 0 ||
      typeof bufferedAheadSeconds !== 'number' ||
      !Number.isFinite(bufferedAheadSeconds) ||
      bufferedAheadSeconds < 0 ||
      typeof underrunCount !== 'number' ||
      !Number.isSafeInteger(underrunCount) ||
      underrunCount < 0
    ) {
      return null;
    }
    return Object.freeze(
      Object.assign(Object.create(null), {
        queueItemId: expectedQueueItemId,
        run,
        phase,
        positionSeconds,
        bufferedAheadSeconds,
        underrunCount,
      }),
    ) as FilePlaybackPosition;
  } catch {
    return null;
  }
}

function sameArmIntent(left: RendezvousArmIntent, right: RendezvousArmIntent): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.kind === right.kind &&
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision &&
    left.rendezvousId === right.rendezvousId &&
    left.recipientId === right.recipientId &&
    left.positionSeconds === right.positionSeconds &&
    left.playbackRate === right.playbackRate &&
    left.startAtRoomTimeMs === right.startAtRoomTimeMs &&
    left.finalizeByRoomTimeMs === right.finalizeByRoomTimeMs
  );
}

function sameFinalizeIntent(
  left: RendezvousFinalizeIntent,
  right: RendezvousFinalizeIntent,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.kind === right.kind &&
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision &&
    left.rendezvousId === right.rendezvousId &&
    left.recipientId === right.recipientId &&
    left.startAtRoomTimeMs === right.startAtRoomTimeMs &&
    left.finalizedAtRoomTimeMs === right.finalizedAtRoomTimeMs
  );
}

function finalizeMatchesArm(arm: RendezvousArmIntent, finalize: RendezvousFinalizeIntent): boolean {
  return (
    arm.protocolVersion === finalize.protocolVersion &&
    arm.queueItemId === finalize.queueItemId &&
    arm.runId === finalize.runId &&
    arm.revision === finalize.revision &&
    arm.rendezvousId === finalize.rendezvousId &&
    arm.recipientId === finalize.recipientId &&
    arm.startAtRoomTimeMs === finalize.startAtRoomTimeMs
  );
}

function createOpaqueCutoverPort(): FilePlaybackCutoverCandidatePort {
  return Object.freeze(Object.create(null)) as FilePlaybackCutoverCandidatePort;
}

function cutoverError(message: string): Error {
  return new Error(`File playback cutover: ${message}`);
}

function createDeferredPromise<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readCutoverArmResult(
  value: unknown,
  intent: RendezvousArmIntent,
  audioContext: AudioContext,
): FilePlaybackCutoverArmResult | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 4 ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'status' && key !== 'receipt' && key !== 'target' && key !== 'started'),
      ) ||
      keys.some((key) => {
        const descriptor = descriptors[key as keyof typeof descriptors];
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
      })
    ) {
      return null;
    }
    const status = descriptors.status?.value as unknown;
    const receipt = readRendezvousArmReceipt(descriptors.receipt?.value);
    if (!receipt) return null;
    const validation = validateRendezvousArmReceipt(intent, receipt);
    if (status === 'rejected') {
      if (
        descriptors.target?.value !== null ||
        descriptors.started?.value !== null ||
        validation.ok ||
        validation.code !== 'arm-rejected'
      ) {
        return null;
      }
      return Object.freeze(
        Object.assign(Object.create(null), {
          status: 'rejected' as const,
          receipt,
          target: null,
          started: null,
        }),
      ) as FilePlaybackCutoverArmResult;
    }
    if (status !== 'armed' || !validation.ok) return null;
    const target = readFilePlaybackCutoverTarget(descriptors.target?.value, audioContext);
    const started = descriptors.started?.value;
    if (target === null || started === null || typeof started !== 'object') return null;
    return Object.freeze(
      Object.assign(Object.create(null), {
        status: 'armed' as const,
        receipt,
        target,
        started: started as Promise<FilePlaybackStartEvidence>,
      }),
    ) as FilePlaybackCutoverArmResult;
  } catch {
    return null;
  }
}

function markReturnedStartPromiseObserved(value: unknown): void {
  try {
    if (value === null || typeof value !== 'object') return;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'started');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value === null) return;
    void Promise.resolve(descriptor.value as Promise<unknown>).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // Invalid source results are rejected below; observation is best effort.
  }
}

function markReturnedTransitionPromiseObserved(value: unknown): void {
  try {
    if (value === null || typeof value !== 'object') return;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'applied');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return;
    const applied = descriptor.value;
    if (!(applied instanceof Promise)) return;
    Promise.prototype.then.call(
      applied,
      () => undefined,
      () => undefined,
    );
  } catch {
    // Invalid source results are rejected below; observation is best effort.
  }
}

function transitionRejectionCompromisesCurrent(
  reason: Extract<FilePlaybackTransitionResult, { readonly status: 'rejected' }>['reason'],
): boolean {
  return (
    reason === 'operation-superseded' ||
    reason === 'schedule-failed' ||
    reason === 'source-failed' ||
    reason === 'source-destroyed'
  );
}

/**
 * Owns native file playback sources outside the serializable application tree.
 *
 * Exactly one active and one speculative standby source may be published. The
 * pending slot records below are also ownership: replacing, removing, or
 * clearing a slot cancels its continuation before destroying an unowned source.
 * That makes late prepare/connect completion unable to revive a removed item.
 */
export class FilePlaybackManager {
  private active: FilePlaybackSource | null = null;
  private standby: FilePlaybackSource | null = null;
  private pendingActive: PendingActiveOperation | null = null;
  private pendingStandby: PendingStandbyOperation | null = null;
  private readonly sourceStates = new WeakMap<FilePlaybackSource, ManagedSource>();
  private readonly discardedQueueItems = new Set<QueueItemId>();
  private readonly cutoverPorts = new WeakMap<object, CutoverRecord>();
  private readonly completedCutoverStops = new WeakMap<object, CompletedCutoverStop>();
  private readonly completedCutoverEnds = new WeakMap<object, CompletedCutoverEnd>();
  private cutoverCurrent: CutoverRecord | null = null;
  private cutoverCandidate: CutoverRecord | null = null;
  private cutoverEpoch = 0;
  private cutoverStageSequence = 0;
  private readonly cutoverStageReservations = new Set<object>();
  private cutoverRetirementBarrier: Promise<void> = Promise.resolve();
  private recoveryRequired = false;

  constructor() {
    // `super()` also runs for subclasses, so branding every `this` would let a
    // hostile subclass reset its prototype to FilePlaybackManager.prototype
    // after mutating the runtime-private own fields. Only exact construction
    // receives the unforgeable module brand.
    if (new.target === FilePlaybackManager) EXACT_FILE_PLAYBACK_MANAGERS.add(this);
  }

  /**
   * Prepares a silent V2 renderer behind a manager-owned outer gate. The
   * returned capability is intentionally opaque and valid only while this
   * exact candidate remains staged.
   */
  stageCutoverCandidate(
    options: FilePlaybackCutoverCandidateOptions,
  ): Promise<FilePlaybackCutoverCandidatePort> {
    const epoch = this.cutoverEpoch;
    const safeOptions = readCutoverCandidateOptions(options);
    if (!safeOptions || epoch !== this.cutoverEpoch) {
      return Promise.reject(cutoverError('candidate options are invalid or re-entrant'));
    }
    if (this.hasLegacyOwnership()) {
      return this.rejectCutoverStageDuringLegacy(safeOptions.source);
    }
    this.cutoverStageSequence += 1;
    const reservation = Object.freeze(Object.create(null)) as object;
    this.cutoverStageReservations.add(reservation);
    return this.stageCutoverCandidateInternal(safeOptions, this.cutoverStageSequence).finally(
      () => {
        this.cutoverStageReservations.delete(reservation);
      },
    );
  }

  armCutoverCandidate(
    port: FilePlaybackCutoverCandidatePort,
    intent: RendezvousArmIntent,
  ): Promise<FilePlaybackCutoverArmResult> {
    const epoch = this.cutoverEpoch;
    const safeIntent = readRendezvousArmIntent(intent);
    const record = this.cutoverPorts.get(port);
    if (
      safeIntent &&
      record?.armIntent &&
      sameArmIntent(record.armIntent, safeIntent) &&
      this.ownsRetryableCutoverRecord(record)
    ) {
      return record.armPromise ?? Promise.reject(cutoverError('arm retry has no cached result'));
    }
    if (!safeIntent || epoch !== this.cutoverEpoch || !record || !this.ownsLiveCandidate(record)) {
      return Promise.reject(cutoverError('candidate port or arm intent is stale'));
    }
    if (record.armIntent) {
      return Promise.reject(cutoverError('candidate is already bound to another attempt'));
    }
    if (record.phase !== 'staged') {
      return Promise.reject(cutoverError('candidate is not ready to arm'));
    }
    if (!this.authorityAllows(record)) {
      void this.retireCandidateRecord(record, 'authority-expired');
      return this.rejectedAuthorityPromise(record);
    }

    const deferred = createDeferredPromise<FilePlaybackCutoverArmResult>();
    record.armIntent = safeIntent;
    record.armPromise = deferred.promise;
    record.phase = 'arming';
    let task: Promise<FilePlaybackCutoverArmResult>;
    try {
      task = Promise.resolve(record.source.armForCutover(safeIntent));
    } catch (error) {
      task = Promise.reject(error);
    }
    void task.then(
      (result) => this.completeCandidateArm(record, result, deferred),
      (error: unknown) => this.failCandidateArm(record, error, deferred),
    );
    return deferred.promise;
  }

  /**
   * Commits only after the source accepted finalization and both outer gates
   * accepted automation for the exact backend-selected native target. The
   * returned started promise remains a distinct evidence boundary.
   */
  finalizeCutoverCandidate(
    port: FilePlaybackCutoverCandidatePort,
    intent: RendezvousFinalizeIntent,
  ): Promise<FilePlaybackCutoverFinalization> {
    const epoch = this.cutoverEpoch;
    const safeIntent = readRendezvousFinalizeIntent(intent);
    const record = this.cutoverPorts.get(port);
    if (
      safeIntent &&
      record?.finalizeIntent &&
      sameFinalizeIntent(record.finalizeIntent, safeIntent) &&
      this.ownsRetryableCutoverRecord(record)
    ) {
      return (
        record.finalizePromise ??
        Promise.reject(cutoverError('finalize retry has no cached result'))
      );
    }
    if (!safeIntent || epoch !== this.cutoverEpoch || !record || !this.ownsLiveCandidate(record)) {
      return Promise.reject(cutoverError('candidate port or finalize intent is stale'));
    }
    if (record.finalizeIntent) {
      return Promise.reject(cutoverError('candidate is already bound to another finalization'));
    }
    if (
      record.phase !== 'armed' ||
      record.armIntent === null ||
      record.armResult?.status !== 'armed' ||
      record.target === null ||
      !finalizeMatchesArm(record.armIntent, safeIntent)
    ) {
      return Promise.reject(cutoverError('candidate was not armed for this exact attempt'));
    }
    if (!this.authorityAllows(record)) {
      void this.retireCandidateRecord(record, 'authority-expired');
      return this.rejectedAuthorityPromise(record);
    }

    const deferred = createDeferredPromise<FilePlaybackCutoverFinalization>();
    record.finalizeIntent = safeIntent;
    record.finalizePromise = deferred.promise;
    record.phase = 'finalizing';
    let task: Promise<RendezvousFinalizeReceipt>;
    try {
      task = Promise.resolve(record.source.finalize(safeIntent));
    } catch (error) {
      task = Promise.reject(error);
    }
    void task.then(
      (receipt) => this.completeCandidateFinalization(record, safeIntent, receipt, deferred),
      (error: unknown) => this.failCandidateFinalization(record, error, deferred),
    );
    return deferred.promise;
  }

  /** Withdraws only the exact still-staged candidate capability. */
  retireCutoverCandidate(port: FilePlaybackCutoverCandidatePort): Promise<boolean> {
    const record = this.cutoverPorts.get(port);
    if (!record || !this.ownsLiveCandidate(record)) return Promise.resolve(false);
    return this.retireCandidateRecord(record, 'caller-retired').then(() => true);
  }

  cutoverRecoveryRequired(): boolean {
    return this.recoveryRequired;
  }

  currentCutoverPort(): FilePlaybackCutoverCandidatePort | null {
    return this.cutoverCurrent?.port ?? null;
  }

  currentCutoverSnapshot(
    port: FilePlaybackCutoverCandidatePort,
  ): FilePlaybackSourceSnapshot | null {
    const record = this.cutoverPorts.get(port);
    if (!record || this.cutoverCurrent !== record || record.revoked) return null;
    let snapshot: FilePlaybackSourceSnapshot;
    try {
      snapshot = createFilePlaybackSourceSnapshot(record.source.getSnapshot());
    } catch {
      return null;
    }
    if (this.cutoverCurrent !== record || record.revoked) return null;
    record.state.lastSnapshot = snapshot;
    return snapshot;
  }

  currentCutoverPosition(
    port: FilePlaybackCutoverCandidatePort,
    localPerformanceTimeMs: number,
  ): FilePlaybackPosition | null {
    if (!Number.isFinite(localPerformanceTimeMs) || localPerformanceTimeMs < 0) return null;
    const record = this.cutoverPorts.get(port);
    if (!record || this.cutoverCurrent !== record || record.revoked) return null;
    const position = readCutoverPosition(
      record.source.positionAt(localPerformanceTimeMs),
      record.state.lastSnapshot.queueItemId,
    );
    if (this.cutoverCurrent !== record || record.revoked) return null;
    return position;
  }

  pauseCurrentCutover(
    port: FilePlaybackCutoverCandidatePort,
    value: FilePlaybackPauseTransitionIntent,
  ): Promise<FilePlaybackTransitionResult> {
    const epoch = this.cutoverEpoch;
    const intent = readFilePlaybackPauseTransitionIntent(value);
    return this.runCurrentCutoverTransition(port, intent, epoch);
  }

  seekCurrentCutover(
    port: FilePlaybackCutoverCandidatePort,
    value: FilePlaybackSeekTransitionIntent,
  ): Promise<FilePlaybackTransitionResult> {
    const epoch = this.cutoverEpoch;
    const intent = readFilePlaybackSeekTransitionIntent(value);
    return this.runCurrentCutoverTransition(port, intent, epoch);
  }

  /**
   * Schedules logical STOP on the exact current renderer's manager-owned outer
   * gate. The backend is deliberately not asked to synthesize stopped state;
   * successful evidence synchronously revokes the current port before source
   * destruction continues in the background.
   */
  stopCurrentCutover(
    port: FilePlaybackCutoverCandidatePort,
    value: FilePlaybackStopTransitionIntent,
  ): Promise<FilePlaybackStopTransitionResult> {
    const observedEpoch = this.cutoverEpoch;
    const record = this.cutoverPorts.get(port);
    if (!record) return this.retryCompletedCutoverStop(port, value);
    const intent = readFilePlaybackStopTransitionIntent(value, record.audioContext);
    if (
      intent &&
      record?.currentStopIntent &&
      sameFilePlaybackStopTransitionIntent(record.currentStopIntent, intent, record.audioContext)
    ) {
      return (
        record.currentStopPromise ?? Promise.reject(cutoverError('stop retry has no cached result'))
      );
    }
    return this.runCurrentCutoverStop(port, intent, observedEpoch);
  }

  retireCurrentCutover(port: FilePlaybackCutoverCandidatePort): Promise<boolean> {
    const record = this.cutoverPorts.get(port);
    if (!record || this.cutoverCurrent !== record || record.revoked) {
      return Promise.resolve(false);
    }
    return this.retireCurrentRecord(record).then(() => true);
  }

  /**
   * Retires only an exact current renderer that has already reached native
   * EOF. The body-free evidence lets the room controller commit STOP without
   * pretending a scheduled stop or destroying a still-playing renderer.
   */
  retireEndedCurrent(
    port: FilePlaybackCutoverCandidatePort,
    value: FilePlaybackEndedTransitionIntent,
  ): Promise<Readonly<FilePlaybackEndedTransitionEvidence>> {
    const observedEpoch = this.cutoverEpoch;
    const intent = readFilePlaybackEndedTransitionIntent(value);
    const record = this.cutoverPorts.get(port);
    if (!intent || !record || this.cutoverCurrent !== record || record.revoked) {
      return this.retryCompletedCutoverEnd(port, intent);
    }
    if (
      this.cutoverCandidate !== null ||
      record.currentTransitionPending ||
      record.currentStopPending
    ) {
      return Promise.reject(cutoverError('ended renderer has a conflicting transition'));
    }
    if (!this.currentAuthorityAllows(record)) {
      void this.enterFailSilent(record, 'ended-renderer-authority-expired');
      return Promise.reject(cutoverError('ended renderer authority expired'));
    }
    if (observedEpoch !== this.cutoverEpoch || !this.ownsLiveCurrent(record)) {
      return Promise.reject(cutoverError('ended renderer changed during authority preflight'));
    }

    let snapshot: FilePlaybackSourceSnapshot;
    try {
      snapshot = createFilePlaybackSourceSnapshot(record.source.getSnapshot());
    } catch (error) {
      void this.enterFailSilent(record, 'ended-renderer-snapshot-unavailable');
      return Promise.reject(error);
    }
    if (observedEpoch !== this.cutoverEpoch || !this.ownsLiveCurrent(record)) {
      return Promise.reject(cutoverError('ended renderer changed during snapshot preflight'));
    }
    const run = snapshot.run ? readPlaybackStateIdentity(snapshot.run) : null;
    if (
      snapshot.queueItemId !== record.queueItemId ||
      snapshot.backend !== record.backend ||
      snapshot.phase !== 'ended' ||
      !run ||
      run.queueItemId !== intent.from.queueItemId ||
      run.runId !== intent.from.runId ||
      run.revision !== intent.from.revision
    ) {
      return Promise.reject(cutoverError('current renderer has not ended for this exact state'));
    }

    if (!this.currentAuthorityAllows(record)) {
      void this.enterFailSilent(record, 'ended-renderer-authority-expired');
      return Promise.reject(cutoverError('ended renderer authority expired'));
    }
    if (observedEpoch !== this.cutoverEpoch || !this.ownsLiveCurrent(record)) {
      return Promise.reject(cutoverError('ended renderer changed before retirement'));
    }

    const evidence = createFilePlaybackEndedTransitionEvidence(intent);
    const cleanup = this.retireCurrentRecord(record);
    const completed = cleanup.then(() => evidence);
    this.completedCutoverEnds.set(port, {
      intent,
      promise: new WeakRef(completed),
    });
    return completed;
  }

  activeSource(): FilePlaybackSource | null {
    return this.active;
  }

  standbySource(): FilePlaybackSource | null {
    return this.standby;
  }

  snapshot(): FilePlaybackManagerSnapshot {
    return Object.freeze({
      active:
        (this.cutoverCurrent
          ? this.currentCutoverSnapshot(this.cutoverCurrent.port)
          : this.active?.getSnapshot()) ?? null,
      standby: this.standby?.getSnapshot() ?? null,
    });
  }

  prepareStandby(source: FilePlaybackSource): Promise<FilePlaybackPublication> {
    const state = this.stateFor(source);
    if (this.hasCutoverOwnership()) {
      return this.rejectAndDestroy(state, 'superseded');
    }
    if (this.discardedQueueItems.has(source.queueItemId) || state.destroyed) {
      return this.rejectAndDestroy(state, 'superseded');
    }

    if (this.pendingStandby?.state === state) return this.pendingStandby.promise;
    if (this.standby === source) {
      return Promise.resolve({ published: true, snapshot: this.snapshotOf(state) });
    }

    if (this.active?.queueItemId === source.queueItemId) {
      return this.rejectDuplicateOfActive(state);
    }

    const pendingActive = this.pendingActive;
    if (pendingActive?.state.source.queueItemId === source.queueItemId) {
      if (pendingActive.state !== state) return this.rejectDuplicateOfActive(state);
      return pendingActive.promise.then((publication) => ({
        published: false,
        reason: publication.published ? 'duplicates-active' : 'superseded',
        snapshot: this.snapshotOf(state),
      }));
    }

    const previousPending = this.pendingStandby;
    const operation = createPendingOperation<PendingStandbyOperation>({
      state,
      promise: null as unknown as Promise<FilePlaybackPublication>,
    });
    this.pendingStandby = operation;
    operation.promise = this.runStandby(operation);

    if (previousPending) {
      previousPending.cancel();
      void this.destroyIfUnowned(previousPending.state);
    }
    return operation.promise;
  }

  activate(
    source: FilePlaybackSource,
    destination: AudioNode,
    authority?: FilePlaybackActivationAuthority,
  ): Promise<FilePlaybackPublication> {
    if (this.hasCutoverOwnership()) {
      return this.rejectAndDestroy(this.stateFor(source), 'superseded');
    }
    // The authority check deliberately precedes every playback-slot mutation.
    // A stale replacement may be destroyed, but cannot cancel a current load,
    // claim standby, or disturb the previously published active source.
    if (authority && !authority()) {
      return this.rejectAndDestroy(this.stateFor(source), 'superseded');
    }

    const state = this.stateFor(source);
    // Authority and source snapshot callbacks are application code. Either may
    // synchronously reserve V2 mode after the first check above.
    if (this.hasCutoverOwnership()) {
      return this.rejectAndDestroy(state, 'superseded');
    }
    if (this.discardedQueueItems.has(source.queueItemId) || state.destroyed) {
      return this.rejectAndDestroy(state, 'superseded');
    }

    if (this.pendingActive?.state === state) return this.pendingActive.promise;
    if (this.active === source) {
      return Promise.resolve({ published: true, snapshot: this.snapshotOf(state) });
    }

    const previousPendingActive = this.pendingActive;
    const claimedPendingStandby = this.pendingStandby?.state === state ? this.pendingStandby : null;
    const conflictingPendingStandby =
      this.pendingStandby?.state.source.queueItemId === source.queueItemId &&
      this.pendingStandby.state !== state
        ? this.pendingStandby
        : null;

    if (claimedPendingStandby || conflictingPendingStandby) this.pendingStandby = null;
    if (this.standby === source) this.standby = null;

    const operation = createPendingOperation<PendingActiveOperation>({
      state,
      destination,
      authority: authority ?? null,
      authorityError: { present: false },
      promise: null as unknown as Promise<FilePlaybackPublication>,
    });
    this.pendingActive = operation;
    operation.promise = this.runActive(operation);

    if (previousPendingActive) {
      previousPendingActive.cancel();
      void this.destroyIfUnowned(previousPendingActive.state);
    }
    if (claimedPendingStandby) claimedPendingStandby.cancel();
    if (conflictingPendingStandby) {
      conflictingPendingStandby.cancel();
      void this.destroyIfUnowned(conflictingPendingStandby.state);
    }
    return operation.promise;
  }

  promoteStandby(
    queueItemId: QueueItemId,
    destination: AudioNode,
  ): Promise<FilePlaybackPublication | null> {
    const source =
      this.pendingStandby?.state.source.queueItemId === queueItemId
        ? this.pendingStandby.state.source
        : this.standby?.queueItemId === queueItemId
          ? this.standby
          : null;
    return source ? this.activate(source, destination) : Promise.resolve(null);
  }

  /**
   * Retire the current playback slot without tombstoning its queue item.
   *
   * Track replacement and session teardown need to release native audio and
   * decode leases before a successor is admitted, but the same queue
   * occurrence may still be selected again. A pending activation is ownership
   * too, so it is cancelled before either source is destroyed.
   */
  async retireActive(): Promise<void> {
    const states = new Set<ManagedSource>();
    if (this.active) states.add(this.stateFor(this.active));
    const cutoverCleanup: Promise<void>[] = [];
    const currentCutover = this.cutoverCurrent;
    const candidateCutover = this.cutoverCandidate;
    if (candidateCutover)
      cutoverCleanup.push(this.retireCandidateRecord(candidateCutover, 'retire-active'));
    if (currentCutover) cutoverCleanup.push(this.retireCurrentRecord(currentCutover));

    const pendingActive = this.pendingActive;
    this.active = null;
    this.pendingActive = null;
    if (pendingActive) {
      states.add(pendingActive.state);
      pendingActive.cancel();
    }

    await Promise.all([...[...states].map((state) => this.destroyState(state)), ...cutoverCleanup]);
  }

  /**
   * Drop speculative media without tombstoning its queue item. A later preload
   * for the same occurrence therefore starts with a fresh source, while a late
   * completion from the retired source cannot republish itself.
   */
  async clearStandby(): Promise<void> {
    const states = new Set<ManagedSource>();
    if (this.standby) states.add(this.stateFor(this.standby));

    const pendingStandby = this.pendingStandby;
    this.standby = null;
    this.pendingStandby = null;
    if (pendingStandby) {
      states.add(pendingStandby.state);
      pendingStandby.cancel();
    }

    await Promise.all([...states].map((state) => this.destroyState(state)));
  }

  /**
   * Retire one exact native source without affecting a successor that happens
   * to share its queue item. This is the stale-load cleanup primitive: callers
   * keep object identity across an asynchronous publication and can safely
   * withdraw only their own result after authority changes.
   */
  async retire(source: FilePlaybackSource): Promise<void> {
    const state = this.stateFor(source);
    const cutoverCleanup: Promise<void>[] = [];
    if (this.cutoverCandidate?.state === state) {
      cutoverCleanup.push(this.retireCandidateRecord(this.cutoverCandidate, 'exact-source-retire'));
    }
    if (this.cutoverCurrent?.state === state) {
      cutoverCleanup.push(this.retireCurrentRecord(this.cutoverCurrent));
    }
    if (this.active === source) this.active = null;
    if (this.standby === source) this.standby = null;
    if (this.pendingActive?.state === state) {
      const operation = this.pendingActive;
      this.pendingActive = null;
      operation.cancel();
    }
    if (this.pendingStandby?.state === state) {
      const operation = this.pendingStandby;
      this.pendingStandby = null;
      operation.cancel();
    }
    await Promise.all([this.destroyState(state), ...cutoverCleanup]);
  }

  async discardQueueItem(queueItemId: QueueItemId): Promise<void> {
    this.discardedQueueItems.add(queueItemId);
    const states = new Set<ManagedSource>();
    const cutoverCleanup: Promise<void>[] = [];
    if (this.cutoverCandidate?.source.queueItemId === queueItemId) {
      cutoverCleanup.push(
        this.retireCandidateRecord(this.cutoverCandidate, 'queue-item-discarded'),
      );
    }
    if (this.cutoverCurrent?.source.queueItemId === queueItemId) {
      cutoverCleanup.push(this.retireCurrentRecord(this.cutoverCurrent));
    }

    if (this.active?.queueItemId === queueItemId) {
      states.add(this.stateFor(this.active));
      this.active = null;
    }
    if (this.standby?.queueItemId === queueItemId) {
      states.add(this.stateFor(this.standby));
      this.standby = null;
    }
    if (this.pendingActive?.state.source.queueItemId === queueItemId) {
      const operation = this.pendingActive;
      this.pendingActive = null;
      states.add(operation.state);
      operation.cancel();
    }
    if (this.pendingStandby?.state.source.queueItemId === queueItemId) {
      const operation = this.pendingStandby;
      this.pendingStandby = null;
      states.add(operation.state);
      operation.cancel();
    }

    await Promise.all([...[...states].map((state) => this.destroyState(state)), ...cutoverCleanup]);
  }

  async clear(): Promise<void> {
    // Invalidate even an options/authority callback that re-enters an otherwise
    // empty manager. This is a synchronous application-session boundary.
    this.cutoverEpoch += 1;
    this.cutoverStageSequence += 1;
    // Reservations belong to the generation that created them. A backend
    // prepare may never settle even after its exact source is destroyed, so a
    // full session clear must synchronously make those old reservations inert.
    // Opaque tickets keep an old promise's `finally` from touching any ticket
    // created by the next generation.
    this.cutoverStageReservations.clear();
    const states = new Set<ManagedSource>();
    if (this.active) states.add(this.stateFor(this.active));
    if (this.standby) states.add(this.stateFor(this.standby));
    if (this.pendingActive) states.add(this.pendingActive.state);
    if (this.pendingStandby) states.add(this.pendingStandby.state);
    const cutoverCleanup: Promise<void>[] = [];
    const cutoverCandidate = this.cutoverCandidate;
    const cutoverCurrent = this.cutoverCurrent;
    if (cutoverCandidate) {
      cutoverCleanup.push(this.retireCandidateRecord(cutoverCandidate, 'manager-clear'));
    }
    if (cutoverCurrent) cutoverCleanup.push(this.retireCurrentRecord(cutoverCurrent));

    const pendingActive = this.pendingActive;
    const pendingStandby = this.pendingStandby;
    this.active = null;
    this.standby = null;
    this.pendingActive = null;
    this.pendingStandby = null;
    pendingActive?.cancel();
    pendingStandby?.cancel();

    // A full clear is an authority/session boundary. Late operations above
    // are still excluded by cancelled ownership and destroyed source state,
    // while a future authoritative snapshot may legitimately reuse an ID.
    this.discardedQueueItems.clear();

    this.recoveryRequired = false;
    await Promise.all([...[...states].map((state) => this.destroyState(state)), ...cutoverCleanup]);
  }

  private async stageCutoverCandidateInternal(
    options: FilePlaybackCutoverCandidateOptions,
    stageSequence: number,
  ): Promise<FilePlaybackCutoverCandidatePort> {
    const { source, destination } = options;
    const authority = options.authority ?? null;
    const state = await this.adoptCutoverSource(source);
    let initialSnapshot: FilePlaybackSourceSnapshot;
    try {
      initialSnapshot = createFilePlaybackSourceSnapshot(source.getSnapshot());
    } catch (error) {
      await this.destroyIfUnowned(state);
      throw error;
    }
    if (initialSnapshot.queueItemId !== source.queueItemId) {
      await this.destroyIfUnowned(state);
      throw cutoverError('source and snapshot queue identities differ');
    }
    state.lastSnapshot = initialSnapshot;
    const audioContext = this.audioContextForDestination(destination);
    if (audioContext === null) {
      await this.destroyIfUnowned(state);
      throw cutoverError('destination has no usable AudioContext');
    }
    if (this.discardedQueueItems.has(initialSnapshot.queueItemId) || state.destroyed) {
      await this.destroyIfUnowned(state);
      throw cutoverError('candidate queue item was discarded');
    }
    if (!this.detachedAuthorityAllows(authority)) {
      const error = this.detachedAuthorityError;
      await this.destroyIfUnowned(state);
      if (error.present) throw error.error;
      throw cutoverError('candidate authority expired');
    }
    if (this.cutoverCurrent?.state === state) {
      throw cutoverError('current renderer cannot also be staged as its own candidate');
    }

    await this.waitForCutoverRetirements();
    if (stageSequence !== this.cutoverStageSequence) {
      await this.destroyIfUnowned(state);
      throw cutoverError('candidate staging was superseded');
    }
    if (state.destroyed || this.discardedQueueItems.has(initialSnapshot.queueItemId)) {
      await this.destroyIfUnowned(state);
      throw cutoverError('candidate authority was retired while waiting for a renderer slot');
    }

    const previous = this.cutoverCandidate;
    if (previous) {
      if (previous.state === state) {
        throw cutoverError('the exact source is already staged');
      }
      if (previous.phase === 'finalizing' || previous.phase === 'scheduled') {
        await this.destroyIfUnowned(state);
        throw cutoverError('a finalized cutover already occupies the second renderer slot');
      }
      await this.retireCandidateRecord(previous, 'candidate-replaced');
    }
    if (stageSequence !== this.cutoverStageSequence) {
      await this.destroyIfUnowned(state);
      throw cutoverError('candidate staging was superseded');
    }
    if (this.cutoverCandidate !== null) {
      await this.destroyIfUnowned(state);
      throw cutoverError('candidate slot changed while staging');
    }
    if (state.destroyed || this.discardedQueueItems.has(initialSnapshot.queueItemId)) {
      await this.destroyIfUnowned(state);
      throw cutoverError('candidate authority was retired while replacing a renderer');
    }
    if (!this.detachedAuthorityAllows(authority)) {
      const error = this.detachedAuthorityError;
      await this.destroyIfUnowned(state);
      if (error.present) throw error.error;
      throw cutoverError('candidate authority expired');
    }

    const port = createOpaqueCutoverPort();
    const record: CutoverRecord = {
      state,
      source,
      queueItemId: initialSnapshot.queueItemId,
      backend: initialSnapshot.backend,
      destination,
      audioContext,
      authority,
      port,
      gate: null,
      phase: 'staging',
      revoked: false,
      authorityError: { present: false },
      armIntent: null,
      armPromise: null,
      armResult: null,
      finalizeIntent: null,
      finalizePromise: null,
      target: null,
      managedStarted: null,
      currentTransitionIntent: null,
      currentTransitionPromise: null,
      currentTransitionPending: false,
      currentStopIntent: null,
      currentStopPromise: null,
      currentStopApplied: null,
      currentStopTimer: null,
      currentStopDeadlineMonotonicMs: null,
      currentStopPending: false,
      supersededCurrentStop: false,
      gatesScheduled: false,
      cleanupPromise: null,
    };
    this.cutoverCandidate = record;
    this.cutoverPorts.set(port, record);
    this.cutoverEpoch += 1;

    try {
      const gate = audioContext.createGain();
      record.gate = gate;
      if (!this.ownsLiveCandidate(record) || !this.authorityAllows(record)) {
        throw this.authorityOrStaleError(record);
      }
      const now = this.readContextTime(audioContext);
      gate.gain.cancelScheduledValues(now);
      gate.gain.setValueAtTime(0, now);
      gate.connect(destination);
      if (!this.ownsLiveCandidate(record) || !this.authorityAllows(record)) {
        throw this.authorityOrStaleError(record);
      }

      await this.prepareOnce(state);
      if (!this.ownsLiveCandidate(record) || !this.authorityAllows(record)) {
        throw this.authorityOrStaleError(record);
      }
      await this.connectAndRemember(state, gate);
      if (!this.ownsLiveCandidate(record) || !this.authorityAllows(record)) {
        throw this.authorityOrStaleError(record);
      }
      record.phase = 'staged';
      return port;
    } catch (error) {
      await this.retireCandidateRecord(record, 'stage-failed');
      throw error;
    }
  }

  private completeCandidateArm(
    record: CutoverRecord,
    value: unknown,
    deferred: ReturnType<typeof createDeferredPromise<FilePlaybackCutoverArmResult>>,
  ): void {
    markReturnedStartPromiseObserved(value);
    const safeIntent = record.armIntent;
    const result = safeIntent ? readCutoverArmResult(value, safeIntent, record.audioContext) : null;
    if (
      !this.ownsLiveCandidate(record) ||
      record.phase !== 'arming' ||
      result === null ||
      !this.authorityAllows(record)
    ) {
      const error =
        result === null
          ? cutoverError('source returned an invalid arm result')
          : this.authorityOrStaleError(record);
      void this.retireCandidateRecord(record, 'arm-failed');
      deferred.reject(error);
      return;
    }
    record.armResult = result;
    if (result.status === 'rejected') {
      record.phase = 'staged';
      deferred.resolve(result);
      return;
    }
    record.target = result.target;
    record.phase = 'armed';
    // Retirement before FINALIZE is expected and the source contract rejects
    // this promise in that case. Mark it observed now; the managed evidence
    // branch below still receives and validates the same settlement later.
    void Promise.resolve(result.started).then(
      () => undefined,
      () => undefined,
    );
    deferred.resolve(result);
  }

  private failCandidateArm(
    record: CutoverRecord,
    error: unknown,
    deferred: ReturnType<typeof createDeferredPromise<FilePlaybackCutoverArmResult>>,
  ): void {
    void this.retireCandidateRecord(record, 'arm-failed');
    deferred.reject(error);
  }

  private completeCandidateFinalization(
    record: CutoverRecord,
    intent: Readonly<RendezvousFinalizeIntent>,
    value: unknown,
    deferred: ReturnType<typeof createDeferredPromise<FilePlaybackCutoverFinalization>>,
  ): void {
    const receipt = readRendezvousFinalizeReceipt(value);
    const target = record.target;
    const sourceStarted = record.armResult?.status === 'armed' ? record.armResult.started : null;
    if (!this.ownsLiveCandidate(record) || record.phase !== 'finalizing') {
      deferred.reject(cutoverError('source finalization completed after candidate revocation'));
      return;
    }
    if (
      receipt === null ||
      target === null ||
      sourceStarted === null ||
      !validateRendezvousFinalizeReceipt(intent, receipt).ok ||
      !this.authorityAllows(record)
    ) {
      const error = cutoverError('source finalization was rejected or became stale');
      if (this.targetHasPassed(record)) {
        void this.enterFailSilent(record, 'finalize-invalid-after-target');
      } else {
        void this.retireCandidateRecord(record, 'finalize-failed');
      }
      deferred.reject(error);
      return;
    }

    try {
      this.scheduleExactCutover(record, target);
      if (!this.ownsLiveCandidate(record) || !this.authorityAllows(record)) {
        throw this.authorityOrStaleError(record);
      }
    } catch (error) {
      if (this.targetHasPassed(record)) {
        void this.enterFailSilent(record, 'gate-scheduling-failed');
      } else {
        void this.retireCandidateRecord(record, 'gate-scheduling-failed');
      }
      deferred.reject(error);
      return;
    }

    record.phase = 'scheduled';
    const managedStarted = this.observeCandidateStart(record, sourceStarted, target);
    void managedStarted.then(
      () => undefined,
      () => undefined,
    );
    record.managedStarted = managedStarted;
    const finalization = Object.freeze(
      Object.assign(Object.create(null), {
        receipt,
        target,
        started: managedStarted,
      }),
    ) as FilePlaybackCutoverFinalization;
    deferred.resolve(finalization);
  }

  private failCandidateFinalization(
    record: CutoverRecord,
    error: unknown,
    deferred: ReturnType<typeof createDeferredPromise<FilePlaybackCutoverFinalization>>,
  ): void {
    if (!this.ownsLiveCandidate(record) || record.phase !== 'finalizing') {
      deferred.reject(error);
      return;
    }
    if (this.targetHasPassed(record)) {
      void this.enterFailSilent(record, 'finalize-promise-failed');
    } else {
      void this.retireCandidateRecord(record, 'finalize-promise-failed');
    }
    deferred.reject(error);
  }

  private observeCandidateStart(
    record: CutoverRecord,
    sourceStarted: Promise<FilePlaybackStartEvidence>,
    target: FilePlaybackCutoverTarget,
  ): Promise<FilePlaybackStartEvidence> {
    const deferred = createDeferredPromise<FilePlaybackStartEvidence>();
    let task: Promise<FilePlaybackStartEvidence>;
    try {
      task = Promise.resolve(sourceStarted);
    } catch (error) {
      task = Promise.reject(error);
    }
    void task.then(
      (value) => {
        const evidence = readFilePlaybackStartEvidence(value, target.targetFrame);
        const evidenceMatchesBackend =
          (record.backend === 'audio-buffer' && evidence?.kind === 'webaudio-schedule-passed') ||
          (record.backend === 'bounded-stream' && evidence?.kind === 'worklet-observed');
        if (!this.ownsLiveCandidate(record) || record.phase !== 'scheduled') {
          deferred.reject(cutoverError('start evidence completed after candidate revocation'));
          return;
        }
        if (evidence === null || !evidenceMatchesBackend || record.target !== target) {
          const error = cutoverError('start evidence was invalid or stale');
          if (this.targetHasPassed(record)) {
            void this.enterFailSilent(record, 'start-evidence-invalid');
          } else {
            void this.retireCandidateRecord(record, 'start-evidence-invalid');
          }
          deferred.reject(error);
          return;
        }
        if (!this.authorityAllows(record)) {
          const error = this.authorityOrStaleError(record);
          if (this.targetHasPassed(record)) {
            void this.enterFailSilent(record, 'start-evidence-authority-expired');
          } else {
            void this.retireCandidateRecord(record, 'start-evidence-authority-expired');
          }
          deferred.reject(error);
          return;
        }
        const startBoundaryProven =
          evidence.kind === 'worklet-observed' || this.targetHasPassed(record);
        if (!this.ownsLiveCandidate(record) || record.phase !== 'scheduled') {
          deferred.reject(cutoverError('start evidence completed after candidate revocation'));
          return;
        }
        if (!startBoundaryProven) {
          void this.retireCandidateRecord(record, 'start-evidence-before-target');
          deferred.reject(cutoverError('start evidence was invalid or stale'));
          return;
        }
        if (!this.promoteStartedCandidate(record, evidence)) {
          deferred.reject(cutoverError('candidate promotion lost authority'));
          return;
        }
        deferred.resolve(evidence);
      },
      (error: unknown) => {
        if (!this.ownsLiveCandidate(record) || record.phase !== 'scheduled') {
          deferred.reject(error);
          return;
        }
        if (this.targetHasPassed(record)) {
          void this.enterFailSilent(record, 'start-evidence-rejected');
        } else {
          void this.retireCandidateRecord(record, 'start-evidence-rejected');
        }
        deferred.reject(error);
      },
    );
    return deferred.promise;
  }

  private promoteStartedCandidate(
    record: CutoverRecord,
    _evidence: FilePlaybackStartEvidence,
  ): boolean {
    if (!this.ownsLiveCandidate(record) || record.phase !== 'scheduled') return false;
    const previous = this.cutoverCurrent;
    this.cutoverCandidate = null;
    record.phase = 'current';
    record.gatesScheduled = false;
    record.supersededCurrentStop = false;
    this.cutoverCurrent = record;
    this.cutoverEpoch += 1;
    this.recoveryRequired = false;

    if (previous && previous !== record) {
      this.cancelCurrentStop(
        previous,
        cutoverError('current renderer was replaced before its stop boundary'),
      );
      previous.revoked = true;
      previous.phase = 'retiring';
      this.forceGate(previous, 0);
      this.disconnectGate(previous);
      if (this.cutoverCurrent !== previous) {
        const cleanup = this.destroyIfUnowned(previous.state);
        this.bindTerminalCutoverCleanup(previous, cleanup);
      }
    }
    return this.cutoverCurrent === record && !record.revoked && record.phase === 'current';
  }

  private runCurrentCutoverTransition(
    port: FilePlaybackCutoverCandidatePort,
    intent: Readonly<FilePlaybackTransitionIntent> | null,
    observedEpoch: number,
  ): Promise<FilePlaybackTransitionResult> {
    const record = this.cutoverPorts.get(port);
    if (
      !intent ||
      observedEpoch !== this.cutoverEpoch ||
      !record ||
      !this.ownsLiveCurrent(record)
    ) {
      return Promise.reject(cutoverError('current port or transition intent is stale'));
    }
    if (
      record.currentTransitionIntent &&
      sameFilePlaybackTransitionIntent(record.currentTransitionIntent, intent)
    ) {
      return (
        record.currentTransitionPromise ??
        Promise.reject(cutoverError('transition retry has no cached result'))
      );
    }
    if (record.currentTransitionPending || record.currentStopPending) {
      return Promise.reject(cutoverError('another current transition is still pending'));
    }

    let currentSnapshot: FilePlaybackSourceSnapshot;
    try {
      currentSnapshot = createFilePlaybackSourceSnapshot(record.source.getSnapshot());
    } catch (error) {
      if (this.ownsLiveCurrent(record)) {
        void this.enterFailSilent(record, 'current-transition-snapshot-unavailable');
      }
      return Promise.reject(error);
    }
    if (observedEpoch !== this.cutoverEpoch || !this.ownsLiveCurrent(record)) {
      return Promise.reject(cutoverError('current renderer changed during transition preflight'));
    }
    if (
      currentSnapshot.queueItemId !== record.queueItemId ||
      currentSnapshot.backend !== record.backend
    ) {
      void this.enterFailSilent(record, 'current-transition-source-identity-mismatch');
      return Promise.reject(cutoverError('current backend snapshot changed managed source'));
    }
    if (!this.transitionSnapshotMatches(record, currentSnapshot, intent.from)) {
      return Promise.reject(cutoverError('transition from state is not current'));
    }
    record.state.lastSnapshot = currentSnapshot;
    if (!this.currentAuthorityAllows(record)) {
      void this.enterFailSilent(record, 'current-transition-authority-expired');
      return this.rejectedAuthorityPromise(record);
    }

    const deferred = createDeferredPromise<FilePlaybackTransitionResult>();
    record.currentTransitionIntent = intent;
    record.currentTransitionPromise = deferred.promise;
    record.currentTransitionPending = true;
    let task: Promise<FilePlaybackTransitionResult>;
    try {
      task =
        intent.kind === 'file-playback-pause-transition'
          ? Promise.resolve(record.source.pauseRevisioned(intent))
          : Promise.resolve(record.source.seekRevisioned(intent));
    } catch (error) {
      task = Promise.reject(error);
    }
    void task.then(
      (result) =>
        this.completeCurrentCutoverTransition(record, intent, currentSnapshot, result, deferred),
      (error: unknown) => this.failCurrentCutoverTransition(record, error, deferred),
    );
    return deferred.promise;
  }

  private completeCurrentCutoverTransition(
    record: CutoverRecord,
    intent: Readonly<FilePlaybackTransitionIntent>,
    preflightSnapshot: FilePlaybackSourceSnapshot,
    value: unknown,
    deferred: ReturnType<typeof createDeferredPromise<FilePlaybackTransitionResult>>,
  ): void {
    markReturnedTransitionPromiseObserved(value);
    if (!this.ownsLiveCurrent(record)) {
      record.currentTransitionPending = false;
      deferred.reject(cutoverError('current renderer was replaced during transition'));
      return;
    }
    const result = readFilePlaybackTransitionResult(value, intent, record.audioContext);
    if (!result) {
      record.currentTransitionPending = false;
      void this.enterFailSilent(record, 'invalid-current-transition-result');
      deferred.reject(cutoverError('backend returned invalid transition authority'));
      return;
    }
    if (
      !this.transitionSnapshotMatches(record, result.snapshot, intent.from, preflightSnapshot.phase)
    ) {
      record.currentTransitionPending = false;
      void this.enterFailSilent(record, 'current-transition-returned-foreign-snapshot');
      deferred.reject(cutoverError('backend transition snapshot is not current'));
      return;
    }
    if (result.status === 'rejected') {
      record.currentTransitionPending = false;
      record.state.lastSnapshot = result.snapshot;
      if (transitionRejectionCompromisesCurrent(result.reason)) {
        void this.enterFailSilent(record, 'current-transition-rejected-unsafely');
        deferred.reject(cutoverError(`current transition failed: ${result.reason}`));
        return;
      }
      deferred.resolve(result);
      return;
    }

    const appliedDeferred = createDeferredPromise<FilePlaybackTransitionEvidence>();
    const expectedObservation =
      record.backend === 'audio-buffer' ? 'webaudio-schedule-passed' : 'worklet-observed';
    try {
      Promise.prototype.then.call(
        result.applied,
        (evidence: unknown) => {
          const canonical = readFilePlaybackTransitionEvidence(
            evidence,
            intent,
            expectedObservation,
            result.target.targetFrame,
          );
          const authorityAccepted = canonical !== null && this.currentAuthorityAllows(record);
          if (!canonical || !authorityAccepted) {
            record.currentTransitionPending = false;
            if (this.ownsLiveCurrent(record)) {
              void this.enterFailSilent(
                record,
                canonical
                  ? 'current-transition-authority-expired'
                  : 'invalid-current-transition-evidence',
              );
            }
            appliedDeferred.reject(
              cutoverError('current transition evidence is invalid or revoked'),
            );
            return;
          }
          const authorityEpoch = this.cutoverEpoch;
          let snapshot: FilePlaybackSourceSnapshot;
          try {
            snapshot = createFilePlaybackSourceSnapshot(record.source.getSnapshot());
          } catch {
            record.currentTransitionPending = false;
            void this.enterFailSilent(record, 'transition-snapshot-unavailable');
            appliedDeferred.reject(cutoverError('transition snapshot is unavailable'));
            return;
          }
          const snapshotRun = snapshot.run ? readPlaybackStateIdentity(snapshot.run) : null;
          if (
            authorityEpoch !== this.cutoverEpoch ||
            !this.ownsLiveCurrent(record) ||
            !snapshotRun ||
            !this.transitionSnapshotMatches(record, snapshot, intent.to) ||
            snapshot.phase !== 'paused'
          ) {
            record.currentTransitionPending = false;
            if (this.ownsLiveCurrent(record)) {
              void this.enterFailSilent(record, 'transition-state-not-applied');
            }
            appliedDeferred.reject(cutoverError('transition state did not match evidence'));
            return;
          }
          record.state.lastSnapshot = snapshot;
          record.currentTransitionPending = false;
          appliedDeferred.resolve(canonical);
        },
        (error: unknown) => {
          record.currentTransitionPending = false;
          if (this.ownsLiveCurrent(record)) {
            void this.enterFailSilent(record, 'current-transition-evidence-rejected');
          }
          appliedDeferred.reject(error);
        },
      );
    } catch (error) {
      record.currentTransitionPending = false;
      void this.enterFailSilent(record, 'current-transition-promise-invalid');
      appliedDeferred.reject(error);
    }

    try {
      deferred.resolve(
        createFilePlaybackScheduledTransitionResult(
          intent,
          result.target,
          result.snapshot,
          appliedDeferred.promise,
        ),
      );
    } catch (error) {
      record.currentTransitionPending = false;
      void this.enterFailSilent(record, 'current-transition-result-wrap-failed');
      deferred.reject(error);
    }
  }

  private failCurrentCutoverTransition(
    record: CutoverRecord,
    error: unknown,
    deferred: ReturnType<typeof createDeferredPromise<FilePlaybackTransitionResult>>,
  ): void {
    record.currentTransitionPending = false;
    if (this.ownsLiveCurrent(record)) {
      void this.enterFailSilent(record, 'current-transition-call-failed');
    }
    deferred.reject(error);
  }

  private runCurrentCutoverStop(
    port: FilePlaybackCutoverCandidatePort,
    intent: Readonly<FilePlaybackStopTransitionIntent> | null,
    observedEpoch: number,
  ): Promise<FilePlaybackStopTransitionResult> {
    const record = this.cutoverPorts.get(port);
    if (
      !intent ||
      observedEpoch !== this.cutoverEpoch ||
      !record ||
      !this.ownsLiveCurrent(record)
    ) {
      return Promise.reject(cutoverError('current port or stop intent is stale'));
    }
    if (record.currentTransitionPending || record.currentStopPending) {
      return Promise.reject(cutoverError('another current transition is still pending'));
    }
    if (
      this.cutoverCandidate?.phase === 'finalizing' ||
      this.cutoverCandidate?.phase === 'scheduled'
    ) {
      return Promise.reject(cutoverError('a renderer replacement is already committing'));
    }

    let currentSnapshot: FilePlaybackSourceSnapshot;
    try {
      currentSnapshot = createFilePlaybackSourceSnapshot(record.source.getSnapshot());
    } catch (error) {
      if (this.ownsLiveCurrent(record)) {
        void this.enterFailSilent(record, 'current-stop-snapshot-unavailable');
      }
      return Promise.reject(error);
    }
    if (observedEpoch !== this.cutoverEpoch || !this.ownsLiveCurrent(record)) {
      return Promise.reject(cutoverError('current renderer changed during stop preflight'));
    }
    if (
      currentSnapshot.queueItemId !== record.queueItemId ||
      currentSnapshot.backend !== record.backend
    ) {
      void this.enterFailSilent(record, 'current-stop-source-identity-mismatch');
      return Promise.reject(cutoverError('current backend snapshot changed managed source'));
    }
    if (
      !this.transitionSnapshotMatches(record, currentSnapshot, intent.from) ||
      (currentSnapshot.phase !== 'playing' && currentSnapshot.phase !== 'paused')
    ) {
      return Promise.reject(cutoverError('stop from state is not current'));
    }
    record.state.lastSnapshot = currentSnapshot;
    if (!this.currentAuthorityAllows(record)) {
      void this.enterFailSilent(record, 'current-stop-authority-expired');
      return this.rejectedAuthorityPromise(record);
    }

    const gate = record.gate;
    const target = readFilePlaybackCutoverTarget(intent.target, record.audioContext);
    if (
      !gate ||
      !target ||
      gate.context !== record.audioContext ||
      this.audioContextForDestination(record.destination) !== record.audioContext
    ) {
      void this.enterFailSilent(record, 'current-stop-native-clock-mismatch');
      return Promise.reject(cutoverError('current stop does not own one AudioContext clock'));
    }
    if (observedEpoch !== this.cutoverEpoch || !this.ownsLiveCurrent(record)) {
      return Promise.reject(cutoverError('current renderer changed during stop clock preflight'));
    }
    if (!this.audioContextIsRunning(record.audioContext)) {
      void this.enterFailSilent(record, 'current-stop-context-not-running');
      return Promise.reject(cutoverError('AudioContext is not running at stop preflight'));
    }

    let now: number;
    let sampleRate: number;
    try {
      now = this.readContextTime(record.audioContext);
      sampleRate = this.readContextSampleRate(record.audioContext);
    } catch (error) {
      void this.enterFailSilent(record, 'current-stop-clock-unavailable');
      return Promise.reject(error);
    }
    if (
      observedEpoch !== this.cutoverEpoch ||
      !this.ownsLiveCurrent(record) ||
      !this.currentAuthorityAllows(record)
    ) {
      return Promise.reject(cutoverError('current renderer changed during stop time preflight'));
    }
    const currentFrame = Math.round(now * sampleRate);
    const leadSeconds = target.contextTimeSeconds - now;
    if (
      leadSeconds <= 0 ||
      leadSeconds > CURRENT_STOP_MAX_LEAD_SECONDS ||
      target.targetFrame <= currentFrame
    ) {
      return Promise.reject(cutoverError('stop target is not an exact bounded future frame'));
    }

    const resultDeferred = createDeferredPromise<FilePlaybackStopTransitionResult>();
    const appliedDeferred = createDeferredPromise<FilePlaybackStopTransitionEvidence>();
    void appliedDeferred.promise.then(
      () => undefined,
      () => undefined,
    );
    record.currentStopIntent = intent;
    record.currentStopPromise = resultDeferred.promise;
    record.currentStopApplied = appliedDeferred;
    record.currentStopPending = true;

    try {
      record.currentStopDeadlineMonotonicMs =
        this.readMonotonicTimeMs() + leadSeconds * 1_000 + CURRENT_STOP_EVIDENCE_GRACE_MS;
      this.scheduleCurrentStopGate(record, intent, observedEpoch, now);
      this.scheduleCurrentStopWatcher(record, intent);
      resultDeferred.resolve(
        createFilePlaybackStopTransitionResult(intent, appliedDeferred.promise),
      );
    } catch (error) {
      this.clearCurrentStopTimer(record);
      const preserved = this.rollbackCurrentStopGate(record, intent);
      record.currentStopPending = false;
      appliedDeferred.reject(error);
      if (!preserved && this.ownsLiveCurrent(record)) {
        void this.enterFailSilent(record, 'current-stop-scheduling-ambiguous');
      }
      resultDeferred.reject(error);
    }
    return resultDeferred.promise;
  }

  private scheduleCurrentStopGate(
    record: CutoverRecord,
    intent: Readonly<FilePlaybackStopTransitionIntent>,
    observedEpoch: number,
    now: number,
  ): void {
    const gate = record.gate;
    if (!gate) throw cutoverError('current outer gate is unavailable');
    this.assertCurrentStopTransactionOwned(record, intent, observedEpoch);
    gate.gain.cancelScheduledValues(now);
    this.assertCurrentStopTransactionOwned(record, intent, observedEpoch);
    gate.gain.setValueAtTime(1, now);
    this.assertCurrentStopTransactionOwned(record, intent, observedEpoch);
    gate.gain.setValueAtTime(0, intent.target.contextTimeSeconds);
    this.assertCurrentStopTransactionOwned(record, intent, observedEpoch);
  }

  private scheduleCurrentStopWatcher(
    record: CutoverRecord,
    intent: Readonly<FilePlaybackStopTransitionIntent>,
  ): void {
    this.clearCurrentStopTimer(record);
    const now = this.readContextTime(record.audioContext);
    const remainingMs = Math.max(0, (intent.target.contextTimeSeconds - now) * 1_000);
    const delayMs = Math.min(
      CURRENT_STOP_MAX_POLL_MS,
      Math.max(CURRENT_STOP_MIN_POLL_MS, remainingMs),
    );
    record.currentStopTimer = globalThis.setTimeout(() => {
      record.currentStopTimer = null;
      this.watchCurrentStop(record, intent);
    }, delayMs);
  }

  private watchCurrentStop(
    record: CutoverRecord,
    intent: Readonly<FilePlaybackStopTransitionIntent>,
  ): void {
    if (
      !record.currentStopPending ||
      record.currentStopIntent !== intent ||
      !this.ownsLiveCurrent(record)
    ) {
      this.cancelCurrentStop(record, cutoverError('current renderer changed before stop evidence'));
      return;
    }
    if (!this.currentAuthorityAllows(record)) {
      this.rejectCurrentStopAfterScheduling(
        record,
        cutoverError('current stop authority expired'),
        false,
      );
      return;
    }
    if (!this.audioContextIsRunning(record.audioContext)) {
      this.rejectCurrentStopAfterScheduling(
        record,
        cutoverError('AudioContext stopped before stop evidence'),
        false,
      );
      return;
    }

    let now: number;
    let sampleRate: number;
    try {
      now = this.readContextTime(record.audioContext);
      sampleRate = this.readContextSampleRate(record.audioContext);
    } catch (error) {
      this.rejectCurrentStopAfterScheduling(record, error, false);
      return;
    }
    if (
      !record.currentStopPending ||
      record.currentStopIntent !== intent ||
      !this.ownsLiveCurrent(record)
    ) {
      this.cancelCurrentStop(record, cutoverError('current renderer changed during stop evidence'));
      return;
    }
    const currentFrame = Math.round(now * sampleRate);
    if (now >= intent.target.contextTimeSeconds && currentFrame >= intent.target.targetFrame) {
      this.commitCurrentStop(record, intent, currentFrame);
      return;
    }
    const deadline = record.currentStopDeadlineMonotonicMs;
    let monotonicTimeMs: number;
    try {
      monotonicTimeMs = this.readMonotonicTimeMs();
    } catch (error) {
      this.rejectCurrentStopAfterScheduling(record, error, false);
      return;
    }
    if (deadline === null || !Number.isFinite(deadline) || monotonicTimeMs > deadline) {
      this.rejectCurrentStopAfterScheduling(
        record,
        cutoverError('AudioContext did not pass the stop target before its deadline'),
        false,
      );
      return;
    }
    try {
      this.scheduleCurrentStopWatcher(record, intent);
    } catch (error) {
      this.rejectCurrentStopAfterScheduling(record, error, true);
    }
  }

  private commitCurrentStop(
    record: CutoverRecord,
    intent: Readonly<FilePlaybackStopTransitionIntent>,
    appliedFrame: number,
  ): void {
    if (
      !record.currentStopPending ||
      record.currentStopIntent !== intent ||
      !this.ownsLiveCurrent(record)
    ) {
      this.cancelCurrentStop(record, cutoverError('current stop lost commit authority'));
      return;
    }
    const observedEpoch = this.cutoverEpoch;
    let evidence: FilePlaybackStopTransitionEvidence;
    try {
      evidence = createFilePlaybackStopTransitionEvidence(intent, appliedFrame);
    } catch (error) {
      this.rejectCurrentStopAfterScheduling(record, error, false);
      return;
    }
    // Evidence canonicalization revalidates the AudioContext target and may
    // read native sample-rate state. A hostile/native getter can synchronously
    // revoke or replace this renderer, so no stop commit may use the authority
    // captured before that read.
    if (
      observedEpoch !== this.cutoverEpoch ||
      !record.currentStopPending ||
      record.currentStopIntent !== intent ||
      !this.ownsLiveCurrent(record) ||
      !this.currentAuthorityAllows(record) ||
      observedEpoch !== this.cutoverEpoch ||
      !record.currentStopPending ||
      record.currentStopIntent !== intent ||
      !this.ownsLiveCurrent(record)
    ) {
      if (record.currentStopPending && this.ownsLiveCurrent(record)) {
        this.rejectCurrentStopAfterScheduling(
          record,
          cutoverError('current stop lost authority during evidence validation'),
          false,
        );
      } else {
        this.cancelCurrentStop(
          record,
          cutoverError('current stop was revoked during evidence validation'),
        );
      }
      return;
    }
    const applied = record.currentStopApplied;
    this.clearCurrentStopTimer(record);
    record.currentStopPending = false;
    this.cutoverCurrent = null;
    record.revoked = true;
    record.phase = 'retiring';
    this.cutoverEpoch += 1;
    this.forceGate(record, 0);
    this.disconnectGate(record);
    applied?.resolve(evidence);
    const completedIntent = record.currentStopIntent;
    const completedPromise = record.currentStopPromise;
    if (completedIntent && completedPromise) {
      this.completedCutoverStops.set(record.port, {
        audioContext: new WeakRef(record.audioContext),
        from: completedIntent.from,
        to: completedIntent.to,
        atRoomTimeMs: completedIntent.atRoomTimeMs,
        contextTimeSeconds: completedIntent.target.contextTimeSeconds,
        targetFrame: completedIntent.target.targetFrame,
        promise: new WeakRef(completedPromise),
      });
    }
    this.bindTerminalCutoverCleanup(record, this.destroyIfUnowned(record.state));
  }

  private retryCompletedCutoverStop(
    port: FilePlaybackCutoverCandidatePort,
    value: FilePlaybackStopTransitionIntent,
  ): Promise<FilePlaybackStopTransitionResult> {
    const completed = this.completedCutoverStops.get(port);
    const audioContext = completed?.audioContext.deref();
    const promise = completed?.promise.deref();
    const intent = audioContext ? readFilePlaybackStopTransitionIntent(value, audioContext) : null;
    if (
      !completed ||
      !promise ||
      !intent ||
      intent.from.queueItemId !== completed.from.queueItemId ||
      intent.from.runId !== completed.from.runId ||
      intent.from.revision !== completed.from.revision ||
      intent.to.queueItemId !== completed.to.queueItemId ||
      intent.to.runId !== completed.to.runId ||
      intent.to.revision !== completed.to.revision ||
      intent.atRoomTimeMs !== completed.atRoomTimeMs ||
      intent.target.contextTimeSeconds !== completed.contextTimeSeconds ||
      intent.target.targetFrame !== completed.targetFrame
    ) {
      return Promise.reject(cutoverError('current port or stop intent is stale'));
    }
    return promise;
  }

  private retryCompletedCutoverEnd(
    port: FilePlaybackCutoverCandidatePort,
    intent: Readonly<FilePlaybackEndedTransitionIntent> | null,
  ): Promise<Readonly<FilePlaybackEndedTransitionEvidence>> {
    const completed = this.completedCutoverEnds.get(port);
    const promise = completed?.promise.deref();
    if (
      !completed ||
      !promise ||
      !intent ||
      !sameFilePlaybackEndedTransitionIntent(completed.intent, intent)
    ) {
      return Promise.reject(cutoverError('current port or ended intent is stale'));
    }
    return promise;
  }

  private rejectCurrentStopAfterScheduling(
    record: CutoverRecord,
    error: unknown,
    mayPreserveBeforeTarget: boolean,
  ): void {
    if (!record.currentStopPending) return;
    this.clearCurrentStopTimer(record);
    const intent = record.currentStopIntent;
    const mayPreserve =
      mayPreserveBeforeTarget && intent !== null && this.rollbackCurrentStopGate(record, intent);
    record.currentStopPending = false;
    record.currentStopApplied?.reject(error);
    if (!mayPreserve && this.ownsLiveCurrent(record)) {
      void this.enterFailSilent(record, 'current-stop-evidence-ambiguous');
    }
  }

  private rollbackCurrentStopGate(
    record: CutoverRecord,
    intent: Readonly<FilePlaybackStopTransitionIntent>,
  ): boolean {
    const gate = record.gate;
    const observedEpoch = this.cutoverEpoch;
    if (
      !gate ||
      !record.currentStopPending ||
      record.currentStopIntent !== intent ||
      !this.ownsLiveCurrent(record) ||
      !this.currentAuthorityAllows(record)
    ) {
      return false;
    }
    try {
      const before = this.readContextTime(record.audioContext);
      const sampleRate = this.readContextSampleRate(record.audioContext);
      if (
        observedEpoch !== this.cutoverEpoch ||
        !record.currentStopPending ||
        record.currentStopIntent !== intent ||
        !this.ownsLiveCurrent(record) ||
        before >= intent.target.contextTimeSeconds ||
        Math.round(before * sampleRate) >= intent.target.targetFrame
      ) {
        return false;
      }

      gate.gain.cancelScheduledValues(before);
      if (
        observedEpoch !== this.cutoverEpoch ||
        !record.currentStopPending ||
        record.currentStopIntent !== intent ||
        !this.ownsLiveCurrent(record) ||
        !this.currentAuthorityAllows(record)
      ) {
        return false;
      }
      gate.gain.setValueAtTime(1, before);
      if (
        observedEpoch !== this.cutoverEpoch ||
        !record.currentStopPending ||
        record.currentStopIntent !== intent ||
        !this.ownsLiveCurrent(record) ||
        !this.currentAuthorityAllows(record)
      ) {
        return false;
      }

      const after = this.readContextTime(record.audioContext);
      const afterSampleRate = this.readContextSampleRate(record.audioContext);
      return (
        observedEpoch === this.cutoverEpoch &&
        record.currentStopPending &&
        record.currentStopIntent === intent &&
        this.ownsLiveCurrent(record) &&
        after < intent.target.contextTimeSeconds &&
        Math.round(after * afterSampleRate) < intent.target.targetFrame
      );
    } catch {
      return false;
    }
  }

  private currentStopTargetIsFuture(
    record: CutoverRecord,
    intent: Readonly<FilePlaybackStopTransitionIntent>,
  ): boolean {
    try {
      const now = this.readContextTime(record.audioContext);
      const sampleRate = this.readContextSampleRate(record.audioContext);
      return (
        now < intent.target.contextTimeSeconds &&
        Math.round(now * sampleRate) < intent.target.targetFrame
      );
    } catch {
      return false;
    }
  }

  private cancelCurrentStop(record: CutoverRecord, error: unknown): void {
    this.clearCurrentStopTimer(record);
    if (!record.currentStopPending) return;
    record.currentStopPending = false;
    record.currentStopApplied?.reject(error);
  }

  private clearCurrentStopTimer(record: CutoverRecord): void {
    if (record.currentStopTimer === null) return;
    globalThis.clearTimeout(record.currentStopTimer);
    record.currentStopTimer = null;
  }

  private assertCurrentStopTransactionOwned(
    record: CutoverRecord,
    intent: Readonly<FilePlaybackStopTransitionIntent>,
    observedEpoch: number,
  ): void {
    if (
      observedEpoch !== this.cutoverEpoch ||
      !record.currentStopPending ||
      record.currentStopIntent !== intent ||
      !this.ownsLiveCurrent(record) ||
      !this.currentAuthorityAllows(record)
    ) {
      throw cutoverError('current stop lost native automation authority');
    }
  }

  private transitionSnapshotMatches(
    record: CutoverRecord,
    snapshot: FilePlaybackSourceSnapshot,
    state: Readonly<FilePlaybackTransitionIntent>['from'],
    expectedPhase?: FilePlaybackSourceSnapshot['phase'],
  ): boolean {
    const run = snapshot.run ? readPlaybackStateIdentity(snapshot.run) : null;
    return (
      snapshot.queueItemId === record.queueItemId &&
      snapshot.backend === record.backend &&
      run !== null &&
      run.queueItemId === state.queueItemId &&
      run.runId === state.runId &&
      run.revision === state.revision &&
      (expectedPhase === undefined || snapshot.phase === expectedPhase)
    );
  }

  private scheduleExactCutover(record: CutoverRecord, target: FilePlaybackCutoverTarget): void {
    const canonicalTarget = readFilePlaybackCutoverTarget(target, record.audioContext);
    const gate = record.gate;
    if (
      !canonicalTarget ||
      !gate ||
      canonicalTarget.audioContext !== gate.context ||
      !this.ownsLiveCandidate(record)
    ) {
      throw cutoverError('backend target does not use the candidate gate context');
    }
    const now = this.readContextTime(record.audioContext);
    if (now >= canonicalTarget.contextTimeSeconds) {
      throw cutoverError('backend target already passed before gate scheduling');
    }
    const previous = this.cutoverCurrent;
    if (previous && previous.audioContext !== canonicalTarget.audioContext) {
      throw cutoverError('current and candidate renderers use different AudioContexts');
    }
    const supersededStop = previous?.currentStopPending ? previous.currentStopIntent : null;
    if (
      supersededStop &&
      (record.armIntent === null ||
        record.armIntent.revision <= supersededStop.to.revision ||
        canonicalTarget.contextTimeSeconds >= supersededStop.target.contextTimeSeconds)
    ) {
      throw cutoverError('candidate does not precede a pending stop with a later revision');
    }

    // Mark the transaction before the first native mutation. A mocked/native
    // callback may synchronously retire the candidate from inside any
    // AudioParam call; retirement must then know that the old gate may already
    // contain a target-time mute even though the record is still finalizing.
    record.gatesScheduled = true;
    try {
      gate.gain.cancelScheduledValues(now);
      this.assertCutoverTransactionOwned(record);
      gate.gain.setValueAtTime(0, now);
      this.assertCutoverTransactionOwned(record);
      gate.gain.setValueAtTime(1, canonicalTarget.contextTimeSeconds);
      this.assertCutoverTransactionOwned(record);
      if (previous?.gate) {
        previous.gate.gain.cancelScheduledValues(now);
        this.assertCutoverTransactionOwned(record);
        previous.gate.gain.setValueAtTime(1, now);
        this.assertCutoverTransactionOwned(record);
        previous.gate.gain.setValueAtTime(0, canonicalTarget.contextTimeSeconds);
        this.assertCutoverTransactionOwned(record);
      }
      if (previous && supersededStop) {
        record.supersededCurrentStop = true;
        this.cancelCurrentStop(
          previous,
          cutoverError('a later renderer revision superseded the pending stop'),
        );
      }
    } catch (error) {
      if (this.readContextTime(record.audioContext) < canonicalTarget.contextTimeSeconds) {
        let rolledBack = this.rollbackScheduledGates(record);
        if (
          rolledBack &&
          previous &&
          supersededStop &&
          previous.currentStopPending &&
          this.currentStopTargetIsFuture(previous, supersededStop)
        ) {
          try {
            const restoreNow = this.readContextTime(previous.audioContext);
            this.scheduleCurrentStopGate(previous, supersededStop, this.cutoverEpoch, restoreNow);
          } catch {
            rolledBack = false;
          }
        }
        if (!rolledBack) {
          void this.enterFailSilent(record, 'gate-rollback-ambiguous');
        }
      } else {
        record.gatesScheduled = false;
        void this.enterFailSilent(record, 'gate-scheduling-crossed-target');
      }
      throw error;
    }
  }

  private rollbackScheduledGates(record: CutoverRecord): boolean {
    // Clear first so a re-entrant retirement from native automation does not
    // recursively attempt the same transaction rollback.
    record.gatesScheduled = false;
    const candidateSilenced = this.forceGate(record, 0);
    const previous = this.cutoverCurrent;
    const currentRestored = previous === null || previous === record || this.forceGate(previous, 1);
    return candidateSilenced && currentRestored;
  }

  private forceGate(record: CutoverRecord, value: 0 | 1): boolean {
    const gate = record.gate;
    if (!gate) return true;
    try {
      const now = this.readContextTime(record.audioContext);
      gate.gain.cancelScheduledValues(now);
      gate.gain.setValueAtTime(value, now);
      return true;
    } catch {
      // A candidate is disconnected below on ambiguity. For a current gate,
      // preserving native state is safer than attempting a second clock.
      return false;
    }
  }

  private retireCandidateRecord(record: CutoverRecord, _reason: string): Promise<void> {
    if (record.cleanupPromise) return record.cleanupPromise;
    if (this.cutoverCandidate !== record) return Promise.resolve();
    if (record.supersededCurrentStop) {
      return this.enterFailSilent(record, 'stop-superseding-candidate-retired');
    }
    const wasScheduled = record.gatesScheduled;
    if (wasScheduled && this.targetHasPassed(record)) {
      if (record.cleanupPromise) return record.cleanupPromise;
      if (this.cutoverCandidate !== record) return Promise.resolve();
      return this.enterFailSilent(record, 'retire-after-target');
    }
    if (record.cleanupPromise) return record.cleanupPromise;
    if (this.cutoverCandidate !== record) return Promise.resolve();
    this.cutoverCandidate = null;
    record.revoked = true;
    record.phase = 'retiring';
    this.cutoverEpoch += 1;
    if (wasScheduled && !this.rollbackScheduledGates(record)) {
      // Reinstall the candidate slot just for fail-silent ownership. The
      // rollback proved the old gate cannot be trusted, so preserving it as a
      // current renderer would create a delayed mute at the old target.
      this.cutoverCandidate = record;
      record.revoked = false;
      record.phase = 'scheduled';
      return this.enterFailSilent(record, 'candidate-retire-rollback-ambiguous');
    }
    this.forceGate(record, 0);
    this.disconnectGate(record);
    return this.bindTerminalCutoverCleanup(record, this.destroyIfUnowned(record.state));
  }

  private retireCurrentRecord(record: CutoverRecord): Promise<void> {
    if (record.cleanupPromise) return record.cleanupPromise;
    if (this.cutoverCurrent !== record) return Promise.resolve();
    this.cancelCurrentStop(
      record,
      cutoverError('current renderer was retired before stop evidence'),
    );
    if (this.cutoverCurrent === record) this.cutoverCurrent = null;
    record.revoked = true;
    record.phase = 'retiring';
    this.cutoverEpoch += 1;
    this.forceGate(record, 0);
    this.disconnectGate(record);
    return this.bindTerminalCutoverCleanup(record, this.destroyIfUnowned(record.state));
  }

  private enterFailSilent(record: CutoverRecord, _reason: string): Promise<void> {
    if (record.cleanupPromise) return record.cleanupPromise;
    if (this.cutoverCandidate !== record && this.cutoverCurrent !== record) {
      return Promise.resolve();
    }
    const states = new Set<ManagedSource>();
    const candidate = this.cutoverCandidate;
    const current = this.cutoverCurrent;
    this.cutoverCandidate = null;
    this.cutoverCurrent = null;
    this.cutoverEpoch += 1;
    this.recoveryRequired = true;
    if (candidate) {
      this.cancelCurrentStop(candidate, cutoverError('renderer entered fail-silent mode'));
      candidate.gatesScheduled = false;
      candidate.revoked = true;
      candidate.phase = 'failed';
      this.forceGate(candidate, 0);
      this.disconnectGate(candidate);
      states.add(candidate.state);
    }
    if (current) {
      this.cancelCurrentStop(current, cutoverError('renderer entered fail-silent mode'));
      current.gatesScheduled = false;
      current.revoked = true;
      current.phase = 'failed';
      this.forceGate(current, 0);
      this.disconnectGate(current);
      states.add(current.state);
    }
    if (!candidate && record !== current) {
      this.cancelCurrentStop(record, cutoverError('renderer entered fail-silent mode'));
      record.gatesScheduled = false;
      record.revoked = true;
      record.phase = 'failed';
      this.forceGate(record, 0);
      this.disconnectGate(record);
      states.add(record.state);
    }
    const cleanup = Promise.all([...states].map((state) => this.destroyIfUnowned(state))).then(
      () => undefined,
    );
    const records = new Set<CutoverRecord>();
    if (candidate) records.add(candidate);
    if (current) records.add(current);
    records.add(record);
    for (const terminalRecord of records) {
      this.bindTerminalCutoverCleanup(terminalRecord, cleanup);
    }
    return record.cleanupPromise ?? cleanup;
  }

  /**
   * Keeps a capability resolvable only until its terminal native cleanup has
   * settled. Deleting after (rather than before) cleanup preserves the exact
   * in-flight retirement promise and stale-call behavior while ensuring an
   * externally retained opaque port cannot retain its source indefinitely.
   */
  private bindTerminalCutoverCleanup(record: CutoverRecord, cleanup: Promise<void>): Promise<void> {
    if (record.cleanupPromise) return record.cleanupPromise;
    const terminalCleanup = cleanup.finally(() => {
      if (
        record.cleanupPromise === terminalCleanup &&
        record.revoked &&
        this.cutoverCandidate !== record &&
        this.cutoverCurrent !== record
      ) {
        this.cutoverPorts.delete(record.port);
      }
    });
    record.cleanupPromise = terminalCleanup;
    this.trackCutoverCleanup(terminalCleanup);
    return terminalCleanup;
  }

  private trackCutoverCleanup(cleanup: Promise<void>): void {
    this.cutoverRetirementBarrier = Promise.all([this.cutoverRetirementBarrier, cleanup]).then(
      () => undefined,
    );
  }

  private async waitForCutoverRetirements(): Promise<void> {
    for (;;) {
      const barrier = this.cutoverRetirementBarrier;
      await barrier;
      if (barrier === this.cutoverRetirementBarrier) return;
    }
  }

  private targetHasPassed(record: CutoverRecord): boolean {
    if (record.target === null) return false;
    try {
      return record.audioContext.currentTime >= record.target.contextTimeSeconds;
    } catch {
      return true;
    }
  }

  private assertCutoverTransactionOwned(record: CutoverRecord): void {
    if (!this.ownsLiveCandidate(record)) {
      throw cutoverError('candidate was revoked during gate automation');
    }
  }

  private disconnectGate(record: CutoverRecord): void {
    const gate = record.gate;
    if (!gate) return;
    try {
      gate.disconnect();
    } catch {
      // Native cleanup is best effort and source destruction remains idempotent.
    }
  }

  private audioContextForDestination(destination: AudioNode): AudioContext | null {
    try {
      const context = destination.context;
      if (
        !context ||
        typeof context.createGain !== 'function' ||
        typeof context.currentTime !== 'number' ||
        !Number.isFinite(context.currentTime)
      ) {
        return null;
      }
      return context as AudioContext;
    } catch {
      return null;
    }
  }

  private readContextTime(audioContext: AudioContext): number {
    const now = audioContext.currentTime;
    if (!Number.isFinite(now) || now < 0) throw cutoverError('AudioContext time is invalid');
    return now;
  }

  private readContextSampleRate(audioContext: AudioContext): number {
    const sampleRate = audioContext.sampleRate;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1_000_000) {
      throw cutoverError('AudioContext sample rate is invalid');
    }
    return sampleRate;
  }

  private readMonotonicTimeMs(): number {
    const now = globalThis.performance.now();
    if (!Number.isFinite(now) || now < 0) throw cutoverError('monotonic clock is invalid');
    return now;
  }

  private audioContextIsRunning(audioContext: AudioContext): boolean {
    try {
      return audioContext.state === 'running';
    } catch {
      return false;
    }
  }

  private ownsLiveCandidate(record: CutoverRecord): boolean {
    return this.cutoverCandidate === record && !record.revoked && !record.state.destroyed;
  }

  private ownsLiveCurrent(record: CutoverRecord): boolean {
    return (
      this.cutoverCurrent === record &&
      record.phase === 'current' &&
      !record.revoked &&
      !record.state.destroyed
    );
  }

  private ownsRetryableCutoverRecord(record: CutoverRecord): boolean {
    return (
      !record.revoked &&
      !record.state.destroyed &&
      (this.cutoverCandidate === record || this.cutoverCurrent === record)
    );
  }

  private hasLegacyOwnership(): boolean {
    return (
      this.active !== null ||
      this.standby !== null ||
      this.pendingActive !== null ||
      this.pendingStandby !== null
    );
  }

  private hasCutoverOwnership(): boolean {
    return (
      this.cutoverStageReservations.size > 0 ||
      this.cutoverCandidate !== null ||
      this.cutoverCurrent !== null
    );
  }

  private async rejectCutoverStageDuringLegacy(
    source: FilePlaybackCutoverSource,
  ): Promise<FilePlaybackCutoverCandidatePort> {
    const state = await this.adoptCutoverSource(source);
    await this.destroyIfUnowned(state);
    throw cutoverError('legacy playback slots must be retired before staging a cutover renderer');
  }

  /**
   * A native staging Promise is the public ownership-transfer boundary. If the
   * first source snapshot cannot even create manager state, settle destruction
   * before rejecting so callers must never guess whether ownership transferred.
   */
  private async adoptCutoverSource(source: FilePlaybackCutoverSource): Promise<ManagedSource> {
    try {
      return this.stateFor(source);
    } catch (error) {
      try {
        await Promise.resolve(source.destroy());
      } catch {
        // The original adoption failure remains authoritative.
      }
      throw error;
    }
  }

  private authorityAllows(record: CutoverRecord): boolean {
    if (!this.ownsLiveCandidate(record)) return false;
    if (record.authorityError.present) return false;
    const epoch = this.cutoverEpoch;
    if (record.authority !== null) {
      try {
        if (!record.authority()) return false;
      } catch (error) {
        record.authorityError = { present: true, error };
        return false;
      }
    }
    return epoch === this.cutoverEpoch && this.ownsLiveCandidate(record);
  }

  private currentAuthorityAllows(record: CutoverRecord): boolean {
    if (!this.ownsLiveCurrent(record) || record.authorityError.present) return false;
    const epoch = this.cutoverEpoch;
    if (record.authority !== null) {
      try {
        if (!record.authority()) return false;
      } catch (error) {
        record.authorityError = { present: true, error };
        return false;
      }
    }
    return epoch === this.cutoverEpoch && this.ownsLiveCurrent(record);
  }

  private detachedAuthorityError: AuthorityError = { present: false };

  private detachedAuthorityAllows(authority: FilePlaybackActivationAuthority | null): boolean {
    this.detachedAuthorityError = { present: false };
    if (authority === null) return true;
    const epoch = this.cutoverEpoch;
    try {
      if (!authority()) return false;
    } catch (error) {
      this.detachedAuthorityError = { present: true, error };
      return false;
    }
    return epoch === this.cutoverEpoch;
  }

  private authorityOrStaleError(record: CutoverRecord): unknown {
    return record.authorityError.present
      ? record.authorityError.error
      : cutoverError('candidate authority expired or was superseded');
  }

  private rejectedAuthorityPromise<T>(record: CutoverRecord): Promise<T> {
    return Promise.reject(this.authorityOrStaleError(record));
  }

  private async runStandby(operation: PendingStandbyOperation): Promise<FilePlaybackPublication> {
    const { state } = operation;
    const outcome = await waitForOperation(operation, this.prepareOnce(state));
    if (outcome.kind === 'cancelled') {
      await this.destroyIfUnowned(state);
      return this.unpublished(state, 'superseded');
    }
    if (outcome.kind === 'error') {
      if (this.pendingStandby !== operation || state.destroyed) {
        await this.destroyIfUnowned(state);
        return this.unpublished(state, 'superseded');
      }
      this.pendingStandby = null;
      await this.destroyState(state);
      throw outcome.error;
    }

    if (
      this.pendingStandby !== operation ||
      state.destroyed ||
      this.discardedQueueItems.has(state.source.queueItemId)
    ) {
      await this.destroyIfUnowned(state);
      return this.unpublished(state, 'superseded');
    }

    if (
      this.active?.queueItemId === state.source.queueItemId ||
      this.pendingActive?.state.source.queueItemId === state.source.queueItemId
    ) {
      const duplicatesPublishedActive = this.active?.queueItemId === state.source.queueItemId;
      this.pendingStandby = null;
      await this.destroyIfUnowned(state);
      return this.unpublished(
        state,
        duplicatesPublishedActive ? 'duplicates-active' : 'superseded',
      );
    }

    const previous = this.standby;
    this.standby = state.source;
    if (previous && previous !== state.source) {
      await this.destroyIfUnowned(this.stateFor(previous));
    }

    if (
      this.pendingStandby !== operation ||
      this.standby !== state.source ||
      state.destroyed ||
      this.discardedQueueItems.has(state.source.queueItemId)
    ) {
      await this.destroyIfUnowned(state);
      return this.unpublished(state, 'superseded');
    }

    this.pendingStandby = null;
    return { published: true, snapshot: this.snapshotOf(state) };
  }

  private async runActive(operation: PendingActiveOperation): Promise<FilePlaybackPublication> {
    const { state } = operation;
    const prepared = await waitForOperation(operation, this.prepareOnce(state));
    const preparedFailure = await this.handleActiveOutcome(operation, prepared);
    if (preparedFailure) return preparedFailure;

    const connected = await waitForOperation(
      operation,
      this.connectAndRemember(state, operation.destination),
    );
    const connectedFailure = await this.handleActiveOutcome(operation, connected);
    if (connectedFailure) return connectedFailure;

    if (!this.canPublishActive(operation)) {
      return this.supersedeActive(operation);
    }

    const previousActive = this.active;
    const duplicateStandby =
      this.standby?.queueItemId === state.source.queueItemId ? this.standby : null;
    const duplicatePendingStandby =
      this.pendingStandby?.state.source.queueItemId === state.source.queueItemId
        ? this.pendingStandby
        : null;

    // Re-check at the literal commit boundary. In particular, no previous
    // active source has been detached or destroyed before this guard passes.
    if (!this.canPublishActive(operation)) {
      return this.supersedeActive(operation);
    }
    this.active = state.source;
    if (duplicateStandby) this.standby = null;
    if (duplicatePendingStandby) {
      this.pendingStandby = null;
      duplicatePendingStandby.cancel();
    }

    const cleanupStates = new Set<ManagedSource>();
    if (previousActive && previousActive !== state.source) {
      cleanupStates.add(this.stateFor(previousActive));
    }
    if (duplicateStandby && duplicateStandby !== state.source) {
      cleanupStates.add(this.stateFor(duplicateStandby));
    }
    if (duplicatePendingStandby && duplicatePendingStandby.state !== state) {
      cleanupStates.add(duplicatePendingStandby.state);
    }
    await Promise.all([...cleanupStates].map((candidate) => this.destroyIfUnowned(candidate)));

    // Authority was committed at the swap above. If it changes while old
    // native objects finish retiring, the caller performs exact-source stale
    // cleanup after this published result; do not leave this slot pending.
    if (
      this.pendingActive !== operation ||
      this.active !== state.source ||
      state.destroyed ||
      this.discardedQueueItems.has(state.source.queueItemId)
    ) {
      await this.destroyIfUnowned(state);
      return this.unpublished(state, 'superseded');
    }

    this.pendingActive = null;
    return { published: true, snapshot: this.snapshotOf(state) };
  }

  private async handleActiveOutcome<T>(
    operation: PendingActiveOperation,
    outcome: PendingOutcome<T>,
  ): Promise<FilePlaybackPublication | null> {
    if (outcome.kind === 'value' && this.canPublishActive(operation)) return null;
    if (
      outcome.kind === 'error' &&
      this.pendingActive === operation &&
      !operation.state.destroyed
    ) {
      this.pendingActive = null;
      await this.destroyState(operation.state);
      throw outcome.error;
    }
    return this.supersedeActive(operation);
  }

  private canPublishActive(operation: PendingActiveOperation): boolean {
    const ownsPendingSlot = (): boolean =>
      this.pendingActive === operation &&
      !operation.state.destroyed &&
      !this.discardedQueueItems.has(operation.state.source.queueItemId);

    if (!ownsPendingSlot()) return false;
    if (operation.authorityError.present) return false;
    if (operation.authority !== null) {
      try {
        if (!operation.authority()) return false;
      } catch (error) {
        // Preserve even `throw undefined` without allowing the asynchronous
        // activation operation to remain installed in pendingActive.
        operation.authorityError = { present: true, error };
        return false;
      }
    }
    // Authority callbacks are caller code and may be re-entrant. Re-check
    // manager ownership after invoking one before authorizing the swap.
    return ownsPendingSlot();
  }

  private async supersedeActive(
    operation: PendingActiveOperation,
  ): Promise<FilePlaybackPublication> {
    const authorityError = operation.authorityError;
    if (this.pendingActive === operation) {
      this.pendingActive = null;
      operation.cancel();
    }
    await this.destroyIfUnowned(operation.state);
    if (authorityError.present) throw authorityError.error;
    return this.unpublished(operation.state, 'superseded');
  }

  private stateFor(source: FilePlaybackSource): ManagedSource {
    const existing = this.sourceStates.get(source);
    if (existing) return existing;
    const state: ManagedSource = {
      source,
      preparePromise: null,
      destroyPromise: null,
      destroyed: false,
      lastSnapshot: createFilePlaybackSourceSnapshot(source.getSnapshot()),
    };
    this.sourceStates.set(source, state);
    return state;
  }

  private snapshotOf(state: ManagedSource): FilePlaybackSourceSnapshot {
    if (!state.destroyed) {
      try {
        state.lastSnapshot = createFilePlaybackSourceSnapshot(state.source.getSnapshot());
      } catch {
        // Preserve the last valid snapshot if a failed backend cannot report.
      }
    }
    return state.lastSnapshot;
  }

  private prepareOnce(state: ManagedSource): Promise<FilePlaybackSourceSnapshot> {
    if (state.preparePromise) return state.preparePromise;
    const current = this.snapshotOf(state);
    if (current.phase !== 'new' && current.phase !== 'preparing') {
      state.preparePromise = Promise.resolve(current);
      return state.preparePromise;
    }
    try {
      state.preparePromise = Promise.resolve(state.source.prepare()).then((snapshot) => {
        const canonical = createFilePlaybackSourceSnapshot(snapshot);
        state.lastSnapshot = canonical;
        return canonical;
      });
    } catch (error) {
      state.preparePromise = Promise.reject(error);
    }
    return state.preparePromise;
  }

  private async connectAndRemember(
    state: ManagedSource,
    destination: AudioNode,
  ): Promise<FilePlaybackSourceSnapshot> {
    const snapshot = await state.source.connect(destination);
    const canonical = createFilePlaybackSourceSnapshot(snapshot);
    state.lastSnapshot = canonical;
    return canonical;
  }

  private owns(state: ManagedSource): boolean {
    return (
      this.active === state.source ||
      this.standby === state.source ||
      this.pendingActive?.state === state ||
      this.pendingStandby?.state === state ||
      this.cutoverCurrent?.state === state ||
      this.cutoverCandidate?.state === state
    );
  }

  private destroyIfUnowned(state: ManagedSource): Promise<void> {
    return this.owns(state) ? Promise.resolve() : this.destroyState(state);
  }

  private destroyState(state: ManagedSource): Promise<void> {
    if (state.destroyPromise) return state.destroyPromise;
    state.destroyed = true;

    let finish!: () => void;
    state.destroyPromise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      Promise.resolve(state.source.destroy()).then(finish, finish);
    } catch {
      finish();
    }
    return state.destroyPromise;
  }

  private rejectDuplicateOfActive(state: ManagedSource): Promise<FilePlaybackPublication> {
    if (this.active === state.source) {
      return Promise.resolve(this.unpublished(state, 'duplicates-active'));
    }
    return this.rejectAndDestroy(state, 'duplicates-active');
  }

  private async rejectAndDestroy(
    state: ManagedSource,
    reason: 'superseded' | 'duplicates-active',
  ): Promise<FilePlaybackPublication> {
    const publication = this.unpublished(state, reason);
    await this.destroyIfUnowned(state);
    return publication;
  }

  private unpublished(
    state: ManagedSource,
    reason: 'superseded' | 'duplicates-active',
  ): FilePlaybackPublication {
    return { published: false, reason, snapshot: this.snapshotOf(state) };
  }
}

/**
 * Verifies the exact module-created manager object without invoking any value
 * property or accepting subclasses/transparent Proxies. Adapter capabilities
 * use this boundary before retaining a manager as native playback authority.
 */
export function isExactFilePlaybackManager(value: unknown): value is FilePlaybackManager {
  try {
    if (value === null || typeof value !== 'object') return false;
    if (!EXACT_FILE_PLAYBACK_MANAGERS.has(value)) return false;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== FilePlaybackManager.prototype) return false;
    const constructorDescriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    return (
      constructorDescriptor !== undefined &&
      Object.hasOwn(constructorDescriptor, 'value') &&
      constructorDescriptor.value === FilePlaybackManager &&
      constructorDescriptor.get === undefined &&
      constructorDescriptor.set === undefined
    );
  } catch {
    return false;
  }
}

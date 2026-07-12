import type { QueueItemId } from '../types/index.ts';
import {
  readFilePlaybackCancelIntent,
  readFilePlaybackCutoverTarget,
  readFilePlaybackStartEvidence,
  type FilePlaybackCancelIntent,
  type FilePlaybackCutoverTarget,
  type FilePlaybackStartEvidence,
} from './file-playback-source.ts';
import {
  FilePlaybackManager,
  isExactFilePlaybackManager,
  type FilePlaybackCutoverCandidatePort,
} from './file-playback-manager.ts';
import {
  readPlaybackAttemptIdentity,
  sameAttempt,
  type PlaybackAttemptIdentity,
} from './playback-identity.ts';
import {
  readRendezvousArmIntent,
  readRendezvousArmReceipt,
  readRendezvousFinalizeIntent,
  readRendezvousFinalizeReceipt,
  validateRendezvousArmReceipt,
  validateRendezvousFinalizeReceipt,
  type RendezvousArmIntent,
  type RendezvousArmReceipt,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
} from './rendezvous-contract.ts';
import type { HostRendezvousParticipant } from './rendezvous-coordinator.ts';

const MAX_IDENTIFIER_LENGTH = 256;
const FALLBACK_QUEUE_ITEM_ID = 'invalid-queue-item' as QueueItemId;
const OPTIONS_KEYS = Object.freeze([
  'participantId',
  'rttP95Ms',
  'armP95Ms',
  'manager',
  'candidatePort',
] as const);
const ARM_RESULT_KEYS = Object.freeze(['status', 'receipt', 'target', 'started'] as const);
const FINALIZATION_KEYS = Object.freeze(['receipt', 'target', 'started'] as const);
const TRUSTED_REFLECT_APPLY = Reflect.apply;
const TRUSTED_PROMISE = Promise;
const TRUSTED_PROMISE_PROTOTYPE = Promise.prototype;
const TRUSTED_PROMISE_THEN = Promise.prototype.then;
const TRUSTED_MANAGER_ARM_CANDIDATE = FilePlaybackManager.prototype.armCutoverCandidate;
const TRUSTED_MANAGER_FINALIZE_CANDIDATE = FilePlaybackManager.prototype.finalizeCutoverCandidate;
const TRUSTED_MANAGER_CURRENT_PORT = FilePlaybackManager.prototype.currentCutoverPort;
const TRUSTED_MANAGER_RETIRE_CANDIDATE = FilePlaybackManager.prototype.retireCutoverCandidate;
const TRUSTED_MANAGER_RETIRE_CURRENT = FilePlaybackManager.prototype.retireCurrentCutover;

export interface ManagerCutoverRendezvousParticipantOptions {
  readonly participantId: string;
  readonly rttP95Ms: number;
  readonly armP95Ms: number;
  readonly manager: FilePlaybackManager;
  readonly candidatePort: FilePlaybackCutoverCandidatePort;
}

interface AttemptOperation {
  readonly intent: Readonly<RendezvousArmIntent>;
  readonly armPromise: Promise<RendezvousArmReceipt>;
  readonly startedPromise: Promise<FilePlaybackStartEvidence>;
  readonly resolveStarted: (evidence: FilePlaybackStartEvidence) => void;
  readonly rejectStarted: (error: Error) => void;
  armAccepted: boolean;
  armTarget: FilePlaybackCutoverTarget | null;
  finalizeIntent: Readonly<RendezvousFinalizeIntent> | null;
  finalizePromise: Promise<RendezvousFinalizeReceipt> | null;
  finalizeAccepted: boolean;
  startedSettled: boolean;
  startObserved: boolean;
  committed: boolean;
  retired: boolean;
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

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = new Set(expectedKeys);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expected.size ||
      keys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function createStartedDeferred(): {
  readonly promise: Promise<FilePlaybackStartEvidence>;
  readonly resolve: (evidence: FilePlaybackStartEvidence) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: (evidence: FilePlaybackStartEvidence) => void;
  let reject!: (error: Error) => void;
  const promise = new TRUSTED_PROMISE<FilePlaybackStartEvidence>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  return { promise, resolve, reject };
}

function sameArmIntent(left: RendezvousArmIntent, right: RendezvousArmIntent): boolean {
  return (
    sameAttempt(left, right) &&
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
    sameAttempt(left, right) &&
    left.recipientId === right.recipientId &&
    left.startAtRoomTimeMs === right.startAtRoomTimeMs &&
    left.finalizedAtRoomTimeMs === right.finalizedAtRoomTimeMs
  );
}

function finalizeMatchesArm(arm: RendezvousArmIntent, finalize: RendezvousFinalizeIntent): boolean {
  return (
    sameAttempt(arm, finalize) &&
    arm.recipientId === finalize.recipientId &&
    arm.startAtRoomTimeMs === finalize.startAtRoomTimeMs
  );
}

function observeRejectedPromise(value: Promise<unknown>): void {
  try {
    TRUSTED_REFLECT_APPLY(TRUSTED_PROMISE_THEN, value, [() => undefined, () => undefined]);
  } catch {
    // Hostile promise lookalikes are rejected by the owning operation.
  }
}

function readNativePromise(value: unknown): Promise<unknown> | null {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Reflect.getPrototypeOf(value) !== TRUSTED_PROMISE_PROTOTYPE ||
      Object.getOwnPropertyDescriptor(value, 'constructor') !== undefined
    ) {
      return null;
    }
    const constructorDescriptor = Object.getOwnPropertyDescriptor(
      TRUSTED_PROMISE_PROTOTYPE,
      'constructor',
    );
    if (
      !constructorDescriptor ||
      !Object.hasOwn(constructorDescriptor, 'value') ||
      constructorDescriptor.value !== TRUSTED_PROMISE
    ) {
      return null;
    }
    TRUSTED_REFLECT_APPLY(TRUSTED_PROMISE_THEN, value, [() => undefined, () => undefined]);
    return value as Promise<unknown>;
  } catch {
    return null;
  }
}

function readLocalCutoverTarget(value: unknown) {
  const snapshot = snapshotExactDataRecord(value, [
    'audioContext',
    'contextTimeSeconds',
    'targetFrame',
  ]);
  if (
    snapshot === null ||
    snapshot.audioContext === null ||
    typeof snapshot.audioContext !== 'object'
  ) {
    return null;
  }
  return readFilePlaybackCutoverTarget(value, snapshot.audioContext as AudioContext);
}

/**
 * One-shot rendezvous capability for one manager-owned silent candidate.
 * Native sources remain private to FilePlaybackManager; this adapter only
 * correlates immutable attempt identities with the opaque candidate port.
 */
export class ManagerCutoverRendezvousParticipant implements HostRendezvousParticipant {
  declare readonly participantId: string;
  declare readonly rttP95Ms: number;
  declare readonly armP95Ms: number;

  readonly #manager: FilePlaybackManager;
  readonly #candidatePort: FilePlaybackCutoverCandidatePort;
  #attempt: AttemptOperation | null = null;
  #retirementPromise: Promise<void> | null = null;

  constructor(options: ManagerCutoverRendezvousParticipantOptions) {
    const canonical = snapshotExactDataRecord(options, OPTIONS_KEYS);
    if (canonical === null) {
      throw new TypeError('Manager cutover participant options must be exact own data');
    }
    if (!isBoundedIdentifier(canonical.participantId)) {
      throw new TypeError('participantId must be a bounded identifier');
    }
    if (!isFiniteNonNegative(canonical.rttP95Ms)) {
      throw new RangeError('rttP95Ms must be finite and non-negative');
    }
    if (!isFiniteNonNegative(canonical.armP95Ms)) {
      throw new RangeError('armP95Ms must be finite and non-negative');
    }
    if (!isExactFilePlaybackManager(canonical.manager)) {
      throw new TypeError('manager must be a FilePlaybackManager');
    }
    if (
      canonical.candidatePort === null ||
      (typeof canonical.candidatePort !== 'object' && typeof canonical.candidatePort !== 'function')
    ) {
      throw new TypeError('candidatePort must be an opaque manager capability');
    }

    Object.defineProperties(this, {
      participantId: {
        value: canonical.participantId,
        enumerable: true,
        writable: false,
        configurable: false,
      },
      rttP95Ms: {
        value: canonical.rttP95Ms,
        enumerable: true,
        writable: false,
        configurable: false,
      },
      armP95Ms: {
        value: canonical.armP95Ms,
        enumerable: true,
        writable: false,
        configurable: false,
      },
    });
    this.#manager = canonical.manager;
    this.#candidatePort = canonical.candidatePort as FilePlaybackCutoverCandidatePort;
    Object.preventExtensions(this);
  }

  arm(value: RendezvousArmIntent): Promise<RendezvousArmReceipt> {
    const intent = readRendezvousArmIntent(value);
    if (intent === null) return Promise.resolve(this.#rejectedArm(null, 'invalid-arm-intent'));
    if (intent.recipientId !== this.participantId) {
      return Promise.resolve(this.#rejectedArm(intent, 'cutover-participant-mismatch'));
    }

    const existing = this.#attempt;
    if (existing !== null) {
      if (sameArmIntent(existing.intent, intent)) {
        return existing.retired && existing.armAccepted
          ? Promise.resolve(this.#rejectedArm(intent, 'cutover-attempt-retired'))
          : existing.armPromise;
      }
      if (!existing.committed && !existing.retired) void this.#retire(existing);
      return Promise.resolve(
        this.#rejectedArm(
          intent,
          existing.committed ? 'cutover-port-already-committed' : 'cutover-attempt-superseded',
        ),
      );
    }

    const started = createStartedDeferred();
    const operation: AttemptOperation = {
      intent,
      armPromise: Promise.resolve().then(() => this.#executeArm(operation)),
      startedPromise: started.promise,
      resolveStarted: started.resolve,
      rejectStarted: started.reject,
      armAccepted: false,
      armTarget: null,
      finalizeIntent: null,
      finalizePromise: null,
      finalizeAccepted: false,
      startedSettled: false,
      startObserved: false,
      committed: false,
      retired: false,
    };
    this.#attempt = operation;
    observeRejectedPromise(operation.startedPromise);
    return operation.armPromise;
  }

  finalize(value: RendezvousFinalizeIntent): Promise<RendezvousFinalizeReceipt> {
    const intent = readRendezvousFinalizeIntent(value);
    if (intent === null) {
      return Promise.resolve(this.#rejectedFinalize(null, 'invalid-finalize-intent'));
    }
    if (intent.recipientId !== this.participantId) {
      return Promise.resolve(this.#rejectedFinalize(intent, 'cutover-participant-mismatch'));
    }
    const operation = this.#attempt;
    if (
      operation !== null &&
      operation.finalizeIntent !== null &&
      sameFinalizeIntent(operation.finalizeIntent, intent) &&
      operation.finalizePromise !== null
    ) {
      return operation.retired && operation.finalizeAccepted
        ? Promise.resolve(this.#rejectedFinalize(intent, 'cutover-attempt-retired'))
        : operation.finalizePromise;
    }
    if (
      operation === null ||
      operation.retired ||
      !operation.armAccepted ||
      !finalizeMatchesArm(operation.intent, intent)
    ) {
      return Promise.resolve(this.#rejectedFinalize(intent, 'cutover-attempt-not-armed'));
    }
    if (operation.finalizeIntent !== null) {
      void this.#retire(operation);
      return Promise.resolve(this.#rejectedFinalize(intent, 'cutover-finalize-conflict'));
    }

    operation.finalizeIntent = intent;
    operation.finalizePromise = Promise.resolve().then(() =>
      this.#executeFinalize(operation, intent),
    );
    return operation.finalizePromise;
  }

  started(value: PlaybackAttemptIdentity): Promise<FilePlaybackStartEvidence> {
    const identity = readPlaybackAttemptIdentity(value);
    const operation = this.#attempt;
    if (identity === null || operation === null || !sameAttempt(operation.intent, identity)) {
      return Promise.reject(new Error('Cutover start evidence is unavailable for this attempt'));
    }
    return operation.startedPromise;
  }

  commitAttempt(value: PlaybackAttemptIdentity): boolean {
    const identity = readPlaybackAttemptIdentity(value);
    const operation = this.#attempt;
    if (identity === null || operation === null || !sameAttempt(operation.intent, identity)) {
      return false;
    }
    if (operation.committed) return true;
    if (operation.retired || !operation.finalizeAccepted || !operation.startObserved) {
      return false;
    }
    let current: FilePlaybackCutoverCandidatePort | null;
    try {
      current = TRUSTED_REFLECT_APPLY(TRUSTED_MANAGER_CURRENT_PORT, this.#manager, []);
    } catch {
      void this.#retire(operation);
      return false;
    }
    if (
      current !== this.#candidatePort ||
      this.#attempt !== operation ||
      operation.retired ||
      !operation.finalizeAccepted ||
      !operation.startObserved
    ) {
      void this.#retire(operation);
      return false;
    }
    operation.committed = true;
    return true;
  }

  cancel(value: FilePlaybackCancelIntent): Promise<void> {
    const intent = readFilePlaybackCancelIntent(value);
    const operation = this.#attempt;
    if (intent === null || operation === null || !sameAttempt(operation.intent, intent)) {
      return Promise.resolve();
    }
    if (operation.committed) return Promise.resolve();
    return this.#retire(operation);
  }

  async #executeArm(operation: AttemptOperation): Promise<RendezvousArmReceipt> {
    if (this.#attempt !== operation || operation.retired) {
      return this.#rejectedArm(operation.intent, 'cutover-attempt-retired');
    }
    let value: unknown;
    try {
      value = await TRUSTED_REFLECT_APPLY(TRUSTED_MANAGER_ARM_CANDIDATE, this.#manager, [
        this.#candidatePort,
        operation.intent,
      ]);
    } catch {
      if (operation.retired) {
        return this.#rejectedArm(operation.intent, 'cutover-attempt-retired');
      }
      void this.#retire(operation);
      return this.#rejectedArm(operation.intent, 'cutover-manager-arm-failed');
    }
    if (this.#attempt !== operation || operation.retired) {
      return this.#rejectedArm(operation.intent, 'cutover-attempt-retired');
    }
    const result = snapshotExactDataRecord(value, ARM_RESULT_KEYS);
    const receipt = result ? readRendezvousArmReceipt(result.receipt) : null;
    if (this.#attempt !== operation || operation.retired) {
      return this.#rejectedArm(operation.intent, 'cutover-attempt-retired');
    }
    const exactReceipt =
      receipt !== null &&
      sameAttempt(operation.intent, receipt) &&
      receipt.participantId === this.participantId;
    const armTarget = result ? readLocalCutoverTarget(result.target) : null;
    const started = result ? readNativePromise(result.started) : null;
    const armedResult =
      result?.status === 'armed' &&
      exactReceipt &&
      receipt.status === 'armed' &&
      validateRendezvousArmReceipt(operation.intent, receipt).ok &&
      armTarget !== null &&
      started !== null;
    const rejectedResult =
      result?.status === 'rejected' &&
      exactReceipt &&
      receipt.status === 'rejected' &&
      result.target === null &&
      result.started === null;
    if (!armedResult && !rejectedResult) {
      void this.#retire(operation);
      return this.#rejectedArm(operation.intent, 'cutover-manager-invalid-arm-result');
    }
    if (rejectedResult) {
      void this.#retire(operation);
      return receipt;
    }
    if (this.#attempt !== operation || operation.retired) {
      return this.#rejectedArm(operation.intent, 'cutover-attempt-retired');
    }
    operation.armAccepted = true;
    operation.armTarget = armTarget;
    return receipt;
  }

  async #executeFinalize(
    operation: AttemptOperation,
    intent: Readonly<RendezvousFinalizeIntent>,
  ): Promise<RendezvousFinalizeReceipt> {
    if (this.#attempt !== operation || operation.retired) {
      return this.#rejectedFinalize(intent, 'cutover-attempt-retired');
    }
    let value: unknown;
    try {
      value = await TRUSTED_REFLECT_APPLY(TRUSTED_MANAGER_FINALIZE_CANDIDATE, this.#manager, [
        this.#candidatePort,
        intent,
      ]);
    } catch {
      if (operation.retired) {
        return this.#rejectedFinalize(intent, 'cutover-attempt-retired');
      }
      void this.#retire(operation);
      return this.#rejectedFinalize(intent, 'cutover-manager-finalize-failed');
    }
    if (this.#attempt !== operation || operation.retired) {
      return this.#rejectedFinalize(intent, 'cutover-attempt-retired');
    }
    const result = snapshotExactDataRecord(value, FINALIZATION_KEYS);
    const receipt = result ? readRendezvousFinalizeReceipt(result.receipt) : null;
    const target = result ? readLocalCutoverTarget(result.target) : null;
    const started = result ? readNativePromise(result.started) : null;
    const armTarget = operation.armTarget;
    if (
      this.#attempt !== operation ||
      operation.retired ||
      receipt === null ||
      !sameAttempt(intent, receipt) ||
      receipt.participantId !== this.participantId ||
      !validateRendezvousFinalizeReceipt(intent, receipt).ok ||
      armTarget === null ||
      target === null ||
      target.audioContext !== armTarget.audioContext ||
      target.contextTimeSeconds !== armTarget.contextTimeSeconds ||
      target.targetFrame !== armTarget.targetFrame ||
      started === null
    ) {
      if (!operation.retired) void this.#retire(operation);
      return this.#rejectedFinalize(intent, 'cutover-manager-invalid-finalize-result');
    }

    operation.finalizeAccepted = true;
    this.#observeStart(operation, target.targetFrame, started);
    if (this.#attempt !== operation || operation.retired) {
      return this.#rejectedFinalize(intent, 'cutover-attempt-retired');
    }
    return receipt;
  }

  #observeStart(
    operation: AttemptOperation,
    targetFrame: number,
    sourceStarted: Promise<unknown>,
  ): void {
    try {
      TRUSTED_REFLECT_APPLY(TRUSTED_PROMISE_THEN, sourceStarted, [
        (value: unknown) => {
          const evidence = readFilePlaybackStartEvidence(value, targetFrame);
          if (evidence === null || this.#attempt !== operation || operation.retired) {
            this.#rejectStarted(
              operation,
              new Error('Cutover start evidence was invalid or retired'),
            );
            if (!operation.retired) void this.#retire(operation);
            return;
          }
          let current: FilePlaybackCutoverCandidatePort | null;
          try {
            current = TRUSTED_REFLECT_APPLY(TRUSTED_MANAGER_CURRENT_PORT, this.#manager, []);
          } catch {
            this.#rejectStarted(operation, new Error('Cutover current port could not be verified'));
            void this.#retire(operation);
            return;
          }
          if (current !== this.#candidatePort || this.#attempt !== operation || operation.retired) {
            this.#rejectStarted(
              operation,
              new Error('Cutover candidate was not promoted as the exact current port'),
            );
            if (!operation.retired) void this.#retire(operation);
            return;
          }
          operation.startObserved = true;
          this.#resolveStarted(operation, evidence);
        },
        (error: unknown) => {
          this.#rejectStarted(
            operation,
            error instanceof Error ? error : new Error('Cutover start evidence was rejected'),
          );
          if (!operation.retired) void this.#retire(operation);
        },
      ]);
    } catch (error) {
      this.#rejectStarted(
        operation,
        error instanceof Error ? error : new Error('Cutover start evidence was invalid'),
      );
      if (!operation.retired) void this.#retire(operation);
    }
  }

  #resolveStarted(operation: AttemptOperation, evidence: FilePlaybackStartEvidence): void {
    if (operation.startedSettled) return;
    operation.startedSettled = true;
    operation.resolveStarted(evidence);
  }

  #rejectStarted(operation: AttemptOperation, error: Error): void {
    if (operation.startedSettled) return;
    operation.startedSettled = true;
    operation.rejectStarted(error);
  }

  #retire(operation: AttemptOperation): Promise<void> {
    if (operation.committed) return Promise.resolve();
    operation.retired = true;
    this.#rejectStarted(operation, new Error('Cutover start evidence was retired'));
    if (this.#retirementPromise) return this.#retirementPromise;
    this.#retirementPromise = Promise.resolve().then(() => this.#retireExactPort());
    return this.#retirementPromise;
  }

  async #retireExactPort(): Promise<void> {
    let retiredCandidate = false;
    try {
      retiredCandidate =
        (await TRUSTED_REFLECT_APPLY(TRUSTED_MANAGER_RETIRE_CANDIDATE, this.#manager, [
          this.#candidatePort,
        ])) === true;
    } catch {
      // A candidate may have promoted between observation and retirement.
    }
    if (retiredCandidate) return;
    try {
      await TRUSTED_REFLECT_APPLY(TRUSTED_MANAGER_RETIRE_CURRENT, this.#manager, [
        this.#candidatePort,
      ]);
    } catch {
      // Exact-port retirement is best effort and never touches another port.
    }
  }

  #rejectedArm(
    intent: Readonly<RendezvousArmIntent> | null,
    reasonCode: string,
  ): RendezvousArmReceipt {
    return freezeCanonical({
      protocolVersion: 2 as const,
      kind: 'rendezvous-armed' as const,
      queueItemId: intent?.queueItemId ?? FALLBACK_QUEUE_ITEM_ID,
      runId: intent?.runId ?? 'invalid-run',
      revision: intent?.revision ?? 0,
      rendezvousId: intent?.rendezvousId ?? 'invalid-rendezvous',
      participantId: this.participantId,
      status: 'rejected' as const,
      observedAtRoomTimeMs: 0,
      bufferedAheadSeconds: 0,
      reasonCode: isBoundedIdentifier(reasonCode) ? reasonCode : 'cutover-arm-rejected',
    });
  }

  #rejectedFinalize(
    intent: Readonly<RendezvousFinalizeIntent> | null,
    reasonCode: string,
  ): RendezvousFinalizeReceipt {
    return freezeCanonical({
      protocolVersion: 2 as const,
      kind: 'rendezvous-finalized' as const,
      queueItemId: intent?.queueItemId ?? FALLBACK_QUEUE_ITEM_ID,
      runId: intent?.runId ?? 'invalid-run',
      revision: intent?.revision ?? 0,
      rendezvousId: intent?.rendezvousId ?? 'invalid-rendezvous',
      participantId: this.participantId,
      status: 'rejected' as const,
      observedAtRoomTimeMs: 0,
      reasonCode: isBoundedIdentifier(reasonCode) ? reasonCode : 'cutover-finalize-rejected',
    });
  }
}

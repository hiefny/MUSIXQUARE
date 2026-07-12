import type { QueueItemId } from '../types/index.ts';
import type { FilePlaybackCancelIntent, FilePlaybackSource } from './file-playback-source.ts';
import {
  readPlaybackAttemptIdentity,
  sameState,
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
  type RevisionedPlaybackRun,
} from './rendezvous-contract.ts';
import type { HostRendezvousParticipant } from './rendezvous-coordinator.ts';

const MAX_IDENTIFIER_LENGTH = 256;
const INVALID_METRIC_FALLBACK_MS = 2_500;
const FALLBACK_QUEUE_ITEM_ID = 'invalid-queue-item';
const FALLBACK_RUN_ID = 'invalid-run';
const FALLBACK_RENDEZVOUS_ID = 'invalid-rendezvous';
const OPTIONS_KEYS = Object.freeze([
  'participantId',
  'getActiveSource',
  'rttP95Ms',
  'armP95Ms',
  'nowRoomTimeMs',
] as const);
const CANCEL_INTENT_KEYS = Object.freeze([
  'kind',
  'queueItemId',
  'runId',
  'revision',
  'rendezvousId',
  'reasonCode',
] as const);

export type LocalRendezvousMetric = number | (() => number);

export interface LocalRendezvousParticipantOptions {
  readonly participantId: string;
  readonly getActiveSource: () => FilePlaybackSource | null;
  readonly rttP95Ms: LocalRendezvousMetric;
  readonly armP95Ms: LocalRendezvousMetric;
  readonly nowRoomTimeMs: () => number;
}

interface OperationAuthority {
  readonly epoch: number;
}

interface ObservedSource {
  readonly source: FilePlaybackSource | null;
  readonly epoch: number;
}

interface ArmedSourceBinding extends RevisionedPlaybackRun {
  readonly rendezvousId: string;
  readonly source: FilePlaybackSource;
  readonly sourceEpoch: number;
}

interface ArmOperation {
  readonly key: string;
  readonly authority: OperationAuthority;
  readonly source: FilePlaybackSource;
  readonly sourceEpoch: number;
  readonly intent: RendezvousArmIntent;
  promise: Promise<RendezvousArmReceipt>;
  retired: boolean;
  retiredReason: string | null;
}

interface FinalizeOperation {
  readonly key: string;
  readonly authority: OperationAuthority;
  readonly binding: ArmedSourceBinding;
  readonly intent: RendezvousFinalizeIntent;
  promise: Promise<RendezvousFinalizeReceipt>;
  retired: boolean;
  retiredReason: string | null;
  accepted: boolean;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function metricReader(metric: LocalRendezvousMetric, label: string): () => number {
  if (typeof metric === 'number') {
    if (!Number.isFinite(metric) || metric < 0) {
      throw new RangeError(`${label} must be a finite non-negative number`);
    }
    return () => metric;
  }
  if (typeof metric !== 'function') {
    throw new TypeError(`${label} must be a number or provider`);
  }
  return () => {
    try {
      const current = metric();
      return Number.isFinite(current) && current >= 0 ? current : INVALID_METRIC_FALLBACK_MS;
    } catch {
      return INVALID_METRIC_FALLBACK_MS;
    }
  };
}

function snapshotOptions(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected: ReadonlySet<string> = new Set(OPTIONS_KEYS);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of OPTIONS_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function readCancelIntent(value: unknown): FilePlaybackCancelIntent | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected: ReadonlySet<string> = new Set(CANCEL_INTENT_KEYS);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of CANCEL_INTENT_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    const attempt = readPlaybackAttemptIdentity(snapshot);
    if (
      !attempt ||
      snapshot.kind !== 'file-playback-cancel' ||
      !isBoundedIdentifier(snapshot.reasonCode)
    ) {
      return null;
    }
    return Object.freeze(
      Object.assign(Object.create(null), {
        kind: 'file-playback-cancel' as const,
        ...attempt,
        reasonCode: snapshot.reasonCode,
      }),
    ) as FilePlaybackCancelIntent;
  } catch {
    return null;
  }
}

function armOperationKey(intent: RendezvousArmIntent): string {
  return JSON.stringify([
    intent.queueItemId,
    intent.runId,
    intent.revision,
    intent.rendezvousId,
    intent.recipientId,
    intent.positionSeconds,
    intent.playbackRate,
    intent.startAtRoomTimeMs,
    intent.finalizeByRoomTimeMs,
  ]);
}

function finalizeOperationKey(intent: RendezvousFinalizeIntent): string {
  return JSON.stringify([
    intent.queueItemId,
    intent.runId,
    intent.revision,
    intent.rendezvousId,
    intent.recipientId,
    intent.startAtRoomTimeMs,
    intent.finalizedAtRoomTimeMs,
  ]);
}

function bindingMatchesRun(binding: ArmedSourceBinding, run: RevisionedPlaybackRun): boolean {
  return sameRevisionedRun(binding, run);
}

function sameRendezvousAttempt(
  left: RevisionedPlaybackRun & { readonly rendezvousId: string },
  right: RevisionedPlaybackRun & { readonly rendezvousId: string },
): boolean {
  return sameRevisionedRun(left, right) && left.rendezvousId === right.rendezvousId;
}

function sameRevisionedRun(left: RevisionedPlaybackRun, right: RevisionedPlaybackRun): boolean {
  return sameState(left, right);
}

/**
 * Adapts the source currently owned by this device to the transport-agnostic
 * host barrier. Every asynchronous operation carries source and authority
 * epochs so a replaced queue occurrence cannot regain authority through ABA.
 */
export class LocalRendezvousParticipant implements HostRendezvousParticipant {
  readonly participantId: string;
  readonly #getActiveSource: () => FilePlaybackSource | null;
  readonly #readRttP95Ms: () => number;
  readonly #readArmP95Ms: () => number;
  readonly #nowRoomTimeMs: () => number;
  #authority: OperationAuthority = Object.freeze({ epoch: 0 });
  #sourceEpoch = 0;
  #hasObservedSource = false;
  #lastObservedSource: FilePlaybackSource | null = null;
  #latestArmRevision = -1;
  #armOperation: ArmOperation | null = null;
  #finalizeOperation: FinalizeOperation | null = null;
  #armedBinding: ArmedSourceBinding | null = null;
  #committedBinding: ArmedSourceBinding | null = null;

  constructor(options: LocalRendezvousParticipantOptions) {
    const snapshot = snapshotOptions(options);
    if (!snapshot) throw new TypeError('Local rendezvous participant options are invalid');
    if (!isBoundedIdentifier(snapshot.participantId)) {
      throw new TypeError('participantId must be a non-empty bounded identifier');
    }
    if (typeof snapshot.getActiveSource !== 'function') {
      throw new TypeError('getActiveSource must be a function');
    }
    if (typeof snapshot.nowRoomTimeMs !== 'function') {
      throw new TypeError('nowRoomTimeMs must be a function');
    }
    this.participantId = snapshot.participantId;
    this.#getActiveSource = snapshot.getActiveSource as () => FilePlaybackSource | null;
    this.#readRttP95Ms = metricReader(snapshot.rttP95Ms as LocalRendezvousMetric, 'rttP95Ms');
    this.#readArmP95Ms = metricReader(snapshot.armP95Ms as LocalRendezvousMetric, 'armP95Ms');
    this.#nowRoomTimeMs = snapshot.nowRoomTimeMs as () => number;
  }

  get rttP95Ms(): number {
    return this.#readRttP95Ms();
  }

  get armP95Ms(): number {
    return this.#readArmP95Ms();
  }

  arm(value: RendezvousArmIntent): Promise<RendezvousArmReceipt> {
    try {
      const intent = readRendezvousArmIntent(value);
      if (!intent) return Promise.resolve(this.#rejectedArm(null, 'invalid-arm-intent'));
      if (intent.recipientId !== this.participantId) {
        return Promise.resolve(this.#rejectedArm(intent, 'local-participant-mismatch'));
      }

      const observed = this.#observeActiveSource();
      const source = observed.source;
      if (source === null) {
        return Promise.resolve(this.#rejectedArm(intent, 'local-source-unavailable'));
      }
      if (!this.#sourceOwnsQueueItem(source, intent.queueItemId)) {
        return Promise.resolve(this.#rejectedArm(intent, 'local-source-mismatch'));
      }

      const key = armOperationKey(intent);
      const existing = this.#armOperation;
      if (existing?.key === key) {
        const staleReason = this.#armRetryStaleReason(existing, observed);
        if (staleReason === null) return existing.promise;
        if (!existing.retired) this.#retireArmOperation(existing, staleReason);
        return Promise.resolve(this.#rejectedArm(intent, staleReason));
      }
      if (intent.revision < this.#latestArmRevision) {
        return Promise.resolve(this.#rejectedArm(intent, 'local-operation-superseded'));
      }
      if (intent.revision === this.#latestArmRevision) {
        const canRearmRetiredRun =
          existing !== null &&
          existing.retired &&
          sameRevisionedRun(existing.intent, intent) &&
          existing.intent.rendezvousId !== intent.rendezvousId;
        if (!canRearmRetiredRun) {
          return Promise.resolve(this.#rejectedArm(intent, 'local-operation-conflict'));
        }
      }

      this.#retireForNewArm();
      this.#latestArmRevision = intent.revision;
      const operation: ArmOperation = {
        key,
        authority: this.#advanceAuthority(),
        source,
        sourceEpoch: observed.epoch,
        intent,
        promise: Promise.resolve(this.#rejectedArm(intent, 'local-operation-not-started')),
        retired: false,
        retiredReason: null,
      };
      this.#armOperation = operation;
      operation.promise = Promise.resolve().then(() => this.#executeArm(operation));
      return operation.promise;
    } catch {
      return Promise.resolve(this.#rejectedArm(null, 'local-participant-internal-failure'));
    }
  }

  finalize(value: RendezvousFinalizeIntent): Promise<RendezvousFinalizeReceipt> {
    try {
      const intent = readRendezvousFinalizeIntent(value);
      if (!intent) return Promise.resolve(this.#rejectedFinalize(null, 'invalid-finalize-intent'));
      if (intent.recipientId !== this.participantId) {
        return Promise.resolve(this.#rejectedFinalize(intent, 'local-participant-mismatch'));
      }

      const observed = this.#observeActiveSource();
      const source = observed.source;
      if (source === null) {
        return Promise.resolve(this.#rejectedFinalize(intent, 'local-source-unavailable'));
      }
      if (!this.#sourceOwnsQueueItem(source, intent.queueItemId)) {
        return Promise.resolve(this.#rejectedFinalize(intent, 'local-source-mismatch'));
      }

      const binding = this.#armedBinding;
      if (
        binding === null ||
        binding.rendezvousId !== intent.rendezvousId ||
        !bindingMatchesRun(binding, intent)
      ) {
        return Promise.resolve(this.#rejectedFinalize(intent, 'local-rendezvous-not-armed'));
      }
      if (binding.source !== source || binding.sourceEpoch !== observed.epoch) {
        this.#retireBinding(binding, 'local-source-changed');
        return Promise.resolve(this.#rejectedFinalize(intent, 'local-source-changed'));
      }

      const key = finalizeOperationKey(intent);
      const existing = this.#finalizeOperation;
      if (existing !== null) {
        if (existing.key !== key) {
          return Promise.resolve(this.#rejectedFinalize(intent, 'local-finalize-conflict'));
        }
        const staleReason = this.#finalizeRetryStaleReason(existing, observed);
        if (staleReason === null) return existing.promise;
        if (!existing.retired) this.#retireFinalizeOperation(existing, staleReason);
        return Promise.resolve(this.#rejectedFinalize(intent, staleReason));
      }

      const operation: FinalizeOperation = {
        key,
        authority: this.#advanceAuthority(),
        binding,
        intent,
        promise: Promise.resolve(this.#rejectedFinalize(intent, 'local-operation-not-started')),
        retired: false,
        retiredReason: null,
        accepted: false,
      };
      this.#finalizeOperation = operation;
      operation.promise = Promise.resolve().then(() => this.#executeFinalize(operation));
      return operation.promise;
    } catch {
      return Promise.resolve(this.#rejectedFinalize(null, 'local-participant-internal-failure'));
    }
  }

  cancel(value: FilePlaybackCancelIntent): Promise<void> {
    try {
      const intent = readCancelIntent(value);
      if (!intent) return Promise.resolve();

      const committedBinding = this.#committedBinding;
      if (committedBinding !== null && sameRendezvousAttempt(committedBinding, intent)) {
        return Promise.resolve();
      }

      const binding = this.#armedBinding;
      const operation = this.#armOperation;
      const matchingBinding =
        binding !== null && sameRendezvousAttempt(binding, intent) ? binding : null;
      const matchingOperation =
        operation !== null && sameRendezvousAttempt(operation.intent, intent) ? operation : null;
      if (matchingBinding === null && matchingOperation === null) {
        return Promise.resolve();
      }

      if (matchingBinding !== null) this.#armedBinding = null;
      if (matchingOperation !== null) {
        matchingOperation.retired = true;
        matchingOperation.retiredReason = 'local-operation-cancelled';
      }
      if (
        this.#finalizeOperation !== null &&
        sameRendezvousAttempt(this.#finalizeOperation.binding, intent)
      ) {
        this.#finalizeOperation.retired = true;
        this.#finalizeOperation.retiredReason = 'local-operation-cancelled';
      }
      this.#advanceAuthority();
      const cancelledSources = new Set<FilePlaybackSource>();
      if (matchingBinding !== null) cancelledSources.add(matchingBinding.source);
      if (matchingOperation !== null) cancelledSources.add(matchingOperation.source);
      for (const source of cancelledSources) {
        this.#bestEffortCancel(source, intent, intent.reasonCode);
      }
      return Promise.resolve();
    } catch {
      return Promise.resolve();
    }
  }

  commitAttempt(value: PlaybackAttemptIdentity): boolean {
    const identity = readPlaybackAttemptIdentity(value);
    if (!identity) return false;
    const committedBinding = this.#committedBinding;
    if (committedBinding !== null && sameRendezvousAttempt(committedBinding, identity)) {
      return true;
    }
    const operation = this.#finalizeOperation;
    if (
      operation === null ||
      operation.retired ||
      !operation.accepted ||
      this.#armedBinding !== operation.binding ||
      !sameRendezvousAttempt(operation.binding, identity)
    ) {
      return false;
    }
    const observed = this.#observeActiveSource();
    if (
      this.#finalizeOperation !== operation ||
      operation.retired ||
      !operation.accepted ||
      this.#armedBinding !== operation.binding ||
      operation.binding.source !== observed.source ||
      operation.binding.sourceEpoch !== observed.epoch
    ) {
      return false;
    }
    this.#committedBinding = operation.binding;
    return true;
  }

  async #executeArm(operation: ArmOperation): Promise<RendezvousArmReceipt> {
    let receipt: RendezvousArmReceipt;
    try {
      receipt = await operation.source.arm(operation.intent);
    } catch {
      const staleReason = this.#armAuthorityFailure(operation);
      if (staleReason !== null) {
        this.#retireArmOperation(operation, staleReason);
        return this.#rejectedArm(operation.intent, staleReason);
      }
      return this.#rejectedArm(operation.intent, 'local-source-arm-failed');
    }

    const staleReason = this.#armAuthorityFailure(operation);
    if (staleReason !== null) {
      this.#retireArmOperation(operation, staleReason);
      return this.#rejectedArm(operation.intent, staleReason);
    }
    const canonicalReceipt = readRendezvousArmReceipt(receipt);
    // Canonicalizing a hostile Proxy can re-enter this participant and retire
    // the operation. Re-check authority before committing its binding.
    const postCanonicalStaleReason = this.#armAuthorityFailure(operation);
    if (postCanonicalStaleReason !== null) {
      if (!operation.retired) this.#retireArmOperation(operation, postCanonicalStaleReason);
      return this.#rejectedArm(operation.intent, postCanonicalStaleReason);
    }
    if (!canonicalReceipt) {
      return this.#rejectedArm(operation.intent, 'local-source-invalid-arm-receipt');
    }
    const validation = validateRendezvousArmReceipt(operation.intent, canonicalReceipt);
    if (
      !validation.ok &&
      validation.code !== 'arm-rejected' &&
      validation.code !== 'arm-after-deadline'
    ) {
      return this.#rejectedArm(operation.intent, 'local-source-invalid-arm-receipt');
    }

    if (validation.ok) {
      this.#armedBinding = Object.freeze({
        queueItemId: operation.intent.queueItemId,
        runId: operation.intent.runId,
        revision: operation.intent.revision,
        rendezvousId: operation.intent.rendezvousId,
        source: operation.source,
        sourceEpoch: operation.sourceEpoch,
      });
    }
    return canonicalReceipt;
  }

  async #executeFinalize(operation: FinalizeOperation): Promise<RendezvousFinalizeReceipt> {
    let receipt: RendezvousFinalizeReceipt;
    try {
      receipt = await operation.binding.source.finalize(operation.intent);
    } catch {
      const staleReason = this.#finalizeAuthorityFailure(operation);
      if (staleReason !== null) {
        this.#retireFinalizeOperation(operation, staleReason);
        return this.#rejectedFinalize(operation.intent, staleReason);
      }
      return this.#rejectedFinalize(operation.intent, 'local-source-finalize-failed');
    }

    const staleReason = this.#finalizeAuthorityFailure(operation);
    if (staleReason !== null) {
      this.#retireFinalizeOperation(operation, staleReason);
      return this.#rejectedFinalize(operation.intent, staleReason);
    }
    const canonicalReceipt = readRendezvousFinalizeReceipt(receipt);
    // As above, no receipt inspected through Proxy traps may commit against a
    // binding that was cancelled or replaced during canonicalization.
    const postCanonicalStaleReason = this.#finalizeAuthorityFailure(operation);
    if (postCanonicalStaleReason !== null) {
      if (!operation.retired) this.#retireFinalizeOperation(operation, postCanonicalStaleReason);
      return this.#rejectedFinalize(operation.intent, postCanonicalStaleReason);
    }
    if (!canonicalReceipt) {
      return this.#rejectedFinalize(operation.intent, 'local-source-invalid-finalize-receipt');
    }
    const validation = validateRendezvousFinalizeReceipt(operation.intent, canonicalReceipt);
    if (
      !validation.ok &&
      validation.code !== 'finalization-rejected' &&
      validation.code !== 'finalization-after-deadline'
    ) {
      return this.#rejectedFinalize(operation.intent, 'local-source-invalid-finalize-receipt');
    }
    if (validation.ok) operation.accepted = true;
    return canonicalReceipt;
  }

  #armRetryStaleReason(operation: ArmOperation, observed: ObservedSource): string | null {
    if (operation.retired) return operation.retiredReason ?? 'local-operation-superseded';
    if (operation.source !== observed.source || operation.sourceEpoch !== observed.epoch) {
      return 'local-source-changed';
    }
    const binding = this.#armedBinding;
    if (
      operation.authority !== this.#authority &&
      (binding === null ||
        binding.source !== operation.source ||
        !bindingMatchesRun(binding, operation.intent))
    ) {
      return 'local-operation-superseded';
    }
    return null;
  }

  #finalizeRetryStaleReason(operation: FinalizeOperation, observed: ObservedSource): string | null {
    if (operation.retired) return operation.retiredReason ?? 'local-operation-superseded';
    if (
      operation.binding.source !== observed.source ||
      operation.binding.sourceEpoch !== observed.epoch ||
      this.#armedBinding !== operation.binding
    ) {
      return 'local-source-changed';
    }
    if (operation.authority !== this.#authority || this.#finalizeOperation !== operation) {
      return 'local-operation-superseded';
    }
    return null;
  }

  #armAuthorityFailure(operation: ArmOperation): string | null {
    if (
      operation.retired ||
      operation.authority !== this.#authority ||
      this.#armOperation !== operation
    ) {
      return operation.retiredReason ?? 'local-operation-superseded';
    }
    const observed = this.#observeActiveSource();
    if (
      operation.retired ||
      operation.authority !== this.#authority ||
      this.#armOperation !== operation
    ) {
      return operation.retiredReason ?? 'local-operation-superseded';
    }
    return operation.source === observed.source && operation.sourceEpoch === observed.epoch
      ? null
      : 'local-source-changed';
  }

  #finalizeAuthorityFailure(operation: FinalizeOperation): string | null {
    if (
      operation.retired ||
      operation.authority !== this.#authority ||
      this.#finalizeOperation !== operation
    ) {
      return operation.retiredReason ?? 'local-operation-superseded';
    }
    const observed = this.#observeActiveSource();
    if (
      operation.retired ||
      operation.authority !== this.#authority ||
      this.#finalizeOperation !== operation ||
      this.#armedBinding !== operation.binding
    ) {
      return operation.retiredReason ?? 'local-operation-superseded';
    }
    if (
      operation.binding.source !== observed.source ||
      operation.binding.sourceEpoch !== observed.epoch ||
      this.#armedBinding !== operation.binding
    ) {
      return 'local-source-changed';
    }
    return null;
  }

  #retireForNewArm(): void {
    if (this.#armOperation !== null && !this.#armOperation.retired) {
      this.#armOperation.retired = true;
      this.#armOperation.retiredReason = 'local-operation-superseded';
    }
    if (this.#finalizeOperation !== null) {
      this.#finalizeOperation.retired = true;
      this.#finalizeOperation.retiredReason = 'local-operation-superseded';
      this.#finalizeOperation = null;
    }
    const binding = this.#armedBinding;
    if (binding !== null) {
      this.#armedBinding = null;
      this.#bestEffortCancel(binding.source, binding, 'newer-rendezvous');
    }
  }

  #retireArmOperation(operation: ArmOperation, reasonCode: string): void {
    operation.retired = true;
    operation.retiredReason = reasonCode;
    if (operation.authority === this.#authority) this.#advanceAuthority();
    const binding = this.#armedBinding;
    if (
      binding?.source === operation.source &&
      binding.rendezvousId === operation.intent.rendezvousId &&
      bindingMatchesRun(binding, operation.intent)
    ) {
      this.#armedBinding = null;
    }
    if (!this.#hasNewerSameRunOnSource(operation.source, operation.intent, operation)) {
      this.#bestEffortCancel(operation.source, operation.intent, reasonCode);
    }
  }

  #retireFinalizeOperation(operation: FinalizeOperation, reasonCode: string): void {
    operation.retired = true;
    operation.retiredReason = reasonCode;
    if (operation.authority === this.#authority) this.#advanceAuthority();
    if (this.#armedBinding === operation.binding) this.#armedBinding = null;
    if (!this.#hasNewerSameRunOnSource(operation.binding.source, operation.binding)) {
      this.#bestEffortCancel(operation.binding.source, operation.binding, reasonCode);
    }
  }

  #retireBinding(binding: ArmedSourceBinding, reasonCode: string): void {
    if (this.#armedBinding === binding) this.#armedBinding = null;
    if (this.#finalizeOperation?.binding === binding) {
      this.#finalizeOperation.retired = true;
      this.#finalizeOperation.retiredReason = reasonCode;
    }
    this.#advanceAuthority();
    this.#bestEffortCancel(binding.source, binding, reasonCode);
  }

  #bestEffortCancel(
    source: FilePlaybackSource,
    run: RevisionedPlaybackRun & { readonly rendezvousId: string },
    reasonCode: string,
  ): void {
    const committedBinding = this.#committedBinding;
    if (
      committedBinding !== null &&
      committedBinding.source === source &&
      sameRendezvousAttempt(committedBinding, run)
    ) {
      return;
    }
    const intent: FilePlaybackCancelIntent = Object.freeze({
      kind: 'file-playback-cancel',
      queueItemId: run.queueItemId,
      runId: run.runId,
      revision: run.revision,
      rendezvousId: run.rendezvousId,
      reasonCode: isBoundedIdentifier(reasonCode) ? reasonCode : 'local-operation-retired',
    });
    try {
      void Promise.resolve(source.cancel(intent)).catch(() => undefined);
    } catch {
      // Retirement is best-effort; stale local work cannot block the host.
    }
  }

  #hasNewerSameRunOnSource(
    source: FilePlaybackSource,
    run: RevisionedPlaybackRun & { readonly rendezvousId?: string },
    excludedOperation?: ArmOperation,
  ): boolean {
    const current = this.#armOperation;
    return (
      current !== null &&
      current !== excludedOperation &&
      !current.retired &&
      current.source === source &&
      sameRevisionedRun(current.intent, run) &&
      (run.rendezvousId === undefined || current.intent.rendezvousId !== run.rendezvousId)
    );
  }

  #advanceAuthority(): OperationAuthority {
    const epoch = this.#authority.epoch === Number.MAX_SAFE_INTEGER ? 0 : this.#authority.epoch + 1;
    this.#authority = Object.freeze({ epoch });
    return this.#authority;
  }

  #observeActiveSource(): ObservedSource {
    let source: FilePlaybackSource | null;
    try {
      source = this.#getActiveSource() ?? null;
    } catch {
      source = null;
    }
    if (!this.#hasObservedSource || source !== this.#lastObservedSource) {
      this.#hasObservedSource = true;
      this.#lastObservedSource = source;
      this.#sourceEpoch = this.#sourceEpoch === Number.MAX_SAFE_INTEGER ? 0 : this.#sourceEpoch + 1;
    }
    return Object.freeze({ source, epoch: this.#sourceEpoch });
  }

  #sourceOwnsQueueItem(source: FilePlaybackSource, queueItemId: QueueItemId): boolean {
    try {
      return source.queueItemId === queueItemId;
    } catch {
      return false;
    }
  }

  #roomTimeMs(): number {
    try {
      const current = this.#nowRoomTimeMs();
      return Number.isFinite(current) && current >= 0 ? current : 0;
    } catch {
      return 0;
    }
  }

  #rejectedArm(intent: RendezvousArmIntent | null, reasonCode: string): RendezvousArmReceipt {
    return Object.freeze({
      protocolVersion: 2,
      kind: 'rendezvous-armed',
      queueItemId: intent?.queueItemId ?? FALLBACK_QUEUE_ITEM_ID,
      runId: intent?.runId ?? FALLBACK_RUN_ID,
      revision: intent?.revision ?? 0,
      rendezvousId: intent?.rendezvousId ?? FALLBACK_RENDEZVOUS_ID,
      participantId: this.participantId,
      status: 'rejected',
      observedAtRoomTimeMs: this.#roomTimeMs(),
      bufferedAheadSeconds: 0,
      reasonCode: isBoundedIdentifier(reasonCode) ? reasonCode : 'local-operation-rejected',
    });
  }

  #rejectedFinalize(
    intent: RendezvousFinalizeIntent | null,
    reasonCode: string,
  ): RendezvousFinalizeReceipt {
    return Object.freeze({
      protocolVersion: 2,
      kind: 'rendezvous-finalized',
      queueItemId: intent?.queueItemId ?? FALLBACK_QUEUE_ITEM_ID,
      runId: intent?.runId ?? FALLBACK_RUN_ID,
      revision: intent?.revision ?? 0,
      rendezvousId: intent?.rendezvousId ?? FALLBACK_RENDEZVOUS_ID,
      participantId: this.participantId,
      status: 'rejected',
      observedAtRoomTimeMs: this.#roomTimeMs(),
      reasonCode: isBoundedIdentifier(reasonCode) ? reasonCode : 'local-operation-rejected',
    });
  }
}

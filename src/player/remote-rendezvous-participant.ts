import type { QueueItemId } from '../types/index.ts';
import type { FilePlaybackCancelIntent } from './file-playback-source.ts';
import {
  isRendezvousArmIntent,
  isRendezvousArmReceipt,
  isRendezvousFinalizeIntent,
  isRendezvousFinalizeReceipt,
  isRevisionedPlaybackRun,
  type RendezvousArmIntent,
  type RendezvousArmReceipt,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
  type RevisionedPlaybackRun,
} from './rendezvous-contract.ts';
import type { HostRendezvousParticipant } from './rendezvous-coordinator.ts';

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_RENDEZVOUS_IDS_PER_RUN = 256;
const INVALID_METRIC_FALLBACK_MS = 2_500;
const FALLBACK_QUEUE_ITEM_ID = 'invalid-queue-item' as QueueItemId;
const FALLBACK_RUN_ID = 'invalid-run';
const FALLBACK_RENDEZVOUS_ID = 'invalid-rendezvous';
const OPTIONS_KEYS = Object.freeze([
  'participantId',
  'rttP95Ms',
  'armP95Ms',
  'nowRoomTimeMs',
  'dispatchArm',
  'dispatchFinalize',
  'dispatchCancel',
]);
const ARM_INTENT_KEYS = Object.freeze([
  'protocolVersion',
  'kind',
  'queueItemId',
  'runId',
  'revision',
  'rendezvousId',
  'recipientId',
  'positionSeconds',
  'playbackRate',
  'startAtRoomTimeMs',
  'finalizeByRoomTimeMs',
]);
const FINALIZE_INTENT_KEYS = Object.freeze([
  'protocolVersion',
  'kind',
  'queueItemId',
  'runId',
  'revision',
  'rendezvousId',
  'recipientId',
  'startAtRoomTimeMs',
  'finalizedAtRoomTimeMs',
]);
const ARM_RECEIPT_KEYS = Object.freeze([
  'protocolVersion',
  'kind',
  'queueItemId',
  'runId',
  'revision',
  'rendezvousId',
  'participantId',
  'status',
  'observedAtRoomTimeMs',
  'bufferedAheadSeconds',
  'reasonCode',
]);
const FINALIZE_RECEIPT_KEYS = Object.freeze([
  'protocolVersion',
  'kind',
  'queueItemId',
  'runId',
  'revision',
  'rendezvousId',
  'participantId',
  'status',
  'observedAtRoomTimeMs',
  'reasonCode',
]);
const CANCEL_INTENT_KEYS = Object.freeze([
  'kind',
  'queueItemId',
  'runId',
  'revision',
  'reasonCode',
]);

export type RemoteRendezvousMetric = number | (() => number);

export interface RemoteRendezvousParticipantOptions {
  readonly participantId: string;
  readonly rttP95Ms: RemoteRendezvousMetric;
  readonly armP95Ms: RemoteRendezvousMetric;
  readonly nowRoomTimeMs: () => number;
  readonly dispatchArm: (intent: RendezvousArmIntent) => unknown;
  readonly dispatchFinalize: (intent: RendezvousFinalizeIntent) => unknown;
  readonly dispatchCancel: (intent: FilePlaybackCancelIntent) => unknown;
}

interface DeferredReceipt<T> {
  readonly promise: Promise<T>;
  readonly resolve: (receipt: T) => void;
  settled: boolean;
}

interface FinalizeOperation {
  readonly intent: RendezvousFinalizeIntent;
  readonly deferred: DeferredReceipt<RendezvousFinalizeReceipt>;
}

interface ActiveCorrelation {
  readonly intent: RendezvousArmIntent;
  readonly deferred: DeferredReceipt<RendezvousArmReceipt>;
  armAccepted: boolean;
  finalize: FinalizeOperation | null;
  retired: boolean;
}

interface LatestCorrelationIdentity extends RevisionedPlaybackRun {
  readonly rendezvousId: string;
}

interface ParticipantCorrelationIdentity extends RevisionedPlaybackRun {
  readonly rendezvousId: string;
  readonly recipientId: string;
}

type RoomTimeRead =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reasonCode: 'remote-room-clock-invalid' };

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function metricReader(metric: unknown, label: string): () => number {
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

function deferredReceipt<T>(): DeferredReceipt<T> {
  let resolve!: (receipt: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve, settled: false };
}

/**
 * Detaches one exact plain record without using [[Get]]. Accessors, symbols,
 * inherited records, and unexpected fields are rejected before validation.
 */
function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const expected = new Set(expectedKeys);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function freezeCanonical<T extends object>(value: T): T {
  return Object.freeze(Object.assign(Object.create(null), value)) as T;
}

function snapshotArmIntent(value: unknown): RendezvousArmIntent | null {
  const snapshot = snapshotExactDataRecord(value, ARM_INTENT_KEYS);
  return snapshot !== null && isRendezvousArmIntent(snapshot)
    ? (snapshot as unknown as RendezvousArmIntent)
    : null;
}

function snapshotFinalizeIntent(value: unknown): RendezvousFinalizeIntent | null {
  const snapshot = snapshotExactDataRecord(value, FINALIZE_INTENT_KEYS);
  return snapshot !== null && isRendezvousFinalizeIntent(snapshot)
    ? (snapshot as unknown as RendezvousFinalizeIntent)
    : null;
}

function snapshotArmReceipt(value: unknown): RendezvousArmReceipt | null {
  const snapshot = snapshotExactDataRecord(value, ARM_RECEIPT_KEYS);
  return snapshot !== null && isRendezvousArmReceipt(snapshot)
    ? (snapshot as unknown as RendezvousArmReceipt)
    : null;
}

function snapshotFinalizeReceipt(value: unknown): RendezvousFinalizeReceipt | null {
  const snapshot = snapshotExactDataRecord(value, FINALIZE_RECEIPT_KEYS);
  return snapshot !== null && isRendezvousFinalizeReceipt(snapshot)
    ? (snapshot as unknown as RendezvousFinalizeReceipt)
    : null;
}

function snapshotCancelIntent(value: unknown): FilePlaybackCancelIntent | null {
  const snapshot = snapshotExactDataRecord(value, CANCEL_INTENT_KEYS);
  if (
    snapshot === null ||
    snapshot.kind !== 'file-playback-cancel' ||
    !isRevisionedPlaybackRun(snapshot) ||
    !isBoundedIdentifier(snapshot.reasonCode)
  ) {
    return null;
  }
  return snapshot as unknown as FilePlaybackCancelIntent;
}

function sameRevisionedRun(left: RevisionedPlaybackRun, right: RevisionedPlaybackRun): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision
  );
}

function sameArmCorrelation(
  left: ParticipantCorrelationIdentity,
  right: ParticipantCorrelationIdentity,
): boolean {
  return (
    sameRevisionedRun(left, right) &&
    left.rendezvousId === right.rendezvousId &&
    left.recipientId === right.recipientId
  );
}

function sameArmIntent(left: RendezvousArmIntent, right: RendezvousArmIntent): boolean {
  return (
    sameArmCorrelation(left, right) &&
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
    sameRevisionedRun(left, right) &&
    left.rendezvousId === right.rendezvousId &&
    left.recipientId === right.recipientId &&
    left.startAtRoomTimeMs === right.startAtRoomTimeMs &&
    left.finalizedAtRoomTimeMs === right.finalizedAtRoomTimeMs
  );
}

function armReceiptMatches(intent: RendezvousArmIntent, receipt: RendezvousArmReceipt): boolean {
  return (
    sameRevisionedRun(intent, receipt) &&
    intent.rendezvousId === receipt.rendezvousId &&
    intent.recipientId === receipt.participantId
  );
}

function finalizeReceiptMatches(
  intent: RendezvousFinalizeIntent,
  receipt: RendezvousFinalizeReceipt,
): boolean {
  return (
    sameRevisionedRun(intent, receipt) &&
    intent.rendezvousId === receipt.rendezvousId &&
    intent.recipientId === receipt.participantId
  );
}

/**
 * Adapts a remote transport endpoint to the host rendezvous barrier. Transport
 * callbacks only dispatch requests; exact receipts must be admitted separately.
 * Callback throws (including `throw undefined`) and rejected dispatch promises
 * are deliberately normalized to rejected receipts so one peer cannot reject
 * or stall the host coordinator's control flow.
 */
export class RemoteRendezvousParticipant implements HostRendezvousParticipant {
  readonly participantId: string;
  readonly #readRttP95Ms: () => number;
  readonly #readArmP95Ms: () => number;
  readonly #nowRoomTimeMs: () => number;
  readonly #dispatchArm: (intent: RendezvousArmIntent) => unknown;
  readonly #dispatchFinalize: (intent: RendezvousFinalizeIntent) => unknown;
  readonly #dispatchCancel: (intent: FilePlaybackCancelIntent) => unknown;
  #active: ActiveCorrelation | null = null;
  #latestIdentity: LatestCorrelationIdentity | null = null;
  #seenRun: RevisionedPlaybackRun | null = null;
  readonly #seenRendezvousIds = new Set<string>();
  #lastRoomTimeMs: number | null = null;
  #readingRoomTime = false;

  constructor(options: RemoteRendezvousParticipantOptions) {
    const canonical = snapshotExactDataRecord(options, OPTIONS_KEYS);
    if (canonical === null) {
      throw new TypeError('Remote rendezvous participant options must be exact own data');
    }
    if (!isBoundedIdentifier(canonical.participantId)) {
      throw new TypeError('participantId must be a non-empty bounded identifier');
    }
    if (typeof canonical.nowRoomTimeMs !== 'function') {
      throw new TypeError('nowRoomTimeMs must be a function');
    }
    if (typeof canonical.dispatchArm !== 'function') {
      throw new TypeError('dispatchArm must be a function');
    }
    if (typeof canonical.dispatchFinalize !== 'function') {
      throw new TypeError('dispatchFinalize must be a function');
    }
    if (typeof canonical.dispatchCancel !== 'function') {
      throw new TypeError('dispatchCancel must be a function');
    }
    this.participantId = canonical.participantId;
    this.#readRttP95Ms = metricReader(canonical.rttP95Ms, 'rttP95Ms');
    this.#readArmP95Ms = metricReader(canonical.armP95Ms, 'armP95Ms');
    this.#nowRoomTimeMs = canonical.nowRoomTimeMs as () => number;
    this.#dispatchArm = canonical.dispatchArm as (intent: RendezvousArmIntent) => unknown;
    this.#dispatchFinalize = canonical.dispatchFinalize as (
      intent: RendezvousFinalizeIntent,
    ) => unknown;
    this.#dispatchCancel = canonical.dispatchCancel as (
      intent: FilePlaybackCancelIntent,
    ) => unknown;
  }

  get rttP95Ms(): number {
    return this.#readRttP95Ms();
  }

  get armP95Ms(): number {
    return this.#readArmP95Ms();
  }

  arm(intent: RendezvousArmIntent): Promise<RendezvousArmReceipt> {
    const canonical = snapshotArmIntent(intent);
    if (canonical === null) {
      return Promise.resolve(this.#rejectedArm(null, 'invalid-arm-intent'));
    }
    if (canonical.recipientId !== this.participantId) {
      return Promise.resolve(this.#rejectedArm(canonical, 'remote-participant-mismatch'));
    }

    const active = this.#active;
    if (active !== null) {
      if (sameArmIntent(active.intent, canonical)) return active.deferred.promise;
      if (canonical.revision < active.intent.revision) {
        return Promise.resolve(this.#rejectedArm(canonical, 'remote-operation-superseded'));
      }
      if (
        canonical.revision === active.intent.revision &&
        (!sameRevisionedRun(canonical, active.intent) ||
          canonical.rendezvousId === active.intent.rendezvousId)
      ) {
        return Promise.resolve(this.#rejectedArm(canonical, 'remote-operation-conflict'));
      }
      if (sameRevisionedRun(canonical, active.intent) && !this.#canRememberRendezvous(canonical)) {
        return Promise.resolve(this.#rejectedArm(canonical, 'remote-operation-superseded'));
      }
      this.#retire(active, 'remote-operation-superseded');
      this.#active = null;
    } else {
      const latest = this.#latestIdentity;
      if (latest !== null && canonical.revision <= latest.revision) {
        const validSameRunRecovery =
          canonical.revision === latest.revision &&
          sameRevisionedRun(canonical, latest) &&
          canonical.rendezvousId !== latest.rendezvousId;
        if (!validSameRunRecovery) {
          return Promise.resolve(this.#rejectedArm(canonical, 'remote-operation-superseded'));
        }
        if (!this.#canRememberRendezvous(canonical)) {
          return Promise.resolve(this.#rejectedArm(canonical, 'remote-operation-superseded'));
        }
      }
    }

    const operation: ActiveCorrelation = {
      intent: canonical,
      deferred: deferredReceipt<RendezvousArmReceipt>(),
      armAccepted: false,
      finalize: null,
      retired: false,
    };
    this.#active = operation;
    this.#latestIdentity = freezeCanonical({
      queueItemId: canonical.queueItemId,
      runId: canonical.runId,
      revision: canonical.revision,
      rendezvousId: canonical.rendezvousId,
    });
    this.#rememberRendezvous(canonical);

    try {
      const dispatched = this.#dispatchArm(canonical);
      this.#observeDispatchFailure(dispatched, () => {
        if (this.#active === operation && !operation.retired && !operation.deferred.settled) {
          this.#settleArm(operation, this.#rejectedArm(canonical, 'remote-arm-dispatch-failed'));
        }
      });
    } catch {
      this.#settleArm(operation, this.#rejectedArm(canonical, 'remote-arm-dispatch-failed'));
    }
    return operation.deferred.promise;
  }

  finalize(intent: RendezvousFinalizeIntent): Promise<RendezvousFinalizeReceipt> {
    const canonical = snapshotFinalizeIntent(intent);
    if (canonical === null) {
      return Promise.resolve(this.#rejectedFinalize(null, 'invalid-finalize-intent'));
    }
    if (canonical.recipientId !== this.participantId) {
      return Promise.resolve(this.#rejectedFinalize(canonical, 'remote-participant-mismatch'));
    }

    const active = this.#active;
    if (
      active === null ||
      active.retired ||
      !active.armAccepted ||
      !sameArmCorrelation(active.intent, canonical) ||
      active.intent.startAtRoomTimeMs !== canonical.startAtRoomTimeMs
    ) {
      return Promise.resolve(this.#rejectedFinalize(canonical, 'remote-rendezvous-not-armed'));
    }
    if (active.finalize !== null) {
      return sameFinalizeIntent(active.finalize.intent, canonical)
        ? active.finalize.deferred.promise
        : Promise.resolve(this.#rejectedFinalize(canonical, 'remote-finalize-conflict'));
    }

    const operation: FinalizeOperation = {
      intent: canonical,
      deferred: deferredReceipt<RendezvousFinalizeReceipt>(),
    };
    active.finalize = operation;
    try {
      const dispatched = this.#dispatchFinalize(canonical);
      this.#observeDispatchFailure(dispatched, () => {
        if (
          this.#active === active &&
          !active.retired &&
          active.finalize === operation &&
          !operation.deferred.settled
        ) {
          this.#settleFinalize(
            operation,
            this.#rejectedFinalize(canonical, 'remote-finalize-dispatch-failed'),
          );
        }
      });
    } catch {
      this.#settleFinalize(
        operation,
        this.#rejectedFinalize(canonical, 'remote-finalize-dispatch-failed'),
      );
    }
    return operation.deferred.promise;
  }

  /** Admits one untrusted arm receipt if it exactly matches the live request. */
  acceptArmReceipt(receipt: unknown): boolean {
    const canonical = snapshotArmReceipt(receipt);
    const active = this.#active;
    if (canonical === null || active === null || !this.#isLiveArm(active, canonical)) {
      return false;
    }
    const roomTime = this.#readRoomTimeMs();
    // The injected clock is application code and may synchronously cancel or
    // supersede this request. Never commit using authority captured before it.
    if (!this.#isLiveArm(active, canonical)) return false;
    if (!roomTime.ok) {
      this.#settleArm(active, this.#rejectedArm(active.intent, roomTime.reasonCode));
      return false;
    }
    if (
      roomTime.value > active.intent.finalizeByRoomTimeMs ||
      canonical.observedAtRoomTimeMs > active.intent.finalizeByRoomTimeMs
    ) {
      this.#settleArm(active, this.#rejectedArm(active.intent, 'remote-arm-receipt-late'));
      return false;
    }
    return this.#settleArm(active, canonical);
  }

  /** Admits one untrusted finalize receipt if it exactly matches the live request. */
  acceptFinalizeReceipt(receipt: unknown): boolean {
    const canonical = snapshotFinalizeReceipt(receipt);
    const active = this.#active;
    const operation = active?.finalize ?? null;
    if (
      canonical === null ||
      active === null ||
      operation === null ||
      !this.#isLiveFinalize(active, operation, canonical)
    ) {
      return false;
    }
    const roomTime = this.#readRoomTimeMs();
    if (!this.#isLiveFinalize(active, operation, canonical)) return false;
    if (!roomTime.ok) {
      this.#settleFinalize(
        operation,
        this.#rejectedFinalize(operation.intent, roomTime.reasonCode),
      );
      return false;
    }
    if (
      roomTime.value > operation.intent.startAtRoomTimeMs ||
      canonical.observedAtRoomTimeMs > operation.intent.startAtRoomTimeMs
    ) {
      this.#settleFinalize(
        operation,
        this.#rejectedFinalize(operation.intent, 'remote-finalize-receipt-late'),
      );
      return false;
    }
    return this.#settleFinalize(operation, canonical);
  }

  cancel(intent: FilePlaybackCancelIntent): Promise<void> {
    const canonical = snapshotCancelIntent(intent);
    const active = this.#active;
    if (canonical === null || active === null || !sameRevisionedRun(active.intent, canonical)) {
      return Promise.resolve();
    }

    this.#retire(active, 'remote-operation-cancelled');
    if (this.#active === active) this.#active = null;
    try {
      const dispatched = this.#dispatchCancel(canonical);
      this.#observeDispatchFailure(dispatched, () => undefined);
    } catch {
      // Cancellation is best-effort and must not wait for a broken transport.
    }
    return Promise.resolve();
  }

  #retire(operation: ActiveCorrelation, reasonCode: string): void {
    if (operation.retired) return;
    operation.retired = true;
    if (!operation.deferred.settled) {
      this.#settleArm(operation, this.#rejectedArm(operation.intent, reasonCode));
    }
    const finalize = operation.finalize;
    if (finalize !== null && !finalize.deferred.settled) {
      this.#settleFinalize(finalize, this.#rejectedFinalize(finalize.intent, reasonCode));
    }
  }

  #settleArm(operation: ActiveCorrelation, receipt: RendezvousArmReceipt): boolean {
    if (operation.deferred.settled) return false;
    operation.deferred.settled = true;
    operation.armAccepted = receipt.status === 'armed';
    operation.deferred.resolve(receipt);
    return true;
  }

  #settleFinalize(operation: FinalizeOperation, receipt: RendezvousFinalizeReceipt): boolean {
    if (operation.deferred.settled) return false;
    operation.deferred.settled = true;
    operation.deferred.resolve(receipt);
    return true;
  }

  #observeDispatchFailure(dispatched: unknown, onRejected: () => void): void {
    try {
      void Promise.resolve(dispatched).catch(() => onRejected());
    } catch {
      onRejected();
    }
  }

  #isLiveArm(operation: ActiveCorrelation, receipt: RendezvousArmReceipt): boolean {
    return (
      this.#active === operation &&
      !operation.retired &&
      !operation.deferred.settled &&
      armReceiptMatches(operation.intent, receipt)
    );
  }

  #isLiveFinalize(
    active: ActiveCorrelation,
    operation: FinalizeOperation,
    receipt: RendezvousFinalizeReceipt,
  ): boolean {
    return (
      this.#active === active &&
      !active.retired &&
      active.finalize === operation &&
      !operation.deferred.settled &&
      finalizeReceiptMatches(operation.intent, receipt)
    );
  }

  #canRememberRendezvous(intent: RendezvousArmIntent): boolean {
    if (this.#seenRun === null || !sameRevisionedRun(this.#seenRun, intent)) return true;
    return (
      !this.#seenRendezvousIds.has(intent.rendezvousId) &&
      this.#seenRendezvousIds.size < MAX_RENDEZVOUS_IDS_PER_RUN
    );
  }

  #rememberRendezvous(intent: RendezvousArmIntent): void {
    if (this.#seenRun === null || !sameRevisionedRun(this.#seenRun, intent)) {
      this.#seenRun = freezeCanonical({
        queueItemId: intent.queueItemId,
        runId: intent.runId,
        revision: intent.revision,
      });
      this.#seenRendezvousIds.clear();
    }
    this.#seenRendezvousIds.add(intent.rendezvousId);
  }

  #readRoomTimeMs(): RoomTimeRead {
    if (this.#readingRoomTime) {
      return { ok: false, reasonCode: 'remote-room-clock-invalid' };
    }
    this.#readingRoomTime = true;
    let current: number;
    try {
      current = this.#nowRoomTimeMs();
    } catch {
      return { ok: false, reasonCode: 'remote-room-clock-invalid' };
    } finally {
      this.#readingRoomTime = false;
    }
    if (
      !Number.isFinite(current) ||
      current < 0 ||
      (this.#lastRoomTimeMs !== null && current < this.#lastRoomTimeMs)
    ) {
      return { ok: false, reasonCode: 'remote-room-clock-invalid' };
    }
    this.#lastRoomTimeMs = current;
    return { ok: true, value: current };
  }

  #observedRoomTimeMs(): number {
    return this.#lastRoomTimeMs ?? 0;
  }

  #rejectedArm(intent: RendezvousArmIntent | null, reasonCode: string): RendezvousArmReceipt {
    return freezeCanonical({
      protocolVersion: 2 as const,
      kind: 'rendezvous-armed' as const,
      queueItemId: intent?.queueItemId ?? FALLBACK_QUEUE_ITEM_ID,
      runId: intent?.runId ?? FALLBACK_RUN_ID,
      revision: intent?.revision ?? 0,
      rendezvousId: intent?.rendezvousId ?? FALLBACK_RENDEZVOUS_ID,
      participantId: this.participantId,
      status: 'rejected' as const,
      observedAtRoomTimeMs: this.#observedRoomTimeMs(),
      bufferedAheadSeconds: 0,
      reasonCode: isBoundedIdentifier(reasonCode) ? reasonCode : 'remote-operation-rejected',
    });
  }

  #rejectedFinalize(
    intent: RendezvousFinalizeIntent | null,
    reasonCode: string,
  ): RendezvousFinalizeReceipt {
    return freezeCanonical({
      protocolVersion: 2 as const,
      kind: 'rendezvous-finalized' as const,
      queueItemId: intent?.queueItemId ?? FALLBACK_QUEUE_ITEM_ID,
      runId: intent?.runId ?? FALLBACK_RUN_ID,
      revision: intent?.revision ?? 0,
      rendezvousId: intent?.rendezvousId ?? FALLBACK_RENDEZVOUS_ID,
      participantId: this.participantId,
      status: 'rejected' as const,
      observedAtRoomTimeMs: this.#observedRoomTimeMs(),
      reasonCode: isBoundedIdentifier(reasonCode) ? reasonCode : 'remote-operation-rejected',
    });
  }
}

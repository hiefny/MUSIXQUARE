import type { QueueItemId } from '../types/index.ts';
import type { FilePlaybackCancelIntent } from './file-playback-source.ts';
import {
  createFilePlaybackWireMessage,
  FILE_PLAYBACK_WIRE_DEFAULT_MAX_CLOCK_SKEW_MS,
  type RendererHealthWireMessage,
} from './file-playback-wire.ts';
import { readPlaybackAttemptIdentity, type PlaybackAttemptIdentity } from './playback-identity.ts';
import {
  readRendezvousArmIntent,
  readRendezvousArmReceipt,
  readRendezvousFinalizeIntent,
  readRendezvousFinalizeReceipt,
  type RendezvousArmIntent,
  type RendezvousArmReceipt,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
  type RevisionedPlaybackRun,
} from './rendezvous-contract.ts';
import type { HostRendezvousParticipant } from './rendezvous-coordinator.ts';

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_RENDEZVOUS_IDS_PER_RUN = 256;
const MAX_RECEIPT_AUTHORITIES = 512;
const INVALID_METRIC_FALLBACK_MS = 2_500;
const FALLBACK_QUEUE_ITEM_ID = 'invalid-queue-item' as QueueItemId;
const FALLBACK_RUN_ID = 'invalid-run';
const FALLBACK_RENDEZVOUS_ID = 'invalid-rendezvous';
const OPTIONS_KEYS = Object.freeze([
  'participantId',
  'rendererEvidenceScope',
  'rttP95Ms',
  'armP95Ms',
  'nowRoomTimeMs',
  'dispatchArm',
  'dispatchFinalize',
  'dispatchCancel',
]);
const RENDERER_EVIDENCE_SCOPE_KEYS = Object.freeze([
  'sessionId',
  'connectionId',
  'recipientParticipantId',
  'sourceIdentity',
  'transferSessionId',
]);
const CANCEL_INTENT_KEYS = Object.freeze([
  'kind',
  'queueItemId',
  'runId',
  'revision',
  'rendezvousId',
  'reasonCode',
]);

export type RemoteRendezvousMetric = number | (() => number);

/**
 * Separates a receipt that changed rendezvous state from one that was safely
 * consumed after its authority expired, without weakening malformed or
 * unissued receipt handling.
 */
export type RemoteRendezvousReceiptAdmission =
  | Readonly<{ readonly disposition: 'accepted' }>
  | Readonly<{ readonly disposition: 'handled'; readonly reason: 'late' | 'stale' }>
  | Readonly<{
      readonly disposition: 'invalid';
      readonly reason:
        | 'malformed'
        | 'wrong-participant'
        | 'conflicting-authority'
        | 'unknown-authority';
    }>;

export interface RemoteRendererEvidenceScope {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly recipientParticipantId: string;
  readonly sourceIdentity: string;
  readonly transferSessionId: string | null;
}

export interface RemoteRendezvousParticipantOptions {
  readonly participantId: string;
  /**
   * Trusted media/connection scope owned by the channel constructing this
   * adapter. Recreate the adapter whenever any fixed scope field changes.
   */
  readonly rendererEvidenceScope: RemoteRendererEvidenceScope;
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
  finalizeAccepted: boolean;
  rendererStartEvidence: RendererHealthWireMessage | null;
  committed: boolean;
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

function isWireIdentifier(value: unknown): value is string {
  if (!isBoundedIdentifier(value) || value !== value.trim()) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
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

const RECEIPT_ACCEPTED: RemoteRendezvousReceiptAdmission = freezeCanonical({
  disposition: 'accepted' as const,
});
const RECEIPT_HANDLED_LATE: RemoteRendezvousReceiptAdmission = freezeCanonical({
  disposition: 'handled' as const,
  reason: 'late' as const,
});
const RECEIPT_HANDLED_STALE: RemoteRendezvousReceiptAdmission = freezeCanonical({
  disposition: 'handled' as const,
  reason: 'stale' as const,
});
const RECEIPT_INVALID_MALFORMED: RemoteRendezvousReceiptAdmission = freezeCanonical({
  disposition: 'invalid' as const,
  reason: 'malformed' as const,
});
const RECEIPT_INVALID_WRONG_PARTICIPANT: RemoteRendezvousReceiptAdmission = freezeCanonical({
  disposition: 'invalid' as const,
  reason: 'wrong-participant' as const,
});
const RECEIPT_INVALID_CONFLICTING_AUTHORITY: RemoteRendezvousReceiptAdmission = freezeCanonical({
  disposition: 'invalid' as const,
  reason: 'conflicting-authority' as const,
});
const RECEIPT_INVALID_UNKNOWN_AUTHORITY: RemoteRendezvousReceiptAdmission = freezeCanonical({
  disposition: 'invalid' as const,
  reason: 'unknown-authority' as const,
});

function snapshotCancelIntent(value: unknown): FilePlaybackCancelIntent | null {
  const snapshot = snapshotExactDataRecord(value, CANCEL_INTENT_KEYS);
  const attempt = readPlaybackAttemptIdentity(snapshot);
  if (
    snapshot === null ||
    snapshot.kind !== 'file-playback-cancel' ||
    !attempt ||
    !isBoundedIdentifier(snapshot.reasonCode)
  ) {
    return null;
  }
  return freezeCanonical({
    kind: 'file-playback-cancel' as const,
    ...attempt,
    reasonCode: snapshot.reasonCode,
  });
}

function readRendererHealthEvidence(value: unknown): RendererHealthWireMessage | null {
  try {
    const canonical = createFilePlaybackWireMessage(value as RendererHealthWireMessage);
    return canonical.kind === 'renderer-health' ? canonical : null;
  } catch {
    return null;
  }
}

function snapshotRendererEvidenceScope(value: unknown): RemoteRendererEvidenceScope | null {
  const snapshot = snapshotExactDataRecord(value, RENDERER_EVIDENCE_SCOPE_KEYS);
  if (
    snapshot === null ||
    !isWireIdentifier(snapshot.sessionId) ||
    !isWireIdentifier(snapshot.connectionId) ||
    !isWireIdentifier(snapshot.recipientParticipantId) ||
    !isWireIdentifier(snapshot.sourceIdentity) ||
    (snapshot.transferSessionId !== null && !isWireIdentifier(snapshot.transferSessionId))
  ) {
    return null;
  }
  return freezeCanonical({
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    recipientParticipantId: snapshot.recipientParticipantId,
    sourceIdentity: snapshot.sourceIdentity,
    transferSessionId: snapshot.transferSessionId,
  });
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
  readonly #rendererEvidenceScope: RemoteRendererEvidenceScope;
  readonly #nowRoomTimeMs: () => number;
  readonly #dispatchArm: (intent: RendezvousArmIntent) => unknown;
  readonly #dispatchFinalize: (intent: RendezvousFinalizeIntent) => unknown;
  readonly #dispatchCancel: (intent: FilePlaybackCancelIntent) => unknown;
  #active: ActiveCorrelation | null = null;
  #latestIdentity: LatestCorrelationIdentity | null = null;
  #seenRun: RevisionedPlaybackRun | null = null;
  readonly #seenRendezvousIds = new Set<string>();
  readonly #armReceiptAuthorities: RendezvousArmIntent[] = [];
  readonly #finalizeReceiptAuthorities: RendezvousFinalizeIntent[] = [];
  #lastRoomTimeMs: number | null = null;
  #readingRoomTime = false;
  #roomTimeReadReentered = false;
  #lastRendererEvidenceControlSequence: number | null = null;

  constructor(options: RemoteRendezvousParticipantOptions) {
    const canonical = snapshotExactDataRecord(options, OPTIONS_KEYS);
    if (canonical === null) {
      throw new TypeError('Remote rendezvous participant options must be exact own data');
    }
    if (!isBoundedIdentifier(canonical.participantId)) {
      throw new TypeError('participantId must be a non-empty bounded identifier');
    }
    const rendererEvidenceScope = snapshotRendererEvidenceScope(canonical.rendererEvidenceScope);
    if (rendererEvidenceScope === null) {
      throw new TypeError('rendererEvidenceScope must be exact trusted wire scope data');
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
    this.#rendererEvidenceScope = rendererEvidenceScope;
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
    const canonical = readRendezvousArmIntent(intent);
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
      finalizeAccepted: false,
      rendererStartEvidence: null,
      committed: false,
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
    this.#rememberArmReceiptAuthority(canonical);

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
    const canonical = readRendezvousFinalizeIntent(intent);
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
    this.#rememberFinalizeReceiptAuthority(canonical);
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

  /** Classifies and, when live, admits one untrusted arm receipt. */
  admitArmReceipt(receipt: unknown): RemoteRendezvousReceiptAdmission {
    const canonical = readRendezvousArmReceipt(receipt);
    if (canonical === null) return RECEIPT_INVALID_MALFORMED;
    if (canonical.participantId !== this.participantId) {
      return RECEIPT_INVALID_WRONG_PARTICIPANT;
    }
    const active = this.#active;
    if (active === null || !this.#isLiveArm(active, canonical)) {
      return this.#classifyInactiveArmReceipt(canonical);
    }
    const roomTime = this.#readRoomTimeMs();
    // The injected clock is application code and may synchronously cancel or
    // supersede this request. Never commit using authority captured before it.
    if (!this.#isLiveArm(active, canonical)) return this.#classifyInactiveArmReceipt(canonical);
    if (!roomTime.ok) {
      this.#settleArm(active, this.#rejectedArm(active.intent, roomTime.reasonCode));
      return RECEIPT_HANDLED_STALE;
    }
    if (
      roomTime.value > active.intent.finalizeByRoomTimeMs ||
      canonical.observedAtRoomTimeMs > active.intent.finalizeByRoomTimeMs
    ) {
      this.#settleArm(active, this.#rejectedArm(active.intent, 'remote-arm-receipt-late'));
      return RECEIPT_HANDLED_LATE;
    }
    return this.#settleArm(active, canonical) ? RECEIPT_ACCEPTED : RECEIPT_HANDLED_STALE;
  }

  /** Boolean compatibility view for coordinator and test harness callers. */
  acceptArmReceipt(receipt: unknown): boolean {
    return this.admitArmReceipt(receipt).disposition === 'accepted';
  }

  /** Classifies and, when live, admits one untrusted finalize receipt. */
  admitFinalizeReceipt(receipt: unknown): RemoteRendezvousReceiptAdmission {
    const canonical = readRendezvousFinalizeReceipt(receipt);
    if (canonical === null) return RECEIPT_INVALID_MALFORMED;
    if (canonical.participantId !== this.participantId) {
      return RECEIPT_INVALID_WRONG_PARTICIPANT;
    }
    const active = this.#active;
    const operation = active?.finalize ?? null;
    if (
      active === null ||
      operation === null ||
      !this.#isLiveFinalize(active, operation, canonical)
    ) {
      return this.#classifyInactiveFinalizeReceipt(canonical);
    }
    const roomTime = this.#readRoomTimeMs();
    if (!this.#isLiveFinalize(active, operation, canonical)) {
      return this.#classifyInactiveFinalizeReceipt(canonical);
    }
    if (!roomTime.ok) {
      this.#settleFinalize(
        operation,
        this.#rejectedFinalize(operation.intent, roomTime.reasonCode),
      );
      return RECEIPT_HANDLED_STALE;
    }
    if (
      roomTime.value > operation.intent.startAtRoomTimeMs ||
      canonical.observedAtRoomTimeMs > operation.intent.startAtRoomTimeMs
    ) {
      this.#settleFinalize(
        operation,
        this.#rejectedFinalize(operation.intent, 'remote-finalize-receipt-late'),
      );
      return RECEIPT_HANDLED_LATE;
    }
    const settled = this.#settleFinalize(operation, canonical);
    if (settled && canonical.status === 'accepted') active.finalizeAccepted = true;
    return settled ? RECEIPT_ACCEPTED : RECEIPT_HANDLED_STALE;
  }

  /** Boolean compatibility view for coordinator and test harness callers. */
  acceptFinalizeReceipt(receipt: unknown): boolean {
    return this.admitFinalizeReceipt(receipt).disposition === 'accepted';
  }

  /**
   * Admits the remote renderer's strongest available start attestation. This
   * is still a report from another device, not proof from its Web Audio
   * renderer internals, so the host binds it to one live finalized attempt and
   * a short room-clock lease before treating that participant as committed.
   */
  acceptRendererStartEvidence(evidence: unknown): boolean {
    const canonical = readRendererHealthEvidence(evidence);
    const active = this.#active;
    if (canonical === null || active === null || !this.#isLiveRendererEvidence(active, canonical)) {
      return false;
    }

    // A newer exact unhealthy report revokes an uncommitted lease even when
    // it arrives reentrantly from the host clock callback. Burn its sequence
    // before any clock read so the older healthy report cannot be resurrected.
    if (canonical.value === 'unhealthy') {
      this.#lastRendererEvidenceControlSequence = canonical.controlSequence;
      if (!active.committed) active.rendererStartEvidence = null;
      return false;
    }

    const roomTime = this.#readRoomTimeMs();
    // Application clock code may synchronously cancel, supersede, or re-enter
    // this participant. Revalidate the exact authority after it returns.
    if (!this.#isLiveRendererEvidence(active, canonical) || !roomTime.ok) return false;
    // AudioWorklet may render the exact target frame ahead of wall-clock
    // presentation, and two room-clock estimates may differ slightly. The
    // receiver already bounds both observations with this skew budget; reuse
    // it here while still failing closed outside the same temporal contract.
    if (
      canonical.observedAtRoomTimeMs + FILE_PLAYBACK_WIRE_DEFAULT_MAX_CLOCK_SKEW_MS <
        active.intent.startAtRoomTimeMs ||
      canonical.observedAtRoomTimeMs > roomTime.value + FILE_PLAYBACK_WIRE_DEFAULT_MAX_CLOCK_SKEW_MS
    ) {
      return false;
    }

    this.#lastRendererEvidenceControlSequence = canonical.controlSequence;
    if (canonical.leaseUntilRoomTimeMs <= roomTime.value) {
      if (!active.committed) active.rendererStartEvidence = null;
      return false;
    }

    active.rendererStartEvidence = canonical;
    return true;
  }

  cancel(intent: FilePlaybackCancelIntent): Promise<void> {
    const canonical = snapshotCancelIntent(intent);
    const active = this.#active;
    if (
      canonical === null ||
      active === null ||
      !sameRevisionedRun(active.intent, canonical) ||
      active.intent.rendezvousId !== canonical.rendezvousId
    ) {
      return Promise.resolve();
    }
    if (active.committed) return Promise.resolve();

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

  commitAttempt(value: PlaybackAttemptIdentity): boolean {
    const identity = readPlaybackAttemptIdentity(value);
    const active = this.#active;
    if (
      identity === null ||
      active === null ||
      active.retired ||
      !sameRevisionedRun(active.intent, identity) ||
      active.intent.rendezvousId !== identity.rendezvousId
    ) {
      return false;
    }
    if (active.committed) return true;

    const evidence = active.rendererStartEvidence;
    if (!active.finalizeAccepted || evidence === null) return false;
    const roomTime = this.#readRoomTimeMs();
    if (
      !roomTime.ok ||
      this.#active !== active ||
      active.retired ||
      active.committed ||
      !active.finalizeAccepted ||
      active.rendererStartEvidence !== evidence ||
      evidence.leaseUntilRoomTimeMs <= roomTime.value
    ) {
      return active.committed;
    }
    active.committed = true;
    return true;
  }

  #retire(operation: ActiveCorrelation, reasonCode: string): void {
    if (operation.retired) return;
    operation.retired = true;
    operation.rendererStartEvidence = null;
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

  #isLiveRendererEvidence(active: ActiveCorrelation, evidence: RendererHealthWireMessage): boolean {
    const scope = this.#rendererEvidenceScope;
    const lastSequence = this.#lastRendererEvidenceControlSequence;
    return (
      this.#active === active &&
      !active.retired &&
      active.finalizeAccepted &&
      (lastSequence === null || evidence.controlSequence > lastSequence) &&
      evidence.sessionId === scope.sessionId &&
      evidence.connectionId === scope.connectionId &&
      evidence.senderParticipantId === this.participantId &&
      evidence.recipientParticipantId === scope.recipientParticipantId &&
      evidence.sourceIdentity === scope.sourceIdentity &&
      evidence.transferSessionId === scope.transferSessionId &&
      sameRevisionedRun(active.intent, evidence) &&
      active.intent.rendezvousId === evidence.rendezvousId
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

  #rememberArmReceiptAuthority(intent: RendezvousArmIntent): void {
    this.#armReceiptAuthorities.push(intent);
    if (this.#armReceiptAuthorities.length > MAX_RECEIPT_AUTHORITIES) {
      this.#armReceiptAuthorities.shift();
    }
  }

  #rememberFinalizeReceiptAuthority(intent: RendezvousFinalizeIntent): void {
    this.#finalizeReceiptAuthorities.push(intent);
    if (this.#finalizeReceiptAuthorities.length > MAX_RECEIPT_AUTHORITIES) {
      this.#finalizeReceiptAuthorities.shift();
    }
  }

  #classifyInactiveArmReceipt(receipt: RendezvousArmReceipt): RemoteRendezvousReceiptAdmission {
    if (this.#armReceiptAuthorities.some((intent) => armReceiptMatches(intent, receipt))) {
      return RECEIPT_HANDLED_STALE;
    }
    if (
      this.#armReceiptAuthorities.some(
        (intent) =>
          intent.rendezvousId === receipt.rendezvousId || sameRevisionedRun(intent, receipt),
      )
    ) {
      return RECEIPT_INVALID_CONFLICTING_AUTHORITY;
    }
    return RECEIPT_INVALID_UNKNOWN_AUTHORITY;
  }

  #classifyInactiveFinalizeReceipt(
    receipt: RendezvousFinalizeReceipt,
  ): RemoteRendezvousReceiptAdmission {
    if (
      this.#finalizeReceiptAuthorities.some((intent) => finalizeReceiptMatches(intent, receipt))
    ) {
      return RECEIPT_HANDLED_STALE;
    }
    if (
      this.#finalizeReceiptAuthorities.some(
        (intent) =>
          intent.rendezvousId === receipt.rendezvousId || sameRevisionedRun(intent, receipt),
      )
    ) {
      return RECEIPT_INVALID_CONFLICTING_AUTHORITY;
    }
    return RECEIPT_INVALID_UNKNOWN_AUTHORITY;
  }

  #readRoomTimeMs(): RoomTimeRead {
    if (this.#readingRoomTime) {
      this.#roomTimeReadReentered = true;
      return { ok: false, reasonCode: 'remote-room-clock-invalid' };
    }
    this.#readingRoomTime = true;
    this.#roomTimeReadReentered = false;
    let current: number;
    try {
      current = this.#nowRoomTimeMs();
    } catch {
      return { ok: false, reasonCode: 'remote-room-clock-invalid' };
    } finally {
      this.#readingRoomTime = false;
    }
    if (this.#roomTimeReadReentered) {
      this.#roomTimeReadReentered = false;
      return { ok: false, reasonCode: 'remote-room-clock-invalid' };
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

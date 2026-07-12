import { calculateRendezvousLeadMs } from '../network/clock-estimator.ts';
import type { FilePlaybackCancelIntent } from './file-playback-source.ts';
import { readPlaybackStateIdentity } from './playback-identity.ts';
import {
  readRendezvousArmReceipt,
  readRendezvousFinalizeReceipt,
  validateRendezvousArmReceipt,
  validateRendezvousFinalization,
  validateRendezvousFinalizeReceipt,
  type RendezvousArmIntent,
  type RendezvousArmReceipt,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
  type RendezvousValidationCode,
  type RevisionedPlaybackRun,
} from './rendezvous-contract.ts';

/** Time reserved between the last host commit and the immutable start instant. */
export const RENDEZVOUS_FINALIZATION_GUARD_MS = 100;

const MAX_IDENTIFIER_LENGTH = 256;
const COORDINATOR_OPTION_KEYS = Object.freeze(['nowRoomTimeMs', 'createRendezvousId'] as const);

export interface HostRendezvousParticipant {
  readonly participantId: string;
  readonly rttP95Ms: number;
  readonly armP95Ms: number;
  arm(intent: RendezvousArmIntent): Promise<RendezvousArmReceipt>;
  finalize(intent: RendezvousFinalizeIntent): Promise<RendezvousFinalizeReceipt>;
  /** Best-effort retirement of an old target that may already be audible. */
  cancel?(intent: FilePlaybackCancelIntent): Promise<unknown> | unknown;
}

export interface StartHostRendezvousInput {
  readonly run: RevisionedPlaybackRun;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly participants: readonly HostRendezvousParticipant[];
}

export interface HostRendezvousCoordinatorOptions {
  /** Monotonic time translated into the shared room clock domain. */
  readonly nowRoomTimeMs: () => number;
  readonly createRendezvousId: () => string;
}

export type HostRendezvousAttemptStatus = 'open' | 'complete' | 'cancelled' | 'superseded';

export type RendezvousArmOutcomeStatus =
  | 'pending'
  | 'armed'
  | 'rejected'
  | 'invalid'
  | 'failed'
  | 'missed-deadline'
  | 'stale';

export type RendezvousFinalizeOutcomeStatus =
  | 'not-requested'
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'invalid'
  | 'failed'
  | 'missed-deadline'
  | 'stale';

export interface HostRendezvousParticipantOutcome {
  readonly participantId: string;
  readonly estimatedLeadMs: number;
  readonly bufferedAheadSeconds: number | null;
  readonly armStatus: RendezvousArmOutcomeStatus;
  readonly armLatencyMs: number | null;
  readonly armValidationCode: RendezvousValidationCode | null;
  readonly armReasonCode: string | null;
  readonly finalizeStatus: RendezvousFinalizeOutcomeStatus;
  readonly finalizeLatencyMs: number | null;
  readonly finalizeValidationCode: RendezvousValidationCode | null;
  readonly finalizeReasonCode: string | null;
}

export interface HostRendezvousAttemptSnapshot {
  readonly protocolVersion: 2;
  readonly status: HostRendezvousAttemptStatus;
  readonly reasonCode: string | null;
  readonly rendezvousId: string;
  readonly run: RevisionedPlaybackRun;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly createdAtRoomTimeMs: number;
  readonly leadTimeMs: number;
  readonly finalizeByRoomTimeMs: number;
  readonly startAtRoomTimeMs: number;
  readonly participants: readonly HostRendezvousParticipantOutcome[];
}

/**
 * An attempt is intentionally not PromiseLike. A permanently pending peer must
 * never prevent the host timeline or any healthy peer from progressing.
 */
export interface HostRendezvousAttempt {
  readonly rendezvousId: string;
  readonly startAtRoomTimeMs: number;
  readonly finalizeByRoomTimeMs: number;
  getSnapshot(): HostRendezvousAttemptSnapshot;
  /** Closes unresolved work after advancing the injected room clock. */
  expire(): HostRendezvousAttemptSnapshot;
  cancel(reasonCode?: string): HostRendezvousAttemptSnapshot;
}

interface MutableParticipantOutcome {
  readonly participant: HostRendezvousParticipant;
  readonly intent: RendezvousArmIntent;
  readonly estimatedLeadMs: number;
  readonly armDispatchedAtRoomTimeMs: number;
  bufferedAheadSeconds: number | null;
  armStatus: RendezvousArmOutcomeStatus;
  armLatencyMs: number | null;
  armValidationCode: RendezvousValidationCode | null;
  armReasonCode: string | null;
  finalizeStatus: RendezvousFinalizeOutcomeStatus;
  finalizeDispatchedAtRoomTimeMs: number | null;
  finalizeLatencyMs: number | null;
  finalizeValidationCode: RendezvousValidationCode | null;
  finalizeReasonCode: string | null;
}

interface ImmutableAttemptSchedule {
  readonly rendezvousId: string;
  readonly run: RevisionedPlaybackRun;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly createdAtRoomTimeMs: number;
  readonly leadTimeMs: number;
  readonly finalizeByRoomTimeMs: number;
  readonly startAtRoomTimeMs: number;
}

interface DetachedStartInput {
  readonly run: unknown;
  readonly positionSeconds: unknown;
  readonly playbackRate: unknown;
  readonly participants: unknown;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function snapshotCoordinatorOptions(
  value: unknown,
): Readonly<Record<(typeof COORDINATOR_OPTION_KEYS)[number], unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected: ReadonlySet<string> = new Set(COORDINATOR_OPTION_KEYS);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<
      (typeof COORDINATOR_OPTION_KEYS)[number],
      unknown
    >;
    for (const key of COORDINATOR_OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function readStartInput(input: unknown): DetachedStartInput {
  try {
    if (input === null || typeof input !== 'object') throw new TypeError();
    return Object.freeze({
      run: Reflect.get(input, 'run'),
      positionSeconds: Reflect.get(input, 'positionSeconds'),
      playbackRate: Reflect.get(input, 'playbackRate'),
      participants: Reflect.get(input, 'participants'),
    });
  } catch {
    throw new TypeError('Rendezvous start input is invalid');
  }
}

function snapshotParticipant(value: unknown): HostRendezvousParticipant {
  try {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      throw new TypeError();
    }
    const participantId = Reflect.get(value, 'participantId') as unknown;
    const rttP95Ms = Reflect.get(value, 'rttP95Ms') as unknown;
    const armP95Ms = Reflect.get(value, 'armP95Ms') as unknown;
    const arm = Reflect.get(value, 'arm') as unknown;
    const finalize = Reflect.get(value, 'finalize') as unknown;
    const cancel = Reflect.get(value, 'cancel') as unknown;
    if (
      !isBoundedIdentifier(participantId) ||
      typeof arm !== 'function' ||
      typeof finalize !== 'function' ||
      (cancel !== undefined && typeof cancel !== 'function')
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      participantId,
      rttP95Ms: rttP95Ms as number,
      armP95Ms: armP95Ms as number,
      arm: (intent: RendezvousArmIntent) =>
        Reflect.apply(arm, value, [intent]) as Promise<RendezvousArmReceipt>,
      finalize: (intent: RendezvousFinalizeIntent) =>
        Reflect.apply(finalize, value, [intent]) as Promise<RendezvousFinalizeReceipt>,
      ...(cancel === undefined
        ? {}
        : {
            cancel: (intent: FilePlaybackCancelIntent) => Reflect.apply(cancel, value, [intent]),
          }),
    });
  } catch {
    throw new TypeError('Rendezvous participant is invalid');
  }
}

function snapshotParticipants(value: unknown): readonly HostRendezvousParticipant[] {
  try {
    if (!Array.isArray(value)) throw new TypeError();
    const length = Reflect.get(value, 'length') as unknown;
    if (!Number.isSafeInteger(length) || (length as number) < 0) throw new TypeError();
    const participants: HostRendezvousParticipant[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      participants.push(snapshotParticipant(Reflect.get(value, String(index))));
    }
    return Object.freeze(participants);
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Rendezvous participant is invalid') {
      throw error;
    }
    throw new TypeError('Rendezvous participants must be an array', { cause: error });
  }
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function immutableRun(run: RevisionedPlaybackRun): RevisionedPlaybackRun {
  return Object.freeze({
    queueItemId: run.queueItemId,
    runId: run.runId,
    revision: run.revision,
  });
}

function mapArmValidationStatus(code: RendezvousValidationCode): RendezvousArmOutcomeStatus {
  if (code === 'arm-rejected') return 'rejected';
  if (code === 'arm-after-deadline') return 'missed-deadline';
  return 'invalid';
}

function mapFinalizeValidationStatus(
  code: RendezvousValidationCode,
): RendezvousFinalizeOutcomeStatus {
  if (code === 'finalization-rejected') return 'rejected';
  if (code === 'finalization-after-deadline') return 'missed-deadline';
  return 'invalid';
}

function immutableParticipantOutcome(
  outcome: MutableParticipantOutcome,
): HostRendezvousParticipantOutcome {
  return Object.freeze({
    participantId: outcome.participant.participantId,
    estimatedLeadMs: outcome.estimatedLeadMs,
    bufferedAheadSeconds: outcome.bufferedAheadSeconds,
    armStatus: outcome.armStatus,
    armLatencyMs: outcome.armLatencyMs,
    armValidationCode: outcome.armValidationCode,
    armReasonCode: outcome.armReasonCode,
    finalizeStatus: outcome.finalizeStatus,
    finalizeLatencyMs: outcome.finalizeLatencyMs,
    finalizeValidationCode: outcome.finalizeValidationCode,
    finalizeReasonCode: outcome.finalizeReasonCode,
  });
}

class ActiveHostRendezvousAttempt implements HostRendezvousAttempt {
  readonly #owner: HostRendezvousCoordinator;
  readonly #schedule: ImmutableAttemptSchedule;
  readonly #outcomes: MutableParticipantOutcome[];
  #status: HostRendezvousAttemptStatus = 'open';
  #reasonCode: string | null = null;

  constructor(
    owner: HostRendezvousCoordinator,
    schedule: ImmutableAttemptSchedule,
    participants: readonly HostRendezvousParticipant[],
    participantLeadTimesMs: readonly number[],
  ) {
    this.#owner = owner;
    this.#schedule = schedule;
    this.#outcomes = participants.map((participant, index) => ({
      participant,
      intent: Object.freeze({
        protocolVersion: 2,
        kind: 'rendezvous-arm',
        ...schedule.run,
        rendezvousId: schedule.rendezvousId,
        recipientId: participant.participantId,
        positionSeconds: schedule.positionSeconds,
        playbackRate: schedule.playbackRate,
        startAtRoomTimeMs: schedule.startAtRoomTimeMs,
        finalizeByRoomTimeMs: schedule.finalizeByRoomTimeMs,
      }),
      estimatedLeadMs: participantLeadTimesMs[index]!,
      armDispatchedAtRoomTimeMs: schedule.createdAtRoomTimeMs,
      bufferedAheadSeconds: null,
      armStatus: 'pending',
      armLatencyMs: null,
      armValidationCode: null,
      armReasonCode: null,
      finalizeStatus: 'not-requested',
      finalizeDispatchedAtRoomTimeMs: null,
      finalizeLatencyMs: null,
      finalizeValidationCode: null,
      finalizeReasonCode: null,
    }));
  }

  get rendezvousId(): string {
    return this.#schedule.rendezvousId;
  }

  get startAtRoomTimeMs(): number {
    return this.#schedule.startAtRoomTimeMs;
  }

  get finalizeByRoomTimeMs(): number {
    return this.#schedule.finalizeByRoomTimeMs;
  }

  get revision(): number {
    return this.#schedule.run.revision;
  }

  dispatch(): void {
    for (const outcome of this.#outcomes) {
      if (this.#status !== 'open' || !this.#owner.isActive(this)) break;
      let pending: Promise<RendezvousArmReceipt>;
      try {
        pending = outcome.participant.arm(outcome.intent);
      } catch {
        this.#recordArmFailure(outcome, 'arm-call-failed');
        continue;
      }

      void Promise.resolve(pending).then(
        (receipt) => this.#receiveArmReceipt(outcome, receipt),
        () => this.#recordArmFailure(outcome, 'arm-promise-rejected'),
      );
    }
    this.#refreshCompletion();
  }

  getSnapshot(): HostRendezvousAttemptSnapshot {
    const participants = Object.freeze(this.#outcomes.map(immutableParticipantOutcome));
    return Object.freeze({
      protocolVersion: 2,
      status: this.#status,
      reasonCode: this.#reasonCode,
      rendezvousId: this.#schedule.rendezvousId,
      run: this.#schedule.run,
      positionSeconds: this.#schedule.positionSeconds,
      playbackRate: this.#schedule.playbackRate,
      createdAtRoomTimeMs: this.#schedule.createdAtRoomTimeMs,
      leadTimeMs: this.#schedule.leadTimeMs,
      finalizeByRoomTimeMs: this.#schedule.finalizeByRoomTimeMs,
      startAtRoomTimeMs: this.#schedule.startAtRoomTimeMs,
      participants,
    });
  }

  expire(): HostRendezvousAttemptSnapshot {
    if (this.#status !== 'open') return this.getSnapshot();
    const now = this.#owner.tryReadRoomTimeMs();
    if (now === null) {
      this.#closePending('cancelled', 'invalid-room-clock');
      return this.getSnapshot();
    }

    if (now > this.#schedule.finalizeByRoomTimeMs) {
      for (const outcome of this.#outcomes) {
        if (outcome.armStatus === 'pending') {
          outcome.armStatus = 'missed-deadline';
          outcome.armLatencyMs = now - outcome.armDispatchedAtRoomTimeMs;
          outcome.armValidationCode = 'arm-after-deadline';
          outcome.armReasonCode = 'arm-receipt-not-received';
          outcome.finalizeStatus = 'missed-deadline';
          outcome.finalizeReasonCode = 'arm-receipt-not-received';
        }
      }
    }

    if (now > this.#schedule.startAtRoomTimeMs) {
      for (const outcome of this.#outcomes) {
        if (outcome.finalizeStatus === 'pending') {
          outcome.finalizeStatus = 'missed-deadline';
          outcome.finalizeLatencyMs =
            outcome.finalizeDispatchedAtRoomTimeMs === null
              ? null
              : now - outcome.finalizeDispatchedAtRoomTimeMs;
          outcome.finalizeValidationCode = 'finalization-after-deadline';
          outcome.finalizeReasonCode = 'finalize-receipt-not-received';
        }
      }
    }

    this.#refreshCompletion();
    return this.getSnapshot();
  }

  cancel(reasonCode = 'cancelled-by-host'): HostRendezvousAttemptSnapshot {
    if (!isBoundedIdentifier(reasonCode)) {
      throw new TypeError('Rendezvous cancellation reason is invalid');
    }
    if (this.#status !== 'cancelled' && this.#status !== 'superseded') {
      this.#cancelArmedParticipants(reasonCode);
      this.#closePending('cancelled', reasonCode);
    }
    return this.getSnapshot();
  }

  supersede(): void {
    if (this.#status === 'cancelled' || this.#status === 'superseded') return;
    this.#cancelArmedParticipants('newer-rendezvous');
    this.#closePending('superseded', 'newer-rendezvous');
  }

  #cancelArmedParticipants(reasonCode: string): void {
    const intent: FilePlaybackCancelIntent = Object.freeze({
      kind: 'file-playback-cancel',
      ...this.#schedule.run,
      reasonCode,
    });
    for (const outcome of this.#outcomes) {
      if (outcome.armStatus !== 'armed' || typeof outcome.participant.cancel !== 'function') {
        continue;
      }
      try {
        const pending = Promise.resolve(outcome.participant.cancel(intent));
        void pending.catch(() => undefined);
      } catch {
        // Retirement is best-effort. A broken peer must not block the new run.
      }
    }
  }

  #receiveArmReceipt(outcome: MutableParticipantOutcome, receipt: unknown): void {
    if (outcome.armStatus !== 'pending') return;
    const receivedAtRoomTimeMs = this.#owner.tryReadRoomTimeMs();
    outcome.armLatencyMs =
      receivedAtRoomTimeMs === null
        ? null
        : receivedAtRoomTimeMs - outcome.armDispatchedAtRoomTimeMs;

    if (!this.#owner.isActive(this) || this.#status !== 'open') {
      outcome.armStatus = 'stale';
      outcome.armReasonCode = 'rendezvous-not-active';
      outcome.finalizeStatus = 'stale';
      outcome.finalizeReasonCode = 'rendezvous-not-active';
      this.#refreshCompletion();
      return;
    }
    if (receivedAtRoomTimeMs === null) {
      outcome.armStatus = 'failed';
      outcome.armReasonCode = 'invalid-room-clock';
      this.#refreshCompletion();
      return;
    }

    const candidate = readRendezvousArmReceipt(receipt);
    // Reading an untrusted Proxy can re-enter the coordinator. Never let the
    // older receipt commit after cancellation, supersession, or another
    // receipt has already advanced this participant outcome.
    if (outcome.armStatus !== 'pending' || !this.#owner.isActive(this) || this.#status !== 'open') {
      return;
    }
    const armValidation = candidate
      ? validateRendezvousArmReceipt(outcome.intent, candidate)
      : ({ ok: false, code: 'invalid-contract' } as const);
    if (!armValidation.ok) {
      outcome.armStatus = mapArmValidationStatus(armValidation.code);
      outcome.armValidationCode = armValidation.code;
      outcome.armReasonCode = candidate?.reasonCode ?? armValidation.code;
      this.#refreshCompletion();
      return;
    }
    if (!candidate) return;

    outcome.armStatus = 'armed';
    outcome.bufferedAheadSeconds = candidate.bufferedAheadSeconds;
    const finalizeIntent: RendezvousFinalizeIntent = Object.freeze({
      protocolVersion: 2,
      kind: 'rendezvous-finalize',
      ...this.#schedule.run,
      rendezvousId: this.#schedule.rendezvousId,
      recipientId: outcome.participant.participantId,
      startAtRoomTimeMs: this.#schedule.startAtRoomTimeMs,
      finalizedAtRoomTimeMs: receivedAtRoomTimeMs,
    });
    const finalizationValidation = validateRendezvousFinalization(
      outcome.intent,
      candidate,
      finalizeIntent,
      receivedAtRoomTimeMs,
    );
    if (!finalizationValidation.ok) {
      outcome.finalizeStatus = mapFinalizeValidationStatus(finalizationValidation.code);
      outcome.finalizeValidationCode = finalizationValidation.code;
      outcome.finalizeReasonCode = finalizationValidation.code;
      this.#refreshCompletion();
      return;
    }

    outcome.finalizeStatus = 'pending';
    outcome.finalizeDispatchedAtRoomTimeMs = receivedAtRoomTimeMs;
    let pending: Promise<RendezvousFinalizeReceipt>;
    try {
      pending = outcome.participant.finalize(finalizeIntent);
    } catch {
      this.#recordFinalizeFailure(outcome, 'finalize-call-failed');
      return;
    }
    void Promise.resolve(pending).then(
      (finalizeReceipt) => this.#receiveFinalizeReceipt(outcome, finalizeIntent, finalizeReceipt),
      () => this.#recordFinalizeFailure(outcome, 'finalize-promise-rejected'),
    );
  }

  #receiveFinalizeReceipt(
    outcome: MutableParticipantOutcome,
    intent: RendezvousFinalizeIntent,
    receipt: unknown,
  ): void {
    if (outcome.finalizeStatus !== 'pending') return;
    const receivedAtRoomTimeMs = this.#owner.tryReadRoomTimeMs();
    outcome.finalizeLatencyMs =
      receivedAtRoomTimeMs === null || outcome.finalizeDispatchedAtRoomTimeMs === null
        ? null
        : receivedAtRoomTimeMs - outcome.finalizeDispatchedAtRoomTimeMs;

    if (!this.#owner.isActive(this) || this.#status !== 'open') {
      outcome.finalizeStatus = 'stale';
      outcome.finalizeReasonCode = 'rendezvous-not-active';
      this.#refreshCompletion();
      return;
    }
    if (receivedAtRoomTimeMs === null) {
      outcome.finalizeStatus = 'failed';
      outcome.finalizeReasonCode = 'invalid-room-clock';
      this.#refreshCompletion();
      return;
    }

    const candidate = readRendezvousFinalizeReceipt(receipt);
    // Receipt canonicalization may execute Proxy traps. Re-check the live
    // authority before allowing the pre-canonicalization attempt to settle.
    if (
      outcome.finalizeStatus !== 'pending' ||
      !this.#owner.isActive(this) ||
      this.#status !== 'open'
    ) {
      return;
    }
    const validation = candidate
      ? validateRendezvousFinalizeReceipt(intent, candidate)
      : ({ ok: false, code: 'invalid-contract' } as const);
    if (!validation.ok) {
      outcome.finalizeStatus = mapFinalizeValidationStatus(validation.code);
      outcome.finalizeValidationCode = validation.code;
      outcome.finalizeReasonCode = candidate?.reasonCode ?? validation.code;
    } else {
      outcome.finalizeStatus = 'accepted';
      outcome.finalizeReasonCode = null;
    }
    this.#refreshCompletion();
  }

  #recordArmFailure(outcome: MutableParticipantOutcome, reasonCode: string): void {
    if (outcome.armStatus !== 'pending') return;
    const receivedAtRoomTimeMs = this.#owner.tryReadRoomTimeMs();
    outcome.armLatencyMs =
      receivedAtRoomTimeMs === null
        ? null
        : receivedAtRoomTimeMs - outcome.armDispatchedAtRoomTimeMs;
    outcome.armStatus = this.#owner.isActive(this) && this.#status === 'open' ? 'failed' : 'stale';
    outcome.armReasonCode = outcome.armStatus === 'stale' ? 'rendezvous-not-active' : reasonCode;
    if (outcome.armStatus === 'stale') {
      outcome.finalizeStatus = 'stale';
      outcome.finalizeReasonCode = 'rendezvous-not-active';
    }
    this.#refreshCompletion();
  }

  #recordFinalizeFailure(outcome: MutableParticipantOutcome, reasonCode: string): void {
    if (outcome.finalizeStatus !== 'pending') return;
    const receivedAtRoomTimeMs = this.#owner.tryReadRoomTimeMs();
    outcome.finalizeLatencyMs =
      receivedAtRoomTimeMs === null || outcome.finalizeDispatchedAtRoomTimeMs === null
        ? null
        : receivedAtRoomTimeMs - outcome.finalizeDispatchedAtRoomTimeMs;
    outcome.finalizeStatus =
      this.#owner.isActive(this) && this.#status === 'open' ? 'failed' : 'stale';
    outcome.finalizeReasonCode =
      outcome.finalizeStatus === 'stale' ? 'rendezvous-not-active' : reasonCode;
    this.#refreshCompletion();
  }

  #closePending(
    status: Extract<HostRendezvousAttemptStatus, 'cancelled' | 'superseded'>,
    reasonCode: string,
  ): void {
    this.#status = status;
    this.#reasonCode = reasonCode;
    for (const outcome of this.#outcomes) {
      if (outcome.armStatus === 'pending') {
        outcome.armStatus = 'stale';
        outcome.armReasonCode = reasonCode;
      }
      if (outcome.finalizeStatus === 'pending' || outcome.armStatus === 'stale') {
        outcome.finalizeStatus = 'stale';
        outcome.finalizeReasonCode = reasonCode;
      }
    }
  }

  #refreshCompletion(): void {
    if (this.#status !== 'open') return;
    const settled = this.#outcomes.every(
      (outcome) => outcome.armStatus !== 'pending' && outcome.finalizeStatus !== 'pending',
    );
    if (settled) this.#status = 'complete';
  }
}

/**
 * Transport-agnostic host barrier. It publishes one immutable target and then
 * advances each participant independently as its own asynchronous work settles.
 */
export class HostRendezvousCoordinator {
  readonly #nowRoomTimeMs: () => number;
  readonly #createRendezvousId: () => string;
  #lastRoomTimeMs: number | null = null;
  #active: ActiveHostRendezvousAttempt | null = null;
  #mutationEpoch = 0;

  constructor(options: HostRendezvousCoordinatorOptions) {
    const snapshot = snapshotCoordinatorOptions(options);
    if (!snapshot) throw new TypeError('Rendezvous coordinator options are invalid');
    if (typeof snapshot.nowRoomTimeMs !== 'function') {
      throw new TypeError('nowRoomTimeMs must be a function');
    }
    if (typeof snapshot.createRendezvousId !== 'function') {
      throw new TypeError('createRendezvousId must be a function');
    }
    this.#nowRoomTimeMs = snapshot.nowRoomTimeMs as () => number;
    this.#createRendezvousId = snapshot.createRendezvousId as () => string;
  }

  start(input: StartHostRendezvousInput): HostRendezvousAttempt {
    const mutationEpoch = this.#advanceMutationEpoch();
    const detachedInput = readStartInput(input);
    const run = readPlaybackStateIdentity(detachedInput.run);
    if (!run) {
      throw new TypeError('Rendezvous playback run is invalid');
    }
    this.#assertMutationEpoch(mutationEpoch);
    if (this.#active && run.revision <= this.#active.revision) {
      throw new RangeError('Rendezvous revision must be newer than the previous attempt');
    }
    if (typeof detachedInput.positionSeconds !== 'number') {
      throw new TypeError('Rendezvous position must be a number');
    }
    const positionSeconds = detachedInput.positionSeconds;
    assertFiniteNonNegative(positionSeconds, 'Rendezvous position');
    if (
      typeof detachedInput.playbackRate !== 'number' ||
      !Number.isFinite(detachedInput.playbackRate) ||
      detachedInput.playbackRate <= 0
    ) {
      throw new RangeError('Rendezvous playback rate must be a finite positive number');
    }
    const playbackRate = detachedInput.playbackRate;

    const participants = snapshotParticipants(detachedInput.participants);
    const participantIds = new Set<string>();
    const participantLeadTimesMs = participants.map((participant) => {
      if (participantIds.has(participant.participantId)) {
        throw new TypeError('Rendezvous participant IDs must be unique');
      }
      participantIds.add(participant.participantId);
      return calculateRendezvousLeadMs(participant.rttP95Ms, participant.armP95Ms);
    });
    this.#assertMutationEpoch(mutationEpoch);

    const createdAtRoomTimeMs = this.#readRoomTimeMs();
    this.#assertMutationEpoch(mutationEpoch);
    const rendezvousId = this.#createRendezvousId();
    this.#assertMutationEpoch(mutationEpoch);
    if (!isBoundedIdentifier(rendezvousId)) {
      throw new TypeError('Generated rendezvous ID is invalid');
    }
    if (this.#active?.rendezvousId === rendezvousId) {
      throw new Error('Generated rendezvous ID must differ from the active attempt');
    }

    const leadTimeMs = Math.max(calculateRendezvousLeadMs(0, 0), ...participantLeadTimesMs);
    const startAtRoomTimeMs = createdAtRoomTimeMs + leadTimeMs;
    if (!Number.isFinite(startAtRoomTimeMs)) {
      throw new RangeError('Rendezvous schedule overflowed');
    }
    const schedule: ImmutableAttemptSchedule = Object.freeze({
      rendezvousId,
      run: immutableRun(run),
      positionSeconds,
      playbackRate,
      createdAtRoomTimeMs,
      leadTimeMs,
      finalizeByRoomTimeMs: startAtRoomTimeMs - RENDEZVOUS_FINALIZATION_GUARD_MS,
      startAtRoomTimeMs,
    });
    const attempt = new ActiveHostRendezvousAttempt(
      this,
      schedule,
      participants,
      participantLeadTimesMs,
    );

    this.#assertMutationEpoch(mutationEpoch);
    if (this.#active && run.revision <= this.#active.revision) {
      throw new RangeError('Rendezvous revision was superseded during start');
    }
    const previous = this.#active;
    this.#active = attempt;
    previous?.supersede();
    if (this.#active === attempt && this.#mutationEpoch === mutationEpoch) {
      attempt.dispatch();
    }
    return attempt;
  }

  cancelActive(reasonCode?: string): HostRendezvousAttemptSnapshot | null {
    this.#advanceMutationEpoch();
    return this.#active?.cancel(reasonCode) ?? null;
  }

  isActive(attempt: ActiveHostRendezvousAttempt): boolean {
    return this.#active === attempt;
  }

  tryReadRoomTimeMs(): number | null {
    try {
      return this.#readRoomTimeMs();
    } catch {
      return null;
    }
  }

  #readRoomTimeMs(): number {
    const current = this.#nowRoomTimeMs();
    assertFiniteNonNegative(current, 'Room time');
    if (this.#lastRoomTimeMs !== null && current < this.#lastRoomTimeMs) {
      throw new RangeError('Room time must not move backwards');
    }
    this.#lastRoomTimeMs = current;
    return current;
  }

  #advanceMutationEpoch(): number {
    this.#mutationEpoch =
      this.#mutationEpoch === Number.MAX_SAFE_INTEGER ? 0 : this.#mutationEpoch + 1;
    return this.#mutationEpoch;
  }

  #assertMutationEpoch(expected: number): void {
    if (this.#mutationEpoch !== expected) {
      throw new Error('Rendezvous start was superseded during validation');
    }
  }
}

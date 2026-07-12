import { calculateRendezvousLeadMs } from '../network/clock-estimator.ts';
import type { FilePlaybackCancelIntent } from './file-playback-source.ts';
import {
  isRevisionedPlaybackRun,
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

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function readReasonCode(value: unknown): string | null {
  try {
    if (!value || typeof value !== 'object') return null;
    const reasonCode = (value as Record<string, unknown>).reasonCode;
    return isBoundedIdentifier(reasonCode) ? reasonCode : null;
  } catch {
    return null;
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

    const candidate = receipt as RendezvousArmReceipt;
    const armValidation = validateRendezvousArmReceipt(outcome.intent, candidate);
    if (!armValidation.ok) {
      outcome.armStatus = mapArmValidationStatus(armValidation.code);
      outcome.armValidationCode = armValidation.code;
      outcome.armReasonCode = readReasonCode(receipt) ?? armValidation.code;
      this.#refreshCompletion();
      return;
    }

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

    const validation = validateRendezvousFinalizeReceipt(
      intent,
      receipt as RendezvousFinalizeReceipt,
    );
    if (!validation.ok) {
      outcome.finalizeStatus = mapFinalizeValidationStatus(validation.code);
      outcome.finalizeValidationCode = validation.code;
      outcome.finalizeReasonCode = readReasonCode(receipt) ?? validation.code;
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

  constructor(options: HostRendezvousCoordinatorOptions) {
    if (typeof options.nowRoomTimeMs !== 'function') {
      throw new TypeError('nowRoomTimeMs must be a function');
    }
    if (typeof options.createRendezvousId !== 'function') {
      throw new TypeError('createRendezvousId must be a function');
    }
    this.#nowRoomTimeMs = options.nowRoomTimeMs;
    this.#createRendezvousId = options.createRendezvousId;
  }

  start(input: StartHostRendezvousInput): HostRendezvousAttempt {
    if (!isRevisionedPlaybackRun(input.run)) {
      throw new TypeError('Rendezvous playback run is invalid');
    }
    if (this.#active && input.run.revision <= this.#active.revision) {
      throw new RangeError('Rendezvous revision must be newer than the previous attempt');
    }
    assertFiniteNonNegative(input.positionSeconds, 'Rendezvous position');
    if (!Number.isFinite(input.playbackRate) || input.playbackRate <= 0) {
      throw new RangeError('Rendezvous playback rate must be a finite positive number');
    }
    if (!Array.isArray(input.participants)) {
      throw new TypeError('Rendezvous participants must be an array');
    }

    const participants = [...input.participants];
    const participantIds = new Set<string>();
    const participantLeadTimesMs = participants.map((participant) => {
      if (!isBoundedIdentifier(participant.participantId)) {
        throw new TypeError('Rendezvous participant ID is invalid');
      }
      if (participantIds.has(participant.participantId)) {
        throw new TypeError('Rendezvous participant IDs must be unique');
      }
      if (typeof participant.arm !== 'function' || typeof participant.finalize !== 'function') {
        throw new TypeError('Rendezvous participant callbacks are invalid');
      }
      if (participant.cancel !== undefined && typeof participant.cancel !== 'function') {
        throw new TypeError('Rendezvous participant cancel callback is invalid');
      }
      participantIds.add(participant.participantId);
      return calculateRendezvousLeadMs(participant.rttP95Ms, participant.armP95Ms);
    });

    const createdAtRoomTimeMs = this.#readRoomTimeMs();
    const rendezvousId = this.#createRendezvousId();
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
      run: immutableRun(input.run),
      positionSeconds: input.positionSeconds,
      playbackRate: input.playbackRate,
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

    this.#active?.supersede();
    this.#active = attempt;
    attempt.dispatch();
    return attempt;
  }

  cancelActive(reasonCode?: string): HostRendezvousAttemptSnapshot | null {
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
}

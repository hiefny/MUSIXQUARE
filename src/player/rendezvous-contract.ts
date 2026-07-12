import {
  isPlaybackRevision,
  isPlaybackRunIdentity,
  samePlaybackRun,
  type PlaybackRevision,
  type PlaybackRunIdentity,
} from './playback-timeline.ts';

export type RendezvousId = string;
export type RendezvousParticipantId = string;

export interface RevisionedPlaybackRun extends PlaybackRunIdentity {
  readonly revision: PlaybackRevision;
}

interface RendezvousIdentity extends RevisionedPlaybackRun {
  readonly protocolVersion: 2;
  readonly rendezvousId: RendezvousId;
}

/** Host request for one participant to prime and arm its local source. */
export interface RendezvousArmIntent extends RendezvousIdentity {
  readonly kind: 'rendezvous-arm';
  readonly recipientId: RendezvousParticipantId;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly startAtRoomTimeMs: number;
  readonly finalizeByRoomTimeMs: number;
}

/** Participant response after its local engine is ready for final commit. */
export interface RendezvousArmReceipt extends RendezvousIdentity {
  readonly kind: 'rendezvous-armed';
  readonly participantId: RendezvousParticipantId;
  readonly status: 'armed' | 'rejected';
  readonly observedAtRoomTimeMs: number;
  readonly bufferedAheadSeconds: number;
  readonly reasonCode: string | null;
}

/** Host's final, immutable commit for the previously armed start instant. */
export interface RendezvousFinalizeIntent extends RendezvousIdentity {
  readonly kind: 'rendezvous-finalize';
  readonly recipientId: RendezvousParticipantId;
  readonly startAtRoomTimeMs: number;
  readonly finalizedAtRoomTimeMs: number;
}

/** Participant confirmation that the final commit was accepted locally. */
export interface RendezvousFinalizeReceipt extends RendezvousIdentity {
  readonly kind: 'rendezvous-finalized';
  readonly participantId: RendezvousParticipantId;
  readonly status: 'accepted' | 'missed-deadline' | 'rejected';
  readonly observedAtRoomTimeMs: number;
  readonly reasonCode: string | null;
}

export type RendezvousValidationCode =
  | 'invalid-contract'
  | 'identity-mismatch'
  | 'revision-mismatch'
  | 'rendezvous-mismatch'
  | 'participant-mismatch'
  | 'schedule-mismatch'
  | 'arm-rejected'
  | 'arm-after-deadline'
  | 'finalization-after-deadline'
  | 'finalization-rejected';

export type RendezvousValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RendezvousValidationCode };

const MAX_ID_LENGTH = 256;
const valid: RendezvousValidationResult = Object.freeze({ ok: true });

function invalid(code: RendezvousValidationCode): RendezvousValidationResult {
  return { ok: false, code };
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasValidIdentity(value: RendezvousIdentity): boolean {
  return (
    value.protocolVersion === 2 &&
    isPlaybackRunIdentity(value) &&
    isPlaybackRevision(value.revision) &&
    isBoundedIdentifier(value.rendezvousId)
  );
}

export function isRevisionedPlaybackRun(value: unknown): value is RevisionedPlaybackRun {
  return (
    !!value &&
    typeof value === 'object' &&
    isPlaybackRunIdentity(value) &&
    isPlaybackRevision((value as unknown as Record<string, unknown>).revision)
  );
}

export function isRendezvousArmIntent(value: unknown): value is RendezvousArmIntent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as RendezvousArmIntent;
  return (
    candidate.kind === 'rendezvous-arm' &&
    hasValidIdentity(candidate) &&
    isBoundedIdentifier(candidate.recipientId) &&
    isFiniteNonNegative(candidate.positionSeconds) &&
    typeof candidate.playbackRate === 'number' &&
    Number.isFinite(candidate.playbackRate) &&
    candidate.playbackRate > 0 &&
    isFiniteNonNegative(candidate.startAtRoomTimeMs) &&
    isFiniteNonNegative(candidate.finalizeByRoomTimeMs) &&
    candidate.finalizeByRoomTimeMs <= candidate.startAtRoomTimeMs
  );
}

export function isRendezvousArmReceipt(value: unknown): value is RendezvousArmReceipt {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as RendezvousArmReceipt;
  return (
    candidate.kind === 'rendezvous-armed' &&
    hasValidIdentity(candidate) &&
    isBoundedIdentifier(candidate.participantId) &&
    (candidate.status === 'armed' || candidate.status === 'rejected') &&
    isFiniteNonNegative(candidate.observedAtRoomTimeMs) &&
    isFiniteNonNegative(candidate.bufferedAheadSeconds) &&
    (candidate.reasonCode === null || isBoundedIdentifier(candidate.reasonCode))
  );
}

export function isRendezvousFinalizeIntent(value: unknown): value is RendezvousFinalizeIntent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as RendezvousFinalizeIntent;
  return (
    candidate.kind === 'rendezvous-finalize' &&
    hasValidIdentity(candidate) &&
    isBoundedIdentifier(candidate.recipientId) &&
    isFiniteNonNegative(candidate.startAtRoomTimeMs) &&
    isFiniteNonNegative(candidate.finalizedAtRoomTimeMs) &&
    candidate.finalizedAtRoomTimeMs <= candidate.startAtRoomTimeMs
  );
}

export function isRendezvousFinalizeReceipt(value: unknown): value is RendezvousFinalizeReceipt {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as RendezvousFinalizeReceipt;
  return (
    candidate.kind === 'rendezvous-finalized' &&
    hasValidIdentity(candidate) &&
    isBoundedIdentifier(candidate.participantId) &&
    (candidate.status === 'accepted' ||
      candidate.status === 'missed-deadline' ||
      candidate.status === 'rejected') &&
    isFiniteNonNegative(candidate.observedAtRoomTimeMs) &&
    (candidate.reasonCode === null || isBoundedIdentifier(candidate.reasonCode))
  );
}

function validateMatchingIdentity(
  expected: RendezvousIdentity,
  actual: RendezvousIdentity,
): RendezvousValidationResult {
  if (!samePlaybackRun(expected, actual)) return invalid('identity-mismatch');
  if (expected.revision !== actual.revision) return invalid('revision-mismatch');
  if (expected.rendezvousId !== actual.rendezvousId) return invalid('rendezvous-mismatch');
  return valid;
}

export function validateRendezvousArmReceipt(
  intent: RendezvousArmIntent,
  receipt: RendezvousArmReceipt,
): RendezvousValidationResult {
  if (!isRendezvousArmIntent(intent) || !isRendezvousArmReceipt(receipt)) {
    return invalid('invalid-contract');
  }
  const identity = validateMatchingIdentity(intent, receipt);
  if (!identity.ok) return identity;
  if (intent.recipientId !== receipt.participantId) return invalid('participant-mismatch');
  if (receipt.status !== 'armed') return invalid('arm-rejected');
  if (receipt.observedAtRoomTimeMs > intent.finalizeByRoomTimeMs) {
    return invalid('arm-after-deadline');
  }
  return valid;
}

export function validateRendezvousFinalization(
  armIntent: RendezvousArmIntent,
  armReceipt: RendezvousArmReceipt,
  finalizeIntent: RendezvousFinalizeIntent,
  receivedAtRoomTimeMs: number,
): RendezvousValidationResult {
  if (
    !isRendezvousArmIntent(armIntent) ||
    !isRendezvousArmReceipt(armReceipt) ||
    !isRendezvousFinalizeIntent(finalizeIntent) ||
    !isFiniteNonNegative(receivedAtRoomTimeMs)
  ) {
    return invalid('invalid-contract');
  }
  const armed = validateRendezvousArmReceipt(armIntent, armReceipt);
  if (!armed.ok) return armed;
  const identity = validateMatchingIdentity(armIntent, finalizeIntent);
  if (!identity.ok) return identity;
  if (
    armIntent.recipientId !== finalizeIntent.recipientId ||
    armReceipt.participantId !== finalizeIntent.recipientId
  ) {
    return invalid('participant-mismatch');
  }
  if (armIntent.startAtRoomTimeMs !== finalizeIntent.startAtRoomTimeMs) {
    return invalid('schedule-mismatch');
  }
  if (
    finalizeIntent.finalizedAtRoomTimeMs > armIntent.finalizeByRoomTimeMs ||
    receivedAtRoomTimeMs > armIntent.finalizeByRoomTimeMs
  ) {
    return invalid('finalization-after-deadline');
  }
  return valid;
}

export function validateRendezvousFinalizeReceipt(
  finalizeIntent: RendezvousFinalizeIntent,
  receipt: RendezvousFinalizeReceipt,
): RendezvousValidationResult {
  if (!isRendezvousFinalizeIntent(finalizeIntent) || !isRendezvousFinalizeReceipt(receipt)) {
    return invalid('invalid-contract');
  }
  const identity = validateMatchingIdentity(finalizeIntent, receipt);
  if (!identity.ok) return identity;
  if (finalizeIntent.recipientId !== receipt.participantId) {
    return invalid('participant-mismatch');
  }
  if (receipt.observedAtRoomTimeMs > finalizeIntent.startAtRoomTimeMs) {
    return invalid('finalization-after-deadline');
  }
  if (receipt.status !== 'accepted') return invalid('finalization-rejected');
  return valid;
}

export function isRendezvousFinalizationOpen(
  intent: RendezvousArmIntent,
  roomTimeMs: number,
): boolean {
  return (
    isRendezvousArmIntent(intent) &&
    isFiniteNonNegative(roomTimeMs) &&
    roomTimeMs <= intent.finalizeByRoomTimeMs
  );
}

import {
  readPlaybackAttemptIdentity,
  sameAttempt,
  sameRun,
  sameState,
  type PlaybackAttemptIdentity,
  type PlaybackStateIdentity,
} from './playback-identity.ts';

export type RendezvousId = string;
export type RendezvousParticipantId = string;

export type RevisionedPlaybackRun = PlaybackStateIdentity;

interface RendezvousIdentity extends PlaybackAttemptIdentity {
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
] as const);
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
] as const);
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
] as const);
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
] as const);

function invalid(code: RendezvousValidationCode): RendezvousValidationResult {
  return { ok: false, code };
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function snapshotRequiredDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of requiredKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function hasValidIdentity(value: Readonly<Record<string, unknown>>): boolean {
  return value.protocolVersion === 2 && readPlaybackAttemptIdentity(value) !== null;
}

export function readRendezvousArmIntent(value: unknown): Readonly<RendezvousArmIntent> | null {
  const candidate = snapshotRequiredDataRecord(value, ARM_INTENT_KEYS);
  if (
    !candidate ||
    candidate.kind !== 'rendezvous-arm' ||
    !hasValidIdentity(candidate) ||
    !isBoundedIdentifier(candidate.recipientId) ||
    !isFiniteNonNegative(candidate.positionSeconds) ||
    typeof candidate.playbackRate !== 'number' ||
    !Number.isFinite(candidate.playbackRate) ||
    candidate.playbackRate <= 0 ||
    !isFiniteNonNegative(candidate.startAtRoomTimeMs) ||
    !isFiniteNonNegative(candidate.finalizeByRoomTimeMs) ||
    candidate.finalizeByRoomTimeMs > candidate.startAtRoomTimeMs
  ) {
    return null;
  }
  return candidate as unknown as Readonly<RendezvousArmIntent>;
}

export function readRendezvousArmReceipt(value: unknown): Readonly<RendezvousArmReceipt> | null {
  const candidate = snapshotRequiredDataRecord(value, ARM_RECEIPT_KEYS);
  if (
    !candidate ||
    candidate.kind !== 'rendezvous-armed' ||
    !hasValidIdentity(candidate) ||
    !isBoundedIdentifier(candidate.participantId) ||
    (candidate.status !== 'armed' && candidate.status !== 'rejected') ||
    !isFiniteNonNegative(candidate.observedAtRoomTimeMs) ||
    !isFiniteNonNegative(candidate.bufferedAheadSeconds) ||
    (candidate.reasonCode !== null && !isBoundedIdentifier(candidate.reasonCode))
  ) {
    return null;
  }
  return candidate as unknown as Readonly<RendezvousArmReceipt>;
}

export function readRendezvousFinalizeIntent(
  value: unknown,
): Readonly<RendezvousFinalizeIntent> | null {
  const candidate = snapshotRequiredDataRecord(value, FINALIZE_INTENT_KEYS);
  if (
    !candidate ||
    candidate.kind !== 'rendezvous-finalize' ||
    !hasValidIdentity(candidate) ||
    !isBoundedIdentifier(candidate.recipientId) ||
    !isFiniteNonNegative(candidate.startAtRoomTimeMs) ||
    !isFiniteNonNegative(candidate.finalizedAtRoomTimeMs) ||
    candidate.finalizedAtRoomTimeMs > candidate.startAtRoomTimeMs
  ) {
    return null;
  }
  return candidate as unknown as Readonly<RendezvousFinalizeIntent>;
}

export function readRendezvousFinalizeReceipt(
  value: unknown,
): Readonly<RendezvousFinalizeReceipt> | null {
  const candidate = snapshotRequiredDataRecord(value, FINALIZE_RECEIPT_KEYS);
  if (
    !candidate ||
    candidate.kind !== 'rendezvous-finalized' ||
    !hasValidIdentity(candidate) ||
    !isBoundedIdentifier(candidate.participantId) ||
    (candidate.status !== 'accepted' &&
      candidate.status !== 'missed-deadline' &&
      candidate.status !== 'rejected') ||
    !isFiniteNonNegative(candidate.observedAtRoomTimeMs) ||
    (candidate.reasonCode !== null && !isBoundedIdentifier(candidate.reasonCode))
  ) {
    return null;
  }
  return candidate as unknown as Readonly<RendezvousFinalizeReceipt>;
}

function validateMatchingIdentity(
  expected: RendezvousIdentity,
  actual: RendezvousIdentity,
): RendezvousValidationResult {
  if (!sameRun(expected, actual)) return invalid('identity-mismatch');
  if (!sameState(expected, actual)) return invalid('revision-mismatch');
  if (!sameAttempt(expected, actual)) return invalid('rendezvous-mismatch');
  return valid;
}

export function validateRendezvousArmReceipt(
  intent: RendezvousArmIntent,
  receipt: RendezvousArmReceipt,
): RendezvousValidationResult {
  const safeIntent = readRendezvousArmIntent(intent);
  const safeReceipt = readRendezvousArmReceipt(receipt);
  if (!safeIntent || !safeReceipt) return invalid('invalid-contract');
  const identity = validateMatchingIdentity(safeIntent, safeReceipt);
  if (!identity.ok) return identity;
  if (safeIntent.recipientId !== safeReceipt.participantId) {
    return invalid('participant-mismatch');
  }
  if (safeReceipt.status !== 'armed') return invalid('arm-rejected');
  if (safeReceipt.observedAtRoomTimeMs > safeIntent.finalizeByRoomTimeMs) {
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
  const safeArmIntent = readRendezvousArmIntent(armIntent);
  const safeArmReceipt = readRendezvousArmReceipt(armReceipt);
  const safeFinalizeIntent = readRendezvousFinalizeIntent(finalizeIntent);
  if (
    !safeArmIntent ||
    !safeArmReceipt ||
    !safeFinalizeIntent ||
    !isFiniteNonNegative(receivedAtRoomTimeMs)
  ) {
    return invalid('invalid-contract');
  }
  const armed = validateRendezvousArmReceipt(safeArmIntent, safeArmReceipt);
  if (!armed.ok) return armed;
  const identity = validateMatchingIdentity(safeArmIntent, safeFinalizeIntent);
  if (!identity.ok) return identity;
  if (
    safeArmIntent.recipientId !== safeFinalizeIntent.recipientId ||
    safeArmReceipt.participantId !== safeFinalizeIntent.recipientId
  ) {
    return invalid('participant-mismatch');
  }
  if (safeArmIntent.startAtRoomTimeMs !== safeFinalizeIntent.startAtRoomTimeMs) {
    return invalid('schedule-mismatch');
  }
  if (
    safeFinalizeIntent.finalizedAtRoomTimeMs > safeArmIntent.finalizeByRoomTimeMs ||
    receivedAtRoomTimeMs > safeArmIntent.finalizeByRoomTimeMs
  ) {
    return invalid('finalization-after-deadline');
  }
  return valid;
}

export function validateRendezvousFinalizeReceipt(
  finalizeIntent: RendezvousFinalizeIntent,
  receipt: RendezvousFinalizeReceipt,
): RendezvousValidationResult {
  const safeIntent = readRendezvousFinalizeIntent(finalizeIntent);
  const safeReceipt = readRendezvousFinalizeReceipt(receipt);
  if (!safeIntent || !safeReceipt) return invalid('invalid-contract');
  const identity = validateMatchingIdentity(safeIntent, safeReceipt);
  if (!identity.ok) return identity;
  if (safeIntent.recipientId !== safeReceipt.participantId) {
    return invalid('participant-mismatch');
  }
  if (safeReceipt.observedAtRoomTimeMs > safeIntent.startAtRoomTimeMs) {
    return invalid('finalization-after-deadline');
  }
  if (safeReceipt.status !== 'accepted') return invalid('finalization-rejected');
  return valid;
}

export function isRendezvousFinalizationOpen(
  intent: RendezvousArmIntent,
  roomTimeMs: number,
): boolean {
  const safeIntent = readRendezvousArmIntent(intent);
  return (
    safeIntent !== null &&
    isFiniteNonNegative(roomTimeMs) &&
    roomTimeMs <= safeIntent.finalizeByRoomTimeMs
  );
}

import type { QueueItemId } from '../types/index.ts';
import { isFilePlaybackSourceSnapshot, type FilePlaybackBackend } from './file-playback-source.ts';
import {
  isPlaybackRevision,
  isPlaybackRunIdentity,
  isPlaybackStateIdentity,
  type PlaybackRevision,
} from './playback-identity.ts';
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

export const FILE_PLAYBACK_WIRE_PROTOCOL_VERSION = 2 as const;
export const FILE_PLAYBACK_WIRE_MAX_PAYLOAD_BYTES = 4_096;
export const FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH = 256;
export const FILE_PLAYBACK_WIRE_MAX_REASON_LENGTH = 160;
export const FILE_PLAYBACK_WIRE_DEFAULT_MAX_CLOCK_SKEW_MS = 250;

const MAX_ROOM_TIME_MS = 1_000_000_000_000;
const MAX_MEDIA_DURATION_SECONDS = 31_536_000;
const MAX_READY_LEASE_MS = 120_000;
const MAX_RENDERER_LEASE_MS = 30_000;
const MAX_PLAYBACK_RATE = 16;
const MAX_COUNTER = 1_000_000_000_000;
const MAX_SAMPLE_RATE_HZ = 1_000_000;
const MAX_CHANNEL_COUNT = 8;
const MAX_CLOCK_SKEW_MS = 2_500;
const MAX_RENDEZVOUS_SCHEDULE_AHEAD_MS = 2_500;

export const FILE_PLAYBACK_WIRE_KINDS = Object.freeze([
  'source-ready',
  'source-not-ready',
  'rendezvous-arm',
  'rendezvous-armed',
  'rendezvous-finalize',
  'rendezvous-finalized',
  'file-playback-pause',
  'file-playback-seek',
  'file-playback-cancel',
  'renderer-health',
] as const);

export type FilePlaybackWireKind = (typeof FILE_PLAYBACK_WIRE_KINDS)[number];

/**
 * Connection-scoped identity common to every V2 file-control message.
 *
 * `sessionId` is the application session, while `transferSessionId` names the
 * independent byte-transfer lifecycle (or is null for a local source). A
 * playback run, rendezvous, and transfer must never borrow each other's IDs.
 */
interface FilePlaybackWireEnvelope {
  readonly protocolVersion: 2;
  readonly kind: FilePlaybackWireKind;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly senderParticipantId: string;
  readonly recipientParticipantId: string;
  readonly controlSequence: number;
  readonly queueItemId: QueueItemId;
  readonly runId: string;
  readonly revision: PlaybackRevision;
  readonly sourceIdentity: string;
  readonly transferSessionId: string | null;
}

export interface FileSourceReadyWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'source-ready';
  readonly observedAtRoomTimeMs: number;
  readonly readyLeaseUntilRoomTimeMs: number;
  readonly backend: FilePlaybackBackend;
  readonly durationSeconds: number;
  readonly bufferedAheadSeconds: number;
  readonly outputSampleRateHz: number;
  readonly channelCount: number;
}

export interface FileSourceNotReadyWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'source-not-ready';
  readonly observedAtRoomTimeMs: number;
  readonly reasonCode: string;
  readonly retryable: boolean;
}

export interface RendezvousArmWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'rendezvous-arm';
  readonly rendezvousId: string;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly startAtRoomTimeMs: number;
  readonly finalizeByRoomTimeMs: number;
}

export interface RendezvousArmedWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'rendezvous-armed';
  readonly rendezvousId: string;
  readonly status: 'armed' | 'rejected';
  readonly observedAtRoomTimeMs: number;
  readonly bufferedAheadSeconds: number;
  readonly reasonCode: string | null;
}

export interface RendezvousFinalizeWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'rendezvous-finalize';
  readonly rendezvousId: string;
  readonly startAtRoomTimeMs: number;
  readonly finalizedAtRoomTimeMs: number;
}

export interface RendezvousFinalizedWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'rendezvous-finalized';
  readonly rendezvousId: string;
  readonly status: 'accepted' | 'missed-deadline' | 'rejected';
  readonly observedAtRoomTimeMs: number;
  readonly reasonCode: string | null;
}

export interface FilePlaybackPauseWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'file-playback-pause';
  readonly atRoomTimeMs: number;
}

export interface FilePlaybackSeekWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'file-playback-seek';
  readonly positionSeconds: number;
  readonly atRoomTimeMs: number;
}

export interface FilePlaybackCancelWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'file-playback-cancel';
  readonly reasonCode: string;
}

export interface RendererHealthWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'renderer-health';
  /** Exact renderer generation; same-run recovery allocates a new rendezvous. */
  readonly rendezvousId: string;
  readonly value: 'healthy' | 'unhealthy';
  readonly observedAtRoomTimeMs: number;
  readonly leaseUntilRoomTimeMs: number;
  readonly renderedFrame: number;
  readonly underrunCount: number;
  readonly reasonCode: string | null;
}

export type FilePlaybackWireMessage =
  | FileSourceReadyWireMessage
  | FileSourceNotReadyWireMessage
  | RendezvousArmWireMessage
  | RendezvousArmedWireMessage
  | RendezvousFinalizeWireMessage
  | RendezvousFinalizedWireMessage
  | FilePlaybackPauseWireMessage
  | FilePlaybackSeekWireMessage
  | FilePlaybackCancelWireMessage
  | RendererHealthWireMessage;

/** Optional binding checks supplied by the connection owner at receive time. */
export interface FilePlaybackWireExpectations {
  readonly sessionId?: string;
  readonly connectionId?: string;
  readonly senderParticipantId?: string;
  readonly recipientParticipantId?: string;
  /** The received sequence must be strictly greater than this value. */
  readonly lastControlSequence?: number;
  readonly run?: RevisionedPlaybackRun;
  readonly sourceIdentity?: string;
  readonly transferSessionId?: string | null;
  readonly rendezvousId?: string;
  /** Trusted local room time captured before parsing this received frame. */
  readonly receivedAtRoomTimeMs?: number;
  /** Maximum positive sender-clock skew accepted at the receive boundary. */
  readonly maxClockSkewMs?: number;
}

/** Mandatory connection scope for parsing a received, untrusted frame. */
export interface FilePlaybackWireReceiveExpectations extends FilePlaybackWireExpectations {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly senderParticipantId: string;
  readonly recipientParticipantId: string;
  readonly lastControlSequence: number;
  readonly receivedAtRoomTimeMs: number;
}

export interface FilePlaybackWireReceiverOptions {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly senderParticipantId: string;
  readonly recipientParticipantId: string;
  readonly nowRoomTimeMs: () => number;
  readonly maxClockSkewMs?: number;
}

export interface FilePlaybackWireMediaBinding {
  readonly run: RevisionedPlaybackRun;
  readonly sourceIdentity: string;
  readonly transferSessionId: string | null;
  readonly rendezvousId?: string;
}

const COMMON_KEYS = [
  'protocolVersion',
  'kind',
  'sessionId',
  'connectionId',
  'senderParticipantId',
  'recipientParticipantId',
  'controlSequence',
  'queueItemId',
  'runId',
  'revision',
  'sourceIdentity',
  'transferSessionId',
] as const;

const SPECIFIC_KEYS: Readonly<Record<FilePlaybackWireKind, readonly string[]>> = Object.freeze({
  'source-ready': Object.freeze([
    'observedAtRoomTimeMs',
    'readyLeaseUntilRoomTimeMs',
    'backend',
    'durationSeconds',
    'bufferedAheadSeconds',
    'outputSampleRateHz',
    'channelCount',
  ]),
  'source-not-ready': Object.freeze(['observedAtRoomTimeMs', 'reasonCode', 'retryable']),
  'rendezvous-arm': Object.freeze([
    'rendezvousId',
    'positionSeconds',
    'playbackRate',
    'startAtRoomTimeMs',
    'finalizeByRoomTimeMs',
  ]),
  'rendezvous-armed': Object.freeze([
    'rendezvousId',
    'status',
    'observedAtRoomTimeMs',
    'bufferedAheadSeconds',
    'reasonCode',
  ]),
  'rendezvous-finalize': Object.freeze([
    'rendezvousId',
    'startAtRoomTimeMs',
    'finalizedAtRoomTimeMs',
  ]),
  'rendezvous-finalized': Object.freeze([
    'rendezvousId',
    'status',
    'observedAtRoomTimeMs',
    'reasonCode',
  ]),
  'file-playback-pause': Object.freeze(['atRoomTimeMs']),
  'file-playback-seek': Object.freeze(['positionSeconds', 'atRoomTimeMs']),
  'file-playback-cancel': Object.freeze(['reasonCode']),
  'renderer-health': Object.freeze([
    'rendezvousId',
    'value',
    'observedAtRoomTimeMs',
    'leaseUntilRoomTimeMs',
    'renderedFrame',
    'underrunCount',
    'reasonCode',
  ]),
});

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isBoundedReason(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FILE_PLAYBACK_WIRE_MAX_REASON_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    !Object.is(value, -0) &&
    value >= minimum &&
    value <= maximum
  );
}

function isBoundedSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= minimum &&
    value <= maximum
  );
}

function isRoomTime(value: unknown): value is number {
  return isBoundedNumber(value, 0, MAX_ROOM_TIME_MS);
}

function isMediaTime(value: unknown): value is number {
  return isBoundedNumber(value, 0, MAX_MEDIA_DURATION_SECONDS);
}

function isWireKind(value: unknown): value is FilePlaybackWireKind {
  return (
    typeof value === 'string' && (FILE_PLAYBACK_WIRE_KINDS as readonly string[]).includes(value)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function detachExactDataRecord(value: Record<string, unknown>): Record<string, unknown> | null {
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (
    !kindDescriptor ||
    !kindDescriptor.enumerable ||
    !Object.hasOwn(kindDescriptor, 'value') ||
    !isWireKind(kindDescriptor.value)
  ) {
    return null;
  }
  const kind = kindDescriptor.value;
  const expected = new Set<string>([...COMMON_KEYS, ...SPECIFIC_KEYS[kind]]);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expected.size) return null;
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !expected.has(key)) return null;
  }

  // Read every untrusted data descriptor exactly once. Validation, byte
  // accounting, and canonicalization use only this detached null-prototype
  // snapshot, so a Proxy cannot change values between phases or inject a
  // toJSON hook that hides the real payload size.
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor =
      key === 'kind' ? kindDescriptor : Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function hasValidEnvelope(candidate: Record<string, unknown>): boolean {
  const run = {
    queueItemId: candidate.queueItemId,
    runId: candidate.runId,
  };
  return (
    candidate.protocolVersion === FILE_PLAYBACK_WIRE_PROTOCOL_VERSION &&
    isWireKind(candidate.kind) &&
    isBoundedIdentifier(candidate.sessionId) &&
    isBoundedIdentifier(candidate.connectionId) &&
    isBoundedIdentifier(candidate.senderParticipantId) &&
    isBoundedIdentifier(candidate.recipientParticipantId) &&
    candidate.senderParticipantId !== candidate.recipientParticipantId &&
    isBoundedSafeInteger(candidate.controlSequence, 1, Number.MAX_SAFE_INTEGER) &&
    isPlaybackRunIdentity(run) &&
    isPlaybackRevision(candidate.revision) &&
    !Object.is(candidate.revision, -0) &&
    isBoundedIdentifier(candidate.sourceIdentity) &&
    (candidate.transferSessionId === null || isBoundedIdentifier(candidate.transferSessionId))
  );
}

function hasBoundedPayload(candidate: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(candidate);
  return (
    typeof serialized === 'string' &&
    new TextEncoder().encode(serialized).byteLength <= FILE_PLAYBACK_WIRE_MAX_PAYLOAD_BYTES
  );
}

function asRevisionedRun(candidate: Record<string, unknown>): RevisionedPlaybackRun {
  return {
    queueItemId: candidate.queueItemId as QueueItemId,
    runId: candidate.runId as string,
    revision: candidate.revision as PlaybackRevision,
  };
}

function asArmIntent(candidate: Record<string, unknown>): RendezvousArmIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-arm',
    ...asRevisionedRun(candidate),
    rendezvousId: candidate.rendezvousId as string,
    recipientId: candidate.recipientParticipantId as string,
    positionSeconds: candidate.positionSeconds as number,
    playbackRate: candidate.playbackRate as number,
    startAtRoomTimeMs: candidate.startAtRoomTimeMs as number,
    finalizeByRoomTimeMs: candidate.finalizeByRoomTimeMs as number,
  };
}

function asArmReceipt(candidate: Record<string, unknown>): RendezvousArmReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-armed',
    ...asRevisionedRun(candidate),
    rendezvousId: candidate.rendezvousId as string,
    participantId: candidate.senderParticipantId as string,
    status: candidate.status as RendezvousArmReceipt['status'],
    observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
    bufferedAheadSeconds: candidate.bufferedAheadSeconds as number,
    reasonCode: candidate.reasonCode as string | null,
  };
}

function asFinalizeIntent(candidate: Record<string, unknown>): RendezvousFinalizeIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalize',
    ...asRevisionedRun(candidate),
    rendezvousId: candidate.rendezvousId as string,
    recipientId: candidate.recipientParticipantId as string,
    startAtRoomTimeMs: candidate.startAtRoomTimeMs as number,
    finalizedAtRoomTimeMs: candidate.finalizedAtRoomTimeMs as number,
  };
}

function asFinalizeReceipt(candidate: Record<string, unknown>): RendezvousFinalizeReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalized',
    ...asRevisionedRun(candidate),
    rendezvousId: candidate.rendezvousId as string,
    participantId: candidate.senderParticipantId as string,
    status: candidate.status as RendezvousFinalizeReceipt['status'],
    observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
    reasonCode: candidate.reasonCode as string | null,
  };
}

function hasValidReadySource(candidate: Record<string, unknown>): boolean {
  if (
    !isRoomTime(candidate.observedAtRoomTimeMs) ||
    !isRoomTime(candidate.readyLeaseUntilRoomTimeMs) ||
    candidate.readyLeaseUntilRoomTimeMs <= candidate.observedAtRoomTimeMs ||
    candidate.readyLeaseUntilRoomTimeMs - candidate.observedAtRoomTimeMs > MAX_READY_LEASE_MS ||
    !isBoundedNumber(candidate.durationSeconds, Number.MIN_VALUE, MAX_MEDIA_DURATION_SECONDS) ||
    !isMediaTime(candidate.bufferedAheadSeconds) ||
    candidate.bufferedAheadSeconds > candidate.durationSeconds ||
    !isBoundedSafeInteger(candidate.outputSampleRateHz, 1, MAX_SAMPLE_RATE_HZ) ||
    !isBoundedSafeInteger(candidate.channelCount, 1, MAX_CHANNEL_COUNT)
  ) {
    return false;
  }
  return isFilePlaybackSourceSnapshot({
    schemaVersion: 1,
    queueItemId: candidate.queueItemId,
    backend: candidate.backend,
    phase: 'ready',
    revision: candidate.revision,
    run: asRevisionedRun(candidate),
    durationSeconds: candidate.durationSeconds,
    positionSeconds: 0,
    bufferedAheadSeconds: candidate.bufferedAheadSeconds,
    outputSampleRateHz: candidate.outputSampleRateHz,
    channelCount: candidate.channelCount,
    underrunCount: 0,
    errorCode: null,
  });
}

function hasCoherentStatusReason(
  accepted: boolean,
  reasonCode: unknown,
): reasonCode is string | null {
  return accepted ? reasonCode === null : isBoundedReason(reasonCode);
}

function hasValidKindPayload(candidate: Record<string, unknown>): boolean {
  switch (candidate.kind) {
    case 'source-ready':
      return hasValidReadySource(candidate);
    case 'source-not-ready':
      return (
        isRoomTime(candidate.observedAtRoomTimeMs) &&
        isBoundedReason(candidate.reasonCode) &&
        typeof candidate.retryable === 'boolean'
      );
    case 'rendezvous-arm':
      return (
        isBoundedIdentifier(candidate.rendezvousId) &&
        isMediaTime(candidate.positionSeconds) &&
        isBoundedNumber(candidate.playbackRate, Number.MIN_VALUE, MAX_PLAYBACK_RATE) &&
        isRoomTime(candidate.startAtRoomTimeMs) &&
        isRoomTime(candidate.finalizeByRoomTimeMs) &&
        readRendezvousArmIntent(asArmIntent(candidate)) !== null
      );
    case 'rendezvous-armed': {
      const statusIsArmed = candidate.status === 'armed';
      return (
        isBoundedIdentifier(candidate.rendezvousId) &&
        (statusIsArmed || candidate.status === 'rejected') &&
        isRoomTime(candidate.observedAtRoomTimeMs) &&
        isMediaTime(candidate.bufferedAheadSeconds) &&
        hasCoherentStatusReason(statusIsArmed, candidate.reasonCode) &&
        readRendezvousArmReceipt(asArmReceipt(candidate)) !== null
      );
    }
    case 'rendezvous-finalize':
      return (
        isBoundedIdentifier(candidate.rendezvousId) &&
        isRoomTime(candidate.startAtRoomTimeMs) &&
        isRoomTime(candidate.finalizedAtRoomTimeMs) &&
        readRendezvousFinalizeIntent(asFinalizeIntent(candidate)) !== null
      );
    case 'rendezvous-finalized': {
      const statusIsAccepted = candidate.status === 'accepted';
      return (
        isBoundedIdentifier(candidate.rendezvousId) &&
        (statusIsAccepted ||
          candidate.status === 'missed-deadline' ||
          candidate.status === 'rejected') &&
        isRoomTime(candidate.observedAtRoomTimeMs) &&
        hasCoherentStatusReason(statusIsAccepted, candidate.reasonCode) &&
        readRendezvousFinalizeReceipt(asFinalizeReceipt(candidate)) !== null
      );
    }
    case 'file-playback-pause':
      return isRoomTime(candidate.atRoomTimeMs);
    case 'file-playback-seek':
      return isMediaTime(candidate.positionSeconds) && isRoomTime(candidate.atRoomTimeMs);
    case 'file-playback-cancel':
      return isBoundedReason(candidate.reasonCode);
    case 'renderer-health': {
      const healthy = candidate.value === 'healthy';
      if (!healthy && candidate.value !== 'unhealthy') return false;
      if (
        !isBoundedIdentifier(candidate.rendezvousId) ||
        !isRoomTime(candidate.observedAtRoomTimeMs) ||
        !isRoomTime(candidate.leaseUntilRoomTimeMs) ||
        !isBoundedSafeInteger(candidate.renderedFrame, 0, MAX_COUNTER) ||
        !isBoundedSafeInteger(candidate.underrunCount, 0, MAX_COUNTER) ||
        !hasCoherentStatusReason(healthy, candidate.reasonCode)
      ) {
        return false;
      }
      return healthy
        ? candidate.leaseUntilRoomTimeMs > candidate.observedAtRoomTimeMs &&
            candidate.leaseUntilRoomTimeMs - candidate.observedAtRoomTimeMs <= MAX_RENDERER_LEASE_MS
        : candidate.leaseUntilRoomTimeMs === candidate.observedAtRoomTimeMs;
    }
  }
  return false;
}

const EXPECTATION_KEYS = new Set([
  'sessionId',
  'connectionId',
  'senderParticipantId',
  'recipientParticipantId',
  'lastControlSequence',
  'run',
  'sourceIdentity',
  'transferSessionId',
  'rendezvousId',
  'receivedAtRoomTimeMs',
  'maxClockSkewMs',
]);
const REQUIRED_RECEIVE_EXPECTATION_KEYS = [
  'sessionId',
  'connectionId',
  'senderParticipantId',
  'recipientParticipantId',
  'lastControlSequence',
  'receivedAtRoomTimeMs',
] as const;

function snapshotAllowedDataRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[] = [],
): Record<string, unknown> | null {
  try {
    if (!isPlainRecord(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      required.some((key) => !ownKeys.includes(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotExpectedRun(value: unknown): RevisionedPlaybackRun | null {
  const snapshot = snapshotAllowedDataRecord(value, new Set(['queueItemId', 'runId', 'revision']), [
    'queueItemId',
    'runId',
    'revision',
  ]);
  if (
    !snapshot ||
    !isBoundedIdentifier(snapshot.queueItemId) ||
    !isBoundedIdentifier(snapshot.runId) ||
    !isPlaybackRevision(snapshot.revision) ||
    Object.is(snapshot.revision, -0)
  ) {
    return null;
  }
  return freezeCanonical({
    queueItemId: snapshot.queueItemId as QueueItemId,
    runId: snapshot.runId,
    revision: snapshot.revision,
  });
}

function snapshotReceiveExpectations(value: unknown): FilePlaybackWireReceiveExpectations | null {
  const snapshot = snapshotAllowedDataRecord(
    value,
    EXPECTATION_KEYS,
    REQUIRED_RECEIVE_EXPECTATION_KEYS,
  );
  if (
    !snapshot ||
    !isBoundedIdentifier(snapshot.sessionId) ||
    !isBoundedIdentifier(snapshot.connectionId) ||
    !isBoundedIdentifier(snapshot.senderParticipantId) ||
    !isBoundedIdentifier(snapshot.recipientParticipantId) ||
    snapshot.senderParticipantId === snapshot.recipientParticipantId ||
    !isBoundedSafeInteger(snapshot.lastControlSequence, 0, Number.MAX_SAFE_INTEGER) ||
    !isRoomTime(snapshot.receivedAtRoomTimeMs)
  ) {
    return null;
  }
  if (
    Object.hasOwn(snapshot, 'maxClockSkewMs') &&
    snapshot.maxClockSkewMs !== undefined &&
    !isBoundedNumber(snapshot.maxClockSkewMs, 0, MAX_CLOCK_SKEW_MS)
  ) {
    return null;
  }
  const runCandidate = Object.hasOwn(snapshot, 'run')
    ? snapshotExpectedRun(snapshot.run)
    : undefined;
  if (runCandidate === null) return null;
  const run: RevisionedPlaybackRun | undefined = runCandidate;
  if (
    Object.hasOwn(snapshot, 'sourceIdentity') &&
    snapshot.sourceIdentity !== undefined &&
    !isBoundedIdentifier(snapshot.sourceIdentity)
  ) {
    return null;
  }
  if (
    Object.hasOwn(snapshot, 'transferSessionId') &&
    snapshot.transferSessionId !== undefined &&
    snapshot.transferSessionId !== null &&
    !isBoundedIdentifier(snapshot.transferSessionId)
  ) {
    return null;
  }
  if (
    Object.hasOwn(snapshot, 'rendezvousId') &&
    snapshot.rendezvousId !== undefined &&
    !isBoundedIdentifier(snapshot.rendezvousId)
  ) {
    return null;
  }

  return freezeCanonical({
    sessionId: snapshot.sessionId as string,
    connectionId: snapshot.connectionId as string,
    senderParticipantId: snapshot.senderParticipantId as string,
    recipientParticipantId: snapshot.recipientParticipantId as string,
    lastControlSequence: snapshot.lastControlSequence as number,
    receivedAtRoomTimeMs: snapshot.receivedAtRoomTimeMs as number,
    ...(snapshot.maxClockSkewMs === undefined
      ? {}
      : { maxClockSkewMs: snapshot.maxClockSkewMs as number }),
    ...(run === undefined ? {} : { run }),
    ...(snapshot.sourceIdentity === undefined
      ? {}
      : { sourceIdentity: snapshot.sourceIdentity as string }),
    ...(snapshot.transferSessionId === undefined
      ? {}
      : { transferSessionId: snapshot.transferSessionId as string | null }),
    ...(snapshot.rendezvousId === undefined
      ? {}
      : { rendezvousId: snapshot.rendezvousId as string }),
  });
}

function hasValidExpectationBindings(
  message: FilePlaybackWireMessage,
  expectations: FilePlaybackWireExpectations,
): boolean {
  if (expectations.sessionId !== undefined && message.sessionId !== expectations.sessionId) {
    return false;
  }
  if (
    expectations.connectionId !== undefined &&
    message.connectionId !== expectations.connectionId
  ) {
    return false;
  }
  if (
    expectations.senderParticipantId !== undefined &&
    message.senderParticipantId !== expectations.senderParticipantId
  ) {
    return false;
  }
  if (
    expectations.recipientParticipantId !== undefined &&
    message.recipientParticipantId !== expectations.recipientParticipantId
  ) {
    return false;
  }
  if (expectations.lastControlSequence !== undefined) {
    if (
      !isBoundedSafeInteger(expectations.lastControlSequence, 0, Number.MAX_SAFE_INTEGER) ||
      message.controlSequence <= expectations.lastControlSequence
    ) {
      return false;
    }
  }
  if (expectations.run !== undefined) {
    if (
      !isPlaybackStateIdentity(expectations.run) ||
      !isPlaybackRevision(expectations.run.revision) ||
      Object.is(expectations.run.revision, -0) ||
      message.queueItemId !== expectations.run.queueItemId ||
      message.runId !== expectations.run.runId ||
      message.revision !== expectations.run.revision
    ) {
      return false;
    }
  }
  if (
    expectations.sourceIdentity !== undefined &&
    message.sourceIdentity !== expectations.sourceIdentity
  ) {
    return false;
  }
  if (
    expectations.transferSessionId !== undefined &&
    message.transferSessionId !== expectations.transferSessionId
  ) {
    return false;
  }
  if (expectations.rendezvousId !== undefined) {
    if ('rendezvousId' in message && message.rendezvousId !== expectations.rendezvousId) {
      return false;
    }
  }
  if (message.kind === 'renderer-health' && expectations.rendezvousId === undefined) {
    return false;
  }
  return hasValidTemporalBindings(message, expectations);
}

function observedAtRoomTimeMs(message: FilePlaybackWireMessage): number | null {
  return 'observedAtRoomTimeMs' in message ? message.observedAtRoomTimeMs : null;
}

function hasValidTemporalBindings(
  message: FilePlaybackWireMessage,
  expectations: FilePlaybackWireExpectations,
): boolean {
  const receivedAt = expectations.receivedAtRoomTimeMs;
  const configuredSkew = expectations.maxClockSkewMs;
  if (receivedAt === undefined) return configuredSkew === undefined;
  if (!isRoomTime(receivedAt)) return false;
  const skew =
    configuredSkew === undefined ? FILE_PLAYBACK_WIRE_DEFAULT_MAX_CLOCK_SKEW_MS : configuredSkew;
  if (!isBoundedNumber(skew, 0, MAX_CLOCK_SKEW_MS)) return false;

  const observedAt = observedAtRoomTimeMs(message);
  if (observedAt !== null && observedAt > receivedAt + skew) return false;

  switch (message.kind) {
    case 'source-ready':
      return message.readyLeaseUntilRoomTimeMs > receivedAt;
    case 'renderer-health':
      return message.value === 'unhealthy' || message.leaseUntilRoomTimeMs > receivedAt;
    case 'rendezvous-arm':
      return (
        message.finalizeByRoomTimeMs >= receivedAt - skew &&
        message.startAtRoomTimeMs >= receivedAt - skew &&
        message.startAtRoomTimeMs <= receivedAt + MAX_RENDEZVOUS_SCHEDULE_AHEAD_MS + skew
      );
    case 'rendezvous-finalize':
      return (
        message.finalizedAtRoomTimeMs <= receivedAt + skew &&
        message.startAtRoomTimeMs >= receivedAt - skew &&
        message.startAtRoomTimeMs <= receivedAt + MAX_RENDEZVOUS_SCHEDULE_AHEAD_MS + skew
      );
    case 'file-playback-pause':
    case 'file-playback-seek':
      return message.atRoomTimeMs <= receivedAt + skew;
    default:
      return true;
  }
}

function freezeCanonical<T extends object>(value: T): T {
  return Object.freeze(Object.assign(Object.create(null), value)) as T;
}

function canonicalEnvelope(candidate: Record<string, unknown>): FilePlaybackWireEnvelope {
  return freezeCanonical({
    protocolVersion: 2,
    kind: candidate.kind as FilePlaybackWireKind,
    sessionId: candidate.sessionId as string,
    connectionId: candidate.connectionId as string,
    senderParticipantId: candidate.senderParticipantId as string,
    recipientParticipantId: candidate.recipientParticipantId as string,
    controlSequence: candidate.controlSequence as number,
    queueItemId: candidate.queueItemId as QueueItemId,
    runId: candidate.runId as string,
    revision: candidate.revision as PlaybackRevision,
    sourceIdentity: candidate.sourceIdentity as string,
    transferSessionId: candidate.transferSessionId as string | null,
  });
}

function canonicalMessage(candidate: Record<string, unknown>): FilePlaybackWireMessage {
  const envelope = canonicalEnvelope(candidate);
  switch (candidate.kind) {
    case 'source-ready':
      return freezeCanonical({
        ...envelope,
        kind: 'source-ready',
        observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
        readyLeaseUntilRoomTimeMs: candidate.readyLeaseUntilRoomTimeMs as number,
        backend: candidate.backend as FilePlaybackBackend,
        durationSeconds: candidate.durationSeconds as number,
        bufferedAheadSeconds: candidate.bufferedAheadSeconds as number,
        outputSampleRateHz: candidate.outputSampleRateHz as number,
        channelCount: candidate.channelCount as number,
      });
    case 'source-not-ready':
      return freezeCanonical({
        ...envelope,
        kind: 'source-not-ready',
        observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
        reasonCode: candidate.reasonCode as string,
        retryable: candidate.retryable as boolean,
      });
    case 'rendezvous-arm':
      return freezeCanonical({
        ...envelope,
        kind: 'rendezvous-arm',
        rendezvousId: candidate.rendezvousId as string,
        positionSeconds: candidate.positionSeconds as number,
        playbackRate: candidate.playbackRate as number,
        startAtRoomTimeMs: candidate.startAtRoomTimeMs as number,
        finalizeByRoomTimeMs: candidate.finalizeByRoomTimeMs as number,
      });
    case 'rendezvous-armed':
      return freezeCanonical({
        ...envelope,
        kind: 'rendezvous-armed',
        rendezvousId: candidate.rendezvousId as string,
        status: candidate.status as RendezvousArmedWireMessage['status'],
        observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
        bufferedAheadSeconds: candidate.bufferedAheadSeconds as number,
        reasonCode: candidate.reasonCode as string | null,
      });
    case 'rendezvous-finalize':
      return freezeCanonical({
        ...envelope,
        kind: 'rendezvous-finalize',
        rendezvousId: candidate.rendezvousId as string,
        startAtRoomTimeMs: candidate.startAtRoomTimeMs as number,
        finalizedAtRoomTimeMs: candidate.finalizedAtRoomTimeMs as number,
      });
    case 'rendezvous-finalized':
      return freezeCanonical({
        ...envelope,
        kind: 'rendezvous-finalized',
        rendezvousId: candidate.rendezvousId as string,
        status: candidate.status as RendezvousFinalizedWireMessage['status'],
        observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
        reasonCode: candidate.reasonCode as string | null,
      });
    case 'file-playback-pause':
      return freezeCanonical({
        ...envelope,
        kind: 'file-playback-pause',
        atRoomTimeMs: candidate.atRoomTimeMs as number,
      });
    case 'file-playback-seek':
      return freezeCanonical({
        ...envelope,
        kind: 'file-playback-seek',
        positionSeconds: candidate.positionSeconds as number,
        atRoomTimeMs: candidate.atRoomTimeMs as number,
      });
    case 'file-playback-cancel':
      return freezeCanonical({
        ...envelope,
        kind: 'file-playback-cancel',
        reasonCode: candidate.reasonCode as string,
      });
    case 'renderer-health':
      return freezeCanonical({
        ...envelope,
        kind: 'renderer-health',
        rendezvousId: candidate.rendezvousId as string,
        value: candidate.value as RendererHealthWireMessage['value'],
        observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
        leaseUntilRoomTimeMs: candidate.leaseUntilRoomTimeMs as number,
        renderedFrame: candidate.renderedFrame as number,
        underrunCount: candidate.underrunCount as number,
        reasonCode: candidate.reasonCode as string | null,
      });
    default:
      throw new TypeError('Unsupported file playback wire message kind');
  }
}

function canonicalizeFilePlaybackWireMessage(value: unknown): FilePlaybackWireMessage | null {
  try {
    if (!isPlainRecord(value)) return null;
    const snapshot = detachExactDataRecord(value);
    if (!snapshot) return null;
    if (
      !hasValidEnvelope(snapshot) ||
      !hasValidKindPayload(snapshot) ||
      !hasBoundedPayload(snapshot)
    ) {
      return null;
    }
    return canonicalMessage(snapshot);
  } catch {
    return null;
  }
}

/**
 * Stateless strict receive parser. Every call must supply the complete trusted
 * connection scope and capture time. Product dispatch should prefer
 * FilePlaybackWireReceiver, which advances the sequence watermark in the same
 * synchronous commit as validation.
 */
export function parseFilePlaybackWireMessage(
  value: unknown,
  expectations: FilePlaybackWireReceiveExpectations,
): FilePlaybackWireMessage | null {
  const message = canonicalizeFilePlaybackWireMessage(value);
  if (!message) return null;
  const trusted = snapshotReceiveExpectations(expectations);
  return trusted && hasValidExpectationBindings(message, trusted) ? message : null;
}

/** Validates and canonicalizes a locally constructed frame. */
export function createFilePlaybackWireMessage(
  value: FilePlaybackWireMessage,
): FilePlaybackWireMessage {
  const message = canonicalizeFilePlaybackWireMessage(value);
  if (!message) throw new TypeError('File playback wire message is invalid');
  return message;
}

function snapshotMediaExpectations(
  value: FilePlaybackWireMediaBinding,
): FilePlaybackWireMediaBinding | null {
  const snapshot = snapshotAllowedDataRecord(
    value,
    new Set(['run', 'sourceIdentity', 'transferSessionId', 'rendezvousId']),
    ['run', 'sourceIdentity', 'transferSessionId'],
  );
  if (!snapshot) return null;
  const run = snapshotExpectedRun(snapshot.run);
  if (run === null || !isBoundedIdentifier(snapshot.sourceIdentity)) {
    return null;
  }
  if (snapshot.transferSessionId !== null && !isBoundedIdentifier(snapshot.transferSessionId)) {
    return null;
  }
  if (Object.hasOwn(snapshot, 'rendezvousId') && !isBoundedIdentifier(snapshot.rendezvousId)) {
    return null;
  }
  return freezeCanonical({
    run,
    sourceIdentity: snapshot.sourceIdentity,
    transferSessionId: snapshot.transferSessionId as string | null,
    ...(Object.hasOwn(snapshot, 'rendezvousId')
      ? { rendezvousId: snapshot.rendezvousId as string }
      : {}),
  });
}

/**
 * Connection-owned receive gate with an atomic inbound sequence watermark.
 * Untrusted structural detachment happens before the latest media binding and
 * watermark are read, so a re-entrant Proxy cannot make an older outer frame
 * overwrite a newer inner commit.
 */
export class FilePlaybackWireReceiver {
  readonly #sessionId: string;
  readonly #connectionId: string;
  readonly #senderParticipantId: string;
  readonly #recipientParticipantId: string;
  readonly #nowRoomTimeMs: () => number;
  readonly #maxClockSkewMs: number;
  #lastControlSequence = 0;
  #media: FilePlaybackWireMediaBinding | null = null;

  constructor(options: FilePlaybackWireReceiverOptions) {
    const snapshot = snapshotAllowedDataRecord(
      options,
      new Set([
        'sessionId',
        'connectionId',
        'senderParticipantId',
        'recipientParticipantId',
        'nowRoomTimeMs',
        'maxClockSkewMs',
      ]),
      [
        'sessionId',
        'connectionId',
        'senderParticipantId',
        'recipientParticipantId',
        'nowRoomTimeMs',
      ],
    );
    if (
      !snapshot ||
      !isBoundedIdentifier(snapshot.sessionId) ||
      !isBoundedIdentifier(snapshot.connectionId) ||
      !isBoundedIdentifier(snapshot.senderParticipantId) ||
      !isBoundedIdentifier(snapshot.recipientParticipantId) ||
      snapshot.senderParticipantId === snapshot.recipientParticipantId ||
      typeof snapshot.nowRoomTimeMs !== 'function'
    ) {
      throw new TypeError('File playback receiver scope is invalid');
    }
    const maxClockSkewMs =
      snapshot.maxClockSkewMs === undefined
        ? FILE_PLAYBACK_WIRE_DEFAULT_MAX_CLOCK_SKEW_MS
        : snapshot.maxClockSkewMs;
    if (!isBoundedNumber(maxClockSkewMs, 0, MAX_CLOCK_SKEW_MS)) {
      throw new RangeError('File playback receiver clock skew is invalid');
    }
    this.#sessionId = snapshot.sessionId;
    this.#connectionId = snapshot.connectionId;
    this.#senderParticipantId = snapshot.senderParticipantId;
    this.#recipientParticipantId = snapshot.recipientParticipantId;
    this.#nowRoomTimeMs = snapshot.nowRoomTimeMs as () => number;
    this.#maxClockSkewMs = maxClockSkewMs;
  }

  lastControlSequence(): number {
    return this.#lastControlSequence;
  }

  bindMedia(expectations: FilePlaybackWireMediaBinding): void {
    const snapshot = snapshotMediaExpectations(expectations);
    if (!snapshot) throw new TypeError('File playback receiver media binding is invalid');
    this.#media = snapshot;
  }

  clearMedia(): void {
    this.#media = null;
  }

  receive(value: unknown): FilePlaybackWireMessage | null {
    // Capture ingress time before hostile Proxy traps can consume main-thread
    // time. Mutable media authority and the watermark are still read after
    // detachment, so a re-entrant trap cannot make an older outer frame win.
    let receivedAtRoomTimeMs: number;
    try {
      receivedAtRoomTimeMs = this.#nowRoomTimeMs();
    } catch {
      return null;
    }
    const message = canonicalizeFilePlaybackWireMessage(value);
    if (!message) return null;

    const media = this.#media;
    if (!media) return null;
    const currentWatermark = this.#lastControlSequence;
    const expectations: FilePlaybackWireReceiveExpectations = freezeCanonical({
      sessionId: this.#sessionId,
      connectionId: this.#connectionId,
      senderParticipantId: this.#senderParticipantId,
      recipientParticipantId: this.#recipientParticipantId,
      lastControlSequence: currentWatermark,
      receivedAtRoomTimeMs,
      maxClockSkewMs: this.#maxClockSkewMs,
      ...media,
    });
    if (!hasValidExpectationBindings(message, expectations)) return null;

    // No untrusted callback occurs between the final current-watermark check
    // and this commit. Dispatch may safely become async only after receive().
    if (message.controlSequence <= this.#lastControlSequence) return null;
    this.#lastControlSequence = message.controlSequence;
    return message;
  }
}

/** Serializes only a validated canonical frame within the wire byte budget. */
export function serializeFilePlaybackWireMessage(value: FilePlaybackWireMessage): string {
  const serialized = JSON.stringify(createFilePlaybackWireMessage(value));
  if (new TextEncoder().encode(serialized).byteLength > FILE_PLAYBACK_WIRE_MAX_PAYLOAD_BYTES) {
    throw new TypeError('File playback wire message exceeds the byte budget');
  }
  return serialized;
}

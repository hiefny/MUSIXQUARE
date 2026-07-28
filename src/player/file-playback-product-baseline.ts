import {
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_READY_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
} from '../network/file-playback-transport-contract.ts';
import { isFilePlaybackSessionId } from '../network/file-playback-session-handshake.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  isPlaybackRevision,
  isPlaybackRevisionWatermark,
  type PlaybackRevisionWatermark,
} from './playback-identity.ts';
import { isQueueItemId } from './queue-model.ts';

export const FILE_PLAYBACK_PRODUCT_PROTOCOL_VERSION = 2 as const;

export type FilePlaybackProductPhase = 'stopped' | 'paused' | 'playing';

export interface FilePlaybackProductBaselineV2 {
  readonly protocolVersion: typeof FILE_PLAYBACK_PRODUCT_PROTOCOL_VERSION;
  readonly type: typeof FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly baselineId: string;
  readonly hostParticipantId: string;
  readonly guestParticipantId: string;
  readonly playbackRevision: PlaybackRevisionWatermark;
  readonly phase: FilePlaybackProductPhase;
  readonly queueItemId: QueueItemId | null;
  readonly runId: string | null;
  readonly positionSeconds: number;
  readonly rate: number;
  readonly anchorRoomTimeMs: number;
}

export interface FilePlaybackProductReadyV2 {
  readonly protocolVersion: typeof FILE_PLAYBACK_PRODUCT_PROTOCOL_VERSION;
  readonly type: typeof FILE_PLAYBACK_PRODUCT_READY_V2_TYPE;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly baselineId: string;
  readonly guestParticipantId: string;
  readonly playbackRevision: PlaybackRevisionWatermark;
  readonly observedAtRoomTimeMs: number;
}

export type FilePlaybackProductBaselineV2Input = Omit<
  FilePlaybackProductBaselineV2,
  'protocolVersion' | 'type'
>;

export type FilePlaybackProductReadyV2Input = Omit<
  FilePlaybackProductReadyV2,
  'protocolVersion' | 'type'
>;

type ProductPrimitive = string | number | null;
type PrimitiveSnapshot = Readonly<Record<string, ProductPrimitive>>;

const BASELINE_KEYS = Object.freeze([
  'anchorRoomTimeMs',
  'baselineId',
  'connectionId',
  'guestParticipantId',
  'hostParticipantId',
  'phase',
  'playbackRevision',
  'positionSeconds',
  'protocolVersion',
  'queueItemId',
  'rate',
  'runId',
  'sessionId',
  'type',
] as const);

const BASELINE_INPUT_KEYS = Object.freeze(
  BASELINE_KEYS.filter((key) => key !== 'protocolVersion' && key !== 'type'),
);

const READY_KEYS = Object.freeze([
  'baselineId',
  'connectionId',
  'guestParticipantId',
  'observedAtRoomTimeMs',
  'playbackRevision',
  'protocolVersion',
  'sessionId',
  'type',
] as const);

const READY_INPUT_KEYS = Object.freeze(
  READY_KEYS.filter((key) => key !== 'protocolVersion' && key !== 'type'),
);

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPlaybackRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function snapshotExactPrimitiveRecord(
  value: unknown,
  expectedKeys: readonly string[],
): PrimitiveSnapshot | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set(expectedKeys);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }

    const snapshot = Object.create(null) as Record<string, ProductPrimitive>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        (descriptor.value !== null &&
          typeof descriptor.value !== 'string' &&
          typeof descriptor.value !== 'number')
      ) {
        return null;
      }
      snapshot[key] = descriptor.value as ProductPrimitive;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function serializedByteLength(value: object): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function canonicalizeBaseline(
  snapshot: PrimitiveSnapshot,
): Readonly<FilePlaybackProductBaselineV2> | null {
  if (
    snapshot.protocolVersion !== FILE_PLAYBACK_PRODUCT_PROTOCOL_VERSION ||
    snapshot.type !== FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE ||
    !isFilePlaybackSessionId(snapshot.sessionId) ||
    !isFilePlaybackSessionId(snapshot.connectionId) ||
    snapshot.sessionId === snapshot.connectionId ||
    !isFilePlaybackSessionId(snapshot.baselineId) ||
    !isFilePlaybackSessionId(snapshot.hostParticipantId) ||
    !isFilePlaybackSessionId(snapshot.guestParticipantId) ||
    snapshot.hostParticipantId === snapshot.guestParticipantId ||
    !isPlaybackRevisionWatermark(snapshot.playbackRevision) ||
    (snapshot.phase !== 'stopped' && snapshot.phase !== 'paused' && snapshot.phase !== 'playing') ||
    !isFiniteNonNegative(snapshot.positionSeconds) ||
    !isPlaybackRate(snapshot.rate) ||
    !isFiniteNonNegative(snapshot.anchorRoomTimeMs)
  ) {
    return null;
  }
  if (
    new Set([
      snapshot.sessionId,
      snapshot.connectionId,
      snapshot.baselineId,
      snapshot.hostParticipantId,
      snapshot.guestParticipantId,
    ]).size !== 5
  ) {
    return null;
  }

  if (snapshot.phase === 'stopped') {
    if (
      snapshot.queueItemId !== null ||
      snapshot.runId !== null ||
      snapshot.positionSeconds !== 0 ||
      snapshot.rate !== 1
    ) {
      return null;
    }
  } else if (
    !isPlaybackRevision(snapshot.playbackRevision) ||
    !isQueueItemId(snapshot.queueItemId) ||
    !isQueueItemId(snapshot.runId) ||
    snapshot.queueItemId === snapshot.runId
  ) {
    return null;
  }

  const baseline = freezeCanonical({
    protocolVersion: FILE_PLAYBACK_PRODUCT_PROTOCOL_VERSION,
    type: FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    baselineId: snapshot.baselineId,
    hostParticipantId: snapshot.hostParticipantId,
    guestParticipantId: snapshot.guestParticipantId,
    playbackRevision: snapshot.playbackRevision as PlaybackRevisionWatermark,
    phase: snapshot.phase as FilePlaybackProductPhase,
    queueItemId: snapshot.queueItemId as QueueItemId | null,
    runId: snapshot.runId,
    positionSeconds: snapshot.positionSeconds,
    rate: snapshot.rate,
    anchorRoomTimeMs: snapshot.anchorRoomTimeMs,
  });
  return serializedByteLength(baseline) <= FILE_PLAYBACK_PRODUCT_BASELINE_V2_MAX_RAW_FRAME_BYTES
    ? baseline
    : null;
}

function canonicalizeReady(
  snapshot: PrimitiveSnapshot,
): Readonly<FilePlaybackProductReadyV2> | null {
  if (
    snapshot.protocolVersion !== FILE_PLAYBACK_PRODUCT_PROTOCOL_VERSION ||
    snapshot.type !== FILE_PLAYBACK_PRODUCT_READY_V2_TYPE ||
    !isFilePlaybackSessionId(snapshot.sessionId) ||
    !isFilePlaybackSessionId(snapshot.connectionId) ||
    snapshot.sessionId === snapshot.connectionId ||
    !isFilePlaybackSessionId(snapshot.baselineId) ||
    !isFilePlaybackSessionId(snapshot.guestParticipantId) ||
    !isPlaybackRevisionWatermark(snapshot.playbackRevision) ||
    !isFiniteNonNegative(snapshot.observedAtRoomTimeMs)
  ) {
    return null;
  }
  if (
    new Set([
      snapshot.sessionId,
      snapshot.connectionId,
      snapshot.baselineId,
      snapshot.guestParticipantId,
    ]).size !== 4
  ) {
    return null;
  }

  const ready = freezeCanonical({
    protocolVersion: FILE_PLAYBACK_PRODUCT_PROTOCOL_VERSION,
    type: FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    baselineId: snapshot.baselineId,
    guestParticipantId: snapshot.guestParticipantId,
    playbackRevision: snapshot.playbackRevision as PlaybackRevisionWatermark,
    observedAtRoomTimeMs: snapshot.observedAtRoomTimeMs,
  });
  return serializedByteLength(ready) <= FILE_PLAYBACK_PRODUCT_READY_V2_MAX_RAW_FRAME_BYTES
    ? ready
    : null;
}

export function parseFilePlaybackProductBaselineV2(
  value: unknown,
): Readonly<FilePlaybackProductBaselineV2> | null {
  const snapshot = snapshotExactPrimitiveRecord(value, BASELINE_KEYS);
  return snapshot ? canonicalizeBaseline(snapshot) : null;
}

export function createFilePlaybackProductBaselineV2(
  input: FilePlaybackProductBaselineV2Input,
): Readonly<FilePlaybackProductBaselineV2> {
  const snapshot = snapshotExactPrimitiveRecord(input, BASELINE_INPUT_KEYS);
  if (!snapshot) throw new TypeError('File playback product baseline input is invalid');
  const baseline = canonicalizeBaseline(
    freezeCanonical({
      ...snapshot,
      protocolVersion: FILE_PLAYBACK_PRODUCT_PROTOCOL_VERSION,
      type: FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
    }),
  );
  if (!baseline) throw new TypeError('File playback product baseline is invalid');
  return baseline;
}

export function parseFilePlaybackProductReadyV2(
  value: unknown,
): Readonly<FilePlaybackProductReadyV2> | null {
  const snapshot = snapshotExactPrimitiveRecord(value, READY_KEYS);
  return snapshot ? canonicalizeReady(snapshot) : null;
}

export function createFilePlaybackProductReadyV2(
  input: FilePlaybackProductReadyV2Input,
): Readonly<FilePlaybackProductReadyV2> {
  const snapshot = snapshotExactPrimitiveRecord(input, READY_INPUT_KEYS);
  if (!snapshot) throw new TypeError('File playback product ready input is invalid');
  const ready = canonicalizeReady(
    freezeCanonical({
      ...snapshot,
      protocolVersion: FILE_PLAYBACK_PRODUCT_PROTOCOL_VERSION,
      type: FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
    }),
  );
  if (!ready) throw new TypeError('File playback product ready is invalid');
  return ready;
}

export function serializeFilePlaybackProductFrameV2(value: unknown): string {
  const frame = parseFilePlaybackProductBaselineV2(value) ?? parseFilePlaybackProductReadyV2(value);
  if (!frame) throw new TypeError('File playback product frame is invalid');
  return JSON.stringify(frame);
}

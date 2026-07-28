import { isFilePlaybackSessionId } from '../network/file-playback-session-handshake.ts';
import {
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE,
} from '../network/file-playback-transport-contract.ts';
import {
  createPlaybackRunIdentity,
  isPlaybackRevision,
  isPlaybackRevisionWatermark,
  type PlaybackRunIdentity,
} from './playback-identity.ts';
import type { PlaybackTimelineSnapshot } from './playback-timeline.ts';
import type { QueueItemId } from '../types/index.ts';

export const FILE_PLAYBACK_TIMELINE_UPDATE_V2_PROTOCOL_VERSION = 2 as const;
export const FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_FRAME_BYTES =
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_RAW_FRAME_BYTES;

const UPDATE_KEYS = Object.freeze([
  'anchorRoomTimeMs',
  'connectionId',
  'phase',
  'positionSeconds',
  'protocolVersion',
  'queueItemId',
  'rate',
  'revision',
  'roomGeneration',
  'runId',
  'sessionId',
  'type',
] as const);
const INPUT_KEYS = Object.freeze([
  'connectionId',
  'roomGeneration',
  'sessionId',
  'timeline',
] as const);
const TIMELINE_KEYS = Object.freeze([
  'anchorMonotonicMs',
  'phase',
  'positionSeconds',
  'rate',
  'revision',
  'run',
  'schemaVersion',
] as const);

type ExactSnapshot = Readonly<Record<string, unknown>>;

/** Primitive-only auxiliary frame accepted by the application-session lane. */
export interface FilePlaybackTimelineUpdateV2 {
  readonly type: typeof FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE;
  readonly protocolVersion: typeof FILE_PLAYBACK_TIMELINE_UPDATE_V2_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly roomGeneration: number;
  readonly revision: number;
  readonly phase: 'stopped' | 'paused' | 'playing';
  readonly queueItemId: QueueItemId | null;
  readonly runId: string | null;
  readonly positionSeconds: number;
  readonly anchorRoomTimeMs: number;
  readonly rate: number;
}

export interface FilePlaybackTimelineUpdateV2Input {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly roomGeneration: number;
  readonly timeline: Readonly<PlaybackTimelineSnapshot>;
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): ExactSnapshot | null {
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

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPlaybackRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function canonicalRun(value: unknown): Readonly<PlaybackRunIdentity> | null {
  try {
    return createPlaybackRunIdentity(value as PlaybackRunIdentity);
  } catch {
    return null;
  }
}

function canonicalTimeline(value: unknown): Readonly<PlaybackTimelineSnapshot> | null {
  const snapshot = snapshotExactDataRecord(value, TIMELINE_KEYS);
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    !isPlaybackRevisionWatermark(snapshot.revision) ||
    (snapshot.phase !== 'stopped' && snapshot.phase !== 'paused' && snapshot.phase !== 'playing') ||
    !isFiniteNonNegative(snapshot.positionSeconds) ||
    !isFiniteNonNegative(snapshot.anchorMonotonicMs) ||
    !isPlaybackRate(snapshot.rate)
  ) {
    return null;
  }
  if (snapshot.phase === 'stopped') {
    if (snapshot.run !== null || snapshot.positionSeconds !== 0 || snapshot.rate !== 1) return null;
    return freezeCanonical({
      schemaVersion: 1 as const,
      revision: snapshot.revision,
      phase: 'stopped' as const,
      run: null,
      positionSeconds: 0,
      anchorMonotonicMs: snapshot.anchorMonotonicMs,
      rate: 1,
    });
  }
  const run = canonicalRun(snapshot.run);
  if (!isPlaybackRevision(snapshot.revision) || !run) return null;
  return freezeCanonical({
    schemaVersion: 1 as const,
    revision: snapshot.revision,
    phase: snapshot.phase as FilePlaybackTimelineUpdateV2['phase'],
    run,
    positionSeconds: snapshot.positionSeconds,
    anchorMonotonicMs: snapshot.anchorMonotonicMs,
    rate: snapshot.rate,
  });
}

function serializedByteLength(value: object): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function canonicalUpdate(snapshot: ExactSnapshot): Readonly<FilePlaybackTimelineUpdateV2> | null {
  if (
    snapshot.type !== FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE ||
    snapshot.protocolVersion !== FILE_PLAYBACK_TIMELINE_UPDATE_V2_PROTOCOL_VERSION ||
    !isFilePlaybackSessionId(snapshot.sessionId) ||
    !isFilePlaybackSessionId(snapshot.connectionId) ||
    snapshot.sessionId === snapshot.connectionId ||
    !isPositiveSafeInteger(snapshot.roomGeneration) ||
    !isPlaybackRevisionWatermark(snapshot.revision) ||
    (snapshot.phase !== 'stopped' && snapshot.phase !== 'paused' && snapshot.phase !== 'playing') ||
    !isFiniteNonNegative(snapshot.positionSeconds) ||
    !isFiniteNonNegative(snapshot.anchorRoomTimeMs) ||
    !isPlaybackRate(snapshot.rate)
  ) {
    return null;
  }

  let queueItemId: QueueItemId | null = null;
  let runId: string | null = null;
  if (snapshot.phase === 'stopped') {
    if (
      snapshot.queueItemId !== null ||
      snapshot.runId !== null ||
      snapshot.positionSeconds !== 0 ||
      snapshot.rate !== 1
    ) {
      return null;
    }
  } else {
    const run = canonicalRun({ queueItemId: snapshot.queueItemId, runId: snapshot.runId });
    if (!isPlaybackRevision(snapshot.revision) || !run) return null;
    queueItemId = run.queueItemId;
    runId = run.runId;
  }

  const update = freezeCanonical({
    type: FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE,
    protocolVersion: FILE_PLAYBACK_TIMELINE_UPDATE_V2_PROTOCOL_VERSION,
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    roomGeneration: snapshot.roomGeneration,
    revision: snapshot.revision,
    phase: snapshot.phase as FilePlaybackTimelineUpdateV2['phase'],
    queueItemId,
    runId,
    positionSeconds: snapshot.positionSeconds,
    anchorRoomTimeMs: snapshot.anchorRoomTimeMs,
    rate: snapshot.rate,
  });
  return serializedByteLength(update) <= FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_FRAME_BYTES
    ? update
    : null;
}

export function parseFilePlaybackTimelineUpdateV2(
  value: unknown,
): Readonly<FilePlaybackTimelineUpdateV2> | null {
  const snapshot = snapshotExactDataRecord(value, UPDATE_KEYS);
  return snapshot ? canonicalUpdate(snapshot) : null;
}

export function createFilePlaybackTimelineUpdateV2(
  input: FilePlaybackTimelineUpdateV2Input,
): Readonly<FilePlaybackTimelineUpdateV2> {
  const snapshot = snapshotExactDataRecord(input, INPUT_KEYS);
  const timeline = snapshot ? canonicalTimeline(snapshot.timeline) : null;
  if (!snapshot || !timeline) throw new TypeError('File playback timeline update input is invalid');
  const update = canonicalUpdate(
    freezeCanonical({
      type: FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE,
      protocolVersion: FILE_PLAYBACK_TIMELINE_UPDATE_V2_PROTOCOL_VERSION,
      sessionId: snapshot.sessionId,
      connectionId: snapshot.connectionId,
      roomGeneration: snapshot.roomGeneration,
      revision: timeline.revision,
      phase: timeline.phase,
      queueItemId: timeline.run?.queueItemId ?? null,
      runId: timeline.run?.runId ?? null,
      positionSeconds: timeline.positionSeconds,
      anchorRoomTimeMs: timeline.anchorMonotonicMs,
      rate: timeline.rate,
    }),
  );
  if (!update) throw new TypeError('File playback timeline update is invalid');
  return update;
}

export function timelineFromFilePlaybackTimelineUpdateV2(
  value: unknown,
): Readonly<PlaybackTimelineSnapshot> | null {
  const update = parseFilePlaybackTimelineUpdateV2(value);
  if (!update) return null;
  return canonicalTimeline({
    schemaVersion: 1,
    revision: update.revision,
    phase: update.phase,
    run:
      update.queueItemId === null || update.runId === null
        ? null
        : { queueItemId: update.queueItemId, runId: update.runId },
    positionSeconds: update.positionSeconds,
    anchorMonotonicMs: update.anchorRoomTimeMs,
    rate: update.rate,
  });
}

export function serializeFilePlaybackTimelineUpdateV2(value: unknown): string {
  const update = parseFilePlaybackTimelineUpdateV2(value);
  if (!update) throw new TypeError('File playback timeline update is invalid');
  return JSON.stringify(update);
}

export function isFilePlaybackTimelineUpdateV2Replay(left: unknown, right: unknown): boolean {
  const safeLeft = parseFilePlaybackTimelineUpdateV2(left);
  const safeRight = parseFilePlaybackTimelineUpdateV2(right);
  if (!safeLeft || !safeRight) return false;
  return UPDATE_KEYS.every((key) => safeLeft[key] === safeRight[key]);
}

import type { QueueItemId } from '../../../types/index.ts';
import { isPlaybackRevision } from '../../playback-identity.ts';
import { isQueueItemId } from '../../queue-model.ts';

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_MIME_TYPE_LENGTH = 128;
const MAX_ACTOR_INBOX = 256;
const MAX_RESYNC_REQUEST_ATTEMPTS = 8;

export type FilePlaybackDeliveryKind = 'blob' | 'peer-range' | 'r2-records';
export type FilePlaybackRoomTimelinePhase = 'stopped' | 'playing' | 'paused';

export interface FilePlaybackRoomRun {
  readonly queueItemId: QueueItemId;
  readonly runId: string;
}

/**
 * Canonical host room-clock timeline. `anchorRoomTimeMs` is never a local
 * `performance.now()` value. A renderer adapter must map it through a live
 * clock lease before scheduling native output.
 */
export interface FilePlaybackRoomTimeline {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly phase: FilePlaybackRoomTimelinePhase;
  readonly run: FilePlaybackRoomRun | null;
  readonly positionSeconds: number;
  readonly anchorRoomTimeMs: number;
  readonly rate: number;
}

export type FilePlaybackRoomTimelineIntent =
  | Readonly<{
      readonly type: 'play';
      readonly revision: number;
      readonly run: FilePlaybackRoomRun;
      readonly positionSeconds: number;
      readonly rate: number;
    }>
  | Readonly<{
      readonly type: 'pause' | 'stop';
      readonly revision: number;
      readonly run: FilePlaybackRoomRun;
    }>
  | Readonly<{
      readonly type: 'seek';
      readonly revision: number;
      readonly run: FilePlaybackRoomRun;
      readonly positionSeconds: number;
    }>;

/**
 * The secret/body descriptor remains in a transport-owned immutable registry.
 * This binding carries the complete epoch-scoped lookup identity required to
 * resolve exactly one descriptor without consulting mutable queue position.
 */
export interface FilePlaybackMediaBinding {
  readonly bindingId: string;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly delivery: FilePlaybackDeliveryKind;
  readonly descriptorId: string;
  readonly descriptorVersion: number;
  readonly encodedSize: number;
  readonly mimeType: string;
  readonly durationSeconds: number | null;
}

interface FilePlaybackRoomEventEnvelope {
  readonly schemaVersion: 1;
  readonly roomEpoch: string;
  readonly sequence: number;
  readonly eventId: string;
}

export interface FilePlaybackMediaBoundEvent extends FilePlaybackRoomEventEnvelope {
  readonly kind: 'media-bound';
  readonly media: FilePlaybackMediaBinding | null;
}

export interface FilePlaybackTimelineTransitionEvent extends FilePlaybackRoomEventEnvelope {
  readonly kind: 'timeline-transition';
  readonly atRoomTimeMs: number;
  readonly intent: FilePlaybackRoomTimelineIntent;
}

export interface FilePlaybackSnapshotEvent extends FilePlaybackRoomEventEnvelope {
  readonly kind: 'snapshot';
  readonly timeline: FilePlaybackRoomTimeline;
  readonly media: FilePlaybackMediaBinding | null;
}

export type FilePlaybackRoomEvent =
  | FilePlaybackMediaBoundEvent
  | FilePlaybackTimelineTransitionEvent
  | FilePlaybackSnapshotEvent;

export interface FilePlaybackEffectLease {
  readonly roomEpoch: string;
  readonly actorGeneration: string;
  readonly effectSerial: number;
  readonly effectId: string;
}

export interface FilePlaybackRendererCompletionEvent {
  readonly schemaVersion: 1;
  readonly kind: 'renderer-effect-completed';
  readonly roomEpoch: string;
  readonly actorGeneration: string;
  readonly lease: FilePlaybackEffectLease;
  readonly outcome: 'ready' | 'failed';
}

export interface FilePlaybackResyncRetryEvent {
  readonly schemaVersion: 1;
  readonly kind: 'resync-retry';
  readonly roomEpoch: string;
  readonly actorGeneration: string;
  readonly resyncGeneration: number;
}

export type FilePlaybackActorInput =
  | FilePlaybackRoomEvent
  | FilePlaybackRendererCompletionEvent
  | FilePlaybackResyncRetryEvent;

export interface FilePlaybackRoomResyncState {
  readonly generation: number;
  readonly expectedSequence: number;
  readonly highestObservedSequence: number;
  readonly requestAttempt: number;
}

export type FilePlaybackRendererStatus = 'idle' | 'reconciling' | 'ready' | 'degraded';

export interface FilePlaybackRoomReplica {
  readonly schemaVersion: 1;
  readonly roomEpoch: string;
  readonly actorGeneration: string;
  readonly appliedSequence: number;
  readonly snapshotSequence: number;
  readonly lastEventId: string | null;
  readonly lastEventFingerprint: string | null;
  readonly stateVersion: number;
  readonly effectSerial: number;
  readonly resyncSerial: number;
  readonly timeline: FilePlaybackRoomTimeline;
  readonly media: FilePlaybackMediaBinding | null;
  readonly rendererStatus: FilePlaybackRendererStatus;
  readonly activeRendererLease: FilePlaybackEffectLease | null;
  readonly resync: FilePlaybackRoomResyncState | null;
}

export type FilePlaybackRoomEffect =
  | Readonly<{
      readonly kind: 'request-snapshot';
      readonly roomEpoch: string;
      readonly actorGeneration: string;
      readonly resyncGeneration: number;
      readonly haveSequence: number;
      readonly expectedSequence: number;
      readonly highestObservedSequence: number;
      readonly attempt: number;
    }>
  | Readonly<{
      readonly kind: 'request-media';
      readonly roomEpoch: string;
      readonly actorGeneration: string;
      readonly desiredSequence: number;
      readonly queueItemId: QueueItemId;
    }>
  | Readonly<{
      readonly kind: 'reconcile-renderer';
      readonly timeline: FilePlaybackRoomTimeline;
      readonly media: FilePlaybackMediaBinding | null;
      readonly lease: FilePlaybackEffectLease;
    }>
  | Readonly<{
      readonly kind: 'retire-stale-renderer';
      readonly lease: FilePlaybackEffectLease;
    }>;

export type FilePlaybackRoomReduceStatus = 'applied' | 'ignored' | 'resync-required' | 'rejected';

export type FilePlaybackRoomReduceReason =
  | null
  | 'duplicate'
  | 'stale'
  | 'stale-local-event'
  | 'sequence-gap'
  | 'sequence-conflict'
  | 'resync-pending'
  | 'resync-retry-exhausted'
  | 'timeline-conflict'
  | 'invalid-event'
  | 'foreign-room-epoch'
  | 'regressive-snapshot'
  | 'inconsistent-snapshot'
  | 'counter-exhausted'
  | 'inbox-overflow';

export interface FilePlaybackRoomReduceResult {
  readonly status: FilePlaybackRoomReduceStatus;
  readonly reason: FilePlaybackRoomReduceReason;
  readonly event: FilePlaybackActorInput | null;
  readonly state: FilePlaybackRoomReplica;
  readonly effects: readonly FilePlaybackRoomEffect[];
}

interface ExactDataRecord {
  readonly descriptors: PropertyDescriptorMap;
  readonly keys: readonly PropertyKey[];
}

interface PendingActorEvent {
  readonly event: unknown;
  readonly resolve: (result: FilePlaybackRoomReduceResult) => void;
  readonly reject: (error: unknown) => void;
}

export interface FilePlaybackRoomActorOptions {
  readonly roomEpoch: string;
  readonly actorGeneration: string;
  readonly anchorRoomTimeMs?: number;
  readonly onResult?: (result: FilePlaybackRoomReduceResult) => void;
  readonly onObserverError?: (error: unknown) => void;
}

const EVENT_ENVELOPE_KEYS = Object.freeze([
  'schemaVersion',
  'roomEpoch',
  'sequence',
  'eventId',
] as const);
const MEDIA_BOUND_EVENT_KEYS = Object.freeze([...EVENT_ENVELOPE_KEYS, 'kind', 'media'] as const);
const TIMELINE_EVENT_KEYS = Object.freeze([
  ...EVENT_ENVELOPE_KEYS,
  'kind',
  'atRoomTimeMs',
  'intent',
] as const);
const SNAPSHOT_EVENT_KEYS = Object.freeze([
  ...EVENT_ENVELOPE_KEYS,
  'kind',
  'timeline',
  'media',
] as const);
const MEDIA_BINDING_KEYS = Object.freeze([
  'bindingId',
  'queueItemId',
  'sourceIdentity',
  'delivery',
  'descriptorId',
  'descriptorVersion',
  'encodedSize',
  'mimeType',
  'durationSeconds',
] as const);
const TIMELINE_KEYS = Object.freeze([
  'schemaVersion',
  'revision',
  'phase',
  'run',
  'positionSeconds',
  'anchorRoomTimeMs',
  'rate',
] as const);
const TIMELINE_INTENT_KEYS: Readonly<
  Record<FilePlaybackRoomTimelineIntent['type'], readonly string[]>
> = Object.freeze({
  play: Object.freeze(['type', 'revision', 'run', 'positionSeconds', 'rate']),
  pause: Object.freeze(['type', 'revision', 'run']),
  seek: Object.freeze(['type', 'revision', 'run', 'positionSeconds']),
  stop: Object.freeze(['type', 'revision', 'run']),
});
const PLAYBACK_RUN_KEYS = Object.freeze(['queueItemId', 'runId'] as const);
const EFFECT_LEASE_KEYS = Object.freeze([
  'roomEpoch',
  'actorGeneration',
  'effectSerial',
  'effectId',
] as const);
const RENDERER_COMPLETION_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'roomEpoch',
  'actorGeneration',
  'lease',
  'outcome',
] as const);
const RESYNC_RETRY_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'roomEpoch',
  'actorGeneration',
  'resyncGeneration',
] as const);

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function readDataRecord(value: unknown): ExactDataRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return freezeCanonical({ descriptors, keys: Object.freeze(Reflect.ownKeys(descriptors)) });
  } catch {
    return null;
  }
}

function projectExact(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  const record = readDataRecord(value);
  if (!record) return null;
  const expected = new Set(expectedKeys);
  if (
    record.keys.length !== expected.size ||
    record.keys.some((key) => typeof key !== 'string' || !expected.has(key))
  ) {
    return null;
  }
  const projected = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = record.descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    projected[key] = descriptor.value;
  }
  return Object.freeze(projected);
}

function isIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim()
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

function isMimeType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MIME_TYPE_LENGTH &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function isCounter(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function isPositiveCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nextCounter(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
    ? value + 1
    : null;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPlaybackRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function readPlaybackRun(value: unknown): FilePlaybackRoomRun | null {
  const candidate = projectExact(value, PLAYBACK_RUN_KEYS);
  if (!candidate || !isQueueItemId(candidate.queueItemId) || !isIdentifier(candidate.runId)) {
    return null;
  }
  return freezeCanonical({ queueItemId: candidate.queueItemId, runId: candidate.runId });
}

function readTimelineIntent(value: unknown): FilePlaybackRoomTimelineIntent | null {
  const record = readDataRecord(value);
  if (!record) return null;
  const typeDescriptor = record.descriptors.type;
  if (!typeDescriptor?.enumerable || !Object.hasOwn(typeDescriptor, 'value')) return null;
  const typeValue = typeDescriptor.value;
  if (
    typeValue !== 'play' &&
    typeValue !== 'pause' &&
    typeValue !== 'seek' &&
    typeValue !== 'stop'
  ) {
    return null;
  }
  const type: FilePlaybackRoomTimelineIntent['type'] = typeValue;
  const candidate = projectExact(value, TIMELINE_INTENT_KEYS[type]);
  if (!candidate || !isPlaybackRevision(candidate.revision)) return null;
  const run = readPlaybackRun(candidate.run);
  if (!run) return null;
  switch (type) {
    case 'play':
      if (!isFiniteNonNegative(candidate.positionSeconds) || !isPlaybackRate(candidate.rate)) {
        return null;
      }
      return freezeCanonical({
        type,
        revision: candidate.revision,
        run,
        positionSeconds: candidate.positionSeconds,
        rate: candidate.rate,
      });
    case 'pause':
    case 'stop':
      return freezeCanonical({ type, revision: candidate.revision, run });
    case 'seek':
      if (!isFiniteNonNegative(candidate.positionSeconds)) return null;
      return freezeCanonical({
        type,
        revision: candidate.revision,
        run,
        positionSeconds: candidate.positionSeconds,
      });
  }
  return null;
}

function readTimeline(value: unknown): FilePlaybackRoomTimeline | null {
  const candidate = projectExact(value, TIMELINE_KEYS);
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    !isCounter(candidate.revision) ||
    (candidate.phase !== 'stopped' &&
      candidate.phase !== 'playing' &&
      candidate.phase !== 'paused') ||
    !isFiniteNonNegative(candidate.positionSeconds) ||
    !isFiniteNonNegative(candidate.anchorRoomTimeMs) ||
    !isPlaybackRate(candidate.rate)
  ) {
    return null;
  }
  if (candidate.phase === 'stopped') {
    if (candidate.run !== null || candidate.positionSeconds !== 0 || candidate.rate !== 1) {
      return null;
    }
    return freezeCanonical({
      schemaVersion: 1 as const,
      revision: candidate.revision,
      phase: 'stopped' as const,
      run: null,
      positionSeconds: 0,
      anchorRoomTimeMs: candidate.anchorRoomTimeMs,
      rate: 1,
    });
  }
  if (!isPlaybackRevision(candidate.revision)) return null;
  const run = readPlaybackRun(candidate.run);
  if (!run) return null;
  return freezeCanonical({
    schemaVersion: 1 as const,
    revision: candidate.revision,
    phase: candidate.phase,
    run,
    positionSeconds: candidate.positionSeconds,
    anchorRoomTimeMs: candidate.anchorRoomTimeMs,
    rate: candidate.rate,
  });
}

function readMediaBinding(value: unknown): FilePlaybackMediaBinding | null {
  const candidate = projectExact(value, MEDIA_BINDING_KEYS);
  if (
    !candidate ||
    !isIdentifier(candidate.bindingId) ||
    !isQueueItemId(candidate.queueItemId) ||
    !isIdentifier(candidate.sourceIdentity) ||
    (candidate.delivery !== 'blob' &&
      candidate.delivery !== 'peer-range' &&
      candidate.delivery !== 'r2-records') ||
    !isIdentifier(candidate.descriptorId) ||
    !isPositiveCounter(candidate.descriptorVersion) ||
    !isPositiveCounter(candidate.encodedSize) ||
    !isMimeType(candidate.mimeType) ||
    (candidate.durationSeconds !== null &&
      (typeof candidate.durationSeconds !== 'number' ||
        !Number.isFinite(candidate.durationSeconds) ||
        candidate.durationSeconds <= 0))
  ) {
    return null;
  }
  return freezeCanonical({
    bindingId: candidate.bindingId,
    queueItemId: candidate.queueItemId,
    sourceIdentity: candidate.sourceIdentity,
    delivery: candidate.delivery,
    descriptorId: candidate.descriptorId,
    descriptorVersion: candidate.descriptorVersion,
    encodedSize: candidate.encodedSize,
    mimeType: candidate.mimeType,
    durationSeconds: candidate.durationSeconds,
  });
}

function readOptionalMediaBinding(value: unknown): FilePlaybackMediaBinding | null | undefined {
  return value === null ? null : (readMediaBinding(value) ?? undefined);
}

function readEnvelope(candidate: Readonly<Record<string, unknown>>): Readonly<{
  schemaVersion: 1;
  roomEpoch: string;
  sequence: number;
  eventId: string;
}> | null {
  if (
    candidate.schemaVersion !== 1 ||
    !isIdentifier(candidate.roomEpoch) ||
    !isCounter(candidate.sequence) ||
    !isIdentifier(candidate.eventId)
  ) {
    return null;
  }
  return freezeCanonical({
    schemaVersion: 1 as const,
    roomEpoch: candidate.roomEpoch,
    sequence: candidate.sequence,
    eventId: candidate.eventId,
  });
}

export function readFilePlaybackRoomEvent(value: unknown): FilePlaybackRoomEvent | null {
  const record = readDataRecord(value);
  if (!record) return null;
  const kindDescriptor = record.descriptors.kind;
  if (!kindDescriptor?.enumerable || !Object.hasOwn(kindDescriptor, 'value')) return null;
  const kind = kindDescriptor.value;
  if (kind === 'media-bound') {
    const candidate = projectExact(value, MEDIA_BOUND_EVENT_KEYS);
    const envelope = candidate ? readEnvelope(candidate) : null;
    const media = candidate ? readOptionalMediaBinding(candidate.media) : undefined;
    if (!candidate || !envelope || media === undefined) return null;
    return freezeCanonical({ ...envelope, kind, media });
  }
  if (kind === 'timeline-transition') {
    const candidate = projectExact(value, TIMELINE_EVENT_KEYS);
    const envelope = candidate ? readEnvelope(candidate) : null;
    const intent = candidate ? readTimelineIntent(candidate.intent) : null;
    if (!candidate || !envelope || !isFiniteNonNegative(candidate.atRoomTimeMs) || !intent) {
      return null;
    }
    return freezeCanonical({
      ...envelope,
      kind,
      atRoomTimeMs: candidate.atRoomTimeMs,
      intent,
    });
  }
  if (kind === 'snapshot') {
    const candidate = projectExact(value, SNAPSHOT_EVENT_KEYS);
    const envelope = candidate ? readEnvelope(candidate) : null;
    const timeline = candidate ? readTimeline(candidate.timeline) : null;
    const media = candidate ? readOptionalMediaBinding(candidate.media) : undefined;
    if (!candidate || !envelope || !timeline || media === undefined) return null;
    return freezeCanonical({ ...envelope, kind, timeline, media });
  }
  return null;
}

function readEffectLease(value: unknown): FilePlaybackEffectLease | null {
  const candidate = projectExact(value, EFFECT_LEASE_KEYS);
  if (
    !candidate ||
    !isIdentifier(candidate.roomEpoch) ||
    !isIdentifier(candidate.actorGeneration) ||
    !isPositiveCounter(candidate.effectSerial) ||
    !isIdentifier(candidate.effectId)
  ) {
    return null;
  }
  return freezeCanonical({
    roomEpoch: candidate.roomEpoch,
    actorGeneration: candidate.actorGeneration,
    effectSerial: candidate.effectSerial,
    effectId: candidate.effectId,
  });
}

function readLocalActorEvent(
  value: unknown,
): FilePlaybackRendererCompletionEvent | FilePlaybackResyncRetryEvent | null {
  const record = readDataRecord(value);
  if (!record) return null;
  const kindDescriptor = record.descriptors.kind;
  if (!kindDescriptor?.enumerable || !Object.hasOwn(kindDescriptor, 'value')) return null;
  if (kindDescriptor.value === 'renderer-effect-completed') {
    const candidate = projectExact(value, RENDERER_COMPLETION_KEYS);
    const lease = candidate ? readEffectLease(candidate.lease) : null;
    if (
      !candidate ||
      candidate.schemaVersion !== 1 ||
      !isIdentifier(candidate.roomEpoch) ||
      !isIdentifier(candidate.actorGeneration) ||
      !lease ||
      (candidate.outcome !== 'ready' && candidate.outcome !== 'failed')
    ) {
      return null;
    }
    return freezeCanonical({
      schemaVersion: 1 as const,
      kind: 'renderer-effect-completed' as const,
      roomEpoch: candidate.roomEpoch,
      actorGeneration: candidate.actorGeneration,
      lease,
      outcome: candidate.outcome,
    });
  }
  if (kindDescriptor.value === 'resync-retry') {
    const candidate = projectExact(value, RESYNC_RETRY_KEYS);
    if (
      !candidate ||
      candidate.schemaVersion !== 1 ||
      !isIdentifier(candidate.roomEpoch) ||
      !isIdentifier(candidate.actorGeneration) ||
      !isPositiveCounter(candidate.resyncGeneration)
    ) {
      return null;
    }
    return freezeCanonical({
      schemaVersion: 1 as const,
      kind: 'resync-retry' as const,
      roomEpoch: candidate.roomEpoch,
      actorGeneration: candidate.actorGeneration,
      resyncGeneration: candidate.resyncGeneration,
    });
  }
  return null;
}

export function createFilePlaybackActorInput(
  value: FilePlaybackActorInput,
): FilePlaybackActorInput {
  const event = readFilePlaybackRoomEvent(value) ?? readLocalActorEvent(value);
  if (!event) throw new TypeError('File playback actor input is invalid');
  return event;
}

function sameRun(left: FilePlaybackRoomRun | null, right: FilePlaybackRoomRun | null): boolean {
  return !!left && !!right && left.queueItemId === right.queueItemId && left.runId === right.runId;
}

function sameMedia(
  left: FilePlaybackMediaBinding | null,
  right: FilePlaybackMediaBinding | null,
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.bindingId === right.bindingId &&
      left.queueItemId === right.queueItemId &&
      left.sourceIdentity === right.sourceIdentity &&
      left.delivery === right.delivery &&
      left.descriptorId === right.descriptorId &&
      left.descriptorVersion === right.descriptorVersion &&
      left.encodedSize === right.encodedSize &&
      left.mimeType === right.mimeType &&
      left.durationSeconds === right.durationSeconds)
  );
}

function sameLease(
  left: FilePlaybackEffectLease | null,
  right: FilePlaybackEffectLease | null,
): boolean {
  return (
    !!left &&
    !!right &&
    left.roomEpoch === right.roomEpoch &&
    left.actorGeneration === right.actorGeneration &&
    left.effectSerial === right.effectSerial &&
    left.effectId === right.effectId
  );
}

function eventFingerprint(event: FilePlaybackRoomEvent): string {
  return JSON.stringify(event);
}

function createInitialTimeline(anchorRoomTimeMs: number): FilePlaybackRoomTimeline {
  return freezeCanonical({
    schemaVersion: 1 as const,
    revision: 0,
    phase: 'stopped' as const,
    run: null,
    positionSeconds: 0,
    anchorRoomTimeMs,
    rate: 1,
  });
}

function createReplica(
  value: Omit<FilePlaybackRoomReplica, 'schemaVersion'>,
): FilePlaybackRoomReplica {
  return freezeCanonical({ schemaVersion: 1 as const, ...value });
}

export function createInitialFilePlaybackRoomReplica(
  roomEpoch: string,
  actorGeneration: string,
  anchorRoomTimeMs = 0,
): FilePlaybackRoomReplica {
  if (
    !isIdentifier(roomEpoch) ||
    !isIdentifier(actorGeneration) ||
    !isFiniteNonNegative(anchorRoomTimeMs)
  ) {
    throw new TypeError('Initial file playback room replica is invalid');
  }
  return createReplica({
    roomEpoch,
    actorGeneration,
    appliedSequence: 0,
    snapshotSequence: 0,
    lastEventId: null,
    lastEventFingerprint: null,
    stateVersion: 0,
    effectSerial: 0,
    resyncSerial: 0,
    timeline: createInitialTimeline(anchorRoomTimeMs),
    media: null,
    rendererStatus: 'idle',
    activeRendererLease: null,
    resync: null,
  });
}

function result(
  status: FilePlaybackRoomReduceStatus,
  reason: FilePlaybackRoomReduceReason,
  event: FilePlaybackActorInput | null,
  state: FilePlaybackRoomReplica,
  effects: readonly FilePlaybackRoomEffect[] = Object.freeze([]),
): FilePlaybackRoomReduceResult {
  return freezeCanonical({ status, reason, event, state, effects: Object.freeze([...effects]) });
}

function requestSnapshotEffect(
  state: FilePlaybackRoomReplica,
  resync: FilePlaybackRoomResyncState,
): FilePlaybackRoomEffect {
  return freezeCanonical({
    kind: 'request-snapshot' as const,
    roomEpoch: state.roomEpoch,
    actorGeneration: state.actorGeneration,
    resyncGeneration: resync.generation,
    haveSequence: state.appliedSequence,
    expectedSequence: resync.expectedSequence,
    highestObservedSequence: resync.highestObservedSequence,
    attempt: resync.requestAttempt,
  });
}

function requestMediaEffect(
  state: FilePlaybackRoomReplica,
  queueItemId: QueueItemId,
): FilePlaybackRoomEffect {
  return freezeCanonical({
    kind: 'request-media' as const,
    roomEpoch: state.roomEpoch,
    actorGeneration: state.actorGeneration,
    desiredSequence: state.appliedSequence,
    queueItemId,
  });
}

function desiredMediaMissing(state: FilePlaybackRoomReplica): QueueItemId | null {
  return state.timeline.phase !== 'stopped' &&
    state.timeline.run &&
    state.media?.queueItemId !== state.timeline.run.queueItemId
    ? state.timeline.run.queueItemId
    : null;
}

function commitSequenceOnly(
  state: FilePlaybackRoomReplica,
  event: FilePlaybackRoomEvent,
): FilePlaybackRoomReplica | null {
  const stateVersion = nextCounter(state.stateVersion);
  if (stateVersion === null) return null;
  return createReplica({
    ...state,
    appliedSequence: event.sequence,
    lastEventId: event.eventId,
    lastEventFingerprint: eventFingerprint(event),
    stateVersion,
  });
}

function commitDesiredState(
  state: FilePlaybackRoomReplica,
  event: FilePlaybackRoomEvent,
  timeline: FilePlaybackRoomTimeline,
  media: FilePlaybackMediaBinding | null,
  snapshotSequence = state.snapshotSequence,
): Readonly<{
  state: FilePlaybackRoomReplica;
  effects: readonly FilePlaybackRoomEffect[];
}> | null {
  const stateVersion = nextCounter(state.stateVersion);
  const effectSerial = nextCounter(state.effectSerial);
  if (stateVersion === null || effectSerial === null) return null;
  const lease = freezeCanonical({
    roomEpoch: state.roomEpoch,
    actorGeneration: state.actorGeneration,
    effectSerial,
    effectId: `${state.actorGeneration}:renderer:${effectSerial}`,
  });
  const next = createReplica({
    ...state,
    appliedSequence: event.sequence,
    snapshotSequence,
    lastEventId: event.eventId,
    lastEventFingerprint: eventFingerprint(event),
    stateVersion,
    effectSerial,
    timeline,
    media,
    rendererStatus: 'reconciling',
    activeRendererLease: lease,
    resync: null,
  });
  const effects: FilePlaybackRoomEffect[] = [
    freezeCanonical({ kind: 'reconcile-renderer' as const, timeline, media, lease }),
  ];
  const missing = desiredMediaMissing(next);
  if (missing) effects.push(requestMediaEffect(next, missing));
  return freezeCanonical({ state: next, effects: Object.freeze(effects) });
}

function enterResync(
  state: FilePlaybackRoomReplica,
  event: FilePlaybackRoomEvent,
  reason: Extract<
    FilePlaybackRoomReduceReason,
    'sequence-gap' | 'sequence-conflict' | 'timeline-conflict'
  >,
): FilePlaybackRoomReduceResult {
  const stateVersion = nextCounter(state.stateVersion);
  const generation = nextCounter(state.resyncSerial);
  if (stateVersion === null || generation === null) {
    return result('rejected', 'counter-exhausted', event, state);
  }
  const resync = freezeCanonical({
    generation,
    expectedSequence: state.appliedSequence + 1,
    highestObservedSequence: event.sequence,
    requestAttempt: 1,
  });
  const next = createReplica({
    ...state,
    stateVersion,
    resyncSerial: generation,
    resync,
  });
  return result('resync-required', reason, event, next, [requestSnapshotEffect(next, resync)]);
}

function observeDuringResync(
  state: FilePlaybackRoomReplica,
  event: FilePlaybackRoomEvent,
): FilePlaybackRoomReduceResult {
  const current = state.resync;
  if (!current) throw new Error('resync state is missing');
  if (event.sequence <= state.appliedSequence || event.sequence <= state.snapshotSequence) {
    return result('ignored', 'stale', event, state);
  }
  if (event.sequence <= current.highestObservedSequence) {
    return result('resync-required', 'resync-pending', event, state);
  }
  const stateVersion = nextCounter(state.stateVersion);
  if (stateVersion === null) return result('rejected', 'counter-exhausted', event, state);
  const canRequest = current.requestAttempt < MAX_RESYNC_REQUEST_ATTEMPTS;
  const nextResync = freezeCanonical({
    ...current,
    highestObservedSequence: event.sequence,
    requestAttempt: canRequest ? current.requestAttempt + 1 : current.requestAttempt,
  });
  const next = createReplica({ ...state, stateVersion, resync: nextResync });
  return result(
    'resync-required',
    canRequest ? 'resync-pending' : 'resync-retry-exhausted',
    event,
    next,
    canRequest ? [requestSnapshotEffect(next, nextResync)] : [],
  );
}

function derivePosition(timeline: FilePlaybackRoomTimeline, atRoomTimeMs: number): number | null {
  if (atRoomTimeMs < timeline.anchorRoomTimeMs) return null;
  if (timeline.phase !== 'playing') return timeline.positionSeconds;
  const position =
    timeline.positionSeconds + ((atRoomTimeMs - timeline.anchorRoomTimeMs) / 1_000) * timeline.rate;
  return Number.isFinite(position) && position >= 0 ? position : null;
}

function applyTimelineIntent(
  timeline: FilePlaybackRoomTimeline,
  intent: FilePlaybackRoomTimelineIntent,
  atRoomTimeMs: number,
): FilePlaybackRoomTimeline | null {
  if (intent.revision !== timeline.revision + 1) return null;
  if (intent.type !== 'play' && !sameRun(timeline.run, intent.run)) return null;
  const currentPosition = derivePosition(timeline, atRoomTimeMs);
  if (currentPosition === null) return null;
  switch (intent.type) {
    case 'play':
      return freezeCanonical({
        schemaVersion: 1 as const,
        revision: intent.revision,
        phase: 'playing' as const,
        run: intent.run,
        positionSeconds: intent.positionSeconds,
        anchorRoomTimeMs: atRoomTimeMs,
        rate: intent.rate,
      });
    case 'pause':
      return freezeCanonical({
        schemaVersion: 1 as const,
        revision: intent.revision,
        phase: 'paused' as const,
        run: intent.run,
        positionSeconds: currentPosition,
        anchorRoomTimeMs: atRoomTimeMs,
        rate: timeline.rate,
      });
    case 'seek':
      return freezeCanonical({
        schemaVersion: 1 as const,
        revision: intent.revision,
        phase: timeline.phase,
        run: intent.run,
        positionSeconds: intent.positionSeconds,
        anchorRoomTimeMs: atRoomTimeMs,
        rate: timeline.rate,
      });
    case 'stop':
      return freezeCanonical({
        schemaVersion: 1 as const,
        revision: intent.revision,
        phase: 'stopped' as const,
        run: null,
        positionSeconds: 0,
        anchorRoomTimeMs: atRoomTimeMs,
        rate: 1,
      });
  }
}

function snapshotIsConsistent(event: FilePlaybackSnapshotEvent): boolean {
  return (
    event.timeline.phase === 'stopped' ||
    (!!event.timeline.run && event.media?.queueItemId === event.timeline.run.queueItemId)
  );
}

function retrySnapshot(
  state: FilePlaybackRoomReplica,
  event: FilePlaybackActorInput,
): FilePlaybackRoomReduceResult {
  const current = state.resync;
  if (!current) return result('ignored', 'stale-local-event', event, state);
  if (current.requestAttempt >= MAX_RESYNC_REQUEST_ATTEMPTS) {
    return result('resync-required', 'resync-retry-exhausted', event, state);
  }
  const stateVersion = nextCounter(state.stateVersion);
  if (stateVersion === null) return result('rejected', 'counter-exhausted', event, state);
  const nextResync = freezeCanonical({ ...current, requestAttempt: current.requestAttempt + 1 });
  const next = createReplica({ ...state, stateVersion, resync: nextResync });
  return result('resync-required', 'resync-pending', event, next, [
    requestSnapshotEffect(next, nextResync),
  ]);
}

function applySnapshot(
  state: FilePlaybackRoomReplica,
  event: FilePlaybackSnapshotEvent,
): FilePlaybackRoomReduceResult {
  const fingerprint = eventFingerprint(event);
  if (state.resync && event.sequence < state.resync.highestObservedSequence) {
    return retrySnapshot(state, event);
  }
  if (event.sequence < state.appliedSequence || event.sequence < state.snapshotSequence) {
    return result('ignored', 'stale', event, state);
  }
  if (event.timeline.revision < state.timeline.revision) {
    return result('rejected', 'regressive-snapshot', event, state);
  }
  if (!snapshotIsConsistent(event)) {
    return result('rejected', 'inconsistent-snapshot', event, state);
  }
  if (
    !state.resync &&
    event.sequence === state.appliedSequence &&
    event.eventId === state.lastEventId &&
    fingerprint === state.lastEventFingerprint
  ) {
    return result('ignored', 'duplicate', event, state);
  }
  if (
    !state.resync &&
    event.sequence === state.appliedSequence &&
    (event.eventId !== state.lastEventId || fingerprint !== state.lastEventFingerprint)
  ) {
    return enterResync(state, event, 'sequence-conflict');
  }
  const committed = commitDesiredState(state, event, event.timeline, event.media, event.sequence);
  return committed
    ? result('applied', null, event, committed.state, committed.effects)
    : result('rejected', 'counter-exhausted', event, state);
}

function applyMutation(
  state: FilePlaybackRoomReplica,
  event: FilePlaybackMediaBoundEvent | FilePlaybackTimelineTransitionEvent,
): FilePlaybackRoomReduceResult {
  if (state.resync) return observeDuringResync(state, event);
  if (event.sequence <= state.snapshotSequence || event.sequence < state.appliedSequence) {
    return result('ignored', 'stale', event, state);
  }
  const fingerprint = eventFingerprint(event);
  if (event.sequence === state.appliedSequence) {
    return event.eventId === state.lastEventId && fingerprint === state.lastEventFingerprint
      ? result('ignored', 'duplicate', event, state)
      : enterResync(state, event, 'sequence-conflict');
  }
  if (event.sequence !== state.appliedSequence + 1) {
    return enterResync(state, event, 'sequence-gap');
  }

  if (event.kind === 'media-bound') {
    const activeQueueItemId =
      state.timeline.phase === 'stopped' ? null : (state.timeline.run?.queueItemId ?? null);
    const applicableMedia =
      activeQueueItemId && event.media?.queueItemId !== activeQueueItemId
        ? state.media?.queueItemId === activeQueueItemId
          ? state.media
          : null
        : event.media;
    if (sameMedia(applicableMedia, state.media)) {
      const next = commitSequenceOnly(state, event);
      if (!next) return result('rejected', 'counter-exhausted', event, state);
      const missing = desiredMediaMissing(next);
      return result(
        'applied',
        null,
        event,
        next,
        missing ? [requestMediaEffect(next, missing)] : [],
      );
    }
    const committed = commitDesiredState(state, event, state.timeline, applicableMedia);
    return committed
      ? result('applied', null, event, committed.state, committed.effects)
      : result('rejected', 'counter-exhausted', event, state);
  }

  const timeline = applyTimelineIntent(state.timeline, event.intent, event.atRoomTimeMs);
  if (!timeline) return enterResync(state, event, 'timeline-conflict');
  const media =
    timeline.phase === 'stopped' || state.media?.queueItemId === timeline.run?.queueItemId
      ? state.media
      : null;
  const committed = commitDesiredState(state, event, timeline, media);
  return committed
    ? result('applied', null, event, committed.state, committed.effects)
    : result('rejected', 'counter-exhausted', event, state);
}

function applyRendererCompletion(
  state: FilePlaybackRoomReplica,
  event: FilePlaybackRendererCompletionEvent,
): FilePlaybackRoomReduceResult {
  if (
    event.roomEpoch !== state.roomEpoch ||
    event.actorGeneration !== state.actorGeneration ||
    !sameLease(event.lease, state.activeRendererLease)
  ) {
    return result('ignored', 'stale-local-event', event, state, [
      freezeCanonical({ kind: 'retire-stale-renderer' as const, lease: event.lease }),
    ]);
  }
  const stateVersion = nextCounter(state.stateVersion);
  if (stateVersion === null) return result('rejected', 'counter-exhausted', event, state);
  const next = createReplica({
    ...state,
    stateVersion,
    rendererStatus: event.outcome === 'ready' ? 'ready' : 'degraded',
    activeRendererLease: null,
  });
  return result('applied', null, event, next);
}

function applyResyncRetry(
  state: FilePlaybackRoomReplica,
  event: FilePlaybackResyncRetryEvent,
): FilePlaybackRoomReduceResult {
  if (
    event.roomEpoch !== state.roomEpoch ||
    event.actorGeneration !== state.actorGeneration ||
    event.resyncGeneration !== state.resync?.generation
  ) {
    return result('ignored', 'stale-local-event', event, state);
  }
  return retrySnapshot(state, event);
}

/**
 * Pure, side-effect-free room reducer. Remote sequence and desired state move
 * together only after canonical admission. Local effect completion must pass
 * the exact actor-owned lease.
 */
export function reduceFilePlaybackActorInput(
  state: FilePlaybackRoomReplica,
  value: unknown,
): FilePlaybackRoomReduceResult {
  const roomEvent = readFilePlaybackRoomEvent(value);
  if (roomEvent) {
    if (roomEvent.roomEpoch !== state.roomEpoch) {
      return result('rejected', 'foreign-room-epoch', roomEvent, state);
    }
    return roomEvent.kind === 'snapshot'
      ? applySnapshot(state, roomEvent)
      : applyMutation(state, roomEvent);
  }
  const localEvent = readLocalActorEvent(value);
  if (!localEvent) return result('rejected', 'invalid-event', null, state);
  return localEvent.kind === 'renderer-effect-completed'
    ? applyRendererCompletion(state, localEvent)
    : applyResyncRetry(state, localEvent);
}

/**
 * One bounded serialized inbox. Events queued synchronously by an observer are
 * deliberately processed in a later microtask, preventing callback re-entry
 * from monopolizing the current actor turn.
 */
export class FilePlaybackRoomActor {
  #state: FilePlaybackRoomReplica;
  readonly #onResult: ((result: FilePlaybackRoomReduceResult) => void) | undefined;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #queue: PendingActorEvent[] = [];
  #pendingCount = 0;
  #scheduled = false;
  #draining = false;

  constructor(options: FilePlaybackRoomActorOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      !isIdentifier(options.roomEpoch) ||
      !isIdentifier(options.actorGeneration) ||
      (options.anchorRoomTimeMs !== undefined && !isFiniteNonNegative(options.anchorRoomTimeMs)) ||
      (options.onResult !== undefined && typeof options.onResult !== 'function') ||
      (options.onObserverError !== undefined && typeof options.onObserverError !== 'function')
    ) {
      throw new TypeError('File playback room actor options are invalid');
    }
    this.#state = createInitialFilePlaybackRoomReplica(
      options.roomEpoch,
      options.actorGeneration,
      options.anchorRoomTimeMs,
    );
    this.#onResult = options.onResult;
    this.#onObserverError = options.onObserverError;
  }

  snapshot(): FilePlaybackRoomReplica {
    return this.#state;
  }

  dispatch(event: unknown): Promise<FilePlaybackRoomReduceResult> {
    if (this.#pendingCount >= MAX_ACTOR_INBOX) {
      return Promise.resolve(result('rejected', 'inbox-overflow', null, this.#state));
    }
    return new Promise((resolve, reject) => {
      this.#pendingCount += 1;
      this.#queue.push({ event, resolve, reject });
      if (!this.#scheduled && !this.#draining) {
        this.#scheduled = true;
        queueMicrotask(() => this.#drain());
      }
    });
  }

  #drain(): void {
    if (this.#draining) return;
    this.#scheduled = false;
    this.#draining = true;
    const batch = this.#queue.splice(0, this.#queue.length);
    try {
      for (const pending of batch) {
        let reduced: FilePlaybackRoomReduceResult;
        try {
          reduced = reduceFilePlaybackActorInput(this.#state, pending.event);
        } catch (error) {
          this.#pendingCount -= 1;
          pending.reject(error);
          try {
            this.#onObserverError?.(error);
          } catch {
            // Observability must not become another mutation or teardown owner.
          }
          continue;
        }
        this.#state = reduced.state;
        this.#pendingCount -= 1;
        pending.resolve(reduced);
        try {
          this.#onResult?.(reduced);
        } catch (error) {
          try {
            this.#onObserverError?.(error);
          } catch {
            // Observability must not become another mutation or teardown owner.
          }
        }
      }
    } finally {
      this.#draining = false;
      if (this.#queue.length > 0 && !this.#scheduled) {
        this.#scheduled = true;
        queueMicrotask(() => this.#drain());
      }
    }
  }
}

import type {
  FilePlaybackApplicationLifecycleEvent,
  FilePlaybackApplicationSessionRole,
  FilePlaybackAuxiliaryAdoptionEvent,
} from '../network/file-playback-application-session.ts';
import { FilePlaybackConnectionChannel } from '../network/file-playback-connection-channel.ts';
import {
  FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
  createSecureFilePlaybackHandshakeId,
  isFilePlaybackSessionId,
  type FilePlaybackSessionBindingV2,
} from '../network/file-playback-session-handshake.ts';
import {
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
} from '../network/file-playback-transport-contract.ts';
import type { DataConnection } from '../types/index.ts';
import {
  createFilePlaybackProductBaselineV2,
  createFilePlaybackProductReadyV2,
  parseFilePlaybackProductBaselineV2,
  parseFilePlaybackProductReadyV2,
  type FilePlaybackProductBaselineV2,
  type FilePlaybackProductReadyV2,
} from './file-playback-product-baseline.ts';
import {
  createPlaybackRunIdentity,
  type PlaybackRevisionWatermark,
  type PlaybackRunIdentity,
} from './playback-identity.ts';
import {
  derivePlaybackPosition,
  isPlaybackTimelineSnapshot,
  type PlaybackTimelineSnapshot,
} from './playback-timeline.ts';
import { isFilePlaybackSemanticCohortId } from './file-playback-semantic-cohort.ts';

const BASELINE_ID_ISSUER_OPTION_KEYS = Object.freeze(['createBaselineId'] as const);
const MAX_ACTIVE_PRODUCT_BASELINE_SESSIONS = 64;
const MAX_RECENT_BASELINE_IDS = 4_096;
const SESSION_OPTION_KEYS = Object.freeze([
  'getTimelineSnapshot',
  'idIssuer',
  'onReady',
  'sendRequired',
] as const);
const LIFECYCLE_EVENT_KEYS = Object.freeze(['channel', 'connection', 'kind', 'role'] as const);
const AUXILIARY_EVENT_KEYS = Object.freeze([
  'channel',
  'connection',
  'connectionToken',
  'frame',
] as const);
const SESSION_BINDING_KEYS = Object.freeze([
  'connectionId',
  'guestParticipantId',
  'helloId',
  'hostParticipantId',
  'semanticPlaybackCohortId',
  'sessionId',
  'version',
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

export interface FilePlaybackProductBaselineIdIssuerOptions {
  /** Test/platform override. Production factories must remain CSPRNG-backed. */
  readonly createBaselineId?: () => string;
}

export interface FilePlaybackProductBaselineSessionOptions {
  readonly idIssuer: FilePlaybackProductBaselineIdIssuer;
  readonly getTimelineSnapshot: () => PlaybackTimelineSnapshot;
  readonly sendRequired: (connection: DataConnection, frame: unknown) => boolean;
  readonly onReady?: (snapshot: FilePlaybackProductBaselineSessionSnapshot) => void;
}

export type FilePlaybackProductBaselineSessionStatus =
  | 'awaiting-baseline'
  | 'awaiting-clock'
  | 'awaiting-ready'
  | 'ready';

export interface FilePlaybackProductBaselineSessionSnapshot {
  readonly schemaVersion: 1;
  readonly role: FilePlaybackApplicationSessionRole;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly hostParticipantId: string;
  readonly guestParticipantId: string;
  readonly status: FilePlaybackProductBaselineSessionStatus;
  readonly clockReady: boolean;
  readonly playbackRevision: PlaybackRevisionWatermark | null;
  readonly baselineId: string | null;
  readonly baseline: Readonly<FilePlaybackProductBaselineV2> | null;
  readonly ready: Readonly<FilePlaybackProductReadyV2> | null;
}

interface SessionScope {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly hostParticipantId: string;
  readonly guestParticipantId: string;
}

interface SessionRecord {
  readonly role: FilePlaybackApplicationSessionRole;
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel;
  readonly connectionToken: object;
  readonly scope: Readonly<SessionScope>;
  status: FilePlaybackProductBaselineSessionStatus;
  clockReady: boolean;
  baseline: Readonly<FilePlaybackProductBaselineV2> | null;
  ready: Readonly<FilePlaybackProductReadyV2> | null;
}

interface MutationAuthority {
  reentered: boolean;
}

interface LifecycleEventSnapshot {
  readonly kind: FilePlaybackApplicationLifecycleEvent['kind'];
  readonly role: FilePlaybackApplicationSessionRole;
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel | null;
}

interface AuxiliaryEventSnapshot {
  readonly frame: unknown;
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel;
  readonly connectionToken: object;
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function isObjectIdentity(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
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

function snapshotAllowedOptions(
  value: unknown,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set(allowedKeys);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
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

function readLifecycleEvent(value: unknown): Readonly<LifecycleEventSnapshot> | null {
  const snapshot = snapshotExactRecord(value, LIFECYCLE_EVENT_KEYS);
  if (
    !snapshot ||
    (snapshot.kind !== 'established' &&
      snapshot.kind !== 'clock-ready' &&
      snapshot.kind !== 'clock-degraded' &&
      snapshot.kind !== 'revoked') ||
    (snapshot.role !== 'host' && snapshot.role !== 'guest') ||
    !isObjectIdentity(snapshot.connection) ||
    (snapshot.channel !== null && !(snapshot.channel instanceof FilePlaybackConnectionChannel))
  ) {
    return null;
  }
  return freezeCanonical({
    kind: snapshot.kind,
    role: snapshot.role,
    connection: snapshot.connection as DataConnection,
    channel: snapshot.channel as FilePlaybackConnectionChannel | null,
  });
}

function readAuxiliaryEvent(value: unknown): Readonly<AuxiliaryEventSnapshot> | null {
  const snapshot = snapshotExactRecord(value, AUXILIARY_EVENT_KEYS);
  if (
    !snapshot ||
    !isObjectIdentity(snapshot.connection) ||
    !(snapshot.channel instanceof FilePlaybackConnectionChannel) ||
    snapshot.connectionToken === null ||
    typeof snapshot.connectionToken !== 'object'
  ) {
    return null;
  }
  return freezeCanonical({
    frame: snapshot.frame,
    connection: snapshot.connection as DataConnection,
    channel: snapshot.channel,
    connectionToken: snapshot.connectionToken,
  });
}

function readFrameType(value: unknown): string | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
      ? typeof descriptor.value === 'string'
        ? descriptor.value
        : null
      : null;
  } catch {
    return null;
  }
}

function readSessionScope(
  value: Readonly<FilePlaybackSessionBindingV2> | null,
): Readonly<SessionScope> | null {
  const snapshot = snapshotExactRecord(value, SESSION_BINDING_KEYS);
  if (
    !snapshot ||
    snapshot.version !== FILE_PLAYBACK_SESSION_PROTOCOL_VERSION ||
    !isFilePlaybackSemanticCohortId(snapshot.semanticPlaybackCohortId) ||
    !isFilePlaybackSessionId(snapshot.sessionId) ||
    !isFilePlaybackSessionId(snapshot.connectionId) ||
    !isFilePlaybackSessionId(snapshot.helloId) ||
    !isFilePlaybackSessionId(snapshot.hostParticipantId) ||
    !isFilePlaybackSessionId(snapshot.guestParticipantId) ||
    new Set([
      snapshot.sessionId,
      snapshot.connectionId,
      snapshot.helloId,
      snapshot.hostParticipantId,
      snapshot.guestParticipantId,
    ]).size !== 5
  ) {
    return null;
  }
  return freezeCanonical({
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    hostParticipantId: snapshot.hostParticipantId,
    guestParticipantId: snapshot.guestParticipantId,
  });
}

function readTimelineSnapshot(value: unknown): PlaybackTimelineSnapshot | null {
  const snapshot = snapshotExactRecord(value, TIMELINE_KEYS);
  if (!snapshot) return null;
  let run: Readonly<PlaybackRunIdentity> | null = null;
  if (snapshot.run !== null) {
    try {
      run = createPlaybackRunIdentity(snapshot.run as PlaybackRunIdentity);
    } catch {
      return null;
    }
  }
  const canonical = freezeCanonical({
    schemaVersion: snapshot.schemaVersion,
    revision: snapshot.revision,
    phase: snapshot.phase,
    run,
    positionSeconds: snapshot.positionSeconds,
    anchorMonotonicMs: snapshot.anchorMonotonicMs,
    rate: snapshot.rate,
  });
  return isPlaybackTimelineSnapshot(canonical) ? canonical : null;
}

function sameBaseline(
  left: Readonly<FilePlaybackProductBaselineV2>,
  right: Readonly<FilePlaybackProductBaselineV2>,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.type === right.type &&
    left.sessionId === right.sessionId &&
    left.connectionId === right.connectionId &&
    left.baselineId === right.baselineId &&
    left.hostParticipantId === right.hostParticipantId &&
    left.guestParticipantId === right.guestParticipantId &&
    left.playbackRevision === right.playbackRevision &&
    left.phase === right.phase &&
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.positionSeconds === right.positionSeconds &&
    left.rate === right.rate &&
    left.anchorRoomTimeMs === right.anchorRoomTimeMs
  );
}

function sameReady(
  left: Readonly<FilePlaybackProductReadyV2>,
  right: Readonly<FilePlaybackProductReadyV2>,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.type === right.type &&
    left.sessionId === right.sessionId &&
    left.connectionId === right.connectionId &&
    left.baselineId === right.baselineId &&
    left.guestParticipantId === right.guestParticipantId &&
    left.playbackRevision === right.playbackRevision &&
    left.observedAtRoomTimeMs === right.observedAtRoomTimeMs
  );
}

function baselineMatchesEqualTimeline(
  baseline: Readonly<FilePlaybackProductBaselineV2>,
  timeline: PlaybackTimelineSnapshot,
): boolean {
  if (baseline.playbackRevision !== timeline.revision || baseline.phase !== timeline.phase) {
    return false;
  }
  if (timeline.phase === 'stopped') return baseline.phase === 'stopped';
  if (
    baseline.queueItemId !== timeline.run?.queueItemId ||
    baseline.runId !== timeline.run?.runId ||
    baseline.rate !== timeline.rate
  ) {
    return false;
  }
  if (timeline.phase === 'paused') {
    return baseline.positionSeconds === timeline.positionSeconds;
  }

  // Equal revisions are immutable timeline states. A later baseline may use a
  // newer anchor while describing that same playing trajectory, but it must
  // not smuggle a rewind/fast-forward under an unchanged revision. Product
  // timelines use the authoritative room clock, so project the local state to
  // the baseline's room anchor and compare at that common instant.
  try {
    const expectedPosition = derivePlaybackPosition(timeline, baseline.anchorRoomTimeMs);
    return Math.abs(expectedPosition - baseline.positionSeconds) <= 1e-6;
  } catch {
    return false;
  }
}

function baselineCanAdvanceTimeline(
  baseline: Readonly<FilePlaybackProductBaselineV2>,
  timeline: PlaybackTimelineSnapshot,
): boolean {
  return (
    baseline.playbackRevision > timeline.revision ||
    (baseline.playbackRevision === timeline.revision &&
      baselineMatchesEqualTimeline(baseline, timeline))
  );
}

/** CSPRNG ID authority with a bounded recent-collision window. */
export class FilePlaybackProductBaselineIdIssuer {
  readonly #createBaselineId: () => string;
  readonly #recentIds = new Set<string>();
  #issuing = false;
  #reentered = false;

  constructor(options: FilePlaybackProductBaselineIdIssuerOptions = {}) {
    const snapshot = snapshotAllowedOptions(options, BASELINE_ID_ISSUER_OPTION_KEYS);
    if (
      !snapshot ||
      (snapshot.createBaselineId !== undefined && typeof snapshot.createBaselineId !== 'function')
    ) {
      throw new TypeError('File playback product baseline ID issuer options are invalid');
    }
    this.#createBaselineId =
      (snapshot.createBaselineId as (() => string) | undefined) ??
      (() => createSecureFilePlaybackHandshakeId());
  }

  issueBaselineId(): string {
    if (this.#issuing) {
      this.#reentered = true;
      throw new Error('Product baseline ID factory re-entry is not allowed');
    }
    this.#issuing = true;
    this.#reentered = false;
    try {
      const baselineId = this.#createBaselineId();
      if (this.#reentered) {
        throw new Error('Product baseline ID factory re-entry is not allowed');
      }
      if (!isFilePlaybackSessionId(baselineId)) {
        throw new TypeError('Product baseline ID factory returned an invalid ID');
      }
      if (this.#recentIds.has(baselineId)) {
        throw new Error('Product baseline ID must not be reused');
      }
      if (this.#recentIds.size >= MAX_RECENT_BASELINE_IDS) {
        const oldest = this.#recentIds.values().next().value as string | undefined;
        if (oldest !== undefined) this.#recentIds.delete(oldest);
      }
      this.#recentIds.add(baselineId);
      return baselineId;
    } finally {
      this.#issuing = false;
      this.#reentered = false;
    }
  }
}

/**
 * Per-DataConnection one-shot product-baseline/READY authority.
 *
 * This class deliberately owns no media source. It only binds one immutable
 * timeline baseline and its READY echo to an exact APPLIED channel epoch.
 */
export class FilePlaybackProductBaselineSession {
  readonly #idIssuer: FilePlaybackProductBaselineIdIssuer;
  readonly #getTimelineSnapshot: () => PlaybackTimelineSnapshot;
  readonly #sendRequired: (connection: DataConnection, frame: unknown) => boolean;
  readonly #onReady: ((snapshot: FilePlaybackProductBaselineSessionSnapshot) => void) | null;
  readonly #records = new Map<DataConnection, SessionRecord>();
  #activeMutation: MutationAuthority | null = null;

  constructor(options: FilePlaybackProductBaselineSessionOptions) {
    const snapshot = snapshotAllowedOptions(options, SESSION_OPTION_KEYS);
    if (
      !snapshot ||
      !(snapshot.idIssuer instanceof FilePlaybackProductBaselineIdIssuer) ||
      typeof snapshot.getTimelineSnapshot !== 'function' ||
      typeof snapshot.sendRequired !== 'function' ||
      (snapshot.onReady !== undefined && typeof snapshot.onReady !== 'function')
    ) {
      throw new TypeError('File playback product baseline session options are invalid');
    }
    this.#idIssuer = snapshot.idIssuer;
    this.#getTimelineSnapshot = snapshot.getTimelineSnapshot as () => PlaybackTimelineSnapshot;
    this.#sendRequired = snapshot.sendRequired as (
      connection: DataConnection,
      frame: unknown,
    ) => boolean;
    this.#onReady =
      (snapshot.onReady as
        | ((snapshot: FilePlaybackProductBaselineSessionSnapshot) => void)
        | undefined) ?? null;
  }

  handleLifecycle(
    value: FilePlaybackApplicationLifecycleEvent,
  ): FilePlaybackProductBaselineSessionSnapshot | null {
    if (this.#activeMutation !== null) {
      this.#activeMutation.reentered = true;
      const event = readLifecycleEvent(value);
      if (event?.kind === 'revoked') return this.#revoke(event);
      throw new Error('Product baseline session lifecycle re-entry is not allowed');
    }
    return this.#mutate((authority) => {
      const event = readLifecycleEvent(value);
      if (!event) throw new TypeError('Product baseline lifecycle event is invalid');
      if (event.kind === 'revoked') return this.#revoke(event);
      if (event.channel === null)
        throw new TypeError('Product baseline lifecycle channel is missing');
      const liveEvent = freezeCanonical({ ...event, channel: event.channel });
      if (event.kind === 'established') return this.#establish(liveEvent, authority);
      return this.#handleClockLifecycle(liveEvent, authority);
    });
  }

  adoptAuxiliary(value: FilePlaybackAuxiliaryAdoptionEvent): boolean {
    return this.#mutate((authority) => {
      const event = readAuxiliaryEvent(value);
      if (!event) throw new TypeError('Product baseline auxiliary event is invalid');
      const type = readFrameType(event.frame);
      if (type === null) throw new TypeError('Product baseline auxiliary frame is malformed');
      if (
        type !== FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE &&
        type !== FILE_PLAYBACK_PRODUCT_READY_V2_TYPE
      ) {
        return false;
      }
      const record = this.#requireEventRecord(event, authority);
      try {
        if (type === FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE) {
          return this.#acceptGuestBaseline(record, event.frame, authority);
        }
        return this.#acceptHostReady(record, event.frame, authority);
      } catch (error) {
        this.#deleteRecord(record);
        throw error;
      }
    });
  }

  snapshot(connection: DataConnection): FilePlaybackProductBaselineSessionSnapshot | null {
    const record = this.#records.get(connection);
    return record ? this.#snapshotRecord(record) : null;
  }

  #establish(
    event: Readonly<LifecycleEventSnapshot> & { readonly channel: FilePlaybackConnectionChannel },
    authority: MutationAuthority,
  ): FilePlaybackProductBaselineSessionSnapshot {
    const channelAuthority = this.#readChannelAuthority(event.channel, event.connection);
    if (channelAuthority.role !== event.role) {
      throw new Error('Product baseline lifecycle role does not match its channel');
    }
    const existing = this.#records.get(event.connection);
    if (existing) {
      if (
        existing.channel === event.channel &&
        existing.connectionToken === channelAuthority.connectionToken &&
        existing.role === event.role
      ) {
        this.#assertRecordLive(existing, authority);
        return this.#snapshotRecord(existing);
      }
      this.#deleteRecord(existing);
      throw new Error('Product baseline connection already belongs to another channel epoch');
    }
    if (this.#records.size >= MAX_ACTIVE_PRODUCT_BASELINE_SESSIONS) {
      throw new Error('Product baseline session capacity was exhausted');
    }

    if (event.role === 'guest') {
      const record: SessionRecord = {
        role: 'guest',
        connection: event.connection,
        channel: event.channel,
        connectionToken: channelAuthority.connectionToken,
        scope: channelAuthority.scope,
        status: 'awaiting-baseline',
        clockReady: false,
        baseline: null,
        ready: null,
      };
      this.#records.set(event.connection, record);
      try {
        this.#assertRecordLive(record, authority);
        return this.#snapshotRecord(record);
      } catch (error) {
        this.#deleteRecord(record);
        throw error;
      }
    }

    const timeline = this.#readCurrentTimeline(authority);
    const anchorRoomTimeMs = this.#readRoomTime(event.channel, authority);
    const positionSeconds = derivePlaybackPosition(timeline, anchorRoomTimeMs);
    this.#assertMutation(authority);
    const baselineId = this.#idIssuer.issueBaselineId();
    this.#assertMutation(authority);
    const baseline = createFilePlaybackProductBaselineV2({
      ...channelAuthority.scope,
      baselineId,
      playbackRevision: timeline.revision,
      phase: timeline.phase,
      queueItemId: timeline.run?.queueItemId ?? null,
      runId: timeline.run?.runId ?? null,
      positionSeconds,
      rate: timeline.rate,
      anchorRoomTimeMs,
    });
    const record: SessionRecord = {
      role: 'host',
      connection: event.connection,
      channel: event.channel,
      connectionToken: channelAuthority.connectionToken,
      scope: channelAuthority.scope,
      status: 'awaiting-ready',
      clockReady: false,
      baseline,
      ready: null,
    };
    this.#records.set(event.connection, record);
    try {
      if (!this.#sendRequiredFrame(record, baseline, authority)) {
        throw new Error('Required product baseline send failed');
      }
      return this.#snapshotRecord(record);
    } catch (error) {
      this.#deleteRecord(record);
      throw error;
    }
  }

  #handleClockLifecycle(
    event: Readonly<LifecycleEventSnapshot> & { readonly channel: FilePlaybackConnectionChannel },
    authority: MutationAuthority,
  ): FilePlaybackProductBaselineSessionSnapshot {
    const record = this.#requireLifecycleRecord(event, authority);
    try {
      if (event.kind === 'clock-degraded') {
        if (record.role !== 'guest') {
          throw new Error('Host product baseline clock cannot become degraded');
        }
        record.clockReady = false;
        return this.#snapshotRecord(record);
      }
      record.clockReady = true;
      if (record.role === 'guest' && record.ready === null && record.baseline !== null) {
        this.#sendGuestReady(record, authority);
      }
      return this.#snapshotRecord(record);
    } catch (error) {
      this.#deleteRecord(record);
      throw error;
    }
  }

  #acceptGuestBaseline(record: SessionRecord, value: unknown, authority: MutationAuthority): true {
    if (record.role !== 'guest') throw new Error('Host cannot receive a product baseline');
    const baseline = parseFilePlaybackProductBaselineV2(value);
    if (!baseline) throw new TypeError('Product baseline frame is invalid');
    if (record.baseline !== null) {
      if (sameBaseline(record.baseline, baseline)) return true;
      throw new Error('Product baseline conflicts with the accepted baseline');
    }
    if (
      baseline.sessionId !== record.scope.sessionId ||
      baseline.connectionId !== record.scope.connectionId ||
      baseline.hostParticipantId !== record.scope.hostParticipantId ||
      baseline.guestParticipantId !== record.scope.guestParticipantId
    ) {
      throw new Error('Product baseline scope does not match the channel');
    }
    const timeline = this.#readCurrentTimeline(authority);
    if (!baselineCanAdvanceTimeline(baseline, timeline)) {
      throw new Error(
        baseline.playbackRevision < timeline.revision
          ? 'Product baseline revision must not roll playback back'
          : 'Product baseline conflicts with the equal local playback revision',
      );
    }
    record.baseline = baseline;
    record.status = 'awaiting-clock';
    this.#assertRecordLive(record, authority);
    if (record.clockReady) this.#sendGuestReady(record, authority);
    return true;
  }

  #acceptHostReady(record: SessionRecord, value: unknown, authority: MutationAuthority): true {
    if (record.role !== 'host') throw new Error('Guest cannot receive a product READY frame');
    const ready = parseFilePlaybackProductReadyV2(value);
    if (!ready) throw new TypeError('Product READY frame is invalid');
    if (record.ready !== null) {
      if (sameReady(record.ready, ready)) return true;
      throw new Error('Product READY conflicts with the accepted READY frame');
    }
    const baseline = record.baseline;
    if (
      !baseline ||
      ready.sessionId !== record.scope.sessionId ||
      ready.connectionId !== record.scope.connectionId ||
      ready.guestParticipantId !== record.scope.guestParticipantId ||
      ready.baselineId !== baseline.baselineId ||
      ready.playbackRevision !== baseline.playbackRevision
    ) {
      throw new Error('Product READY does not match the outstanding baseline');
    }
    record.ready = ready;
    record.status = 'ready';
    this.#assertRecordLive(record, authority);
    this.#notifyReady(record, authority);
    return true;
  }

  #notifyReady(record: SessionRecord, authority: MutationAuthority): void {
    if (!this.#onReady) return;
    this.#onReady(this.#snapshotRecord(record));
    this.#assertRecordLive(record, authority);
  }

  #sendGuestReady(record: SessionRecord, authority: MutationAuthority): void {
    const baseline = record.baseline;
    if (record.role !== 'guest' || !record.clockReady || !baseline || record.ready !== null) {
      throw new Error('Product READY cannot be sent from the current guest state');
    }
    const timeline = this.#readCurrentTimeline(authority);
    if (!baselineCanAdvanceTimeline(baseline, timeline)) {
      throw new Error('Product baseline became stale before READY');
    }
    const observedAtRoomTimeMs = this.#readRoomTime(record.channel, authority);
    const ready = createFilePlaybackProductReadyV2({
      sessionId: record.scope.sessionId,
      connectionId: record.scope.connectionId,
      baselineId: baseline.baselineId,
      guestParticipantId: record.scope.guestParticipantId,
      playbackRevision: baseline.playbackRevision,
      observedAtRoomTimeMs,
    });
    if (!this.#sendRequiredFrame(record, ready, authority)) {
      throw new Error('Required product READY send failed');
    }
    record.ready = ready;
    record.status = 'ready';
    this.#notifyReady(record, authority);
  }

  #readCurrentTimeline(authority: MutationAuthority): PlaybackTimelineSnapshot {
    const value = this.#getTimelineSnapshot();
    this.#assertMutation(authority);
    const timeline = readTimelineSnapshot(value);
    if (!timeline) throw new TypeError('Current playback timeline snapshot is invalid');
    return timeline;
  }

  #readRoomTime(channel: FilePlaybackConnectionChannel, authority: MutationAuthority): number {
    const roomTimeMs = FilePlaybackConnectionChannel.prototype.nowRoomTimeMs.call(channel);
    this.#assertMutation(authority);
    if (!Number.isFinite(roomTimeMs) || roomTimeMs < 0) {
      throw new RangeError('Product baseline room time is invalid');
    }
    return roomTimeMs;
  }

  #sendRequiredFrame(record: SessionRecord, frame: unknown, authority: MutationAuthority): boolean {
    const sent = this.#sendRequired(record.connection, frame) === true;
    this.#assertRecordLive(record, authority);
    return sent;
  }

  #readChannelAuthority(
    channel: FilePlaybackConnectionChannel,
    connection: DataConnection,
  ): Readonly<{
    role: FilePlaybackApplicationSessionRole;
    connectionToken: object;
    scope: Readonly<SessionScope>;
  }> {
    try {
      const role = FilePlaybackConnectionChannel.prototype.role.call(channel);
      const binding = FilePlaybackConnectionChannel.prototype.establishedBinding.call(channel);
      const connectionToken =
        FilePlaybackConnectionChannel.prototype.liveConnectionToken.call(channel);
      const closed = FilePlaybackConnectionChannel.prototype.isClosed.call(channel);
      const scope = readSessionScope(binding);
      if (
        (role !== 'host' && role !== 'guest') ||
        closed ||
        connectionToken === null ||
        connectionToken !== connection ||
        !scope
      ) {
        throw new Error('Product baseline channel authority is not live');
      }
      return freezeCanonical({ role, connectionToken, scope });
    } catch (error) {
      if (error instanceof Error && /Product baseline/u.test(error.message)) throw error;
      throw new Error('Product baseline channel authority is invalid', { cause: error });
    }
  }

  #requireLifecycleRecord(
    event: Readonly<LifecycleEventSnapshot> & { readonly channel: FilePlaybackConnectionChannel },
    authority: MutationAuthority,
  ): SessionRecord {
    const record = this.#records.get(event.connection);
    if (!record || record.role !== event.role || record.channel !== event.channel) {
      throw new Error('Product baseline lifecycle event has no matching session');
    }
    this.#assertRecordLive(record, authority);
    return record;
  }

  #requireEventRecord(
    event: Readonly<AuxiliaryEventSnapshot>,
    authority: MutationAuthority,
  ): SessionRecord {
    const record = this.#records.get(event.connection);
    if (
      !record ||
      record.channel !== event.channel ||
      record.connectionToken !== event.connectionToken
    ) {
      throw new Error('Product baseline auxiliary event has no matching session');
    }
    this.#assertRecordLive(record, authority);
    return record;
  }

  #assertRecordLive(record: SessionRecord, authority: MutationAuthority): void {
    this.#assertMutation(authority);
    if (
      this.#records.get(record.connection) !== record ||
      FilePlaybackConnectionChannel.prototype.isClosed.call(record.channel) ||
      FilePlaybackConnectionChannel.prototype.liveConnectionToken.call(record.channel) !==
        record.connectionToken
    ) {
      throw new Error('Product baseline session authority was revoked');
    }
    this.#assertMutation(authority);
  }

  #revoke(event: Readonly<LifecycleEventSnapshot>): null {
    const record = this.#records.get(event.connection);
    if (!record) return null;
    if (event.role !== record.role || event.channel !== record.channel) {
      throw new Error('Product baseline revocation does not match the live channel');
    }
    this.#deleteRecord(record);
    return null;
  }

  #deleteRecord(record: SessionRecord): void {
    if (this.#records.get(record.connection) === record) this.#records.delete(record.connection);
  }

  #snapshotRecord(record: SessionRecord): FilePlaybackProductBaselineSessionSnapshot {
    return freezeCanonical({
      schemaVersion: 1 as const,
      role: record.role,
      sessionId: record.scope.sessionId,
      connectionId: record.scope.connectionId,
      hostParticipantId: record.scope.hostParticipantId,
      guestParticipantId: record.scope.guestParticipantId,
      status: record.status,
      clockReady: record.clockReady,
      playbackRevision: record.baseline?.playbackRevision ?? null,
      baselineId: record.baseline?.baselineId ?? null,
      baseline: record.baseline,
      ready: record.ready,
    });
  }

  #mutate<T>(callback: (authority: MutationAuthority) => T): T {
    if (this.#activeMutation !== null) {
      this.#activeMutation.reentered = true;
      throw new Error('Product baseline session re-entry is not allowed');
    }
    const authority: MutationAuthority = { reentered: false };
    this.#activeMutation = authority;
    try {
      const result = callback(authority);
      this.#assertMutation(authority);
      return result;
    } finally {
      if (this.#activeMutation === authority) this.#activeMutation = null;
    }
  }

  #assertMutation(authority: MutationAuthority): void {
    if (this.#activeMutation !== authority || authority.reentered) {
      throw new Error('Product baseline session operation was superseded by re-entry');
    }
  }
}

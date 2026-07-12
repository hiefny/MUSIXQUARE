import type {
  FilePlaybackApplicationLifecycleEvent,
  FilePlaybackApplicationSessionHooks,
  FilePlaybackApplicationSessionRole,
  FilePlaybackAuxiliaryAdoptionEvent,
  FilePlaybackPeerRangeAdoptionEvent,
  FilePlaybackWireAdoptionEvent,
} from '../network/file-playback-application-session.ts';
import { FilePlaybackConnectionChannel } from '../network/file-playback-connection-channel.ts';
import type { DataConnection } from '../types/index.ts';
import {
  FilePlaybackProductBaselineIdIssuer,
  FilePlaybackProductBaselineSession,
  type FilePlaybackProductBaselineSessionSnapshot,
  type FilePlaybackProductBaselineSessionStatus,
} from './file-playback-product-baseline-session.ts';
import type { FilePlaybackProductBaselineV2 } from './file-playback-product-baseline.ts';
import { createPlaybackRunIdentity } from './playback-identity.ts';
import {
  adoptPlaybackTimelineBaseline,
  createStoppedPlaybackTimeline,
  isPlaybackTimelineSnapshot,
  type PlaybackTimelineBaselineAdoptionResult,
  type PlaybackTimelineSnapshot,
} from './playback-timeline.ts';

const MAX_ACTIVE_CONNECTIONS = 64;
const OPTION_KEYS = Object.freeze([
  'closeConnection',
  'idIssuer',
  'initialTimeline',
  'onHostReady',
  'onTimelineAdopted',
  'sendRequired',
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
const LIFECYCLE_KEYS = Object.freeze(['channel', 'connection', 'kind', 'role'] as const);
const AUXILIARY_KEYS = Object.freeze([
  'channel',
  'connection',
  'connectionToken',
  'frame',
] as const);
const WIRE_KEYS = Object.freeze([
  'attemptLease',
  'channel',
  'connection',
  'message',
  'stateLease',
] as const);
const PEER_RANGE_KEYS = Object.freeze([
  'channel',
  'connection',
  'connectionToken',
  'frame',
  'lane',
  'role',
] as const);

export interface FilePlaybackApplicationControllerOptions {
  readonly initialTimeline: PlaybackTimelineSnapshot;
  readonly idIssuer: FilePlaybackProductBaselineIdIssuer;
  readonly sendRequired: (connection: DataConnection, frame: unknown) => boolean;
  readonly closeConnection: (connection: DataConnection) => void;
  readonly onHostReady?: (snapshot: FilePlaybackApplicationControllerConnectionSnapshot) => void;
  readonly onTimelineAdopted?: (event: FilePlaybackApplicationTimelineAdoptedEvent) => void;
}

export interface FilePlaybackApplicationTimelineAdoptedEvent {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly status: Extract<PlaybackTimelineBaselineAdoptionResult, { accepted: true }>['status'];
  readonly timeline: PlaybackTimelineSnapshot;
}

export interface FilePlaybackApplicationControllerConnectionSnapshot {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly epoch: number;
  readonly role: FilePlaybackApplicationSessionRole;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly baselineStatus: FilePlaybackProductBaselineSessionStatus | 'establishing';
  readonly baselineId: string | null;
  readonly playbackRevision: number | null;
  readonly clockReady: boolean;
  readonly ready: boolean;
}

export interface FilePlaybackApplicationControllerSnapshot {
  readonly schemaVersion: 1;
  readonly roomGeneration: number;
  readonly roomRole: FilePlaybackApplicationSessionRole | null;
  readonly timeline: PlaybackTimelineSnapshot;
  readonly activeConnectionCount: number;
  readonly connections: readonly FilePlaybackApplicationControllerConnectionSnapshot[];
}

interface ControllerRecord {
  readonly role: FilePlaybackApplicationSessionRole;
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel;
  readonly connectionToken: object;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly roomGeneration: number;
  readonly abortController: AbortController;
  epoch: number;
  retired: boolean;
}

interface MutationAuthority {
  reentered: boolean;
  readonly pendingReady: PendingReadyEffect[];
}

type PendingReadyEffect =
  | Readonly<{
      kind: 'guest-timeline';
      record: ControllerRecord;
      expectedTimeline: PlaybackTimelineSnapshot;
      result: Extract<PlaybackTimelineBaselineAdoptionResult, { accepted: true }>;
    }>
  | Readonly<{
      kind: 'host-ready';
      record: ControllerRecord;
      baseline: FilePlaybackProductBaselineSessionSnapshot;
    }>;

type ReadyNotification =
  | Readonly<{
      kind: 'timeline';
      record: ControllerRecord;
      event: FilePlaybackApplicationTimelineAdoptedEvent;
    }>
  | Readonly<{
      kind: 'host';
      record: ControllerRecord;
      snapshot: FilePlaybackApplicationControllerConnectionSnapshot;
    }>;

interface LifecycleSnapshot {
  readonly kind: FilePlaybackApplicationLifecycleEvent['kind'];
  readonly role: FilePlaybackApplicationSessionRole;
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel | null;
}

interface AuxiliarySnapshot {
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

function snapshotAllowedOptions(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(OPTION_KEYS);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function canonicalTimeline(value: unknown): PlaybackTimelineSnapshot | null {
  const snapshot = snapshotExactRecord(value, TIMELINE_KEYS);
  if (!snapshot) return null;
  const run =
    snapshot.run === null
      ? null
      : (() => {
          try {
            return createPlaybackRunIdentity(snapshot.run as never);
          } catch {
            return null;
          }
        })();
  if (snapshot.run !== null && run === null) return null;
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

function readLifecycle(value: unknown): Readonly<LifecycleSnapshot> | null {
  const snapshot = snapshotExactRecord(value, LIFECYCLE_KEYS);
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

function readAuxiliary(value: unknown): Readonly<AuxiliarySnapshot> | null {
  const snapshot = snapshotExactRecord(value, AUXILIARY_KEYS);
  if (
    !snapshot ||
    !isObjectIdentity(snapshot.connection) ||
    !(snapshot.channel instanceof FilePlaybackConnectionChannel) ||
    !isObjectIdentity(snapshot.connectionToken)
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

function timelineFromBaseline(
  baseline: Readonly<FilePlaybackProductBaselineV2>,
): PlaybackTimelineSnapshot {
  if (baseline.phase === 'stopped') {
    return createStoppedPlaybackTimeline(baseline.anchorRoomTimeMs, baseline.playbackRevision);
  }
  const candidate = freezeCanonical({
    schemaVersion: 1 as const,
    revision: baseline.playbackRevision,
    phase: baseline.phase,
    run: createPlaybackRunIdentity({
      queueItemId: baseline.queueItemId!,
      runId: baseline.runId!,
    }),
    positionSeconds: baseline.positionSeconds,
    anchorMonotonicMs: baseline.anchorRoomTimeMs,
    rate: baseline.rate,
  });
  if (!isPlaybackTimelineSnapshot(candidate)) {
    throw new TypeError('Product baseline could not form a playback timeline');
  }
  return candidate;
}

/**
 * Phase-1 application controller. It owns only room timeline and connection
 * control authority; media bodies and renderer/source authority arrive in
 * later phases.
 */
export class FilePlaybackApplicationController {
  readonly #sendRequired: (connection: DataConnection, frame: unknown) => boolean;
  readonly #closeConnection: (connection: DataConnection) => void;
  readonly #onHostReady:
    | ((snapshot: FilePlaybackApplicationControllerConnectionSnapshot) => void)
    | null;
  readonly #onTimelineAdopted:
    | ((event: FilePlaybackApplicationTimelineAdoptedEvent) => void)
    | null;
  readonly #records = new Map<DataConnection, ControllerRecord>();
  readonly #epochs = new WeakMap<object, number>();
  readonly #closeSignalled = new WeakSet<object>();
  readonly #pendingCloseSignals: DataConnection[] = [];
  readonly #pendingAborts: AbortController[] = [];
  readonly #baselineSession: FilePlaybackProductBaselineSession;
  readonly #hooks: Readonly<FilePlaybackApplicationSessionHooks>;
  #timeline: PlaybackTimelineSnapshot;
  #roomGeneration = 1;
  #roomRole: FilePlaybackApplicationSessionRole | null = null;
  #activeMutation: MutationAuthority | null = null;
  #notifyingClose = false;
  #flushingEffects = false;

  constructor(options: FilePlaybackApplicationControllerOptions) {
    const snapshot = snapshotAllowedOptions(options);
    const initialTimeline = canonicalTimeline(snapshot?.initialTimeline);
    if (
      !snapshot ||
      !initialTimeline ||
      !(snapshot.idIssuer instanceof FilePlaybackProductBaselineIdIssuer) ||
      typeof snapshot.sendRequired !== 'function' ||
      typeof snapshot.closeConnection !== 'function' ||
      (snapshot.onHostReady !== undefined && typeof snapshot.onHostReady !== 'function') ||
      (snapshot.onTimelineAdopted !== undefined && typeof snapshot.onTimelineAdopted !== 'function')
    ) {
      throw new TypeError('File playback application controller options are invalid');
    }
    this.#timeline = initialTimeline;
    this.#sendRequired = snapshot.sendRequired as (
      connection: DataConnection,
      frame: unknown,
    ) => boolean;
    this.#closeConnection = snapshot.closeConnection as (connection: DataConnection) => void;
    this.#onHostReady =
      (snapshot.onHostReady as
        | ((value: FilePlaybackApplicationControllerConnectionSnapshot) => void)
        | undefined) ?? null;
    this.#onTimelineAdopted =
      (snapshot.onTimelineAdopted as
        | ((event: FilePlaybackApplicationTimelineAdoptedEvent) => void)
        | undefined) ?? null;
    this.#baselineSession = new FilePlaybackProductBaselineSession({
      idIssuer: snapshot.idIssuer,
      getTimelineSnapshot: () => this.#timeline,
      sendRequired: (connection, frame) => this.#sendRequiredFrame(connection, frame),
      onReady: (ready) => this.#handleBaselineReady(ready),
    });
    this.#hooks = freezeCanonical({
      adoptWireMessage: (event, acknowledge) => this.#adoptUnsupportedWire(event, acknowledge),
      adoptAuxiliaryMessage: (event, acknowledge) => this.#adoptAuxiliary(event, acknowledge),
      adoptPeerRangeMessage: (event, acknowledge) =>
        this.#adoptUnsupportedPeerRange(event, acknowledge),
      onLifecycleEvent: (event) => this.#handleLifecycle(event),
    });
  }

  applicationSessionHooks(): Readonly<FilePlaybackApplicationSessionHooks> {
    return this.#hooks;
  }

  timelineSnapshot(): PlaybackTimelineSnapshot {
    return this.#timeline;
  }

  connectionSignal(connection: DataConnection): AbortSignal | null {
    const record = this.#records.get(connection);
    return record && this.#isRecordLive(record) ? record.abortController.signal : null;
  }

  connectionEpoch(connection: DataConnection): number {
    return this.#epochs.get(connection) ?? 0;
  }

  connectionSnapshot(
    connection: DataConnection,
  ): FilePlaybackApplicationControllerConnectionSnapshot | null {
    const record = this.#records.get(connection);
    return record && this.#isRecordLive(record) ? this.#snapshotRecord(record) : null;
  }

  snapshot(): FilePlaybackApplicationControllerSnapshot {
    const connections = Object.freeze(
      [...this.#records.values()]
        .filter((record) => this.#isRecordLive(record))
        .map((record) => this.#snapshotRecord(record)),
    );
    return freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: this.#roomGeneration,
      roomRole: this.#roomRole,
      timeline: this.#timeline,
      activeConnectionCount: connections.length,
      connections,
    });
  }

  beginRoom(initialTimeline: PlaybackTimelineSnapshot): FilePlaybackApplicationControllerSnapshot {
    const nextTimeline = canonicalTimeline(initialTimeline);
    if (!nextTimeline) throw new TypeError('New room playback timeline is invalid');
    try {
      this.#mutate((authority) => {
        if (this.#roomGeneration >= Number.MAX_SAFE_INTEGER) {
          throw new Error('File playback room generation was exhausted');
        }
        for (const record of [...this.#records.values()]) {
          this.#revokeBaseline(record);
          this.#retireRecord(record);
          this.#signalClose(record.connection);
        }
        this.#roomGeneration += 1;
        this.#roomRole = null;
        this.#timeline = nextTimeline;
        this.#assertMutation(authority);
      });
      return this.snapshot();
    } finally {
      this.#flushDeferredEffects();
    }
  }

  #handleLifecycle(value: FilePlaybackApplicationLifecycleEvent): void {
    const event = readLifecycle(value);
    if (!event) throw new TypeError('Application controller lifecycle event is invalid');
    try {
      this.#mutate((authority) => {
        if (event.kind === 'established') this.#establish(event, authority);
        else if (event.kind === 'revoked') this.#revoke(event, authority);
        else this.#clockLifecycle(event, authority);
        const notifications = this.#commitPendingReady(authority);
        this.#publishReadyNotifications(notifications, authority);
      });
    } catch (error) {
      this.#failClosed(event.connection);
      throw error;
    } finally {
      this.#flushDeferredEffects();
    }
  }

  #establish(event: Readonly<LifecycleSnapshot>, authority: MutationAuthority): void {
    if (event.channel === null) throw new Error('Established lifecycle channel is missing');
    if (this.#records.has(event.connection)) {
      throw new Error('Application controller connection establishment is duplicate or replaced');
    }
    if (this.#epochs.has(event.connection) || this.#closeSignalled.has(event.connection)) {
      throw new Error('Application controller DataConnection authority is one-shot');
    }
    if (this.#records.size >= MAX_ACTIVE_CONNECTIONS) {
      throw new Error('Application controller connection capacity was exhausted');
    }
    const channelAuthority = this.#readChannelAuthority(event.channel, event.connection);
    if (channelAuthority.role !== event.role) {
      throw new Error('Application controller lifecycle role does not match the channel');
    }
    if (this.#roomRole !== null && this.#roomRole !== event.role) {
      throw new Error('Application controller room role cannot change within a generation');
    }
    if (
      [...this.#records.values()].some(
        (record) =>
          record.roomGeneration === this.#roomGeneration &&
          record.connectionId === channelAuthority.connectionId,
      )
    ) {
      throw new Error('Application controller channel identity is already active');
    }
    const previousEpoch = this.#epochs.get(event.connection) ?? 0;
    if (previousEpoch >= Number.MAX_SAFE_INTEGER - 1) {
      throw new Error('Application controller connection epoch was exhausted');
    }
    const epoch = previousEpoch + 1;
    if (this.#roomRole === null) this.#roomRole = event.role;
    const record: ControllerRecord = {
      role: event.role,
      connection: event.connection,
      channel: event.channel,
      connectionToken: channelAuthority.connectionToken,
      sessionId: channelAuthority.sessionId,
      connectionId: channelAuthority.connectionId,
      roomGeneration: this.#roomGeneration,
      abortController: new AbortController(),
      epoch,
      retired: false,
    };
    this.#epochs.set(event.connection, epoch);
    this.#records.set(event.connection, record);
    this.#baselineSession.handleLifecycle(event as FilePlaybackApplicationLifecycleEvent);
    this.#assertRecordLive(record, authority);
  }

  #clockLifecycle(event: Readonly<LifecycleSnapshot>, authority: MutationAuthority): void {
    if (event.channel === null) throw new Error('Clock lifecycle channel is missing');
    const record = this.#requireRecord(event.connection, event.channel, event.role, authority);
    this.#baselineSession.handleLifecycle(event as FilePlaybackApplicationLifecycleEvent);
    this.#assertRecordLive(record, authority);
  }

  #revoke(event: Readonly<LifecycleSnapshot>, authority: MutationAuthority): void {
    const record = this.#records.get(event.connection);
    if (!record) {
      this.#baselineSession.handleLifecycle(event as FilePlaybackApplicationLifecycleEvent);
      this.#assertMutation(authority);
      return;
    }
    if (event.channel !== record.channel || event.role !== record.role) {
      throw new Error('Application controller revocation does not match the live record');
    }
    this.#baselineSession.handleLifecycle(event as FilePlaybackApplicationLifecycleEvent);
    this.#assertRecordLive(record, authority);
    this.#retireRecord(record);
    this.#assertMutation(authority);
  }

  #adoptAuxiliary(value: FilePlaybackAuxiliaryAdoptionEvent, acknowledge: () => void): void {
    const event = readAuxiliary(value);
    if (!event || typeof acknowledge !== 'function') {
      throw new TypeError('Application controller auxiliary adoption is invalid');
    }
    try {
      this.#mutate((authority) => {
        const record = this.#requireRecord(
          event.connection,
          event.channel,
          null,
          authority,
          event.connectionToken,
        );
        const handled = this.#baselineSession.adoptAuxiliary(
          event as FilePlaybackAuxiliaryAdoptionEvent,
        );
        if (!handled) throw new Error('Phase-1 controller does not support this auxiliary frame');
        this.#assertRecordLive(record, authority);
        const notifications = this.#commitPendingReady(authority);
        acknowledge();
        this.#assertRecordLive(record, authority);
        this.#publishReadyNotifications(notifications, authority);
      });
    } catch (error) {
      this.#failClosed(event.connection);
      throw error;
    } finally {
      this.#flushDeferredEffects();
    }
  }

  #adoptUnsupportedWire(value: FilePlaybackWireAdoptionEvent, acknowledge: () => void): void {
    const snapshot = snapshotExactRecord(value, WIRE_KEYS);
    if (
      !snapshot ||
      typeof acknowledge !== 'function' ||
      !isObjectIdentity(snapshot.connection) ||
      !(snapshot.channel instanceof FilePlaybackConnectionChannel)
    ) {
      throw new TypeError('Application controller wire adoption is invalid');
    }
    const connection = snapshot.connection as DataConnection;
    try {
      this.#mutate((authority) => {
        this.#requireRecord(
          connection,
          snapshot.channel as FilePlaybackConnectionChannel,
          null,
          authority,
        );
        throw new Error('Phase-1 controller does not support file-playback wire traffic');
      });
    } catch (error) {
      this.#failClosed(connection);
      throw error;
    } finally {
      this.#flushDeferredEffects();
    }
  }

  #adoptUnsupportedPeerRange(
    value: FilePlaybackPeerRangeAdoptionEvent,
    acknowledge: () => void,
  ): void {
    const snapshot = snapshotExactRecord(value, PEER_RANGE_KEYS);
    if (
      !snapshot ||
      typeof acknowledge !== 'function' ||
      !isObjectIdentity(snapshot.connection) ||
      !(snapshot.channel instanceof FilePlaybackConnectionChannel) ||
      !isObjectIdentity(snapshot.connectionToken)
    ) {
      throw new TypeError('Application controller peer-range adoption is invalid');
    }
    const connection = snapshot.connection as DataConnection;
    try {
      this.#mutate((authority) => {
        this.#requireRecord(
          connection,
          snapshot.channel as FilePlaybackConnectionChannel,
          null,
          authority,
          snapshot.connectionToken as object,
        );
        throw new Error('Phase-1 controller does not support peer-range traffic');
      });
    } catch (error) {
      this.#failClosed(connection);
      throw error;
    } finally {
      this.#flushDeferredEffects();
    }
  }

  #handleBaselineReady(snapshot: FilePlaybackProductBaselineSessionSnapshot): void {
    const authority = this.#activeMutation;
    if (!authority) throw new Error('Product baseline READY escaped controller mutation authority');
    const record = [...this.#records.values()].find(
      (candidate) =>
        candidate.roomGeneration === this.#roomGeneration &&
        candidate.sessionId === snapshot.sessionId &&
        candidate.connectionId === snapshot.connectionId &&
        candidate.role === snapshot.role,
    );
    if (!record) throw new Error('Product baseline READY has no controller record');
    this.#assertRecordLive(record, authority);
    if (snapshot.role === 'guest') {
      if (!snapshot.baseline) throw new Error('Guest READY is missing its product baseline');
      const result = adoptPlaybackTimelineBaseline(
        this.#timeline,
        timelineFromBaseline(snapshot.baseline),
      );
      if (!result.accepted) {
        throw new Error(`Guest product baseline timeline was rejected: ${result.reason}`);
      }
      authority.pendingReady.push(
        freezeCanonical({
          kind: 'guest-timeline' as const,
          record,
          expectedTimeline: this.#timeline,
          result,
        }),
      );
      this.#assertRecordLive(record, authority);
      return;
    }
    authority.pendingReady.push(
      freezeCanonical({ kind: 'host-ready' as const, record, baseline: snapshot }),
    );
    this.#assertRecordLive(record, authority);
  }

  #commitPendingReady(authority: MutationAuthority): readonly ReadyNotification[] {
    this.#assertMutation(authority);
    const pending = authority.pendingReady.splice(0);
    const notifications: ReadyNotification[] = [];
    for (const effect of pending) {
      this.#assertRecordLive(effect.record, authority);
      if (effect.kind === 'guest-timeline') {
        if (this.#timeline !== effect.expectedTimeline) {
          throw new Error('Guest product baseline timeline authority changed before commit');
        }
        this.#timeline = effect.result.snapshot;
        notifications.push(
          freezeCanonical({
            kind: 'timeline' as const,
            record: effect.record,
            event: freezeCanonical({
              schemaVersion: 1 as const,
              roomGeneration: this.#roomGeneration,
              sessionId: effect.record.sessionId,
              connectionId: effect.record.connectionId,
              status: effect.result.status,
              timeline: this.#timeline,
            }),
          }),
        );
      } else {
        notifications.push(
          freezeCanonical({
            kind: 'host' as const,
            record: effect.record,
            snapshot: this.#snapshotRecord(effect.record, effect.baseline),
          }),
        );
      }
      this.#assertRecordLive(effect.record, authority);
    }
    return Object.freeze(notifications);
  }

  #publishReadyNotifications(
    notifications: readonly ReadyNotification[],
    authority: MutationAuthority,
  ): void {
    for (const notification of notifications) {
      if (notification.kind === 'timeline') this.#onTimelineAdopted?.(notification.event);
      else this.#onHostReady?.(notification.snapshot);
      this.#assertRecordLive(notification.record, authority);
    }
  }

  #sendRequiredFrame(connection: DataConnection, frame: unknown): boolean {
    const record = this.#records.get(connection);
    const authority = this.#activeMutation;
    if (!record || !authority) return false;
    this.#assertRecordLive(record, authority);
    const sent = this.#sendRequired(connection, frame) === true;
    this.#assertRecordLive(record, authority);
    return sent;
  }

  #readChannelAuthority(
    channel: FilePlaybackConnectionChannel,
    connection: DataConnection,
  ): Readonly<{
    role: FilePlaybackApplicationSessionRole;
    connectionToken: object;
    sessionId: string;
    connectionId: string;
  }> {
    const role = FilePlaybackConnectionChannel.prototype.role.call(channel);
    const binding = FilePlaybackConnectionChannel.prototype.establishedBinding.call(channel);
    const connectionToken =
      FilePlaybackConnectionChannel.prototype.liveConnectionToken.call(channel);
    const closed = FilePlaybackConnectionChannel.prototype.isClosed.call(channel);
    if (
      (role !== 'host' && role !== 'guest') ||
      closed ||
      !binding ||
      connectionToken !== connection
    ) {
      throw new Error('Application controller channel authority is not live');
    }
    return freezeCanonical({
      role,
      connectionToken,
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
    });
  }

  #requireRecord(
    connection: DataConnection,
    channel: FilePlaybackConnectionChannel,
    role: FilePlaybackApplicationSessionRole | null,
    authority: MutationAuthority,
    connectionToken?: object,
  ): ControllerRecord {
    const record = this.#records.get(connection);
    if (
      !record ||
      record.channel !== channel ||
      (role !== null && record.role !== role) ||
      (connectionToken !== undefined && record.connectionToken !== connectionToken)
    ) {
      throw new Error('Application controller event has no exact live record');
    }
    this.#assertRecordLive(record, authority);
    return record;
  }

  #isRecordLive(record: ControllerRecord): boolean {
    try {
      return (
        !record.retired &&
        record.roomGeneration === this.#roomGeneration &&
        this.#records.get(record.connection) === record &&
        this.#epochs.get(record.connection) === record.epoch &&
        !record.abortController.signal.aborted &&
        !FilePlaybackConnectionChannel.prototype.isClosed.call(record.channel) &&
        FilePlaybackConnectionChannel.prototype.liveConnectionToken.call(record.channel) ===
          record.connectionToken
      );
    } catch {
      return false;
    }
  }

  #assertRecordLive(record: ControllerRecord, authority: MutationAuthority): void {
    this.#assertMutation(authority);
    if (!this.#isRecordLive(record))
      throw new Error('Application controller authority was revoked');
    this.#assertMutation(authority);
  }

  #revokeBaseline(record: ControllerRecord): void {
    this.#baselineSession.handleLifecycle(
      freezeCanonical({
        kind: 'revoked' as const,
        role: record.role,
        connection: record.connection,
        channel: record.channel,
      }),
    );
  }

  #retireRecord(record: ControllerRecord): void {
    if (record.retired) return;
    record.retired = true;
    record.epoch += 1;
    this.#epochs.set(record.connection, record.epoch);
    if (this.#records.get(record.connection) === record) this.#records.delete(record.connection);
    this.#pendingAborts.push(record.abortController);
  }

  #failClosed(connection: DataConnection): void {
    const active = this.#activeMutation;
    if (active) active.reentered = true;
    const record = this.#records.get(connection);
    if (record) {
      try {
        this.#revokeBaseline(record);
      } catch {
        // The baseline machine may already have deleted its exact record.
      }
      this.#retireRecord(record);
    }
    this.#signalClose(connection);
  }

  #signalClose(connection: DataConnection): void {
    if (this.#closeSignalled.has(connection)) return;
    this.#closeSignalled.add(connection);
    this.#pendingCloseSignals.push(connection);
    if (this.#activeMutation !== null || this.#flushingEffects) return;
    this.#flushDeferredEffects();
  }

  #flushDeferredEffects(): void {
    if (this.#activeMutation !== null || this.#flushingEffects) return;
    this.#flushingEffects = true;
    this.#notifyingClose = true;
    try {
      for (;;) {
        const abortController = this.#pendingAborts.shift();
        if (abortController) {
          try {
            abortController.abort('file-playback-connection-revoked');
          } catch {
            // Authority is already fenced; continue with required closure.
          }
          continue;
        }
        const pending = this.#pendingCloseSignals.shift();
        if (!pending) break;
        try {
          this.#closeConnection(pending);
        } catch {
          // Controller authority is already retired; closure is best effort.
        }
      }
    } finally {
      this.#notifyingClose = false;
      this.#flushingEffects = false;
    }
  }

  #snapshotRecord(
    record: ControllerRecord,
    baseline = this.#baselineSession.snapshot(record.connection),
  ): FilePlaybackApplicationControllerConnectionSnapshot {
    return freezeCanonical({
      schemaVersion: 1 as const,
      roomGeneration: record.roomGeneration,
      epoch: record.epoch,
      role: record.role,
      sessionId: record.sessionId,
      connectionId: record.connectionId,
      baselineStatus: baseline?.status ?? ('establishing' as const),
      baselineId: baseline?.baselineId ?? null,
      playbackRevision: baseline?.playbackRevision ?? null,
      clockReady: baseline?.clockReady ?? false,
      ready: baseline?.status === 'ready',
    });
  }

  #mutate<T>(callback: (authority: MutationAuthority) => T): T {
    if (this.#flushingEffects || this.#notifyingClose) {
      throw new Error('Application controller deferred-effect re-entry is not allowed');
    }
    if (this.#activeMutation !== null) {
      this.#activeMutation.reentered = true;
      throw new Error('Application controller re-entry is not allowed');
    }
    const authority: MutationAuthority = { reentered: false, pendingReady: [] };
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
      throw new Error('Application controller operation was superseded by re-entry');
    }
  }
}

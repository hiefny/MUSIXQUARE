import type {
  FilePlaybackApplicationLifecycleEvent,
  FilePlaybackApplicationSessionHooks,
  FilePlaybackApplicationSessionRole,
  FilePlaybackAuxiliaryAdoptionEvent,
  FilePlaybackPeerRangeAdoptionEvent,
  FilePlaybackWireAdoptionEvent,
} from '../network/file-playback-application-session.ts';
import { FilePlaybackConnectionChannel } from '../network/file-playback-connection-channel.ts';
import {
  FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
  FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
} from '../network/file-playback-transport-contract.ts';
import type { DataConnection } from '../types/index.ts';

const MAX_ACTIVE_CONNECTIONS = 64;
const OPTION_KEYS = Object.freeze([
  'controller',
  'createGuestMediaOwner',
  'createHostMediaOwner',
] as const);
const CONTROLLER_PORT_KEYS = Object.freeze(['adoptAuxiliaryMessage', 'onLifecycleEvent'] as const);
const HOST_OWNER_KEYS = Object.freeze([
  'adoptPeerRangeControl',
  'adoptWireMessage',
  'revoke',
] as const);
const GUEST_OWNER_KEYS = Object.freeze([
  'adoptAuxiliaryMessage',
  'adoptPeerRangeBulk',
  'adoptWireMessage',
  'revoke',
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

type Acknowledge = () => void;
type ExactRecord = Readonly<Record<string, unknown>>;

/** Narrow adapter around the application controller's baseline/READY hooks. */
export interface FilePlaybackProductSessionRouterControllerPort {
  readonly onLifecycleEvent: (event: Readonly<FilePlaybackApplicationLifecycleEvent>) => void;
  readonly adoptAuxiliaryMessage: (
    event: Readonly<FilePlaybackAuxiliaryAdoptionEvent>,
    acknowledge: Acknowledge,
  ) => void;
}

export interface FilePlaybackProductSessionRouterConnectionContext {
  readonly schemaVersion: 1;
  readonly role: FilePlaybackApplicationSessionRole;
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel;
  readonly connectionToken: object;
  /** Router-private lifetime identity, distinct from transport/channel identity. */
  readonly routerToken: object;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly hostParticipantId: string;
  readonly guestParticipantId: string;
}

export interface FilePlaybackProductSessionRouterHostMediaOwnerPort {
  readonly adoptWireMessage: (
    event: Readonly<FilePlaybackWireAdoptionEvent>,
    acknowledge: Acknowledge,
  ) => void;
  readonly adoptPeerRangeControl: (
    event: Readonly<FilePlaybackPeerRangeAdoptionEvent>,
    acknowledge: Acknowledge,
  ) => void;
  readonly revoke: (context: Readonly<FilePlaybackProductSessionRouterConnectionContext>) => void;
}

export interface FilePlaybackProductSessionRouterGuestMediaOwnerPort {
  readonly adoptAuxiliaryMessage: (
    event: Readonly<FilePlaybackAuxiliaryAdoptionEvent>,
    acknowledge: Acknowledge,
  ) => void;
  readonly adoptWireMessage: (
    event: Readonly<FilePlaybackWireAdoptionEvent>,
    acknowledge: Acknowledge,
  ) => void;
  readonly adoptPeerRangeBulk: (
    event: Readonly<FilePlaybackPeerRangeAdoptionEvent>,
    acknowledge: Acknowledge,
  ) => void;
  readonly revoke: (context: Readonly<FilePlaybackProductSessionRouterConnectionContext>) => void;
}

export interface FilePlaybackProductSessionRouterOptions {
  readonly controller: FilePlaybackProductSessionRouterControllerPort;
  readonly createHostMediaOwner: (
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  ) => FilePlaybackProductSessionRouterHostMediaOwnerPort;
  readonly createGuestMediaOwner: (
    context: Readonly<FilePlaybackProductSessionRouterConnectionContext>,
  ) => FilePlaybackProductSessionRouterGuestMediaOwnerPort;
}

export interface FilePlaybackProductSessionRouterConnectionSnapshot {
  readonly role: FilePlaybackApplicationSessionRole;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly hostParticipantId: string;
  readonly guestParticipantId: string;
}

export interface FilePlaybackProductSessionRouterSnapshot {
  readonly schemaVersion: 1;
  readonly closed: boolean;
  readonly activeConnectionCount: number;
  readonly connections: readonly FilePlaybackProductSessionRouterConnectionSnapshot[];
}

interface HostOwnerSnapshot {
  readonly role: 'host';
  readonly adoptWireMessage: FilePlaybackProductSessionRouterHostMediaOwnerPort['adoptWireMessage'];
  readonly adoptPeerRangeControl: FilePlaybackProductSessionRouterHostMediaOwnerPort['adoptPeerRangeControl'];
  readonly revoke: FilePlaybackProductSessionRouterHostMediaOwnerPort['revoke'];
}

interface GuestOwnerSnapshot {
  readonly role: 'guest';
  readonly adoptAuxiliaryMessage: FilePlaybackProductSessionRouterGuestMediaOwnerPort['adoptAuxiliaryMessage'];
  readonly adoptWireMessage: FilePlaybackProductSessionRouterGuestMediaOwnerPort['adoptWireMessage'];
  readonly adoptPeerRangeBulk: FilePlaybackProductSessionRouterGuestMediaOwnerPort['adoptPeerRangeBulk'];
  readonly revoke: FilePlaybackProductSessionRouterGuestMediaOwnerPort['revoke'];
}

type OwnerSnapshot = HostOwnerSnapshot | GuestOwnerSnapshot;

interface ConnectionRecord {
  readonly role: FilePlaybackApplicationSessionRole;
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel;
  readonly connectionToken: object;
  readonly routerToken: object;
  readonly context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  controllerEstablished: boolean;
  owner: OwnerSnapshot | null;
  state: 'establishing' | 'active' | 'retired';
}

interface MutationAuthority {
  reentered: boolean;
}

const trustedChannelRole = FilePlaybackConnectionChannel.prototype.role;
const trustedChannelBinding = FilePlaybackConnectionChannel.prototype.establishedBinding;
const trustedChannelToken = FilePlaybackConnectionChannel.prototype.liveConnectionToken;
const trustedChannelClosed = FilePlaybackConnectionChannel.prototype.isClosed;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactRecord(value: unknown, expectedKeys: readonly string[]): ExactRecord | null {
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

function snapshotOptions(value: unknown): ExactRecord | null {
  return snapshotExactRecord(value, OPTION_KEYS);
}

function snapshotMethodPort(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, (...args: never[]) => unknown>> | null {
  const snapshot = snapshotExactRecord(value, expectedKeys);
  if (!snapshot) return null;
  const port = Object.create(null) as Record<string, (...args: never[]) => unknown>;
  for (const key of expectedKeys) {
    const method = snapshot[key];
    if (typeof method !== 'function') return null;
    port[key] = (...args: never[]) => Reflect.apply(method, value, args);
  }
  return Object.freeze(port);
}

function snapshotControllerPort(
  value: unknown,
): Readonly<FilePlaybackProductSessionRouterControllerPort> | null {
  const port = snapshotMethodPort(value, CONTROLLER_PORT_KEYS);
  return port as Readonly<FilePlaybackProductSessionRouterControllerPort> | null;
}

function snapshotHostOwner(value: unknown): Readonly<HostOwnerSnapshot> | null {
  const port = snapshotMethodPort(value, HOST_OWNER_KEYS);
  return port
    ? freezeCanonical({
        role: 'host' as const,
        adoptWireMessage:
          port.adoptWireMessage as FilePlaybackProductSessionRouterHostMediaOwnerPort['adoptWireMessage'],
        adoptPeerRangeControl:
          port.adoptPeerRangeControl as FilePlaybackProductSessionRouterHostMediaOwnerPort['adoptPeerRangeControl'],
        revoke: port.revoke as FilePlaybackProductSessionRouterHostMediaOwnerPort['revoke'],
      })
    : null;
}

function snapshotGuestOwner(value: unknown): Readonly<GuestOwnerSnapshot> | null {
  const port = snapshotMethodPort(value, GUEST_OWNER_KEYS);
  return port
    ? freezeCanonical({
        role: 'guest' as const,
        adoptAuxiliaryMessage:
          port.adoptAuxiliaryMessage as FilePlaybackProductSessionRouterGuestMediaOwnerPort['adoptAuxiliaryMessage'],
        adoptWireMessage:
          port.adoptWireMessage as FilePlaybackProductSessionRouterGuestMediaOwnerPort['adoptWireMessage'],
        adoptPeerRangeBulk:
          port.adoptPeerRangeBulk as FilePlaybackProductSessionRouterGuestMediaOwnerPort['adoptPeerRangeBulk'],
        revoke: port.revoke as FilePlaybackProductSessionRouterGuestMediaOwnerPort['revoke'],
      })
    : null;
}

function isObjectIdentity(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function auxiliaryType(frame: unknown): string | null {
  try {
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(frame, 'type');
    return descriptor?.enumerable === true &&
      Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function mergeFailure(primary: unknown, cleanup: unknown): unknown {
  if (primary === null) return cleanup;
  if (cleanup === null) return primary;
  return new AggregateError(
    [primary, cleanup],
    'Session routing and fail-closed cleanup both failed',
  );
}

/**
 * Exact connection router installed as the application-session hook set.
 * It retains no frame or media body; only bounded connection authorities and
 * their narrow owner adapters survive a synchronous adoption call.
 */
export class FilePlaybackProductSessionRouter {
  readonly #controller: Readonly<FilePlaybackProductSessionRouterControllerPort>;
  readonly #createHostMediaOwner: FilePlaybackProductSessionRouterOptions['createHostMediaOwner'];
  readonly #createGuestMediaOwner: FilePlaybackProductSessionRouterOptions['createGuestMediaOwner'];
  readonly #records = new Map<DataConnection, ConnectionRecord>();
  readonly #claimedConnections = new WeakSet<object>();
  readonly #hooks: Readonly<FilePlaybackApplicationSessionHooks>;
  #activeMutation: MutationAuthority | null = null;
  #closed = false;

  constructor(options: FilePlaybackProductSessionRouterOptions) {
    const input = snapshotOptions(options);
    const controller = snapshotControllerPort(input?.controller);
    if (
      !input ||
      !controller ||
      typeof input.createHostMediaOwner !== 'function' ||
      typeof input.createGuestMediaOwner !== 'function'
    ) {
      throw new TypeError('File playback product session router options are invalid');
    }
    this.#controller = controller;
    this.#createHostMediaOwner =
      input.createHostMediaOwner as FilePlaybackProductSessionRouterOptions['createHostMediaOwner'];
    this.#createGuestMediaOwner =
      input.createGuestMediaOwner as FilePlaybackProductSessionRouterOptions['createGuestMediaOwner'];
    this.#hooks = freezeCanonical({
      onLifecycleEvent: (event: Readonly<FilePlaybackApplicationLifecycleEvent>) =>
        this.#onLifecycleEvent(event),
      adoptAuxiliaryMessage: (
        event: Readonly<FilePlaybackAuxiliaryAdoptionEvent>,
        acknowledge: Acknowledge,
      ) => this.#adoptAuxiliaryMessage(event, acknowledge),
      adoptWireMessage: (
        event: Readonly<FilePlaybackWireAdoptionEvent>,
        acknowledge: Acknowledge,
      ) => this.#adoptWireMessage(event, acknowledge),
      adoptPeerRangeMessage: (
        event: Readonly<FilePlaybackPeerRangeAdoptionEvent>,
        acknowledge: Acknowledge,
      ) => this.#adoptPeerRangeMessage(event, acknowledge),
    });
  }

  applicationSessionHooks(): Readonly<FilePlaybackApplicationSessionHooks> {
    return this.#hooks;
  }

  snapshot(): Readonly<FilePlaybackProductSessionRouterSnapshot> {
    const connections = Object.freeze(
      [...this.#records.values()]
        .filter((record) => record.state === 'active')
        .map((record) =>
          freezeCanonical({
            role: record.role,
            sessionId: record.context.sessionId,
            connectionId: record.context.connectionId,
            hostParticipantId: record.context.hostParticipantId,
            guestParticipantId: record.context.guestParticipantId,
          }),
        ),
    );
    return freezeCanonical({
      schemaVersion: 1 as const,
      closed: this.#closed,
      activeConnectionCount: connections.length,
      connections,
    });
  }

  /** Retires every owner before its controller record, even without manager revoke events. */
  close(): void {
    if (this.#closed) return;
    if (this.#activeMutation) {
      const authority = this.#activeMutation;
      authority.reentered = true;
      this.#closed = true;
      const cleanup = this.#retireAll(authority);
      throw mergeFailure(
        new Error('File playback router close superseded an active operation'),
        cleanup,
      );
    }
    this.#mutate((authority) => {
      this.#closed = true;
      const failure = this.#retireAll(authority);
      if (failure !== null) throw failure;
    });
  }

  #onLifecycleEvent(value: Readonly<FilePlaybackApplicationLifecycleEvent>): void {
    const event = snapshotExactRecord(value, LIFECYCLE_KEYS);
    if (
      !event ||
      (event.kind !== 'established' &&
        event.kind !== 'clock-ready' &&
        event.kind !== 'clock-degraded' &&
        event.kind !== 'revoked') ||
      (event.role !== 'host' && event.role !== 'guest') ||
      !isObjectIdentity(event.connection) ||
      (event.channel !== null && !(event.channel instanceof FilePlaybackConnectionChannel))
    ) {
      throw new TypeError('File playback router lifecycle event is invalid');
    }
    const role = event.role as FilePlaybackApplicationSessionRole;
    const kind = event.kind as FilePlaybackApplicationLifecycleEvent['kind'];
    const connection = event.connection as DataConnection;
    const channel = event.channel as FilePlaybackConnectionChannel | null;
    if (this.#closed && kind === 'revoked') return;
    this.#mutate((authority) => {
      this.#assertOpen();
      if (kind === 'established') {
        if (!(channel instanceof FilePlaybackConnectionChannel)) {
          throw new TypeError('Established router lifecycle requires an exact channel');
        }
        this.#establish(role, connection, channel, authority);
        return;
      }
      const record = this.#records.get(connection);
      if (kind === 'revoked') {
        if (!record) return;
        let cause: unknown = null;
        if (record.role !== role || (channel !== null && channel !== record.channel)) {
          cause = new Error('Router revocation did not match the exact connection record');
        }
        const cleanup = this.#retireRecord(record, authority);
        if (cause !== null || cleanup !== null) throw mergeFailure(cause, cleanup);
        return;
      }
      if (!record) throw new Error('Router clock lifecycle has no exact connection record');
      try {
        this.#assertRecord(record, role, channel, undefined, authority);
        this.#controller.onLifecycleEvent(
          freezeCanonical({
            kind: kind as 'clock-ready' | 'clock-degraded',
            role: record.role,
            connection: record.connection,
            channel: record.channel,
          }),
        );
        this.#assertRecord(record, role, channel, undefined, authority);
      } catch (cause) {
        const cleanup = this.#retireRecord(record, authority);
        throw mergeFailure(cause, cleanup);
      }
    });
  }

  #establish(
    role: FilePlaybackApplicationSessionRole,
    connection: DataConnection,
    channel: FilePlaybackConnectionChannel,
    authority: MutationAuthority,
  ): void {
    this.#assertOpen();
    if (this.#records.size >= MAX_ACTIVE_CONNECTIONS) {
      throw new Error('File playback router connection capacity was exhausted');
    }
    if (this.#records.has(connection) || this.#claimedConnections.has(connection)) {
      throw new Error('File playback router connection authority is one-shot');
    }
    const context = this.#createContext(role, connection, channel);
    const record: ConnectionRecord = {
      role,
      connection,
      channel,
      connectionToken: context.connectionToken,
      routerToken: context.routerToken,
      context,
      controllerEstablished: false,
      owner: null,
      state: 'establishing',
    };
    this.#claimedConnections.add(connection);
    this.#records.set(connection, record);
    try {
      this.#controller.onLifecycleEvent(
        freezeCanonical({ kind: 'established' as const, role, connection, channel }),
      );
      record.controllerEstablished = true;
      this.#assertMutation(authority);
      const ownerValue =
        role === 'host'
          ? Reflect.apply(this.#createHostMediaOwner, undefined, [context])
          : Reflect.apply(this.#createGuestMediaOwner, undefined, [context]);
      const owner =
        role === 'host' ? snapshotHostOwner(ownerValue) : snapshotGuestOwner(ownerValue);
      if (!owner) throw new TypeError('File playback router media owner port is invalid');
      record.owner = owner;
      this.#assertMutation(authority);
      this.#assertLiveChannel(record);
      record.state = 'active';
      this.#assertMutation(authority);
    } catch (cause) {
      const cleanup = this.#retireRecord(record, authority);
      throw mergeFailure(cause, cleanup);
    }
  }

  #adoptAuxiliaryMessage(
    value: Readonly<FilePlaybackAuxiliaryAdoptionEvent>,
    acknowledge: Acknowledge,
  ): void {
    const event = snapshotExactRecord(value, AUXILIARY_KEYS);
    if (!event || typeof acknowledge !== 'function') {
      throw new TypeError('File playback router auxiliary adoption is invalid');
    }
    this.#routeAdoption(
      event.connection,
      event.channel,
      event.connectionToken,
      acknowledge,
      (record, guardedAcknowledge) => {
        const type = auxiliaryType(event.frame);
        const canonicalEvent = freezeCanonical({
          frame: event.frame as FilePlaybackAuxiliaryAdoptionEvent['frame'],
          connection: event.connection as DataConnection,
          channel: event.channel as FilePlaybackConnectionChannel,
          connectionToken: event.connectionToken as object,
        });
        if (
          (type === FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE && record.role === 'guest') ||
          (type === FILE_PLAYBACK_PRODUCT_READY_V2_TYPE && record.role === 'host')
        ) {
          this.#controller.adoptAuxiliaryMessage(canonicalEvent, guardedAcknowledge);
          return;
        }
        if (
          record.role === 'guest' &&
          record.owner.role === 'guest' &&
          (type === FILE_MEDIA_SOURCE_OFFER_V2_TYPE || type === FILE_PLAYBACK_RUN_BINDING_V2_TYPE)
        ) {
          record.owner.adoptAuxiliaryMessage(canonicalEvent, guardedAcknowledge);
          return;
        }
        throw new Error('Auxiliary frame direction is not owned by this connection role');
      },
    );
  }

  #adoptWireMessage(
    value: Readonly<FilePlaybackWireAdoptionEvent>,
    acknowledge: Acknowledge,
  ): void {
    const event = snapshotExactRecord(value, WIRE_KEYS);
    if (!event || typeof acknowledge !== 'function') {
      throw new TypeError('File playback router wire adoption is invalid');
    }
    const canonicalEvent = freezeCanonical({
      message: event.message as FilePlaybackWireAdoptionEvent['message'],
      connection: event.connection as DataConnection,
      channel: event.channel as FilePlaybackConnectionChannel,
      stateLease: event.stateLease as FilePlaybackWireAdoptionEvent['stateLease'],
      attemptLease: event.attemptLease as FilePlaybackWireAdoptionEvent['attemptLease'],
    });
    this.#routeAdoption(
      event.connection,
      event.channel,
      undefined,
      acknowledge,
      (record, guardedAcknowledge) =>
        record.owner.adoptWireMessage(canonicalEvent, guardedAcknowledge),
    );
  }

  #adoptPeerRangeMessage(
    value: Readonly<FilePlaybackPeerRangeAdoptionEvent>,
    acknowledge: Acknowledge,
  ): void {
    const event = snapshotExactRecord(value, PEER_RANGE_KEYS);
    if (
      !event ||
      typeof acknowledge !== 'function' ||
      (event.role !== 'host' && event.role !== 'guest') ||
      (event.lane !== 'control' && event.lane !== 'bulk')
    ) {
      throw new TypeError('File playback router peer-range adoption is invalid');
    }
    const canonicalEvent = freezeCanonical({
      frame: event.frame,
      lane: event.lane as 'control' | 'bulk',
      role: event.role as FilePlaybackApplicationSessionRole,
      connection: event.connection as DataConnection,
      channel: event.channel as FilePlaybackConnectionChannel,
      connectionToken: event.connectionToken as object,
    });
    this.#routeAdoption(
      event.connection,
      event.channel,
      event.connectionToken,
      acknowledge,
      (record, guardedAcknowledge) => {
        if (record.role !== event.role) {
          throw new Error('Peer-range frame role does not match the exact connection');
        }
        if (record.role === 'host' && record.owner.role === 'host' && event.lane === 'control') {
          record.owner.adoptPeerRangeControl(canonicalEvent, guardedAcknowledge);
          return;
        }
        if (record.role === 'guest' && record.owner.role === 'guest' && event.lane === 'bulk') {
          record.owner.adoptPeerRangeBulk(canonicalEvent, guardedAcknowledge);
          return;
        }
        throw new Error('Peer-range lane direction is invalid for the connection role');
      },
    );
  }

  #routeAdoption(
    connectionValue: unknown,
    channelValue: unknown,
    connectionTokenValue: unknown,
    acknowledge: Acknowledge,
    route: (record: ConnectionRecord & { owner: OwnerSnapshot }, acknowledge: Acknowledge) => void,
  ): void {
    if (
      !isObjectIdentity(connectionValue) ||
      !(channelValue instanceof FilePlaybackConnectionChannel)
    ) {
      throw new TypeError('File playback router adoption connection identity is invalid');
    }
    this.#mutate((authority) => {
      this.#assertOpen();
      const record = this.#records.get(connectionValue as DataConnection);
      if (!record) throw new Error('File playback router has no exact connection owner');
      try {
        this.#assertRecord(record, record.role, channelValue, connectionTokenValue, authority);
        if (!record.owner) throw new Error('File playback router media owner is unavailable');
        let acknowledgementCount = 0;
        let acceptingAcknowledgement = true;
        const guardedAcknowledge = () => {
          if (!acceptingAcknowledgement) return;
          acknowledgementCount += 1;
          if (acknowledgementCount !== 1) {
            throw new Error('File playback router adoption acknowledged more than once');
          }
          this.#assertRecord(record, record.role, channelValue, connectionTokenValue, authority);
          acknowledge();
          this.#assertRecord(record, record.role, channelValue, connectionTokenValue, authority);
        };
        try {
          route(record as ConnectionRecord & { owner: OwnerSnapshot }, guardedAcknowledge);
        } finally {
          acceptingAcknowledgement = false;
        }
        if (acknowledgementCount !== 1) {
          throw new Error('File playback router adoption requires one synchronous acknowledgement');
        }
        this.#assertRecord(record, record.role, channelValue, connectionTokenValue, authority);
      } catch (cause) {
        const cleanup = this.#retireRecord(record, authority);
        throw mergeFailure(cause, cleanup);
      }
    });
  }

  #createContext(
    role: FilePlaybackApplicationSessionRole,
    connection: DataConnection,
    channel: FilePlaybackConnectionChannel,
  ): Readonly<FilePlaybackProductSessionRouterConnectionContext> {
    if (Reflect.getPrototypeOf(channel) !== FilePlaybackConnectionChannel.prototype) {
      throw new TypeError('File playback router requires an exact channel instance');
    }
    const channelRole = Reflect.apply(trustedChannelRole, channel, []);
    const binding = Reflect.apply(trustedChannelBinding, channel, []);
    const connectionToken = Reflect.apply(trustedChannelToken, channel, []);
    const closed = Reflect.apply(trustedChannelClosed, channel, []);
    if (
      closed ||
      channelRole !== role ||
      !binding ||
      connectionToken !== connection ||
      !isObjectIdentity(connectionToken)
    ) {
      throw new Error('File playback router channel authority does not match the DataConnection');
    }
    return freezeCanonical({
      schemaVersion: 1 as const,
      role,
      connection,
      channel,
      connectionToken,
      routerToken: Object.freeze(Object.create(null) as object),
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      hostParticipantId: binding.hostParticipantId,
      guestParticipantId: binding.guestParticipantId,
    });
  }

  #assertRecord(
    record: ConnectionRecord,
    role: FilePlaybackApplicationSessionRole,
    channel: unknown,
    connectionToken: unknown,
    authority: MutationAuthority,
  ): void {
    this.#assertMutation(authority);
    if (
      record.state !== 'active' ||
      this.#records.get(record.connection) !== record ||
      record.role !== role ||
      channel !== record.channel ||
      (connectionToken !== undefined && connectionToken !== record.connectionToken)
    ) {
      throw new Error('File playback router connection record is stale');
    }
    this.#assertLiveChannel(record);
    this.#assertMutation(authority);
  }

  #assertLiveChannel(record: ConnectionRecord): void {
    const role = Reflect.apply(trustedChannelRole, record.channel, []);
    const binding = Reflect.apply(trustedChannelBinding, record.channel, []);
    const token = Reflect.apply(trustedChannelToken, record.channel, []);
    const closed = Reflect.apply(trustedChannelClosed, record.channel, []);
    if (
      closed ||
      role !== record.role ||
      !binding ||
      token !== record.connectionToken ||
      binding.sessionId !== record.context.sessionId ||
      binding.connectionId !== record.context.connectionId ||
      binding.hostParticipantId !== record.context.hostParticipantId ||
      binding.guestParticipantId !== record.context.guestParticipantId
    ) {
      throw new Error('File playback router channel authority is stale');
    }
  }

  #retireRecord(record: ConnectionRecord, authority: MutationAuthority): unknown {
    if (record.state !== 'retired') {
      record.state = 'retired';
      if (this.#records.get(record.connection) === record) this.#records.delete(record.connection);
    }
    const owner = record.owner;
    record.owner = null;
    let failure: unknown = null;
    if (owner) {
      try {
        owner.revoke(record.context);
      } catch (error) {
        failure = error;
      }
    }
    if (record.controllerEstablished) {
      record.controllerEstablished = false;
      try {
        this.#controller.onLifecycleEvent(
          freezeCanonical({
            kind: 'revoked' as const,
            role: record.role,
            connection: record.connection,
            channel: record.channel,
          }),
        );
      } catch (error) {
        failure = failure === null ? error : new AggregateError([failure, error]);
      }
    }
    try {
      this.#assertMutation(authority);
    } catch (error) {
      failure = failure === null ? error : new AggregateError([failure, error]);
    }
    return failure;
  }

  #retireAll(authority: MutationAuthority): unknown {
    let failure: unknown = null;
    for (const record of [...this.#records.values()]) {
      const cleanup = this.#retireRecord(record, authority);
      if (cleanup !== null) {
        failure = failure === null ? cleanup : new AggregateError([failure, cleanup]);
      }
    }
    return failure;
  }

  #mutate<T>(callback: (authority: MutationAuthority) => T): T {
    if (this.#activeMutation) {
      this.#activeMutation.reentered = true;
      throw new Error('File playback router re-entry is not allowed');
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
      throw new Error('File playback router operation was superseded by re-entry');
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('File playback product session router is closed');
  }
}

import { MSG } from '../core/constants.ts';
import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import type { DataConnection } from '../types/index.ts';
import {
  getFilePlaybackRoomClock,
  type FilePlaybackRoomClockLease,
} from '../player/file-playback-room-clock.ts';
import type {
  FilePlaybackWireMessageForKind,
  FilePlaybackWirePayloadByKind,
} from '../player/file-playback-wire-sender.ts';
import type {
  FilePlaybackWireAttemptLease,
  FilePlaybackWireLease,
  FilePlaybackWireStateLease,
} from '../player/file-playback-wire-binding.ts';
import type { FilePlaybackWireMessage } from '../player/file-playback-wire.ts';
import { PEER_RANGE_PROTOCOL } from '../player/sources/peer-range-protocol.ts';
import {
  FILE_PLAYBACK_CLOCK_PING_TYPE,
  FILE_PLAYBACK_CLOCK_PONG_TYPE,
  FilePlaybackClockExchange,
  parseFilePlaybackClockPingV2,
  parseFilePlaybackClockPongV2,
  type FilePlaybackClockExchangeRejectionReason,
} from './file-playback-clock-exchange.ts';
import { FilePlaybackConnectionChannel } from './file-playback-connection-channel.ts';
import {
  FILE_PLAYBACK_SESSION_APPLIED_TYPE,
  FILE_PLAYBACK_SESSION_HELLO_TYPE,
  FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE,
  FILE_PLAYBACK_SESSION_WELCOME_TYPE,
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHandshakeIdIssuer,
  FilePlaybackHostSessionHandshake,
  isFilePlaybackSessionId,
  parseFilePlaybackSessionMessageV2,
  type FilePlaybackHandshakeIdToken,
} from './file-playback-session-handshake.ts';
import {
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES,
  FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
  FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES,
  FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE,
  FILE_PLAYBACK_PRODUCT_READY_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_PRODUCT_READY_V2_TYPE,
  FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_RAW_FRAME_BYTES,
  FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE,
} from './file-playback-transport-contract.ts';
import { hasQueueAuthority } from './queue-authority.ts';

const INITIAL_CLOCK_SAMPLE_COUNT = 5;
const MAX_OUTSTANDING_CLOCK_PINGS = 5;
const DEFAULT_MAX_CLOCK_CALIBRATION_ATTEMPTS = 15;
const DEFAULT_APPLICATION_HANDSHAKE_DEADLINE_MS = 10_000;
const DEFAULT_CLOCK_CALIBRATION_RETRY_MS = 1_000;
const DEFAULT_CLOCK_CALIBRATION_DEADLINE_MS = 5_000;
const MAX_RETIRED_CLOCK_PING_IDS = 100;
const MAX_BOOTSTRAP_SNAPSHOT_NODES = 10_000;
const MAX_BOOTSTRAP_SNAPSHOT_DEPTH = 8;
const MAX_BOOTSTRAP_OBJECT_KEYS = 32;
const MAX_AUXILIARY_OBJECT_KEYS = 32;

const RECOVERABLE_CLOCK_SAMPLE_REJECTIONS = new Set<FilePlaybackClockExchangeRejectionReason>([
  'expired-ping',
  'exchange-too-long',
  'rtt-too-high',
  'offset-outlier',
]);

const BOOTSTRAP_FRAME_KEYS = Object.freeze([
  Object.freeze(['bootstrap', 'currentQueueItemId', 'list', 'revision', 'type']),
  Object.freeze(['_bootstrap', 'type', 'value']),
  Object.freeze(['_bootstrap', 'type', 'value']),
] as const);
const APPLICATION_OPTION_KEYS = Object.freeze([
  'applicationHandshakeDeadlineMs',
  'clockCalibrationRetryMs',
  'clockCalibrationDeadlineMs',
  'maxClockCalibrationAttempts',
  'scheduleTimeout',
  'cancelTimeout',
  'adoptWireMessage',
  'adoptAuxiliaryMessage',
  'adoptPeerRangeMessage',
  'onLifecycleEvent',
] as const);
const APPLICATION_HOOK_KEYS = Object.freeze([
  'adoptWireMessage',
  'adoptAuxiliaryMessage',
  'adoptPeerRangeMessage',
  'onLifecycleEvent',
] as const);
const HOST_APPLICATION_SESSION_AUTHORITY_KEYS = Object.freeze([
  'applicationSessionId',
  'hostParticipantId',
] as const);

const SESSION_TYPES = new Set<string>([
  FILE_PLAYBACK_SESSION_HELLO_TYPE,
  FILE_PLAYBACK_SESSION_WELCOME_TYPE,
  FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE,
  FILE_PLAYBACK_SESSION_APPLIED_TYPE,
]);
const CLOCK_TYPES = new Set<string>([FILE_PLAYBACK_CLOCK_PING_TYPE, FILE_PLAYBACK_CLOCK_PONG_TYPE]);
const AUXILIARY_RAW_FRAME_BUDGETS: ReadonlyMap<string, number> = new Map([
  [FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE, FILE_PLAYBACK_PRODUCT_BASELINE_V2_MAX_RAW_FRAME_BYTES],
  [FILE_PLAYBACK_PRODUCT_READY_V2_TYPE, FILE_PLAYBACK_PRODUCT_READY_V2_MAX_RAW_FRAME_BYTES],
  [FILE_MEDIA_SOURCE_OFFER_V2_TYPE, FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES],
  [FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE, FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES],
  [FILE_PLAYBACK_RUN_BINDING_V2_TYPE, FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES],
  [FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE, FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_RAW_FRAME_BYTES],
]);

export type FilePlaybackApplicationSessionRole = 'host' | 'guest';
export type FilePlaybackApplicationSessionPhase = 'none' | 'handshaking' | 'established';
export type FilePlaybackClockCalibrationState = 'none' | 'calibrating' | 'ready' | 'degraded';

/** Body-free identity of the exact host application-session authority. */
export interface FilePlaybackHostApplicationSessionAuthority {
  readonly applicationSessionId: string;
  readonly hostParticipantId: string;
}

type ApplicationSessionTimerHandle = unknown;

export interface FilePlaybackApplicationSessionManagerOptions {
  readonly applicationHandshakeDeadlineMs?: number;
  readonly clockCalibrationRetryMs?: number;
  readonly clockCalibrationDeadlineMs?: number;
  readonly maxClockCalibrationAttempts?: number;
  readonly scheduleTimeout?: (
    callback: () => void,
    delayMs: number,
  ) => ApplicationSessionTimerHandle;
  readonly cancelTimeout?: (handle: ApplicationSessionTimerHandle) => void;
  /** Synchronous exact-once adoption boundary for accepted canonical wire frames. */
  readonly adoptWireMessage?: (
    event: Readonly<FilePlaybackWireAdoptionEvent>,
    acknowledge: () => void,
  ) => void;
  /** Synchronous exact-once adoption boundary for bounded product control frames. */
  readonly adoptAuxiliaryMessage?: (
    event: Readonly<FilePlaybackAuxiliaryAdoptionEvent>,
    acknowledge: () => void,
  ) => void;
  /**
   * Synchronous adoption boundary for bounded peer-range control/bulk frames.
   * The sink must parse and consume `event.frame` before acknowledging; the
   * raw object is deliberately not retained or cloned by the session layer.
   */
  readonly adoptPeerRangeMessage?: (
    event: Readonly<FilePlaybackPeerRangeAdoptionEvent>,
    acknowledge: () => void,
  ) => void;
  /** Detached lifecycle seam for a later async controller integration. */
  readonly onLifecycleEvent?: (event: Readonly<FilePlaybackApplicationLifecycleEvent>) => void;
}

export interface FilePlaybackWireAdoptionEvent {
  readonly message: FilePlaybackWireMessage;
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel;
  readonly stateLease: FilePlaybackWireStateLease;
  readonly attemptLease: FilePlaybackWireAttemptLease | null;
}

export type FilePlaybackAuxiliaryPrimitive = string | number | boolean | null;

export type FilePlaybackAuxiliaryFrame = Readonly<Record<string, FilePlaybackAuxiliaryPrimitive>>;

export interface FilePlaybackAuxiliaryAdoptionEvent {
  readonly frame: FilePlaybackAuxiliaryFrame;
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel;
  readonly connectionToken: object;
}

export interface FilePlaybackPeerRangeAdoptionEvent {
  /** Untrusted transport-owned frame; consume synchronously before ACK. */
  readonly frame: unknown;
  readonly lane: 'control' | 'bulk';
  readonly role: FilePlaybackApplicationSessionRole;
  readonly connection: DataConnection;
  readonly channel: FilePlaybackConnectionChannel;
  readonly connectionToken: object;
}

export type FilePlaybackApplicationLifecycleEvent =
  | Readonly<{
      kind: 'established' | 'clock-ready' | 'clock-degraded';
      role: FilePlaybackApplicationSessionRole;
      connection: DataConnection;
      channel: FilePlaybackConnectionChannel;
    }>
  | Readonly<{
      kind: 'revoked';
      role: FilePlaybackApplicationSessionRole;
      connection: DataConnection;
      channel: FilePlaybackConnectionChannel | null;
    }>;

export interface FilePlaybackApplicationSessionHooks {
  readonly adoptWireMessage: NonNullable<
    FilePlaybackApplicationSessionManagerOptions['adoptWireMessage']
  >;
  readonly adoptAuxiliaryMessage: NonNullable<
    FilePlaybackApplicationSessionManagerOptions['adoptAuxiliaryMessage']
  >;
  readonly adoptPeerRangeMessage: NonNullable<
    FilePlaybackApplicationSessionManagerOptions['adoptPeerRangeMessage']
  >;
  readonly onLifecycleEvent: NonNullable<
    FilePlaybackApplicationSessionManagerOptions['onLifecycleEvent']
  >;
}

export interface FilePlaybackApplicationReceiveResult {
  readonly handled: boolean;
  readonly established: boolean;
  readonly clockBecameReady: boolean;
}

interface BaseConnectionRecord {
  readonly role: FilePlaybackApplicationSessionRole;
  readonly conn: DataConnection;
  clock: FilePlaybackClockExchange | null;
  channel: FilePlaybackConnectionChannel | null;
  bootstrapIndex: number;
  receiving: boolean;
  closing: boolean;
  clockReadyNotified: boolean;
  revocationPublished: boolean;
  handshakeDeadline: ApplicationSessionTimerHandle | null;
  handshakeDeadlineEpoch: number;
}

interface HostConnectionRecord extends BaseConnectionRecord {
  readonly role: 'host';
  readonly handshake: FilePlaybackHostSessionHandshake;
}

interface GuestConnectionRecord extends BaseConnectionRecord {
  readonly role: 'guest';
  readonly handshake: FilePlaybackGuestSessionHandshake;
  clockLease: FilePlaybackRoomClockLease | null;
  calibrationState: Exclude<FilePlaybackClockCalibrationState, 'none'> | 'idle';
  calibrationAttempts: number;
  calibrationEpoch: number;
  calibrationPendingPingIds: Set<number>;
  calibrationRetiredPingIds: Set<number>;
  calibrationRetryTimer: ApplicationSessionTimerHandle | null;
  calibrationDeadlineTimer: ApplicationSessionTimerHandle | null;
}

type ConnectionRecord = HostConnectionRecord | GuestConnectionRecord;

interface HostRoomAuthority {
  readonly descriptor: Readonly<FilePlaybackHostApplicationSessionAuthority>;
  readonly sessionId: FilePlaybackHandshakeIdToken<'session'>;
  readonly clockLease: ReturnType<ReturnType<typeof getFilePlaybackRoomClock>['beginHostSession']>;
}

/**
 * Detaches the two public identity fields from an untrusted adapter result.
 * Accessors, extra fields, arrays, and exotic prototypes are rejected.
 */
export function snapshotFilePlaybackHostApplicationSessionAuthority(
  value: unknown,
): Readonly<FilePlaybackHostApplicationSessionAuthority> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set<string>(HOST_APPLICATION_SESSION_AUTHORITY_KEYS);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    for (const key of HOST_APPLICATION_SESSION_AUTHORITY_KEYS) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') ||
        !isFilePlaybackSessionId(descriptor.value)
      ) {
        return null;
      }
    }
    return Object.freeze({
      applicationSessionId: descriptors.applicationSessionId?.value as string,
      hostParticipantId: descriptors.hostParticipantId?.value as string,
    });
  } catch {
    return null;
  }
}

function result(
  handled: boolean,
  established = false,
  clockBecameReady = false,
): Readonly<FilePlaybackApplicationReceiveResult> {
  return Object.freeze({ handled, established, clockBecameReady });
}

function snapshotApplicationOptions(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(APPLICATION_OPTION_KEYS);
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

function snapshotApplicationHooks(
  value: unknown,
): Readonly<FilePlaybackApplicationSessionHooks> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set<string>(APPLICATION_HOOK_KEYS);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of APPLICATION_HOOK_KEYS) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function'
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot) as Readonly<FilePlaybackApplicationSessionHooks>;
  } catch {
    return null;
  }
}

function isAuxiliaryPrimitive(value: unknown): value is FilePlaybackAuxiliaryPrimitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function snapshotAuxiliaryFrame(
  value: unknown,
  expectedType: string,
  maxRawFrameBytes: number,
): FilePlaybackAuxiliaryFrame | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length === 0 ||
      ownKeys.length > MAX_AUXILIARY_OBJECT_KEYS ||
      ownKeys.some((key) => typeof key !== 'string' || key.length > maxRawFrameBytes)
    ) {
      return null;
    }

    const snapshot = Object.create(null) as Record<string, FilePlaybackAuxiliaryPrimitive>;
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        !isAuxiliaryPrimitive(descriptor.value) ||
        (typeof descriptor.value === 'string' && descriptor.value.length > maxRawFrameBytes)
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    if (snapshot.type !== expectedType) return null;

    const serialized = JSON.stringify(snapshot);
    if (
      typeof serialized !== 'string' ||
      new TextEncoder().encode(serialized).byteLength > maxRawFrameBytes
    ) {
      return null;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function ownDataDiscriminator(value: unknown): Readonly<{
  type: string | null;
  kind: string | null;
}> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const read = (key: 'type' | 'kind'): string | null => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return null;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Application-session discriminator must be own data');
      }
      return typeof descriptor.value === 'string' ? descriptor.value : null;
    };
    return Object.freeze({ type: read('type'), kind: read('kind') });
  } catch {
    return null;
  }
}

function peerRangeLaneClaim(value: unknown): 'control' | 'bulk' | 'malformed' | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const protocol = Object.getOwnPropertyDescriptor(value, 'protocol');
    if (!protocol) return null;
    if (protocol.enumerable !== true || !Object.hasOwn(protocol, 'value')) return 'malformed';
    if (protocol.value !== PEER_RANGE_PROTOCOL) return null;
    const lane = Object.getOwnPropertyDescriptor(value, 'lane');
    if (lane?.enumerable !== true || !Object.hasOwn(lane, 'value')) return 'malformed';
    return lane.value === 'control' || lane.value === 'bulk' ? lane.value : 'malformed';
  } catch {
    return 'malformed';
  }
}

interface SnapshotBudget {
  nodes: number;
}

function snapshotPlainData(value: unknown, budget: SnapshotBudget, depth: number): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (!value || typeof value !== 'object' || depth > MAX_BOOTSTRAP_SNAPSHOT_DEPTH) return null;
  budget.nodes += 1;
  if (budget.nodes > MAX_BOOTSTRAP_SNAPSHOT_NODES) return null;

  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_BOOTSTRAP_SNAPSHOT_NODES ||
        keys.length !== lengthDescriptor.value + 1
      ) {
        return null;
      }
      const output: unknown[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          return null;
        }
        const item = snapshotPlainData(descriptor.value, budget, depth + 1);
        if (item === null && descriptor.value !== null) return null;
        output.push(item);
      }
      return Object.freeze(output);
    }

    if (keys.length > MAX_BOOTSTRAP_OBJECT_KEYS || keys.some((key) => typeof key !== 'string')) {
      return null;
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const item = snapshotPlainData(descriptor.value, budget, depth + 1);
      if (item === null && descriptor.value !== null) return null;
      output[key] = item;
    }
    return Object.freeze(output);
  } catch {
    return null;
  }
}

function snapshotExactGuestBootstrapFrame(
  value: unknown,
  expectedIndex: number,
): Readonly<Record<string, unknown>> | null {
  if (expectedIndex < 0 || expectedIndex >= BOOTSTRAP_FRAME_KEYS.length) return null;
  const snapshot = snapshotPlainData(value, { nodes: 0 }, 0);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const frame = snapshot as Readonly<Record<string, unknown>>;
  const actualKeys = Object.keys(frame).sort();
  const expectedKeys = [...BOOTSTRAP_FRAME_KEYS[expectedIndex]].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return null;
  }
  if (expectedIndex === 0) {
    return frame.type === MSG.PLAYLIST_UPDATE && frame.bootstrap === true ? frame : null;
  }
  if (expectedIndex === 1) {
    return frame.type === MSG.REPEAT_MODE && frame._bootstrap === true ? frame : null;
  }
  return frame.type === MSG.SHUFFLE_MODE && frame._bootstrap === true ? frame : null;
}

/**
 * Manager-lifetime application-session authority.
 *
 * The ID issuer intentionally survives room resets so connection/hello/session
 * tombstones are never forgotten during this document lifetime. Every record
 * is keyed by the exact DataConnection object; peer IDs are labels only.
 */
export class FilePlaybackApplicationSessionManager {
  readonly #issuer: FilePlaybackHandshakeIdIssuer;
  readonly #records = new Map<DataConnection, ConnectionRecord>();
  readonly #applicationHandshakeDeadlineMs: number;
  readonly #clockCalibrationRetryMs: number;
  readonly #clockCalibrationDeadlineMs: number;
  readonly #maxClockCalibrationAttempts: number;
  readonly #scheduleTimeout: (
    callback: () => void,
    delayMs: number,
  ) => ApplicationSessionTimerHandle;
  readonly #cancelTimeout: (handle: ApplicationSessionTimerHandle) => void;
  #adoptWireMessage: FilePlaybackApplicationSessionManagerOptions['adoptWireMessage'] | undefined;
  #adoptAuxiliaryMessage:
    | FilePlaybackApplicationSessionManagerOptions['adoptAuxiliaryMessage']
    | undefined;
  #adoptPeerRangeMessage:
    | FilePlaybackApplicationSessionManagerOptions['adoptPeerRangeMessage']
    | undefined;
  #onLifecycleEvent: FilePlaybackApplicationSessionManagerOptions['onLifecycleEvent'] | undefined;
  #hooksInstalled = false;
  #hookInstallationClosed = false;
  #hostRoom: HostRoomAuthority | null = null;

  constructor(
    issuer: FilePlaybackHandshakeIdIssuer = new FilePlaybackHandshakeIdIssuer(),
    options: FilePlaybackApplicationSessionManagerOptions = {},
  ) {
    const snapshot = snapshotApplicationOptions(options);
    if (!snapshot) throw new TypeError('Application-session manager options are invalid');
    this.#issuer = issuer;
    this.#applicationHandshakeDeadlineMs =
      (snapshot.applicationHandshakeDeadlineMs as number | undefined) ??
      DEFAULT_APPLICATION_HANDSHAKE_DEADLINE_MS;
    this.#clockCalibrationRetryMs =
      (snapshot.clockCalibrationRetryMs as number | undefined) ??
      DEFAULT_CLOCK_CALIBRATION_RETRY_MS;
    this.#clockCalibrationDeadlineMs =
      (snapshot.clockCalibrationDeadlineMs as number | undefined) ??
      DEFAULT_CLOCK_CALIBRATION_DEADLINE_MS;
    this.#maxClockCalibrationAttempts =
      (snapshot.maxClockCalibrationAttempts as number | undefined) ??
      DEFAULT_MAX_CLOCK_CALIBRATION_ATTEMPTS;
    this.#scheduleTimeout =
      (snapshot.scheduleTimeout as FilePlaybackApplicationSessionManagerOptions['scheduleTimeout']) ??
      ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.#cancelTimeout =
      (snapshot.cancelTimeout as FilePlaybackApplicationSessionManagerOptions['cancelTimeout']) ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#adoptWireMessage =
      snapshot.adoptWireMessage as FilePlaybackApplicationSessionManagerOptions['adoptWireMessage'];
    this.#adoptAuxiliaryMessage =
      snapshot.adoptAuxiliaryMessage as FilePlaybackApplicationSessionManagerOptions['adoptAuxiliaryMessage'];
    this.#adoptPeerRangeMessage =
      snapshot.adoptPeerRangeMessage as FilePlaybackApplicationSessionManagerOptions['adoptPeerRangeMessage'];
    this.#onLifecycleEvent =
      snapshot.onLifecycleEvent as FilePlaybackApplicationSessionManagerOptions['onLifecycleEvent'];
    this.#hooksInstalled =
      this.#adoptWireMessage !== undefined ||
      this.#adoptAuxiliaryMessage !== undefined ||
      this.#adoptPeerRangeMessage !== undefined ||
      this.#onLifecycleEvent !== undefined;

    for (const [value, label] of [
      [this.#applicationHandshakeDeadlineMs, 'applicationHandshakeDeadlineMs'],
      [this.#clockCalibrationRetryMs, 'clockCalibrationRetryMs'],
      [this.#clockCalibrationDeadlineMs, 'clockCalibrationDeadlineMs'],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
    }
    if (
      !Number.isSafeInteger(this.#maxClockCalibrationAttempts) ||
      this.#maxClockCalibrationAttempts < INITIAL_CLOCK_SAMPLE_COUNT ||
      this.#maxClockCalibrationAttempts > 100
    ) {
      throw new RangeError('maxClockCalibrationAttempts must be a bounded positive integer');
    }
    if (
      this.#clockCalibrationDeadlineMs < this.#clockCalibrationRetryMs ||
      typeof this.#scheduleTimeout !== 'function' ||
      typeof this.#cancelTimeout !== 'function' ||
      (this.#adoptWireMessage !== undefined && typeof this.#adoptWireMessage !== 'function') ||
      (this.#adoptAuxiliaryMessage !== undefined &&
        typeof this.#adoptAuxiliaryMessage !== 'function') ||
      (this.#adoptPeerRangeMessage !== undefined &&
        typeof this.#adoptPeerRangeMessage !== 'function') ||
      (this.#onLifecycleEvent !== undefined && typeof this.#onLifecycleEvent !== 'function')
    ) {
      throw new RangeError('Application-session timer options are invalid');
    }
  }

  installHooks(hooks: FilePlaybackApplicationSessionHooks): void {
    const snapshot = snapshotApplicationHooks(hooks);
    if (!snapshot) throw new TypeError('Application-session hooks are invalid');
    if (this.#hooksInstalled) throw new Error('Application-session hooks were already installed');
    if (this.#hookInstallationClosed || this.#hostRoom !== null || this.#records.size > 0) {
      throw new Error(
        'Application-session hooks must be installed before session authority starts',
      );
    }

    this.#adoptWireMessage = snapshot.adoptWireMessage;
    this.#adoptAuxiliaryMessage = snapshot.adoptAuxiliaryMessage;
    this.#adoptPeerRangeMessage = snapshot.adoptPeerRangeMessage;
    this.#onLifecycleEvent = snapshot.onLifecycleEvent;
    this.#hooksInstalled = true;
  }

  beginHostRoom(hostParticipantId: string): Readonly<FilePlaybackHostApplicationSessionAuthority> {
    if (!isFilePlaybackSessionId(hostParticipantId)) {
      throw new TypeError('File playback host participant ID is invalid');
    }
    this.#hookInstallationClosed = true;
    this.endRoom();
    const sessionId = this.#issuer.issueSessionId();
    const descriptor = snapshotFilePlaybackHostApplicationSessionAuthority({
      applicationSessionId: this.#issuer.resolveSessionId(sessionId),
      hostParticipantId,
    });
    if (!descriptor) {
      throw new Error('File playback host application-session authority is invalid');
    }
    const roomClock = getFilePlaybackRoomClock();
    this.#hostRoom = Object.freeze({
      descriptor,
      sessionId,
      clockLease: roomClock.beginHostSession(),
    });
    return descriptor;
  }

  beginHostConnection(conn: DataConnection, guestParticipantId: string): boolean {
    const room = this.#hostRoom;
    if (!room || this.#records.has(conn) || !conn?.open) {
      this.#closeTransport(conn);
      return false;
    }
    try {
      const handshake = new FilePlaybackHostSessionHandshake({
        idIssuer: this.#issuer,
        sessionId: room.sessionId,
        connectionId: this.#issuer.issueConnectionId(),
        hostParticipantId: room.descriptor.hostParticipantId,
        guestParticipantId,
      });
      this.#records.set(conn, {
        role: 'host',
        conn,
        handshake,
        clock: null,
        channel: null,
        bootstrapIndex: 0,
        receiving: false,
        closing: false,
        clockReadyNotified: false,
        revocationPublished: false,
        handshakeDeadline: null,
        handshakeDeadlineEpoch: 0,
      });
      const record = this.#records.get(conn);
      if (!record || !this.#armHandshakeDeadline(record)) return false;
      return true;
    } catch (error) {
      log.warn('[AppSession] Failed to begin host connection', error);
      this.#closeTransport(conn);
      return false;
    }
  }

  beginGuestConnection(conn: DataConnection, guestParticipantId: string): boolean {
    if (this.#records.has(conn) || !conn?.open) {
      this.#closeTransport(conn);
      return false;
    }
    this.#hookInstallationClosed = true;
    try {
      // A browser document can own only one guest room authority. Retire every
      // exact predecessor before issuing HELLO for its replacement.
      for (const existing of [...this.#records.values()]) {
        if (existing.role === 'guest') this.#teardown(existing, true);
      }
      const handshake = new FilePlaybackGuestSessionHandshake({
        idIssuer: this.#issuer,
        guestParticipantId,
      });
      const record: GuestConnectionRecord = {
        role: 'guest',
        conn,
        handshake,
        clock: null,
        channel: null,
        bootstrapIndex: 0,
        receiving: false,
        closing: false,
        clockReadyNotified: false,
        revocationPublished: false,
        handshakeDeadline: null,
        handshakeDeadlineEpoch: 0,
        clockLease: null,
        calibrationState: 'idle',
        calibrationAttempts: 0,
        calibrationEpoch: 0,
        calibrationPendingPingIds: new Set(),
        calibrationRetiredPingIds: new Set(),
        calibrationRetryTimer: null,
        calibrationDeadlineTimer: null,
      };
      this.#records.set(conn, record);
      if (!this.#armHandshakeDeadline(record)) return false;
      const hello = handshake.createHello();
      if (!hello.accepted) {
        this.#teardown(record, true);
        return false;
      }
      if (!this.#sendRequired(record, hello.hello)) return false;
      return true;
    } catch (error) {
      log.warn('[AppSession] Failed to begin guest connection', error);
      this.#teardown(this.#records.get(conn), true);
      return false;
    }
  }

  sendRequired(conn: DataConnection, frame: unknown): boolean {
    const record = this.#records.get(conn);
    return !!record && this.#sendRequired(record, frame);
  }

  receive(value: unknown, conn: DataConnection): Readonly<FilePlaybackApplicationReceiveResult> {
    const record = this.#records.get(conn);
    if (!record || record.conn !== conn) return result(false);
    if (record.receiving) {
      this.#teardown(record, true);
      return result(true);
    }

    record.receiving = true;
    try {
      const discriminator = ownDataDiscriminator(value);
      if (!discriminator) {
        this.#teardown(record, true);
        return result(true);
      }

      const peerRangeLane = peerRangeLaneClaim(value);
      if (peerRangeLane !== null) {
        const expectedLane = record.role === 'host' ? 'control' : 'bulk';
        if (!record.channel || peerRangeLane === 'malformed' || peerRangeLane !== expectedLane) {
          this.#teardown(record, true);
          return result(true);
        }
        return this.#receivePeerRangeMessage(record, value, peerRangeLane);
      }

      if (discriminator.type && SESSION_TYPES.has(discriminator.type)) {
        return this.#receiveSession(record, value);
      }
      if (discriminator.type && CLOCK_TYPES.has(discriminator.type)) {
        return this.#receiveClock(record, value);
      }
      if (
        record.role === 'guest' &&
        !record.channel &&
        discriminator.type &&
        (discriminator.type === MSG.PLAYLIST_UPDATE ||
          discriminator.type === MSG.REPEAT_MODE ||
          discriminator.type === MSG.SHUFFLE_MODE)
      ) {
        return this.#receiveGuestBootstrap(record, value);
      }
      if (discriminator.type !== null) {
        const auxiliaryBudget = AUXILIARY_RAW_FRAME_BUDGETS.get(discriminator.type);
        if (auxiliaryBudget !== undefined) {
          if (!record.channel) {
            this.#teardown(record, true);
            return result(true);
          }
          return this.#receiveAuxiliaryMessage(record, value, discriminator.type, auxiliaryBudget);
        }
      }
      if (discriminator.kind !== null) {
        if (!record.channel) {
          this.#teardown(record, true);
          return result(true);
        }
        return this.#receiveEstablishedChannel(record, value);
      }
      return result(false);
    } catch (error) {
      log.warn('[AppSession] Receive failed closed', error);
      this.#teardown(record, true);
      return result(true);
    } finally {
      record.receiving = false;
    }
  }

  phase(conn: DataConnection): FilePlaybackApplicationSessionPhase {
    const record = this.#records.get(conn);
    if (!record) return 'none';
    return record.channel ? 'established' : 'handshaking';
  }

  isKnownConnection(conn: DataConnection): boolean {
    return this.#records.has(conn);
  }

  establishedChannel(conn: DataConnection): FilePlaybackConnectionChannel | null {
    return this.#records.get(conn)?.channel ?? null;
  }

  clockCalibrationState(conn: DataConnection): FilePlaybackClockCalibrationState {
    const record = this.#records.get(conn);
    if (!record) return 'none';
    if (record.role === 'host') return record.channel?.clockReady() ? 'ready' : 'none';
    if (record.calibrationState === 'idle') return 'none';
    if (record.calibrationState === 'ready' && !this.#guestClockIsReady(record)) {
      return 'degraded';
    }
    return record.calibrationState;
  }

  sendWire<const Kind extends keyof FilePlaybackWirePayloadByKind>(
    conn: DataConnection,
    lease: FilePlaybackWireLease,
    payload: FilePlaybackWirePayloadByKind[Kind],
  ): FilePlaybackWireMessageForKind<Kind> | null {
    const record = this.#records.get(conn);
    if (record?.receiving) {
      this.#teardown(record, true);
      return null;
    }
    const channel = record?.channel;
    if (!record || !channel || !channel.clockReady()) return null;
    try {
      const message = channel.createWire(lease, payload);
      return this.#sendRequired(record, message) ? message : null;
    } catch (error) {
      log.warn('[AppSession] Wire send failed closed', error);
      this.#teardown(record, true);
      return null;
    }
  }

  handleWake(conn?: DataConnection): boolean {
    const records = conn
      ? ([this.#records.get(conn)].filter(Boolean) as ConnectionRecord[])
      : [...this.#records.values()];
    let handled = false;
    for (const record of records) {
      try {
        const clock = record.channel ?? record.clock;
        if (!clock) continue;
        clock.handleWake();
        record.clockReadyNotified = record.role === 'host';
        handled = true;
        if (record.role === 'guest' && !this.#beginGuestCalibration(record)) {
          if (this.#records.get(record.conn) === record) this.#markCalibrationDegraded(record);
        }
      } catch (error) {
        log.warn('[AppSession] Wake recovery failed closed', error);
        this.#teardown(record, true);
      }
    }
    return handled;
  }

  closeConnection(conn: DataConnection, closeTransport = false): void {
    const record = this.#records.get(conn);
    // A live transport may never outlive its manager/protocol authority.
    this.#teardown(record, closeTransport || record?.conn.open === true);
  }

  endRoom(): void {
    for (const record of [...this.#records.values()]) {
      // Removing a known connection from the manager while leaving its
      // transport open would also remove the protocol's pre-APPLIED gate.
      this.#teardown(record, true);
    }
    const roomClock = getFilePlaybackRoomClock();
    if (this.#hostRoom) {
      roomClock.clear(this.#hostRoom.clockLease);
      this.#hostRoom = null;
    }
  }

  #receiveSession(
    record: ConnectionRecord,
    value: unknown,
  ): Readonly<FilePlaybackApplicationReceiveResult> {
    const message = parseFilePlaybackSessionMessageV2(value);
    if (!message) {
      this.#teardown(record, true);
      return result(true);
    }

    if (record.role === 'host') {
      if (message.type === FILE_PLAYBACK_SESSION_HELLO_TYPE) {
        const welcome = record.handshake.handleHello(message);
        if (!welcome.accepted) {
          this.#teardown(record, true);
          return result(true);
        }
        if (!this.#sendRequired(record, welcome.welcome)) return result(true);
        const binding = record.handshake.provisionalBinding();
        if (!binding) {
          this.#teardown(record, true);
          return result(true);
        }
        record.clock = new FilePlaybackClockExchange({
          role: 'host',
          sessionId: binding.sessionId,
          connectionId: binding.connectionId,
        });
        if (!this.#sendHostBootstrap(record)) return result(true);
        const snapshot = record.handshake.createSnapshot();
        if (!snapshot.accepted) {
          this.#teardown(record, true);
          return result(true);
        }
        if (!this.#sendRequired(record, snapshot.snapshot)) {
          return result(true);
        }
        return result(true);
      }
      if (message.type === FILE_PLAYBACK_SESSION_APPLIED_TYPE) {
        const applied = record.handshake.handleApplied(message);
        if (!applied.accepted || !record.clock) {
          this.#teardown(record, true);
          return result(true);
        }
        return this.#establishHost(record);
      }
      this.#teardown(record, true);
      return result(true);
    }

    if (message.type === FILE_PLAYBACK_SESSION_WELCOME_TYPE) {
      const accepted = record.handshake.handleWelcome(message);
      if (!accepted.accepted) {
        this.#teardown(record, true);
        return result(true);
      }
      const binding = record.handshake.provisionalBinding();
      if (!binding) {
        this.#teardown(record, true);
        return result(true);
      }
      record.clock = new FilePlaybackClockExchange({
        role: 'guest',
        sessionId: binding.sessionId,
        connectionId: binding.connectionId,
        maxPendingPings: MAX_OUTSTANDING_CLOCK_PINGS,
      });
      if (!this.#beginGuestCalibration(record)) {
        if (this.#records.get(record.conn) === record) this.#teardown(record, true);
      }
      return result(true);
    }
    if (message.type === FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE) {
      if (record.bootstrapIndex !== 3 || !hasQueueAuthority(record.conn) || !record.clock) {
        this.#teardown(record, true);
        return result(true);
      }
      const accepted = record.handshake.acceptSnapshot(message);
      if (!accepted.accepted) {
        this.#teardown(record, true);
        return result(true);
      }
      const applied = record.handshake.createApplied();
      if (!applied.accepted) {
        this.#teardown(record, true);
        return result(true);
      }
      if (!this.#sendRequired(record, applied.applied)) return result(true);
      return this.#establishGuest(record);
    }
    this.#teardown(record, true);
    return result(true);
  }

  #receiveClock(
    record: ConnectionRecord,
    value: unknown,
  ): Readonly<FilePlaybackApplicationReceiveResult> {
    if (record.role === 'guest') return this.#receiveGuestClockPong(record, value);
    if (record.channel) return this.#receiveEstablishedChannel(record, value);
    const clock = record.clock;
    if (!clock) {
      this.#teardown(record, true);
      return result(true);
    }

    if (record.role === 'host') {
      const ping = parseFilePlaybackClockPingV2(value);
      if (!ping) {
        this.#teardown(record, true);
        return result(true);
      }
      const handled = clock.handlePing(ping);
      if (!handled.accepted || !this.#sendRequired(record, handled.pong)) return result(true);
      return result(true);
    }

    this.#teardown(record, true);
    return result(true);
  }

  #receiveGuestBootstrap(
    record: GuestConnectionRecord,
    value: unknown,
  ): Readonly<FilePlaybackApplicationReceiveResult> {
    const entryIndex = record.bootstrapIndex;
    const frame = snapshotExactGuestBootstrapFrame(value, entryIndex);
    if (
      !frame ||
      this.#records.get(record.conn) !== record ||
      record.closing ||
      record.bootstrapIndex !== entryIndex
    ) {
      this.#teardown(record, true);
      return result(true);
    }
    let acknowledgementCount = 0;
    let applied = false;
    bus.emit('network:peer-bootstrap-apply', frame, record.conn, (success) => {
      acknowledgementCount += 1;
      if (acknowledgementCount === 1) applied = success === true;
    });
    if (acknowledgementCount !== 1 || !applied || this.#records.get(record.conn) !== record) {
      this.#teardown(record, true);
      return result(true);
    }
    record.bootstrapIndex += 1;
    return result(true);
  }

  #receiveEstablishedChannel(
    record: ConnectionRecord,
    value: unknown,
  ): Readonly<FilePlaybackApplicationReceiveResult> {
    const channel = record.channel;
    if (!channel) return result(true);
    const received = channel.receive(value, record.conn);
    if (!received.accepted) {
      this.#teardown(record, true);
      return result(true);
    }
    if (received.frame === 'clock-ping') {
      if (!this.#sendRequired(record, received.pong)) return result(true);
      return result(true);
    }
    if (received.frame === 'clock-pong') {
      return result(true, false, this.#publishClockReady(record));
    }
    if (received.frame === 'wire-stale') return result(true);

    const sink = this.#adoptWireMessage;
    if (!sink) {
      this.#teardown(record, true);
      return result(true);
    }
    let acknowledgementCount = 0;
    let acceptingAcknowledgement = true;
    const acknowledge = () => {
      acknowledgementCount += 1;
      if (
        !acceptingAcknowledgement ||
        acknowledgementCount !== 1 ||
        this.#records.get(record.conn) !== record ||
        record.channel !== channel ||
        record.closing
      ) {
        this.#teardown(record, true);
      }
    };
    try {
      sink(
        Object.freeze({
          message: received.message,
          connection: record.conn,
          channel,
          stateLease: received.stateLease,
          attemptLease: received.attemptLease,
        }),
        acknowledge,
      );
    } catch (error) {
      log.warn('[AppSession] Wire adoption failed closed', error);
      this.#teardown(record, true);
      return result(true);
    } finally {
      acceptingAcknowledgement = false;
    }
    if (
      acknowledgementCount !== 1 ||
      this.#records.get(record.conn) !== record ||
      record.channel !== channel ||
      record.closing
    ) {
      this.#teardown(record, true);
    }
    return result(true);
  }

  #receiveAuxiliaryMessage(
    record: ConnectionRecord,
    value: unknown,
    expectedType: string,
    maxRawFrameBytes: number,
  ): Readonly<FilePlaybackApplicationReceiveResult> {
    const channel = record.channel;
    const connectionToken = channel?.liveConnectionToken() ?? null;
    const frame = snapshotAuxiliaryFrame(value, expectedType, maxRawFrameBytes);
    if (
      !channel ||
      connectionToken === null ||
      !frame ||
      this.#records.get(record.conn) !== record ||
      record.channel !== channel ||
      record.closing ||
      channel.liveConnectionToken() !== connectionToken
    ) {
      this.#teardown(record, true);
      return result(true);
    }

    const sink = this.#adoptAuxiliaryMessage;
    if (!sink) {
      this.#teardown(record, true);
      return result(true);
    }
    let acknowledgementCount = 0;
    let acceptingAcknowledgement = true;
    const acknowledge = () => {
      acknowledgementCount += 1;
      if (
        !acceptingAcknowledgement ||
        acknowledgementCount !== 1 ||
        this.#records.get(record.conn) !== record ||
        record.channel !== channel ||
        record.closing ||
        channel.liveConnectionToken() !== connectionToken
      ) {
        this.#teardown(record, true);
      }
    };
    try {
      sink(
        Object.freeze({
          frame,
          connection: record.conn,
          channel,
          connectionToken,
        }),
        acknowledge,
      );
    } catch (error) {
      log.warn('[AppSession] Auxiliary adoption failed closed', error);
      this.#teardown(record, true);
      return result(true);
    } finally {
      acceptingAcknowledgement = false;
    }
    if (
      acknowledgementCount !== 1 ||
      this.#records.get(record.conn) !== record ||
      record.channel !== channel ||
      record.closing ||
      channel.liveConnectionToken() !== connectionToken
    ) {
      this.#teardown(record, true);
    }
    return result(true);
  }

  #receivePeerRangeMessage(
    record: ConnectionRecord,
    frame: unknown,
    lane: 'control' | 'bulk',
  ): Readonly<FilePlaybackApplicationReceiveResult> {
    const channel = record.channel;
    const connectionToken = channel?.liveConnectionToken() ?? null;
    if (
      !channel ||
      connectionToken === null ||
      this.#records.get(record.conn) !== record ||
      record.channel !== channel ||
      record.closing ||
      channel.liveConnectionToken() !== connectionToken
    ) {
      this.#teardown(record, true);
      return result(true);
    }

    const sink = this.#adoptPeerRangeMessage;
    if (!sink) {
      this.#teardown(record, true);
      return result(true);
    }
    let acknowledgementCount = 0;
    let acceptingAcknowledgement = true;
    const acknowledge = () => {
      acknowledgementCount += 1;
      if (
        !acceptingAcknowledgement ||
        acknowledgementCount !== 1 ||
        this.#records.get(record.conn) !== record ||
        record.channel !== channel ||
        record.closing ||
        channel.liveConnectionToken() !== connectionToken
      ) {
        this.#teardown(record, true);
      }
    };
    try {
      sink(
        Object.freeze({
          frame,
          lane,
          role: record.role,
          connection: record.conn,
          channel,
          connectionToken,
        }),
        acknowledge,
      );
    } catch (error) {
      log.warn('[AppSession] Peer-range adoption failed closed', error);
      this.#teardown(record, true);
      return result(true);
    } finally {
      acceptingAcknowledgement = false;
    }
    if (
      acknowledgementCount !== 1 ||
      this.#records.get(record.conn) !== record ||
      record.channel !== channel ||
      record.closing ||
      channel.liveConnectionToken() !== connectionToken
    ) {
      this.#teardown(record, true);
    }
    return result(true);
  }

  #receiveGuestClockPong(
    record: GuestConnectionRecord,
    value: unknown,
  ): Readonly<FilePlaybackApplicationReceiveResult> {
    const pong = parseFilePlaybackClockPongV2(value);
    if (!pong) {
      this.#teardown(record, true);
      return result(true);
    }
    const binding = record.channel?.establishedBinding() ?? record.handshake.provisionalBinding();
    if (
      !binding ||
      pong.sessionId !== binding.sessionId ||
      pong.connectionId !== binding.connectionId
    ) {
      this.#teardown(record, true);
      return result(true);
    }
    if (record.calibrationRetiredPingIds.delete(pong.pingId)) return result(true);
    if (!record.calibrationPendingPingIds.delete(pong.pingId)) {
      this.#teardown(record, true);
      return result(true);
    }

    let accepted = false;
    let rejection: FilePlaybackClockExchangeRejectionReason | null = null;
    if (record.channel) {
      const received = record.channel.receive(pong, record.conn);
      if (received.accepted && received.frame === 'clock-pong') accepted = true;
      else if (!received.accepted && received.reason === 'clock-rejected') {
        rejection = received.clockReason;
      }
    } else if (record.clock) {
      const received = record.clock.handlePong(pong);
      if (received.accepted) accepted = true;
      else rejection = received.reason;
    }

    if (!accepted && (!rejection || !RECOVERABLE_CLOCK_SAMPLE_REJECTIONS.has(rejection))) {
      this.#teardown(record, true);
      return result(true);
    }

    if (accepted && this.#guestClockIsReady(record)) {
      this.#markCalibrationReady(record);
      return result(true, false, this.#publishClockReady(record));
    }
    if (record.calibrationPendingPingIds.size === 0 && record.calibrationState === 'calibrating') {
      if (record.calibrationAttempts >= this.#maxClockCalibrationAttempts) {
        this.#markCalibrationDegraded(record);
      } else if (!this.#sendNextCalibrationBatch(record, true)) {
        if (this.#records.get(record.conn) === record) this.#markCalibrationDegraded(record);
      }
    }
    return result(true);
  }

  #sendHostBootstrap(record: HostConnectionRecord): boolean {
    let acknowledgementCount = 0;
    let succeeded = false;
    bus.emit(
      'network:peer-bootstrap',
      record.conn,
      (frame) => {
        const entryIndex = record.bootstrapIndex;
        const snapshot = snapshotExactGuestBootstrapFrame(frame, entryIndex);
        if (
          !snapshot ||
          this.#records.get(record.conn) !== record ||
          record.closing ||
          record.bootstrapIndex !== entryIndex
        ) {
          this.#teardown(record, true);
          return false;
        }
        if (!this.#sendRequired(record, snapshot)) return false;
        record.bootstrapIndex += 1;
        return true;
      },
      (success) => {
        acknowledgementCount += 1;
        if (acknowledgementCount === 1) succeeded = success === true;
      },
    );
    if (
      acknowledgementCount !== 1 ||
      !succeeded ||
      record.bootstrapIndex !== 3 ||
      this.#records.get(record.conn) !== record
    ) {
      this.#teardown(record, true);
      return false;
    }
    return true;
  }

  #beginGuestCalibration(record: GuestConnectionRecord): boolean {
    if (
      this.#records.get(record.conn) !== record ||
      record.closing ||
      !(record.channel ?? record.clock)
    ) {
      return false;
    }
    this.#cancelCalibrationTimers(record);
    this.#retireCalibrationPending(record);
    record.calibrationEpoch += 1;
    record.calibrationAttempts = 0;
    record.calibrationState = 'calibrating';
    record.clockReadyNotified = false;
    if (!this.#armCalibrationDeadline(record)) return false;
    return this.#sendNextCalibrationBatch(record);
  }

  #sendNextCalibrationBatch(record: GuestConnectionRecord, resetClock = false): boolean {
    if (
      this.#records.get(record.conn) !== record ||
      record.closing ||
      record.calibrationState !== 'calibrating'
    ) {
      return false;
    }
    this.#clearCalibrationRetry(record);
    this.#retireCalibrationPending(record);
    const clock = record.channel ?? record.clock;
    if (!clock) return false;
    if (resetClock) {
      clock.handleWake();
      record.clockReadyNotified = false;
    }
    const count = Math.min(
      MAX_OUTSTANDING_CLOCK_PINGS,
      this.#maxClockCalibrationAttempts - record.calibrationAttempts,
    );
    if (count <= 0) {
      this.#markCalibrationDegraded(record);
      return true;
    }
    for (let index = 0; index < count; index += 1) {
      const ping =
        clock instanceof FilePlaybackConnectionChannel
          ? clock.createClockPing()
          : clock.createPing();
      record.calibrationAttempts += 1;
      record.calibrationPendingPingIds.add(ping.pingId);
      if (!this.#sendRequired(record, ping)) return false;
      if (
        this.#records.get(record.conn) !== record ||
        record.closing ||
        record.calibrationState !== 'calibrating'
      ) {
        return false;
      }
    }
    return this.#armCalibrationRetry(record);
  }

  #guestClockIsReady(record: GuestConnectionRecord): boolean {
    try {
      const clock = record.channel ?? record.clock;
      if (!clock) return false;
      return clock instanceof FilePlaybackConnectionChannel
        ? clock.clockReady()
        : clock.quality().calibrated;
    } catch {
      return false;
    }
  }

  #markCalibrationReady(record: GuestConnectionRecord): void {
    if (this.#records.get(record.conn) !== record || record.closing) return;
    record.calibrationState = 'ready';
    this.#cancelCalibrationTimers(record);
    this.#retireCalibrationPending(record);
  }

  #markCalibrationDegraded(record: GuestConnectionRecord): void {
    if (this.#records.get(record.conn) !== record || record.closing) return;
    record.calibrationState = 'degraded';
    record.clockReadyNotified = false;
    this.#cancelCalibrationTimers(record);
    this.#retireCalibrationPending(record);
    if (record.channel && !this.#emitLifecycle(record, 'clock-degraded')) {
      this.#teardown(record, true);
    }
  }

  #retireCalibrationPending(record: GuestConnectionRecord): void {
    for (const pingId of record.calibrationPendingPingIds) {
      record.calibrationRetiredPingIds.add(pingId);
    }
    record.calibrationPendingPingIds.clear();
    while (record.calibrationRetiredPingIds.size > MAX_RETIRED_CLOCK_PING_IDS) {
      const oldest = record.calibrationRetiredPingIds.values().next().value as number | undefined;
      if (oldest === undefined) break;
      record.calibrationRetiredPingIds.delete(oldest);
    }
  }

  #armHandshakeDeadline(record: ConnectionRecord): boolean {
    this.#clearHandshakeDeadline(record);
    const epoch = record.handshakeDeadlineEpoch;
    let handle: ApplicationSessionTimerHandle;
    try {
      handle = this.#scheduleTimeout(() => {
        if (
          record.handshakeDeadlineEpoch !== epoch ||
          this.#records.get(record.conn) !== record ||
          record.channel
        ) {
          return;
        }
        record.handshakeDeadline = null;
        this.#teardown(record, true);
      }, this.#applicationHandshakeDeadlineMs);
      if (handle === null || handle === undefined) throw new Error('Timer handle is missing');
    } catch (error) {
      log.warn('[AppSession] Failed to arm handshake deadline', error);
      this.#teardown(record, true);
      return false;
    }
    if (this.#records.get(record.conn) !== record || record.closing) {
      try {
        this.#cancelTimeout(handle);
      } catch {
        /* noop */
      }
      return false;
    }
    record.handshakeDeadline = handle;
    return true;
  }

  #clearHandshakeDeadline(record: ConnectionRecord): void {
    record.handshakeDeadlineEpoch += 1;
    const handle = record.handshakeDeadline;
    record.handshakeDeadline = null;
    if (handle === null) return;
    try {
      this.#cancelTimeout(handle);
    } catch {
      /* noop */
    }
  }

  #armCalibrationRetry(record: GuestConnectionRecord): boolean {
    const epoch = record.calibrationEpoch;
    let handle: ApplicationSessionTimerHandle;
    try {
      handle = this.#scheduleTimeout(() => {
        if (
          record.calibrationEpoch !== epoch ||
          this.#records.get(record.conn) !== record ||
          record.calibrationState !== 'calibrating'
        ) {
          return;
        }
        record.calibrationRetryTimer = null;
        if (this.#guestClockIsReady(record)) {
          this.#markCalibrationReady(record);
          this.#publishClockReady(record);
        } else if (record.calibrationAttempts >= this.#maxClockCalibrationAttempts) {
          this.#markCalibrationDegraded(record);
        } else if (!this.#sendNextCalibrationBatch(record, true)) {
          if (this.#records.get(record.conn) === record) this.#markCalibrationDegraded(record);
        }
      }, this.#clockCalibrationRetryMs);
      if (handle === null || handle === undefined) throw new Error('Timer handle is missing');
    } catch (error) {
      log.warn('[AppSession] Failed to arm calibration retry', error);
      return false;
    }
    if (
      this.#records.get(record.conn) !== record ||
      record.closing ||
      record.calibrationState !== 'calibrating' ||
      record.calibrationEpoch !== epoch
    ) {
      try {
        this.#cancelTimeout(handle);
      } catch {
        /* noop */
      }
      return false;
    }
    record.calibrationRetryTimer = handle;
    return true;
  }

  #armCalibrationDeadline(record: GuestConnectionRecord): boolean {
    const epoch = record.calibrationEpoch;
    let handle: ApplicationSessionTimerHandle;
    try {
      handle = this.#scheduleTimeout(() => {
        if (
          record.calibrationEpoch !== epoch ||
          this.#records.get(record.conn) !== record ||
          record.calibrationState !== 'calibrating'
        ) {
          return;
        }
        record.calibrationDeadlineTimer = null;
        if (this.#guestClockIsReady(record)) {
          this.#markCalibrationReady(record);
          this.#publishClockReady(record);
        } else {
          this.#markCalibrationDegraded(record);
        }
      }, this.#clockCalibrationDeadlineMs);
      if (handle === null || handle === undefined) throw new Error('Timer handle is missing');
    } catch (error) {
      log.warn('[AppSession] Failed to arm calibration deadline', error);
      return false;
    }
    if (
      this.#records.get(record.conn) !== record ||
      record.closing ||
      record.calibrationEpoch !== epoch
    ) {
      try {
        this.#cancelTimeout(handle);
      } catch {
        /* noop */
      }
      return false;
    }
    record.calibrationDeadlineTimer = handle;
    return true;
  }

  #clearCalibrationRetry(record: GuestConnectionRecord): void {
    const handle = record.calibrationRetryTimer;
    record.calibrationRetryTimer = null;
    if (handle === null) return;
    try {
      this.#cancelTimeout(handle);
    } catch {
      /* noop */
    }
  }

  #cancelCalibrationTimers(record: GuestConnectionRecord): void {
    this.#clearCalibrationRetry(record);
    const deadline = record.calibrationDeadlineTimer;
    record.calibrationDeadlineTimer = null;
    if (deadline !== null) {
      try {
        this.#cancelTimeout(deadline);
      } catch {
        /* noop */
      }
    }
  }

  #establishHost(record: HostConnectionRecord): Readonly<FilePlaybackApplicationReceiveResult> {
    try {
      const channel = new FilePlaybackConnectionChannel(record.handshake, record.conn, {
        clockExchange: record.clock ?? undefined,
      });
      record.channel = channel;
      if (!this.#emitLifecycle(record, 'established')) {
        this.#teardown(record, true);
        return result(true);
      }
      this.#clearHandshakeDeadline(record);
      return result(true, true, this.#publishClockReady(record));
    } catch (error) {
      log.warn('[AppSession] Host channel activation failed', error);
      this.#teardown(record, true);
      return result(true);
    }
  }

  #establishGuest(record: GuestConnectionRecord): Readonly<FilePlaybackApplicationReceiveResult> {
    try {
      const channel = new FilePlaybackConnectionChannel(record.handshake, record.conn, {
        clockExchange: record.clock ?? undefined,
        guestAppliedSendConfirmed: true,
      });
      const roomClock = getFilePlaybackRoomClock();
      record.clockLease = roomClock.bindGuestSession(channel);
      record.channel = channel;
      if (!this.#emitLifecycle(record, 'established')) {
        this.#teardown(record, true);
        return result(true);
      }
      this.#clearHandshakeDeadline(record);
      if (channel.clockReady()) this.#markCalibrationReady(record);
      return result(true, true, this.#publishClockReady(record));
    } catch (error) {
      log.warn('[AppSession] Guest channel activation failed', error);
      this.#teardown(record, true);
      return result(true);
    }
  }

  #publishClockReady(record: ConnectionRecord): boolean {
    const channel = record.channel;
    if (!channel || record.clockReadyNotified || !channel.clockReady()) return false;
    if (record.role === 'guest') this.#markCalibrationReady(record);
    record.clockReadyNotified = true;
    if (!this.#emitLifecycle(record, 'clock-ready')) {
      this.#teardown(record, true);
      return false;
    }
    return true;
  }

  #emitLifecycle(
    record: ConnectionRecord,
    kind: 'established' | 'clock-ready' | 'clock-degraded',
  ): boolean {
    const sink = this.#onLifecycleEvent;
    if (!sink) return true;
    const channel = record.channel;
    if (!channel) return false;
    try {
      sink(
        Object.freeze({
          kind,
          role: record.role,
          connection: record.conn,
          channel,
        }),
      );
    } catch (error) {
      log.warn('[AppSession] Lifecycle sink failed closed', error);
      return false;
    }
    return (
      !record.closing &&
      this.#records.get(record.conn) === record &&
      record.channel === channel &&
      !channel.isClosed()
    );
  }

  #sendRequired(record: ConnectionRecord, frame: unknown): boolean {
    if (record.closing || this.#records.get(record.conn) !== record || !record.conn.open) {
      this.#teardown(record, true);
      return false;
    }
    try {
      record.conn.send(frame);
      if (record.closing || this.#records.get(record.conn) !== record || !record.conn.open) {
        this.#teardown(record, true);
        return false;
      }
      return true;
    } catch (error) {
      log.warn('[AppSession] Required send failed', error);
      this.#teardown(record, true);
      return false;
    }
  }

  #teardown(record: ConnectionRecord | undefined, closeTransport: boolean): void {
    if (!record) return;
    if (record.closing) {
      if (closeTransport && record.conn.open) this.#closeTransport(record.conn);
      return;
    }
    record.closing = true;
    if (this.#records.get(record.conn) === record) this.#records.delete(record.conn);
    this.#clearHandshakeDeadline(record);
    if (record.role === 'guest') {
      record.calibrationEpoch += 1;
      this.#cancelCalibrationTimers(record);
      this.#retireCalibrationPending(record);
    }
    const channel = record.channel;
    if (!record.revocationPublished) {
      record.revocationPublished = true;
      try {
        this.#onLifecycleEvent?.(
          Object.freeze({
            kind: 'revoked' as const,
            role: record.role,
            connection: record.conn,
            channel,
          }),
        );
      } catch (error) {
        log.warn('[AppSession] Revocation lifecycle sink failed', error);
      }
    }
    if (channel) channel.close();
    else record.clock?.clearSession();
    record.channel = null;
    record.clock = null;
    if (record.role === 'guest' && record.clockLease) {
      getFilePlaybackRoomClock().clear(record.clockLease);
      record.clockLease = null;
    }
    if (closeTransport) this.#closeTransport(record.conn);
  }

  #closeTransport(conn: DataConnection | null | undefined): void {
    try {
      conn?.close();
    } catch {
      /* noop */
    }
  }
}

const filePlaybackApplicationSessions = new FilePlaybackApplicationSessionManager();

export function installFilePlaybackApplicationSessionHooks(
  hooks: FilePlaybackApplicationSessionHooks,
): void {
  filePlaybackApplicationSessions.installHooks(hooks);
}

export function getFilePlaybackApplicationSessionManager(): FilePlaybackApplicationSessionManager {
  return filePlaybackApplicationSessions;
}

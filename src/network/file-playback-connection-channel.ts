import type { ClockQuality, MonotonicNow } from './clock-estimator.ts';
import {
  FILE_PLAYBACK_CLOCK_PING_TYPE,
  FILE_PLAYBACK_CLOCK_PONG_TYPE,
  FilePlaybackClockExchange,
  parseFilePlaybackClockPingV2,
  parseFilePlaybackClockPongV2,
  type FilePlaybackClockExchangeRejectionReason,
  type FilePlaybackClockPingV2,
  type FilePlaybackClockPongResult,
  type FilePlaybackClockPongV2,
  type FilePlaybackClockRole,
} from './file-playback-clock-exchange.ts';
import {
  FilePlaybackGuestSessionHandshake,
  FilePlaybackHostSessionHandshake,
  type FilePlaybackSessionBindingV2,
} from './file-playback-session-handshake.ts';
import type { FilePlaybackClockBindings } from '../player/file-playback-clock.ts';
import {
  FILE_PLAYBACK_WIRE_KINDS,
  FILE_PLAYBACK_WIRE_MAX_PAYLOAD_BYTES,
  FilePlaybackWireReceiver,
  createFilePlaybackWireMessage,
  type FilePlaybackWireKind,
  type FilePlaybackWireMediaBinding,
  type FilePlaybackWireMessage,
} from '../player/file-playback-wire.ts';
import {
  FilePlaybackWireSender,
  type FilePlaybackWireMessageForKind,
  type FilePlaybackWirePayloadByKind,
} from '../player/file-playback-wire-sender.ts';

/**
 * Upper bound for one already-materialized file-playback connection frame.
 *
 * The transport adapter remains responsible for rejecting raw strings,
 * ArrayBuffers, Blobs, and decoded JSON above this limit *before* parsing or
 * object materialization. receive() deliberately accepts data objects only.
 * It independently measures their detached primitive representation without
 * invoking JSON.stringify or any source accessor.
 */
export const FILE_PLAYBACK_CONNECTION_CHANNEL_MAX_FRAME_BYTES =
  FILE_PLAYBACK_WIRE_MAX_PAYLOAD_BYTES;

const MAX_FRAME_KEYS = 32;
const MAX_FRAME_KEY_CODE_UNITS = 64;
const CHANNEL_OPTION_KEYS = Object.freeze([
  'clockExchange',
  'guestAppliedSendConfirmed',
  'maxClockSkewMs',
  'now',
] as const);
const MEDIA_KEYS = Object.freeze([
  'rendezvousId',
  'run',
  'sourceIdentity',
  'transferSessionId',
] as const);
const RUN_KEYS = Object.freeze(['queueItemId', 'revision', 'runId'] as const);
const RUN_KEY_SET = new Set<string>(RUN_KEYS);

/** Exhaustive, fail-closed ownership table for every control kind. */
const WIRE_KIND_SENDER_ROLE: Readonly<Record<FilePlaybackWireKind, FilePlaybackClockRole>> =
  Object.freeze({
    'source-ready': 'guest',
    'source-not-ready': 'guest',
    'rendezvous-arm': 'host',
    'rendezvous-armed': 'guest',
    'rendezvous-finalize': 'host',
    'rendezvous-finalized': 'guest',
    'file-playback-pause': 'host',
    'file-playback-seek': 'host',
    'file-playback-cancel': 'host',
    'renderer-health': 'guest',
  });

/**
 * APPLIED is a one-shot authority, not a reusable description. Claims never
 * expire for this document lifetime, including after channel close.
 */
const CLAIMED_HANDSHAKES = new WeakMap<EstablishedHandshake, object>();
const CONSTRUCTING_HANDSHAKES = new WeakSet<EstablishedHandshake>();

type EstablishedHandshake = FilePlaybackHostSessionHandshake | FilePlaybackGuestSessionHandshake;

type PrimitiveFrameValue = string | number | boolean | null;
type DetachedFrame = Readonly<Record<string, PrimitiveFrameValue>>;
type AcceptedClockSample = Extract<FilePlaybackClockPongResult, { readonly accepted: true }>;

export interface FilePlaybackConnectionChannelOptions {
  /** Shared monotonic source for tests/platform integration. */
  readonly now?: MonotonicNow;
  readonly maxClockSkewMs?: number;
  /** Exact provisional exchange for this same role/session/connection epoch. */
  readonly clockExchange?: FilePlaybackClockExchange;
  /**
   * Guest adapters set this only after APPLIED was successfully handed to the
   * exact live transport. A boolean cannot prove delivery: send failure still
   * requires immediate connection teardown and handshake discard by the
   * product adapter.
   */
  readonly guestAppliedSendConfirmed?: true;
}

export type FilePlaybackConnectionChannelRejectionReason =
  | 'closed'
  | 'wrong-connection-token'
  | 'reentrant-call'
  | 'malformed-frame'
  | 'wrong-direction'
  | 'wrong-role-kind'
  | 'clock-uncalibrated'
  | 'clock-rejected'
  | 'wire-rejected';

export type FilePlaybackConnectionChannelReceiveResult =
  | Readonly<{
      accepted: true;
      frame: 'clock-ping';
      /** The caller sends this canonical response on the same ordered lane. */
      pong: Readonly<FilePlaybackClockPongV2>;
    }>
  | Readonly<{
      accepted: true;
      frame: 'clock-pong';
      sample: AcceptedClockSample;
    }>
  | Readonly<{
      accepted: true;
      frame: 'wire';
      message: FilePlaybackWireMessage;
    }>
  | Readonly<{
      accepted: false;
      reason: Exclude<FilePlaybackConnectionChannelRejectionReason, 'clock-rejected'>;
    }>
  | Readonly<{
      accepted: false;
      reason: 'clock-rejected';
      clockReason: FilePlaybackClockExchangeRejectionReason;
    }>;

interface DetachedMediaBinding extends FilePlaybackWireMediaBinding {
  readonly run: FilePlaybackWireMediaBinding['run'];
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function rejected(
  reason: Exclude<FilePlaybackConnectionChannelRejectionReason, 'clock-rejected'>,
): FilePlaybackConnectionChannelReceiveResult;
function rejected(
  reason: 'clock-rejected',
  clockReason: FilePlaybackClockExchangeRejectionReason,
): FilePlaybackConnectionChannelReceiveResult;
function rejected(
  reason: FilePlaybackConnectionChannelRejectionReason,
  clockReason?: FilePlaybackClockExchangeRejectionReason,
): FilePlaybackConnectionChannelReceiveResult {
  return freezeCanonical({
    accepted: false as const,
    reason,
    ...(clockReason === undefined ? {} : { clockReason }),
  }) as FilePlaybackConnectionChannelReceiveResult;
}

function accepted<T extends object>(value: T): Readonly<T & { accepted: true }> {
  return freezeCanonical({ accepted: true as const, ...value });
}

function snapshotAllowedOptions(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const allowed = new Set<string>(CHANNEL_OPTION_KEYS);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function jsonStringByteLength(value: string, remaining: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes > remaining) return bytes;
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        // Well-formed JSON escapes lone UTF-16 surrogates as \udxxx.
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function primitiveJsonByteLength(value: PrimitiveFrameValue, remaining: number): number {
  if (typeof value === 'string') return jsonStringByteLength(value, remaining);
  if (value === null) return 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Object.is(value, -0) ? 1 : String(value).length;
}

/**
 * One hostile-object pass: every admitted descriptor is read exactly once,
 * accessors and nested values are rejected, and the byte budget is computed
 * directly from primitive values without hostile serialization hooks.
 */
function snapshotMaterializedFrame(value: unknown): DetachedFrame | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length === 0 ||
      ownKeys.length > MAX_FRAME_KEYS ||
      ownKeys.some(
        (key) =>
          typeof key !== 'string' || key.length === 0 || key.length > MAX_FRAME_KEY_CODE_UNITS,
      )
    ) {
      return null;
    }

    const snapshot = Object.create(null) as Record<string, PrimitiveFrameValue>;
    let bytes = 2;
    for (let index = 0; index < ownKeys.length; index += 1) {
      const key = ownKeys[index] as string;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const item = descriptor.value;
      if (
        item !== null &&
        typeof item !== 'string' &&
        typeof item !== 'number' &&
        typeof item !== 'boolean'
      ) {
        return null;
      }
      const separatorBytes = index === 0 ? 1 : 2;
      bytes +=
        separatorBytes +
        jsonStringByteLength(key, FILE_PLAYBACK_CONNECTION_CHANNEL_MAX_FRAME_BYTES - bytes) +
        primitiveJsonByteLength(item, FILE_PLAYBACK_CONNECTION_CHANNEL_MAX_FRAME_BYTES - bytes);
      if (bytes > FILE_PLAYBACK_CONNECTION_CHANNEL_MAX_FRAME_BYTES) return null;
      snapshot[key] = item;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotMediaBinding(value: unknown): Readonly<DetachedMediaBinding> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const allowed = new Set<string>(MEDIA_KEYS);
    const ownKeys = Reflect.ownKeys(value);
    if (
      !ownKeys.includes('run') ||
      !ownKeys.includes('sourceIdentity') ||
      !ownKeys.includes('transferSessionId') ||
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))
    ) {
      return null;
    }

    const outer = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      outer[key] = descriptor.value;
    }
    const runValue = outer.run;
    if (runValue === null || typeof runValue !== 'object' || Array.isArray(runValue)) return null;
    const runKeys = Reflect.ownKeys(runValue);
    if (
      runKeys.length !== RUN_KEYS.length ||
      runKeys.some((key) => typeof key !== 'string' || !RUN_KEY_SET.has(key))
    ) {
      return null;
    }
    const run = Object.create(null) as Record<string, unknown>;
    for (const key of RUN_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(runValue, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      run[key] = descriptor.value;
    }

    return freezeCanonical({
      run: freezeCanonical(run) as unknown as FilePlaybackWireMediaBinding['run'],
      sourceIdentity: outer.sourceIdentity as string,
      transferSessionId: outer.transferSessionId as string | null,
      ...(Object.hasOwn(outer, 'rendezvousId')
        ? { rendezvousId: outer.rendezvousId as string }
        : {}),
    });
  } catch {
    return null;
  }
}

function inferEstablishedBinding(handshake: EstablishedHandshake): Readonly<{
  binding: Readonly<FilePlaybackSessionBindingV2>;
  role: FilePlaybackClockRole;
}> {
  try {
    if (handshake instanceof FilePlaybackHostSessionHandshake) {
      const state = FilePlaybackHostSessionHandshake.prototype.state.call(handshake);
      const binding = FilePlaybackHostSessionHandshake.prototype.establishedBinding.call(handshake);
      if (state !== 'applied' || !binding) {
        throw new TypeError('Host file playback handshake is not APPLIED');
      }
      return freezeCanonical({ binding, role: 'host' as const });
    }
    if (handshake instanceof FilePlaybackGuestSessionHandshake) {
      const state = FilePlaybackGuestSessionHandshake.prototype.state.call(handshake);
      const binding =
        FilePlaybackGuestSessionHandshake.prototype.establishedBinding.call(handshake);
      if (state !== 'applied-issued' || !binding) {
        throw new TypeError('Guest file playback handshake is not APPLIED');
      }
      return freezeCanonical({ binding, role: 'guest' as const });
    }
  } catch (error) {
    if (error instanceof TypeError && /not APPLIED/u.test(error.message)) throw error;
  }
  throw new TypeError('File playback channel requires an APPLIED handshake object');
}

interface ClaimedChannelAuthority {
  readonly role: FilePlaybackClockRole;
  readonly binding: Readonly<FilePlaybackSessionBindingV2>;
  readonly connectionToken: object;
  readonly clock: FilePlaybackClockExchange;
  readonly sender: FilePlaybackWireSender;
  readonly receiver: FilePlaybackWireReceiver;
}

function claimChannelAuthority(
  handshake: EstablishedHandshake,
  liveConnectionToken: object,
  options: FilePlaybackConnectionChannelOptions,
): ClaimedChannelAuthority {
  const established = inferEstablishedBinding(handshake);
  if (liveConnectionToken === null || typeof liveConnectionToken !== 'object') {
    throw new TypeError('File playback channel requires an opaque live connection token');
  }
  if (CLAIMED_HANDSHAKES.has(handshake) || CONSTRUCTING_HANDSHAKES.has(handshake)) {
    throw new Error('File playback APPLIED handshake authority was already claimed');
  }

  CONSTRUCTING_HANDSHAKES.add(handshake);
  try {
    const optionSnapshot = snapshotAllowedOptions(options);
    if (
      !optionSnapshot ||
      (optionSnapshot.now !== undefined && typeof optionSnapshot.now !== 'function') ||
      (optionSnapshot.clockExchange !== undefined &&
        !(optionSnapshot.clockExchange instanceof FilePlaybackClockExchange)) ||
      (optionSnapshot.guestAppliedSendConfirmed !== undefined &&
        optionSnapshot.guestAppliedSendConfirmed !== true)
    ) {
      throw new TypeError('File playback channel options are invalid');
    }
    if (established.role === 'guest' && optionSnapshot.guestAppliedSendConfirmed !== true) {
      throw new TypeError(
        'Guest file playback channel requires confirmed APPLIED transport delivery',
      );
    }

    const binding = freezeCanonical({ ...established.binding });
    if (optionSnapshot.clockExchange !== undefined && optionSnapshot.now !== undefined) {
      throw new TypeError('An adopted clock exchange cannot override its monotonic source');
    }
    const adoptedClock = optionSnapshot.clockExchange as FilePlaybackClockExchange | undefined;
    const adoptedBinding = adoptedClock?.activeBinding();
    if (
      adoptedClock &&
      (!adoptedBinding ||
        adoptedBinding.role !== established.role ||
        adoptedBinding.sessionId !== binding.sessionId ||
        adoptedBinding.connectionId !== binding.connectionId)
    ) {
      throw new TypeError('Adopted clock exchange does not match the APPLIED connection scope');
    }
    const clock =
      adoptedClock ??
      new FilePlaybackClockExchange({
        role: established.role,
        sessionId: binding.sessionId,
        connectionId: binding.connectionId,
        ...(optionSnapshot.now === undefined ? {} : { now: optionSnapshot.now as MonotonicNow }),
      });
    const senderParticipantId =
      established.role === 'host' ? binding.hostParticipantId : binding.guestParticipantId;
    const recipientParticipantId =
      established.role === 'host' ? binding.guestParticipantId : binding.hostParticipantId;
    const sender = new FilePlaybackWireSender({
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      senderParticipantId,
      recipientParticipantId,
    });
    const receiver = new FilePlaybackWireReceiver({
      sessionId: binding.sessionId,
      connectionId: binding.connectionId,
      senderParticipantId: recipientParticipantId,
      recipientParticipantId: senderParticipantId,
      nowRoomTimeMs: () => clock.nowRoomTimeMs(),
      ...(optionSnapshot.maxClockSkewMs === undefined
        ? {}
        : { maxClockSkewMs: optionSnapshot.maxClockSkewMs as number }),
    });

    const authority = freezeCanonical({
      role: established.role,
      binding,
      connectionToken: liveConnectionToken,
      clock,
      sender,
      receiver,
    });
    // This is the one irreversible transition. A later channel close does not
    // release the APPLIED handshake for another connection object.
    CLAIMED_HANDSHAKES.set(handshake, liveConnectionToken);
    return authority;
  } finally {
    CONSTRUCTING_HANDSHAKES.delete(handshake);
  }
}

/**
 * Exact live-connection authority after HELLO/WELCOME/SNAPSHOT/APPLIED.
 *
 * One instance belongs to one opaque DataConnection object. A peer ID or a
 * matching connection ID string is never enough to receive a frame. The role,
 * participant direction, clock scope, sender scope, and receiver scope are all
 * derived from the established handshake and cannot be overridden by callers.
 *
 * Guest adapters MUST construct this class only from the success continuation
 * of sending APPLIED on this exact live connection. createApplied() alone is
 * insufficient: if transport send throws or reports failure, close that
 * DataConnection, discard the handshake, and never activate a channel from it.
 */
export class FilePlaybackConnectionChannel {
  readonly #role: FilePlaybackClockRole;
  #binding: Readonly<FilePlaybackSessionBindingV2> | null;
  #connectionToken: object | null;
  readonly #clock: FilePlaybackClockExchange;
  readonly #sender: FilePlaybackWireSender;
  readonly #receiver: FilePlaybackWireReceiver;
  #media: Readonly<DetachedMediaBinding> | null = null;
  #closed = false;
  #receiving = false;
  #mediaMutationEpoch = 0;

  constructor(
    handshake: EstablishedHandshake,
    liveConnectionToken: object,
    options: FilePlaybackConnectionChannelOptions = {},
  ) {
    const authority = claimChannelAuthority(handshake, liveConnectionToken, options);
    this.#role = authority.role;
    this.#binding = authority.binding;
    this.#connectionToken = authority.connectionToken;
    this.#clock = authority.clock;
    this.#sender = authority.sender;
    this.#receiver = authority.receiver;
  }

  role(): FilePlaybackClockRole {
    return this.#role;
  }

  establishedBinding(): Readonly<FilePlaybackSessionBindingV2> | null {
    return this.#closed ? null : this.#binding;
  }

  liveConnectionToken(): object | null {
    return this.#closed ? null : this.#connectionToken;
  }

  isClosed(): boolean {
    return this.#closed;
  }

  quality(): Readonly<ClockQuality> {
    this.#assertOpen();
    const quality = this.#clock.quality();
    this.#assertOpen();
    return quality;
  }

  /** Host identity clocks are ready immediately; guests require calibration. */
  clockReady(): boolean {
    this.#assertOpen();
    return this.#temporalAuthorityAvailable();
  }

  nowRoomTimeMs(): number {
    this.#assertTemporalAuthority();
    const value = this.#clock.nowRoomTimeMs();
    this.#assertTemporalAuthority();
    return value;
  }

  bindAudioContext(context: AudioContext): FilePlaybackClockBindings {
    this.#assertTemporalAuthority();
    const binding = this.#clock.bindAudioContext(context);
    this.#assertTemporalAuthority();
    const guarded =
      <Arguments extends unknown[]>(
        callback: (...args: Arguments) => number,
      ): ((...args: Arguments) => number) =>
      (...args: Arguments): number => {
        this.#assertTemporalAuthority();
        const value = callback(...args);
        this.#assertTemporalAuthority();
        return value;
      };
    return Object.freeze({
      nowRoomTimeMs: guarded(binding.nowRoomTimeMs),
      roomTimeMsToContextTime: guarded(binding.roomTimeMsToContextTime),
      localPerformanceMsToContextTime: guarded(binding.localPerformanceMsToContextTime),
    });
  }

  handleWake(): void {
    this.#assertOpen();
    this.#clock.handleWake();
    this.#assertOpen();
  }

  createClockPing(): Readonly<FilePlaybackClockPingV2> {
    this.#assertOpen();
    if (this.#role !== 'guest') throw new Error('Only the guest channel can create a clock ping');
    const ping = this.#clock.createPing();
    this.#assertOpen();
    return ping;
  }

  bindMedia(binding: FilePlaybackWireMediaBinding): void {
    this.#assertOpen();
    const entryEpoch = this.#mediaMutationEpoch;
    const detached = snapshotMediaBinding(binding);
    if (!detached) throw new TypeError('File playback channel media binding is invalid');
    // A hostile Proxy may synchronously close the channel while its own-data
    // descriptors are detached. Never republish media after that revocation.
    this.#assertOpen();
    if (this.#mediaMutationEpoch !== entryEpoch) {
      throw new Error('File playback media authority changed during binding');
    }
    const previous = this.#media;
    try {
      this.#sender.bindMedia(detached);
      this.#receiver.bindMedia(detached);
      this.#media = detached;
    } catch (error) {
      if (previous) {
        this.#sender.bindMedia(previous);
        this.#receiver.bindMedia(previous);
      } else {
        this.#sender.clearMedia();
        this.#receiver.clearMedia();
      }
      throw error;
    }
    this.#mediaMutationEpoch = entryEpoch + 1;
    this.#assertOpen();
  }

  clearMedia(): void {
    this.#assertOpen();
    this.#mediaMutationEpoch += 1;
    this.#media = null;
    this.#sender.clearMedia();
    this.#receiver.clearMedia();
  }

  createWire<const Kind extends keyof FilePlaybackWirePayloadByKind>(
    payload: FilePlaybackWirePayloadByKind[Kind],
  ): FilePlaybackWireMessageForKind<Kind> {
    this.#assertTemporalAuthority();
    // Role admission must happen before FilePlaybackWireSender allocates its
    // irreversible sequence. Detach once so hostile kind accessors/re-entry
    // cannot make the role check and sender observe different payloads.
    const detached = snapshotMaterializedFrame(payload);
    if (!detached || !Object.hasOwn(detached, 'kind')) {
      throw new TypeError('File playback wire payload is invalid');
    }
    this.#assertTemporalAuthority();
    const kind = detached.kind;
    if (
      typeof kind !== 'string' ||
      !FILE_PLAYBACK_WIRE_KINDS.includes(kind as FilePlaybackWireKind)
    ) {
      throw new TypeError('File playback wire payload is invalid');
    }
    if (WIRE_KIND_SENDER_ROLE[kind as FilePlaybackWireKind] !== this.#role) {
      throw new TypeError(`File playback ${this.#role} cannot send ${kind}`);
    }
    const message = this.#sender.create(detached as unknown as FilePlaybackWirePayloadByKind[Kind]);
    this.#assertTemporalAuthority();
    return message;
  }

  receive(value: unknown, liveConnectionToken: object): FilePlaybackConnectionChannelReceiveResult {
    if (this.#closed) return rejected('closed');
    if (liveConnectionToken !== this.#connectionToken) return rejected('wrong-connection-token');
    if (this.#receiving) return rejected('reentrant-call');

    this.#receiving = true;
    try {
      const detached = snapshotMaterializedFrame(value);
      if (this.#closed) return rejected('closed');
      if (!detached) return rejected('malformed-frame');

      const hasType = Object.hasOwn(detached, 'type');
      const hasKind = Object.hasOwn(detached, 'kind');
      if (hasType === hasKind) return rejected('malformed-frame');

      if (hasType) return this.#receiveClock(detached);
      return this.#receiveWire(detached);
    } finally {
      this.#receiving = false;
    }
  }

  /** Idempotent teardown. Previously returned AudioContext bindings fail closed. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connectionToken = null;
    this.#binding = null;
    this.#media = null;
    this.#mediaMutationEpoch += 1;
    this.#sender.clearMedia();
    this.#receiver.clearMedia();
    this.#clock.clearSession();
  }

  #receiveClock(frame: DetachedFrame): FilePlaybackConnectionChannelReceiveResult {
    const binding = this.#binding;
    if (!binding) return rejected('closed');

    if (frame.type === FILE_PLAYBACK_CLOCK_PING_TYPE) {
      if (this.#role !== 'host') return rejected('wrong-direction');
      const ping = parseFilePlaybackClockPingV2(frame);
      if (!ping) return rejected('malformed-frame');
      if (ping.sessionId !== binding.sessionId || ping.connectionId !== binding.connectionId) {
        return rejected(
          'clock-rejected',
          ping.sessionId !== binding.sessionId ? 'wrong-session' : 'wrong-connection',
        );
      }
      const result = this.#clock.handlePing(ping);
      if (this.#closed) return rejected('closed');
      if (!result.accepted) return rejected('clock-rejected', result.reason);
      return accepted({ frame: 'clock-ping' as const, pong: result.pong });
    }

    if (frame.type === FILE_PLAYBACK_CLOCK_PONG_TYPE) {
      if (this.#role !== 'guest') return rejected('wrong-direction');
      const pong = parseFilePlaybackClockPongV2(frame);
      if (!pong) return rejected('malformed-frame');
      if (pong.sessionId !== binding.sessionId || pong.connectionId !== binding.connectionId) {
        return rejected(
          'clock-rejected',
          pong.sessionId !== binding.sessionId ? 'wrong-session' : 'wrong-connection',
        );
      }
      const result = this.#clock.handlePong(pong);
      if (this.#closed) return rejected('closed');
      if (!result.accepted) return rejected('clock-rejected', result.reason);
      return accepted({ frame: 'clock-pong' as const, sample: result });
    }

    return rejected('malformed-frame');
  }

  #receiveWire(frame: DetachedFrame): FilePlaybackConnectionChannelReceiveResult {
    const binding = this.#binding;
    if (!binding) return rejected('closed');
    if (!this.#temporalAuthorityAvailable()) {
      return this.#closed ? rejected('closed') : rejected('clock-uncalibrated');
    }
    let canonical: FilePlaybackWireMessage;
    try {
      canonical = createFilePlaybackWireMessage(frame as unknown as FilePlaybackWireMessage);
    } catch {
      return rejected('malformed-frame');
    }

    const expectedSender =
      this.#role === 'host' ? binding.guestParticipantId : binding.hostParticipantId;
    const expectedRecipient =
      this.#role === 'host' ? binding.hostParticipantId : binding.guestParticipantId;
    if (
      canonical.senderParticipantId !== expectedSender ||
      canonical.recipientParticipantId !== expectedRecipient
    ) {
      return rejected('wrong-direction');
    }
    if (
      canonical.sessionId !== binding.sessionId ||
      canonical.connectionId !== binding.connectionId
    ) {
      return rejected('wire-rejected');
    }
    const remoteRole: FilePlaybackClockRole = this.#role === 'host' ? 'guest' : 'host';
    if (WIRE_KIND_SENDER_ROLE[canonical.kind] !== remoteRole) {
      return rejected('wrong-role-kind');
    }

    const message = this.#receiver.receive(canonical);
    if (this.#closed) return rejected('closed');
    return message ? accepted({ frame: 'wire' as const, message }) : rejected('wire-rejected');
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('File playback connection channel is closed');
  }

  #temporalAuthorityAvailable(): boolean {
    if (this.#closed) return false;
    if (this.#role === 'host') return true;
    try {
      const calibrated = this.#clock.quality().calibrated;
      return !this.#closed && calibrated;
    } catch {
      return false;
    }
  }

  #assertTemporalAuthority(): void {
    this.#assertOpen();
    if (!this.#temporalAuthorityAvailable()) {
      this.#assertOpen();
      throw new Error('Guest file playback clock is not calibrated');
    }
  }
}

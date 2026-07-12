import {
  type ClockQuality,
  type ClockSampleRejectionReason,
  type MonotonicNow,
  monotonicNow,
} from './clock-estimator.ts';
import { FilePlaybackClock } from '../player/file-playback-clock.ts';

export const FILE_PLAYBACK_CLOCK_PROTOCOL_VERSION = 2 as const;
export const FILE_PLAYBACK_CLOCK_PING_TYPE = 'FILE_PLAYBACK_CLOCK_PING_V2' as const;
export const FILE_PLAYBACK_CLOCK_PONG_TYPE = 'FILE_PLAYBACK_CLOCK_PONG_V2' as const;
export const MAX_FILE_PLAYBACK_CLOCK_ID_LENGTH = 128;
/**
 * Ten years of monotonic uptime is deliberately generous for a browser
 * document while keeping hostile wire values far away from floating-point
 * overflow. A connection surviving longer than this must establish a fresh
 * clock epoch.
 */
export const MAX_FILE_PLAYBACK_CLOCK_TIMESTAMP_MS = 10 * 366 * 24 * 60 * 60 * 1_000;
export const MAX_FILE_PLAYBACK_CLOCK_OFFSET_MS = MAX_FILE_PLAYBACK_CLOCK_TIMESTAMP_MS;
export const MAX_FILE_PLAYBACK_ROOM_TIME_MS =
  MAX_FILE_PLAYBACK_CLOCK_TIMESTAMP_MS + MAX_FILE_PLAYBACK_CLOCK_OFFSET_MS;

const DEFAULT_MAX_PENDING_PINGS = 32;
const DEFAULT_PING_TIMEOUT_MS = 5_000;
const CLOCK_ID_PATTERN = /^[A-Za-z0-9._~:-]+$/u;

export type FilePlaybackClockRole = 'host' | 'guest';

/**
 * Guest -> host. Every timestamp is a DOMHighResTimeStamp-compatible value
 * from performance.now(), never Date.now().
 */
export interface FilePlaybackClockPingV2 {
  readonly type: typeof FILE_PLAYBACK_CLOCK_PING_TYPE;
  readonly version: typeof FILE_PLAYBACK_CLOCK_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly pingId: number;
  readonly sequence: number;
  readonly t0: number;
}

/** Host -> guest. t0 is echoed byte-for-byte as a JavaScript number. */
export interface FilePlaybackClockPongV2 {
  readonly type: typeof FILE_PLAYBACK_CLOCK_PONG_TYPE;
  readonly version: typeof FILE_PLAYBACK_CLOCK_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly pingId: number;
  readonly sequence: number;
  readonly t0: number;
  readonly t1: number;
  readonly t2: number;
}

export type FilePlaybackClockExchangeRejectionReason =
  | 'malformed-message'
  | 'wrong-role'
  | 'inactive-session'
  | 'wrong-session'
  | 'wrong-connection'
  | 'stale-sequence'
  | 'unknown-ping'
  | 'mismatched-sequence'
  | 'mismatched-t0'
  | 'expired-ping'
  | 'performance-clock-reversed'
  | 'clock-value-out-of-range'
  | ClockSampleRejectionReason;

export type FilePlaybackClockPingResult =
  | Readonly<{
      accepted: true;
      pong: Readonly<FilePlaybackClockPongV2>;
    }>
  | Readonly<{
      accepted: false;
      reason: FilePlaybackClockExchangeRejectionReason;
    }>;

export type FilePlaybackClockPongResult =
  | Readonly<{
      accepted: true;
      rttMs: number;
      offsetMs: number;
      quality: Readonly<ClockQuality>;
    }>
  | Readonly<{
      accepted: false;
      reason: FilePlaybackClockExchangeRejectionReason;
    }>;

export interface FilePlaybackClockExchangeOptions {
  readonly role: FilePlaybackClockRole;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly now?: MonotonicNow;
  readonly maxPendingPings?: number;
  readonly pingTimeoutMs?: number;
}

interface PendingPing {
  readonly pingId: number;
  readonly sequence: number;
  readonly t0: number;
  readonly sessionId: string;
  readonly connectionId: string;
}

const PING_KEYS = Object.freeze([
  'connectionId',
  'pingId',
  'sequence',
  'sessionId',
  't0',
  'type',
  'version',
]);
const PONG_KEYS = Object.freeze([...PING_KEYS, 't1', 't2'].sort());

function isBoundedTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_FILE_PLAYBACK_CLOCK_TIMESTAMP_MS
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isFilePlaybackClockId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_FILE_PLAYBACK_CLOCK_ID_LENGTH &&
    CLOCK_ID_PATTERN.test(value)
  );
}

/**
 * Snapshot untrusted wire objects without invoking accessors or reading a
 * hostile Proxy property twice. Object.getOwnPropertyDescriptors performs one
 * descriptor read per own key; all later validation uses this detached copy.
 */
function snapshotExactDataRecord(
  value: unknown,
  expected: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (
      actual.length !== expected.length ||
      actual.some((key) => typeof key !== 'string') ||
      (actual as string[]).sort().some((key, index) => key !== expected[index])
    ) {
      return null;
    }

    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

export function parseFilePlaybackClockPingV2(
  value: unknown,
): Readonly<FilePlaybackClockPingV2> | null {
  const record = snapshotExactDataRecord(value, PING_KEYS);
  if (
    !record ||
    record.type !== FILE_PLAYBACK_CLOCK_PING_TYPE ||
    record.version !== FILE_PLAYBACK_CLOCK_PROTOCOL_VERSION ||
    !isFilePlaybackClockId(record.sessionId) ||
    !isFilePlaybackClockId(record.connectionId) ||
    !isPositiveSafeInteger(record.pingId) ||
    !isPositiveSafeInteger(record.sequence) ||
    !isBoundedTimestamp(record.t0)
  ) {
    return null;
  }

  return Object.freeze({
    type: FILE_PLAYBACK_CLOCK_PING_TYPE,
    version: FILE_PLAYBACK_CLOCK_PROTOCOL_VERSION,
    sessionId: record.sessionId,
    connectionId: record.connectionId,
    pingId: record.pingId,
    sequence: record.sequence,
    t0: record.t0,
  });
}

export function parseFilePlaybackClockPongV2(
  value: unknown,
): Readonly<FilePlaybackClockPongV2> | null {
  const record = snapshotExactDataRecord(value, PONG_KEYS);
  if (
    !record ||
    record.type !== FILE_PLAYBACK_CLOCK_PONG_TYPE ||
    record.version !== FILE_PLAYBACK_CLOCK_PROTOCOL_VERSION ||
    !isFilePlaybackClockId(record.sessionId) ||
    !isFilePlaybackClockId(record.connectionId) ||
    !isPositiveSafeInteger(record.pingId) ||
    !isPositiveSafeInteger(record.sequence) ||
    !isBoundedTimestamp(record.t0) ||
    !isBoundedTimestamp(record.t1) ||
    !isBoundedTimestamp(record.t2)
  ) {
    return null;
  }

  return Object.freeze({
    type: FILE_PLAYBACK_CLOCK_PONG_TYPE,
    version: FILE_PLAYBACK_CLOCK_PROTOCOL_VERSION,
    sessionId: record.sessionId,
    connectionId: record.connectionId,
    pingId: record.pingId,
    sequence: record.sequence,
    t0: record.t0,
    t1: record.t1,
    t2: record.t2,
  });
}

function rejected(
  reason: FilePlaybackClockExchangeRejectionReason,
): Readonly<{ accepted: false; reason: FilePlaybackClockExchangeRejectionReason }> {
  return Object.freeze({ accepted: false, reason });
}

function frozenQuality(quality: ClockQuality): Readonly<ClockQuality> {
  return Object.freeze({ ...quality });
}

function assertPositiveOption(value: number, label: string, integer: boolean): void {
  const valid = Number.isFinite(value) && value > 0 && (!integer || Number.isSafeInteger(value));
  if (!valid) throw new RangeError(`${label} must be a positive${integer ? ' safe integer' : ''}`);
}

/**
 * Lifecycle-scoped four-timestamp exchange for the file playback room clock.
 *
 * This class deliberately owns no timers and sends no messages. A future
 * network adapter transports the frozen ping/pong values and calls the two
 * receive methods immediately on delivery. Expiration is enforced lazily at
 * every guest send/receive boundary, so teardown never leaves a timer behind.
 */
export class FilePlaybackClockExchange {
  readonly #sourceNow: MonotonicNow;
  #clock: FilePlaybackClock | null = null;
  readonly #maxPendingPings: number;
  readonly #pingTimeoutMs: number;
  readonly #pending = new Map<number, PendingPing>();
  readonly #retiredConnectionIds = new Set<string>();
  #role: FilePlaybackClockRole;
  #sessionId: string | null;
  #connectionId: string | null;
  #nextPingId = 1;
  #nextSequence = 1;
  #lastHostSequence = 0;
  #lastObservedNowMs: number | null = null;
  #clockReversalEpoch = 0;

  constructor(options: FilePlaybackClockExchangeOptions) {
    if (options.role !== 'host' && options.role !== 'guest') {
      throw new RangeError('role must be either host or guest');
    }
    if (!isFilePlaybackClockId(options.sessionId)) {
      throw new RangeError('sessionId must be a bounded clock identifier');
    }
    if (!isFilePlaybackClockId(options.connectionId)) {
      throw new RangeError('connectionId must be a bounded clock identifier');
    }

    this.#sourceNow = options.now ?? monotonicNow;
    // The estimator and exchange deliberately share this one observation
    // gate. A reversal observed through quality()/hostNow() therefore clears
    // outstanding correlations as well as estimator samples.
    this.#clock = new FilePlaybackClock({ now: () => this.#observeNow() });
    this.#maxPendingPings = options.maxPendingPings ?? DEFAULT_MAX_PENDING_PINGS;
    this.#pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    assertPositiveOption(this.#maxPendingPings, 'maxPendingPings', true);
    assertPositiveOption(this.#pingTimeoutMs, 'pingTimeoutMs', false);

    this.#role = options.role;
    this.#sessionId = options.sessionId;
    this.#connectionId = options.connectionId;
    this.#resetClockForRole();
  }

  role(): FilePlaybackClockRole {
    return this.#role;
  }

  quality(): Readonly<ClockQuality> {
    const localNowMs = this.#captureNowOrThrow();
    return frozenQuality(this.#getClock().qualityAtLocalTime(localNowMs));
  }

  hostNow(): number {
    const localNowMs = this.#captureNowOrThrow();
    const roomTimeMs = this.#getClock().nowRoomTimeMsAtLocalTime(localNowMs);
    if (
      !Number.isFinite(roomTimeMs) ||
      roomTimeMs < 0 ||
      roomTimeMs > MAX_FILE_PLAYBACK_ROOM_TIME_MS
    ) {
      this.#resetAfterUnsafeClockValue();
      throw new RangeError('host room time is outside the supported clock range');
    }
    return roomTimeMs;
  }

  pendingPingCount(): number {
    return this.#pending.size;
  }

  createPing(): Readonly<FilePlaybackClockPingV2> {
    if (this.#role !== 'guest') throw new Error('Only a guest can create a clock ping');
    const sessionId = this.#sessionId;
    const connectionId = this.#connectionId;
    if (!sessionId || !connectionId) throw new Error('Clock exchange has no active session');

    const t0 = this.#captureNowOrThrow();
    this.#pruneExpired(t0);
    this.#evictOldestIfFull();
    const pingId = this.#takeCounter('pingId');
    const sequence = this.#takeCounter('sequence');
    const pending = Object.freeze({ pingId, sequence, t0, sessionId, connectionId });
    this.#pending.set(pingId, pending);

    return Object.freeze({
      type: FILE_PLAYBACK_CLOCK_PING_TYPE,
      version: FILE_PLAYBACK_CLOCK_PROTOCOL_VERSION,
      sessionId,
      connectionId,
      pingId,
      sequence,
      t0,
    });
  }

  handlePing(value: unknown): FilePlaybackClockPingResult {
    // t1 brackets validation and response construction so handler work is
    // correctly accounted as host processing time instead of network RTT.
    const t1 = this.#captureNow();
    if (t1 === null) return rejected('performance-clock-reversed');
    const ping = parseFilePlaybackClockPingV2(value);
    if (!ping) return rejected('malformed-message');
    if (this.#role !== 'host') return rejected('wrong-role');
    if (!this.#sessionId || !this.#connectionId) return rejected('inactive-session');
    if (ping.sessionId !== this.#sessionId) return rejected('wrong-session');
    if (ping.connectionId !== this.#connectionId) return rejected('wrong-connection');
    if (ping.sequence <= this.#lastHostSequence) return rejected('stale-sequence');

    const t2 = this.#captureNow();
    if (t2 === null) return rejected('performance-clock-reversed');
    this.#lastHostSequence = ping.sequence;

    const pong = Object.freeze({
      type: FILE_PLAYBACK_CLOCK_PONG_TYPE,
      version: FILE_PLAYBACK_CLOCK_PROTOCOL_VERSION,
      sessionId: ping.sessionId,
      connectionId: ping.connectionId,
      pingId: ping.pingId,
      sequence: ping.sequence,
      t0: ping.t0,
      t1,
      t2,
    });
    return Object.freeze({ accepted: true, pong });
  }

  handlePong(value: unknown): FilePlaybackClockPongResult {
    // Capture t3 before parsing/correlation so local receive-side work cannot
    // bias the four-timestamp estimate.
    const t3 = this.#captureNow();
    if (t3 === null) return rejected('performance-clock-reversed');
    const pong = parseFilePlaybackClockPongV2(value);
    if (!pong) return rejected('malformed-message');
    if (this.#role !== 'guest') return rejected('wrong-role');
    if (!this.#sessionId || !this.#connectionId) return rejected('inactive-session');
    if (pong.sessionId !== this.#sessionId) return rejected('wrong-session');
    if (pong.connectionId !== this.#connectionId) return rejected('wrong-connection');

    const pending = this.#pending.get(pong.pingId);
    if (!pending) return rejected('unknown-ping');

    // A response carrying the bound identity and a known pingId consumes that
    // registry entry even when another echoed field is corrupt. This keeps the
    // correlation strictly one-shot instead of allowing response races.
    this.#pending.delete(pong.pingId);
    if (pong.sequence !== pending.sequence) return rejected('mismatched-sequence');
    if (pong.t0 !== pending.t0) return rejected('mismatched-t0');

    this.#pruneExpired(t3);
    if (t3 - pending.t0 > this.#pingTimeoutMs) return rejected('expired-ping');

    const reversalEpoch = this.#clockReversalEpoch;
    const sample = this.#getClock().addNtpSample(pending.t0, pong.t1, pong.t2, t3);
    if (this.#clockReversalEpoch !== reversalEpoch) {
      // The estimator read the same shared monotonic source while accepting
      // the sample. Do not retain a sample captured across that reversal.
      this.#getClock().handleWake();
      return rejected('performance-clock-reversed');
    }
    if (!sample.accepted) return rejected(sample.reason);
    if (Math.abs(sample.offsetMs) > MAX_FILE_PLAYBACK_CLOCK_OFFSET_MS) {
      this.#resetAfterUnsafeClockValue();
      return rejected('clock-value-out-of-range');
    }
    return Object.freeze({
      accepted: true,
      rttMs: sample.rttMs,
      offsetMs: sample.offsetMs,
      quality: frozenQuality(sample.quality),
    });
  }

  /** Sleep/wake makes both pending RTTs and established offsets ineligible. */
  handleWake(): void {
    this.#pending.clear();
    this.#lastObservedNowMs = null;
    this.#getClock().handleWake();
  }

  /** A role boundary invalidates all samples and outstanding correlations. */
  setRole(role: FilePlaybackClockRole): void {
    if (role !== 'host' && role !== 'guest') {
      throw new RangeError('role must be either host or guest');
    }
    if (role === this.#role) return;
    this.#role = role;
    this.#pending.clear();
    this.#lastObservedNowMs = null;
    this.#resetClockForRole();
  }

  /**
   * Bind a new connection epoch. Old packets cannot cross this boundary.
   *
   * Adapter contract: connectionId MUST be freshly generated for every
   * transport epoch and MUST NOT be reused during the adapter lifetime. This
   * exchange additionally tombstones every retired ID for its object lifetime
   * to reject A -> B -> A rebinding even if an adapter violates that contract.
   */
  bindSession(sessionId: string, connectionId: string): void {
    if (!isFilePlaybackClockId(sessionId)) {
      throw new RangeError('sessionId must be a bounded clock identifier');
    }
    if (!isFilePlaybackClockId(connectionId)) {
      throw new RangeError('connectionId must be a bounded clock identifier');
    }
    if (sessionId === this.#sessionId && connectionId === this.#connectionId) return;
    if (connectionId === this.#connectionId || this.#retiredConnectionIds.has(connectionId)) {
      throw new RangeError('connectionId must not be reused across transport epochs');
    }

    this.#retireCurrentConnectionId();
    this.#sessionId = sessionId;
    this.#connectionId = connectionId;
    this.#pending.clear();
    this.#lastHostSequence = 0;
    this.#lastObservedNowMs = null;
    this.#resetClockForRole();
  }

  /** Full session teardown. The selected role is retained for the next bind. */
  clearSession(): void {
    this.#retireCurrentConnectionId();
    this.#sessionId = null;
    this.#connectionId = null;
    this.#pending.clear();
    this.#lastHostSequence = 0;
    this.#lastObservedNowMs = null;
    this.#resetClockForRole();
  }

  #takeCounter(label: 'pingId' | 'sequence'): number {
    const value = label === 'pingId' ? this.#nextPingId : this.#nextSequence;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${label} exhausted its positive safe-integer space`);
    }
    if (label === 'pingId') this.#nextPingId += 1;
    else this.#nextSequence += 1;
    return value;
  }

  #captureNowOrThrow(): number {
    const captured = this.#captureNow();
    if (captured === null) {
      throw new RangeError('performance.now() moved backwards during clock exchange');
    }
    return captured;
  }

  #captureNow(): number | null {
    const reversalEpoch = this.#clockReversalEpoch;
    const captured = this.#observeNow();
    return this.#clockReversalEpoch === reversalEpoch ? captured : null;
  }

  #pruneExpired(nowMs: number): void {
    for (const [pingId, pending] of this.#pending) {
      if (nowMs - pending.t0 > this.#pingTimeoutMs) this.#pending.delete(pingId);
    }
  }

  #evictOldestIfFull(): void {
    while (this.#pending.size >= this.#maxPendingPings) {
      const oldestPingId = this.#pending.keys().next().value as number | undefined;
      if (oldestPingId === undefined) return;
      this.#pending.delete(oldestPingId);
    }
  }

  #resetClockForRole(): void {
    this.#getClock().reset();
    this.#getClock().setHost(this.#role === 'host');
  }

  #observeNow(): number {
    let captured: number;
    try {
      captured = this.#sourceNow();
    } catch (error) {
      this.#invalidateObservedClock();
      throw error;
    }
    if (!isBoundedTimestamp(captured)) {
      this.#invalidateObservedClock();
      throw new RangeError('performance.now() is outside the supported clock range');
    }
    if (this.#lastObservedNowMs !== null && captured < this.#lastObservedNowMs) {
      this.#lastObservedNowMs = captured;
      this.#invalidateObservedClock();
      return captured;
    }
    this.#lastObservedNowMs = captured;
    return captured;
  }

  #resetAfterUnsafeClockValue(): void {
    this.#pending.clear();
    this.#getClock().handleWake();
  }

  #retireCurrentConnectionId(): void {
    const connectionId = this.#connectionId;
    if (!connectionId || this.#retiredConnectionIds.has(connectionId)) return;
    this.#retiredConnectionIds.add(connectionId);
  }

  #invalidateObservedClock(): void {
    this.#pending.clear();
    this.#clockReversalEpoch += 1;
    // Safe during an estimator read: handleWake() has no clock read of its
    // own and clears the estimator before the current observation commits.
    this.#clock?.handleWake();
  }

  #getClock(): FilePlaybackClock {
    const clock = this.#clock;
    if (!clock) throw new Error('File playback clock is not initialized');
    return clock;
  }
}

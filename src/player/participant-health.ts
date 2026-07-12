/**
 * Per-participant playback health and recovery policy.
 *
 * This module is deliberately side-effect free: it never touches the DOM,
 * networking, audio, or the room timeline. Callers report leased observations
 * and execute the returned actions for this participant only. In particular,
 * no action produced here can pause or stop healthy room participants.
 */

export const PARTICIPANT_HEALTH_STATES = Object.freeze({
  SYNCED: 'SYNCED',
  DEGRADED: 'DEGRADED',
  REJOINING: 'REJOINING',
  OFFLINE: 'OFFLINE',
} as const);

export type ParticipantHealthState =
  (typeof PARTICIPANT_HEALTH_STATES)[keyof typeof PARTICIPANT_HEALTH_STATES];

export const PARTICIPANT_HEALTH_DIMENSIONS = Object.freeze([
  'transport',
  'clock',
  'media-readiness',
  'renderer',
] as const);

export type ParticipantHealthDimension = (typeof PARTICIPANT_HEALTH_DIMENSIONS)[number];
export type ParticipantHealthValue = 'healthy' | 'unhealthy';

export interface ParticipantHealthSignal {
  readonly dimension: ParticipantHealthDimension;
  readonly value: ParticipantHealthValue;
  /** Timestamp in the same monotonic domain as `now`. */
  readonly observedAtMs: number;
  /**
   * Exclusive lease deadline. Healthy observations require a future deadline;
   * unhealthy observations use `observedAtMs` as their zero-length lease.
   */
  readonly leaseUntilMs: number;
  readonly reasonCode?: string | null;
}

export interface ParticipantHealthDimensionSnapshot {
  readonly value: ParticipantHealthValue;
  readonly observedAtMs: number;
  readonly leaseUntilMs: number;
  readonly reasonCode: string | null;
  readonly effectiveHealthy: boolean;
}

export interface ParticipantHealthSnapshot {
  readonly participantId: string;
  readonly state: ParticipantHealthState;
  readonly evaluatedAtMs: number;
  readonly hidden: boolean;
  /** Identity is retained through transient disconnect and rejoin grace. */
  readonly identityRetained: boolean;
  readonly episode: number;
  readonly activeEpisode: number | null;
  readonly degradedSinceMs: number | null;
  readonly reconnectDeadlineMs: number | null;
  readonly notificationEmitted: boolean;
  /** True while an explicit rendezvous/rejoin completion is still required. */
  readonly rejoinRequired: boolean;
  readonly unhealthyDimensions: readonly ParticipantHealthDimension[];
  readonly dimensions: Readonly<
    Record<ParticipantHealthDimension, ParticipantHealthDimensionSnapshot>
  >;
}

interface ParticipantHealthActionBase {
  readonly participantId: string;
  readonly atMs: number;
  readonly episode: number;
}

export interface EmitDegradedSystemMessageAction extends ParticipantHealthActionBase {
  readonly type: 'emit-degraded-system-message';
  readonly messageKey: 'participant-connection-unstable-recovering';
  readonly unhealthyDimensions: readonly ParticipantHealthDimension[];
}

export interface RequestParticipantRejoinAction extends ParticipantHealthActionBase {
  readonly type: 'request-rejoin';
  readonly unhealthyDimensions: readonly ParticipantHealthDimension[];
}

export interface MarkParticipantOfflineAction extends ParticipantHealthActionBase {
  readonly type: 'mark-offline';
  readonly reason: 'explicit-leave' | 'session-ended' | 'reconnect-grace-expired';
}

export type ParticipantHealthAction =
  | EmitDegradedSystemMessageAction
  | RequestParticipantRejoinAction
  | MarkParticipantOfflineAction;

export interface ParticipantHealthTransition {
  /**
   * Whether this input changed the machine. A false result can still carry
   * actions whose monotonic deadline matured while processing the input.
   */
  readonly accepted: boolean;
  readonly actions: readonly ParticipantHealthAction[];
  readonly snapshot: ParticipantHealthSnapshot;
}

export interface ParticipantHealthMonitorOptions {
  readonly participantId: string;
  readonly now: () => number;
  /** All four dimensions begin healthy under this explicit lease. */
  readonly initialLeaseUntilMs: number;
  readonly degradationGraceMs?: number;
  readonly reconnectGraceMs?: number;
  readonly maxLeaseDurationMs?: number;
}

interface MutableDimensionHealth {
  value: ParticipantHealthValue;
  observedAtMs: number;
  leaseUntilMs: number;
  reasonCode: string | null;
}

const DEFAULT_DEGRADATION_GRACE_MS = 1_500;
const DEFAULT_RECONNECT_GRACE_MS = 15_000;
const DEFAULT_MAX_LEASE_DURATION_MS = 60_000;
const MAX_DURATION_MS = 86_400_000;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_REASON_CODE_LENGTH = 128;

function isFiniteMonotonicTime(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function assertMonotonicTime(value: unknown, label: string): asserts value is number {
  if (!isFiniteMonotonicTime(value)) {
    throw new RangeError(`${label} must be a finite non-negative monotonic timestamp`);
  }
}

function assertDuration(value: unknown, label: string, allowZero = true): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < (allowZero ? 0 : Number.MIN_VALUE) ||
    value > MAX_DURATION_MS
  ) {
    throw new RangeError(`${label} must be a bounded finite duration`);
  }
}

function isDimension(value: unknown): value is ParticipantHealthDimension {
  return PARTICIPANT_HEALTH_DIMENSIONS.some((dimension) => dimension === value);
}

function immutableDimensions(
  dimensions: readonly ParticipantHealthDimension[],
): readonly ParticipantHealthDimension[] {
  return Object.freeze([...dimensions]);
}

function freezeActions(
  actions: readonly ParticipantHealthAction[],
): readonly ParticipantHealthAction[] {
  return Object.freeze(actions.map((action) => Object.freeze(action)));
}

/**
 * Deterministic health FSM for exactly one room participant.
 *
 * Call `tick()` from an existing monotonic scheduler so lease/grace deadlines
 * can mature even when no new health signal arrives.
 */
export class ParticipantHealthMonitor {
  readonly #participantId: string;
  readonly #now: () => number;
  readonly #degradationGraceMs: number;
  readonly #reconnectGraceMs: number;
  readonly #maxLeaseDurationMs: number;
  readonly #dimensions: Record<ParticipantHealthDimension, MutableDimensionHealth>;

  #state: ParticipantHealthState = PARTICIPANT_HEALTH_STATES.SYNCED;
  #lastNowMs: number;
  #evaluatedAtMs: number;
  #hidden = false;
  #episode = 0;
  #activeEpisode: number | null = null;
  #degradedSinceMs: number | null = null;
  #transportDisconnectedAtMs: number | null = null;
  #notificationEmitted = false;
  #rejoinRequested = false;
  #rejoinRequired = false;

  constructor(options: ParticipantHealthMonitorOptions) {
    if (
      typeof options.participantId !== 'string' ||
      options.participantId.length === 0 ||
      options.participantId.length > MAX_IDENTIFIER_LENGTH
    ) {
      throw new TypeError('participantId must be a non-empty bounded identifier');
    }
    if (typeof options.now !== 'function') throw new TypeError('now must be a function');

    const now = options.now();
    assertMonotonicTime(now, 'now()');

    this.#degradationGraceMs = options.degradationGraceMs ?? DEFAULT_DEGRADATION_GRACE_MS;
    this.#reconnectGraceMs = options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.#maxLeaseDurationMs = options.maxLeaseDurationMs ?? DEFAULT_MAX_LEASE_DURATION_MS;
    assertDuration(this.#degradationGraceMs, 'degradationGraceMs');
    assertDuration(this.#reconnectGraceMs, 'reconnectGraceMs', false);
    assertDuration(this.#maxLeaseDurationMs, 'maxLeaseDurationMs', false);
    assertMonotonicTime(options.initialLeaseUntilMs, 'initialLeaseUntilMs');
    if (
      options.initialLeaseUntilMs <= now ||
      options.initialLeaseUntilMs - now > this.#maxLeaseDurationMs
    ) {
      throw new RangeError('initialLeaseUntilMs must be a bounded future lease');
    }

    this.#participantId = options.participantId;
    this.#now = options.now;
    this.#lastNowMs = now;
    this.#evaluatedAtMs = now;
    const initial = (): MutableDimensionHealth => ({
      value: 'healthy',
      observedAtMs: now,
      leaseUntilMs: options.initialLeaseUntilMs,
      reasonCode: null,
    });
    this.#dimensions = {
      transport: initial(),
      clock: initial(),
      'media-readiness': initial(),
      renderer: initial(),
    };
  }

  getSnapshot(): ParticipantHealthSnapshot {
    return this.#snapshot();
  }

  /** Applies one leased health observation. */
  report(signal: ParticipantHealthSignal): ParticipantHealthTransition {
    return this.reportMany([signal]);
  }

  /** Applies one atomic set of observations, with at most one per dimension. */
  reportMany(signals: readonly ParticipantHealthSignal[]): ParticipantHealthTransition {
    if (!Array.isArray(signals as unknown) || signals.length === 0) {
      throw new TypeError('signals must contain at least one health observation');
    }
    if (signals.length > PARTICIPANT_HEALTH_DIMENSIONS.length) {
      throw new RangeError('signals contains too many health observations');
    }

    const batch: readonly ParticipantHealthSignal[] = signals;
    const now = this.#readNow();
    const seen = new Set<ParticipantHealthDimension>();
    for (const signal of batch) {
      this.#validateSignal(signal, now);
      if (seen.has(signal.dimension)) {
        throw new TypeError(`signals contains duplicate ${signal.dimension} observations`);
      }
      seen.add(signal.dimension);
    }

    const actions: ParticipantHealthAction[] = [];
    this.#evaluatedAtMs = now;
    if (this.#expireDisconnectedTransport(now, actions)) {
      return this.#transition(false, actions);
    }

    let accepted = false;
    for (const signal of batch) {
      const current = this.#dimensions[signal.dimension];
      if (signal.observedAtMs <= current.observedAtMs) continue;
      current.value = signal.value;
      current.observedAtMs = signal.observedAtMs;
      current.leaseUntilMs = signal.leaseUntilMs;
      current.reasonCode = signal.reasonCode ?? null;
      accepted = true;
    }
    actions.push(...this.#evaluate(now));
    return this.#transition(accepted, actions);
  }

  /** Advances lease and grace deadlines without introducing a health signal. */
  tick(): ParticipantHealthTransition {
    const now = this.#readNow();
    return this.#transition(true, this.#evaluate(now));
  }

  /**
   * Records visibility for diagnostics only. Hidden state is intentionally not
   * one of the four health dimensions and cannot degrade a participant.
   */
  setDocumentHidden(hidden: boolean): ParticipantHealthTransition {
    if (typeof hidden !== 'boolean') throw new TypeError('hidden must be a boolean');
    const now = this.#readNow();
    const actions = this.#evaluate(now);
    if (this.#hidden === hidden) return this.#transition(false, actions);
    this.#hidden = hidden;
    return this.#transition(true, actions);
  }

  /** Moves a degraded participant into the caller-managed recovery attempt. */
  beginRejoin(): ParticipantHealthTransition {
    const now = this.#readNow();
    const actions = this.#evaluate(now);
    if (this.#state !== PARTICIPANT_HEALTH_STATES.DEGRADED) {
      return this.#transition(false, actions);
    }
    this.#state = PARTICIPANT_HEALTH_STATES.REJOINING;
    this.#rejoinRequired = true;
    return this.#transition(true, actions);
  }

  /**
   * Completes a caller-managed rejoin. Success is accepted only after all four
   * leased dimensions are healthy; failure returns to DEGRADED without
   * duplicating the episode notification.
   */
  completeRejoin(success: boolean): ParticipantHealthTransition {
    if (typeof success !== 'boolean') throw new TypeError('success must be a boolean');
    const now = this.#readNow();
    const actions = this.#evaluate(now);
    if (this.#state !== PARTICIPANT_HEALTH_STATES.REJOINING) {
      return this.#transition(false, actions);
    }
    if (!success) {
      this.#state = PARTICIPANT_HEALTH_STATES.DEGRADED;
      this.#rejoinRequired = true;
      return this.#transition(true, actions);
    }
    if (this.#unhealthyDimensions(now).length > 0) {
      return this.#transition(false, actions);
    }
    this.#settleSynced();
    return this.#transition(true, actions);
  }

  /** Explicit terminal transition. Unexpected transport loss uses grace instead. */
  markOffline(reason: 'explicit-leave' | 'session-ended'): ParticipantHealthTransition {
    if (reason !== 'explicit-leave' && reason !== 'session-ended') {
      throw new TypeError('invalid offline reason');
    }
    const now = this.#readNow();
    this.#evaluatedAtMs = now;
    if (this.#state === PARTICIPANT_HEALTH_STATES.OFFLINE) {
      return this.#transition(false, []);
    }
    return this.#transition(true, [this.#offline(now, reason)]);
  }

  explicitLeave(): ParticipantHealthTransition {
    return this.markOffline('explicit-leave');
  }

  #readNow(): number {
    const now = this.#now();
    assertMonotonicTime(now, 'now()');
    if (now < this.#lastNowMs) {
      throw new RangeError('now() moved backwards');
    }
    this.#lastNowMs = now;
    return now;
  }

  #validateSignal(signal: ParticipantHealthSignal, now: number): void {
    if (!signal || typeof signal !== 'object') {
      throw new TypeError('health signal must be an object');
    }
    if (!isDimension(signal.dimension)) throw new TypeError('invalid health dimension');
    if (signal.value !== 'healthy' && signal.value !== 'unhealthy') {
      throw new TypeError('invalid health value');
    }
    assertMonotonicTime(signal.observedAtMs, 'observedAtMs');
    assertMonotonicTime(signal.leaseUntilMs, 'leaseUntilMs');
    if (signal.observedAtMs > now) {
      throw new RangeError('observedAtMs cannot be in the future');
    }
    if (signal.value === 'healthy') {
      if (
        signal.leaseUntilMs <= signal.observedAtMs ||
        signal.leaseUntilMs <= now ||
        signal.leaseUntilMs - signal.observedAtMs > this.#maxLeaseDurationMs
      ) {
        throw new RangeError('healthy signal requires a bounded future lease');
      }
    } else if (signal.leaseUntilMs !== signal.observedAtMs) {
      throw new RangeError('unhealthy signal must use a zero-length lease');
    }
    if (
      signal.reasonCode !== undefined &&
      signal.reasonCode !== null &&
      (typeof signal.reasonCode !== 'string' ||
        signal.reasonCode.length === 0 ||
        signal.reasonCode.length > MAX_REASON_CODE_LENGTH)
    ) {
      throw new TypeError('reasonCode must be null or a non-empty bounded string');
    }
  }

  #evaluate(now: number): ParticipantHealthAction[] {
    this.#evaluatedAtMs = now;
    const actions: ParticipantHealthAction[] = [];
    if (this.#expireDisconnectedTransport(now, actions)) return actions;

    const unhealthy = this.#unhealthyDimensions(now);
    const transportHealthy = !unhealthy.includes('transport');
    if (!transportHealthy && this.#transportDisconnectedAtMs === null) {
      this.#transportDisconnectedAtMs = this.#failureStartedAt('transport', now);
    } else if (transportHealthy) {
      this.#transportDisconnectedAtMs = null;
    }

    if (this.#expireDisconnectedTransport(now, actions)) return actions;

    if (unhealthy.length === 0) {
      if (this.#state !== PARTICIPANT_HEALTH_STATES.REJOINING && !this.#rejoinRequired) {
        this.#settleSynced();
      }
      return actions;
    }

    if (this.#activeEpisode === null) {
      this.#episode += 1;
      this.#activeEpisode = this.#episode;
      this.#degradedSinceMs = Math.min(
        ...unhealthy.map((dimension) => this.#failureStartedAt(dimension, now)),
      );
      this.#notificationEmitted = false;
      this.#rejoinRequested = false;
    }
    if (this.#state !== PARTICIPANT_HEALTH_STATES.REJOINING) {
      this.#state = PARTICIPANT_HEALTH_STATES.DEGRADED;
    }

    if (this.#degradedSinceMs !== null && now >= this.#degradedSinceMs + this.#degradationGraceMs) {
      const dimensions = immutableDimensions(unhealthy);
      if (!this.#notificationEmitted) {
        this.#notificationEmitted = true;
        actions.push(
          Object.freeze({
            type: 'emit-degraded-system-message',
            messageKey: 'participant-connection-unstable-recovering',
            participantId: this.#participantId,
            atMs: now,
            episode: this.#activeEpisode,
            unhealthyDimensions: dimensions,
          }),
        );
      }
      if (!this.#rejoinRequested) {
        this.#rejoinRequested = true;
        this.#rejoinRequired = true;
        actions.push(
          Object.freeze({
            type: 'request-rejoin',
            participantId: this.#participantId,
            atMs: now,
            episode: this.#activeEpisode,
            unhealthyDimensions: dimensions,
          }),
        );
      }
    }
    return actions;
  }

  #expireDisconnectedTransport(now: number, actions: ParticipantHealthAction[]): boolean {
    if (this.#state === PARTICIPANT_HEALTH_STATES.OFFLINE) return true;
    const transport = this.#dimensions.transport;
    const effectiveHealthy = transport.value === 'healthy' && now < transport.leaseUntilMs;
    if (effectiveHealthy) return false;
    const disconnectedAt =
      this.#transportDisconnectedAtMs ?? this.#failureStartedAt('transport', now);
    this.#transportDisconnectedAtMs = disconnectedAt;
    if (now >= disconnectedAt + this.#reconnectGraceMs) {
      actions.push(this.#offline(now, 'reconnect-grace-expired'));
      return true;
    }
    return false;
  }

  #offline(
    now: number,
    reason: MarkParticipantOfflineAction['reason'],
  ): MarkParticipantOfflineAction {
    const episode = this.#activeEpisode ?? this.#episode;
    this.#state = PARTICIPANT_HEALTH_STATES.OFFLINE;
    this.#activeEpisode = null;
    this.#degradedSinceMs = null;
    this.#transportDisconnectedAtMs = null;
    this.#notificationEmitted = false;
    this.#rejoinRequested = false;
    this.#rejoinRequired = false;
    return Object.freeze({
      type: 'mark-offline',
      participantId: this.#participantId,
      atMs: now,
      episode,
      reason,
    });
  }

  #settleSynced(): void {
    this.#state = PARTICIPANT_HEALTH_STATES.SYNCED;
    this.#activeEpisode = null;
    this.#degradedSinceMs = null;
    this.#transportDisconnectedAtMs = null;
    this.#notificationEmitted = false;
    this.#rejoinRequested = false;
    this.#rejoinRequired = false;
  }

  #failureStartedAt(dimension: ParticipantHealthDimension, now: number): number {
    const health = this.#dimensions[dimension];
    return Math.min(now, health.value === 'healthy' ? health.leaseUntilMs : health.observedAtMs);
  }

  #unhealthyDimensions(now: number): ParticipantHealthDimension[] {
    return PARTICIPANT_HEALTH_DIMENSIONS.filter((dimension) => {
      const health = this.#dimensions[dimension];
      return health.value !== 'healthy' || now >= health.leaseUntilMs;
    });
  }

  #transition(
    accepted: boolean,
    actions: readonly ParticipantHealthAction[],
  ): ParticipantHealthTransition {
    return Object.freeze({
      accepted,
      actions: freezeActions(actions),
      snapshot: this.#snapshot(),
    });
  }

  #snapshot(): ParticipantHealthSnapshot {
    const evaluatedAtMs = this.#evaluatedAtMs;
    const dimensions = Object.freeze(
      Object.fromEntries(
        PARTICIPANT_HEALTH_DIMENSIONS.map((dimension) => {
          const health = this.#dimensions[dimension];
          return [
            dimension,
            Object.freeze({
              value: health.value,
              observedAtMs: health.observedAtMs,
              leaseUntilMs: health.leaseUntilMs,
              reasonCode: health.reasonCode,
              effectiveHealthy: health.value === 'healthy' && evaluatedAtMs < health.leaseUntilMs,
            }),
          ];
        }),
      ),
    ) as Readonly<Record<ParticipantHealthDimension, ParticipantHealthDimensionSnapshot>>;
    const unhealthyDimensions = immutableDimensions(this.#unhealthyDimensions(evaluatedAtMs));
    return Object.freeze({
      participantId: this.#participantId,
      state: this.#state,
      evaluatedAtMs,
      hidden: this.#hidden,
      identityRetained: this.#state !== PARTICIPANT_HEALTH_STATES.OFFLINE,
      episode: this.#episode,
      activeEpisode: this.#activeEpisode,
      degradedSinceMs: this.#degradedSinceMs,
      reconnectDeadlineMs:
        this.#transportDisconnectedAtMs === null
          ? null
          : this.#transportDisconnectedAtMs + this.#reconnectGraceMs,
      notificationEmitted: this.#notificationEmitted,
      rejoinRequired: this.#rejoinRequired,
      unhealthyDimensions,
      dimensions,
    });
  }
}

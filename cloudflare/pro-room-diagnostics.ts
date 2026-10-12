/**
 * Best-effort, credential-free PRO diagnostics. Counters live only in memory:
 * eviction/cancellation can lose an unflushed window, and Logs retention and
 * platform sampling still apply. No storage, network, timers, or heartbeat logs.
 */
const WINDOW_MS = 60_000;
const REPEATED_DETAILS_PER_WINDOW = 4;
const MAX_COUNT = 2_147_483_647;

// Both counter keys and first-failure slots come exclusively from this table.
// Adding arbitrary request strings here would remove the cardinality bound.
const EVENT_REASONS = {
  presence_join: [],
  presence_reenter: [],
  presence_replay: [],
  presence_takeover: [],
  presence_close: [],
  presence_leave: [],
  presence_expire: [],
  presence_kick: [],
  presence_pin_revoked: [],
  room_sleep: [],
  room_wake: [],
  room_full: [
    'total_presence',
    'non_owner_presence',
    'identity_unavailable',
    'signaling_connections',
  ],
  rate_limited: [
    'pin',
    'admission',
    'owner_recovery',
    'owner_transfer',
    'control',
    'bot',
    'ledger_capacity',
  ],
  state_capacity: ['core', 'session_receipt', 'presence_close_receipt', 'member_limit'],
  presence_active_elsewhere: [],
  presence_identity_mismatch: [],
  // This means a server-observed numeric projection violation. It does not
  // claim that the browser received or rejected the response.
  snapshot_contract_invalid: ['peer_ordinal', 'member_display_number'],
  registry_failure: ['lookup', 'refresh', 'timeout'],
  upstream_timeout: ['response', 'body'],
  upstream_failure: ['fetch', 'response', 'body'],
} as const;

export type ProRoomDiagnosticEvent = keyof typeof EVENT_REASONS;
export type ProRoomDiagnosticReason = (typeof EVENT_REASONS)[ProRoomDiagnosticEvent][number];
export type ProRoomDiagnosticScope = 'room' | 'front' | 'app' | 'signaling';

const FAILURES = new Set<ProRoomDiagnosticEvent>([
  'room_full',
  'rate_limited',
  'state_capacity',
  'presence_active_elsewhere',
  'presence_identity_mismatch',
  'snapshot_contract_invalid',
  'registry_failure',
  'upstream_timeout',
  'upstream_failure',
]);
const OPERATIONS = [
  'sessions',
  'presence_enter',
  'presence_close',
  'session_close',
  'heartbeat',
  'bootstrap',
  'registry_refresh',
  'registry_lookup',
  'system_audio',
  'account_lease',
  'snapshot',
  'alarm',
  'other',
] as const;

export interface ProRoomDiagnosticContext {
  readonly scope: ProRoomDiagnosticScope;
  readonly roomCode?: unknown;
  readonly roomGeneration?: unknown;
  readonly versionId?: unknown;
}

export interface ProRoomDiagnosticDetail {
  readonly operation?: (typeof OPERATIONS)[number];
  readonly reason?: ProRoomDiagnosticReason;
  readonly livePresence?: unknown;
  readonly residentPresence?: unknown;
  readonly nonOwnerPresence?: unknown;
  readonly storedSessions?: unknown;
  readonly maxPeerOrdinal?: unknown;
  readonly sessionReceipts?: unknown;
  readonly affectedCount?: unknown;
  readonly socketCount?: unknown;
  readonly authorityTargetCount?: unknown;
  readonly authorityPresenceRevision?: unknown;
  readonly ticketPresenceRevision?: unknown;
  readonly status?: unknown;
  readonly retryAfterSeconds?: unknown;
}

const METRICS = [
  'livePresence',
  'residentPresence',
  'nonOwnerPresence',
  'storedSessions',
  'maxPeerOrdinal',
  'sessionReceipts',
  'affectedCount',
  'socketCount',
  'authorityTargetCount',
  'authorityPresenceRevision',
  'ticketPresenceRevision',
] as const;
type Metrics = Partial<Record<(typeof METRICS)[number], number | null>>;

function property(value: unknown, key: string): unknown {
  try {
    return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  } catch {
    return undefined;
  }
}

function boundedInteger(value: unknown, maximum = MAX_COUNT): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function contextFields(context: unknown) {
  const scope = property(context, 'scope');
  const code = property(context, 'roomCode');
  const version = property(context, 'versionId');
  return {
    scope:
      scope === 'room' || scope === 'front' || scope === 'app' || scope === 'signaling'
        ? scope
        : 'unknown',
    roomCode: typeof code === 'string' && /^\d{6}$/.test(code) ? code : null,
    roomGeneration: boundedInteger(property(context, 'roomGeneration'), Number.MAX_SAFE_INTEGER),
    versionId:
      typeof version === 'string' &&
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(version)
        ? version
        : null,
  };
}

function metricFields(detail: unknown): Metrics {
  const result: Metrics = {};
  for (const key of METRICS) {
    const value = property(detail, key);
    // Missing is different from supplied-but-invalid. Never coerce objects,
    // numeric strings, NaN, or negative counts into plausible measurements.
    if (value !== undefined) {
      result[key] = boundedInteger(
        value,
        key === 'authorityPresenceRevision' || key === 'ticketPresenceRevision'
          ? Number.MAX_SAFE_INTEGER
          : MAX_COUNT,
      );
    }
  }
  return result;
}

function emit(record: Record<string, unknown>): void {
  try {
    console.log({ diagnostic: 'pro_room', schema: 1, ...record });
  } catch {
    // Logging must never change admission, cleanup, or the original failure.
  }
}

/** Create one instance per room object; do not reuse it across room identities. */
export class ProRoomDiagnostics {
  private summaryStartMs: number | null = null;
  private lastSummaryMs: number | null = null;
  private detailStartMs: number | null = null;
  private counts: Record<string, number> = {};
  private affectedCounts: Record<string, number> = {};
  private readonly seenFailures = new Set<string>();
  private repeatedDetails = 0;
  private suppressedDetails = 0;
  private peakPresence: number | null = null;
  private latest: Metrics = {};

  constructor(private readonly getContext: () => ProRoomDiagnosticContext) {}

  record(
    event: ProRoomDiagnosticEvent,
    detail: ProRoomDiagnosticDetail = {},
    eventContext?: ProRoomDiagnosticContext,
  ): void {
    try {
      if (typeof event !== 'string' || !Object.hasOwn(EVENT_REASONS, event)) return;
      const nowMs = Date.now();
      this.flushIfDue();
      this.summaryStartMs ??= nowMs;
      if (this.detailStartMs === null || nowMs - this.detailStartMs >= WINDOW_MS) {
        this.detailStartMs = nowMs;
        this.seenFailures.clear();
        this.repeatedDetails = 0;
      }
      const rawReason = property(detail, 'reason');
      const allowedReasons: readonly string[] = EVENT_REASONS[event];
      const reason =
        typeof rawReason === 'string' && allowedReasons.includes(rawReason) ? rawReason : null;
      const key = reason === null ? event : `${event}:${reason}`;
      this.counts[key] = Math.min(MAX_COUNT, (this.counts[key] ?? 0) + 1);
      const metrics = metricFields(detail);
      if (typeof metrics.affectedCount === 'number') {
        this.affectedCounts[key] = Math.min(
          MAX_COUNT,
          (this.affectedCounts[key] ?? 0) + metrics.affectedCount,
        );
      }
      this.latest = { ...this.latest, ...metrics };
      if (typeof metrics.livePresence === 'number') {
        this.peakPresence = Math.max(this.peakPresence ?? 0, metrics.livePresence);
      }
      if (!FAILURES.has(event)) return;
      const first = !this.seenFailures.has(key);
      if (!first && this.repeatedDetails >= REPEATED_DETAILS_PER_WINDOW) {
        this.suppressedDetails = Math.min(MAX_COUNT, this.suppressedDetails + 1);
        return;
      }
      this.seenFailures.add(key);
      if (!first) this.repeatedDetails += 1;
      const operation = property(detail, 'operation');
      const status = boundedInteger(property(detail, 'status'), 599);
      emit({
        kind: 'event',
        ...contextFields(eventContext ?? this.getContext()),
        observedAtMs: nowMs,
        event,
        reason,
        operation:
          typeof operation === 'string' && (OPERATIONS as readonly string[]).includes(operation)
            ? operation
            : null,
        ...metrics,
        status: status !== null && status >= 100 ? status : null,
        retryAfterSeconds: boundedInteger(property(detail, 'retryAfterSeconds'), 86_400),
      });
    } catch {
      // Providers/getters may fail during partial initialization or cleanup.
    }
  }

  /** Call from existing traffic/alarms. Quiet rooms create no diagnostic timer. */
  flushIfDue(): void {
    try {
      if (this.summaryStartMs !== null && Date.now() - this.summaryStartMs >= WINDOW_MS) {
        this.flush('interval');
      }
    } catch {
      // A diagnostic flush is never a reason to fail a request or alarm.
    }
  }

  /** Early final-state flushes share the one-summary-per-minute budget. */
  flush(trigger: 'sleep' | 'close' | 'interval'): void {
    try {
      if (trigger !== 'sleep' && trigger !== 'close' && trigger !== 'interval') return;
      const nowMs = Date.now();
      if (
        this.summaryStartMs === null ||
        Object.keys(this.counts).length === 0 ||
        (this.lastSummaryMs !== null && nowMs - this.lastSummaryMs < WINDOW_MS)
      ) {
        return;
      }
      emit({
        kind: 'summary',
        ...contextFields(this.getContext()),
        windowStartMs: this.summaryStartMs,
        windowEndMs: nowMs,
        trigger,
        counts: this.counts,
        ...(Object.keys(this.affectedCounts).length > 0
          ? { affectedCounts: this.affectedCounts }
          : {}),
        suppressedDetails: this.suppressedDetails,
        peakPresence: this.peakPresence,
        latest: this.latest,
      });
      this.lastSummaryMs = nowMs;
      this.summaryStartMs = null;
      this.counts = {};
      this.affectedCounts = {};
      this.suppressedDetails = 0;
      this.peakPresence = null;
      this.latest = {};
      // Do not reset detail slots here: repeated close/sleep churn must not
      // bypass the detail budget by triggering early summary flushes.
    } catch {
      // No caller depends on diagnostic delivery.
    }
  }
}

// Exactly two reporters per isolate, never a map keyed by room, URL, or user.
// Detailed failures retain room context; facade summaries intentionally combine
// rooms and use null room fields. They are not room-specific failure totals.
let frontVersionId: unknown;
let appVersionId: unknown;
const frontDiagnostics = new ProRoomDiagnostics(() => ({
  scope: 'front',
  versionId: frontVersionId,
}));
const appDiagnostics = new ProRoomDiagnostics(() => ({ scope: 'app', versionId: appVersionId }));

export function reportProRoomFrontDiagnostic(
  context: ProRoomDiagnosticContext,
  event: ProRoomDiagnosticEvent,
  detail: ProRoomDiagnosticDetail = {},
): void {
  try {
    if (!FAILURES.has(event)) return;
    const scope = property(context, 'scope');
    if (scope === 'front') {
      frontVersionId = contextFields(context).versionId;
      frontDiagnostics.record(event, detail, context);
    } else if (scope === 'app') {
      appVersionId = contextFields(context).versionId;
      appDiagnostics.record(event, detail, context);
    }
  } catch {
    // Preserve the facade's response even if observability is unavailable.
  }
}

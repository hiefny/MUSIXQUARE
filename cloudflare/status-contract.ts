/**
 * Public status page contract (musixquare.com/status, train 9.0.845).
 *
 * The single home of the status routes, the identity of the GitHub browser
 * monitor, the check schedule, the result policy and the check budgets. It is
 * the timing home of registry record RO-57 (the public status check ledger):
 * the App Worker's status modules, the browser monitor and their tests import
 * these values and never retype them. The internal signaling bridge's call and
 * poll timeouts stay in cloudflare/app-worker.ts, and the claim and probe-room
 * lifetimes in cloudflare/signaling-worker.ts, beside the code they bound.
 *
 * Copies that cannot import this file are pinned to it by
 * src/core/__tests__/status-policy-parity.test.ts: the server cron in
 * cloudflare/wrangler.app.toml, the workflow cron and timeout in
 * .github/workflows/status-monitor.yml, browser/classic-runtime/status-page.ts,
 * .workshop/status/status.html, the fixtures in e2e/fixtures/status/ and the
 * claim path that cloudflare/signaling-worker.ts declares.
 *
 * Cloudflare documents a 15-minute wall-clock limit for Cron Trigger
 * invocations and a 30-second default CPU limit for schedules whose interval
 * is under one hour (developers.cloudflare.com/workers/platform/limits, read
 * 2026-11-26). The rooms check is I/O-bound, waiting on the internal
 * signaling bridge, so its 60-second deadline fits.
 *
 * This leaf has no imports and uses only erasable TypeScript, because Node
 * runs scripts that import it by stripping the types alone.
 */

/** Version of the GET /api/status body; the page and the browser monitor refuse any other. */
export const STATUS_SCHEMA_VERSION = 1;

/** App Worker route of the public status JSON the /status page polls. */
export const STATUS_PUBLIC_PATH = '/api/status';

/** App Worker route where the browser monitor reports its website and connection results. */
export const STATUS_REPORT_PATH = '/api/ops/status-report';

/** App Worker route where the browser monitor claims a room code before its host connects. */
export const STATUS_CLAIM_PATH = '/api/ops/status-claim';

/** The only GitHub Actions OIDC audience the report route accepts. */
export const STATUS_REPORT_AUDIENCE = `https://musixquare.com${STATUS_REPORT_PATH}`;

/** The only GitHub Actions OIDC audience the claim route accepts. */
export const STATUS_CLAIM_AUDIENCE = `https://musixquare.com${STATUS_CLAIM_PATH}`;

/** The only workflow whose job may call the report and claim routes, and only from main. */
export const STATUS_MONITOR_WORKFLOW_REF =
  'hiefny/MUSIXQUARE/.github/workflows/status-monitor.yml@refs/heads/main';

/** Rows of the page and of the ledger, in page order. */
export const STATUS_COMPONENT_IDS = Object.freeze([
  'website',
  'rooms',
  'connection',
  'pro',
] as const);

export type StatusComponentId = (typeof STATUS_COMPONENT_IDS)[number];

/** `server`: the App Worker cron checks a row; `browser`: the GitHub browser monitor does. */
export type StatusSchedule = 'server' | 'browser';

/** The schedule that checks each row, which also sets the row's slot boundaries. */
export const STATUS_COMPONENT_SCHEDULE = Object.freeze({
  website: 'browser',
  rooms: 'server',
  connection: 'browser',
  pro: 'server',
} as const satisfies Record<StatusComponentId, StatusSchedule>);

/** Minutes between two checks of one row, on both schedules. */
export const STATUS_CHECK_INTERVAL_MINUTES = 15;

/** Minutes past each UTC hour of the server checks (rooms and pro). */
export const STATUS_SERVER_CHECK_MINUTES = Object.freeze([0, 15, 30, 45] as const);

/** Minutes past each UTC hour of the browser checks (website and connection). */
export const STATUS_BROWSER_CHECK_MINUTES = Object.freeze([7, 22, 37, 52] as const);

/** The App Worker cron trigger of the server checks; scheduled() matches this exact string. */
export const STATUS_SERVER_CRON = '0,15,30,45 * * * *';

/** The browser monitor workflow's schedule. GitHub may start a run late or drop it. */
export const STATUS_BROWSER_CRON = '7,22,37,52 * * * *';

/**
 * A row shows a problem once this many of its newest checks that passed or
 * failed (o or p) all failed. Missed slots (n) and maintenance marks (m) are
 * skipped, so they neither break nor extend a run of failures.
 */
export const STATUS_PROBLEM_AFTER_FAILURES = 2;

/** A row reads "Not checked" once its newest check that passed or failed is older than this. */
export const STATUS_STALE_AFTER_MINUTES = 30;

/** Marks per row in /api/status: 96 slots of 15 minutes are the last 24 hours. */
export const STATUS_RECENT_SLOTS = 96;

/** How long the ledger keeps a result (48 hours); every server check run prunes older rows. */
export const STATUS_RESULT_RETENTION_MS = 48 * 60 * 60_000;

/** Made-up path of the /api/status edge-cache key; no route serves it. */
export const STATUS_EDGE_CACHE_KEY_PATH = '/.well-known/mxqr-cache/status/v1';

/** Edge-cache lifetime of a /api/status body whose results and note were both read, in seconds. */
export const STATUS_EDGE_CACHE_TTL_S = 30;

/**
 * Oldest report the report route accepts, by the run's startedAt. It is above
 * the job timeout, so a run that uses its whole budget still reports.
 */
export const STATUS_REPORT_MAX_AGE_MS = 20 * 60_000;

/** How far a report's startedAt may run ahead of the App Worker's clock. */
export const STATUS_REPORT_MAX_FUTURE_SKEW_MS = 2 * 60_000;

/** Largest report body, in bytes. */
export const STATUS_REPORT_BODY_MAX_BYTES = 4_096;

/** Requests each ops route (report and claim) accepts per rate window. */
export const STATUS_OPS_RATE_LIMIT = 60;

/** Length of the ops routes' rate window, in seconds. */
export const STATUS_OPS_RATE_WINDOW_SECONDS = 600;

/**
 * A result reason: 1 to 48 lowercase letters, digits or underscores, such as
 * `passing`, `maintenance` or `pro_http_503`. Test values with isStatusReason,
 * which also refuses anything that is not a string.
 */
export const STATUS_REASON_RE = /^[a-z0-9_]{1,48}$/u;

/**
 * The built-in PRO canary room that the pro check reads: a read-only
 * bootstrap of a room without an owner.
 */
export const STATUS_PRO_PROBE_ROOM_CODE = '000000';

/**
 * Route on the signaling room object that marks the next new room on its code
 * as a status probe, whose events stay out of the public room count. Only a
 * Durable Object binding reaches it: public signaling hosts answer 404 for
 * every /internal/ path.
 */
export const STATUS_PROBE_CLAIM_INTERNAL_PATH = '/internal/status-probe/v1/claim';

/**
 * Most random room codes the rooms check tries in one run; it moves on to
 * another code when one is busy or taken.
 */
export const STATUS_ROOMS_CODE_ATTEMPTS = 3;

/** Overall deadline of the rooms check in one cron run. */
export const STATUS_ROOMS_CHECK_DEADLINE_MS = 60_000;

/** Longest wait for one expected signaling frame in the rooms check. */
export const STATUS_ROOMS_FRAME_WAIT_MS = 10_000;

/** The waitMs of one signaling bridge poll in the rooms check. */
export const STATUS_ROOMS_POLL_WAIT_MS = 1_500;

/**
 * Pause before the single retry of a server check, which follows only a
 * transport, 5xx or timeout failure and never a definite refusal.
 */
export const STATUS_CHECK_RETRY_DELAY_MS = 2_000;

/** Navigation timeout of the browser monitor's website check. */
export const STATUS_BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * Timeout of each later browser monitor step, such as the page turning ready
 * or a chat message arriving.
 */
export const STATUS_BROWSER_STEP_TIMEOUT_MS = 25_000;

/** Timeout of one claim request; the monitor holds its host's frames until the claim answers. */
export const STATUS_BROWSER_CLAIM_TIMEOUT_MS = 8_000;

/**
 * The browser monitor job's timeout-minutes, below the check interval so that
 * a run ends before the next one is due.
 */
export const STATUS_BROWSER_JOB_TIMEOUT_MINUTES = 10;

/** Attempts to deliver one report; only a 429, a 5xx or a network error is retried. */
export const STATUS_BROWSER_REPORT_ATTEMPTS = 3;

/**
 * A check result as the ledger stores it: `o` passed, `p` failed, `m` during
 * maintenance. A slot without a row reads as `n` (no check) and is never
 * stored.
 */
export type StatusStoredResult = 'o' | 'p' | 'm';

/** Writer of a ledger row: the App Worker cron or the browser monitor's report. */
export type StatusCheckSource = 'cron' | 'browser';

/** One row of the status check ledger: one per component and slot, where the newest check wins. */
export interface StatusCheckRow {
  readonly component: StatusComponentId;
  /** Epoch ms of the slot: statusSlotAt on the component's schedule. */
  readonly slotAt: number;
  readonly result: StatusStoredResult;
  /** A reason that isStatusReason accepts. */
  readonly reason: string;
  /** Epoch ms at which the check finished, by the App Worker's clock. */
  readonly checkedAt: number;
  readonly source: StatusCheckSource;
  /** The GitHub Actions run id of a browser report (1 to 32 characters); null for the cron. */
  readonly runId: string | null;
}

/**
 * How the signaling room object answered a status probe claim: `claimed`
 * (200), `room_active` (409, try another code), `unsupported` (404, a
 * signaling Worker without the route, so open no room), `maintenance` (503
 * SERVICE_MAINTENANCE), `control_unavailable` (503
 * SERVICE_MAINTENANCE_STATUS_UNAVAILABLE) or `failed` (any other answer, or
 * none).
 */
export type StatusProbeClaimOutcome =
  'claimed' | 'room_active' | 'unsupported' | 'maintenance' | 'control_unavailable' | 'failed';

/** The active status note as /api/status shows it in `announcement`. */
export interface StatusPublicNote {
  readonly id: string;
  readonly message: string;
  /** ISO time of the note's publication: the note record's updatedAt. */
  readonly postedAt: string;
  /** ISO expiry, or null for a note without one. */
  readonly expiresAt: string | null;
}

const MINUTE_MS = 60_000;
const STATUS_CHECK_INTERVAL_MS = STATUS_CHECK_INTERVAL_MINUTES * MINUTE_MS;

/** Whether a value is one of the four status rows. */
export function isStatusComponentId(value: unknown): value is StatusComponentId {
  return STATUS_COMPONENT_IDS.some((id) => id === value);
}

/** Whether a value is a string that STATUS_REASON_RE accepts. */
export function isStatusReason(value: unknown): value is string {
  return typeof value === 'string' && STATUS_REASON_RE.test(value);
}

/**
 * The slot a time belongs to: the latest boundary of the schedule at or before
 * nowMs, in epoch ms. A schedule's boundaries are its first minute past a UTC
 * hour plus whole check intervals. A time that is not finite has no slot
 * (NaN), so the alignment check `statusSlotAt(t, schedule) === t` refuses it.
 */
export function statusSlotAt(nowMs: number, schedule: StatusSchedule): number {
  if (!Number.isFinite(nowMs)) return Number.NaN;
  const firstMinute =
    schedule === 'browser' ? STATUS_BROWSER_CHECK_MINUTES[0] : STATUS_SERVER_CHECK_MINUTES[0];
  const offsetMs = firstMinute * MINUTE_MS;
  return (
    Math.floor((nowMs - offsetMs) / STATUS_CHECK_INTERVAL_MS) * STATUS_CHECK_INTERVAL_MS + offsetMs
  );
}

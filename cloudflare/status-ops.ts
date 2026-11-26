/**
 * GitHub Actions routes of the public status page (musixquare.com/status).
 *
 * The browser monitor, .github/workflows/status-monitor.yml, authenticates
 * with a GitHub Actions OIDC token instead of a stored secret:
 * - POST /api/ops/status-report records its website and connection results in
 *   the status check ledger of registry record RO-57, beside the App cron's
 *   rooms and pro results.
 * - POST /api/ops/status-claim asks the signaling room object of a code to
 *   mark the next new room there as a status probe before the monitor's host
 *   connects, so monitor rooms stay out of the public room count.
 *
 * Both routes keep the order of the App build floor setter: the method, the
 * abuse-rate limit before any token parse or key fetch, the bearer token and
 * its verification against a policy pinned to the monitor workflow on main,
 * and only then the JSON body. Nothing is recorded or claimed unless the token
 * verified, no error repeats the token or the body, and neither route answers
 * CORS. The App keeps the report route open during maintenance, when it records
 * maintenance marks; the claim route stays behind the maintenance gate.
 *
 * The App Worker passes its private helpers in as deps, so this module holds no
 * binding, timer or clock of its own. Paths, audiences, limits and the slot
 * rule come from status-contract.ts.
 */
import {
  GITHUB_ACTIONS_OIDC_TOKEN_MAX_BYTES,
  MUSIXQUARE_GITHUB_REPOSITORY,
  verifyGitHubActionsOidcToken,
  type GitHubActionsOidcPolicy,
} from './github-actions-oidc.ts';
import {
  STATUS_CLAIM_AUDIENCE,
  STATUS_COMPONENT_IDS,
  STATUS_COMPONENT_SCHEDULE,
  STATUS_MONITOR_WORKFLOW_REF,
  STATUS_OPS_RATE_LIMIT,
  STATUS_OPS_RATE_WINDOW_SECONDS,
  STATUS_REPORT_AUDIENCE,
  STATUS_REPORT_BODY_MAX_BYTES,
  STATUS_REPORT_MAX_AGE_MS,
  STATUS_REPORT_MAX_FUTURE_SKEW_MS,
  isStatusReason,
  statusSlotAt,
  type StatusCheckRow,
  type StatusComponentId,
  type StatusProbeClaimOutcome,
  type StatusSchedule,
  type StatusStoredResult,
} from './status-contract.ts';

/** Version of the report and claim bodies; any other is refused. */
export const STATUS_OPS_BODY_VERSION = 1;

/** What the browser monitor reports for one check. */
export const STATUS_REPORT_OUTCOMES = Object.freeze([
  'ok',
  'fail',
  'maintenance',
  'skipped',
] as const);

export type StatusReportOutcome = (typeof STATUS_REPORT_OUTCOMES)[number];

/** The browser monitor's schedule, which sets its rows and the slot of its report. */
const STATUS_REPORT_SCHEDULE: StatusSchedule = 'browser';

/** The rows a report carries, in page order: every row on the browser schedule. */
export const STATUS_REPORT_COMPONENTS: readonly StatusComponentId[] = Object.freeze(
  STATUS_COMPONENT_IDS.filter((id) => STATUS_COMPONENT_SCHEDULE[id] === STATUS_REPORT_SCHEDULE),
);

/** The ledger result of each outcome; a skipped check records no row, so its slot reads n. */
const STATUS_REPORT_RESULTS: Readonly<Record<StatusReportOutcome, StatusStoredResult | null>> =
  Object.freeze({ ok: 'o', fail: 'p', maintenance: 'm', skipped: null });

/** Reason of a row recorded while maintenance is active; the cron uses the same one. */
const STATUS_MAINTENANCE_REASON = 'maintenance';
const STATUS_REPORT_RATE_ENDPOINT = 'ops-status-report';
const STATUS_CLAIM_RATE_ENDPOINT = 'ops-status-claim';
const STANDARD_ROOM_ID_RE = /^[1-9]\d{5}$/u;
/** A GitHub run id as the ledger keeps it: decimal, 1 to 32 characters (run_id's CHECK). */
const GITHUB_RUN_ID_RE = /^\d{1,32}$/u;
const JSON_CONTENT_TYPE_RE = /^application\/json(?:\s*;|$)/u;
const BEARER_RE = /^Bearer ([^\s]+)$/u;

const STATUS_MONITOR_IDENTITY = {
  ...MUSIXQUARE_GITHUB_REPOSITORY,
  ref: 'refs/heads/main',
  // The job names no GitHub environment, which keeps production secrets out
  // of its reach; its token then carries no environment claim.
  environment: null,
  // The schedule, or a run started by hand.
  eventName: Object.freeze(['schedule', 'workflow_dispatch']),
  runnerEnvironment: 'github-hosted',
  // The monitor job runs its own steps; a token minted inside a reusable
  // workflow is refused.
  workflowRefs: Object.freeze([STATUS_MONITOR_WORKFLOW_REF]),
} as const;

/** The only identity the report route accepts: the monitor job on main, for the report audience. */
export const STATUS_REPORT_POLICY: GitHubActionsOidcPolicy = Object.freeze({
  ...STATUS_MONITOR_IDENTITY,
  audience: STATUS_REPORT_AUDIENCE,
});

/** The only identity the claim route accepts: the same job, for the claim audience. */
export const STATUS_CLAIM_POLICY: GitHubActionsOidcPolicy = Object.freeze({
  ...STATUS_MONITOR_IDENTITY,
  audience: STATUS_CLAIM_AUDIENCE,
});

/**
 * The App's abuse-rate answer. Only `status: 'ok'` with `allowed: true` lets a
 * request through; any other status means the limiter is unavailable.
 */
export interface StatusOpsRateLimit {
  readonly status: string;
  readonly allowed?: boolean;
  readonly retryAfterSeconds?: number;
}

/** The App's bounded JSON body read: the parsed value, or why the body was refused. */
export type StatusOpsJsonBody =
  | { readonly value: unknown; readonly error?: undefined }
  | {
      readonly error: 'invalid' | 'too-large' | 'timeout' | 'aborted';
      readonly value?: undefined;
    };

/** The service maintenance state. Maintenance is active while enabled and readable. */
export interface StatusOpsMaintenance {
  readonly enabled: boolean;
  readonly controlUnavailable?: boolean;
}

/** App Worker helpers that both routes use. */
export interface StatusOpsDeps {
  /** A no-store JSON response with the App's security headers. */
  readonly json: (body: unknown, status?: number, headers?: Record<string, string>) => Response;
  /** The App's checkPaidRateLimit, bound to its environment. */
  readonly checkPaidRateLimit: (
    request: Request,
    endpoint: string,
    limit: number,
    windowSec: number,
  ) => Promise<StatusOpsRateLimit>;
  /** The 429, with Retry-After. */
  readonly rateLimitResponse: (retryAfterSeconds: number | undefined) => Response;
  /** The 503 RATE_LIMIT_UNAVAILABLE. */
  readonly rateLimitUnavailableResponse: () => Response;
  readonly readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<StatusOpsJsonBody>;
  /** The 400, 408 or 413 for a body the read refused. */
  readonly jsonBodyError: (result: StatusOpsJsonBody) => Response;
  /** The App Worker's clock, in epoch ms. */
  readonly nowMs: () => number;
}

export interface StatusReportDeps extends StatusOpsDeps {
  /** readServiceMaintenance: the route is on the maintenance bypass, so it reads the state itself. */
  readonly readMaintenance: () => Promise<StatusOpsMaintenance>;
  /** Writes rows to the ledger (status-store.ts). It must reject on any failure. */
  readonly record: (rows: readonly StatusCheckRow[]) => Promise<unknown>;
}

export interface StatusClaimDeps extends StatusOpsDeps {
  /** Claims the code on its signaling room object (status-probe-claim.ts). */
  readonly claim: (roomId: string) => Promise<StatusProbeClaimOutcome>;
}

type Refusal = { readonly ok: false; readonly response: Response };

interface StatusReportResult {
  readonly component: StatusComponentId;
  readonly outcome: StatusReportOutcome;
  readonly reason: string;
}

interface StatusReport {
  readonly startedAtMs: number;
  readonly results: readonly StatusReportResult[];
}

function refuse(response: Response): Refusal {
  return { ok: false, response };
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isStatusReportOutcome(value: unknown): value is StatusReportOutcome {
  return STATUS_REPORT_OUTCOMES.some((outcome) => outcome === value);
}

/** Epoch ms of an ISO time written exactly as toISOString writes it, or null. */
function isoTimeMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

/**
 * The method, the abuse-rate limit, then the token. A limited caller costs no
 * token parse and no key fetch.
 */
async function admitStatusOpsRequest(
  request: Request,
  deps: StatusOpsDeps,
  endpoint: string,
  policy: GitHubActionsOidcPolicy,
): Promise<{ readonly ok: true; readonly runId: string | null } | Refusal> {
  if (request.method !== 'POST') {
    return refuse(deps.json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'POST' }));
  }
  const rate = await deps.checkPaidRateLimit(
    request,
    endpoint,
    STATUS_OPS_RATE_LIMIT,
    STATUS_OPS_RATE_WINDOW_SECONDS,
  );
  if (rate.status !== 'ok') return refuse(deps.rateLimitUnavailableResponse());
  if (rate.allowed !== true) return refuse(deps.rateLimitResponse(rate.retryAfterSeconds));

  const token = BEARER_RE.exec(request.headers.get('Authorization') || '')?.[1] ?? '';
  if (!token || token.length > GITHUB_ACTIONS_OIDC_TOKEN_MAX_BYTES) {
    return refuse(deps.json({ error: 'OIDC_TOKEN_INVALID' }, 401));
  }
  const verified = await verifyGitHubActionsOidcToken(token, policy, deps.nowMs());
  if (!verified.ok) return refuse(deps.json({ error: verified.error }, verified.status));
  return { ok: true, runId: verified.runId };
}

/** The JSON body, after the content type; read only once the token verified. */
async function readStatusOpsBody(
  request: Request,
  deps: StatusOpsDeps,
): Promise<{ readonly ok: true; readonly value: unknown } | Refusal> {
  const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
  if (!JSON_CONTENT_TYPE_RE.test(contentType)) {
    return refuse(deps.json({ error: 'JSON_REQUIRED' }, 415));
  }
  const body = await deps.readJsonBodyLimited(request, STATUS_REPORT_BODY_MAX_BYTES);
  if (body.error !== undefined) return refuse(deps.jsonBodyError(body));
  return { ok: true, value: body.value };
}

/**
 * Exactly {v: 1, startedAt, results: {website: {outcome, reason}, connection:
 * {outcome, reason}}}, where startedAt is an ISO time in toISOString's form.
 */
function parseStatusReport(value: unknown): StatusReport | null {
  if (!hasExactKeys(value, ['v', 'startedAt', 'results']) || value.v !== STATUS_OPS_BODY_VERSION) {
    return null;
  }
  const startedAtMs = isoTimeMs(value.startedAt);
  const reported = value.results;
  if (startedAtMs === null || !hasExactKeys(reported, STATUS_REPORT_COMPONENTS)) return null;
  const results: StatusReportResult[] = [];
  for (const component of STATUS_REPORT_COMPONENTS) {
    const result = reported[component];
    if (
      !hasExactKeys(result, ['outcome', 'reason']) ||
      !isStatusReportOutcome(result.outcome) ||
      !isStatusReason(result.reason)
    ) {
      return null;
    }
    results.push({ component, outcome: result.outcome, reason: result.reason });
  }
  return { startedAtMs, results };
}

/** Exactly {v: 1, roomId}, where roomId is a Standard room code. */
function parseStatusClaim(value: unknown): string | null {
  if (!hasExactKeys(value, ['v', 'roomId']) || value.v !== STATUS_OPS_BODY_VERSION) return null;
  const roomId = value.roomId;
  return typeof roomId === 'string' && STANDARD_ROOM_ID_RE.test(roomId) ? roomId : null;
}

/**
 * Whether maintenance is active: enabled, and not the control-plane outage the
 * read reports as enabled but unavailable. An outage, or a read that failed, is
 * not maintenance, so the monitor's results stand, as the cron's do.
 */
async function maintenanceActive(deps: StatusReportDeps): Promise<boolean> {
  try {
    const state = await deps.readMaintenance();
    return state.enabled && state.controlUnavailable !== true;
  } catch {
    return false;
  }
}

/**
 * POST /api/ops/status-report. The rows go to the slot the run started in: the
 * latest browser boundary at or before startedAt, so a run that GitHub starts
 * late is recorded where it ran. While maintenance is active both rows are
 * maintenance marks; otherwise ok, fail and maintenance record o, p and m, and
 * skipped records nothing. checkedAt is the App Worker's clock, and the runId
 * comes from the verified token.
 */
export async function handleStatusReport(
  request: Request,
  deps: StatusReportDeps,
): Promise<Response> {
  const admission = await admitStatusOpsRequest(
    request,
    deps,
    STATUS_REPORT_RATE_ENDPOINT,
    STATUS_REPORT_POLICY,
  );
  if (!admission.ok) return admission.response;
  const body = await readStatusOpsBody(request, deps);
  if (!body.ok) return body.response;
  const report = parseStatusReport(body.value);
  if (!report) return deps.json({ error: 'INVALID_REQUEST' }, 400);
  const nowMs = deps.nowMs();
  if (
    report.startedAtMs < nowMs - STATUS_REPORT_MAX_AGE_MS ||
    report.startedAtMs > nowMs + STATUS_REPORT_MAX_FUTURE_SKEW_MS
  ) {
    return deps.json({ error: 'REPORT_OUT_OF_WINDOW' }, 400);
  }

  const maintenance = await maintenanceActive(deps);
  const slotAt = statusSlotAt(report.startedAtMs, STATUS_REPORT_SCHEDULE);
  const runId =
    admission.runId !== null && GITHUB_RUN_ID_RE.test(admission.runId) ? admission.runId : null;
  const rows: StatusCheckRow[] = [];
  const recorded: Partial<Record<StatusComponentId, StatusStoredResult | null>> = {};
  for (const { component, outcome, reason } of report.results) {
    const result = maintenance ? 'm' : STATUS_REPORT_RESULTS[outcome];
    recorded[component] = result;
    if (result === null) continue;
    rows.push({
      component,
      slotAt,
      result,
      reason: maintenance ? STATUS_MAINTENANCE_REASON : reason,
      checkedAt: nowMs,
      source: 'browser',
      runId,
    });
  }
  if (rows.length > 0) {
    try {
      await deps.record(rows);
    } catch {
      return deps.json({ error: 'STATUS_STORE_UNAVAILABLE' }, 503);
    }
  }
  return deps.json({ ok: true, slotAt: new Date(slotAt).toISOString(), recorded });
}

/**
 * POST /api/ops/status-claim. 200 once the room object stored the claim; 409
 * ROOM_ACTIVE whenever the room object refused that code (in use, quarantined
 * or bound to another code), so the monitor tries another; 424
 * STATUS_PROBE_UNSUPPORTED from a signaling Worker without the claim route, so
 * the monitor opens no room; 503 STATUS_PROBE_UNAVAILABLE for anything else.
 */
export async function handleStatusClaim(
  request: Request,
  deps: StatusClaimDeps,
): Promise<Response> {
  const admission = await admitStatusOpsRequest(
    request,
    deps,
    STATUS_CLAIM_RATE_ENDPOINT,
    STATUS_CLAIM_POLICY,
  );
  if (!admission.ok) return admission.response;
  const body = await readStatusOpsBody(request, deps);
  if (!body.ok) return body.response;
  const roomId = parseStatusClaim(body.value);
  if (roomId === null) return deps.json({ error: 'INVALID_REQUEST' }, 400);

  let outcome: StatusProbeClaimOutcome;
  try {
    outcome = await deps.claim(roomId);
  } catch {
    outcome = 'failed';
  }
  if (outcome === 'claimed') return deps.json({ ok: true });
  if (outcome === 'room_active') return deps.json({ error: 'ROOM_ACTIVE' }, 409);
  if (outcome === 'unsupported') return deps.json({ error: 'STATUS_PROBE_UNSUPPORTED' }, 424);
  return deps.json({ error: 'STATUS_PROBE_UNAVAILABLE' }, 503);
}

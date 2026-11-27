/**
 * Starter of the browser checks of the public status page
 * (musixquare.com/status, train 9.0.846; registry record RO-57).
 *
 * GitHub delivers the schedule events of .github/workflows/status-monitor.yml
 * hours late for this repository, while the App Worker's crons run on time.
 * At each browser check minute (STATUS_BROWSER_CHECK_MINUTES) the App's
 * minute cron therefore asks GitHub to start that workflow on main through
 * the REST API's workflow dispatch, and the workflow's own schedule only
 * backs this up. A dispatched run starts within seconds, and its OIDC token
 * carries the event workflow_dispatch, which the report and claim routes
 * accept from main.
 *
 * The module is pure: the App Worker passes the token, fetch, the timers and
 * the warning sink in, as scheduled() does for the server checks. One call
 * sends at most one request and never retries it; the next browser check
 * minute is the retry. The request is bounded by STATUS_DISPATCH_TIMEOUT_MS
 * and its timer is cleared on every path. A redirect is not followed, so the
 * token goes to api.github.com only, and no answer is read beyond its status
 * and two rate-limit headers. A call never rejects. Each call that did not
 * dispatch gives one warning with its outcome and GitHub's HTTP status only:
 * never the token, a header or a body.
 */

import { MUSIXQUARE_GITHUB_REPOSITORY } from './github-actions-oidc.ts';
import {
  STATUS_BROWSER_CHECK_MINUTES,
  STATUS_DISPATCH_TIMEOUT_MS,
  STATUS_MONITOR_BRANCH,
  STATUS_MONITOR_WORKFLOW_FILE,
} from './status-contract.ts';

/**
 * Why a dispatch did not start the monitor:
 * - `unconfigured`: no usable MXQR_STATUS_MONITOR_DISPATCH_TOKEN, so no
 *   request was sent;
 * - `unauthorized` (401): the token is wrong, expired or revoked;
 * - `forbidden` (403 without rate-limit headers): the token lacks Actions
 *   write on this repository;
 * - `not_found` (404): the token cannot see this repository, or the workflow
 *   file is gone;
 * - `unprocessable` (422): the workflow is disabled or lacks
 *   workflow_dispatch, or the branch is missing;
 * - `rate_limited` (429, or 403 with `x-ratelimit-remaining: 0` or a
 *   `retry-after` header);
 * - `failed`: a 5xx, no answer, or none within STATUS_DISPATCH_TIMEOUT_MS;
 * - `unexpected`: any other answer, a redirect included.
 *
 * cloudflare/admin-dashboard-ops.md explains each one to the operator.
 */
export const STATUS_DISPATCH_FAILURES = Object.freeze([
  'unconfigured',
  'unauthorized',
  'forbidden',
  'not_found',
  'unprocessable',
  'rate_limited',
  'failed',
  'unexpected',
] as const);

export type StatusDispatchFailure = (typeof STATUS_DISPATCH_FAILURES)[number];

/** A warning's only fields: never the token, a header or a body. */
export interface StatusDispatchWarnFields {
  readonly outcome: StatusDispatchFailure;
  /** GitHub's HTTP status; absent when no request was sent or no answer arrived. */
  readonly httpStatus?: number;
}

/** What one dispatch came to. GitHub accepts with 204, or 200 with the run's details. */
export type StatusDispatchResult =
  { readonly outcome: 'dispatched'; readonly httpStatus: number } | StatusDispatchWarnFields;

/** The request this module sends; the App passes it to fetch unchanged. */
export interface StatusDispatchRequest {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: 'manual';
  readonly signal: AbortSignal;
}

/** The parts of GitHub's answer a dispatch uses: the status, headers, and the body to let go. */
export interface StatusDispatchAnswer {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: { cancel(reason?: unknown): Promise<unknown> } | null;
}

export interface StatusDispatchDeps<Timer> {
  /** The Worker secret MXQR_STATUS_MONITOR_DISPATCH_TOKEN as the env holds it, set or not. */
  readonly token: unknown;
  fetch(url: string, init: StatusDispatchRequest): Promise<StatusDispatchAnswer>;
  /** setTimeout: a dispatch arms one timer, for STATUS_DISPATCH_TIMEOUT_MS. */
  setTimer(callback: () => void, ms: number): Timer;
  /** clearTimeout, which a dispatch calls for its timer on every path. */
  clearTimer(timer: Timer): void;
  warn(fields: StatusDispatchWarnFields): void;
}

const STATUS_DISPATCH_URL =
  `https://api.github.com/repos/${MUSIXQUARE_GITHUB_REPOSITORY.repository}` +
  `/actions/workflows/${STATUS_MONITOR_WORKFLOW_FILE}/dispatches`;

/** Run the workflow on its branch, without inputs. */
const STATUS_DISPATCH_BODY = JSON.stringify({ ref: STATUS_MONITOR_BRANCH });

/** GitHub requires a User-Agent; this one names the client and no person. */
const STATUS_DISPATCH_USER_AGENT = 'MUSIXQUARE-status-dispatcher';

/** A token as GitHub issues them: printable ASCII without spaces (github_pat_..., ghp_...). */
const TOKEN_RE = /^[\x21-\x7e]{1,1024}$/u;

const NO_ANSWER = Symbol('status-dispatch-no-answer');
const TIMED_OUT = Symbol('status-dispatch-timed-out');

/**
 * Whether a cron event's scheduledTime falls in a browser check minute
 * (STATUS_BROWSER_CHECK_MINUTES, UTC). Anything but a finite number never
 * does.
 */
export function isStatusDispatchMinute(scheduledTime: unknown): boolean {
  if (typeof scheduledTime !== 'number' || !Number.isFinite(scheduledTime)) return false;
  const minute = new Date(scheduledTime).getUTCMinutes();
  return STATUS_BROWSER_CHECK_MINUTES.some((checkMinute) => checkMinute === minute);
}

function usableToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return TOKEN_RE.test(token) ? token : null;
}

function isRateLimited(answer: StatusDispatchAnswer): boolean {
  return (
    answer.headers.get('x-ratelimit-remaining')?.trim() === '0' ||
    answer.headers.get('retry-after') !== null
  );
}

function failureOf(answer: StatusDispatchAnswer): StatusDispatchFailure {
  switch (answer.status) {
    case 401:
      return 'unauthorized';
    case 403:
      return isRateLimited(answer) ? 'rate_limited' : 'forbidden';
    case 404:
      return 'not_found';
    case 422:
      return 'unprocessable';
    case 429:
      return 'rate_limited';
    default:
      return answer.status >= 500 ? 'failed' : 'unexpected';
  }
}

function classify(answer: StatusDispatchAnswer): StatusDispatchResult {
  const { status } = answer;
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    return { outcome: 'unexpected' };
  }
  if (status === 200 || status === 204) return { outcome: 'dispatched', httpStatus: status };
  return { outcome: failureOf(answer), httpStatus: status };
}

/** No body is read: let the connection go at once. Best effort. */
function discardBody(answer: StatusDispatchAnswer): void {
  try {
    Promise.resolve(answer.body?.cancel()).catch(() => undefined);
  } catch {
    // A body that cannot be cancelled is left to the runtime.
  }
}

/** The one bounded request. Its timer is cleared on every path. */
async function sendDispatch<Timer>(
  deps: StatusDispatchDeps<Timer>,
  token: string,
): Promise<StatusDispatchResult> {
  const controller = new AbortController();
  let expire!: () => void;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    expire = () => resolve(TIMED_OUT);
  });
  const timer = deps.setTimer(() => {
    expire();
    controller.abort();
  }, STATUS_DISPATCH_TIMEOUT_MS);
  try {
    const request = Promise.resolve().then(() =>
      deps.fetch(STATUS_DISPATCH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': STATUS_DISPATCH_USER_AGENT,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: STATUS_DISPATCH_BODY,
        redirect: 'manual',
        signal: controller.signal,
      }),
    );
    const settled = await Promise.race([
      request.then(
        (answer) => answer,
        (): typeof NO_ANSWER => NO_ANSWER,
      ),
      expired,
    ]);
    if (settled === TIMED_OUT) {
      // An answer that still comes after the bound is dropped unread.
      request.then(discardBody, () => undefined);
      return { outcome: 'failed' };
    }
    if (settled === NO_ANSWER) return { outcome: 'failed' };
    discardBody(settled);
    return classify(settled);
  } finally {
    try {
      deps.clearTimer(timer);
    } catch {
      // The runtime's timer bookkeeping never changes the outcome.
    }
  }
}

function warnQuietly<Timer>(
  deps: StatusDispatchDeps<Timer>,
  fields: StatusDispatchWarnFields,
): void {
  try {
    deps.warn(fields);
  } catch {
    // A diagnostic never changes the dispatch.
  }
}

/**
 * Asks GitHub once to start the browser monitor workflow on its branch. It
 * settles within STATUS_DISPATCH_TIMEOUT_MS of the request whatever GitHub or
 * the network does, never rejects, and warns once unless it dispatched.
 */
export async function dispatchStatusMonitor<Timer>(
  deps: StatusDispatchDeps<Timer>,
): Promise<StatusDispatchResult> {
  let result: StatusDispatchResult;
  try {
    const token = usableToken(deps.token);
    result = token === null ? { outcome: 'unconfigured' } : await sendDispatch(deps, token);
  } catch {
    // A dependency threw before any answer arrived: nothing was dispatched.
    result = { outcome: 'failed' };
  }
  if (result.outcome !== 'dispatched') warnQuietly(deps, result);
  return result;
}

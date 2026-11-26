/**
 * The pure half of the public status page's browser monitor (registry record
 * RO-57). scripts/status-browser-monitor.ts drives Chromium in the Status
 * monitor workflow; every decision it takes lives here, so that unit tests pin
 * it with fakes:
 *
 * - classifyStatusPreflight: the checks run only when GET /api/status answers
 *   schema 1, and report maintenance while it is on.
 * - mintOidcToken and createOidcTokenSource: GitHub Actions OIDC tokens for the
 *   report and claim routes, each masked in the job log before anything else.
 * - ClaimGate, routeMonitorWebSocket and routeMonitorRequest: no host transport
 *   reaches signaling before the claim route granted its room code, so the
 *   monitor's rooms stay out of the public room count. An unknown transport is
 *   aborted and the connection check is reported as skipped.
 * - buildStatusReport, connectionResult and postStatusReport: the exact report
 *   body and its bounded delivery.
 * - statusMonitorExitCode: when the GitHub job fails.
 * - sanitizeMonitorDiagnostic: what the public Actions log may show.
 *
 * The status checks' timing values come from cloudflare/status-contract.ts.
 * The few below bound only this monitor's own requests and waits, and stay
 * beside the code they bound.
 */

import { Buffer } from 'node:buffer';

import {
  STATUS_BROWSER_CLAIM_TIMEOUT_MS,
  STATUS_BROWSER_REPORT_ATTEMPTS,
  STATUS_CLAIM_PATH,
  STATUS_PUBLIC_PATH,
  STATUS_REPORT_PATH,
  STATUS_SCHEMA_VERSION,
  isStatusReason,
} from '../../cloudflare/status-contract.ts';

/** The live App: the status routes and the HTTP signaling bridge. */
export const STATUS_MONITOR_APP_ORIGIN = 'https://musixquare.com';

/** One status read, OIDC mint or report attempt; a claim has its own contract timeout. */
export const STATUS_MONITOR_REQUEST_TIMEOUT_MS = 10_000;

/** Pause before the next report attempt after a 429, a 5xx or no answer. */
export const STATUS_MONITOR_REPORT_RETRY_DELAY_MS = 2_000;

/**
 * Whole connection check, from the host's first click to the second chat
 * message (a passing one takes about 20 seconds). Its steps each wait up to
 * the contract's step timeout; this bound keeps the slowest run inside the
 * workflow's 4-minute run step with time to report.
 */
export const STATUS_MONITOR_CONNECTION_BUDGET_MS = 75_000;

/** How long a page may take to show its first-run dialog before the check goes on. */
export const STATUS_MONITOR_DIALOG_WAIT_MS = 2_000;

/** A cached OIDC token is minted again when it expires within this margin. */
export const STATUS_MONITOR_TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Page-side close code of a socket the gate refuses: "try again later", below
 * the 4000 range that signaling uses for room verdicts, so the App treats it as
 * a failed route and never as a verdict about the room.
 */
export const STATUS_MONITOR_REFUSED_CLOSE_CODE = 1013;

const RESPONSE_MAX_BYTES = 64 * 1024;
// The report and claim routes refuse a bearer token above 8 KiB.
const OIDC_TOKEN_MAX_BYTES = 8 * 1024;
const OIDC_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const STANDARD_ROOM_ID_RE = /^[1-9]\d{5}$/u;
const PEER_ID_RE = /^[A-Za-z0-9_-]{1,96}$/u;
const ROOM_SOCKET_PATH_RE = /^\/api\/rooms\/([1-9]\d{5})\/ws$/u;
const BRIDGE_PATH_PREFIX = '/api/standard-signaling/';
const BRIDGE_OPEN_PATH = '/api/standard-signaling/v1/bridge/open';
const BRIDGE_SESSION_PATHS: ReadonlySet<string> = new Set([
  '/api/standard-signaling/v1/bridge/send',
  '/api/standard-signaling/v1/bridge/poll',
  '/api/standard-signaling/v1/bridge/close',
]);

// ── Results and the report body ──────────────────────────────────────────

export type MonitorOutcome = 'ok' | 'fail' | 'maintenance' | 'skipped';

export interface MonitorResult {
  readonly outcome: MonitorOutcome;
  /** A reason that isStatusReason accepts. */
  readonly reason: string;
}

/** Every reason the monitor reports, besides page_http_<status>. */
export const MONITOR_REASONS = Object.freeze({
  passing: 'passing',
  maintenance: 'maintenance',
  edgeChallenge: 'edge_challenge',
  navigationFailed: 'navigation_failed',
  bootTimeout: 'boot_timeout',
  bootAborted: 'boot_aborted',
  startScreenMissing: 'start_screen_missing',
  websiteFailed: 'website_failed',
  claimUnavailable: 'claim_unavailable',
  hostStartFailed: 'host_start_failed',
  guestPageFailed: 'guest_page_failed',
  guestJoinFailed: 'guest_join_failed',
  dialogBlocked: 'dialog_blocked',
  chatToGuestFailed: 'chat_to_guest_failed',
  chatToHostFailed: 'chat_to_host_failed',
  connectionTimeout: 'connection_timeout',
} as const);

const MONITOR_OUTCOMES: ReadonlySet<string> = new Set(['ok', 'fail', 'maintenance', 'skipped']);

export const MONITOR_PASSING: MonitorResult = Object.freeze({
  outcome: 'ok',
  reason: MONITOR_REASONS.passing,
});

export const MONITOR_MAINTENANCE: MonitorResult = Object.freeze({
  outcome: 'maintenance',
  reason: MONITOR_REASONS.maintenance,
});

export function monitorFailure(reason: string): MonitorResult {
  return { outcome: 'fail', reason };
}

export function monitorSkipped(reason: string): MonitorResult {
  return { outcome: 'skipped', reason };
}

/** How the main document of a page load answered. */
export type DocumentVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'challenge' }
  | { readonly kind: 'http'; readonly reason: string };

/**
 * A Cloudflare challenge (cf-mitigated: challenge) is reported as skipped and
 * never solved; any other answer outside 2xx is a failed page load.
 */
export function classifyDocumentResponse(
  status: number,
  cfMitigated: string | null,
): DocumentVerdict {
  if (cfMitigated?.trim().toLowerCase() === 'challenge') return { kind: 'challenge' };
  if (status >= 200 && status <= 299) return { kind: 'ok' };
  return {
    kind: 'http',
    reason:
      Number.isSafeInteger(status) && status >= 100 && status <= 599
        ? `page_http_${status}`
        : MONITOR_REASONS.navigationFailed,
  };
}

/** The report body, exactly as POST /api/ops/status-report accepts it. */
export interface StatusReportBody {
  readonly v: 1;
  readonly startedAt: string;
  readonly results: {
    readonly website: MonitorResult;
    readonly connection: MonitorResult;
  };
}

function reportResult(result: MonitorResult, row: string): MonitorResult {
  if (!MONITOR_OUTCOMES.has(result.outcome) || !isStatusReason(result.reason)) {
    throw new Error(`The ${row} result is not a valid status report result.`);
  }
  return { outcome: result.outcome, reason: result.reason };
}

export function buildStatusReport(
  startedAtMs: number,
  website: MonitorResult,
  connection: MonitorResult,
): StatusReportBody {
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) {
    throw new Error('The report needs the run start time.');
  }
  return {
    v: 1,
    startedAt: new Date(startedAtMs).toISOString(),
    results: {
      website: reportResult(website, 'website'),
      connection: reportResult(connection, 'connection'),
    },
  };
}

// ── Requests ─────────────────────────────────────────────────────────────

export interface StatusMonitorDeps {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Writes one line to the job log. */
  readonly write: (line: string) => void;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface JsonAnswer {
  readonly status: number;
  readonly body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** One bounded request; null when it got no answer in time. */
async function requestJson(
  deps: StatusMonitorDeps,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<JsonAnswer | null> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await deps.fetch(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let body: unknown = null;
    if (bytes.byteLength <= RESPONSE_MAX_BYTES) {
      try {
        body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function errorCode(body: unknown): string {
  const code = isRecord(body) ? body.error : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : 'unknown';
}

/** An answer as one log fragment: the HTTP status and the error code, never the body. */
export function describeAnswer(answer: JsonAnswer | null): string {
  return answer === null ? 'no answer' : `HTTP ${answer.status} (${errorCode(answer.body)})`;
}

// ── Preflight ────────────────────────────────────────────────────────────

/**
 * `not-deployed`: GET /api/status did not answer 200 with schema 1 (production
 * before this train, a rollback without the routes, or no answer), so the job
 * opens no browser and ends successfully. `maintenance`: report both rows as
 * maintenance and open nothing. `run`: run the checks.
 */
export type StatusPreflight = 'not-deployed' | 'maintenance' | 'run';

export function classifyStatusPreflight(answer: JsonAnswer | null): StatusPreflight {
  if (
    answer?.status !== 200 ||
    !isRecord(answer.body) ||
    answer.body.schemaVersion !== STATUS_SCHEMA_VERSION
  ) {
    return 'not-deployed';
  }
  const maintenance = answer.body.maintenance;
  return isRecord(maintenance) && maintenance.active === true ? 'maintenance' : 'run';
}

export async function readStatusPreflight(
  deps: StatusMonitorDeps,
): Promise<{ readonly preflight: StatusPreflight; readonly answer: JsonAnswer | null }> {
  const answer = await requestJson(
    deps,
    `${STATUS_MONITOR_APP_ORIGIN}${STATUS_PUBLIC_PATH}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    STATUS_MONITOR_REQUEST_TIMEOUT_MS,
  );
  return { preflight: classifyStatusPreflight(answer), answer };
}

// ── GitHub Actions OIDC ──────────────────────────────────────────────────

/**
 * Mints a GitHub Actions OIDC token for one route's audience (the job needs
 * permissions id-token: write) and masks it before anything else is written,
 * so the public log can never show it.
 */
export async function mintOidcToken(audience: string, deps: StatusMonitorDeps): Promise<string> {
  const requestUrl = deps.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = deps.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const route = new URL(audience).pathname;
  if (!requestUrl || !requestToken) {
    throw new Error(
      `GitHub Actions OIDC is unavailable for ${route}; run the Status monitor workflow (id-token: write).`,
    );
  }
  let tokenUrl: URL;
  try {
    tokenUrl = new URL(requestUrl);
  } catch {
    throw new Error('GitHub Actions OIDC gave an invalid token request URL.');
  }
  tokenUrl.searchParams.set('audience', audience);
  const answer = await requestJson(
    deps,
    tokenUrl.toString(),
    {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${requestToken}` },
    },
    STATUS_MONITOR_REQUEST_TIMEOUT_MS,
  );
  const token = isRecord(answer?.body) ? answer.body.value : undefined;
  if (
    answer?.status !== 200 ||
    typeof token !== 'string' ||
    token.length > OIDC_TOKEN_MAX_BYTES ||
    !OIDC_TOKEN_RE.test(token)
  ) {
    throw new Error(
      `GitHub Actions OIDC did not issue a token for ${route} (${
        answer === null ? 'no answer' : `HTTP ${answer.status}`
      }).`,
    );
  }
  deps.write(`::add-mask::${token}`);
  return token;
}

/** The expiry in the token's payload, or null when it cannot be read. */
function oidcTokenExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as unknown;
    const exp = isRecord(payload) ? payload.exp : undefined;
    return typeof exp === 'number' && Number.isSafeInteger(exp) ? exp * 1_000 : null;
  } catch {
    return null;
  }
}

export interface OidcTokenSource {
  /** A token with more than the refresh margin left, minted (and masked) when needed. */
  get(): Promise<string>;
}

/**
 * One audience's token, minted on the first get() and minted again once it
 * expires within the refresh margin (or at every get() when its expiry cannot
 * be read), so a slow run never reports with an expired token.
 */
export function createOidcTokenSource(audience: string, deps: StatusMonitorDeps): OidcTokenSource {
  let cached: { readonly token: string; readonly expiresAtMs: number | null } | null = null;
  let minting: Promise<string> | null = null;
  return {
    get(): Promise<string> {
      if (
        cached &&
        cached.expiresAtMs !== null &&
        cached.expiresAtMs - deps.now() > STATUS_MONITOR_TOKEN_REFRESH_MARGIN_MS
      ) {
        return Promise.resolve(cached.token);
      }
      minting ??= mintOidcToken(audience, deps)
        .then((token) => {
          cached = { token, expiresAtMs: oidcTokenExpiryMs(token) };
          return token;
        })
        .finally(() => {
          minting = null;
        });
      return minting;
    },
  };
}

// ── Claim gate ───────────────────────────────────────────────────────────

/** How POST /api/ops/status-claim answered one claim. */
export type ClaimVerdict =
  /** 200 {ok:true}: the next new room on this code is a status probe. */
  | 'claimed'
  /** 409: a live room holds this code; only this code is refused. */
  | 'room_active'
  /** 424: signaling has no claim route (rolled back); claim nothing more. */
  | 'unsupported'
  /** 401 or 403: the route refused this job's identity; claim nothing more. */
  | 'unauthorized'
  /** 503 SERVICE_MAINTENANCE: maintenance started; claim nothing more. */
  | 'maintenance'
  /** Any other 4xx: the request itself is wrong; claim nothing more. */
  | 'rejected'
  /** 429, another 5xx, no answer, or no answer within the claim timeout. */
  | 'unavailable';

const DEFINITE_REFUSALS: ReadonlySet<ClaimVerdict> = new Set([
  'unsupported',
  'unauthorized',
  'maintenance',
  'rejected',
]);

export function classifyClaimAnswer(answer: JsonAnswer | null): ClaimVerdict {
  if (answer === null) return 'unavailable';
  const { status, body } = answer;
  if (status === 200) return isRecord(body) && body.ok === true ? 'claimed' : 'unavailable';
  if (status === 409) return 'room_active';
  if (status === 424) return 'unsupported';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 503 && errorCode(body) === 'SERVICE_MAINTENANCE') return 'maintenance';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'rejected';
}

/** One claim request through the claim route with a token of its audience. */
export async function requestStatusClaim(
  roomId: string,
  tokens: OidcTokenSource,
  deps: StatusMonitorDeps,
  signal: AbortSignal,
): Promise<ClaimVerdict> {
  let token: string;
  try {
    token = await tokens.get();
  } catch {
    return 'unavailable';
  }
  const answer = await requestJson(
    deps,
    `${STATUS_MONITOR_APP_ORIGIN}${STATUS_CLAIM_PATH}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ v: 1, roomId }),
    },
    STATUS_BROWSER_CLAIM_TIMEOUT_MS,
    signal,
  );
  return classifyClaimAnswer(answer);
}

export interface ClaimGateSummary {
  /** Room codes the claim route granted. */
  readonly claimed: number;
  /** Host transports the gate closed or aborted because no claim was granted. */
  readonly refused: number;
  /** Transports the gate did not recognise, all aborted. */
  readonly unrecognized: number;
  /** The page showed a room the gate never claimed. */
  readonly bypassed: boolean;
  /** The definite refusal that ended claiming, if any. */
  readonly stoppedBy: ClaimVerdict | null;
  /** The claim route answered 401 or 403. */
  readonly authRefused: boolean;
}

export interface ClaimGateOptions {
  /** One claim request; the signal aborts it when the claim timeout ends. */
  readonly request: (roomId: string, signal: AbortSignal) => Promise<ClaimVerdict>;
  /** Told each verdict, for the log; never told the room code. */
  readonly onVerdict?: (verdict: ClaimVerdict) => void;
}

type CodeState = 'claimed' | 'refused' | Promise<boolean>;

/**
 * Grants a host transport only once POST /api/ops/status-claim answered 200
 * for its room code, within STATUS_BROWSER_CLAIM_TIMEOUT_MS. One run's codes:
 * a claimed code is reused (the App reconnecting, or trying its next route),
 * concurrent claims for one code share one request, a 409 refuses that code,
 * a request without an answer may be tried again by the next transport, and a
 * definite refusal (424, 401, 403, maintenance or another 4xx) ends claiming.
 */
export class ClaimGate {
  readonly #request: ClaimGateOptions['request'];
  readonly #onVerdict: ClaimGateOptions['onVerdict'];
  readonly #codes = new Map<string, CodeState>();
  #stoppedBy: ClaimVerdict | null = null;
  #authRefused = false;
  #refused = 0;
  #unrecognized = 0;
  #bypassed = false;

  constructor(options: ClaimGateOptions) {
    this.#request = options.request;
    this.#onVerdict = options.onVerdict;
  }

  /** Whether the room code may open its host transport now. */
  claim(roomId: string): Promise<boolean> {
    if (!STANDARD_ROOM_ID_RE.test(roomId)) return Promise.resolve(false);
    const known = this.#codes.get(roomId);
    if (known === 'claimed') return Promise.resolve(true);
    if (known === 'refused' || this.#stoppedBy !== null) return Promise.resolve(false);
    if (known) return known;
    const pending = this.#claimOnce(roomId);
    this.#codes.set(roomId, pending);
    return pending;
  }

  /** claim() for one host transport, which counts as refused when it may not open. */
  async admitHost(roomId: string): Promise<boolean> {
    const admitted = await this.claim(roomId);
    if (!admitted) this.#refused += 1;
    return admitted;
  }

  /** Whether the claim route granted this room code in this run. */
  isClaimed(roomId: string): boolean {
    return this.#codes.get(roomId) === 'claimed';
  }

  /** A transport the gate could not classify was aborted. */
  noteUnrecognized(): void {
    this.#unrecognized += 1;
  }

  /** The page opened a room the gate never claimed. */
  noteBypass(): void {
    this.#bypassed = true;
  }

  summary(): ClaimGateSummary {
    return {
      claimed: [...this.#codes.values()].filter((state) => state === 'claimed').length,
      refused: this.#refused,
      unrecognized: this.#unrecognized,
      bypassed: this.#bypassed,
      stoppedBy: this.#stoppedBy,
      authRefused: this.#authRefused,
    };
  }

  async #claimOnce(roomId: string): Promise<boolean> {
    const verdict = await this.#ask(roomId);
    this.#onVerdict?.(verdict);
    if (verdict === 'claimed') {
      this.#codes.set(roomId, 'claimed');
      return true;
    }
    if (verdict === 'unavailable') {
      this.#codes.delete(roomId);
      return false;
    }
    this.#codes.set(roomId, 'refused');
    if (DEFINITE_REFUSALS.has(verdict)) {
      this.#stoppedBy ??= verdict;
      if (verdict === 'unauthorized') this.#authRefused = true;
    }
    return false;
  }

  async #ask(roomId: string): Promise<ClaimVerdict> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ClaimVerdict>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('unavailable');
      }, STATUS_BROWSER_CLAIM_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.#request(roomId, controller.signal).catch((): ClaimVerdict => 'unavailable'),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Transports the gate sees ─────────────────────────────────────────────

/** Where the App's Standard-room signaling transports go. */
export interface MonitorSignalingEndpoints {
  /** Room socket origins: the primary and the alternate signaling host. */
  readonly socketOrigins: readonly string[];
  /** HTTP origins of the same hosts, which the App only probes with GET. */
  readonly httpOrigins: readonly string[];
  /** The App origin, which serves the HTTP signaling bridge. */
  readonly appOrigin: string;
}

/**
 * The production endpoints: src/network/transport/config.ts's
 * PUBLIC_SIGNALING_URL and PUBLIC_SIGNALING_FALLBACK_URL, and the bridge of
 * src/network/transport/standard-http-signaling.ts on the App origin.
 */
export const STATUS_MONITOR_SIGNALING_ENDPOINTS: MonitorSignalingEndpoints = Object.freeze({
  socketOrigins: Object.freeze(['wss://signal.musixquare.com', 'wss://signal-alt.musixquare.com']),
  httpOrigins: Object.freeze([
    'https://signal.musixquare.com',
    'https://signal-alt.musixquare.com',
  ]),
  appOrigin: STATUS_MONITOR_APP_ORIGIN,
});

/**
 * `host`: a host transport that may open only after its room code is claimed.
 * `pass`: a guest transport, a bridge session call or no signaling at all.
 * `refuse`: a transport the gate does not recognise, which never opens.
 */
export type MonitorTransport =
  | { readonly kind: 'host'; readonly roomId: string }
  | { readonly kind: 'pass' }
  | { readonly kind: 'refuse' };

const PASS: MonitorTransport = Object.freeze({ kind: 'pass' });
const REFUSE: MonitorTransport = Object.freeze({ kind: 'refuse' });

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function roomTransport(role: unknown, roomId: string, peerId: unknown): MonitorTransport {
  if (typeof peerId !== 'string' || !PEER_ID_RE.test(peerId)) return REFUSE;
  if (role === 'host') return { kind: 'host', roomId };
  return role === 'guest' ? PASS : REFUSE;
}

/**
 * A WebSocket of the host's browser context. Only a Standard room socket on a
 * signaling host, wss://<host>/api/rooms/<code>/ws?role=<role>&peerId=<id>
 * with exactly those two parameters, is recognised. The host page opens no
 * other socket, so any other one is refused, whatever its host.
 */
export function classifyMonitorWebSocket(
  url: string,
  endpoints: MonitorSignalingEndpoints = STATUS_MONITOR_SIGNALING_ENDPOINTS,
): MonitorTransport {
  const parsed = parseUrl(url);
  if (
    !parsed ||
    !endpoints.socketOrigins.includes(parsed.origin) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    return REFUSE;
  }
  const roomId = ROOM_SOCKET_PATH_RE.exec(parsed.pathname)?.[1];
  const keys = [...parsed.searchParams.keys()];
  if (!roomId || keys.length !== 2 || !keys.includes('role') || !keys.includes('peerId')) {
    return REFUSE;
  }
  return roomTransport(parsed.searchParams.get('role'), roomId, parsed.searchParams.get('peerId'));
}

/**
 * An HTTP request of the host's browser context to a signaling host or to the
 * App's /api/standard-signaling/ paths. The bridge open, whose JSON body is
 * exactly {roomId, role, peerId}, is a host transport for role host; the
 * session calls after it pass; a signaling host takes only GET and HEAD (the
 * App's route probe); anything else there is refused. Other requests pass.
 */
export function classifyMonitorRequest(
  method: string,
  url: string,
  postData: string | null,
  endpoints: MonitorSignalingEndpoints = STATUS_MONITOR_SIGNALING_ENDPOINTS,
): MonitorTransport {
  const parsed = parseUrl(url);
  if (!parsed) return REFUSE;
  const verb = method.toUpperCase();
  if (endpoints.httpOrigins.includes(parsed.origin)) {
    return verb === 'GET' || verb === 'HEAD' ? PASS : REFUSE;
  }
  if (parsed.origin !== endpoints.appOrigin || !parsed.pathname.startsWith(BRIDGE_PATH_PREFIX)) {
    return PASS;
  }
  if (verb !== 'POST' || parsed.search || parsed.hash) return REFUSE;
  if (BRIDGE_SESSION_PATHS.has(parsed.pathname)) return PASS;
  if (parsed.pathname !== BRIDGE_OPEN_PATH) return REFUSE;
  let body: unknown;
  try {
    body = JSON.parse(postData ?? '') as unknown;
  } catch {
    return REFUSE;
  }
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ['roomId', 'role', 'peerId']) ||
    typeof body.roomId !== 'string' ||
    !STANDARD_ROOM_ID_RE.test(body.roomId)
  ) {
    return REFUSE;
  }
  return roomTransport(body.role, body.roomId, body.peerId);
}

/** A socket message as Playwright's WebSocketRoute hands it over. */
export type MonitorSocketMessage = string | Buffer;

export interface MonitorSocketCloseOptions {
  code?: number;
  reason?: string;
}

/** The server side of a routed socket (Playwright's WebSocketRoute after connectToServer). */
export interface MonitorServerSocket {
  send(message: MonitorSocketMessage): void;
  close(options?: MonitorSocketCloseOptions): Promise<void>;
}

/** The page side of a routed socket (Playwright's WebSocketRoute). */
export interface MonitorPageSocket {
  url(): string;
  onMessage(handler: (message: MonitorSocketMessage) => void): void;
  onClose(handler: (code: number | undefined, reason: string | undefined) => void): void;
  close(options?: MonitorSocketCloseOptions): Promise<void>;
  connectToServer(): MonitorServerSocket;
}

function closeOptions(
  code: number | undefined,
  reason: string | undefined,
): MonitorSocketCloseOptions {
  const options: MonitorSocketCloseOptions = {};
  if (code !== undefined) options.code = code;
  if (reason !== undefined) options.reason = reason;
  return options;
}

/**
 * The routeWebSocket handler of the host's browser context.
 *
 * A host socket is held before any connection exists: the page's socket stays
 * CONNECTING and signaling sees nothing (not even the upgrade, which would
 * already make the room object count a pending host and refuse the claim)
 * until the claim answers. Granted: the server connection opens, and page
 * frames go to it in order, any frame held while waiting first. Refused: the
 * page's socket closes with STATUS_MONITOR_REFUSED_CLOSE_CODE, held frames are
 * dropped and the server is never contacted. A page that closes its socket
 * while the claim is pending is never connected. A guest socket passes through
 * unchanged, and a socket the gate does not recognise is refused.
 */
export async function routeMonitorWebSocket(
  route: MonitorPageSocket,
  gate: ClaimGate,
  endpoints: MonitorSignalingEndpoints = STATUS_MONITOR_SIGNALING_ENDPOINTS,
): Promise<void> {
  try {
    const transport = classifyMonitorWebSocket(route.url(), endpoints);
    if (transport.kind === 'pass') {
      route.connectToServer();
      return;
    }
    if (transport.kind === 'refuse') {
      gate.noteUnrecognized();
      await route.close({
        code: STATUS_MONITOR_REFUSED_CLOSE_CODE,
        reason: 'status-monitor-unrecognized',
      });
      return;
    }

    const held: MonitorSocketMessage[] = [];
    let server: MonitorServerSocket | null = null;
    let pageClosed = false;
    route.onMessage((message) => {
      if (server) server.send(message);
      else held.push(message);
    });
    route.onClose((code, reason) => {
      if (server) {
        server.close(closeOptions(code, reason)).catch(() => undefined);
        return;
      }
      // Finish the page's own close; the server was never contacted.
      pageClosed = true;
      held.length = 0;
      route.close(closeOptions(code, reason)).catch(() => undefined);
    });

    const admitted = await gate.admitHost(transport.roomId);
    if (pageClosed) return;
    if (!admitted) {
      held.length = 0;
      await route.close({
        code: STATUS_MONITOR_REFUSED_CLOSE_CODE,
        reason: 'status-claim-unavailable',
      });
      return;
    }
    const connected = route.connectToServer();
    for (const message of held.splice(0)) connected.send(message);
    server = connected;
  } catch {
    // The page or the browser went away while the gate waited. Nothing that
    // was held reached signaling, and Playwright must not see a rejection.
  }
}

/** A routed request (Playwright's Route). */
export interface MonitorRequestRoute {
  request(): { method(): string; url(): string; postData(): string | null };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

/**
 * The route handler of the host's browser context for signaling requests: a
 * host bridge open continues only once its room code is claimed, a request the
 * gate does not recognise is aborted, and everything else continues.
 */
export async function routeMonitorRequest(
  route: MonitorRequestRoute,
  gate: ClaimGate,
  endpoints: MonitorSignalingEndpoints = STATUS_MONITOR_SIGNALING_ENDPOINTS,
): Promise<void> {
  try {
    const request = route.request();
    const transport = classifyMonitorRequest(
      request.method(),
      request.url(),
      request.postData(),
      endpoints,
    );
    if (transport.kind === 'pass') {
      await route.continue();
      return;
    }
    if (transport.kind === 'refuse') {
      gate.noteUnrecognized();
      await route.abort('blockedbyclient');
      return;
    }
    if (await gate.admitHost(transport.roomId)) await route.continue();
    else await route.abort('blockedbyclient');
  } catch {
    // The page cancelled the request, or its context closed.
  }
}

// ── Connection result ────────────────────────────────────────────────────

/** How the connection flow itself ended. */
export type ConnectionFlowOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly outcome: 'fail' | 'skipped';
      readonly reason: string;
      /** The host page showed its room code, so the room exists. */
      readonly hostOpened: boolean;
    };

/**
 * The connection row. Fail closed: a transport the gate did not recognise, or
 * a room the gate never claimed, makes the whole check skipped as
 * claim_unavailable, even when the chat worked. A host that never opened its
 * room while the gate refused a transport is skipped the same way, because
 * the refusal, not the product, stopped it.
 */
export function connectionResult(
  flow: ConnectionFlowOutcome,
  gate: ClaimGateSummary,
): MonitorResult {
  if (gate.unrecognized > 0 || gate.bypassed) {
    return monitorSkipped(MONITOR_REASONS.claimUnavailable);
  }
  if (flow.ok) return MONITOR_PASSING;
  if (flow.outcome === 'skipped') return monitorSkipped(flow.reason);
  if (!flow.hostOpened && (gate.refused > 0 || gate.stoppedBy !== null)) {
    return monitorSkipped(MONITOR_REASONS.claimUnavailable);
  }
  return monitorFailure(flow.reason);
}

/** The connection row when the website row did not pass. */
export function connectionAfterWebsite(website: MonitorResult): MonitorResult {
  return website.outcome === 'skipped'
    ? monitorSkipped(website.reason)
    : monitorSkipped(MONITOR_REASONS.websiteFailed);
}

// ── Delivery and exit ────────────────────────────────────────────────────

export interface ReportDelivery {
  readonly delivered: boolean;
  /** The report route answered 401 or 403. */
  readonly authRefused: boolean;
  /** The last answer, or null when no attempt got one. */
  readonly answer: JsonAnswer | null;
  readonly attempts: number;
}

/**
 * Posts the report up to STATUS_BROWSER_REPORT_ATTEMPTS times. Only a 429, a
 * 5xx or no answer is tried again; 200 {ok:true} is delivered, and any other
 * answer is final.
 */
export async function postStatusReport(
  body: StatusReportBody,
  tokens: OidcTokenSource,
  deps: StatusMonitorDeps,
): Promise<ReportDelivery> {
  let answer: JsonAnswer | null = null;
  for (let attempt = 1; ; attempt += 1) {
    let token: string | null = null;
    try {
      token = await tokens.get();
    } catch {
      token = null;
    }
    answer =
      token === null
        ? null
        : await requestJson(
            deps,
            `${STATUS_MONITOR_APP_ORIGIN}${STATUS_REPORT_PATH}`,
            {
              method: 'POST',
              headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            },
            STATUS_MONITOR_REQUEST_TIMEOUT_MS,
          );
    if (answer?.status === 200 && isRecord(answer.body) && answer.body.ok === true) {
      return { delivered: true, authRefused: false, answer, attempts: attempt };
    }
    const authRefused = answer?.status === 401 || answer?.status === 403;
    const transient = answer === null || answer.status === 429 || answer.status >= 500;
    if (!transient || attempt >= STATUS_BROWSER_REPORT_ATTEMPTS) {
      return { delivered: false, authRefused, answer, attempts: attempt };
    }
    deps.write(
      `[status-monitor] report attempt ${attempt} got ${describeAnswer(answer)}; trying again`,
    );
    await deps.sleep(STATUS_MONITOR_REPORT_RETRY_DELAY_MS);
  }
}

/** The recorded marks of a delivered report, for the log. */
export function describeDelivered(answer: JsonAnswer | null): string {
  const body = isRecord(answer?.body) ? answer.body : {};
  const recorded = isRecord(body.recorded) ? body.recorded : {};
  const mark = (value: unknown): string =>
    value === 'o' || value === 'p' || value === 'm' ? value : 'none';
  const slotAt =
    typeof body.slotAt === 'string' && !Number.isNaN(Date.parse(body.slotAt))
      ? new Date(Date.parse(body.slotAt)).toISOString()
      : 'unknown';
  return `slot ${slotAt}, website ${mark(recorded.website)}, connection ${mark(recorded.connection)}`;
}

/**
 * 0 when production has no status API yet, or when the report was delivered
 * (failed checks included). 1 when the report or claim route answered 401 or
 * 403, or the report was not delivered; a crash before reporting also ends
 * with 1, from the script itself.
 */
export function statusMonitorExitCode(run: {
  readonly preflight: StatusPreflight;
  readonly delivered: boolean;
  readonly authRefused: boolean;
}): 0 | 1 {
  if (run.preflight === 'not-deployed') return 0;
  return run.delivered && !run.authRefused ? 0 : 1;
}

// ── Diagnostics ──────────────────────────────────────────────────────────

const DIAGNOSTIC_MAX_LENGTH = 240;
const URL_IN_TEXT_RE = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#@'"<>]*@)?([^\s/?#'"<>]+)[^\s'"<>]*/giu;
const JWT_IN_TEXT_RE = /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)*/gu;
const IPV4_IN_TEXT_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
// Hex groups with "::" or at least four colons (a clock time has two).
const IPV6_IN_TEXT_RE =
  /(?<![0-9a-z:])(?=[0-9a-f:]*::|(?:[0-9a-f]{1,4}:){4})[0-9a-f:]{2,}(?:%[0-9a-z]+)?(?![0-9a-z:])/giu;
const PEER_ID_IN_TEXT_RE = /\bmx-[A-Za-z0-9_-]+/gu;
const ROOM_CODE_IN_TEXT_RE = /(?<![A-Za-z0-9])\d{6}(?![A-Za-z0-9])/gu;
// Secrets, session tokens and mutation ids are 24 or more random base64url
// characters; an upper-case error code such as HTTP_SIGNALING_OPEN_TIMEOUT
// has no lower-case letter and stays readable.
const OPAQUE_RUN_RE = /[A-Za-z0-9_-]{20,}/gu;

function redactOpaqueRun(run: string): string {
  return /[a-z]/u.test(run) && /[A-Z0-9]/u.test(run) ? '[redacted]' : run;
}

/**
 * One line the public job log may show: control characters (so no line
 * breaks, which could start a workflow command), URLs cut to their origin,
 * and tokens, IP addresses, peer ids, six-digit room codes and long random
 * values replaced, then shortened.
 */
export function sanitizeMonitorDiagnostic(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(URL_IN_TEXT_RE, '$1$2/[path]')
    .replace(JWT_IN_TEXT_RE, '[token]')
    .replace(IPV4_IN_TEXT_RE, '[ip]')
    .replace(IPV6_IN_TEXT_RE, '[ip]')
    .replace(PEER_ID_IN_TEXT_RE, '[peer]')
    .replace(ROOM_CODE_IN_TEXT_RE, '[code]')
    .replace(OPAQUE_RUN_RE, redactOpaqueRun)
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, DIAGNOSTIC_MAX_LENGTH);
}

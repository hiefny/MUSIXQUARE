#!/usr/bin/env node
/**
 * App build floor operations (forced update; resource record RO-50).
 *
 *   node scripts/app-build-floor.mts status            read-only status and client read
 *   node scripts/app-build-floor.mts check             GitHub OIDC dry run, no change
 *   node scripts/app-build-floor.mts set <build>       raise (or re-verify) the floor
 *   node scripts/app-build-floor.mts lower <build>     lower the floor; 0 turns it off
 *   node scripts/app-build-floor.mts raise             Production Release: raise to the
 *                                                      checked-out release build
 *   node scripts/app-build-floor.mts emergency-guard   local emergency App deploy guard
 *   node scripts/app-build-floor.mts pro-room-guard    Production Release (pro-room, all):
 *                                                      read-only check that the floor
 *                                                      reaches the App build the PRO
 *                                                      Worker requires
 *
 * Setters run only in GitHub Actions: the App Worker's ops route accepts a
 * GitHub OIDC token of the release or App Build Floor workflow on main, so no
 * secret or owner credential is involved. The token is never printed. The
 * reason comes from MXQR_APP_BUILD_FLOOR_REASON (the workflow input).
 *
 * After every change (and on a re-run at the same value) the script proves the
 * result end to end: the public status shows the floor, the PRO front door
 * refuses build N-1 and admits N, the Signaling Worker refuses a host-auth
 * with N-1 before admission (so no room is created), a minute cron report
 * newer than the change arrives, and the page's client read answers the new
 * floor within the edge-cache lifetime plus 30 s. It then prints one summary
 * line for release-record section 1.
 */

import { appendFileSync } from 'node:fs';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  APP_BUILD_FLOOR_CLIENT_PATH,
  APP_BUILD_FLOOR_EDGE_CACHE_TTL_S,
  APP_BUILD_FLOOR_OPS_AUDIENCE,
  APP_BUILD_FLOOR_OPS_PATH,
  APP_BUILD_FLOOR_PUBLIC_STATUS_PATH,
  APP_UPDATE_REQUIRED_CODE,
  parseAppBuild,
} from '../cloudflare/app-build-floor-contract.ts';
import {
  appBuildRequestHeaders,
  classifyHostAdmission,
  readServiceWorkerAppBuild,
  withAppBuild,
} from './live-smoke-app-build.mts';
import { readReleaseIdentity } from './release-identity.mts';

const APP_ORIGIN = 'https://musixquare.com';
const SIGNALING_ROOMS_ORIGIN = 'wss://signal.musixquare.com/api/rooms';
const PRO_PIN_CANARY_BOOTSTRAP = '/api/pro-room/v1/rooms/000001/bootstrap';
// The App's entry-policy opt-in: with it, the PRO Worker before and after the
// 2026-10-26 old-version removal give the same bootstrap answer.
const PRO_ENTRY_POLICY_HEADERS = Object.freeze({ 'X-MXQR-Pro-Entry-Policy': 'optional-v1' });
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const OIDC_TOKEN_MAX_BYTES = 8 * 1024;
const OIDC_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
// The control object's request-id and reason formats.
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/u;
const REASON_RE = /^[^\u0000-\u001f\u007f]{1,200}$/u;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** Consecutive equal reads of the live service worker before its build counts. */
export const APP_BUILD_FLOOR_LIVE_READ_COUNT = 3;
const LIVE_READ_INTERVAL_MS = 1_000;
const LIVE_READ_TIMEOUT_MS = 60_000;
/** How long the gates may take to see a change: isolate caches plus read timeouts. */
const PROPAGATION_TIMEOUT_MS = 30_000;
const PROPAGATION_POLL_MS = 3_000;
/**
 * Polls whose PRO answer was a rate limit, a 5xx or no answer wait for the
 * answer's Retry-After (at most PRO_RETRY_AFTER_MAX_MS) and do not spend the
 * propagation budget, up to this many times.
 */
const PRO_TRANSIENT_WAITS = 5;
const PRO_RETRY_AFTER_MAX_MS = 30_000;
const SIGNALING_PROBE_ATTEMPTS = 3;
/** A raise, lower or re-run must be followed by a minute cron report within this time. */
export const APP_BUILD_FLOOR_CRON_REPORT_TIMEOUT_MS = 180_000;
const CRON_REPORT_POLL_MS = 10_000;
/** The client read may lag one edge-cache lifetime; allow 30 s more. */
export const APP_BUILD_FLOOR_CLIENT_READ_TIMEOUT_MS =
  (APP_BUILD_FLOOR_EDGE_CACHE_TTL_S + 30) * 1_000;
const CLIENT_READ_POLL_MS = 5_000;
const OPS_ATTEMPTS = 3;
const OPS_RETRY_DELAY_MS = 2_000;

type JsonObject = Record<string, unknown>;
type Env = Readonly<Record<string, string | undefined>>;

export type AppBuildFloorCommand =
  | { readonly action: 'status' }
  | { readonly action: 'check' }
  | { readonly action: 'set'; readonly minAppBuild: number; readonly reason: string }
  | { readonly action: 'lower'; readonly minAppBuild: number; readonly reason: string }
  | { readonly action: 'raise'; readonly reason: string }
  | { readonly action: 'emergency-guard' }
  | { readonly action: 'pro-room-guard'; readonly requiredAppBuild: number | null };

export interface AppBuildFloorStatus {
  readonly minAppBuild: number;
  readonly effectiveMinAppBuild: number;
  readonly revision: number;
  readonly updatedAt: number | null;
  readonly liveAppBuild: number | null;
  readonly reportedLiveAppBuild: number | null;
  readonly reportedAt: number | null;
  readonly state: string | null;
}

export interface SignalingFloorProbe {
  readonly outcome: 'below-floor' | 'admitted' | 'invalid-frame' | 'refused';
  readonly minAppBuild?: number;
  readonly closeCode?: number;
  readonly closeReason?: string;
}

export interface AppBuildFloorDependencies {
  fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  log: (line: string) => void;
  writeSummary: (line: string) => void;
  env: Env;
  /** The checked-out release build (the service-worker cache epoch). */
  releaseBuild: () => number;
  /** One host-auth with `appBuild` on a fresh room, refused or admitted. */
  probeSignaling: (appBuild: number) => Promise<SignalingFloorProbe>;
}

export interface AppBuildFloorRunResult {
  readonly action: AppBuildFloorCommand['action'];
  readonly changed: boolean;
  readonly status: AppBuildFloorStatus;
  readonly clientFloor: number | null;
  readonly summary: string;
}

const USAGE =
  'Usage: node scripts/app-build-floor.mts <status|check|set <build>|lower <build>|raise|emergency-guard|pro-room-guard>';

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usage(detail: string): Error {
  return new Error(`${USAGE} (${detail})`);
}

function parseBuildArgument(value: string | undefined): number {
  const build = value === undefined || value === '' ? null : parseAppBuild(value);
  if (build === null) throw usage('the build must be a whole number from 0');
  return build;
}

function runLabel(env: Env): string {
  return env.GITHUB_RUN_ID ? `run ${env.GITHUB_RUN_ID}` : 'local run';
}

function commandReason(env: Env, fallback: string): string {
  const provided = env.MXQR_APP_BUILD_FLOOR_REASON?.trim() || '';
  const reason = provided || fallback;
  if (!REASON_RE.test(reason)) {
    throw new Error('The floor change reason must be 1 to 200 characters on one line.');
  }
  return reason;
}

/**
 * The App build that the PRO Worker on main requires of every client. The
 * Production Release sets it on its check step, outside every runtime path
 * list, so writing or clearing it never changes a release target; empty means
 * no requirement.
 */
function requiredProRoomAppBuild(env: Env): number | null {
  const value = env.MXQR_PRO_ROOM_REQUIRED_APP_BUILD?.trim() ?? '';
  if (value === '') return null;
  const build = parseAppBuild(value);
  if (build === null || build === 0) {
    throw usage('MXQR_PRO_ROOM_REQUIRED_APP_BUILD must be empty or a build from 1');
  }
  return build;
}

export function parseAppBuildFloorArgs(argv: readonly string[], env: Env): AppBuildFloorCommand {
  const [action, build, ...rest] = argv;
  if (rest.length > 0) throw usage('too many arguments');
  switch (action) {
    case 'status':
    case 'check':
    case 'emergency-guard':
    case 'pro-room-guard':
    case 'raise':
      // The workflow passes an empty build input for the actions without one.
      if (build !== undefined && build !== '') throw usage(`${action} takes no build`);
      if (action === 'raise') {
        return {
          action,
          reason: commandReason(
            env,
            `Raised to the released build by Production Release (${runLabel(env)})`,
          ),
        };
      }
      if (action === 'pro-room-guard') {
        return { action, requiredAppBuild: requiredProRoomAppBuild(env) };
      }
      return { action };
    case 'set':
      return {
        action,
        minAppBuild: parseBuildArgument(build),
        reason: commandReason(env, `Set by the App Build Floor workflow (${runLabel(env)})`),
      };
    case 'lower':
      return {
        action,
        minAppBuild: parseBuildArgument(build),
        reason: commandReason(env, `Lowered by the App Build Floor workflow (${runLabel(env)})`),
      };
    default:
      throw usage('unknown action');
  }
}

function nullableBuild(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' ? (parseAppBuild(value) ?? undefined) : undefined;
}

function nullableTime(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseStatus(value: unknown): AppBuildFloorStatus {
  if (!isJsonObject(value)) throw new Error('The App build floor status is not an object.');
  const minAppBuild = nullableBuild(value.minAppBuild);
  const effectiveMinAppBuild = nullableBuild(value.effectiveMinAppBuild);
  const liveAppBuild = nullableBuild(value.liveAppBuild);
  const reportedLiveAppBuild = nullableBuild(value.reportedLiveAppBuild);
  const updatedAt = nullableTime(value.updatedAt);
  const reportedAt = nullableTime(value.reportedAt);
  if (
    typeof minAppBuild !== 'number' ||
    typeof effectiveMinAppBuild !== 'number' ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    liveAppBuild === undefined ||
    reportedLiveAppBuild === undefined ||
    updatedAt === undefined ||
    reportedAt === undefined ||
    (value.state !== null && typeof value.state !== 'string')
  ) {
    throw new Error('The App build floor status is malformed.');
  }
  return {
    minAppBuild,
    effectiveMinAppBuild,
    revision: value.revision,
    updatedAt,
    liveAppBuild,
    reportedLiveAppBuild,
    reportedAt,
    state: typeof value.state === 'string' ? value.state : null,
  };
}

function iso(value: number | null): string {
  return value === null ? 'never' : new Date(value).toISOString();
}

export function formatAppBuildFloorSummary(
  status: AppBuildFloorStatus,
  clientFloor: number | null,
): string {
  const reported =
    status.reportedLiveAppBuild === null
      ? 'none'
      : `${status.reportedLiveAppBuild} at ${iso(status.reportedAt)}`;
  return (
    `App build floor: stored ${status.minAppBuild}, effective ${status.effectiveMinAppBuild}, ` +
    `revision ${status.revision}, updated ${iso(status.updatedAt)}; ` +
    `live App ${status.liveAppBuild ?? 'unreadable'}, reported ${reported}; ` +
    `client read ${clientFloor ?? 'unreadable'}`
  );
}

async function readJson(
  deps: AppBuildFloorDependencies,
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; retryAfterMs: number | null }> {
  const response = await deps.fetcher(url, {
    cache: 'no-store',
    ...init,
    headers: { Accept: 'application/json', ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > RESPONSE_MAX_BYTES) {
    throw new Error(`${new URL(url).pathname} answered more than ${RESPONSE_MAX_BYTES} bytes.`);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    body = null;
  }
  const retryAfterS = Number(response.headers.get('Retry-After') ?? '');
  const retryAfterMs =
    Number.isSafeInteger(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1_000 : null;
  return { status: response.status, body, retryAfterMs };
}

function errorCode(body: unknown): string {
  const code = isJsonObject(body) ? body.error : undefined;
  return typeof code === 'string' && ERROR_CODE_RE.test(code) ? code : 'unknown';
}

async function readPublicStatus(deps: AppBuildFloorDependencies): Promise<AppBuildFloorStatus> {
  const { status, body } = await readJson(
    deps,
    `${APP_ORIGIN}${APP_BUILD_FLOOR_PUBLIC_STATUS_PATH}`,
  );
  if (status !== 200) {
    throw new Error(`The App build floor status answered HTTP ${status} (${errorCode(body)}).`);
  }
  return parseStatus(body);
}

async function readClientFloor(deps: AppBuildFloorDependencies): Promise<number | null> {
  try {
    const { status, body } = await readJson(deps, `${APP_ORIGIN}${APP_BUILD_FLOOR_CLIENT_PATH}`, {
      credentials: 'omit',
    });
    if (status !== 200 || !isJsonObject(body) || Object.keys(body).length !== 1) return null;
    return typeof body.effectiveMinAppBuild === 'number'
      ? parseAppBuild(body.effectiveMinAppBuild)
      : null;
  } catch {
    return null;
  }
}

/**
 * The live App build: three consecutive equal reads of the live service
 * worker, confirmed by the build the App Worker itself reports in the status.
 */
export async function readStableLiveAppBuild(deps: AppBuildFloorDependencies): Promise<number> {
  const deadline = deps.now() + LIVE_READ_TIMEOUT_MS;
  const reads: Array<number | null> = [];
  for (;;) {
    reads.push(await readServiceWorkerAppBuild(deps.fetcher));
    const recent = reads.slice(-APP_BUILD_FLOOR_LIVE_READ_COUNT);
    const [first] = recent;
    if (
      recent.length === APP_BUILD_FLOOR_LIVE_READ_COUNT &&
      typeof first === 'number' &&
      recent.every((build) => build === first)
    ) {
      const status = await readPublicStatus(deps).catch(() => null);
      if (status?.liveAppBuild === first) return first;
    }
    if (deps.now() >= deadline) {
      throw new Error(
        `The live App build did not settle: the last reads were ${recent
          .map((build) => build ?? 'unreadable')
          .join(', ')}.`,
      );
    }
    await deps.sleep(LIVE_READ_INTERVAL_MS);
  }
}

function requireActionsOidc(env: Env): { url: string; requestToken: string } {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) {
    throw new Error(
      'Changing the App build floor needs GitHub Actions OIDC (id-token: write); run the App Build Floor workflow.',
    );
  }
  return { url, requestToken };
}

async function mintOpsToken(deps: AppBuildFloorDependencies): Promise<string> {
  const { url, requestToken } = requireActionsOidc(deps.env);
  const tokenUrl = new URL(url);
  tokenUrl.searchParams.set('audience', APP_BUILD_FLOOR_OPS_AUDIENCE);
  const { status, body } = await readJson(deps, tokenUrl.toString(), {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  const token = isJsonObject(body) ? body.value : undefined;
  if (
    status !== 200 ||
    typeof token !== 'string' ||
    token.length > OIDC_TOKEN_MAX_BYTES ||
    !OIDC_TOKEN_RE.test(token)
  ) {
    throw new Error(`GitHub Actions OIDC did not issue a token (HTTP ${status}).`);
  }
  return token;
}

async function postOps(
  deps: AppBuildFloorDependencies,
  token: string,
  body: JsonObject,
): Promise<JsonObject> {
  for (let attempt = 1; ; attempt += 1) {
    let answer: { status: number; body: unknown } | null = null;
    try {
      answer = await readJson(deps, `${APP_ORIGIN}${APP_BUILD_FLOOR_OPS_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      answer = null;
    }
    if (answer?.status === 200 && isJsonObject(answer.body) && answer.body.ok === true) {
      return answer.body;
    }
    // A request id makes a repeated change a replay, so a transient failure is
    // repeated unchanged; anything else is final.
    const transient = answer === null || answer.status === 429 || answer.status >= 500;
    if (!transient || attempt >= OPS_ATTEMPTS) {
      const detail =
        answer === null ? 'no response' : `HTTP ${answer.status} (${errorCode(answer.body)})`;
      throw new Error(`The App build floor ${String(body.action)} failed: ${detail}.`);
    }
    deps.log(
      `[app-build-floor] ${String(body.action)} attempt ${attempt} got ${answer?.status ?? 'no response'}; repeating`,
    );
    await deps.sleep(OPS_RETRY_DELAY_MS * attempt);
  }
}

function requestId(env: Env, action: string): string {
  const id =
    env.GITHUB_RUN_ID && env.GITHUB_RUN_ATTEMPT
      ? `gha-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${action}`
      : `local-${randomUUID().replaceAll('-', '')}-${action}`;
  if (!REQUEST_ID_RE.test(id)) throw new Error('The floor request id is malformed.');
  return id;
}

async function pollUntil<Value>(
  deps: AppBuildFloorDependencies,
  timeoutMs: number,
  intervalMs: number,
  read: () => Promise<Value>,
  done: (value: Value) => boolean,
): Promise<{ value: Value; done: boolean }> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return { value, done: true };
    if (deps.now() >= deadline) return { value, done: false };
    await deps.sleep(intervalMs);
  }
}

async function readStatusOrNull(
  deps: AppBuildFloorDependencies,
): Promise<AppBuildFloorStatus | null> {
  return readPublicStatus(deps).catch(() => null);
}

type ProAnswer = { status: number; body: unknown; retryAfterMs: number | null } | null;

async function proBootstrap(
  deps: AppBuildFloorDependencies,
  appBuild: number | null,
): Promise<ProAnswer> {
  try {
    return await readJson(deps, `${APP_ORIGIN}${PRO_PIN_CANARY_BOOTSTRAP}`, {
      headers: {
        ...(appBuild === null ? {} : appBuildRequestHeaders(appBuild)),
        ...PRO_ENTRY_POLICY_HEADERS,
      },
    });
  } catch {
    return null;
  }
}

function isTransientProAnswer(answer: ProAnswer): boolean {
  return answer === null || answer.status === 429 || answer.status >= 500;
}

function describeProAnswer(answer: ProAnswer): string {
  return answer === null ? 'no answer' : `HTTP ${answer.status}`;
}

function isProRefusal(answer: { status: number; body: unknown } | null, floor: number): boolean {
  return (
    answer?.status === 426 &&
    isJsonObject(answer.body) &&
    answer.body.error === APP_UPDATE_REQUIRED_CODE &&
    answer.body.minAppBuild === floor
  );
}

/**
 * Room 000001 admitted: its status and `passwordRequired` agree, whichever
 * entry password the room has (the floor proof changes no room setting).
 */
function isProAdmission(answer: { status: number; body: unknown } | null): boolean {
  return (
    answer?.status === 200 &&
    isJsonObject(answer.body) &&
    answer.body.roomCode === '000001' &&
    ((answer.body.status === 'pin_required' && answer.body.passwordRequired === true) ||
      (answer.body.status === 'open' && answer.body.passwordRequired === false))
  );
}

/**
 * The PRO front door refuses floor - 1 and admits the floor (or a build-less
 * entry at 0). A poll with a rate-limited, 5xx or missing answer is not yet a
 * verdict: it waits for that answer's Retry-After and does not spend the
 * propagation budget, a bounded number of times.
 */
async function verifyProGate(deps: AppBuildFloorDependencies, floor: number): Promise<void> {
  let deadline = deps.now() + PROPAGATION_TIMEOUT_MS;
  let transientWaits = 0;
  for (;;) {
    const answers =
      floor > 0
        ? [await proBootstrap(deps, floor - 1), await proBootstrap(deps, floor)]
        : [await proBootstrap(deps, null)];
    const verified =
      floor > 0
        ? isProRefusal(answers[0] ?? null, floor) && isProAdmission(answers[1] ?? null)
        : isProAdmission(answers[0] ?? null);
    if (verified) return;
    const transient = answers.filter(isTransientProAnswer);
    if (transient.length > 0 && transientWaits < PRO_TRANSIENT_WAITS) {
      transientWaits += 1;
      const waitMs = Math.max(
        PROPAGATION_POLL_MS,
        ...transient.map((answer) => Math.min(answer?.retryAfterMs ?? 0, PRO_RETRY_AFTER_MAX_MS)),
      );
      deps.log(
        `[app-build-floor] PRO front door answered ${answers.map(describeProAnswer).join(', ')}; waiting ${waitMs / 1000} s`,
      );
      await deps.sleep(waitMs);
      deadline += waitMs;
      continue;
    }
    if (deps.now() >= deadline) {
      const last = answers.map(describeProAnswer).join(', ');
      throw new Error(
        floor > 0
          ? `The PRO front door did not refuse build ${floor - 1} and admit build ${floor} within ${PROPAGATION_TIMEOUT_MS / 1000} s (last answers: ${last}).`
          : `The PRO front door did not admit an entry without a build within ${PROPAGATION_TIMEOUT_MS / 1000} s (last answer: ${last}).`,
      );
    }
    await deps.sleep(PROPAGATION_POLL_MS);
  }
}

/**
 * A host-auth with floor - 1 is refused before admission, so no room is
 * created. An admission or a refusal at another floor (an isolate that still
 * holds the floor from before the change), another refusal, or a probe that
 * could not connect is repeated within the same small attempt budget; an
 * invalid first frame (the probe's host-auth no longer matches the shape the
 * Worker requires, or a Signaling Worker older than 9.0.14 refuses appBuild)
 * and a wrong close fail at once.
 */
async function verifySignalingGate(deps: AppBuildFloorDependencies, floor: number): Promise<void> {
  if (floor <= 0) return;
  let last = 'did not run';
  for (let attempt = 1; attempt <= SIGNALING_PROBE_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await deps.sleep(PROPAGATION_POLL_MS);
    let probe: SignalingFloorProbe;
    try {
      probe = await deps.probeSignaling(floor - 1);
    } catch (error) {
      last = `failed: ${error instanceof Error ? error.message : String(error)}`;
      deps.log(`[app-build-floor] Signaling probe attempt ${attempt} ${last}`);
      continue;
    }
    if (probe.outcome === 'invalid-frame') {
      throw new Error(
        'The Signaling Worker refused the probe host-auth as an invalid first frame (HOST_AUTH_FIRST_FRAME_INVALID): either the probe does not send the host-auth shape the Worker requires, or the Signaling Worker is older than 9.0.14 and refuses appBuild (a rollback outside the procedure).',
      );
    }
    if (probe.outcome === 'below-floor' && probe.minAppBuild === floor) {
      if (probe.closeCode !== 1008 || probe.closeReason !== APP_UPDATE_REQUIRED_CODE) {
        throw new Error(
          `The Signaling Worker refused build ${floor - 1} at floor ${floor} with close ${probe.closeCode ?? 'none'}; expected close 1008 ${APP_UPDATE_REQUIRED_CODE}.`,
        );
      }
      return;
    }
    last =
      probe.outcome === 'admitted'
        ? 'was admitted'
        : probe.outcome === 'below-floor'
          ? `was refused at floor ${probe.minAppBuild ?? 'unknown'}`
          : 'was refused for another reason';
    deps.log(`[app-build-floor] Signaling probe attempt ${attempt} ${last}`);
  }
  throw new Error(
    `The Signaling Worker did not refuse build ${floor - 1} below the floor ${floor} in ${SIGNALING_PROBE_ATTEMPTS} probes; the last probe ${last}.`,
  );
}

/**
 * Proves a floor end to end and returns the latest status and client read.
 * `exact` (set and raise) requires the enforced floor to equal the stored one;
 * a lower only requires it not to exceed it.
 */
async function verifyFloor(
  deps: AppBuildFloorDependencies,
  target: number,
  exact: boolean,
): Promise<{ status: AppBuildFloorStatus; clientFloor: number }> {
  const settled = await pollUntil(
    deps,
    PROPAGATION_TIMEOUT_MS,
    PROPAGATION_POLL_MS,
    () => readStatusOrNull(deps),
    (status) =>
      status !== null &&
      status.minAppBuild === target &&
      (exact ? status.effectiveMinAppBuild === target : status.effectiveMinAppBuild <= target),
  );
  if (!settled.done || settled.value === null) {
    throw new Error(
      `The App build floor status did not show stored ${target}${exact ? ` and enforced ${target}` : ''} within ${PROPAGATION_TIMEOUT_MS / 1000} s.`,
    );
  }
  const floor = settled.value.effectiveMinAppBuild;
  await verifyProGate(deps, floor);
  await verifySignalingGate(deps, floor);

  const after = Math.max(settled.value.reportedAt ?? 0, settled.value.updatedAt ?? 0);
  const reported = await pollUntil(
    deps,
    APP_BUILD_FLOOR_CRON_REPORT_TIMEOUT_MS,
    CRON_REPORT_POLL_MS,
    () => readStatusOrNull(deps),
    (status) => status !== null && status.reportedAt !== null && status.reportedAt > after,
  );
  let status: AppBuildFloorStatus;
  if (reported.done && reported.value !== null) {
    status = reported.value;
  } else if (!exact) {
    // A lower is fail-safe: without a later report the enforced floor only
    // drops further (to 0 five minutes after the last report), so the lowered
    // floor stands and the run records it instead of failing.
    deps.log(
      `::warning::[app-build-floor] No App cron report arrived within ${APP_BUILD_FLOOR_CRON_REPORT_TIMEOUT_MS / 60_000} minutes after the lower; the floor is lowered, and the App cron needs a look.`,
    );
    status = reported.value ?? settled.value;
  } else {
    throw new Error(
      `No App cron report arrived within ${APP_BUILD_FLOOR_CRON_REPORT_TIMEOUT_MS / 60_000} minutes; without it the floor turns itself off 5 minutes after the last report.`,
    );
  }
  const expectedClient =
    status.liveAppBuild === null ? 0 : Math.min(status.effectiveMinAppBuild, status.liveAppBuild);
  const client = await pollUntil(
    deps,
    APP_BUILD_FLOOR_CLIENT_READ_TIMEOUT_MS,
    CLIENT_READ_POLL_MS,
    () => readClientFloor(deps),
    (value) => value === expectedClient,
  );
  if (!client.done) {
    // The floor is set and enforced; record it for release-record section 1
    // with the stale client read before failing the step.
    deps.writeSummary(formatAppBuildFloorSummary(status, client.value));
    throw new Error(
      `The floor is set and the gates enforce it, but the client read still answered ${client.value ?? 'nothing'} instead of ${expectedClient} after ${APP_BUILD_FLOOR_CLIENT_READ_TIMEOUT_MS / 1000} s; the start and resume check would not see it.`,
    );
  }
  return { status, clientFloor: expectedClient };
}

function report(
  deps: AppBuildFloorDependencies,
  action: AppBuildFloorCommand['action'],
  changed: boolean,
  status: AppBuildFloorStatus,
  clientFloor: number | null,
): AppBuildFloorRunResult {
  const summary = formatAppBuildFloorSummary(status, clientFloor);
  deps.log(summary);
  deps.writeSummary(summary);
  return { action, changed, status, clientFloor, summary };
}

async function changeFloor(
  deps: AppBuildFloorDependencies,
  action: 'set' | 'lower' | 'raise',
  target: number,
  reason: string,
): Promise<AppBuildFloorRunResult> {
  const before = await readPublicStatus(deps);
  let changed = false;
  if (target === before.minAppBuild) {
    deps.log(`[app-build-floor] the stored floor is already ${target}; verifying it`);
  } else {
    const token = await mintOpsToken(deps);
    const answer = await postOps(deps, token, {
      action: action === 'lower' ? 'lower' : 'set',
      minAppBuild: target,
      expectedRevision: before.revision,
      requestId: requestId(deps.env, action),
      reason,
    });
    changed = answer.changed === true;
    deps.log(
      `[app-build-floor] ${action} to ${target}: ${changed ? 'changed' : 'unchanged'} (revision ${before.revision} before)`,
    );
  }
  const { status, clientFloor } = await verifyFloor(deps, target, action !== 'lower');
  return report(deps, action, changed, status, clientFloor);
}

/** Refuses an emergency App deploy of a build below the stored floor. */
async function guardEmergencyAppDeploy(deps: AppBuildFloorDependencies): Promise<void> {
  const localBuild = deps.releaseBuild();
  let status: AppBuildFloorStatus;
  try {
    status = await readPublicStatus(deps);
  } catch (error) {
    deps.log(
      `[app-build-floor] warning: ${error instanceof Error ? error.message : String(error)} ` +
        'continuing without the App build floor check.',
    );
    return;
  }
  if (localBuild < status.minAppBuild) {
    throw new Error(
      `Local App build ${localBuild} is below the stored App build floor ${status.minAppBuild}: ` +
        'its new room entries would be refused until the next App report. Lower the floor first: ' +
        `gh workflow run app-build-floor.yml --ref main -f action=lower -f min_app_build=${localBuild} ` +
        `-f reason="Emergency deploy of build ${localBuild}"`,
    );
  }
  deps.log(
    `[app-build-floor] local App build ${localBuild} is not below the stored floor ${status.minAppBuild}`,
  );
}

/**
 * The Production Release check for targets pro-room and all, before anything
 * changes: when the PRO Worker on main requires every client to be at least an
 * App build, the stored and the effective floor must both reach it. Read-only,
 * through the public status. An unreadable status is read again for the gates'
 * propagation budget, and an effective floor of 0 (no App report for five
 * minutes) waits as long as a floor change waits for a new App report; then
 * the release stops while nothing has changed.
 */
async function guardProRoomRelease(
  deps: AppBuildFloorDependencies,
  required: number | null,
): Promise<void> {
  if (required === null) {
    deps.log(
      '[app-build-floor] the PRO Worker requires no App build (MXQR_PRO_ROOM_REQUIRED_APP_BUILD is empty); nothing to check',
    );
    return;
  }
  const requirement = `build ${required}, which the PRO Worker of this release requires`;
  const exit = 'nothing has changed; see App Build Floor in docs/hotfix-procedure.md';
  let lastReadError = 'no answer';
  const readStatus = (): Promise<AppBuildFloorStatus | null> =>
    readPublicStatus(deps).catch((error: unknown) => {
      lastReadError = (error instanceof Error ? error.message : String(error)).replace(/\.$/u, '');
      return null;
    });
  const unreadable = (when: string): Error =>
    new Error(
      `The App build floor status could not be read ${when} (last read: ${lastReadError}), ` +
        `so ${requirement} is unchecked; ${exit}.`,
    );

  const read = await pollUntil(
    deps,
    PROPAGATION_TIMEOUT_MS,
    PROPAGATION_POLL_MS,
    readStatus,
    (status) => status !== null,
  );
  if (read.value === null) throw unreadable(`within ${PROPAGATION_TIMEOUT_MS / 1000} s`);
  let status = read.value;
  if (status.minAppBuild >= required && status.effectiveMinAppBuild === 0) {
    deps.log(
      `[app-build-floor] the effective floor is 0 (last App report ${iso(status.reportedAt)}); waiting for a new App report`,
    );
    const reported = await pollUntil(
      deps,
      APP_BUILD_FLOOR_CRON_REPORT_TIMEOUT_MS,
      CRON_REPORT_POLL_MS,
      readStatus,
      (value) => value !== null && value.effectiveMinAppBuild > 0,
    );
    if (reported.value === null) throw unreadable('while waiting for a new App report');
    if (!reported.done) {
      throw new Error(
        `The effective App build floor stayed 0 for ${APP_BUILD_FLOOR_CRON_REPORT_TIMEOUT_MS / 60_000} minutes ` +
          `without a new App report (last ${iso(reported.value.reportedAt)}), so the entry gates do not ` +
          `enforce ${requirement}; ${exit}.`,
      );
    }
    status = reported.value;
  }
  if (status.minAppBuild < required) {
    throw new Error(
      `The stored App build floor ${status.minAppBuild} is below ${requirement}; ${exit}.`,
    );
  }
  if (status.effectiveMinAppBuild < required) {
    throw new Error(
      `The effective App build floor ${status.effectiveMinAppBuild} is below ${requirement} ` +
        `(stored ${status.minAppBuild}, live App reported ${status.reportedLiveAppBuild ?? 'none'}); ${exit}.`,
    );
  }
  deps.log(
    `[app-build-floor] the floors stored ${status.minAppBuild} and effective ${status.effectiveMinAppBuild} reach ${requirement}`,
  );
}

export async function runAppBuildFloorCommand(
  command: AppBuildFloorCommand,
  deps: AppBuildFloorDependencies,
): Promise<AppBuildFloorRunResult | null> {
  switch (command.action) {
    case 'status': {
      const status = await readPublicStatus(deps);
      return report(deps, 'status', false, status, await readClientFloor(deps));
    }
    case 'check': {
      const token = await mintOpsToken(deps);
      const answer = await postOps(deps, token, { action: 'check' });
      deps.log(`[app-build-floor] GitHub OIDC check passed for ${String(answer.workflow)}`);
      const status = parseStatus(answer.appBuildFloor);
      return report(deps, 'check', false, status, await readClientFloor(deps));
    }
    case 'set': {
      requireActionsOidc(deps.env);
      const live = await readStableLiveAppBuild(deps);
      if (command.minAppBuild > live) {
        throw new Error(
          `Refusing to set the floor to ${command.minAppBuild}, above the live App build ${live}.`,
        );
      }
      const current = await readPublicStatus(deps);
      if (command.minAppBuild < current.minAppBuild) {
        throw new Error(
          `The stored floor is ${current.minAppBuild}; use lower to go down to ${command.minAppBuild}.`,
        );
      }
      return changeFloor(deps, 'set', command.minAppBuild, command.reason);
    }
    case 'lower': {
      requireActionsOidc(deps.env);
      const current = await readPublicStatus(deps);
      if (command.minAppBuild > current.minAppBuild) {
        throw new Error(
          `The stored floor is ${current.minAppBuild}; lower cannot raise it, use set for ${command.minAppBuild}.`,
        );
      }
      return changeFloor(deps, 'lower', command.minAppBuild, command.reason);
    }
    case 'raise': {
      const release = deps.releaseBuild();
      const live = await readStableLiveAppBuild(deps);
      if (live !== release) {
        throw new Error(
          `The live App build ${live} is not this release's build ${release}; refusing to raise the floor.`,
        );
      }
      const current = await readPublicStatus(deps);
      if (current.minAppBuild >= release) {
        deps.log(
          `[app-build-floor] the stored floor is already ${current.minAppBuild}, at or above the released build ${release}; nothing to raise`,
        );
        return report(deps, 'raise', false, current, await readClientFloor(deps));
      }
      requireActionsOidc(deps.env);
      return changeFloor(deps, 'raise', release, command.reason);
    }
    case 'emergency-guard':
      await guardEmergencyAppDeploy(deps);
      return null;
    case 'pro-room-guard':
      await guardProRoomRelease(deps, command.requiredAppBuild);
      return null;
  }
}

/** The socket surface the Signaling probe uses (a `ws` client in production). */
export interface SignalingProbeSocket {
  on(event: 'message', listener: (data: { toString(): string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'open', listener: () => void): unknown;
  once(event: 'close', listener: (code: number, reason: { toString(): string }) => void): unknown;
  once(
    event: 'unexpected-response',
    listener: (
      request: unknown,
      response: { readonly statusCode?: number | undefined; resume(): unknown },
    ) => void,
  ): unknown;
  send(data: string): void;
  terminate(): void;
}

/**
 * Sends one pending host-auth carrying `appBuild` and the PIN fields the
 * Worker requires (a passwordless room) and reads the answer: the refusal
 * frame and its close, an admission (the probe room is closed at once), an
 * invalid first frame, or any other refusal. The socket is always terminated.
 */
export async function runSignalingProbe(
  socket: SignalingProbeSocket,
  appBuild: number,
): Promise<SignalingFloorProbe> {
  socket.on('error', () => undefined);
  try {
    return await new Promise<SignalingFloorProbe>((resolveProbe, reject) => {
      let frame: JsonObject | null = null;
      const timer = setTimeout(
        () => reject(new Error('The Signaling probe timed out.')),
        REQUEST_TIMEOUT_MS,
      );
      socket.once('open', () => {
        socket.send(
          JSON.stringify(
            withAppBuild(
              {
                type: 'host-auth',
                secret: `floor-probe-${randomUUID()}`,
                desiredRoomPassword: '',
                pinMutationId: randomBytes(24).toString('base64url'),
              },
              appBuild,
            ),
          ),
        );
      });
      socket.on('message', (data) => {
        let message: unknown;
        try {
          message = JSON.parse(data.toString()) as unknown;
        } catch {
          return;
        }
        if (!isJsonObject(message) || frame !== null) return;
        frame = message;
        if (classifyHostAdmission(message).outcome === 'admitted') {
          clearTimeout(timer);
          resolveProbe({ outcome: 'admitted' });
        }
      });
      socket.once('close', (code, reason) => {
        clearTimeout(timer);
        const admission = frame === null ? null : classifyHostAdmission(frame);
        if (admission?.outcome === 'admitted') return;
        if (admission?.outcome === 'below-floor') {
          resolveProbe({
            outcome: 'below-floor',
            minAppBuild: admission.minAppBuild,
            closeCode: code,
            closeReason: reason.toString(),
          });
          return;
        }
        resolveProbe({
          outcome: admission?.outcome === 'invalid-frame' ? 'invalid-frame' : 'refused',
        });
      });
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        response.resume();
        reject(
          new Error(`The Signaling probe upgrade answered HTTP ${response.statusCode ?? 'none'}.`),
        );
      });
    });
  } finally {
    socket.terminate();
  }
}

/** The production Signaling probe: one pending host on a fresh synthetic room. */
async function probeProductionSignaling(appBuild: number): Promise<SignalingFloorProbe> {
  const { default: WebSocket } = await import('ws');
  const roomId = String(randomInt(100_000, 1_000_000));
  const url = new URL(`${SIGNALING_ROOMS_ORIGIN}/${roomId}/ws`);
  url.searchParams.set('role', 'host');
  url.searchParams.set('peerId', `floor-probe-${randomUUID().replaceAll('-', '').slice(0, 12)}`);
  return runSignalingProbe(new WebSocket(url, { origin: APP_ORIGIN }), appBuild);
}

function productionDependencies(): AppBuildFloorDependencies {
  return {
    fetcher: (input, init) => fetch(input, init),
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
    log: (line) => console.log(line),
    writeSummary: (line) => {
      const path = process.env.GITHUB_STEP_SUMMARY;
      if (path) appendFileSync(resolve(path), `- ${line}\n`, 'utf8');
    },
    env: process.env,
    releaseBuild: () => readReleaseIdentity().serviceWorkerCacheEpoch,
    probeSignaling: probeProductionSignaling,
  };
}

async function main(): Promise<void> {
  const command = parseAppBuildFloorArgs(process.argv.slice(2), process.env);
  await runAppBuildFloorCommand(command, productionDependencies());
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

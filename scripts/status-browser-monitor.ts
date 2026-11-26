#!/usr/bin/env node
/**
 * Status browser monitor: the "Website and app" and "Device connections" rows
 * of the public musixquare.com/status page (registry record RO-57).
 *
 *   npx tsx scripts/status-browser-monitor.ts
 *
 * The Status monitor workflow (.github/workflows/status-monitor.yml) runs it
 * every 15 minutes in the Playwright container. Its only credential is a
 * GitHub Actions OIDC token:
 *
 * 1. GET /api/status. Unless it answers schema 1 (production before this
 *    train, or after a rollback), the run ends successfully with no browser.
 * 2. It mints the report and claim tokens, each masked in the log.
 * 3. During maintenance it reports both rows as maintenance and opens nothing.
 * 4. Website and app: a fresh Chromium context opens the site and waits for a
 *    ready or degraded boot and the start screen's host button. A Cloudflare
 *    challenge is reported as skipped and never solved.
 * 5. Device connections, only after the website passed: a host context makes
 *    a room, a guest context joins it, and each sends the other a chat
 *    message. Chat in a Standard room travels only over the two browsers'
 *    WebRTC data channel, so the two messages prove the connection. The host
 *    context's claim gate holds every host transport until the claim route
 *    granted its room code: signaling then records a status probe, and the
 *    /about room count stays unchanged. Without a claim no room opens and the
 *    check is skipped.
 * 6. It posts both results to the report route; statusMonitorExitCode decides
 *    whether the job fails.
 *
 * The public log shows no room code, peer id, token, IP address or full URL,
 * and the run saves no screenshot. Waits use Locator APIs only.
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';

import {
  STATUS_BROWSER_NAVIGATION_TIMEOUT_MS,
  STATUS_BROWSER_STEP_TIMEOUT_MS,
  STATUS_CLAIM_AUDIENCE,
  STATUS_REPORT_AUDIENCE,
} from '../cloudflare/status-contract.ts';
import {
  ClaimGate,
  MONITOR_MAINTENANCE,
  MONITOR_PASSING,
  MONITOR_REASONS,
  STATUS_MONITOR_APP_ORIGIN,
  STATUS_MONITOR_CONNECTION_BUDGET_MS,
  STATUS_MONITOR_DIALOG_WAIT_MS,
  buildStatusReport,
  classifyDocumentResponse,
  connectionAfterWebsite,
  connectionResult,
  createOidcTokenSource,
  describeAnswer,
  describeDelivered,
  monitorFailure,
  monitorSkipped,
  postStatusReport,
  readStatusPreflight,
  requestStatusClaim,
  routeMonitorRequest,
  routeMonitorWebSocket,
  sanitizeMonitorDiagnostic,
  statusMonitorExitCode,
  type ConnectionFlowOutcome,
  type MonitorResult,
  type StatusMonitorDeps,
} from './lib/status-browser-monitor-lib.mts';

const LOG_PREFIX = '[status-monitor]';
const DIAGNOSTIC_LINES_PER_PAGE = 12;
const BOOT_TERMINAL_SELECTOR =
  'html[data-bootstrap-state="ready"], html[data-bootstrap-state="degraded"], ' +
  'html[data-bootstrap-state="aborted"]';
const ROOM_CODE_RE = /^[1-9]\d{5}$/u;
// Web Analytics' beacon script and its report endpoint: monitor page views are
// not visitors.
const ANALYTICS_SCRIPT = 'https://static.cloudflareinsights.com/**';
const ANALYTICS_REPORT = /\/cdn-cgi\/rum(?:[/?#]|$)/u;
// The host context routes every socket and every request that could reach
// signaling; the gate classifies each one.
const EVERY_WEBSOCKET = /^wss?:/u;
const SIGNALING_HOST_REQUEST = /^https?:\/\/signal(?:-alt)?\.musixquare\.com[:/]/u;
const SIGNALING_BRIDGE_REQUEST = /^https:\/\/musixquare\.com\/api\/standard-signaling\//u;

type Role = 'host' | 'guest';

/** A failed or skipped step of the connection flow, with the reason it reports. */
class FlowStop extends Error {
  readonly reason: string;
  readonly outcome: 'fail' | 'skipped';

  constructor(reason: string, outcome: 'fail' | 'skipped' = 'fail') {
    super(reason);
    this.reason = reason;
    this.outcome = outcome;
  }
}

interface FlowProgress {
  /** The reason the current step reports if anything goes wrong. */
  reason: string;
  /** The host page showed its room code, so the room exists. */
  hostOpened: boolean;
}

function nodeDeps(): StatusMonitorDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  };
}

function log(deps: StatusMonitorDeps, message: string): void {
  deps.write(`${LOG_PREFIX} ${message}`);
}

function annotation(kind: 'notice' | 'warning' | 'error', message: string): string {
  const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  return `::${kind} title=Status monitor::${escaped}`;
}

/** A workflow annotation; its message escapes what the runner would read as a command. */
function annotate(
  deps: StatusMonitorDeps,
  kind: 'notice' | 'warning' | 'error',
  message: string,
): void {
  deps.write(annotation(kind, message));
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function watchPage(page: Page, role: Role, lines: string[]): void {
  const push = (text: string): void => {
    lines.push(sanitizeMonitorDiagnostic(`${role} ${text}`));
    if (lines.length > DIAGNOSTIC_LINES_PER_PAGE) lines.shift();
  };
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => push(`page error: ${error.message}`));
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? 'unknown';
    // The monitor's own aborts (analytics, refused transports) are not page failures.
    if (!errorText.includes('ERR_BLOCKED_BY_CLIENT')) {
      push(`request failed: ${request.url()} ${errorText}`);
    }
  });
}

async function readText(page: Page, selector: string): Promise<string | null> {
  return page
    .locator(selector)
    .first()
    .textContent({ timeout: 1_000 })
    .catch(() => null);
}

/** What the log may show of a page that failed: its boot state, setup errors and log lines. */
async function printDiagnostics(
  deps: StatusMonitorDeps,
  role: Role,
  page: Page | null,
  lines: readonly string[],
): Promise<void> {
  deps.write(`::group::${LOG_PREFIX} ${role} page diagnostics`);
  if (page && !page.isClosed()) {
    const root = page.locator('html');
    const attribute = (name: string): Promise<string | null> =>
      root.getAttribute(name, { timeout: 1_000 }).catch(() => null);
    const boot = [
      `state=${(await attribute('data-bootstrap-state')) ?? 'none'}`,
      `failures=${(await attribute('data-bootstrap-failures')) || '-'}`,
      `fallbacks=${(await attribute('data-bootstrap-fallbacks')) || '-'}`,
    ].join(' ');
    log(deps, sanitizeMonitorDiagnostic(`${role} boot ${boot}`));
    for (const selector of ['#setup-host-error', '#setup-guest-error', '#dialog-title']) {
      const text = await readText(page, selector);
      if (text?.trim()) log(deps, sanitizeMonitorDiagnostic(`${role} ${selector}: ${text}`));
    }
  }
  for (const line of lines) log(deps, line);
  deps.write('::endgroup::');
}

async function abortRoute(route: Route): Promise<void> {
  await route.abort('blockedbyclient').catch(() => undefined);
}

async function newMonitorContext(browser: Browser, gate: ClaimGate | null) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
  });
  await context.route(ANALYTICS_SCRIPT, abortRoute);
  await context.route(ANALYTICS_REPORT, abortRoute);
  if (gate) {
    await context.routeWebSocket(EVERY_WEBSOCKET, (route) => routeMonitorWebSocket(route, gate));
    await context.route(SIGNALING_HOST_REQUEST, (route) => routeMonitorRequest(route, gate));
    await context.route(SIGNALING_BRIDGE_REQUEST, (route) => routeMonitorRequest(route, gate));
  }
  return context;
}

/**
 * Opens the App and waits, within one step timeout, for a ready or degraded
 * boot and the start screen's control. Passing, or the website row's failure
 * or skip.
 */
export async function openStartScreen(
  page: Page,
  startControl: '#btn-setup-host' | '#btn-setup-guest',
  origin: string = STATUS_MONITOR_APP_ORIGIN,
): Promise<MonitorResult> {
  let response;
  try {
    response = await page.goto(`${origin}/`, {
      waitUntil: 'domcontentloaded',
      timeout: STATUS_BROWSER_NAVIGATION_TIMEOUT_MS,
    });
  } catch {
    return monitorFailure(MONITOR_REASONS.navigationFailed);
  }
  if (!response) return monitorFailure(MONITOR_REASONS.navigationFailed);
  const document = classifyDocumentResponse(
    response.status(),
    await response.headerValue('cf-mitigated').catch(() => null),
  );
  if (document.kind === 'challenge') return monitorSkipped(MONITOR_REASONS.edgeChallenge);
  if (document.kind === 'http') return monitorFailure(document.reason);

  const deadline = Date.now() + STATUS_BROWSER_STEP_TIMEOUT_MS;
  try {
    await page
      .locator(BOOT_TERMINAL_SELECTOR)
      .waitFor({ state: 'attached', timeout: remainingMs(deadline) });
  } catch {
    return monitorFailure(MONITOR_REASONS.bootTimeout);
  }
  const state = await page
    .locator('html')
    .getAttribute('data-bootstrap-state', { timeout: remainingMs(deadline) })
    .catch(() => null);
  if (state !== 'ready' && state !== 'degraded') {
    return monitorFailure(MONITOR_REASONS.bootAborted);
  }
  try {
    await page.locator(startControl).waitFor({ state: 'visible', timeout: remainingMs(deadline) });
  } catch {
    return monitorFailure(MONITOR_REASONS.startScreenMissing);
  }
  return MONITOR_PASSING;
}

async function step<T>(progress: FlowProgress, reason: string, run: () => Promise<T>): Promise<T> {
  progress.reason = reason;
  try {
    return await run();
  } catch (error) {
    if (error instanceof FlowStop) throw error;
    throw new FlowStop(reason);
  }
}

async function startHost(page: Page, gate: ClaimGate, progress: FlowProgress): Promise<string> {
  const timeout = STATUS_BROWSER_STEP_TIMEOUT_MS;
  const code = await step(progress, MONITOR_REASONS.hostStartFailed, async () => {
    await page.locator('#btn-setup-host').click({ timeout });
    await page.locator('#setup-code-area').waitFor({ state: 'visible', timeout });
    // The code shows once signaling admitted the host, so the room exists.
    await expect(page.locator('#setup-code')).toHaveValue(ROOM_CODE_RE, { timeout });
    return (await page.locator('#setup-code').inputValue({ timeout })).trim();
  });
  if (!gate.isClaimed(code)) {
    // A room the gate never claimed would be counted. Stop before a guest
    // joins it; the gate reports the connection check as skipped.
    gate.noteBypass();
    throw new FlowStop(MONITOR_REASONS.claimUnavailable, 'skipped');
  }
  progress.hostOpened = true;
  await step(progress, MONITOR_REASONS.hostStartFailed, async () => {
    await page.locator('#btn-setup-confirm:not([disabled])').waitFor({ state: 'visible', timeout });
    await page.locator('#btn-setup-confirm').click({ timeout });
    await page.locator('#setup-overlay.active').waitFor({ state: 'hidden', timeout });
  });
  return code;
}

async function openGuestPage(
  context: BrowserContext,
  lines: string[],
  progress: FlowProgress,
): Promise<Page> {
  const page = await step(progress, MONITOR_REASONS.guestPageFailed, () => context.newPage());
  watchPage(page, 'guest', lines);
  const opened = await openStartScreen(page, '#btn-setup-guest');
  if (opened.outcome === 'skipped') throw new FlowStop(opened.reason, 'skipped');
  if (opened.outcome !== 'ok') throw new FlowStop(MONITOR_REASONS.guestPageFailed);
  return page;
}

async function joinGuest(page: Page, code: string, progress: FlowProgress): Promise<void> {
  const timeout = STATUS_BROWSER_STEP_TIMEOUT_MS;
  await step(progress, MONITOR_REASONS.guestJoinFailed, async () => {
    await page.locator('#btn-setup-guest').click({ timeout });
    await page.locator('#setup-join-area').waitFor({ state: 'visible', timeout });
    await page.locator('#setup-join-code').fill(code, { timeout });
    await page.locator('#btn-setup-confirm').click({ timeout });
    await page.locator('#setup-overlay.active').waitFor({ state: 'hidden', timeout });
  });
}

async function dismissFirstRunDialog(page: Page, progress: FlowProgress): Promise<void> {
  const overlay = page.locator('#dialog-overlay.show');
  try {
    await overlay.waitFor({ state: 'visible', timeout: STATUS_MONITOR_DIALOG_WAIT_MS });
  } catch {
    return;
  }
  await step(progress, MONITOR_REASONS.dialogBlocked, async () => {
    const secondary = page.locator('#btn-dialog-secondary');
    if (!(await secondary.isVisible())) throw new FlowStop(MONITOR_REASONS.dialogBlocked);
    await secondary.click({ timeout: STATUS_BROWSER_STEP_TIMEOUT_MS });
    await overlay.waitFor({ state: 'hidden', timeout: STATUS_BROWSER_STEP_TIMEOUT_MS });
  });
}

/** One chat message from one page, which must arrive on the other. */
async function sendChat(
  from: Page,
  to: Page,
  message: string,
  reason: string,
  progress: FlowProgress,
): Promise<void> {
  const timeout = STATUS_BROWSER_STEP_TIMEOUT_MS;
  await step(progress, reason, async () => {
    const input = from.locator('#chat-input');
    await input.waitFor({ state: 'visible', timeout });
    await input.fill(message, { timeout });
    await from.locator('#btn-chat-send').click({ timeout });
    await to
      .locator('#chat-messages', { hasText: message })
      .waitFor({ state: 'attached', timeout });
  });
}

async function runConnectionFlow(
  hostPage: Page,
  guestContext: BrowserContext,
  gate: ClaimGate,
  guestLines: string[],
  progress: FlowProgress,
): Promise<{ readonly outcome: ConnectionFlowOutcome; readonly guestPage: Page | null }> {
  let guestPage: Page | null = null;
  try {
    const [host, guest] = await Promise.allSettled([
      startHost(hostPage, gate, progress),
      openGuestPage(guestContext, guestLines, progress),
    ]);
    if (guest.status === 'fulfilled') guestPage = guest.value;
    if (host.status === 'rejected') throw host.reason;
    if (guest.status === 'rejected') throw guest.reason;
    const guestReady = guest.value;
    await joinGuest(guestReady, host.value, progress);
    await Promise.all([
      dismissFirstRunDialog(hostPage, progress),
      dismissFirstRunDialog(guestReady, progress),
    ]);
    const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
    await sendChat(
      hostPage,
      guestReady,
      `Status check ${nonce} from the host`,
      MONITOR_REASONS.chatToGuestFailed,
      progress,
    );
    await sendChat(
      guestReady,
      hostPage,
      `Status check ${nonce} from the guest`,
      MONITOR_REASONS.chatToHostFailed,
      progress,
    );
    return { outcome: { ok: true }, guestPage };
  } catch (error) {
    const stop = error instanceof FlowStop ? error : new FlowStop(progress.reason);
    return {
      outcome: {
        ok: false,
        outcome: stop.outcome,
        reason: stop.reason,
        hostOpened: progress.hostOpened,
      },
      guestPage,
    };
  }
}

async function checkConnection(
  deps: StatusMonitorDeps,
  hostPage: Page,
  hostLines: readonly string[],
  guestContext: BrowserContext,
  gate: ClaimGate,
): Promise<MonitorResult> {
  const progress: FlowProgress = { reason: MONITOR_REASONS.hostStartFailed, hostOpened: false };
  const guestLines: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), STATUS_MONITOR_CONNECTION_BUDGET_MS);
  });
  const flow = runConnectionFlow(hostPage, guestContext, gate, guestLines, progress);
  const finished = await Promise.race([flow, budget]).finally(() => clearTimeout(timer));
  const outcome: ConnectionFlowOutcome = finished?.outcome ?? {
    ok: false,
    outcome: 'fail',
    reason: MONITOR_REASONS.connectionTimeout,
    hostOpened: progress.hostOpened,
  };
  const result = connectionResult(outcome, gate.summary());
  if (!outcome.ok) {
    log(deps, `connection flow stopped at ${outcome.reason}`);
    await printDiagnostics(deps, 'host', hostPage, hostLines);
    await printDiagnostics(deps, 'guest', finished?.guestPage ?? null, guestLines);
  }
  return result;
}

async function runBrowserChecks(
  deps: StatusMonitorDeps,
  gate: ClaimGate,
): Promise<{ readonly website: MonitorResult; readonly connection: MonitorResult }> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const hostContext = await newMonitorContext(browser, gate);
    const guestContext = await newMonitorContext(browser, null);
    const hostPage = await hostContext.newPage();
    const hostLines: string[] = [];
    watchPage(hostPage, 'host', hostLines);

    const website = await openStartScreen(hostPage, '#btn-setup-host');
    if (website.outcome !== 'ok') {
      await printDiagnostics(deps, 'host', hostPage, hostLines);
      return { website, connection: connectionAfterWebsite(website) };
    }
    const connection = await checkConnection(deps, hostPage, hostLines, guestContext, gate);
    return { website, connection };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** One monitor run: the exit code the job ends with. */
export async function runStatusBrowserMonitor(
  deps: StatusMonitorDeps = nodeDeps(),
): Promise<0 | 1> {
  const startedAtMs = deps.now();
  const { preflight, answer } = await readStatusPreflight(deps);
  if (preflight === 'not-deployed') {
    annotate(
      deps,
      'notice',
      `GET /api/status answered ${describeAnswer(answer)} without schema 1; no checks ran.`,
    );
    return statusMonitorExitCode({ preflight, delivered: false, authRefused: false });
  }

  // Both tokens up front: a job without OIDC fails before it opens anything.
  const reportTokens = createOidcTokenSource(STATUS_REPORT_AUDIENCE, deps);
  const claimTokens = createOidcTokenSource(STATUS_CLAIM_AUDIENCE, deps);
  await reportTokens.get();
  await claimTokens.get();

  let website = MONITOR_MAINTENANCE;
  let connection = MONITOR_MAINTENANCE;
  let claimAuthRefused = false;
  if (preflight === 'maintenance') {
    log(deps, 'maintenance is on: reporting both rows as maintenance, opening nothing');
  } else {
    const gate = new ClaimGate({
      request: (roomId, signal) => requestStatusClaim(roomId, claimTokens, deps, signal),
      onVerdict: (verdict) => log(deps, `claim answered ${verdict}`),
    });
    ({ website, connection } = await runBrowserChecks(deps, gate));
    const summary = gate.summary();
    claimAuthRefused = summary.authRefused;
    log(
      deps,
      `claim gate: ${summary.claimed} claimed, ${summary.refused} host transports refused, ` +
        `${summary.unrecognized} unrecognized transports, bypass ${summary.bypassed ? 'yes' : 'no'}`,
    );
  }

  log(deps, `website: ${website.outcome} (${website.reason})`);
  log(deps, `connection: ${connection.outcome} (${connection.reason})`);
  for (const [row, result] of [
    ['Website and app', website],
    ['Device connections', connection],
  ] as const) {
    if (result.outcome === 'fail') annotate(deps, 'warning', `${row} failed: ${result.reason}`);
  }

  const delivery = await postStatusReport(
    buildStatusReport(startedAtMs, website, connection),
    reportTokens,
    deps,
  );
  if (delivery.delivered) {
    log(deps, `report delivered: ${describeDelivered(delivery.answer)}`);
  } else {
    annotate(
      deps,
      'error',
      `The report was not delivered: ${describeAnswer(delivery.answer)} after ` +
        `${delivery.attempts} attempt(s).`,
    );
  }
  if (claimAuthRefused) {
    annotate(deps, 'error', "The claim route refused this job's identity (401 or 403).");
  }
  return statusMonitorExitCode({
    preflight,
    delivered: delivery.delivered,
    authRefused: delivery.authRefused || claimAuthRefused,
  });
}

/** Ends the run without Node's own report, whose stack could show a URL or a room code. */
function failRun(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${annotation('error', sanitizeMonitorDiagnostic(message))}\n`);
  process.exit(1);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.on('uncaughtException', failRun);
  process.on('unhandledRejection', failRun);
  const exitCode = await runStatusBrowserMonitor().catch((error: unknown) => failRun(error));
  process.exit(exitCode);
}

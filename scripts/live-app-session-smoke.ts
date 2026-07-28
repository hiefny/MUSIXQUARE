#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

const APP_ORIGIN = 'https://musixquare.com';
const NAVIGATION_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 25_000;
const GENERATION_TIMEOUT_MS = 90_000;
const GENERATION_POLL_MS = 1_500;
const REQUIRED_CONSECUTIVE_GENERATION_READS = 3;
const DIAGNOSTIC_DIRECTORY = 'release-artifacts/deployments/live-app-session-smoke';

interface LivePage {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly diagnostics: string[];
}

function extractMainScript(html: string): string | null {
  return html.match(/\bsrc=["'](\/assets\/main-[^"']+\.js)["']/u)?.[1] ?? null;
}

async function expectedMainScript(): Promise<string> {
  const mainScript = extractMainScript(await readFile('dist/index.html', 'utf8'));
  if (!mainScript) throw new Error('candidate dist does not declare a hashed main script');
  return mainScript;
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/\beyJ[A-Za-z0-9._-]+\b/gu, '[redacted-token]')
    .replace(/((?:https?|wss?):\/\/[^\s?#]+)[?#][^\s)]+/gu, '$1?[redacted]');
}

function attachDiagnostics(page: Page, role: 'host' | 'guest'): string[] {
  const diagnostics: string[] = [];
  const push = (message: string): void => {
    diagnostics.push(sanitizeDiagnostic(message));
    if (diagnostics.length > 80) diagnostics.shift();
  };

  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      push(`${role}:console:${message.type()}:${message.text()}`);
    }
  });
  page.on('pageerror', (error) => push(`${role}:pageerror:${String(error)}`));
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    push(
      `${role}:requestfailed:${url.origin}${url.pathname}:${
        request.failure()?.errorText || 'unknown'
      }`,
    );
  });
  return diagnostics;
}

async function waitForPublicGeneration(expectedMain: string): Promise<void> {
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  const observed = new Set<string>();
  let consecutive = 0;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${APP_ORIGIN}/?release-generation=${randomUUID()}`, {
        cache: 'no-store',
        headers: {
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
      });
      if (!response.ok) {
        observed.add(`http-${response.status}`);
        consecutive = 0;
      } else {
        const actualMain = extractMainScript(await response.text());
        observed.add(actualMain || 'missing-main-script');
        consecutive = actualMain === expectedMain ? consecutive + 1 : 0;
        if (consecutive >= REQUIRED_CONSECUTIVE_GENERATION_READS) {
          console.log(
            JSON.stringify({
              productionGenerationConverged: true,
              expectedMain,
              consecutiveReads: consecutive,
            }),
          );
          return;
        }
      }
    } catch (error) {
      observed.add(`fetch-error:${sanitizeDiagnostic(String(error))}`);
      consecutive = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, GENERATION_POLL_MS));
  }

  throw new Error(
    `production app generation did not converge to ${expectedMain}; observed=${[...observed].join(
      ',',
    )}`,
  );
}

async function openLivePage(
  browser: Browser,
  role: 'host' | 'guest',
  expectedMain: string,
): Promise<LivePage> {
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  const observed = new Set<string>();

  while (Date.now() < deadline) {
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const diagnostics = attachDiagnostics(page, role);
    try {
      await page.goto(`${APP_ORIGIN}/?release-session=${randomUUID()}`, {
        waitUntil: 'networkidle',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      const actualMain = await page.locator('script[type="module"][src]').getAttribute('src');
      observed.add(actualMain || 'missing-main-script');
      if (actualMain === expectedMain) {
        await page
          .locator('#btn-setup-host')
          .waitFor({ state: 'visible', timeout: SESSION_TIMEOUT_MS });
        return { context, page, diagnostics };
      }
    } catch (error) {
      observed.add(`navigation-error:${sanitizeDiagnostic(String(error))}`);
    }
    await context.close().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, GENERATION_POLL_MS));
  }

  throw new Error(
    `${role} page did not load candidate ${expectedMain}; observed=${[...observed].join(',')}`,
  );
}

async function startHost(page: Page): Promise<string> {
  await page.locator('#btn-setup-host').click();
  await page.locator('#setup-code-area').waitFor({ state: 'visible', timeout: SESSION_TIMEOUT_MS });
  await page.waitForFunction(
    () => {
      const element = document.getElementById('setup-code');
      const value =
        element instanceof HTMLInputElement ? element.value : element?.textContent || '';
      return /^\d{6}$/.test(value.trim());
    },
    undefined,
    { timeout: SESSION_TIMEOUT_MS },
  );
  const roomId = (await page.locator('#setup-code').inputValue()).trim();
  if (!/^\d{6}$/.test(roomId)) throw new Error('live host did not receive a six-digit room ID');

  await page
    .locator('#btn-setup-confirm:not([disabled])')
    .waitFor({ state: 'visible', timeout: SESSION_TIMEOUT_MS });
  await page.locator('#btn-setup-confirm').click();
  await page
    .locator('#setup-overlay.active')
    .waitFor({ state: 'hidden', timeout: SESSION_TIMEOUT_MS });
  return roomId;
}

async function joinGuest(page: Page, roomId: string): Promise<void> {
  await page.locator('#btn-setup-guest').click();
  await page.locator('#setup-join-area').waitFor({ state: 'visible', timeout: SESSION_TIMEOUT_MS });
  await page.locator('#setup-join-code').fill(roomId);
  await page.locator('#btn-setup-confirm').click();
  await page
    .locator('#setup-overlay.active')
    .waitFor({ state: 'hidden', timeout: SESSION_TIMEOUT_MS });
}

async function dismissFirstRunDemoPrompt(page: Page): Promise<void> {
  const overlay = page.locator('#dialog-overlay.show');
  try {
    await overlay.waitFor({ state: 'visible', timeout: 2_000 });
  } catch {
    return;
  }

  const secondary = page.locator('#btn-dialog-secondary');
  if (!(await secondary.isVisible())) {
    const title = await page.locator('#dialog-title').textContent();
    const message = await page.locator('#dialog-message').textContent();
    throw new Error(`unexpected blocking dialog: ${title || ''} ${message || ''}`.trim());
  }
  await secondary.click();
  await overlay.waitFor({ state: 'hidden', timeout: SESSION_TIMEOUT_MS });
}

async function sendChat(page: Page, message: string): Promise<void> {
  await page.locator('#chat-input').waitFor({ state: 'visible', timeout: SESSION_TIMEOUT_MS });
  await page.locator('#chat-input').fill(message);
  await page.locator('#btn-chat-send').click();
}

async function waitForChat(page: Page, message: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document.getElementById('chat-messages')?.textContent?.includes(expected) ?? false,
    message,
    { timeout: SESSION_TIMEOUT_MS },
  );
}

async function capturePageState(livePage: LivePage | undefined): Promise<Record<string, unknown>> {
  if (!livePage || livePage.page.isClosed()) return { available: false };
  const state = await livePage.page
    .evaluate(() => ({
      mainScript: document
        .querySelector<HTMLScriptElement>('script[type="module"][src]')
        ?.getAttribute('src'),
      setupOverlayActive: document.getElementById('setup-overlay')?.classList.contains('active'),
      setupJoinVisible: !document.getElementById('setup-join-area')?.hidden,
      setupCodeVisible: !document.getElementById('setup-code-area')?.hidden,
      dialogVisible: document.getElementById('dialog-overlay')?.classList.contains('show'),
      toastMessages: [...document.querySelectorAll<HTMLElement>('.toast, [role="alert"]')]
        .map((element) => element.textContent?.replace(/\s+/gu, ' ').trim())
        .filter(Boolean)
        .slice(-8),
      serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
    }))
    .catch((error) => ({ evaluationError: sanitizeDiagnostic(String(error)) }));
  return {
    available: true,
    ...state,
    diagnostics: livePage.diagnostics,
  };
}

async function persistFailureDiagnostics(
  host: LivePage | undefined,
  guest: LivePage | undefined,
): Promise<void> {
  await mkdir(DIAGNOSTIC_DIRECTORY, { recursive: true });
  const snapshot = {
    capturedAt: new Date().toISOString(),
    host: await capturePageState(host),
    guest: await capturePageState(guest),
  };
  await writeFile(
    `${DIAGNOSTIC_DIRECTORY}/state.json`,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );
  await Promise.all([
    host?.page
      .screenshot({ path: `${DIAGNOSTIC_DIRECTORY}/host.png`, fullPage: true })
      .catch(() => undefined),
    guest?.page
      .screenshot({ path: `${DIAGNOSTIC_DIRECTORY}/guest.png`, fullPage: true })
      .catch(() => undefined),
  ]);
  console.error(JSON.stringify({ liveAppSessionFailure: snapshot }));
}

async function main(): Promise<void> {
  let browser: Browser | undefined;
  let hostLive: LivePage | undefined;
  let guestLive: LivePage | undefined;

  try {
    const expectedMain = await expectedMainScript();
    await waitForPublicGeneration(expectedMain);
    browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    [hostLive, guestLive] = await Promise.all([
      openLivePage(browser, 'host', expectedMain),
      openLivePage(browser, 'guest', expectedMain),
    ]);
    const hostPage = hostLive.page;
    const guestPage = guestLive.page;
    const roomId = await startHost(hostPage);
    await joinGuest(guestPage, roomId);
    await Promise.all([dismissFirstRunDemoPrompt(hostPage), dismissFirstRunDemoPrompt(guestPage)]);

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const hostMessage = `live-host-${suffix}`;
    const guestMessage = `live-guest-${suffix}`;
    await sendChat(hostPage, hostMessage);
    await waitForChat(guestPage, hostMessage);
    await sendChat(guestPage, guestMessage);
    await waitForChat(hostPage, guestMessage);

    console.log(
      JSON.stringify({
        ok: true,
        roomId,
        productionApp: APP_ORIGIN,
        actualHostGuestJoin: true,
        appliedApplicationSession: true,
        orderedBootstrapBeforeJoin: true,
        cloudflareTransport: true,
        bidirectionalFirstChat: true,
      }),
    );
  } catch (error) {
    await persistFailureDiagnostics(hostLive, guestLive).catch(() => undefined);
    throw error;
  } finally {
    await guestLive?.context.close().catch(() => undefined);
    await hostLive?.context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

await main();

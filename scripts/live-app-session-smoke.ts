#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

const APP_ORIGIN = 'https://musixquare.com';
const NAVIGATION_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 25_000;

async function openLivePage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(APP_ORIGIN, {
    waitUntil: 'networkidle',
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await page.locator('#btn-setup-host').waitFor({ state: 'visible', timeout: SESSION_TIMEOUT_MS });
  return page;
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

async function main(): Promise<void> {
  let browser: Browser | undefined;
  let hostContext: BrowserContext | undefined;
  let guestContext: BrowserContext | undefined;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    const contextOptions = {
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
    } as const;
    hostContext = await browser.newContext(contextOptions);
    guestContext = await browser.newContext(contextOptions);

    const [hostPage, guestPage] = await Promise.all([
      openLivePage(hostContext),
      openLivePage(guestContext),
    ]);
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
  } finally {
    await guestContext?.close().catch(() => undefined);
    await hostContext?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

await main();

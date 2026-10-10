import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test.use({ serviceWorkers: 'block' });

const ROOM_CODE = '000001';
const CLAIM = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
const FIRST_SCOPE = 'a'.repeat(43);
const SECOND_SCOPE = 'b'.repeat(43);
const COPY = {
  ko: {
    title: 'PRO 방을 등록할 계정',
    primary: '이 계정으로 등록',
    secondary: '다른 계정으로 로그인',
  },
  en: {
    title: 'Choose an account for this PRO room',
    primary: 'Continue',
    secondary: 'Another account',
  },
} as const;

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  });
}

async function openClaim(
  page: Page,
  locale: keyof typeof COPY,
  options: { anonymous?: boolean; incomplete?: boolean } = {},
) {
  let nickname: string | null = options.anonymous ? null : options.incomplete ? '' : 'Minsu';
  let profileComplete = options.incomplete !== true;
  let scope = FIRST_SCOPE;
  const mutations: Array<{ body: unknown; scope: string | undefined }> = [];
  const profileUpdates: unknown[] = [];
  const unexpected: string[] = [];
  const googleStarts: string[] = [];
  let releaseAccountRead: (() => void) | undefined;
  const accountReadReady = options.incomplete
    ? new Promise<void>((resolve) => {
        releaseAccountRead = resolve;
      })
    : Promise.resolve();
  await page.addInitScript((language) => {
    localStorage.setItem('musixquare-lang', language);
    localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
    localStorage.setItem('musixquare-app-used-v1', '1');
  }, locale);
  // All API calls are synthetic. Never reach a real account or consume a claim.
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') {
      await accountReadReady;
      await json(route, {
        configured: true,
        authenticated: nickname !== null,
        account: nickname === null ? null : { nickname, profileComplete },
        statsScope: nickname === null ? null : scope,
      });
      return;
    }
    if (url.pathname === '/api/auth/google/start') {
      googleStarts.push(route.request().url());
      await route.fulfill({
        contentType: 'text/html',
        body: '<title>Local sign-in fixture</title>',
      });
      return;
    }
    if (url.pathname === '/api/auth/profile' && route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { nickname: string };
      profileUpdates.push(body);
      nickname = body.nickname;
      profileComplete = true;
      await json(route, {
        configured: true,
        authenticated: true,
        account: { nickname, profileComplete },
        statsScope: scope,
      });
      return;
    }
    if (url.pathname.endsWith(`/v1/rooms/${ROOM_CODE}/bootstrap`)) {
      await json(route, { roomCode: ROOM_CODE, status: 'activation_required' });
      return;
    }
    if (url.pathname.endsWith(`/v1/rooms/${ROOM_CODE}/activation`)) {
      mutations.push({
        body: route.request().postDataJSON(),
        scope: route.request().headers()['x-mxqr-account-expected-scope'],
      });
      // Stop at the HTTP boundary; no synthetic room connection is necessary.
      await json(route, { error: 'ACCOUNT_SESSION_CHANGED' }, 409);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await json(route, { error: 'LOCAL_FIXTURE_UNAVAILABLE' }, 503);
      return;
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      unexpected.push(url.origin);
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.goto(`/${ROOM_CODE}#pro-claim=${CLAIM}`);
  await page.locator('#btn-setup-confirm:not([disabled])').click();
  // Let the pending cookie-session read arrive after entry starts. The account
  // UI and PRO flow must share one nickname prompt when both discover it.
  releaseAccountRead?.();
  await expect(page.locator('#dialog-title')).toHaveText(
    options.incomplete ? 'Set nickname' : COPY[locale].title,
  );
  await expect(page.locator('.dialog-input-segment')).toHaveCount(0);
  expect(mutations).toEqual([]);
  return {
    mutations,
    profileUpdates,
    googleStarts,
    unexpected,
    setAccount(nextNickname: string, nextScope = SECOND_SCOPE) {
      nickname = nextNickname;
      scope = nextScope;
    },
  };
}

async function assertStackedActions(page: Page, locale: keyof typeof COPY): Promise<void> {
  const dialog = page.locator('#dialog-overlay.show');
  await expect(dialog.locator('button:visible')).toHaveCount(2);
  await expect(page.locator('#btn-dialog-ok')).toHaveText(COPY[locale].primary);
  await expect(page.locator('#btn-dialog-secondary')).toHaveText(COPY[locale].secondary);
  await page.evaluate(() => document.fonts.ready);
  const metrics = await dialog.evaluate((overlay) => {
    const buttons = [...overlay.querySelectorAll<HTMLButtonElement>('button:not([hidden])')];
    const actionBox = buttons[0]!.parentElement!;
    const style = getComputedStyle(actionBox);
    const availableWidth =
      actionBox.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return {
      availableWidth,
      buttons: buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(button);
        const lineTops = new Set([...text.getClientRects()].map((line) => Math.round(line.top)));
        return {
          id: button.id,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          clientWidth: button.clientWidth,
          scrollWidth: button.scrollWidth,
          clientHeight: button.clientHeight,
          scrollHeight: button.scrollHeight,
          textLineCount: lineTops.size,
        };
      }),
    };
  });
  expect(metrics.buttons.map((button) => button.id)).toEqual([
    'btn-dialog-ok',
    'btn-dialog-secondary',
  ]);
  const [primary, secondary] = metrics.buttons;
  expect(secondary!.y).toBeGreaterThanOrEqual(primary!.y + primary!.height + 9);
  expect(Math.abs(primary!.x - secondary!.x)).toBeLessThan(1);
  for (const button of metrics.buttons) {
    expect(Math.abs(button.width - metrics.availableWidth)).toBeLessThan(1);
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
    expect(button.scrollHeight).toBeLessThanOrEqual(button.clientHeight);
    expect(button.textLineCount, `${button.id} must keep its complete label on one line`).toBe(1);
  }
}

test.describe('PRO activation account confirmation', () => {
  for (const locale of ['ko', 'en'] as const) {
    for (const width of [320, 360, 390, 1180]) {
      test(`${locale} ${width}px: confirms the account and activates directly without a PIN`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 820 });
        const state = await openClaim(page, locale);
        await expect(page.locator('#dialog-message')).toContainText('Minsu');
        await assertStackedActions(page, locale);
        if (process.env.MXQR_ACCOUNT_PREVIEW_DIR && width === 320) {
          await mkdir(process.env.MXQR_ACCOUNT_PREVIEW_DIR, { recursive: true });
          await page.locator('#dialog-overlay.show .dialog').screenshot({
            path: resolve(process.env.MXQR_ACCOUNT_PREVIEW_DIR, `account-${locale}-320.png`),
            animations: 'disabled',
          });
        }
        await page.locator('#btn-dialog-ok').click();
        await expect.poll(() => state.mutations.length).toBe(1);
        expect(state.mutations[0]!.body).toEqual({
          claimToken: CLAIM,
          ownerName: expect.any(String),
        });
        expect(state.mutations[0]!.scope).toBe(FIRST_SCOPE);
        await expect(page.locator('#dialog-title')).toHaveText(COPY[locale].title);
        await expect(page.locator('.dialog-input-segment')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(page.locator('#dialog-overlay')).not.toHaveClass(/show/u);
        expect(state.mutations).toHaveLength(1);
      });
    }
  }

  test('anonymous sign-in returns to explicit account confirmation before activation', async ({
    page,
  }) => {
    const state = await openClaim(page, 'en', { anonymous: true });
    await expect(page.locator('#dialog-message')).not.toContainText('Minsu');
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#btn-dialog-ok').click();
    const popup = await popupPromise;
    await expect(popup).toHaveTitle('Local sign-in fixture');
    expect(popup.url()).not.toContain(CLAIM);
    state.setAccount('Jisoo');
    await popup.close();
    await expect(page.locator('#dialog-message')).toContainText('Jisoo');
    await expect(page.locator('.dialog-input-segment')).toHaveCount(0);
    await assertStackedActions(page, 'en');
    await page.locator('#btn-dialog-ok').click();
    await expect.poll(() => state.mutations.length).toBe(1);
    expect(state.mutations[0]!.body).toEqual({ claimToken: CLAIM, ownerName: expect.any(String) });
    await expect(page.locator('.dialog-input-segment')).toHaveCount(0);
  });

  test('an already signed-in account completes its nickname before consent without another Google login', async ({
    page,
  }) => {
    const state = await openClaim(page, 'en', { incomplete: true });
    await expect(page.locator('#dialog-overlay.show')).toHaveCount(1);
    await expect(page.locator('.dialog-input')).toHaveCount(1);
    expect(state.googleStarts).toEqual([]);
    expect(state.mutations).toEqual([]);
    await page.locator('.dialog-input').fill('Jisoo');
    await page.locator('#btn-dialog-ok').click();
    await expect(page.locator('#dialog-title')).toHaveText(COPY.en.title);
    await expect(page.locator('#dialog-message')).toContainText('Jisoo');
    await expect(page.locator('.dialog-input-segment')).toHaveCount(0);
    expect(state.profileUpdates).toEqual([{ nickname: 'Jisoo' }]);
    expect(state.googleStarts).toEqual([]);
    expect(state.mutations).toEqual([]);
    await page.locator('#btn-dialog-ok').click();
    await expect.poll(() => state.mutations.length).toBe(1);
    expect(state.mutations[0]!.body).toEqual({ claimToken: CLAIM, ownerName: expect.any(String) });
    await expect(page.locator('.dialog-input-segment')).toHaveCount(0);
  });

  test('switching accounts opens a popup from Enter and requires fresh confirmation', async ({
    page,
  }) => {
    const state = await openClaim(page, 'ko');
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#btn-dialog-secondary').focus();
    await page.keyboard.press('Enter');
    const popup = await popupPromise;
    await expect(popup).toHaveTitle('Local sign-in fixture');
    expect(popup.url()).not.toContain(CLAIM);
    state.setAccount('Jisoo');
    await popup.close();
    await expect(page.locator('#dialog-message')).toContainText('Jisoo');
    await expect(page.locator('.dialog-input-segment')).toHaveCount(0);
    expect(state.mutations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#dialog-overlay')).not.toHaveClass(/show/u);
    expect(state.mutations).toEqual([]);
  });

  test('a server account change before activation reconfirms identity without a PIN', async ({
    page,
  }) => {
    const state = await openClaim(page, 'en');
    state.setAccount('Jisoo');
    await page.locator('#btn-dialog-ok').click();
    await expect.poll(() => state.mutations.length).toBe(1);
    expect(state.mutations[0]!.scope).toBe(FIRST_SCOPE);
    expect(state.mutations[0]!.body).not.toHaveProperty('newPin');
    await expect(page.locator('#dialog-message')).toContainText('Jisoo');
    await expect(page.locator('.dialog-input-segment')).toHaveCount(0);
    await page.locator('#btn-dialog-ok').click();
    await expect.poll(() => state.mutations.length).toBe(2);
    expect(state.mutations[1]!.scope).toBe(SECOND_SCOPE);
    expect(state.mutations[1]!.body).toEqual({ claimToken: CLAIM, ownerName: expect.any(String) });
    await expect(page.locator('.dialog-input-segment')).toHaveCount(0);
  });
});

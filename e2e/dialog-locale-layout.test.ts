import { expect, test, type Page } from '@playwright/test';
import en from '../src/i18n/en.ts';
import ko from '../src/i18n/ko.ts';

// These synthetic account/API routes must reach Playwright. A controlling
// service worker can bypass route interception; SW behavior has separate tests.
test.use({ serviceWorkers: 'block' });

async function localAccount(page: Page, incomplete: boolean) {
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session')
      return route.fulfill({
        json: {
          configured: true,
          authenticated: true,
          account: { nickname: incomplete ? '' : 'Local', profileComplete: !incomplete },
          statsScope: 'a'.repeat(43),
        },
      });
    if (url.pathname.endsWith('/v1/rooms/000001/bootstrap'))
      return route.fulfill({ json: { roomCode: '000001', status: 'activation_required' } });
    if (url.pathname.startsWith('/api/'))
      return route.fulfill({ status: 503, json: { error: 'LOCAL_FIXTURE_UNAVAILABLE' } });
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('musixquare-lang', 'system');
    localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
    localStorage.setItem('musixquare-app-used-v1', '1');
    Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true });
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
  });
}

for (const height of [280, 220]) {
  test(`PRO PIN actions remain reachable by pointer at 320 by ${height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await localAccount(page, false);
    await page.goto(`/000001#pro-claim=${'a'.repeat(32)}.${'b'.repeat(43)}`);
    await page.locator('#btn-setup-confirm:not([disabled])').click();
    await expect(page.locator('#dialog-title')).toHaveText('Choose an account for this PRO room');
    await page.locator('#btn-dialog-ok').click();
    const segments = page.locator('.dialog-input-segment');
    await expect(segments).toHaveCount(2);
    await segments.first().press('Enter');
    await expect(page.locator('#dialog-input-hint')).not.toBeEmpty();
    await page.evaluate(() => document.fonts.ready);
    await page.setViewportSize({ width: 320, height });
    await page.waitForFunction(() =>
      document
        .getElementById('dialog-overlay')!
        .getAnimations({ subtree: true })
        .every((animation) => ['finished', 'idle'].includes(animation.playState)),
    );
    const primary = page.locator('#btn-dialog-ok');
    await primary.scrollIntoViewIfNeeded();
    const metrics = await primary.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const panel = button.closest('.dialog')!;
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: innerHeight,
        panelTop: panel.getBoundingClientRect().top,
        panelBottom: panel.getBoundingClientRect().bottom,
        scrollTop: panel.scrollTop,
        pointerHit:
          document
            .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            ?.closest('button') === button,
      };
    });
    expect(metrics.top).toBeGreaterThanOrEqual(0);
    expect(metrics.bottom).toBeLessThanOrEqual(height);
    expect(metrics.panelTop).toBeGreaterThanOrEqual(0);
    expect(metrics.panelBottom).toBeLessThanOrEqual(height);
    expect(metrics.pointerHit).toBe(true);
    await info.attach('PIN scroll geometry', {
      body: JSON.stringify(metrics),
      contentType: 'application/json',
    });
    await primary.click();
    await expect(page.locator('#dialog-overlay')).toHaveClass(/show/);
    // Revisit the editor and return to Cancel without losing the typed digits.
    await segments.first().fill('1234');
    await segments.last().fill('5678');
    await expect(segments.first()).toHaveValue('1234');
    await expect(segments.last()).toHaveValue('5678');
    await page.locator('#btn-dialog-secondary').click();
    await expect(page.locator('#dialog-overlay')).not.toHaveClass(/show/);
  });
}

test('system language change refreshes the open nickname dialog without consuming its draft', async ({
  page,
}) => {
  await localAccount(page, true);
  await page.goto('/');
  const input = page.locator('.dialog-input');
  await expect(page.locator('#dialog-title')).toHaveText(en['account.nickname_title']);
  await page.locator('#btn-dialog-ok').click();
  await expect(page.locator('#dialog-input-hint')).toHaveText(en['account.nickname_required']);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { value: ['ko-KR'], configurable: true });
    Object.defineProperty(navigator, 'language', { value: 'ko-KR', configurable: true });
    window.dispatchEvent(new Event('languagechange'));
  });
  await expect(page.locator('#dialog-title')).toHaveText(ko['account.nickname_title']);
  await expect(page.locator('#dialog-message')).toContainText(ko['account.nickname_message']);
  await expect(input).toHaveAttribute('data-placeholder', ko['account.nickname_placeholder']);
  await expect(input).toHaveAttribute('aria-label', ko['account.nickname_placeholder']);
  await expect(page.locator('#btn-dialog-ok')).toHaveText(ko['common.ok']);
  await expect(page.locator('#btn-dialog-secondary')).toHaveText(ko['common.later']);
  await expect(page.locator('#dialog-input-hint')).toHaveText(ko['account.nickname_required']);
  await input.fill('My draft');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true });
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    window.dispatchEvent(new Event('languagechange'));
  });
  await expect(input).toHaveText('My draft');
  await expect(input).toBeFocused();
  await expect(page.locator('#dialog-title')).toHaveText(en['account.nickname_title']);
  await expect(page.locator('#dialog-input-hint')).toHaveText(en['account.nickname_hint']);
  await page.locator('#btn-dialog-secondary').click();
  await expect(page.locator('#dialog-overlay')).not.toHaveClass(/show/);
});

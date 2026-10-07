import { expect, test } from '@playwright/test';
import ja from '../src/i18n/ja.ts';
import ar from '../src/i18n/ar.ts';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

// A fresh non-controlled document isolates one transient first request; the
// production/SW-allowed recovery variants are also retained in repair evidence.
test.use({ serviceWorkers: 'block' });

test('a failed locale module recovers through public re-selection without reloading', async ({
  page,
}) => {
  let failedRequests = 0;
  const recoveryRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/locale-recovery-ja-[^/]+\.json$/u.test(request.url()))
      recoveryRequests.push(request.url());
  });
  await page.route(/\/ja-[^/]+\.js$/u, (route) => {
    failedRequests += 1;
    return route.abort('failed');
  });
  await page.goto('/en/');
  await waitForBootstrapReady(page);
  await page.evaluate(() => {
    document.documentElement.dataset.recoveryDocument = 'same-document';
  });
  await page.locator('[data-setup-language-trigger]:visible').click();
  await page.locator('.language-option[data-lang="ja"]').click();
  await expect.poll(() => failedRequests).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.locator('.language-option[data-lang="en"]').click();
  await page.locator('.language-option[data-lang="ja"]').click();
  await expect(page.locator('#btn-setup-host')).toHaveText(ja['setup.host_button']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('html')).toHaveAttribute('data-recovery-document', 'same-document');
  expect(recoveryRequests).toHaveLength(1);
  expect(failedRequests).toBe(1);
});

test('a failed optional font CSS retries its immutable URL at a later render', async ({ page }) => {
  let requests = 0;
  let allowRetry = false;
  const urls: string[] = [];
  await page.route(/\/noto-arabic-[^/]+\.css$/u, (route) => {
    requests += 1;
    urls.push(route.request().url());
    return allowRetry ? route.continue() : route.abort('failed');
  });
  await page.goto('/ar/');
  await waitForBootstrapReady(page);
  await expect(page.locator('#btn-setup-host')).toHaveText(ar['setup.host_button']);
  await expect.poll(() => requests).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      async () => (await document.fonts.load('750 15px "Noto Sans Arabic"', 'العربية')).length,
    ),
  ).toBe(0);
  const failedRequests = requests;
  // Bootstrap may render again after the first failure. Keep the outage in
  // place until this explicit public retry, independent of that render count.
  allowRetry = true;
  await page.locator('[data-setup-language-trigger]:visible').click();
  await page.locator('.language-option[data-lang="en"]').click();
  await page.locator('.language-option[data-lang="ar"]').click();
  await page.locator('#btn-language-dialog-done').click();
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await document.fonts.load('750 15px "Noto Sans Arabic"', 'العربية')).length,
      ),
    )
    .toBeGreaterThan(0);
  expect(requests).toBeGreaterThan(failedRequests);
  expect(new Set(urls).size).toBe(1);
});

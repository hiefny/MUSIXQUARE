import { expect, test } from '@playwright/test';
import {
  BootstrapReadinessError,
  waitForBootstrapCachedNavigationFallback,
} from './helpers/bootstrap.ts';

test('cached-navigation observation waits for a late Worker fallback publication', async ({
  page,
}) => {
  await page.setContent(
    '<html data-bootstrap-state="ready" data-bootstrap-step-count="52" data-bootstrap-failure-count="0" data-bootstrap-fallback-count="0"><body></body></html>',
  );
  await page.evaluate(() => {
    setTimeout(() => {
      Object.assign(document.documentElement.dataset, {
        bootstrapState: 'degraded',
        bootstrapStepCount: '53',
        bootstrapFailureCount: '0',
        bootstrapFallbackCount: '1',
        bootstrapFallbacks: 'CachedNavigation',
      });
    }, 150);
  });
  await waitForBootstrapCachedNavigationFallback(page);
});

test('cached-navigation observation rejects a ready page that never reports fallback', async ({
  page,
}) => {
  await page.setContent(
    '<html data-bootstrap-state="ready" data-bootstrap-step-count="52" data-bootstrap-failure-count="0" data-bootstrap-fallback-count="0"><body></body></html>',
  );
  await expect(waitForBootstrapCachedNavigationFallback(page, 300)).rejects.toThrow();
});

test('cached-navigation observation still rejects an additional bootstrap failure', async ({
  page,
}) => {
  await page.setContent(
    '<html data-bootstrap-state="degraded" data-bootstrap-step-count="53" data-bootstrap-failure-count="1" data-bootstrap-fallback-count="1" data-bootstrap-fallbacks="CachedNavigation"><body></body></html>',
  );
  await expect(waitForBootstrapCachedNavigationFallback(page)).rejects.toBeInstanceOf(
    BootstrapReadinessError,
  );
});

test('cached-navigation observation still rejects an aborted bootstrap', async ({ page }) => {
  await page.setContent(
    '<html data-bootstrap-state="aborted" data-bootstrap-step-count="0" data-bootstrap-failure-count="1" data-bootstrap-fallback-count="0"><body></body></html>',
  );
  await expect(waitForBootstrapCachedNavigationFallback(page)).rejects.toBeInstanceOf(
    BootstrapReadinessError,
  );
});

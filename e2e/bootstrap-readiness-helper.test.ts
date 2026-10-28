import { expect, test } from '@playwright/test';
import {
  BootstrapReadinessError,
  EXPECTED_BOOTSTRAP_STEP_COUNT,
  waitForBootstrapReady,
  waitForBootstrapCachedNavigationFallback,
} from './helpers/bootstrap.ts';

// The helper owns the eager step count, and every app test that waits for a
// clean bootstrap holds it against the real app. These tests check only how
// the helper judges an observation, so they read the count from it.
const STEPS = EXPECTED_BOOTSTRAP_STEP_COUNT;

test('clean bootstrap requires exactly the expected eager step count', async ({ page }) => {
  for (const count of [STEPS - 1, STEPS, STEPS + 1]) {
    await page.setContent(
      `<html data-bootstrap-state="ready" data-bootstrap-step-count="${count}" data-bootstrap-failure-count="0" data-bootstrap-fallback-count="0"><body></body></html>`,
    );
    if (count === STEPS) await waitForBootstrapReady(page);
    else await expect(waitForBootstrapReady(page)).rejects.toBeInstanceOf(BootstrapReadinessError);
  }
});

test('cached-navigation observation waits for a late Worker fallback publication', async ({
  page,
}) => {
  await page.setContent(
    `<html data-bootstrap-state="ready" data-bootstrap-step-count="${STEPS}" data-bootstrap-failure-count="0" data-bootstrap-fallback-count="0"><body></body></html>`,
  );
  await page.evaluate((steps) => {
    setTimeout(() => {
      Object.assign(document.documentElement.dataset, {
        bootstrapState: 'degraded',
        bootstrapStepCount: String(steps + 1),
        bootstrapFailureCount: '0',
        bootstrapFallbackCount: '1',
        bootstrapFallbacks: 'CachedNavigation',
      });
    }, 150);
  }, STEPS);
  await waitForBootstrapCachedNavigationFallback(page);
});

test('cached-navigation observation rejects a ready page that never reports fallback', async ({
  page,
}) => {
  await page.setContent(
    `<html data-bootstrap-state="ready" data-bootstrap-step-count="${STEPS}" data-bootstrap-failure-count="0" data-bootstrap-fallback-count="0"><body></body></html>`,
  );
  await expect(waitForBootstrapCachedNavigationFallback(page, 300)).rejects.toThrow();
});

test('cached-navigation observation still rejects an additional bootstrap failure', async ({
  page,
}) => {
  await page.setContent(
    `<html data-bootstrap-state="degraded" data-bootstrap-step-count="${STEPS + 1}" data-bootstrap-failure-count="1" data-bootstrap-fallback-count="1" data-bootstrap-fallbacks="CachedNavigation"><body></body></html>`,
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

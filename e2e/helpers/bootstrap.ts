import type { Page } from '@playwright/test';
import { BOOTSTRAP_REQUIRED_STEPS } from '../../src/core/bootstrap-contract.ts';

interface BootstrapObservation {
  state: string | null;
  stepCount: string | null;
  failureCount: string | null;
  fallbackCount: string | null;
  failures: string | null;
  fallbacks: string | null;
}

export class BootstrapReadinessError extends Error {
  override name = 'BootstrapReadinessError';
}

async function readBootstrapObservation(page: Page): Promise<BootstrapObservation> {
  return page.locator('html').evaluate<BootstrapObservation>((root) => ({
    state: root.getAttribute('data-bootstrap-state'),
    stepCount: root.getAttribute('data-bootstrap-step-count'),
    failureCount: root.getAttribute('data-bootstrap-failure-count'),
    fallbackCount: root.getAttribute('data-bootstrap-fallback-count'),
    failures: root.getAttribute('data-bootstrap-failures'),
    fallbacks: root.getAttribute('data-bootstrap-fallbacks'),
  }));
}

function formatBootstrapObservation(observation: BootstrapObservation): string {
  return (
    `state=${observation.state}, steps=${observation.stepCount}, ` +
    `failures=${observation.failureCount} [${observation.failures || '-'}], ` +
    `fallbacks=${observation.fallbackCount} [${observation.fallbacks || '-'}]`
  );
}

/** Wait for an explicit terminal bootstrap observation and require a clean baseline. */
export async function waitForBootstrapReady(page: Page, timeout = 15_000): Promise<void> {
  try {
    await page
      .locator(
        'html[data-bootstrap-state="ready"], ' +
          'html[data-bootstrap-state="degraded"], ' +
          'html[data-bootstrap-state="aborted"]',
      )
      .waitFor({ state: 'attached', timeout });
  } catch {
    const observation = await readBootstrapObservation(page).catch(() => null);
    throw new Error(
      'Bootstrap did not reach a terminal state' +
        (observation ? `: ${formatBootstrapObservation(observation)}` : ''),
    );
  }

  const observation = await readBootstrapObservation(page);

  if (
    observation.state !== 'ready' ||
    observation.stepCount !== String(BOOTSTRAP_REQUIRED_STEPS.length) ||
    observation.failureCount !== '0' ||
    observation.fallbackCount !== '0'
  ) {
    throw new BootstrapReadinessError(
      `Bootstrap baseline was not ready: ${formatBootstrapObservation(observation)}`,
    );
  }
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isBenignPageError } from '../../../e2e/helpers/page-errors.ts';

describe('Playwright page-error allowlist', () => {
  it('keeps exact production Chromium and WebKit lifecycle smoke page-error aware', () => {
    const candidateSmoke = readFileSync(resolve('e2e/production-candidate-smoke.test.ts'), 'utf8');
    expect(candidateSmoke).toContain('trackPageErrors(page)');
    expect(candidateSmoke).toContain('expect(getPageErrors(page)).toEqual([])');
  });

  it.each([
    'ResizeObserver loop limit exceeded',
    'ResizeObserver loop completed with undelivered notifications.',
  ])('allows only the exact browser-authored diagnostic: %s', (message) => {
    expect(isBenignPageError(message)).toBe(true);
  });

  it.each([
    'ReferenceError: ServiceWorker registration state is undefined',
    'service-worker bootstrap crashed',
    'ResizeObserver callback threw TypeError',
    'ResizeObserver loop limit exceeded after app mutation',
  ])('keeps application failures visible: %s', (message) => {
    expect(isBenignPageError(message)).toBe(false);
  });
});

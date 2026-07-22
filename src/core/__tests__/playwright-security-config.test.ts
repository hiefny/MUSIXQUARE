import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Playwright browser security profile', () => {
  it('keeps browser web security enabled for release and general E2E', () => {
    const config = readFileSync(resolve('playwright.config.ts'), 'utf8');
    expect(config).not.toContain('--disable-web-security');
  });
});

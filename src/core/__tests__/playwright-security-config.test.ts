import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Playwright browser security profile', () => {
  it('keeps browser web security enabled for release and general E2E', () => {
    const config = readFileSync(resolve('playwright.config.ts'), 'utf8');
    expect(config).not.toContain('--disable-web-security');
  });

  it('uses fresh dedicated local servers instead of unverified listeners', () => {
    for (const file of ['playwright.config.ts', 'playwright.webkit.config.ts']) {
      const config = readFileSync(resolve(file), 'utf8');
      expect(config).toContain('reuseExistingServer: false');
      expect(config).toContain('E2E_PREVIEW_COMMAND');
      expect(config).not.toContain('localhost:4173');
    }

    const globalSetup = readFileSync(resolve('e2e/global-setup.ts'), 'utf8');
    expect(globalSetup).toContain('refusing to reuse an unverified listener');
    expect(globalSetup).not.toContain('reusing existing PeerJS server');
  });
});

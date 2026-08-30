import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Playwright browser security profile', () => {
  it('forbids accidentally exclusive tests in every CI browser lane', () => {
    for (const file of [
      'playwright.config.ts',
      'playwright.candidate.config.ts',
      'playwright.webkit.config.ts',
      'playwright.webkit-service-worker.config.ts',
    ]) {
      expect(readFileSync(resolve(file), 'utf8'), file).toContain(
        'forbidOnly: Boolean(process.env.CI)',
      );
    }
  });

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

    const candidateConfig = readFileSync(resolve('playwright.candidate.config.ts'), 'utf8');
    expect(candidateConfig).toContain('reuseExistingServer: false');
    expect(candidateConfig).toContain('E2E_PRODUCTION_PREVIEW_COMMAND');

    const webkitServiceWorkerConfig = readFileSync(
      resolve('playwright.webkit-service-worker.config.ts'),
      'utf8',
    );
    expect(webkitServiceWorkerConfig).toContain('reuseExistingServer: false');
    expect(webkitServiceWorkerConfig).toContain('E2E_CONTROLLED_PRODUCTION_PREVIEW_COMMAND');

    const controlledPreview = readFileSync(resolve('e2e/controlled-production-preview.ts'), 'utf8');
    expect(controlledPreview).toContain("mode: 'production'");
    expect(controlledPreview).toContain('NAVIGATION_OUTAGE_QUERY_PARAMETER');
    expect(controlledPreview).toContain('NAVIGATION_OUTAGE_ARM_PATH');
    expect(controlledPreview).toContain('NAVIGATION_OUTAGE_RELEASE_PATH');
    expect(controlledPreview).toContain('navigationOutages.get(token)');
    expect(controlledPreview).toContain('releaseStalledNavigation');
    expect(controlledPreview).not.toContain('NAVIGATION_OUTAGE_SAFETY_TIMEOUT_MS');
    expect(controlledPreview).not.toContain('response.statusCode = 307');
    expect(controlledPreview).not.toContain('request.socket.destroy()');
    expect(controlledPreview).not.toContain('response.writeHead');
    expect(controlledPreview).not.toContain('vite build');
  });

  it('keeps production candidate smoke free of E2E-only state hooks', () => {
    const standardConfig = readFileSync(resolve('playwright.config.ts'), 'utf8');
    const candidateConfig = readFileSync(resolve('playwright.candidate.config.ts'), 'utf8');
    const candidateSmoke = readFileSync(resolve('e2e/production-candidate-smoke.test.ts'), 'utf8');
    const pageErrors = readFileSync(resolve('e2e/helpers/page-errors.ts'), 'utf8');
    const webkitServiceWorkerConfig = readFileSync(
      resolve('playwright.webkit-service-worker.config.ts'),
      'utf8',
    );

    expect(standardConfig).toContain("'production-candidate-smoke.test.ts'");
    expect(candidateConfig).toContain("serviceWorkers: 'allow'");
    expect(webkitServiceWorkerConfig).toContain("serviceWorkers: 'allow'");
    expect(webkitServiceWorkerConfig).not.toContain("serviceWorkers: 'block'");
    expect(candidateSmoke).toContain('await waitForBootstrapCachedNavigationFallback(page);');
    expect(candidateSmoke).not.toContain('setExtraHTTPHeaders');
    expect(candidateSmoke).toContain('WEBKIT_NAVIGATION_TIMEOUT_DIAGNOSTICS');
    expect(candidateSmoke).toContain('/api/auth/session due to access control checks.');
    expect(candidateSmoke).toContain(
      '/designsystem/fonts/PretendardVariable.woff2 due to access control checks.',
    );
    expect(pageErrors).not.toContain('access control checks');
  });

  it('owns the PeerJS child process through bounded Playwright cleanup', () => {
    const globalSetup = readFileSync(resolve('e2e/global-setup.ts'), 'utf8');

    expect(globalSetup).toContain('spawn(');
    expect(globalSetup).toContain('process.execPath');
    expect(globalSetup).toContain('shell: false');
    expect(globalSetup).toContain('windowsHide: true');
    expect(globalSetup).toContain('return cleanup;');
    expect(globalSetup).toContain('const PEER_READY_TIMEOUT_MS = 30_000;');
    expect(globalSetup).toContain('Date.now() + PEER_READY_TIMEOUT_MS');
    expect(globalSetup).toContain('PEER_TERMINATE_TIMEOUT_MS');
    expect(globalSetup).toContain("peerProcess.kill('SIGKILL')");
    expect(globalSetup).not.toContain("require('peer')");
    expect(globalSetup).not.toContain('__PEER_APP__');

    for (const file of ['playwright.config.ts', 'playwright.webkit.config.ts']) {
      const config = readFileSync(resolve(file), 'utf8');
      expect(config).not.toContain('globalTeardown');
    }
    expect(existsSync(resolve('e2e/global-teardown.ts'))).toBe(false);
  });
});

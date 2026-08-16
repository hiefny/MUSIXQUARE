import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AUXILIARY_BROWSER_ASSETS,
  compileAuxiliaryBrowserAsset,
} from '../../../scripts/auxiliary-browser-assets.ts';

describe('local E2E report contract', () => {
  it('clears stale output before opening the viewer and preserves the test exit code', () => {
    const batch = readFileSync(resolve('e2e/run-tests.bat'), 'utf8');
    const clearJson = batch.indexOf('del /q "e2e-report.json"');
    const clearScript = batch.indexOf('del /q "e2e\\e2e-report-data.js"');
    const materialize = batch.indexOf('node scripts\\materialize-auxiliary-browser-assets.mts');
    const materializeFailure = batch.indexOf('if errorlevel 1 exit /b %ERRORLEVEL%');
    const openViewer = batch.indexOf('start "" "%~dp0report-viewer.html"');

    expect(clearJson).toBeGreaterThan(-1);
    expect(clearScript).toBeGreaterThan(-1);
    expect(openViewer).toBeGreaterThan(clearJson);
    expect(openViewer).toBeGreaterThan(clearScript);
    expect(materialize).toBeGreaterThan(clearScript);
    expect(materializeFailure).toBeGreaterThan(materialize);
    expect(openViewer).toBeGreaterThan(materializeFailure);
    expect(batch).toContain('set "TEST_EXIT_CODE=%ERRORLEVEL%"');
    expect(batch).toContain('exit /b %TEST_EXIT_CODE%');
  });

  it('treats interrupted and suite-level failures as failures', async () => {
    const html = readFileSync(resolve('e2e/report-viewer.html'), 'utf8');
    const asset = AUXILIARY_BROWSER_ASSETS.find(
      (candidate) => candidate.outputPath === 'e2e/report-viewer.js',
    );
    if (!asset) throw new Error('Missing report viewer asset.');
    const script = (await compileAuxiliaryBrowserAsset(resolve('.'), asset)).code;

    expect(html).toContain('<script src="./report-viewer.js"></script>');
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/iu);
    expect(script).toMatch(/status === ["']interrupted["']/u);
    expect(script).toMatch(/finalStatus === ["']passed["']/u);
    expect(script).toMatch(/["']RUN FAILED["']/u);
    expect(() => new Function(script)).not.toThrow();
  });

  it('keeps device-specific WebKit tests out of desktop Chromium and preserves timeout artifacts', () => {
    const playwrightConfig = readFileSync(resolve('playwright.config.ts'), 'utf8');
    const workflow = readFileSync(resolve('.github/workflows/e2e.yml'), 'utf8');

    expect(playwrightConfig).toContain("testIgnore: ['webkit-mobile-smoke.test.ts']");
    expect(workflow).toContain('timeout-minutes: 180');
    expect(workflow).toContain('timeout-minutes: 165');
    expect(workflow).toContain('if: failure() || cancelled()');
  });
});

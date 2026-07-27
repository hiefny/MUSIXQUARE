import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('local E2E report contract', () => {
  it('clears stale output before opening the viewer and preserves the test exit code', () => {
    const batch = readFileSync(resolve('e2e/run-tests.bat'), 'utf8');
    const clearJson = batch.indexOf('del /q "e2e-report.json"');
    const clearScript = batch.indexOf('del /q "e2e\\e2e-report-data.js"');
    const openViewer = batch.indexOf('start "" "%~dp0report-viewer.html"');

    expect(clearJson).toBeGreaterThan(-1);
    expect(clearScript).toBeGreaterThan(-1);
    expect(openViewer).toBeGreaterThan(clearJson);
    expect(openViewer).toBeGreaterThan(clearScript);
    expect(batch).toContain('set "TEST_EXIT_CODE=%ERRORLEVEL%"');
    expect(batch).toContain('exit /b %TEST_EXIT_CODE%');
  });

  it('treats interrupted and suite-level failures as failures', () => {
    const html = readFileSync(resolve('e2e/report-viewer.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

    expect(script).toContain("status === 'interrupted'");
    expect(script).toContain("finalStatus === 'passed'");
    expect(script).toContain("'RUN FAILED'");
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

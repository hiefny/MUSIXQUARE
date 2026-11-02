/**
 * The local translation preview (.workshop/translate/dev/preview.config.ts)
 * serves translate.html with what the page links: the shared font sheets
 * and the classic scripts, /han-order.js among them, so the page draws Han
 * in the app's order and logs no 404 there.
 */
import { readFileSync } from 'node:fs';
import type { Plugin, UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';

import previewConfig from '../../../.workshop/translate/dev/preview.config.ts';

function servedPlugins(): Plugin[] {
  if (typeof previewConfig !== 'function') throw new Error('expected a config function');
  const config = previewConfig({
    command: 'serve',
    mode: 'development',
    isPreview: false,
    isSsrBuild: false,
  }) as UserConfig;
  return (config.plugins ?? []).flat() as Plugin[];
}

function servedPluginNames(): string[] {
  return servedPlugins().map(({ name }) => name);
}

describe('the local translation preview', () => {
  it('links /han-order.js before the shared font sheets', () => {
    const page = readFileSync('.workshop/translate/translate.html', 'utf8');
    const marker = page.indexOf('<script src="/han-order.js"></script>');
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(page.indexOf('/web-fonts/first.css'));
  });

  it("serves the page's shared font sheets and its classic scripts", () => {
    const names = servedPluginNames();
    expect(names).toContain('public-font-sheets');
    expect(names).toContain('musixquare-classic-runtime-assets'); // brand-capitalization: allow-technical
  });

  it('checks every request is local before it serves a classic script', () => {
    // Vite runs 'pre' plugins first, in array order: the preview's local-only
    // check, then the classic scripts.
    const plugins = servedPlugins();
    const guard = plugins.findIndex(({ name }) => name === 'translation-editor-local-preview');
    const classic = plugins.findIndex(
      ({ name }) => name === 'musixquare-classic-runtime-assets', // brand-capitalization: allow-technical
    );
    expect(plugins[guard]?.enforce).toBe('pre');
    expect(plugins[classic]?.enforce).toBe('pre');
    expect(guard).toBeLessThan(classic);
  });
});

import { build, type Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import { createViteConfig } from '../../../vite.config.ts';

describe('workshop output assets', () => {
  it('emits public page names that survive later bundle hooks and the final output', async () => {
    const pages = new Map([
      ['.workshop/landing/landing.html', 'about.html'],
      ['.workshop/privacy/privacy.html', 'privacy.html'],
      ['.workshop/terms/terms.html', 'terms.html'],
      ['.workshop/faq/faq.html', 'faq.html'],
      ['.workshop/developers/developers.html', 'developers.html'],
      ['.workshop/translate/translate.html', 'translate.html'],
    ]);
    const flatten = createViteConfig({}).plugins?.find(
      (plugin): plugin is Plugin =>
        plugin !== null &&
        typeof plugin === 'object' &&
        'name' in plugin &&
        plugin.name === 'flatten-workshop-html',
    );
    if (!flatten) throw new Error('Workshop output plugin is missing.');

    let checkedLaterHook = false;
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'workshop-output-fixture',
          resolveId(id) {
            return id === 'virtual:workshop-test' ? '\0workshop-test' : null;
          },
          load(id) {
            return id === '\0workshop-test' ? 'console.log("workshop fixture");' : null;
          },
          generateBundle() {
            for (const [fileName, publicName] of pages) {
              this.emitFile({ type: 'asset', fileName, source: `<title>${publicName}</title>` });
            }
          },
        },
        flatten,
        {
          name: 'check-workshop-output-from-later-hook',
          enforce: 'post',
          generateBundle(_options, bundle) {
            for (const [authoredName, publicName] of pages) {
              expect(bundle[authoredName]).toBeUndefined();
              expect(bundle[publicName]).toMatchObject({
                type: 'asset',
                source: `<title>${publicName}</title>`,
              });
            }
            checkedLaterHook = true;
          },
        },
      ],
      build: { write: false, rolldownOptions: { input: 'virtual:workshop-test' } },
    });
    if (Array.isArray(result) || !('output' in result)) {
      throw new Error('Expected a single in-memory build output.');
    }
    expect(checkedLaterHook).toBe(true);
    const outputNames = result.output.map(({ fileName }) => fileName);
    expect(outputNames).toEqual(expect.arrayContaining([...pages.values()]));
    expect(outputNames.some((fileName) => fileName.startsWith('.workshop/'))).toBe(false);
  });
});

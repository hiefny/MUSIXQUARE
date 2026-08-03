import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('filled UI brand colors', () => {
  it('keeps the balanced surface-2 palette synchronized across public surfaces', async () => {
    const sources = await Promise.all(
      [
        'css/style.css',
        'e2e/report-viewer.html',
        'public/editorial-base.css',
        'public/admin.css',
        'public/legal-pages.css',
        'public/designsystem/colors_and_type.css',
        'public/designsystem/index.html',
        'public/designsystem/preview/colors-dark.html',
        'public/designsystem/preview/colors-light.html',
      ].map(async (path) => [path, (await readFile(path, 'utf8')).toLowerCase()] as const),
    );
    const sourceByPath = new Map(sources);

    for (const path of [
      'css/style.css',
      'e2e/report-viewer.html',
      'public/editorial-base.css',
      'public/admin.css',
      'public/legal-pages.css',
      'public/designsystem/colors_and_type.css',
      'public/designsystem/index.html',
      'public/designsystem/preview/colors-dark.html',
    ]) {
      expect(sourceByPath.get(path), `${path} dark surface-2`).toContain('#202020');
    }

    for (const path of [
      'css/style.css',
      'public/designsystem/colors_and_type.css',
      'public/designsystem/index.html',
      'public/designsystem/preview/colors-light.html',
    ]) {
      expect(sourceByPath.get(path), `${path} light surface-2`).toContain('#eff1f3');
    }

    const combined = sources.map(([, source]) => source).join('\n');
    expect(combined).not.toContain('#222222');
    expect(combined).not.toContain('#f1f3f5');
  });

  it('keeps the original MUSIXQUARE brand and semantic palette', async () => {
    const css = await readFile('css/style.css', 'utf8');
    const expected = {
      'primary-filled': '#3b82f6',
      'success-filled': '#20a45a',
      'danger-filled': '#ef4444',
      'warning-filled': '#f59e0b',
      'youtube-filled': '#ff0033',
    } as const;

    for (const [token, originalColor] of Object.entries(expected)) {
      const value = css.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
      expect(value, `missing --${token}`).toBeTruthy();
      expect(value?.toLowerCase(), `--${token}`).toBe(originalColor);
    }
  });

  it('keeps standalone primary fallbacks on the brand blue', async () => {
    const [css, youtubeIframe] = await Promise.all([
      readFile('css/style.css', 'utf8'),
      readFile('src/youtube/iframe.ts', 'utf8'),
    ]);

    expect(css).toContain('var(--primary-filled, #3b82f6)');
    expect(youtubeIframe).toContain('var(--primary-filled, #3b82f6)');
    expect(`${css}\n${youtubeIframe}`).not.toContain('var(--primary-filled, #2563eb)');
  });

  it('keeps the final demo step on the established translucent active surface', async () => {
    const [css, flatControls] = await Promise.all([
      readFile('css/style.css', 'utf8'),
      readFile('css/flat-controls.css', 'utf8'),
    ]);

    expect(flatControls).toMatch(
      /#demo-overlay \.demo-step-nav button\.active\s*\{[^}]*background:\s*var\(--flat-control-active\)[^}]*color:\s*var\(--primary\)/s,
    );
    expect(css).not.toMatch(
      /\.demo-step-nav [^{]*\.demo-step-next\.is-final\s*\{[^}]*background(?:-color)?:/s,
    );
    expect(flatControls).not.toMatch(
      /#demo-overlay \.demo-step-nav [^{]*\.demo-step-next\.is-final\s*\{[^}]*background(?:-color)?:/s,
    );
  });
});

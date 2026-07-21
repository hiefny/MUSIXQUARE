import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('YouTube search and link preview styling', () => {
  it('keeps selection semantics without the decorative left rail', async () => {
    const css = await readFile('css/style.css', 'utf8');

    expect(css).not.toContain('.yt-preview-card::before');
    expect(css).not.toContain('.yt-search-result::before');
    expect(css).not.toContain('.yt-search-result.selected::before');
    expect(css).toContain('.yt-search-result.selected .yt-search-title');
  });

  it('uses symmetric padding after removing the rail', async () => {
    const css = await readFile('css/style.css', 'utf8');
    const previewRule = css.match(/\.yt-preview-card\s*\{([^}]+)\}/)?.[1] || '';
    const resultRule = css.match(/\.yt-search-result\s*\{([^}]+)\}/)?.[1] || '';

    expect(previewRule).toContain('padding: 14px;');
    expect(resultRule).toContain('padding: 10px 12px;');
  });
});

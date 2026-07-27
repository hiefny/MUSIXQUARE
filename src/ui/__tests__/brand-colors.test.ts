import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('filled UI brand colors', () => {
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
});

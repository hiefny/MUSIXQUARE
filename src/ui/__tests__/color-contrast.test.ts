import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function relativeLuminance(hex: string): number {
  const channels = hex
    .match(/[0-9a-f]{2}/gi)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastWithWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

describe('filled UI color contrast', () => {
  it('keeps normal-size white labels at WCAG AA contrast', async () => {
    const css = await readFile('css/style.css', 'utf8');
    for (const token of [
      'primary-filled',
      'success-filled',
      'danger-filled',
      'warning-filled',
      'youtube-filled',
    ]) {
      const value = css.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
      expect(value, `missing --${token}`).toBeTruthy();
      expect(contrastWithWhite(value!), `--${token}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

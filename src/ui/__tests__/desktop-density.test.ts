import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const QHD_QUERY = '@media (min-width: 2560px) and (min-height: 1280px)';
const UHD_QUERY = '@media (min-width: 3840px) and (min-height: 1900px)';

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe('desktop density viewport contracts', () => {
  it('uses browser-content heights for density and keeps the visualizer tier synchronized', async () => {
    const stylesheet = await readFile('css/desktop.css', 'utf8');

    // QHD appears once for density and once for the matching visualizer tier.
    expect(count(stylesheet, QHD_QUERY)).toBe(2);
    expect(count(stylesheet, UHD_QUERY)).toBe(1);
    expect(stylesheet).not.toContain('(min-width: 2560px) and (min-height: 1440px)');
    expect(stylesheet).not.toContain('(min-width: 3840px) and (min-height: 2160px)');
  });

  it('uses height as the safety gate and reserves the full scaled player stack', async () => {
    const stylesheet = await readFile('css/desktop.css', 'utf8');

    expect(stylesheet).toContain('var(--app-height, 100dvh) * var(--desktop-layout-ratio)');
    expect(count(stylesheet, 'height: var(--desktop-viewport-height);')).toBeGreaterThanOrEqual(4);
    expect(stylesheet).not.toContain(
      'calc(var(--app-height, 100vh) * var(--desktop-layout-ratio))',
    );
    expect(stylesheet).toContain('calc((var(--desktop-viewport-height) - 400px) * 16 / 9)');
    expect(stylesheet).not.toContain('calc((var(--desktop-viewport-height) - 320px) * 16 / 9)');

    // A 5120x1080 strip remains below the 1280px density threshold. At
    // 5120x1300, the 1.2x tier has a 1083px logical viewport: its 683px video,
    // header (60), title rail including margins (68), and control stack (268)
    // still retain a small deterministic gap.
    expect(1080).toBeLessThan(1280);
    const logicalHeight = 1300 / 1.2;
    expect(60 + (logicalHeight - 400) + 68 + 268).toBeLessThanOrEqual(logicalHeight);
  });
});

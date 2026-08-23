import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const relativeLuminance = (hex: string): number => {
  const channels = hex
    .slice(1)
    .match(/.{2}/gu)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));

  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

const contrastRatio = (first: string, second: string): number => {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
};

describe('OS contrast accessibility styles', () => {
  it('keeps authored high contrast opt-in scoped to the contrast contract', async () => {
    const css = await readFile('css/style.css', 'utf8');

    expect(css).toMatch(
      /html\[data-contrast='more'\]\s*\{[\s\S]*?--bg:\s*#000000;[\s\S]*?--primary:\s*#8ab4ff;[\s\S]*?--primary-filled:\s*#174ea6;[\s\S]*?--text-muted:\s*#d0d0d0;/u,
    );
    expect(css).toMatch(
      /html\[data-theme='light'\]\[data-contrast='more'\]\s*\{[\s\S]*?--bg:\s*#ffffff;[\s\S]*?--primary:\s*#0047a8;[\s\S]*?--primary-filled:\s*#0047a8;[\s\S]*?--text-muted:\s*#333333;/u,
    );

    const baseRoot = css.match(/@layer base\s*\{\s*:root\s*\{([\s\S]*?)\n\s*\}/u)?.[1] ?? '';
    expect(baseRoot).toContain('--bg: #121212;');
    expect(baseRoot).toContain('--primary: #3b82f6;');
    expect(baseRoot).toContain('--text-main: #eeeeee;');
  });

  it('follows prefers-contrast live unless the explicit normal override is present', async () => {
    const [css, flatControls] = await Promise.all([
      readFile('css/style.css', 'utf8'),
      readFile('css/flat-controls.css', 'utf8'),
    ]);
    const contrastCss = css.slice(css.indexOf('OS contrast preferences'));

    for (const source of [css, flatControls]) {
      expect(source).toContain('@media (prefers-contrast: more)');
      expect(source).toContain("html:not([data-contrast='normal'])");
    }

    expect(css).toContain("html[data-theme='light']:not([data-contrast='normal'])");
    expect(flatControls).toContain("html[data-contrast='more']");
    expect(flatControls).toMatch(
      /html\[data-contrast='more'\]\s+:is\([\s\S]*?#tab-settings \.ch-opt[\s\S]*?outline:\s*1px solid var\(--divider\);/u,
    );
    expect(flatControls).toMatch(
      /html\[data-contrast='more'\][\s\S]*?\.demo-step-next:not\(\.is-final\)[\s\S]*?background:\s*var\(--primary-filled\);[\s\S]*?color:\s*#fff;/u,
    );
    expect(flatControls).toMatch(
      /@media \(forced-colors: active\)[\s\S]*?\.demo-step-next:not\(\.is-final\)[\s\S]*?background:\s*Highlight;[\s\S]*?color:\s*HighlightText;/u,
    );

    expect(css).toMatch(
      /html\[data-contrast='more'\]\s+:is\(button, \[role='button'\], \[role='switch'\], \[role='tab'\]\)[\s\S]*?outline:\s*1px solid var\(--divider\);/u,
    );
    expect(contrastCss.match(/outline:\s*3px solid var\(--primary\) !important;/gu)).toHaveLength(
      2,
    );
    expect(contrastCss.match(/outline:\s*2px solid var\(--primary\);/gu)).toHaveLength(2);
    expect(css).toMatch(
      /html\[data-contrast='more'\][\s\S]*?\.tab-action-btn\.active[\s\S]*?::before[\s\S]*?background:\s*var\(--primary-filled\);/u,
    );
    expect(css).toMatch(
      /html\[data-contrast='more'\][\s\S]*?\.tab-action-btn\.active-one::after[\s\S]*?color:\s*var\(--primary-filled\);/u,
    );
    expect(css).toMatch(
      /html:not\(\[data-contrast='normal'\]\)[\s\S]*?input\[type='range'\]::-webkit-slider-runnable-track[\s\S]*?border:\s*1px solid var\(--divider\);/u,
    );
  });

  it('keeps authored control boundaries and focus indicators above 3:1', () => {
    expect(contrastRatio('#8c8c8c', '#000000')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio('#8ab4ff', '#000000')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio('#1f2937', '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio('#0047a8', '#ffffff')).toBeGreaterThanOrEqual(3);

    for (const filledSurface of [
      '#174ea6',
      '#006d3d',
      '#b00020',
      '#714500',
      '#0047a8',
      '#006b3c',
      '#a4001d',
      '#6b4100',
    ]) {
      expect(contrastRatio('#ffffff', filledSurface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('lets Windows forced colors own the palette while retaining control structure', async () => {
    const css = await readFile('css/style.css', 'utf8');

    expect(css).toContain('@media (forced-colors: active)');
    for (const declaration of [
      '--bg: Canvas;',
      '--surface-2: ButtonFace;',
      '--divider: CanvasText;',
      '--primary: LinkText;',
      '--primary-filled: Highlight;',
      '--text-main: CanvasText;',
    ]) {
      expect(css).toContain(declaration);
    }

    expect(css).toMatch(
      /:is\(button, \[role='button'\], \[role='switch'\], \[role='tab'\]\)\s*\{[\s\S]*?outline:\s*1px solid ButtonText;/u,
    );
    expect(css).toContain('outline: 3px solid Highlight !important;');
    expect(css).toContain('background: Highlight !important;');
    expect(css).toContain('color: HighlightText !important;');
    expect(css).toContain('color: GrayText !important;');
    expect(css).toContain('color: LinkText;');
    expect(css).toContain('background: Canvas;');
  });

  it('restores range geometry after forced colors removes authored gradients', async () => {
    const css = await readFile('css/style.css', 'utf8');

    expect(css).toMatch(
      /input\[type='range'\]::-webkit-slider-runnable-track\s*\{[\s\S]*?border:\s*1px solid CanvasText !important;[\s\S]*?background:\s*Canvas !important;/u,
    );
    expect(css).toMatch(
      /input\[type='range'\]::-webkit-slider-thumb\s*\{[\s\S]*?width:\s*16px !important;[\s\S]*?background:\s*Highlight !important;[\s\S]*?opacity:\s*1 !important;/u,
    );
    expect(css).toMatch(
      /input\[type='range'\]::-moz-range-thumb\s*\{[\s\S]*?width:\s*16px !important;[\s\S]*?background:\s*Highlight !important;[\s\S]*?opacity:\s*1 !important;/u,
    );
  });

  it('limits forced-color opt-out to the functional QR artwork', async () => {
    const css = await readFile('css/style.css', 'utf8');
    const optOuts = css.match(/forced-color-adjust:\s*none\s*;/gu) ?? [];

    expect(optOuts).toHaveLength(1);
    expect(css).toMatch(
      /\.qr-svg\s*\{\s*forced-color-adjust:\s*none;\s*background:\s*#000000;\s*\}/u,
    );
    expect(css).toMatch(
      /\.qr-svg path\s*\{\s*stroke:\s*#ffffff !important;\s*fill:\s*#ffffff !important;\s*\}/u,
    );
    expect(css).not.toMatch(/(?:html|body|:root|\*)\s*\{[^}]*forced-color-adjust:\s*none/gu);
  });
});

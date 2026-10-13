import { readFile } from 'node:fs/promises';
import { parse as parseCss } from 'postcss';
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

const splitSelectors = (selectorList: string): string[] => {
  const selectors: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of selectorList) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      selectors.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  selectors.push(current.trim());
  return selectors;
};

/** Innermost style rules with comment-free, whitespace-normalized selectors. */
const styleRules = (source: string): { selectors: string[]; body: string }[] =>
  [...source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(([, selectorList, body]) => ({
    selectors: splitSelectors(selectorList!.replace(/\/\*[\s\S]*?\*\//gu, '')).map((selector) =>
      selector.replace(/\s+/gu, ' ').replace(/\(\s+/gu, '(').replace(/\s+\)/gu, ')').trim(),
    ),
    body: body!,
  }));

describe('OS contrast accessibility styles', () => {
  it('keeps authored high contrast opt-in scoped to the contrast contract', async () => {
    const css = await readFile('css/style.css', 'utf8');

    expect(css).toMatch(
      /html\[data-contrast='more'\]\s*\{[\s\S]*?--bg:\s*#000000;[\s\S]*?--primary:\s*#8ab4ff;[\s\S]*?--primary-filled:\s*#0047a8;[\s\S]*?--success-filled:\s*#006b3c;[\s\S]*?--danger-filled:\s*#a4001d;[\s\S]*?--warning-filled:\s*#6b4100;[\s\S]*?--youtube-filled:\s*#a4001d;[\s\S]*?--text-muted:\s*#d0d0d0;/u,
    );
    expect(css).toMatch(
      /html\[data-contrast='more'\]\s*\{[\s\S]*?--divider:\s*#262626;[\s\S]*?--glass-border:\s*#262626;/u,
    );
    expect(css).toMatch(
      /html\[data-theme='light'\]\[data-contrast='more'\]\s*\{[\s\S]*?--bg:\s*#f2f2f2;[\s\S]*?--surface-1:\s*#ffffff;[\s\S]*?--surface-2:\s*#d4d4d4;[\s\S]*?--surface-3:\s*#a8a8a8;[\s\S]*?--divider:\s*#d4d6d8;[\s\S]*?--primary:\s*#0047a8;[\s\S]*?--text-main:\s*#000000;[\s\S]*?--text-muted:\s*#333333;/u,
    );

    const baseRoot = css.match(/@layer base\s*\{\s*:root\s*\{([\s\S]*?)\n\s*\}/u)?.[1] ?? '';
    expect(baseRoot).toContain('--bg: #121212;');
    expect(baseRoot).toContain('--primary: #3b82f6;');
    expect(baseRoot).toContain('--text-main: #eeeeee;');

    const paletteDeclaration =
      /--(?:bg|surface-[123]|divider|primary(?:-rgb|-filled)?|success-filled|danger-filled|warning-(?:filled|foreground)|youtube-filled|accent(?:-rgb)?|text-(?:main|sub|muted)|range-fill-(?:idle|active)|play-fab-bg-(?:idle|active|disabled)|glass-(?:bg|border)|scrollbar-thumb(?:-hover|-active)?)\s*:/u;
    const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, '');
    const paletteOwners = [...cssWithoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter((match) => paletteDeclaration.test(match[2] ?? ''))
      .map((match) => (match[1] ?? '').trim());

    expect(paletteOwners.length).toBeGreaterThan(0);
    for (const selector of paletteOwners) {
      expect(selector).not.toMatch(/\bbody\b/u);
    }

    for (const token of [
      '--primary-filled',
      '--success-filled',
      '--danger-filled',
      '--warning-filled',
      '--youtube-filled',
    ]) {
      expect(css.match(new RegExp(`${token}:`, 'gu')), `${token} declaration owners`).toHaveLength(
        4,
      );
    }
  });

  it('keeps prefers-contrast and its debug override color-only', async () => {
    const css = await readFile('css/style.css', 'utf8');
    const prefersStart = css.indexOf('@media (prefers-contrast: more)');
    const forcedStart = css.indexOf('@media (forced-colors: active)', prefersStart);
    const coreCss = css.slice(0, css.indexOf("html[data-contrast='more']"));
    const manualCss = css.slice(css.indexOf("html[data-contrast='more']"), prefersStart);
    const contrastMedia: string[] = [];
    parseCss(css).walkAtRules('media', (rule) => {
      if (rule.params === '(prefers-contrast: more)') contrastMedia.push(rule.toString());
    });
    const prefersCss = contrastMedia.join('\n');
    const forcedCss = css.slice(forcedStart);
    const structuralDeclaration =
      /^\s*(?:border(?:-[\w-]+)?|box-shadow|filter|opacity|outline(?:-[\w-]+)?|text-decoration(?:-[\w-]+)?|transform):/mu;

    expect(css).toContain('@media (prefers-contrast: more)');
    expect(css).toContain("html:not([data-contrast='normal'])");
    expect(css).toContain("html[data-theme='light']:not([data-contrast='normal'])");
    expect(css).not.toContain("html[data-theme='light']:not([data-contrast='normal']) body");
    expect(manualCss).toMatch(
      /html\[data-contrast='more'\]\s*\{[^}]*--control-active:\s*rgba\(var\(--primary-rgb\), 0\.28\);[^}]*--control-danger:\s*rgba\(176, 0, 32, 0\.24\);[^}]*--control-danger-hover:\s*rgba\(176, 0, 32, 0\.34\);/u,
    );
    expect(prefersCss).toMatch(
      /html:not\(\[data-contrast='normal'\]\)\s*\{[^}]*--control-active:\s*rgba\(var\(--primary-rgb\), 0\.28\);[^}]*--control-danger:\s*rgba\(176, 0, 32, 0\.24\);[^}]*--control-danger-hover:\s*rgba\(176, 0, 32, 0\.34\);/u,
    );
    expect(coreCss).toMatch(
      /\.demo-step-nav \.demo-step-next:not\(\.is-final\)\s*\{(?=[^}]*background:\s*var\(--primary-filled\);)(?=[^}]*border-color:\s*transparent;)(?=[^}]*color:\s*#fff;)[^}]*\}/u,
    );
    expect(forcedCss).toMatch(
      /\.demo-step-nav \.demo-step-next:not\(\.is-final\)\s*\{[^}]*border-color:\s*Highlight !important;[^}]*background:\s*Highlight !important;[^}]*color:\s*CanvasText !important;/u,
    );

    for (const colorOnlyCss of [manualCss, prefersCss]) {
      expect(colorOnlyCss).not.toMatch(structuralDeclaration);
    }

    expect(manualCss).toMatch(
      /html\[data-contrast='more'\]\s+:is\(\.tab-action-btn\.active, \.tab-action-btn\.active-one\)::before\s*\{\s*background:\s*var\(--primary\);/u,
    );
    expect(manualCss).toMatch(
      /html\[data-theme='light'\]\[data-contrast='more'\][\s\S]*?:is\(\.tab-action-btn\.active, \.tab-action-btn\.active-one\)::before\s*\{\s*background:\s*var\(--primary-filled\);/u,
    );
    expect(css).toMatch(
      /html\[data-contrast='more'\][\s\S]*?\.tab-action-btn\.active-one::after[\s\S]*?color:\s*var\(--primary-filled\);/u,
    );
    expect(prefersCss).toContain('background: var(--primary);');
    expect(prefersCss).toContain('background: var(--primary-filled);');
    expect(prefersCss).toContain('color: var(--primary-filled);');
    expect(prefersCss).toContain('--divider: #262626;');
    expect(prefersCss).toContain('--bg: #f2f2f2;');
    expect(prefersCss).toContain('--surface-2: #d4d4d4;');
    expect(prefersCss).toContain('--surface-3: #a8a8a8;');
    expect(prefersCss).toContain('--text-main: #000000;');
  });

  it('keeps authored palette contrasts above their required ratios', () => {
    expect(contrastRatio('#8ab4ff', '#1f1f1f')).toBeGreaterThanOrEqual(4.5);
    expect('#8ab4ff').not.toBe('#0047a8');
    expect(contrastRatio('#000000', '#f2f2f2')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#0047a8', '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio('#f59e0b', '#1f1f1f')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#6b4100', '#ffffff')).toBeGreaterThanOrEqual(4.5);

    for (const filledSurface of ['#0047a8', '#006b3c', '#a4001d', '#6b4100']) {
      expect(contrastRatio('#ffffff', filledSurface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('lets Windows forced colors own the palette while retaining control structure', async () => {
    const css = await readFile('css/style.css', 'utf8');

    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toMatch(/@media \(forced-colors: active\)\s*\{\s*:root\s*\{/u);
    for (const declaration of [
      '--bg: Canvas !important;',
      '--surface-2: ButtonFace !important;',
      '--divider: CanvasText !important;',
      '--primary: LinkText !important;',
      '--primary-filled: Highlight !important;',
      '--warning-foreground: LinkText !important;',
      '--text-main: CanvasText !important;',
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

  it('never paints forced-colors text in HighlightText, which vanishes on the text backplate', async () => {
    const css = await readFile('css/style.css', 'utf8');
    const forcedCss = css.slice(css.lastIndexOf('@media (forced-colors: active) {'));
    const highlightTextColorSelectors = [...forcedCss.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].flatMap(
      ([, selectorList, body]) =>
        /(?:^|[\s;])color:\s*HighlightText\b/u.test(body!)
          ? splitSelectors(selectorList!.replace(/\/\*[\s\S]*?\*\//gu, ''))
          : [],
    );

    expect(highlightTextColorSelectors.length).toBeGreaterThan(0);
    for (const selector of highlightTextColorSelectors) {
      // Icons and check marks have no backplate; everything else is text.
      expect(selector, selector).toMatch(/(?:\bsvg|-check)$/u);
    }
    // Selected rows and pressed controls keep their Highlight fill and border,
    // and their copy keeps the OS text color on the backplate.
    expect(forcedCss).toMatch(
      /\.language-option\.active\s*\)\s*\{\s*border-color:\s*Highlight !important;\s*outline-color:\s*Highlight;\s*background:\s*Highlight !important;\s*color:\s*CanvasText !important;/u,
    );
    expect(forcedCss).toMatch(
      /\.language-option\.active\s*\)\s*svg\s*\{\s*color:\s*HighlightText !important;/u,
    );
    expect(forcedCss).not.toMatch(/\.language-option\.active\s*\)\s*\*\s*\{/u);
  });

  it('keeps base-layer important colors from outranking the forced-colors rules', async () => {
    const css = await readFile('css/style.css', 'utf8');
    const baseCss = css.slice(0, css.indexOf('/* end @layer base */'));
    const forcedCss = css.slice(css.lastIndexOf('@media (forced-colors: active) {'));
    // An important declaration inside @layer base outranks an unlayered
    // important one, so it would silently defeat the forced-colors rule.
    const importantColorFamilies = (body: string): Set<string> =>
      new Set(
        body
          .split(';')
          .map((declaration) => declaration.trim())
          .filter((declaration) => /!important$/u.test(declaration))
          .map((declaration) => declaration.slice(0, declaration.indexOf(':')).trim())
          .map((property) =>
            property.match(/^(color|background|border|outline|fill|stroke)(?:-color)?$/u),
          )
          .filter((match): match is RegExpMatchArray => match !== null)
          .map((match) => match[1]!),
      );
    const forced = new Map<string, Set<string>>();
    for (const rule of styleRules(forcedCss)) {
      const families = importantColorFamilies(rule.body);
      for (const selector of rule.selectors) {
        forced.set(selector, new Set([...(forced.get(selector) ?? []), ...families]));
      }
    }
    const conflicts = styleRules(baseCss).flatMap((rule) =>
      [...importantColorFamilies(rule.body)].flatMap((family) =>
        rule.selectors
          .filter((selector) => forced.get(selector)?.has(family))
          .map((selector) => `${selector} { ${family} }`),
      ),
    );

    expect(forced.get(".room-password-toggle[aria-pressed='true']")).toContain('background');
    expect(forced.get('.qr-svg path')).toContain('stroke');
    expect(conflicts).toEqual([]);
  });

  it('lets accent-filled tab and option icons follow the selected icon color', async () => {
    const css = await readFile('css/style.css', 'utf8');
    const forcedCss = css.slice(css.lastIndexOf('@media (forced-colors: active) {'));

    // These icons use the accent fill instead of currentColor, which would
    // leave LinkText icons on the Highlight fill of the selected tab or option.
    expect(css).toMatch(/\.nav-item\.active svg\s*\{[^}]*fill:\s*var\(--primary\);/u);
    expect(css).toMatch(
      /\.ch-opt\.active svg,\s*\.ch-opt\.selected svg\s*\{[^}]*fill:\s*var\(--primary\);/u,
    );
    expect(forcedCss).toMatch(
      /:is\(\.nav-item, \.ch-opt\):is\(\[aria-pressed='true'\], \[aria-selected='true'\], \[aria-checked='true'\]\)\s*svg\s*\{\s*fill:\s*currentColor;\s*\}/u,
    );
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

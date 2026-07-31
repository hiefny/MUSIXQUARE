import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(selector);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  expect(open).toBeGreaterThan(start);
  expect(close).toBeGreaterThan(open);
  return source.slice(open + 1, close);
}

function customNumber(body: string, name: string): number {
  const match = body.match(new RegExp(`${name}:\\s*([\\d.]+)(?:px)?;`));
  expect(match, `Missing CSS custom property: ${name}`).not.toBeNull();
  return Number(match![1]);
}

describe('locale typography geometry contracts', () => {
  it('keeps compact settings controls aligned without a global line-height override', async () => {
    const [baseCss, desktopCss] = await Promise.all([
      readFile('css/style.css', 'utf8'),
      readFile('css/desktop.css', 'utf8'),
    ]);

    const cjk = ruleBody(baseCss, 'html:lang(ja),\n  html:lang(zh-Hans),\n  html:lang(zh-Hant)');
    const thai = ruleBody(baseCss, 'html:lang(th)');

    const cjkSubtabLine = customNumber(cjk, '--locale-settings-subtab-line-height');
    const cjkSubtabPadding = customNumber(cjk, '--locale-settings-subtab-padding-block');
    const thaiSubtabLine = customNumber(thai, '--locale-settings-subtab-line-height');
    const thaiSubtabPadding = customNumber(thai, '--locale-settings-subtab-padding-block');

    // 13px desktop pill: content + block padding + active underline.
    expect(cjkSubtabLine + 2 * cjkSubtabPadding + 2).toBe(37);
    expect(thaiSubtabLine + 2 * thaiSubtabPadding + 2).toBe(37);

    const cjkChoiceLine = customNumber(cjk, '--locale-settings-choice-line-height');
    const cjkChoicePadding = customNumber(cjk, '--locale-settings-choice-padding-block');
    const thaiChoiceLine = customNumber(thai, '--locale-settings-choice-line-height');
    const thaiChoicePadding = customNumber(thai, '--locale-settings-choice-padding-block');

    // 32px icon + 8px gap + label + block padding + two 2px borders.
    expect(32 + 8 + cjkChoiceLine + 2 * cjkChoicePadding + 4).toBe(96);
    expect(32 + 8 + thaiChoiceLine + 2 * thaiChoicePadding + 4).toBe(96);

    expect(ruleBody(baseCss, '.ch-opt')).toContain(
      'line-height: var(--locale-settings-choice-line-height, normal)',
    );
    expect(ruleBody(baseCss, '.section-title')).toContain(
      'line-height: var(--locale-settings-section-line-height, normal)',
    );
    expect(ruleBody(desktopCss, '.subtab-pill')).toContain(
      'line-height: var(--locale-settings-subtab-line-height, normal)',
    );
    expect(baseCss).not.toMatch(
      /(?:^|\n)\s*(?:html|body)\s*\{[^}]*line-height:\s*(?:var\(--locale|[\d.]+)/s,
    );
  });

  it('preserves outer title rhythm while retaining extra Thai glyph leading', async () => {
    const baseCss = await readFile('css/style.css', 'utf8');
    const cjk = ruleBody(baseCss, 'html:lang(ja),\n  html:lang(zh-Hans),\n  html:lang(zh-Hant)');
    const thai = ruleBody(baseCss, 'html:lang(th)');

    const cjkSectionLine = 17 * customNumber(cjk, '--locale-settings-section-line-height');
    const thaiSectionLine = 17 * customNumber(thai, '--locale-settings-section-line-height');
    const thaiSectionPaddingAdjust = customNumber(thai, '--locale-settings-section-padding-adjust');

    // Desktop Korean/Pretendard baseline: 20px text + 44/16px padding.
    expect(cjkSectionLine).toBeCloseTo(20, 4);
    expect(cjkSectionLine + 44 + 16).toBeCloseTo(80, 4);
    expect(thaiSectionLine).toBeCloseTo(22, 4);
    expect(thaiSectionLine + 44 + 16 - 2 * thaiSectionPaddingAdjust).toBeCloseTo(80, 4);

    const cjkOnboarding = 28 * customNumber(cjk, '--locale-onboarding-title-line-height') + 8;
    const thaiOnboarding =
      28 * customNumber(thai, '--locale-onboarding-title-line-height') +
      8 -
      customNumber(thai, '--locale-onboarding-title-margin-adjust');

    // At 1280px the onboarding title is 28px. Both locale contributions
    // remain the Pretendard baseline (34px line box + 8px margin).
    expect(cjkOnboarding).toBeCloseTo(42, 4);
    expect(thaiOnboarding).toBeCloseTo(42, 4);
    expect(customNumber(thai, '--locale-onboarding-title-line-height')).toBeGreaterThan(
      customNumber(cjk, '--locale-onboarding-title-line-height'),
    );
  });
});

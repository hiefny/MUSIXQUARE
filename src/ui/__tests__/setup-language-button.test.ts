import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * The phone start screen's language button (owner decision 2026-11-17). The
 * 44px button sits centred on the greeting title at the top of the welcome
 * area, so its pill and its keyboard focus outline reach above the title, and
 * both scroll boxes there (`.setup-mobile-view` and `#setup-welcome-area`)
 * clipped at their top edge: the top of the hover pill and of the outline was
 * cut off. Both clip edges now sit 16px higher, in the card's empty top
 * padding, and the content keeps its place (e2e/setup-scroll-edge.test.ts).
 * Every other step area starts there too (owner decision the same day), so
 * scrolled content leaves the screen at the same line on every step.
 */

/** The step areas: the setup view's scrolling children in index.html. */
async function setupStepAreas(): Promise<string[]> {
  const html = await readFile('index.html', 'utf8');
  const start = html.indexOf('<div class="setup-mobile-view" data-custom-scroll>');
  const end = html.indexOf('<div class="ob-actions" id="setup-actions">', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return [
    ...html
      .slice(start, end)
      .matchAll(/<div\s+id="(setup-[a-z-]+-area)"\s+class="[^"]*"\s+data-custom-scroll/gu),
  ].map((match) => match[1]!);
}

async function stylesheetLayer(name: string): Promise<string> {
  const css = await readFile('css/style.css', 'utf8');
  const start = css.indexOf(`@layer ${name} {`);
  if (start < 0) throw new Error(`Missing @layer ${name}`);
  const next = css.indexOf('\n@layer ', start + 1);
  return css.slice(start, next < 0 ? undefined : next);
}

/** The declarations of the one rule whose whole selector is `selector`. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const matches = [...css.matchAll(new RegExp(`\\n {2}${escaped} \\{([^}]*)\\}`, 'gu'))];
  expect(matches, selector).toHaveLength(1);
  return matches[0]![1]!;
}

function px(body: string, property: string): number {
  const value = body.match(new RegExp(`(?:^|[\\s;])${property}: (-?[\\d.]+)px;`, 'u'))?.[1];
  expect(value, property).toBeDefined();
  return Number(value);
}

describe('phone start screen language button', () => {
  it('raises every phone setup clip edge 16px and keeps the content where it was', async () => {
    const areas = await setupStepAreas();
    expect(areas).toEqual([
      'setup-welcome-area',
      'setup-code-area',
      'setup-join-area',
      'setup-auto-join-area',
      'setup-role-area',
    ]);
    const responsive = await stylesheetLayer('responsive');
    const phone = [
      ...responsive.matchAll(/@media \(max-width: 719\.98px\) \{\n([\s\S]*?)\n {2}\}/gu),
    ].map((match) => match[1] ?? '');
    const block = phone.find((body) => body.includes('#setup-overlay .setup-mobile-view {'));
    expect(block).toBeDefined();
    // The view's height is fixed (100% of the card), so it grows by the same
    // 16px it reaches up; each step area is a flex item that grows on its own.
    expect(block).toMatch(
      /#setup-overlay \.setup-mobile-view \{\s*margin-top: -16px;\s*padding-top: 16px;\s*height: calc\(100% \+ 16px\);\s*\}/u,
    );
    // One rule for every step area, so a scrolled step leaves the screen at the
    // same line whichever step it is.
    const rule = block!.match(
      /\n {4}(#setup-[a-z-]+-area(?:,\s*#setup-[a-z-]+-area)*) \{([^}]*)\}/u,
    );
    expect(rule?.[1]?.split(/,\s*/u)).toEqual(areas.map((id) => `#${id}`));
    expect(rule?.[2]).toMatch(/^\s*margin-top: -16px;\s*padding-top: 16px;\s*$/u);
  });

  it("covers the button's reach above the title, with its focus outline, with room to spare", async () => {
    const css = await readFile('css/style.css', 'utf8');
    const button = ruleBody(css, '.setup-language-button');
    const title = ruleBody(css, '.setup-header-text h2');
    const focus = ruleBody(css, '.setup-language-button:focus-visible');
    const height = px(button, 'min-height');
    const lineHeight = Number(title.match(/(?:^|[\s;])line-height: ([\d.]+);/u)?.[1]);
    const line = px(title, 'font-size') * lineHeight;
    const outline = Number(focus.match(/(?:^|[\s;])outline: (\d+)px solid/u)?.[1]);
    const reach = (height - line) / 2 + outline + px(focus, 'outline-offset');
    // 44px on a 28.8px line: 7.6px above it, 11.6px with the outline.
    expect(reach).toBeCloseTo(11.6, 6);
    expect(reach).toBeLessThanOrEqual(16 - 2);
  });
});

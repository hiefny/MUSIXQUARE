import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('borderless flat settings and demo controls', () => {
  it('loads the isolated visual layer after the core desktop styles', async () => {
    const html = await readFile('index.html', 'utf8');
    const desktopIndex = html.indexOf('css/desktop.css');
    const flatIndex = html.indexOf('css/flat-controls.css');

    expect(desktopIndex).toBeGreaterThan(-1);
    expect(flatIndex).toBeGreaterThan(desktopIndex);
  });

  it('covers settings and every guided-demo button family', async () => {
    const css = await readFile('css/flat-controls.css', 'utf8');

    expect(css).toContain('#tab-settings .ch-opt');
    expect(css).toContain('#demo-overlay .ch-opt.demo-choice');
    expect(css).toContain('#demo-overlay .demo-role-segmented button[data-demo-role]');
    expect(css).toContain('#demo-overlay .demo-step-nav button');
    expect(css).toContain('#demo-overlay .demo-large-actions .accent-action-btn');
    expect(css).toContain('#demo-overlay .demo-large-actions .leave-session-btn');
  });

  it('removes frames and shadows while retaining selected and danger surfaces', async () => {
    const css = await readFile('css/flat-controls.css', 'utf8');
    const shadowValues = Array.from(css.matchAll(/box-shadow:\s*([^;]+);/g), ([, value]) =>
      value.trim(),
    );

    expect(css).toContain('border-color: transparent');
    expect(css).toContain('box-shadow: none');
    expect(css).toContain('--flat-control-active');
    expect(css).toContain('--flat-control-danger');
    expect(shadowValues.length).toBeGreaterThan(0);
    expect(new Set(shadowValues)).toEqual(new Set(['none']));
  });

  it('uses the design-system surface-2 default and surface-3 hover tokens', async () => {
    const css = await readFile('css/flat-controls.css', 'utf8');

    expect(css).toMatch(/--flat-control-surface:\s*var\(--surface-2\)\s*;/);
    expect(css).toMatch(/--flat-control-hover:\s*var\(--surface-3\)\s*;/);
    expect(css).toMatch(
      /#tab-settings \.ch-opt,[\s\S]*?background:\s*var\(--flat-control-surface\)\s*;/,
    );
    expect(css).toMatch(
      /@media \(hover: hover\)[\s\S]*?#tab-settings \.ch-opt:hover,[\s\S]*?background:\s*var\(--flat-control-hover\)\s*;/,
    );
  });
});

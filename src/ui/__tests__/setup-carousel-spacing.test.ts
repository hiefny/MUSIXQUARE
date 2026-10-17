import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('welcome carousel spacing', () => {
  it('keeps the phone gaps the owner chose', async () => {
    // Visible 28 / 20 / 36px from the icon circle to the title text, the title
    // to the description and the description to the dots. The line boxes add
    // the rest, and the nav row's margin collapses with the viewport's 4px.
    const css = await readFile('css/style.css', 'utf8');
    const slide = css.match(/\n {2}\.ob-slide \{([^}]*)\}/)?.[1];

    expect(slide).toBeDefined();
    expect(slide).not.toMatch(/\bgap:/);
    expect(css).toMatch(/\.ob-slide \.ob-icon-circle \{\s*margin: 0 auto 24\.5px;\s*\}/);
    expect(css).toMatch(/\.ob-slide \.ob-title \{\s*font-size: 24px;[^}]*margin-bottom: 11\.5px;/);
    expect(css).toMatch(/\.ob-slide \.ob-desc \{\s*font-size: 14px;[^}]*line-height: 1\.6;/);
    expect(css).toMatch(/\.ob-slider-viewport \{[^}]*margin: 4px 0;/);
    expect(css).toMatch(/\.ob-nav-row \{[^}]*margin-top: 31\.5px;\s*margin-bottom: 8px;/);
  });

  it('scales the same rhythm with the two-column title', async () => {
    // About 7/6, 5/6 and 3/2 of the title size, so the left panel keeps the
    // phone's proportions at every compact and desktop size.
    const css = await readFile('css/style.css', 'utf8');
    const desktop = await readFile('css/desktop.css', 'utf8');

    expect(css).toMatch(
      /\.desktop-diagram-area \.ob-icon-circle \{[^}]*margin-bottom: var\(--setup-ob-title\);/,
    );
    expect(css).toMatch(
      /\.desktop-diagram-area \.ob-slide \.ob-title \{\s*font-size: var\(--setup-ob-title\);\s*margin-bottom: calc\(var\(--setup-ob-title\) \* 0\.54\);/,
    );
    expect(css).toMatch(/\.desktop-diagram-area \.ob-slide \.ob-desc \{[^}]*line-height: 1\.5;/);
    expect(css).toMatch(
      /\.desktop-diagram-area \.ob-nav-row \{\s*margin-top: var\(--setup-nav-mt\);/,
    );
    // The compact layout hides the arrows; on desktop the 22px arrows center
    // the dots 7px lower.
    expect(css).toMatch(/--setup-nav-mt: calc\(var\(--setup-ob-title\) \* 1\.5 - 8px\);/);
    expect(css).toMatch(/--setup-nav-arrow: none;/);
    expect(desktop).toMatch(/--setup-nav-mt: calc\(var\(--setup-ob-title\) \* 1\.5 - 16px\);/);
    expect(desktop).toMatch(/--setup-nav-arrow: flex;/);
    expect(desktop).toMatch(/\.ob-nav-arrow \{\s*width: 22px;\s*height: 22px;/);
    expect(`${css}\n${desktop}`).not.toContain('--setup-ob-title-mb');
  });

  it('keeps the icon circle as faint in dark as in light', async () => {
    // The circle only evens out the icons' optical size. More contrast keeps
    // the stronger surface-2 circle.
    const css = await readFile('css/style.css', 'utf8');

    expect(css).toMatch(/\n {2}\.ob-icon-circle \{[^}]*background: var\(--ob-icon-circle-bg\);/);
    expect(css).toMatch(/:root \{[^}]*--ob-icon-circle-bg: var\(--surface-1\);/);
    expect(css).toMatch(
      /html\[data-theme='light'\] \{[^}]*--ob-icon-circle-bg: var\(--surface-2\);/,
    );
    expect(css).toMatch(
      /html\[data-contrast='more'\] \{[^}]*--ob-icon-circle-bg: var\(--surface-2\);/,
    );
    expect(css).toMatch(
      /@media \(prefers-contrast: more\) \{\s*html:not\(\[data-contrast='normal'\]\) \{[^}]*--ob-icon-circle-bg: var\(--surface-2\);/,
    );
  });
});

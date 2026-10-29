/**
 * @vitest-environment jsdom
 *
 * The tour's exits and its header. Owner decision (2026-10-29, item 18):
 * the header exit 9.0.20 added at the top start goes, so steps 1 to 3 leave
 * through Back again, and step 4 keeps Exit Tour on the left of Track info.
 * The header names the current track alone on one line.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Node } from 'postcss';
import { describe, expect, it } from 'vitest';

import { DEMO_TRACKS } from '../tracks.ts';

const source = readFileSync(resolve('index.html'), 'utf8');
const markup = new DOMParser().parseFromString(source, 'text/html');
const css = readFileSync(resolve('css/style.css'), 'utf8');
const stylesheet = parseCss(css);

/** Whether a conditional at-rule wraps `node`; cascade layers apply everywhere. */
function isConditional(node: Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && (parent as AtRule).name !== 'layer') return true;
  }
  return false;
}

/** Values of `property` in unconditional rules that list `selector` itself. */
function declared(selector: string, property: string): string[] {
  const values: string[] = [];
  stylesheet.walkRules((rule) => {
    if (!rule.selectors.includes(selector) || isConditional(rule)) return;
    rule.each((node) => {
      if (node.type === 'decl' && node.prop === property) values.push(node.value);
    });
  });
  return values;
}

describe('demo tour exits', () => {
  it('has no exit in the header: steps 1 to 3 leave through Back', () => {
    const header = markup.querySelector('#demo-overlay .demo-track-header')!;
    const outsidePill = [...header.querySelectorAll('button')].filter(
      (button) => !button.closest('.demo-controls-pill'),
    );
    expect(outsidePill).toEqual([]);
    expect(header.firstElementChild?.classList.contains('demo-controls-pill')).toBe(true);
    expect(markup.getElementById('btn-demo-exit')).toBeNull();
    expect(source).not.toContain('btn-demo-exit');
    expect(css).not.toContain('demo-exit-corner');
    // The only exit in the tour's markup is step 4's.
    const exits = [...markup.querySelectorAll('#demo-overlay [data-demo-exit]')];
    expect(
      exits.map((exit) => exit.closest('[data-demo-panel]')?.getAttribute('data-demo-panel')),
    ).toEqual(['4']);
  });

  it('lays the header out as settings, then the track copy', () => {
    expect(declared('.demo-track-header', 'grid-template-columns')).toEqual([
      '44px minmax(0, 1fr)',
    ]);
    expect(declared('.demo-controls-pill', 'grid-column')).toEqual(['1 / -1']);
    expect(declared('.demo-track-copy', 'grid-column')).toEqual(['2']);
    // The open settings pill grows from the opener over the track copy and
    // no longer slides over an exit's place.
    expect(declared('.demo-controls-expanded .demo-controls-pill', 'margin-inline-start')).toEqual(
      [],
    );
    expect(declared('.demo-controls-expanded .demo-controls-pill', 'max-width')).toEqual([]);
  });

  it('puts Exit Tour on the left of Track info on the last step', () => {
    const actions = markup.querySelector('[data-demo-panel="4"] .demo-large-actions')!;
    const buttons = Array.from(actions.querySelectorAll(':scope > button'));
    expect(buttons.map((button) => button.hasAttribute('data-demo-exit'))).toEqual([true, false]);
    expect(buttons[1]?.hasAttribute('data-demo-info')).toBe(true);
  });
});

describe('demo header track title', () => {
  it('names the track alone, without the album every demo track shares', () => {
    // The track list on step 4 and the track info keep the album.
    for (const track of DEMO_TRACKS) {
      expect(track.title).toBe(`Linelight OST - ${track.shortTitle}`);
    }
    expect(markup.querySelector('#demo-overlay .demo-track-title')?.textContent).toBe(
      DEMO_TRACKS[0]!.shortTitle,
    );
    const rows = [...markup.querySelectorAll('#demo-overlay [data-demo-track-index] strong')];
    expect(rows.map((row) => row.textContent)).toEqual(DEMO_TRACKS.map((track) => track.title));
    expect(readFileSync(resolve('src/demo/mode.ts'), 'utf8')).toMatch(
      /\.demo-track-title'\)\.forEach\(\(el\) => \{\s*el\.textContent = track\.shortTitle;/u,
    );
  });

  it('keeps the title on one line with an ellipsis as the net', () => {
    // After the header exit went, 162 of 1,176 cases (42 locales, 320 to
    // 420px, 4 tracks) still took two lines with the album; with the track
    // name alone none does, and the ellipsis only guards a longer name.
    expect(declared('.demo-track-title', 'white-space')).toEqual(['nowrap']);
    expect(declared('.demo-track-title', 'overflow')).toEqual(['hidden']);
    expect(declared('.demo-track-title', 'text-overflow')).toEqual(['ellipsis']);
    expect(declared('.demo-track-title', 'overflow-wrap')).toEqual(['normal']);
  });
});

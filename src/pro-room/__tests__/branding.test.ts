// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import {
  initProRoomBranding,
  syncProRoomBrandingForTests as syncProRoomBranding,
} from '../branding.ts';

function readTranslateX(element: Element | null): number {
  const transform = element?.getAttribute('transform') ?? '';
  const match = transform.match(/translate\(\s*(-?\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

function readPolygonXBounds(element: Element | null): { min: number; max: number } {
  const values = (element?.getAttribute('points') ?? '')
    .trim()
    .split(/\s+/)
    .map((pair) => Number(pair.split(',')[0]));
  return { min: Math.min(...values), max: Math.max(...values) };
}

function readPathInitialX(element: Element | null): number {
  const match = (element?.getAttribute('d') ?? '').match(/^M(-?\d+(?:\.\d+)?),/);
  if (!match) throw new Error('Expected an absolute initial SVG path coordinate.');
  return Number(match[1]);
}

function readPathInitialY(element: Element | null): number {
  const match = (element?.getAttribute('d') ?? '').match(/^M-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/);
  if (!match) throw new Error('Expected an absolute initial SVG path coordinate.');
  return Number(match[1]);
}

beforeEach(() => {
  document.body.innerHTML = `
    <svg id="header-standard-wordmark"></svg>
    <svg id="header-pro-wordmark"></svg>
  `;
  document.documentElement.removeAttribute('data-pro-room');
  bus.clear();
  resetState();
});

describe('PRO room branding', () => {
  it('uses a dedicated one-line MXQR PRO wordmark instead of a generic badge', async () => {
    const markup = await readFile('index.html', 'utf8');
    const stylesheet = await readFile('css/style.css', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const standardWordmark = parsed.getElementById('header-standard-wordmark');
    const proWordmark = parsed.getElementById('header-pro-wordmark');
    const betaBadges = parsed.querySelectorAll('.media-source-beta-badge');

    expect(standardWordmark?.tagName).toBe('svg');
    expect(proWordmark?.tagName).toBe('svg');
    expect(proWordmark?.getAttribute('viewBox')).toBe('43 12 170 24');
    expect(proWordmark?.querySelectorAll('[data-glyph]')).toHaveLength(7);
    const proSuffix = proWordmark?.querySelector('[data-wordmark-segment="pro"]');
    expect(
      Array.from(proSuffix?.children ?? []).map((glyph) => glyph.getAttribute('data-glyph')),
    ).toEqual(['P', 'R', 'O']);
    expect(proWordmark?.querySelectorAll(':scope > [data-glyph]')).toHaveLength(4);
    expect(proWordmark?.querySelector('text')).toBeNull();
    expect(parsed.getElementById('header-pro-badge')).toBeNull();
    expect(stylesheet).toMatch(/\.header-pro-wordmark\s*{\s*display:\s*none;/);
    expect(stylesheet).toMatch(
      /html\[data-pro-room\]\s+#header-standard-wordmark\s*{\s*display:\s*none;/,
    );
    expect(stylesheet).toMatch(
      /html\[data-pro-room\]\s+\.header-pro-wordmark\s*{\s*display:\s*block;/,
    );
    expect(stylesheet).toMatch(/\.header-pro-suffix\s*\{\s*opacity:\s*0\.5;/);
    expect(betaBadges).toHaveLength(2);
    for (const badge of betaBadges) {
      expect(badge.classList.contains('feature-badge')).toBe(true);
    }
  });

  it('reuses the production M X Q R geometry verbatim and preserves the full R tail', async () => {
    const markup = await readFile('index.html', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const standard = parsed.getElementById('header-standard-wordmark');
    const pro = parsed.getElementById('header-pro-wordmark');
    const standardChildren = standard ? Array.from(standard.children) : [];

    expect(pro?.querySelector('[data-glyph="M"]')?.getAttribute('points')).toBe(
      standardChildren[0]?.getAttribute('points'),
    );
    expect(pro?.querySelector('[data-glyph="X"]')?.getAttribute('points')).toBe(
      standardChildren[4]?.getAttribute('points'),
    );
    expect(pro?.querySelector('[data-glyph="Q"]')?.getAttribute('d')).toBe(
      standardChildren[5]?.getAttribute('d'),
    );
    const originalR = standardChildren[8]?.getAttribute('d');
    const proRs = pro?.querySelectorAll('[data-glyph="R"]') ?? [];
    expect(proRs).toHaveLength(2);
    for (const proR of proRs) expect(proR.getAttribute('d')).toBe(originalR);
    expect(originalR).toContain('5.8306272,10.0920839');
    expect(originalR).toContain('-4.5310104-7.8424689');
  });

  it('lowers the P bowl while preserving its original stroke weight', async () => {
    const markup = await readFile('index.html', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const pro = parsed.getElementById('header-pro-wordmark');
    const p = pro?.querySelector('[data-glyph="P"]') ?? null;
    const suffixR = pro?.querySelector('[data-wordmark-segment="pro"] [data-glyph="R"]') ?? null;

    const pPath = p?.getAttribute('d') ?? '';
    expect(readPathInitialY(p) - readPathInitialY(suffixR)).toBeCloseTo(1.5, 4);
    expect(pPath).toContain('.0013333,5.9999998-8.9999996.0026666-.0013333-5.9999998Z');
  });

  it('carries the production X optical kerning into MXQR without opening the suffix', async () => {
    const markup = await readFile('index.html', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const standard = parsed.getElementById('header-standard-wordmark');
    const pro = parsed.getElementById('header-pro-wordmark');
    const standardChildren = standard ? Array.from(standard.children) : [];

    const standardI = standardChildren[3];
    const standardX = standardChildren[4];
    const standardQ = standardChildren[5];
    const standardXBounds = readPolygonXBounds(standardX);
    const standardIEnd =
      Number(standardI?.getAttribute('x')) + Number(standardI?.getAttribute('width'));
    const standardLeftGap = standardXBounds.min - standardIEnd;
    const standardRightGap = readPathInitialX(standardQ) - standardXBounds.max;

    const proM = pro?.querySelector('[data-glyph="M"]') ?? null;
    const proX = pro?.querySelector('[data-glyph="X"]') ?? null;
    const proQ = pro?.querySelector('[data-glyph="Q"]') ?? null;
    const proMBounds = readPolygonXBounds(proM);
    const proXBounds = readPolygonXBounds(proX);
    const proLeftGap =
      proXBounds.min + readTranslateX(proX) - (proMBounds.max + readTranslateX(proM));
    const proRightGap =
      readPathInitialX(proQ) + readTranslateX(proQ) - (proXBounds.max + readTranslateX(proX));

    expect(proLeftGap).toBeCloseTo(standardLeftGap, 2);
    expect(proRightGap).toBeCloseTo(standardRightGap, 3);
    expect(proLeftGap).toBeLessThan(3);
    expect(proRightGap).toBeLessThan(3);

    const qTranslate = readTranslateX(proQ);
    const suffixTranslationOffsets = Array.from(
      pro?.querySelectorAll('[data-glyph="R"], [data-glyph="P"], [data-glyph="O"]') ?? [],
    ).map((glyph) => readTranslateX(glyph) - qTranslate);
    expect(suffixTranslationOffsets).toEqual([-45, -13.5, 9, 100]);
  });

  it('yields either wordmark before collapsing the compact sidebar labels', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const compactStart = stylesheet.indexOf('@media (min-width: 720px) and (max-width: 1279px) {');
    const compactEnd = stylesheet.indexOf('/* iPad PWA portrait', compactStart);
    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(compactEnd).toBeGreaterThan(compactStart);
    const compactSidebarStyles = stylesheet.slice(compactStart, compactEnd);

    expect(compactSidebarStyles).toMatch(
      /#app-logo\s*{\s*flex-direction:\s*row;\s*align-items:\s*center;/,
    );
    expect(compactSidebarStyles).toMatch(
      /html\[data-pro-room\]\s+#app-logo\s*\{\s*align-self:\s*flex-start;\s*margin-inline-start:\s*13px;/,
    );
    expect(compactSidebarStyles).toMatch(
      /@media\s*\(max-height:\s*370px\)[\s\S]*?html:not\(\.keyboard-open\) #app-logo\s*\{\s*display:\s*none\s*!important;/,
    );
    expect(compactSidebarStyles).toMatch(/@media\s*\(max-height:\s*300px\)/);
    expect(compactSidebarStyles.indexOf('@media (max-height: 370px)')).toBeLessThan(
      compactSidebarStyles.indexOf('@media (max-height: 300px)'),
    );
  });

  it('removes the standard-room guided demo affordance from PRO rooms', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');

    expect(stylesheet).toMatch(
      /html\[data-pro-room\]\s+#btn-demo-media,\s*html\[data-pro-room\]\s+#btn-demo-media-mobile\s*\{\s*display:\s*none\s*!important;/,
    );
  });

  it('keeps the persistent-storage disclosure contextual to PRO rooms', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');

    expect(stylesheet).toMatch(/\[data-legal-standard-storage\]\s*{\s*display:\s*inline;/);
    expect(stylesheet).toMatch(/\[data-legal-pro-storage\]\s*{\s*display:\s*none;/);
    expect(stylesheet).toMatch(
      /html\[data-pro-room\]\s+\[data-legal-standard-storage\]\s*{\s*display:\s*none;/,
    );
    expect(stylesheet).toMatch(
      /html\[data-pro-room\]\s+\[data-legal-pro-storage\]\s*{\s*display:\s*inline;/,
    );
  });

  it('keeps equal PRO role badges on the primary blue identity treatment', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    expect(stylesheet).toMatch(
      /\.role-badge\.pro-equal\s*{\s*background:\s*var\(--primary-filled\);\s*color:\s*white;/,
    );
    expect(stylesheet).not.toContain('.role-dot');
  });

  it('stays hidden for standard and idle sessions', () => {
    syncProRoomBranding('');
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(false);

    syncProRoomBranding('123456');
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(false);
  });

  it('shows only inside the reserved PRO namespace', () => {
    syncProRoomBranding('000001');
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(true);
  });

  it('reacts to the canonical session-code state', () => {
    initProRoomBranding();

    setState('network.sessionCode', '000000');
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(true);

    setState('network.sessionCode', '654321');
    expect(document.documentElement.hasAttribute('data-pro-room')).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(resolve('css/style.css'), 'utf8');
const desktopStylesheet = readFileSync(resolve('css/desktop.css'), 'utf8');
const markup = readFileSync(resolve('index.html'), 'utf8');
const document = new JSDOM(markup).window.document;

describe('visualizer layout contract', () => {
  it('seeds the complete standalone iOS landscape surface before JS reconciliation', () => {
    expect(stylesheet).toMatch(
      /@supports \(-webkit-touch-callout: none\)\s*\{\s*@media \(display-mode: standalone\) and \(orientation: landscape\)\s*\{\s*:root\s*\{\s*--app-height:\s*100vh;/u,
    );
    expect(stylesheet).not.toMatch(/--safe-bottom:\s*0(?:px)?\s*[;}]/u);
  });

  it('mounts the visualizer and YouTube surface in one shared stage', () => {
    expect(markup).toMatch(
      /class="playback-stage"[\s\S]*?class="vinyl-wrapper"[\s\S]*?class="video-wrapper"/u,
    );
    expect(stylesheet).toMatch(
      /\.playback-stage\s*\{[\s\S]*?max-width:\s*600px;[\s\S]*?min-height:\s*0;[\s\S]*?aspect-ratio:\s*16\s*\/\s*9;[\s\S]*?contain:\s*size;[\s\S]*?flex-shrink:\s*0;/u,
    );
    expect(stylesheet).toMatch(
      /\.video-wrapper\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?border-radius:\s*16px;[\s\S]*?position:\s*absolute;/u,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 719\.98px\)\s*\{[\s\S]*?#tab-play\s*\{[\s\S]*?padding-top:\s*var\(--header-height\);[\s\S]*?#tab-play \.tab-body\s*\{[\s\S]*?padding-top:\s*0;[\s\S]*?#tab-play \.play-secondary-area\s*\{[\s\S]*?margin-bottom:\s*auto;[\s\S]*?\.playback-stage\s*\{[\s\S]*?max-width:\s*none;[\s\S]*?\.video-wrapper\s*\{[\s\S]*?border-radius:\s*0;/u,
    );
    expect(stylesheet).not.toContain('@media (orientation: portrait) and (max-width: 1279px)');
  });

  it('keeps fixed visual insets while the active variable gaps share free height', () => {
    const playGroups = Array.from(document.querySelectorAll('#tab-play > .tab-body > *'));
    expect(playGroups.slice(0, 4).map((element) => element.className)).toEqual([
      'playback-stage',
      'track-box',
      'controls-area',
      'play-secondary-area',
    ]);
    expect(stylesheet).toMatch(
      /\.track-box,\s*\.controls-area,\s*\.play-secondary-area\s*\{[\s\S]*?padding:\s*20px 24px 0;[\s\S]*?margin-top:\s*0;/u,
    );
    expect(stylesheet).toMatch(
      /\.track-box,\s*\.play-secondary-area\s*\{[\s\S]*?margin-top:\s*auto;/u,
    );
    expect(stylesheet).toMatch(
      /@media \(max-height: 720px\) and \(orientation: portrait\)\s*\{\s*\.track-artist\s*\{\s*display:\s*none;/u,
    );
    expect(stylesheet).toMatch(/\.controls-area\s*\{\s*padding-top:\s*12px;/u);
    expect(stylesheet).toMatch(
      /\.play-secondary-area\s*\{[\s\S]*?padding-top:\s*32px;[\s\S]*?padding-bottom:\s*24px;/u,
    );
    expect(stylesheet).toMatch(/--nav-height:\s*64px;/u);
    expect(stylesheet).toMatch(
      /\.bottom-nav\s*\{[\s\S]*?padding:\s*10px 16px calc\(10px \+ var\(--safe-bottom\) \+ var\(--safe-nav-bottom, 0px\)\);/u,
    );
    expect(stylesheet).toMatch(/\.nav-item\s*\{[\s\S]*?min-height:\s*44px;/u);
    expect(stylesheet).toMatch(
      /\.toast\s*\{[^}]*?--toast-rest-bottom:\s*110px;[^}]*?bottom:\s*var\(--toast-rest-bottom\);/u,
    );
    expect(stylesheet).toMatch(
      /\.playlist-selection-bar\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?bottom:\s*-10px;/u,
    );
    expect(desktopStylesheet).toMatch(
      /#tab-play \.tab-body::before\s*\{[\s\S]*?content:\s*'';[\s\S]*?flex:\s*0 0 0;[\s\S]*?margin-top:\s*auto;/u,
    );
    expect(desktopStylesheet).toMatch(
      /#tab-play \.controls-area\s*\{[\s\S]*?margin-top:\s*0;[\s\S]*?margin-bottom:\s*auto;/u,
    );
    expect(desktopStylesheet).toMatch(
      /#tab-play \.tab-body\s*\{[^}]*?padding-top:\s*0;[^}]*?padding-bottom:\s*var\(--safe-bottom\);[^}]*?scroll-padding-bottom:\s*var\(--safe-bottom\);/u,
    );
    expect(desktopStylesheet).toMatch(
      /#tab-play\s*\{[\s\S]*?grid-area:\s*tab-play;[\s\S]*?padding:\s*0 44px;/u,
    );
    expect(desktopStylesheet).toMatch(
      /\.track-box,\s*\.controls-area,\s*\.play-secondary-area\s*\{[\s\S]*?width:\s*calc\(var\(--playback-rail-width\) - 8px\);[\s\S]*?padding:\s*20px 0 0;[\s\S]*?margin-inline-start:\s*auto;[\s\S]*?margin-inline-end:\s*auto;/u,
    );
    expect(desktopStylesheet).toMatch(/\.controls-area\s*\{\s*padding-top:\s*12px;/u);
    // Desktop keeps the base wrapper's 16px corners: it never restates the wrapper.
    expect(desktopStylesheet).not.toContain('.video-wrapper');
    expect(stylesheet).toMatch(
      /\.video-wrapper:fullscreen,[\s\S]*?\.video-wrapper:-webkit-full-screen\s*\{[\s\S]*?border-radius:\s*0;/u,
    );
    expect(stylesheet).toMatch(/\.playback-stage\s*\{[\s\S]*?margin:\s*auto auto 0;/u);
  });

  it('keeps a phone toast 16px above the floating selection bar', () => {
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const body = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(
        stylesheet,
      )?.[1];
      expect(body, selector).toBeDefined();
      return body!;
    };
    const px = (declarations: string, pattern: RegExp): number => {
      const value = pattern.exec(declarations)?.[1];
      expect(value, String(pattern)).toBeDefined();
      return Number.parseFloat(value!);
    };
    // The tab body clears the nav plus this much; the sticky bar floats inside it.
    const clearance = px(
      rule('.tab-body'),
      /padding-bottom:\s*calc\(\s*var\(--nav-height\) \+ var\(--safe-bottom\) \+ var\(--safe-nav-bottom, 0px\) \+ (\d+)px\s*\)/u,
    );
    const bar = rule('.playlist-selection-bar');
    const barAboveNav = clearance + px(bar, /\bbottom:\s*(-?\d+)px;/u);
    const barHeight =
      px(rule('.playlist-selection-action'), /\bheight:\s*(\d+)px;/u) +
      2 * px(bar, /\bpadding:\s*(\d+)px;/u) +
      2 * px(bar, /\bborder:\s*(\d+)px solid/u);
    // The bar's owner writes the place while the bar is up; until then the
    // toast keeps above the floating bar.
    const toastOffset = px(
      stylesheet,
      /@media \(max-width: 719\.98px\)\s*\{\s*body:has\(#tab-playlist\.active \.playlist-selection-bar:not\(\[hidden\]\):not\(\[data-state='leaving'\]\)\)\s*\.toast\s*\{\s*bottom:\s*var\(\s*--toast-clear-bottom,\s*calc\(var\(--nav-height\) \+ var\(--safe-bottom\) \+ var\(--safe-nav-bottom, 0px\) \+ (\d+)px\)\s*\);/u,
    );
    // The gap the bar's owner keeps when it moves a toast above the bar.
    const toastClearance = px(
      readFileSync(resolve('src/ui/playlist-removal.ts'), 'utf8'),
      /\bconst TOAST_CLEARANCE_PX = (\d+);/u,
    );
    expect({ barAboveNav, barHeight }).toEqual({ barAboveNav: 14, barHeight: 70 });
    expect(toastOffset - barAboveNav - barHeight).toBe(16);
    expect(toastClearance).toBe(16);
  });

  it('centers both visualizer modes inside the shared stage without sizing the stage', () => {
    const circularRule = stylesheet.match(/\.vinyl-wrapper\s*\{([^}]*)\}/u)?.[1];
    const spectrumRule = stylesheet.match(/body\.viz-spectrum \.vinyl-wrapper\s*\{([^}]*)\}/u)?.[1];

    expect(circularRule).toMatch(
      /height:\s*min\(100%,\s*var\(--visualizer-content-block-size\)\)/u,
    );
    expect(circularRule).toMatch(/width:\s*auto/u);
    expect(circularRule).toMatch(/aspect-ratio:\s*1/u);
    expect(spectrumRule).toBeDefined();
    expect(spectrumRule).toMatch(/width:\s*100%/u);
    expect(spectrumRule).toMatch(
      /height:\s*min\(100%,\s*var\(--visualizer-content-block-size\)\)/u,
    );
  });

  it('uses an adaptive desktop stage rail with a centered optical controls inset', () => {
    expect(desktopStylesheet).toMatch(
      /#tab-play\s*\{[\s\S]*?--playback-rail-width:\s*min\([\s\S]*?100%,[\s\S]*?max\(360px,\s*calc\(\(var\(--desktop-viewport-height\)\s*-\s*400px\)\s*\*\s*16\s*\/\s*9\)\)[\s\S]*?\);/u,
    );
    expect(desktopStylesheet).toMatch(
      /\.playback-stage\s*\{[\s\S]*?width:\s*var\(--playback-rail-width\);/u,
    );
  });
});

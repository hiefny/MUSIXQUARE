import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(resolve('css/style.css'), 'utf8');
const desktopStylesheet = readFileSync(resolve('css/desktop.css'), 'utf8');
const markup = readFileSync(resolve('index.html'), 'utf8');
const document = new JSDOM(markup).window.document;

describe('visualizer layout contract', () => {
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
      /@media \(max-width: 719px\)\s*\{[\s\S]*?#tab-play\s*\{[\s\S]*?padding-top:\s*var\(--header-height\);[\s\S]*?#tab-play \.tab-body\s*\{[\s\S]*?padding-top:\s*0;[\s\S]*?#tab-play \.play-secondary-area\s*\{[\s\S]*?margin-bottom:\s*auto;[\s\S]*?\.playback-stage\s*\{[\s\S]*?max-width:\s*none;[\s\S]*?\.video-wrapper\s*\{[\s\S]*?border-radius:\s*0;/u,
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
      /@media \(max-width: 1279px\) and \(max-height: 720px\)\s*\{\s*\.track-artist\s*\{\s*display:\s*none !important;/u,
    );
    expect(stylesheet).toMatch(/\.controls-area\s*\{\s*padding-top:\s*12px;/u);
    expect(stylesheet).toMatch(
      /\.play-secondary-area\s*\{[\s\S]*?padding-top:\s*32px;[\s\S]*?padding-bottom:\s*24px;/u,
    );
    expect(desktopStylesheet).toMatch(
      /#tab-play \.tab-body::before\s*\{[\s\S]*?content:\s*'';[\s\S]*?flex:\s*0 0 0;[\s\S]*?margin-top:\s*auto;/u,
    );
    expect(desktopStylesheet).toMatch(
      /#tab-play \.controls-area\s*\{[\s\S]*?margin-top:\s*0;[\s\S]*?margin-bottom:\s*auto;/u,
    );
    expect(desktopStylesheet).toMatch(
      /#tab-play \.tab-body\s*\{[\s\S]*?padding-top:\s*0;[\s\S]*?padding-bottom:\s*0;/u,
    );
    expect(desktopStylesheet).toMatch(
      /#tab-play\s*\{[\s\S]*?grid-area:\s*tab-play;[\s\S]*?padding:\s*0 44px;/u,
    );
    expect(desktopStylesheet).toMatch(
      /\.track-box,\s*\.controls-area,\s*\.play-secondary-area\s*\{[\s\S]*?width:\s*calc\(var\(--playback-rail-width\) - 8px\);[\s\S]*?padding:\s*20px 0 0;[\s\S]*?margin-left:\s*auto;[\s\S]*?margin-right:\s*auto;/u,
    );
    expect(desktopStylesheet).toMatch(/\.controls-area\s*\{\s*padding-top:\s*12px;/u);
    expect(desktopStylesheet).toMatch(/\.video-wrapper\s*\{[\s\S]*?border-radius:\s*16px;/u);
    expect(stylesheet).toMatch(
      /\.video-wrapper:fullscreen,[\s\S]*?\.video-wrapper:-webkit-full-screen\s*\{[\s\S]*?border-radius:\s*0 !important;/u,
    );
    expect(stylesheet).toMatch(/\.playback-stage\s*\{[\s\S]*?margin:\s*auto auto 0;/u);
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

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
      /\.video-wrapper\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?position:\s*absolute;/u,
    );
  });

  it('keeps the middle gap fixed while three variable gaps share free height', () => {
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
    expect(desktopStylesheet).toMatch(/#tab-play \.controls-area\s*\{[\s\S]*?margin-top:\s*0;/u);
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

  it('uses the former iframe footprint for the desktop shared stage', () => {
    expect(desktopStylesheet).toMatch(
      /\.playback-stage\s*\{[\s\S]*?width:\s*min\([\s\S]*?90%,[\s\S]*?max\(calc\(160px\s*\*\s*16\s*\/\s*9\),\s*calc\(\(var\(--desktop-viewport-height\)\s*-\s*400px\)\s*\*\s*16\s*\/\s*9\)\)[\s\S]*?\);/u,
    );
  });
});

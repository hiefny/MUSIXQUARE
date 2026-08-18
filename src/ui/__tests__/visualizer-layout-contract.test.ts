import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(resolve('css/style.css'), 'utf8');

describe('visualizer layout contract', () => {
  it('reserves one responsive block size for circular and spectrum modes', () => {
    expect(stylesheet).toMatch(
      /\.vinyl-wrapper\s*\{[\s\S]*?--visualizer-stage-block-size:\s*min\(55vw,\s*320px\);[\s\S]*?flex-basis:\s*var\(--visualizer-stage-block-size\);/u,
    );
    expect(stylesheet).toMatch(
      /body\.viz-spectrum \.vinyl-wrapper\s*\{[\s\S]*?width:\s*100%;[\s\S]*?flex-basis:\s*var\(--visualizer-stage-block-size\);[\s\S]*?aspect-ratio:\s*auto;/u,
    );
  });

  it('does not restore a mode-specific intrinsic height', () => {
    const spectrumRule = stylesheet.match(/body\.viz-spectrum \.vinyl-wrapper\s*\{([^}]*)\}/u)?.[1];

    expect(spectrumRule).toBeDefined();
    expect(spectrumRule).not.toMatch(/flex-basis:\s*auto/u);
    expect(spectrumRule).not.toMatch(/aspect-ratio:\s*5\s*\/\s*3/u);
  });
});

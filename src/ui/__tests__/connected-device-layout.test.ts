import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('connected-device list layout', () => {
  it('reserves stable row rails for disclosures and per-device removal', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const memberRowRules = stylesheet.match(/\.device-row\s*\{([^}]*)\}/)?.[1] ?? '';
    const deviceSubrowRules = stylesheet.match(/\.device-subrow\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(memberRowRules).toContain('min-height: 64px');
    expect(deviceSubrowRules).toContain('min-height: 44px');
    expect(deviceSubrowRules).toContain('box-sizing: border-box');
  });

  it('keeps authorized physical-device removal visible before hover', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const kickButtonRules =
      stylesheet.match(/\.btn-kick-device,\s*\.btn-kick-physical-device\s*\{([^}]*)\}/)?.[1] ?? '';
    const deviceHoverRules =
      stylesheet.match(/\.device-subrow:hover \.btn-kick-physical-device\s*\{([^}]*)\}/)?.[1] ?? '';
    const coarsePointerRules =
      stylesheet.match(
        /@media \(pointer: coarse\)\s*\{[\s\S]*?\.btn-kick-physical-device\s*\{([^}]*)\}/,
      )?.[1] ?? '';

    expect(kickButtonRules).toContain('opacity: 1');
    expect(deviceHoverRules).toContain('opacity: 1');
    expect(coarsePointerRules).toContain('opacity: 1');
    expect(stylesheet).toMatch(
      /\.device-subrow:hover \.btn-kick-physical-device:hover,\s*\.btn-kick-physical-device:focus-visible\s*\{[^}]*color:\s*#ff4d4f;/s,
    );
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('connected-device list layout', () => {
  it('matches administrator and connected-device rows to the playlist row rail', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const rootRules = stylesheet.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
    const playlistRowRules = stylesheet.match(/\.track-item\s*\{([^}]*)\}/)?.[1] ?? '';
    const memberRowRules = stylesheet.match(/\.device-row\s*\{([^}]*)\}/)?.[1] ?? '';
    const deviceSubrowRules = stylesheet.match(/\.device-subrow\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rootRules).toContain('--list-row-height: 56px');
    expect(playlistRowRules).toContain('min-height: var(--list-row-height)');
    expect(memberRowRules).toContain('padding: 12px 16px');
    expect(memberRowRules).toContain('min-height: var(--list-row-height)');
    expect(deviceSubrowRules).toContain('min-height: 44px');
    expect(deviceSubrowRules).toContain('box-sizing: border-box');
  });

  it('keeps authorized physical-device removal visible before hover', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    const kickButtonRules =
      stylesheet.match(/\.btn-kick-device,\s*\.btn-kick-physical-device\s*\{([^}]*)\}/)?.[1] ?? '';

    // Visible on every input without a pointer-specific override, and nothing
    // dims it, so no rule restores an opacity on row hover; hover only colors
    // it (src/ui/hover-pointer.ts owns when hover applies).
    expect(kickButtonRules).toContain('color: var(--text-muted)');
    expect(kickButtonRules).not.toContain('opacity');
    expect(stylesheet).not.toMatch(/\.device-(?:row|subrow):hover \.btn-kick-[\w-]+\s*\{/);
    expect(stylesheet).not.toMatch(/@media \(pointer: coarse\)/);
    expect(stylesheet).toMatch(
      /:where\(html\[data-hover-pointer\]\) \.device-subrow:hover \.btn-kick-physical-device:hover,\s*\.btn-kick-physical-device:focus-visible\s*\{[^}]*color:\s*var\(--danger-foreground\);/s,
    );
  });
});

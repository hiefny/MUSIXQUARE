import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function stylesheetLayer(name: string): Promise<string> {
  const css = await readFile('css/style.css', 'utf8');
  const start = css.indexOf(`@layer ${name} {`);
  if (start < 0) throw new Error(`Missing @layer ${name}`);
  const next = css.indexOf('\n@layer ', start + 1);
  return css.slice(start, next < 0 ? undefined : next);
}

describe('phone portrait setup centering', () => {
  it('centers the middle block between the header and the actions', async () => {
    // The components layer gives the carousel `flex: 1`; only a later layer
    // can make it shrink to its content so the auto margins have room.
    const responsive = await stylesheetLayer('responsive');
    const blocks = [
      ...responsive.matchAll(
        /@media \(max-width: 719px\) and \(orientation: portrait\) \{\n([\s\S]*?)\n {2}\}/g,
      ),
    ].map((match) => match[1] ?? '');
    const block = blocks.find((body) => body.includes('#setup-welcome-area > #ob-slider-area'));

    expect(block).toBeDefined();
    expect(block).toMatch(
      /#setup-code-area > \.setup-host-invite-stage,\s*#setup-join-area > \.setup-guest-qr-stage \{\s*margin-top: auto;\s*\}/,
    );
    expect(block).toMatch(
      /#setup-code-area > \.setup-code-area-bottom,\s*#setup-join-area > \.setup-code-area-bottom \{\s*margin-bottom: auto;\s*padding-bottom: 40px;\s*\}/,
    );
    expect(block).toMatch(
      /#setup-welcome-area > #ob-slider-area \{\s*flex: none;\s*margin-block: auto;\s*padding-bottom: 36px;\s*\}/,
    );
  });

  it('keeps the gaps the bottom paddings are derived from', async () => {
    // 40px = 56px header gap - 16px actions top padding. 36px = 56px + 4px
    // viewport top margin - 8px nav-row bottom margin - 16px. Change them
    // together.
    const css = await readFile('css/style.css', 'utf8');

    expect(css).toMatch(/\.setup-header-text \{\s*width: 100%;\s*margin-bottom: 56px;/);
    expect(css).toMatch(
      /\.ob-actions \{[^}]*padding: 16px 28px calc\(24px \+ env\(safe-area-inset-bottom, 0\)\);/,
    );
    expect(css).toMatch(/\.ob-slider-viewport \{[^}]*margin: 4px 0;/);
    expect(css).toMatch(/\.ob-nav-row \{[^}]*margin-top: 24px;\s*margin-bottom: 8px;/);
  });
});

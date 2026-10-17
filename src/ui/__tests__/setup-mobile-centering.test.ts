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
  it('centers the visible middle block between the header and the actions', async () => {
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
      /#setup-code-area > \.setup-code-area-bottom,\s*#setup-join-area > \.setup-code-area-bottom \{\s*margin-bottom: auto;\s*\}/,
    );
    expect(block).toMatch(
      /#setup-code-area > \.setup-code-area-bottom \{\s*padding-bottom: calc\(27\.5px \+ 0\.08 \* min\(272px, 56vw, 36vh\)\);\s*padding-bottom: calc\(27\.5px \+ 0\.08 \* min\(272px, 56vw, 36dvh\)\);\s*\}/,
    );
    expect(block).toMatch(
      /#setup-join-area > \.setup-code-area-bottom \{\s*padding-bottom: calc\(45px \+ 0\.08 \* min\(272px, 56vw, 36vh\)\);\s*padding-bottom: calc\(45px \+ 0\.08 \* min\(272px, 56vw, 36dvh\)\);\s*\}/,
    );
    expect(block).toMatch(
      /#setup-welcome-area > #ob-slider-area \{\s*flex: none;\s*margin-block: auto;\s*padding-bottom: 41px;\s*\}/,
    );
  });

  it('keeps the gaps the bottom paddings are derived from', async () => {
    // Above the block: the header's 56px margin, ~5px of line spacing under a
    // 16px / 1.5 subtitle, and the 8% transparent inset of the QR square (a
    // two-module margin around a 21-module code) or the 84% scan button. Below
    // it: the actions' 16px top padding, the nav row's 8px margin, and ~17.5px
    // under the 32px code digits. Change them together.
    const css = await readFile('css/style.css', 'utf8');
    const invite = await readFile('src/ui/setup-host-invite.ts', 'utf8');

    expect(css).toMatch(/\.setup-header-text \{\s*width: 100%;\s*margin-bottom: 56px;/);
    expect(css).toMatch(/\.setup-header-text p \{\s*font-size: 16px;[^}]*line-height: 1\.5;/);
    expect(css).toMatch(
      /\.ob-actions \{[^}]*padding: 16px 28px calc\(24px \+ env\(safe-area-inset-bottom, 0\)\);/,
    );
    expect(css).toMatch(/\.ob-slider-viewport \{[^}]*margin: 4px 0;/);
    expect(css).toMatch(/\.ob-nav-row \{[^}]*margin-top: 24px;\s*margin-bottom: 8px;/);
    expect(css).toMatch(
      /\.setup-host-qr \{\s*width: min\(272px, 56vw, 36vh\);\s*width: min\(272px, 56vw, 36dvh\);/,
    );
    expect(css).toMatch(
      /\.setup-guest-qr-stage \{[^}]*width: min\(272px, 56vw, 36vh\);\s*width: min\(272px, 56vw, 36dvh\);/,
    );
    expect(css).toMatch(/\.setup-qr-scan-button,\s*\.setup-qr-camera \{[^}]*width: 84%;/);
    expect(css).toMatch(/\.setup-join-input \{[^}]*padding: 8px 0;\s*font-size: 32px;/);
    expect(invite).toContain("const HOST_INVITE_ROOT = 'MUSIXQUARE.COM';");
    expect(invite).toMatch(/type: 'svg',\s*margin: 2,\s*errorCorrectionLevel: 'L'/);
  });
});

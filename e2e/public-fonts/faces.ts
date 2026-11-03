/**
 * What the opt-in public font labs share (playwright.public-fonts.config.ts):
 * the Hangul MUSIXQUARE Hangul draws, the requests that must not happen, and
 * the faces of a node read with CSS.getPlatformFontsForNode.
 */
import { readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';

/** Requests of the retired font delivery: Pretendard, the original sheets, the deployed copy. */
export const RETIRED_FONT_REQUEST = /pretendard|\/css\/fonts\/|\/designsystem\/fonts\//iu;

/** The code points MUSIXQUARE Hangul draws (fonts/hangul-faces.json). */
export const HANGUL_FAMILY_CODE_POINTS: ReadonlySet<number> = (() => {
  const record = JSON.parse(
    readFileSync(new URL('../../fonts/hangul-faces.json', import.meta.url), 'utf8'),
  ) as { faces: { unicodeRange: string }[] };
  const codePoints = new Set<number>();
  for (const { unicodeRange } of record.faces) {
    for (const token of unicodeRange.split(',')) {
      const [start = '', end] = token.trim().slice(2).split('-');
      for (let at = Number.parseInt(start, 16); at <= Number.parseInt(end ?? start, 16); at += 1) {
        codePoints.add(at);
      }
    }
  }
  return codePoints;
})();

/** One face Chromium drew a node's text with. */
export interface PlatformFace {
  readonly familyName: string;
  readonly isCustomFont: boolean;
}

/** The faces Chromium drew each node matching `selector` with, in document order. */
export async function platformFaces(page: Page, selector: string): Promise<PlatformFace[][]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    const faces: PlatformFace[][] = [];
    for (const nodeId of nodeIds) {
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      faces.push(fonts.map(({ familyName, isCustomFont }) => ({ familyName, isCustomFont })));
    }
    return faces;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Whether a reported face is the family: a variable face may report an instance name. */
export function isFamily(face: PlatformFace | undefined, family: string): boolean {
  return (
    face?.isCustomFont === true &&
    (face.familyName === family || face.familyName.startsWith(`${family} `))
  );
}

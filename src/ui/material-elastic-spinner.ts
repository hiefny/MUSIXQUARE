/**
 * The shared loader's parts (css/style.css `.material-elastic-spinner`).
 *
 * It turns as Google's Material circular progress does (Material Components
 * Web 14, `@material/circular-progress`, MIT; THIRD-PARTY-NOTICES.md), the
 * owner's choice of 2026-11-16 (App 9.0.53), drawn on our ring. Every part
 * moves by a transform alone, which the compositor runs without the page: iOS
 * stops painting a page it is leaving, and the stroke dash the loader once
 * animated froze there while its turn ran on (App 9.0.50).
 * - turn (Google's container): the whole loader, one turn per 1.568 s;
 * - arc (its spinner layer): a frame whose 12 o'clock is the middle of the
 *   arc, stepping 135 degrees on eight times per 5.332 s;
 * - seam (its gap patch): a 7.2 degree arc at that 12 o'clock, at 80 % of the
 *   ring's stroke, under the line where the frame's halves meet (the shortest
 *   arc, 10 degrees, always covers it, and the halves' edges hide its own);
 * - tail and head (its left and right clippers): the frame's left and right
 *   halves, each showing the part of a turning ring piece that falls inside
 *   it, so the arc runs from the tail ring's end through 12 o'clock to the
 *   head ring's end; the rings swing every 1.333 s, the arc 10 to 280
 *   degrees long. Each piece is the 150 degrees of the ring that can ever show
 *   (the tail from 3 o'clock, the head up to 9 o'clock), so its hidden end
 *   never comes near the line the two halves share (Google's whole half rings
 *   come within 5 degrees of it, and showed through as a speck in 9.0.50).
 *
 * index.html (its splash and static loaders) and the design-system page carry
 * the same markup; `__tests__/material-elastic-spinner.test.ts` pins every copy.
 */
export const MATERIAL_ELASTIC_SPINNER_PARTS =
  '<span class="material-elastic-turn"><span class="material-elastic-arc">' +
  '<svg class="material-elastic-seam" viewBox="0 0 44 44" focusable="false">' +
  '<path d="M20.8698 4.0355A18 18 0 0 1 23.1302 4.0355"/></svg>' +
  '<span class="material-elastic-tail"><svg viewBox="0 0 44 44" focusable="false">' +
  '<path d="M40 22A18 18 0 0 1 6.4115 31"/></svg></span>' +
  '<span class="material-elastic-head"><svg viewBox="0 0 44 44" focusable="false">' +
  '<path d="M37.5885 31A18 18 0 0 1 4 22"/></svg></span>' +
  '</span></span>';

/**
 * The turn's period: Google's container turn, 1568.2352941176 ms, to the whole
 * ms, so it reads the same in every sheet, minified copy and phase copy (the
 * index.html preflight carries it as a literal; the tests pin each copy).
 */
export const MATERIAL_ELASTIC_TURN_PERIOD_MS = 1568;

/**
 * The arc's period: the spinner layer's eight steps. Its rings swing four
 * times in it (every 1333 ms), so one phase of this period serves the layer
 * and both rings.
 */
export const MATERIAL_ELASTIC_ARC_PERIOD_MS = 5332;

/**
 * The shared loader's parts (css/style.css `.material-elastic-spinner`).
 *
 * Every part moves by a transform alone, which the compositor runs without the
 * page: iOS stops painting a page it is leaving, and the stroke dash the loader
 * once animated froze there while its turn ran on (App 9.0.50).
 * - turn: the whole loader, one turn per 1.85 s;
 * - arc: a frame whose 12 o'clock follows the middle of the arc, which grows
 *   and shrinks around it every 1.45 s;
 * - seam: the shortest arc (7.2 degrees) at that 12 o'clock, under the line
 *   where the frame's halves meet (the arc always covers it);
 * - tail and head: the frame's left and right halves, each showing the part of
 *   a turning ring piece that falls inside it, so the arc runs from the tail
 *   ring's end through 12 o'clock to the head ring's end. Each piece is the
 *   150 degrees of the ring that can ever show (the tail from 3 o'clock, the
 *   head up to 9 o'clock), so its hidden end never comes near the line the
 *   two halves share (a whole half ring's did, and showed through as a speck).
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

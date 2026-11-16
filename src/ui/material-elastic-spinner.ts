/**
 * The shared loader's parts (css/style.css `.material-elastic-spinner`).
 *
 * It turns as Google's Material circular progress does (Material Components
 * Web 14, `@material/circular-progress`, MIT; THIRD-PARTY-NOTICES.md), the
 * owner's choice of 2026-11-16, and is drawn as the owner then proposed: the
 * ring is one still mask on the loader itself (the r = 18 circle of a 44 unit
 * box at each host's stroke, set in the sheets alone), and inside it two
 * filled wedges turn as Google's two half rings do. Two ring pieces drawn and
 * turned apart, Google's as ours, met a fraction of a device pixel apart at
 * some sizes and scales, the smaller the worse; a mask that never turns draws
 * the ring's inner and outer edges once, and the wedges only decide where the
 * arc starts and ends. Every part moves by a transform alone, on an HTML box,
 * which the compositor runs without the page: iOS stops painting a page it is
 * leaving, and the stroke dash the loader once animated froze there while its
 * turn ran on (App 9.0.50); Chromium runs an `<svg>`'s own transform
 * animation on the main thread whenever the device scale is not 1, so the
 * wedges turn on spans holding their drawings.
 * - turn (Google's container): the whole loader, one turn per 1.568 s;
 * - arc (its spinner layer): a frame whose 12 o'clock is the middle of the
 *   arc, stepping 135 degrees on eight times per 5.332 s;
 * - tail and head (its left and right clippers): the frame's left and right
 *   halves, each reaching 1px past the middle so both wedges' ink covers the
 *   line where they meet (Google lays a gap patch over it); each shows the
 *   part of its wedge that falls inside it as its span (ring) turns, so the
 *   arc runs from the tail wedge's side through 12 o'clock to the head
 *   wedge's side; the wedges swing every 1.333 s, the arc 10 to 280 degrees
 *   long as the keyframes turn them (the 2px strip where the halves meet
 *   always shows both wedges' ink, so a ring under 28px draws its shortest arc
 *   a little longer: about 12 degrees at 24px, 21 at the current row's 13.444px
 *   ring). Each wedge is 150 degrees from the ring's centre out past the box's
 *   corners (the tail from 3 o'clock, the head up to 9 o'clock): at most 140
 *   show, and the other 10 keep its hidden side under the other wedge's ink,
 *   far from the line the two halves share at 6 o'clock (Google's whole half
 *   rings come within 5 degrees of it, which showed through as a speck in
 *   9.0.50).
 *
 * index.html (its splash and static loaders) and the design-system page carry
 * the same markup; `__tests__/material-elastic-spinner.test.ts` pins every copy.
 */
export const MATERIAL_ELASTIC_SPINNER_PARTS =
  '<span class="material-elastic-turn"><span class="material-elastic-arc">' +
  '<span class="material-elastic-tail"><span class="material-elastic-ring">' +
  '<svg viewBox="0 0 44 44" focusable="false"><path d="M22 22L55 22A33 33 0 0 1 -6.5789 38.5Z"/></svg>' +
  '</span></span>' +
  '<span class="material-elastic-head"><span class="material-elastic-ring">' +
  '<svg viewBox="0 0 44 44" focusable="false"><path d="M22 22L50.5789 38.5A33 33 0 0 1 -11 22Z"/></svg>' +
  '</span></span>' +
  '</span></span>';

/**
 * The turn's period: Google's container turn, 1568.2352941176 ms, to the whole
 * ms, so it reads the same in every sheet, minified copy and phase copy (the
 * index.html preflight carries it as a literal; the tests pin each copy).
 */
export const MATERIAL_ELASTIC_TURN_PERIOD_MS = 1568;

/**
 * The arc's period: the spinner layer's eight steps. Its wedges swing four
 * times in it (every 1333 ms), so one phase of this period serves the layer
 * and both wedges.
 */
export const MATERIAL_ELASTIC_ARC_PERIOD_MS = 5332;

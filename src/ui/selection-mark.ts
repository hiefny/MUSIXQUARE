/**
 * MUSIXQUARE — Selection check and minus
 *
 * One mark family for every selection list: the language list, the PRO
 * password participant choice, the playlist switcher, and the minus that
 * turns into the check on playlist rows and in the move dialog. Like the
 * app's X buttons and chevrons, the marks are angular: butt ends and a
 * mitred corner.
 *
 * The end points sit past the old round-capped ones so the ink keeps its
 * box and centre at 22px. A butt end on a 45° leg reaches (2.4 / 2) / √2
 * sideways, against 2.4 / 2 for a round cap, so each leg is 0.5 longer at
 * its free end; the mitred corner reaches 0.5 further down than a round
 * join, so the check is raised 0.2. The minus is longer by half its 1.9
 * stroke at each end.
 * public/designsystem/index.html draws the same paths (pinned by test).
 */

const CHECK_PATH = 'M4.65 11.95l4.55 4.55L19.35 6.35';
const MINUS_PATH = 'M6.05 12h11.9';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** A standalone check has no stylesheet rule, so it carries its stroke. */
const CHECK_STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2.4',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
} as const;

/** The check alone: language list, choice list and playlist switcher. */
export function createSelectionCheckSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', CHECK_PATH);
  for (const [name, value] of Object.entries(CHECK_STROKE)) path.setAttribute(name, value);
  svg.appendChild(path);
  return svg;
}

/**
 * The minus and the check it turns into, for an svg with viewBox 0 0 24 24.
 * The `.playlist-select-minus, .playlist-select-mark` rule strokes both.
 */
export const SELECTION_TOGGLE_PATHS = `<path class="playlist-select-minus" d="${MINUS_PATH}"/><path class="playlist-select-mark" d="${CHECK_PATH}"/>`;

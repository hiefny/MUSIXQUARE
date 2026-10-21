/**
 * MUSIXQUARE — Selection block morph
 *
 * Selected playlist rows paint one translucent block per run of consecutive
 * rows, each row drawing its own part (`.playlist-entry::before`). When a
 * selection change reshapes the runs, the rows' parts are hidden for a moment
 * and this layer draws every run as one pill that keeps its corner radius
 * the whole way: a block stretches to take in a new row, two blocks reach
 * for each other and merge through a widening waist, and a block that loses
 * a middle row pinches apart. The pills are solid inside a layer that carries
 * the fill's alpha, so where they overlap they read as one shape, never a
 * darker band. When the morph ends the rows' parts, already in the final
 * shape, show again in the same place.
 *
 * Loaded after the list mounts; selection works without it.
 */

const MORPH_MS = 320;
const MORPH_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const MORPHING_CLASS = 'is-fill-morphing';

interface Block {
  top: number;
  bottom: number;
  left: number;
  width: number;
  opacity: number;
  /** Rows the block spans; a drawn pill counts as a block of several. */
  rows: number;
}

export interface PlaylistSelectionMorph {
  /**
   * Note the drawn blocks before a selection change. Changes made in the same
   * task morph together once the task ends.
   */
  capture(): void;
  /**
   * The list was rebuilt. If the selected blocks no longer sit where the morph
   * is heading (a remote change added, removed or moved rows), it ends at once
   * instead of drawing over the wrong rows.
   */
  afterRender(): void;
  /** End any morph at once and show the rows' own fills. */
  stop(): void;
  destroy(): void;
}

function sameSpan(from: Block, to: Block): boolean {
  return Math.abs(from.top - to.top) < 0.5 && Math.abs(from.bottom - to.bottom) < 0.5;
}

function samePlace(a: Block, b: Block): boolean {
  return sameSpan(a, b) && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5;
}

function overlaps(a: Block, b: Block): boolean {
  return a.top < b.bottom && b.top < a.bottom;
}

/** `rgb(…)`/`rgba(…)` as a solid color and its alpha. */
function splitAlpha(color: string): { solid: string; alpha: number } | null {
  const parts = color
    .match(/^rgba?\(([^)]+)\)$/)?.[1]
    ?.split(/[\s,/]+/)
    .filter(Boolean);
  if (!parts || parts.length < 3) return null;
  const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
  if (!Number.isFinite(alpha) || alpha <= 0) return null;
  return { solid: `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`, alpha };
}

export function createPlaylistSelectionMorph(list: HTMLElement): PlaylistSelectionMorph {
  let before: Block[] | null = null;
  let layer: HTMLElement | null = null;
  /** Where the running morph's pills end. */
  let targets: Block[] = [];
  let timer = 0;
  let destroyed = false;

  // Runs of consecutive selected rows, as the CSS joins them.
  function selectedRuns(): Block[] {
    const runs: Block[] = [];
    let run: Block | null = null;
    for (const child of list.children) {
      const entry = child as HTMLElement;
      if (
        !entry.classList.contains('playlist-entry') ||
        !entry.classList.contains('is-removal-selected') ||
        !entry.getClientRects().length
      ) {
        run = null;
        continue;
      }
      const rect = entry.getBoundingClientRect();
      if (run) {
        run.bottom = rect.bottom;
        run.rows += 1;
      } else {
        run = {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          width: rect.width,
          opacity: 1,
          rows: 1,
        };
        runs.push(run);
      }
    }
    return runs;
  }

  // Mid-morph, the drawn blocks are the pills as they are right now; ones
  // that have faded out are gone.
  function drawnPills(): Block[] {
    if (!layer) return [];
    return Array.from(layer.children, (child) => {
      const rect = child.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        opacity: Number.parseFloat(getComputedStyle(child).opacity) || 0,
        rows: 2,
      };
    }).filter((block) => block.opacity > 0.01);
  }

  function stop(): void {
    window.clearTimeout(timer);
    timer = 0;
    before = null;
    layer?.remove();
    layer = null;
    list.classList.remove(MORPHING_CLASS);
  }

  function run(): void {
    const from = before;
    before = null;
    if (destroyed || !from) return;
    const to = selectedRuns();

    const moves: { from: Block; to: Block }[] = [];
    for (const start of from) {
      for (const end of to) if (overlaps(start, end)) moves.push({ from: start, to: end });
    }
    const leaving = from.filter((start) => !to.some((end) => overlaps(start, end)));
    const arriving = to.filter((end) => !from.some((start) => overlaps(start, end)));
    const reshapes = moves.some((move) => !sameSpan(move.from, move.to));
    // A block of several rows appearing or clearing at once (Select all,
    // Deselect all, Cancel) fades as one shape: the rows' own fills would
    // turn into separate pills on the way. A lone row needs no morph; its
    // own fill fades. A morph in progress keeps drawing until it settles.
    const wholeBlock = [...leaving, ...arriving].some((block) => block.rows > 1);
    if (!reshapes && !wholeBlock && !layer) return;

    const probe = document.createElement('span');
    probe.hidden = true;
    probe.style.background = 'var(--control-active)';
    list.before(probe);
    const color = splitAlpha(getComputedStyle(probe).backgroundColor);
    probe.remove();
    if (!color) {
      stop();
      return;
    }

    layer?.remove();
    window.clearTimeout(timer);
    const next = document.createElement('div');
    next.className = 'playlist-fill-morph';
    next.setAttribute('aria-hidden', 'true');
    next.style.opacity = String(color.alpha);
    next.style.color = color.solid;
    // Behind the rows, which paint after it; pinned to its containing block's
    // origin so top/left count from wherever that is.
    list.before(next);
    next.style.left = '0px';
    next.style.top = '0px';
    const origin = next.getBoundingClientRect();

    const timing: KeyframeAnimationOptions = {
      duration: MORPH_MS,
      easing: MORPH_EASING,
      fill: 'forwards',
    };
    const frame = (block: Block, opacity: number): Keyframe => ({
      top: `${block.top - origin.top}px`,
      height: `${block.bottom - block.top}px`,
      opacity,
    });
    const animations: Animation[] = [];
    const pill = (block: Block, keyframes: Keyframe[]): void => {
      const element = document.createElement('div');
      element.style.left = `${block.left - origin.left}px`;
      element.style.width = `${block.width}px`;
      next.appendChild(element);
      animations.push(element.animate(keyframes, timing));
    };
    for (const move of moves) {
      pill(move.to, [frame(move.from, move.from.opacity), frame(move.to, 1)]);
    }
    for (const block of leaving) pill(block, [frame(block, block.opacity), frame(block, 0)]);
    for (const block of arriving) pill(block, [frame(block, 0), frame(block, 1)]);

    layer = next;
    targets = to;
    list.classList.add(MORPHING_CLASS);
    // The rows show again when the pills arrive, however the page clock runs.
    const finished = animations[0]?.finished;
    if (finished !== undefined) {
      void finished.then(
        () => {
          if (layer === next) stop();
        },
        () => {},
      );
    } else timer = window.setTimeout(stop, MORPH_MS);
  }

  return {
    capture() {
      if (destroyed || before) return;
      before = layer ? drawnPills() : selectedRuns();
      queueMicrotask(run);
    },
    afterRender() {
      // A change still waiting to morph measures the rebuilt rows itself.
      if (!layer || before) return;
      const now = selectedRuns();
      if (
        now.length !== targets.length ||
        now.some((block, index) => !samePlace(block, targets[index]!))
      ) {
        stop();
      }
    },
    stop,
    destroy() {
      destroyed = true;
      stop();
    },
  };
}

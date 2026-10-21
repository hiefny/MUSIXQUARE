/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaylistSelectionMorph } from '../playlist-selection-morph.ts';

const ROW = 56;
const GAP = 8;

interface MockAnimation {
  element: Element;
  keyframes: Keyframe[];
  finish: () => void;
}

describe('playlist selection morph', () => {
  let animations: MockAnimation[];
  let list: HTMLElement;
  let originalAnimate: typeof HTMLElement.prototype.animate | undefined;

  beforeEach(() => {
    document.body.innerHTML = `<div class="tab-body"><ul id="playlist-ui">${Array.from(
      { length: 4 },
      (_, index) => `<li class="playlist-entry" data-index="${index}"></li>`,
    ).join('')}</ul></div>`;
    list = document.getElementById('playlist-ui')!;
    animations = [];
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const index = Number((this as HTMLElement).dataset.index ?? NaN);
      const top = Number.isNaN(index) ? 0 : index * (ROW + GAP);
      const height = Number.isNaN(index) ? 0 : ROW;
      return { top, bottom: top + height, left: 16, width: 358, height } as DOMRect;
    });
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) =>
      element.tagName === 'SPAN'
        ? ({ backgroundColor: 'rgba(59, 130, 246, 0.13)' } as CSSStyleDeclaration)
        : computed(element, pseudo),
    );
    originalAnimate = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (this: Element, keyframes: Keyframe[]) {
      let finish = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      animations.push({ element: this, keyframes, finish });
      return { finished, cancel: vi.fn() } as unknown as Animation;
    } as unknown as typeof HTMLElement.prototype.animate;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAnimate) HTMLElement.prototype.animate = originalAnimate;
    else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  });

  function select(...indices: number[]): void {
    list.querySelectorAll('.playlist-entry').forEach((entry, index) => {
      entry.classList.toggle('is-removal-selected', indices.includes(index));
    });
  }

  function spans(): { from: [string, string]; to: [string, string] }[] {
    return animations.map(({ keyframes }) => ({
      from: [String(keyframes[0]!.top), String(keyframes[0]!.height)],
      to: [String(keyframes[1]!.top), String(keyframes[1]!.height)],
    }));
  }

  const top = (index: number) => `${index * (ROW + GAP)}px`;
  const height = (rows: number) => `${rows * ROW + (rows - 1) * GAP}px`;

  it('bridges two blocks as two pills stretching into one, keeping their radius', async () => {
    const morph = createPlaylistSelectionMorph(list);
    select(0, 2);
    morph.capture();
    select(0, 1, 2);
    await Promise.resolve();

    const layer = document.querySelector<HTMLElement>('.playlist-fill-morph')!;
    expect(layer.nextElementSibling).toBe(list);
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    // Solid pills in a layer carrying the fill's alpha: overlaps stay one shape.
    expect(layer.style.opacity).toBe('0.13');
    expect(layer.style.color).toBe('rgb(59, 130, 246)');
    expect(list.classList.contains('is-fill-morphing')).toBe(true);
    expect(spans()).toEqual([
      { from: [top(0), height(1)], to: [top(0), height(3)] },
      { from: [top(2), height(1)], to: [top(0), height(3)] },
    ]);

    animations[0]!.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('.playlist-fill-morph')).toBeNull();
    expect(list.classList.contains('is-fill-morphing')).toBe(false);
  });

  it('pinches a block apart when a middle row leaves it', async () => {
    const morph = createPlaylistSelectionMorph(list);
    select(0, 1, 2);
    morph.capture();
    select(0, 2);
    await Promise.resolve();
    expect(spans()).toEqual([
      { from: [top(0), height(3)], to: [top(0), height(1)] },
      { from: [top(0), height(3)], to: [top(2), height(1)] },
    ]);
  });

  it('stretches a block onto a joining row and leaves a lone row to its own fade', async () => {
    const morph = createPlaylistSelectionMorph(list);
    select(1);
    morph.capture();
    select(1, 2);
    await Promise.resolve();
    expect(spans()).toEqual([{ from: [top(1), height(1)], to: [top(1), height(2)] }]);
    morph.stop();
    expect(document.querySelector('.playlist-fill-morph')).toBeNull();
    expect(list.classList.contains('is-fill-morphing')).toBe(false);

    animations = [];
    morph.capture();
    select(1, 2, 0);
    // Changes in the same task morph together.
    morph.capture();
    select(0, 1, 2, 3);
    await Promise.resolve();
    expect(spans()).toEqual([{ from: [top(1), height(2)], to: [top(0), height(4)] }]);
    morph.stop();

    animations = [];
    select();
    morph.capture();
    select(3);
    await Promise.resolve();
    expect(animations).toHaveLength(0);
    expect(document.querySelector('.playlist-fill-morph')).toBeNull();
  });

  it('ends a morph when a rebuilt list moved the blocks it was heading for', async () => {
    const morph = createPlaylistSelectionMorph(list);
    select(0, 2);
    morph.capture();
    select(0, 1, 2);
    await Promise.resolve();
    const rebuild = (shift: number) => {
      list.innerHTML = Array.from(
        { length: 4 },
        (_, index) =>
          `<li class="playlist-entry${index < 3 ? ' is-removal-selected' : ''}" data-index="${index + shift}"></li>`,
      ).join('');
    };

    // The same rows rendered again: the morph carries on.
    rebuild(0);
    morph.afterRender();
    expect(document.querySelector('.playlist-fill-morph')).not.toBeNull();
    expect(list.classList.contains('is-fill-morphing')).toBe(true);

    // A remote change put a row above the selection: stop instead of drawing
    // the pills over the wrong rows.
    rebuild(1);
    morph.afterRender();
    expect(document.querySelector('.playlist-fill-morph')).toBeNull();
    expect(list.classList.contains('is-fill-morphing')).toBe(false);
  });

  it('clears and draws a block of several rows as one shape', async () => {
    const morph = createPlaylistSelectionMorph(list);
    // Deselect all: the block fades where it is instead of falling into pills.
    select(0, 1, 2);
    morph.capture();
    select();
    await Promise.resolve();
    expect(animations.map(({ keyframes }) => keyframes.map((frame) => frame.opacity))).toEqual([
      [1, 0],
    ]);
    expect(spans()).toEqual([{ from: [top(0), height(3)], to: [top(0), height(3)] }]);
    expect(list.classList.contains('is-fill-morphing')).toBe(true);
    morph.stop();

    // Select all from nothing: the block fades in whole.
    animations = [];
    morph.capture();
    select(0, 1, 2, 3);
    await Promise.resolve();
    expect(animations.map(({ keyframes }) => keyframes.map((frame) => frame.opacity))).toEqual([
      [0, 1],
    ]);
    expect(spans()).toEqual([{ from: [top(0), height(4)], to: [top(0), height(4)] }]);
    morph.stop();

    // A lone row is already a pill; its own fill fades.
    animations = [];
    select(2);
    morph.capture();
    select();
    await Promise.resolve();
    expect(animations).toHaveLength(0);
    expect(document.querySelector('.playlist-fill-morph')).toBeNull();
  });

  it('keeps drawing a morph in progress through a change that reshapes nothing', async () => {
    const morph = createPlaylistSelectionMorph(list);
    select(0);
    morph.capture();
    select(0, 1);
    await Promise.resolve();
    const first = document.querySelector('.playlist-fill-morph');
    morph.capture();
    select(0, 1, 3);
    await Promise.resolve();
    const second = document.querySelector('.playlist-fill-morph');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(document.querySelectorAll('.playlist-fill-morph')).toHaveLength(1);
    expect(list.classList.contains('is-fill-morphing')).toBe(true);
    morph.destroy();
    expect(document.querySelector('.playlist-fill-morph')).toBeNull();
  });
});

/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { installPlaylistSelectionGestures } from '../playlist-selection-gestures.ts';

const ROW_TOP = 100;
const ROW_HEIGHT = 56;
const ROW_STEP = 64;
const IDS = ['r0', 'r1', 'r2', 'r3', 'r4'];

interface TestTouch {
  identifier: number;
  clientX: number;
  clientY: number;
  target: EventTarget;
}

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 390,
    width: 390,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function rowCenter(index: number): number {
  return ROW_TOP + index * ROW_STEP + ROW_HEIGHT / 2;
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  clientY: number,
  options: { pointerId?: number; pointerType?: string; isPrimary?: boolean } = {},
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: 360,
    clientY,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    isPrimary: { value: options.isPrimary ?? true },
    pointerType: { value: options.pointerType ?? 'mouse' },
  });
  target.dispatchEvent(event);
  return event;
}

function touchList(touches: TestTouch[]): TouchList {
  const list = [...touches] as unknown as TouchList & { item(index: number): Touch | null };
  Object.defineProperty(list, 'item', {
    value: (index: number) => (list[index] as Touch | undefined) ?? null,
  });
  return list;
}

function dispatchTouch(
  target: EventTarget,
  type: string,
  touches: TestTouch[],
  changedTouches: TestTouch[] = touches,
  cancelable = true,
): Event {
  const event = new Event(type, { bubbles: true, cancelable });
  Object.defineProperties(event, {
    touches: { value: touchList(touches) },
    changedTouches: { value: touchList(changedTouches) },
  });
  target.dispatchEvent(event);
  return event;
}

describe('playlist drag selection gestures', () => {
  let list: HTMLElement;
  let scroller: HTMLElement;
  let selected: Set<string>;
  let canSelect: boolean;
  let toggle: Mock<(queueItemId: string) => void>;
  let uninstall: (() => void) | null = null;
  let viewportBottom = 1000;

  function button(index: number): HTMLElement {
    return list.querySelector<HTMLElement>(
      `.btn-playlist-select[data-queue-item-id="${IDS[index]}"]`,
    )!;
  }

  function selection(): string[] {
    return IDS.filter((id) => selected.has(id));
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    viewportBottom = 1000;
    document.body.innerHTML = `<div class="tab-body"><ul id="playlist-ui">${IDS.map(
      (id) => `<li class="playlist-entry" data-queue-item-id="${id}">
        <div class="track-item"><button type="button" class="track-name" data-action="play"></button>
        <button type="button" class="btn-playlist-select" data-action="select" data-queue-item-id="${id}"></button></div>
      </li>`,
    ).join('')}</ul></div>`;
    list = document.getElementById('playlist-ui')!;
    scroller = document.querySelector<HTMLElement>('.tab-body')!;
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, get: () => viewportBottom },
    });
    scroller.getBoundingClientRect = () => rect(0, viewportBottom);
    list.querySelectorAll<HTMLElement>('.playlist-entry').forEach((entry, index) => {
      entry.getBoundingClientRect = () => rect(ROW_TOP + index * ROW_STEP - scrollTop, ROW_HEIGHT);
    });
    selected = new Set();
    canSelect = true;
    toggle = vi.fn((id: string): void => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    });
    uninstall = installPlaylistSelectionGestures({
      list,
      canSelect: () => canSelect,
      isSelected: (id) => selected.has(id),
      toggle,
    });
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    vi.useRealTimers();
  });

  it('selects every row a check-column drag passes and gives back rows it leaves', () => {
    dispatchPointer(button(0), 'pointerdown', rowCenter(0));
    dispatchPointer(document, 'pointermove', rowCenter(0) + 4);
    expect(toggle).not.toHaveBeenCalled();

    dispatchPointer(document, 'pointermove', rowCenter(2));
    expect(selection()).toEqual(['r0', 'r1', 'r2']);
    // A point in the 8px gap belongs to the row below it.
    dispatchPointer(document, 'pointermove', ROW_TOP + 3 * ROW_STEP - 4);
    expect(selection()).toEqual(['r0', 'r1', 'r2', 'r3']);
    dispatchPointer(document, 'pointermove', rowCenter(1));
    expect(selection()).toEqual(['r0', 'r1']);
    dispatchPointer(document, 'pointerup', rowCenter(1));

    // The click that ends the drag neither toggles nor plays a row.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    const listClick = vi.fn();
    list.addEventListener('click', listClick);
    button(1).dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(listClick).not.toHaveBeenCalled();
  });

  it('deselects from a selected starting row and keeps the rest of the selection', () => {
    selected = new Set(['r0', 'r1', 'r2', 'r4']);
    dispatchPointer(button(2), 'pointerdown', rowCenter(2), { pointerType: 'touch' });
    dispatchPointer(document, 'pointermove', rowCenter(1), { pointerType: 'touch' });
    expect(selection()).toEqual(['r0', 'r4']);
    dispatchPointer(document, 'pointermove', rowCenter(3), { pointerType: 'touch' });
    expect(selection()).toEqual(['r0', 'r1', 'r4']);
    dispatchPointer(document, 'pointercancel', rowCenter(3), { pointerType: 'touch' });
    dispatchPointer(document, 'pointermove', rowCenter(0), { pointerType: 'touch' });
    expect(selection()).toEqual(['r0', 'r1', 'r4']);
  });

  it('adds before it removes, so a drag never empties and ends edit mode on the way', () => {
    selected = new Set(['r3']);
    dispatchPointer(button(0), 'pointerdown', rowCenter(0));
    dispatchPointer(document, 'pointermove', rowCenter(1));
    const calls = toggle.mock.calls.map(([id]) => id);
    expect(calls).toEqual(['r0', 'r1']);
    expect(selection()).toEqual(['r0', 'r1', 'r3']);
  });

  it('leaves a short press to the check circle and ignores other starts', () => {
    dispatchPointer(button(1), 'pointerdown', rowCenter(1));
    dispatchPointer(document, 'pointerup', rowCenter(1));
    expect(toggle).not.toHaveBeenCalled();

    dispatchPointer(list.querySelector('.track-name')!, 'pointerdown', rowCenter(0));
    dispatchPointer(document, 'pointermove', rowCenter(3));
    expect(toggle).not.toHaveBeenCalled();
    dispatchPointer(document, 'pointerup', rowCenter(3));

    canSelect = false;
    dispatchPointer(button(0), 'pointerdown', rowCenter(0));
    dispatchPointer(document, 'pointermove', rowCenter(3));
    expect(toggle).not.toHaveBeenCalled();
  });

  it('auto-scrolls near the visible bottom edge and keeps extending the range', () => {
    viewportBottom = 300;
    dispatchPointer(button(0), 'pointerdown', rowCenter(0));
    dispatchPointer(document, 'pointermove', rowCenter(1));
    expect(selection()).toEqual(['r0', 'r1']);
    // Inside the bottom edge zone (72px at most for a 300px pane).
    dispatchPointer(document, 'pointermove', 295);
    const before = scroller.scrollTop;
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(scroller.scrollTop).toBeGreaterThan(before);
    for (let frame = 0; frame < 30; frame += 1) vi.advanceTimersToNextFrame();
    expect(selection()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    dispatchPointer(document, 'pointerup', 295);
    const settled = scroller.scrollTop;
    vi.advanceTimersToNextFrame();
    expect(scroller.scrollTop).toBe(settled);
  });

  it('selects the range under a two-finger pan and blocks native scrolling while it runs', () => {
    const fingers = (y: number): TestTouch[] => [
      { identifier: 1, clientX: 100, clientY: y - 6, target: button(1) },
      { identifier: 2, clientX: 160, clientY: y + 6, target: button(1) },
    ];
    dispatchTouch(list, 'touchstart', fingers(rowCenter(1)).slice(0, 1));
    dispatchTouch(list, 'touchstart', fingers(rowCenter(1)));
    const firstMove = dispatchTouch(list, 'touchmove', fingers(rowCenter(1) + 2));
    expect(firstMove.defaultPrevented).toBe(true);
    expect(toggle).not.toHaveBeenCalled();

    dispatchTouch(list, 'touchmove', fingers(rowCenter(3)));
    expect(selection()).toEqual(['r1', 'r2', 'r3']);
    dispatchTouch(list, 'touchmove', fingers(rowCenter(0)));
    expect(selection()).toEqual(['r0', 'r1']);
    dispatchTouch(
      list,
      'touchend',
      fingers(rowCenter(0)).slice(1),
      fingers(rowCenter(0)).slice(0, 1),
    );
    dispatchTouch(list, 'touchmove', fingers(rowCenter(4)).slice(1));
    expect(selection()).toEqual(['r0', 'r1']);
  });

  it('sets a two-finger range like the starting row: select from unselected, deselect from selected', () => {
    const fingers = (y: number): TestTouch[] => [
      { identifier: 1, clientX: 100, clientY: y - 6, target: button(1) },
      { identifier: 2, clientX: 160, clientY: y + 6, target: button(1) },
    ];
    const pan = (from: number, to: number) => {
      dispatchTouch(list, 'touchstart', fingers(rowCenter(from)));
      dispatchTouch(list, 'touchmove', fingers(rowCenter(from) + 12));
      dispatchTouch(list, 'touchmove', fingers(rowCenter(to)));
      dispatchTouch(list, 'touchend', [], fingers(rowCenter(to)));
    };

    // Rows 2, 3 and 5 selected; a pan from the unselected row 1 to the end
    // selects everything it passes.
    selected = new Set(['r1', 'r2', 'r4']);
    pan(0, 4);
    expect(selection()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    // From the selected row 2 down to the end it deselects: only row 1 stays.
    pan(1, 4);
    expect(selection()).toEqual(['r0']);

    // Rows 2, 4 and 5 selected; from row 2 the pan clears them and leaves the
    // unselected row 3 as it was.
    selected = new Set(['r1', 'r3', 'r4']);
    toggle.mockClear();
    pan(1, 4);
    expect(selection()).toEqual([]);
    expect(toggle.mock.calls.map(([id]) => id).sort()).toEqual(['r1', 'r3', 'r4']);
  });

  it('lets a pinch and an already scrolling page keep their native behavior', () => {
    const pair = (y: number, spread: number): TestTouch[] => [
      { identifier: 1, clientX: 100, clientY: y - spread, target: button(2) },
      { identifier: 2, clientX: 100, clientY: y + spread, target: button(2) },
    ];
    dispatchTouch(list, 'touchstart', pair(rowCenter(2), 10));
    dispatchTouch(list, 'touchmove', pair(rowCenter(2), 80));
    dispatchTouch(list, 'touchmove', pair(rowCenter(4), 80));
    expect(toggle).not.toHaveBeenCalled();
    dispatchTouch(list, 'touchend', [], pair(rowCenter(4), 80));

    dispatchTouch(list, 'touchstart', pair(rowCenter(2), 10));
    const scrolling = dispatchTouch(list, 'touchmove', pair(rowCenter(4), 10), undefined, false);
    expect(scrolling.defaultPrevented).toBe(false);
    dispatchTouch(list, 'touchmove', pair(rowCenter(4), 10));
    expect(toggle).not.toHaveBeenCalled();
  });

  it('stops listening once uninstalled', () => {
    uninstall?.();
    uninstall = null;
    dispatchPointer(button(0), 'pointerdown', rowCenter(0));
    dispatchPointer(document, 'pointermove', rowCenter(3));
    expect(toggle).not.toHaveBeenCalled();
  });
});

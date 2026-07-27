/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaylistReorderController } from '../playlist-reorder.ts';

const PLAYLIST_LONG_PRESS_MS = 700;
const PLAYLIST_REORDER_HINT_MS = 2000;

const IDS = {
  a: '00000000-0000-4000-8000-000000000001',
  b: '00000000-0000-4000-8000-000000000002',
  c: '00000000-0000-4000-8000-000000000003',
} as const;

function domRect(top: number, height = 48): DOMRect {
  return domRectAt(0, top, 300, height);
}

function domRectAt(left: number, top: number, width = 300, height = 48): DOMRect {
  return {
    x: left,
    y: top,
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setupList(): { list: HTMLElement; scroller: HTMLElement; rows: HTMLElement[] } {
  document.body.innerHTML = `
    <div class="tab-body">
      <ul id="playlist-ui">
        ${Object.values(IDS)
          .map(
            (id, index) => `<li class="playlist-entry" data-queue-item-id="${id}">
              <div class="track-item" data-queue-item-id="${id}">
                <button class="playlist-reorder-handle" data-queue-item-id="${id}" aria-grabbed="false"><span class="track-idx">${index + 1}</span></button>
                <button class="track-name" data-action="play" data-queue-item-id="${id}"><span class="track-name-text">${id.slice(-1)}</span></button>
              </div>
            </li>`,
          )
          .join('')}
      </ul>
    </div>`;
  const list = document.getElementById('playlist-ui')!;
  const scroller = document.querySelector<HTMLElement>('.tab-body')!;
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.track-item'));
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => domRect(index * 56);
  });
  scroller.getBoundingClientRect = () => domRect(0, 200);
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 800 },
  });
  return { list, scroller, rows };
}

function dispatchPointer(
  target: Element,
  type: string,
  clientY: number,
  pointerId = 1,
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 20,
    clientY,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    isPrimary: { value: true },
    pointerType: { value: 'mouse' },
  });
  target.dispatchEvent(event);
  return event;
}

interface TestTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

function touchList(touches: TestTouch[]): TouchList {
  const list = [...touches] as unknown as TouchList & { item(index: number): Touch | null };
  Object.defineProperty(list, 'item', {
    value: (index: number) => (list[index] as Touch | undefined) ?? null,
  });
  return list;
}

function dispatchTouch(
  target: Element,
  type: string,
  touches: TestTouch[],
  changedTouches: TestTouch[] = touches,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: touchList(touches) },
    changedTouches: { value: touchList(changedTouches) },
  });
  target.dispatchEvent(event);
  return event;
}

describe('playlist reorder interaction controller', () => {
  const controllers: Array<{ destroy(): void }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id));
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.destroy());
    document.body.style.removeProperty('--desktop-ui-scale');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function create(canReorder = true, initiallyVisible = true) {
    const commit = vi.fn();
    const interactionEnd = vi.fn();
    let visible = initiallyVisible;
    const { list, scroller, rows } = setupList();
    const controller = createPlaylistReorderController({
      list,
      canReorder: () => canReorder,
      isPlaylistVisible: () => visible,
      onCommit: commit,
      onInteractionEnd: interactionEnd,
      getAnnouncement: (id, position, total) => `${id}:${position}/${total}`,
      getHandleLabel: (id, position) => `${id}:position-${position}`,
    });
    controllers.push(controller);
    return {
      controller,
      commit,
      interactionEnd,
      list,
      scroller,
      rows,
      setVisible(next: boolean) {
        visible = next;
      },
    };
  }

  it('commits a direct handle drag once using source and before IDs', () => {
    const { commit, controller, list } = create();
    const handle = list.querySelector<HTMLElement>('.playlist-reorder-handle')!;

    dispatchPointer(handle, 'pointerdown', 20);
    expect(document.querySelector('.playlist-reorder-ghost')).not.toBeNull();
    dispatchPointer(handle, 'pointermove', 190);
    expect(
      Array.from(list.querySelectorAll<HTMLElement>('.playlist-entry')).map(
        (entry) => entry.dataset.queueItemId,
      ),
    ).toEqual([IDS.b, IDS.c, IDS.a]);
    expect(
      Array.from(list.querySelectorAll<HTMLElement>('.playlist-entry')).map((entry) => ({
        index: entry.dataset.playlistIndex,
        number: entry.querySelector('.track-idx')?.textContent,
        position: entry.querySelector('.playlist-reorder-handle')?.getAttribute('aria-posinset'),
      })),
    ).toEqual([
      { index: '0', number: '1', position: '1' },
      { index: '1', number: '2', position: '2' },
      { index: '2', number: '3', position: '3' },
    ]);
    dispatchPointer(handle, 'pointerup', 190);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(IDS.a, null);
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();
    expect(document.querySelector('.playlist-reorder-settle')).not.toBeNull();
    expect(controller.isSettling).toBe(true);
    vi.advanceTimersByTime(600);
    expect(document.querySelector('.playlist-reorder-settle')).toBeNull();
    expect(controller.isSettling).toBe(false);
  });

  it('settles from the exact release box with transform-only motion and a source handoff', () => {
    const { commit, controller, interactionEnd, list, rows } = create();
    const handle = list.querySelector<HTMLElement>('.playlist-reorder-handle')!;
    const sourceEntry = handle.closest<HTMLElement>('.playlist-entry')!;

    dispatchPointer(handle, 'pointerdown', 20);
    dispatchPointer(handle, 'pointermove', 190);
    const ghost = document.querySelector<HTMLElement>('.playlist-reorder-ghost')!;
    const releaseRect = domRectAt(37.25, 143.5, 304.5, 48.75);
    ghost.getBoundingClientRect = vi.fn(() => releaseRect);
    rows[0].getBoundingClientRect = () => domRectAt(12.5, 112.25, 300, 48);

    dispatchPointer(handle, 'pointerup', 190);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(ghost.classList.contains('playlist-reorder-ghost')).toBe(false);
    expect(ghost.classList.contains('playlist-reorder-settle')).toBe(true);
    expect(ghost.style.left).toBe('37.25px');
    expect(ghost.style.top).toBe('143.5px');
    expect(ghost.style.transformOrigin).toBe('0 0');
    expect(ghost.style.transform).toBe('translate3d(0px, 0px, 0px) scale(1.015)');
    expect(sourceEntry.classList.contains('is-reorder-source')).toBe(true);
    expect(sourceEntry.classList.contains('is-reorder-settling-source')).toBe(true);
    expect(sourceEntry.classList.contains('is-reorder-handoff')).toBe(false);
    expect(handle.getAttribute('aria-grabbed')).toBe('false');
    expect(interactionEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);
    expect(ghost.style.left).toBe('37.25px');
    expect(ghost.style.top).toBe('143.5px');
    expect(ghost.style.transform).toBe('translate3d(0px, 0px, 0px) scale(1.015)');
    expect(sourceEntry.classList.contains('is-reorder-handoff')).toBe(false);

    vi.advanceTimersByTime(16);
    expect(ghost.style.left).toBe('37.25px');
    expect(ghost.style.top).toBe('143.5px');
    expect(ghost.style.transform).toBe('translate3d(-24.75px, -31.25px, 0px) scale(1)');
    expect(ghost.style.opacity).toBe('0');
    expect(sourceEntry.classList.contains('is-reorder-handoff')).toBe(true);
    expect(controller.isSettling).toBe(true);

    vi.advanceTimersByTime(301);
    expect(ghost.isConnected).toBe(true);
    expect(sourceEntry.classList.contains('is-reorder-settling-source')).toBe(true);
    expect(interactionEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(ghost.isConnected).toBe(false);
    expect(sourceEntry.classList.contains('is-reorder-source')).toBe(false);
    expect(sourceEntry.classList.contains('is-reorder-settling-source')).toBe(false);
    expect(sourceEntry.classList.contains('is-reorder-handoff')).toBe(false);
    expect(sourceEntry.isConnected).toBe(true);
    expect(controller.isSettling).toBe(true);
    expect(interactionEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(171);
    expect(sourceEntry.isConnected).toBe(true);
    expect(controller.isSettling).toBe(true);
    expect(interactionEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(controller.isSettling).toBe(false);
    expect(interactionEnd).toHaveBeenCalledOnce();
    expect(interactionEnd).toHaveBeenCalledWith(true);
  });

  it('keeps fixed ghosts, FLIP motion, and drop settling in body-local pixels at 1.5x', () => {
    document.body.style.setProperty('--desktop-ui-scale', '1.5');
    const { commit, list } = create();
    const entries = Array.from(list.querySelectorAll<HTMLElement>('.playlist-entry'));
    const handle = entries[0].querySelector<HTMLElement>('.playlist-reorder-handle')!;
    vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue(domRectAt(30, 45, 1200, 900));

    const renderedTop = (entry: HTMLElement): number =>
      Array.from(list.children).indexOf(entry) * 84 + 150;
    entries.forEach((entry) => {
      entry.getBoundingClientRect = () => domRectAt(150, renderedTop(entry), 450, 72);
      entry.querySelector<HTMLElement>('.track-item')!.getBoundingClientRect = () =>
        domRectAt(150, renderedTop(entry), 450, 72);
    });
    list.getBoundingClientRect = () => domRectAt(150, 150, 450, 400);

    dispatchPointer(handle, 'pointerdown', 180);
    const ghost = document.querySelector<HTMLElement>('.playlist-reorder-ghost')!;
    expect(ghost.style.left).toBe('80px');
    expect(ghost.style.top).toBe('70px');
    expect(ghost.style.width).toBe('300px');

    dispatchPointer(handle, 'pointermove', 390);
    expect(ghost.style.transform).toBe('translate3d(0, 140px, 0) scale(1.015)');
    expect(entries[1].style.transform).toBe('translate3d(0px, 56px, 0)');
    expect(entries[2].style.transform).toBe('translate3d(0px, 56px, 0)');
    expect(entries[0].style.transform).toBe('translate3d(0px, -112px, 0)');

    ghost.getBoundingClientRect = () => domRectAt(180, 360, 450, 72);
    dispatchPointer(handle, 'pointerup', 390);
    expect(commit).toHaveBeenCalledWith(IDS.a, null);
    expect(ghost.style.left).toBe('100px');
    expect(ghost.style.top).toBe('210px');

    vi.advanceTimersByTime(32);
    expect(ghost.style.transform).toBe('translate3d(-20px, -28px, 0px) scale(1)');
  });

  it('keeps offset-based reorder thresholds in viewport coordinates at 1.5x', () => {
    document.body.style.setProperty('--desktop-ui-scale', '1.5');
    const { list } = create();
    const entries = Array.from(list.querySelectorAll<HTMLElement>('.playlist-entry'));
    const rows = entries.map((entry) => entry.querySelector<HTMLElement>('.track-item')!);
    const handle = entries[0].querySelector<HTMLElement>('.playlist-reorder-handle')!;
    list.getBoundingClientRect = () => domRectAt(0, 150, 450, 400);

    entries.forEach((entry, index) => {
      Object.defineProperties(entry, {
        offsetTop: { configurable: true, value: index * 56 },
        offsetHeight: { configurable: true, value: 48 },
      });
      Object.defineProperty(rows[index], 'offsetHeight', { configurable: true, value: 48 });
      rows[index].getBoundingClientRect = () => domRectAt(0, 150 + index * 84, 450, 72);
    });

    dispatchPointer(handle, 'pointerdown', 180);
    // B's rendered midpoint is 270 and C's is 354. A viewport Y of 300 must
    // therefore insert before C; mixing unscaled offsets would append A.
    dispatchPointer(handle, 'pointermove', 300);
    expect(
      Array.from(list.querySelectorAll<HTMLElement>('.playlist-entry')).map(
        (entry) => entry.dataset.queueItemId,
      ),
    ).toEqual([IDS.b, IDS.a, IDS.c]);
  });

  it('finishes reduced-motion settling after commit without leaking visual state', () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    const order: string[] = [];
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    try {
      const { commit, controller, interactionEnd, list } = create();
      commit.mockImplementation(() => order.push('commit'));
      interactionEnd.mockImplementation(() => order.push('end'));
      const handle = list.querySelector<HTMLElement>('.playlist-reorder-handle')!;
      const sourceEntry = handle.closest<HTMLElement>('.playlist-entry')!;

      dispatchPointer(handle, 'pointerdown', 20);
      dispatchPointer(handle, 'pointermove', 190);
      dispatchPointer(handle, 'pointerup', 190);

      expect(order).toEqual(['commit']);
      expect(controller.isSettling).toBe(true);
      expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();
      expect(document.querySelector('.playlist-reorder-settle')).toBeNull();
      expect(sourceEntry.classList.contains('is-reorder-source')).toBe(false);
      expect(sourceEntry.classList.contains('is-reorder-settling-source')).toBe(false);
      expect(sourceEntry.classList.contains('is-reorder-handoff')).toBe(false);

      vi.advanceTimersByTime(0);
      expect(order).toEqual(['commit', 'end']);
      expect(controller.isSettling).toBe(false);

      vi.advanceTimersByTime(1_000);
      expect(order).toEqual(['commit', 'end']);
      expect(document.querySelector('.playlist-reorder-settle')).toBeNull();
    } finally {
      if (originalMatchMedia) {
        Object.defineProperty(window, 'matchMedia', originalMatchMedia);
      } else {
        Reflect.deleteProperty(window, 'matchMedia');
      }
    }
  });

  it('cancels pointer drag without committing', () => {
    const { commit, list } = create();
    const handle = list.querySelector<HTMLElement>('.playlist-reorder-handle')!;

    dispatchPointer(handle, 'pointerdown', 20);
    dispatchPointer(handle, 'pointermove', 190);
    dispatchPointer(handle, 'pointercancel', 190);

    expect(commit).not.toHaveBeenCalled();
    expect(document.body.classList.contains('playlist-reorder-active')).toBe(false);
    expect(
      Array.from(list.querySelectorAll<HTMLElement>('.playlist-entry')).map(
        (entry) => entry.dataset.queueItemId,
      ),
    ).toEqual([IDS.a, IDS.b, IDS.c]);
  });

  it('cancels an active drag on Escape without changing order', () => {
    const { commit, list } = create();
    const handle = list.querySelector<HTMLElement>('.playlist-reorder-handle')!;
    dispatchPointer(handle, 'pointerdown', 20);
    dispatchPointer(handle, 'pointermove', 190);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(commit).not.toHaveBeenCalled();
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();
  });

  it('supports keyboard pickup, target movement, drop, and live position feedback', () => {
    const { commit, list } = create();
    const handles = list.querySelectorAll<HTMLElement>('.playlist-reorder-handle');
    const middle = handles[1];
    middle.focus();

    middle.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    middle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(middle);
    middle.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );

    expect(commit).toHaveBeenCalledWith(IDS.b, IDS.a);
    vi.advanceTimersByTime(16);
    expect(document.querySelector('.playlist-reorder-live')?.textContent).toContain('1/3');
  });

  it('activates row-body reorder only after a stationary 700 ms touch', () => {
    const { commit, list, rows } = create();
    const rowClick = vi.fn();
    list.addEventListener('click', rowClick);
    const touch = { identifier: 7, clientX: 140, clientY: 20 };
    dispatchTouch(rows[0], 'touchstart', [touch]);

    vi.advanceTimersByTime(PLAYLIST_LONG_PRESS_MS - 1);
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.querySelector('.playlist-reorder-ghost')).not.toBeNull();

    const moved = { ...touch, clientY: 190 };
    const moveEvent = dispatchTouch(rows[0], 'touchmove', [moved]);
    expect(moveEvent.defaultPrevented).toBe(true);
    dispatchTouch(rows[0], 'touchend', [], [moved]);
    expect(commit).toHaveBeenCalledWith(IDS.a, null);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    rows[0].dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('lets the title play button double as the mobile long-press surface', () => {
    const { list } = create();
    const title = list.querySelector<HTMLElement>('.track-name')!;
    const titleText = title.querySelector<HTMLElement>('.track-name-text')!;
    const rowClick = vi.fn();
    list.addEventListener('click', rowClick);

    const tap = { identifier: 28, clientX: 140, clientY: 20 };
    dispatchTouch(titleText, 'touchstart', [tap]);
    dispatchTouch(titleText, 'touchend', [], [tap]);
    const ordinaryClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    titleText.dispatchEvent(ordinaryClick);
    expect(ordinaryClick.defaultPrevented).toBe(false);
    expect(rowClick).toHaveBeenCalledTimes(1);

    const hold = { identifier: 29, clientX: 140, clientY: 20 };
    dispatchTouch(titleText, 'touchstart', [hold]);
    vi.advanceTimersByTime(PLAYLIST_LONG_PRESS_MS);
    expect(document.querySelector('.playlist-reorder-ghost')).not.toBeNull();
    dispatchTouch(titleText, 'touchend', [], [hold]);

    const suppressedClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    titleText.dispatchEvent(suppressedClick);
    expect(suppressedClick.defaultPrevented).toBe(true);
    expect(rowClick).toHaveBeenCalledTimes(1);
  });

  it('cancels an armed probe when another touch starts anywhere and waits for all fingers to lift', () => {
    const { list, rows } = create();
    const rowClick = vi.fn();
    list.addEventListener('click', rowClick);
    const first = { identifier: 20, clientX: 140, clientY: 20 };
    const second = { identifier: 21, clientX: 20, clientY: 300 };
    dispatchTouch(rows[0], 'touchstart', [first]);
    vi.advanceTimersByTime(300);

    dispatchTouch(document.body, 'touchstart', [first, second], [second]);
    vi.advanceTimersByTime(PLAYLIST_LONG_PRESS_MS + 500);
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();

    dispatchTouch(document.body, 'touchend', [first], [second]);
    vi.advanceTimersByTime(PLAYLIST_LONG_PRESS_MS + 500);
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();

    dispatchTouch(rows[0], 'touchend', [], [first]);
    const syntheticClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    rows[0].dispatchEvent(syntheticClick);
    expect(syntheticClick.defaultPrevented).toBe(true);
    expect(rowClick).not.toHaveBeenCalled();

    const fresh = { identifier: 22, clientX: 140, clientY: 20 };
    dispatchTouch(rows[0], 'touchstart', [fresh]);
    vi.advanceTimersByTime(PLAYLIST_LONG_PRESS_MS);
    expect(document.querySelector('.playlist-reorder-ghost')).not.toBeNull();
    dispatchTouch(rows[0], 'touchcancel', [], [fresh]);
  });

  it('cancels an active touch drag immediately when another touch starts outside the list', () => {
    const { commit, rows } = create();
    const first = { identifier: 23, clientX: 140, clientY: 20 };
    const second = { identifier: 24, clientX: 20, clientY: 300 };
    dispatchTouch(rows[0], 'touchstart', [first]);
    vi.advanceTimersByTime(PLAYLIST_LONG_PRESS_MS);
    expect(document.querySelector('.playlist-reorder-ghost')).not.toBeNull();

    dispatchTouch(document.body, 'touchstart', [first, second], [second]);
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();
    expect(document.body.classList.contains('playlist-reorder-active')).toBe(false);
    expect(commit).not.toHaveBeenCalled();

    dispatchTouch(document.body, 'touchend', [first], [second]);
    dispatchTouch(rows[0], 'touchend', [], [first]);
  });

  it('permanently disqualifies long-press after native scroll and hints only the row under finger', () => {
    const { rows, scroller } = create();
    const touch = { identifier: 9, clientX: 140, clientY: 20 };
    dispatchTouch(rows[0], 'touchstart', [touch]);
    const moved = { ...touch, clientY: 90 };
    dispatchTouch(rows[0], 'touchmove', [moved]);

    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn((_x: number, y: number) => (y > 100 ? rows[2] : rows[1])),
    });
    scroller.scrollTop = 20;
    scroller.dispatchEvent(new Event('scroll'));
    const latestMove = { ...touch, clientY: 130 };
    dispatchTouch(rows[0], 'touchmove', [latestMove]);
    vi.advanceTimersByTime(16);

    expect(rows[2].closest('.playlist-entry')?.classList.contains('is-touch-scroll-hint')).toBe(
      true,
    );
    vi.advanceTimersByTime(PLAYLIST_LONG_PRESS_MS + 200);
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();

    dispatchTouch(rows[0], 'touchend', [], [latestMove]);
    expect(document.querySelector('.is-touch-scroll-hint')).toBeNull();
  });

  it('does not re-arm long-press after the finger crosses the movement threshold and stops', () => {
    const { list, rows } = create();
    const rowClick = vi.fn();
    list.addEventListener('click', rowClick);
    const touch = { identifier: 10, clientX: 140, clientY: 20 };
    dispatchTouch(rows[0], 'touchstart', [touch]);
    const moved = { ...touch, clientY: 29 };
    dispatchTouch(rows[0], 'touchmove', [moved]);

    vi.advanceTimersByTime(PLAYLIST_LONG_PRESS_MS + 500);
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();

    dispatchTouch(rows[0], 'touchend', [], [moved]);

    const syntheticClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    rows[0].dispatchEvent(syntheticClick);
    expect(syntheticClick.defaultPrevented).toBe(true);
    expect(rowClick).not.toHaveBeenCalled();

    const ordinaryClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    rows[0].dispatchEvent(ordinaryClick);
    expect(ordinaryClick.defaultPrevented).toBe(false);
    expect(rowClick).toHaveBeenCalledTimes(1);
  });

  it('never arms a contact that starts while scroll momentum is settling', () => {
    const { list, rows, scroller } = create();
    const rowClick = vi.fn();
    list.addEventListener('click', rowClick);
    scroller.scrollTop = 20;
    scroller.dispatchEvent(new Event('scroll'));

    const touch = { identifier: 25, clientX: 140, clientY: 20 };
    dispatchTouch(rows[0], 'touchstart', [touch]);
    vi.advanceTimersByTime(PLAYLIST_LONG_PRESS_MS + 500);
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();

    dispatchTouch(rows[0], 'touchend', [], [touch]);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    rows[0].dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('removes an active touch drag on touchcancel without committing', () => {
    const { commit, rows } = create();
    const touch = { identifier: 26, clientX: 140, clientY: 20 };
    dispatchTouch(rows[0], 'touchstart', [touch]);
    vi.advanceTimersByTime(PLAYLIST_LONG_PRESS_MS);
    expect(document.querySelector('.playlist-reorder-ghost')).not.toBeNull();

    dispatchTouch(rows[0], 'touchcancel', [], [touch]);
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();
    expect(document.body.classList.contains('playlist-reorder-active')).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps an ordinary row tap unsuppressed', () => {
    const { list, rows } = create();
    const rowClick = vi.fn();
    list.addEventListener('click', rowClick);
    const touch = { identifier: 27, clientX: 140, clientY: 20 };
    dispatchTouch(rows[0], 'touchstart', [touch]);
    dispatchTouch(rows[0], 'touchend', [], [touch]);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    rows[0].dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(rowClick).toHaveBeenCalledTimes(1);
  });

  it('does not reveal a touch-scroll hint for a tap without actual scrolling', () => {
    const { rows } = create();
    const touch = { identifier: 11, clientX: 140, clientY: 20 };
    dispatchTouch(rows[0], 'touchstart', [touch]);
    dispatchTouch(rows[0], 'touchend', [], [touch]);
    vi.advanceTimersByTime(32);

    expect(document.querySelector('.is-touch-scroll-hint')).toBeNull();
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();
  });

  it('shows all handles for exactly two seconds after an add notification', () => {
    const { controller, list } = create();
    controller.notifyItemsAdded();
    expect(list.classList.contains('show-reorder-hints')).toBe(true);

    vi.advanceTimersByTime(PLAYLIST_REORDER_HINT_MS - 1);
    expect(list.classList.contains('show-reorder-hints')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(list.classList.contains('show-reorder-hints')).toBe(false);
  });

  it('shows the two-second hint on every visible playlist-tab entry', () => {
    const { controller, list } = create();

    controller.notifyPlaylistEntered();
    expect(list.classList.contains('show-reorder-hints')).toBe(true);

    vi.advanceTimersByTime(PLAYLIST_REORDER_HINT_MS);
    expect(list.classList.contains('show-reorder-hints')).toBe(false);
  });

  it('defers an add hint while hidden and shows it on the next playlist entry', () => {
    const { controller, list, setVisible } = create(true, false);
    controller.notifyItemsAdded();
    expect(list.classList.contains('show-reorder-hints')).toBe(false);

    setVisible(true);
    controller.notifyPlaylistEntered();
    expect(list.classList.contains('show-reorder-hints')).toBe(true);
  });

  it('auto-scrolls the tab body near the visible bottom edge', () => {
    const { list, scroller } = create();
    const handle = list.querySelector<HTMLElement>('.playlist-reorder-handle')!;
    dispatchPointer(handle, 'pointerdown', 20);
    dispatchPointer(handle, 'pointermove', 198);

    vi.advanceTimersByTime(64);
    expect(scroller.scrollTop).toBeGreaterThan(0);
    dispatchPointer(handle, 'pointerup', 198);
  });

  it('does not treat a non-overlapping compact side navigation as a bottom obstruction', () => {
    const { list, scroller } = create();
    const sideNav = document.createElement('nav');
    sideNav.className = 'bottom-nav';
    sideNav.getBoundingClientRect = () =>
      ({
        top: 50,
        bottom: 400,
        left: 320,
        right: 420,
        width: 100,
        height: 350,
        x: 320,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(sideNav);

    const handle = list.querySelector<HTMLElement>('.playlist-reorder-handle')!;
    dispatchPointer(handle, 'pointerdown', 20);
    dispatchPointer(handle, 'pointermove', 120);

    vi.advanceTimersByTime(64);
    expect(scroller.scrollTop).toBe(0);
    dispatchPointer(handle, 'pointerup', 120);
  });

  it('does not start any reorder affordance without mutation authority', () => {
    const { commit, list, controller } = create(false);
    const handle = list.querySelector<HTMLElement>('.playlist-reorder-handle')!;
    dispatchPointer(handle, 'pointerdown', 20);
    controller.notifyItemsAdded();

    expect(commit).not.toHaveBeenCalled();
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();
    expect(list.classList.contains('show-reorder-hints')).toBe(false);
  });
});

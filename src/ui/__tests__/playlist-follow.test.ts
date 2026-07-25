/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaylistFollowController } from '../playlist-follow.ts';

const QUEUE_A = '00000000-0000-4000-8000-000000000001';
const QUEUE_B = '00000000-0000-4000-8000-000000000002';

function domRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 320,
    width: 320,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function renderEntries(list: HTMLElement, queueItemIds: readonly string[]): void {
  list.replaceChildren(
    ...queueItemIds.map((queueItemId) => {
      const entry = document.createElement('li');
      entry.className = 'playlist-entry';
      entry.dataset.queueItemId = queueItemId;
      const row = document.createElement('div');
      row.className = 'track-item';
      entry.appendChild(row);
      return entry;
    }),
  );
}

function setupScroller(): {
  panel: HTMLElement;
  scroller: HTMLElement;
  list: HTMLElement;
  scrollTo: ReturnType<typeof vi.fn>;
} {
  document.body.innerHTML = `
    <section id="tab-playlist" class="active">
      <div class="tab-body"><ul id="playlist-ui"></ul></div>
    </section>`;
  const panel = document.getElementById('tab-playlist')!;
  const scroller = document.querySelector<HTMLElement>('.tab-body')!;
  const list = document.getElementById('playlist-ui')!;

  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 200 },
    clientTop: { configurable: true, value: 0 },
    scrollHeight: { configurable: true, value: 1000 },
  });
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (typeof options.top === 'number') scroller.scrollTop = options.top;
  });
  Object.defineProperty(scroller, 'scrollTo', {
    configurable: true,
    value: scrollTo,
  });

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this === scroller) return domRect(100, 200);
    if (this.classList.contains('track-item')) {
      const queueItemId = this.closest<HTMLElement>('.playlist-entry')?.dataset.queueItemId;
      const contentTop = queueItemId === QUEUE_B ? 620 : 40;
      return domRect(100 + contentTop - scroller.scrollTop, 40);
    }
    if (this.classList.contains('sub-track-item')) {
      return domRect(800 - scroller.scrollTop, 40);
    }
    return domRect(0, 0);
  });

  return { panel, scroller, list, scrollTo };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  );
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
    window.clearTimeout(handle);
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.style.removeProperty('--desktop-ui-scale');
});

function flushFollowFrame(): void {
  vi.advanceTimersByTime(16);
}

describe('playlist active-track follow', () => {
  it('centers inside the mobile viewport above its bottom navigation clearance', () => {
    const { panel, scroller, list, scrollTo } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    scroller.style.scrollPaddingBottom = '80px';
    scroller.scrollTop = 120;

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();

      // The usable viewport is 120px tall, so its logical center is 60px
      // below the top rather than the raw scrollbox's 100px center.
      expect(scroller.scrollTop).toBe(580);
      expect(scrollTo).toHaveBeenCalledWith({ top: 580, behavior: 'smooth' });
    } finally {
      controller.destroy();
    }
  });

  it('centers a physically scaled target using logical scroll coordinates', () => {
    document.body.style.setProperty('--desktop-ui-scale', '1.5');
    const { panel, scroller, list, scrollTo } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    scroller.scrollTop = 120;
    scroller.getBoundingClientRect = () => domRect(150, 300);
    const target = list.querySelector<HTMLElement>(
      `[data-queue-item-id="${QUEUE_B}"] .track-item`,
    )!;
    target.getBoundingClientRect = () => domRect(150 + (620 - scroller.scrollTop) * 1.5, 60);

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();
      expect(scroller.scrollTop).toBe(540);
      expect(scrollTo).toHaveBeenCalledWith({ top: 540, behavior: 'smooth' });
    } finally {
      controller.destroy();
    }
  });

  it('follows a new selection after manual scrolling but leaves the same selection alone', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    scroller.scrollTop = 120;

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();

      expect(scroller.scrollTop).toBe(540);

      // A manual browse away from the active row is respected until playback
      // actually selects another queue occurrence.
      scroller.scrollTop = 80;
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();
      expect(scroller.scrollTop).toBe(80);

      controller.updateSelection(QUEUE_A, -1);
      controller.afterRender();
      flushFollowFrame();
      expect(scroller.scrollTop).toBe(0);
    } finally {
      controller.destroy();
    }
  });

  it('retargets a native smooth follow when a render moves its row', () => {
    const { panel, scroller, list, scrollTo } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    scroller.scrollTop = 40;

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 540, behavior: 'smooth' });

      renderEntries(list, [QUEUE_A, QUEUE_B]);
      const replacement = list.querySelector<HTMLElement>(
        `[data-queue-item-id="${QUEUE_B}"] .track-item`,
      )!;
      replacement.getBoundingClientRect = () => domRect(100 + 760 - scroller.scrollTop, 40);
      controller.afterRender();
      flushFollowFrame();

      expect(scrollTo).toHaveBeenNthCalledWith(2, { top: 540, behavior: 'auto' });
      expect(scrollTo).toHaveBeenNthCalledWith(3, { top: 680, behavior: 'smooth' });
      expect(scroller.scrollTop).toBe(680);
    } finally {
      controller.destroy();
    }
  });

  it('leaves a very long jump entirely to native smooth scrolling without a timeout snap', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 50_000 });
    scroller.scrollTop = 40;
    const scrollTo = vi.fn<(options: ScrollToOptions) => void>();
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });
    const target = list.querySelector<HTMLElement>(
      `[data-queue-item-id="${QUEUE_B}"] .track-item`,
    )!;
    target.getBoundingClientRect = () => domRect(100 + 40_000 - scroller.scrollTop, 40);
    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenCalledWith({ top: 39_920, behavior: 'smooth' });

      vi.advanceTimersByTime(10_000);
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scroller.scrollTop).toBe(40);
    } finally {
      controller.destroy();
    }
  });

  it('keeps a missing target pending until a later render supplies it', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A]);

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      vi.advanceTimersByTime(16);
      expect(scroller.scrollTop).toBe(0);

      renderEntries(list, [QUEUE_A, QUEUE_B]);
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();

      expect(scroller.scrollTop).toBe(540);
    } finally {
      controller.destroy();
    }
  });

  it('keeps a missing expanded sub-track pending until its row is rendered', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    const entry = list.querySelector<HTMLElement>(`[data-queue-item-id="${QUEUE_B}"]`)!;
    const subPlaylist = document.createElement('ul');
    subPlaylist.className = 'sub-playlist';
    subPlaylist.innerHTML = '<li class="sub-track-item loading">Loading</li>';
    entry.appendChild(subPlaylist);

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, 3);
      controller.afterRender();
      vi.advanceTimersByTime(16);
      expect(scroller.scrollTop).toBe(0);

      subPlaylist.innerHTML = '<li class="sub-track-item" data-sub-index="3">Track 4</li>';
      controller.afterRender();
      flushFollowFrame();

      expect(scroller.scrollTop).toBe(620);
    } finally {
      controller.destroy();
    }
  });

  it('does not start a pending follow while another playlist interaction owns the view', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    let blocked = true;

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
      isBlocked: () => blocked,
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      vi.advanceTimersByTime(16);
      expect(scroller.scrollTop).toBe(0);

      blocked = false;
      controller.afterRender();
      flushFollowFrame();
      expect(scroller.scrollTop).toBe(540);
    } finally {
      controller.destroy();
    }
  });

  it('cancels an in-flight native scroll when the user manually takes over scrolling', () => {
    const { panel, scroller, list, scrollTo } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 540, behavior: 'smooth' });

      scroller.scrollTop = 180;
      scroller.dispatchEvent(new Event('wheel'));
      vi.advanceTimersByTime(2_000);

      expect(scroller.scrollTop).toBe(180);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 180, behavior: 'auto' });
      expect(scrollTo).toHaveBeenCalledTimes(2);

      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();
      expect(scrollTo).toHaveBeenCalledTimes(2);
    } finally {
      controller.destroy();
    }
  });

  it.each(['touchstart', 'pointerdown'])(
    'cancels an in-flight native scroll on %s takeover',
    (eventType) => {
      const { panel, scroller, list, scrollTo } = setupScroller();
      renderEntries(list, [QUEUE_A, QUEUE_B]);

      const controller = createPlaylistFollowController({
        list,
        scrollContainer: scroller,
        isVisible: () => panel.classList.contains('active'),
      });
      try {
        controller.updateSelection(QUEUE_B, -1);
        controller.afterRender();
        flushFollowFrame();

        scroller.scrollTop = 190;
        list.dispatchEvent(new Event(eventType, { bubbles: true }));

        expect(scrollTo).toHaveBeenLastCalledWith({ top: 190, behavior: 'auto' });
        expect(scrollTo).toHaveBeenCalledTimes(2);
      } finally {
        controller.destroy();
      }
    },
  );

  it('observes native-scroll idle completion without forcing a final position', () => {
    const { panel, scroller, list, scrollTo } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();

      scroller.scrollTop = 430;
      scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(160);

      expect(scroller.scrollTop).toBe(430);
      expect(scrollTo).toHaveBeenCalledTimes(1);
    } finally {
      controller.destroy();
    }
  });

  it('cancels an in-flight animation when the sibling custom scrollbar takes over', () => {
    const { panel, scroller, list, scrollTo } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    const track = document.createElement('div');
    track.className = 'cscroll-track';
    const thumb = document.createElement('div');
    thumb.className = 'cscroll-thumb';
    track.appendChild(thumb);
    panel.appendChild(track);

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();

      scroller.scrollTop = 210;
      thumb.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      vi.advanceTimersByTime(2_000);

      expect(scroller.scrollTop).toBe(210);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 210, behavior: 'auto' });
    } finally {
      controller.destroy();
    }
  });

  it('cancels an in-flight animation for keyboard interaction in the playlist', () => {
    const { panel, scroller, list, scrollTo } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();

      scroller.scrollTop = 230;
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
      vi.advanceTimersByTime(2_000);

      expect(scroller.scrollTop).toBe(230);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 230, behavior: 'auto' });
    } finally {
      controller.destroy();
    }
  });

  it('keeps following when playlist controls consume a keyboard command', () => {
    const { panel, scroller, list, scrollTo } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    list.addEventListener('keydown', (event) => event.preventDefault());

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();

      list.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
      flushFollowFrame();

      expect(scroller.scrollTop).toBe(540);
      expect(scrollTo).toHaveBeenCalledTimes(1);
    } finally {
      controller.destroy();
    }
  });

  it('replaces an in-flight destination when playback selects another occurrence', () => {
    const { panel, scroller, list, scrollTo } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();
      scroller.scrollTop = 200;

      controller.updateSelection(QUEUE_A, -1);
      controller.afterRender();
      flushFollowFrame();
      expect(scroller.scrollTop).toBe(0);
      expect(scrollTo).toHaveBeenNthCalledWith(2, { top: 200, behavior: 'auto' });
      expect(scrollTo).toHaveBeenNthCalledWith(3, { top: 0, behavior: 'smooth' });
    } finally {
      controller.destroy();
    }
  });

  it('moves immediately when reduced motion is requested', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    const { panel, scroller, list, scrollTo } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      vi.advanceTimersByTime(16);
      expect(scroller.scrollTop).toBe(540);
      expect(scrollTo).toHaveBeenCalledWith({ top: 540, behavior: 'auto' });
    } finally {
      controller.destroy();
    }
  });

  it('falls back to an immediate position when a legacy scrollTo rejects options', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    scroller.scrollTop = 120;
    const scrollTo = vi.fn(() => {
      throw new TypeError('options overload unsupported');
    });
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      flushFollowFrame();

      expect(scrollTo).toHaveBeenCalledWith({ top: 540, behavior: 'smooth' });
      expect(scroller.scrollTop).toBe(540);
    } finally {
      controller.destroy();
    }
  });
});

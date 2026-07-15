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

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
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

  return { panel, scroller, list };
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
});

describe('playlist active-track follow', () => {
  it('follows a new selection after manual scrolling but leaves the same selection alone', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    scroller.scrollTop = 120;
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scroller.scrollTop = options.top as number;
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
      vi.advanceTimersByTime(16);

      expect(scrollTo).toHaveBeenLastCalledWith({ top: 540, behavior: 'smooth' });
      vi.advanceTimersByTime(440);

      // A manual browse away from the active row is respected until playback
      // actually selects another queue occurrence.
      scroller.scrollTop = 80;
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      vi.advanceTimersByTime(16);
      expect(scrollTo).toHaveBeenCalledTimes(1);

      controller.updateSelection(QUEUE_A, -1);
      controller.afterRender();
      vi.advanceTimersByTime(16);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
    } finally {
      controller.destroy();
    }
  });

  it('reissues the same pending follow when a render replaces its target row', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    scroller.scrollTop = 40;
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      vi.advanceTimersByTime(16);
      expect(scrollTo).toHaveBeenCalledTimes(1);

      renderEntries(list, [QUEUE_A, QUEUE_B]);
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      vi.advanceTimersByTime(16);

      // The original settle check owns the retry deadline even if a render
      // replaces the target DOM in the meantime.
      expect(scrollTo).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(440);
      expect(scrollTo).toHaveBeenCalledTimes(2);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 540, behavior: 'smooth' });
    } finally {
      controller.destroy();
    }
  });

  it('retries an ignored smooth scroll and finishes with a deterministic fallback', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    scroller.scrollTop = 40;
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      vi.advanceTimersByTime(16 + 440 + 16 + 440);

      expect(scrollTo.mock.calls.map(([options]) => options.behavior)).toEqual([
        'smooth',
        'smooth',
        'auto',
      ]);
      expect(scroller.scrollTop).toBe(540);
    } finally {
      controller.destroy();
    }
  });

  it('keeps a missing target pending until a later render supplies it', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A]);
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scroller.scrollTop = options.top as number;
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
      vi.advanceTimersByTime(16);
      expect(scrollTo).not.toHaveBeenCalled();

      renderEntries(list, [QUEUE_A, QUEUE_B]);
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      vi.advanceTimersByTime(16);

      expect(scrollTo).toHaveBeenCalledWith({ top: 540, behavior: 'smooth' });
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
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scroller.scrollTop = options.top as number;
    });
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, 3);
      controller.afterRender();
      vi.advanceTimersByTime(16);
      expect(scrollTo).not.toHaveBeenCalled();

      subPlaylist.innerHTML = '<li class="sub-track-item" data-sub-index="3">Track 4</li>';
      controller.afterRender();
      vi.advanceTimersByTime(16);

      expect(scrollTo).toHaveBeenCalledWith({ top: 620, behavior: 'smooth' });
    } finally {
      controller.destroy();
    }
  });

  it('does not start a pending follow while another playlist interaction owns the view', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });
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
      expect(scrollTo).not.toHaveBeenCalled();

      blocked = false;
      controller.afterRender();
      vi.advanceTimersByTime(16);
      expect(scrollTo).toHaveBeenCalledOnce();
    } finally {
      controller.destroy();
    }
  });

  it('cancels retries when the user manually takes over scrolling', () => {
    const { panel, scroller, list } = setupScroller();
    renderEntries(list, [QUEUE_A, QUEUE_B]);
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    const controller = createPlaylistFollowController({
      list,
      scrollContainer: scroller,
      isVisible: () => panel.classList.contains('active'),
    });
    try {
      controller.updateSelection(QUEUE_B, -1);
      controller.afterRender();
      vi.advanceTimersByTime(16);
      expect(scrollTo).toHaveBeenCalledOnce();

      scroller.scrollTop = 180;
      scroller.dispatchEvent(new Event('wheel'));
      vi.advanceTimersByTime(2_000);

      expect(scrollTo).toHaveBeenCalledOnce();
      expect(scroller.scrollTop).toBe(180);
    } finally {
      controller.destroy();
    }
  });
});

/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemId } from '../../types/index.ts';
import {
  createPlaylistCurrentJumpController,
  type PlaylistCurrentSelection,
} from '../playlist-current-jump.ts';

const QUEUE_A = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const QUEUE_B = '00000000-0000-4000-8000-000000000002' as QueueItemId;

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

function setup(): {
  panel: HTMLElement;
  scroller: HTMLElement;
  list: HTMLElement;
  selection: PlaylistCurrentSelection;
  onActivate: (selection: Readonly<PlaylistCurrentSelection>) => void;
} {
  document.body.innerHTML = `
    <section id="tab-playlist" class="tab-content active">
      <div class="tab-body"><ul id="playlist-ui"></ul></div>
    </section>`;
  const panel = document.getElementById('tab-playlist')!;
  const scroller = document.querySelector<HTMLElement>('.tab-body')!;
  const list = document.getElementById('playlist-ui')!;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 200 },
    clientTop: { configurable: true, value: 0 },
    scrollHeight: { configurable: true, value: 1_000 },
  });
  scroller.getBoundingClientRect = () => domRect(100, 200);

  for (const [queueItemId, contentTop] of [
    [QUEUE_A, 80],
    [QUEUE_B, 620],
  ] as const) {
    const entry = document.createElement('li');
    entry.className = 'playlist-entry';
    entry.dataset.queueItemId = queueItemId;
    const row = document.createElement('div');
    row.className = 'track-item';
    row.getBoundingClientRect = () => domRect(100 + contentTop - scroller.scrollTop, 40);
    entry.appendChild(row);
    list.appendChild(entry);
  }

  const selection: PlaylistCurrentSelection = { queueItemId: QUEUE_B, subIndex: -1 };
  const onActivate = vi.fn<(selection: Readonly<PlaylistCurrentSelection>) => void>();
  return { panel, scroller, list, selection, onActivate };
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

describe('playlist current-track jump affordance', () => {
  it('shows below/above the viewport and delegates centering to the follow owner', () => {
    const { panel, scroller, list, selection, onActivate } = setup();
    const controller = createPlaylistCurrentJumpController({
      panel,
      list,
      scrollContainer: scroller,
      getSelection: () => selection,
      isVisible: () => panel.classList.contains('active'),
      onActivate,
    });
    try {
      vi.advanceTimersByTime(16);
      const button = document.getElementById('btn-playlist-current-track') as HTMLButtonElement;
      expect(button.classList).toContain('show');
      expect(button.classList).not.toContain('is-above');
      expect(button.tabIndex).toBe(0);

      button.click();
      expect(onActivate).toHaveBeenCalledWith(selection);

      scroller.scrollTop = 800;
      scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(16);
      expect(button.classList).toContain('show');
      expect(button.classList).toContain('is-above');

      scroller.scrollTop = 540;
      scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(16);
      expect(button.classList).not.toContain('show');
      expect(button.tabIndex).toBe(-1);
      expect(button.getAttribute('aria-hidden')).toBe('true');
    } finally {
      controller.destroy();
    }
  });

  it('tracks the active expanded sub-index instead of the visible parent row', () => {
    const { panel, scroller, list, selection, onActivate } = setup();
    const entry = Array.from(list.children).find(
      (child) => child instanceof HTMLElement && child.dataset.queueItemId === QUEUE_B,
    ) as HTMLElement;
    const subItem = document.createElement('li');
    subItem.className = 'sub-track-item active';
    subItem.dataset.subIndex = '3';
    subItem.getBoundingClientRect = () => domRect(100 + 860 - scroller.scrollTop, 40);
    entry.appendChild(subItem);

    scroller.scrollTop = 540; // Parent is centered, sub-track remains below.
    selection.subIndex = 3;
    const controller = createPlaylistCurrentJumpController({
      panel,
      list,
      scrollContainer: scroller,
      getSelection: () => selection,
      isVisible: () => true,
      onActivate,
    });
    try {
      vi.advanceTimersByTime(16);
      const button = document.getElementById('btn-playlist-current-track')!;
      expect(button.classList).toContain('show');

      selection.subIndex = -1;
      controller.afterRender();
      vi.advanceTimersByTime(16);
      expect(button.classList).not.toContain('show');
    } finally {
      controller.destroy();
    }
  });

  it('stays hidden while playlist interactions own the view', () => {
    const { panel, scroller, list, selection, onActivate } = setup();
    let blocked = true;
    const controller = createPlaylistCurrentJumpController({
      panel,
      list,
      scrollContainer: scroller,
      getSelection: () => selection,
      isVisible: () => true,
      isBlocked: () => blocked,
      onActivate,
    });
    try {
      vi.advanceTimersByTime(16);
      const button = document.getElementById('btn-playlist-current-track')!;
      expect(button.classList).not.toContain('show');

      blocked = false;
      controller.refresh();
      vi.advanceTimersByTime(16);
      expect(button.classList).toContain('show');
    } finally {
      controller.destroy();
    }
  });
});

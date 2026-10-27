/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistItem, QueueItemId } from '../../types/index.ts';
import { setLanguageMode, t } from '../../i18n/index.ts';
import {
  createPlaylistRemovalController,
  type PlaylistRemovalController,
} from '../playlist-removal.ts';

/** Matches the controller's remote confirmation window. */
const REMOTE_CONFIRMATION_TIMEOUT_MS = 10_000;
/** Matches the controller's in-place exit of the pills. */
const BAR_EXIT_MS = 220;
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';

function item(queueItemId: QueueItemId, title: string): PlaylistItem {
  return {
    queueItemId,
    type: 'file',
    name: `${title}.mp3`,
    title,
    videoId: null,
    playlistId: null,
  };
}

function row(queueItemId: QueueItemId): string {
  return `<li class="playlist-entry" data-queue-item-id="${queueItemId}">
    <button type="button" class="btn-playlist-select" data-queue-item-id="${queueItemId}"></button>
  </li>`;
}

/** A row as the playlist view renders it: the title button and the named minus. */
function rowWithTitle(queueItemId: QueueItemId, title: string): string {
  return `<li class="playlist-entry" data-queue-item-id="${queueItemId}">
    <div class="track-item" data-queue-item-id="${queueItemId}">
      <button type="button" class="track-name" data-action="play" data-queue-item-id="${queueItemId}">${title}</button>
      <button type="button" class="btn-playlist-select" data-action="select"
        data-queue-item-id="${queueItemId}" aria-pressed="false"
        aria-label="${t('playlist.select_track', { title })}"></button>
    </div>
  </li>`;
}

describe('playlist removal controller', () => {
  let controller: PlaylistRemovalController | null = null;

  beforeEach(() => {
    document.body.innerHTML = `<button id="nav-play" class="nav-item" data-tab="play">Play</button>
      <section id="tab-playlist" class="tab-content active">
        <ul id="playlist-ui">${row(A)}${row(B)}</ul>
      </section>`;
    setLanguageMode('en');
  });

  afterEach(() => {
    controller?.destroy();
    controller = null;
  });

  it('keeps each minus named by its track and reports the selection only as pressed', () => {
    const items = [item(A, 'Alpha'), item(B, 'Beta')];
    const list = document.getElementById('playlist-ui')!;
    list.innerHTML = rowWithTitle(A, 'Alpha') + rowWithTitle(B, 'Beta');
    controller = createPlaylistRemovalController({
      list,
      canRemove: () => true,
      isPlaylistVisible: () => true,
      getItems: () => items,
      onDelete: vi.fn(),
    });
    const [first, second] = list.querySelectorAll<HTMLButtonElement>('.btn-playlist-select');
    const names = () => [first!, second!].map((button) => button.getAttribute('aria-label'));
    const hints = () => [first!, second!].map((button) => button.getAttribute('title'));
    const fixedNames = [
      t('playlist.select_track', { title: 'Alpha' }),
      t('playlist.select_track', { title: 'Beta' }),
    ];

    // Outside the mode the minus says what a press starts; the name never
    // changes with the state, which only aria-pressed reports.
    expect(names()).toEqual(fixedNames);
    expect(first!.getAttribute('aria-pressed')).toBe('false');
    expect(hints()).toEqual([t('playlist.select_mode_hint'), t('playlist.select_mode_hint')]);

    controller.toggle(A);
    expect(names()).toEqual(fixedNames);
    expect(first!.getAttribute('aria-pressed')).toBe('true');
    expect(second!.getAttribute('aria-pressed')).toBe('false');
    // Inside the mode a press only picks, so no hint is shown on any row.
    expect(hints()).toEqual([null, null]);

    controller.cancel();
    expect(names()).toEqual(fixedNames);
    expect(first!.getAttribute('aria-pressed')).toBe('false');
    expect(hints()).toEqual([t('playlist.select_mode_hint'), t('playlist.select_mode_hint')]);
  });

  it('lets the track title report the selection and leave the tab order only while selecting', () => {
    const items = [item(A, 'Alpha'), item(B, 'Beta')];
    const list = document.getElementById('playlist-ui')!;
    list.innerHTML = rowWithTitle(A, 'Alpha') + rowWithTitle(B, 'Beta');
    controller = createPlaylistRemovalController({
      list,
      canRemove: () => true,
      isPlaylistVisible: () => true,
      getItems: () => items,
      onDelete: vi.fn(),
    });
    const titles = [...list.querySelectorAll<HTMLButtonElement>('.track-name')];
    const state = () =>
      titles.map((title) => [title.getAttribute('aria-pressed'), title.getAttribute('tabindex')]);

    expect(state()).toEqual([
      [null, null],
      [null, null],
    ]);

    // A title press picks the row in the mode, so it carries the same state,
    // and keyboard users pass each row once, on its minus.
    controller.toggle(A);
    expect(state()).toEqual([
      ['true', '-1'],
      ['false', '-1'],
    ]);
    controller.toggle(B);
    expect(state()).toEqual([
      ['true', '-1'],
      ['true', '-1'],
    ]);

    controller.cancel();
    expect(state()).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it('announces the count in an always-present status cell and names the bar by the visible count', () => {
    document
      .getElementById('tab-playlist')!
      .insertAdjacentHTML(
        'afterbegin',
        '<div class="tab-header"><span class="tab-title">Playlist</span><div class="playlist-title-area"></div></div>',
      );
    const items = [item(A, 'Alpha'), item(B, 'Beta')];
    controller = createPlaylistRemovalController({
      list: document.getElementById('playlist-ui')!,
      canRemove: () => true,
      isPlaylistVisible: () => true,
      getItems: () => items,
      onDelete: vi.fn(),
    });
    const header = document.querySelector<HTMLElement>('.tab-header')!;
    const title = header.querySelector<HTMLElement>('.playlist-selection-title')!;
    const status = header.querySelector<HTMLElement>('.playlist-selection-status')!;
    const bar = document.querySelector<HTMLElement>('.playlist-selection-bar')!;

    // The status cell is in the accessibility tree before the first pick, so
    // a screen reader hears the first count instead of a region appearing.
    expect(status).not.toBeNull();
    expect(status.classList).toContain('sr-only');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('');
    // The visible title is shown and hidden with the mode but never announces.
    expect(title.hasAttribute('aria-live')).toBe(false);
    expect(title.id).toBeTruthy();
    // The bar is named by the visible count, not by a delete-only label.
    expect(bar.getAttribute('aria-labelledby')).toBe(title.id);
    expect(bar.hasAttribute('aria-label')).toBe(false);

    controller.toggle(A);
    expect(status.textContent).toBe(t('playlist.selected_count', { count: 1 }));
    expect(title.textContent).toBe(t('playlist.selected_count', { count: 1 }));
    expect(bar.hasAttribute('aria-label')).toBe(false);
    controller.toggle(B);
    expect(status.textContent).toBe(t('playlist.selected_count', { count: 2 }));

    controller.cancel();
    expect(status.textContent).toBe('');
    expect(status.hidden).toBe(false);
    expect(status.isConnected).toBe(true);
  });

  it('names the selection bar actions without repeating their names as tooltips', () => {
    const items = [item(A, 'Alpha'), item(B, 'Beta')];
    const list = document.getElementById('playlist-ui')!;
    controller = createPlaylistRemovalController({
      list,
      canRemove: () => true,
      isPlaylistVisible: () => true,
      getItems: () => items,
      onDelete: vi.fn(),
      canMove: () => true,
      onMove: vi.fn(),
    });
    controller.toggle(A);

    const actions = [
      ...document.querySelectorAll<HTMLButtonElement>('.playlist-selection-bar button'),
    ];
    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      t('playlist.move_action'),
      t('common.delete'),
      t('common.cancel'),
    ]);
    expect(actions.filter((button) => button.hasAttribute('title'))).toEqual([]);
  });

  it('moves focus out of a playlist hidden by current-track deletion and never restores it later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let items = [item(A, 'Alpha'), item(B, 'Beta')];
      let visible = true;
      const list = document.getElementById('playlist-ui')!;
      const playTab = document.getElementById('nav-play') as HTMLButtonElement;
      const onDelete = vi.fn((queueItemIds: QueueItemId[]) => {
        items = items.filter((entry) => !queueItemIds.includes(entry.queueItemId));
        visible = false;
        document.getElementById('tab-playlist')?.classList.remove('active');
        controller?.notifyPlaylistHidden(playTab);
      });
      controller = createPlaylistRemovalController({
        list,
        canRemove: () => true,
        isPlaylistVisible: () => visible,
        getItems: () => items,
        onDelete,
        isRemovalLocal: () => true,
      });

      controller.toggle(A);
      const deleteButton = document.querySelector<HTMLButtonElement>(
        '[data-selection-action="delete"]',
      )!;
      deleteButton.focus();
      deleteButton.click();

      expect(onDelete).toHaveBeenCalledWith([A]);
      expect(document.activeElement).toBe(playTab);

      list.innerHTML = row(B);
      controller.afterRender();
      await Promise.resolve();

      expect(document.activeElement).toBe(playTab);
      expect(document.querySelector<HTMLElement>('.playlist-selection-bar')!.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases playlist follow after visible deletion selection ends', async () => {
    const items = [item(A, 'Alpha'), item(B, 'Beta')];
    const list = document.getElementById('playlist-ui')!;
    const onSelectionEnd = vi.fn();
    controller = createPlaylistRemovalController({
      list,
      canRemove: () => true,
      isPlaylistVisible: () => true,
      getItems: () => items,
      onDelete: vi.fn(),
      onSelectionEnd,
    });

    controller.toggle(A);
    controller.cancel();
    expect(onSelectionEnd).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(onSelectionEnd).toHaveBeenCalledOnce();
  });

  function deleteFirstRow(
    extra: Partial<Parameters<typeof createPlaylistRemovalController>[0]> = {},
  ) {
    let items = [item(A, 'Alpha'), item(B, 'Beta')];
    const list = document.getElementById('playlist-ui')!;
    const onDelete = vi.fn();
    const onDeleted = vi.fn();
    const onHiddenChange = vi.fn();
    controller = createPlaylistRemovalController({
      list,
      canRemove: () => true,
      isPlaylistVisible: () => true,
      getItems: () => items,
      onDelete,
      onDeleted,
      onHiddenChange,
      ...extra,
    });
    controller.toggle(A);
    document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
    return {
      list,
      onDelete,
      onDeleted,
      onHiddenChange,
      /** The authoritative snapshot drops the rows. */
      confirm(queueItemIds: QueueItemId[]) {
        items = items.filter((entry) => !queueItemIds.includes(entry.queueItemId));
        controller!.afterRender();
      },
    };
  }

  it('sends a deletion at once and hides remote rows until the snapshot drops them', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { onDelete, onDeleted, onHiddenChange, confirm } = deleteFirstRow();
      expect(onDelete).toHaveBeenCalledOnce();
      expect(onDelete).toHaveBeenCalledWith([A]);
      expect(controller!.isActive).toBe(false);
      expect(controller!.isHidden(A)).toBe(true);
      expect(controller!.isHidden(B)).toBe(false);
      expect(onHiddenChange).toHaveBeenCalled();
      expect(document.querySelector('[data-selection-action="undo"]')).toBeNull();
      expect(onDeleted).not.toHaveBeenCalled();

      confirm([A]);
      expect(onDeleted).toHaveBeenCalledOnce();
      expect(onDeleted).toHaveBeenCalledWith(1);
      vi.advanceTimersByTime(REMOTE_CONFIRMATION_TIMEOUT_MS);
      expect(onDeleted).toHaveBeenCalledOnce();
      expect(onDelete).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives an unconfirmed remote deletion its rows back without reporting it', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { onDeleted, onHiddenChange } = deleteFirstRow();
      onHiddenChange.mockClear();
      vi.advanceTimersByTime(REMOTE_CONFIRMATION_TIMEOUT_MS - 1);
      expect(controller!.isHidden(A)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(controller!.isHidden(A)).toBe(false);
      expect(onHiddenChange).toHaveBeenCalledOnce();
      expect(onDeleted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a local deletion as soon as it applies and never hides its rows', () => {
    let items = [item(A, 'Alpha'), item(B, 'Beta')];
    const onDeleted = vi.fn();
    controller = createPlaylistRemovalController({
      list: document.getElementById('playlist-ui')!,
      canRemove: () => true,
      isPlaylistVisible: () => true,
      getItems: () => items,
      onDelete: (queueItemIds) => {
        items = items.filter((entry) => !queueItemIds.includes(entry.queueItemId));
      },
      onDeleted,
      isRemovalLocal: () => true,
    });
    controller.toggle(A);
    controller.toggle(B);
    document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(onDeleted).toHaveBeenCalledWith(2);
  });

  it('does not report a local deletion the host refused', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { onDelete, onDeleted } = deleteFirstRow({ isRemovalLocal: () => true });
      expect(onDelete).toHaveBeenCalledWith([A]);
      expect(controller!.isHidden(A)).toBe(false);
      vi.advanceTimersByTime(REMOTE_CONFIRMATION_TIMEOUT_MS);
      controller!.afterRender();
      expect(onDeleted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report a deletion settled after edit authority is gone', () => {
    let allowed = true;
    const { onDeleted, confirm } = deleteFirstRow({ canRemove: () => allowed });
    allowed = false;
    // Leaving the room empties the list as well.
    confirm([A, B]);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  describe('bar exit', () => {
    let animate: ReturnType<typeof vi.fn>;
    let originalAnimate: typeof HTMLElement.prototype.animate | undefined;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      originalAnimate = HTMLElement.prototype.animate;
      animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
      HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    });

    afterEach(() => {
      vi.useRealTimers();
      if (originalAnimate) HTMLElement.prototype.animate = originalAnimate;
      else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    });

    function bar(): HTMLElement {
      return document.querySelector<HTMLElement>('.playlist-selection-bar')!;
    }

    function barAnimations(): unknown[][] {
      return animate.mock.calls.filter((_call, index) => animate.mock.contexts[index] === bar());
    }

    function selectFirstRow(visible = () => true): void {
      const items = [item(A, 'Alpha'), item(B, 'Beta')];
      controller = createPlaylistRemovalController({
        list: document.getElementById('playlist-ui')!,
        canRemove: () => true,
        isPlaylistVisible: visible,
        getItems: () => items,
        onDelete: vi.fn(),
      });
      controller.toggle(A);
    }

    it('lets its owner finish other row motion before it copies the leaving rows', () => {
      const rects = vi
        .spyOn(Element.prototype, 'getClientRects')
        .mockReturnValue([{}] as unknown as DOMRectList);
      try {
        const settling = document.querySelector<HTMLElement>(
          `.playlist-entry[data-queue-item-id="${A}"]`,
        )!;
        settling.classList.add('is-reorder-settling-source');
        const calls: string[] = [];
        const onBeforeDelete = vi.fn(() => {
          calls.push('finish other motion');
          settling.classList.remove('is-reorder-settling-source');
        });
        deleteFirstRow({ onBeforeDelete, onDelete: () => calls.push('delete') });

        expect(calls).toEqual(['finish other motion', 'delete']);
        const ghost = document.querySelector<HTMLElement>('.playlist-exit-ghost')!;
        expect(ghost.dataset.queueItemId).toBe(A);
        expect(ghost.classList.contains('is-reorder-settling-source')).toBe(false);
      } finally {
        rects.mockRestore();
      }
    });

    it('shrinks the whole bar away in place after Delete without delaying the deletion', () => {
      const { onDelete, list } = deleteFirstRow();
      expect(onDelete).toHaveBeenCalledOnce();
      expect(bar().hidden).toBe(false);
      expect(bar().dataset.state).toBe('leaving');
      expect(list.classList.contains('has-removal-exit')).toBe(true);
      expect(barAnimations()).toHaveLength(1);
      const [keyframes, timing] = barAnimations()[0] as [Keyframe[], KeyframeAnimationOptions];
      expect(keyframes.map((frame) => frame.opacity)).toEqual([1, 0]);
      expect(keyframes.map((frame) => frame.transform)).toEqual([
        'translateY(0px) scale(1)',
        'translateY(0px) scale(0.72)',
      ]);
      expect(timing).toMatchObject({ duration: BAR_EXIT_MS, fill: 'forwards' });

      // Pills on their way out no longer act.
      document.querySelector<HTMLButtonElement>('[data-selection-action="cancel"]')!.click();
      expect(bar().dataset.state).toBe('leaving');

      vi.advanceTimersByTime(BAR_EXIT_MS);
      expect(bar().hidden).toBe(true);
      expect(list.classList.contains('has-removal-exit')).toBe(false);
    });

    it('shrinks the bar away where it was when Cancel ends the mode', () => {
      selectFirstRow();
      // Outside the mode the list stretches and the pills would sit at the
      // bottom; their start must be read while the mode still holds them.
      const list = document.getElementById('playlist-ui')!;
      const rect = vi.spyOn(bar(), 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            top:
              list.classList.contains('has-removal-selection') ||
              list.classList.contains('has-removal-exit')
                ? 300
                : 600,
          }) as DOMRect,
      );
      document.querySelector<HTMLButtonElement>('[data-selection-action="cancel"]')!.click();
      expect(bar().dataset.state).toBe('leaving');
      expect(barAnimations()).toHaveLength(1);
      const [keyframes] = barAnimations()[0] as [Keyframe[]];
      expect(keyframes[0]!.transform).toBe('translateY(0px) scale(1)');
      vi.advanceTimersByTime(BAR_EXIT_MS);
      expect(bar().hidden).toBe(true);
      rect.mockRestore();
    });

    it('cancels the exit cleanly when a new selection starts during it', () => {
      deleteFirstRow();
      const exitIndex = animate.mock.contexts.lastIndexOf(bar());
      const exit = animate.mock.results[exitIndex]!.value as {
        cancel: ReturnType<typeof vi.fn>;
      };
      controller!.toggle(B);
      expect(exit.cancel).toHaveBeenCalled();
      expect(bar().dataset.state).toBe('select');
      expect(bar().hidden).toBe(false);
      vi.advanceTimersByTime(BAR_EXIT_MS);
      expect(bar().hidden).toBe(false);
      expect(bar().dataset.state).toBe('select');
    });

    it('hides at once when the playlist is off screen', () => {
      let visible = true;
      selectFirstRow(() => visible);
      visible = false;
      controller!.notifyPlaylistHidden();
      expect(bar().hidden).toBe(true);
      expect(barAnimations()).toHaveLength(0);
    });

    it('slides a frozen copy of each deleted row out to the right', () => {
      const rects = vi
        .spyOn(Element.prototype, 'getClientRects')
        .mockReturnValue([{}] as unknown as DOMRectList);
      try {
        const { list } = deleteFirstRow();
        const layer = document.querySelector<HTMLElement>('.playlist-exit-layer')!;
        expect(layer).not.toBeNull();
        expect(layer.getAttribute('aria-hidden')).toBe('true');
        // After the bar, outside the list that re-renders from scratch.
        expect(layer.previousElementSibling).toBe(bar());
        const runs = layer.querySelectorAll<HTMLElement>(':scope > .playlist-exit-run');
        expect(runs).toHaveLength(1);
        const ghosts = runs[0]!.querySelectorAll<HTMLElement>('.playlist-exit-ghost');
        expect(Array.from(ghosts, (ghost) => ghost.dataset.queueItemId)).toEqual([A]);
        // The copy carries the shape, not the class other rows' rules read.
        expect(ghosts[0]!.classList.contains('is-removal-selected')).toBe(false);
        expect(list.contains(ghosts[0]!)).toBe(false);

        // The run slides on for 260 ms and fades out within the first 200.
        const runCalls = animate.mock.calls.filter(
          (_call, index) => animate.mock.contexts[index] === runs[0],
        ) as [Keyframe[], KeyframeAnimationOptions][];
        expect(
          runCalls.map(([frames]) => frames.map((frame) => frame.transform ?? frame.opacity)),
        ).toEqual([
          ['translateX(0)', 'translateX(100%)'],
          [1, 0],
        ]);
        expect(runCalls.map(([, timing]) => timing.duration)).toEqual([260, 200]);

        vi.advanceTimersByTime(260);
        expect(document.querySelector('.playlist-exit-layer')).toBeNull();
      } finally {
        rects.mockRestore();
      }
    });

    it('moves a joined block out as one run', () => {
      const rects = vi
        .spyOn(Element.prototype, 'getClientRects')
        .mockReturnValue([{}] as unknown as DOMRectList);
      try {
        const items = [item(A, 'Alpha'), item(B, 'Beta')];
        controller = createPlaylistRemovalController({
          list: document.getElementById('playlist-ui')!,
          canRemove: () => true,
          isPlaylistVisible: () => true,
          getItems: () => items,
          onDelete: vi.fn(),
        });
        controller.toggle(A);
        controller.toggle(B);
        document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
        const runs = document.querySelectorAll<HTMLElement>(
          '.playlist-exit-layer > .playlist-exit-run',
        );
        expect(runs).toHaveLength(1);
        expect(
          Array.from(
            runs[0]!.querySelectorAll<HTMLElement>('.playlist-exit-ghost'),
            (ghost) => ghost.dataset.queueItemId,
          ),
        ).toEqual([A, B]);
        // The rows inside the run do not move on their own.
        for (const ghost of runs[0]!.querySelectorAll('.playlist-exit-ghost')) {
          expect(animate.mock.contexts).not.toContain(ghost);
        }
      } finally {
        rects.mockRestore();
      }
    });

    it('crossfades the header between its playlist and selection controls', () => {
      document
        .getElementById('tab-playlist')!
        .insertAdjacentHTML(
          'afterbegin',
          '<div class="tab-header"><span class="tab-title">Playlist</span><div class="playlist-title-area"><button class="tab-action-btn" id="btn-repeat"></button></div></div>',
        );
      const rects = vi
        .spyOn(Element.prototype, 'getClientRects')
        .mockReturnValue([{}] as unknown as DOMRectList);
      try {
        selectFirstRow();
        const header = document.querySelector<HTMLElement>('.tab-header')!;
        const title = header.querySelector<HTMLElement>('.playlist-selection-title')!;
        const toggle = header.querySelector<HTMLElement>('.playlist-selection-toggle')!;
        const fadedIn = (element: Element) =>
          animate.mock.calls.some(
            (call, index) =>
              animate.mock.contexts[index] === element &&
              (call[0] as Keyframe[]).map((frame) => frame.opacity).join() === '0,1',
          );
        let layer = header.querySelector<HTMLElement>('.playlist-header-fade')!;
        expect(layer.getAttribute('aria-hidden')).toBe('true');
        // The playlist title and its icon actions leave as copies without ids.
        expect(Array.from(layer.children, (copy) => copy.className)).toEqual([
          'tab-title',
          'tab-action-btn',
        ]);
        expect(layer.querySelector('[id]')).toBeNull();
        expect(fadedIn(title)).toBe(true);
        expect(fadedIn(toggle)).toBe(true);
        vi.advanceTimersByTime(180);
        expect(header.querySelector('.playlist-header-fade')).toBeNull();

        // Leaving copies the count title before the mode empties it.
        document.querySelector<HTMLButtonElement>('[data-selection-action="cancel"]')!.click();
        layer = header.querySelector<HTMLElement>('.playlist-header-fade')!;
        expect(layer.children[0]!.textContent).toBe(t('playlist.selected_count', { count: 1 }));
        expect(layer.children[0]!.hasAttribute('aria-live')).toBe(false);
        // The bar's name points at the live title, never at its frozen copy.
        expect(layer.querySelector('[id]')).toBeNull();
        expect(layer.querySelector('.playlist-selection-status')).toBeNull();
        expect(fadedIn(header.querySelector('.tab-action-btn')!)).toBe(true);
        // A count change inside the mode is not a crossfade.
        controller!.toggle(A);
        controller!.toggle(B);
        vi.advanceTimersByTime(180);
        controller!.toggle(A);
        expect(header.querySelector('.playlist-header-fade')).toBeNull();
        expect(title.textContent).toBe(t('playlist.selected_count', { count: 1 }));
      } finally {
        rects.mockRestore();
      }
    });
  });

  it('builds and removes its header controls with the controller', () => {
    document
      .getElementById('tab-playlist')!
      .insertAdjacentHTML(
        'afterbegin',
        '<div class="tab-header"><span class="tab-title">Playlist</span><div class="playlist-title-area"></div></div>',
      );
    const items = [item(A, 'Alpha'), item(B, 'Beta')];
    controller = createPlaylistRemovalController({
      list: document.getElementById('playlist-ui')!,
      canRemove: () => true,
      isPlaylistVisible: () => true,
      getItems: () => items,
      onDelete: vi.fn(),
    });
    const header = document.querySelector<HTMLElement>('.tab-header')!;
    controller.toggle(A);
    expect(header.querySelector('.playlist-selection-title')?.textContent).toBe(
      t('playlist.selected_count', { count: 1 }),
    );
    expect(header.querySelector('.playlist-title-area .playlist-selection-toggle')).not.toBeNull();
    expect(header.querySelector('.playlist-selection-status')?.textContent).toBe(
      t('playlist.selected_count', { count: 1 }),
    );

    controller.destroy();
    controller = null;
    expect(header.querySelector('.playlist-selection-title')).toBeNull();
    expect(header.querySelector('.playlist-selection-toggle')).toBeNull();
    expect(header.querySelector('.playlist-selection-status')).toBeNull();
    expect(header.classList.contains('is-removal-selecting')).toBe(false);
    expect(document.querySelector('.playlist-selection-bar')).toBeNull();
  });

  it('does not resume playlist follow when the view hides before the release microtask', async () => {
    const items = [item(A, 'Alpha'), item(B, 'Beta')];
    const list = document.getElementById('playlist-ui')!;
    const onSelectionEnd = vi.fn();
    let visible = true;
    controller = createPlaylistRemovalController({
      list,
      canRemove: () => true,
      isPlaylistVisible: () => visible,
      getItems: () => items,
      onDelete: vi.fn(),
      onSelectionEnd,
    });

    controller.toggle(A);
    controller.cancel();
    visible = false;
    await Promise.resolve();

    expect(onSelectionEnd).not.toHaveBeenCalled();
  });
});

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
/** Matches the controller's exit slide. */
const MORPH_MS = 300;
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

  it('names each check circle as a selection toggle and updates its pressed-state action', () => {
    const items = [item(A, 'Alpha'), item(B, 'Beta')];
    const list = document.getElementById('playlist-ui')!;
    controller = createPlaylistRemovalController({
      list,
      canRemove: () => true,
      isPlaylistVisible: () => true,
      getItems: () => items,
      onDelete: vi.fn(),
    });

    const button = list.querySelector<HTMLButtonElement>(
      `.btn-playlist-select[data-queue-item-id="${A}"]`,
    )!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe(
      t('playlist.select_for_deletion', { title: 'Alpha' }),
    );

    controller.toggle(A);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe(
      t('playlist.deselect_for_deletion', { title: 'Alpha' }),
    );
    expect(button.title).toBe(button.getAttribute('aria-label'));
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

    it('slides the whole bar away after Delete without delaying the deletion', () => {
      const { onDelete, list } = deleteFirstRow();
      expect(onDelete).toHaveBeenCalledOnce();
      expect(bar().hidden).toBe(false);
      expect(bar().dataset.state).toBe('leaving');
      expect(list.classList.contains('has-removal-exit')).toBe(true);
      expect(barAnimations()).toHaveLength(1);
      const [keyframes, timing] = barAnimations()[0] as [Keyframe[], KeyframeAnimationOptions];
      expect(keyframes.map((frame) => frame.opacity)).toEqual([1, 0]);
      expect(timing).toMatchObject({ duration: MORPH_MS, fill: 'forwards' });

      // Pills on their way out no longer act.
      document.querySelector<HTMLButtonElement>('[data-selection-action="cancel"]')!.click();
      expect(bar().dataset.state).toBe('leaving');

      vi.advanceTimersByTime(MORPH_MS);
      expect(bar().hidden).toBe(true);
      expect(list.classList.contains('has-removal-exit')).toBe(false);
    });

    it('slides the bar away when Cancel ends the mode', () => {
      selectFirstRow();
      document.querySelector<HTMLButtonElement>('[data-selection-action="cancel"]')!.click();
      expect(bar().dataset.state).toBe('leaving');
      expect(barAnimations()).toHaveLength(1);
      vi.advanceTimersByTime(MORPH_MS);
      expect(bar().hidden).toBe(true);
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
      vi.advanceTimersByTime(MORPH_MS);
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

    controller.destroy();
    controller = null;
    expect(header.querySelector('.playlist-selection-title')).toBeNull();
    expect(header.querySelector('.playlist-selection-toggle')).toBeNull();
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

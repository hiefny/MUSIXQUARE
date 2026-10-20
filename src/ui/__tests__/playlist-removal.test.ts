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

/** Matches the controller's undo window. */
const PLAYLIST_REMOVAL_UNDO_MS = 3000;
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
    <button type="button" class="btn-playlist-remove" data-queue-item-id="${queueItemId}"></button>
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

  it('names each X as a selection toggle and updates its pressed-state action', () => {
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
      `.btn-playlist-remove[data-queue-item-id="${A}"]`,
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
      expect(onDelete).not.toHaveBeenCalled();
      vi.advanceTimersByTime(PLAYLIST_REMOVAL_UNDO_MS);

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

  function beginPendingDeletion(
    extra: Partial<Parameters<typeof createPlaylistRemovalController>[0]> = {},
  ) {
    const items = [item(A, 'Alpha'), item(B, 'Beta')];
    const list = document.getElementById('playlist-ui')!;
    const onDelete = vi.fn();
    const onHiddenChange = vi.fn();
    controller = createPlaylistRemovalController({
      list,
      canRemove: () => true,
      isPlaylistVisible: () => true,
      getItems: () => items,
      onDelete,
      onHiddenChange,
      ...extra,
    });
    controller.toggle(A);
    document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
    return { list, items, onDelete, onHiddenChange };
  }

  it('hides the deleted rows during the undo window and sends them once afterwards', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { onDelete, onHiddenChange } = beginPendingDeletion();
      expect(controller!.hasPendingDeletion).toBe(true);
      expect(controller!.isHidden(A)).toBe(true);
      expect(controller!.isHidden(B)).toBe(false);
      expect(controller!.isActive).toBe(false);
      expect(onHiddenChange).toHaveBeenCalled();

      vi.advanceTimersByTime(PLAYLIST_REMOVAL_UNDO_MS);
      expect(onDelete).toHaveBeenCalledOnce();
      expect(onDelete).toHaveBeenCalledWith([A]);
      expect(controller!.hasPendingDeletion).toBe(false);
      // Remote removal keeps the row hidden until the snapshot drops it.
      expect(controller!.isHidden(A)).toBe(true);
      vi.advanceTimersByTime(10_000);
      expect(controller!.isHidden(A)).toBe(false);
      expect(onDelete).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the rows on Undo and never sends them', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { onDelete } = beginPendingDeletion();
      const pill = document.querySelector<HTMLButtonElement>('[data-selection-action="undo"]')!;
      expect(pill.textContent?.trim()).toBe(t('common.undo'));
      expect(pill.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      pill.click();
      expect(controller!.isHidden(A)).toBe(false);
      expect(controller!.hasPendingDeletion).toBe(false);
      vi.advanceTimersByTime(20_000);
      expect(onDelete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a local deletion at once and drops a pending one on request', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { onDelete } = beginPendingDeletion({ isRemovalLocal: () => true });
      controller!.commitPendingDeletion();
      expect(onDelete).toHaveBeenCalledWith([A]);
      expect(controller!.isHidden(A)).toBe(false);

      controller!.toggle(B);
      document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
      expect(controller!.isHidden(B)).toBe(true);
      controller!.dropPendingDeletion();
      expect(controller!.isHidden(B)).toBe(false);
      vi.advanceTimersByTime(20_000);
      expect(onDelete).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a pending deletion whose authority is gone by the time it would commit', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let allowed = true;
      const { onDelete } = beginPendingDeletion({ canRemove: () => allowed });
      allowed = false;
      vi.advanceTimersByTime(PLAYLIST_REMOVAL_UNDO_MS);
      expect(onDelete).not.toHaveBeenCalled();
      expect(controller!.isHidden(A)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

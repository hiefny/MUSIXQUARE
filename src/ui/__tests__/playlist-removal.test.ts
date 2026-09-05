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
    });

    controller.toggle(A);
    const deleteButton = document.querySelector<HTMLButtonElement>(
      '[data-selection-action="delete"]',
    )!;
    deleteButton.focus();
    deleteButton.click();

    expect(onDelete).toHaveBeenCalledWith([A]);
    expect(document.activeElement).toBe(playTab);

    // Match the later state-driven playlist rebuild. A stale pending focus
    // must not pull focus back into the now-hidden panel.
    list.innerHTML = row(B);
    controller.afterRender();
    await Promise.resolve();

    expect(document.activeElement).toBe(playTab);
    expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
      'is-visible',
    );
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

  function beginDelayedDeletion() {
    let items = [item(A, 'Alpha'), item(B, 'Beta')];
    const list = document.getElementById('playlist-ui')!;
    const onDelete = vi.fn();
    controller = createPlaylistRemovalController({
      list,
      canRemove: () => true,
      isPlaylistVisible: () => true,
      getItems: () => items,
      onDelete,
    });
    controller.toggle(A);
    document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
    expect(onDelete).toHaveBeenCalledWith([A]);
    expect((document.activeElement as HTMLElement).dataset.queueItemId).toBe(B);
    return {
      list,
      renderResponse: () => {
        // PRO and Standard operator removal rebuild only after the canonical
        // response arrives, leaving time for another user interaction.
        items = items.filter((entry) => entry.queueItemId !== A);
        list.innerHTML = row(B);
        controller!.afterRender();
      },
    };
  }

  it('restores the survivor after the canonical rebuild removes the focused button', async () => {
    const { list, renderResponse } = beginDelayedDeletion();
    renderResponse();
    expect(document.activeElement).toBe(document.body);
    await Promise.resolve();
    expect(document.activeElement).toBe(list.querySelector('.btn-playlist-remove'));
  });

  it.each(['chat', 'other-row', 'pointerdown', 'keydown'] as const)(
    'preserves newer %s intent while a deletion response is pending',
    async (intent) => {
      const { list, renderResponse } = beginDelayedDeletion();
      const chat = document.createElement('input');
      document.body.appendChild(chat);
      if (intent === 'chat') chat.focus();
      else if (intent === 'other-row') {
        list.querySelector<HTMLButtonElement>(`[data-queue-item-id="${A}"] button`)!.focus();
      } else if (intent === 'pointerdown') {
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      } else {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
        );
      }
      renderResponse();
      await Promise.resolve();
      expect(document.activeElement).toBe(intent === 'chat' ? chat : document.body);
    },
  );

  it.each(['cancel', 'destroy'] as const)(
    'retires a queued restore when %s happens before its microtask',
    async (action) => {
      const { renderResponse } = beginDelayedDeletion();
      renderResponse();
      controller![action]();
      await Promise.resolve();
      expect(document.activeElement).toBe(document.body);
    },
  );

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

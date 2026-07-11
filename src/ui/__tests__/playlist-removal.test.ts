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
});

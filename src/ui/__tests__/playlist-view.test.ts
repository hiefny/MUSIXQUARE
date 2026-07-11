/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import type { DataConnection, PlaylistItem } from '../../types/index.ts';
import { setLanguageMode, t } from '../../i18n/index.ts';
import { initPlaylistView, updatePlaylistUI } from '../playlist-view.ts';

vi.mock('../../network/peer.ts', () => ({
  safeSend: vi.fn(),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  resetState();
  bus.clear();
  localStorage.clear();
  document.body.innerHTML =
    '<section id="tab-playlist" class="tab-content active"><div class="tab-body"><ul id="playlist-ui"></ul></div></section>';
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  setLanguageMode('ko');
});

const FILE_A = '00000000-0000-4000-8000-000000000001';
const YT_B = '00000000-0000-4000-8000-000000000002';

function sampleItems(): PlaylistItem[] {
  return [
    {
      queueItemId: FILE_A,
      type: 'file',
      name: 'a.mp3',
      title: 'A',
      videoId: null,
      playlistId: null,
    },
    {
      queueItemId: YT_B,
      type: 'youtube',
      name: 'YouTube list',
      title: 'YouTube list',
      videoId: 'abcdefghijk',
      playlistId: 'PL_TEST',
      isExpanded: true,
    },
  ];
}

describe('playlist empty state i18n', () => {
  it('keeps the empty-state row translatable after playlist rerenders', () => {
    updatePlaylistUI();

    const empty = document.querySelector<HTMLElement>('.list-empty-state');
    expect(empty?.getAttribute('data-i18n')).toBe('playlist.empty_hint');

    setLanguageMode('en');

    expect(empty?.textContent).toBe(t('playlist.empty_hint'));
  });

  it('refreshes playlist-rendered copy when the language changes', async () => {
    initPlaylistView();
    updatePlaylistUI();

    setLanguageMode('en');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const empty = document.querySelector<HTMLElement>('.list-empty-state');
    expect(empty?.textContent).toBe('Please add media.');
  });
});

describe('playlist queue identity rendering and actions', () => {
  it('renders each YouTube parent and sub-list inside one atomic queue entry', () => {
    setState('playlist.items', sampleItems());
    setState('youtube.subItemsMap', {
      PL_TEST: { ids: ['video-a', 'video-b'], titles: ['First', 'Second'] },
    });

    updatePlaylistUI();

    const entries = document.querySelectorAll(':scope #playlist-ui > .playlist-entry');
    expect(entries).toHaveLength(2);
    const youtubeEntry = document.querySelector(`[data-queue-item-id="${YT_B}"]`);
    expect(youtubeEntry?.matches('.playlist-entry')).toBe(true);
    expect(youtubeEntry?.querySelectorAll(':scope > .sub-playlist')).toHaveLength(1);
    expect(youtubeEntry?.querySelectorAll('.sub-track-item[data-sub-index]')).toHaveLength(2);
  });

  it('shows reorder handles only to the host and keeps the same number slot', () => {
    setState('playlist.items', sampleItems());
    updatePlaylistUI();
    expect(document.querySelectorAll('.playlist-reorder-handle')).toHaveLength(2);
    expect(document.querySelectorAll('.playlist-reorder-handle .track-idx')).toHaveLength(2);

    setState('network.hostConn', { open: true, peer: 'host' } as DataConnection);
    updatePlaylistUI();
    expect(document.querySelectorAll('.playlist-reorder-handle')).toHaveLength(0);
    expect(document.querySelectorAll('.track-leading-static .track-idx')).toHaveLength(2);
  });

  it('delegates play, remove, expansion, and sub-seek actions by queueItemId', async () => {
    const items = sampleItems();
    items[1] = { ...items[1], isExpanded: false };
    setState('playlist.items', items);
    setState('youtube.subItemsMap', {
      PL_TEST: { ids: ['video-a'], titles: ['First'] },
    });
    initPlaylistView();

    const play = vi.fn();
    const remove = vi.fn();
    const populate = vi.fn();
    const subSeek = vi.fn();
    bus.on('playlist:play-track', play);
    bus.on('playlist:remove-tracks', remove);
    bus.on('youtube:populate-sub-items', populate);
    bus.on('youtube:sub-seek', subSeek);

    document
      .querySelector<HTMLElement>(`.track-item[data-queue-item-id="${FILE_A}"] .track-name`)!
      .click();
    expect(play).toHaveBeenCalledWith(FILE_A);

    document
      .querySelector<HTMLElement>(`[data-action="expand"][data-queue-item-id="${YT_B}"]`)!
      .click();
    expect(populate).toHaveBeenCalledWith('PL_TEST', YT_B);
    document.querySelector<HTMLElement>('.sub-track-item[data-sub-index="0"]')!.click();
    expect(subSeek).toHaveBeenCalledWith(YT_B, 0, false);

    const removeButton = document.querySelector<HTMLButtonElement>(
      `[data-action="remove"][data-queue-item-id="${FILE_A}"]`,
    )!;
    removeButton.click();
    expect(removeButton.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.playlist-selection-pill')?.classList).toContain('is-visible');
    expect(remove).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
    expect(remove).toHaveBeenCalledWith([FILE_A]);
  });

  it('uses the existing remove buttons as stable multi-selection toggles', () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();

    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.btn-playlist-remove'),
    );
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute('aria-label')).toBe(
      t('playlist.select_for_deletion', { title: 'A' }),
    );

    buttons[0]!.click();
    expect(buttons[0]?.getAttribute('aria-label')).toBe(
      t('playlist.deselect_for_deletion', { title: 'A' }),
    );
    buttons[1]!.click();
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    expect(document.querySelector('.playlist-selection-count')?.textContent).toBe('2');

    buttons[0]!.click();
    expect(document.querySelector('.playlist-selection-count')?.textContent).toBe('1');
    expect(document.querySelector('.playlist-selection-pill')?.classList).toContain('is-visible');

    buttons[1]!.click();
    expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
      'is-visible',
    );
  });

  it('cancels selection with Escape and disables reorder controls only while active', () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    const removeButton = document.querySelector<HTMLButtonElement>('.btn-playlist-remove')!;
    const handles = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.playlist-reorder-handle'),
    );

    removeButton.click();
    expect(document.querySelector('.playlist-selection-pill')?.getAttribute('role')).toBe('group');
    expect(handles.every((handle) => handle.disabled)).toBe(true);
    expect(handles.every((handle) => !handle.hasAttribute('aria-keyshortcuts'))).toBe(true);

    removeButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(removeButton.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
      'is-visible',
    );
    expect(handles.every((handle) => !handle.disabled)).toBe(true);
    expect(handles.every((handle) => handle.hasAttribute('aria-keyshortcuts'))).toBe(true);
  });

  it('toggles every live queue item from one select-all action without mutating the queue', () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    const remove = vi.fn();
    bus.on('playlist:remove-tracks', remove);

    document.querySelector<HTMLButtonElement>('.btn-playlist-remove')!.click();
    const selectAll = document.querySelector<HTMLButtonElement>(
      '[data-selection-action="select-all"]',
    )!;
    selectAll.click();

    expect(
      Array.from(document.querySelectorAll('.btn-playlist-remove')).map((button) =>
        button.getAttribute('aria-pressed'),
      ),
    ).toEqual(['true', 'true']);
    expect(selectAll.disabled).toBe(false);
    expect(selectAll.getAttribute('aria-pressed')).toBe('true');
    expect(selectAll.getAttribute('aria-label')).toBe(t('playlist.deselect_all'));
    expect(document.querySelector('[data-selection-action="deselect"]')).toBeNull();

    selectAll.click();
    expect(remove).not.toHaveBeenCalled();
    expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
      'is-visible',
    );
    expect(
      Array.from(document.querySelectorAll('.btn-playlist-remove')).map((button) =>
        button.getAttribute('aria-pressed'),
      ),
    ).toEqual(['false', 'false']);
  });

  it('clears selection and closes the pill from the explicit cancel action', () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    const remove = vi.fn();
    bus.on('playlist:remove-tracks', remove);

    document.querySelector<HTMLButtonElement>('.btn-playlist-remove')!.click();
    const cancelButton = document.querySelector<HTMLButtonElement>(
      '[data-selection-action="cancel"]',
    )!;
    expect(cancelButton.getAttribute('aria-label')).toBe(t('common.cancel'));
    cancelButton.click();

    expect(remove).not.toHaveBeenCalled();
    expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
      'is-visible',
    );
    expect(
      Array.from(document.querySelectorAll('.btn-playlist-remove')).map((button) =>
        button.getAttribute('aria-pressed'),
      ),
    ).toEqual(['false', 'false']);
  });

  it('deletes non-contiguous selections once in playlist order and without a dialog', () => {
    const third: PlaylistItem = {
      queueItemId: '00000000-0000-4000-8000-000000000003',
      type: 'file',
      name: 'a.mp3',
      title: 'A duplicate',
      videoId: null,
      playlistId: null,
    };
    setState('playlist.items', [...sampleItems(), third]);
    initPlaylistView();
    const remove = vi.fn();
    bus.on('playlist:remove-tracks', remove);

    document
      .querySelector<HTMLButtonElement>(`.btn-playlist-remove[data-queue-item-id="${FILE_A}"]`)!
      .click();
    document
      .querySelector<HTMLButtonElement>(
        `.btn-playlist-remove[data-queue-item-id="${third.queueItemId}"]`,
      )!
      .click();
    document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([FILE_A, third.queueItemId]);
    expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
      'is-visible',
    );
  });

  it('keeps selection attached to queueItemId across rerenders and prunes lost authority', () => {
    const items = sampleItems();
    setState('playlist.items', items);
    initPlaylistView();
    document
      .querySelector<HTMLButtonElement>(`.btn-playlist-remove[data-queue-item-id="${FILE_A}"]`)!
      .click();

    setState('playlist.items', [items[1]!, items[0]!]);
    updatePlaylistUI();
    expect(
      document
        .querySelector(`.btn-playlist-remove[data-queue-item-id="${FILE_A}"]`)
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    setState('network.hostConn', { open: true, peer: 'host' } as DataConnection);
    updatePlaylistUI();
    expect(document.querySelectorAll('.btn-playlist-remove')).toHaveLength(0);
    expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
      'is-visible',
    );
  });

  it('does not expose removal or reorder controls while system audio owns playback', () => {
    setState('playlist.items', sampleItems());
    setState('playback.mode', 'system-audio');
    initPlaylistView();

    expect(document.querySelectorAll('.btn-playlist-remove')).toHaveLength(0);
    expect(document.querySelectorAll('.playlist-reorder-handle')).toHaveLength(0);
  });

  it('does not restore deletion focus into a playlist that became hidden', async () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    document.querySelector<HTMLButtonElement>('.btn-playlist-remove')!.click();
    const deleteButton = document.querySelector<HTMLButtonElement>(
      '[data-selection-action="delete"]',
    )!;
    deleteButton.focus();
    bus.on('playlist:remove-tracks', () => {
      document.getElementById('tab-playlist')?.classList.remove('active');
    });

    deleteButton.click();
    updatePlaylistUI();
    await Promise.resolve();

    expect(document.activeElement?.closest('#tab-playlist')).toBeNull();
  });

  it('reveals all host handles when an add batch completes', () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();

    bus.emit('playlist:items-added', [YT_B]);

    expect(document.getElementById('playlist-ui')?.classList.contains('show-reorder-hints')).toBe(
      true,
    );
  });

  it('emits a reorder commit with stable IDs and the latest base revision', () => {
    setState('playlist.items', sampleItems());
    setState('playlist.revision', 7);
    initPlaylistView();
    const reorder = vi.fn();
    bus.on('playlist:reorder-track', reorder);

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.track-item'));
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () =>
        ({
          top: index * 56,
          bottom: index * 56 + 48,
          left: 0,
          right: 300,
          width: 300,
          height: 48,
          x: 0,
          y: index * 56,
          toJSON: () => ({}),
        }) as DOMRect;
    });
    const handle = document.querySelector<HTMLElement>('.playlist-reorder-handle')!;
    const dispatch = (type: string, clientY: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 20,
        clientY,
      });
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        isPrimary: { value: true },
      });
      handle.dispatchEvent(event);
    };

    dispatch('pointerdown', 20);
    dispatch('pointermove', 160);
    dispatch('pointerup', 160);

    expect(reorder).toHaveBeenCalledWith(FILE_A, null, 7);
  });

  it('preserves the actual tab-body scroll position across a non-selection rerender', () => {
    setState('playlist.items', sampleItems());
    updatePlaylistUI();
    const scroller = document.querySelector<HTMLElement>('.tab-body')!;
    scroller.scrollTop = 123;

    updatePlaylistUI();

    expect(scroller.scrollTop).toBe(123);
  });
});

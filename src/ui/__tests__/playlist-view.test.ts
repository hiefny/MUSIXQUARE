/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { MSG } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection, PlaylistItem } from '../../types/index.ts';
import { setLanguageMode, t } from '../../i18n/index.ts';
import { initPlaylistView, updatePlaylistUI } from '../playlist-view.ts';
import { safeSend } from '../../network/peer.ts';

vi.mock('../../network/peer.ts', () => ({
  safeSend: vi.fn(),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.mocked(safeSend).mockReset();
  localStorage.clear();
  setState('network.appRole', 'host');
  document.body.innerHTML =
    '<section id="tab-playlist" class="tab-content active"><div class="tab-body"><ul id="playlist-ui"></ul></div></section>';
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  setLanguageMode('ko');
});

afterEach(() => {
  clearAllManagedTimers();
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

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function configurePlaylistFollowLayout(): ReturnType<typeof vi.fn> {
  const scroller = document.querySelector<HTMLElement>('.tab-body')!;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 300 },
  });
  scroller.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 100,
      left: 0,
      right: 300,
      width: 300,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  const baseTops = new Map([
    [FILE_A, 0],
    [YT_B, 200],
  ]);
  for (const row of document.querySelectorAll<HTMLElement>('.track-item[data-queue-item-id]')) {
    const baseTop = baseTops.get(row.dataset.queueItemId || '') ?? 0;
    row.getBoundingClientRect = () => {
      const top = baseTop - scroller.scrollTop;
      return {
        top,
        bottom: top + 40,
        left: 0,
        right: 300,
        width: 300,
        height: 40,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
  }

  const scrollTo = vi.fn((options: ScrollToOptions) => {
    scroller.scrollTop = Number(options.top ?? 0);
  });
  Object.defineProperty(scroller, 'scrollTo', {
    configurable: true,
    value: scrollTo,
  });
  return scrollTo;
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
    expect(empty?.textContent).toBe('No media yet.');
  });
});

describe('playlist queue identity rendering and actions', () => {
  it('does not rebuild every row for play/pause activity changes', async () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    const list = document.getElementById('playlist-ui')!;
    const replaceChildren = vi.spyOn(list, 'replaceChildren');

    setState('playback.activity', 'playing');
    await nextAnimationFrame();
    expect(replaceChildren).not.toHaveBeenCalled();

    setState('playback.mode', 'system-audio');
    await nextAnimationFrame();
    expect(replaceChildren).toHaveBeenCalledOnce();
  });

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

  it('marks multilingual parent and sub-track titles with detected script fonts', () => {
    const items = sampleItems();
    items[1]!.title = '這麼好的歌';
    setState('playlist.items', items);
    setState('youtube.subItemsMap', {
      PL_TEST: { ids: ['video-a'], titles: ['かなの曲'] },
    });

    updatePlaylistUI();

    expect(
      document.querySelector(`[data-queue-item-id="${YT_B}"] .track-name-text`)?.classList,
    ).toContain('user-text-font-zh-hant');
    expect(document.querySelector('.sub-name')?.classList).toContain('user-text-font-ja');
  });

  it('prefers resolved display titles for files and YouTube entries', () => {
    setState('playlist.items', [
      {
        queueItemId: FILE_A,
        type: 'file',
        name: 'original-file-name.flac',
        title: 'Embedded track title',
        videoId: null,
        playlistId: null,
      },
      {
        queueItemId: YT_B,
        type: 'youtube',
        name: 'abcdefghijk',
        title: 'Resolved YouTube title',
        videoId: 'abcdefghijk',
        playlistId: null,
      },
    ]);

    updatePlaylistUI();

    const labels = [...document.querySelectorAll<HTMLElement>('.track-name-text')].map(
      (element) => element.textContent,
    );
    expect(labels).toEqual(['Embedded track title', 'Resolved YouTube title']);
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

  it('shows queue editing controls to a PRO media manager', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'coordinator' } as DataConnection);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'coordinator',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['queue.mutate'],
    });
    setState('playlist.items', sampleItems());

    updatePlaylistUI();

    expect(document.querySelectorAll('.playlist-reorder-handle')).toHaveLength(2);
    expect(document.querySelectorAll('.btn-playlist-remove')).toHaveLength(2);
  });

  it('preserves a PRO deletion task across revision-only context pulses', async () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'coordinator' } as DataConnection);
    const context = {
      kind: 'pro' as const,
      roomId: '000001',
      role: 'member' as const,
      coordinatorId: 'coordinator',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['queue.mutate' as const],
    };
    setState('room.context', context);
    setState('playlist.items', sampleItems());
    initPlaylistView();
    const list = document.getElementById('playlist-ui')!;
    const replaceChildren = vi.spyOn(list, 'replaceChildren');

    document
      .querySelector<HTMLButtonElement>(`.btn-playlist-remove[data-queue-item-id="${FILE_A}"]`)!
      .click();
    setState('room.context', { ...context, snapshotRevision: 2 });
    await nextAnimationFrame();

    expect(replaceChildren).not.toHaveBeenCalled();
    expect(document.querySelector('.playlist-selection-pill')?.classList).toContain('is-visible');
    expect(
      document
        .querySelector(`.btn-playlist-remove[data-queue-item-id="${FILE_A}"]`)
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('cancels a PRO deletion task on authority loss or room-incarnation replacement', async () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'coordinator' } as DataConnection);
    const context = {
      kind: 'pro' as const,
      roomId: '000001',
      role: 'member' as const,
      coordinatorId: 'coordinator',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['queue.mutate' as const],
    };
    setState('room.context', context);
    setState('playlist.items', sampleItems());
    initPlaylistView();

    document.querySelector<HTMLButtonElement>('.btn-playlist-remove')!.click();
    setState('room.context', { ...context, snapshotRevision: 2, capabilities: [] });
    expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
      'is-visible',
    );

    setState('room.context', { ...context, snapshotRevision: 3 });
    await nextAnimationFrame();
    document.querySelector<HTMLButtonElement>('.btn-playlist-remove')!.click();
    setState('room.context', { ...context, epoch: 2, snapshotRevision: 4 });
    expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
      'is-visible',
    );

    setState('room.context', { ...context, epoch: 2, snapshotRevision: 5 });
    await nextAnimationFrame();
    document.querySelector<HTMLButtonElement>('.btn-playlist-remove')!.click();
    setState('room.context', { ...context, roomId: '000002', snapshotRevision: 1 });

    expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
      'is-visible',
    );
  });

  it('keeps an active PRO reorder mounted through revision-only context pulses', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'coordinator' } as DataConnection);
    const context = {
      kind: 'pro' as const,
      roomId: '000001',
      role: 'member' as const,
      coordinatorId: 'coordinator',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['queue.mutate' as const],
    };
    setState('room.context', context);
    setState('playlist.items', sampleItems());
    initPlaylistView();

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
    const dispatch = (type: string, clientY: number): void => {
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
    dispatch('pointermove', 100);
    expect(document.querySelector('.playlist-reorder-ghost')).not.toBeNull();

    setState('room.context', { ...context, snapshotRevision: 2 });
    expect(document.querySelector('.playlist-reorder-ghost')).not.toBeNull();

    setState('room.context', { ...context, snapshotRevision: 3, capabilities: [] });
    expect(document.querySelector('.playlist-reorder-ghost')).toBeNull();
  });

  it('shows queue controls only when a standard-room administrator can manage media', async () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'host' } as DataConnection);
    setState('playlist.items', sampleItems());
    initPlaylistView();

    expect(document.querySelectorAll('.playlist-reorder-handle')).toHaveLength(0);
    expect(document.querySelectorAll('.btn-playlist-remove')).toHaveLength(0);

    setState('network.isOperator', true);
    setState('network.standardRoomCapabilities', [
      'media.add',
      'queue.mutate',
      'playback.control',
      'asset.upload',
      'members.manage',
    ]);
    await nextAnimationFrame();
    expect(document.querySelectorAll('.playlist-reorder-handle')).not.toHaveLength(0);
    expect(document.querySelectorAll('.btn-playlist-remove')).not.toHaveLength(0);

    setState('network.isOperator', false);
    await nextAnimationFrame();
    expect(document.querySelectorAll('.playlist-reorder-handle')).toHaveLength(0);
    expect(document.querySelectorAll('.btn-playlist-remove')).toHaveLength(0);
    expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
      'is-visible',
    );
  });

  it('arms an immediate play-control wait after a PRO member requests a row', () => {
    const hostConn = { open: true, peer: 'coordinator' } as DataConnection;
    vi.mocked(safeSend).mockReturnValue(true);
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.isOperator', true);
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'member',
      coordinatorId: 'coordinator',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['playback.control'],
    });
    setState('playlist.items', sampleItems());
    initPlaylistView();

    document
      .querySelector<HTMLElement>(`.track-item[data-queue-item-id="${FILE_A}"] .track-name`)!
      .click();

    expect(safeSend).toHaveBeenCalledWith(hostConn, {
      type: MSG.REQUEST_TRACK_CHANGE,
      queueItemId: FILE_A,
    });
    expect(getState('network.pendingTrackChangeQueueItemId')).toBe(FILE_A);
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

  it('preserves desktop deletion selection across track advance and prunes only removed rows', async () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });

    try {
      const items = sampleItems();
      setState('playlist.items', items);
      setState('playlist.currentQueueItemId', FILE_A);
      initPlaylistView();

      for (const queueItemId of [FILE_A, YT_B]) {
        document
          .querySelector<HTMLButtonElement>(
            `.btn-playlist-remove[data-queue-item-id="${queueItemId}"]`,
          )!
          .click();
      }

      // playTrack() emits this logical switch while the wide dashboard keeps
      // the playlist physically visible. Advancing the active row must not
      // cancel the user's independent deletion task.
      bus.emit('ui:tab-changed', 'play');
      setState('playlist.currentQueueItemId', YT_B);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      expect(document.querySelector('.playlist-selection-count')?.textContent).toBe('2');
      expect(
        document
          .querySelector(`.btn-playlist-remove[data-queue-item-id="${FILE_A}"]`)
          ?.getAttribute('aria-pressed'),
      ).toBe('true');
      expect(
        document
          .querySelector(`.btn-playlist-remove[data-queue-item-id="${YT_B}"]`)
          ?.getAttribute('aria-pressed'),
      ).toBe('true');

      setState('playlist.items', [items[1]!]);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(document.querySelector('.playlist-selection-count')?.textContent).toBe('1');
      expect(
        document
          .querySelector(`.btn-playlist-remove[data-queue-item-id="${YT_B}"]`)
          ?.getAttribute('aria-pressed'),
      ).toBe('true');
      expect(document.querySelector('.playlist-selection-pill')?.classList).toContain('is-visible');

      setState('playlist.items', []);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(document.querySelector('.playlist-selection-pill')?.classList).not.toContain(
        'is-visible',
      );
    } finally {
      if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('does not recenter an unchanged current track when deletion selection is cancelled', async () => {
    setState('playlist.items', sampleItems());
    setState('playlist.currentQueueItemId', FILE_A);
    initPlaylistView();
    const scrollTo = configurePlaylistFollowLayout();
    await nextAnimationFrame();
    scrollTo.mockClear();

    document.querySelector<HTMLButtonElement>('.btn-playlist-remove')!.click();
    document.querySelector<HTMLButtonElement>('[data-selection-action="cancel"]')!.click();
    await Promise.resolve();
    await nextAnimationFrame();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('resumes a pending active-track follow after deletion selection ends', async () => {
    setState('playlist.items', sampleItems());
    setState('playlist.currentQueueItemId', FILE_A);
    initPlaylistView();
    let scrollTo = configurePlaylistFollowLayout();
    await nextAnimationFrame();

    document.querySelector<HTMLButtonElement>('.btn-playlist-remove')!.click();
    setState('playlist.currentQueueItemId', YT_B);
    await nextAnimationFrame();
    scrollTo = configurePlaylistFollowLayout();

    document.querySelector<HTMLButtonElement>('[data-selection-action="cancel"]')!.click();
    await Promise.resolve();
    await nextAnimationFrame();
    await nextAnimationFrame();

    const scroller = document.querySelector<HTMLElement>('.tab-body')!;
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ top: 170, behavior: 'smooth' });
    expect(scroller.scrollTop).toBe(170);
  });

  it('keeps deletion survivor focus without starting an unrelated current-track follow', async () => {
    const items = sampleItems();
    setState('playlist.items', items);
    setState('playlist.currentQueueItemId', FILE_A);
    initPlaylistView();
    const scrollTo = configurePlaylistFollowLayout();
    await nextAnimationFrame();
    scrollTo.mockClear();
    bus.on('playlist:remove-tracks', () => setState('playlist.items', [items[0]!]));

    document
      .querySelector<HTMLButtonElement>(`.btn-playlist-remove[data-queue-item-id="${YT_B}"]`)!
      .click();
    document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
    await Promise.resolve();
    await nextAnimationFrame();
    await Promise.resolve();

    expect(scrollTo).not.toHaveBeenCalled();
    expect((document.activeElement as HTMLElement | null)?.dataset.queueItemId).toBe(FILE_A);
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

  it('keeps the committed source handle mounted through its return fade before rendering', () => {
    const FRAME_MS = 16;
    const DROP_SETTLE_MS = 302;
    const HANDLE_RETURN_WITH_SAFETY_MS = 172;
    vi.useFakeTimers();
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) =>
        window.setTimeout(() => callback(performance.now()), FRAME_MS),
      );
    const caf = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id) => window.clearTimeout(id));
    let unsubscribe: (() => void) | undefined;

    try {
      const initial = sampleItems();
      const committed: PlaylistItem[] = [initial[1]!, { ...initial[0]!, name: 'committed-a.mp3' }];
      setState('playlist.items', initial);
      setState('playlist.revision', 7);
      initPlaylistView();

      const commit = vi.fn(() => setState('playlist.items', committed));
      unsubscribe = bus.on('playlist:reorder-track', commit);

      const list = document.getElementById('playlist-ui')!;
      const sourceSelector = `.playlist-entry[data-queue-item-id="${FILE_A}"]`;
      const sourceEntry = list.querySelector<HTMLElement>(sourceSelector)!;
      const sourceHandle = sourceEntry.querySelector<HTMLElement>('.playlist-reorder-handle')!;
      const sourceNumber = sourceHandle.querySelector<HTMLElement>('.track-idx')!;
      const sourceGrip = sourceHandle.querySelector<SVGElement>('.playlist-reorder-grip')!;
      const sourceName = sourceEntry.querySelector<HTMLElement>('.track-name-text')!;

      Array.from(list.querySelectorAll<HTMLElement>('.track-item')).forEach((row, index) => {
        row.getBoundingClientRect = () =>
          ({
            x: 0,
            y: index * 56,
            top: index * 56,
            bottom: index * 56 + 48,
            left: 0,
            right: 300,
            width: 300,
            height: 48,
            toJSON: () => ({}),
          }) as DOMRect;
      });

      const dispatch = (type: string, clientY: number): void => {
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
        sourceHandle.dispatchEvent(event);
      };
      const expectOriginalIdentity = (): void => {
        const current = list.querySelector<HTMLElement>(sourceSelector)!;
        expect(sourceEntry.isConnected).toBe(true);
        expect(current).toBe(sourceEntry);
        expect(current.querySelector('.playlist-reorder-handle')).toBe(sourceHandle);
        expect(current.querySelector('.track-idx')).toBe(sourceNumber);
        expect(current.querySelector('.playlist-reorder-grip')).toBe(sourceGrip);
      };

      dispatch('pointerdown', 20);
      dispatch('pointermove', 160);
      dispatch('pointerup', 160);

      expect(commit).toHaveBeenCalledWith(FILE_A, null, 7);
      expect(document.querySelector('.playlist-reorder-settle')).not.toBeNull();
      expect(sourceEntry.classList.contains('is-reorder-source')).toBe(true);
      expectOriginalIdentity();
      expect(sourceName.textContent).toBe('A');

      vi.advanceTimersByTime(FRAME_MS);
      vi.advanceTimersByTime(FRAME_MS);
      expect(sourceEntry.classList.contains('is-reorder-handoff')).toBe(true);

      vi.advanceTimersByTime(DROP_SETTLE_MS);
      expect(document.querySelector('.playlist-reorder-settle')).toBeNull();
      expect(sourceEntry.classList.contains('is-reorder-source')).toBe(false);
      expectOriginalIdentity();

      vi.advanceTimersByTime(FRAME_MS);
      expectOriginalIdentity();

      vi.advanceTimersByTime(HANDLE_RETURN_WITH_SAFETY_MS - FRAME_MS - 1);
      expectOriginalIdentity();
      expect(sourceName.textContent).toBe('A');

      vi.advanceTimersByTime(1);
      expectOriginalIdentity();
      vi.advanceTimersByTime(FRAME_MS - 1);
      expectOriginalIdentity();
      vi.advanceTimersByTime(1);

      const renderedEntry = list.querySelector<HTMLElement>(sourceSelector)!;
      expect(sourceEntry.isConnected).toBe(false);
      expect(renderedEntry).not.toBe(sourceEntry);
      expect(renderedEntry.querySelector('.playlist-reorder-handle')).not.toBe(sourceHandle);
      expect(renderedEntry.querySelector('.track-name-text')?.textContent).toBe('A');
    } finally {
      unsubscribe?.();
      vi.clearAllTimers();
      raf.mockRestore();
      caf.mockRestore();
      vi.useRealTimers();
    }
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

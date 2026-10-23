/**
 * @vitest-environment jsdom
 */
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { DESKTOP_LAYOUT_QUERY } from '../../core/layout-breakpoints.ts';
import { MSG } from '../../core/constants.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { DataConnection, PlaylistItem } from '../../types/index.ts';
import { setLanguageMode, t } from '../../i18n/index.ts';
import { initPlaylistView, updatePlaylistUI } from '../playlist-view.ts';
import { safeSend } from '../../network/peer.ts';
import { updateSubItemTitle } from '../../youtube/_state.ts';
import { ProRoomUploadQueue, setActiveProRoomUploadQueue } from '../../pro-room/upload-queue.ts';
import { STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES } from '../../network/standard-room-authority.ts';
import { ProRoomPlaylistProjection } from '../../pro-room/playlist-projection.ts';
import { hydrateProRoomYouTubeManifests } from '../../pro-room/youtube-manifest-policy.ts';
import { proYouTubeSubItemsKey } from '../../youtube/queue-manifest.ts';
import type { ProRoomSnapshot } from '../../pro-room/contracts.ts';

const playlistTitleMarqueeMocks = vi.hoisted(() => ({
  init: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('../../network/peer.ts', () => ({
  safeSend: vi.fn(),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../playlist-title-marquee.ts', () => ({
  initPlaylistTitleMarquee: playlistTitleMarqueeMocks.init,
  schedulePlaylistTitleMarqueeMeasure: playlistTitleMarqueeMocks.schedule,
}));

let proRoomUploadQueue: ProRoomUploadQueue | null = null;

beforeEach(() => {
  proRoomUploadQueue?.reset();
  proRoomUploadQueue = null;
  setActiveProRoomUploadQueue(null);
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.mocked(safeSend).mockReset();
  playlistTitleMarqueeMocks.init.mockReset();
  playlistTitleMarqueeMocks.schedule.mockReset();
  localStorage.clear();
  setState('network.appRole', 'host');
  document.body.innerHTML =
    '<nav class="bottom-nav"><button type="button" class="nav-item" data-tab="play">Play</button></nav>' +
    '<section id="tab-playlist" class="tab-content active" tabindex="-1">' +
    '<div class="tab-header"><span class="tab-title" data-i18n="nav.playlist">Playlist</span>' +
    '<div class="playlist-title-area"><button type="button" class="tab-action-btn" id="btn-repeat"></button>' +
    '<button type="button" class="tab-action-btn" id="btn-shuffle"></button>' +
    '<button type="button" class="tab-action-btn" id="btn-add-media"></button></div></div>' +
    '<div class="tab-body"><ul id="playlist-ui"></ul></div></section>';
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  setLanguageMode('ko');
});

afterEach(() => {
  proRoomUploadQueue?.reset();
  proRoomUploadQueue = null;
  setActiveProRoomUploadQueue(null);
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

function selectionBarVisible(): boolean {
  const bar = document.querySelector<HTMLElement>('.playlist-selection-bar');
  return !!bar && !bar.hidden;
}

function selectionTitle(): string | null {
  const title = document.querySelector<HTMLElement>('.playlist-selection-title');
  return title && !title.hidden ? title.textContent : null;
}

function renderedQueueIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('#playlist-ui > .playlist-entry[data-queue-item-id]'),
    (entry) => entry.dataset.queueItemId ?? '',
  );
}

function clickSelect(queueItemId: string): void {
  document
    .querySelector<HTMLButtonElement>(`.btn-playlist-select[data-queue-item-id="${queueItemId}"]`)!
    .click();
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

it('renders and patches titles for each saved PRO manifest independently, including later batches', async () => {
  const manifests = [
    { queueItemId: FILE_A, ids: Array.from({ length: 180 }, (_, index) => `old${index}`) },
    { queueItemId: YT_B, ids: Array.from({ length: 180 }, (_, index) => `new${index}`) },
  ];
  const playlist = manifests.map(({ queueItemId, ids }) => ({
    queueItemId,
    name: 'Saved playlist',
    source: { kind: 'youtube' as const, videoId: ids[0]!, playlistId: 'PL_SHARED', videoIds: ids },
  }));
  setState(
    'playlist.items',
    new ProRoomPlaylistProjection()
      .project(playlist)
      .map((item) => ({ ...item, isExpanded: true })),
  );
  hydrateProRoomYouTubeManifests({ playlist } as ProRoomSnapshot);
  initPlaylistView();
  await vi.dynamicImportSettled();
  updatePlaylistUI();
  for (let batch = 0; batch < 5; batch++) await nextAnimationFrame();
  for (const { queueItemId, ids } of manifests) {
    const selector = `.sub-playlist[data-queue-item-id="${queueItemId}"]`;
    const rows = document.querySelectorAll<HTMLElement>(`${selector} [data-video-id]`);
    expect(Array.from(rows, (element) => element.dataset.videoId)).toEqual(ids);
    updateSubItemTitle(proYouTubeSubItemsKey(queueItemId), 1, `${queueItemId} title`);
    expect(document.querySelector(`${selector} [data-sub-index="1"] .sub-name`)?.textContent).toBe(
      `${queueItemId} title`,
    );
  }
});

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
    await vi.dynamicImportSettled();
    updatePlaylistUI();

    setLanguageMode('en');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const empty = document.querySelector<HTMLElement>('.list-empty-state');
    expect(empty?.textContent).toBe('No media yet');
  });
});

describe('playlist title marquee markup', () => {
  it('keeps one measurable title child for parent and sub-track labels', () => {
    setState('playlist.items', sampleItems());
    setState('youtube.subItemsMap', {
      PL_TEST: { ids: ['abcdefghijk'], titles: ['A long resolved sub-track title'] },
    });
    updatePlaylistUI();

    const parent = document.querySelector<HTMLElement>(
      `[data-queue-item-id="${FILE_A}"] .track-name-text`,
    );
    const sub = document.querySelector<HTMLElement>('.sub-track-item .sub-name');
    expect(parent?.children).toHaveLength(1);
    expect(parent?.dir).toBe('auto');
    expect(parent?.firstElementChild?.classList).toContain('playlist-title-marquee-content');
    expect(parent?.textContent).toBe('A');
    expect(sub?.children).toHaveLength(1);
    expect(sub?.dir).toBe('auto');
    expect(sub?.firstElementChild?.classList).toContain('playlist-title-marquee-content');
    expect(sub?.textContent).toBe('A long resolved sub-track title');
  });

  it('preserves the single marquee child when a lazy sub-track title is patched', () => {
    setState('playlist.items', sampleItems());
    setState('youtube.subItemsMap', {
      PL_TEST: { ids: ['abcdefghijk'], titles: ['Initial'] },
    });
    initPlaylistView();

    updateSubItemTitle('PL_TEST', 0, 'Resolved without rebuilding the row');

    const sub = document.querySelector<HTMLElement>('.sub-track-item .sub-name');
    expect(sub?.children).toHaveLength(1);
    expect(sub?.dir).toBe('auto');
    expect(sub?.firstElementChild?.classList).toContain('playlist-title-marquee-content');
    expect(sub?.textContent).toBe('Resolved without rebuilding the row');
  });

  it('remeasures only the mounted title changed by a background title update', async () => {
    const ids = Array.from(
      { length: 240 },
      (_, index) => `video-${String(index).padStart(4, '0')}`,
    );
    setState('playlist.items', sampleItems());
    setState('youtube.subItemsMap', {
      PL_TEST: { ids, titles: [] },
    });
    initPlaylistView();
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect(playlistTitleMarqueeMocks.schedule).toHaveBeenCalled());
    playlistTitleMarqueeMocks.schedule.mockClear();

    updateSubItemTitle('PL_TEST', 137, 'Resolved title 137');

    await vi.waitFor(() => {
      const batches = playlistTitleMarqueeMocks.schedule.mock.calls
        .map(([root]) => root)
        .filter((root): root is HTMLElement[] => Array.isArray(root));
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);
      expect(batches[0]?.[0]?.closest<HTMLElement>('.sub-track-item')?.dataset.subIndex).toBe(
        '137',
      );
    });
  });
});

describe('PRO upload rows', () => {
  it('renders active uploads as compact file rows with icon-only cancel controls', async () => {
    const progressReporter: { current?: (fraction: number) => void } = {};
    proRoomUploadQueue = new ProRoomUploadQueue({
      createId: vi.fn().mockReturnValueOnce(FILE_A).mockReturnValueOnce(YT_B),
      run: async (_input, context) => {
        progressReporter.current ??= context.onProgress;
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          });
        });
      },
    });
    setActiveProRoomUploadQueue(proRoomUploadQueue);
    initPlaylistView();
    await vi.dynamicImportSettled();

    proRoomUploadQueue.enqueueFiles([new File(['a'], 'one.flac'), new File(['bb'], 'two.flac')]);
    await nextAnimationFrame();

    const entries = document.querySelectorAll<HTMLElement>('.pro-upload-entry');
    expect(entries).toHaveLength(2);
    expect(document.querySelector('.list-empty-state')).toBeNull();
    expect(entries[0]?.dataset.queueItemId).toBeUndefined();
    expect(entries[0]?.dataset.proUploadId).toBe(FILE_A);
    expect(entries[0]?.querySelector('.pro-upload-name')?.textContent).toBe('one.flac');
    expect(entries[0]?.querySelector('.track-idx')).toBeNull();
    expect(entries[1]?.querySelector('.track-idx')).toBeNull();
    expect(entries[0]?.classList).toContain('is-uploading');
    expect(entries[1]?.classList).toContain('is-waiting');
    for (const entry of entries) {
      const track = entry.querySelector<HTMLElement>('.pro-upload-track');
      const spinner = entry.querySelector<HTMLElement>(
        '.material-elastic-spinner.pro-upload-spinner',
      );
      expect(track).not.toBeNull();
      expect(spinner).not.toBeNull();
      expect(spinner?.classList).toContain('playlist-row-spinner');
      expect(spinner?.parentElement).toBe(entry.querySelector('.track-leading'));
      expect(track?.firstElementChild).toBe(entry.querySelector('.pro-upload-name'));
      expect(track?.childElementCount).toBe(1);
      expect(spinner?.getAttribute('aria-hidden')).toBe('true');
      expect(spinner?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 44 44');
      expect(spinner?.querySelector('circle')?.getAttribute('cx')).toBe('22');
      expect(spinner?.querySelector('circle')?.getAttribute('cy')).toBe('22');
      expect(spinner?.querySelector('circle')?.getAttribute('r')).toBe('18');
      expect(spinner?.querySelector('circle')?.getAttribute('pathLength')).toBe('100');
      // The phase is `-(now % period)`; a zero remainder renders as `0ms`, not `-0ms`.
      expect(spinner?.style.getPropertyValue('--material-elastic-spin-delay')).toMatch(/^-?\d+ms$/);
      expect(spinner?.style.getPropertyValue('--material-elastic-dash-delay')).toMatch(/^-?\d+ms$/);
      expect(entry.querySelector('.type-icon')).toBeNull();
      const row = entry.querySelector('.pro-upload-row');
      expect(row?.lastElementChild).toBe(entry.querySelector('[data-pro-upload-action="cancel"]'));
    }
    expect(entries[0]?.querySelector('.pro-upload-leading')).toBeNull();
    expect(entries[0]?.querySelector('.pro-upload-status')).toBeNull();
    expect(entries[0]?.querySelector('.pro-upload-progress')).toBeNull();

    const cancel = entries[0]?.querySelector<HTMLButtonElement>(
      '[data-pro-upload-action="cancel"]',
    );
    expect(cancel?.classList).toContain('btn-playlist-remove');
    expect(cancel?.textContent).toBe('');
    expect(cancel?.disabled).toBe(false);
    expect(cancel?.hasAttribute('aria-disabled')).toBe(false);
    expect(cancel?.getAttribute('aria-label')).toBe(
      t('pro.upload.cancel_file', { name: 'one.flac' }),
    );
    expect(cancel?.title).toBe(t('pro.upload.cancel_file', { name: 'one.flac' }));
    cancel?.focus();
    progressReporter.current?.(0.37);
    await nextAnimationFrame();

    const replacementCancel = document.querySelector<HTMLButtonElement>(
      `[data-pro-upload-id="${FILE_A}"] [data-pro-upload-action="cancel"]`,
    );
    expect(document.activeElement).toBe(replacementCancel);
    expect(document.querySelector('.pro-upload-status')).toBeNull();
    expect(document.querySelector('.pro-upload-progress')).toBeNull();

    progressReporter.current?.(1);
    await nextAnimationFrame();
    const confirming = document.querySelector<HTMLElement>(
      `[data-pro-upload-id="${FILE_A}"].is-confirming`,
    );
    expect(confirming).not.toBeNull();
    expect(
      confirming?.querySelector('.material-elastic-spinner.pro-upload-spinner'),
    ).not.toBeNull();
    const confirmingCancel = confirming?.querySelector<HTMLButtonElement>(
      '[data-pro-upload-action="cancel"]',
    );
    expect(confirmingCancel).not.toBeNull();
    expect(confirmingCancel?.disabled).toBe(true);
    expect(confirmingCancel?.tabIndex).toBe(-1);
    expect(confirmingCancel?.getAttribute('aria-disabled')).toBe('true');
    expect(confirmingCancel?.getAttribute('aria-label')).toBe(
      t('pro.upload.confirming_file', { name: 'one.flac' }),
    );
    expect(confirmingCancel?.title).toBe(t('pro.upload.confirming_file', { name: 'one.flac' }));
    const confirmingRow = confirming?.querySelector<HTMLElement>('.track-item');
    expect(confirmingRow).not.toBeNull();
    expect(confirmingRow?.lastElementChild).toBe(confirmingCancel);
    expect(confirmingRow?.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(confirmingRow);
    const cancelSpy = vi.spyOn(proRoomUploadQueue, 'cancel');
    confirmingCancel?.click();
    expect(cancelSpy).not.toHaveBeenCalled();

    const stylesheet = await readFile('css/style.css', 'utf8');
    expect(stylesheet).not.toContain('.pro-upload-progress');
    expect(stylesheet).not.toContain('.pro-upload-status');
    expect(stylesheet).not.toContain('.pro-upload-entry .track-idx');
    expect(stylesheet).toContain('.pro-upload-name');
    const rowRules = stylesheet.match(/\.track-item\s*\{([^}]*)\}/)?.[1] ?? '';
    const trackNameRules = stylesheet.match(/^\s*\.track-name\s*\{([^}]*)\}/m)?.[1] ?? '';
    const uploadNameRules = stylesheet.match(/\.pro-upload-name\s*\{([^}]*)\}/)?.[1] ?? '';
    const rowSpinnerRules = stylesheet.match(/\.playlist-row-spinner\s*\{([^}]*)\}/)?.[1] ?? '';
    const uploadSpinnerRules = stylesheet.match(/\.pro-upload-spinner\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rowRules).toContain('--playlist-indicator-color: var(--text-muted)');
    expect(trackNameRules).toContain('color: var(--text-main)');
    expect(uploadNameRules).toContain('color: var(--text-muted)');
    expect(rowSpinnerRules).toContain('color: var(--playlist-indicator-color, currentColor)');
    expect(uploadSpinnerRules).not.toContain('color: var(--primary)');
    expect(stylesheet).not.toMatch(/\.pro-upload-name\s*\{[^}]*opacity:/s);
    expect(stylesheet).not.toContain('.pro-upload-cancel:not(:disabled)');
    expect(stylesheet).toContain('.pro-upload-cancel:disabled');
    expect(stylesheet).toContain('opacity: 0.32');
    expect(stylesheet).toContain(
      '.track-item:focus-within .btn-playlist-remove:not(.is-selected):not(:disabled)',
    );
    expect(stylesheet).toContain('.btn-playlist-remove:not(:disabled):hover');
    expect(stylesheet).not.toMatch(/\.btn-playlist-remove:hover\s*\{/);
  });

  it('keeps the elastic head/tail phase continuous when an upload row is rebuilt', async () => {
    const performanceNow = vi.spyOn(performance, 'now');
    try {
      performanceNow.mockReturnValue(2000);
      proRoomUploadQueue = new ProRoomUploadQueue({
        createId: vi.fn().mockReturnValue(FILE_A),
        run: async (_input, context) => {
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), {
              once: true,
            });
          });
        },
      });
      setActiveProRoomUploadQueue(proRoomUploadQueue);
      initPlaylistView();
      await vi.dynamicImportSettled();
      proRoomUploadQueue.enqueueFiles([new File(['a'], 'continuous.flac')]);
      await nextAnimationFrame();

      const first = document.querySelector<HTMLElement>('.pro-upload-spinner');
      expect(first?.style.getPropertyValue('--material-elastic-spin-delay')).toBe('-150ms');
      expect(first?.style.getPropertyValue('--material-elastic-dash-delay')).toBe('-550ms');

      performanceNow.mockReturnValue(2200);
      updatePlaylistUI();
      const replacement = document.querySelector<HTMLElement>('.pro-upload-spinner');
      expect(replacement).not.toBe(first);
      expect(replacement?.style.getPropertyValue('--material-elastic-spin-delay')).toBe('-350ms');
      expect(replacement?.style.getPropertyValue('--material-elastic-dash-delay')).toBe('-750ms');
    } finally {
      performanceNow.mockRestore();
    }
  });

  it('hides failed uploads and restores the empty state for batch-level failure handling', async () => {
    let attempts = 0;
    proRoomUploadQueue = new ProRoomUploadQueue({
      createId: () => FILE_A,
      run: async () => {
        attempts += 1;
        throw new Error('network');
      },
    });
    setActiveProRoomUploadQueue(proRoomUploadQueue);
    initPlaylistView();
    await vi.dynamicImportSettled();
    proRoomUploadQueue.enqueueFiles([new File(['a'], 'one.flac')]);
    await proRoomUploadQueue.whenIdle();
    await nextAnimationFrame();

    expect(attempts).toBe(1);
    expect(document.querySelector('.pro-upload-entry')).toBeNull();
    expect(document.querySelector('[data-pro-upload-action="retry"]')).toBeNull();
    expect(document.querySelector('[data-pro-upload-action="remove"]')).toBeNull();
    expect(document.querySelector('.list-empty-state')?.textContent).toBe(t('playlist.empty_hint'));
    expect(proRoomUploadQueue.rows[0]?.phase).toBe('failed');
  });

  it('moves focus to the playlist panel when a focused upload fails beside existing tracks', async () => {
    let rejectUpload: ((reason?: unknown) => void) | undefined;
    proRoomUploadQueue = new ProRoomUploadQueue({
      createId: () => '00000000-0000-4000-8000-000000000003',
      run: () =>
        new Promise<void>((_resolve, reject) => {
          rejectUpload = reject;
        }),
    });
    setActiveProRoomUploadQueue(proRoomUploadQueue);
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();
    proRoomUploadQueue.enqueueFiles([new File(['a'], 'one.flac')]);
    await nextAnimationFrame();

    const cancel = document.querySelector<HTMLButtonElement>('[data-pro-upload-action="cancel"]')!;
    cancel.focus();
    expect(document.activeElement).toBe(cancel);

    rejectUpload?.(new Error('network'));
    await proRoomUploadQueue.whenIdle();
    await nextAnimationFrame();

    expect(document.querySelector('.pro-upload-entry')).toBeNull();
    expect(document.activeElement).toBe(document.getElementById('tab-playlist'));
  });

  it('never renders a completed temporary row beside its authoritative playlist row', async () => {
    proRoomUploadQueue = new ProRoomUploadQueue({
      createId: () => FILE_A,
      run: async (_input, context) => {
        context.onProgress(1);
        setState('playlist.items', [
          {
            queueItemId: FILE_A,
            type: 'file',
            name: 'one.flac',
            videoId: null,
            playlistId: null,
          },
        ]);
      },
    });
    setActiveProRoomUploadQueue(proRoomUploadQueue);
    initPlaylistView();
    await vi.dynamicImportSettled();
    proRoomUploadQueue.enqueueFiles([new File(['a'], 'one.flac')]);
    await proRoomUploadQueue.whenIdle();
    await nextAnimationFrame();

    expect(document.querySelectorAll('.playlist-entry')).toHaveLength(1);
    expect(document.querySelector('.pro-upload-entry')).toBeNull();
    expect(
      document.querySelector(`[data-queue-item-id="${FILE_A}"] .track-name-text`)?.textContent,
    ).toBe('one');
  });

  it('settles a failed temporary row when a later snapshot confirms the same queue item', async () => {
    proRoomUploadQueue = new ProRoomUploadQueue({
      createId: () => FILE_A,
      run: async () => {
        throw new Error('ambiguous append');
      },
    });
    setActiveProRoomUploadQueue(proRoomUploadQueue);
    initPlaylistView();
    await vi.dynamicImportSettled();
    proRoomUploadQueue.enqueueFiles([new File(['a'], 'one.flac')]);
    await proRoomUploadQueue.whenIdle();
    await nextAnimationFrame();
    expect(document.querySelector('.pro-upload-entry')).toBeNull();
    expect(document.querySelector('.list-empty-state')).not.toBeNull();
    expect(proRoomUploadQueue.rows[0]?.phase).toBe('failed');

    setState('playlist.items', [
      {
        queueItemId: FILE_A,
        type: 'file',
        name: 'one.flac',
        videoId: null,
        playlistId: null,
      },
    ]);
    await nextAnimationFrame();

    expect(document.querySelectorAll('.playlist-entry')).toHaveLength(1);
    expect(document.querySelector('.pro-upload-entry')).toBeNull();
    expect(proRoomUploadQueue.rows).toEqual([]);
  });
});

describe('playlist queue identity rendering and actions', () => {
  it('restores focus to the same queue action after a full rerender', () => {
    setState('playlist.items', sampleItems());
    updatePlaylistUI();

    const expand = document.querySelector<HTMLButtonElement>(
      `[data-queue-item-id="${YT_B}"][data-action="expand"]`,
    )!;
    expand.focus();
    expect(document.activeElement).toBe(expand);

    updatePlaylistUI();

    const replacement = document.querySelector<HTMLButtonElement>(
      `[data-queue-item-id="${YT_B}"][data-action="expand"]`,
    );
    expect(replacement).not.toBe(expand);
    expect(document.activeElement).toBe(replacement);
  });

  it('does not rebuild every row for play/pause activity changes', async () => {
    setState('playlist.items', sampleItems());
    setState('playlist.currentQueueItemId', FILE_A);
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    initPlaylistView();
    await vi.dynamicImportSettled();
    const list = document.getElementById('playlist-ui')!;
    const replaceChildren = vi.spyOn(list, 'replaceChildren');
    const currentLeading = list.querySelector<HTMLElement>('.playlist-current-leading')!;

    expect(currentLeading.classList).toContain('is-current-paused');
    // The state stands in for the source icon; the row keeps its number.
    expect(currentLeading.classList).toContain('track-type-slot');
    expect(currentLeading.closest('.track-name')).not.toBeNull();
    expect(currentLeading.querySelector('.type-icon')).not.toBeNull();
    expect(currentLeading.closest('.track-item')?.querySelector('.track-idx')?.textContent).toBe(
      '1',
    );
    expect(list.querySelector('.track-leading .track-playback-state-icon')).toBeNull();
    expect(currentLeading.querySelector('.track-playing-indicator path')?.getAttribute('d')).toBe(
      'M8 5v14l11-7z',
    );
    expect(
      currentLeading.querySelector('.track-playing-indicator path')?.getAttribute('transform'),
    ).toBe('translate(-1.5 0)');
    expect(currentLeading.querySelector('.track-paused-indicator path')?.getAttribute('d')).toBe(
      'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    );
    expect(list.querySelectorAll('.playlist-current-leading')).toHaveLength(1);

    setState('playback.activity', 'playing');
    await nextAnimationFrame();
    expect(replaceChildren).not.toHaveBeenCalled();
    expect(currentLeading.classList).toContain('is-current-playing');
    expect(currentLeading.classList).not.toContain('is-current-paused');

    setState('playback.mode', 'youtube');
    await nextAnimationFrame();
    expect(replaceChildren).not.toHaveBeenCalled();

    setState('playback.mode', 'system-audio');
    await nextAnimationFrame();
    expect(replaceChildren).toHaveBeenCalledOnce();
  });

  it('mirrors the main play spinner and keeps loading above play/pause state', async () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<button id="play-btn" class="is-loading" aria-busy="true"></button>',
    );
    setState('playlist.items', sampleItems());
    setState('playlist.currentQueueItemId', FILE_A);
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    initPlaylistView();
    await vi.dynamicImportSettled();

    const list = document.getElementById('playlist-ui')!;
    const replaceChildren = vi.spyOn(list, 'replaceChildren');
    const currentLeading = list.querySelector<HTMLElement>('.playlist-current-leading')!;
    expect(currentLeading.classList).toContain('is-current-loading');
    expect(currentLeading.classList).not.toContain('is-current-paused');
    expect(currentLeading.querySelector('.track-playback-loading-indicator')).not.toBeNull();

    bus.emit('ui:play-loading-state', false);
    expect(currentLeading.classList).not.toContain('is-current-loading');
    expect(currentLeading.classList).toContain('is-current-paused');

    bus.emit('ui:play-loading-state', true);
    setState('playback.activity', 'playing');
    await nextAnimationFrame();
    expect(currentLeading.classList).toContain('is-current-loading');
    expect(currentLeading.classList).not.toContain('is-current-playing');

    bus.emit('ui:play-loading-state', false);
    expect(currentLeading.classList).not.toContain('is-current-loading');
    expect(currentLeading.classList).toContain('is-current-playing');
    expect(replaceChildren).not.toHaveBeenCalled();
  });

  it('uses the shared Material Elastic SVG contract for playlist playback loading', async () => {
    setState('playlist.items', sampleItems());
    setState('playlist.currentQueueItemId', FILE_A);
    setState('playback.mode', 'file');
    initPlaylistView();
    await vi.dynamicImportSettled();

    const spinner = document.querySelector<HTMLElement>(
      '.track-playback-loading-indicator.material-elastic-spinner',
    );
    expect(spinner).not.toBeNull();
    expect(spinner?.classList).toContain('playlist-row-spinner');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(spinner?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 44 44');
    expect(spinner?.querySelector('circle')?.getAttribute('cx')).toBe('22');
    expect(spinner?.querySelector('circle')?.getAttribute('cy')).toBe('22');
    expect(spinner?.querySelector('circle')?.getAttribute('r')).toBe('18');
    expect(spinner?.querySelector('circle')?.getAttribute('pathLength')).toBe('100');
    const stylesheet = await readFile('css/style.css', 'utf8');
    const activeRowRules = stylesheet.match(/\.track-item\.active\s*\{([^}]*)\}/)?.[1] ?? '';
    const playbackIconRules =
      stylesheet.match(/\.track-playback-state-icon\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(activeRowRules).toContain('--playlist-indicator-color: var(--primary)');
    expect(playbackIconRules).toContain('color: var(--playlist-indicator-color, currentColor)');
    expect(playbackIconRules).not.toContain('color: var(--primary)');
  });

  it('uses Material Elastic for every remaining indeterminate spinner and keeps the header text-only', async () => {
    const [stylesheet, systemAudioStylesheet, markup] = await Promise.all([
      readFile('css/style.css', 'utf8'),
      readFile('css/playback-actions.css', 'utf8'),
      readFile('index.html', 'utf8'),
    ]);
    const parsed = new DOMParser().parseFromString(markup, 'text/html');

    for (const selector of [
      '#play-btn .play-loading-spinner.material-elastic-spinner',
      '#youtube-sync-loading-overlay .youtube-sync-loading-spinner.material-elastic-spinner',
      '.demo-play-button .demo-loading-spinner.material-elastic-spinner',
      '#btn-system-audio .system-audio-loading-spinner.material-elastic-spinner',
    ]) {
      const spinner = parsed.querySelector(selector);
      expect(spinner, selector).not.toBeNull();
      expect(spinner?.getAttribute('aria-hidden')).toBe('true');
      expect(spinner?.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 44 44');
      expect(spinner?.querySelector('circle')?.getAttribute('r')).toBe('18');
      expect(spinner?.querySelector('circle')?.getAttribute('pathLength')).toBe('100');
    }

    expect(stylesheet).toContain('animation: material-elastic-spin 1.85s linear infinite');
    expect(stylesheet).toContain('animation: material-elastic-dash 1.45s ease-in-out infinite');
    expect(stylesheet).toContain('animation-delay: var(--material-elastic-spin-delay, 0ms)');
    expect(stylesheet).toContain('animation-delay: var(--material-elastic-dash-delay, 0ms)');
    expect(stylesheet).toContain('@keyframes material-elastic-spin');
    expect(stylesheet).toContain('@keyframes material-elastic-dash');
    expect(stylesheet).toContain('stroke-linecap: butt');
    expect(stylesheet).toContain('stroke-dasharray: 74 26');
    expect(stylesheet).toContain('stroke-dasharray: 2 98');
    expect(stylesheet).toContain('stroke-dashoffset: -100');
    expect(stylesheet).toMatch(
      /\.material-elastic-spinner > svg\s*\{[^}]*animation:\s*material-elastic-spin/s,
    );
    expect(stylesheet).not.toMatch(
      /\.material-elastic-spinner\s*\{[^}]*animation:\s*material-elastic-spin/s,
    );
    expect(stylesheet).toMatch(/\.play-loading-spinner\s*\{[^}]*--material-elastic-size:\s*26px;/);
    expect(systemAudioStylesheet).toMatch(
      /body\.mode-system-audio #play-btn\.is-loading\s*\{[^}]*opacity:\s*1\s*!important;/,
    );
    expect(stylesheet).toMatch(
      /\.track-playback-loading-indicator\s*\{[^}]*--material-elastic-size:\s*16px;/,
    );
    expect(stylesheet).toMatch(/\.pro-upload-spinner\s*\{[^}]*--material-elastic-size:\s*16px;/);
    expect(parsed.querySelector('#main-header .material-elastic-spinner')).toBeNull();
    expect(
      parsed.querySelector('#header-loading-text .header-loading-text-content'),
    ).not.toBeNull();
    expect(stylesheet).toMatch(
      /\.track-playback-loading-indicator > svg\s*\{[^}]*display:\s*none;/,
    );
    expect(stylesheet).toMatch(
      /\.playlist-current-leading\.is-current-loading \.track-playback-loading-indicator > svg\s*\{[^}]*display:\s*block;/,
    );
    expect(stylesheet).not.toContain('@keyframes yt-spin');
    expect(stylesheet).not.toContain('@keyframes track-playback-spin');
    expect(stylesheet).not.toContain('@keyframes pro-system-audio-spin');
    expect(parsed.querySelector('#header-progress-bg')).not.toBeNull();
    expect(parsed.querySelector('#seek-slider')).not.toBeNull();
  });

  it('patches the current ordinal from YouTube play-state events without rebuilding rows', () => {
    setState('playlist.items', sampleItems());
    setState('playlist.currentQueueItemId', YT_B);
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    initPlaylistView();
    const list = document.getElementById('playlist-ui')!;
    const replaceChildren = vi.spyOn(list, 'replaceChildren');
    const currentLeading = list.querySelector<HTMLElement>('.playlist-current-leading')!;

    bus.emit('ui:update-play-state', false);
    expect(replaceChildren).not.toHaveBeenCalled();
    expect(currentLeading.classList).toContain('is-current-paused');
    expect(currentLeading.classList).not.toContain('is-current-playing');

    bus.emit('ui:update-play-state', true);
    expect(replaceChildren).not.toHaveBeenCalled();
    expect(currentLeading.classList).toContain('is-current-playing');
    expect(currentLeading.classList).not.toContain('is-current-paused');
  });

  it('replaces the active YouTube sub-index with the shared playback state icons', () => {
    setState('playlist.items', sampleItems());
    setState('youtube.subItemsMap', {
      PL_TEST: { ids: ['video-a', 'video-b'], titles: ['First', 'Loading title'] },
    });
    setState('playlist.currentQueueItemId', YT_B);
    setState('youtube.currentSubIndex', 1);
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    initPlaylistView();

    const inactive = document.querySelector<HTMLElement>('.sub-track-item[data-sub-index="0"]')!;
    const active = document.querySelector<HTMLElement>('.sub-track-item[data-sub-index="1"]')!;
    const leading = active.querySelector<HTMLElement>('.sub-idx.playlist-current-leading')!;

    expect(inactive.hasAttribute('aria-current')).toBe(false);
    expect(active.getAttribute('aria-current')).toBe('true');
    expect(active.hasAttribute('aria-label')).toBe(false);
    expect(leading.querySelector('.sub-idx-number')?.textContent).toBe('2');
    expect(leading.querySelector('.track-playing-indicator')).not.toBeNull();
    expect(leading.classList).toContain('is-current-playing');

    bus.emit('ui:update-play-state', false);
    expect(leading.classList).toContain('is-current-paused');
    expect(leading.classList).not.toContain('is-current-playing');

    bus.emit('ui:play-loading-state', true);
    expect(leading.classList).toContain('is-current-loading');
    expect(leading.classList).not.toContain('is-current-paused');

    updateSubItemTitle('PL_TEST', 1, 'Resolved title');
    expect(active.textContent).toContain('Resolved title');
    expect(active.textContent).toContain('2');
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

  it('uses a blue glyph-only hover for playlist disclosure while preserving its state', async () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();

    const expanded = document.querySelector<HTMLButtonElement>(
      `.expand-toggle[data-queue-item-id="${YT_B}"]`,
    )!;
    expect(expanded.getAttribute('aria-expanded')).toBe('true');

    const stylesheet = await readFile('css/style.css', 'utf8');
    const hoverRules = stylesheet.match(/\.expand-toggle:hover\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(hoverRules).toContain('background: transparent');
    expect(hoverRules).toContain('color: var(--primary)');
    expect(stylesheet).not.toMatch(/\.expand-toggle:hover\s*,\s*\.device-expand-toggle:hover/);
  });

  it('exposes each main track action as a native keyboard button', () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    const play = vi.fn();
    bus.on('playlist:play-track', play);

    const trackAction = document.querySelector<HTMLButtonElement>(
      `.track-name[data-queue-item-id="${FILE_A}"]`,
    );
    expect(trackAction).toBeInstanceOf(HTMLButtonElement);
    expect(trackAction?.type).toBe('button');
    expect(trackAction?.tabIndex).toBe(0);

    trackAction?.click();
    expect(play).toHaveBeenCalledWith(FILE_A, undefined, { explicitPlaybackIntent: true });
  });

  it('renders a huge sub-playlist progressively and patches title-only updates in place', async () => {
    const ids = Array.from(
      { length: 1_000 },
      (_, index) => `video-${String(index).padStart(4, '0')}`,
    );
    setState('playlist.items', sampleItems());
    setState('youtube.subItemsMap', {
      PL_TEST: { ids, titles: [] },
    });
    initPlaylistView();

    const list = document.getElementById('playlist-ui')!;
    const replaceChildren = vi.spyOn(list, 'replaceChildren');
    expect(document.querySelectorAll('.sub-track-item[data-sub-index]')).toHaveLength(240);

    updateSubItemTitle('PL_TEST', 10, 'Resolved title');
    updateSubItemTitle('PL_TEST', 900, 'Late resolved title');
    expect(
      document.querySelector<HTMLElement>('.sub-track-item[data-sub-index="10"] .sub-name')
        ?.textContent,
    ).toBe('Resolved title');
    expect(replaceChildren).not.toHaveBeenCalled();

    for (let frame = 0; frame < 5; frame += 1) await nextAnimationFrame();
    expect(document.querySelectorAll('.sub-track-item[data-sub-index]')).toHaveLength(1_000);
    expect(
      document.querySelector<HTMLElement>('.sub-track-item[data-sub-index="900"] .sub-name')
        ?.textContent,
    ).toBe('Late resolved title');
    expect(document.querySelector('.sub-playlist')?.hasAttribute('aria-busy')).toBe(false);
  });

  it.each(['restore', 'focus', 'pointer', 'hidden', 'rerender', 'consecutive', 'reorder'])(
    'owns progressive sub-row focus through %s',
    async (intent) => {
      const ids = Array.from(
        { length: 1_000 },
        (_, index) => `video-${String(index).padStart(4, '0')}`,
      );
      setState('playlist.items', sampleItems());
      setState('youtube.subItemsMap', { PL_TEST: { ids, titles: [] } });
      initPlaylistView();
      for (let frame = 0; frame < 5; frame += 1) await nextAnimationFrame();
      if (intent === 'reorder') {
        const handle = document.querySelector<HTMLElement>('.playlist-reorder-handle')!;
        handle.focus();
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(handle.getAttribute('aria-grabbed')).toBe('true');
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      document.querySelector<HTMLElement>('.sub-track-item[data-sub-index="900"]')!.focus();
      updatePlaylistUI();
      expect(document.querySelectorAll('.sub-track-item[data-sub-index]')).toHaveLength(240);
      const otherControl = document.createElement('button');
      document.body.appendChild(otherControl);
      if (intent === 'focus') otherControl.focus();
      if (intent === 'pointer')
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      if (intent === 'hidden') document.getElementById('tab-playlist')!.classList.remove('active');
      if (intent === 'rerender') {
        document.querySelector<HTMLElement>('.sub-track-item[data-sub-index="10"]')!.focus();
        updatePlaylistUI();
      }
      if (intent === 'consecutive') {
        await nextAnimationFrame();
        expect(document.querySelector('.sub-track-item[data-sub-index="900"]')).toBeNull();
        expect(document.activeElement).toBe(document.body);
        updatePlaylistUI();
      }
      for (let frame = 0; frame < 5; frame += 1) await nextAnimationFrame();
      expect(document.querySelectorAll('.sub-track-item[data-sub-index]')).toHaveLength(1_000);
      if (['restore', 'rerender', 'consecutive', 'reorder'].includes(intent)) {
        expect((document.activeElement as HTMLElement).dataset.subIndex).toBe(
          intent === 'rerender' ? '10' : '900',
        );
      } else {
        expect(document.activeElement).toBe(intent === 'focus' ? otherControl : document.body);
      }
    },
  );

  it('measures only the newly appended titles in each progressive batch', async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    let nextFrameId = 1;
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frameCallbacks.push(callback);
        return nextFrameId++;
      });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    try {
      const ids = Array.from(
        { length: 720 },
        (_, index) => `video-${String(index).padStart(4, '0')}`,
      );
      setState('playlist.items', sampleItems());
      setState('youtube.subItemsMap', {
        PL_TEST: { ids, titles: [] },
      });
      updatePlaylistUI();

      await vi.waitFor(() => expect(playlistTitleMarqueeMocks.schedule).toHaveBeenCalled());
      playlistTitleMarqueeMocks.schedule.mockClear();

      while (
        document.querySelectorAll('.sub-track-item[data-sub-index]').length < 480 &&
        frameCallbacks.length
      ) {
        frameCallbacks.shift()?.(16);
      }
      await vi.waitFor(() => {
        const batches = playlistTitleMarqueeMocks.schedule.mock.calls
          .map(([root]) => root)
          .filter((root): root is HTMLElement[] => Array.isArray(root));
        expect(batches).toHaveLength(1);
        expect(batches[0]).toHaveLength(240);
        expect(batches[0]?.[0]?.closest<HTMLElement>('.sub-track-item')?.dataset.subIndex).toBe(
          '240',
        );
        expect(batches[0]?.at(-1)?.closest<HTMLElement>('.sub-track-item')?.dataset.subIndex).toBe(
          '479',
        );
      });

      playlistTitleMarqueeMocks.schedule.mockClear();
      while (
        document.querySelectorAll('.sub-track-item[data-sub-index]').length < 720 &&
        frameCallbacks.length
      ) {
        frameCallbacks.shift()?.(32);
      }
      await vi.waitFor(() => {
        const batches = playlistTitleMarqueeMocks.schedule.mock.calls
          .map(([root]) => root)
          .filter((root): root is HTMLElement[] => Array.isArray(root));
        expect(batches).toHaveLength(1);
        expect(batches[0]).toHaveLength(240);
        expect(batches[0]?.[0]?.closest<HTMLElement>('.sub-track-item')?.dataset.subIndex).toBe(
          '480',
        );
        expect(batches[0]?.at(-1)?.closest<HTMLElement>('.sub-track-item')?.dataset.subIndex).toBe(
          '719',
        );
      });
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
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
    expect(document.querySelectorAll('.btn-playlist-select')).toHaveLength(2);
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
    await vi.dynamicImportSettled();
    const list = document.getElementById('playlist-ui')!;
    const replaceChildren = vi.spyOn(list, 'replaceChildren');

    document
      .querySelector<HTMLButtonElement>(`.btn-playlist-select[data-queue-item-id="${FILE_A}"]`)!
      .click();
    setState('room.context', { ...context, snapshotRevision: 2 });
    await nextAnimationFrame();

    expect(replaceChildren).not.toHaveBeenCalled();
    expect(selectionBarVisible()).toBe(true);
    expect(
      document
        .querySelector(`.btn-playlist-select[data-queue-item-id="${FILE_A}"]`)
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
    await vi.dynamicImportSettled();

    document.querySelector<HTMLButtonElement>('.btn-playlist-select')!.click();
    setState('room.context', { ...context, snapshotRevision: 2, capabilities: [] });
    expect(selectionBarVisible()).toBe(false);

    setState('room.context', { ...context, snapshotRevision: 3 });
    await nextAnimationFrame();
    document.querySelector<HTMLButtonElement>('.btn-playlist-select')!.click();
    setState('room.context', { ...context, epoch: 2, snapshotRevision: 4 });
    expect(selectionBarVisible()).toBe(false);

    setState('room.context', { ...context, epoch: 2, snapshotRevision: 5 });
    await nextAnimationFrame();
    document.querySelector<HTMLButtonElement>('.btn-playlist-select')!.click();
    setState('room.context', { ...context, roomId: '000002', snapshotRevision: 1 });

    expect(selectionBarVisible()).toBe(false);
  });

  it('keeps an active PRO reorder mounted through revision-only context pulses', async () => {
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
    await vi.dynamicImportSettled();
    // The reorder controller loads after the list mounts.
    await vi.dynamicImportSettled();

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

  it('restores queue grips when the host account sibling projection arrives', async () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'host' } as DataConnection);
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();

    expect(document.querySelectorAll('.playlist-reorder-handle')).toHaveLength(0);
    expect(document.querySelectorAll('.btn-playlist-select')).toHaveLength(0);

    // OPERATOR_GRANT applies the explicit projection before the compatibility
    // isOperator flag. The scheduled render must converge after both fields.
    setState('network.standardRoomCapabilities', [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES]);
    setState('network.isOperator', true);
    await nextAnimationFrame();
    expect(document.querySelectorAll('.playlist-reorder-handle')).not.toHaveLength(0);
    expect(document.querySelectorAll('.btn-playlist-select')).not.toHaveLength(0);

    setState('network.standardRoomCapabilities', null);
    setState('network.isOperator', false);
    await nextAnimationFrame();
    expect(document.querySelectorAll('.playlist-reorder-handle')).toHaveLength(0);
    expect(document.querySelectorAll('.btn-playlist-select')).toHaveLength(0);
    expect(selectionBarVisible()).toBe(false);
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

  it('delegates play, select, expansion, and sub-seek actions by queueItemId', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const items = sampleItems();
      items[1] = { ...items[1], isExpanded: false };
      setState('playlist.items', items);
      setState('youtube.subItemsMap', {
        PL_TEST: { ids: ['video-a'], titles: ['First'] },
      });
      initPlaylistView();
      await vi.dynamicImportSettled();

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
      expect(play).toHaveBeenCalledWith(FILE_A, undefined, { explicitPlaybackIntent: true });

      document
        .querySelector<HTMLElement>(`[data-action="expand"][data-queue-item-id="${YT_B}"]`)!
        .click();
      expect(populate).toHaveBeenCalledWith('PL_TEST', YT_B);
      document.querySelector<HTMLElement>('.sub-track-item[data-sub-index="0"]')!.click();
      expect(subSeek).toHaveBeenCalledWith(YT_B, 0, false);

      const removeButton = document.querySelector<HTMLButtonElement>(
        `[data-action="select"][data-queue-item-id="${FILE_A}"]`,
      )!;
      removeButton.click();
      expect(removeButton.getAttribute('aria-pressed')).toBe('true');
      expect(selectionBarVisible()).toBe(true);
      expect(remove).not.toHaveBeenCalled();

      document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
      expect(remove).toHaveBeenCalledWith([FILE_A]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts a select minus after each title that enters edit mode for its own row', async () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();

    const row = document.querySelector<HTMLElement>(`.track-item[data-queue-item-id="${FILE_A}"]`)!;
    const check = row.querySelector<HTMLButtonElement>('.btn-playlist-select')!;
    expect(row.lastElementChild).toBe(check);
    expect(row.querySelector('.btn-playlist-remove')).toBeNull();
    expect(check.previousElementSibling?.classList.contains('track-name')).toBe(true);
    expect(
      check.querySelector('svg[aria-hidden="true"] path.playlist-select-minus')?.getAttribute('d'),
    ).toBe('M7 12h10');
    // The language list's check mark, shown once the row is selected.
    expect(check.querySelector('path.playlist-select-mark')?.getAttribute('d')).toBe(
      'M5 12.5l4.2 4.2L19 6.9',
    );
    expect(check.getAttribute('aria-pressed')).toBe('false');
    expect(check.title).toBe(t('playlist.select_for_deletion', { title: 'A' }));

    check.click();
    expect(check.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('playlist-ui')!.classList).toContain('has-removal-selection');
    expect(check.closest('.playlist-entry')!.classList).toContain('is-removal-selected');
    expect(selectionBarVisible()).toBe(true);
  });

  it('marks selected entries so consecutive ones join into one block', async () => {
    const ids = [1, 2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-00000000010${n}`);
    setState(
      'playlist.items',
      ids.map((queueItemId, index) => ({
        queueItemId,
        type: 'file' as const,
        name: `${index + 1}.mp3`,
        title: `Track ${index + 1}`,
        videoId: null,
        playlistId: null,
      })),
    );
    initPlaylistView();
    await vi.dynamicImportSettled();
    for (const index of [0, 1, 3]) clickSelect(ids[index]!);
    const selectedEntries = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('#playlist-ui > .playlist-entry'),
        (entry) => entry.classList.contains('is-removal-selected'),
      );
    expect(selectedEntries()).toEqual([true, true, false, true, false]);
    // A re-render keeps the marks.
    updatePlaylistUI();
    expect(selectedEntries()).toEqual([true, true, false, true, false]);

    // Rows 1-2 form one block with the pill's top and bottom corners; row 4
    // is its own pill. The 8px gap between joined rows is filled square.
    const stylesheet = await readFile('css/style.css', 'utf8');
    const rule = (selector: string) =>
      stylesheet.match(
        new RegExp(`${selector.replace(/[.+()]/g, '\\$&')}\\s*\\{([^}]*)\\}`),
      )?.[1] ?? '';
    const sel = '.playlist-entry.is-removal-selected';
    expect(rule(`${sel}::before`)).toContain('background: var(--control-active)');
    expect(stylesheet).toContain('--playlist-fill-radius: calc(var(--list-row-height) / 2);');
    const base = rule('.playlist-entry::before');
    expect(base).toContain('--fill-top-radius: var(--playlist-fill-radius)');
    expect(base).toContain('--fill-bottom-radius: var(--playlist-fill-radius)');
    expect(base).toMatch(
      /border-radius: var\(--fill-top-radius\) var\(--fill-top-radius\) var\(--fill-bottom-radius\)\s+var\(--fill-bottom-radius\)/,
    );
    expect(rule(`${sel}:has(+ ${sel})::before`)).toContain('--fill-bottom-radius: 0px');
    expect(rule(`${sel} + ${sel}::before`)).toContain('--fill-top-radius: 0px');
    expect(rule(`${sel} + ${sel}::before`)).toContain('top: -8px');

    // Reshaping is drawn by the morph layer: the rows' own fills change shape
    // in place (only their color fades) and hide while it runs.
    expect(base).toContain('transition: background-color 0.16s ease;');
    expect(rule('.playlist-ul.is-fill-morphing > .playlist-entry::before')).toContain('opacity: 0');
    expect(stylesheet).toMatch(
      /\.playlist-fill-morph > \* \{[^}]*border-radius: calc\(var\(--list-row-height\) \/ 2\);/,
    );
  });

  it('folds YouTube playlists in edit mode and keeps each expansion for afterwards', async () => {
    const items = [
      ...sampleItems(),
      {
        queueItemId: '00000000-0000-4000-8000-000000000003',
        type: 'youtube' as const,
        name: 'Closed list',
        title: 'Closed list',
        videoId: 'abcdefghijl',
        playlistId: 'PL_CLOSED',
        isExpanded: false,
      },
    ];
    setState('playlist.items', items);
    setState('youtube.subItemsMap', { PL_TEST: { ids: ['video-a'], titles: ['First'] } });
    initPlaylistView();
    await vi.dynamicImportSettled();
    const list = document.getElementById('playlist-ui')!;
    const expansion = () =>
      Array.from(list.querySelectorAll<HTMLElement>('.expand-toggle'), (toggle) =>
        toggle.getAttribute('aria-expanded'),
      );
    expect(expansion()).toEqual(['true', 'false']);
    expect(list.querySelectorAll('.sub-playlist')).toHaveLength(1);

    clickSelect(FILE_A);
    expect(list.classList).toContain('has-removal-selection');
    const stylesheet = await readFile('css/style.css', 'utf8');
    expect(stylesheet).toMatch(
      /\.playlist-ul\.has-removal-selection \.sub-playlist,\s*\.playlist-ul\.has-removal-selection \.expand-toggle\s*\{\s*display: none;/,
    );

    document.querySelector<HTMLButtonElement>('[data-selection-action="cancel"]')!.click();
    expect(list.classList).not.toContain('has-removal-selection');
    expect(expansion()).toEqual(['true', 'false']);
    expect(list.querySelectorAll('.sub-playlist')).toHaveLength(1);
  });

  it('uses the row check circles as stable multi-selection toggles', async () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();

    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.btn-playlist-select'),
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
    expect(selectionTitle()).toBe(t('playlist.selected_count', { count: 2 }));

    buttons[0]!.click();
    expect(selectionTitle()).toBe(t('playlist.selected_count', { count: 1 }));
    expect(selectionBarVisible()).toBe(true);

    buttons[1]!.click();
    expect(selectionBarVisible()).toBe(false);
    expect(selectionTitle()).toBeNull();
  });

  it('turns the header into the selected count with one select-all text toggle', async () => {
    setLanguageMode('en');
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();
    const header = document.querySelector<HTMLElement>('#tab-playlist .tab-header')!;
    const toggle = header.querySelector<HTMLButtonElement>('.playlist-selection-toggle')!;
    const live = header.querySelector<HTMLElement>('.playlist-selection-title')!;

    expect(header.classList.contains('is-removal-selecting')).toBe(false);
    expect(toggle.hidden).toBe(true);
    expect(live.hidden).toBe(true);
    expect(live.getAttribute('aria-live')).toBe('polite');

    clickSelect(FILE_A);
    expect(header.classList.contains('is-removal-selecting')).toBe(true);
    expect(live.textContent).toBe('1 selected');
    expect(toggle.hidden).toBe(false);
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.textContent).toBe('Select all (2)');
    expect(header.querySelectorAll('.playlist-selection-toggle')).toHaveLength(1);
    // The tab's icon actions stay in the DOM; CSS hides them in this mode.
    expect(header.querySelector('#btn-add-media')).not.toBeNull();

    clickSelect(YT_B);
    expect(live.textContent).toBe('2 selected');
    expect(toggle.textContent).toBe('Deselect all');

    const bar = document.querySelector<HTMLElement>('.playlist-selection-bar')!;
    const deleteButton = bar.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!;
    const cancelButton = bar.querySelector<HTMLButtonElement>('[data-selection-action="cancel"]')!;
    expect(bar.getAttribute('role')).toBe('group');
    // Icon buttons: a trash can and a close mark, named and titled by the
    // shared Delete and Cancel strings.
    expect(deleteButton.textContent?.trim()).toBe('');
    expect(deleteButton.getAttribute('aria-label')).toBe('Delete');
    expect(deleteButton.title).toBe('Delete');
    expect(deleteButton.querySelector('svg[aria-hidden="true"] path')).not.toBeNull();
    expect(cancelButton.getAttribute('aria-label')).toBe('Cancel');
    expect(cancelButton.title).toBe('Cancel');
    expect(cancelButton.querySelector('svg[aria-hidden="true"] path')).not.toBeNull();
    expect(cancelButton.hidden).toBe(false);
  });

  it('cancels selection with Escape and disables reorder controls only while active', async () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();
    const removeButton = document.querySelector<HTMLButtonElement>('.btn-playlist-select')!;
    const handles = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.playlist-reorder-handle'),
    );

    removeButton.click();
    expect(document.querySelector('.playlist-selection-bar')?.getAttribute('role')).toBe('group');
    expect(handles.every((handle) => handle.disabled)).toBe(true);
    expect(handles.every((handle) => !handle.hasAttribute('aria-keyshortcuts'))).toBe(true);

    removeButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(removeButton.getAttribute('aria-pressed')).toBe('false');
    expect(selectionBarVisible()).toBe(false);
    expect(handles.every((handle) => !handle.disabled)).toBe(true);
    expect(handles.every((handle) => handle.hasAttribute('aria-keyshortcuts'))).toBe(true);

    removeButton.click();
    document
      .querySelector<HTMLButtonElement>('.playlist-selection-toggle')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(selectionBarVisible()).toBe(false);
  });

  it('selects every live row, then ends deletion mode from Deselect all', async () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();
    const remove = vi.fn();
    bus.on('playlist:remove-tracks', remove);

    clickSelect(FILE_A);
    const toggle = document.querySelector<HTMLButtonElement>('.playlist-selection-toggle')!;
    expect(toggle.dataset.selectionAction).toBe('select-all');
    expect(toggle.textContent).toBe(`${t('playlist.select_all')} (2)`);
    toggle.click();

    expect(
      Array.from(document.querySelectorAll('.btn-playlist-select')).map((button) =>
        button.getAttribute('aria-pressed'),
      ),
    ).toEqual(['true', 'true']);
    expect(toggle.dataset.selectionAction).toBe('deselect-all');
    expect(toggle.textContent).toBe(t('playlist.deselect_all'));
    expect(selectionTitle()).toBe(t('playlist.selected_count', { count: 2 }));

    toggle.click();
    expect(remove).not.toHaveBeenCalled();
    expect(selectionBarVisible()).toBe(false);
    expect(toggle.hidden).toBe(true);
    expect(
      Array.from(document.querySelectorAll('.btn-playlist-select')).map((button) =>
        button.getAttribute('aria-pressed'),
      ),
    ).toEqual(['false', 'false']);
  });

  it('clears selection and closes the pills from the explicit cancel action', async () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();
    const remove = vi.fn();
    bus.on('playlist:remove-tracks', remove);

    clickSelect(FILE_A);
    const cancelButton = document.querySelector<HTMLButtonElement>(
      '[data-selection-action="cancel"]',
    )!;
    expect(cancelButton.getAttribute('aria-label')).toBe(t('common.cancel'));
    cancelButton.click();

    expect(remove).not.toHaveBeenCalled();
    expect(selectionBarVisible()).toBe(false);
    expect(
      Array.from(document.querySelectorAll('.btn-playlist-select')).map((button) =>
        button.getAttribute('aria-pressed'),
      ),
    ).toEqual(['false', 'false']);
  });

  it('ends deletion mode on a tap outside the track list but not on its own controls', async () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();

    clickSelect(FILE_A);
    document.querySelector<HTMLButtonElement>('.playlist-selection-toggle')!.click();
    expect(selectionTitle()).toBe(t('playlist.selected_count', { count: 2 }));
    // Rows and the list itself keep the mode.
    document.getElementById('playlist-ui')!.click();
    clickSelect(YT_B);
    expect(selectionTitle()).toBe(t('playlist.selected_count', { count: 1 }));

    document.querySelector<HTMLElement>('#tab-playlist .tab-title[data-i18n]')!.click();
    expect(selectionBarVisible()).toBe(false);

    clickSelect(FILE_A);
    document.querySelector<HTMLElement>('.tab-body')!.click();
    expect(selectionBarVisible()).toBe(false);

    clickSelect(FILE_A);
    document.querySelector<HTMLButtonElement>('.bottom-nav .nav-item')!.click();
    expect(selectionBarVisible()).toBe(false);
  });

  it.each([false, true])('ends deletion mode on a tab change (desktop: %s)', async (desktop) => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({ matches: desktop && query === '(min-width: 1280px)' })),
    });
    try {
      setState('playlist.items', sampleItems());
      initPlaylistView();
      await vi.dynamicImportSettled();
      clickSelect(FILE_A);
      expect(selectionBarVisible()).toBe(true);

      bus.emit('ui:tab-changed', 'playlist');
      expect(selectionBarVisible()).toBe(true);

      if (!desktop) document.getElementById('tab-playlist')!.classList.remove('active');
      bus.emit('ui:tab-changed', 'chat');
      expect(selectionBarVisible()).toBe(false);
      expect(selectionTitle()).toBeNull();
    } finally {
      if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('deletes non-contiguous selections at once in playlist order and tells only this device', async () => {
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
    await vi.dynamicImportSettled();
    const remove = vi.fn((ids: string[]) =>
      setState(
        'playlist.items',
        getState('playlist.items').filter((item) => !ids.includes(item.queueItemId)),
      ),
    );
    const toast = vi.fn();
    bus.on('playlist:remove-tracks', remove);
    bus.on('ui:show-toast', toast);

    clickSelect(FILE_A);
    clickSelect(third.queueItemId);
    document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([FILE_A, third.queueItemId]);
    expect(renderedQueueIds()).toEqual([YT_B]);
    expect(selectionTitle()).toBeNull();
    expect(selectionBarVisible()).toBe(false);
    expect(document.querySelector('[data-selection-action="undo"]')).toBeNull();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(t('toast.deleted_tracks', { count: 2 }));
    expect(t('toast.deleted_tracks', { count: 2 })).toBe('트랙 2개를 삭제했어요');
  });

  it('does not report a deletion the host refused', async () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();
    const remove = vi.fn();
    const toast = vi.fn();
    bus.on('playlist:remove-tracks', remove);
    bus.on('ui:show-toast', toast);

    clickSelect(FILE_A);
    document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();

    expect(remove).toHaveBeenCalledWith([FILE_A]);
    // The host applies removals synchronously, so a refused one stays listed.
    expect(renderedQueueIds()).toEqual([FILE_A, YT_B]);
    updatePlaylistUI();
    expect(toast).not.toHaveBeenCalled();
  });

  function joinProRoomAsMediaManager(): void {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'coordinator' } as DataConnection);
    setState('room.context', {
      kind: 'pro' as const,
      roomId: '000001',
      role: 'member' as const,
      coordinatorId: 'coordinator',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: ['queue.mutate' as const],
    });
  }

  it('keeps a remote deletion hidden until the authoritative snapshot drops it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      joinProRoomAsMediaManager();
      const third: PlaylistItem = {
        queueItemId: '00000000-0000-4000-8000-000000000003',
        type: 'file',
        name: 'c.mp3',
        title: 'C',
        videoId: null,
        playlistId: null,
      };
      const items = [...sampleItems(), third];
      setState('playlist.items', items);
      initPlaylistView();
      await vi.dynamicImportSettled();
      const remove = vi.fn();
      const toast = vi.fn();
      bus.on('playlist:remove-tracks', remove);
      bus.on('ui:show-toast', toast);

      clickSelect(FILE_A);
      clickSelect(third.queueItemId);
      document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
      expect(remove).toHaveBeenCalledWith([FILE_A, third.queueItemId]);
      expect(renderedQueueIds()).toEqual([YT_B]);
      // One visible row cannot be reordered, even though three are canonical.
      expect(document.querySelectorAll('.playlist-reorder-handle')).toHaveLength(0);
      // Survivors are numbered as they appear.
      expect(document.querySelector('.track-idx')?.textContent).toBe('1');
      bus.emit('i18n:changed', 'ko');
      updatePlaylistUI();
      expect(renderedQueueIds()).toEqual([YT_B]);
      expect(toast).not.toHaveBeenCalled();

      setState('playlist.items', [items[1]!]);
      updatePlaylistUI();
      expect(renderedQueueIds()).toEqual([YT_B]);
      expect(toast).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledWith(t('toast.deleted_tracks', { count: 2 }));
      vi.advanceTimersByTime(10_000);
      expect(toast).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a rejected or lost remote deletion its rows back without a toast', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      joinProRoomAsMediaManager();
      setState('playlist.items', sampleItems());
      initPlaylistView();
      await vi.dynamicImportSettled();
      const toast = vi.fn();
      bus.on('ui:show-toast', toast);

      clickSelect(FILE_A);
      document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
      expect(renderedQueueIds()).toEqual([YT_B]);
      vi.advanceTimersByTime(9_999);
      expect(renderedQueueIds()).toEqual([YT_B]);
      vi.advanceTimersByTime(1);
      expect(renderedQueueIds()).toEqual([FILE_A, YT_B]);
      expect(toast).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report a remote deletion settled after the room is gone', async () => {
    joinProRoomAsMediaManager();
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();
    const toast = vi.fn();
    bus.on('ui:show-toast', toast);

    clickSelect(FILE_A);
    document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
    setState('room.context', { ...getState('room.context'), capabilities: [] });
    setState('playlist.items', []);
    updatePlaylistUI();
    expect(toast).not.toHaveBeenCalled();
  });

  it('keeps selection attached to queueItemId across rerenders and prunes lost authority', async () => {
    const items = sampleItems();
    setState('playlist.items', items);
    initPlaylistView();
    await vi.dynamicImportSettled();
    document
      .querySelector<HTMLButtonElement>(`.btn-playlist-select[data-queue-item-id="${FILE_A}"]`)!
      .click();

    setState('playlist.items', [items[1]!, items[0]!]);
    updatePlaylistUI();
    expect(
      document
        .querySelector(`.btn-playlist-select[data-queue-item-id="${FILE_A}"]`)
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    setState('network.hostConn', { open: true, peer: 'host' } as DataConnection);
    updatePlaylistUI();
    expect(document.querySelectorAll('.btn-playlist-select')).toHaveLength(0);
    expect(selectionBarVisible()).toBe(false);
  });

  it('keeps desktop deletion selection across track advance and prunes only removed rows', async () => {
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
      await vi.dynamicImportSettled();

      for (const queueItemId of [FILE_A, YT_B]) clickSelect(queueItemId);

      // Sequential playback advances without a tab switch.
      setState('playlist.currentQueueItemId', YT_B);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      expect(selectionTitle()).toBe(t('playlist.selected_count', { count: 2 }));
      expect(
        document
          .querySelector(`.btn-playlist-select[data-queue-item-id="${FILE_A}"]`)
          ?.getAttribute('aria-pressed'),
      ).toBe('true');

      setState('playlist.items', [items[1]!]);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(selectionTitle()).toBe(t('playlist.selected_count', { count: 1 }));
      expect(
        document
          .querySelector(`.btn-playlist-select[data-queue-item-id="${YT_B}"]`)
          ?.getAttribute('aria-pressed'),
      ).toBe('true');
      expect(selectionBarVisible()).toBe(true);

      setState('playlist.items', []);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(selectionBarVisible()).toBe(false);
    } finally {
      if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('does not recenter an unchanged current track when deletion selection is cancelled', async () => {
    setState('playlist.items', sampleItems());
    setState('playlist.currentQueueItemId', FILE_A);
    initPlaylistView();
    await vi.dynamicImportSettled();
    const scrollTo = configurePlaylistFollowLayout();
    await nextAnimationFrame();
    scrollTo.mockClear();

    document.querySelector<HTMLButtonElement>('.btn-playlist-select')!.click();
    document.querySelector<HTMLButtonElement>('[data-selection-action="cancel"]')!.click();
    await Promise.resolve();
    await nextAnimationFrame();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('resumes one pending desktop follow only after the setup entrance', async () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({ matches: query === DESKTOP_LAYOUT_QUERY })),
    });

    try {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div id="setup-overlay" class="active"></div>',
      );
      setState('playlist.items', sampleItems());
      setState('playlist.currentQueueItemId', YT_B);
      initPlaylistView();
      await vi.dynamicImportSettled();
      const scrollTo = configurePlaylistFollowLayout();
      await nextAnimationFrame();
      expect(scrollTo).not.toHaveBeenCalled();

      const scroller = document.querySelector<HTMLElement>('.tab-body')!;
      setState('setup.sessionStarted', true);
      await nextAnimationFrame();
      expect(scrollTo).not.toHaveBeenCalled();

      document.getElementById('setup-overlay')!.classList.remove('active');
      bus.emit('setup:app-entrance');
      await nextAnimationFrame();

      expect(scrollTo).toHaveBeenCalledOnce();
      expect(scrollTo).toHaveBeenCalledWith({ top: 170, behavior: 'smooth' });

      scroller.dispatchEvent(new Event('scrollend'));
      scroller.scrollTop = 0;
      bus.emit('setup:app-entrance');
      setState('playlist.items', [...sampleItems()]);
      await nextAnimationFrame();
      await nextAnimationFrame();

      expect(scrollTo).toHaveBeenCalledOnce();
      expect(scroller.scrollTop).toBe(0);
    } finally {
      if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('preserves manual scroll while a setup-blocked follow is only pending', async () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({ matches: query === DESKTOP_LAYOUT_QUERY })),
    });

    try {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div id="setup-overlay" class="active"></div>',
      );
      setState('playlist.items', sampleItems());
      setState('playlist.currentQueueItemId', YT_B);
      initPlaylistView();
      await vi.dynamicImportSettled();
      const scrollTo = configurePlaylistFollowLayout();
      await nextAnimationFrame();

      const scroller = document.querySelector<HTMLElement>('.tab-body')!;
      scroller.scrollTop = 60;
      setState('playlist.items', [...sampleItems()]);
      await nextAnimationFrame();
      await nextAnimationFrame();

      expect(scrollTo).not.toHaveBeenCalled();
      expect(scroller.scrollTop).toBe(60);
    } finally {
      if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('resumes a pending active-track follow after deletion selection ends', async () => {
    setState('playlist.items', sampleItems());
    setState('playlist.currentQueueItemId', FILE_A);
    initPlaylistView();
    await vi.dynamicImportSettled();
    configurePlaylistFollowLayout();
    await nextAnimationFrame();

    document.querySelector<HTMLButtonElement>('.btn-playlist-select')!.click();
    setState('playlist.currentQueueItemId', YT_B);
    await nextAnimationFrame();
    const scrollTo = configurePlaylistFollowLayout();

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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const items = sampleItems();
      setState('playlist.items', items);
      setState('playlist.currentQueueItemId', FILE_A);
      initPlaylistView();
      await vi.dynamicImportSettled();
      const scrollTo = configurePlaylistFollowLayout();
      await nextAnimationFrame();
      scrollTo.mockClear();
      bus.on('playlist:remove-tracks', () => setState('playlist.items', [items[0]!]));

      clickSelect(YT_B);
      const pill = document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!;
      pill.focus();
      pill.click();
      await Promise.resolve();
      await nextAnimationFrame();
      await Promise.resolve();

      expect(scrollTo).not.toHaveBeenCalled();
      expect((document.activeElement as HTMLElement | null)?.dataset.queueItemId).toBe(FILE_A);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not expose removal or reorder controls while system audio owns playback', () => {
    setState('playlist.items', sampleItems());
    setState('playback.mode', 'system-audio');
    initPlaylistView();

    expect(document.querySelectorAll('.btn-playlist-select')).toHaveLength(0);
    expect(document.querySelectorAll('.playlist-reorder-handle')).toHaveLength(0);
  });

  it('does not restore deletion focus into a playlist that became hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      setState('playlist.items', sampleItems());
      initPlaylistView();
      await vi.dynamicImportSettled();
      clickSelect(FILE_A);
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
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals all host handles when an add batch completes', async () => {
    setState('playlist.items', sampleItems());
    initPlaylistView();
    await vi.dynamicImportSettled();
    // The reorder controller loads after the list mounts.
    await vi.dynamicImportSettled();

    bus.emit('playlist:items-added', [YT_B]);

    expect(document.getElementById('playlist-ui')?.classList.contains('show-reorder-hints')).toBe(
      true,
    );
  });

  it('emits a reorder commit with stable IDs and the latest base revision', async () => {
    setState('playlist.items', sampleItems());
    setState('playlist.revision', 7);
    initPlaylistView();
    await vi.dynamicImportSettled();
    // The reorder controller loads after the list mounts.
    await vi.dynamicImportSettled();
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

  it('keeps the committed source handle mounted through its return fade before rendering', async () => {
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
      await vi.dynamicImportSettled();
      // The reorder controller loads after the list mounts.
      await vi.dynamicImportSettled();

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

describe('playlist interaction gate (RO-27)', () => {
  const FILE_B = '00000000-0000-4000-8000-0000000000b2';
  const FILE_C = '00000000-0000-4000-8000-0000000000c3';
  const FRAME_MS = 16;
  // A drop settles for 302 ms and its grip fades back for 172 ms; the render
  // that follows waits one more frame.
  const DROP_SETTLE_MS = 302 + 172 + FRAME_MS * 4;
  const LONG_PRESS_MS = 700;
  let restoreFrames: () => void = () => {};

  function threeFiles(): PlaylistItem[] {
    return [FILE_A, FILE_B, FILE_C].map((queueItemId, index) => ({
      queueItemId,
      type: 'file' as const,
      name: `${'abc'[index]}.mp3`,
      title: 'ABC'[index]!,
      videoId: null,
      playlistId: null,
    }));
  }

  function rowRect(top: number): DOMRect {
    return {
      x: 0,
      y: top,
      top,
      bottom: top + 48,
      left: 0,
      right: 300,
      width: 300,
      height: 48,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /** Rows sit 56px apart from the top of the viewport, in rendered order. */
  function layoutRows(): void {
    document.querySelectorAll<HTMLElement>('#playlist-ui .track-item').forEach((row, index) => {
      row.getBoundingClientRect = () => rowRect(index * 56);
    });
  }

  async function mount(items: PlaylistItem[] = threeFiles()): Promise<HTMLElement> {
    setState('playlist.items', items);
    initPlaylistView();
    await vi.dynamicImportSettled();
    // The reorder and removal controllers load after the list mounts.
    await vi.dynamicImportSettled();
    layoutRows();
    return document.getElementById('playlist-ui')!;
  }

  function pointer(target: Element, type: string, clientY: number): void {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: 20,
      clientY,
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      isPrimary: { value: true },
      pointerType: { value: 'mouse' },
    });
    target.dispatchEvent(event);
  }

  /** Hold a row's title still for the long press; returns the held element. */
  function longPress(queueItemId: string, clientY: number): HTMLElement {
    const title = document.querySelector<HTMLElement>(
      `.track-item[data-queue-item-id="${queueItemId}"] .track-name`,
    )!;
    pointer(title, 'pointerdown', clientY);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    return title;
  }

  function pressedIds(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('.btn-playlist-select[aria-pressed="true"]'),
      (button) => button.dataset.queueItemId ?? '',
    );
  }

  function liftedRow(): Element | null {
    return document.querySelector('.playlist-reorder-ghost');
  }

  function joinStandardRoomAsOperator(): void {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'host' } as DataConnection);
    setState('network.standardRoomCapabilities', [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES]);
    setState('network.isOperator', true);
  }

  function joinProRoomWithQueueEdit(): void {
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
  }

  /**
   * How each queue editor's own playlist answers a reorder and a deletion
   * before any reply: the Standard host commits both at once, a PRO member
   * shows its reorder through the optimistic overlay and waits for the
   * deletion, a Standard guest only sends requests.
   */
  const QUEUE_EDITORS = [
    {
      role: 'Standard host',
      join: () => {},
      reorderAppliesAtOnce: true,
      removalAppliesAtOnce: true,
    },
    {
      role: 'Standard guest with ADMIN',
      join: joinStandardRoomAsOperator,
      reorderAppliesAtOnce: false,
      removalAppliesAtOnce: false,
    },
    {
      role: 'PRO media manager',
      join: joinProRoomWithQueueEdit,
      reorderAppliesAtOnce: true,
      removalAppliesAtOnce: false,
    },
  ] as const;

  type QueueEditor = (typeof QUEUE_EDITORS)[number];

  /**
   * In edit mode with C selected, hold A, drop it before C and tap Delete
   * 100 ms into the drop settle.
   */
  async function deleteDuringDropSettle(editor: QueueEditor): Promise<void> {
    editor.join();
    const items = threeFiles();
    await mount(items);
    if (editor.reorderAppliesAtOnce) {
      bus.on('playlist:reorder-track', () =>
        setState('playlist.items', [items[1]!, items[0]!, items[2]!]),
      );
    }
    if (editor.removalAppliesAtOnce) {
      bus.on('playlist:remove-tracks', (ids: string[]) =>
        setState(
          'playlist.items',
          getState('playlist.items').filter((item) => !ids.includes(item.queueItemId)),
        ),
      );
    }
    clickSelect(FILE_C);
    const lifted = longPress(FILE_A, 20);
    pointer(lifted, 'pointermove', 80);
    pointer(lifted, 'pointerup', 80);
    vi.advanceTimersByTime(100);
    expect(document.querySelector('.playlist-reorder-settle')).not.toBeNull();
    expect(renderedQueueIds()).toEqual([FILE_B, FILE_A, FILE_C]);

    document.querySelector<HTMLButtonElement>('[data-selection-action="delete"]')!.click();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) =>
        window.setTimeout(() => callback(performance.now()), FRAME_MS),
      );
    const caf = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id) => window.clearTimeout(id));
    restoreFrames = () => {
      raf.mockRestore();
      caf.mockRestore();
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    restoreFrames();
    vi.useRealTimers();
  });

  it('starts selection from a hold outside edit mode and lifts the held row inside it', async () => {
    await mount();
    const reorder = vi.fn();
    bus.on('playlist:reorder-track', reorder);

    const held = longPress(FILE_A, 20);
    pointer(held, 'pointerup', 20);
    expect(pressedIds()).toEqual([FILE_A]);
    expect(selectionBarVisible()).toBe(true);
    expect(liftedRow()).toBeNull();

    const lifted = longPress(FILE_C, 132);
    expect(liftedRow()).not.toBeNull();
    pointer(lifted, 'pointermove', 10);
    pointer(lifted, 'pointerup', 10);
    expect(reorder).toHaveBeenCalledWith(FILE_C, FILE_A, 0);
    expect(pressedIds()).toEqual([FILE_A]);
  });

  it('defers renders while an edit-mode drag runs instead of dropping it', async () => {
    const list = await mount();
    const reorder = vi.fn();
    bus.on('playlist:reorder-track', reorder);
    clickSelect(FILE_A);
    const replaceChildren = vi.spyOn(list, 'replaceChildren');

    const lifted = longPress(FILE_C, 132);
    setState('playlist.currentQueueItemId', FILE_B);
    bus.emit('playlist:refresh-requested');
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(replaceChildren).not.toHaveBeenCalled();
    expect(liftedRow()).not.toBeNull();

    pointer(lifted, 'pointermove', 10);
    pointer(lifted, 'pointerup', 10);
    expect(reorder).toHaveBeenCalledWith(FILE_C, FILE_A, 0);
    expect(replaceChildren).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DROP_SETTLE_MS);
    expect(replaceChildren).toHaveBeenCalledTimes(1);
    expect(pressedIds()).toEqual([FILE_A]);
  });

  it('renders a playlist change that arrives during a drop settle once, when it ends', async () => {
    const list = await mount();
    const items = threeFiles();
    bus.on('playlist:reorder-track', () =>
      setState('playlist.items', [items[1]!, items[0]!, items[2]!]),
    );
    const replaceChildren = vi.spyOn(list, 'replaceChildren');

    const handle = list.querySelector<HTMLElement>('.playlist-reorder-handle')!;
    pointer(handle, 'pointerdown', 20);
    pointer(handle, 'pointermove', 80);
    pointer(handle, 'pointerup', 80);
    setState('playlist.items', [{ ...items[1]!, title: 'B renamed' }, items[0]!, items[2]!]);
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(replaceChildren).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DROP_SETTLE_MS);
    expect(replaceChildren).toHaveBeenCalledTimes(1);
    expect(renderedQueueIds()).toEqual([FILE_B, FILE_A, FILE_C]);
    expect(list.querySelector('.track-name-text')?.textContent).toBe('B renamed');
  });

  it.each([
    ['operator revocation', () => setState('network.isOperator', false)],
    ['capability revocation', () => setState('network.standardRoomCapabilities', [])],
    [
      'host connection replacement',
      () => setState('network.hostConn', { open: true, peer: 'host-2' } as DataConnection),
    ],
    ['session end', () => setState('network.appRole', 'idle')],
  ])('cancels the drag and the selection together on %s', async (_trigger, trigger) => {
    joinStandardRoomAsOperator();
    await mount();
    const reorder = vi.fn();
    bus.on('playlist:reorder-track', reorder);
    clickSelect(FILE_A);
    const lifted = longPress(FILE_C, 132);
    pointer(lifted, 'pointermove', 10);
    expect(liftedRow()).not.toBeNull();

    trigger();

    expect(liftedRow()).toBeNull();
    expect(selectionBarVisible()).toBe(false);
    pointer(lifted, 'pointerup', 10);
    expect(reorder).not.toHaveBeenCalled();
  });

  // Owner decision O4 (2026-10-23): Delete tapped during a drop settle
  // finishes the settle at once, then deletes, so the leaving rows go and the
  // survivors close up from where they are.
  it.each([
    { editor: QUEUE_EDITORS[0], rendered: [FILE_B, FILE_A] },
    // The host has not answered the reorder request yet, so this guest's
    // playlist still holds the order from before the drop.
    { editor: QUEUE_EDITORS[1], rendered: [FILE_A, FILE_B] },
    { editor: QUEUE_EDITORS[2], rendered: [FILE_B, FILE_A] },
  ])(
    'finishes a drop settle at once when Delete is tapped during it ($editor.role)',
    async ({ editor, rendered }) => {
      await deleteDuringDropSettle(editor);

      expect(document.querySelector('.playlist-reorder-settle')).toBeNull();
      expect(renderedQueueIds()).toEqual(rendered);
      expect(selectionBarVisible()).toBe(false);
      vi.advanceTimersByTime(DROP_SETTLE_MS);
      expect(renderedQueueIds()).toEqual(rendered);
    },
  );
});

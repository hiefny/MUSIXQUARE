/**
 * @vitest-environment jsdom
 */
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
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
    '<section id="tab-playlist" class="tab-content active" tabindex="-1"><div class="tab-body"><ul id="playlist-ui"></ul></div></section>';
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
    expect(parent?.firstElementChild?.classList).toContain('playlist-title-marquee-content');
    expect(parent?.textContent).toBe('A');
    expect(sub?.children).toHaveLength(1);
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
      expect(spinner?.style.getPropertyValue('--material-elastic-spin-delay')).toMatch(/^-\d+ms$/);
      expect(spinner?.style.getPropertyValue('--material-elastic-dash-delay')).toMatch(/^-\d+ms$/);
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
    const list = document.getElementById('playlist-ui')!;
    const replaceChildren = vi.spyOn(list, 'replaceChildren');
    const currentLeading = list.querySelector<HTMLElement>('.playlist-current-leading')!;

    expect(currentLeading.classList).toContain('is-current-paused');
    expect(currentLeading.querySelector('.track-idx')?.textContent).toBe('1');
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
      '<button id="play-btn" class="yt-syncing" aria-busy="true"></button>',
    );
    setState('playlist.items', sampleItems());
    setState('playlist.currentQueueItemId', FILE_A);
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    initPlaylistView();

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
    const [stylesheet, markup] = await Promise.all([
      readFile('css/style.css', 'utf8'),
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
    expect(play).toHaveBeenCalledWith(FILE_A);
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

  it('restores queue grips when the host account sibling projection arrives', async () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true, peer: 'host' } as DataConnection);
    setState('playlist.items', sampleItems());
    initPlaylistView();

    expect(document.querySelectorAll('.playlist-reorder-handle')).toHaveLength(0);
    expect(document.querySelectorAll('.btn-playlist-remove')).toHaveLength(0);

    // OPERATOR_GRANT applies the explicit projection before the compatibility
    // isOperator flag. The scheduled render must converge after both fields.
    setState('network.standardRoomCapabilities', [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES]);
    setState('network.isOperator', true);
    await nextAnimationFrame();
    expect(document.querySelectorAll('.playlist-reorder-handle')).not.toHaveLength(0);
    expect(document.querySelectorAll('.btn-playlist-remove')).not.toHaveLength(0);

    setState('network.standardRoomCapabilities', null);
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

  it('resumes one pending desktop follow only after the setup entrance', async () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({ matches: query === '(min-width: 1280px)' })),
    });

    try {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div id="setup-overlay" class="active"></div>',
      );
      setState('playlist.items', sampleItems());
      setState('playlist.currentQueueItemId', YT_B);
      initPlaylistView();
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
      value: vi.fn((query: string) => ({ matches: query === '(min-width: 1280px)' })),
    });

    try {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div id="setup-overlay" class="active"></div>',
      );
      setState('playlist.items', sampleItems());
      setState('playlist.currentQueueItemId', YT_B);
      initPlaylistView();
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
    configurePlaylistFollowLayout();
    await nextAnimationFrame();

    document.querySelector<HTMLButtonElement>('.btn-playlist-remove')!.click();
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

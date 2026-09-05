/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { setLanguageMode } from '../../i18n/index.ts';
import { bus } from '../../core/events.ts';
import { getState, setState } from '../../core/state.ts';
import * as peerState from '../../network/peer-state.ts';
import {
  cancelSubTitleFetch,
  clearPreviewDebounce,
  clearYouTubeInputState,
  extractYouTubeVideoId,
  extractYouTubePlaylistId,
  fetchYouTubePreview,
  fetchYouTubeSearchResults,
  fetchPlaylistSubTitles,
  getPrefetchedYouTubePlaylistManifest,
  getSelectedYouTubeSearchResult,
  getYouTubeInputIntent,
  isYouTubeLiveUrl,
  resolveYouTubePlaylistEntry,
  resolveYouTubePlaylistManifest,
  searchYouTubeFromInput,
} from '../search.ts';
import { fetchOEmbedTitle, fetchWithTimeout } from '../oembed.ts';
import { OEMBED_INITIAL_BATCH_SIZE } from '../constants.ts';

afterEach(() => {
  clearPreviewDebounce();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('YouTube playlist title batch completion', () => {
  const playlistId = 'PLauditTitleBatch';
  const ids = Array.from(
    { length: OEMBED_INITIAL_BATCH_SIZE + 2 },
    (_, index) => `video${index.toString().padStart(6, '0')}`,
  );
  const partialIndex = OEMBED_INITIAL_BATCH_SIZE;
  const lastIndex = ids.length - 1;

  afterEach(() => {
    cancelSubTitleFetch();
    setState('youtube.subItemsMap', {});
    vi.restoreAllMocks();
  });

  function prepareTitleFetch(
    responseForIndex: (index: number) => Response = (index) =>
      Response.json({ title: `Title ${index}` }),
  ) {
    vi.useFakeTimers();
    setState('network.hostConn', null);
    setState('youtube.currentSubIndex', 0);
    setState('youtube.subItemsMap', { [playlistId]: { ids: [...ids], titles: [] } });
    const broadcast = vi.spyOn(peerState, 'broadcast').mockImplementation(() => undefined);
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const target = new URL(new URL(String(input)).searchParams.get('url')!);
      return responseForIndex(ids.indexOf(target.searchParams.get('v')!));
    });
    vi.stubGlobal('fetch', fetch);
    return { broadcast, fetch };
  }

  it.each(['success', 'unavailable', 'empty-title', 'failure', 'already-known'] as const)(
    'flushes successful partial results when the final item is %s',
    async (ending) => {
      const { broadcast, fetch } = prepareTitleFetch((index) => {
        if (ending === 'already-known' && index === partialIndex) {
          const titles: string[] = [];
          titles[lastIndex] = 'Known final title';
          setState('youtube.subItemsMap', { [playlistId]: { ids: [...ids], titles } });
        }
        if (index === lastIndex) {
          if (ending === 'unavailable') return new Response('', { status: 404 });
          if (ending === 'empty-title') return Response.json({ title: '' });
          if (ending === 'failure') throw new Error('oEmbed unavailable');
        }
        return Response.json({ title: `Title ${index}` });
      });
      const pending = fetchPlaylistSubTitles(playlistId, ids);
      await vi.runAllTimersAsync();
      await pending;

      expect(getState('youtube.subItemsMap')[playlistId]?.titles[partialIndex]).toBe(
        `Title ${partialIndex}`,
      );
      expect(broadcast).toHaveBeenCalledWith({
        type: 'youtube-sub-title-update',
        playlistId,
        subIdx: partialIndex,
        title: `Title ${partialIndex}`,
      });
      expect(fetch).toHaveBeenCalledTimes(ids.length - (ending === 'already-known' ? 1 : 0));
    },
  );

  it.each(['cancelled', 'replaced', 'removed'] as const)(
    'does not flush buffered titles after their owner is %s',
    async (ending) => {
      const { broadcast } = prepareTitleFetch((index) => {
        if (index === lastIndex) {
          if (ending === 'cancelled') cancelSubTitleFetch();
          else if (ending === 'removed') setState('youtube.subItemsMap', {});
          else {
            setState('youtube.subItemsMap', {
              [playlistId]: { ids: ids.map(() => 'replacement'), titles: [] },
            });
          }
          return new Response('', { status: 404 });
        }
        return Response.json({ title: `Title ${index}` });
      });
      const pending = fetchPlaylistSubTitles(playlistId, ids);
      await vi.runAllTimersAsync();
      await pending;

      expect(getState('youtube.subItemsMap')[playlistId]?.titles[partialIndex]).toBeUndefined();
      expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ subIdx: partialIndex }));
    },
  );
});

describe('YouTube request lifetime', () => {
  it('settles at the deadline when fetch never returns response headers', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? null;
        return new Promise<Response>(() => undefined);
      }),
    );

    const pending = fetchWithTimeout('https://www.youtube.com/oembed', 1_000);
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'YOUTUBE_REQUEST_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('settles and cancels when response headers arrive but its body never progresses', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      }),
    );
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response));

    const boundedResponse = await fetchWithTimeout('https://www.youtube.com/oembed', 1_000);
    const body = boundedResponse.text();
    const rejection = expect(body).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'YOUTUBE_REQUEST_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('extractYouTubeVideoId', () => {
  it('extracts from standard watch URL', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('extracts from short URL', () => {
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from shorts URL', () => {
    expect(extractYouTubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from embed URL', () => {
    expect(extractYouTubeVideoId('https://youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from live URL', () => {
    expect(extractYouTubeVideoId('https://youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts when v= is not the first query param', () => {
    expect(extractYouTubeVideoId('https://youtube.com/watch?t=10&v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('extracts from URL with extra params', () => {
    expect(
      extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxx&index=1'),
    ).toBe('dQw4w9WgXcQ');
  });

  it('returns null for invalid URL', () => {
    expect(extractYouTubeVideoId('https://example.com')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractYouTubeVideoId('')).toBeNull();
  });

  it('returns null for non-YouTube URL', () => {
    expect(extractYouTubeVideoId('https://vimeo.com/123456')).toBeNull();
  });
});

describe('isYouTubeLiveUrl', () => {
  it('detects /live/ links', () => {
    expect(isYouTubeLiveUrl('https://youtube.com/live/dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeLiveUrl('https://www.youtube.com/live/dQw4w9WgXcQ?si=abc')).toBe(true);
  });

  it('does not treat ordinary watch links as live from URL alone', () => {
    expect(isYouTubeLiveUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
  });
});

describe('extractYouTubePlaylistId', () => {
  it('extracts playlist ID from list param', () => {
    expect(
      extractYouTubePlaylistId(
        'https://youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
      ),
    ).toBe('PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  });

  it('extracts playlist ID when combined with video', () => {
    expect(extractYouTubePlaylistId('https://youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest123')).toBe(
      'PLtest123',
    );
  });

  it('returns null when no list param', () => {
    expect(extractYouTubePlaylistId('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractYouTubePlaylistId('')).toBeNull();
  });
});

describe('getYouTubeInputIntent', () => {
  it('classifies a video URL', () => {
    expect(getYouTubeInputIntent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toMatchObject({
      kind: 'video-url',
      videoId: 'dQw4w9WgXcQ',
      playlistId: null,
      query: null,
    });
  });

  it('classifies a playlist URL', () => {
    expect(getYouTubeInputIntent('https://youtube.com/playlist?list=PLtest123')).toMatchObject({
      kind: 'playlist-url',
      videoId: null,
      playlistId: 'PLtest123',
      query: null,
    });
  });

  it('classifies plain text as a search query', () => {
    expect(getYouTubeInputIntent('  city pop   live  ')).toMatchObject({
      kind: 'search-query',
      query: 'city pop live',
    });
  });

  it('keeps non-YouTube URLs invalid instead of searching them', () => {
    expect(getYouTubeInputIntent('https://example.com/watch?v=dQw4w9WgXcQ')).toMatchObject({
      kind: 'invalid-url',
    });
  });
});

describe('YouTube input i18n state', () => {
  it('keeps dynamic status text translatable', () => {
    document.body.innerHTML = `
      <div id="youtube-preview"></div>
      <div id="youtube-preview-status"></div>
      <div id="youtube-search-results" role="group" aria-label="Search results"></div>
      <button id="youtube-play-btn"></button>
    `;
    setLanguageMode('ko');

    clearYouTubeInputState();

    const status = document.getElementById('youtube-preview-status');
    expect(status?.getAttribute('data-i18n')).toBe('youtube.enter_link_prompt');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-atomic')).toBe('true');

    setLanguageMode('en');

    expect(status?.textContent).toBe('Enter a YouTube search term or link');
  });
});

describe('YouTube search action state', () => {
  it('gates play until a result exists and keeps the dedicated search action retryable', async () => {
    document.body.innerHTML = `
      <div id="youtube-preview" hidden></div>
      <div id="youtube-preview-status"></div>
      <div id="youtube-search-results" role="group"></div>
      <button id="youtube-search-btn" disabled></button>
      <button id="youtube-play-btn" disabled></button>
    `;
    const searchButton = document.getElementById('youtube-search-btn') as HTMLButtonElement;
    const playButton = document.getElementById('youtube-play-btn') as HTMLButtonElement;
    let resolveSearch!: (response: Response) => void;
    const pendingSearch = new Promise<Response>((resolve) => {
      resolveSearch = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        if (url.includes('/api/youtube-search')) return pendingSearch;
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    fetchYouTubePreview('no result state probe 20260818');
    expect(searchButton.disabled).toBe(false);
    expect(playButton.disabled).toBe(true);

    const search = searchYouTubeFromInput('no result state probe 20260818');
    expect(searchButton.disabled).toBe(true);
    expect(searchButton.getAttribute('aria-busy')).toBe('true');
    expect(playButton.disabled).toBe(true);

    resolveSearch(Response.json({ results: [] }));
    await search;

    expect(searchButton.disabled).toBe(false);
    expect(searchButton.hasAttribute('aria-busy')).toBe(false);
    expect(playButton.disabled).toBe(true);
    expect(document.getElementById('youtube-preview-status')?.getAttribute('data-i18n')).toBe(
      'youtube.search_no_results',
    );

    fetchYouTubePreview('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    expect(searchButton.disabled).toBe(true);

    clearYouTubeInputState();
    document.body.innerHTML = '';
  });
});

describe('YouTube search result normalization', () => {
  // Exercise the response-hardening layer of normalizeSearchResults: the
  // proxy is trusted-ish, but defense-in-depth drops malformed rows, rejects
  // non-https thumbnails to block data:/javascript: if the backend ever drifts,
  // and rebuilds any URL that doesn't contain the
  // row's own videoId from the canonical watch URL.
  it('drops malformed rows and sanitizes thumbnail/url fields from the search proxy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        return Response.json({
          results: [
            'not-an-object',
            { videoId: 'tooShort', title: 'invalid id length — dropped' },
            {
              videoId: 'AAAAAAAAAAA',
              title: 'Valid &amp; Co',
              channelTitle: 'Chan',
              thumbnailUrl: 'http://i.ytimg.com/vi/AAAAAAAAAAA/insecure.jpg',
              url: 'https://evil.example/page-without-the-id',
            },
            {
              videoId: 'BBBBBBBBBBB',
              title: 'Keeps own url',
              channelTitle: 'Chan B',
              thumbnailUrl: 'https://i.ytimg.com/vi/BBBBBBBBBBB/mqdefault.jpg',
              url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB&t=10s',
            },
          ],
        });
      }),
    );

    const results = await fetchYouTubeSearchResults('normalize hardening probe 20260613');

    expect(results).toHaveLength(2);
    // http:// thumbnail rejected → '' (renderer falls back to canonical
    // mqdefault.jpg); foreign url without the videoId → canonical watch URL.
    expect(results[0]).toMatchObject({
      videoId: 'AAAAAAAAAAA',
      title: 'Valid & Co',
      thumbnailUrl: '',
      url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
    });
    // https thumbnail and an own-videoId url pass through untouched.
    expect(results[1]).toMatchObject({
      videoId: 'BBBBBBBBBBB',
      thumbnailUrl: 'https://i.ytimg.com/vi/BBBBBBBBBBB/mqdefault.jpg',
      url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB&t=10s',
    });
  });
});

describe('YouTube playlist entry resolution', () => {
  it('rejects invalid playlist IDs before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveYouTubePlaylistEntry('bad/id')).rejects.toThrow(
      'Invalid YouTube playlist ID',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts only a matching, concrete playlist entry from the protected proxy', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/security-config')) {
        return Response.json({ capabilityRequired: false });
      }
      expect(url).toContain('/api/youtube-playlist-entry?playlistId=PL_VALID_01');
      return Response.json({
        playlistId: 'PL_VALID_01',
        videoId: 'AAAAAAAAAAA',
        title: 'First &amp; playable',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveYouTubePlaylistEntry('PL_VALID_01')).resolves.toEqual({
      playlistId: 'PL_VALID_01',
      videoId: 'AAAAAAAAAAA',
      title: 'First & playable',
    });
  });

  it('rejects mismatched or expanded response shapes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        return Response.json({
          playlistId: 'PL_OTHER',
          videoId: 'AAAAAAAAAAA',
          title: 'First',
          unexpected: true,
        });
      }),
    );

    await expect(resolveYouTubePlaylistEntry('PL_EXPECTED')).rejects.toThrow(
      'Invalid YouTube playlist resolution response',
    );
  });
});

describe('YouTube playlist manifest resolution', () => {
  it('accepts a complete ordered manifest, including duplicate video IDs', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/security-config')) {
        return Response.json({ capabilityRequired: false });
      }
      expect(url).toContain('/api/youtube-playlist-manifest?playlistId=PL_MANIFEST_01');
      return Response.json({
        playlistId: 'PL_MANIFEST_01',
        videoId: 'AAAAAAAAAAA',
        videoIds: ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'BBBBBBBBBBB'],
        title: 'First &amp; playable',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveYouTubePlaylistManifest('PL_MANIFEST_01')).resolves.toEqual({
      playlistId: 'PL_MANIFEST_01',
      videoId: 'AAAAAAAAAAA',
      videoIds: ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'BBBBBBBBBBB'],
      title: 'First & playable',
    });
  });

  it.each([
    {
      playlistId: 'PL_MANIFEST_01',
      videoId: 'AAAAAAAAAAA',
      videoIds: [],
      title: 'First',
    },
    {
      playlistId: 'PL_MANIFEST_01',
      videoId: 'AAAAAAAAAAA',
      videoIds: ['BBBBBBBBBBB'],
      title: 'First',
    },
    {
      playlistId: 'PL_MANIFEST_01',
      videoId: 'AAAAAAAAAAA',
      videoIds: ['AAAAAAAAAAA', 'invalid'],
      title: 'First',
    },
    {
      playlistId: 'PL_OTHER',
      videoId: 'AAAAAAAAAAA',
      videoIds: ['AAAAAAAAAAA'],
      title: 'First',
    },
  ])('rejects an invalid manifest response %#', async (payload) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/security-config')
          ? Response.json({ capabilityRequired: false })
          : Response.json(payload),
      ),
    );

    await expect(resolveYouTubePlaylistManifest('PL_MANIFEST_01')).rejects.toThrow(
      'Invalid YouTube playlist manifest response',
    );
  });

  it('rejects manifests above the 5,000-video contract bound', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/security-config')
          ? Response.json({ capabilityRequired: false })
          : Response.json({
              playlistId: 'PL_MANIFEST_01',
              videoId: 'AAAAAAAAAAA',
              videoIds: Array.from({ length: 5_001 }, () => 'AAAAAAAAAAA'),
              title: 'First',
            }),
      ),
    );

    await expect(resolveYouTubePlaylistManifest('PL_MANIFEST_01')).rejects.toThrow(
      'Invalid YouTube playlist manifest response',
    );
  });

  it('rejects an oversized manifest without waiting for body cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/security-config')
          ? Response.json({ capabilityRequired: false })
          : (new Response(new ReadableStream<Uint8Array>({ cancel }), {
              headers: { 'content-length': String(256 * 1024 + 1) },
            }) as Response),
      ),
    );

    await expect(resolveYouTubePlaylistManifest('PL_MANIFEST_01')).rejects.toThrow(
      'CONTROL_RESPONSE_TOO_LARGE',
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('YouTube playlist manifest preview prefetch', () => {
  function mountYouTubePreview(): HTMLButtonElement {
    document.body.innerHTML = `
      <div id="youtube-preview" hidden></div>
      <div id="youtube-preview-status"></div>
      <img id="youtube-preview-thumb">
      <div id="youtube-preview-title"></div>
      <div id="youtube-preview-channel"></div>
      <div id="youtube-search-results"></div>
      <button id="youtube-play-btn"></button>
    `;
    return document.getElementById('youtube-play-btn') as HTMLButtonElement;
  }

  it('prefetches and synchronously exposes a playlist manifest before enabling play', async () => {
    vi.useFakeTimers();
    const playButton = mountYouTubePreview();
    const manifestRequests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        if (url.includes('/api/youtube-playlist-manifest')) {
          manifestRequests.push(url);
          return Response.json({
            playlistId: 'PL_PREVIEW_READY',
            videoId: 'AAAAAAAAAAA',
            videoIds: ['AAAAAAAAAAA', 'BBBBBBBBBBB'],
            title: 'Preview playlist',
          });
        }
        if (url.includes('youtube.com/oembed')) {
          return Response.json({
            title: 'Preview playlist',
            author_name: 'MUSIXQUARE',
            thumbnail_url: 'https://i.ytimg.com/vi/AAAAAAAAAAA/mqdefault.jpg',
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    fetchYouTubePreview('https://youtube.com/playlist?list=PL_PREVIEW_READY');
    expect(playButton.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(playButton.disabled).toBe(false);
    expect(manifestRequests).toHaveLength(1);

    const prefetched = getPrefetchedYouTubePlaylistManifest('PL_PREVIEW_READY');
    expect(prefetched).toEqual({
      playlistId: 'PL_PREVIEW_READY',
      videoId: 'AAAAAAAAAAA',
      videoIds: ['AAAAAAAAAAA', 'BBBBBBBBBBB'],
      title: 'Preview playlist',
    });

    prefetched!.videoIds[0] = 'CCCCCCCCCCC';
    expect(getPrefetchedYouTubePlaylistManifest('PL_PREVIEW_READY')?.videoIds[0]).toBe(
      'AAAAAAAAAAA',
    );
  });

  it('keeps a video-attached Mix URL on the immediate single-video preview path', async () => {
    vi.useFakeTimers();
    const playButton = mountYouTubePreview();
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url.includes('/api/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        if (url.includes('youtube.com/oembed')) {
          return Response.json({
            title: 'Mix-attached video',
            author_name: 'MUSIXQUARE',
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    fetchYouTubePreview('https://www.youtube.com/watch?v=AAAAAAAAAAA&list=RDAAAAAAAAAAA');
    await vi.advanceTimersByTimeAsync(500);

    expect(playButton.disabled).toBe(false);
    expect(requests.some((url) => url.includes('/api/youtube-playlist-manifest'))).toBe(false);
  });

  it('keeps play gated only for the bounded manifest budget, then permits iframe fallback', async () => {
    vi.useFakeTimers();
    const playButton = mountYouTubePreview();
    let resolveManifest!: (response: Response) => void;
    const pendingManifest = new Promise<Response>((resolve) => {
      resolveManifest = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        if (url.includes('/api/youtube-playlist-manifest')) return pendingManifest;
        if (url.includes('youtube.com/oembed')) {
          return Response.json({
            title: 'Slow manifest playlist',
            author_name: 'MUSIXQUARE',
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    fetchYouTubePreview('https://youtube.com/playlist?list=PL_PREVIEW_SLOW');
    await vi.advanceTimersByTimeAsync(500);
    expect(playButton.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(playButton.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(playButton.disabled).toBe(false);
    expect(getPrefetchedYouTubePlaylistManifest('PL_PREVIEW_SLOW')).toBeNull();

    resolveManifest(
      Response.json({
        playlistId: 'PL_PREVIEW_SLOW',
        videoId: 'AAAAAAAAAAA',
        videoIds: ['AAAAAAAAAAA'],
        title: 'Slow manifest playlist',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(getPrefetchedYouTubePlaylistManifest('PL_PREVIEW_SLOW')?.videoId).toBe('AAAAAAAAAAA');
  });

  it('drops a stale manifest when the URL changes before its prefetch resolves', async () => {
    vi.useFakeTimers();
    mountYouTubePreview();
    let resolveStaleManifest!: (response: Response) => void;
    const staleManifest = new Promise<Response>((resolve) => {
      resolveStaleManifest = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        if (url.includes('playlistId=PL_PREVIEW_STALE')) return staleManifest;
        if (url.includes('playlistId=PL_PREVIEW_CURRENT')) {
          return Response.json({
            playlistId: 'PL_PREVIEW_CURRENT',
            videoId: 'BBBBBBBBBBB',
            videoIds: ['BBBBBBBBBBB'],
            title: 'Current playlist',
          });
        }
        if (url.includes('youtube.com/oembed')) {
          return Response.json({ title: 'Playlist', author_name: 'MUSIXQUARE' });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    fetchYouTubePreview('https://youtube.com/playlist?list=PL_PREVIEW_STALE');
    await vi.advanceTimersByTimeAsync(500);
    fetchYouTubePreview('https://youtube.com/playlist?list=PL_PREVIEW_CURRENT');
    await vi.advanceTimersByTimeAsync(500);

    resolveStaleManifest(
      Response.json({
        playlistId: 'PL_PREVIEW_STALE',
        videoId: 'AAAAAAAAAAA',
        videoIds: ['AAAAAAAAAAA'],
        title: 'Stale playlist',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(getPrefetchedYouTubePlaylistManifest('PL_PREVIEW_STALE')).toBeNull();
    expect(getPrefetchedYouTubePlaylistManifest('PL_PREVIEW_CURRENT')?.videoId).toBe('BBBBBBBBBBB');
  });

  it('aborts an unfinished manifest prefetch when the preview overlay closes', async () => {
    vi.useFakeTimers();
    const playButton = mountYouTubePreview();
    const manifestRequest: { signal: AbortSignal | null } = { signal: null };
    let resolveManifest!: (response: Response) => void;
    const pendingManifest = new Promise<Response>((resolve) => {
      resolveManifest = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        if (url.includes('/api/youtube-playlist-manifest')) {
          manifestRequest.signal = init?.signal ?? null;
          return pendingManifest;
        }
        if (url.includes('youtube.com/oembed')) {
          return Response.json({ title: 'Closing playlist', author_name: 'MUSIXQUARE' });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    fetchYouTubePreview('https://youtube.com/playlist?list=PL_PREVIEW_CLOSED');
    await vi.advanceTimersByTimeAsync(500);
    expect(playButton.disabled).toBe(true);

    clearPreviewDebounce();
    expect(manifestRequest.signal?.aborted).toBe(true);

    resolveManifest(
      Response.json({
        playlistId: 'PL_PREVIEW_CLOSED',
        videoId: 'AAAAAAAAAAA',
        videoIds: ['AAAAAAAAAAA'],
        title: 'Closing playlist',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(getPrefetchedYouTubePlaylistManifest('PL_PREVIEW_CLOSED')).toBeNull();
    expect(playButton.disabled).toBe(true);
  });
});

describe('YouTube search result rendering sink', () => {
  it('coalesces a rendered result list into one scrollbar reveal per frame', async () => {
    document.body.innerHTML = `
      <div id="youtube-preview"></div>
      <div id="youtube-preview-status"></div>
      <div id="youtube-search-results" role="group"></div>
      <button id="youtube-play-btn"></button>
    `;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          results: [
            {
              videoId: 'EEEEEEEEEEE',
              title: 'Single reveal',
              channelTitle: 'MUSIXQUARE',
              thumbnailUrl: '',
              url: 'https://www.youtube.com/watch?v=EEEEEEEEEEE',
            },
          ],
        }),
      ),
    );
    const reveal = vi.fn();
    const cleanup = bus.on('ui:scrollbar-reveal', reveal);

    try {
      await searchYouTubeFromInput('single reveal probe 20260723');
      await new Promise((resolve) => window.setTimeout(resolve, 40));

      expect(reveal).toHaveBeenCalledTimes(1);
      expect(reveal).toHaveBeenCalledWith(document.getElementById('youtube-search-results'));
    } finally {
      cleanup();
      clearYouTubeInputState();
      document.body.innerHTML = '';
    }
  });

  // HTML entities are decoded BEFORE the title reaches the DOM; that is only
  // safe because every title sink is textContent/innerText. Exercise that
  // decode-then-textContent contract: a decoded markup payload must
  // render as literal text, never as elements — and the auto-selected result
  // stays bound to the query it was rendered for.
  it('renders decoded titles through textContent and binds selection to the originating query', async () => {
    document.body.innerHTML = `
      <div id="youtube-preview"></div>
      <div id="youtube-preview-status"></div>
      <div id="youtube-search-results" role="group" aria-label="Search results"></div>
      <button id="youtube-play-btn"></button>
    `;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        return Response.json({
          results: [
            {
              videoId: 'CCCCCCCCCCC',
              title: 'Tom &amp; Jerry &lt;img src=x onerror=boom()&gt;',
              channelTitle: 'Cartoon &amp; Co',
              thumbnailUrl: 'https://i.ytimg.com/vi/CCCCCCCCCCC/mqdefault.jpg',
              url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC',
            },
          ],
        });
      }),
    );

    await searchYouTubeFromInput('sink probe 20260613');

    // Entities decoded for display, markup inert: the decoded "<img …>" is
    // literal text under the title node, and the only <img> in the results
    // list is the thumbnail itself.
    const titleEl = document.querySelector('.yt-search-title');
    expect(titleEl?.textContent).toBe('Tom & Jerry <img src=x onerror=boom()>');
    expect(titleEl?.children).toHaveLength(0);
    expect(document.querySelectorAll('#youtube-search-results img')).toHaveLength(1);
    const resultButton = document.querySelector<HTMLElement>('.yt-search-result');
    expect(document.getElementById('youtube-search-results')?.getAttribute('role')).toBe('group');
    expect(resultButton?.getAttribute('role')).toBeNull();
    expect(resultButton?.getAttribute('aria-pressed')).toBe('true');

    // The first result auto-selects for the query that produced it; a changed
    // input invalidates the selection (stale-pick guard in the play button path).
    expect(getSelectedYouTubeSearchResult('sink probe 20260613')?.videoId).toBe('CCCCCCCCCCC');
    expect(getSelectedYouTubeSearchResult('some other query')).toBeNull();

    clearYouTubeInputState();
    document.body.innerHTML = '';
  });

  it('marks multilingual search-result metadata with its detected script fonts', async () => {
    document.body.innerHTML = `
      <div id="youtube-preview"></div>
      <div id="youtube-preview-status"></div>
      <div id="youtube-search-results" role="group"></div>
      <button id="youtube-play-btn"></button>
    `;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          results: [
            {
              videoId: 'DDDDDDDDDDD',
              title: '练习中文',
              channelTitle: 'Музыка',
              thumbnailUrl: '',
              url: 'https://www.youtube.com/watch?v=DDDDDDDDDDD',
            },
          ],
        }),
      ),
    );

    await searchYouTubeFromInput('font probe 20260722');

    expect(document.querySelector('.yt-search-title')?.classList).toContain(
      'user-text-font-zh-hans',
    );
    expect(document.querySelector('.yt-search-channel')?.classList).toContain('user-text-font-ru');
  });
});

describe('YouTube metadata entity decoding', () => {
  it('decodes HTML entities from search results and oEmbed metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/security-config')) {
          return Response.json({ capabilityRequired: false });
        }
        if (url.includes('/api/youtube-search')) {
          return Response.json({
            results: [
              {
                videoId: 'dQw4w9WgXcQ',
                title: 'Ain&#39;t &amp; &quot;Too Cool&quot; &lt;Live&gt; &rsquo;',
                channelTitle: 'LunchMoney &amp; Crew',
                thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
                url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
              },
            ],
          });
        }
        return Response.json({
          title: 'Rock &amp; Roll &#x27;Tonight&#x27; &mdash; Live',
          author_name: 'LunchMoney &amp; Crew',
        });
      }),
    );

    const results = await fetchYouTubeSearchResults('entity decode smoke 20260602');
    expect(results[0]?.title).toBe('Ain\'t & "Too Cool" <Live> \u2019');
    expect(results[0]?.channelTitle).toBe('LunchMoney & Crew');

    const onMetadata = vi.fn();
    await expect(
      fetchOEmbedTitle('https://www.youtube.com/watch?v=entityDecode01', onMetadata),
    ).resolves.toBe("Rock & Roll 'Tonight' \u2014 Live");
    expect(onMetadata).toHaveBeenCalledWith({
      title: "Rock & Roll 'Tonight' \u2014 Live",
      authorName: 'LunchMoney & Crew',
    });
  });
});

/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { setLanguageMode } from '../../i18n/index.ts';
import {
  clearYouTubeInputState,
  extractYouTubeVideoId,
  extractYouTubePlaylistId,
  fetchYouTubeSearchResults,
  getSelectedYouTubeSearchResult,
  getYouTubeInputIntent,
  isYouTubeLiveUrl,
  searchYouTubeFromInput,
} from '../search.ts';
import { fetchOEmbedTitle } from '../oembed.ts';

afterEach(() => {
  vi.unstubAllGlobals();
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
      <div id="youtube-search-results"></div>
      <button id="youtube-play-btn"></button>
    `;
    setLanguageMode('ko');

    clearYouTubeInputState();

    const status = document.getElementById('youtube-preview-status');
    expect(status?.getAttribute('data-i18n')).toBe('youtube.enter_link_prompt');

    setLanguageMode('en');

    expect(status?.textContent).toBe('Enter a YouTube search term or link');
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

describe('YouTube search result rendering sink', () => {
  // HTML entities are decoded BEFORE the title reaches the DOM; that is only
  // safe because every title sink is textContent/innerText. Exercise that
  // decode-then-textContent contract: a decoded markup payload must
  // render as literal text, never as elements — and the auto-selected result
  // stays bound to the query it was rendered for.
  it('renders decoded titles through textContent and binds selection to the originating query', async () => {
    document.body.innerHTML = `
      <div id="youtube-preview"></div>
      <div id="youtube-preview-status"></div>
      <div id="youtube-search-results"></div>
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

    // The first result auto-selects for the query that produced it; a changed
    // input invalidates the selection (stale-pick guard in the play button path).
    expect(getSelectedYouTubeSearchResult('sink probe 20260613')?.videoId).toBe('CCCCCCCCCCC');
    expect(getSelectedYouTubeSearchResult('some other query')).toBeNull();

    clearYouTubeInputState();
    document.body.innerHTML = '';
  });
});

describe('YouTube title entity decoding', () => {
  it('decodes HTML entities from search results and oEmbed titles', async () => {
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
        });
      }),
    );

    const results = await fetchYouTubeSearchResults('entity decode smoke 20260602');
    expect(results[0]?.title).toBe('Ain\'t & "Too Cool" <Live> \u2019');
    expect(results[0]?.channelTitle).toBe('LunchMoney & Crew');

    await expect(
      fetchOEmbedTitle('https://www.youtube.com/watch?v=entityDecode01'),
    ).resolves.toBe('Rock & Roll \'Tonight\' \u2014 Live');
  });
});

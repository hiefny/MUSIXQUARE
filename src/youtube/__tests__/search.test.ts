/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { setLanguageMode } from '../../i18n/index.ts';
import {
  clearYouTubeInputState,
  extractYouTubeVideoId,
  extractYouTubePlaylistId,
  getYouTubeInputIntent,
  isYouTubeLiveUrl,
} from '../search.ts';

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

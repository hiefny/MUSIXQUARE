/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { extractYouTubeVideoId, extractYouTubePlaylistId } from '../search.ts';

describe('extractYouTubeVideoId', () => {
  it('extracts from standard watch URL', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
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

  it('extracts when v= is not the first query param', () => {
    expect(extractYouTubeVideoId('https://youtube.com/watch?t=10&v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts from URL with extra params', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxx&index=1')).toBe('dQw4w9WgXcQ');
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

describe('extractYouTubePlaylistId', () => {
  it('extracts playlist ID from list param', () => {
    expect(extractYouTubePlaylistId('https://youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf')).toBe('PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  });

  it('extracts playlist ID when combined with video', () => {
    expect(extractYouTubePlaylistId('https://youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest123')).toBe('PLtest123');
  });

  it('returns null when no list param', () => {
    expect(extractYouTubePlaylistId('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractYouTubePlaylistId('')).toBeNull();
  });
});

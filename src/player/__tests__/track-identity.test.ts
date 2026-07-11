/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import type { PlaylistItem } from '../../types/index.ts';
import { getTrackKeyFromFile, getTrackKeyFromItem } from '../_state.ts';

function fileItem(name: string, file?: File): PlaylistItem {
  return {
    type: 'file',
    name,
    file,
    videoId: null,
    playlistId: null,
  };
}

describe('failed-track identity', () => {
  it('uses File object identity rather than colliding metadata', () => {
    const first = new File(['aaaa'], 'same.wav', { type: 'audio/wav', lastModified: 123 });
    const second = new File(['bbbb'], 'same.wav', { type: 'audio/wav', lastModified: 123 });

    expect(getTrackKeyFromFile(first)).toBe(getTrackKeyFromFile(first));
    expect(getTrackKeyFromFile(first)).not.toBe(getTrackKeyFromFile(second));
    expect(getTrackKeyFromItem(fileItem(first.name, first))).toBe(getTrackKeyFromFile(first));
  });

  it('does not collapse same-size raw Blobs or same-name file entries', () => {
    const firstBlob = new Blob(['aaaa']);
    const secondBlob = new Blob(['bbbb']);
    const firstItem = fileItem('same.wav');
    const secondItem = fileItem('same.wav');

    expect(getTrackKeyFromFile(firstBlob)).not.toBe(getTrackKeyFromFile(secondBlob));
    expect(getTrackKeyFromItem(firstItem)).toBe(getTrackKeyFromItem(firstItem));
    expect(getTrackKeyFromItem(firstItem)).not.toBe(getTrackKeyFromItem(secondItem));
  });

  it('keeps YouTube videoId as stable media identity', () => {
    const first: PlaylistItem = {
      type: 'youtube',
      name: 'first title',
      videoId: 'abcdefghijk',
      playlistId: null,
    };
    const second: PlaylistItem = { ...first, name: 'renamed title' };

    expect(getTrackKeyFromItem(first)).toBe('yt:abcdefghijk');
    expect(getTrackKeyFromItem(second)).toBe('yt:abcdefghijk');
  });
});

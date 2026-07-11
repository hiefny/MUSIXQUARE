/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import type { PlaylistItem } from '../../types/index.ts';
import { getTrackKeyFromFileForTests, getTrackKeyFromItem } from '../_state.ts';

const FIRST_QUEUE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_QUEUE_ID = '22222222-2222-4222-8222-222222222222';

function fileItem(queueItemId: string, name: string, file?: File): PlaylistItem {
  return {
    queueItemId,
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

    expect(getTrackKeyFromFileForTests(first)).toBe(getTrackKeyFromFileForTests(first));
    expect(getTrackKeyFromFileForTests(first)).not.toBe(getTrackKeyFromFileForTests(second));
    expect(getTrackKeyFromItem(fileItem(FIRST_QUEUE_ID, first.name, first))).toBe(
      `queue:${FIRST_QUEUE_ID}`,
    );
  });

  it('does not collapse same-size raw Blobs or separate queue occurrences', () => {
    const firstBlob = new Blob(['aaaa']);
    const secondBlob = new Blob(['bbbb']);
    const sharedFile = new File(['aaaa'], 'same.wav', { type: 'audio/wav' });
    const firstItem = fileItem(FIRST_QUEUE_ID, 'same.wav', sharedFile);
    const secondItem = fileItem(SECOND_QUEUE_ID, 'same.wav', sharedFile);

    expect(getTrackKeyFromFileForTests(firstBlob)).not.toBe(
      getTrackKeyFromFileForTests(secondBlob),
    );
    expect(getTrackKeyFromItem(firstItem)).toBe(getTrackKeyFromItem(firstItem));
    expect(getTrackKeyFromItem(firstItem)).not.toBe(getTrackKeyFromItem(secondItem));
  });

  it('keeps queue identity stable across a YouTube title update', () => {
    const first: PlaylistItem = {
      queueItemId: FIRST_QUEUE_ID,
      type: 'youtube',
      name: 'first title',
      videoId: 'abcdefghijk',
      playlistId: null,
    };
    const second: PlaylistItem = { ...first, name: 'renamed title' };

    expect(getTrackKeyFromItem(first)).toBe(`queue:${FIRST_QUEUE_ID}`);
    expect(getTrackKeyFromItem(second)).toBe(`queue:${FIRST_QUEUE_ID}`);
  });

  it('keeps duplicate YouTube occurrences independent', () => {
    const first: PlaylistItem = {
      queueItemId: FIRST_QUEUE_ID,
      type: 'youtube',
      name: 'same video',
      videoId: 'abcdefghijk',
      playlistId: null,
    };
    const second: PlaylistItem = { ...first, queueItemId: SECOND_QUEUE_ID };

    expect(getTrackKeyFromItem(first)).not.toBe(getTrackKeyFromItem(second));
  });
});

import { describe, expect, it } from 'vitest';
import type { ProRoomPlaylistWireItem, ProRoomR2Source } from '../contracts.ts';
import { ProRoomPlaylistProjection } from '../playlist-projection.ts';
import type { PlaylistItem } from '../../types/index.ts';

const YOUTUBE_ID = '11111111-1111-4111-8111-111111111111';
const FILE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';

const source: ProRoomR2Source = {
  kind: 'pro-r2',
  assetId: 'asset_00000000001',
  version: 2,
  byteLength: 4,
  mime: 'audio/flac',
  sha256: 'a'.repeat(64),
};

function wirePlaylist(): ProRoomPlaylistWireItem[] {
  return [
    {
      queueItemId: YOUTUBE_ID,
      name: 'Video',
      title: 'Exact title',
      artist: 'Artist',
      thumbnail: 'https://example.test/thumbnail.jpg',
      source: {
        kind: 'youtube',
        videoId: 'dQw4w9WgXcQ',
        playlistId: 'PL1234567890',
        videoIds: ['dQw4w9WgXcQ', 'aaaaaaaaaaa'],
      },
    },
    {
      queueItemId: FILE_ID,
      name: 'Orchestra.flac',
      source: { ...source },
    },
  ];
}

describe('PRO playlist projection', () => {
  it('maps YouTube exactly and exposes an unloaded legacy row for private R2 media', () => {
    const projection = new ProRoomPlaylistProjection();
    const projected = projection.project(wirePlaylist());

    expect(projected[0]).toEqual({
      queueItemId: YOUTUBE_ID,
      type: 'youtube',
      name: 'Video',
      title: 'Exact title',
      artist: 'Artist',
      thumbnail: 'https://example.test/thumbnail.jpg',
      videoId: 'dQw4w9WgXcQ',
      playlistId: 'PL1234567890',
    });
    expect(projected[1]).toEqual({
      queueItemId: FILE_ID,
      type: 'file',
      name: 'Orchestra.flac',
      videoId: null,
      playlistId: null,
    });
    expect(Object.prototype.hasOwnProperty.call(projected[1], 'file')).toBe(false);
    expect(projection.sourceFor(FILE_ID)).toEqual(source);
  });

  it('round-trips canonical metadata and source identities without sharing mutable objects', () => {
    const projection = new ProRoomPlaylistProjection();
    const input = wirePlaylist();
    const legacy = projection.project(input);
    input[1]!.source = { kind: 'youtube', videoId: 'aaaaaaaaaaa' };

    const result = projection.toWire(legacy);
    expect(result).toEqual(wirePlaylist());
    expect(result[1]!.source).not.toBe(source);
    expect(result[0]!.source).toEqual(wirePlaylist()[0]!.source);
    if (result[0]!.source.kind !== 'youtube' || !result[0]!.source.videoIds) {
      throw new Error('fixture');
    }
    result[0]!.source.videoIds[1] = 'bbbbbbbbbbb';
    expect(projection.sourceFor(YOUTUBE_ID)).toMatchObject({
      videoIds: ['dQw4w9WgXcQ', 'aaaaaaaaaaa'],
    });
  });

  it('derives current YouTube fields while requiring an uploaded source for files', () => {
    const projection = new ProRoomPlaylistProjection();
    const youtube: PlaylistItem = {
      queueItemId: YOUTUBE_ID,
      type: 'youtube',
      name: 'Video',
      videoId: 'aaaaaaaaaaa',
      playlistId: null,
    };
    expect(projection.toWire([youtube])).toEqual([
      {
        queueItemId: YOUTUBE_ID,
        name: 'Video',
        source: { kind: 'youtube', videoId: 'aaaaaaaaaaa' },
      },
    ]);

    const localOnly: PlaylistItem = {
      queueItemId: FILE_ID,
      type: 'file',
      file: new File(['data'], 'local.flac', { type: 'audio/flac' }),
      name: 'local.flac',
      videoId: null,
      playlistId: null,
    };
    expect(() => projection.toWire([localOnly])).toThrow('PRO_ROOM_PLAYLIST_FILE_NOT_UPLOADED');

    projection.bindR2Source(FILE_ID, source);
    expect(projection.toWire([localOnly])[0]?.source).toEqual(source);
  });

  it('atomically replaces stale registry entries and rejects duplicate queue identities', () => {
    const projection = new ProRoomPlaylistProjection();
    projection.project(wirePlaylist());
    projection.project([
      {
        queueItemId: OTHER_ID,
        name: 'Other',
        source: { kind: 'youtube', videoId: 'bbbbbbbbbbb' },
      },
    ]);
    expect(projection.sourceFor(FILE_ID)).toBeNull();

    const duplicate = wirePlaylist();
    duplicate[1] = { ...duplicate[1]!, queueItemId: duplicate[0]!.queueItemId };
    expect(() => projection.project(duplicate)).toThrow('PRO_ROOM_PLAYLIST_DUPLICATE_QUEUE_ITEM');
  });

  it('does not partially mutate the source registry when reverse projection fails', () => {
    const projection = new ProRoomPlaylistProjection();
    projection.project(wirePlaylist());
    const missingFile: PlaylistItem = {
      queueItemId: OTHER_ID,
      type: 'file',
      name: 'not-uploaded.wav',
      videoId: null,
      playlistId: null,
    };

    expect(() =>
      projection.toWire([
        {
          queueItemId: YOUTUBE_ID,
          type: 'youtube',
          name: 'Changed',
          videoId: 'aaaaaaaaaaa',
          playlistId: null,
        },
        missingFile,
      ]),
    ).toThrow('PRO_ROOM_PLAYLIST_FILE_NOT_UPLOADED');
    expect(projection.sourceFor(YOUTUBE_ID)).toEqual({
      kind: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      playlistId: 'PL1234567890',
      videoIds: ['dQw4w9WgXcQ', 'aaaaaaaaaaa'],
    });
    expect(projection.sourceFor(FILE_ID)).toEqual(source);
  });
});

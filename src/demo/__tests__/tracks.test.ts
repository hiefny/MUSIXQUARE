import { describe, expect, it } from 'vitest';
import { DEMO_TRACK, DEMO_TRACKS, createDemoTrackMeta } from '../tracks.ts';

describe('demo track registry', () => {
  it('keeps the explicit Linelight demo registry internally unique', () => {
    expect(DEMO_TRACKS).toHaveLength(4);
    expect(new Set(DEMO_TRACKS.map((track) => track.id)).size).toBe(DEMO_TRACKS.length);
    expect(new Set(DEMO_TRACKS.map((track) => track.url)).size).toBe(DEMO_TRACKS.length);
  });

  it('creates file track metadata for demo playback', () => {
    expect(createDemoTrackMeta()).toEqual({
      type: 'file',
      name: DEMO_TRACK.fileName,
      title: DEMO_TRACK.title,
      artist: DEMO_TRACK.artist,
      videoId: null,
      playlistId: null,
    });
  });
});

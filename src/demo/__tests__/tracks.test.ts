import { describe, expect, it } from 'vitest';
import {
  DEMO_TRACK,
  DEMO_TRACKS,
  LEGACY_DEMO_FILE_NAME,
  createDemoTrackMeta,
  isDemoTrackName,
} from '../tracks.ts';

describe('demo track registry', () => {
  it('recognizes the Linelight R2 demo filenames', () => {
    expect(DEMO_TRACKS).toHaveLength(4);
    for (const track of DEMO_TRACKS) {
      expect(isDemoTrackName(track.fileName)).toBe(true);
    }
    expect(isDemoTrackName('  brett taylor - linelight ost - 04 spring.m4a  ')).toBe(true);
  });

  it('keeps the legacy bundled demo filename recognized for compatibility', () => {
    expect(isDemoTrackName(LEGACY_DEMO_FILE_NAME)).toBe(true);
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

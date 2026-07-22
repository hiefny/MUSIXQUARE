import { describe, expect, it } from 'vitest';
import { getTrackDisplayTitle } from '../track-display.ts';

describe('track display title', () => {
  it('prefers genuine file title metadata', () => {
    expect(
      getTrackDisplayTitle({ type: 'file', name: 'artist - file.flac', title: 'Song title' }),
    ).toBe('Song title');
  });

  it('removes the extension when file title metadata is absent', () => {
    expect(getTrackDisplayTitle({ type: 'file', name: 'artist - file.flac' })).toBe(
      'artist - file',
    );
  });

  it('normalizes legacy file titles that duplicate the filename', () => {
    expect(getTrackDisplayTitle({ type: 'file', name: 'legacy.mp3', title: 'legacy.mp3' })).toBe(
      'legacy',
    );
  });

  it('does not treat dots in real titles or YouTube titles as file extensions', () => {
    expect(getTrackDisplayTitle({ type: 'file', name: 'track.mp3', title: 'Dr. Feelgood' })).toBe(
      'Dr. Feelgood',
    );
    expect(getTrackDisplayTitle({ type: 'youtube', name: 'Video', title: 'Version 2.0' })).toBe(
      'Version 2.0',
    );
  });

  it('keeps extension stripping isolated from stored identity', () => {
    const name = 'archive.mix.wav';
    expect(getTrackDisplayTitle({ type: 'file', name })).toBe('archive.mix');
    expect(name).toBe('archive.mix.wav');
  });

  it('preserves dotted filenames when the suffix is not a supported audio extension', () => {
    expect(getTrackDisplayTitle({ type: 'file', name: 'Version.2' })).toBe('Version.2');
    expect(getTrackDisplayTitle({ type: 'file', name: 'session.project' })).toBe('session.project');
  });
});

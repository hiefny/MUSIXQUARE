import { describe, expect, it } from 'vitest';
import { getFileDisplayName, getTrackDisplayTitle } from '../track-display.ts';

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

  // macOS hands file names over decomposed (NFD): a Hangul syllable arrives
  // as conjoining jamo, which no self-hosted face draws. File-derived titles
  // are composed (NFC) for display only.
  const NFD_GAK = '각';
  const NFC_GAK = '각';

  it('composes a decomposed file name for display without touching the stored name', () => {
    const name = `${NFD_GAK}.mp3`;
    expect(getTrackDisplayTitle({ type: 'file', name })).toBe(NFC_GAK);
    expect(name).toBe(`${NFD_GAK}.mp3`);
    expect(name.normalize('NFC')).not.toBe(name);
  });

  it('composes a decomposed title on a file track', () => {
    expect(
      getTrackDisplayTitle({ type: 'file', name: 'track.mp3', title: `${NFD_GAK} title` }),
    ).toBe(`${NFC_GAK} title`);
  });

  it('leaves YouTube titles as the service sent them', () => {
    expect(getTrackDisplayTitle({ type: 'youtube', name: 'Video', title: NFD_GAK })).toBe(NFD_GAK);
  });

  it('composes a raw file name, extension kept, for rows that show the whole name', () => {
    expect(getFileDisplayName(`${NFD_GAK}.flac`)).toBe(`${NFC_GAK}.flac`);
    expect(getFileDisplayName('one.flac')).toBe('one.flac');
  });
});

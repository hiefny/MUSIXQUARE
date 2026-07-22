/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIO_FILE_ACCEPT,
  partitionAudioFileCandidates,
  resolveAudioMime,
  stripRecognizedAudioFileExtension,
} from '../audio-file.ts';

const extensionCases = [
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['flac', 'audio/flac'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/opus'],
  ['webm', 'audio/webm'],
  ['aif', 'audio/aiff'],
  ['aiff', 'audio/aiff'],
  ['caf', 'audio/x-caf'],
] as const;

function descriptor(name: string, type: string): Pick<File, 'name' | 'type'> {
  return { name, type };
}

function isCandidate(name: string, type: string): boolean {
  const file = descriptor(name, type) as File;
  return partitionAudioFileCandidates([file]).accepted.length === 1;
}

describe('local audio-file candidates', () => {
  it.each(extensionCases)('accepts .%s when MIME is missing', (extension) => {
    expect(isCandidate(`track.${extension}`, '')).toBe(true);
  });

  it.each(extensionCases)('accepts .%s through generic binary MIME fallback', (extension) => {
    expect(isCandidate(`TRACK.${extension.toUpperCase()}`, 'application/octet-stream')).toBe(true);
    expect(isCandidate(`track.${extension}`, 'binary/octet-stream')).toBe(true);
  });

  it('trusts audio MIME before the extension and ignores MIME parameters', () => {
    expect(isCandidate('track.unknown', 'audio/opus')).toBe(true);
    expect(isCandidate('track.bin', ' Audio/MP4; codecs=mp4a.40.2 ')).toBe(true);
  });

  it('lets legacy Ogg application MIME fall back to a recognized audio extension', () => {
    expect(isCandidate('track.oga', 'application/ogg')).toBe(true);
    expect(isCandidate('track.ogg', 'application/x-ogg; codecs=opus')).toBe(true);
    expect(resolveAudioMime('track.oga', 'application/ogg')).toBe('audio/ogg');
  });

  it('rejects unsupported or explicitly non-audio files', () => {
    expect(isCandidate('document.pdf', '')).toBe(false);
    expect(isCandidate('cover.png', 'image/png')).toBe(false);
    expect(isCandidate('renamed.mp3', 'application/pdf')).toBe(false);
    expect(isCandidate('mislabelled.m4a', 'video/mp4')).toBe(false);
    expect(isCandidate('movie.webm', 'video/webm')).toBe(false);
  });

  it.each(extensionCases)('shares the .%s extension-to-MIME fallback', (extension, mime) => {
    expect(resolveAudioMime(`TRACK.${extension.toUpperCase()}`, '')).toBe(mime);
    expect(resolveAudioMime(`track.${extension}`, 'application/octet-stream')).toBe(mime);
  });

  it('strips only suffixes recognized by the shared audio extension table', () => {
    expect(stripRecognizedAudioFileExtension('archive.mix.FLAC')).toBe('archive.mix');
    expect(stripRecognizedAudioFileExtension('Version.2')).toBe('Version.2');
    expect(stripRecognizedAudioFileExtension('.mp3')).toBe('.mp3');
  });

  it('preserves a meaningful declared MIME', () => {
    expect(resolveAudioMime('track.mp3', ' audio/custom; codecs=test ')).toBe(
      'audio/custom; codecs=test',
    );
  });

  it('partitions candidates without changing order or duplicate entries', () => {
    const audio = new File(['a'], 'track.flac', { type: 'audio/flac' });
    const image = new File(['i'], 'cover.png', { type: 'image/png' });
    const fallback = new File(['b'], 'fallback.caf', { type: '' });

    expect(partitionAudioFileCandidates([audio, image, audio, fallback])).toEqual({
      accepted: [audio, audio, fallback],
      rejected: [image],
    });
  });

  it('keeps the native file-picker hint aligned with the fallback list', () => {
    expect(AUDIO_FILE_ACCEPT).toBe(
      '.mp3,.wav,.flac,.m4a,.aac,.ogg,.oga,.opus,.webm,.aif,.aiff,.caf,audio/*',
    );
  });
});

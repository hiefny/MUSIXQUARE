import { stripRecognizedAudioFileExtension } from '../media/audio-file.ts';

type DisplayTrack = {
  type?: string | null;
  name?: string | null;
  title?: string | null;
};

/**
 * A file name as people should see it. macOS hands file names over decomposed
 * (NFD), and a decomposed Hangul syllable is conjoining jamo that no
 * self-hosted face draws, so it would fall to a device font. Compose it (NFC)
 * for display only; the stored name keeps its bytes for storage, transfer and
 * queue identity.
 */
export function getFileDisplayName(name: string): string {
  return name.normalize('NFC');
}

/**
 * Resolve user-facing track copy without changing the stable filename used
 * for storage, transfer, and queue identity.
 */
export function getTrackDisplayTitle(track: DisplayTrack, fallback = ''): string {
  const title = typeof track.title === 'string' ? track.title.trim() : '';
  const name = typeof track.name === 'string' ? track.name.trim() : '';

  if (track.type !== 'file') return title || name || fallback;
  if (title && title !== name) return getFileDisplayName(title);
  // A trustworthy audio/* MIME can admit files without a conventional audio
  // suffix. Share the admission extension table so a genuine dotted filename
  // such as "Version.2" is never shortened by a catch-all regex.
  return getFileDisplayName(stripRecognizedAudioFileExtension(name || title)) || fallback;
}

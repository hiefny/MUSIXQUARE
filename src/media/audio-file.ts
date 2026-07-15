/**
 * Fast, decode-free classification for local audio-file candidates.
 *
 * A positive result means only that a file is worth passing to the browser's
 * native audio decoder. Codec/container support is still decided by
 * decodeAudioData at load time.
 */

const AUDIO_FILE_FALLBACK_EXTENSIONS = Object.freeze([
  'mp3',
  'wav',
  'flac',
  'm4a',
  'aac',
  'ogg',
  'aif',
  'aiff',
  'caf',
] as const);

const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
});

const GENERIC_BINARY_MIME_ESSENCES = new Set(['application/octet-stream', 'binary/octet-stream']);

export const AUDIO_FILE_ACCEPT = `${AUDIO_FILE_FALLBACK_EXTENSIONS.map((ext) => `.${ext}`).join(',')},audio/*`;

function mimeEssence(mime?: string): string {
  return typeof mime === 'string' ? (mime.split(';', 1)[0]?.trim().toLowerCase() ?? '') : '';
}

function filenameExtension(filename: string): string {
  return /\.([^.\\/]+)$/.exec(filename.trim().toLowerCase())?.[1] ?? '';
}

function inferAudioMimeFromFilename(filename: string): string {
  return AUDIO_MIME_BY_EXTENSION[filenameExtension(filename)] ?? '';
}

export function resolveAudioMime(filename: string, mime?: string): string {
  return meaningfulDeclaredMime(mime) || inferAudioMimeFromFilename(filename);
}

export function meaningfulDeclaredMime(mime?: string): string {
  const declared = typeof mime === 'string' ? mime.trim() : '';
  const essence = mimeEssence(declared);
  if (essence && !GENERIC_BINARY_MIME_ESSENCES.has(essence)) return declared;
  return '';
}

function isAudioFileCandidate(file: Pick<File, 'name' | 'type'>): boolean {
  const essence = mimeEssence(file.type);
  if (essence.startsWith('audio/')) return true;
  if (essence && !GENERIC_BINARY_MIME_ESSENCES.has(essence)) return false;
  return inferAudioMimeFromFilename(file.name) !== '';
}

export function partitionAudioFileCandidates(files: ArrayLike<File>): {
  accepted: File[];
  rejected: File[];
} {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (!file) continue;
    (isAudioFileCandidate(file) ? accepted : rejected).push(file);
  }
  return { accepted, rejected };
}

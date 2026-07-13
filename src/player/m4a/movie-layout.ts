import type { IsoBmffBoxRef } from '../mp4/box.ts';
import { IsoBmffBoxReader } from '../mp4/box-reader.ts';
import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';
import {
  type M4aMediaHeader,
  type M4aMovieHeader,
  type M4aTrackHeader,
  parseM4aEditList,
  parseM4aHandlerHeader,
  parseM4aMediaHeader,
  parseM4aMovieHeader,
  parseM4aTrackHeader,
} from './fixed-boxes.ts';
import type { M4aAacEditEvidence } from './timeline.ts';

export const M4A_MAX_TRACK_BOXES = 64;

const MVHD_PAYLOAD_BYTES = new Set([100, 112]);
const MDHD_PAYLOAD_BYTES = new Set([24, 36]);
const TKHD_PAYLOAD_BYTES = new Set([84, 96]);
const ELST_PAYLOAD_BYTES = new Set([20, 28]);
const HDLR_FIXED_PREFIX_BYTES = 24;
const SMHD_PAYLOAD_BYTES = 8;
const DREF_HEADER_BYTES = 8;
const URL_PAYLOAD_BYTES = 4;
const TRACK_ENABLED_FLAG = 0x0000_0001;
const TRACK_IN_MOVIE_FLAG = 0x0000_0002;

const MOOV_PADDING_TYPES = new Set(['free', 'skip', 'iods']);
const TRACK_PADDING_TYPES = new Set(['free', 'skip']);
const AUDIO_EXTENSION_TYPES = new Set(['meta', 'udta', 'elng', 'tref']);
const FRAGMENTED_BOX_TYPES = new Set(['mvex', 'moof', 'mfra', 'traf']);

export interface M4aAudioTrackLayout {
  readonly trackHeader: Readonly<M4aTrackHeader>;
  readonly mediaHeader: Readonly<M4aMediaHeader>;
  readonly edit: Readonly<M4aAacEditEvidence> | null;
  /** Provenance-bearing `stbl` reference for the bounded table verifier. */
  readonly stbl: Readonly<IsoBmffBoxRef>;
}

export interface M4aMovieLayout {
  readonly movieHeader: Readonly<M4aMovieHeader>;
  readonly audioTrack: Readonly<M4aAudioTrackLayout>;
  /** The optional `moov/udta` metadata root; its body has not been read. */
  readonly metadataRoot: Readonly<IsoBmffBoxRef> | null;
}

export class M4aMovieLayoutError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aMovieLayoutError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

interface TrackChildren {
  readonly trackHeaders: readonly Readonly<IsoBmffBoxRef>[];
  readonly media: Readonly<IsoBmffBoxRef>;
  readonly edits: readonly Readonly<IsoBmffBoxRef>[];
  readonly extensions: readonly Readonly<IsoBmffBoxRef>[];
}

interface MediaChildren {
  readonly mediaHeaders: readonly Readonly<IsoBmffBoxRef>[];
  readonly handler: Readonly<IsoBmffBoxRef>;
  readonly mediaInformation: readonly Readonly<IsoBmffBoxRef>[];
  readonly extensions: readonly Readonly<IsoBmffBoxRef>[];
}

function bodyLength(box: Readonly<IsoBmffBoxRef>): number {
  return box.end - box.dataStart;
}

function requireExactBodyLength(
  box: Readonly<IsoBmffBoxRef>,
  expected: number | ReadonlySet<number>,
  label: string,
): number {
  const length = bodyLength(box);
  const valid = typeof expected === 'number' ? length === expected : expected.has(length);
  if (!valid) {
    const description = typeof expected === 'number' ? `${expected}` : [...expected].join(' or ');
    throw new M4aMovieLayoutError(`${label} payload must contain exactly ${description} bytes`);
  }
  return length;
}

function assignUnique(
  current: Readonly<IsoBmffBoxRef> | null,
  candidate: Readonly<IsoBmffBoxRef>,
  label: string,
): Readonly<IsoBmffBoxRef> {
  if (current !== null) {
    throw new M4aMovieLayoutError(`M4A ${label} must appear exactly once`);
  }
  return candidate;
}

function requireExactlyOne(
  boxes: readonly Readonly<IsoBmffBoxRef>[],
  label: string,
): Readonly<IsoBmffBoxRef> {
  if (boxes.length !== 1) {
    throw new M4aMovieLayoutError(`M4A ${label} must appear exactly once`);
  }
  return boxes[0]!;
}

function validateSelectedAudioExtensions(
  boxes: readonly Readonly<IsoBmffBoxRef>[],
  scope: string,
): void {
  const seen = new Set<string>();
  for (const box of boxes) {
    if (TRACK_PADDING_TYPES.has(box.type)) continue;
    if (!AUDIO_EXTENSION_TYPES.has(box.type)) {
      throw new M4aMovieLayoutError(
        `Unknown M4A ${scope} box ${JSON.stringify(box.type)} is not admitted`,
      );
    }
    if (seen.has(box.type)) {
      throw new M4aMovieLayoutError(`M4A ${scope}/${box.type} box must appear at most once`);
    }
    seen.add(box.type);
  }
}

async function readFixedPayload(
  reader: IsoBmffBoxReader,
  box: Readonly<IsoBmffBoxRef>,
  expected: ReadonlySet<number>,
  label: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = requireExactBodyLength(box, expected, label);
  return reader.readBytes(box.dataStart, length, signal);
}

async function collectTrackChildren(
  reader: IsoBmffBoxReader,
  track: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<Readonly<TrackChildren>> {
  const cursor = reader.createChildCursor(track);
  const trackHeaders: Readonly<IsoBmffBoxRef>[] = [];
  const edits: Readonly<IsoBmffBoxRef>[] = [];
  const extensions: Readonly<IsoBmffBoxRef>[] = [];
  let media: Readonly<IsoBmffBoxRef> | null = null;

  for (;;) {
    const child = await cursor.next(signal);
    if (child === null) break;
    if (FRAGMENTED_BOX_TYPES.has(child.type)) {
      throw new M4aMovieLayoutError(
        `Fragmented M4A track box ${JSON.stringify(child.type)} is not supported`,
      );
    }
    switch (child.type) {
      case 'tkhd':
        trackHeaders.push(child);
        break;
      case 'mdia':
        media = assignUnique(media, child, 'trak/mdia box');
        break;
      case 'edts':
        edits.push(child);
        break;
      default:
        // Discovery cannot interpret an unrelated track. Retain only the
        // bounded box reference so the selected audio track can validate its
        // own extensions after hdlr identification; non-audio bodies remain
        // completely untouched.
        extensions.push(child);
        break;
    }
  }

  if (media === null) {
    throw new M4aMovieLayoutError('M4A trak/mdia box must appear exactly once');
  }
  return Object.freeze({
    trackHeaders: Object.freeze(trackHeaders),
    media,
    edits: Object.freeze(edits),
    extensions: Object.freeze(extensions),
  });
}

async function collectMediaChildren(
  reader: IsoBmffBoxReader,
  media: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<Readonly<MediaChildren>> {
  const cursor = reader.createChildCursor(media);
  const mediaHeaders: Readonly<IsoBmffBoxRef>[] = [];
  const mediaInformation: Readonly<IsoBmffBoxRef>[] = [];
  const extensions: Readonly<IsoBmffBoxRef>[] = [];
  let handler: Readonly<IsoBmffBoxRef> | null = null;

  for (;;) {
    const child = await cursor.next(signal);
    if (child === null) break;
    if (FRAGMENTED_BOX_TYPES.has(child.type)) {
      throw new M4aMovieLayoutError(
        `Fragmented M4A media box ${JSON.stringify(child.type)} is not supported`,
      );
    }
    switch (child.type) {
      case 'mdhd':
        mediaHeaders.push(child);
        break;
      case 'hdlr':
        handler = assignUnique(handler, child, 'mdia/hdlr box');
        break;
      case 'minf':
        mediaInformation.push(child);
        break;
      default:
        extensions.push(child);
        break;
    }
  }

  if (handler === null) {
    throw new M4aMovieLayoutError('M4A mdia/hdlr box must appear exactly once');
  }
  return Object.freeze({
    mediaHeaders: Object.freeze(mediaHeaders),
    handler,
    mediaInformation: Object.freeze(mediaInformation),
    extensions: Object.freeze(extensions),
  });
}

async function readHandlerType(
  reader: IsoBmffBoxReader,
  handler: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<string> {
  if (bodyLength(handler) < HDLR_FIXED_PREFIX_BYTES) {
    throw new M4aMovieLayoutError(
      `M4A hdlr payload must contain at least ${HDLR_FIXED_PREFIX_BYTES} bytes`,
    );
  }
  const prefix = await reader.readBytes(handler.dataStart, HDLR_FIXED_PREFIX_BYTES, signal);
  return parseM4aHandlerHeader(prefix).handlerType;
}

async function readEdit(
  reader: IsoBmffBoxReader,
  edits: readonly Readonly<IsoBmffBoxRef>[],
  signal: AbortSignal,
): Promise<Readonly<M4aAacEditEvidence> | null> {
  if (edits.length === 0) return null;
  const edts = requireExactlyOne(edits, 'trak/edts box');
  const cursor = reader.createChildCursor(edts);
  const editList = await cursor.next(signal);
  if (editList === null || editList.type !== 'elst') {
    throw new M4aMovieLayoutError('M4A edts must contain exactly one elst box');
  }
  if ((await cursor.next(signal)) !== null) {
    throw new M4aMovieLayoutError('M4A edts must contain exactly one elst box');
  }
  return parseM4aEditList(
    await readFixedPayload(reader, editList, ELST_PAYLOAD_BYTES, 'M4A elst', signal),
  );
}

async function validateSoundMediaHeader(
  reader: IsoBmffBoxReader,
  soundHeader: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<void> {
  requireExactBodyLength(soundHeader, SMHD_PAYLOAD_BYTES, 'M4A smhd');
  const bytes = await reader.readBytes(soundHeader.dataStart, SMHD_PAYLOAD_BYTES, signal);
  if (
    bytes[0] !== 0 ||
    bytes[1] !== 0 ||
    bytes[2] !== 0 ||
    bytes[3] !== 0 ||
    bytes[4] !== 0 ||
    bytes[5] !== 0 ||
    bytes[6] !== 0 ||
    bytes[7] !== 0
  ) {
    throw new M4aMovieLayoutError(
      'M4A smhd must have version/flags zero, balance zero, and reserved zero',
    );
  }
}

async function validateDataReference(
  reader: IsoBmffBoxReader,
  dataReference: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<void> {
  if (bodyLength(dataReference) < DREF_HEADER_BYTES) {
    throw new M4aMovieLayoutError('M4A dref FullBox header is truncated');
  }
  const header = await reader.readBytes(dataReference.dataStart, DREF_HEADER_BYTES, signal);
  if (
    header[0] !== 0 ||
    header[1] !== 0 ||
    header[2] !== 0 ||
    header[3] !== 0 ||
    new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4, false) !== 1
  ) {
    throw new M4aMovieLayoutError(
      'M4A dref must be version/flags zero and declare exactly one entry',
    );
  }

  const entries = reader.createChildCursor(dataReference, {
    start: dataReference.dataStart + DREF_HEADER_BYTES,
  });
  const entry = await entries.next(signal);
  if (entry === null) {
    throw new M4aMovieLayoutError('M4A dref must contain exactly one self-contained url entry');
  }
  if (entry.type !== 'url ') {
    throw new M4aMovieLayoutError(
      `External M4A data reference ${JSON.stringify(entry.type)} is not supported`,
    );
  }
  requireExactBodyLength(entry, URL_PAYLOAD_BYTES, 'M4A self-contained url');
  const url = await reader.readBytes(entry.dataStart, URL_PAYLOAD_BYTES, signal);
  if (url[0] !== 0 || url[1] !== 0 || url[2] !== 0 || url[3] !== 1) {
    throw new M4aMovieLayoutError(
      'M4A url data reference must be version zero and self-contained (flags=1)',
    );
  }
  if ((await entries.next(signal)) !== null) {
    throw new M4aMovieLayoutError('M4A dref must contain exactly one self-contained url entry');
  }
}

async function validateDataInformation(
  reader: IsoBmffBoxReader,
  dataInformation: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<void> {
  const cursor = reader.createChildCursor(dataInformation);
  let dataReference: Readonly<IsoBmffBoxRef> | null = null;
  for (;;) {
    const child = await cursor.next(signal);
    if (child === null) break;
    if (child.type !== 'dref') {
      throw new M4aMovieLayoutError(
        `Unknown M4A dinf box ${JSON.stringify(child.type)} is not admitted`,
      );
    }
    dataReference = assignUnique(dataReference, child, 'dinf/dref box');
  }
  if (dataReference === null) {
    throw new M4aMovieLayoutError('M4A dinf/dref box must appear exactly once');
  }
  await validateDataReference(reader, dataReference, signal);
}

async function readMediaInformation(
  reader: IsoBmffBoxReader,
  mediaInformation: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<Readonly<IsoBmffBoxRef>> {
  const cursor = reader.createChildCursor(mediaInformation);
  let soundHeader: Readonly<IsoBmffBoxRef> | null = null;
  let dataInformation: Readonly<IsoBmffBoxRef> | null = null;
  let sampleTable: Readonly<IsoBmffBoxRef> | null = null;

  for (;;) {
    const child = await cursor.next(signal);
    if (child === null) break;
    switch (child.type) {
      case 'smhd':
        soundHeader = assignUnique(soundHeader, child, 'minf/smhd box');
        break;
      case 'dinf':
        dataInformation = assignUnique(dataInformation, child, 'minf/dinf box');
        break;
      case 'stbl':
        sampleTable = assignUnique(sampleTable, child, 'minf/stbl box');
        break;
      case 'free':
      case 'skip':
        break;
      default:
        throw new M4aMovieLayoutError(
          `Unknown M4A minf box ${JSON.stringify(child.type)} is not admitted`,
        );
    }
  }

  if (dataInformation === null) {
    throw new M4aMovieLayoutError('M4A minf/dinf box must appear exactly once');
  }
  if (sampleTable === null) {
    throw new M4aMovieLayoutError('M4A minf/stbl box must appear exactly once');
  }
  if (soundHeader === null) {
    throw new M4aMovieLayoutError('M4A minf/smhd box must appear exactly once');
  }
  await validateSoundMediaHeader(reader, soundHeader, signal);
  await validateDataInformation(reader, dataInformation, signal);
  return sampleTable;
}

async function readAudioTrack(
  reader: IsoBmffBoxReader,
  track: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<Readonly<M4aAudioTrackLayout> | null> {
  // First retain only validated child references. No fixed body except hdlr is
  // touched until the handler has selected this as the one audio track.
  const trackChildren = await collectTrackChildren(reader, track, signal);
  const mediaChildren = await collectMediaChildren(reader, trackChildren.media, signal);
  const handlerType = await readHandlerType(reader, mediaChildren.handler, signal);
  if (handlerType !== 'soun') return null;

  validateSelectedAudioExtensions(trackChildren.extensions, 'trak');
  validateSelectedAudioExtensions(mediaChildren.extensions, 'mdia');

  const trackHeaderBox = requireExactlyOne(trackChildren.trackHeaders, 'audio trak/tkhd box');
  const mediaHeaderBox = requireExactlyOne(mediaChildren.mediaHeaders, 'audio mdia/mdhd box');
  const mediaInformation = requireExactlyOne(mediaChildren.mediaInformation, 'audio mdia/minf box');

  const trackHeader = parseM4aTrackHeader(
    await readFixedPayload(reader, trackHeaderBox, TKHD_PAYLOAD_BYTES, 'M4A tkhd', signal),
  );
  if (
    (trackHeader.flags & TRACK_ENABLED_FLAG) === 0 ||
    (trackHeader.flags & TRACK_IN_MOVIE_FLAG) === 0
  ) {
    throw new M4aMovieLayoutError('M4A audio track must be enabled and present in the movie');
  }
  const mediaHeader = parseM4aMediaHeader(
    await readFixedPayload(reader, mediaHeaderBox, MDHD_PAYLOAD_BYTES, 'M4A mdhd', signal),
  );
  const edit = await readEdit(reader, trackChildren.edits, signal);
  const stbl = await readMediaInformation(reader, mediaInformation, signal);

  return Object.freeze({ trackHeader, mediaHeader, edit, stbl });
}

/**
 * Read the strict non-fragmented movie/audio-track structure needed by the
 * bounded M4A demuxer. Large media and metadata bodies are retained only as
 * provenance-bearing box references.
 */
export async function readM4aMovieLayout(
  reader: IsoBmffBoxReader,
  moovRef: Readonly<IsoBmffBoxRef>,
  signal: AbortSignal,
): Promise<Readonly<M4aMovieLayout>> {
  if (!(reader instanceof IsoBmffBoxReader)) {
    throw new TypeError('M4A movie layout requires an IsoBmffBoxReader');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A movie layout requires an AbortSignal');
  }

  // Creating the cursor authenticates the exact reader-issued reference before
  // any caller-controlled box fields are inspected.
  const cursor = reader.createChildCursor(moovRef);
  if (moovRef.type !== 'moov') {
    throw new M4aMovieLayoutError('M4A movie-layout parent must be a moov box');
  }

  let movieHeaderBox: Readonly<IsoBmffBoxRef> | null = null;
  let metadataRoot: Readonly<IsoBmffBoxRef> | null = null;
  let directMetadata: Readonly<IsoBmffBoxRef> | null = null;
  const moovExtensions = new Set<string>();
  const tracks: Readonly<IsoBmffBoxRef>[] = [];

  for (;;) {
    const child = await cursor.next(signal);
    if (child === null) break;
    if (FRAGMENTED_BOX_TYPES.has(child.type)) {
      throw new M4aMovieLayoutError(
        `Fragmented M4A movie box ${JSON.stringify(child.type)} is not supported`,
      );
    }
    if (MOOV_PADDING_TYPES.has(child.type)) continue;
    switch (child.type) {
      case 'mvhd':
        movieHeaderBox = assignUnique(movieHeaderBox, child, 'moov/mvhd box');
        break;
      case 'trak':
        tracks.push(child);
        if (tracks.length > M4A_MAX_TRACK_BOXES) {
          throw new M4aMovieLayoutError(
            `M4A moov contains more than ${M4A_MAX_TRACK_BOXES} tracks`,
          );
        }
        break;
      case 'udta':
        metadataRoot = assignUnique(metadataRoot, child, 'moov/udta box');
        break;
      case 'meta':
        // Direct moov metadata is a standard harmless extension, but the
        // initial iTunSMPB reader deliberately authenticates only
        // moov/udta/meta. Retain uniqueness without presenting this ref as
        // iTun gapless evidence.
        directMetadata = assignUnique(directMetadata, child, 'moov/meta box');
        break;
      case 'elng':
      case 'tref':
        if (moovExtensions.has(child.type)) {
          throw new M4aMovieLayoutError(`M4A moov/${child.type} box must appear at most once`);
        }
        moovExtensions.add(child.type);
        break;
      default:
        throw new M4aMovieLayoutError(
          `Unknown M4A moov box ${JSON.stringify(child.type)} is not admitted`,
        );
    }
  }

  if (movieHeaderBox === null) {
    throw new M4aMovieLayoutError('M4A moov/mvhd box must appear exactly once');
  }
  if (tracks.length === 0) {
    throw new M4aMovieLayoutError('M4A moov must contain at least one trak box');
  }

  const movieHeader = parseM4aMovieHeader(
    await readFixedPayload(reader, movieHeaderBox, MVHD_PAYLOAD_BYTES, 'M4A mvhd', signal),
  );
  let audioTrack: Readonly<M4aAudioTrackLayout> | null = null;
  for (const track of tracks) {
    const candidate = await readAudioTrack(reader, track, signal);
    if (candidate === null) continue;
    if (audioTrack !== null) {
      throw new M4aMovieLayoutError('M4A initial subset requires exactly one audio track');
    }
    audioTrack = candidate;
  }
  if (audioTrack === null) {
    throw new M4aMovieLayoutError('M4A initial subset requires exactly one audio track');
  }

  reader.assertReadable(signal);
  return Object.freeze({ movieHeader, audioTrack, metadataRoot });
}

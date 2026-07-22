import { describe, expect, it } from 'vitest';
import { probeAudioChannelCount } from '../audio-header.ts';

function ascii(target: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) target[offset + i] = value.charCodeAt(i);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function blobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function mp4Box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length, false);
  ascii(bytes, 4, type);
  bytes.set(payload, 8);
  return bytes;
}

function wave(channels: number): Blob {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 0, 'RIFF');
  view.setUint32(4, 36, true);
  ascii(bytes, 8, 'WAVE');
  ascii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  ascii(bytes, 36, 'data');
  return new Blob([blobPart(bytes)], { type: 'audio/wav' });
}

function flac(channels: number): Blob {
  const bytes = new Uint8Array(42);
  ascii(bytes, 0, 'fLaC');
  bytes[4] = 0x80; // last metadata block, STREAMINFO
  bytes[7] = 34;
  bytes[20] = (channels - 1) << 1;
  return new Blob([blobPart(bytes)], { type: 'audio/flac' });
}

function oggPage(packets: Uint8Array[]): Uint8Array {
  if (packets.some((packet) => packet.length >= 255)) throw new Error('test packet too large');
  const header = new Uint8Array(27 + packets.length);
  ascii(header, 0, 'OggS');
  header[4] = 0;
  header[5] = 0x02; // BOS
  header[26] = packets.length;
  packets.forEach((packet, index) => {
    header[27 + index] = packet.length;
  });
  return concat(header, ...packets);
}

function opus(channels: number): Blob {
  const packet = new Uint8Array(19);
  ascii(packet, 0, 'OpusHead');
  packet[8] = 1;
  packet[9] = channels;
  return new Blob([blobPart(oggPage([packet]))], { type: 'audio/ogg' });
}

function vorbisWithFakeOpusComment(channels: number): Blob {
  const identification = new Uint8Array(30);
  identification[0] = 0x01;
  ascii(identification, 1, 'vorbis');
  identification[11] = channels;
  identification[29] = 0x01; // framing bit
  const comment = new Uint8Array(32);
  comment[0] = 0x03;
  ascii(comment, 1, 'vorbis');
  ascii(comment, 12, 'OpusHead');
  comment[21] = 1;
  return new Blob([blobPart(oggPage([identification, comment]))], { type: 'audio/ogg' });
}

function mp4AudioEntry(channels: number, type = 'mp4a'): Uint8Array {
  const entry = new Uint8Array(36);
  const view = new DataView(entry.buffer);
  view.setUint32(0, entry.length, false);
  ascii(entry, 4, type);
  view.setUint16(24, channels, false);
  return entry;
}

function quickTimeV2AudioEntry(channels: number): Uint8Array {
  const entry = new Uint8Array(72);
  const view = new DataView(entry.buffer);
  view.setUint32(0, entry.length, false);
  ascii(entry, 4, 'mp4a');
  view.setUint16(16, 2, false);
  view.setUint16(24, 3, false);
  view.setUint16(26, 16, false);
  view.setUint16(28, 0xfffe, false);
  view.setUint16(30, 0, false);
  view.setUint32(32, 65_536, false);
  view.setUint32(36, 72, false);
  view.setUint32(48, channels, false);
  return entry;
}

function mp4Track(entries: Uint8Array[], handlerType = 'soun'): Uint8Array {
  const entryBytes = concat(...entries);
  const payload = new Uint8Array(8 + entryBytes.length);
  new DataView(payload.buffer).setUint32(4, entries.length, false);
  payload.set(entryBytes, 8);
  const handler = new Uint8Array(12);
  ascii(handler, 8, handlerType);
  return mp4Box(
    'trak',
    mp4Box(
      'mdia',
      concat(mp4Box('hdlr', handler), mp4Box('minf', mp4Box('stbl', mp4Box('stsd', payload)))),
    ),
  );
}

function mp4Moov(entries: Uint8Array[], prefix: Uint8Array[] = []): Uint8Array {
  return mp4Box('moov', concat(...prefix, mp4Track(entries)));
}

function mp4FromEntries(entries: Uint8Array[], tail = false, moovPrefix: Uint8Array[] = []): Blob {
  const moov = mp4Moov(entries, moovPrefix);
  const ftypPayload = new Uint8Array(8);
  ascii(ftypPayload, 0, 'M4A ');
  const ftyp = mp4Box('ftyp', ftypPayload);
  if (!tail) return new Blob([blobPart(concat(ftyp, moov))], { type: 'audio/mp4' });
  const mediaPayload = new Uint8Array(300 * 1024);
  // A codec-looking sequence in mdat must never be parsed as an MP3 frame.
  mediaPayload.set([0xff, 0xfb, 0x90, 0x00], 128);
  return new Blob([blobPart(concat(ftyp, mp4Box('mdat', mediaPayload), moov))], {
    type: 'audio/mp4',
  });
}

function mp4(channels: number, tail = false, precedingChannels?: number): Blob {
  return mp4FromEntries(
    [
      ...(precedingChannels === undefined ? [] : [mp4AudioEntry(precedingChannels)]),
      mp4AudioEntry(channels),
    ],
    tail,
  );
}

function mp4WithFakeFinalMoovInMdat(realChannels: number, fakeChannels: number): Blob {
  const ftypPayload = new Uint8Array(8);
  ascii(ftypPayload, 0, 'M4A ');
  const fakeMoov = mp4Moov([mp4AudioEntry(fakeChannels)]);
  const finalMediaPayload = concat(new Uint8Array(300 * 1024), fakeMoov);
  return new Blob(
    [
      blobPart(
        concat(
          mp4Box('ftyp', ftypPayload),
          mp4Box('mdat', new Uint8Array(300 * 1024)),
          mp4Moov([mp4AudioEntry(realChannels)]),
          mp4Box('mdat', finalMediaPayload),
        ),
      ),
    ],
    { type: 'audio/mp4' },
  );
}

function mp4WithFakeLeadingMoovInMdat(realChannels: number, fakeChannels: number): Blob {
  const ftypPayload = new Uint8Array(8);
  ascii(ftypPayload, 0, 'M4A ');
  const fakeMoov = mp4Moov([mp4AudioEntry(fakeChannels)]);
  return new Blob(
    [
      blobPart(
        concat(
          mp4Box('ftyp', ftypPayload),
          mp4Box('mdat', concat(fakeMoov, new Uint8Array(300 * 1024))),
          mp4Moov([mp4AudioEntry(realChannels)]),
        ),
      ),
    ],
    { type: 'audio/mp4' },
  );
}

function id3TaggedAudio(payloadBytes: number, frame: Uint8Array): Blob {
  const header = new Uint8Array(10);
  ascii(header, 0, 'ID3');
  header[3] = 3;
  header[6] = (payloadBytes >> 21) & 0x7f;
  header[7] = (payloadBytes >> 14) & 0x7f;
  header[8] = (payloadBytes >> 7) & 0x7f;
  header[9] = payloadBytes & 0x7f;
  return new Blob([blobPart(header), blobPart(new Uint8Array(payloadBytes)), blobPart(frame)], {
    type: 'audio/mpeg',
  });
}

describe('bounded audio header channel probe', () => {
  it.each([
    ['WAV', wave(6), 6],
    ['FLAC', flac(8), 8],
    ['Ogg Opus', opus(2), 2],
    ['Ogg Vorbis with fake OpusHead comment', vorbisWithFakeOpusComment(8), 8],
    ['MP3', new Blob([blobPart(new Uint8Array([0xff, 0xfb, 0x90, 0xc0]))]), 2],
    ['AAC ADTS', new Blob([blobPart(new Uint8Array([0xff, 0xf1, 0x50, 0x80]))]), 8],
    [
      'large-ID3 MP3',
      id3TaggedAudio(300 * 1024, new Uint8Array([0xff, 0xfb, 0x90, 0xc0, 0xff, 0xf1, 0x50, 0x80])),
      2,
    ],
    ['large-ID3 AAC', id3TaggedAudio(300 * 1024, new Uint8Array([0xff, 0xf1, 0x50, 0x80])), 8],
    [
      'ID3 audio header straddles the first probe boundary',
      id3TaggedAudio(256 * 1024 - 12, new Uint8Array([0xff, 0xfb, 0x90, 0xc0])),
      2,
    ],
    ['MP4', mp4(2), 2],
    ['multi-track MP4', mp4(6, false, 2), 6],
    ['tail-moov MP4', mp4(6, true), 6],
    ['QuickTime v2 MP4', mp4FromEntries([quickTimeV2AudioEntry(8)]), 8],
    ['AC-3 MP4', mp4FromEntries([mp4AudioEntry(2, 'ac-3')]), 6],
    ['E-AC-3 MP4', mp4FromEntries([mp4AudioEntry(2, 'ec-3')]), 16],
    [
      'unknown audio entry beside stereo entry',
      mp4FromEntries([mp4AudioEntry(2), mp4AudioEntry(2, 'zzzz')]),
      32,
    ],
    [
      'unknown video entry does not widen audio',
      mp4FromEntries([mp4AudioEntry(2)], false, [mp4Track([mp4AudioEntry(1, 'avc1')], 'vide')]),
      2,
    ],
    [
      'large-moov MP4',
      mp4FromEntries([mp4AudioEntry(6)], false, [mp4Box('free', new Uint8Array(300 * 1024))]),
      6,
    ],
    ['fake leading moov inside mdat', mp4WithFakeLeadingMoovInMdat(6, 1), 6],
    ['fake final moov inside mdat', mp4WithFakeFinalMoovInMdat(6, 1), 6],
  ])('reads %s channels without decoding the file', async (_name, blob, expected) => {
    await expect(probeAudioChannelCount(blob)).resolves.toBe(expected);
  });

  it('prefers an ID3/MP3 byte signature over a misleading MP4 MIME label', async () => {
    const source = id3TaggedAudio(32, new Uint8Array([0xff, 0xfb, 0x90, 0xc0]));
    const mislabeled = new Blob([await source.arrayBuffer()], { type: 'audio/mp4' });

    await expect(probeAudioChannelCount(mislabeled)).resolves.toBe(2);
  });

  it('returns null for malformed or unknown bytes', async () => {
    await expect(probeAudioChannelCount(new Blob([new Uint8Array([1, 2, 3])]))).resolves.toBeNull();
  });
});

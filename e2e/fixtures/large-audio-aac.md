# Synthetic AAC regression fixtures

These files contain synthetic chirps created for MUSIXQUARE's tests. They contain
no recorded music or third-party audio. The left and right channels deliberately
differ so that a channel swap, false mono result or bad channel mapping is visible.
Their generating formula is:

```sh
ffmpeg -f lavfi -i 'aevalsrc=0.65*sin(2*PI*(220*t+40*t*t))|0.4*sin(2*PI*(330*t+27*t*t)):s=44100:d=5' -c:a pcm_s16le source-stereo.wav
```

`large-audio-chirp-lc-stereo.m4a` uses FFmpeg's native AAC encoder at 160 kbit/s.
`large-audio-chirp-lc-mono.m4a` uses the same source converted to mono, 48 kHz,
80 kbit/s. Their `.aac` files are packet-identical ADTS remuxes:

```sh
ffmpeg -i source-stereo.wav -c:a aac -b:a 160k large-audio-chirp-lc-stereo.m4a
ffmpeg -i source-stereo.wav -ar 48000 -ac 1 -c:a aac -b:a 80k large-audio-chirp-lc-mono.m4a
ffmpeg -i large-audio-chirp-lc-stereo.m4a -c:a copy -f adts large-audio-chirp-lc-stereo.aac
ffmpeg -i large-audio-chirp-lc-mono.m4a -c:a copy -f adts large-audio-chirp-lc-mono.aac
```

HE-AAC and HE-AAC v2 were encoded with fdkaac 1.0.5 / libfdk-aac 2.0.2.
`ffprobe` verifies their actual profiles as `HE-AAC` and `HE-AACv2`, respectively,
both at 44.1 kHz stereo. Merely changing an LC container's profile tag is not a
valid substitute. The primary M4A fixtures use ISO edit-list gapless signaling;
the ADTS fixtures contain the raw encoder delay, as that transport has no edit list.

```sh
fdkaac -S --no-timestamp -p 5 -b 64000 -G 1 -o large-audio-chirp-he-stereo.m4a source-stereo.wav
fdkaac -S --no-timestamp -p 5 -b 64000 -f 2 -o large-audio-chirp-he-stereo.aac source-stereo.wav
fdkaac -S --no-timestamp -p 29 -b 32000 -G 1 -o large-audio-chirp-hev2-stereo.m4a source-stereo.wav
fdkaac -S --no-timestamp -p 29 -b 32000 -f 2 -o large-audio-chirp-hev2-stereo.aac source-stereo.wav
```

The `lc-itunes.m4a` and `he-itunes.m4a` variants exercise fdkaac's default
`iTunSMPB` signaling instead of assuming every M4A comes from the same encoder:

```sh
fdkaac -S --no-timestamp -p 2 -b 128000 -o large-audio-chirp-lc-itunes.m4a source-stereo.wav
fdkaac -S --no-timestamp -p 5 -b 64000 -o large-audio-chirp-he-itunes.m4a source-stereo.wav
```

`lc-surround.m4a` validates six distinct native channel positions (L/R/C/LFE/BL/BR)
against the incremental decoder's channel order, at 48 kHz:

```sh
ffmpeg -f lavfi -i 'aevalsrc=0.6*sin(2*PI*(120*t+19*t*t))|0.5*sin(2*PI*(200*t+23*t*t))|0.4*sin(2*PI*(280*t+27*t*t))|0.3*sin(2*PI*60*t)|0.2*sin(2*PI*(440*t+31*t*t))|0.1*sin(2*PI*(520*t+35*t*t)):s=48000:d=5:c=5.1' -c:a aac -b:a 256k large-audio-chirp-lc-surround.m4a
```

`lc-leading-edit.m4a` preserves the LC packets but adds a one-second leading
empty edit, exercising MP4 tracks with a positive first packet timestamp. It is
a rejection fixture: the bounded engine keeps this unverified edit layout out
of its supported set rather than silently falling back to full-file decoding.

```sh
ffmpeg -itsoffset 1 -i large-audio-chirp-lc-stereo.m4a -c:a copy large-audio-chirp-lc-leading-edit.m4a
```

`he-explicit.m4a` and `hev2-explicit.m4a` contain the same genuinely HE-encoded
packets as their `*-stereo.m4a` originals. Their `esds` AudioSpecificConfig is
rewritten from backward-compatible SBR/PS extension signaling to the equivalent
explicit audio object types 5 and 29. No LC stream is relabeled as HE. The
replacement stays within the existing descriptor length using zero padding;
`ffprobe` and Chromium both verify the resulting HE/HEv2 streams.

```js
// Replace these exact AudioSpecificConfig bytes inside the esds descriptor.
// All other bytes, including compressed packets and edit lists, stay intact.
// HE:   objectType=5, core=22050Hz, channels=2, extension=44100Hz, coreType=2.
// HEv2: objectType=29, core=22050Hz, channels=1, extension=44100Hz, coreType=2.
const replacements = {
  he: { before: [0x13, 0x90, 0x56, 0xe5, 0xa0], after: [0x2b, 0x92, 0x08, 0, 0] },
  hev2: {
    before: [0x13, 0x88, 0x56, 0xe5, 0xa5, 0x48, 0x80],
    after: [0xeb, 0x8a, 0x08, 0, 0, 0, 0],
  },
};
```

The temporary Windows encoder was downloaded from the
[RareWares fdkaac distribution](https://www.rarewares.org/aac-encoders.php).
The `fdkaac-1.0.5-x64.zip` archive's SHA-256 was
`2717cf55c641326cd7551f337ca5b2220764ce21aea609b24dd3d52755f32d4a`.
The encoder binary is not included in the repository or app. Tests only need
the resulting fixtures, so running CI requires neither this encoder nor FFmpeg.

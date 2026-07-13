# Universal bounded streaming engine

- **Status:** accepted; implementation in progress behind the existing V2 gate
- **Date:** 2026-07-13
- **Supersedes:** the FLAC-only codec scope in `streaming-playback-engine-v2.md`
- **Storage parent:** `browser-media-storage-policy.md`

## Decision

Long-form WAV, AIFF, CAF, FLAC, MP3, AAC, and M4A playback will converge on
one bounded PCM renderer and one room-clock/rendezvous timeline. A codec or
container adapter may differ in parsing, seeking, preroll, decoder delay, and
packet indexing, but it must not introduce a different audible clock.

The long-file path is:

```text
EncodedAudioSource
  -> bounded format probe and metadata reader
  -> format-specific decoder adapter in a Worker
  -> bounded planar Float32 PCM messages
  -> shared PCM ring AudioWorklet
  -> shared room clock, rendezvous, and product audio graph
```

This replaces the earlier product target where only FLAC streamed and ordinary
formats depended on whole-file `decodeAudioData`.

## Non-negotiable invariants

1. File duration does not determine the engine working set. Every encoded read,
   decoder queue, PCM message, and renderer ring has an explicit bound.
2. Media bodies and decoded PCM remain RAM-only. The playback engine does not
   write OPFS or IndexedDB.
3. `MediaElement` is not a playback backend. Every supported bounded format is
   rendered by the same PCM AudioWorklet clock.
4. No bounded path constructs a whole-file `ArrayBuffer` or whole-track
   `AudioBuffer`.
5. Local Blob, peer range, and future R2 record delivery implement the same
   exact, abort-aware `EncodedAudioSource.readAt` contract. Transport selection
   is independent of codec selection.
6. Codec/container coordinates do not escape their adapter. The shared source
   sees only an audible media timeline: sample rate, channel count, total media
   frames, and output frames.
7. Encoder delay, end padding, MP3 bit-reservoir preroll, AAC priming, FLAC seek
   anchors, and container packet tables belong to adapters.
8. A decoder generation is not ready until both the decoder adapter and PCM
   ring have acknowledged the same generation. Stale generations are inert.
9. Arm, finalize, pause, seek, stop, start evidence, underrun health, and room
   revision authority remain codec-neutral.
10. Encoded-source ownership transfers exactly once and every partial open,
    abort, failure, or destroy path closes it exactly once.

## Common interfaces

`EncodedAudioSource` owns exact bounded byte reads. A format adapter owns the
decoder and exposes normalized information plus lifecycle operations:

```ts
interface StreamingDecoderInfo {
  mediaSampleRateHz: number;
  channelCount: number;
  totalMediaFrames: number;
}

interface BoundedStreamingDecoderAdapter {
  readonly info: StreamingDecoderInfo;
  open(options: { signal: AbortSignal }): Promise<void>;
  startGeneration(options: {
    generation: number;
    targetMediaFrame: number;
    outputSampleRateHz: number;
    pcmPort: MessagePort;
    signal: AbortSignal;
  }): Promise<void>;
  stopGeneration(generation: number): void;
  close(): Promise<void>;
}
```

The exact runtime contract may add canonical failure callbacks and ownership
receipts, but it must not expose a codec descriptor to the common renderer.

## Format rollout

| Phase | Containers/codecs   | Initial supported subset                                  | Seek model                                      |
| ----- | ------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| 1     | Native FLAC         | Existing bounded libFLAC path                             | verified frame anchors and sparse index         |
| 2     | RIFF/RF64/BW64 WAVE | PCM u8/s16/s24/s32, IEEE float32/64, extensible PCM/float | O(1) from `dataOffset + frame * blockAlign`     |
| 3     | AIFF/AIFC           | NONE/twos/sowt/fl32/fl64                                  | O(1) PCM frame addressing                       |
| 4     | CAF                 | LPCM first                                                | O(1) fixed-packet addressing                    |
| 5     | MP3                 | MPEG audio with Xing/Info/VBRI support                    | sparse frame index plus reservoir preroll       |
| 6     | raw AAC             | ADTS first                                                | sparse access-unit index plus priming           |
| 7     | M4A/MP4             | AAC first; ALAC is a separate codec capability            | ISO BMFF sample tables and edit/gapless mapping |

File extensions are hints only. Selection is content-first, and container and
codec are reported separately. Unsupported compressed WAVE/CAF, ADIF,
LATM/LOAS, fragmented MP4, or ALAC must fail explicitly until their adapter
capability exists; they must not silently fall back into an unbounded path.

## Implementation status

This table records implementation progress, not production availability. The
V2 product gate remains off for every row until the release gate below is
satisfied.

| Capability                                                              | Status                                                                             | Product route |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------- |
| Codec-neutral bounded source, decoder adapter, PCM ring, and room clock | implemented and regression-tested                                                  | gated off     |
| Native FLAC                                                             | implemented on the common renderer                                                 | gated off     |
| RIFF/RF64/BW64 WAVE linear PCM                                          | implemented on the shared linear-PCM worker                                        | gated off     |
| AIFF/AIFC linear PCM                                                    | implemented on the shared linear-PCM worker                                        | gated off     |
| CAF LPCM                                                                | implemented on the shared linear-PCM worker                                        | gated off     |
| MP3                                                                     | strict parser/index/timeline and frame decoder implemented; worker/adapter pending | unavailable   |
| ADTS AAC                                                                | design in progress                                                                 | unavailable   |
| M4A/MP4 AAC                                                             | design in progress                                                                 | unavailable   |

WAVE, AIFF/AIFC, and CAF do not own container-specific renderers. Their
metadata readers normalize verified byte geometry into one linear-PCM decoder,
one Worker protocol, and the same bounded renderer used by the room timeline.

### MP3 decoder checkpoint

The MP3 path currently proves ID3 boundaries, complete Layer III frame
geometry, Xing/Info/VBRI declarations, bit-reservoir pointers, exact seek
seeds, and encoder-tag CRCs before decoding. Free-format Layer III remains an
explicitly unsupported capability; it is not guessed from adjacent sync words.

`mpg123-decoder@1.0.3` is pinned as the audited PCM runtime. It runs with
upstream gapless trimming disabled, accepts only scanner-verified audio frames,
and never receives the leading Xing/Info/VBRI structural frame. Media
coordinates are mapped explicitly with the verified Layer III decoder delay:

```text
decoderDelay = 529
headTrim = encoderDelay + decoderDelay
tailTrim = max(endPadding - decoderDelay, 0)
```

If the gapless extension is absent or fails validation, neither the encoder
values nor the decoder delay are guessed; the full raw frame timeline remains
audible. Every seek starts a fresh decoder Worker realm, supplies bounded
reservoir and synthesis history, discards to the exact global raw coordinate,
and terminates the realm instead of invoking the upstream `reset()` or
`free()` cleanup paths. Product routing remains unavailable until that Worker
and adapter lifecycle is implemented and soaked.

## Memory model

- Encoded reads remain bounded by the encoded-source port limit.
- Decoder output messages remain bounded by both frame count and byte count.
- The renderer ring is capped by bytes as well as duration; channel count and
  output sample rate therefore cannot multiply a nominal 12-second ring into
  an uncontrolled allocation.
- Prime depth is derived from the smaller safe capacity and must leave headroom
  for active decode and transfer buffers.
- At most the manager's admitted current/candidate sources may own live rings
  and decoders.

The exact byte budgets are implementation constants with device-test evidence,
not part of the wire protocol.

## Decoder policy

The renderer does not depend on one decoding API. Modern platforms may use a
WebCodecs adapter after `AudioDecoder.isConfigSupported` proves the exact codec
configuration. Platforms without the required decoder use a pinned,
format-specific WASM implementation. Both routes emit the same canonical PCM
messages and are tested against the same timeline fixtures.

A compressed-audio dependency is not admitted merely because it decodes a
whole file. Before adoption it must pass full-versus-sliced PCM equivalence,
seek/preroll, gapless-frame-count, corruption fail-closed, repeated lifecycle,
bounded-heap, and iOS Worker tests. A wrapper that cannot prove safe ownership
or exact sample mapping is replaced or patched behind a repository-owned
runtime boundary before any factory route can select it.

Container demux and codec decode remain separate. A browser decoder accepting
AAC does not imply that it can parse M4A, and a file extension does not prove
either capability.

## Delivery policy

Local files use a Blob-backed random-access source. LAN sharing uses peer range
requests. R2 may later expose authenticated record/range reads through another
`EncodedAudioSource`; that change does not alter format adapters or the room
clock. Multipart upload/resume is therefore infrastructure work, not a media
renderer backend.

## Release gate

The existing V2 product gate stays off until all of the following pass:

- unit fixtures for every enabled container/codec and malformed counterpart;
- mono, stereo, 4-, 6-, and 8-channel rendering;
- 44.1, 48, 88.2, 96, 176.4, and 192 kHz, plus explicit high-rate rejection or
  bounded operation where claimed;
- long-duration memory soak with no duration-proportional growth;
- first start, pause/resume, seek, replay, next, late join, reconnect, and
  background recovery;
- iOS host to Windows guest and Windows host to iOS guest;
- start/drift p95, underrun, and start-evidence measurements;
- capability mismatch isolates only the unsupported participant;
- no legacy file side effect can race the V2 owner.

Any release bundle containing the embedded mpg123 runtime must also ship the
required LGPL-2.1-only notices, corresponding source, and relink materials at
the documented distribution location. A passing browser build alone does not
satisfy this release gate.

Production enablement and rollback are separate commits. Until then the current
live product and its rollback checkpoint remain unchanged.

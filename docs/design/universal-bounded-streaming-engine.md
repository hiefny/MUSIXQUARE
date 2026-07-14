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

This table records repository implementation progress, not production
availability. Native FLAC and supported linear PCM are selected only inside an
enabled V2 document. MP3, ADTS, and M4A are additionally controlled by the
immutable bounded-route policy. Their factories, owner/stager integration, and
decoder paths are implemented, but the production singleton does not install
that optional policy, so those formats retain their current route. This ADR
does not assert that a deployed build enables the independent V2 bootstrap
gate.

| Capability                                                              | Repository status                                                                                              | Product selection in this revision       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Codec-neutral bounded source, decoder adapter, PCM ring, and room clock | implemented and regression-tested                                                                              | depends on the independent V2 build gate |
| Native FLAC                                                             | implemented on the common renderer                                                                             | selected only in an enabled V2 document  |
| RIFF/RF64/BW64 WAVE linear PCM                                          | implemented on the shared linear-PCM worker                                                                    | selected only in an enabled V2 document  |
| AIFF/AIFC linear PCM                                                    | implemented on the shared linear-PCM worker                                                                    | selected only in an enabled V2 document  |
| CAF LPCM                                                                | implemented on the shared linear-PCM worker                                                                    | selected only in an enabled V2 document  |
| MP3                                                                     | parser, decoder, Worker, factory, direct/manifest peer source, and lifecycle integration implemented           | optional product policy not installed    |
| ADTS AAC                                                                | scanner, WebCodecs decoder, factory, authenticated manifest peer source, and lifecycle integration implemented | optional product policy not installed    |
| M4A/MP4 AAC                                                             | bounded ISO-BMFF parser, WebCodecs decoder, factory, peer source, and lifecycle integration implemented        | optional product policy not installed    |

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
`free()` cleanup paths.

The Worker, decoder adapter, thin common-renderer wrapper, format factory, and
product owner/stager path are implemented. A repeated-lifecycle soak covers 128
fresh decoder generations, 256 retired leases whose physical reads ignore
cancellation, and 3,300 serial bounded PCM demands over a real
`MessageChannel`. Peer delivery uses direct range reads when frame-count
metadata makes guest reconstruction bounded, and an authenticated timeline
manifest otherwise. The optional MP3 bounded-route policy remains absent from
the production singleton, so this checkpoint does not claim production
availability.

### ADTS AAC decoder checkpoint

The first ADTS capability is intentionally narrower than the syntax that the
header parser can describe. After an optional bounded chain of validated
leading ID3v2 tags, playback admission requires a contiguous MPEG-4 AAC-LC
frame span with one raw data block per frame, no CRC, a constant sample
rate/configuration, and mono or stereo channel configuration. The exact
nonzero `audioStartByte` is preserved through host manifest sealing, guest
reconstruction, scan, seek, and decode; the terminal frame must still end at
the physical source EOF. MPEG-2, AAC Main/SSR/LTP/HE, CRC-protected frames,
multiple raw data blocks, and in-band Program Config Elements fail explicitly
until their own fixtures and decoder evidence exist.

ADTS has no general byte-offset table or trustworthy gapless metadata. The
adapter must therefore verify the complete frame span with bounded reads,
build a bounded sparse access-unit index, expose an untrimmed `1024 * N` media
timeline, and use a fresh decoder generation plus measured bounded preroll for
seek. No callback-to-access-unit one-to-one relationship may be assumed.

The first shipping AAC decoder cohort is WebCodecs-only. WebKit added
`AudioDecoder` in Safari 26, but a browser/version label is not admission
evidence. Every device still requires both `AudioDecoder.isConfigSupported()`
and a real canary decode for the exact configuration. Safari versions before
26, or any implementation that fails either check, reject bounded AAC/M4A
playback explicitly; they must not fall back to a whole-file `AudioBuffer`, a
`MediaElement`, or another unbounded path. See the official
[WebKit Safari 26 feature summary](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
and [Safari 26 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes).

The canary proves that the selected browser decoder emits bounded AAC-LC core
geometry for a real frame. It does not parse `raw_data_block()` and therefore
cannot prove that an input lacks in-band SBR or PS when a browser silently
ignores those extensions. Strict input admission remains the responsibility of
payload validation or the repository-owned decoder. Expanded rate, channel, or
frame output still fails closed before PCM enters the renderer.

Backend selection is generation-explicit. An open command names exactly one
backend and the ready event echoes it. A Worker must fail if that backend is
unavailable; it must not silently switch from WebCodecs to WASM inside the same
generation. A retry selects a new backend in a fresh generation so room
coordination can observe the change.

The ADTS factory and host/guest owner path are implemented, including the
authenticated manifest-prefixed peer-range source used to avoid a mandatory
guest-side whole-file scan. The only implemented decoder cohort is still the
strict WebCodecs cohort described above, and the optional ADTS product policy
is not installed in the production singleton. Implementation therefore must
not be read as a shipping support claim.

AAC has two distinct consistency contracts:

- Timeline exactness is mandatory for every admitted backend: 1024 core frames
  per access unit, no dropped or duplicated frame, the same target coordinate,
  and the same rendezvous time.
- Sample-value equivalence is claimed only for the same pinned decoder artifact
  and the same fresh-generation anchor/preroll plan. It is not claimed between
  browser WebCodecs implementations or between WebCodecs and WASM.

Perceptual Noise Substitution state can continue across access units and need
not converge after a short seek preroll. If sample coherence across room
channels is required, all peers use the same pinned fallback artifact and move
together to a candidate generation opened from one common anchor. The current
one-AU transform preroll is bounded startup policy, not a PNS bitwise guarantee.

A repository-owned WASM decoder remains a possible future compatibility
expansion, not a prerequisite for the Safari 26+ WebCodecs cohort. Symphonia
`v0.6.0` is only a deferred candidate and is not an admitted dependency.
Admission would still require a repository-owned raw-AU ABI, fail-closed
SBR/PS/SAC patch, fixed WASM memory, reproducible artifact manifest and digest,
malformed-input/lifecycle soak, and MPL-2.0 corresponding-source notices. Its
artifact digest and ABI would become a new room-visible backend profile; it
could not silently join or replace the current WebCodecs cohort.

### M4A AAC container checkpoint

M4A does not introduce a second audio clock or a whole-file container decode.
The initial subset walks exact ISO-BMFF box boundaries, skips `mdat` bodies,
and accepts non-fragmented, self-contained `mp4a.40.2` tracks only. Tail-`moov`
and greater-than-4-GiB `mdat` layouts are handled with safe-integer coordinates;
box headers and table pages remain bounded to at most 64 KiB per physical read.

The codec boundary is native AAC, not synthesized ADTS. An `mp4a` sample entry
must supply either the exact two-byte AAC-LC AudioSpecificConfig or FFmpeg's
canonical five-byte no-SBR form. The latter is admitted only when its sync
extension explicitly declares SBR absent and all remaining padding bits are
zero; SBR, PS, SAC, and arbitrary suffixes remain rejected. WebCodecs receives
the raw `raw_data_block()` access unit together with the complete validated
configuration as `AudioDecoderConfig.description`; ADTS continues to use
description-absent ADTS chunks. One decoder generation pins one framing
contract and may not switch between them after its canary or first decode.

The admitted M4A timing model is proven from sample tables instead of inferred
from file duration:

```text
rawCoreFrames       = accessUnitCount * 1024
presentationEnd     = sum(stts)
headTrim            = exact elst media_time or validated iTunSMPB priming
tailTrim            = rawCoreFrames - presentationEnd
totalMediaFrames    = presentationEnd - headTrim
```

Every non-terminal AAC access unit has an `stts` delta of 1,024; only the final
unit may be shorter. `mdhd`, edit-list, and iTunSMPB evidence must agree. No AAC
priming or end padding is guessed when metadata is absent. Large `stts`, `stsz`,
and chunk-offset tables are validated in pages and represented by bounded sparse
checkpoints rather than arrays proportional to track duration.

The metadata checkpoint now emits one exact, structured-clone-safe manifest for
the admitted AAC-LC track. It captures the source size and immutable identity,
AAC configuration, normalized audible timeline, `stsz` pages, complete bounded
`stsc` body, chunk-offset pages, and `mdat` ranges. At the current
origin-trusted, structurally-untrusted same-app boundary, a Worker rebinds the
source identity and reauthenticates the table
headers and source-derived `stsc` runs before it may issue a decoder runtime;
remaining table pages are authenticated lazily. Codec, timeline, container
diagnostics, and declared `mdat` ranges are canonicalized but are not reparsed
during that reopen, so an external or otherwise untrusted manifest requires
separate authentication before this boundary can accept it. Transferred
normalized runs are never runtime authority on their own. The factory and
product owner/stager path are implemented, but selection still requires the
optional M4A bounded-route policy that the production singleton does not
install.

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
message shape and are tested against the same exact timeline fixtures; this
does not assert bitwise sample equality across different decoder backends.

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

Do not install the optional MP3/ADTS/M4A bounded-route policy in the production
singleton until all of the following pass. Production selection is fail-closed:
the V2 flag must equal the exact string `1` and the tracked constant
`FILE_PLAYBACK_V2_PRODUCTION_RELEASE_ENABLED` must be `true`. The universal
route additionally requires its own flag to equal the exact string `1`.
With the latch off, every production flag combination remains
`legacy-current`; remote builder flags are never sufficient authority. The
constant remains `false` until release approval; enablement changes only that
latch line to `true`, and rollback changes the same line back to `false` before
rebuilding the static application.

The exact Vite mode `e2e-universal` is the only latch exception. It still
requires both exact build flags and exists solely to exercise the isolated
candidate artifact; near-match mode names and ordinary production builds do
not receive the exception.

Every candidate checkpoint builds and verifies three mutually isolated
profile/cohort artifacts:

1. exact `e2e-universal`, which must select `v2-universal-v1`;
2. production with the V2 flag on and universal flag off, which must select
   `legacy-current` while the latch is off and `v2-current` after the one-line
   enable; and
3. production with both flags on, which must select `legacy-current` while the
   latch is off and `v2-universal-v1` after the one-line enable.

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
- valid AAC-LC native canary decode on every claimed WebCodecs browser, plus
  explicit SBR, PS, and SAC fail-closed fixtures;
- room-visible AAC backend profile selection, exact ready echo, and no silent
  fallback inside a decoder generation;
- same-artifact/same-anchor AAC PCM equivalence and cross-backend timeline/frame
  count equivalence;
- no legacy file side effect can race the V2 owner.

Any release bundle containing the embedded mpg123 runtime must also ship the
required LGPL-2.1-only notices, corresponding source, and relink materials at
the documented distribution location. A passing browser build alone does not
satisfy this release gate.

Any release bundle containing the proposed Symphonia AAC WASM must likewise
ship the exact MPL-2.0 covered source and local patch corresponding to the
published artifact, the MPL license text, artifact/build manifest, and a stable
source location tied to the release revision.

Production enablement and rollback are separate commits. Until then the tracked
latch stays off, and the current live product and its rollback checkpoint remain
unchanged.

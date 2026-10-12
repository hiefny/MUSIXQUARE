# System Sync Compensation

This table tracks per-platform sync compensation used by MUSIXQUARE.

Last YouTube compensation review: 2026-10-12 (local change, not yet deployed).
Other compensation rows retain their individual review dates.

## Sign Convention

| Mode                 | Positive offset                                        | Negative offset                                             |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| Local file           | Plays that device's audio earlier                      | Plays that device's audio later                             |
| YouTube manual sync  | Moves this device's YouTube target position forward    | Moves this device's YouTube target position backward        |
| System audio sharing | Adds receiver playout delay, so that guest hears later | Reduces receiver playout delay, so that guest hears earlier |

## Shared System-Audio Buffering

The standard-room P2P/SFU and PRO-room SFU system-audio receive paths currently
request a `playoutDelayHint` of **0.5 seconds** where the browser supports it.
This is a shared jitter-buffer target intended to reduce cross-device variance;
it is not a measured per-platform compensation and therefore is not added to
the platform-delta column below.

The PRO `lan-direct-v1` receiver does **not** currently set that hint. It uses
the browser's default WebRTC jitter buffering only after the transport-selected
(or sole nominated), succeeded host-to-host candidate pair is reached through a
valid UUID-shaped remote `.local` mDNS candidate. Candidate-bearing SDP and
numeric remote candidates are rejected; browsers without usable mDNS, global or
malformed addresses, and missing or ambiguous candidate-pair statistics select
SFU. A browser-redacted selected address is accepted only through an exact
foundation-and-port match to the strict mDNS candidate ledger for that route.
Consequently, direct and SFU delivery can have different absolute latency even
though both use the same platform-delta table.

### PRO direct-to-SFU promotion

LAN-direct is an all-participant route for one publisher and at most three
receivers. One failed initial target starts SFU under the already allocated
`publicationId`; one failed or incompatible late target promotes an already-live
direct publication to SFU under that same ID. A fifth active device instead
revokes the system-audio share. The promotion is one-way, so a live publication
does not oscillate between two jitter-buffer regimes and direct signaling is
rejected once canonical state is SFU. The identity continuity is an authority
fence, not a claim of sample-continuous or equal-latency handoff: receivers
accept the authenticated equal-rank replacement only for the same publication
and then use the SFU path's 0.5-second hint where supported.

No automatic hidden platform compensation is added or removed during
promotion. A user's system-audio manual value retains the sign convention above
and composes with whichever receiver buffer the current canonical route uses.

### P2P receive replacement and failure contract

The active P2P system-audio `MediaConnection` is an identity-fenced resource.
Every asynchronous stream-attachment step rechecks that the connection is
still current before publishing audio state. Replacing a connection publishes
the replacement identity before closing its predecessor, so a synchronous
stale `close` callback cannot clear the successor.

If the current stream cannot initialize its audio graph, has no usable tracks,
or otherwise rejects during asynchronous attachment, the guest immediately
cleans up the failed receive state and shows the receive-failed toast. A later
call can then retry without waiting for PeerJS to emit a separate `error` or
`close`. A failure from a superseded connection is a no-op and must not tear
down the replacement.

## Current Compensation Table

| Playback mode        | Platform |    Hidden compensation | UI manual default | Why                                                                                                                                      | File                                                                                                                                                    | Section / symbol                                                                                                                                             | Last updated | Status |
| -------------------- | -------- | ---------------------: | ----------------: | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------ |
| Local file           | Windows  |                 +20 ms |              0 ms | Windows WebAudio output was observed about 20 ms late versus mobile devices.                                                             | `src/player/transport.ts`                                                                                                                               | `WINDOWS_LOCAL_FILE_OUTPUT_ADVANCE_SEC`, `getPlatformLocalFileOutputOffset()`, `_internalPlay()`, `getTrackPosition()`                                       | 2026-06-03   | Active |
| Local file           | Android  |                   0 ms |              0 ms | No platform baseline confirmed yet.                                                                                                      | `src/player/transport.ts`                                                                                                                               | `getPlatformLocalFileOutputOffset()`                                                                                                                         | 2026-06-03   | Watch  |
| Local file           | iOS      |                   0 ms |              0 ms | No platform baseline confirmed yet.                                                                                                      | `src/player/transport.ts`                                                                                                                               | `getPlatformLocalFileOutputOffset()`                                                                                                                         | 2026-06-03   | Watch  |
| Local file           | macOS    |                   0 ms |              0 ms | No platform baseline confirmed yet.                                                                                                      | `src/player/transport.ts`                                                                                                                               | `getPlatformLocalFileOutputOffset()`                                                                                                                         | 2026-06-03   | Watch  |
| YouTube | Android | own fixed output baseline +250 ms | 0 ms | Owner device tests reported 250 ms audio lag; app default, with startup latency separate. | `src/youtube/output-latency.ts`, `src/youtube/authority-arm.ts`, `src/youtube/sync.ts` | `getYouTubeAudibleOutputDelayMs()` | 2026-10-12 | Local, pending release |
| YouTube              | Windows  |                   0 ms |              0 ms | No platform baseline confirmed yet.                                                                                                      | `src/youtube/sync.ts`                                                                                                                                   | `getEffectiveYouTubePlayLatencyMs()`, `guestRendezvousSync()`                                                                                                | 2026-06-03   | Watch  |
| YouTube              | iOS      |                   0 ms |              0 ms | No platform baseline confirmed yet.                                                                                                      | `src/youtube/sync.ts`                                                                                                                                   | `getEffectiveYouTubePlayLatencyMs()`, `guestRendezvousSync()`                                                                                                | 2026-06-03   | Watch  |
| YouTube              | macOS    |                   0 ms |              0 ms | No platform baseline confirmed yet.                                                                                                      | `src/youtube/sync.ts`                                                                                                                                   | `getEffectiveYouTubePlayLatencyMs()`, `guestRendezvousSync()`                                                                                                | 2026-06-03   | Watch  |
| System audio sharing | Windows  |                   0 ms |              0 ms | No platform-specific baseline confirmed; LAN-direct uses the browser default buffer, while P2P/SFU paths request the shared 500 ms hint. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts`, `src/network/pro-system-audio-sfu.ts`, `src/network/pro-system-audio-direct.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()`, `RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" })` | 2026-08-19   | Watch  |
| System audio sharing | Android  |                   0 ms |              0 ms | No platform-specific baseline confirmed; LAN-direct uses the browser default buffer, while P2P/SFU paths request the shared 500 ms hint. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts`, `src/network/pro-system-audio-sfu.ts`, `src/network/pro-system-audio-direct.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()`, `RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" })` | 2026-08-19   | Watch  |
| System audio sharing | iOS      |                   0 ms |              0 ms | No platform-specific baseline confirmed; LAN-direct uses the browser default buffer, while P2P/SFU paths request the shared 500 ms hint. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts`, `src/network/pro-system-audio-sfu.ts`, `src/network/pro-system-audio-direct.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()`, `RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" })` | 2026-08-19   | Watch  |
| System audio sharing | macOS    |                   0 ms |              0 ms | No platform-specific baseline confirmed; LAN-direct uses the browser default buffer, while P2P/SFU paths request the shared 500 ms hint. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts`, `src/network/pro-system-audio-sfu.ts`, `src/network/pro-system-audio-direct.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()`, `RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" })` | 2026-08-19   | Watch  |

## YouTube output baseline

The owner tested two Android tablets, five Galaxy devices and a Xiaomi device
and reported audio 250 ms behind the YouTube media timeline. The 2026-10-12
decision makes this an application default for detected Android on all playing
paths, not a claim about every browser or output route. The value is defined once
in `constants.ts` and read through `output-latency.ts`.

- PRO follows the independent server timeline. Android schedules its release
  250 ms early; if the available lead is shorter, only the missing fixed output
  lead advances the media position. Learned startup lead remains separate and
  is only applied on eligible zero-starts.
- Standard also follows a canonical room position. Every device, including the
  host, applies only its own output correction and its own manual setting. The
  host subtracts its actually applied local delta before publishing room time;
  changing that host's manual setting does not move the guests. No new platform
  field is added to ordinary STATE/SYNC frames. The existing zero-start platform
  field remains part of that protocol's startup calibration.
- An Android Standard host can physically reach ENDED before the canonical
  room position reaches the end. An occurrence-fenced hold drains that output
  interval before normal next/repeat handling, while canonical time continues.
  A new playback action cancels the obsolete hold.
- Manual input remains unchanged, including its +/-9.999-second limit. Automatic
  output correction is composed after the input clamp. Zero-position holds and
  media-end guards remain necessary. Paused targets receive no output advance.
- Calibration removes the known output contribution before learning startup
  latency. Existing Standard stored estimates are not reset. PRO estimates
  remain session-local.
- Explicit Android UA or Android UA-CH is sufficient; Linux plus touch is not.
  A device hiding Android in both sources cannot be identified reliably.
  Mixed old/new clients are a release compatibility limit; local tests use the
  new policy on both endpoints. See the linked implementation report.

## Notes

Standard-host YouTube edits use the same device play-latency reader for a
[host-only scheduled rendezvous](design/standard-host-youtube-manual-sync.md).
Both Standard and PRO edits retain this device's fixed output component. Startup
learning remains separate. The local-to-canonical conversion removes the actual
physical advance, including the automatic contribution, before exporting time.
See [implementation and verification](design/android-youtube-output-baseline-2026-10-12.md).

- Hidden compensation should stay separate from the user-facing manual sync value.
- User-facing manual sync should remain a fine-tuning control, not the place where known platform defaults are stored.
- When adding a platform default, record the observed symptom and the interpretation of the sign.
- Prefer tiny platform defaults such as 20 ms only when repeatedly confirmed, because browser audio latency can vary by device, output route, Bluetooth, and power state.
- System audio sharing is a live WebRTC stream. It cannot be repositioned like a decoded local file; any future platform delta must compose deliberately with the shared receiver hint and be verified across reconnects and browser implementations.
- LAN-direct and SFU should be measured as separate transport cohorts. A lower
  LAN median must not be encoded as an operating-system default, and an SFU
  promotion should be included in every future compensation test matrix.

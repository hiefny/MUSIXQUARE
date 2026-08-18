# System Sync Compensation

This table tracks per-platform sync compensation used by MUSIXQUARE.

Last static source review: 2026-08-19

## Sign Convention

| Mode                 | Positive offset                                        | Negative offset                                             |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| Local file           | Plays that device's audio earlier                      | Plays that device's audio later                             |
| YouTube manual sync  | Moves the guest's YouTube target position forward      | Moves the guest's YouTube target position backward          |
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
| YouTube              | Android  | play call 250 ms early |              0 ms | Android YouTube iframe audible output was observed late versus desktop/iOS.                                                              | `src/youtube/constants.ts`, `src/youtube/sync.ts`                                                                                                       | `ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS`, `getEffectiveGuestPlayLatencyMs()`, `guestRendezvousSync()`                                                         | 2026-06-03   | Active |
| YouTube              | Windows  |                   0 ms |              0 ms | No platform baseline confirmed yet.                                                                                                      | `src/youtube/sync.ts`                                                                                                                                   | `getEffectiveGuestPlayLatencyMs()`, `guestRendezvousSync()`                                                                                                  | 2026-06-03   | Watch  |
| YouTube              | iOS      |                   0 ms |              0 ms | No platform baseline confirmed yet.                                                                                                      | `src/youtube/sync.ts`                                                                                                                                   | `getEffectiveGuestPlayLatencyMs()`, `guestRendezvousSync()`                                                                                                  | 2026-06-03   | Watch  |
| YouTube              | macOS    |                   0 ms |              0 ms | No platform baseline confirmed yet.                                                                                                      | `src/youtube/sync.ts`                                                                                                                                   | `getEffectiveGuestPlayLatencyMs()`, `guestRendezvousSync()`                                                                                                  | 2026-06-03   | Watch  |
| System audio sharing | Windows  |                   0 ms |              0 ms | No platform-specific baseline confirmed; LAN-direct uses the browser default buffer, while P2P/SFU paths request the shared 500 ms hint. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts`, `src/network/pro-system-audio-sfu.ts`, `src/network/pro-system-audio-direct.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()`, `RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" })` | 2026-08-19   | Watch  |
| System audio sharing | Android  |                   0 ms |              0 ms | No platform-specific baseline confirmed; LAN-direct uses the browser default buffer, while P2P/SFU paths request the shared 500 ms hint. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts`, `src/network/pro-system-audio-sfu.ts`, `src/network/pro-system-audio-direct.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()`, `RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" })` | 2026-08-19   | Watch  |
| System audio sharing | iOS      |                   0 ms |              0 ms | No platform-specific baseline confirmed; LAN-direct uses the browser default buffer, while P2P/SFU paths request the shared 500 ms hint. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts`, `src/network/pro-system-audio-sfu.ts`, `src/network/pro-system-audio-direct.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()`, `RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" })` | 2026-08-19   | Watch  |
| System audio sharing | macOS    |                   0 ms |              0 ms | No platform-specific baseline confirmed; LAN-direct uses the browser default buffer, while P2P/SFU paths request the shared 500 ms hint. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts`, `src/network/pro-system-audio-sfu.ts`, `src/network/pro-system-audio-direct.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()`, `RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" })` | 2026-08-19   | Watch  |

## Notes

- Hidden compensation should stay separate from the user-facing manual sync value.
- User-facing manual sync should remain a fine-tuning control, not the place where known platform defaults are stored.
- When adding a platform default, record the observed symptom and the interpretation of the sign.
- Prefer tiny platform defaults such as 20 ms only when repeatedly confirmed, because browser audio latency can vary by device, output route, Bluetooth, and power state.
- System audio sharing is a live WebRTC stream. It cannot be repositioned like a decoded local file; any future platform delta must compose deliberately with the shared receiver hint and be verified across reconnects and browser implementations.
- LAN-direct and SFU should be measured as separate transport cohorts. A lower
  LAN median must not be encoded as an operating-system default, and an SFU
  promotion should be included in every future compensation test matrix.

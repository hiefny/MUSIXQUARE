# System Sync Compensation

This table tracks per-platform sync compensation used by MUSIXQUARE.

Last static source review: 2026-07-11

## Sign Convention

| Mode | Positive offset | Negative offset |
| --- | --- | --- |
| Local file | Plays that device's audio earlier | Plays that device's audio later |
| YouTube manual sync | Moves the guest's YouTube target position forward | Moves the guest's YouTube target position backward |
| System audio sharing | Adds receiver playout delay, so that guest hears later | Reduces receiver playout delay, so that guest hears earlier |

## Shared System-Audio Buffering

Both P2P and SFU system-audio receive paths currently request a
`playoutDelayHint` of **0.5 seconds** where the browser supports it. This is a
shared jitter-buffer target intended to reduce cross-device variance; it is not
a measured per-platform compensation and therefore is not added to the
platform-delta column below.

## Current Compensation Table

| Playback mode | Platform | Hidden compensation | UI manual default | Why | File | Section / symbol | Last updated | Status |
| --- | --- | ---: | ---: | --- | --- | --- | --- | --- |
| Local file | Windows | +20 ms | 0 ms | Windows WebAudio output was observed about 20 ms late versus mobile devices. | `src/player/transport.ts` | `WINDOWS_LOCAL_FILE_OUTPUT_ADVANCE_SEC`, `getPlatformLocalFileOutputOffset()`, `_internalPlay()`, `getTrackPosition()` | 2026-06-03 | Active |
| Local file | Android | 0 ms | 0 ms | No platform baseline confirmed yet. | `src/player/transport.ts` | `getPlatformLocalFileOutputOffset()` | 2026-06-03 | Watch |
| Local file | iOS | 0 ms | 0 ms | No platform baseline confirmed yet. | `src/player/transport.ts` | `getPlatformLocalFileOutputOffset()` | 2026-06-03 | Watch |
| Local file | macOS | 0 ms | 0 ms | No platform baseline confirmed yet. | `src/player/transport.ts` | `getPlatformLocalFileOutputOffset()` | 2026-06-03 | Watch |
| YouTube | Android | play call 250 ms early | 0 ms | Android YouTube iframe audible output was observed late versus desktop/iOS. | `src/youtube/constants.ts`, `src/youtube/sync.ts` | `ANDROID_YOUTUBE_PLAY_LATENCY_FLOOR_MS`, `getEffectiveGuestPlayLatencyMs()`, `guestRendezvousSync()` | 2026-06-03 | Active |
| YouTube | Windows | 0 ms | 0 ms | No platform baseline confirmed yet. | `src/youtube/sync.ts` | `getEffectiveGuestPlayLatencyMs()`, `guestRendezvousSync()` | 2026-06-03 | Watch |
| YouTube | iOS | 0 ms | 0 ms | No platform baseline confirmed yet. | `src/youtube/sync.ts` | `getEffectiveGuestPlayLatencyMs()`, `guestRendezvousSync()` | 2026-06-03 | Watch |
| YouTube | macOS | 0 ms | 0 ms | No platform baseline confirmed yet. | `src/youtube/sync.ts` | `getEffectiveGuestPlayLatencyMs()`, `guestRendezvousSync()` | 2026-06-03 | Watch |
| System audio sharing | Windows | 0 ms | 0 ms | No platform-specific baseline confirmed; the shared 500 ms receiver hint applies first. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()` | 2026-07-11 | Watch |
| System audio sharing | Android | 0 ms | 0 ms | No platform-specific baseline confirmed; the shared 500 ms receiver hint applies first. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()` | 2026-07-11 | Watch |
| System audio sharing | iOS | 0 ms | 0 ms | No platform-specific baseline confirmed; the shared 500 ms receiver hint applies first. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()` | 2026-07-11 | Watch |
| System audio sharing | macOS | 0 ms | 0 ms | No platform-specific baseline confirmed; the shared 500 ms receiver hint applies first. | `src/network/system-audio-guest.ts`, `src/network/system-audio-sfu.ts` | `SYSTEM_AUDIO_PLAYOUT_DELAY_S`, receiver `playoutDelayHint` block, `setReceiverDelay()` | 2026-07-11 | Watch |

## Notes

- Hidden compensation should stay separate from the user-facing manual sync value.
- User-facing manual sync should remain a fine-tuning control, not the place where known platform defaults are stored.
- When adding a platform default, record the observed symptom and the interpretation of the sign.
- Prefer tiny platform defaults such as 20 ms only when repeatedly confirmed, because browser audio latency can vary by device, output route, Bluetooth, and power state.
- System audio sharing is a live WebRTC stream. It cannot be repositioned like a decoded local file; any future platform delta must compose deliberately with the shared receiver hint and be verified across reconnects and browser implementations.

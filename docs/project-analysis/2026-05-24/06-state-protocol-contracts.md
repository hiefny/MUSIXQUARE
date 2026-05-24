# State and Protocol Contracts

This file captures the cross-module contracts that future code changes should preserve.

## Core Rule

Do not treat the state tree as a free-form object. It is the app's runtime contract.

Important rules:

- Use `getState`, `setState`, and `batchSetState` from `src/core/state.ts`.
- State paths are typed through `StatePath`.
- `getState()` returns shallow immutable views for objects/arrays/maps/sets.
- State mutations emit typed `state:*` events.
- Direct writes to `playback.lifecycle` should go through `src/player/lifecycle.ts::transition()` or the narrow ownership helpers.
- Production code should not use legacy `appState`; it is intentionally absent.

## Top-Level State Domains

Source: `src/types/index.ts::StateTree`.

| Domain | Main owner | Purpose | Risk if changed carelessly |
| --- | --- | --- | --- |
| `setup` | setup UI/app bootstrap | Whether session setup has started. | Overlays and join/host flow can desync. |
| `player` | player/decode/transport/UI | Current track timing, seek flag, track metadata, decode failures. | Playback UI, sync, media session, and recovery can disagree. |
| `share.remote` | remote-share | Upload/download status, progress, blob URL, errors. | Remote guests can hang or show stale progress. |
| `transfer` | storage transfer | Direct file receive/send status, session IDs, metadata, stale chunk counters. | File transfer races and stale chunks can corrupt current playback. |
| `preload` | storage preload | Next-track preload metadata, session state, ack tracking, next blob. | Preload promotion can collide with foreground track switching. |
| `audio` | audio engine/effects/settings | Volume, channel, EQ, reverb, stereo width, virtual bass, sub frequency. | Host/guest audio settings can diverge. |
| `demo` | demo mode | Demo active/loading/effects toggles. | Demo exit/restore can leave app in wrong mode. |
| `sync` | sync/shared clock/YouTube | Local offsets, latency history, YouTube local offset. | Playback convergence and manual sync can drift. |
| `network` | peer/host/guest/chat | Role, IDs, connection objects, slots, OP, room password, chat policy. | Authority, room membership, and chat controls can break. |
| `playlist` | playlist/player/UI | Items, current index, repeat, shuffle. | Track changes and preload target selection can break. |
| `files` | decode/storage/player | Current file blob and current track name. | Decode/playback/recovery can target wrong file. |
| `youtube` | YouTube modules | Current subindex, playlist subitems, guest play latency. | YouTube playlist/rendezvous sync can break. |
| `recovery` | storage recovery/playback | Recovery pending/retry counters. | Guests can retry wrong file or spam host. |
| `systemAudio` | system audio modules | Guest receiving state. | UI ownership and restore behavior can desync. |
| `playback` | player ownership/lifecycle | Media owner, activity, file lifecycle, pending play/recovery, failed tracks. | Central playback contract breaks across modules. |

## Playback State Contract

Source files:

- `src/core/constants.ts`
- `src/player/ownership.ts`
- `src/player/lifecycle.ts`
- `src/types/index.ts`

### Mode

`playback.mode` values:

| Value | Meaning |
| --- | --- |
| `null` | No active media owner. |
| `file` | Local file pipeline is current/selected owner. |
| `youtube` | YouTube iframe/player is current owner. |
| `system-audio` | System audio sharing/receiving is current owner. |

### Activity

`playback.activity` values:

| Value | Meaning |
| --- | --- |
| `idle` | No active user-visible playback. |
| `pending` | A media path is preparing, loading, transferring, decoding, or waiting. |
| `playing` | Media is actively producing or expected to produce playback. |
| `paused` | Media is selected/loaded but not advancing. |

### File Lifecycle

`playback.lifecycle` values:

| Value | Meaning |
| --- | --- |
| `IDLE` | No file pipeline active. |
| `DOWNLOADING` | Main file transfer/download active. |
| `AWAITING_PRELOAD` | Preload-promoted path selected but blob not ready yet. |
| `DECODING` | Blob available and `decodeAudioData` running. |
| `READY` | Decoded buffer loaded, awaiting play. |
| `PLAYING` | File playback active. |
| `PAUSED` | File playback paused with decoded buffer. |
| `FAILED` | Decode/timeout/unavailable state. |

Important nuance:

- YouTube and system audio do not use `playback.lifecycle`; they have their own domain state.
- Any non-`IDLE` file lifecycle implies file pipeline involvement.
- `playback.mode` and `playback.activity` are the public two-axis contract.
- `getPlaybackOwnership()` may derive ownership from mode/activity plus lifecycle, transfer state, current track metadata, and system audio receiving state.

## Playback Write Helpers

Source: `src/player/ownership.ts`.

Use these helpers instead of ad hoc cross-module state writes:

| Helper family | Purpose |
| --- | --- |
| `setPlaybackLifecycleState(...)` | Writes file lifecycle and synchronizes mode/activity. |
| `setPlaybackTransferState(...)` | Writes transfer state and synchronizes ownership. |
| `setSystemAudioReceiving(...)` | Writes system audio receive state and synchronizes ownership. |
| `claimPlaybackOwner(...)` / domain claim helpers | Claim active media owner. |
| `releasePlaybackOwner(...)` / domain release helpers | Release active media owner. |
| `setPlaybackIdle(...)` | Return public playback state to idle. |
| `getPlaybackOwnership()` | Full derived ownership view. |
| `getPlaybackModeActivity()` | Public mode/activity view. |
| `isPlaybackPlayingFile/YouTube/SystemAudio(...)` | Mode-specific predicates. |
| `isExternalOwner(...)` | Safety check for file pipeline versus external owners. |
| `isPlaybackIdleCompat()` | Narrow legacy-compatible predicate only. |

Do not add broad new state flags if the value can be derived from lifecycle, transfer, metadata, and mode/activity.

## File Lifecycle Event Contract

Source: `src/player/lifecycle.ts`.

The lifecycle state machine accepts typed events, including:

- `FILE_PREPARE`
- `FILE_START`
- `FILE_CHUNK`
- `FILE_END`
- `FILE_RESUME`
- `PLAY_PRELOADED`
- `PRELOAD_START`
- `PRELOAD_CHUNK`
- `PRELOAD_END`
- `PRELOAD_FILE_READY`
- `PLAY`
- `PAUSE`
- `TRACK_ENDED`
- `DECODE_SUCCESS`
- `DECODE_TIMEOUT`
- `DECODE_ERROR`
- `CHUNK_WATCHDOG_STALL`
- `PREPARE_WATCHDOG_TIMEOUT`
- `PRELOAD_STALL`
- `PRELOAD_CEILING`
- `LOAD_TOKEN_MISMATCH`
- `REMOTE_FILE_UNAVAILABLE`
- `HOST_AUTO_ADVANCE`

Transition resolver behavior:

- Legal transitions return a next state.
- Expected no-ops return `stay`.
- Disallowed combinations are logged and ignored.
- The app intentionally does not throw on rejected transitions.

This is the right behavior for a real-time app: a single stale packet should not crash the page.

## Event Bus Contract

Source:

- `src/core/events.ts`
- `src/types/index.ts::EventMap`

The event bus consists of:

- Hand-authored domain events in `BaseEventMap`.
- Auto-derived state events in `StateEvents`.

State event shape:

```text
state:${StatePath}
```

Examples:

- `state:playback.mode`
- `state:playback.activity`
- `state:playback.lifecycle`
- `state:transfer.state`
- `state:player.currentTrackMeta`
- `state:systemAudio.isReceiving`

Ownership synchronization listens to:

- `state:playback.lifecycle`
- `state:transfer.state`
- `state:player.currentTrackMeta`
- `state:systemAudio.isReceiving`

That means changing any of those source paths can change public mode/activity.

## Protocol Message Categories

Source:

- `src/core/constants.ts::MSG`
- `src/types/index.ts::ProtocolMap`
- `src/network/protocol.ts`

### Handshake and Session

Messages:

- `welcome`
- `session-full`
- `force-close-duplicate`
- `device-list-update`
- `kick-device`
- `operator-grant`
- `operator-revoke`
- `operator-toast`
- `request-rename`

Authority:

- Host sends room/session authority messages.
- Guests should trust these only from `hostConn`.
- Host owns slot/device/operator decisions.

### Playback

Messages:

- `play`
- `pause`
- `play-preloaded`
- `request-play`
- `request-pause`
- `request-seek`
- `request-skip-time`
- `request-next-track`
- `request-prev-track`
- `request-track-change`

Authority:

- Host broadcasts `play` and `pause`.
- Guests drop `play`/`pause` frames not arriving through `hostConn`.
- OP guests request control; host verifies operator status before applying.

### File Transfer

Messages:

- `file-prepare`
- `file-start`
- `file-chunk`
- `file-end`
- `file-wait`
- `file-resume`
- `remote-file-share`
- `remote-file-unavailable`
- `request-current-file`
- `request-data-recovery`

Authority and policy:

- Host owns current file transfer.
- Guests accept broadcast transfer frames only from host connection.
- File chunk payloads are bounded and sessioned.
- Remote/unknown peers should not receive file data over TURN.
- Remote guests use encrypted remote-share descriptors instead.

### Preload

Messages:

- `preload-start`
- `preload-chunk`
- `preload-end`
- `preload-ack`
- `preload-abort`

Authority:

- Host sends preload frames.
- Guests accept preload frames only from `hostConn`.
- Preload is speculative and local-only.
- Remote speculative preload is disabled.

### YouTube

Messages:

- `youtube-play`
- `youtube-stop`
- `youtube-state`
- `youtube-sync`
- `youtube-sub-title-update`
- `youtube-playlist-info`
- `request-youtube-play`
- `request-youtube-pause`
- `request-youtube-toggle`
- `request-youtube-sub-seek`
- `request-youtube-playlist-info`

Authority:

- Host broadcasts YouTube state/sync.
- Guests drop host-like YouTube messages not from `hostConn`.
- OP guests request controls.
- Playlist info requests are host-served.

### Shared Clock

Messages:

- `sync-ping`
- `sync-pong`
- `sync-request`

Contract:

- `sync-pong` includes `mode`, `activity`, `position`, and `trackIndex`.
- It no longer carries legacy `appState`.

### Audio Settings

Messages:

- `volume`
- `eq-update`
- `eq-reset`
- `preamp`
- `reverb`
- `reverb-type`
- `reverb-decay`
- `reverb-predelay`
- `reverb-lowcut`
- `reverb-highcut`
- `stereo-width`
- `vbass`
- `request-setting`
- `request-eq-reset`

Authority:

- Host broadcasts settings.
- Guests accept setting broadcasts only from `hostConn`.
- OP guests may request setting changes.
- Host verifies OP before applying OP requests.

### Chat

Messages:

- `chat`
- `chat-mute`
- `chat-unmute`
- `chat-freeze`
- `chat-unfreeze`
- `chat-clear`
- `chat-whisper`
- `chat-notice`
- `chat-slowmode`
- `chat-filter`
- `chat-system`
- `request-chat-command`

Authority:

- Host enforces mute/freeze/filter/slowmode.
- Guest-side host messages should come from `hostConn`.
- OP-only chat commands are checked server-side by host state, not trusted client claims.

### System Audio

Messages:

- `system-audio-start`
- `system-audio-sfu-ready`
- `system-audio-stop`

Authority:

- Host starts/stops system audio.
- SFU readiness metadata is validated structurally.
- Media streams must match trusted host/system-audio metadata.

## Protocol Validation Contract

Source: `src/network/protocol.ts`.

Validation covers:

- Known message type.
- Numeric finite values.
- Non-negative indices.
- Chunk bounds.
- Max file/preload total chunk count.
- Remote-share size limits.
- YouTube IDs/playlists/subindices.
- Audio setting ranges.
- Chat payload shape.
- Playlist list length.
- System-audio SFU ready shape.

Inbound rate limiting:

- Per-peer token bucket.
- Non-chunk messages are limited.
- `file-chunk` and `preload-chunk` are exempt because they are high-rate legitimate traffic and separately bounded.
- Buckets are reset on disconnect.

## Production Hook Contract

Development/E2E hooks exist for tests:

- `__MUSIXQUARE_GET_STATE__`
- `__MUSIXQUARE_SET_STATE__`
- `__MUSIXQUARE_BUS__`

Production guard:

- `scripts/assert-production-build-clean.mjs` scans `dist/` after build.
- `npm run build:checked` fails if those hooks leak.

This is a good pattern. If adding more test hooks, update the guard.

## Current Contract Mismatch

Confirmed mismatch:

- Production state no longer has `appState`.
- `sync-pong` carries `mode` and `activity`, not `appState`.
- Some E2E tests still read `__MUSIXQUARE_GET_STATE__('appState')`.

Impact:

- Production contract is cleaner.
- E2E contract is stale.

Recommended permission-gated remediation:

- Migrate E2E helper language to mode/activity/lifecycle.
- Avoid re-adding appState as a compatibility shim unless there is an explicit reason. A shim would hide stale tests instead of making them match production semantics.


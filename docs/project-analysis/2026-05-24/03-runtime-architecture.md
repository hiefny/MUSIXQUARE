# Runtime Architecture Deep Dive

> **Historical snapshot (2026-05-24).** Module names and runtime flows may have
> moved since this audit. Verify every path against the current source before
> using it for implementation work.

## Boot Order

Main entry: `src/app.ts`.

The app is a long-lived singleton browser runtime. It initializes core services, then domain modules, then UI, then optional browser integrations. The approximate boot shape is:

1. Import and initialize core state/events/logging helpers.
2. Initialize i18n and DOM translation behavior.
3. Initialize audio graph and audio settings.
4. Initialize network/peer orchestration and protocol handlers.
5. Initialize storage, transfer, preload, recovery, and remote-share paths.
6. Initialize player lifecycle, playlist, decode, transport, media controls.
7. Initialize YouTube handlers, iframe/search/sync surfaces.
8. Initialize setup overlays, controls, tabs, dialogs, toasts, visualizer, chat.
9. Register keyboard shortcuts, visibility handling, wake lock/no-sleep behavior.
10. Register service worker in production/dev conditions.

This order matters because many modules register event handlers at import/init time. A later module often assumes earlier contracts exist.

## State Model

Primary state owner: `src/core/state.ts`.

The state tree is typed through `StateTree` and `StatePath` in `src/types/index.ts`. State paths are updated with dot-path helpers:

- `getState(path)`
- `setState(path, value)`
- `batchSetState(updates)`
- `snapshot()`
- `resetState()`

State changes emit through the bus as `state:${path}` events.

Important state domains:

- `setup`
- `player`
- `share.remote`
- `transfer`
- `preload`
- `audio`
- `demo`
- `sync`
- `network`
- `playlist`
- `files`
- `youtube`
- `recovery`
- `systemAudio`
- `playback`

Development/E2E hooks:

- `window.__MUSIXQUARE_GET_STATE__`
- `window.__MUSIXQUARE_SET_STATE__`
- `window.__MUSIXQUARE_BUS__`

These are exposed only in dev/e2e/test-hook modes and guarded from production build output.

## Event Bus

Primary file: `src/core/events.ts`.

The bus is typed through `EventMap`. It supports:

- `on`
- `once`
- `off`
- `emit`
- `clear`
- debug inspection
- scoped cleanup through `createBusScope`

The event bus is the app's main cross-module signaling mechanism. State events and domain events both pass through this layer.

## Playback Ownership Contract

Primary files:

- `src/player/ownership.ts`
- `src/player/lifecycle.ts`
- `src/core/constants.ts`
- `src/types/index.ts`

The current design separates:

- Room/media owner: `playback.mode`
- User-visible activity: `playback.activity`
- File playback lifecycle: `playback.lifecycle`

Valid modes:

- `file`
- `youtube`
- `system-audio`
- `null`

Valid activities:

- `idle`
- `paused`
- `playing`
- `pending`

File lifecycle states are richer and domain-specific:

- idle
- downloading
- awaiting preload
- decoding
- ready
- playing
- paused
- failed

Important conclusion:

- Legacy `appState` is not the production source of truth.
- Broad "is anything playing?" checks should use ownership helpers.
- Exact old idle semantics, where still needed, are isolated behind compatibility helpers.
- Production tests guard against reintroducing broad `appState` usage.

## Protocol Architecture

Primary files:

- `src/types/index.ts`
- `src/network/protocol.ts`
- `src/core/constants.ts`

The app's peer protocol is centralized as typed messages. `ProtocolMap` and `AnyProtocolMsg` define message shapes, while `network/protocol.ts` validates and dispatches incoming payloads.

Protocol safety patterns:

- Unknown message types are rejected.
- High-risk message payloads have structural validators.
- Numeric bounds are checked for positions, chunk indices, chunk counts, settings, playlist IDs, and remote-share sizes.
- Inbound non-chunk messages are rate-limited per peer.
- Chunk messages are treated specially because regular rate limits would break file transfer.
- Host/guest/operator authority is enforced by handlers and request paths.

Examples of protocol domains:

- Room/session: welcome, full, duplicate, rename, device list, kick.
- Playback: play, pause, seek, skip, track end.
- Transfer: file prepare/start/chunk/end/resume/wait.
- Preload: preload start/chunk/end/abort.
- YouTube: state, sync, play/pause/seek, playlist/subitem handling.
- Audio settings: EQ, reverb, channel, reset.
- System audio: start/stop/ready/SFU metadata.
- Chat and command surfaces.

## Transport Architecture

Primary files:

- `src/network/transport/types.ts`
- `src/network/transport/index.ts`
- `src/network/transport/config.ts`
- `src/network/transport/cloudflare-signaling.ts`
- `src/network/transport/peerjs-adapter.ts`

The transport layer abstracts:

- Peer creation.
- Data connections.
- Media calls.
- Cloudflare signaling versus PeerJS.
- Runtime/env transport overrides.

Default production Cloudflare signaling URL:

- `wss://signal.musixquare.com/api/rooms`

Development/local behavior:

- Local hostnames default toward PeerJS unless runtime/env config overrides.

TURN/STUN:

- STUN defaults are always available.
- TURN credentials are fetched through capability-protected app worker endpoints.
- Cloudflare TURN is primary, with legacy Metered fallback behavior.

## Host Flow

Primary files:

- `src/network/peer.ts`
- `src/network/host.ts`
- `src/network/peer-state.ts`

High-level flow:

1. Host initializes network transport.
2. Host creates a cryptographically random six-digit session code.
3. Host retries if the room ID is taken.
4. Incoming guest connections are accepted and assigned slots.
5. Duplicate/old connections are cleaned up.
6. Guest receives welcome, device list, and current room metadata.
7. Host monitors connection type and later rechecks.
8. Host broadcasts state/device changes.
9. Host enforces max guests, room password, OP, rename, kick.

Key risks:

- Duplicate connection replacement.
- Stale close/error events from old connections.
- Slot/device list consistency.
- Connection type detection timeout.
- Remote/unknown guest classification affecting transfer policy.

## Guest Flow

Primary files:

- `src/network/guest.ts`
- `src/ui/setup.ts`
- `src/network/peer.ts`

High-level flow:

1. Guest enters room code and optional password.
2. Guest initializes network transport if needed.
3. Guest opens connection to host room ID.
4. A timeout guards connection open.
5. Only the current host connection can mutate guest state.
6. Welcome, session-full, force-close, device-list, OP grant/revoke, kick, and rename messages are handled.
7. Guest starts sync worker timer after connection.
8. Connection type may be locally detected or host-reported.

Key risks:

- Previous host connection cleanup.
- Late messages from stale host connection.
- Reconnect/pending join behavior.
- Password mismatch and duplicate-device flows.

## File Playback Flow

Primary files:

- `src/player/playlist.ts`
- `src/player/decode.ts`
- `src/player/playback.ts`
- `src/player/transport.ts`
- `src/storage/transfer-send.ts`
- `src/storage/transfer-receive.ts`
- `src/storage/storage.ts`

Host local-file path:

1. User selects or switches to a file track.
2. Playlist clears stale preload/transfer intent as needed.
3. Decode path creates a load token/session guard.
4. Audio decode runs with timeout.
5. Current file blob and transfer metadata are published after decode success.
6. Playback transport starts/stops/seeks through Web Audio.
7. Host broadcasts file metadata and play/pause/seek messages.
8. Direct local peers receive file chunks.
9. Remote peers receive remote-share descriptors instead.

Guest direct-transfer path:

1. Guest receives FILE_PREPARE/START/CHUNK/END.
2. Transfer receive code tracks session ID, expected chunk, reorder buffer, and watchdog.
3. Early chunks are buffered.
4. Stale or superseded sessions are skipped.
5. Completed blob is written to RAM storage.
6. Decode/playback is triggered or resumed depending on pending play state.

Race controls:

- Session IDs.
- Load tokens.
- Chunk watchdogs.
- Pending play snapshots.
- Skip predicates.
- Preload-promoted state.
- Active broadcast session guards.
- Abort controllers.

## Remote Share Flow

Primary files:

- `src/share/remote-share.ts`
- `src/share/r2-client.ts`
- `src/share/crypto.ts`
- `src/network/peer-state.ts`
- `src/storage/transfer-receive.ts`

Purpose:

- Avoid sending file data over TURN.
- Give remote/unknown guests a viable file path.
- Keep file contents encrypted at rest in R2.

High-level flow:

1. Host determines some peers are remote/unknown or not direct-data targets.
2. Host prepares the complete file as one private remote object.
3. Host requests a remote-share session from R2 worker.
4. Host uploads the object via a presigned URL.
5. Host sends the download descriptor over the WebRTC control channel.
6. Guest downloads the authorized whole object.
7. Guest converts it to a File/Blob for RAM storage/decode.

Important policy:

- Remote-share descriptors are for active/current tracks, not speculative remote preload.
- Demo tracks avoid R2.
- Active foreground download is single-flight; newer requests abort older ones.
- Remote-share wait timeout is long enough to tolerate large uploads/downloads.

## Preload Flow

Primary files:

- `src/storage/preload.ts`
- `src/player/playlist.ts`
- `src/storage/transfer-send.ts`
- `src/storage/transfer-receive.ts`

Purpose:

- Prepare the next local track before playback switches.

Important constraints:

- Speculative preload is local-only.
- Remote preload is disabled; remote guests use remote-share for actual current tracks.
- Background transfers are serialized rather than killed mid-stream.
- Generation counters abort stale schedules.
- Session caps prevent unlimited memory growth.

Preload risks:

- Interaction with active foreground transfer.
- Same-track replay.
- Remote-local promotion.
- Playlist shuffle/repeat changes.
- Host rapid track switching.

## YouTube Together Flow

Primary files:

- `src/youtube/player.ts`
- `src/youtube/iframe.ts`
- `src/youtube/sync.ts`
- `src/youtube/search.ts`
- `src/youtube/constants.ts`
- `src/youtube/_state.ts`

Host flow:

1. User enters/searches/selects YouTube URL/video/playlist.
2. Iframe API loads or reuses an existing player.
3. Host enters YouTube playback mode.
4. Host broadcasts YouTube state.
5. Host schedules two-stage autosync.
6. Stage 1 shares current state.
7. Stage 2 broadcasts rendezvous/manual sync if playing.
8. Host sends heartbeat/sync snapshots.

Guest flow:

1. Guest receives YouTube state.
2. Guest loads matching video/playlist/subitem.
3. Guest handles readiness/autoplay constraints.
4. Guest applies sync snapshots, latency calibration, and drift correction.

Special handling:

- iOS gesture preservation.
- YouTube API script timeout.
- Unavailable video detection.
- Playlist scraping and indexing.
- Live stream warning.
- Iframe crash detection/rebuild.
- Ad detection and sync suppression.
- Latency persistence in localStorage.

## System Audio Flow

Primary files:

- `src/audio/system-capture.ts`
- `src/network/system-audio-host.ts`
- `src/network/system-audio-guest.ts`
- `src/network/system-audio-sfu.ts`
- `src/network/system-audio-debug.ts`

Host flow:

1. Host requests display/system audio capture.
2. Captured audio is split/routed depending on role/channel needs.
3. Host claims `system-audio` playback ownership.
4. Host broadcasts system-audio start metadata.
5. Guests receive stream through P2P or SFU path.
6. Host mutes local capture output as needed.

Stop/restore flow:

1. Host stops streams and tracks.
2. Host broadcasts system-audio stop.
3. App restores previous mode if possible:
   - YouTube can be restored room-wide.
   - File playback can return to paused/idle with prior track metadata.
4. State ownership returns to the previous or idle state.

Risks:

- Browser capture permission differences.
- Track ended events.
- P2P/SFU adapter switching.
- Mobile support limitations.
- Restoring previous mode without stale state.

## UI Architecture

Primary files:

- `src/ui/dom.ts`
- `src/ui/setup.ts`
- `src/ui/setup-host.ts`
- `src/ui/setup-guest.ts`
- `src/ui/setup-shared.ts`
- `src/ui/player-controls.ts`
- `src/ui/playlist-view.ts`
- `src/ui/connect.ts`
- `src/ui/settings.ts`
- `src/ui/chat.ts`
- `src/ui/dialog.ts`
- `src/ui/toast.ts`
- `src/ui/visualizer.ts`

The UI is manual DOM orchestration. It uses:

- Static HTML IDs.
- Data attributes.
- Class toggles.
- Event listeners.
- MutationObserver for overlays and i18n.
- ARIA attributes in key controls.

Notable UI contract:

- `src/ui/dom.ts` has a central overlay registry.
- The overlay registry drives both `body.overlay-open` and inert/focus behavior.
- Dialog overlay is centered/non-fullscreen and intentionally remains interactive above fullscreen overlays.

UI risks:

- Static HTML and TypeScript controllers can drift.
- Inner HTML is used in controlled spots, requiring escaping discipline.
- Long-lived event listeners need idempotent setup.
- Visual behavior needs browser-level verification, not just unit tests.

## i18n Architecture

Primary files:

- `src/i18n/index.ts`
- `src/i18n/ko.ts`
- `src/i18n/en.ts`

Behavior:

- Language is resolved from localStorage or browser language.
- `setLanguageMode()` persists the selected language.
- `data-i18n` writes textContent.
- `data-i18n-html` writes innerHTML through `tHtml()`.
- Attribute translation covers placeholder, aria-label, title, alt, and data-placeholder.
- MutationObserver translates dynamically inserted DOM.
- `i18n:changed` notifies components with cached labels.

Risk:

- Dictionary keys are extensive.
- HTML translation blocks are powerful and must remain trusted/local.
- Dynamic component text must listen to `i18n:changed` or refresh itself.

## Cloudflare Edge Architecture

### App Worker

File: `cloudflare/app-worker.js`.

Responsibilities:

- Security headers.
- CORS for trusted origins.
- Capability token configuration and minting.
- Turnstile verification.
- Per-IP rate limiting.
- YouTube search proxy.
- TURN credentials.
- Realtime credentials.

Important security controls:

- HSTS, CSP, no-sniff, frame deny, Permissions Policy.
- Capability scopes: `turn`, `realtime`, `youtube-search`, `remote-share`.
- Capability TTL clamped by config.
- Turnstile hostname/action validation.
- Explicit fallback policy when Turnstile is disabled.

### Signaling Worker

File: `cloudflare/signaling-worker.js`.

Responsibilities:

- Durable Object room signaling.
- Room code path validation.
- Host/guest WebSocket management.
- Host reclaim grace.
- Guest authentication timeout.
- Rate limiting.
- Origin allowlist.
- Hibernation attachment normalization.

Risk:

- Signaling must be robust under refreshes, duplicate hosts, guest auth timeout, and hibernation behavior.

### Remote Share Worker

File: `cloudflare/remote-share-worker.js`.

Responsibilities:

- R2-backed temporary object sharing.
- Session capability gate.
- HMAC signing.
- Presigned upload/download.
- Upload caps and TTLs.
- Cleanup token/session token handling.
- CORS allowlist.

Risk:

- Must fail closed if capability secret is missing in production.
- Must keep object TTL and size caps aligned with client behavior.
- Must avoid exposing decryption keys; keys only travel over WebRTC/control protocol.

## Cleanup Architecture

Cleanup is one of the most important cross-cutting concerns.

Common cleanup mechanisms:

- Managed timers in `src/core/timers.ts`.
- Session scopes in `src/core/session-scope.ts`.
- Blob URL manager in `src/core/blob-manager.ts`.
- AbortController usage in transfer/share paths.
- State ownership reset helpers.
- Media track stop routines.
- Peer connection close/destroy.

`leaveSession()` in `src/network/peer.ts` is a high-blast-radius function. It clears media, network, transfer, preload, files, playback, sync, YouTube, and UI-adjacent state. Any future change to leave/cleanup should be tested against all media modes.

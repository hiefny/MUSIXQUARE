# Runtime Flow Analysis

> **Historical flow snapshot (2026-05-24).** This preserves the audit's flow
> reasoning; it is not a guarantee that every named module, message, or step is
> unchanged today.

This file traces major user/runtime flows at the level needed to plan safe changes.

## Flow 1: App Boot

Primary files:

- `src/app.ts`
- `src/core/state.ts`
- `src/core/events.ts`
- `src/i18n/index.ts`
- `src/audio/engine.ts`
- `src/network/peer.ts`
- `src/storage/transfer.ts`
- `src/player/playback.ts`
- `src/youtube/handlers.ts`
- `src/ui/*`

Flow:

1. Browser loads `index.html` and Vite entry module.
2. `src/app.ts` imports modules and registers bootstrap on DOM ready if needed.
3. Core state and event bus become available.
4. i18n initializes from localStorage/browser language and translates DOM.
5. Audio engine initializes Web Audio graph lazily/idempotently.
6. Network, storage, player, YouTube, chat, settings, and UI handlers register protocol/event listeners.
7. Global keyboard shortcuts are installed.
8. Visibility/background handlers are installed.
9. Service worker is registered where allowed.
10. User lands in setup/demo/media UI and can create or join a room.

Critical contract:

- Import/init order matters because modules register singleton handlers.
- Re-initialization must be idempotent where tests or hot reload can call setup repeatedly.

Failure modes:

- Missing DOM IDs/classes can make a UI controller silently no-op.
- Duplicate event listeners can double-send protocol messages.
- AudioContext cannot fully start until user gesture/browser policy permits it.

## Flow 2: Host Creates Room

Primary files:

- `src/ui/setup-host.ts`
- `src/network/peer.ts`
- `src/network/host.ts`
- `src/network/transport/index.ts`
- `src/network/transport/config.ts`
- `src/network/peer-state.ts`
- `cloudflare/signaling-worker.js`

Flow:

1. User chooses host/create room.
2. App initializes transport according to runtime/env config.
3. Host obtains STUN/TURN config if needed.
4. Host generates a six-digit session code.
5. Transport attempts to open the room ID.
6. If the ID is taken, host retries with a new code.
7. Host sets role/session state.
8. Host listens for incoming connections.
9. Host displays QR/invite/session UI.

Critical contract:

- Host room code generation must avoid predictable collisions as much as practical.
- Host must not trust guest-provided authority fields.
- Host owns device list, slot assignment, OP status, password policy, and max guests.

Failure modes:

- Signaling outage or blocked WebSocket.
- TURN capability failure causing STUN-only behavior.
- Duplicate host/session code race.
- UI shows session started before transport is truly open.

## Flow 3: Guest Joins Room

Primary files:

- `src/ui/setup-guest.ts`
- `src/ui/setup.ts`
- `src/network/guest.ts`
- `src/network/peer.ts`
- `src/network/sync.ts`

Flow:

1. Guest enters room code and optional password.
2. Guest initializes network transport if needed.
3. Guest opens a connection to host room.
4. A timeout protects against indefinite connection wait.
5. Host accepts or rejects guest.
6. Guest receives `welcome` or `session-full`/kick/duplicate messages.
7. Guest updates `network.hostConn`, role, labels, OP status, room settings.
8. Guest starts sync ping loop.
9. Guest receives playlist/device/media state depending on host state.

Critical contract:

- Guest should only trust authoritative host messages from current `hostConn`.
- Old host connection close/error events must not mutate current state.

Failure modes:

- Old connection emits close after a successful reconnect.
- Password state changes during join.
- Guest sees stale device list if host replacement cleanup races.
- Sync starts before host state is fully welcomed.

## Flow 4: Host Plays Local File

Primary files:

- `src/player/playlist.ts`
- `src/player/decode.ts`
- `src/player/transport.ts`
- `src/player/playback.ts`
- `src/storage/transfer-send.ts`
- `src/network/peer-state.ts`
- `src/share/remote-share.ts`

Flow:

1. User selects/adds a local file track.
2. Playlist sets current track intent and clears stale preload/transfer state.
3. Decode path obtains file blob and creates load/session guards.
4. Host decodes audio with timeout.
5. On success, `files.currentFileBlob`, `player.currentTrackMeta`, and transfer metadata are updated.
6. Playback lifecycle moves through file states.
7. Host starts Web Audio playback or prepares paused/ready state.
8. Host broadcasts playlist/current file/play messages.
9. Host chooses data path per peer:
   - local data target: direct WebRTC chunks.
   - remote/unknown: authorized whole-object remote-share descriptor.

Critical contract:

- Track identity, session ID, and current index must stay aligned.
- Direct file data must not flow to remote/unknown peers over TURN.
- Decode failures should not loop forever on the same unsupported track.

Failure modes:

- User switches tracks while decode is pending.
- Direct transfer starts after remote-share wait was armed.
- Same-track replay is mistaken for stale data.
- Host sends play before remote guest has file, requiring pending play handling.

## Flow 5: Guest Receives Direct File Transfer

Primary files:

- `src/storage/transfer.ts`
- `src/storage/transfer-receive.ts`
- `src/storage/storage.ts`
- `src/storage/ramstore.ts`
- `src/player/lifecycle.ts`
- `src/player/decode.ts`
- `src/player/playback.ts`

Flow:

1. Guest receives `file-prepare` from host.
2. Guest decides whether to accept, skip, defer, or wait for preload/remote-share.
3. Lifecycle enters `DOWNLOADING`, `AWAITING_PRELOAD`, or stays/supersedes.
4. Guest receives `file-start`.
5. Guest receives chunks, possibly out of order.
6. Reorder buffer drains chunks in order.
7. Chunk watchdog monitors progress.
8. Guest receives `file-end`.
9. RAM storage publishes file-ready.
10. Guest decodes the blob.
11. Pending play/pause timing is applied.

Critical contract:

- Only host connection should be trusted for file frames.
- Session ID must match current expected transfer.
- Stale chunks must not reset current transfer.
- Pending play snapshots must survive cleanup long enough to start at host-relative position.

Failure modes:

- `file-end` arrives before final chunk is processed.
- Stale chunks flood after a track switch.
- Preload and foreground transfer target the same index.
- Recovery request targets the wrong session.

## Flow 6: Remote Share File Playback

Primary files:

- `src/network/peer-state.ts`
- `src/share/remote-share.ts`
- `src/share/r2-client.ts`
- `src/share/crypto.ts`
- `cloudflare/remote-share-worker.js`
- `src/storage/transfer-receive.ts`
- `src/player/decode.ts`

Host flow:

1. Peer is classified as remote/unknown or not a data target.
2. Host prepares the complete file as one private remote object.
3. Host creates remote-share session through capability-gated endpoint.
4. Host uploads the object to R2 via a presigned URL.
5. Host sends `remote-file-share` descriptor over WebRTC.

Guest flow:

1. Guest receives descriptor from host.
2. Guest starts download with progress.
3. Guest authorizes the whole-object download with the short-lived descriptor token.
4. Guest creates a file/blob for RAM storage/decode.
5. Guest applies pending playback state.

Critical contract:

- R2 stores one private whole-file object under the canonical `room/` namespace.
- Download authority is carried only in a short-lived request header, not in the URL.
- Remote-share descriptor should be accepted only for current active track, not speculative preload.
- Active foreground download is single-flight.

Failure modes:

- Upload succeeds but descriptor is stale by arrival time.
- Download is aborted by newer track.
- Capability challenge is cancelled by user.
- Remote file unavailable should move lifecycle to failed/pending fallback, not hang forever.

## Flow 7: Preload Next Track

Primary files:

- `src/storage/preload.ts`
- `src/player/playlist.ts`
- `src/storage/transfer-send.ts`
- `src/storage/transfer-receive.ts`

Flow:

1. Host determines next track candidate.
2. Host schedules preload generation.
3. Existing background transfer is serialized or allowed to finish depending on state.
4. Host sends `preload-start`, chunks, and `preload-end` to local peers.
5. Guest stores preload blob separately.
6. Guest sends `preload-ack` after storage confirms readiness.
7. When host later switches to that track, `play-preloaded` can promote the blob.

Critical contract:

- Preload is local-only.
- Remote guests do not receive speculative remote preload.
- Preload session caps prevent unbounded map growth.
- `preload-abort` should reach receivers before sender scope is disposed.

Failure modes:

- Host track changes while preload transfer is mid-flight.
- Guest receives chunks before `preload-start`.
- `play-preloaded` arrives before preload blob is assembled.
- Preload session eviction removes a still-needed next blob.

## Flow 8: YouTube Together

Primary files:

- `src/youtube/search.ts`
- `src/youtube/player.ts`
- `src/youtube/iframe.ts`
- `src/youtube/sync.ts`
- `src/youtube/handlers.ts`
- `src/player/ownership.ts`

Host flow:

1. User enters URL/searches/selects video or playlist.
2. URL parser/search resolves video/playlist metadata.
3. YouTube iframe API loads or existing iframe is reused.
4. Host claims YouTube playback mode.
5. Host starts player and broadcasts `youtube-play`/state.
6. Autosync stage 1 sends state snapshot.
7. Autosync stage 2 sends rendezvous/manual sync if playing.
8. Host continues heartbeat/sync messages.

Guest flow:

1. Guest accepts YouTube messages only from `hostConn`.
2. Guest loads video/playlist/subindex.
3. Guest waits for iframe readiness and autoplay possibility.
4. Guest applies host sync snapshots.
5. Guest adjusts for latency and drift.

Critical contract:

- YouTube uses mode/activity, not file lifecycle.
- Iframe readiness must not race with sync snapshots.
- Manual sync should be host-nondisruptive where possible.
- Host ad/unavailable states must not cause guest overcorrection.

Failure modes:

- YouTube API script never loads.
- Browser blocks autoplay.
- Playlist item is unavailable.
- Guest loads old video after new `youtube-play`.
- Iframe crash/rebuild loses state.

## Flow 9: System Audio Sharing

Primary files:

- `src/audio/system-capture.ts`
- `src/network/system-audio-host.ts`
- `src/network/system-audio-guest.ts`
- `src/network/system-audio-sfu.ts`
- `src/player/ownership.ts`
- `src/player/transport.ts`

Host flow:

1. User starts system audio sharing.
2. Browser prompts for display/system audio capture.
3. App captures MediaStream.
4. App claims `system-audio` playback mode.
5. App stops/pauses previous mode as needed and snapshots restore target.
6. App sends `system-audio-start`.
7. App sends P2P streams or uses SFU readiness path.

Guest flow:

1. Guest receives start signal from host.
2. Guest may show placeholder/pending system audio track meta.
3. Guest receives actual media stream.
4. Guest marks `systemAudio.isReceiving`.
5. UI/activity becomes system-audio playing.

Stop/restore:

1. Host stops capture tracks and media connections.
2. Host broadcasts `system-audio-stop`.
3. Guests clear receiving state.
4. Previous YouTube/file state is restored where possible.

Critical contract:

- System audio can be pending before actual stream arrives.
- `systemAudio.isReceiving` participates in playback ownership derivation.
- Previous mode restore must not revive stale file/YouTube state.

Failure modes:

- User denies capture.
- Capture track ends unexpectedly.
- SFU readiness arrives after stop.
- Media call comes from untrusted peer.
- Restore tries to resume a file that has since changed.

## Flow 10: Leave Session and Cleanup

Primary files:

- `src/network/peer.ts`
- `src/player/transport.ts`
- `src/share/remote-share.ts`
- `src/storage/preload.ts`
- `src/storage/transfer.ts`
- `src/youtube/player.ts`
- `src/audio/system-capture.ts`

Flow:

1. User leaves or connection closes intentionally.
2. App marks intentional disconnect state.
3. System audio is force-stopped.
4. Worker timers and sync loops stop.
5. Playback nodes and media streams stop.
6. YouTube/system audio/file ownership is cleared.
7. Data/media connections close.
8. Peer instance is destroyed.
9. Transfer/preload/recovery/files state resets.
10. Blob URLs are revoked or scheduled for revocation.
11. UI returns to setup/idle role.

Critical contract:

- Cleanup must cancel in-flight async operations.
- Old async completions must not mutate new session state.
- State reset order should preserve enough information for user-facing messages but clear authority-bearing state.

Failure modes:

- Decode completes after leave.
- Remote-share upload/download completes after leave.
- Old connection close event fires after rejoin.
- Blob URL remains referenced.
- MediaStream track continues running.

## Cross-Flow Invariants

These invariants should be preserved in future changes:

1. Guests trust host-originated room/playback/media messages only from the current `hostConn`.
2. Host verifies OP status before applying guest control requests.
3. File data does not go over TURN to remote/unknown peers.
4. `playback.mode` and `playback.activity` are the public playback contract.
5. `playback.lifecycle` is file-only and transition-controlled.
6. YouTube and system audio do not write file lifecycle states.
7. Async operations must carry session/load/generation/abort guards.
8. Production bundle must not expose test hooks.
9. Cloudflare capability-protected endpoints must fail closed unless an explicit guarded fallback is configured.
10. E2E should observe semantic playback state, not legacy `appState`.

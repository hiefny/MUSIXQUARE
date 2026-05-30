# Large File Split Design - 2026-05-30

## Scope

This document is a design-only pass over the TypeScript files above 1000 lines that were named in `scratch/agent-prompts/03-large-file-split-design.md`. No code changes are proposed as part of this prompt.

The goal is to identify low-risk extraction boundaries that reduce file size without weakening the race-defense behavior around room sync, transfer state, playback state, timers, and singleton browser APIs.

## Guiding Strategy

Use facade-first splits. Keep the existing public import paths stable while moving internals behind small modules. The first PR for each file should preserve exported function names and event registration order. Shared mutable state should move exactly once, into a dedicated runtime/state module, and all other extracted modules should import helpers from that module instead of creating parallel state.

Prefer extraction in this order:

1. Pure helpers and command tables.
2. Timer/session lifecycle helpers with explicit stop/cleanup APIs.
3. Protocol guards and serializers.
4. Event handlers that already have narrow inputs.
5. Large orchestration functions only after surrounding helpers have been extracted and covered by tests.

## Cross-File Race-Defense Checklist

- Preserve listener registration order in all `init*` functions.
- Keep module-level singleton state singleton; do not duplicate runtime objects through circular imports.
- Preserve named timer IDs and cleanup paths before extracting UI overlays or transfer sessions.
- Keep network send/broadcast boundaries visible in the facade during the first split.
- Add narrow regression tests before moving code that handles late join, reconnect, preload promotion, YouTube rendezvous, or transfer cleanup.
- Run the relevant targeted tests after every slice, then the broader E2E group once the facade is thin.

## `src/chat/commands.ts` - 1729 lines

### Responsibility Map

- Lines 1-52: imports, command context types, and command definitions.
- Lines 53-116: target resolution, host/permission checks.
- Lines 117-392: moderation and chat commands (`kick`, `op`, `deop`, `freeze`, `mute`, `unmute`, `clear`, `filter`, `slowmode`, `notice`, `nick`, `whisper`, `help`, `users`).
- Lines 433-646: browser/OS parsing and the general `/debug` report.
- Lines 647-759: system-audio debug session state, timer, and cleanup.
- Lines 760-1012: screen debug session, safe-area/display probes, and formatting helpers.
- Lines 1013-1567: memory snapshot collection, memory overlay session, graph canvas sync, and rendering.
- Lines 1568-1663: command registry table.
- Lines 1664-1729: command lookup, parsing, arg hints, availability filtering, and execution.

### Shared Mutable State

- `_activeSystemAudioDebugSession`, `_activeScreenDebugSession`, and `_activeDebugSession`.
- Debug timers and canvas/DOM references owned by those sessions.
- Global app state accessed through `getState`/`setState`.
- EventBus side effects, clipboard writes, localStorage reads, and DOM/media probes.
- Permission-sensitive command metadata and aliases.

### Proposed Split

- `chat/command-core.ts`: command parsing, lookup, permissions, arg hints, and the public execute function.
- `chat/commands/moderation.ts`: target resolution plus moderation/user commands.
- `chat/commands/chat.ts`: nick, whisper, help, users, notice, clear, filter, slowmode.
- `chat/debug/device.ts`: `/debug`, browser/OS parsing, safe-area/display helpers.
- `chat/debug/system-audio.ts`: system-audio debug session and cleanup.
- `chat/debug/screen.ts`: screen session and related formatting/probe helpers.
- `chat/debug/memory.ts`: memory collection, session lifecycle, canvas graph renderer.
- Keep `commands.ts` as a facade that assembles `COMMANDS_DEF` and re-exports the current public API during the first split.

### Race-Defense Risks

- Debug session stop paths must remain idempotent. Moving overlay code without its timer cleanup can leave intervals or stale DOM.
- The command registry mixes aliases, permission checks, and argument hints; splitting the table from lookup can accidentally expose privileged commands in completion.
- Browser/clipboard/DOM helpers are hard to exercise in non-browser tests; keep them behind thin adapters.

### Verdict

Split now, low to medium risk. Start with debug modules and command-core because those boundaries are already visible. Leave command registration order unchanged until tests cover alias and permission behavior.

## `src/youtube/iframe.ts` - 1593 lines

### Responsibility Map

- Lines 1-77: imports and module/runtime state.
- Lines 78-211: host reset, live-stream detection, duration cache invalidation, and broadcast markers.
- Lines 212-388: `loadYouTubeVideo`, player reuse, iframe bootstrapping, and load timeout behavior.
- Lines 389-570: `createYouTubePlayer`, IFrame API loading, and singleton player construction.
- Lines 571-800: ready callback, playlist indexing, playlist scraping, and snapshot finalization.
- Lines 801-1042: YouTube error and state-change callbacks.
- Lines 1043-1372: periodic UI update loop, stuck/crash/live detection, and playback display updates.
- Lines 1373-1479: sync overlay and guest/host status UI.
- Lines 1480-1508: display refresh facade.
- Lines 1509-1593: playlist snapshot retry accounting and trigger logic.

### Shared Mutable State

- `_ifr` runtime object and YouTube player singleton in global state.
- YouTube UI loop timer, load timeout, playlist indexing timers, scrape timers, and retry counters.
- Duration/live/stuck detection caches.
- Host broadcast marker and playback ownership state.
- Subitem/playlist metadata shared with `player.ts` and `sync.ts`.

### Proposed Split

- `youtube/iframe-runtime.ts`: `_ifr`, live/duration/stuck helpers, reset helpers, snapshot retry counters.
- `youtube/iframe-loader.ts`: script/API loading and `loadYouTubeVideo`.
- `youtube/iframe-player.ts`: `createYouTubePlayer`, ready/error/state callbacks.
- `youtube/iframe-playlist-indexing.ts`: playlist indexing, scraping, snapshot trigger/finalization.
- `youtube/iframe-ui-loop.ts`: UI loop, display refresh, sync overlay, crash/stuck warnings.
- Keep `iframe.ts` as the compatibility facade until imports from `player.ts` and `sync.ts` are untangled.

### Race-Defense Risks

- The global `onYouTubeIframeAPIReady` callback and player singleton must not be installed twice.
- Circular imports with `youtube/player.ts` can duplicate pending auto-sync state or make callbacks observe partially initialized modules.
- iOS gesture reuse and overlay timing are fragile; keep the load/reuse path intact until browser coverage is focused on mobile Safari-like behavior.
- Playlist snapshot retry counters must remain keyed to the same player/session lifecycle.

### Verdict

Split, but stage carefully. Extract runtime and playlist indexing first, then UI loop. Defer moving ready/state callbacks until the facade has tests around load, replay, playlist scrape, and guest sync overlay behavior.

## `src/youtube/player.ts` - 1548 lines

### Responsibility Map

- Lines 1-80: pending auto-sync state, compatibility idle helper, and imports.
- Lines 81-166: re-exports from YouTube search, iframe, handler, and sync modules.
- Lines 167-293: auto-sync scheduling, cancellation, and late-join rendezvous sync scheduling.
- Lines 294-417: `stopYouTubeMode` and teardown of YouTube playback.
- Lines 418-484: sub-video navigation.
- Lines 485-1021: `initYouTube` event/protocol wiring for load, toggle, auto-play, ready, seek, skip, and broadcast-sync.
- Lines 1022-1182: adding YouTube videos/playlists to the playlist.
- Lines 1183-1299: input overlay and load-from-input flow.
- Lines 1300-1438: refresh, volume, sub-seek, subitem population, and load-from-chat handlers.
- Lines 1439-1548: peer-connected late-join bootstrap and room restore behavior.

### Shared Mutable State

- Pending auto-sync variables and timers.
- YouTube state, subitems, playlist state, and current playback mode.
- Network `hostConn`, protocol sends, broadcasts, and safe send helpers.
- Preload scheduling and playlist mutation side effects.
- EventBus registration order inside `initYouTube`.

### Proposed Split

- `youtube/autosync.ts`: pending auto-sync state, schedule/cancel, late-join rendezvous scheduling.
- `youtube/mode.ts`: `stopYouTubeMode` and teardown helpers.
- `youtube/navigation.ts`: sub-video navigation, seek/skip/next/prev handlers.
- `youtube/add-to-playlist.ts`: preview/input/chat parsing and `_addYouTubeToPlaylist`.
- `youtube/bootstrap.ts`: peer-connected late-join and room playback restore.
- `youtube/init.ts`: event wiring only.
- Keep `player.ts` as a facade/re-export module while consumers migrate.

### Race-Defense Risks

- `initYouTube` listener order affects first-load autoplay, room restore, and host hand-off.
- Auto-sync timers interact with `iframe.ts` ready callbacks and `sync.ts` rendezvous logic; extracting them before untangling cycles can change when pending sync is consumed.
- Playlist mutation and YouTube load flows share preload and broadcast side effects.

### Verdict

Split after `iframe.ts` and `sync.ts` facades exist. The first safe move is extracting auto-sync state and teardown helpers. Keep `initYouTube` wiring in one file until targeted tests protect listener order.

## `src/storage/transfer-receive.ts` - 1507 lines

### Responsibility Map

- Lines 1-66: imports, transfer buffers, demo fetch promise, and early chunk state.
- Lines 67-123: pending-play snapshot capture/restore.
- Lines 124-232: skip guards, local direct promotion, remote wait switching, and local playlist index helpers.
- Lines 233-363: chunk watchdog and demo fetch/load handling.
- Lines 364-430: remote unavailable UI, host-broadcast detection, and same-file replay.
- Lines 431-849: `handleFilePrepare`.
- Lines 850-958: `handleFileStart`.
- Lines 959-1024: `handleFileResume`.
- Lines 1025-1339: chunk receive, reorder buffer drain, local/direct apply flow.
- Lines 1340-1437: `handleFileEnd` and remote wait handling.
- Lines 1438-1471: transfer memory stats.
- Lines 1472-1507: receive-state cleanup and cancel APIs.

### Shared Mutable State

- `fileReorderBuffer`, `nextExpectedChunk`, `lastChunkTime`, `_pendingEarlyChunks`, and `_demoFetchPromise`.
- Pending-play snapshots and transfer watchdog timer.
- Playback/transfer/preload global state and remote-share wait state.
- Ramstore write commands and Blob URL playback handoff.

### Proposed Split

- `storage/transfer-receive/state.ts`: buffer state, memory stats, cleanup/cancel primitives.
- `storage/transfer-receive/guards.ts`: host broadcast, skip incoming, local direct acceptance, pending-play snapshots.
- `storage/transfer-receive/demo.ts`: demo fetch and remote-unavailable UI.
- `storage/transfer-receive/prepare.ts`: `handleFilePrepare`.
- `storage/transfer-receive/start-resume.ts`: `handleFileStart`, `handleFileResume`, local direct promotion.
- `storage/transfer-receive/chunks.ts`: chunk application, reorder drain, watchdog updates.
- `storage/transfer-receive/end-wait.ts`: `handleFileEnd` and `handleFileWait`.
- Keep top-level `transfer-receive.ts` as the exported API during migration.

### Race-Defense Risks

- Recent local-direct promotion behavior depends on skipping `storage:clear-previous-track` after a remote-share wait; keep this guard and its tests close to start/resume extraction.
- Reorder-buffer state is coupled to `nextExpectedChunk`; moving chunk code without shared state will duplicate or reset sequence tracking.
- Pending-play snapshot restore must still happen around cleanup paths that clear transfer state.
- Early chunk caps protect memory. Preserve the exact cap and drop behavior before refactoring.

### Verdict

Split in medium-risk slices. Extract state and guards first, then chunk handling, then prepare/start. Do not move remote wait promotion until its unit and E2E coverage is stable.

## `src/player/playlist.ts` - 1445 lines

### Responsibility Map

- Lines 1-43: imports and module setup.
- Lines 44-134: shuffle order state and helpers.
- Lines 135-220: repeat/shuffle settings and preload-state clearing.
- Lines 221-256: preload/session cleanup helpers.
- Lines 257-576: `playTrack` orchestration.
- Lines 577-810: end-of-playlist, next, previous, repeat, and shuffle navigation.
- Lines 811-1069: playlist update, track-change, request settings, and remote control handlers.
- Lines 1070-1163: file selection/upload handling.
- Lines 1164-1408: `initPlaylist` event wiring and playlist mutation handlers.
- Lines 1409-1445: peer-connected bootstrap.

### Shared Mutable State

- `_shuffleOrder` and `_shufflePosition`.
- Playlist state, current track index, repeat/shuffle state, and preload cache state.
- Transfer session IDs, file references, load tokens, and current playback URLs.
- YouTube mode/subitems and network broadcast state.

### Proposed Split

- `player/playlist/shuffle.ts`: shuffle state and order mutation.
- `player/playlist/repeat.ts`: repeat mode transitions.
- `player/playlist/preload-state.ts`: preload/session cleanup helpers.
- `player/playlist/play-track.ts`: `playTrack` orchestration, initially kept large.
- `player/playlist/navigation.ts`: next/previous/end-of-playlist logic.
- `player/playlist/uploads.ts`: file selection and local upload handling.
- `player/playlist/network-handlers.ts`: remote control, peer-connected bootstrap, broadcasts.
- `player/playlist/init.ts`: event registration only.

### Race-Defense Risks

- Shuffle order must remain consistent after removal, reorder, and late changes to playlist length.
- `playTrack` crosses local file, YouTube, remote preload, and transfer-session cleanup. Splitting it too early risks stale playback URLs or wrong mode transitions.
- Broadcast order around track change and preload scheduling is user-visible for guests.
- Peer-connected bootstrap must not replay stale local files to guests.

### Verdict

Split, but begin with pure shuffle/repeat/preload helpers. Keep `playTrack` mostly intact until navigation and preload tests are expanded.

## `src/storage/preload.ts` - 1409 lines

### Responsibility Map

- Lines 1-67: imports, preload reorder state, active scopes, in-flight transfers, and generation counter.
- Lines 68-169: stale session cleanup and cancellation.
- Lines 170-204: schedule and clear cache state.
- Lines 205-392: `preloadNextTrack`.
- Lines 393-479: background transfer.
- Lines 480-561: unicast preload.
- Lines 562-712: host-broadcast guard and `handlePreloadStart`.
- Lines 713-871: reorder drain and chunk handling.
- Lines 872-1033: preload end/abort handling.
- Lines 1034-1056: preload ack.
- Lines 1057-1219: play-preloaded handling.
- Lines 1220-1243: memory stats.
- Lines 1244-1409: `initPreload`, storage-ready handlers, preload-ready, cleanup wiring.

### Shared Mutable State

- `preloadReorderBuffer`, `latestPreloadSessionId`, `_activePlayPreloadedIndex`, `_preloadScope`, `_activePreloadUnicasts`, `_inFlightBackgroundTransfer`, and `_preloadGeneration`.
- `preload.*` fields in global state.
- Per-peer abort controllers and timers.
- Storage-ready callbacks that can complete after a newer generation starts.

### Proposed Split

- `storage/preload/state.ts`: module runtime, generation counter, memory stats, clear/cancel helpers.
- `storage/preload/scheduler.ts`: schedule, stale cleanup, `preloadNextTrack`.
- `storage/preload/send.ts`: background transfer and broadcast send.
- `storage/preload/unicast.ts`: per-peer unicast preload.
- `storage/preload/receive.ts`: start/chunk/end/abort/ack receive path.
- `storage/preload/play-preloaded.ts`: local play-preloaded promotion.
- `storage/preload/storage-ready.ts`: storage completion and preload-ready handling.
- `storage/preload/init.ts`: event wiring facade.

### Race-Defense Risks

- `_preloadGeneration` prevents stale async completions; it must remain a single source of truth.
- Abort-before-chunk and stale-storage-ready races are easy to reintroduce if send/receive state diverges.
- Broadcast preload and unicast preload share active scope cleanup; duplicate abort controllers can leak transfers.
- The direct-preload policy differs between host and guests, so guard extraction needs explicit tests.

### Verdict

Split in guarded phases. Extract state/runtime first, then receive path, then send/unicast. Keep scheduler and play-preloaded close until transfer promotion coverage is broader.

## `src/youtube/sync.ts` - 1381 lines

### Responsibility Map

- Lines 1-101: imports, manual broadcast timestamp, guest latency/manual offset helpers.
- Lines 102-247: host `broadcastYouTubeSync`.
- Lines 248-386: guest sync runtime, pending manual offset apply, ad detection, host snapshot, and manual rendezvous helpers.
- Lines 387-601: host-broadcast guard and `handleYouTubeSync`.
- Lines 602-904: guest rendezvous sync, play scheduling, finish/cancel.
- Lines 905-944: sync-state reset.
- Lines 945-1227: `handleYouTubeState`.
- Lines 1228-1283: immediate execution helper.
- Lines 1284-1315: subtitle update handler.
- Lines 1316-1339: playlist info handler.
- Lines 1340-1361: YouTube stop handler.
- Lines 1362-1381: `initYouTubeSync` protocol wiring.

### Shared Mutable State

- `_lastManualBroadcastAt`, `_rt`, and `_pendingManualOffsetApplyUntil`.
- Rendezvous timers, retry timers, ad-detection state, and host snapshot state.
- YouTube player singleton, shared clock calibration, playlist/subitem state, and playback mode.
- Network `hostConn` and protocol sender identity.

### Proposed Split

- `youtube/sync/runtime.ts`: `_rt`, pending manual offset, host snapshot, reset helpers.
- `youtube/sync/broadcast.ts`: `broadcastYouTubeSync` and manual offset calculation.
- `youtube/sync/manual-rendezvous.ts`: manual defer/retry/offset apply helpers.
- `youtube/sync/guest-rendezvous.ts`: rendezvous scheduling, finish, cancel.
- `youtube/sync/handlers-sync.ts`: `handleYouTubeSync` and host-broadcast guard.
- `youtube/sync/handlers-state.ts`: `handleYouTubeState` and immediate execution helper.
- `youtube/sync/playlist-info.ts`: subtitle and playlist-info handlers.
- `youtube/sync/init.ts`: protocol registration facade.

### Race-Defense Risks

- `_rt` is the synchronization brain; duplicating it through import cycles would break drift suppression, ad detection, and rendezvous state.
- Manual rendezvous deferral depends on host snapshot freshness and pending offset timing.
- Shared-clock calibration and drift correction must still run before guest play/seek decisions.
- `youtube:sync` and `youtube:state` handler ordering matters when host updates arrive close together.

### Verdict

Split, high risk. Extract runtime plus broadcast helpers first. Keep guest rendezvous and `handleYouTubeSync` together until manual sync and late-join E2E tests are stable across repeated runs.

## Suggested Migration Order

1. `src/chat/commands.ts`: extract command-core and debug modules.
2. `src/player/playlist.ts`: extract shuffle/repeat/preload-state helpers.
3. `src/storage/transfer-receive.ts`: extract state and guards, protected by transfer promotion tests.
4. `src/storage/preload.ts`: extract state/runtime, then receive path.
5. `src/youtube/iframe.ts`: extract runtime and playlist indexing.
6. `src/youtube/sync.ts`: extract runtime and broadcast helpers.
7. `src/youtube/player.ts`: thin facade after iframe/sync dependencies are calmer.

This order reduces risk by removing pure or near-pure code first, then transfer state with fresh regression coverage, and only then the cyclic YouTube modules.

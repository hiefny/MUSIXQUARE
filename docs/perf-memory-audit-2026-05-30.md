# Performance & Memory Audit - 2026-05-30

> **Historical audit snapshot.** Measurements, line numbers, priorities, and
> references to “current code” describe the 2026-05-30 baseline only. Re-measure
> the present build before using any value as a capacity or release decision.

Scope: `src/player/playlist.ts`, `src/storage/preload.ts`,
`src/storage/transfer-receive.ts`, `src/storage/ramstore.ts`,
`src/core/blob-manager.ts`, `src/audio/engine.ts`, `src/audio/effects.ts`,
`src/audio/channel.ts`, `src/ui/visualizer.ts`, plus the existing
`/debug memory` diagnostics in `src/chat/commands.ts`.

This is an analysis-first audit. No production refactor was applied.

## Measurement Notes

Static measurements from the current code:

| Item | Bound / formula | Size |
| --- | ---: | ---: |
| Chunk size | `CHUNK_SIZE = 64 * 1024` | 64 KiB |
| Main transfer reorder cap | `500 * CHUNK_SIZE` | 31.25 MiB |
| Main pending-early queue cap | `200 * CHUNK_SIZE` | 12.50 MiB |
| Preload early-chunk cap | `128 * CHUNK_SIZE` | 8.00 MiB |
| 4 min stereo PCM @ 44.1 kHz | `2 * 44100 * 240 * 4` | 80.75 MiB |
| 10 min stereo PCM @ 44.1 kHz | `2 * 44100 * 600 * 4` | 201.87 MiB |
| 4 min stereo PCM @ 48 kHz | `2 * 48000 * 240 * 4` | 87.89 MiB |

Focused regression check run:

```text
npm test -- src/core/__tests__/blob-manager.test.ts src/storage/__tests__/ramstore.test.ts src/ui/__tests__/visualizer.test.ts
Test Files 3 passed
Tests 84 passed
```

I did not run a browser heap timeline with a real 200-track import in this
pass. Findings marked "theoretical" are derived from object lifetime tracing
and code-level bounds, not from a reproduced heap snapshot.

## Ranked Findings

### P1 - Decode overlap can create very high peak memory during track switches

Status: theoretical, strongly supported by code path.

Evidence:

- `loadAndBroadcastFile` and `loadDemoTrackForPlayback` call
  `file.arrayBuffer()` and then `decodeAudioData(...)` before replacing
  `currentAudioBuffer` (`src/player/decode.ts:164-193`,
  `src/player/decode.ts:309-327`).
- `loadPreloadedTrack` clears the previous `currentAudioBuffer` before
  decoding the promoted preload (`src/player/decode.ts:641-649`), but the
  host local-file path keeps the old decoded buffer resident until the new
  decode succeeds.
- `stopPlayerNode()` has iOS-specific mitigation for retired
  `AudioBufferSourceNode` retention, including disconnect, stop, clearing
  `onended`, and best-effort `buffer = null` (`src/player/transport.ts:181-228`).
- WeakRef tracking exists to catch retained decoded buffers after switches
  (`src/player/_state.ts:43-78`) and `/debug memory` reports live/ever-seen
  counts (`src/chat/commands.ts:1160`).

Impact:

For a normal 4-minute stereo track, one decoded buffer is about 80.75 MiB.
During host local decode, peak can include the old decoded buffer, the new
compressed `ArrayBuffer`, and the new decoded PCM before the old buffer is
cleared. For longer files, one 10-minute stereo decode is about 201.87 MiB.
This shape matches the documented 200+ playlist OOM risk more closely than a
small persistent leak: rapid switches can create a peak cliff even if cleanup
eventually succeeds.

Proposed fix:

Design a reviewed "decode handoff" path for host local-file loads that can
release the old `currentAudioBuffer` earlier without reopening stale-audio
races. A safe version likely needs an explicit pending-load owner token and
playback lifecycle gate so `play()` cannot use a null/old buffer while the new
decode is in flight. Do not apply this as a casual refactor.

### P1 - `ramstore` internal bytes are not included in `/debug memory`

Status: reproduced by code search; memory growth itself is theoretical.

Evidence:

- `ramstore.ts` exposes `ramStats()` with main/preload byte counts
  (`src/storage/ramstore.ts:303-329`).
- The only production imports of memory stats are transfer/preload/audio/blob
  diagnostics in `src/chat/commands.ts`; `ramStats()` is only used in tests
  (`src/storage/__tests__/ramstore.test.ts`).
- `/debug memory` counts `files.currentFileBlob`, `preload.nextFileBlob`,
  playlist file refs, transfer reorder bytes, and preload reorder bytes
  (`src/chat/commands.ts:1182-1289`), but not finalized or in-flight
  `ramstore` slots that are no longer referenced by those state fields.

Impact:

If a stale preload/main slot remains inside `ramstore`, the existing live
diagnostic can under-report it. That weakens the primary debugging tool on
Safari/iOS, where `performance.memory` is unavailable and the code explicitly
uses `[Tracked]` as the heap-pressure proxy.

Proposed fix:

Add `ramStats()` to `/debug memory`, with separate `mainBytes`,
`preloadBytes`, `preloadCount`, `finalizedCount`, and `inFlightCount` lines.
This is low risk and gives future browser profiling a stronger signal before
changing storage behavior.

### P2 - Speculative preload slots rely on lifecycle cleanup, not a hard count cap

Status: theoretical.

Evidence:

- `ramstore` keeps preload slots by `sessionId` and by `filename`
  (`src/storage/ramstore.ts:46-47`).
- A new preload slot is inserted for every new `(sessionId, filename)`
  (`src/storage/ramstore.ts:96-116`).
- Old slots are removed by filename cleanup, session reset, or full preload
  reset (`src/storage/ramstore.ts:265-295`).
- `preload.ts` deliberately does not reset all preload storage on each
  `PRELOAD_START` so in-flight superseded preloads can still complete
  (`src/storage/preload.ts:664-681`).
- Promoting a preload cleans the previous current track from both pools
  (`src/player/decode.ts:681-694`), but speculative preloads that are never
  promoted depend on later reset/abort/cleanup paths.

Impact:

This is probably correct for race recovery, but it means the storage pool has
no explicit "keep only N finalized speculative preloads" invariant. With large
playlists and heavy skip/reconnect behavior, a missed cleanup would retain one
RAM-backed blob per stale preload. Because of Finding P1, such retention may
not show up in `/debug memory`.

Proposed fix:

After adding `ramStats()` diagnostics, add a conservative eviction policy for
finalized preload slots that are neither `preload.meta.sessionId`, nor the
current file, nor an awaited recovery target. Keep the race-sensitive "do not
reset all preloads on start" behavior intact.

### P2 - Playlist file references are the designed dominant memory floor

Status: observed by code inspection; actual browser residency depends on File
implementation.

Evidence:

- File selection pushes every accepted `File` into `playlist.items`
  (`src/player/playlist.ts:1070-1132`).
- `/debug memory` intentionally sums every playlist item with a measurable
  `file.size` (`src/chat/commands.ts:1190-1202`).
- The task constraints say the RAM-first storage model is intentional.

Impact:

For 200 selected local tracks averaging 8 MiB, `/debug memory` will report
about 1.6 GiB of playlist file refs even before decoded PCM and preload/current
blobs are counted. Some browsers back `File` objects by OS file handles rather
than copying bytes immediately, but guest-side RAM store files are memory-backed.

Proposed fix:

Do not change the storage model without owner review. Do add UI/debug warnings
that explain the estimated playlist footprint and call out the decoded PCM
multiplier. This is safer than trying to "fix" memory by dropping file refs
that are required for host retransmit/recovery.

### P3 - Blob URL lifecycle is bounded for normal local playback

Status: verified by code inspection and existing tests.

Evidence:

- Local playback creates URLs only through `BlobURLManager.create()`
  (`src/player/decode.ts:159`, `src/player/decode.ts:309`,
  `src/player/decode.ts:724`, `src/player/decode.ts:976`).
- `confirm()` revokes the previous active URL through `safeRevoke()`
  (`src/core/blob-manager.ts:76-88`).
- `MAX_PENDING` caps scheduled revocations at 5 (`src/core/blob-manager.ts:23`,
  `src/core/blob-manager.ts:118-137`).
- `stopAllMedia()` and `clearPreviousTrackState()` both revoke/flush
  (`src/player/transport.ts:246-251`, `src/player/decode.ts:899-902`).
- Session-end exposes `blob:revoke-all` to `revokeAllNow()`
  (`src/app.ts:467`).
- Remote-share object URLs are outside `BlobURLManager`, but each path revokes
  the previous/current URL (`src/share/remote-share.ts:273`,
  `src/share/remote-share.ts:722-723`, `src/share/remote-share.ts:855`).

Impact:

No unbounded Blob URL leak found. Worst normal local-playback state is one
active URL, one preparing URL, and up to five pending scheduled revocations.

Proposed fix:

Optional: route remote-share object URLs through a small manager or expose them
in `/debug memory` so all URL retention is visible in one place.

### P3 - Visualizer rAF is actively stopped outside playing/settling states

Status: verified by code inspection and visualizer tests.

Evidence:

- `cancelVisualizerAnimation()` cancels `_animationId` and sets idle state
  (`src/ui/visualizer.ts:178-184`).
- Playback mode/activity is scoped through `createBusScope()` and disposed on
  re-init (`src/ui/visualizer.ts:768-824`).
- Paused/idle paths settle or fade out instead of continuing the active
  analyser loop (`src/ui/visualizer.ts:823-846`).
- Active draw loops stop immediately in YouTube mode
  (`src/ui/visualizer.ts:500-503`, `src/ui/visualizer.ts:694-697`).
- One-time window resize/orientation/theme listeners are guarded by module
  booleans (`src/ui/visualizer.ts:20-21`, `src/ui/visualizer.ts:100-107`,
  `src/ui/visualizer.ts:803-807`).

Impact:

No continuously running idle/hidden analyser polling leak found. The remaining
global listeners are app-lifetime singletons, not per-session growth.

Proposed fix:

Optional: expose visualizer loop state in `/debug memory` to make "idle vs
active vs settling" visible during field reports.

## Recommended Next Steps

1. Add `ramStats()` to `/debug memory` before changing storage behavior.
2. Run a browser heap timeline with a synthetic 200-track playlist and record
   `/debug memory` before import, after import, after 20 rapid switches, after
   session leave, and after a forced GC where available.
3. Design the host-local decode handoff before implementing it; the existing
   comments show stale-buffer races are real, so this needs tests around rapid
   track switching, same-track replay, and preload promotion.
4. Consider a conservative finalized-preload eviction invariant only after the
   diagnostics can prove whether stale `ramstore` slots are actually retained.

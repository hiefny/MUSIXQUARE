# fix09 — Deep Analysis Round 9 (Final Sweep)

## Summary
- **Total fixes**: 3 (High 1, Low 2)
- **Cumulative**: fix01–fix09 = 136 fixes

## Agents Deployed (3)
1. YouTube modules deep audit (player.ts, iframe.ts, handlers.ts, sync.ts, _state.ts, search.ts)
2. Blob/OPFS management audit (blob-manager.ts, opfs.ts, transfer-receive.ts, transfer-send.ts)
3. Cross-module state consistency audit (state.ts, events.ts, app.ts, types/index.ts, full src/ grep)

## Fixes Applied

### H1 — `stopPlayback()` YouTube path does not call `stopYouTubeMode()` — guest stuck in PLAYING_YOUTUBE
| Key | Value |
|-----|-------|
| File | `src/player/transport.ts` |
| Severity | **High** |
| Confidence | 9/10 |

**Bug**: When the host pressed Stop during YouTube playback, `stopPlayback()` called `youtube:stop-playback` (stopVideo only) but not `youtube:stop-mode` (full cleanup). This meant:
- `YOUTUBE_STOP` was never broadcast to guests
- YouTube timers (`youtubeUILoop`, `youtubeSyncLoop`, etc.) were never cleared
- Guest remained stuck in `PLAYING_YOUTUBE` state with dead player, unable to play local files

The code also incorrectly broadcast `MSG.PAUSE` (a local-file protocol message) which the guest ignored because `handlePauseMsg` already has a YouTube guard.

**Fix**: Replaced the broken YouTube branch with:
1. `youtube:stop-playback` — stops the video on host
2. `youtube:stop-mode` — delegates to `stopYouTubeMode()` which handles: player destroy, timer cleanup, `YOUTUBE_STOP` broadcast to guests, appState→IDLE transition, `player:state-changed` emission
3. Removed the redundant state management (already handled by `stopYouTubeMode`)

---

### L1 — `_ytScriptLoading` flag never reset on script load success
| Key | Value |
|-----|-------|
| File | `src/youtube/iframe.ts` |
| Severity | **Low** |
| Confidence | 9/10 |

**Bug**: `_ytScriptLoading` was set to `true` when starting script load and only reset to `false` in the `onerror` handler. The `onload` handler didn't reset it. While a secondary guard (`document.querySelector`) prevents re-insertion, if the script tag were ever removed (e.g., error recovery path does `tag.remove()`), the stuck flag would prevent re-loading.

**Fix**: Added `setYtScriptLoading(false)` in the `onload` callback.

---

### L2 — `cleanupOPFSInWorker` hardcoded timer name causes bus listener leak on rapid calls
| Key | Value |
|-----|-------|
| File | `src/storage/opfs.ts` |
| Severity | **Low** |
| Confidence | 8/10 |

**Bug**: `cleanupOPFSInWorker` used a hardcoded timer name `'opfs-cleanup-watchdog'`. When called twice rapidly (e.g., quick track change), the second call replaced the managed timer via `setManagedTimer`, discarding the first timer's callback without calling `unsub()`. The first call's `bus.on('opfs:cleanup-complete')` listener was never unsubscribed, leaking one listener per rapid double-call.

**Fix**: Made the watchdog timer name unique per file: `'opfs-cleanup-watchdog-' + expectedOpfsName`.

---

## Cross-Module State Consistency Audit Results

The comprehensive cross-cutting audit verified:

| Audit Dimension | Result | Details |
|-----------------|--------|---------|
| State key spelling | **CLEAN** | All 70 unique state paths match StateTree and createInitialState() |
| Bootstrap order | **CLEAN** | No circular dependencies; PeerJS/audio deferred to user gesture |
| MSG enum | **CLEAN** | All 67 message types have both senders and handlers |
| APP_STATE transitions | **CLEAN** | No impossible transitions; every setState is paired with player:state-changed |
| Implicit dependencies | **CLEAN** | No cross-module state reads before initialization |

## Findings Deferred to fix10

| # | Finding | Reason |
|---|---------|--------|
| Guest YouTube ENDED orphaned player state | <500ms timing window; cleanup happens on next track |
| OPFS integrity checks size-only, not content hash | Design limitation — impractical for real-time streaming |
| Relay chunk forwarding before OPFS write confirmation | Recovery mechanism handles this adequately |

## Verification
- `npx tsc --noEmit` — 0 errors
- Preview: 0 console errors, 0 app-related failed requests (only TURN config 503 expected offline)

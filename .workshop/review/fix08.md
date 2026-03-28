# fix08 — Deep Analysis Round 8

## Summary
- **Total fixes**: 7 (High 1, Medium 5, Low 1)
- **Cumulative**: fix01–fix08 = 133 fixes

## Agents Deployed (6)
1. video.ts + visualizer audit
2. i18n + log + timers + blob-manager audit
3. sync + playback network audit
4. transfer + opfs + worker audit
5. player-controls + settings UI audit
6. peer-state + host + constants audit

## Fixes Applied

### H1 — `broadcastFile` backpressure timeout skips individual chunks, creating permanent holes
| Key | Value |
|-----|-------|
| File | `src/storage/transfer-send.ts` |
| Severity | **High** |
| Confidence | 9/10 |

**Bug**: When a peer hit 30s backpressure timeout, only the current chunk was skipped for that peer. The outer loop continued sending subsequent chunks. The receiving peer's reorder buffer would wait forever for the skipped chunk, eventually triggering a full file re-transfer via recovery — potentially creating a re-transfer loop.

**Fix**: Added `timedOutPeers` Set to track peers that hit backpressure timeout. Once a peer times out, it is excluded from ALL remaining chunks in the transfer, preventing partial holes.

---

### M1 — Visualizer runs 60fps animation during PLAYING_VIDEO when canvas is CSS-hidden
| Key | Value |
|-----|-------|
| File | `src/ui/visualizer.ts` |
| Severity | **Medium** |
| Confidence | 9/10 |

**Bug**: During video playback, CSS hides the visualizer canvas (`body.mode-video .vinyl-wrapper { display: none }`), but the `draw()` loop still ran at full refresh rate, performing FFT reads and canvas operations invisibly. Significant waste on mobile/battery devices.

**Fix**: Added `APP_STATE.PLAYING_VIDEO` to the early-exit guard in `draw()`, alongside the existing `PLAYING_YOUTUBE` check.

---

### M2 — `finalizeGuestFile` calls `setEngineMode` before `setState('files.currentFileBlob')`
| Key | Value |
|-----|-------|
| File | `src/player/decode.ts` |
| Severity | **Medium** |
| Confidence | 8/10 |

**Bug**: `setEngineMode` triggers `updateBodyModeClass` which reads `files.currentFileBlob` from state. Because the blob was set AFTER the mode switch, `updateBodyModeClass` checked the previous track's blob (or null), potentially not applying `mode-video` class for video files on guest devices.

**Fix**: Moved `setState('files.currentFileBlob', file)` before the `setEngineMode()` call.

---

### M3 — `handlePauseMsg` on guest has no YouTube mode guard
| Key | Value |
|-----|-------|
| File | `src/player/playback.ts` |
| Severity | **Medium** |
| Confidence | 8/10 |

**Bug**: If a guest in `PLAYING_YOUTUBE` state received a `PAUSE` message (edge case with message ordering), `pause()` would stop the player node and transition to `PAUSED` state, breaking the YouTube UI without proper YouTube-specific cleanup.

**Fix**: Added `APP_STATE.PLAYING_YOUTUBE` guard at the top of `handlePauseMsg`.

---

### M4 — `leaveSession` does not reset `network.maxGuestSlots`
| Key | Value |
|-----|-------|
| File | `src/network/peer.ts` |
| Severity | **Medium** |
| Confidence | 8/10 |

**Bug**: `leaveSession()` reset `peerSlots` to `DEFAULT_MAX_GUEST_SLOTS + 1` length but didn't reset `maxGuestSlots`. If the host had increased max guests to 10, after leaving, `getAvailablePeerSlot` would iterate up to index 10 on an array of length 4, accessing out-of-bounds indices.

**Fix**: Added `'network.maxGuestSlots': DEFAULT_MAX_GUEST_SLOTS` to the `batchSetState` call in `leaveSession()`.

---

### M5 — `network:max-guests-changed` handler doesn't clean up `peerSlotByPeerId` for truncated slots
| Key | Value |
|-----|-------|
| File | `src/network/host.ts` |
| Severity | **Medium** |
| Confidence | 8/10 |

**Bug**: When max guest slots was reduced (e.g., from 5 to 2), slot entries beyond the new max were silently dropped from the array, but corresponding entries in `peerSlotByPeerId` remained, creating orphaned reverse-map entries pointing to non-existent slots.

**Fix**: Added loop to call `releasePeerSlot()` for peers in truncated slots before resizing the array.

---

### L1 — Host entry in `broadcastDeviceList` missing `isOp` field
| Key | Value |
|-----|-------|
| File | `src/network/peer-state.ts` |
| Severity | **Low** |
| Confidence | 9/10 |

**Bug**: Host entry in device list was `{ id, label, status, isHost }` without `isOp`. DeviceInfo interface requires `isOp: boolean`. Guest-side code reading `entry.isOp` on the host entry got `undefined` instead of a boolean.

**Fix**: Added `isOp: true` to the host entry in `broadcastDeviceList()`.

---

## Findings Evaluated but NOT Fixed (deferred to fix10)

| # | Finding | Reason |
|---|---------|--------|
| Single-shot sync no elapsed-time extrapolation | Sync math change — high risk, needs careful testing |
| Stale loadedmetadata listeners on video element | Structural — needs centralized listener management |
| `handleFileEnd` no completion validation | Structural — requires FILE_END-triggered finalization path |
| Host bootstrap PLAY ignores timestamp | Sync improvement — auto-sync triggers shortly after |
| Preload state direct mutation | Intentional perf pattern, no current subscribers |
| setState reference equality drops in-place mutations | By-design trade-off, ShallowImmutable provides compile-time guard |
| Heartbeat in-place mutation of connectedPeers | Intentional perf optimization |

## Verification
- `npx tsc --noEmit` — 0 errors
- Preview: 0 console errors, 0 failed network requests
